use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{Extensions, HeaderMap};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::json;

use pierwave_domain::models::{SessionUser, User};
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

/// 登录输入上限（UTF-8 字节数）。超限直接 400，不进入限流表、也不跑 Argon2。
pub const MAX_USERNAME_BYTES: usize = 128;
pub const MAX_PASSWORD_BYTES: usize = 256;

/// 未知用户也校验一次固定 Argon2 哈希，让两个分支的耗时接近。
///
/// 哈希参数与 `Argon2::default()` 一致（Argon2id / m=19456 / t=2 / p=1）；
/// 明文是固定占位值，永远不会与任何用户密码匹配。
const DUMMY_PASSWORD_HASH: &str =
    "$argon2id$v=19$m=19456,t=2,p=1$hhAUHGk4U6vl32NSjMwJEw$1LtGMm6BVIeh1JMJY26qiPl/BntPvi+NduR7s+UL3Qo";

/// 凭据校验的统一入口；`None` 表示用户名不存在。
///
/// 先抽出可注入的 `verify` 版本：测试可以在纯函数层面断言「未知用户也调用了一次
/// 哈希校验」，不必依赖容易 flake 的耗时断言。
fn verify_credentials_with(
    user: Option<&User>,
    password: &str,
    verify: &mut dyn FnMut(&str, &str) -> bool,
) -> bool {
    match user {
        Some(user) => verify(password, &user.password_hash),
        // 未知用户也校验一次：耗时与「密码错误」接近，不能靠响应时间区分账号是否存在。
        None => {
            let _ = verify(password, DUMMY_PASSWORD_HASH);
            false
        }
    }
}

fn verify_credentials(user: Option<&User>, password: &str) -> bool {
    verify_credentials_with(user, password, &mut password::verify)
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

/// UA 存库上限：够区分设备，又不给审计表塞一整段离谱的请求头。
const MAX_USER_AGENT_CHARS: usize = 512;

fn user_agent(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())?
        .trim();
    if raw.is_empty() {
        return None;
    }
    Some(raw.chars().take(MAX_USER_AGENT_CHARS).collect())
}

/// 写进 sessions.ip / 告警里的 IP：`unknown` 不落库，避免把占位符当真实 IP。
fn stored_ip(ip: &str) -> Option<String> {
    let ip = ip.trim();
    if ip.is_empty() || ip == "unknown" {
        None
    } else {
        Some(ip.to_string())
    }
}

/// 登录失败审计：记用户名（含未知用户）、原因分类与 IP，**绝不记密码**。
async fn audit_login_failure(
    state: &AppState,
    user_id: Option<&str>,
    username: &str,
    ip: &str,
    reason: &str,
) {
    let target = user_id.unwrap_or(username);
    crate::audit::record_anonymous(
        state,
        user_id,
        "auth.login_failed",
        target,
        json!({
            "username": username,
            "reason": reason,
            "ip": ip,
        }),
    )
    .await;
}

/// 连续失败达到阈值时发一次 `login_failed`；渠道层再做冷却。
async fn maybe_alert_login_failure(state: &AppState, threshold: u32, username: &str, ip: &str) {
    if !state.login_watch.record_failure(
        username,
        threshold,
        crate::login_watch::LOGIN_FAILURE_WINDOW,
    ) {
        return;
    }
    crate::alerts::notify(
        state,
        crate::alerts::AlertKind::LoginFailed,
        username,
        "连续登录失败 / Repeated login failures",
        &format!(
            "用户 {username} 在 10 分钟内连续失败 {threshold} 次（最近 IP：{ip}）/ \
             User {username} failed {threshold} times within 10 minutes (latest IP: {ip})"
        ),
    )
    .await;
}

pub async fn login(
    State(state): State<AppState>,
    ip: ClientIp,
    headers: HeaderMap,
    jar: CookieJar,
    Json(req): Json<LoginRequest>,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    // 阈值每次登录都从设置表取一次：设置页改完不需要重启。
    let settings = settings::load(&state.db.pool).await;
    let max_attempts = settings.login_max_attempts.clamp(1, 20) as u32;
    state.login_throttle.configure(
        max_attempts,
        settings.login_lock_secs.clamp(60, 86400) as u64,
    );

    // 先按 UTF-8 字节数卡上限：超长输入既不进限流表，也不跑 Argon2。
    if req.username.len() > MAX_USERNAME_BYTES {
        return Err(AppError::coded(
            "auth.username_too_long",
            Some(json!({ "max_bytes": MAX_USERNAME_BYTES })),
            format!(
                "用户名最多 {MAX_USERNAME_BYTES} 字节 / Username must be at most {MAX_USERNAME_BYTES} bytes"
            ),
        ));
    }
    if req.password.len() > MAX_PASSWORD_BYTES {
        return Err(AppError::coded(
            "auth.password_too_long",
            Some(json!({ "max_bytes": MAX_PASSWORD_BYTES })),
            format!(
                "密码最多 {MAX_PASSWORD_BYTES} 字节 / Password must be at most {MAX_PASSWORD_BYTES} bytes"
            ),
        ));
    }

    let username = req.username.trim();
    let key = Key::new(username, ip.0.clone());
    if let Err(retry_after) = state.login_throttle.check(&key) {
        audit_login_failure(&state, None, username, &ip.0, "rate_limited").await;
        maybe_alert_login_failure(&state, max_attempts, username, &ip.0).await;
        return Err(AppError::TooManyAttempts(retry_after));
    }

    // 未知用户也要跑一次固定 dummy 哈希，避免通过响应耗时枚举用户名。
    let user = repo::users::find_by_username(&state.db.pool, username).await?;
    if !verify_credentials(user.as_ref(), &req.password) {
        let (user_id, reason) = match user.as_ref() {
            Some(user) => (Some(user.id.as_str()), "bad_password"),
            None => (None, "unknown_user"),
        };
        state.login_throttle.record_failure(&key);
        audit_login_failure(&state, user_id, username, &ip.0, reason).await;
        maybe_alert_login_failure(&state, max_attempts, username, &ip.0).await;
        return Err(AppError::InvalidCredentials);
    }
    let Some(user) = user else {
        // `verify_credentials_with(None, ..)` 恒为 false，正常不会走到这里。
        return Err(AppError::InvalidCredentials);
    };
    if user.status != "active" {
        audit_login_failure(&state, Some(&user.id), username, &ip.0, "disabled").await;
        maybe_alert_login_failure(&state, max_attempts, username, &ip.0).await;
        return Err(AppError::forbidden(
            "auth.account_disabled",
            None,
            "权限不足",
        ));
    }

    state.login_throttle.clear(&key);
    state.login_watch.clear(username);

    let ttl_secs = settings.session_ttl_secs();
    let secure_cookie = crate::auth::request_is_https(&headers);
    let agent = user_agent(&headers);
    let ip_value = stored_ip(&ip.0);
    let (token, _) = repo::sessions::create_with_client(
        &state.db.pool,
        &user.id,
        ttl_secs,
        agent.as_deref(),
        ip_value.as_deref(),
    )
    .await?;

    // 成功登录后记录 IP；首次出现的 IP 触发一次 `login_new_ip`。
    let new_ip = match ip_value.as_deref() {
        Some(ip) => repo::login_ips::record(&state.db.pool, &user.id, ip, repo::now()).await?,
        None => false,
    };
    crate::audit::record(
        &state,
        &user,
        "auth.login",
        &user.id,
        json!({
            "ip": ip_value.clone(),
            "user_agent": agent.clone(),
            "new_ip": new_ip,
        }),
    )
    .await;
    if new_ip {
        let ip = ip_value.as_deref().unwrap_or("unknown");
        crate::alerts::notify(
            &state,
            crate::alerts::AlertKind::LoginNewIp,
            &user.id,
            "新 IP 登录 / New IP sign-in",
            &format!(
                "用户 {} 从新 IP {ip} 登录成功 / User {} signed in from a new IP {ip}",
                user.username, user.username
            ),
        )
        .await;
    }

    let body = json!({
        "user": SessionUser {
            id: user.id.clone(),
            username: user.username.clone(),
            role: user.role.clone(),
            short_code: user.short_code.clone(),
        }
    });
    Ok((
        jar.add(session_cookie(token, ttl_secs, secure_cookie)),
        Json(body),
    ))
}

pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
    user: Option<CurrentUser>,
    session: crate::auth::CurrentSession,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        repo::sessions::delete_by_token(&state.db.pool, cookie.value()).await?;
        if let Some(user) = user {
            crate::audit::record(
                &state,
                &user.0,
                "auth.logout",
                &user.0.id,
                json!({
                    "session_id": session.0.map(|meta| meta.session_id),
                }),
            )
            .await;
        }
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
                subscription_template_id: None,
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
        login_with_proto(app, username, password, forwarded_for, None).await
    }

    async fn login_with_proto(
        app: &Router,
        username: &str,
        password: &str,
        forwarded_for: &str,
        forwarded_proto: Option<&str>,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut builder = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", forwarded_for);
        if let Some(proto) = forwarded_proto {
            builder = builder.header("x-forwarded-proto", proto);
        }
        let response = app
            .clone()
            .oneshot(
                builder
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
    async fn login_sets_secure_cookie_when_forwarded_https() {
        let (app, _state) = setup().await;
        let (status, headers, body) =
            login_with_proto(&app, "admin", "devpass", "203.0.113.10", Some("https")).await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let cookie = headers
            .get(header::SET_COOKIE)
            .expect("登录成功必须 Set-Cookie")
            .to_str()
            .unwrap();
        assert!(
            cookie.contains("Secure"),
            "HTTPS 反代下必须加 Secure：{cookie}"
        );
        assert!(cookie.contains("HttpOnly"), "{cookie}");
        assert!(cookie.contains("SameSite=Lax"), "{cookie}");
    }

    #[tokio::test]
    async fn login_cookie_is_not_secure_on_plain_http() {
        let (app, _state) = setup().await;
        let (status, headers, body) =
            login_with_proto(&app, "admin", "devpass", "203.0.113.11", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let cookie = headers
            .get(header::SET_COOKIE)
            .expect("登录成功必须 Set-Cookie")
            .to_str()
            .unwrap();
        assert!(
            !cookie.contains("Secure"),
            "纯 HTTP 不能加 Secure，否则本地登录失效：{cookie}"
        );
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

    /// 超长输入必须是 400，且不能进限流表（否则攻击者可以用超长用户名灌表）。
    #[tokio::test]
    async fn oversized_credentials_are_rejected_before_the_throttle() {
        let (app, state) = setup().await;
        let ip = "203.0.113.77";

        let username = "u".repeat(MAX_USERNAME_BYTES + 1);
        let (status, _, body) = login(&app, &username, "whatever", ip).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let message = body["error"].as_str().unwrap();
        assert!(message.contains("用户名"), "{message}");
        assert!(
            message.contains("Username"),
            "错误信息要中英双语：{message}"
        );
        assert_eq!(state.login_throttle.len(), 0, "超长输入不能进限流表");

        let password = "p".repeat(MAX_PASSWORD_BYTES + 1);
        let (status, _, body) = login(&app, "admin", &password, ip).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let message = body["error"].as_str().unwrap();
        assert!(message.contains("密码"), "{message}");
        assert!(
            message.contains("Password"),
            "错误信息要中英双语：{message}"
        );
        assert_eq!(state.login_throttle.len(), 0, "超长输入不能进限流表");

        // 边界值本身合法：仍然走正常的「凭据错误」路径，而不是 400。
        let username = "u".repeat(MAX_USERNAME_BYTES);
        let (status, _, _) = login(&app, &username, "whatever", ip).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let password = "p".repeat(MAX_PASSWORD_BYTES);
        let (status, _, _) = login(&app, "admin", &password, ip).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    /// 未知用户也必须跑一次哈希校验（用固定 dummy 哈希），避免靠响应耗时枚举用户名。
    #[test]
    fn unknown_users_still_run_one_password_verification() {
        let mut calls: Vec<(String, String)> = Vec::new();
        let accepted = verify_credentials_with(None, "guess", &mut |plain, hash| {
            calls.push((plain.to_string(), hash.to_string()));
            false
        });

        assert!(!accepted);
        assert_eq!(calls.len(), 1, "未知用户必须校验且只校验一次");
        assert_eq!(calls[0].0, "guess");
        assert_eq!(
            calls[0].1, DUMMY_PASSWORD_HASH,
            "未知用户必须校验固定的 dummy 哈希"
        );

        // dummy 哈希本身是合法 Argon2 PHC 串，否则校验会立即返回、起不到等时作用。
        assert!(
            password::verify("pierwave-dummy-password", DUMMY_PASSWORD_HASH),
            "dummy 哈希必须能被 Argon2 正常解析"
        );
        assert!(!password::verify("wrong-password", DUMMY_PASSWORD_HASH));
    }

    /// 已知用户仍然只校验自己的哈希，不能多跑一次 dummy。
    #[test]
    fn known_users_verify_their_own_hash_once() {
        let user = User {
            id: "user-1".into(),
            username: "admin".into(),
            password_hash: "stored-hash".into(),
            role: "admin".into(),
            status: "active".into(),
            short_code: String::new(),
            short_code_updated_at: 0,
            quota_bytes: None,
            used_bytes: 0,
            rule_template_id: None,
            subscription_template_id: None,
            created_at: 0,
            updated_at: 0,
        };

        let mut calls: Vec<(String, String)> = Vec::new();
        let accepted = verify_credentials_with(Some(&user), "guess", &mut |plain, hash| {
            calls.push((plain.to_string(), hash.to_string()));
            true
        });

        assert!(accepted);
        assert_eq!(
            calls,
            vec![("guess".to_string(), "stored-hash".to_string())]
        );
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
