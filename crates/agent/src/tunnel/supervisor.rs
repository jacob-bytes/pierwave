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

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use pierwave_proto::{DesiredForward, ForwardEngine, ForwardStatus, TunnelRole, TunnelSpec};
use rustls::pki_types::ServerName;
use tokio::net::{lookup_host, TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::timeout;

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

/// 一个正在运行的 tunnel 端点。
struct RunningTunnel {
    spec: TunnelSpec,
    task: JoinHandle<()>,
    /// Listener 才有；心跳/测试用。
    stats: Option<TunnelStatsHandle>,
    /// 实际绑定地址（`listen` 写端口 0 时由内核分配）。
    bound_addr: SocketAddr,
}

impl RunningTunnel {
    async fn close(self, id: &str) {
        self.task.abort();
        let _ = timeout(SHUTDOWN_TIMEOUT, self.task).await;
        if let Some(stats) = self.stats {
            let snapshot = stats.snapshot();
            tracing::info!(
                %id,
                bound_addr = %self.bound_addr,
                total = snapshot.total,
                rejected = snapshot.rejected,
                denied = snapshot.denied,
                "隧道端点已停止 / tunnel endpoint stopped"
            );
        }
    }
}

/// 隧道收敛器。
pub struct TunnelSupervisor {
    running: HashMap<String, RunningTunnel>,
    failed: HashMap<String, String>,
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

    /// 收敛到期望列表。只处理 `engine = tunnel` 的规则。
    pub async fn apply(&mut self, desired: &[DesiredForward]) {
        let mut wanted: Vec<&DesiredForward> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for spec in desired {
            if spec.engine != ForwardEngine::Tunnel {
                continue;
            }
            if !seen.insert(spec.id.as_str()) {
                tracing::warn!(id = %spec.id, "期望态里有重复的 tunnel id，忽略后一条");
                continue;
            }
            wanted.push(spec);
        }

        // 1. 关掉已删除或参数变化的端点。先释放端口，再绑定新端口。
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
        self.failed
            .retain(|id, _| wanted.iter().any(|spec| &spec.id == id));

        // 2. 启动新增/变化的端点。失败只记录状态，下一轮重试。
        for spec in &wanted {
            if self.running.contains_key(&spec.id) {
                continue;
            }
            match start_endpoint(spec).await {
                Ok((spec_tunnel, task, stats, bound_addr)) => {
                    tracing::info!(
                        id = %spec.id,
                        role = ?spec_tunnel.role,
                        listen = %spec_tunnel.listen,
                        remote = %spec_tunnel.remote,
                        "隧道端点已启动 / tunnel endpoint started"
                    );
                    self.failed.remove(&spec.id);
                    self.running.insert(
                        spec.id.clone(),
                        RunningTunnel {
                            spec: spec_tunnel,
                            task,
                            stats,
                            bound_addr,
                        },
                    );
                }
                Err(error) => {
                    let reason = format!("{error:#}");
                    tracing::warn!(id = %spec.id, %reason, "隧道端点启动失败 / tunnel endpoint failed to start");
                    self.failed.insert(spec.id.clone(), reason);
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

type Started = (
    TunnelSpec,
    JoinHandle<()>,
    Option<TunnelStatsHandle>,
    SocketAddr,
);

async fn start_endpoint(spec: &DesiredForward) -> Result<Started> {
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
            let mut config = TunnelServerConfig::new(
                bind,
                tunnel.cert_pem_path.clone(),
                tunnel.key_pem_path.clone(),
                hops,
            );
            config.max_connections = crate::tunnel::DEFAULT_MAX_CONNECTIONS;
            config.allowed_targets = allowed_targets;
            let (server, listener) = TunnelServer::bind(config).await?;
            let bound_addr = listener.local_addr().context("读取隧道监听地址失败")?;
            let stats = server.stats_handle();
            let task = tokio::spawn(async move {
                if let Err(error) = server.serve(listener).await {
                    tracing::error!(error = %error, "隧道 Listener 退出 / tunnel listener exited");
                }
            });
            Ok((tunnel, task, Some(stats), bound_addr))
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
            let ca_path = tunnel.ca_pem_path.clone();
            let client = TunnelClient::trusting_ca_file(
                remote,
                server_name,
                tunnel.hop_id.clone(),
                secret,
                std::path::Path::new(&ca_path),
            )?;
            let listener = TcpListener::bind(bind).await.with_context(|| {
                format!("绑定隧道入口 {bind} 失败 / failed to bind tunnel dialer")
            })?;
            let bound_addr = listener.local_addr().context("读取隧道入口地址失败")?;
            let client = Arc::new(client);
            let id = spec.id.clone();
            let task = tokio::spawn(async move {
                dialer_accept_loop(id, listener, client, target, bound_addr).await;
            });
            Ok((tunnel, task, None, bound_addr))
        }
    }
}

fn validate_spec(spec: &TunnelSpec) -> Result<()> {
    if spec.hop_id.trim().is_empty() || spec.hop_id.len() > 255 {
        bail!("hop_id 长度非法（1..=255）/ invalid hop_id length (1..=255)");
    }
    match spec.role {
        TunnelRole::Listener => {
            if spec.cert_pem_path.trim().is_empty() || spec.key_pem_path.trim().is_empty() {
                bail!("Listener 缺少 cert_pem_path/key_pem_path / listener is missing certificate paths");
            }
        }
        TunnelRole::Dialer => {
            if spec.remote.trim().is_empty() {
                bail!("Dialer 缺少 remote / dialer is missing remote address");
            }
            if spec.ca_pem_path.trim().is_empty() {
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
