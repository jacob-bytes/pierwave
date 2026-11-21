//! 备份与恢复（管理员）。
//!
//! 导出用 `VACUUM INTO` 生成一致性快照，gzip 后再用主密钥 AES-256-GCM 加密
//! （设置项 `backup_encrypt` 可关闭）；恢复只把校验通过的文件落盘为
//! `<db>.restore-pending`，真正替换发生在下次启动、打开连接池之前
//! （见 `pierwave_domain::backup::apply_pending_restore`）。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use pierwave_domain::backup::{self, MAX_BACKUP_BYTES};
use pierwave_domain::error::DomainError;
use pierwave_domain::fs_security;
use pierwave_domain::repo;
use pierwave_domain::secret_box::{self, SecretKey};

use crate::audit;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 已压缩好的一份备份；`_guard` 在 Drop 时删除临时文件。
pub(crate) struct BackupArchive {
    pub(crate) path: PathBuf,
    pub(crate) bytes: u64,
    pub(crate) db_bytes: u64,
    pub(crate) filename: String,
    /// true = `.db.gz.enc`（默认）；false = 关闭加密后的明文 `.db.gz`。
    pub(crate) encrypted: bool,
    _guard: TempFile,
}

impl BackupArchive {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn bytes(&self) -> u64 {
        self.bytes
    }

    pub(crate) fn filename(&self) -> &str {
        &self.filename
    }

    pub(crate) fn encrypted(&self) -> bool {
        self.encrypted
    }
}

/// 生成一份 gzip 压缩的一致性快照并落盘（默认再加密成 `.db.gz.enc`）。
///
/// 下载与异地上传共用同一条路径：`VACUUM INTO` 临时快照 → gzip 临时文件 →
/// （默认）AES-256-GCM 加密。关闭设置项 `backup_encrypt` 时跳过最后一步，
/// 输出历史兼容的明文 `.db.gz`。
/// 返回的 [`BackupArchive`] 持有临时文件守卫，调用方用完即自动清理。
pub(crate) async fn create_backup_archive(state: &AppState) -> AppResult<BackupArchive> {
    let db_path = backup_db_path(state)?;
    let dir = parent_dir(&db_path);
    // 备份目录（与数据库同目录）只允许属主进入；已存在的宽权限会被 warn + 收紧。
    fs_security::create_private_dir(dir)?;
    let settings = crate::routes::settings::load(&state.db).await;
    let encrypted = settings.backup_encrypt;
    let timestamp = backup::filename_timestamp();
    let token = uuid::Uuid::new_v4();
    let snapshot = dir.join(format!(".pierwave-backup-{timestamp}-{token}.tmp"));
    let snapshot_guard = TempFile::new(snapshot.clone());

    backup::create_snapshot(&state.db.pool, &snapshot).await?;
    let db_bytes = std::fs::metadata(&snapshot)?.len();

    let gz_path = dir.join(format!(".pierwave-backup-{timestamp}-{token}.db.gz.tmp"));
    let gz_guard = TempFile::new(gz_path.clone());
    let gzip_source = snapshot.clone();
    let gzip_target = gz_path.clone();
    tokio::task::spawn_blocking(move || gzip_file_to(&gzip_source, &gzip_target))
        .await
        .map_err(|error| AppError::Internal(anyhow::anyhow!("压缩备份失败：{error}")))??;
    // 快照只用于生成 gzip，落盘完成后立刻删掉（不依赖后续执行流）。
    drop(snapshot_guard);

    let prefix = pierwave_domain::remote_backup::REMOTE_BACKUP_PREFIX;
    if encrypted {
        let enc_path = dir.join(format!(
            ".pierwave-backup-{timestamp}-{token}.db.gz.enc.tmp"
        ));
        let guard = TempFile::new(enc_path.clone());
        let key = state.db.secret_key().clone();
        let source = gz_path.clone();
        let target = enc_path.clone();
        tokio::task::spawn_blocking(move || seal_file_to(&source, &target, &key))
            .await
            .map_err(|error| AppError::Internal(anyhow::anyhow!("加密备份失败：{error}")))??;
        drop(gz_guard);

        let bytes = std::fs::metadata(&enc_path)?.len();
        Ok(BackupArchive {
            path: enc_path,
            bytes,
            db_bytes,
            filename: pierwave_domain::remote_backup::remote_file_name(prefix, &timestamp, true),
            encrypted: true,
            _guard: guard,
        })
    } else {
        let bytes = std::fs::metadata(&gz_path)?.len();
        Ok(BackupArchive {
            path: gz_path,
            bytes,
            db_bytes,
            filename: pierwave_domain::remote_backup::remote_file_name(prefix, &timestamp, false),
            encrypted: false,
            _guard: gz_guard,
        })
    }
}

/// `GET /api/v1/backup`：下载加密（默认）或明文 gzip 的一致性快照。
pub async fn export(State(state): State<AppState>, user: CurrentUser) -> AppResult<Response> {
    user.require_admin()?;
    let archive = create_backup_archive(&state).await?;
    let gz = tokio::fs::read(archive.path()).await?;
    let filename = archive.filename().to_string();
    let db_bytes = archive.db_bytes;
    let encrypted = archive.encrypted();

    audit::record(
        &state,
        &user.0,
        "backup.export",
        "backup",
        json!({ "bytes": gz.len(), "db_bytes": db_bytes, "encrypted": encrypted }),
    )
    .await;

    let mut response = Response::new(Body::from(gz));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(if encrypted {
            "application/octet-stream"
        } else {
            "application/gzip"
        }),
    );
    let disposition = format!("attachment; filename=\"{filename}\"");
    let disposition =
        HeaderValue::from_str(&disposition).map_err(|error| AppError::Internal(error.into()))?;
    response
        .headers_mut()
        .insert(header::CONTENT_DISPOSITION, disposition);
    Ok(response)
}

/// 恢复请求的查询参数。
///
/// 上传体是原始文件字节，不能同时是 JSON，所以 `force` 只能走查询串：
/// `POST /api/v1/backup/restore?force=true`。
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct RestoreOptions {
    #[serde(default)]
    pub force: bool,
}

/// `POST /api/v1/backup/restore`：上传 `.db` / `.db.gz` / `.db.gz.enc`，落盘为待恢复文件。
pub async fn restore(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(options): Query<RestoreOptions>,
    body: Body,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let db_path = backup_db_path(&state)?;
    let dir = parent_dir(&db_path);
    fs_security::create_private_dir(dir)?;
    let pending = backup::pending_path(&db_path);
    let token = uuid::Uuid::new_v4();

    // 原始上传体（可能是 gzip，也可能直接是 .db）。
    let upload = dir.join(format!(".pierwave-restore-upload-{token}.tmp"));
    let _upload_guard = TempFile::new(upload.clone());
    save_body(body, &upload).await?;

    // 按内容判断：加密信封 / gzip / 裸 SQLite。历史明文备份继续可用。
    let format = upload_format(&upload)?;
    let compressed = format != UploadFormat::Raw;
    let raw_path: PathBuf;
    let _raw_guard: Option<TempFile>;
    match format {
        UploadFormat::Encrypted => {
            let blob = std::fs::read(&upload)?;
            let gzip_bytes = secret_box::open(state.db.secret_key(), &blob)
                .map_err(|_| restore_decrypt_error())?;
            // 解密后的内容是本产品写下的 gzip；先落盘再流式解压，避免把
            // 解压后的数据库整个读进内存。
            let gz_path = dir.join(format!(".pierwave-restore-gz-{token}.db.gz"));
            let _gz_guard = TempFile::new(gz_path.clone());
            write_private_bytes(&gz_path, &gzip_bytes)?;

            let raw = dir.join(format!(".pierwave-restore-raw-{token}.db"));
            // 守卫必须先于解压创建：坏 gzip / 超限会在写出半截文件后失败，
            // 事后才建守卫就永远删不到它（明文业务数据留在磁盘上）。
            _raw_guard = Some(TempFile::new(raw.clone()));
            let source = gz_path.clone();
            let target = raw.clone();
            tokio::task::spawn_blocking(move || gunzip_file(&source, &target))
                .await
                .map_err(|error| AppError::Internal(anyhow::anyhow!("解压备份失败：{error}")))?
                .map_err(restore_gunzip_error)?;
            raw_path = raw;
        }
        UploadFormat::Gzip => {
            let raw = dir.join(format!(".pierwave-restore-raw-{token}.db"));
            _raw_guard = Some(TempFile::new(raw.clone()));
            let source = upload.clone();
            let target = raw.clone();
            tokio::task::spawn_blocking(move || gunzip_file(&source, &target))
                .await
                .map_err(|error| AppError::Internal(anyhow::anyhow!("解压备份失败：{error}")))?
                .map_err(restore_gunzip_error)?;
            raw_path = raw;
        }
        UploadFormat::Raw => {
            _raw_guard = None;
            raw_path = upload.clone();
        }
    }

    let raw_bytes = backup::validate_backup_file(&raw_path)
        .await
        .map_err(restore_validation_error)?;

    // 结构校验通过后、rename 成 pending 之前，再校验秘密值能否被**当前主密钥**
    // 解开。否则恢复会“成功”，但重启后设置页 / WebDAV / 告警 / 订阅全部坏掉。
    // `force` 是管理员的显式覆盖：允许丢弃旧秘密，但响应必须带 warning。
    let unreadable = backup::unreadable_encrypted_settings(&raw_path, state.db.secret_key())
        .await
        .map_err(|error| AppError::Internal(error.context("扫描备份中的秘密设置失败")))?;
    if !unreadable.is_empty() && !options.force {
        return Err(restore_key_mismatch_error(unreadable));
    }
    let secrets_match_current_key = unreadable.is_empty();
    if options.force && !secrets_match_current_key {
        // force = 丢弃旧秘密：删掉解不开的行，避免恢复后设置页 400 / 订阅 500，
        // 同时让内部 hmac_secret_v1 在首次使用时重新生成（所有客户端需重新拉取订阅）。
        let discarded = backup::discard_unreadable_settings(&raw_path, state.db.secret_key())
            .await
            .map_err(|error| AppError::Internal(error.context("丢弃无法解密的旧秘密失败")))?;
        debug_assert_eq!(discarded, unreadable);
    }

    // 原子写：校验通过的完整文件已经写盘并 sync，落位只做同目录 rename。
    std::fs::rename(&raw_path, &pending).map_err(|error| AppError::Internal(error.into()))?;
    // 待恢复文件里是完整业务数据；上传临时文件已是 0600，这里再兜底一次。
    fs_security::ensure_private_file(&pending)?;

    audit::record(
        &state,
        &user.0,
        "backup.restore.schedule",
        "backup",
        json!({
            "bytes": raw_bytes,
            "compressed": compressed,
            "encrypted": format == UploadFormat::Encrypted,
            "forced": options.force,
            "unreadable_secrets": unreadable,
        }),
    )
    .await;

    let mut response = json!({
        "restart_required": true,
        "pending": {
            "uploaded_at": uploaded_at(&pending),
            "bytes": raw_bytes,
        },
    });
    if options.force {
        response["warning"] = if secrets_match_current_key {
            json!(
                "已使用 force=true 恢复备份；备份中的秘密与当前主密钥一致，无需重新配置。 / \
                 Restored with force=true; the backup secrets match the current master key."
            )
        } else {
            json!(
                "已按 force=true 恢复并丢弃了无法解密的旧秘密：恢复后 Telegram Token、\
                 WebDAV 密码、Webhook 地址需要重新填写，订阅派生 secret 会重新生成\
                 （所有客户端需重新拉取订阅，旧凭据失效）。 / Restored with force=true and \
                 discarded unreadable secrets: re-enter the Telegram token, WebDAV password \
                 and webhook URL; the subscription derivation secret is regenerated, so every \
                 client must fetch its subscription again and old credentials no longer work."
            )
        };
    }
    Ok(Json(response))
}

/// `GET /api/v1/backup/info`：当前库大小与待恢复状态。
///
/// `db_bytes` 必须反映真实数据量：WAL 模式下主库文件可能只有 4 KB，直接
/// `stat` 主库会把几百 KB 的数据报成 4 KB。这里用
/// `PRAGMA page_count * page_size`（含 WAL 中已提交的页），口径与下载的
/// `VACUUM INTO` 快照一致。
pub async fn info(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let db_path = backup_db_path(&state)?;
    let db_bytes = repo::backup::database_bytes(&state.db.pool).await?;
    Ok(Json(json!({
        "db_bytes": db_bytes,
        "pending": pending_info(&db_path),
    })))
}

/// `DELETE /api/v1/backup/restore`：取消待恢复文件。
pub async fn cancel_restore(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let db_path = backup_db_path(&state)?;
    let pending = backup::pending_path(&db_path);
    if !pending.exists() {
        return Err(AppError::coded(
            "backup.restore_no_pending",
            None,
            "没有待恢复的备份",
        ));
    }
    let bytes = std::fs::metadata(&pending)
        .map(|meta| meta.len())
        .unwrap_or(0);
    std::fs::remove_file(&pending)?;
    audit::record(
        &state,
        &user.0,
        "backup.restore.cancel",
        "backup",
        json!({ "bytes": bytes }),
    )
    .await;
    Ok(Json(json!({ "cancelled": true })))
}

/// `GET /api/v1/backup/remote`：异地备份状态与最近文件列表。
///
/// `last_success_at` / `last_error` 来自持久化状态；`files` 实时 PROPFIND，
/// 远端不可达时返回空列表而不是让整个设置卡报错。
pub async fn remote_status(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let settings = crate::routes::settings::load(&state.db).await;
    let meta = crate::remote_backup::load_meta(&state.db.pool).await;
    let files = crate::remote_backup::list_managed_files(&settings).await;
    Ok(Json(remote_status_json(&meta, &files)))
}

fn remote_status_json(
    meta: &crate::remote_backup::RemoteBackupMeta,
    files: &[pierwave_domain::remote_backup::RemoteFile],
) -> Value {
    let files: Vec<Value> = files
        .iter()
        .map(|file| {
            json!({
                "name": file.name,
                "size": file.size,
                "modified": file.modified,
            })
        })
        .collect();
    json!({
        "last_success_at": meta.last_success_at,
        "last_failure_at": meta.last_failure_at,
        "last_error": if meta.last_error.is_empty() {
            Value::Null
        } else {
            Value::String(meta.last_error.clone())
        },
        "files": files,
    })
}

/// `POST /api/v1/backup/remote/test`：测试已保存的 WebDAV 配置。
///
/// 连接失败是**业务结果**（200 + `ok: false`），不是接口错误：卡片要显示原因。
pub async fn remote_test(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    // 秘密解不开时不能回落成「未配置」：那会把密钥问题误导成填表问题。
    let settings = crate::routes::settings::load_for_background(&state.db)
        .await
        .map_err(|error| crate::remote_backup::RunError::Secret(error).into_app_error())?;
    match crate::remote_backup::test_connection(&settings).await {
        Ok(()) => Ok(Json(json!({ "ok": true, "error": Value::Null }))),
        Err(crate::remote_backup::RunError::NotConfigured(message)) => Err(AppError::coded(
            "backup.remote_not_configured",
            None,
            message,
        )),
        Err(crate::remote_backup::RunError::Failed(message)) => {
            Ok(Json(json!({ "ok": false, "error": message })))
        }
        Err(crate::remote_backup::RunError::Secret(error)) => {
            Err(crate::remote_backup::RunError::Secret(error).into_app_error())
        }
        Err(crate::remote_backup::RunError::Busy) => Err(AppError::conflict(
            "backup.remote_busy",
            None,
            "已有备份正在上传，请稍后重试 / An upload is already running",
        )),
    }
}

/// `POST /api/v1/backup/remote/run`：立即生成并上传一次备份。
pub async fn remote_run(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let outcome = crate::remote_backup::run_now(&state, crate::remote_backup::Trigger::Manual)
        .await
        .map_err(crate::remote_backup::RunError::into_app_error)?;

    audit::record(
        &state,
        &user.0,
        "backup.remote.upload",
        "backup",
        json!({
            "file": outcome.file_name,
            "bytes": outcome.bytes,
            "deleted": outcome.deleted.len(),
        }),
    )
    .await;

    Ok(Json(json!({
        "ok": true,
        "file": {
            "name": outcome.file_name,
            "size": outcome.bytes,
            "uploaded_at": outcome.uploaded_at,
        },
        "deleted": outcome.deleted,
        "files": outcome.files.iter().map(|file| json!({
            "name": file.name,
            "size": file.size,
            "modified": file.modified,
        })).collect::<Vec<Value>>(),
    })))
}

fn backup_db_path(state: &AppState) -> AppResult<PathBuf> {
    state.db.file_path().map(Path::to_path_buf).ok_or_else(|| {
        AppError::coded(
            "backup.in_memory_unsupported",
            None,
            "当前数据库是内存库，不支持备份与恢复",
        )
    })
}

/// 备份里的秘密值来自另一把主密钥：拒绝恢复，并告诉管理员怎么带上原密钥。
fn restore_key_mismatch_error(keys: Vec<String>) -> AppError {
    let keys_text = keys.join(", ");
    AppError::coded(
        "backup.key_mismatch",
        Some(json!({ "keys": keys })),
        format!(
            "备份来自另一把主密钥（无法解密：{keys_text}）。请同时提供原实例的 secret.key，\
             或设置相同的 PIERWAVE_SECRET_KEY 后重试；确认要丢弃旧秘密可加 ?force=true。 / \
             The backup was encrypted with another master key ({keys_text}). Provide the \
             original secret.key or the same PIERWAVE_SECRET_KEY, or append ?force=true to \
             discard the old secrets."
        ),
    )
}

/// 恢复校验失败的错误码：文案保持原样（便于排障），只按原因归类。
///
/// 领域层现在会直接给出 `DomainError`（优先使用其 code/params）；字符串匹配
/// 只作为旧错误链的兜底，行为与以前一致。
fn restore_validation_error(error: anyhow::Error) -> AppError {
    if let Some(domain) = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<DomainError>())
    {
        return AppError::coded(
            domain.code,
            domain.params_option(),
            format!("备份文件校验失败：{}", domain.message),
        );
    }
    let message = format!("备份文件校验失败：{error:#}");
    if message.contains("文件头不是 SQLite format 3") {
        AppError::coded("backup.restore_bad_header", None, message)
    } else if message.contains("备份缺少必需的表") {
        AppError::coded("backup.restore_missing_tables", None, message)
    } else if message.contains("迁移版本") {
        let numbers: Vec<i64> = message
            .split(|c: char| !c.is_ascii_digit())
            .filter_map(|part| part.parse::<i64>().ok())
            .collect();
        // 前端要按 params 插值，缺了就只能回落中文原文
        AppError::coded(
            "backup.restore_migration_too_new",
            Some(json!({
                "version": numbers.first().copied().unwrap_or_default(),
                "supported": numbers.get(1).copied().unwrap_or_default(),
            })),
            message,
        )
    } else if message.contains("超过 512 MB") {
        AppError::coded(
            "backup.restore_too_large",
            Some(json!({ "max_mb": 512 })),
            message,
        )
    } else {
        AppError::coded("backup.restore_invalid", None, message)
    }
}

/// gzip 解压失败：超过上限与坏包分开，其余归入解压失败。
fn restore_gunzip_error(message: String) -> AppError {
    if message.contains("超过 512 MB") {
        AppError::coded(
            "backup.restore_too_large",
            Some(json!({ "max_mb": 512 })),
            message,
        )
    } else {
        AppError::coded("backup.restore_bad_gzip", None, message)
    }
}

fn parent_dir(db_path: &Path) -> &Path {
    db_path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn pending_info(db_path: &Path) -> Value {
    let pending = backup::pending_path(db_path);
    match std::fs::metadata(&pending) {
        Ok(meta) if meta.is_file() => json!({
            "uploaded_at": uploaded_at(&pending),
            "bytes": meta.len(),
        }),
        _ => Value::Null,
    }
}

fn uploaded_at(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// 上传体的真实格式；按内容判断，不看扩展名。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadFormat {
    /// 本产品的 `MAGIC | VERSION | NONCE | CIPHERTEXT` 信封（默认导出格式）。
    Encrypted,
    /// 历史明文备份：gzip 压缩的 SQLite。
    Gzip,
    /// 更早的裸 `.db` 上传。
    Raw,
}

fn upload_format(path: &Path) -> AppResult<UploadFormat> {
    let mut header = [0u8; 4];
    let mut file = std::fs::File::open(path)?;
    let read = file.read(&mut header)?;
    if read == header.len() && header == secret_box::MAGIC {
        return Ok(UploadFormat::Encrypted);
    }
    if read >= backup::GZIP_MAGIC.len() && header[..2] == backup::GZIP_MAGIC {
        return Ok(UploadFormat::Gzip);
    }
    Ok(UploadFormat::Raw)
}

/// 解密失败对外的统一错误：不透露主密钥、密文细节或具体失败原因。
fn restore_decrypt_error() -> AppError {
    AppError::coded(
        "backup.restore_decrypt_failed",
        None,
        "备份解密失败：主密钥与备份不匹配，或文件已损坏 / \
         The backup cannot be decrypted: the master key does not match, or the file is corrupted",
    )
}

/// 一次写入并 sync，权限走 `open_private_file`（0600）。
fn write_private_bytes(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut file = fs_security::open_private_file(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// 读取 gzip 产物并封装成信封；只在 `spawn_blocking` 里调用。
fn seal_file_to(source: &Path, target: &Path, key: &SecretKey) -> AppResult<()> {
    let plaintext = std::fs::read(source)?;
    let sealed = secret_box::seal(key, &plaintext);
    write_private_bytes(target, &sealed)
}

/// gzip 到目标文件并 sync；失败时把半成品删掉，避免残留临时文件。
fn gzip_file_to(source: &Path, target: &Path) -> AppResult<()> {
    let result = (|| -> std::io::Result<()> {
        let mut input = std::fs::File::open(source)?;
        let output = fs_security::open_private_file(target)?;
        let mut encoder = GzEncoder::new(output, Compression::default());
        std::io::copy(&mut input, &mut encoder)?;
        let output = encoder.finish()?;
        output.sync_all()?;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(target);
            Err(error.into())
        }
    }
}

/// gzip 解压到临时文件，返回解压后字节数；超过上限直接拒绝（防 zip bomb）。
fn gunzip_file(source: &Path, target: &Path) -> Result<u64, String> {
    gunzip_file_with_limit(source, target, MAX_BACKUP_BYTES)
}

/// [`gunzip_file`] 的可测版本：上限可注入，便于用小样本覆盖超限路径。
///
/// 任何失败都删除 `target`：调用方即便忘了守卫，也不能把解压到一半的明文
/// 业务数据库留在磁盘上。
fn gunzip_file_with_limit(source: &Path, target: &Path, max_bytes: u64) -> Result<u64, String> {
    let result = (|| -> Result<u64, String> {
        let input =
            std::fs::File::open(source).map_err(|error| format!("打开上传文件失败：{error}"))?;
        let mut decoder = GzDecoder::new(input);
        let mut output = fs_security::open_private_file(target)
            .map_err(|error| format!("创建临时文件失败：{error}"))?;
        let mut limited = (&mut decoder).take(max_bytes.saturating_add(1));
        let copied = std::io::copy(&mut limited, &mut output)
            .map_err(|error| format!("gzip 解压失败：{error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("写入临时文件失败：{error}"))?;
        if copied > max_bytes {
            return Err(format!(
                "解压后的数据库超过 {} MB 上限",
                max_bytes / (1024 * 1024)
            ));
        }
        Ok(copied)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(target);
    }
    result
}

/// 流式落盘，边写边计数，避免把 512 MB 上传体整个读进内存。
async fn save_body(body: Body, target: &Path) -> AppResult<u64> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        options.mode(fs_security::PRIVATE_FILE_MODE);
    }
    let mut file = options.open(target).await?;
    // `create(true)` 不会修改已存在文件的权限；落盘前先收紧，避免窗口期可读。
    fs_security::ensure_private_file(target)?;
    let mut stream = body.into_data_stream();
    let mut total: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|_| AppError::coded("backup.restore_read_failed", None, "读取上传内容失败"))?;
        total = total.saturating_add(chunk.len() as u64);
        if total > MAX_BACKUP_BYTES {
            return Err(AppError::coded(
                "backup.restore_too_large",
                Some(json!({ "max_mb": 512 })),
                "备份文件超过 512 MB 上限",
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| AppError::Internal(error.into()))?;
    }
    file.flush()
        .await
        .map_err(|error| AppError::Internal(error.into()))?;
    file.sync_all()
        .await
        .map_err(|error| AppError::Internal(error.into()))?;
    Ok(total)
}

/// 临时文件守卫：无论成功、失败还是 panic 展开都尽量删掉半成品。
struct TempFile {
    path: PathBuf,
}

impl TempFile {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{HeaderMap, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::repo;
    use pierwave_domain::repo::users::{self, NewUser};
    use pierwave_domain::Db;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "pierwave-route-backup-{tag}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn db_path(&self) -> PathBuf {
            self.path.join("pierwave.db")
        }

        fn file(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    async fn setup(tag: &str) -> (TestDir, Router, AppState, String) {
        let dir = TestDir::new(tag);
        let db = Db::connect(&format!("sqlite://{}?mode=rwc", dir.db_path().display()))
            .await
            .unwrap();
        db.migrate().await.unwrap();
        let admin = users::create(
            &db.pool,
            NewUser {
                username: "admin".into(),
                password: "devpass".into(),
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
            .await
            .unwrap();
        let mut state = AppState::new(db, "web/dist");
        // 重试退避压到毫秒级：单测不真的等 2s + 4s。
        state.remote_backup = crate::state::RemoteBackupRuntime::default().fast_retry();
        let app = crate::app::router(state.clone());
        (
            dir,
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
        )
    }

    async fn request(
        app: &Router,
        cookie: Option<&str>,
        method: Method,
        uri: &str,
        body: Vec<u8>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 32 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec();
        (status, headers, bytes)
    }

    fn json(bytes: &[u8]) -> Value {
        serde_json::from_slice(bytes).unwrap()
    }

    fn gunzip(bytes: &[u8]) -> Vec<u8> {
        let mut decoder = GzDecoder::new(bytes);
        let mut raw = Vec::new();
        decoder.read_to_end(&mut raw).unwrap();
        raw
    }

    /// 临时文件都以 `.pierwave-` 开头；正常路径结束后不应残留。
    fn leftover_temp_files(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".pierwave-"))
            .collect()
    }

    async fn export_bytes(app: &Router, cookie: &str) -> Vec<u8> {
        let (status, _, body) =
            request(app, Some(cookie), Method::GET, "/api/v1/backup", Vec::new()).await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        body
    }

    /// 默认导出必须是加密信封：不能是 gzip，更不能是明文 SQLite。
    #[tokio::test]
    async fn export_returns_encrypted_gzipped_sqlite_snapshot() {
        let (dir, app, state, cookie) = setup("export").await;
        let (status, headers, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/backup",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap().to_str().unwrap(),
            "application/octet-stream"
        );
        let disposition = headers
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            disposition.starts_with("attachment; filename=\"pierwave-backup-"),
            "实际：{disposition}"
        );
        assert!(
            disposition.ends_with(".db.gz.enc\""),
            "默认必须输出加密备份：{disposition}"
        );
        assert!(
            body.starts_with(&secret_box::MAGIC),
            "导出内容必须是加密信封"
        );
        assert!(
            !gzip_magic(&body),
            "加密备份不能以 gzip 魔数开头（那说明没加密）"
        );
        assert!(
            !body.starts_with(backup::SQLITE_MAGIC),
            "加密备份不能是明文 SQLite"
        );

        // 用服务端主密钥解密后，得到 gzip → SQLite。
        let gz = secret_box::open(state.db.secret_key(), &body).unwrap();
        assert!(gzip_magic(&gz));
        let raw = gunzip(&gz);
        assert!(raw.starts_with(backup::SQLITE_MAGIC));
        assert!(
            leftover_temp_files(&dir.path).is_empty(),
            "导出后临时快照应被删除：{:?}",
            leftover_temp_files(&dir.path)
        );
        let snapshot = dir.file("downloaded.db");
        std::fs::write(&snapshot, &raw).unwrap();
        let db = Db::connect(&format!("sqlite://{}?mode=rwc", snapshot.display()))
            .await
            .unwrap();
        assert!(repo::backup::table_exists(&db.pool, "users").await.unwrap());
        db.pool.close().await;
    }

    /// 备份链路上的临时文件都含完整业务数据：上传临时体、gzip 产物、待恢复文件。
    #[cfg(unix)]
    #[tokio::test]
    async fn backup_temp_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TestDir::new("temp-perm");
        let upload = dir.file("upload.tmp");
        save_body(Body::from("payload"), &upload).await.unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&upload), 0o600, "上传临时文件必须是 0600");

        let gz = dir.file("backup.db.gz");
        gzip_file_to(&upload, &gz).unwrap();
        assert_eq!(mode(&gz), 0o600, "gzip 产物必须是 0600");
    }

    #[tokio::test]
    async fn rejects_bad_uploads_with_specific_reasons() {
        let (dir, app, _state, cookie) = setup("reject").await;

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            b"this is not a database".to_vec(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let message = json(&body)["error"].as_str().unwrap().to_string();
        assert!(message.contains("SQLite format 3"), "实际：{message}");
        assert_eq!(json(&body)["code"], "backup.restore_bad_header");

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let message = json(&body)["error"].as_str().unwrap().to_string();
        assert!(message.contains("为空"), "实际：{message}");
        assert_eq!(json(&body)["code"], "backup.restore_invalid");

        // 合法 SQLite，但没有 users / _sqlx_migrations。
        let tableless_path = dir.file("tableless.db");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&tableless_path)
            .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE dummy (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            std::fs::read(&tableless_path).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let message = json(&body)["error"].as_str().unwrap().to_string();
        assert!(message.contains("users"), "实际：{message}");
        assert!(message.contains("_sqlx_migrations"), "实际：{message}");
        assert_eq!(json(&body)["code"], "backup.restore_missing_tables");

        assert!(
            !backup::pending_path(&dir.db_path()).exists(),
            "失败的上传不能留下待恢复文件"
        );
    }

    #[tokio::test]
    async fn rejects_backup_with_future_migration_version() {
        let (dir, app, _state, cookie) = setup("future").await;
        let future_path = dir.file("future.db");
        let db = Db::connect(&format!("sqlite://{}?mode=rwc", future_path.display()))
            .await
            .unwrap();
        db.migrate().await.unwrap();
        sqlx::query(
            "INSERT INTO _sqlx_migrations
                (version, description, success, checksum, execution_time)
             VALUES (?, 'from the future', 1, ?, 0)",
        )
        .bind(pierwave_domain::latest_migration_version() + 1)
        .bind(Vec::<u8>::new())
        .execute(&db.pool)
        .await
        .unwrap();
        // 走和真实备份相同的 VACUUM INTO 路径，避免 WAL 旁路文件干扰测试。
        let future_snapshot = dir.file("future-snapshot.db");
        backup::create_snapshot(&db.pool, &future_snapshot)
            .await
            .unwrap();
        db.pool.close().await;

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            std::fs::read(&future_snapshot).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let message = json(&body)["error"].as_str().unwrap().to_string();
        assert!(message.contains("迁移版本"), "实际：{message}");
        assert!(message.contains("高于当前程序支持"), "实际：{message}");
        assert_eq!(json(&body)["code"], "backup.restore_migration_too_new");
    }

    #[tokio::test]
    async fn gzip_upload_creates_pending_info_and_cancel() {
        let (dir, app, state, cookie) = setup("pending").await;
        let gz = export_bytes(&app, &cookie).await;

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            gz,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        assert_eq!(json(&body)["restart_required"], true);

        let pending = backup::pending_path(&dir.db_path());
        assert!(pending.exists(), "上传成功后应生成待恢复文件");
        assert!(std::fs::read(&pending)
            .unwrap()
            .starts_with(backup::SQLITE_MAGIC));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&pending).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, ".restore-pending 必须是 0600");
        }

        assert!(
            leftover_temp_files(&dir.path).is_empty(),
            "上传落位后临时文件应被删除：{:?}",
            leftover_temp_files(&dir.path)
        );

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/backup/info",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let info = json(&body);
        assert!(info["db_bytes"].as_u64().unwrap() > 0);
        assert!(info["pending"].is_object(), "info：{info}");
        assert_eq!(
            info["pending"]["bytes"].as_u64().unwrap(),
            std::fs::metadata(&pending).unwrap().len()
        );
        assert!(info["pending"]["uploaded_at"].as_i64().unwrap() > 0);

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            "/api/v1/backup/restore",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        assert_eq!(json(&body)["cancelled"], true);
        assert!(!pending.exists(), "取消后待恢复文件应被删除");

        let (_, _, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/backup/info",
            Vec::new(),
        )
        .await;
        assert!(json(&body)["pending"].is_null());

        let actions: Vec<String> = repo::audit::list(&state.db.pool, 50)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.action)
            .collect();
        for action in [
            "backup.export",
            "backup.restore.schedule",
            "backup.restore.cancel",
        ] {
            assert!(actions.contains(&action.to_string()), "缺少审计：{action}");
        }
    }

    /// 解压超限与解压失败走同一套清理逻辑：半成品临时库必须删掉。
    #[test]
    fn oversized_gunzip_removes_partial_target() {
        let dir = TestDir::new("gunzip-limit");
        let source = dir.file("bomb.gz");
        let target = dir.file("raw.db");
        {
            let file = std::fs::File::create(&source).unwrap();
            let mut encoder = GzEncoder::new(file, Compression::default());
            encoder.write_all(&[0u8; 64]).unwrap();
            encoder.finish().unwrap();
        }

        let error = gunzip_file_with_limit(&source, &target, 8).unwrap_err();
        assert!(error.contains("超过"), "{error}");
        assert!(!target.exists(), "超限时不能留下解压到一半的临时库");
    }

    /// 坏 gzip 在解压时就会失败：写了一半的明文临时库必须被守卫删掉。
    #[tokio::test]
    async fn failed_gzip_restore_leaves_no_temp_files() {
        let (dir, app, _state, cookie) = setup("bad-gzip").await;
        let malformed = vec![0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff];

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            malformed,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{}",
            String::from_utf8_lossy(&body)
        );
        assert_eq!(json(&body)["code"], "backup.restore_bad_gzip");
        assert!(
            leftover_temp_files(&dir.path).is_empty(),
            "解压失败后不能留下明文临时库：{:?}",
            leftover_temp_files(&dir.path)
        );
        assert!(!backup::pending_path(&dir.db_path()).exists());
    }

    #[tokio::test]
    async fn raw_database_upload_is_accepted() {
        let (dir, app, state, cookie) = setup("raw").await;
        let encrypted = export_bytes(&app, &cookie).await;
        let gz = secret_box::open(state.db.secret_key(), &encrypted).unwrap();
        let raw = gunzip(&gz);

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            raw,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        assert!(backup::pending_path(&dir.db_path()).exists());
    }

    /// 恢复别的实例导出的库（秘密用另一把密钥加密）必须在 rename 前拒绝；
    /// `?force=true` 是显式覆盖，允许丢弃旧秘密但响应必须带 warning。
    #[tokio::test]
    async fn restore_rejects_another_master_key_and_force_is_explicit() {
        let (dir, app, state, cookie) = setup("key-mismatch").await;

        // 另一个目录里的实例：它有自己的 secret.key 和加密设置。
        let other_dir = TestDir::new("key-mismatch-other");
        let other = Db::connect(&format!(
            "sqlite://{}?mode=rwc",
            other_dir.db_path().display()
        ))
        .await
        .unwrap();
        other.migrate().await.unwrap();
        let secret = "123456:belongs-to-another-instance";
        for (key, value) in [
            ("telegram_bot_token", secret),
            ("hmac_secret_v1", "other-instance-hmac"),
        ] {
            repo::settings::set(
                &other.pool,
                key,
                &secret_box::encrypt_setting(other.secret_key(), value),
            )
            .await
            .unwrap();
        }
        let foreign = dir.file("foreign.db");
        backup::create_snapshot(&other.pool, &foreign)
            .await
            .unwrap();
        other.pool.close().await;
        let bytes = std::fs::read(&foreign).unwrap();

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            bytes.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
        let payload = json(&body);
        assert_eq!(payload["code"], "backup.key_mismatch");
        assert_eq!(
            payload["params"]["keys"],
            json!(["hmac_secret_v1", "telegram_bot_token"])
        );
        let message = payload["error"].as_str().unwrap();
        assert!(
            message.contains("另一把主密钥"),
            "错误要说明原因：{message}"
        );
        assert!(
            message.contains("secret.key") && message.contains("PIERWAVE_SECRET_KEY"),
            "错误要给出可操作指引：{message}"
        );
        assert!(!message.contains(secret), "错误不能泄露旧秘密：{message}");
        assert!(
            !backup::pending_path(&dir.db_path()).exists(),
            "校验失败不能留下待恢复文件"
        );

        // force：管理员确认丢弃旧秘密。
        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore?force=true",
            bytes,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body:?}");
        let payload = json(&body);
        assert_eq!(payload["restart_required"], true);
        assert!(
            payload["warning"].as_str().unwrap().contains("force=true"),
            "force 必须在响应里带 warning：{payload}"
        );
        let pending = backup::pending_path(&dir.db_path());
        assert!(pending.exists());
        // force = 丢弃旧秘密：待恢复库里不应再有解不开的 enc:v1 行（含 hmac）。
        assert!(
            backup::unreadable_encrypted_settings(&pending, state.db.secret_key())
                .await
                .unwrap()
                .is_empty(),
            "force 后仍存在无法解密的秘密行"
        );
    }

    /// 手动异地备份 / 测试连接遇到秘密解不开：400 + 明确错误码，不是 502/「未配置」。
    #[tokio::test]
    async fn remote_backup_secret_errors_are_not_misreported() {
        let (_dir, app, state, cookie) = setup("remote-secret-error").await;
        let other = SecretKey::generate().unwrap();
        for (key, value) in [
            ("backup_webdav_enabled", "1".to_string()),
            (
                "backup_webdav_url",
                "https://dav.example.test/dav".to_string(),
            ),
        ] {
            repo::settings::set(&state.db.pool, key, &value)
                .await
                .unwrap();
        }
        repo::settings::set(
            &state.db.pool,
            "backup_webdav_password",
            &secret_box::encrypt_setting(&other, "webdav-secret-canary"),
        )
        .await
        .unwrap();

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/remote/test",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
        assert_eq!(json(&body)["code"], "settings.secret_decrypt_failed");
        let message = json(&body)["error"].as_str().unwrap().to_string();
        assert!(message.contains("主密钥"), "{message}");
        assert!(!message.contains("未配置"), "不能误导成未配置：{message}");
        assert!(!message.contains("webdav-secret-canary"));

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/remote/run",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
        assert_eq!(json(&body)["code"], "settings.secret_decrypt_failed");
        assert_ne!(status, StatusCode::BAD_GATEWAY, "秘密问题不能报 502");
    }

    /// 篡改加密备份的任意一字节：解密必须失败，错误可读且不泄露细节。
    #[tokio::test]
    async fn tampered_encrypted_backup_is_rejected_with_readable_error() {
        let (dir, app, _state, cookie) = setup("tamper").await;
        let mut body = export_bytes(&app, &cookie).await;
        assert!(body.starts_with(&secret_box::MAGIC));
        let last = body.len() - 1;
        body[last] ^= 0x01;

        let (status, _, response) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            body,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let payload = json(&response);
        assert_eq!(payload["code"], "backup.restore_decrypt_failed");
        let message = payload["error"].as_str().unwrap();
        assert!(message.contains("解密失败"), "错误要可读：{message}");
        assert!(
            message.contains("主密钥") || message.contains("损坏"),
            "错误要说明可能原因：{message}"
        );
        assert!(
            !message.contains("PWSB") && !message.contains("tag"),
            "错误不能透露密文/实现细节：{message}"
        );
        assert!(
            !backup::pending_path(&dir.db_path()).exists(),
            "解密失败不能留下待恢复文件"
        );
    }

    /// 关闭 `backup_encrypt` 后：导出是明文 `.db.gz`，且这份旧格式仍可恢复。
    #[tokio::test]
    async fn disabling_backup_encryption_outputs_plaintext_and_still_restores() {
        let (dir, app, state, cookie) = setup("plain-export").await;
        repo::settings::set(&state.db.pool, "backup_encrypt", "0")
            .await
            .unwrap();

        let (status, headers, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/backup",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap().to_str().unwrap(),
            "application/gzip"
        );
        let disposition = headers
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            disposition.ends_with(".db.gz\""),
            "关闭加密后必须是 .db.gz：{disposition}"
        );
        assert!(gzip_magic(&body), "关闭加密后必须是明文 gzip");
        assert!(!body.starts_with(&secret_box::MAGIC));

        // 旧的明文 .db.gz 备份（这里就是关闭加密后的导出）仍然可以恢复。
        let (status, _, response) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            body,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&response)
        );
        assert!(backup::pending_path(&dir.db_path()).exists());
    }

    /// 默认导出再原样上传：加密往返成功，落位文件是明文 SQLite。
    #[tokio::test]
    async fn encrypted_export_round_trips_through_restore() {
        let (dir, app, _state, cookie) = setup("enc-roundtrip").await;
        let body = export_bytes(&app, &cookie).await;

        let (status, _, response) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            body,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&response)
        );
        let pending = backup::pending_path(&dir.db_path());
        assert!(pending.exists());
        assert!(std::fs::read(&pending)
            .unwrap()
            .starts_with(backup::SQLITE_MAGIC));
    }

    /// 刚初始化（迁移 + 建管理员）的库：数值不为 0，也不能是几十 MB。
    #[tokio::test]
    async fn info_reports_sane_size_for_fresh_database() {
        let (_dir, app, _state, cookie) = setup("info-fresh").await;

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/backup/info",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let db_bytes = json(&body)["db_bytes"].as_u64().unwrap();
        assert!(db_bytes > 0, "刚初始化的库不应报 0：{db_bytes}");
        assert!(
            db_bytes < 64 * 1024 * 1024,
            "刚初始化的库不应有几十 MB：{db_bytes}"
        );
    }

    /// `db_bytes` 必须算上 WAL 里已提交、尚未 checkpoint 的数据。
    ///
    /// 复现路径：写入 1 MB 到 WAL（低于自动 checkpoint 阈值），主库文件仍很小，
    /// 但 `/backup/info` 报的大小要与 `VACUUM INTO` 快照同量级。
    #[tokio::test]
    async fn info_counts_committed_wal_pages() {
        let (dir, app, state, cookie) = setup("info-wal").await;
        sqlx::query("CREATE TABLE wal_probe (payload BLOB)")
            .execute(&state.db.pool)
            .await
            .unwrap();
        let payload = vec![9u8; 32 * 1024];
        for _ in 0..32 {
            sqlx::query("INSERT INTO wal_probe (payload) VALUES (?)")
                .bind(&payload)
                .execute(&state.db.pool)
                .await
                .unwrap();
        }

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/backup/info",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let db_bytes = json(&body)["db_bytes"].as_u64().unwrap();

        let main_bytes = std::fs::metadata(dir.db_path()).unwrap().len();
        let snapshot = dir.file("info-snapshot.db");
        backup::create_snapshot(&state.db.pool, &snapshot)
            .await
            .unwrap();
        let snapshot_bytes = std::fs::metadata(&snapshot).unwrap().len();

        assert!(
            db_bytes > main_bytes,
            "db_bytes={db_bytes} 必须大于主库文件 {main_bytes}"
        );
        assert!(
            db_bytes >= snapshot_bytes,
            "db_bytes={db_bytes} 不应小于备份快照 {snapshot_bytes}"
        );
        assert!(
            db_bytes <= snapshot_bytes * 2,
            "与快照量级相差过大：db_bytes={db_bytes}, 快照={snapshot_bytes}"
        );
        // 1 MB 数据确实在库里：不能只报迁移后的空表页。
        assert!(db_bytes >= 1024 * 1024, "db_bytes={db_bytes}");
    }

    // ---- 异地备份（WebDAV）----

    async fn configure_webdav(state: &AppState, url: &str, password: &str, keep: i64) {
        for (key, value) in [
            ("backup_webdav_enabled", "1".to_string()),
            ("backup_webdav_url", url.to_string()),
            ("backup_webdav_username", "pierwave".to_string()),
            ("backup_webdav_password", password.to_string()),
            ("backup_webdav_interval_hours", "24".to_string()),
            ("backup_webdav_keep", keep.to_string()),
        ] {
            repo::settings::set(&state.db.pool, key, &value)
                .await
                .unwrap();
        }
    }

    fn dav_file(name: &str, size: usize) -> (String, (Vec<u8>, i64)) {
        (name.to_string(), (vec![0u8; size], 1_767_225_600))
    }

    fn gzip_magic(bytes: &[u8]) -> bool {
        bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
    }

    #[tokio::test]
    async fn remote_upload_puts_snapshot_and_only_prunes_same_prefix() {
        let fake = crate::webdav_fake::FakeDav::start(crate::webdav_fake::FakeState {
            files: [
                dav_file("pierwave-backup-20260101-000000.db.gz", 1),
                dav_file("pierwave-backup-20260102-000000.db.gz", 1),
                dav_file("pierwave-backup-20260103-000000.db.gz", 1),
                dav_file("pierwave-backup-20260104-000000.db.gz", 1),
                // 非本产品写入的文件：无论如何都不能删。
                dav_file("notes.txt", 3),
                dav_file("pierwave-backup-manual.db.gz", 5),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        })
        .await;
        let (dir, app, state, cookie) = setup("remote-upload").await;
        configure_webdav(&state, &fake.base_url, "s3cret", 2).await;

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/remote/run",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        let payload = json(&body);
        assert_eq!(payload["ok"], true);
        let name = payload["file"]["name"].as_str().unwrap();
        assert!(
            name.starts_with("pierwave-backup-") && name.ends_with(".db.gz.enc"),
            "默认上传的必须是加密备份：{name}"
        );
        assert!(payload["file"]["size"].as_u64().unwrap() > 0);
        assert_eq!(
            payload["deleted"].as_array().unwrap().len(),
            3,
            "4 份旧备份 + 新上传，keep=2 时应删 3 份：{payload}"
        );

        {
            let fake_state = fake.state();
            assert_eq!(
                fake_state.files.len(),
                4,
                "远端应剩 2 份本产品备份 + 2 份别人的文件：{:?}",
                fake_state.files.keys().collect::<Vec<_>>()
            );
            assert!(fake_state.files.contains_key(name), "新备份必须已在远端");
            assert!(fake_state.files.contains_key("notes.txt"));
            assert!(fake_state
                .files
                .contains_key("pierwave-backup-manual.db.gz"));
            for deleted in [
                "pierwave-backup-20260101-000000.db.gz",
                "pierwave-backup-20260102-000000.db.gz",
                "pierwave-backup-20260103-000000.db.gz",
            ] {
                assert!(
                    !fake_state.files.contains_key(deleted),
                    "旧备份应被删除：{deleted}"
                );
            }
            assert!(fake_state
                .files
                .contains_key("pierwave-backup-20260104-000000.db.gz"));
            let uploaded = &fake_state.files[name].0;
            // 上传到假 WebDAV 的内容必须是密文：不是 gzip，也不是明文 SQLite。
            assert!(
                uploaded.starts_with(&secret_box::MAGIC),
                "上传的必须是加密信封"
            );
            assert!(!gzip_magic(uploaded), "上传内容不能是明文 gzip");
            assert!(
                !uploaded.starts_with(backup::SQLITE_MAGIC),
                "上传内容不能是明文 SQLite"
            );
            let gz = secret_box::open(state.db.secret_key(), uploaded).unwrap();
            assert!(gzip_magic(&gz), "解密后应是本产品的 gzip");
            let raw = gunzip(&gz);
            assert!(
                raw.starts_with(backup::SQLITE_MAGIC),
                "解压后必须是 SQLite 数据库"
            );
        }

        // 状态接口：成功时间、无错误、最近文件不超过 30 条。
        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/backup/remote",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let status_payload = json(&body);
        assert!(status_payload["last_success_at"].as_i64().unwrap() > 0);
        assert!(status_payload["last_error"].is_null());
        let files = status_payload["files"].as_array().unwrap();
        assert_eq!(files.len(), 2, "只列本产品的备份：{status_payload}");
        assert!(files.iter().all(|file| file["name"]
            .as_str()
            .unwrap()
            .starts_with("pierwave-backup-")));
        assert!(files[0]["size"].as_u64().unwrap() > 0);
        assert!(files[0]["modified"].as_i64().is_some());

        assert!(
            leftover_temp_files(&dir.path).is_empty(),
            "上传结束后不能留下临时文件：{:?}",
            leftover_temp_files(&dir.path)
        );

        let actions: Vec<String> = repo::audit::list(&state.db.pool, 50)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.action)
            .collect();
        assert!(
            actions.contains(&"backup.remote.upload".to_string()),
            "立即备份要进审计：{actions:?}"
        );
    }

    #[tokio::test]
    async fn remote_test_connection_reports_success_and_failure_safely() {
        let fake =
            crate::webdav_fake::FakeDav::start(crate::webdav_fake::FakeState::default()).await;
        let (_dir, app, state, cookie) = setup("remote-test").await;

        // 未配置：返回可读的 400，而不是 500。
        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/remote/test",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json(&body)["code"], "backup.remote_not_configured");

        configure_webdav(&state, &fake.base_url, "hunter2-secret", 7).await;
        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/remote/test",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body)["ok"], true);

        // 认证失败：200 + ok:false + 打码原因（测试连接失败是业务结果）。
        fake.state().fail_requests = 1;
        fake.state().fail_status = 401;
        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/remote/test",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let payload = json(&body);
        assert_eq!(payload["ok"], false);
        let error = payload["error"].as_str().unwrap();
        assert!(error.contains("401"), "{error}");
        assert!(
            !error.contains("hunter2-secret"),
            "错误信息不能泄露密码：{error}"
        );
    }

    #[tokio::test]
    async fn remote_upload_retries_with_backoff_then_succeeds() {
        let fake = crate::webdav_fake::FakeDav::start(crate::webdav_fake::FakeState {
            fail_requests: 2,
            fail_status: 500,
            ..Default::default()
        })
        .await;
        let (_dir, app, state, cookie) = setup("remote-retry").await;
        configure_webdav(&state, &fake.base_url, "pass", 7).await;

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/remote/run",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        let put_attempts = fake
            .state()
            .requests
            .iter()
            .filter(|line| line.starts_with("PUT "))
            .count();
        assert_eq!(put_attempts, 3, "失败两次后第三次成功，共 3 次尝试");
    }

    #[tokio::test]
    async fn remote_upload_failure_records_status_and_alerts() {
        let fake = crate::webdav_fake::FakeDav::start(crate::webdav_fake::FakeState {
            fail_requests: 99,
            fail_status: 500,
            ..Default::default()
        })
        .await;
        let (_dir, _app, mut state, _cookie) = setup("remote-fail").await;
        configure_webdav(&state, &fake.base_url, "very-secret-pass", 7).await;
        repo::settings::set(&state.db.pool, "webhook_url", "https://example.test/hook")
            .await
            .unwrap();
        repo::settings::set(&state.db.pool, "alert_events", "backup_failed")
            .await
            .unwrap();
        repo::settings::set(&state.db.pool, "alert_cooldown_secs", "0")
            .await
            .unwrap();
        let transport = std::sync::Arc::new(crate::alerts::RecordingTransport::default());
        state.alerts = crate::alerts::Alerts::new(transport.clone());

        let round = crate::scheduler::run_remote_backup_round(&state)
            .await
            .unwrap();
        match round {
            crate::scheduler::RemoteBackupRound::Failed(message) => {
                assert!(message.contains("500"), "{message}");
                assert!(
                    !message.contains("very-secret-pass"),
                    "失败原因不能泄露密码：{message}"
                );
            }
            other => panic!("应失败，实际 {other:?}"),
        }

        let meta = crate::remote_backup::load_meta(&state.db.pool).await;
        assert!(meta.last_failure_at.unwrap() > 0, "失败时间要落库");
        assert!(
            meta.last_attempt_at.unwrap() > 0,
            "尝试时间要落库，避免间隔内反复重试"
        );
        assert!(meta.last_success_at.is_none());
        assert!(meta.last_error.contains("500"), "{}", meta.last_error);
        assert!(!meta.last_error.contains("very-secret-pass"));

        // 最多 3 次尝试。
        let put_attempts = fake
            .state()
            .requests
            .iter()
            .filter(|line| line.starts_with("PUT "))
            .count();
        assert_eq!(put_attempts, 3);

        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "backup_failed");
        assert_eq!(sent[0].target, "backup");
        assert!(
            !sent[0].body.contains("very-secret-pass"),
            "告警正文不能泄露密码：{}",
            sent[0].body
        );
    }

    #[tokio::test]
    async fn remote_upload_is_mutually_exclusive() {
        let fake = crate::webdav_fake::FakeDav::start(crate::webdav_fake::FakeState {
            delay: std::time::Duration::from_millis(300),
            ..Default::default()
        })
        .await;
        let (_dir, app, state, cookie) = setup("remote-busy").await;
        configure_webdav(&state, &fake.base_url, "pass", 7).await;

        let first = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/remote/run",
            Vec::new(),
        );
        let second = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/remote/run",
            Vec::new(),
        );
        let ((first_status, _, first_body), (second_status, _, second_body)) =
            tokio::join!(first, second);

        let statuses = [first_status, second_status];
        assert!(
            statuses.contains(&StatusCode::OK),
            "两个并发请求必须有一个成功：{} / {}",
            String::from_utf8_lossy(&first_body),
            String::from_utf8_lossy(&second_body)
        );
        let busy = if first_status == StatusCode::CONFLICT {
            &first_body
        } else {
            assert_eq!(
                second_status,
                StatusCode::CONFLICT,
                "另一个必须被互斥挡住：{}",
                String::from_utf8_lossy(&second_body)
            );
            &second_body
        };
        assert_eq!(json(busy)["code"], "backup.remote_busy");
    }

    #[tokio::test]
    async fn remote_status_is_admin_only() {
        let (_dir, app, state, _cookie) = setup("remote-auth").await;
        let (status, _, _) =
            request(&app, None, Method::GET, "/api/v1/backup/remote", Vec::new()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let bob = repo::users::create(
            &state.db.pool,
            NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&state.db.pool, &bob.id, 3600, None)
            .await
            .unwrap();
        let bob_cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);
        let (status, _, body) = request(
            &app,
            Some(&bob_cookie),
            Method::GET,
            "/api/v1/backup/remote",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(json(&body)["code"], "auth.forbidden");
    }

    #[tokio::test]
    async fn cancel_without_pending_is_rejected() {
        let (_dir, app, _state, cookie) = setup("no-pending").await;
        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            "/api/v1/backup/restore",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json(&body)["error"]
            .as_str()
            .unwrap()
            .contains("没有待恢复"));
    }
}
