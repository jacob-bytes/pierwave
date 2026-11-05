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

    /// 流量落库后累加用户总用量。用 SQL 自增而不是先读后写，避免并发上报互相覆盖。
    pub async fn add_used_bytes(pool: &SqlitePool, id: &str, delta: i64) -> anyhow::Result<()> {
        sqlx::query("UPDATE users SET used_bytes = used_bytes + ?, updated_at = ? WHERE id = ?")
            .bind(delta.max(0))
            .bind(now())
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
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

    /// Agent 心跳里与本项目相关的健康指标。
    #[derive(Debug, Clone, Default)]
    pub struct HealthSnapshot {
        pub xray_running: bool,
        pub nginx_running: bool,
        pub load1: f64,
        pub mem_used: i64,
        pub mem_total: i64,
        pub disk_used: i64,
        pub disk_total: i64,
        pub uptime_secs: i64,
    }

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

    /// 改名 / 改地址 / 改 xray 模式；其他字段一律不动。
    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        name: Option<&str>,
        address: Option<&str>,
        xray_mode: Option<&str>,
    ) -> anyhow::Result<Option<Server>> {
        sqlx::query(
            "UPDATE servers SET
                name = COALESCE(?, name),
                address = COALESCE(?, address),
                xray_mode = COALESCE(?, xray_mode)
             WHERE id = ?",
        )
        .bind(name)
        .bind(address)
        .bind(xray_mode)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(
            sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await?,
        )
    }

    /// 删除服务器；nodes 由外键级联清理。
    pub async fn delete(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
        let affected = sqlx::query("DELETE FROM servers WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?
            .rows_affected();
        Ok(affected > 0)
    }

    pub async fn list(pool: &SqlitePool) -> anyhow::Result<Vec<Server>> {
        Ok(
            sqlx::query_as::<_, Server>("SELECT * FROM servers ORDER BY created_at DESC")
                .fetch_all(pool)
                .await?,
        )
    }

    /// 有启用节点的服务器：只有这些服务器的下发配置里可能出现用户 client。
    ///
    /// 断流标记用它决定「这次不可用要通知哪些服务器」，顺序稳定（创建时间）。
    pub async fn list_ids_with_enabled_nodes(pool: &SqlitePool) -> anyhow::Result<Vec<String>> {
        Ok(sqlx::query_scalar(
            "SELECT DISTINCT s.id
             FROM servers s
             JOIN nodes n ON n.server_id = s.id
             WHERE n.enabled = 1
             ORDER BY s.created_at ASC, s.rowid ASC",
        )
        .fetch_all(pool)
        .await?)
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

    /// 落库一次心跳：健康指标 + agent 版本。`last_seen_at` 由这里一并推进，
    /// 避免心跳和状态写入分成两次事务。
    pub async fn update_health(
        pool: &SqlitePool,
        id: &str,
        agent_version: &str,
        health: &HealthSnapshot,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE servers SET
                status = 'online',
                last_seen_at = ?,
                health_at = ?,
                agent_version = ?,
                xray_running = ?,
                nginx_running = ?,
                load1 = ?,
                mem_used = ?,
                mem_total = ?,
                disk_used = ?,
                disk_total = ?,
                uptime_secs = ?
             WHERE id = ?",
        )
        .bind(now())
        .bind(now())
        .bind(agent_version)
        .bind(health.xray_running)
        .bind(health.nginx_running)
        .bind(health.load1)
        .bind(health.mem_used)
        .bind(health.mem_total)
        .bind(health.disk_used)
        .bind(health.disk_total)
        .bind(health.uptime_secs)
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

/// 最近一次成功下发的期望态快照：断流对账靠它判断「配置有没有真的变化」。
pub mod desired {
    use super::*;

    #[derive(Debug, Clone, sqlx::FromRow)]
    pub struct Snapshot {
        pub server_id: String,
        /// 渲染结果（`xray` JSON）的稳定指纹，见 master 的 `routes::desired::fingerprint`。
        pub fingerprint: String,
        pub config_version: i64,
        pub updated_at: i64,
        /// 最近一次下发配置里的用户集合（JSON 数组）。
        ///
        /// `None` = 0005 之前写入的旧快照，无法判断已下发内容；恢复对账必须跳过，
        /// 否则会把「本来就已下发」的用户误判成需要恢复。
        pub granted_users: Option<String>,
    }

    impl Snapshot {
        /// 解析已下发的用户集合；旧快照/脏数据返回 `None`。
        pub fn granted_user_ids(&self) -> Option<Vec<String>> {
            let raw = self.granted_users.as_deref()?;
            serde_json::from_str::<Vec<String>>(raw).ok()
        }
    }

    pub async fn get(pool: &SqlitePool, server_id: &str) -> anyhow::Result<Option<Snapshot>> {
        Ok(sqlx::query_as::<_, Snapshot>(
            "SELECT server_id, fingerprint, config_version, updated_at, granted_users
             FROM desired_snapshots WHERE server_id = ?",
        )
        .bind(server_id)
        .fetch_optional(pool)
        .await?)
    }

    /// 每次 push 成功后覆盖快照；`server_id` 是主键，天然幂等。
    pub async fn save(
        pool: &SqlitePool,
        server_id: &str,
        fingerprint: &str,
        config_version: i64,
        granted_users: &[String],
        updated_at: i64,
    ) -> anyhow::Result<()> {
        let granted_users = serde_json::to_string(granted_users).unwrap_or_else(|_| "[]".into());
        sqlx::query(
            "INSERT INTO desired_snapshots
                (server_id, fingerprint, config_version, granted_users, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(server_id) DO UPDATE SET
                fingerprint = excluded.fingerprint,
                config_version = excluded.config_version,
                granted_users = excluded.granted_users,
                updated_at = excluded.updated_at",
        )
        .bind(server_id)
        .bind(fingerprint)
        .bind(config_version)
        .bind(granted_users)
        .bind(updated_at)
        .execute(pool)
        .await?;
        Ok(())
    }
}

pub mod traffic {
    use super::*;

    /// 日账本的一行，供落库后自检与测试断言使用。
    #[derive(Debug, Clone, sqlx::FromRow)]
    pub struct DailyRow {
        pub day: String,
        pub server_id: String,
        pub subject: String,
        pub uplink: i64,
        pub downlink: i64,
        pub weighted: i64,
    }

    /// 幂等占位：首次见到 `(server_id, boot_id, seq)` 返回 `true`。
    ///
    /// 重复上报直接返回 `false`，调用方必须原样丢弃，不能再次累加账本。
    pub async fn claim_report(
        pool: &SqlitePool,
        server_id: &str,
        boot_id: &str,
        seq: u64,
        received_at: i64,
    ) -> anyhow::Result<bool> {
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO traffic_reports (server_id, boot_id, seq, received_at)
             VALUES (?, ?, ?, ?)",
        )
        .bind(server_id)
        .bind(boot_id)
        .bind(seq as i64)
        .bind(received_at)
        .execute(pool)
        .await?
        .rows_affected();
        Ok(inserted > 0)
    }

    /// 按 (day, server_id, subject) 累加原始值与加权值。
    pub async fn accumulate_daily(
        pool: &SqlitePool,
        day: &str,
        server_id: &str,
        subject: &str,
        uplink: u64,
        downlink: u64,
        weighted: u64,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO traffic_daily (day, server_id, subject, uplink, downlink, weighted)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(day, server_id, subject) DO UPDATE SET
                uplink = uplink + excluded.uplink,
                downlink = downlink + excluded.downlink,
                weighted = weighted + excluded.weighted",
        )
        .bind(day)
        .bind(server_id)
        .bind(subject)
        .bind(saturating_i64(uplink))
        .bind(saturating_i64(downlink))
        .bind(saturating_i64(weighted))
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn find_daily(
        pool: &SqlitePool,
        day: &str,
        server_id: &str,
        subject: &str,
    ) -> anyhow::Result<Option<DailyRow>> {
        Ok(sqlx::query_as::<_, DailyRow>(
            "SELECT day, server_id, subject, uplink, downlink, weighted
             FROM traffic_daily WHERE day = ? AND server_id = ? AND subject = ?",
        )
        .bind(day)
        .bind(server_id)
        .bind(subject)
        .fetch_optional(pool)
        .await?)
    }

    /// 某台服务器上的上报条数；测试幂等与 e2e 对账用。
    pub async fn count_reports(pool: &SqlitePool, server_id: &str) -> anyhow::Result<i64> {
        Ok(
            sqlx::query_scalar("SELECT COUNT(*) FROM traffic_reports WHERE server_id = ?")
                .bind(server_id)
                .fetch_one(pool)
                .await?,
        )
    }
}

/// u64 → SQLite 的 i64：正常流量远小于 i64::MAX，超出时饱和而不是回绕成负数。
fn saturating_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

pub mod nodes {
    use std::collections::HashSet;

    use sqlx::QueryBuilder;

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
        pub cert_id: Option<String>,
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
        /// 三态：缺失 = 不改，`Null` = 解绑，`Value` = 绑定指定证书。
        pub cert_id: Patch<String>,
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
                (id, server_id, tag, name, protocol, transport, security, port, config_json, enabled, cert_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        .bind(&input.cert_id)
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
    /// 全局节点列表（跨服务器），供管理端的选择器使用。
    pub async fn list_all(pool: &SqlitePool) -> anyhow::Result<Vec<crate::models::NodeListItem>> {
        Ok(sqlx::query_as::<_, crate::models::NodeListItem>(
            "SELECT n.*, s.name AS server_name
             FROM nodes n
             JOIN servers s ON s.id = n.server_id
             ORDER BY s.created_at ASC, s.rowid ASC,
                      n.created_at ASC, n.rowid ASC",
        )
        .fetch_all(pool)
        .await?)
    }

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
                enabled = COALESCE(?, enabled),
                cert_id = CASE WHEN ? THEN ? ELSE cert_id END
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
        .bind(i64::from(input.cert_id.is_set()))
        .bind(input.cert_id.value())
        .bind(id)
        .execute(pool)
        .await?;

        if res.rows_affected() == 0 {
            return Ok(None);
        }
        find_by_id(pool, id).await
    }

    /// 这批 id 里哪些在库里不存在；套餐节点范围校验用。
    ///
    /// 外键会在写入时报错，但业务层需要的是「400 + 中文提示」，所以先查一次。
    pub async fn missing_ids(pool: &SqlitePool, ids: &[String]) -> anyhow::Result<Vec<String>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut builder = QueryBuilder::new("SELECT id FROM nodes WHERE id IN (");
        let mut separated = builder.separated(", ");
        for id in ids {
            separated.push_bind(id.clone());
        }
        separated.push_unseparated(")");
        let found: Vec<String> = builder.build_query_scalar().fetch_all(pool).await?;
        let found: HashSet<&str> = found.iter().map(String::as_str).collect();
        Ok(ids
            .iter()
            .filter(|id| !found.contains(id.as_str()))
            .cloned()
            .collect())
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
    use std::collections::HashMap;

    use sqlx::QueryBuilder;

    use super::*;

    pub struct NewPackage {
        pub name: String,
        pub quota_bytes: Option<i64>,
        pub period_days: Option<i64>,
        pub direction: String,
        pub node_ratio: f64,
        /// `None` = 未设范围（可见全部节点）；`Some([])` = 显式一个都不给。
        pub node_ids: Option<Vec<String>>,
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
        /// 节点范围三态：缺失 = 不动；`Null` = 恢复全部；`Value([])` = 一个都不给。
        pub node_ids: Patch<Vec<String>>,
    }

    pub async fn create(pool: &SqlitePool, input: NewPackage) -> anyhow::Result<Package> {
        let id = Uuid::new_v4().to_string();
        let mut tx = pool.begin().await?;
        sqlx::query(
            "INSERT INTO packages
                (id, name, quota_bytes, period_days, direction, node_ratio, created_at,
                 node_scope_explicit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&input.name)
        .bind(input.quota_bytes)
        .bind(input.period_days)
        .bind(&input.direction)
        .bind(input.node_ratio)
        .bind(now())
        .bind(i64::from(input.node_ids.is_some()))
        .execute(&mut *tx)
        .await?;
        if let Some(node_ids) = &input.node_ids {
            insert_scope(&mut tx, &id, node_ids).await?;
        }
        tx.commit().await?;
        find_by_id(pool, &id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("套餐创建后读取失败"))
    }

    /// 覆盖写 `package_nodes`；调用方负责先用 [`super::nodes::missing_ids`] 校验。
    async fn insert_scope(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        package_id: &str,
        node_ids: &[String],
    ) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM package_nodes WHERE package_id = ?")
            .bind(package_id)
            .execute(&mut **tx)
            .await?;
        for node_id in node_ids {
            sqlx::query("INSERT INTO package_nodes (package_id, node_id) VALUES (?, ?)")
                .bind(package_id)
                .bind(node_id)
                .execute(&mut **tx)
                .await?;
        }
        Ok(())
    }

    /// 批量补齐 `node_ids` / `node_count`，避免列表页每个套餐各查一遍。
    ///
    /// `node_count` 是「实际可见节点数」：未设范围时算上全部节点（含 disabled，
    /// 范围本身与启用状态无关），显式空范围时是 0。两个字段搭配即可区分三种语义。
    async fn fill_scope(pool: &SqlitePool, packages: &mut [Package]) -> anyhow::Result<()> {
        if packages.is_empty() {
            return Ok(());
        }
        let mut builder = QueryBuilder::new(
            "SELECT p.id, p.node_scope_explicit, pn.node_id
             FROM packages p
             LEFT JOIN package_nodes pn ON pn.package_id = p.id
             WHERE p.id IN (",
        );
        let mut separated = builder.separated(", ");
        for package in packages.iter() {
            separated.push_bind(package.id.clone());
        }
        separated.push_unseparated(") ORDER BY p.id ASC, pn.node_id ASC");
        let rows = builder
            .build_query_as::<(String, i64, Option<String>)>()
            .fetch_all(pool)
            .await?;

        let mut by_id: HashMap<String, (bool, Vec<String>)> = HashMap::new();
        for (id, explicit, node_id) in rows {
            let entry = by_id.entry(id).or_insert((explicit != 0, Vec::new()));
            if let Some(node_id) = node_id {
                entry.1.push(node_id);
            }
        }

        let total_nodes = if packages
            .iter()
            .any(|package| by_id.get(&package.id).is_none_or(|(explicit, _)| !explicit))
        {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM nodes")
                .fetch_one(pool)
                .await?
                .max(0) as usize
        } else {
            0
        };

        for package in packages.iter_mut() {
            let (explicit, node_ids) = by_id.remove(&package.id).unwrap_or((false, Vec::new()));
            package.node_count = if explicit {
                node_ids.len()
            } else {
                total_nodes
            };
            package.node_ids = node_ids;
        }
        Ok(())
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<Package>> {
        let package = sqlx::query_as::<_, Package>(
            "SELECT p.*,
                    (SELECT COUNT(*) FROM user_packages up WHERE up.package_id = p.id) AS user_count
             FROM packages p
             WHERE p.id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        let Some(package) = package else {
            return Ok(None);
        };
        let mut packages = vec![package];
        fill_scope(pool, &mut packages).await?;
        Ok(packages.pop())
    }

    /// 列表用一次 LEFT JOIN 聚合出引用数，避免前端/后端各来一轮 N+1。
    pub async fn list(pool: &SqlitePool) -> anyhow::Result<Vec<Package>> {
        let mut items = sqlx::query_as::<_, Package>(
            "SELECT p.id, p.name, p.quota_bytes, p.period_days, p.direction, p.node_ratio,
                    p.created_at, COUNT(up.id) AS user_count
             FROM packages p
             LEFT JOIN user_packages up ON up.package_id = p.id
             GROUP BY p.id
             ORDER BY p.created_at DESC, p.rowid DESC",
        )
        .fetch_all(pool)
        .await?;
        fill_scope(pool, &mut items).await?;
        Ok(items)
    }

    /// 套餐节点范围的原始状态；用于判断一次更新是否真的改了范围。
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct NodeScope {
        /// `false` = 未设范围（可见全部节点）。
        pub explicit: bool,
        /// 升序。
        pub node_ids: Vec<String>,
    }

    /// 读范围快照（`None` = 套餐不存在）。调用方用它和更新后的结果比较，
    /// 只有范围真的变了才触发下发，避免无意义 apply。
    pub async fn node_scope(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<NodeScope>> {
        let rows = sqlx::query_as::<_, (i64, Option<String>)>(
            "SELECT p.node_scope_explicit, pn.node_id
             FROM packages p
             LEFT JOIN package_nodes pn ON pn.package_id = p.id
             WHERE p.id = ?
             ORDER BY pn.node_id ASC",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;
        let Some((explicit, _)) = rows.first() else {
            return Ok(None);
        };
        let explicit = *explicit != 0;
        let mut node_ids = Vec::new();
        for (_, node_id) in rows {
            if let Some(node_id) = node_id {
                node_ids.push(node_id);
            }
        }
        Ok(Some(NodeScope { explicit, node_ids }))
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
        // Missing = 不动；Null = 恢复全部（explicit=0，清行）；Value = 显式范围（explicit=1）。
        let (scope_set, scope_explicit) = match &input.node_ids {
            Patch::Missing => (false, 0),
            Patch::Null => (true, 0),
            Patch::Value(_) => (true, 1),
        };
        let mut tx = pool.begin().await?;
        let res = sqlx::query(
            "UPDATE packages SET
                name = COALESCE(?, name),
                quota_bytes = CASE WHEN ? THEN ? ELSE quota_bytes END,
                period_days = CASE WHEN ? THEN ? ELSE period_days END,
                direction = COALESCE(?, direction),
                node_ratio = COALESCE(?, node_ratio),
                node_scope_explicit = CASE WHEN ? THEN ? ELSE node_scope_explicit END
             WHERE id = ?",
        )
        .bind(input.name)
        .bind(quota_set)
        .bind(quota)
        .bind(period_set)
        .bind(period)
        .bind(input.direction)
        .bind(input.node_ratio)
        .bind(scope_set)
        .bind(scope_explicit)
        .bind(id)
        .execute(&mut *tx)
        .await?;

        if res.rows_affected() == 0 {
            return Ok(None);
        }
        match &input.node_ids {
            Patch::Missing => {}
            Patch::Null => {
                sqlx::query("DELETE FROM package_nodes WHERE package_id = ?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            Patch::Value(node_ids) => insert_scope(&mut tx, id, node_ids).await?,
        }
        tx.commit().await?;
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

    /// 瀑布分配用：按创建顺序列出用户所有「原始状态 active」的实例。
    ///
    /// `quota_bytes` 是生效额度（实例覆写优先，其次模板兜底）；`0`/NULL 由
    /// [`crate::metering::BillableInstance::remaining`] 解释为不限。
    pub async fn list_billable(
        pool: &SqlitePool,
        user_id: &str,
    ) -> anyhow::Result<Vec<crate::metering::BillableInstance>> {
        #[derive(sqlx::FromRow)]
        struct BillableRow {
            id: String,
            used_bytes: i64,
            quota_bytes: Option<i64>,
            direction: String,
            node_ratio: f64,
        }

        let rows = sqlx::query_as::<_, BillableRow>(
            "SELECT up.id, up.used_bytes,
                    COALESCE(up.quota_override, p.quota_bytes) AS quota_bytes,
                    up.direction, up.node_ratio
             FROM user_packages up
             JOIN packages p ON p.id = up.package_id
             WHERE up.user_id = ? AND up.status = 'active'
             ORDER BY up.created_at ASC, up.rowid ASC",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|row| crate::metering::BillableInstance {
                id: row.id,
                used_bytes: row.used_bytes,
                quota_bytes: row.quota_bytes,
                direction: row.direction,
                node_ratio: row.node_ratio,
            })
            .collect())
    }

    /// 瀑布分配后按增量累加，避免覆盖同报告里多张实例的连续扣费。
    pub async fn add_used_bytes(pool: &SqlitePool, id: &str, delta: i64) -> anyhow::Result<bool> {
        let res = sqlx::query("UPDATE user_packages SET used_bytes = used_bytes + ? WHERE id = ?")
            .bind(delta.max(0))
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// 日重置候选：`reset_day` 命中今天、且今天还没重置过的 active 实例。
    ///
    /// `reset_days` 是「今天该触发的 reset_day 集合」——29/30/31 在小月会压到
    /// 当月最后一天，所以月末最后一天可能同时命中多个值；这段日历换算留在
    /// 领域层（[`crate::reset`]），这里只按集合过滤。
    ///
    /// 「今天还没重置过」= `last_reset_at` 为空，或落在今天（UTC+8）之外。
    #[derive(Debug, Clone, sqlx::FromRow)]
    pub struct ResetCandidate {
        pub id: String,
        pub user_id: String,
    }

    pub async fn list_reset_candidates(
        pool: &SqlitePool,
        reset_days: &[i64],
        day_start: i64,
        day_end: i64,
    ) -> anyhow::Result<Vec<ResetCandidate>> {
        if reset_days.is_empty() {
            return Ok(Vec::new());
        }

        let mut builder = QueryBuilder::new(
            "SELECT id, user_id FROM user_packages
             WHERE status = 'active' AND reset_day IN (",
        );
        {
            let mut separated = builder.separated(", ");
            for day in reset_days {
                separated.push_bind(*day);
            }
        }
        builder
            .push(") AND (last_reset_at IS NULL OR last_reset_at < ")
            .push_bind(day_start)
            .push(" OR last_reset_at >= ")
            .push_bind(day_end)
            .push(") ORDER BY created_at ASC, rowid ASC");

        Ok(builder
            .build_query_as::<ResetCandidate>()
            .fetch_all(pool)
            .await?)
    }

    /// 对候选实例执行日重置：清零、写 `last_reset_at`、从用户总量饱和扣减。
    ///
    /// 返回 `(实际重置的实例数, 扣减的总字节数)`。整批在一个事务里完成；
    /// `UPDATE` 里重复带上「今天还没重置」的条件，所以即使两个调度器/测试同时
    /// 调用，同一天也只有一次能清零（`rows_affected == 0` 的会被跳过）。
    pub async fn apply_daily_reset(
        pool: &SqlitePool,
        candidates: &[ResetCandidate],
        now: i64,
        day_start: i64,
        day_end: i64,
    ) -> anyhow::Result<(i64, i64)> {
        let mut tx = pool.begin().await?;
        let mut instances = 0i64;
        let mut deducted_bytes = 0i64;

        for candidate in candidates {
            // 事务内重读旧用量：扣减的必须是这次真正清零的那部分。
            let used: Option<i64> = sqlx::query_scalar(
                "SELECT used_bytes FROM user_packages
                 WHERE id = ? AND status = 'active'
                   AND (last_reset_at IS NULL OR last_reset_at < ? OR last_reset_at >= ?)",
            )
            .bind(&candidate.id)
            .bind(day_start)
            .bind(day_end)
            .fetch_optional(&mut *tx)
            .await?;
            let Some(used) = used else {
                continue;
            };

            let reset = sqlx::query(
                "UPDATE user_packages SET used_bytes = 0, last_reset_at = ?
                 WHERE id = ? AND status = 'active'
                   AND (last_reset_at IS NULL OR last_reset_at < ? OR last_reset_at >= ?)",
            )
            .bind(now)
            .bind(&candidate.id)
            .bind(day_start)
            .bind(day_end)
            .execute(&mut *tx)
            .await?;
            if reset.rows_affected() == 0 {
                continue;
            }

            let deduction = used.max(0);
            if deduction > 0 {
                // MAX(..., 0) 就是 saturating_sub：用户总量不够扣时只扣到 0，不出负数。
                sqlx::query(
                    "UPDATE users SET used_bytes = MAX(used_bytes - ?, 0), updated_at = ?
                     WHERE id = ?",
                )
                .bind(deduction)
                .bind(now)
                .bind(&candidate.user_id)
                .execute(&mut *tx)
                .await?;
            }

            instances += 1;
            deducted_bytes = deducted_bytes.saturating_add(deduction);
        }

        tx.commit().await?;
        Ok((instances, deducted_bytes))
    }

    /// 读取实例的重置水位（测试与运维排查用）。
    pub async fn last_reset_at(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<i64>> {
        let row: Option<Option<i64>> =
            sqlx::query_scalar("SELECT last_reset_at FROM user_packages WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await?;
        Ok(row.flatten())
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
        eligible_pairs_matching(pool, server_id, None).await
    }

    /// 单用户的授权对：与 [`eligible_pairs`] 同一条 SQL，只是多一个用户过滤。
    ///
    /// 订阅端只需要一个人的节点，不能把全站授权都拉出来再筛。
    pub async fn eligible_pairs_for_user(
        pool: &SqlitePool,
        server_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Vec<EligiblePair>> {
        eligible_pairs_matching(pool, server_id, Some(user_id)).await
    }

    async fn eligible_pairs_matching(
        pool: &SqlitePool,
        server_id: &str,
        user_id: Option<&str>,
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
               -- 账户总额度：NULL = 不限；达到或超过即全站失去资格
               AND (u.quota_bytes IS NULL OR u.used_bytes < u.quota_bytes)
               AND (? IS NULL OR u.id = ?)
               AND (p.node_scope_explicit = 0
                    OR EXISTS (SELECT 1 FROM package_nodes pn
                               WHERE pn.package_id = p.id AND pn.node_id = n.id))
             ORDER BY u.created_at ASC, u.rowid ASC,
                      n.created_at ASC, n.rowid ASC,
                      up.created_at ASC, up.rowid ASC",
        )
        .bind(server_id)
        .bind(user_id)
        .bind(user_id)
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

    /// 单个用户在所有服务器上的可见节点 id（订阅导出用）。
    ///
    /// 这里不另写过滤条件，复用 [`eligible_pairs_for_user`]：下发配置
    /// （`desired::render`）和订阅导出走同一套 SQL，套餐节点范围不会两处漂移。
    pub async fn eligible_node_ids_for_user(
        pool: &SqlitePool,
        user_id: &str,
    ) -> anyhow::Result<HashSet<String>> {
        let mut node_ids = HashSet::new();
        for server_id in super::servers::list_ids_with_enabled_nodes(pool).await? {
            for pair in eligible_pairs_for_user(pool, &server_id, user_id).await? {
                node_ids.insert(pair.node_id);
            }
        }
        Ok(node_ids)
    }

    /// 单个用户是否有任何可用套餐实例（不涉及节点范围）。
    ///
    /// 订阅导出现在按 [`eligible_node_ids_for_user`] 的节点集合判断，本函数保留
    /// 给只需要「套餐是否可用」的调用方。
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

/// 断流事件与过期对账。
///
/// 「谁已经不可用」的口径复用 [`crate::models::package_status_at`]，和订阅/apply
/// 注入完全一致；这里只负责把候选用户捞出来、把事件落库。
pub mod enforcement {
    use std::collections::HashMap;

    use super::*;

    /// 一条待写库的断流事件；`message` 由调用方用 [`crate::enforcement`] 生成。
    pub struct NewEvent<'a> {
        /// `removed` | `restored`。
        pub kind: &'a str,
        pub user_id: &'a str,
        pub username: &'a str,
        pub server_id: &'a str,
        pub server_name: &'a str,
        pub reason: &'a str,
        pub message: &'a str,
    }

    pub async fn insert_event(
        pool: &SqlitePool,
        input: NewEvent<'_>,
    ) -> anyhow::Result<EnforcementEvent> {
        let id = Uuid::new_v4().to_string();
        let created_at = now();
        sqlx::query(
            "INSERT INTO enforcement_events
                (id, kind, user_id, username, server_id, server_name, reason, message, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(input.kind)
        .bind(input.user_id)
        .bind(input.username)
        .bind(input.server_id)
        .bind(input.server_name)
        .bind(input.reason)
        .bind(input.message)
        .bind(created_at)
        .execute(pool)
        .await?;

        Ok(EnforcementEvent {
            id,
            kind: input.kind.to_string(),
            user_id: input.user_id.to_string(),
            username: input.username.to_string(),
            server_id: input.server_id.to_string(),
            server_name: input.server_name.to_string(),
            reason: input.reason.to_string(),
            message: input.message.to_string(),
            created_at,
        })
    }

    pub async fn list_events(
        pool: &SqlitePool,
        limit: i64,
    ) -> anyhow::Result<Vec<EnforcementEvent>> {
        Ok(sqlx::query_as::<_, EnforcementEvent>(
            "SELECT id, kind, user_id, username, server_id, server_name, reason, message, created_at
             FROM enforcement_events
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?",
        )
        .bind(limit.clamp(1, 200))
        .fetch_all(pool)
        .await?)
    }

    pub async fn count_events(pool: &SqlitePool) -> anyhow::Result<i64> {
        Ok(
            sqlx::query_scalar("SELECT COUNT(*) FROM enforcement_events")
                .fetch_one(pool)
                .await?,
        )
    }

    /// 对账候选：有原始 active 实例、但全部不可用的用户。
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct UnusableUser {
        pub user_id: String,
        pub username: String,
        /// 逗号分隔的原因码，例如 `expired,exhausted`。
        pub reason: String,
    }

    #[derive(sqlx::FromRow)]
    struct CandidateRow {
        user_id: String,
        username: String,
        package_status: String,
        expires_at: Option<i64>,
        quota_bytes: Option<i64>,
        used_bytes: i64,
    }

    /// 扫出「有 active 实例但全部不可用」的 active 用户。
    ///
    /// 只扫原始状态为 `active` 的实例：被管理员停用的实例不属于「跑满/过期」，
    /// 这类用户本来就不会被注入。判断是否可用统一走 [`crate::models::package_status_at`]。
    pub async fn list_unusable_users(
        pool: &SqlitePool,
        now: i64,
    ) -> anyhow::Result<Vec<UnusableUser>> {
        let rows = sqlx::query_as::<_, CandidateRow>(
            "SELECT u.id AS user_id, u.username,
                    up.status AS package_status, up.expires_at,
                    COALESCE(up.quota_override, p.quota_bytes) AS quota_bytes,
                    up.used_bytes
             FROM users u
             JOIN user_packages up ON up.user_id = u.id
             JOIN packages p ON p.id = up.package_id
             WHERE u.status = 'active' AND up.status = 'active'
             ORDER BY u.created_at ASC, u.rowid ASC,
                      up.created_at ASC, up.rowid ASC",
        )
        .fetch_all(pool)
        .await?;

        // 按用户分组；顺序保持 SQL 的稳定顺序，方便日志与测试断言。
        let mut order: Vec<String> = Vec::new();
        let mut grouped: HashMap<String, (String, bool, Vec<&'static str>)> = HashMap::new();
        for row in rows {
            let status = crate::models::package_status_at(
                &row.package_status,
                row.expires_at,
                row.quota_bytes,
                row.used_bytes,
                now,
            );
            let entry = grouped.entry(row.user_id.clone()).or_insert_with(|| {
                order.push(row.user_id.clone());
                (row.username.clone(), false, Vec::new())
            });
            if status == "active" {
                entry.1 = true;
            } else if !entry.2.contains(&status) {
                entry.2.push(status);
            }
        }

        let mut candidates = Vec::new();
        for user_id in order {
            let Some((username, any_usable, reasons)) = grouped.remove(&user_id) else {
                continue;
            };
            // 只要还有一张可用卡就保留；reasons 为空说明没有可判断的实例。
            if any_usable || reasons.is_empty() {
                continue;
            }
            candidates.push(UnusableUser {
                user_id,
                username,
                reason: crate::enforcement::merge_reasons(reasons),
            });
        }
        Ok(candidates)
    }
}

/// 管理端概览与趋势：全部走聚合 SQL，不把明细行拉进内存。
///
/// 每个数字一条聚合查询（`COUNT` / `SUM`），避免 N+1；趋势只取请求窗口内的
/// 日聚合，再在内存里给缺失日期补 0（窗口最大 90 行，不构成全表扫描）。
pub mod certificates {
    use sqlx::{QueryBuilder, Sqlite};

    use super::*;

    pub struct NewCertificate {
        pub name: String,
        pub domains: Vec<String>,
        pub cert_pem: String,
        pub key_pem: String,
        pub not_before: i64,
        pub not_after: i64,
    }

    pub async fn create(pool: &SqlitePool, input: NewCertificate) -> anyhow::Result<Certificate> {
        let id = Uuid::new_v4().to_string();
        let domains = serde_json::to_string(&input.domains)?;
        sqlx::query(
            "INSERT INTO certificates
                (id, name, domains, cert_pem, key_pem, not_before, not_after, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&input.name)
        .bind(&domains)
        .bind(&input.cert_pem)
        .bind(&input.key_pem)
        .bind(input.not_before)
        .bind(input.not_after)
        .bind(now())
        .execute(pool)
        .await?;
        find_by_id(pool, &id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("证书创建后读取失败"))
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<Certificate>> {
        Ok(
            sqlx::query_as::<_, Certificate>("SELECT * FROM certificates WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await?,
        )
    }

    /// 一次取回多张证书（下发时按 id 去重后调用，避免 N+1）。
    pub async fn find_by_ids(
        pool: &SqlitePool,
        ids: &[String],
    ) -> anyhow::Result<Vec<Certificate>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut builder = QueryBuilder::<Sqlite>::new("SELECT * FROM certificates WHERE id IN (");
        let mut separated = builder.separated(", ");
        for id in ids {
            separated.push_bind(id);
        }
        separated.push_unseparated(") ORDER BY id ASC");
        Ok(builder
            .build_query_as::<Certificate>()
            .fetch_all(pool)
            .await?)
    }

    #[derive(sqlx::FromRow)]
    struct ViewRow {
        id: String,
        name: String,
        domains: String,
        not_before: i64,
        not_after: i64,
        created_at: i64,
    }

    impl ViewRow {
        fn into_view(self, now: i64) -> CertificateView {
            CertificateView {
                id: self.id,
                name: self.name,
                domains: serde_json::from_str(&self.domains).unwrap_or_default(),
                not_before: self.not_before,
                not_after: self.not_after,
                days_left: crate::certificate::days_left(self.not_after, now),
                has_key: true,
                created_at: self.created_at,
            }
        }
    }

    const VIEW_COLUMNS: &str =
        "SELECT id, name, domains, not_before, not_after, created_at FROM certificates";

    /// 列表只取元数据列：私钥与证书正文永远不离开仓储。
    pub async fn list_views(pool: &SqlitePool, now: i64) -> anyhow::Result<Vec<CertificateView>> {
        let rows = sqlx::query_as::<_, ViewRow>(&format!(
            "{VIEW_COLUMNS} ORDER BY created_at ASC, rowid ASC"
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(|row| row.into_view(now)).collect())
    }

    pub async fn view_by_id(
        pool: &SqlitePool,
        id: &str,
        now: i64,
    ) -> anyhow::Result<Option<CertificateView>> {
        let row = sqlx::query_as::<_, ViewRow>(&format!("{VIEW_COLUMNS} WHERE id = ?"))
            .bind(id)
            .fetch_optional(pool)
            .await?;
        Ok(row.map(|row| row.into_view(now)))
    }

    pub async fn count_node_references(pool: &SqlitePool, id: &str) -> anyhow::Result<i64> {
        Ok(
            sqlx::query_scalar("SELECT COUNT(*) FROM nodes WHERE cert_id = ?")
                .bind(id)
                .fetch_one(pool)
                .await?,
        )
    }

    /// 概览告警口径：`not_after - now <= 30 天`（含已过期）。
    pub async fn count_expiring(pool: &SqlitePool, now: i64) -> anyhow::Result<i64> {
        let deadline = now + crate::certificate::EXPIRING_DAYS * 86_400;
        Ok(
            sqlx::query_scalar("SELECT COUNT(*) FROM certificates WHERE not_after <= ?")
                .bind(deadline)
                .fetch_one(pool)
                .await?,
        )
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
        let res = sqlx::query("DELETE FROM certificates WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }
}

pub mod stats {
    use std::collections::HashMap;

    use super::*;

    /// 概览一次查齐所有卡片数字。`now` 由调用方传入，测试可以固定时间。
    pub async fn overview(pool: &SqlitePool, now: i64) -> anyhow::Result<Overview> {
        let (servers_total, servers_online): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END), 0)
             FROM servers",
        )
        .fetch_one(pool)
        .await?;

        let (users_total, users_active): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0)
             FROM users",
        )
        .fetch_one(pool)
        .await?;

        let packages_total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM packages")
            .fetch_one(pool)
            .await?;
        let package_instances: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_packages")
            .fetch_one(pool)
            .await?;

        let today = crate::time::business_date(now);
        let (month_start, month_end) = crate::time::business_month_bounds(now);
        let today_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(weighted), 0) FROM traffic_daily WHERE day = ?",
        )
        .bind(&today)
        .fetch_one(pool)
        .await?;
        let month_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(weighted), 0) FROM traffic_daily
             WHERE day >= ? AND day <= ?",
        )
        .bind(&month_start)
        .bind(&month_end)
        .fetch_one(pool)
        .await?;

        // 告警口径与 UserPackageView.status 一致：disabled 不算过期/用尽；
        // 已过期的实例只计入 expired，不重复计入 exhausted。
        let expired_instances: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)
             FROM user_packages up
             JOIN packages p ON p.id = up.package_id
             WHERE up.status = 'active'
               AND up.expires_at IS NOT NULL AND up.expires_at <= ?",
        )
        .bind(now)
        .fetch_one(pool)
        .await?;
        let exhausted_instances: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)
             FROM user_packages up
             JOIN packages p ON p.id = up.package_id
             WHERE up.status = 'active'
               AND (up.expires_at IS NULL OR up.expires_at > ?)
               AND COALESCE(up.quota_override, p.quota_bytes) > 0
               AND up.used_bytes >= COALESCE(up.quota_override, p.quota_bytes)",
        )
        .bind(now)
        .fetch_one(pool)
        .await?;
        let offline_servers: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM servers WHERE status <> 'online'")
                .fetch_one(pool)
                .await?;
        let expiring_certs = super::certificates::count_expiring(pool, now).await?;

        Ok(Overview {
            servers: ServerStats {
                total: servers_total,
                online: servers_online,
            },
            users: UserStats {
                total: users_total,
                active: users_active,
            },
            packages: PackageStats {
                total: packages_total,
                instances: package_instances,
            },
            traffic: TrafficStats {
                today_bytes,
                month_bytes,
            },
            alerts: AlertStats {
                expired_instances,
                exhausted_instances,
                offline_servers,
                expiring_certs,
            },
        })
    }

    /// 最近 `days` 天（含今天）的日趋势，升序返回。
    ///
    /// SQL 只做 `GROUP BY day`；缺失日期在内存里补 0，保证前端拿到连续的
    /// `days` 个点。`days` 在这里再夹一次，防止调用方绕过校验。
    pub async fn traffic_trend(
        pool: &SqlitePool,
        now: i64,
        days: i64,
    ) -> anyhow::Result<Vec<TrafficDay>> {
        traffic_trend_scoped(pool, now, days, None).await
    }

    /// 单个用户（`traffic_daily.subject == user_id`）的日趋势，形状与全局一致。
    pub async fn traffic_trend_for_subject(
        pool: &SqlitePool,
        now: i64,
        days: i64,
        subject: &str,
    ) -> anyhow::Result<Vec<TrafficDay>> {
        traffic_trend_scoped(pool, now, days, Some(subject)).await
    }

    /// 单用户今日/本月计费流量（`weighted` 之和）。
    pub async fn subject_totals(
        pool: &SqlitePool,
        subject: &str,
        now: i64,
    ) -> anyhow::Result<(i64, i64)> {
        let today = crate::time::business_date(now);
        let (month_start, month_end) = crate::time::business_month_bounds(now);
        let row: (i64, i64) = sqlx::query_as(
            "SELECT COALESCE(SUM(CASE WHEN day = ? THEN weighted ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN day >= ? AND day <= ? THEN weighted ELSE 0 END), 0)
             FROM traffic_daily WHERE subject = ?",
        )
        .bind(&today)
        .bind(&month_start)
        .bind(&month_end)
        .bind(subject)
        .fetch_one(pool)
        .await?;
        Ok(row)
    }

    async fn traffic_trend_scoped(
        pool: &SqlitePool,
        now: i64,
        days: i64,
        subject: Option<&str>,
    ) -> anyhow::Result<Vec<TrafficDay>> {
        let days = days.clamp(1, 90);
        let today = crate::time::business_day(now);
        let first = today - (days - 1);
        let start_date = crate::time::business_date(crate::time::business_day_start(first));
        let end_date = crate::time::business_date(crate::time::business_day_start(today));

        #[derive(sqlx::FromRow)]
        struct DayRow {
            day: String,
            uplink: i64,
            downlink: i64,
            weighted: i64,
        }

        let sql = if subject.is_some() {
            "SELECT day,
                    COALESCE(SUM(uplink), 0) AS uplink,
                    COALESCE(SUM(downlink), 0) AS downlink,
                    COALESCE(SUM(weighted), 0) AS weighted
             FROM traffic_daily
             WHERE day >= ? AND day <= ? AND subject = ?
             GROUP BY day"
        } else {
            "SELECT day,
                    COALESCE(SUM(uplink), 0) AS uplink,
                    COALESCE(SUM(downlink), 0) AS downlink,
                    COALESCE(SUM(weighted), 0) AS weighted
             FROM traffic_daily
             WHERE day >= ? AND day <= ?
             GROUP BY day"
        };
        let mut query = sqlx::query_as::<_, DayRow>(sql)
            .bind(&start_date)
            .bind(&end_date);
        if let Some(subject) = subject {
            query = query.bind(subject);
        }
        let rows = query.fetch_all(pool).await?;

        let mut by_day: HashMap<String, (i64, i64, i64)> = rows
            .into_iter()
            .map(|row| (row.day, (row.uplink, row.downlink, row.weighted)))
            .collect();

        let mut points = Vec::with_capacity(days as usize);
        for offset in 0..days {
            let date = crate::time::business_date(crate::time::business_day_start(first + offset));
            let (uplink, downlink, weighted) = by_day.remove(&date).unwrap_or((0, 0, 0));
            points.push(TrafficDay {
                date,
                uplink,
                downlink,
                weighted,
            });
        }
        Ok(points)
    }
}
