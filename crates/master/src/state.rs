use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use pierwave_domain::Db;
use pierwave_proto::MasterMessage;
use serde_json::Value;
use tokio::sync::{broadcast, watch};

use crate::alerts::Alerts;
use crate::api_token::{ApiTokenRateLimiter, ApiTokenUsage};
use crate::enforcement::Enforcer;
use crate::login_watch::LoginWatch;
use crate::session_touch::SessionTouch;
use crate::tcping::Registry as TcpingRegistry;
use crate::throttle::{IpThrottle, LoginThrottle};
use crate::updates::UpdateService;

/// 每台服务器一条广播通道；没有 Agent 在线时发送方仍在，消息自然丢弃。
const AGENT_CHANNEL_CAPACITY: usize = 64;

/// 发布产物的默认回源地址。
pub const DEFAULT_RELEASE_SOURCE: &str =
    "https://github.com/jacob-bytes/pierwave/releases/download";

/// 查询最新版本的默认 GitHub API 地址。
pub const DEFAULT_LATEST_URL: &str =
    "https://api.github.com/repos/jacob-bytes/pierwave/releases/latest";

/// 异地备份的进程内并发保护与重试参数。
///
/// 锁只保护「同一时刻一次上传」；重试次数固定 3 次（指数退避），退避基数
/// 放在这里是为了让测试能把它压到毫秒级，不依赖真实等待。
#[derive(Clone)]
pub struct RemoteBackupRuntime {
    lock: Arc<AsyncMutex<()>>,
    /// 最多尝试次数（含首次）。
    pub max_attempts: usize,
    /// 指数退避基数：base, 2×base, 4×base…
    pub retry_delay: Duration,
}

impl Default for RemoteBackupRuntime {
    fn default() -> Self {
        Self {
            lock: Arc::new(AsyncMutex::new(())),
            max_attempts: 3,
            retry_delay: Duration::from_secs(2),
        }
    }
}

impl RemoteBackupRuntime {
    /// 非阻塞取锁：拿到返回 guard，已有上传在进行时返回 `None`。
    pub fn try_acquire(&self) -> Option<OwnedMutexGuard<()>> {
        self.lock.clone().try_lock_owned().ok()
    }

    /// 测试：把退避压到毫秒级，避免单测真的等 2s + 4s。
    #[cfg(test)]
    pub fn fast_retry(mut self) -> Self {
        self.retry_delay = Duration::from_millis(1);
        self
    }
}

/// 最新版本缓存 5 分钟：前端「留空 = 最新」不应该每次点击都打 GitHub。
const LATEST_VERSION_TTL: Duration = Duration::from_secs(300);

/// 主控缓存/中转 Agent 发布产物所需的配置。
///
/// `cache_dir` 与 `source` 都允许通过环境变量覆盖；`source` 还允许是本地目录，
/// 便于离线镜像与测试（测试里绝不真的打 GitHub）。
#[derive(Clone, Debug)]
pub struct AgentReleaseConfig {
    pub cache_dir: PathBuf,
    /// `https://...` / `http://...` = 回源下载；其它值按本地目录处理。
    pub source: String,
    /// 下发计划里使用的发布目标三元组（决定下载哪个架构的二进制）。
    pub target: String,
    /// 查询最新 Release 的 URL（生产是 GitHub API；测试/离线可指向本地 JSON 文件）。
    pub latest_url: String,
}

pub const DEFAULT_AGENT_TARGET: &str = "x86_64-unknown-linux-musl";

impl AgentReleaseConfig {
    pub fn from_env() -> Self {
        Self {
            cache_dir: env_nonempty("PIERWAVE_AGENT_CACHE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("data/agent-cache")),
            source: env_nonempty("PIERWAVE_AGENT_RELEASE_SOURCE")
                .unwrap_or_else(|| DEFAULT_RELEASE_SOURCE.to_string()),
            target: env_nonempty("PIERWAVE_AGENT_TARGET")
                .unwrap_or_else(|| DEFAULT_AGENT_TARGET.to_string()),
            latest_url: env_nonempty("PIERWAVE_AGENT_LATEST_URL")
                .unwrap_or_else(|| DEFAULT_LATEST_URL.to_string()),
        }
    }

    /// 本地缓存路径：`{cache_dir}/{version}/{file}`。
    pub fn cache_path(&self, version: &str, file: &str) -> PathBuf {
        self.cache_dir.join(version).join(file)
    }
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 「最新版本」的进程内缓存；过期后由下一次请求重新解析。
#[derive(Clone, Default)]
pub struct LatestVersionCache {
    inner: Arc<Mutex<Option<(Instant, String)>>>,
}

impl LatestVersionCache {
    pub fn get(&self) -> Option<String> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .as_ref()
            .filter(|(at, _)| at.elapsed() < LATEST_VERSION_TTL)
            .map(|(_, version)| version.clone())
    }

    pub fn put(&self, version: &str) {
        *self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            Some((Instant::now(), version.to_string()));
    }
}

/// 公开状态页的结果缓存：30 秒内重复请求直接复用，避免每次打库扫采样表。
///
/// 放在 `AppState` 里而不是全局静态变量：每个进程/测试实例各自独立，
/// 测试之间不会互相污染。
pub const PUBLIC_STATUS_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Default)]
pub struct PublicStatusCache {
    inner: Arc<Mutex<Option<(Instant, Value)>>>,
}

impl PublicStatusCache {
    pub fn get(&self) -> Option<Value> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .as_ref()
            .filter(|(at, _)| at.elapsed() < PUBLIC_STATUS_CACHE_TTL)
            .map(|(_, value)| value.clone())
    }

    pub fn put(&self, value: Value) {
        *self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((Instant::now(), value));
    }

    #[cfg(test)]
    pub fn clear(&self) {
        *self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

/// 已连接 Agent 的期望态广播中心。
///
/// 主控只在 `apply` 时广播完整配置，Agent 收敛失败会回 `ApplyResult`，
/// 不需要命令式 RPC。这里用 tokio 自带的 broadcast，避免额外依赖。
///
/// 每条登记还带一个 `watch` 断开信号：新连接顶替旧连接、重置 token、
/// 删除服务器时用它通知旧连接主动退出，而不是等 TCP 自己断。
#[derive(Clone, Default)]
pub struct AgentHub {
    registrations: Arc<Mutex<HashMap<String, AgentRegistration>>>,
}

struct AgentRegistration {
    sender: broadcast::Sender<MasterMessage>,
    disconnect: watch::Sender<()>,
}

/// 一次 Agent 连接的订阅凭证；Drop 时自动从 hub 注销。
pub struct AgentSubscription {
    pub receiver: broadcast::Receiver<MasterMessage>,
    pub sender: broadcast::Sender<MasterMessage>,
    /// 被新连接顶替 / token 重置 / 服务器删除时收到一次变更。
    pub disconnect: watch::Receiver<()>,
    server_id: String,
    hub: AgentHub,
}

impl Drop for AgentSubscription {
    fn drop(&mut self) {
        self.hub.unsubscribe_if(&self.server_id, &self.sender);
    }
}

impl AgentHub {
    /// 注册（或替换）某个服务器的 Agent 通道。
    ///
    /// 替换时向旧登记发断开信号，让旧连接主动退出；旧登记本身不会在这里删除，
    /// 由旧连接的 [`AgentSubscription::drop`] 清理。
    pub fn subscribe(&self, server_id: &str) -> AgentSubscription {
        let (sender, receiver) = broadcast::channel(AGENT_CHANNEL_CAPACITY);
        let (disconnect, disconnect_rx) = watch::channel(());
        let replaced = self
            .registrations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                server_id.to_string(),
                AgentRegistration {
                    sender: sender.clone(),
                    disconnect,
                },
            );
        if let Some(old) = replaced {
            // 接收者由旧连接的订阅持有；即便已经没了，send 返回 Err 也无害。
            let _ = old.disconnect.send(());
        }
        AgentSubscription {
            receiver,
            sender,
            disconnect: disconnect_rx,
            server_id: server_id.to_string(),
            hub: self.clone(),
        }
    }

    /// 返回成功入队的 Agent 数量；0 表示当前没有 Agent 在线。
    pub fn publish(&self, server_id: &str, message: MasterMessage) -> usize {
        let registrations = self
            .registrations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registrations
            .get(server_id)
            .map(|registration| registration.sender.send(message).unwrap_or(0))
            .unwrap_or(0)
    }

    /// 通知某台服务器的当前连接退出（重置 token / 删除服务器）。
    ///
    /// **只发信号，不删除登记**：连接退出后要用 [`Self::is_current`] 判断自己是
    /// 不是当前连接，登记被提前删掉会得到 false，从而漏掉 `mark_offline` 与离线
    /// 告警，服务器会永远显示在线。登记留给旧连接的 Drop 清理。
    pub fn disconnect(&self, server_id: &str) {
        let registrations = self
            .registrations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(registration) = registrations.get(server_id) {
            let _ = registration.disconnect.send(());
        }
    }

    /// 这条连接是否仍是该服务器当前登记的那条。
    ///
    /// 连接退出时只有当前连接才允许把服务器标离线：被新连接顶替的旧连接如果
    /// 也标离线，会把刚上线的新连接状态覆盖掉。
    pub fn is_current(&self, server_id: &str, sender: &broadcast::Sender<MasterMessage>) -> bool {
        self.registrations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(server_id)
            .is_some_and(|registration| registration.sender.same_channel(sender))
    }

    /// 只有当前登记的就是这条连接时才移除，避免旧连接断开时误删新连接。
    fn unsubscribe_if(&self, server_id: &str, sender: &broadcast::Sender<MasterMessage>) {
        let mut registrations = self
            .registrations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if registrations
            .get(server_id)
            .is_some_and(|registration| registration.sender.same_channel(sender))
        {
            registrations.remove(server_id);
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    pub web_dir: Arc<std::path::PathBuf>,
    pub hub: AgentHub,
    /// 断流去抖状态；由 `crate::enforcement::spawn_worker` 消费。
    pub enforcement: Enforcer,
    /// 登录失败限流；阈值每次登录时从设置表刷新。
    pub login_throttle: Arc<LoginThrottle>,
    /// 认证失败的 IP 维度限流（Bearer / Agent Hello）；进程内计数。
    pub ip_throttle: Arc<IpThrottle>,
    /// 连续失败计数（登录失败告警）；与限流分开，成功登录时清零。
    pub login_watch: LoginWatch,
    /// 会话 `last_seen_at` 的低频写回节流（默认 60 秒）。
    pub session_touch: SessionTouch,
    /// Agent 发布产物的缓存/回源配置。
    pub agent_release: AgentReleaseConfig,
    /// 「最新版本」缓存（5 分钟）。
    pub latest_version: LatestVersionCache,
    /// 公开状态页结果缓存（30 秒）。
    pub public_status: PublicStatusCache,
    /// 告警去抖状态 + 投递器；未配置渠道时所有通知都是 no-op。
    pub alerts: Alerts,
    /// 版本更新检测：版本源（默认 GitHub Releases）+ 最近一次结果缓存。
    pub updates: UpdateService,
    /// 节点 TCPing 的每节点并发/频控状态；结果只在内存里，不落库。
    pub tcping: TcpingRegistry,
    /// 异地备份（WebDAV）的进程内互斥与重试参数。
    pub remote_backup: RemoteBackupRuntime,
    /// API Token 每 token 每分钟限流（进程内）。
    pub api_token_throttle: Arc<ApiTokenRateLimiter>,
    /// API Token 的 `last_used_at` 写回缓冲；调度器批量落库。
    pub api_token_usage: Arc<ApiTokenUsage>,
}

impl AppState {
    pub fn new(db: Db, web_dir: impl Into<std::path::PathBuf>) -> Self {
        Self {
            db: Arc::new(db),
            web_dir: Arc::new(web_dir.into()),
            hub: AgentHub::default(),
            enforcement: Enforcer::from_env(),
            login_throttle: Arc::new(LoginThrottle::default()),
            ip_throttle: Arc::new(IpThrottle::default()),
            login_watch: LoginWatch::default(),
            session_touch: SessionTouch::default(),
            agent_release: AgentReleaseConfig::from_env(),
            latest_version: LatestVersionCache::default(),
            public_status: PublicStatusCache::default(),
            alerts: Alerts::default(),
            updates: UpdateService::default(),
            tcping: TcpingRegistry::default(),
            remote_backup: RemoteBackupRuntime::default(),
            api_token_throttle: Arc::new(ApiTokenRateLimiter::default()),
            api_token_usage: Arc::new(ApiTokenUsage::default()),
        }
    }

    /// 测试：显式设置断流开关与去抖窗口，不受环境变量影响。
    #[cfg(test)]
    pub fn with_enforcement(mut self, enabled: bool, window: Duration) -> Self {
        self.enforcement = Enforcer::new(enabled, window);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hub_broadcasts_only_to_the_registered_server() {
        let hub = AgentHub::default();
        let mut subscription = hub.subscribe("server-1");

        assert_eq!(hub.publish("server-1", MasterMessage::Ping), 1);
        assert!(matches!(
            subscription.receiver.recv().await.unwrap(),
            MasterMessage::Ping
        ));

        assert_eq!(hub.publish("server-2", MasterMessage::Ping), 0);

        drop(subscription);
        assert_eq!(hub.publish("server-1", MasterMessage::Ping), 0);
    }

    #[tokio::test]
    async fn stale_connection_drop_keeps_the_newer_registration() {
        let hub = AgentHub::default();
        let old = hub.subscribe("server-1");
        let new = hub.subscribe("server-1");

        drop(old);
        assert_eq!(hub.publish("server-1", MasterMessage::Ping), 1);

        drop(new);
        assert_eq!(hub.publish("server-1", MasterMessage::Ping), 0);
    }

    /// 新连接登记同一台服务器时，旧连接必须收到断开信号；旧连接 Drop 也不能
    /// 把新登记删掉。
    #[tokio::test]
    async fn replacing_subscription_signals_old_connection() {
        let hub = AgentHub::default();
        let mut old = hub.subscribe("server-1");
        let new = hub.subscribe("server-1");

        tokio::time::timeout(Duration::from_secs(1), old.disconnect.changed())
            .await
            .expect("1s 内必须收到断开信号，否则旧连接不会被顶下去")
            .expect("旧连接必须收到断开信号");
        assert!(
            !hub.is_current("server-1", &old.sender),
            "被顶替后旧连接不再是当前连接"
        );
        assert!(
            hub.is_current("server-1", &new.sender),
            "新连接才是当前连接"
        );

        drop(old);
        assert_eq!(
            hub.publish("server-1", MasterMessage::Ping),
            1,
            "旧连接 Drop 不能删掉新登记"
        );
        drop(new);
        assert_eq!(hub.publish("server-1", MasterMessage::Ping), 0);
    }

    /// `disconnect` 只发信号，登记保留到连接自己 Drop：这样连接退出时
    /// `is_current` 仍为 true，才能正确标离线。
    #[tokio::test]
    async fn disconnect_signals_current_connection() {
        let hub = AgentHub::default();
        let mut subscription = hub.subscribe("server-1");

        hub.disconnect("server-1");
        tokio::time::timeout(Duration::from_secs(1), subscription.disconnect.changed())
            .await
            .expect("1s 内必须收到断开信号")
            .expect("当前连接必须收到断开信号");
        assert!(
            hub.is_current("server-1", &subscription.sender),
            "disconnect 不能立即删登记，否则退出时判不出 is_current、会漏标离线"
        );
        assert_eq!(
            hub.publish("server-1", MasterMessage::Ping),
            1,
            "发信号后登记仍然有效，直到连接 Drop"
        );

        // 没有登记的服务器 / 没有接收者时只是 no-op，不能 panic。
        hub.disconnect("server-404");
        drop(subscription);
        assert_eq!(hub.publish("server-1", MasterMessage::Ping), 0);
    }

    /// 已登记的连接收到信号后即便再次 disconnect 也不该出问题。
    #[tokio::test]
    async fn repeated_disconnect_is_idempotent() {
        let hub = AgentHub::default();
        let mut subscription = hub.subscribe("server-1");

        hub.disconnect("server-1");
        hub.disconnect("server-1");
        tokio::time::timeout(Duration::from_secs(1), subscription.disconnect.changed())
            .await
            .expect("1s 内必须收到断开信号")
            .expect("信号只需要送达一次");

        // 接收者仍在：Drop 之后登记才被清理。
        assert!(hub.is_current("server-1", &subscription.sender));
        let sender = subscription.sender.clone();
        drop(subscription);
        assert!(!hub.is_current("server-1", &sender));
    }
}
