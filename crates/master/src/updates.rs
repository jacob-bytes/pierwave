//! master / agent 版本更新检测：GitHub Releases 唯一版本源。
//!
//! 为什么只认 GitHub Releases：所有者已确认不做自建清单，GitHub 的
//! `releases/latest` 就是唯一真相。这里只做三件事：
//!
//! 1. 拉取并解析最新 Release（解析逻辑在 `pierwave_domain::updates`）；
//! 2. 把结果写库（失败也写，但保留上一次成功值）+ 内存缓存；
//! 3. 版本变化时通过现有告警渠道发一条（开关是 `alert_events` 里的
//!    `update_available` 事件），并把「已通知的版本」落库去重。
//!
//! 网络请求走系统 `curl` 子进程，与告警投递保持同一套取舍（不引入 HTTP
//! 客户端依赖），但**必须**带超时与 `User-Agent`——GitHub API 会拒绝没有
//! User-Agent 的请求。测试一律注入 [`StaticFetcher`]，绝不联网。

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use pierwave_domain::repo::updates::{AgentVersionCount, UpdateCheck};
use pierwave_domain::{repo, time, updates};

use crate::alerts::{event_enabled, AlertKind};
use crate::routes::settings;
use crate::state::AppState;

/// 默认每 6 小时检测一次；与设置项 `update_check_interval_hours` 的默认值一致。
pub const DEFAULT_INTERVAL_HOURS: i64 = 6;
/// 间隔下限：小于 1 小时会变成对 GitHub 的轮询风暴。
pub const MIN_INTERVAL_HOURS: i64 = 1;
/// 间隔上限：168 小时 = 7 天。
pub const MAX_INTERVAL_HOURS: i64 = 168;
/// 调度器的检查粒度：每分钟读一次设置，决定这一分钟是否到点。
pub const CHECK_TICK: Duration = Duration::from_secs(60);
/// 当前支持的 Agent 最低协议版本；低于它只支持 tcp / both。
pub const MIN_SUPPORTED_PROTOCOL: i64 = pierwave_proto::UDP_PROTOCOL_VERSION as i64;
/// curl 的硬超时：GitHub 正常几百毫秒，15 秒足够覆盖慢网。
const FETCH_MAX_TIME_SECS: &str = "15";
const FETCH_CONNECT_TIME_SECS: &str = "5";

/// 当前构建的 master 版本；`--version` 与侧栏显示的是同一个值。
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// 版本源地址：默认固定 GitHub Releases。
///
/// `PIERWAVE_UPDATE_LATEST_URL` 只给离线镜像与测试用（与 Agent 发布源的
/// `PIERWAVE_AGENT_LATEST_URL` 同一套约定）；生产不配置就是 GitHub。
pub fn latest_url_from_env() -> String {
    std::env::var("PIERWAVE_UPDATE_LATEST_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| updates::LATEST_RELEASE_URL.to_string())
}

pub type FetchFuture<'a> =
    Pin<Box<dyn Future<Output = Result<String, updates::UpdateError>> + Send + 'a>>;

/// 拉取版本源原文的抽象；测试注入固定响应，绝不联网。
pub trait ReleaseFetcher: Send + Sync {
    fn fetch<'a>(&'a self) -> FetchFuture<'a>;
}

/// 生产实现：http(s) 走 curl（带超时与 User-Agent），其它地址按本地文件读。
///
/// 本地文件分支只服务于 `PIERWAVE_UPDATE_LATEST_URL` 的离线/测试用法。
#[derive(Debug, Clone)]
pub struct CurlFetcher {
    pub url: String,
    /// curl 可执行文件；生产固定是 `curl`，测试注入假脚本以伪造超大输出。
    pub program: String,
}

impl Default for CurlFetcher {
    fn default() -> Self {
        Self {
            url: latest_url_from_env(),
            program: "curl".to_string(),
        }
    }
}

impl ReleaseFetcher for CurlFetcher {
    fn fetch<'a>(&'a self) -> FetchFuture<'a> {
        Box::pin(async move {
            let url = self.url.trim();
            if url.is_empty() {
                return Err(updates::UpdateError::Unavailable(
                    "未配置版本源 / release source is not configured".to_string(),
                ));
            }
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                let bytes = tokio::fs::read(url).await.map_err(|error| {
                    updates::UpdateError::Unavailable(truncate(&error.to_string()))
                })?;
                if crate::outbound::exceeded(bytes.len() as u64) {
                    return Err(updates::UpdateError::TooLarge {
                        limit_mib: crate::outbound::MAX_OUTBOUND_BODY_MIB,
                    });
                }
                return String::from_utf8(bytes).map_err(|error| {
                    updates::UpdateError::Unavailable(truncate(&error.to_string()))
                });
            }
            fetch_over_curl(&self.program, url).await
        })
    }
}

async fn fetch_over_curl(program: &str, url: &str) -> Result<String, updates::UpdateError> {
    let user_agent = format!("pierwave-master/{}", current_version());
    let max_filesize = crate::outbound::max_filesize_arg();
    // `-w '\n%{http_code}'`：body 写 stdout，最后一行追加 HTTP 状态码。
    // 不用 `-f`：HTTP 错误也要能看到状态码，才能给出「HTTP 404」这种可读原因。
    let output = tokio::process::Command::new(program)
        .args([
            "--silent",
            "--show-error",
            "--proto",
            "=http,https",
            "--connect-timeout",
            FETCH_CONNECT_TIME_SECS,
            "--max-time",
            FETCH_MAX_TIME_SECS,
            "--max-filesize",
            &max_filesize,
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            "-H",
            &format!("User-Agent: {user_agent}"),
            "-o",
            "-",
            "-w",
            "\n%{http_code}",
            url,
        ])
        .output()
        .await
        .map_err(|error| {
            updates::UpdateError::Unavailable(truncate(&format!("无法执行 curl：{error}")))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        // curl 28 = operation timeout（--max-time 触发）。
        if output.status.code() == Some(28) {
            return Err(updates::UpdateError::Timeout);
        }
        // curl 63 = CURLE_FILESIZE_EXCEEDED（--max-filesize 触发）。
        if output.status.code() == Some(63) {
            return Err(updates::UpdateError::TooLarge {
                limit_mib: crate::outbound::MAX_OUTBOUND_BODY_MIB,
            });
        }
        let detail = if stderr.is_empty() {
            format!("curl 退出码 {:?}", output.status.code())
        } else {
            truncate(stderr)
        };
        return Err(updates::UpdateError::Network(detail));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let too_large = || updates::UpdateError::TooLarge {
        limit_mib: crate::outbound::MAX_OUTBOUND_BODY_MIB,
    };
    let (body, status) = match stdout.rsplit_once('\n') {
        Some((body, status)) => {
            // `--max-filesize` 只在有 Content-Length 时提前中止；chunked 响应只能读回后再判。
            if crate::outbound::exceeded(body.len() as u64) {
                return Err(too_large());
            }
            (body.to_string(), status.trim().parse::<u16>().ok())
        }
        None => {
            if crate::outbound::exceeded(stdout.len() as u64) {
                return Err(too_large());
            }
            (stdout.to_string(), None)
        }
    };
    match status {
        Some(status) if (200..300).contains(&status) => Ok(body),
        Some(status) => Err(updates::UpdateError::Http(status)),
        None => Err(updates::UpdateError::Network(
            "curl 没有返回 HTTP 状态码 / curl returned no HTTP status".to_string(),
        )),
    }
}

fn truncate(value: &str) -> String {
    value.trim().chars().take(200).collect()
}

/// 更新检测服务：可注入的版本源 + 最近一次结果的进程内缓存。
///
/// 缓存只是少读一次库；权威值始终在 `update_check` 表里，重启后照常显示
/// 「上次检测」。
#[derive(Clone)]
pub struct UpdateService {
    fetcher: Arc<dyn ReleaseFetcher>,
    cache: Arc<Mutex<Option<UpdateCheck>>>,
    /// 串行化检测：手动触发与定时任务同时跑时，避免同一版本被通知两次。
    check_lock: Arc<tokio::sync::Mutex<()>>,
}

impl Default for UpdateService {
    fn default() -> Self {
        Self::new(Arc::new(CurlFetcher::default()))
    }
}

impl UpdateService {
    pub fn new(fetcher: Arc<dyn ReleaseFetcher>) -> Self {
        Self {
            fetcher,
            cache: Arc::new(Mutex::new(None)),
            check_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// 取的检测互斥锁；同一时刻只允许一轮检测。
    pub async fn lock_check(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.check_lock.lock().await
    }

    pub fn cached(&self) -> Option<UpdateCheck> {
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn put(&self, check: UpdateCheck) {
        *self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(check);
    }

    /// 测试用：清掉缓存，模拟「进程重启」。
    #[cfg(test)]
    pub fn clear_cache(&self) {
        *self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

/// 读取当前快照：先看内存缓存，再回落到数据库。
pub async fn snapshot(state: &AppState) -> anyhow::Result<UpdateCheck> {
    if let Some(cached) = state.updates.cached() {
        return Ok(cached);
    }
    let check = repo::updates::load(&state.db.pool).await?;
    state.updates.put(check.clone());
    Ok(check)
}

/// 立即检测一次（手动接口与启动首轮共用）。
///
/// 失败不返回 Err：网络/解析错误会落库成 `error` 字段，返回值仍然是当前
/// 快照。只有数据库写入失败才会返回 Err。
pub async fn check_now(state: &AppState) -> anyhow::Result<UpdateCheck> {
    // 手动「立即检测」与定时任务可能撞车：串行化后「已通知版本」的判断才可靠。
    let _guard = state.updates.lock_check().await;
    let checked_at = time::now();
    let outcome = state.updates.fetcher.fetch().await;
    let check = match outcome {
        Ok(raw) => match updates::parse_release(&raw) {
            Ok(release) => {
                repo::updates::save_success(
                    &state.db.pool,
                    &release.version,
                    &release.url,
                    release.released_at,
                    checked_at,
                )
                .await?;
                let mut check = repo::updates::load(&state.db.pool).await?;
                if maybe_notify(state, &check, &release).await? {
                    // 通知记录写库后重新读，返回给前端的快照要和库里一致。
                    check = repo::updates::load(&state.db.pool).await?;
                }
                check
            }
            Err(error) => record_failure(state, &error, checked_at).await?,
        },
        Err(error) => record_failure(state, &error, checked_at).await?,
    };
    state.updates.put(check.clone());
    tracing::debug!(
        latest = %check.latest_version,
        error = %check.error,
        "更新检测完成"
    );
    Ok(check)
}

async fn record_failure(
    state: &AppState,
    error: &updates::UpdateError,
    checked_at: i64,
) -> anyhow::Result<UpdateCheck> {
    tracing::warn!(code = error.code(), "更新检测失败：{}", error.message());
    repo::updates::save_failure(&state.db.pool, &error.message(), checked_at).await?;
    repo::updates::load(&state.db.pool).await
}

/// 有新版本且这个版本还没通知过时，走现有告警渠道发一条。
///
/// 开关以 `alert_events` 里的 `update_available` 事件为准（与其它告警事件同一份
/// 白名单、同一个通知页）；旧的 `update_check_notify` 只保留接口兼容，不参与判断。
/// 返回是否写入了「已通知」记录（写库后调用方需要重新读快照）。
async fn maybe_notify(
    state: &AppState,
    check: &UpdateCheck,
    release: &updates::ReleaseInfo,
) -> anyhow::Result<bool> {
    if !updates::has_update(Some(&release.version), current_version()) {
        return Ok(false);
    }
    if check.notified_version == release.version {
        return Ok(false);
    }
    let settings = settings::load(&state.db).await;
    if !event_enabled(&settings, AlertKind::UpdateAvailable) {
        return Ok(false);
    }

    let current = current_version();
    let title = format!(
        "发现新版本 v{} / New release v{}",
        release.version, release.version
    );
    let body = format!(
        "当前 v{current} → 最新 v{}\n{}\n当前 v{current} → latest v{}; release notes: {}",
        release.version, release.url, release.version, release.url
    );
    // 没有配置渠道时不要记「已通知」，否则管理员配好渠道后永远收不到。
    let delivered =
        crate::alerts::notify_custom(state, "update_available", "master", &title, &body).await;
    if !delivered {
        return Ok(false);
    }
    repo::updates::mark_notified(&state.db.pool, &release.version, time::now()).await?;
    Ok(true)
}

/// 把间隔小时数夹到 1–168 秒的合法范围（设置读取侧已经夹过，这里兜底）。
pub fn interval_secs(hours: i64) -> i64 {
    hours.clamp(MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS) * 3600
}

/// 距离上次检测是否已经超过间隔；从未检测过 = 立即到期。
pub fn is_due(last_checked_at: Option<i64>, now: i64, interval_hours: i64) -> bool {
    match last_checked_at {
        None => true,
        Some(last) => now.saturating_sub(last) >= interval_secs(interval_hours),
    }
}

/// 调度器的一轮：读设置 → 判断是否启用/到点 → 检测。
///
/// 返回 `None` 表示本轮什么都没做（关闭或未到点）。
pub async fn run_due_check(state: &AppState) -> anyhow::Result<Option<UpdateCheck>> {
    let settings = settings::load(&state.db).await;
    if !settings.update_check_enabled {
        return Ok(None);
    }
    let snapshot = snapshot(state).await?;
    if !is_due(
        snapshot.checked_at,
        time::now(),
        settings.update_check_interval_hours,
    ) {
        return Ok(None);
    }
    Ok(Some(check_now(state).await?))
}

/// `GET /api/v1/updates` 的响应体；agent 部分完全不依赖外网。
pub async fn view(state: &AppState) -> anyhow::Result<Value> {
    let check = snapshot(state).await?;
    let versions = repo::updates::agent_versions(&state.db.pool).await?;
    Ok(json!({
        "master": master_json(&check),
        "agents": agents_json(&versions),
    }))
}

/// master 部分：当前版本 / 最新版本 / 是否有更新 / 失败原因。
pub fn master_json(check: &UpdateCheck) -> Value {
    let current = current_version();
    let latest = (!check.latest_version.trim().is_empty()).then(|| check.latest_version.clone());
    json!({
        "current": current,
        "latest": latest,
        "update_available": updates::has_update(latest.as_deref(), current),
        "release_url": (!check.release_url.trim().is_empty()).then(|| check.release_url.clone()),
        "released_at": check.released_at,
        "checked_at": check.checked_at,
        "error": (!check.error.trim().is_empty()).then(|| check.error.clone()),
    })
}

/// agents 部分：协议版本区间 + 心跳上报的版本分布。
pub fn agents_json(versions: &[AgentVersionCount]) -> Value {
    json!({
        "current_protocol": pierwave_proto::PROTOCOL_VERSION,
        "min_supported": MIN_SUPPORTED_PROTOCOL,
        "versions": versions
            .iter()
            .map(|row| json!({ "version": row.version, "count": row.count }))
            .collect::<Vec<Value>>(),
    })
}

/// 测试用的固定响应版本源；队列里只有一个响应时会一直复用它。
#[cfg(test)]
pub struct StaticFetcher {
    replies: Vec<Result<String, updates::UpdateError>>,
    cursor: Mutex<usize>,
}

#[cfg(test)]
impl StaticFetcher {
    pub fn new(replies: Vec<Result<String, updates::UpdateError>>) -> Self {
        Self {
            replies,
            cursor: Mutex::new(0),
        }
    }
}

#[cfg(test)]
impl ReleaseFetcher for StaticFetcher {
    fn fetch<'a>(&'a self) -> FetchFuture<'a> {
        Box::pin(async move {
            let mut cursor = self
                .cursor
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let index = (*cursor).min(self.replies.len().saturating_sub(1));
            *cursor += 1;
            self.replies
                .get(index)
                .cloned()
                .unwrap_or(Err(updates::UpdateError::Unavailable(
                    "没有模拟响应 / no stub reply".to_string(),
                )))
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    use pierwave_domain::Db;

    use crate::alerts::{Alerts, RecordingTransport};

    fn release_json(version: &str) -> String {
        format!(
            r#"{{"tag_name":"v{version}","html_url":"https://github.com/jacob-bytes/pierwave/releases/tag/v{version}","published_at":"2026-11-20T10:00:00Z"}}"#
        )
    }

    async fn setup(
        replies: Vec<Result<String, updates::UpdateError>>,
    ) -> (AppState, Arc<RecordingTransport>) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let transport = Arc::new(RecordingTransport::default());
        let mut state = AppState::new(db, "web/dist");
        state.alerts = Alerts::new(transport.clone());
        state.updates = UpdateService::new(Arc::new(StaticFetcher::new(replies)));
        (state, transport)
    }

    async fn configure_webhook(state: &AppState) {
        repo::settings::set(&state.db.pool, "webhook_url", "https://example.test/hook")
            .await
            .unwrap();
    }

    async fn configure_events(state: &AppState, events: &str) {
        repo::settings::set(&state.db.pool, "alert_events", events)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn successful_check_records_the_release() {
        let (state, _transport) = setup(vec![Ok(release_json("99.0.0"))]).await;

        let check = check_now(&state).await.unwrap();
        assert_eq!(check.latest_version, "99.0.0", "必须去掉 tag 的 v 前缀");
        assert_eq!(
            check.release_url,
            "https://github.com/jacob-bytes/pierwave/releases/tag/v99.0.0"
        );
        assert_eq!(check.released_at, Some(1_795_168_800));
        assert!(check.checked_at.is_some());
        assert_eq!(check.error, "");

        let body = view(&state).await.unwrap();
        assert_eq!(body["master"]["current"], current_version());
        assert_eq!(body["master"]["latest"], "99.0.0");
        assert_eq!(body["master"]["update_available"], true);
        assert_eq!(body["master"]["error"], Value::Null);
        assert_eq!(
            body["agents"]["current_protocol"],
            i64::from(pierwave_proto::PROTOCOL_VERSION)
        );
        assert_eq!(body["agents"]["min_supported"], 16);
    }

    #[tokio::test]
    async fn failed_check_keeps_the_last_success_values() {
        let (state, _transport) = setup(vec![
            Ok(release_json("99.0.0")),
            Err(updates::UpdateError::Http(503)),
        ])
        .await;

        check_now(&state).await.unwrap();
        let check = check_now(&state).await.unwrap();

        assert_eq!(check.latest_version, "99.0.0", "失败不能清掉上次成功值");
        assert!(check.error.contains("HTTP 503"), "{}", check.error);
        assert!(
            check.error.contains("GitHub Releases responded"),
            "错误必须是中英双语：{}",
            check.error
        );
        let body = view(&state).await.unwrap();
        assert_eq!(body["master"]["latest"], "99.0.0");
        assert_eq!(body["master"]["update_available"], true);
        assert!(body["master"]["error"].as_str().unwrap().contains("503"));
    }

    #[tokio::test]
    async fn the_same_version_is_notified_only_once() {
        let (state, transport) = setup(vec![Ok(release_json("99.0.0"))]).await;
        configure_webhook(&state).await;

        check_now(&state).await.unwrap();
        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "update_available");
        assert_eq!(sent[0].target, "master");
        assert!(sent[0].title.contains("99.0.0"), "{}", sent[0].title);

        // 同一版本再检测两次：不能重复发。
        check_now(&state).await.unwrap();
        check_now(&state).await.unwrap();
        transport
            .assert_no_more(1, Duration::from_millis(120))
            .await;

        let check = repo::updates::load(&state.db.pool).await.unwrap();
        assert_eq!(check.notified_version, "99.0.0");
    }

    #[tokio::test]
    async fn a_newer_version_is_notified_again() {
        let (state, transport) =
            setup(vec![Ok(release_json("99.0.0")), Ok(release_json("99.1.0"))]).await;
        configure_webhook(&state).await;

        check_now(&state).await.unwrap();
        check_now(&state).await.unwrap();

        let sent = transport.wait_for(2).await;
        assert!(sent[1].title.contains("99.1.0"), "{}", sent[1].title);
        let check = repo::updates::load(&state.db.pool).await.unwrap();
        assert_eq!(check.notified_version, "99.1.0");
    }

    /// 事件勾选后才通知：`alert_events` 是唯一事实来源，默认值里已包含它。
    #[tokio::test]
    async fn update_event_checked_sends_the_notification() {
        let (state, transport) = setup(vec![Ok(release_json("99.0.0"))]).await;
        configure_webhook(&state).await;
        configure_events(&state, "server_offline,update_available").await;

        check_now(&state).await.unwrap();
        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "update_available");
        assert_eq!(sent[0].target, "master");
        assert!(sent[0].title.contains("99.0.0"), "{}", sent[0].title);
    }

    /// 取消勾选后不通知，也不能记为「已通知」——重新勾选要能补发这一条。
    #[tokio::test]
    async fn update_event_unchecked_stops_the_notification() {
        let (state, transport) = setup(vec![Ok(release_json("99.0.0"))]).await;
        configure_webhook(&state).await;
        configure_events(&state, "server_offline,user_exhausted").await;
        // 旧开关保持默认开启：它不能再把通知强行打开。
        assert!(settings::load(&state.db).await.update_check_notify);

        check_now(&state).await.unwrap();
        transport
            .assert_no_more(0, Duration::from_millis(120))
            .await;
        let check = repo::updates::load(&state.db.pool).await.unwrap();
        assert_eq!(
            check.notified_version, "",
            "关闭通知时不能记为已通知，否则重新打开就永远收不到"
        );

        // 重新勾选后，同一版本仍要补发（notified_version 还是空的）。
        configure_events(&state, "server_offline,update_available").await;
        check_now(&state).await.unwrap();
        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "update_available");
        assert_eq!(
            repo::updates::load(&state.db.pool)
                .await
                .unwrap()
                .notified_version,
            "99.0.0"
        );
    }

    /// 旧 `update_check_notify = 0` 不再覆盖事件列表（迁移 0050 会把旧值映射成
    /// 「不勾选 update_available」，所以升级用户的选择照样延续）。
    #[tokio::test]
    async fn legacy_switch_does_not_override_the_event_list() {
        let (state, transport) = setup(vec![Ok(release_json("99.0.0"))]).await;
        configure_webhook(&state).await;
        repo::settings::set(&state.db.pool, "update_check_notify", "0")
            .await
            .unwrap();
        configure_events(&state, "update_available").await;

        check_now(&state).await.unwrap();
        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "update_available");
    }

    #[tokio::test]
    async fn without_a_channel_the_version_stays_unnotified() {
        let (state, transport) = setup(vec![Ok(release_json("99.0.0"))]).await;

        check_now(&state).await.unwrap();
        transport
            .assert_no_more(0, Duration::from_millis(120))
            .await;

        // 之后配置好渠道：下一次检测仍要补发这一条。
        configure_webhook(&state).await;
        check_now(&state).await.unwrap();
        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "update_available");
        let check = repo::updates::load(&state.db.pool).await.unwrap();
        assert_eq!(check.notified_version, "99.0.0");
    }

    #[tokio::test]
    async fn already_latest_never_notifies() {
        let (state, transport) = setup(vec![Ok(release_json(current_version()))]).await;
        configure_webhook(&state).await;

        let check = check_now(&state).await.unwrap();
        assert_eq!(check.latest_version, current_version());
        transport
            .assert_no_more(0, Duration::from_millis(120))
            .await;
        assert_eq!(
            repo::updates::load(&state.db.pool)
                .await
                .unwrap()
                .notified_version,
            ""
        );
    }

    #[tokio::test]
    async fn the_check_result_survives_a_restart() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let mut state = AppState::new(db, "web/dist");
        state.updates = UpdateService::new(Arc::new(StaticFetcher::new(vec![Ok(release_json(
            "99.0.0",
        ))])));
        check_now(&state).await.unwrap();

        // 新进程：内存缓存为空，但库里还有上次检测。
        state.updates.clear_cache();
        let snapshot = snapshot(&state).await.unwrap();
        assert_eq!(snapshot.latest_version, "99.0.0");
        assert!(snapshot.checked_at.is_some());
    }

    #[tokio::test]
    async fn snapshot_never_calls_the_network() {
        // 响应队列为空 = 任何一次 fetch 都会返回「没有模拟响应」错误；
        // 快照只读库，不应触发检测。
        let (state, _transport) = setup(Vec::new()).await;
        let snapshot = snapshot(&state).await.unwrap();
        assert_eq!(snapshot, UpdateCheck::default());
        assert_eq!(state.updates.cached(), Some(UpdateCheck::default()));
    }

    #[tokio::test]
    async fn due_check_respects_the_enable_switch_and_interval() {
        let (state, _transport) = setup(vec![Ok(release_json("99.0.0"))]).await;

        assert!(
            run_due_check(&state).await.unwrap().is_some(),
            "从未检测过时第一轮必须执行"
        );
        assert!(
            run_due_check(&state).await.unwrap().is_none(),
            "刚检测过，间隔内不应重复请求"
        );

        repo::settings::set(&state.db.pool, "update_check_enabled", "0")
            .await
            .unwrap();
        state.updates.clear_cache();
        assert!(run_due_check(&state).await.unwrap().is_none());
    }

    /// 伪造一个输出 17 MiB 的 curl：必须报可读的超限错误，而不是把整个响应交给解析。
    #[cfg(unix)]
    #[tokio::test]
    async fn oversized_curl_responses_are_rejected() {
        use std::os::unix::fs::PermissionsExt;

        let dir =
            std::env::temp_dir().join(format!("pierwave-update-oversize-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-curl.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\ndd if=/dev/zero bs=1024 count=17408 2>/dev/null\nprintf '\\n200'\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let fetcher = CurlFetcher {
            url: "http://example.invalid/releases/latest".to_string(),
            program: script.to_string_lossy().into_owned(),
        };
        let error = fetcher.fetch().await.expect_err("17 MiB 响应必须被拒绝");
        assert!(
            error.message().contains("16 MiB"),
            "错误要可读并带上限：{}",
            error.message()
        );
        assert!(
            error.message().contains("超过") || error.message().contains("exceeds"),
            "错误要说明是响应体超限：{}",
            error.message()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 正常大小的响应仍然能解析出状态码与 body。
    #[cfg(unix)]
    #[tokio::test]
    async fn normal_curl_responses_still_pass() {
        use std::os::unix::fs::PermissionsExt;

        let dir =
            std::env::temp_dir().join(format!("pierwave-update-normal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-curl.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf '{\"tag_name\":\"v9.9.9\"}'\nprintf '\\n200'\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let fetcher = CurlFetcher {
            url: "http://example.invalid/releases/latest".to_string(),
            program: script.to_string_lossy().into_owned(),
        };
        let body = fetcher.fetch().await.unwrap();
        assert_eq!(body, "{\"tag_name\":\"v9.9.9\"}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn interval_boundaries_are_clamped() {
        assert_eq!(DEFAULT_INTERVAL_HOURS, 6);
        assert_eq!(interval_secs(1), 3_600);
        assert_eq!(interval_secs(6), 21_600);
        assert_eq!(interval_secs(168), 604_800);
        assert_eq!(interval_secs(0), 3_600, "0 小时按 1 小时处理");
        assert_eq!(interval_secs(999), 604_800, "越界按 168 小时处理");
        assert_eq!(interval_secs(-5), 3_600);
    }

    #[test]
    fn is_due_covers_the_boundaries() {
        let now = 1_000_000;
        assert!(is_due(None, now, 6), "从未检测过立即到期");
        assert!(!is_due(Some(now - 6 * 3600 + 1), now, 6));
        assert!(is_due(Some(now - 6 * 3600), now, 6), "正好到点要执行");
        assert!(is_due(Some(now - 7 * 3600), now, 6));
        assert!(!is_due(Some(now - 3600 + 1), now, 1));
        assert!(is_due(Some(now - 168 * 3600), now, 168));
        // 时钟回拨（checked_at 在未来）不 panic，也不重复检测。
        assert!(!is_due(Some(now + 100), now, 6));
    }
}
