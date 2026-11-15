use axum::extract::{FromRequestParts, Request, State};
use axum::http::header;
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::cookie::CookieJar;

use pierwave_domain::models::User;
use pierwave_domain::repo;

use crate::error::AppError;
use crate::state::AppState;

pub const SESSION_COOKIE: &str = "pierwave_session";

/// 通过 `Authorization: Bearer pwt_...` 认证出来的 token 身份。
///
/// 它不关联 `users` 表（迁移 0054 的 `api_tokens` 没有 owner 列），
/// 因此 `CurrentUser` 会用这里的信息构造一个「管理员身份」的合成用户：
/// 审计的 `actor_id` 落 token id，读接口的 `require_admin` 可以正常通过。
/// 写权限由 [`api_token_middleware`] 按 scope 在进入 handler 之前拦住。
#[derive(Debug, Clone)]
pub struct ApiTokenPrincipal {
    pub id: String,
    pub name: String,
    pub scope: String,
}

impl ApiTokenPrincipal {
    /// 只有 admin scope 才等同于管理员会话；`read` 仍是只读。
    pub fn is_admin(&self) -> bool {
        self.scope == repo::api_tokens::SCOPE_ADMIN
    }

    fn synthetic_user(&self) -> User {
        let ts = repo::now();
        User {
            id: self.id.clone(),
            // 面板里没有对应账号；用可读前缀让审计/调试一眼看出是 token。
            username: format!("{}:{}", repo::api_tokens::PREFIX, self.name),
            password_hash: String::new(),
            role: "admin".to_string(),
            status: "active".to_string(),
            short_code: String::new(),
            short_code_updated_at: ts,
            quota_bytes: None,
            used_bytes: 0,
            rule_template_id: None,
            subscription_template_id: None,
            created_at: ts,
            updated_at: ts,
        }
    }
}

/// 从 Cookie 或已认证的 API Token 解析当前用户；两者都没有直接 401。
///
/// 第二个字段为 `Some` 表示这次请求来自 API Token；Cookie 会话为 `None`。
/// 保留 `(pub User)` 的元组形状，现有 handler 的 `user.0` 全部不用改。
pub struct CurrentUser(pub User, pub Option<ApiTokenPrincipal>);

impl CurrentUser {
    /// 只要求「管理员权限」：Cookie 管理员、admin scope token，以及
    /// read scope token 的只读请求都通过（写请求已被中间件提前拦成 403）。
    pub fn require_admin(&self) -> Result<(), AppError> {
        if self.0.role == "admin" {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }

    /// 要求真正的管理员身份：Cookie 管理员或 **admin scope** token。
    /// 用于「仅管理员」的敏感接口（例如 API Token 管理本身）：
    /// read scope token 连列表都不能看。
    pub fn require_full_admin(&self) -> Result<(), AppError> {
        if self.0.role != "admin" {
            return Err(AppError::Forbidden);
        }
        match &self.1 {
            None => Ok(()),
            Some(principal) if principal.is_admin() => Ok(()),
            Some(_) => Err(AppError::forbidden(
                "api_token.admin_scope_required",
                None,
                "该操作需要 admin scope 的 API Token / an admin-scoped API token is required",
            )),
        }
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // 中间件已经验证过 Bearer 时会先写入扩展；优先用它，避免重复查库。
        if let Some(principal) = parts.extensions.get::<ApiTokenPrincipal>() {
            return Ok(CurrentUser(
                principal.synthetic_user(),
                Some(principal.clone()),
            ));
        }

        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar
            .get(SESSION_COOKIE)
            .map(|c| c.value().to_string())
            .ok_or(AppError::Unauthorized)?;
        let user = repo::sessions::user_for_token(&state.db.pool, &token)
            .await?
            .ok_or(AppError::Unauthorized)?;
        Ok(CurrentUser(user, None))
    }
}

/// 只认 `Authorization: Bearer <token>`；其它 scheme / 畸形值返回 `None`。
pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = raw.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}

/// API Token 认证结果；由中间件与 `/mcp` handler 共用。
#[derive(Debug)]
pub enum ApiTokenAuthError {
    /// token 不存在、已吊销或已过期。
    Unauthorized,
    /// 该 token 在本分钟窗口内超限。
    RateLimited(u64),
    Internal(anyhow::Error),
}

/// 认证 Bearer token：查哈希 → 限流 → 记 `last_used_at` 内存缓冲。
///
/// 限流放在这里而不是 handler：普通 API 与 `/mcp` 共用同一份额度，
/// 避免通过两个入口各拿 120 次。
pub async fn authenticate_api_token(
    state: &AppState,
    token: &str,
) -> Result<ApiTokenPrincipal, ApiTokenAuthError> {
    let row =
        repo::api_tokens::find_active_by_token(&state.db.pool, token, pierwave_domain::time::now())
            .await
            .map_err(ApiTokenAuthError::Internal)?
            .ok_or(ApiTokenAuthError::Unauthorized)?;

    state
        .api_token_throttle
        .check(&row.id)
        .map_err(ApiTokenAuthError::RateLimited)?;
    state.api_token_usage.mark(&row.id);

    Ok(ApiTokenPrincipal {
        id: row.id,
        name: row.name,
        scope: row.scope,
    })
}

/// read scope **明确拒绝**的敏感 GET 路径前缀。
///
/// read 的「只读」不等于「可以看所有数据」：数据库导出、证书/节点配置、
/// 审计、设置里的 Telegram token 都包含凭据或基础设施拓扑。这里集中列名单，
/// 不让策略散落在各个 handler 里；新增敏感接口时把前缀加到这里。
///
/// 匹配规则是「等于前缀或以 `前缀/` 开头」，所以 `/api/v1/servers` 不会
/// 误伤 `/api/v1/serversX`，也不会漏掉 `/api/v1/servers/{id}/nodes`。
pub const SENSITIVE_READ_PREFIXES: &[&str] = &[
    // 整库导出、待恢复信息、远端备份文件列表。
    "/api/v1/backup",
    // 证书库存与元数据；当前列表不返回 PEM/私钥，但拒绝可防止未来 GET 变成泄露面。
    "/api/v1/certificates",
    // 管理动作、操作者与目标。
    "/api/v1/audit",
    // 设置里包含明文 Telegram Bot Token、chat id 与 Webhook 地址。
    "/api/v1/settings",
    // token 元数据（名称/scope/使用时间）；管理本身已要求 admin scope。
    "/api/v1/api-tokens",
    // 服务器地址、Agent 状态与安装元数据。
    "/api/v1/servers",
    // 节点配置里可能有客户端凭据、Reality 私钥、证书引用。
    "/api/v1/nodes",
    // 出站配置里可能有上游代理的账号密码。
    "/api/v1/outbounds",
    // 转发目标地址与端口。
    "/api/v1/forwards",
    // 链拓扑、目标与成员健康。
    "/api/v1/chains",
    // 链模板里包含目标地址与成员编排。
    "/api/v1/chain-templates",
    // 路由规则属于网络拓扑。
    "/api/v1/routing-rules",
    // 用户清单与订阅短码（短码本身就是订阅凭据）。
    "/api/v1/users",
    // 订阅列表包含短码与生效模板。
    "/api/v1/subscriptions",
];

/// read scope 只拒绝「集合前缀之下还有具体资源」的敏感详情路径。
///
/// 与 [`SENSITIVE_READ_PREFIXES`] 的区别：集合本身（列表）不含敏感字段，
/// 可以给 read token 用；只有详情才返回敏感数据。当前用于 Agent 升级批次：
/// 列表只有版本/状态/计数，详情才带 `server_name` 与 `agent_version`。
pub const SENSITIVE_READ_DETAIL_PREFIXES: &[&str] = &["/api/v1/agent-upgrades/batches"];

/// 是否为 read scope 不可访问的敏感路径。
pub fn is_sensitive_read_path(path: &str) -> bool {
    let matches_prefix = |prefix: &str| {
        path == prefix
            || path
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('/'))
    };
    SENSITIVE_READ_PREFIXES
        .iter()
        .any(|prefix| matches_prefix(prefix))
        // 详情前缀要求后面还有一段非空路径：集合列表本身不敏感。
        || SENSITIVE_READ_DETAIL_PREFIXES.iter().any(|prefix| {
            path.strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('/') && rest.len() > 1)
        })
}

/// 对 `/api/v1/*` 生效的 Bearer 中间件：与 Cookie 会话并行。
///
/// - 没有 `Authorization: Bearer pwt_...`：原样放行，交给 Cookie 提权器；
/// - 有：认证成功就写入 [`ApiTokenPrincipal`] 扩展；
/// - `read` scope 的非安全方法（POST/PATCH/PUT/DELETE）直接 403
///   `api_token.read_only`，不会进入 handler。
///
/// `/mcp` 不经过这里：它需要返回 JSON-RPC 形状的错误，由 handler 自己做认证。
pub async fn api_token_middleware(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    if !request.uri().path().starts_with("/api/v1/") {
        return next.run(request).await;
    }

    let Some(raw) = bearer_token(request.headers()) else {
        return next.run(request).await;
    };
    if !raw.starts_with(repo::api_tokens::PREFIX) {
        // 不是 API Token（例如别的 Bearer 方案）：不接管，交回 Cookie 路径。
        return next.run(request).await;
    }

    let principal = match authenticate_api_token(&state, raw).await {
        Ok(principal) => principal,
        Err(ApiTokenAuthError::Unauthorized) => {
            return AppError::unauthorized(
                "api_token.invalid",
                None,
                "API Token 无效、已过期或已吊销 / Invalid, expired or revoked API token",
            )
            .into_response();
        }
        Err(ApiTokenAuthError::RateLimited(retry_after)) => {
            return AppError::too_many_requests(
                "api_token.rate_limited",
                retry_after,
                "API Token 请求过于频繁 / API token rate limit exceeded",
            )
            .into_response();
        }
        Err(ApiTokenAuthError::Internal(error)) => {
            return AppError::from(error).into_response();
        }
    };

    let safe_method = matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    if !principal.is_admin() {
        if !safe_method {
            return AppError::forbidden(
                "api_token.read_only",
                None,
                "只读 API Token 不能执行写操作 / read-only API token cannot perform writes",
            )
            .into_response();
        }
        if is_sensitive_read_path(request.uri().path()) {
            return AppError::forbidden(
                "api_token.sensitive_endpoint",
                None,
                "该接口包含敏感数据，read scope 不可访问 / this endpoint contains sensitive data and is not available to read-scoped tokens",
            )
            .into_response();
        }
    }

    request.extensions_mut().insert(principal);
    next.run(request).await
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
