//! 用户端自助接口：所有数据都以会话用户为准，忽略任何传入的身份参数。

use axum::extract::{Query, State};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::{password, repo};

use crate::auth::{CurrentUser, SESSION_COOKIE};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub async fn summary(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    let view = repo::users::view_by_id(&state.db.pool, &user.0.id)
        .await?
        .ok_or(AppError::NotFound)?;
    let now = repo::now();
    let (today_bytes, month_bytes) =
        repo::stats::subject_totals(&state.db.pool, &view.id, now).await?;

    Ok(Json(json!({
        "user": {
            "id": view.id,
            "username": view.username,
            "role": view.role,
            "short_code": view.short_code,
            "used_bytes": view.used_bytes,
            "quota_bytes": view.quota_bytes,
            "quota_exceeded": view.quota_exceeded,
        },
        "packages": view.packages,
        "traffic": { "today_bytes": today_bytes, "month_bytes": month_bytes },
        "subscription_url": format!("/api/v1/sub/{}", view.short_code),
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
        return Err(AppError::BadRequest("days 需在 1-90 之间".into()));
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
        return Err(AppError::BadRequest("新密码至少 8 位".into()));
    }

    if !repo::users::set_password(&state.db.pool, &user.0.id, &req.new_password).await? {
        return Err(AppError::NotFound);
    }

    let token = jar
        .get(SESSION_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or(AppError::Unauthorized)?;
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
}
