//! 断流事件查询：`GET /api/v1/enforcement/events`。
//!
//! 只读：事件由后台去抖 apply 在「用户真的从配置里消失」时写入，
//! 前端以后用它展示「谁、因为什么、什么时候被断流」。

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use mmrust_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

#[derive(Deserialize)]
pub struct EventsQuery {
    /// 返回条数；缺省 50，超出 1..=200 时夹到边界。
    pub limit: Option<String>,
}

pub async fn events(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<EventsQuery>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let limit = match query.limit.as_deref() {
        None => DEFAULT_LIMIT,
        Some(raw) => raw
            .trim()
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest(format!("limit 必须是 1-{MAX_LIMIT} 的整数")))?,
    }
    .clamp(1, MAX_LIMIT);

    let items = repo::enforcement::list_events(&state.db.pool, limit).await?;
    Ok(Json(json!({ "items": items })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use mmrust_domain::Db;

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
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    #[tokio::test]
    async fn admin_lists_events_newest_first_with_limit() {
        let (app, state, cookie) = setup().await;
        for user in ["alice", "bob", "carol"] {
            repo::enforcement::insert_event(
                &state.db.pool,
                repo::enforcement::NewEvent {
                    kind: "removed",
                    user_id: "user-1",
                    username: user,
                    server_id: "server-1",
                    server_name: "hk-1",
                    reason: "exhausted",
                    message: &format!("用户 {user} 因额度用尽，已从服务器 hk-1 的配置中移除"),
                },
            )
            .await
            .unwrap();
        }

        let (status, body) = get(&app, Some(&cookie), "/api/v1/enforcement/events?limit=2").await;
        assert_eq!(status, StatusCode::OK);
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["username"], "carol", "最新事件排在最前");
        assert_eq!(items[1]["username"], "bob");
        assert_eq!(items[0]["kind"], "removed");
        assert!(items[0]["message"]
            .as_str()
            .unwrap()
            .contains("已从服务器 hk-1 的配置中移除"));

        let (status, body) = get(&app, Some(&cookie), "/api/v1/enforcement/events").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"].as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn events_require_admin() {
        let (app, state, _admin_cookie) = setup().await;
        let user = repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&state.db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);

        let (status, body) = get(&app, None, "/api/v1/enforcement/events").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "未登录");

        let (status, body) = get(&app, Some(&cookie), "/api/v1/enforcement/events").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");
    }

    #[tokio::test]
    async fn invalid_limit_is_chinese_400() {
        let (app, _state, cookie) = setup().await;
        let (status, body) = get(&app, Some(&cookie), "/api/v1/enforcement/events?limit=abc").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("limit"));
    }
}
