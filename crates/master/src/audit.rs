//! 审计写入的薄封装。
//!
//! 核心约束：**审计是旁路，失败只记日志，绝不能影响主操作的返回值**。
//! 所以 [`record`] 永远返回 `()`，把 `repo::audit::record` 的错误吞在这里；
//! 任何调用点都不需要（也不应该）用 `?` 传播审计失败。

use pierwave_domain::models::User;
use pierwave_domain::repo;
use serde_json::{json, Value};

use crate::state::AppState;

/// 记一条管理端/用户端写操作。
///
/// `target` 约定为被操作对象的 id；`detail` 只放变更摘要，不要放密码、
/// 私钥、证书正文这类敏感内容。写入失败只打 `tracing::error!`。
pub async fn record(
    state: &AppState,
    actor: &User,
    action: &str,
    target: impl Into<String>,
    detail: Value,
) {
    let target = target.into();
    // 失败只记日志，绝不向上传播：审计库表异常（例如被手工删表）不能连累主操作。
    if let Err(error) = repo::audit::record(
        &state.db.pool,
        Some(&actor.id),
        action,
        Some(&target),
        &detail,
    )
    .await
    {
        tracing::error!(
            action,
            target = %target,
            actor_id = %actor.id,
            error = %error,
            "写审计日志失败（已忽略，不影响主操作）"
        );
    }
}

/// 组装 `{字段: {"from": 旧值, "to": 新值}}`，只保留真正变化的字段。
///
/// 用一次比较代替每个调用点手写 if，避免审计里出现一堆没变的字段。
pub fn diff(fields: Vec<(&str, Value, Value)>) -> Value {
    let mut changed = serde_json::Map::new();
    for (key, from, to) in fields {
        if from != to {
            changed.insert(key.to_string(), json!({ "from": from, "to": to }));
        }
    }
    Value::Object(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    use pierwave_domain::Db;

    fn admin() -> User {
        User {
            id: "actor-1".into(),
            username: "admin".into(),
            password_hash: String::new(),
            role: "admin".into(),
            status: "active".into(),
            short_code: "code".into(),
            quota_bytes: None,
            used_bytes: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn diff_keeps_only_changed_fields() {
        let detail = diff(vec![
            ("quota_override", json!(null), json!(100)),
            ("reset_day", json!(5), json!(5)),
        ]);
        assert_eq!(detail["quota_override"]["from"], Value::Null);
        assert_eq!(detail["quota_override"]["to"], 100);
        assert!(detail.get("reset_day").is_none());
    }

    /// 审计表不可写时（这里是连接池已关闭）`record` 不能 panic、也不能返回错误——
    /// 它只允许打日志，主操作照常继续。
    #[tokio::test]
    async fn audit_failure_is_swallowed() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        state.db.pool.close().await;

        record(&state, &admin(), "user.create", "target-1", json!({})).await;
    }
}
