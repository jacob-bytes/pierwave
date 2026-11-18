//! 异地备份（WebDAV）：把一致性快照 gzip +（默认）AES-256-GCM 加密后，
//! 按保留策略上传到远端；上传产物与下载导出完全一致，绝不单独上传明文。
//!
//! 职责边界：
//! * 生成备份 → `crate::routes::backup::create_backup_archive`（与下载共用）；
//! * 远端读写 → [`crate::webdav`]；
//! * 「哪些文件算本产品的、该删哪几份」→ `pierwave_domain::remote_backup`；
//! * 本模块只负责流程编排、重试/退避、状态落库与失败告警。
//!
//! 并发：进程内 [`crate::state::RemoteBackupRuntime`] 的互斥锁保证同一时刻
//! 只有一次上传（定时任务与「立即备份」互斥）。拿不到锁返回 [`RunError::Busy`]，
//! 不排队——排队只会在按钮上堆出一串迟到的上传。

use sqlx::SqlitePool;

use pierwave_domain::remote_backup::{self, RemoteFile};
use pierwave_domain::{repo, time};

use crate::alerts::AlertKind;
use crate::error::AppError;
use crate::routes::backup;
use crate::routes::settings::{self, Settings};
use crate::state::AppState;
use crate::webdav::WebDavClient;

/// 最近一次**成功**上传的 Unix 秒（内部键，不在设置白名单里）。
pub const LAST_SUCCESS_KEY: &str = "backup_webdav_last_success_at";
/// 最近一次**失败**上传的 Unix 秒。
pub const LAST_FAILURE_KEY: &str = "backup_webdav_last_failure_at";
/// 最近一次失败原因（已对密码打码）。
pub const LAST_ERROR_KEY: &str = "backup_webdav_last_error";
/// 最近一次尝试的 Unix 秒；调度器用它判断是否到间隔。
pub const LAST_ATTEMPT_KEY: &str = "backup_webdav_last_attempt_at";

/// 一次上传的触发来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Schedule,
    Manual,
}

/// 远端备份的持久化状态（不含密码等配置）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteBackupMeta {
    pub last_success_at: Option<i64>,
    pub last_failure_at: Option<i64>,
    pub last_error: String,
    pub last_attempt_at: Option<i64>,
}

/// 一次成功上传的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadOutcome {
    pub file_name: String,
    pub bytes: u64,
    pub uploaded_at: i64,
    pub deleted: Vec<String>,
    pub files: Vec<RemoteFile>,
}

/// 上传失败的原因；路由层把它映射成稳定的错误码。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// 已有上传在进行。
    Busy,
    /// 没有配置地址或密码。
    NotConfigured(&'static str),
    /// 秘密设置（WebDAV 密码、Token 等）解不开：不是「未配置」，不能用 502 误导。
    Secret(settings::SecretError),
    /// 生成本地备份或远端写入失败（消息已对密码打码）。
    Failed(String),
}

impl RunError {
    pub fn into_app_error(self) -> AppError {
        match self {
            RunError::Busy => AppError::conflict(
                "backup.remote_busy",
                None,
                "已有备份正在上传，请稍后重试 / An upload is already running",
            ),
            RunError::NotConfigured(message) => AppError::coded(
                "backup.remote_not_configured",
                None,
                format!("{message} / WebDAV backup is not configured"),
            ),
            RunError::Secret(error) => AppError::coded(
                "settings.secret_decrypt_failed",
                Some(serde_json::json!({ "keys": error.keys })),
                error.message,
            ),
            RunError::Failed(message) => AppError::bad_gateway(
                "backup.remote_upload_failed",
                Some(serde_json::json!({ "detail": message })),
                format!("异地备份上传失败：{message}"),
            ),
        }
    }
}

/// 读取持久化状态；任何单键读取失败都按缺省处理，不影响设置页其它内容。
pub async fn load_meta(pool: &SqlitePool) -> RemoteBackupMeta {
    RemoteBackupMeta {
        last_success_at: read_timestamp(pool, LAST_SUCCESS_KEY).await,
        last_failure_at: read_timestamp(pool, LAST_FAILURE_KEY).await,
        last_error: read_text(pool, LAST_ERROR_KEY).await,
        last_attempt_at: read_timestamp(pool, LAST_ATTEMPT_KEY).await,
    }
}

async fn read_timestamp(pool: &SqlitePool, key: &str) -> Option<i64> {
    repo::settings::get(pool, key)
        .await
        .ok()
        .flatten()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
}

async fn read_text(pool: &SqlitePool, key: &str) -> String {
    repo::settings::get(pool, key)
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

async fn persist(pool: &SqlitePool, pairs: &[(&str, String)]) {
    for (key, value) in pairs {
        if let Err(error) = repo::settings::set(pool, key, value).await {
            // 状态写入失败不能让上传结果被误报成失败；下一次成功会覆盖。
            tracing::error!(key, error = %error, "写入异地备份状态失败");
        }
    }
}

/// 当前设置对应的客户端；地址或密码缺失时返回 `None`。
pub fn client_for(settings: &Settings) -> Option<WebDavClient> {
    if settings.backup_webdav_url.is_empty() || settings.backup_webdav_password.is_empty() {
        return None;
    }
    Some(WebDavClient::new(
        settings.backup_webdav_url.clone(),
        settings.backup_webdav_username.clone(),
        settings.backup_webdav_password.clone(),
    ))
}

/// 只读列出远端本产品备份（最新在前，最多 30 条）。
///
/// 远端不可达时返回空列表：状态接口不能因此 500，卡片保留上次错误即可。
pub async fn list_managed_files(settings: &Settings) -> Vec<RemoteFile> {
    let Some(client) = client_for(settings) else {
        return Vec::new();
    };
    match client.list().await {
        Ok(files) => managed_files(files),
        Err(error) => {
            tracing::warn!(error = %error, "读取 WebDAV 目录失败");
            Vec::new()
        }
    }
}

/// 过滤成「本产品写入的备份」并按文件名倒序（时间戳格式可字典序比较）。
pub fn managed_files(files: Vec<RemoteFile>) -> Vec<RemoteFile> {
    let mut managed: Vec<RemoteFile> = files
        .into_iter()
        .filter(|file| {
            remote_backup::is_managed_backup_name(&file.name, remote_backup::REMOTE_BACKUP_PREFIX)
        })
        .collect();
    managed.sort_by(|left, right| right.name.cmp(&left.name));
    managed.truncate(remote_backup::MAX_STATUS_FILES);
    managed
}

/// 测试连接：只做一次 Depth: 0 的 PROPFIND。
pub async fn test_connection(settings: &Settings) -> Result<(), RunError> {
    let Some(client) = client_for(settings) else {
        return Err(RunError::NotConfigured(
            "请先保存 WebDAV 地址与密码 / WebDAV URL and password are required",
        ));
    };
    client
        .test_connection()
        .await
        .map_err(|error| RunError::Failed(error.message().to_string()))
}

/// 立即执行一次上传（定时与手动共用）。
///
/// 失败时：
/// * 记录 `last_failure_at` / `last_attempt_at` / `last_error`；
/// * 定时触发时走现有告警渠道（`backup_failed`）；手动触发只返回错误，
///   避免管理员点一下按钮就收到一条告警。
pub async fn run_now(state: &AppState, trigger: Trigger) -> Result<UploadOutcome, RunError> {
    // 进程内互斥：拿不到就立刻返回 busy，不排队。
    let _guard = state.remote_backup.try_acquire().ok_or(RunError::Busy)?;

    let settings = settings::load_for_background(&state.db)
        .await
        .map_err(RunError::Secret)?;
    // 解不开时不要误报成「未配置」：那是两件不同的事。
    let Some(client) = client_for(&settings) else {
        return Err(RunError::NotConfigured(
            "请先保存 WebDAV 地址与密码 / WebDAV URL and password are required",
        ));
    };

    let archive = backup::create_backup_archive(state)
        .await
        .map_err(|error| RunError::Failed(format!("生成本地备份失败：{error}")))?;

    let mut last_error = String::new();
    let mut uploaded = false;
    for attempt in 0..state.remote_backup.max_attempts {
        match client.put_file(archive.filename(), archive.path()).await {
            Ok(()) => {
                uploaded = true;
                break;
            }
            Err(error) => {
                last_error = error.message().to_string();
                let remaining = state.remote_backup.max_attempts - attempt - 1;
                if remaining > 0 {
                    // 指数退避：base, 2×base, 4×base…（最多 3 次尝试）。
                    let delay = state.remote_backup.retry_delay * (1u32 << attempt);
                    tracing::warn!(
                        attempt = attempt + 1,
                        max = state.remote_backup.max_attempts,
                        delay_ms = delay.as_millis() as u64,
                        file = archive.filename(),
                        error = %last_error,
                        "异地备份上传失败，准备重试"
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

    if !uploaded {
        let message = remote_backup::redact_secret(&last_error, &settings.backup_webdav_password);
        let now = time::now();
        persist(
            &state.db.pool,
            &[
                (LAST_FAILURE_KEY, now.to_string()),
                (LAST_ATTEMPT_KEY, now.to_string()),
                (LAST_ERROR_KEY, truncate(&message)),
            ],
        )
        .await;
        if trigger == Trigger::Schedule {
            crate::alerts::notify(
                state,
                AlertKind::BackupFailed,
                "backup",
                "异地备份失败 / Off-site backup failed",
                &format!(
                    "WebDAV 备份连续 {} 次上传失败：{message} / \
                     WebDAV backup failed after {} attempts: {message}",
                    state.remote_backup.max_attempts, state.remote_backup.max_attempts
                ),
            )
            .await;
        }
        return Err(RunError::Failed(message));
    }

    let now = time::now();
    let mut deleted = Vec::new();
    let mut files = Vec::new();
    match client.list().await {
        Ok(list) => {
            let plan = remote_backup::plan_retention(
                &list,
                remote_backup::REMOTE_BACKUP_PREFIX,
                settings.backup_webdav_keep,
            );
            for name in plan {
                match client.delete(&name).await {
                    Ok(()) => deleted.push(name),
                    Err(error) => {
                        // 保留策略失败不影响「本次备份已成功」。
                        tracing::warn!(file = %name, error = %error, "删除远端旧备份失败");
                    }
                }
            }
            files = managed_files(list)
                .into_iter()
                .filter(|file| !deleted.iter().any(|name| name == &file.name))
                .collect();
        }
        Err(error) => {
            tracing::warn!(error = %error, "备份已上传，但读取远端目录失败");
        }
    }

    persist(
        &state.db.pool,
        &[
            (LAST_SUCCESS_KEY, now.to_string()),
            (LAST_ATTEMPT_KEY, now.to_string()),
            (LAST_ERROR_KEY, String::new()),
        ],
    )
    .await;

    tracing::info!(
        file = archive.filename(),
        bytes = archive.bytes(),
        deleted = deleted.len(),
        "异地备份上传成功"
    );

    Ok(UploadOutcome {
        file_name: archive.filename().to_string(),
        bytes: archive.bytes(),
        uploaded_at: now,
        deleted,
        files,
    })
}

/// 状态接口的错误文案也会进日志，长度兜底避免把整段 curl 输出写进设置表。
fn truncate(message: &str) -> String {
    message.chars().take(1000).collect()
}

/// 是否到了下一次上传时间。
///
/// `last_attempt_at` 缺失（刚开启）视为立即到期；失败也按「尝试时间」计时，
/// 不会在间隔内反复重试（重试只发生在上传过程内部的 3 次退避）。
pub fn is_due(meta: &RemoteBackupMeta, interval_hours: i64, now: i64) -> bool {
    let interval = interval_hours.max(remote_backup::MIN_INTERVAL_HOURS) * 3600;
    match meta.last_attempt_at {
        Some(last) => now.saturating_sub(last) >= interval,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use pierwave_domain::remote_backup::RemoteFile;

    fn file(name: &str) -> RemoteFile {
        RemoteFile {
            name: name.to_string(),
            size: 1,
            modified: None,
        }
    }

    #[test]
    fn due_check_uses_last_attempt_and_honours_interval() {
        let meta = RemoteBackupMeta {
            last_attempt_at: Some(1_000),
            ..Default::default()
        };
        assert!(!is_due(&meta, 24, 1_000));
        assert!(!is_due(&meta, 24, 1_000 + 24 * 3600 - 1));
        assert!(is_due(&meta, 24, 1_000 + 24 * 3600));
        assert!(is_due(&RemoteBackupMeta::default(), 24, 1_000));
        // 时钟回拨（last 在未来）不应把任务饿死到负数区间。
        assert!(!is_due(&meta, 1, 0));
        // 间隔被手工写成 0 时按最小值 1 小时处理，避免轮询风暴。
        assert!(!is_due(&meta, 0, 1_000 + 60));
    }

    #[test]
    fn managed_files_are_sorted_and_limited() {
        let mut files = vec![
            file("notes.txt"),
            file("pierwave-backup-20260101-000000.db.gz"),
            file("pierwave-backup-20260103-000000.db.gz"),
            file("pierwave-backup-20260102-000000.db.gz"),
        ];
        for index in 0..40 {
            files.push(file(&format!(
                "pierwave-backup-202601{:02}-000000.db.gz",
                index + 1
            )));
        }
        let managed = managed_files(files);
        assert_eq!(managed.len(), remote_backup::MAX_STATUS_FILES);
        assert_eq!(managed[0].name, "pierwave-backup-20260140-000000.db.gz");
        assert!(managed
            .iter()
            .all(|entry| entry.name.starts_with("pierwave-backup-")));
    }

    #[test]
    fn client_requires_url_and_password() {
        let mut settings = Settings::default();
        assert!(client_for(&settings).is_none());

        settings.backup_webdav_url = "https://dav.example.com/dav".into();
        assert!(client_for(&settings).is_none(), "缺密码不算配置完成");

        settings.backup_webdav_password = "secret".into();
        assert!(client_for(&settings).is_some());
    }
}
