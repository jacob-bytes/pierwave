//! native 引擎的 UDP 转发。
//!
//! UDP 没有「连接」，所以这里用**会话**表达「一个客户端地址 ↔ 一条上游」：
//! 主控规则在 `forward_bind:listen_port` 上绑一个 [`UdpSocket`] 收包，按客户端
//! `SocketAddr` 查会话表；表里存着**已 connect 到目标的上游 socket**，客户端包
//! 直接 `send()` 过去，上游回包由每条会话自己的读任务 `send_to` 回客户端。
//!
//! 三条不变量：
//!
//! 1. **同一会话固定同一上游**：选路只按客户端地址做一致性哈希（[`pick_target`]），
//!    绝不轮询。UDP 里同一个会话的包如果散到不同上游，对局会直接坏掉
//!    （登录落在 A、对局包落在 B，B 不认识这个会话）；
//! 2. **会话必须能回收**：空闲超过 [`SESSION_IDLE`] 就关掉，否则一个扫描器
//!    发一个包就能永久占住一个 fd；
//! 3. **有上限**：每条规则同时存在的会话不超过 [`MAX_SESSIONS`]，超限拒绝新会话
//!    并只告警一次——被打爆时宁可丢新客户端，也不能把 Agent 的 fd 吃光。
//!
//! `udp = false` 的规则完全不会走到这个模块（由 `forward` 模块决定），
//! 因此 native 的 TCP 行为不受影响。

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pierwave_proto::ForwardTarget;
use tokio::net::UdpSocket;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::timeout;

/// 会话空闲多久回收（沿用 realm 的默认 UDP 超时量级）。
pub(crate) const SESSION_IDLE: Duration = Duration::from_secs(60);
/// 会话回收任务的扫描周期。
pub(crate) const SWEEP_INTERVAL: Duration = Duration::from_secs(10);
/// 每条规则同时存在的会话上限。按 fd / 内存预估：一条规则 4096 个会话
/// 已经是一个繁忙的游戏服代理的规模，再多就该拆规则或换端口了。
pub(crate) const MAX_SESSIONS: usize = 4096;
/// 建连（DNS 解析 + connect）预算；解析卡住不能拖死整个收包循环。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 单条规则只分配一份的收包缓冲：按 UDP 数据报的理论上限分配。
const LISTEN_BUFFER: usize = 65_535;
/// 每条会话的上游收包缓冲。16 KiB 覆盖所有 MTU 内的数据报（含 9K 巨帧），
/// 同时把「4096 会话 × 缓冲」的最坏内存压在 64 MiB——按 65535 分配会是 256 MiB。
const SESSION_BUFFER: usize = 16 * 1024;
/// 关闭时等收包循环退出的上限，超时就强制中止任务。
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
/// 收包 / 读上游出错后的退避，避免空转烧 CPU。
const BACKOFF: Duration = Duration::from_millis(100);

/// 会话表的规模与回收参数。生产用 [`Limits::default`]，测试注入短超时/小上限，
/// 这样「空闲回收」「超上限」都能在毫秒级验证，不用真的等 60 秒。
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    pub(crate) idle: Duration,
    pub(crate) max_sessions: usize,
    pub(crate) sweep_interval: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            idle: SESSION_IDLE,
            max_sessions: MAX_SESSIONS,
            sweep_interval: SWEEP_INTERVAL,
        }
    }
}

/// 一条客户端会话。
struct Session {
    /// 已 connect 到目标的上游 socket：`send()` 不用每次解析地址。
    upstream: Arc<UdpSocket>,
    /// 命中的目标下标（日志与排障用；选路已由客户端哈希固定）。
    target_index: usize,
    /// 最近活跃时刻（毫秒，相对 [`UdpInner::epoch`]）。收包侧与读上游侧都会刷新，
    /// 所以用原子量：两侧都不该为了「记个时间」去抢会话表的锁。
    last_active_ms: Arc<AtomicU64>,
    /// 读上游回包的任务；会话被回收时 abort。
    reader: JoinHandle<()>,
}

impl Session {
    fn last_active(&self) -> u64 {
        self.last_active_ms.load(Ordering::Relaxed)
    }

    /// 摘掉会话时同时停掉读任务——否则 socket 关不掉、fd 泄漏。
    ///
    /// `abort` 只是请求取消，任务真正被 drop 才会释放它持有的 `Arc<UdpSocket>`。
    /// 所以这里必须 await 句柄：调用方（规则关闭 / 空闲回收）返回时 fd 已经释放，
    /// 同端口的新规则可以立刻绑定。
    async fn shutdown(self) {
        self.reader.abort();
        let _ = self.reader.await;
    }
}

/// 会话表：客户端地址 → 上游会话。
///
/// 刻意与 IO 解耦：`touch` / `take_expired` 都显式接收「现在」的毫秒数，
/// 单元测试可以任意拨时钟，不需要 sleep 60 秒。
#[derive(Default)]
struct SessionTable {
    sessions: HashMap<SocketAddr, Session>,
    /// 超限告警只打一次：被打爆的规则不能每来一个包就刷一行日志。
    capacity_warned: bool,
}

impl SessionTable {
    fn len(&self) -> usize {
        self.sessions.len()
    }

    /// 命中已有会话：刷新活跃时间并返回上游 socket。
    fn touch(&mut self, client: &SocketAddr, now_ms: u64) -> Option<Arc<UdpSocket>> {
        let session = self.sessions.get(client)?;
        session.last_active_ms.store(now_ms, Ordering::Relaxed);
        Some(session.upstream.clone())
    }

    /// 插入新会话，返回被替换掉的旧会话（若有），由调用方在锁外 close。
    fn insert(&mut self, client: SocketAddr, session: Session) -> Option<Session> {
        self.sessions.insert(client, session)
    }

    /// 摘掉空闲**超过** `idle` 的会话。abort 读任务这类收尾由调用方在锁外做。
    fn take_expired(&mut self, now_ms: u64, idle: Duration) -> Vec<(SocketAddr, Session)> {
        let idle_ms = u64::try_from(idle.as_millis()).unwrap_or(u64::MAX);
        let expired: Vec<SocketAddr> = self
            .sessions
            .iter()
            .filter(|(_, session)| now_ms.saturating_sub(session.last_active()) > idle_ms)
            .map(|(client, _)| *client)
            .collect();
        expired
            .into_iter()
            .filter_map(|client| {
                self.sessions
                    .remove(&client)
                    .map(|session| (client, session))
            })
            .collect()
    }

    fn take_all(&mut self) -> Vec<(SocketAddr, Session)> {
        self.sessions.drain().collect()
    }
}

/// 一条正在运行的 UDP 转发（一条规则一个）。
pub(crate) struct UdpForward {
    /// 内核实际分配的端口（规则里写 0 时也能读回来，测试用）。
    pub(crate) bound_port: u16,
    inner: Arc<UdpInner>,
    /// `Some` 时用来通知收包循环 / 回收任务退出；`None` 表示已经通知过。
    shutdown: Option<watch::Sender<bool>>,
    /// 收包循环。
    task: JoinHandle<()>,
    /// 会话回收循环。
    sweeper: JoinHandle<()>,
}

struct UdpInner {
    id: String,
    listener: Arc<UdpSocket>,
    targets: Arc<[ForwardTarget]>,
    /// 会话建连失败的累计次数；与 TCP 路径共用同一个计数器。
    connect_failures: Arc<AtomicU64>,
    sessions: Mutex<SessionTable>,
    limits: Limits,
    /// 会话活跃时间的基准点；表里只存相对毫秒数。
    epoch: Instant,
}

/// 绑定并启动一条 UDP 转发。
///
/// `targets` 必须非空（主控侧保证）；单目标时哈希退化成直连。
pub(crate) async fn start(
    id: String,
    bind_host: &str,
    port: u16,
    targets: Arc<[ForwardTarget]>,
    connect_failures: Arc<AtomicU64>,
) -> io::Result<UdpForward> {
    start_with_limits(
        id,
        bind_host,
        port,
        targets,
        connect_failures,
        Limits::default(),
    )
    .await
}

async fn start_with_limits(
    id: String,
    bind_host: &str,
    port: u16,
    targets: Arc<[ForwardTarget]>,
    connect_failures: Arc<AtomicU64>,
    limits: Limits,
) -> io::Result<UdpForward> {
    if targets.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "没有可用的目标",
        ));
    }
    // 绑定成功 = 这个 UDP 端口归我们；`AddrInUse` 会由调用方转成 listening=false。
    let listener = UdpSocket::bind((bind_host, port)).await?;
    let bound_port = listener.local_addr()?.port();
    let inner = Arc::new(UdpInner {
        id,
        listener: Arc::new(listener),
        targets,
        connect_failures,
        sessions: Mutex::new(SessionTable::default()),
        limits,
        epoch: Instant::now(),
    });
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let task = tokio::spawn(receive_loop(inner.clone(), shutdown_rx.clone()));
    let sweeper = tokio::spawn(sweep_loop(inner.clone(), shutdown_rx));
    tracing::info!(
        id = %inner.id,
        port = bound_port,
        target_count = inner.targets.len(),
        max_sessions = limits.max_sessions,
        "UDP 转发监听已启动"
    );
    Ok(UdpForward {
        bound_port,
        inner,
        shutdown: Some(shutdown_tx),
        task,
        sweeper,
    })
}

impl UdpForward {
    /// 通知收包循环与回收任务退出，并等它们真正 drop 掉 socket（端口释放）。
    pub(crate) async fn close(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(true);
        }
        if timeout(SHUTDOWN_TIMEOUT, &mut self.task).await.is_err() {
            tracing::warn!(id = %self.inner.id, "UDP 收包循环关闭超时，强制中止任务");
            self.task.abort();
            let _ = self.task.await;
        }
        self.sweeper.abort();
        let _ = self.sweeper.await;
        // 收包循环已经退出，不会再新建会话；剩下的全部收尾。
        let sessions = self.inner.take_all_sessions();
        let count = sessions.len();
        for (client, session) in sessions {
            session.shutdown().await;
            tracing::debug!(id = %self.inner.id, %client, "UDP 会话随规则关闭");
        }
        tracing::info!(
            id = %self.inner.id,
            port = self.bound_port,
            sessions = count,
            "UDP 转发监听已停止"
        );
    }
}

impl UdpInner {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, SessionTable> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn take_all_sessions(&self) -> Vec<(SocketAddr, Session)> {
        self.lock_sessions().take_all()
    }

    /// 取（或新建）客户端对应的上游会话；超限 / 建连失败返回 `None`。
    ///
    /// 调用方只有收包循环一个（单生产者），所以「查表 → 建会话 → 插入」之间
    /// 不需要处理同客户端并发建会话的问题；回收任务只做删除，插不进来。
    async fn session_for(&self, client: SocketAddr) -> Option<Arc<UdpSocket>> {
        let now = self.now_ms();
        {
            let mut sessions = self.lock_sessions();
            // 命中：只刷新活跃时间。同一客户端绝不会在这里换上游。
            if let Some(upstream) = sessions.touch(&client, now) {
                return Some(upstream);
            }
            // 超限：拒绝新会话，已经存在的会话一个都不挤掉。
            if sessions.len() >= self.limits.max_sessions {
                let warn = !sessions.capacity_warned;
                sessions.capacity_warned = true;
                drop(sessions);
                if warn {
                    tracing::warn!(
                        id = %self.id,
                        %client,
                        limit = self.limits.max_sessions,
                        "UDP 会话数达到上限，新会话被丢弃（已有会话不受影响）"
                    );
                }
                return None;
            }
        }

        // 同一会话固定同一上游：哈希只看客户端地址，不轮询、不看健康快照。
        let index = pick_target(client, self.targets.len());
        let Some(target) = self.targets.get(index) else {
            tracing::error!(id = %self.id, index, "UDP 选路返回了越界目标");
            return None;
        };
        let target_label = format!("{}:{}", target.host, target.port);
        let upstream = match timeout(CONNECT_TIMEOUT, connect_upstream(target)).await {
            Ok(Ok(socket)) => Arc::new(socket),
            Ok(Err(error)) => {
                let count = self.connect_failures.fetch_add(1, Ordering::Relaxed) + 1;
                tracing::warn!(
                    id = %self.id,
                    %client,
                    target = %target_label,
                    %error,
                    failures = count,
                    "UDP 会话建连失败，丢弃该客户端的数据报"
                );
                return None;
            }
            Err(_) => {
                let count = self.connect_failures.fetch_add(1, Ordering::Relaxed) + 1;
                tracing::warn!(
                    id = %self.id,
                    %client,
                    target = %target_label,
                    failures = count,
                    "UDP 会话建连超时，丢弃该客户端的数据报"
                );
                return None;
            }
        };

        let last_active_ms = Arc::new(AtomicU64::new(self.now_ms()));
        let reader = tokio::spawn(read_upstream(
            self.id.clone(),
            client,
            upstream.clone(),
            self.listener.clone(),
            last_active_ms.clone(),
            self.epoch,
        ));
        let previous = self.lock_sessions().insert(
            client,
            Session {
                upstream: upstream.clone(),
                target_index: index,
                last_active_ms,
                reader,
            },
        );
        // 同一客户端理论上只会建一次；真撞了就保留新的、等旧读任务真正退出。
        if let Some(previous) = previous {
            previous.shutdown().await;
        }
        tracing::debug!(
            id = %self.id,
            %client,
            target = %target_label,
            server_id = %target.server_id,
            index,
            sessions = self.lock_sessions().len(),
            "UDP 会话已建立"
        );
        Some(upstream)
    }
}

/// 收包循环：客户端数据报 → 对应会话的上游 socket。
async fn receive_loop(inner: Arc<UdpInner>, mut shutdown: watch::Receiver<bool>) {
    let mut buf = vec![0u8; LISTEN_BUFFER];
    loop {
        tokio::select! {
            // 优先处理关闭：删除规则后不再接受新包。
            biased;
            _ = wait_shutdown(&mut shutdown) => {
                tracing::debug!(id = %inner.id, "UDP 收包循环退出");
                break;
            }
            received = inner.listener.recv_from(&mut buf) => {
                let (size, client) = match received {
                    Ok(value) => value,
                    Err(error) => {
                        // recv 失败（EMFILE 等）不能退出监听，否则整条规则假死。
                        tracing::warn!(id = %inner.id, %error, "UDP 收包失败，稍后重试");
                        tokio::time::sleep(BACKOFF).await;
                        continue;
                    }
                };
                // 0 字节数据报在 UDP 里是合法的（部分游戏拿它做心跳），照常转发。
                let Some(upstream) = inner.session_for(client).await else {
                    continue;
                };
                if let Err(error) = upstream.send(&buf[..size]).await {
                    // 单个包发不出去（EMSGSIZE / 目标临时不可达）只丢这个包：
                    // 会话保留，等上层的重传，绝不 panic、也不关监听。
                    tracing::debug!(
                        id = %inner.id,
                        %client,
                        %error,
                        "UDP 数据报转发到上游失败"
                    );
                }
            }
        }
    }
}

/// 会话回收循环：每 [`Limits::sweep_interval`] 扫一次，摘掉空闲超时的会话。
async fn sweep_loop(inner: Arc<UdpInner>, mut shutdown: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(inner.limits.sweep_interval);
    // interval 的第一次 tick 立即就绪；刚启动没有会话可收，先消费掉。
    interval.tick().await;
    loop {
        tokio::select! {
            biased;
            _ = wait_shutdown(&mut shutdown) => {
                tracing::debug!(id = %inner.id, "UDP 会话回收循环退出");
                break;
            }
            _ = interval.tick() => {
                let expired = inner.lock_sessions().take_expired(inner.now_ms(), inner.limits.idle);
                let count = expired.len();
                for (client, session) in expired {
                    let target_index = session.target_index;
                    session.shutdown().await;
                    tracing::debug!(
                        id = %inner.id,
                        %client,
                        target_index,
                        "UDP 会话空闲回收"
                    );
                }
                if count > 0 {
                    tracing::debug!(
                        id = %inner.id,
                        count,
                        remaining = inner.lock_sessions().len(),
                        "UDP 会话回收完成"
                    );
                }
            }
        }
    }
}

/// 读一条会话的上游回包，并写回建立这条会话的客户端。
///
/// 每条会话一个任务：上游 socket 是 `connect` 过的，回包天然只属于这个客户端，
/// 不需要再做「回包该给谁」的路由。
async fn read_upstream(
    id: String,
    client: SocketAddr,
    upstream: Arc<UdpSocket>,
    listener: Arc<UdpSocket>,
    last_active_ms: Arc<AtomicU64>,
    epoch: Instant,
) {
    let mut buf = vec![0u8; SESSION_BUFFER];
    loop {
        match upstream.recv(&mut buf).await {
            Ok(size) => {
                last_active_ms.store(
                    u64::try_from(epoch.elapsed().as_millis()).unwrap_or(u64::MAX),
                    Ordering::Relaxed,
                );
                if let Err(error) = listener.send_to(&buf[..size], client).await {
                    // 客户端已经走了（ICMP port unreachable 等）不是会话错误：
                    // 继续读，让空闲回收来收尾。
                    tracing::debug!(%id, %client, %error, "UDP 回包写回客户端失败");
                }
            }
            // 目标没人在监听时，内核会把 ICMP unreachable 报成这两个错误。
            // 它们只影响当前这个包，不能因此关掉会话（游戏目标常常先关后开）。
            Err(error) if is_transient_udp_error(&error) => {
                tokio::time::sleep(BACKOFF).await;
            }
            Err(error) => {
                tracing::debug!(%id, %client, %error, "UDP 上游读任务退出");
                return;
            }
        }
    }
}

/// 等关闭信号；发送端被 drop 也视为退出。
async fn wait_shutdown(shutdown: &mut watch::Receiver<bool>) {
    let _ = shutdown.changed().await;
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

/// 解析目标并建一个 connect 过的上游 socket。
async fn connect_upstream(target: &ForwardTarget) -> io::Result<UdpSocket> {
    let port = u16::try_from(target.port).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("目标端口非法: {}", target.port),
        )
    })?;
    let remote = resolve_target(&target.host, port).await?;
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

/// 解析目标地址。
///
/// 用 `(host, port)` 而不是手拼字符串：IPv6 字面量（`2001:db8::1`）不需要
/// 调用方写方括号，`lookup_host` 会直接按 IP 字面量解析，不走 DNS。
/// 域名解析失败就是 `NotFound`，由调用方计数并丢弃当前数据报。
async fn resolve_target(host: &str, port: u16) -> io::Result<SocketAddr> {
    let host = host.trim();
    if host.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "目标地址为空"));
    }
    let mut addresses = tokio::net::lookup_host((host, port)).await?;
    addresses
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("目标地址解析不到: {host}")))
}

/// 会话选路：**只按客户端地址做一致性哈希**，绝不轮询。
///
/// UDP 没有连接概念，轮询会让同一会话的包散到不同上游：登录落在 A、对局包落在 B，
/// B 根本没见过这个会话，玩家直接断线。哈希保证「同一客户端地址 → 同一目标」，
/// 只有在目标列表本身变化时才会重新分配。
///
/// 单目标退化为直连（下标恒为 0）。
pub(crate) fn pick_target(client: SocketAddr, target_count: usize) -> usize {
    if target_count <= 1 {
        return 0;
    }
    (socket_hash(client) % target_count as u64) as usize
}

/// FNV-1a：不引第三方依赖、结果跨进程/跨版本稳定（`DefaultHasher` 不保证）。
///
/// 与 `selector::ip_hash` 的区别是**把源端口也算进去**：会话的 key 本来就是
/// `SocketAddr`，同一个 NAT 后面的多个客户端只靠源端口区分；只哈希 IP 会让
/// 整栋楼的玩家挤到同一个上游。IPv4/IPv6 加一个版本字节，避免两类地址撞在一起。
fn socket_hash(client: SocketAddr) -> u64 {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    fn mix(mut hash: u64, byte: u8) -> u64 {
        hash ^= u64::from(byte);
        hash.wrapping_mul(FNV_PRIME)
    }

    let mut hash = FNV_OFFSET_BASIS;
    match client.ip() {
        std::net::IpAddr::V4(addr) => {
            hash = mix(hash, 4);
            for octet in addr.octets() {
                hash = mix(hash, octet);
            }
        }
        std::net::IpAddr::V6(addr) => {
            hash = mix(hash, 6);
            for octet in addr.octets() {
                hash = mix(hash, octet);
            }
        }
    }
    for byte in client.port().to_be_bytes() {
        hash = mix(hash, byte);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;

    use tokio::net::UdpSocket;
    use tokio::time::timeout;

    fn failures() -> Arc<AtomicU64> {
        Arc::new(AtomicU64::new(0))
    }

    fn targets(addrs: &[SocketAddr]) -> Arc<[ForwardTarget]> {
        addrs
            .iter()
            .map(|addr| ForwardTarget {
                host: addr.ip().to_string(),
                port: i64::from(addr.port()),
                server_id: format!("srv-{}", addr.port()),
            })
            .collect::<Vec<_>>()
            .into()
    }

    /// 本地 UDP echo。`tag` 有值时先在回包里塞一个 tag 字节，方便断言流量去了哪个上游。
    async fn spawn_udp_echo(tag: Option<u8>) -> SocketAddr {
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = socket.local_addr().unwrap();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            loop {
                let Ok((size, peer)) = socket.recv_from(&mut buf).await else {
                    break;
                };
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
        addr
    }

    /// 起一条 UDP 转发，测试结束前记得 `close()`（否则收包任务会活到测试 runtime 结束）。
    async fn start_forward(target: SocketAddr, limits: Limits) -> UdpForward {
        start_with_limits(
            "udp-test".into(),
            "127.0.0.1",
            0,
            targets(&[target]),
            failures(),
            limits,
        )
        .await
        .expect("UDP 端口应能绑定")
    }

    /// 建一个「空转 reader」的会话条目，供纯表级测试使用。
    fn idle_session(last_active_ms: u64) -> Session {
        let upstream = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        upstream.set_nonblocking(true).unwrap();
        let upstream = Arc::new(UdpSocket::from_std(upstream).unwrap());
        Session {
            upstream,
            target_index: 0,
            last_active_ms: Arc::new(AtomicU64::new(last_active_ms)),
            reader: tokio::spawn(async { std::future::pending::<()>().await }),
        }
    }

    fn client_addr(value: &str) -> SocketAddr {
        value.parse().expect("测试用地址必须合法")
    }

    // ---- 选路（纯逻辑）----

    #[test]
    fn same_client_always_lands_on_the_same_target() {
        let client = client_addr("203.0.113.7:40000");
        let first = pick_target(client, 3);
        for _ in 0..128 {
            assert_eq!(
                pick_target(client, 3),
                first,
                "同一客户端地址必须固定同一上游（不能轮询）"
            );
        }
    }

    #[test]
    fn different_clients_spread_across_all_targets() {
        let mut seen = [false; 3];
        for port in 40_000u16..40_256 {
            let client = SocketAddr::from(([203, 0, 113, 7], port));
            seen[pick_target(client, 3)] = true;
        }
        assert!(
            seen.iter().all(|hit| *hit),
            "256 个不同源端口应该覆盖全部 3 个目标，实际 {seen:?}"
        );
    }

    #[test]
    fn single_target_degrades_to_direct() {
        let client = client_addr("198.51.100.9:1234");
        assert_eq!(pick_target(client, 1), 0, "单目标必须是直连");
        assert_eq!(pick_target(client, 0), 0, "空列表也不能 panic");
    }

    #[test]
    fn ipv4_and_ipv6_do_not_collide() {
        let v4 = client_addr("10.0.0.1:1234");
        let v6 = client_addr("[::a00:1]:1234");
        assert_ne!(socket_hash(v4), socket_hash(v6));
    }

    // ---- 会话表（可注入时钟）----

    #[tokio::test]
    async fn idle_sessions_are_reclaimed_after_the_timeout() {
        let mut table = SessionTable::default();
        let client = client_addr("198.51.100.9:1234");
        // last_active = 0ms，用一个「刚刚超过空闲阈值」的 now 扫。
        table.insert(client, idle_session(0));

        let just_before = u64::try_from(SESSION_IDLE.as_millis()).unwrap();
        assert!(
            table.take_expired(just_before, SESSION_IDLE).is_empty(),
            "刚好到阈值（未超过）时不能回收"
        );
        assert_eq!(table.len(), 1);

        let expired = table.take_expired(just_before + 1, SESSION_IDLE);
        assert_eq!(expired.len(), 1, "超过空闲阈值必须回收");
        assert_eq!(expired[0].0, client);
        assert_eq!(table.len(), 0);
    }

    #[tokio::test]
    async fn touch_refreshes_last_active_and_keeps_the_session() {
        let mut table = SessionTable::default();
        let client = client_addr("198.51.100.9:4321");
        table.insert(client, idle_session(0));

        // 第 30 秒还有包：活跃时间被刷新。
        assert!(table.touch(&client, 30_000).is_some());
        let idle_ms = u64::try_from(SESSION_IDLE.as_millis()).unwrap();
        assert!(
            table
                .take_expired(30_000 + idle_ms, SESSION_IDLE)
                .is_empty(),
            "活跃过的会话不能按旧的 last_active 回收"
        );
        assert_eq!(table.len(), 1);

        // 再往后超过阈值才回收。
        assert_eq!(
            table.take_expired(30_000 + idle_ms + 1, SESSION_IDLE).len(),
            1
        );
    }

    #[tokio::test]
    async fn expired_take_returns_sessions_for_shutdown() {
        // 回收时必须把 Session 交出来，否则读上游任务永远不会被 abort。
        let mut table = SessionTable::default();
        table.insert(client_addr("198.51.100.9:5555"), idle_session(0));
        let mut expired = table.take_expired(u64::MAX, SESSION_IDLE);
        let (_, session) = expired.pop().unwrap();
        session.shutdown().await;
        assert!(table.take_all().is_empty());
    }

    // ---- 真跑 socket ----

    /// 同一客户端连续发包复用同一个上游会话（socket 指针相同 = 没有重建）。
    #[tokio::test]
    async fn same_client_reuses_one_upstream_session() {
        let echo = spawn_udp_echo(None).await;
        let forward = start_forward(echo, Limits::default()).await;
        let client = client_addr("127.0.0.1:31001");

        let first = forward
            .inner
            .session_for(client)
            .await
            .expect("第一个包必须能建会话");
        let second = forward
            .inner
            .session_for(client)
            .await
            .expect("第二个包必须命中同一会话");
        assert!(Arc::ptr_eq(&first, &second), "同一会话不能重建上游 socket");
        assert_eq!(forward.inner.lock_sessions().len(), 1);

        forward.close().await;
    }

    /// 客户端发 3 个包，全部经转发回显。
    #[tokio::test]
    async fn three_datagrams_are_echoed_through_the_forwarder() {
        let echo = spawn_udp_echo(None).await;
        let forward = start_forward(echo, Limits::default()).await;
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let listen = format!("127.0.0.1:{}", forward.bound_port);
        let mut reply = [0u8; 64];

        for payload in [b"first".as_slice(), b"second", b"third"] {
            client.send_to(payload, &listen).await.unwrap();
            let (size, from) = timeout(Duration::from_secs(2), client.recv_from(&mut reply))
                .await
                .expect("回显超时")
                .expect("回显失败");
            assert_eq!(&reply[..size], payload, "回显内容必须与发送一致");
            assert_eq!(from, listen.parse::<SocketAddr>().unwrap());
        }

        forward.close().await;
    }

    /// 两个目标 + 两个落在不同哈希桶的客户端：各自拿到自己上游的 tag，
    /// 且同一个客户端重复发包不会换上游。
    #[tokio::test]
    async fn clients_pinned_to_different_targets_get_their_own_upstream() {
        let echo_a = spawn_udp_echo(Some(b'A')).await;
        let echo_b = spawn_udp_echo(Some(b'B')).await;
        let forward = start_with_limits(
            "udp-two".into(),
            "127.0.0.1",
            0,
            targets(&[echo_a, echo_b]),
            failures(),
            Limits::default(),
        )
        .await
        .unwrap();
        let listen: SocketAddr = format!("127.0.0.1:{}", forward.bound_port).parse().unwrap();

        // 绑两个源端口，挑出分别落在目标 0 / 目标 1 的那一对。
        let (client_a, client_b) = pick_two_clients().await;

        for _ in 0..3 {
            assert_eq!(
                roundtrip_udp(&client_a, listen, b"hello-a").await[0],
                b'A',
                "落在目标 0 的客户端必须稳定走 A"
            );
            assert_eq!(
                roundtrip_udp(&client_b, listen, b"hello-b").await[0],
                b'B',
                "落在目标 1 的客户端必须稳定走 B"
            );
        }

        forward.close().await;
    }

    /// 起两个源地址，保证它们的哈希分别落在 0 和 1（目标数 = 2）。
    async fn pick_two_clients() -> (UdpSocket, UdpSocket) {
        let first = loop {
            let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let addr = socket.local_addr().unwrap();
            if pick_target(addr, 2) == 0 {
                break socket;
            }
        };
        loop {
            let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let addr = socket.local_addr().unwrap();
            if pick_target(addr, 2) == 1 {
                return (first, socket);
            }
        }
    }

    async fn roundtrip_udp(client: &UdpSocket, listen: SocketAddr, payload: &[u8]) -> Vec<u8> {
        client.send_to(payload, listen).await.unwrap();
        let mut reply = [0u8; 64];
        let (size, _) = timeout(Duration::from_secs(2), client.recv_from(&mut reply))
            .await
            .expect("回显超时")
            .expect("回显失败");
        reply[..size].to_vec()
    }

    /// 会话回收任务真的会按注入的短阈值把会话摘掉（不用等 60 秒）。
    #[tokio::test]
    async fn sweeper_reclaims_idle_sessions() {
        let echo = spawn_udp_echo(None).await;
        let forward = start_forward(
            echo,
            Limits {
                idle: Duration::from_millis(80),
                max_sessions: MAX_SESSIONS,
                sweep_interval: Duration::from_millis(20),
            },
        )
        .await;
        let client = client_addr("127.0.0.1:31002");
        forward
            .inner
            .session_for(client)
            .await
            .expect("先建一个会话");
        assert_eq!(forward.inner.lock_sessions().len(), 1);

        // 80ms 空闲 + 20ms 扫描周期；给 2 秒余量避免 CI 抖动。
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if forward.inner.lock_sessions().len() == 0 {
                break;
            }
            assert!(Instant::now() < deadline, "空闲会话必须被回收任务清掉");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        forward.close().await;
    }

    /// 超上限：拒绝新会话、只告警一次，已有会话继续可用。
    #[tokio::test]
    async fn over_limit_refuses_new_sessions_and_keeps_existing_ones() {
        let echo = spawn_udp_echo(None).await;
        let forward = start_with_limits(
            "udp-limit".into(),
            "127.0.0.1",
            0,
            targets(&[echo]),
            failures(),
            Limits {
                idle: SESSION_IDLE,
                max_sessions: 2,
                sweep_interval: SWEEP_INTERVAL,
            },
        )
        .await
        .unwrap();
        let inner = forward.inner.clone();

        let first = client_addr("127.0.0.1:32001");
        let second = client_addr("127.0.0.1:32002");
        let third = client_addr("127.0.0.1:32003");
        assert!(inner.session_for(first).await.is_some());
        assert!(inner.session_for(second).await.is_some());

        assert!(
            inner.session_for(third).await.is_none(),
            "超过 max_sessions 必须拒绝新会话"
        );
        assert!(
            inner.lock_sessions().capacity_warned,
            "拒绝时必须告警（只第一次）"
        );
        assert_eq!(inner.lock_sessions().len(), 2, "已有会话不能被挤掉");

        // 已有的客户端继续命中自己的会话，不受上限影响。
        assert!(
            inner.session_for(first).await.is_some(),
            "已存在会话的客户端不能被拒绝"
        );

        forward.close().await;
    }

    /// 目标为空时启动必须失败（主控会拦住，但 Agent 不能因此 panic）。
    #[tokio::test]
    async fn start_without_targets_fails() {
        let error = start_with_limits(
            "udp-empty".into(),
            "127.0.0.1",
            0,
            Arc::from(Vec::new()),
            failures(),
            Limits::default(),
        )
        .await
        .err()
        .expect("没有目标必须返回错误");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    /// 端口已被占用时 `start` 必须返回 `AddrInUse`：调用方据此上报 listening=false。
    #[tokio::test]
    async fn occupied_port_reports_addr_in_use() {
        let occupied = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = occupied.local_addr().unwrap().port();
        let echo = spawn_udp_echo(None).await;
        let error = start_with_limits(
            "udp-busy".into(),
            "127.0.0.1",
            port,
            targets(&[echo]),
            failures(),
            Limits::default(),
        )
        .await
        .err()
        .expect("端口被占用时必须失败");
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);
    }

    // ---- 目标解析与 fd 释放 ----

    /// IPv6 字面量目标不需要调用方写方括号，也不该走 DNS。
    #[tokio::test]
    async fn ipv6_literal_targets_resolve_without_brackets() {
        let addr = resolve_target("2001:db8::1", 443)
            .await
            .expect("IPv6 字面量必须能直接解析");
        assert!(addr.is_ipv6());
        assert_eq!(addr.port(), 443);
        assert_eq!(addr.ip().to_string(), "2001:db8::1");
    }

    /// 目标地址为空 / 端口非法 = 明确错误，由会话层计数并丢弃，不 panic。
    #[tokio::test]
    async fn invalid_targets_are_reported_as_errors() {
        assert_eq!(
            resolve_target("   ", 443).await.unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        let target = ForwardTarget {
            host: "127.0.0.1".into(),
            port: 70_000,
            server_id: "srv".into(),
        };
        assert_eq!(
            connect_upstream(&target).await.unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    /// 会话被关闭后，读上游任务必须在 `close()` 返回前真正 drop：
    /// 否则它持有的 socket 会拖到下一次调度，规则重建时可能出现 fd 残留。
    #[tokio::test]
    async fn close_releases_reader_tasks_before_returning() {
        let echo = spawn_udp_echo(None).await;
        let forward = start_forward(echo, Limits::default()).await;
        let inner = forward.inner.clone();

        // 用一个只有测试能看到的 marker 观察读任务是否还活着。
        let marker = Arc::new(());
        let client = client_addr("127.0.0.1:33001");
        let upstream = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let reader = {
            let marker = marker.clone();
            tokio::spawn(async move {
                let _guard = marker;
                std::future::pending::<()>().await;
            })
        };
        inner.lock_sessions().insert(
            client,
            Session {
                upstream,
                target_index: 0,
                last_active_ms: Arc::new(AtomicU64::new(inner.now_ms())),
                reader,
            },
        );
        assert_eq!(Arc::strong_count(&marker), 2, "读任务必须持有 marker");

        forward.close().await;
        assert_eq!(
            Arc::strong_count(&marker),
            1,
            "close 返回前读任务必须已经被 drop（fd 已释放）"
        );
    }
}
