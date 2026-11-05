//! 领域层：数据模型、仓储与不依赖 HTTP 的业务规则。
//! 这里不允许出现 axum / 请求上下文，方便被 master、CLI、测试共用。

pub mod models;
pub mod password;
pub mod repo;
pub mod xray;

use anyhow::Context;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;

pub struct Db {
    pub pool: SqlitePool,
}

impl Db {
    /// `sqlite://data/mmrust.db?mode=rwc`；目录不存在会自动创建。
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        if let Some(path) = url.strip_prefix("sqlite://") {
            let path = path.split('?').next().unwrap_or(path);
            if let Some(dir) = std::path::Path::new(path).parent() {
                if !dir.as_os_str().is_empty() {
                    std::fs::create_dir_all(dir).ok();
                }
            }
        }
        let opts = SqliteConnectOptions::from_str(url)?.create_if_missing(true);
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
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .ok();
        Ok(Self { pool })
    }

    pub async fn migrate(&self) -> anyhow::Result<()> {
        sqlx::migrate!("./migrations")
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
            },
        )
        .await?;
        Ok(generated)
    }
}
