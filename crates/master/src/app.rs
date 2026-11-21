use axum::body::Body;
use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderName, HeaderValue, Request, Uri};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::{delete, get, patch, post};
use axum::Router;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::routes;
use crate::state::AppState;

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

pub fn router(state: AppState) -> Router {
    let index = state.web_dir.join("index.html");
    let static_files = ServeDir::new(state.web_dir.as_path()).fallback(ServeFile::new(index));

    Router::new()
        .route("/api/v1/health", get(routes::system::health))
        // 公开状态页：无需登录；关闭开关由 handler 自身判断并返回 404。
        .route("/api/v1/public/status", get(routes::public_status::status))
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
}
