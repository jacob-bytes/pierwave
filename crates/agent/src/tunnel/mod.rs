//! P16.1：TLS + 自有 CA 的单跳隧道骨架。
//!
//! 一条隧道 = 一条 TCP + TLS 连接，不共享、不复用、不做多路复用。连接建立后：
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
//! - TLS 只由 rustls 实现，本模块不实现任何 AEAD/KDF；
//! - 客户端只信任**显式传入**的 CA，`None` 表示空信任根（fail-closed），
//!   不存在回退 `webpki-roots` 或 `insecure` 开关；
//! - 握手版本精确匹配，失败回 `ServerHello{ok:false, reason}` 后立即断开；
//! - 帧长度硬上限 64 KiB，超限断开并记 error。
//!
//! # 关闭语义
//!
//! - 一端 EOF（TLS close_notify / TCP FIN）→ 对端 `shutdown` 写方向 →
//!   等另一个方向自然结束。`copy_bidirectional` 本身就按这个顺序收尾，
//!   帧层只在两个方向上各加一个泵；
//! - CLOSE 帧是**立即断开**：不排空、不等对端，直接丢弃目标连接。

#![allow(dead_code)] // P16.1 骨架尚未被 main 接线；接 supervisor 时删除（见模块文档）。

mod framing;
mod handshake;

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

use self::handshake::{ClientHello, HandshakeError, ReplayCache, ServerHello};
// 对外的帧/地址类型：上层（TunnelSupervisor）只需要这几个名字。
use self::framing::FrameError;
pub use self::framing::{Frame, FrameKind, TargetAddr, MAX_FRAME_PAYLOAD};

/// 默认最大并发连接数。10k 并发 × 单连接 ~100KB 会吃掉 1GB，
/// 所以必须有硬上限兜住（P16 设计目标见 docs/PLAN.md §5）。
pub const DEFAULT_MAX_CONNECTIONS: usize = 8192;

/// TLS 握手（含 ClientHello/ServerHello）的总预算。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// 连接目标的预算；超时按「目标不可达」处理，避免客户端永久挂起。
const TARGET_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 关闭时等待帧层把尾巴排空的预算；对端不读时不能把任务永久挂住。
const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
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

/// 帧层到 `copy_bidirectional` 之间的内存管道容量。
///
/// 32 KiB 与单方向搬运缓冲同量级：足够吸收一次突发的帧写入，同时把
/// 「每连接常驻」压在 2×32 KiB（copy 双向）+ 32 KiB（duplex）附近。
const DUPLEX_BUF_SIZE: usize = 32 * 1024;

/// 服务端配置。`hops` 是 `hop_id -> hop_secret` 的预共享密钥表。
pub struct TunnelServerConfig {
    /// 监听地址；端口写 0 时由内核分配（测试用）。
    pub bind: std::net::SocketAddr,
    /// 服务端证书链（PEM，可含多段 CERTIFICATE）。
    pub cert_path: PathBuf,
    /// 服务端私钥（PEM：PKCS#8 / PKCS#1 / SEC1 均可）。
    pub key_path: PathBuf,
    /// 本机允许接入的跳。未知 hop_id 一律拒绝。
    pub hops: HashMap<String, Vec<u8>>,
    /// 并发连接硬上限；超限拒绝新连接，不踢在线连接。
    pub max_connections: usize,
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
            cert_path: cert_path.into(),
            key_path: key_path.into(),
            hops,
            max_connections: DEFAULT_MAX_CONNECTIONS,
        }
    }
}

// Debug 会打日志：hop_secret 绝不能出现在日志里，只列 hop_id。
impl fmt::Debug for TunnelServerConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TunnelServerConfig")
            .field("bind", &self.bind)
            .field("cert_path", &self.cert_path)
            .field("key_path", &self.key_path)
            .field("hops", &self.hops.keys().collect::<Vec<_>>())
            .field("max_connections", &self.max_connections)
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
        }
    }
}

#[derive(Debug, Default)]
struct Metrics {
    active: AtomicUsize,
    total: AtomicU64,
    rejected: AtomicU64,
    /// 上次打「连接数超限」warn 的时间；30s 内只打一次，避免刷爆日志。
    last_reject_warn: Mutex<Option<Instant>>,
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
    acceptor: TlsAcceptor,
    hops: HashMap<String, Vec<u8>>,
    max_connections: usize,
    metrics: Arc<Metrics>,
    replay: Mutex<ReplayCache>,
}

/// 隧道服务端。`bind` 后由 `serve` 跑 accept 循环；本类型可 clone 进任务。
#[derive(Clone)]
pub struct TunnelServer {
    inner: Arc<ServerInner>,
}

impl TunnelServer {
    /// 加载证书/私钥并绑定监听。证书或私钥不合法时**在绑定前**失败，
    /// 避免出现「端口占着、但永远握不上手」的假监听。
    pub async fn bind(config: TunnelServerConfig) -> Result<(Self, TcpListener)> {
        validate_server_config(&config)?;
        let tls = server_tls_config(&config.cert_path, &config.key_path)?;
        let listener = TcpListener::bind(config.bind).await.with_context(|| {
            format!(
                "绑定隧道监听 {} 失败 / failed to bind tunnel listener",
                config.bind
            )
        })?;

        let server = Self {
            inner: Arc::new(ServerInner {
                acceptor: TlsAcceptor::from(tls),
                hops: config.hops,
                max_connections: config.max_connections,
                metrics: Arc::new(Metrics::default()),
                replay: Mutex::new(ReplayCache::new()),
            }),
        };
        Ok((server, listener))
    }

    pub fn stats_handle(&self) -> TunnelStatsHandle {
        TunnelStatsHandle {
            metrics: Arc::clone(&self.inner.metrics),
        }
    }

    pub fn stats(&self) -> TunnelStats {
        self.stats_handle().snapshot()
    }

    /// accept 循环，永不正常返回。每条连接一个 task，连接槽由 RAII 守卫归还。
    pub async fn serve(self, listener: TcpListener) -> io::Result<()> {
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

    async fn handle_connection(&self, stream: TcpStream, peer: std::net::SocketAddr) -> Result<()> {
        // 隧道帧多为交互小包；Nagle 会把它们攒成 40ms 的延迟。
        let _ = stream.set_nodelay(true);

        let mut tls = match timeout(HANDSHAKE_TIMEOUT, self.inner.acceptor.accept(stream)).await {
            Ok(Ok(tls)) => tls,
            Ok(Err(error)) => bail!("TLS 握手失败 / TLS handshake failed: {error}"),
            Err(_) => bail!(
                "TLS 握手超时（{}s）/ TLS handshake timed out after {}s",
                HANDSHAKE_TIMEOUT.as_secs(),
                HANDSHAKE_TIMEOUT.as_secs()
            ),
        };

        if let Err(error) = self.authenticate(&mut tls, peer).await {
            // 失败也回 ServerHello{ok:false}，客户端能拿到可读原因；随后断开。
            let reply = ServerHello::reject(error.to_string());
            let _ = timeout(HANDSHAKE_TIMEOUT, reply.write(&mut tls)).await;
            return Err(anyhow!(
                "隧道握手被拒绝 / tunnel handshake rejected: {error}"
            ));
        }
        ServerHello::accept().write(&mut tls).await?;

        // 首帧必须是地址帧；CLOSE 直接结束，PING 说明客户端实现有问题。
        // 握手完成后客户端应立刻发地址，不能无限期占着连接槽。
        let first = match timeout(HANDSHAKE_TIMEOUT, read_frame_logged(&mut tls, peer)).await {
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

        let mut upstream = match connect_target(&target).await {
            Ok(upstream) => upstream,
            Err(error) => {
                // 明确告诉客户端目标不可达，而不是让它等 TLS 超时。
                let _ = framing::write_frame(&mut tls, FrameKind::Close, &[]).await;
                return Err(error);
            }
        };

        forward(&mut tls, &mut upstream, initial, peer).await
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
/// 两个泵 + 一个 `copy_bidirectional`：
///
/// ```text
/// 客户端 --DATA帧--> tls_read  --write--> duplex_write ┐
///                                                     copy_bidirectional <--> 目标 TCP
/// 客户端 <--DATA帧-- tls_write <--read--- duplex_read  ┘
/// ```
///
/// `copy_bidirectional` 负责半关语义：一边 EOF 时对另一边的写方向 `shutdown`，
/// 然后等另一个方向结束。帧层只把「TLS EOF」翻译成 duplex 写方向 shutdown，
/// 把「目标 EOF」翻译成 TLS close_notify（写方向半关，读方向继续）。
async fn forward(
    tls: &mut tokio_rustls::server::TlsStream<TcpStream>,
    upstream: &mut TcpStream,
    initial: Vec<u8>,
    peer: std::net::SocketAddr,
) -> Result<()> {
    let (local, mut remote) = tokio::io::duplex(DUPLEX_BUF_SIZE);
    let (mut local_read, mut local_write) = tokio::io::split(local);
    let (mut tls_read, mut tls_write) = tokio::io::split(tls);

    let to_target = async move {
        if !initial.is_empty() {
            local_write.write_all(&initial).await?;
        }
        loop {
            match read_frame_logged(&mut tls_read, peer).await? {
                Some(frame) => match frame.kind {
                    FrameKind::Data => {
                        if !frame.payload.is_empty() {
                            local_write.write_all(&frame.payload).await?;
                        }
                    }
                    // 心跳只用于保活/未来 RTT 观测，P16.1 不回包。
                    FrameKind::Ping => {}
                    FrameKind::Close => return Ok::<_, anyhow::Error>(ClientEnd::Close),
                },
                None => {
                    // 客户端半关写方向：把 EOF 传给目标，回程仍然继续。
                    local_write.shutdown().await?;
                    return Ok(ClientEnd::Eof);
                }
            }
        }
    };

    let to_client = async move {
        let mut buf = vec![0u8; COPY_BUF_SIZE];
        loop {
            let read = local_read.read(&mut buf).await?;
            if read == 0 {
                // 目标方向 EOF → 给客户端发 TLS close_notify（只关写方向），
                // 客户端仍可继续把剩余数据发过来。
                tls_write.shutdown().await?;
                return Ok::<(), anyhow::Error>(());
            }
            framing::write_frame(&mut tls_write, FrameKind::Data, &buf[..read]).await?;
        }
    };

    let copy = async {
        tokio::io::copy_bidirectional_with_sizes(
            upstream,
            &mut remote,
            COPY_BUF_SIZE,
            COPY_BUF_SIZE,
        )
        .await
    };

    tokio::pin!(to_target, to_client, copy);

    let mut client_done = false;
    let mut target_done = false;
    loop {
        tokio::select! {
            result = &mut to_target, if !client_done => {
                match result? {
                    ClientEnd::Close => {
                        // CLOSE = 立即断开：不排空、不等对端，直接丢 target。
                        return Ok(());
                    }
                    ClientEnd::Eof => client_done = true,
                }
            }
            result = &mut to_client, if !target_done => {
                result?;
                target_done = true;
            }
            result = &mut copy => {
                let (client_to_target, target_to_client) = result?;
                tracing::debug!(
                    peer = %peer,
                    client_to_target,
                    target_to_client,
                    "隧道双向搬运结束 / tunnel copy finished"
                );
                if !target_done {
                    // copy 结束意味着目标方向已 EOF；to_client 只剩把 duplex
                    // 里的尾巴写完并半关 TLS。给它有限时间，避免对端不读时挂死。
                    match timeout(DRAIN_TIMEOUT, &mut to_client).await {
                        Ok(result) => result?,
                        Err(_) => tracing::warn!(
                            peer = %peer,
                            "隧道关闭排空超时 / tunnel drain timed out while closing"
                        ),
                    }
                }
                return Ok(());
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClientEnd {
    /// 客户端半关写方向（TLS close_notify / TCP FIN）。
    Eof,
    /// 客户端显式发 CLOSE 帧。
    Close,
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

/// TLS 隧道客户端。`roots = None` 表示空信任根（fail-closed），
/// 不会隐式使用 `webpki-roots`，这正是不允许 `insecure` 开关的落地方式。
pub struct TunnelClient {
    server_addr: std::net::SocketAddr,
    server_name: ServerName<'static>,
    hop_id: String,
    hop_secret: Vec<u8>,
    config: Arc<ClientConfig>,
    /// 仅测试用：覆盖 ClientHello 的时间戳，用来验证服务端的窗口/重放。
    proof_timestamp: Option<u64>,
}

impl TunnelClient {
    /// 用显式 CA 构建客户端。`roots = None` → 空信任根，连接必定失败。
    pub fn new(
        server_addr: std::net::SocketAddr,
        server_name: ServerName<'static>,
        hop_id: impl Into<String>,
        hop_secret: Vec<u8>,
        roots: Option<Arc<RootCertStore>>,
    ) -> Self {
        Self {
            server_addr,
            server_name,
            hop_id: hop_id.into(),
            hop_secret,
            config: client_tls_config(roots),
            proof_timestamp: None,
        }
    }

    /// 从 CA 文件构建客户端；文件里必须至少有一个 `CERTIFICATE` 块。
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

    /// 建 TLS、握手、发首帧地址，返回可读写帧的连接。
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

        let connector = TlsConnector::from(self.config.clone());
        let mut tls = match timeout(
            HANDSHAKE_TIMEOUT,
            connector.connect(self.server_name.clone(), tcp),
        )
        .await
        {
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

        let timestamp = self.proof_timestamp.unwrap_or_else(handshake::unix_now);
        let hello = ClientHello::new(&self.hop_secret, self.hop_id.clone(), timestamp);
        timeout(HANDSHAKE_TIMEOUT, hello.write(&mut tls))
            .await
            .context("发送 ClientHello 超时 / timed out sending ClientHello")??;

        let reply = timeout(HANDSHAKE_TIMEOUT, ServerHello::read(&mut tls))
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

        let mut connection = TunnelConnection { stream: tls };
        connection.send_address(target).await?;
        Ok(connection)
    }
}

/// 一条已建立的隧道。调用方按帧语义读写；P16.1 不提供 `AsyncRead/AsyncWrite`
/// 适配层（帧边界对上层更重要，等有真实业务接入时再做）。
pub struct TunnelConnection {
    stream: tokio_rustls::client::TlsStream<TcpStream>,
}

impl TunnelConnection {
    /// 发数据帧；单帧上限 64 KiB（超过返回错误，不静默分片）。
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

    pub async fn send_ping(&mut self) -> Result<()> {
        framing::write_frame(&mut self.stream, FrameKind::Ping, &[]).await?;
        Ok(())
    }

    /// 发 CLOSE：服务端立即断开目标连接，不再排空。
    pub async fn send_close(&mut self) -> Result<()> {
        framing::write_frame(&mut self.stream, FrameKind::Close, &[]).await?;
        Ok(())
    }

    /// 读一帧；`None` = 对端半关/关闭（TLS close_notify 或 TCP FIN）。
    pub async fn recv(&mut self) -> Result<Option<Frame>> {
        Ok(framing::read_frame(&mut self.stream).await?)
    }

    /// 只关写方向（TLS close_notify），仍可继续读。用于优雅半关。
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
    Ok(())
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
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use rustls::pki_types::ServerName;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::task::JoinHandle;
    use tokio::time::timeout;
    use tokio_rustls::{client::TlsStream, TlsConnector};

    use super::framing::{FrameKind, TargetAddr, MAX_FRAME_PAYLOAD};
    use super::handshake::{self, ClientHello, ServerHello};
    use super::{
        client_tls_config, roots_from_pem, TunnelClient, TunnelConnection, TunnelServer,
        TunnelServerConfig, TunnelStatsHandle, DEFAULT_MAX_CONNECTIONS,
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
                cert_path,
                key_path,
                hops,
                max_connections,
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
}
