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

    /// 覆盖写入（设置页用）。
    pub async fn set(pool: &SqlitePool, key: &str, value: &str) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(pool)
        .await?;
        Ok(())
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
        /// 用户级规则模板绑定；`None` = 跟随套餐 / 全局默认。
        pub rule_template_id: Option<String>,
    }

    #[derive(Debug, Default)]
    pub struct UpdateUser {
        pub role: Option<String>,
        pub status: Option<String>,
        /// 缺失 = 不改；`Patch::Null` = 不限；`Patch::Value` = 具体额度。
        pub quota_bytes: Patch<i64>,
        /// 缺失 = 不改；`Patch::Null` = 解绑（跟随套餐 / 默认）；`Patch::Value` = 绑定。
        pub rule_template_id: Patch<String>,
    }

    pub async fn create(pool: &SqlitePool, input: NewUser) -> anyhow::Result<User> {
        let id = Uuid::new_v4().to_string();
        let hash = crate::password::hash(&input.password)?;
        let short_code = new_short_code();
        let ts = now();
        sqlx::query(
            "INSERT INTO users
                (id, username, password_hash, role, status, short_code, short_code_updated_at,
                 quota_bytes, rule_template_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&input.username)
        .bind(&hash)
        .bind(&input.role)
        .bind(&short_code)
        .bind(ts)
        .bind(input.quota_bytes)
        .bind(input.rule_template_id)
        .bind(ts)
        .bind(ts)
        .execute(pool)
        .await?;
        find_by_id(pool, &id).await
    }

    /// 订阅短码：10 位十六进制（与建号时一致）。
    ///
    /// 短码不是密钥，但泄漏等于送人流量；长度只要求「难以枚举」，不需要可读性。
    fn new_short_code() -> String {
        Uuid::new_v4().simple().to_string()[..10].to_string()
    }

    /// 用户自助重置订阅：只改 `id` 指定的这一行，返回新短码与时间戳。
    ///
    /// 唯一索引冲突理论上只有 16^10 分之一，但并发/倒霉时不能 500：
    /// 换一个短码重试，最多 5 次。**不接受任何调用方传入的用户 id 之外的过滤条件**，
    /// 越权由路由层取会话用户保证。
    pub async fn reset_short_code(
        pool: &SqlitePool,
        id: &str,
    ) -> anyhow::Result<Option<(String, i64)>> {
        for _ in 0..5 {
            let short_code = new_short_code();
            let ts = now();
            let result = sqlx::query(
                "UPDATE users
                 SET short_code = ?, short_code_updated_at = ?, updated_at = ?
                 WHERE id = ?",
            )
            .bind(&short_code)
            .bind(ts)
            .bind(ts)
            .bind(id)
            .execute(pool)
            .await;

            match result {
                Ok(res) if res.rows_affected() > 0 => return Ok(Some((short_code, ts))),
                Ok(_) => return Ok(None),
                Err(sqlx::Error::Database(error)) if error.is_unique_violation() => continue,
                Err(error) => return Err(error.into()),
            }
        }
        anyhow::bail!("生成订阅短码连续冲突")
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
        let rule_set = input.rule_template_id.is_set();
        let rule = input.rule_template_id.value();
        let res = sqlx::query(
            "UPDATE users SET
                role = COALESCE(?, role),
                status = COALESCE(?, status),
                quota_bytes = CASE WHEN ? THEN ? ELSE quota_bytes END,
                rule_template_id = CASE WHEN ? THEN ? ELSE rule_template_id END,
                updated_at = ?
             WHERE id = ?",
        )
        .bind(input.role)
        .bind(input.status)
        .bind(quota_set)
        .bind(quota)
        .bind(rule_set)
        .bind(rule)
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

pub mod rule_templates {
    use std::collections::{HashMap, HashSet};

    use sqlx::QueryBuilder;

    use super::*;
    use crate::models::{RuleTemplate, RuleTemplateRow};

    pub struct NewRuleTemplate {
        pub name: String,
        pub description: String,
        pub rules: Vec<String>,
        pub is_default: bool,
    }

    #[derive(Debug, Default)]
    pub struct UpdateRuleTemplate {
        pub name: Option<String>,
        pub description: Option<String>,
        pub rules: Option<Vec<String>>,
        pub is_default: Option<bool>,
    }

    /// 删除结果：默认模板由仓储拒绝，调用方据此回 400 中文。
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum DeleteOutcome {
        Deleted,
        NotFound,
        IsDefault,
    }

    fn encode_rules(rules: &[String]) -> anyhow::Result<String> {
        Ok(serde_json::to_string(rules)?)
    }

    fn from_rows(rows: Vec<RuleTemplateRow>) -> Vec<RuleTemplate> {
        rows.into_iter().map(RuleTemplate::from).collect()
    }

    /// 默认模板排在最前，其余按创建顺序；顺序稳定，前端不需要再排。
    pub async fn list(pool: &SqlitePool) -> anyhow::Result<Vec<RuleTemplate>> {
        let rows = sqlx::query_as::<_, RuleTemplateRow>(
            "SELECT id, name, description, rules, is_default, created_at, updated_at
             FROM rule_templates
             ORDER BY is_default DESC, created_at ASC, rowid ASC",
        )
        .fetch_all(pool)
        .await?;
        Ok(from_rows(rows))
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<RuleTemplate>> {
        let row = sqlx::query_as::<_, RuleTemplateRow>(
            "SELECT id, name, description, rules, is_default, created_at, updated_at
             FROM rule_templates WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(RuleTemplate::from))
    }

    /// 名称唯一性预检：返回已有行，路由据此给出 400 而不是等数据库报错。
    pub async fn find_by_name(
        pool: &SqlitePool,
        name: &str,
    ) -> anyhow::Result<Option<RuleTemplate>> {
        let row = sqlx::query_as::<_, RuleTemplateRow>(
            "SELECT id, name, description, rules, is_default, created_at, updated_at
             FROM rule_templates WHERE name = ?",
        )
        .bind(name)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(RuleTemplate::from))
    }

    /// 订阅端未指定 `?rule=` 时用它；理论上迁移保证存在，但仍返回 `Option`
    /// 以便调用方回落到内置规则。
    pub async fn find_default(pool: &SqlitePool) -> anyhow::Result<Option<RuleTemplate>> {
        let row = sqlx::query_as::<_, RuleTemplateRow>(
            "SELECT id, name, description, rules, is_default, created_at, updated_at
             FROM rule_templates WHERE is_default = 1 LIMIT 1",
        )
        .fetch_optional(pool)
        .await?;
        Ok(row.map(RuleTemplate::from))
    }

    /// 一次取多个模板（订阅列表批量解析用，避免每行一次查询）。
    pub async fn find_by_ids(
        pool: &SqlitePool,
        ids: &[String],
    ) -> anyhow::Result<HashMap<String, RuleTemplate>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut builder = QueryBuilder::new(
            "SELECT id, name, description, rules, is_default, created_at, updated_at
             FROM rule_templates WHERE id IN (",
        );
        let mut separated = builder.separated(", ");
        for id in ids {
            separated.push_bind(id.clone());
        }
        separated.push_unseparated(")");
        let rows = builder
            .build_query_as::<RuleTemplateRow>()
            .fetch_all(pool)
            .await?;
        Ok(from_rows(rows)
            .into_iter()
            .map(|template| (template.id.clone(), template))
            .collect())
    }

    /// 解析一个用户实际生效的规则模板。
    ///
    /// 顺序与订阅端点一致：用户绑定 → 当前套餐绑定 → 全局默认 → `None`（内置规则）。
    /// 绑定指向不存在的模板时视为未绑定继续回落——外键 `SET NULL` 已经会清列，
    /// 这里再兜一层，兼容外键关闭期间留下的脏 id。
    pub async fn resolve_for_user(
        pool: &SqlitePool,
        user_id: &str,
        user_binding: Option<&str>,
    ) -> anyhow::Result<Option<RuleTemplate>> {
        let resolved = resolve_for_users(
            pool,
            &[(user_id.to_string(), user_binding.map(str::to_string))],
        )
        .await?;
        Ok(resolved.get(user_id).cloned().flatten())
    }

    /// 批量解析多个用户的生效模板；返回每个用户对应的模板（`None` = 内置规则）。
    ///
    /// 用户绑定从调用方传入（`UserView.rule_template_id`），因此这里只需要一次
    /// 「每个用户当前套餐绑定」查询 + 一次模板查询，订阅列表不会 N+1。
    pub async fn resolve_for_users(
        pool: &SqlitePool,
        users: &[(String, Option<String>)],
    ) -> anyhow::Result<HashMap<String, Option<RuleTemplate>>> {
        let mut resolved: HashMap<String, Option<RuleTemplate>> = HashMap::new();
        if users.is_empty() {
            return Ok(resolved);
        }

        let user_ids: Vec<String> = users.iter().map(|(id, _)| id.clone()).collect();
        let package_bindings =
            super::user_packages::current_rule_template_ids(pool, &user_ids).await?;
        let default = find_default(pool).await?;

        // 所有可能命中的模板一次查完：用户绑定 + 套餐绑定 + 默认。
        let mut candidates: HashSet<String> = users
            .iter()
            .filter_map(|(_, binding)| binding.clone())
            .collect();
        candidates.extend(package_bindings.values().cloned());
        if let Some(default) = &default {
            candidates.insert(default.id.clone());
        }
        let templates: HashMap<String, RuleTemplate> =
            find_by_ids(pool, &candidates.into_iter().collect::<Vec<_>>()).await?;

        for (user_id, binding) in users {
            let chosen = binding
                .as_ref()
                .and_then(|id| templates.get(id))
                .or_else(|| {
                    package_bindings
                        .get(user_id)
                        .and_then(|id| templates.get(id))
                })
                .or(default.as_ref());
            resolved.insert(user_id.clone(), chosen.cloned());
        }
        Ok(resolved)
    }

    /// 创建模板；`is_default = true` 时在**同一事务**里先清掉旧的默认标记。
    pub async fn create(pool: &SqlitePool, input: NewRuleTemplate) -> anyhow::Result<RuleTemplate> {
        let id = Uuid::new_v4().to_string();
        let rules = encode_rules(&input.rules)?;
        let ts = now();
        let mut tx = pool.begin().await?;
        if input.is_default {
            sqlx::query("UPDATE rule_templates SET is_default = 0 WHERE is_default = 1")
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "INSERT INTO rule_templates
                (id, name, description, rules, is_default, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&input.name)
        .bind(&input.description)
        .bind(&rules)
        .bind(i64::from(input.is_default))
        .bind(ts)
        .bind(ts)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        find_by_id(pool, &id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("规则模板创建后读取失败"))
    }

    /// 只更新传入的字段。设新默认时在同一事务里先清掉其它行，保证不会出现两个 1。
    ///
    /// 先确认目标行存在再清默认，避免 `PATCH` 一个不存在的 id 把全站默认清空。
    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        input: UpdateRuleTemplate,
    ) -> anyhow::Result<Option<RuleTemplate>> {
        let rules = input.rules.as_deref().map(encode_rules).transpose()?;
        let (default_set, default_value) = match input.is_default {
            Some(value) => (true, i64::from(value)),
            None => (false, 0),
        };
        let mut tx = pool.begin().await?;
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT is_default FROM rule_templates WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        if exists.is_none() {
            return Ok(None);
        }
        if input.is_default == Some(true) {
            sqlx::query("UPDATE rule_templates SET is_default = 0 WHERE id <> ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "UPDATE rule_templates SET
                name = COALESCE(?, name),
                description = COALESCE(?, description),
                rules = COALESCE(?, rules),
                is_default = CASE WHEN ? THEN ? ELSE is_default END,
                updated_at = ?
             WHERE id = ?",
        )
        .bind(input.name)
        .bind(input.description)
        .bind(rules)
        .bind(default_set)
        .bind(default_value)
        .bind(now())
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        find_by_id(pool, id).await
    }

    /// 删除非默认模板。默认模板不允许删，否则订阅会失去当前策略。
    pub async fn delete(pool: &SqlitePool, id: &str) -> anyhow::Result<DeleteOutcome> {
        let mut tx = pool.begin().await?;
        let is_default: Option<i64> =
            sqlx::query_scalar("SELECT is_default FROM rule_templates WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        match is_default {
            None => Ok(DeleteOutcome::NotFound),
            Some(1) => Ok(DeleteOutcome::IsDefault),
            Some(_) => {
                let removed = sqlx::query("DELETE FROM rule_templates WHERE id = ?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected();
                tx.commit().await?;
                Ok(if removed > 0 {
                    DeleteOutcome::Deleted
                } else {
                    DeleteOutcome::NotFound
                })
            }
        }
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

    /// 改密码后吊销该用户的其它会话，保留当前 token 对应的那条。
    ///
    /// 按 token 哈希比对而不是 token 明文，库里本来也不存明文。
    pub async fn delete_others(
        pool: &SqlitePool,
        user_id: &str,
        keep_token: &str,
    ) -> anyhow::Result<u64> {
        let keep_hash = crate::password::sha256_hex(keep_token);
        let res = sqlx::query("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?")
            .bind(user_id)
            .bind(keep_hash)
            .execute(pool)
            .await?;
        Ok(res.rows_affected())
    }

    /// 某用户的全部会话，按创建时间正序（最新一条在最后）。
    pub async fn list_for_user(pool: &SqlitePool, user_id: &str) -> anyhow::Result<Vec<Session>> {
        Ok(sqlx::query_as::<_, Session>(
            "SELECT id, user_id, token_hash, expires_at, created_at
             FROM sessions WHERE user_id = ? ORDER BY created_at ASC, rowid ASC",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?)
    }

    /// 会话总行数（调度器清理的测试用）。
    pub async fn count(pool: &SqlitePool) -> anyhow::Result<i64> {
        Ok(sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(pool)
            .await?)
    }
}

pub mod servers {
    use super::*;

    /// Agent 心跳里与本项目相关的健康指标。
    #[derive(Debug, Clone, Default)]
    pub struct HealthSnapshot {
        /// CPU 架构（`x86_64` / `aarch64`）；空串 = 旧 Agent 没上报。
        pub arch: String,
        pub xray_running: bool,
        pub nginx_running: bool,
        pub load1: f64,
        pub mem_used: i64,
        pub mem_total: i64,
        pub disk_used: i64,
        pub disk_total: i64,
        pub uptime_secs: i64,
        /// Agent 测得并缓存的 TCP 握手 RTT（毫秒）；None = 本轮没有有效结果。
        pub latency_ms: Option<i64>,
        /// `/etc/os-release` 的 NAME；None = 旧 Agent 或读不到。
        pub os_name: Option<String>,
        /// `/etc/os-release` 的 VERSION_ID；None = 旧 Agent 或读不到。
        pub os_version: Option<String>,
        /// 虚拟化类型（kvm / vmware / ...）；None = 裸机或读不到。
        pub virt: Option<String>,
        /// realm 引擎是否可用；None = 旧 Agent 未上报（保持 NULL）。
        pub realm_available: Option<bool>,
        /// realm 是否带 transport feature；None = 旧 Agent 未上报 / 无法判定。
        pub realm_transport: Option<bool>,
        /// nftables 引擎是否可用；None = 旧 Agent 未上报。
        pub nftables_available: Option<bool>,
    }

    /// 返回 (服务器, 明文配对 token)。token 只在创建时可见一次。
    pub async fn create(
        pool: &SqlitePool,
        name: &str,
        address: &str,
        xray_mode: &str,
    ) -> anyhow::Result<(Server, String)> {
        create_with_country(pool, name, address, xray_mode, None).await
    }

    /// 同 [`create`]，但允许在创建时直接填写国家/地区代码。
    pub async fn create_with_country(
        pool: &SqlitePool,
        name: &str,
        address: &str,
        xray_mode: &str,
        country_code: Option<&str>,
    ) -> anyhow::Result<(Server, String)> {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let token_hash = crate::password::sha256_hex(&token);
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO servers (id, name, address, token_hash, xray_mode, country_code, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(address)
        .bind(&token_hash)
        .bind(xray_mode)
        .bind(country_code)
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

    /// 改名 / 改地址 / 改 xray 模式 / 开关 Agent 升级；其他字段一律不动。
    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        name: Option<&str>,
        address: Option<&str>,
        xray_mode: Option<&str>,
        allow_agent_upgrade: Option<bool>,
    ) -> anyhow::Result<Option<Server>> {
        sqlx::query(
            "UPDATE servers SET
                name = COALESCE(?, name),
                address = COALESCE(?, address),
                xray_mode = COALESCE(?, xray_mode),
                allow_agent_upgrade = COALESCE(?, allow_agent_upgrade)
             WHERE id = ?",
        )
        .bind(name)
        .bind(address)
        .bind(xray_mode)
        .bind(allow_agent_upgrade)
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

    /// 设置（或清空）国家/地区代码。`None` = 清空为 NULL，与「没传」区分开。
    pub async fn set_country_code(
        pool: &SqlitePool,
        id: &str,
        country_code: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query("UPDATE servers SET country_code = ? WHERE id = ?")
            .bind(country_code)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// 设置（或清空）期望的 Agent 版本。`None` = 不升级。
    pub async fn set_agent_target_version(
        pool: &SqlitePool,
        id: &str,
        version: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query("UPDATE servers SET agent_target_version = ? WHERE id = ?")
            .bind(version)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
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
                arch = ?,
                os_name = ?,
                os_version = ?,
                virt = ?,
                realm_available = ?,
                realm_transport = ?,
                nftables_available = ?,
                xray_running = ?,
                nginx_running = ?,
                load1 = ?,
                mem_used = ?,
                mem_total = ?,
                disk_used = ?,
                disk_total = ?,
                uptime_secs = ?,
                latency_ms = ?
             WHERE id = ?",
        )
        .bind(now())
        .bind(now())
        .bind(agent_version)
        .bind(&health.arch)
        .bind(&health.os_name)
        .bind(&health.os_version)
        .bind(&health.virt)
        .bind(health.realm_available)
        .bind(health.realm_transport)
        .bind(health.nftables_available)
        .bind(health.xray_running)
        .bind(health.nginx_running)
        .bind(health.load1)
        .bind(health.mem_used)
        .bind(health.mem_total)
        .bind(health.disk_used)
        .bind(health.disk_total)
        .bind(health.uptime_secs)
        .bind(health.latency_ms)
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

/// Agent 自升级尝试：每次触发一条，心跳确认后把 pending 翻成 succeeded。
pub mod agent_upgrades {
    use super::*;

    /// 新建一条 pending 记录。
    pub async fn create(
        pool: &SqlitePool,
        server_id: &str,
        from_version: &str,
        to_version: &str,
    ) -> anyhow::Result<AgentUpgrade> {
        let id = Uuid::new_v4().to_string();
        let ts = now();
        sqlx::query(
            "INSERT INTO agent_upgrades
                (id, server_id, from_version, to_version, status, error, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', '', ?, ?)",
        )
        .bind(&id)
        .bind(server_id)
        .bind(from_version)
        .bind(to_version)
        .bind(ts)
        .bind(ts)
        .execute(pool)
        .await?;
        find_by_id(pool, &id)
            .await?
            .ok_or_else(|| sqlx::Error::RowNotFound.into())
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<AgentUpgrade>> {
        Ok(
            sqlx::query_as::<_, AgentUpgrade>("SELECT * FROM agent_upgrades WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await?,
        )
    }

    /// 最近一条升级记录（不论状态）。判断「有没有进行中的升级」用它。
    pub async fn latest(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Option<AgentUpgrade>> {
        Ok(sqlx::query_as::<_, AgentUpgrade>(
            "SELECT * FROM agent_upgrades
             WHERE server_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1",
        )
        .bind(server_id)
        .fetch_optional(pool)
        .await?)
    }

    /// 记录「第一次看到目标版本」的时刻，作为稳定窗口的起点。幂等：已有值不覆盖。
    pub async fn mark_confirmed(pool: &SqlitePool, id: &str, ts: i64) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE agent_upgrades SET confirmed_at = ?
             WHERE id = ? AND confirmed_at IS NULL",
        )
        .bind(ts)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// 某台服务器仍在 pending 的升级记录。
    pub async fn find_pending(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Option<AgentUpgrade>> {
        Ok(sqlx::query_as::<_, AgentUpgrade>(
            "SELECT * FROM agent_upgrades
             WHERE server_id = ? AND status = 'pending'
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1",
        )
        .bind(server_id)
        .fetch_optional(pool)
        .await?)
    }

    /// 把超时仍未完成的升级标成 failed，并清空对应服务器的目标版本。
    ///
    /// 没有这一步，Agent 起不来时 `agent_target_version` 会永远挂着，
    /// 前端一直转圈、也无法重新发起升级。
    pub async fn expire_stale(
        pool: &SqlitePool,
        now: i64,
        timeout_secs: i64,
        error: &str,
    ) -> anyhow::Result<Vec<String>> {
        let cutoff = now - timeout_secs;
        let stale: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, server_id FROM agent_upgrades
             WHERE status = 'pending' AND created_at <= ?",
        )
        .bind(cutoff)
        .fetch_all(pool)
        .await?;
        if stale.is_empty() {
            return Ok(Vec::new());
        }
        let mut expired = Vec::new();
        for (id, server_id) in stale {
            mark(pool, &id, "failed", error).await?;
            servers::set_agent_target_version(pool, &server_id, None).await?;
            expired.push(server_id);
        }
        Ok(expired)
    }

    /// 更新状态与错误说明；`updated_at` 一并推进。
    pub async fn mark(
        pool: &SqlitePool,
        id: &str,
        status: &str,
        error: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE agent_upgrades
             SET status = ?, error = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(status)
        .bind(error)
        .bind(now())
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// 某台服务器的升级历史，最新在前。
    pub async fn list_by_server(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Vec<AgentUpgrade>> {
        Ok(sqlx::query_as::<_, AgentUpgrade>(
            "SELECT * FROM agent_upgrades
             WHERE server_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT 100",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?)
    }
}

/// 批量 Agent 升级：只排队、只记录状态；真正的升级仍然走 [`agent_upgrades`]。
pub mod upgrade_batches {
    use super::*;

    /// 新建一个 running 批次，并按 `server_ids` 的顺序插入 queued items。
    ///
    /// 批次和 items 在同一个事务里写入：校验通过后不能出现「有批次没条目」。
    pub async fn create(
        pool: &SqlitePool,
        server_ids: &[String],
        to_version: &str,
        stop_on_failure: bool,
        concurrency: i64,
    ) -> anyhow::Result<AgentUpgradeBatch> {
        let id = Uuid::new_v4().to_string();
        let ts = now();
        let mut tx = pool.begin().await?;
        sqlx::query(
            "INSERT INTO agent_upgrade_batches
                (id, from_version, to_version, status, stop_on_failure, concurrency, created_at, updated_at)
             VALUES (?, '', ?, 'running', ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(to_version)
        .bind(stop_on_failure)
        .bind(concurrency)
        .bind(ts)
        .bind(ts)
        .execute(&mut *tx)
        .await?;

        for server_id in server_ids {
            sqlx::query(
                "INSERT INTO agent_upgrade_batch_items
                    (batch_id, server_id, upgrade_id, status, error, updated_at)
                 VALUES (?, ?, NULL, 'queued', '', ?)",
            )
            .bind(&id)
            .bind(server_id)
            .bind(ts)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        find_by_id(pool, &id).await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<AgentUpgradeBatch> {
        Ok(sqlx::query_as::<_, AgentUpgradeBatch>(
            "SELECT * FROM agent_upgrade_batches WHERE id = ?",
        )
        .bind(id)
        .fetch_one(pool)
        .await?)
    }

    pub async fn find_by_id_opt(
        pool: &SqlitePool,
        id: &str,
    ) -> anyhow::Result<Option<AgentUpgradeBatch>> {
        Ok(sqlx::query_as::<_, AgentUpgradeBatch>(
            "SELECT * FROM agent_upgrade_batches WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?)
    }

    /// 最近的批次，最新在前。`limit` 夹在 1..=100。
    pub async fn list(pool: &SqlitePool, limit: i64) -> anyhow::Result<Vec<AgentUpgradeBatch>> {
        Ok(sqlx::query_as::<_, AgentUpgradeBatch>(
            "SELECT * FROM agent_upgrade_batches
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?",
        )
        .bind(limit.clamp(1, 100))
        .fetch_all(pool)
        .await?)
    }

    /// 批次详情：按插入顺序返回，带服务器名与当前 Agent 版本。
    pub async fn items(
        pool: &SqlitePool,
        batch_id: &str,
    ) -> anyhow::Result<Vec<AgentUpgradeBatchItemView>> {
        Ok(sqlx::query_as::<_, AgentUpgradeBatchItemView>(
            "SELECT i.batch_id, i.server_id, s.name AS server_name,
                    s.agent_version AS agent_version, i.upgrade_id,
                    i.status, i.error, i.updated_at
             FROM agent_upgrade_batch_items i
             JOIN servers s ON s.id = i.server_id
             WHERE i.batch_id = ?
             ORDER BY i.rowid ASC",
        )
        .bind(batch_id)
        .fetch_all(pool)
        .await?)
    }

    /// 更新单个 item 的状态与错误说明。
    pub async fn mark_item(
        pool: &SqlitePool,
        batch_id: &str,
        server_id: &str,
        status: &str,
        error: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE agent_upgrade_batch_items
             SET status = ?, error = ?, updated_at = ?
             WHERE batch_id = ? AND server_id = ?",
        )
        .bind(status)
        .bind(error)
        .bind(now())
        .bind(batch_id)
        .bind(server_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// 触发成功后回填 `upgrade_id` 并把 item 置为 running。
    pub async fn start_item(
        pool: &SqlitePool,
        batch_id: &str,
        server_id: &str,
        upgrade_id: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE agent_upgrade_batch_items
             SET status = 'running', upgrade_id = ?, error = '', updated_at = ?
             WHERE batch_id = ? AND server_id = ?",
        )
        .bind(upgrade_id)
        .bind(now())
        .bind(batch_id)
        .bind(server_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// 只回填 `upgrade_id`（item 已经是 running，用于恢复升级记录）。
    pub async fn set_item_upgrade(
        pool: &SqlitePool,
        batch_id: &str,
        server_id: &str,
        upgrade_id: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE agent_upgrade_batch_items
             SET upgrade_id = ?, updated_at = ?
             WHERE batch_id = ? AND server_id = ?",
        )
        .bind(upgrade_id)
        .bind(now())
        .bind(batch_id)
        .bind(server_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// 把剩余的 queued 全部标成 skipped（遇错即停）；返回受影响条数。
    pub async fn skip_queued(
        pool: &SqlitePool,
        batch_id: &str,
        error: &str,
    ) -> anyhow::Result<u64> {
        Ok(sqlx::query(
            "UPDATE agent_upgrade_batch_items
             SET status = 'skipped', error = ?, updated_at = ?
             WHERE batch_id = ? AND status = 'queued'",
        )
        .bind(error)
        .bind(now())
        .bind(batch_id)
        .execute(pool)
        .await?
        .rows_affected())
    }

    /// 取消时把剩余的 queued 全部标成 cancelled；返回受影响条数。
    pub async fn cancel_queued(
        pool: &SqlitePool,
        batch_id: &str,
        error: &str,
    ) -> anyhow::Result<u64> {
        Ok(sqlx::query(
            "UPDATE agent_upgrade_batch_items
             SET status = 'cancelled', error = ?, updated_at = ?
             WHERE batch_id = ? AND status = 'queued'",
        )
        .bind(error)
        .bind(now())
        .bind(batch_id)
        .execute(pool)
        .await?
        .rows_affected())
    }

    pub async fn mark(pool: &SqlitePool, id: &str, status: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE agent_upgrade_batches SET status = ?, updated_at = ? WHERE id = ?")
            .bind(status)
            .bind(now())
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// 还有 queued / running item 的批次（runner 每轮扫这些）。
    ///
    /// 不只看 `status = 'running'`：取消或遇错即停后批次可能已经是终态，
    /// 但仍在跑的 item 必须继续同步，否则会永远停在 running。
    pub async fn active(pool: &SqlitePool) -> anyhow::Result<Vec<AgentUpgradeBatch>> {
        Ok(sqlx::query_as::<_, AgentUpgradeBatch>(
            "SELECT b.* FROM agent_upgrade_batches b
             WHERE EXISTS (
                 SELECT 1 FROM agent_upgrade_batch_items i
                 WHERE i.batch_id = b.id AND i.status IN ('queued', 'running')
             )
             ORDER BY b.created_at ASC, b.rowid ASC",
        )
        .fetch_all(pool)
        .await?)
    }

    /// 出现在任何未终态 item 里的服务器；用于「同一台不能在两个批次里」校验。
    pub async fn busy_server_ids(pool: &SqlitePool) -> anyhow::Result<Vec<String>> {
        Ok(sqlx::query_scalar(
            "SELECT DISTINCT server_id FROM agent_upgrade_batch_items
             WHERE status IN ('queued', 'running')",
        )
        .fetch_all(pool)
        .await?)
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

    /// 节点维度日账本的一行（`node_tag` 定位节点，`user_id` 为空串表示无法归因）。
    #[derive(Debug, Clone, sqlx::FromRow)]
    pub struct NodeDailyRow {
        pub day: String,
        pub server_id: String,
        pub node_tag: String,
        pub user_id: String,
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

    /// 一次节点维度累加的入参。
    ///
    /// `weighted` 必须由调用方用**同一个**已按方向×倍率算好的值传入，这里不再加权；
    /// `user_id` 传 `''` 表示无法归因。
    #[derive(Debug, Clone, Copy)]
    pub struct NodeTrafficDelta<'a> {
        pub node_tag: &'a str,
        pub user_id: &'a str,
        pub uplink: u64,
        pub downlink: u64,
        pub weighted: u64,
    }

    /// 按 (day, server_id, node_tag, user_id) 累加节点维度切片。
    ///
    /// `user_id = ''` 的行仍计入节点总量，但不进用户明细。
    pub async fn accumulate_node_daily(
        pool: &SqlitePool,
        day: &str,
        server_id: &str,
        delta: NodeTrafficDelta<'_>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO traffic_node_daily
                (day, server_id, node_tag, user_id, uplink, downlink, weighted)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(day, server_id, node_tag, user_id) DO UPDATE SET
                uplink = uplink + excluded.uplink,
                downlink = downlink + excluded.downlink,
                weighted = weighted + excluded.weighted",
        )
        .bind(day)
        .bind(server_id)
        .bind(delta.node_tag)
        .bind(delta.user_id)
        .bind(saturating_i64(delta.uplink))
        .bind(saturating_i64(delta.downlink))
        .bind(saturating_i64(delta.weighted))
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn find_node_daily(
        pool: &SqlitePool,
        day: &str,
        server_id: &str,
        node_tag: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<NodeDailyRow>> {
        Ok(sqlx::query_as::<_, NodeDailyRow>(
            "SELECT day, server_id, node_tag, user_id, uplink, downlink, weighted
             FROM traffic_node_daily
             WHERE day = ? AND server_id = ? AND node_tag = ? AND user_id = ?",
        )
        .bind(day)
        .bind(server_id)
        .bind(node_tag)
        .bind(user_id)
        .fetch_optional(pool)
        .await?)
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
        /// 带宽上限（kbps）；`None` / 0 = 不限。
        pub bandwidth_kbps: Option<i64>,
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
        /// `None` = 不改；`Some(0)` = 取消限速。
        pub bandwidth_kbps: Option<i64>,
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
                (id, server_id, tag, name, protocol, transport, security, port, config_json,
                 enabled, cert_id, bandwidth_kbps, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        .bind(input.bandwidth_kbps)
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

    /// 同一服务器上占用该端口的节点（含已停用节点）。
    ///
    /// 转发监听端口不能与节点端口冲突；停用节点也算占用，因为随时可能被重新启用，
    /// 若允许共用端口，恢复节点时才会暴露冲突。
    pub async fn find_by_port(
        pool: &SqlitePool,
        server_id: &str,
        port: i64,
    ) -> anyhow::Result<Option<Node>> {
        Ok(sqlx::query_as::<_, Node>(
            "SELECT * FROM nodes WHERE server_id = ? AND port = ? LIMIT 1",
        )
        .bind(server_id)
        .bind(port)
        .fetch_optional(pool)
        .await?)
    }

    /// 节点总数；公开状态页的 `nodes_total` 用它（不分启用/停用）。
    pub async fn count(pool: &SqlitePool) -> anyhow::Result<i64> {
        Ok(sqlx::query_scalar("SELECT COUNT(*) FROM nodes")
            .fetch_one(pool)
            .await?)
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
                cert_id = CASE WHEN ? THEN ? ELSE cert_id END,
                bandwidth_kbps = COALESCE(?, bandwidth_kbps)
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
        .bind(input.bandwidth_kbps)
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

/// 单跳 TCP 端口转发：规则 CRUD + 心跳运行状态缓存。
///
/// 规则和运行状态分两张表：规则是管理员写的期望态，状态是 Agent 每轮心跳
/// 覆盖的观测值。列表接口在 [`list_with_status`] 里按 `forward_id` 合并。
pub mod forwards {
    use std::collections::HashMap;

    use serde::Serialize;

    use super::*;

    pub struct NewForward {
        pub name: String,
        pub listen_port: i64,
        pub target_host: String,
        pub target_port: i64,
        pub enabled: bool,
        /// 已通过 `engine::normalize` 校验的引擎名（`native` / `realm` / `nftables`）。
        pub engine: String,
        /// 已通过 `protocol::normalize_forward` 校验的协议名（`tcp` / `udp` / `both`）。
        ///
        /// 旧的 `udp` 列由仓储按它同步写成镜像值，只用于兼容旧 API/旧 Agent。
        pub protocol: String,
    }

    #[derive(Default)]
    pub struct UpdateForward {
        pub name: Option<String>,
        pub listen_port: Option<i64>,
        pub target_host: Option<String>,
        pub target_port: Option<i64>,
        pub enabled: Option<bool>,
        /// `None` = 不改；`Some` 必须已通过 `engine::normalize` 校验。
        pub engine: Option<String>,
        /// `None` = 不改；`Some` 必须已通过 `protocol::normalize_forward` 校验。
        /// 改动时仓储会同步旧的 `udp` 镜像列。
        pub protocol: Option<String>,
    }

    /// 心跳里一条转发状态落库前的形态（领域层不依赖 proto）。
    pub struct NewForwardStatus {
        pub forward_id: String,
        pub listening: bool,
        pub error: String,
        /// 目标可达性；`None` = 本轮没探测 / 旧 Agent 没上报。
        pub target_ok: Option<bool>,
        /// 加密链握手失败原因码；`None` = 未探测 / 成功 / 旧 Agent 没上报。
        pub target_error: Option<String>,
        /// 逐目标探测结果；空 = 未探测（存 NULL），不能写成 0ms。
        pub targets: Vec<NewTargetProbe>,
    }

    /// 心跳里一个 target 的探测结果（与线协议的 `TargetProbe` 同形，
    /// 但领域层不依赖 proto，所以单独定义）。
    #[derive(Debug, Clone, Serialize)]
    pub struct NewTargetProbe {
        pub server_id: String,
        pub ok: bool,
        pub latency_ms: Option<u32>,
    }

    pub async fn create(
        pool: &SqlitePool,
        server_id: &str,
        input: NewForward,
    ) -> anyhow::Result<Forward> {
        let id = Uuid::new_v4().to_string();
        let ts = now();
        sqlx::query(
            "INSERT INTO forwards
                (id, server_id, name, listen_port, target_host, target_port, enabled, engine,
                 protocol, udp, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(server_id)
        .bind(input.name.trim())
        .bind(input.listen_port)
        .bind(input.target_host.trim())
        .bind(input.target_port)
        .bind(i64::from(input.enabled))
        .bind(crate::engine::from_db(&input.engine))
        .bind(crate::protocol::from_db(&input.protocol))
        // 旧 udp 列只作镜像：读路径以 protocol 为准。
        .bind(i64::from(crate::protocol::is_both(&input.protocol)))
        .bind(ts)
        .bind(ts)
        .execute(pool)
        .await?;
        find_by_id(pool, &id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("转发规则创建后读取失败"))
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<Forward>> {
        Ok(
            sqlx::query_as::<_, Forward>("SELECT * FROM forwards WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await?,
        )
    }

    pub async fn list_by_server(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Vec<Forward>> {
        Ok(sqlx::query_as::<_, Forward>(
            "SELECT * FROM forwards WHERE server_id = ?
             ORDER BY created_at ASC, rowid ASC",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?)
    }

    /// 期望态只下发启用的规则；排序与列表一致，保证每次渲染结果确定。
    pub async fn list_enabled_by_server(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Vec<Forward>> {
        Ok(sqlx::query_as::<_, Forward>(
            "SELECT * FROM forwards WHERE server_id = ? AND enabled = 1
             ORDER BY created_at ASC, rowid ASC",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?)
    }

    /// 同一服务器上是否已有转发占用该端口。
    ///
    /// `exclude_id` 用于 PATCH：规则自身不算冲突。
    pub async fn find_by_listen_port(
        pool: &SqlitePool,
        server_id: &str,
        listen_port: i64,
        exclude_id: Option<&str>,
    ) -> anyhow::Result<Option<Forward>> {
        Ok(sqlx::query_as::<_, Forward>(
            "SELECT * FROM forwards
             WHERE server_id = ? AND listen_port = ? AND id <> COALESCE(?, '')
             LIMIT 1",
        )
        .bind(server_id)
        .bind(listen_port)
        .bind(exclude_id)
        .fetch_optional(pool)
        .await?)
    }

    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        input: UpdateForward,
    ) -> anyhow::Result<Option<Forward>> {
        let res = sqlx::query(
            "UPDATE forwards SET
                name = COALESCE(?, name),
                listen_port = COALESCE(?, listen_port),
                target_host = COALESCE(?, target_host),
                target_port = COALESCE(?, target_port),
                enabled = COALESCE(?, enabled),
                engine = COALESCE(?, engine),
                protocol = COALESCE(?, protocol),
                udp = COALESCE(?, udp),
                updated_at = ?
             WHERE id = ?",
        )
        .bind(input.name.map(|name| name.trim().to_string()))
        .bind(input.listen_port)
        .bind(input.target_host.map(|host| host.trim().to_string()))
        .bind(input.target_port)
        .bind(input.enabled.map(i64::from))
        .bind(input.engine.as_deref().map(crate::engine::from_db))
        .bind(input.protocol.as_deref().map(crate::protocol::from_db))
        .bind(
            input
                .protocol
                .as_deref()
                .map(|protocol| i64::from(crate::protocol::is_both(protocol))),
        )
        .bind(now())
        .bind(id)
        .execute(pool)
        .await?;

        if res.rows_affected() == 0 {
            return Ok(None);
        }
        find_by_id(pool, id).await
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
        // 同事务清掉运行状态：否则 Agent 长期离线时，删除的规则会在
        // forward_status 里留下永远没人再覆盖的旧行（列表虽然会过滤，但会积灰）。
        let mut tx = pool.begin().await?;
        let res = sqlx::query("DELETE FROM forwards WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM forward_status WHERE forward_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(res.rows_affected() > 0)
    }

    /// 列表 + 心跳状态。状态按 `forward_id` 合并；心跳里没有的规则 `runtime = None`。
    ///
    /// 只 JOIN 内存里的现存规则：规则被删除后，`forward_status` 里可能还有
    /// 一条 Agent 尚未收敛的旧状态，它不会出现在结果里。
    pub async fn list_with_status(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Vec<ForwardView>> {
        let forwards = list_by_server(pool, server_id).await?;
        let statuses = list_status_by_server(pool, server_id).await?;
        let mut by_id: HashMap<String, ForwardStatusRow> = statuses
            .into_iter()
            .map(|status| (status.forward_id.clone(), status))
            .collect();

        Ok(forwards
            .into_iter()
            .map(|forward| {
                // 新 Agent 上报的是期望态 id（`fwd-<uuid>`）；旧 Agent 可能还在报
                // 裸 uuid。两种都要能合并，优先认前缀形式。
                let runtime = by_id
                    .remove(&crate::forwards::desired_id(&forward.id))
                    .or_else(|| by_id.remove(&forward.id))
                    .map(|status| ForwardRuntime {
                        listening: status.listening,
                        error: status.error,
                        target_ok: status.target_ok,
                        target_error: status.target_error,
                        degraded: crate::chains::is_degraded(status.target_fail_count),
                        updated_at: status.updated_at,
                    });
                ForwardView { forward, runtime }
            })
            .collect())
    }

    /// 某台服务器的全部转发运行状态；链视图按 forward_id 合并时也用它。
    pub async fn list_status_by_server(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Vec<ForwardStatusRow>> {
        Ok(sqlx::query_as::<_, ForwardStatusRow>(
            "SELECT * FROM forward_status WHERE server_id = ?",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?)
    }

    /// 用一次心跳里的 `forwards` 整体替换该服务器的状态缓存。
    ///
    /// 整体替换而不是 upsert：Agent 已经从期望态里删掉的规则不会再上报，
    /// 只有先 DELETE 才能把上一轮的旧状态清掉。事务保证读不到中间态。
    ///
    /// `target_fail_count` 是**连续** false 的计数：本轮 `Some(false)` 在上一轮
    /// 计数上 +1，其余情况（`Some(true)` / `None`）一律清零。
    pub async fn save_status(
        pool: &SqlitePool,
        server_id: &str,
        statuses: &[NewForwardStatus],
    ) -> anyhow::Result<()> {
        // 先读出上一轮计数，再整体删除；否则「连续」信息会随 DELETE 一起丢掉。
        let previous: HashMap<String, i64> = sqlx::query_as::<_, (String, i64)>(
            "SELECT forward_id, target_fail_count FROM forward_status WHERE server_id = ?",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();

        let ts = now();
        let mut tx = pool.begin().await?;
        sqlx::query("DELETE FROM forward_status WHERE server_id = ?")
            .bind(server_id)
            .execute(&mut *tx)
            .await?;
        for status in statuses {
            let fail_count = if status.target_ok == Some(false) {
                previous.get(&status.forward_id).copied().unwrap_or(0) + 1
            } else {
                0
            };
            // 空数组 = 本轮没探测：存 NULL，读路径保持「无数据」而不是「0ms」。
            let targets_json = if status.targets.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&status.targets)?)
            };
            sqlx::query(
                "INSERT INTO forward_status
                    (server_id, forward_id, listening, error, target_ok, target_error,
                     target_fail_count, targets_json, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(server_id, forward_id) DO UPDATE SET
                    listening = excluded.listening,
                    error = excluded.error,
                    target_ok = excluded.target_ok,
                    target_error = excluded.target_error,
                    target_fail_count = excluded.target_fail_count,
                    targets_json = excluded.targets_json,
                    updated_at = excluded.updated_at",
            )
            .bind(server_id)
            .bind(&status.forward_id)
            .bind(i64::from(status.listening))
            .bind(&status.error)
            .bind(status.target_ok)
            .bind(&status.target_error)
            .bind(fail_count)
            .bind(&targets_json)
            .bind(ts)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

/// 线性多跳链：组的 CRUD + 端口冲突查询。
///
/// 链只是「组/成员的配置」；期望态由 master 用 groups + 服务器 address
/// 推导成每台服务器上的 `DesiredForward`，存储层不负责推导。
///
/// 读接口总是把成员按 `priority ASC, rowid ASC` 排好：priority 小的优先（主备），
/// 同优先级保持创建顺序（轮询）。推导层直接复用这个顺序，不再二次排序。
pub mod chains {
    use std::collections::HashMap;

    use super::*;

    pub struct NewChainGroupMember {
        pub server_id: String,
        pub listen_port: i64,
        pub priority: i64,
        pub weight: i64,
    }

    pub struct NewChainGroup {
        pub name: Option<String>,
        /// 规范化的 snake_case 策略串（`round_robin` 等）。
        pub strategy: String,
        /// 该组监听证书 id；入口组（seq = 0）必须为 `None`。
        pub cert_id: Option<String>,
        pub members: Vec<NewChainGroupMember>,
    }

    pub struct NewChain {
        pub name: String,
        pub target_host: String,
        pub target_port: i64,
        pub enabled: bool,
        /// 已通过 `engine::normalize` 校验的引擎名（`native` / `realm` / `nftables`）。
        pub engine: String,
        /// 已通过 `protocol::normalize_chain` 校验的协议名（`tcp` / `udp` / `both`）。
        ///
        /// 旧的 `udp` 列由仓储按它同步写成镜像值，只用于兼容旧 API/旧 Agent。
        pub protocol: String,
        /// 已通过 `hop_transport::normalize` 校验的加密模式（`none` / `tls`）。
        pub transport: String,
        pub groups: Vec<NewChainGroup>,
    }

    #[derive(Default)]
    pub struct UpdateChain {
        pub name: Option<String>,
        pub target_host: Option<String>,
        pub target_port: Option<i64>,
        pub enabled: Option<bool>,
        /// `None` = 不改；`Some` 必须已通过 `engine::normalize` 校验。
        pub engine: Option<String>,
        /// `None` = 不改；`Some` 必须已通过 `protocol::normalize_chain` 校验。
        /// 改动时仓储会同步旧的 `udp` 镜像列。
        pub protocol: Option<String>,
        /// `None` = 不改；`Some` 必须已通过 `hop_transport::normalize` 校验。
        pub transport: Option<String>,
        /// `None` = 不改组；`Some` = 整体替换。
        pub groups: Option<Vec<NewChainGroup>>,
    }

    async fn load_groups(
        pool: &SqlitePool,
        chain_id: &str,
    ) -> anyhow::Result<Vec<ChainGroupWithMembers>> {
        let groups = sqlx::query_as::<_, ChainGroup>(
            "SELECT id, chain_id, seq, name, strategy, cert_id
             FROM chain_groups
             WHERE chain_id = ?
             ORDER BY seq ASC, rowid ASC",
        )
        .bind(chain_id)
        .fetch_all(pool)
        .await?;
        if groups.is_empty() {
            return Ok(Vec::new());
        }

        let members = sqlx::query_as::<_, ChainGroupMember>(
            "SELECT m.group_id, g.chain_id, g.seq, g.strategy,
                    m.server_id, s.name AS server_name, s.address AS server_address,
                    m.listen_port, m.priority, m.weight, s.realm_transport,
                    s.nftables_available
             FROM chain_group_members m
             JOIN chain_groups g ON g.id = m.group_id
             JOIN servers s ON s.id = m.server_id
             WHERE g.chain_id = ?
             ORDER BY g.seq ASC, m.priority ASC, m.rowid ASC",
        )
        .bind(chain_id)
        .fetch_all(pool)
        .await?;

        let mut by_group: HashMap<String, Vec<ChainGroupMember>> = HashMap::new();
        for member in members {
            by_group
                .entry(member.group_id.clone())
                .or_default()
                .push(member);
        }

        Ok(groups
            .into_iter()
            .map(|group| ChainGroupWithMembers {
                members: by_group.remove(&group.id).unwrap_or_default(),
                group,
            })
            .collect())
    }

    async fn assemble(pool: &SqlitePool, chain: Chain) -> anyhow::Result<ChainWithGroups> {
        let groups = load_groups(pool, &chain.id).await?;
        Ok(ChainWithGroups { chain, groups })
    }

    /// 在一个事务连接里写入全部组和成员（调用方负责先清空旧组）。
    async fn insert_groups(
        conn: &mut sqlx::SqliteConnection,
        chain_id: &str,
        groups: &[NewChainGroup],
    ) -> anyhow::Result<()> {
        for (seq, group) in groups.iter().enumerate() {
            let group_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO chain_groups (id, chain_id, seq, name, strategy, cert_id)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&group_id)
            .bind(chain_id)
            .bind(seq as i64)
            .bind(group.name.as_deref())
            .bind(&group.strategy)
            .bind(group.cert_id.as_deref())
            .execute(&mut *conn)
            .await?;

            for member in &group.members {
                sqlx::query(
                    "INSERT INTO chain_group_members
                        (group_id, server_id, listen_port, priority, weight)
                     VALUES (?, ?, ?, ?, ?)",
                )
                .bind(&group_id)
                .bind(&member.server_id)
                .bind(member.listen_port)
                .bind(member.priority)
                .bind(member.weight)
                .execute(&mut *conn)
                .await?;
            }
        }
        Ok(())
    }

    pub async fn create(pool: &SqlitePool, input: NewChain) -> anyhow::Result<ChainWithGroups> {
        let id = Uuid::new_v4().to_string();
        let ts = now();
        let mut tx = pool.begin().await?;
        sqlx::query(
            "INSERT INTO chains
                (id, name, target_host, target_port, enabled, engine, protocol, udp, transport,
                 created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(input.name.trim())
        .bind(input.target_host.trim())
        .bind(input.target_port)
        .bind(i64::from(input.enabled))
        .bind(crate::engine::from_db(&input.engine))
        .bind(crate::protocol::from_db(&input.protocol))
        // 旧 udp 列只作镜像：读路径以 protocol 为准。
        .bind(i64::from(crate::protocol::is_both(&input.protocol)))
        .bind(crate::hop_transport::from_db(&input.transport))
        .bind(ts)
        .bind(ts)
        .execute(&mut *tx)
        .await?;
        insert_groups(&mut tx, &id, &input.groups).await?;
        tx.commit().await?;
        find_by_id(pool, &id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("链创建后读取失败"))
    }

    pub async fn find_by_id(
        pool: &SqlitePool,
        id: &str,
    ) -> anyhow::Result<Option<ChainWithGroups>> {
        let chain = sqlx::query_as::<_, Chain>("SELECT * FROM chains WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
        match chain {
            Some(chain) => Ok(Some(assemble(pool, chain).await?)),
            None => Ok(None),
        }
    }

    async fn list_where(
        pool: &SqlitePool,
        enabled_only: bool,
    ) -> anyhow::Result<Vec<ChainWithGroups>> {
        let sql = if enabled_only {
            "SELECT * FROM chains WHERE enabled = 1 ORDER BY created_at ASC, rowid ASC"
        } else {
            "SELECT * FROM chains ORDER BY created_at ASC, rowid ASC"
        };
        let chains = sqlx::query_as::<_, Chain>(sql).fetch_all(pool).await?;
        let mut items = Vec::with_capacity(chains.len());
        for chain in chains {
            items.push(assemble(pool, chain).await?);
        }
        Ok(items)
    }

    pub async fn list(pool: &SqlitePool) -> anyhow::Result<Vec<ChainWithGroups>> {
        list_where(pool, false).await
    }

    /// 期望态只推导启用的链。
    pub async fn list_enabled(pool: &SqlitePool) -> anyhow::Result<Vec<ChainWithGroups>> {
        list_where(pool, true).await
    }

    /// 概览用：与链列表同口径的 blocked 链数。
    ///
    /// 口径完全走 [`crate::chains::blocked_reason`]：证书过期 / 能力不足等
    /// **配置层面整链无法下发**才算 blocked；`listening = 0` 是运行态健康，
    /// 不计入（与链列表一致）。
    ///
    /// 固定 3 条 SQL（链 / 组 / 成员）+ 最多 1 条证书批量查询，查询次数与链
    /// 数量无关，不存在 N+1；没有链时只发 1 条查询直接返回 0。
    pub async fn count_blocked(pool: &SqlitePool, now: i64) -> anyhow::Result<i64> {
        let chains =
            sqlx::query_as::<_, Chain>("SELECT * FROM chains ORDER BY created_at ASC, rowid ASC")
                .fetch_all(pool)
                .await?;
        if chains.is_empty() {
            return Ok(0);
        }

        let mut groups = load_all_groups(pool).await?;
        let chains_list: Vec<ChainWithGroups> = chains
            .into_iter()
            .map(|chain| ChainWithGroups {
                groups: groups.remove(&chain.id).unwrap_or_default(),
                chain,
            })
            .collect();
        Ok(blocked_reasons(pool, &chains_list, now).await?.len() as i64)
    }

    /// 批量算出哪些链 blocked，返回 `chain_id -> 原因`。
    ///
    /// 链列表与概览计数都调用它；证书用一次 `IN (...)` 查完，禁止在循环里
    /// 按链查库。未 blocked 的链不出现在结果里。
    pub async fn blocked_reasons(
        pool: &SqlitePool,
        chains_list: &[ChainWithGroups],
        now: i64,
    ) -> anyhow::Result<HashMap<String, crate::chains::BlockedReason>> {
        let cert_ids: Vec<String> = chains_list
            .iter()
            .flat_map(|chain| chain.groups.iter())
            .filter_map(|group| group.group.cert_id.clone())
            .collect();
        let certificates = super::certificates::find_by_ids(pool, &cert_ids).await?;
        let by_id: HashMap<&str, &Certificate> = certificates
            .iter()
            .map(|cert| (cert.id.as_str(), cert))
            .collect();

        Ok(chains_list
            .iter()
            .filter_map(|chain| {
                crate::chains::blocked_reason(&chain.chain, &chain.groups, &by_id, now)
                    .map(|reason| (chain.chain.id.clone(), reason))
            })
            .collect())
    }

    /// 一次性读出所有链的组与成员：概览计数专用，避免逐链查库。
    ///
    /// 成员按 `priority ASC, rowid ASC` 排好，与 [`load_groups`] 的读接口一致，
    /// 后续判定即使只用到成员数/能力字段，也不会出现两种顺序。
    async fn load_all_groups(
        pool: &SqlitePool,
    ) -> anyhow::Result<HashMap<String, Vec<ChainGroupWithMembers>>> {
        let groups = sqlx::query_as::<_, ChainGroup>(
            "SELECT id, chain_id, seq, name, strategy, cert_id
             FROM chain_groups
             ORDER BY chain_id ASC, seq ASC, rowid ASC",
        )
        .fetch_all(pool)
        .await?;
        if groups.is_empty() {
            return Ok(HashMap::new());
        }

        let members = sqlx::query_as::<_, ChainGroupMember>(
            "SELECT m.group_id, g.chain_id, g.seq, g.strategy,
                    m.server_id, s.name AS server_name, s.address AS server_address,
                    m.listen_port, m.priority, m.weight, s.realm_transport,
                    s.nftables_available
             FROM chain_group_members m
             JOIN chain_groups g ON g.id = m.group_id
             JOIN servers s ON s.id = m.server_id
             ORDER BY g.chain_id ASC, g.seq ASC, m.priority ASC, m.rowid ASC",
        )
        .fetch_all(pool)
        .await?;

        let mut by_group: HashMap<String, Vec<ChainGroupMember>> = HashMap::new();
        for member in members {
            by_group
                .entry(member.group_id.clone())
                .or_default()
                .push(member);
        }

        let mut by_chain: HashMap<String, Vec<ChainGroupWithMembers>> = HashMap::new();
        for group in groups {
            let members = by_group.remove(&group.id).unwrap_or_default();
            by_chain
                .entry(group.chain_id.clone())
                .or_default()
                .push(ChainGroupWithMembers { group, members });
        }
        Ok(by_chain)
    }

    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        input: UpdateChain,
    ) -> anyhow::Result<Option<ChainWithGroups>> {
        let mut tx = pool.begin().await?;
        let res = sqlx::query(
            "UPDATE chains SET
                name = COALESCE(?, name),
                target_host = COALESCE(?, target_host),
                target_port = COALESCE(?, target_port),
                enabled = COALESCE(?, enabled),
                engine = COALESCE(?, engine),
                protocol = COALESCE(?, protocol),
                udp = COALESCE(?, udp),
                transport = COALESCE(?, transport),
                updated_at = ?
             WHERE id = ?",
        )
        .bind(input.name.map(|name| name.trim().to_string()))
        .bind(input.target_host.map(|host| host.trim().to_string()))
        .bind(input.target_port)
        .bind(input.enabled.map(i64::from))
        .bind(input.engine.as_deref().map(crate::engine::from_db))
        .bind(input.protocol.as_deref().map(crate::protocol::from_db))
        .bind(
            input
                .protocol
                .as_deref()
                .map(|protocol| i64::from(crate::protocol::is_both(protocol))),
        )
        .bind(
            input
                .transport
                .as_deref()
                .map(crate::hop_transport::from_db),
        )
        .bind(now())
        .bind(id)
        .execute(&mut *tx)
        .await?;
        if res.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(None);
        }

        if let Some(groups) = input.groups {
            sqlx::query("DELETE FROM chain_groups WHERE chain_id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            insert_groups(&mut tx, id, &groups).await?;
        }
        tx.commit().await?;
        find_by_id(pool, id).await
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
        // 链删除后 Agent 可能还在线也可能离线；顺手清掉它推导出的状态行，
        // 否则离线机器的 forward_status 里会留下永远没人覆盖的 `chain-<id>-*`。
        let mut tx = pool.begin().await?;
        let res = sqlx::query("DELETE FROM chains WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM forward_status WHERE forward_id LIKE ?")
            .bind(format!("chain-{id}-%"))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(res.rows_affected() > 0)
    }

    /// 另一条链是否已经占用了这台服务器的这个监听端口（成员端口，不是组端口）。
    ///
    /// `exclude_chain_id` 用于 PATCH：链自己的成员不算冲突。
    pub async fn find_member_port_conflict(
        pool: &SqlitePool,
        server_id: &str,
        listen_port: i64,
        exclude_chain_id: Option<&str>,
    ) -> anyhow::Result<Option<ChainMemberPortConflict>> {
        Ok(sqlx::query_as::<_, ChainMemberPortConflict>(
            "SELECT g.chain_id, c.name AS chain_name, g.seq, m.listen_port
             FROM chain_group_members m
             JOIN chain_groups g ON g.id = m.group_id
             JOIN chains c ON c.id = g.chain_id
             WHERE m.server_id = ? AND m.listen_port = ?
               AND g.chain_id <> COALESCE(?, '')
             ORDER BY g.seq ASC
             LIMIT 1",
        )
        .bind(server_id)
        .bind(listen_port)
        .bind(exclude_chain_id)
        .fetch_optional(pool)
        .await?)
    }
}

/// 自定义出站：CRUD + 按服务器列表。
///
/// 排序口径固定为 `created_at, rowid`：配置生成要求「按创建顺序」，
/// 同一秒创建的多行再由 rowid 兜底，保证每次渲染顺序一致。
pub mod outbounds {
    use super::*;

    pub struct NewOutbound {
        pub tag: String,
        pub protocol: String,
        pub config_json: String,
        pub enabled: bool,
    }

    #[derive(Default)]
    pub struct UpdateOutbound {
        pub tag: Option<String>,
        pub protocol: Option<String>,
        pub config_json: Option<String>,
        pub enabled: Option<bool>,
    }

    pub async fn create(
        pool: &SqlitePool,
        server_id: &str,
        input: NewOutbound,
    ) -> anyhow::Result<Outbound> {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO server_outbounds
                (id, server_id, tag, protocol, config_json, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(server_id)
        .bind(input.tag.trim())
        .bind(input.protocol.trim().to_ascii_lowercase())
        .bind(&input.config_json)
        .bind(i64::from(input.enabled))
        .bind(now())
        .execute(pool)
        .await?;
        find_by_id(pool, &id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("出站创建后读取失败"))
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<Outbound>> {
        Ok(
            sqlx::query_as::<_, Outbound>("SELECT * FROM server_outbounds WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await?,
        )
    }

    pub async fn list_by_server(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Vec<Outbound>> {
        Ok(sqlx::query_as::<_, Outbound>(
            "SELECT * FROM server_outbounds WHERE server_id = ?
             ORDER BY created_at ASC, rowid ASC",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?)
    }

    /// 只返回启用的出站；配置生成按这个顺序追加到内置出站之后。
    pub async fn list_enabled_by_server(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Vec<Outbound>> {
        Ok(sqlx::query_as::<_, Outbound>(
            "SELECT * FROM server_outbounds WHERE server_id = ? AND enabled = 1
             ORDER BY created_at ASC, rowid ASC",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?)
    }

    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        input: UpdateOutbound,
    ) -> anyhow::Result<Option<Outbound>> {
        let res = sqlx::query(
            "UPDATE server_outbounds SET
                tag = COALESCE(?, tag),
                protocol = COALESCE(?, protocol),
                config_json = COALESCE(?, config_json),
                enabled = COALESCE(?, enabled)
             WHERE id = ?",
        )
        .bind(input.tag.map(|tag| tag.trim().to_string()))
        .bind(
            input
                .protocol
                .map(|protocol| protocol.trim().to_ascii_lowercase()),
        )
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
        let res = sqlx::query("DELETE FROM server_outbounds WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }
}

/// 路由规则：CRUD + 按服务器列表 + 出站引用统计。
pub mod routing_rules {
    use super::*;

    pub struct NewRoutingRule {
        pub sort_order: i64,
        pub inbound_tag: Option<String>,
        pub domain: Option<String>,
        pub ip: Option<String>,
        pub outbound_tag: String,
        pub enabled: bool,
    }

    #[derive(Default)]
    pub struct UpdateRoutingRule {
        pub sort_order: Option<i64>,
        /// 三态：缺失 = 不改，`Null` = 清空，`Value` = 设置。
        pub inbound_tag: Patch<String>,
        pub domain: Patch<String>,
        pub ip: Patch<String>,
        pub outbound_tag: Option<String>,
        pub enabled: Option<bool>,
    }

    pub async fn create(
        pool: &SqlitePool,
        server_id: &str,
        input: NewRoutingRule,
    ) -> anyhow::Result<RoutingRule> {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO server_routing_rules
                (id, server_id, sort_order, inbound_tag, domain, ip, outbound_tag, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(server_id)
        .bind(input.sort_order)
        .bind(&input.inbound_tag)
        .bind(&input.domain)
        .bind(&input.ip)
        .bind(input.outbound_tag.trim())
        .bind(i64::from(input.enabled))
        .bind(now())
        .execute(pool)
        .await?;
        find_by_id(pool, &id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("路由规则创建后读取失败"))
    }

    pub async fn find_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<RoutingRule>> {
        Ok(
            sqlx::query_as::<_, RoutingRule>("SELECT * FROM server_routing_rules WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await?,
        )
    }

    pub async fn list_by_server(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Vec<RoutingRule>> {
        Ok(sqlx::query_as::<_, RoutingRule>(
            "SELECT * FROM server_routing_rules WHERE server_id = ?
             ORDER BY sort_order ASC, created_at ASC, rowid ASC",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?)
    }

    /// 配置生成只取启用的规则，顺序与列表一致。
    pub async fn list_enabled_by_server(
        pool: &SqlitePool,
        server_id: &str,
    ) -> anyhow::Result<Vec<RoutingRule>> {
        Ok(sqlx::query_as::<_, RoutingRule>(
            "SELECT * FROM server_routing_rules WHERE server_id = ? AND enabled = 1
             ORDER BY sort_order ASC, created_at ASC, rowid ASC",
        )
        .bind(server_id)
        .fetch_all(pool)
        .await?)
    }

    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        input: UpdateRoutingRule,
    ) -> anyhow::Result<Option<RoutingRule>> {
        let res = sqlx::query(
            "UPDATE server_routing_rules SET
                sort_order = COALESCE(?, sort_order),
                inbound_tag = CASE WHEN ? THEN ? ELSE inbound_tag END,
                domain = CASE WHEN ? THEN ? ELSE domain END,
                ip = CASE WHEN ? THEN ? ELSE ip END,
                outbound_tag = COALESCE(?, outbound_tag),
                enabled = COALESCE(?, enabled)
             WHERE id = ?",
        )
        .bind(input.sort_order)
        .bind(i64::from(input.inbound_tag.is_set()))
        .bind(input.inbound_tag.value())
        .bind(i64::from(input.domain.is_set()))
        .bind(input.domain.value())
        .bind(i64::from(input.ip.is_set()))
        .bind(input.ip.value())
        .bind(input.outbound_tag.map(|tag| tag.trim().to_string()))
        .bind(input.enabled.map(i64::from))
        .bind(id)
        .execute(pool)
        .await?;

        if res.rows_affected() == 0 {
            return Ok(None);
        }
        find_by_id(pool, id).await
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
        let res = sqlx::query("DELETE FROM server_routing_rules WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// 该服务器下有多少条规则（含已停用的）指向这个出站 tag。
    ///
    /// 删除出站前用它给出「被 N 条规则引用」的中文提示；停用的规则也算引用，
    /// 因为重新启用后会立刻变成悬挂引用。
    pub async fn count_by_outbound(
        pool: &SqlitePool,
        server_id: &str,
        outbound_tag: &str,
    ) -> anyhow::Result<i64> {
        Ok(sqlx::query_scalar(
            "SELECT COUNT(*) FROM server_routing_rules
             WHERE server_id = ? AND outbound_tag = ?",
        )
        .bind(server_id)
        .bind(outbound_tag)
        .fetch_one(pool)
        .await?)
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
        /// 限速档位（kbps）；`None` / 0 = 不限。
        pub speed_limit_kbps: Option<i64>,
        /// 套餐级规则模板绑定；`None` = 不绑定（跟随全局默认）。
        pub rule_template_id: Option<String>,
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
        /// 缺失 = 不改；`Patch::Null` = 取消限速；`Patch::Value` = 档位 kbps。
        pub speed_limit_kbps: Patch<i64>,
        /// 缺失 = 不改；`Patch::Null` = 解绑；`Patch::Value` = 绑定。
        pub rule_template_id: Patch<String>,
        /// 节点范围三态：缺失 = 不动；`Null` = 恢复全部；`Value([])` = 一个都不给。
        pub node_ids: Patch<Vec<String>>,
    }

    pub async fn create(pool: &SqlitePool, input: NewPackage) -> anyhow::Result<Package> {
        let id = Uuid::new_v4().to_string();
        let mut tx = pool.begin().await?;
        sqlx::query(
            "INSERT INTO packages
                (id, name, quota_bytes, period_days, direction, node_ratio, speed_limit_kbps,
                 rule_template_id, created_at, node_scope_explicit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&input.name)
        .bind(input.quota_bytes)
        .bind(input.period_days)
        .bind(&input.direction)
        .bind(input.node_ratio)
        .bind(input.speed_limit_kbps)
        .bind(input.rule_template_id)
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
            package.node_scope = if explicit { "custom" } else { "all" }.to_string();
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
                    p.speed_limit_kbps, p.rule_template_id, p.created_at, COUNT(up.id) AS user_count
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
        let speed_limit_set = input.speed_limit_kbps.is_set();
        let speed_limit = input.speed_limit_kbps.value();
        let rule_set = input.rule_template_id.is_set();
        let rule = input.rule_template_id.value();
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
                speed_limit_kbps = CASE WHEN ? THEN ? ELSE speed_limit_kbps END,
                rule_template_id = CASE WHEN ? THEN ? ELSE rule_template_id END,
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
        .bind(speed_limit_set)
        .bind(speed_limit)
        .bind(rule_set)
        .bind(rule)
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

    /// 每个用户「当前套餐」的规则模板绑定。
    ///
    /// 当前套餐 = 最近一次绑定的、未过期的实例；多个实例按创建时间取最新一条
    /// （同秒创建时用 rowid 兜底）。当前实例没有绑定（或绑定列被 SET NULL）时
    /// 不返回该用户，调用方按「未绑定套餐」继续回落到全局默认。
    pub async fn current_rule_template_ids(
        pool: &SqlitePool,
        user_ids: &[String],
    ) -> anyhow::Result<HashMap<String, String>> {
        if user_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let now = super::now();
        let mut builder = QueryBuilder::new(
            "SELECT user_id, rule_template_id FROM (
                SELECT up.user_id AS user_id,
                       p.rule_template_id AS rule_template_id,
                       ROW_NUMBER() OVER (
                           PARTITION BY up.user_id
                           ORDER BY up.created_at DESC, up.rowid DESC
                       ) AS rn
                FROM user_packages up
                JOIN packages p ON p.id = up.package_id
                WHERE up.status = 'active'
                  AND (up.expires_at IS NULL OR up.expires_at > ",
        );
        builder.push_bind(now);
        builder.push(") AND up.user_id IN (");
        let mut separated = builder.separated(", ");
        for user_id in user_ids {
            separated.push_bind(user_id.clone());
        }
        separated.push_unseparated(")) WHERE rn = 1 AND rule_template_id IS NOT NULL");
        let rows = builder
            .build_query_as::<(String, String)>()
            .fetch_all(pool)
            .await?;
        Ok(rows.into_iter().collect())
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
        /// 该用户在该节点上的近似限速档位（kbps）；`None` = 不限。
        ///
        /// 同一用户可能有多张可用套餐都覆盖这个节点，取**最严格**的一档
        /// （最小的正数）；全部不限时才为 `None`。
        pub speed_limit_kbps: Option<i64>,
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
        speed_limit_kbps: Option<i64>,
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
                    up.used_bytes,
                    p.speed_limit_kbps
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
        let mut seen: std::collections::HashMap<(String, String), usize> =
            std::collections::HashMap::new();
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
            let key = (row.user_id.clone(), row.node_id.clone());
            let limit = row.speed_limit_kbps.filter(|kbps| *kbps > 0);
            if let Some(&index) = seen.get(&key) {
                // 多张卡都覆盖同一节点时取最严格的一档，避免「贵的卡被便宜卡放松」。
                let existing: &mut EligiblePair = &mut pairs[index];
                existing.speed_limit_kbps = strictest_limit(existing.speed_limit_kbps, limit);
                continue;
            }
            seen.insert(key, pairs.len());
            pairs.push(EligiblePair {
                user_id: row.user_id,
                node_id: row.node_id,
                speed_limit_kbps: limit,
            });
        }
        Ok(pairs)
    }

    /// 两档限速取更严格的一档：`None` 表示不限，任何正数都比 `None` 严格。
    fn strictest_limit(a: Option<i64>, b: Option<i64>) -> Option<i64> {
        match (a, b) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        }
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

    /// 单个用户自己的断流/恢复事件（用户自助页用）。
    ///
    /// 过滤条件只有 `user_id = ?`：调用方必须传会话用户，绝不能把请求参数透传进来。
    pub async fn list_events_for_user(
        pool: &SqlitePool,
        user_id: &str,
        limit: i64,
    ) -> anyhow::Result<Vec<EnforcementEvent>> {
        Ok(sqlx::query_as::<_, EnforcementEvent>(
            "SELECT id, kind, user_id, username, server_id, server_name, reason, message, created_at
             FROM enforcement_events
             WHERE user_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?",
        )
        .bind(user_id)
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

    /// 仍被多少个链组引用（`chain_groups.cert_id`）。删除证书前必须一起检查，
    /// 否则删完下一次 apply 会因为「组缺证书」把整条 TLS 链停掉。
    pub async fn count_chain_references(pool: &SqlitePool, id: &str) -> anyhow::Result<i64> {
        Ok(
            sqlx::query_scalar("SELECT COUNT(*) FROM chain_groups WHERE cert_id = ?")
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

/// 探针采样：把 `servers` 的当前状态与健康字段按 5 分钟粒度落成历史。
///
/// 这里只负责「抄一份 + 按窗口聚合」，不判断公开页是否开启（那是接口层的事）。
/// 采样时间由调用方传入，调度器与测试共用同一套逻辑。
pub mod server_samples {
    use super::*;

    /// 采样粒度：5 分钟。
    pub const SAMPLE_INTERVAL_SECS: i64 = 300;
    /// 采样保留 7 天；每轮写入时顺带清掉更早的行。
    pub const RETENTION_SECS: i64 = 7 * 86_400;

    /// 一轮采样的结果，便于调度器记日志与测试断言。
    #[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
    pub struct SampleRound {
        /// 写入（或覆盖）的服务器行数。
        pub recorded: u64,
        /// 清理掉的过期行数。
        pub pruned: u64,
    }

    /// 把时间对齐到 5 分钟整点。
    ///
    /// 调度器启动/重启时刻不一定落在整 5 分钟上，对齐后同一时间窗只会有一行；
    /// 重复执行用 upsert 覆盖，不会把可用率的分母算重。
    pub fn align_ts(ts: i64) -> i64 {
        ts - ts.rem_euclid(SAMPLE_INTERVAL_SECS)
    }

    /// 写一轮采样并清理 7 天前的行。
    ///
    /// 数据来自 `servers` 的当前状态：离线服务器也会写 `online = 0`，
    /// 否则离线时段不进入分母，可用率会永远显示 100%。
    pub async fn record_round(pool: &SqlitePool, now: i64) -> anyhow::Result<SampleRound> {
        let ts = align_ts(now);
        let mut tx = pool.begin().await?;

        let recorded = sqlx::query(
            "INSERT INTO server_samples
                (server_id, ts, online, load1, mem_used, mem_total, disk_used, disk_total,
                 latency_ms)
             SELECT id, ?, CASE WHEN status = 'online' THEN 1 ELSE 0 END,
                    COALESCE(load1, 0), COALESCE(mem_used, 0), COALESCE(mem_total, 0),
                    COALESCE(disk_used, 0), COALESCE(disk_total, 0), latency_ms
             FROM servers
             WHERE true
             ON CONFLICT(server_id, ts) DO UPDATE SET
                online = excluded.online,
                load1 = excluded.load1,
                mem_used = excluded.mem_used,
                mem_total = excluded.mem_total,
                disk_used = excluded.disk_used,
                disk_total = excluded.disk_total,
                latency_ms = excluded.latency_ms",
        )
        .bind(ts)
        .execute(&mut *tx)
        .await?
        .rows_affected();

        let pruned = sqlx::query("DELETE FROM server_samples WHERE ts < ?")
            .bind(ts - RETENTION_SECS)
            .execute(&mut *tx)
            .await?
            .rows_affected();

        tx.commit().await?;
        Ok(SampleRound { recorded, pruned })
    }

    /// 某台服务器自 `since` 起的采样，按时间升序（测试与排障用）。
    pub async fn list(
        pool: &SqlitePool,
        server_id: &str,
        since: i64,
    ) -> anyhow::Result<Vec<ServerSample>> {
        Ok(sqlx::query_as::<_, ServerSample>(
            "SELECT * FROM server_samples
             WHERE server_id = ? AND ts >= ?
             ORDER BY ts ASC",
        )
        .bind(server_id)
        .bind(since)
        .fetch_all(pool)
        .await?)
    }

    /// 所有服务器在 24h / 7d 窗口内的可用率（0..1）；没有采样的服务器不会出现在结果里。
    pub async fn uptime_all(pool: &SqlitePool, now: i64) -> anyhow::Result<Vec<ServerUptime>> {
        Ok(sqlx::query_as::<_, ServerUptime>(
            "SELECT server_id,
                    AVG(CASE WHEN ts >= ? THEN online END) AS uptime_24h,
                    AVG(online) AS uptime_7d
             FROM server_samples
             WHERE ts >= ? AND ts <= ?
             GROUP BY server_id",
        )
        .bind(now - 86_400)
        .bind(now - RETENTION_SECS)
        .bind(now)
        .fetch_all(pool)
        .await?)
    }

    /// `[since, until)` 内按小时聚合的在线比例，只返回有采样的 (server, 小时)。
    pub async fn hourly_buckets(
        pool: &SqlitePool,
        since: i64,
        until: i64,
    ) -> anyhow::Result<Vec<ServerHourlyBucket>> {
        Ok(sqlx::query_as::<_, ServerHourlyBucket>(
            "SELECT server_id,
                    (ts / 3600) * 3600 AS ts,
                    AVG(online) AS online_ratio
             FROM server_samples
             WHERE ts >= ? AND ts < ?
             GROUP BY server_id, (ts / 3600) * 3600",
        )
        .bind(since)
        .bind(until)
        .fetch_all(pool)
        .await?)
    }
}

pub mod stats {
    use std::collections::HashMap;

    use super::*;

    /// 公开状态页的汇总：只查可公开的数字，不触碰用户/套餐/证书表。
    pub async fn public_summary(pool: &SqlitePool, now: i64) -> anyhow::Result<PublicSummary> {
        let (servers_total, servers_online): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END), 0)
             FROM servers",
        )
        .fetch_one(pool)
        .await?;

        let nodes_total = super::nodes::count(pool).await?;

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

        Ok(PublicSummary {
            servers_total,
            servers_online,
            nodes_total,
            traffic_today: today_bytes,
            traffic_month: month_bytes,
        })
    }

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

    /// 节点维度流量：`days` 窗口内按节点汇总，按 `weighted` 降序。
    ///
    /// 节点由 `(server_id, node_tag)` 定位——tag 只在单个服务器内唯一，必须 JOIN
    /// `nodes` 的复合唯一键。节点删除后 `traffic_node_daily` 里的历史行仍在，
    /// 但 JOIN 不到就不再出现在这里（总量仍由 `traffic_daily` 兜底）。
    pub async fn node_traffic(
        pool: &SqlitePool,
        now: i64,
        days: i64,
        server_id: Option<&str>,
    ) -> anyhow::Result<Vec<NodeTrafficRow>> {
        let days = days.clamp(1, 90);
        let (start_date, end_date) = day_window(now, days);
        let today = crate::time::business_date(now);
        let (month_start, month_end) = crate::time::business_month_bounds(now);
        // 今日/本月要覆盖窗口以外的本月数据，所以扫描下界取两者更早的那个。
        let scan_from = start_date.as_str().min(month_start.as_str());
        let rows = sqlx::query_as::<_, NodeTrafficRow>(
            "SELECT n.id AS node_id, n.tag AS node_tag, n.name AS name,
                    n.server_id AS server_id, s.name AS server_name,
                    n.protocol AS protocol, n.transport AS transport, n.security AS security,
                    COALESCE(SUM(CASE WHEN t.day >= ? AND t.day <= ? THEN t.uplink ELSE 0 END), 0)
                        AS uplink,
                    COALESCE(SUM(CASE WHEN t.day >= ? AND t.day <= ? THEN t.downlink ELSE 0 END), 0)
                        AS downlink,
                    COALESCE(SUM(CASE WHEN t.day >= ? AND t.day <= ? THEN t.weighted ELSE 0 END), 0)
                        AS weighted,
                    COALESCE(SUM(CASE WHEN t.day = ? THEN t.weighted ELSE 0 END), 0)
                        AS today_bytes,
                    COALESCE(SUM(CASE WHEN t.day >= ? AND t.day <= ? THEN t.weighted ELSE 0 END), 0)
                        AS month_bytes
             FROM traffic_node_daily t
             JOIN nodes n ON n.server_id = t.server_id AND n.tag = t.node_tag
             JOIN servers s ON s.id = n.server_id
             WHERE t.day >= ? AND t.day <= ? AND (? IS NULL OR t.server_id = ?)
             GROUP BY n.id, n.tag, n.name, n.server_id, s.name,
                      n.protocol, n.transport, n.security
             ORDER BY SUM(CASE WHEN t.day >= ? AND t.day <= ? THEN t.weighted ELSE 0 END) DESC,
                      n.id ASC",
        )
        .bind(&start_date)
        .bind(&end_date)
        .bind(&start_date)
        .bind(&end_date)
        .bind(&start_date)
        .bind(&end_date)
        .bind(&today)
        .bind(&month_start)
        .bind(&month_end)
        .bind(scan_from)
        .bind(&end_date)
        .bind(server_id)
        .bind(server_id)
        .bind(&start_date)
        .bind(&end_date)
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// 单个节点的流量详情：节点汇总 + 日趋势 + Top N 用户。
    pub type NodeTrafficDetail = (NodeTrafficRow, Vec<TrafficDay>, Vec<NodeUserRow>);

    /// 节点不存在返回 `None`（接口层转 404）；节点存在但窗口内没有流量时，
    /// 汇总为零、趋势全是 0（缺失日补 0），`users` 为空。
    pub async fn node_traffic_detail(
        pool: &SqlitePool,
        node_id: &str,
        now: i64,
        days: i64,
        top: i64,
    ) -> anyhow::Result<Option<NodeTrafficDetail>> {
        let days = days.clamp(1, 90);
        let top = top.clamp(1, 50);
        let Some(node) = super::nodes::find_by_id(pool, node_id).await? else {
            return Ok(None);
        };
        let server_name: String = sqlx::query_scalar("SELECT name FROM servers WHERE id = ?")
            .bind(&node.server_id)
            .fetch_one(pool)
            .await?;

        let (start_date, end_date) = day_window(now, days);
        let today = crate::time::business_date(now);
        let (month_start, month_end) = crate::time::business_month_bounds(now);
        let scan_from = start_date.as_str().min(month_start.as_str());

        #[derive(sqlx::FromRow)]
        struct Totals {
            uplink: i64,
            downlink: i64,
            weighted: i64,
            today_bytes: i64,
            month_bytes: i64,
        }
        let totals = sqlx::query_as::<_, Totals>(
            "SELECT
                COALESCE(SUM(CASE WHEN day >= ? AND day <= ? THEN uplink ELSE 0 END), 0)
                    AS uplink,
                COALESCE(SUM(CASE WHEN day >= ? AND day <= ? THEN downlink ELSE 0 END), 0)
                    AS downlink,
                COALESCE(SUM(CASE WHEN day >= ? AND day <= ? THEN weighted ELSE 0 END), 0)
                    AS weighted,
                COALESCE(SUM(CASE WHEN day = ? THEN weighted ELSE 0 END), 0) AS today_bytes,
                COALESCE(SUM(CASE WHEN day >= ? AND day <= ? THEN weighted ELSE 0 END), 0)
                    AS month_bytes
             FROM traffic_node_daily
             WHERE server_id = ? AND node_tag = ? AND day >= ? AND day <= ?",
        )
        .bind(&start_date)
        .bind(&end_date)
        .bind(&start_date)
        .bind(&end_date)
        .bind(&start_date)
        .bind(&end_date)
        .bind(&today)
        .bind(&month_start)
        .bind(&month_end)
        .bind(&node.server_id)
        .bind(&node.tag)
        .bind(scan_from)
        .bind(&end_date)
        .fetch_one(pool)
        .await?;

        let row = NodeTrafficRow {
            node_id: node.id.clone(),
            node_tag: node.tag.clone(),
            name: node.name.clone(),
            server_id: node.server_id.clone(),
            server_name,
            protocol: node.protocol.clone(),
            transport: node.transport.clone(),
            security: node.security.clone(),
            uplink: totals.uplink,
            downlink: totals.downlink,
            weighted: totals.weighted,
            today_bytes: totals.today_bytes,
            month_bytes: totals.month_bytes,
        };

        let trend = node_trend(pool, &node.server_id, &node.tag, now, days).await?;

        // `user_id = ''` 是无法归因的流量：计入上面的节点总量，但不进用户明细。
        // 用户后来被删时用 user_id 兜底展示，避免整行消失。
        let users = sqlx::query_as::<_, NodeUserRow>(
            "SELECT t.user_id AS user_id,
                    COALESCE(u.username, t.user_id) AS username,
                    COALESCE(SUM(t.uplink), 0) AS uplink,
                    COALESCE(SUM(t.downlink), 0) AS downlink,
                    COALESCE(SUM(t.weighted), 0) AS weighted
             FROM traffic_node_daily t
             LEFT JOIN users u ON u.id = t.user_id
             WHERE t.server_id = ? AND t.node_tag = ?
               AND t.day >= ? AND t.day <= ? AND t.user_id <> ''
             GROUP BY t.user_id
             ORDER BY SUM(t.weighted) DESC, t.user_id ASC
             LIMIT ?",
        )
        .bind(&node.server_id)
        .bind(&node.tag)
        .bind(&start_date)
        .bind(&end_date)
        .bind(top)
        .fetch_all(pool)
        .await?;

        Ok(Some((row, trend, users)))
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
        Ok(fill_days(now, days, rows))
    }

    /// `days` 窗口的起止日期（UTC+8，闭区间）。
    pub(crate) fn day_window(now: i64, days: i64) -> (String, String) {
        let days = days.clamp(1, 90);
        let today = crate::time::business_day(now);
        let first = today - (days - 1);
        (
            crate::time::business_date(crate::time::business_day_start(first)),
            crate::time::business_date(crate::time::business_day_start(today)),
        )
    }

    #[derive(sqlx::FromRow)]
    struct DayRow {
        day: String,
        uplink: i64,
        downlink: i64,
        weighted: i64,
    }

    /// 把稀疏的 `GROUP BY day` 结果补成连续 `days` 个点（升序）。
    fn fill_days(now: i64, days: i64, rows: Vec<DayRow>) -> Vec<TrafficDay> {
        let days = days.clamp(1, 90);
        let today = crate::time::business_day(now);
        let first = today - (days - 1);
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
        points
    }

    /// 单节点日趋势，形状与全局趋势一致。
    async fn node_trend(
        pool: &SqlitePool,
        server_id: &str,
        node_tag: &str,
        now: i64,
        days: i64,
    ) -> anyhow::Result<Vec<TrafficDay>> {
        let days = days.clamp(1, 90);
        let (start_date, end_date) = day_window(now, days);
        let rows = sqlx::query_as::<_, DayRow>(
            "SELECT day,
                    COALESCE(SUM(uplink), 0) AS uplink,
                    COALESCE(SUM(downlink), 0) AS downlink,
                    COALESCE(SUM(weighted), 0) AS weighted
             FROM traffic_node_daily
             WHERE server_id = ? AND node_tag = ? AND day >= ? AND day <= ?
             GROUP BY day",
        )
        .bind(server_id)
        .bind(node_tag)
        .bind(&start_date)
        .bind(&end_date)
        .fetch_all(pool)
        .await?;
        Ok(fill_days(now, days, rows))
    }
}

/// 概览页一次拉齐的只读聚合（`GET /api/v1/overview`）。
///
/// 字段名是前端契约的一部分，改名视为破坏性变更。所有 SQL 都在这里，
/// master 只做参数解析与序列化。
///
/// 口径：
/// * `kpi.traffic_today/month` 与 `/api/v1/stats/overview` 一致，用 `weighted`
///   （计费口径）；
/// * `series` 直接复用 `stats::traffic_trend`：同一时间窗、同一「缺失日补 0」规则，
///   只保留契约要求的 `day/uplink/downlink`；
/// * `protocols.traffic_7d` / `top.traffic_7d` 用原始上下行之和（与趋势图同口径），
///   窗口长度 = `days`（默认 7，故字段名固定为 `traffic_7d`）；
/// * 协议归属在 SQL 里拆 `subject = "{user_id}@{node_tag}"`：节点 tag 只允许
///   `[a-z0-9_-]`，不会含 `@`，按第一个（也是唯一一个）`@` 切分即可。删掉的节点
///   JOIN 不到，流量归入 `unknown` 而不是丢弃；
/// * `chains.blocked` 与链列表的 `blocked_reason` **同口径**：配置层面无法下发
///   （nftables 能力不足 / 多目标不支持 / TLS 证书或跳间能力不满足）才计数，
///   `listening = 0` 属于运行态健康，不再计入。判定统一走
///   [`crate::chains::blocked_reason`]，不在概览 SQL 里另算一套；
///   `chains.forwards_*` 只统计独立端口转发规则，不含链推导出的转发。
pub mod overview {
    use std::collections::HashMap;

    use serde::Serialize;

    use super::*;

    /// Top 卡片最多返回的服务器数。
    const TOP_SERVERS: i64 = 5;

    #[derive(Debug, Clone, PartialEq, Serialize)]
    pub struct Kpi {
        pub servers_online: i64,
        pub servers_total: i64,
        pub nodes: i64,
        pub traffic_today: i64,
        pub traffic_month: i64,
        /// 0..1；没有可用采样的服务器不参与均值，全都没有时为 0。
        pub uptime_24h: f64,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    pub struct SeriesPoint {
        pub day: String,
        pub uplink: i64,
        pub downlink: i64,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    pub struct ProtocolRow {
        pub protocol: String,
        /// 该协议配置的节点数（含停用节点；与 KPI 的 `nodes` 同口径）。
        pub nodes: i64,
        /// 窗口内原始上下行之和；已删除节点归入 `protocol = "unknown"`。
        pub traffic_7d: i64,
    }

    #[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
    pub struct ChainRow {
        pub total: i64,
        pub degraded: i64,
        pub blocked: i64,
        pub forwards_total: i64,
        pub forwards_failing: i64,
        /// `forward_status.target_error IS NOT NULL` 的行数。
        pub handshake_failures: i64,
    }

    #[derive(Debug, Clone, PartialEq, Serialize)]
    pub struct TopRow {
        /// 目前只有 `server`；保留字段供后续扩展节点维度。
        pub kind: &'static str,
        pub name: String,
        pub traffic_7d: i64,
        pub load1: Option<f64>,
        pub online: bool,
    }

    #[derive(Debug, Clone, PartialEq, Serialize)]
    pub struct OverviewSnapshot {
        pub kpi: Kpi,
        pub series: Vec<SeriesPoint>,
        pub protocols: Vec<ProtocolRow>,
        pub chains: ChainRow,
        pub top: Vec<TopRow>,
    }

    /// 查询次数固定、与数据量无关（没有 N+1）：概览主体 9 条；
    /// `chains.blocked` 走 [`super::chains::count_blocked`] 的 3 条结构查询
    /// + 最多 1 条证书批量查询（无链时只 1 条）。
    pub async fn snapshot(
        pool: &SqlitePool,
        now: i64,
        days: i64,
    ) -> anyhow::Result<OverviewSnapshot> {
        let days = days.clamp(1, 90);
        let today = crate::time::business_date(now);
        let (month_start, month_end) = crate::time::business_month_bounds(now);

        // 一条 SQL 拿齐四张表的标量，避免为每个数字各发一次查询。
        let (servers_total, servers_online, nodes, traffic_today, traffic_month): (
            i64,
            i64,
            i64,
            i64,
            i64,
        ) = sqlx::query_as(
            "SELECT
                (SELECT COUNT(*) FROM servers),
                (SELECT COUNT(*) FROM servers WHERE status = 'online'),
                (SELECT COUNT(*) FROM nodes),
                (SELECT COALESCE(SUM(weighted), 0) FROM traffic_daily WHERE day = ?),
                (SELECT COALESCE(SUM(weighted), 0) FROM traffic_daily
                  WHERE day >= ? AND day <= ?)",
        )
        .bind(&today)
        .bind(&month_start)
        .bind(&month_end)
        .fetch_one(pool)
        .await?;

        let series = super::stats::traffic_trend(pool, now, days)
            .await?
            .into_iter()
            .map(|point| SeriesPoint {
                day: point.date,
                uplink: point.uplink,
                downlink: point.downlink,
            })
            .collect();

        Ok(OverviewSnapshot {
            kpi: Kpi {
                servers_online,
                servers_total,
                nodes,
                traffic_today,
                traffic_month,
                uptime_24h: mean_uptime_24h(pool, now).await?,
            },
            series,
            protocols: protocol_rows(pool, now, days).await?,
            chains: chain_row(pool, now).await?,
            top: top_servers(pool, now, days).await?,
        })
    }

    /// 与 `/api/v1/public/status` 完全同口径：先用 `server_samples::uptime_all`
    /// 取每台服务器 24h 的均值，再对「有采样」的服务器求均值。
    async fn mean_uptime_24h(pool: &SqlitePool, now: i64) -> anyhow::Result<f64> {
        let rows = super::server_samples::uptime_all(pool, now).await?;
        let mut sum = 0.0;
        let mut sampled = 0_u64;
        for row in rows {
            if let Some(value) = row.uptime_24h {
                sum += value;
                sampled += 1;
            }
        }
        Ok(if sampled == 0 {
            0.0
        } else {
            sum / sampled as f64
        })
    }

    /// 协议分布：节点数来自 `nodes`，流量用**一条** `GROUP BY` 聚合
    /// `traffic_daily`。两者在 Rust 里按协议合并，保证「配了但没流量」的协议
    /// 以 `traffic_7d = 0` 出现，已删节点的流量落到 `unknown`。
    async fn protocol_rows(
        pool: &SqlitePool,
        now: i64,
        days: i64,
    ) -> anyhow::Result<Vec<ProtocolRow>> {
        let (start_date, end_date) = super::stats::day_window(now, days);
        let node_counts: Vec<(String, i64)> =
            sqlx::query_as("SELECT protocol, COUNT(*) FROM nodes GROUP BY protocol")
                .fetch_all(pool)
                .await?;
        // `instr(subject, '@')` 取第一个 @：节点 tag 的字符集不允许 @，
        // 所以它同时就是最后一个 @（与 METERING §3 的切分规则一致）。
        let traffic: Vec<(String, i64)> = sqlx::query_as(
            "SELECT COALESCE(n.protocol, 'unknown') AS protocol,
                    COALESCE(SUM(t.uplink + t.downlink), 0) AS traffic
             FROM traffic_daily t
             LEFT JOIN nodes n
               ON n.server_id = t.server_id
              AND n.tag = CASE
                    WHEN instr(t.subject, '@') > 0
                    THEN substr(t.subject, instr(t.subject, '@') + 1)
                    ELSE ''
                  END
             WHERE t.day >= ? AND t.day <= ?
             GROUP BY COALESCE(n.protocol, 'unknown')",
        )
        .bind(&start_date)
        .bind(&end_date)
        .fetch_all(pool)
        .await?;

        let mut by_protocol: HashMap<String, ProtocolRow> = node_counts
            .into_iter()
            .map(|(protocol, nodes)| {
                (
                    protocol.clone(),
                    ProtocolRow {
                        protocol,
                        nodes,
                        traffic_7d: 0,
                    },
                )
            })
            .collect();
        for (protocol, traffic_7d) in traffic {
            by_protocol
                .entry(protocol.clone())
                .and_modify(|row| row.traffic_7d = traffic_7d)
                .or_insert(ProtocolRow {
                    protocol,
                    nodes: 0,
                    traffic_7d,
                });
        }
        let mut rows: Vec<ProtocolRow> = by_protocol.into_values().collect();
        rows.sort_by(|a, b| {
            b.traffic_7d
                .cmp(&a.traffic_7d)
                .then_with(|| a.protocol.cmp(&b.protocol))
        });
        Ok(rows)
    }

    /// 链路健康：一次 CTE 把链 → 组 → 成员 → 心跳状态对齐，算降级；
    /// 阻断数走与链列表完全相同的 [`crate::chains::blocked_reason`] 判定。
    ///
    /// forward id 的格式必须与 `crate::chains::forward_id` 一致：单成员组用
    /// `chain-<id>-<seq>`，多成员组追加 `-<server_id>`。
    async fn chain_row(pool: &SqlitePool, now: i64) -> anyhow::Result<ChainRow> {
        #[derive(sqlx::FromRow)]
        struct Health {
            total: i64,
            degraded: i64,
        }
        let health = sqlx::query_as::<_, Health>(
            "WITH group_sizes AS (
                 SELECT group_id, COUNT(*) AS members
                 FROM chain_group_members
                 GROUP BY group_id
             ),
             derived AS (
                 SELECT c.id AS chain_id,
                        m.server_id AS server_id,
                        CASE WHEN gs.members <= 1
                             THEN 'chain-' || c.id || '-' || g.seq
                             ELSE 'chain-' || c.id || '-' || g.seq || '-' || m.server_id
                        END AS forward_id
                 FROM chains c
                 JOIN chain_groups g ON g.chain_id = c.id
                 JOIN group_sizes gs ON gs.group_id = g.id
                 JOIN chain_group_members m ON m.group_id = g.id
             )
             SELECT (SELECT COUNT(*) FROM chains) AS total,
                    COUNT(DISTINCT CASE WHEN fs.target_fail_count >= ? THEN d.chain_id END)
                        AS degraded
             FROM derived d
             LEFT JOIN forward_status fs
               ON fs.server_id = d.server_id AND fs.forward_id = d.forward_id",
        )
        .bind(crate::chains::DEGRADED_AFTER_FAILURES)
        .fetch_one(pool)
        .await?;

        let (forwards_total, forwards_failing): (i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM forwards),
                    (SELECT COUNT(*)
                     FROM forwards f
                     JOIN forward_status fs
                       ON fs.server_id = f.server_id AND fs.forward_id = f.id
                     WHERE fs.listening = 0)",
        )
        .fetch_one(pool)
        .await?;
        let handshake_failures: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM forward_status WHERE target_error IS NOT NULL",
        )
        .fetch_one(pool)
        .await?;

        let blocked = super::chains::count_blocked(pool, now).await?;

        Ok(ChainRow {
            total: health.total,
            degraded: health.degraded,
            blocked,
            forwards_total,
            forwards_failing,
            handshake_failures,
        })
    }

    /// Top 服务器：窗口内原始上下行之和降序。LEFT JOIN 保证零流量服务器也参与
    /// 排序（服务器少于 5 台时它们会出现在列表尾部），但不会为了凑数硬填。
    async fn top_servers(pool: &SqlitePool, now: i64, days: i64) -> anyhow::Result<Vec<TopRow>> {
        let (start_date, end_date) = super::stats::day_window(now, days);

        #[derive(sqlx::FromRow)]
        struct Row {
            name: String,
            traffic_7d: i64,
            load1: Option<f64>,
            online: bool,
        }
        let rows = sqlx::query_as::<_, Row>(
            "SELECT s.name AS name,
                    COALESCE(SUM(t.uplink + t.downlink), 0) AS traffic_7d,
                    s.load1 AS load1,
                    s.status = 'online' AS online
             FROM servers s
             LEFT JOIN traffic_daily t
               ON t.server_id = s.id AND t.day >= ? AND t.day <= ?
             GROUP BY s.id, s.name, s.load1, s.status, s.created_at
             ORDER BY traffic_7d DESC, s.created_at ASC, s.id ASC
             LIMIT ?",
        )
        .bind(&start_date)
        .bind(&end_date)
        .bind(TOP_SERVERS)
        .fetch_all(pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|row| TopRow {
                kind: "server",
                name: row.name,
                traffic_7d: row.traffic_7d,
                load1: row.load1,
                online: row.online,
            })
            .collect())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        use crate::Db;

        fn at(rfc3339: &str) -> i64 {
            chrono::DateTime::parse_from_rfc3339(rfc3339)
                .unwrap()
                .timestamp()
        }

        async fn setup() -> SqlitePool {
            let db = Db::connect("sqlite::memory:").await.unwrap();
            db.migrate().await.unwrap();
            db.pool
        }

        async fn add_node(pool: &SqlitePool, server_id: &str, tag: &str, protocol: &str) {
            super::super::nodes::create(
                pool,
                server_id,
                super::super::nodes::NewNode {
                    tag: Some(tag.into()),
                    name: tag.into(),
                    protocol: protocol.into(),
                    transport: "tcp".into(),
                    security: "none".into(),
                    port: 443,
                    config_json: "{}".into(),
                    enabled: true,
                    cert_id: None,
                    bandwidth_kbps: None,
                },
            )
            .await
            .unwrap();
        }

        async fn seed(
            pool: &SqlitePool,
            day: &str,
            server_id: &str,
            subject: &str,
            bytes: (u64, u64, u64),
        ) {
            super::super::traffic::accumulate_daily(
                pool, day, server_id, subject, bytes.0, bytes.1, bytes.2,
            )
            .await
            .unwrap();
        }

        #[tokio::test]
        async fn protocols_group_by_protocol_and_bucket_deleted_nodes_as_unknown() {
            let pool = setup().await;
            let (server, _) = super::super::servers::create(&pool, "hk-1", "10.0.0.1", "external")
                .await
                .unwrap();
            add_node(&pool, &server.id, "v1", "vless").await;
            add_node(&pool, &server.id, "t1", "trojan").await;
            add_node(&pool, &server.id, "m1", "vmess").await;

            let now = at("2026-11-15T12:00:00+08:00");
            let today = crate::time::business_date(now);
            seed(&pool, &today, &server.id, "alice@v1", (10, 20, 30)).await;
            seed(&pool, &today, &server.id, "alice@t1", (1, 2, 3)).await;
            // 节点已删除：subject 里的 tag 在 nodes 里找不到。
            seed(&pool, &today, &server.id, "bob@gone", (5, 5, 10)).await;

            let snapshot = super::snapshot(&pool, now, 7).await.unwrap();
            let rows: Vec<(&str, i64, i64)> = snapshot
                .protocols
                .iter()
                .map(|row| (row.protocol.as_str(), row.nodes, row.traffic_7d))
                .collect();
            assert_eq!(
                rows,
                vec![
                    ("vless", 1, 30),
                    ("unknown", 0, 10),
                    ("trojan", 1, 3),
                    // 配了但窗口内没有流量：仍然返回，流量为 0。
                    ("vmess", 1, 0),
                ]
            );
        }

        #[tokio::test]
        async fn window_includes_boundary_day_and_excludes_future_days() {
            let pool = setup().await;
            let (server, _) = super::super::servers::create(&pool, "hk-1", "10.0.0.1", "external")
                .await
                .unwrap();
            add_node(&pool, &server.id, "v1", "vless").await;

            let now = at("2026-11-15T12:00:00+08:00");
            // days = 7 → 窗口 11-09..11-15（含两端）。
            seed(&pool, "2026-11-09", &server.id, "alice@v1", (1, 2, 3)).await;
            seed(&pool, "2026-11-08", &server.id, "alice@v1", (100, 100, 200)).await;
            seed(&pool, "2026-11-16", &server.id, "alice@v1", (200, 200, 400)).await;

            let snapshot = super::snapshot(&pool, now, 7).await.unwrap();
            assert_eq!(snapshot.series.len(), 7);
            assert_eq!(snapshot.series[0].day, "2026-11-09");
            assert_eq!(
                (snapshot.series[0].uplink, snapshot.series[0].downlink),
                (1, 2)
            );
            assert_eq!(snapshot.series[6].day, "2026-11-15");
            assert_eq!(
                (snapshot.series[6].uplink, snapshot.series[6].downlink),
                (0, 0),
                "未来日期的数据不能进入窗口"
            );
            assert_eq!(snapshot.protocols[0].traffic_7d, 3);
            assert_eq!(snapshot.top[0].traffic_7d, 3);

            // days = 1 只含今天：昨天与边界日都排除。
            let snapshot = super::snapshot(&pool, now, 1).await.unwrap();
            assert_eq!(snapshot.series.len(), 1);
            assert_eq!(snapshot.series[0].day, "2026-11-15");
            assert_eq!(snapshot.protocols[0].traffic_7d, 0);
            assert_eq!(snapshot.top[0].traffic_7d, 0);
        }

        #[tokio::test]
        async fn top_servers_are_sorted_by_traffic_and_truncated_to_five() {
            let pool = setup().await;
            let now = at("2026-11-15T12:00:00+08:00");
            let today = crate::time::business_date(now);

            for index in 1..=6 {
                let (server, _) = super::super::servers::create(
                    &pool,
                    &format!("s{index}"),
                    &format!("10.0.0.{index}"),
                    "external",
                )
                .await
                .unwrap();
                seed(
                    &pool,
                    &today,
                    &server.id,
                    "alice@x",
                    (index * 10, 0, index * 10),
                )
                .await;
            }

            let snapshot = super::snapshot(&pool, now, 7).await.unwrap();
            let names: Vec<&str> = snapshot.top.iter().map(|row| row.name.as_str()).collect();
            assert_eq!(names, vec!["s6", "s5", "s4", "s3", "s2"]);
            assert_eq!(snapshot.top.len(), 5);
            assert_eq!(snapshot.top[0].traffic_7d, 60);
            assert_eq!(snapshot.top[0].kind, "server");
            assert!(!snapshot.top[0].online);
            assert_eq!(snapshot.top[0].load1, None);
        }

        #[tokio::test]
        async fn top_includes_zero_traffic_servers_when_under_five() {
            let pool = setup().await;
            let now = at("2026-11-15T12:00:00+08:00");
            let today = crate::time::business_date(now);

            let (busy, _) = super::super::servers::create(&pool, "busy", "10.0.0.1", "external")
                .await
                .unwrap();
            let (_, _) = super::super::servers::create(&pool, "idle", "10.0.0.2", "external")
                .await
                .unwrap();
            super::super::servers::update_health(
                &pool,
                &busy.id,
                "0.1.0",
                &super::super::servers::HealthSnapshot {
                    load1: 0.4,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            super::super::servers::mark_online(&pool, &busy.id)
                .await
                .unwrap();
            seed(&pool, &today, &busy.id, "alice@x", (90, 10, 100)).await;

            let snapshot = super::snapshot(&pool, now, 7).await.unwrap();
            assert_eq!(snapshot.top.len(), 2);
            assert_eq!(snapshot.top[0].name, "busy");
            assert_eq!(snapshot.top[0].traffic_7d, 100);
            assert_eq!(snapshot.top[0].load1, Some(0.4));
            assert!(snapshot.top[0].online);
            assert_eq!(snapshot.top[1].name, "idle");
            assert_eq!(snapshot.top[1].traffic_7d, 0);
            assert!(!snapshot.top[1].online);

            // 零流量服务器也参与排序：再建一台有流量的会排到它前面。
            let (other, _) = super::super::servers::create(&pool, "other", "10.0.0.3", "external")
                .await
                .unwrap();
            seed(&pool, &today, &other.id, "alice@x", (5, 5, 10)).await;
            let snapshot = super::snapshot(&pool, now, 7).await.unwrap();
            let names: Vec<&str> = snapshot.top.iter().map(|row| row.name.as_str()).collect();
            assert_eq!(names, vec!["busy", "other", "idle"]);
            assert_eq!(snapshot.top[2].name, "idle");
            assert_eq!(snapshot.top[2].traffic_7d, 0);
        }

        #[tokio::test]
        async fn handshake_failures_count_only_rows_with_target_error() {
            let pool = setup().await;
            let (server, _) = super::super::servers::create(&pool, "hk-1", "10.0.0.1", "external")
                .await
                .unwrap();
            let forward = super::super::forwards::create(
                &pool,
                &server.id,
                super::super::forwards::NewForward {
                    name: "web".into(),
                    listen_port: 8443,
                    target_host: "1.1.1.1".into(),
                    target_port: 443,
                    enabled: true,
                    engine: "native".into(),
                    protocol: "tcp".into(),
                },
            )
            .await
            .unwrap();

            super::super::forwards::save_status(
                &pool,
                &server.id,
                &[
                    super::super::forwards::NewForwardStatus {
                        forward_id: forward.id.clone(),
                        listening: false,
                        error: "监听失败".into(),
                        target_ok: None,
                        target_error: None,
                        targets: Vec::new(),
                    },
                    super::super::forwards::NewForwardStatus {
                        forward_id: "fwd-a".into(),
                        listening: true,
                        error: String::new(),
                        target_ok: Some(false),
                        target_error: Some("cert_expired".into()),
                        targets: Vec::new(),
                    },
                    super::super::forwards::NewForwardStatus {
                        forward_id: "fwd-b".into(),
                        listening: true,
                        error: String::new(),
                        target_ok: Some(false),
                        target_error: Some("timeout".into()),
                        targets: Vec::new(),
                    },
                    super::super::forwards::NewForwardStatus {
                        forward_id: "fwd-c".into(),
                        listening: true,
                        error: String::new(),
                        target_ok: None,
                        target_error: None,
                        targets: Vec::new(),
                    },
                ],
            )
            .await
            .unwrap();

            let snapshot = super::snapshot(&pool, at("2026-11-15T12:00:00+08:00"), 7)
                .await
                .unwrap();
            assert_eq!(
                snapshot.chains.handshake_failures, 2,
                "只有 target_error 非 NULL 的两行计入"
            );
            assert_eq!(snapshot.chains.forwards_total, 1);
            assert_eq!(snapshot.chains.forwards_failing, 1);
            assert_eq!(snapshot.chains.total, 0);
            assert_eq!(snapshot.chains.degraded, 0);
            assert_eq!(snapshot.chains.blocked, 0);
        }

        #[tokio::test]
        async fn chain_health_marks_degraded_after_two_failures_and_keeps_blocked_config_only() {
            let pool = setup().await;
            let now = at("2026-11-15T12:00:00+08:00");
            let (server, _) = super::super::servers::create(&pool, "hk-1", "10.0.0.1", "external")
                .await
                .unwrap();
            let chain = super::super::chains::create(
                &pool,
                super::super::chains::NewChain {
                    name: "港-日".into(),
                    target_host: "1.1.1.1".into(),
                    target_port: 443,
                    enabled: true,
                    engine: "native".into(),
                    protocol: "tcp".into(),
                    transport: "none".into(),
                    groups: vec![super::super::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: None,
                        members: vec![super::super::chains::NewChainGroupMember {
                            server_id: server.id.clone(),
                            listen_port: 9001,
                            priority: 0,
                            weight: 1,
                        }],
                    }],
                },
            )
            .await
            .unwrap();
            let forward_id = crate::chains::forward_id(&chain.chain.id, 0, &server.id, 1);
            let failing = || super::super::forwards::NewForwardStatus {
                forward_id: forward_id.clone(),
                listening: true,
                error: String::new(),
                target_ok: Some(false),
                target_error: Some("cert_expired".into()),
                targets: Vec::new(),
            };

            // 第一次失败：不降级（连续两次才算）。
            super::super::forwards::save_status(&pool, &server.id, &[failing()])
                .await
                .unwrap();
            let snapshot = super::snapshot(&pool, now, 7).await.unwrap();
            assert_eq!(snapshot.chains.total, 1);
            assert_eq!(snapshot.chains.degraded, 0);
            assert_eq!(snapshot.chains.handshake_failures, 1);

            // 第二次失败：链降级。
            super::super::forwards::save_status(&pool, &server.id, &[failing()])
                .await
                .unwrap();
            let snapshot = super::snapshot(&pool, now, 7).await.unwrap();
            assert_eq!(snapshot.chains.degraded, 1);

            // 监听失败：运行态不健康，但这不是配置层面的 blocked
            // （概览与链列表同口径：blocked 只看证书/能力等「整链无法下发」）。
            super::super::forwards::save_status(
                &pool,
                &server.id,
                &[super::super::forwards::NewForwardStatus {
                    forward_id,
                    listening: false,
                    error: "监听 9001 失败".into(),
                    target_ok: None,
                    target_error: None,
                    targets: Vec::new(),
                }],
            )
            .await
            .unwrap();
            let snapshot = super::snapshot(&pool, now, 7).await.unwrap();
            assert_eq!(snapshot.chains.degraded, 0);
            assert_eq!(
                snapshot.chains.blocked, 0,
                "listening=0 不计入 blocked，与链列表 blocked_reason 一致"
            );
            assert_eq!(snapshot.chains.handshake_failures, 0);
        }

        #[tokio::test]
        async fn uptime_average_reuses_public_status_semantics() {
            let pool = setup().await;
            let now = at("2026-11-15T12:00:00+08:00");
            let (a, _) = super::super::servers::create(&pool, "a", "10.0.0.1", "external")
                .await
                .unwrap();
            let (b, _) = super::super::servers::create(&pool, "b", "10.0.0.2", "external")
                .await
                .unwrap();
            super::super::servers::mark_online(&pool, &a.id)
                .await
                .unwrap();
            super::super::server_samples::record_round(&pool, now - 300)
                .await
                .unwrap();

            // 一台在线、一台离线：均值 0.5。
            super::super::servers::mark_offline(&pool, &b.id)
                .await
                .unwrap();
            super::super::server_samples::record_round(&pool, now)
                .await
                .unwrap();
            // 没有采样的服务器不参与均值。
            super::super::servers::create(&pool, "c", "10.0.0.3", "external")
                .await
                .unwrap();
            let snapshot = super::snapshot(&pool, now, 7).await.unwrap();
            assert!((snapshot.kpi.uptime_24h - 0.5).abs() < 1e-9);
            assert_eq!(snapshot.kpi.servers_total, 3);
            assert_eq!(snapshot.kpi.servers_online, 1);
        }

        #[tokio::test]
        async fn empty_database_returns_zeroes_and_empty_lists_without_panicking() {
            let pool = setup().await;
            let snapshot = super::snapshot(&pool, at("2026-11-15T12:00:00+08:00"), 7)
                .await
                .unwrap();
            assert_eq!(
                snapshot.kpi,
                Kpi {
                    servers_online: 0,
                    servers_total: 0,
                    nodes: 0,
                    traffic_today: 0,
                    traffic_month: 0,
                    uptime_24h: 0.0,
                }
            );
            assert_eq!(snapshot.series.len(), 7);
            assert!(snapshot
                .series
                .iter()
                .all(|point| point.uplink == 0 && point.downlink == 0));
            assert!(snapshot.protocols.is_empty());
            assert!(snapshot.top.is_empty());
            assert_eq!(snapshot.chains, ChainRow::default());
        }

        #[tokio::test]
        async fn kpi_traffic_uses_weighted_and_month_bounds() {
            let pool = setup().await;
            let (server, _) = super::super::servers::create(&pool, "hk-1", "10.0.0.1", "external")
                .await
                .unwrap();
            let now = at("2026-11-15T12:00:00+08:00");
            let today = crate::time::business_date(now);
            seed(&pool, &today, &server.id, "alice@x", (10, 20, 300)).await;
            seed(&pool, "2026-11-01", &server.id, "alice@x", (1, 1, 50)).await;
            seed(&pool, "2026-10-31", &server.id, "alice@x", (2, 2, 70)).await;

            let snapshot = super::snapshot(&pool, now, 7).await.unwrap();
            assert_eq!(snapshot.kpi.traffic_today, 300, "today 用 weighted");
            assert_eq!(
                snapshot.kpi.traffic_month, 350,
                "month 覆盖 11-01..11-15，不含 10-31"
            );
        }
    }
}

/// 审计日志：所有管理端写操作的留痕。表在 `0001_init.sql` 里就已存在。
/// 备份/恢复的只读查询与一致性快照。
pub mod backup {
    use super::*;

    /// `VACUUM INTO` 生成独立、一致的单文件快照。
    ///
    /// 目标由调用方保证不存在；这里不用字符串拼接，路径走参数绑定。
    pub async fn vacuum_into(pool: &SqlitePool, target: &str) -> anyhow::Result<()> {
        sqlx::query("VACUUM INTO ?")
            .bind(target)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn table_exists(pool: &SqlitePool, name: &str) -> anyhow::Result<bool> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .bind(name)
        .fetch_one(pool)
        .await?;
        Ok(count > 0)
    }

    /// 备份里最高的迁移版本；表为空时返回 `None`。
    pub async fn max_migration_version(pool: &SqlitePool) -> anyhow::Result<Option<i64>> {
        Ok(
            sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
                .fetch_one(pool)
                .await?,
        )
    }
}

pub mod audit {
    use serde_json::Value;

    use super::*;
    use crate::models::{AuditEntry, AuditRow};

    /// 稳定翻页游标：排序键是 `(created_at, id)`，同一秒有多条记录时靠 id 决胜负。
    ///
    /// `id = None` 表示调用方只给了时间戳；此时按「不晚于该秒」翻页，
    /// 不会漏掉同一秒里的其它记录。
    #[derive(Debug, Clone)]
    pub struct Cursor {
        pub created_at: i64,
        pub id: Option<String>,
    }

    /// 审计列表筛选条件；全部为空时等价于旧的「取最新 N 条」。
    #[derive(Debug, Default, Clone)]
    pub struct Filter {
        /// 动作前缀；多个前缀之间是 OR（前端的「系统」分类覆盖好几类动作）。
        pub action_prefixes: Vec<String>,
        /// 操作者用户名子串。
        pub actor: Option<String>,
        /// 目标 id / 固定名字串。
        pub target: Option<String>,
    }

    pub struct Page {
        pub items: Vec<AuditEntry>,
        /// 下一页游标；`None` 表示已经翻到底。
        pub next_before: Option<String>,
    }

    /// 写一条审计记录。
    ///
    /// 调用方负责把这里的失败降级成日志：审计是旁路，**不能**回滚或阻断主操作。
    /// `target` 是被操作对象的 id（设置类操作用固定名，如 `settings`）。
    ///
    /// **id 必须用 UUID v7，不要改回 v4。** `created_at` 只到秒，同秒多条记录谁先谁后
    /// 完全由第二个排序键 `id` 决定：v7 的字符串字典序 = 创建顺序，所以
    /// `ORDER BY created_at DESC, id DESC` 在同一秒内也能稳定地「新记录在前」，
    /// 旧的 `rowid DESC` 行为因此不变；而 v4 是随机的，同秒顺序会变成随机结果——
    /// 既让 `(created_at, id)` 游标翻页的顺序看起来忽上忽下，也会让
    /// 「连续写三条、最新一条排最前」的既有测试间歇性失败。
    ///
    /// 历史遗留的 v4 记录不受影响：跨秒顺序由 `created_at` 决定，只有「同一秒内
    /// 新旧记录混排」这个边界会呈现任意顺序，属于已定型的历史数据。
    pub async fn record(
        pool: &SqlitePool,
        actor_id: Option<&str>,
        action: &str,
        target: Option<&str>,
        detail: &Value,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO audit_log (id, actor_id, action, target, detail, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(actor_id)
        .bind(action)
        .bind(target)
        .bind(detail.to_string())
        .bind(now())
        .execute(pool)
        .await?;
        Ok(())
    }

    /// LIKE 模式里的 `%` / `_` / `\` 必须转义，否则用户搜 `%` 会命中全部记录。
    fn escape_like(raw: &str) -> String {
        let mut escaped = String::with_capacity(raw.len() + 4);
        for ch in raw.chars() {
            if matches!(ch, '\\' | '%' | '_') {
                escaped.push('\\');
            }
            escaped.push(ch);
        }
        escaped
    }

    fn contains_pattern(raw: &str) -> String {
        format!("%{}%", escape_like(raw))
    }

    fn prefix_pattern(raw: &str) -> String {
        format!("{}%", escape_like(raw))
    }

    /// 按 `(created_at, id)` 倒序翻页，最多返回 `limit` 条。
    ///
    /// 排序键唯一，所以翻页不重不漏；历史 v4 记录在同一秒内的相对顺序是任意的，
    /// 但 `(created_at, id)` 仍然是确定的全序，翻页依旧稳定。
    ///
    /// `limit` 由调用方夹在 1..=500；这里多取一条用来判断「还有没有下一页」，
    /// 而不是让前端在最后一页多发一次空请求。
    pub async fn page(
        pool: &SqlitePool,
        filter: &Filter,
        cursor: Option<&Cursor>,
        limit: i64,
    ) -> anyhow::Result<Page> {
        let limit = limit.clamp(1, 500);
        let action_patterns: Vec<String> = filter
            .action_prefixes
            .iter()
            .map(|prefix| prefix.trim())
            .filter(|prefix| !prefix.is_empty())
            .map(prefix_pattern)
            .collect();
        let actor_pattern = filter
            .actor
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(contains_pattern);
        let target_pattern = filter
            .target
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(contains_pattern);

        // SQL 片段都是静态字符串，筛选值一律走绑定参数。
        let mut sql = String::from(
            "SELECT a.id, a.actor_id, u.username AS actor_name, a.action, a.target,
                    a.detail, a.created_at
             FROM audit_log a
             LEFT JOIN users u ON u.id = a.actor_id
             WHERE 1 = 1",
        );
        if !action_patterns.is_empty() {
            sql.push_str(" AND (");
            for index in 0..action_patterns.len() {
                if index > 0 {
                    sql.push_str(" OR ");
                }
                sql.push_str("a.action LIKE ? ESCAPE '\\'");
            }
            sql.push(')');
        }
        if actor_pattern.is_some() {
            sql.push_str(" AND u.username LIKE ? ESCAPE '\\'");
        }
        if target_pattern.is_some() {
            sql.push_str(" AND a.target LIKE ? ESCAPE '\\'");
        }
        match cursor {
            Some(Cursor { id: Some(_), .. }) => {
                sql.push_str(" AND (a.created_at, a.id) < (?, ?)");
            }
            Some(_) => sql.push_str(" AND a.created_at <= ?"),
            None => {}
        }
        sql.push_str(" ORDER BY a.created_at DESC, a.id DESC LIMIT ?");

        let mut query = sqlx::query_as::<_, AuditRow>(&sql);
        for pattern in &action_patterns {
            query = query.bind(pattern);
        }
        if let Some(pattern) = &actor_pattern {
            query = query.bind(pattern);
        }
        if let Some(pattern) = &target_pattern {
            query = query.bind(pattern);
        }
        if let Some(cursor) = cursor {
            query = query.bind(cursor.created_at);
            if let Some(id) = &cursor.id {
                query = query.bind(id);
            }
        }
        let mut rows = query.bind(limit + 1).fetch_all(pool).await?;

        let has_more = rows.len() as i64 > limit;
        if has_more {
            rows.truncate(limit as usize);
        }
        let next_before = if has_more {
            rows.last().map(|row| row.id.clone())
        } else {
            None
        };
        Ok(Page {
            items: rows.into_iter().map(AuditEntry::from).collect(),
            next_before,
        })
    }

    /// 游标只给 id 时，用一次主键查询还原它的 `created_at`。
    pub async fn find_created_at(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<i64>> {
        Ok(
            sqlx::query_scalar("SELECT created_at FROM audit_log WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await?,
        )
    }

    /// 旧的「取最新 `limit` 条」入口，保持给既有调用方使用。
    pub async fn list(pool: &SqlitePool, limit: i64) -> anyhow::Result<Vec<AuditEntry>> {
        Ok(page(pool, &Filter::default(), None, limit).await?.items)
    }
}
