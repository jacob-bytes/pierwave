//! 断流事件查询：`GET /api/v1/enforcement/events`。
//!
//! 只读：事件由后台去抖 apply 在「用户真的从配置里消失」时写入，
//! 前端以后用它展示「谁、因为什么、什么时候被断流」。

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::{repo, time};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

/// 清理范围：至少保留 1 天，最多按 10 年（3650 天）向前；`null` 表示全部。
const CLEANUP_MIN_DAYS: i64 = 1;
const CLEANUP_MAX_DAYS: i64 = 3650;

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
        Some(raw) => raw.trim().parse::<i64>().map_err(|_| {
            AppError::coded(
                "query.limit_invalid",
                Some(json!({ "min": 1, "max": MAX_LIMIT })),
                format!("limit 必须是 1-{MAX_LIMIT} 的整数"),
            )
        })?,
    }
    .clamp(1, MAX_LIMIT);

    let items = repo::enforcement::list_events(&state.db.pool, limit).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CleanupEvents {
    /// 只删除 `created_at < now - days×86400` 的记录；缺省 / `null` = 全部。
    #[serde(default)]
    pub days: Option<i64>,
}

/// 批量清理断流 / 恢复事件，返回 `{ deleted: n }`。
///
/// 删除不可恢复；`deleted = 0` 是正常结果（范围内没有记录），不是错误。
pub async fn cleanup(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<CleanupEvents>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let cutoff = match req.days {
        None => None,
        Some(days) => {
            if !(CLEANUP_MIN_DAYS..=CLEANUP_MAX_DAYS).contains(&days) {
                return Err(AppError::coded(
                    "event.cleanup_days_invalid",
                    Some(json!({
                        "min": CLEANUP_MIN_DAYS,
                        "max": CLEANUP_MAX_DAYS,
                    })),
                    format!(
                        "清理天数必须在 {CLEANUP_MIN_DAYS}-{CLEANUP_MAX_DAYS} 天之间，或选择全部"
                    ),
                ));
            }
            Some(time::now().saturating_sub(days.saturating_mul(time::SECONDS_PER_DAY)))
        }
    };

    let deleted = repo::enforcement::delete_events_before(&state.db.pool, cutoff).await?;

    crate::audit::record(
        &state,
        &user.0,
        "event.cleanup",
        "enforcement_events",
        json!({ "days": req.days, "deleted": deleted }),
    )
    .await;

    Ok(Json(json!({ "deleted": deleted })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use pierwave_domain::Db;

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
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    async fn post(app: &Router, cookie: &str, uri: &str, body: Value) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(uri)
                    .header(header::COOKIE, cookie)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
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

    async fn seed_event(state: &AppState, username: &str, created_at: i64) {
        repo::enforcement::insert_event_at(
            &state.db.pool,
            repo::enforcement::NewEvent {
                kind: "removed",
                user_id: "user-1",
                username,
                server_id: "server-1",
                server_name: "hk-1",
                reason: "expired",
                message: "历史断流事件",
            },
            created_at,
        )
        .await
        .unwrap();
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
                rule_template_id: None,
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

    #[tokio::test]
    async fn cleanup_deletes_only_events_older_than_the_requested_days() {
        let (app, state, cookie) = setup().await;
        let now = time::now();
        seed_event(&state, "alice", now - 10 * time::SECONDS_PER_DAY).await;
        seed_event(&state, "bob", now - 40 * time::SECONDS_PER_DAY).await;
        seed_event(&state, "carol", now - 100 * time::SECONDS_PER_DAY).await;

        let (status, body) = post(
            &app,
            &cookie,
            "/api/v1/enforcement/events/cleanup",
            json!({ "days": 30 }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["deleted"], 2, "只删除 30 天以前的两条");
        assert_eq!(
            repo::enforcement::count_events(&state.db.pool)
                .await
                .unwrap(),
            1,
            "10 天前的记录必须保留"
        );

        // 审计落库：动作、范围与数量，不包含用户名等隐私数据。
        let entries = repo::audit::list(&state.db.pool, 20).await.unwrap();
        let entry = entries
            .iter()
            .find(|entry| entry.action == "event.cleanup")
            .expect("缺少清理审计");
        let detail = entry.detail.as_ref().unwrap();
        assert_eq!(detail["days"], 30);
        assert_eq!(detail["deleted"], 2);
        let serialized = detail.to_string();
        for username in ["alice", "bob", "carol"] {
            assert!(!serialized.contains(username));
        }
        assert_eq!(entry.target.as_deref(), Some("enforcement_events"));

        // 再点一次：范围内已没有记录，返回 0 而不是报错。
        let (status, body) = post(
            &app,
            &cookie,
            "/api/v1/enforcement/events/cleanup",
            json!({ "days": 30 }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], 0);

        // `null` / 缺省 = 全部清理。
        let (status, body) = post(
            &app,
            &cookie,
            "/api/v1/enforcement/events/cleanup",
            json!({ "days": null }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], 1);
        assert_eq!(
            repo::enforcement::count_events(&state.db.pool)
                .await
                .unwrap(),
            0
        );

        // 空库再点一次同样是 0，不是错误。
        let (status, body) = post(
            &app,
            &cookie,
            "/api/v1/enforcement/events/cleanup",
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], 0);
    }

    #[tokio::test]
    async fn cleanup_rejects_invalid_days_and_requires_admin() {
        let (app, state, cookie) = setup().await;
        for days in [0, -1, 3651] {
            let (status, body) = post(
                &app,
                &cookie,
                "/api/v1/enforcement/events/cleanup",
                json!({ "days": days }),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(body["code"], "event.cleanup_days_invalid");
        }

        seed_event(&state, "alice", time::now() - 100 * time::SECONDS_PER_DAY).await;
        let user = repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&state.db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        let normal = format!("{}={token}", crate::auth::SESSION_COOKIE);

        let (status, body) = post(
            &app,
            &normal,
            "/api/v1/enforcement/events/cleanup",
            json!({ "days": 30 }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");
        assert_eq!(
            repo::enforcement::count_events(&state.db.pool)
                .await
                .unwrap(),
            1,
            "非管理员请求不能删除任何记录"
        );
    }
}
