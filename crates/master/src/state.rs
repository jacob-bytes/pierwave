use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pierwave_domain::Db;
use pierwave_proto::MasterMessage;
use serde_json::Value;
use tokio::sync::broadcast;

use crate::alerts::Alerts;
use crate::enforcement::Enforcer;
use crate::throttle::LoginThrottle;

/// 每台服务器一条广播通道；没有 Agent 在线时发送方仍在，消息自然丢弃。
const AGENT_CHANNEL_CAPACITY: usize = 64;

/// 发布产物的默认回源地址。
pub const DEFAULT_RELEASE_SOURCE: &str =
    "https://github.com/jacob-bytes/pierwave/releases/download";

/// 查询最新版本的默认 GitHub API 地址。
pub const DEFAULT_LATEST_URL: &str =
    "https://api.github.com/repos/jacob-bytes/pierwave/releases/latest";

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
#[derive(Clone, Default)]
pub struct AgentHub {
    senders: Arc<Mutex<HashMap<String, broadcast::Sender<MasterMessage>>>>,
}

/// 一次 Agent 连接的订阅凭证；Drop 时自动从 hub 注销。
pub struct AgentSubscription {
    pub receiver: broadcast::Receiver<MasterMessage>,
    pub sender: broadcast::Sender<MasterMessage>,
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
    pub fn subscribe(&self, server_id: &str) -> AgentSubscription {
        let (sender, receiver) = broadcast::channel(AGENT_CHANNEL_CAPACITY);
        self.senders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(server_id.to_string(), sender.clone());
        AgentSubscription {
            receiver,
            sender,
            server_id: server_id.to_string(),
            hub: self.clone(),
        }
    }

    /// 返回成功入队的 Agent 数量；0 表示当前没有 Agent 在线。
    pub fn publish(&self, server_id: &str, message: MasterMessage) -> usize {
        let senders = self
            .senders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        senders
            .get(server_id)
            .map(|sender| sender.send(message).unwrap_or(0))
            .unwrap_or(0)
    }

    /// 只有当前登记的就是这条连接时才移除，避免旧连接断开时误删新连接。
    fn unsubscribe_if(&self, server_id: &str, sender: &broadcast::Sender<MasterMessage>) {
        let mut senders = self
            .senders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if senders
            .get(server_id)
            .is_some_and(|current| current.same_channel(sender))
        {
            senders.remove(server_id);
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
    /// Agent 发布产物的缓存/回源配置。
    pub agent_release: AgentReleaseConfig,
    /// 「最新版本」缓存（5 分钟）。
    pub latest_version: LatestVersionCache,
    /// 公开状态页结果缓存（30 秒）。
    pub public_status: PublicStatusCache,
    /// 告警去抖状态 + 投递器；未配置渠道时所有通知都是 no-op。
    pub alerts: Alerts,
}

impl AppState {
    pub fn new(db: Db, web_dir: impl Into<std::path::PathBuf>) -> Self {
        Self {
            db: Arc::new(db),
            web_dir: Arc::new(web_dir.into()),
            hub: AgentHub::default(),
            enforcement: Enforcer::from_env(),
            login_throttle: Arc::new(LoginThrottle::default()),
            agent_release: AgentReleaseConfig::from_env(),
            latest_version: LatestVersionCache::default(),
            public_status: PublicStatusCache::default(),
            alerts: Alerts::default(),
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
}
