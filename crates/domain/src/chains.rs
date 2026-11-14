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

/// 组内选路策略的四个合法值（与 `PROTOCOL_VERSION = 12` 的线协议一致）。
pub const STRATEGY_NAMES: [&str; 4] = ["round_robin", "failover", "lowest_latency", "ip_hashed"];

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
}

impl GroupStrategy {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RoundRobin => "round_robin",
            Self::Failover => "failover",
            Self::LowestLatency => "lowest_latency",
            Self::IpHashed => "ip_hashed",
        }
    }

    /// 严格解析：只接受四个 snake_case 枚举值（大小写不敏感会掩盖配置错误）。
    pub fn parse(raw: &str) -> Result<Self, DomainError> {
        match raw.trim() {
            "round_robin" => Ok(Self::RoundRobin),
            "failover" => Ok(Self::Failover),
            "lowest_latency" => Ok(Self::LowestLatency),
            "ip_hashed" => Ok(Self::IpHashed),
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
    pub fn from_db(raw: &str) -> Self {
        Self::parse(raw).unwrap_or_default()
    }
}

/// 旧版单跳 id：`chain-<chain_id>-<seq>`。
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
    // Noise 的 UDP 中继本轮不做（QUIC 需要 TLS 证书）。保存路径已经拒绝，
    // 下发路径再挡一次：手工改库或旧数据不能让 Agent 起一个必然失败的端点。
    if protocol::allows_udp(&chain.protocol) && tunnel_security::is_noise(&chain.tunnel_security) {
        return Some(BlockedReason {
            code: "chain.tunnel_udp_requires_tls".to_string(),
            message: "tunnel 的 UDP 中继需要 TLS 安全模式 / the tunnel UDP relay requires the TLS security mode（Noise 的 UDP 本轮不做 / Noise over UDP is not implemented yet）".to_string(),
        });
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
    // 内网地址缺失先于引擎判定：只要这一跳真要内网地址却拿不到，整链都不能下发。
    if let Some(reason) = internal_address_blocked_reason(groups) {
        return Some(reason);
    }
    // 仅 UDP 需要每一跳的 Agent 协议 >= 16；旧 Agent 会把它悄悄变成 TCP。
    if let Some(reason) = agent_protocol_blocked_reason(chain, groups) {
        return Some(reason);
    }
    if engine::is_tunnel(&chain.engine) {
        return tunnel_blocked_reason(chain, groups);
    }
    if engine::is_nftables(&chain.engine) {
        if let Some((seq, _)) = groups
            .iter()
            .enumerate()
            .find(|(seq, group)| *seq >= 1 && group.members.len() > 1)
        {
            return Some(BlockedReason {
                code: "chain.nftables_multi_target".to_string(),
                message: format!(
                    "nftables 引擎暂不支持第 {} 组的多成员选路，请改成单成员组",
                    seq + 1
                ),
            });
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
    fn strategies_accept_exactly_the_four_wire_values() {
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
        assert_eq!(GroupStrategy::default(), GroupStrategy::RoundRobin);
        assert_eq!(GroupStrategy::RoundRobin.as_str(), "round_robin");

        for bad in ["", "RoundRobin", "round-robin", "random", "weighted"] {
            let error = GroupStrategy::parse(bad).unwrap_err();
            assert_eq!(error.code, "chain.strategy_invalid", "bad={bad:?}");
            assert!(
                error.message.contains("只支持 round_robin / failover"),
                "{}",
                error.message
            );
        }
        assert_eq!(
            GroupStrategy::from_db("garbage"),
            GroupStrategy::RoundRobin,
            "旧数据里的非法策略回落到轮询，不能拖垮整条链"
        );
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
}
