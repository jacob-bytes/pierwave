use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use pierwave_domain::error::DomainError;
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
    Internal(anyhow::Error),
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

    /// 409：并发冲突（服务器仍被链引用、数据库写锁等待超时等）。
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

    /// 429：API Token 限流。`retry_after` 同时进响应头与 `params`。
    pub fn too_many_requests(
        code: &'static str,
        retry_after: u64,
        message: impl Into<String>,
    ) -> Self {
        Self::with_status(
            StatusCode::TOO_MANY_REQUESTS,
            code,
            Some(json!({ "retry_after_secs": retry_after })),
            message,
        )
    }

    /// 502：上游依赖（这里指远端 WebDAV）返回失败或不可达。
    pub fn bad_gateway(
        code: &'static str,
        params: Option<Value>,
        message: impl Into<String>,
    ) -> Self {
        Self::with_status(StatusCode::BAD_GATEWAY, code, params, message)
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

    /// 从任意 `anyhow::Error` 的错误链里抽出 [`DomainError`]。
    ///
    /// 领域层用 `anyhow::Context` 包装过也能取到；取不到返回 `None`，由调用方
    /// 保留原有映射（500 或特定 4xx）。
    pub fn from_domain_chain(error: &anyhow::Error) -> Option<Self> {
        error
            .chain()
            .find_map(|cause| cause.downcast_ref::<DomainError>())
            .map(|domain| Self::coded(domain.code, domain.params_option(), domain.message.clone()))
    }
}

/// 所有 `?` 的默认入口：错误链里有 `DomainError` 就转成带 code 的 400，
/// 其余保持原来的 500。
/// SQLite 写锁等待超时（`database is locked` / `database table is locked`）。
///
/// 这类错误是并发争用而不是服务端 bug：映射成 409 + 可读文案，前端可以提示
/// 「稍后重试」，而不是把 500 直接甩给用户。
fn is_database_locked(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let message = cause.to_string().to_ascii_lowercase();
        if let Some(sqlx::Error::Database(database)) = cause.downcast_ref::<sqlx::Error>() {
            if database.code().as_deref() == Some("5") {
                return true;
            }
        }
        message.contains("database is locked")
            || message.contains("database table is locked")
            || message.contains("database schema is locked")
    })
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        if let Some(error) = Self::from_domain_chain(&error) {
            return error;
        }
        if is_database_locked(&error) {
            return AppError::conflict(
                "request.busy",
                None,
                "数据库繁忙，请稍后重试（并发写入未能在等待时间内完成）",
            );
        }
        AppError::Internal(error)
    }
}

/// 领域校验函数直接返回 `DomainError` 时，`?` 也能落成 400。
impl From<DomainError> for AppError {
    fn from(error: DomainError) -> Self {
        Self::from(anyhow::Error::new(error))
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => AppError::NotFound,
            other => AppError::from(anyhow::Error::new(other)),
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
            } => {
                // 429 的 `retry_after_secs` 同时写回 `Retry-After` 头，
                // 客户端不必解析 body 就能按建议重试。
                let retry_after = (*status == StatusCode::TOO_MANY_REQUESTS)
                    .then(|| {
                        params
                            .as_ref()
                            .and_then(|params| params.get("retry_after_secs"))
                            .and_then(Value::as_u64)
                    })
                    .flatten();
                (
                    *status,
                    message.clone(),
                    Some(*code),
                    params.clone(),
                    retry_after,
                )
            }
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

/// 请求体 JSON 解析失败时的固定文案（中英双语，可直接展示）。
const INVALID_JSON_MESSAGE: &str = "请求体不是合法的 JSON，或某个字段类型不匹配（例如整数 / 数字字段不能传空串；清空请发 null） / Request body is not valid JSON, or a field has the wrong type (e.g. an integer field cannot receive an empty string; send null to clear it)";

/// 把 axum `Json` 提取器产生的 422 纯文本改写成统一错误信封。
///
/// 这是**全局通用**的一层（在 `app::router` 上以中间件注册），不是给某个端点
/// 打的补丁：任何路由的请求体反序列化失败都会得到
/// `{ error, code: "request.invalid_json", params.detail }`，前端可以按 code
/// 翻译。HTTP 状态保持 422（axum 对「JSON 合法但类型不匹配」的既有语义），
/// 已有客户端不需要改判断。
///
/// 只改写 `text/plain` 的 422：正常业务错误即使碰巧返回 422 也已经有自己的
/// JSON body，不能被覆盖。
pub async fn map_json_rejections(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    rewrite_json_rejection(response).await
}

async fn rewrite_json_rejection(response: Response) -> Response {
    if response.status() != StatusCode::UNPROCESSABLE_ENTITY {
        return response;
    }
    let is_plain_text = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/plain"));
    if !is_plain_text {
        return response;
    }

    // 原始 detail 放进 params：前端不需要翻译它，排查时能直接看到哪个字段出错。
    let (mut parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, 64 * 1024)
        .await
        .unwrap_or_default();
    let detail = String::from_utf8_lossy(&bytes).trim().to_string();
    let mut params = serde_json::Map::new();
    if !detail.is_empty() {
        params.insert("detail".to_string(), Value::String(detail));
    }
    let body = json!({
        "error": INVALID_JSON_MESSAGE,
        "code": "request.invalid_json",
        "params": Value::Object(params),
    });
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Response::from_parts(parts, Body::from(body.to_string()))
}

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

    #[tokio::test]
    async fn domain_error_in_anyhow_chain_becomes_coded_400() {
        let error: anyhow::Error = anyhow::Error::new(DomainError::with_params(
            "backup.restore_too_large",
            json!({ "max_mb": 512 }),
            "备份文件超过 512 MB 上限",
        ))
        .context("上传备份校验失败");

        let (status, body) = render(AppError::from(error)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "备份文件超过 512 MB 上限");
        assert_eq!(body["code"], "backup.restore_too_large");
        assert_eq!(body["params"], json!({ "max_mb": 512 }));
    }

    #[tokio::test]
    async fn domain_error_converts_directly_for_question_mark() {
        let app_error: AppError =
            DomainError::new("routing_rule.match_required", "路由规则至少要填写一项").into();
        let (status, body) = render(app_error).await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "routing_rule.match_required");
        assert!(body.get("params").is_none(), "{body}");
    }

    #[tokio::test]
    async fn database_lock_errors_become_a_readable_409() {
        for message in [
            "database is locked",
            "database table is locked",
            "database schema is locked",
        ] {
            let (status, body) = render(AppError::from(anyhow::anyhow!(message.to_string()))).await;
            assert_eq!(status, StatusCode::CONFLICT, "{message}");
            assert_eq!(body["code"], "request.busy", "{message}: {body}");
            assert!(
                body["error"].as_str().unwrap().contains("稍后重试"),
                "{message}: {body}"
            );
        }

        // sqlx 包一层也必须在错误链里被识别，而不是变成 500。
        let error = sqlx::Error::Protocol("database is locked".into());
        let (status, body) = render(AppError::from(error)).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "request.busy");
    }

    #[tokio::test]
    async fn plain_anyhow_error_still_maps_to_internal() {
        let (status, body) = render(AppError::from(anyhow::anyhow!("读取磁盘失败"))).await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(body.get("code").is_none(), "{body}");
        assert_eq!(body["error"], "服务器内部错误");
    }

    /// 任何路由的 `Json<T>` 反序列化失败都会落成这一个信封，而不是 422 纯文本。
    #[tokio::test]
    async fn json_rejection_422_is_rewritten_to_a_coded_envelope() {
        let response = (
            StatusCode::UNPROCESSABLE_ENTITY,
            [(
                header::CONTENT_TYPE,
                "text/plain; charset=utf-8".to_string(),
            )],
            "Failed to deserialize the JSON body into the target type: \
             price_cents: invalid type: string \"\", expected i64",
        )
            .into_response();
        let response = rewrite_json_rejection(response).await;

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(response
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("application/json"));
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "request.invalid_json", "{body}");
        assert!(
            body["error"].as_str().unwrap().contains("请求体")
                && body["error"].as_str().unwrap().contains("Request body"),
            "错误文案必须中英双语：{body}"
        );
        assert!(
            body["params"]["detail"]
                .as_str()
                .unwrap()
                .contains("price_cents"),
            "原始 detail 必须保留：{body}"
        );
    }

    /// 只改写 text/plain 的 422：其它状态与已是 JSON 的响应原样透传。
    #[tokio::test]
    async fn json_rejection_rewrite_leaves_other_responses_alone() {
        let bad_request = (StatusCode::BAD_REQUEST, "bad request").into_response();
        let response = rewrite_json_rejection(bad_request).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let json_422 = (
            StatusCode::UNPROCESSABLE_ENTITY,
            axum::Json(json!({ "code": "custom.422" })),
        )
            .into_response();
        let response = rewrite_json_rejection(json_422).await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "custom.422", "已有 JSON 不能被覆盖：{body}");
    }
}
