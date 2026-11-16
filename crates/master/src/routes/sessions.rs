//! 登录设备（会话）管理：查看 / 踢出。
//!
//! 归属规则写死在路由层，前端只负责展示：
//! * `/api/v1/sessions*` 永远只作用于**会话用户自己**，路径里没有 user id；
//! * 普通用户踢别人的会话返回 **404**（不泄露该会话是否存在）；
//! * 管理员可以通过 `/api/v1/users/{id}/sessions*` 查看并踢掉任意用户的会话，
//!   与用户端复用同一组 repo 函数；
//! * 踢掉当前会话时响应会清掉 Cookie，前端据此立即跳登录页；
//! * 踢出动作写审计（`auth.session_kick` / `auth.sessions_kick_others`），
//!   只记会话 id 与设备摘要，不记 token 哈希/明文。

use axum::extract::{Path, Query, State};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::Session;
use pierwave_domain::{password, repo};

use crate::auth::{clear_cookie, CurrentUser, SESSION_COOKIE};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 用户端「最近登录」条数：产品要求固定 5 条。
const RECENT_LOGINS: i64 = 5;

#[derive(Deserialize)]
pub struct OthersQuery {
    /// `1` / `true` / `yes` 表示「退出其它设备」；缺省或其它值返回 400，
    /// 避免误操作把「删除全部会话」当成默认行为。
    pub others: Option<String>,
}

/// 当前请求 Cookie 的 token 哈希；API Token 请求没有 Cookie，返回 None。
fn current_token_hash(jar: &CookieJar) -> Option<String> {
    jar.get(SESSION_COOKIE)
        .map(|cookie| password::sha256_hex(cookie.value()))
}

fn is_current(session: &Session, hash: Option<&str>) -> bool {
    hash.is_some_and(|hash| hash == session.token_hash)
}

/// 对外形状：不含 token 哈希/明文；UA 原样返回，由前端解析成设备摘要。
fn session_json(session: &Session, current_hash: Option<&str>) -> Value {
    json!({
        "id": session.id,
        "user_id": session.user_id,
        "user_agent": session.user_agent,
        "ip": session.ip,
        "created_at": session.created_at,
        "last_seen_at": session.last_seen_at,
        "expires_at": session.expires_at,
        "current": is_current(session, current_hash),
    })
}

/// `GET /api/v1/sessions`：当前用户的全部会话，最新签发在前。
pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    jar: CookieJar,
) -> AppResult<Json<Value>> {
    let hash = current_token_hash(&jar);
    let mut sessions = repo::sessions::list_for_user(&state.db.pool, &user.0.id).await?;
    sessions.reverse();
    let items: Vec<Value> = sessions
        .iter()
        .map(|session| session_json(session, hash.as_deref()))
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// `DELETE /api/v1/sessions/{id}`：踢掉指定会话。
///
/// 普通用户只能踢自己的；管理员可以踢任意用户的（用户管理页复用）。
/// 越权一律 404，避免通过状态码判断别人的会话是否存在。
pub async fn revoke(
    State(state): State<AppState>,
    Path(id): Path<String>,
    user: CurrentUser,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<Value>)> {
    let target = repo::sessions::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("session.not_found", None, "会话不存在"))?;

    let is_admin = user.0.role == "admin";
    if target.user_id != user.0.id && !is_admin {
        return Err(AppError::not_found("session.not_found", None, "会话不存在"));
    }

    let current = is_current(&target, current_token_hash(&jar).as_deref());
    repo::sessions::delete_by_id(&state.db.pool, &target.id).await?;

    crate::audit::record(
        &state,
        &user.0,
        "auth.session_kick",
        &target.user_id,
        json!({
            "session_id": target.id,
            "ip": target.ip,
            "user_agent": target.user_agent,
            "current": current,
            "other_user": target.user_id != user.0.id,
        }),
    )
    .await;

    let jar = if current {
        jar.add(clear_cookie())
    } else {
        jar
    };
    Ok((jar, Json(json!({ "ok": true, "current": current }))))
}

/// `DELETE /api/v1/sessions?others=1`：保留当前会话，踢掉其它全部会话。
pub async fn revoke_others(
    State(state): State<AppState>,
    Query(query): Query<OthersQuery>,
    user: CurrentUser,
    jar: CookieJar,
) -> AppResult<Json<Value>> {
    let enabled = matches!(
        query.others.as_deref().map(str::trim),
        Some("1" | "true" | "yes")
    );
    if !enabled {
        return Err(AppError::coded(
            "session.others_required",
            None,
            "缺少 others=1 参数 / missing others=1",
        ));
    }

    let token = jar
        .get(SESSION_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .ok_or_else(|| {
            AppError::unauthorized("auth.unauthorized", None, "未登录 / not signed in")
        })?;
    let revoked = repo::sessions::delete_others(&state.db.pool, &user.0.id, &token).await?;

    crate::audit::record(
        &state,
        &user.0,
        "auth.sessions_kick_others",
        &user.0.id,
        json!({ "revoked": revoked }),
    )
    .await;

    Ok(Json(json!({ "ok": true, "revoked": revoked })))
}

/// `GET /api/v1/users/{id}/sessions`：管理员查看某用户的会话。
pub async fn admin_list(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
    admin: CurrentUser,
    jar: CookieJar,
) -> AppResult<Json<Value>> {
    admin.require_admin()?;
    let target = repo::users::find_by_id_opt(&state.db.pool, &user_id)
        .await?
        .ok_or_else(|| AppError::not_found("user.not_found", None, "资源不存在"))?;

    let hash = current_token_hash(&jar);
    let mut sessions = repo::sessions::list_for_user(&state.db.pool, &target.id).await?;
    sessions.reverse();
    let items: Vec<Value> = sessions
        .iter()
        .map(|session| session_json(session, hash.as_deref()))
        .collect();
    Ok(Json(json!({
        "user": { "id": target.id, "username": target.username },
        "items": items,
    })))
}

/// `DELETE /api/v1/users/{id}/sessions/{session_id}`：管理员踢掉某用户的会话。
///
/// 路径里的 user id 必须与会话归属一致，否则 404——避免管理员误把
/// 「用户 A 的页面」当成可以删除任意 session id 的入口。
pub async fn admin_revoke(
    State(state): State<AppState>,
    Path((user_id, session_id)): Path<(String, String)>,
    admin: CurrentUser,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<Value>)> {
    admin.require_admin()?;
    let target = repo::sessions::find_by_id(&state.db.pool, &session_id)
        .await?
        .filter(|session| session.user_id == user_id)
        .ok_or_else(|| AppError::not_found("session.not_found", None, "会话不存在"))?;

    let current = is_current(&target, current_token_hash(&jar).as_deref());
    repo::sessions::delete_by_id(&state.db.pool, &target.id).await?;

    crate::audit::record(
        &state,
        &admin.0,
        "auth.session_kick",
        &target.user_id,
        json!({
            "session_id": target.id,
            "ip": target.ip,
            "user_agent": target.user_agent,
            "current": current,
            "via": "admin",
        }),
    )
    .await;

    let jar = if current {
        jar.add(clear_cookie())
    } else {
        jar
    };
    Ok((jar, Json(json!({ "ok": true, "current": current }))))
}

/// `GET /api/v1/me/logins`：自己的最近 5 条成功登录记录。
///
/// 只按会话用户过滤，响应里不含别人的记录；失败登录属于安全审计，
/// 普通用户的这个接口只返回成功登录，避免把别人的撞库尝试暴露给用户。
pub async fn recent_logins(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Value>> {
    let items = repo::audit::recent_logins(&state.db.pool, &user.0.id, RECENT_LOGINS).await?;
    Ok(Json(json!({ "items": items })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Arc;
    use std::time::Duration;

    use axum::body::Body;
    use axum::http::{header, HeaderMap, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::models::User;
    use pierwave_domain::Db;

    use crate::alerts::{Alerts, RecordingTransport};

    async fn setup() -> (Router, AppState) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (app, state)
    }

    async fn setup_with_alerts() -> (Router, AppState, Arc<RecordingTransport>) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let transport = Arc::new(RecordingTransport::default());
        let mut state = AppState::new(db, "web/dist");
        state.alerts = Alerts::new(transport.clone());
        let app = crate::app::router(state.clone());
        (app, state, transport)
    }

    async fn configure_webhook(state: &AppState, events: &str, cooldown: i64) {
        for (key, value) in [
            ("webhook_url", "https://example.test/hooks/pierwave"),
            ("alert_events", events),
            ("alert_cooldown_secs", &cooldown.to_string()),
        ] {
            repo::settings::set(&state.db.pool, key, value)
                .await
                .unwrap();
        }
    }

    async fn make_user(state: &AppState, username: &str, role: &str) -> User {
        repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: username.into(),
                password: "password123".into(),
                role: role.into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
            },
        )
        .await
        .unwrap()
    }

    async fn make_session(
        state: &AppState,
        user_id: &str,
        user_agent: Option<&str>,
        ip: Option<&str>,
    ) -> (String, String) {
        let (token, _) =
            repo::sessions::create_with_client(&state.db.pool, user_id, 3600, user_agent, ip)
                .await
                .unwrap();
        let cookie = format!("{}={token}", SESSION_COOKIE);
        (token, cookie)
    }

    fn cookie_from(headers: &HeaderMap) -> String {
        headers
            .get(header::SET_COOKIE)
            .expect("响应必须设置 Cookie")
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string()
    }

    async fn send(
        app: &Router,
        method: Method,
        uri: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "panel.example.com")
            .header(header::USER_AGENT, "TestBrowser/1.0");
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, headers, value)
    }

    async fn login(
        app: &Router,
        username: &str,
        password: &str,
        ip: &str,
    ) -> (StatusCode, HeaderMap, Value) {
        let builder = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/login")
            .header(header::HOST, "panel.example.com")
            .header(header::USER_AGENT, "TestBrowser/1.0")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", ip);
        let response = app
            .clone()
            .oneshot(
                builder
                    .body(Body::from(
                        json!({ "username": username, "password": password }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            headers,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn list_is_scoped_to_the_current_user_and_marks_current_session() {
        let (app, state) = setup().await;
        let alice = make_user(&state, "alice", "user").await;
        let bob = make_user(&state, "bob", "user").await;
        let (_, alice_cookie) =
            make_session(&state, &alice.id, Some("Alice/1.0"), Some("203.0.113.1")).await;
        let (_, alice_second) =
            make_session(&state, &alice.id, Some("Phone/2.0"), Some("203.0.113.2")).await;
        let (bob_token, _) =
            make_session(&state, &bob.id, Some("Bob/1.0"), Some("198.51.100.9")).await;

        let (status, _, body) = send(
            &app,
            Method::GET,
            "/api/v1/sessions",
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "只返回自己的会话：{body}");
        assert!(items.iter().all(|item| item["user_id"] == alice.id));
        assert!(
            !body.to_string().contains(&bob_token),
            "不能泄露别人的 token"
        );
        assert!(items.iter().any(|item| item["user_agent"] == "Alice/1.0"));
        assert!(items.iter().any(|item| item["user_agent"] == "Phone/2.0"));
        assert_eq!(
            items.iter().filter(|item| item["current"] == true).count(),
            1,
            "必须且只能标记当前会话：{body}"
        );
        let current = items.iter().find(|item| item["current"] == true).unwrap();
        assert_eq!(current["user_agent"], "Alice/1.0");
        assert_eq!(current["ip"], "203.0.113.1");
        assert!(current["last_seen_at"].as_i64().unwrap() > 0);

        let (status, _, body) = send(
            &app,
            Method::GET,
            "/api/v1/sessions",
            Some(&alice_second),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["current"] == true)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn kicking_own_session_works_and_kicking_someone_elses_is_404() {
        let (app, state) = setup().await;
        let alice = make_user(&state, "alice", "user").await;
        let bob = make_user(&state, "bob", "user").await;
        let (_, alice_cookie) = make_session(&state, &alice.id, None, None).await;
        let (_, alice_second) = make_session(&state, &alice.id, None, None).await;
        let (_, bob_cookie) = make_session(&state, &bob.id, None, None).await;

        let (status, _, body) = send(
            &app,
            Method::GET,
            "/api/v1/sessions",
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let bob_session = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["user_id"] == bob.id);
        assert!(bob_session.is_none(), "列表不能出现别人的会话");

        let bob_id = repo::sessions::list_for_user(&state.db.pool, &bob.id)
            .await
            .unwrap()[0]
            .id
            .clone();
        let (status, _, body) = send(
            &app,
            Method::DELETE,
            &format!("/api/v1/sessions/{bob_id}"),
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "越权必须是 404：{body}");
        let (status, _, _) = send(
            &app,
            Method::GET,
            "/api/v1/auth/me",
            Some(&bob_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "越权失败不能影响别人的会话");

        // 踢掉自己的另一条会话。
        let token = alice_cookie.split('=').nth(1).unwrap();
        let current_id = repo::sessions::authenticate(&state.db.pool, token)
            .await
            .unwrap()
            .unwrap()
            .session_id;
        let second_id = repo::sessions::list_for_user(&state.db.pool, &alice.id)
            .await
            .unwrap()
            .into_iter()
            .find(|session| session.id != current_id)
            .unwrap()
            .id;
        let (status, _, body) = send(
            &app,
            Method::DELETE,
            &format!("/api/v1/sessions/{second_id}"),
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["current"], false);
        let (status, _, _) = send(
            &app,
            Method::GET,
            "/api/v1/auth/me",
            Some(&alice_second),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "被踢的会话必须立即失效");

        // 踢掉当前会话：返回 current=true 并清 Cookie。
        let (status, headers, body) = send(
            &app,
            Method::DELETE,
            &format!("/api/v1/sessions/{current_id}"),
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["current"], true);
        assert!(
            headers
                .get(header::SET_COOKIE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .contains("Max-Age=0"),
            "踢掉当前会话必须清 Cookie"
        );
        let (status, _, _) = send(
            &app,
            Method::GET,
            "/api/v1/auth/me",
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let actions: Vec<String> = repo::audit::list(&state.db.pool, 20)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.action)
            .collect();
        assert!(
            actions
                .iter()
                .filter(|action| *action == "auth.session_kick")
                .count()
                >= 2
        );
    }

    #[tokio::test]
    async fn kick_all_others_keeps_current_and_requires_the_flag() {
        let (app, state) = setup().await;
        let alice = make_user(&state, "alice", "user").await;
        let bob = make_user(&state, "bob", "user").await;
        let (_, alice_cookie) = make_session(&state, &alice.id, None, None).await;
        let (_, alice_second) = make_session(&state, &alice.id, None, None).await;
        let (_, alice_third) = make_session(&state, &alice.id, None, None).await;
        let (_, bob_cookie) = make_session(&state, &bob.id, None, None).await;

        let (status, _, body) = send(
            &app,
            Method::DELETE,
            "/api/v1/sessions",
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "缺少 others=1 必须拒绝：{body}"
        );

        let (status, _, body) = send(
            &app,
            Method::DELETE,
            "/api/v1/sessions?others=1",
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["revoked"], 2);

        let (status, _, _) = send(
            &app,
            Method::GET,
            "/api/v1/auth/me",
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "当前会话必须保留");
        for cookie in [&alice_second, &alice_third] {
            let (status, _, _) =
                send(&app, Method::GET, "/api/v1/auth/me", Some(cookie), None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "其它会话必须失效");
        }
        let (status, _, _) = send(
            &app,
            Method::GET,
            "/api/v1/auth/me",
            Some(&bob_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "不能动别人的会话");

        let actions: Vec<String> = repo::audit::list(&state.db.pool, 20)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.action)
            .collect();
        assert!(actions
            .iter()
            .any(|action| action == "auth.sessions_kick_others"));
    }

    #[tokio::test]
    async fn admin_can_list_and_kick_any_users_sessions() {
        let (app, state) = setup().await;
        let admin = make_user(&state, "root", "admin").await;
        let alice = make_user(&state, "alice", "user").await;
        let (_, admin_cookie) = make_session(&state, &admin.id, None, None).await;
        let (_, alice_cookie) = make_session(&state, &alice.id, None, None).await;
        let (_, alice_cookie2) = make_session(&state, &alice.id, None, None).await;

        let (status, _, body) = send(
            &app,
            Method::GET,
            &format!("/api/v1/users/{}/sessions", alice.id),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["user"]["username"], "alice");
        assert_eq!(body["items"].as_array().unwrap().len(), 2);

        let (status, _, _) = send(
            &app,
            Method::GET,
            &format!("/api/v1/users/{}/sessions", alice.id),
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "普通用户不能看别人的会话");

        let session_id = repo::sessions::list_for_user(&state.db.pool, &alice.id)
            .await
            .unwrap()[0]
            .id
            .clone();
        let (status, _, body) = send(
            &app,
            Method::DELETE,
            &format!("/api/v1/users/{}/sessions/{session_id}", alice.id),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, _, _) = send(
            &app,
            Method::GET,
            "/api/v1/auth/me",
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        // 用户 id 与会话归属不一致 → 404。
        let other_id = repo::sessions::list_for_user(&state.db.pool, &alice.id)
            .await
            .unwrap()[0]
            .id
            .clone();
        let (status, _, _) = send(
            &app,
            Method::DELETE,
            &format!("/api/v1/users/{}/sessions/{other_id}", admin.id),
            Some(&admin_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = send(
            &app,
            Method::GET,
            "/api/v1/auth/me",
            Some(&alice_cookie2),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "404 时不能误删");
    }

    #[tokio::test]
    async fn last_seen_is_written_at_low_frequency() {
        let (app, state) = setup().await;
        let alice = make_user(&state, "alice", "user").await;
        let (_, alice_cookie) = make_session(&state, &alice.id, None, None).await;
        let session = repo::sessions::list_for_user(&state.db.pool, &alice.id)
            .await
            .unwrap()
            .remove(0);
        let old = repo::now() - 120;
        repo::sessions::touch(&state.db.pool, &session.id, old)
            .await
            .unwrap();

        let (status, _, _) = send(
            &app,
            Method::GET,
            "/api/v1/auth/me",
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let after = repo::sessions::list_for_user(&state.db.pool, &alice.id)
            .await
            .unwrap()[0]
            .last_seen_at
            .unwrap();
        assert!(after > old, "超过节流窗口的请求必须更新 last_seen_at");

        // 把库值改回旧的：内存节流窗口内仍不能写库，证明不是每个请求都写。
        repo::sessions::touch(&state.db.pool, &session.id, old)
            .await
            .unwrap();
        let (status, _, _) = send(
            &app,
            Method::GET,
            "/api/v1/auth/me",
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let unchanged = repo::sessions::list_for_user(&state.db.pool, &alice.id)
            .await
            .unwrap()[0]
            .last_seen_at
            .unwrap();
        assert_eq!(unchanged, old, "节流窗口内不能重复写库");
    }

    #[tokio::test]
    async fn login_audit_records_success_failure_and_logout_without_password() {
        let (app, state) = setup().await;
        make_user(&state, "alice", "user").await;

        let (status, _, body) = login(&app, "alice", "wrong-password", "203.0.113.5").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        let (status, headers, _) = login(&app, "alice", "password123", "203.0.113.5").await;
        assert_eq!(status, StatusCode::OK);
        let cookie = cookie_from(&headers);
        let (status, _, _) = send(
            &app,
            Method::POST,
            "/api/v1/auth/logout",
            Some(&cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = send(&app, Method::GET, "/api/v1/auth/me", Some(&cookie), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "登出后会话必须失效");

        let entries = repo::audit::list(&state.db.pool, 20).await.unwrap();
        for action in ["auth.login_failed", "auth.login", "auth.logout"] {
            assert!(
                entries.iter().any(|entry| entry.action == action),
                "缺少审计：{action}"
            );
        }
        let failed = entries
            .iter()
            .find(|entry| entry.action == "auth.login_failed")
            .unwrap();
        assert_eq!(failed.detail.as_ref().unwrap()["username"], "alice");
        assert_eq!(failed.detail.as_ref().unwrap()["reason"], "bad_password");
        let detail = failed.detail.as_ref().unwrap().to_string();
        assert!(!detail.contains("wrong-password"), "审计不能记录密码");
        assert!(!detail.contains("password123"), "审计不能记录密码");
        let success = entries
            .iter()
            .find(|entry| entry.action == "auth.login")
            .unwrap();
        assert!(!success
            .detail
            .as_ref()
            .unwrap()
            .to_string()
            .contains("password"));
    }

    #[tokio::test]
    async fn recent_logins_returns_only_own_last_five() {
        let (app, state) = setup().await;
        let alice = make_user(&state, "alice", "user").await;
        let bob = make_user(&state, "bob", "user").await;

        for index in 0..6 {
            let (status, _, _) =
                login(&app, "alice", "password123", &format!("203.0.113.{index}")).await;
            assert_eq!(status, StatusCode::OK);
        }
        let (status, _, _) = login(&app, "bob", "password123", "198.51.100.1").await;
        assert_eq!(status, StatusCode::OK);

        let (_, alice_cookie) = make_session(&state, &alice.id, None, None).await;
        let (status, _, body) = send(
            &app,
            Method::GET,
            "/api/v1/me/logins",
            Some(&alice_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 5, "最多 5 条：{body}");
        assert!(items
            .iter()
            .all(|item| item["ip"].as_str().unwrap().starts_with("203.0.113.")));
        assert!(
            !body.to_string().contains("198.51.100.1"),
            "不能包含别人的登录"
        );
        assert!(items[0]["created_at"].as_i64().unwrap() > 0);

        let (_, bob_cookie) = make_session(&state, &bob.id, None, None).await;
        let (_, _, body) = send(
            &app,
            Method::GET,
            "/api/v1/me/logins",
            Some(&bob_cookie),
            None,
        )
        .await;
        assert_eq!(body["items"].as_array().unwrap().len(), 1);
        assert_eq!(body["items"][0]["ip"], "198.51.100.1");
    }

    // ------------------------------------------------------------------
    // 告警：登录失败 / 新 IP
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn login_failure_alerts_once_at_threshold_and_respects_cooldown() {
        let (app, state, transport) = setup_with_alerts().await;
        configure_webhook(&state, "login_failed", 600).await;
        make_user(&state, "alice", "user").await;

        for _ in 0..5 {
            let (status, _, _) = login(&app, "alice", "wrong-password", "203.0.113.8").await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
        }
        let sent = transport.wait_for(1).await;
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].kind, "login_failed");
        assert_eq!(sent[0].target, "alice");
        assert!(!sent[0].body.contains("wrong-password"));

        // 第 6 次已被限流；计数继续累加，但同一窗口不重复告警。
        let (status, _, _) = login(&app, "alice", "wrong-password", "203.0.113.8").await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        transport
            .assert_no_more(1, Duration::from_millis(150))
            .await;

        // 即使计数清零（模拟另一个窗口），渠道冷却仍然挡住重复投递。
        state.login_watch.clear("alice");
        for _ in 0..5 {
            let _ = login(&app, "alice", "wrong-password", "203.0.113.8").await;
        }
        transport
            .assert_no_more(1, Duration::from_millis(150))
            .await;
    }

    #[tokio::test]
    async fn new_ip_alert_fires_only_for_the_first_login_from_an_ip() {
        let (app, state, transport) = setup_with_alerts().await;
        configure_webhook(&state, "login_new_ip", 0).await;
        make_user(&state, "alice", "user").await;

        let (status, headers, _) = login(&app, "alice", "password123", "203.0.113.20").await;
        assert_eq!(status, StatusCode::OK);
        let first_cookie = cookie_from(&headers);
        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "login_new_ip");
        assert!(sent[0].body.contains("203.0.113.20"));

        let (status, _, _) = send(
            &app,
            Method::POST,
            "/api/v1/auth/logout",
            Some(&first_cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = login(&app, "alice", "password123", "203.0.113.20").await;
        assert_eq!(status, StatusCode::OK);
        transport
            .assert_no_more(1, Duration::from_millis(150))
            .await;

        let (status, _, _) = login(&app, "alice", "password123", "203.0.113.21").await;
        assert_eq!(status, StatusCode::OK);
        let sent = transport.wait_for(2).await;
        assert!(sent[1].body.contains("203.0.113.21"));
    }

    #[tokio::test]
    async fn disabled_switches_suppress_login_alerts() {
        let (app, state, transport) = setup_with_alerts().await;
        configure_webhook(&state, "server_offline", 0).await;
        make_user(&state, "alice", "user").await;
        make_user(&state, "bob", "user").await;

        for _ in 0..5 {
            let _ = login(&app, "alice", "wrong-password", "203.0.113.30").await;
        }
        // 账号维度已锁定，换一个账号验证「新 IP 事件」同样被关闭。
        let (status, _, _) = login(&app, "bob", "password123", "203.0.113.31").await;
        assert_eq!(status, StatusCode::OK);
        transport
            .assert_no_more(0, Duration::from_millis(150))
            .await;
    }
}
