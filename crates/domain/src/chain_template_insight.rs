//! 「转发链模板」洞察（`/api/v1/overview/chain-templates`）的纯逻辑。
//!
//! 输入是**一次读出的模板列表 / 链拓扑 / 服务器状态**，以及（详情页额外的）
//! **一次取出的当前窗口时延样本与探测计数**；这里只做内存归并，不碰 SQL、
//! 不读 HTTP 上下文。口径见 `docs/CHAIN-TEMPLATE-INSIGHT.md`：
//!
//! * 列表 `chains` = 仍然存在（未删除）且 `chains.template_id = 模板 id` 的链，
//!   含管理员链与用户链；`users` 是这些链里 `owner_user_id` 的去重数，
//!   管理员链（owner 为空）不计入；
//! * `status`：模板停用 → `blocked/disabled`；否则模板**每个组的候选成员**
//!   里某组**全部离线**（这一跳没有在线候选）→ `blocked/member_offline`；
//!   组内还有在线候选、只是部分成员离线 → `degraded`（`cause` 为 `null`，
//!   链路只是容量下降）；任一非 `online` 但未确认离线的候选（`abnormal` /
//!   `no_data` / 服务器已删除）→ `degraded`（没有专门的 cause）；全部 online
//!   → `ok`；模板没有任何候选成员 → `degraded`；
//! * 详情 `nodes[].members[].chains` / `users` = 实际链在该组包含该成员的
//!   去重链 / 用户数（键是真实组的 `seq`，不是模板的 `seq`）；
//! * 详情的 `nodes` **只来自真实链的实际拓扑**（`chain_groups` /
//!   `chain_group_members`），模板只提供候选清单：模板改过跳数或成员后，
//!   节点/边仍然画真实链，不会错位。与模板当前定义不一致时 `template.stale`
//!   为 `true` 并给出 `stale_reason`；没被任何链用到的候选成员单独放在
//!   `unused_candidates`，不混进 `nodes`；
//! * `edges` 来自**实际链的 groups**：相邻两组之间按成员对展开，最后一组
//!   的每个成员再连到该链的目标。同一 `(from.member → to.member)` 跨链合并；
//! * `p50_ms` / `loss_pct` 复用 chain-health 的口径：时延取最近
//!   [`chain_health::CURRENT_WINDOW_SECS`]（2 小时）的样本中位数，丢包取同
//!   窗口的 `forward_probe_samples` attempts/failures；拿不到就是 `null`，
//!   不补 0。多成员下一跳的探测不区分目标，同一源成员的每条出边共享该
//!   forward 的计数（与 chain-health 的段级聚合一致）；
//! * `series` 用 `chains.created_at` 派生「截至该桶末仍存在的链数 / 去重
//!   用户数」。**按当前存在的链回填**：创建即计入，删除后该链从所有历史桶
//!   消失（没有删除时间，无法保留历史）；`series_basis = "existing_chains"`
//!   显式声明这个口径。桶宽固定 [`SERIES_BUCKET_SECS`]（15 分钟），最后
//!   一个点是**当前未完成桶**（`ts` = 当前桶起点，统计到 `now`）；
//! * `strategies` 按每条链**第一跳**（`seq` 最小）的
//!   `chain_groups.strategy` 统计，一条链只计一次，所以不会因为中间跳换了
//!   策略而重复。

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Serialize;

use crate::chain_health::CURRENT_WINDOW_SECS;
use crate::chain_templates;
use crate::models::{ChainGroupWithMembers, ChainTemplate, ChainTemplateGroup, ChainWithGroups};
use crate::repo::latency::LatencySample;
use crate::telemetry::ProbeCounts;

/// 详情页增长曲线的桶宽：15 分钟。24h = 96 点，168h = 672 点。
pub const SERIES_BUCKET_SECS: i64 = 900;

/// 服务器的最小展示快照：名称 + `servers.status`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerState {
    pub name: String,
    pub status: String,
}

/// 模板级可用性状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TemplateStatus {
    /// `ok` / `degraded` / `blocked`。
    pub kind: &'static str,
    /// `member_offline` / `disabled`；其余情况为 `null`。
    pub cause: Option<&'static str>,
}

impl TemplateStatus {
    fn ok() -> Self {
        Self {
            kind: "ok",
            cause: None,
        }
    }

    fn degraded() -> Self {
        Self {
            kind: "degraded",
            cause: None,
        }
    }

    fn blocked(cause: &'static str) -> Self {
        Self {
            kind: "blocked",
            cause: Some(cause),
        }
    }
}

/// 列表里的策略分布。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StrategyStat {
    pub strategy: String,
    pub chains: i64,
}

/// 列表里的目标分布。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TargetStat {
    pub host: String,
    pub port: i64,
    pub chains: i64,
}

/// 列表的一项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TemplateListItem {
    pub id: String,
    pub name: String,
    pub hops: i64,
    pub enabled: bool,
    pub chains: i64,
    pub users: i64,
    pub status: TemplateStatus,
    pub strategies: Vec<StrategyStat>,
    pub targets: Vec<TargetStat>,
}

/// 详情里的用户引用（tooltip 只需要 id / 名称）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UserRef {
    pub id: String,
    pub name: String,
}

/// 详情里的用户分布。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UserStat {
    pub id: String,
    pub name: String,
    pub chains: i64,
}

/// 详情里的策略分布。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StrategyDetail {
    pub strategy: String,
    pub chains: i64,
    pub users: i64,
}

/// 详情里的目标明细。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TargetDetail {
    pub host: String,
    pub port: i64,
    pub chains: i64,
    pub users: Vec<UserRef>,
}

/// 节点成员。服务器成员带 `server_id` / `status`；目标成员两者都省略。
///
/// `chains` / `users` 是**真实链**在该组包含该成员的去重链 / 用户数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NodeMember {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub chains: i64,
    pub users: i64,
}

/// 详情里的一个拓扑节点：真实链出现过的每个组 + 目标。
///
/// 节点不是模板定义的展开，而是链实际走过的组；模板只提供候选（未使用的
/// 候选在 [`UnusedCandidate`] 里）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TemplateNode {
    pub seq: i64,
    /// `source` / `hop` / `target`。
    pub role: &'static str,
    pub name: String,
    pub members: Vec<NodeMember>,
}

/// 边的端点。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EdgeEndpoint {
    pub seq: i64,
    pub member: String,
}

/// 详情里的一条真实路径边。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TemplateEdge {
    /// 目标组的 `seq`；最后一跳是「最后一组 seq + 1」。
    pub seq: i64,
    pub from: EdgeEndpoint,
    pub to: EdgeEndpoint,
    pub chains: i64,
    pub users: i64,
    pub p50_ms: Option<f64>,
    pub loss_pct: Option<f64>,
}

/// 增长曲线的一个桶。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SeriesPoint {
    pub ts: i64,
    pub chains: i64,
    pub users: i64,
}

/// 没有被任何实际链用到的模板候选成员。
///
/// 模板改过之后，旧链仍按自己的成员走；新增 / 换掉的候选不会出现在
/// `nodes` 里（`nodes` 只画真实路径），单独在这里列出，前端放在「未使用」
/// 区域，避免把候选混成真实拓扑。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnusedCandidate {
    /// 模板组的 `seq`（0 起）。
    pub seq: i64,
    pub server_id: String,
    /// `servers.name`；服务器已删除时回退 id。
    pub name: String,
    /// `servers.status`；服务器已删除 / 状态缺失时是 `"unknown"`。
    pub status: String,
}

/// 详情里的模板摘要。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TemplateSummary {
    pub id: String,
    pub name: String,
    pub hops: i64,
    pub created_at: i64,
    /// 是否存在链的跳数 / 成员与模板**当前定义**不一致。
    pub stale: bool,
    /// 不一致的人可读说明（中英双语）；`stale = false` 时为 `null`。
    pub stale_reason: Option<String>,
}

/// 详情响应（不含 `generated_at`，由路由层补）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TemplateDetail {
    pub template: TemplateSummary,
    pub nodes: Vec<TemplateNode>,
    pub edges: Vec<TemplateEdge>,
    pub targets: Vec<TargetDetail>,
    pub users: Vec<UserStat>,
    pub series: Vec<SeriesPoint>,
    /// `series` 的口径：固定 `"existing_chains"`（按当前存在的链回填，
    /// 删除链会回退历史）。前端据此标注「按现有链回填」。
    pub series_basis: &'static str,
    /// 没有被任何链用到的候选成员。
    pub unused_candidates: Vec<UnusedCandidate>,
    pub strategies: Vec<StrategyDetail>,
}

type EdgeKey = (i64, String, i64, String);

#[derive(Debug, Clone, Default)]
struct Counts {
    chains: i64,
    users: HashSet<String>,
}

impl Counts {
    fn add(&mut self, owner: Option<&str>) {
        self.chains += 1;
        if let Some(owner) = owner.filter(|owner| !owner.is_empty()) {
            self.users.insert(owner.to_string());
        }
    }

    fn users(&self) -> i64 {
        self.users.len() as i64
    }
}

#[derive(Debug, Clone)]
struct PathMember {
    id: String,
    name: String,
    priority: i64,
}

#[derive(Debug, Clone)]
struct PathGroup {
    seq: i64,
    /// 真实链的组名（`chain_groups.name`）；菜单里没有名称字段，通常为 None。
    name: Option<String>,
    strategy: String,
    members: Vec<PathMember>,
}

/// 一条链在内存里的实际拓扑。只保留聚合需要的字段，避免持有原 `&` 生命周期。
#[derive(Debug, Clone)]
struct PathChain {
    id: String,
    owner: Option<String>,
    created_at: i64,
    target_host: String,
    target_port: i64,
    groups: Vec<PathGroup>,
}

impl PathChain {
    fn from_chain(chain: &ChainWithGroups) -> Self {
        let mut groups: Vec<&ChainGroupWithMembers> = chain.groups.iter().collect();
        groups.sort_by_key(|group| group.group.seq);
        let groups = groups
            .into_iter()
            .map(|group| {
                let mut members: Vec<&crate::models::ChainGroupMember> =
                    group.members.iter().collect();
                members.sort_by_key(|member| (member.priority, member.server_id.clone()));
                PathGroup {
                    seq: group.group.seq,
                    name: group
                        .group
                        .name
                        .as_deref()
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .map(str::to_string),
                    strategy: group.group.strategy.clone(),
                    members: members
                        .into_iter()
                        .map(|member| PathMember {
                            id: member.server_id.clone(),
                            name: member.server_name.clone(),
                            priority: member.priority,
                        })
                        .collect(),
                }
            })
            .collect();
        Self {
            id: chain.chain.id.clone(),
            owner: chain.chain.owner_user_id.clone(),
            created_at: chain.chain.created_at,
            target_host: chain.chain.target_host.clone(),
            target_port: chain.chain.target_port,
            groups,
        }
    }

    fn target(&self) -> String {
        format_target(&self.target_host, self.target_port)
    }

    fn first_strategy(&self) -> Option<&str> {
        self.groups
            .iter()
            .find(|group| !group.members.is_empty())
            .or_else(|| self.groups.first())
            .map(|group| group.strategy.as_str())
    }
}

/// 模板定义（已规范化）。损坏的 `groups_json` 按「没有组」处理，不把整页
/// 变成 500；这与模板列表读路径的容错口径一致。
fn shape_of(template: &ChainTemplate) -> Vec<ChainTemplateGroup> {
    chain_templates::parse_groups(&template.groups_json).unwrap_or_default()
}

fn chains_of<'a>(template_id: &str, chains: &'a [ChainWithGroups]) -> Vec<&'a ChainWithGroups> {
    chains
        .iter()
        .filter(|chain| chain.chain.template_id.as_deref() == Some(template_id))
        .collect()
}

fn paths_of(chains: &[&ChainWithGroups]) -> Vec<PathChain> {
    chains
        .iter()
        .map(|chain| PathChain::from_chain(chain))
        .collect()
}

/// 模板级状态：候选成员来自模板定义，而不是某条链的实际成员。
///
/// 与链级可用性同一口径，按**组**判断：某组的候选**全部离线**（这一跳没有
/// 在线候选）才 `blocked/member_offline`；组内还有在线候选、只是掉了部分
/// 成员 → `degraded`（容量下降）；其它非在线候选（`abnormal` / `no_data` /
/// 服务器已删除）同样只 `degraded`。
fn status_of(
    enabled: bool,
    groups: &[ChainTemplateGroup],
    servers: &HashMap<String, ServerState>,
) -> TemplateStatus {
    if !enabled {
        return TemplateStatus::blocked("disabled");
    }
    if groups
        .iter()
        .all(|group| group.server_ids.iter().all(|id| id.trim().is_empty()))
    {
        return TemplateStatus::degraded();
    }
    let mut offline = false;
    let mut non_online = false;
    let mut blocked = false;
    for group in groups {
        let mut online = 0_usize;
        let mut has_offline = false;
        for server_id in &group.server_ids {
            match servers.get(server_id) {
                Some(server) if server.status == "online" => online += 1,
                Some(server) if server.status == "offline" => {
                    has_offline = true;
                    offline = true;
                }
                // 服务器被删除 / 状态缺失 / abnormal / no_data 都算「非在线」，
                // 但没被确认离线，只降级不阻断。
                _ => non_online = true,
            }
        }
        if online == 0 && has_offline {
            blocked = true;
        }
    }
    if blocked {
        TemplateStatus::blocked("member_offline")
    } else if offline || non_online {
        TemplateStatus::degraded()
    } else {
        TemplateStatus::ok()
    }
}

/// 列表聚合。
pub fn list(
    templates: &[ChainTemplate],
    chains: &[ChainWithGroups],
    servers: &HashMap<String, ServerState>,
) -> Vec<TemplateListItem> {
    let mut items = Vec::with_capacity(templates.len());
    for template in templates {
        let groups = shape_of(template);
        let relevant = chains_of(&template.id, chains);
        let mut target_counts: HashMap<String, i64> = HashMap::new();
        let mut strategy_counts: HashMap<String, Counts> = HashMap::new();
        let mut users: HashSet<String> = HashSet::new();
        let mut chain_count = 0_i64;
        for chain in &relevant {
            chain_count += 1;
            if let Some(owner) = chain
                .chain
                .owner_user_id
                .as_deref()
                .filter(|owner| !owner.is_empty())
            {
                users.insert(owner.to_string());
            }
            *target_counts
                .entry(format_target(
                    &chain.chain.target_host,
                    chain.chain.target_port,
                ))
                .or_default() += 1;
            if let Some(strategy) = PathChain::from_chain(chain)
                .first_strategy()
                .map(str::to_string)
            {
                strategy_counts.entry(strategy).or_default().add(
                    chain
                        .chain
                        .owner_user_id
                        .as_deref()
                        .filter(|owner| !owner.is_empty()),
                );
            }
        }

        let mut strategies: Vec<StrategyStat> = strategy_counts
            .into_iter()
            .map(|(strategy, counts)| StrategyStat {
                strategy,
                chains: counts.chains,
            })
            .collect();
        strategies.sort_by(|a, b| {
            b.chains
                .cmp(&a.chains)
                .then_with(|| a.strategy.cmp(&b.strategy))
        });

        let mut targets: Vec<TargetStat> = target_counts
            .into_iter()
            .map(|(target, chains)| {
                let (host, port) = split_target(&target);
                TargetStat { host, port, chains }
            })
            .collect();
        targets.sort_by(|a, b| {
            b.chains
                .cmp(&a.chains)
                .then_with(|| a.host.cmp(&b.host))
                .then_with(|| a.port.cmp(&b.port))
        });

        items.push(TemplateListItem {
            id: template.id.clone(),
            name: template.name.clone(),
            hops: groups.len() as i64,
            enabled: template.enabled,
            chains: chain_count,
            users: users.len() as i64,
            status: status_of(template.enabled, &groups, servers),
            strategies,
            targets,
        });
    }
    items.sort_by(|a, b| {
        b.chains
            .cmp(&a.chains)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });
    items
}

/// 详情页边值需要的两批数据：当前 2h 的时延样本与同一窗口的探测总数。
///
/// 与本模板无关的行会被忽略。
pub struct EdgeData<'a> {
    pub samples: &'a [LatencySample],
    pub probes: &'a HashMap<String, ProbeCounts>,
}

/// 详情聚合。
pub fn detail(
    template: &ChainTemplate,
    chains: &[ChainWithGroups],
    servers: &HashMap<String, ServerState>,
    user_names: &HashMap<String, String>,
    edges_data: EdgeData<'_>,
    now: i64,
    hours: i64,
) -> TemplateDetail {
    let samples = edges_data.samples;
    let probes = edges_data.probes;
    let groups = shape_of(template);
    let paths = paths_of(&chains_of(&template.id, chains));
    let hops = groups.len() as i64;

    // ---- 实际拓扑：nodes 只来自真实链的 groups；模板只提供候选清单 ----
    //
    // 计数键是**真实组的 seq**（`chain_groups.seq`），不是模板的 seq：模板
    // 改过跳数后，旧链的 seq 与模板不再一一对应，用模板 seq 做键会让计数
    // 大面积归零、节点成员错位。
    let mut member_counts: HashMap<(i64, String), Counts> = HashMap::new();
    let mut member_priority: HashMap<(i64, String), i64> = HashMap::new();
    let mut member_names: HashMap<(i64, String), String> = HashMap::new();
    let mut group_names: HashMap<i64, String> = HashMap::new();
    // 真实出现过的组 seq；节点按它升序排列。
    let mut levels: BTreeSet<i64> = BTreeSet::new();
    // 被任意链用到过的 server id：`unused_candidates` 用它排除候选。
    let mut used_servers: HashSet<String> = HashSet::new();
    let mut target_counts: HashMap<String, Counts> = HashMap::new();
    let mut first_strategy_counts: HashMap<String, Counts> = HashMap::new();
    let mut user_counts: HashMap<String, i64> = HashMap::new();

    for path in &paths {
        let owner = path.owner.as_deref().filter(|owner| !owner.is_empty());
        if let Some(owner) = owner {
            *user_counts.entry(owner.to_string()).or_default() += 1;
        }
        if let Some(strategy) = path.first_strategy() {
            first_strategy_counts
                .entry(strategy.to_string())
                .or_default()
                .add(owner);
        }
        for group in &path.groups {
            levels.insert(group.seq);
            if let Some(name) = group.name.as_deref() {
                group_names
                    .entry(group.seq)
                    .or_insert_with(|| name.to_string());
            }
            for member in &group.members {
                let key = (group.seq, member.id.clone());
                member_counts.entry(key.clone()).or_default().add(owner);
                // 同一成员在真实链里只有一个 priority / 名称；取第一次遇到的。
                member_priority
                    .entry(key.clone())
                    .or_insert(member.priority);
                member_names.entry(key).or_insert(member.name.clone());
                used_servers.insert(member.id.clone());
            }
        }
        target_counts.entry(path.target()).or_default().add(owner);
    }

    let mut nodes: Vec<TemplateNode> = Vec::with_capacity(levels.len() + 1);
    for (index, seq) in levels.iter().copied().enumerate() {
        let mut members: Vec<(i64, String, NodeMember)> = member_counts
            .iter()
            .filter(|((level, _), _)| *level == seq)
            .map(|((level, server_id), counts)| {
                let state = servers.get(server_id);
                let name = state
                    .map(|state| state.name.clone())
                    .or_else(|| member_names.get(&(*level, server_id.clone())).cloned())
                    .unwrap_or_else(|| server_id.clone());
                let status = state
                    .map(|state| state.status.clone())
                    .unwrap_or_else(|| "unknown".to_string());
                (
                    member_priority
                        .get(&(*level, server_id.clone()))
                        .copied()
                        .unwrap_or(0),
                    server_id.clone(),
                    NodeMember {
                        server_id: Some(server_id.clone()),
                        name,
                        status: Some(status),
                        chains: counts.chains,
                        users: counts.users(),
                    },
                )
            })
            .collect();
        // 与 chain-health / derive_forwards 同一顺序：`(priority, server_id)`。
        members.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        nodes.push(TemplateNode {
            seq,
            role: if index == 0 { "source" } else { "hop" },
            name: group_names
                .get(&seq)
                .cloned()
                .unwrap_or_else(|| node_name(index)),
            members: members.into_iter().map(|(_, _, member)| member).collect(),
        });
    }
    // 目标节点：seq = 真实最后一组 seq + 1（没有链就没有目标节点）。
    let target_seq = levels.iter().next_back().map(|seq| seq + 1);
    if let Some(seq) = target_seq {
        let mut target_members: Vec<NodeMember> = target_counts
            .iter()
            .map(|(target, counts)| NodeMember {
                server_id: None,
                name: target.clone(),
                status: None,
                chains: counts.chains,
                users: counts.users(),
            })
            .collect();
        target_members.sort_by(|a, b| b.chains.cmp(&a.chains).then_with(|| a.name.cmp(&b.name)));
        nodes.push(TemplateNode {
            seq,
            role: "target",
            name: "目标".to_string(),
            members: target_members,
        });
    }

    // ---- stale：链的跳数 / 成员是否仍与模板当前定义一致 ----
    //
    // 候选成员是「菜单」，链选中其中一部分是正常的；只有链里出现模板
    // 候选之外的成员、或跳数不同，才算模板改过之后链没有跟上。
    let mut actual_hops: BTreeSet<i64> = BTreeSet::new();
    let mut member_mismatch_seqs: BTreeSet<i64> = BTreeSet::new();
    for path in &paths {
        let hops = path.groups.len() as i64;
        if hops != hops_of_template(&groups) {
            actual_hops.insert(hops);
        }
        for (index, group) in path.groups.iter().enumerate() {
            match groups.get(index) {
                Some(template_group) => {
                    let candidates: HashSet<&str> = template_group
                        .server_ids
                        .iter()
                        .map(|id| id.trim())
                        .collect();
                    if group
                        .members
                        .iter()
                        .any(|member| !candidates.contains(member.id.as_str()))
                    {
                        member_mismatch_seqs.insert(group.seq);
                    }
                }
                None => {
                    member_mismatch_seqs.insert(group.seq);
                }
            }
        }
    }
    let stale = !actual_hops.is_empty() || !member_mismatch_seqs.is_empty();
    let stale_reason = stale.then(|| {
        stale_text(
            &actual_hops,
            &member_mismatch_seqs,
            hops_of_template(&groups),
        )
    });

    // ---- unused_candidates：模板候选里没有被任何链用到的成员 ----
    let mut unused_candidates: Vec<UnusedCandidate> = Vec::new();
    let mut seen_candidates: HashSet<String> = HashSet::new();
    for group in &groups {
        for server_id in &group.server_ids {
            let id = server_id.trim();
            if id.is_empty() || !seen_candidates.insert(id.to_string()) {
                continue;
            }
            if used_servers.contains(id) {
                continue;
            }
            let state = servers.get(id);
            unused_candidates.push(UnusedCandidate {
                seq: group.seq,
                server_id: id.to_string(),
                name: state
                    .map(|state| state.name.clone())
                    .unwrap_or_else(|| id.to_string()),
                status: state
                    .map(|state| state.status.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
            });
        }
    }
    unused_candidates.sort_by(|a, b| {
        a.seq
            .cmp(&b.seq)
            .then_with(|| a.server_id.cmp(&b.server_id))
    });

    // ---- edges：真实链的 group 成员对 + 最后一跳到目标 ----
    let mut edge_counts: HashMap<EdgeKey, Counts> = HashMap::new();
    for path in &paths {
        let owner = path.owner.as_deref().filter(|owner| !owner.is_empty());
        for (index, group) in path.groups.iter().enumerate() {
            if let Some(next) = path.groups.get(index + 1) {
                for from in &group.members {
                    for to in &next.members {
                        edge_counts
                            .entry((group.seq, from.id.clone(), next.seq, to.id.clone()))
                            .or_default()
                            .add(owner);
                    }
                }
            } else {
                let target = path.target();
                for from in &group.members {
                    edge_counts
                        .entry((group.seq, from.id.clone(), group.seq + 1, target.clone()))
                        .or_default()
                        .add(owner);
                }
            }
        }
    }

    let edge_start = now - CURRENT_WINDOW_SECS;
    let mut forward_map: HashMap<String, (usize, usize, usize)> = HashMap::new();
    for (chain_index, path) in paths.iter().enumerate() {
        for (group_index, group) in path.groups.iter().enumerate() {
            for (member_index, member) in group.members.iter().enumerate() {
                forward_map
                    .entry(crate::chains::forward_id(
                        &path.id,
                        group.seq,
                        &member.id,
                        group.members.len(),
                    ))
                    .or_insert((chain_index, group_index, member_index));
            }
        }
    }

    let mut edge_values: HashMap<EdgeKey, Vec<f64>> = HashMap::new();
    for sample in samples {
        if sample.ts < edge_start || sample.ts > now {
            continue;
        }
        let Some(&(chain_index, group_index, member_index)) = forward_map.get(&sample.forward_id)
        else {
            continue;
        };
        let Some(path) = paths.get(chain_index) else {
            continue;
        };
        let Some(group) = path.groups.get(group_index) else {
            continue;
        };
        let Some(from) = group.members.get(member_index) else {
            continue;
        };
        let is_final = group_index + 1 == path.groups.len();
        let key = if is_final {
            if !sample.target_server_id.is_empty() {
                // 最后一跳的 forward 目标是链目标，带非空目标说明是历史残留。
                continue;
            }
            (group.seq, from.id.clone(), group.seq + 1, path.target())
        } else {
            let next = &path.groups[group_index + 1];
            let target_id = if sample.target_server_id.is_empty() {
                if next.members.len() == 1 {
                    next.members[0].id.clone()
                } else {
                    // 多成员下一跳却上报空目标，无法判断走了哪条路。
                    continue;
                }
            } else {
                sample.target_server_id.clone()
            };
            if !next.members.iter().any(|member| member.id == target_id) {
                continue;
            }
            (group.seq, from.id.clone(), next.seq, target_id)
        };
        if edge_counts.contains_key(&key) {
            edge_values
                .entry(key)
                .or_default()
                .push(sample.latency_ms as f64);
        }
    }

    // 探测计数按 forward 聚合。多成员下一跳的探测不区分目标，同一源成员的
    // 每条出边共享这份计数（与 chain-health 段级口径一致）。
    let mut outbound: HashMap<(i64, String), Vec<EdgeKey>> = HashMap::new();
    for key in edge_counts.keys() {
        outbound
            .entry((key.0, key.1.clone()))
            .or_default()
            .push(key.clone());
    }
    let mut edge_probes: HashMap<EdgeKey, ProbeCounts> = HashMap::new();
    for (forward_id, counts) in probes {
        if counts.attempts <= 0 {
            continue;
        }
        let Some(&(chain_index, group_index, member_index)) = forward_map.get(forward_id) else {
            continue;
        };
        let Some(path) = paths.get(chain_index) else {
            continue;
        };
        let Some(group) = path.groups.get(group_index) else {
            continue;
        };
        let Some(from) = group.members.get(member_index) else {
            continue;
        };
        let is_final = group_index + 1 == path.groups.len();
        let keys: Vec<EdgeKey> = if is_final {
            vec![(group.seq, from.id.clone(), group.seq + 1, path.target())]
        } else {
            let next = &path.groups[group_index + 1];
            if next.members.len() == 1 {
                vec![(
                    group.seq,
                    from.id.clone(),
                    next.seq,
                    next.members[0].id.clone(),
                )]
            } else {
                outbound
                    .get(&(group.seq, from.id.clone()))
                    .cloned()
                    .unwrap_or_default()
            }
        };
        for key in keys {
            if !edge_counts.contains_key(&key) {
                continue;
            }
            let entry = edge_probes.entry(key).or_default();
            entry.attempts = entry.attempts.saturating_add(counts.attempts);
            entry.failures = entry.failures.saturating_add(counts.failures);
        }
    }

    let from_names: HashMap<(i64, String), String> = paths
        .iter()
        .flat_map(|path| path.groups.iter())
        .flat_map(|group| {
            group
                .members
                .iter()
                .map(move |member| ((group.seq, member.id.clone()), member.name.clone()))
        })
        .collect();
    let mut edges: Vec<TemplateEdge> = edge_counts
        .into_iter()
        .map(|(key, counts)| {
            let (from_seq, from_id, to_seq, to_id) = key.clone();
            let values = edge_values.get(&key);
            let p50 = values.and_then(|values| median(values)).map(round1);
            let probe = edge_probes.get(&key).copied().unwrap_or_default();
            let loss_pct = (probe.attempts > 0).then(|| {
                round4(
                    (probe.failures.max(0) as f64 / probe.attempts as f64).clamp(0.0, 1.0) * 100.0,
                )
            });
            TemplateEdge {
                seq: to_seq,
                from: EdgeEndpoint {
                    seq: from_seq,
                    member: from_names
                        .get(&(from_seq, from_id))
                        .cloned()
                        .unwrap_or_default(),
                },
                to: EdgeEndpoint {
                    seq: to_seq,
                    member: from_names
                        .get(&(to_seq, to_id.clone()))
                        .cloned()
                        .unwrap_or(to_id),
                },
                chains: counts.chains,
                users: counts.users(),
                p50_ms: p50,
                loss_pct,
            }
        })
        .collect();
    edges.sort_by(|a, b| {
        a.seq
            .cmp(&b.seq)
            .then_with(|| b.chains.cmp(&a.chains))
            .then_with(|| a.from.member.cmp(&b.from.member))
            .then_with(|| a.to.member.cmp(&b.to.member))
    });

    // ---- targets / users / strategies ----
    let mut targets: Vec<TargetDetail> = target_counts
        .iter()
        .map(|(target, counts)| {
            let (host, port) = split_target(target);
            let mut users: Vec<UserRef> = counts
                .users
                .iter()
                .map(|id| UserRef {
                    id: id.clone(),
                    name: user_names.get(id).cloned().unwrap_or_else(|| id.clone()),
                })
                .collect();
            users.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
            TargetDetail {
                host,
                port,
                chains: counts.chains,
                users,
            }
        })
        .collect();
    targets.sort_by(|a, b| {
        b.chains
            .cmp(&a.chains)
            .then_with(|| a.host.cmp(&b.host))
            .then_with(|| a.port.cmp(&b.port))
    });

    let mut users: Vec<UserStat> = user_counts
        .into_iter()
        .map(|(id, chains)| UserStat {
            name: user_names.get(&id).cloned().unwrap_or_else(|| id.clone()),
            id,
            chains,
        })
        .collect();
    users.sort_by(|a, b| b.chains.cmp(&a.chains).then_with(|| a.name.cmp(&b.name)));

    let mut strategies: Vec<StrategyDetail> = first_strategy_counts
        .into_iter()
        .map(|(strategy, counts)| StrategyDetail {
            strategy,
            chains: counts.chains,
            users: counts.users(),
        })
        .collect();
    strategies.sort_by(|a, b| {
        b.chains
            .cmp(&a.chains)
            .then_with(|| a.strategy.cmp(&b.strategy))
    });

    TemplateDetail {
        template: TemplateSummary {
            id: template.id.clone(),
            name: template.name.clone(),
            hops,
            created_at: template.created_at,
            stale,
            stale_reason,
        },
        nodes,
        edges,
        targets,
        users,
        series: series(&paths, now, hours),
        series_basis: "existing_chains",
        unused_candidates,
        strategies,
    }
}

/// 截至每个桶末的累计链数 / 去重用户数。
///
/// 用 `created_at` 派生，**按当前存在的链回填**：删除链后它从所有历史桶
/// 消失（没有删除时间可用），`series_basis: "existing_chains"` 就是这个
/// 口径的声明。桶宽固定 15 分钟；最后一个点是**当前未完成桶**：`ts` 是
/// 当前桶起点、统计到 `now`，与 chain-health 的最后一个桶语义一致。
/// 窗口内没有创建时仍补齐 0 值，不返回空数组。
fn series(paths: &[PathChain], now: i64, hours: i64) -> Vec<SeriesPoint> {
    let count = (hours.max(1) * 3600 / SERIES_BUCKET_SECS).max(1);
    // 当前未完成桶的起点（向下对齐 15 分钟）。
    let end = now - now.rem_euclid(SERIES_BUCKET_SECS);
    // 最后一个点就是当前桶，所以数组从 end 往前铺 count-1 个完整桶。
    let start = end - (count - 1) * SERIES_BUCKET_SECS;
    let mut points = Vec::with_capacity(count as usize);
    for index in 0..count {
        let ts = start + index * SERIES_BUCKET_SECS;
        let bucket_end = if index + 1 == count {
            now + 1
        } else {
            ts + SERIES_BUCKET_SECS
        };
        let mut chains = 0_i64;
        let mut users: HashSet<&str> = HashSet::new();
        for path in paths {
            if path.created_at <= now && path.created_at < bucket_end {
                chains += 1;
                if let Some(owner) = path.owner.as_deref().filter(|owner| !owner.is_empty()) {
                    users.insert(owner);
                }
            }
        }
        points.push(SeriesPoint {
            ts,
            chains,
            users: users.len() as i64,
        });
    }
    points
}

fn node_name(index: usize) -> String {
    if index == 0 {
        "入口".to_string()
    } else {
        format!("第 {} 跳", index + 1)
    }
}

/// 模板定义里的跳数；只用于和真实链比较，不做任何归一。
fn hops_of_template(groups: &[ChainTemplateGroup]) -> i64 {
    groups.len() as i64
}

/// `template.stale_reason` 的中英双语说明。
///
/// `actual_hops` 是和模板跳数不同的真实跳数集合（升序去重）；
/// `member_mismatch_seqs` 是「链里有成员不在模板当前候选里」的真实组 seq
/// （升序去重）。调用方只在至少一项非空时调用。
fn stale_text(
    actual_hops: &BTreeSet<i64>,
    member_mismatch_seqs: &BTreeSet<i64>,
    template_hops: i64,
) -> String {
    let hops = actual_hops
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(" / ");
    let seqs = member_mismatch_seqs
        .iter()
        .map(|seq| (seq + 1).to_string())
        .collect::<Vec<_>>()
        .join(", ");
    match (actual_hops.is_empty(), member_mismatch_seqs.is_empty()) {
        (false, false) => format!(
            "链的跳数（{hops}）与模板（{template_hops}）不一致，且第 {seqs} 跳有成员不在模板当前候选中 / chain hop count ({hops}) differs from the template ({template_hops}), and hop {seqs} contains members outside the template candidates"
        ),
        (false, true) => format!(
            "链的跳数（{hops}）与模板（{template_hops}）不一致 / chain hop count ({hops}) differs from the template ({template_hops})"
        ),
        (true, false) => format!(
            "第 {seqs} 跳的成员不在模板当前候选中 / hop {seqs} contains members outside the template candidates"
        ),
        (true, true) => String::new(),
    }
}

fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let rank = 0.5 * (sorted.len() - 1) as f64;
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    if lower == upper {
        Some(sorted[lower])
    } else {
        Some(sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower as f64))
    }
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

/// `host:port`；IPv6（两个及以上冒号）补方括号，与链视图的展示格式一致。
fn format_target(host: &str, port: i64) -> String {
    let host = host.trim();
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// 从 `host:port` 里拆回主机/端口；只用于列表 targets 的展示字段。
fn split_target(target: &str) -> (String, i64) {
    match target.rsplit_once(':') {
        Some((host, port)) => (
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .to_string(),
            port.parse().unwrap_or(0),
        ),
        None => (target.to_string(), 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::models::{Chain, ChainGroup, ChainGroupMember};

    fn server(name: &str, status: &str) -> ServerState {
        ServerState {
            name: name.into(),
            status: status.into(),
        }
    }

    fn template(id: &str, name: &str, enabled: bool, groups: &[(&str, &[&str])]) -> ChainTemplate {
        let groups: Vec<ChainTemplateGroup> = groups
            .iter()
            .enumerate()
            .map(|(seq, (strategy, server_ids))| ChainTemplateGroup {
                seq: seq as i64,
                strategy: (*strategy).into(),
                server_ids: server_ids.iter().map(|id| (*id).to_string()).collect(),
            })
            .collect();
        ChainTemplate {
            id: id.into(),
            name: name.into(),
            engine: "native".into(),
            security: "tls".into(),
            transport: "none".into(),
            protocol: "tcp".into(),
            groups_json: serde_json::to_string(&groups).unwrap(),
            enabled,
            created_at: 1_700_000_000,
        }
    }

    fn chain(
        id: &str,
        template_id: Option<&str>,
        owner: Option<&str>,
        target: (&str, i64),
        created_at: i64,
        groups: &[&[&str]],
    ) -> ChainWithGroups {
        let groups = groups
            .iter()
            .enumerate()
            .map(|(seq, members)| ChainGroupWithMembers {
                group: ChainGroup {
                    id: format!("g-{id}-{seq}"),
                    chain_id: id.into(),
                    seq: seq as i64,
                    name: None,
                    strategy: "round_robin".into(),
                    cert_id: None,
                    public_port: None,
                    use_internal_address: false,
                },
                members: members
                    .iter()
                    .enumerate()
                    .map(|(priority, server_id)| ChainGroupMember {
                        group_id: format!("g-{id}-{seq}"),
                        chain_id: id.into(),
                        seq: seq as i64,
                        strategy: "round_robin".into(),
                        server_id: (*server_id).into(),
                        server_name: format!("name-{server_id}"),
                        server_status: "online".into(),
                        server_address: "10.0.0.1".into(),
                        server_internal_address: None,
                        listen_port: 20_000 + priority as i64,
                        priority: priority as i64,
                        weight: 1,
                        realm_transport: None,
                        nftables_available: None,
                        tunnel_available: None,
                        server_protocol_version: None,
                        last_seen_at: None,
                    })
                    .collect(),
            })
            .collect();
        ChainWithGroups {
            chain: Chain {
                id: id.into(),
                name: format!("chain-{id}"),
                target_host: target.0.into(),
                target_port: target.1,
                enabled: true,
                engine: "native".into(),
                udp: false,
                protocol: "tcp".into(),
                proxy_protocol: false,
                transport: "none".into(),
                tunnel_security: "tls".into(),
                template_id: template_id.map(str::to_string),
                owner_user_id: owner.map(str::to_string),
                created_at,
                updated_at: created_at,
            },
            groups,
        }
    }

    fn servers() -> HashMap<String, ServerState> {
        HashMap::from([
            ("s1".to_string(), server("香港-01", "online")),
            ("s2".to_string(), server("东京-01", "online")),
            ("s3".to_string(), server("大阪-01", "offline")),
        ])
    }

    #[test]
    fn list_counts_chains_and_dedups_users_without_admins() {
        let tpl = template(
            "t1",
            "港日双路",
            true,
            &[("ip_hashed", &["s1"]), ("round_robin", &["s2"])],
        );
        let chains = vec![
            chain(
                "c1",
                Some("t1"),
                None,
                ("1.1.1.1", 443),
                100,
                &[&["s1"], &["s2"]],
            ),
            chain(
                "c2",
                Some("t1"),
                Some("u1"),
                ("1.1.1.1", 443),
                200,
                &[&["s1"], &["s2"]],
            ),
            chain(
                "c3",
                Some("t1"),
                Some("u1"),
                ("2.2.2.2", 8443),
                300,
                &[&["s1"], &["s2"]],
            ),
            chain(
                "c4",
                Some("t1"),
                Some("u2"),
                ("2.2.2.2", 8443),
                400,
                &[&["s1"], &["s2"]],
            ),
            // 别的模板不能串进统计。
            chain(
                "c5",
                Some("t2"),
                Some("u3"),
                ("3.3.3.3", 443),
                500,
                &[&["s1"]],
            ),
        ];
        let items = list(&[tpl], &chains, &servers());
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.chains, 4);
        assert_eq!(item.users, 2, "管理员链没有 owner，不计入 users");
        assert_eq!(item.hops, 2);
        assert_eq!(item.status, TemplateStatus::ok());
        assert_eq!(
            item.strategies,
            vec![StrategyStat {
                strategy: "round_robin".into(),
                chains: 4
            }]
        );
        assert_eq!(
            item.targets,
            vec![
                TargetStat {
                    host: "1.1.1.1".into(),
                    port: 443,
                    chains: 2
                },
                TargetStat {
                    host: "2.2.2.2".into(),
                    port: 8443,
                    chains: 2
                },
            ]
        );
    }

    #[test]
    fn status_covers_disabled_offline_partial_and_empty_templates() {
        let servers = servers();
        let partial = template(
            "t1",
            "部分离线",
            true,
            &[("round_robin", &["s1"]), ("round_robin", &["s3"])],
        );
        assert_eq!(
            status_of(true, &shape_of(&partial), &servers),
            TemplateStatus::blocked("member_offline")
        );

        let disabled = template("t2", "停用", false, &[("round_robin", &["s1"])]);
        assert_eq!(
            status_of(false, &shape_of(&disabled), &servers),
            TemplateStatus::blocked("disabled")
        );

        let empty = template("t3", "无成员", true, &[]);
        assert_eq!(
            status_of(true, &shape_of(&empty), &servers),
            TemplateStatus::degraded()
        );

        let missing = template("t4", "服务器已删", true, &[("round_robin", &["gone"])]);
        assert_eq!(
            status_of(true, &shape_of(&missing), &servers),
            TemplateStatus::degraded(),
            "服务器不存在算非在线，不能报 ok"
        );

        let all_offline = template(
            "t5",
            "全离线",
            true,
            &[("round_robin", &["s3"]), ("round_robin", &["gone"])],
        );
        assert_eq!(
            status_of(true, &shape_of(&all_offline), &servers),
            TemplateStatus::blocked("member_offline")
        );
    }

    /// 组内仍有一台在线候选时只降级；整组候选全部离线才阻断。
    #[test]
    fn a_group_with_all_candidates_offline_blocks_the_template() {
        let servers = HashMap::from([
            ("s1".to_string(), server("香港-01", "online")),
            ("s2".to_string(), server("东京-01", "online")),
            ("s3".to_string(), server("东京-02", "offline")),
            ("s4".to_string(), server("大阪-01", "offline")),
        ]);

        // 同一组 [online, offline]：还有在线成员 → degraded。
        let partial_group = template(
            "t1",
            "组内部分离线",
            true,
            &[("round_robin", &["s1"]), ("round_robin", &["s2", "s3"])],
        );
        assert_eq!(
            status_of(true, &shape_of(&partial_group), &servers),
            TemplateStatus::degraded(),
            "组内还有在线候选，不能阻断整个模板"
        );

        // 入口组也是同一规则：组内有在线成员就不阻断。
        let partial_entry = template(
            "t2",
            "入口部分离线",
            true,
            &[("round_robin", &["s1", "s3"]), ("round_robin", &["s2"])],
        );
        assert_eq!(
            status_of(true, &shape_of(&partial_entry), &servers),
            TemplateStatus::degraded()
        );

        // 同一组两台全离线：这一跳没有在线候选 → blocked。
        let all_offline_group = template(
            "t3",
            "组内全离线",
            true,
            &[("round_robin", &["s1"]), ("round_robin", &["s3", "s4"])],
        );
        assert_eq!(
            status_of(true, &shape_of(&all_offline_group), &servers),
            TemplateStatus::blocked("member_offline")
        );
    }

    #[test]
    fn list_sorts_by_chains_desc_then_name() {
        let templates = vec![
            template("a", "Beta", true, &[("round_robin", &["s1"])]),
            template("b", "Alpha", true, &[("round_robin", &["s1"])]),
            template("c", "Gamma", true, &[("round_robin", &["s1"])]),
        ];
        let chains = vec![
            chain("c1", Some("a"), Some("u1"), ("1.1.1.1", 443), 1, &[&["s1"]]),
            chain("c2", Some("b"), Some("u2"), ("1.1.1.1", 443), 2, &[&["s1"]]),
            chain("c3", Some("b"), Some("u2"), ("1.1.1.1", 443), 3, &[&["s1"]]),
        ];
        let items = list(&templates, &chains, &servers());
        let order: Vec<&str> = items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(order, vec!["Alpha", "Beta", "Gamma"]);
    }

    #[test]
    fn detail_lists_all_template_candidates_and_dedups_users() {
        let tpl = template(
            "t1",
            "港日双路",
            true,
            &[("ip_hashed", &["s1", "s2"]), ("round_robin", &["s3"])],
        );
        let chains = vec![
            chain(
                "c1",
                Some("t1"),
                None,
                ("1.1.1.1", 443),
                100,
                &[&["s1"], &["s3"]],
            ),
            chain(
                "c2",
                Some("t1"),
                Some("u1"),
                ("1.1.1.1", 443),
                200,
                &[&["s1"], &["s3"]],
            ),
            chain(
                "c3",
                Some("t1"),
                Some("u1"),
                ("2.2.2.2", 8443),
                300,
                &[&["s2"], &["s3"]],
            ),
            chain(
                "c4",
                Some("t1"),
                Some("u2"),
                ("2.2.2.2", 8443),
                400,
                &[&["s2"], &["s3"]],
            ),
        ];
        let names = HashMap::from([
            ("u1".to_string(), "demo".to_string()),
            ("u2".to_string(), "alice".to_string()),
        ]);
        let detail = detail(
            &tpl,
            &chains,
            &servers(),
            &names,
            EdgeData {
                samples: &[],
                probes: &HashMap::new(),
            },
            1_800_000_000,
            24,
        );
        assert_eq!(detail.nodes.len(), 3);
        assert_eq!(detail.nodes[0].role, "source");
        assert_eq!(detail.nodes[0].members.len(), 2);
        assert_eq!(detail.nodes[0].members[0].name, "香港-01");
        assert_eq!(detail.nodes[0].members[0].chains, 2);
        assert_eq!(detail.nodes[0].members[0].users, 1);
        assert_eq!(detail.nodes[0].members[1].chains, 2);
        assert_eq!(detail.nodes[0].members[1].users, 2);
        assert_eq!(detail.nodes[1].seq, 1);
        assert_eq!(detail.nodes[2].role, "target");
        assert_eq!(detail.nodes[2].seq, 2);
        assert_eq!(detail.nodes[2].members.len(), 2);

        assert_eq!(detail.users.len(), 2);
        assert_eq!(detail.users[0].name, "demo");
        assert_eq!(detail.users[0].chains, 2);
        assert_eq!(detail.users[1].name, "alice");
        assert_eq!(detail.users[1].chains, 1);
        assert_eq!(detail.targets[0].chains, 2);
        assert_eq!(detail.targets[0].users.len(), 1);

        // 边：s1→s3 2 条（管理员 + u1，用户 1）；s2→s3 2 条（u1 + u2，用户 2）。
        let edge = detail
            .edges
            .iter()
            .find(|edge| edge.seq == 1 && edge.from.member == "name-s1")
            .unwrap();
        assert_eq!(edge.chains, 2);
        assert_eq!(edge.users, 1);
        assert_eq!(edge.p50_ms, None);
        assert_eq!(edge.loss_pct, None);
        // 最后一跳：s3 → 1.1.1.1:443 / 2.2.2.2:8443。
        assert!(detail
            .edges
            .iter()
            .any(|edge| edge.seq == 2 && edge.to.member == "1.1.1.1:443"));
        assert!(detail
            .edges
            .iter()
            .any(|edge| edge.seq == 2 && edge.to.member == "2.2.2.2:8443"));
        assert!(detail.edges.iter().all(|edge| edge.to.seq >= 1));
    }

    #[test]
    fn detail_merges_edge_samples_and_probes() {
        let tpl = template("t1", "单跳", true, &[("round_robin", &["s1"])]);
        let chains = vec![
            chain(
                "c1",
                Some("t1"),
                Some("u1"),
                ("1.1.1.1", 443),
                100,
                &[&["s1"]],
            ),
            chain(
                "c2",
                Some("t1"),
                Some("u2"),
                ("1.1.1.1", 443),
                200,
                &[&["s1"]],
            ),
        ];
        let now = 1_800_000_000;
        let samples: Vec<LatencySample> = ["c1", "c2"]
            .iter()
            .enumerate()
            .map(|(index, id)| LatencySample {
                ts: now - 30,
                server_id: "s1".into(),
                forward_id: crate::chains::forward_id(id, 0, "s1", 1),
                target_server_id: String::new(),
                latency_ms: 10 + index as i64 * 10,
            })
            .collect();
        let probes: HashMap<String, ProbeCounts> = [
            (
                crate::chains::forward_id("c1", 0, "s1", 1),
                ProbeCounts {
                    attempts: 100,
                    failures: 1,
                },
            ),
            (
                crate::chains::forward_id("c2", 0, "s1", 1),
                ProbeCounts {
                    attempts: 100,
                    failures: 1,
                },
            ),
        ]
        .into_iter()
        .collect();
        let detail = detail(
            &tpl,
            &chains,
            &servers(),
            &HashMap::new(),
            EdgeData {
                samples: &samples,
                probes: &probes,
            },
            now,
            24,
        );
        assert_eq!(detail.edges.len(), 1);
        let edge = &detail.edges[0];
        assert_eq!(edge.seq, 1);
        assert_eq!(edge.chains, 2);
        assert_eq!(edge.users, 2);
        assert_eq!(edge.p50_ms, Some(15.0));
        assert_eq!(edge.loss_pct, Some(1.0));
    }

    #[test]
    fn series_is_cumulative_and_pads_zero_buckets() {
        let paths = vec![PathChain {
            id: "c1".into(),
            owner: Some("u1".into()),
            created_at: 1_800_000_000 - 3 * 3600,
            target_host: "1.1.1.1".into(),
            target_port: 443,
            groups: Vec::new(),
        }];
        let now = 1_800_000_000;
        let points = series(&paths, now, 24);
        assert_eq!(points.len(), 96);
        let last = points.last().unwrap();
        assert_eq!(last.chains, 1);
        assert_eq!(last.users, 1);
        // 前 21 个桶（3 小时前创建）是 0。
        assert_eq!(points[0].chains, 0);
        assert_eq!(points[0].users, 0);
        assert!(points.iter().filter(|point| point.chains == 0).count() >= 80);

        let empty = series(&[], now, 24);
        assert_eq!(empty.len(), 96);
        assert!(empty
            .iter()
            .all(|point| point.chains == 0 && point.users == 0));
        assert_eq!(series(&[], now, 168).len(), 672);
    }

    #[test]
    fn target_format_brackets_ipv6() {
        assert_eq!(format_target("1.2.3.4", 443), "1.2.3.4:443");
        assert_eq!(format_target("2001:db8::1", 443), "[2001:db8::1]:443");
        assert_eq!(split_target("1.2.3.4:443"), ("1.2.3.4".into(), 443));
        assert_eq!(
            split_target("[2001:db8::1]:443"),
            ("2001:db8::1".into(), 443)
        );
    }

    fn detail_now(template: &ChainTemplate, chains: &[ChainWithGroups]) -> TemplateDetail {
        detail(
            template,
            chains,
            &servers(),
            &HashMap::new(),
            EdgeData {
                samples: &[],
                probes: &HashMap::new(),
            },
            1_800_000_000,
            24,
        )
    }

    /// B3：模板从 2 跳改成 1 跳后，详情仍按真实链画 2 跳；`stale` 为 true，
    /// 计数键跟真实组 seq，不会因为模板少了第 2 组而大面积归零。
    #[test]
    fn an_edited_template_keeps_the_real_two_hop_topology() {
        let chains = vec![
            chain(
                "c1",
                Some("t1"),
                Some("u1"),
                ("1.1.1.1", 443),
                100,
                &[&["s1"], &["s2"]],
            ),
            chain(
                "c2",
                Some("t1"),
                Some("u1"),
                ("1.1.1.1", 443),
                200,
                &[&["s1"], &["s2"]],
            ),
        ];
        // 模板被编辑成 1 跳；链还是旧的 2 跳。
        let edited = template("t1", "港日双路", true, &[("round_robin", &["s1"])]);
        let detail = detail_now(&edited, &chains);
        assert!(detail.template.stale);
        let reason = detail.template.stale_reason.as_deref().unwrap();
        assert!(reason.contains("跳数"), "reason={reason}");
        assert_eq!(detail.template.hops, 1, "template.hops 仍是模板定义");
        // nodes 跟随真实链：0 / 1 两个组 + target(seq 2)。
        let seqs: Vec<i64> = detail.nodes.iter().map(|node| node.seq).collect();
        assert_eq!(seqs, vec![0, 1, 2]);
        assert_eq!(detail.nodes[2].role, "target");
        assert_eq!(detail.nodes[0].role, "source");
        assert_eq!(detail.nodes[1].role, "hop");
        // 计数没有归零：两个真实组各自 2 条链。
        assert_eq!(detail.nodes[0].members[0].server_id.as_deref(), Some("s1"));
        assert_eq!(detail.nodes[0].members[0].chains, 2);
        assert_eq!(detail.nodes[1].members[0].server_id.as_deref(), Some("s2"));
        assert_eq!(detail.nodes[1].members[0].chains, 2);
        // edges 仍是真实两段（0→1 与 1→目标）。
        assert!(detail
            .edges
            .iter()
            .any(|edge| edge.seq == 1 && edge.from.member == "name-s1"));
        assert!(detail
            .edges
            .iter()
            .any(|edge| edge.seq == 2 && edge.to.member == "1.1.1.1:443"));
        assert!(detail.unused_candidates.is_empty());
        assert_eq!(detail.series_basis, "existing_chains");
    }

    /// B3：模板从 1 跳改成 2 跳后，真实链仍是 1 跳；新增的第 2 跳候选进入
    /// `unused_candidates`，不混进 `nodes`。
    #[test]
    fn adding_a_hop_to_the_template_does_not_invent_a_node() {
        let chains = vec![chain(
            "c1",
            Some("t1"),
            None,
            ("1.1.1.1", 443),
            100,
            &[&["s1"]],
        )];
        let edited = template(
            "t1",
            "单跳",
            true,
            &[("round_robin", &["s1"]), ("round_robin", &["s3"])],
        );
        let detail = detail_now(&edited, &chains);
        assert!(detail.template.stale);
        // 只有真实的一组 + 目标节点（seq 1），不会凭空多一个 hop 节点。
        let seqs: Vec<i64> = detail.nodes.iter().map(|node| node.seq).collect();
        assert_eq!(seqs, vec![0, 1]);
        assert_eq!(detail.nodes[0].members.len(), 1);
        assert_eq!(detail.nodes[0].members[0].chains, 1, "计数不能归零");
        assert_eq!(detail.nodes[1].role, "target");
        // s3 是模板新增的候选，没有任何链用它。
        assert_eq!(
            detail.unused_candidates,
            vec![UnusedCandidate {
                seq: 1,
                server_id: "s3".into(),
                name: "大阪-01".into(),
                status: "offline".into(),
            }]
        );
        assert_eq!(detail.edges.len(), 1);
        assert_eq!(detail.edges[0].seq, 1);
        assert_eq!(detail.edges[0].to.member, "1.1.1.1:443");
    }

    /// B3：模板换掉候选成员后，链里仍在用的旧成员必须继续出现在 nodes 里，
    /// 计数不丢；新候选进 `unused_candidates`。
    #[test]
    fn replacing_a_candidate_keeps_the_member_the_chain_actually_uses() {
        let chains = vec![chain(
            "c1",
            Some("t1"),
            None,
            ("1.1.1.1", 443),
            100,
            &[&["s1"]],
        )];
        // 模板把 s1 换成 s2：链仍然按 s1 走。
        let edited = template("t1", "换成员", true, &[("round_robin", &["s2"])]);
        let detail = detail_now(&edited, &chains);
        assert!(detail.template.stale);
        let reason = detail.template.stale_reason.as_deref().unwrap();
        assert!(reason.contains("候选"), "reason={reason}");
        assert_eq!(detail.nodes[0].members[0].server_id.as_deref(), Some("s1"));
        assert_eq!(detail.nodes[0].members[0].chains, 1);
        assert_eq!(
            detail.unused_candidates,
            vec![UnusedCandidate {
                seq: 0,
                server_id: "s2".into(),
                name: "东京-01".into(),
                status: "online".into(),
            }]
        );
    }

    /// B3：模板没变时 `stale = false`、`stale_reason = null`。
    #[test]
    fn an_unchanged_template_is_not_stale() {
        let tpl = template("t1", "港日双路", true, &[("round_robin", &["s1"])]);
        let chains = vec![chain(
            "c1",
            Some("t1"),
            None,
            ("1.1.1.1", 443),
            100,
            &[&["s1"]],
        )];
        let detail = detail_now(&tpl, &chains);
        assert!(!detail.template.stale);
        assert_eq!(detail.template.stale_reason, None);
        assert!(detail.unused_candidates.is_empty());
    }

    /// B4：`series` 按**当前存在的链**回填——删链后历史桶也回退，
    /// `series_basis` 显式声明这个口径。
    #[test]
    fn deleting_a_chain_rewinds_the_backfilled_series() {
        let make = |id: &str, owner: &str, created_at: i64| PathChain {
            id: id.into(),
            owner: Some(owner.into()),
            created_at,
            target_host: "1.1.1.1".into(),
            target_port: 443,
            groups: Vec::new(),
        };
        let now = 1_800_000_000;
        let paths = vec![
            make("c1", "u1", now - 3 * 3600),
            make("c2", "u2", now - 2 * 3600),
        ];
        let before = series(&paths, now, 24);
        assert_eq!(before.last().unwrap().chains, 2);
        assert_eq!(before.last().unwrap().users, 2);

        // 删掉 c2：现有链只剩 c1，所有历史桶一起回退（不会再有 2 条）。
        let after = series(&paths[..1], now, 24);
        assert!(after.iter().all(|point| point.chains <= 1));
        assert!(after.iter().all(|point| point.users <= 1));
        assert_eq!(after.last().unwrap().chains, 1);
        assert_eq!(after.last().unwrap().users, 1);
        assert!(
            before
                .iter()
                .zip(after.iter())
                .any(|(before, after)| before.chains == 2 && after.chains == 1),
            "删除后历史桶必须回退"
        );
    }

    /// B5：最后一个点代表**当前未完成桶**（`ts` = 当前 15 分钟桶起点），
    /// now 不对齐 900 时也一样，且刚刚创建的链必须计入。
    #[test]
    fn the_last_series_point_is_the_current_incomplete_bucket() {
        let now = 1_800_000_123; // 不是 900 的整数倍
        let paths = vec![PathChain {
            id: "c1".into(),
            owner: Some("u1".into()),
            created_at: now - 60,
            target_host: "1.1.1.1".into(),
            target_port: 443,
            groups: Vec::new(),
        }];
        let points = series(&paths, now, 24);
        assert_eq!(points.len(), 96);
        let aligned = now - now.rem_euclid(SERIES_BUCKET_SECS);
        let last = points.last().unwrap();
        assert_eq!(last.ts, aligned, "最后一点是当前桶起点");
        assert_eq!(last.chains, 1, "当前未完成桶必须包含刚创建的链");
        assert_eq!(points[points.len() - 2].chains, 0, "上一个完整桶没有它");
        assert!(points
            .windows(2)
            .all(|pair| pair[1].ts - pair[0].ts == SERIES_BUCKET_SECS));

        // hours = 1 也是同样的边界（4 个点）。
        let short = series(&paths, now, 1);
        assert_eq!(short.len(), 4);
        assert_eq!(short.last().unwrap().ts, aligned);
    }
}
