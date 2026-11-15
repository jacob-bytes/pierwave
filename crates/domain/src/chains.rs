//! 线性多跳链的纯校验逻辑。
//!
//! 链的推导（哪一跳转到哪台服务器的 address:port）在 master 侧完成，
//! 因为它产出的是跨端 DTO `DesiredForward`；本模块只放「不查库」的规则：
//! 组数、组内成员数、重复服务器、选路策略、名称，以及「连续失败几次算降级」。
//!
//! 目标地址/端口、监听端口范围、保留端口、自连回环都复用
//! [`crate::forwards`] 里的现有函数，避免两套口径。

use std::collections::{HashMap, HashSet};

use serde_json::json;

use crate::error::DomainError;
use crate::models::{Certificate, Chain, ChainGroupWithMembers};
use crate::{engine, hop_transport, protocol, tunnel_security};

/// 一条链最少 1 跳（入口直接指向 target）。
pub const MIN_HOPS: usize = 1;

/// 一条链最多 6 跳。
///
/// 这是**产品规格**，不是技术硬限制：每多一跳就多一次 TCP 中转，
/// 端到端延迟、故障点和排查成本都随之线性增长；6 跳已能覆盖
/// 「国内入口 → 中转 → 中转 → 落地 → 落地 → 目标」这类极端线路组合。
/// 可用率是逐跳相乘的：单跳 98% 时 4 跳约 92%、6 跳约 89%，再长就没有实际意义。
/// 若要放开，需要同时评估：拓扑 UI 的横向容量、逐跳延迟的归因难度、
/// 以及链路上任何一台故障都会整链中断的可用性代价。
pub const MAX_HOPS: usize = 6;

/// 一个组最少 1 台成员。
pub const MIN_GROUP_MEMBERS: usize = 1;

/// 一个组最多 8 台成员；再多的候选池对单条链没有收益，只会放大端口冲突面。
pub const MAX_GROUP_MEMBERS: usize = 8;

/// 中间跳自动分配监听端口的池起点（含）。
///
/// 池范围固定为 `20000..=29999`：[`PORT_POOL_START`]..=[`PORT_POOL_END`]。
pub const PORT_POOL_START: i64 = 20_000;

/// 中间跳自动分配监听端口的池终点（含）。
pub const PORT_POOL_END: i64 = 29_999;

/// 链名称最大字符数，与单跳转发保持一致。
pub const NAME_MAX_CHARS: usize = crate::forwards::NAME_MAX_CHARS;

/// 组名最大字符数，与链名保持一致。
pub const GROUP_NAME_MAX_CHARS: usize = NAME_MAX_CHARS;

/// 连续多少次 `target_ok=false` 判定为降级。
pub const DEGRADED_AFTER_FAILURES: i64 = 2;

/// 链推导出的 `DesiredForward.id` 前缀；与独立转发的 `fwd-` 前缀区分开。
pub const FORWARD_ID_PREFIX: &str = "chain-";

/// 隧道链最少 2 跳：入口 Dialer + 出口 Listener。
pub const TUNNEL_MIN_HOPS: usize = 2;

/// 隧道链最多 6 跳（中间跳 1..=4 个）；与全局 [`MAX_HOPS`] 一致。
pub const TUNNEL_MAX_HOPS: usize = MAX_HOPS;

/// 3+ 跳隧道需要的最低 Agent 线协议版本。
///
/// 旧 Agent 不认识 `TunnelSpec.downstream`，会把中间跳当成出口 Listener 直接
/// 连首帧目标，静默截短跳数。与 `pierwave_proto::PROTOCOL_VERSION` 必须保持一致
/// （master 有断言测试）。
pub const TUNNEL_MULTIHOP_MIN_PROTOCOL_VERSION: i64 = 24;

/// Noise 模式 + UDP 中继需要的最低 Agent 线协议版本。
///
/// Noise 的 QUIC 用 `hop_secret` 确定性派生的自签证书 + 指纹固定（协议 25）。
/// 协议 24 及更早的 Agent 会直接拒绝 `noise + udp`、让整个端点启动失败，所以
/// 主控必须在保存/下发两条路径上要求两端都升级，绝不悄悄关掉 UDP 或降级。
/// 与 `pierwave_proto::TUNNEL_NOISE_UDP_PROTOCOL_VERSION` 必须一致（master 有断言）。
pub const TUNNEL_NOISE_UDP_MIN_PROTOCOL_VERSION: i64 = 25;

/// 组内选路策略的六个合法值（与 `PROTOCOL_VERSION = 27` 的线协议一致）。
pub const STRATEGY_NAMES: [&str; 6] = [
    "round_robin",
    "failover",
    "lowest_latency",
    "ip_hashed",
    "weighted",
    "least_conn",
];

/// 成员权重下限（含）。
pub const WEIGHT_MIN: i64 = 1;

/// 成员权重上限（含）。
pub const WEIGHT_MAX: i64 = 100;

/// 加权 / 最少连接需要的最低 Agent 线协议版本。
///
/// 旧 Agent 的 `ForwardStrategy` 没有这两个变体，收到后会让整份期望态解析失败
/// （同一台服务器上的所有转发一起消失）。与
/// `pierwave_proto::CHAIN_STRATEGY_PROTOCOL_VERSION` 必须一致（master 有断言）。
pub const STRATEGY_MIN_PROTOCOL_VERSION: i64 = 27;

/// nftables 多目标选路需要的最低 Agent 线协议版本。
///
/// 旧 Agent 的 nftables 引擎只接受单目标：收到多成员组会在 apply 时逐条报
/// `暂不支持多目标选路`，但主控仍会以为配置下发成功。主控据此在保存/下发
/// 两条路径上要求整条链的 Agent 升级，绝不静默降级成「只发第一个目标」。
///
/// 与线协议版本一起递增：多目标规则完全由 Agent 从 `DesiredForward.targets`
/// 推导，不需要新增协议字段；版本号就是能力信号。
pub const NFTABLES_MULTI_TARGET_MIN_PROTOCOL_VERSION: i64 = 29;

/// 领域层的选路策略。
///
/// 故意不直接复用 `pierwave_proto::ForwardStrategy`：domain 不依赖线协议，
/// 由 master 在推导时把这里的结果映射成 DTO。这样纯校验可以在 domain 里单测。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GroupStrategy {
    /// 按顺序轮流（默认）。
    #[default]
    RoundRobin,
    /// 主备：总是用第一个可用的，前面的通了就换回来。
    Failover,
    /// 只选当前探测延迟最低的。
    LowestLatency,
    /// 按客户端 IP 做一致性哈希。
    IpHashed,
    /// 按成员权重做平滑加权随机（协议 27 起）。
    Weighted,
    /// 选当前活跃连接数最少的成员，平局按轮询（协议 27 起）。
    LeastConn,
}

impl GroupStrategy {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RoundRobin => "round_robin",
            Self::Failover => "failover",
            Self::LowestLatency => "lowest_latency",
            Self::IpHashed => "ip_hashed",
            Self::Weighted => "weighted",
            Self::LeastConn => "least_conn",
        }
    }

    /// 是否只有协议 27+ 的 Agent 才认识。
    pub const fn requires_agent_v27(self) -> bool {
        matches!(self, Self::Weighted | Self::LeastConn)
    }

    /// 严格解析：只接受六个 snake_case 枚举值（大小写不敏感会掩盖配置错误）。
    pub fn parse(raw: &str) -> Result<Self, DomainError> {
        match raw.trim() {
            "round_robin" => Ok(Self::RoundRobin),
            "failover" => Ok(Self::Failover),
            "lowest_latency" => Ok(Self::LowestLatency),
            "ip_hashed" => Ok(Self::IpHashed),
            "weighted" => Ok(Self::Weighted),
            "least_conn" => Ok(Self::LeastConn),
            other => Err(DomainError::with_params(
                "chain.strategy_invalid",
                json!({ "strategy": other, "allowed": STRATEGY_NAMES }),
                format!(
                    "选路策略「{other}」无效，只支持 {}",
                    STRATEGY_NAMES.join(" / ")
                ),
            )),
        }
    }

    /// 从数据库里读出的策略：非法值回落到轮询，保证旧数据不会让整条链下发失败。
    ///
    /// 注意：新策略（weighted / least_conn）能被正常解析，**不会**走到回落；
    /// 旧 Agent 无法理解它们时由 [`strategy_blocked_reason`] 整链阻断，
    /// 绝不静默降级成轮询。
    pub fn from_db(raw: &str) -> Self {
        Self::parse(raw).unwrap_or_default()
    }
}

/// 成员权重必须是 1–100 的整数。
///
/// 历史行 / 旧链没有显式权重时由迁移与列默认值给出 1，因此旧数据天然通过。
/// 错误码 `chain.weight_invalid` 由前端词典翻译。
pub fn validate_weight(weight: i64, seq: i64) -> Result<(), DomainError> {
    if (WEIGHT_MIN..=WEIGHT_MAX).contains(&weight) {
        return Ok(());
    }
    Err(DomainError::with_params(
        "chain.weight_invalid",
        json!({
            "weight": weight,
            "min": WEIGHT_MIN,
            "max": WEIGHT_MAX,
            "seq": seq,
        }),
        format!(
            "第 {} 组的成员权重必须在 {WEIGHT_MIN}-{WEIGHT_MAX} 之间（当前 {weight}）/ member weight in group {} must be between {WEIGHT_MIN} and {WEIGHT_MAX} (got {weight})",
            seq + 1,
            seq + 1
        ),
    ))
}

/// 这条链的某个策略是否需要协议 27+ 的 Agent。
///
/// 输入是 `(策略, 组成员数)`：
/// * 入口组（seq = 0）的策略永远不下发（执行选路的是上一跳），不参与门禁；
/// * **单成员组没有选路空间**，主控推导时会把新策略归一成默认值，不把
///   旧 Agent 不认识的枚举值放到线上（行为等价，不是降级）；
/// * 多成员组的新策略会原样下发给上一跳，旧 Agent 会让整份期望态解析失败。
pub fn strategy_needs_new_agent(groups: &[(GroupStrategy, usize)]) -> bool {
    groups
        .iter()
        .enumerate()
        .any(|(seq, (strategy, member_count))| {
            seq >= 1 && *member_count > 1 && strategy.requires_agent_v27()
        })
}

/// 链保存前的策略能力门禁，错误码 `chain.strategy_requires_agent_upgrade`。
///
/// `needs_upgrade` 由 [`strategy_needs_new_agent`] 得出；`servers` 是整条链的
/// `(服务器名, Agent 协议版本)`。未知（NULL）按旧版处理，与其它能力门禁同一口径。
pub fn ensure_chain_strategy_supported(
    needs_upgrade: bool,
    servers: &[(&str, Option<i64>)],
) -> Result<(), DomainError> {
    if !needs_upgrade {
        return Ok(());
    }
    let mut stale: Vec<&str> = Vec::new();
    for (name, version) in servers {
        let supported = version.is_some_and(|version| version >= STRATEGY_MIN_PROTOCOL_VERSION);
        if !supported && !stale.contains(name) {
            stale.push(name);
        }
    }
    if stale.is_empty() {
        return Ok(());
    }
    Err(DomainError::with_params(
        "chain.strategy_requires_agent_upgrade",
        json!({
            "server": stale.join("、"),
            "servers": stale,
            "required": STRATEGY_MIN_PROTOCOL_VERSION,
        }),
        format!(
            "加权 / 最少连接选路需要每台服务器的 Agent 协议版本 ≥ {STRATEGY_MIN_PROTOCOL_VERSION}（旧 Agent 不认识新策略，会导致整份期望态解析失败）：{} / weighted / least-connection routing requires agent protocol >= {STRATEGY_MIN_PROTOCOL_VERSION} on every server (older agents cannot parse the new strategy and would fail the whole desired state): {}",
            stale.join("、"),
            stale.join(", ")
        ),
    ))
}

/// nftables 多目标能实现的选路策略。
///
/// 内核 DNAT 只有 `numgen` / `jhash` 两类选择器：
/// * `round_robin`：`numgen inc mod N`；
/// * `weighted`：`numgen random mod Σweight` + 区间；
/// * `ip_hashed`：`jhash ip saddr mod N`（IPv6 用 `jhash ip6 saddr`）。
///
/// `failover` / `lowest_latency` 需要健康探测与故障回切，`least_conn` 需要
/// 每目标连接计数——这三者都在用户态，内核没有对应原语，必须明确拒绝。
/// 单成员组没有选路空间，策略不影响结果，不受这个矩阵限制。
pub fn nftables_strategy_supported(strategy: GroupStrategy) -> bool {
    matches!(
        strategy,
        GroupStrategy::RoundRobin | GroupStrategy::Weighted | GroupStrategy::IpHashed
    )
}

/// 不支持时的可读原因（中文 + English），写进错误与 blocked 视图。
pub fn nftables_strategy_reason(strategy: GroupStrategy) -> &'static str {
    match strategy {
        GroupStrategy::Failover => {
            "主备（failover）需要探测目标健康并在故障时回切，内核 DNAT 没有健康探测原语 / failover needs target health probes and fail-back, which kernel DNAT does not have"
        }
        GroupStrategy::LowestLatency => {
            "最低延迟（lowest_latency）需要主控探测每台目标的延迟，内核 DNAT 拿不到该信号 / lowest-latency needs per-target latency probes, which kernel DNAT cannot see"
        }
        GroupStrategy::LeastConn => {
            "最少连接（least_conn）需要每目标连接计数，内核没有连接计数原语 / least-conn needs per-target connection counters, which the kernel does not provide"
        }
        _ => "该策略无法由 nftables 多目标实现 / this strategy cannot be implemented by nftables multi-target",
    }
}

/// 链里是否有「需要选路的 nftables 多成员组」。
///
/// 输入是 `(策略, 成员数)`，按 seq 顺序。入口组（seq 0）的多成员是各自独立
/// 入口，不需要上一跳选路；只有 seq >= 1 且成员数 > 1 才会生成 vmap。
pub fn nftables_multi_target_groups(
    groups: &[(GroupStrategy, usize)],
) -> Vec<(usize, GroupStrategy, usize)> {
    groups
        .iter()
        .enumerate()
        .filter(|(seq, (_, member_count))| *seq >= 1 && *member_count > 1)
        .map(|(seq, (strategy, member_count))| (seq, *strategy, *member_count))
        .collect()
}

/// 保存前的 nftables 多目标策略门禁，错误码 `chain.nftables_strategy_unsupported`。
///
/// 只检查真正需要选路的组；单成员组保留任意策略（没有选路空间，行为等价）。
pub fn ensure_nftables_groups_supported(
    groups: &[(GroupStrategy, usize)],
) -> Result<(), DomainError> {
    for (seq, strategy, member_count) in nftables_multi_target_groups(groups) {
        if nftables_strategy_supported(strategy) {
            continue;
        }
        return Err(DomainError::with_params(
            "chain.nftables_strategy_unsupported",
            json!({
                "seq": seq + 1,
                "strategy": strategy.as_str(),
                "count": member_count,
                "reason": nftables_strategy_reason(strategy),
            }),
            format!(
                "nftables 引擎的第 {} 组有 {member_count} 个目标，但不支持「{}」选路：{} / nftables group {} has {member_count} targets but does not support the {} strategy: {}",
                seq + 1,
                strategy.as_str(),
                nftables_strategy_reason(strategy),
                seq + 1,
                strategy.as_str(),
                nftables_strategy_reason(strategy)
            ),
        ));
    }
    Ok(())
}

/// 保存前的 nftables 多目标 Agent 门禁，错误码
/// `chain.nftables_multi_target_requires_agent_upgrade`。
///
/// 只要链里有需要选路的 nftables 多成员组，整条链的 Agent 都必须 >= 29：
/// 旧 Agent 会拒绝多目标并让该规则未监听。未知（NULL）按旧版处理，与其它
/// 能力门禁同一口径。
pub fn ensure_nftables_agent_supported(
    groups: &[(GroupStrategy, usize)],
    servers: &[(&str, Option<i64>)],
) -> Result<(), DomainError> {
    let multi = nftables_multi_target_groups(groups);
    if multi.is_empty() {
        return Ok(());
    }
    let mut stale: Vec<&str> = Vec::new();
    for (name, version) in servers {
        let supported =
            version.is_some_and(|version| version >= NFTABLES_MULTI_TARGET_MIN_PROTOCOL_VERSION);
        if !supported && !stale.contains(name) {
            stale.push(name);
        }
    }
    if stale.is_empty() {
        return Ok(());
    }
    Err(DomainError::with_params(
        "chain.nftables_multi_target_requires_agent_upgrade",
        json!({
            "server": stale.join("、"),
            "servers": stale,
            "required": NFTABLES_MULTI_TARGET_MIN_PROTOCOL_VERSION,
        }),
        format!(
            "nftables 多目标选路需要每台服务器的 Agent 协议版本 ≥ {NFTABLES_MULTI_TARGET_MIN_PROTOCOL_VERSION}（旧 Agent 会拒绝多目标，导致该端口不转发）：{} / nftables multi-target routing requires agent protocol >= {NFTABLES_MULTI_TARGET_MIN_PROTOCOL_VERSION} on every server (older agents reject multi-target rules and leave the port unforwarded): {}",
            stale.join("、"),
            stale.join(", ")
        ),
    ))
}

/// 保存/模板路径的统一入口：先查策略矩阵，再查 Agent 版本。
pub fn validate_nftables_multi_target(
    groups: &[(GroupStrategy, usize)],
    servers: &[(&str, Option<i64>)],
) -> Result<(), DomainError> {
    ensure_nftables_groups_supported(groups)?;
    ensure_nftables_agent_supported(groups, servers)
}

/// 视图/下发路径的 nftables 多目标阻断原因。
///
/// 这里是唯一判定入口：链列表、创建/更新响应、期望态渲染与概览都调用它。
/// 顺序是「策略不支持」先于「Agent 太旧」：配置本身错了，升级 Agent 也没用。
pub fn nftables_multi_target_blocked_reason(
    groups: &[ChainGroupWithMembers],
) -> Option<BlockedReason> {
    let mut ordered: Vec<&ChainGroupWithMembers> = groups.iter().collect();
    ordered.sort_by_key(|group| group.group.seq);
    let strategies: Vec<(GroupStrategy, usize)> = ordered
        .iter()
        .map(|group| {
            (
                GroupStrategy::from_db(&group.group.strategy),
                group.members.len(),
            )
        })
        .collect();
    if let Some(reason) = ensure_nftables_groups_supported(&strategies)
        .err()
        .map(|error| BlockedReason {
            code: error.code.to_string(),
            message: error.message,
        })
    {
        return Some(reason);
    }
    let servers: Vec<(&str, Option<i64>)> = ordered
        .iter()
        .flat_map(|group| group.members.iter())
        .map(|member| (member.server_name.as_str(), member.server_protocol_version))
        .collect();
    ensure_nftables_agent_supported(&strategies, &servers)
        .err()
        .map(|error| BlockedReason {
            code: error.code.to_string(),
            message: error.message,
        })
}

///
/// 单成员组继续使用它，迁移后的链因此与旧版下发**逐字节一致**：
/// Agent 按 id 收敛，不会因为升级而重建监听、也不会丢上一轮的健康状态。
pub fn legacy_forward_id(chain_id: &str, seq: i64) -> String {
    format!("{FORWARD_ID_PREFIX}{chain_id}-{seq}")
}

/// 多成员组的成员 id：`chain-<chain_id>-<seq>-<server_id>`。
///
/// 一个组可能有多台服务器，每台都要有独立且稳定的 id（心跳按 id 回报监听状态）。
/// `server_id` 在一条链里唯一（跨组也不允许重复），所以不会撞。
pub fn member_forward_id(chain_id: &str, seq: i64, server_id: &str) -> String {
    format!("{FORWARD_ID_PREFIX}{chain_id}-{seq}-{server_id}")
}

/// 按组内成员数选 id：单成员组沿用旧格式，多成员组按服务器区分。
pub fn forward_id(chain_id: &str, seq: i64, server_id: &str, member_count: usize) -> String {
    if member_count <= 1 {
        legacy_forward_id(chain_id, seq)
    } else {
        member_forward_id(chain_id, seq, server_id)
    }
}

/// 链名称：去首尾空白后不能为空，且不超过 64 个字符。
pub fn normalize_name(raw: &str) -> Result<String, DomainError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(DomainError::new("chain.name_required", "链名称不能为空"));
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(DomainError::with_params(
            "chain.name_too_long",
            json!({ "max": NAME_MAX_CHARS }),
            format!("链名称最多 {NAME_MAX_CHARS} 个字符"),
        ));
    }
    Ok(name.to_string())
}

/// 跳数必须在 1..=4 之间。
pub fn validate_hop_count(count: usize) -> Result<(), DomainError> {
    if (MIN_HOPS..=MAX_HOPS).contains(&count) {
        return Ok(());
    }
    Err(DomainError::with_params(
        "chain.hop_count_invalid",
        json!({ "min": MIN_HOPS, "max": MAX_HOPS, "count": count }),
        format!("链必须包含 {MIN_HOPS}-{MAX_HOPS} 跳（当前 {count} 跳）"),
    ))
}

/// 同一台服务器不能在一跳链里出现两次（否则会自己连自己）。
pub fn ensure_unique_servers(server_ids: &[String]) -> Result<(), DomainError> {
    let mut seen = HashSet::new();
    for server_id in server_ids {
        if !seen.insert(server_id.as_str()) {
            return Err(DomainError::with_params(
                "chain.duplicate_server",
                json!({ "server_id": server_id }),
                format!("同一台服务器（{server_id}）不能在一跳链里出现两次"),
            ));
        }
    }
    Ok(())
}

/// 组数（等价于跳数）必须在 1..=4 之间。
///
/// 复用 `chain.hop_count_invalid` 错误码：旧前端已经翻译过它。
pub fn validate_group_count(count: usize) -> Result<(), DomainError> {
    validate_hop_count(count)
}

/// 一个组必须有 1..=8 台成员服务器。
pub fn validate_group_member_count(count: usize, seq: i64) -> Result<(), DomainError> {
    if (MIN_GROUP_MEMBERS..=MAX_GROUP_MEMBERS).contains(&count) {
        return Ok(());
    }
    Err(DomainError::with_params(
        "chain.group_member_count_invalid",
        json!({
            "min": MIN_GROUP_MEMBERS,
            "max": MAX_GROUP_MEMBERS,
            "count": count,
            "seq": seq,
        }),
        format!(
            "第 {} 组必须有 {MIN_GROUP_MEMBERS}-{MAX_GROUP_MEMBERS} 台成员（当前 {count} 台）",
            seq + 1
        ),
    ))
}

/// 在固定端口池里挑一个最小可用端口。
///
/// `occupied` 是该 `server_id` 上已经被占用的端口集合（独立转发、节点、其它链
/// 的成员，以及同一次保存里刚刚分配出去的结果）。函数本身不查库：调用方负责
/// 按服务器准备好集合，并在分配成功后**立即**把结果并入集合，保证同一次保存
/// 内不会把同一个端口分给两组。
///
/// 池耗尽时返回 `chain.port_pool_exhausted`（HTTP 400），不做随机挑选或回退：
/// 「悄悄换一个范围」会让用户更难发现自己已经用光了一台机器的端口。
pub fn allocate_port(server_id: &str, occupied: &HashSet<i64>) -> Result<i64, DomainError> {
    (PORT_POOL_START..=PORT_POOL_END)
        .find(|port| !occupied.contains(port))
        .ok_or_else(|| {
            DomainError::with_params(
                "chain.port_pool_exhausted",
                json!({
                    "server_id": server_id,
                    "pool_start": PORT_POOL_START,
                    "pool_end": PORT_POOL_END,
                }),
                format!(
                    "服务器（{server_id}）的自动分配端口池 {PORT_POOL_START}-{PORT_POOL_END} 已耗尽；请先释放端口，或为这一跳手动填写端口"
                ),
            )
        })
}

/// 入口组（seq = 0）必须显式填写监听端口。
///
/// 入口端口是用户实际连接的公网入口，静默改动会让线上客户端直接失联；
/// 因此只有中间组（seq >= 1）允许省略、由主控从端口池分配。
pub fn ensure_entry_port(seq: i64, listen_port: Option<i64>) -> Result<(), DomainError> {
    if seq == 0 && listen_port.is_none() {
        return Err(DomainError::new(
            "chain.entry_port_required",
            "入口组（第 1 组）必须填写监听端口",
        ));
    }
    Ok(())
}

/// 同一台服务器不能在同一个组里出现两次。
pub fn ensure_group_member_servers_unique(
    server_ids: &[String],
    seq: i64,
) -> Result<(), DomainError> {
    let mut seen = HashSet::new();
    for server_id in server_ids {
        if !seen.insert(server_id.as_str()) {
            return Err(DomainError::with_params(
                "chain.duplicate_group_member",
                json!({ "server_id": server_id, "seq": seq }),
                format!(
                    "同一台服务器（{server_id}）不能在第 {} 组里出现两次",
                    seq + 1
                ),
            ));
        }
    }
    Ok(())
}

/// 同一台服务器不能出现在同一条链的不同组里（否则会自己连自己）。
///
/// `groups` 按 seq 升序传入；跨组重复的错误码沿用旧版的 `chain.duplicate_server`。
pub fn ensure_chain_servers_unique(groups: &[Vec<String>]) -> Result<(), DomainError> {
    let mut seen: HashMap<&str, i64> = HashMap::new();
    for (seq, server_ids) in groups.iter().enumerate() {
        let seq = seq as i64;
        for server_id in server_ids {
            if let Some(first_seq) = seen.insert(server_id.as_str(), seq) {
                return Err(DomainError::with_params(
                    "chain.duplicate_server",
                    json!({
                        "server_id": server_id,
                        "first_seq": first_seq,
                        "seq": seq,
                    }),
                    format!(
                        "同一台服务器（{server_id}）不能在同一链的不同组里出现两次（第 {} 组与第 {} 组）",
                        first_seq + 1,
                        seq + 1
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// 组名可选：`None` / 空白 → `None`；非空时去首尾空白并限长。
pub fn normalize_group_name(raw: Option<&str>) -> Result<Option<String>, DomainError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let name = raw.trim();
    if name.is_empty() {
        return Ok(None);
    }
    if name.chars().count() > GROUP_NAME_MAX_CHARS {
        return Err(DomainError::with_params(
            "chain.group_name_too_long",
            json!({ "max": GROUP_NAME_MAX_CHARS }),
            format!("组名最多 {GROUP_NAME_MAX_CHARS} 个字符"),
        ));
    }
    Ok(Some(name.to_string()))
}

/// 链的路径形态：每组只有一台成员，端到端只有一条路径。
pub const PATH_SINGLE: &str = "single";
/// 存在多成员组，选中哪一台由策略决定（不是纯哈希）。
pub const PATH_MULTI: &str = "multi";
/// 所有多成员组都用 `ip_hashed`：同一来源总落到同一台，路径可按来源复现。
pub const PATH_HASH: &str = "hash";

/// 判定链的路径形态（纯函数，输入是「组策略 + 成员数」）。
///
/// * `single`：每组 ≤ 1 台，整条链只有一条路径，各段延迟可以直接相加；
/// * `hash`：所有多成员组都是 `ip_hashed`（同一客户端 IP 固定走一条路径）；
/// * `multi`：其余情况——存在多成员组，且至少一个多成员组用轮询/主备/最低延迟。
///
/// 只有 `single` 的 `total_latency_ms` 才有意义：多路径下「合计」是一个
/// 不存在的确定值，主控返回 null，避免把某一次探测的路径冒充成整条链。
pub fn path_mode<'a, I>(groups: I) -> &'static str
where
    I: IntoIterator<Item = (&'a str, usize)>,
{
    let mut has_multi = false;
    let mut all_multi_hashed = true;
    for (strategy, member_count) in groups {
        if member_count <= 1 {
            continue;
        }
        has_multi = true;
        all_multi_hashed &= GroupStrategy::from_db(strategy) == GroupStrategy::IpHashed;
    }
    if !has_multi {
        PATH_SINGLE
    } else if all_multi_hashed {
        PATH_HASH
    } else {
        PATH_MULTI
    }
}

/// 延迟历史的时间桶宽度：5 分钟。
///
/// 心跳默认 15 秒一条、每条最多一个目标一行样本；5 分钟桶把最多 20 个点
/// 压成 1 个，既保留趋势又不会让前端画上千个点。
pub const LATENCY_BUCKET_SECS: i64 = 5 * 60;

/// 延迟历史的一个点（既是聚合输入，也是 API 输出）。
///
/// * `ts`：输入时是样本时刻，输出时是所在 5 分钟桶的起点（Unix 秒）；
/// * `seq`：**被探测的那一跳**（目标成员所在组的 seq）。入口组没有上一跳，
///   因此不会有点；最后一跳到链目标的探测没有 `server_id`，不进历史；
/// * `server_id`：被探测的成员服务器 id；
/// * `latency_ms`：TCP 握手 RTT。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatencyPoint {
    pub ts: i64,
    pub seq: i64,
    pub server_id: String,
    pub latency_ms: i64,
}

/// 把同一跳的样本按时间桶聚合：一个桶一个点，取该桶内所有成员的**中位数**。
///
/// 口径（与 API 文档一致）：
/// * 桶起点 = `ts.div_euclid(bucket) * bucket`；
/// * 同一 `(桶, seq)` 内把所有成员的样本放在一起排序，取 `len / 2`（偶数个时
///   取较低的中位数），`server_id` 记为该中位数样本的成员，仅用于区分/排障；
/// * 输出按 `(ts, seq)` 升序，便于前端直接铺时间轴；空输入返回空数组。
pub fn aggregate_latency(samples: &[LatencyPoint], bucket_secs: i64) -> Vec<LatencyPoint> {
    if samples.is_empty() || bucket_secs <= 0 {
        return Vec::new();
    }
    let mut buckets: std::collections::BTreeMap<(i64, i64), Vec<&LatencyPoint>> =
        std::collections::BTreeMap::new();
    for sample in samples {
        let bucket = sample.ts.div_euclid(bucket_secs) * bucket_secs;
        buckets
            .entry((bucket, sample.seq))
            .or_default()
            .push(sample);
    }
    buckets
        .into_iter()
        .map(|((ts, seq), mut bucket)| {
            // 排序键带上 server_id，保证同延迟时的代表性成员稳定（不受查询顺序影响）。
            bucket.sort_by(|a, b| {
                a.latency_ms
                    .cmp(&b.latency_ms)
                    .then_with(|| a.server_id.cmp(&b.server_id))
            });
            // 偶数个取较低的中位数：`(len - 1) / 2`（不是 `len / 2`）。
            let median = bucket[(bucket.len() - 1) / 2];
            LatencyPoint {
                ts,
                seq,
                server_id: median.server_id.clone(),
                latency_ms: median.latency_ms,
            }
        })
        .collect()
}

/// 连续失败次数是否已经达到降级阈值。
///
/// 只读计数，不在这里记录历史；计数由 `repo::forwards::save_status` 维护。
pub fn is_degraded(target_fail_count: i64) -> bool {
    target_fail_count >= DEGRADED_AFTER_FAILURES
}

/// 组开关开启、但该组成员缺少内网地址时的整链阻断原因。
///
/// 保存路径已经 400 拦住；这里再算一次用于两件事：
/// * 链列表 / 概览显示 blocked；
/// * 期望态渲染时整链跳过——绝不静默回退公网地址。
///
/// 入口组（seq = 0）没有上一跳，开关不产生地址变化，因此不参与判定。
pub fn internal_address_blocked_reason(groups: &[ChainGroupWithMembers]) -> Option<BlockedReason> {
    for group in groups {
        if group.group.seq == 0 || !group.group.use_internal_address {
            continue;
        }
        for member in &group.members {
            if member
                .server_internal_address
                .as_deref()
                .map(str::trim)
                .is_none_or(str::is_empty)
            {
                return Some(BlockedReason {
                    code: "chain.internal_address_missing".to_string(),
                    message: format!(
                        "服务器「{}」还没有填写内网地址，无法使用内网地址转发",
                        member.server_name
                    ),
                });
            }
        }
    }
    None
}

/// 仅 UDP 链遇到旧 Agent 时的整链阻断原因。
///
/// `protocol = udp` 需要每一跳的 Agent 协议版本 `>= 16`；旧 Agent 会忽略
/// `protocol` 而按旧的 `udp` 镜像位只监听 TCP，链会静默失效。保存路径用
/// [`protocol::ensure_chain_agent_supported`] 直接 400，这里给列表/概览与
/// 下发路径提供同一套判定（未知版本按不支持处理）。
pub fn agent_protocol_blocked_reason(
    chain: &Chain,
    groups: &[ChainGroupWithMembers],
) -> Option<BlockedReason> {
    if !protocol::is_udp_only(&chain.protocol) {
        return None;
    }
    let servers: Vec<(&str, Option<i64>)> = groups
        .iter()
        .flat_map(|group| group.members.iter())
        .map(|member| (member.server_name.as_str(), member.server_protocol_version))
        .collect();
    protocol::ensure_chain_agent_supported(&chain.protocol, &servers)
        .err()
        .map(|error| BlockedReason {
            code: error.code.to_string(),
            message: error.message,
        })
}

/// 加权 / 最少连接遇到旧 Agent 时的整链阻断原因。
///
/// 旧 Agent 的 `ForwardStrategy` 枚举没有新变体，整份期望态会解析失败；
/// 保存路径用 [`ensure_chain_strategy_supported`] 直接 400，这里给列表/概览
/// 与下发路径提供同一套判定（未知版本按旧版处理）。**绝不**把新策略降级成轮询。
pub fn strategy_blocked_reason(groups: &[ChainGroupWithMembers]) -> Option<BlockedReason> {
    let mut ordered: Vec<&ChainGroupWithMembers> = groups.iter().collect();
    ordered.sort_by_key(|group| group.group.seq);
    let strategies: Vec<(GroupStrategy, usize)> = ordered
        .iter()
        .map(|group| {
            (
                GroupStrategy::from_db(&group.group.strategy),
                group.members.len(),
            )
        })
        .collect();
    if !strategy_needs_new_agent(&strategies) {
        return None;
    }
    let servers: Vec<(&str, Option<i64>)> = ordered
        .iter()
        .flat_map(|group| group.members.iter())
        .map(|member| (member.server_name.as_str(), member.server_protocol_version))
        .collect();
    ensure_chain_strategy_supported(true, &servers)
        .err()
        .map(|error| BlockedReason {
            code: error.code.to_string(),
            message: error.message,
        })
}

/// 链开启 PROXY protocol v2、但当前配置/Agent 不支持时的整链阻断原因。
///
/// 只有**最后一跳**真正连链目标，因此只检查最后一跳成员；中间跳即使 Agent
/// 较旧也没有影响（它们下发的 `proxy_protocol` 永远是 false）。历史配置在
/// 保存时没被拦住的（手工改库 / 旧版本写入），列表与下发都走这一条规则跳过，
/// 绝不静默忽略开关。
pub fn proxy_protocol_blocked_reason(
    chain: &Chain,
    groups: &[ChainGroupWithMembers],
) -> Option<BlockedReason> {
    if !chain.proxy_protocol {
        return None;
    }
    let mut ordered: Vec<&ChainGroupWithMembers> = groups.iter().collect();
    ordered.sort_by_key(|group| group.group.seq);
    let last_hop: Vec<(&str, Option<i64>)> = ordered
        .last()
        .map(|group| {
            group
                .members
                .iter()
                .map(|member| (member.server_name.as_str(), member.server_protocol_version))
                .collect()
        })
        .unwrap_or_default();
    protocol::ensure_chain_proxy_protocol(true, &chain.protocol, &chain.engine, &last_hop)
        .err()
        .map(|error| BlockedReason {
            code: error.code.to_string(),
            message: error.message,
        })
}

/// 一条链在视图里「为什么没下发」的结构化原因。
///
/// `code` 是前端词典的稳定键，`message` 是中文兜底文案；两者都由
/// [`blocked_reason`] 统一产出，链列表、创建/更新响应与概览计数不再各算一套。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockedReason {
    pub code: String,
    pub message: String,
}

/// 纯推导：一条链的逐组 transport（明文链返回空 Vec）。
///
/// 失败一律是「整链无效」，调用方据此跳过整条链（不是跳过某一跳）：
///
/// * 能力门禁：链上**任意**成员的 `realm_transport != Some(true)`（含旧 Agent /
///   slim realm 的 NULL）→ `chain.tls_realm_unsupported`；
/// * 证书缺失 / 过期 / 无 DNS SAN / 私钥不匹配 → 对应 `chain.tls_cert_*`；
/// * 组 0 不允许证书；seq >= 1 每组必须有。
///
/// `certs` 由调用方一次性批量读取（见 `desired::render`），避免逐链查库。
/// 本函数既用于下发（master 的期望态），也用于视图/概览的 blocked 判定，
/// 保证「面板说能下发」与「实际下发」永远是同一套规则。
pub fn plan_from_certificates(
    chain: &Chain,
    groups: &[ChainGroupWithMembers],
    certs: &HashMap<&str, &Certificate>,
    now: i64,
) -> Result<Vec<hop_transport::HopTransport>, DomainError> {
    if !hop_transport::is_tls(&chain.transport) {
        return Ok(Vec::new());
    }
    if protocol::is_udp_only(&chain.protocol) {
        return Err(DomainError::new(
            "chain.protocol_udp_with_tls",
            "加密链只走 TCP，不能选择仅 UDP",
        ));
    }

    // 下发路径也必须重查链级前置条件：写路径已经拦过，但手工改库/旧数据
    // 仍可能留下「native+tls」「单组 tls」「tls+udp」这类不能安全下发的组合。
    // 这里宁可整链跳过，也不能把它渲染成一个不带 transport 的明文端点。
    if !engine::is_realm(&chain.engine) {
        return Err(DomainError::new(
            "chain.tls_requires_realm",
            "只有 realm 引擎的链才能启用跳间加密",
        ));
    }
    if groups.len() < 2 {
        return Err(DomainError::new(
            "chain.tls_requires_two_hops",
            "至少两跳的链才有跳间链路",
        ));
    }
    if protocol::allows_udp(&chain.protocol) {
        return Err(DomainError::new(
            "chain.tls_udp_unsupported",
            "加密链不支持 UDP，请把链的协议改为 tcp",
        ));
    }

    // 能力门禁先于证书：旧 Agent 收到 transport 会静默忽略，必须整链挡住。
    let mut unsupported: Vec<&str> = Vec::new();
    for member in groups.iter().flat_map(|group| group.members.iter()) {
        if member.realm_transport != Some(true)
            && !unsupported.contains(&member.server_name.as_str())
        {
            unsupported.push(member.server_name.as_str());
        }
    }
    if !unsupported.is_empty() {
        return Err(DomainError::with_params(
            "chain.tls_realm_unsupported",
            json!({ "servers": unsupported }),
            format!(
                "以下服务器的 realm 未启用 transport（需要升级 Agent / 换官方 realm）：{}",
                unsupported.join("、")
            ),
        ));
    }

    let mut ordered: Vec<&ChainGroupWithMembers> = groups.iter().collect();
    ordered.sort_by_key(|group| group.group.seq);
    let mut group_certs = Vec::with_capacity(ordered.len());
    for (seq, group) in ordered.iter().enumerate() {
        if seq == 0 {
            group_certs.push(None);
            continue;
        }
        let cert_id = group.group.cert_id.as_deref().ok_or_else(|| {
            DomainError::with_params(
                "chain.tls_group_cert_required",
                json!({ "seq": seq }),
                format!("第 {} 组缺少证书", seq + 1),
            )
        })?;
        let cert = certs.get(cert_id).copied().ok_or_else(|| {
            DomainError::with_params(
                "chain.tls_cert_not_found",
                json!({ "cert_id": cert_id, "seq": seq }),
                format!("第 {} 组引用的证书不存在", seq + 1),
            )
        })?;
        group_certs.push(Some(hop_transport::validate_certificate(cert, now)?));
    }
    hop_transport::derive_hop_transports(&group_certs)
}

/// tunnel 链的前置条件（保存与下发共用同一套判定）。
///
/// 拓扑是「入口 Dialer →（中间跳 Listener+Dialer）… → 出口 Listener」：
/// 2–6 跳，每组一台成员。多成员组需要每个成员一个 `remote`，而
/// [`pierwave_proto::TunnelSpec::remote`] 只有一个地址，强行下发会导致只有
/// 第一台收到流量，所以先拒绝而不是静默降级。
///
/// 3+ 跳还需要每一跳都运行新协议 Agent：旧 Agent 不认识 `downstream`，会把
/// 中间跳当成出口直接连目标，跳数被静默截短——这里整链拒绝下发。
pub fn tunnel_blocked_reason(
    chain: &Chain,
    groups: &[ChainGroupWithMembers],
) -> Option<BlockedReason> {
    if groups.len() < TUNNEL_MIN_HOPS {
        return Some(BlockedReason {
            code: "chain.tunnel_requires_two_hops".to_string(),
            message: format!(
                "tunnel 引擎至少需要 2 跳（入口 Dialer + 出口 Listener），当前 {} 跳 / the tunnel engine needs at least 2 hops (entry dialer + exit listener), got {}",
                groups.len(),
                groups.len()
            ),
        });
    }
    if groups.len() > TUNNEL_MAX_HOPS {
        return Some(BlockedReason {
            code: "chain.tunnel_hop_limit".to_string(),
            message: format!(
                "tunnel 引擎最多支持 {TUNNEL_MAX_HOPS} 跳，当前 {} 跳 / the tunnel engine supports at most {TUNNEL_MAX_HOPS} hops, got {}",
                groups.len(),
                groups.len()
            ),
        });
    }
    if let Some(group) = groups.iter().find(|group| group.members.len() != 1) {
        return Some(BlockedReason {
            code: "chain.tunnel_single_member".to_string(),
            message: format!(
                "tunnel 引擎当前只支持每组 1 台成员（第 {} 组有 {} 台）/ the tunnel engine supports exactly one member per group (group {} has {})",
                group.group.seq + 1,
                group.members.len(),
                group.group.seq + 1,
                group.members.len()
            ),
        });
    }
    // UDP 中继（P16.3）本轮只在 2 跳链上实现：中间跳的 QUIC endpoint 只会把
    // 数据报发给链目标，3+ 跳会绕过后续跳。整链拒绝，绝不静默截短。
    if groups.len() > TUNNEL_MIN_HOPS && protocol::allows_udp(&chain.protocol) {
        return Some(BlockedReason {
            code: "chain.tunnel_udp_requires_two_hops".to_string(),
            message: "tunnel 的 UDP 中继当前只支持 2 跳链 / the tunnel UDP relay currently supports exactly 2 hops".to_string(),
        });
    }
    // Noise + UDP 从协议 25 开始支持（QUIC 用 hop_secret 派生的证书 + 指纹固定）。
    // 旧 Agent 会让整个端点启动失败；保存路径已拒绝，下发路径再挡一次：手工
    // 改库或旧数据不能把一条注定失败的链下发下去，也绝不能悄悄关掉 UDP。
    if protocol::allows_udp(&chain.protocol) && tunnel_security::is_noise(&chain.tunnel_security) {
        let stale: Vec<&str> = groups
            .iter()
            .flat_map(|group| group.members.iter())
            .filter(|member| {
                !member
                    .server_protocol_version
                    .is_some_and(|version| version >= TUNNEL_NOISE_UDP_MIN_PROTOCOL_VERSION)
            })
            .map(|member| member.server_name.as_str())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if !stale.is_empty() {
            let mut stale = stale;
            stale.sort_unstable();
            return Some(BlockedReason {
                code: "chain.tunnel_noise_udp_requires_upgrade".to_string(),
                message: format!(
                    "Noise 模式的 UDP 中继需要每台服务器的 Agent 协议版本 ≥ {TUNNEL_NOISE_UDP_MIN_PROTOCOL_VERSION}（旧 Agent 无法在 QUIC 上完成 PSK 认证）：{} / the Noise-mode UDP relay requires agent protocol >= {TUNNEL_NOISE_UDP_MIN_PROTOCOL_VERSION} (older agents cannot authenticate over QUIC): {}",
                    stale.join("、"),
                    stale.join(", ")
                ),
            });
        }
    }
    if crate::hop_transport::is_tls(&chain.transport) {
        return Some(BlockedReason {
            code: "chain.tunnel_transport_conflict".to_string(),
            message: "tunnel 自带 TLS，不能再选择 realm 的 transport=tls / the tunnel brings its own TLS and cannot reuse realm transport=tls".to_string(),
        });
    }
    // 3+ 跳：每一跳都必须由新协议 Agent 处理 `downstream`。未知版本按旧版
    // 处理（与「tunnel 能力未知 = 不支持」同一保守口径）。
    if groups.len() > TUNNEL_MIN_HOPS {
        let stale: Vec<&str> = groups
            .iter()
            .flat_map(|group| group.members.iter())
            .filter(|member| {
                !member
                    .server_protocol_version
                    .is_some_and(|version| version >= TUNNEL_MULTIHOP_MIN_PROTOCOL_VERSION)
            })
            .map(|member| member.server_name.as_str())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if !stale.is_empty() {
            let mut stale = stale;
            stale.sort_unstable();
            return Some(BlockedReason {
                code: "chain.tunnel_multihop_requires_upgrade".to_string(),
                message: format!(
                    "3+ 跳 tunnel 链需要每台服务器的 Agent 协议版本 ≥ {TUNNEL_MULTIHOP_MIN_PROTOCOL_VERSION}（旧 Agent 会静默截短跳数）：{} / multi-hop tunnel chains require agent protocol >= {TUNNEL_MULTIHOP_MIN_PROTOCOL_VERSION} (older agents would silently shorten the chain): {}",
                    stale.join("、"),
                    stale.join(", ")
                ),
            });
        }
    }
    let mut names: Vec<&str> = groups
        .iter()
        .flat_map(|group| group.members.iter())
        .filter(|member| member.tunnel_available != Some(true))
        .map(|member| member.server_name.as_str())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if !names.is_empty() {
        names.sort_unstable();
        return Some(BlockedReason {
            code: "chain.tunnel_unavailable".to_string(),
            message: format!(
                "以下服务器的 Agent 不支持 tunnel 引擎（需要升级到带 tunnel 能力的版本）：{} / these servers run agents without tunnel support: {}",
                names.join("、"),
                names.join(", ")
            ),
        });
    }
    None
}

/// 空成员组：整条链无法下发（与 tunnel 的 `tunnel_downstream_missing` 同口径）。
///
/// 保存路径会拒绝 0 成员的组；但删除服务器会级联删掉成员（历史数据 / 手工
/// 改库也可能留下空组），此时如果继续推导，上一跳会「没有下一跳」并静默
/// 回退成直连最终目标——跳数被悄悄截短。这里对**所有引擎**统一整链阻断。
pub fn empty_group_blocked_reason(groups: &[ChainGroupWithMembers]) -> Option<BlockedReason> {
    groups
        .iter()
        .find(|group| group.members.is_empty())
        .map(|group| BlockedReason {
            code: "chain.group_empty".to_string(),
            message: format!(
                "第 {} 跳没有成员服务器，整条链未下发 / hop {} has no member servers, so the whole chain was not delivered",
                group.group.seq + 1,
                group.group.seq + 1
            ),
        })
}

/// 链视图里的「为什么没下发」：能力或证书不满足时给用户看的原因。
///
/// 这是**唯一**的 blocked 判定入口：链列表、创建/更新响应和概览的
/// [`crate::repo::chains::count_blocked`] 都调用它，不允许在仓储里重写规则。
///
/// 注意：`listening = 0` 不属于 blocked（那是运行态健康，由 `degraded` /
/// 成员视图表达）；blocked 只描述「配置层面整链无法下发」。
pub fn blocked_reason(
    chain: &Chain,
    groups: &[ChainGroupWithMembers],
    certs: &HashMap<&str, &Certificate>,
    now: i64,
) -> Option<BlockedReason> {
    // 空成员组对所有引擎都是整链阻断：先于引擎/证书判定，避免 native 等
    // 引擎在「没有下一跳」时静默回退成直连目标。
    if let Some(reason) = empty_group_blocked_reason(groups) {
        return Some(reason);
    }
    // 内网地址缺失先于引擎判定：只要这一跳真要内网地址却拿不到，整链都不能下发。
    if let Some(reason) = internal_address_blocked_reason(groups) {
        return Some(reason);
    }
    // PROXY protocol v2：只检查最后一跳的 Agent，且只允许 TCP + native。
    // 先于「仅 UDP」门禁，让 proxy + UDP 的历史配置显示更具体的原因。
    if let Some(reason) = proxy_protocol_blocked_reason(chain, groups) {
        return Some(reason);
    }
    // 仅 UDP 需要每一跳的 Agent 协议 >= 16；旧 Agent 会把它悄悄变成 TCP。
    if let Some(reason) = agent_protocol_blocked_reason(chain, groups) {
        return Some(reason);
    }
    // 加权 / 最少连接只有协议 27+ 的 Agent 认识；历史链遇到旧 Agent 时整链
    // 阻断，绝不把策略静默降级成轮询。
    if let Some(reason) = strategy_blocked_reason(groups) {
        return Some(reason);
    }
    if engine::is_tunnel(&chain.engine) {
        return tunnel_blocked_reason(chain, groups);
    }
    if engine::is_nftables(&chain.engine) {
        // 多目标：先在策略矩阵里拒绝不可实现的策略，再要求整链 Agent >= 29。
        // 旧版这里一律拒绝所有非入口多成员组；现在 round_robin / weighted /
        // ip_hashed 可以选路，只有无法用内核原语实现的策略才 blocking。
        if let Some(reason) = nftables_multi_target_blocked_reason(groups) {
            return Some(reason);
        }
        let mut names: Vec<&str> = groups
            .iter()
            .flat_map(|group| group.members.iter())
            .filter(|member| member.nftables_available != Some(true))
            .map(|member| member.server_name.as_str())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if !names.is_empty() {
            names.sort_unstable();
            return Some(BlockedReason {
                code: "chain.nftables_unavailable".to_string(),
                message: format!(
                    "以下服务器的 nftables 不可用（需要安装 nft 并以 root 运行）：{}",
                    names.join("、")
                ),
            });
        }
        return None;
    }
    if !hop_transport::is_tls(&chain.transport) {
        return None;
    }
    match plan_from_certificates(chain, groups, certs, now) {
        Ok(_) => None,
        Err(error) => Some(BlockedReason {
            code: error.code.to_string(),
            message: error.message,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::models::{ChainGroup, ChainGroupMember};

    use serde_json::json;

    #[test]
    fn hop_count_is_limited_to_one_through_six() {
        for count in MIN_HOPS..=MAX_HOPS {
            assert!(validate_hop_count(count).is_ok(), "count={count}");
        }

        for count in [0, MAX_HOPS + 1, 10] {
            let error = validate_hop_count(count).unwrap_err();
            assert_eq!(error.code, "chain.hop_count_invalid", "count={count}");
            assert_eq!(
                error.params,
                json!({ "min": MIN_HOPS, "max": MAX_HOPS, "count": count })
            );
            assert!(
                error.message.contains(&format!("1-{MAX_HOPS}")),
                "{}",
                error.message
            );
        }
    }

    #[test]
    fn duplicate_servers_are_rejected() {
        let ok = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert!(ensure_unique_servers(&ok).is_ok());

        let duplicated = vec!["a".to_string(), "b".to_string(), "a".to_string()];
        let error = ensure_unique_servers(&duplicated).unwrap_err();
        assert_eq!(error.code, "chain.duplicate_server");
        assert_eq!(error.params, json!({ "server_id": "a" }));
        assert!(error.message.contains("不能在一跳链里出现两次"));
    }

    #[test]
    fn names_are_required_and_bounded() {
        assert_eq!(normalize_name(" 港-日-美 ").unwrap(), "港-日-美");
        assert_eq!(
            normalize_name(&"a".repeat(NAME_MAX_CHARS)).unwrap(),
            "a".repeat(NAME_MAX_CHARS)
        );
        assert_eq!(
            normalize_name("  ").unwrap_err().code,
            "chain.name_required"
        );
        assert_eq!(
            normalize_name(&"a".repeat(NAME_MAX_CHARS + 1))
                .unwrap_err()
                .code,
            "chain.name_too_long"
        );
    }

    #[test]
    fn degraded_needs_two_consecutive_failures() {
        assert!(!is_degraded(0));
        assert!(!is_degraded(1), "只失败一次不能判降级");
        assert!(is_degraded(2), "连续两次失败才降级");
        assert!(is_degraded(3));
    }

    #[test]
    fn derived_forward_ids_are_stable_and_prefixed() {
        // 单成员组沿用旧 id：升级不重建监听、不丢健康状态。
        assert_eq!(forward_id("c1", 0, "srv-a", 1), "chain-c1-0");
        assert_eq!(forward_id("c1", 3, "srv-b", 1), "chain-c1-3");
        assert_eq!(legacy_forward_id("c1", 0), "chain-c1-0");

        // 多成员组必须按服务器区分。
        assert_eq!(forward_id("c1", 0, "srv-a", 2), "chain-c1-0-srv-a");
        assert_eq!(member_forward_id("c1", 3, "srv-b"), "chain-c1-3-srv-b");
        assert!(forward_id("c1", 0, "srv-a", 2).starts_with(FORWARD_ID_PREFIX));
        assert_ne!(
            forward_id("c1", 0, "srv-a", 2),
            forward_id("c1", 0, "srv-b", 2),
            "同一组的不同成员必须拿到不同 id"
        );
    }

    #[test]
    fn strategies_accept_exactly_the_six_wire_values() {
        assert_eq!(
            GroupStrategy::parse("round_robin").unwrap(),
            GroupStrategy::RoundRobin
        );
        assert_eq!(
            GroupStrategy::parse(" failover ").unwrap(),
            GroupStrategy::Failover,
            "首尾空白可忽略"
        );
        assert_eq!(
            GroupStrategy::parse("lowest_latency").unwrap(),
            GroupStrategy::LowestLatency
        );
        assert_eq!(
            GroupStrategy::parse("ip_hashed").unwrap(),
            GroupStrategy::IpHashed
        );
        assert_eq!(
            GroupStrategy::parse("weighted").unwrap(),
            GroupStrategy::Weighted,
            "加权策略必须能被严格解析"
        );
        assert_eq!(
            GroupStrategy::parse("least_conn").unwrap(),
            GroupStrategy::LeastConn,
            "最少连接策略必须能被严格解析"
        );
        assert_eq!(GroupStrategy::default(), GroupStrategy::RoundRobin);
        assert_eq!(GroupStrategy::RoundRobin.as_str(), "round_robin");
        assert_eq!(GroupStrategy::Weighted.as_str(), "weighted");
        assert_eq!(GroupStrategy::LeastConn.as_str(), "least_conn");

        for bad in ["", "RoundRobin", "round-robin", "random", "weight"] {
            let error = GroupStrategy::parse(bad).unwrap_err();
            assert_eq!(error.code, "chain.strategy_invalid", "bad={bad:?}");
            assert!(
                error.message.contains("只支持 round_robin / failover"),
                "{}",
                error.message
            );
            assert!(
                error.message.contains("weighted") && error.message.contains("least_conn"),
                "错误文案必须列出全部 6 个合法值：{}",
                error.message
            );
        }
        assert_eq!(
            GroupStrategy::from_db("garbage"),
            GroupStrategy::RoundRobin,
            "旧数据里的非法策略回落到轮询，不能拖垮整条链"
        );
        assert_eq!(
            GroupStrategy::from_db("weighted"),
            GroupStrategy::Weighted,
            "合法的新策略不能被 from_db 回落"
        );
    }

    #[test]
    fn member_weight_must_be_between_one_and_one_hundred() {
        for weight in [WEIGHT_MIN, 2, 50, WEIGHT_MAX] {
            assert!(validate_weight(weight, 1).is_ok(), "weight={weight}");
        }
        for weight in [0, -1, WEIGHT_MAX + 1, i64::MAX] {
            let error = validate_weight(weight, 1).unwrap_err();
            assert_eq!(error.code, "chain.weight_invalid", "weight={weight}");
            assert_eq!(
                error.params,
                json!({
                    "weight": weight,
                    "min": WEIGHT_MIN,
                    "max": WEIGHT_MAX,
                    "seq": 1,
                })
            );
            assert!(error.message.contains("第 2 组"), "{}", error.message);
            assert!(
                error.message.contains("1-100"),
                "文案必须写清范围：{}",
                error.message
            );
        }
    }

    #[test]
    fn new_strategies_require_protocol_27_agents() {
        // 入口组的策略永远不下发：单组链用 weighted 不需要新 Agent。
        assert!(!strategy_needs_new_agent(&[(GroupStrategy::Weighted, 1)]));
        assert!(!strategy_needs_new_agent(&[
            (GroupStrategy::RoundRobin, 1),
            (GroupStrategy::Failover, 1),
        ]));
        assert!(
            !strategy_needs_new_agent(&[
                (GroupStrategy::RoundRobin, 1),
                (GroupStrategy::Weighted, 1),
            ]),
            "单成员组没有选路空间：新策略推导时归一成默认值，不要求升级"
        );
        assert!(strategy_needs_new_agent(&[
            (GroupStrategy::RoundRobin, 1),
            (GroupStrategy::Weighted, 2),
        ]));
        assert!(
            strategy_needs_new_agent(&[
                (GroupStrategy::RoundRobin, 1),
                (GroupStrategy::LeastConn, 2),
            ]),
            "最少连接同样只有协议 27+ 认识"
        );

        let servers = [("hk-a", Some(27)), ("jp-b", Some(27))];
        assert!(ensure_chain_strategy_supported(false, &servers).is_ok());
        assert!(
            ensure_chain_strategy_supported(true, &servers).is_ok(),
            "全部 >= 27 时放行"
        );

        for version in [None, Some(0), Some(26)] {
            let servers = [("hk-a", Some(27)), ("jp-b", version)];
            let error = ensure_chain_strategy_supported(true, &servers).unwrap_err();
            assert_eq!(error.code, "chain.strategy_requires_agent_upgrade");
            assert_eq!(error.params["required"], STRATEGY_MIN_PROTOCOL_VERSION);
            assert_eq!(error.params["servers"], json!(["jp-b"]));
            assert!(
                error.message.contains("jp-b") && error.message.contains("27"),
                "文案必须点名服务器与所需版本：{}",
                error.message
            );
            assert!(
                error.message.contains("protocol >= 27"),
                "错误文案必须中英双语：{}",
                error.message
            );
        }
    }

    #[test]
    fn historical_new_strategy_chain_is_blocked_not_downgraded() {
        let mut groups = vec![server("strategy-chain", 0), server("strategy-chain", 1)];
        // 多成员组才会把新策略真正放到线上；复制一台同组候选。
        let mut second = groups[1].members[0].clone();
        second.server_id = "srv-1b".into();
        second.server_name = "srv-1b".into();
        groups[1].members.push(second);
        groups[1].group.strategy = "weighted".into();
        for member in &mut groups[1].members {
            member.strategy = "weighted".into();
            member.server_protocol_version = Some(26);
        }

        let reason = strategy_blocked_reason(&groups).expect("旧 Agent 必须整链阻断");
        assert_eq!(reason.code, "chain.strategy_requires_agent_upgrade");
        assert_eq!(
            GroupStrategy::from_db(&groups[1].group.strategy),
            GroupStrategy::Weighted,
            "阻断不等于降级：策略本身必须仍然可读"
        );

        // Agent 升级后恢复下发。
        groups[0].members[0].server_protocol_version = Some(27);
        for member in &mut groups[1].members {
            member.server_protocol_version = Some(27);
        }
        assert!(
            strategy_blocked_reason(&groups).is_none(),
            "整条链都 >= 27 时必须恢复"
        );

        // 入口组的 weighted 永不下发，不因旧 Agent 阻断。
        groups[1].group.strategy = "round_robin".into();
        for member in &mut groups[1].members {
            member.strategy = "round_robin".into();
        }
        groups[0].group.strategy = "weighted".into();
        groups[0].members[0].strategy = "weighted".into();
        groups[0].members[0].server_protocol_version = Some(26);
        assert!(
            strategy_blocked_reason(&groups).is_none(),
            "入口组策略不参与下发"
        );
    }

    #[test]
    fn blocked_reason_uses_the_strategy_gate() {
        let mut groups = vec![server("blocked-strategy", 0), server("blocked-strategy", 1)];
        let mut second = groups[1].members[0].clone();
        second.server_id = "srv-1b".into();
        second.server_name = "srv-1b".into();
        groups[1].members.push(second);
        groups[1].group.strategy = "least_conn".into();
        for member in &mut groups[1].members {
            member.strategy = "least_conn".into();
            member.server_protocol_version = Some(26);
        }
        let chain = Chain {
            id: "blocked-strategy".into(),
            name: "strategy".into(),
            target_host: "1.1.1.1".into(),
            target_port: 443,
            enabled: true,
            engine: "native".into(),
            udp: false,
            protocol: "tcp".into(),
            proxy_protocol: false,
            transport: "none".into(),
            tunnel_security: "tls".into(),
            template_id: None,
            owner_user_id: None,
            created_at: 0,
            updated_at: 0,
        };
        let reason = blocked_reason(&chain, &groups, &HashMap::new(), 0)
            .expect("列表与下发必须看到同一个阻断原因");
        assert_eq!(reason.code, "chain.strategy_requires_agent_upgrade");
    }

    #[test]
    fn group_member_count_is_limited_to_one_through_eight() {
        for count in MIN_GROUP_MEMBERS..=MAX_GROUP_MEMBERS {
            assert!(
                validate_group_member_count(count, 0).is_ok(),
                "count={count}"
            );
        }

        for count in [0, MAX_GROUP_MEMBERS + 1, 20] {
            let error = validate_group_member_count(count, 1).unwrap_err();
            assert_eq!(error.code, "chain.group_member_count_invalid");
            assert_eq!(
                error.params,
                json!({
                    "min": MIN_GROUP_MEMBERS,
                    "max": MAX_GROUP_MEMBERS,
                    "count": count,
                    "seq": 1,
                })
            );
            assert!(error.message.contains("第 2 组"), "{}", error.message);
        }
    }

    #[test]
    fn the_same_server_cannot_repeat_within_a_group_or_across_groups() {
        let within = vec!["a".to_string(), "b".to_string(), "a".to_string()];
        let error = ensure_group_member_servers_unique(&within, 0).unwrap_err();
        assert_eq!(error.code, "chain.duplicate_group_member");
        assert_eq!(error.params, json!({ "server_id": "a", "seq": 0 }));
        assert!(error.message.contains("第 1 组"), "{}", error.message);

        let groups = vec![
            vec!["a".to_string(), "b".to_string()],
            vec!["c".to_string(), "a".to_string()],
        ];
        let error = ensure_chain_servers_unique(&groups).unwrap_err();
        assert_eq!(error.code, "chain.duplicate_server");
        assert_eq!(
            error.params,
            json!({ "server_id": "a", "first_seq": 0, "seq": 1 })
        );
        assert!(
            error.message.contains("第 1 组与第 2 组"),
            "{}",
            error.message
        );

        let ok = vec![vec!["a".to_string()], vec!["b".to_string()]];
        assert!(ensure_chain_servers_unique(&ok).is_ok());
    }

    #[test]
    fn path_mode_is_single_multi_or_hash() {
        assert_eq!(path_mode([]), PATH_SINGLE);
        assert_eq!(
            path_mode([("round_robin", 1), ("ip_hashed", 1)]),
            PATH_SINGLE,
            "每组一台时策略不参与判定"
        );
        assert_eq!(
            path_mode([("round_robin", 1), ("round_robin", 2)]),
            PATH_MULTI
        );
        assert_eq!(path_mode([("round_robin", 1), ("ip_hashed", 2)]), PATH_HASH);
        assert_eq!(
            path_mode([("ip_hashed", 3), ("ip_hashed", 2)]),
            PATH_HASH,
            "所有多成员组都哈希才算 hash"
        );
        assert_eq!(
            path_mode([("ip_hashed", 2), ("round_robin", 2)]),
            PATH_MULTI,
            "只要有一个多成员组不是哈希，路径就不固定"
        );
    }

    #[test]
    fn port_pool_allocates_the_lowest_free_port() {
        let mut occupied = HashSet::new();
        assert_eq!(
            allocate_port("srv-a", &occupied).unwrap(),
            PORT_POOL_START,
            "空集时从池起点开始"
        );

        occupied.insert(PORT_POOL_START);
        occupied.insert(PORT_POOL_START + 1);
        assert_eq!(
            allocate_port("srv-a", &occupied).unwrap(),
            PORT_POOL_START + 2,
            "跳过已占用端口，取最小的空闲值"
        );

        // 池外的端口不参与：小于起点 / 大于终点的占用不影响池内选择。
        occupied.clear();
        occupied.insert(PORT_POOL_START - 1);
        occupied.insert(PORT_POOL_END + 1);
        assert_eq!(allocate_port("srv-a", &occupied).unwrap(), PORT_POOL_START);
    }

    #[test]
    fn port_pool_exhaustion_returns_a_coded_error() {
        let occupied: HashSet<i64> = (PORT_POOL_START..=PORT_POOL_END).collect();
        let error = allocate_port("srv-b", &occupied).unwrap_err();
        assert_eq!(error.code, "chain.port_pool_exhausted");
        assert_eq!(
            error.params,
            json!({
                "server_id": "srv-b",
                "pool_start": PORT_POOL_START,
                "pool_end": PORT_POOL_END,
            })
        );
        assert!(error.message.contains("20000-29999"), "{}", error.message);
        assert!(error.message.contains("已耗尽"), "{}", error.message);
    }

    #[test]
    fn entry_group_must_provide_its_port() {
        assert_eq!(
            ensure_entry_port(0, None).unwrap_err().code,
            "chain.entry_port_required"
        );
        assert!(ensure_entry_port(0, Some(20000)).is_ok());
        assert!(
            ensure_entry_port(1, None).is_ok(),
            "中间组允许省略端口，由主控分配"
        );
        assert!(ensure_entry_port(5, Some(20001)).is_ok());
    }

    #[test]
    fn group_names_are_optional_and_bounded() {
        assert_eq!(normalize_group_name(None).unwrap(), None);
        assert_eq!(normalize_group_name(Some("  ")).unwrap(), None);
        assert_eq!(
            normalize_group_name(Some(" 入口 ")).unwrap(),
            Some("入口".to_string())
        );
        assert_eq!(
            normalize_group_name(Some(&"a".repeat(GROUP_NAME_MAX_CHARS))).unwrap(),
            Some("a".repeat(GROUP_NAME_MAX_CHARS))
        );
        assert_eq!(
            normalize_group_name(Some(&"a".repeat(GROUP_NAME_MAX_CHARS + 1)))
                .unwrap_err()
                .code,
            "chain.group_name_too_long"
        );
    }

    #[test]
    fn group_count_reuses_the_hop_count_bounds() {
        for count in MIN_HOPS..=MAX_HOPS {
            assert!(validate_group_count(count).is_ok(), "count={count}");
        }
        for count in [0, MAX_HOPS + 1] {
            assert_eq!(
                validate_group_count(count).unwrap_err().code,
                "chain.hop_count_invalid"
            );
        }
    }

    fn point(ts: i64, seq: i64, server_id: &str, latency_ms: i64) -> LatencyPoint {
        LatencyPoint {
            ts,
            seq,
            server_id: server_id.into(),
            latency_ms,
        }
    }

    #[test]
    fn latency_history_is_bucketed_and_uses_the_median() {
        // 同一个 5 分钟桶：三个成员 10/30/20 → 中位数 20。
        let samples = vec![
            point(1_000, 1, "b", 30),
            point(1_010, 1, "a", 10),
            point(1_020, 1, "c", 20),
        ];
        let points = aggregate_latency(&samples, LATENCY_BUCKET_SECS);
        assert_eq!(points, vec![point(900, 1, "c", 20)]);

        // 偶数个样本取较低的中位数（10/30 → 10），且结果稳定。
        let samples = vec![point(1_000, 1, "b", 30), point(1_000, 1, "a", 10)];
        assert_eq!(
            aggregate_latency(&samples, LATENCY_BUCKET_SECS),
            vec![point(900, 1, "a", 10)]
        );

        // 不同桶 / 不同跳各自聚合，输出按 (ts, seq) 升序。
        let samples = vec![
            point(1_500, 2, "c", 40),
            point(1_500, 1, "a", 20),
            point(1_201, 2, "d", 60),
            point(1_200, 1, "b", 80),
        ];
        assert_eq!(
            aggregate_latency(&samples, LATENCY_BUCKET_SECS),
            vec![
                point(1_200, 1, "b", 80),
                point(1_200, 2, "d", 60),
                point(1_500, 1, "a", 20),
                point(1_500, 2, "c", 40),
            ]
        );
    }

    #[test]
    fn latency_history_returns_empty_for_no_samples_or_invalid_bucket() {
        assert!(aggregate_latency(&[], LATENCY_BUCKET_SECS).is_empty());
        assert!(
            aggregate_latency(&[point(1_000, 0, "a", 10)], 0).is_empty(),
            "非法桶宽不能 panic，也不能返回编造的点"
        );
    }
    fn empty_group(code: &str) -> ChainGroupWithMembers {
        ChainGroupWithMembers {
            group: ChainGroup {
                id: "g-1".into(),
                chain_id: code.into(),
                seq: 1,
                name: None,
                strategy: "round_robin".into(),
                cert_id: None,
                public_port: None,
                use_internal_address: false,
            },
            members: Vec::new(),
        }
    }

    fn server(code: &str, seq: i64) -> ChainGroupWithMembers {
        ChainGroupWithMembers {
            group: ChainGroup {
                id: format!("g-{seq}"),
                chain_id: code.into(),
                seq,
                name: None,
                strategy: "round_robin".into(),
                cert_id: None,
                public_port: None,
                use_internal_address: false,
            },
            members: vec![ChainGroupMember {
                group_id: format!("g-{seq}"),
                chain_id: code.into(),
                seq,
                strategy: "round_robin".into(),
                server_id: format!("srv-{seq}"),
                server_name: format!("srv-{seq}"),
                server_address: "10.0.0.1".into(),
                server_internal_address: None,
                listen_port: 20000 + seq,
                priority: 0,
                weight: 1,
                realm_transport: None,
                nftables_available: None,
                tunnel_available: None,
                server_protocol_version: None,
                last_seen_at: None,
            }],
        }
    }

    fn multi_member_group(
        code: &str,
        seq: i64,
        strategy: &str,
        version: Option<i64>,
    ) -> ChainGroupWithMembers {
        let mut group = server(code, seq);
        group.group.strategy = strategy.into();
        let mut second = group.members[0].clone();
        second.server_id = format!("srv-{seq}-b");
        second.server_name = format!("srv-{seq}-b");
        second.priority = 1;
        for member in [&mut group.members[0], &mut second] {
            member.strategy = strategy.into();
            member.server_protocol_version = version;
        }
        group.members.push(second);
        group
    }

    fn engine_chain(code: &str, engine: &str) -> Chain {
        Chain {
            id: code.into(),
            name: engine.into(),
            target_host: "1.1.1.1".into(),
            target_port: 443,
            enabled: true,
            engine: engine.into(),
            udp: false,
            protocol: "tcp".into(),
            proxy_protocol: false,
            transport: "none".into(),
            tunnel_security: "tls".into(),
            template_id: None,
            owner_user_id: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn nftables_strategy_matrix_matches_the_kernel_primitives() {
        assert!(nftables_strategy_supported(GroupStrategy::RoundRobin));
        assert!(nftables_strategy_supported(GroupStrategy::Weighted));
        assert!(nftables_strategy_supported(GroupStrategy::IpHashed));
        for strategy in [
            GroupStrategy::Failover,
            GroupStrategy::LowestLatency,
            GroupStrategy::LeastConn,
        ] {
            assert!(!nftables_strategy_supported(strategy), "{strategy:?}");
            assert!(
                nftables_strategy_reason(strategy).contains("内核")
                    || nftables_strategy_reason(strategy).contains("kernel"),
                "{strategy:?}"
            );
        }
    }

    #[test]
    fn nftables_multi_target_groups_skip_entry_and_single_member_groups() {
        let groups = nftables_multi_target_groups(&[
            (GroupStrategy::Failover, 3),
            (GroupStrategy::Failover, 1),
            (GroupStrategy::RoundRobin, 2),
        ]);
        assert_eq!(
            groups,
            vec![(2, GroupStrategy::RoundRobin, 2)],
            "入口组多成员只是独立入口；单成员组没有选路空间"
        );
    }

    #[test]
    fn nftables_rejects_unimplementable_multi_target_strategies() {
        for strategy in [
            GroupStrategy::Failover,
            GroupStrategy::LowestLatency,
            GroupStrategy::LeastConn,
        ] {
            let error =
                ensure_nftables_groups_supported(&[(GroupStrategy::RoundRobin, 1), (strategy, 2)])
                    .unwrap_err();
            assert_eq!(error.code, "chain.nftables_strategy_unsupported");
            assert_eq!(error.params["seq"], 2);
            assert_eq!(error.params["strategy"], strategy.as_str());
            assert_eq!(error.params["count"], 2);
            assert!(
                error.message.contains(strategy.as_str()),
                "{}",
                error.message
            );
            assert!(
                error.message.contains("内核") || error.message.contains("kernel"),
                "{}",
                error.message
            );
        }
        // 单成员组保留任意策略：没有选路空间，和旧配置完全一致。
        assert!(ensure_nftables_groups_supported(&[
            (GroupStrategy::Failover, 1),
            (GroupStrategy::LeastConn, 1),
        ])
        .is_ok());
    }

    #[test]
    fn nftables_multi_target_requires_agent_29() {
        let groups = [
            (GroupStrategy::RoundRobin, 1),
            (GroupStrategy::RoundRobin, 2),
        ];
        let error =
            ensure_nftables_agent_supported(&groups, &[("old", Some(28)), ("new", Some(29))])
                .unwrap_err();
        assert_eq!(
            error.code,
            "chain.nftables_multi_target_requires_agent_upgrade"
        );
        assert_eq!(error.params["servers"], json!(["old"]));
        assert_eq!(
            error.params["required"],
            NFTABLES_MULTI_TARGET_MIN_PROTOCOL_VERSION
        );
        assert!(error.message.contains("old"), "{}", error.message);
        assert!(ensure_nftables_agent_supported(&groups, &[("new", Some(29))]).is_ok());
        assert!(
            ensure_nftables_agent_supported(&groups, &[("unknown", None)]).is_err(),
            "未知版本按旧版处理"
        );
        // 单成员组不需要多目标能力，旧 Agent 仍可保存。
        assert!(ensure_nftables_agent_supported(
            &[(GroupStrategy::RoundRobin, 1)],
            &[("old", Some(28))]
        )
        .is_ok());
    }

    #[test]
    fn nftables_blocked_reason_prefers_strategy_error_over_agent_upgrade() {
        let groups = vec![
            server("nft-chain", 0),
            multi_member_group("nft-chain", 1, "least_conn", Some(28)),
        ];
        let reason =
            nftables_multi_target_blocked_reason(&groups).expect("least_conn 多目标必须 blocked");
        assert_eq!(reason.code, "chain.nftables_strategy_unsupported");
        assert!(reason.message.contains("least_conn"), "{}", reason.message);

        let groups = vec![
            server("nft-chain", 0),
            multi_member_group("nft-chain", 1, "round_robin", Some(28)),
        ];
        let reason =
            nftables_multi_target_blocked_reason(&groups).expect("旧 Agent 多目标必须 blocked");
        assert_eq!(
            reason.code,
            "chain.nftables_multi_target_requires_agent_upgrade"
        );

        let mut groups = vec![
            server("nft-chain", 0),
            multi_member_group("nft-chain", 1, "round_robin", Some(29)),
        ];
        groups[0].members[0].server_protocol_version = Some(29);
        assert!(nftables_multi_target_blocked_reason(&groups).is_none());
    }

    #[test]
    fn blocked_reason_wires_the_nftables_matrix_not_a_blanket_rejection() {
        let chain = engine_chain("nft-chain", "nftables");
        let mut groups = vec![
            server("nft-chain", 0),
            multi_member_group("nft-chain", 1, "round_robin", Some(29)),
        ];
        groups[0].members[0].server_protocol_version = Some(29);
        // 能力未知（成员 nftables_available 为 None）会先被可用性门禁挡住；
        // 这里只确认 reason 不再是旧的 chain.nftables_multi_target。
        let reason = blocked_reason(&chain, &groups, &HashMap::new(), 0).unwrap();
        assert_eq!(reason.code, "chain.nftables_unavailable");

        let mut available = groups;
        for group in &mut available {
            for member in &mut group.members {
                member.nftables_available = Some(true);
            }
        }
        assert!(blocked_reason(&chain, &available, &HashMap::new(), 0).is_none());
    }

    #[test]
    fn blocked_reason_still_rejects_unsupported_nftables_strategies() {
        let chain = engine_chain("nft-chain", "nftables");
        let mut groups = vec![
            server("nft-chain", 0),
            multi_member_group("nft-chain", 1, "failover", Some(29)),
        ];
        for group in &mut groups {
            for member in &mut group.members {
                member.nftables_available = Some(true);
            }
        }
        let reason = blocked_reason(&chain, &groups, &HashMap::new(), 0).unwrap();
        assert_eq!(reason.code, "chain.nftables_strategy_unsupported");
    }

    #[test]
    fn an_empty_group_blocks_every_engine() {
        let groups = vec![
            server("native-chain", 0),
            empty_group("native-chain"),
            server("native-chain", 2),
        ];
        let reason = empty_group_blocked_reason(&groups).expect("空组必须阻断整链");
        assert_eq!(reason.code, "chain.group_empty");
        assert!(reason.message.contains("第 2 跳"), "{}", reason.message);

        let chain = Chain {
            id: "native-chain".into(),
            name: "native".into(),
            target_host: "1.1.1.1".into(),
            target_port: 443,
            enabled: true,
            engine: "native".into(),
            udp: false,
            protocol: "tcp".into(),
            proxy_protocol: false,
            transport: "none".into(),
            tunnel_security: "tls".into(),
            template_id: None,
            owner_user_id: None,
            created_at: 0,
            updated_at: 0,
        };
        let reason = blocked_reason(&chain, &groups, &HashMap::new(), 0)
            .expect("native 引擎也必须给出 blocked 原因");
        assert_eq!(reason.code, "chain.group_empty");
    }
}
