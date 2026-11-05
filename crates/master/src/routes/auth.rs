use axum::extract::State;
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::json;

use mmrust_domain::models::SessionUser;
use mmrust_domain::{password, repo};

use crate::auth::{clear_cookie, session_cookie, CurrentUser, SESSION_COOKIE};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<LoginRequest>,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    let user = repo::users::find_by_username(&state.db.pool, &req.username)
        .await?
        .ok_or(AppError::InvalidCredentials)?;
    if !password::verify(&req.password, &user.password_hash) {
        return Err(AppError::InvalidCredentials);
    }
    if user.status != "active" {
        return Err(AppError::Forbidden);
    }
    let (token, _) = repo::sessions::create(&state.db.pool, &user.id, 30 * 24 * 3600, None).await?;
    let body = json!({
        "user": SessionUser {
            id: user.id.clone(),
            username: user.username.clone(),
            role: user.role.clone(),
            short_code: user.short_code.clone(),
        }
    });
    Ok((jar.add(session_cookie(token)), Json(body)))
}

pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        repo::sessions::delete_by_token(&state.db.pool, cookie.value()).await?;
    }
    Ok((jar.add(clear_cookie()), Json(json!({ "ok": true }))))
}

pub async fn me(user: CurrentUser) -> Json<serde_json::Value> {
    Json(json!({
        "user": SessionUser {
            id: user.0.id,
            username: user.0.username,
            role: user.0.role,
            short_code: user.0.short_code,
        }
    }))
}
