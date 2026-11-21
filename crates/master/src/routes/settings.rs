//! 面板设置：白名单键 + 范围校验，全部落 `settings` 表的 key/value。
//!
//! 读取侧统一走 [`load`]：缺省、类型错误、越界、数据库读取失败都回落到默认值，
//! 保证设置表被手工改坏时登录等核心链路仍然可用。

use std::fmt;

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};
use sqlx::SqlitePool;

use pierwave_domain::remote_backup;
use pierwave_domain::repo;
use pierwave_domain::secret_box::{self, SecretKey};
use pierwave_domain::Db;

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
/// 公开状态页是否显示费用与到期：默认公开（兼容旧行为）。
///
/// 0 = 四个费用字段一律返回 `null`，并用 `billing_hidden: true` 标明
/// 「不是没配置，而是不公开」；1 = 正常返回（没配置时仍是 `null`）。
pub const DEFAULT_PUBLIC_BILLING_VISIBLE: i64 = 1;
/// 默认开启的七类告警；升级失败默认关闭（噪音较大，且升级本身有 UI 状态）。
/// `update_available` 默认开启，与旧的 `update_check_notify` 默认值一致；
/// `backup_failed`（异地备份连续 3 次失败）默认开启——备份是数据安全底线。
/// `login_failed` / `login_new_ip` 也默认开启：前者是撞库的第一信号，后者
/// 是账号被盗用的第一信号；管理员可以在设置页单独关掉。
pub const DEFAULT_ALERT_EVENTS: &str = "server_offline,user_exhausted,chain_degraded,backup_failed,update_available,login_failed,login_new_ip";
/// 同类告警默认冷却 600 秒；0 = 不去抖。
pub const DEFAULT_ALERT_COOLDOWN_SECS: i64 = 600;
pub const MIN_ALERT_COOLDOWN_SECS: i64 = 0;
pub const MAX_ALERT_COOLDOWN_SECS: i64 = 86_400;
/// 版本更新检测：默认启用、每 6 小时一次；通知开关已迁到 `alert_events`
/// 的 `update_available` 事件（见迁移 0050），这里是新装实例的初值。
pub const DEFAULT_UPDATE_CHECK_ENABLED: bool = true;
/// 间隔范围与调度器共用同一份常量，避免「设置允许 1–168、调度器夹到别的值」。
pub const DEFAULT_UPDATE_CHECK_INTERVAL_HOURS: i64 = crate::updates::DEFAULT_INTERVAL_HOURS;
pub const MIN_UPDATE_CHECK_INTERVAL_HOURS: i64 = crate::updates::MIN_INTERVAL_HOURS;
pub const MAX_UPDATE_CHECK_INTERVAL_HOURS: i64 = crate::updates::MAX_INTERVAL_HOURS;
/// **兼容保留**：只给旧前端读写；通知路径已改用 `update_available` 事件。
pub const DEFAULT_UPDATE_CHECK_NOTIFY: bool = true;

/// 异地备份（WebDAV）：默认关闭；间隔与保留份数复用领域层常量，
/// 保证「设置允许的范围」与「保留策略使用的范围」永远一致。
pub const DEFAULT_BACKUP_WEBDAV_ENABLED: bool = false;
pub const DEFAULT_BACKUP_WEBDAV_INTERVAL_HOURS: i64 = remote_backup::DEFAULT_INTERVAL_HOURS;
pub const MIN_BACKUP_WEBDAV_INTERVAL_HOURS: i64 = remote_backup::MIN_INTERVAL_HOURS;
pub const MAX_BACKUP_WEBDAV_INTERVAL_HOURS: i64 = remote_backup::MAX_INTERVAL_HOURS;
pub const DEFAULT_BACKUP_WEBDAV_KEEP: i64 = remote_backup::DEFAULT_KEEP;
pub const MIN_BACKUP_WEBDAV_KEEP: i64 = remote_backup::MIN_KEEP;
pub const MAX_BACKUP_WEBDAV_KEEP: i64 = remote_backup::MAX_KEEP;
/// 用户名与密码的长度上限来自领域层，保留策略/客户端共用同一份约束。
pub const MAX_BACKUP_WEBDAV_USERNAME_CHARS: usize = remote_backup::MAX_USERNAME_CHARS;
pub const MAX_BACKUP_WEBDAV_PASSWORD_CHARS: usize = remote_backup::MAX_PASSWORD_CHARS;

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
const PUBLIC_BILLING_VISIBLE_KEY: &str = "public_billing_visible";
const AGENT_BASE_URL_KEY: &str = "agent_base_url";
const SUBSCRIPTION_BASE_URL_KEY: &str = "subscription_base_url";
pub const TELEGRAM_BOT_TOKEN_KEY: &str = "telegram_bot_token";
pub const TELEGRAM_CHAT_ID_KEY: &str = "telegram_chat_id";
pub const TELEGRAM_ADMIN_CHAT_IDS_KEY: &str = "telegram_admin_chat_ids";
pub const TELEGRAM_BOT_ENABLED_KEY: &str = "telegram_bot_enabled";
pub const WEBHOOK_URL_KEY: &str = "webhook_url";
pub const ALERT_EVENTS_KEY: &str = "alert_events";
pub const ALERT_COOLDOWN_SECS_KEY: &str = "alert_cooldown_secs";
pub const UPDATE_CHECK_ENABLED_KEY: &str = "update_check_enabled";
pub const UPDATE_CHECK_INTERVAL_HOURS_KEY: &str = "update_check_interval_hours";
pub const UPDATE_CHECK_NOTIFY_KEY: &str = "update_check_notify";
pub const BACKUP_WEBDAV_ENABLED_KEY: &str = "backup_webdav_enabled";
pub const BACKUP_WEBDAV_URL_KEY: &str = "backup_webdav_url";
pub const BACKUP_WEBDAV_USERNAME_KEY: &str = "backup_webdav_username";
pub const BACKUP_WEBDAV_PASSWORD_KEY: &str = "backup_webdav_password";
pub const BACKUP_WEBDAV_INTERVAL_HOURS_KEY: &str = "backup_webdav_interval_hours";
pub const BACKUP_WEBDAV_KEEP_KEY: &str = "backup_webdav_keep";
/// 备份是否加密（默认 true）；关闭后导出/上传明文 `.db.gz`。
pub const BACKUP_ENCRYPT_KEY: &str = "backup_encrypt";
pub const DEFAULT_BACKUP_ENCRYPT: bool = true;

/// 设置页的白名单键；新增键必须同时改这里和 `docs/PLAN.md`。
#[derive(Clone, PartialEq, Eq)]
pub struct Settings {
    pub panel_name: String,
    pub login_max_attempts: i64,
    pub login_lock_secs: i64,
    pub session_ttl_hours: i64,
    pub agent_upgrade_concurrency: i64,
    /// 0 = 关闭公开状态页；1 = 开启。
    pub public_status_enabled: i64,
    /// 0 = 公开页隐藏费用与到期；1 = 公开（默认）。
    pub public_billing_visible: i64,
    /// Agent 纳管地址（安装命令、升级包 URL）；空 = 按请求头推导。
    pub agent_base_url: String,
    /// 订阅地址（订阅链接、二维码）；空 = 回退到 `agent_base_url`，再为空才看请求头。
    pub subscription_base_url: String,
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
    /// 版本更新检测总开关；关闭后调度器不再请求 GitHub。
    pub update_check_enabled: bool,
    /// 检测间隔（小时），1–168；默认 6。
    pub update_check_interval_hours: i64,
    /// **兼容保留**：发现新版本是否通知，已迁到 `alert_events` 的
    /// `update_available` 事件（唯一事实来源）。这里仍读写该键，避免旧前端
    /// 报 `settings.unknown_key`；通知路径不再读它，迁移 0050 只读一次。
    pub update_check_notify: bool,
    /// 异地备份（WebDAV）总开关；开启后调度器按间隔上传。
    pub backup_webdav_enabled: bool,
    /// WebDAV 目录地址；空 = 未配置。
    pub backup_webdav_url: String,
    /// WebDAV 用户名；空 = 匿名（多数服务器会拒绝）。
    pub backup_webdav_username: String,
    /// WebDAV 密码。**只在本进程内使用，绝不出现在 `as_json()` / 日志里。**
    pub backup_webdav_password: String,
    /// 上传间隔（小时），1–168，默认 24。
    pub backup_webdav_interval_hours: i64,
    /// 远端保留份数，1–30，默认 7。
    pub backup_webdav_keep: i64,
    /// 备份产物是否加密；默认 true。关闭后导出与异地备份都是明文 `.db.gz`。
    pub backup_encrypt: bool,
    /// 只在本进程内使用：秘密设置解密失败时的可读原因（不含密钥/密文）。
    /// 不下发给前端（`as_json` 不包含）；GET /settings 把它转成 `secret_errors`
    /// 标记，后台任务则转成 [`SecretError`]。
    pub secret_error: Option<String>,
    /// 只在本进程内使用：本次读取中解不开的秘密键名（不含值）。
    ///
    /// 设置页的逃生路径用它判断「哪些秘密可以重填」；同样不进 `as_json`。
    pub secret_broken_keys: Vec<&'static str>,
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
            public_billing_visible: DEFAULT_PUBLIC_BILLING_VISIBLE,
            agent_base_url: String::new(),
            subscription_base_url: String::new(),
            telegram_bot_token: String::new(),
            telegram_chat_id: String::new(),
            telegram_admin_chat_ids: String::new(),
            telegram_bot_enabled: false,
            webhook_url: String::new(),
            alert_events: DEFAULT_ALERT_EVENTS.to_string(),
            alert_cooldown_secs: DEFAULT_ALERT_COOLDOWN_SECS,
            update_check_enabled: DEFAULT_UPDATE_CHECK_ENABLED,
            update_check_interval_hours: DEFAULT_UPDATE_CHECK_INTERVAL_HOURS,
            update_check_notify: DEFAULT_UPDATE_CHECK_NOTIFY,
            backup_webdav_enabled: DEFAULT_BACKUP_WEBDAV_ENABLED,
            backup_webdav_url: String::new(),
            backup_webdav_username: String::new(),
            backup_webdav_password: String::new(),
            backup_webdav_interval_hours: DEFAULT_BACKUP_WEBDAV_INTERVAL_HOURS,
            backup_webdav_keep: DEFAULT_BACKUP_WEBDAV_KEEP,
            backup_encrypt: DEFAULT_BACKUP_ENCRYPT,
            secret_error: None,
            secret_broken_keys: Vec::new(),
        }
    }
}

/// 手写 `Debug`：凭据/授权字段永远不进入日志、panic 信息或测试快照。
impl fmt::Debug for Settings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        const REDACTED: &str = "<redacted>";
        formatter
            .debug_struct("Settings")
            .field("panel_name", &self.panel_name)
            .field("login_max_attempts", &self.login_max_attempts)
            .field("login_lock_secs", &self.login_lock_secs)
            .field("session_ttl_hours", &self.session_ttl_hours)
            .field("agent_upgrade_concurrency", &self.agent_upgrade_concurrency)
            .field("public_status_enabled", &self.public_status_enabled)
            .field("public_billing_visible", &self.public_billing_visible)
            .field("agent_base_url", &self.agent_base_url)
            .field("subscription_base_url", &self.subscription_base_url)
            // 四个秘密/授权字段：Token、WebDAV 密码、Webhook 地址（常带 token）、
            // 管理员 chat id 列表（授权名单）。
            .field("telegram_bot_token", &REDACTED)
            .field("telegram_chat_id", &self.telegram_chat_id)
            .field("telegram_admin_chat_ids", &REDACTED)
            .field("telegram_bot_enabled", &self.telegram_bot_enabled)
            .field("webhook_url", &REDACTED)
            .field("alert_events", &self.alert_events)
            .field("alert_cooldown_secs", &self.alert_cooldown_secs)
            .field("update_check_enabled", &self.update_check_enabled)
            .field(
                "update_check_interval_hours",
                &self.update_check_interval_hours,
            )
            .field("update_check_notify", &self.update_check_notify)
            .field("backup_webdav_enabled", &self.backup_webdav_enabled)
            .field("backup_webdav_url", &self.backup_webdav_url)
            .field("backup_webdav_username", &self.backup_webdav_username)
            .field("backup_webdav_password", &REDACTED)
            .field(
                "backup_webdav_interval_hours",
                &self.backup_webdav_interval_hours,
            )
            .field("backup_webdav_keep", &self.backup_webdav_keep)
            .field("backup_encrypt", &self.backup_encrypt)
            .field("secret_error", &self.secret_error)
            .field("secret_broken_keys", &self.secret_broken_keys)
            .finish()
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
            "public_billing_visible": self.public_billing_visible,
            "agent_base_url": self.agent_base_url,
            "subscription_base_url": self.subscription_base_url,
            // Token 与 WebDAV 密码同一语义：永远不回显，只告诉前端「已保存」。
            "telegram_bot_token": "",
            "telegram_bot_has_token": !self.telegram_bot_token.is_empty(),
            "telegram_chat_id": self.telegram_chat_id,
            "telegram_admin_chat_ids": self.telegram_admin_chat_ids,
            "telegram_bot_enabled": self.telegram_bot_enabled,
            "webhook_url": self.webhook_url,
            "alert_events": self.alert_events,
            "alert_cooldown_secs": self.alert_cooldown_secs,
            "update_check_enabled": self.update_check_enabled,
            "update_check_interval_hours": self.update_check_interval_hours,
            "update_check_notify": self.update_check_notify,
            "backup_webdav_enabled": self.backup_webdav_enabled,
            "backup_webdav_url": self.backup_webdav_url,
            "backup_webdav_username": self.backup_webdav_username,
            // 密码永远不回显：只告诉前端「已保存」，留空保存表示保持不变。
            "backup_webdav_password": "",
            "backup_webdav_has_password": !self.backup_webdav_password.is_empty(),
            "backup_webdav_interval_hours": self.backup_webdav_interval_hours,
            "backup_webdav_keep": self.backup_webdav_keep,
            // 关闭加密时前端需要明确提示：产物是明文，泄漏即可读全部业务数据。
            "backup_encrypt": self.backup_encrypt,
        })
    }
}

/// 读取当前生效设置；任何单个键异常都只影响它自己。
///
/// 秘密设置（`telegram_bot_token` 等）在库里是 `enc:v1:` 密文，这里透明解密；
/// 解密失败不会静默成空串，而是记录到 `secret_error` / `secret_broken_keys`，
/// 由 [`get`] 在 200 响应里标记，后台任务则用 [`load_for_background`] 拿到
/// [`SecretError`]。GET 不能因此整体 400：设置页要能看到并重填坏掉的键。
pub async fn load(db: &Db) -> Settings {
    load_inner(&db.pool, db.secret_key()).await
}

/// 后台路径的秘密解密错误：带可读文案与**键名**（不含值）。
///
/// 定时备份、告警、Telegram Bot、手动异地备份都统一用它，避免每条路径
/// 各自把「解不开」当成「未配置」或静默跳过。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretError {
    pub message: String,
    pub keys: Vec<&'static str>,
}

impl fmt::Display for SecretError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SecretError {}

/// 后台任务读取设置：任一秘密解不开就返回 [`SecretError`]。
///
/// 与 [`load`] 的区别只在契约：调用方不能把「解不开」当成默认值继续跑
/// （那会把 WebDAV 静默停掉、把告警静默丢弃）。需要部分设置做优雅降级时，
/// 调用方可以同时用 [`load`] 读取仍可用的字段，但必须记录这里的错误。
pub async fn load_for_background(db: &Db) -> Result<Settings, SecretError> {
    let settings = load_inner(&db.pool, db.secret_key()).await;
    match settings.secret_error.clone() {
        Some(message) => Err(SecretError {
            message,
            keys: settings.secret_broken_keys,
        }),
        None => Ok(settings),
    }
}

/// 解密失败的统一文案：只说明「主密钥不匹配或密文损坏」，不包含任何值。
fn secret_decrypt_error() -> String {
    "已保存的秘密设置无法用当前主密钥解密：请恢复写入时使用的 data/secret.key 或 \
     PIERWAVE_SECRET_KEY / Stored secrets cannot be decrypted with the current master \
     key; restore the original data/secret.key or PIERWAVE_SECRET_KEY"
        .to_string()
}

async fn load_inner(pool: &SqlitePool, master: &SecretKey) -> Settings {
    let defaults = Settings::default();
    // 三个用户可见秘密（以及内部 hmac secret 不走这里）需要透明解密。
    let (telegram_bot_token, mut secret_error, token_broken) = read_secret_text(
        pool,
        master,
        TELEGRAM_BOT_TOKEN_KEY,
        "",
        normalize_telegram_token,
    )
    .await;
    let (webhook_url, error, webhook_broken) =
        read_secret_text(pool, master, WEBHOOK_URL_KEY, "", normalize_webhook_url).await;
    secret_error = secret_error.or(error);
    let (backup_webdav_password, error, password_broken) =
        read_secret_text(pool, master, BACKUP_WEBDAV_PASSWORD_KEY, "", |raw| {
            Ok(raw.to_string())
        })
        .await;
    secret_error = secret_error.or(error);
    let mut secret_broken_keys = Vec::new();
    for (broken, key) in [
        (token_broken, TELEGRAM_BOT_TOKEN_KEY),
        (webhook_broken, WEBHOOK_URL_KEY),
        (password_broken, BACKUP_WEBDAV_PASSWORD_KEY),
    ] {
        if broken {
            secret_broken_keys.push(key);
        }
    }

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
        public_billing_visible: read_int(
            pool,
            PUBLIC_BILLING_VISIBLE_KEY,
            0,
            1,
            defaults.public_billing_visible,
        )
        .await,
        agent_base_url: read_text(pool, AGENT_BASE_URL_KEY, "", normalize_public_base_url).await,
        subscription_base_url: read_text(
            pool,
            SUBSCRIPTION_BASE_URL_KEY,
            "",
            normalize_public_base_url,
        )
        .await,
        telegram_bot_token,
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
        webhook_url,
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
        update_check_enabled: read_bool(
            pool,
            UPDATE_CHECK_ENABLED_KEY,
            defaults.update_check_enabled,
        )
        .await,
        update_check_interval_hours: read_int(
            pool,
            UPDATE_CHECK_INTERVAL_HOURS_KEY,
            MIN_UPDATE_CHECK_INTERVAL_HOURS,
            MAX_UPDATE_CHECK_INTERVAL_HOURS,
            defaults.update_check_interval_hours,
        )
        .await,
        update_check_notify: read_bool(pool, UPDATE_CHECK_NOTIFY_KEY, defaults.update_check_notify)
            .await,
        backup_webdav_enabled: read_bool(
            pool,
            BACKUP_WEBDAV_ENABLED_KEY,
            defaults.backup_webdav_enabled,
        )
        .await,
        backup_webdav_url: read_text(
            pool,
            BACKUP_WEBDAV_URL_KEY,
            "",
            remote_backup::normalize_webdav_url,
        )
        .await,
        backup_webdav_username: read_text(
            pool,
            BACKUP_WEBDAV_USERNAME_KEY,
            "",
            normalize_backup_webdav_username,
        )
        .await,
        // 密码不做任何规范化：用户设置的原样保存，读回也原样使用。
        backup_webdav_password,
        backup_webdav_interval_hours: read_int(
            pool,
            BACKUP_WEBDAV_INTERVAL_HOURS_KEY,
            MIN_BACKUP_WEBDAV_INTERVAL_HOURS,
            MAX_BACKUP_WEBDAV_INTERVAL_HOURS,
            defaults.backup_webdav_interval_hours,
        )
        .await,
        backup_webdav_keep: read_int(
            pool,
            BACKUP_WEBDAV_KEEP_KEY,
            MIN_BACKUP_WEBDAV_KEEP,
            MAX_BACKUP_WEBDAV_KEEP,
            defaults.backup_webdav_keep,
        )
        .await,
        backup_encrypt: read_bool(pool, BACKUP_ENCRYPT_KEY, defaults.backup_encrypt).await,
        secret_error,
        secret_broken_keys,
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

/// 读取秘密设置：库里是 `enc:v1:` 密文时透明解密，历史明文原样兼容。
///
/// 返回 `(value, error, broken)`：解密失败返回默认值 + 可读错误 + `true`
/// （不含密钥、密文或明文）；调用方把 `broken` 汇总进
/// [`Settings::secret_broken_keys`]，由 GET 标记、PATCH 走逃生路径。
async fn read_secret_text(
    pool: &SqlitePool,
    master: &SecretKey,
    key: &'static str,
    default: &str,
    normalize: fn(&str) -> Result<String, String>,
) -> (String, Option<String>, bool) {
    match repo::settings::get(pool, key).await {
        Ok(Some(raw)) => match secret_box::reveal_setting(master, &raw) {
            Ok(plain) => (
                normalize(&plain).unwrap_or_else(|error| {
                    tracing::warn!(key, %error, "settings 值非法，使用默认值");
                    default.to_string()
                }),
                None,
                false,
            ),
            Err(error) => {
                // 日志只说「解不开」，不输出密文/密钥/明文。
                tracing::error!(key, error = %error, "设置中的秘密无法用当前主密钥解密");
                (default.to_string(), Some(secret_decrypt_error()), true)
            }
        },
        Ok(None) => (default.to_string(), None, false),
        Err(error) => {
            tracing::warn!(key, error = %error, "读取设置失败，使用默认值");
            (default.to_string(), None, false)
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
    // 秘密解不开时仍然返回 200：设置页要能整体打开，管理员才知道哪些键坏了、
    // 才能重填。坏掉的秘密字段已经是空串（`as_json` 从不回显秘密），这里额外用
    // `secret_errors.keys` 明确标记，不能静默成功。
    let settings = load(&state.db).await;
    let broken_keys = settings.secret_broken_keys.clone();
    if let Some(error) = settings.secret_error.as_deref() {
        tracing::error!(
            keys = ?broken_keys,
            error,
            "设置中的秘密无法解密；GET /settings 返回 200 并标记 secret_errors"
        );
    }
    let mut body = json!({ "items": settings.as_json() });
    if settings.secret_error.is_some() {
        body["secret_errors"] = json!({ "keys": broken_keys });
    }
    Ok(Json(body))
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    // 先读一次现有设置（允许部分秘密解不开）：逃生路径要能在主密钥不匹配时
    // 只改非秘密键，或用新值覆盖解不开的秘密键。
    let existing = load(&state.db).await;
    let broken_secret_keys = existing.secret_broken_keys.clone();

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
            PUBLIC_BILLING_VISIBLE_KEY => updates.push((
                PUBLIC_BILLING_VISIBLE_KEY,
                validate_int("公开费用可见开关（0 隐藏 / 1 公开）", value, 0, 1)?.to_string(),
            )),
            AGENT_BASE_URL_KEY => {
                updates.push((AGENT_BASE_URL_KEY, validate_public_base_url(value)?))
            }
            SUBSCRIPTION_BASE_URL_KEY => {
                updates.push((SUBSCRIPTION_BASE_URL_KEY, validate_public_base_url(value)?))
            }
            // 留空 = 保持不变：不把空串写库，避免一次保存清掉已保存的 Token。
            TELEGRAM_BOT_TOKEN_KEY => {
                if let Some(token) = validate_optional_telegram_token(value)? {
                    updates.push((TELEGRAM_BOT_TOKEN_KEY, token));
                }
            }
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
            UPDATE_CHECK_ENABLED_KEY => updates.push((
                UPDATE_CHECK_ENABLED_KEY,
                if validate_bool("版本更新检测开关", value)? {
                    "1".to_string()
                } else {
                    "0".to_string()
                },
            )),
            UPDATE_CHECK_INTERVAL_HOURS_KEY => updates.push((
                UPDATE_CHECK_INTERVAL_HOURS_KEY,
                validate_int(
                    "版本更新检测间隔（小时）",
                    value,
                    MIN_UPDATE_CHECK_INTERVAL_HOURS,
                    MAX_UPDATE_CHECK_INTERVAL_HOURS,
                )?
                .to_string(),
            )),
            UPDATE_CHECK_NOTIFY_KEY => updates.push((
                UPDATE_CHECK_NOTIFY_KEY,
                if validate_bool("版本更新通知开关", value)? {
                    "1".to_string()
                } else {
                    "0".to_string()
                },
            )),
            BACKUP_WEBDAV_ENABLED_KEY => updates.push((
                BACKUP_WEBDAV_ENABLED_KEY,
                if validate_bool("异地备份开关", value)? {
                    "1".to_string()
                } else {
                    "0".to_string()
                },
            )),
            BACKUP_WEBDAV_URL_KEY => updates.push((
                BACKUP_WEBDAV_URL_KEY,
                validate_text(
                    "WebDAV 地址",
                    value,
                    "settings.backup_webdav_url_invalid",
                    remote_backup::normalize_webdav_url,
                )?,
            )),
            BACKUP_WEBDAV_USERNAME_KEY => updates.push((
                BACKUP_WEBDAV_USERNAME_KEY,
                validate_text(
                    "WebDAV 用户名",
                    value,
                    "settings.backup_webdav_username_invalid",
                    normalize_backup_webdav_username,
                )?,
            )),
            // 留空 = 保持不变：不把空串写库，避免一次保存清掉密码。
            BACKUP_WEBDAV_PASSWORD_KEY => {
                if let Some(raw) = validate_optional_password(value)? {
                    updates.push((BACKUP_WEBDAV_PASSWORD_KEY, raw));
                }
            }
            BACKUP_ENCRYPT_KEY => updates.push((
                BACKUP_ENCRYPT_KEY,
                if validate_bool("备份加密开关", value)? {
                    "1".to_string()
                } else {
                    "0".to_string()
                },
            )),
            BACKUP_WEBDAV_INTERVAL_HOURS_KEY => updates.push((
                BACKUP_WEBDAV_INTERVAL_HOURS_KEY,
                validate_int(
                    "异地备份间隔（小时）",
                    value,
                    MIN_BACKUP_WEBDAV_INTERVAL_HOURS,
                    MAX_BACKUP_WEBDAV_INTERVAL_HOURS,
                )?
                .to_string(),
            )),
            BACKUP_WEBDAV_KEEP_KEY => updates.push((
                BACKUP_WEBDAV_KEEP_KEY,
                validate_int(
                    "异地备份保留份数",
                    value,
                    MIN_BACKUP_WEBDAV_KEEP,
                    MAX_BACKUP_WEBDAV_KEEP,
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

    // 部分更新也要保证「开启时有地址与密码」：用写库前的有效值检查。
    if updates.iter().any(|(key, _)| {
        matches!(
            *key,
            BACKUP_WEBDAV_ENABLED_KEY | BACKUP_WEBDAV_URL_KEY | BACKUP_WEBDAV_PASSWORD_KEY
        )
    }) {
        let mut effective = existing;
        for (key, value) in &updates {
            match *key {
                BACKUP_WEBDAV_ENABLED_KEY => effective.backup_webdav_enabled = value == "1",
                BACKUP_WEBDAV_URL_KEY => effective.backup_webdav_url = value.clone(),
                BACKUP_WEBDAV_PASSWORD_KEY => effective.backup_webdav_password = value.clone(),
                _ => {}
            }
        }
        if effective.backup_webdav_enabled {
            if effective.backup_webdav_url.is_empty() {
                return Err(AppError::coded(
                    "settings.backup_webdav_url_required",
                    None,
                    "开启异地备份前必须填写 WebDAV 地址 / A WebDAV URL is required",
                ));
            }
            if effective.backup_webdav_password.is_empty() {
                if broken_secret_keys.contains(&BACKUP_WEBDAV_PASSWORD_KEY) {
                    return Err(AppError::coded(
                        "settings.secret_overwrite",
                        Some(json!({ "keys": [BACKUP_WEBDAV_PASSWORD_KEY] })),
                        "已保存的 WebDAV 密码无法用当前主密钥解密；请重新填写密码，或关闭异地备份 / \
                         The saved WebDAV password cannot be decrypted with the current master \
                         key; re-enter it, or turn off off-site backup",
                    ));
                }
                return Err(AppError::coded(
                    "settings.backup_webdav_password_required",
                    None,
                    "开启异地备份前必须填写 WebDAV 密码 / A WebDAV password is required",
                ));
            }
        }
    }

    // 开启 Telegram Bot 时如果 Token 解不开，不能当成「没配置」静默成功；
    // 保存新 Token 或在同一次请求里关闭 Bot 都可以自救。
    let enables_telegram_bot = updates
        .iter()
        .any(|(key, value)| *key == TELEGRAM_BOT_ENABLED_KEY && value == "1");
    let provides_telegram_token = updates
        .iter()
        .any(|(key, _)| *key == TELEGRAM_BOT_TOKEN_KEY);
    if enables_telegram_bot
        && !provides_telegram_token
        && broken_secret_keys.contains(&TELEGRAM_BOT_TOKEN_KEY)
    {
        return Err(AppError::coded(
            "settings.secret_overwrite",
            Some(json!({ "keys": [TELEGRAM_BOT_TOKEN_KEY] })),
            "已保存的 Telegram Bot Token 无法用当前主密钥解密；请重新填写 Token，或先关闭 Bot / \
             The saved Telegram Bot token cannot be decrypted with the current master key; \
             re-enter it, or turn the bot off first",
        ));
    }

    // 审计只记「改了哪些键」；值里可能有面板名等业务信息，一律不落 detail。
    let changed_keys: Vec<&str> = updates.iter().map(|(key, _)| *key).collect();
    for (key, value) in updates {
        // 秘密项落库前加密；空串保持为空（用于清空 webhook_url 这类可清空项）。
        let stored = if secret_box::is_secret_setting(key) && !value.is_empty() {
            secret_box::encrypt_setting(state.db.secret_key(), &value)
        } else {
            value
        };
        repo::settings::set(&state.db.pool, key, &stored).await?;
    }

    crate::audit::record(
        &state,
        &user.0,
        "settings.update",
        "settings",
        json!({ "keys": changed_keys }),
    )
    .await;

    // 公开页缓存 30 秒：这两项直接改变公开响应，保存后立刻失效，
    // 避免管理员刚关掉费用展示、公开页还能看到旧值。
    if changed_keys
        .iter()
        .any(|key| matches!(*key, PUBLIC_STATUS_ENABLED_KEY | PUBLIC_BILLING_VISIBLE_KEY))
    {
        state.public_status.clear();
    }

    // 秘密仍解不开时也返回 200：非秘密键已经保存成功，前端可以用 warning
    // 提示管理员「哪些键需要重填」，而不是把整次保存吞成 400。
    let settings = load(&state.db).await;
    let mut response = json!({ "items": settings.as_json() });
    if let Some(error) = settings.secret_error {
        response["warning"] = json!(error);
    }
    Ok(Json(response))
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

/// Telegram Bot Token：空串（或纯空白）= 保持原值；否则按原规则规范化。
///
/// 与 WebDAV 密码一致：GET/PATCH 都不回显，留空保存不会清掉已保存的 Token。
fn validate_optional_telegram_token(value: &Value) -> AppResult<Option<String>> {
    let raw = value.as_str().ok_or_else(|| {
        AppError::coded(
            "settings.telegram_bot_token_invalid",
            None,
            "Telegram Bot Token 必须是字符串 / Telegram Bot Token must be a string",
        )
    })?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    normalize_telegram_token(raw)
        .map(Some)
        .map_err(|message| AppError::coded("settings.telegram_bot_token_invalid", None, message))
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

/// 对外地址：空串合法（= 按请求头推导）；非空必须是纯 `http(s)://host[:port]`。
fn validate_public_base_url(value: &Value) -> AppResult<String> {
    let raw = value.as_str().ok_or_else(|| {
        AppError::coded(
            "settings.base_url_type_invalid",
            None,
            "对外地址必须是字符串 / Public address must be a string",
        )
    })?;
    crate::routes::public_url::parse_public_base_url(raw)
        .map_err(|error| AppError::coded(error.code(), None, error.message()))
}

fn normalize_public_base_url(raw: &str) -> Result<String, String> {
    crate::routes::public_url::parse_public_base_url(raw).map_err(|error| error.message())
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

/// WebDAV 用户名：trim、长度上限、不允许冒号（Basic 认证的分隔符）。
fn normalize_backup_webdav_username(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.chars().count() > MAX_BACKUP_WEBDAV_USERNAME_CHARS {
        return Err(format!(
            "WebDAV 用户名最多 {MAX_BACKUP_WEBDAV_USERNAME_CHARS} 个字符"
        ));
    }
    if value.contains(':') {
        return Err("WebDAV 用户名不能包含冒号".to_string());
    }
    if value.chars().any(char::is_control) {
        return Err("WebDAV 用户名不能包含控制字符".to_string());
    }
    Ok(value.to_string())
}

/// 密码：空串（或纯空白）= 保持原值；否则原样保存。
///
/// 允许空格（密码里可能是短语），只挡换行与控制字符——它们会破坏
/// curl 的 stdin 配置格式。
fn validate_optional_password(value: &Value) -> AppResult<Option<String>> {
    let raw = value.as_str().ok_or_else(|| {
        AppError::coded(
            "settings.backup_webdav_password_invalid",
            None,
            "WebDAV 密码必须是字符串 / WebDAV password must be a string",
        )
    })?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    if raw.chars().count() > MAX_BACKUP_WEBDAV_PASSWORD_CHARS {
        return Err(AppError::coded(
            "settings.backup_webdav_password_invalid",
            None,
            format!(
                "WebDAV 密码最多 {MAX_BACKUP_WEBDAV_PASSWORD_CHARS} 个字符 / \
                 WebDAV password is too long"
            ),
        ));
    }
    if raw.chars().any(|character| character.is_control()) {
        return Err(AppError::coded(
            "settings.backup_webdav_password_invalid",
            None,
            "WebDAV 密码不能包含控制字符 / WebDAV password cannot contain control characters",
        ));
    }
    Ok(Some(raw.to_string()))
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
                subscription_template_id: None,
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
                subscription_template_id: None,
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
    async fn public_base_urls_default_empty_and_round_trip_trimmed() {
        let (app, _state, admin, _bob) = setup().await;

        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(body["items"]["agent_base_url"], "");
        assert_eq!(body["items"]["subscription_base_url"], "");

        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({
                "agent_base_url": "  https://panel.example.com:8443  ",
                "subscription_base_url": "  HTTP://sub.example.com  ",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["items"]["agent_base_url"],
            "https://panel.example.com:8443"
        );
        assert_eq!(
            body["items"]["subscription_base_url"], "http://sub.example.com",
            "scheme 统一小写，首尾空白 trim"
        );

        // 清空同样合法：回到请求头推导。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"agent_base_url": "   ", "subscription_base_url": ""})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["agent_base_url"], "");
        assert_eq!(body["items"]["subscription_base_url"], "");
    }

    #[tokio::test]
    async fn invalid_public_base_urls_are_rejected_with_bilingual_codes() {
        let (app, _state, admin, _bob) = setup().await;
        let cases = [
            ("agent_base_url", json!("panel.example.com")),
            ("agent_base_url", json!("ftp://panel.example.com")),
            ("agent_base_url", json!("https://panel.example.com/path")),
            ("agent_base_url", json!("https://panel.example.com?x=1")),
            ("agent_base_url", json!("https://panel.example.com#top")),
            ("agent_base_url", json!("http://")),
            ("agent_base_url", json!("http://:8787")),
            ("agent_base_url", json!("http://panel.example.com:0")),
            ("agent_base_url", json!("http://panel.example.com:70000")),
            (
                "agent_base_url",
                json!("https://user:pass@panel.example.com"),
            ),
            ("subscription_base_url", json!("https://sub.example.com/")),
            ("subscription_base_url", json!("sub.example.com")),
            ("subscription_base_url", json!("http://")),
            ("subscription_base_url", json!(123)),
        ];
        for (key, value) in cases {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(json!({ key: value })),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{key}: {body}");
            let code = body["code"].as_str().unwrap();
            assert!(code.starts_with("settings.base_url_"), "{key}: {body}");
            let message = body["error"].as_str().unwrap();
            assert!(message.contains(" / "), "错误信息必须中英双语：{body}");
        }

        // 全量校验：非法地址不能把同一请求里的合法字段半截写库。
        let (status, _, _) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"panel_name": "临时名字", "agent_base_url": "nope"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(body["items"]["panel_name"], "PierWave");
        assert_eq!(body["items"]["agent_base_url"], "");
    }

    #[tokio::test]
    async fn corrupt_public_base_urls_fall_back_to_empty_on_read() {
        let (app, state, admin, _bob) = setup().await;
        for (key, value) in [
            ("agent_base_url", "https://panel.example.com/path"),
            ("subscription_base_url", "ftp://sub.example.com"),
        ] {
            repo::settings::set(&state.db.pool, key, value)
                .await
                .unwrap();
        }

        let settings = load(&state.db).await;
        assert_eq!(settings.agent_base_url, "");
        assert_eq!(settings.subscription_base_url, "");

        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(body["items"]["agent_base_url"], "");
        assert_eq!(body["items"]["subscription_base_url"], "");
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
        assert_eq!(load(&state.db).await.agent_upgrade_concurrency, 1);
    }

    /// 版本更新检测：三项设置的默认值、范围校验与「手工改坏读取回落」。
    ///
    /// 间隔只接受 1–168 小时（0 会变成轮询风暴）；越界直接 400，不做静默夹紧，
    /// 让调用方立刻发现自己传错了值。
    #[tokio::test]
    async fn update_check_settings_are_validated_and_read_falls_back() {
        let (app, state, admin, _bob) = setup().await;

        let (status, _, body) =
            request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"]["update_check_enabled"], true, "默认启用");
        assert_eq!(
            body["items"]["update_check_interval_hours"], 6,
            "默认 6 小时"
        );
        assert_eq!(
            body["items"]["update_check_notify"], true,
            "兼容保留的旧开关默认仍是 true，与 update_available 事件默认勾选一致"
        );
        assert!(
            body["items"]["alert_events"]
                .as_str()
                .unwrap()
                .split(',')
                .any(|event| event == "update_available"),
            "版本更新通知的唯一开关是 alert_events 里的 update_available：{body}"
        );

        for hours in [1, 6, 168] {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(json!({"update_check_interval_hours": hours})),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["items"]["update_check_interval_hours"], hours);
        }

        for bad in [json!(0), json!(169), json!(-1), json!("6")] {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(json!({"update_check_interval_hours": bad.clone()})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "payload: {bad}");
            assert!(
                body["error"].as_str().unwrap().contains("版本更新检测间隔"),
                "错误信息要指出字段：{body}"
            );
        }

        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({
                "update_check_enabled": false,
                "update_check_notify": false,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["update_check_enabled"], false);
        assert_eq!(body["items"]["update_check_notify"], false);

        let (status, _, _) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"update_check_enabled": "yes"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "布尔项必须是 true / false");

        // 直接写库绕过接口（模拟手工改坏）：读取回落到默认值。
        repo::settings::set(&state.db.pool, "update_check_interval_hours", "0")
            .await
            .unwrap();
        repo::settings::set(&state.db.pool, "update_check_enabled", "wat")
            .await
            .unwrap();
        let loaded = load(&state.db).await;
        assert_eq!(loaded.update_check_interval_hours, 6);
        assert!(loaded.update_check_enabled);
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
            body["items"]["alert_events"],
            "server_offline,user_exhausted,chain_degraded,backup_failed,update_available,login_failed,login_new_ip",
            "升级失败默认不开启；异地备份失败、发现新版本与两类登录告警默认开启"
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
        assert_eq!(
            body["items"]["telegram_bot_token"], "",
            "Token 不回显，只给 has_token"
        );
        assert_eq!(body["items"]["telegram_bot_has_token"], true);
        assert!(!body.to_string().contains("123456:ABC-def_ghi"), "{body}");
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
        assert_eq!(
            body["items"]["telegram_bot_has_token"], true,
            "留空 = 保持不变，已保存的 Token 不能被清掉"
        );
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

        let settings = load(&state.db).await;
        assert_eq!(settings.telegram_bot_token, "");
        assert_eq!(settings.telegram_chat_id, "");
        assert_eq!(settings.webhook_url, "");
        assert_eq!(settings.alert_events, DEFAULT_ALERT_EVENTS);
        assert_eq!(settings.alert_cooldown_secs, DEFAULT_ALERT_COOLDOWN_SECS);

        // 空事件列表是合法值，不能被回落成默认（否则「全部关闭」失效）。
        repo::settings::set(&state.db.pool, "alert_events", "")
            .await
            .unwrap();
        assert_eq!(load(&state.db).await.alert_events, "");

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
        assert_eq!(load(&state.db).await.public_status_enabled, 1);
    }

    /// 公开费用可见性：默认 1（兼容旧行为）；只接受 0 / 1；手工改坏回落默认。
    #[tokio::test]
    async fn public_billing_visible_accepts_only_zero_or_one() {
        let (app, state, admin, _bob) = setup().await;

        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(
            body["items"]["public_billing_visible"], 1,
            "费用默认公开，保持升级前的行为"
        );

        for ok in [0, 1] {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(json!({"public_billing_visible": ok})),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["items"]["public_billing_visible"], ok);
        }

        for bad in [json!(2), json!(-1), json!("0"), json!(true), json!(null)] {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(json!({"public_billing_visible": bad.clone()})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "payload: {bad}");
            assert!(
                body["error"].as_str().unwrap().contains("公开费用"),
                "错误信息要指出字段：{body}"
            );
        }

        // 手工改坏：读取回落默认 1，不能因为一个坏键让设置页整体打不开。
        repo::settings::set(&state.db.pool, "public_billing_visible", "9")
            .await
            .unwrap();
        assert_eq!(load(&state.db).await.public_billing_visible, 1);
    }

    /// 异地备份：默认值、地址规范化、密码不回显、留空保持不变。
    #[tokio::test]
    async fn backup_webdav_settings_never_echo_the_password() {
        let (app, state, admin, _bob) = setup().await;

        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(body["items"]["backup_webdav_enabled"], false, "默认关闭");
        assert_eq!(body["items"]["backup_webdav_url"], "");
        assert_eq!(body["items"]["backup_webdav_username"], "");
        assert_eq!(body["items"]["backup_webdav_password"], "");
        assert_eq!(body["items"]["backup_webdav_has_password"], false);
        assert_eq!(body["items"]["backup_webdav_interval_hours"], 24);
        assert_eq!(body["items"]["backup_webdav_keep"], 7);

        let secret = "s3cret-pass";
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({
                "backup_webdav_enabled": true,
                "backup_webdav_url": "  https://dav.example.com/remote.php/dav/files/user/pierwave/  ",
                "backup_webdav_username": "  pierwave  ",
                "backup_webdav_password": secret,
                "backup_webdav_interval_hours": 12,
                "backup_webdav_keep": 3,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["items"]["backup_webdav_url"],
            "https://dav.example.com/remote.php/dav/files/user/pierwave",
            "地址要 trim、去掉末尾斜杠"
        );
        assert_eq!(body["items"]["backup_webdav_username"], "pierwave");
        assert_eq!(
            body["items"]["backup_webdav_password"], "",
            "密码绝不能出现在 API 响应里"
        );
        assert_eq!(body["items"]["backup_webdav_has_password"], true);
        assert_eq!(body["items"]["backup_webdav_interval_hours"], 12);
        assert_eq!(body["items"]["backup_webdav_keep"], 3);
        assert!(
            !body.to_string().contains(secret),
            "响应体任何位置都不能出现密码：{body}"
        );

        // 密码已落库（客户端要用），但只存在服务端。
        assert_eq!(load(&state.db).await.backup_webdav_password, secret);

        // 留空保存 = 保持不变，不能把已保存的密码清掉。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"backup_webdav_password": ""})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["backup_webdav_has_password"], true);
        assert_eq!(load(&state.db).await.backup_webdav_password, secret);

        // 显式换成新密码才覆盖。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"backup_webdav_password": "new-pass"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(!body.to_string().contains("new-pass"), "{body}");
        assert_eq!(load(&state.db).await.backup_webdav_password, "new-pass");
    }

    /// Telegram Token 与 WebDAV 密码同一语义：GET/PATCH 都不回显，留空保持不变。
    #[tokio::test]
    async fn telegram_token_is_masked_and_blank_keeps_the_saved_value() {
        use std::sync::Arc;

        use crate::alerts::{AlertKind, Alerts, RecordingTransport};

        let (app, mut state, admin, _bob) = setup().await;
        let secret = "123456:ABC-secret-token";
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({
                "telegram_bot_token": secret,
                "telegram_chat_id": "-1001234567890",
                "alert_cooldown_secs": 0,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["items"]["telegram_bot_token"], "",
            "PATCH 响应也不能回显 Token"
        );
        assert_eq!(body["items"]["telegram_bot_has_token"], true);
        assert!(
            !body.to_string().contains(secret),
            "响应体任何位置都不能出现 Token：{body}"
        );

        let (status, _, body) =
            request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"]["telegram_bot_token"], "");
        assert_eq!(body["items"]["telegram_bot_has_token"], true);
        assert!(
            !body.to_string().contains(secret),
            "GET 不能回显 Token：{body}"
        );

        // 留空 = 保持不变（不能把已保存的 Token 清掉）。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"telegram_bot_token": ""})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["telegram_bot_has_token"], true);
        assert_eq!(load(&state.db).await.telegram_bot_token, secret);

        // 告警仍然使用库里的真实值（不是 GET 返回的掩码）。
        let transport = Arc::new(RecordingTransport::default());
        state.alerts = Alerts::new(transport.clone());
        crate::alerts::notify(
            &state,
            AlertKind::LoginFailed,
            "admin",
            "连续登录失败 / Repeated login failures",
            "test",
        )
        .await;
        let sent = transport.wait_for(1).await;
        assert!(
            sent[0].url.contains(secret),
            "Telegram 投递必须用库里的真实 Token：{}",
            sent[0].url
        );

        // 新值生效；响应仍然只给 has_token。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"telegram_bot_token": "654321:NEW-token"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["telegram_bot_token"], "");
        assert_eq!(body["items"]["telegram_bot_has_token"], true);
        assert!(!body.to_string().contains("654321:NEW-token"), "{body}");
        assert_eq!(load(&state.db).await.telegram_bot_token, "654321:NEW-token");
    }

    /// 异地备份：URL、间隔、保留份数、用户名/密码的校验与「开启前置条件」。
    #[tokio::test]
    async fn backup_webdav_settings_validate_inputs_and_enable_preconditions() {
        let (app, _state, admin, _bob) = setup().await;

        let cases = [
            ("backup_webdav_url", json!("ftp://dav.example.com/dav")),
            ("backup_webdav_url", json!("dav.example.com/dav")),
            (
                "backup_webdav_url",
                json!("https://user:pass@dav.example.com/dav"),
            ),
            (
                "backup_webdav_url",
                json!("https://dav.example.com/dav?x=1"),
            ),
            ("backup_webdav_interval_hours", json!(0)),
            ("backup_webdav_interval_hours", json!(169)),
            ("backup_webdav_interval_hours", json!("24")),
            ("backup_webdav_keep", json!(0)),
            ("backup_webdav_keep", json!(31)),
            ("backup_webdav_keep", json!("7")),
            ("backup_webdav_username", json!("a:b")),
            ("backup_webdav_username", json!(123)),
            ("backup_webdav_password", json!("line\nbreak")),
            ("backup_webdav_password", json!(123)),
            ("backup_webdav_enabled", json!("true")),
        ];
        for (key, value) in cases {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(json!({ key: value.clone() })),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{key}={value}: {body}");
            assert!(
                body["code"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("settings."),
                "{key}={value}: {body}"
            );
        }

        // 开启时必须同时具备地址与密码。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"backup_webdav_enabled": true})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "settings.backup_webdav_url_required");

        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({
                "backup_webdav_enabled": true,
                "backup_webdav_url": "https://dav.example.com/dav",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "settings.backup_webdav_password_required");

        // 同一个请求里补齐地址与密码：允许。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({
                "backup_webdav_enabled": true,
                "backup_webdav_url": "http://10.0.0.5:8080/dav",
                "backup_webdav_password": "pass",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["backup_webdav_enabled"], true);
        assert_eq!(
            body["items"]["backup_webdav_url"], "http://10.0.0.5:8080/dav",
            "内网允许 http"
        );
    }

    /// 库里被手工改坏时，读取回落到默认值，不影响主控启动与其它设置。
    #[tokio::test]
    async fn corrupt_backup_webdav_settings_fall_back_to_defaults() {
        let (_app, state, _admin, _bob) = setup().await;
        for (key, value) in [
            ("backup_webdav_enabled", "maybe"),
            ("backup_webdav_url", "ftp://dav.example.com"),
            ("backup_webdav_username", "a:b"),
            ("backup_webdav_interval_hours", "0"),
            ("backup_webdav_keep", "99"),
        ] {
            repo::settings::set(&state.db.pool, key, value)
                .await
                .unwrap();
        }
        let settings = load(&state.db).await;
        assert!(!settings.backup_webdav_enabled);
        assert_eq!(settings.backup_webdav_url, "");
        assert_eq!(settings.backup_webdav_username, "");
        assert_eq!(settings.backup_webdav_interval_hours, 24);
        assert_eq!(settings.backup_webdav_keep, 7);
        // 密码不做规范化：手工写入的值仍然原样读回（可能被用于连接）。
        repo::settings::set(&state.db.pool, "backup_webdav_password", "raw-pass")
            .await
            .unwrap();
        assert_eq!(load(&state.db).await.backup_webdav_password, "raw-pass");
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
        let settings = load(&state.db).await;
        assert!(!settings.telegram_bot_enabled);
        assert_eq!(settings.telegram_admin_chat_ids, "");
        assert!(parse_telegram_admin_chat_ids(" 1,2,1 ").unwrap() == vec!["1", "2"]);
    }

    /// 新写入的秘密项在库里必须是密文；读取路径透明解密。
    #[tokio::test]
    async fn secret_settings_are_encrypted_at_rest_and_readable() {
        let (app, state, admin, _bob) = setup().await;
        let token = "123456:ABC-at-rest";
        let password = "webdav-pass-at-rest";
        let webhook = "https://hooks.example.test/services/secret-path";

        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({
                "telegram_bot_token": token,
                "backup_webdav_password": password,
                "webhook_url": webhook,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");

        // 落盘值：带 enc:v1: 前缀、不含明文。
        for (name, plaintext) in [
            ("telegram_bot_token", token),
            ("backup_webdav_password", password),
            ("webhook_url", webhook),
        ] {
            let raw = repo::settings::get(&state.db.pool, name)
                .await
                .unwrap()
                .unwrap();
            assert!(
                secret_box::is_encrypted_setting(&raw),
                "{name} 必须落密文：{raw}"
            );
            assert!(!raw.contains(plaintext), "{name} 明文不能落库：{raw}");
        }

        // 读取路径：内存设置里是明文，API 只对 Token/密码做掩码。
        let loaded = load(&state.db).await;
        assert!(loaded.secret_error.is_none());
        assert_eq!(loaded.telegram_bot_token, token);
        assert_eq!(loaded.backup_webdav_password, password);
        assert_eq!(loaded.webhook_url, webhook);

        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(body["items"]["telegram_bot_token"], "");
        assert_eq!(body["items"]["telegram_bot_has_token"], true);
        assert_eq!(body["items"]["backup_webdav_password"], "");
        assert_eq!(body["items"]["backup_webdav_has_password"], true);
        assert_eq!(body["items"]["webhook_url"], webhook);
        assert!(!body.to_string().contains(token), "{body}");
        assert!(!body.to_string().contains(password), "{body}");
    }

    /// 升级前写下的明文秘密（没有前缀）仍然可用；迁移会把它们加密。
    #[tokio::test]
    async fn legacy_plaintext_secret_settings_stay_usable() {
        let (_app, state, _admin, _bob) = setup().await;
        repo::settings::set(&state.db.pool, "telegram_bot_token", "legacy:token")
            .await
            .unwrap();
        repo::settings::set(&state.db.pool, "backup_webdav_password", "legacy-pass")
            .await
            .unwrap();

        let loaded = load(&state.db).await;
        assert!(loaded.secret_error.is_none());
        assert_eq!(loaded.telegram_bot_token, "legacy:token");
        assert_eq!(loaded.backup_webdav_password, "legacy-pass");

        // 迁移的 Rust 侧：明文就地加密，迁移后仍可读；第二次不改写。
        let changed = secret_box::encrypt_existing_settings(&state.db.pool, state.db.secret_key())
            .await
            .unwrap();
        assert_eq!(changed.len(), 2, "{changed:?}");
        let loaded = load(&state.db).await;
        assert_eq!(loaded.telegram_bot_token, "legacy:token");
        assert_eq!(loaded.backup_webdav_password, "legacy-pass");
        let changed = secret_box::encrypt_existing_settings(&state.db.pool, state.db.secret_key())
            .await
            .unwrap();
        assert!(changed.is_empty(), "迁移必须幂等：{changed:?}");
    }

    /// 主密钥不匹配：GET 仍返回 200（设置页整体可用），坏掉的秘密字段为空，
    /// 并用 `secret_errors.keys` 明确告诉前端哪些键需要重填。
    #[tokio::test]
    async fn wrong_master_key_is_reported_instead_of_silently_empty() {
        let (app, state, admin, _bob) = setup().await;
        let other = SecretKey::generate().unwrap();
        let sealed = secret_box::encrypt_setting(&other, "123456:written-with-another-key");
        repo::settings::set(&state.db.pool, "telegram_bot_token", &sealed)
            .await
            .unwrap();

        let (status, _, body) =
            request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(status, StatusCode::OK, "秘密损坏不能让整页不可用：{body}");
        assert_eq!(body["items"]["telegram_bot_token"], "");
        assert_eq!(body["items"]["telegram_bot_has_token"], false);
        assert_eq!(
            body["secret_errors"]["keys"],
            json!(["telegram_bot_token"]),
            "必须列出解不开的键：{body}"
        );
        let rendered = body.to_string();
        assert!(
            !rendered.contains("written-with-another-key") && !rendered.contains(&sealed),
            "响应不能泄露明文或密文：{rendered}"
        );

        // 内部读取仍能工作（空 Token + secret_error），只是 API 明确标记。
        let settings = load(&state.db).await;
        assert_eq!(settings.telegram_bot_token, "");
        assert!(settings.secret_error.is_some());
    }

    /// 备份加密默认开启；关闭/重新开启都能往返，并且原始落库值正确。
    #[tokio::test]
    async fn backup_encrypt_defaults_true_and_round_trips() {
        let (app, state, admin, _bob) = setup().await;
        let (_, _, body) = request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(
            body["items"]["backup_encrypt"], true,
            "加密备份必须默认开启"
        );

        for (value, stored) in [(false, "0"), (true, "1")] {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                Method::PATCH,
                "/api/v1/settings",
                Some(json!({ "backup_encrypt": value })),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["items"]["backup_encrypt"], value);
            assert_eq!(
                repo::settings::get(&state.db.pool, "backup_encrypt")
                    .await
                    .unwrap()
                    .as_deref(),
                Some(stored)
            );
        }

        // 非布尔值直接 400。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"backup_encrypt": "off"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!body["error"].as_str().unwrap().is_empty());
    }

    /// 主密钥不匹配时，管理员仍能自救：只改非秘密键、或用新值覆盖坏掉的秘密。
    #[tokio::test]
    async fn settings_patch_stays_usable_when_a_secret_cannot_be_decrypted() {
        let (app, state, admin, _bob) = setup().await;
        let other = SecretKey::generate().unwrap();
        let old_secret = "123456:written-with-another-key";
        let sealed = secret_box::encrypt_setting(&other, old_secret);
        repo::settings::set(&state.db.pool, "telegram_bot_token", &sealed)
            .await
            .unwrap();
        // 让 WebDAV 也处于「已开启但密码解不开」：这必须给出明确的覆盖错误。
        for (key, value) in [
            ("backup_webdav_enabled", "1"),
            ("backup_webdav_url", "https://dav.example.test/dav"),
        ] {
            repo::settings::set(&state.db.pool, key, value)
                .await
                .unwrap();
        }
        let password = secret_box::encrypt_setting(&other, "webdav-secret");
        repo::settings::set(&state.db.pool, "backup_webdav_password", &password)
            .await
            .unwrap();

        // 只写非秘密键：200，值保存成功，并带 warning（秘密仍待修复）。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({ "panel_name": "Rescue Panel" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"]["panel_name"], "Rescue Panel");
        assert!(
            body["warning"].as_str().unwrap().contains("主密钥"),
            "{body}"
        );
        assert_eq!(
            repo::settings::get(&state.db.pool, "panel_name")
                .await
                .unwrap()
                .as_deref(),
            Some("Rescue Panel")
        );

        // 开启 WebDAV 却没有提供新密码：给出 secret_overwrite，而不是误导成「未配置」。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({ "backup_webdav_enabled": true })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "settings.secret_overwrite");
        assert!(body["error"].as_str().unwrap().contains("WebDAV 密码"));

        // 用新值覆盖坏掉的 Token：200；WebDAV 密码仍坏，所以响应继续带 warning。
        let new_token = "654321:NEW-token";
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({ "telegram_bot_token": new_token })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            body["warning"].as_str().unwrap().contains("主密钥"),
            "{body}"
        );

        // 覆盖后的落盘值必须是新密钥加密的密文，旧明文不再存在。
        let raw = repo::settings::get(&state.db.pool, "telegram_bot_token")
            .await
            .unwrap()
            .unwrap();
        assert!(secret_box::is_encrypted_setting(&raw));
        assert!(!raw.contains(old_secret) && !raw.contains(new_token));
        assert_eq!(
            secret_box::reveal_setting(state.db.secret_key(), &raw).unwrap(),
            new_token
        );

        // 再重填 WebDAV 密码：所有秘密都能解开后，GET 恢复正常。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({ "backup_webdav_password": "new-webdav-pass" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.get("warning").is_none(), "秘密已全部修复：{body}");
        let (status, _, body) =
            request(&app, Some(&admin), Method::GET, "/api/v1/settings", None).await;
        assert_eq!(status, StatusCode::OK, "重填秘密后必须能读取设置：{body}");
    }

    /// 后台路径统一拿 `SecretError`：错误里只有键名，没有值。
    #[tokio::test]
    async fn load_for_background_reports_keys_but_never_values() {
        let (_app, state, _admin, _bob) = setup().await;
        let other = SecretKey::generate().unwrap();
        let secret = "123456:background-leak-canary";
        repo::settings::set(
            &state.db.pool,
            "telegram_bot_token",
            &secret_box::encrypt_setting(&other, secret),
        )
        .await
        .unwrap();

        let error = load_for_background(&state.db).await.unwrap_err();
        assert_eq!(error.keys, vec![TELEGRAM_BOT_TOKEN_KEY]);
        assert!(error.message.contains("主密钥"));
        assert!(!error.to_string().contains(secret));
        assert!(!format!("{error:?}").contains(secret));
    }

    /// `Settings` 的 Debug 不能把凭据带进日志。
    #[test]
    fn settings_debug_redacts_secrets_and_authorization_lists() {
        let settings = Settings {
            telegram_bot_token: "123456:TOKEN-CANARY".into(),
            telegram_admin_chat_ids: "-100999".into(),
            webhook_url: "https://hooks.test/canary".into(),
            backup_webdav_password: "PASSWORD-CANARY".into(),
            ..Settings::default()
        };
        let debug = format!("{settings:?}");
        for secret in [
            "123456:TOKEN-CANARY",
            "PASSWORD-CANARY",
            "canary",
            "-100999",
        ] {
            assert!(!debug.contains(secret), "Debug 泄露了 {secret}: {debug}");
        }
        assert_eq!(debug.matches("<redacted>").count(), 4, "{debug}");
    }
}
