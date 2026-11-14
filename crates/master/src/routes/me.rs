//! 用户端自助接口：所有数据都以会话用户为准，忽略任何传入的身份参数。
//!
//! 这里的每个 handler 都只接收 [`CurrentUser`]，**没有任何 `:id` 路径参数或
//! `user_id` 查询参数**；越权不可能靠「前端不显示」实现，必须在路由这层就不存在
//! 可指向别人的入口。

use axum::extract::{Query, State};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::UserPackageView;
use pierwave_domain::{password, repo};

use crate::auth::{CurrentUser, SESSION_COOKIE};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DEFAULT_EVENTS_LIMIT: i64 = 20;
const MAX_EVENTS_LIMIT: i64 = 200;

/// 主套餐：优先取仍可用（active）的最新一张；没有可用的就退到最新一张，
/// 让「已过期 / 已用尽 / 已停用」仍然能在概览卡上如实显示，而不是变成空。
fn primary_package(packages: &[UserPackageView], now: i64) -> Option<&UserPackageView> {
    packages
        .iter()
        .rev()
        .find(|item| item.status_at(now) == "active")
        .or_else(|| packages.last())
}

/// 剩余天数：向上取整；已过期返回 0；永不过期返回 None。
fn days_left(expires_at: Option<i64>, now: i64) -> Option<i64> {
    expires_at.map(|expires_at| {
        let seconds = expires_at - now;
        if seconds <= 0 {
            0
        } else {
            (seconds + 86_399) / 86_400
        }
    })
}

/// 用户自助摘要。
///
/// 返回形状是给「我的」页面用的；`packages` / `traffic` / `subscription_url`
/// 是 P4 早期契约的字段，保留它们是为了旧前端在升级窗口内不白屏。
pub async fn summary(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    let now = repo::now();
    let packages = repo::user_packages::list_views_by_user(&state.db.pool, &user.0.id).await?;
    let (today_bytes, month_bytes) =
        repo::stats::subject_totals(&state.db.pool, &user.0.id, now).await?;

    let primary = primary_package(&packages, now);
    let package = primary.map(|item| {
        json!({
            "name": item.package_name,
            "traffic_limit": item.quota_bytes,
            "expires_at": item.expires_at,
        })
    });

    // 账户总用量与订阅头 / 日重置同口径：`users.used_bytes`。
    // `traffic_limit` 的 0 / null 都表示不限；0 是实例级「显式不限」。
    let used_bytes = user.0.used_bytes;
    let traffic_limit = primary.and_then(|item| item.quota_bytes);
    let remaining_bytes = traffic_limit.and_then(|limit| {
        if limit > 0 {
            Some((limit - used_bytes).max(0))
        } else {
            None
        }
    });
    let status = if user.0.status != "active" {
        "disabled"
    } else if primary.is_none() {
        "none"
    } else if user.0.quota_bytes.is_some_and(|quota| used_bytes >= quota) {
        "exhausted"
    } else {
        primary.map(|item| item.status_at(now)).unwrap_or("none")
    };

    // 节点可见性与订阅端点走同一套授权 SQL，套餐节点范围不会两处漂移。
    let allowed =
        repo::authorization::eligible_node_ids_for_user(&state.db.pool, &user.0.id).await?;
    let servers = repo::servers::list(&state.db.pool).await?;
    let server_names: std::collections::HashMap<String, String> = servers
        .iter()
        .map(|server| (server.id.clone(), server.name.clone()))
        .collect();
    let mut nodes = Vec::new();
    for row in repo::nodes::list_enabled_with_server(&state.db.pool).await? {
        if !allowed.contains(&row.node.id) {
            continue;
        }
        // 只给名字，不给服务器地址 / 端口 / 配置。
        nodes.push(json!({
            "id": row.node.id,
            "name": row.node.name,
            "tag": row.node.tag,
            "protocol": row.node.protocol,
            "server_name": server_names.get(&row.node.server_id).cloned().unwrap_or_default(),
        }));
    }

    // 自助转发可选的服务器：与创建转发用**同一份**额度快照，避免出现
    // 「下拉里有服务器、但配额是 0」的矛盾状态。limit = 0 时一律返回空。
    let forward_allowance =
        repo::packages::forward_allowance(&state.db.pool, &user.0.id, now).await?;
    let mut forward_servers: Vec<&pierwave_domain::models::Server> = if forward_allowance.limit > 0
    {
        servers
            .iter()
            .filter(|server| forward_allowance.allows_server(&server.id))
            .collect()
    } else {
        Vec::new()
    };
    forward_servers.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    let forward_servers: Vec<Value> = forward_servers
        .into_iter()
        .map(|server| json!({ "id": server.id, "name": server.name }))
        .collect();

    let short_code = user.0.short_code.clone();
    Ok(Json(json!({
        "user": {
            "id": user.0.id,
            "username": user.0.username,
            // 当前数据模型没有 email 列；保留 null 让前端按「未填写」处理。
            "email": null,
            "role": user.0.role,
            "short_code": short_code,
            "used_bytes": used_bytes,
            "quota_bytes": user.0.quota_bytes,
            "quota_exceeded": user.0.quota_bytes.is_some_and(|quota| used_bytes >= quota),
        },
        "package": package,
        "usage": {
            "used_bytes": used_bytes,
            "remaining_bytes": remaining_bytes,
            "days_left": days_left(primary.and_then(|item| item.expires_at), now),
            "status": status,
        },
        "nodes": nodes,
        // 普通用户建自助转发时的服务器下拉；只含当前有权创建的服务器。
        "forward_servers": forward_servers,
        "subscription": {
            "url": format!("/api/v1/sub/{short_code}"),
            "updated_at": user.0.short_code_updated_at,
        },
        // 兼容字段（P4 旧契约）；新页面只用上面的结构化字段。
        "packages": packages,
        "traffic": { "today_bytes": today_bytes, "month_bytes": month_bytes },
        "subscription_url": format!("/api/v1/sub/{short_code}"),
    })))
}

#[derive(Deserialize)]
pub struct DaysQuery {
    #[serde(default = "default_days")]
    pub days: i64,
}

fn default_days() -> i64 {
    7
}

pub async fn traffic(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<DaysQuery>,
) -> AppResult<Json<Value>> {
    if !(1..=90).contains(&query.days) {
        return Err(AppError::coded(
            "stats.days_invalid",
            Some(json!({ "min": 1, "max": 90 })),
            "days 需在 1-90 之间",
        ));
    }
    let days =
        repo::stats::traffic_trend_for_subject(&state.db.pool, repo::now(), query.days, &user.0.id)
            .await?;
    Ok(Json(json!({ "days": days })))
}

#[derive(Deserialize)]
pub struct ChangePassword {
    pub old_password: String,
    pub new_password: String,
}

#[derive(Deserialize)]
pub struct EventsQuery {
    /// 返回条数；缺省 20，非法值 400，越界夹到 1..=200。
    pub limit: Option<String>,
}

/// 自己的断流/恢复事件。复用 `enforcement_events` 表，按会话用户过滤。
pub async fn events(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<EventsQuery>,
) -> AppResult<Json<Value>> {
    let limit = match query.limit.as_deref() {
        None => DEFAULT_EVENTS_LIMIT,
        Some(raw) => raw.trim().parse::<i64>().map_err(|_| {
            AppError::coded(
                "query.limit_invalid",
                Some(json!({ "min": 1, "max": MAX_EVENTS_LIMIT })),
                format!("limit 必须是 1-{MAX_EVENTS_LIMIT} 的整数"),
            )
        })?,
    }
    .clamp(1, MAX_EVENTS_LIMIT);

    let items = repo::enforcement::list_events_for_user(&state.db.pool, &user.0.id, limit).await?;
    Ok(Json(json!({ "items": items })))
}

/// 重置自己的订阅短码：旧链接立即失效，返回新 URL。
///
/// 只改会话用户这一行；`id` 不接受任何请求参数。审计里只记「谁在什么时候重置」，
/// 不记短码本身（短码泄漏等于送人流量，审计表不该成为泄漏面）。
pub async fn reset_subscription(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Value>> {
    let (short_code, updated_at) = repo::users::reset_short_code(&state.db.pool, &user.0.id)
        .await?
        .ok_or_else(|| AppError::not_found("user.not_found", None, "资源不存在"))?;

    crate::audit::record(
        &state,
        &user.0,
        "user.reset_subscription",
        &user.0.id,
        json!({ "updated_at": updated_at }),
    )
    .await;

    Ok(Json(json!({
        "url": format!("/api/v1/sub/{short_code}"),
        "updated_at": updated_at,
    })))
}

/// 修改自己的密码：校验旧密码 → 更新 hash → 吊销其它会话（保留当前 token）。
pub async fn change_password(
    State(state): State<AppState>,
    user: CurrentUser,
    jar: CookieJar,
    Json(req): Json<ChangePassword>,
) -> AppResult<Json<Value>> {
    if !password::verify(&req.old_password, &user.0.password_hash) {
        return Err(AppError::WrongPassword);
    }
    if req.new_password.chars().count() < 8 {
        return Err(AppError::coded(
            "user.password_too_short",
            Some(json!({ "min": 8 })),
            "新密码至少 8 位",
        ));
    }

    if !repo::users::set_password(&state.db.pool, &user.0.id, &req.new_password).await? {
        return Err(AppError::not_found("user.not_found", None, "资源不存在"));
    }

    let token = jar
        .get(SESSION_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or_else(|| AppError::unauthorized("auth.unauthorized", None, "未登录"))?;
    let revoked = repo::sessions::delete_others(&state.db.pool, &user.0.id, &token).await?;
    tracing::info!(user_id = %user.0.id, revoked, "密码已更新，其它会话已吊销");

    // 只记「改过密码」这件事，detail 里绝不出现新/旧密码。
    crate::audit::record(
        &state,
        &user.0,
        "password.change",
        &user.0.id,
        json!({ "revoked_sessions": revoked }),
    )
    .await;

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::time;
    use pierwave_domain::Db;

    async fn setup() -> (Router, AppState, String, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let alice = repo::users::create(
            &db.pool,
            repo::users::NewUser {
                username: "alice".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&db.pool, &alice.id, 3600, None)
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
            alice.id,
        )
    }

    async fn get(app: &Router, cookie: Option<&str>, uri: &str) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header("cookie", cookie);
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn post(
        app: &Router,
        cookie: Option<&str>,
        uri: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(cookie) = cookie {
            builder = builder.header("cookie", cookie);
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn login(app: &Router, username: &str, password: &str) -> (StatusCode, Value) {
        post(
            app,
            None,
            "/api/v1/auth/login",
            json!({"username": username, "password": password}),
        )
        .await
    }

    #[tokio::test]
    async fn summary_is_scoped_to_the_session_user() {
        let (app, state, cookie, alice_id) = setup().await;

        // 给 alice 造一条今天的流量，另一个用户造一条不应被计入的
        let now = repo::now();
        let day = time::business_date(now);
        repo::traffic::accumulate_daily(&state.db.pool, &day, "server-1", &alice_id, 100, 50, 150)
            .await
            .unwrap();
        repo::traffic::accumulate_daily(&state.db.pool, &day, "server-1", "someone-else", 9, 9, 18)
            .await
            .unwrap();

        let (status, body) = get(&app, Some(&cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["user"]["username"], "alice");
        assert_eq!(body["traffic"]["today_bytes"], 150);
        assert_eq!(body["traffic"]["month_bytes"], 150);
        assert!(body["subscription_url"]
            .as_str()
            .unwrap()
            .starts_with("/api/v1/sub/"));
    }

    #[tokio::test]
    async fn traffic_series_is_zero_filled_and_validated() {
        let (app, state, cookie, alice_id) = setup().await;
        let now = repo::now();
        let day = time::business_date(now);
        repo::traffic::accumulate_daily(&state.db.pool, &day, "s", &alice_id, 1, 2, 3)
            .await
            .unwrap();

        let (status, body) = get(&app, Some(&cookie), "/api/v1/me/traffic?days=3").await;
        assert_eq!(status, StatusCode::OK);
        let days = body["days"].as_array().unwrap();
        assert_eq!(days.len(), 3);
        assert_eq!(days[2]["weighted"], 3);

        let (status, _) = get(&app, Some(&cookie), "/api/v1/me/traffic?days=999").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn requires_login() {
        let (app, _, _, _) = setup().await;
        let (status, _) = get(&app, None, "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn changing_password_revokes_other_sessions_and_keeps_current_one() {
        let (app, state, current_cookie, alice_id) = setup().await;
        let (other_token, _) = repo::sessions::create(&state.db.pool, &alice_id, 3600, None)
            .await
            .unwrap();
        let other_cookie = format!("{}={other_token}", crate::auth::SESSION_COOKIE);

        // 未登录 → 401。
        let (status, _) = post(
            &app,
            None,
            "/api/v1/me/password",
            json!({"old_password": "password123", "new_password": "newpassword123"}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        // 旧密码错 → 401，密码不变。
        let (status, body) = post(
            &app,
            Some(&current_cookie),
            "/api/v1/me/password",
            json!({"old_password": "wrong-password", "new_password": "newpassword123"}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "旧密码错误");
        let (status, _) = login(&app, "alice", "password123").await;
        assert_eq!(status, StatusCode::OK, "旧密码仍应可用");

        // 新密码太短 → 400。
        let (status, body) = post(
            &app,
            Some(&current_cookie),
            "/api/v1/me/password",
            json!({"old_password": "password123", "new_password": "short"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("至少 8 位"));

        // 成功改密码。
        let (status, body) = post(
            &app,
            Some(&current_cookie),
            "/api/v1/me/password",
            json!({"old_password": "password123", "new_password": "newpassword123"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ok"], true);

        // 当前会话仍可用；其它会话已被吊销。
        let (status, _) = get(&app, Some(&current_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK, "当前 token 必须保留");
        let (status, _) = get(&app, Some(&other_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "其它会话必须被吊销");

        // 旧密码登录失败，新密码登录成功。
        let (status, body) = login(&app, "alice", "password123").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "用户名或密码错误");
        let (status, body) = login(&app, "alice", "newpassword123").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["user"]["username"], "alice");
    }

    // ------------------------------------------------------------------
    // 用户自助中心（P4）：summary / traffic / events 一律以会话用户为准。
    // ------------------------------------------------------------------

    use pierwave_domain::repo::{
        enforcement, nodes as node_repo, packages, servers, user_packages,
    };

    const SERVER_ADDRESS: &str = "203.0.113.77";

    /// 建一个用户 + 会话 Cookie。
    async fn make_user(state: &AppState, username: &str, role: &str) -> (String, String) {
        let user = repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: username.into(),
                password: "password123".into(),
                role: role.into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&state.db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        (user.id, format!("{}={token}", crate::auth::SESSION_COOKIE))
    }

    /// 建一台服务器 + 一个节点，返回 (server_id, node_id)。
    async fn make_server_node(state: &AppState, server_name: &str, tag: &str) -> (String, String) {
        let (server, _token) =
            servers::create(&state.db.pool, server_name, SERVER_ADDRESS, "external")
                .await
                .unwrap();
        let node = node_repo::create(
            &state.db.pool,
            &server.id,
            node_repo::NewNode {
                tag: Some(tag.into()),
                name: format!("{server_name}-{tag}"),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "none".into(),
                port: 443,
                public_port: None,
                config_json: json!({"settings": {"clients": [], "decryption": "none"}}).to_string(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();
        (server.id, node.id)
    }

    /// 建套餐模板 + 给用户绑一张卡；返回实例视图。
    async fn give_package(
        state: &AppState,
        user_id: &str,
        name: &str,
        quota_bytes: Option<i64>,
        expires_at: Option<i64>,
        node_ids: Option<Vec<String>>,
    ) -> pierwave_domain::models::UserPackageView {
        let package = packages::create(
            &state.db.pool,
            packages::NewPackage {
                name: name.into(),
                quota_bytes,
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                speed_limit_kbps: None,
                rule_template_id: None,
                node_ids,
            },
        )
        .await
        .unwrap();
        user_packages::create(
            &state.db.pool,
            user_id,
            user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap()
    }

    async fn record_event(state: &AppState, kind: &str, user_id: &str, username: &str) {
        let message = format!("{username} 的测试事件");
        enforcement::insert_event(
            &state.db.pool,
            enforcement::NewEvent {
                kind,
                user_id,
                username,
                server_id: "server-1",
                server_name: "hk-1",
                reason: if kind == "removed" {
                    "exhausted"
                } else {
                    "recovered"
                },
                message: &message,
            },
        )
        .await
        .unwrap();
    }

    async fn seed_daily(state: &AppState, subject: &str, weighted: u64) {
        let now = repo::now();
        let day = time::business_date(now);
        repo::traffic::accumulate_daily(&state.db.pool, &day, "server-1", subject, 1, 1, weighted)
            .await
            .unwrap();
    }

    /// 用户 A 的每个自助接口都只返回 A 自己的数据；拿 A 的会话去打 B 的
    /// 管理端数据路径必须 403。**越权由后端拒绝，前端不做过滤。**
    #[tokio::test]
    async fn me_endpoints_are_scoped_to_the_session_user() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");

        let (alice_id, alice_cookie) = make_user(&state, "alice", "user").await;
        let (bob_id, _bob_cookie) = make_user(&state, "bob", "user").await;

        let (_server_a, node_a) = make_server_node(&state, "hk-a", "alice-node").await;
        let (_server_b, node_b) = make_server_node(&state, "hk-b", "bob-node").await;

        give_package(
            &state,
            &alice_id,
            "Alice 卡",
            Some(1_000),
            None,
            Some(vec![node_a.clone()]),
        )
        .await;
        give_package(
            &state,
            &bob_id,
            "Bob 卡",
            Some(9_000),
            None,
            Some(vec![node_b.clone()]),
        )
        .await;

        // 双方都有流量与断流事件；A 的响应里出现任何 B 的数字都是越权。
        seed_daily(&state, &alice_id, 111).await;
        seed_daily(&state, &bob_id, 999).await;
        repo::users::add_used_bytes(&state.db.pool, &alice_id, 111)
            .await
            .unwrap();
        repo::users::add_used_bytes(&state.db.pool, &bob_id, 999)
            .await
            .unwrap();
        record_event(&state, "removed", &alice_id, "alice").await;
        record_event(&state, "removed", &bob_id, "bob").await;

        let app = crate::app::router(state.clone());

        // 故意带上 B 的 id 作为查询参数：服务端必须忽略，以会话为准。
        let (status, body) = get(
            &app,
            Some(&alice_cookie),
            &format!("/api/v1/me/summary?user_id={bob_id}&subject={bob_id}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["user"]["username"], "alice");
        assert_eq!(body["package"]["name"], "Alice 卡");
        assert_eq!(body["package"]["traffic_limit"], 1_000);
        assert_eq!(body["usage"]["used_bytes"], 111);
        assert_eq!(body["usage"]["remaining_bytes"], 889);
        assert_eq!(body["usage"]["status"], "active");

        // 节点是 A 的套餐范围，不含 B 的节点；响应里也不允许出现服务器真实地址。
        let nodes = body["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 1, "{body}");
        assert_eq!(nodes[0]["id"], node_a);
        assert_eq!(nodes[0]["server_name"], "hk-a");
        assert!(nodes[0].get("address").is_none(), "节点不暴露真实地址");
        assert!(
            !body.to_string().contains(SERVER_ADDRESS),
            "summary 里不能出现服务器地址：{body}"
        );

        assert!(body["subscription"]["url"]
            .as_str()
            .unwrap()
            .ends_with(&format!(
                "/api/v1/sub/{}",
                body["user"]["short_code"].as_str().unwrap()
            )));
        assert!(body["subscription"]["updated_at"].is_number());
        assert!(!body.to_string().contains("Bob 卡"));

        // 事件：只返回自己的。
        let (status, body) = get(
            &app,
            Some(&alice_cookie),
            &format!("/api/v1/me/events?user_id={bob_id}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "{body}");
        assert_eq!(items[0]["user_id"], alice_id);
        assert_eq!(items[0]["username"], "alice");
        assert!(
            !body.to_string().contains(&bob_id),
            "A 的事件里不能出现 B：{body}"
        );

        // 流量：只统计自己的日账本。
        let (status, body) = get(
            &app,
            Some(&alice_cookie),
            &format!("/api/v1/me/traffic?days=3&user_id={bob_id}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let days = body["days"].as_array().unwrap();
        assert_eq!(days.len(), 3);
        assert_eq!(days[2]["weighted"], 111, "不能把 B 的 999 算进来：{body}");

        // 管理端用户套餐接口仍然是管理员专属：普通用户直接 403。
        let (status, _) = get(
            &app,
            Some(&alice_cookie),
            &format!("/api/v1/users/{bob_id}/packages"),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "越权必须在后端拒绝");
    }

    /// 自助转发下拉：只返回生效中套餐白名单的并集，且配额为 0 时为空。
    #[tokio::test]
    async fn summary_lists_only_forward_servers_from_active_packages() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let (alice_id, alice_cookie) = make_user(&state, "alice", "user").await;

        let (server_x, _node_x) = make_server_node(&state, "hk-b", "x").await;
        let (server_y, _node_y) = make_server_node(&state, "hk-a", "y").await;
        let (server_z, _node_z) = make_server_node(&state, "hk-z", "z").await;
        let app = crate::app::router(state.clone());

        // 无套餐：空数组。
        let (status, body) = get(&app, Some(&alice_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["forward_servers"], json!([]));

        // 套餐 A 允许 X、套餐 B 允许 Y：取并集，按名称排序。
        let package_a = give_package(&state, &alice_id, "A", Some(1_000), None, None).await;
        repo::packages::set_forward_rules(
            &state.db.pool,
            &package_a.package_id,
            2,
            std::slice::from_ref(&server_x),
        )
        .await
        .unwrap();
        let package_b = give_package(&state, &alice_id, "B", Some(1_000), None, None).await;
        repo::packages::set_forward_rules(
            &state.db.pool,
            &package_b.package_id,
            3,
            std::slice::from_ref(&server_y),
        )
        .await
        .unwrap();
        // 套餐 C 虽然列了 Z，但 forward_limit = 0：不能出现在下拉里。
        let package_c = give_package(&state, &alice_id, "C", Some(1_000), None, None).await;
        repo::packages::set_forward_rules(
            &state.db.pool,
            &package_c.package_id,
            0,
            std::slice::from_ref(&server_z),
        )
        .await
        .unwrap();

        let (status, body) = get(&app, Some(&alice_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["forward_servers"],
            json!([
                { "id": server_y, "name": "hk-a" },
                { "id": server_x, "name": "hk-b" },
            ]),
            "多套餐取并集、按名称排序，且不能泄漏未授权服务器：{body}"
        );
    }

    /// 管理员访问 `/me/*` 不报错，并且返回的是管理员自己的数据。
    #[tokio::test]
    async fn admin_me_returns_admin_own_data() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let (admin_id, admin_cookie) = make_user(&state, "root", "admin").await;
        let (_, node) = make_server_node(&state, "admin-hk", "admin-node").await;
        give_package(
            &state,
            &admin_id,
            "管理员卡",
            Some(2_000),
            None,
            Some(vec![node.clone()]),
        )
        .await;
        seed_daily(&state, &admin_id, 42).await;
        record_event(&state, "restored", &admin_id, "root").await;

        let app = crate::app::router(state.clone());

        let (status, body) = get(&app, Some(&admin_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK, "管理员看自己的数据不应 403：{body}");
        assert_eq!(body["user"]["username"], "root");
        assert_eq!(body["user"]["role"], "admin");
        assert_eq!(body["nodes"][0]["id"], node);

        let (status, body) = get(&app, Some(&admin_cookie), "/api/v1/me/events").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"][0]["username"], "root");

        let (status, body) = get(&app, Some(&admin_cookie), "/api/v1/me/traffic?days=2").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["days"][1]["weighted"], 42);
    }

    /// 四种用户状态（active / expired / exhausted / disabled）由后端算好；
    /// 无套餐用户不崩，`package` 为 null。
    #[tokio::test]
    async fn summary_reports_all_four_states_and_handles_no_package() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let (_, node) = make_server_node(&state, "hk", "n1").await;
        let now = repo::now();

        let (active_id, active_cookie) = make_user(&state, "active-user", "user").await;
        give_package(
            &state,
            &active_id,
            "生效卡",
            Some(1_000),
            Some(now + 30 * 86_400),
            Some(vec![node.clone()]),
        )
        .await;

        let (expired_id, expired_cookie) = make_user(&state, "expired-user", "user").await;
        give_package(
            &state,
            &expired_id,
            "过期卡",
            Some(1_000),
            Some(now - 60),
            Some(vec![node.clone()]),
        )
        .await;

        let (exhausted_id, exhausted_cookie) = make_user(&state, "exhausted-user", "user").await;
        let exhausted = give_package(
            &state,
            &exhausted_id,
            "用尽卡",
            Some(1_000),
            None,
            Some(vec![node.clone()]),
        )
        .await;
        user_packages::set_used_bytes(&state.db.pool, &exhausted.id, 1_000)
            .await
            .unwrap();
        repo::users::add_used_bytes(&state.db.pool, &exhausted_id, 1_000)
            .await
            .unwrap();

        let (disabled_id, disabled_cookie) = make_user(&state, "disabled-user", "user").await;
        let disabled = give_package(
            &state,
            &disabled_id,
            "停用账号卡",
            Some(1_000),
            None,
            Some(vec![node.clone()]),
        )
        .await;
        // 账号仍能登录（否则请求是 401），停用的是他的套餐实例：状态必须是 disabled。
        user_packages::update(
            &state.db.pool,
            &disabled.id,
            user_packages::UpdateUserPackage {
                status: Some("disabled".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let (_, no_package_cookie) = make_user(&state, "no-package", "user").await;

        let app = crate::app::router(state.clone());

        let (status, body) = get(&app, Some(&active_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["usage"]["status"], "active");
        assert_eq!(body["usage"]["days_left"], 30);
        assert_eq!(body["usage"]["remaining_bytes"], 1_000);
        assert_eq!(body["nodes"].as_array().unwrap().len(), 1);

        let (status, body) = get(&app, Some(&expired_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK, "过期不是错误态：{body}");
        assert_eq!(body["usage"]["status"], "expired");
        assert_eq!(body["usage"]["days_left"], 0);
        assert!(body["package"].is_object());

        let (status, body) = get(&app, Some(&exhausted_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["usage"]["status"], "exhausted");
        assert_eq!(body["usage"]["remaining_bytes"], 0);

        let (status, body) = get(&app, Some(&disabled_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK, "禁用不是 403：{body}");
        assert_eq!(body["usage"]["status"], "disabled");
        assert_eq!(body["nodes"].as_array().unwrap().len(), 0);

        let (status, body) = get(&app, Some(&no_package_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK, "无套餐不能崩：{body}");
        assert!(body["package"].is_null(), "{body}");
        assert_eq!(body["usage"]["status"], "none");
        assert_eq!(body["usage"]["used_bytes"], 0);
        assert!(body["usage"]["remaining_bytes"].is_null());
        assert!(body["usage"]["days_left"].is_null());
        assert_eq!(body["nodes"].as_array().unwrap().len(), 0);
    }

    /// 重置订阅：只换自己的短码、旧链接立即 404、写审计。
    #[tokio::test]
    async fn reset_subscription_rotates_only_own_token_and_audits() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let (alice_id, alice_cookie) = make_user(&state, "alice", "user").await;
        let (bob_id, _bob_cookie) = make_user(&state, "bob", "user").await;
        let (_, node) = make_server_node(&state, "hk", "n1").await;
        give_package(
            &state,
            &alice_id,
            "卡",
            Some(1_000),
            None,
            Some(vec![node.clone()]),
        )
        .await;
        give_package(
            &state,
            &bob_id,
            "卡",
            Some(1_000),
            None,
            Some(vec![node.clone()]),
        )
        .await;

        let alice = repo::users::find_by_id(&state.db.pool, &alice_id)
            .await
            .unwrap();
        let old_code = alice.short_code.clone();
        let bob_code = repo::users::find_by_id(&state.db.pool, &bob_id)
            .await
            .unwrap()
            .short_code;
        let app = crate::app::router(state.clone());

        let (status, body) = post(
            &app,
            Some(&alice_cookie),
            "/api/v1/me/subscription/reset",
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let new_url = body["url"].as_str().unwrap();
        assert!(new_url.starts_with("/api/v1/sub/"), "{body}");
        let new_code = new_url.trim_start_matches("/api/v1/sub/").to_string();
        assert_ne!(new_code, old_code, "必须换一个新短码");
        assert!(body["updated_at"].as_i64().unwrap() > 0);

        // 旧 token 立即失效，新 token 可用。
        let (status, _, _) = sub_get(&app, &old_code, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "旧订阅链接必须立即失效");
        let (status, _, _) = sub_get(&app, &new_code, None).await;
        assert_eq!(status, StatusCode::OK, "新订阅链接必须可用");

        // 只对自己生效。
        let bob_after = repo::users::find_by_id(&state.db.pool, &bob_id)
            .await
            .unwrap();
        assert_eq!(bob_after.short_code, bob_code, "不能改到别人");
        let (status, _, _) = sub_get(&app, &bob_code, None).await;
        assert_eq!(status, StatusCode::OK);

        // summary 立即反映新链接。
        let (status, body) = get(&app, Some(&alice_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["subscription"]["url"]
            .as_str()
            .unwrap()
            .ends_with(&new_code));

        // 审计：动作与目标都必须是本人。
        let row: (String, Option<String>) = sqlx::query_as(
            "SELECT action, target FROM audit_log WHERE actor_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .bind(&alice_id)
        .fetch_one(&state.db.pool)
        .await
        .unwrap();
        assert_eq!(row.0, "user.reset_subscription");
        assert_eq!(row.1.as_deref(), Some(alice_id.as_str()));
    }

    /// 订阅链接必须能直接用于全部 13 种对用户展示的格式（前端只负责拼 `?target=`）。
    #[tokio::test]
    async fn subscription_url_works_for_every_supported_format() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let (alice_id, alice_cookie) = make_user(&state, "alice", "user").await;
        let (_, node) = make_server_node(&state, "hk", "n1").await;
        give_package(
            &state,
            &alice_id,
            "卡",
            Some(1_000),
            None,
            Some(vec![node.clone()]),
        )
        .await;
        let app = crate::app::router(state.clone());

        let (status, body) = get(&app, Some(&alice_cookie), "/api/v1/me/summary").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let url = body["subscription"]["url"].as_str().unwrap().to_string();
        let code = url.trim_start_matches("/api/v1/sub/").to_string();

        for format in [
            "clash",
            "mihomo",
            "stash",
            "surge",
            "egern",
            "surfboard",
            "loon",
            "qx",
            "singbox",
            "shadowrocket",
            "v2ray",
            "singbox-full",
            "surge-full",
        ] {
            let (status, _, rendered) = sub_get(&app, &code, Some(format)).await;
            assert_eq!(status, StatusCode::OK, "格式 {format} 应可用：{rendered}");
            assert!(!rendered.is_empty(), "格式 {format} 不应返回空内容");
        }
    }

    #[tokio::test]
    async fn all_me_endpoints_require_login() {
        let (app, _, _, _) = setup().await;
        for uri in [
            "/api/v1/me/summary",
            "/api/v1/me/traffic",
            "/api/v1/me/events",
        ] {
            let (status, _) = get(&app, None, uri).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
        }
        let (status, _) = post(&app, None, "/api/v1/me/subscription/reset", json!({})).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    /// 订阅端点直接返回文本（YAML/URI/JSON），这里复用一个只取状态与 body 的辅助函数。
    async fn sub_get(
        app: &Router,
        short_code: &str,
        target: Option<&str>,
    ) -> (StatusCode, axum::http::HeaderMap, String) {
        let uri = match target {
            Some(target) => format!("/api/v1/sub/{short_code}?target={target}"),
            None => format!("/api/v1/sub/{short_code}"),
        };
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (status, headers, String::from_utf8_lossy(&bytes).to_string())
    }

    /// 事件条数上限参数与管理员接口同款：非法值 400，越界夹到 1..=200。
    #[tokio::test]
    async fn me_events_limit_is_validated() {
        let (app, state, cookie, alice_id) = setup().await;
        for index in 0..3 {
            record_event(&state, "removed", &alice_id, &format!("alice-{index}")).await;
        }

        let (status, body) = get(&app, Some(&cookie), "/api/v1/me/events?limit=2").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 2);

        let (status, body) = get(&app, Some(&cookie), "/api/v1/me/events?limit=abc").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
}
