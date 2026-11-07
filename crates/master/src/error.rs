use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("未登录")]
    Unauthorized,
    #[error("用户名或密码错误")]
    InvalidCredentials,
    #[error("旧密码错误")]
    WrongPassword,
    #[error("权限不足")]
    Forbidden,
    #[error("{0}")]
    BadRequest(String),
    #[error("资源不存在")]
    NotFound,
    /// 登录失败次数过多；携带建议的重试秒数（`Retry-After`）。
    #[error("尝试过于频繁，请稍后再试")]
    TooManyAttempts(u64),
    /// 上游暂时不可用（例如回源 GitHub 失败且本地无缓存）。
    #[error("{0}")]
    ServiceUnavailable(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => AppError::NotFound,
            other => AppError::Internal(other.into()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Internal(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message, retry_after) = match &self {
            AppError::Unauthorized | AppError::InvalidCredentials | AppError::WrongPassword => {
                (StatusCode::UNAUTHORIZED, self.to_string(), None)
            }
            AppError::Forbidden => (StatusCode::FORBIDDEN, self.to_string(), None),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string(), None),
            AppError::NotFound => (StatusCode::NOT_FOUND, self.to_string(), None),
            AppError::ServiceUnavailable(_) => {
                (StatusCode::SERVICE_UNAVAILABLE, self.to_string(), None)
            }
            AppError::TooManyAttempts(secs) => {
                let minutes = (*secs).div_ceil(60).max(1);
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    format!("尝试过于频繁，请 {minutes} 分钟后再试"),
                    Some(*secs),
                )
            }
            AppError::Internal(e) => {
                tracing::error!(error = %e, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "服务器内部错误".to_string(),
                    None,
                )
            }
        };

        let mut response = (status, Json(json!({ "error": message }))).into_response();
        if let Some(secs) = retry_after {
            if let Ok(value) = HeaderValue::from_str(&secs.to_string()) {
                response.headers_mut().insert(header::RETRY_AFTER, value);
            }
        }
        response
    }
}

pub type AppResult<T> = Result<T, AppError>;
