//! 跨链时延聚合（`/api/v1/overview/chain-health`）的纯逻辑。
//!
//! 输入是**一次读出的链拓扑**与**一次取出的窗口样本**，这里只做内存归并，
//! 不碰 SQL、不读 HTTP 上下文。口径与限制见 `docs/CHAIN-HEALTH.md`：
//!
//! * 链的第 N 组 → 第 N+1 组为一「段」，段的 `seq` 取**目标组**的 seq；
//! * 中间段样本条件：`server_id ∈ group[N].members` 且
//!   `target_server_id ∈ group[N+1].members`。单成员下一跳在旧 Agent 上会用
//!   兼容字段上报空 `target_server_id`，这里按「下一组唯一成员」补回；
//! * 最后一跳（最后一组 → 链目标）同样是一段，`seq = 最后一组 seq + 1`：
//!   `server_id ∈ 最后一组`、`target_server_id` 为空的样本归到它（Agent 对
//!   最后一跳的 forward 目标就是链目标，没有下一台服务器，所以目标 id 为空）。
//!   有样本时**不进** `missing_hops`；`p50` / `series` / `attempts` /
//!   `failures` / `loss_pct` 与中间段同形；
//! * 整体时延 = 同一桶里各段 p50 之和；任一段缺样本则该桶为 null；
//! * 当前值取最近 [`CURRENT_WINDOW_SECS`]（2 小时）的桶中位数，基线取此前
//!   [`BASELINE_WINDOW_SECS`]（24 小时）的桶中位数。选择 2h 而不是 24h 的
//!   原因：24h 中位数会把最近 2 小时的短时劣化稀释到 8% 的权重，回答不了
//!   「现在哪条链慢」；基线仍用 24h，避免单个桶的抖动。
//! * 丢包：每段取同一「当前窗口」（最近 2h，与 p50 一致）内
//!   `forward_probe_samples` 的 attempts / failures；单段 `loss = failures /
//!   attempts`，attempts = 0 时为 `null`（不是 0）。整链按各跳独立连乘
//!   `1 - Π(1 - loss_i)`；缺数据的段跳过，只有「部分段有数据」时才标
//!   `loss_partial`（全链无数据时 `loss_pct = null`、`loss_partial = false`）。
//! * `series[].loss_pct` 是**该时间桶**的整链丢包，用同一 `ts` 桶的各段
//!   探测计数连乘；桶内所有段都没探测时为 null（桶级不设 partial）。
//! * **最后一跳可测性**：Agent 只为 `engine = native` 且 `protocol = tcp` 的
//!   forward 启动目标探测（`target_health_loop`；realm / nftables / tunnel
//!   从不探测，`udp` / `both` 也不探测）。这类链的最后一跳**永远**不会有
//!   样本，不能参与 `series` 的「所有段齐全」判定、当前整体值、`missing_hops`
//!   与 `loss_partial`，否则整条曲线会被一个不可测的段拖空。可测性是链级
//!   属性（引擎 / 协议逐跳透传）：实现上只把**最后一跳**排除在齐全判定外，
//!   中间段的历史样本仍参与曲线（`status` 则整体判 `unknown`，因为这条链
//!   当前不可测）。`chains[].last_hop` 显式给出 `measurable` 与 `reason`，
//!   前端据此显示「最后一跳不可测量」而不是「无历史数据」。
//! * 多成员组（多路径）按段中位数求和，链级 `estimated = true`；丢包则把
//!   各成员的探测计数相加后再算比值。
//! * `entry` / `exit` 是链的展示起点/终点：首/末组里 `(priority, server_id)`
//!   最小的成员；入口端口优先 `chain_groups.public_port`，为空回退成员
//!   `listen_port`，终点固定用 `listen_port`。`servers.address` 为空时回退
//!   `internal_address` 并标 `address_source: "internal"`。
//! * `segments[].series` 与链级 `series` 同桶宽、同长度：每桶 p50 来自该段
//!   时延样本，loss_pct 来自该段探测桶（attempts = 0 → null），无样本桶为
//!   null。它与 entry/exit 一样只做内存归并，不新增 SQL。
//! * `nodes` 是链的拓扑节点：每个组一个（组级 `status` 取最差成员，
//!   `members` 按 `(priority, server_id)` 给出该组全部成员），末尾再补一个
//!   `role = target` 的链目标节点（`members` 是空数组、
//!   `server_id` / `status` 都是 null）。多成员组的成员全部可见，链级
//!   `estimated = true` 只表示段值是估算。`entry` / `exit` 保留，前端可渐进
//!   迁移。
//! * `status` 是链级可用性状态，按**跳**判断而不是按成员：任一 `source` /
//!   `hop` 组的**全部成员**都离线（这一跳没有在线成员）或组内没有成员 →
//!   `blocked`（`node_offline`，有离线成员时点名第一台）；每跳都至少有一台
//!   在线但存在离线成员 → 仍 `degraded`（`node_offline`，点名第一台离线
//!   成员，链路只是容量下降）；存在 `abnormal` 等非在线成员 → `degraded`
//!   （`node_unhealthy`）；否则最后一跳不可测 → `unknown`（`unmeasurable`，
//!   见上一条）；否则无当前样本 / 有断点 → `degraded`（`no_samples`）；否则
//!   较基线变慢 → `degraded`（`slow`）；否则 `ok`。成员状态优先于数据质量，
//!   所以掉线导致的缺样本不会被误判成 `no_samples`。链目标节点
//!   （`role = "target"`）没有成员，不参与判定。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::chains::GroupStrategy;
use crate::models::{ChainGroupMember, ChainGroupWithMembers, ChainWithGroups};
use crate::repo::chain_probe::ProbeBucketRow;
use crate::repo::latency::LatencySample;
use crate::telemetry::ProbeCounts;

/// 当前值窗口：最近 2 小时（按桶宽向下取整）。
pub const CURRENT_WINDOW_SECS: i64 = 2 * 60 * 60;
/// 基线窗口：当前窗口之前的 24 小时（按桶宽向下取整）。
pub const BASELINE_WINDOW_SECS: i64 = 24 * 60 * 60;
/// 「变慢的链」阈值：整体 p50 较基线上升 ≥ 8ms。
///
/// 与前端设计稿里的「稳定 = 没有超过 8ms 的变化」一致；8ms 也是跨公网
/// 一跳的常见抖动上限，低于它更像噪声而不是需要排障的事件。
pub const SLOW_DELTA_MS: f64 = 8.0;
/// 单段主导阈值：某段贡献 ≥ 80% 判 `single_hop`。
pub const SINGLE_HOP_CONTRIBUTION_PCT: f64 = 80.0;
/// 链目标节点的展示名：链路最后一跳连的就是它，没有服务器行可引用。
pub const CHAIN_TARGET_NAME: &str = "链目标";

/// 链级诊断。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diagnosis {
    /// `single_hop` / `overall` / `unknown`。
    pub kind: &'static str,
    /// 只有 `single_hop` 时给出主导段的 seq。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
}

impl Diagnosis {
    fn unknown() -> Self {
        Self {
            kind: "unknown",
            seq: None,
        }
    }
}

/// 最后一跳（最后一组 → 链目标）的可测性。
///
/// Agent 只对 `engine = native` 且 `protocol = tcp` 的 forward 跑目标探测
/// （`crates/agent/src/forward.rs` 的 `health_task` 条件是
/// `wants_tcp && !wants_udp`）。realm / nftables / tunnel 的规则从不探测
/// （心跳里 `probe_attempts` 一直是 `None`），`udp` / `both` 也明确不探测：
/// TCP 握手证明不了 UDP 可达。这些链的最后一跳永远不会产生样本，必须显式
/// 标注为「不可测」，而不是当成「缺失」。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LastHop {
    /// `false` = Agent 不会探测这一跳（引擎或协议不支持）。
    pub measurable: bool,
    /// 不可测原因：`engine_unsupported`（realm / nftables / tunnel）或
    /// `protocol_unsupported`（native + udp / both）。可测时为 `null`。
    pub reason: Option<&'static str>,
}

impl LastHop {
    /// 以 **Agent 实际探测条件**为准：`engine = native && protocol = tcp`。
    ///
    /// 引擎 / 协议都是链级字段（`derive_forwards` 逐跳透传），所以这一条同时
    /// 决定了中间段是否可测：不可测链的所有段都没有探测。
    pub fn of(engine: &str, protocol: &str) -> Self {
        if !crate::engine::is_native(engine) {
            return Self {
                measurable: false,
                reason: Some("engine_unsupported"),
            };
        }
        if crate::protocol::from_db(protocol) != crate::protocol::TCP {
            return Self {
                measurable: false,
                reason: Some("protocol_unsupported"),
            };
        }
        Self {
            measurable: true,
            reason: None,
        }
    }
}

/// 一「段」的视图：第 N 组 → 第 N+1 组；最后一跳是最后一组 → 链目标。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentView {
    /// 段编号：中间段取**目标组**的 `seq`，最后一跳取 `最后一组 seq + 1`
    /// （正常链是 1..=hops）。
    pub seq: i64,
    /// 源组代表成员名；多路径时是当前窗口样本最多的那台。
    pub from: String,
    /// 目标组代表成员名。
    pub to: String,
    /// 与链级 `series` **同桶宽、同长度**的逐段序列；没有该段样本的桶是
    /// `null`，不是 `{ p50: 0 }`。
    pub series: Vec<Option<SegmentSeriesPoint>>,
    /// 当前窗口的桶中位数；没有样本时 null，不是 0。
    pub p50: Option<f64>,
    /// `p50 - 基线 p50`；任一侧无样本时 null。
    pub delta_ms: Option<f64>,
    /// 正向增量占比（0..100，整数）。只把「变慢」的段计入分母。
    pub contribution_pct: i64,
    /// 当前窗口内的探测次数；没有探测时 0（`loss_pct` 为 null）。
    pub attempts: i64,
    /// 当前窗口内的探测失败次数。
    pub failures: i64,
    /// `failures / attempts × 100`（保留 4 位）；attempts = 0 时 null，不是 0。
    pub loss_pct: Option<f64>,
}

/// 逐段时间序列的一个点。空桶在 `SegmentView::series` 里是 `null`。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentSeriesPoint {
    pub ts: i64,
    /// 该段在该桶的 p50；能出现在这里就一定有值（空桶整体是 null）。
    pub p50: f64,
    /// 该段在该桶的丢包（%）；`attempts = 0` 时为 null，不是 0。
    pub loss_pct: Option<f64>,
}

/// 链的起点或终点：展示用的 `服务器地址:端口`。
///
/// 口径见 `docs/CHAIN-HEALTH.md`：起点是第一个组里 `priority` 最小的成员，
/// 端口优先用组级 `public_port`（为空回退该成员 `listen_port`）；终点是最后
/// 一组里 `priority` 最小的成员，端口固定用该成员 `listen_port`。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Endpoint {
    pub server_id: String,
    pub server_name: String,
    /// `ip:port`；IPv6 写成 `[ip]:port`。缺地址或缺端口时为 null，
    /// 但 `ip` 仍会保留（缺端口时）。
    pub address: Option<String>,
    /// `address` 里的主机部分；不做 DNS 解析，IPv6 不带方括号。
    pub ip: Option<String>,
    /// 实际用于拼 `address` 的端口；端口缺失/非法时为 null。
    pub port: Option<i64>,
    /// 只有 `servers.address` 为空、回退到 `internal_address` 时才出现，
    /// 值为 `"internal"`；正常情况省略这个字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address_source: Option<&'static str>,
}

/// 一组探测计数（整链各段之和）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct LossSamples {
    pub attempts: i64,
    pub failures: i64,
}

/// 组内一个成员（服务器）的展示视图。
///
/// `status` 是 `servers.status` 的原样透传（online / offline / abnormal /
/// no_data …），不做二次推断；组级状态由 [`NodeView::status`] 取最差成员得到。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NodeMember {
    /// `chain_group_members.server_id`，即 `servers.id`。
    pub server_id: String,
    /// `servers.name`。
    pub name: String,
    /// 成员服务器的 `servers.status`。
    pub status: String,
}

/// 链上的一个拓扑节点：一个组一个，末端的链目标再补一个。
///
/// 口径见 `docs/CHAIN-HEALTH.md`：组节点带该组**全部**成员（`members` 按
/// `(priority, server_id)` 排序，`member_count` 是成员数），组级 `status` 取
/// 最差成员（offline > 其它非 online > online；空组为 null）；`server_id` /
/// `name` 仍是该组代表成员（`(priority, server_id)` 最小）的兼容字段，
/// `name` 优先用组名（组名为空才回退代表成员名）。链目标节点没有服务器行，
/// `server_id` / `status` 为 null，`members` 是空数组、`member_count = 0`。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NodeView {
    /// 组节点的 `seq` 取组的 seq；链目标节点取「最后一组 seq + 1」。
    pub seq: i64,
    /// 该组代表成员的 `server_id`（`(priority, server_id)` 最小，与
    /// `entry` / `exit` 同口径）；链目标节点与没有成员的组为 null。
    pub server_id: Option<String>,
    /// 组名优先；组名不可用时用代表成员名（空组回退 `第 N 跳`）；
    /// 链目标节点是 `"链目标"`。
    pub name: String,
    /// `source`（第一组）/ `hop`（其余组）/ `target`（链目标）。
    pub role: &'static str,
    /// 组级聚合状态：取该组最差成员（offline > abnormal/no_data > online）。
    /// 空组与链目标节点为 null。**这个字段只描述组内最差成员**：多成员组里
    /// 一台离线会让组级变 `offline`，但链级是否阻断取决于该组还有没有在线
    /// 成员（见 [`ChainStatus`]）——组级 `offline` 不等于链 `blocked`。
    pub status: Option<String>,
    /// `members` 的长度；链目标节点与空组为 0。
    pub member_count: usize,
    /// 该组全部成员，顺序同 `(priority, server_id)`；链目标节点是空数组。
    pub members: Vec<NodeMember>,
    /// 该组的选路策略：`round_robin` / `failover` / `lowest_latency` /
    /// `ip_hashed` / `weighted` / `least_conn`。入口组没有上一跳、链目标
    /// 节点没有选路，两者都是 null；库里的非法值回落 `round_robin`。
    pub strategy: Option<String>,
    /// 从入口代表成员沿 Agent 上报的「当前选中」走出的当前通路成员
    /// （`server_id`）。入口组与链目标恒为 null；某跳没有单一选中项、
    /// 没有心跳记录、选中项不在该组或上一跳成员不在线时，从该跳起都是 null。
    pub active_server_id: Option<String>,
}

/// 心跳 `forward_status.targets_json` 里的一个目标探测结果（链视图用）。
///
/// 与线协议的 `TargetProbe` 同形，但 domain 不依赖 proto，所以单独定义。
/// 每个字段都有 serde 默认值：旧 Agent 的 JSON 没有 `active`（缺键 / null）
/// 时解析成 None，不因为新增字段让整条链视图失败。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TargetProbeRow {
    #[serde(default)]
    pub server_id: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub latency_ms: Option<u32>,
    #[serde(default)]
    pub active: Option<bool>,
}

/// 链级可用性状态里被点名的节点（具体到成员）。
///
/// 只带展示需要的 `seq` / `name` / `member_name`；具体原因由上层 `cause`
/// 表达，不在这里重复。`node_offline` 的 `blocked` 与 `degraded` 都会带
/// 这个字段（前者是「整跳没有在线成员」，后者是「仍可用但少了成员」）；
/// 空组导致 `blocked` 时没有成员可点名，`node` 为 `null`。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatusNode {
    /// 离线成员所在组的 `seq`。
    pub seq: i64,
    /// 离线成员的展示名（保留旧字段语义，与 `member_name` 相同）。
    pub name: String,
    /// 离线成员名；`node_offline` 时总有值，显式给出便于前端不区分组节点名
    /// 与成员名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_name: Option<String>,
}

/// 链级可用性状态：把节点状态与链路数据合成为一个用户能直接看的状态。
///
/// 可用性按**跳**判断：多成员组里离线一台只降低容量，链路仍可用。
/// 判定优先级（高 → 低）：
/// 1. 任一 `source` / `hop` 组的成员**全部离线**（这一跳没有任何在线成员；
///    只有 `abnormal` / `no_data`、没有离线成员的跳见第 3 条）或**没有成员**
///    （空组）→ `blocked` + `node_offline`，`node` 指向拓扑上先遇到的那台
///    离线成员（组 `seq` 升序、组内 `(priority, server_id)` 顺序）；空组没有
///    成员可点名时为 `null`；
/// 2. 每跳都至少有一台在线，但存在离线成员 → `degraded` + `node_offline`，
///    `node` 同样指向第一台离线成员及其组（链路只是容量下降）；
/// 3. 每跳都至少有一台在线，但存在 `abnormal` / `no_data` 等非在线成员 →
///    `degraded` + `node_unhealthy`；
/// 4. 最后一跳不可测（见 [`LastHop`]；引擎 / 协议是链级字段，所以这条链的
///    **所有段**都不可测）→ `unknown` + `unmeasurable`：这条链的探测数据
///    永远不会齐全，报 `no_samples` 会让用户误以为「Agent 没上报 / 链路坏了」，
///    而不是「这种引擎 / 协议本来就不测」；
/// 5. 当前窗口没有整体样本，或 `missing_hops` 非空 → `degraded` + `no_samples`；
/// 6. 整体较基线变慢（与 `summary.slow_chains` 同一个 [`SLOW_DELTA_MS`] 阈值）
///    → `degraded` + `slow`；
/// 7. 其余 → `ok`，`cause` / `node` 都是 `null`。
///
/// `role = "target"` 的链目标节点不参与判定：它没有成员，`status` 恒为
/// `null`。成员优先级高于数据质量，所以「成员掉线导致缺样本」会得到
/// `blocked` / `degraded` 的 `node_offline`，不会被误判成 `no_samples`。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChainStatus {
    /// `ok` / `degraded` / `blocked` / `unknown`。
    pub kind: &'static str,
    /// `node_offline` / `node_unhealthy` / `no_samples` / `slow` /
    /// `unmeasurable`；`ok` 时为 `null`。
    pub cause: Option<&'static str>,
    /// 只有 `node_offline` 时给出第一台离线节点（`blocked` 与 `degraded`
    /// 都可能带）；空组导致的 `blocked` 没有成员可点名，为 `null`。
    pub node: Option<StatusNode>,
}

impl ChainStatus {
    fn ok() -> Self {
        Self {
            kind: "ok",
            cause: None,
            node: None,
        }
    }

    fn degraded(cause: &'static str) -> Self {
        Self {
            kind: "degraded",
            cause: Some(cause),
            node: None,
        }
    }

    /// 不可测链：Agent 不会为这条链产生探测样本，所以「没有数据」是预期
    /// 状态，既不是健康也不是降级。
    fn unmeasurable() -> Self {
        Self {
            kind: "unknown",
            cause: Some("unmeasurable"),
            node: None,
        }
    }
}

/// 组级状态取最差成员：`offline` > 其它非 `online`（`abnormal` / `no_data` …）
/// > `online`；空组没有成员可引用，返回 `null`。
///
/// 多个成员同档时取 `(priority, server_id)` 顺序里的第一台，结果稳定。
fn group_status(members: &[NodeMember]) -> Option<String> {
    let mut worst: Option<(u8, &str)> = None;
    for member in members {
        let rank = match member.status.as_str() {
            "online" => 1,
            // 库里可能存在 abnormal / no_data 等值：都归到「非在线」一档，
            // 同档时保留先遇到的那个原始值。
            "offline" => 3,
            _ => 2,
        };
        if worst.is_none_or(|(worst_rank, _)| rank > worst_rank) {
            worst = Some((rank, member.status.as_str()));
        }
    }
    worst.map(|(_, status)| status.to_string())
}

/// 根据节点（组内全部成员）状态与数据质量判定链级可用性；优先级见
/// [`ChainStatus`]。
///
/// 可用性按**跳**判断，不按成员：一个必需跳只要还有至少一台 `online` 成员，
/// 这一跳就能承载流量，多掉的成员只降低容量（`degraded`）；整跳成员全部离线
/// 或空组才会让整条链不可用（`blocked`）。只有 `abnormal` / `no_data`、没有
/// 离线成员的跳仍按旧口径降级（没被确认离线，仍可能恢复）。
fn chain_status(
    nodes: &[NodeView],
    missing_hops: &[i64],
    current_overall: Option<f64>,
    baseline_overall: Option<f64>,
    last_hop_measurable: bool,
) -> ChainStatus {
    // 1. blocked：任一必需跳（source / hop）**成员全部离线**或根本没有成员。
    // 2. degraded：每跳都还有在线成员，但存在离线成员（node_offline，点名第一
    //    台离线成员）或状态异常成员（node_unhealthy）。
    let mut blocked = false;
    let mut first_offline: Option<(&NodeView, &NodeMember)> = None;
    let mut unhealthy = false;
    for node in nodes.iter().filter(|node| node.role != "target") {
        // 空组没有任何成员能承载这一跳：与「全部离线」同档，都是 blocked。
        if node.members.is_empty() {
            blocked = true;
            continue;
        }
        let mut online = 0_usize;
        let mut has_offline = false;
        for member in &node.members {
            match member.status.as_str() {
                "online" => online += 1,
                "offline" => {
                    has_offline = true;
                    // nodes 按组 seq 升序、members 按 (priority, server_id) 升序，
                    // 所以第一台命中的就是「拓扑上最先遇到」的离线成员。
                    if first_offline.is_none() {
                        first_offline = Some((node, member));
                    }
                }
                // `abnormal` / `no_data` 等库内值都算「非在线」：跳仍可能在
                // 线成员支撑，但这种状态说不清，整条链只能降级。
                _ => unhealthy = true,
            }
        }
        // 这一跳已经没有任何在线成员：多成员组也救不回来，整链不可用。
        // 只有 abnormal / no_data、没有 offline 的跳沿用旧口径降级：它没被
        // 确认离线，仍有恢复的可能，不能报成阻断。
        if online == 0 && has_offline {
            blocked = true;
        }
    }
    let offline_node = first_offline.map(|(node, member)| StatusNode {
        seq: node.seq,
        name: member.name.clone(),
        member_name: Some(member.name.clone()),
    });
    if blocked {
        // 空组会让 `node` 为 null：没有成员可点名。
        return ChainStatus {
            kind: "blocked",
            cause: Some("node_offline"),
            node: offline_node,
        };
    }
    if offline_node.is_some() {
        // 每跳都还有在线成员：离线的那几台只是让链路降级（容量下降）。
        return ChainStatus {
            kind: "degraded",
            cause: Some("node_offline"),
            node: offline_node,
        };
    }
    if unhealthy {
        return ChainStatus::degraded("node_unhealthy");
    }
    // 引擎 / 协议本来就不探测：没有数据是预期状态，不能报 no_samples。
    // 放在节点状态之后：一条真正掉线的链仍然是 blocked，而不是 unknown。
    if !last_hop_measurable {
        return ChainStatus::unmeasurable();
    }
    // 当前窗口没有任何一个「所有段齐全」的桶，说明最近 2 小时测不出整链时延；
    // 有断点（空组 / 最后一跳完全没有样本）同样算样本不足。
    if missing_hops.is_empty() && current_overall.is_some() {
        return if is_slow(current_overall, baseline_overall) {
            ChainStatus::degraded("slow")
        } else {
            ChainStatus::ok()
        };
    }
    ChainStatus::degraded("no_samples")
}

/// 整体变慢：当前整体 p50 比 24h 基线高至少 [`SLOW_DELTA_MS`]。
///
/// `summary.slow_chains` 与逐链 `status.cause = "slow"` 共用这一个口径，
/// 避免两处阈值漂移。
fn is_slow(current: Option<f64>, baseline: Option<f64>) -> bool {
    match (current, baseline) {
        (Some(current), Some(baseline)) => current - baseline >= SLOW_DELTA_MS,
        _ => false,
    }
}

/// 整体时间序列的一个点；空桶在数组里是 `null`。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SeriesPoint {
    pub ts: i64,
    pub p50: f64,
    pub p10: f64,
    pub p90: f64,
    pub samples: i64,
    /// 该桶内的整链丢包（%；各段取同一 `ts` 桶的 attempts/failures 连乘）。
    /// 桶内所有段都没有探测时为 null，不补 0。
    pub loss_pct: Option<f64>,
}

/// 一条链的聚合结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChainHealth {
    pub id: String,
    pub name: String,
    /// 链的组数（入口 + 中转 + 出口）。4 组 = 4 段：3 个中间段 + 最后一跳。
    pub hops: i64,
    /// 链的起点：第一个组里优先级最高的成员。没有任何成员时 null。
    pub entry: Option<Endpoint>,
    /// 链的终点：最后一个组里优先级最高的成员。没有任何成员时 null。
    pub exit: Option<Endpoint>,
    /// 拓扑节点：每个组一个（带全部成员与组级最差状态）+ 末尾的链目标节点
    /// （`role = "target"`，成员为空）。没有任何组的脏数据是空数组。
    pub nodes: Vec<NodeView>,
    /// 存在多成员组（多路径），整体/逐段都是估算值。
    pub estimated: bool,
    /// 无法测量的跳：只有「最后一跳没有任何时延/探测样本」或「成员为空的组」
    /// 才会列进来；有最后一跳样本时**不含**最后一跳。最后一跳不可测
    /// （引擎 / 协议不支持探测，见 [`LastHop`]）时**也不含**它——那是
    /// 「测不了」，不是「缺数据」。空数组只可能出现在没有任何组的脏数据上。
    pub missing_hops: Vec<i64>,
    /// 最后一跳是否可被 Agent 探测；不可测时它不参与 `series` 齐全判定、
    /// 当前整体值与 `missing_hops`。口径见 [`LastHop`]。
    pub last_hop: LastHop,
    /// 链级可用性状态（按跳判断）：整跳没有在线成员 → `blocked`，多成员组
    /// 部分离线 / 成员异常 / 样本不足 / 变慢 → `degraded`，不可测 → `unknown`，
    /// 其余 `ok`。判定优先级见 [`ChainStatus`]。
    pub status: ChainStatus,
    /// 固定长度 = `hours * 3600 / bucket`；无样本桶是 `null`。
    pub series: Vec<Option<SeriesPoint>>,
    /// 逐段视图，按目标组 seq 升序。
    pub segments: Vec<SegmentView>,
    /// 整链丢包：各段独立连乘 `1 - Π(1 - loss_i)`（%）；没有可用段时 null。
    pub loss_pct: Option<f64>,
    /// 参与连乘的各段探测次数 / 失败次数之和；没有可用段时是 `{0, 0}`。
    pub loss_samples: LossSamples,
    /// 有段缺探测数据且另有段有数据时为 true：该段被跳过，整链
    /// `loss_pct` 只覆盖有数据的段。**全部段都没有探测数据时是 false**
    /// （此时整链 `loss_pct` 为 null，前端只显示「无探测数据」，不能同时
    /// 声称「部分跳缺少数据」）。
    pub loss_partial: bool,
    pub diagnosis: Diagnosis,
}

/// 跨链汇总。
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct Summary {
    /// 退化最严重那条链的当前整体 p50（整数毫秒）；没有可用数据时 null。
    pub hop_p50_ms: Option<i64>,
    /// 上述链当前整体 p50 相对 24h 基线的变化；没有配对数据时 null。
    pub delta_ms: Option<i64>,
    /// 较基线上升 ≥ [`SLOW_DELTA_MS`] 的链数。
    pub slow_chains: i64,
    /// 本次响应里的链数（筛选后）。
    pub total_chains: i64,
    /// 当前窗口 p50 最高的段；没有段数据时 null。
    pub worst_hop: Option<HopRef>,
    /// 当前可见链里最差的一条的整链丢包（%）；没有可用丢包数据时 null。
    pub loss_pct: Option<f64>,
    /// 上述最差丢包链；与 `loss_pct` 同源，没有数据时 null。
    pub worst_loss: Option<LossRef>,
}

/// 最差丢包链的位置。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LossRef {
    pub chain_id: String,
    pub chain_name: String,
    pub loss_pct: f64,
}

/// 最慢段的位置。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HopRef {
    pub chain_id: String,
    pub chain_name: String,
    pub seq: i64,
    pub p50_ms: i64,
}

/// 一次聚合的完整结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Aggregate {
    pub summary: Summary,
    pub chains: Vec<ChainHealth>,
    /// 本应映射到某段却失败的样本数：目标组多成员但 Agent 只上报了空目标、
    /// 最后一跳却带了一个非空目标、链改过成员后的历史残留等。最后一跳用空
    /// 目标上报是**预期**格式（Agent 探测的就是链目标，没有成员 id），
    /// 不计入这里。
    pub unmapped_forwards: i64,
}

/// 样本查询的起点：覆盖请求的时间轴窗口与 24h 基线中更老的一侧。
///
/// 路由层用它算出 `since`，保证「一次取窗口样本」就够聚合，不再为基线
/// 单独查一次。
pub fn sample_window_start(now: i64, hours: i64, bucket: i64) -> i64 {
    if hours <= 0 || bucket <= 0 {
        return now;
    }
    let end = aligned_end(now, bucket);
    let series_start = end - hours * 3600;
    let current_count = current_bucket_count(hours, bucket);
    let current_start = end - current_count * bucket;
    let baseline_count = baseline_bucket_count(bucket);
    (series_start).min(current_start - baseline_count * bucket)
}

fn aligned_end(now: i64, bucket: i64) -> i64 {
    now - now.rem_euclid(bucket) + bucket
}

fn current_bucket_count(hours: i64, bucket: i64) -> i64 {
    let series_buckets = (hours * 3600 / bucket).max(1);
    (CURRENT_WINDOW_SECS / bucket).clamp(1, series_buckets)
}

fn baseline_bucket_count(bucket: i64) -> i64 {
    (BASELINE_WINDOW_SECS / bucket).max(1)
}

/// 当前值窗口的 `[start, end)`（与 `sample_window_start` 同一套对齐规则）。
///
/// 路由层用它给 `forward_probe_samples` 取数，保证丢包和 p50 用的是**同一个
/// 当前窗口**（最近 2h，请求窗口不足 2h 时退化为请求窗口）。
pub fn current_window(now: i64, hours: i64, bucket: i64) -> (i64, i64) {
    if hours <= 0 || bucket <= 0 {
        return (now, now);
    }
    let end = aligned_end(now, bucket);
    let current_count = current_bucket_count(hours, bucket);
    (end - current_count * bucket, end)
}

/// 时间轴窗口的 `[start, end)`：从对齐后的 `end` 往前 `hours` 小时。
///
/// 路由层用它给 `forward_probe_samples` 取数：逐桶丢包需要 `series` 覆盖到
/// 的每个探测桶（不只是当前 2h 窗口）。
pub fn series_window(now: i64, hours: i64, bucket: i64) -> (i64, i64) {
    if hours <= 0 || bucket <= 0 {
        return (now, now);
    }
    let end = aligned_end(now, bucket);
    let count = (hours * 3600 / bucket).max(1);
    (end - count * bucket, end)
}

/// 纯内存聚合。`chains` 必须已经按 `server_ids` 筛选过；`samples` 是这些链
/// 所有成员的 `forward_latency_samples`（`ts >= sample_window_start`）；
/// `probes` 是同一批成员 forward 在 [`series_window`] 内的 5 分钟探测桶。
/// 当前窗口的整链丢包与 `series[].loss_pct` 都由这批桶内存聚合得到。
pub fn aggregate(
    chains: &[ChainWithGroups],
    samples: &[LatencySample],
    probes: &[ProbeBucketRow],
    latest_targets: &HashMap<String, Vec<TargetProbeRow>>,
    now: i64,
    hours: i64,
    bucket: i64,
) -> Aggregate {
    if bucket <= 0 || hours <= 0 {
        return Aggregate {
            summary: Summary {
                total_chains: chains.len() as i64,
                ..Summary::default()
            },
            chains: Vec::new(),
            unmapped_forwards: 0,
        };
    }

    let count = (hours * 3600 / bucket).max(1);
    let (series_start, end) = series_window(now, hours, bucket);
    let (current_start, _) = current_window(now, hours, bucket);
    let baseline_count = baseline_bucket_count(bucket);
    let baseline_start = current_start - baseline_count * bucket;
    let since = series_start.min(baseline_start);

    let mut layouts: Vec<Layout> = chains.iter().map(Layout::from_chain).collect();
    // 每链算完 Layout 后，把「当前通路」写进节点；没有任何心跳记录时全是 null。
    for layout in &mut layouts {
        let active = active_members(layout, latest_targets);
        for (node, active) in layout.nodes.iter_mut().zip(active) {
            node.active_server_id = active;
        }
    }
    let mut forward_map: HashMap<String, (usize, usize, usize)> = HashMap::new();
    for (chain_index, layout) in layouts.iter().enumerate() {
        for (group_index, members) in layout.groups.iter().enumerate() {
            let seq = layout.group_seq[group_index];
            for (member_index, member) in members.iter().enumerate() {
                let forward_id =
                    crate::chains::forward_id(&layout.chain_id, seq, &member.id, members.len());
                forward_map
                    .entry(forward_id)
                    .or_insert((chain_index, group_index, member_index));
            }
        }
    }

    // (chain, segment, series bucket) → 该桶的探测计数。forward 是「每跳入口」
    // 的探测，这里把同一段所有成员（多路径）的计数相加。段 index 恒等于源组
    // index：中间段是 group[i] → group[i+1]，最后一组的 forward 探测的是链
    // 目标，归到最后一跳（index = 最后一组 index）。
    let mut segment_probe_buckets: HashMap<(usize, usize, i64), ProbeCounts> = HashMap::new();
    // 同一批桶里落在当前窗口（最近 2h）的部分，用于整链窗口丢包。
    let mut segment_probes: HashMap<(usize, usize), ProbeCounts> = HashMap::new();
    // 每条链的最后一跳是否在窗口内出现过时延样本或探测桶；只有完全没有数据
    // 时才把它写进 missing_hops。
    let mut final_hop_seen = vec![false; layouts.len()];
    for row in probes {
        let Some(&(chain_index, group_index, _)) = forward_map.get(&row.forward_id) else {
            continue;
        };
        let layout = &layouts[chain_index];
        let bucket_ts = row.ts.div_euclid(bucket) * bucket;
        if bucket_ts < series_start || bucket_ts >= end {
            continue;
        }
        let counts = ProbeCounts {
            attempts: row.attempts.max(0),
            failures: row.failures.max(0),
        };
        // attempts = 0 的行不算「有样本」：它只是计数基线，没有真实探测。
        // 不可测链的最后一跳永远没有探测，不必（也不该）标记「见过」。
        if layout.final_hop_seq.is_some()
            && layout.last_hop.measurable
            && group_index + 1 == layout.groups.len()
            && counts.attempts > 0
        {
            final_hop_seen[chain_index] = true;
        }
        segment_probe_buckets
            .entry((chain_index, group_index, bucket_ts))
            .or_default()
            .add(counts);
        if bucket_ts >= current_start {
            segment_probes
                .entry((chain_index, group_index))
                .or_default()
                .add(counts);
        }
    }

    // (chain, segment, bucket) → 原始延迟值；桶内再算分位数。
    let mut bucket_values: HashMap<(usize, usize, i64), Vec<f64>> = HashMap::new();
    // 当前窗口内 (源, 目标) 的样本数，用来给多路径段挑代表成员。
    let mut pair_counts: PairCounts = HashMap::new();
    let mut unmapped_forwards = 0_i64;

    for sample in samples {
        if sample.ts < since || sample.ts >= end {
            continue;
        }
        let Some(&(chain_index, group_index, member_index)) = forward_map.get(&sample.forward_id)
        else {
            unmapped_forwards += 1;
            continue;
        };
        let layout = &layouts[chain_index];
        let Some(source) = layout
            .groups
            .get(group_index)
            .and_then(|members| members.get(member_index))
        else {
            unmapped_forwards += 1;
            continue;
        };
        if source.id != sample.server_id {
            // forward_id 与上报的 server_id 不自洽（链被改过/脏数据）。
            unmapped_forwards += 1;
            continue;
        }
        // 段 index = 源组 index。最后一跳没有「下一台服务器」：Agent 对最后
        // 一组的 forward 目标就是链目标，`target_server_id` 是空串。空目标在
        // 这里才是正确格式；带非空目标说明是链改过成员后的历史残留。
        let final_hop = group_index + 1 == layout.groups.len();
        let target_id = if final_hop {
            if !sample.target_server_id.is_empty() {
                unmapped_forwards += 1;
                continue;
            }
            String::new()
        } else {
            // final_hop = false 时下一组一定存在（段 index = 源组 index）。
            let target_members = &layout.groups[group_index + 1];
            let target_id = if sample.target_server_id.is_empty() {
                // 单成员下一跳走兼容字段，Agent 拿不到 server_id；唯一成员可确定。
                if target_members.len() == 1 {
                    target_members[0].id.clone()
                } else {
                    unmapped_forwards += 1;
                    continue;
                }
            } else {
                sample.target_server_id.clone()
            };
            if !target_members.iter().any(|member| member.id == target_id) {
                unmapped_forwards += 1;
                continue;
            }
            target_id
        };
        let bucket_ts = sample.ts.div_euclid(bucket) * bucket;
        // `since` 同时覆盖 series 与基线里更老的一侧：hours > 26 时基线在
        // 时间轴内部，不能把基线之前的 series 桶误丢。
        if bucket_ts < since {
            continue;
        }
        // B6：最后一跳「有样本」只认 **series 窗口**（请求的 hours），不能
        // 用 26h 基线窗口——基线里的旧样本会让一个最近没有数据的最后一跳
        // 从 `missing_hops` 里消失。
        if final_hop && layout.last_hop.measurable && bucket_ts >= series_start {
            final_hop_seen[chain_index] = true;
        }
        bucket_values
            .entry((chain_index, group_index, bucket_ts))
            .or_default()
            .push(sample.latency_ms as f64);
        if bucket_ts >= current_start {
            pair_counts
                .entry((chain_index, group_index))
                .or_default()
                .entry((source.id.clone(), target_id))
                .and_modify(|count| *count += 1)
                .or_insert(1);
        }
    }

    // 桶内分位数只算一次，序列/当前/基线三条路径共用。
    let mut stats: HashMap<(usize, usize, i64), BucketStats> = HashMap::new();
    for ((chain_index, segment_index, ts), mut values) in bucket_values {
        values.sort_by(|a, b| a.total_cmp(b));
        stats.insert(
            (chain_index, segment_index, ts),
            BucketStats {
                p10: percentile(&values, 0.10),
                p50: percentile(&values, 0.50),
                p90: percentile(&values, 0.90),
                samples: values.len() as i64,
            },
        );
    }

    let mut views = Vec::with_capacity(chains.len());
    for (chain_index, layout) in layouts.iter().enumerate() {
        // 段数 = 组数：组 i → 组 i+1（i < hops-1）再加最后一组 → 链目标。
        // 空组仍保留一个 p50 为 null 的段，与中间段同形。
        let segment_count = layout.hops.max(0) as usize;
        // 不可测的最后一跳不参与「所有段齐全」判定：否则 realm / nftables /
        // tunnel / udp / both 链的整条曲线会被一个永远没有样本的段拖空。
        // 可测性由引擎 / 协议决定（链级），所以不可测链只保留中间段。
        let measured_segments = if layout.last_hop.measurable {
            segment_count
        } else {
            segment_count.saturating_sub(1)
        };

        // 最后一跳只有「窗口内完全没有时延样本、也没有探测桶」时才进
        // missing_hops；成员为空的组造成的断点由 topology 预先给出。
        // 不可测的最后一跳是「测不了」，不是「缺数据」，同样不进。
        let mut missing_hops = layout.missing_hops.clone();
        if let Some(seq) = layout.final_hop_seq {
            if layout.last_hop.measurable && !final_hop_seen[chain_index] {
                missing_hops.push(seq);
            }
        }
        missing_hops.sort_unstable();
        missing_hops.dedup();

        // 时间轴：固定长度，空桶 null。
        let mut series = Vec::with_capacity(count as usize);
        for index in 0..count {
            let ts = series_start + index * bucket;
            let mut total = StatsAccumulator::default();
            let mut complete = measured_segments > 0;
            for segment_index in 0..measured_segments {
                match stats.get(&(chain_index, segment_index, ts)) {
                    Some(bucket_stats) => total.add(bucket_stats),
                    None => {
                        complete = false;
                        break;
                    }
                }
            }
            // 桶级丢包与 p50 同桶：某段该桶无探测就跳过，全部段都无探测
            // 才是 null；桶级没有 partial 字段，缺失只由 null 表达。
            let loss_pct = if complete {
                chain_loss_for_bucket(&segment_probe_buckets, chain_index, measured_segments, ts)
            } else {
                None
            };
            series.push(complete.then(|| total.into_point(ts, loss_pct)));
        }

        // 当前窗口（最近 2h）与基线窗口（此前 24h）：逐桶 p50，再取中位数。
        // 不可测的最后一跳不进入整体值；它自己的段级 p50 仍按历史样本原样给出。
        let current = window_segment_p50s(
            &stats,
            chain_index,
            segment_count,
            measured_segments,
            current_start,
            end,
            bucket,
        );
        let baseline = window_segment_p50s(
            &stats,
            chain_index,
            segment_count,
            measured_segments,
            baseline_start,
            current_start,
            bucket,
        );

        // 逐段序列与链级 series 同桶宽、同长度；空桶 null。数据全部来自
        // 上面那批内存 map，不新增任何 SQL。
        let segment_series: Vec<Vec<Option<SegmentSeriesPoint>>> = (0..segment_count)
            .map(|segment_index| {
                (0..count)
                    .map(|index| {
                        let ts = series_start + index * bucket;
                        stats
                            .get(&(chain_index, segment_index, ts))
                            .map(|bucket_stats| SegmentSeriesPoint {
                                ts,
                                p50: round1(bucket_stats.p50),
                                loss_pct: segment_loss_for_bucket(
                                    &segment_probe_buckets,
                                    chain_index,
                                    segment_index,
                                    ts,
                                ),
                            })
                    })
                    .collect()
            })
            .collect();

        let mut segments = Vec::with_capacity(segment_count);
        let mut deltas = Vec::with_capacity(segment_count);
        let mut survival = 1.0_f64;
        let mut loss_samples = LossSamples::default();
        let mut loss_segments = 0_usize;
        let mut missing_segments = 0_usize;
        for (segment_index, series) in segment_series.into_iter().enumerate() {
            let current_p50 = current.segment_p50[segment_index];
            let baseline_p50 = baseline.segment_p50[segment_index];
            let delta = match (current_p50, baseline_p50) {
                (Some(current), Some(baseline)) => Some(current - baseline),
                _ => None,
            };
            deltas.push(delta);
            // 丢包只看当前窗口（与 p50 同窗口）。attempts = 0 是「没有探测」，
            // 必须保持 null：补 0 会被读成 0% 丢包。
            let counts = segment_probes
                .get(&(chain_index, segment_index))
                .copied()
                .unwrap_or_default();
            let loss = (counts.attempts > 0)
                .then(|| (counts.failures.max(0) as f64 / counts.attempts as f64).clamp(0.0, 1.0));
            match loss {
                Some(loss) => {
                    survival *= 1.0 - loss;
                    loss_segments += 1;
                    loss_samples.attempts = loss_samples.attempts.saturating_add(counts.attempts);
                    loss_samples.failures = loss_samples.failures.saturating_add(counts.failures);
                }
                // 不可测的最后一跳本来就不会有探测，不能算「部分跳缺数据」。
                None if segment_index < measured_segments => missing_segments += 1,
                None => {}
            }
            let (from, to) = layout.representative(chain_index, segment_index, &pair_counts);
            segments.push(SegmentView {
                seq: layout.segment_seq[segment_index],
                from,
                to,
                series,
                p50: current_p50.map(round1),
                delta_ms: delta.map(round1),
                contribution_pct: 0,
                attempts: counts.attempts,
                failures: counts.failures,
                loss_pct: loss.map(|loss| round4(loss * 100.0)),
            });
        }
        // 各跳独立：整链 = 1 - Π(1 - loss_i)。缺数据的段已跳过，不能把
        // 「不知道」当成 0 后声称整链完好。
        // partial 只在「有的段有数据、有的段没有」时为 true；全链都没有
        // 探测时 loss_pct 本身就是 null，再标 partial 会自相矛盾。
        // 不可测的最后一跳不参与 partial 判定（它永远不会被探测）。
        let loss_partial = loss_segments > 0 && missing_segments > 0;
        let chain_loss_pct = (loss_segments > 0).then(|| round4((1.0 - survival) * 100.0));

        // 正向增量占比：分母只算「变慢」的段。
        let total_positive: f64 = deltas
            .iter()
            .filter_map(|delta| *delta)
            .filter(|delta| *delta > 0.0)
            .sum();
        for (segment, delta) in segments.iter_mut().zip(deltas.iter()) {
            segment.contribution_pct = match delta {
                Some(delta) if *delta > 0.0 && total_positive > 0.0 => {
                    (delta / total_positive * 100.0).round() as i64
                }
                _ => 0,
            };
        }

        let current_overall = median(&current.overall);
        let baseline_overall = median(&baseline.overall);
        let diagnosis = diagnose(&segments, current_overall, baseline_overall);
        let status = chain_status(
            &layout.nodes,
            &missing_hops,
            current_overall,
            baseline_overall,
            layout.last_hop.measurable,
        );

        views.push(ChainViewBuild {
            view: ChainHealth {
                id: layout.chain_id.clone(),
                name: layout.chain_name.clone(),
                hops: layout.hops,
                entry: layout.entry.clone(),
                exit: layout.exit.clone(),
                nodes: layout.nodes.clone(),
                estimated: layout.estimated,
                missing_hops,
                last_hop: layout.last_hop.clone(),
                status,
                series,
                segments,
                loss_pct: chain_loss_pct,
                loss_samples,
                loss_partial,
                diagnosis,
            },
            current_overall,
            baseline_overall,
        });
    }

    let summary = summarize(&views);
    Aggregate {
        summary,
        chains: views.into_iter().map(|build| build.view).collect(),
        unmapped_forwards,
    }
}

/// 某一个时间桶的整链丢包（%）：各段取**同一桶**的 attempts/failures 连乘。
///
/// 某段该桶没有探测就跳过；所有段都没有探测时返回 null（不补 0）。
/// 桶级不设 partial：缺失只由 `null` 表达。
fn chain_loss_for_bucket(
    probes: &HashMap<(usize, usize, i64), ProbeCounts>,
    chain_index: usize,
    segment_count: usize,
    ts: i64,
) -> Option<f64> {
    let mut survival = 1.0_f64;
    let mut seen = false;
    for segment_index in 0..segment_count {
        let counts = probes
            .get(&(chain_index, segment_index, ts))
            .copied()
            .unwrap_or_default();
        if counts.attempts <= 0 {
            continue;
        }
        seen = true;
        let loss = (counts.failures.max(0) as f64 / counts.attempts as f64).clamp(0.0, 1.0);
        survival *= 1.0 - loss;
    }
    seen.then(|| round4((1.0 - survival) * 100.0))
}

/// 某一段在某个时间桶的丢包（%）：`failures / attempts × 100`。
///
/// 该桶没有探测（`attempts = 0`）时返回 null，不补 0。只做一次哈希查找，
/// 逐段序列因此仍然是纯内存遍历。
fn segment_loss_for_bucket(
    probes: &HashMap<(usize, usize, i64), ProbeCounts>,
    chain_index: usize,
    segment_index: usize,
    ts: i64,
) -> Option<f64> {
    let counts = probes
        .get(&(chain_index, segment_index, ts))
        .copied()
        .unwrap_or_default();
    (counts.attempts > 0).then(|| {
        round4((counts.failures.max(0) as f64 / counts.attempts as f64).clamp(0.0, 1.0) * 100.0)
    })
}

/// (链, 段) → (源成员, 目标成员) → 当前窗口样本数。
type PairCounts = HashMap<(usize, usize), HashMap<(String, String), i64>>;

struct ChainViewBuild {
    view: ChainHealth,
    current_overall: Option<f64>,
    baseline_overall: Option<f64>,
}

/// 一条链的拓扑在内存里的展开形态。
pub struct Layout {
    chain_id: String,
    chain_name: String,
    hops: i64,
    entry: Option<Endpoint>,
    exit: Option<Endpoint>,
    /// 拓扑节点（每个组一个 + 末尾的链目标节点）。
    nodes: Vec<NodeView>,
    estimated: bool,
    /// 最后一跳可测性（引擎 / 协议决定，整条链共享）。
    last_hop: LastHop,
    /// 成员为空的组造成的断点（不含最后一跳；最后一跳是否缺失取决于样本）。
    missing_hops: Vec<i64>,
    /// 最后一跳的 `seq` = 最后一组的 seq + 1；没有任何组时 None。
    final_hop_seq: Option<i64>,
    /// 每组在链里的 `seq`，与 `groups` 下标一一对应。
    group_seq: Vec<i64>,
    /// 每组排好序的成员（priority, server_id）。
    groups: Vec<Vec<Member>>,
    /// 每组在链里的选路策略；入口组为 None（没有上一跳），其余组是
    /// `GroupStrategy::from_db(...).as_str()`（非法值已回落 `round_robin`）。
    strategies: Vec<Option<&'static str>>,
    /// 每组排好序后的成员数，`active_members` 算 forward id 用。
    group_member_counts: Vec<usize>,
    /// 段编号：中间段取目标组 seq，最后一跳取最后一组 seq + 1。
    segment_seq: Vec<i64>,
    /// 无样本时的 from/to 兜底。
    segment_from: Vec<String>,
    segment_to: Vec<String>,
}

#[derive(Debug, Clone)]
struct Member {
    id: String,
    name: String,
    /// `servers.status` 原样透传，只用于 `nodes[].status`。
    status: String,
    address: String,
    internal_address: Option<String>,
    listen_port: i64,
}

impl Layout {
    fn from_chain(chain: &ChainWithGroups) -> Self {
        let mut groups: Vec<&ChainGroupWithMembers> = chain.groups.iter().collect();
        groups.sort_by_key(|group| group.group.seq);
        let group_seq: Vec<i64> = groups.iter().map(|group| group.group.seq).collect();
        let members: Vec<Vec<Member>> = groups
            .iter()
            .map(|group| {
                let mut members: Vec<&ChainGroupMember> = group.members.iter().collect();
                // 仓储已经按 (priority, rowid) 排好；这里用 (priority, server_id)
                // 再兜一次，让测试构造的乱序输入也有确定结果。
                members.sort_by_key(|member| (member.priority, member.server_id.clone()));
                members
                    .into_iter()
                    .map(|member| Member {
                        id: member.server_id.clone(),
                        name: member.server_name.clone(),
                        status: member.server_status.clone(),
                        address: member.server_address.clone(),
                        internal_address: member.server_internal_address.clone(),
                        listen_port: member.listen_port,
                    })
                    .collect()
            })
            .collect();
        let entry = groups
            .first()
            .zip(members.first())
            .and_then(|(group, members)| {
                members.first().map(|member| {
                    // 入口端口优先用组级 public_port（只用于展示）；为空时
                    // 回退到入口成员的 listen_port。
                    endpoint(
                        member,
                        group.group.public_port.unwrap_or(member.listen_port),
                    )
                })
            });
        let exit = members
            .last()
            .and_then(|members| members.first())
            .map(|member| endpoint(member, member.listen_port));
        let strategies: Vec<Option<&'static str>> = groups
            .iter()
            .enumerate()
            .map(|(index, group)| {
                // 入口组没有上一跳，永远不执行选路；链目标在 nodes 里另补。
                (index > 0).then(|| GroupStrategy::from_db(&group.group.strategy).as_str())
            })
            .collect();
        let group_member_counts: Vec<usize> = members.iter().map(Vec::len).collect();
        let estimated = members.iter().any(|group| group.len() > 1);
        let hops = groups.len() as i64;
        let final_hop_seq = group_seq.last().map(|last| last + 1);
        // 可测性只看链级字段，与 Agent 的 `target_health_loop` 条件一致。
        let last_hop = LastHop::of(&chain.chain.engine, &chain.chain.protocol);

        // 空组造成的断点：相邻两组任一侧没有成员时，目标组的 seq 无法测量。
        // 最后一跳由 aggregate 按「窗口内有没有样本」单独决定，不能无条件写死。
        let mut missing_hops = Vec::new();
        for index in 0..groups.len().saturating_sub(1) {
            if members[index].is_empty() || members[index + 1].is_empty() {
                missing_hops.push(group_seq[index + 1]);
            }
        }
        missing_hops.sort_unstable();
        missing_hops.dedup();

        // 段数 = 组数：前 hops-1 段是组 → 下一组，最后一段是最后一组 → 链目标。
        let segment_count = groups.len();
        let mut segment_seq = Vec::with_capacity(segment_count);
        let mut segment_from = Vec::with_capacity(segment_count);
        let mut segment_to = Vec::with_capacity(segment_count);
        for index in 0..segment_count {
            let last = index + 1 >= groups.len();
            if last {
                // groups 非空时 final_hop_seq 一定有值。
                segment_seq.push(final_hop_seq.unwrap_or(group_seq[index] + 1));
            } else {
                segment_seq.push(group_seq[index + 1]);
            }
            segment_from.push(members[index].first().map_or_else(
                || groups[index].group.name.clone().unwrap_or_default(),
                |member| member.name.clone(),
            ));
            segment_to.push(if last {
                CHAIN_TARGET_NAME.to_string()
            } else {
                members[index + 1].first().map_or_else(
                    || groups[index + 1].group.name.clone().unwrap_or_default(),
                    |member| member.name.clone(),
                )
            });
        }

        // 节点：每个组一个，成员全部展开。组级 status 取最差成员；name 优先
        // 用组名，组名为空回退代表成员名（与 entry/exit 同口径）。
        let mut nodes = Vec::with_capacity(groups.len() + 1);
        for (index, group_members) in members.iter().enumerate() {
            let role = if index == 0 { "source" } else { "hop" };
            let node_members: Vec<NodeMember> = group_members
                .iter()
                .map(|member| NodeMember {
                    server_id: member.id.clone(),
                    name: member.name.clone(),
                    status: member.status.clone(),
                })
                .collect();
            let name = groups[index]
                .group
                .name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .or_else(|| group_members.first().map(|member| member.name.clone()))
                .unwrap_or_else(|| format!("第 {} 跳", index + 1));
            nodes.push(NodeView {
                seq: group_seq[index],
                server_id: group_members.first().map(|member| member.id.clone()),
                name,
                role,
                status: group_status(&node_members),
                member_count: node_members.len(),
                members: node_members,
                strategy: strategies[index].map(str::to_string),
                active_server_id: None,
            });
        }
        if let Some(seq) = final_hop_seq {
            nodes.push(NodeView {
                seq,
                server_id: None,
                name: CHAIN_TARGET_NAME.to_string(),
                role: "target",
                status: None,
                member_count: 0,
                members: Vec::new(),
                strategy: None,
                active_server_id: None,
            });
        }

        Self {
            chain_id: chain.chain.id.clone(),
            chain_name: chain.chain.name.clone(),
            hops,
            entry,
            exit,
            nodes,
            estimated,
            last_hop,
            missing_hops,
            final_hop_seq,
            group_seq,
            groups: members,
            strategies,
            group_member_counts,
            segment_seq,
            segment_from,
            segment_to,
        }
    }

    /// 当前窗口样本最多的 (源, 目标) 成员对；没有当前样本时退回每组第一台。
    fn representative(
        &self,
        chain_index: usize,
        segment_index: usize,
        pair_counts: &PairCounts,
    ) -> (String, String) {
        let best = pair_counts
            .get(&(chain_index, segment_index))
            .and_then(|pairs| {
                pairs.iter().fold(
                    None::<(&String, &String, i64)>,
                    |best, (pair, count)| match best {
                        Some((best_from, best_to, best_count))
                            if *count < best_count
                                || (*count == best_count
                                    && pair >= &(best_from.clone(), best_to.clone())) =>
                        {
                            Some((best_from, best_to, best_count))
                        }
                        _ => Some((&pair.0, &pair.1, *count)),
                    },
                )
            });
        match best {
            Some((from, to, _)) => (
                self.name_of(from)
                    .map_or_else(|| self.segment_from[segment_index].clone(), str::to_string),
                self.name_of(to)
                    .map_or_else(|| self.segment_to[segment_index].clone(), str::to_string),
            ),
            None => (
                self.segment_from[segment_index].clone(),
                self.segment_to[segment_index].clone(),
            ),
        }
    }

    /// 成员 server_id → 展示名；只在本链内查，跨链同名/同 id 不串。
    fn name_of(&self, server_id: &str) -> Option<&str> {
        self.groups
            .iter()
            .flatten()
            .find(|member| member.id == server_id)
            .map(|member| member.name.as_str())
    }
}

/// 计算从入口代表成员出发、沿 Agent 上报的「当前选中」走出的通路。
///
/// 返回数组与 `layout.nodes` 一一对应（每个组一个 + 末尾链目标）：
/// * `source`（入口组）与 `target` 恒为 None——入口没有上一跳，目标不是成员；
/// * 第 i 跳看**第 i-1 跳当前通路成员**的 forward 探测记录
///   （`forward_id = chains::forward_id(chain_id, 上一跳 seq, 成员 id, 成员数)`），
///   其中恰好一个 `active = Some(true)` 的目标就是这一跳的当前通路成员；
/// * 上一跳成员不是 `online`、没有心跳记录、没有唯一 `active`、或 `active`
///   的 `server_id` 不在本组时，从该跳起全部 None（不猜、不跳过去继续走）。
///
/// 单成员组走兼容字段时 Agent 拿不到 server_id（空串），此时按「唯一成员
/// 可确定」归到该成员，与样本归属的既有口径一致。
pub fn active_members(
    layout: &Layout,
    latest: &HashMap<String, Vec<TargetProbeRow>>,
) -> Vec<Option<String>> {
    let mut active = vec![None; layout.nodes.len()];
    let Some(mut previous) = layout.groups.first().and_then(|members| members.first()) else {
        // 入口组没有成员：没有起点可走。
        return active;
    };
    let mut previous_group = 0_usize;
    for (group_index, members) in layout.groups.iter().enumerate().skip(1) {
        // active 只对「有单一选中项」的策略有意义；轮询 / 哈希 / 加权 /
        // 最少连接即使收到脏的 active=true 也不能当成当前通路。
        if !matches!(
            layout.strategies[group_index],
            Some("failover" | "lowest_latency")
        ) {
            break;
        }
        // 上一跳通路成员必须在线；离线/异常就从这一跳起断开。
        if previous.status != "online" {
            break;
        }
        let forward_id = crate::chains::forward_id(
            &layout.chain_id,
            layout.group_seq[previous_group],
            &previous.id,
            layout.group_member_counts[previous_group],
        );
        let Some(probes) = latest.get(&forward_id) else {
            break;
        };
        // 同规则至多一个 Some(true)；0 个或多个都说明没有单一选中项。
        let selected: Vec<&TargetProbeRow> = probes
            .iter()
            .filter(|probe| probe.active == Some(true))
            .collect();
        let [selected] = selected.as_slice() else {
            break;
        };
        let next = if !selected.server_id.is_empty() {
            members
                .iter()
                .find(|member| member.id == selected.server_id)
        } else if members.len() == 1 {
            members.first()
        } else {
            None
        };
        let Some(next) = next else {
            break;
        };
        active[group_index] = Some(next.id.clone());
        previous = next;
        previous_group = group_index;
    }
    active
}

/// 把一个成员 + 端口组装成起点/终点。
///
/// 地址优先用 `servers.address`；为空（历史脏数据 / 只填了内网地址）时回退
/// `servers.internal_address` 并标记 `address_source = "internal"`。端口非法
/// （<= 0 或缺失）时 `address` 为 null，但 `ip` 保留——前端仍能展示主机。
fn endpoint(member: &Member, port: i64) -> Endpoint {
    let external = member.address.trim();
    let internal = member
        .internal_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (host, address_source) = if external.is_empty() {
        (internal, Some("internal"))
    } else {
        (Some(external), None)
    };
    let ip = host.map(normalize_host);
    let port = (port > 0).then_some(port);
    let address = ip
        .as_deref()
        .zip(port)
        .map(|(host, port)| format_endpoint(host, port));
    Endpoint {
        server_id: member.id.clone(),
        server_name: member.name.clone(),
        address,
        ip,
        port,
        // 只有真正回退成功时才是 `"internal"`；地址完全缺失时不标注来源。
        address_source: address_source.filter(|_| host.is_some()),
    }
}

/// 去掉 IPv6 方括号，保证 `ip` 是可读的裸地址。
fn normalize_host(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(trimmed)
        .to_string()
}

/// `ip:port`；IPv6（两个及以上冒号）补方括号。
fn format_endpoint(host: &str, port: i64) -> String {
    if host.matches(':').count() >= 2 {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct BucketStats {
    p10: f64,
    p50: f64,
    p90: f64,
    samples: i64,
}

#[derive(Default)]
struct StatsAccumulator {
    p10: f64,
    p50: f64,
    p90: f64,
    samples: i64,
}

impl StatsAccumulator {
    fn add(&mut self, stats: &BucketStats) {
        self.p10 += stats.p10;
        self.p50 += stats.p50;
        self.p90 += stats.p90;
        self.samples += stats.samples;
    }

    fn into_point(self, ts: i64, loss_pct: Option<f64>) -> SeriesPoint {
        SeriesPoint {
            ts,
            p50: round1(self.p50),
            p10: round1(self.p10),
            p90: round1(self.p90),
            samples: self.samples,
            loss_pct,
        }
    }
}

#[derive(Default)]
struct WindowStats {
    /// 每段在窗口内各桶 p50 的列表（用于取中位数）。
    segment_p50: Vec<Option<f64>>,
    /// 窗口内「各段都齐全」的桶的整体 p50。
    overall: Vec<f64>,
}

/// 一个窗口内逐段 p50 与「可测段齐全」的整链桶值。
///
/// `segment_count` 是段总数（决定 `segment_p50` 的长度，不可测的最后一跳也
/// 保留自己的段值）；`measured_segments` 是参与整链判定的段数：不可测的
/// 最后一跳不参与，所以它的空桶不会让整链变 null。
fn window_segment_p50s(
    stats: &HashMap<(usize, usize, i64), BucketStats>,
    chain_index: usize,
    segment_count: usize,
    measured_segments: usize,
    start: i64,
    end: i64,
    bucket: i64,
) -> WindowStats {
    let mut result = WindowStats {
        segment_p50: vec![None; segment_count],
        overall: Vec::new(),
    };
    if segment_count == 0 || end <= start || bucket <= 0 {
        return result;
    }
    let mut per_segment: Vec<Vec<f64>> = vec![Vec::new(); segment_count];
    let mut overall = Vec::new();
    let mut ts = start;
    while ts < end {
        let mut total = 0.0;
        let mut complete = measured_segments > 0;
        for (segment_index, values) in per_segment.iter_mut().enumerate() {
            match stats.get(&(chain_index, segment_index, ts)) {
                Some(bucket_stats) => {
                    values.push(bucket_stats.p50);
                    if segment_index < measured_segments {
                        total += bucket_stats.p50;
                    }
                }
                // 逐段 p50 互相独立：某段该桶缺样本只让「整体」桶不完整，
                // 不能顺手跳过后面段，否则最后一跳会被前面的空段连坐。
                None => {
                    if segment_index < measured_segments {
                        complete = false;
                    }
                }
            }
        }
        if complete {
            overall.push(total);
        }
        ts += bucket;
    }
    result.segment_p50 = per_segment
        .into_iter()
        .map(|values| median(&values))
        .collect();
    result.overall = overall;
    result
}

fn diagnose(
    segments: &[SegmentView],
    current_overall: Option<f64>,
    baseline_overall: Option<f64>,
) -> Diagnosis {
    let (Some(current), Some(baseline)) = (current_overall, baseline_overall) else {
        return Diagnosis::unknown();
    };
    if segments.is_empty() || current - baseline <= 0.0 {
        return Diagnosis::unknown();
    }
    let top = segments
        .iter()
        .filter(|segment| segment.p50.is_some())
        .max_by(|a, b| {
            a.contribution_pct
                .cmp(&b.contribution_pct)
                .then_with(|| b.seq.cmp(&a.seq))
        });
    match top {
        Some(segment) if segment.contribution_pct as f64 >= SINGLE_HOP_CONTRIBUTION_PCT => {
            Diagnosis {
                kind: "single_hop",
                seq: Some(segment.seq),
            }
        }
        _ => Diagnosis {
            kind: "overall",
            seq: None,
        },
    }
}

fn summarize(views: &[ChainViewBuild]) -> Summary {
    // 顶部数字聚焦**退化最严重的链**，而不是所有链的中位数：一条链 +25ms
    // 的另一条 +0ms 时，中位数永远是 0，headline 会看不到事故。这里取
    // 「正向 delta 最大」的链；都没有基线时退回「当前整体最大」；再按 id
    // 兜底，保证同一份数据每次选同一条。`worst_hop` 仍是所有链里最慢的段。
    let focus = views
        .iter()
        // 不可测链的样本只可能是历史残留（Agent 不会为它在当前配置下探测），
        // 不能拿来做 headline，否则 summary 会和 `status = unknown` 打架。
        .filter(|build| build.view.last_hop.measurable)
        .filter(|build| build.current_overall.is_some())
        .max_by(|a, b| {
            let a_delta = a
                .baseline_overall
                .map(|baseline| a.current_overall.unwrap_or(baseline) - baseline);
            let b_delta = b
                .baseline_overall
                .map(|baseline| b.current_overall.unwrap_or(baseline) - baseline);
            a_delta
                .unwrap_or(f64::NEG_INFINITY)
                .total_cmp(&b_delta.unwrap_or(f64::NEG_INFINITY))
                .then_with(|| {
                    a.current_overall
                        .unwrap_or_default()
                        .total_cmp(&b.current_overall.unwrap_or_default())
                })
                .then_with(|| b.view.id.cmp(&a.view.id))
        });

    let delta_ms = focus.and_then(
        |build| match (build.current_overall, build.baseline_overall) {
            (Some(current), Some(baseline)) => Some((current - baseline).round() as i64),
            _ => None,
        },
    );
    // 与逐链 `status.cause = "slow"` 同口径：不可测链永远不会得到 `slow`
    // （§1.3 的优先级里 `unmeasurable` 在 `slow` 之前），所以这里也不能把它
    // 计进 `slow_chains`，否则会出现「summary 说 1 条慢链、链上却是 unknown」。
    let slow_chains = views
        .iter()
        .filter(|build| build.view.last_hop.measurable)
        .filter(|build| is_slow(build.current_overall, build.baseline_overall))
        .count() as i64;

    let mut worst: Option<HopRef> = None;
    for build in views {
        for segment in &build.view.segments {
            let Some(p50) = segment.p50 else {
                continue;
            };
            let candidate = HopRef {
                chain_id: build.view.id.clone(),
                chain_name: build.view.name.clone(),
                seq: segment.seq,
                p50_ms: p50.round() as i64,
            };
            let replace = worst.as_ref().is_none_or(|current| {
                p50 > current.p50_ms as f64
                    || (p50 == current.p50_ms as f64
                        && (&candidate.chain_id, candidate.seq) < (&current.chain_id, current.seq))
            });
            if replace {
                worst = Some(candidate);
            }
        }
    }

    let mut worst_loss: Option<LossRef> = None;
    for build in views {
        let Some(loss_pct) = build.view.loss_pct else {
            continue;
        };
        let candidate = LossRef {
            chain_id: build.view.id.clone(),
            chain_name: build.view.name.clone(),
            loss_pct,
        };
        let replace = worst_loss.as_ref().is_none_or(|current| {
            loss_pct > current.loss_pct
                || (loss_pct == current.loss_pct && candidate.chain_id < current.chain_id)
        });
        if replace {
            worst_loss = Some(candidate);
        }
    }
    let loss_pct = worst_loss.as_ref().map(|worst| worst.loss_pct);

    Summary {
        hop_p50_ms: focus
            .and_then(|build| build.current_overall)
            .map(|value| value.round() as i64),
        delta_ms,
        slow_chains,
        total_chains: views.len() as i64,
        worst_hop: worst,
        loss_pct,
        worst_loss,
    }
}

fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    Some(percentile(&sorted, 0.5))
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let rank = p.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    if lower == upper {
        sorted[lower]
    } else {
        sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower as f64)
    }
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// 丢包百分比保留 4 位小数：2/240 = 0.8333%，两段各 1% = 1.99%。
fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Chain, ChainGroup, ChainGroupWithMembers};

    const BUCKET: i64 = 900;
    const NOW: i64 = 1_800_000_000;

    fn member(
        chain_id: &str,
        group_id: &str,
        seq: i64,
        server_id: &str,
        server_name: &str,
        listen_port: i64,
        priority: i64,
    ) -> ChainGroupMember {
        ChainGroupMember {
            group_id: group_id.into(),
            chain_id: chain_id.into(),
            seq,
            strategy: "round_robin".into(),
            server_id: server_id.into(),
            server_name: server_name.into(),
            server_status: "online".into(),
            server_address: format!("10.0.0.{listen_port}"),
            server_internal_address: None,
            listen_port,
            priority,
            weight: 1,
            realm_transport: None,
            nftables_available: None,
            tunnel_available: None,
            server_protocol_version: None,
            last_seen_at: None,
        }
    }

    /// 构造一条链：`groups` 是 `(seq, [(server_id, name)])`。
    fn chain(id: &str, groups: Vec<(i64, Vec<(&str, &str)>)>) -> ChainWithGroups {
        let chain = chain_base(id);
        let groups = groups
            .into_iter()
            .map(|(seq, members)| {
                let group_id = format!("{id}-g{seq}");
                let group = ChainGroup {
                    id: group_id.clone(),
                    chain_id: id.into(),
                    seq,
                    name: None,
                    strategy: "round_robin".into(),
                    cert_id: None,
                    public_port: None,
                    use_internal_address: false,
                };
                let members = members
                    .into_iter()
                    .enumerate()
                    .map(|(index, (server_id, name))| {
                        member(
                            id,
                            &group_id,
                            seq,
                            server_id,
                            name,
                            10_000 + index as i64,
                            index as i64,
                        )
                    })
                    .collect();
                ChainGroupWithMembers { group, members }
            })
            .collect();
        ChainWithGroups { chain, groups }
    }

    fn chain_base(id: &str) -> Chain {
        Chain {
            id: id.into(),
            name: format!("chain-{id}"),
            target_host: "target".into(),
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
            created_at: 1,
            updated_at: 1,
        }
    }

    /// 起点/终点测试用的成员：地址、内网地址、端口、优先级都可控。
    fn full_member(
        server_id: &str,
        server_name: &str,
        address: &str,
        internal_address: Option<&str>,
        listen_port: i64,
        priority: i64,
    ) -> ChainGroupMember {
        ChainGroupMember {
            group_id: String::new(),
            chain_id: String::new(),
            seq: 0,
            strategy: "round_robin".into(),
            server_id: server_id.into(),
            server_name: server_name.into(),
            server_status: "online".into(),
            server_address: address.into(),
            server_internal_address: internal_address.map(str::to_string),
            listen_port,
            priority,
            weight: 1,
            realm_transport: None,
            nftables_available: None,
            tunnel_available: None,
            server_protocol_version: None,
            last_seen_at: None,
        }
    }

    /// 显式指定每组 `(seq, public_port, 成员)`；成员顺序故意由调用方给乱，
    /// 由 `Layout` 再按 `(priority, server_id)` 排序。
    fn topology(
        id: &str,
        groups: Vec<(i64, Option<i64>, Vec<ChainGroupMember>)>,
    ) -> ChainWithGroups {
        let chain = chain_base(id);
        let groups = groups
            .into_iter()
            .map(|(seq, public_port, mut members)| {
                let group_id = format!("{id}-g{seq}");
                for member in &mut members {
                    member.group_id = group_id.clone();
                    member.chain_id = id.into();
                    member.seq = seq;
                }
                let group = ChainGroup {
                    id: group_id,
                    chain_id: id.into(),
                    seq,
                    name: None,
                    strategy: "round_robin".into(),
                    cert_id: None,
                    public_port,
                    use_internal_address: false,
                };
                ChainGroupWithMembers { group, members }
            })
            .collect();
        ChainWithGroups { chain, groups }
    }

    fn sample(
        ts: i64,
        server_id: &str,
        forward_id: String,
        target_server_id: &str,
        latency_ms: i64,
    ) -> LatencySample {
        LatencySample {
            ts,
            server_id: server_id.into(),
            forward_id,
            target_server_id: target_server_id.into(),
            latency_ms,
        }
    }

    fn end_at(now: i64, bucket: i64) -> i64 {
        now - now.rem_euclid(bucket) + bucket
    }

    fn forward(chain_id: &str, seq: i64, server_id: &str, member_count: usize) -> String {
        crate::chains::forward_id(chain_id, seq, server_id, member_count)
    }

    /// 没有探测数据：丢包逐段为 null、整链 null，且不标 `loss_partial`。
    fn no_probes() -> Vec<ProbeBucketRow> {
        Vec::new()
    }

    /// 没有最近探测记录：`active_server_id` 全部为 null。
    fn no_latest() -> HashMap<String, Vec<TargetProbeRow>> {
        HashMap::new()
    }

    type ProbeEntries<'a> = [(String, &'a [(&'a str, Option<bool>)])];

    /// 一批 forward 的逐目标探测：`(forward_id, [(server_id, active)])`。
    fn latest_probes(entries: &ProbeEntries<'_>) -> HashMap<String, Vec<TargetProbeRow>> {
        entries
            .iter()
            .map(|(forward_id, probes)| {
                (
                    forward_id.clone(),
                    probes
                        .iter()
                        .map(|(server_id, active)| TargetProbeRow {
                            server_id: (*server_id).to_string(),
                            ok: true,
                            latency_ms: Some(10),
                            active: *active,
                        })
                        .collect(),
                )
            })
            .collect()
    }

    /// 当前窗口内的一个 5 分钟探测桶：`(forward_id, attempts, failures)`。
    fn probes(entries: &[(String, i64, i64)]) -> Vec<ProbeBucketRow> {
        probes_in_bucket(end_at(NOW, BUCKET) - 60, entries)
    }

    /// 指定时间戳的探测桶；同一批 entry 共用 `ts`。
    fn probes_in_bucket(ts: i64, entries: &[(String, i64, i64)]) -> Vec<ProbeBucketRow> {
        entries
            .iter()
            .map(|(forward_id, attempts, failures)| ProbeBucketRow {
                forward_id: forward_id.clone(),
                ts,
                attempts: *attempts,
                failures: *failures,
            })
            .collect()
    }

    #[test]
    fn entry_and_exit_use_the_first_and_last_group_members() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    Some(443),
                    vec![full_member("a", "香港-01", "203.0.113.11", None, 21_001, 0)],
                ),
                (
                    1,
                    None,
                    vec![full_member(
                        "b",
                        "大阪-01",
                        "198.51.100.21",
                        None,
                        21_004,
                        0,
                    )],
                ),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.hops, 2);

        let entry = view.entry.as_ref().expect("起点不能为空");
        assert_eq!(entry.server_id, "a");
        assert_eq!(entry.server_name, "香港-01");
        assert_eq!(
            entry.address.as_deref(),
            Some("203.0.113.11:443"),
            "入口端口优先用 chain_groups.public_port"
        );
        assert_eq!(entry.ip.as_deref(), Some("203.0.113.11"));
        assert_eq!(entry.port, Some(443));
        assert_eq!(entry.address_source, None, "正常地址不标注来源");

        let exit = view.exit.as_ref().expect("终点不能为空");
        assert_eq!(exit.server_id, "b");
        assert_eq!(exit.server_name, "大阪-01");
        assert_eq!(
            exit.address.as_deref(),
            Some("198.51.100.21:21004"),
            "终点端口用该成员的 listen_port"
        );
        assert_eq!(exit.ip.as_deref(), Some("198.51.100.21"));
        assert_eq!(exit.port, Some(21_004));
        assert_eq!(exit.address_source, None);
    }

    #[test]
    fn entry_and_exit_pick_the_lowest_priority_then_smallest_server_id() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    Some(40001),
                    vec![
                        full_member("z", "Z", "10.0.0.1", None, 21_001, 0),
                        full_member("a", "A", "10.0.0.2", None, 21_002, 0),
                        full_member("m", "M", "10.0.0.3", None, 21_003, 5),
                    ],
                ),
                (
                    1,
                    None,
                    vec![
                        full_member("y", "Y", "10.0.0.4", None, 21_004, 9),
                        full_member("x", "X", "10.0.0.5", None, 21_005, 2),
                    ],
                ),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        let entry = view.entry.as_ref().unwrap();
        assert_eq!(
            entry.server_id, "a",
            "同优先级按 server_id 稳定排序，不受插入顺序影响"
        );
        assert_eq!(entry.address.as_deref(), Some("10.0.0.2:40001"));
        let exit = view.exit.as_ref().unwrap();
        assert_eq!(exit.server_id, "x");
        assert_eq!(exit.address.as_deref(), Some("10.0.0.5:21005"));
    }

    #[test]
    fn entry_port_falls_back_to_listen_port_when_public_port_is_empty() {
        let chain = topology(
            "c1",
            vec![(
                0,
                None,
                vec![full_member("a", "A", "203.0.113.11", None, 21_001, 0)],
            )],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let entry = aggregate.chains[0].entry.as_ref().unwrap();
        assert_eq!(
            entry.address.as_deref(),
            Some("203.0.113.11:21001"),
            "public_port 为空时回退该成员的 listen_port"
        );
        assert_eq!(entry.port, Some(21_001));
        // 单组链的终点就是同一个成员，端口仍用 listen_port。
        assert_eq!(
            aggregate.chains[0]
                .exit
                .as_ref()
                .unwrap()
                .address
                .as_deref(),
            Some("203.0.113.11:21001")
        );
    }

    #[test]
    fn a_missing_public_address_falls_back_to_internal_and_is_marked() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    Some(8443),
                    vec![full_member(
                        "a",
                        "香港-01",
                        "   ",
                        Some("10.0.0.11"),
                        21_001,
                        0,
                    )],
                ),
                (
                    1,
                    None,
                    vec![full_member(
                        "b",
                        "大阪-01",
                        "203.0.113.21",
                        Some("10.0.0.21"),
                        21_004,
                        0,
                    )],
                ),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let entry = aggregate.chains[0].entry.as_ref().unwrap();
        assert_eq!(entry.address.as_deref(), Some("10.0.0.11:8443"));
        assert_eq!(entry.ip.as_deref(), Some("10.0.0.11"));
        assert_eq!(
            entry.address_source,
            Some("internal"),
            "回退到 internal_address 时必须标注"
        );
        // 公网地址存在时不回退，即使 internal_address 也有值。
        let exit = aggregate.chains[0].exit.as_ref().unwrap();
        assert_eq!(exit.address.as_deref(), Some("203.0.113.21:21004"));
        assert_eq!(exit.address_source, None);
    }

    #[test]
    fn an_endpoint_without_any_address_keeps_null_hosts() {
        let chain = topology(
            "c1",
            vec![(
                0,
                Some(443),
                vec![full_member("a", "A", "", None, 21_001, 0)],
            )],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let entry = aggregate.chains[0].entry.as_ref().unwrap();
        assert_eq!(entry.server_id, "a");
        assert_eq!(entry.address, None);
        assert_eq!(entry.ip, None);
        assert_eq!(entry.port, Some(443));
        assert_eq!(entry.address_source, None, "没有回退成功就不标来源");
    }

    #[test]
    fn ipv6_endpoints_are_bracketed_and_the_ip_stays_bare() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    Some(443),
                    vec![full_member("a", "A", "2001:db8::11", None, 21_001, 0)],
                ),
                (
                    1,
                    None,
                    vec![full_member("b", "B", "[2001:db8::21]", None, 21_004, 0)],
                ),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let entry = aggregate.chains[0].entry.as_ref().unwrap();
        assert_eq!(entry.ip.as_deref(), Some("2001:db8::11"));
        assert_eq!(entry.address.as_deref(), Some("[2001:db8::11]:443"));
        let exit = aggregate.chains[0].exit.as_ref().unwrap();
        assert_eq!(
            exit.ip.as_deref(),
            Some("2001:db8::21"),
            "输入已带方括号时 ip 不重复包裹"
        );
        assert_eq!(exit.address.as_deref(), Some("[2001:db8::21]:21004"));
    }

    #[test]
    fn a_missing_port_keeps_the_ip_but_nulls_the_address() {
        let chain = topology(
            "c1",
            vec![(
                0,
                None,
                vec![full_member("a", "A", "203.0.113.11", None, 0, 0)],
            )],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let entry = aggregate.chains[0].entry.as_ref().unwrap();
        assert_eq!(entry.ip.as_deref(), Some("203.0.113.11"));
        assert_eq!(entry.port, None);
        assert_eq!(entry.address, None, "缺端口只丢 address，不丢 ip");
    }

    #[test]
    fn groups_without_members_have_no_entry_or_exit() {
        let chain = chain("c1", vec![(0, vec![]), (1, vec![])]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert!(view.entry.is_none());
        assert!(view.exit.is_none());
    }

    #[test]
    fn every_segment_series_has_the_same_length_as_the_chain_series() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
                (3, vec![("d", "D")]),
            ],
        );
        let end = end_at(NOW, BUCKET);
        let samples = vec![
            sample(end - 2 * BUCKET + 60, "a", forward("c1", 0, "a", 1), "", 10),
            sample(end - BUCKET + 60, "a", forward("c1", 0, "a", 1), "", 20),
            sample(end - BUCKET + 60, "b", forward("c1", 1, "b", 1), "", 30),
        ];
        let probes = probes_in_bucket(
            end - BUCKET + 60,
            &[
                (forward("c1", 0, "a", 1), 100, 1),
                (forward("c1", 1, "b", 1), 200, 10),
            ],
        );

        let aggregate = aggregate(&[chain], &samples, &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.series.len(), 4);
        for segment in &view.segments {
            assert_eq!(
                segment.series.len(),
                view.series.len(),
                "段 {} 的序列必须与链级同长",
                segment.seq
            );
        }
        // 桶 3（最新）：第 1 段 20ms / 1%，第 2 段 30ms / 5%。
        let first = view.segments[0].series[3].as_ref().unwrap();
        assert_eq!(first.ts, end - BUCKET);
        assert_eq!(first.p50, 20.0);
        assert_eq!(first.loss_pct, Some(1.0));
        let second = view.segments[1].series[3].as_ref().unwrap();
        assert_eq!(second.p50, 30.0);
        assert_eq!(second.loss_pct, Some(5.0));
        // 桶 2 只有第 1 段时延、没有探测：loss 是 null，不是 0。
        let older = view.segments[0].series[2].as_ref().unwrap();
        assert_eq!(older.p50, 10.0);
        assert_eq!(older.loss_pct, None);
        // 第 3 段完全没有样本：整段序列全是 null，不能补 {p50: 0}。
        assert!(view.segments[2].series.iter().all(Option::is_none));
        assert!(
            view.segments[0].series[0].is_none(),
            "没有样本的桶也是 null"
        );
        assert!(view.segments[1].series[2].is_none());
    }

    #[test]
    fn a_segment_bucket_with_zero_attempts_has_null_loss() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let end = end_at(NOW, BUCKET);
        let samples = vec![sample(
            end - BUCKET + 60,
            "a",
            forward("c1", 0, "a", 1),
            "",
            20,
        )];
        // 计数行存在但 attempts = 0：必须保持 null，不能写成 0%。
        let probes = probes_in_bucket(end - BUCKET + 60, &[(forward("c1", 0, "a", 1), 0, 0)]);
        let aggregate = aggregate(&[chain], &samples, &probes, &no_latest(), NOW, 1, BUCKET);
        let point = aggregate.chains[0].segments[0].series[3].as_ref().unwrap();
        assert_eq!(point.p50, 20.0);
        assert_eq!(point.loss_pct, None);
    }

    #[test]
    fn a_segment_bucket_with_probes_but_no_latency_is_null() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let end = end_at(NOW, BUCKET);
        // 只有探测、没有时延样本：整桶为 null，不能只返回丢包。
        let probes = probes_in_bucket(end - BUCKET + 60, &[(forward("c1", 0, "a", 1), 100, 50)]);
        let aggregate = aggregate(&[chain], &[], &probes, &no_latest(), NOW, 1, BUCKET);
        assert!(aggregate.chains[0].segments[0].series[3].is_none());
    }

    #[test]
    fn maps_adjacent_groups_and_the_final_hop_in_the_same_bucket() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "香港-01")]),
                (1, vec![("b", "东京-01")]),
                (2, vec![("c", "大阪-01")]),
            ],
        );
        let end = end_at(NOW, BUCKET);
        let ts = end - 60;
        let samples = vec![
            // 单成员下一跳走兼容字段：target_server_id 为空，按唯一成员补回。
            sample(ts, "a", forward("c1", 0, "a", 1), "", 14),
            sample(ts, "b", forward("c1", 1, "b", 1), "", 56),
            // 最后一跳用空目标上报（Agent 探测的是链目标，没有下一台服务器）。
            sample(ts, "c", forward("c1", 2, "c", 1), "", 5),
        ];

        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        assert_eq!(
            aggregate.unmapped_forwards, 0,
            "最后一跳的空目标是预期格式，不是 unmapped"
        );
        let view = &aggregate.chains[0];
        assert_eq!(view.hops, 3);
        assert!(
            view.last_hop.measurable,
            "native + tcp 的最后一跳必须仍可测（回归）"
        );
        assert_eq!(view.last_hop.reason, None);
        assert!(
            view.missing_hops.is_empty(),
            "有最后一跳样本时不能声明缺失：{:?}",
            view.missing_hops
        );
        assert_eq!(
            view.segments.iter().map(|s| s.seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(view.segments[0].from, "香港-01");
        assert_eq!(view.segments[0].to, "东京-01");
        assert_eq!(view.segments[0].p50, Some(14.0));
        assert_eq!(view.segments[1].p50, Some(56.0));
        assert_eq!(view.segments[2].from, "大阪-01");
        assert_eq!(view.segments[2].to, CHAIN_TARGET_NAME);
        assert_eq!(view.segments[2].p50, Some(5.0), "最后一跳的 p50 要能读到");
        assert!(!view.estimated);

        let last = view.series.last().unwrap().as_ref().unwrap();
        assert_eq!(last.p50, 75.0, "整体 = 同一桶各段 p50 之和");
        assert_eq!(last.p10, 75.0);
        assert_eq!(last.p90, 75.0);
        assert_eq!(last.samples, 3);
        assert!(view.series[0].is_none(), "没有样本的桶必须是 null");
        assert_eq!(view.diagnosis.kind, "unknown", "没有基线时不能编诊断");
        assert_eq!(aggregate.summary.total_chains, 1);
        assert_eq!(aggregate.summary.hop_p50_ms, Some(75));
        assert_eq!(aggregate.summary.delta_ms, None);
    }

    #[test]
    fn empty_target_on_a_multi_member_next_group_is_unmapped() {
        let chain = chain(
            "c1",
            vec![(0, vec![("a", "A")]), (1, vec![("b1", "B1"), ("b2", "B2")])],
        );
        let ts = end_at(NOW, BUCKET) - 60;
        let samples = vec![sample(ts, "a", forward("c1", 0, "a", 1), "", 10)];
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        assert_eq!(aggregate.unmapped_forwards, 1);
        assert!(aggregate.chains[0].series.last().unwrap().is_none());
        assert!(aggregate.chains[0].segments[0].p50.is_none());
    }

    #[test]
    fn a_stale_target_is_counted_as_unmapped_instead_of_being_dropped_silently() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let ts = end_at(NOW, BUCKET) - 60;
        // 目标不在下一组里（链改过成员后的历史样本）：必须进 warnings。
        let samples = vec![sample(ts, "a", forward("c1", 0, "a", 1), "ghost", 10)];
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        assert_eq!(aggregate.unmapped_forwards, 1);
        assert!(aggregate.chains[0].series.last().unwrap().is_none());
    }

    #[test]
    fn multi_member_group_is_estimated_and_uses_the_median_path() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b1", "B1"), ("b2", "B2")]),
                (2, vec![("c", "C")]),
            ],
        );
        let ts = end_at(NOW, BUCKET) - 60;
        let samples = vec![
            // 入口组单成员：forward id 走兼容格式，目标用真实 server_id。
            sample(ts, "a", forward("c1", 0, "a", 1), "b1", 10),
            sample(ts, "a", forward("c1", 0, "a", 1), "b2", 20),
            // 中转组多成员：forward id 带 server_id；下一组单成员 → 空目标。
            sample(ts, "b1", forward("c1", 1, "b1", 2), "", 30),
            sample(ts, "b2", forward("c1", 1, "b2", 2), "", 50),
            // 最后一跳：多成员中转组各自探测链目标，仍然只算最后一段。
            sample(ts, "c", forward("c1", 2, "c", 1), "", 60),
        ];
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert!(view.estimated, "多成员组必须标注估算");
        assert_eq!(view.segments[0].p50, Some(15.0), "10/20 的中位数");
        assert_eq!(view.segments[1].p50, Some(40.0), "30/50 的中位数");
        assert_eq!(view.segments[2].p50, Some(60.0), "最后一跳独立成段");
        assert_eq!(
            view.series.last().unwrap().as_ref().unwrap().p50,
            115.0,
            "多路径按段中位数求和（含最后一跳）"
        );
        assert_eq!(view.segments[1].from, "B1", "同票时按 server id 稳定选择");
        assert_eq!(view.segments[2].to, CHAIN_TARGET_NAME);
    }

    #[test]
    fn chains_without_samples_keep_null_series_and_unknown_diagnosis() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.hops, 2);
        assert_eq!(view.missing_hops, vec![2], "最后一跳没有样本时仍声明缺失");
        assert_eq!(view.segments.len(), 2);
        assert!(view.segments[0].p50.is_none());
        assert!(view.segments[1].p50.is_none());
        assert!(view.segments[0].delta_ms.is_none());
        assert_eq!(view.segments[0].contribution_pct, 0);
        assert!(view.series.iter().all(Option::is_none));
        assert_eq!(view.diagnosis.kind, "unknown");
        assert_eq!(aggregate.summary.hop_p50_ms, None);
        assert_eq!(aggregate.summary.delta_ms, None);
        assert_eq!(aggregate.summary.slow_chains, 0);
        assert_eq!(aggregate.summary.worst_hop, None);
    }

    #[test]
    fn a_single_group_chain_measures_only_the_final_hop() {
        let chain = chain("c1", vec![(0, vec![("a", "A")])]);
        // 没有样本：最后一跳是唯一一段，但必须保持 null + missing_hops。
        let empty = aggregate(
            std::slice::from_ref(&chain),
            &[],
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        let view = &empty.chains[0];
        assert_eq!(view.hops, 1);
        assert_eq!(view.missing_hops, vec![1]);
        assert_eq!(view.segments.len(), 1, "最后一组 → 链目标也是一段");
        assert_eq!(view.segments[0].seq, 1);
        assert_eq!(view.segments[0].to, CHAIN_TARGET_NAME);
        assert!(view.segments[0].p50.is_none());
        assert!(view.series.iter().all(Option::is_none));
        assert_eq!(view.diagnosis.kind, "unknown");

        // 有最后一跳样本：p50 可见、missing_hops 清空。
        let ts = end_at(NOW, BUCKET) - 60;
        let samples = vec![sample(ts, "a", forward("c1", 0, "a", 1), "", 12)];
        let with_samples = aggregate(
            std::slice::from_ref(&chain),
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        let view = &with_samples.chains[0];
        assert!(view.missing_hops.is_empty());
        assert_eq!(view.segments[0].p50, Some(12.0));
        assert_eq!(view.series.last().unwrap().as_ref().unwrap().p50, 12.0);
    }

    #[test]
    fn groups_without_members_are_reported_as_missing_instead_of_panicking() {
        let chain = chain("c1", vec![(0, vec![]), (1, vec![])]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.hops, 2);
        assert_eq!(view.missing_hops, vec![1, 2]);
        assert_eq!(view.segments.len(), 2, "空的中间段与最后一跳都保留位置");
        assert!(view.segments.iter().all(|segment| segment.p50.is_none()));
        assert!(view.series.iter().all(Option::is_none));
        assert_eq!(view.nodes.len(), 3);
        assert_eq!(view.nodes[0].server_id, None);
        assert_eq!(view.nodes[0].status, None);
        assert_eq!(view.nodes[2].role, "target");
    }

    /// 在 `[start, end)` 的每个桶里放一条样本；`latency` 是 `(桶序号, 值)`。
    fn per_bucket_samples(
        chain_id: &str,
        server_id: &str,
        seq: i64,
        target: &str,
        start: i64,
        end: i64,
        latency: impl Fn(i64) -> i64,
    ) -> Vec<LatencySample> {
        let mut samples = Vec::new();
        let mut ts = start;
        while ts < end {
            samples.push(sample(
                ts + 60,
                server_id,
                forward(chain_id, seq, server_id, 1),
                target,
                latency(ts),
            ));
            ts += BUCKET;
        }
        samples
    }

    #[test]
    fn a_single_segment_slowdown_is_diagnosed_as_single_hop() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
            ],
        );
        let end = end_at(NOW, BUCKET);
        let current_start = end - 2 * 3600;
        let baseline_start = current_start - 24 * 3600;
        let mut samples = Vec::new();
        // 第 1 段全程 20ms；第 2 段基线 30ms、最近 2h 55ms。
        samples.extend(per_bucket_samples(
            "c1",
            "a",
            0,
            "",
            baseline_start,
            end,
            |_| 20,
        ));
        samples.extend(per_bucket_samples(
            "c1",
            "b",
            1,
            "",
            baseline_start,
            current_start,
            |_| 30,
        ));
        samples.extend(per_bucket_samples(
            "c1",
            "b",
            1,
            "",
            current_start,
            end,
            |_| 55,
        ));
        // 最后一跳（大阪 → 链目标）全程 10ms，保持稳定。
        samples.extend(per_bucket_samples(
            "c1",
            "c",
            2,
            "",
            baseline_start,
            end,
            |_| 10,
        ));

        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            24,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].p50, Some(20.0));
        assert_eq!(view.segments[1].p50, Some(55.0));
        assert_eq!(view.segments[1].delta_ms, Some(25.0));
        assert_eq!(view.segments[1].contribution_pct, 100);
        assert_eq!(view.segments[0].contribution_pct, 0);
        assert_eq!(view.segments[2].p50, Some(10.0));
        assert_eq!(view.segments[2].contribution_pct, 0);
        assert_eq!(view.diagnosis.kind, "single_hop");
        assert_eq!(view.diagnosis.seq, Some(2));
        assert_eq!(aggregate.summary.hop_p50_ms, Some(85), "20 + 55 + 10");
        assert_eq!(aggregate.summary.delta_ms, Some(25));
        assert_eq!(aggregate.summary.slow_chains, 1);
        assert_eq!(
            aggregate.summary.worst_hop.as_ref().map(|hop| hop.seq),
            Some(2)
        );
    }

    #[test]
    fn an_even_slowdown_is_diagnosed_as_overall() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
            ],
        );
        let end = end_at(NOW, BUCKET);
        let current_start = end - 2 * 3600;
        let baseline_start = current_start - 24 * 3600;
        let mut samples = Vec::new();
        for (server, seq) in [("a", 0), ("b", 1)] {
            samples.extend(per_bucket_samples(
                "c1",
                server,
                seq,
                "",
                baseline_start,
                current_start,
                |_| 30,
            ));
            samples.extend(per_bucket_samples(
                "c1",
                server,
                seq,
                "",
                current_start,
                end,
                |_| 40,
            ));
        }
        // 最后一跳全程稳定 10ms，不参与增量占比。
        samples.extend(per_bucket_samples(
            "c1",
            "c",
            2,
            "",
            baseline_start,
            end,
            |_| 10,
        ));

        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            24,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].contribution_pct, 50);
        assert_eq!(view.segments[1].contribution_pct, 50);
        assert_eq!(view.segments[2].contribution_pct, 0);
        assert_eq!(view.diagnosis.kind, "overall");
        assert_eq!(view.diagnosis.seq, None);
        assert_eq!(aggregate.summary.delta_ms, Some(20));
    }

    #[test]
    fn a_long_series_keeps_buckets_older_than_the_baseline_window() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let end = end_at(NOW, BUCKET);
        // 30h 前：比 24h 基线更老，但仍在 48h 的 series 窗口里。
        let ts = end - 30 * 3600;
        // 两段同一桶齐全，整体桶才非 null（最后一跳也必须算进来）。
        let samples = vec![
            sample(ts, "a", forward("c1", 0, "a", 1), "", 20),
            sample(ts, "b", forward("c1", 1, "b", 1), "", 5),
        ];
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            48,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        let index = ((ts - (end - 48 * 3600)) / BUCKET) as usize;
        assert!(
            view.series[index].is_some(),
            "48h 时间轴里 30h 前的桶不能被基线过滤丢掉"
        );
        assert_eq!(view.series[index].as_ref().unwrap().p50, 25.0);
        assert!(
            view.segments[0].p50.is_none(),
            "30h 前的样本不属于最近 2h 当前窗口"
        );
    }

    #[test]
    fn a_partial_bucket_does_not_get_summed_as_zero() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
            ],
        );
        let ts = end_at(NOW, BUCKET) - 60;
        // 只有第 1 段有样本：整体桶必须 null，第 1 段自己仍然有 p50。
        let samples = vec![sample(ts, "a", forward("c1", 0, "a", 1), "", 20)];
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].p50, Some(20.0));
        assert!(view.segments[1].p50.is_none());
        assert!(view.series.last().unwrap().is_none());
    }

    #[test]
    fn zero_attempts_is_null_not_a_zero_loss() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        // 计数行存在但 attempts = 0（差分被丢弃等）：必须当作「没有探测」。
        let probes = probes(&[(forward("c1", 0, "a", 1), 0, 0)]);
        let aggregate = aggregate(&[chain], &[], &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].attempts, 0);
        assert_eq!(view.segments[0].failures, 0);
        assert_eq!(
            view.segments[0].loss_pct, None,
            "attempts=0 必须是 null 而不是 0"
        );
        assert_eq!(view.loss_pct, None, "没有可用段时整链丢包也是 null");
        assert_eq!(view.loss_samples, LossSamples::default());
        assert!(
            !view.loss_partial,
            "全链都没有探测数据时不能标 partial（否则与「无探测数据」矛盾）"
        );
        assert_eq!(aggregate.summary.loss_pct, None);
        assert!(aggregate.summary.worst_loss.is_none());
    }

    #[test]
    fn a_segment_loss_is_failures_over_attempts() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let probes = probes(&[(forward("c1", 0, "a", 1), 240, 2)]);
        let aggregate = aggregate(&[chain], &[], &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].attempts, 240);
        assert_eq!(view.segments[0].failures, 2);
        assert_eq!(view.segments[0].loss_pct, Some(0.8333), "2/240 = 0.8333%");
        assert_eq!(view.loss_pct, Some(0.8333), "只有一段有数据时整链等于该段");
        assert_eq!(
            view.loss_samples,
            LossSamples {
                attempts: 240,
                failures: 2
            }
        );
        assert_eq!(view.segments[1].attempts, 0, "最后一跳没有探测");
        assert_eq!(view.segments[1].loss_pct, None);
        assert!(
            view.loss_partial,
            "最后一跳没有探测数据时，整链丢包只覆盖部分段，必须标 partial"
        );
        assert_eq!(aggregate.summary.loss_pct, Some(0.8333));
        assert_eq!(
            aggregate
                .summary
                .worst_loss
                .as_ref()
                .map(|worst| worst.chain_id.as_str()),
            Some("c1")
        );
    }

    #[test]
    fn chain_loss_compounds_independent_hops() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
            ],
        );
        // 两段各 1%：1 - 0.99² = 1.99%，不是 2%。
        let probes = probes(&[
            (forward("c1", 0, "a", 1), 100, 1),
            (forward("c1", 1, "b", 1), 100, 1),
        ]);
        let aggregate = aggregate(&[chain], &[], &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].loss_pct, Some(1.0));
        assert_eq!(view.segments[1].loss_pct, Some(1.0));
        assert_eq!(view.loss_pct, Some(1.99));
        assert_eq!(
            view.loss_samples,
            LossSamples {
                attempts: 200,
                failures: 2
            }
        );
        assert_eq!(view.segments[2].loss_pct, None, "最后一跳没有探测");
        assert!(view.loss_partial, "最后一跳没有探测数据时必须标 partial");
        assert_eq!(aggregate.summary.loss_pct, Some(1.99));
    }

    #[test]
    fn a_missing_segment_is_skipped_and_flags_partial() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
            ],
        );
        // 只有第 1 段有探测：算法只能覆盖已知段，不能把第 2 段当 0%。
        let probes = probes(&[(forward("c1", 0, "a", 1), 100, 1)]);
        let aggregate = aggregate(&[chain], &[], &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].loss_pct, Some(1.0));
        assert_eq!(view.segments[1].loss_pct, None);
        assert_eq!(view.loss_pct, Some(1.0), "缺的段跳过，不补 0");
        assert!(view.loss_partial);
        assert_eq!(
            view.loss_samples,
            LossSamples {
                attempts: 100,
                failures: 1
            }
        );
    }

    #[test]
    fn all_missing_probes_are_null_and_not_partial() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
                (3, vec![("d", "D")]),
            ],
        );
        // 整链四段（3 个中间段 + 最后一跳）都没有探测：这是「无数据」，
        // 不是「部分跳缺数据」。
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments.len(), 4);
        assert!(view
            .segments
            .iter()
            .all(|segment| segment.loss_pct.is_none()));
        assert_eq!(view.loss_pct, None);
        assert_eq!(view.loss_samples, LossSamples::default());
        assert!(
            !view.loss_partial,
            "全部段都缺探测时 loss_partial 必须是 false"
        );
        assert_eq!(aggregate.summary.loss_pct, None);
        assert!(aggregate.summary.worst_loss.is_none());
    }

    #[test]
    fn two_probed_segments_and_one_missing_stay_partial() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
                (3, vec![("d", "D")]),
            ],
        );
        // 两段有数据（各 1%）、一段没有 → 连乘 1.99%，并标 partial。
        let probes = probes(&[
            (forward("c1", 0, "a", 1), 100, 1),
            (forward("c1", 1, "b", 1), 100, 1),
        ]);
        let aggregate = aggregate(&[chain], &[], &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].loss_pct, Some(1.0));
        assert_eq!(view.segments[1].loss_pct, Some(1.0));
        assert_eq!(view.segments[2].loss_pct, None);
        assert_eq!(view.loss_pct, Some(1.99));
        assert!(view.loss_partial, "部分段有数据、部分没有时必须是 true");
        assert_eq!(
            view.loss_samples,
            LossSamples {
                attempts: 200,
                failures: 2
            }
        );
    }

    #[test]
    fn series_loss_is_per_bucket_not_the_window_value() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
            ],
        );
        let end = end_at(NOW, BUCKET);
        let mut samples = Vec::new();
        for ts in [end - 3 * BUCKET, end - 2 * BUCKET, end - BUCKET] {
            samples.push(sample(ts + 60, "a", forward("c1", 0, "a", 1), "", 20));
            samples.push(sample(ts + 60, "b", forward("c1", 1, "b", 1), "", 30));
            // 最后一跳每桶有时延但没探测：整桶链级 loss 只按前两段算。
            samples.push(sample(ts + 60, "c", forward("c1", 2, "c", 1), "", 10));
        }

        // 桶 1：两段各 1% → 1.99%；桶 2：第 1 段 0%、第 2 段 50% → 50%。
        let mut probes = probes_in_bucket(
            end - 3 * BUCKET,
            &[
                (forward("c1", 0, "a", 1), 100, 1),
                (forward("c1", 1, "b", 1), 100, 1),
            ],
        );
        probes.extend(probes_in_bucket(
            end - 2 * BUCKET,
            &[
                (forward("c1", 0, "a", 1), 100, 0),
                (forward("c1", 1, "b", 1), 100, 50),
            ],
        ));
        // 桶 3：只有第 1 段有探测，第 2 段跳过（桶级不算 partial）。
        probes.extend(probes_in_bucket(
            end - BUCKET,
            &[(forward("c1", 0, "a", 1), 100, 1)],
        ));

        let aggregate = aggregate(&[chain], &samples, &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert!(view.series[0].is_none(), "没有时延样本的桶仍是 null");
        assert_eq!(view.series[1].as_ref().unwrap().loss_pct, Some(1.99));
        assert_eq!(view.series[2].as_ref().unwrap().loss_pct, Some(50.0));
        assert_eq!(
            view.series[3].as_ref().unwrap().loss_pct,
            Some(1.0),
            "缺第 2 段探测时按第 1 段有数据的部分计算"
        );
        assert_eq!(
            view.series[1].as_ref().unwrap().p50,
            60.0,
            "丢包按桶计算不影响 p50（含最后一跳）"
        );
        assert_eq!(view.segments[2].loss_pct, None, "最后一跳没有探测");

        // 窗口值仍是当前 2h 的合并计数：第 1 段 2/300、第 2 段 51/200。
        assert_eq!(view.segments[0].loss_pct, Some(0.6667));
        assert_eq!(view.segments[1].loss_pct, Some(25.5));
        assert_eq!(view.loss_pct, Some(25.9967));
    }

    #[test]
    fn a_series_bucket_without_probes_has_null_loss() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let end = end_at(NOW, BUCKET);
        let samples = vec![
            sample(end - 2 * BUCKET + 60, "a", forward("c1", 0, "a", 1), "", 20),
            sample(end - BUCKET + 60, "a", forward("c1", 0, "a", 1), "", 20),
            // 最后一跳两个桶都有时延，整桶才齐全；探测只写较老的那个桶。
            sample(end - 2 * BUCKET + 60, "b", forward("c1", 1, "b", 1), "", 5),
            sample(end - BUCKET + 60, "b", forward("c1", 1, "b", 1), "", 5),
        ];
        // 只给较老的那个桶写探测；另一个桶只有时延、没有探测。
        let probes = probes_in_bucket(end - 2 * BUCKET + 60, &[(forward("c1", 0, "a", 1), 100, 1)]);

        let aggregate = aggregate(&[chain], &samples, &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.series[2].as_ref().unwrap().loss_pct, Some(1.0));
        assert_eq!(view.series[3].as_ref().unwrap().loss_pct, None);
        assert_eq!(view.series[3].as_ref().unwrap().p50, 25.0);
    }

    #[test]
    fn the_last_hop_probe_is_attributed_to_the_final_hop_not_an_middle_segment() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        // 最后一组的 forward 探测的是链目标：归到最后一跳，不能算进第 1 段。
        let probes = probes(&[(forward("c1", 1, "b", 1), 240, 240)]);
        let aggregate = aggregate(&[chain], &[], &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].attempts, 0, "第 1 段没有探测");
        assert_eq!(view.segments[0].loss_pct, None);
        assert_eq!(view.segments[1].attempts, 240);
        assert_eq!(view.segments[1].failures, 240);
        assert_eq!(view.segments[1].loss_pct, Some(100.0));
        assert_eq!(view.loss_pct, Some(100.0));
        assert!(view.loss_partial, "第 1 段没有探测数据，整链只覆盖部分段");
    }

    #[test]
    fn a_multi_member_segment_sums_probe_counts_before_dividing() {
        let chain = chain(
            "c1",
            vec![(0, vec![("a1", "A1"), ("a2", "A2")]), (1, vec![("b", "B")])],
        );
        // 不能对两个成员的失败率取平均：必须先把计数相加。
        let probes = probes(&[
            (forward("c1", 0, "a1", 2), 100, 0),
            (forward("c1", 0, "a2", 2), 100, 10),
        ]);
        let aggregate = aggregate(&[chain], &[], &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].attempts, 200);
        assert_eq!(view.segments[0].failures, 10);
        assert_eq!(view.segments[0].loss_pct, Some(5.0));
        assert_eq!(view.loss_pct, Some(5.0));
    }

    /// 多成员最后一跳：每个成员的样本按自己的 server_id 归属到同一段，
    /// 不能把 b1 的延迟挂到 b2 上；段内仍按成员池取中位数。
    #[test]
    fn a_multi_member_final_hop_is_attributed_per_source_member() {
        let chain = chain(
            "c1",
            vec![(0, vec![("a", "A")]), (1, vec![("b1", "B1"), ("b2", "B2")])],
        );
        let ts = end_at(NOW, BUCKET) - 60;
        let samples = vec![
            sample(ts, "b1", forward("c1", 1, "b1", 2), "", 10),
            sample(ts, "b2", forward("c1", 1, "b2", 2), "", 30),
            sample(ts, "b1", forward("c1", 1, "b1", 2), "", 50),
        ];
        let probes = probes(&[
            (forward("c1", 1, "b1", 2), 100, 1),
            (forward("c1", 1, "b2", 2), 100, 2),
        ]);
        let aggregate = aggregate(&[chain], &samples, &probes, &no_latest(), NOW, 1, BUCKET);
        assert_eq!(aggregate.unmapped_forwards, 0);
        let view = &aggregate.chains[0];
        assert!(view.missing_hops.is_empty());
        assert_eq!(view.segments.len(), 2, "2 组 = 2 段（含最后一跳）");
        let last = &view.segments[1];
        assert_eq!(last.seq, 2);
        assert_eq!(last.from, "B1", "当前窗口样本最多的是 b1");
        assert_eq!(last.to, CHAIN_TARGET_NAME);
        assert_eq!(last.p50, Some(30.0), "10/30/50 的中位数");
        // 多成员段与中间段同口径：先相加计数再算比值。
        assert_eq!(last.attempts, 200);
        assert_eq!(last.failures, 3);
        assert_eq!(last.loss_pct, Some(1.5));
        assert_eq!(view.loss_pct, Some(1.5));
    }

    /// 同一台服务器既做中间段的源、又做最后一跳的源时，必须按 target 区分：
    /// 带真实目标的样本进中间段，空目标才进最后一跳。
    #[test]
    fn a_middle_segment_and_the_final_hop_do_not_mix_on_the_same_server() {
        // 业务上同一台服务器不能重复出现在一条链里；这里只构造纯逻辑输入，
        // 验证归属看的是 (forward, target) 而不是只看 server_id。
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("x", "X1")]),
                (2, vec![("x", "X2")]),
            ],
        );
        let ts = end_at(NOW, BUCKET) - 60;
        let samples = vec![
            // 中间段：x 的 forward 在 seq=1，目标 x（下一组成员）。
            sample(ts, "x", forward("c1", 1, "x", 1), "x", 10),
            // 最后一跳：x 的 forward 在 seq=2，目标是链目标，空目标。
            sample(ts, "x", forward("c1", 2, "x", 1), "", 50),
        ];
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        assert_eq!(aggregate.unmapped_forwards, 0);
        let view = &aggregate.chains[0];
        assert!(view.missing_hops.is_empty());
        assert_eq!(view.segments[1].seq, 2);
        assert_eq!(view.segments[1].p50, Some(10.0), "中间段只吃真实目标的样本");
        assert_eq!(view.segments[2].seq, 3);
        assert_eq!(view.segments[2].p50, Some(50.0), "最后一跳只吃空目标样本");
    }

    /// 最后一跳带非空目标是历史残留：计入 unmapped，不能当成最后一跳样本。
    #[test]
    fn a_final_hop_sample_with_a_target_is_unmapped() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let ts = end_at(NOW, BUCKET) - 60;
        let samples = vec![sample(ts, "b", forward("c1", 1, "b", 1), "ghost", 10)];
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        assert_eq!(aggregate.unmapped_forwards, 1);
        let view = &aggregate.chains[0];
        assert_eq!(view.missing_hops, vec![2], "没有合法样本时仍声明缺失");
        assert!(view.segments[1].p50.is_none());
    }

    /// 只有探测、没有时延的最后一跳不算「没有样本」：loss 可见，p50 才是 null。
    #[test]
    fn a_probe_only_final_hop_is_not_a_missing_hop() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let probes = probes(&[(forward("c1", 1, "b", 1), 100, 1)]);
        let aggregate = aggregate(&[chain], &[], &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert!(view.missing_hops.is_empty());
        assert!(
            view.segments[1].p50.is_none(),
            "没有时延样本时 p50 仍是 null"
        );
        assert_eq!(view.segments[1].loss_pct, Some(1.0));
        assert_eq!(view.loss_pct, Some(1.0));
    }

    /// attempts = 0 的探测行只是基线，不能把最后一跳从 missing_hops 里「救」出来。
    #[test]
    fn a_zero_attempt_final_probe_is_not_data() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let probes = probes(&[(forward("c1", 1, "b", 1), 0, 0)]);
        let aggregate = aggregate(&[chain], &[], &probes, &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.missing_hops, vec![2]);
        assert_eq!(view.segments[1].attempts, 0);
        assert_eq!(view.segments[1].loss_pct, None);
        assert_eq!(view.loss_pct, None);
    }

    /// 拓扑节点：首组 source、中间/末组 hop、末尾 target；组节点的状态是
    /// 组内最差成员，成员全部展开。
    #[test]
    fn topology_nodes_carry_roles_and_server_status() {
        let mut hk = full_member("a", "香港-01", "203.0.113.11", None, 21_001, 0);
        hk.server_status = "online".into();
        let mut tokyo = full_member("b", "东京-01", "198.51.100.21", None, 21_002, 0);
        tokyo.server_status = "offline".into();
        let mut osaka = full_member("c", "大阪-01", "198.51.100.23", None, 21_003, 0);
        osaka.server_status = "abnormal".into();
        let chain = topology(
            "c1",
            vec![
                (0, Some(443), vec![hk]),
                (1, None, vec![tokyo]),
                (2, None, vec![osaka]),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(
            view.nodes,
            vec![
                NodeView {
                    seq: 0,
                    server_id: Some("a".into()),
                    name: "香港-01".into(),
                    role: "source",
                    status: Some("online".into()),
                    member_count: 1,
                    members: vec![node_member("a", "香港-01", "online")],
                    strategy: None,
                    active_server_id: None,
                },
                NodeView {
                    seq: 1,
                    server_id: Some("b".into()),
                    name: "东京-01".into(),
                    role: "hop",
                    status: Some("offline".into()),
                    member_count: 1,
                    members: vec![node_member("b", "东京-01", "offline")],
                    strategy: Some("round_robin".into()),
                    active_server_id: None,
                },
                NodeView {
                    seq: 2,
                    server_id: Some("c".into()),
                    name: "大阪-01".into(),
                    role: "hop",
                    status: Some("abnormal".into()),
                    member_count: 1,
                    members: vec![node_member("c", "大阪-01", "abnormal")],
                    strategy: Some("round_robin".into()),
                    active_server_id: None,
                },
                NodeView {
                    seq: 3,
                    server_id: None,
                    name: CHAIN_TARGET_NAME.into(),
                    role: "target",
                    status: None,
                    member_count: 0,
                    members: Vec::new(),
                    strategy: None,
                    active_server_id: None,
                },
            ]
        );
        // entry / exit 保留，node 与它们不冲突。
        assert_eq!(view.entry.as_ref().unwrap().server_id, "a");
        assert_eq!(view.exit.as_ref().unwrap().server_id, "c");
    }

    /// 拓扑节点的策略：入口组与链目标为 null，其余组取该组策略；
    /// 库里的非法值回落 `round_robin`。
    #[test]
    fn node_strategy_normalizes_and_falls_back_to_round_robin() {
        let mut chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![full_member("a", "A", "10.0.0.1", None, 21_001, 0)],
                ),
                (
                    1,
                    None,
                    vec![full_member("b", "B", "10.0.0.2", None, 21_002, 0)],
                ),
                (
                    2,
                    None,
                    vec![full_member("c", "C", "10.0.0.3", None, 21_003, 0)],
                ),
            ],
        );
        chain.groups[1].group.strategy = "failover".into();
        chain.groups[2].group.strategy = "garbage".into();
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let nodes = &aggregate.chains[0].nodes;
        assert_eq!(nodes[0].strategy, None, "入口组不执行选路");
        assert_eq!(nodes[1].strategy.as_deref(), Some("failover"));
        assert_eq!(
            nodes[2].strategy.as_deref(),
            Some("round_robin"),
            "非法策略必须回落轮询，而不是让节点缺字段"
        );
        assert_eq!(nodes[3].strategy, None, "链目标没有选路策略");
    }

    /// 入口代表成员 → 第 1 跳选中 → 第 2 跳选中：通路逐跳串起来；
    /// 入口组与链目标恒为 null。
    #[test]
    fn active_members_follows_the_reported_selection_hop_by_hop() {
        let mut chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![full_member("a", "A", "10.0.0.1", None, 21_001, 0)],
                ),
                (
                    1,
                    None,
                    vec![
                        full_member("b", "B", "10.0.0.2", None, 21_002, 0),
                        full_member("c", "C", "10.0.0.3", None, 21_003, 1),
                    ],
                ),
                (
                    2,
                    None,
                    vec![full_member("d", "D", "10.0.0.4", None, 21_004, 0)],
                ),
            ],
        );
        chain.groups[1].group.strategy = "failover".into();
        chain.groups[2].group.strategy = "failover".into();
        let latest = latest_probes(&[
            (
                forward("c1", 0, "a", 1),
                &[("b", Some(false)), ("c", Some(true))][..],
            ),
            (forward("c1", 1, "c", 2), &[("d", Some(true))][..]),
        ]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), &latest, NOW, 1, BUCKET);
        let nodes = &aggregate.chains[0].nodes;
        assert_eq!(nodes[0].active_server_id, None, "入口组恒为 null");
        assert_eq!(nodes[1].active_server_id.as_deref(), Some("c"));
        assert_eq!(nodes[2].active_server_id.as_deref(), Some("d"));
        assert_eq!(nodes[3].active_server_id, None, "链目标恒为 null");
    }

    /// 上一跳没有探测记录：从该跳起全部 null，不能跳过它继续猜后面的。
    #[test]
    fn active_members_stops_when_a_hop_has_no_status_record() {
        let mut chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![full_member("a", "A", "10.0.0.1", None, 21_001, 0)],
                ),
                (
                    1,
                    None,
                    vec![
                        full_member("b", "B", "10.0.0.2", None, 21_002, 0),
                        full_member("c", "C", "10.0.0.3", None, 21_003, 1),
                    ],
                ),
                (
                    2,
                    None,
                    vec![full_member("d", "D", "10.0.0.4", None, 21_004, 0)],
                ),
            ],
        );
        chain.groups[1].group.strategy = "failover".into();
        let latest = latest_probes(&[(
            forward("c1", 0, "a", 1),
            &[("b", Some(false)), ("c", Some(true))][..],
        )]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), &latest, NOW, 1, BUCKET);
        let nodes = &aggregate.chains[0].nodes;
        assert_eq!(nodes[1].active_server_id.as_deref(), Some("c"));
        assert_eq!(nodes[2].active_server_id, None);
    }

    /// 没有 `active=true`（旧 Agent / 非单一选中策略）：从该跳起 null。
    #[test]
    fn active_members_is_null_when_no_target_is_marked_active() {
        let mut chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![full_member("a", "A", "10.0.0.1", None, 21_001, 0)],
                ),
                (
                    1,
                    None,
                    vec![
                        full_member("b", "B", "10.0.0.2", None, 21_002, 0),
                        full_member("c", "C", "10.0.0.3", None, 21_003, 1),
                    ],
                ),
            ],
        );
        chain.groups[1].group.strategy = "failover".into();
        let latest = latest_probes(&[(
            forward("c1", 0, "a", 1),
            &[("b", None), ("c", Some(false))][..],
        )]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), &latest, NOW, 1, BUCKET);
        let nodes = &aggregate.chains[0].nodes;
        assert_eq!(nodes[1].active_server_id, None);
    }

    /// 同一个规则出现多个 `Some(true)`（脏数据）：没有单一选中项，按无数据处理。
    #[test]
    fn active_members_rejects_multiple_active_targets() {
        let mut chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![full_member("a", "A", "10.0.0.1", None, 21_001, 0)],
                ),
                (
                    1,
                    None,
                    vec![
                        full_member("b", "B", "10.0.0.2", None, 21_002, 0),
                        full_member("c", "C", "10.0.0.3", None, 21_003, 1),
                    ],
                ),
            ],
        );
        chain.groups[1].group.strategy = "failover".into();
        let latest = latest_probes(&[(
            forward("c1", 0, "a", 1),
            &[("b", Some(true)), ("c", Some(true))][..],
        )]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), &latest, NOW, 1, BUCKET);
        assert_eq!(aggregate.chains[0].nodes[1].active_server_id, None);
    }

    /// active 的 server_id 不在本组（例如链改过成员后的历史数据）：该跳起 null。
    #[test]
    fn active_members_stops_when_the_selected_server_is_not_in_the_group() {
        let mut chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![full_member("a", "A", "10.0.0.1", None, 21_001, 0)],
                ),
                (
                    1,
                    None,
                    vec![
                        full_member("b", "B", "10.0.0.2", None, 21_002, 0),
                        full_member("c", "C", "10.0.0.3", None, 21_003, 1),
                    ],
                ),
                (
                    2,
                    None,
                    vec![full_member("d", "D", "10.0.0.4", None, 21_004, 0)],
                ),
            ],
        );
        chain.groups[1].group.strategy = "failover".into();
        chain.groups[2].group.strategy = "failover".into();
        let latest = latest_probes(&[
            (forward("c1", 0, "a", 1), &[("ghost", Some(true))][..]),
            (forward("c1", 1, "c", 2), &[("d", Some(true))][..]),
        ]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), &latest, NOW, 1, BUCKET);
        let nodes = &aggregate.chains[0].nodes;
        assert_eq!(nodes[1].active_server_id, None);
        assert_eq!(nodes[2].active_server_id, None);
    }

    /// 上一跳通路成员非 online：该跳（以及之后）全部 null，但上一跳已确定的
    /// 成员仍然保留（它确实被选中了，只是不在线）。
    #[test]
    fn active_members_stops_after_an_offline_hop_member() {
        let mut chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![full_member("a", "A", "10.0.0.1", None, 21_001, 0)],
                ),
                (
                    1,
                    None,
                    vec![
                        full_member("b", "B", "10.0.0.2", None, 21_002, 0),
                        full_member("c", "C", "10.0.0.3", None, 21_003, 1),
                    ],
                ),
                (
                    2,
                    None,
                    vec![full_member("d", "D", "10.0.0.4", None, 21_004, 0)],
                ),
            ],
        );
        chain.groups[1].members[1].server_status = "offline".into();
        chain.groups[1].group.strategy = "failover".into();
        chain.groups[2].group.strategy = "failover".into();
        let latest = latest_probes(&[
            (
                forward("c1", 0, "a", 1),
                &[("b", Some(false)), ("c", Some(true))][..],
            ),
            (forward("c1", 1, "c", 2), &[("d", Some(true))][..]),
        ]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), &latest, NOW, 1, BUCKET);
        let nodes = &aggregate.chains[0].nodes;
        assert_eq!(nodes[1].active_server_id.as_deref(), Some("c"));
        assert_eq!(
            nodes[2].active_server_id, None,
            "上一跳成员离线后不能再往下走"
        );
    }

    /// 单成员组走兼容字段时 `server_id` 是空串：唯一成员可确定，按该成员算。
    #[test]
    fn active_members_resolves_an_empty_server_id_to_the_only_member() {
        let mut chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![full_member("a", "A", "10.0.0.1", None, 21_001, 0)],
                ),
                (
                    1,
                    None,
                    vec![full_member("b", "B", "10.0.0.2", None, 21_002, 0)],
                ),
            ],
        );
        chain.groups[1].group.strategy = "failover".into();
        let latest = latest_probes(&[(forward("c1", 0, "a", 1), &[("", Some(true))][..])]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), &latest, NOW, 1, BUCKET);
        assert_eq!(
            aggregate.chains[0].nodes[1].active_server_id.as_deref(),
            Some("b")
        );
    }

    /// 多成员组的节点展开**全部**成员：顺序沿用 `(priority, server_id)`，
    /// `member_count` 是成员数，`server_id` / `name` 仍取代表成员。
    #[test]
    fn multi_member_nodes_expand_every_member_in_priority_order() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![
                        full_member("z", "Z", "10.0.0.1", None, 21_001, 0),
                        full_member("a", "A", "10.0.0.2", None, 21_002, 0),
                        full_member("m", "M", "10.0.0.3", None, 21_003, 5),
                    ],
                ),
                (
                    1,
                    None,
                    vec![full_member("b", "B", "10.0.0.4", None, 21_004, 0)],
                ),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert!(view.estimated);
        assert_eq!(view.nodes.len(), 3);
        let source = &view.nodes[0];
        assert_eq!(source.server_id.as_deref(), Some("a"), "代表成员不变");
        assert_eq!(source.name, "A", "组名不可用时回退代表成员名");
        assert_eq!(source.role, "source");
        assert_eq!(source.member_count, 3);
        assert_eq!(
            source.members,
            vec![
                node_member("a", "A", "online"),
                node_member("z", "Z", "online"),
                node_member("m", "M", "online"),
            ],
            "成员完整、按 (priority, server_id) 排序"
        );
        assert_eq!(view.nodes[1].member_count, 1);
        assert_eq!(view.nodes[2].role, "target");
        assert_eq!(view.nodes[2].members, Vec::new());
        assert_eq!(view.nodes[2].member_count, 0);
    }

    /// 组级状态取最差成员：offline > abnormal/no_data > online。
    #[test]
    fn a_group_status_is_the_worst_member_status() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![
                        status_member("a", "A", "online", 21_001),
                        status_member("b", "B", "abnormal", 21_002),
                    ],
                ),
                (
                    1,
                    None,
                    vec![
                        status_member("c", "C", "no_data", 21_003),
                        status_member("d", "D", "offline", 21_004),
                    ],
                ),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(
            view.nodes[0].status.as_deref(),
            Some("abnormal"),
            "online + abnormal → 取更差的 abnormal"
        );
        assert_eq!(
            view.nodes[1].status.as_deref(),
            Some("offline"),
            "no_data + offline → offline 最差"
        );
        assert_eq!(
            view.nodes[0].members[1].status, "abnormal",
            "成员状态原样保留，不被组级状态覆盖"
        );
    }

    /// 期望的成员节点：`(server_id, name, status)`。
    fn node_member(server_id: &str, name: &str, status: &str) -> NodeMember {
        NodeMember {
            server_id: server_id.into(),
            name: name.into(),
            status: status.into(),
        }
    }

    /// 指定服务器状态的成员：用于链级可用性判定。
    fn status_member(
        server_id: &str,
        server_name: &str,
        status: &str,
        listen_port: i64,
    ) -> ChainGroupMember {
        let mut member = full_member(server_id, server_name, "10.0.0.1", None, listen_port, 0);
        member.server_status = status.into();
        member
    }

    /// 一条三段链、所有段在当前窗口都有样本时的「健康」输入。
    fn healthy_samples(chain_id: &str) -> Vec<LatencySample> {
        let ts = end_at(NOW, BUCKET) - 60;
        vec![
            sample(ts, "a", forward(chain_id, 0, "a", 1), "", 12),
            sample(ts, "b", forward(chain_id, 1, "b", 1), "", 8),
            sample(ts, "c", forward(chain_id, 2, "c", 1), "", 6),
        ]
    }

    /// 24h 样本：第 2 段最近 2h +20ms，其余段持平 → 整体变慢。
    fn slowed_samples(chain_id: &str) -> Vec<LatencySample> {
        let end = end_at(NOW, BUCKET);
        let current_start = end - 2 * 3600;
        let baseline_start = current_start - 24 * 3600;
        let mut samples = Vec::new();
        let mut ts = baseline_start;
        while ts < end {
            samples.push(sample(ts + 60, "a", forward(chain_id, 0, "a", 1), "", 20));
            let second = if ts >= current_start { 50 } else { 30 };
            samples.push(sample(
                ts + 60,
                "b",
                forward(chain_id, 1, "b", 1),
                "",
                second,
            ));
            samples.push(sample(ts + 60, "c", forward(chain_id, 2, "c", 1), "", 10));
            ts += BUCKET;
        }
        samples
    }

    /// 三种 kind 之一：所有节点在线、当前窗口数据完整且不慢 → `ok`。
    /// 链目标节点的 `status` 恒为 null，不能把链判成 degraded。
    #[test]
    fn chain_status_is_ok_when_every_node_is_online_and_data_is_current() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![status_member("a", "香港-01", "online", 21_001)],
                ),
                (
                    1,
                    None,
                    vec![status_member("b", "东京-01", "online", 21_002)],
                ),
                (
                    2,
                    None,
                    vec![status_member("c", "大阪-01", "online", 21_003)],
                ),
            ],
        );
        let aggregate = aggregate(
            &[chain],
            &healthy_samples("c1"),
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert!(view.missing_hops.is_empty());
        assert_eq!(view.status.kind, "ok");
        assert_eq!(view.status.cause, None);
        assert_eq!(view.status.node, None);
        // 链目标节点不参与判定：它的 status 是 null，但链仍是 ok。
        let target = view.nodes.last().unwrap();
        assert_eq!(target.role, "target");
        assert_eq!(target.status, None);
    }

    /// 非 online 的普通节点（abnormal / no_data …）→ `degraded` / `node_unhealthy`。
    #[test]
    fn an_unhealthy_hop_degrades_the_chain_without_naming_a_node() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![status_member("a", "香港-01", "online", 21_001)],
                ),
                (
                    1,
                    None,
                    vec![status_member("b", "东京-01", "no_data", 21_002)],
                ),
                (
                    2,
                    None,
                    vec![status_member("c", "大阪-01", "online", 21_003)],
                ),
            ],
        );
        let aggregate = aggregate(
            &[chain],
            &healthy_samples("c1"),
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert_eq!(view.status.kind, "degraded");
        assert_eq!(view.status.cause, Some("node_unhealthy"));
        assert_eq!(view.status.node, None, "只有 node_offline 才点名叫节点");
    }

    /// 掉线节点 → `blocked` / `node_offline`，点名 seq 最小的那台离线节点；
    /// 即使同时缺样本（缺样本本身会判 no_samples），也必须先判节点离线。
    #[test]
    fn an_offline_hop_blocks_the_chain_and_names_the_first_offline_node() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![status_member("a", "香港-01", "online", 21_001)],
                ),
                (
                    1,
                    None,
                    vec![status_member("b", "东京-01", "offline", 21_002)],
                ),
                (
                    2,
                    None,
                    vec![status_member("c", "大阪-01", "offline", 21_003)],
                ),
            ],
        );
        // 完全没样本：缺样本不能抢在节点离线前面。
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.missing_hops, vec![3], "最后一跳确实没有样本");
        assert_eq!(view.status.kind, "blocked");
        assert_eq!(view.status.cause, Some("node_offline"));
        assert_eq!(
            view.status.node,
            Some(StatusNode {
                seq: 1,
                name: "东京-01".into(),
                member_name: Some("东京-01".into()),
            }),
            "两台都离线时取 seq 最小的第一台"
        );
    }

    /// 多成员组里第二台成员离线：只是容量下降，链仍可用 → `degraded` /
    /// `node_offline`，并点名那台成员（不是代表成员）。
    #[test]
    fn an_offline_second_member_degrades_the_chain_and_names_that_member() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![status_member("a", "香港-01", "online", 21_001)],
                ),
                (
                    1,
                    None,
                    vec![
                        status_member("b1", "东京-01", "online", 21_002),
                        status_member("b2", "东京-02", "offline", 21_003),
                    ],
                ),
            ],
        );
        let ts = end_at(NOW, BUCKET) - 60;
        // 在线成员的样本齐全：不能是因为缺样本才判 degraded。
        let samples = vec![
            sample(ts, "a", forward("c1", 0, "a", 1), "b1", 10),
            sample(ts, "b1", forward("c1", 1, "b1", 2), "", 5),
        ];
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert!(view.missing_hops.is_empty(), "在线成员的样本足够完整");
        assert_eq!(
            view.status.kind, "degraded",
            "多成员组只掉一台：链路仍然可用，不能阻断"
        );
        assert_eq!(view.status.cause, Some("node_offline"));
        assert_eq!(
            view.status.node,
            Some(StatusNode {
                seq: 1,
                name: "东京-02".into(),
                member_name: Some("东京-02".into()),
            }),
            "点名第二台成员，而不是代表成员 b1"
        );
        assert_eq!(
            view.nodes[1].status.as_deref(),
            Some("offline"),
            "组级状态取最差成员"
        );
        assert_eq!(view.nodes[1].member_count, 2);
    }

    /// 多成员组两台全离线：这一跳已经没有在线成员，链必须 `blocked`。
    #[test]
    fn a_group_without_any_online_member_blocks_the_chain() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![status_member("a", "香港-01", "online", 21_001)],
                ),
                (
                    1,
                    None,
                    vec![
                        status_member("b1", "东京-01", "offline", 21_002),
                        status_member("b2", "东京-02", "offline", 21_003),
                    ],
                ),
                (
                    2,
                    None,
                    vec![status_member("c", "大阪-01", "online", 21_004)],
                ),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.status.kind, "blocked");
        assert_eq!(view.status.cause, Some("node_offline"));
        assert_eq!(
            view.status.node,
            Some(StatusNode {
                seq: 1,
                name: "东京-01".into(),
                member_name: Some("东京-01".into()),
            }),
            "点名该跳第一台离线成员"
        );
    }

    /// 入口组同理：组内还有在线成员就不阻断，只降级并点名离线的那台。
    #[test]
    fn a_partially_offline_entry_group_only_degrades_the_chain() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![
                        status_member("a1", "香港-01", "online", 21_001),
                        status_member("a2", "香港-02", "offline", 21_002),
                    ],
                ),
                (
                    1,
                    None,
                    vec![status_member("b", "东京-01", "online", 21_003)],
                ),
            ],
        );
        let ts = end_at(NOW, BUCKET) - 60;
        // 在线成员 a1 的样本完整：不能是因为缺样本才判降级。
        let samples = vec![
            sample(ts, "a1", forward("c1", 0, "a1", 2), "b", 10),
            sample(ts, "b", forward("c1", 1, "b", 1), "", 5),
        ];
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert!(view.missing_hops.is_empty(), "在线成员的样本足够完整");
        assert_eq!(view.status.kind, "degraded");
        assert_eq!(view.status.cause, Some("node_offline"));
        assert_eq!(
            view.status.node,
            Some(StatusNode {
                seq: 0,
                name: "香港-02".into(),
                member_name: Some("香港-02".into()),
            })
        );
    }

    /// 多个组分别有成员离线（每组都还有在线成员）→ 仍只是 `degraded`。
    #[test]
    fn several_partially_offline_groups_stay_degraded() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![
                        status_member("a1", "香港-01", "online", 21_001),
                        status_member("a2", "香港-02", "offline", 21_002),
                    ],
                ),
                (
                    1,
                    None,
                    vec![
                        status_member("b1", "东京-01", "online", 21_003),
                        status_member("b2", "东京-02", "offline", 21_004),
                    ],
                ),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.status.kind, "degraded");
        assert_eq!(view.status.cause, Some("node_offline"));
        assert_eq!(
            view.status.node,
            Some(StatusNode {
                seq: 0,
                name: "香港-02".into(),
                member_name: Some("香港-02".into()),
            }),
            "点名拓扑上第一台离线成员"
        );
    }

    /// 部分离线 + abnormal 混合：仍是 `degraded`，cause 优先 `node_offline`。
    #[test]
    fn a_partial_offline_member_outranks_an_abnormal_member() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![
                        status_member("a1", "香港-01", "online", 21_001),
                        status_member("a2", "香港-02", "offline", 21_002),
                    ],
                ),
                (
                    1,
                    None,
                    vec![
                        status_member("b1", "东京-01", "online", 21_003),
                        status_member("b2", "东京-02", "abnormal", 21_004),
                    ],
                ),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.status.kind, "degraded");
        assert_eq!(
            view.status.cause,
            Some("node_offline"),
            "离线优先于 abnormal"
        );
        assert_eq!(
            view.status.node,
            Some(StatusNode {
                seq: 0,
                name: "香港-02".into(),
                member_name: Some("香港-02".into()),
            })
        );
    }

    /// 空组：没有任何成员能承载这一跳 → `blocked`；没有成员可点名，`node` 为 null。
    #[test]
    fn an_empty_required_group_blocks_the_chain_without_naming_a_node() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![status_member("a", "香港-01", "online", 21_001)],
                ),
                (1, None, vec![]),
                (
                    2,
                    None,
                    vec![status_member("c", "大阪-01", "online", 21_002)],
                ),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.status.kind, "blocked");
        assert_eq!(view.status.cause, Some("node_offline"));
        assert_eq!(view.status.node, None, "空组没有成员可点名");
    }

    /// 节点在线、但当前窗口没有任何完整整体样本，且有断点 → `degraded` / `no_samples`。
    #[test]
    fn missing_samples_degrade_the_chain_with_cause_no_samples() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![status_member("a", "香港-01", "online", 21_001)],
                ),
                (
                    1,
                    None,
                    vec![status_member("b", "东京-01", "online", 21_002)],
                ),
            ],
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.missing_hops, vec![2]);
        assert_eq!(view.status.kind, "degraded");
        assert_eq!(view.status.cause, Some("no_samples"));
        assert_eq!(view.status.node, None);
    }

    /// 所有节点在线、整体较基线变慢 → `degraded` / `slow`。
    #[test]
    fn a_slow_chain_degrades_with_cause_slow() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![status_member("a", "香港-01", "online", 21_001)],
                ),
                (
                    1,
                    None,
                    vec![status_member("b", "东京-01", "online", 21_002)],
                ),
                (
                    2,
                    None,
                    vec![status_member("c", "大阪-01", "online", 21_003)],
                ),
            ],
        );
        let samples = slowed_samples("c1");
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            24,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert_eq!(view.status.kind, "degraded");
        assert_eq!(view.status.cause, Some("slow"));
        assert_eq!(view.status.node, None);
        assert_eq!(
            aggregate.summary.slow_chains, 1,
            "逐链 slow 与 summary.slow_chains 必须同一口径"
        );
    }

    /// 节点离线优先于变慢：同一份「确实变慢」的数据，只要有一台离线就是 blocked。
    #[test]
    fn an_offline_node_outranks_a_slowdown() {
        let chain = topology(
            "c1",
            vec![
                (
                    0,
                    None,
                    vec![status_member("a", "香港-01", "online", 21_001)],
                ),
                (
                    1,
                    None,
                    vec![status_member("b", "东京-01", "online", 21_002)],
                ),
                (
                    2,
                    None,
                    vec![status_member("c", "大阪-01", "offline", 21_003)],
                ),
            ],
        );
        let samples = slowed_samples("c1");
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            24,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert_eq!(aggregate.summary.slow_chains, 1, "数据本身确实满足变慢口径");
        assert_eq!(view.status.kind, "blocked");
        assert_eq!(view.status.cause, Some("node_offline"));
        assert_eq!(
            view.status.node,
            Some(StatusNode {
                seq: 2,
                name: "大阪-01".into(),
                member_name: Some("大阪-01".into()),
            })
        );
    }

    /// 引擎 / 协议给链换一套运行时（native + tcp 是唯一可探测组合）。
    fn with_runtime(mut chain: ChainWithGroups, engine: &str, protocol: &str) -> ChainWithGroups {
        chain.chain.engine = engine.into();
        chain.chain.protocol = protocol.into();
        chain
    }

    /// B1：Agent 不探测最后一跳（realm / nftables / tunnel / udp / both）时，
    /// 最后一跳不能把 `series`、`current_overall`、`status`、`missing_hops`
    /// 拖空 / 拖成 degraded；它只是「不可测」，不是「缺数据」。
    #[test]
    fn an_unmeasurable_last_hop_does_not_empty_the_series() {
        for (engine, protocol, reason) in [
            ("realm", "tcp", "engine_unsupported"),
            ("nftables", "tcp", "engine_unsupported"),
            ("tunnel", "tcp", "engine_unsupported"),
            ("native", "udp", "protocol_unsupported"),
            ("native", "both", "protocol_unsupported"),
        ] {
            let chain = with_runtime(
                chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]),
                engine,
                protocol,
            );
            let end = end_at(NOW, BUCKET);
            // 只有中间段有数据：最后一跳由 Agent 实际行为决定，永远没有样本。
            let samples = vec![sample(end - 60, "a", forward("c1", 0, "a", 1), "b", 20)];
            let probes = probes(&[(forward("c1", 0, "a", 1), 200, 2)]);
            let aggregate = aggregate(&[chain], &samples, &probes, &no_latest(), NOW, 1, BUCKET);
            let view = &aggregate.chains[0];
            assert!(!view.last_hop.measurable, "{engine}/{protocol}");
            assert_eq!(view.last_hop.reason, Some(reason), "{engine}/{protocol}");
            assert_eq!(view.segments.len(), 2, "最后一跳保留段位");
            assert_eq!(view.segments[1].p50, None, "没有样本就是 null");
            let last = view.series.last().unwrap().as_ref().unwrap_or_else(|| {
                panic!("{engine}/{protocol} 的 series 不能被不可测的最后一跳拖空")
            });
            assert_eq!(last.p50, 20.0, "整链 p50 只由可测的中间段求和");
            assert_eq!(last.loss_pct, Some(1.0));
            assert!(
                view.missing_hops.is_empty(),
                "{engine}/{protocol}：不可测不是缺失：{:?}",
                view.missing_hops
            );
            assert_eq!(
                view.status.kind, "unknown",
                "{engine}/{protocol}：不可测链不能判成 degraded/no_samples"
            );
            assert_eq!(view.status.cause, Some("unmeasurable"));
            assert_eq!(view.loss_pct, Some(1.0));
            assert!(
                !view.loss_partial,
                "不可测的最后一跳不能让整链永远显示「部分跳缺少数据」"
            );
            assert_eq!(view.segments[1].attempts, 0);
        }
    }

    /// B2：连「任何可测段」都没有（单组 + 不可测最后一跳）时，状态是
    /// `unknown` / `unmeasurable`，不是 `degraded` / `no_samples`。
    #[test]
    fn a_chain_without_any_measurable_segment_is_unknown_not_no_samples() {
        let chain = with_runtime(chain("c1", vec![(0, vec![("a", "A")])]), "realm", "tcp");
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert!(!view.last_hop.measurable);
        assert!(view.missing_hops.is_empty(), "不可测不是缺失");
        assert!(view.series.iter().all(Option::is_none));
        assert_eq!(view.status.kind, "unknown");
        assert_eq!(view.status.cause, Some("unmeasurable"));
        assert_eq!(view.status.node, None);
    }

    /// 不可测链不能驱动 `summary` 的慢链 / headline：它的样本只可能是历史
    /// 残留，逐链状态又是 `unknown`，否则会和 `status.cause = slow` 的口径
    /// 自相矛盾（文档承诺 summary.slow_chains 与逐链 slow 同源）。
    #[test]
    fn an_unmeasurable_chain_never_drives_the_slow_summary() {
        let chain = with_runtime(
            topology(
                "c1",
                vec![
                    (
                        0,
                        None,
                        vec![status_member("a", "香港-01", "online", 21_001)],
                    ),
                    (
                        1,
                        None,
                        vec![status_member("b", "东京-01", "online", 21_002)],
                    ),
                    (
                        2,
                        None,
                        vec![status_member("c", "大阪-01", "online", 21_003)],
                    ),
                ],
            ),
            "realm",
            "tcp",
        );
        let samples = slowed_samples("c1");
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            24,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert_eq!(view.status.kind, "unknown");
        assert_eq!(view.status.cause, Some("unmeasurable"));
        assert_eq!(aggregate.summary.slow_chains, 0);
        assert_eq!(aggregate.summary.hop_p50_ms, None);
        assert_eq!(aggregate.summary.delta_ms, None);
    }

    /// B2：节点状态仍然优先于「不可测」——真正掉线的链还是 blocked。
    #[test]
    fn an_offline_member_outranks_an_unmeasurable_last_hop() {
        let chain = with_runtime(
            topology(
                "c1",
                vec![
                    (
                        0,
                        None,
                        vec![status_member("a", "香港-01", "online", 21_001)],
                    ),
                    (
                        1,
                        None,
                        vec![status_member("b", "东京-01", "offline", 21_002)],
                    ),
                ],
            ),
            "realm",
            "tcp",
        );
        let aggregate = aggregate(&[chain], &[], &no_probes(), &no_latest(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert!(!view.last_hop.measurable);
        assert_eq!(view.status.kind, "blocked");
        assert_eq!(view.status.cause, Some("node_offline"));
    }

    /// B6：最后一跳「有样本」只认 series 窗口（请求的 hours）；只在 24h
    /// 基线窗口里出现的旧样本不能让 `missing_hops` 变空。
    #[test]
    fn a_final_hop_seen_only_in_the_baseline_window_is_still_missing() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let end = end_at(NOW, BUCKET);
        // hours = 1：series 窗口只有 4 个桶，3 小时前的样本落在 24h 基线里。
        let ts = end - 3 * 3600 + 60;
        let samples = vec![
            sample(ts, "a", forward("c1", 0, "a", 1), "b", 20),
            sample(ts, "b", forward("c1", 1, "b", 1), "", 5),
        ];
        let aggregate = aggregate(
            &[chain],
            &samples,
            &no_probes(),
            &no_latest(),
            NOW,
            1,
            BUCKET,
        );
        let view = &aggregate.chains[0];
        assert_eq!(
            view.missing_hops,
            vec![2],
            "基线窗口里的旧样本不算「最近有数据」"
        );
        assert!(view.series.iter().all(Option::is_none));
    }

    #[test]
    fn the_summary_reports_the_worst_visible_chain() {
        let a = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let b = chain("c2", vec![(0, vec![("c", "C")]), (1, vec![("d", "D")])]);
        let probes = probes(&[
            (forward("c1", 0, "a", 1), 100, 50),
            (forward("c2", 0, "c", 1), 100, 1),
        ]);
        let aggregate = aggregate(&[a, b], &[], &probes, &no_latest(), NOW, 1, BUCKET);
        assert_eq!(aggregate.chains[0].loss_pct, Some(50.0));
        assert_eq!(aggregate.chains[1].loss_pct, Some(1.0));
        assert_eq!(aggregate.summary.loss_pct, Some(50.0));
        let worst = aggregate.summary.worst_loss.unwrap();
        assert_eq!(worst.chain_id, "c1");
        assert_eq!(worst.chain_name, "chain-c1");
        assert_eq!(worst.loss_pct, 50.0);
    }
}
