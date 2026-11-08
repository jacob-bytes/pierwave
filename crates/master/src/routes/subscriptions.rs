//! 订阅管理列表：`GET /api/v1/subscriptions`。
//!
//! 行结构与用户列表一致，另外带出每行**实际生效**的规则模板
//! （`?rule=` 不参与这里：列表代表用户不携带参数时的默认订阅效果）。
//! 生效值按：用户绑定 → 当前套餐绑定 → 全局默认 → 内置规则（id/name 为 null）。

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use pierwave_domain::models::UserPackageView;
use pierwave_domain::repo;
use pierwave_domain::subscribe;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ListSubscriptionsQuery {
    /// 用户名 / 订阅短码模糊搜索。
    pub q: Option<String>,
    pub limit: Option<String>,
}

/// 订阅列表行：用户视图字段 + 生效规则模板。
///
/// 不直接 `flatten(UserView)`：`UserView.rule_template_id` 是用户绑定值，
/// 这里要输出的是解析后的**生效值**，两个同名字段会让 JSON 出现重复键。
#[derive(Serialize)]
struct SubscriptionRow {
    id: String,
    username: String,
    role: String,
    status: String,
    short_code: String,
    quota_bytes: Option<i64>,
    used_bytes: i64,
    created_at: i64,
    package_count: i64,
    packages: Vec<UserPackageView>,
    quota_exceeded: bool,
    package_quota_bytes: Option<i64>,
    package_used_bytes: i64,
    package_worst_status: String,
    /// 生效模板 id；`null` = 内置规则。
    rule_template_id: Option<String>,
    /// 生效模板名称；`null` = 内置规则。
    rule_template_name: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<ListSubscriptionsQuery>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let limit = match query.limit.as_deref() {
        None => 200,
        Some(raw) => raw
            .parse::<i64>()
            .map_err(|_| AppError::coded("query.limit_invalid", None, "limit 必须是整数"))?,
    };

    let users = repo::users::list_views(&state.db.pool, query.q.as_deref(), limit).await?;
    // 用户绑定已经在 UserView 里；这里一次查出每人的当前套餐绑定并批量解析，
    // 列表页不会因为「每个用户查三次模板」产生 N+1。
    let bindings: Vec<(String, Option<String>)> = users
        .iter()
        .map(|view| (view.id.clone(), view.rule_template_id.clone()))
        .collect();
    let resolved = repo::rule_templates::resolve_for_users(&state.db.pool, &bindings).await?;

    let items: Vec<SubscriptionRow> = users
        .into_iter()
        .map(|view| {
            let effective = subscribe::effective_rules(resolved.get(&view.id).cloned().flatten());
            SubscriptionRow {
                id: view.id,
                username: view.username,
                role: view.role,
                status: view.status,
                short_code: view.short_code,
                quota_bytes: view.quota_bytes,
                used_bytes: view.used_bytes,
                created_at: view.created_at,
                package_count: view.package_count,
                packages: view.packages,
                quota_exceeded: view.quota_exceeded,
                package_quota_bytes: view.package_quota_bytes,
                package_used_bytes: view.package_used_bytes,
                package_worst_status: view.package_worst_status,
                rule_template_id: effective.rule_template_id,
                rule_template_name: effective.rule_template_name,
            }
        })
        .collect();

    Ok(Json(json!({ "items": items })))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use pierwave_domain::models::User;
    use pierwave_domain::repo::{self, packages, user_packages};
    use pierwave_domain::Db;

    use crate::state::AppState;

    async fn setup() -> (Router, AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = repo::users::create(
            &db.pool,
            repo::users::NewUser {
                username: "admin".into(),
                password: "devpass".into(),
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
        )
    }

    async fn get(app: &Router, cookie: Option<&str>, uri: &str) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes).unwrap();
        (status, value)
    }

    fn row<'a>(body: &'a Value, username: &str) -> &'a Value {
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["username"] == username)
            .unwrap_or_else(|| panic!("列表里没有 {username}：{body}"))
    }

    async fn create_template(state: &AppState, name: &str, rules: &[&str]) -> String {
        repo::rule_templates::create(
            &state.db.pool,
            repo::rule_templates::NewRuleTemplate {
                name: name.into(),
                description: String::new(),
                rules: rules.iter().map(|rule| rule.to_string()).collect(),
                is_default: false,
            },
        )
        .await
        .unwrap()
        .id
    }

    async fn create_user(state: &AppState, username: &str, rule_template_id: Option<&str>) -> User {
        repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: username.into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: rule_template_id.map(str::to_string),
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn subscription_rows_report_effective_rule_template() {
        let (app, state, admin) = setup().await;
        let user_template = create_template(&state, "用户模板", &["MATCH,DIRECT"]).await;
        let package_template = create_template(&state, "套餐模板", &["MATCH,PROXY"]).await;

        // 套餐 A 绑定模板，套餐 B 不绑定。
        let bound_package = packages::create(
            &state.db.pool,
            packages::NewPackage {
                name: "绑定套餐".into(),
                quota_bytes: Some(10_000),
                period_days: Some(30),
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: Some(package_template.clone()),
                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        let plain_package = packages::create(
            &state.db.pool,
            packages::NewPackage {
                name: "普通套餐".into(),
                quota_bytes: Some(10_000),
                period_days: Some(30),
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,
                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();

        // alice：用户绑定 + 套餐绑定 → 用户级优先。
        let alice = create_user(&state, "alice", Some(&user_template)).await;
        user_packages::create(
            &state.db.pool,
            &alice.id,
            user_packages::NewUserPackage {
                package_id: bound_package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &bound_package,
        )
        .await
        .unwrap();

        // bob：没有用户绑定 → 套餐级。
        let bob = create_user(&state, "bob", None).await;
        user_packages::create(
            &state.db.pool,
            &bob.id,
            user_packages::NewUserPackage {
                package_id: bound_package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &bound_package,
        )
        .await
        .unwrap();

        // carol：套餐不绑定 → 全局默认。
        let carol = create_user(&state, "carol", None).await;
        user_packages::create(
            &state.db.pool,
            &carol.id,
            user_packages::NewUserPackage {
                package_id: plain_package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &plain_package,
        )
        .await
        .unwrap();

        // dave：绑定的模板随后被删除 → 绑定被 SET NULL，回落到全局默认。
        let deleted = create_template(&state, "待删除模板", &["MATCH,DIRECT"]).await;
        create_user(&state, "dave", Some(&deleted)).await;
        assert_eq!(
            repo::rule_templates::delete(&state.db.pool, &deleted)
                .await
                .unwrap(),
            repo::rule_templates::DeleteOutcome::Deleted
        );

        let default = repo::rule_templates::find_default(&state.db.pool)
            .await
            .unwrap()
            .expect("迁移应带默认模板");

        let (status, body) = get(&app, Some(&admin), "/api/v1/subscriptions").await;
        assert_eq!(status, StatusCode::OK);

        let alice_row = row(&body, "alice");
        assert_eq!(alice_row["rule_template_id"], user_template.as_str());
        assert_eq!(alice_row["rule_template_name"], "用户模板");
        // 行仍带用户视图字段，前端不需要再请求一次用户列表。
        assert_eq!(alice_row["short_code"].as_str().unwrap().len(), 10);
        assert_eq!(alice_row["package_count"], 1);

        let bob_row = row(&body, "bob");
        assert_eq!(bob_row["rule_template_id"], package_template.as_str());
        assert_eq!(bob_row["rule_template_name"], "套餐模板");

        for username in ["carol", "dave"] {
            let item = row(&body, username);
            assert_eq!(item["rule_template_id"], default.id.as_str());
            assert_eq!(item["rule_template_name"], default.name.as_str());
        }

        // 搜索参数沿用用户列表语义，生效模板字段仍然在。
        let (status, body) = get(&app, Some(&admin), "/api/v1/subscriptions?q=ali").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"].as_array().unwrap().len(), 1);
        assert_eq!(body["items"][0]["username"], "alice");
        assert_eq!(body["items"][0]["rule_template_name"], "用户模板");
        // 用户绑定值与生效值不能同时以同名 key 出现（否则 JSON 有重复键）。
        assert_eq!(body.to_string().matches("\"rule_template_id\"").count(), 1);
    }

    #[tokio::test]
    async fn subscriptions_require_admin() {
        let (app, state, _admin) = setup().await;
        let user = create_user(&state, "normal", None).await;
        let (token, _) = repo::sessions::create(&state.db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);

        let (status, body) = get(&app, Some(&cookie), "/api/v1/subscriptions").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");

        let (status, body) = get(&app, None, "/api/v1/subscriptions").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "未登录");
    }
}
