use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::cookie::CookieJar;

use mmrust_domain::models::User;

use crate::error::AppError;
use crate::state::AppState;

pub const SESSION_COOKIE: &str = "mmrust_session";

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
        let user = mmrust_domain::repo::sessions::user_for_token(&state.db.pool, &token)
            .await?
            .ok_or(AppError::Unauthorized)?;
        Ok(CurrentUser(user))
    }
}

pub fn session_cookie(token: String) -> axum_extra::extract::cookie::Cookie<'static> {
    axum_extra::extract::cookie::Cookie::build((SESSION_COOKIE, token))
        .http_only(true)
        .same_site(axum_extra::extract::cookie::SameSite::Lax)
        .path("/")
        .max_age(time::Duration::days(30))
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
