//! 领域层：数据模型、仓储与不依赖 HTTP 的业务规则。
//! 这里不允许出现 axum / 请求上下文，方便被 master、CLI、测试共用。

pub mod backup;
pub mod certificate;
pub mod credentials;
pub mod enforcement;
pub mod error;
pub mod forwards;
pub mod metering;
pub mod models;
pub mod password;
pub mod reality;
pub mod release;
pub mod repo;
pub mod reset;
pub mod routing;
pub mod subscribe;
pub mod time;
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
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let path = Self::database_path(url);
        if let Some(path) = &path {
            if let Some(dir) = path.parent() {
                if !dir.as_os_str().is_empty() {
                    std::fs::create_dir_all(dir).ok();
                }
            }
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
            },
        )
        .await?;
        Ok(generated)
    }
}
