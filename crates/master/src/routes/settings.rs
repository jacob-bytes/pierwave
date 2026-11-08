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
/// 公开状态页总开关：默认开启；0 = 关闭（接口返回 404）。
pub const DEFAULT_PUBLIC_STATUS_ENABLED: i64 = 1;
/// 默认开启的三类告警；升级失败默认关闭（噪音较大，且升级本身有 UI 状态）。
pub const DEFAULT_ALERT_EVENTS: &str = "server_offline,user_exhausted,chain_degraded";
/// 同类告警默认冷却 600 秒；0 = 不去抖。
pub const DEFAULT_ALERT_COOLDOWN_SECS: i64 = 600;
pub const MIN_ALERT_COOLDOWN_SECS: i64 = 0;
pub const MAX_ALERT_COOLDOWN_SECS: i64 = 86_400;

pub const MAX_TELEGRAM_TOKEN_CHARS: usize = 256;
pub const MAX_TELEGRAM_CHAT_ID_CHARS: usize = 128;
/// 管理员 Bot 最多授权 10 个 chat id（群 + 个人合计）。
pub const MAX_TELEGRAM_ADMIN_CHAT_IDS: usize = 10;
/// 管理员 chat id 列表的存储上限（逗号分隔的原始串）。
pub const MAX_TELEGRAM_ADMIN_CHAT_IDS_CHARS: usize = 512;
pub const MAX_WEBHOOK_URL_CHARS: usize = 2048;
pub const MAX_ALERT_EVENTS_CHARS: usize = 256;

const PANEL_NAME_KEY: &str = "panel_name";
const LOGIN_MAX_ATTEMPTS_KEY: &str = "login_max_attempts";
const LOGIN_LOCK_SECS_KEY: &str = "login_lock_secs";
const SESSION_TTL_HOURS_KEY: &str = "session_ttl_hours";
const AGENT_UPGRADE_CONCURRENCY_KEY: &str = "agent_upgrade_concurrency";
const PUBLIC_STATUS_ENABLED_KEY: &str = "public_status_enabled";
pub const TELEGRAM_BOT_TOKEN_KEY: &str = "telegram_bot_token";
pub const TELEGRAM_CHAT_ID_KEY: &str = "telegram_chat_id";
pub const TELEGRAM_ADMIN_CHAT_IDS_KEY: &str = "telegram_admin_chat_ids";
pub const TELEGRAM_BOT_ENABLED_KEY: &str = "telegram_bot_enabled";
pub const WEBHOOK_URL_KEY: &str = "webhook_url";
pub const ALERT_EVENTS_KEY: &str = "alert_events";
pub const ALERT_COOLDOWN_SECS_KEY: &str = "alert_cooldown_secs";

/// 设置页的白名单键；新增键必须同时改这里和 `docs/PLAN.md`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub panel_name: String,
    pub login_max_attempts: i64,
    pub login_lock_secs: i64,
    pub session_ttl_hours: i64,
    pub agent_upgrade_concurrency: i64,
    /// 0 = 关闭公开状态页；1 = 开启。
    pub public_status_enabled: i64,
    /// 空 = 不启用 Telegram。
    pub telegram_bot_token: String,
    /// 空 = 不启用 Telegram；与 token 必须同时配置。
    pub telegram_chat_id: String,
    /// 管理员 Bot 允许的 chat id，逗号分隔（1..=10 个）；空 = 不授权任何人。
    ///
    /// 只对这里列出的 chat 生效：其它 chat 发来的命令一律回「未授权」，
    /// 不读取任何业务数据。存储的是规范化后的串（trim、去重、逗号连接）。
    pub telegram_admin_chat_ids: String,
    /// 管理员 Bot 长轮询总开关；默认关闭。
    ///
    /// 必须同时满足 `enabled = true`、token 非空、管理员列表非空才会真正拉起
    /// 长轮询任务；三个条件缺一个都按「未启用」处理。
    pub telegram_bot_enabled: bool,
    /// 空 = 不启用 Webhook。
    pub webhook_url: String,
    /// 逗号分隔的事件名；规范化后存储（去重、固定顺序）。
    pub alert_events: String,
    /// 同类告警冷却秒数；0 = 不去抖。
    pub alert_cooldown_secs: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            panel_name: DEFAULT_PANEL_NAME.to_string(),
            login_max_attempts: DEFAULT_LOGIN_MAX_ATTEMPTS,
            login_lock_secs: DEFAULT_LOGIN_LOCK_SECS,
            session_ttl_hours: DEFAULT_SESSION_TTL_HOURS,
            agent_upgrade_concurrency: DEFAULT_AGENT_UPGRADE_CONCURRENCY,
            public_status_enabled: DEFAULT_PUBLIC_STATUS_ENABLED,
            telegram_bot_token: String::new(),
            telegram_chat_id: String::new(),
            telegram_admin_chat_ids: String::new(),
            telegram_bot_enabled: false,
            webhook_url: String::new(),
            alert_events: DEFAULT_ALERT_EVENTS.to_string(),
            alert_cooldown_secs: DEFAULT_ALERT_COOLDOWN_SECS,
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
            "public_status_enabled": self.public_status_enabled,
            "telegram_bot_token": self.telegram_bot_token,
            "telegram_chat_id": self.telegram_chat_id,
            "telegram_admin_chat_ids": self.telegram_admin_chat_ids,
            "telegram_bot_enabled": self.telegram_bot_enabled,
            "webhook_url": self.webhook_url,
            "alert_events": self.alert_events,
            "alert_cooldown_secs": self.alert_cooldown_secs,
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
        public_status_enabled: read_int(
            pool,
            PUBLIC_STATUS_ENABLED_KEY,
            0,
            1,
            defaults.public_status_enabled,
        )
        .await,
        telegram_bot_token: read_text(pool, TELEGRAM_BOT_TOKEN_KEY, "", normalize_telegram_token)
            .await,
        telegram_chat_id: read_text(pool, TELEGRAM_CHAT_ID_KEY, "", normalize_telegram_chat_id)
            .await,
        telegram_admin_chat_ids: read_text(
            pool,
            TELEGRAM_ADMIN_CHAT_IDS_KEY,
            "",
            normalize_telegram_admin_chat_ids,
        )
        .await,
        telegram_bot_enabled: read_bool(pool, TELEGRAM_BOT_ENABLED_KEY, false).await,
        webhook_url: read_text(pool, WEBHOOK_URL_KEY, "", normalize_webhook_url).await,
        alert_events: read_text(
            pool,
            ALERT_EVENTS_KEY,
            DEFAULT_ALERT_EVENTS,
            normalize_alert_events,
        )
        .await,
        alert_cooldown_secs: read_int(
            pool,
            ALERT_COOLDOWN_SECS_KEY,
            MIN_ALERT_COOLDOWN_SECS,
            MAX_ALERT_COOLDOWN_SECS,
            defaults.alert_cooldown_secs,
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

/// 读取文本设置：缺失用默认值；库里的值不合法时也回落默认值并告警。
async fn read_text(
    pool: &SqlitePool,
    key: &str,
    default: &str,
    normalize: fn(&str) -> Result<String, String>,
) -> String {
    match repo::settings::get(pool, key).await {
        Ok(Some(raw)) => normalize(&raw).unwrap_or_else(|error| {
            tracing::warn!(key, %error, "settings 值非法，使用默认值");
            default.to_string()
        }),
        Ok(None) => default.to_string(),
        Err(error) => {
            tracing::warn!(key, error = %error, "读取设置失败，使用默认值");
            default.to_string()
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

/// 读取布尔设置；接受写库用的 `1` / `0` 与更易读的 `true` / `false`。
/// 其它值（含空串）回落到默认值并告警，避免手工改库让主控启动失败。
async fn read_bool(pool: &SqlitePool, key: &str, default: bool) -> bool {
    match repo::settings::get(pool, key).await {
        Ok(Some(raw)) => match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" => true,
            "0" | "false" => false,
            _ => {
                tracing::warn!(key, "settings 布尔值非法，使用默认值 {default}");
                default
            }
        },
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

    let object = body.as_object().ok_or_else(|| {
        AppError::coded("settings.body_not_object", None, "请求体必须是 JSON 对象")
    })?;
    if object.is_empty() {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供一个可更新字段",
        ));
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
            PUBLIC_STATUS_ENABLED_KEY => updates.push((
                PUBLIC_STATUS_ENABLED_KEY,
                validate_int("公开状态页开关（0 关闭 / 1 开启）", value, 0, 1)?.to_string(),
            )),
            TELEGRAM_BOT_TOKEN_KEY => updates.push((
                TELEGRAM_BOT_TOKEN_KEY,
                validate_text(
                    "Telegram Bot Token",
                    value,
                    "settings.telegram_bot_token_invalid",
                    normalize_telegram_token,
                )?,
            )),
            TELEGRAM_CHAT_ID_KEY => updates.push((
                TELEGRAM_CHAT_ID_KEY,
                validate_text(
                    "Telegram Chat ID",
                    value,
                    "settings.telegram_chat_id_invalid",
                    normalize_telegram_chat_id,
                )?,
            )),
            TELEGRAM_ADMIN_CHAT_IDS_KEY => updates.push((
                TELEGRAM_ADMIN_CHAT_IDS_KEY,
                validate_text(
                    "Telegram 管理员 Chat ID 列表",
                    value,
                    "settings.telegram_admin_chat_ids_invalid",
                    normalize_telegram_admin_chat_ids,
                )?,
            )),
            TELEGRAM_BOT_ENABLED_KEY => updates.push((
                TELEGRAM_BOT_ENABLED_KEY,
                if validate_bool("Telegram Bot 开关", value)? {
                    "1".to_string()
                } else {
                    "0".to_string()
                },
            )),
            WEBHOOK_URL_KEY => updates.push((
                WEBHOOK_URL_KEY,
                validate_text(
                    "Webhook URL",
                    value,
                    "settings.webhook_url_invalid",
                    normalize_webhook_url,
                )?,
            )),
            ALERT_EVENTS_KEY => updates.push((
                ALERT_EVENTS_KEY,
                validate_text(
                    "告警事件列表",
                    value,
                    "settings.alert_events_invalid",
                    normalize_alert_events,
                )?,
            )),
            ALERT_COOLDOWN_SECS_KEY => updates.push((
                ALERT_COOLDOWN_SECS_KEY,
                validate_int(
                    "告警冷却时间（秒）",
                    value,
                    MIN_ALERT_COOLDOWN_SECS,
                    MAX_ALERT_COOLDOWN_SECS,
                )?
                .to_string(),
            )),
            other => {
                return Err(AppError::coded(
                    "settings.unknown_key",
                    Some(json!({ "key": other })),
                    format!("未知的设置项：{other}"),
                ));
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
    let raw = value.as_str().ok_or_else(|| {
        AppError::coded("settings.panel_name_invalid", None, "面板名称必须是字符串")
    })?;
    let name = raw.trim();
    if !(1..=64).contains(&name.chars().count()) {
        return Err(AppError::coded(
            "settings.panel_name_length_invalid",
            Some(json!({ "min": 1, "max": 64 })),
            "面板名称长度必须在 1-64 个字符之间",
        ));
    }
    Ok(name.to_string())
}

fn validate_text(
    label: &str,
    value: &Value,
    code: &'static str,
    normalize: fn(&str) -> Result<String, String>,
) -> AppResult<String> {
    let raw = value
        .as_str()
        .ok_or_else(|| AppError::coded(code, None, format!("{label}必须是字符串")))?;
    normalize(raw).map_err(|message| AppError::coded(code, None, message))
}

/// 空值 = 不启用；非空 token 只约束长度与空白，避免把合法字符集写死。
fn normalize_telegram_token(raw: &str) -> Result<String, String> {
    let token = raw.trim();
    if token.chars().count() > MAX_TELEGRAM_TOKEN_CHARS {
        return Err(format!(
            "Telegram Bot Token 最多 {MAX_TELEGRAM_TOKEN_CHARS} 个字符"
        ));
    }
    if token
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("Telegram Bot Token 不能包含空白或控制字符".to_string());
    }
    Ok(token.to_string())
}

fn normalize_telegram_chat_id(raw: &str) -> Result<String, String> {
    let chat_id = raw.trim();
    if chat_id.chars().count() > MAX_TELEGRAM_CHAT_ID_CHARS {
        return Err(format!(
            "Telegram Chat ID 最多 {MAX_TELEGRAM_CHAT_ID_CHARS} 个字符"
        ));
    }
    if chat_id
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("Telegram Chat ID 不能包含空白或控制字符".to_string());
    }
    Ok(chat_id.to_string())
}

/// 解析管理员 chat id 列表：逗号分隔、trim、去重、保持输入顺序。
///
/// 空串是合法值（= 不授权任何人，Bot 不会启动）；非空时最多
/// [`MAX_TELEGRAM_ADMIN_CHAT_IDS`] 个。单个 id 的字符约束与
/// `telegram_chat_id` 完全一致，避免出现两套口径。
pub fn parse_telegram_admin_chat_ids(raw: &str) -> Result<Vec<String>, String> {
    if raw.chars().count() > MAX_TELEGRAM_ADMIN_CHAT_IDS_CHARS {
        return Err(format!(
            "Telegram 管理员 Chat ID 列表最多 {MAX_TELEGRAM_ADMIN_CHAT_IDS_CHARS} 个字符"
        ));
    }
    let mut ids: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let id = part.trim();
        if id.is_empty() {
            continue;
        }
        if id.chars().count() > MAX_TELEGRAM_CHAT_ID_CHARS {
            return Err(format!(
                "Telegram Chat ID 最多 {MAX_TELEGRAM_CHAT_ID_CHARS} 个字符"
            ));
        }
        if id
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err("Telegram Chat ID 不能包含空白或控制字符".to_string());
        }
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_string());
        }
    }
    if ids.len() > MAX_TELEGRAM_ADMIN_CHAT_IDS {
        return Err(format!(
            "Telegram 管理员 Chat ID 最多 {MAX_TELEGRAM_ADMIN_CHAT_IDS} 个"
        ));
    }
    Ok(ids)
}

fn normalize_telegram_admin_chat_ids(raw: &str) -> Result<String, String> {
    Ok(parse_telegram_admin_chat_ids(raw)?.join(","))
}

fn normalize_webhook_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Ok(String::new());
    }
    if url.chars().count() > MAX_WEBHOOK_URL_CHARS {
        return Err(format!("Webhook URL 最多 {MAX_WEBHOOK_URL_CHARS} 个字符"));
    }
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"));
    let Some(rest) = rest else {
        return Err("Webhook URL 必须以 http:// 或 https:// 开头".to_string());
    };
    if url
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("Webhook URL 不能包含空白或控制字符".to_string());
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return Err("Webhook URL 缺少主机名".to_string());
    }
    Ok(url.to_string())
}

fn normalize_alert_events(raw: &str) -> Result<String, String> {
    if raw.chars().count() > MAX_ALERT_EVENTS_CHARS {
        return Err(format!("告警事件列表最多 {MAX_ALERT_EVENTS_CHARS} 个字符"));
    }
    let events = crate::alerts::parse_alert_events(raw)?;
    Ok(crate::alerts::format_alert_events(&events))
}

fn validate_int(label: &str, value: &Value, min: i64, max: i64) -> AppResult<i64> {
    value
        .as_i64()
        .filter(|number| (min..=max).contains(number))
        .ok_or_else(|| {
            AppError::coded(
                "settings.int_out_of_range",
                Some(json!({ "label": label, "min": min, "max": max })),
                format!("{label}需在 {min}-{max} 之间的整数"),
            )
        })
}

/// 新设置项用 JSON 布尔值；写库统一成 `1` / `0`，方便沿用 key/value TEXT 表。
fn validate_bool(label: &str, value: &Value) -> AppResult<bool> {
    value.as_bool().ok_or_else(|| {
        AppError::coded(
            "settings.bool_invalid",
            Some(json!({ "label": label })),
            format!("{label}必须是布尔值 true / false"),
        )
    })
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

    #[tokio::test]
    async fn alert_settings_default_and_round_trip() {
        let (app, _state, admin, _bob) = setup().await;

        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(body["items"]["telegram_bot_token"], "");
        assert_eq!(body["items"]["telegram_chat_id"], "");
        assert_eq!(body["items"]["webhook_url"], "");
        assert_eq!(
            body["items"]["alert_events"], "server_offline,user_exhausted,chain_degraded",
            "升级失败默认不开启"
        );
        assert_eq!(body["items"]["alert_cooldown_secs"], 600);

        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({
                "telegram_bot_token": "  123456:ABC-def_ghi  ",
                "telegram_chat_id": "  -1001234567890  ",
                "webhook_url": "  https://example.test/hooks/pierwave  ",
                "alert_events": " upgrade_failed, server_offline, server_offline ",
                "alert_cooldown_secs": 0,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["telegram_bot_token"], "123456:ABC-def_ghi");
        assert_eq!(body["items"]["telegram_chat_id"], "-1001234567890");
        assert_eq!(
            body["items"]["webhook_url"],
            "https://example.test/hooks/pierwave"
        );
        assert_eq!(
            body["items"]["alert_events"], "server_offline,upgrade_failed",
            "事件列表要 trim、去重并固定顺序"
        );
        assert_eq!(body["items"]["alert_cooldown_secs"], 0);

        // 上限 86400 合法；空事件列表表示全部关闭，空渠道表示不启用。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({
                "telegram_bot_token": "",
                "telegram_chat_id": "",
                "webhook_url": "",
                "alert_events": "",
                "alert_cooldown_secs": 86400,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["alert_events"], "");
        assert_eq!(body["items"]["alert_cooldown_secs"], 86400);
        assert_eq!(body["items"]["webhook_url"], "");
    }

    #[tokio::test]
    async fn invalid_alert_settings_are_rejected() {
        let (app, _state, admin, _bob) = setup().await;

        let cases = [
            json!({"telegram_bot_token": "a b"}),
            json!({"telegram_bot_token": "x".repeat(MAX_TELEGRAM_TOKEN_CHARS + 1)}),
            json!({"telegram_bot_token": 123}),
            json!({"telegram_chat_id": "a b"}),
            json!({"telegram_chat_id": "x".repeat(MAX_TELEGRAM_CHAT_ID_CHARS + 1)}),
            json!({"webhook_url": "ftp://example.test/hook"}),
            json!({"webhook_url": "example.test/hook"}),
            json!({"webhook_url": "http://"}),
            json!({"webhook_url": "https://exa mple.test/hook"}),
            json!({"webhook_url": "x".repeat(MAX_WEBHOOK_URL_CHARS + 1)}),
            json!({"alert_events": "server_offline,nope"}),
            json!({"alert_events": "x".repeat(MAX_ALERT_EVENTS_CHARS + 1)}),
            json!({"alert_cooldown_secs": -1}),
            json!({"alert_cooldown_secs": 86401}),
            json!({"alert_cooldown_secs": "600"}),
        ];
        for bad in cases {
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
    }

    #[tokio::test]
    async fn corrupt_alert_settings_fall_back_to_defaults_on_read() {
        let (app, state, admin, _bob) = setup().await;

        for (key, value) in [
            ("telegram_bot_token", "bad token"),
            ("telegram_chat_id", "bad chat id"),
            ("webhook_url", "ftp://example.test/hook"),
            ("alert_events", "server_offline,wat"),
            ("alert_cooldown_secs", "999999"),
        ] {
            repo::settings::set(&state.db.pool, key, value)
                .await
                .unwrap();
        }

        let settings = load(&state.db.pool).await;
        assert_eq!(settings.telegram_bot_token, "");
        assert_eq!(settings.telegram_chat_id, "");
        assert_eq!(settings.webhook_url, "");
        assert_eq!(settings.alert_events, DEFAULT_ALERT_EVENTS);
        assert_eq!(settings.alert_cooldown_secs, DEFAULT_ALERT_COOLDOWN_SECS);

        // 空事件列表是合法值，不能被回落成默认（否则「全部关闭」失效）。
        repo::settings::set(&state.db.pool, "alert_events", "")
            .await
            .unwrap();
        assert_eq!(load(&state.db.pool).await.alert_events, "");

        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(body["items"]["alert_events"], "");
    }

    #[tokio::test]
    async fn public_status_enabled_accepts_only_zero_or_one() {
        let (app, state, admin, _bob) = setup().await;

        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(
            body["items"]["public_status_enabled"], 1,
            "公开状态页默认开启"
        );

        for ok in [0, 1] {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(json!({"public_status_enabled": ok})),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["items"]["public_status_enabled"], ok);
        }

        for bad in [json!(2), json!(-1), json!("1"), json!(true)] {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(json!({"public_status_enabled": bad.clone()})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "payload: {bad}");
            assert!(
                body["error"].as_str().unwrap().contains("公开状态页"),
                "错误信息要指出字段：{body}"
            );
        }

        // 直接写库绕过接口（模拟手工改坏）：读取回落到默认值 1。
        repo::settings::set(&state.db.pool, "public_status_enabled", "9")
            .await
            .unwrap();
        assert_eq!(load(&state.db.pool).await.public_status_enabled, 1);
    }

    #[tokio::test]
    async fn admin_bot_settings_default_off_and_round_trip() {
        let (app, _state, admin, _bob) = setup().await;

        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(body["items"]["telegram_admin_chat_ids"], "");
        assert_eq!(body["items"]["telegram_bot_enabled"], false, "Bot 默认关闭");

        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({
                "telegram_admin_chat_ids": " 42, -100123,42, ",
                "telegram_bot_enabled": true,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["items"]["telegram_admin_chat_ids"], "42,-100123",
            "管理员列表要 trim、去重"
        );
        assert_eq!(body["items"]["telegram_bot_enabled"], true);

        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"telegram_bot_enabled": false, "telegram_admin_chat_ids": ""})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["telegram_bot_enabled"], false);
        assert_eq!(body["items"]["telegram_admin_chat_ids"], "");
    }

    #[tokio::test]
    async fn invalid_admin_bot_settings_are_rejected_and_read_falls_back() {
        let (app, state, admin, _bob) = setup().await;

        let too_many = (0..MAX_TELEGRAM_ADMIN_CHAT_IDS + 1)
            .map(|index| index.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let cases = [
            json!({"telegram_admin_chat_ids": too_many.clone()}),
            json!({"telegram_admin_chat_ids": "1 2,3"}),
            json!({"telegram_admin_chat_ids": "x".repeat(MAX_TELEGRAM_CHAT_ID_CHARS + 1)}),
            json!({"telegram_admin_chat_ids": 42}),
            json!({"telegram_bot_enabled": 1}),
            json!({"telegram_bot_enabled": "true"}),
        ];
        for bad in cases {
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

        // 手工改坏：读取回落默认值，主控仍能启动。
        repo::settings::set(&state.db.pool, "telegram_bot_enabled", "maybe")
            .await
            .unwrap();
        repo::settings::set(&state.db.pool, "telegram_admin_chat_ids", &too_many)
            .await
            .unwrap();
        let settings = load(&state.db.pool).await;
        assert!(!settings.telegram_bot_enabled);
        assert_eq!(settings.telegram_admin_chat_ids, "");
        assert!(parse_telegram_admin_chat_ids(" 1,2,1 ").unwrap() == vec!["1", "2"]);
    }
}
