use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("未登录")]
    Unauthorized,
    #[error("用户名或密码错误")]
    InvalidCredentials,
    #[error("权限不足")]
    Forbidden,
    #[error("{0}")]
    BadRequest(String),
    #[error("资源不存在")]
    NotFound,
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

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::Unauthorized | AppError::InvalidCredentials => StatusCode::UNAUTHORIZED,
            AppError::Forbidden => StatusCode::FORBIDDEN,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::Internal(e) => {
                tracing::error!(error = %e, "internal error");
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        let message = match &self {
            AppError::Internal(_) => "服务器内部错误".to_string(),
            other => other.to_string(),
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
