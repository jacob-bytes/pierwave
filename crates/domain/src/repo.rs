//! 仓储：所有 SQL 都在这一层，函数签名只吃 `&SqlitePool`。

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::models::*;

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub mod users {
    use super::*;

    pub struct NewUser {
        pub username: String,
        pub password: String,
        pub role: String,
    }

    pub async fn create(pool: &SqlitePool, input: NewUser) -> anyhow::Result<User> {
        let id = Uuid::new_v4().to_string();
        let hash = crate::password::hash(&input.password)?;
        let short_code = Uuid::new_v4().simple().to_string()[..10].to_string();
        let ts = now();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, role, status, short_code, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
        )
        .bind(&id)
        .bind(&input.username)
        .bind(&hash)
        .bind(&input.role)
        .bind(&short_code)
        .bind(ts)
        .bind(ts)
        .execute(pool)
        .await?;
        find_by_id(pool, &id).await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<User> {
        Ok(
            sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?")
                .bind(id)
                .fetch_one(pool)
                .await?,
        )
    }

    pub async fn find_by_username(
        pool: &SqlitePool,
        username: &str,
    ) -> anyhow::Result<Option<User>> {
        Ok(
            sqlx::query_as::<_, User>("SELECT * FROM users WHERE username = ?")
                .bind(username)
                .fetch_optional(pool)
                .await?,
        )
    }

    pub async fn list(pool: &SqlitePool) -> anyhow::Result<Vec<User>> {
        Ok(
            sqlx::query_as::<_, User>("SELECT * FROM users ORDER BY created_at DESC")
                .fetch_all(pool)
                .await?,
        )
    }

    pub async fn count(pool: &SqlitePool) -> anyhow::Result<i64> {
        Ok(sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(pool)
            .await?)
    }
}

pub mod sessions {
    use super::*;

    /// 返回 (明文 token, 过期时间)。明文只出现在 Set-Cookie 里。
    pub async fn create(
        pool: &SqlitePool,
        user_id: &str,
        ttl_secs: i64,
        user_agent: Option<&str>,
    ) -> anyhow::Result<(String, i64)> {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let token_hash = crate::password::sha256_hex(&token);
        let ts = now();
        let expires_at = ts + ttl_secs;
        sqlx::query(
            "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, user_agent)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(user_id)
        .bind(&token_hash)
        .bind(expires_at)
        .bind(ts)
        .bind(user_agent)
        .execute(pool)
        .await?;
        Ok((token, expires_at))
    }

    pub async fn user_for_token(pool: &SqlitePool, token: &str) -> anyhow::Result<Option<User>> {
        let hash = crate::password::sha256_hex(token);
        let user = sqlx::query_as::<_, User>(
            "SELECT u.* FROM users u
             JOIN sessions s ON s.user_id = u.id
             WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'",
        )
        .bind(hash)
        .bind(now())
        .fetch_optional(pool)
        .await?;
        Ok(user)
    }

    pub async fn delete_by_token(pool: &SqlitePool, token: &str) -> anyhow::Result<()> {
        let hash = crate::password::sha256_hex(token);
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(hash)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn purge_expired(pool: &SqlitePool) -> anyhow::Result<u64> {
        let res = sqlx::query("DELETE FROM sessions WHERE expires_at < ?")
            .bind(now())
            .execute(pool)
            .await?;
        Ok(res.rows_affected())
    }
}

pub mod servers {
    use super::*;

    /// 返回 (服务器, 明文配对 token)。token 只在创建时可见一次。
    pub async fn create(
        pool: &SqlitePool,
        name: &str,
        address: &str,
        xray_mode: &str,
    ) -> anyhow::Result<(Server, String)> {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let token_hash = crate::password::sha256_hex(&token);
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO servers (id, name, address, token_hash, xray_mode, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(address)
        .bind(&token_hash)
        .bind(xray_mode)
        .bind(now())
        .execute(pool)
        .await?;
        let server = find_by_id(pool, &id).await?;
        Ok((server, token))
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Server> {
        Ok(
            sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE id = ?")
                .bind(id)
                .fetch_one(pool)
                .await?,
        )
    }

    pub async fn find_by_token(pool: &SqlitePool, token: &str) -> anyhow::Result<Option<Server>> {
        let hash = crate::password::sha256_hex(token);
        Ok(
            sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE token_hash = ?")
                .bind(hash)
                .fetch_optional(pool)
                .await?,
        )
    }

    pub async fn list(pool: &SqlitePool) -> anyhow::Result<Vec<Server>> {
        Ok(
            sqlx::query_as::<_, Server>("SELECT * FROM servers ORDER BY created_at DESC")
                .fetch_all(pool)
                .await?,
        )
    }

    pub async fn mark_online(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE servers SET status = 'online', last_seen_at = ? WHERE id = ?")
            .bind(now())
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn heartbeat(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE servers SET last_seen_at = ?, status = 'online' WHERE id = ?")
            .bind(now())
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn mark_offline(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE servers SET status = 'offline' WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }
}
