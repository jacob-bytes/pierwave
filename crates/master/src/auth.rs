use std::convert::Infallible;

use axum::extract::{FromRequestParts, OptionalFromRequestParts, Request, State};
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

/// 当前 Cookie 会话的身份（会话 id）。
///
/// 由 [`CurrentUser`] 在鉴权时写入请求扩展，避免为「标记当前会话」再查一次库。
/// **提取器顺序有要求**：handler 参数里 [`CurrentUser`] 必须排在
/// [`CurrentSession`] 前面；API Token 请求没有 Cookie 会话，值为 `None`。
#[derive(Debug, Clone)]
pub struct SessionMeta {
    pub session_id: String,
}

/// 读取 [`CurrentUser`] 写入的会话身份；没有（API Token）时为 `None`。
pub struct CurrentSession(pub Option<SessionMeta>);

impl FromRequestParts<AppState> for CurrentSession {
    type Rejection = Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(CurrentSession(
            parts.extensions.get::<SessionMeta>().cloned(),
        ))
    }
}

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
        let authenticated = repo::sessions::authenticate(&state.db.pool, &token)
            .await?
            .ok_or(AppError::Unauthorized)?;

        // 低频写回 last_seen_at：默认 60 秒最多一次，失败只记日志，不影响请求。
        let now = repo::now();
        if state.session_touch.should_touch(
            &authenticated.session_id,
            authenticated.session_last_seen_at,
            now,
        ) {
            if let Err(error) =
                repo::sessions::touch(&state.db.pool, &authenticated.session_id, now).await
            {
                tracing::warn!(
                    session_id = %authenticated.session_id,
                    error = %error,
                    "更新会话最近活跃时间失败（已忽略）"
                );
            }
        }
        parts.extensions.insert(SessionMeta {
            session_id: authenticated.session_id,
        });

        Ok(CurrentUser(authenticated.user, None))
    }
}

/// `Option<CurrentUser>`：登出这类「没有有效会话也要清 Cookie」的入口使用。
///
/// axum 0.8 的 `Option<T>` 要求 `T: OptionalFromRequestParts`；这里把
/// 认证失败降级成 `None`（不返回 401），handler 自己决定是否写审计。
impl OptionalFromRequestParts<AppState> for CurrentUser {
    type Rejection = Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Option<Self>, Self::Rejection> {
        Ok(
            <Self as FromRequestParts<AppState>>::from_request_parts(parts, state)
                .await
                .ok(),
        )
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
/// 注意：read scope 的实际策略是 [`READ_SCOPE_ALLOWED_PATHS`] 的默认拒绝，
/// 不是「只挡这些前缀」。这份名单保留为纵深防御与可读的敏感面清单：
/// 即使未来有人把某个接口加进 allowlist，只要它在这里，仍然会被拒绝。
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
    // 转发日流量含用户名与目标地址，和 `/forwards` 同类。
    "/api/v1/forward-traffic",
    // 链拓扑、目标与成员健康。
    "/api/v1/chains",
    // 概览聚合含服务器/节点/用户流量排名，属于运营拓扑。
    "/api/v1/overview",
    // 统计聚合含 Top 用户、节点流量与节点详情。
    "/api/v1/stats",
    // 断流/超限事件含用户名、服务器名与原因。
    "/api/v1/enforcement",
    // 链模板里包含目标地址与成员编排。
    "/api/v1/chain-templates",
    // 路由规则属于网络拓扑。
    "/api/v1/routing-rules",
    // 用户清单与订阅短码（短码本身就是订阅凭据）。
    "/api/v1/users",
    // 订阅列表包含短码与生效模板。
    "/api/v1/subscriptions",
];

/// read scope 的**唯一允许路径**：健康检查与公开状态页。
///
/// read token 的定位是「健康检查与监控探针」，不是「能看大部分数据的只读
/// 账号」。除这两个路径外的所有 `/api/v1/*` GET 一律 403；要读业务数据请用
/// admin scope。`/api/v1/public/status` 本身无需登录，列在这里只是为了让
/// read token 的语义完整、可被测试直接断言。
pub const READ_SCOPE_ALLOWED_PATHS: &[&str] = &["/api/v1/health", "/api/v1/public/status"];

/// 路径是否在 read scope 的白名单内（精确匹配，不接受尾斜杠/子路径）。
pub fn is_read_scope_allowed_path(path: &str) -> bool {
    READ_SCOPE_ALLOWED_PATHS.contains(&path)
}

/// read scope 只拒绝「集合前缀之下还有具体资源」的敏感详情路径。
///
/// 与 [`SENSITIVE_READ_PREFIXES`] 的区别：详情才返回敏感数据。这是纵深防御
/// 名单，不是 read scope 的主策略；主策略见 [`READ_SCOPE_ALLOWED_PATHS`]。
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

/// 公开的 `/api/v1` 入口：不需要登录，也不受 IP 认证失败锁定影响。
///
/// 被 Bearer / Agent Hello 失败锁住的 IP 仍要能访问健康检查、公开状态页、
/// 订阅和登录入口。登录入口有自己的「用户名 + IP」限流；成功登录会清掉 IP
/// 计数，管理员因此有自救路径，不会因为一条脚本写错 token 就彻底进不来。
fn is_public_api_path(path: &str) -> bool {
    matches!(
        path,
        "/api/v1/health" | "/api/v1/public/status" | "/api/v1/auth/login"
    ) || path.starts_with("/api/v1/sub/")
}

/// 该路径是否受「按 IP 的认证失败锁定」保护。
///
/// 只覆盖 `/api/v1/*` 里需要登录的接口；`/mcp` 与 Agent WS 在自己的入口里
/// 检查同一张表（错误形状不同，不能复用 HTTP 中间件）。
pub fn is_ip_throttled_path(path: &str) -> bool {
    path.starts_with("/api/v1/") && !is_public_api_path(path)
}

/// 外层 IP 锁定中间件验证过 Cookie 会话后写入请求扩展。
///
/// 内层 Bearer 中间件据此避免把「有效 Cookie + 坏 Bearer」的请求连坐成 429：
/// 坏凭据仍然只回 401，已登录会话不受影响。
#[derive(Debug, Clone, Copy)]
struct ValidatedSessionCookie;

/// 请求是否带着一个**有效**的 Cookie 会话。
///
/// 只在 IP 已锁定时调用（低频），用于把「有效会话」从锁定里豁免出来；
/// 不写 `last_seen_at`，不改变任何会话状态。
async fn has_valid_session_cookie(state: &AppState, headers: &HeaderMap) -> bool {
    let jar = CookieJar::from_headers(headers);
    let Some(cookie) = jar.get(SESSION_COOKIE) else {
        return false;
    };
    matches!(
        repo::sessions::authenticate(&state.db.pool, cookie.value()).await,
        Ok(Some(_))
    )
}

/// 认证失败按 IP 限流的中间件。
///
/// 锁定**只约束认证尝试**：带有效 Cookie 会话或有效 Bearer 的请求永远放行
/// （否则同一 NAT 里有人打坏 Bearer 就能把管理员已登录的会话锁死）。无效
/// 凭据的请求照旧 429；计数在 [`crate::throttle::IpThrottle`] 里，失败在
/// Bearer 校验与 Agent Hello 处记录。
pub async fn ip_auth_throttle_middleware(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    if !is_ip_throttled_path(request.uri().path()) {
        return next.run(request).await;
    }

    let ip = crate::routes::auth::client_ip(request.headers(), request.extensions());
    // 缓存解析结果：内层 Bearer 中间件与 handler 提取器不再重复解析 XFF。
    request
        .extensions_mut()
        .insert(crate::routes::auth::ResolvedClientAddr(ip));
    let Some(ip) = ip else {
        // 没有可解析的客户端地址就没有限流键：跳过锁定，绝不能拿垃圾字符串当键。
        return next.run(request).await;
    };
    let key = ip.throttle_key();
    let Err(retry_after) = state.ip_throttle.check(key) else {
        return next.run(request).await;
    };

    // 1) 有效 Cookie 会话：放行，并让内层知道「这次会话是有效的」。
    if has_valid_session_cookie(&state, request.headers()).await {
        request.extensions_mut().insert(ValidatedSessionCookie);
        return next.run(request).await;
    }
    // 2) Bearer：交给内层 `api_token_middleware` 真正认证。这里不预认证，
    //    避免重复消耗 token 限流与 last_used_at；内层对**坏** Bearer 在锁定
    //    期内返回 429，对**好** Bearer 认证成功并清零计数。
    if let Some(raw) = bearer_token(request.headers()) {
        if raw.starts_with(repo::api_tokens::PREFIX) {
            return next.run(request).await;
        }
    }

    tracing::warn!(ip = %key, retry_after, "该 IP 认证失败次数过多，已临时拒绝");
    // 复用登录限流已翻译好的 `auth.too_many_attempts`（带 Retry-After 与 minutes），
    // 不新增一个前端词典里没有的错误码。
    AppError::TooManyAttempts(retry_after).into_response()
}

/// 对 `/api/v1/*` 生效的 Bearer 中间件：与 Cookie 会话并行。
///
/// - 没有 `Authorization: Bearer pwt_...`：原样放行，交给 Cookie 提权器；
/// - 有：认证成功就写入 [`ApiTokenPrincipal`] 扩展；
/// - `read` scope 的非安全方法（POST/PATCH/PUT/DELETE）直接 403
///   `api_token.read_only`，不会进入 handler；
/// - `read` scope 只允许 [`READ_SCOPE_ALLOWED_PATHS`]（健康检查/公开状态），
///   其余 GET 一律 403 `api_token.sensitive_endpoint`。
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

    // 只对「真的尝试了 API Token 认证」的请求计数；其它 Bearer 方案不背锅。
    let ip_key = crate::routes::auth::client_ip(request.headers(), request.extensions())
        .map(|addr| addr.throttle_key());
    let throttled = is_ip_throttled_path(request.uri().path());
    // 先记录「本次尝试之前」是否已锁定：认证失败时据此决定 429 还是 401，
    // 并避免对已锁定的 IP 继续累加（锁期不会被无限延长）。
    let existing_lock = ip_key
        .as_ref()
        .and_then(|key| state.ip_throttle.check(*key).err());
    let session_validated = request
        .extensions()
        .get::<ValidatedSessionCookie>()
        .is_some();
    let invalid_token = || {
        AppError::unauthorized(
            "api_token.invalid",
            None,
            "API Token 无效、已过期或已吊销 / Invalid, expired or revoked API token",
        )
        .into_response()
    };

    let principal = match authenticate_api_token(&state, raw).await {
        Ok(principal) => {
            // 成功认证清零该 IP 的失败计数；有效 Bearer 永远不被 IP 锁连坐。
            if let Some(key) = ip_key.as_ref() {
                state.ip_throttle.clear(*key);
            }
            principal
        }
        Err(ApiTokenAuthError::Unauthorized) => {
            if let Some(retry_after) = existing_lock {
                // 已锁定：受保护接口上的坏 Bearer 返回 429。公开入口不锁；
                // 有效 Cookie 会话也不连坐（坏 Bearer 仍只是 401）。
                if throttled && !session_validated {
                    return AppError::TooManyAttempts(retry_after).into_response();
                }
                return invalid_token();
            }
            if let Some(key) = ip_key.as_ref() {
                state.ip_throttle.record_failure(*key);
            }
            return invalid_token();
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
        let path = request.uri().path();
        if !is_read_scope_allowed_path(path) || is_sensitive_read_path(path) {
            return AppError::forbidden(
                "api_token.sensitive_endpoint",
                None,
                "该接口不在 read scope 的白名单内（read 仅用于健康检查/公开状态） / this endpoint is outside the read-scope allowlist (read is limited to health checks and public status)",
            )
            .into_response();
        }
    }

    request.extensions_mut().insert(principal);
    next.run(request).await
}

/// 请求是否经由 HTTPS 反代进来。
///
/// 主控自身只监听 HTTP，TLS 通常由同机反向代理终止；因此这里只认
/// `X-Forwarded-Proto` 的第一段（与 `ClientIp` 的信任边界一致）。直接
/// HTTP 访问时返回 `false`，不会把 Cookie 标成 Secure 导致本地登录失效。
pub fn request_is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .is_some_and(|proto| proto.eq_ignore_ascii_case("https"))
}

/// 会话 Cookie 的 `Max-Age` 必须与服务端 `sessions.expires_at` 一致，
/// 否则会出现「服务端已过期、浏览器还留着 Cookie」的假登录态。
pub fn session_cookie(
    token: String,
    ttl_secs: i64,
    secure: bool,
) -> axum_extra::extract::cookie::Cookie<'static> {
    axum_extra::extract::cookie::Cookie::build((SESSION_COOKIE, token))
        .http_only(true)
        .secure(secure)
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

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, HeaderMap, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::{repo, Db};

    use crate::throttle::{IP_MAX_FAILURES, IP_WINDOW_SECS};

    async fn router_with_tokens() -> (Router, String, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let (_, read_token) =
            repo::api_tokens::create(&db.pool, "read-ci", repo::api_tokens::SCOPE_READ, None)
                .await
                .unwrap();
        let (_, admin_token) =
            repo::api_tokens::create(&db.pool, "admin-ci", repo::api_tokens::SCOPE_ADMIN, None)
                .await
                .unwrap();
        let state = crate::state::AppState::new(db, "web/dist");
        (crate::app::router(state), read_token, admin_token)
    }

    /// 带一个管理员 Cookie 会话与一个 admin Bearer 的路由。
    async fn router_with_admin_session() -> (Router, String, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let user = repo::users::create(
            &db.pool,
            repo::users::NewUser {
                username: "admin".into(),
                password: "devpass".into(),
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
            },
        )
        .await
        .unwrap();
        let (session_token, _) = repo::sessions::create(&db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        let (_, admin_token) =
            repo::api_tokens::create(&db.pool, "admin-ci", repo::api_tokens::SCOPE_ADMIN, None)
                .await
                .unwrap();
        let state = crate::state::AppState::new(db, "web/dist");
        (crate::app::router(state), admin_token, session_token)
    }

    /// 同时可带 Cookie / Bearer / XFF 的 GET：用于验证「有效身份不被 IP 锁连坐」。
    async fn get_as(
        app: &Router,
        uri: &str,
        ip: &str,
        bearer: Option<&str>,
        session: Option<&str>,
    ) -> (StatusCode, HeaderMap) {
        let mut builder = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header("x-forwarded-for", ip);
        if let Some(token) = bearer {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(token) = session {
            builder = builder.header(header::COOKIE, format!("{SESSION_COOKIE}={token}"));
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        (response.status(), response.headers().clone())
    }

    async fn get(app: &Router, uri: &str, token: &str) -> StatusCode {
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        app.clone().oneshot(request).await.unwrap().status()
    }

    /// 带 `X-Forwarded-For` 的请求：单测里没有 ConnectInfo，`ClientIp` 会采信 XFF。
    async fn get_with_ip(
        app: &Router,
        uri: &str,
        token: Option<&str>,
        ip: &str,
    ) -> (StatusCode, HeaderMap) {
        let mut builder = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header("x-forwarded-for", ip);
        if let Some(token) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        (response.status(), response.headers().clone())
    }

    async fn bad_bearer(app: &Router, ip: &str) -> StatusCode {
        get_with_ip(app, "/api/v1/overview", Some("pwt_definitely-invalid"), ip)
            .await
            .0
    }

    /// 伪造 / 失效 Bearer 按 IP 计数：20 次失败后**无效凭据**的请求 429，
    /// 但合法 Bearer 永远不被锁连坐（T2），认证成功还会清零计数。
    #[tokio::test]
    async fn twenty_bad_bearers_lock_the_ip() {
        let (app, read_token, admin_token) = router_with_tokens().await;
        let ip = "203.0.113.50";

        for _ in 0..IP_MAX_FAILURES {
            assert_eq!(bad_bearer(&app, ip).await, StatusCode::UNAUTHORIZED);
        }

        let (status, headers) =
            get_with_ip(&app, "/api/v1/overview", Some("pwt_definitely-invalid"), ip).await;
        assert_eq!(
            status,
            StatusCode::TOO_MANY_REQUESTS,
            "第 21 次失败必须被限流"
        );
        let retry_after = headers
            .get(header::RETRY_AFTER)
            .expect("429 必须带 Retry-After")
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert!(
            (1..=IP_WINDOW_SECS).contains(&retry_after),
            "Retry-After 不合理：{retry_after}"
        );

        // T2：锁定期内合法 Bearer 仍必须放行，且成功认证清零该 IP 的计数。
        let (status, _) = get_with_ip(&app, "/api/v1/overview", Some(&admin_token), ip).await;
        assert_eq!(status, StatusCode::OK, "合法 Bearer 不能被 IP 锁连坐");

        // 计数已清零：坏 token 回到「认证失败 401」，而不是继续 429。
        assert_eq!(bad_bearer(&app, ip).await, StatusCode::UNAUTHORIZED);

        // 不同 IP 互不影响：合法 read token 进到鉴权阶段后被 scope 拒绝（403），
        // 而不是被 IP 限流拦成 429。
        let (status, _) =
            get_with_ip(&app, "/api/v1/overview", Some(&read_token), "203.0.113.51").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    async fn post_login(app: &Router, ip: &str, password: &str) -> StatusCode {
        let body = format!("{{\"username\":\"admin\",\"password\":\"{password}\"}}");
        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", ip)
            .body(Body::from(body))
            .unwrap();
        app.clone().oneshot(request).await.unwrap().status()
    }

    /// 攻击者连发错误登录只锁登录接口自己的「用户名 + IP」维度，不会喂
    /// `IpThrottle`；同一 IP 上已登录的 Cookie 会话不受影响。
    #[tokio::test]
    async fn failed_logins_do_not_lock_out_an_existing_session() {
        let (app, _admin_token, session_token) = router_with_admin_session().await;
        let ip = "203.0.113.53";

        for _ in 0..5 {
            assert_eq!(
                post_login(&app, ip, "wrong-password").await,
                StatusCode::UNAUTHORIZED
            );
        }
        // 第 6 次被登录自己的限流挡住（429），但这不是 IpThrottle。
        assert_eq!(
            post_login(&app, ip, "wrong-password").await,
            StatusCode::TOO_MANY_REQUESTS
        );

        // 已登录会话不参与登录限流，仍然必须 200。
        let (status, _) = get_as(&app, "/api/v1/overview", ip, None, Some(&session_token)).await;
        assert_eq!(status, StatusCode::OK, "错误登录不能连带锁住已登录会话");
    }

    /// T2：同一 NAT 内的有效 Cookie 会话不被 IP 锁连坐。
    #[tokio::test]
    async fn valid_cookie_session_is_never_blocked_by_the_ip_lock() {
        let (app, _admin_token, session_token) = router_with_admin_session().await;
        let ip = "203.0.113.52";

        for _ in 0..IP_MAX_FAILURES {
            assert_eq!(bad_bearer(&app, ip).await, StatusCode::UNAUTHORIZED);
        }
        assert_eq!(bad_bearer(&app, ip).await, StatusCode::TOO_MANY_REQUESTS);

        // 已登录会话：即使该 IP 已被别人打到锁定，也必须 200。
        let (status, _) = get_as(&app, "/api/v1/overview", ip, None, Some(&session_token)).await;
        assert_eq!(status, StatusCode::OK, "有效 Cookie 会话不能被 IP 锁连坐");

        // Cookie 请求不能清零 IP 计数（否则任何已登录用户都能刷掉失败计数）。
        assert_eq!(bad_bearer(&app, ip).await, StatusCode::TOO_MANY_REQUESTS);

        // 无凭据的请求保持旧行为：仍在锁定期内 429。
        let (status, _) = get_as(&app, "/api/v1/overview", ip, None, None).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    }

    // ---- T1：X-Forwarded-For 解析与信任边界 ----

    /// 追加语义（nginx `$proxy_add_x_forwarded_for`）：客户端伪造的第一段
    /// 会留在最左，真实地址由代理追加到最右。限流键必须是右侧的真实地址，
    /// 否则攻击者只要每次换一个伪造值就能无限绕过。
    #[tokio::test]
    async fn appended_xff_counts_the_rightmost_real_client_not_the_forged_first_hop() {
        let (app, _, _) = router_with_tokens().await;
        let real = "203.0.113.80";

        for index in 0..IP_MAX_FAILURES {
            // 客户端每次自带一个不同的私网伪造值，代理追加真实地址。
            let xff = format!("10.9.9.{index}, {real}");
            assert_eq!(
                bad_bearer_with_xff(&app, &xff).await,
                StatusCode::UNAUTHORIZED
            );
        }

        assert_eq!(
            bad_bearer_with_xff(&app, &format!("10.9.9.200, {real}")).await,
            StatusCode::TOO_MANY_REQUESTS,
            "追加语义下必须按真实客户端地址计数"
        );
    }

    /// IPv4-mapped IPv6 与纯 IPv4 是同一个地址，必须共用计数。
    #[tokio::test]
    async fn mapped_ipv6_is_normalized_to_ipv4_for_throttling() {
        let (app, _, _) = router_with_tokens().await;
        let real = "203.0.113.81";

        for _ in 0..IP_MAX_FAILURES {
            assert_eq!(
                bad_bearer_with_xff(&app, &format!("::ffff:{real}")).await,
                StatusCode::UNAUTHORIZED
            );
        }

        assert_eq!(
            bad_bearer_with_xff(&app, real).await,
            StatusCode::TOO_MANY_REQUESTS,
            "mapped 地址必须与 IPv4 共用限流桶"
        );
    }

    /// IPv6 按 /64 聚合：同一前缀内的单地址可以轮换，不能各算一个桶。
    #[tokio::test]
    async fn ipv6_throttling_aggregates_the_64_prefix() {
        let (app, _, _) = router_with_tokens().await;

        for _ in 0..IP_MAX_FAILURES {
            assert_eq!(
                bad_bearer_with_xff(&app, "2001:db8:1:2::1").await,
                StatusCode::UNAUTHORIZED
            );
        }

        assert_eq!(
            bad_bearer_with_xff(&app, "2001:db8:1:2::99").await,
            StatusCode::TOO_MANY_REQUESTS,
            "同一 /64 内的其它地址必须命中同一把锁"
        );
        assert_eq!(
            bad_bearer_with_xff(&app, "2001:db8:1:3::1").await,
            StatusCode::UNAUTHORIZED,
            "不同 /64 不应互相影响"
        );
    }

    /// 解析失败的 XFF 段不能原样当限流键（否则垃圾字符串会成为共享桶/伪造面）。
    #[tokio::test]
    async fn unparseable_xff_is_never_used_as_a_throttle_key() {
        let (app, _, _) = router_with_tokens().await;
        let garbage = "not-an-ip, still-not-an-ip";

        for _ in 0..IP_MAX_FAILURES {
            assert_eq!(
                bad_bearer_with_xff(&app, garbage).await,
                StatusCode::UNAUTHORIZED
            );
        }

        // 没有 ConnectInfo、整条 XFF 也不可用 → 没有可用的限流键，不应锁定。
        assert_eq!(
            bad_bearer_with_xff(&app, garbage).await,
            StatusCode::UNAUTHORIZED,
            "无法解析的 XFF 不能成为限流键"
        );
    }

    async fn bad_bearer_with_xff(app: &Router, xff: &str) -> StatusCode {
        get_with_ip(app, "/api/v1/overview", Some("pwt_definitely-invalid"), xff)
            .await
            .0
    }

    /// 成功认证一次必须清零该 IP 的失败计数。
    #[tokio::test]
    async fn successful_bearer_clears_the_ip_counter() {
        let (app, _, admin_token) = router_with_tokens().await;
        let ip = "198.51.100.23";

        for _ in 0..IP_MAX_FAILURES - 1 {
            assert_eq!(bad_bearer(&app, ip).await, StatusCode::UNAUTHORIZED);
        }
        let (status, _) = get_with_ip(&app, "/api/v1/overview", Some(&admin_token), ip).await;
        assert_eq!(status, StatusCode::OK, "合法 token 必须放行");

        // 清零后再失败 N-1 次仍不到阈值（不清零的话第一次就会累计到 20 被锁）。
        for _ in 0..IP_MAX_FAILURES - 1 {
            assert_eq!(
                bad_bearer(&app, ip).await,
                StatusCode::UNAUTHORIZED,
                "成功认证应让计数从头开始"
            );
        }
        let (status, _) = get_with_ip(&app, "/api/v1/overview", Some(&admin_token), ip).await;
        assert_eq!(status, StatusCode::OK);
    }

    /// IP 锁定只作用于受保护接口：公开入口不被 429，管理员仍能登录自救。
    #[tokio::test]
    async fn ip_lock_does_not_block_public_entry_points() {
        let (app, _, _) = router_with_tokens().await;
        let ip = "192.0.2.77";

        for _ in 0..IP_MAX_FAILURES {
            assert_eq!(bad_bearer(&app, ip).await, StatusCode::UNAUTHORIZED);
        }
        assert_eq!(bad_bearer(&app, ip).await, StatusCode::TOO_MANY_REQUESTS);

        for path in ["/api/v1/health", "/api/v1/public/status"] {
            let (status, _) = get_with_ip(&app, path, None, ip).await;
            assert_eq!(status, StatusCode::OK, "公开入口 {path} 不能被 IP 限流挡住");
        }
    }

    /// 哪些路径受 IP 锁定保护：公开入口（健康检查 / 公开状态 / 登录 / 订阅）除外。
    #[test]
    fn ip_throttle_covers_only_protected_api_paths() {
        for path in [
            "/api/v1/overview",
            "/api/v1/servers",
            "/api/v1/users/abc",
            "/api/v1/auth/me",
            "/api/v1/auth/logout",
        ] {
            assert!(is_ip_throttled_path(path), "必须在 IP 限流范围内：{path}");
        }
        for path in [
            "/api/v1/health",
            "/api/v1/public/status",
            "/api/v1/auth/login",
            "/api/v1/sub/abc123",
            "/mcp",
            "/api/agent/ws",
            "/",
        ] {
            assert!(!is_ip_throttled_path(path), "不能锁公开入口：{path}");
        }
    }

    #[test]
    fn sensitive_read_paths_include_operator_aggregates() {
        for path in [
            "/api/v1/overview",
            "/api/v1/stats/overview",
            "/api/v1/stats/nodes",
            "/api/v1/stats/nodes/server-1",
            "/api/v1/enforcement/events",
            "/api/v1/forward-traffic",
        ] {
            assert!(is_sensitive_read_path(path), "必须在纵深名单里：{path}");
        }
    }

    /// 纵深名单本身不能误伤相邻路径；read scope 的实际主策略是 allowlist。
    #[test]
    fn sensitive_read_paths_do_not_overreach() {
        for path in [
            "/api/v1/health",
            "/api/v1/public/status",
            "/api/v1/agent-upgrades/batches",
            "/api/v1/statsx",
            "/api/v1/overviewx",
        ] {
            assert!(!is_sensitive_read_path(path), "不能误伤：{path}");
        }
        assert!(
            is_sensitive_read_path("/api/v1/agent-upgrades/batches/batch-1"),
            "批次详情仍必须拒绝 read token"
        );
    }

    #[test]
    fn read_scope_allowlist_is_only_health_and_public_status() {
        for path in ["/api/v1/health", "/api/v1/public/status"] {
            assert!(is_read_scope_allowed_path(path), "允许：{path}");
        }
        for path in [
            "/api/v1/overview",
            "/api/v1/stats/traffic",
            "/api/v1/enforcement/events",
            "/api/v1/forward-traffic",
            "/api/v1/agent-upgrades/batches",
            "/api/v1/rule-templates",
            "/api/v1/settings",
            "/api/v1/health/extra",
            "/api/v1/public/status/extra",
        ] {
            assert!(!is_read_scope_allowed_path(path), "必须拒绝：{path}");
        }
    }

    #[tokio::test]
    async fn read_token_cannot_read_overview_stats_or_enforcement() {
        let (app, read_token, _) = router_with_tokens().await;
        for path in [
            "/api/v1/overview",
            "/api/v1/stats/overview",
            "/api/v1/stats/nodes",
            "/api/v1/enforcement/events",
        ] {
            assert_eq!(
                get(&app, path, &read_token).await,
                StatusCode::FORBIDDEN,
                "read token 不能访问 {path}"
            );
        }
    }

    #[tokio::test]
    async fn read_scope_denies_forward_traffic() {
        let (app, read_token, _) = router_with_tokens().await;
        assert_eq!(
            get(&app, "/api/v1/forward-traffic", &read_token).await,
            StatusCode::FORBIDDEN,
            "转发日流量含用户名与目标地址，read token 必须拒绝"
        );
    }

    /// read scope 的定位是健康检查/监控探针：除 health/public status 外一律 403。
    #[tokio::test]
    async fn read_token_denies_everything_else() {
        let (app, read_token, _) = router_with_tokens().await;
        for path in [
            "/api/v1/agent-upgrades/batches",
            "/api/v1/rule-templates",
            "/api/v1/settings",
            "/api/v1/forward-traffic",
        ] {
            assert_eq!(
                get(&app, path, &read_token).await,
                StatusCode::FORBIDDEN,
                "read token 不能访问 {path}"
            );
        }
    }

    #[tokio::test]
    async fn read_token_keeps_health_and_public_status_readable() {
        let (app, read_token, _) = router_with_tokens().await;
        for path in ["/api/v1/health", "/api/v1/public/status"] {
            assert_eq!(
                get(&app, path, &read_token).await,
                StatusCode::OK,
                "read token 应能访问 {path}"
            );
        }
    }

    #[tokio::test]
    async fn admin_token_still_reads_the_aggregates() {
        let (app, _, admin_token) = router_with_tokens().await;
        for path in [
            "/api/v1/overview",
            "/api/v1/stats/nodes",
            "/api/v1/enforcement/events",
            "/api/v1/forward-traffic",
            "/api/v1/agent-upgrades/batches",
        ] {
            assert_eq!(
                get(&app, path, &admin_token).await,
                StatusCode::OK,
                "admin token 应能访问 {path}"
            );
        }
    }

    #[test]
    fn request_is_https_reads_only_the_first_forwarded_proto() {
        let mut headers = HeaderMap::new();
        assert!(!request_is_https(&headers), "没有头时按 HTTP 处理");

        headers.insert("x-forwarded-proto", "HTTPS".parse().unwrap());
        assert!(request_is_https(&headers), "大小写不敏感");

        headers.insert("x-forwarded-proto", "https, http".parse().unwrap());
        assert!(request_is_https(&headers), "只看第一段");

        headers.insert("x-forwarded-proto", "http".parse().unwrap());
        assert!(!request_is_https(&headers));
    }

    #[test]
    fn session_cookie_sets_secure_only_when_requested() {
        let secure = session_cookie("token".into(), 3600, true).to_string();
        assert!(secure.contains("Secure"), "{secure}");
        assert!(secure.contains("HttpOnly"), "{secure}");
        assert!(secure.contains("SameSite=Lax"), "{secure}");

        let plain = session_cookie("token".into(), 3600, false).to_string();
        assert!(!plain.contains("Secure"), "{plain}");
    }
}
