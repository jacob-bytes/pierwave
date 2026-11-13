//! P16.3 入口侧：本地 UDP 客户端 ↔ QUIC 隧道会话。
//!
//! 出口侧（[`super::TunnelServer::with_udp`]）在隧道端口上跑 QUIC endpoint；
//! 本模块在**入口跳**的同一个端口号上再绑一个 UDP socket，把每个本地 UDP
//! 客户端的数据报送进隧道。
//!
//! # 为什么一个客户端一条 QUIC 连接
//!
//! QUIC 的回包只带**目标地址**，不带本地客户端地址（见 [`super::quic`] 的
//! 数据报格式）。同一个目标上的多个本地客户端如果复用一条连接，回包就无法
//! 区分该发给谁。因此：
//!
//! ```text
//! 本地客户端 A:portA ──┐
//!                      ├── QUIC 连接 #1 ──┐
//! 目标 T (链目标)   ←──┘                  ├── 出口 Listener
//! 本地客户端 B:portB ──┐                  │
//!                      ├── QUIC 连接 #2 ──┘
//! 目标 T            ←──┘
//! ```
//!
//! **一条连接 = 一个本地客户端**，回包直接按连接找到 `A:portA` / `B:portB`。
//! 服务端的会话键是 `(连接, 目标)`，与 native UDP 的 `(客户端地址, 目标)`
//! 一一对应，**零数据报格式改动**。
//!
//! # 会话表
//!
//! * 键 = 客户端 `SocketAddr`（IP + 源端口；同一个 NAT 后面的多个客户端靠
//!   源端口区分）；
//! * 首次收到某客户端的数据报：插入 `pending`，异步建 QUIC 连接（TLS 握手 +
//!   hop 认证），期间最多缓存 [`PENDING_BUFFER`] 个数据报，连上后按序补发；
//! * 之后：直接在该连接上 `send_from`，回包任务把 datagram 载荷发回客户端；
//! * 空闲超过 [`Limits::idle`]（默认 60s）回收：关 QUIC 连接、停回包任务；
//! * 连接断开（回包读取失败 / 发送失败）→ 清掉该客户端会话，下一个包重连；
//! * 上限 [`Limits::max_sessions`]（默认 4096），**超限丢新客户端**的数据报，
//!   已有会话不受影响，30s 内只 warn 一次。
//!
//! # 选路
//!
//! `target_rules` **只含链目标那一条**（由 `TunnelSupervisor` 传）。绝不能把
//! 「下一跳 Listener + 链目标」的整份白名单传进来：`send_from` 按客户端地址
//! 做一致性哈希，多一条规则就可能把「下一跳」选成 UDP 后端。
//!
//! # 生命周期
//!
//! [`DialerUdp::serve`] 把收包循环与会话回收集合在同一个 future 里；调用方
//! abort 这个任务时 socket、QUIC 连接与会话表一起 drop（端口立即释放），
//! 不会留下脱离监管的后台任务。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

use super::quic::QuicUdpClient;
use super::whitelist::TargetRule;
use super::TunnelClient;

/// 会话空闲多久回收（与 native UDP / QUIC 服务端同量级）。
pub(crate) const SESSION_IDLE: Duration = Duration::from_secs(60);
/// 会话回收任务的扫描周期。
pub(crate) const SWEEP_INTERVAL: Duration = Duration::from_secs(10);
/// 同时存在的会话上限（与 native UDP / QUIC 服务端一致）。
pub(crate) const MAX_SESSIONS: usize = 4096;
/// 收包缓冲：按 UDP 数据报的理论上限分配，一条规则只此一份。
const LISTEN_BUFFER: usize = 65_535;
/// 建连期间最多缓存多少个数据报（按客户端）。
///
/// QUIC/TLS 握手要几毫秒；不做缓冲的话，客户端在拿到第一个回包之前连发的
/// 包会被丢掉（UDP 允许丢，但没必要）。超过上限就丢新包，等连上后靠上层重传。
const PENDING_BUFFER: usize = 8;
/// 收包出错后的退避，避免空转烧 CPU。
const BACKOFF: Duration = Duration::from_millis(100);

/// 会话表的规模与回收参数。
///
/// 生产用 [`Limits::default`]；测试注入短超时 / 小上限，这样「空闲回收」
/// 能在毫秒级验证，不用真的等 60 秒。
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    /// 会话空闲多久回收。
    pub(crate) idle: Duration,
    /// 单个端点的会话上限；超限丢新客户端，不挤掉已有会话。
    pub(crate) max_sessions: usize,
    /// 回收任务的扫描周期。
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

/// 入口侧 UDP 中继的计数。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Stats {
    /// 从本地客户端收到的数据报数（含随后被上限丢弃的）。
    pub(crate) datagrams_in: u64,
    /// 成功写回本地客户端的回包数。
    pub(crate) datagrams_out: u64,
    /// 当前会话数（含正在建 QUIC 连接的）。
    pub(crate) sessions: usize,
    /// 因会话上限被丢弃的数据报数。
    pub(crate) sessions_rejected: u64,
    /// QUIC 建连失败次数。
    pub(crate) connect_errors: u64,
    /// 在 QUIC 连接上发送失败 / 写回本地客户端失败的次数。
    pub(crate) send_errors: u64,
}

/// 读 [`Stats`] 的句柄（生命周期不绑在 `serve` 任务上）。
#[derive(Clone)]
pub(crate) struct StatsHandle {
    metrics: Arc<Metrics>,
}

impl StatsHandle {
    pub(crate) fn snapshot(&self) -> Stats {
        Stats {
            datagrams_in: self.metrics.datagrams_in.load(Ordering::Relaxed),
            datagrams_out: self.metrics.datagrams_out.load(Ordering::Relaxed),
            sessions: self.metrics.session_count(),
            sessions_rejected: self.metrics.sessions_rejected.load(Ordering::Relaxed),
            connect_errors: self.metrics.connect_errors.load(Ordering::Relaxed),
            send_errors: self.metrics.send_errors.load(Ordering::Relaxed),
        }
    }
}

/// 一条已建立的会话：一个本地客户端 → 一条 QUIC 连接。
struct Session {
    connection: Arc<QuicUdpClient>,
    /// 最近活跃时刻（毫秒，相对 [`Metrics::epoch`]）。
    last_active_ms: Arc<AtomicU64>,
    /// 回包任务（QUIC datagram → 本地客户端）；`None` = 已经收尾。
    reader: Option<JoinHandle<()>>,
}

impl Session {
    fn last_active(&self) -> u64 {
        self.last_active_ms.load(Ordering::Relaxed)
    }

    /// 摘掉会话：先关 QUIC 连接，再停回包任务并等它真正退出。
    async fn shutdown(mut self) {
        self.connection.close();
        if let Some(reader) = self.reader.take() {
            reader.abort();
            let _ = reader.await;
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // `JoinHandle` 的 Drop 只是 detach，不会 abort；规则被删除/重建时
        // 会话表整体 drop，必须同步取消回包任务，否则 QUIC 连接与 fd 会拖到
        // 连接空闲超时（120s）才释放。
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
    }
}

/// 正在建连的客户端；建连期间到达的数据报先攒着。
struct Pending {
    buffered: Vec<Vec<u8>>,
}

#[derive(Default)]
struct State {
    sessions: HashMap<SocketAddr, Session>,
    pending: HashMap<SocketAddr, Pending>,
    /// 正在建连的任务句柄；`serve` 被取消时随 State 一起 abort，避免任务继续
    /// 持有 `Arc<Inner>`（UDP 端口）直到握手超时。
    connectors: HashMap<SocketAddr, JoinHandle<()>>,
}

impl Drop for State {
    fn drop(&mut self) {
        for (_, handle) in self.connectors.drain() {
            handle.abort();
        }
    }
}

/// 计数与会话表；收包循环、建连任务、回包任务共享。
struct Metrics {
    datagrams_in: AtomicU64,
    datagrams_out: AtomicU64,
    sessions_rejected: AtomicU64,
    connect_errors: AtomicU64,
    send_errors: AtomicU64,
    state: Mutex<State>,
    /// 上次「会话超限」warn 的时间；30s 内只打一次。
    last_capacity_warn: Mutex<Option<Instant>>,
    /// 上次「建连失败」warn 的时间；同样 30s 节流。
    last_connect_warn: Mutex<Option<Instant>>,
    /// 会话活跃时间的基准点；表里只存相对毫秒数。
    epoch: Instant,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            datagrams_in: AtomicU64::new(0),
            datagrams_out: AtomicU64::new(0),
            sessions_rejected: AtomicU64::new(0),
            connect_errors: AtomicU64::new(0),
            send_errors: AtomicU64::new(0),
            state: Mutex::new(State::default()),
            last_capacity_warn: Mutex::new(None),
            last_connect_warn: Mutex::new(None),
            epoch: Instant::now(),
        }
    }
}

impl Metrics {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 当前会话数：已建立的 + 正在建连的（两者都占会话名额）。
    fn session_count(&self) -> usize {
        let state = self.lock_state();
        state.sessions.len() + state.pending.len()
    }
}

/// [`DialerUdp::bind`] 的配置。
pub(crate) struct DialerUdpConfig {
    /// 与 TCP 入口同 IP、同端口号（UDP/TCP 是两套协议，可共存）。
    pub(crate) bind: SocketAddr,
    /// 复用隧道的 TLS 配置（对端地址、SNI、CA、hop_id、hop_secret）。
    pub(crate) client: Arc<TunnelClient>,
    /// 候选目标：**只含链目标那一条**，顺序即一致性哈希的桶顺序。
    pub(crate) target_rules: Vec<TargetRule>,
    pub(crate) limits: Limits,
}

struct Inner {
    listener: Arc<UdpSocket>,
    client: Arc<TunnelClient>,
    target_rules: Vec<TargetRule>,
    limits: Limits,
    metrics: Arc<Metrics>,
}

/// 入口跳的 UDP 监听 + 会话表。
pub(crate) struct DialerUdp {
    bound_addr: SocketAddr,
    inner: Arc<Inner>,
    stats: StatsHandle,
}

impl DialerUdp {
    /// 绑定 UDP 端口。绑定失败直接返回错误：调用方据此上报 `listening=false`
    /// （UDP 模式下「TCP 监听成功」不等于端点可用）。
    pub(crate) async fn bind(config: DialerUdpConfig) -> Result<Self> {
        if config.target_rules.is_empty() {
            bail!(
                "UDP 中继至少需要一个带端口的目标规则 / UDP relay needs at least one target rule with a port"
            );
        }
        let listener = UdpSocket::bind(config.bind).await.with_context(|| {
            format!(
                "绑定隧道 UDP 入口 {} 失败 / failed to bind the tunnel UDP dialer",
                config.bind
            )
        })?;
        let bound_addr = listener
            .local_addr()
            .context("读取隧道 UDP 入口地址失败 / failed to read the UDP dialer address")?;
        let limits = config.limits;
        let metrics = Arc::new(Metrics::default());
        tracing::info!(
            bind = %bound_addr,
            targets = config.target_rules.len(),
            max_sessions = limits.max_sessions,
            "隧道 UDP 入口监听已就绪 / tunnel UDP dialer ready"
        );
        let stats = StatsHandle {
            metrics: Arc::clone(&metrics),
        };
        Ok(Self {
            bound_addr,
            inner: Arc::new(Inner {
                listener: Arc::new(listener),
                client: config.client,
                target_rules: config.target_rules,
                limits,
                metrics,
            }),
            stats,
        })
    }

    /// 内核实际分配的地址（`bind` 写端口 0 时也能读回来）。
    #[cfg(test)]
    pub(crate) fn bound_addr(&self) -> SocketAddr {
        self.bound_addr
    }

    pub(crate) fn stats_handle(&self) -> StatsHandle {
        self.stats.clone()
    }

    /// 收包循环 + 会话回收循环，永不正常返回。
    ///
    /// 两个循环放在同一个 future 里，而不是各自 `tokio::spawn`：调用方 abort
    /// 这个任务时 UDP socket 随 future 一起 drop，端口立即释放。
    pub(crate) async fn serve(self) {
        tracing::info!(
            bind = %self.bound_addr,
            "隧道 UDP 入口开始服务 / tunnel UDP dialer serving"
        );
        let inner = self.inner;
        tokio::join!(receive_loop(Arc::clone(&inner)), sweep_loop(inner));
    }
}

/// 收包循环：本地数据报 → 对应客户端的 QUIC 连接。
async fn receive_loop(inner: Arc<Inner>) {
    let mut buf = vec![0u8; LISTEN_BUFFER];
    loop {
        let (size, client) = match inner.listener.recv_from(&mut buf).await {
            Ok(value) => value,
            Err(error) => {
                // recv 失败（EMFILE 等）不能退出监听，否则整条规则假死。
                tracing::warn!(%error, "隧道 UDP 入口收包失败，稍后重试 / tunnel UDP dialer recv failed");
                tokio::time::sleep(BACKOFF).await;
                continue;
            }
        };
        inner.metrics.datagrams_in.fetch_add(1, Ordering::Relaxed);
        inner.handle_datagram(client, &buf[..size]).await;
    }
}

/// 一个数据报的处理结论；判定与 IO 分开，锁只在需要时持有。
enum Action {
    /// 命中已有会话，用这条连接发送。
    Send(Arc<QuicUdpClient>),
    /// 已进入建连队列（或已暂存），无需其它动作。
    Buffered,
    /// 超上限：丢弃并计数。
    Reject,
    /// 新客户端：需要异步建连。
    Connect,
}

impl Inner {
    /// 一个客户端数据报：命中会话直接发；否则建连（或暂存到 pending）。
    async fn handle_datagram(self: &Arc<Self>, client: SocketAddr, payload: &[u8]) {
        let now = self.metrics.now_ms();
        let action = {
            let mut state = self.metrics.lock_state();
            if let Some(session) = state.sessions.get(&client) {
                // 命中：只刷新活跃时间。同一客户端绝不换连接。
                session.last_active_ms.store(now, Ordering::Relaxed);
                Action::Send(Arc::clone(&session.connection))
            } else if let Some(pending) = state.pending.get_mut(&client) {
                // 建连中：先攒着，连上后按到达顺序补发。
                if pending.buffered.len() < PENDING_BUFFER {
                    pending.buffered.push(payload.to_vec());
                }
                Action::Buffered
            } else if state.sessions.len() + state.pending.len() >= self.limits.max_sessions {
                Action::Reject
            } else {
                state.pending.insert(
                    client,
                    Pending {
                        buffered: vec![payload.to_vec()],
                    },
                );
                Action::Connect
            }
        };

        match action {
            Action::Send(connection) => {
                if let Err(error) = connection.send_from(client, payload) {
                    // 连接可能刚断（回包任务还没感知到）：丢掉这个包并清掉会话，
                    // 下一个包重新建连；绝不 panic、也不关整个监听。
                    self.metrics.send_errors.fetch_add(1, Ordering::Relaxed);
                    tracing::debug!(%client, %error, "隧道 UDP 发送失败，会话将被清理 / tunnel UDP send failed, dropping the session");
                    self.drop_session(client).await;
                }
            }
            Action::Buffered => {}
            Action::Reject => {
                self.metrics
                    .sessions_rejected
                    .fetch_add(1, Ordering::Relaxed);
                if warn_due(&self.metrics.last_capacity_warn) {
                    tracing::warn!(
                        %client,
                        limit = self.limits.max_sessions,
                        "隧道 UDP 会话数达到上限，丢弃新客户端的数据报（已有会话不受影响）/ tunnel UDP session limit reached, dropping new datagrams (existing sessions keep working)（{}s 内只记一次 / logged once per {}s）",
                        super::REJECT_WARN_INTERVAL.as_secs(),
                        super::REJECT_WARN_INTERVAL.as_secs()
                    );
                }
            }
            Action::Connect => {
                let inner = Arc::clone(self);
                let handle = tokio::spawn(async move {
                    inner.connect_session(client).await;
                });
                self.metrics.lock_state().connectors.insert(client, handle);
            }
        }
    }

    /// 取（或新建）一个客户端的 QUIC 连接。
    async fn connect_session(self: Arc<Self>, client: SocketAddr) {
        // 这个任务已经跑起来了，表里的句柄不再需要（drop = detach，不影响自己）。
        let _ = self.metrics.lock_state().connectors.remove(&client);
        let result = self.client.with_udp(self.target_rules.clone()).await;
        let connection = match result {
            Ok(connection) => Arc::new(connection),
            Err(error) => {
                self.metrics.connect_errors.fetch_add(1, Ordering::Relaxed);
                self.metrics.lock_state().pending.remove(&client);
                if warn_due(&self.metrics.last_connect_warn) {
                    tracing::warn!(
                        %client,
                        %error,
                        "隧道 UDP 建连失败，丢弃该客户端的数据报 / tunnel UDP session connect failed, dropping the datagram"
                    );
                }
                return;
            }
        };

        let last_active_ms = Arc::new(AtomicU64::new(self.metrics.now_ms()));
        let reader = spawn_reader(
            Arc::clone(&self),
            client,
            Arc::clone(&connection),
            Arc::clone(&last_active_ms),
        );
        let buffered = {
            let mut state = self.metrics.lock_state();
            let buffered = state
                .pending
                .remove(&client)
                .map(|pending| pending.buffered)
                .unwrap_or_default();
            state.sessions.insert(
                client,
                Session {
                    connection: Arc::clone(&connection),
                    last_active_ms,
                    reader: Some(reader),
                },
            );
            buffered
        };
        // 建连期间攒下的数据报按到达顺序补发。单个包失败不影响会话。
        for payload in buffered {
            if let Err(error) = connection.send_from(client, &payload) {
                self.metrics.send_errors.fetch_add(1, Ordering::Relaxed);
                tracing::debug!(%client, %error, "隧道 UDP 补发失败，会话将被清理 / tunnel UDP buffered send failed, dropping the session");
                self.drop_session(client).await;
                return;
            }
        }
        tracing::debug!(
            %client,
            remote = %connection.remote_address(),
            sessions = self.metrics.session_count(),
            "隧道 UDP 会话已建立 / tunnel UDP session established"
        );
    }

    /// 摘掉一个客户端的会话并关闭 QUIC 连接。
    async fn drop_session(&self, client: SocketAddr) {
        let session = self.metrics.lock_state().sessions.remove(&client);
        if let Some(session) = session {
            tracing::debug!(%client, "隧道 UDP 会话已清理 / tunnel UDP session dropped");
            session.shutdown().await;
        }
    }
}

/// 回包任务：QUIC datagram → 建立这条连接时记下的本地客户端。
///
/// 连接断了就清掉会话（只在表里仍是自己时删，避免误删重连后的新会话）。
fn spawn_reader(
    inner: Arc<Inner>,
    client: SocketAddr,
    connection: Arc<QuicUdpClient>,
    last_active_ms: Arc<AtomicU64>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match connection.recv().await {
                Ok(datagram) => {
                    last_active_ms.store(inner.metrics.now_ms(), Ordering::Relaxed);
                    match inner.listener.send_to(&datagram.payload, client).await {
                        Ok(_) => {
                            inner.metrics.datagrams_out.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(error) => {
                            inner.metrics.send_errors.fetch_add(1, Ordering::Relaxed);
                            // 客户端已经走了（ICMP port unreachable 等）不是会话
                            // 错误：继续读，让空闲回收来收尾。
                            tracing::debug!(%client, %error, "隧道 UDP 回包写回客户端失败 / tunnel UDP reply to client failed");
                        }
                    }
                }
                Err(error) => {
                    // 连接断开：清掉该客户端会话，下一个包重新建连。
                    tracing::debug!(%client, %error, "隧道 UDP 连接断开，清理会话 / tunnel UDP connection closed, dropping the session");
                    let removed = {
                        let mut state = inner.metrics.lock_state();
                        let is_current = state
                            .sessions
                            .get(&client)
                            .is_some_and(|session| Arc::ptr_eq(&session.connection, &connection));
                        is_current.then(|| state.sessions.remove(&client)).flatten()
                    };
                    if let Some(session) = removed {
                        // 不 abort `session.reader`：那正是当前任务，直接返回即可。
                        drop(session);
                    }
                    return;
                }
            }
        }
    })
}

/// 会话回收循环：每 [`Limits::sweep_interval`] 扫一次。
async fn sweep_loop(inner: Arc<Inner>) {
    let mut interval = tokio::time::interval(inner.limits.sweep_interval);
    // interval 的第一次 tick 立即就绪；刚启动没有会话可收，先消费掉。
    interval.tick().await;
    loop {
        interval.tick().await;
        let now = inner.metrics.now_ms();
        let expired = {
            let mut state = inner.metrics.lock_state();
            take_expired(&mut state.sessions, now, inner.limits.idle)
        };
        let count = expired.len();
        for (client, session) in expired {
            session.shutdown().await;
            tracing::debug!(
                %client,
                "隧道 UDP 会话空闲回收 / tunnel UDP session reclaimed after idling"
            );
        }
        if count > 0 {
            tracing::debug!(
                count,
                remaining = inner.metrics.session_count(),
                "隧道 UDP 会话回收完成 / tunnel UDP session sweep finished"
            );
        }
    }
}

/// 摘掉空闲**超过** `idle` 的会话（等于阈值不回收）。
fn take_expired(
    sessions: &mut HashMap<SocketAddr, Session>,
    now_ms: u64,
    idle: Duration,
) -> Vec<(SocketAddr, Session)> {
    let idle_ms = u64::try_from(idle.as_millis()).unwrap_or(u64::MAX);
    let expired: Vec<SocketAddr> = sessions
        .iter()
        .filter(|(_, session)| now_ms.saturating_sub(session.last_active()) > idle_ms)
        .map(|(client, _)| *client)
        .collect();
    expired
        .into_iter()
        .filter_map(|client| sessions.remove(&client).map(|session| (client, session)))
        .collect()
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rustls::pki_types::ServerName;
    use tokio::time::timeout;

    use super::super::quic::{QuicUdpLimits, QuicUdpStatsHandle};
    use super::super::{TunnelClient, TunnelServer, TunnelServerConfig};
    use super::*;

    const CA_PEM: &str = include_str!("../../tests/fixtures/tunnel-ca.pem");
    const SERVER_CERT_PEM: &str = include_str!("../../tests/fixtures/tunnel-server.pem");
    const SERVER_KEY_PEM: &str = include_str!("../../tests/fixtures/tunnel-server-key.pem");
    const HOP_ID: &str = "hop-udp-dialer";
    const HOP_SECRET: &[u8] = b"test-hop-secret-32-bytes-long!!!";
    const TEST_SNI: &str = "tunnel.test";

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "pierwave-tunnel-udp-dialer-test-{}",
                uuid::Uuid::new_v4()
            ));
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

    fn localhost_rule(addr: SocketAddr) -> TargetRule {
        TargetRule::new(addr.ip().to_string(), Some((addr.port(), addr.port())))
    }

    /// 带计数的 UDP echo：`received` 是「目标真的收到了几个包」的证据。
    struct UdpEcho {
        addr: SocketAddr,
        received: Arc<std::sync::atomic::AtomicUsize>,
        task: JoinHandle<()>,
    }

    impl Drop for UdpEcho {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn spawn_udp_echo() -> UdpEcho {
        let socket = UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("UDP echo 必须能绑定");
        let addr = socket.local_addr().expect("读取 UDP echo 地址");
        let received = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&received);
        let task = tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            loop {
                let Ok((size, peer)) = socket.recv_from(&mut buf).await else {
                    break;
                };
                counter.fetch_add(1, Ordering::Relaxed);
                if socket.send_to(&buf[..size], peer).await.is_err() {
                    break;
                }
            }
        });
        UdpEcho {
            addr,
            received,
            task,
        }
    }

    struct Harness {
        /// 出口侧 QUIC 计数（服务端会话）。
        server_stats: QuicUdpStatsHandle,
        /// 入口侧本地会话计数。
        dialer_stats: StatsHandle,
        dialer_addr: SocketAddr,
        listener_task: JoinHandle<()>,
        dialer_task: JoinHandle<()>,
        _dir: TempDir,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.listener_task.abort();
            self.dialer_task.abort();
        }
    }

    /// 起一个完整的「出口 Listener + 入口 Dialer」闭环（真 QUIC，真 TLS）。
    async fn start(echo: SocketAddr, limits: Limits) -> Harness {
        let dir = TempDir::new();
        let cert_path = dir.write("server.pem", SERVER_CERT_PEM);
        let key_path = dir.write("server-key.pem", SERVER_KEY_PEM);
        let ca_path = dir.write("ca.pem", CA_PEM);

        let mut hops = HashMap::new();
        hops.insert(HOP_ID.to_string(), HOP_SECRET.to_vec());
        let mut config =
            TunnelServerConfig::new("127.0.0.1:0".parse().unwrap(), cert_path, key_path, hops);
        config.allowed_targets = vec![localhost_rule(echo)];
        let (server, listener) = TunnelServer::bind(config)
            .await
            .expect("测试隧道服务端必须能启动");
        let listener_addr = listener.local_addr().expect("读取监听地址");
        let server = server
            .with_udp_limits(vec![localhost_rule(echo)], QuicUdpLimits::default())
            .await
            .expect("出口 UDP 中继必须能启动");
        let server_stats = server.udp_stats_handle().expect("启用 UDP 必须有计数");
        let listener_task = tokio::spawn(async move {
            let _ = server.serve(listener).await;
        });

        let client = TunnelClient::trusting_ca_file(
            listener_addr,
            ServerName::try_from(TEST_SNI).expect("测试 SNI 必须合法"),
            HOP_ID,
            HOP_SECRET.to_vec(),
            &ca_path,
        )
        .expect("CA 夹具必须能加载");
        let dialer = DialerUdp::bind(DialerUdpConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            client: Arc::new(client),
            target_rules: vec![localhost_rule(echo)],
            limits,
        })
        .await
        .expect("入口 UDP 监听必须能绑定");
        let dialer_addr = dialer.bound_addr();
        let dialer_stats = dialer.stats_handle();
        let dialer_task = tokio::spawn(dialer.serve());

        Harness {
            server_stats,
            dialer_stats,
            dialer_addr,
            listener_task,
            dialer_task,
            _dir: dir,
        }
    }

    async fn roundtrip(client: &UdpSocket, dialer: SocketAddr, payload: &[u8]) -> Vec<u8> {
        client.send_to(payload, dialer).await.expect("发送失败");
        let mut buf = [0u8; 2048];
        let (size, _) = timeout(Duration::from_secs(5), client.recv_from(&mut buf))
            .await
            .expect("等待 UDP 回包超时")
            .expect("读取 UDP 回包失败");
        buf[..size].to_vec()
    }

    async fn wait_until<F: Fn() -> bool>(what: &str, condition: F) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if condition() {
                return;
            }
            assert!(Instant::now() < deadline, "等待超时：{what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// 3 个数据报完整回显；随后空闲回收：入口会话归零，出口连接也随之清掉。
    #[tokio::test]
    async fn three_datagrams_are_echoed_and_idle_sessions_are_reclaimed() {
        let echo = spawn_udp_echo().await;
        let harness = start(
            echo.addr,
            Limits {
                idle: Duration::from_millis(150),
                max_sessions: MAX_SESSIONS,
                sweep_interval: Duration::from_millis(20),
            },
        )
        .await;

        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        for payload in [b"first".as_slice(), b"second", b"third"] {
            assert_eq!(
                roundtrip(&client, harness.dialer_addr, payload).await,
                payload,
                "回显内容必须与发送一致"
            );
        }
        assert_eq!(
            echo.received.load(Ordering::Relaxed),
            3,
            "echo 必须真的收到 3 个包"
        );
        assert_eq!(harness.dialer_stats.snapshot().sessions, 1);
        assert_eq!(harness.server_stats.snapshot().datagrams_in, 3);
        assert_eq!(harness.server_stats.snapshot().sessions, 1);

        // 150ms 空闲 + 20ms 扫描；给 5 秒余量避免 CI 抖动。
        wait_until("入口空闲会话归零", || {
            harness.dialer_stats.snapshot().sessions == 0
        })
        .await;
        // 入口关 QUIC 连接后，出口的会话也必须被清掉（不是等 60s 服务端回收）。
        wait_until("出口会话随连接关闭归零", || {
            harness.server_stats.snapshot().sessions == 0
        })
        .await;
        println!(
            "[udp dialer idle] dialer={:?} server={:?}",
            harness.dialer_stats.snapshot(),
            harness.server_stats.snapshot()
        );
    }

    /// 建连期间连发的数据报不能丢：先攒进 pending，连上后按到达顺序补发。
    #[tokio::test]
    async fn datagrams_sent_while_connecting_are_buffered_and_echoed() {
        let echo = spawn_udp_echo().await;
        let harness = start(echo.addr, Limits::default()).await;
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();

        // 不等回包，先连发 3 个：第 2、3 个大概率落在 TLS 握手期间。
        for payload in [b"one".as_slice(), b"two", b"three"] {
            client
                .send_to(payload, harness.dialer_addr)
                .await
                .expect("发送失败");
        }

        let mut echoed = Vec::new();
        for _ in 0..3 {
            let mut buf = [0u8; 64];
            let (size, _) = timeout(Duration::from_secs(5), client.recv_from(&mut buf))
                .await
                .expect("等待 UDP 回包超时")
                .expect("读取 UDP 回包失败");
            echoed.push(buf[..size].to_vec());
        }
        echoed.sort();
        assert_eq!(
            echoed,
            vec![b"one".to_vec(), b"three".to_vec(), b"two".to_vec()],
            "连发的 3 个数据报都必须回显"
        );
        assert_eq!(echo.received.load(Ordering::Relaxed), 3);
        println!("[udp dialer pending] {:?}", harness.dialer_stats.snapshot());
    }

    /// 超上限：拒绝新客户端、只丢新包，已有会话继续工作。
    #[tokio::test]
    async fn over_session_limit_drops_new_clients_but_keeps_existing_ones() {
        let echo = spawn_udp_echo().await;
        let harness = start(
            echo.addr,
            Limits {
                idle: SESSION_IDLE,
                max_sessions: 1,
                sweep_interval: SWEEP_INTERVAL,
            },
        )
        .await;

        let first = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        assert_eq!(
            roundtrip(&first, harness.dialer_addr, b"first-client").await,
            b"first-client"
        );
        wait_until("第一个会话建立", || {
            harness.dialer_stats.snapshot().sessions == 1
        })
        .await;

        let second = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        second
            .send_to(b"over-limit", harness.dialer_addr)
            .await
            .unwrap();
        let mut buf = [0u8; 256];
        let no_reply = timeout(Duration::from_millis(400), second.recv_from(&mut buf)).await;
        assert!(no_reply.is_err(), "超过会话上限的新客户端不能拿到回包");
        wait_until("超限计数到 1", || {
            harness.dialer_stats.snapshot().sessions_rejected == 1
        })
        .await;
        assert_eq!(
            harness.dialer_stats.snapshot().sessions,
            1,
            "已有会话不能被挤掉"
        );

        // 已有客户端继续可用。
        assert_eq!(
            roundtrip(&first, harness.dialer_addr, b"still-working").await,
            b"still-working"
        );
        println!("[udp dialer limit] {:?}", harness.dialer_stats.snapshot());
    }
}
