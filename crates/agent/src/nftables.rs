//! nftables 引擎：把 `engine == nftables` 的转发规则收敛到一张自有 NAT 表。
//!
//! 数据路径完全在内核：`prerouting` / `output` 两条 nat 链按监听端口做 DNAT，
//! 不经过用户态搬运，也不需要为每条规则开 socket。表名固定为 `inet pierwave`；
//! 每次 apply 只重建这一张表，绝不触碰系统里的其它 nftables 表。
//!
//! 多目标选路在**一张独立的 vmap** 里完成，规则本身只做端口匹配：
//!
//! * `round_robin`：`numgen inc mod N vmap { 0 : dnat … }`；
//! * `weighted`：`numgen random mod Σweight vmap { 0-2 : …, 3-9 : … }`（区间即权重）；
//! * `ip_hashed`：`jhash ip saddr mod N vmap …`（IPv6 用 `jhash ip6 saddr`）；
//! * `failover` / `lowest_latency` / `least_conn` 依赖健康探测或连接计数，
//!   内核 DNAT 没有这些原语，主控保存时就拒绝；Agent 侧仍防御性拒绝，绝不
//!   静默只发第一个目标。
//!
//! 按地址族拆开后，某族只剩 1 个有效目标时**直接生成普通 `dnat`**，不带
//! vmap / `numgen` / `jhash`：`mod 1` 在老内核上会返回 `ERANGE`。只有 ≥2 个
//! 目标的那一族才使用 vmap。
//!
//! nftables 的命名 map 无法用 `numgen` 的整数键（nft 至今没有对应的 key 类型），
//! 所以这里生成的是匿名 vmap：它是内核里独立的一张 verdict map，但随表一起
//! 原子重建，语义上仍是「单独一张 map」。不要为了命名 map 去 `meta mark set`，
//! 那会污染用户自己的策略路由 mark。
//!
//! 能力判定：`nft list tables` 必须成功（二进制存在 + CAP_NET_ADMIN），并且
//! `nft -c` 能解析多目标探针脚本（numgen / vmap / jhash 语法可用）。
//! 失败时所有 nftables 规则上报 `listening=false`，native / realm 规则不受影响。

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;

use pierwave_proto::{DesiredForward, ForwardEngine, ForwardStatus, ForwardStrategy};

/// 默认的 nft 可执行文件；安装脚本不打包 nft，使用发行版包管理器安装。
pub const DEFAULT_BIN: &str = "nft";

/// 自有表名；删除时只删这一张表。
pub const TABLE: &str = "pierwave";

/// 状态脚本文件名，落在 Agent 的 state_dir 下，便于排障时直接看生成内容。
pub const SCRIPT_FILE_NAME: &str = "nftables.nft";

/// 没有可用的 nft / 权限时，每条 nftables 规则的错误原文。
pub const NOT_AVAILABLE: &str = "nftables 不可用（需要安装 nft 并以 root 运行）";

/// `nft -c` 语法探针失败时的错误原文：nft 能列表演示但解析不了多目标规则。
pub const NOT_AVAILABLE_SYNTAX: &str = "nftables 不可用（`nft -c` 语法探测失败：当前 nft/内核不支持 numgen/vmap 多目标选路）；nftables unavailable (`nft -c` probe failed: this nft/kernel cannot parse numgen/vmap multi-target rules)";

/// 多目标但策略无法由内核 DNAT 实现时的错误原文。
pub const STRATEGY_UNSUPPORTED: &str =
    "nftables 多目标不支持该选路策略 / nftables multi-target does not support this strategy";

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
/// 能力探测（`list tables` / `nft -c`）的单次预算：nft 卡住时不能把
/// Agent 的心跳与 WebSocket 循环一起拖停。
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// 能力探测结果缓存：心跳 15 秒一轮，但没必要每轮都 spawn `nft`。
const CAPABILITY_CACHE_TTL: Duration = Duration::from_secs(60);
const ERROR_LIMIT: usize = 500;

/// 第一次 spawn 遇到「资源暂时不足」时的退避；只重试一次。
const SPAWN_RETRY_DELAY: Duration = Duration::from_millis(50);

/// `nft -c` 探针：只检查语法与内核表达式可用性，不提交任何规则。
///
/// 覆盖三种能实现的多目标选路（round_robin / weighted / ip_hashed）以及
/// IPv4/IPv6 的 family 匹配。表名/链名带 `probe` 前缀，避免与真实表冲突。
pub const SYNTAX_PROBE: &str = "\
table inet pierwave_probe {
    chain probe {
        type nat hook prerouting priority dstnat; policy accept;
        fib daddr type local meta nfproto ipv4 tcp dport 1 counter numgen inc mod 2 vmap { 0 : dnat ip to 127.0.0.1:1, 1 : dnat ip to 127.0.0.2:2 }
        fib daddr type local meta nfproto ipv4 tcp dport 2 counter numgen random mod 3 vmap { 0-1 : dnat ip to 127.0.0.1:1, 2 : dnat ip to 127.0.0.2:2 }
        fib daddr type local meta nfproto ipv4 tcp dport 3 counter jhash ip saddr mod 2 vmap { 0 : dnat ip to 127.0.0.1:1, 1 : dnat ip to 127.0.0.2:2 }
        fib daddr type local meta nfproto ipv6 tcp dport 3 counter jhash ip6 saddr mod 2 vmap { 0 : dnat ip6 to [::1]:1, 1 : dnat ip6 to [::2]:2 }
    }
}
";

/// 一个已解析的目标：地址 + 权重（只有 weighted 读取权重）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedEndpoint {
    pub addr: SocketAddr,
    pub weight: u32,
}

impl ResolvedEndpoint {
    fn new(addr: SocketAddr, weight: u32) -> Self {
        Self {
            addr,
            // 与主控的 1–100 同一口径；历史脏数据也不能让某个成员永远选不中。
            weight: weight.clamp(1, 100),
        }
    }
}

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
        let mut command = std::process::Command::new(&self.bin);
        command
            .args(["delete", "table", "inet", TABLE])
            .stdin(Stdio::null());
        let _ = spawn_with_retry(command).and_then(|child| child.wait_with_output());
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
    /// 能力探测缓存；`None` = 还没测过或已过期。
    capability: Option<CapabilityCache>,
    /// 单次能力探测的预算；生产固定 [`PROBE_TIMEOUT`]，测试可放宽以容忍 CI 负载。
    probe_timeout: Duration,
}

/// [`NftablesSupervisor`] 的能力探测缓存：`None` 表示可用。
#[derive(Debug, Clone)]
struct CapabilityCache {
    checked_at: Instant,
    reason: Option<String>,
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
            capability: None,
            probe_timeout: PROBE_TIMEOUT,
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
    ///
    /// 结果缓存 [`CAPABILITY_CACHE_TTL`]：心跳与 reconcile 共用同一份缓存，
    /// 避免每 15 秒都 spawn 两个 `nft` 子进程。
    pub async fn available(&mut self) -> bool {
        self.probe_capability().await.is_none()
    }

    /// 测试专用：放宽探测预算。CI 上 10 个测试线程并发 spawn 时，一个
    /// `exit 0` 的 shell 脚本也可能几秒才被调度；逻辑测试不该因此误判，
    /// 2 秒预算由 `capability_probe_times_out_instead_of_blocking_forever` 单独钉住。
    #[cfg(test)]
    pub fn with_probe_timeout(mut self, timeout: Duration) -> Self {
        self.probe_timeout = timeout;
        self
    }

    /// 当前能力（`None` = 可用）；60 秒内复用上一次结果。
    async fn probe_capability(&mut self) -> Option<String> {
        if let Some(cache) = &self.capability {
            if cache.checked_at.elapsed() < CAPABILITY_CACHE_TTL {
                return cache.reason.clone();
            }
        }
        let reason = unavailable_reason_with_timeout(&self.bin, self.probe_timeout).await;
        self.capability = Some(CapabilityCache {
            checked_at: Instant::now(),
            reason: reason.clone(),
        });
        reason
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

        let Some(reason) = self.probe_capability().await else {
            return self.apply_resolved().await;
        };
        tracing::warn!(
            bin = %self.bin.display(),
            reason = %reason,
            "nftables 不可用，nftables 规则保持未监听（native / realm 不受影响）"
        );
        self.needs_retry = true;
        self.status
            .store(self.inactive_statuses(&reason, &self.rules));
    }

    /// 能力探测通过后的实际收敛：解析全部目标、生成脚本、原子重建自有表。
    async fn apply_resolved(&mut self) {
        let mut resolved: Vec<(DesiredForward, Vec<ResolvedEndpoint>)> = Vec::new();
        let mut errors: HashMap<String, String> = HashMap::new();
        for rule in &self.rules {
            match resolve_targets(rule).await {
                Ok(targets) => resolved.push((rule.clone(), targets)),
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
                        probe_attempts: None,
                        probe_failures: None,
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
                            probe_attempts: None,
                            probe_failures: None,
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
                            probe_attempts: None,
                            probe_failures: None,
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
        match self.probe_capability().await {
            None => {
                if self.needs_retry || !table_exists(&self.bin).await {
                    let rules = self.rules.clone();
                    self.apply(&rules).await;
                } else {
                    // 表没变也要读一次 counter：流量持续增长，心跳必须看到最新值。
                    self.refresh_traffic().await;
                }
            }
            Some(reason) => {
                let rules = self.rules.clone();
                self.status.store(self.inactive_statuses(&reason, &rules));
            }
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
        // 无条件尝试删除：`bin` 可能只是裸命令名（走 PATH），也可能在运行期被
        // 移走/替换；用 `exists()` 当门槛会让内核里的 DNAT 表永远留着。
        // `nft` 不存在、表不存在都按成功处理（失败本来也不该阻断收尾）。
        let _ = run_nft(&self.bin, &["delete", "table", "inet", TABLE]).await;
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
                probe_attempts: None,
                probe_failures: None,
            })
            .collect()
    }
}

/// 不可用原因；`None` = 可用。心跳、apply、reconcile 共用同一套判定。
///
/// `timeout` 是单次探测预算：生产固定 [`PROBE_TIMEOUT`]，测试可放宽。
///
/// 判定 = 可执行文件 + `nft list tables` + `nft -c` 语法探针。
/// `list tables` 读表本身受 CAP_NET_ADMIN 限制；成功就说明进程确实有权限，
/// 这比只看文件存在更准确。多目标规则依赖 `numgen` / `vmap` / `jhash`：
/// nft 二进制能列表演示不代表它能解析这些表达式（或内核不支持），所以再用
/// `nft -c` 跑一段不提交的探针脚本；失败时上报可读错误，而不是等到 apply
/// 才炸掉内核对账。
///
/// **PATH 语义**：`nft_bin` 默认是裸命令名 `nft`，必须像 `execvp` 一样按
/// PATH 解析后再 stat/执行。直接用 `fs::metadata("nft")` 只会看当前目录，
/// 会把系统里已经装好的 nft 误判成「未安装」。
async fn unavailable_reason_with_timeout(bin: &Path, timeout: Duration) -> Option<String> {
    let path_var = std::env::var_os("PATH");
    unavailable_reason_with_path(bin, path_var.as_deref(), timeout).await
}

/// [`unavailable_reason_with_timeout`] 的可注入 PATH 版本：单测用临时目录伪造 PATH，
/// 不必改写进程级环境变量（并行测试下改 env 会互相污染）。
async fn unavailable_reason_with_path(
    bin: &Path,
    path_var: Option<&OsStr>,
    timeout: Duration,
) -> Option<String> {
    let Some(bin) = resolve_executable(bin, path_var) else {
        return Some(NOT_AVAILABLE.to_string());
    };
    if !probe_command(&bin, &["list", "tables"], timeout).await {
        return Some(NOT_AVAILABLE.to_string());
    }
    if !syntax_available(&bin, timeout).await {
        return Some(NOT_AVAILABLE_SYNTAX.to_string());
    }
    None
}

/// 解析可执行文件：带路径分隔符的值按原样；裸名按 PATH 逐目录查找。
///
/// 与 `execvp` 一致：PATH 中的空段表示当前目录；PATH 缺失时裸名无法解析。
fn resolve_executable(bin: &Path, path_var: Option<&OsStr>) -> Option<PathBuf> {
    if bin.is_absolute() || bin.components().count() > 1 {
        return is_executable_file(bin).then(|| bin.to_path_buf());
    }
    let name = bin.file_name()?;
    path_var
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable_file(candidate))
}

/// 普通文件 +（unix）可执行位；目录、残缺文件都不算可用。
fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
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
    true
}

/// 探测轮询间隔：用 `try_wait()` 主动收尸，不依赖 SIGCHLD 驱动的 `wait()`。
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// 在 deadline 内等子进程结束；超时返回 `None`（调用方负责 kill）。
async fn wait_for_probe(
    child: &mut tokio::process::Child,
    deadline: Instant,
) -> Option<std::process::ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(PROBE_POLL_INTERVAL).await;
    }
}

/// 跑一次带超时的探测（stdin 置空）。启动失败 / 超时 / 非零退出都算失败。
///
/// * spawn 复用 [`spawn_with_retry_async`]：CI/高并发下 `posix_spawn` 的
///   EAGAIN/EMFILE 是瞬时的，不重试会把「nft 已安装」误判成不可用；
/// * 等待用 [`wait_for_probe`] 的 `try_wait` 轮询：直接 `waitpid(WNOHANG)`
///   拿退出码，不依赖运行时的信号驱动，也便于用同一个 deadline 覆盖
///   spawn 之后的全部执行时间；
/// * `kill_on_drop(true)` 保证超时后子进程不会残留。
async fn probe_command(bin: &Path, args: &[&str], timeout: Duration) -> bool {
    let mut command = tokio::process::Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match spawn_with_retry_async(command).await {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!(bin = %bin.display(), %error, "nft 探测启动失败");
            return false;
        }
    };
    // 预算从 spawn 之后开始算：spawn 本身受系统进程表影响，不能算进
    // 「nft 跑多久」的预算里，否则高负载下会把可用误判成不可用。
    match wait_for_probe(&mut child, Instant::now() + timeout).await {
        Some(status) => status.success(),
        None => {
            let _ = child.start_kill();
            false
        }
    }
}

/// `nft -c -f -`：只做语义/语法检查，不提交事务。
///
/// 探针脚本通过 stdin 传入，不落盘、不依赖 state_dir；超时/启动失败都算不可用。
/// 写 stdin 失败（EPIPE）不算失败：子进程可能提前退出并关掉管道，结果以退出码
/// 为准；否则一个很快退出的 nft 实现会被误判成「不支持语法探测」。
async fn syntax_available(bin: &Path, timeout: Duration) -> bool {
    let mut command = tokio::process::Command::new(bin);
    command
        .args(["-c", "-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match spawn_with_retry_async(command).await {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!(bin = %bin.display(), %error, "nft 语法探测启动失败");
            return false;
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(SYNTAX_PROBE.as_bytes()).await;
        drop(stdin);
    }
    match wait_for_probe(&mut child, Instant::now() + timeout).await {
        Some(status) => status.success(),
        None => {
            let _ = child.start_kill();
            false
        }
    }
}

/// 这条策略能否由内核 DNAT 实现多目标选路。
///
/// `failover` / `lowest_latency` 需要健康探测与故障回切，`least_conn` 需要
/// 连接计数——这些都在用户态，内核没有对应原语。单目标时策略不影响结果，
/// 调用方只在 `targets.len() > 1` 时检查。
pub fn supports_strategy(strategy: ForwardStrategy) -> bool {
    matches!(
        strategy,
        ForwardStrategy::RoundRobin | ForwardStrategy::Weighted | ForwardStrategy::IpHashed
    )
}

/// 不支持时的可读原因（保存/下发路径应该更早拒绝；这里是 Agent 的防御）。
pub fn unsupported_strategy_reason(strategy: ForwardStrategy) -> &'static str {
    match strategy {
        ForwardStrategy::Failover => {
            "nftables 多目标不支持主备（failover）：内核 DNAT 无法探测目标健康并回切 / nftables multi-target does not support failover: kernel DNAT cannot probe target health or fail back"
        }
        ForwardStrategy::LowestLatency => {
            "nftables 多目标不支持最低延迟（lowest_latency）：内核 DNAT 拿不到目标探测延迟 / nftables multi-target does not support lowest-latency: kernel DNAT has no target latency signal"
        }
        ForwardStrategy::LeastConn => {
            "nftables 多目标不支持最少连接（least_conn）：内核没有连接计数原语 / nftables multi-target does not support least-conn: the kernel has no per-target connection counter"
        }
        _ => STRATEGY_UNSUPPORTED,
    }
}

/// 纯脚本生成：`resolved` 是「规则 + 已解析目标」，顺序由调用方保证。
///
/// 生成的规则同时放进 `prerouting`（外部入站）和 `output`（本机发起）两条链；
/// 用 `fib daddr type local` 限定目的地址是本机，避免把本机访问外网的普通连接
/// 也 DNAT 掉。指定了具体 `forward_bind` 时改用 `ip daddr` / `ip6 daddr`。
pub fn render_script(rules: &[(DesiredForward, Vec<ResolvedEndpoint>)], bind_host: &str) -> String {
    let mut lines = vec![format!("table inet {TABLE} {{")];
    for (chain, hook, priority) in [
        ("prerouting", "prerouting", "dstnat"),
        ("output", "output", "-100"),
    ] {
        lines.push(format!("    chain {chain} {{"));
        lines.push(format!(
            "        type nat hook {hook} priority {priority}; policy accept;"
        ));
        for (rule, targets) in rules {
            // 规则自带 listen_host 时只匹配该网卡地址；没有时退回全局 bind_host。
            let bind = rule
                .listen_host
                .as_deref()
                .map(str::trim)
                .filter(|host| !host.is_empty())
                .unwrap_or(bind_host)
                .trim();
            let matcher = daddr_matcher(bind);
            // 读路径以 protocol 为准；旧主控的 udp=true 由 effective_protocol
            // 还原成 both。只生成所选协议的规则：仅 UDP 时不能留下 tcp dnat。
            let protocol = rule.effective_protocol();
            for action in target_actions(rule.strategy, targets) {
                // `counter` 必须在选路/dnat 之前：这样每条规则都会累计命中字节，
                // 心跳用 `nft -j list table` 读回（nft 默认不计数）。
                let guard = if action.family_guard.is_empty() {
                    String::new()
                } else {
                    format!(" {}", action.family_guard)
                };
                if protocol.allows_tcp() {
                    lines.push(format!(
                        "        {matcher}{guard} tcp dport {} counter {}",
                        rule.listen_port, action.action
                    ));
                }
                if protocol.allows_udp() {
                    lines.push(format!(
                        "        {matcher}{guard} udp dport {} counter {}",
                        rule.listen_port, action.action
                    ));
                }
            }
        }
        lines.push("    }".to_string());
    }
    lines.push("}".to_string());
    lines.join("\n") + "\n"
}

/// 一条规则在某一协议上要生成的 (family 守卫, 动作)。
struct TargetAction {
    /// 空串 = 不守卫；否则形如 `meta nfproto ipv4`。
    family_guard: String,
    /// `dnat ip to …` 或 `numgen … vmap { … }`。
    action: String,
}

/// 把已解析目标变成 nft 动作。
///
/// * 单目标：保持旧版 `dnat …` 一行，不引入 vmap；
/// * 多目标：按地址族拆开（v4 / v6），各自生成一个动作；某族只有 1 个目标时
///   直接 `dnat …`，只有 ≥2 个目标才用 vmap——`mod 1` 在老内核上会 `ERANGE`；
///   即使只有一种族也加 `meta nfproto` 守卫，避免 v6 客户端被 DNAT 到 v4 目标；
/// * round_robin / weighted / ip_hashed 是三套选择器，互不复用。
fn target_actions(strategy: ForwardStrategy, targets: &[ResolvedEndpoint]) -> Vec<TargetAction> {
    // 防御性去重：同名成员 / 同一域名解析到同一地址时，vmap 的重复键会让
    // nft 直接报错。正常路径已在 resolve_targets 去重。
    let mut unique: Vec<&ResolvedEndpoint> = Vec::with_capacity(targets.len());
    for target in targets {
        if !unique.iter().any(|existing| existing.addr == target.addr) {
            unique.push(target);
        }
    }
    if unique.len() <= 1 {
        return unique
            .iter()
            .map(|target| TargetAction {
                family_guard: String::new(),
                action: render_dnat(target),
            })
            .collect();
    }

    let mut v4: Vec<&ResolvedEndpoint> = Vec::new();
    let mut v6: Vec<&ResolvedEndpoint> = Vec::new();
    for target in unique {
        match target.addr.ip() {
            IpAddr::V4(_) => v4.push(target),
            IpAddr::V6(_) => v6.push(target),
        }
    }

    let mut actions = Vec::with_capacity(2);
    if !v4.is_empty() {
        actions.push(family_action(strategy, &v4, false, "meta nfproto ipv4"));
    }
    if !v6.is_empty() {
        actions.push(family_action(strategy, &v6, true, "meta nfproto ipv6"));
    }
    actions
}

/// 一个地址族的动作：单目标用普通 dnat，≥2 个目标才用 vmap 选择器。
///
/// 单目标族绝不能走 `render_selector`：那会生成 `mod 1`，老内核直接 ERANGE。
fn family_action(
    strategy: ForwardStrategy,
    targets: &[&ResolvedEndpoint],
    ipv6: bool,
    family_guard: &str,
) -> TargetAction {
    TargetAction {
        family_guard: family_guard.to_string(),
        action: if targets.len() == 1 {
            render_dnat(targets[0])
        } else {
            render_selector(strategy, targets, ipv6)
        },
    }
}

/// 生成选择器：round_robin / weighted 用 numgen，ip_hashed 用 jhash。
fn render_selector(strategy: ForwardStrategy, targets: &[&ResolvedEndpoint], ipv6: bool) -> String {
    match strategy {
        ForwardStrategy::IpHashed => {
            let key = if ipv6 { "ip6 saddr" } else { "ip saddr" };
            let entries = targets
                .iter()
                .enumerate()
                .map(|(index, target)| format!("{index} : {}", render_dnat(target)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("jhash {key} mod {} vmap {{ {entries} }}", targets.len())
        }
        ForwardStrategy::Weighted => {
            let total: u32 = targets.iter().map(|target| target.weight).sum();
            let mut next = 0u32;
            let entries = targets
                .iter()
                .map(|target| {
                    let start = next;
                    next += target.weight;
                    let end = next - 1;
                    let key = if start == end {
                        start.to_string()
                    } else {
                        format!("{start}-{end}")
                    };
                    format!("{key} : {}", render_dnat(target))
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("numgen random mod {total} vmap {{ {entries} }}")
        }
        // 其余多目标策略在保存/下发路径已经拒绝；这里退回轮询是最安全的可实现
        // 语义，但**绝不**只发第一个目标。
        _ => {
            let entries = targets
                .iter()
                .enumerate()
                .map(|(index, target)| format!("{index} : {}", render_dnat(target)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("numgen inc mod {} vmap {{ {entries} }}", targets.len())
        }
    }
}

fn render_dnat(target: &ResolvedEndpoint) -> String {
    match target.addr.ip() {
        IpAddr::V4(_) => format!("dnat ip to {}:{}", target.addr.ip(), target.addr.port()),
        IpAddr::V6(_) => format!("dnat ip6 to [{}]:{}", target.addr.ip(), target.addr.port()),
    }
}

/// 监听地址 → nft `daddr` 匹配串。未指定 / `0.0.0.0` 时匹配「本机地址」。
fn daddr_matcher(bind: &str) -> String {
    match bind.parse::<IpAddr>() {
        Ok(IpAddr::V4(addr)) if !addr.is_unspecified() => format!("ip daddr {addr}"),
        Ok(IpAddr::V6(addr)) if !addr.is_unspecified() => format!("ip6 daddr {addr}"),
        _ => "fib daddr type local".to_string(),
    }
}

/// 解析一条规则的全部目标；域名在 apply 时解析（与旧单目标行为一致）。
///
/// 顺序由主控保证（priority 升序），这里保持输入顺序。同一地址只保留一次，
/// 避免 vmap 出现重复键；只留第一个权重。任一名成员解析失败都让整条规则失败：
/// 静默少发一个目标会改变流量分配，且用户看不出「目标池少了一台」。
pub async fn resolve_targets(rule: &DesiredForward) -> Result<Vec<ResolvedEndpoint>, String> {
    let multi = rule.targets.len() > 1;
    if multi && !supports_strategy(rule.strategy) {
        return Err(unsupported_strategy_reason(rule.strategy).to_string());
    }
    let entries: Vec<(&str, i64, u32)> = if rule.targets.is_empty() {
        vec![(rule.target_host.as_str(), rule.target_port, 1)]
    } else {
        rule.targets
            .iter()
            .map(|target| (target.host.as_str(), target.port, target.weight))
            .collect()
    };
    if entries.is_empty() {
        return Err(format!(
            "规则 {} 没有目标地址（targets 为空且兼容字段为空）",
            rule.id
        ));
    }

    let mut resolved: Vec<ResolvedEndpoint> = Vec::with_capacity(entries.len());
    for (host, port, weight) in entries {
        let port = u16::try_from(port).map_err(|_| format!("目标端口不合法：{port}"))?;
        let addr = if let Ok(ip) = host.parse::<IpAddr>() {
            SocketAddr::new(ip, port)
        } else {
            let mut addrs = tokio::net::lookup_host((host, port))
                .await
                .map_err(|error| format!("解析目标 {host}:{port} 失败：{error}"))?;
            addrs
                .next()
                .ok_or_else(|| format!("目标 {host}:{port} 没有解析结果"))?
        };
        if resolved.iter().any(|existing| existing.addr == addr) {
            continue;
        }
        resolved.push(ResolvedEndpoint::new(addr, weight));
    }
    if resolved.is_empty() {
        return Err(format!("规则 {} 没有可用的目标地址", rule.id));
    }
    Ok(resolved)
}

/// 首次 `spawn` 失败后是否值得重试一次。
///
/// 只认「资源暂时不足 / 系统调用被打断」这一类错误：
///
/// * `WouldBlock` / `EAGAIN`：fork 时进程表或内存瞬时不够（CI 上几百个
///   测试并行 spawn 子进程的典型症状，重跑即恢复）；
/// * `Interrupted` / `EINTR`：`posix_spawn` 被信号打断；
/// * `EMFILE` / `ENFILE`：文件描述符瞬时耗尽，通常几十毫秒内就被回收。
///
/// 其余错误（路径不存在、无执行权限、ENOMEM 真没内存）重试也改变不了结果，
/// 只会把「配置/环境错误」掩盖成一次更慢的失败，所以不重试。
pub(crate) fn should_retry(error: &io::Error) -> bool {
    if matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    ) {
        return true;
    }
    #[cfg(unix)]
    {
        use libc::{EAGAIN, EINTR, EMFILE, ENFILE};
        if matches!(error.raw_os_error(), Some(code)
            if code == EAGAIN || code == EINTR || code == EMFILE || code == ENFILE)
        {
            return true;
        }
    }
    false
}

/// 同步 spawn 的一次性重试：`attempt` 只被调用两次，第二次仍失败就原样返回。
///
/// 抽成泛型是为了单测能注入「首次失败、第二次成功」的假 spawn，而不依赖
/// 真的把进程表打满；`backoff` 由调用方决定（生产路径是 50ms 睡眠）。
fn retry_spawn<T>(
    mut attempt: impl FnMut() -> io::Result<T>,
    mut backoff: impl FnMut(),
) -> io::Result<T> {
    match attempt() {
        Ok(value) => Ok(value),
        Err(first) if should_retry(&first) => {
            tracing::warn!(
                error = %first,
                delay_ms = SPAWN_RETRY_DELAY.as_millis() as u64,
                "nft 首次 spawn 失败（可重试），退避后重试一次"
            );
            backoff();
            attempt()
        }
        Err(error) => Err(error),
    }
}

/// 同步命令的 spawn：首次遇到可重试错误时睡 50ms 再试一次。
///
/// 只在退出清理（[`NftablesCleanup::cleanup`]）这类同步路径上用；能力探测
/// 与 apply 走异步版本，不能在 Agent 主循环里阻塞 50ms。
fn spawn_with_retry(mut command: std::process::Command) -> io::Result<std::process::Child> {
    retry_spawn(|| command.spawn(), || std::thread::sleep(SPAWN_RETRY_DELAY))
}

/// 异步命令的 spawn：与 [`spawn_with_retry`] 同样的判定与退避。
async fn spawn_with_retry_async(
    mut command: tokio::process::Command,
) -> io::Result<tokio::process::Child> {
    match command.spawn() {
        Ok(child) => Ok(child),
        Err(first) if should_retry(&first) => {
            tracing::warn!(
                error = %first,
                delay_ms = SPAWN_RETRY_DELAY.as_millis() as u64,
                "nft 首次 spawn 失败（可重试），退避后重试一次"
            );
            tokio::time::sleep(SPAWN_RETRY_DELAY).await;
            command.spawn()
        }
        Err(error) => Err(error),
    }
}

async fn run_nft(bin: &Path, args: &[&str]) -> Result<(), String> {
    run_nft_capture(bin, args).await.map(|_| ())
}

/// 执行 nft 并返回 stdout（解析 `-j list table` 的计数器用）。
///
/// 先 `spawn` 再 `wait_with_output`，而不是一步 `output()`：只有 spawn 阶段
/// 的 EAGAIN/EINTR 值得重试，子进程已经起来之后再失败重试反而会重复执行。
async fn run_nft_capture(bin: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = tokio::process::Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = tokio::time::timeout(COMMAND_TIMEOUT, async move {
        let child = spawn_with_retry_async(command).await?;
        child.wait_with_output().await
    })
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

/// 规则表达式里是否真的包含 dnat。
///
/// 单目标规则是顶层 `{"dnat": …}`；多目标规则把它藏在
/// `vmap.data.set[*][1]` 的 verdict 里，所以必须递归找，不能只看第一层。
/// 只用于识别「这条规则是 DNAT」，不解析目标本身。
fn contains_dnat(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            map.contains_key("dnat") || map.values().any(contains_dnat)
        }
        serde_json::Value::Array(items) => items.iter().any(contains_dnat),
        _ => false,
    }
}

/// 解析 `nft -j list table inet pierwave` 里每条 dnat 规则的 counter。
///
/// 返回 `(listen_port, "tcp"/"udp") -> bytes`，同一端口的两条链
/// （prerouting / output）与同一协议的多条规则累加。只统计同时带
/// `dnat`（含 vmap 里的 dnat verdict）与 `counter` 的规则；其它规则
/// （用户手改的表等）一律忽略。
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
        if !exprs.iter().any(contains_dnat) {
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
        pierwave_domain::fs_security::create_private_dir(parent)?;
    }
    let tmp = path.with_extension("nft.new");
    pierwave_domain::fs_security::write_private_file(&tmp, content.as_bytes())?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    pierwave_domain::fs_security::ensure_private_file(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pierwave_proto::{ForwardStrategy, ForwardTarget};
    use std::time::Instant;

    /// 逻辑测试的探测预算：CI 上 10 个测试线程并发 spawn 时，即使 `exit 0`
    /// 的 shell 脚本也可能几秒才被调度。2s 的生产预算由专门的超时测试钉住，
    /// 这里放宽，避免把「机器慢」误判成「逻辑坏」。
    const TEST_PROBE_TIMEOUT: Duration = Duration::from_secs(20);

    fn test_supervisor(
        bin: impl Into<PathBuf>,
        state_dir: impl Into<PathBuf>,
        bind: impl Into<String>,
    ) -> NftablesSupervisor {
        NftablesSupervisor::new(bin, state_dir, bind).with_probe_timeout(TEST_PROBE_TIMEOUT)
    }

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
            proxy_protocol: false,
            listen_host: None,
            tunnel: None,
        }
    }

    fn ep(addr: &str) -> ResolvedEndpoint {
        ResolvedEndpoint::new(addr.parse().unwrap(), 1)
    }

    fn multi_targets() -> Vec<ForwardTarget> {
        vec![
            ForwardTarget {
                host: "1.1.1.1".into(),
                port: 80,
                server_id: "a".into(),
                weight: 1,
            },
            ForwardTarget {
                host: "2.2.2.2".into(),
                port: 8080,
                server_id: "b".into(),
                weight: 1,
            },
        ]
    }

    /// 进程级闸门：本 crate 里所有会 spawn `nft` 的用例共用，最多 4 个并发。
    ///
    /// CI 上 350 个测试并行时会同时 fork 大量子进程，进程表/内存瞬时不足会让
    /// `posix_spawn` 偶发 EAGAIN。生产侧已经有一次性重试，这里再加一道闸门，
    /// 从源头压低 nft 子进程的并发数；不放大超时、不 `#[ignore]`、也不把
    /// 整个测试套件改成串行。
    static NFT_SPAWN_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

    async fn nft_permit() -> tokio::sync::SemaphorePermit<'static> {
        NFT_SPAWN_PERMITS
            .acquire()
            .await
            .expect("nft 测试信号量不会关闭")
    }

    /// 判定表：只有 EAGAIN / EINTR / EMFILE / ENFILE（以及对应的 ErrorKind）
    /// 值得重试一次；ENOMEM、路径不存在、权限不足都不重试。
    #[test]
    fn only_transient_spawn_errors_are_retryable() {
        let cases: [(&str, io::Error, bool); 11] = [
            ("EAGAIN", io::Error::from_raw_os_error(libc::EAGAIN), true),
            ("EINTR", io::Error::from_raw_os_error(libc::EINTR), true),
            ("EMFILE", io::Error::from_raw_os_error(libc::EMFILE), true),
            ("ENFILE", io::Error::from_raw_os_error(libc::ENFILE), true),
            (
                "WouldBlock",
                io::Error::from(io::ErrorKind::WouldBlock),
                true,
            ),
            (
                "Interrupted",
                io::Error::from(io::ErrorKind::Interrupted),
                true,
            ),
            ("ENOMEM", io::Error::from_raw_os_error(libc::ENOMEM), false),
            ("ENOENT", io::Error::from_raw_os_error(libc::ENOENT), false),
            ("EACCES", io::Error::from_raw_os_error(libc::EACCES), false),
            ("NotFound", io::Error::from(io::ErrorKind::NotFound), false),
            ("Other", io::Error::other("boom"), false),
        ];
        for (name, error, expected) in cases {
            assert_eq!(should_retry(&error), expected, "{name}");
        }
    }

    /// 首次 spawn 失败且可重试 → 退避一次后重试；第二次成功就返回成功。
    #[test]
    fn retry_spawn_retries_once_after_a_transient_failure() {
        let mut attempts = 0;
        let mut backoffs = 0;
        let result = retry_spawn(
            || {
                attempts += 1;
                if attempts == 1 {
                    Err(io::Error::from_raw_os_error(libc::EAGAIN))
                } else {
                    Ok(())
                }
            },
            || backoffs += 1,
        );
        assert!(result.is_ok());
        assert_eq!(attempts, 2, "首次 EAGAIN 后必须恰好重试一次");
        assert_eq!(backoffs, 1, "重试前必须退避一次");
    }

    /// 连续两次可重试错误只重试一次（不无限重试）；不可重试错误一次都不重试。
    #[test]
    fn retry_spawn_is_single_attempt_and_skips_permanent_errors() {
        let mut attempts = 0;
        let result = retry_spawn(
            || {
                attempts += 1;
                Err::<(), _>(io::Error::from_raw_os_error(libc::EAGAIN))
            },
            || {},
        );
        assert!(result.is_err());
        assert_eq!(attempts, 2, "只重试一次，不进入循环");

        let mut attempts = 0;
        let result = retry_spawn(
            || {
                attempts += 1;
                Err::<(), _>(io::Error::from_raw_os_error(libc::ENOENT))
            },
            || {},
        );
        assert!(result.is_err());
        assert_eq!(attempts, 1, "ENOENT 不该重试");
    }

    #[test]
    fn renders_ipv4_rules_for_both_chains_and_protocols() {
        let script = render_script(
            &[(rule("f1", 8080, "1.2.3.4", 80), vec![ep("1.2.3.4:80")])],
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
                vec![ep("[2001:db8::1]:443")],
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
        let script = render_script(&[(spec, vec![ep("1.2.3.4:80")])], "0.0.0.0");
        assert!(script.contains("tcp dport 8080"));
        assert!(!script.contains("udp dport 8080"), "{script}");
    }

    #[test]
    fn udp_only_rule_renders_only_udp_dnat() {
        let mut spec = rule("f1", 8080, "1.2.3.4", 80);
        spec.protocol = pierwave_proto::ForwardProtocol::Udp;
        spec.udp = false;
        let script = render_script(&[(spec, vec![ep("1.2.3.4:80")])], "0.0.0.0");
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
        let script = render_script(&[(spec, vec![ep("1.2.3.4:80")])], "0.0.0.0");
        for protocol in ["tcp", "udp"] {
            assert_eq!(
                script.matches(&format!("{protocol} dport 8080")).count(),
                2,
                "prerouting 与 output 各一条 {protocol}：{script}"
            );
        }
    }

    /// golden：2 目标 round_robin 生成 `numgen inc mod 2 vmap`，两条链 × 两种协议。
    #[test]
    fn renders_round_robin_vmap_for_two_targets() {
        let script = render_script(
            &[(
                rule("f1", 8080, "1.2.3.4", 80),
                vec![ep("1.1.1.1:80"), ep("2.2.2.2:8080")],
            )],
            "0.0.0.0",
        );
        let expected = "\
table inet pierwave {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        fib daddr type local meta nfproto ipv4 tcp dport 8080 counter numgen inc mod 2 vmap { 0 : dnat ip to 1.1.1.1:80, 1 : dnat ip to 2.2.2.2:8080 }
        fib daddr type local meta nfproto ipv4 udp dport 8080 counter numgen inc mod 2 vmap { 0 : dnat ip to 1.1.1.1:80, 1 : dnat ip to 2.2.2.2:8080 }
    }
    chain output {
        type nat hook output priority -100; policy accept;
        fib daddr type local meta nfproto ipv4 tcp dport 8080 counter numgen inc mod 2 vmap { 0 : dnat ip to 1.1.1.1:80, 1 : dnat ip to 2.2.2.2:8080 }
        fib daddr type local meta nfproto ipv4 udp dport 8080 counter numgen inc mod 2 vmap { 0 : dnat ip to 1.1.1.1:80, 1 : dnat ip to 2.2.2.2:8080 }
    }
}
";
        assert_eq!(script, expected);
    }

    #[test]
    fn renders_three_targets_and_mixed_tcp_udp_ports() {
        let mut tcp = rule("tcp", 8080, "1.1.1.1", 80);
        tcp.protocol = pierwave_proto::ForwardProtocol::Tcp;
        tcp.udp = false;
        let mut udp = rule("udp", 9090, "1.1.1.1", 80);
        udp.protocol = pierwave_proto::ForwardProtocol::Udp;
        udp.udp = false;
        let targets = vec![ep("1.1.1.1:80"), ep("2.2.2.2:81"), ep("3.3.3.3:82")];
        let script = render_script(&[(tcp, targets.clone()), (udp, targets)], "0.0.0.0");
        assert_eq!(
            script.matches("numgen inc mod 3 vmap").count(),
            4,
            "TCP + UDP × 两条链：{script}"
        );
        assert!(script.contains("0 : dnat ip to 1.1.1.1:80"));
        assert!(script.contains("1 : dnat ip to 2.2.2.2:81"));
        assert!(script.contains("2 : dnat ip to 3.3.3.3:82"));
        assert_eq!(script.matches("tcp dport 8080").count(), 2);
        assert_eq!(script.matches("udp dport 9090").count(), 2);
        assert!(
            !script.contains("udp dport 8080") && !script.contains("tcp dport 9090"),
            "混合协议不能串台：{script}"
        );
    }

    #[test]
    fn renders_weighted_ranges_from_member_weights() {
        let targets = vec![
            ResolvedEndpoint::new("1.1.1.1:80".parse().unwrap(), 3),
            ResolvedEndpoint::new("2.2.2.2:80".parse().unwrap(), 7),
        ];
        let script = render_script(
            &[(
                {
                    let mut spec = rule("f1", 8080, "1.1.1.1", 80);
                    spec.strategy = ForwardStrategy::Weighted;
                    spec
                },
                targets,
            )],
            "0.0.0.0",
        );
        assert!(
            script.contains(
                "numgen random mod 10 vmap { 0-2 : dnat ip to 1.1.1.1:80, 3-9 : dnat ip to 2.2.2.2:80 }"
            ),
            "{script}"
        );
    }

    /// 两族各只有 1 个目标：必须生成两条普通 `dnat`（带族守卫），
    /// 不能出现 `jhash … mod 1` —— 老内核会因 `modulus <= 1` 返回 ERANGE。
    #[test]
    fn two_single_target_families_render_plain_dnat() {
        let targets = vec![ep("1.1.1.1:80"), ep("[2001:db8::1]:80")];
        let script = render_script(
            &[(
                {
                    let mut spec = rule("f1", 8080, "1.1.1.1", 80);
                    spec.strategy = ForwardStrategy::IpHashed;
                    spec
                },
                targets,
            )],
            "0.0.0.0",
        );
        assert!(
            script.contains("meta nfproto ipv4 tcp dport 8080 counter dnat ip to 1.1.1.1:80"),
            "{script}"
        );
        assert!(
            script
                .contains("meta nfproto ipv6 tcp dport 8080 counter dnat ip6 to [2001:db8::1]:80"),
            "{script}"
        );
        assert!(
            !script.contains("jhash"),
            "单目标族不能生成 jhash：{script}"
        );
        assert!(!script.contains("vmap"), "单目标族不能生成 vmap：{script}");
        assert!(
            !contains_modulus_one(&script),
            "单目标族不能生成 mod 1：{script}"
        );
    }

    /// IpHashed 的多目标族仍生成 `jhash … vmap`；同规则里另一族只有 1 个
    /// 目标时必须退回普通 dnat（B7），不能生成 `jhash … mod 1`。
    #[test]
    fn ip_hashed_uses_vmap_only_for_the_multi_target_family() {
        let mut spec = rule("f1", 8080, "1.1.1.1", 80);
        spec.strategy = ForwardStrategy::IpHashed;
        spec.protocol = pierwave_proto::ForwardProtocol::Tcp;
        spec.udp = false;
        let script = render_script(
            &[(
                spec,
                vec![ep("1.1.1.1:80"), ep("2.2.2.2:80"), ep("[2001:db8::1]:443")],
            )],
            "0.0.0.0",
        );
        assert!(
            script.contains(
                "meta nfproto ipv4 tcp dport 8080 counter jhash ip saddr mod 2 vmap { 0 : dnat ip to 1.1.1.1:80, 1 : dnat ip to 2.2.2.2:80 }"
            ),
            "{script}"
        );
        assert!(
            script
                .contains("meta nfproto ipv6 tcp dport 8080 counter dnat ip6 to [2001:db8::1]:443"),
            "{script}"
        );
        assert!(
            !contains_modulus_one(&script),
            "多目标族用 mod 2，单目标族退回普通 dnat：{script}"
        );
    }

    /// golden：单族单目标 = 普通 `dnat`，不带 vmap / numgen / jhash。
    #[test]
    fn golden_single_family_single_target_is_plain_dnat() {
        let mut spec = rule("f1", 8080, "1.1.1.1", 80);
        spec.protocol = pierwave_proto::ForwardProtocol::Tcp;
        spec.udp = false;
        let script = render_script(&[(spec, vec![ep("1.1.1.1:80")])], "0.0.0.0");
        let expected = "\
table inet pierwave {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        fib daddr type local tcp dport 8080 counter dnat ip to 1.1.1.1:80
    }
    chain output {
        type nat hook output priority -100; policy accept;
        fib daddr type local tcp dport 8080 counter dnat ip to 1.1.1.1:80
    }
}
";
        assert_eq!(script, expected);
        assert!(!script.contains("vmap"), "{script}");
        assert!(!script.contains("numgen"), "{script}");
        assert!(!script.contains("jhash"), "{script}");
    }

    /// golden：两族各单目标 = 每个 chain 两条普通 `dnat`（各带族守卫）。
    #[test]
    fn golden_two_single_target_families_are_two_plain_dnat() {
        let mut spec = rule("f1", 8080, "1.1.1.1", 80);
        spec.protocol = pierwave_proto::ForwardProtocol::Tcp;
        spec.udp = false;
        let script = render_script(
            &[(spec, vec![ep("1.1.1.1:80"), ep("[2001:db8::1]:443")])],
            "0.0.0.0",
        );
        let expected = "\
table inet pierwave {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        fib daddr type local meta nfproto ipv4 tcp dport 8080 counter dnat ip to 1.1.1.1:80
        fib daddr type local meta nfproto ipv6 tcp dport 8080 counter dnat ip6 to [2001:db8::1]:443
    }
    chain output {
        type nat hook output priority -100; policy accept;
        fib daddr type local meta nfproto ipv4 tcp dport 8080 counter dnat ip to 1.1.1.1:80
        fib daddr type local meta nfproto ipv6 tcp dport 8080 counter dnat ip6 to [2001:db8::1]:443
    }
}
";
        assert_eq!(script, expected);
        assert!(!script.contains("vmap"), "{script}");
        assert!(
            !contains_modulus_one(&script),
            "两族各单目标不能生成 mod 1：{script}"
        );
    }

    /// golden：一族 2 个 + 另一族 1 个 = 一条 vmap + 一条普通 dnat（每个 chain）。
    #[test]
    fn golden_two_plus_one_targets_are_one_vmap_and_one_plain_dnat() {
        let mut spec = rule("f1", 8080, "1.1.1.1", 80);
        spec.protocol = pierwave_proto::ForwardProtocol::Tcp;
        spec.udp = false;
        let script = render_script(
            &[(
                spec,
                vec![
                    ep("1.1.1.1:80"),
                    ep("2.2.2.2:8080"),
                    ep("[2001:db8::1]:443"),
                ],
            )],
            "0.0.0.0",
        );
        let expected = "\
table inet pierwave {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        fib daddr type local meta nfproto ipv4 tcp dport 8080 counter numgen inc mod 2 vmap { 0 : dnat ip to 1.1.1.1:80, 1 : dnat ip to 2.2.2.2:8080 }
        fib daddr type local meta nfproto ipv6 tcp dport 8080 counter dnat ip6 to [2001:db8::1]:443
    }
    chain output {
        type nat hook output priority -100; policy accept;
        fib daddr type local meta nfproto ipv4 tcp dport 8080 counter numgen inc mod 2 vmap { 0 : dnat ip to 1.1.1.1:80, 1 : dnat ip to 2.2.2.2:8080 }
        fib daddr type local meta nfproto ipv6 tcp dport 8080 counter dnat ip6 to [2001:db8::1]:443
    }
}
";
        assert_eq!(script, expected);
        assert_eq!(script.matches("vmap").count(), 2, "两条 chain 各一条 vmap");
        assert_eq!(
            script
                .matches("meta nfproto ipv6 tcp dport 8080 counter dnat ip6")
                .count(),
            2,
            "v6 单目标族在每个 chain 各一条普通 dnat"
        );
        assert!(
            !contains_modulus_one(&script),
            "脚本中不能出现 mod 1：{script}"
        );
    }

    /// 对多种目标组合 × 多种策略循环断言：生成脚本里永不出现 `mod 1`
    /// （按空白切词判断，避免误伤 `mod 10` 这类合法模数）。
    #[test]
    fn never_emits_modulus_one_for_any_target_combination() {
        let combinations: Vec<Vec<&str>> = vec![
            vec!["1.1.1.1:80"],
            vec!["[2001:db8::1]:80"],
            vec!["1.1.1.1:80", "2.2.2.2:80"],
            vec!["[2001:db8::1]:80", "[2001:db8::2]:80"],
            vec!["1.1.1.1:80", "[2001:db8::1]:80"],
            vec!["1.1.1.1:80", "2.2.2.2:80", "[2001:db8::1]:80"],
            vec!["1.1.1.1:80", "[2001:db8::1]:80", "[2001:db8::2]:80"],
            vec![
                "1.1.1.1:80",
                "2.2.2.2:80",
                "[2001:db8::1]:80",
                "[2001:db8::2]:80",
            ],
        ];
        for strategy in [
            ForwardStrategy::RoundRobin,
            ForwardStrategy::Weighted,
            ForwardStrategy::IpHashed,
        ] {
            for combination in &combinations {
                let mut spec = rule("f1", 8080, "1.1.1.1", 80);
                spec.strategy = strategy;
                let targets: Vec<ResolvedEndpoint> =
                    combination.iter().map(|addr| ep(addr)).collect();
                let script = render_script(&[(spec, targets)], "0.0.0.0");
                assert!(
                    !contains_modulus_one(&script),
                    "strategy={strategy:?} targets={combination:?} 生成了 mod 1：\n{script}"
                );
            }
        }
    }

    /// 按空白切词判断是否出现 `mod 1`，不会把 `mod 10` / `mod 1-2` 误判。
    fn contains_modulus_one(script: &str) -> bool {
        script
            .split_whitespace()
            .collect::<Vec<_>>()
            .windows(2)
            .any(|pair| pair[0] == "mod" && pair[1] == "1")
    }

    /// 同一地址出现两次（成员填了相同 IP）只保留一个 vmap 键，避免 nft 报重复。
    #[test]
    fn deduplicates_identical_endpoints() {
        let script = render_script(
            &[(
                rule("f1", 8080, "1.2.3.4", 80),
                vec![ep("1.1.1.1:80"), ep("1.1.1.1:80")],
            )],
            "0.0.0.0",
        );
        assert!(
            script.contains("counter dnat ip to 1.1.1.1:80"),
            "去重后退化成单目标：{script}"
        );
        assert!(!script.contains("vmap"), "{script}");
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

    /// 多目标规则的 dnat 藏在 vmap 的 verdict 里，计数器仍必须命中；
    /// 否则 nftables 链切到多目标后流量面板会突然全空。
    #[test]
    fn parses_counters_for_vmap_dnat_rules() {
        let raw = r#"{"nftables":[
            {"rule":{"family":"inet","table":"pierwave","chain":"prerouting","expr":[
                {"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":8080}},
                {"counter":{"packets":4,"bytes":4000}},
                {"vmap":{"key":{"numgen":{"mod":2,"type":"inc"}},"data":{"set":[
                    [0,{"dnat":{"addr":"1.1.1.1","port":80}}],
                    [1,{"dnat":{"addr":"2.2.2.2","port":8080}}]
                ]}}}
            ]}},
            {"rule":{"family":"inet","table":"pierwave","chain":"prerouting","expr":[
                {"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":9090}},
                {"counter":{"packets":4,"bytes":4000}},
                {"vmap":{"key":{"numgen":{"mod":2,"type":"inc"}},"data":{"set":[
                    [0,{"accept":null}],
                    [1,{"accept":null}]
                ]}}}
            ]}}
        ]}"#;
        let counters = parse_counters(raw).unwrap();
        assert_eq!(counters.get(&(8080, "tcp".to_string())), Some(&4000));
        assert_eq!(
            counters.get(&(9090, "tcp".to_string())),
            None,
            "vmap 里没有 dnat 的规则不是转发流量"
        );
    }

    #[test]
    fn rejects_malformed_counter_json_instead_of_panicking() {
        assert!(parse_counters("not json").is_err());
        assert!(parse_counters("{}").is_err());
    }

    #[tokio::test]
    async fn resolves_ip_literals_without_dns() {
        let targets = resolve_targets(&rule("f1", 8080, "1.2.3.4", 80))
            .await
            .unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].addr, "1.2.3.4:80".parse().unwrap());
    }

    #[tokio::test]
    async fn resolves_every_target_in_order() {
        let mut spec = rule("f1", 8080, "1.2.3.4", 80);
        spec.targets = multi_targets();
        let targets = resolve_targets(&spec).await.unwrap();
        assert_eq!(
            targets.iter().map(|t| t.addr).collect::<Vec<_>>(),
            vec![
                "1.1.1.1:80".parse().unwrap(),
                "2.2.2.2:8080".parse().unwrap()
            ]
        );
    }

    #[tokio::test]
    async fn rejects_unimplementable_multi_target_strategies() {
        for strategy in [
            ForwardStrategy::Failover,
            ForwardStrategy::LowestLatency,
            ForwardStrategy::LeastConn,
        ] {
            let mut spec = rule("f1", 8080, "1.2.3.4", 80);
            spec.targets = multi_targets();
            spec.strategy = strategy;
            let error = resolve_targets(&spec).await.unwrap_err();
            assert!(
                error.contains(&format!("{strategy:?}").to_lowercase()) || error.contains("多目标"),
                "strategy={strategy:?} error={error}"
            );
        }
    }

    #[tokio::test]
    async fn single_target_keeps_working_for_every_strategy() {
        for strategy in [
            ForwardStrategy::RoundRobin,
            ForwardStrategy::Failover,
            ForwardStrategy::LowestLatency,
            ForwardStrategy::IpHashed,
            ForwardStrategy::Weighted,
            ForwardStrategy::LeastConn,
        ] {
            let mut spec = rule("f1", 8080, "1.2.3.4", 80);
            spec.strategy = strategy;
            assert!(
                resolve_targets(&spec).await.is_ok(),
                "单目标没有选路空间，不能被策略门禁挡住：{strategy:?}"
            );
        }
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
        let _permit = nft_permit().await;
        let dir = TempDir::new();
        let bin = fake_nft(dir.path(), "exit 0");
        let mut supervisor = test_supervisor(bin, dir.path(), "0.0.0.0");
        supervisor.apply(&[rule("f1", 8080, "1.2.3.4", 80)]).await;
        let status = supervisor.status_handle().snapshot();
        assert_eq!(status.len(), 1);
        assert!(status[0].listening, "apply 失败：{}", status[0].error);
        assert!(status[0].error.is_empty(), "{}", status[0].error);
        assert_eq!(status[0].target_ok, None, "内核转发无法做目标探测");
        let script = std::fs::read_to_string(dir.path().join(SCRIPT_FILE_NAME)).unwrap();
        assert!(script.contains("table inet pierwave"), "{script}");
    }

    /// nftables 脚本随期望态落盘，内容等价于本机转发规则；必须是 0600。
    #[cfg(unix)]
    #[test]
    fn script_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let path = dir.path().join(SCRIPT_FILE_NAME);
        write_script(&path, "table inet pierwave {}\n").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "nftables 脚本必须是 0600");
    }

    /// `nft -c` 语法探测失败（nft 太旧 / 内核不支持 numgen/vmap）时必须给出
    /// 可读错误并保持未监听，不能 panic，也不能误报 listening=true。
    #[cfg(unix)]
    #[tokio::test]
    async fn syntax_probe_failure_reports_readable_error() {
        let _permit = nft_permit().await;
        let dir = TempDir::new();
        let bin = fake_nft(
            dir.path(),
            r#"if [ "$1" = "-c" ]; then
  echo "Error: syntax error, unexpected vmap" >&2
  exit 1
fi
exit 0"#,
        );
        let mut supervisor = test_supervisor(bin, dir.path(), "0.0.0.0");
        assert!(
            !supervisor.available().await,
            "nft -c 失败时能力必须是不可用"
        );
        supervisor.apply(&[rule("f1", 8080, "1.2.3.4", 80)]).await;
        let status = supervisor.status_handle().snapshot();
        assert_eq!(status.len(), 1);
        assert!(!status[0].listening);
        assert!(
            status[0].error.contains("nft -c") && status[0].error.contains("numgen/vmap"),
            "错误必须说明是语法探测失败：{}",
            status[0].error
        );
    }

    /// 多目标规则真正落盘：2 个目标必须出现在 vmap 里，而不是只取第一个。
    #[cfg(unix)]
    #[tokio::test]
    async fn applies_multi_target_vmap_to_the_state_file() {
        let _permit = nft_permit().await;
        let dir = TempDir::new();
        let bin = fake_nft(dir.path(), "exit 0");
        let mut supervisor = test_supervisor(bin, dir.path(), "0.0.0.0");
        let mut spec = rule("f1", 8080, "1.1.1.1", 80);
        spec.targets = multi_targets();
        supervisor.apply(&[spec]).await;
        let status = supervisor.status_handle().snapshot();
        assert!(status[0].listening, "apply 失败：{}", status[0].error);
        let script = std::fs::read_to_string(dir.path().join(SCRIPT_FILE_NAME)).unwrap();
        assert!(
            script.contains(
                "numgen inc mod 2 vmap { 0 : dnat ip to 1.1.1.1:80, 1 : dnat ip to 2.2.2.2:8080 }"
            ),
            "{script}"
        );
    }

    /// nft -c 探针必须通过 stdin 收到合法脚本（而不是空文件），否则老 nft
    /// 的空 stdin 会直接成功，探测就形同虚设。
    #[cfg(unix)]
    #[tokio::test]
    async fn syntax_probe_feeds_the_script_to_stdin() {
        let _permit = nft_permit().await;
        let dir = TempDir::new();
        let log = dir.path().join("stdin");
        let bin = fake_nft(
            dir.path(),
            &format!(
                "if [ \"$1\" = \"-c\" ]; then cat > {}; fi\nexit 0",
                log.display()
            ),
        );
        let mut supervisor = test_supervisor(bin, dir.path(), "0.0.0.0");
        assert!(
            supervisor.available().await,
            "PATH 中有可执行 nft 时必须判定可用"
        );
        let probe = std::fs::read_to_string(log).unwrap();
        assert!(probe.contains("numgen inc mod 2 vmap"), "{probe}");
        assert!(probe.contains("jhash ip saddr mod 2"), "{probe}");
    }

    /// 表里的 counter 必须按 (端口, 协议) 汇总到对应规则：both 规则取
    /// tcp+udp 之和作为入方向；出方向没有数据源，必须是 None 而不是 0。
    #[cfg(unix)]
    #[tokio::test]
    async fn heartbeat_reports_nftables_dnat_counters() {
        let _permit = nft_permit().await;
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
        let mut supervisor = test_supervisor(bin, dir.path(), "0.0.0.0");
        supervisor.apply(&[rule("f1", 8080, "1.2.3.4", 80)]).await;
        let status = supervisor.status_handle().snapshot();
        assert_eq!(
            status[0].traffic_in,
            Some(1_200),
            "tcp 1000 + udp 200；listening={} error={}",
            status[0].listening,
            status[0].error
        );
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
        let _permit = nft_permit().await;
        let dir = TempDir::new();
        let bin = fake_nft(dir.path(), "exit 1");
        let mut supervisor = test_supervisor(bin, dir.path(), "0.0.0.0");
        supervisor.apply(&[rule("f1", 8080, "1.2.3.4", 80)]).await;
        let status = supervisor.status_handle().snapshot();
        assert_eq!(status.len(), 1);
        assert!(!status[0].listening);
        assert!(status[0].error.contains("nftables"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn empty_desired_state_cleans_the_table() {
        let _permit = nft_permit().await;
        let dir = TempDir::new();
        let log = dir.path().join("calls");
        let bin = fake_nft(
            dir.path(),
            &format!("echo \"$@\" >> {}\nexit 0", log.display()),
        );
        let mut supervisor = test_supervisor(bin, dir.path(), "0.0.0.0");
        supervisor.apply(&[rule("f1", 8080, "1.2.3.4", 80)]).await;
        supervisor.apply(&[]).await;
        assert!(supervisor.status_handle().snapshot().is_empty());
        let calls = std::fs::read_to_string(log).unwrap();
        assert!(calls.contains("delete table inet pierwave"), "{calls}");
    }

    /// P0 回归：`nft_bin` 默认是裸名 `nft`（从 PATH 取）。探测必须按 PATH
    /// 解析后执行，不能用 `fs::metadata("nft")` 去当前目录碰运气。
    #[cfg(unix)]
    #[tokio::test]
    async fn bare_nft_name_is_resolved_through_path() {
        let _permit = nft_permit().await;
        let dir = TempDir::new();
        fake_nft(dir.path(), "exit 0");
        let reason = unavailable_reason_with_path(
            Path::new("nft"),
            Some(dir.path().as_os_str()),
            TEST_PROBE_TIMEOUT,
        )
        .await;
        assert!(
            reason.is_none(),
            "PATH 中有可执行 nft 时必须判定可用，实际：{reason:?}"
        );
    }

    /// 裸名解析失败时按「未安装」处理；不能因为 cwd 里恰好有同名文件就误判。
    #[cfg(unix)]
    #[tokio::test]
    async fn bare_nft_name_missing_from_path_is_unavailable() {
        let dir = TempDir::new();
        let reason = unavailable_reason_with_path(
            Path::new("nft"),
            Some(dir.path().as_os_str()),
            TEST_PROBE_TIMEOUT,
        )
        .await;
        assert_eq!(reason.as_deref(), Some(NOT_AVAILABLE));
    }

    /// 探测必须自己限时：假 nft 挂住时在 2s 预算内返回「不可用」，
    /// 不能把 Agent 的主循环（心跳 / 读 WS）一起卡死。
    #[cfg(unix)]
    #[tokio::test]
    async fn capability_probe_times_out_instead_of_blocking_forever() {
        let _permit = nft_permit().await;
        let dir = TempDir::new();
        let bin = fake_nft(dir.path(), "exec sleep 30");
        // 走心跳同一条路径（available → probe_capability），只是不让测试
        // 放大预算：2s 是生产常量。
        let mut supervisor =
            NftablesSupervisor::new(bin, dir.path(), "0.0.0.0").with_probe_timeout(PROBE_TIMEOUT);
        let started = Instant::now();
        let available = supervisor.available().await;
        let elapsed = started.elapsed();
        assert!(!available, "挂住的 nft 必须判定不可用");
        assert!(
            elapsed < Duration::from_secs(4),
            "探测必须按 2s 超时返回，实际耗时 {elapsed:?}"
        );
    }

    /// 能力探测结果缓存 60s：心跳每 15s 读一次，不能每轮都 spawn。
    #[cfg(unix)]
    #[tokio::test]
    async fn capability_probe_is_cached_between_heartbeats() {
        let _permit = nft_permit().await;
        let dir = TempDir::new();
        let log = dir.path().join("calls");
        let bin = fake_nft(
            dir.path(),
            &format!("echo \"$@\" >> {}\nexit 0", log.display()),
        );
        let mut supervisor = test_supervisor(bin, dir.path(), "0.0.0.0");
        assert!(supervisor.available().await);
        let first = std::fs::read_to_string(&log).unwrap().lines().count();
        assert!(first >= 2, "首轮至少应探测 list tables 与 -c：{first}");

        assert!(supervisor.available().await);
        let second = std::fs::read_to_string(&log).unwrap().lines().count();
        assert_eq!(
            first, second,
            "60s 缓存内不能重复 spawn nft（首轮 {first} 次，第二轮 {second} 次）"
        );
    }

    /// 规则自带 listen_host 时，DNAT 只匹配该网卡地址，而不是所有本机地址。
    #[test]
    fn per_rule_listen_host_selects_that_daddr() {
        let mut spec = rule("f1", 8080, "1.2.3.4", 80);
        spec.listen_host = Some("10.0.0.2".into());
        let script = render_script(&[(spec, vec![ep("1.2.3.4:80")])], "0.0.0.0");
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
