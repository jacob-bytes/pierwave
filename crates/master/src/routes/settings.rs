//! 面板设置：白名单键 + 范围校验，全部落 `settings` 表的 key/value。
//!
//! 读取侧统一走 [`load`]：缺省、类型错误、越界、数据库读取失败都回落到默认值，
//! 保证设置表被手工改坏时登录等核心链路仍然可用。

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};
use sqlx::SqlitePool;

use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const DEFAULT_PANEL_NAME: &str = "PierWave";
pub const DEFAULT_LOGIN_MAX_ATTEMPTS: i64 = 5;
pub const DEFAULT_LOGIN_LOCK_SECS: i64 = 900;
pub const DEFAULT_SESSION_TTL_HOURS: i64 = 720;
/// 批量 Agent 升级并发数：默认 1，上限 5。
pub const DEFAULT_AGENT_UPGRADE_CONCURRENCY: i64 = 1;
pub const MIN_AGENT_UPGRADE_CONCURRENCY: i64 = 1;
pub const MAX_AGENT_UPGRADE_CONCURRENCY: i64 = 5;

const PANEL_NAME_KEY: &str = "panel_name";
const LOGIN_MAX_ATTEMPTS_KEY: &str = "login_max_attempts";
const LOGIN_LOCK_SECS_KEY: &str = "login_lock_secs";
const SESSION_TTL_HOURS_KEY: &str = "session_ttl_hours";
const AGENT_UPGRADE_CONCURRENCY_KEY: &str = "agent_upgrade_concurrency";

/// 设置页的四个白名单键；新增键必须同时改这里和 `docs/PLAN.md`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub panel_name: String,
    pub login_max_attempts: i64,
    pub login_lock_secs: i64,
    pub session_ttl_hours: i64,
    pub agent_upgrade_concurrency: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            panel_name: DEFAULT_PANEL_NAME.to_string(),
            login_max_attempts: DEFAULT_LOGIN_MAX_ATTEMPTS,
            login_lock_secs: DEFAULT_LOGIN_LOCK_SECS,
            session_ttl_hours: DEFAULT_SESSION_TTL_HOURS,
            agent_upgrade_concurrency: DEFAULT_AGENT_UPGRADE_CONCURRENCY,
        }
    }
}

impl Settings {
    pub fn session_ttl_secs(&self) -> i64 {
        self.session_ttl_hours.saturating_mul(3600)
    }

    pub fn as_json(&self) -> Value {
        json!({
            "panel_name": self.panel_name,
            "login_max_attempts": self.login_max_attempts,
            "login_lock_secs": self.login_lock_secs,
            "session_ttl_hours": self.session_ttl_hours,
            "agent_upgrade_concurrency": self.agent_upgrade_concurrency,
        })
    }
}

/// 读取当前生效设置；任何单个键异常都只影响它自己。
pub async fn load(pool: &SqlitePool) -> Settings {
    let defaults = Settings::default();
    Settings {
        panel_name: read_panel_name(pool).await,
        login_max_attempts: read_int(
            pool,
            LOGIN_MAX_ATTEMPTS_KEY,
            1,
            20,
            defaults.login_max_attempts,
        )
        .await,
        login_lock_secs: read_int(
            pool,
            LOGIN_LOCK_SECS_KEY,
            60,
            86400,
            defaults.login_lock_secs,
        )
        .await,
        session_ttl_hours: read_int(
            pool,
            SESSION_TTL_HOURS_KEY,
            1,
            720,
            defaults.session_ttl_hours,
        )
        .await,
        agent_upgrade_concurrency: read_int(
            pool,
            AGENT_UPGRADE_CONCURRENCY_KEY,
            MIN_AGENT_UPGRADE_CONCURRENCY,
            MAX_AGENT_UPGRADE_CONCURRENCY,
            defaults.agent_upgrade_concurrency,
        )
        .await,
    }
}

async fn read_panel_name(pool: &SqlitePool) -> String {
    match repo::settings::get(pool, PANEL_NAME_KEY).await {
        Ok(Some(raw)) => {
            let name = raw.trim();
            if (1..=64).contains(&name.chars().count()) {
                name.to_string()
            } else {
                tracing::warn!("settings.panel_name 越界，使用默认值");
                DEFAULT_PANEL_NAME.to_string()
            }
        }
        Ok(None) => DEFAULT_PANEL_NAME.to_string(),
        Err(error) => {
            tracing::warn!(error = %error, "读取 panel_name 失败，使用默认值");
            DEFAULT_PANEL_NAME.to_string()
        }
    }
}

async fn read_int(pool: &SqlitePool, key: &str, min: i64, max: i64, default: i64) -> i64 {
    match repo::settings::get(pool, key).await {
        Ok(Some(raw)) => raw
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|value| (min..=max).contains(value))
            .unwrap_or_else(|| {
                tracing::warn!(key, "settings 值非法，使用默认值 {default}");
                default
            }),
        Ok(None) => default,
        Err(error) => {
            tracing::warn!(key, error = %error, "读取设置失败，使用默认值 {default}");
            default
        }
    }
}

pub async fn get(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let settings = load(&state.db.pool).await;
    Ok(Json(json!({ "items": settings.as_json() })))
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let object = body
        .as_object()
        .ok_or_else(|| AppError::BadRequest("请求体必须是 JSON 对象".into()))?;
    if object.is_empty() {
        return Err(AppError::BadRequest("至少需要提供一个可更新字段".into()));
    }

    // 先全量校验再写库：避免一个非法字段导致前面的字段被半截更新。
    let mut updates: Vec<(&'static str, String)> = Vec::new();
    for (key, value) in object {
        match key.as_str() {
            PANEL_NAME_KEY => updates.push((PANEL_NAME_KEY, validate_panel_name(value)?)),
            LOGIN_MAX_ATTEMPTS_KEY => updates.push((
                LOGIN_MAX_ATTEMPTS_KEY,
                validate_int("登录失败次数上限", value, 1, 20)?.to_string(),
            )),
            LOGIN_LOCK_SECS_KEY => updates.push((
                LOGIN_LOCK_SECS_KEY,
                validate_int("锁定时长（秒）", value, 60, 86400)?.to_string(),
            )),
            SESSION_TTL_HOURS_KEY => updates.push((
                SESSION_TTL_HOURS_KEY,
                validate_int("会话有效期（小时）", value, 1, 720)?.to_string(),
            )),
            AGENT_UPGRADE_CONCURRENCY_KEY => updates.push((
                AGENT_UPGRADE_CONCURRENCY_KEY,
                validate_int(
                    "Agent 升级并发数",
                    value,
                    MIN_AGENT_UPGRADE_CONCURRENCY,
                    MAX_AGENT_UPGRADE_CONCURRENCY,
                )?
                .to_string(),
            )),
            other => {
                return Err(AppError::BadRequest(format!("未知的设置项：{other}")));
            }
        }
    }

    // 审计只记「改了哪些键」；值里可能有面板名等业务信息，一律不落 detail。
    let changed_keys: Vec<&str> = updates.iter().map(|(key, _)| *key).collect();
    for (key, value) in updates {
        repo::settings::set(&state.db.pool, key, &value).await?;
    }

    crate::audit::record(
        &state,
        &user.0,
        "settings.update",
        "settings",
        json!({ "keys": changed_keys }),
    )
    .await;

    let settings = load(&state.db.pool).await;
    Ok(Json(json!({ "items": settings.as_json() })))
}

fn validate_panel_name(value: &Value) -> AppResult<String> {
    let raw = value
        .as_str()
        .ok_or_else(|| AppError::BadRequest("面板名称必须是字符串".into()))?;
    let name = raw.trim();
    if !(1..=64).contains(&name.chars().count()) {
        return Err(AppError::BadRequest(
            "面板名称长度必须在 1-64 个字符之间".into(),
        ));
    }
    Ok(name.to_string())
}

fn validate_int(label: &str, value: &Value, min: i64, max: i64) -> AppResult<i64> {
    value
        .as_i64()
        .filter(|number| (min..=max).contains(number))
        .ok_or_else(|| AppError::BadRequest(format!("{label}需在 {min}-{max} 之间的整数")))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::Db;

    async fn setup() -> (Router, AppState, String, String) {
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
            },
        )
        .await
        .unwrap();
        let bob = repo::users::create(
            &db.pool,
            repo::users::NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (admin_token, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
            .await
            .unwrap();
        let (bob_token, _) = repo::sessions::create(&db.pool, &bob.id, 3600, None)
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={admin_token}", crate::auth::SESSION_COOKIE),
            format!("{}={bob_token}", crate::auth::SESSION_COOKIE),
        )
    }

    async fn request(
        app: &Router,
        cookie: Option<&str>,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
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
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, headers, value)
    }

    #[tokio::test]
    async fn defaults_are_returned_and_valid_patch_round_trips() {
        let (app, _state, admin, _bob) = setup().await;

        let (status, _, body) =
            request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"]["panel_name"], "PierWave");
        assert_eq!(body["items"]["login_max_attempts"], 5);
        assert_eq!(body["items"]["login_lock_secs"], 900);
        assert_eq!(body["items"]["session_ttl_hours"], 720);
        assert_eq!(
            body["items"]["agent_upgrade_concurrency"], 1,
            "批量升级并发默认必须是 1"
        );

        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({
                "panel_name": "  我的面板  ",
                "login_max_attempts": 3,
                "login_lock_secs": 120,
                "session_ttl_hours": 2,
                "agent_upgrade_concurrency": 3
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["panel_name"], "我的面板", "应该 trim");
        assert_eq!(body["items"]["login_max_attempts"], 3);
        assert_eq!(body["items"]["login_lock_secs"], 120);
        assert_eq!(body["items"]["session_ttl_hours"], 2);
        assert_eq!(body["items"]["agent_upgrade_concurrency"], 3);

        let (status, _, body) =
            request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"]["panel_name"], "我的面板");
        assert_eq!(body["items"]["login_max_attempts"], 3);
        assert_eq!(body["items"]["login_lock_secs"], 120);
        assert_eq!(body["items"]["session_ttl_hours"], 2);
        assert_eq!(body["items"]["agent_upgrade_concurrency"], 3);

        // 部分更新只动传了的键。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"panel_name": "又改了一次"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"]["panel_name"], "又改了一次");
        assert_eq!(body["items"]["login_max_attempts"], 3, "没传的键保持原值");
    }

    #[tokio::test]
    async fn unknown_and_out_of_range_settings_are_rejected() {
        let (app, _state, admin, _bob) = setup().await;

        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"unknown_key": 1})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("未知的设置项"));

        let long_name = "x".repeat(65);
        for bad in [
            json!({"panel_name": ""}),
            json!({"panel_name": "   "}),
            json!({"panel_name": long_name}),
            json!({"panel_name": 123}),
            json!({"login_max_attempts": 0}),
            json!({"login_max_attempts": 21}),
            json!({"login_max_attempts": "5"}),
            json!({"login_lock_secs": 59}),
            json!({"login_lock_secs": 86401}),
            json!({"session_ttl_hours": 0}),
            json!({"session_ttl_hours": 721}),
            json!({}),
        ] {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(bad.clone()),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "payload: {bad}");
            assert!(!body["error"].as_str().unwrap().is_empty());
        }

        // 全量校验：非法字段不应让同请求里的合法字段落库。
        let (status, _, _) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"panel_name": "临时名字", "login_max_attempts": 999})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(body["items"]["panel_name"], "PierWave", "不该半截写入");
    }

    /// 并发数只接受 1..=5：写入越界直接 400（不做静默夹紧），
    /// 这样调用方能立刻发现自己传错了值；读取侧仍会把库里被手工改坏的值回落成默认 1。
    #[tokio::test]
    async fn agent_upgrade_concurrency_is_validated_and_read_falls_back() {
        let (app, state, admin, _bob) = setup().await;

        for ok in [1, 5] {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(json!({"agent_upgrade_concurrency": ok})),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["items"]["agent_upgrade_concurrency"], ok);
        }

        for bad in [json!(0), json!(6), json!(-1), json!(99), json!("2")] {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(json!({"agent_upgrade_concurrency": bad.clone()})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "payload: {bad}");
            assert!(
                body["error"].as_str().unwrap().contains("Agent 升级并发数"),
                "错误信息要指出字段：{body}"
            );
        }

        // 直接写库绕过接口（模拟手工改坏）：读取回落到默认值 1，runner 仍能工作。
        repo::settings::set(&state.db.pool, "agent_upgrade_concurrency", "99")
            .await
            .unwrap();
        assert_eq!(load(&state.db.pool).await.agent_upgrade_concurrency, 1);
    }

    #[tokio::test]
    async fn settings_require_admin() {
        let (app, _state, _admin, bob) = setup().await;

        let (status, _, body) =
            request(&app, Some(&bob), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");

        let (status, _, body) = request(
            &app,
            Some(&bob),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"panel_name": "我也想改"})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");

        let (status, _, _) = request(&app, None, Method::GET, "/api/v1/settings", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn session_ttl_hours_drives_login_session_and_cookie() {
        let (app, state, admin, _bob) = setup().await;

        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"session_ttl_hours": 1})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"]["session_ttl_hours"], 1);

        let (status, headers, body) = request(
            &app,
            None,
            Method::POST,
            "/api/v1/auth/login",
            Some(json!({"username": "admin", "password": "devpass"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let cookie = headers
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            cookie.contains("Max-Age=3600"),
            "Cookie 有效期必须跟着 session_ttl_hours：{cookie}"
        );

        let admin_id = repo::users::find_by_username(&state.db.pool, "admin")
            .await
            .unwrap()
            .unwrap()
            .id;
        let sessions = repo::sessions::list_for_user(&state.db.pool, &admin_id)
            .await
            .unwrap();
        let latest = sessions.last().unwrap();
        assert_eq!(
            latest.expires_at - latest.created_at,
            3600,
            "服务端会话有效期必须是 1 小时"
        );
    }
}
