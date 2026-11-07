use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

/// 面向用户的错误。
///
/// `error` 字段永远是中文兜底文案；`code`（稳定标识）与 `params`（插值参数）
/// 是可选的，未提供时不会出现在 JSON 里，因此旧前端看到的响应形状不变。
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
    /// 旧的无 code 错误形状。路由已全部改用 [`AppError::Coded`]；保留该变体
    /// 是为了验证「没有 code 时响应里不出现 code/params」，也方便后续接入
    /// 尚未带 code 的内部调用方。
    #[allow(dead_code)]
    #[error("{0}")]
    BadRequest(String),
    #[error("资源不存在")]
    NotFound,
    /// 登录失败次数过多；携带建议的重试秒数（`Retry-After`）。
    #[error("尝试过于频繁，请稍后再试")]
    TooManyAttempts(u64),
    /// 带稳定错误码的响应。`message` 是中文兜底，`code` 供前端查词典，
    /// `params` 只放需要插值的短值。
    #[error("{message}")]
    Coded {
        status: StatusCode,
        code: &'static str,
        params: Option<Value>,
        message: String,
    },
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    /// 400 + 稳定错误码；`params` 传 `None` 时响应里不出现该字段。
    pub fn coded(code: &'static str, params: Option<Value>, message: impl Into<String>) -> Self {
        Self::with_status(StatusCode::BAD_REQUEST, code, params, message)
    }

    pub fn forbidden(
        code: &'static str,
        params: Option<Value>,
        message: impl Into<String>,
    ) -> Self {
        Self::with_status(StatusCode::FORBIDDEN, code, params, message)
    }

    pub fn not_found(
        code: &'static str,
        params: Option<Value>,
        message: impl Into<String>,
    ) -> Self {
        Self::with_status(StatusCode::NOT_FOUND, code, params, message)
    }

    /// 目前没有写站点返回 409；保留构造器是因为「已存在」类冲突属于稳定错误族，
    /// 前端词典需要这一档，后续新增并发冲突接口时可直接使用。
    #[allow(dead_code)]
    pub fn conflict(code: &'static str, params: Option<Value>, message: impl Into<String>) -> Self {
        Self::with_status(StatusCode::CONFLICT, code, params, message)
    }

    pub fn unauthorized(
        code: &'static str,
        params: Option<Value>,
        message: impl Into<String>,
    ) -> Self {
        Self::with_status(StatusCode::UNAUTHORIZED, code, params, message)
    }

    pub fn service_unavailable(
        code: &'static str,
        params: Option<Value>,
        message: impl Into<String>,
    ) -> Self {
        Self::with_status(StatusCode::SERVICE_UNAVAILABLE, code, params, message)
    }

    fn with_status(
        status: StatusCode,
        code: &'static str,
        params: Option<Value>,
        message: impl Into<String>,
    ) -> Self {
        Self::Coded {
            status,
            code,
            params,
            message: message.into(),
        }
    }
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
        // (status, message, code, params, Retry-After 秒数)
        let (status, message, code, params, retry_after): (
            StatusCode,
            String,
            Option<&'static str>,
            Option<Value>,
            Option<u64>,
        ) = match &self {
            // 这几个固定含义的错误在枚举层就带 code：中间件（`auth.rs`）里
            // 直接构造的 401/403 也能被前端翻译，不需要改中间件。
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                self.to_string(),
                Some("auth.unauthorized"),
                None,
                None,
            ),
            AppError::InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                self.to_string(),
                Some("auth.invalid_credentials"),
                None,
                None,
            ),
            AppError::WrongPassword => (
                StatusCode::UNAUTHORIZED,
                self.to_string(),
                Some("auth.wrong_password"),
                None,
                None,
            ),
            AppError::Forbidden => (
                StatusCode::FORBIDDEN,
                self.to_string(),
                Some("auth.forbidden"),
                None,
                None,
            ),
            AppError::BadRequest(_) => {
                (StatusCode::BAD_REQUEST, self.to_string(), None, None, None)
            }
            AppError::NotFound => (
                StatusCode::NOT_FOUND,
                self.to_string(),
                Some("common.resource_not_found"),
                None,
                None,
            ),
            AppError::TooManyAttempts(secs) => {
                let minutes = (*secs).div_ceil(60).max(1);
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    format!("尝试过于频繁，请 {minutes} 分钟后再试"),
                    Some("auth.too_many_attempts"),
                    Some(json!({ "retry_after_secs": secs, "minutes": minutes })),
                    Some(*secs),
                )
            }
            AppError::Coded {
                status,
                code,
                params,
                message,
            } => (*status, message.clone(), Some(*code), params.clone(), None),
            AppError::Internal(e) => {
                tracing::error!(error = %e, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "服务器内部错误".to_string(),
                    None,
                    None,
                    None,
                )
            }
        };

        let mut body = serde_json::Map::new();
        body.insert("error".to_string(), Value::String(message));
        if let Some(code) = code {
            body.insert("code".to_string(), Value::String(code.to_string()));
        }
        if let Some(params) = params {
            body.insert("params".to_string(), params);
        }

        let mut response = (status, Json(Value::Object(body))).into_response();
        if let Some(secs) = retry_after {
            if let Ok(value) = HeaderValue::from_str(&secs.to_string()) {
                response.headers_mut().insert(header::RETRY_AFTER, value);
            }
        }
        response
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    async fn render(error: AppError) -> (StatusCode, Value) {
        let response = error.into_response();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body = serde_json::from_slice(&bytes).unwrap();
        (status, body)
    }

    #[tokio::test]
    async fn coded_error_has_error_code_and_params() {
        let (status, body) = render(AppError::coded(
            "agent.upgrade.not_newer",
            Some(json!({ "current": "0.5.3", "target": "0.5.2" })),
            "目标版本必须比当前版本新",
        ))
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "目标版本必须比当前版本新");
        assert_eq!(body["code"], "agent.upgrade.not_newer");
        assert_eq!(
            body["params"],
            json!({ "current": "0.5.3", "target": "0.5.2" })
        );
    }

    #[tokio::test]
    async fn coded_error_without_params_omits_params() {
        let (status, body) =
            render(AppError::not_found("user.not_found", None, "资源不存在")).await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "资源不存在");
        assert_eq!(body["code"], "user.not_found");
        assert!(body.get("params").is_none());
    }

    #[tokio::test]
    async fn uncoded_error_keeps_legacy_shape() {
        let (status, body) = render(AppError::BadRequest("旧文案".into())).await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "旧文案");
        assert!(body.get("code").is_none());
        assert!(body.get("params").is_none());
    }

    #[tokio::test]
    async fn coded_family_constructors_use_their_status() {
        for (error, expected) in [
            (
                AppError::forbidden("auth.account_disabled", None, "权限不足"),
                StatusCode::FORBIDDEN,
            ),
            (
                AppError::conflict("user.username_taken", None, "用户名已存在"),
                StatusCode::CONFLICT,
            ),
            (
                AppError::unauthorized("auth.unauthorized", None, "未登录"),
                StatusCode::UNAUTHORIZED,
            ),
            (
                AppError::service_unavailable("install.release_unavailable", None, "暂不可用"),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ] {
            let (status, body) = render(error).await;
            assert_eq!(status, expected);
            assert!(body["code"].is_string(), "{body}");
        }
    }
}
