//! 节点级带宽上限：在 Agent 侧用 `tc` 精确限速。
//!
//! 设计约束（P11-A）：
//!
//! * **只管理自己的 qdisc handle**（`1f00:`）。删除时只删 `handle 1f00:`，
//!   绝不 `tc qdisc del dev <iface> root`——那会把别人（机房、其它面板）的
//!   根队列一起删掉，直接把服务器网络打歪。
//! * **应用前先快照原始根队列**：`tc qdisc show dev <iface> root` 的 kind/参数
//!   写进 `tc-originals.json`。清理时先删自己的 handle，再把根队列恢复原样；
//!   认不出/无法重建的类型（htb、noqueue、空）回落到内核默认 `fq_codel`。
//! * **启动收敛残留**：进程被杀后 qdisc 可能还在。启动时扫描 `1f00:`，
//!   有残留就删掉并恢复（状态文件丢了就回落 `fq_codel`）。
//! * **只有配置了上限的节点才动 tc**。全部不限时一个写命令都不发；
//!   如果之前应用过，则删自己的 handle 并恢复原始根队列。
//! * **幂等**：每次 apply 先删自己的 handle 再重建，重复下发不会堆叠 class/filter。
//! * **失败只告警**：所有错误向上返回，由调用方 `tracing::warn!`，绝不影响
//!   xray 配置应用。也就是说「面板显示有限速、机器上实际没限」是可能的，
//!   核对方式：`tc qdisc show dev <iface>`、`tc class show dev <iface>`。
//! * **安全阀**：tc 应用成功后启动 30 秒倒计时，期间必须持续收到主控消息
//!   （desired/ping/ack）或心跳发送成功；失联超过 30 秒自动删掉自己的 qdisc
//!   并恢复原始根队列。**已知边界：SIGKILL/断电时安全阀随进程消失，规则会残留，
//!   靠下次 systemd 拉起时的启动收敛兜底。**
//! * **只限制下行**：tc 根 qdisc 是出向的，能限的是服务器→客户端方向。
//!   上行（客户端→服务器→目标）无法仅凭端口识别，本轮不覆盖。
//!
//! 出口网卡默认取默认路由所在网卡（`ip route show default`），可用
//! `tc_interface` 配置覆盖。

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use pierwave_proto::DesiredNode;
use serde::{Deserialize, Serialize};

/// 本模块独占的 qdisc handle。删除/替换都只认这个值。
pub const HANDLE: &str = "1f00:";
/// 默认 class（不匹配任何节点端口的流量走这里），必须存在，否则未限速流量会被丢。
const DEFAULT_CLASS: &str = "1";
/// 默认 class 的速率：足够大，等价于「不限速」。
const DEFAULT_RATE: &str = "100gbit";
/// 失联多久后自动拆掉自己的 qdisc。
pub const SAFETY_TTL: Duration = Duration::from_secs(30);
/// 认不出原始根队列时的回落类型（内核默认的主动队列管理）。
const FALLBACK_QDISC: &str = "fq_codel";

/// tc 的执行钩子；返回 stdout。测试注入假实现，生产走 [`run_tc`]。
pub type Runner = Box<dyn Fn(&[String]) -> io::Result<String> + Send + Sync>;
/// 出口网卡探测钩子；测试可注入固定网卡。
pub type Detector = Box<dyn Fn() -> Option<String> + Send + Sync>;

/// 一条已经规整过的节点限速：端口 + 上行/下行共用的 kbps。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRate {
    pub port: i64,
    pub bandwidth_kbps: i64,
}

/// 从期望态里挑出真正需要限速的节点：带宽 <= 0 / 端口非法的一律忽略。
///
/// 同一端口被多个节点引用时取更严格的档位，并按端口升序输出，
/// 保证同样的期望态生成逐字节相同的命令序列。
pub fn rates_from(nodes: &[DesiredNode]) -> Vec<NodeRate> {
    let mut rates: Vec<NodeRate> = Vec::new();
    for node in nodes {
        if node.bandwidth_kbps <= 0 || !(1..=65_535).contains(&node.port) {
            continue;
        }
        match rates.iter_mut().find(|rate| rate.port == node.port) {
            Some(existing) => {
                existing.bandwidth_kbps = existing.bandwidth_kbps.min(node.bandwidth_kbps)
            }
            None => rates.push(NodeRate {
                port: node.port,
                bandwidth_kbps: node.bandwidth_kbps,
            }),
        }
    }
    rates.sort_by_key(|rate| rate.port);
    rates
}

/// 一组要执行的 tc 命令。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TcPlan {
    pub interface: String,
    /// 先删自己的 handle（best-effort），再按顺序执行 setup。
    pub commands: Vec<Vec<String>>,
}

/// 构造完整命令序列；没有任何限速节点时返回 `None`。
pub fn build_plan(interface: &str, nodes: &[DesiredNode]) -> Option<TcPlan> {
    let rates = rates_from(nodes);
    if rates.is_empty() {
        return None;
    }

    let mut commands = Vec::with_capacity(2 + rates.len() * 5);
    commands.push(qdisc_args(interface));
    commands.push(default_class_args(interface));
    for (index, rate) in rates.iter().enumerate() {
        // class 1 留给默认流量；业务节点从 2 开始。
        let class = index as i64 + 2;
        commands.push(class_args(interface, class, rate.bandwidth_kbps));
        // 规范要求按节点端口匹配 `dport`；但 tc 根 qdisc 管的是**出向**流量，
        // 服务器→客户端这一方向（真正占节点带宽的下行）里节点端口在 source 侧。
        // 所以同时下发 dport / sport 两条规则到同一个 class：dport 满足约定，
        // sport 才是在真实链路上生效的那条。上行（客户端→服务器→目标）在
        // 出向网卡上无法仅凭端口识别，本轮不覆盖。
        for (family, match_family) in [("ip", "ip"), ("ipv6", "ip6")] {
            commands.push(filter_args(
                interface,
                family,
                match_family,
                "dport",
                rate.port,
                class,
            ));
            commands.push(filter_args(
                interface,
                family,
                match_family,
                "sport",
                rate.port,
                class,
            ));
        }
    }
    Some(TcPlan {
        interface: interface.to_string(),
        commands,
    })
}

fn qdisc_args(interface: &str) -> Vec<String> {
    vec![
        "tc".into(),
        "qdisc".into(),
        "replace".into(),
        "dev".into(),
        interface.into(),
        "root".into(),
        "handle".into(),
        HANDLE.into(),
        "htb".into(),
        // default 指向 class 1f00:1（无限速兜底），不能指向某个节点限速 class。
        "default".into(),
        DEFAULT_CLASS.into(),
    ]
}

fn default_class_args(interface: &str) -> Vec<String> {
    class_args_named(interface, DEFAULT_CLASS, DEFAULT_RATE, DEFAULT_RATE)
}

fn class_args(interface: &str, class: i64, kbps: i64) -> Vec<String> {
    let rate = format!("{kbps}kbit");
    class_args_named(interface, &class.to_string(), &rate, &rate)
}

fn class_args_named(interface: &str, class: &str, rate: &str, ceil: &str) -> Vec<String> {
    vec![
        "tc".into(),
        "class".into(),
        "replace".into(),
        "dev".into(),
        interface.into(),
        "parent".into(),
        HANDLE.into(),
        "classid".into(),
        format!("{HANDLE}{class}"),
        "htb".into(),
        "rate".into(),
        rate.into(),
        "ceil".into(),
        ceil.into(),
    ]
}

fn filter_args(
    interface: &str,
    family: &str,
    match_family: &str,
    direction: &str,
    port: i64,
    class: i64,
) -> Vec<String> {
    vec![
        "tc".into(),
        "filter".into(),
        // 用 add 而不是 replace：u32 的 replace 在没有显式 handle 时行为依赖
        // iproute2 版本；我们每次 apply 都先删 qdisc 再建，add 已经幂等。
        "add".into(),
        "dev".into(),
        interface.into(),
        "protocol".into(),
        family.into(),
        "parent".into(),
        HANDLE.into(),
        "prio".into(),
        "1".into(),
        "u32".into(),
        "match".into(),
        match_family.into(),
        direction.into(),
        port.to_string(),
        "0xffff".into(),
        "flowid".into(),
        format!("{HANDLE}{class}"),
    ]
}

/// 删除命令：**只删自己的 handle**，不带 `root` 通配。
fn delete_args(interface: &str) -> Vec<String> {
    vec![
        "tc".into(),
        "qdisc".into(),
        "del".into(),
        "dev".into(),
        interface.into(),
        "root".into(),
        "handle".into(),
        HANDLE.into(),
    ]
}

fn show_root_args(interface: &str) -> Vec<String> {
    vec![
        "tc".into(),
        "qdisc".into(),
        "show".into(),
        "dev".into(),
        interface.into(),
        "root".into(),
    ]
}

fn show_all_args() -> Vec<String> {
    vec!["tc".into(), "qdisc".into(), "show".into()]
}

/// 原始根队列的快照。`params` 是 `tc qdisc show` 里可回放的参数
/// （已去掉 `refcnt` 这类纯输出字段）；`raw` 只用于排障。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginalRoot {
    pub kind: String,
    #[serde(default)]
    pub params: String,
    #[serde(default)]
    pub raw: String,
}

impl OriginalRoot {
    fn fallback() -> Self {
        Self {
            kind: FALLBACK_QDISC.into(),
            params: String::new(),
            raw: String::new(),
        }
    }
}

/// `tc qdisc show dev <iface> root` 的解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
struct RootQdisc {
    kind: String,
    handle: String,
    params: String,
    raw: String,
}

/// 默认路由所在网卡。先 IPv4 再 IPv6；两条命令都失败/解析不到时返回 `None`。
pub fn detect_interface() -> Option<String> {
    for family in ["-4", "-6"] {
        let output = Command::new("ip")
            .args([family, "route", "show", "default"])
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        if let Some(interface) = parse_default_route(&String::from_utf8_lossy(&output.stdout)) {
            return Some(interface);
        }
    }
    None
}

/// 从 `ip route show default` 的输出里取 `dev <iface>`。
pub fn parse_default_route(raw: &str) -> Option<String> {
    for line in raw.lines() {
        let mut fields = line.split_whitespace();
        while let Some(field) = fields.next() {
            if field == "dev" {
                if let Some(interface) = fields.next() {
                    if !interface.is_empty() {
                        return Some(interface.to_string());
                    }
                }
            }
        }
    }
    None
}

fn run_tc(args: &[String]) -> io::Result<String> {
    let Some((program, rest)) = args.split_first() else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "tc 命令为空"));
    };
    let output = Command::new(program).args(rest).output()?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(io::Error::other(format!(
        "`{}` 失败（{}）：{}",
        args.join(" "),
        output.status,
        stderr.trim()
    )))
}

fn is_our_handle(handle: &str) -> bool {
    handle == HANDLE || handle.starts_with(HANDLE)
}

/// 解析 `tc qdisc show dev <iface> root` 的第一行。
fn parse_root_qdisc(raw: &str) -> Option<RootQdisc> {
    let line = raw
        .lines()
        .find(|line| line.trim_start().starts_with("qdisc "))?;
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() < 3 {
        return None;
    }
    let mut params = Vec::new();
    let mut skip = 0usize;
    for token in &tokens[3..] {
        if skip > 0 {
            skip -= 1;
            continue;
        }
        match *token {
            // 纯输出字段：`refcnt 2`、`dev eth0`（不带 dev 的查询不会出现）。
            "refcnt" | "dev" => skip = 1,
            "root" => {}
            other => params.push(other),
        }
    }
    Some(RootQdisc {
        kind: tokens[1].to_string(),
        handle: tokens[2].to_string(),
        params: params.join(" "),
        raw: line.trim().to_string(),
    })
}

/// 扫描 `tc qdisc show` 全量输出，找出带 `1f00:` 的网卡（启动残留）。
fn parse_residual_ifaces(raw: &str) -> Vec<String> {
    let mut ifaces = BTreeSet::new();
    for line in raw.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 3 || tokens[0] != "qdisc" || !is_our_handle(tokens[2]) {
            continue;
        }
        if let Some(index) = tokens.iter().position(|token| *token == "dev") {
            if let Some(interface) = tokens.get(index + 1) {
                ifaces.insert((*interface).to_string());
            }
        }
    }
    ifaces.into_iter().collect()
}

/// 原始 kind 能否安全回放；htb 的 class/filter 树无法从一行描述重建，直接回落。
fn can_restore_kind(kind: &str) -> bool {
    !matches!(kind.trim(), "" | "htb" | "noqueue" | "ingress" | "clsact")
}

/// 恢复命令：优先原 kind + 参数，认不出时回落 `fq_codel`（不带参数）。
fn restore_args(interface: &str, original: Option<&OriginalRoot>) -> Vec<String> {
    let kind = original
        .map(|original| original.kind.trim())
        .filter(|kind| !kind.is_empty())
        .unwrap_or(FALLBACK_QDISC);
    if !can_restore_kind(kind) {
        return fallback_restore_args(interface);
    }
    let mut args = vec![
        "tc".into(),
        "qdisc".into(),
        "replace".into(),
        "dev".into(),
        interface.into(),
        "root".into(),
        kind.into(),
    ];
    if let Some(original) = original {
        args.extend(original.params.split_whitespace().map(str::to_string));
    }
    args
}

fn fallback_restore_args(interface: &str) -> Vec<String> {
    vec![
        "tc".into(),
        "qdisc".into(),
        "replace".into(),
        "dev".into(),
        interface.into(),
        "root".into(),
        FALLBACK_QDISC.into(),
    ]
}

fn read_origins(path: &Path) -> BTreeMap<String, OriginalRoot> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    match serde_json::from_str(&text) {
        Ok(origins) => origins,
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "读取 tc 原始根队列状态失败，按空状态处理");
            BTreeMap::new()
        }
    }
}

fn write_origins(path: &Path, origins: &BTreeMap<String, OriginalRoot>) -> io::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let bytes = serde_json::to_vec_pretty(origins).map_err(io::Error::other)?;
    std::fs::write(&tmp, bytes)?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(())
}

/// tc 状态机：只在有限速节点时下发；应用前后负责快照/恢复原始根队列。
pub struct TcManager {
    /// 配置覆盖的出口网卡；空/None 时自动探测。
    interface: Option<String>,
    /// 原始根队列状态文件。
    state_path: PathBuf,
    /// iface -> 原始根队列快照。
    origins: BTreeMap<String, OriginalRoot>,
    applied: Option<Applied>,
    run: Runner,
    detect: Detector,
}

struct Applied {
    interface: String,
    /// 最近一次确认主控链路正常的时间。
    last_contact: Instant,
}

impl TcManager {
    pub fn new(interface: Option<String>, state_path: PathBuf) -> Self {
        Self {
            interface: interface
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            origins: read_origins(&state_path),
            state_path,
            applied: None,
            run: Box::new(run_tc),
            detect: Box::new(detect_interface),
        }
    }

    #[cfg(test)]
    fn with_hooks(
        interface: Option<String>,
        state_path: PathBuf,
        run: Runner,
        detect: Detector,
    ) -> Self {
        Self {
            interface: interface
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            origins: read_origins(&state_path),
            state_path,
            applied: None,
            run,
            detect,
        }
    }

    /// 启动时收敛上一次进程留下的 `1f00:` qdisc。
    ///
    /// 状态文件在就按记录的原始 kind/参数恢复；不在（被删/写失败）就回落
    /// `fq_codel`。宁可不知道原来是什么，也不能把自己的 htb 留在机器上。
    pub fn recover_startup(&mut self) {
        let output = match (self.run)(&show_all_args()) {
            Ok(output) => output,
            Err(error) => {
                tracing::warn!(%error, "启动时扫描残留 qdisc 失败（tc 不可用？）");
                return;
            }
        };
        let residual = parse_residual_ifaces(&output);
        if residual.is_empty() {
            // 机器重启过或已恢复：状态文件里的旧条目已经没用，清掉避免误恢复。
            if !self.origins.is_empty() {
                self.origins.clear();
                self.save_origins();
            }
            return;
        }

        for interface in &residual {
            tracing::warn!(
                interface = %interface,
                "启动时发现残留的节点限速 qdisc，删除并恢复原始根队列"
            );
            self.drop_and_restore(interface);
        }
        // 没有残留的 iface 不再保留旧快照。
        self.origins
            .retain(|interface, _| residual.contains(interface));
        self.save_origins();
    }

    /// 收敛到期望态的限速。没有限速节点时最多只清理自己的旧规则。
    ///
    /// 失败返回 `Err`，调用方只 `warn!`；这里不会 panic，也不会影响 xray。
    pub fn apply(&mut self, nodes: &[DesiredNode], now: Instant) -> Result<()> {
        let rates = rates_from(nodes);
        if rates.is_empty() {
            // 旧规则存在时清掉并恢复原始根队列；从未应用过就一个写命令都不发。
            if let Some(previous) = self.applied.take() {
                self.drop_and_restore(&previous.interface);
            }
            return Ok(());
        }

        let interface = match self.interface.clone().or_else(|| (self.detect)()) {
            Some(interface) => interface,
            None => anyhow::bail!("无法探测出口网卡，跳过节点限速（可用 tc_interface 配置指定）"),
        };

        // 换网卡/重配前先清旧规则，避免旧规则残留在另一张网卡上。
        if let Some(previous) = self.applied.take() {
            if previous.interface != interface {
                self.drop_and_restore(&previous.interface);
            }
        }

        // 快照必须发生在替换 root 之前；如果当前 root 已经是我们的 handle，
        // 说明这是重复 apply 或上次进程的残留，不能把 htb 当成「原始」。
        let current = self.show_root(&interface)?;
        let ours = current
            .as_ref()
            .is_some_and(|qdisc| is_our_handle(&qdisc.handle));
        if !ours {
            let original = current.map(|qdisc| OriginalRoot {
                kind: qdisc.kind,
                params: qdisc.params,
                raw: qdisc.raw,
            });
            self.origins.insert(
                interface.clone(),
                original.unwrap_or_else(OriginalRoot::fallback),
            );
            self.save_origins();
        }

        let plan = build_plan(&interface, nodes).expect("rates 非空时一定有命令");
        // 幂等：先删自己的 handle，再重建，重复 apply 不会堆叠 filter。
        // 删除失败（本来就没有）是正常情况，忽略。
        let _ = (self.run)(&delete_args(&interface));

        for command in &plan.commands {
            if let Err(error) = (self.run)(command) {
                // 半应用比不限速更危险：删掉半成品并把根队列恢复原状。
                self.drop_and_restore(&interface);
                self.applied = None;
                return Err(error)
                    .with_context(|| format!("应用节点限速失败（网卡 {interface}），已尝试清理"));
            }
        }

        self.applied = Some(Applied {
            interface: interface.clone(),
            last_contact: now,
        });
        tracing::info!(
            %interface,
            nodes = rates.len(),
            "节点限速已应用（handle {HANDLE}，仅限制下行 / download only）"
        );
        Ok(())
    }

    /// 主控消息到达 / 心跳发送成功时调用；没有应用过 tc 时是 no-op。
    pub fn mark_contact(&mut self, now: Instant) {
        if let Some(applied) = &mut self.applied {
            applied.last_contact = now;
        }
    }

    /// 主动清理（升级退出 / SIGTERM 退出前用）。失败只告警。
    pub fn cleanup(&mut self) {
        if let Some(applied) = self.applied.take() {
            self.drop_and_restore(&applied.interface);
        }
    }

    /// 检查安全阀。返回 `true` 表示这次确实尝试了清理。
    ///
    /// 时间由调用方注入，单元测试可以用假的 `Instant` 推进 30 秒。
    pub fn safety_check(&mut self, now: Instant) -> bool {
        let Some(applied) = &self.applied else {
            return false;
        };
        if now.saturating_duration_since(applied.last_contact) < SAFETY_TTL {
            return false;
        }
        let interface = applied.interface.clone();
        self.applied = None;
        tracing::warn!(
            %interface,
            ttl_secs = SAFETY_TTL.as_secs(),
            "安全阀触发：超过时限没有收到主控消息，删除节点限速并恢复原始根队列"
        );
        self.drop_and_restore(&interface);
        true
    }

    fn show_root(&self, interface: &str) -> Result<Option<RootQdisc>> {
        let output = (self.run)(&show_root_args(interface))
            .with_context(|| format!("读取 {interface} 的原始根队列失败"))?;
        Ok(parse_root_qdisc(&output))
    }

    /// 先删自己的 handle，再恢复原始根队列。
    fn drop_and_restore(&mut self, interface: &str) {
        if let Err(error) = (self.run)(&delete_args(interface)) {
            tracing::warn!(%interface, %error, "删除自己的 qdisc 失败（可能本来就不存在）");
        }
        self.restore_root(interface);
    }

    fn restore_root(&mut self, interface: &str) {
        let original = self.origins.get(interface).cloned();
        let restore = restore_args(interface, original.as_ref());
        match (self.run)(&restore) {
            Ok(_) => {
                tracing::info!(
                    %interface,
                    kind = %restore[6],
                    "已恢复原始根队列"
                );
            }
            Err(error) => {
                tracing::warn!(%interface, %error, "恢复原始根队列失败，尝试回落 fq_codel");
                let fallback = fallback_restore_args(interface);
                if restore != fallback {
                    match (self.run)(&fallback) {
                        Ok(_) => tracing::warn!(%interface, "已回落到 fq_codel 根队列"),
                        Err(error) => {
                            tracing::warn!(%interface, %error, "回落 fq_codel 也失败，请人工检查 tc")
                        }
                    }
                }
            }
        }
        self.origins.remove(interface);
        self.save_origins();
    }

    fn save_origins(&self) {
        if let Err(error) = write_origins(&self.state_path, &self.origins) {
            tracing::warn!(
                path = %self.state_path.display(),
                %error,
                "保存 tc 原始根队列状态失败（崩溃后只能回落 fq_codel）"
            );
        }
    }

    /// 当前是否有已应用的限速规则（仅测试使用）。
    #[cfg(test)]
    pub fn is_applied(&self) -> bool {
        self.applied.is_some()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    fn node(port: i64, bandwidth_kbps: i64) -> DesiredNode {
        DesiredNode {
            id: format!("node-{port}"),
            tag: format!("tag-{port}"),
            port,
            bandwidth_kbps,
        }
    }

    /// 每个用例自己的状态文件，Drop 时删掉。
    struct TempState(PathBuf);

    impl TempState {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("pierwave-tc-test-{}.json", uuid::Uuid::new_v4()));
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempState {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            let mut tmp = self.0.as_os_str().to_os_string();
            tmp.push(".tmp");
            let _ = std::fs::remove_file(PathBuf::from(tmp));
        }
    }

    /// 假 tc：记录命令；`show` 返回可配置的根队列/全量输出。
    struct FakeTc {
        calls: Arc<Mutex<Vec<Vec<String>>>>,
        root: Arc<Mutex<String>>,
        all: Arc<Mutex<String>>,
        fail_classes: bool,
        fail_show: bool,
        fail_restore_params: Arc<Mutex<bool>>,
    }

    impl FakeTc {
        fn new() -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                root: Arc::new(Mutex::new(
                    "qdisc fq_codel 0: root refcnt 2 limit 10240p flows 1024\n".into(),
                )),
                all: Arc::new(Mutex::new(String::new())),
                fail_classes: false,
                fail_show: false,
                fail_restore_params: Arc::new(Mutex::new(false)),
            }
        }

        fn with_root(self, root: &str) -> Self {
            *self.root.lock().unwrap() = root.into();
            self
        }

        fn with_all(self, all: &str) -> Self {
            *self.all.lock().unwrap() = all.into();
            self
        }

        fn failing_classes(mut self) -> Self {
            self.fail_classes = true;
            self
        }

        fn failing_show(mut self) -> Self {
            self.fail_show = true;
            self
        }

        fn set_failing_restore_params(&self) {
            *self.fail_restore_params.lock().unwrap() = true;
        }

        fn runner(&self) -> Runner {
            let calls = self.calls.clone();
            let root = self.root.clone();
            let all = self.all.clone();
            let fail_classes = self.fail_classes;
            let fail_show = self.fail_show;
            let fail_restore_params = self.fail_restore_params.clone();
            Box::new(move |args: &[String]| {
                calls.lock().unwrap().push(args.to_vec());
                let is_show = args.get(1).map(String::as_str) == Some("qdisc")
                    && args.get(2).map(String::as_str) == Some("show");
                if is_show {
                    if fail_show {
                        return Err(io::Error::other("show boom"));
                    }
                    if args.len() > 3 {
                        return Ok(root.lock().unwrap().clone());
                    }
                    return Ok(all.lock().unwrap().clone());
                }
                if fail_classes && args.get(1).map(String::as_str) == Some("class") {
                    return Err(io::Error::other("class boom"));
                }
                // 模拟「带参数恢复被内核拒绝」：只接受裸 fq_codel。
                if *fail_restore_params.lock().unwrap()
                    && args.get(1).map(String::as_str) == Some("qdisc")
                    && args.get(2).map(String::as_str) == Some("replace")
                    && args.iter().any(|arg| arg == "limit")
                {
                    return Err(io::Error::other("param rejected"));
                }
                Ok(String::new())
            })
        }

        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }

        fn clear_calls(&self) {
            self.calls.lock().unwrap().clear();
        }
    }

    fn manager(fake: &FakeTc, state: &TempState) -> TcManager {
        TcManager::with_hooks(
            Some("eth0".into()),
            state.path().to_path_buf(),
            fake.runner(),
            Box::new(|| Some("eth0".into())),
        )
    }

    fn read_state(state: &TempState) -> BTreeMap<String, OriginalRoot> {
        read_origins(state.path())
    }

    fn restore_kind(call: &[String]) -> Option<&str> {
        if call.get(1).map(String::as_str) == Some("qdisc")
            && call.get(2).map(String::as_str) == Some("replace")
        {
            call.get(6).map(String::as_str)
        } else {
            None
        }
    }

    #[test]
    fn builds_expected_tc_command_shape() {
        let plan = build_plan("eth0", &[node(443, 100_000), node(8443, 20_000)]).unwrap();

        assert_eq!(
            plan.commands[0],
            vec![
                "tc", "qdisc", "replace", "dev", "eth0", "root", "handle", "1f00:", "htb",
                "default", "1",
            ]
        );
        // 默认 class：兜住不匹配任何节点端口的流量，不能被限速。
        assert_eq!(
            plan.commands[1],
            vec![
                "tc", "class", "replace", "dev", "eth0", "parent", "1f00:", "classid", "1f00:1",
                "htb", "rate", "100gbit", "ceil", "100gbit",
            ]
        );
        assert_eq!(
            plan.commands[2],
            vec![
                "tc",
                "class",
                "replace",
                "dev",
                "eth0",
                "parent",
                "1f00:",
                "classid",
                "1f00:2",
                "htb",
                "rate",
                "100000kbit",
                "ceil",
                "100000kbit",
            ]
        );
        // 节点 443：IPv4/IPv6 × dport/sport，四个 filter 都指向同一个 class。
        let filters: Vec<&Vec<String>> = plan.commands[3..7].iter().collect();
        assert_eq!(filters.len(), 4);
        assert_eq!(filters[0][6], "ip");
        assert_eq!(filters[0][13], "ip");
        assert_eq!(filters[0][14], "dport");
        assert_eq!(filters[0][15], "443");
        assert_eq!(filters[0][18], "1f00:2");
        assert_eq!(filters[1][14], "sport");
        assert_eq!(filters[1][15], "443");
        assert_eq!(filters[2][6], "ipv6");
        assert_eq!(filters[2][13], "ip6");
        assert_eq!(filters[2][14], "dport");
        assert_eq!(filters[3][13], "ip6");
        assert_eq!(filters[3][14], "sport");
        assert_eq!(filters[3][18], "1f00:2");
        // 第二个节点从 class 3 开始。
        assert_eq!(plan.commands[7][11], "20000kbit");
        assert_eq!(plan.commands[8][15], "8443");
        assert_eq!(plan.commands[8][18], "1f00:3");
        assert_eq!(plan.commands[11][14], "sport");
    }

    #[test]
    fn repeated_plan_is_byte_identical() {
        let nodes = [node(8443, 20_000), node(443, 100_000)];
        let first = build_plan("eth0", &nodes).unwrap();
        let second = build_plan("eth0", &nodes).unwrap();
        assert_eq!(first, second, "同样的期望态必须得到同样的命令");
        // 输入顺序不同也要稳定：按端口排序。
        let reversed = [node(443, 100_000), node(8443, 20_000)];
        assert_eq!(build_plan("eth0", &reversed).unwrap(), first);
    }

    #[test]
    fn no_limit_means_no_tc_at_all() {
        let fake = FakeTc::new();
        let state = TempState::new();
        let mut manager = manager(&fake, &state);

        // 0 与缺失都算不限；没有任何有限速的节点。
        manager
            .apply(&[node(443, 0), node(8443, 0)], Instant::now())
            .unwrap();
        assert!(!manager.is_applied());
        assert!(
            fake.calls().is_empty(),
            "没有限额时不能调用 tc（连 show 都不该调）：{:?}",
            fake.calls()
        );
    }

    #[test]
    fn applying_snapshots_root_then_removes_only_own_handle() {
        let fake = FakeTc::new();
        let state = TempState::new();
        let mut manager = manager(&fake, &state);

        manager
            .apply(&[node(443, 100_000)], Instant::now())
            .unwrap();

        let calls = fake.calls();
        assert_eq!(calls[0], show_root_args("eth0"), "替换前必须先快照 root");
        assert_eq!(calls[1], delete_args("eth0"), "重建前先删自己的 handle");
        assert_eq!(calls[2], qdisc_args("eth0"));
        assert!(
            calls.iter().all(|call| {
                !(call.get(1) == Some(&"qdisc".to_string())
                    && call.get(2) == Some(&"del".to_string())
                    && call.get(5) == Some(&"root".to_string())
                    && call.len() == 6)
            }),
            "绝不能出现 `tc qdisc del dev <iface> root`（无 handle）的删除：{calls:?}"
        );
        assert_eq!(calls[1][7], "1f00:", "删除命令必须只认自己的 handle");

        let origins = read_state(&state);
        assert_eq!(origins["eth0"].kind, "fq_codel");
        assert!(
            origins["eth0"].params.contains("limit 10240p"),
            "状态文件必须记录参数：{:?}",
            origins["eth0"]
        );
    }

    #[test]
    fn removal_restores_the_original_root_qdisc() {
        let fake = FakeTc::new();
        let state = TempState::new();
        let mut manager = manager(&fake, &state);
        manager
            .apply(&[node(443, 100_000)], Instant::now())
            .unwrap();
        fake.clear_calls();

        manager.apply(&[], Instant::now()).unwrap();

        assert!(!manager.is_applied());
        let calls = fake.calls();
        assert_eq!(
            calls.len(),
            2,
            "清空限速 = 删 handle + 恢复 root：{calls:?}"
        );
        assert_eq!(calls[0], delete_args("eth0"));
        assert_eq!(restore_kind(&calls[1]), Some("fq_codel"));
        assert!(
            calls[1].contains(&"limit".to_string()),
            "恢复命令应带原始参数：{:?}",
            calls[1]
        );
        assert!(read_state(&state).is_empty(), "恢复后状态文件应清空");
    }

    #[test]
    fn htb_original_falls_back_to_fq_codel() {
        let fake = FakeTc::new().with_root("qdisc htb 1: root refcnt 2 r2q 10 default 30\n");
        let state = TempState::new();
        let mut manager = manager(&fake, &state);
        manager
            .apply(&[node(443, 100_000)], Instant::now())
            .unwrap();
        assert_eq!(read_state(&state)["eth0"].kind, "htb");
        fake.clear_calls();

        manager.apply(&[], Instant::now()).unwrap();

        let calls = fake.calls();
        assert_eq!(restore_kind(&calls[1]), Some("fq_codel"));
        assert_eq!(calls[1], fallback_restore_args("eth0"));
    }

    #[test]
    fn safety_valve_fires_only_after_ttl_without_contact() {
        let fake = FakeTc::new();
        let state = TempState::new();
        let mut manager = manager(&fake, &state);
        let start = Instant::now();
        manager.apply(&[node(443, 100_000)], start).unwrap();
        fake.clear_calls();

        assert!(!manager.safety_check(start + Duration::from_secs(29)));
        assert!(fake.calls().is_empty(), "未到 30 秒不能删");

        assert!(manager.safety_check(start + Duration::from_secs(30)));
        assert!(!manager.is_applied());
        let calls = fake.calls();
        assert_eq!(calls.len(), 2, "安全阀 = 删 handle + 恢复 root");
        assert_eq!(calls[0], delete_args("eth0"));
        assert_eq!(restore_kind(&calls[1]), Some("fq_codel"));

        // 已经拆干净后继续检查是 no-op。
        assert!(!manager.safety_check(start + Duration::from_secs(600)));
        assert_eq!(fake.calls().len(), 2);
    }

    #[test]
    fn contact_refreshes_the_safety_valve() {
        let fake = FakeTc::new();
        let state = TempState::new();
        let mut manager = manager(&fake, &state);
        let start = Instant::now();
        manager.apply(&[node(443, 100_000)], start).unwrap();
        fake.clear_calls();

        // 每 15 秒一次心跳：永远不应触发安全阀。
        for tick in 1..=10 {
            let now = start + Duration::from_secs(tick * 15);
            manager.mark_contact(now);
            assert!(!manager.safety_check(now));
        }
        assert!(fake.calls().is_empty());

        // 最后一次联系之后再失联 30 秒：触发。
        let last = start + Duration::from_secs(150);
        assert!(manager.safety_check(last + Duration::from_secs(30)));
        assert_eq!(fake.calls().len(), 2);
    }

    #[test]
    fn failed_apply_cleans_up_and_does_not_arm() {
        let fake = FakeTc::new().failing_classes();
        let state = TempState::new();
        let mut manager = manager(&fake, &state);

        let error = manager
            .apply(&[node(443, 100_000)], Instant::now())
            .unwrap_err();
        assert!(error.to_string().contains("应用节点限速失败"), "{error}");
        assert!(!manager.is_applied(), "失败后不能武装安全阀");
        // 最后两步是「删自己的 handle + 恢复原始 root」。
        let calls = fake.calls();
        let tail = &calls[calls.len() - 2..];
        assert_eq!(tail[0], delete_args("eth0"));
        assert_eq!(restore_kind(&tail[1]), Some("fq_codel"));
        assert!(read_state(&state).is_empty());
    }

    #[test]
    fn startup_residual_without_state_falls_back_to_fq_codel() {
        let fake = FakeTc::new().with_all("qdisc htb 1f00: dev eth0 root refcnt 2 default 1\n");
        let state = TempState::new();
        let mut manager = manager(&fake, &state);

        manager.recover_startup();

        let calls = fake.calls();
        assert_eq!(calls[0], show_all_args());
        assert_eq!(calls[1], delete_args("eth0"));
        assert_eq!(calls[2], fallback_restore_args("eth0"));
    }

    #[test]
    fn startup_residual_uses_saved_original_kind() {
        let fake = FakeTc::new().with_all("qdisc htb 1f00: dev eth0 root refcnt 2 default 1\n");
        let state = TempState::new();
        let saved = BTreeMap::from([(
            "eth0".to_string(),
            OriginalRoot {
                kind: "fq_codel".into(),
                params: "limit 1024p".into(),
                raw: "qdisc fq_codel 0: root refcnt 2 limit 1024p".into(),
            },
        )]);
        write_origins(state.path(), &saved).unwrap();
        let mut manager = manager(&fake, &state);

        manager.recover_startup();

        let calls = fake.calls();
        assert_eq!(calls[1], delete_args("eth0"));
        assert_eq!(restore_kind(&calls[2]), Some("fq_codel"));
        assert!(calls[2].contains(&"limit".to_string()));
        assert!(read_state(&state).is_empty());
    }

    #[test]
    fn startup_without_residual_clears_stale_state() {
        let fake = FakeTc::new();
        let state = TempState::new();
        let saved = BTreeMap::from([(
            "eth0".to_string(),
            OriginalRoot {
                kind: "fq_codel".into(),
                params: String::new(),
                raw: String::new(),
            },
        )]);
        write_origins(state.path(), &saved).unwrap();
        let mut manager = manager(&fake, &state);

        manager.recover_startup();

        assert_eq!(fake.calls(), vec![show_all_args()]);
        assert!(read_state(&state).is_empty());
    }

    #[test]
    fn apply_refuses_to_touch_root_when_snapshot_fails() {
        let fake = FakeTc::new().failing_show();
        let state = TempState::new();
        let mut manager = manager(&fake, &state);

        let error = manager
            .apply(&[node(443, 100_000)], Instant::now())
            .unwrap_err();
        assert!(error.to_string().contains("原始根队列"), "{error}");
        assert!(!manager.is_applied());

        // 只看 root，不能删/替换：没有快照就不该动别人的根队列。
        let calls = fake.calls();
        assert_eq!(calls, vec![show_root_args("eth0")]);
    }

    #[test]
    fn restore_falls_back_to_bare_fq_codel_when_params_rejected() {
        let fake = FakeTc::new();
        let state = TempState::new();
        let mut manager = manager(&fake, &state);
        manager
            .apply(&[node(443, 100_000)], Instant::now())
            .unwrap();
        fake.clear_calls();

        // 之后所有带 limit 参数的恢复都会被内核拒绝。
        fake.set_failing_restore_params();
        manager.apply(&[], Instant::now()).unwrap();

        let calls = fake.calls();
        assert_eq!(
            calls.len(),
            3,
            "删 handle → 带参恢复失败 → 裸 fq_codel：{calls:?}"
        );
        assert_eq!(calls[0], delete_args("eth0"));
        assert!(calls[1].contains(&"limit".to_string()));
        assert_eq!(calls[2], fallback_restore_args("eth0"));
        assert!(read_state(&state).is_empty());
    }

    #[test]
    fn detects_interface_from_default_route() {
        assert_eq!(
            parse_default_route(
                "default via 192.0.2.1 dev eth0 proto dhcp src 192.0.2.10 metric 100\n"
            ),
            Some("eth0".into())
        );
        assert_eq!(
            parse_default_route("default dev wg0 scope link\n"),
            Some("wg0".into())
        );
        assert_eq!(parse_default_route(""), None);
        assert_eq!(parse_default_route("default via 192.0.2.1\n"), None);
    }

    #[test]
    fn parses_root_qdisc_and_strips_output_only_fields() {
        let parsed = parse_root_qdisc(
            "qdisc fq_codel 0: root refcnt 2 limit 10240p flows 1024 quantum 1514 target 5ms\n",
        )
        .unwrap();
        assert_eq!(parsed.kind, "fq_codel");
        assert_eq!(parsed.handle, "0:");
        assert!(!parsed.params.contains("refcnt"));
        assert!(parsed.params.starts_with("limit 10240p"));

        let mq = parse_root_qdisc("qdisc mq 0: root refcnt 9\n").unwrap();
        assert_eq!(mq.kind, "mq");
        assert!(mq.params.is_empty());

        assert!(parse_root_qdisc("").is_none());
        assert!(parse_root_qdisc("garbage\n").is_none());
    }

    #[test]
    fn parses_residual_interfaces_from_full_qdisc_show() {
        let raw = "qdisc htb 1f00: dev eth0 root refcnt 2 default 1\n\
                   qdisc fq_codel 0: dev eth1 root refcnt 2 limit 1024p\n\
                   qdisc htb 1f01: dev eth2 root refcnt 2 default 1\n";
        assert_eq!(parse_residual_ifaces(raw), vec!["eth0".to_string()]);
        assert!(parse_residual_ifaces("qdisc fq_codel 0: dev eth0 root\n").is_empty());
    }

    #[test]
    fn invalid_ports_and_nonpositive_limits_are_ignored() {
        assert!(build_plan("eth0", &[node(0, 1000)]).is_none());
        assert!(build_plan("eth0", &[node(70000, 1000)]).is_none());
        assert!(build_plan("eth0", &[node(443, -1)]).is_none());
        // 同端口取更严格的档位。
        let plan = build_plan("eth0", &[node(443, 100_000), node(443, 10_000)]).unwrap();
        assert!(plan.commands[2].contains(&"10000kbit".to_string()));
    }
}
