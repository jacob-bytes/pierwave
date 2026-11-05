//! 仓储：所有 SQL 都在这一层，函数签名只吃 `&SqlitePool`。

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::models::*;

pub fn now() -> i64 {
    crate::time::now()
}

/// 键值配置：订阅凭据派生的 master secret 等。
pub mod settings {
    use super::*;

    pub async fn get(pool: &SqlitePool, key: &str) -> anyhow::Result<Option<String>> {
        Ok(
            sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
                .bind(key)
                .fetch_optional(pool)
                .await?,
        )
    }

    /// 不存在则写入，返回最终生效值。
    ///
    /// 首启时两个请求可能同时生成 secret，用 `ON CONFLICT DO NOTHING` 让先写入者胜出，
    /// 再统一读回，保证所有进程/连接看到的都是同一份。
    pub async fn get_or_init(pool: &SqlitePool, key: &str, value: &str) -> anyhow::Result<String> {
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO NOTHING",
        )
        .bind(key)
        .bind(value)
        .execute(pool)
        .await?;
        get(pool, key)
            .await?
            .ok_or_else(|| anyhow::anyhow!("settings 写入后读取失败：{key}"))
    }
}

pub mod users {
    use super::*;

    pub struct NewUser {
        pub username: String,
        pub password: String,
        pub role: String,
        pub quota_bytes: Option<i64>,
    }

    #[derive(Debug, Default)]
    pub struct UpdateUser {
        pub role: Option<String>,
        pub status: Option<String>,
        /// 缺失 = 不改；`Patch::Null` = 不限；`Patch::Value` = 具体额度。
        pub quota_bytes: Patch<i64>,
    }

    pub async fn create(pool: &SqlitePool, input: NewUser) -> anyhow::Result<User> {
        let id = Uuid::new_v4().to_string();
        let hash = crate::password::hash(&input.password)?;
        let short_code = Uuid::new_v4().simple().to_string()[..10].to_string();
        let ts = now();
        sqlx::query(
            "INSERT INTO users
                (id, username, password_hash, role, status, short_code, quota_bytes, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&input.username)
        .bind(&hash)
        .bind(&input.role)
        .bind(&short_code)
        .bind(input.quota_bytes)
        .bind(ts)
        .bind(ts)
        .execute(pool)
        .await?;
        find_by_id(pool, &id).await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<User> {
        find_by_id_opt(pool, id)
            .await?
            .ok_or_else(|| sqlx::Error::RowNotFound.into())
    }

    pub async fn find_by_id_opt(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<User>> {
        Ok(
            sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
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

    /// 订阅入口：短码不是密钥，但泄漏等于送人流量，所以查询只按短码精确匹配。
    pub async fn find_by_short_code(
        pool: &SqlitePool,
        short_code: &str,
    ) -> anyhow::Result<Option<User>> {
        Ok(
            sqlx::query_as::<_, User>("SELECT * FROM users WHERE short_code = ?")
                .bind(short_code)
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

    /// 管理端列表：按用户名/订阅短码模糊搜索，全部走参数绑定。
    pub async fn list_with_query(
        pool: &SqlitePool,
        q: Option<&str>,
        limit: i64,
    ) -> anyhow::Result<Vec<User>> {
        let pattern = q
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(|q| format!("%{q}%"));
        Ok(sqlx::query_as::<_, User>(
            "SELECT * FROM users
             WHERE (? IS NULL OR username LIKE ? OR short_code LIKE ?)
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?",
        )
        .bind(pattern.as_deref())
        .bind(pattern.as_deref())
        .bind(pattern.as_deref())
        .bind(limit.clamp(1, 500))
        .fetch_all(pool)
        .await?)
    }

    /// 只更新传入的字段；返回更新后的用户，不存在返回 `None`。
    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        input: UpdateUser,
    ) -> anyhow::Result<Option<User>> {
        let quota_set = input.quota_bytes.is_set();
        let quota = input.quota_bytes.value();
        let res = sqlx::query(
            "UPDATE users SET
                role = COALESCE(?, role),
                status = COALESCE(?, status),
                quota_bytes = CASE WHEN ? THEN ? ELSE quota_bytes END,
                updated_at = ?
             WHERE id = ?",
        )
        .bind(input.role)
        .bind(input.status)
        .bind(quota_set)
        .bind(quota)
        .bind(now())
        .bind(id)
        .execute(pool)
        .await?;

        if res.rows_affected() == 0 {
            return Ok(None);
        }
        find_by_id_opt(pool, id).await
    }

    /// 返回是否真的改到了行。
    pub async fn set_password(pool: &SqlitePool, id: &str, password: &str) -> anyhow::Result<bool> {
        let hash = crate::password::hash(password)?;
        let res = sqlx::query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
            .bind(hash)
            .bind(now())
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// 返回是否真的删掉了一行；名下的会话与套餐实例由外键级联删除。
    pub async fn delete(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
        let res = sqlx::query("DELETE FROM users WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn count(pool: &SqlitePool) -> anyhow::Result<i64> {
        Ok(sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(pool)
            .await?)
    }

    /// 单个用户的完整视图（含套餐实例）。
    pub async fn view_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<UserView>> {
        let Some(user) = find_by_id_opt(pool, id).await? else {
            return Ok(None);
        };
        let packages = super::user_packages::list_views_by_user(pool, id).await?;
        Ok(Some(UserView::from((user, packages))))
    }

    /// 列表视图：先查用户页，再用一次 IN 查询把套餐实例装配进来（无 N+1）。
    pub async fn list_views(
        pool: &SqlitePool,
        q: Option<&str>,
        limit: i64,
    ) -> anyhow::Result<Vec<UserView>> {
        let users = list_with_query(pool, q, limit).await?;
        let ids: Vec<String> = users.iter().map(|user| user.id.clone()).collect();
        let mut grouped = super::user_packages::group_views_by_users(pool, &ids).await?;
        Ok(users
            .into_iter()
            .map(|user| {
                let packages = grouped.remove(&user.id).unwrap_or_default();
                UserView::from((user, packages))
            })
            .collect())
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

    /// 配置版本原子 +1，返回新版本。apply 时调用。
    pub async fn bump_config_version(pool: &SqlitePool, id: &str) -> anyhow::Result<i64> {
        let version = sqlx::query_scalar::<_, i64>(
            "UPDATE servers SET config_version = config_version + 1
             WHERE id = ?
             RETURNING config_version",
        )
        .bind(id)
        .fetch_one(pool)
        .await?;
        Ok(version)
    }
}

pub mod nodes {
    use super::*;

    pub struct NewNode {
        /// 留空时自动生成 `<protocol>-<随机后缀>`。
        pub tag: Option<String>,
        pub name: String,
        pub protocol: String,
        pub transport: String,
        pub security: String,
        pub port: i64,
        pub config_json: String,
        pub enabled: bool,
    }

    #[derive(Default)]
    pub struct UpdateNode {
        pub tag: Option<String>,
        pub name: Option<String>,
        pub protocol: Option<String>,
        pub transport: Option<String>,
        pub security: Option<String>,
        pub port: Option<i64>,
        pub config_json: Option<String>,
        pub enabled: Option<bool>,
    }

    pub async fn create(
        pool: &SqlitePool,
        server_id: &str,
        input: NewNode,
    ) -> anyhow::Result<Node> {
        let id = Uuid::new_v4().to_string();
        let tag = match input.tag.as_deref().map(str::trim) {
            Some(tag) if !tag.is_empty() => tag.to_string(),
            _ => {
                let suffix = &Uuid::new_v4().simple().to_string()[..8];
                format!("{}-{suffix}", input.protocol.trim().to_ascii_lowercase())
            }
        };
        sqlx::query(
            "INSERT INTO nodes
                (id, server_id, tag, name, protocol, transport, security, port, config_json, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(server_id)
        .bind(&tag)
        .bind(&input.name)
        .bind(input.protocol.trim().to_ascii_lowercase())
        .bind(input.transport.trim().to_ascii_lowercase())
        .bind(input.security.trim().to_ascii_lowercase())
        .bind(input.port)
        .bind(&input.config_json)
        .bind(i64::from(input.enabled))
        .bind(now())
        .execute(pool)
        .await?;
        find_by_id(pool, &id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("节点创建后读取失败"))
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<Node>> {
        Ok(
            sqlx::query_as::<_, Node>("SELECT * FROM nodes WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await?,
        )
    }

    pub async fn list_by_server(pool: &SqlitePool, server_id: &str) -> anyhow::Result<Vec<Node>> {
        Ok(sqlx::query_as::<_, Node>(
            "SELECT * FROM nodes WHERE server_id = ? ORDER BY created_at ASC, rowid ASC",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?)
    }

    pub async fn list_enabled_by_server(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Vec<Node>> {
        Ok(sqlx::query_as::<_, Node>(
            "SELECT * FROM nodes WHERE server_id = ? AND enabled = 1
             ORDER BY created_at ASC, rowid ASC",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?)
    }

    /// 订阅用：所有服务器下启用的节点，并带出服务器地址。
    ///
    /// JOIN 天然满足「所属服务器必须存在」；否则节点在库里就是孤儿，不该出现在订阅里。
    pub async fn list_enabled_with_server(
        pool: &SqlitePool,
    ) -> anyhow::Result<Vec<NodeWithServer>> {
        Ok(sqlx::query_as::<_, NodeWithServer>(
            "SELECT n.*, s.address AS server_address
             FROM nodes n
             JOIN servers s ON s.id = n.server_id
             WHERE n.enabled = 1
             ORDER BY n.created_at ASC, n.rowid ASC",
        )
        .fetch_all(pool)
        .await?)
    }

    /// 只更新传入的字段；返回更新后的节点，不存在返回 `None`。
    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        input: UpdateNode,
    ) -> anyhow::Result<Option<Node>> {
        let res = sqlx::query(
            "UPDATE nodes SET
                tag = COALESCE(?, tag),
                name = COALESCE(?, name),
                protocol = COALESCE(?, protocol),
                transport = COALESCE(?, transport),
                security = COALESCE(?, security),
                port = COALESCE(?, port),
                config_json = COALESCE(?, config_json),
                enabled = COALESCE(?, enabled)
             WHERE id = ?",
        )
        .bind(input.tag)
        .bind(input.name)
        .bind(input.protocol)
        .bind(input.transport)
        .bind(input.security)
        .bind(input.port)
        .bind(input.config_json)
        .bind(input.enabled.map(i64::from))
        .bind(id)
        .execute(pool)
        .await?;

        if res.rows_affected() == 0 {
            return Ok(None);
        }
        find_by_id(pool, id).await
    }

    /// 返回是否真的删掉了一行。
    pub async fn delete(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
        let res = sqlx::query("DELETE FROM nodes WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }
}

pub mod packages {
    use super::*;

    pub struct NewPackage {
        pub name: String,
        pub quota_bytes: Option<i64>,
        pub period_days: Option<i64>,
        pub direction: String,
        pub node_ratio: f64,
    }

    #[derive(Debug, Default)]
    pub struct UpdatePackage {
        pub name: Option<String>,
        /// 缺失 = 不改；`Patch::Null` = 不限；`Patch::Value` = 具体额度。
        pub quota_bytes: Patch<i64>,
        /// 缺失 = 不改；`Patch::Null` = 不过期周期；`Patch::Value` = 天数。
        pub period_days: Patch<i64>,
        pub direction: Option<String>,
        pub node_ratio: Option<f64>,
    }

    pub async fn create(pool: &SqlitePool, input: NewPackage) -> anyhow::Result<Package> {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO packages
                (id, name, quota_bytes, period_days, direction, node_ratio, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&input.name)
        .bind(input.quota_bytes)
        .bind(input.period_days)
        .bind(&input.direction)
        .bind(input.node_ratio)
        .bind(now())
        .execute(pool)
        .await?;
        find_by_id(pool, &id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("套餐创建后读取失败"))
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<Package>> {
        Ok(sqlx::query_as::<_, Package>(
            "SELECT p.*,
                    (SELECT COUNT(*) FROM user_packages up WHERE up.package_id = p.id) AS user_count
             FROM packages p
             WHERE p.id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?)
    }

    /// 列表用一次 LEFT JOIN 聚合出引用数，避免前端/后端各来一轮 N+1。
    pub async fn list(pool: &SqlitePool) -> anyhow::Result<Vec<Package>> {
        Ok(sqlx::query_as::<_, Package>(
            "SELECT p.id, p.name, p.quota_bytes, p.period_days, p.direction, p.node_ratio,
                    p.created_at, COUNT(up.id) AS user_count
             FROM packages p
             LEFT JOIN user_packages up ON up.package_id = p.id
             GROUP BY p.id
             ORDER BY p.created_at DESC, p.rowid DESC",
        )
        .fetch_all(pool)
        .await?)
    }

    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        input: UpdatePackage,
    ) -> anyhow::Result<Option<Package>> {
        let quota_set = input.quota_bytes.is_set();
        let quota = input.quota_bytes.value();
        let period_set = input.period_days.is_set();
        let period = input.period_days.value();
        let res = sqlx::query(
            "UPDATE packages SET
                name = COALESCE(?, name),
                quota_bytes = CASE WHEN ? THEN ? ELSE quota_bytes END,
                period_days = CASE WHEN ? THEN ? ELSE period_days END,
                direction = COALESCE(?, direction),
                node_ratio = COALESCE(?, node_ratio)
             WHERE id = ?",
        )
        .bind(input.name)
        .bind(quota_set)
        .bind(quota)
        .bind(period_set)
        .bind(period)
        .bind(input.direction)
        .bind(input.node_ratio)
        .bind(id)
        .execute(pool)
        .await?;

        if res.rows_affected() == 0 {
            return Ok(None);
        }
        find_by_id(pool, id).await
    }

    /// 仍被多少张套餐实例引用；删除前用它给出业务错误而不是外键报错。
    pub async fn count_references(pool: &SqlitePool, id: &str) -> anyhow::Result<i64> {
        Ok(
            sqlx::query_scalar("SELECT COUNT(*) FROM user_packages WHERE package_id = ?")
                .bind(id)
                .fetch_one(pool)
                .await?,
        )
    }

    /// 返回是否真的删掉了一行。
    pub async fn delete(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
        let res = sqlx::query("DELETE FROM packages WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }
}

pub mod user_packages {
    use std::collections::HashMap;

    use sqlx::QueryBuilder;

    use super::*;

    pub struct NewUserPackage {
        pub package_id: String,
        pub quota_override: Option<i64>,
        pub expires_at: Option<i64>,
        pub reset_day: Option<i64>,
    }

    #[derive(Debug, Default)]
    pub struct UpdateUserPackage {
        pub expires_at: Patch<i64>,
        pub quota_override: Patch<i64>,
        pub reset_day: Patch<i64>,
        pub status: Option<String>,
    }

    /// 实例创建时把套餐模板的计费方向/倍率冻结进来，之后改模板不影响已售出的卡。
    pub async fn create(
        pool: &SqlitePool,
        user_id: &str,
        input: NewUserPackage,
        package: &Package,
    ) -> anyhow::Result<UserPackageView> {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO user_packages
                (id, user_id, package_id, quota_override, used_bytes, direction, node_ratio,
                 expires_at, reset_day, status, created_at)
             VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'active', ?)",
        )
        .bind(&id)
        .bind(user_id)
        .bind(&input.package_id)
        .bind(input.quota_override)
        .bind(&package.direction)
        .bind(package.node_ratio)
        .bind(input.expires_at)
        .bind(input.reset_day)
        .bind(now())
        .execute(pool)
        .await?;
        find_view_by_id(pool, &id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("套餐实例创建后读取失败"))
    }

    /// 视图查询的公共列：原样带出 `quota_override`，同时给出生效额度与原始状态。
    const VIEW_COLUMNS: &str = "up.id, up.user_id, up.package_id, p.name AS package_name,
         up.quota_override,
         COALESCE(up.quota_override, p.quota_bytes) AS quota_bytes,
         up.used_bytes, up.expires_at, up.reset_day,
         up.status AS raw_status,
         up.direction, up.node_ratio";

    pub async fn find_view_by_id(
        pool: &SqlitePool,
        id: &str,
    ) -> anyhow::Result<Option<UserPackageView>> {
        let now = super::now();
        Ok(sqlx::query_as::<_, UserPackageView>(&format!(
            "SELECT {VIEW_COLUMNS}
             FROM user_packages up
             JOIN packages p ON p.id = up.package_id
             WHERE up.id = ?"
        ))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(|view| view.resolve_status(now)))
    }

    pub async fn list_views_by_user(
        pool: &SqlitePool,
        user_id: &str,
    ) -> anyhow::Result<Vec<UserPackageView>> {
        let now = super::now();
        let rows = sqlx::query_as::<_, UserPackageView>(&format!(
            "SELECT {VIEW_COLUMNS}
             FROM user_packages up
             JOIN packages p ON p.id = up.package_id
             WHERE up.user_id = ?
             ORDER BY up.created_at ASC, up.rowid ASC"
        ))
        .bind(user_id)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|view| view.resolve_status(now))
            .collect())
    }

    /// 一次查询取出一页用户的所有套餐实例，再按 user_id 分组（避免 N+1）。
    pub async fn group_views_by_users(
        pool: &SqlitePool,
        user_ids: &[String],
    ) -> anyhow::Result<HashMap<String, Vec<UserPackageView>>> {
        let mut grouped: HashMap<String, Vec<UserPackageView>> = HashMap::new();
        if user_ids.is_empty() {
            return Ok(grouped);
        }

        let mut builder = QueryBuilder::new(format!(
            "SELECT {VIEW_COLUMNS}
             FROM user_packages up
             JOIN packages p ON p.id = up.package_id
             WHERE up.user_id IN ("
        ));
        let mut separated = builder.separated(", ");
        for user_id in user_ids {
            separated.push_bind(user_id.clone());
        }
        separated.push_unseparated(") ORDER BY up.created_at ASC, up.rowid ASC");

        let now = super::now();
        let rows = builder
            .build_query_as::<UserPackageView>()
            .fetch_all(pool)
            .await?;
        for row in rows {
            let row = row.resolve_status(now);
            grouped.entry(row.user_id.clone()).or_default().push(row);
        }
        Ok(grouped)
    }

    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        input: UpdateUserPackage,
    ) -> anyhow::Result<Option<UserPackageView>> {
        let expires_set = input.expires_at.is_set();
        let expires = input.expires_at.value();
        let quota_set = input.quota_override.is_set();
        let quota = input.quota_override.value();
        let reset_set = input.reset_day.is_set();
        let reset = input.reset_day.value();
        let res = sqlx::query(
            "UPDATE user_packages SET
                expires_at = CASE WHEN ? THEN ? ELSE expires_at END,
                quota_override = CASE WHEN ? THEN ? ELSE quota_override END,
                reset_day = CASE WHEN ? THEN ? ELSE reset_day END,
                status = COALESCE(?, status)
             WHERE id = ?",
        )
        .bind(expires_set)
        .bind(expires)
        .bind(quota_set)
        .bind(quota)
        .bind(reset_set)
        .bind(reset)
        .bind(input.status)
        .bind(id)
        .execute(pool)
        .await?;

        if res.rows_affected() == 0 {
            return Ok(None);
        }
        find_view_by_id(pool, id).await
    }

    /// 流量采集落库后更新实例用量；`exhausted` 判定与订阅授权都依赖它。
    pub async fn set_used_bytes(
        pool: &SqlitePool,
        id: &str,
        used_bytes: i64,
    ) -> anyhow::Result<bool> {
        let res = sqlx::query("UPDATE user_packages SET used_bytes = ? WHERE id = ?")
            .bind(used_bytes.max(0))
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// 返回是否真的删掉了一行。
    pub async fn delete(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
        let res = sqlx::query("DELETE FROM user_packages WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }
}

/// 订阅授权：谁有资格用哪些节点（`docs/SUBSCRIBE.md` §7.1）。
///
/// 「有资格」的口径只有一处：用户 `status='active'`，且至少有一张
/// [`crate::models::package_is_usable_at`] 判定可用的套餐实例。
/// apply（服务端注入 client）和公开订阅端点共用它，避免两处各自写一套
/// 「未过期 / 没用尽」条件后慢慢漂移。
pub mod authorization {
    use std::collections::HashSet;

    use super::*;

    /// 一条「用户 × 节点」授权对。跨服务器/跨用户一次算好，避免 master 里写 SQL。
    #[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
    pub struct EligiblePair {
        pub user_id: String,
        pub node_id: String,
    }

    /// 候选行的扁平形态：同一个人可能有多张卡，只要有一张可用就保留。
    #[derive(Debug, Clone, sqlx::FromRow)]
    struct Candidate {
        user_id: String,
        node_id: String,
        package_status: String,
        expires_at: Option<i64>,
        quota_bytes: Option<i64>,
        used_bytes: i64,
    }

    /// 给定服务器：enabled 节点 × 有资格用户的笛卡尔集，顺序稳定。
    ///
    /// 返回的 pair 只是「谁可以用谁」；凭据仍由调用方用 master secret 派生，
    /// 保证这一层不接触任何密钥材料。
    pub async fn eligible_pairs(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Vec<EligiblePair>> {
        let rows = sqlx::query_as::<_, Candidate>(
            "SELECT u.id AS user_id, n.id AS node_id,
                    up.status AS package_status,
                    up.expires_at,
                    COALESCE(up.quota_override, p.quota_bytes) AS quota_bytes,
                    up.used_bytes
             FROM users u
             CROSS JOIN nodes n
             JOIN user_packages up ON up.user_id = u.id
             JOIN packages p ON p.id = up.package_id
             WHERE n.server_id = ? AND n.enabled = 1
               AND u.status = 'active'
             ORDER BY u.created_at ASC, u.rowid ASC,
                      n.created_at ASC, n.rowid ASC,
                      up.created_at ASC, up.rowid ASC",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?;

        let now = super::now();
        let mut seen = HashSet::new();
        let mut pairs = Vec::new();
        for row in rows {
            if !crate::models::package_is_usable_at(
                &row.package_status,
                row.expires_at,
                row.quota_bytes,
                row.used_bytes,
                now,
            ) {
                continue;
            }
            if seen.insert((row.user_id.clone(), row.node_id.clone())) {
                pairs.push(EligiblePair {
                    user_id: row.user_id,
                    node_id: row.node_id,
                });
            }
        }
        Ok(pairs)
    }

    /// 单个用户是否有任何可用套餐（订阅端点用它决定是否导出节点）。
    pub async fn is_eligible(pool: &SqlitePool, user_id: &str) -> anyhow::Result<bool> {
        let Some(user) = super::users::find_by_id_opt(pool, user_id).await? else {
            return Ok(false);
        };
        if user.status != "active" {
            return Ok(false);
        }
        let packages = super::user_packages::list_views_by_user(pool, user_id).await?;
        let now = super::now();
        Ok(packages.iter().any(|item| item.is_usable_at(now)))
    }
}
