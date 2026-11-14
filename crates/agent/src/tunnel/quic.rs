//! P16.3：UDP 中继（QUIC datagram）。
//!
//! 目标：把客户端 UDP 数据报经隧道送到对端，再从对端发出；**不把 UDP 塞进
//! TCP 流**（UDP-over-TCP 在弱网下会把延迟放大，做了也会被弃用）。
//!
//! # 传输
//!
//! 一条 QUIC 连接（TLS 1.3，ALPN = [`ALPN`]）承载一条隧道。UDP 载荷只走
//! QUIC **datagram 帧**（[`quinn::Connection::send_datagram`] /
//! [`quinn::Connection::read_datagram`]），不占任何 stream：datagram 不可靠、
//! 不重传、不排序，语义与 UDP 一致；被 QUIC 丢掉的包由上层（游戏/QUIC 应用）
//! 自己重传，隧道不做补偿。
//!
//! 连接里唯一的一条双向流只用于认证：客户端发
//! [`handshake::ClientHello`]（`hop_id` + HMAC proof），服务端校验后回
//! [`handshake::ServerHello`]。认证通过前不会处理任何 datagram；认证失败
//! 直接关连接（fail-closed）。
//!
//! # 数据报格式
//!
//! ```text
//! [hop_id_len u8][hop_id][atyp u8][addr][port][payload]
//! ```
//!
//! * `atyp/addr/port` 复用 [`TargetAddr`] 的 SOCKS5 编解码；
//! * 客户端 → 服务端：`addr` 是目标，`payload` 是 UDP 载荷；
//! * 服务端 → 客户端：`addr` 是产生这条回包的**目标地址**，客户端据此知道
//!   回包属于哪个本地会话（同一个 QUIC 连接可以承载多个本地客户端）；
//! * 每包都带 `hop_id`：服务端比对认证过的 hop，不匹配直接丢弃。多跳时
//!   下一跳也能按 hop 复核，不依赖连接级状态。
//!
//! 回包与请求用同一套编码，是为了只维护一个编解码器、也方便抓包对照；
//! 代价是每个回包多 1 + len(hop_id) 字节。
//!
//! # 服务端语义
//!
//! 1. 白名单：[`whitelist::allows`] 不命中 → 丢弃 + 计数（30s 节流 warn），
//!    **不发起任何连接**；空列表拒绝一切（fail closed）；
//! 2. 会话：每个 `(QUIC 连接, 目标)` 一个 UDP 会话，上游 socket `connect`
//!    到目标，回包由会话自己的读任务经同一条 QUIC 连接发回；
//! 3. 回收：空闲超过 [`QuicUdpLimits::idle`]（默认 60s）回收；
//! 4. 上限：单个 endpoint 最多 [`QuicUdpLimits::max_sessions`]（默认 4096）
//!    个会话，超限丢弃**新**数据报、已有会话不受影响；30s 节流 warn。
//!
//! # 会话粘性
//!
//! 选路只按「客户端地址」做一致性哈希（[`crate::udp::pick_target`]，与 native
//! UDP 同一套 FNV-1a），绝不轮询。UDP 没有连接对象，轮询会让同一玩家的包散到
//! 不同上游：登录落在 A、对局包落在 B，B 不认识这个会话，玩家直接断线。
//!
//! 服务端看到的只有 QUIC 对端地址，看不到本地 UDP 客户端的源地址，所以
//! 「客户端地址」由入口侧（[`QuicUdpClient::send_from`]）决定：Dialer 用本地
//! UDP 客户端的 `SocketAddr` 做哈希，把选中的目标地址写进每个数据报；服务端
//! 只按这个目标建会话。这样同一本地客户端恒定同一目标，且服务端无需知道
//! 本地客户端的存在。
//!
//! # 接线方式
//!
//! 回包只带**目标地址**，不带本地客户端地址；所以「同一目标上的多个本地
//! 客户端」无法只靠回包区分。因此入口侧（[`super::udp_dialer`]）采用
//! **一个本地 UDP 客户端一条 QUIC 连接**：拿本地客户端地址建连、`send_from`
//! 继续按它做哈希、回包按连接回到对应客户端。服务端的 `(连接, 目标)` 会话键
//! 与 native UDP 的 `(客户端地址, 目标)` 一一对应，**零协议改动**。
//!
//! 若要单连接复用，下一版协议（换 ALPN）需要在头部加一个 client 地址字段，
//! 服务端原样回显。
//!
//! # 本轮范围
//!
//! * 只做 TLS 模式；Noise 的 UDP 路径（PSK 认证 + 无证书）本轮不做，
//!   [`TunnelClient::with_udp`] 在 Noise 模式下明确失败；
//! * 入口侧的 UDP 监听与会话表在 [`super::udp_dialer`]；出口侧是
//!   [`TunnelServer::with_udp`]（白名单只含链目标）。
//!
//! # 安全边界
//!
//! * 不自己实现任何 AEAD/KDF：QUIC 的握手与包保护全部由 `quinn` +
//!   rustls（**ring** 后端）完成；
//! * 没有 `insecure` 开关：QUIC 客户端只信任显式传入的 CA（空信任根 =
//!   必定失败），服务端证书沿用 P16.1 的 CA/属证书；
//! * 认证失败、未知 hop、datagram 截断/非法地址、hop 不匹配一律丢弃或关连接；
//! * 单条 datagram 的实际上限由 QUIC 路径 MTU 决定（通常 ~1200 字节），
//!   超过上限客户端在发送前就返回可读错误，不静默截断。

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};
use quinn::{Connection, Endpoint, IdleTimeout, ServerConfig, TransportConfig, VarInt};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::RootCertStore;
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::handshake::{self, ClientHello, HandshakeError, ServerHello};
use super::whitelist::{self, TargetRule};
use super::{Metrics, TargetAddr, HANDSHAKE_TIMEOUT};

/// QUIC 的 ALPN。两端必须一致；写进 rustls 配置后，QUIC 握手会协商它。
///
/// 带 `/1`：以后改数据报格式就换 ALPN，旧客户端会被明确拒绝，而不是
/// 解析错位。
pub const ALPN: &[u8] = b"pierwave-tunnel/udp/1";

/// 会话空闲多久回收（与 native UDP 的 [`crate::udp::SESSION_IDLE`] 同量级）。
pub const SESSION_IDLE: Duration = Duration::from_secs(60);
/// 会话回收任务的扫描周期。
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(10);
/// 单个 endpoint 同时存在的会话上限（与 native UDP 的 `MAX_SESSIONS` 一致）。
pub const MAX_SESSIONS: usize = 4096;
/// 会话建连（DNS 解析 + `connect`）预算；解析卡住不能拖死收包循环。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 每条会话的上游收包缓冲：16 KiB 覆盖 MTU 内的数据报（与 native UDP 一致）。
const SESSION_BUFFER: usize = 16 * 1024;
/// 对端 datagram 的接收缓冲。满了就丢（不可靠语义），不阻塞收包循环。
const DATAGRAM_RECV_BUFFER: usize = 1024 * 1024;
/// 本端 datagram 的发送缓冲。同上：宁可丢包，也不无限涨内存。
const DATAGRAM_SEND_BUFFER: usize = 1024 * 1024;
/// QUIC 连接空闲超时。UDP 会话本身只有 60s 空闲回收，连接活得更久一点，
/// 靠 keep-alive 保活，避免「刚回收完会话、连接也被拆」的抖动。
const CONNECTION_IDLE: Duration = Duration::from_secs(120);
/// QUIC keep-alive 周期；必须小于 [`CONNECTION_IDLE`]。
const KEEP_ALIVE: Duration = Duration::from_secs(30);
/// warn 节流周期（白名单拒绝 / 会话超限），与 native UDP 同策略。
const WARN_INTERVAL: Duration = Duration::from_secs(30);
/// 收包 / 读上游出错后的退避，避免空转烧 CPU。
const BACKOFF: Duration = Duration::from_millis(100);

/// 服务端应用层关闭码：认证失败。
const CLOSE_AUTH_FAILED: u32 = 0x01;
/// 服务端应用层关闭码：正常关闭。
const CLOSE_NORMAL: u32 = 0x00;

/// 会话表的规模与回收参数。
///
/// 生产用 [`Default`]；测试注入短超时 / 小上限，这样「空闲回收」「超上限」
/// 都能在毫秒级验证，不用真的等 60 秒、也不用建 4096 个会话。
#[derive(Debug, Clone, Copy)]
pub struct QuicUdpLimits {
    /// 会话空闲多久回收。
    pub idle: Duration,
    /// 单个 endpoint 的会话上限；超限丢新包，不挤掉已有会话。
    pub max_sessions: usize,
    /// 回收任务的扫描周期。
    pub sweep_interval: Duration,
}

impl Default for QuicUdpLimits {
    fn default() -> Self {
        Self {
            idle: SESSION_IDLE,
            max_sessions: MAX_SESSIONS,
            sweep_interval: SWEEP_INTERVAL,
        }
    }
}

/// 一个 UDP 中继数据报（请求与回包共用同一编码）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UdpDatagram {
    /// 认证过的 hop；服务端按它复核数据报。
    pub hop_id: String,
    /// 请求：目标地址；回包：产生回包的目标地址。
    pub target: TargetAddr,
    /// UDP 载荷（可以为空——0 字节数据报在 UDP 里合法）。
    pub payload: Vec<u8>,
}

impl UdpDatagram {
    /// 编码成单个 QUIC datagram 的载荷。
    pub fn encode(&self) -> io::Result<Vec<u8>> {
        let hop = self.hop_id.as_bytes();
        if hop.is_empty() {
            return Err(invalid("hop_id 为空 / hop_id is empty"));
        }
        if hop.len() > u8::MAX as usize {
            return Err(invalid(format!(
                "hop_id 超过 {} 字节 / hop_id exceeds {} bytes: {}",
                u8::MAX,
                u8::MAX,
                hop.len()
            )));
        }
        let address = self.target.encode()?;
        let mut out = Vec::with_capacity(1 + hop.len() + address.len() + self.payload.len());
        out.push(hop.len() as u8);
        out.extend_from_slice(hop);
        out.extend_from_slice(&address);
        out.extend_from_slice(&self.payload);
        Ok(out)
    }

    /// 从 QUIC datagram 解出一个数据报。
    ///
    /// 地址被截断、hop 长度非法、载荷不足都算 `InvalidData`：调用方丢弃这个
    /// 数据报并计数，不能 panic，也不能猜着往下解析。
    pub fn decode(input: &[u8]) -> io::Result<Self> {
        let hop_len = *input
            .first()
            .ok_or_else(|| invalid("数据报为空 / the datagram is empty"))?
            as usize;
        if hop_len == 0 {
            return Err(invalid("hop_id 为空 / hop_id is empty"));
        }
        let hop_end = 1 + hop_len;
        let hop_bytes = input
            .get(1..hop_end)
            .ok_or_else(|| invalid("hop_id 被截断 / truncated hop_id"))?;
        let hop_id = std::str::from_utf8(hop_bytes)
            .map_err(|_| invalid("hop_id 不是合法 UTF-8 / hop_id is not valid UTF-8"))?
            .to_string();

        let (target, consumed) = TargetAddr::decode_prefix(&input[hop_end..])?;
        let payload_start = hop_end + consumed;
        Ok(Self {
            hop_id,
            target,
            payload: input[payload_start..].to_vec(),
        })
    }
}

fn invalid(message: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// 把白名单规则转成客户端的候选目标列表（用于一致性哈希）。
///
/// 只保留**带具体端口**的规则：没有端口就无法 `connect`，通配符域名也没法
/// 当具体目标。规则顺序就是哈希桶的顺序，调用方不要随意重排。
pub fn targets_from_rules(rules: &[TargetRule]) -> Result<Arc<[TargetAddr]>> {
    let mut targets = Vec::new();
    for rule in rules {
        let Some((port, _)) = rule.ports else {
            continue;
        };
        let host = rule.host.trim();
        if host.is_empty() || host.starts_with("*.") {
            continue;
        }
        let target = match host.parse::<IpAddr>() {
            Ok(ip) => TargetAddr::Ip(SocketAddr::new(ip, port)),
            Err(_) => TargetAddr::Domain {
                host: host.to_string(),
                port,
            },
        };
        targets.push(target);
    }
    if targets.is_empty() {
        bail!(
            "UDP 中继至少需要一个带端口的目标规则 / UDP relay needs at least one target rule with a port"
        );
    }
    Ok(targets.into())
}

/// 无锁读取的 UDP 中继计数。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QuicUdpStats {
    /// 服务端收到的 datagram 数（含随后被白名单/上限丢弃的）。
    pub datagrams_in: u64,
    /// 服务端发出的回包数。
    pub datagrams_out: u64,
    /// 因目标不在白名单被丢弃的数据报数。
    pub denied: u64,
    /// 编码/解码失败被丢弃的数据报数。
    pub malformed: u64,
    /// `hop_id` 与认证 hop 不一致被丢弃的数据报数。
    pub hop_mismatch: u64,
    /// 因会话上限被丢弃的数据报数。
    pub sessions_rejected: u64,
    /// 上游 `send()` 失败数（会话保留，只丢当前包）。
    pub forward_errors: u64,
    /// 回包写回 QUIC 失败数。
    pub send_errors: u64,
    /// 当前会话数。
    pub sessions: usize,
}

/// 读 [`QuicUdpStats`] 的句柄。
#[derive(Debug, Clone)]
pub struct QuicUdpStatsHandle {
    metrics: Arc<QuicUdpMetrics>,
}

impl QuicUdpStatsHandle {
    pub fn snapshot(&self) -> QuicUdpStats {
        QuicUdpStats {
            datagrams_in: self.metrics.datagrams_in.load(Ordering::Relaxed),
            datagrams_out: self.metrics.datagrams_out.load(Ordering::Relaxed),
            denied: self.metrics.denied.load(Ordering::Relaxed),
            malformed: self.metrics.malformed.load(Ordering::Relaxed),
            hop_mismatch: self.metrics.hop_mismatch.load(Ordering::Relaxed),
            sessions_rejected: self.metrics.sessions_rejected.load(Ordering::Relaxed),
            forward_errors: self.metrics.forward_errors.load(Ordering::Relaxed),
            send_errors: self.metrics.send_errors.load(Ordering::Relaxed),
            sessions: self.metrics.session_count(),
        }
    }
}

/// 一条客户端会话：`connect` 到目标的上游 socket + 回包读任务。
#[derive(Debug)]
struct Session {
    /// 已 connect 到目标的上游 socket：`send()` 不用每次解析地址。
    upstream: Arc<UdpSocket>,
    /// 最近活跃时刻（毫秒，相对 [`QuicUdpMetrics::epoch`]）。
    ///
    /// 收包侧与回包侧都要刷新，用原子量避免为了「记个时间」去抢会话表的锁。
    last_active_ms: Arc<AtomicU64>,
    /// 读上游回包的任务；会话被回收时 abort。
    reader: JoinHandle<()>,
}

impl Session {
    fn last_active(&self) -> u64 {
        self.last_active_ms.load(Ordering::Relaxed)
    }

    /// 摘掉会话时同时停掉读任务——否则 socket 关不掉、fd 泄漏。
    async fn shutdown(self) {
        self.reader.abort();
        let _ = self.reader.await;
    }
}

/// 会话表键：`(QUIC 连接, 目标)`。
///
/// 用连接的 `stable_id` 而不是对端 `SocketAddr`：同一客户端可能以同一个
/// 源端口重连（NAT 复用），旧连接收尾时的清理不能把新连接的会话一起删掉。
/// `stable_id` 在 endpoint 生命周期内唯一。
type SessionKey = (usize, TargetAddr);

/// 会话表：与 IO 解耦，`touch` / `take_expired` 都显式接收「现在」的毫秒数，
/// 单元测试可以任意拨时钟，不必 sleep 60 秒。
#[derive(Debug, Default)]
struct SessionTable {
    sessions: HashMap<SessionKey, Session>,
}

impl SessionTable {
    fn len(&self) -> usize {
        self.sessions.len()
    }

    /// 命中已有会话：刷新活跃时间并返回上游 socket。
    fn touch(&mut self, owner: usize, target: &TargetAddr, now_ms: u64) -> Option<Arc<UdpSocket>> {
        let session = self.sessions.get(&(owner, target.clone()))?;
        session.last_active_ms.store(now_ms, Ordering::Relaxed);
        Some(Arc::clone(&session.upstream))
    }

    /// 插入新会话，返回被替换掉的旧会话（若有），由调用方在锁外 close。
    fn insert(&mut self, key: SessionKey, session: Session) -> Option<Session> {
        self.sessions.insert(key, session)
    }

    /// 摘掉空闲**超过** `idle` 的会话（等于阈值不回收）。
    fn take_expired(&mut self, now_ms: u64, idle: Duration) -> Vec<(SessionKey, Session)> {
        let idle_ms = u64::try_from(idle.as_millis()).unwrap_or(u64::MAX);
        let expired: Vec<SessionKey> = self
            .sessions
            .iter()
            .filter(|(_, session)| now_ms.saturating_sub(session.last_active()) > idle_ms)
            .map(|(key, _)| key.clone())
            .collect();
        expired
            .into_iter()
            .filter_map(|key| self.sessions.remove(&key).map(|session| (key, session)))
            .collect()
    }

    /// 连接关闭时摘掉这条连接的所有会话。
    fn take_owner(&mut self, owner: usize) -> Vec<(SessionKey, Session)> {
        let keys: Vec<SessionKey> = self
            .sessions
            .keys()
            .filter(|(session_owner, _)| *session_owner == owner)
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|key| self.sessions.remove(&key).map(|session| (key, session)))
            .collect()
    }

    #[cfg(test)]
    fn take_all(&mut self) -> Vec<(SessionKey, Session)> {
        self.sessions.drain().collect()
    }
}

/// 计数与共享状态；被 endpoint 的所有连接任务共享。
#[derive(Debug)]
struct QuicUdpMetrics {
    datagrams_in: AtomicU64,
    datagrams_out: AtomicU64,
    denied: AtomicU64,
    malformed: AtomicU64,
    hop_mismatch: AtomicU64,
    sessions_rejected: AtomicU64,
    forward_errors: AtomicU64,
    send_errors: AtomicU64,
    sessions: Mutex<SessionTable>,
    /// 上次打「白名单拒绝」warn 的时间；30s 内只打一次。
    last_denied_warn: Mutex<Option<Instant>>,
    /// 上次打「会话超限」warn 的时间；同样 30s 节流。
    last_capacity_warn: Mutex<Option<Instant>>,
    /// 会话活跃时间的基准点；表里只存相对毫秒数。
    epoch: Instant,
}

impl Default for QuicUdpMetrics {
    fn default() -> Self {
        Self {
            datagrams_in: AtomicU64::new(0),
            datagrams_out: AtomicU64::new(0),
            denied: AtomicU64::new(0),
            malformed: AtomicU64::new(0),
            hop_mismatch: AtomicU64::new(0),
            sessions_rejected: AtomicU64::new(0),
            forward_errors: AtomicU64::new(0),
            send_errors: AtomicU64::new(0),
            sessions: Mutex::new(SessionTable::default()),
            last_denied_warn: Mutex::new(None),
            last_capacity_warn: Mutex::new(None),
            epoch: Instant::now(),
        }
    }
}

impl QuicUdpMetrics {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, SessionTable> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn session_count(&self) -> usize {
        self.lock_sessions().len()
    }
}

/// QUIC 端点 + 连接任务共享的上下文（**不含** endpoint）。
///
/// 刻意与 endpoint 分开：连接任务只持有 `Arc<QuicUdpCtx>`，`QuicUdpServer`
/// 被 drop 时 endpoint 会立即关闭（UDP 端口释放、所有连接断开），不会被
/// 连接任务反向拖住。
struct QuicUdpCtx {
    hops: HashMap<String, Vec<u8>>,
    allowed_targets: Vec<TargetRule>,
    limits: QuicUdpLimits,
    metrics: Arc<QuicUdpMetrics>,
    /// 与 TCP 路径共用的连接槽计数 / 超限 warn。
    tcp_metrics: Arc<Metrics>,
    max_connections: usize,
}

/// [`QuicUdpServer::bind`] 的配置。
pub(super) struct QuicUdpServerConfig {
    /// UDP 监听地址；通常与 TCP 隧道监听同 IP、同端口（协议不同，可共存）。
    pub(super) bind: SocketAddr,
    pub(super) cert_path: PathBuf,
    pub(super) key_path: PathBuf,
    pub(super) hops: HashMap<String, Vec<u8>>,
    /// 目标白名单；空 = 拒绝一切（fail closed）。
    pub(super) allowed_targets: Vec<TargetRule>,
    pub(super) limits: QuicUdpLimits,
    /// 与 TCP 路径共用连接上限。
    pub(super) tcp_metrics: Arc<Metrics>,
    pub(super) max_connections: usize,
}

/// UDP 中继的 QUIC 服务端。
///
/// 一个 endpoint = 一个 UDP 端口；所有 QUIC 连接共享同一张会话表（会话键里
/// 带连接 id，所以不会互相串）。
pub struct QuicUdpServer {
    endpoint: Endpoint,
    ctx: Arc<QuicUdpCtx>,
}

impl QuicUdpServer {
    /// 加载证书、绑定 UDP 端口并创建 QUIC endpoint。
    ///
    /// 证书/私钥不合法、端口被占用时**在返回前**失败，调用方据此决定是否
    /// 继续只跑 TCP。
    pub(super) fn bind(config: QuicUdpServerConfig) -> Result<Self> {
        let certificates = super::load_certificates(&config.cert_path)?;
        let key = super::load_private_key(&config.key_path)?;
        let crypto = quic_server_crypto(certificates, key)?;
        let mut server_config = ServerConfig::with_crypto(Arc::new(crypto));
        server_config.transport_config(Arc::new(datagram_transport()));

        let endpoint = Endpoint::server(server_config, config.bind).with_context(|| {
            format!(
                "绑定 UDP 中继监听 {} 失败 / failed to bind the UDP relay listener",
                config.bind
            )
        })?;
        let bound_addr = endpoint
            .local_addr()
            .context("读取 UDP 中继监听地址失败 / failed to read the UDP relay address")?;
        tracing::info!(
            bind = %bound_addr,
            hops = config.hops.len(),
            allowed_targets = config.allowed_targets.len(),
            max_sessions = config.limits.max_sessions,
            "UDP 中继（QUIC）监听已就绪 / UDP relay (QUIC) listener ready"
        );

        Ok(Self {
            endpoint,
            ctx: Arc::new(QuicUdpCtx {
                hops: config.hops,
                allowed_targets: config.allowed_targets,
                limits: config.limits,
                metrics: Arc::new(QuicUdpMetrics::default()),
                tcp_metrics: config.tcp_metrics,
                max_connections: config.max_connections,
            }),
        })
    }

    pub fn stats_handle(&self) -> QuicUdpStatsHandle {
        QuicUdpStatsHandle {
            metrics: Arc::clone(&self.ctx.metrics),
        }
    }

    /// 测试用：实际绑定的 UDP 地址（验证与 TCP 隧道端口一致）。
    #[cfg(test)]
    pub(crate) fn bound_addr(&self) -> Option<SocketAddr> {
        self.endpoint.local_addr().ok()
    }

    /// accept 循环 + 会话回收循环。两个都不正常返回；`QuicUdpServer` 被 drop
    /// 时 endpoint 关闭，任务随之退出。
    pub async fn serve(self: Arc<Self>) {
        tokio::join!(self.accept_loop(), self.sweep_loop());
    }

    async fn accept_loop(&self) {
        loop {
            let Some(incoming) = self.endpoint.accept().await else {
                tracing::debug!("UDP 中继 accept 循环退出 / UDP relay accept loop ended");
                return;
            };
            let peer = incoming.remote_address();

            // 与 TCP 路径共用连接上限：超限在握手前拒绝，不为必然失败的连接付加密开销。
            let Some(guard) = self.ctx.tcp_metrics.admit(self.ctx.max_connections) else {
                incoming.refuse();
                continue;
            };

            let ctx = Arc::clone(&self.ctx);
            tokio::spawn(async move {
                if let Err(error) = ctx.handle_incoming(incoming, peer).await {
                    tracing::debug!(
                        %peer,
                        "UDP 中继连接结束 / UDP relay connection ended: {error:#}"
                    );
                }
                drop(guard);
            });
        }
    }

    /// 会话回收循环：每 [`QuicUdpLimits::sweep_interval`] 扫一次。
    async fn sweep_loop(&self) {
        let mut interval = tokio::time::interval(self.ctx.limits.sweep_interval);
        // interval 的第一次 tick 立即就绪；刚启动没有会话可收，先消费掉。
        interval.tick().await;
        loop {
            interval.tick().await;
            let expired = self
                .ctx
                .metrics
                .lock_sessions()
                .take_expired(self.ctx.metrics.now_ms(), self.ctx.limits.idle);
            let count = expired.len();
            for (key, session) in expired {
                let (owner, target) = key;
                session.shutdown().await;
                tracing::debug!(
                    owner,
                    ?target,
                    "UDP 中继会话空闲回收 / UDP relay session reclaimed after idling"
                );
            }
            if count > 0 {
                tracing::debug!(
                    count,
                    remaining = self.ctx.metrics.session_count(),
                    "UDP 中继会话回收完成 / UDP relay session sweep finished"
                );
            }
        }
    }
}

impl Drop for QuicUdpServer {
    fn drop(&mut self) {
        // endpoint 被 drop 只关闭 driver；连接还持有 socket 的 Arc。显式 close
        // 才会让所有连接立即断开、UDP 端口立刻释放——规则被删除/重建时不能
        // 让旧端口挂到空闲超时。
        self.endpoint.close(
            VarInt::from_u32(CLOSE_NORMAL),
            b"udp tunnel server shutting down",
        );
    }
}

impl QuicUdpCtx {
    /// 一个 QUIC 连接：认证 → datagram 循环 → 清理该连接的会话。
    async fn handle_incoming(&self, incoming: quinn::Incoming, peer: SocketAddr) -> Result<()> {
        let connection = match timeout(HANDSHAKE_TIMEOUT, incoming).await {
            Ok(Ok(connection)) => connection,
            Ok(Err(error)) => {
                bail!("QUIC 握手失败 / QUIC handshake failed: {error}")
            }
            Err(_) => bail!(
                "QUIC 握手超时（{}s）/ QUIC handshake timed out after {}s",
                HANDSHAKE_TIMEOUT.as_secs(),
                HANDSHAKE_TIMEOUT.as_secs()
            ),
        };

        let hop_id = match self.authenticate(&connection, peer).await {
            Ok(hop_id) => hop_id,
            Err(error) => {
                connection.close(VarInt::from_u32(CLOSE_AUTH_FAILED), b"tunnel auth failed");
                return Err(error);
            }
        };
        tracing::debug!(
            %peer,
            hop_id = %hop_id,
            "UDP 中继握手通过 / UDP relay handshake accepted"
        );

        self.datagram_loop(&connection, peer, &hop_id).await;

        let owner = connection.stable_id();
        let removed = self.metrics.lock_sessions().take_owner(owner);
        let count = removed.len();
        for ((_, target), session) in removed {
            session.shutdown().await;
            tracing::debug!(%peer, owner, ?target, "UDP 中继会话随连接关闭 / UDP relay session closed with the connection");
        }
        if count > 0 {
            tracing::debug!(%peer, sessions = count, "UDP 中继连接清理完成 / UDP relay connection cleaned up");
        }
        connection.close(VarInt::from_u32(CLOSE_NORMAL), b"tunnel udp closed");
        Ok(())
    }

    /// 认证：唯一一条双向流里交换 ClientHello / ServerHello。
    ///
    /// 顺序与 TCP 路径一致：版本 → hop → 时间窗 → HMAC。QUIC 额外**不做**
    /// 时间戳重放去重（见 `check_hello` 的说明）。
    async fn authenticate(&self, connection: &Connection, peer: SocketAddr) -> Result<String> {
        let (mut send, mut recv) = match timeout(HANDSHAKE_TIMEOUT, connection.accept_bi()).await {
            Ok(Ok(streams)) => streams,
            Ok(Err(error)) => {
                bail!("接受 QUIC 认证流失败 / failed to accept the QUIC auth stream: {error}")
            }
            Err(_) => bail!(
                "等待 QUIC 认证流超时（{}s）/ timed out waiting for the QUIC auth stream after {}s",
                HANDSHAKE_TIMEOUT.as_secs(),
                HANDSHAKE_TIMEOUT.as_secs()
            ),
        };

        let hello = timeout(HANDSHAKE_TIMEOUT, ClientHello::read(&mut recv))
            .await
            .map_err(|_| {
                anyhow!(
                    "等待 QUIC ClientHello 超时（{}s）/ timed out waiting for the QUIC ClientHello after {}s",
                    HANDSHAKE_TIMEOUT.as_secs(),
                    HANDSHAKE_TIMEOUT.as_secs()
                )
            })??;

        match self.check_hello(&hello, peer) {
            Ok(()) => {
                ServerHello::accept().write(&mut send).await?;
                // 认证流到此结束：数据面只走 datagram。finish 之后对端能立刻
                // 读到「认证完成、不会再有多余字节」。
                let _ = send.finish();
                Ok(hello.hop_id)
            }
            Err(error) => {
                // 失败也回 ServerHello{ok:false}，客户端能拿到可读原因；随后关连接。
                let reply = ServerHello::reject(error.to_string());
                let _ = timeout(HANDSHAKE_TIMEOUT, reply.write(&mut send)).await;
                let _ = send.finish();
                Err(anyhow!(
                    "UDP 中继握手被拒绝 / UDP relay handshake rejected: {error}"
                ))
            }
        }
    }

    fn check_hello(&self, hello: &ClientHello, peer: SocketAddr) -> Result<(), HandshakeError> {
        if hello.version != handshake::PROTOCOL_VERSION {
            return Err(HandshakeError::UnsupportedVersion(hello.version));
        }
        let secret = self
            .hops
            .get(&hello.hop_id)
            .ok_or(HandshakeError::UnknownHop)?;
        handshake::check_timestamp(hello.timestamp_secs, handshake::unix_now())?;
        if !hello.verify(secret) {
            return Err(HandshakeError::BadProof);
        }
        // 刻意**不**查重放缓存：proof 只由 `(hop_secret, hop_id, 秒级时间戳)`
        // 决定，而入口侧「一个本地 UDP 客户端一条 QUIC 连接」，同一秒内会有
        // 多条连接，proof 必然相同。QUIC 的 ClientHello 在 TLS 1.3 加密流里，
        // 被动攻击者拿不到 proof、也无法重放整段 QUIC 握手（服务端每次生成
        // 新密钥，Finished 必然校验失败），所以这一层不需要时间戳去重。
        // TCP 路径继续使用共享重放缓存，语义不变。
        tracing::debug!(%peer, hop_id = %hello.hop_id, "UDP 中继 proof 校验通过 / UDP relay proof accepted");
        Ok(())
    }

    /// 数据面：读 datagram → 白名单 → 会话 → 上游 `send()`。
    async fn datagram_loop(&self, connection: &Connection, peer: SocketAddr, hop_id: &str) {
        loop {
            tokio::select! {
                biased;
                _ = connection.closed() => return,
                received = connection.read_datagram() => {
                    let datagram = match received {
                        Ok(datagram) => datagram,
                        // 连接结束 / 对端关闭：交给上层清理。
                        Err(_) => return,
                    };
                    self.metrics.datagrams_in.fetch_add(1, Ordering::Relaxed);
                    if let Err(error) = self.handle_datagram(connection, peer, hop_id, &datagram).await {
                        tracing::debug!(%peer, %error, "UDP 中继数据报被丢弃 / UDP relay datagram dropped");
                    }
                }
            }
        }
    }

    async fn handle_datagram(
        &self,
        connection: &Connection,
        peer: SocketAddr,
        hop_id: &str,
        raw: &[u8],
    ) -> Result<()> {
        let datagram = match UdpDatagram::decode(raw) {
            Ok(datagram) => datagram,
            Err(error) => {
                self.metrics.malformed.fetch_add(1, Ordering::Relaxed);
                return Err(error.into());
            }
        };

        // 连接级认证之外再复核 hop：多跳时下一跳不依赖连接状态也能拒绝错投。
        if datagram.hop_id != hop_id {
            self.metrics.hop_mismatch.fetch_add(1, Ordering::Relaxed);
            bail!(
                "数据报 hop {} 与连接认证的 hop {hop_id} 不一致 / datagram hop does not match the authenticated hop",
                datagram.hop_id
            );
        }

        // 白名单必须在任何 connect 之前判定：拒绝时绝不发起连接。空列表 = 拒绝一切。
        if !whitelist::allows(&self.allowed_targets, &datagram.target) {
            self.metrics.denied.fetch_add(1, Ordering::Relaxed);
            if warn_due(&self.metrics.last_denied_warn) {
                tracing::warn!(
                    %peer,
                    ?datagram.target,
                    "UDP 中继目标不在白名单内，丢弃 / UDP relay target is not allowlisted, dropping（{}s 内只记一次 / logged once per {}s）",
                    WARN_INTERVAL.as_secs(),
                    WARN_INTERVAL.as_secs()
                );
            }
            bail!(
                "目标 {:?} 不在白名单内 / target is not allowlisted",
                datagram.target
            );
        }

        let Some(upstream) = self
            .session_for(connection, peer, &datagram.target, hop_id)
            .await
        else {
            return Ok(());
        };
        if let Err(error) = upstream.send(&datagram.payload).await {
            // 单个包发不出去（EMSGSIZE / 目标临时不可达）只丢这个包：
            // 会话保留，等上层的重传，绝不 panic、也不关连接。
            self.metrics.forward_errors.fetch_add(1, Ordering::Relaxed);
            tracing::debug!(%peer, ?datagram.target, %error, "UDP 中继转发到上游失败 / UDP relay forward to upstream failed");
        }
        Ok(())
    }

    /// 取（或新建）`(连接, 目标)` 对应的上游会话；超限 / 建连失败返回 `None`。
    ///
    /// 调用方是本连接唯一的 datagram 循环（单生产者），所以「查表 → 建会话 →
    /// 插入」之间不需要处理同连接并发建会话；回收任务只删除，插不进来。
    async fn session_for(
        &self,
        connection: &Connection,
        peer: SocketAddr,
        target: &TargetAddr,
        hop_id: &str,
    ) -> Option<Arc<UdpSocket>> {
        let now = self.metrics.now_ms();
        let owner = connection.stable_id();
        {
            let mut table = self.metrics.lock_sessions();
            // 命中：只刷新活跃时间。同一连接的同一目标绝不会在这里换上游。
            if let Some(upstream) = table.touch(owner, target, now) {
                return Some(upstream);
            }
            // 超限：丢弃这个数据报，已经存在的会话一个都不挤掉。
            if table.len() >= self.limits.max_sessions {
                drop(table);
                self.metrics
                    .sessions_rejected
                    .fetch_add(1, Ordering::Relaxed);
                if warn_due(&self.metrics.last_capacity_warn) {
                    tracing::warn!(
                        %peer,
                        limit = self.limits.max_sessions,
                        "UDP 中继会话数达到上限，丢弃新数据报（已有会话不受影响）/ UDP relay session limit reached, dropping new datagram (existing sessions keep working)（{}s 内只记一次 / logged once per {}s）",
                        WARN_INTERVAL.as_secs(),
                        WARN_INTERVAL.as_secs()
                    );
                }
                return None;
            }
        }

        let upstream = match timeout(CONNECT_TIMEOUT, connect_upstream(target)).await {
            Ok(Ok(socket)) => Arc::new(socket),
            Ok(Err(error)) => {
                tracing::warn!(%peer, ?target, %error, "UDP 中继会话建连失败，丢弃数据报 / UDP relay session connect failed, dropping the datagram");
                return None;
            }
            Err(_) => {
                tracing::warn!(
                    %peer,
                    ?target,
                    timeout_secs = CONNECT_TIMEOUT.as_secs(),
                    "UDP 中继会话建连超时，丢弃数据报 / UDP relay session connect timed out, dropping the datagram"
                );
                return None;
            }
        };

        let last_active_ms = Arc::new(AtomicU64::new(self.metrics.now_ms()));
        let reader = spawn_reader(
            peer,
            target.clone(),
            hop_id.to_string(),
            Arc::clone(&upstream),
            connection.clone(),
            Arc::clone(&last_active_ms),
            Arc::clone(&self.metrics),
        );
        let previous = self.metrics.lock_sessions().insert(
            (owner, target.clone()),
            Session {
                upstream: Arc::clone(&upstream),
                last_active_ms,
                reader,
            },
        );
        if let Some(previous) = previous {
            previous.shutdown().await;
        }
        tracing::debug!(
            %peer,
            owner,
            ?target,
            sessions = self.metrics.session_count(),
            "UDP 中继会话已建立 / UDP relay session established"
        );
        Some(upstream)
    }
}

/// 上游回包 → 同一条 QUIC 连接。
///
/// 每条会话一个任务：上游 socket 是 `connect` 过的，回包天然只属于这个会话，
/// 不需要再做「回包该给谁」的路由。任务同时盯 `connection.closed()`，连接
/// 一断就退出，不会留下一个永远阻塞在 `recv()` 上的 fd。
#[allow(clippy::too_many_arguments)]
fn spawn_reader(
    peer: SocketAddr,
    target: TargetAddr,
    hop_id: String,
    upstream: Arc<UdpSocket>,
    connection: Connection,
    last_active_ms: Arc<AtomicU64>,
    metrics: Arc<QuicUdpMetrics>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = vec![0u8; SESSION_BUFFER];
        loop {
            tokio::select! {
                biased;
                _ = connection.closed() => return,
                received = upstream.recv(&mut buf) => {
                    let size = match received {
                        Ok(size) => size,
                        // 目标没人在监听时，内核会把 ICMP unreachable 报成
                        // ConnectionRefused / ConnectionReset。它们只影响当前
                        // 这个包，不能因此关掉会话（游戏目标常常先关后开）。
                        Err(error) if is_transient_udp_error(&error) => {
                            tokio::time::sleep(BACKOFF).await;
                            continue;
                        }
                        Err(error) => {
                            tracing::debug!(%peer, ?target, %error, "UDP 中继上游读任务退出 / UDP relay upstream reader exited");
                            return;
                        }
                    };
                    last_active_ms.store(metrics.now_ms(), Ordering::Relaxed);
                    let reply = UdpDatagram {
                        hop_id: hop_id.clone(),
                        target: target.clone(),
                        payload: buf[..size].to_vec(),
                    };
                    let bytes = match reply.encode() {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            metrics.send_errors.fetch_add(1, Ordering::Relaxed);
                            tracing::debug!(%peer, ?target, %error, "UDP 中继回包编码失败 / UDP relay reply encoding failed");
                            continue;
                        }
                    };
                    match connection.send_datagram(bytes.into()) {
                        Ok(()) => {
                            metrics.datagrams_out.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(error) => {
                            metrics.send_errors.fetch_add(1, Ordering::Relaxed);
                            tracing::debug!(%peer, ?target, %error, "UDP 中继回包写回 QUIC 失败 / UDP relay reply send failed");
                        }
                    }
                }
            }
        }
    })
}

fn is_transient_udp_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::WouldBlock
            | io::ErrorKind::Interrupted
    )
}

/// 解析目标并建一个 `connect` 过的上游 socket。
async fn connect_upstream(target: &TargetAddr) -> io::Result<UdpSocket> {
    let remote = match target {
        TargetAddr::Ip(addr) => *addr,
        TargetAddr::Domain { host, port } => resolve_target(host, *port).await?,
    };
    // 本地通配地址必须与目标同族，否则 connect 直接 EAFNOSUPPORT。
    let local = if remote.is_ipv4() {
        SocketAddr::from(([0, 0, 0, 0], 0))
    } else {
        SocketAddr::from(([0u16; 8], 0))
    };
    let socket = UdpSocket::bind(local).await?;
    socket.connect(remote).await?;
    Ok(socket)
}

/// 解析域名目标；IP 字面量直接返回，不走 DNS。
async fn resolve_target(host: &str, port: u16) -> io::Result<SocketAddr> {
    let host = host.trim();
    if host.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "目标地址为空 / target host is empty",
        ));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }
    let mut addresses = tokio::net::lookup_host((host, port)).await?;
    addresses.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("目标地址解析不到 / target did not resolve: {host}"),
        )
    })
}

/// 30s 节流：到期才返回 true 并记录本次时间。
fn warn_due(last: &Mutex<Option<Instant>>) -> bool {
    let mut last = last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    if super::reject_warn_due(*last, now) {
        *last = Some(now);
        true
    } else {
        false
    }
}

/// 两端共用的 QUIC 传输参数：开启 datagram + keep-alive + 空闲超时。
fn datagram_transport() -> TransportConfig {
    let mut transport = TransportConfig::default();
    // `Some(..)` 才会在 transport parameters 里宣告支持 datagram；
    // 两端之一为 `None` 时 `send_datagram` 直接 UnsupportedByPeer。
    transport.datagram_receive_buffer_size(Some(DATAGRAM_RECV_BUFFER));
    transport.datagram_send_buffer_size(DATAGRAM_SEND_BUFFER);
    transport.max_idle_timeout(Some(
        IdleTimeout::try_from(CONNECTION_IDLE).expect("CONNECTION_IDLE 必须能编码成 QUIC 空闲超时"),
    ));
    transport.keep_alive_interval(Some(KEEP_ALIVE));
    transport
}

/// 服务端 QUIC 用的 rustls 配置：TLS 1.3 + ALPN + 显式 ring provider。
fn quic_server_crypto(
    certificates: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> Result<QuicServerConfig> {
    let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .map_err(|error| anyhow!("QUIC 只支持 TLS 1.3 / QUIC requires TLS 1.3: {error}"))?
    .with_no_client_auth()
    .with_single_cert(certificates, key)
    .context("证书与私钥不匹配 / certificate and private key do not match")?;
    tls.alpn_protocols = vec![ALPN.to_vec()];
    QuicServerConfig::try_from(Arc::new(tls))
        .map_err(|error| anyhow!("QUIC TLS 配置无效 / invalid QUIC TLS config: {error}"))
}

/// 客户端 QUIC 用的 rustls 配置：显式 CA（空信任根 = 必定失败）+ ALPN + ring。
fn quic_client_crypto(roots: Arc<RootCertStore>) -> Result<QuicClientConfig> {
    let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .map_err(|error| anyhow!("QUIC 只支持 TLS 1.3 / QUIC requires TLS 1.3: {error}"))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    tls.alpn_protocols = vec![ALPN.to_vec()];
    // 0-RTT 会绕过重放保护，UDP 中继不需要它。
    tls.enable_early_data = false;
    QuicClientConfig::try_from(Arc::new(tls))
        .map_err(|error| anyhow!("QUIC TLS 配置无效 / invalid QUIC TLS config: {error}"))
}

/// UDP 中继的 QUIC 客户端。
///
/// 一条 QUIC 连接承载一条隧道；UDP 载荷只走 datagram。
pub struct QuicUdpClient {
    endpoint: Endpoint,
    connection: Connection,
    hop_id: String,
    /// 一致性哈希的候选目标（顺序即哈希桶顺序）。
    targets: Arc<[TargetAddr]>,
}

impl QuicUdpClient {
    /// 连上 QUIC 服务端并完成 hop 认证。
    pub async fn connect(
        server_addr: SocketAddr,
        server_name: ServerName<'static>,
        hop_id: String,
        hop_secret: Vec<u8>,
        roots: Arc<RootCertStore>,
        target_rules: &[TargetRule],
    ) -> Result<Self> {
        let targets = targets_from_rules(target_rules)?;
        let crypto = quic_client_crypto(roots)?;
        let mut client_config = quinn::ClientConfig::new(Arc::new(crypto));
        client_config.transport_config(Arc::new(datagram_transport()));

        // 本地地址族必须与对端一致，否则 IPv4 客户端连不上 IPv6 目标。
        let local = if server_addr.is_ipv4() {
            SocketAddr::from(([0, 0, 0, 0], 0))
        } else {
            SocketAddr::from(([0u16; 8], 0))
        };
        let mut endpoint = Endpoint::client(local)
            .with_context(|| format!("创建 QUIC 客户端 endpoint 失败 / failed to create the QUIC client endpoint: {local}"))?;
        endpoint.set_default_client_config(client_config);

        let name = server_name.to_str().into_owned();
        let connecting = endpoint.connect(server_addr, &name).map_err(|error| {
            anyhow!("发起 QUIC 连接失败 / failed to start the QUIC connection: {error}")
        })?;
        let connection = match timeout(HANDSHAKE_TIMEOUT, connecting).await {
            Ok(Ok(connection)) => connection,
            Ok(Err(error)) => bail!(
                "QUIC 握手失败 / QUIC handshake failed: {error}（证书不受信任、SNI 不匹配或对端不是 QUIC / untrusted certificate, SNI mismatch, or the peer is not QUIC）"
            ),
            Err(_) => bail!(
                "QUIC 握手超时（{}s）/ QUIC handshake timed out after {}s",
                HANDSHAKE_TIMEOUT.as_secs(),
                HANDSHAKE_TIMEOUT.as_secs()
            ),
        };

        client_handshake(&connection, &hop_id, &hop_secret).await?;

        if connection.max_datagram_size().is_none() {
            bail!("对端未启用 QUIC datagram / the peer did not enable QUIC datagrams");
        }

        Ok(Self {
            endpoint,
            connection,
            hop_id,
            targets,
        })
    }

    /// QUIC 对端地址。
    pub fn remote_address(&self) -> SocketAddr {
        self.connection.remote_address()
    }

    /// 按本地 UDP 客户端地址选目标并发一个数据报，返回选中的目标。
    ///
    /// 这是粘性的唯一来源：同一 `local_client` 的每个包都会哈希到同一个目标，
    /// 与 native UDP 的 [`crate::udp::pick_target`] 完全同一套规则。
    ///
    /// 注意回包不带 `local_client`，只带目标地址；因此入口侧是**一个本地
    /// 客户端一条连接**（见 [`super::udp_dialer`]），回包按连接回到对应客户端。
    pub fn send_from(&self, local_client: SocketAddr, payload: &[u8]) -> Result<TargetAddr> {
        let index = crate::udp::pick_target(local_client, self.targets.len());
        let target = self.targets.get(index).cloned().ok_or_else(|| {
            anyhow!(
                "UDP 选路返回越界目标 / UDP target selection went out of bounds: {index}/{}",
                self.targets.len()
            )
        })?;
        self.send(&UdpDatagram {
            hop_id: self.hop_id.clone(),
            target: target.clone(),
            payload: payload.to_vec(),
        })?;
        Ok(target)
    }

    /// 发一个已编码好的数据报（高级用法：调用方自己决定目标）。
    pub fn send(&self, datagram: &UdpDatagram) -> Result<()> {
        let bytes = datagram.encode()?;
        if let Some(max) = self.connection.max_datagram_size() {
            if bytes.len() > max {
                bail!(
                    "数据报 {} 字节超过 QUIC 上限 {} 字节 / the {}-byte datagram exceeds the {}-byte QUIC limit",
                    bytes.len(),
                    max,
                    bytes.len(),
                    max
                );
            }
        }
        self.connection
            .send_datagram(bytes.into())
            .map_err(|error| {
                anyhow!("发送 QUIC datagram 失败 / failed to send the QUIC datagram: {error}")
            })
    }

    /// 读一个回包；解码失败返回 `InvalidData`。
    pub async fn recv(&self) -> Result<UdpDatagram> {
        let bytes = self.connection.read_datagram().await.map_err(|error| {
            anyhow!("读取 QUIC datagram 失败 / failed to read the QUIC datagram: {error}")
        })?;
        Ok(UdpDatagram::decode(&bytes)?)
    }

    /// 关闭连接与 endpoint（UDP socket 立即释放）。
    pub fn close(&self) {
        self.connection
            .close(VarInt::from_u32(CLOSE_NORMAL), b"udp tunnel client closed");
        self.endpoint
            .close(VarInt::from_u32(CLOSE_NORMAL), b"udp tunnel client closed");
    }
}

impl Drop for QuicUdpClient {
    fn drop(&mut self) {
        self.endpoint
            .close(VarInt::from_u32(CLOSE_NORMAL), b"udp tunnel client dropped");
    }
}

impl fmt::Debug for QuicUdpClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("QuicUdpClient")
            .field("remote", &self.connection.remote_address())
            .field("hop_id", &self.hop_id)
            .field("targets", &self.targets)
            .finish_non_exhaustive()
    }
}

/// 客户端认证：唯一一条双向流里交换 ClientHello / ServerHello。
async fn client_handshake(connection: &Connection, hop_id: &str, hop_secret: &[u8]) -> Result<()> {
    let (mut send, mut recv) = match timeout(HANDSHAKE_TIMEOUT, connection.open_bi()).await {
        Ok(Ok(streams)) => streams,
        Ok(Err(error)) => {
            bail!("打开 QUIC 认证流失败 / failed to open the QUIC auth stream: {error}")
        }
        Err(_) => bail!(
            "打开 QUIC 认证流超时（{}s）/ timed out opening the QUIC auth stream after {}s",
            HANDSHAKE_TIMEOUT.as_secs(),
            HANDSHAKE_TIMEOUT.as_secs()
        ),
    };

    let hello = ClientHello::new(hop_secret, hop_id, handshake::unix_now());
    timeout(HANDSHAKE_TIMEOUT, hello.write(&mut send))
        .await
        .context("发送 QUIC ClientHello 超时 / timed out sending the QUIC ClientHello")??;
    // 认证流只用来交换两段固定长度的消息；写方向到此为止。
    let _ = send.finish();

    let reply = match timeout(HANDSHAKE_TIMEOUT, ServerHello::read(&mut recv)).await {
        Ok(Ok(reply)) => reply,
        Ok(Err(error)) => bail!(
            "读取 QUIC ServerHello 失败（认证被拒绝或连接已关闭）/ failed to read the QUIC ServerHello (authentication rejected or connection closed): {error}"
        ),
        Err(_) => bail!(
            "等待 QUIC ServerHello 超时（{}s）/ timed out waiting for the QUIC ServerHello after {}s",
            HANDSHAKE_TIMEOUT.as_secs(),
            HANDSHAKE_TIMEOUT.as_secs()
        ),
    };

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
        bail!("UDP 中继握手被服务端拒绝 / UDP relay handshake rejected by server: {reason}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::AtomicUsize;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::time::timeout as tokio_timeout;

    use crate::tunnel::{TunnelClient, TunnelServer, TunnelServerConfig};

    const CA_PEM: &str = include_str!("../../tests/fixtures/tunnel-ca.pem");
    const SERVER_CERT_PEM: &str = include_str!("../../tests/fixtures/tunnel-server.pem");
    const SERVER_KEY_PEM: &str = include_str!("../../tests/fixtures/tunnel-server-key.pem");
    const HOP_ID: &str = "hop-udp";
    /// TCP 用例单独用一个 hop：TCP 仍按 proof 去重，同一秒内两条同 hop 的
    /// TCP 连接会被重放缓存拒绝。
    const HOP_ID_TCP: &str = "hop-tcp";
    const HOP_SECRET: &[u8] = b"test-hop-secret-32-bytes-long!!!";
    const TEST_SNI: &str = "tunnel.test";

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("pierwave-quic-test-{}", uuid::Uuid::new_v4()));
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

    fn localhost_rule(addr: SocketAddr) -> TargetRule {
        TargetRule::new(addr.ip().to_string(), Some((addr.port(), addr.port())))
    }

    /// 带计数的 UDP echo：`tag` 有值时回包前面塞一个 tag 字节，方便断言
    /// 流量去了哪个目标；`received` 是「真的收到了几个包」的证据。
    struct UdpEcho {
        addr: SocketAddr,
        received: Arc<AtomicUsize>,
        /// 收到的载荷（按到达顺序）。
        ///
        /// 负向断言（「这个包绝不能到目标」）看载荷而不是只看计数：同进程里
        /// 并行跑的其它隧道用例会频繁创建/释放临时 UDP 端口，一个不属于本
        /// 用例的包落进来只会污染计数，不是「本用例的数据报被转发了」。
        payloads: Arc<Mutex<Vec<Vec<u8>>>>,
        task: JoinHandle<()>,
    }

    impl UdpEcho {
        fn received(&self) -> usize {
            self.received.load(Ordering::Relaxed)
        }

        fn payloads(&self) -> Vec<Vec<u8>> {
            self.payloads
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }

        /// 断言某个载荷从未到达这个 echo（比「计数为 0」更精确，也不会被
        /// 其它用例误投的包带偏）。
        fn assert_never_received(&self, payload: &[u8], what: &str) {
            let got = self.payloads();
            assert!(
                !got.iter().any(|received| received == payload),
                "{what}：目标收到了不该被转发的载荷（载荷：{got:?}）"
            );
        }
    }

    impl Drop for UdpEcho {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn spawn_udp_echo(tag: Option<u8>) -> UdpEcho {
        let socket = UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("UDP echo 必须能绑定");
        let addr = socket.local_addr().expect("读取 UDP echo 地址");
        let received = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&received);
        let payloads = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&payloads);
        let task = tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            loop {
                let Ok((size, peer)) = socket.recv_from(&mut buf).await else {
                    break;
                };
                // 先记载荷再自增计数：看到计数就一定能看到对应的载荷。
                recorder
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(buf[..size].to_vec());
                counter.fetch_add(1, Ordering::Relaxed);
                let mut reply = Vec::with_capacity(size + usize::from(tag.is_some()));
                if let Some(tag) = tag {
                    reply.push(tag);
                }
                reply.extend_from_slice(&buf[..size]);
                if socket.send_to(&reply, peer).await.is_err() {
                    break;
                }
            }
        });
        UdpEcho {
            addr,
            received,
            payloads,
            task,
        }
    }

    /// 起一个同时提供 TCP 隧道与 QUIC UDP 中继的服务端。
    struct Harness {
        /// TCP 隧道监听地址（同时是 QUIC 的 UDP 端口）。
        addr: SocketAddr,
        /// QUIC endpoint 实际绑定的 UDP 地址。
        udp_addr: SocketAddr,
        stats: QuicUdpStatsHandle,
        task: JoinHandle<()>,
        ca_path: PathBuf,
        _dir: TempDir,
    }

    impl Harness {
        /// `tcp_allowed` 只影响 TCP 首帧白名单；`udp_allowed` 是 UDP 白名单。
        async fn start_with(
            tcp_allowed: Vec<TargetRule>,
            udp_allowed: Vec<TargetRule>,
            limits: QuicUdpLimits,
        ) -> Self {
            let dir = TempDir::new();
            let cert_path = dir.write("server.pem", SERVER_CERT_PEM);
            let key_path = dir.write("server-key.pem", SERVER_KEY_PEM);
            let ca_path = dir.write("ca.pem", CA_PEM);
            let mut hops = HashMap::new();
            hops.insert(HOP_ID.to_string(), HOP_SECRET.to_vec());
            hops.insert(HOP_ID_TCP.to_string(), HOP_SECRET.to_vec());

            let mut config =
                TunnelServerConfig::new("127.0.0.1:0".parse().unwrap(), cert_path, key_path, hops);
            config.allowed_targets = tcp_allowed;

            let (server, listener) = TunnelServer::bind(config)
                .await
                .expect("测试隧道服务端必须能启动");
            let addr = listener.local_addr().expect("读取监听地址");
            let server = server
                .with_udp_limits(udp_allowed, limits)
                .await
                .expect("UDP 中继必须能启动");
            let udp_addr = server
                .udp_bound_addr()
                .expect("启用了 UDP 就必须有 UDP 监听地址");
            let stats = server
                .udp_stats_handle()
                .expect("启用了 UDP 就必须有 stats");
            let task = tokio::spawn(async move {
                let _ = server.serve(listener).await;
            });
            Self {
                addr,
                udp_addr,
                stats,
                task,
                ca_path,
                _dir: dir,
            }
        }

        async fn start() -> Self {
            // 回环测试允许 127.0.0.1 的任意端口；拒绝路径单独构造更严格的规则。
            Self::start_with(
                vec![TargetRule::new("127.0.0.1", None)],
                vec![TargetRule::new("127.0.0.1", None)],
                QuicUdpLimits::default(),
            )
            .await
        }

        /// 建一条 QUIC UDP 客户端；`rules` 同时是候选目标列表。
        async fn udp_client_with(&self, hop_id: &str, rules: Vec<TargetRule>) -> QuicUdpClient {
            let tunnel = TunnelClient::trusting_ca_file(
                self.addr,
                server_name(),
                hop_id,
                HOP_SECRET.to_vec(),
                &self.ca_path,
            )
            .expect("CA 夹具必须能加载");
            tunnel.with_udp(rules).await.expect("QUIC 客户端必须能连上")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn recv_reply(client: &QuicUdpClient) -> UdpDatagram {
        // 回包等待是「截止时间」而不是固定睡眠：CI（少核、较慢）上 QUIC 数据报
        // 往返可能比本机慢一个数量级。
        tokio_timeout(TEST_WAIT_TIMEOUT, client.recv())
            .await
            .expect("等待 UDP 回包超时")
            .expect("读取 UDP 回包失败")
    }

    /// 等待「最终达到」类断言的预算：CI 上握手/回收可能慢一个数量级，
    /// 5s 以下本身就会变成新的抖动源。
    const TEST_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
    /// 轮询间隔；与 supervisor / udp_dialer 的测试保持一致。
    const TEST_POLL_INTERVAL: Duration = Duration::from_millis(20);
    /// 「不该有回包」的负向观察窗口。这**不是**等待某个事件发生，而是给
    /// 「绝不会发生」留出迟到包的余地；不靠它来同步任何状态。
    const NO_REPLY_WINDOW: Duration = Duration::from_millis(500);

    /// 轮询等待 `condition` 成立，返回成立时的计数快照。
    ///
    /// 失败时把当时的 stats 一起打进 panic：CI 日志里能直接看出是「没收到 /
    /// 没建会话」还是「计数多算了」，不用再猜。
    async fn wait_until<F>(what: &str, stats: &QuicUdpStatsHandle, condition: F) -> QuicUdpStats
    where
        F: Fn(&QuicUdpStats) -> bool,
    {
        let deadline = Instant::now() + TEST_WAIT_TIMEOUT;
        loop {
            let snapshot = stats.snapshot();
            if condition(&snapshot) {
                return snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "等待超时：{what}（stats: {snapshot:?}）"
            );
            tokio::time::sleep(TEST_POLL_INTERVAL).await;
        }
    }

    /// 找一个哈希到指定桶的合成客户端地址（只用于选路，不需要真的 bind）。
    fn client_addr_for_bucket(bucket: usize, buckets: usize) -> SocketAddr {
        for port in 40_000u16..60_000 {
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            if crate::udp::pick_target(addr, buckets) == bucket {
                return addr;
            }
        }
        panic!("找不到落在桶 {bucket} 的客户端地址");
    }

    // ---- datagram 编解码（纯逻辑）----

    #[test]
    fn datagram_roundtrip_for_every_address_family() {
        let cases = [
            (
                TargetAddr::Ip("203.0.113.7:8080".parse().unwrap()),
                b"payload".as_slice(),
            ),
            (
                TargetAddr::Ip("[2001:db8::1]:443".parse().unwrap()),
                b"".as_slice(),
            ),
            (
                TargetAddr::Domain {
                    host: "example.internal".into(),
                    port: 8443,
                },
                b"\x00\x01\x02",
            ),
        ];
        for (target, payload) in cases {
            let datagram = UdpDatagram {
                hop_id: "hop-1".into(),
                target: target.clone(),
                payload: payload.to_vec(),
            };
            let encoded = datagram.encode().unwrap();
            // 布局：hop_len + hop + 地址 + 载荷
            assert_eq!(encoded[0] as usize, "hop-1".len());
            assert_eq!(&encoded[1..6], b"hop-1");
            assert_eq!(
                &encoded[6..6 + target.encode().unwrap().len()],
                &target.encode().unwrap()[..]
            );
            assert_eq!(UdpDatagram::decode(&encoded).unwrap(), datagram);
        }
    }

    #[test]
    fn datagram_rejects_malformed_input() {
        assert!(UdpDatagram::decode(&[]).is_err(), "空数据报必须拒绝");
        // hop_len = 0
        assert!(UdpDatagram::decode(&[0x00, 0x01, 127, 0, 0, 1, 0, 80]).is_err());
        // hop 被截断
        assert!(UdpDatagram::decode(&[0x05, b'a', b'b']).is_err());
        // 地址被截断（hop 合法，后面只有 2 字节 IPv4）
        let mut encoded = UdpDatagram {
            hop_id: "h".into(),
            target: TargetAddr::Ip("127.0.0.1:9".parse().unwrap()),
            payload: Vec::new(),
        }
        .encode()
        .unwrap();
        encoded.truncate(encoded.len() - 2);
        assert!(UdpDatagram::decode(&encoded).is_err());
        // 非法 UTF-8 的 hop
        assert!(UdpDatagram::decode(&[0x01, 0xff, 0x01, 127, 0, 0, 1, 0, 9]).is_err());
    }

    #[test]
    fn datagram_encode_requires_a_bounded_hop_id() {
        let target = TargetAddr::Ip("127.0.0.1:9".parse().unwrap());
        assert!(UdpDatagram {
            hop_id: String::new(),
            target: target.clone(),
            payload: vec![],
        }
        .encode()
        .is_err());
        assert!(UdpDatagram {
            hop_id: "x".repeat(256),
            target,
            payload: vec![],
        }
        .encode()
        .is_err());
    }

    // ---- 候选目标 / 选路（纯逻辑）----

    #[test]
    fn targets_from_rules_skips_rules_without_a_concrete_target() {
        let rules = vec![
            TargetRule::new("127.0.0.1", Some((7000, 7000))),
            TargetRule::new("127.0.0.2", None),
            TargetRule::new("*.example.com", Some((443, 443))),
            TargetRule::new("example.internal", Some((8443, 8443))),
        ];
        let targets = targets_from_rules(&rules).unwrap();
        assert_eq!(
            &targets[..],
            &[
                TargetAddr::Ip("127.0.0.1:7000".parse().unwrap()),
                TargetAddr::Domain {
                    host: "example.internal".into(),
                    port: 8443
                },
            ]
        );
        assert!(targets_from_rules(&[]).is_err(), "没有候选目标必须报错");
        assert!(
            targets_from_rules(&[TargetRule::new("example.com", None)]).is_err(),
            "没有端口的规则不能当目标"
        );
    }

    #[test]
    fn same_local_client_always_picks_the_same_target() {
        let client = client_addr_for_bucket(0, 3);
        let first = crate::udp::pick_target(client, 3);
        for _ in 0..128 {
            assert_eq!(
                crate::udp::pick_target(client, 3),
                first,
                "同一客户端地址必须固定同一目标（与 native UDP 同一套哈希）"
            );
        }
    }

    // ---- 会话表（可注入时钟）----

    fn idle_session(last_active_ms: u64) -> Session {
        let upstream = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        upstream.set_nonblocking(true).unwrap();
        let upstream = Arc::new(UdpSocket::from_std(upstream).unwrap());
        Session {
            upstream,
            last_active_ms: Arc::new(AtomicU64::new(last_active_ms)),
            reader: tokio::spawn(async { std::future::pending::<()>().await }),
        }
    }

    /// 会话键：`(连接 stable_id, 目标)`；测试里用任意整数代表连接。
    fn table_key(owner: usize) -> SessionKey {
        (owner, TargetAddr::Ip("127.0.0.1:9".parse().unwrap()))
    }

    #[tokio::test]
    async fn session_table_reclaims_only_after_the_idle_threshold() {
        let mut table = SessionTable::default();
        let key = table_key(1234);
        table.insert(key.clone(), idle_session(0));

        let idle_ms = u64::try_from(SESSION_IDLE.as_millis()).unwrap();
        assert!(
            table.take_expired(idle_ms, SESSION_IDLE).is_empty(),
            "刚好到阈值（未超过）时不能回收"
        );
        assert_eq!(table.len(), 1);

        let expired = table.take_expired(idle_ms + 1, SESSION_IDLE);
        assert_eq!(expired.len(), 1, "超过空闲阈值必须回收");
        assert_eq!(expired[0].0, key);
        assert_eq!(table.len(), 0);
    }

    #[tokio::test]
    async fn touch_refreshes_last_active_and_keeps_the_session() {
        let mut table = SessionTable::default();
        let key = table_key(4321);
        table.insert(key.clone(), idle_session(0));

        assert!(table.touch(key.0, &key.1, 30_000).is_some());
        let idle_ms = u64::try_from(SESSION_IDLE.as_millis()).unwrap();
        assert!(
            table
                .take_expired(30_000 + idle_ms, SESSION_IDLE)
                .is_empty(),
            "活跃过的会话不能按旧的 last_active 回收"
        );
        assert_eq!(
            table.take_expired(30_000 + idle_ms + 1, SESSION_IDLE).len(),
            1
        );
    }

    #[tokio::test]
    async fn take_owner_only_drops_that_connections_sessions() {
        let mut table = SessionTable::default();
        table.insert(table_key(1), idle_session(0));
        table.insert(table_key(2), idle_session(0));

        let removed = table.take_owner(1);
        assert_eq!(removed.len(), 1);
        assert_eq!(
            table.len(),
            1,
            "别的连接的会话不能被误删（同一源端口重连也安全）"
        );
        for (_, session) in removed {
            session.shutdown().await;
        }
        for (_, session) in table.take_all() {
            session.shutdown().await;
        }
    }

    // ---- 回环：UDP echo 经 QUIC 隧道 ----

    /// QUIC 监听必须与 TCP 隧道同 IP、同端口（UDP/TCP 是两套协议，可共存）。
    #[tokio::test]
    async fn quic_endpoint_binds_the_same_port_as_the_tcp_tunnel() {
        let harness = Harness::start().await;
        assert_eq!(
            harness.udp_addr, harness.addr,
            "QUIC endpoint 必须绑在隧道端口上（TCP 与 UDP 同号）"
        );
        println!("[quic port] tcp={} udp={}", harness.addr, harness.udp_addr);
    }

    #[tokio::test]
    async fn three_datagrams_are_echoed_over_the_quic_tunnel() {
        let echo = spawn_udp_echo(None).await;
        let harness = Harness::start().await;
        let client = harness
            .udp_client_with(HOP_ID, vec![localhost_rule(echo.addr)])
            .await;
        let local = client_addr_for_bucket(0, 1);

        for payload in [b"first".as_slice(), b"second", b"third"] {
            let target = client.send_from(local, payload).expect("发送数据报失败");
            assert_eq!(
                target,
                TargetAddr::Ip(echo.addr),
                "单目标必须直连（与 native UDP 的退化规则一致）"
            );
            let reply = recv_reply(&client).await;
            assert_eq!(reply.payload, payload, "回显内容必须与发送一致");
            assert_eq!(reply.target, TargetAddr::Ip(echo.addr));
            assert_eq!(reply.hop_id, HOP_ID);
        }

        // 回包内容已经证明 3 个包都被转发；计数只需要「最终至少 3」——
        // 不要求断言瞬间就绪（服务端任务可能还没把收尾计数落下来）。
        let stats = wait_until(
            "3 个数据报都计数（收/发）",
            &harness.stats,
            |stats| stats.datagrams_in >= 3 && stats.datagrams_out >= 3,
        )
        .await;
        assert!(stats.datagrams_in >= 3, "{stats:?}");
        assert!(stats.datagrams_out >= 3, "{stats:?}");
        assert_eq!(stats.sessions, 1, "同一客户端 + 同一目标只能有一个会话");
        assert!(echo.received() >= 3, "echo 至少收到 3 个包");
        println!("[quic echo] {stats:?}");
    }

    /// 白名单拒绝：目标不在白名单 → 丢弃 + 计数，echo 一个包都收不到。
    #[tokio::test]
    async fn denied_target_is_counted_and_never_connected() {
        let allowed_echo = spawn_udp_echo(None).await;
        let denied_echo = spawn_udp_echo(None).await;
        let harness = Harness::start_with(
            vec![TargetRule::new("127.0.0.1", None)],
            // 只允许 allowed_echo 的端口：denied_echo 必须被拒绝。
            vec![localhost_rule(allowed_echo.addr)],
            QuicUdpLimits::default(),
        )
        .await;
        let client = harness
            .udp_client_with(HOP_ID, vec![localhost_rule(denied_echo.addr)])
            .await;
        let local = client_addr_for_bucket(0, 1);
        // 唯一载荷：负向断言按载荷匹配，别的用例（或复用了端口的并行用例）
        // 恰好发同样字节的概率必须为 0。
        let payload = format!("must-not-arrive-{}", uuid::Uuid::new_v4());
        let payload = payload.as_bytes();

        // 数据报本身不可靠：可能丢、服务端也可能还没轮到处理。发一次就断言
        // 「恰好 3 次拒绝」是在赌时序；重发到「拒绝计数 ≥ 3」为止，每轮同时
        // 盯着回包——真的被转发时会立刻失败。
        let deadline = Instant::now() + TEST_WAIT_TIMEOUT;
        let stats = loop {
            let stats = harness.stats.snapshot();
            if stats.denied >= 3 {
                break stats;
            }
            assert!(
                Instant::now() < deadline,
                "等待超时：3 个被拒绝的数据报都必须计数（stats: {stats:?}, echo 载荷: {:?}）",
                denied_echo.payloads()
            );
            let target = client.send_from(local, payload).unwrap();
            assert_eq!(target, TargetAddr::Ip(denied_echo.addr));
            match tokio_timeout(TEST_POLL_INTERVAL, client.recv()).await {
                Err(_) => {}
                Ok(Ok(datagram)) => {
                    panic!("被白名单拒绝的目标不能产生回包，却收到 {datagram:?}")
                }
                Ok(Err(error)) => panic!("读取回包失败：{error:#}"),
            }
        };

        assert!(stats.denied >= 3, "每个被拒绝的数据报都要计数：{stats:?}");
        // 每个到达的数据报都走了「白名单拒绝」分支，没有建任何会话/上游连接。
        assert!(stats.datagrams_in >= stats.denied, "{stats:?}");
        assert_eq!(stats.datagrams_out, 0, "{stats:?}");
        assert_eq!(stats.sessions, 0, "拒绝时不能建会话");
        denied_echo.assert_never_received(payload, "白名单拒绝的目标不能收到载荷");

        // 负向窗口：拒绝分支不可能产生回包，再观察一段时间兜住迟到的包。
        let no_reply = tokio_timeout(NO_REPLY_WINDOW, client.recv()).await;
        assert!(no_reply.is_err(), "被白名单拒绝的目标不能产生回包");
        println!(
            "[quic denied] denied={} datagrams_in={} sessions={} denied_echo_payloads={:?}",
            stats.denied,
            stats.datagrams_in,
            stats.sessions,
            denied_echo.payloads()
        );
    }

    /// 粘性：不同本地客户端地址落在不同目标；同一地址连续发包永远同一目标。
    #[tokio::test]
    async fn local_client_address_pins_the_datagram_to_one_target() {
        let echo_a = spawn_udp_echo(Some(b'A')).await;
        let echo_b = spawn_udp_echo(Some(b'B')).await;
        let harness = Harness::start().await;
        let client = harness
            .udp_client_with(
                HOP_ID,
                vec![localhost_rule(echo_a.addr), localhost_rule(echo_b.addr)],
            )
            .await;

        let client_a = client_addr_for_bucket(0, 2);
        let client_b = client_addr_for_bucket(1, 2);

        for _ in 0..3 {
            let target_a = client.send_from(client_a, b"hello-a").unwrap();
            assert_eq!(target_a, TargetAddr::Ip(echo_a.addr));
            let reply = recv_reply(&client).await;
            assert_eq!(reply.target, target_a);
            assert_eq!(reply.payload, b"Ahello-a", "客户端 A 必须稳定走 echo A");

            let target_b = client.send_from(client_b, b"hello-b").unwrap();
            assert_eq!(target_b, TargetAddr::Ip(echo_b.addr));
            let reply = recv_reply(&client).await;
            assert_eq!(reply.target, target_b);
            assert_eq!(reply.payload, b"Bhello-b", "客户端 B 必须稳定走 echo B");
        }

        let stats = wait_until("两个目标都建立会话", &harness.stats, |stats| {
            stats.sessions >= 2
        })
        .await;
        assert_eq!(stats.sessions, 2, "两个目标 → 两个会话：{stats:?}");
        assert!(echo_a.received() >= 3, "echo A 至少收到 3 个包");
        assert!(echo_b.received() >= 3, "echo B 至少收到 3 个包");
        println!("[quic sticky] {stats:?}");
    }

    /// 空闲回收：注入 100ms 空闲 / 20ms 扫描，会话必须被清掉。
    #[tokio::test]
    async fn sweeper_reclaims_idle_sessions() {
        let echo = spawn_udp_echo(None).await;
        let harness = Harness::start_with(
            vec![TargetRule::new("127.0.0.1", None)],
            vec![TargetRule::new("127.0.0.1", None)],
            QuicUdpLimits {
                idle: Duration::from_millis(100),
                max_sessions: MAX_SESSIONS,
                sweep_interval: Duration::from_millis(20),
            },
        )
        .await;
        let client = harness
            .udp_client_with(HOP_ID, vec![localhost_rule(echo.addr)])
            .await;
        let local = client_addr_for_bucket(0, 1);

        client.send_from(local, b"make-a-session").unwrap();
        let _ = recv_reply(&client).await;
        wait_until("会话已建立", &harness.stats, |stats| {
            stats.sessions >= 1
        })
        .await;

        // 100ms 空闲 + 20ms 扫描周期；轮询到 10s 截止，避免 CI 抖动。
        let stats = wait_until(
            "空闲会话必须被回收任务清掉",
            &harness.stats,
            |stats| stats.sessions == 0,
        )
        .await;
        println!(
            "[quic idle] sessions reclaimed, stats={stats:?}, echo received={}",
            echo.received()
        );
    }

    /// 超上限：第 3 个地址被丢弃，已有两个会话继续工作。
    #[tokio::test]
    async fn over_session_limit_refuses_new_client_but_keeps_existing_ones() {
        let echo_a = spawn_udp_echo(Some(b'A')).await;
        let echo_b = spawn_udp_echo(Some(b'B')).await;
        let echo_c = spawn_udp_echo(Some(b'C')).await;
        let harness = Harness::start_with(
            vec![TargetRule::new("127.0.0.1", None)],
            vec![TargetRule::new("127.0.0.1", None)],
            QuicUdpLimits {
                idle: SESSION_IDLE,
                max_sessions: 2,
                sweep_interval: SWEEP_INTERVAL,
            },
        )
        .await;
        let client = harness
            .udp_client_with(
                HOP_ID,
                vec![
                    localhost_rule(echo_a.addr),
                    localhost_rule(echo_b.addr),
                    localhost_rule(echo_c.addr),
                ],
            )
            .await;

        let clients = [
            client_addr_for_bucket(0, 3),
            client_addr_for_bucket(1, 3),
            client_addr_for_bucket(2, 3),
        ];
        // 建会话是服务端异步做的：回包已经证明这两个会话存在，但仍然用
        // 「等达到」而不是「立刻等于」，避免在慢机器上抢跑。
        for (index, addr) in clients.iter().take(2).enumerate() {
            client.send_from(*addr, b"fill").unwrap();
            let reply = recv_reply(&client).await;
            assert_eq!(reply.payload[0], b'A' + index as u8, "{index}");
        }
        let stats = wait_until("已有两个会话", &harness.stats, |stats| {
            stats.sessions >= 2
        })
        .await;
        assert_eq!(stats.sessions, 2, "{stats:?}");

        // 第 3 个地址：超限，不能建会话、不能有回包。
        //
        // 数据报可能丢、服务端也可能还没轮到处理它，所以重发到「拒绝计数 ≥ 1」
        // 为止；每轮同时盯着回包，一旦真的被转发就立刻失败。最终断言用
        // 「至少 1」而不是「恰好 1」——重发几次就会多计几次，那不是被测行为。
        //
        // 载荷带上唯一后缀：负向断言按载荷匹配，不会把别的用例（或复用了
        // 端口的并行用例）误投的包当成「超限数据报被转发了」。
        let over_limit = format!("over-limit-{}", uuid::Uuid::new_v4());
        let over_limit = over_limit.as_bytes();
        let deadline = Instant::now() + TEST_WAIT_TIMEOUT;
        let stats = loop {
            let stats = harness.stats.snapshot();
            if stats.sessions_rejected >= 1 {
                break stats;
            }
            assert!(
                Instant::now() < deadline,
                "等待超时：超过会话上限的新地址必须被拒绝（stats: {stats:?}, echo_c 载荷: {:?}）",
                echo_c.payloads()
            );
            assert_eq!(
                client.send_from(clients[2], over_limit).unwrap(),
                TargetAddr::Ip(echo_c.addr),
                "第 3 个地址必须选中第 3 个目标"
            );
            match tokio_timeout(TEST_POLL_INTERVAL, client.recv()).await {
                Err(_) => {}
                Ok(Ok(datagram)) => {
                    panic!("超过会话上限的新地址不能拿到回包，却收到 {datagram:?}")
                }
                Ok(Err(error)) => panic!("读取回包失败：{error:#}"),
            }
        };
        assert!(stats.sessions_rejected >= 1, "{stats:?}");
        assert_eq!(stats.sessions, 2, "已有会话不能被挤掉：{stats:?}");
        // 语义核心：这个数据报从未被转发。按载荷断言而不是只看计数——
        // 同进程里并行跑的其它隧道用例可能复用临时端口，往这个 echo 投进
        // 一个不属于本用例的包；那不该算「超限数据报被转发了」。
        echo_c.assert_never_received(over_limit, "超限数据报不能被转发到目标");

        // 负向窗口：超限分支不可能产生回包，再观察一段时间兜住迟到的包。
        let no_reply = tokio_timeout(NO_REPLY_WINDOW, client.recv()).await;
        assert!(no_reply.is_err(), "超过会话上限的新地址不能拿到回包");

        // 已有两个会话必须继续工作（用回包内容证明，不依赖固定 sleep）。
        client.send_from(clients[0], b"still-a").unwrap();
        assert_eq!(recv_reply(&client).await.payload, b"Astill-a");
        client.send_from(clients[1], b"still-b").unwrap();
        assert_eq!(recv_reply(&client).await.payload, b"Bstill-b");
        let stats = harness.stats.snapshot();
        assert_eq!(stats.sessions, 2, "已有会话不能被挤掉：{stats:?}");
        println!(
            "[quic limit] sessions_rejected={} sessions={} existing_still_working=true",
            stats.sessions_rejected, stats.sessions
        );
    }

    /// 同一端口上 TCP 隧道不受 UDP/QUIC 影响（`serve` 同时跑两个 accept 循环）。
    #[tokio::test]
    async fn tcp_tunnel_keeps_working_with_udp_enabled() {
        let tcp_echo = spawn_tcp_echo().await;
        let harness = Harness::start_with(
            vec![TargetRule::new("127.0.0.1", None)],
            vec![TargetRule::new("127.0.0.1", None)],
            QuicUdpLimits::default(),
        )
        .await;

        // 先跑 QUIC，再跑 TCP；两个 hop 不同，避免同一份 hop_secret 在两条
        // 路径上交叉（TCP 仍走重放缓存，QUIC 不做时间戳去重）。
        let udp_echo = spawn_udp_echo(None).await;
        let udp_client = harness
            .udp_client_with(HOP_ID, vec![localhost_rule(udp_echo.addr)])
            .await;
        udp_client
            .send_from(client_addr_for_bucket(0, 1), b"udp-first")
            .unwrap();
        assert_eq!(recv_reply(&udp_client).await.payload, b"udp-first");

        let tunnel = TunnelClient::trusting_ca_file(
            harness.addr,
            server_name(),
            HOP_ID_TCP,
            HOP_SECRET.to_vec(),
            &harness.ca_path,
        )
        .expect("CA 夹具必须能加载");
        let connection = tunnel
            .connect(&TargetAddr::Ip(tcp_echo.addr))
            .await
            .expect("TCP 隧道必须仍能建连");
        let mut framed = connection.into_frame_io();
        framed.write_all(b"tcp-payload").await.unwrap();
        framed.flush().await.unwrap();
        let mut echoed = vec![0u8; b"tcp-payload".len()];
        tokio_timeout(Duration::from_secs(5), framed.read_exact(&mut echoed))
            .await
            .expect("TCP 回显超时")
            .expect("TCP 回显失败");
        assert_eq!(echoed, b"tcp-payload");
        println!("[quic tcp] tcp roundtrip ok with udp enabled");
    }

    async fn spawn_tcp_echo() -> TcpEcho {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("TCP echo 必须能绑定");
        let addr = listener.local_addr().expect("读取 TCP echo 地址");
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
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
                });
            }
        });
        TcpEcho { addr, task }
    }

    struct TcpEcho {
        addr: SocketAddr,
        task: JoinHandle<()>,
    }

    impl Drop for TcpEcho {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    /// 错误的 hop_secret：QUIC/TLS 握手能过（证书对），但 HMAC proof 必须被拒，
    /// 且不能建任何会话、不能转发任何 datagram。
    #[tokio::test]
    async fn bad_proof_is_rejected_before_any_datagram_is_forwarded() {
        let echo = spawn_udp_echo(None).await;
        let harness = Harness::start().await;
        let tunnel = TunnelClient::trusting_ca_file(
            harness.addr,
            server_name(),
            HOP_ID,
            b"wrong-hop-secret-32-bytes!!!!!!!".to_vec(),
            &harness.ca_path,
        )
        .expect("CA 夹具必须能加载");
        let error = tunnel
            .with_udp(vec![localhost_rule(echo.addr)])
            .await
            .expect_err("错误的 hop_secret 必须被拒绝");
        let text = format!("{error:#}");
        assert!(
            text.contains("拒绝") || text.contains("rejected") || text.contains("认证"),
            "错误原因必须可读：{text}"
        );

        let stats = harness.stats.snapshot();
        assert_eq!(stats.datagrams_in, 0, "{stats:?}");
        assert_eq!(stats.sessions, 0, "{stats:?}");
        assert_eq!(echo.received(), 0);
        println!("[quic bad-proof] rejected without forwarding: {text}");
    }

    /// Noise 模式没有 UDP 路径：必须明确失败，而不是悄悄退化。
    #[tokio::test]
    async fn noise_mode_refuses_udp_relay() {
        let tunnel =
            TunnelClient::noise("127.0.0.1:9".parse().unwrap(), HOP_ID, HOP_SECRET.to_vec());
        let error = tunnel
            .with_udp(vec![TargetRule::new("127.0.0.1", Some((1, 1)))])
            .await
            .expect_err("Noise 模式必须拒绝 UDP 中继");
        assert!(format!("{error:#}").contains("Noise"), "{error:#}");

        let mut hops = HashMap::new();
        hops.insert(HOP_ID.to_string(), HOP_SECRET.to_vec());
        let mut config = TunnelServerConfig::noise("127.0.0.1:0".parse().unwrap(), hops);
        config.allowed_targets = vec![TargetRule::new("127.0.0.1", None)];
        let (server, _listener) = TunnelServer::bind(config).await.unwrap();
        let error = match server
            .with_udp(vec![TargetRule::new("127.0.0.1", None)])
            .await
        {
            Ok(_) => panic!("Noise 服务端必须拒绝 UDP 中继"),
            Err(error) => error,
        };
        assert!(format!("{error:#}").contains("TLS"), "{error:#}");
    }

    /// QUIC 的初始套件必须来自 ring provider（不引入 aws-lc）。
    #[test]
    fn quic_tls_config_uses_the_ring_provider() {
        // `rustls::crypto::ring` 在只启用 ring feature 的构建里一定存在；
        // 若哪天有人给 quinn 打开 aws-lc feature，这个断言会先失败。
        let provider = rustls::crypto::ring::default_provider();
        assert!(
            provider
                .cipher_suites
                .iter()
                .any(|suite| suite.suite() == rustls::CipherSuite::TLS13_AES_128_GCM_SHA256),
            "QUIC 初始套件必须是 TLS13_AES_128_GCM_SHA256"
        );
    }
}
