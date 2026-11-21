//! 备份与离线恢复：一致性快照、备份文件校验、启动时应用待恢复文件。
//!
//! 恢复**不在线替换**正在使用的 SQLite 文件：上传阶段只落盘为
//! `<db>.restore-pending`，由 `main` 在**打开连接池之前**调用
//! [`apply_pending_restore`] 完成替换。这样连接池不会持有被换掉的旧 inode。
//!
//! 这里只处理「文件」层面的事情，不依赖 axum；gzip 压缩与 HTTP 响应在
//! `crates/master` 里做。

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::error::DomainError;
use crate::repo;

/// 备份文件大小上限（上传的压缩体与解压后的数据库分别适用）。
pub const MAX_BACKUP_BYTES: u64 = 512 * 1024 * 1024;

/// 大小超限的稳定错误；`max_mb` 供前端插值，避免文案里写死单位换算。
fn too_large_error(len: u64) -> DomainError {
    let max_mb = MAX_BACKUP_BYTES / (1024 * 1024);
    DomainError::with_params(
        "backup.restore_too_large",
        json!({ "max_mb": max_mb }),
        format!(
            "备份文件大小 {} MB 超过 {max_mb} MB 上限",
            len / (1024 * 1024)
        ),
    )
}

/// SQLite 文件头，必须是文件最开头的 16 个字节。
pub const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

/// gzip 魔数；上传时按内容判断，而不是看扩展名。
pub const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

/// 恢复前必须存在的表；`_sqlx_migrations` 用来判断备份的迁移版本。
pub const REQUIRED_TABLES: [&str; 2] = ["users", "_sqlx_migrations"];

/// 待恢复文件后缀，直接拼在主库文件名后面。
pub const PENDING_SUFFIX: &str = ".restore-pending";

const PRE_RESTORE_INFIX: &str = ".pre-restore-";

/// 一次启动检查的结果。
#[derive(Debug, PartialEq, Eq)]
pub enum RestoreOutcome {
    /// 没有 `<db>.restore-pending`，正常启动。
    NoPending,
    /// 校验通过并已替换；`previous` 是旧库的回滚副本（首次建库时可能没有）。
    Applied {
        pending: PathBuf,
        previous: Option<PathBuf>,
    },
    /// 文件存在但校验不通过：**不替换**，保留现场，由调用方记录日志/审计。
    Rejected { reason: String },
}

/// `.../pierwave.db` -> `.../pierwave.db.restore-pending`。
pub fn pending_path(db_path: &Path) -> PathBuf {
    append_suffix(db_path, PENDING_SUFFIX)
}

/// `.../pierwave.db` -> `.../pierwave.db.pre-restore-20260101-000000`。
pub fn pre_restore_path(db_path: &Path, timestamp: &str) -> PathBuf {
    append_suffix(db_path, &format!("{PRE_RESTORE_INFIX}{timestamp}"))
}

/// 备份文件名里的时间戳（UTC，`YYYYmmdd-HHMMSS`）。
pub fn filename_timestamp() -> String {
    chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string()
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// 用 `VACUUM INTO` 在 `target` 生成一致性快照。
///
/// 调用方负责在用完后删除 `target`；目标已存在时直接报错（SQLite 的
/// `VACUUM INTO` 不会覆盖已有文件）。
pub async fn create_snapshot(pool: &SqlitePool, target: &Path) -> anyhow::Result<()> {
    if target.exists() {
        bail!("临时快照文件已存在：{}", target.display());
    }
    let target = target
        .to_str()
        .context("临时快照路径不是合法 UTF-8，无法交给 SQLite")?;
    repo::backup::vacuum_into(pool, target)
        .await
        .with_context(|| format!("生成数据库快照失败：{target}"))?;
    // 快照就是完整业务数据：生成后立刻收紧，避免默认 umask 落成 0644。
    crate::fs_security::ensure_private_file(Path::new(target))
        .with_context(|| format!("收紧快照权限失败：{target}"))?;
    Ok(())
}

/// 校验一个**未压缩**的 SQLite 备份文件，返回文件字节数。
///
/// 失败信息是面向用户的中文，直接展示在 400 响应里。校验顺序：
/// 大小 -> 文件头魔数 -> `PRAGMA quick_check` -> 必需表 -> 迁移版本不高于当前二进制。
pub async fn validate_backup_file(path: &Path) -> anyhow::Result<u64> {
    let meta =
        fs::metadata(path).with_context(|| format!("读取备份文件失败：{}", path.display()))?;
    if !meta.is_file() {
        return Err(DomainError::new("backup.restore_invalid", "备份不是普通文件").into());
    }
    if meta.len() == 0 {
        return Err(DomainError::new("backup.restore_invalid", "备份文件为空").into());
    }
    if meta.len() > MAX_BACKUP_BYTES {
        return Err(too_large_error(meta.len()).into());
    }

    let mut header = [0u8; 16];
    let read = File::open(path)
        .and_then(|mut file| file.read(&mut header))
        .with_context(|| format!("读取备份文件头失败：{}", path.display()))?;
    if read < header.len() || &header[..] != SQLITE_MAGIC {
        return Err(DomainError::new(
            "backup.restore_bad_header",
            "文件头不是 SQLite format 3（不是有效的 SQLite 数据库）",
        )
        .into());
    }

    // 只读打开：校验过程绝不能修改备份文件。
    let pool = open_readonly(path).await?;
    let result = inspect(&pool).await;
    pool.close().await;
    result?;
    Ok(meta.len())
}

/// 扫描备份库 `settings` 里所有 `enc:v1:` 值，返回**当前主密钥解不开**的键名。
///
/// 恢复接口在把上传文件 rename 成 `.restore-pending` 之前调用；返回空表示
/// 备份里的秘密都能被当前实例读取。只读打开，不修改备份文件。
pub async fn unreadable_encrypted_settings(
    path: &Path,
    key: &crate::secret_box::SecretKey,
) -> anyhow::Result<Vec<String>> {
    let pool = open_readonly(path).await?;
    let result = crate::secret_box::find_unreadable_settings(&pool, key).await;
    pool.close().await;
    result
}

/// `force` 覆盖恢复时丢弃候选库里无法解密的秘密行。
///
/// 管理员已确认「丢弃旧秘密」：这些行留着只会让恢复后的设置页 400、订阅 500，
/// 且没有任何入口能修复内部 `hmac_secret_v1`。只删**解不开**的 `enc:v1:` 行；
/// 能解开的历史密文和所有非秘密设置原样保留。
pub async fn discard_unreadable_settings(
    path: &Path,
    key: &crate::secret_box::SecretKey,
) -> anyhow::Result<Vec<String>> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .with_context(|| format!("无法打开待恢复数据库以丢弃旧秘密：{}", path.display()))?;
    let result = async {
        let unreadable = crate::secret_box::find_unreadable_settings(&pool, key).await?;
        for name in &unreadable {
            repo::settings::delete(&pool, name).await?;
            // 依赖该秘密的开关必须一起关掉：否则恢复后会出现
            // 「backup_webdav_enabled=1 但密码为空」这种悬空状态，任务只在
            // 日志里静默失败，管理员以为备份还开着。
            let dependent_switch = match name.as_str() {
                "backup_webdav_password" => Some("backup_webdav_enabled"),
                "telegram_bot_token" => Some("telegram_bot_enabled"),
                _ => None,
            };
            if let Some(switch) = dependent_switch {
                repo::settings::set(&pool, switch, "0").await?;
            }
        }
        Ok(unreadable)
    }
    .await;
    pool.close().await;
    result
}

async fn inspect(pool: &SqlitePool) -> anyhow::Result<()> {
    // 先做完整性检查：截断/损坏的库可能在 sqlite_master 里仍有表名，
    // 但页链已经断了；直接往下查表会得到难以理解的 SQLite 内部错误。
    let problems = match repo::backup::quick_check(pool).await {
        Ok(problems) => problems,
        Err(error) => {
            return Err(DomainError::new(
                "backup.restore_corrupt",
                format!(
                    "备份数据库完整性校验失败（文件可能被截断或损坏）：{error} / \
                     The backup database failed its integrity check and may be truncated or corrupted"
                ),
            )
            .into());
        }
    };
    if problems.len() != 1 || problems[0].trim() != "ok" {
        let detail: String = problems.join("; ").chars().take(300).collect();
        return Err(DomainError::with_params(
            "backup.restore_corrupt",
            json!({ "detail": detail }),
            format!(
                "备份数据库完整性校验未通过（文件可能被截断或损坏）：{detail} / \
                 The backup database failed its integrity check and may be truncated or corrupted"
            ),
        )
        .into());
    }

    let mut missing = Vec::new();
    for table in REQUIRED_TABLES {
        let exists = repo::backup::table_exists(pool, table)
            .await
            .with_context(|| format!("读取备份数据库失败（检查表 {table}）"))?;
        if !exists {
            missing.push(table);
        }
    }
    if !missing.is_empty() {
        return Err(DomainError::new(
            "backup.restore_missing_tables",
            format!("备份缺少必需的表：{}", missing.join("、")),
        )
        .into());
    }

    let version = repo::backup::max_migration_version(pool)
        .await
        .context("读取备份的迁移版本失败（_sqlx_migrations 结构异常）")?;
    let supported = crate::latest_migration_version();
    if let Some(version) = version.filter(|version| *version > supported) {
        return Err(DomainError::with_params(
            "backup.restore_migration_too_new",
            json!({ "version": version, "supported": supported }),
            format!(
                "备份的迁移版本 {version} 高于当前程序支持的版本 {supported}，\
                 请使用不低于该版本的程序恢复"
            ),
        )
        .into());
    }
    Ok(())
}

async fn open_readonly(path: &Path) -> anyhow::Result<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .busy_timeout(std::time::Duration::from_secs(5));
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .with_context(|| format!("无法打开备份数据库：{}", path.display()))
}

/// 本产品在数据库目录写下的临时文件前缀。
pub const TEMP_FILE_PREFIXES: [&str; 2] = [".pierwave-restore-", ".pierwave-backup-"];

/// 启动清理只删超过这个年龄的临时文件：1 小时足够覆盖 512 MB 上传/解压，
/// 又不会误删另一个仍在进行中的请求写下的半成品。
pub const STALE_TEMP_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(3_600);

/// 启动时清理上次崩溃/断电流下的临时文件，返回实际删除的路径。
///
/// 只处理 [`TEMP_FILE_PREFIXES`] 开头、且修改时间早于 `max_age` 的**普通文件**；
/// 正在上传/解压的临时文件（mtime 很新）与其它文件一律不动。删除失败只记
/// `warn`，不影响启动。
pub fn cleanup_stale_temp_files(db_path: &Path, max_age: std::time::Duration) -> Vec<PathBuf> {
    let dir = db_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let now = std::time::SystemTime::now();
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !TEMP_FILE_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        // 时钟回拨（mtime 在“未来”）时 `duration_since` 返回 Err：不要当成过期。
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age <= max_age {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => removed.push(path),
            Err(error) => tracing::warn!(
                path = %path.display(),
                %error,
                "清理启动残留临时文件失败（继续启动）"
            ),
        }
    }
    removed
}

/// 启动时应用 `<db>.restore-pending`。
///
/// - 没有待恢复文件：返回 [`RestoreOutcome::NoPending`]；
/// - 校验不通过：返回 [`RestoreOutcome::Rejected`]，**不替换**、文件保留；
/// - 校验通过：当前库（含 `-wal`/`-shm` 旁路文件）改名为
///   `<db>.pre-restore-<ts>`，待恢复文件改名为正式库。
///
/// 任一步改名失败都会尽量回滚已经移动的文件并返回错误，避免出现
/// 「主库没了、旧库也不知道在哪」的半完成状态。
pub async fn apply_pending_restore(db_path: &Path) -> anyhow::Result<RestoreOutcome> {
    let pending = pending_path(db_path);
    if !pending.exists() {
        return Ok(RestoreOutcome::NoPending);
    }

    // 先收紧：即使随后校验失败、文件被保留，也不该让 group/other 读到其中的数据。
    if let Err(error) = crate::fs_security::ensure_private_file(&pending) {
        tracing::warn!(
            path = %pending.display(),
            %error,
            "收紧待恢复文件权限失败（继续校验）"
        );
    }

    if let Err(error) = validate_backup_file(&pending).await {
        return Ok(RestoreOutcome::Rejected {
            reason: format!("{error:#}"),
        });
    }

    let previous = move_current_aside(db_path)?;
    if let Err(error) = fs::rename(&pending, db_path) {
        rollback_previous(db_path, previous.as_deref());
        return Err(error).with_context(|| {
            format!(
                "用待恢复文件替换数据库失败：{} -> {}",
                pending.display(),
                db_path.display()
            )
        });
    }

    // 待恢复文件可能是旧版本上传的 0644 副本；落位后主库必须立即收紧。
    crate::fs_security::ensure_private_file(db_path)
        .with_context(|| format!("收紧恢复后的数据库权限失败：{}", db_path.display()))?;

    Ok(RestoreOutcome::Applied { pending, previous })
}

/// 把当前主库与 WAL/SHM 旁路文件一起改名，返回回滚副本路径。
fn move_current_aside(db_path: &Path) -> anyhow::Result<Option<PathBuf>> {
    if !db_path.exists() {
        return Ok(None);
    }

    // 同一秒内重复调用时不要让 rename 覆盖已有的回滚副本。
    let timestamp = filename_timestamp();
    let mut previous = pre_restore_path(db_path, &timestamp);
    let mut serial = 1;
    while previous.exists() {
        previous = pre_restore_path(db_path, &format!("{timestamp}-{serial}"));
        serial += 1;
    }

    fs::rename(db_path, &previous)
        .with_context(|| format!("把当前数据库改名为 {} 失败", previous.display()))?;

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for suffix in ["-wal", "-shm"] {
        let source = append_suffix(db_path, suffix);
        if !source.exists() {
            continue;
        }
        let target = append_suffix(&previous, suffix);
        if let Err(error) = fs::rename(&source, &target) {
            for (source, target) in moved.iter().rev() {
                let _ = fs::rename(target, source);
            }
            let _ = fs::rename(&previous, db_path);
            return Err(error)
                .with_context(|| format!("把数据库旁路文件改名为 {} 失败", target.display()));
        }
        moved.push((source, target));
    }
    Ok(Some(previous))
}

/// 替换失败时把旧库（含旁路文件）搬回原位；尽力而为，不覆盖原始错误。
fn rollback_previous(db_path: &Path, previous: Option<&Path>) {
    let Some(previous) = previous else {
        return;
    };
    for suffix in ["-wal", "-shm"] {
        let source = append_suffix(previous, suffix);
        if source.exists() {
            let _ = fs::rename(&source, append_suffix(db_path, suffix));
        }
    }
    if previous.exists() {
        let _ = fs::rename(previous, db_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::models::User;
    use crate::repo::users::{self, NewUser};
    use crate::Db;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "pierwave-domain-backup-{tag}-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).unwrap();
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
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    async fn open_db(path: &Path) -> Db {
        Db::connect(&format!("sqlite://{}?mode=rwc", path.display()))
            .await
            .unwrap()
    }

    async fn create_user(db: &Db, username: &str) -> User {
        users::create(
            &db.pool,
            NewUser {
                username: username.into(),
                password: "password123".into(),
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
            },
        )
        .await
        .unwrap()
    }

    fn domain_error(error: &anyhow::Error) -> &DomainError {
        error
            .chain()
            .find_map(|cause| cause.downcast_ref::<DomainError>())
            .expect("备份校验错误必须携带 DomainError")
    }

    #[tokio::test]
    async fn snapshot_is_a_readable_database_with_required_tables() {
        let dir = TestDir::new("snapshot");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();
        create_user(&db, "admin").await;

        let target = dir.file("snapshot.db");
        create_snapshot(&db.pool, &target).await.unwrap();
        validate_backup_file(&target).await.unwrap();

        let snapshot = open_db(&target).await;
        assert!(repo::backup::table_exists(&snapshot.pool, "users")
            .await
            .unwrap());
        assert_eq!(users::count(&snapshot.pool).await.unwrap(), 1);
        assert_eq!(
            users::find_by_username(&snapshot.pool, "admin")
                .await
                .unwrap()
                .unwrap()
                .username,
            "admin"
        );
        snapshot.pool.close().await;
    }

    /// 恢复前必须能用当前主密钥解开备份里的每一个 `enc:v1:` 值。
    #[tokio::test]
    async fn detects_secret_settings_written_with_another_master_key() {
        let dir = TestDir::new("key-mismatch");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();
        let other = crate::secret_box::SecretKey::from_bytes([0x5A; crate::secret_box::KEY_LEN]);
        repo::settings::set(
            &db.pool,
            "telegram_bot_token",
            &crate::secret_box::encrypt_setting(&other, "123456:other-instance"),
        )
        .await
        .unwrap();
        let snapshot = dir.file("other-key.db");
        create_snapshot(&db.pool, &snapshot).await.unwrap();

        let unreadable = unreadable_encrypted_settings(&snapshot, db.secret_key())
            .await
            .unwrap();
        assert_eq!(unreadable, vec!["telegram_bot_token".to_string()]);
        assert!(!format!("{unreadable:?}").contains("other-instance"));

        assert!(
            unreadable_encrypted_settings(&snapshot, &other)
                .await
                .unwrap()
                .is_empty(),
            "同一把密钥不应报告任何问题"
        );

        // force = 丢弃旧秘密：只删解不开的行，之后扫描为空。
        let discarded = discard_unreadable_settings(&snapshot, db.secret_key())
            .await
            .unwrap();
        assert_eq!(discarded, unreadable);
        assert!(unreadable_encrypted_settings(&snapshot, db.secret_key())
            .await
            .unwrap()
            .is_empty());
        db.pool.close().await;
    }

    /// force 丢弃依赖秘密时，依赖它的开关必须一起关掉，不能留下悬空状态。
    #[tokio::test]
    async fn discarding_unreadable_secrets_turns_off_dependent_switches() {
        let dir = TestDir::new("force-switches");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();
        for (key, value) in [
            ("backup_webdav_enabled", "1"),
            ("telegram_bot_enabled", "1"),
        ] {
            repo::settings::set(&db.pool, key, value).await.unwrap();
        }
        let other = crate::secret_box::SecretKey::generate().unwrap();
        for key in [
            "backup_webdav_password",
            "telegram_bot_token",
            "hmac_secret_v1",
        ] {
            repo::settings::set(
                &db.pool,
                key,
                &crate::secret_box::encrypt_setting(&other, "other-instance"),
            )
            .await
            .unwrap();
        }
        let snapshot = dir.file("force-switches.db");
        create_snapshot(&db.pool, &snapshot).await.unwrap();
        db.pool.close().await;

        let discarded = discard_unreadable_settings(&snapshot, db.secret_key())
            .await
            .unwrap();
        assert_eq!(
            discarded,
            vec![
                "backup_webdav_password".to_string(),
                "hmac_secret_v1".to_string(),
                "telegram_bot_token".to_string(),
            ]
        );

        let restored = open_db(&snapshot).await;
        for key in ["backup_webdav_enabled", "telegram_bot_enabled"] {
            assert_eq!(
                repo::settings::get(&restored.pool, key)
                    .await
                    .unwrap()
                    .as_deref(),
                Some("0"),
                "丢弃凭据后 {key} 必须关闭，不能留下 enabled=1 的悬空开关"
            );
        }
        restored.pool.close().await;
    }

    /// 快照会被 gzip 后下载/上传到远端：文件本身必须只有属主可读。
    #[cfg(unix)]
    #[tokio::test]
    async fn snapshot_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TestDir::new("snapshot-perm");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();

        let target = dir.file("snapshot.db");
        create_snapshot(&db.pool, &target).await.unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "VACUUM INTO 产物必须是 0600");
        db.pool.close().await;
    }

    /// 待恢复文件同样含完整业务数据，落位后必须是 0600。
    #[cfg(unix)]
    #[tokio::test]
    async fn pending_restore_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TestDir::new("pending-perm");
        let db_path = dir.db_path();
        let current = open_db(&db_path).await;
        current.migrate().await.unwrap();
        current.pool.close().await;

        // 用一份合法快照冒充上传成功后的落盘结果。
        let source_path = dir.file("source.db");
        let source = open_db(&source_path).await;
        source.migrate().await.unwrap();
        let snapshot = dir.file("snapshot.db");
        create_snapshot(&source.pool, &snapshot).await.unwrap();
        source.pool.close().await;

        let pending = pending_path(&db_path);
        std::fs::copy(&snapshot, &pending).unwrap();
        let mode_before = std::fs::metadata(&pending).unwrap().permissions().mode() & 0o777;
        // 模拟上传临时文件之前可能过宽的历史状态；启动应用恢复时必须收紧。
        std::fs::set_permissions(&pending, std::fs::Permissions::from_mode(0o644)).unwrap();
        let outcome = apply_pending_restore(&db_path).await.unwrap();
        assert!(
            matches!(outcome, RestoreOutcome::Applied { .. }),
            "{outcome:?}"
        );
        let mode = std::fs::metadata(&db_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "恢复后的主库必须是 0600（之前是 {mode_before:04o} 的副本）"
        );
    }

    #[tokio::test]
    async fn rejects_non_sqlite_empty_and_tableless_files() {
        let dir = TestDir::new("invalid");

        let text = dir.file("text.db");
        fs::write(&text, b"this is not a database").unwrap();
        let error = validate_backup_file(&text).await.unwrap_err();
        assert_eq!(domain_error(&error).code, "backup.restore_bad_header");
        let reason = error.to_string();
        assert!(reason.contains("SQLite format 3"), "实际：{reason}");

        let empty = dir.file("empty.db");
        fs::write(&empty, b"").unwrap();
        let error = validate_backup_file(&empty).await.unwrap_err();
        assert_eq!(domain_error(&error).code, "backup.restore_invalid");
        let reason = error.to_string();
        assert!(reason.contains("为空"), "实际：{reason}");

        // 合法 SQLite 文件，但没有业务表。
        let tableless = dir.file("tableless.db");
        let db = open_db(&tableless).await;
        sqlx::query("CREATE TABLE dummy (id INTEGER PRIMARY KEY)")
            .execute(&db.pool)
            .await
            .unwrap();
        db.pool.close().await;
        let error = validate_backup_file(&tableless).await.unwrap_err();
        assert_eq!(domain_error(&error).code, "backup.restore_missing_tables");
        let reason = error.to_string();
        assert!(reason.contains("users"), "实际：{reason}");
        assert!(reason.contains("_sqlx_migrations"), "实际：{reason}");
    }

    /// 截断一页的 SQLite 文件：表还在 sqlite_master 里，但页链已经不完整。
    /// 恢复前必须靠完整性校验拒绝，而不是等启动后查询才炸。
    #[tokio::test]
    async fn rejects_truncated_sqlite_backup() {
        let dir = TestDir::new("truncated");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();
        create_user(&db, "admin").await;

        let target = dir.file("truncated.db");
        create_snapshot(&db.pool, &target).await.unwrap();
        db.pool.close().await;

        let len = fs::metadata(&target).unwrap().len();
        assert!(len > 4096, "迁移后的库不止一页，才有截断空间");
        let file = fs::OpenOptions::new().write(true).open(&target).unwrap();
        file.set_len(len - 4096).unwrap();
        drop(file);

        let error = validate_backup_file(&target).await.unwrap_err();
        let domain = domain_error(&error);
        assert_eq!(
            domain.code, "backup.restore_corrupt",
            "截断的备份必须被判为损坏：{domain}"
        );
        let reason = error.to_string();
        assert!(
            reason.contains("完整性") || reason.contains("损坏") || reason.contains("截断"),
            "错误要可读：{reason}"
        );
    }

    /// quick_check 的耗时口径：在 ~20 MB 的合成库上测 `validate_backup_file`
    /// 的墙钟时间。阈值刻意放宽到 10 秒，只防「随库大小爆炸」的回归，不做性能基准。
    #[tokio::test]
    async fn integrity_check_stays_fast_on_a_moderate_database() {
        let dir = TestDir::new("integrity-perf");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();
        create_user(&db, "admin").await;
        sqlx::query("CREATE TABLE synthetic (id INTEGER PRIMARY KEY, payload BLOB)")
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query(
            "WITH RECURSIVE seq(x) AS (
                 SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < 10000
             )
             INSERT INTO synthetic (payload) SELECT randomblob(2048) FROM seq",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        let target = dir.file("moderate.db");
        create_snapshot(&db.pool, &target).await.unwrap();
        db.pool.close().await;

        let started = std::time::Instant::now();
        validate_backup_file(&target).await.unwrap();
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "~20 MB 备份的校验耗时 {elapsed:?} 超出预期"
        );
    }

    #[tokio::test]
    async fn rejects_non_file_and_oversized_backups() {
        let dir = TestDir::new("size");

        // 目录不是普通文件：不能交给 SQLite。
        let error = validate_backup_file(&dir.path).await.unwrap_err();
        let domain = domain_error(&error);
        assert_eq!(domain.code, "backup.restore_invalid");
        assert!(domain.message.contains("普通文件"), "{domain}");

        // 稀疏文件只占元数据，足以触发大小检查而不真的写 512 MB。
        let oversized = dir.file("oversized.db");
        let file = File::create(&oversized).unwrap();
        file.set_len(MAX_BACKUP_BYTES + 1).unwrap();
        drop(file);
        let error = validate_backup_file(&oversized).await.unwrap_err();
        let domain = domain_error(&error);
        assert_eq!(domain.code, "backup.restore_too_large");
        assert_eq!(domain.params, json!({ "max_mb": 512 }));
        assert!(domain.message.contains("超过 512 MB"), "{domain}");
    }

    #[tokio::test]
    async fn rejects_migration_version_newer_than_this_binary() {
        let dir = TestDir::new("future");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();
        create_user(&db, "admin").await;
        sqlx::query(
            "INSERT INTO _sqlx_migrations
                (version, description, success, checksum, execution_time)
             VALUES (?, 'from the future', 1, ?, 0)",
        )
        .bind(crate::latest_migration_version() + 1)
        .bind(Vec::<u8>::new())
        .execute(&db.pool)
        .await
        .unwrap();

        let target = dir.file("future.db");
        create_snapshot(&db.pool, &target).await.unwrap();
        let error = validate_backup_file(&target).await.unwrap_err();
        let domain = domain_error(&error);
        assert_eq!(domain.code, "backup.restore_migration_too_new");
        assert_eq!(
            domain.params,
            json!({
                "version": crate::latest_migration_version() + 1,
                "supported": crate::latest_migration_version(),
            })
        );
        let reason = error.to_string();
        assert!(reason.contains("迁移版本"), "实际：{reason}");
        assert!(reason.contains("高于当前程序支持"), "实际：{reason}");
        db.pool.close().await;
    }

    #[tokio::test]
    async fn applies_valid_pending_and_keeps_previous_database() {
        let dir = TestDir::new("apply");
        let db_path = dir.db_path();
        let current = open_db(&db_path).await;
        current.migrate().await.unwrap();
        create_user(&current, "old-admin").await;

        // 另建一个「备份库」，里面是恢复后应出现的数据。
        let source_path = dir.file("source.db");
        let source = open_db(&source_path).await;
        source.migrate().await.unwrap();
        create_user(&source, "restored-admin").await;
        let snapshot = dir.file("snapshot.db");
        create_snapshot(&source.pool, &snapshot).await.unwrap();
        source.pool.close().await;

        fs::copy(&snapshot, pending_path(&db_path)).unwrap();
        current.pool.close().await;

        let outcome = apply_pending_restore(&db_path).await.unwrap();
        let previous = match outcome {
            RestoreOutcome::Applied { previous, .. } => previous.expect("应保留旧库"),
            other => panic!("应已应用，实际 {other:?}"),
        };
        assert!(!pending_path(&db_path).exists());
        assert!(previous.exists(), "旧库必须保留用于回滚");

        let restored = open_db(&db_path).await;
        assert!(users::find_by_username(&restored.pool, "restored-admin")
            .await
            .unwrap()
            .is_some());
        assert!(users::find_by_username(&restored.pool, "old-admin")
            .await
            .unwrap()
            .is_none());
        restored.pool.close().await;

        let old = open_db(&previous).await;
        assert!(users::find_by_username(&old.pool, "old-admin")
            .await
            .unwrap()
            .is_some());
        old.pool.close().await;
    }

    #[tokio::test]
    async fn rejects_invalid_pending_without_touching_current_database() {
        let dir = TestDir::new("reject");
        let db_path = dir.db_path();
        let current = open_db(&db_path).await;
        current.migrate().await.unwrap();
        create_user(&current, "old-admin").await;
        current.pool.close().await;

        fs::write(pending_path(&db_path), b"broken").unwrap();
        let outcome = apply_pending_restore(&db_path).await.unwrap();
        match outcome {
            RestoreOutcome::Rejected { reason } => {
                assert!(reason.contains("SQLite format 3"), "实际：{reason}");
            }
            other => panic!("应被拒绝，实际 {other:?}"),
        }
        assert!(pending_path(&db_path).exists(), "失败时保留待恢复文件");

        let current = open_db(&db_path).await;
        assert!(users::find_by_username(&current.pool, "old-admin")
            .await
            .unwrap()
            .is_some());
        current.pool.close().await;
    }

    /// 启动清理只删「超时的本产品临时文件」，正在上传的文件与无关文件不能动。
    #[test]
    fn startup_cleanup_removes_only_stale_pierwave_temp_files() {
        let dir = TestDir::new("stale-temp");
        let db_path = dir.db_path();
        let stale_restore = dir.file(".pierwave-restore-upload-old.tmp");
        let stale_backup = dir.file(".pierwave-backup-20260101-000000-old.tmp");
        let fresh_restore = dir.file(".pierwave-restore-upload-active.tmp");
        let unrelated = dir.file("other.tmp");
        for path in [&stale_restore, &stale_backup, &fresh_restore, &unrelated] {
            fs::write(path, b"x").unwrap();
        }

        let two_hours_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(7_200);
        for path in [&stale_restore, &stale_backup, &unrelated] {
            let file = fs::OpenOptions::new().write(true).open(path).unwrap();
            file.set_times(
                std::fs::FileTimes::new()
                    .set_modified(two_hours_ago)
                    .set_accessed(two_hours_ago),
            )
            .unwrap();
        }

        let removed = cleanup_stale_temp_files(&db_path, std::time::Duration::from_secs(3_600));
        let mut removed: Vec<String> = removed
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        removed.sort();
        assert_eq!(
            removed,
            vec![
                ".pierwave-backup-20260101-000000-old.tmp".to_string(),
                ".pierwave-restore-upload-old.tmp".to_string(),
            ],
            "只能清理超时的本产品临时文件"
        );
        assert!(!stale_restore.exists());
        assert!(!stale_backup.exists());
        assert!(fresh_restore.exists(), "正在上传的临时文件不能被删");
        assert!(unrelated.exists(), "无关文件不能被删");
    }

    #[tokio::test]
    async fn no_pending_file_is_a_noop() {
        let dir = TestDir::new("none");
        let outcome = apply_pending_restore(&dir.db_path()).await.unwrap();
        assert_eq!(outcome, RestoreOutcome::NoPending);
    }

    /// 刚初始化（只跑完迁移）的库不是 0 字节，也不该是几十 MB。
    #[tokio::test]
    async fn database_bytes_is_sane_for_freshly_migrated_database() {
        let dir = TestDir::new("fresh-bytes");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();

        let bytes = repo::backup::database_bytes(&db.pool).await.unwrap();
        db.pool.close().await;

        assert!(bytes > 0, "刚初始化的库不应报 0");
        assert!(bytes >= 4096, "至少一个 SQLite 页：{bytes}");
        assert!(
            bytes < 64 * 1024 * 1024,
            "刚初始化的库不应有几十 MB：{bytes}"
        );
    }

    /// WAL 里已提交但未 checkpoint 的数据必须算进 `db_bytes`。
    ///
    /// 主库文件可能停在 4 KB，真实数据在 `-wal` 里；`page_count * page_size`
    /// 要跟着数据走，并与 `VACUUM INTO` 快照（= 真正备份出去的内容）同量级。
    #[tokio::test]
    async fn database_bytes_includes_pages_committed_in_wal() {
        let dir = TestDir::new("wal-bytes");
        let db_path = dir.db_path();
        let db = open_db(&db_path).await;
        db.migrate().await.unwrap();

        // 每行 32 KB，合计约 1 MB：低于 SQLite 默认 1000 页（4 MB）的
        // 自动 checkpoint 阈值，所以这些页停留在 WAL 里，主库文件不长大。
        sqlx::query("CREATE TABLE wal_probe (payload BLOB)")
            .execute(&db.pool)
            .await
            .unwrap();
        let payload = vec![7u8; 32 * 1024];
        for _ in 0..32 {
            sqlx::query("INSERT INTO wal_probe (payload) VALUES (?)")
                .bind(&payload)
                .execute(&db.pool)
                .await
                .unwrap();
        }

        let main_bytes = fs::metadata(&db_path).unwrap().len();
        let wal_bytes = fs::metadata(dir.file("pierwave.db-wal"))
            .map(|meta| meta.len())
            .unwrap_or(0);
        let logical = repo::backup::database_bytes(&db.pool).await.unwrap();

        let snapshot = dir.file("wal-snapshot.db");
        create_snapshot(&db.pool, &snapshot).await.unwrap();
        let snapshot_bytes = fs::metadata(&snapshot).unwrap().len();
        db.pool.close().await;

        assert!(wal_bytes > 0, "写入应停留在 WAL 里");
        assert!(
            logical > main_bytes,
            "db_bytes 必须大于主库文件：db_bytes={logical}, main={main_bytes}"
        );
        // 数据量下限：至少和备份出去的单文件快照一样大。
        assert!(
            logical >= snapshot_bytes,
            "db_bytes 不应小于快照：db_bytes={logical}, snapshot={snapshot_bytes}"
        );
        // 量级一致：不能把 WAL 的历史版本全算进来（那会是 2 倍以上）。
        assert!(
            logical <= snapshot_bytes * 2,
            "db_bytes 与快照量级相差过大：db_bytes={logical}, snapshot={snapshot_bytes}"
        );
    }
}
