//! 审计日志读取：管理员专用，按时间倒序。
//!
//! `detail` 在库里是 JSON 文本，对外直接返回解析后的对象，前端不用二次 parse。

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DEFAULT_LIMIT: i64 = 100;
const MAX_LIMIT: i64 = 500;

#[derive(Deserialize)]
pub struct AuditQuery {
    /// 手写解析成字符串：非法整数也要回中文 400，而不是 axum 的纯文本拒绝。
    pub limit: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<AuditQuery>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let limit = match query.limit.as_deref() {
        None => DEFAULT_LIMIT,
        Some(raw) => raw.parse::<i64>().map_err(|_| {
            AppError::coded(
                "query.limit_invalid",
                Some(json!({ "max": MAX_LIMIT })),
                "limit 必须是整数",
            )
        })?,
    };
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(AppError::coded(
            "query.limit_out_of_range",
            Some(json!({ "min": 1, "max": MAX_LIMIT })),
            format!("limit 必须在 1-{MAX_LIMIT} 之间"),
        ));
    }

    let items = repo::audit::list(&state.db.pool, limit).await?;
    Ok(Json(json!({ "items": items })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::repo::nodes::{self, NewNode};
    use pierwave_domain::repo::users::{self, NewUser};
    use pierwave_domain::Db;

    async fn setup() -> (Router, AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = users::create(
            &db.pool,
            NewUser {
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

    async fn request(
        app: &Router,
        cookie: Option<&str>,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    async fn audit_items(app: &Router, admin: &str) -> Vec<Value> {
        let (status, body) = request(app, Some(admin), Method::GET, "/api/v1/audit", None).await;
        assert_eq!(status, StatusCode::OK, "读审计失败：{body}");
        body["items"].as_array().unwrap().clone()
    }

    fn find_action<'a>(items: &'a [Value], action: &str) -> &'a Value {
        items
            .iter()
            .find(|item| item["action"] == action)
            .unwrap_or_else(|| panic!("没有 {action} 记录：{items:?}"))
    }

    #[tokio::test]
    async fn user_create_is_audited_with_actor_name() {
        let (app, _state, admin) = setup().await;

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/users",
            Some(json!({"username": "alice", "password": "password123"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let alice_id = body["user"]["id"].as_str().unwrap();

        let items = audit_items(&app, &admin).await;
        let entry = find_action(&items, "user.create");
        assert_eq!(entry["target"], alice_id);
        assert_eq!(entry["actor_name"], "admin");
        assert_eq!(entry["detail"]["username"], "alice");
        assert_eq!(entry["detail"]["role"], "user");
        assert!(
            entry["detail"].get("password").is_none(),
            "detail 不能出现密码"
        );
    }

    #[tokio::test]
    async fn package_scope_change_is_recorded_in_detail() {
        let (app, state, admin) = setup().await;

        // 两个节点：套餐范围只能引用真实存在的节点。
        let (server, _token) = repo::servers::create(&state.db.pool, "s1", "10.0.0.1", "external")
            .await
            .unwrap();
        let mut node_ids = Vec::new();
        for (tag, port) in [("n1", 10001), ("n2", 10002)] {
            let node = nodes::create(
                &state.db.pool,
                &server.id,
                NewNode {
                    tag: Some(tag.into()),
                    name: tag.into(),
                    protocol: "trojan".into(),
                    transport: "tcp".into(),
                    security: "none".into(),
                    port,
                    config_json: "{}".into(),
                    enabled: true,
                    cert_id: None,
                },
            )
            .await
            .unwrap();
            node_ids.push(node.id);
        }

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "月卡", "quota_bytes": 1000})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let package_id = body["package"]["id"].as_str().unwrap().to_string();
        assert_eq!(body["package"]["node_scope"], "all");

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": node_ids})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_scope"], "custom");

        let items = audit_items(&app, &admin).await;
        let entry = find_action(&items, "package.update");
        assert_eq!(entry["target"], package_id);
        let scope = &entry["detail"]["node_scope"];
        assert_eq!(scope["from"], "all", "detail: {entry}");
        assert_eq!(scope["to"], "custom", "detail: {entry}");
        assert_eq!(entry["detail"]["node_count"]["to"], 2);
    }

    #[tokio::test]
    async fn server_delete_is_audited() {
        let (app, _state, admin) = setup().await;

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/servers",
            Some(json!({"name": "待删服务器", "address": "10.0.0.9"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let server_id = body["server"]["id"].as_str().unwrap().to_string();

        let (status, _) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/servers/{server_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let items = audit_items(&app, &admin).await;
        let entry = find_action(&items, "server.delete");
        assert_eq!(entry["target"], server_id);
        assert_eq!(entry["detail"]["name"], "待删服务器");
    }

    #[tokio::test]
    async fn audit_endpoint_guards_limit_and_order() {
        let (app, state, admin) = setup().await;

        // 普通用户 → 403。
        let bob = users::create(
            &state.db.pool,
            NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&state.db.pool, &bob.id, 3600, None)
            .await
            .unwrap();
        let bob_cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);
        let (status, body) =
            request(&app, Some(&bob_cookie), Method::GET, "/api/v1/audit", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");

        // 未登录 → 401。
        let (status, _) = request(&app, None, Method::GET, "/api/v1/audit", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        // limit 越界 / 非整数 → 400 + 中文。
        for raw in ["0", "501", "-1", "abc"] {
            let (status, body) = request(
                &app,
                Some(&admin),
                Method::GET,
                &format!("/api/v1/audit?limit={raw}"),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "limit={raw}");
            let error = body["error"].as_str().unwrap();
            assert!(!error.is_empty(), "limit={raw}");
            assert!(error.contains("limit"), "错误信息应说明 limit：{error}");
        }

        // 边界值 1 / 500 可用。
        for raw in ["1", "500"] {
            let (status, _) = request(
                &app,
                Some(&admin),
                Method::GET,
                &format!("/api/v1/audit?limit={raw}"),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "limit={raw}");
        }

        // 连续三次写操作：最新一条排在最前，整体时间戳非递增。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/users",
            Some(json!({"username": "charlie", "password": "password123"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let charlie_id = body["user"]["id"].as_str().unwrap().to_string();
        let (status, _) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/users/{charlie_id}"),
            Some(json!({"status": "disabled"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/users/{charlie_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let items = audit_items(&app, &admin).await;
        assert_eq!(items[0]["action"], "user.delete", "最新记录应在最前");
        assert!(items.len() >= 3);
        let timestamps: Vec<i64> = items
            .iter()
            .map(|item| item["created_at"].as_i64().unwrap())
            .collect();
        assert!(
            timestamps.windows(2).all(|pair| pair[0] >= pair[1]),
            "created_at 应按时间倒序：{timestamps:?}"
        );
    }
}
