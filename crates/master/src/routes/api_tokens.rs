//! 作用域化 API Token：列表、创建（明文只返回一次）、吊销。
//!
//! 路由挂载见 `crate::app`；鉴权中间件见 `crate::auth::api_token_middleware`。
//! 明细/审计都只出现名称、scope 与时间戳，**不出现明文、哈希**。

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct CreateApiTokenRequest {
    pub name: String,
    #[serde(default)]
    pub scope: Option<String>,
    /// Unix 秒；`null` / 缺省 = 永久有效。
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// `GET /api/v1/api-tokens`：包含已吊销/已过期行的管理列表。
///
/// `ApiToken` 的 `token_hash` 带 `#[serde(skip)]`，所以即使有人误加字段，
/// 哈希也不会出现在响应里。
pub async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_full_admin()?;
    let items = repo::api_tokens::list(&state.db.pool).await?;
    Ok(Json(json!({ "items": items })))
}

/// `POST /api/v1/api-tokens`：创建并**仅此一次**返回 `token` 明文。
pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateApiTokenRequest>,
) -> AppResult<Json<Value>> {
    user.require_full_admin()?;

    let name = normalize_name(&body.name)?;
    let scope = normalize_scope(body.scope.as_deref())?;
    let expires_at = validate_expires_at(body.expires_at)?;

    let (row, plaintext) =
        repo::api_tokens::create(&state.db.pool, &name, scope, expires_at).await?;

    // 审计只记录 id / 名称 / scope / 过期时间；明文与哈希一律不落 detail。
    crate::audit::record(
        &state,
        &user.0,
        "api_token.create",
        &row.id,
        json!({
            "name": row.name,
            "scope": row.scope,
            "expires_at": row.expires_at,
        }),
    )
    .await;

    Ok(Json(json!({
        // 唯一一次出现明文的地方。前端只允许在创建成功对话框里展示。
        "token": plaintext,
        "item": row,
    })))
}

/// `DELETE /api/v1/api-tokens/{id}`：吊销（幂等）。
pub async fn revoke(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_full_admin()?;

    let row = repo::api_tokens::get(&state.db.pool, &id)
        .await?
        .ok_or_else(|| {
            AppError::not_found(
                "api_token.not_found",
                None,
                "API Token 不存在 / API token not found",
            )
        })?;
    let changed = repo::api_tokens::revoke(&state.db.pool, &id).await?;

    if changed {
        crate::audit::record(
            &state,
            &user.0,
            "api_token.revoke",
            &row.id,
            json!({ "name": row.name, "scope": row.scope }),
        )
        .await;
    }

    Ok(Json(json!({ "ok": true, "changed": changed })))
}

fn normalize_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > repo::api_tokens::MAX_NAME_CHARS {
        return Err(AppError::coded(
            "api_token.name_invalid",
            Some(json!({ "max": repo::api_tokens::MAX_NAME_CHARS })),
            format!(
                "名称需在 1-{} 个字符之间 / name must be 1-{} characters",
                repo::api_tokens::MAX_NAME_CHARS,
                repo::api_tokens::MAX_NAME_CHARS
            ),
        ));
    }
    if name.chars().any(|character| character.is_control()) {
        return Err(AppError::coded(
            "api_token.name_invalid",
            Some(json!({ "max": repo::api_tokens::MAX_NAME_CHARS })),
            "名称不能包含控制字符 / name cannot contain control characters",
        ));
    }
    Ok(name.to_string())
}

fn normalize_scope(raw: Option<&str>) -> AppResult<&'static str> {
    match raw.map(str::trim).filter(|scope| !scope.is_empty()) {
        None => Ok(repo::api_tokens::SCOPE_READ),
        Some(scope) if scope == repo::api_tokens::SCOPE_READ => Ok(repo::api_tokens::SCOPE_READ),
        Some(scope) if scope == repo::api_tokens::SCOPE_ADMIN => Ok(repo::api_tokens::SCOPE_ADMIN),
        Some(_) => Err(AppError::coded(
            "api_token.scope_invalid",
            Some(json!({
                "allowed": [repo::api_tokens::SCOPE_READ, repo::api_tokens::SCOPE_ADMIN]
            })),
            "scope 只能是 read 或 admin / scope must be read or admin",
        )),
    }
}

/// 过期时间必须是未来时间；`None` = 永久。为了避免「刚创建就过期」的
/// 边界抖动，允许等于当前秒 + 1 以上。
fn validate_expires_at(raw: Option<i64>) -> AppResult<Option<i64>> {
    let Some(expires_at) = raw else {
        return Ok(None);
    };
    if expires_at <= repo::now() {
        return Err(AppError::coded(
            "api_token.expires_at_invalid",
            Some(json!({ "now": repo::now() })),
            "过期时间必须晚于当前时间 / expires_at must be in the future",
        ));
    }
    Ok(Some(expires_at))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_and_scope_are_normalized() {
        assert_eq!(normalize_name("  CI token  ").unwrap(), "CI token");
        assert_eq!(normalize_scope(None).unwrap(), "read");
        assert_eq!(normalize_scope(Some(" read ")).unwrap(), "read");
        assert_eq!(normalize_scope(Some("admin")).unwrap(), "admin");
        assert!(normalize_scope(Some("write")).is_err());
        assert!(normalize_name("").is_err());
        assert!(normalize_name(&"x".repeat(repo::api_tokens::MAX_NAME_CHARS + 1)).is_err());
    }

    #[test]
    fn expiry_must_be_in_the_future() {
        assert_eq!(validate_expires_at(None).unwrap(), None);
        assert!(validate_expires_at(Some(repo::now() - 1)).is_err());
        assert!(validate_expires_at(Some(repo::now() + 3600)).is_ok());
    }
}

#[cfg(test)]
mod http_tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use pierwave_domain::Db;

    #[derive(Clone, Copy)]
    enum Auth<'a> {
        Cookie(&'a str),
        Bearer(&'a str),
        None,
    }

    async fn setup() -> (Router, AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = repo::users::create(
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
        let (session, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={session}", crate::auth::SESSION_COOKIE),
        )
    }

    async fn request(
        app: &Router,
        auth: Auth<'_>,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value, axum::http::HeaderMap) {
        let mut builder = Request::builder().method(method).uri(uri);
        match auth {
            Auth::Cookie(cookie) => {
                builder = builder.header(header::COOKIE, cookie);
            }
            Auth::Bearer(token) => {
                builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
            Auth::None => {}
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
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, value, headers)
    }

    async fn create_token(
        app: &Router,
        cookie: &str,
        name: &str,
        scope: &str,
        expires_at: Option<i64>,
    ) -> (String, String) {
        let (status, body, _) = request(
            app,
            Auth::Cookie(cookie),
            Method::POST,
            "/api/v1/api-tokens",
            Some(json!({ "name": name, "scope": scope, "expires_at": expires_at })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        (
            body["token"].as_str().unwrap().to_string(),
            body["item"]["id"].as_str().unwrap().to_string(),
        )
    }

    /// 核心断言：创建返回一次明文；列表不出现明文/哈希；库里只有哈希。
    #[tokio::test]
    async fn create_returns_plaintext_once_but_list_and_db_never_do() {
        let (app, state, cookie) = setup().await;
        let (plaintext, id) = create_token(&app, &cookie, " CI ", "read", None).await;
        assert!(plaintext.starts_with("pwt_"), "token 前缀必须是 pwt_");
        assert_eq!(plaintext.len(), 4 + 64, "pwt_ + 32 字节 hex");

        let (status, body, _) = request(
            &app,
            Auth::Cookie(&cookie),
            Method::GET,
            "/api/v1/api-tokens",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let rendered = body.to_string();
        assert!(!rendered.contains(&plaintext), "列表不能出现明文");
        assert!(!rendered.contains("token_hash"), "列表不能出现哈希字段");
        assert_eq!(body["items"][0]["name"], "CI", "名称应 trim");
        assert_eq!(body["items"][0]["scope"], "read");
        assert_eq!(body["items"][0]["id"], id);
        assert!(body["items"][0]["last_used_at"].is_null());
        assert!(body["items"][0]["revoked_at"].is_null());

        let stored: String = sqlx::query_scalar("SELECT token_hash FROM api_tokens WHERE id = ?")
            .bind(&id)
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(
            stored,
            pierwave_domain::password::sha256_hex(&plaintext),
            "落库必须是 SHA-256(明文)"
        );
        assert_ne!(stored, plaintext);
    }

    #[tokio::test]
    async fn revoked_token_is_rejected_and_revoke_is_idempotent() {
        let (app, _state, cookie) = setup().await;
        let (plaintext, id) = create_token(&app, &cookie, "revoked", "read", None).await;

        // 吊销前能用。
        let (status, _, _) = request(
            &app,
            Auth::Bearer(&plaintext),
            Method::GET,
            "/api/v1/packages",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, body, _) = request(
            &app,
            Auth::Cookie(&cookie),
            Method::DELETE,
            &format!("/api/v1/api-tokens/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["changed"], true);

        // 再吊销一次：幂等，不重复写审计时间。
        let (status, body, _) = request(
            &app,
            Auth::Cookie(&cookie),
            Method::DELETE,
            &format!("/api/v1/api-tokens/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["changed"], false);

        let (status, body, _) = request(
            &app,
            Auth::Bearer(&plaintext),
            Method::GET,
            "/api/v1/packages",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body["code"], "api_token.invalid");
    }

    #[tokio::test]
    async fn expired_token_is_rejected() {
        let (app, state, _cookie) = setup().await;
        // 绕过路由校验直接建一个过期 token：鉴权必须拒绝。
        let (row, plaintext) =
            repo::api_tokens::create(&state.db.pool, "expired", "read", Some(repo::now() - 10))
                .await
                .unwrap();
        assert!(row.expires_at.unwrap() < repo::now());

        let (status, body, _) = request(
            &app,
            Auth::Bearer(&plaintext),
            Method::GET,
            "/api/v1/packages",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body["code"], "api_token.invalid");
    }

    #[tokio::test]
    async fn read_scope_cannot_write_but_admin_scope_can() {
        let (app, _state, cookie) = setup().await;
        let (read_token, _) = create_token(&app, &cookie, "read", "read", None).await;
        let (admin_token, _) = create_token(&app, &cookie, "admin", "admin", None).await;

        // read scope：GET 通过，写接口 403 read_only。
        let (status, _, _) = request(
            &app,
            Auth::Bearer(&read_token),
            Method::GET,
            "/api/v1/packages",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "read scope 应能读");

        let (status, body, _) = request(
            &app,
            Auth::Bearer(&read_token),
            Method::POST,
            "/api/v1/api-tokens",
            Some(json!({ "name": "nope", "scope": "read" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["code"], "api_token.read_only");

        // 「仅管理员」的 token 管理：read scope 连列表都不行。
        let (status, body, _) = request(
            &app,
            Auth::Bearer(&read_token),
            Method::GET,
            "/api/v1/api-tokens",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["code"], "api_token.sensitive_endpoint");

        // admin scope 等同管理员：可以创建、可以改设置。
        let (status, body, _) = request(
            &app,
            Auth::Bearer(&admin_token),
            Method::POST,
            "/api/v1/api-tokens",
            Some(json!({ "name": "from-admin-token", "scope": "read" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body, _) = request(
            &app,
            Auth::Bearer(&admin_token),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({ "panel_name": "token-write" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["panel_name"], "token-write");
    }

    #[tokio::test]
    async fn rate_limit_returns_429_with_retry_after() {
        let (app, state, cookie) = setup().await;
        let (token, _) = create_token(&app, &cookie, "limited", "read", None).await;
        state.api_token_throttle.set_limit(2);

        for _ in 0..2 {
            let (status, _, _) = request(
                &app,
                Auth::Bearer(&token),
                Method::GET,
                "/api/v1/packages",
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
        }
        let (status, body, headers) = request(
            &app,
            Auth::Bearer(&token),
            Method::GET,
            "/api/v1/packages",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
        assert_eq!(body["code"], "api_token.rate_limited");
        assert!(
            headers.get(header::RETRY_AFTER).is_some(),
            "429 必须带 Retry-After"
        );
    }

    #[tokio::test]
    async fn last_used_at_is_buffered_then_flushed() {
        let (app, state, cookie) = setup().await;
        let (token, id) = create_token(&app, &cookie, "usage", "read", None).await;

        let (status, _, _) = request(
            &app,
            Auth::Bearer(&token),
            Method::GET,
            "/api/v1/packages",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(state.api_token_usage.pending(), 1, "热路径只写内存");
        assert!(
            repo::api_tokens::get(&state.db.pool, &id)
                .await
                .unwrap()
                .unwrap()
                .last_used_at
                .is_none(),
            "请求返回时还没写库"
        );

        assert_eq!(
            state.api_token_usage.flush(&state.db.pool).await.unwrap(),
            1
        );
        let row = repo::api_tokens::get(&state.db.pool, &id)
            .await
            .unwrap()
            .unwrap();
        assert!(row.last_used_at.is_some(), "flush 后应写回 last_used_at");
    }

    #[tokio::test]
    async fn audit_entries_never_contain_the_plaintext() {
        let (app, state, cookie) = setup().await;
        let (plaintext, id) = create_token(&app, &cookie, "audited", "admin", None).await;
        let (status, _, _) = request(
            &app,
            Auth::Cookie(&cookie),
            Method::DELETE,
            &format!("/api/v1/api-tokens/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let page = repo::audit::page(&state.db.pool, &repo::audit::Filter::default(), None, 50)
            .await
            .unwrap();
        let create = page
            .items
            .iter()
            .find(|entry| entry.action == "api_token.create")
            .expect("必须有 api_token.create 审计");
        let revoke = page
            .items
            .iter()
            .find(|entry| entry.action == "api_token.revoke")
            .expect("必须有 api_token.revoke 审计");
        let hash = pierwave_domain::password::sha256_hex(&plaintext);
        for entry in [create, revoke] {
            let rendered = entry
                .detail
                .as_ref()
                .map(Value::to_string)
                .unwrap_or_default();
            assert!(!rendered.contains(&plaintext), "审计不能有明文：{rendered}");
            assert!(!rendered.contains(&hash), "审计不能有哈希：{rendered}");
            assert!(
                rendered.contains("audited"),
                "审计应带名称便于追溯：{rendered}"
            );
        }
    }

    /// 敏感路径的集中名单：read scope 一律 403 `api_token.sensitive_endpoint`。
    #[tokio::test]
    async fn read_scope_is_denied_on_sensitive_get_paths() {
        let (app, state, cookie) = setup().await;
        let (read_token, _) = create_token(&app, &cookie, "read-sensitive", "read", None).await;
        let (server, _) = repo::servers::create(&state.db.pool, "hk", "10.0.0.1", "external")
            .await
            .unwrap();
        let batch = repo::upgrade_batches::create(
            &state.db.pool,
            std::slice::from_ref(&server.id),
            "0.13.4",
            true,
            1,
        )
        .await
        .unwrap();
        let paths = [
            "/api/v1/backup".to_string(),
            "/api/v1/backup/info".to_string(),
            "/api/v1/backup/remote".to_string(),
            "/api/v1/certificates".to_string(),
            "/api/v1/audit".to_string(),
            "/api/v1/settings".to_string(),
            "/api/v1/api-tokens".to_string(),
            "/api/v1/servers".to_string(),
            "/api/v1/nodes".to_string(),
            "/api/v1/chains".to_string(),
            "/api/v1/chain-templates".to_string(),
            "/api/v1/users".to_string(),
            "/api/v1/subscriptions".to_string(),
            format!("/api/v1/agent-upgrades/batches/{}", batch.id),
            format!("/api/v1/servers/{}/nodes", server.id),
            format!("/api/v1/servers/{}/outbounds", server.id),
            format!("/api/v1/servers/{}/routing-rules", server.id),
            format!("/api/v1/servers/{}/forwards", server.id),
        ];
        for path in paths {
            let (status, body, _) =
                request(&app, Auth::Bearer(&read_token), Method::GET, &path, None).await;
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "{path} 必须对 read scope 返回 403：{body}"
            );
            assert_eq!(
                body["code"], "api_token.sensitive_endpoint",
                "{path}: {body}"
            );
        }
    }

    /// 名单边界：前缀不能误伤相邻路径。
    #[test]
    fn sensitive_path_matching_respects_segment_boundaries() {
        assert!(crate::auth::is_sensitive_read_path("/api/v1/backup"));
        assert!(crate::auth::is_sensitive_read_path("/api/v1/backup/info"));
        assert!(crate::auth::is_sensitive_read_path(
            "/api/v1/servers/abc/nodes"
        ));
        assert!(crate::auth::is_sensitive_read_path(
            "/api/v1/chain-templates"
        ));
        assert!(crate::auth::is_sensitive_read_path("/api/v1/routing-rules"));
        assert!(crate::auth::is_sensitive_read_path(
            "/api/v1/agent-upgrades/batches/abc"
        ));
        // 集合列表本身不含服务器名/版本，read token 仍可读。
        assert!(!crate::auth::is_sensitive_read_path(
            "/api/v1/agent-upgrades/batches"
        ));
        assert!(!crate::auth::is_sensitive_read_path("/api/v1/overview"));
        assert!(!crate::auth::is_sensitive_read_path(
            "/api/v1/stats/traffic"
        ));
        assert!(!crate::auth::is_sensitive_read_path(
            "/api/v1/forward-traffic"
        ));
        assert!(!crate::auth::is_sensitive_read_path("/api/v1/serversX"));
        assert!(!crate::auth::is_sensitive_read_path(
            "/api/v1/chain-templatesX"
        ));
    }

    /// admin scope 不受敏感名单影响：代表性 JSON 接口保持 200。
    #[tokio::test]
    async fn admin_scope_can_read_sensitive_endpoints() {
        let (app, state, cookie) = setup().await;
        let (admin_token, _) = create_token(&app, &cookie, "admin-sensitive", "admin", None).await;
        let (server, _) = repo::servers::create(&state.db.pool, "hk", "10.0.0.1", "external")
            .await
            .unwrap();
        let batch = repo::upgrade_batches::create(
            &state.db.pool,
            std::slice::from_ref(&server.id),
            "0.13.4",
            true,
            1,
        )
        .await
        .unwrap();
        let paths = [
            "/api/v1/certificates".to_string(),
            "/api/v1/audit".to_string(),
            "/api/v1/settings".to_string(),
            "/api/v1/api-tokens".to_string(),
            "/api/v1/servers".to_string(),
            "/api/v1/nodes".to_string(),
            "/api/v1/chains".to_string(),
            "/api/v1/chain-templates".to_string(),
            "/api/v1/users".to_string(),
            "/api/v1/subscriptions".to_string(),
            format!("/api/v1/agent-upgrades/batches/{}", batch.id),
            format!("/api/v1/servers/{}/nodes", server.id),
            format!("/api/v1/servers/{}/outbounds", server.id),
            format!("/api/v1/servers/{}/routing-rules", server.id),
        ];
        for path in paths {
            let (status, body, _) =
                request(&app, Auth::Bearer(&admin_token), Method::GET, &path, None).await;
            assert_eq!(status, StatusCode::OK, "admin 应可访问 {path}：{body}");
        }

        // 备份相关接口在内存库上会 400（不支持备份），但绝不能是 scope 403。
        for path in [
            "/api/v1/backup",
            "/api/v1/backup/info",
            "/api/v1/backup/remote",
        ] {
            let (status, body, _) =
                request(&app, Auth::Bearer(&admin_token), Method::GET, path, None).await;
            assert_ne!(status, StatusCode::FORBIDDEN, "{path}: {body}");
            assert_ne!(
                body["code"], "api_token.sensitive_endpoint",
                "{path}: {body}"
            );
        }
    }

    /// 文件型数据库上证明 admin scope 真的能下载整库备份。
    #[tokio::test]
    async fn admin_scope_can_download_the_database_backup() {
        let path = std::path::PathBuf::from(format!(
            "target/test-api-tokens-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Db::connect(&format!("sqlite://{}?mode=rwc", path.display()))
            .await
            .unwrap();
        db.migrate().await.unwrap();
        let admin = repo::users::create(
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
        let (session, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        let cookie = format!("{}={session}", crate::auth::SESSION_COOKIE);
        let (admin_token, _) = create_token(&app, &cookie, "backup-admin", "admin", None).await;

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/backup")
                    .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "admin scope 必须能下载备份"
        );
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/gzip"
        );
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        assert!(!bytes.is_empty());

        drop(app);
        state.db.pool.close().await;
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn missing_auth_is_401_for_token_endpoints() {
        let (app, _state, _cookie) = setup().await;
        let (status, body, _) =
            request(&app, Auth::None, Method::GET, "/api/v1/api-tokens", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body["code"], "auth.unauthorized");

        // 畸形/非 pwt_ 的 Bearer 不接管，仍然走 Cookie 路径 → 401。
        let (status, _, _) = request(
            &app,
            Auth::Bearer("pwt_not-a-real-token"),
            Method::GET,
            "/api/v1/settings",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn creates_are_bilingual_and_validate_input() {
        let (app, _state, cookie) = setup().await;
        for body in [
            json!({ "name": "" }),
            json!({ "name": "x".repeat(65) }),
            json!({ "name": "scope", "scope": "write" }),
            json!({ "name": "expiry", "expires_at": repo::now() - 1 }),
        ] {
            let (status, body, _) = request(
                &app,
                Auth::Cookie(&cookie),
                Method::POST,
                "/api/v1/api-tokens",
                Some(body.clone()),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert!(
                body["error"].as_str().unwrap().contains(" / "),
                "错误必须中英双语：{body}"
            );
        }
    }
}
