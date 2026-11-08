//! 告警通知：Telegram + Webhook。
//!
//! 设计要点：
//! * 只做「进程内」去抖：`HashMap<(kind, target_id), Instant>`。主控重启后丢失
//!   冷却状态是可接受的——重启只可能让一条告警多发一次，不会漏发；
//!   反过来把冷却状态落库会引入一次额外的写事务，对「通知」这种旁路功能不值得。
//! * 投递走系统 `curl` 子进程，不引入 HTTP 客户端依赖。Telegram bot token
//!   嵌在 URL 里，因此 URL、chat_id、消息正文全部通过 `--config -` 从 stdin
//!   传入，不进 argv：`ps` / `/proc/*/cmdline` 对同机其它用户可见。
//! * 投递失败只 `tracing::warn!`，并且投递本身跑在独立任务里：一个卡住的
//!   Webhook 不能拖慢 WS 读循环、心跳或断流 worker。
//! * 未配置任何渠道时直接返回（no-op）；`alert_events` 关掉的事件也不发。

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use pierwave_domain::time;

use crate::routes::settings::{self, Settings};
use crate::state::AppState;

/// 告警事件类型；名字与设置项 `alert_events` 里的逗号分隔项一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AlertKind {
    ServerOffline,
    UserExhausted,
    ChainDegraded,
    UpgradeFailed,
}

impl AlertKind {
    pub const ALL: [AlertKind; 4] = [
        AlertKind::ServerOffline,
        AlertKind::UserExhausted,
        AlertKind::ChainDegraded,
        AlertKind::UpgradeFailed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            AlertKind::ServerOffline => "server_offline",
            AlertKind::UserExhausted => "user_exhausted",
            AlertKind::ChainDegraded => "chain_degraded",
            AlertKind::UpgradeFailed => "upgrade_failed",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == name.trim())
    }
}

/// 解析 `alert_events`：逗号分隔，空项忽略，重复项去重，未知名字报错。
pub fn parse_alert_events(raw: &str) -> Result<Vec<AlertKind>, String> {
    let mut kinds = Vec::new();
    for part in raw.split(',') {
        let name = part.trim();
        if name.is_empty() {
            continue;
        }
        let kind = AlertKind::from_name(name)
            .ok_or_else(|| format!("未知的告警事件：{name}（可用：server_offline,user_exhausted,chain_degraded,upgrade_failed）"))?;
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    Ok(kinds)
}

/// 规范化后的 `alert_events` 存储值（去重、固定顺序、无多余空格）。
pub fn format_alert_events(kinds: &[AlertKind]) -> String {
    let mut ordered = Vec::new();
    for kind in AlertKind::ALL {
        if kinds.contains(&kind) {
            ordered.push(kind.as_str());
        }
    }
    ordered.join(",")
}

/// 已配置的投递渠道。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Telegram,
    Webhook,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Telegram => "telegram",
            Channel::Webhook => "webhook",
        }
    }
}

/// 一次投递所需的全部内容；由 [`AlertTransport`] 决定怎么发。
pub struct OutgoingAlert<'a> {
    pub channel: Channel,
    /// Telegram 专用；webhook 忽略。
    pub chat_id: &'a str,
    /// Telegram 的 `sendMessage` 地址或 webhook 目标地址。
    pub url: &'a str,
    pub kind: &'a str,
    pub target: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub at: i64,
}

pub type DeliveryFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

/// 投递抽象：生产是 curl，测试注入记录型实现（绝不联网）。
pub trait AlertTransport: Send + Sync {
    fn send<'a>(&'a self, alert: OutgoingAlert<'a>) -> DeliveryFuture<'a>;
}

/// curl 投递器。
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

/// curl 参数里没有任何秘密：token、chat_id、URL、正文都在 stdin 的 config 里。
pub const CURL_ARGS: &[&str] = &[
    "--silent",
    "--show-error",
    "--fail",
    "--proto",
    "=http,https",
    "--connect-timeout",
    "5",
    "--max-time",
    "15",
    "--config",
    "-",
];

impl AlertTransport for CurlTransport {
    fn send<'a>(&'a self, alert: OutgoingAlert<'a>) -> DeliveryFuture<'a> {
        Box::pin(async move {
            let config = build_curl_config(&alert);
            let mut child = Command::new(&self.program)
                .args(CURL_ARGS)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|error| format!("无法执行 `{}`：{error}", self.program))?;

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
                return Ok(());
            }
            let detail = String::from_utf8_lossy(&output.stderr);
            let detail = detail.trim();
            let detail: String = detail.chars().take(300).collect();
            if detail.is_empty() {
                Err(format!("curl 退出码 {:?}", output.status.code()))
            } else {
                Err(format!("curl 退出码 {:?}：{detail}", output.status.code()))
            }
        })
    }
}

/// curl 的 `--config` 内容。Telegram 用 `data-urlencode` 让 curl 负责转义，
/// webhook 用 JSON 正文。所有值都做 curl 配置字符串转义。
pub fn build_curl_config(alert: &OutgoingAlert<'_>) -> String {
    match alert.channel {
        Channel::Telegram => {
            let text = format!("{}\n\n{}", alert.title, alert.body);
            format!(
                "url = \"{}\"\ndata-urlencode = \"chat_id={}\"\ndata-urlencode = \"text={}\"\n",
                escape_curl_config(alert.url),
                escape_curl_config(alert.chat_id),
                escape_curl_config(&text),
            )
        }
        Channel::Webhook => {
            let payload = json!({
                "kind": alert.kind,
                "target": alert.target,
                "title": alert.title,
                "body": alert.body,
                "at": alert.at,
            })
            .to_string();
            format!(
                "url = \"{}\"\nheader = \"Content-Type: application/json\"\ndata = \"{}\"\n",
                escape_curl_config(alert.url),
                escape_curl_config(&payload),
            )
        }
    }
}

/// curl 配置里的双引号字符串需要转义反斜杠、双引号与换行。
fn escape_curl_config(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// 进程内去抖状态 + 可注入的投递器。
///
/// 去抖状态放在 [`AppState`] 里（而不是全局静态变量）：测试之间互不污染，
/// 也符合「进程重启后丢失可接受」的取舍。
#[derive(Clone)]
pub struct Alerts {
    debounce: Arc<Mutex<HashMap<(AlertKind, String), Instant>>>,
    transport: Arc<dyn AlertTransport>,
}

impl Default for Alerts {
    fn default() -> Self {
        Self::new(Arc::new(CurlTransport::default()))
    }
}

impl Alerts {
    pub fn new(transport: Arc<dyn AlertTransport>) -> Self {
        Self {
            debounce: Arc::new(Mutex::new(HashMap::new())),
            transport,
        }
    }

    /// 冷却窗口内已发过同 (kind, target) 时返回 `false`。
    ///
    /// 先记录再投递：投递失败也不应在冷却期内反复重试，否则对面挂掉时
    /// 每个心跳都会再打一次。
    fn allow(&self, kind: AlertKind, target: &str, cooldown: Duration) -> bool {
        if cooldown.is_zero() {
            return true;
        }
        let now = Instant::now();
        let mut seen = self
            .debounce
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if seen
            .get(&(kind, target.to_string()))
            .is_some_and(|at| now.saturating_duration_since(*at) < cooldown)
        {
            return false;
        }
        // 目标对象会增删，长时间运行后 map 需要收敛；超过阈值时清掉过期项。
        if seen.len() >= 1024 {
            seen.retain(|_, at| now.saturating_duration_since(*at) < cooldown);
        }
        seen.insert((kind, target.to_string()), now);
        true
    }
}

/// 一个已配置渠道及其连接参数。
#[derive(Debug, Clone)]
struct ChannelConfig {
    channel: Channel,
    chat_id: String,
    url: String,
}

fn configured_channels(settings: &Settings) -> Vec<ChannelConfig> {
    let mut channels = Vec::new();
    if !settings.telegram_bot_token.is_empty() && !settings.telegram_chat_id.is_empty() {
        channels.push(ChannelConfig {
            channel: Channel::Telegram,
            chat_id: settings.telegram_chat_id.clone(),
            url: format!(
                "https://api.telegram.org/bot{}/sendMessage",
                settings.telegram_bot_token
            ),
        });
    }
    if !settings.webhook_url.is_empty() {
        channels.push(ChannelConfig {
            channel: Channel::Webhook,
            chat_id: String::new(),
            url: settings.webhook_url.clone(),
        });
    }
    channels
}

fn alert_enabled(settings: &Settings, kind: AlertKind) -> bool {
    parse_alert_events(&settings.alert_events)
        .map(|events| events.contains(&kind))
        .unwrap_or(false)
}

/// 发一条告警。任何失败都只 `warn`，不返回错误，也不阻塞调用方。
///
/// 去抖、开关判断在调用任务里同步完成；真正的网络投递丢到独立任务里。
pub async fn notify(state: &AppState, kind: AlertKind, target_id: &str, title: &str, body: &str) {
    let settings = settings::load(&state.db.pool).await;
    let channels = configured_channels(&settings);
    if channels.is_empty() {
        return;
    }
    if !alert_enabled(&settings, kind) {
        return;
    }
    let cooldown = u64::try_from(settings.alert_cooldown_secs).unwrap_or(0);
    if !state
        .alerts
        .allow(kind, target_id, Duration::from_secs(cooldown))
    {
        return;
    }

    let payload = OwnedPayload {
        kind: kind.as_str().to_string(),
        target: target_id.to_string(),
        title: title.to_string(),
        body: body.to_string(),
        at: time::now(),
    };
    let transport = state.alerts.transport.clone();
    // 网络投递与调用方解耦：curl 最坏要等到 max-time，不能卡住 WS/心跳/断流。
    tokio::spawn(async move {
        for channel in channels {
            let alert = OutgoingAlert {
                channel: channel.channel,
                chat_id: &channel.chat_id,
                url: &channel.url,
                kind: &payload.kind,
                target: &payload.target,
                title: &payload.title,
                body: &payload.body,
                at: payload.at,
            };
            if let Err(error) = transport.send(alert).await {
                tracing::warn!(
                    channel = channel.channel.as_str(),
                    kind = payload.kind,
                    target = payload.target,
                    error = %error,
                    "告警投递失败"
                );
            }
        }
    });
}

struct OwnedPayload {
    kind: String,
    target: String,
    title: String,
    body: String,
    at: i64,
}

/// 单个渠道的测试结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelResult {
    pub channel: Channel,
    pub ok: bool,
    pub error: Option<String>,
}

/// 测试接口的返回；`message` 只在没有任何渠道时出现。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestReport {
    pub configured: usize,
    pub results: Vec<ChannelResult>,
    pub message: Option<String>,
}

impl TestReport {
    pub fn as_json(&self) -> serde_json::Value {
        let results: Vec<serde_json::Value> = self
            .results
            .iter()
            .map(|result| {
                json!({
                    "channel": result.channel.as_str(),
                    "ok": result.ok,
                    "error": result.error,
                })
            })
            .collect();
        let mut body = json!({
            "configured": self.configured,
            "results": results,
        });
        if let Some(message) = &self.message {
            body["message"] = json!(message);
        }
        body
    }
}

/// 向所有已配置渠道各发一条测试消息；不进行去抖与 `alert_events` 过滤。
pub async fn test_delivery(state: &AppState) -> TestReport {
    let settings = settings::load(&state.db.pool).await;
    let channels = configured_channels(&settings);
    if channels.is_empty() {
        return TestReport {
            configured: 0,
            results: Vec::new(),
            message: Some(
                "未配置任何告警渠道：请填写 telegram_bot_token + telegram_chat_id 或 webhook_url / \
                 No alert channel configured"
                    .to_string(),
            ),
        };
    }

    let at = time::now();
    let title = "测试告警 / Test alert";
    let body = "这是一条来自 PierWave 的测试消息 / This is a test message from PierWave";
    let mut results = Vec::with_capacity(channels.len());
    for channel in &channels {
        let alert = OutgoingAlert {
            channel: channel.channel,
            chat_id: &channel.chat_id,
            url: &channel.url,
            kind: "test",
            target: "test",
            title,
            body,
            at,
        };
        let result =
            match tokio::time::timeout(Duration::from_secs(20), state.alerts.transport.send(alert))
                .await
            {
                Ok(Ok(())) => ChannelResult {
                    channel: channel.channel,
                    ok: true,
                    error: None,
                },
                Ok(Err(error)) => ChannelResult {
                    channel: channel.channel,
                    ok: false,
                    error: Some(error),
                },
                Err(_) => ChannelResult {
                    channel: channel.channel,
                    ok: false,
                    error: Some("投递超时".to_string()),
                },
            };
        results.push(result);
    }
    TestReport {
        configured: results.len(),
        results,
        message: None,
    }
}

// 供其它模块的测试复用：记录投递内容，绝不联网。
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedAlert {
    pub channel: Channel,
    pub kind: String,
    pub target: String,
    pub title: String,
    pub body: String,
    pub at: i64,
    pub chat_id: String,
    pub url: String,
}

#[cfg(test)]
#[derive(Clone, Default)]
pub struct RecordingTransport {
    sent: Arc<Mutex<Vec<RecordedAlert>>>,
    failing: Arc<Mutex<Vec<Channel>>>,
}

#[cfg(test)]
impl RecordingTransport {
    pub fn fail(&self, channel: Channel) {
        self.failing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(channel);
    }

    pub fn sent(&self) -> Vec<RecordedAlert> {
        self.sent
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// 等待至少 `expected` 条投递；投递在独立任务里，测试需要短暂等待。
    pub async fn wait_for(&self, expected: usize) -> Vec<RecordedAlert> {
        for _ in 0..500 {
            let sent = self.sent();
            if sent.len() >= expected {
                return sent;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let sent = self.sent();
        panic!(
            "等待告警投递超时：期望 {expected} 条，实际 {} 条",
            sent.len()
        );
    }

    /// 确认在 `window` 内没有新增投递。
    pub async fn assert_no_more(&self, expected: usize, window: Duration) {
        tokio::time::sleep(window).await;
        let sent = self.sent();
        assert_eq!(sent.len(), expected, "不应再有新的告警投递：{sent:?}");
    }
}

#[cfg(test)]
impl AlertTransport for RecordingTransport {
    fn send<'a>(&'a self, alert: OutgoingAlert<'a>) -> DeliveryFuture<'a> {
        Box::pin(async move {
            self.sent
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(RecordedAlert {
                    channel: alert.channel,
                    kind: alert.kind.to_string(),
                    target: alert.target.to_string(),
                    title: alert.title.to_string(),
                    body: alert.body.to_string(),
                    at: alert.at,
                    chat_id: alert.chat_id.to_string(),
                    url: alert.url.to_string(),
                });
            let failing = self
                .failing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains(&alert.channel);
            if failing {
                Err("模拟投递失败".to_string())
            } else {
                Ok(())
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use pierwave_domain::{repo, Db};

    const TOKEN: &str = "123456:ABC-def_ghi";
    const CHAT_ID: &str = "-1001234567890";
    const WEBHOOK: &str = "https://example.test/hooks/pierwave";

    async fn setup() -> (AppState, Arc<RecordingTransport>) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let transport = Arc::new(RecordingTransport::default());
        let mut state = AppState::new(db, "web/dist");
        state.alerts = Alerts::new(transport.clone());
        (state, transport)
    }

    async fn configure(state: &AppState, keys: &[(&str, &str)]) {
        for (key, value) in keys {
            repo::settings::set(&state.db.pool, key, value)
                .await
                .unwrap();
        }
    }

    async fn webhook_only(state: &AppState) {
        configure(
            state,
            &[
                ("webhook_url", WEBHOOK),
                (
                    "alert_events",
                    "server_offline,user_exhausted,chain_degraded,upgrade_failed",
                ),
                ("alert_cooldown_secs", "600"),
            ],
        )
        .await;
    }

    #[tokio::test]
    async fn same_kind_and_target_is_debounced_within_cooldown() {
        let (state, transport) = setup().await;
        webhook_only(&state).await;

        notify(
            &state,
            AlertKind::ServerOffline,
            "server-1",
            "offline",
            "down",
        )
        .await;
        transport.wait_for(1).await;
        notify(
            &state,
            AlertKind::ServerOffline,
            "server-1",
            "offline",
            "down again",
        )
        .await;
        transport
            .assert_no_more(1, Duration::from_millis(100))
            .await;
    }

    #[tokio::test]
    async fn different_targets_are_not_debounced_against_each_other() {
        let (state, transport) = setup().await;
        webhook_only(&state).await;

        notify(
            &state,
            AlertKind::ServerOffline,
            "server-1",
            "offline",
            "down",
        )
        .await;
        notify(
            &state,
            AlertKind::ServerOffline,
            "server-2",
            "offline",
            "down",
        )
        .await;

        let sent = transport.wait_for(2).await;
        let targets: Vec<&str> = sent.iter().map(|item| item.target.as_str()).collect();
        assert_eq!(targets, vec!["server-1", "server-2"]);
    }

    #[tokio::test]
    async fn zero_cooldown_sends_every_time() {
        let (state, transport) = setup().await;
        webhook_only(&state).await;
        configure(&state, &[("alert_cooldown_secs", "0")]).await;

        for _ in 0..2 {
            notify(
                &state,
                AlertKind::ServerOffline,
                "server-1",
                "offline",
                "down",
            )
            .await;
        }
        let sent = transport.wait_for(2).await;
        assert_eq!(sent.len(), 2, "冷却为 0 时不去抖");
    }

    #[tokio::test]
    async fn unconfigured_channels_are_noop() {
        let (state, transport) = setup().await;

        notify(
            &state,
            AlertKind::ServerOffline,
            "server-1",
            "offline",
            "down",
        )
        .await;
        transport
            .assert_no_more(0, Duration::from_millis(100))
            .await;
    }

    #[tokio::test]
    async fn telegram_only_uses_telegram() {
        let (state, transport) = setup().await;
        configure(
            &state,
            &[
                ("telegram_bot_token", TOKEN),
                ("telegram_chat_id", CHAT_ID),
                ("alert_events", "server_offline"),
                ("alert_cooldown_secs", "0"),
            ],
        )
        .await;

        notify(
            &state,
            AlertKind::ServerOffline,
            "server-1",
            "offline",
            "down",
        )
        .await;

        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].channel, Channel::Telegram);
        assert_eq!(sent[0].chat_id, CHAT_ID);
        assert!(sent[0].url.contains(TOKEN), "Telegram URL 必须带 token");
    }

    #[tokio::test]
    async fn webhook_only_uses_webhook() {
        let (state, transport) = setup().await;
        webhook_only(&state).await;

        notify(
            &state,
            AlertKind::ServerOffline,
            "server-1",
            "offline",
            "down",
        )
        .await;

        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].channel, Channel::Webhook);
        assert_eq!(sent[0].url, WEBHOOK);
    }

    #[tokio::test]
    async fn both_channels_are_delivered() {
        let (state, transport) = setup().await;
        webhook_only(&state).await;
        configure(
            &state,
            &[
                ("telegram_bot_token", TOKEN),
                ("telegram_chat_id", CHAT_ID),
                ("alert_cooldown_secs", "0"),
            ],
        )
        .await;

        notify(
            &state,
            AlertKind::ServerOffline,
            "server-1",
            "offline",
            "down",
        )
        .await;

        let sent = transport.wait_for(2).await;
        let channels: Vec<Channel> = sent.iter().map(|item| item.channel).collect();
        assert!(channels.contains(&Channel::Telegram));
        assert!(channels.contains(&Channel::Webhook));
    }

    #[tokio::test]
    async fn disabled_event_is_not_delivered() {
        let (state, transport) = setup().await;
        webhook_only(&state).await;
        configure(&state, &[("alert_events", "server_offline,chain_degraded")]).await;

        notify(
            &state,
            AlertKind::UserExhausted,
            "user-1",
            "exhausted",
            "quota",
        )
        .await;
        transport
            .assert_no_more(0, Duration::from_millis(100))
            .await;

        // 同一渠道下，开启的事件仍要发。
        notify(
            &state,
            AlertKind::ChainDegraded,
            "chain-1",
            "degraded",
            "hop down",
        )
        .await;
        transport.wait_for(1).await;
    }

    #[tokio::test]
    async fn test_report_without_channels_explains_why() {
        let (state, transport) = setup().await;

        let report = test_delivery(&state).await;
        assert_eq!(report.configured, 0);
        assert!(report.results.is_empty());
        let message = report.message.expect("无渠道时必须有提示");
        assert!(message.contains("未配置"), "{message}");
        transport.assert_no_more(0, Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn test_report_calls_every_configured_channel_and_reports_failures() {
        let (state, transport) = setup().await;
        webhook_only(&state).await;
        configure(
            &state,
            &[("telegram_bot_token", TOKEN), ("telegram_chat_id", CHAT_ID)],
        )
        .await;
        transport.fail(Channel::Webhook);

        let report = test_delivery(&state).await;
        assert_eq!(report.configured, 2);
        assert_eq!(report.results.len(), 2);
        assert!(report.message.is_none());

        let telegram = report
            .results
            .iter()
            .find(|result| result.channel == Channel::Telegram)
            .unwrap();
        assert!(telegram.ok, "Telegram 应成功：{telegram:?}");
        assert!(telegram.error.is_none());

        let webhook = report
            .results
            .iter()
            .find(|result| result.channel == Channel::Webhook)
            .unwrap();
        assert!(!webhook.ok);
        assert!(webhook
            .error
            .as_deref()
            .unwrap_or("")
            .contains("模拟投递失败"));

        let sent = transport.sent();
        assert_eq!(sent.len(), 2, "两个渠道各发一条");
        assert!(sent.iter().all(|item| item.kind == "test"));
    }

    #[test]
    fn event_names_round_trip_and_unknown_names_are_rejected() {
        assert_eq!(
            AlertKind::from_name("server_offline"),
            Some(AlertKind::ServerOffline)
        );
        assert_eq!(
            AlertKind::from_name("upgrade_failed"),
            Some(AlertKind::UpgradeFailed)
        );
        assert_eq!(AlertKind::from_name("nope"), None);

        let parsed =
            parse_alert_events(" server_offline, chain_degraded,server_offline, ").unwrap();
        assert_eq!(
            parsed,
            vec![AlertKind::ServerOffline, AlertKind::ChainDegraded]
        );
        assert_eq!(
            format_alert_events(&parsed),
            "server_offline,chain_degraded"
        );
        assert!(parse_alert_events("server_offline,wat").is_err());
        assert!(parse_alert_events("").unwrap().is_empty());
    }

    #[test]
    fn telegram_config_keeps_the_token_out_of_argv() {
        let url = format!("https://api.telegram.org/bot{TOKEN}/sendMessage");
        let alert = OutgoingAlert {
            channel: Channel::Telegram,
            chat_id: CHAT_ID,
            url: &url,
            kind: "server_offline",
            target: "server-1",
            title: "t",
            body: "b",
            at: 1,
        };
        let config = build_curl_config(&alert);
        assert!(config.contains(TOKEN), "token 必须在 stdin 配置里");
        assert!(config.contains(CHAT_ID));
        assert!(
            !CURL_ARGS.iter().any(|arg| arg.contains(TOKEN)),
            "token 不能出现在 argv：{CURL_ARGS:?}"
        );
    }

    #[test]
    fn webhook_config_is_json_with_expected_fields() {
        let alert = OutgoingAlert {
            channel: Channel::Webhook,
            chat_id: "",
            url: WEBHOOK,
            kind: "user_exhausted",
            target: "user-1",
            title: "alert-title",
            body: "alert-body",
            at: 42,
        };
        let config = build_curl_config(&alert);
        assert!(config.contains("url = \"https://example.test/hooks/pierwave\""));
        assert!(config.contains("Content-Type: application/json"));
        assert!(config.contains("\\\"kind\\\":\\\"user_exhausted\\\""));
        assert!(config.contains("\\\"target\\\":\\\"user-1\\\""));
        assert!(config.contains("\\\"title\\\":\\\"alert-title\\\""));
        assert!(config.contains("\\\"at\\\":42"));
    }

    #[test]
    fn escapes_curl_config_strings() {
        assert_eq!(escape_curl_config("abc"), "abc");
        assert_eq!(escape_curl_config(r#"a"b\c"#), r#"a\"b\\c"#);
        assert_eq!(escape_curl_config("a\nb"), "a\\nb");
    }
}
