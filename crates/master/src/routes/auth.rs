use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{Extensions, HeaderMap};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::json;

use pierwave_domain::models::SessionUser;
use pierwave_domain::{password, repo};

use crate::auth::{clear_cookie, session_cookie, CurrentUser, SESSION_COOKIE};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::throttle::Key;

use super::settings;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// 客户端 IP：优先 `X-Forwarded-For` 第一段，其次 TCP 对端地址。
///
/// 信任策略见 `docs/PLAN.md`：主控默认只监听回环、生产部署在反向代理后面，
/// 所以这里直接信任 XFF。若把主控直接暴露到公网，攻击者可以伪造 XFF
/// 绕过 IP 维度；此时应让代理覆盖而非透传客户端自带的 XFF
/// （账号维度仍会按用户名聚合，不会被 XFF 绕过）。
pub struct ClientIp(pub String);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(ClientIp(client_ip(&parts.headers, &parts.extensions)))
    }
}

/// 只有直连方是回环/内网时，才相信它转发的 `X-Forwarded-For`。
///
/// 主控可能被直接暴露在公网（IP:port 直连部署），此时任何人都能伪造 XFF，
/// 无条件采信会让「单 IP 撞多账号」这条限流形同虚设。
fn is_trusted_proxy(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        // IPv6 唯一本地地址 fc00::/7
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

fn client_ip(headers: &HeaderMap, extensions: &Extensions) -> String {
    let peer = extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip());

    if let Some(peer) = peer {
        if !is_trusted_proxy(peer) {
            return peer.to_string();
        }
    }

    if let Some(first) = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|first| !first.is_empty())
    {
        return first.to_string();
    }

    peer.map(|ip| ip.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

pub async fn login(
    State(state): State<AppState>,
    ip: ClientIp,
    jar: CookieJar,
    Json(req): Json<LoginRequest>,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    // 阈值每次登录都从设置表取一次：设置页改完不需要重启。
    let settings = settings::load(&state.db.pool).await;
    state.login_throttle.configure(
        settings.login_max_attempts.clamp(1, 20) as u32,
        settings.login_lock_secs.clamp(60, 86400) as u64,
    );

    let key = Key::new(req.username.trim(), ip.0);
    if let Err(retry_after) = state.login_throttle.check(&key) {
        return Err(AppError::TooManyAttempts(retry_after));
    }

    let user = match repo::users::find_by_username(&state.db.pool, &req.username).await? {
        Some(user) => user,
        None => {
            // 未知用户与密码错误走同一条失败路径，不泄露账号是否存在。
            state.login_throttle.record_failure(&key);
            return Err(AppError::InvalidCredentials);
        }
    };
    if !password::verify(&req.password, &user.password_hash) {
        state.login_throttle.record_failure(&key);
        return Err(AppError::InvalidCredentials);
    }
    if user.status != "active" {
        return Err(AppError::forbidden(
            "auth.account_disabled",
            None,
            "权限不足",
        ));
    }

    state.login_throttle.clear(&key);
    let ttl_secs = settings.session_ttl_secs();
    let (token, _) = repo::sessions::create(&state.db.pool, &user.id, ttl_secs, None).await?;
    let body = json!({
        "user": SessionUser {
            id: user.id.clone(),
            username: user.username.clone(),
            role: user.role.clone(),
            short_code: user.short_code.clone(),
        }
    });
    Ok((jar.add(session_cookie(token, ttl_secs)), Json(body)))
}

pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        repo::sessions::delete_by_token(&state.db.pool, cookie.value()).await?;
    }
    Ok((jar.add(clear_cookie()), Json(json!({ "ok": true }))))
}

pub async fn me(user: CurrentUser) -> Json<serde_json::Value> {
    Json(json!({
        "user": SessionUser {
            id: user.0.id,
            username: user.0.username,
            role: user.0.role,
            short_code: user.0.short_code,
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, HeaderValue, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use pierwave_domain::Db;

    async fn setup() -> (Router, AppState) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        repo::users::create(
            &db.pool,
            repo::users::NewUser {
                username: "admin".into(),
                password: "devpass".into(),
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (app, state)
    }

    async fn login(
        app: &Router,
        username: &str,
        password: &str,
        forwarded_for: &str,
    ) -> (StatusCode, HeaderMap, Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/auth/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("x-forwarded-for", forwarded_for)
                    .body(Body::from(
                        json!({"username": username, "password": password}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, headers, body)
    }

    #[tokio::test]
    async fn five_failures_lock_the_login_and_return_retry_after() {
        let (app, _state) = setup().await;
        let ip = "203.0.113.9";

        for _ in 0..5 {
            let (status, _, body) = login(&app, "admin", "wrong-password", ip).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_eq!(body["error"], "用户名或密码错误");
        }

        let (status, headers, body) = login(&app, "admin", "wrong-password", ip).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        let retry_after = headers
            .get(header::RETRY_AFTER)
            .expect("429 必须带 Retry-After")
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert!(
            (1..=900).contains(&retry_after),
            "Retry-After 不合理：{retry_after}"
        );
        assert!(body["error"].as_str().unwrap().contains("尝试过于频繁"));

        // 锁定期内即使密码正确也直接 429，不再验密码。
        let (status, _, _) = login(&app, "admin", "devpass", ip).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn successful_login_clears_the_failure_counter() {
        let (app, _state) = setup().await;
        let ip = "198.51.100.23";

        for _ in 0..4 {
            let (status, _, _) = login(&app, "admin", "wrong-password", ip).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
        }
        let (status, _, body) = login(&app, "admin", "devpass", ip).await;
        assert_eq!(status, StatusCode::OK, "{body}");

        // 计数已清零：再错 4 次仍不到阈值，第 5 次用正确密码能登录成功。
        for _ in 0..4 {
            let (status, _, _) = login(&app, "admin", "wrong-password", ip).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
        }
        let (status, _, body) = login(&app, "admin", "devpass", ip).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "成功登录后必须把失败计数清零：{body}"
        );
    }

    #[tokio::test]
    async fn unknown_users_are_counted_without_leaking_existence() {
        let (app, _state) = setup().await;
        let ip = "192.0.2.44";

        for _ in 0..5 {
            let (status, _, body) = login(&app, "nobody-here", "whatever", ip).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_eq!(
                body["error"], "用户名或密码错误",
                "未知用户不能返回可区分的错误"
            );
        }
        let (status, _, body) = login(&app, "nobody-here", "whatever", ip).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert!(body["error"].as_str().unwrap().contains("尝试过于频繁"));

        // 换一个 IP 用真实账号但密码错：首个失败的响应与未知用户完全一致。
        let (status, _, body) = login(&app, "admin", "wrong-password", "192.0.2.99").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "用户名或密码错误");
    }

    #[test]
    fn client_ip_prefers_the_first_forwarded_hop_then_connect_info() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static(" 203.0.113.7 , 10.0.0.1"),
        );
        assert_eq!(
            client_ip(&headers, &Extensions::new()),
            "203.0.113.7",
            "取第一段并 trim"
        );

        // 空的 XFF 回落 TCP 对端地址。
        let mut empty = HeaderMap::new();
        empty.insert("x-forwarded-for", HeaderValue::from_static("  , 10.0.0.1"));
        let mut extensions = Extensions::new();
        extensions.insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 54321))));
        assert_eq!(client_ip(&empty, &extensions), "127.0.0.1");

        // 两者都没有时用固定占位符，保证限流仍有 key。
        assert_eq!(client_ip(&HeaderMap::new(), &Extensions::new()), "unknown");
    }

    /// 直连方是公网 IP 时，XFF 一律不采信——否则 IP 维度的限流可以被伪造头绕过。
    #[test]
    fn xff_is_ignored_for_public_peers() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9".parse().unwrap());
        let mut extensions = Extensions::new();
        let peer: SocketAddr = "198.51.100.7:44321".parse().unwrap();
        extensions.insert(ConnectInfo(peer));
        assert_eq!(client_ip(&headers, &extensions), "198.51.100.7");

        // 没有 peer 信息时（单测里直接构造请求）仍按 XFF 走，便于测试。
        assert_eq!(client_ip(&headers, &Extensions::new()), "203.0.113.9");
    }

    /// 本机/内网反代转发的 XFF 才被采信。
    #[test]
    fn xff_is_honored_behind_loopback_proxy() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9, 10.0.0.1".parse().unwrap());
        let mut extensions = Extensions::new();
        let peer: SocketAddr = "127.0.0.1:5555".parse().unwrap();
        extensions.insert(ConnectInfo(peer));
        assert_eq!(client_ip(&headers, &extensions), "203.0.113.9");
    }
}
