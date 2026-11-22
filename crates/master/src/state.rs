use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use pierwave_domain::repo::overview::TrafficSnapshot;
use pierwave_domain::Db;
use pierwave_proto::MasterMessage;
use serde_json::Value;
use tokio::sync::{broadcast, watch};

use crate::alerts::Alerts;
use crate::api_token::{ApiTokenRateLimiter, ApiTokenUsage};
use crate::enforcement::Enforcer;
use crate::error::{AppError, AppResult};
use crate::login_watch::LoginWatch;
use crate::session_touch::SessionTouch;
use crate::tcping::Registry as TcpingRegistry;
use crate::throttle::{IpThrottle, LoginThrottle, PublicReadThrottle};
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

/// 概览「流量快照」的短缓存：默认 12 秒，与前端轮询同一量级。
///
/// 只缓存由 `traffic_daily` / `traffic_node_daily` 派生的部分（趋势、协议、
/// Top 用户/节点/套餐、KPI 流量）；服务器/节点计数、链路健康、24h 可用率
/// 与带实时状态/网速采样的 Top 服务器每次现算，所以新建节点或链路状态变化
/// 不会被缓存拖慢。
///
/// **缓存是 TTL 语义，不做写穿透**：key 只有 `days`，计费入账不会让缓存
/// 失效，最坏情况下概览流量数字比账本晚 12 秒。这样做是为了避免生产里
/// Agent 持续上报（每秒都有 `traffic_daily` 写入）导致缓存永远 miss；
/// 计费与账单始终读原始账本，不受影响。
///
/// `PIERWAVE_OVERVIEW_CACHE_SECS=0` 可关闭缓存（基准脚本用它测冷查询）。
pub const OVERVIEW_TRAFFIC_CACHE_TTL: Duration = Duration::from_secs(12);

#[derive(Debug, Default)]
struct OverviewTrafficStats {
    hits: AtomicU64,
    misses: AtomicU64,
}

/// 缓存 key：生产只用 `(days, 0)`；第二个分量留给测试复现旧的
/// `(days, generation)` 策略，证明持续写入下它会几乎全部 miss。
type OverviewTrafficKey = (i64, i64);
/// 缓存条目：写入时刻 + 流量快照。
type OverviewTrafficEntry = (Instant, TrafficSnapshot);

/// 概览流量快照缓存，按 `days` 命中，TTL 12 秒。
///
/// 显式的 [`Self::clear`] 只用于管理员动作（恢复备份等）要求立即失效的场景；
/// 常规计费入账**不**清缓存，否则持续上报会让缓存失去意义。
///
/// 放在 `AppState` 里而不是全局静态变量：每个进程/测试实例各自独立，
/// 测试之间不会互相污染。
#[derive(Clone)]
pub struct OverviewTrafficCache {
    inner: Arc<Mutex<HashMap<OverviewTrafficKey, OverviewTrafficEntry>>>,
    ttl: Duration,
    stats: Arc<OverviewTrafficStats>,
}

impl Default for OverviewTrafficCache {
    fn default() -> Self {
        Self::with_ttl(OVERVIEW_TRAFFIC_CACHE_TTL)
    }
}

impl OverviewTrafficCache {
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            ttl,
            stats: Arc::new(OverviewTrafficStats::default()),
        }
    }

    /// 缓存有效期；`0` 表示禁用（不发缓存内容，直接走冷查询）。
    #[cfg(test)]
    pub fn ttl(&self) -> Duration {
        self.ttl
    }

    fn lookup(&self, key: OverviewTrafficKey) -> Option<TrafficSnapshot> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let hit = guard
            .get(&key)
            .filter(|(at, _)| at.elapsed() < self.ttl)
            .map(|(_, snapshot)| snapshot.clone());
        if hit.is_some() {
            self.stats.hits.fetch_add(1, Ordering::Relaxed);
        } else {
            self.stats.misses.fetch_add(1, Ordering::Relaxed);
        }
        hit
    }

    fn store(&self, key: OverviewTrafficKey, snapshot: TrafficSnapshot) {
        if self.ttl.is_zero() {
            return;
        }
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, (Instant::now(), snapshot));
    }

    /// 命中返回快照；超过 TTL 才是 miss（days 不同是不同的 key）。
    pub fn get(&self, days: i64) -> Option<TrafficSnapshot> {
        self.lookup((days, 0))
    }

    /// 写入快照；同一 `days` 覆盖旧条目。
    pub fn put(&self, days: i64, snapshot: TrafficSnapshot) {
        self.store((days, 0), snapshot);
    }

    /// 测试专用：复现旧的 `(days, generation)` key，用来证明持续写入下
    /// 命中率会接近 0。生产路径不会调用。
    #[cfg(test)]
    pub(crate) fn get_generation_keyed(
        &self,
        days: i64,
        generation: i64,
    ) -> Option<TrafficSnapshot> {
        self.lookup((days, generation))
    }

    /// 测试专用：与 [`Self::get_generation_keyed`] 配对。
    #[cfg(test)]
    pub(crate) fn put_generation_keyed(
        &self,
        days: i64,
        generation: i64,
        snapshot: TrafficSnapshot,
    ) {
        self.store((days, generation), snapshot);
    }

    /// 立刻失效：只给管理员动作（例如恢复备份）用，常规流量写入不要调用。
    pub fn clear(&self) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// (hits, misses)；只给测试断言用。
    #[cfg(test)]
    pub(crate) fn stats(&self) -> (u64, u64) {
        (
            self.stats.hits.load(Ordering::Relaxed),
            self.stats.misses.load(Ordering::Relaxed),
        )
    }
}

/// `PIERWAVE_OVERVIEW_CACHE_SECS`：缺省用 [`OVERVIEW_TRAFFIC_CACHE_TTL`]，
/// 显式 `0` 关闭缓存。非法值忽略，避免拼错环境变量把线上缓存意外关掉。
fn overview_cache_ttl_from_env() -> Duration {
    std::env::var("PIERWAVE_OVERVIEW_CACHE_SECS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(OVERVIEW_TRAFFIC_CACHE_TTL)
}

/// 管理员「服务器态势」快照的短缓存：30 秒。
///
/// 采样本身 5 分钟才写一行，30 秒缓存不会让页面明显滞后，却能把「多个管理员
/// 同时刷新」从 N 次 7 天窗口聚合压成 1 次。key 是 `(hours, bucket)`：不同
/// 窗口/桶宽的结果不能互相复用。
///
/// **不做写穿透**：新采样最多晚 30 秒出现在响应里；`generated_at` 也随快照
/// 一起缓存（同一份数据的时间戳必须一致）。轮询频率远高于 30 秒时命中率接近 1。
pub const SERVER_HEALTH_CACHE_TTL: Duration = Duration::from_secs(30);

type ServerHealthKey = (i64, i64);
type ServerHealthEntry = (Instant, Value);

#[derive(Debug, Default)]
struct ServerHealthStats {
    hits: AtomicU64,
    misses: AtomicU64,
}

/// `GET /api/v1/overview/server-health` 的 30 秒结果缓存。
///
/// 放在 `AppState` 里而不是全局静态变量：每个进程/测试实例各自独立。
#[derive(Clone)]
pub struct ServerHealthCache {
    inner: Arc<Mutex<HashMap<ServerHealthKey, ServerHealthEntry>>>,
    ttl: Duration,
    stats: Arc<ServerHealthStats>,
}

impl Default for ServerHealthCache {
    fn default() -> Self {
        Self::with_ttl(SERVER_HEALTH_CACHE_TTL)
    }
}

impl ServerHealthCache {
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            ttl,
            stats: Arc::new(ServerHealthStats::default()),
        }
    }

    pub fn get(&self, hours: i64, bucket: i64) -> Option<Value> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let hit = guard
            .get(&(hours, bucket))
            .filter(|(at, _)| self.ttl > Duration::ZERO && at.elapsed() < self.ttl)
            .map(|(_, value)| value.clone());
        if hit.is_some() {
            self.stats.hits.fetch_add(1, Ordering::Relaxed);
        } else {
            self.stats.misses.fetch_add(1, Ordering::Relaxed);
        }
        hit
    }

    pub fn put(&self, hours: i64, bucket: i64, value: Value) {
        if self.ttl.is_zero() {
            return;
        }
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert((hours, bucket), (Instant::now(), value));
    }

    /// (hits, misses)；只给测试断言用。
    #[cfg(test)]
    pub(crate) fn stats(&self) -> (u64, u64) {
        (
            self.stats.hits.load(Ordering::Relaxed),
            self.stats.misses.load(Ordering::Relaxed),
        )
    }
}

/// 导出 / 异地备份的数据库大小上限：与恢复共用 512 MB 默认值。
///
/// 可用 `PIERWAVE_MAX_BACKUP_MB` 调整；非法值（0 / 非数字）回落默认值，
/// 避免一个笔误让所有备份静默失败。
pub const DEFAULT_MAX_BACKUP_BYTES: u64 = pierwave_domain::backup::MAX_BACKUP_BYTES;

fn max_backup_bytes_from_env() -> u64 {
    std::env::var("PIERWAVE_MAX_BACKUP_MB")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|mb| *mb > 0)
        .map(|mb| mb.saturating_mul(1024 * 1024))
        .unwrap_or(DEFAULT_MAX_BACKUP_BYTES)
}

/// 公开状态页的结果缓存：30 秒内重复请求直接复用，避免每次打库扫采样表。
///
/// 放在 `AppState` 里而不是全局静态变量：每个进程/测试实例各自独立，
/// 测试之间不会互相污染。
pub const PUBLIC_STATUS_CACHE_TTL: Duration = Duration::from_secs(30);

/// 一次聚合的完整结果：列表响应 + 每台服务器的 24h 趋势。
///
/// 列表接口不再返回 `series_24h`（1000 台时它接近列表体积的一半），趋势挪到
/// `GET /api/v1/public/status/{id}`。两者必须是**同一次聚合**的产物：分开缓存
/// 会让详情看到比列表更旧/更新的数据，所以放在一个快照里一起写、一起失效。
#[derive(Clone, Default)]
pub struct PublicStatusSnapshot {
    /// `GET /api/v1/public/status` 的完整响应（不含 `series_24h`）。
    pub list: Value,
    /// `server_id` → 序列化后的 `series_24h`；只含公开可见的服务器。
    pub series: HashMap<String, Value>,
}

/// 公开状态页快照的等待上限：重建期间的并发请求最多等这么久。
///
/// 1000 台冷缓存重建约 500ms，5 秒足够覆盖慢盘 / 慢查询；超过后返回 503
/// 而不是让请求无限排队。**不让等待者自己再算一遍**：那正是缓存击穿
/// （30 秒过期瞬间 N 个并发请求各扫一遍采样表）本身。
pub const PUBLIC_STATUS_REBUILD_WAIT: Duration = Duration::from_secs(5);

/// 公开状态页快照的单飞计数器；只用于日志与测试，不接 Prometheus。
#[derive(Debug, Default)]
struct PublicStatusStats {
    /// 真正执行了聚合的次数。
    rebuilds: AtomicU64,
    /// 等到锁之后发现别人已经建好、直接复用结果的次数。
    waited_hits: AtomicU64,
    /// 等锁超过 [`PUBLIC_STATUS_REBUILD_WAIT`] 而返回 503 的次数。
    wait_timeouts: AtomicU64,
    /// 聚合失败（错误不缓存，下一次请求会重新尝试）的次数。
    failures: AtomicU64,
}

#[derive(Clone)]
pub struct PublicStatusCache {
    inner: Arc<Mutex<Option<(Instant, PublicStatusSnapshot)>>>,
    /// 单飞锁：同一时刻只允许一个请求重建快照，其余等待并复用同一结果。
    ///
    /// 必须是 **tokio 的异步锁**：`std::sync::MutexGuard` 不是 `Send`，跨
    /// `.await` 持有会让 handler 编不过，拿它硬锁还会把整个 runtime 卡住。
    /// 计数器锁 `inner` 只在 `get` / `put` 里短暂持有，绝不跨越 `.await`。
    rebuild: Arc<AsyncMutex<()>>,
    /// 等待重建的上限，测试里可以缩短（见 [`Self::with_wait`]）。
    wait: Duration,
    stats: Arc<PublicStatusStats>,
    /// 缓存代际：`clear()` 递增。重建开始前记下代际，写缓存前比对；
    /// 期间发生过 clear 就丢弃这次结果，避免旧快照回填。
    generation: Arc<AtomicU64>,
}

impl Default for PublicStatusCache {
    fn default() -> Self {
        Self::with_wait(PUBLIC_STATUS_REBUILD_WAIT)
    }
}

impl PublicStatusCache {
    /// 指定等待上限；测试用它把 5 秒压到毫秒级。
    pub fn with_wait(wait: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            rebuild: Arc::new(AsyncMutex::new(())),
            wait,
            stats: Arc::new(PublicStatusStats::default()),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    fn get(&self) -> Option<PublicStatusSnapshot> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .as_ref()
            .filter(|(at, _)| at.elapsed() < PUBLIC_STATUS_CACHE_TTL)
            .map(|(_, snapshot)| snapshot.clone())
    }

    /// 只有代际未变时才写缓存；返回是否写入。
    fn put_if_generation(&self, generation: u64, snapshot: PublicStatusSnapshot) -> bool {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        *guard = Some((Instant::now(), snapshot));
        true
    }

    /// 缓存命中直接返回；未命中时**单飞**重建：只有一个请求真正执行
    /// `build`，其余请求等它把结果写进缓存后直接复用。
    ///
    /// 失败语义：
    /// * 聚合失败 → 错误原样返回给 leader，**不写缓存**，因此下一次请求
    ///   会重新尝试，不会被一次失败卡住 30 秒；
    /// * 等待锁超过 [`Self::wait`] → 返回 503
    ///   `public_status.overloaded`，不各自重算（避免等待者把数据库打穿）；
    /// * leader 失败时锁随 guard 一起释放，排队的等待者中最早的那个会接手
    ///   重建，不会永久卡住。
    pub async fn get_or_build<F, Fut>(&self, build: F) -> AppResult<PublicStatusSnapshot>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = AppResult<PublicStatusSnapshot>>,
    {
        if let Some(snapshot) = self.get() {
            return Ok(snapshot);
        }

        let guard = match tokio::time::timeout(self.wait, self.rebuild.clone().lock_owned()).await {
            Ok(guard) => guard,
            Err(_) => {
                let timeouts = self.stats.wait_timeouts.fetch_add(1, Ordering::Relaxed) + 1;
                tracing::warn!(
                    wait_ms = self.wait.as_millis() as u64,
                    timeouts,
                    "等待公开状态页快照重建超时，返回 503"
                );
                return Err(AppError::service_unavailable(
                    "public_status.overloaded",
                    Some(serde_json::json!({ "retry_after_secs": 1 })),
                    "公开状态页正在重建快照，请稍后重试 / The public status snapshot is being rebuilt, please retry shortly",
                ));
            }
        };

        // 拿到锁后再看一眼：前一位持有者可能刚好建好并写入缓存，
        // 这时直接复用，不再跑第二遍聚合。
        if let Some(snapshot) = self.get() {
            let waited_hits = self.stats.waited_hits.fetch_add(1, Ordering::Relaxed) + 1;
            tracing::debug!(waited_hits, "公开状态页快照等待命中，复用 leader 的结果");
            drop(guard);
            return Ok(snapshot);
        }

        // 聚合开始前记下代际：期间管理员 clear 过，结果就不能回填缓存。
        let generation = self.generation.load(Ordering::SeqCst);
        let started = Instant::now();
        match build().await {
            Ok(snapshot) => {
                let cached = self.put_if_generation(generation, snapshot.clone());
                if !cached {
                    tracing::info!("公开状态页快照重建期间缓存被清空，丢弃本次结果不回填");
                }
                let rebuilds = self.stats.rebuilds.fetch_add(1, Ordering::Relaxed) + 1;
                let waited_hits = self.stats.waited_hits.load(Ordering::Relaxed);
                tracing::info!(
                    rebuilds,
                    waited_hits,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "公开状态页快照已重建 / public status snapshot rebuilt"
                );
                drop(guard);
                Ok(snapshot)
            }
            Err(error) => {
                let failures = self.stats.failures.fetch_add(1, Ordering::Relaxed) + 1;
                tracing::warn!(
                    failures,
                    error = %error,
                    "公开状态页快照重建失败（不缓存错误，下一次请求会重试）"
                );
                // guard 在这里释放，排队的等待者可以接手重建。
                drop(guard);
                Err(error)
            }
        }
    }

    /// 立刻失效缓存：公开页的开关 / 白名单 / 费用可见性变化后必须马上生效。
    ///
    /// 递增代际与清空在同一个锁里完成：重建中的 leader 要么在 clear 之前写入
    /// （随后被这里清掉），要么在之后发现代际变化而放弃写入。
    pub fn clear(&self) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.generation.fetch_add(1, Ordering::SeqCst);
        *guard = None;
    }

    /// (rebuilds, waited_hits, wait_timeouts, failures)；只给测试断言用。
    #[cfg(test)]
    pub(crate) fn stats(&self) -> (u64, u64, u64, u64) {
        (
            self.stats.rebuilds.load(Ordering::Relaxed),
            self.stats.waited_hits.load(Ordering::Relaxed),
            self.stats.wait_timeouts.load(Ordering::Relaxed),
            self.stats.failures.load(Ordering::Relaxed),
        )
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

/// 恢复落位时目录 `fsync` 的实现；测试可注入失败/计数版本。
pub type RestoreFsync = Arc<dyn Fn(&std::path::Path) -> std::io::Result<()> + Send + Sync>;

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
    /// 公开状态页的按 IP 读取限流（与认证失败计数表完全分开）。
    pub public_read_throttle: Arc<PublicReadThrottle>,
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
    /// 概览流量快照缓存（默认 12 秒，按日汇总代际失效）。
    pub overview_traffic: OverviewTrafficCache,
    /// 管理员「服务器态势」快照缓存（30 秒，按 `(hours, bucket)` 命中）。
    pub server_health: ServerHealthCache,
    /// 自动汇率：可注入的抓取器 + 串行化手动覆盖/自动抓取的锁。
    pub fx: crate::fx::FxService,
    /// 告警去抖状态 + 投递器；未配置渠道时所有通知都是 no-op。
    pub alerts: Alerts,
    /// 版本更新检测：版本源（默认 GitHub Releases）+ 最近一次结果缓存。
    pub updates: UpdateService,
    /// 节点 TCPing 的每节点并发/频控状态；结果只在内存里，不落库。
    pub tcping: TcpingRegistry,
    /// 异地备份（WebDAV）的进程内互斥与重试参数。
    pub remote_backup: RemoteBackupRuntime,
    /// 导出 / 异地备份允许的最大数据库字节数（默认 [`DEFAULT_MAX_BACKUP_BYTES`]）。
    ///
    /// 与恢复共用同一上限；测试可以直接改小，不必真的造一个 512 MB 的库。
    pub max_backup_bytes: u64,
    /// API Token 每 token 每分钟限流（进程内）。
    pub api_token_throttle: Arc<ApiTokenRateLimiter>,
    /// API Token 的 `last_used_at` 写回缓冲；调度器批量落库。
    pub api_token_usage: Arc<ApiTokenUsage>,
    /// 恢复落位时 `fsync` 父目录的实现。
    ///
    /// 生产固定是 [`pierwave_domain::fs_security::sync_dir`]；测试注入失败/计数
    /// 版本，验证「fsync 失败不能静默成功」以及成功路径恰好同步一次。
    pub restore_fsync: RestoreFsync,
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
            public_read_throttle: Arc::new(PublicReadThrottle::from_env()),
            login_watch: LoginWatch::default(),
            session_touch: SessionTouch::default(),
            agent_release: AgentReleaseConfig::from_env(),
            latest_version: LatestVersionCache::default(),
            public_status: PublicStatusCache::default(),
            overview_traffic: OverviewTrafficCache::with_ttl(overview_cache_ttl_from_env()),
            server_health: ServerHealthCache::default(),
            fx: crate::fx::FxService::default(),
            alerts: Alerts::default(),
            updates: UpdateService::default(),
            tcping: TcpingRegistry::default(),
            remote_backup: RemoteBackupRuntime::default(),
            max_backup_bytes: max_backup_bytes_from_env(),
            api_token_throttle: Arc::new(ApiTokenRateLimiter::default()),
            api_token_usage: Arc::new(ApiTokenUsage::default()),
            restore_fsync: Arc::new(pierwave_domain::fs_security::sync_dir),
        }
    }

    /// 测试：显式设置断流开关与去抖窗口，不受环境变量影响。
    #[cfg(test)]
    pub fn with_enforcement(mut self, enabled: bool, window: Duration) -> Self {
        self.enforcement = Enforcer::new(enabled, window);
        self
    }

    /// 测试：把公开读取限流固定成指定阈值，不受环境变量影响。
    #[cfg(test)]
    pub fn with_public_rate_limit(mut self, limit: u32) -> Self {
        self.public_read_throttle = Arc::new(PublicReadThrottle::new(limit));
        self
    }

    /// 测试：把公开状态页快照的等待上限压到毫秒级。
    #[cfg(test)]
    pub fn with_public_status_wait(mut self, wait: Duration) -> Self {
        self.public_status = PublicStatusCache::with_wait(wait);
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

    // ---- 公开状态页快照：单飞（single-flight） ----

    fn snapshot(generated_at: i64) -> PublicStatusSnapshot {
        PublicStatusSnapshot {
            list: serde_json::json!({ "generated_at": generated_at }),
            series: HashMap::new(),
        }
    }

    /// 重建期间 `clear()`（例如管理员改了公开页开关）不能被旧结果覆盖。
    ///
    /// 单飞 leader 在聚合开始前拿到 generation；期间 clear 递增 generation，
    /// leader 完成后发现 generation 变了就不写缓存。否则一次设置变更会被
    /// 重建中的旧快照「回填」，隐私开关最多晚 30 秒才生效。
    #[tokio::test]
    async fn clear_during_rebuild_does_not_get_overwritten_by_the_stale_snapshot() {
        let cache = PublicStatusCache::default();
        let build_cache = cache.clone();

        let stale = cache
            .get_or_build(move || async move {
                build_cache.clear();
                Ok::<_, AppError>(snapshot(1))
            })
            .await
            .expect("leader 仍能拿到自己构建的结果");
        assert_eq!(stale.list["generated_at"], 1);
        assert!(
            cache.get().is_none(),
            "重建期间的 clear 必须生效，旧快照不能回填缓存"
        );

        // 下一次请求重新构建并正常缓存。
        let fresh = cache
            .get_or_build(|| async { Ok::<_, AppError>(snapshot(2)) })
            .await
            .unwrap();
        assert_eq!(fresh.list["generated_at"], 2);
        assert_eq!(
            cache.get().unwrap().list["generated_at"],
            2,
            "clear 之后的新构建必须能写入缓存"
        );
    }

    /// 20 个并发请求只允许触发 **一次** 聚合；其余 19 个等同一个结果。
    #[tokio::test]
    async fn concurrent_requests_rebuild_the_public_status_snapshot_once() {
        use std::sync::atomic::AtomicUsize;

        let cache = PublicStatusCache::default();
        let attempts = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(tokio::sync::Barrier::new(20));

        let mut tasks = Vec::new();
        for _ in 0..20 {
            let cache = cache.clone();
            let attempts = attempts.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                cache
                    .get_or_build(|| async move {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        // 模拟 1000 台冷缓存聚合：故意让 leader 慢，
                        // 等待者必须真的等同一个结果，而不是各自再算。
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        Ok::<_, AppError>(snapshot(42))
                    })
                    .await
            }));
        }

        let mut results = Vec::new();
        for task in tasks {
            results.push(task.await.unwrap().expect("重建期间每个请求都要拿到结果"));
        }

        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "20 个并发请求只能触发 1 次重建"
        );
        let (rebuilds, waited_hits, timeouts, failures) = cache.stats();
        assert_eq!(rebuilds, 1, "重建次数应为 1");
        assert_eq!(waited_hits, 19, "其余 19 个请求必须命中 leader 的结果");
        assert_eq!((timeouts, failures), (0, 0));
        for result in &results {
            assert_eq!(result.list["generated_at"], 42, "所有请求拿到同一份结果");
        }
    }

    /// 重建失败不缓存错误：下一次请求必须能重新尝试并成功。
    #[tokio::test]
    async fn rebuild_failure_is_not_cached_and_the_next_attempt_succeeds() {
        let cache = PublicStatusCache::default();

        let failed = cache
            .get_or_build(|| async {
                Err::<PublicStatusSnapshot, _>(AppError::Internal(anyhow::anyhow!("聚合失败")))
            })
            .await;
        assert!(failed.is_err(), "leader 必须收到真实错误");
        assert!(cache.get().is_none(), "失败的聚合绝不能写进缓存");

        let (rebuilds, waited_hits, timeouts, failures) = cache.stats();
        assert_eq!((rebuilds, waited_hits, timeouts), (0, 0, 0));
        assert_eq!(failures, 1, "失败次数必须计数");

        let ok = cache
            .get_or_build(|| async { Ok::<_, AppError>(snapshot(7)) })
            .await;
        assert!(ok.is_ok(), "失败之后的下一次请求仍要能成功");
        assert_eq!(cache.stats().0, 1, "第二次请求才是一次真正的重建");
        assert!(cache.get().is_some());
    }

    /// 等待者超时返回 503，而不是各自重算把数据库打穿；leader 完成后缓存照常可用。
    #[tokio::test]
    async fn waiter_times_out_with_503_instead_of_recomputing() {
        let cache = PublicStatusCache::with_wait(Duration::from_millis(50));
        let started = Arc::new(tokio::sync::Notify::new());

        let leader = {
            let cache = cache.clone();
            let started = started.clone();
            tokio::spawn(async move {
                cache
                    .get_or_build(|| async move {
                        started.notify_one();
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        Ok::<_, AppError>(snapshot(1))
                    })
                    .await
            })
        };
        started.notified().await;

        let error = match cache
            .get_or_build(|| async { Ok::<_, AppError>(snapshot(2)) })
            .await
        {
            Ok(_) => panic!("leader 仍占着锁时，等待者必须超时返回 503"),
            Err(error) => error,
        };
        match error {
            AppError::Coded { status, code, .. } => {
                assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
                assert_eq!(code, "public_status.overloaded");
            }
            other => panic!("必须是 503 public_status.overloaded，实际 {other:?}"),
        }
        assert_eq!(cache.stats().2, 1, "必须记录一次等待超时");

        assert!(leader.await.unwrap().is_ok());
        assert!(cache.get().is_some(), "leader 完成后缓存必须可用");
    }

    // ---- 概览流量快照缓存 ----

    fn traffic_snapshot(today: i64) -> TrafficSnapshot {
        TrafficSnapshot {
            traffic_today: today,
            ..Default::default()
        }
    }

    /// 命中条件只有 `days` 与 TTL：计费入账（generation 变化）不参与 key。
    ///
    /// 这是生产策略 A 的核心：持续上报时缓存仍能命中，代价是流量数字最多
    /// 陈旧一个 TTL。`clear()` 是管理员动作的显式失效，不用于常规写路径。
    #[tokio::test]
    async fn overview_cache_is_keyed_by_days_and_expires_by_ttl() {
        let cache = OverviewTrafficCache::with_ttl(Duration::from_millis(60));
        assert!(cache.get(7).is_none(), "空缓存必须 miss");
        cache.put(7, traffic_snapshot(1));

        assert_eq!(cache.get(7).unwrap().traffic_today, 1);
        assert_eq!(cache.get(7).unwrap().traffic_today, 1);
        cache.put(7, traffic_snapshot(2));
        assert_eq!(cache.get(7).unwrap().traffic_today, 2, "同 days 覆盖旧值");
        assert!(cache.get(30).is_none(), "days 不同必须 miss");

        cache.clear();
        assert!(cache.get(7).is_none(), "clear 之后必须 miss");

        cache.put(7, traffic_snapshot(3));
        tokio::time::sleep(Duration::from_millis(90)).await;
        assert!(cache.get(7).is_none(), "超过 TTL 必须 miss");
        let (hits, misses) = cache.stats();
        assert_eq!(hits, 3, "三次命中");
        assert_eq!(misses, 4, "空缓存 / days 不同 / clear / TTL 各一次");
    }

    /// 旧 `(days, generation)` key 的行为：generation 一变就 miss。
    ///
    /// 路由层用真实后台写入验证命中率；这里只锁定底层 lookup 的语义，
    /// 防止有人把 generation 又塞回生产 key。
    #[tokio::test]
    async fn generation_keyed_lookup_misses_when_generation_changes() {
        let cache = OverviewTrafficCache::with_ttl(Duration::from_secs(12));
        cache.put_generation_keyed(7, 1, traffic_snapshot(1));
        assert!(cache.get_generation_keyed(7, 1).is_some());
        assert!(
            cache.get_generation_keyed(7, 2).is_none(),
            "generation 变化必须 miss"
        );
        cache.put_generation_keyed(7, 2, traffic_snapshot(2));
        assert_eq!(cache.get_generation_keyed(7, 2).unwrap().traffic_today, 2);
    }

    /// `PIERWAVE_OVERVIEW_CACHE_SECS=0` 的禁用语义：永远不命中，也不占内存。
    #[tokio::test]
    async fn overview_cache_with_zero_ttl_never_hits() {
        let cache = OverviewTrafficCache::with_ttl(Duration::ZERO);
        assert!(cache.ttl().is_zero());
        cache.put(7, traffic_snapshot(1));
        assert!(cache.get(7).is_none());
        let (hits, misses) = cache.stats();
        assert_eq!((hits, misses), (0, 1));
    }
}
