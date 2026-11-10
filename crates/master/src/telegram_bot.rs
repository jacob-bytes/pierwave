//! 管理员 Telegram Bot：`getUpdates` 长轮询 + 纯文本命令分发。
//!
//! 范围：**只服务已配置的管理员 chat id**，不做租户绑定。授权判断在
//! [`dispatch`] 的第一行完成——非管理员直接返回「未授权」，后面的命令处理
//! 根本不会读库，因此不存在「先查再拒绝」导致的数据泄露窗口。
//!
//! 设计取舍：
//! * 投递仍然走系统 `curl` 子进程，不引入 HTTP 客户端依赖。bot token 嵌在
//!   URL 里，所以 URL、chat_id、正文全部通过 `--config -` 从 stdin 传入，
//!   **不进 argv**（`ps` / `/proc/*/cmdline` 对同机其它用户可见）。
//! * `getUpdates` 用 `timeout=30` 长轮询；`offset` 只放进程内存，主控重启后
//!   可能重复处理上一条命令——通知类 Bot 允许这种重复，换来的是一条命令都
//!   不会漏。把 offset 落库不值当（多一次写事务，且重启本来就少）。
//! * 主控启动时拉起一个 supervisor 任务；它每 [`CONFIG_REFRESH`] 读一次设置，
//!   配置变化（启停、token、管理员列表）时中止旧长轮询任务并起新的。
//! * 所有失败只 `tracing::warn!`，绝不影响主控启动 / WS / 心跳等主流程。
//! * 对外只回纯文本中文 + 英文关键字段，不含异常堆栈、数据库 id、session
//!   token 等内部信息；超长消息截断到 Telegram 的 4096 字符上限并提示。

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::task::JoinHandle;

use pierwave_domain::{chains, repo, time};

use crate::alerts::escape_curl_config;
use crate::routes::settings;
use crate::state::AppState;

/// Telegram `sendMessage` 的硬上限：超过会被 API 直接拒绝。
pub const MAX_MESSAGE_CHARS: usize = 4096;

/// 截断提示；本身也算进 4096 字符里。
pub const TRUNCATED_SUFFIX: &str = "\n…（已截断 / truncated）";

/// `getUpdates` 长轮询的最长等待秒数。
pub const POLL_TIMEOUT_SECS: u64 = 30;

/// supervisor 读取设置的间隔：30 秒足够，不追求实时。
pub const CONFIG_REFRESH: Duration = Duration::from_secs(30);

/// 未授权时的唯一回复；不包含任何业务字段。
pub const UNAUTHORIZED: &str = "未授权 / Unauthorized";

/// 单次命令最多展示的服务器行数。
const MAX_SERVER_ROWS: usize = 20;

/// 一轮长轮询所需的配置。`PartialEq` 用来判断设置是否真的变了。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotConfig {
    pub token: String,
    /// 已规范化、去重后的管理员 chat id；空列表会在 supervisor 里被当成未启用。
    pub admin_chat_ids: Vec<String>,
}

impl BotConfig {
    fn is_admin(&self, chat_id: &str) -> bool {
        self.admin_chat_ids.iter().any(|id| id == chat_id)
    }
}

/// 一条更新里我们关心的部分；没有 text 的消息（图片、入群事件等）只用来推进 offset。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingMessage {
    pub chat_id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingUpdate {
    pub update_id: i64,
    pub message: Option<IncomingMessage>,
}

pub type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// 投递抽象：生产是 curl，测试注入脚本化更新与记录型发送（绝不联网）。
pub trait TelegramTransport: Send + Sync {
    fn get_updates<'a>(
        &'a self,
        token: &'a str,
        offset: i64,
        timeout_secs: u64,
    ) -> TransportFuture<'a, Vec<IncomingUpdate>>;

    fn send_message<'a>(
        &'a self,
        token: &'a str,
        chat_id: &'a str,
        text: &'a str,
    ) -> TransportFuture<'a, ()>;
}

/// curl 参数里没有 token、chat_id 或正文；它们全在 stdin 的 config 里。
///
/// `--max-time 40` 比长轮询的 `timeout=30` 多留 10 秒网络余量。
pub const CURL_ARGS: &[&str] = &[
    "--silent",
    "--show-error",
    "--fail",
    "--proto",
    "=http,https",
    "--connect-timeout",
    "5",
    "--max-time",
    "40",
    "--config",
    "-",
];

/// 生产投递器。
#[derive(Debug, Clone)]
pub struct CurlTransport {
    program: String,
}

impl Default for CurlTransport {
    fn default() -> Self {
        Self {
            program: "curl".into(),
        }
    }
}

pub fn get_updates_url(token: &str) -> String {
    format!("https://api.telegram.org/bot{token}/getUpdates")
}

pub fn send_message_url(token: &str) -> String {
    format!("https://api.telegram.org/bot{token}/sendMessage")
}

/// `getUpdates` 的 curl config。token 只出现在这里（stdin），不在 argv。
pub fn build_get_updates_config(token: &str, offset: i64, timeout_secs: u64) -> String {
    format!(
        "url = \"{}\"\ndata-urlencode = \"timeout={timeout_secs}\"\ndata-urlencode = \"offset={offset}\"\ndata-urlencode = \"allowed_updates=[\\\"message\\\"]\"\n",
        escape_curl_config(&get_updates_url(token)),
    )
}

/// `sendMessage` 的 curl config。只发纯文本，不设 `parse_mode`。
pub fn build_send_message_config(token: &str, chat_id: &str, text: &str) -> String {
    format!(
        "url = \"{}\"\ndata-urlencode = \"chat_id={}\"\ndata-urlencode = \"text={}\"\ndata-urlencode = \"disable_web_page_preview=true\"\n",
        escape_curl_config(&send_message_url(token)),
        escape_curl_config(chat_id),
        escape_curl_config(text),
    )
}

async fn run_curl(program: &str, config: String) -> Result<Vec<u8>, String> {
    let mut child = Command::new(program)
        .args(CURL_ARGS)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // supervisor 停止/重启长轮询时会 abort 任务；顺手杀掉 curl，避免孤儿进程
        // 再占着 30 秒长轮询。
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("无法执行 `{program}`：{error}"))?;

    let write_result = match child.stdin.take() {
        Some(mut stdin) => {
            let written = stdin.write_all(config.as_bytes()).await;
            drop(stdin);
            written
        }
        None => Ok(()),
    };
    if let Err(error) = write_result {
        let _ = child.kill().await;
        return Err(format!("向 curl 写入配置失败：{error}"));
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("等待 curl 退出失败：{error}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    let detail: String = detail.chars().take(300).collect();
    if detail.is_empty() {
        Err(format!("curl 退出码 {:?}", output.status.code()))
    } else {
        Err(format!("curl 退出码 {:?}：{detail}", output.status.code()))
    }
}

impl TelegramTransport for CurlTransport {
    fn get_updates<'a>(
        &'a self,
        token: &'a str,
        offset: i64,
        timeout_secs: u64,
    ) -> TransportFuture<'a, Vec<IncomingUpdate>> {
        Box::pin(async move {
            let config = build_get_updates_config(token, offset, timeout_secs);
            let bytes = run_curl(&self.program, config)
                .await
                .map_err(|error| error.replace(token, "<redacted>"))?;
            parse_updates_response(&bytes)
        })
    }

    fn send_message<'a>(
        &'a self,
        token: &'a str,
        chat_id: &'a str,
        text: &'a str,
    ) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            let config = build_send_message_config(token, chat_id, text);
            let bytes = run_curl(&self.program, config)
                .await
                .map_err(|error| error.replace(token, "<redacted>"))?;
            parse_ok_response(&bytes)
        })
    }
}

#[derive(Deserialize)]
struct ApiEnvelope<T> {
    ok: bool,
    #[serde(default)]
    result: Option<T>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct RawUpdate {
    update_id: i64,
    #[serde(default)]
    message: Option<RawMessage>,
}

#[derive(Deserialize)]
struct RawMessage {
    chat: RawChat,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct RawChat {
    /// Telegram 的 chat id 是整数；这里用 `Value` 兜底字符串形式，避免旧版本/网关差异。
    id: Value,
}

fn chat_id_string(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => Some(number.to_string()),
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

/// 解析 `getUpdates` 响应。没有 text 的更新也会返回（只带 update_id），
/// 让调用方推进 offset，避免同一条非文本消息被反复拉取。
pub fn parse_updates_response(bytes: &[u8]) -> Result<Vec<IncomingUpdate>, String> {
    let envelope: ApiEnvelope<Vec<RawUpdate>> = serde_json::from_slice(bytes)
        .map_err(|error| format!("解析 getUpdates 响应失败：{error}"))?;
    if !envelope.ok {
        return Err(envelope
            .description
            .unwrap_or_else(|| "Telegram API 返回 ok=false".to_string()));
    }
    Ok(envelope
        .result
        .unwrap_or_default()
        .into_iter()
        .map(|update| IncomingUpdate {
            update_id: update.update_id,
            message: update.message.and_then(|message| {
                let chat_id = chat_id_string(&message.chat.id)?;
                let text = message.text?;
                Some(IncomingMessage { chat_id, text })
            }),
        })
        .collect())
}

fn parse_ok_response(bytes: &[u8]) -> Result<(), String> {
    let envelope: ApiEnvelope<Value> = serde_json::from_slice(bytes)
        .map_err(|error| format!("解析 sendMessage 响应失败：{error}"))?;
    if envelope.ok {
        Ok(())
    } else {
        Err(envelope
            .description
            .unwrap_or_else(|| "Telegram API 返回 ok=false".to_string()))
    }
}

/// 非管理员在 [`dispatch`] 第一行就被挡下；这里是唯一的授权判断点。
///
/// 返回的字符串已经截断到 Telegram 上限；调用方直接 `sendMessage` 即可。
pub async fn dispatch(state: &AppState, config: &BotConfig, chat_id: &str, text: &str) -> String {
    // ---- 授权闸门：必须最先执行，且在任何 repo / DB 访问之前 ----
    if !config.is_admin(chat_id) {
        // 只回一句固定文案：不读库，所以不可能带出任何数据。
        return UNAUTHORIZED.to_string();
    }

    let reply = match parse_command(text) {
        Some(BotCommand::Status) => status_text(state).await,
        Some(BotCommand::Servers) => servers_text(state).await,
        Some(BotCommand::User(name)) => user_text(state, &name).await,
        Some(BotCommand::Chain) => chain_text(state).await,
        Some(BotCommand::Help) | None => help_text(),
    };
    truncate_message(&reply)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum BotCommand {
    Status,
    Servers,
    User(String),
    Chain,
    Help,
}

/// 解析命令：大小写不敏感，支持群聊里的 `/status@botname` 写法。
/// 非法命令返回 `None`，由调用方回 `/help`。
fn parse_command(text: &str) -> Option<BotCommand> {
    let mut parts = text.split_whitespace();
    let raw = parts.next()?;
    let name = raw
        .split_once('@')
        .map(|(name, _)| name)
        .unwrap_or(raw)
        .to_ascii_lowercase();
    match name.as_str() {
        "/status" => Some(BotCommand::Status),
        "/servers" => Some(BotCommand::Servers),
        "/user" => Some(BotCommand::User(
            parts.next().unwrap_or_default().trim().to_string(),
        )),
        "/chain" => Some(BotCommand::Chain),
        "/help" => Some(BotCommand::Help),
        _ => None,
    }
}

fn help_text() -> String {
    [
        "PierWave 管理员命令 / Admin commands:",
        "/status  状态 / status",
        "/servers 服务器 / servers",
        "/user <名> 用户 / user",
        "/chain   转发链 / chains",
        "/help    帮助 / help",
    ]
    .join("\n")
}

async fn status_text(state: &AppState) -> String {
    let now = repo::now();
    let overview = match repo::stats::overview(&state.db.pool, now).await {
        Ok(overview) => overview,
        Err(error) => {
            tracing::warn!(error = %error, "管理员 Bot 读取 overview 失败");
            return "读取状态失败，请稍后再试 / failed to load status, please try again later"
                .to_string();
        }
    };
    let nodes = match repo::nodes::count(&state.db.pool).await {
        Ok(count) => count,
        Err(error) => {
            tracing::warn!(error = %error, "管理员 Bot 读取节点数失败");
            0
        }
    };
    format!(
        "PierWave 状态 / Status\n\
         服务器在线 / Servers online: {}/{}\n\
         节点 / Nodes: {}\n\
         今日流量 / Traffic today: {}\n\
         告警 / Alerts: 离线 / offline {}，到期 / expired {}，超量 / exhausted {}，证书 / certs {}",
        overview.servers.online,
        overview.servers.total,
        nodes,
        format_bytes(overview.traffic.today_bytes),
        overview.alerts.offline_servers,
        overview.alerts.expired_instances,
        overview.alerts.exhausted_instances,
        overview.alerts.expiring_certs,
    )
}

async fn servers_text(state: &AppState) -> String {
    let servers = match repo::servers::list(&state.db.pool).await {
        Ok(servers) => servers,
        Err(error) => {
            tracing::warn!(error = %error, "管理员 Bot 读取服务器列表失败");
            return "读取服务器失败，请稍后再试 / failed to load servers, please try again later"
                .to_string();
        }
    };
    let total = servers.len();
    let mut lines = vec![format!("服务器 / Servers: {total} 台 / total")];
    if total == 0 {
        lines.push("暂无服务器 / no servers".to_string());
        return lines.join("\n");
    }
    for server in servers.iter().take(MAX_SERVER_ROWS) {
        let status = if server.status == "online" {
            "在线 / online"
        } else {
            "离线 / offline"
        };
        let load = server
            .load1
            .map(|value| format!("{value:.2}"))
            .unwrap_or_else(|| "-".to_string());
        let latency = server
            .latency_ms
            .map(|value| format!("{value}ms"))
            .unwrap_or_else(|| "-".to_string());
        lines.push(format!(
            "- {}: {} | 负载 / load {} | 延迟 / latency {}",
            server.name, status, load, latency
        ));
    }
    if total > MAX_SERVER_ROWS {
        lines.push(format!(
            "仅显示前 {MAX_SERVER_ROWS} 台 / showing first {MAX_SERVER_ROWS}"
        ));
    }
    lines.join("\n")
}

async fn user_text(state: &AppState, username: &str) -> String {
    let username = username.trim();
    if username.is_empty() {
        return "用法 / usage: /user <用户名 / username>".to_string();
    }
    let user = match repo::users::find_by_username(&state.db.pool, username).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return format!("用户不存在 / User not found: {username}");
        }
        Err(error) => {
            tracing::warn!(error = %error, "管理员 Bot 查询用户失败");
            return "读取用户失败，请稍后再试 / failed to load user, please try again later"
                .to_string();
        }
    };
    let view = match repo::users::view_by_id(&state.db.pool, &user.id).await {
        Ok(Some(view)) => view,
        Ok(None) => return format!("用户不存在 / User not found: {username}"),
        Err(error) => {
            tracing::warn!(error = %error, "管理员 Bot 读取用户详情失败");
            return "读取用户失败，请稍后再试 / failed to load user, please try again later"
                .to_string();
        }
    };

    let mut lines = vec![
        format!("用户 / User: {}", view.username),
        format!("状态 / Status: {}", status_label(&view.status)),
        format!(
            "账户用量 / Account usage: {}/{}",
            format_bytes(view.used_bytes),
            quota_label(view.quota_bytes)
        ),
        "套餐 / Packages:".to_string(),
    ];
    if view.packages.is_empty() {
        lines.push("暂无套餐 / no package".to_string());
    }
    for package in &view.packages {
        let expires = package
            .expires_at
            .map(time::business_date)
            .unwrap_or_else(|| "不过期 / never".to_string());
        lines.push(format!(
            "- {}: 已用/总量 / used/total {}/{} | 到期 / expires {} | 状态 / status {}",
            package.package_name,
            format_bytes(package.used_bytes),
            quota_label(package.quota_bytes),
            expires,
            status_label(&package.status),
        ));
    }
    lines.join("\n")
}

async fn chain_text(state: &AppState) -> String {
    let chains_list = match repo::chains::list(&state.db.pool).await {
        Ok(chains) => chains,
        Err(error) => {
            tracing::warn!(error = %error, "管理员 Bot 读取转发链失败");
            return "读取转发链失败，请稍后再试 / failed to load chains, please try again later"
                .to_string();
        }
    };
    if chains_list.is_empty() {
        return "转发链 / Chains: 0\n暂无转发链 / no chains".to_string();
    }

    // 状态来自心跳写入的 forward_status；按 server 去重后一次拉全。
    let mut server_ids: Vec<String> = Vec::new();
    for chain in &chains_list {
        for member in chain.groups.iter().flat_map(|group| group.members.iter()) {
            if !server_ids.iter().any(|id| id == &member.server_id) {
                server_ids.push(member.server_id.clone());
            }
        }
    }
    let mut statuses = HashMap::new();
    for server_id in &server_ids {
        match repo::forwards::list_status_by_server(&state.db.pool, server_id).await {
            Ok(rows) => {
                for row in rows {
                    statuses.insert(row.forward_id.clone(), row);
                }
            }
            Err(error) => {
                // 单台服务器的状态读不到不影响其它链的展示。
                tracing::warn!(server_id = %server_id, error = %error, "管理员 Bot 读取转发状态失败");
            }
        }
    }

    let mut lines = vec![format!("转发链 / Chains: {}", chains_list.len())];
    for chain in &chains_list {
        let groups = chain.groups.len();
        let members: usize = chain.groups.iter().map(|group| group.members.len()).sum();
        let degraded = chain.groups.iter().any(|group| {
            group.members.iter().any(|member| {
                let forward_id = chains::forward_id(
                    &chain.chain.id,
                    group.group.seq,
                    &member.server_id,
                    group.members.len(),
                );
                statuses
                    .get(&forward_id)
                    .is_some_and(|row| chains::is_degraded(row.target_fail_count))
            })
        });
        let state_label = if degraded {
            "降级 / degraded"
        } else {
            "正常 / healthy"
        };
        let enabled = if chain.chain.enabled {
            ""
        } else {
            " | 已停用 / disabled"
        };
        lines.push(format!(
            "- {}: 组 / groups {groups} | 成员 / members {members} | {state_label}{enabled}",
            chain.chain.name
        ));
    }
    lines.join("\n")
}

fn status_label(status: &str) -> &'static str {
    match status {
        "active" => "正常 / active",
        "expired" => "已过期 / expired",
        "exhausted" => "已超量 / exhausted",
        "disabled" => "已停用 / disabled",
        _ => "未知 / unknown",
    }
}

fn quota_label(quota: Option<i64>) -> String {
    match quota {
        None | Some(0) => "不限 / unlimited".to_string(),
        Some(bytes) => format_bytes(bytes),
    }
}

/// 二进制单位；负数按 0 处理（数据库异常时不要把负数发给用户）。
pub fn format_bytes(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let bytes = bytes.max(0);
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// 超过 Telegram 上限时按字符（不是字节）截断，并把「已截断」算进上限。
pub fn truncate_message(text: &str) -> String {
    if text.chars().count() <= MAX_MESSAGE_CHARS {
        return text.to_string();
    }
    let keep = MAX_MESSAGE_CHARS - TRUNCATED_SUFFIX.chars().count();
    let mut out: String = text.chars().take(keep).collect();
    out.push_str(TRUNCATED_SUFFIX);
    out
}

/// 从设置表推导出应运行的 Bot 配置；`None` = 当前不应有长轮询任务。
async fn desired_config(state: &AppState) -> Option<BotConfig> {
    let settings = settings::load(&state.db.pool).await;
    if !settings.telegram_bot_enabled {
        return None;
    }
    if settings.telegram_bot_token.is_empty() {
        return None;
    }
    let admin_chat_ids = settings::parse_telegram_admin_chat_ids(&settings.telegram_admin_chat_ids)
        .unwrap_or_default();
    if admin_chat_ids.is_empty() {
        return None;
    }
    Some(BotConfig {
        token: settings.telegram_bot_token,
        admin_chat_ids,
    })
}

struct RunningBot {
    config: BotConfig,
    handle: JoinHandle<()>,
}

impl RunningBot {
    async fn stop(mut self) {
        self.handle.abort();
        let _ = (&mut self.handle).await;
    }
}

impl Drop for RunningBot {
    fn drop(&mut self) {
        // supervisor 自己被 abort 时也要带走长轮询任务。
        self.handle.abort();
    }
}

/// 主控启动时调用：起一个 supervisor，配置变化时自动停/启长轮询。
pub fn spawn(state: AppState) -> JoinHandle<()> {
    spawn_with(state, Arc::new(CurlTransport::default()), CONFIG_REFRESH)
}

fn spawn_with(
    state: AppState,
    transport: Arc<dyn TelegramTransport>,
    refresh: Duration,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let offset = Arc::new(AtomicI64::new(0));
        let mut running: Option<RunningBot> = None;
        loop {
            let desired = desired_config(&state).await;
            let changed = match (&running, &desired) {
                (None, None) => false,
                (Some(_), None) | (None, Some(_)) => true,
                (Some(running), Some(desired)) => running.config != *desired,
            };
            if changed {
                if let Some(running) = running.take() {
                    running.stop().await;
                }
                if let Some(config) = desired {
                    let handle = tokio::spawn(poll_loop(
                        state.clone(),
                        transport.clone(),
                        config.clone(),
                        offset.clone(),
                    ));
                    running = Some(RunningBot { config, handle });
                }
            }
            tokio::time::sleep(refresh).await;
        }
    })
}

async fn poll_loop(
    state: AppState,
    transport: Arc<dyn TelegramTransport>,
    config: BotConfig,
    offset: Arc<AtomicI64>,
) {
    loop {
        let current = offset.load(Ordering::Relaxed);
        match transport
            .get_updates(&config.token, current, POLL_TIMEOUT_SECS)
            .await
        {
            Ok(updates) => {
                for update in updates {
                    // 先推进 offset 再处理：处理失败也不会重复拉同一条更新。
                    // offset 只在内存里，重启后可能重复处理最后一条命令（可接受）。
                    offset.store(update.update_id.saturating_add(1), Ordering::Relaxed);
                    let Some(message) = update.message else {
                        continue;
                    };
                    let reply = dispatch(&state, &config, &message.chat_id, &message.text).await;
                    if let Err(error) = transport
                        .send_message(&config.token, &message.chat_id, &reply)
                        .await
                    {
                        tracing::warn!(error = %error, "管理员 Bot sendMessage 失败");
                    }
                }
            }
            Err(error) => {
                tracing::warn!(error = %error, "管理员 Bot getUpdates 失败");
                // token 错误 / 网络中断时不要打爆 Telegram API。
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::VecDeque;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    use pierwave_domain::models::Package;
    use pierwave_domain::repo::{
        chains as chains_repo, nodes as nodes_repo, packages as packages_repo,
        servers as servers_repo, user_packages as user_packages_repo, users as users_repo,
    };
    use pierwave_domain::{chains as chain_rules, time, Db};

    const TOKEN: &str = "123456:ABC-def_ghi";
    const ADMIN_CHAT: &str = "42";

    #[derive(Default)]
    struct FakeTransport {
        queued: Mutex<VecDeque<Vec<IncomingUpdate>>>,
        sent: Mutex<Vec<(String, String)>>,
        polls: AtomicUsize,
    }

    impl FakeTransport {
        fn push(&self, updates: Vec<IncomingUpdate>) {
            self.queued
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push_back(updates);
        }

        fn sent(&self) -> Vec<(String, String)> {
            self.sent
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }

        fn polls(&self) -> usize {
            self.polls.load(Ordering::Relaxed)
        }
    }

    impl TelegramTransport for FakeTransport {
        fn get_updates<'a>(
            &'a self,
            _token: &'a str,
            _offset: i64,
            _timeout_secs: u64,
        ) -> TransportFuture<'a, Vec<IncomingUpdate>> {
            Box::pin(async move {
                self.polls.fetch_add(1, Ordering::Relaxed);
                let next = self
                    .queued
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .pop_front();
                match next {
                    Some(updates) => Ok(updates),
                    None => {
                        // 避免空队列时把测试跑成忙循环。
                        tokio::time::sleep(Duration::from_millis(5)).await;
                        Ok(Vec::new())
                    }
                }
            })
        }

        fn send_message<'a>(
            &'a self,
            _token: &'a str,
            chat_id: &'a str,
            text: &'a str,
        ) -> TransportFuture<'a, ()> {
            Box::pin(async move {
                self.sent
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push((chat_id.to_string(), text.to_string()));
                Ok(())
            })
        }
    }

    async fn setup() -> (AppState, Arc<FakeTransport>) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let transport = Arc::new(FakeTransport::default());
        (AppState::new(db, "web/dist"), transport)
    }

    fn config() -> BotConfig {
        BotConfig {
            token: TOKEN.to_string(),
            admin_chat_ids: vec![ADMIN_CHAT.to_string()],
        }
    }

    async fn set_setting(state: &AppState, key: &str, value: &str) {
        repo::settings::set(&state.db.pool, key, value)
            .await
            .unwrap();
    }

    async fn enable_bot(state: &AppState) {
        set_setting(state, settings::TELEGRAM_BOT_TOKEN_KEY, TOKEN).await;
        set_setting(state, settings::TELEGRAM_ADMIN_CHAT_IDS_KEY, ADMIN_CHAT).await;
        set_setting(state, settings::TELEGRAM_BOT_ENABLED_KEY, "1").await;
    }

    /// 两台服务器（1 在线 + 负载/延迟，1 离线）、一个节点、今日流量。
    async fn seed_status(state: &AppState) -> String {
        let (online, _) = servers_repo::create(&state.db.pool, "hk-1", "10.0.0.1", "external")
            .await
            .unwrap();
        let health = servers_repo::HealthSnapshot {
            arch: "x86_64".into(),
            xray_running: true,
            nginx_running: true,
            load1: 0.42,
            mem_used: 0,
            mem_total: 0,
            disk_used: 0,
            disk_total: 0,
            uptime_secs: 0,
            latency_ms: Some(23),
            ..Default::default()
        };
        servers_repo::update_health(&state.db.pool, &online.id, "0.6.0", &health)
            .await
            .unwrap();
        servers_repo::create(&state.db.pool, "jp-1", "10.0.0.2", "external")
            .await
            .unwrap();

        nodes_repo::create(
            &state.db.pool,
            &online.id,
            nodes_repo::NewNode {
                tag: Some("hk-1".into()),
                name: "HK".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "none".into(),
                port: 443,
                config_json: "{}".into(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();

        let today = time::business_date(time::now());
        repo::traffic::accumulate_daily(
            &state.db.pool,
            &today,
            &online.id,
            "alice",
            1_500_000,
            0,
            1_500_000,
        )
        .await
        .unwrap();
        online.id
    }

    async fn seed_user_with_package(state: &AppState) -> String {
        let user = users_repo::create(
            &state.db.pool,
            users_repo::NewUser {
                username: "alice".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: Some(10 * 1024 * 1024 * 1024),
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let package: Package = packages_repo::create(
            &state.db.pool,
            packages_repo::NewPackage {
                name: "月卡".into(),
                quota_bytes: Some(10 * 1024 * 1024 * 1024),
                period_days: Some(30),
                direction: "both".into(),
                node_ratio: 1.0,
                speed_limit_kbps: None,
                rule_template_id: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        let instance = user_packages_repo::create(
            &state.db.pool,
            &user.id,
            user_packages_repo::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: Some(time::now() + 30 * 24 * 3600),
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap();
        user_packages_repo::set_used_bytes(&state.db.pool, &instance.id, 3 * 1024 * 1024 * 1024)
            .await
            .unwrap();
        user.id
    }

    #[tokio::test]
    async fn unauthorized_chat_gets_no_data() {
        let (state, _transport) = setup().await;
        seed_user_with_package(&state).await;

        for command in ["/status", "/servers", "/user alice", "/chain", "/help"] {
            let reply = dispatch(&state, &config(), "999", command).await;
            assert_eq!(reply, UNAUTHORIZED, "非管理员只能看到固定文案：{command}");
            assert!(!reply.contains("alice"), "不能泄露用户名：{reply}");
            assert!(!reply.contains("月卡"), "不能泄露套餐：{reply}");
        }
    }

    #[tokio::test]
    async fn status_contains_servers_nodes_traffic_and_alerts() {
        let (state, _transport) = setup().await;
        seed_status(&state).await;

        let reply = dispatch(&state, &config(), ADMIN_CHAT, "/status").await;
        assert!(
            reply.contains("服务器在线 / Servers online: 1/2"),
            "{reply}"
        );
        assert!(reply.contains("节点 / Nodes: 1"), "{reply}");
        assert!(
            reply.contains("今日流量 / Traffic today: 1.4 MiB"),
            "{reply}"
        );
        assert!(reply.contains("告警 / Alerts"), "{reply}");
    }

    #[tokio::test]
    async fn servers_lists_name_status_load_and_latency() {
        let (state, _transport) = setup().await;
        seed_status(&state).await;

        let reply = dispatch(&state, &config(), ADMIN_CHAT, "/servers").await;
        assert!(reply.contains("服务器 / Servers: 2"), "{reply}");
        assert!(reply.contains("hk-1"), "{reply}");
        assert!(reply.contains("jp-1"), "{reply}");
        assert!(reply.contains("在线 / online"), "{reply}");
        assert!(reply.contains("离线 / offline"), "{reply}");
        assert!(reply.contains("负载 / load 0.42"), "{reply}");
        assert!(reply.contains("延迟 / latency 23ms"), "{reply}");
    }

    #[tokio::test]
    async fn user_shows_package_usage_expiry_and_status() {
        let (state, _transport) = setup().await;
        seed_user_with_package(&state).await;

        let reply = dispatch(&state, &config(), ADMIN_CHAT, "/user alice").await;
        assert!(reply.contains("用户 / User: alice"), "{reply}");
        assert!(reply.contains("月卡"), "{reply}");
        assert!(
            reply.contains("已用/总量 / used/total 3.0 GiB/10.0 GiB"),
            "{reply}"
        );
        assert!(reply.contains("到期 / expires"), "{reply}");
        assert!(reply.contains("状态 / status 正常 / active"), "{reply}");
    }

    #[tokio::test]
    async fn missing_user_gets_a_friendly_message() {
        let (state, _transport) = setup().await;

        let reply = dispatch(&state, &config(), ADMIN_CHAT, "/user ghost").await;
        assert!(
            reply.contains("用户不存在 / User not found: ghost"),
            "{reply}"
        );
        assert!(!reply.contains("failed"), "不要暴露内部错误：{reply}");
    }

    #[tokio::test]
    async fn chain_shows_groups_members_and_health() {
        let (state, _transport) = setup().await;
        let server_id = seed_status(&state).await;
        let server = servers_repo::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();

        chains_repo::create(
            &state.db.pool,
            chains_repo::NewChain {
                name: "hk-to-jp".into(),
                target_host: "example.test".into(),
                target_port: 443,
                enabled: true,
                engine: "native".into(),
                udp: false,
                groups: vec![chains_repo::NewChainGroup {
                    name: None,
                    strategy: chain_rules::GroupStrategy::RoundRobin.as_str().to_string(),
                    members: vec![chains_repo::NewChainGroupMember {
                        server_id: server.id.clone(),
                        listen_port: 8443,
                        priority: 0,
                        weight: 1,
                    }],
                }],
            },
        )
        .await
        .unwrap();

        let reply = dispatch(&state, &config(), ADMIN_CHAT, "/chain").await;
        assert!(reply.contains("转发链 / Chains: 1"), "{reply}");
        assert!(reply.contains("hk-to-jp"), "{reply}");
        assert!(reply.contains("组 / groups 1"), "{reply}");
        assert!(reply.contains("成员 / members 1"), "{reply}");
        assert!(reply.contains("正常 / healthy"), "{reply}");
    }

    #[tokio::test]
    async fn unknown_command_falls_back_to_help() {
        let (state, _transport) = setup().await;

        let reply = dispatch(&state, &config(), ADMIN_CHAT, "/rm -rf /").await;
        assert_eq!(reply, help_text(), "非法命令必须回 /help");
        assert!(reply.contains("/status"), "{reply}");
        assert!(reply.contains("/user"), "{reply}");
    }

    #[test]
    fn long_messages_are_truncated_to_the_telegram_limit() {
        let reply = truncate_message(&"x".repeat(5000));
        assert_eq!(reply.chars().count(), MAX_MESSAGE_CHARS);
        assert!(reply.ends_with(TRUNCATED_SUFFIX), "{reply}");
        assert!(reply.contains("已截断"));

        let short = "ok";
        assert_eq!(truncate_message(short), short);
    }

    #[test]
    fn token_stays_out_of_argv() {
        let config = build_get_updates_config(TOKEN, 7, POLL_TIMEOUT_SECS);
        assert!(config.contains(TOKEN), "token 必须在 stdin 配置里");
        assert!(config.contains("timeout=30"));
        assert!(config.contains("offset=7"));
        assert!(config.contains("allowed_updates"));
        assert!(
            !CURL_ARGS.iter().any(|arg| arg.contains(TOKEN)),
            "token 不能出现在 argv：{CURL_ARGS:?}"
        );

        let send = build_send_message_config(TOKEN, ADMIN_CHAT, "你好\n/status");
        assert!(send.contains(TOKEN));
        assert!(send.contains("chat_id=42"));
        assert!(send.contains("你好\\n/status"), "换行要被 curl config 转义");
        assert!(
            !CURL_ARGS.iter().any(|arg| arg.contains(TOKEN)),
            "token 不能出现在 argv：{CURL_ARGS:?}"
        );
    }

    #[test]
    fn updates_response_parses_text_and_non_text_updates() {
        let raw = br#"{
            "ok": true,
            "result": [
                {"update_id": 10, "message": {"chat": {"id": -100123}, "text": "/status"}},
                {"update_id": 11, "message": {"chat": {"id": 42}}},
                {"update_id": 12}
            ]
        }"#;
        let updates = parse_updates_response(raw).unwrap();
        assert_eq!(updates.len(), 3);
        assert_eq!(
            updates[0].message,
            Some(IncomingMessage {
                chat_id: "-100123".into(),
                text: "/status".into()
            })
        );
        assert!(updates[1].message.is_none());
        assert!(updates[2].message.is_none());
        assert_eq!(updates[2].update_id, 12);

        let failed = br#"{"ok": false, "description": "Unauthorized"}"#;
        assert!(parse_updates_response(failed)
            .unwrap_err()
            .contains("Unauthorized"));
    }

    #[tokio::test]
    async fn disabled_setting_stops_polling_and_processing() {
        let (state, transport) = setup().await;
        enable_bot(&state).await;
        transport.push(vec![IncomingUpdate {
            update_id: 1,
            message: Some(IncomingMessage {
                chat_id: ADMIN_CHAT.into(),
                text: "/status".into(),
            }),
        }]);

        let handle = spawn_with(state.clone(), transport.clone(), Duration::from_millis(10));

        // 等到第一条命令被处理。
        for _ in 0..200 {
            if !transport.sent().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(transport.sent().len(), 1, "启用时应处理命令");
        let reply = &transport.sent()[0].1;
        assert!(reply.contains("PierWave 状态"), "{reply}");

        // 关掉开关：supervisor 下一轮对账应中止长轮询。
        set_setting(&state, settings::TELEGRAM_BOT_ENABLED_KEY, "0").await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let polls_after_disable = transport.polls();
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(
            transport.polls(),
            polls_after_disable,
            "enabled=false 后不应再轮询"
        );
        assert_eq!(transport.sent().len(), 1, "enabled=false 后不应再回复");

        handle.abort();
    }

    #[tokio::test]
    async fn enabled_but_unconfigured_does_not_poll() {
        let (state, _transport) = setup().await;
        set_setting(&state, settings::TELEGRAM_BOT_ENABLED_KEY, "1").await;
        assert!(desired_config(&state).await.is_none(), "缺 token 不应启动");

        set_setting(&state, settings::TELEGRAM_BOT_TOKEN_KEY, TOKEN).await;
        assert!(
            desired_config(&state).await.is_none(),
            "缺管理员列表不应启动"
        );

        set_setting(&state, settings::TELEGRAM_ADMIN_CHAT_IDS_KEY, ADMIN_CHAT).await;
        let desired = desired_config(&state).await.unwrap();
        assert_eq!(desired.admin_chat_ids, vec![ADMIN_CHAT.to_string()]);
    }
}
