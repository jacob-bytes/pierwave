//! 领域层：数据模型、仓储与不依赖 HTTP 的业务规则。
//! 这里不允许出现 axum / 请求上下文，方便被 master、CLI、测试共用。

pub mod backup;
pub mod certificate;
pub mod chain_templates;
pub mod chains;
pub mod country;
pub mod credentials;
pub mod enforcement;
pub mod engine;
pub mod error;
pub mod forwards;
pub mod fs_security;
pub mod hop_transport;
pub mod metering;
pub mod models;
pub mod password;
pub mod port_policy;
pub mod protocol;
pub mod reality;
pub mod release;
pub mod remote_backup;
pub mod repo;
pub mod reset;
pub mod routing;
pub mod subscribe;
pub mod subscription_template;
pub mod telemetry;
pub mod time;
pub mod tunnel_security;
pub mod updates;
pub mod xray;

use anyhow::Context;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::str::FromStr;

/// 编译期打进二进制的迁移集合；恢复校验用它判断「当前程序支持到哪一版」。
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// 当前二进制支持的最高迁移版本。
pub fn latest_migration_version() -> i64 {
    MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap_or(0)
}

pub struct Db {
    pub pool: SqlitePool,
    /// 文件型数据库的路径；`sqlite::memory:` 为 `None`。
    path: Option<PathBuf>,
}

impl Db {
    /// 从 `PIERWAVE_DB` 风格的 URL 解析出磁盘路径。
    ///
    /// `sqlite::memory:` 与不支持的文件 URL 返回 `None`。备份/恢复只在
    /// 文件型数据库上有意义。
    pub fn database_path(url: &str) -> Option<PathBuf> {
        let rest = url.strip_prefix("sqlite://")?;
        let path = rest.split('?').next().unwrap_or(rest);
        if path.is_empty() || path == ":memory:" {
            return None;
        }
        Some(PathBuf::from(path))
    }

    /// 文件型数据库的路径；内存库返回 `None`。
    pub fn file_path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// `sqlite://data/pierwave.db?mode=rwc`；目录不存在会自动创建。
    ///
    /// 文件库落盘后立即收紧权限：数据库文件和父目录（也是备份目录）默认都是
    /// 0600 / 0700，`-wal` / `-shm` 随主库一起收紧。升级前遗留的 0644 库会在
    /// 这里自动修正并 `warn`，不需要用户手动 `chmod`。
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let path = Self::database_path(url);
        if let Some(path) = &path {
            if let Some(dir) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
                crate::fs_security::create_private_dir(dir)
                    .with_context(|| format!("创建数据库目录失败：{}", dir.display()))?;
            }
            // 先以 0600 建库文件：SQLite 不会放宽已有文件的权限，WAL/SHM 也会
            // 继承主库权限，而不是按默认 umask 落成 0644。
            crate::fs_security::prepare_private_file(path)
                .with_context(|| format!("准备数据库文件失败：{}", path.display()))?;
        }
        // 外键打开到连接选项里：池里每条连接都生效，删用户时套餐实例才会级联清理。
        let opts = SqliteConnectOptions::from_str(url)?
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await
            .context("打开 SQLite 失败")?;
        // WAL + 忙等：高频心跳写入时避免整库被写锁住
        sqlx::query("PRAGMA journal_mode = WAL")
            .execute(&pool)
            .await
            .ok();
        sqlx::query("PRAGMA busy_timeout = 5000")
            .execute(&pool)
            .await
            .ok();
        if let Some(path) = &path {
            tighten_database_files(path);
        }
        Ok(Self { pool, path })
    }

    pub async fn migrate(&self) -> anyhow::Result<()> {
        MIGRATOR
            .run(&self.pool)
            .await
            .context("执行数据库迁移失败")?;
        Ok(())
    }

    /// 首次启动建管理员；返回生成的明文密码（仅当随机生成时）。
    pub async fn ensure_admin(&self, password: Option<String>) -> anyhow::Result<Option<String>> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&self.pool)
            .await?;
        if count > 0 {
            return Ok(None);
        }
        let (plain, generated) = match password {
            Some(p) => (p, None),
            None => {
                let p = password::random_password();
                (p.clone(), Some(p))
            }
        };
        repo::users::create(
            &self.pool,
            repo::users::NewUser {
                username: "admin".into(),
                password: plain,
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
            },
        )
        .await?;
        Ok(generated)
    }
}

/// 主库与 SQLite 旁路文件（`-wal` / `-shm`）一起收紧到 0600。
///
/// 收紧失败只记 `warn`：文件可能属于 root 或位于不支持 chmod 的网络挂载上，
/// 但连接池已经可用，不能因此让整个服务起不来。
fn tighten_database_files(db_path: &Path) {
    if let Err(error) = crate::fs_security::ensure_private_file(db_path) {
        tracing::warn!(path = %db_path.display(), %error, "收紧数据库文件权限失败（继续运行）");
    }
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = db_path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        if let Err(error) = crate::fs_security::ensure_private_file(&sidecar) {
            tracing::warn!(path = %sidecar.display(), %error, "收紧数据库旁路文件权限失败（继续运行）");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "pierwave-domain-db-perm-{tag}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn db_path(&self) -> PathBuf {
            self.0.join("pierwave.db")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    async fn open_db(path: &Path) -> Db {
        Db::connect(&format!("sqlite://{}?mode=rwc", path.display()))
            .await
            .unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn database_file_and_parent_directory_are_owner_only() {
        let dir = TestDir::new("new");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();

        assert_eq!(mode_of(&dir.db_path()), 0o600, "数据库文件必须是 0600");
        assert_eq!(
            mode_of(&dir.0),
            0o700,
            "数据库目录（也是备份目录）必须是 0700"
        );
        db.pool.close().await;
    }

    /// 升级前已有的库通常是 0644：启动时必须自动收紧，而不是只对新建的库生效。
    #[cfg(unix)]
    #[tokio::test]
    async fn existing_world_readable_database_is_tightened_on_connect() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TestDir::new("existing");
        let path = dir.db_path();
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let db = open_db(&path).await;
        assert_eq!(mode_of(&path), 0o600, "已存在的 0644 库必须被收紧");
        db.pool.close().await;
    }

    /// WAL/SHM 与主库同级；主库 0600 时它们也必须是 0600。
    #[cfg(unix)]
    #[tokio::test]
    async fn wal_and_shm_sidecar_files_are_owner_only() {
        let dir = TestDir::new("wal");
        let path = dir.db_path();
        let db = open_db(&path).await;
        db.migrate().await.unwrap();
        // 写入落在 WAL 里，确保 -wal/-shm 真的存在再断言。
        sqlx::query("CREATE TABLE perm_probe (payload BLOB)")
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO perm_probe (payload) VALUES (?)")
            .bind(vec![1u8; 32 * 1024])
            .execute(&db.pool)
            .await
            .unwrap();

        for suffix in ["", "-wal", "-shm"] {
            let file = PathBuf::from(format!("{}{suffix}", path.display()));
            assert!(file.exists(), "旁路文件应存在：{}", file.display());
            assert_eq!(mode_of(&file), 0o600, "{} 必须是 0600", file.display());
        }
        db.pool.close().await;
    }
}
