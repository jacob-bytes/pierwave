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
    Ok(())
}

/// 校验一个**未压缩**的 SQLite 备份文件，返回文件字节数。
///
/// 失败信息是面向用户的中文，直接展示在 400 响应里。校验顺序：
/// 大小 -> 文件头魔数 -> 必需表 -> 迁移版本不高于当前二进制。
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

async fn inspect(pool: &SqlitePool) -> anyhow::Result<()> {
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

    #[tokio::test]
    async fn no_pending_file_is_a_noop() {
        let dir = TestDir::new("none");
        let outcome = apply_pending_restore(&dir.db_path()).await.unwrap();
        assert_eq!(outcome, RestoreOutcome::NoPending);
    }
}
