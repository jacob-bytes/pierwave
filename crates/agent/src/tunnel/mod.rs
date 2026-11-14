//! P16 隧道：TLS + 自有 CA（默认）与 Noise/PSK 两种安全模式。
//!
//! 一条隧道 = 一条 TCP +（TLS 或 Noise）连接，不共享、不复用、不做多路复用。
//! 两种模式共用同一个监听端口，由握手首字节分流（见 [`modes`]）：
//!
//! ```text
//! [0x01] TLS ClientHello
//! [0x02] Noise 握手消息 1
//! ```
//!
//! 连接建立后：
//!
//! 1. 客户端发 [`handshake::ClientHello`]（`hop_id` + `proof`）；
//! 2. 服务端校验版本、hop、±300s 时间戳窗口、HMAC proof 与重放缓存，
//!    回 [`handshake::ServerHello`]；
//! 3. 客户端发首帧 DATA，payload 是 SOCKS5 风格目标地址；
//! 4. 服务端连目标，用 [`tokio::io::copy_bidirectional_with_sizes`] 双向搬运；
//! 5. 帧层负责把字节流切成 DATA / CLOSE / PING（见 [`framing`]）。
//!
//! # 本模块的范围
//!
//! 只交付 P16.1 的协议骨架，**没有**接入 `DesiredState`、`ForwardEngine`、
//! 心跳或 UI（见 docs/PLAN.md 的 P16 分阶段表）。因此它暂时没有来自 `main`
//! 的调用点，所有入口由本文件的测试覆盖；`dead_code` 是「未接线」而不是
//! 「没写完」。接线点在后续的 `TunnelSupervisor`，届时删除模块级 allow。
//!
//! # 安全边界
//!
//! - TLS 只由 rustls 实现，Noise 只由 `snow` 实现，本模块不实现任何 AEAD/KDF；
//! - TLS 客户端只信任**显式传入**的 CA，`None` 表示空信任根（fail-closed），
//!   不存在回退 `webpki-roots` 或 `insecure` 开关；
//! - Noise 静态密钥对与 PSK 都由 `hop_secret` 经 HMAC 域分离派生，两端可独立
//!   复现；临时密钥由 `snow` 每次握手生成，静态材料只用于认证；
//! - TLS 握手版本精确匹配，失败回 `ServerHello{ok:false, reason}` 后立即断开；
//! - 未知首字节 fail-closed；帧长度硬上限 64 KiB，超限断开并记 error。
//!
//! # 关闭语义
//!
//! - 一端 EOF（TLS close_notify / TCP FIN）→ 对端 `shutdown` 写方向 →
//!   等另一个方向自然结束。`copy_bidirectional` 本身就按这个顺序收尾，
//!   帧层只在两个方向上各加一个泵；
//! - CLOSE 帧是**立即断开**：不排空、不等对端，直接丢弃目标连接。

mod adapter;
mod framing;
mod handshake;
mod modes;
// P16.3 的 UDP 中继（QUIC datagram）：出口侧（QUIC server）在本模块，
// 入口侧（本地 UDP 会话表）在 `udp_dialer`。TCP 路径完全不经过这两个模块。
mod quic;
mod supervisor;
mod udp_dialer;
mod whitelist;

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use rustls::pki_types::{
    CertificateDer, PrivateKeyDer, PrivatePkcs1KeyDer, PrivatePkcs8KeyDer, PrivateSec1KeyDer,
    ServerName,
};
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_rustls::{TlsAcceptor, TlsConnector};

use self::adapter::FrameIo;
use self::handshake::{ClientHello, HandshakeError, ReplayCache, ServerHello};
use self::quic::{
    QuicUdpClient, QuicUdpLimits, QuicUdpServer, QuicUdpServerConfig, QuicUdpStatsHandle,
};
// 对外的帧/地址类型：上层（TunnelSupervisor）只需要这几个名字。
use self::framing::FrameError;
pub use self::framing::{Frame, FrameKind, TargetAddr, MAX_FRAME_PAYLOAD};
pub use self::modes::{
    BoxedStream, NoiseHop, NoiseMaterial, NoiseStream, TunnelSecurity, DEFAULT_REKEY_INTERVAL,
};
pub use self::supervisor::TunnelSupervisor;
pub use self::whitelist::TargetRule;

/// 默认最大并发连接数。10k 并发 × 单连接 ~100KB 会吃掉 1GB，
/// 所以必须有硬上限兜住（P16 设计目标见 docs/PLAN.md §5）。
pub const DEFAULT_MAX_CONNECTIONS: usize = 8192;

/// TLS 握手（含 ClientHello/ServerHello）的总预算。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// 连接目标的预算；超时按「目标不可达」处理，避免客户端永久挂起。
const TARGET_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// accept 出错后的退避，避免 fd 耗尽时空转烧 CPU。
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
/// 连接数超限的 warn 节流周期。
const REJECT_WARN_INTERVAL: Duration = Duration::from_secs(30);

/// 搬运缓冲区：32 KiB，而不是 `copy_bidirectional` 默认的 8 KiB。
///
/// 原因：rustls 的一条 TLS record 最大 16 KiB，8 KiB 缓冲会让每个 record
/// 至少两次 syscall/加密调用；32 KiB 正好覆盖两条 record，吞吐测试里收益
/// 最大（docs/PLAN.md §5 把这条列为第一优化项）。不取 64 KiB 是因为
/// 每连接要占两份（双向各一），64 KiB 会把单连接常驻内存翻倍，而 32 KiB
/// 已足够让 TLS 记录写满，边际收益很低。
const COPY_BUF_SIZE: usize = 32 * 1024;

/// 服务端配置。`hops` 是 `hop_id -> hop_secret` 的预共享密钥表。
pub struct TunnelServerConfig {
    /// 监听地址；端口写 0 时由内核分配（测试用）。
    pub bind: std::net::SocketAddr,
    /// 同时支持的安全模式。
    ///
    /// 监听端始终按握手首字节分流：`Tls` 要求绑定前能加载证书私钥，`Noise`
    /// 不要求证书但要求 `hops` 非空。若同时提供了证书与 hop，两种客户端都能
    /// 连上同一个端口；只提供其中一种时，另一种首字节会被明确拒绝。
    pub security: TunnelSecurity,
    /// 服务端证书链（PEM，可含多段 CERTIFICATE）。Noise-only 模式可留空。
    pub cert_path: PathBuf,
    /// 服务端私钥（PEM：PKCS#8 / PKCS#1 / SEC1 均可）。Noise-only 模式可留空。
    pub key_path: PathBuf,
    /// 本机允许接入的跳。未知 hop_id 一律拒绝。
    pub hops: HashMap<String, Vec<u8>>,
    /// 并发连接硬上限；超限拒绝新连接，不踢在线连接。
    pub max_connections: usize,
    /// 允许连接的目标白名单；空 = 拒绝一切（fail closed）。
    pub allowed_targets: Vec<TargetRule>,
    /// 中间跳（3–6 跳链）的内嵌 dialer；`None` = 2 跳链的出口 Listener。
    ///
    /// 有值时 Listener 收到首帧、通过白名单后**不** `connect_target`，而是先用
    /// 这个 dialer 向下一跳建一条新的加密隧道，再帧层到帧层双向搬运。
    pub downstream: Option<DownstreamDialer>,
}

/// 中间跳的内嵌 dialer：一个已经解析好地址、加载好信任根的 [`TunnelClient`]，
/// 加上它每连接请求的目标（downstream 白名单的最后一条 = 链目标）。
///
/// 与入口 Dialer 共用同一套 TLS/Noise 与白名单语义，区别只在于它的连接来自
/// 上一跳的隧道而不是本地客户端。
pub struct DownstreamDialer {
    client: Arc<TunnelClient>,
    target: TargetAddr,
}

impl DownstreamDialer {
    pub fn new(client: Arc<TunnelClient>, target: TargetAddr) -> Self {
        Self { client, target }
    }
}

impl fmt::Debug for DownstreamDialer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // client 里有 hop_secret：只打目标地址，绝不打印密钥或握手材料。
        f.debug_struct("DownstreamDialer")
            .field("target", &self.target)
            .finish_non_exhaustive()
    }
}

impl TunnelServerConfig {
    pub fn new(
        bind: std::net::SocketAddr,
        cert_path: impl Into<PathBuf>,
        key_path: impl Into<PathBuf>,
        hops: HashMap<String, Vec<u8>>,
    ) -> Self {
        Self {
            bind,
            security: TunnelSecurity::Tls,
            cert_path: cert_path.into(),
            key_path: key_path.into(),
            hops,
            max_connections: DEFAULT_MAX_CONNECTIONS,
            allowed_targets: Vec::new(),
            downstream: None,
        }
    }

    /// Noise-only 监听：不需要证书与私钥。
    ///
    /// `TunnelSupervisor` 在 `TunnelSpec.security = Noise` 时走这个构造器，
    /// 证书路径留空是合法状态（不会被读取）。
    pub fn noise(bind: std::net::SocketAddr, hops: HashMap<String, Vec<u8>>) -> Self {
        Self {
            bind,
            security: TunnelSecurity::Noise,
            cert_path: PathBuf::new(),
            key_path: PathBuf::new(),
            hops,
            max_connections: DEFAULT_MAX_CONNECTIONS,
            allowed_targets: Vec::new(),
            downstream: None,
        }
    }
}

// Debug 会打日志：hop_secret 绝不能出现在日志里，只列 hop_id。
impl fmt::Debug for TunnelServerConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TunnelServerConfig")
            .field("bind", &self.bind)
            .field("security", &self.security)
            .field("cert_path", &self.cert_path)
            .field("key_path", &self.key_path)
            .field("hops", &self.hops.keys().collect::<Vec<_>>())
            .field("max_connections", &self.max_connections)
            .field("allowed_targets", &self.allowed_targets)
            .field("downstream", &self.downstream)
            .finish()
    }
}

/// 心跳/监控可读的连接计数快照。
///
/// P16.1 先不进 `crates/proto`；等隧道真正接入 supervisor 后，由心跳把
/// 这份快照映射到现有 `ForwardStatus`（或新字段），不改已验收的链路。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TunnelStats {
    /// 当前占用连接槽的连接数（含握手中）。
    pub active: usize,
    /// 累计接纳的连接数（超限拒绝的不算）。
    pub total: u64,
    /// 累计因 `max_connections` 拒绝的连接数。
    pub rejected: u64,
    /// 累计因目标不在白名单被拒绝的连接数。
    pub denied: u64,
}

/// 无锁读取 [`TunnelStats`] 的句柄；心跳线程只 clone 这个。
#[derive(Debug, Clone)]
pub struct TunnelStatsHandle {
    metrics: Arc<Metrics>,
}

impl TunnelStatsHandle {
    pub fn snapshot(&self) -> TunnelStats {
        TunnelStats {
            active: self.metrics.active.load(Ordering::Acquire),
            total: self.metrics.total.load(Ordering::Relaxed),
            rejected: self.metrics.rejected.load(Ordering::Relaxed),
            denied: self.metrics.denied.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Default)]
struct Metrics {
    active: AtomicUsize,
    total: AtomicU64,
    rejected: AtomicU64,
    denied: AtomicU64,
    /// 上次打「连接数超限」warn 的时间；30s 内只打一次，避免刷爆日志。
    last_reject_warn: Mutex<Option<Instant>>,
    /// 上次打「目标不在白名单」warn 的时间；同样 30s 节流。
    last_denied_warn: Mutex<Option<Instant>>,
}

impl Metrics {
    /// 尝试占用一个连接槽。`None` = 已到上限，调用方负责关掉 TCP。
    fn admit(self: &Arc<Self>, max_connections: usize) -> Option<ActiveGuard> {
        // 先加后判：并发下最多短暂多占一个槽，但绝不会超过上限放行。
        let previous = self.active.fetch_add(1, Ordering::AcqRel);
        if previous >= max_connections {
            self.active.fetch_sub(1, Ordering::AcqRel);
            self.reject(max_connections);
            return None;
        }
        self.total.fetch_add(1, Ordering::Relaxed);
        Some(ActiveGuard {
            metrics: Arc::clone(self),
        })
    }

    /// 目标被白名单拒绝：计数 + 30s 节流 warn。
    fn deny(&self, target: &TargetAddr, peer: std::net::SocketAddr) {
        self.denied.fetch_add(1, Ordering::Relaxed);
        let mut last = self
            .last_denied_warn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        if reject_warn_due(*last, now) {
            *last = Some(now);
            tracing::warn!(
                %peer,
                ?target,
                "隧道目标不在白名单内，拒绝并关闭 / tunnel target is not allowlisted, closing（{}s 内只记一次 / logged once per {}s）",
                REJECT_WARN_INTERVAL.as_secs(),
                REJECT_WARN_INTERVAL.as_secs()
            );
        }
    }

    fn reject(&self, max_connections: usize) {
        self.rejected.fetch_add(1, Ordering::Relaxed);
        let mut last = self
            .last_reject_warn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        if reject_warn_due(*last, now) {
            *last = Some(now);
            tracing::warn!(
                max_connections,
                "隧道连接数已达上限，拒绝新连接 / tunnel connection limit reached, rejecting new connection（{}s 内只记一次 / logged once per {}s）",
                REJECT_WARN_INTERVAL.as_secs(),
                REJECT_WARN_INTERVAL.as_secs()
            );
        }
    }
}

/// 30 秒 warn 节流判定；抽成纯函数方便在测试里覆盖边界。
fn reject_warn_due(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|previous| now.saturating_duration_since(previous) >= REJECT_WARN_INTERVAL)
}

/// 连接槽的 RAII 守卫：任务结束（含 panic）都会归还名额。
struct ActiveGuard {
    metrics: Arc<Metrics>,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.metrics.active.fetch_sub(1, Ordering::AcqRel);
    }
}

struct ServerInner {
    /// `None` = 本监听没有加载证书，TLS 首字节会被明确拒绝。
    tls: Option<TlsAcceptor>,
    /// Noise 模式可接受的 hop（含由 hop_secret 派生的静态材料）。
    noise_hops: Vec<NoiseHop>,
    hops: HashMap<String, Vec<u8>>,
    max_connections: usize,
    metrics: Arc<Metrics>,
    /// 与 UDP/QUIC 路径共用：同一个 proof 不能既走 TCP 又走 QUIC。
    replay: Arc<Mutex<ReplayCache>>,
    allowed_targets: Vec<TargetRule>,
    /// 内核实际分配的监听地址（`bind` 里写端口 0 时也能读回来）。
    /// UDP 中继要绑**同一个端口**，所以必须保存实际值而不是配置里的 0。
    bound_addr: std::net::SocketAddr,
    /// 启用 UDP 中继时要重新加载证书（TCP 的 `TlsAcceptor` 不暴露配置）。
    cert_path: PathBuf,
    key_path: PathBuf,
    /// 中间跳的下一跳 dialer；`None` = 出口 Listener（2 跳链）。
    downstream: Option<DownstreamDialer>,
}

/// 隧道服务端。`bind` 后由 `serve` 跑 accept 循环；本类型可 clone 进任务。
#[derive(Clone)]
pub struct TunnelServer {
    inner: Arc<ServerInner>,
    /// `Some` = 同一个端口上还跑着一个 QUIC UDP 中继（P16.3）。
    quic: Option<Arc<QuicUdpServer>>,
}

impl TunnelServer {
    /// 加载证书/私钥并绑定监听。证书或私钥不合法时**在绑定前**失败，
    /// 避免出现「端口占着、但永远握不上手」的假监听。
    ///
    /// TLS 与 Noise 共用这个监听：证书存在就能接 TLS 客户端，`hops` 非空
    /// 就能接 Noise 客户端。`security` 决定绑定前必须满足哪一组凭据。
    pub async fn bind(config: TunnelServerConfig) -> Result<(Self, TcpListener)> {
        validate_server_config(&config)?;
        let tls = load_optional_server_tls(&config)?;
        // 没有证书时监听的有效模式必然是 Noise（TLS 首字节会被明确拒绝）。
        let effective_security = if tls.is_some() {
            config.security
        } else {
            TunnelSecurity::Noise
        };
        let noise_hops = config
            .hops
            .iter()
            .map(|(hop_id, secret)| NoiseHop::new(hop_id.clone(), secret))
            .collect::<Vec<_>>();
        let listener = TcpListener::bind(config.bind).await.with_context(|| {
            format!(
                "绑定隧道监听 {} 失败 / failed to bind tunnel listener",
                config.bind
            )
        })?;
        let bound_addr = listener.local_addr().unwrap_or(config.bind);
        tracing::info!(
            bind = %bound_addr,
            security = %effective_security,
            tls = tls.is_some(),
            hops = config.hops.len(),
            "隧道监听已就绪 / tunnel listener ready"
        );

        let server = Self {
            inner: Arc::new(ServerInner {
                tls,
                noise_hops,
                hops: config.hops,
                max_connections: config.max_connections,
                metrics: Arc::new(Metrics::default()),
                replay: Arc::new(Mutex::new(ReplayCache::new())),
                allowed_targets: config.allowed_targets,
                bound_addr,
                cert_path: config.cert_path,
                key_path: config.key_path,
                downstream: config.downstream,
            }),
            quic: None,
        };
        Ok((server, listener))
    }

    pub fn stats_handle(&self) -> TunnelStatsHandle {
        TunnelStatsHandle {
            metrics: Arc::clone(&self.inner.metrics),
        }
    }

    /// 在**同一个端口**（UDP）上启用 QUIC datagram 中继（P16.3）。
    ///
    /// `target_rules` 是 UDP 目标白名单：空列表拒绝一切（fail closed）；命中
    /// 规则后才 `connect` 目标。TCP 路径（TLS/Noise + 帧协议）一字不改。
    ///
    /// 只有 TLS 模式支持：Noise 的 UDP 路径本轮不做，调用会明确失败，不会
    /// 悄悄退化成明文或跳过认证。
    ///
    pub async fn with_udp(self, target_rules: Vec<TargetRule>) -> Result<Self> {
        self.attach_udp(target_rules, QuicUdpLimits::default())
            .await
    }

    /// 测试用：与 [`Self::with_udp`] 相同，但注入会话超时 / 上限。
    #[cfg(test)]
    pub(crate) async fn with_udp_limits(
        self,
        target_rules: Vec<TargetRule>,
        limits: QuicUdpLimits,
    ) -> Result<Self> {
        self.attach_udp(target_rules, limits).await
    }

    async fn attach_udp(
        mut self,
        target_rules: Vec<TargetRule>,
        limits: QuicUdpLimits,
    ) -> Result<Self> {
        // QUIC 的 TLS 1.3 证书来自 P16.1 的 CA/属证书；Noise-only 监听没有
        // 证书，本轮不能开 UDP。失败时 TCP 监听保持原样，由调用方决定是否继续。
        if self.inner.cert_path.as_os_str().is_empty() || self.inner.key_path.as_os_str().is_empty()
        {
            bail!(
                "UDP 中继需要 TLS 证书；Noise 的 UDP 路径本轮不做 / UDP relay requires TLS certificates; Noise over UDP is not implemented yet"
            );
        }
        let server = QuicUdpServer::bind(QuicUdpServerConfig {
            // 与 TCP 同 IP、同端口：QUIC 是 UDP，和 TCP 监听可以共存。
            bind: self.inner.bound_addr,
            cert_path: self.inner.cert_path.clone(),
            key_path: self.inner.key_path.clone(),
            hops: self.inner.hops.clone(),
            allowed_targets: target_rules,
            limits,
            tcp_metrics: Arc::clone(&self.inner.metrics),
            max_connections: self.inner.max_connections,
        })?;
        self.quic = Some(Arc::new(server));
        Ok(self)
    }

    /// UDP 中继的计数句柄；没启用 UDP 时为 `None`。
    pub fn udp_stats_handle(&self) -> Option<QuicUdpStatsHandle> {
        self.quic.as_ref().map(|quic| quic.stats_handle())
    }

    /// 测试用：UDP 中继实际绑定的地址（验证与 TCP 端口一致）。
    #[cfg(test)]
    pub(crate) fn udp_bound_addr(&self) -> Option<std::net::SocketAddr> {
        self.quic.as_ref().and_then(|quic| quic.bound_addr())
    }

    /// TCP accept 循环 +（可选）QUIC accept 循环，永不正常返回。
    ///
    /// 两条循环放在同一个 future 里而不是 `tokio::spawn`：调用方 abort 这个
    /// 任务时，QUIC endpoint 会一起被 drop（UDP 端口立即释放），不会留下一个
    /// 脱离监管的后台任务。
    pub async fn serve(self, listener: TcpListener) -> io::Result<()> {
        match self.quic.clone() {
            Some(quic) => {
                let tcp = self.serve_tcp(listener);
                tokio::pin!(tcp);
                tokio::select! {
                    result = &mut tcp => result,
                    () = quic.serve() => tcp.await,
                }
            }
            None => self.serve_tcp(listener).await,
        }
    }

    /// TCP accept 循环；每条连接一个 task，连接槽由 RAII 守卫归还。
    async fn serve_tcp(self, listener: TcpListener) -> io::Result<()> {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    tracing::warn!("接受隧道连接失败 / tunnel accept failed: {error}");
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                    continue;
                }
            };

            // 超限在 TLS 握手前就拒绝：不为必然失败的连接付加密开销。
            let Some(guard) = self.inner.metrics.admit(self.inner.max_connections) else {
                drop(stream);
                continue;
            };

            let server = self.clone();
            tokio::spawn(async move {
                if let Err(error) = server.handle_connection(stream, peer).await {
                    tracing::debug!(peer = %peer, "隧道连接结束 / tunnel connection ended: {error:#}");
                }
                drop(guard);
            });
        }
    }

    async fn handle_connection(
        &self,
        mut stream: TcpStream,
        peer: std::net::SocketAddr,
    ) -> Result<()> {
        // 隧道帧多为交互小包；Nagle 会把它们攒成 40ms 的延迟。
        let _ = stream.set_nodelay(true);

        // 首字节决定底层：0x01/0x16 → TLS，0x02 → Noise。peek 不消费字节，
        // 所以 TLS 的 ClientHello 可以原样交给 rustls；Noise 分支在握手前
        // 显式吃掉模式字节。
        let mode = match timeout(HANDSHAKE_TIMEOUT, peek_mode(&mut stream)).await {
            Ok(Ok(mode)) => mode,
            Ok(Err(error)) => {
                bail!("读取隧道模式字节失败 / failed to read tunnel mode byte: {error}")
            }
            Err(_) => bail!(
                "等待隧道模式字节超时（{}s）/ timed out waiting for the tunnel mode byte after {}s",
                HANDSHAKE_TIMEOUT.as_secs(),
                HANDSHAKE_TIMEOUT.as_secs()
            ),
        };

        match mode {
            modes::MODE_TLS => {
                consume_mode_byte(&mut stream, modes::MODE_TLS).await?;
                self.serve_tls(stream, peer).await
            }
            modes::TLS_CLIENT_HELLO => {
                // 兼容不发送模式字节的旧客户端：首字节就是 TLS record type。
                self.serve_tls(stream, peer).await
            }
            modes::MODE_NOISE => {
                consume_mode_byte(&mut stream, modes::MODE_NOISE).await?;
                let accepted = timeout(
                    HANDSHAKE_TIMEOUT,
                    modes::server_handshake(&mut stream, &self.inner.noise_hops),
                )
                .await
                .map_err(|_| {
                    anyhow!(
                        "Noise 握手超时（{}s）/ Noise handshake timed out after {}s",
                        HANDSHAKE_TIMEOUT.as_secs(),
                        HANDSHAKE_TIMEOUT.as_secs()
                    )
                })?
                .context("Noise 握手失败 / Noise handshake failed")?;
                let (hop, transport) = accepted;
                tracing::debug!(
                    peer = %peer,
                    hop_id = %hop.hop_id,
                    "Noise 隧道握手通过 / Noise tunnel handshake accepted"
                );
                let noise = NoiseStream::start(
                    stream,
                    transport,
                    hop.material,
                    false,
                    DEFAULT_REKEY_INTERVAL,
                );
                self.serve_frames(Box::new(noise), peer).await
            }
            other => bail!(
                "未知的隧道首字节 0x{other:02x}（期望 0x01 TLS 或 0x02 Noise）/ unknown tunnel mode byte 0x{other:02x} (expected 0x01 TLS or 0x02 Noise)"
            ),
        }
    }

    /// TLS 分支：TLS 握手 + HMAC hop 认证，然后交给统一帧层。
    async fn serve_tls(&self, stream: TcpStream, peer: std::net::SocketAddr) -> Result<()> {
        let mut tls = self.accept_tls(stream).await?;
        if let Err(error) = self.authenticate(&mut tls, peer).await {
            // 失败也回 ServerHello{ok:false}，客户端能拿到可读原因；随后断开。
            let reply = ServerHello::reject(error.to_string());
            let _ = timeout(HANDSHAKE_TIMEOUT, reply.write(&mut tls)).await;
            return Err(anyhow!(
                "隧道握手被拒绝 / tunnel handshake rejected: {error}"
            ));
        }
        ServerHello::accept().write(&mut tls).await?;
        self.serve_frames(Box::new(tls), peer).await
    }

    /// 把已认证的连接交给统一的帧/转发层。
    async fn serve_frames(
        &self,
        mut stream: BoxedStream,
        peer: std::net::SocketAddr,
    ) -> Result<()> {
        // 首帧必须是地址帧；CLOSE 直接结束，PING 说明客户端实现有问题。
        // 握手完成后客户端应立刻发地址，不能无限期占着连接槽。
        let first = match timeout(HANDSHAKE_TIMEOUT, read_frame_logged(&mut stream, peer)).await {
            Ok(result) => result?,
            Err(_) => bail!(
                "等待首帧超时（{}s）/ timed out waiting for the first frame after {}s",
                HANDSHAKE_TIMEOUT.as_secs(),
                HANDSHAKE_TIMEOUT.as_secs()
            ),
        };
        let first = match first {
            Some(frame) => frame,
            None => bail!("客户端在首帧前关闭 / client closed before the first frame"),
        };
        let (target, consumed) = match first.kind {
            FrameKind::Data => TargetAddr::decode_prefix(&first.payload)
                .context("首帧目标地址非法 / invalid target address in the first frame")?,
            FrameKind::Close => return Ok(()),
            FrameKind::Ping => bail!(
                "首帧必须是地址帧，不能是 PING / the first frame must carry the target address, not PING"
            ),
        };
        // 首帧地址之后允许跟初始数据（当前客户端不发，协议预留）。
        let initial = first.payload[consumed..].to_vec();

        // 白名单必须在这里、在 connect_target 之前判定：拒绝时绝不发起任何连接。
        // 空列表 = 拒绝一切（fail closed）。
        if !whitelist::allows(&self.inner.allowed_targets, &target) {
            self.inner.metrics.deny(&target, peer);
            // 明确回 CLOSE，客户端能立即失败而不是等 TLS 超时。
            let _ = framing::write_frame(&mut stream, FrameKind::Close, &[]).await;
            return Err(anyhow!(
                "目标 {:?} 不在白名单内 / target is not allowlisted",
                target
            ));
        }

        // 中间跳：白名单校验通过后不直连目标，而是向下一跳建一条**新的**
        // 加密隧道，帧层到帧层搬运。`downstream` 缺失的中间跳根本不会启动
        // （见 supervisor），所以这里不存在「悄悄直连」的分支。
        if let Some(downstream) = self.inner.downstream.as_ref() {
            let connection = match downstream.client.connect(&downstream.target).await {
                Ok(connection) => connection,
                Err(error) => {
                    // 下一跳不可达：明确回 CLOSE，让上一跳/客户端立即失败，
                    // 绝不能退回 connect_target 或用明文继续。
                    let _ = framing::write_frame(&mut stream, FrameKind::Close, &[]).await;
                    return Err(error.context(format!(
                        "中间跳连接下一跳 {:?} 失败 / middle hop failed to connect the next hop",
                        downstream.target
                    )));
                }
            };
            tracing::debug!(
                peer = %peer,
                target = ?downstream.target,
                "中间跳已连上下一跳，开始帧层搬运 / middle hop connected to the next hop, relaying frames"
            );
            return relay_frames(stream, connection, initial, peer).await;
        }

        let upstream = match connect_target(&target).await {
            Ok(upstream) => upstream,
            Err(error) => {
                // 明确告诉客户端目标不可达，而不是让它等 TLS 超时。
                let _ = framing::write_frame(&mut stream, FrameKind::Close, &[]).await;
                return Err(error);
            }
        };

        forward(stream, upstream, initial, peer).await
    }

    /// 只做 TLS 握手；证书未加载时给出可读错误（fail closed，不回退明文）。
    async fn accept_tls(
        &self,
        stream: TcpStream,
    ) -> Result<tokio_rustls::server::TlsStream<TcpStream>> {
        let acceptor = self.inner.tls.as_ref().ok_or_else(|| {
            anyhow!(
                "本监听未启用 TLS（缺少证书/私钥）/ TLS is not enabled on this listener (missing certificate/key)"
            )
        })?;
        match timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
            Ok(Ok(tls)) => Ok(tls),
            Ok(Err(error)) => bail!("TLS 握手失败 / TLS handshake failed: {error}"),
            Err(_) => bail!(
                "TLS 握手超时（{}s）/ TLS handshake timed out after {}s",
                HANDSHAKE_TIMEOUT.as_secs(),
                HANDSHAKE_TIMEOUT.as_secs()
            ),
        }
    }

    /// 版本 → hop → 时间窗 → proof → 重放。顺序很重要：先做便宜且无状态的
    /// 检查，再做 HMAC；只有 HMAC 通过才碰重放缓存（否则未认证字节可塞满缓存）。
    async fn authenticate(
        &self,
        tls: &mut tokio_rustls::server::TlsStream<TcpStream>,
        peer: std::net::SocketAddr,
    ) -> Result<(), HandshakeError> {
        let hello = timeout(HANDSHAKE_TIMEOUT, ClientHello::read(tls))
            .await
            .map_err(|_| {
                HandshakeError::Io(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "等待 ClientHello 超时 / timed out waiting for ClientHello",
                ))
            })??;

        if hello.version != handshake::PROTOCOL_VERSION {
            return Err(HandshakeError::UnsupportedVersion(hello.version));
        }
        let secret = self
            .inner
            .hops
            .get(&hello.hop_id)
            .ok_or(HandshakeError::UnknownHop)?;
        handshake::check_timestamp(hello.timestamp_secs, handshake::unix_now())?;
        if !hello.verify(secret) {
            return Err(HandshakeError::BadProof);
        }

        let mut replay = self
            .inner
            .replay
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        replay.check_and_insert(hello.proof, Instant::now())?;
        tracing::debug!(peer = %peer, hop_id = %hello.hop_id, "隧道握手通过 / tunnel handshake accepted");
        Ok(())
    }
}

/// 帧层与目标 TCP 之间的双向搬运。
///
/// `FrameIo` 直接把帧 payload 暴露成字节流，因此这里只需要一个
/// `copy_bidirectional_with_sizes`，不再有 duplex 和两个泵任务：
///
/// ```text
/// 客户端 <--DATA/CLOSE 帧--> FrameIo <--copy_bidirectional--> 目标 TCP
/// ```
///
/// `copy_bidirectional` 负责半关语义：一边 EOF 时对另一边的写方向
/// `shutdown`（FrameIo 的写方向会发 CLOSE 帧）。额外的 `select!` 只处理
/// 「客户端显式 CLOSE」：那是立即断开，不能等目标方向自然 EOF。
async fn forward(
    stream: BoxedStream,
    mut upstream: TcpStream,
    initial: Vec<u8>,
    peer: std::net::SocketAddr,
) -> Result<()> {
    if !initial.is_empty() {
        upstream.write_all(&initial).await?;
    }

    let mut framed = FrameIo::new(stream);
    let close = framed.close_notify();
    let already_closed = framed.saw_close();
    let copy = tokio::io::copy_bidirectional_with_sizes(
        &mut upstream,
        &mut framed,
        COPY_BUF_SIZE,
        COPY_BUF_SIZE,
    );
    tokio::pin!(copy);

    tokio::select! {
        biased;
        _ = async {
            if !already_closed {
                close.notified().await;
            }
        } => {
            tracing::debug!(peer = %peer, "客户端发送 CLOSE，立即断开 / client sent CLOSE, closing immediately");
            Ok(())
        }
        result = &mut copy => {
            match result {
                Ok((client_to_target, target_to_client)) => {
                    tracing::debug!(
                        peer = %peer,
                        client_to_target,
                        target_to_client,
                        "隧道双向搬运结束 / tunnel copy finished"
                    );
                    Ok(())
                }
                Err(error) => {
                    // 帧层（超大长度/未知类型/半帧）的错误必须留下 error 日志；
                    // 普通对端断开只在上层按 debug 处理。
                    if error.kind() == io::ErrorKind::InvalidData {
                        tracing::error!(
                            peer = %peer,
                            %error,
                            "隧道帧非法，断开连接 / invalid tunnel frame, disconnecting"
                        );
                    }
                    Err(error.into())
                }
            }
        }
    }
}

/// 帧层 ↔ 帧层搬运（多跳链的中间跳）。
///
/// 两条连接各自完成过 TLS/Noise 握手：`inbound` 来自上一跳，`outbound` 是
/// 本跳用 `downstream` 新建立的到下一跳的加密隧道。这里只搬 DATA 帧的
/// payload；PING 由各自的 [`FrameIo`] 丢弃；CLOSE 仍是「立即断开」，
/// 半关映射为对端写方向的 `shutdown`（TLS close_notify / Noise 半关）。
async fn relay_frames(
    inbound: BoxedStream,
    outbound: TunnelConnection,
    initial: Vec<u8>,
    peer: std::net::SocketAddr,
) -> Result<()> {
    let mut inbound = FrameIo::new(inbound);
    let mut outbound = outbound.into_frame_io();
    if !initial.is_empty() {
        outbound.write_all(&initial).await?;
    }

    let inbound_close = inbound.close_notify();
    let inbound_closed = inbound.saw_close();
    let outbound_close = outbound.close_notify();
    let outbound_closed = outbound.saw_close();
    let copy = tokio::io::copy_bidirectional_with_sizes(
        &mut inbound,
        &mut outbound,
        COPY_BUF_SIZE,
        COPY_BUF_SIZE,
    );
    tokio::pin!(copy);

    tokio::select! {
        biased;
        _ = async {
            if !inbound_closed {
                inbound_close.notified().await;
            }
        } => {
            tracing::debug!(%peer, "上一跳发送 CLOSE，立即断开 / previous hop sent CLOSE, closing immediately");
            Ok(())
        }
        _ = async {
            if !outbound_closed {
                outbound_close.notified().await;
            }
        } => {
            tracing::debug!(%peer, "下一跳发送 CLOSE，立即断开 / next hop sent CLOSE, closing immediately");
            Ok(())
        }
        result = &mut copy => {
            match result {
                Ok((up, down)) => {
                    tracing::debug!(
                        %peer,
                        up,
                        down,
                        "中间跳双向搬运结束 / middle hop relay finished"
                    );
                    Ok(())
                }
                Err(error) => {
                    if error.kind() == io::ErrorKind::InvalidData {
                        tracing::error!(
                            %peer,
                            %error,
                            "中间跳帧非法，断开连接 / invalid tunnel frame on the middle hop, disconnecting"
                        );
                    }
                    Err(error.into())
                }
            }
        }
    }
}

/// 读取（但不消费）握手首字节，用于 TLS / Noise 分流。
async fn peek_mode(stream: &mut TcpStream) -> io::Result<u8> {
    let mut byte = [0u8; 1];
    loop {
        match stream.peek(&mut byte).await {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "对端在发送模式字节前关闭 / peer closed before sending the mode byte",
                ))
            }
            Ok(_) => return Ok(byte[0]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

/// 消费模式字节；`expected` 用于断言分流结果与读到的字节一致。
async fn consume_mode_byte(stream: &mut TcpStream, expected: u8) -> Result<()> {
    let mut byte = [0u8; 1];
    stream.read_exact(&mut byte).await.with_context(|| {
        format!("消费隧道模式字节失败 / failed to consume the tunnel mode byte 0x{expected:02x}")
    })?;
    if byte[0] != expected {
        bail!(
            "隧道模式字节在 peek 与读取之间变化（期望 0x{expected:02x}，实际 0x{:02x}）/ tunnel mode byte changed between peek and read (expected 0x{expected:02x}, got 0x{:02x})",
            byte[0],
            byte[0]
        );
    }
    Ok(())
}

async fn read_frame_logged<R>(reader: &mut R, peer: std::net::SocketAddr) -> Result<Option<Frame>>
where
    R: AsyncRead + Unpin,
{
    match framing::read_frame(reader).await {
        Ok(frame) => Ok(frame),
        Err(FrameError::TooLarge { len }) => {
            tracing::error!(
                peer = %peer,
                len,
                limit = MAX_FRAME_PAYLOAD,
                "隧道帧长度超限，断开连接 / tunnel frame exceeds the limit, disconnecting"
            );
            Err(FrameError::TooLarge { len }.into())
        }
        Err(error) => Err(error.into()),
    }
}

async fn connect_target(target: &TargetAddr) -> Result<TcpStream> {
    let connect = async {
        match target {
            TargetAddr::Ip(addr) => TcpStream::connect(addr).await,
            TargetAddr::Domain { host, port } => TcpStream::connect((host.as_str(), *port)).await,
        }
    };

    let stream = match timeout(TARGET_CONNECT_TIMEOUT, connect).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => {
            return Err(anyhow!(
                "连接目标 {target:?} 失败 / failed to connect target: {error}"
            ))
        }
        Err(_) => {
            return Err(anyhow!(
                "连接目标 {target:?} 超时（{}s）/ connecting target timed out after {}s",
                TARGET_CONNECT_TIMEOUT.as_secs(),
                TARGET_CONNECT_TIMEOUT.as_secs()
            ))
        }
    };
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// 隧道客户端。TLS 用显式 CA，Noise 用 `hop_secret` 派生的 PSK/静态密钥；
/// 两种模式共用同一套帧层与地址语义。
pub struct TunnelClient {
    server_addr: std::net::SocketAddr,
    /// Noise 模式不需要 SNI；TLS 模式必填。
    server_name: Option<ServerName<'static>>,
    hop_id: String,
    hop_secret: Vec<u8>,
    config: Arc<ClientConfig>,
    /// 显式信任根。TCP 与 QUIC（UDP 中继）共用同一份 CA；`None` 时是空信任根。
    roots: Arc<RootCertStore>,
    security: TunnelSecurity,
    /// 客户端发起重协商的周期；测试可压到毫秒级。
    rekey_interval: Duration,
    /// 仅测试用：覆盖 ClientHello 的时间戳，用来验证服务端的窗口/重放。
    proof_timestamp: Option<u64>,
}

impl TunnelClient {
    /// 用显式 CA 构建 TLS 客户端。`roots = None` → 空信任根，连接必定失败。
    pub fn new(
        server_addr: std::net::SocketAddr,
        server_name: ServerName<'static>,
        hop_id: impl Into<String>,
        hop_secret: Vec<u8>,
        roots: Option<Arc<RootCertStore>>,
    ) -> Self {
        // None = 空信任根（fail closed）；保存下来给 QUIC 复用，避免从
        // `ClientConfig` 里反推信任根（rustls 不提供这个接口）。
        let roots = roots.unwrap_or_else(|| Arc::new(RootCertStore::empty()));
        Self {
            server_addr,
            server_name: Some(server_name),
            hop_id: hop_id.into(),
            hop_secret,
            config: client_tls_config(Some(Arc::clone(&roots))),
            roots,
            security: TunnelSecurity::Tls,
            rekey_interval: DEFAULT_REKEY_INTERVAL,
            proof_timestamp: None,
        }
    }

    /// 从 CA 文件构建 TLS 客户端；文件里必须至少有一个 `CERTIFICATE` 块。
    pub fn trusting_ca_file(
        server_addr: std::net::SocketAddr,
        server_name: ServerName<'static>,
        hop_id: impl Into<String>,
        hop_secret: Vec<u8>,
        ca_path: &Path,
    ) -> Result<Self> {
        let roots = Arc::new(load_root_store(ca_path)?);
        Ok(Self::new(
            server_addr,
            server_name,
            hop_id,
            hop_secret,
            Some(roots),
        ))
    }

    /// 构建 Noise/PSK 客户端：不需要证书、CA 或 SNI。
    ///
    /// 两端只要持有同一个 `hop_secret`，就能独立算出相同的静态密钥对与 PSK。
    /// `TunnelSupervisor` 在 `TunnelSpec.security = Noise` 时走这个构造器，
    /// 三个证书路径字段一律不读。
    pub fn noise(
        server_addr: std::net::SocketAddr,
        hop_id: impl Into<String>,
        hop_secret: Vec<u8>,
    ) -> Self {
        Self {
            server_addr,
            server_name: None,
            hop_id: hop_id.into(),
            hop_secret,
            config: client_tls_config(None),
            roots: Arc::new(RootCertStore::empty()),
            security: TunnelSecurity::Noise,
            rekey_interval: DEFAULT_REKEY_INTERVAL,
            proof_timestamp: None,
        }
    }

    /// 启用 UDP 中继（P16.3）：在**同一个端口**上用 QUIC datagram 连服务端。
    ///
    /// `target_rules` 是候选目标列表（顺序即一致性哈希的桶顺序），
    /// [`QuicUdpClient::send_from`] 按本地 UDP 客户端地址哈希选目标。
    /// TCP 路径不受影响：返回的 [`QuicUdpClient`] 是独立的 QUIC 连接。
    ///
    /// 只有 TLS 模式支持；Noise 的 UDP 路径本轮不做，明确失败而不是退化。
    ///
    /// 入口侧（[`udp_dialer`]）**每个本地 UDP 客户端建一条这样的连接**：
    /// 回包只带目标地址，只有「一条连接 = 一个客户端」才能把回包送对人。
    pub async fn with_udp(&self, target_rules: Vec<TargetRule>) -> Result<QuicUdpClient> {
        if self.security != TunnelSecurity::Tls {
            bail!("Noise 模式的 UDP 中继本轮不做 / UDP relay over Noise is not implemented yet");
        }
        let server_name = self
            .server_name
            .clone()
            .ok_or_else(|| anyhow!("UDP 中继需要服务器名 / UDP relay requires a server name"))?;
        QuicUdpClient::connect(
            self.server_addr,
            server_name,
            self.hop_id.clone(),
            self.hop_secret.clone(),
            Arc::clone(&self.roots),
            &target_rules,
        )
        .await
    }

    /// 覆盖周期重协商间隔（会 clamp 到最小值，避免 0 造成重协商风暴）。
    ///
    /// 生产固定用 [`DEFAULT_REKEY_INTERVAL`]；只有测试需要压缩到毫秒级，
    /// 因此编进测试构建即可，不再用 `allow(dead_code)` 掩盖未接线的方法。
    #[cfg(test)]
    pub fn with_rekey_interval(mut self, interval: Duration) -> Self {
        self.rekey_interval = interval.max(modes::MIN_REKEY_INTERVAL);
        self
    }

    /// 建连、握手、发首帧地址，返回可读写帧的连接。
    pub async fn connect(&self, target: &TargetAddr) -> Result<TunnelConnection> {
        let tcp = match timeout(TARGET_CONNECT_TIMEOUT, TcpStream::connect(self.server_addr)).await
        {
            Ok(Ok(tcp)) => tcp,
            Ok(Err(error)) => {
                return Err(anyhow!(
                    "连接隧道服务端 {} 失败 / failed to connect tunnel server: {error}",
                    self.server_addr
                ))
            }
            Err(_) => {
                return Err(anyhow!(
                    "连接隧道服务端 {} 超时 / connecting tunnel server timed out",
                    self.server_addr
                ))
            }
        };
        let _ = tcp.set_nodelay(true);

        match self.security {
            TunnelSecurity::Tls => self.connect_tls(tcp, target).await,
            TunnelSecurity::Noise => self.connect_noise(tcp, target).await,
        }
    }

    async fn connect_tls(
        &self,
        mut tcp: TcpStream,
        target: &TargetAddr,
    ) -> Result<TunnelConnection> {
        let server_name = self
            .server_name
            .clone()
            .ok_or_else(|| anyhow!("TLS 模式缺少服务器名 / TLS mode requires a server name"))?;
        // 模式字节必须先于 TLS ClientHello；服务端 peek 后消费它。
        tcp.write_all(&[modes::MODE_TLS])
            .await
            .context("发送 TLS 模式字节失败 / failed to send the TLS mode byte")?;
        tcp.flush().await.ok();

        let connector = TlsConnector::from(self.config.clone());
        let mut tls = match timeout(HANDSHAKE_TIMEOUT, connector.connect(server_name, tcp)).await {
            Ok(Ok(tls)) => tls,
            Ok(Err(error)) => return Err(describe_tls_handshake_error(error)),
            Err(_) => {
                return Err(anyhow!(
                    "TLS 握手超时（{}s）/ TLS handshake timed out after {}s",
                    HANDSHAKE_TIMEOUT.as_secs(),
                    HANDSHAKE_TIMEOUT.as_secs()
                ))
            }
        };

        self.exchange_tls_hello(&mut tls).await?;
        let mut connection = TunnelConnection {
            stream: Box::new(tls),
            rekey_count: None,
        };
        connection.send_address(target).await?;
        Ok(connection)
    }

    async fn connect_noise(
        &self,
        mut tcp: TcpStream,
        target: &TargetAddr,
    ) -> Result<TunnelConnection> {
        tcp.write_all(&[modes::MODE_NOISE])
            .await
            .context("发送 Noise 模式字节失败 / failed to send the Noise mode byte")?;
        tcp.flush().await.ok();

        let material = NoiseMaterial::from_secret(&self.hop_secret);
        let transport = timeout(
            HANDSHAKE_TIMEOUT,
            modes::client_handshake(&mut tcp, &material),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "Noise 握手超时（{}s）/ Noise handshake timed out after {}s",
                HANDSHAKE_TIMEOUT.as_secs(),
                HANDSHAKE_TIMEOUT.as_secs()
            )
        })?
        // 服务端在认证失败时直接断开（不回明文原因），客户端统一补一句可读提示：
        // 这一层最常见的失败就是 PSK/hop 配错。
        .context(
            "Noise 握手失败（PSK 不匹配、未知 hop 或对端不是 Noise）/ Noise handshake failed (PSK mismatch, unknown hop, or peer is not Noise)",
        )?;

        let noise = NoiseStream::start(tcp, transport, material, true, self.rekey_interval);
        let counter = noise.rekey_count_handle();
        let mut connection = TunnelConnection {
            stream: Box::new(noise),
            rekey_count: Some(counter),
        };
        connection.send_address(target).await?;
        Ok(connection)
    }

    /// TLS 层的 hop 认证：版本、hop、时间窗、HMAC proof、重放。
    async fn exchange_tls_hello(
        &self,
        tls: &mut tokio_rustls::client::TlsStream<TcpStream>,
    ) -> Result<()> {
        let timestamp = self.proof_timestamp.unwrap_or_else(handshake::unix_now);
        let hello = ClientHello::new(&self.hop_secret, self.hop_id.clone(), timestamp);
        timeout(HANDSHAKE_TIMEOUT, hello.write(tls))
            .await
            .context("发送 ClientHello 超时 / timed out sending ClientHello")??;

        let reply = timeout(HANDSHAKE_TIMEOUT, ServerHello::read(tls))
            .await
            .context("等待 ServerHello 超时 / timed out waiting for ServerHello")??;

        if reply.version != handshake::PROTOCOL_VERSION {
            bail!(
                "服务端握手版本 {} 与本地 {} 不一致 / server handshake version {} does not match local {}",
                reply.version,
                handshake::PROTOCOL_VERSION,
                reply.version,
                handshake::PROTOCOL_VERSION
            );
        }
        if !reply.ok {
            let reason = reply
                .reason
                .unwrap_or_else(|| "服务端未给出原因 / server gave no reason".to_string());
            bail!("隧道握手被服务端拒绝 / tunnel handshake rejected by server: {reason}");
        }
        Ok(())
    }
}

/// 一条已建立的隧道。底层可能是 TLS 或 Noise，上层只按帧语义读写。
pub struct TunnelConnection {
    stream: BoxedStream,
    /// Noise 模式的重协商计数；TLS 为 `None`。
    rekey_count: Option<Arc<AtomicU64>>,
}

impl TunnelConnection {
    /// 已完成的 Noise 重协商次数；TLS 恒为 0。
    pub fn rekey_count(&self) -> u64 {
        self.rekey_count
            .as_ref()
            .map_or(0, |counter| counter.load(Ordering::Relaxed))
    }

    /// 发数据帧；单帧上限 64 KiB（超过返回错误，不静默分片）。
    #[cfg(test)]
    pub async fn send_data(&mut self, payload: &[u8]) -> Result<()> {
        if payload.len() > MAX_FRAME_PAYLOAD {
            bail!(
                "单帧 {} 字节超过 {} 字节上限 / frame payload exceeds the {}-byte limit",
                payload.len(),
                MAX_FRAME_PAYLOAD,
                MAX_FRAME_PAYLOAD
            );
        }
        framing::write_frame(&mut self.stream, FrameKind::Data, payload).await?;
        Ok(())
    }

    #[cfg(test)]
    pub async fn send_ping(&mut self) -> Result<()> {
        framing::write_frame(&mut self.stream, FrameKind::Ping, &[]).await?;
        Ok(())
    }

    /// 发 CLOSE：服务端立即断开目标连接，不再排空。
    #[cfg(test)]
    pub async fn send_close(&mut self) -> Result<()> {
        framing::write_frame(&mut self.stream, FrameKind::Close, &[]).await?;
        Ok(())
    }

    /// 读一帧；`None` = 对端半关/关闭（TLS close_notify / Noise EOF / TCP FIN）。
    #[cfg(test)]
    pub async fn recv(&mut self) -> Result<Option<Frame>> {
        Ok(framing::read_frame(&mut self.stream).await?)
    }

    /// 把连接转成字节流适配器（Dialer 的 `copy_bidirectional` 用）。
    pub fn into_frame_io(self) -> FrameIo<BoxedStream> {
        tracing::debug!(
            rekeys = self.rekey_count(),
            "隧道连接转为字节流 / tunnel connection converted to byte stream"
        );
        FrameIo::new(self.stream)
    }

    /// 只关写方向（TLS close_notify / Noise 半关），仍可继续读。用于优雅半关。
    #[cfg(test)]
    pub async fn shutdown(&mut self) -> Result<()> {
        self.stream.shutdown().await?;
        Ok(())
    }

    async fn send_address(&mut self, target: &TargetAddr) -> Result<()> {
        let payload = target.encode()?;
        framing::write_frame(&mut self.stream, FrameKind::Data, &payload).await?;
        Ok(())
    }
}

fn validate_server_config(config: &TunnelServerConfig) -> Result<()> {
    if config.hops.is_empty() {
        bail!("隧道至少需要一个 hop / a tunnel needs at least one hop");
    }
    for (hop_id, secret) in &config.hops {
        if hop_id.is_empty() || hop_id.len() > 255 {
            bail!("hop_id 长度非法（1..=255）/ invalid hop_id length (1..=255): {hop_id}");
        }
        if secret.is_empty() {
            bail!("hop_secret 不能为空 / hop_secret must not be empty: {hop_id}");
        }
    }

    let has_cert = !config.cert_path.as_os_str().is_empty();
    let has_key = !config.key_path.as_os_str().is_empty();
    match config.security {
        TunnelSecurity::Tls => {
            if !has_cert || !has_key {
                bail!(
                    "TLS 模式必须同时提供证书和私钥 / TLS mode requires both a certificate and a private key"
                );
            }
        }
        TunnelSecurity::Noise => {
            // 允许 Noise-only（两者都空）；只给一半是配置错误，不能靠猜。
            if has_cert != has_key {
                bail!(
                    "证书和私钥必须同时提供或同时留空 / certificate and private key must be provided together or both omitted"
                );
            }
        }
    }
    Ok(())
}

/// 按配置加载 TLS；Noise-only 监听（两个路径都为空）返回 `None`。
fn load_optional_server_tls(config: &TunnelServerConfig) -> Result<Option<TlsAcceptor>> {
    if config.cert_path.as_os_str().is_empty() && config.key_path.as_os_str().is_empty() {
        return Ok(None);
    }
    Ok(Some(TlsAcceptor::from(server_tls_config(
        &config.cert_path,
        &config.key_path,
    )?)))
}

fn client_tls_config(roots: Option<Arc<RootCertStore>>) -> Arc<ClientConfig> {
    // None = 空信任根。绝不回退 webpki-roots：隧道只信任自有 CA。
    let roots = roots.unwrap_or_else(|| Arc::new(RootCertStore::empty()));
    Arc::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

/// 把 rustls 的握手错误翻成可读双语句子；错误码复用 TLS 探针的稳定分类。
fn describe_tls_handshake_error(error: io::Error) -> anyhow::Error {
    let code = crate::tls_probe::classify_handshake_error(&error);
    let readable = match code {
        crate::tls_probe::UNKNOWN_ISSUER => {
            "证书链不受信任（不在给定 CA 下）/ certificate chain is not trusted by the given CA"
        }
        crate::tls_probe::CERT_EXPIRED => "证书已过期 / certificate has expired",
        crate::tls_probe::NAME_MISMATCH => {
            "证书与服务器名不匹配 / certificate does not match the server name"
        }
        crate::tls_probe::TIMEOUT => "TLS 握手超时 / TLS handshake timed out",
        _ => "TLS 握手失败 / TLS handshake failed",
    };
    anyhow!("{readable}（{code}）: {error}")
}

fn server_tls_config(cert_path: &Path, key_path: &Path) -> Result<Arc<ServerConfig>> {
    let certificates = load_certificates(cert_path)?;
    let key = load_private_key(key_path)?;
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certificates, key)
        .context("证书与私钥不匹配 / certificate and private key do not match")?;
    Ok(Arc::new(config))
}

fn load_root_store(ca_path: &Path) -> Result<RootCertStore> {
    let pem = std::fs::read_to_string(ca_path).with_context(|| {
        format!(
            "读取 CA 文件失败 / failed to read CA file: {}",
            ca_path.display()
        )
    })?;
    roots_from_pem(&pem).with_context(|| {
        format!(
            "解析 CA 文件失败 / failed to parse CA file: {}",
            ca_path.display()
        )
    })
}

fn roots_from_pem(pem: &str) -> Result<RootCertStore> {
    let certificates = pem_blocks(pem)?
        .into_iter()
        .filter(|(label, _)| label == "CERTIFICATE")
        .map(|(_, der)| CertificateDer::from(der))
        .collect::<Vec<_>>();
    if certificates.is_empty() {
        bail!("CA 文件里没有 CERTIFICATE 块 / no CERTIFICATE block found in the CA file");
    }

    let mut roots = RootCertStore::empty();
    for certificate in certificates {
        roots
            .add(certificate)
            .context("CA 证书不合法 / invalid CA certificate")?;
    }
    Ok(roots)
}

fn load_certificates(cert_path: &Path) -> Result<Vec<CertificateDer<'static>>> {
    let pem = std::fs::read_to_string(cert_path).with_context(|| {
        format!(
            "读取证书文件失败 / failed to read certificate file: {}",
            cert_path.display()
        )
    })?;
    let certificates = pem_blocks(&pem)?
        .into_iter()
        .filter(|(label, _)| label == "CERTIFICATE")
        .map(|(_, der)| CertificateDer::from(der))
        .collect::<Vec<_>>();
    if certificates.is_empty() {
        bail!(
            "证书文件里没有 CERTIFICATE 块 / no CERTIFICATE block found in {}",
            cert_path.display()
        );
    }
    Ok(certificates)
}

fn load_private_key(key_path: &Path) -> Result<PrivateKeyDer<'static>> {
    let pem = std::fs::read_to_string(key_path).with_context(|| {
        format!(
            "读取私钥文件失败 / failed to read private key file: {}",
            key_path.display()
        )
    })?;

    for (label, der) in pem_blocks(&pem)? {
        match label.as_str() {
            "PRIVATE KEY" => return Ok(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(der))),
            "RSA PRIVATE KEY" => return Ok(PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(der))),
            "EC PRIVATE KEY" => return Ok(PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(der))),
            _ => {}
        }
    }
    bail!(
        "私钥文件里没有可识别的 PRIVATE KEY 块 / no supported PRIVATE KEY block found in {}",
        key_path.display()
    )
}

/// 最小 PEM 解析：只认 `-----BEGIN <label>-----` ... `-----END <label>-----`，
/// 块外文字忽略。够用于证书/私钥；不引入新的 PEM 依赖。
fn pem_blocks(pem: &str) -> Result<Vec<(String, Vec<u8>)>> {
    let mut blocks = Vec::new();
    let mut current: Option<(String, String)> = None;

    for (line_no, raw) in pem.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix("-----BEGIN ") {
            let label = rest.strip_suffix("-----").ok_or_else(|| {
                anyhow!(
                    "PEM 第 {} 行 BEGIN 头不完整 / incomplete BEGIN line",
                    line_no + 1
                )
            })?;
            if current.is_some() {
                bail!(
                    "PEM 第 {} 行出现嵌套 BEGIN / nested BEGIN at line {}",
                    line_no + 1,
                    line_no + 1
                );
            }
            current = Some((label.to_string(), String::new()));
        } else if let Some(rest) = line.strip_prefix("-----END ") {
            let label = rest.strip_suffix("-----").ok_or_else(|| {
                anyhow!(
                    "PEM 第 {} 行 END 尾不完整 / incomplete END line",
                    line_no + 1
                )
            })?;
            let Some((begin_label, body)) = current.take() else {
                bail!(
                    "PEM 第 {} 行 END 没有对应 BEGIN / END without BEGIN at line {}",
                    line_no + 1,
                    line_no + 1
                );
            };
            if begin_label != label {
                bail!(
                    "PEM 第 {} 行 BEGIN/END 标签不一致（{begin_label} vs {label}）/ mismatched PEM labels at line {}",
                    line_no + 1,
                    line_no + 1
                );
            }
            let der = base64::engine::general_purpose::STANDARD
                .decode(body.as_bytes())
                .with_context(|| {
                    format!(
                        "PEM 第 {} 行 base64 解码失败 / invalid base64 at line {}",
                        line_no + 1,
                        line_no + 1
                    )
                })?;
            blocks.push((label.to_string(), der));
        } else if let Some((_, body)) = current.as_mut() {
            body.push_str(line);
        }
        // 块外的说明文字（openssl 注释等）直接忽略。
    }

    if let Some((label, _)) = current {
        bail!("PEM 块 {label} 缺少 END / unterminated PEM block: {label}");
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::net::SocketAddr;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use pierwave_proto::{DesiredForward, ForwardEngine, TunnelRole, TunnelSpec, TunnelTargetRule};
    use rustls::pki_types::ServerName;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::task::JoinHandle;
    use tokio::time::timeout;
    use tokio_rustls::{client::TlsStream, TlsConnector};

    use super::framing::{Frame, FrameKind, TargetAddr, MAX_FRAME_PAYLOAD};
    use super::handshake::{self, ClientHello, ServerHello};
    use super::{
        client_tls_config, roots_from_pem, TargetRule, TunnelClient, TunnelConnection,
        TunnelSecurity, TunnelServer, TunnelServerConfig, TunnelStatsHandle, TunnelSupervisor,
        DEFAULT_MAX_CONNECTIONS,
    };

    const CA_PEM: &str = include_str!("../../tests/fixtures/tunnel-ca.pem");
    const SERVER_CERT_PEM: &str = include_str!("../../tests/fixtures/tunnel-server.pem");
    const SERVER_KEY_PEM: &str = include_str!("../../tests/fixtures/tunnel-server-key.pem");
    const ROGUE_CA_PEM: &str = include_str!("../../tests/fixtures/tunnel-rogue-ca.pem");
    const HOP_ID: &str = "hop-1";
    const HOP_SECRET: &[u8] = b"test-hop-secret-32-bytes-long!!!";
    const TEST_SNI: &str = "tunnel.test";

    /// 自建临时目录；Drop 时删掉。测试不引入 tempfile。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("pierwave-tunnel-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("创建测试临时目录");
            Self(dir)
        }

        fn write(&self, name: &str, contents: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, contents).expect("写测试证书失败");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn server_name() -> ServerName<'static> {
        ServerName::try_from(TEST_SNI).expect("固定测试 SNI 必须合法")
    }

    /// 起一个真实监听的回环隧道服务端，返回地址与可读 stats。
    struct Harness {
        addr: SocketAddr,
        stats: TunnelStatsHandle,
        task: JoinHandle<()>,
        _dir: TempDir,
    }

    impl Harness {
        async fn start(max_connections: usize) -> Self {
            let dir = TempDir::new();
            let cert_path = dir.write("server.pem", SERVER_CERT_PEM);
            let key_path = dir.write("server-key.pem", SERVER_KEY_PEM);
            let mut hops = HashMap::new();
            hops.insert(HOP_ID.to_string(), HOP_SECRET.to_vec());

            let config = TunnelServerConfig {
                bind: "127.0.0.1:0".parse().expect("固定回环地址"),
                security: TunnelSecurity::Tls,
                cert_path,
                key_path,
                hops,
                max_connections,
                // 回环测试统一允许 127.0.0.0/8 的任意端口；白名单拒绝路径由
                // 单独的用例构造更严格的规则。
                allowed_targets: vec![TargetRule::new("127.0.0.1", None)],
                downstream: None,
            };
            let (server, listener) = TunnelServer::bind(config)
                .await
                .expect("测试隧道服务端必须能启动");
            let addr = listener.local_addr().expect("读取监听地址");
            let stats = server.stats_handle();
            let task = tokio::spawn(async move {
                let _ = server.serve(listener).await;
            });
            Self {
                addr,
                stats,
                task,
                _dir: dir,
            }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    /// 回环 echo：读到多少原样写回，读到 EOF 就半关。
    async fn spawn_echo() -> (SocketAddr, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("echo 监听必须能绑定");
        let addr = listener.local_addr().expect("读取 echo 地址");
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 32 * 1024];
                    loop {
                        match stream.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(read) => {
                                if stream.write_all(&buf[..read]).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    let _ = stream.shutdown().await;
                });
            }
        });
        (addr, task)
    }

    fn client_with_ca_file(addr: SocketAddr, ca_path: &Path) -> TunnelClient {
        TunnelClient::trusting_ca_file(addr, server_name(), HOP_ID, HOP_SECRET.to_vec(), ca_path)
            .expect("CA 夹具必须能加载")
    }

    fn client_with_fixture_ca(addr: SocketAddr) -> TunnelClient {
        let roots = Arc::new(roots_from_pem(CA_PEM).expect("CA 夹具必须合法"));
        TunnelClient::new(
            addr,
            server_name(),
            HOP_ID,
            HOP_SECRET.to_vec(),
            Some(roots),
        )
    }

    async fn connect(client: &TunnelClient, target: SocketAddr) -> TunnelConnection {
        timeout(
            Duration::from_secs(5),
            client.connect(&TargetAddr::Ip(target)),
        )
        .await
        .expect("建立隧道超时")
        .expect("建立隧道失败")
    }

    /// 按字节收满 `expected` 字节；DATA 帧的边界由服务端 32KB 缓冲决定，
    /// 不能假设一帧就是一条业务消息。
    async fn recv_exact(tunnel: &mut TunnelConnection, expected: usize) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut out = Vec::with_capacity(expected);
        while out.len() < expected {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("等待隧道数据超时");
            let frame = timeout(remaining, tunnel.recv())
                .await
                .expect("等待隧道帧超时")
                .expect("读取隧道失败");
            match frame {
                Some(frame) => match frame.kind {
                    FrameKind::Data => out.extend_from_slice(&frame.payload),
                    FrameKind::Ping => {}
                    FrameKind::Close => {
                        panic!("对端提前 CLOSE（已收 {} / {} 字节）", out.len(), expected)
                    }
                },
                None => panic!("对端在收满前关闭（已收 {} / {} 字节）", out.len(), expected),
            }
        }
        out
    }

    async fn wait_for_active(stats: &TunnelStatsHandle, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = stats.snapshot();
            if snapshot.active == expected {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "等待 active={expected} 超时，当前 {snapshot:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// 绕过 `TunnelClient` 的裸 TLS 连接，用于构造「客户端实现错误」的帧。
    async fn raw_tls_connect(addr: SocketAddr) -> TlsStream<TcpStream> {
        let roots = Arc::new(roots_from_pem(CA_PEM).expect("CA 夹具必须合法"));
        let config = client_tls_config(Some(roots));
        let tcp = TcpStream::connect(addr).await.expect("raw 客户端连接失败");
        let mut tls = TlsConnector::from(config)
            .connect(server_name(), tcp)
            .await
            .expect("raw 客户端 TLS 握手失败");

        let hello = ClientHello::new(HOP_SECRET, HOP_ID, handshake::unix_now());
        hello
            .write(&mut tls)
            .await
            .expect("raw 客户端 ClientHello 失败");
        let reply = ServerHello::read(&mut tls)
            .await
            .expect("raw 客户端 ServerHello 失败");
        assert!(reply.ok, "raw 客户端握手必须通过: {reply:?}");
        tls
    }

    #[tokio::test]
    async fn tunnel_roundtrip_over_trusted_ca() {
        let harness = Harness::start(DEFAULT_MAX_CONNECTIONS).await;
        let (echo_addr, echo_task) = spawn_echo().await;
        let dir = TempDir::new();
        let ca_path = dir.write("ca.pem", CA_PEM);
        let client = client_with_ca_file(harness.addr, &ca_path);

        let mut tunnel = connect(&client, echo_addr).await;
        tunnel.send_ping().await.expect("PING 应被接受");

        // 双向各 3 条消息；中间一条 40KB > 32KB 搬运缓冲，强制多帧拆分。
        let messages = [
            b"hello-1".to_vec(),
            vec![0xa5; 40 * 1024],
            b"hello-3".to_vec(),
        ];
        for message in &messages {
            tunnel.send_data(message).await.expect("发送数据帧");
            assert_eq!(&recv_exact(&mut tunnel, message.len()).await, message);
        }

        assert_eq!(harness.stats.snapshot().total, 1);
        assert_eq!(harness.stats.snapshot().active, 1);

        tunnel.send_close().await.expect("发送 CLOSE");
        wait_for_active(&harness.stats, 0).await;
        echo_task.abort();
    }

    #[tokio::test]
    async fn client_eof_half_closes_and_finishes_cleanly() {
        let harness = Harness::start(DEFAULT_MAX_CONNECTIONS).await;
        let (echo_addr, echo_task) = spawn_echo().await;
        let mut tunnel = connect(&client_with_fixture_ca(harness.addr), echo_addr).await;

        tunnel.send_data(b"half-close").await.expect("发送数据");
        assert_eq!(recv_exact(&mut tunnel, 10).await, b"half-close");

        // 只关写方向：目标收到 EOF 并退出，回程的 close_notify 仍要能读到。
        tunnel.shutdown().await.expect("半关写方向");
        let tail = timeout(Duration::from_secs(5), tunnel.recv())
            .await
            .expect("等待服务端 close_notify 超时")
            .expect("读取隧道失败");
        assert!(tail.is_none(), "半关后应读到 EOF，而不是帧: {tail:?}");

        wait_for_active(&harness.stats, 0).await;
        echo_task.abort();
    }

    #[tokio::test]
    async fn client_trusting_the_wrong_ca_fails_with_readable_error() {
        let harness = Harness::start(DEFAULT_MAX_CONNECTIONS).await;
        let dir = TempDir::new();
        let rogue_ca = dir.write("rogue-ca.pem", ROGUE_CA_PEM);
        let target = "127.0.0.1:9".parse().expect("固定地址");

        let error = client_with_ca_file(harness.addr, &rogue_ca)
            .connect(&TargetAddr::Ip(target))
            .await
            .err()
            .expect("信任错误 CA 时必须握手失败");
        let text = format!("{error:#}");
        assert!(text.contains("证书链不受信任"), "{text}");
        assert!(text.contains("unknown_issuer"), "{text}");

        // None = 空信任根（fail-closed）：不回退 webpki-roots，同样必须失败。
        let no_roots = TunnelClient::new(
            harness.addr,
            server_name(),
            HOP_ID,
            HOP_SECRET.to_vec(),
            None,
        );
        let error = no_roots
            .connect(&TargetAddr::Ip(target))
            .await
            .err()
            .expect("空信任根必须失败");
        assert!(format!("{error:#}").contains("证书链不受信任"), "{error:#}");

        wait_for_active(&harness.stats, 0).await;
    }

    #[tokio::test]
    async fn stale_proof_is_rejected() {
        let harness = Harness::start(DEFAULT_MAX_CONNECTIONS).await;
        let mut client = client_with_fixture_ca(harness.addr);
        client.proof_timestamp = Some(handshake::unix_now().saturating_sub(400));

        let error = client
            .connect(&TargetAddr::Ip("127.0.0.1:9".parse().expect("固定地址")))
            .await
            .err()
            .expect("时间戳偏移 400s 必须被拒绝");
        let text = format!("{error:#}");
        assert!(text.contains("时间戳"), "{text}");
        assert!(text.contains("400"), "{text}");

        wait_for_active(&harness.stats, 0).await;
    }

    #[tokio::test]
    async fn replayed_proof_is_rejected_but_first_connection_keeps_working() {
        let harness = Harness::start(DEFAULT_MAX_CONNECTIONS).await;
        let (echo_addr, echo_task) = spawn_echo().await;
        let timestamp = handshake::unix_now();

        let mut first_client = client_with_fixture_ca(harness.addr);
        first_client.proof_timestamp = Some(timestamp);
        let mut tunnel = connect(&first_client, echo_addr).await;

        let mut replay_client = client_with_fixture_ca(harness.addr);
        replay_client.proof_timestamp = Some(timestamp);
        let error = replay_client
            .connect(&TargetAddr::Ip(echo_addr))
            .await
            .err()
            .expect("同一 proof 第二次必须被拒绝");
        assert!(format!("{error:#}").contains("重放"), "{error:#}");

        // 重放被拒不能影响已经建立的连接。
        tunnel.send_data(b"still-ok").await.expect("已有连接仍可写");
        assert_eq!(recv_exact(&mut tunnel, 8).await, b"still-ok");

        tunnel.send_close().await.expect("发送 CLOSE");
        wait_for_active(&harness.stats, 0).await;
        echo_task.abort();
    }

    fn noise_client(addr: SocketAddr) -> TunnelClient {
        TunnelClient::noise(addr, HOP_ID, HOP_SECRET.to_vec())
    }

    /// Noise 回环：无证书建隧道 → echo → 双向各 3 条消息。
    #[tokio::test]
    async fn noise_roundtrip_echoes_three_messages_each_way() {
        let harness = Harness::start(DEFAULT_MAX_CONNECTIONS).await;
        let (echo_addr, echo_task) = spawn_echo().await;
        let mut tunnel = connect(&noise_client(harness.addr), echo_addr).await;

        let messages = [
            b"noise-1".to_vec(),
            vec![0x5a; 40 * 1024],
            b"noise-3".to_vec(),
        ];
        for message in &messages {
            tunnel.send_data(message).await.expect("发送 Noise 数据帧");
            assert_eq!(&recv_exact(&mut tunnel, message.len()).await, message);
        }

        assert_eq!(harness.stats.snapshot().total, 1);
        assert_eq!(harness.stats.snapshot().active, 1);
        assert_eq!(tunnel.rekey_count(), 0, "默认 10 分钟内不应重协商");

        tunnel.send_close().await.expect("发送 CLOSE");
        wait_for_active(&harness.stats, 0).await;
        echo_task.abort();
    }

    /// 错误 PSK：握手失败，错误里要能看出是 Noise/PSK 的问题。
    #[tokio::test]
    async fn noise_wrong_psk_fails_with_readable_error() {
        let harness = Harness::start(DEFAULT_MAX_CONNECTIONS).await;
        let wrong = TunnelClient::noise(
            harness.addr,
            HOP_ID,
            b"definitely-not-the-right-secret!".to_vec(),
        );
        let error = wrong
            .connect(&TargetAddr::Ip("127.0.0.1:9".parse().expect("固定地址")))
            .await
            .err()
            .expect("错误 PSK 必须握手失败");
        let text = format!("{error:#}");
        assert!(text.contains("Noise"), "{text}");
        assert!(text.contains("PSK"), "{text}");

        // 失败不能泄漏成「一直挂着的半开连接」。
        wait_for_active(&harness.stats, 0).await;
    }

    /// 同一个 hop_secret 两端独立派生出的静态公钥必须完全一致。
    #[test]
    fn noise_static_key_is_deterministic_across_ends() {
        let left = super::NoiseMaterial::from_secret(HOP_SECRET).static_public();
        let right = super::NoiseMaterial::from_secret(HOP_SECRET).static_public();
        let other = super::NoiseMaterial::from_secret(b"a-different-hop-secret").static_public();

        assert_eq!(left, right, "同一 hop_secret 必须得到同一对静态密钥");
        assert_ne!(left, other, "不同 hop_secret 必须得到不同的静态密钥");
        assert_ne!(left, [0u8; 32], "派生结果不能是全零");
    }

    /// 极短 REKEY_INTERVAL：连接继续传数据，且底层完成了新会话握手。
    #[tokio::test]
    async fn noise_rekey_keeps_streaming_and_swaps_session() {
        let harness = Harness::start(DEFAULT_MAX_CONNECTIONS).await;
        let (echo_addr, echo_task) = spawn_echo().await;
        let client = noise_client(harness.addr).with_rekey_interval(Duration::from_millis(80));
        let mut tunnel = connect(&client, echo_addr).await;

        tunnel
            .send_data(b"before-rekey")
            .await
            .expect("发送重协商前数据");
        assert_eq!(recv_exact(&mut tunnel, 12).await, b"before-rekey");

        let deadline = Instant::now() + Duration::from_secs(5);
        while tunnel.rekey_count() == 0 {
            assert!(
                Instant::now() < deadline,
                "等待 Noise 重协商超时（count=0）"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        // 重协商复用同一条 TCP：服务端累计连接数不能增加。
        assert_eq!(
            harness.stats.snapshot().total,
            1,
            "重协商必须复用同一条 TCP，而不是重连"
        );
        tunnel
            .send_data(b"after-rekey")
            .await
            .expect("发送重协商后数据");
        assert_eq!(recv_exact(&mut tunnel, 11).await, b"after-rekey");
        assert!(tunnel.rekey_count() >= 1);
        println!(
            "Noise 重协商：rekeys={}，服务端累计连接={}（重协商复用同一条 TCP）",
            tunnel.rekey_count(),
            harness.stats.snapshot().total
        );

        tunnel.send_close().await.expect("发送 CLOSE");
        wait_for_active(&harness.stats, 0).await;
        echo_task.abort();
    }

    /// 同一监听端口：TLS 与 Noise 客户端都能连，证明首字节分流正确。
    #[tokio::test]
    async fn tls_and_noise_clients_share_one_listener() {
        let harness = Harness::start(DEFAULT_MAX_CONNECTIONS).await;
        let (echo_addr, echo_task) = spawn_echo().await;

        let mut tls = connect(&client_with_fixture_ca(harness.addr), echo_addr).await;
        tls.send_data(b"over-tls")
            .await
            .expect("TLS 客户端发送数据");
        assert_eq!(recv_exact(&mut tls, 8).await, b"over-tls");
        assert_eq!(harness.stats.snapshot().total, 1);

        let mut noise = connect(&noise_client(harness.addr), echo_addr).await;
        noise
            .send_data(b"over-noise")
            .await
            .expect("Noise 客户端发送数据");
        assert_eq!(recv_exact(&mut noise, 10).await, b"over-noise");
        assert_eq!(
            harness.stats.snapshot().total,
            2,
            "两种模式必须共用同一个 accept 循环"
        );

        tls.send_close().await.expect("TLS 发送 CLOSE");
        noise.send_close().await.expect("Noise 发送 CLOSE");
        wait_for_active(&harness.stats, 0).await;
        echo_task.abort();
    }

    /// Noise-only 监听：没有证书也能绑定；TLS 客户端会得到明确失败。
    #[tokio::test]
    async fn noise_only_listener_binds_without_certificates() {
        let mut hops = HashMap::new();
        hops.insert(HOP_ID.to_string(), HOP_SECRET.to_vec());
        let mut config = TunnelServerConfig::noise("127.0.0.1:0".parse().unwrap(), hops);
        config.allowed_targets = vec![TargetRule::new("127.0.0.1", None)];
        let (server, listener) = TunnelServer::bind(config)
            .await
            .expect("Noise-only 监听必须能在没有证书时启动");
        let addr = listener.local_addr().unwrap();
        let stats = server.stats_handle();
        let task = tokio::spawn(async move {
            let _ = server.serve(listener).await;
        });
        let (echo_addr, echo_task) = spawn_echo().await;

        let mut tunnel = connect(&noise_client(addr), echo_addr).await;
        tunnel.send_data(b"noise-only").await.expect("发送数据");
        assert_eq!(recv_exact(&mut tunnel, 10).await, b"noise-only");

        // TLS 首字节被明确拒绝（fail closed，不回退明文 / 不 panic）。
        let tls_error = client_with_fixture_ca(addr)
            .connect(&TargetAddr::Ip(echo_addr))
            .await
            .err()
            .expect("Noise-only 监听必须拒绝 TLS 客户端");
        assert!(format!("{tls_error:#}").contains("TLS"), "{tls_error:#}");

        tunnel.send_close().await.expect("发送 CLOSE");
        wait_for_active(&stats, 0).await;
        task.abort();
        echo_task.abort();
    }

    /// 起一个带 accept 计数的目标服务：用于断言「白名单拒绝时绝不发起连接」。
    async fn spawn_counted_echo() -> (SocketAddr, Arc<AtomicUsize>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&accepted);
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        match stream.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if stream.write_all(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        (addr, accepted, task)
    }

    #[tokio::test]
    async fn whitelist_rejection_closes_without_connecting() {
        let (echo_addr, accepted, echo_task) = spawn_counted_echo().await;
        let dir = TempDir::new();
        let cert_path = dir.write("server.pem", SERVER_CERT_PEM);
        let key_path = dir.write("server-key.pem", SERVER_KEY_PEM);

        let mut hops = HashMap::new();
        hops.insert(HOP_ID.to_string(), HOP_SECRET.to_vec());
        let config = TunnelServerConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            security: TunnelSecurity::Tls,
            cert_path,
            key_path,
            hops,
            max_connections: DEFAULT_MAX_CONNECTIONS,
            // 只允许一个与 echo 无关的地址：请求 127.0.0.1 必须被拒绝。
            allowed_targets: vec![TargetRule::new("192.0.2.1", Some((1, 65535)))],
            downstream: None,
        };
        let (server, listener) = TunnelServer::bind(config).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stats = server.stats_handle();
        let task = tokio::spawn(async move {
            let _ = server.serve(listener).await;
        });

        let dir_ca = TempDir::new();
        let ca_path = dir_ca.write("ca.pem", CA_PEM);
        let client = client_with_ca_file(addr, &ca_path);
        let mut tunnel = client
            .connect(&TargetAddr::Ip(echo_addr))
            .await
            .expect("首帧发送成功（拒绝发生在服务端校验后）");

        // 服务端回 CLOSE（或直接断开）：两种都必须让客户端立即失败。
        let outcome = timeout(Duration::from_secs(3), tunnel.recv())
            .await
            .expect("等待服务端拒绝超时")
            .expect("读取隧道失败");
        match outcome {
            Some(Frame {
                kind: FrameKind::Close,
                ..
            })
            | None => {}
            other => panic!("白名单拒绝必须回 CLOSE/EOF，实际 {other:?}"),
        }

        // 给可能的连接建立留一点时间，再确认目标一次都没有被连过。
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 0, "拒绝路径绝不能发起连接");
        let snapshot = stats.snapshot();
        assert_eq!(snapshot.denied, 1);
        wait_for_active(&stats, 0).await;

        task.abort();
        echo_task.abort();
    }

    fn free_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    fn base64_secret(secret: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(secret)
    }

    fn tunnel_spec(
        role: TunnelRole,
        listen: &str,
        remote: &str,
        cert_path: &Path,
        key_path: &Path,
        ca_path: &Path,
        allowed: &[SocketAddr],
    ) -> TunnelSpec {
        TunnelSpec {
            role,
            hop_id: HOP_ID.into(),
            listen: listen.into(),
            remote: remote.into(),
            security: TunnelSecurity::Tls,
            cert_pem_path: if matches!(role, TunnelRole::Listener) {
                cert_path.display().to_string()
            } else {
                String::new()
            },
            key_pem_path: if matches!(role, TunnelRole::Listener) {
                key_path.display().to_string()
            } else {
                String::new()
            },
            ca_pem_path: if matches!(role, TunnelRole::Dialer) {
                ca_path.display().to_string()
            } else {
                String::new()
            },
            hop_secret: base64_secret(HOP_SECRET),
            allowed_targets: allowed
                .iter()
                .map(|addr| TunnelTargetRule {
                    host: addr.ip().to_string(),
                    ports: Some((addr.port(), addr.port())),
                })
                .collect(),
            udp: false,
            downstream: None,
        }
    }

    /// 端到端回环：同一个 Agent 上同时收敛 Dialer 与 Listener，客户端连
    /// Dialer 的公开端口，数据经 TLS 隧道到 Listener，再回显。
    #[tokio::test]
    async fn dialer_and_listener_loop_through_supervisor() {
        let (echo_addr, echo_task) = spawn_echo().await;
        let dir = TempDir::new();
        let cert_path = dir.write("server.pem", SERVER_CERT_PEM);
        let key_path = dir.write("server-key.pem", SERVER_KEY_PEM);
        let ca_path = dir.write("ca.pem", CA_PEM);

        let listener_port = free_port();
        let dialer_port = free_port();
        let listener_spec = DesiredForward {
            id: "tunnel-listener".into(),
            listen_port: i64::from(listener_port),
            target_host: echo_addr.ip().to_string(),
            target_port: i64::from(echo_addr.port()),
            targets: Vec::new(),
            strategy: Default::default(),
            engine: ForwardEngine::Tunnel,
            protocol: Default::default(),
            udp: false,
            listen_transport: None,
            remote_transport: None,
            disable_udp: false,
            listen_host: None,
            tunnel: Some(tunnel_spec(
                TunnelRole::Listener,
                &format!("127.0.0.1:{listener_port}"),
                "",
                &cert_path,
                &key_path,
                &ca_path,
                &[echo_addr],
            )),
        };
        let dialer_spec = DesiredForward {
            id: "tunnel-dialer".into(),
            listen_port: i64::from(dialer_port),
            target_host: echo_addr.ip().to_string(),
            target_port: i64::from(echo_addr.port()),
            targets: Vec::new(),
            strategy: Default::default(),
            engine: ForwardEngine::Tunnel,
            protocol: Default::default(),
            udp: false,
            listen_transport: None,
            remote_transport: None,
            disable_udp: false,
            listen_host: None,
            tunnel: Some(tunnel_spec(
                TunnelRole::Dialer,
                &format!("127.0.0.1:{dialer_port}"),
                &format!("127.0.0.1:{listener_port}"),
                &cert_path,
                &key_path,
                &ca_path,
                &[
                    format!("127.0.0.1:{listener_port}").parse().unwrap(),
                    echo_addr,
                ],
            )),
        };

        let mut supervisor = TunnelSupervisor::new();
        supervisor.apply(&[listener_spec, dialer_spec]).await;
        let statuses = supervisor.status_handle().snapshot();
        assert_eq!(statuses.len(), 2);
        for status in &statuses {
            assert!(status.listening, "{} 必须 listening: {status:?}", status.id);
            assert!(status.error.is_empty(), "{status:?}");
        }
        assert_eq!(
            supervisor.bound_addr("tunnel-dialer").unwrap().port(),
            dialer_port
        );

        // 走真正的 Dialer 公开端口；内部会建立 TLS 隧道到 Listener。
        let mut client = TcpStream::connect(("127.0.0.1", dialer_port))
            .await
            .expect("连接 Dialer 失败");
        client.write_all(b"through-tunnel").await.unwrap();
        let mut echoed = vec![0u8; 14];
        timeout(Duration::from_secs(5), client.read_exact(&mut echoed))
            .await
            .expect("读回显超时")
            .expect("读回显失败");
        assert_eq!(&echoed, b"through-tunnel");

        drop(client);
        supervisor.apply(&[]).await;
        assert!(supervisor.status_handle().snapshot().is_empty());
        echo_task.abort();
    }

    #[tokio::test]
    async fn oversized_first_frame_disconnects() {
        let harness = Harness::start(DEFAULT_MAX_CONNECTIONS).await;
        let mut tls = raw_tls_connect(harness.addr).await;

        // 只发 5 字节帧头，声明 64 KiB + 1；服务端必须只看头就断开，
        // 不能试图分配/读取 payload。
        let mut header = [0u8; 5];
        header[0] = FrameKind::Data as u8;
        header[1..].copy_from_slice(&(MAX_FRAME_PAYLOAD as u32 + 1).to_be_bytes());
        tls.write_all(&header).await.expect("写超限帧头");
        tls.flush().await.expect("flush 超限帧头");

        let mut byte = [0u8; 1];
        match timeout(Duration::from_secs(3), tls.read(&mut byte)).await {
            // close_notify、TCP FIN、RST 都是「已断开」。
            Ok(Ok(0)) | Ok(Err(_)) => {}
            Ok(Ok(read)) => panic!("服务端应断开，实际读到 {read} 字节"),
            Err(_) => panic!("服务端未在 3s 内断开超限帧"),
        }

        wait_for_active(&harness.stats, 0).await;
    }

    #[test]
    fn reject_warning_is_throttled_to_once_per_30_seconds() {
        let now = Instant::now();
        assert!(super::reject_warn_due(None, now), "第一次超限必须记 warn");
        assert!(
            !super::reject_warn_due(Some(now), now),
            "同一时刻不能重复记"
        );
        assert!(!super::reject_warn_due(
            Some(now),
            now + Duration::from_secs(29)
        ));
        assert!(super::reject_warn_due(
            Some(now),
            now + Duration::from_secs(30)
        ));
    }

    #[tokio::test]
    async fn max_connections_rejects_new_and_keeps_existing() {
        let harness = Harness::start(1).await;
        let (echo_addr, echo_task) = spawn_echo().await;

        let mut tunnel = connect(&client_with_fixture_ca(harness.addr), echo_addr).await;
        tunnel.send_data(b"first").await.expect("首条连接可用");
        assert_eq!(recv_exact(&mut tunnel, 5).await, b"first");

        // 第二个连接在 accept 阶段就被拒；客户端可能看到 TLS 握手失败。
        client_with_fixture_ca(harness.addr)
            .connect(&TargetAddr::Ip(echo_addr))
            .await
            .err()
            .expect("超限的第二个连接必须被拒绝");

        // 已有连接不受影响。
        tunnel.send_data(b"second").await.expect("已有连接仍可写");
        assert_eq!(recv_exact(&mut tunnel, 6).await, b"second");

        let stats = harness.stats.snapshot();
        assert_eq!(stats.active, 1, "在线连接不能被超限拒绝踢掉");
        assert_eq!(stats.total, 1);
        assert_eq!(stats.rejected, 1);

        tunnel.send_close().await.expect("发送 CLOSE");
        wait_for_active(&harness.stats, 0).await;
        echo_task.abort();
    }
    /// 单连接常驻内存测量（默认 ignored，避免与其它并行测试互相干扰 RSS）。
    ///
    /// 跑法：`cargo test -p pierwave-agent tunnel_rss -- --ignored --nocapture --test-threads=1`
    ///
    /// 断言「10 个并发回环连接带来的 RSS 增量 < 2 MB」。这是从 duplex 桥接
    /// 切到 FrameIo 之后的核心收益：不再有每条连接 32 KiB 的管道 + 32 KiB
    /// 的泵缓冲。
    #[tokio::test]
    #[ignore = "RSS measurement: run with --ignored --test-threads=1 --nocapture"]
    async fn tunnel_rss_delta_for_ten_connections_is_under_two_megabytes() {
        /// 读进程物理足迹（KiB）。macOS 的 `ps` 在沙箱里不可用，改用
        /// `vmmap` 的 "Physical footprint"；它比 RSS 更接近真实占用。
        fn rss_kb() -> u64 {
            let pid = std::process::id().to_string();
            let output = std::process::Command::new("vmmap")
                .arg(&pid)
                .output()
                .expect("vmmap 必须可用");
            let text = String::from_utf8_lossy(&output.stdout);
            let line = text
                .lines()
                .find(|line| line.starts_with("Physical footprint:"))
                .expect("vmmap 输出必须包含 Physical footprint");
            let value = line
                .trim_start_matches("Physical footprint:")
                .trim()
                .trim_end_matches('K');
            value.parse().expect("physical footprint 必须是数字")
        }

        let harness = Harness::start(DEFAULT_MAX_CONNECTIONS).await;
        // 目标只 accept + 持有 socket，不分配任何读写缓冲：这样测到的增量
        // 全部来自隧道两端，而不是测试用的 echo 服务。
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_addr = listener.local_addr().unwrap();
        let held: Arc<Mutex<Vec<TcpStream>>> = Arc::new(Mutex::new(Vec::new()));
        let held_task = {
            let held = Arc::clone(&held);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    held.lock().unwrap().push(stream);
                }
            })
        };
        let now = handshake::unix_now();

        // 先建一条连接并丢弃，让 TLS/分配器的首次开销落在基线之前。
        let warmup = client_with_fixture_ca(harness.addr);
        let mut warmup_client = warmup;
        warmup_client.proof_timestamp = Some(now.saturating_sub(30));
        drop(connect(&warmup_client, echo_addr).await);
        tokio::time::sleep(Duration::from_millis(100)).await;

        let before = rss_kb();
        let mut tunnels = Vec::with_capacity(10);
        for index in 0..10 {
            let mut client = client_with_fixture_ca(harness.addr);
            // 每条连接一个唯一 proof，避免重放缓存拒绝。
            client.proof_timestamp = Some(now.saturating_sub(20 + index));
            tunnels.push(connect(&client, echo_addr).await);
        }
        wait_for_active(&harness.stats, 10).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let after = rss_kb();

        let delta = after.saturating_sub(before);
        println!(
            "RSS before={before} KiB after={after} KiB delta={delta} KiB ({:.1} KiB/连接)",
            delta as f64 / 10.0
        );
        assert!(
            delta < 2 * 1024,
            "10 个并发连接的 RSS 增量必须 < 2 MiB，实际 {delta} KiB"
        );

        drop(tunnels);
        wait_for_active(&harness.stats, 0).await;
        held_task.abort();
    }

    /// 回环吞吐基准：对比「直接 TCP」与「经隧道」的同一份数据量。
    ///
    /// 为什么这样测：设计里「800 Mbps @ 1 Gbps」那个阈值测的是链路带宽，不是隧道效率；
    /// 回环没有带宽上限，测出来的是加密与拷贝的**上限**，与链路无关，任何机器都能跑。
    ///
    /// 跑法：`cargo test --release -p pierwave-agent bench_tunnel -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "benchmark: run with --release --ignored --nocapture"]
    async fn bench_tunnel_loopback_throughput() {
        const TOTAL: u64 = 256 * 1024 * 1024; // 256 MiB
        const CHUNK: usize = 64 * 1024;

        async fn pump_direct(mut stream: TcpStream, total: u64) -> (f64, f64) {
            let start = std::time::Instant::now();
            let chunk = vec![0x5a_u8; CHUNK];
            const WINDOW: u64 = 16;
            let mut got = 0_u64;
            while got < total {
                for _ in 0..WINDOW {
                    if stream.write_all(&chunk).await.is_err() {
                        return (start.elapsed().as_secs_f64(), got as f64);
                    }
                }
                let mut need = (WINDOW * CHUNK as u64) as usize;
                let mut buf = vec![0_u8; CHUNK];
                while need > 0 {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => return (start.elapsed().as_secs_f64(), got as f64),
                        Ok(n) => {
                            need -= n.min(need);
                            got += n as u64;
                        }
                    }
                }
            }
            (start.elapsed().as_secs_f64(), got as f64)
        }

        // 基线：直接连 echo。
        let (echo_addr, echo_task) = spawn_echo().await;
        let direct = TcpStream::connect(echo_addr).await.expect("直连 echo");
        let _ = direct.set_nodelay(true);
        let (direct_secs, direct_bytes) = pump_direct(direct, TOTAL).await;
        let direct_mib = direct_bytes / direct_secs / (1024.0 * 1024.0);

        // 被测：同样的 echo，但经过隧道。单连接、1 MiB 窗口往返，避免两端缓冲互等死锁。
        let harness = Harness::start(256).await;
        let client = client_with_fixture_ca(harness.addr);
        let mut conn = connect(&client, echo_addr).await;
        let chunk = vec![0x5a_u8; CHUNK];
        const WINDOW: u64 = 16; // 16 × 64 KiB = 1 MiB
        let start = std::time::Instant::now();
        let mut got = 0_u64;
        while got < TOTAL {
            for _ in 0..WINDOW {
                conn.send_data(&chunk).await.expect("隧道写失败");
            }
            let mut need = (WINDOW * CHUNK as u64) as usize;
            while need > 0 {
                match conn.recv().await {
                    Ok(Some(frame)) if frame.kind == FrameKind::Data => {
                        let len = frame.payload.len().min(need);
                        need -= len;
                        got += frame.payload.len() as u64;
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(error) => panic!("隧道读失败: {error}"),
                }
            }
        }
        let tunnel_secs = start.elapsed().as_secs_f64();
        let tunnel_mib = got as f64 / tunnel_secs / (1024.0 * 1024.0);

        println!(
            "\n直接 TCP: {direct_mib:.0} MiB/s ({direct_secs:.2}s)\n经隧道:   {tunnel_mib:.0} MiB/s ({tunnel_secs:.2}s)\n比值:     {:.3}",
            tunnel_mib / direct_mib
        );
        echo_task.abort();
        assert!(got > 0, "隧道基准必须搬完数据");
    }
}
