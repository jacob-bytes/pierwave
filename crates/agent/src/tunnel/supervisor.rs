//! P16 隧道的收敛器（与 native / realm / nftables 同层）。
//!
//! 主控把一条 2 跳链推导成两条 [`DesiredForward`]：
//!
//! * 入口服务器：`engine = tunnel` + `TunnelSpec.role = dialer`；
//! * 出口服务器：`engine = tunnel` + `TunnelSpec.role = listener`。
//!
//! 本模块让实际运行的监听集合收敛到期望列表：
//!
//! * 新建 → 绑定端口、加载证书/CA、spawn accept（Listener）或
//!   spawn 转发循环（Dialer）；
//! * 参数变化 → 先关旧任务释放端口，再起新的；
//! * 删除 → abort 任务并等它 drop listener；
//! * 幂等 → 同一份 `TunnelSpec` 重复下发只做 diff。
//!
//! 单条规则失败只写进它自己的 `ForwardStatus`，不影响其它规则；失败项在
//! 下一次 `apply` 时重试（例如证书文件刚由 `apply_files` 落盘）。
//!
//! # 周期对账
//!
//! [`TunnelSupervisor::reconcile`] 由心跳每 15 秒调用一次，与 realm 的
//! `ensure_running` 同级自愈：
//!
//! * 任务已退出 → 按**已保存的期望 spec** 重建，不依赖主控重发；
//! * 规则已不在期望集合 → 关闭并清理；
//! * 重建失败只写自己的状态，并按 15s → 30s → 60s … 上限 5 分钟退避，
//!   成功后清零——避免端口/证书一直坏着时每 15 秒刷一样的一行日志。

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use pierwave_proto::{
    DesiredForward, ForwardEngine, ForwardStatus, TunnelRole, TunnelSecurity, TunnelSpec,
};
use rustls::pki_types::ServerName;
use tokio::net::{lookup_host, TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::quic::QuicUdpStatsHandle;
use super::udp_dialer::{self, DialerUdp, DialerUdpConfig};
use crate::forward::ForwardStatusHandle;
use crate::tunnel::framing::TargetAddr;
use crate::tunnel::whitelist::{self, TargetRule};
use crate::tunnel::{TunnelClient, TunnelServer, TunnelServerConfig, TunnelStatsHandle};

/// 与 native / realm 一致的搬运缓冲；TLS record 16 KiB，32 KiB 覆盖两条。
const COPY_BUF_SIZE: usize = 32 * 1024;
/// 关闭时等 accept 循环退出的上限；超时强制 abort。
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
/// 解析 `remote` 域名的预算；域名黑洞时不能拖住整个 apply。
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
/// 心跳对账重建失败后的首次退避；等于默认心跳周期。
const RECONCILE_BASE_DELAY: Duration = Duration::from_secs(15);
/// 连续失败的退避上限：再慢就会让「证书刚补回来」等太久。
const RECONCILE_MAX_DELAY: Duration = Duration::from_secs(300);

/// UDP 中继的计数句柄：Listener 是 QUIC 服务端，Dialer 是本地的 QUIC 会话表。
///
/// 两侧类型不同，但对运维关心的字段（收/发/拒绝/会话数）语义一致；关闭时
/// 统一打进一行日志，也保证这些计数在生产构建里真的被读取。
#[derive(Clone)]
pub(crate) enum UdpStats {
    Listener(QuicUdpStatsHandle),
    Dialer(udp_dialer::StatsHandle),
}

impl UdpStats {
    /// 关闭时记录 UDP 中继计数；`datagrams_in == 0` 表示这条链没有跑过 UDP。
    fn log_close(&self, id: &str) {
        match self {
            Self::Listener(stats) => {
                let snapshot = stats.snapshot();
                tracing::info!(
                    %id,
                    role = "listener",
                    datagrams_in = snapshot.datagrams_in,
                    datagrams_out = snapshot.datagrams_out,
                    denied = snapshot.denied,
                    malformed = snapshot.malformed,
                    hop_mismatch = snapshot.hop_mismatch,
                    sessions_rejected = snapshot.sessions_rejected,
                    forward_errors = snapshot.forward_errors,
                    send_errors = snapshot.send_errors,
                    sessions = snapshot.sessions,
                    "隧道 UDP 中继已停止 / tunnel UDP relay stopped"
                );
            }
            Self::Dialer(stats) => {
                let snapshot = stats.snapshot();
                tracing::info!(
                    %id,
                    role = "dialer",
                    datagrams_in = snapshot.datagrams_in,
                    datagrams_out = snapshot.datagrams_out,
                    sessions_rejected = snapshot.sessions_rejected,
                    connect_errors = snapshot.connect_errors,
                    send_errors = snapshot.send_errors,
                    sessions = snapshot.sessions,
                    "隧道 UDP 入口已停止 / tunnel UDP dialer stopped"
                );
            }
        }
    }

    #[cfg(test)]
    fn listener_snapshot(&self) -> Option<super::quic::QuicUdpStats> {
        match self {
            Self::Listener(stats) => Some(stats.snapshot()),
            Self::Dialer(_) => None,
        }
    }

    #[cfg(test)]
    fn dialer_snapshot(&self) -> Option<udp_dialer::Stats> {
        match self {
            Self::Listener(_) => None,
            Self::Dialer(stats) => Some(stats.snapshot()),
        }
    }
}

/// 一个正在运行的 tunnel 端点。
struct RunningTunnel {
    spec: TunnelSpec,
    task: JoinHandle<()>,
    /// Listener 才有；心跳/测试用。
    stats: Option<TunnelStatsHandle>,
    /// UDP 中继计数；`udp = false` 时为 `None`。
    udp_stats: Option<UdpStats>,
    /// 实际绑定地址（`listen` 写端口 0 时由内核分配）。
    bound_addr: SocketAddr,
    /// 启动时刻；停止日志与「reconcile 没有重建」的测试断言用。
    started_at: Instant,
}

impl RunningTunnel {
    async fn close(self, id: &str) {
        self.task.abort();
        let _ = timeout(SHUTDOWN_TIMEOUT, self.task).await;
        if let Some(udp) = &self.udp_stats {
            udp.log_close(id);
        }
        if let Some(stats) = self.stats {
            let snapshot = stats.snapshot();
            tracing::info!(
                %id,
                bound_addr = %self.bound_addr,
                uptime_secs = self.started_at.elapsed().as_secs(),
                total = snapshot.total,
                rejected = snapshot.rejected,
                denied = snapshot.denied,
                "隧道端点已停止 / tunnel endpoint stopped"
            );
        }
    }
}

/// 一条规则连续启动失败时的退避状态；启动成功即删除。
#[derive(Debug, Clone)]
struct RetryState {
    /// 连续失败次数（`apply` 与心跳对账共用同一计数）。
    failures: u32,
    /// 早于这个时刻，心跳对账不再尝试重建。
    next_retry_at: Instant,
}

/// 连续失败 n 次后的退避：15s → 30s → 60s → …，上限 5 分钟。
fn retry_delay(consecutive_failures: u32) -> Duration {
    let exponent = consecutive_failures.saturating_sub(1).min(8);
    RECONCILE_BASE_DELAY
        .saturating_mul(1u32 << exponent)
        .min(RECONCILE_MAX_DELAY)
}

/// 把启动失败翻译成可读的状态文案。
///
/// 运维最先要区分的是「证书/配置文件缺失」和「端口绑定失败」：前者等文件
/// 重新落盘就会自愈，后者要查端口被谁占了。两者都必须留在
/// [`ForwardStatus::error`] 里，而不是只写日志。
fn describe_start_failure(error: &anyhow::Error) -> String {
    // 文件缺失时 `read_to_string` 的 source 是 `io::Error(NotFound)`；
    // 用错误链判定，比匹配文案可靠。
    if error
        .chain()
        .filter_map(|cause| cause.downcast_ref::<std::io::Error>())
        .any(|io_error| io_error.kind() == std::io::ErrorKind::NotFound)
    {
        return format!("证书或配置文件缺失 / certificate or config file missing: {error:#}");
    }
    let text = format!("{error:#}");
    // TLS 规格缺路径时由 validate_spec 直接给出「证书缺失」，没有 io 错误链。
    if text.contains("证书缺失") || text.contains("certificate missing") {
        return format!("证书或配置文件缺失 / certificate or config file missing: {text}");
    }
    if text.contains("failed to bind") || text.contains("绑定隧道") {
        return format!("绑定失败 / bind failed: {text}");
    }
    if text.contains("certificate") || text.contains("证书") || text.contains("私钥") {
        return format!("证书或配置无效 / certificate or config is invalid: {text}");
    }
    text
}

/// 隧道收敛器。
pub struct TunnelSupervisor {
    running: HashMap<String, RunningTunnel>,
    failed: HashMap<String, String>,
    /// 最近一次期望态（只含 tunnel 规则，按原始顺序）；`reconcile` 用它
    /// 重建，不依赖主控重发。
    desired: Vec<DesiredForward>,
    /// 连续启动失败的重试时刻；成功启动后删除。
    backoff: HashMap<String, RetryState>,
    order: Vec<String>,
    status: ForwardStatusHandle,
}

impl Default for TunnelSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl TunnelSupervisor {
    pub fn new() -> Self {
        Self {
            running: HashMap::new(),
            failed: HashMap::new(),
            desired: Vec::new(),
            backoff: HashMap::new(),
            order: Vec::new(),
            status: ForwardStatusHandle::default(),
        }
    }

    pub fn status_handle(&self) -> ForwardStatusHandle {
        self.status.clone()
    }

    /// 测试辅助：读回内核实际分配的监听端口。
    #[cfg(test)]
    pub(crate) fn bound_addr(&self, id: &str) -> Option<SocketAddr> {
        self.running.get(id).map(|running| running.bound_addr)
    }

    /// 测试辅助：读 UDP 中继计数。
    #[cfg(test)]
    pub(crate) fn udp_stats(&self, id: &str) -> Option<UdpStats> {
        self.running
            .get(id)
            .and_then(|running| running.udp_stats.clone())
    }

    /// 收敛到期望列表。只处理 `engine = tunnel` 的规则。
    ///
    /// `apply` 是主控的明确信号：失败项立即重试，不受心跳退避限制；
    /// 同一份列表重复下发仍然只做 diff。
    pub async fn apply(&mut self, desired: &[DesiredForward]) {
        let mut wanted: Vec<DesiredForward> = Vec::with_capacity(desired.len());
        let mut seen: HashSet<&str> = HashSet::new();
        for spec in desired {
            if spec.engine != ForwardEngine::Tunnel {
                continue;
            }
            if !seen.insert(spec.id.as_str()) {
                tracing::warn!(id = %spec.id, "期望态里有重复的 tunnel id，忽略后一条");
                continue;
            }
            wanted.push(spec.clone());
        }
        self.desired = wanted;
        self.sync(true).await;
    }

    /// 心跳周期对账（与 realm 的 `ensure_running` 同级）。
    ///
    /// 监听/拨号任务意外退出后，按**已保存的期望 spec** 重建，不依赖主控
    /// 重发；已从期望集合移除的规则关闭并释放端口。任务都活着时只做一次
    /// diff：不重建、不重置状态，因此可以安全地高频调用。
    ///
    /// 单条规则重建失败只写进它自己的 [`ForwardStatus`]（`error` 可读），
    /// 不影响其它规则；同一规则连续失败时按 [`retry_delay`] 退避，
    /// 成功后清零。
    pub async fn reconcile(&mut self) {
        self.sync(false).await;
    }

    /// 实际收敛逻辑。`from_apply = false` 时遵守每规则的重建退避。
    async fn sync(&mut self, from_apply: bool) {
        // spec 里只有小字符串（证书路径、hop_secret），每 15 秒 clone 一次
        // 远比重建/加锁便宜；这样循环里可以同时借用 `self` 的其它字段。
        let wanted = self.desired.clone();

        // 1. 关掉已删除 / 参数变化 / 任务已退出的端点。先释放端口，再绑新端口。
        let stale: Vec<String> = self
            .running
            .iter()
            .filter(|(id, running)| {
                !wanted.iter().any(|spec| {
                    spec.id == **id
                        && spec.tunnel.as_ref() == Some(&running.spec)
                        && !running.task.is_finished()
                })
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(running) = self.running.remove(&id) {
                running.close(&id).await;
            }
        }
        // 期望集合里已经没有的规则，失败原因与退避状态一并清掉。
        let wanted_ids: HashSet<&str> = wanted.iter().map(|spec| spec.id.as_str()).collect();
        self.failed.retain(|id, _| wanted_ids.contains(id.as_str()));
        self.backoff
            .retain(|id, _| wanted_ids.contains(id.as_str()));

        // 2. 启动缺失的端点。失败只记录自己的状态，不影响其它规则。
        for spec in &wanted {
            if self.running.contains_key(&spec.id) {
                continue;
            }
            // 心跳对账：连续失败时不要每 15 秒重试刷屏。`apply` 不受此限。
            let blocked = !from_apply
                && self
                    .backoff
                    .get(&spec.id)
                    .is_some_and(|retry| Instant::now() < retry.next_retry_at);
            if blocked {
                continue;
            }
            match start_endpoint(spec).await {
                Ok(StartedEndpoint {
                    spec: spec_tunnel,
                    task,
                    stats,
                    udp_stats,
                    bound_addr,
                }) => {
                    tracing::info!(
                        id = %spec.id,
                        role = ?spec_tunnel.role,
                        listen = %spec_tunnel.listen,
                        remote = %spec_tunnel.remote,
                        reconciled = !from_apply,
                        "隧道端点已启动 / tunnel endpoint started"
                    );
                    self.failed.remove(&spec.id);
                    // 启动成功即清零连续失败计数。
                    self.backoff.remove(&spec.id);
                    self.running.insert(
                        spec.id.clone(),
                        RunningTunnel {
                            spec: spec_tunnel,
                            task,
                            stats,
                            udp_stats,
                            bound_addr,
                            started_at: Instant::now(),
                        },
                    );
                }
                Err(error) => {
                    let reason = describe_start_failure(&error);
                    let failures = self
                        .backoff
                        .get(&spec.id)
                        .map_or(1, |retry| retry.failures.saturating_add(1));
                    let delay = retry_delay(failures);
                    tracing::warn!(
                        id = %spec.id,
                        failures,
                        retry_in_secs = delay.as_secs(),
                        %reason,
                        "隧道端点启动失败 / tunnel endpoint failed to start"
                    );
                    self.failed.insert(spec.id.clone(), reason);
                    self.backoff.insert(
                        spec.id.clone(),
                        RetryState {
                            failures,
                            next_retry_at: Instant::now() + delay,
                        },
                    );
                }
            }
        }

        // 3. 发布心跳状态（顺序 = 期望列表顺序）。
        self.order = wanted.iter().map(|spec| spec.id.clone()).collect();
        self.publish_status();
    }

    fn publish_status(&self) {
        let statuses = self
            .order
            .iter()
            .map(|id| match self.running.get(id) {
                Some(_) => ForwardStatus {
                    id: id.clone(),
                    listening: true,
                    error: String::new(),
                    target_ok: None,
                    target_error: None,
                    targets: Vec::new(),
                    traffic_in: None,
                    traffic_out: None,
                },
                None => ForwardStatus {
                    id: id.clone(),
                    listening: false,
                    error: self.failed.get(id).cloned().unwrap_or_else(|| {
                        "隧道端点未启动 / tunnel endpoint is not running".into()
                    }),
                    target_ok: None,
                    target_error: None,
                    targets: Vec::new(),
                    traffic_in: None,
                    traffic_out: None,
                },
            })
            .collect();
        self.status.store(statuses);
    }
}

/// 一个端点启动后的产物：期望 spec、任务、两侧计数、实际绑定地址。
struct StartedEndpoint {
    spec: TunnelSpec,
    task: JoinHandle<()>,
    stats: Option<TunnelStatsHandle>,
    udp_stats: Option<UdpStats>,
    bound_addr: SocketAddr,
}

async fn start_endpoint(spec: &DesiredForward) -> Result<StartedEndpoint> {
    let tunnel = spec
        .tunnel
        .clone()
        .ok_or_else(|| anyhow!("engine=tunnel 但缺少 tunnel 段 / missing tunnel spec"))?;
    validate_spec(&tunnel)?;
    let secret = base64::engine::general_purpose::STANDARD
        .decode(&tunnel.hop_secret)
        .context("hop_secret 不是合法 base64 / hop_secret is not valid base64")?;
    if secret.len() != 32 {
        bail!(
            "hop_secret 必须是 32 字节（base64 解码后 {} 字节）/ hop_secret must be 32 bytes, got {}",
            secret.len(),
            secret.len()
        );
    }

    match tunnel.role {
        TunnelRole::Listener => {
            let bind: SocketAddr = tunnel.listen.parse().with_context(|| {
                format!("监听地址非法 / invalid listen address: {}", tunnel.listen)
            })?;
            let mut hops = HashMap::new();
            hops.insert(tunnel.hop_id.clone(), secret);
            let allowed_targets = target_rules(&tunnel);
            if allowed_targets.is_empty() {
                // 不是错误：空白名单表示拒绝一切，但显式记一条 warn 便于排障。
                tracing::warn!(
                    id = %spec.id,
                    "tunnel Listener 的白名单为空，将拒绝所有目标 / empty allowlist: all targets denied"
                );
            }
            let mut config = match tunnel.security {
                // TLS：证书/私钥路径由主控下发，缺失时在 bind 前失败。
                TunnelSecurity::Tls => TunnelServerConfig::new(
                    bind,
                    tunnel.cert_pem_path.clone(),
                    tunnel.key_pem_path.clone(),
                    hops,
                ),
                // Noise：完全不读证书路径，只认 hop_secret。
                TunnelSecurity::Noise => TunnelServerConfig::noise(bind, hops),
            };
            config.max_connections = crate::tunnel::DEFAULT_MAX_CONNECTIONS;
            // UDP 中继的白名单**只含链目标**（`dial_target` = 白名单最后一条）。
            // 不能把整份 allowed_targets 传进去：那是 TCP 首帧的语义，可能含
            // 其它条目；UDP 出口只允许把数据报发给链目标。
            let udp_targets = if tunnel.udp {
                match tunnel.allowed_targets.last() {
                    Some(_) => vec![dial_target_rule(&tunnel)?],
                    // 空白名单 = 拒绝一切 UDP（与 TCP 首帧同一语义），不是错误。
                    None => Vec::new(),
                }
            } else {
                Vec::new()
            };
            config.allowed_targets = allowed_targets;
            let (server, listener) = TunnelServer::bind(config).await?;
            let bound_addr = listener.local_addr().context("读取隧道监听地址失败")?;
            // `udp = true` 时在同一个端口号上起 QUIC endpoint；绑定/证书失败
            // 直接让整个端点启动失败（listening = false），不能只跑一半。
            let server = if tunnel.udp {
                server.with_udp(udp_targets).await.map_err(|error| {
                    error.context(
                        "隧道 Listener 的 UDP 中继启动失败 / failed to start the tunnel UDP relay",
                    )
                })?
            } else {
                server
            };
            let stats = server.stats_handle();
            let udp_stats = server.udp_stats_handle().map(UdpStats::Listener);
            let task = tokio::spawn(async move {
                if let Err(error) = server.serve(listener).await {
                    tracing::error!(error = %error, "隧道 Listener 退出 / tunnel listener exited");
                }
            });
            Ok(StartedEndpoint {
                spec: tunnel,
                task,
                stats: Some(stats),
                udp_stats,
                bound_addr,
            })
        }
        TunnelRole::Dialer => {
            let bind: SocketAddr = tunnel.listen.parse().with_context(|| {
                format!("监听地址非法 / invalid listen address: {}", tunnel.listen)
            })?;
            let (remote, server_name) = resolve_remote(&tunnel.remote).await?;
            // Dialer 只允许连「本链下一跳」：remote 必须命中 allowed_targets。
            // 最后一条规则是每连接请求的目标（链目标），前面的规则用于约束 remote。
            let allowed = target_rules(&tunnel);
            let remote_target = remote_as_target(&tunnel.remote)?;
            if !whitelist::allows(&allowed, &remote_target) {
                bail!(
                    "Dialer 的 remote {} 不在允许的目标列表内 / dialer remote is not allowlisted",
                    tunnel.remote
                );
            }
            let target = dial_target(&tunnel)?;
            let client = match tunnel.security {
                // TLS：CA 文件必须存在且可读。
                TunnelSecurity::Tls => {
                    let ca_path = tunnel.ca_pem_path.clone();
                    TunnelClient::trusting_ca_file(
                        remote,
                        server_name,
                        tunnel.hop_id.clone(),
                        secret,
                        std::path::Path::new(&ca_path),
                    )?
                }
                // Noise：不需要 CA/SNI，只共享 hop_secret。
                TunnelSecurity::Noise => TunnelClient::noise(remote, tunnel.hop_id.clone(), secret),
            };
            let listener = TcpListener::bind(bind).await.with_context(|| {
                format!("绑定隧道入口 {bind} 失败 / failed to bind tunnel dialer")
            })?;
            let bound_addr = listener.local_addr().context("读取隧道入口地址失败")?;
            let client = Arc::new(client);
            // UDP 入口与 TCP 入口同 IP、同端口号。候选目标**只传链目标那一条**：
            // 把含下一跳的整份白名单传进去，一致性哈希可能把 Listener 当后端。
            let udp = if tunnel.udp {
                let target_rule = dial_target_rule(&tunnel)?;
                Some(
                    DialerUdp::bind(DialerUdpConfig {
                        bind: bound_addr,
                        client: Arc::clone(&client),
                        target_rules: vec![target_rule],
                        limits: udp_dialer::Limits::default(),
                    })
                    .await
                    .map_err(|error| {
                        error.context(
                            "隧道 Dialer 的 UDP 入口启动失败 / failed to start the tunnel UDP dialer",
                        )
                    })?,
                )
            } else {
                None
            };
            let udp_stats = udp.as_ref().map(|udp| UdpStats::Dialer(udp.stats_handle()));
            let id = spec.id.clone();
            let task = tokio::spawn(async move {
                match udp {
                    // 两个循环放在同一个任务里：abort 时 UDP socket 随 future 一起
                    // drop，端口立即释放，不会留下脱离监管的后台任务。
                    Some(udp) => {
                        let tcp = dialer_accept_loop(id, listener, client, target, bound_addr);
                        tokio::pin!(tcp);
                        tokio::select! {
                            () = &mut tcp => {}
                            () = udp.serve() => {}
                        }
                    }
                    None => dialer_accept_loop(id, listener, client, target, bound_addr).await,
                }
            });
            Ok(StartedEndpoint {
                spec: tunnel,
                task,
                stats: None,
                udp_stats,
                bound_addr,
            })
        }
    }
}

fn validate_spec(spec: &TunnelSpec) -> Result<()> {
    if spec.hop_id.trim().is_empty() || spec.hop_id.len() > 255 {
        bail!("hop_id 长度非法（1..=255）/ invalid hop_id length (1..=255)");
    }
    // 主控保存时已拒绝；Agent 再挡一次，避免旧/手工数据让端点起一半。
    if spec.udp && spec.security != TunnelSecurity::Tls {
        bail!("Noise 模式的 UDP 中继本轮不做 / UDP relay over Noise is not implemented yet");
    }
    match spec.role {
        TunnelRole::Listener => {
            // Noise 模式不读证书路径：空串 / 不存在的路径都是合法状态。
            if spec.security == TunnelSecurity::Tls
                && (spec.cert_pem_path.trim().is_empty() || spec.key_pem_path.trim().is_empty())
            {
                bail!(
                    "Listener 缺少证书/私钥路径（证书缺失）/ listener is missing certificate/key paths (certificate missing)"
                );
            }
        }
        TunnelRole::Dialer => {
            if spec.remote.trim().is_empty() {
                bail!("Dialer 缺少 remote / dialer is missing remote address");
            }
            // Noise 模式不需要 CA 文件。
            if spec.security == TunnelSecurity::Tls && spec.ca_pem_path.trim().is_empty() {
                bail!("Dialer 缺少 ca_pem_path / dialer is missing CA path");
            }
        }
    }
    Ok(())
}

/// 把 proto 里的白名单规则转成 Agent 侧的匹配器。
fn target_rules(spec: &TunnelSpec) -> Vec<TargetRule> {
    spec.allowed_targets
        .iter()
        .map(|rule| TargetRule::new(rule.host.clone(), rule.ports))
        .collect()
}

/// Dialer 每连接请求的目标：白名单的**最后一条**。
///
/// 主控为 2 跳链生成两条规则：第一条是下一跳 Listener（约束 `remote`），
/// 最后一条是链目标（真正请求给 Listener 的地址）。多条时取最后一条，
/// 且必须有确定端口。
fn dial_target(spec: &TunnelSpec) -> Result<TargetAddr> {
    let Some(rule) = spec.allowed_targets.last() else {
        bail!("Dialer 的 allowed_targets 为空，无法确定隧道目标 / dialer has no allowed target");
    };
    let Some((port, _)) = rule.ports else {
        bail!(
            "Dialer 的目标规则必须指定端口 / dialer target rule must specify a port: {}",
            rule.host
        );
    };
    if let Ok(ip) = rule.host.trim().parse::<IpAddr>() {
        return Ok(TargetAddr::Ip(SocketAddr::new(ip, port)));
    }
    let host = rule.host.trim().to_string();
    if host.is_empty() {
        bail!("Dialer 的目标域名为空 / dialer target host is empty");
    }
    Ok(TargetAddr::Domain { host, port })
}

/// Dialer 的 UDP 候选目标：只取链目标那一条（与 [`dial_target`] 完全一致）。
///
/// **不能**把整份 `allowed_targets` 传给 UDP 选路：那份列表的第一条是下一跳
/// Listener，一致性哈希会把它当成一个 UDP 后端。这里把目标规范化成
/// [`TargetRule`]（IP 用精确地址、域名用后缀规则 + 闭区间端口）。
fn dial_target_rule(spec: &TunnelSpec) -> Result<TargetRule> {
    Ok(match dial_target(spec)? {
        TargetAddr::Ip(addr) => {
            TargetRule::new(addr.ip().to_string(), Some((addr.port(), addr.port())))
        }
        TargetAddr::Domain { host, port } => TargetRule::new(host, Some((port, port))),
    })
}

/// `remote` 字符串对应的目标地址，用于让 Dialer 用同一套白名单规则校验它。
fn remote_as_target(remote: &str) -> Result<TargetAddr> {
    let trimmed = remote.trim();
    if let Ok(addr) = trimmed.parse::<SocketAddr>() {
        return Ok(TargetAddr::Ip(addr));
    }
    let (host, port) = trimmed
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("remote 必须带端口 / remote must include a port: {remote}"))?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port: u16 = port
        .parse()
        .with_context(|| format!("remote 端口非法 / invalid remote port: {remote}"))?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(TargetAddr::Ip(SocketAddr::new(ip, port)));
    }
    Ok(TargetAddr::Domain {
        host: host.to_string(),
        port,
    })
}

/// 解析 `remote`（`host:port`），并给出 TLS 校验用的 ServerName。
async fn resolve_remote(remote: &str) -> Result<(SocketAddr, ServerName<'static>)> {
    let trimmed = remote.trim();
    if let Ok(addr) = trimmed.parse::<SocketAddr>() {
        return Ok((addr, server_name_for(addr.ip())?));
    }

    // 域名 + 端口；IPv6 字面量在上面的 SocketAddr 分支已经处理。
    let (host, port) = trimmed
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("remote 必须带端口 / remote must include a port: {remote}"))?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port: u16 = port
        .parse()
        .with_context(|| format!("remote 端口非法 / invalid remote port: {remote}"))?;
    if host.is_empty() {
        bail!("remote 主机名为空 / remote host is empty");
    }

    let addrs: Vec<SocketAddr> = timeout(RESOLVE_TIMEOUT, lookup_host((host, port)))
        .await
        .context("解析 remote 超时 / resolving remote timed out")??
        .collect();
    let addr = addrs
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("remote 解析不到地址 / remote did not resolve: {host}"))?;
    // 无方括号的 IPv6 字面量会走到这里（lookup_host 能解析），SNI 仍必须是
    // IP，而不是一个永远匹配不上 IP SAN 的 DnsName。
    let server_name = match host.parse::<IpAddr>() {
        Ok(ip) => server_name_for(ip)?,
        Err(_) => ServerName::try_from(host.to_string())?,
    };
    Ok((addr, server_name))
}

fn server_name_for(ip: IpAddr) -> Result<ServerName<'static>> {
    Ok(ServerName::IpAddress(ip.into()))
}

async fn dialer_accept_loop(
    id: String,
    listener: TcpListener,
    client: Arc<TunnelClient>,
    target: TargetAddr,
    bound_addr: SocketAddr,
) {
    tracing::info!(%id, %bound_addr, ?target, "隧道 Dialer 开始监听 / tunnel dialer listening");
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                tracing::warn!(%id, %error, "隧道 Dialer accept 失败 / tunnel dialer accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let client = Arc::clone(&client);
        let target = target.clone();
        let id = id.clone();
        tokio::spawn(async move {
            if let Err(error) = dialer_connection(&id, client, target, stream, peer).await {
                tracing::debug!(%id, %peer, "隧道 Dialer 连接结束 / tunnel dialer connection ended: {error:#}");
            }
        });
    }
}

async fn dialer_connection(
    id: &str,
    client: Arc<TunnelClient>,
    target: TargetAddr,
    mut stream: TcpStream,
    peer: SocketAddr,
) -> Result<()> {
    let _ = stream.set_nodelay(true);
    let tunnel = client.connect(&target).await?;
    let mut framed = tunnel.into_frame_io();
    let close = framed.close_notify();
    let already_closed = framed.saw_close();
    let copy = tokio::io::copy_bidirectional_with_sizes(
        &mut stream,
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
            tracing::debug!(%id, %peer, "隧道服务端 CLOSE，立即断开 / tunnel server sent CLOSE");
        }
        result = &mut copy => {
            let (up, down) = result?;
            tracing::debug!(%id, %peer, up, down, "隧道 Dialer 双向搬运结束 / tunnel dialer copy finished");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    use std::sync::atomic::{AtomicUsize, Ordering};

    use pierwave_proto::TunnelTargetRule;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UdpSocket;
    use tokio::time::timeout;

    const CA_PEM: &str = include_str!("../../tests/fixtures/tunnel-ca.pem");
    const SERVER_CERT_PEM: &str = include_str!("../../tests/fixtures/tunnel-server.pem");
    const SERVER_KEY_PEM: &str = include_str!("../../tests/fixtures/tunnel-server-key.pem");
    const HOP_ID: &str = "hop-1";
    const HOP_SECRET: &[u8] = b"test-hop-secret-32-bytes-long!!!";

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "pierwave-tunnel-supervisor-test-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).expect("创建测试临时目录");
            Self(dir)
        }

        fn write(&self, name: &str, contents: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, contents).expect("写测试文件失败");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn free_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("探测空闲端口");
        listener.local_addr().expect("读取空闲端口").port()
    }

    fn base64_secret(secret: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(secret)
    }

    /// 一个端点的三类证书路径；空串 = 该角色不需要。
    struct SpecPaths<'a> {
        cert: &'a str,
        key: &'a str,
        ca: &'a str,
    }

    fn forward_with_paths(
        id: &str,
        role: TunnelRole,
        listen_port: u16,
        remote: &str,
        paths: SpecPaths<'_>,
        allowed: &[SocketAddr],
    ) -> DesiredForward {
        DesiredForward {
            id: id.into(),
            listen_port: i64::from(listen_port),
            target_host: String::new(),
            target_port: 0,
            targets: Vec::new(),
            strategy: Default::default(),
            engine: ForwardEngine::Tunnel,
            protocol: Default::default(),
            udp: false,
            listen_transport: None,
            remote_transport: None,
            disable_udp: false,
            tunnel: Some(TunnelSpec {
                role,
                hop_id: HOP_ID.into(),
                listen: format!("127.0.0.1:{listen_port}"),
                remote: remote.into(),
                security: TunnelSecurity::Tls,
                cert_pem_path: paths.cert.into(),
                key_pem_path: paths.key.into(),
                ca_pem_path: paths.ca.into(),
                hop_secret: base64_secret(HOP_SECRET),
                allowed_targets: allowed
                    .iter()
                    .map(|addr| TunnelTargetRule {
                        host: addr.ip().to_string(),
                        ports: Some((addr.port(), addr.port())),
                    })
                    .collect(),
                udp: false,
            }),
        }
    }

    fn listener_spec(id: &str, port: u16, cert: &Path, key: &Path) -> DesiredForward {
        listener_spec_paths(
            id,
            port,
            &cert.display().to_string(),
            &key.display().to_string(),
        )
    }

    fn listener_spec_allowed(
        id: &str,
        port: u16,
        cert: &Path,
        key: &Path,
        allowed: &[SocketAddr],
    ) -> DesiredForward {
        let cert = cert.display().to_string();
        let key = key.display().to_string();
        forward_with_paths(
            id,
            TunnelRole::Listener,
            port,
            "",
            SpecPaths {
                cert: &cert,
                key: &key,
                ca: "",
            },
            allowed,
        )
    }

    fn listener_spec_paths(id: &str, port: u16, cert: &str, key: &str) -> DesiredForward {
        forward_with_paths(
            id,
            TunnelRole::Listener,
            port,
            "",
            SpecPaths { cert, key, ca: "" },
            &[],
        )
    }

    fn dialer_spec(
        id: &str,
        port: u16,
        remote_port: u16,
        ca: &Path,
        allowed: &[SocketAddr],
    ) -> DesiredForward {
        let remote = format!("127.0.0.1:{remote_port}");
        let ca = ca.display().to_string();
        forward_with_paths(
            id,
            TunnelRole::Dialer,
            port,
            &remote,
            SpecPaths {
                cert: "",
                key: "",
                ca: &ca,
            },
            allowed,
        )
    }

    /// Noise 规格：三个证书路径都是空串，Agent 不能因此报错。
    fn noise_spec(
        id: &str,
        role: TunnelRole,
        port: u16,
        remote: &str,
        allowed: &[SocketAddr],
    ) -> DesiredForward {
        let mut forward = forward_with_paths(
            id,
            role,
            port,
            remote,
            SpecPaths {
                cert: "",
                key: "",
                ca: "",
            },
            allowed,
        );
        forward.tunnel.as_mut().expect("必须带 tunnel 段").security = TunnelSecurity::Noise;
        forward
    }

    fn status_of(supervisor: &TunnelSupervisor, id: &str) -> ForwardStatus {
        supervisor
            .status_handle()
            .snapshot()
            .into_iter()
            .find(|status| status.id == id)
            .unwrap_or_else(|| panic!("缺少 {id} 的状态"))
    }

    async fn wait_until_finished(supervisor: &TunnelSupervisor, id: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if supervisor
                .running
                .get(id)
                .is_some_and(|running| running.task.is_finished())
            {
                return;
            }
            assert!(Instant::now() < deadline, "等待 {id} 任务退出超时");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// 回环 echo：读到多少原样写回，读到 EOF 就退出。
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
        (addr, task)
    }

    async fn roundtrip(port: u16, payload: &[u8]) -> Vec<u8> {
        let mut client = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("连接 Dialer 失败");
        client.write_all(payload).await.expect("写入 Dialer 失败");
        let mut echoed = vec![0u8; payload.len()];
        timeout(Duration::from_secs(5), client.read_exact(&mut echoed))
            .await
            .expect("读回显超时")
            .expect("读回显失败");
        echoed
    }

    /// 本地 UDP echo；`received` 是「真的收到了几个包」的证据。
    struct UdpEcho {
        addr: SocketAddr,
        received: Arc<AtomicUsize>,
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
        let received = Arc::new(AtomicUsize::new(0));
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

    /// 通过入口 UDP 端口发一个包并等回包。
    async fn udp_roundtrip(client: &UdpSocket, dialer: SocketAddr, payload: &[u8]) -> Vec<u8> {
        client
            .send_to(payload, dialer)
            .await
            .expect("发送 UDP 数据报失败");
        let mut reply = [0u8; 2048];
        let (size, from) = timeout(Duration::from_secs(5), client.recv_from(&mut reply))
            .await
            .expect("等待 UDP 回包超时")
            .expect("读取 UDP 回包失败");
        assert_eq!(from, dialer, "回包必须来自入口的 UDP 端口");
        reply[..size].to_vec()
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

    /// 只打开 TunnelSpec.udp，其余字段保持不变（tcp-only 用例完全不受影响）。
    fn with_tunnel_udp(mut forward: DesiredForward) -> DesiredForward {
        forward.tunnel.as_mut().expect("必须带 tunnel 段").udp = true;
        forward
    }

    fn certs() -> (TempDir, PathBuf, PathBuf, PathBuf) {
        let dir = TempDir::new();
        let cert = dir.write("server.pem", SERVER_CERT_PEM);
        let key = dir.write("server-key.pem", SERVER_KEY_PEM);
        let ca = dir.write("ca.pem", CA_PEM);
        (dir, cert, key, ca)
    }

    /// 杀掉拨号任务后，心跳对账必须按已保存的 spec 重建，且端口仍可连通；
    /// 同机的 Listener 不能被一起重建。
    #[tokio::test]
    async fn reconcile_rebuilds_a_killed_endpoint_and_keeps_the_port_connectable() {
        let (echo_addr, echo_task) = spawn_echo().await;
        let (_dir, cert, key, ca) = certs();
        let listener_port = free_port();
        let dialer_port = free_port();
        let allowed = [
            format!("127.0.0.1:{listener_port}").parse().unwrap(),
            echo_addr,
        ];

        let listener =
            listener_spec_allowed("tunnel-listener", listener_port, &cert, &key, &[echo_addr]);
        let dialer = dialer_spec("tunnel-dialer", dialer_port, listener_port, &ca, &allowed);

        let mut supervisor = TunnelSupervisor::new();
        supervisor.apply(&[listener, dialer]).await;
        assert!(status_of(&supervisor, "tunnel-dialer").listening);
        assert_eq!(roundtrip(dialer_port, b"before").await, b"before");
        let dialer_started = supervisor.running["tunnel-dialer"].started_at;
        let listener_started = supervisor.running["tunnel-listener"].started_at;

        // 模拟拨号任务意外退出：abort 后 JoinHandle 变成 finished。
        supervisor.running["tunnel-dialer"].task.abort();
        wait_until_finished(&supervisor, "tunnel-dialer").await;

        supervisor.reconcile().await;

        let dialer_status = status_of(&supervisor, "tunnel-dialer");
        assert!(dialer_status.listening, "{dialer_status:?}");
        assert!(dialer_status.error.is_empty(), "{dialer_status:?}");
        assert!(
            supervisor.running["tunnel-dialer"].started_at > dialer_started,
            "被杀掉的端点必须重建"
        );
        assert_eq!(
            supervisor.running["tunnel-listener"].started_at, listener_started,
            "其它端点不能被一起重建"
        );
        // 服务端重放缓存按 HMAC(hop_id || timestamp) 去重：同一秒内的第二次
        // 连接会被当成重放拒绝，等过一秒再验证重建后的端口。
        tokio::time::sleep(Duration::from_millis(1100)).await;
        // 端口仍可连，且数据仍能穿过重建后的隧道。
        assert_eq!(roundtrip(dialer_port, b"after").await, b"after");

        supervisor.apply(&[]).await;
        echo_task.abort();
    }

    /// 规则从期望集合移除后，reconcile 必须关掉监听并真正释放端口。
    #[tokio::test]
    async fn reconcile_closes_endpoints_removed_from_the_expected_set() {
        let (_dir, cert, key, _ca) = certs();
        let port = free_port();
        let mut supervisor = TunnelSupervisor::new();
        supervisor
            .apply(&[listener_spec("removed", port, &cert, &key)])
            .await;
        assert!(status_of(&supervisor, "removed").listening);
        assert!(
            TcpStream::connect(("127.0.0.1", port)).await.is_ok(),
            "监听中的端口必须可连"
        );

        // 模拟期望集合缩小：生产中由 apply 更新，这里直接改已保存的期望态，
        // 验证 reconcile 自己的清理分支（不依赖 apply 已经关过一遍）。
        supervisor.desired.clear();
        supervisor.reconcile().await;

        assert!(
            supervisor.running.is_empty(),
            "reconcile 必须关闭不在期望集合里的端点"
        );
        assert!(
            supervisor.status_handle().snapshot().is_empty(),
            "已移除的规则不能继续上报状态"
        );
        // 端口真正释放：同端口重新 bind 必须成功。
        let rebound = TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("reconcile 后端口必须已释放");
        drop(rebound);
    }

    /// 一条规则绑定失败时：状态有可读 error，其它规则照常监听且不被重建。
    #[tokio::test]
    async fn reconcile_records_a_bind_failure_without_affecting_other_rules() {
        let (_dir, cert, key, _ca) = certs();
        let occupied = TcpListener::bind("127.0.0.1:0").await.expect("占用端口");
        let occupied_port = occupied.local_addr().expect("读取占用端口").port();
        let good_port = free_port();
        let bad = listener_spec("bad", occupied_port, &cert, &key);
        let good = listener_spec("good", good_port, &cert, &key);

        let mut supervisor = TunnelSupervisor::new();
        supervisor.apply(&[bad, good]).await;

        let bad_status = status_of(&supervisor, "bad");
        assert!(!bad_status.listening, "{bad_status:?}");
        assert!(
            bad_status.error.contains("绑定失败") && bad_status.error.contains("bind failed"),
            "绑定失败的状态必须可读：{}",
            bad_status.error
        );
        assert!(status_of(&supervisor, "good").listening);

        let good_started = supervisor.running["good"].started_at;
        supervisor.reconcile().await;

        assert!(
            status_of(&supervisor, "good").listening,
            "坏规则不能影响其它规则"
        );
        assert_eq!(
            supervisor.running["good"].started_at, good_started,
            "对账不能重建已经健康的规则"
        );
        assert!(
            TcpStream::connect(("127.0.0.1", good_port)).await.is_ok(),
            "其它规则的端口必须仍可连"
        );
        assert!(
            status_of(&supervisor, "bad").error.contains("绑定失败"),
            "失败原因必须一直可读"
        );

        drop(occupied);
        supervisor.apply(&[]).await;
    }

    /// 「证书/配置文件缺失」与「绑定失败」必须在状态文案里可区分。
    #[tokio::test]
    async fn status_distinguishes_a_missing_certificate_from_a_bind_failure() {
        let (_dir, cert, key, _ca) = certs();
        let occupied = TcpListener::bind("127.0.0.1:0").await.expect("占用端口");
        let occupied_port = occupied.local_addr().expect("读取占用端口").port();

        let missing_cert = listener_spec_paths(
            "missing-cert",
            free_port(),
            "/nonexistent/tunnel-cert.pem",
            "/nonexistent/tunnel-key.pem",
        );
        let bad_bind = listener_spec("bad-bind", occupied_port, &cert, &key);

        let mut supervisor = TunnelSupervisor::new();
        supervisor.apply(&[missing_cert, bad_bind]).await;

        let missing = status_of(&supervisor, "missing-cert");
        assert!(!missing.listening, "{missing:?}");
        assert!(
            missing.error.contains("证书") && missing.error.contains("missing"),
            "证书缺失必须写明：{}",
            missing.error
        );
        assert!(
            !missing.error.contains("绑定失败") && !missing.error.contains("bind failed"),
            "证书缺失不能被报成绑定失败：{}",
            missing.error
        );

        let bind = status_of(&supervisor, "bad-bind");
        assert!(
            bind.error.contains("绑定失败") && bind.error.contains("bind failed"),
            "绑定失败必须写明：{}",
            bind.error
        );
        assert!(
            !bind.error.contains("证书") && !bind.error.contains("certificate"),
            "绑定失败不能被报成证书问题：{}",
            bind.error
        );

        drop(occupied);
        supervisor.apply(&[]).await;
    }

    /// TLS 规格缺证书路径：必须报「证书缺失」，不能悄悄退化成 Noise/明文。
    #[tokio::test]
    async fn tls_spec_with_empty_certificate_paths_reports_missing_certificate() {
        let mut spec = listener_spec_paths("tls-missing", free_port(), "", "");
        spec.tunnel.as_mut().expect("必须带 tunnel 段").security = TunnelSecurity::Tls;

        let mut supervisor = TunnelSupervisor::new();
        supervisor.apply(&[spec]).await;

        let status = status_of(&supervisor, "tls-missing");
        assert!(!status.listening, "{status:?}");
        assert!(
            status.error.contains("证书") && status.error.contains("missing"),
            "TLS 缺证书必须写明：{}",
            status.error
        );
        supervisor.apply(&[]).await;
    }

    /// Noise 规格：证书路径全空是合法状态，监听与回环都必须工作。
    #[tokio::test]
    async fn noise_specs_run_without_reading_certificate_paths() {
        let (echo_addr, echo_task) = spawn_echo().await;
        let listener_port = free_port();
        let dialer_port = free_port();
        let listener_addr: SocketAddr = format!("127.0.0.1:{listener_port}").parse().unwrap();
        let remote = format!("127.0.0.1:{listener_port}");
        let allowed = [listener_addr, echo_addr];

        let listener = noise_spec(
            "noise-listener",
            TunnelRole::Listener,
            listener_port,
            "",
            &[echo_addr],
        );
        let dialer = noise_spec(
            "noise-dialer",
            TunnelRole::Dialer,
            dialer_port,
            &remote,
            &allowed,
        );

        let mut supervisor = TunnelSupervisor::new();
        supervisor.apply(&[listener, dialer]).await;

        assert!(status_of(&supervisor, "noise-listener").listening);
        assert!(status_of(&supervisor, "noise-dialer").listening);
        assert_eq!(
            roundtrip(dialer_port, b"noise-payload").await,
            b"noise-payload",
            "Noise 模式必须能穿过隧道回环"
        );

        supervisor.apply(&[]).await;
        echo_task.abort();
    }

    /// 退避：连续失败时下一次允许重建的时间按 15s→30s→60s… 递增；
    /// 端口释放后到期重试成功，计数清零。
    #[tokio::test]
    async fn reconcile_backs_off_repeated_start_failures_and_resets_after_success() {
        let (_dir, cert, key, _ca) = certs();
        let occupied = TcpListener::bind("127.0.0.1:0").await.expect("占用端口");
        let port = occupied.local_addr().expect("读取占用端口").port();
        let rule = listener_spec("flaky", port, &cert, &key);

        let mut supervisor = TunnelSupervisor::new();
        supervisor.apply(&[rule]).await;

        let retry = supervisor
            .backoff
            .get("flaky")
            .expect("失败后必须有退避记录");
        assert_eq!(retry.failures, 1);
        let first_delay = retry
            .next_retry_at
            .saturating_duration_since(Instant::now());
        assert!(
            first_delay > Duration::from_secs(10) && first_delay <= RECONCILE_BASE_DELAY,
            "首次退避应是 15s，实际 {first_delay:?}"
        );

        // 退避未到期：再过一次心跳也不应重试（失败次数不累加）。
        supervisor.reconcile().await;
        assert_eq!(
            supervisor.backoff["flaky"].failures, 1,
            "退避未到期时不能每 15 秒重试一次"
        );

        // 模拟时间推进到退避到期：下一次失败的间隔必须递增。
        for (index, expected) in [30u64, 60, 120, 240, 300].into_iter().enumerate() {
            supervisor
                .backoff
                .get_mut("flaky")
                .expect("退避记录存在")
                .next_retry_at = Instant::now() - Duration::from_secs(1);
            supervisor.reconcile().await;
            let retry = &supervisor.backoff["flaky"];
            assert_eq!(
                retry.failures,
                index as u32 + 2,
                "每次到期重试失败都要累加连续失败次数"
            );
            let delay = retry
                .next_retry_at
                .saturating_duration_since(Instant::now());
            assert!(
                delay <= Duration::from_secs(expected) && delay > Duration::from_secs(expected - 2),
                "第 {} 次失败后退避应为 {expected}s，实际 {delay:?}",
                index + 2
            );
        }

        // 端口释放后，退避到期重试成功：端点重建、计数清零。
        drop(occupied);
        supervisor
            .backoff
            .get_mut("flaky")
            .expect("退避记录存在")
            .next_retry_at = Instant::now() - Duration::from_secs(1);
        supervisor.reconcile().await;
        assert!(
            supervisor.running.contains_key("flaky"),
            "端口释放后必须自愈"
        );
        assert!(
            !supervisor.backoff.contains_key("flaky"),
            "启动成功后必须重置退避"
        );
        assert!(status_of(&supervisor, "flaky").listening);

        supervisor.apply(&[]).await;
    }

    /// 幂等：任务都活着时，连续 reconcile / 重复 apply 都不重建、不泄漏任务。
    #[tokio::test]
    async fn reconcile_is_idempotent_and_does_not_duplicate_tasks() {
        let (_dir, cert, key, _ca) = certs();
        let port = free_port();
        let rule = listener_spec("idem", port, &cert, &key);

        let mut supervisor = TunnelSupervisor::new();
        supervisor.apply(std::slice::from_ref(&rule)).await;
        let bound = supervisor.bound_addr("idem").expect("监听必须成功");
        let started = supervisor.running["idem"].started_at;

        supervisor.reconcile().await;
        supervisor.reconcile().await;

        assert_eq!(supervisor.running.len(), 1, "不能泄漏重复任务");
        assert_eq!(
            supervisor.running["idem"].started_at, started,
            "reconcile 不能重建活着的任务"
        );
        assert_eq!(supervisor.running["idem"].bound_addr, bound);
        assert_eq!(supervisor.status_handle().snapshot().len(), 1);

        // 同一份期望态重复下发也必须是空 diff。
        supervisor.apply(std::slice::from_ref(&rule)).await;
        assert_eq!(supervisor.running.len(), 1);
        assert_eq!(
            supervisor.running["idem"].started_at, started,
            "重复 apply 不能重建监听"
        );
        assert!(status_of(&supervisor, "idem").listening);

        supervisor.apply(&[]).await;
        assert!(supervisor.running.is_empty());
    }

    /// 两端 tunnel + 本地 UDP echo：3 个数据报全部回显，出口 QUIC 计数对上。
    #[tokio::test]
    async fn udp_tunnel_echoes_three_datagrams_and_reports_quic_stats() {
        let echo = spawn_udp_echo().await;
        let (_dir, cert, key, ca) = certs();
        let listener_port = free_port();
        let dialer_port = free_port();
        let listener_addr: SocketAddr = format!("127.0.0.1:{listener_port}").parse().unwrap();
        let allowed = [listener_addr, echo.addr];

        let listener = with_tunnel_udp(listener_spec_allowed(
            "udp-listener",
            listener_port,
            &cert,
            &key,
            &[echo.addr],
        ));
        let dialer = with_tunnel_udp(dialer_spec(
            "udp-dialer",
            dialer_port,
            listener_port,
            &ca,
            &allowed,
        ));

        let mut supervisor = TunnelSupervisor::new();
        supervisor.apply(&[listener, dialer]).await;
        assert!(status_of(&supervisor, "udp-listener").listening);
        assert!(status_of(&supervisor, "udp-dialer").listening);

        let client = UdpSocket::bind("127.0.0.1:0").await.expect("客户端绑定");
        let dialer_addr: SocketAddr = format!("127.0.0.1:{dialer_port}").parse().unwrap();
        for payload in [b"first".as_slice(), b"second", b"third"] {
            assert_eq!(
                udp_roundtrip(&client, dialer_addr, payload).await,
                payload,
                "UDP 回显内容必须与发送一致"
            );
        }
        assert_eq!(
            echo.received.load(Ordering::Relaxed),
            3,
            "echo 必须真的收到 3 个包"
        );

        wait_until("出口 QUIC 计数到 3", || {
            supervisor
                .udp_stats("udp-listener")
                .and_then(|stats| stats.listener_snapshot())
                .is_some_and(|stats| stats.datagrams_in == 3 && stats.sessions == 1)
        })
        .await;

        let server = supervisor
            .udp_stats("udp-listener")
            .expect("UDP Listener 必须有计数句柄")
            .listener_snapshot()
            .expect("Listener 侧必须是 QUIC 计数");
        assert_eq!(server.datagrams_in, 3, "{server:?}");
        assert_eq!(server.datagrams_out, 3, "{server:?}");
        assert_eq!(server.sessions, 1, "一个本地客户端只能有一个服务端会话");
        assert_eq!(server.denied, 0, "{server:?}");

        let dialer_stats = supervisor
            .udp_stats("udp-dialer")
            .expect("UDP Dialer 必须有计数句柄")
            .dialer_snapshot()
            .expect("Dialer 侧必须是本地会话计数");
        assert_eq!(dialer_stats.datagrams_in, 3, "{dialer_stats:?}");
        assert_eq!(dialer_stats.datagrams_out, 3, "{dialer_stats:?}");
        assert_eq!(dialer_stats.sessions, 1, "{dialer_stats:?}");
        println!("[udp tunnel] server={server:?} dialer={dialer_stats:?}");

        supervisor.apply(&[]).await;
    }

    /// 两个不同源地址的本地客户端各自一条 QUIC 连接、各自一个会话，互不串包。
    #[tokio::test]
    async fn two_udp_clients_get_separate_sessions_and_replies() {
        let echo = spawn_udp_echo().await;
        let (_dir, cert, key, ca) = certs();
        let listener_port = free_port();
        let dialer_port = free_port();
        let listener_addr: SocketAddr = format!("127.0.0.1:{listener_port}").parse().unwrap();
        let allowed = [listener_addr, echo.addr];

        let listener = with_tunnel_udp(listener_spec_allowed(
            "udp2-listener",
            listener_port,
            &cert,
            &key,
            &[echo.addr],
        ));
        let dialer = with_tunnel_udp(dialer_spec(
            "udp2-dialer",
            dialer_port,
            listener_port,
            &ca,
            &allowed,
        ));

        let mut supervisor = TunnelSupervisor::new();
        supervisor.apply(&[listener, dialer]).await;

        let client_a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let client_b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let dialer_addr: SocketAddr = format!("127.0.0.1:{dialer_port}").parse().unwrap();

        // 先各发一个包（两个 QUIC 连接），再同时收；回包必须回到各自的 socket。
        client_a.send_to(b"alpha-1", dialer_addr).await.unwrap();
        client_b.send_to(b"beta-1", dialer_addr).await.unwrap();
        let mut buf = [0u8; 512];
        let (size, _) = timeout(Duration::from_secs(5), client_a.recv_from(&mut buf))
            .await
            .expect("客户端 A 回包超时")
            .unwrap();
        assert_eq!(&buf[..size], b"alpha-1", "客户端 A 不能收到 B 的回包");
        let (size, _) = timeout(Duration::from_secs(5), client_b.recv_from(&mut buf))
            .await
            .expect("客户端 B 回包超时")
            .unwrap();
        assert_eq!(&buf[..size], b"beta-1", "客户端 B 不能收到 A 的回包");

        // 各自继续发包，仍然回到自己。
        assert_eq!(
            udp_roundtrip(&client_a, dialer_addr, b"alpha-2").await,
            b"alpha-2"
        );
        assert_eq!(
            udp_roundtrip(&client_b, dialer_addr, b"beta-2").await,
            b"beta-2"
        );

        wait_until("两个客户端各自一个会话", || {
            let server = supervisor
                .udp_stats("udp2-listener")
                .and_then(|stats| stats.listener_snapshot());
            let dialer = supervisor
                .udp_stats("udp2-dialer")
                .and_then(|stats| stats.dialer_snapshot());
            server.is_some_and(|stats| stats.sessions == 2)
                && dialer.is_some_and(|stats| stats.sessions == 2)
        })
        .await;

        let server = supervisor
            .udp_stats("udp2-listener")
            .unwrap()
            .listener_snapshot()
            .unwrap();
        let dialer_stats = supervisor
            .udp_stats("udp2-dialer")
            .unwrap()
            .dialer_snapshot()
            .unwrap();
        assert_eq!(
            server.sessions, 2,
            "两个本地客户端 → 两条 QUIC 连接：{server:?}"
        );
        assert_eq!(server.datagrams_in, 4, "{server:?}");
        assert_eq!(server.datagrams_out, 4, "{server:?}");
        assert_eq!(
            dialer_stats.sessions, 2,
            "入口侧也必须各有一个会话：{dialer_stats:?}"
        );
        println!("[udp two clients] server={server:?} dialer={dialer_stats:?}");

        supervisor.apply(&[]).await;
    }

    /// 白名单外的目标：出口 `denied` 增加、echo 收包为 0、客户端拿不到回包。
    #[tokio::test]
    async fn udp_tunnel_denies_targets_outside_the_chain_whitelist() {
        let allowed_echo = spawn_udp_echo().await;
        let denied_echo = spawn_udp_echo().await;
        let (_dir, cert, key, ca) = certs();
        let listener_port = free_port();
        let dialer_port = free_port();
        let listener_addr: SocketAddr = format!("127.0.0.1:{listener_port}").parse().unwrap();
        // Dialer 的链目标是 denied_echo；Listener 只允许 allowed_echo。
        let allowed = [listener_addr, denied_echo.addr];

        let listener = with_tunnel_udp(listener_spec_allowed(
            "deny-listener",
            listener_port,
            &cert,
            &key,
            &[allowed_echo.addr],
        ));
        let dialer = with_tunnel_udp(dialer_spec(
            "deny-dialer",
            dialer_port,
            listener_port,
            &ca,
            &allowed,
        ));

        let mut supervisor = TunnelSupervisor::new();
        supervisor.apply(&[listener, dialer]).await;

        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let dialer_addr: SocketAddr = format!("127.0.0.1:{dialer_port}").parse().unwrap();
        client
            .send_to(b"must-not-arrive", dialer_addr)
            .await
            .unwrap();

        wait_until("出口拒绝计数到 1", || {
            supervisor
                .udp_stats("deny-listener")
                .and_then(|stats| stats.listener_snapshot())
                .is_some_and(|stats| stats.denied >= 1)
        })
        .await;

        // 被拒绝的目标不能产生回包。
        let mut buf = [0u8; 256];
        let no_reply = timeout(Duration::from_millis(400), client.recv_from(&mut buf)).await;
        assert!(no_reply.is_err(), "白名单外的目标不能有回包");

        let server = supervisor
            .udp_stats("deny-listener")
            .unwrap()
            .listener_snapshot()
            .unwrap();
        assert_eq!(server.denied, 1, "每个被拒绝的数据报都要计数：{server:?}");
        assert_eq!(server.sessions, 0, "拒绝时不能建服务端会话：{server:?}");
        assert_eq!(server.datagrams_out, 0, "{server:?}");
        assert_eq!(
            allowed_echo.received.load(Ordering::Relaxed),
            0,
            "白名单内的 echo 也不能收到包"
        );
        assert_eq!(
            denied_echo.received.load(Ordering::Relaxed),
            0,
            "白名单外的 echo 收包计数必须为 0"
        );
        println!(
            "[udp deny] denied={} sessions={} denied_echo_received={}",
            server.denied,
            server.sessions,
            denied_echo.received.load(Ordering::Relaxed)
        );

        supervisor.apply(&[]).await;
    }

    #[test]
    fn retry_delay_doubles_from_15s_and_caps_at_5_minutes() {
        let delays: Vec<u64> = (1..=8)
            .map(|failures| retry_delay(failures).as_secs())
            .collect();
        assert_eq!(delays, [15, 30, 60, 120, 240, 300, 300, 300]);
    }
}
