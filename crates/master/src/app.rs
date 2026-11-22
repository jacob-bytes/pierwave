use axum::body::Body;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderName, HeaderValue, Request, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::Router;
use tower_http::compression::predicate::{DefaultPredicate, Predicate};
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::error::AppError;
use crate::routes;
use crate::state::AppState;

/// 哪些响应值得 gzip。
///
/// 默认谓词（[`DefaultPredicate`]）已经跳过图片、gRPC、SSE 与小于 32 字节的
/// 响应；这里额外跳过**已经压缩过的二进制**：
///
/// * `/api/agent/download/{file}` 与 `/api/agent/release/{*rest}` 用
///   `application/octet-stream` 下发 Agent 二进制，再 gzip 只会白烧 CPU、
///   还会让客户端多一层解码；
/// * `application/zip` / `application/gzip` 同理。
///
/// JSON（含公开状态页、订阅、MCP）与静态资源里的 HTML / JS / CSS 照常压缩。
#[derive(Clone)]
struct CompressibleResponse(DefaultPredicate);

/// 已经压缩过、不值得再 gzip 的 Content-Type 前缀。
const ALREADY_COMPRESSED: [&str; 4] = [
    "application/octet-stream",
    "application/zip",
    "application/gzip",
    "application/x-gzip",
];

impl Predicate for CompressibleResponse {
    fn should_compress<B>(&self, response: &axum::http::Response<B>) -> bool
    where
        B: axum::body::HttpBody,
    {
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if ALREADY_COMPRESSED
            .iter()
            .any(|skip| content_type.starts_with(skip))
        {
            return false;
        }
        self.0.should_compress(response)
    }
}

/// 所有响应都会带上的基础安全头。
///
/// 不启用完整的 CSP：当前 SPA 依赖 Vite 生成的资源与部分内联样式，
/// 收紧 `script-src` / `style-src` 需要前端同步改造；本轮先只加
/// `frame-ancestors`，阻止面板被任意站点 iframe 嵌入。
fn apply_security_headers(headers: &mut axum::http::HeaderMap, secure: bool, no_store: bool) {
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-ancestors 'none'"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );

    if no_store {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    }

    if secure {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        );
    }
}

/// 安全响应头中间件：API 不缓存，HTTPS 反代访问时补 HSTS。
async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let secure = crate::auth::request_is_https(request.headers());
    let no_store = request.uri().path().starts_with("/api/");
    let mut response = next.run(request).await;
    apply_security_headers(response.headers_mut(), secure, no_store);
    response
}

/// 日志里的 URI 脱敏：订阅短码与 API query 中的凭据不能进 tracing。
fn redact_uri(uri: &Uri) -> String {
    let path = uri.path();
    let path = match path.strip_prefix("/api/v1/sub/") {
        Some(rest) if !rest.is_empty() => "/api/v1/sub/<redacted>".to_string(),
        _ => path.to_string(),
    };

    match uri.query() {
        Some(_) if path.starts_with("/api/") => format!("{path}?<redacted>"),
        Some(query) => format!("{path}?{query}"),
        None => path,
    }
}

/// TraceLayer 的 span：只记录 method / 脱敏 URI / version，不记录 headers。
fn make_span(request: &Request<Body>) -> tracing::Span {
    tracing::info_span!(
        "http",
        method = %request.method(),
        uri = %redact_uri(request.uri()),
        version = ?request.version(),
    )
}

/// 公开读取限流：`GET /api/v1/public/status` 与 `GET /api/v1/public/status/{id}`。
///
/// 与认证失败限流（[`crate::auth::ip_auth_throttle_middleware`]）**完全分开**：
/// 两张表互不写入。读公开页再多也不会把登录 / Bearer 认证打成 429，反过来
/// 撞库失败也不会消耗公开页的读取额度。
///
/// 键复用 [`crate::routes::auth::client_ip`]：XFF 信任边界（只信回环/内网反代）、
/// IPv4-mapped 归一、IPv6 `/64` 聚合都只有一套实现，这里不另写地址解析。
///
/// 健康检查 `/api/v1/health` 刻意**不**限流：监控探针按秒级轮询，面板被刷时
/// 限流只会让监控误报；它只做一次内存检查，不打库。管理端白名单入口
/// `/api/v1/public-status/*` 也不在这里——那是已鉴权的写读接口，有各自的锁。
async fn public_read_throttle_middleware(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let Some(ip) = crate::routes::auth::client_ip(request.headers(), request.extensions()) else {
        // 拿不到客户端地址就没有限流键：放行。绝不能拿垃圾字符串当共享桶。
        return next.run(request).await;
    };
    let key = ip.throttle_key();
    let Err(retry_after) = state.public_read_throttle.check(key) else {
        return next.run(request).await;
    };

    tracing::debug!(ip = %key, retry_after, "公开状态页读取超限，返回 429");
    AppError::too_many_requests(
        "public_status.rate_limited",
        retry_after,
        "公开状态页请求过于频繁，请稍后再试 / Too many requests to the public status page, please retry later",
    )
    .into_response()
}

pub fn router(state: AppState) -> Router {
    let index = state.web_dir.join("index.html");
    let static_files = ServeDir::new(state.web_dir.as_path()).fallback(ServeFile::new(index));

    // 公开状态页的按 IP 读取限流：只包列表与详情两条路由。
    let public_read_limit =
        axum::middleware::from_fn_with_state(state.clone(), public_read_throttle_middleware);

    Router::new()
        .route("/api/v1/health", get(routes::system::health))
        // 公开状态页：无需登录；关闭开关由 handler 自身判断并返回 404。
        .route(
            "/api/v1/public/status",
            get(routes::public_status::status).layer(public_read_limit.clone()),
        )
        // 单台服务器的详情（含 24h 趋势）：列表不再带上 `series_24h`。
        .route(
            "/api/v1/public/status/{id}",
            get(routes::public_status::detail).layer(public_read_limit),
        )
        // 公开状态页白名单（仅管理员）：读全量列表 / 用 id 列表整体替换。
        .route(
            "/api/v1/public-status/servers",
            get(routes::public_status::admin_servers).put(routes::public_status::replace_servers),
        )
        .route("/api/v1/backup", get(routes::backup::export))
        .route(
            "/api/v1/backup/restore",
            post(routes::backup::restore).delete(routes::backup::cancel_restore),
        )
        .route("/api/v1/backup/info", get(routes::backup::info))
        // 异地备份（WebDAV）：状态只读；测试与立即上传都是管理员动作。
        .route("/api/v1/backup/remote", get(routes::backup::remote_status))
        .route(
            "/api/v1/backup/remote/test",
            post(routes::backup::remote_test),
        )
        .route(
            "/api/v1/backup/remote/run",
            post(routes::backup::remote_run),
        )
        .route("/api/v1/auth/login", post(routes::auth::login))
        // API Token：列表 / 创建（明文只返回一次）/ 吊销；仅管理员。
        .route(
            "/api/v1/api-tokens",
            get(routes::api_tokens::list).post(routes::api_tokens::create),
        )
        .route(
            "/api/v1/api-tokens/{id}",
            delete(routes::api_tokens::revoke),
        )
        // MCP Streamable HTTP：POST 单条 JSON-RPC；认证错误也是 JSON-RPC 形状。
        .route(
            "/mcp",
            post(routes::mcp::http)
                .get(routes::mcp::method_not_allowed)
                .delete(routes::mcp::method_not_allowed)
                .layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route("/api/v1/auth/logout", post(routes::auth::logout))
        .route("/api/v1/auth/me", get(routes::auth::me))
        // 登录设备：用户端只看/踢自己的；管理员入口在用户资源下面。
        .route(
            "/api/v1/sessions",
            get(routes::sessions::list).delete(routes::sessions::revoke_others),
        )
        .route("/api/v1/sessions/{id}", delete(routes::sessions::revoke))
        .route(
            "/api/v1/users/{id}/sessions",
            get(routes::sessions::admin_list),
        )
        .route(
            "/api/v1/users/{id}/sessions/{session_id}",
            delete(routes::sessions::admin_revoke),
        )
        .route("/api/v1/me/logins", get(routes::sessions::recent_logins))
        .route(
            "/api/v1/servers",
            get(routes::servers::list).post(routes::servers::create),
        )
        .route(
            "/api/v1/servers/{id}",
            axum::routing::patch(routes::servers::update).delete(routes::servers::delete),
        )
        .route(
            "/api/v1/servers/{id}/token",
            post(routes::servers::rotate_token),
        )
        .route(
            "/api/v1/servers/{id}/agent-upgrade",
            post(routes::servers::trigger_agent_upgrade),
        )
        .route(
            "/api/v1/servers/{id}/agent-upgrades",
            get(routes::servers::list_agent_upgrades),
        )
        .route(
            "/api/v1/agent-upgrades/batches",
            get(routes::upgrade_batches::list).post(routes::upgrade_batches::create),
        )
        .route(
            "/api/v1/agent-upgrades/batches/{id}",
            get(routes::upgrade_batches::detail),
        )
        .route(
            "/api/v1/agent-upgrades/batches/{id}/cancel",
            post(routes::upgrade_batches::cancel),
        )
        .route(
            "/api/v1/servers/{id}/nodes",
            get(routes::nodes::list).post(routes::nodes::create),
        )
        .route("/api/v1/nodes", get(routes::nodes::list_all))
        .route(
            "/api/v1/nodes/{id}",
            patch(routes::nodes::update).delete(routes::nodes::delete),
        )
        // 实时 TCPing：结果不落库，只写审计；仅管理员。
        .route("/api/v1/nodes/{id}/tcping", post(routes::nodes::tcping))
        .route("/api/v1/servers/{id}/apply", post(routes::nodes::apply))
        .route(
            "/api/v1/servers/{id}/forwards",
            get(routes::forwards::list).post(routes::forwards::create),
        )
        .route(
            "/api/v1/forwards/{id}",
            patch(routes::forwards::update).delete(routes::forwards::delete),
        )
        // 转发日表对账：只读，仅管理员。
        .route("/api/v1/forward-traffic", get(routes::forwards::traffic))
        .route(
            "/api/v1/chains",
            get(routes::chains::list).post(routes::chains::create),
        )
        .route(
            "/api/v1/chains/{id}",
            patch(routes::chains::update).delete(routes::chains::delete),
        )
        .route("/api/v1/chains/{id}/latency", get(routes::chains::latency))
        .route(
            "/api/v1/chains/{id}/availability",
            get(routes::chains::availability),
        )
        .route(
            "/api/v1/chain-templates",
            get(routes::chain_templates::list).post(routes::chain_templates::create),
        )
        .route(
            "/api/v1/chain-templates/{id}",
            patch(routes::chain_templates::update).delete(routes::chain_templates::delete),
        )
        .route(
            "/api/v1/me/chain-templates",
            get(routes::chain_templates::me_list),
        )
        .route(
            "/api/v1/me/chains",
            get(routes::chains::me_list).post(routes::chains::me_create),
        )
        .route(
            "/api/v1/me/chains/{id}",
            axum::routing::patch(routes::chains::me_update).delete(routes::chains::me_delete),
        )
        .route(
            "/api/v1/servers/{id}/outbounds",
            get(routes::outbounds::list).post(routes::outbounds::create),
        )
        .route(
            "/api/v1/outbounds/{id}",
            patch(routes::outbounds::update).delete(routes::outbounds::delete),
        )
        .route(
            "/api/v1/servers/{id}/routing-rules",
            get(routes::routing_rules::list).post(routes::routing_rules::create),
        )
        .route(
            "/api/v1/routing-rules/{id}",
            patch(routes::routing_rules::update).delete(routes::routing_rules::delete),
        )
        .route(
            "/api/v1/users",
            get(routes::users::list).post(routes::users::create),
        )
        .route(
            "/api/v1/users/{id}",
            patch(routes::users::update).delete(routes::users::delete),
        )
        .route(
            "/api/v1/users/over-quota/count",
            get(routes::users::count_over_quota_users),
        )
        .route(
            "/api/v1/users/batch-disable-over-quota",
            post(routes::users::batch_disable_over_quota_users),
        )
        .route(
            "/api/v1/users/{id}/packages",
            get(routes::users::list_user_packages).post(routes::users::create_user_package),
        )
        .route(
            "/api/v1/user-packages/{id}",
            patch(routes::users::update_user_package).delete(routes::users::delete_user_package),
        )
        .route(
            "/api/v1/user-packages/batch-renew",
            post(routes::users::batch_renew_user_packages),
        )
        .route(
            "/api/v1/packages",
            get(routes::packages::list).post(routes::packages::create),
        )
        .route(
            "/api/v1/packages/{id}",
            patch(routes::packages::update).delete(routes::packages::delete),
        )
        .route(
            "/api/v1/rule-templates",
            get(routes::rule_templates::list).post(routes::rule_templates::create),
        )
        .route(
            "/api/v1/rule-templates/{id}",
            patch(routes::rule_templates::update).delete(routes::rule_templates::delete),
        )
        .route(
            "/api/v1/subscription-templates",
            get(routes::subscription_templates::list).post(routes::subscription_templates::create),
        )
        .route(
            "/api/v1/subscription-templates/{id}",
            patch(routes::subscription_templates::update)
                .delete(routes::subscription_templates::delete),
        )
        .route(
            "/api/v1/subscription-templates/{id}/preview",
            post(routes::subscription_templates::preview),
        )
        .route(
            "/api/v1/certificates",
            get(routes::certificates::list).post(routes::certificates::create),
        )
        .route(
            "/api/v1/certificates/{id}",
            axum::routing::delete(routes::certificates::delete),
        )
        .route("/api/v1/audit", get(routes::audit::list))
        .route("/api/v1/stats/overview", get(routes::stats::overview))
        .route("/api/v1/overview", get(routes::overview::overview))
        // 管理员服务器态势：跨服务器一次 GROUP BY，30 秒短缓存。
        .route(
            "/api/v1/overview/server-health",
            get(routes::overview::server_health),
        )
        // 管理员链路时延：一次拓扑 + 一次窗口样本，30 秒短缓存。
        .route(
            "/api/v1/overview/chain-health",
            get(routes::chain_health::chain_health),
        )
        .route("/api/v1/stats/traffic", get(routes::stats::traffic))
        .route("/api/v1/stats/nodes", get(routes::stats::nodes))
        .route(
            "/api/v1/stats/nodes/{node_id}",
            get(routes::stats::node_detail),
        )
        .route(
            "/api/v1/enforcement/events",
            get(routes::enforcement::events),
        )
        .route(
            "/api/v1/enforcement/events/cleanup",
            post(routes::enforcement::cleanup),
        )
        .route(
            "/api/v1/settings",
            get(routes::settings::get).patch(routes::settings::update),
        )
        // 内部订阅派生 secret 损坏时的唯一自助入口（删除后首次使用重新生成）。
        .route(
            "/api/v1/settings/reset-subscription-secret",
            post(routes::settings::reset_subscription_secret),
        )
        .route("/api/v1/alerts/test", post(routes::alerts::test))
        // 版本更新：查询与手动检测，均仅管理员；版本源只认 GitHub Releases。
        .route("/api/v1/updates", get(routes::updates::get))
        .route("/api/v1/updates/check", post(routes::updates::check))
        // 公开订阅入口：不加鉴权，短码即凭证。
        .route("/api/v1/sub/{short_code}", get(routes::subscribe::get))
        .route("/api/v1/subscriptions", get(routes::subscriptions::list))
        .route("/api/v1/me/summary", get(routes::me::summary))
        .route("/api/v1/me/traffic", get(routes::me::traffic))
        .route(
            "/api/v1/me/forward-traffic",
            get(routes::me::forward_traffic),
        )
        .route("/api/v1/me/events", get(routes::me::events))
        .route(
            "/api/v1/me/subscription/reset",
            post(routes::me::reset_subscription),
        )
        .route("/api/v1/me/password", post(routes::me::change_password))
        .route(
            "/api/v1/me/forwards",
            get(routes::forwards::me_list).post(routes::forwards::me_create),
        )
        .route(
            "/api/v1/me/forwards/{id}",
            patch(routes::forwards::me_update).delete(routes::forwards::me_delete),
        )
        .route("/api/agent/install.sh", get(routes::install::script))
        .route("/api/agent/download/{file}", get(routes::install::download))
        .route("/api/agent/release/{*rest}", get(routes::install::release))
        .route("/api/agent/ws", get(routes::agent::ws))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::api_token_middleware,
        ))
        // 认证失败的 IP 维度锁定：必须包在 Bearer 中间件外层，锁定期内连鉴权都不做。
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::ip_auth_throttle_middleware,
        ))
        .with_state(state)
        .fallback_service(static_files)
        // JSON 提取失败（422 纯文本）统一改写成 `request.invalid_json` 信封；
        // 必须包在业务路由外层，才能覆盖所有端点的 `Json<T>` 提取。
        .layer(axum::middleware::from_fn(crate::error::map_json_rejections))
        .layer(axum::middleware::from_fn(security_headers))
        .layer(TraceLayer::new_for_http().make_span_with(make_span))
        // gzip 必须包在最外层：公开状态页、MCP、订阅等 JSON 体积大且重复度高，
        // 压缩后通常只剩 5%–10%；二进制下载由谓词跳过（见 [`CompressibleResponse`]）。
        // tower-http 会自动补 `Content-Encoding: gzip` 与 `Vary: Accept-Encoding`。
        .layer(CompressionLayer::new().compress_when(CompressibleResponse(DefaultPredicate::new())))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::http::{Method, StatusCode};
    use tower::ServiceExt;

    use pierwave_domain::Db;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("pierwave-app-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn test_app(web_dir: impl Into<std::path::PathBuf>) -> Router {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, web_dir);
        router(state)
    }

    /// 带固定公开读取阈值的路由 + state：测试不依赖环境变量。
    async fn test_app_with_state(public_limit: u32) -> (Router, AppState) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist").with_public_rate_limit(public_limit);
        (router(state.clone()), state)
    }

    /// 带 `X-Forwarded-For` 的 GET：单测里没有 `ConnectInfo`，`client_ip` 会采信 XFF。
    async fn get_with_ip(
        app: &Router,
        uri: &str,
        xff: &str,
    ) -> (StatusCode, axum::http::HeaderMap) {
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header("x-forwarded-for", xff)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        (response.status(), response.headers().clone())
    }

    /// 带 `X-Forwarded-For` 与坏 Bearer 的 GET：验证两张限流表互不写入。
    async fn bad_bearer_with_ip(app: &Router, ip: &str) -> StatusCode {
        let request = Request::builder()
            .method(Method::GET)
            .uri("/api/v1/overview")
            .header("x-forwarded-for", ip)
            .header(header::AUTHORIZATION, "Bearer pwt_definitely-invalid")
            .body(Body::empty())
            .unwrap();
        app.clone().oneshot(request).await.unwrap().status()
    }

    async fn get(
        app: &Router,
        uri: &str,
        forwarded_proto: Option<&str>,
    ) -> axum::response::Response {
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(proto) = forwarded_proto {
            builder = builder.header("x-forwarded-proto", proto);
        }
        app.clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    /// JSON 提取失败的错误信封是全局的：任意端点的 `Json<T>` 都走同一层映射。
    #[tokio::test]
    async fn json_extractor_rejections_are_coded_for_any_route() {
        let app = test_app("web/dist").await;
        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"username":1,"password":"devpass"}"#))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "request.invalid_json", "{body}");
    }

    #[tokio::test]
    async fn api_responses_have_security_headers_and_no_store() {
        let app = test_app("web/dist").await;
        let response = get(&app, "/api/v1/health", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();

        assert_eq!(
            headers
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .expect("缺少 nosniff"),
            "nosniff"
        );
        assert_eq!(
            headers
                .get(header::REFERRER_POLICY)
                .expect("缺少 Referrer-Policy"),
            "no-referrer"
        );
        assert_eq!(
            headers
                .get(header::X_FRAME_OPTIONS)
                .expect("缺少 X-Frame-Options"),
            "DENY"
        );
        assert!(headers
            .get(header::CONTENT_SECURITY_POLICY)
            .expect("缺少 CSP")
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'"));
        assert_eq!(
            headers
                .get(header::CACHE_CONTROL)
                .expect("API 必须 no-store"),
            "no-store"
        );
        assert_eq!(
            headers.get(header::PRAGMA).expect("API 必须 Pragma"),
            "no-cache"
        );
        assert!(headers.get(header::STRICT_TRANSPORT_SECURITY).is_none());
    }

    #[tokio::test]
    async fn static_index_gets_security_headers_but_not_no_store() {
        let dir = TempDir::new();
        std::fs::write(dir.path().join("index.html"), "<html>panel</html>").unwrap();
        let app = test_app(dir.path()).await;

        let response = get(&app, "/some/spa/route", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(
            headers
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .expect("缺少 nosniff"),
            "nosniff"
        );
        assert!(
            headers.get(header::CACHE_CONTROL).is_none(),
            "静态资源不能套用 API 的 no-store"
        );
    }

    #[tokio::test]
    async fn hsts_is_only_emitted_for_forwarded_https() {
        let app = test_app("web/dist").await;

        let plain = get(&app, "/api/v1/health", None).await;
        assert!(plain
            .headers()
            .get(header::STRICT_TRANSPORT_SECURITY)
            .is_none());

        let https = get(&app, "/api/v1/health", Some("https")).await;
        assert_eq!(
            https
                .headers()
                .get(header::STRICT_TRANSPORT_SECURITY)
                .expect("HTTPS 访问必须带 HSTS"),
            "max-age=31536000"
        );
    }

    /// gzip 对全站 JSON 生效：`Content-Encoding: gzip` + `Vary: Accept-Encoding`，
    /// 解压后与不压缩的响应完全一致。
    #[tokio::test]
    async fn json_responses_are_gzipped_when_the_client_accepts_it() {
        use axum::response::IntoResponse;
        use tower_http::compression::predicate::{DefaultPredicate, Predicate};

        use pierwave_domain::repo;

        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        // 一台服务器就足够让响应明显大于 32 字节的压缩阈值。
        repo::servers::create(&state.db.pool, "edge-1", "203.0.113.9", "external")
            .await
            .unwrap();
        let app = router(state);

        let plain = get(&app, "/api/v1/public/status", None).await;
        assert_eq!(plain.status(), StatusCode::OK);
        assert!(
            plain.headers().get(header::CONTENT_ENCODING).is_none(),
            "客户端没有 Accept-Encoding 时不能压缩"
        );
        let plain_body = axum::body::to_bytes(plain.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();

        let compressed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/public/status")
                    .header(header::ACCEPT_ENCODING, "gzip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(compressed.status(), StatusCode::OK);
        assert_eq!(
            compressed
                .headers()
                .get(header::CONTENT_ENCODING)
                .expect("必须带 Content-Encoding"),
            "gzip"
        );
        let vary = compressed
            .headers()
            .get(header::VARY)
            .expect("压缩响应必须带 Vary")
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        assert!(vary.contains("accept-encoding"), "Vary = {vary}");
        let bytes = axum::body::to_bytes(compressed.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        assert!(bytes.len() < plain_body.len(), "gzip 应该更小");
        let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
        let mut decoded = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut decoded).unwrap();
        assert_eq!(decoded, plain_body, "解压后必须与未压缩响应逐字节一致");

        // 二进制下载（application/octet-stream）与图片不压缩：默认谓词负责
        // 图片 / SSE / gRPC / 32 字节以下，[`CompressibleResponse`] 负责二进制。
        let predicate = CompressibleResponse(DefaultPredicate::new());
        for (content_type, expected) in [
            ("application/octet-stream", false),
            ("application/zip", false),
            ("image/png", false),
            ("application/json", true),
            ("text/html; charset=utf-8", true),
        ] {
            let response = (
                StatusCode::OK,
                [(header::CONTENT_TYPE, content_type)],
                Body::from(vec![b'x'; 1024]),
            )
                .into_response();
            assert_eq!(
                predicate.should_compress(&response),
                expected,
                "content-type = {content_type}"
            );
        }
    }

    // ---- T2：错误响应的 gzip 等价性 ----

    /// 建一个管理员与一个普通用户，返回路由、状态和两个会话 Cookie。
    async fn auth_test_app() -> (Router, AppState, String, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let mut cookies = Vec::new();
        for (username, role) in [("admin", "admin"), ("bob", "user")] {
            let user = pierwave_domain::repo::users::create(
                &db.pool,
                pierwave_domain::repo::users::NewUser {
                    username: username.into(),
                    password: "devpass".into(),
                    role: role.into(),
                    quota_bytes: None,
                    rule_template_id: None,
                    subscription_template_id: None,
                },
            )
            .await
            .unwrap();
            let (token, _) =
                pierwave_domain::repo::sessions::create(&db.pool, &user.id, 3_600, None)
                    .await
                    .unwrap();
            cookies.push(format!("{}={token}", crate::auth::SESSION_COOKIE));
        }
        let state = AppState::new(db, "web/dist");
        let app = router(state.clone());
        let bob = cookies.pop().unwrap();
        let admin = cookies.pop().unwrap();
        (app, state, admin, bob)
    }

    /// 构造一次 API 请求；`accept_gzip` 控制是否声明 gzip，`xff` 用于可控限流键。
    fn api_request(
        method: Method,
        uri: &str,
        cookie: Option<&str>,
        body: Option<&str>,
        xff: Option<&str>,
        accept_gzip: bool,
    ) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        if let Some(xff) = xff {
            builder = builder.header("x-forwarded-for", xff);
        }
        if body.is_some() {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        if accept_gzip {
            builder = builder.header(header::ACCEPT_ENCODING, "gzip");
        }
        builder
            .body(
                body.map(|body| Body::from(body.to_owned()))
                    .unwrap_or_else(Body::empty),
            )
            .unwrap()
    }

    async fn read_response(
        app: &Router,
        request: Request<Body>,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec();
        (status, headers, bytes)
    }

    /// 同一请求在「不压缩 / 接受 gzip」两种情况下必须逐字节等价。
    ///
    /// 断言：状态码一致；只有声明 gzip 时才压缩；压缩响应带
    /// `Vary: Accept-Encoding`；`/api/` 的 `Cache-Control: no-store` 在两种
    /// 响应里都保留；gzip 体解压后与未压缩体完全一致。返回状态码与未压缩
    /// 响应体，供调用方再断言具体错误类型。
    async fn assert_gzip_equivalent(
        app: &Router,
        label: &str,
        make: impl Fn(bool) -> Request<Body>,
    ) -> (StatusCode, Vec<u8>) {
        let (plain_status, plain_headers, plain_body) = read_response(app, make(false)).await;
        let (gzip_status, gzip_headers, gzip_body) = read_response(app, make(true)).await;

        assert_eq!(plain_status, gzip_status, "{label}: 压缩不能改变状态码");
        assert!(
            plain_headers.get(header::CONTENT_ENCODING).is_none(),
            "{label}: 未声明 Accept-Encoding 时不能压缩"
        );
        assert_eq!(
            gzip_headers
                .get(header::CONTENT_ENCODING)
                .and_then(|value| value.to_str().ok()),
            Some("gzip"),
            "{label}: 必须带 Content-Encoding: gzip"
        );
        let vary = gzip_headers
            .get(header::VARY)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(
            vary.contains("accept-encoding"),
            "{label}: 压缩响应必须带 Vary: Accept-Encoding，实际 {vary}"
        );
        for (kind, headers) in [("plain", &plain_headers), ("gzip", &gzip_headers)] {
            assert_eq!(
                headers
                    .get(header::CACHE_CONTROL)
                    .and_then(|value| value.to_str().ok()),
                Some("no-store"),
                "{label}: {kind} 响应必须保留 /api/ 的 no-store"
            );
        }
        let mut decoder = flate2::read::GzDecoder::new(&gzip_body[..]);
        let mut decoded = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut decoded).unwrap();
        assert_eq!(
            decoded, plain_body,
            "{label}: 解压后必须与未压缩响应逐字节一致"
        );
        (plain_status, plain_body)
    }

    /// 把错误响应体解析成 JSON，便于按 `code` 断言具体错误类型。
    fn error_body(bytes: &[u8]) -> serde_json::Value {
        serde_json::from_slice(bytes).expect("错误响应必须是 JSON 信封")
    }

    /// T2-400：设置校验错误（`settings.panel_name_length_invalid`）。
    #[tokio::test]
    async fn gzip_keeps_400_validation_error_byte_identical() {
        let (app, _state, admin, _bob) = auth_test_app().await;
        let (status, body) = assert_gzip_equivalent(&app, "400", |gzip| {
            api_request(
                Method::PATCH,
                "/api/v1/settings",
                Some(&admin),
                Some(r#"{"panel_name":""}"#),
                None,
                gzip,
            )
        })
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            error_body(&body)["code"],
            "settings.panel_name_length_invalid"
        );
    }

    /// T2-401：未登录访问受保护接口。
    #[tokio::test]
    async fn gzip_keeps_401_unauthorized_error_byte_identical() {
        let (app, _state, _admin, _bob) = auth_test_app().await;
        let (status, body) = assert_gzip_equivalent(&app, "401", |gzip| {
            api_request(Method::GET, "/api/v1/settings", None, None, None, gzip)
        })
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(error_body(&body)["code"], "auth.unauthorized");
    }

    /// T2-403：普通用户访问管理员接口。
    #[tokio::test]
    async fn gzip_keeps_403_forbidden_error_byte_identical() {
        let (app, _state, _admin, bob) = auth_test_app().await;
        let (status, body) = assert_gzip_equivalent(&app, "403", |gzip| {
            api_request(
                Method::GET,
                "/api/v1/settings",
                Some(&bob),
                None,
                None,
                gzip,
            )
        })
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(error_body(&body)["code"], "auth.forbidden");
    }

    /// T2-404：公开状态页请求不存在的服务器。
    #[tokio::test]
    async fn gzip_keeps_404_not_found_error_byte_identical() {
        let (app, _state, _admin, _bob) = auth_test_app().await;
        let (status, body) = assert_gzip_equivalent(&app, "404", |gzip| {
            api_request(
                Method::GET,
                "/api/v1/public/status/does-not-exist",
                None,
                None,
                None,
                gzip,
            )
        })
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error_body(&body)["code"], "public_status.not_found");
    }

    /// T2-422：JSON 字段类型不匹配（全局错误信封）。
    #[tokio::test]
    async fn gzip_keeps_422_json_type_error_byte_identical() {
        let (app, _state, _admin, _bob) = auth_test_app().await;
        let (status, body) = assert_gzip_equivalent(&app, "422", |gzip| {
            api_request(
                Method::POST,
                "/api/v1/auth/login",
                None,
                Some(r#"{"username":1,"password":"devpass"}"#),
                None,
                gzip,
            )
        })
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_body(&body)["code"], "request.invalid_json");
    }

    /// T2-429：公开状态页限流（`public_status.rate_limited`）。
    #[tokio::test]
    async fn gzip_keeps_429_rate_limit_error_byte_identical() {
        let (app, _state) = test_app_with_state(1).await;
        let ip = "203.0.113.99";
        // 先花掉唯一一次额度，让 plain / gzip 两次请求都拿到 429。
        assert_eq!(
            get_with_ip(&app, "/api/v1/public/status", ip).await.0,
            StatusCode::OK
        );
        let (status, body) = assert_gzip_equivalent(&app, "429", |gzip| {
            api_request(
                Method::GET,
                "/api/v1/public/status",
                None,
                None,
                Some(ip),
                gzip,
            )
        })
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(error_body(&body)["code"], "public_status.rate_limited");
    }

    /// T2-503：公开状态页快照单飞重建等待超时（`public_status.overloaded`）。
    #[tokio::test]
    async fn gzip_keeps_503_single_flight_timeout_byte_identical() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist")
            .with_public_status_wait(std::time::Duration::from_millis(30));
        let app = router(state.clone());

        let started = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let leader = {
            let cache = state.public_status.clone();
            let started = started.clone();
            let release = release.clone();
            tokio::spawn(async move {
                cache
                    .get_or_build(|| async move {
                        started.notify_one();
                        // 一直占着单飞锁，直到两次 HTTP 请求都超时返回 503。
                        release.notified().await;
                        Ok::<_, AppError>(crate::state::PublicStatusSnapshot::default())
                    })
                    .await
            })
        };
        started.notified().await;

        let (status, body) = assert_gzip_equivalent(&app, "503", |gzip| {
            api_request(Method::GET, "/api/v1/public/status", None, None, None, gzip)
        })
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error_body(&body)["code"], "public_status.overloaded");

        // 放行 leader：超时只影响等待者，不能把缓存永久锁死。
        release.notify_one();
        assert!(leader.await.unwrap().is_ok());
        let response = get(&app, "/api/v1/public/status", None).await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "leader 完成后必须恢复正常"
        );
    }

    #[test]
    fn redact_uri_hides_subscription_code_and_api_query() {
        let uri: Uri = "/api/v1/sub/abc123".parse().unwrap();
        assert_eq!(redact_uri(&uri), "/api/v1/sub/<redacted>");

        let uri: Uri = "/api/v1/sub/abc123?target=clash".parse().unwrap();
        assert_eq!(redact_uri(&uri), "/api/v1/sub/<redacted>?<redacted>");

        let uri: Uri = "/api/agent/install.sh?token=secret".parse().unwrap();
        assert_eq!(redact_uri(&uri), "/api/agent/install.sh?<redacted>");

        let uri: Uri = "/assets/app.js?v=1".parse().unwrap();
        assert_eq!(redact_uri(&uri), "/assets/app.js?v=1");
    }

    // ---- S1：公开状态页的按 IP 读取限流 ----

    /// 60 次内 200，第 61 次 429 + `Retry-After`；其它 IP 不受影响。
    #[tokio::test]
    async fn public_status_read_limit_allows_sixty_then_429() {
        let (app, _state) = test_app_with_state(60).await;
        let ip = "203.0.113.60";

        for index in 0..60 {
            let (status, _) = get_with_ip(&app, "/api/v1/public/status", ip).await;
            assert_eq!(status, StatusCode::OK, "第 {} 次读取应当成功", index + 1);
        }

        let (status, headers) = get_with_ip(&app, "/api/v1/public/status", ip).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "第 61 次必须 429");
        let retry_after = headers
            .get(header::RETRY_AFTER)
            .expect("429 必须带 Retry-After")
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert!(
            (1..=60).contains(&retry_after),
            "Retry-After 不合理：{retry_after}"
        );

        let (status, _) = get_with_ip(&app, "/api/v1/public/status", "203.0.113.61").await;
        assert_eq!(status, StatusCode::OK, "别的 IP 不受影响");
    }

    /// 列表与详情共用同一个 IP 桶：两个入口各拿一份额度等于限流无效。
    #[tokio::test]
    async fn public_status_list_and_detail_share_one_read_budget() {
        let (app, state) = test_app_with_state(2).await;
        let (server, _) = pierwave_domain::repo::servers::create(
            &state.db.pool,
            "edge-1",
            "203.0.113.9",
            "external",
        )
        .await
        .unwrap();
        let ip = "203.0.113.62";

        assert_eq!(
            get_with_ip(&app, "/api/v1/public/status", ip).await.0,
            StatusCode::OK
        );
        assert_eq!(
            get_with_ip(&app, &format!("/api/v1/public/status/{}", server.id), ip)
                .await
                .0,
            StatusCode::OK,
            "详情与列表共用同一个桶"
        );
        let (status, headers) = get_with_ip(&app, "/api/v1/public/status", ip).await;
        assert_eq!(
            status,
            StatusCode::TOO_MANY_REQUESTS,
            "列表 + 详情合计超限后一律 429"
        );
        assert!(headers.get(header::RETRY_AFTER).is_some());
    }

    /// 伪造 / 轮换 `X-Forwarded-For` 第一跳换不出新额度；mapped 写法也一样。
    #[tokio::test]
    async fn forged_xff_cannot_bypass_the_public_read_limit() {
        let (app, _state) = test_app_with_state(3).await;
        let real = "203.0.113.70";

        for index in 0..3 {
            // nginx `$proxy_add_x_forwarded_for`：客户端伪造的在左，真实地址在最右。
            let xff = format!("10.9.9.{index}, {real}");
            assert_eq!(
                get_with_ip(&app, "/api/v1/public/status", &xff).await.0,
                StatusCode::OK
            );
        }

        let xff = format!("10.9.9.99, {real}");
        assert_eq!(
            get_with_ip(&app, "/api/v1/public/status", &xff).await.0,
            StatusCode::TOO_MANY_REQUESTS,
            "伪造左端不能换出新额度"
        );

        // IPv4-mapped IPv6 与纯 IPv4 是同一个地址，必须共用计数。
        let mapped = format!("::ffff:{real}");
        assert_eq!(
            get_with_ip(&app, "/api/v1/public/status", &mapped).await.0,
            StatusCode::TOO_MANY_REQUESTS,
            "mapped 写法不能绕过限流"
        );
    }

    /// 健康检查不限流；公开读取 429 不写认证失败表（两张表完全分开）。
    #[tokio::test]
    async fn public_read_limit_leaves_health_and_auth_failures_alone() {
        let (app, _state) = test_app_with_state(2).await;
        let ip = "203.0.113.71";

        assert_eq!(
            get_with_ip(&app, "/api/v1/public/status", ip).await.0,
            StatusCode::OK
        );
        assert_eq!(
            get_with_ip(&app, "/api/v1/public/status", ip).await.0,
            StatusCode::OK
        );
        assert_eq!(
            get_with_ip(&app, "/api/v1/public/status", ip).await.0,
            StatusCode::TOO_MANY_REQUESTS
        );

        // 监控探针不能被公开页的 429 误伤。
        assert_eq!(
            get_with_ip(&app, "/api/v1/health", ip).await.0,
            StatusCode::OK,
            "健康检查不参与公开读取限流"
        );

        // 坏 Bearer 仍走认证失败表：401（而不是被公开读取的 429 挡住）。
        assert_eq!(
            bad_bearer_with_ip(&app, ip).await,
            StatusCode::UNAUTHORIZED,
            "公开读取限流不能写进认证失败表"
        );
    }

    /// 反向：认证失败打满也不消耗公开读取额度（公开入口本来就不受 IP 锁定影响）。
    #[tokio::test]
    async fn auth_failures_do_not_consume_the_public_read_budget() {
        let (app, _state) = test_app_with_state(2).await;
        let ip = "203.0.113.72";

        for _ in 0..crate::throttle::IP_MAX_FAILURES {
            let _ = bad_bearer_with_ip(&app, ip).await;
        }

        assert_eq!(
            get_with_ip(&app, "/api/v1/public/status", ip).await.0,
            StatusCode::OK
        );
        assert_eq!(
            get_with_ip(&app, "/api/v1/public/status", ip).await.0,
            StatusCode::OK
        );
        assert_eq!(
            get_with_ip(&app, "/api/v1/public/status", ip).await.0,
            StatusCode::TOO_MANY_REQUESTS,
            "公开读取额度必须是独立的一份"
        );
    }

    // ---- S2：公开状态页快照的单飞重建 ----

    /// 20 个并发请求只触发 1 次重建，且每个请求都拿到结果。
    #[tokio::test]
    async fn concurrent_public_status_requests_rebuild_the_snapshot_once() {
        let (app, state) = test_app_with_state(1_000).await;
        pierwave_domain::repo::servers::create(&state.db.pool, "edge-1", "203.0.113.9", "external")
            .await
            .unwrap();

        let mut tasks = Vec::new();
        for _ in 0..20 {
            let app = app.clone();
            tasks.push(tokio::spawn(async move {
                let response = app
                    .oneshot(
                        Request::builder()
                            .method(Method::GET)
                            .uri("/api/v1/public/status")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let status = response.status();
                let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                    .await
                    .unwrap();
                (status, bytes)
            }));
        }

        for task in tasks {
            let (status, bytes) = task.await.unwrap();
            assert_eq!(status, StatusCode::OK, "重建期间的请求都必须拿到结果");
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["summary"]["servers_total"], 1, "{body}");
        }

        let (rebuilds, _waited_hits, timeouts, failures) = state.public_status.stats();
        assert_eq!(rebuilds, 1, "20 个并发请求只能触发 1 次重建");
        assert_eq!((timeouts, failures), (0, 0));
    }

    /// 等待超过上限时返回 503（而不是每个等待者各自重算），leader 完成后恢复。
    #[tokio::test]
    async fn public_status_returns_503_when_the_rebuild_wait_times_out() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist")
            .with_public_status_wait(std::time::Duration::from_millis(30));
        let app = router(state.clone());

        let started = std::sync::Arc::new(tokio::sync::Notify::new());
        let leader = {
            let cache = state.public_status.clone();
            let started = started.clone();
            tokio::spawn(async move {
                cache
                    .get_or_build(|| async move {
                        started.notify_one();
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                        Ok::<_, crate::error::AppError>(
                            crate::state::PublicStatusSnapshot::default(),
                        )
                    })
                    .await
            })
        };
        started.notified().await;

        let response = get(&app, "/api/v1/public/status", None).await;
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "等待重建超时必须 503"
        );
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "public_status.overloaded", "{body}");
        assert!(
            body["error"].as_str().unwrap().contains("稍后重试"),
            "错误文案必须是中文兜底：{body}"
        );

        assert!(leader.await.unwrap().is_ok());
        let response = get(&app, "/api/v1/public/status", None).await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "leader 完成后必须恢复正常"
        );
    }
}
