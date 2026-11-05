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
        Ok(
            sqlx::query_as::<_, Package>("SELECT * FROM packages WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await?,
        )
    }

    pub async fn list(pool: &SqlitePool) -> anyhow::Result<Vec<Package>> {
        Ok(sqlx::query_as::<_, Package>(
            "SELECT * FROM packages ORDER BY created_at DESC, rowid DESC",
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

    pub async fn find_view_by_id(
        pool: &SqlitePool,
        id: &str,
    ) -> anyhow::Result<Option<UserPackageView>> {
        Ok(sqlx::query_as::<_, UserPackageView>(
            "SELECT up.id, up.user_id, up.package_id, p.name AS package_name,
                    COALESCE(up.quota_override, p.quota_bytes) AS quota_bytes,
                    up.used_bytes, up.expires_at, up.reset_day, up.status,
                    up.direction, up.node_ratio
             FROM user_packages up
             JOIN packages p ON p.id = up.package_id
             WHERE up.id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?)
    }

    pub async fn list_views_by_user(
        pool: &SqlitePool,
        user_id: &str,
    ) -> anyhow::Result<Vec<UserPackageView>> {
        Ok(sqlx::query_as::<_, UserPackageView>(
            "SELECT up.id, up.user_id, up.package_id, p.name AS package_name,
                    COALESCE(up.quota_override, p.quota_bytes) AS quota_bytes,
                    up.used_bytes, up.expires_at, up.reset_day, up.status,
                    up.direction, up.node_ratio
             FROM user_packages up
             JOIN packages p ON p.id = up.package_id
             WHERE up.user_id = ?
             ORDER BY up.created_at ASC, up.rowid ASC",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?)
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

        let mut builder = QueryBuilder::new(
            "SELECT up.id, up.user_id, up.package_id, p.name AS package_name,
                    COALESCE(up.quota_override, p.quota_bytes) AS quota_bytes,
                    up.used_bytes, up.expires_at, up.reset_day, up.status,
                    up.direction, up.node_ratio
             FROM user_packages up
             JOIN packages p ON p.id = up.package_id
             WHERE up.user_id IN (",
        );
        let mut separated = builder.separated(", ");
        for user_id in user_ids {
            separated.push_bind(user_id.clone());
        }
        separated.push_unseparated(") ORDER BY up.created_at ASC, up.rowid ASC");

        let rows = builder
            .build_query_as::<UserPackageView>()
            .fetch_all(pool)
            .await?;
        for row in rows {
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

    /// 返回是否真的删掉了一行。
    pub async fn delete(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
        let res = sqlx::query("DELETE FROM user_packages WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }
}
