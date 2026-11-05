use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::cookie::CookieJar;

use pierwave_domain::models::User;

use crate::error::AppError;
use crate::state::AppState;

pub const SESSION_COOKIE: &str = "pierwave_session";

/// 从 Cookie 解析当前登录用户；未登录直接 401。
pub struct CurrentUser(pub User);

impl CurrentUser {
    pub fn require_admin(&self) -> Result<(), AppError> {
        if self.0.role == "admin" {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar
            .get(SESSION_COOKIE)
            .map(|c| c.value().to_string())
            .ok_or(AppError::Unauthorized)?;
        let user = pierwave_domain::repo::sessions::user_for_token(&state.db.pool, &token)
            .await?
            .ok_or(AppError::Unauthorized)?;
        Ok(CurrentUser(user))
    }
}

/// 会话 Cookie 的 `Max-Age` 必须与服务端 `sessions.expires_at` 一致，
/// 否则会出现「服务端已过期、浏览器还留着 Cookie」的假登录态。
pub fn session_cookie(
    token: String,
    ttl_secs: i64,
) -> axum_extra::extract::cookie::Cookie<'static> {
    axum_extra::extract::cookie::Cookie::build((SESSION_COOKIE, token))
        .http_only(true)
        .same_site(axum_extra::extract::cookie::SameSite::Lax)
        .path("/")
        .max_age(time::Duration::seconds(ttl_secs.max(0)))
        .build()
}

pub fn clear_cookie() -> axum_extra::extract::cookie::Cookie<'static> {
    axum_extra::extract::cookie::Cookie::build((SESSION_COOKIE, ""))
        .http_only(true)
        .same_site(axum_extra::extract::cookie::SameSite::Lax)
        .path("/")
        .max_age(time::Duration::ZERO)
        .build()
}
