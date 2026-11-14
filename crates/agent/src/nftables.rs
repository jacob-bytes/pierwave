//! nftables 引擎：把 `engine == nftables` 的转发规则收敛到一张自有 NAT 表。
//!
//! 数据路径完全在内核：`prerouting` / `output` 两条 nat 链按监听端口做 DNAT，
//! 不经过用户态搬运，也不需要为每条规则开 socket。表名固定为 `inet pierwave`；
//! 每次 apply 只重建这一张表，绝不触碰系统里的其它 nftables 表。
//!
//! 当前只支持单目标（`targets` 为空或只有一个）。多成员组的选路需要
//! `jhash`/map 语法，留到后续在真实 Linux 上验证后再加；主控写路径已经拒绝
//! nftables 链的非入口多成员组。
//!
//! 能力判定：`nft list tables` 必须成功（二进制存在 + CAP_NET_ADMIN）。
//! 失败时所有 nftables 规则上报 `listening=false`，native / realm 规则不受影响。

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pierwave_proto::{DesiredForward, ForwardEngine, ForwardStatus};

/// 默认的 nft 可执行文件；安装脚本不打包 nft，使用发行版包管理器安装。
pub const DEFAULT_BIN: &str = "nft";

/// 自有表名；删除时只删这一张表。
pub const TABLE: &str = "pierwave";

/// 状态脚本文件名，落在 Agent 的 state_dir 下，便于排障时直接看生成内容。
pub const SCRIPT_FILE_NAME: &str = "nftables.nft";

/// 没有可用的 nft / 权限时，每条 nftables 规则的错误原文。
pub const NOT_AVAILABLE: &str = "nftables 不可用（需要安装 nft 并以 root 运行）";

/// 多目标（组内选路）暂不支持时的错误原文。
pub const MULTI_TARGET_UNSUPPORTED: &str = "nftables 暂不支持多目标选路";

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const ERROR_LIMIT: usize = 500;

/// 心跳可无锁读取的 nftables 规则状态快照。
#[derive(Debug, Clone, Default)]
pub struct NftablesStatusHandle {
    inner: Arc<Mutex<NftablesStatusState>>,
}

#[derive(Debug, Clone, Default)]
struct NftablesStatusState {
    statuses: Vec<ForwardStatus>,
    /// 规则 id → (入方向字节, 出方向字节)。nftables 没有反向计数器，
    /// 所以永远只填入方向；出方向保持 None（不是 0）。
    traffic: HashMap<String, (Option<u64>, Option<u64>)>,
}

impl NftablesStatusHandle {
    pub fn snapshot(&self) -> Vec<ForwardStatus> {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut statuses = state.statuses.clone();
        for status in &mut statuses {
            if let Some((inbound, outbound)) = state.traffic.get(&status.id) {
                status.traffic_in = *inbound;
                status.traffic_out = *outbound;
            }
        }
        statuses
    }

    /// 表被重建/删除后旧计数器作废，状态与流量一起重置。
    fn store(&self, statuses: Vec<ForwardStatus>) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.statuses = statuses;
        state.traffic.clear();
    }

    fn store_traffic(&self, traffic: HashMap<String, (Option<u64>, Option<u64>)>) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.traffic = traffic;
    }
}

/// 退出时的清理句柄：信号处理任务只持有 nft 路径，不借用 supervisor。
#[derive(Debug, Clone)]
pub struct NftablesCleanup {
    bin: PathBuf,
}

impl NftablesCleanup {
    /// 同步删除自有表；表不存在、nft 不存在都只记日志。
    pub fn cleanup(&self) {
        let _ = std::process::Command::new(&self.bin)
            .args(["delete", "table", "inet", TABLE])
            .stdin(Stdio::null())
            .output();
    }
}

/// nftables 引擎的收敛器；生命周期与 native / realm 一样跨 websocket 重连保留。
pub struct NftablesSupervisor {
    bin: PathBuf,
    script_path: PathBuf,
    bind_host: String,
    /// 最近一次期望态（按 listen_port/id 排序）；reconcile 重新落盘时使用。
    rules: Vec<DesiredForward>,
    status: NftablesStatusHandle,
    /// 上次 apply 有规则级失败（DNS/多目标）时为 true；reconcile 会重试。
    needs_retry: bool,
}

impl NftablesSupervisor {
    pub fn new(
        bin: impl Into<PathBuf>,
        state_dir: impl Into<PathBuf>,
        bind_host: impl Into<String>,
    ) -> Self {
        let bind_host = bind_host.into();
        let bind_host = if bind_host.trim().is_empty() {
            "0.0.0.0".to_string()
        } else {
            bind_host
        };
        Self {
            bin: bin.into(),
            script_path: state_dir.into().join(SCRIPT_FILE_NAME),
            bind_host,
            rules: Vec::new(),
            status: NftablesStatusHandle::default(),
            needs_retry: false,
        }
    }

    pub fn status_handle(&self) -> NftablesStatusHandle {
        self.status.clone()
    }

    pub fn cleanup_handle(&self) -> NftablesCleanup {
        NftablesCleanup {
            bin: self.bin.clone(),
        }
    }

    /// 心跳能力上报：`nft list tables` 成功才算可用。
    pub fn available(&self) -> bool {
        is_available(&self.bin)
    }

    /// 收敛到期望列表。非 nftables 规则会被忽略（分流在调用方做，这里防御一次）。
    pub async fn apply(&mut self, desired: &[DesiredForward]) {
        let mut seen = HashSet::new();
        let mut rules: Vec<DesiredForward> = desired
            .iter()
            .filter(|spec| spec.engine == ForwardEngine::Nftables)
            .filter(|spec| seen.insert(spec.id.clone()))
            .cloned()
            .collect();
        rules.sort_by(|a, b| {
            a.listen_port
                .cmp(&b.listen_port)
                .then_with(|| a.id.cmp(&b.id))
        });
        self.rules = rules;

        if self.rules.is_empty() {
            self.cleanup().await;
            self.status.store(Vec::new());
            return;
        }

        if !self.available() {
            tracing::warn!(
                bin = %self.bin.display(),
                "nftables 不可用，nftables 规则保持未监听（native / realm 不受影响）"
            );
            self.needs_retry = true;
            self.status
                .store(self.inactive_statuses(NOT_AVAILABLE, &self.rules));
            return;
        }

        let mut resolved: Vec<(DesiredForward, SocketAddr)> = Vec::new();
        let mut errors: HashMap<String, String> = HashMap::new();
        for rule in &self.rules {
            match resolve_target(rule).await {
                Ok(addr) => resolved.push((rule.clone(), addr)),
                Err(error) => {
                    errors.insert(rule.id.clone(), error);
                }
            }
        }

        if resolved.is_empty() {
            self.cleanup().await;
            self.needs_retry = true;
            self.status.store(
                self.rules
                    .iter()
                    .map(|rule| ForwardStatus {
                        id: rule.id.clone(),
                        listening: false,
                        error: errors
                            .get(&rule.id)
                            .cloned()
                            .unwrap_or_else(|| "没有可下发的 nftables 规则".to_string()),
                        target_ok: None,
                        target_error: None,
                        targets: Vec::new(),
                        traffic_in: None,
                        traffic_out: None,
                    })
                    .collect(),
            );
            return;
        }

        let script = render_script(&resolved, &self.bind_host);
        let table_exists = table_exists(&self.bin).await;
        let mut batch = String::new();
        if table_exists {
            batch.push_str(&format!("delete table inet {TABLE}\n"));
        }
        batch.push_str(&script);
        if let Err(error) = write_script(&self.script_path, &batch) {
            let reason = format!("写入 nftables 脚本失败：{error}");
            self.needs_retry = true;
            self.status
                .store(self.inactive_statuses(&reason, &self.rules));
            return;
        }

        match run_nft(&self.bin, &["-f", &self.script_path.to_string_lossy()]).await {
            Ok(()) => {
                self.needs_retry = !errors.is_empty();
                let statuses = self
                    .rules
                    .iter()
                    .map(|rule| match errors.get(&rule.id) {
                        Some(error) => ForwardStatus {
                            id: rule.id.clone(),
                            listening: false,
                            error: error.clone(),
                            target_ok: None,
                            target_error: None,
                            targets: Vec::new(),
                            traffic_in: None,
                            traffic_out: None,
                        },
                        None => ForwardStatus {
                            id: rule.id.clone(),
                            listening: true,
                            error: String::new(),
                            target_ok: None,
                            target_error: None,
                            targets: Vec::new(),
                            traffic_in: None,
                            traffic_out: None,
                        },
                    })
                    .collect();
                self.status.store(statuses);
                // 表刚重建，counter 归零；立刻读一轮，心跳不必等下一轮。
                self.refresh_traffic().await;
            }
            Err(error) => {
                tracing::error!(
                    bin = %self.bin.display(),
                    %error,
                    "nftables 表下发失败"
                );
                self.needs_retry = true;
                self.status
                    .store(self.inactive_statuses(&error, &self.rules));
            }
        }
    }

    /// 心跳对账：表被 flush / 进程重启后重新落盘，不依赖主控重发期望态。
    pub async fn reconcile(&mut self) {
        if self.rules.is_empty() {
            return;
        }
        if !self.available() {
            let rules = self.rules.clone();
            self.status
                .store(self.inactive_statuses(NOT_AVAILABLE, &rules));
            return;
        }
        if self.needs_retry || !table_exists(&self.bin).await {
            let rules = self.rules.clone();
            self.apply(&rules).await;
        } else {
            // 表没变也要读一次 counter：流量持续增长，心跳必须看到最新值。
            self.refresh_traffic().await;
        }
    }

    /// 读 `nft -j list table inet pierwave` 的计数器并写回状态句柄。
    ///
    /// 失败只记 debug/warn 并保留上一轮的值：nft 短暂失败不应该让面板上的
    /// 流量突然变成 null。表被重建时 `store` 已经先清空流量。
    async fn refresh_traffic(&self) {
        if self.rules.is_empty() {
            self.status.store_traffic(HashMap::new());
            return;
        }
        let output = match run_nft_capture(&self.bin, &["-j", "list", "table", "inet", TABLE]).await
        {
            Ok(output) => output,
            Err(error) => {
                tracing::debug!(bin = %self.bin.display(), %error, "读取 nftables 计数器失败");
                return;
            }
        };
        let counters = match parse_counters(&output) {
            Ok(counters) => counters,
            Err(error) => {
                tracing::warn!(bin = %self.bin.display(), %error, "解析 nftables 计数器失败");
                return;
            }
        };
        let mut traffic = HashMap::with_capacity(self.rules.len());
        for rule in &self.rules {
            let protocol = rule.effective_protocol();
            let tcp = protocol
                .allows_tcp()
                .then(|| {
                    counters
                        .get(&(rule.listen_port, "tcp".to_string()))
                        .copied()
                })
                .flatten();
            let udp = protocol
                .allows_udp()
                .then(|| {
                    counters
                        .get(&(rule.listen_port, "udp".to_string()))
                        .copied()
                })
                .flatten();
            let inbound = match (tcp, udp) {
                (None, None) => None,
                (tcp, udp) => Some(tcp.unwrap_or(0) + udp.unwrap_or(0)),
            };
            if let Some(inbound) = inbound {
                // DNAT 规则只看到客户端 → 目标方向，出方向没有数据源。
                traffic.insert(rule.id.clone(), (Some(inbound), None));
            }
        }
        self.status.store_traffic(traffic);
    }

    async fn cleanup(&mut self) {
        if self.bin.exists() {
            let _ = run_nft(&self.bin, &["delete", "table", "inet", TABLE]).await;
        }
        self.needs_retry = false;
    }

    fn inactive_statuses(&self, reason: &str, rules: &[DesiredForward]) -> Vec<ForwardStatus> {
        rules
            .iter()
            .map(|rule| ForwardStatus {
                id: rule.id.clone(),
                listening: false,
                error: reason.to_string(),
                target_ok: None,
                target_error: None,
                targets: Vec::new(),
                traffic_in: None,
                traffic_out: None,
            })
            .collect()
    }
}

/// `nft` 路径是否可用：必须是可执行文件，且 `nft list tables` 成功。
///
/// `list tables` 不需要 root 吗？读表本身受 CAP_NET_ADMIN 限制；成功就说明
/// 进程确实有权限，这比只看文件存在更准确。
pub fn is_available(bin: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(bin) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    std::process::Command::new(bin)
        .args(["list", "tables"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// 纯脚本生成：`resolved` 是「规则 + 已解析目标」，顺序由调用方保证。
///
/// 生成的规则同时放进 `prerouting`（外部入站）和 `output`（本机发起）两条链；
/// 用 `fib daddr type local` 限定目的地址是本机，避免把本机访问外网的普通连接
/// 也 DNAT 掉。指定了具体 `forward_bind` 时改用 `ip daddr` / `ip6 daddr`。
pub fn render_script(rules: &[(DesiredForward, SocketAddr)], bind_host: &str) -> String {
    let mut lines = vec![format!("table inet {TABLE} {{")];
    for (chain, hook, priority) in [
        ("prerouting", "prerouting", "dstnat"),
        ("output", "output", "-100"),
    ] {
        lines.push(format!("    chain {chain} {{"));
        lines.push(format!(
            "        type nat hook {hook} priority {priority}; policy accept;"
        ));
        for (rule, target) in rules {
            // 规则自带 listen_host 时只匹配该网卡地址；没有时退回全局 bind_host。
            let bind = rule
                .listen_host
                .as_deref()
                .map(str::trim)
                .filter(|host| !host.is_empty())
                .unwrap_or(bind_host)
                .trim();
            let matcher = daddr_matcher(bind);
            let dnat = match target.ip() {
                IpAddr::V4(_) => format!("dnat ip to {}:{}", target.ip(), target.port()),
                IpAddr::V6(_) => format!("dnat ip6 to [{}]:{}", target.ip(), target.port()),
            };
            // 读路径以 protocol 为准；旧主控的 udp=true 由 effective_protocol
            // 还原成 both。只生成所选协议的规则：仅 UDP 时不能留下 tcp dnat。
            let protocol = rule.effective_protocol();
            // `counter` 必须在 dnat 之前：这样每条规则都会累计命中字节，
            // 心跳用 `nft -j list table` 读回（nft 默认不计数）。
            if protocol.allows_tcp() {
                lines.push(format!(
                    "        {matcher} tcp dport {} counter {dnat}",
                    rule.listen_port
                ));
            }
            if protocol.allows_udp() {
                lines.push(format!(
                    "        {matcher} udp dport {} counter {dnat}",
                    rule.listen_port
                ));
            }
        }
        lines.push("    }".to_string());
    }
    lines.push("}".to_string());
    lines.join("\n") + "\n"
}

/// 监听地址 → nft `daddr` 匹配串。未指定 / `0.0.0.0` 时匹配「本机地址」。
fn daddr_matcher(bind: &str) -> String {
    match bind.parse::<IpAddr>() {
        Ok(IpAddr::V4(addr)) if !addr.is_unspecified() => format!("ip daddr {addr}"),
        Ok(IpAddr::V6(addr)) if !addr.is_unspecified() => format!("ip6 daddr {addr}"),
        _ => "fib daddr type local".to_string(),
    }
}

/// 解析一条规则的唯一目标。
///
/// 单成员组 / 独立转发走 `target_host:target_port`；主控已经拒绝 nftables 的
/// 多成员组，这里防御一次，避免生成「只选第一个成员」的静默错误。
pub async fn resolve_target(rule: &DesiredForward) -> Result<SocketAddr, String> {
    if rule.targets.len() > 1 {
        return Err(MULTI_TARGET_UNSUPPORTED.to_string());
    }
    let (host, port) = match rule.targets.first() {
        Some(target) => (target.host.as_str(), target.port),
        None => (rule.target_host.as_str(), rule.target_port),
    };
    let port = u16::try_from(port).map_err(|_| format!("目标端口不合法：{port}"))?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }
    let mut resolved = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("解析目标 {host}:{port} 失败：{error}"))?;
    resolved
        .next()
        .ok_or_else(|| format!("目标 {host}:{port} 没有解析结果"))
}

async fn run_nft(bin: &Path, args: &[&str]) -> Result<(), String> {
    run_nft_capture(bin, args).await.map(|_| ())
}

/// 执行 nft 并返回 stdout（解析 `-j list table` 的计数器用）。
async fn run_nft_capture(bin: &Path, args: &[&str]) -> Result<String, String> {
    let output = tokio::time::timeout(
        COMMAND_TIMEOUT,
        tokio::process::Command::new(bin)
            .args(args)
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| format!("nft {} 超时", args.join(" ")))?
    .map_err(|error| format!("执行 nft 失败：{error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text: String = stderr.trim().chars().take(ERROR_LIMIT).collect();
    Err(format!("nft {} 失败：{text}", args.join(" ")))
}

/// 解析 `nft -j list table inet pierwave` 里每条 dnat 规则的 counter。
///
/// 返回 `(listen_port, "tcp"/"udp") -> bytes`，同一端口的两条链
/// （prerouting / output）与同一协议的多条规则累加。只统计同时带
/// `dnat` 与 `counter` 的规则；其它规则（用户手改的表等）一律忽略。
pub fn parse_counters(raw: &str) -> Result<HashMap<(i64, String), u64>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|error| format!("nft JSON 解析失败：{error}"))?;
    let items = value
        .get("nftables")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "nft JSON 缺少 nftables 数组".to_string())?;
    let mut totals: HashMap<(i64, String), u64> = HashMap::new();
    for item in items {
        let Some(exprs) = item
            .get("rule")
            .and_then(|rule| rule.get("expr"))
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        if !exprs.iter().any(|expr| expr.get("dnat").is_some()) {
            continue;
        }
        let mut protocol: Option<String> = None;
        let mut port: Option<i64> = None;
        for expr in exprs {
            let Some(payload) = expr.pointer("/match/left/payload") else {
                continue;
            };
            let proto = payload.get("protocol").and_then(serde_json::Value::as_str);
            let field = payload.get("field").and_then(serde_json::Value::as_str);
            if field != Some("dport") || !matches!(proto, Some("tcp" | "udp")) {
                continue;
            }
            let Some(value) = expr
                .pointer("/match/right")
                .and_then(serde_json::Value::as_i64)
            else {
                continue;
            };
            protocol = proto.map(str::to_string);
            port = Some(value);
        }
        let (Some(protocol), Some(port)) = (protocol, port) else {
            continue;
        };
        let bytes: u64 = exprs
            .iter()
            .filter_map(|expr| expr.get("counter"))
            .filter_map(|counter| counter.get("bytes"))
            .filter_map(serde_json::Value::as_u64)
            .sum();
        if bytes > 0 || exprs.iter().any(|expr| expr.get("counter").is_some()) {
            *totals.entry((port, protocol)).or_default() += bytes;
        }
    }
    Ok(totals)
}

async fn table_exists(bin: &Path) -> bool {
    run_nft(bin, &["list", "table", "inet", TABLE])
        .await
        .is_ok()
}

fn write_script(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("nft.new");
    std::fs::write(&tmp, content)?;
    std::fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pierwave_proto::{ForwardStrategy, ForwardTarget};

    fn rule(id: &str, port: i64, host: &str, target_port: i64) -> DesiredForward {
        DesiredForward {
            id: id.into(),
            listen_port: port,
            target_host: host.into(),
            target_port,
            targets: Vec::new(),
            strategy: ForwardStrategy::RoundRobin,
            engine: ForwardEngine::Nftables,
            protocol: pierwave_proto::ForwardProtocol::Both,
            udp: true,
            listen_transport: None,
            remote_transport: None,
            disable_udp: false,
            listen_host: None,
            tunnel: None,
        }
    }

    #[test]
    fn renders_ipv4_rules_for_both_chains_and_protocols() {
        let script = render_script(
            &[(
                rule("f1", 8080, "1.2.3.4", 80),
                "1.2.3.4:80".parse().unwrap(),
            )],
            "0.0.0.0",
        );
        assert!(script.contains("table inet pierwave {"), "{script}");
        assert!(script.contains("type nat hook prerouting priority dstnat; policy accept;"));
        assert!(script.contains("type nat hook output priority -100; policy accept;"));
        assert!(
            script.contains("fib daddr type local tcp dport 8080 counter dnat ip to 1.2.3.4:80")
        );
        assert!(
            script.contains("fib daddr type local udp dport 8080 counter dnat ip to 1.2.3.4:80")
        );
        assert_eq!(
            script
                .matches("fib daddr type local tcp dport 8080")
                .count(),
            2,
            "prerouting 与 output 各一条"
        );
    }

    #[test]
    fn renders_ipv6_targets_and_specific_bind_address() {
        let script = render_script(
            &[(
                rule("f1", 8443, "2001:db8::1", 443),
                "[2001:db8::1]:443".parse().unwrap(),
            )],
            "10.0.0.5",
        );
        assert!(
            script
                .contains("ip daddr 10.0.0.5 tcp dport 8443 counter dnat ip6 to [2001:db8::1]:443"),
            "{script}"
        );
        assert!(script.contains("ip daddr 10.0.0.5 udp dport 8443"));
        assert!(!script.contains("fib daddr type local"), "{script}");
    }

    #[test]
    fn omits_udp_when_the_rule_does_not_enable_it() {
        let mut spec = rule("f1", 8080, "1.2.3.4", 80);
        spec.protocol = pierwave_proto::ForwardProtocol::Tcp;
        spec.udp = false;
        let script = render_script(&[(spec, "1.2.3.4:80".parse().unwrap())], "0.0.0.0");
        assert!(script.contains("tcp dport 8080"));
        assert!(!script.contains("udp dport 8080"), "{script}");
    }

    #[test]
    fn udp_only_rule_renders_only_udp_dnat() {
        let mut spec = rule("f1", 8080, "1.2.3.4", 80);
        spec.protocol = pierwave_proto::ForwardProtocol::Udp;
        spec.udp = false;
        let script = render_script(&[(spec, "1.2.3.4:80".parse().unwrap())], "0.0.0.0");
        assert!(
            script.contains("udp dport 8080 counter dnat ip to 1.2.3.4:80"),
            "{script}"
        );
        assert!(
            !script.contains("tcp dport 8080"),
            "仅 UDP 模式不能生成 tcp dnat：{script}"
        );
    }

    #[test]
    fn both_protocol_renders_one_dnat_per_protocol() {
        let mut spec = rule("f1", 8080, "1.2.3.4", 80);
        spec.protocol = pierwave_proto::ForwardProtocol::Both;
        spec.udp = true;
        let script = render_script(&[(spec, "1.2.3.4:80".parse().unwrap())], "0.0.0.0");
        for protocol in ["tcp", "udp"] {
            assert_eq!(
                script.matches(&format!("{protocol} dport 8080")).count(),
                2,
                "prerouting 与 output 各一条 {protocol}：{script}"
            );
        }
    }

    /// nft -j 的真实形状：每个 rule 的 expr 里含 match(payload dport) +
    /// counter + dnat。同一端口在两条链里的计数要累加，非 dnat 规则忽略。
    #[test]
    fn parses_dnat_counters_per_port_and_protocol() {
        let raw = r#"{"nftables":[
            {"metainfo":{"version":"1.0.9","release_name":"x"}},
            {"table":{"family":"inet","name":"pierwave"}},
            {"chain":{"family":"inet","table":"pierwave","name":"prerouting","type":"nat"}},
            {"rule":{"family":"inet","table":"pierwave","chain":"prerouting","expr":[
                {"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":8080}},
                {"counter":{"packets":10,"bytes":1000}},
                {"dnat":{"addr":"1.2.3.4","port":80}}
            ]}},
            {"rule":{"family":"inet","table":"pierwave","chain":"prerouting","expr":[
                {"match":{"op":"==","left":{"payload":{"protocol":"udp","field":"dport"}},"right":8080}},
                {"counter":{"packets":2,"bytes":200}},
                {"dnat":{"addr":"1.2.3.4","port":80}}
            ]}},
            {"rule":{"family":"inet","table":"pierwave","chain":"output","expr":[
                {"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":8080}},
                {"counter":{"packets":1,"bytes":50}},
                {"dnat":{"addr":"1.2.3.4","port":80}}
            ]}},
            {"rule":{"family":"inet","table":"pierwave","chain":"prerouting","expr":[
                {"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":9090}},
                {"counter":{"packets":9,"bytes":999}}
            ]}}
        ]}"#;
        let counters = parse_counters(raw).unwrap();
        assert_eq!(counters.get(&(8080, "tcp".to_string())), Some(&1050));
        assert_eq!(counters.get(&(8080, "udp".to_string())), Some(&200));
        assert_eq!(
            counters.get(&(9090, "tcp".to_string())),
            None,
            "没有 dnat 的规则不是转发流量"
        );
    }

    #[test]
    fn rejects_malformed_counter_json_instead_of_panicking() {
        assert!(parse_counters("not json").is_err());
        assert!(parse_counters("{}").is_err());
    }

    #[tokio::test]
    async fn resolves_ip_literals_without_dns() {
        let addr = resolve_target(&rule("f1", 8080, "1.2.3.4", 80))
            .await
            .unwrap();
        assert_eq!(addr, "1.2.3.4:80".parse().unwrap());
    }

    #[tokio::test]
    async fn rejects_multi_target_rules() {
        let mut spec = rule("f1", 8080, "1.2.3.4", 80);
        spec.targets = vec![
            ForwardTarget {
                host: "1.1.1.1".into(),
                port: 80,
                server_id: "a".into(),
            },
            ForwardTarget {
                host: "2.2.2.2".into(),
                port: 80,
                server_id: "b".into(),
            },
        ];
        assert_eq!(
            resolve_target(&spec).await.unwrap_err(),
            MULTI_TARGET_UNSUPPORTED
        );
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("pierwave-nftables-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn fake_nft(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("nft");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn apply_marks_rules_listening_when_nft_succeeds() {
        let dir = TempDir::new();
        let bin = fake_nft(dir.path(), "exit 0");
        let mut supervisor = NftablesSupervisor::new(bin, dir.path(), "0.0.0.0");
        supervisor.apply(&[rule("f1", 8080, "1.2.3.4", 80)]).await;
        let status = supervisor.status_handle().snapshot();
        assert_eq!(status.len(), 1);
        assert!(status[0].listening);
        assert!(status[0].error.is_empty());
        assert_eq!(status[0].target_ok, None, "内核转发无法做目标探测");
        let script = std::fs::read_to_string(dir.path().join(SCRIPT_FILE_NAME)).unwrap();
        assert!(script.contains("table inet pierwave"), "{script}");
    }

    /// 表里的 counter 必须按 (端口, 协议) 汇总到对应规则：both 规则取
    /// tcp+udp 之和作为入方向；出方向没有数据源，必须是 None 而不是 0。
    #[cfg(unix)]
    #[tokio::test]
    async fn heartbeat_reports_nftables_dnat_counters() {
        let dir = TempDir::new();
        let bin = fake_nft(
            dir.path(),
            r#"if [ "$1" = "-j" ]; then
cat <<'JSON'
{"nftables":[
 {"rule":{"family":"inet","table":"pierwave","chain":"prerouting","expr":[
   {"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":8080}},
   {"counter":{"packets":3,"bytes":1000}},
   {"dnat":{"addr":"1.2.3.4","port":80}}
 ]}},
 {"rule":{"family":"inet","table":"pierwave","chain":"prerouting","expr":[
   {"match":{"op":"==","left":{"payload":{"protocol":"udp","field":"dport"}},"right":8080}},
   {"counter":{"packets":2,"bytes":200}},
   {"dnat":{"addr":"1.2.3.4","port":80}}
 ]}}
]}
JSON
fi
exit 0"#,
        );
        let mut supervisor = NftablesSupervisor::new(bin, dir.path(), "0.0.0.0");
        supervisor.apply(&[rule("f1", 8080, "1.2.3.4", 80)]).await;
        let status = supervisor.status_handle().snapshot();
        assert_eq!(status[0].traffic_in, Some(1_200), "tcp 1000 + udp 200");
        assert_eq!(
            status[0].traffic_out, None,
            "DNAT counter 只看一个方向，不能编造出方向"
        );

        // 心跳对账（表没变）也必须刷新计数。
        supervisor.reconcile().await;
        assert_eq!(
            supervisor.status_handle().snapshot()[0].traffic_in,
            Some(1_200)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn apply_marks_rules_failed_when_nft_is_unavailable() {
        let dir = TempDir::new();
        let bin = fake_nft(dir.path(), "exit 1");
        let mut supervisor = NftablesSupervisor::new(bin, dir.path(), "0.0.0.0");
        supervisor.apply(&[rule("f1", 8080, "1.2.3.4", 80)]).await;
        let status = supervisor.status_handle().snapshot();
        assert_eq!(status.len(), 1);
        assert!(!status[0].listening);
        assert!(status[0].error.contains("nftables"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn empty_desired_state_cleans_the_table() {
        let dir = TempDir::new();
        let log = dir.path().join("calls");
        let bin = fake_nft(
            dir.path(),
            &format!("echo \"$@\" >> {}\nexit 0", log.display()),
        );
        let mut supervisor = NftablesSupervisor::new(bin, dir.path(), "0.0.0.0");
        supervisor.apply(&[rule("f1", 8080, "1.2.3.4", 80)]).await;
        supervisor.apply(&[]).await;
        assert!(supervisor.status_handle().snapshot().is_empty());
        let calls = std::fs::read_to_string(log).unwrap();
        assert!(calls.contains("delete table inet pierwave"), "{calls}");
    }

    /// 规则自带 listen_host 时，DNAT 只匹配该网卡地址，而不是所有本机地址。
    #[test]
    fn per_rule_listen_host_selects_that_daddr() {
        let mut spec = rule("f1", 8080, "1.2.3.4", 80);
        spec.listen_host = Some("10.0.0.2".into());
        let script = render_script(&[(spec, "1.2.3.4:80".parse().unwrap())], "0.0.0.0");
        assert!(
            script.contains("ip daddr 10.0.0.2 tcp dport 8080"),
            "{script}"
        );
        assert!(
            !script.contains("fib daddr type local tcp dport 8080"),
            "指定网卡后不能继续匹配所有本机地址：{script}"
        );
    }
}
