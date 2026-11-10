//! 线性多跳链管理（管理员）。
//!
//! 契约：`GET/POST /api/v1/chains`、`PATCH/DELETE /api/v1/chains/{id}`。
//!
//! 链本身不在 Agent 侧存在：主控把一条链推导成每台服务器上的若干
//! `DesiredForward`，复用既有转发通道。推导函数 [`derive_forwards`] 是纯函数，
//! 输入是「按 seq 排好序的组（每组 1..N 台成员）+ 链目标」，
//! 输出 `(server_id, DesiredForward)`。
//!
//! 组的语义：第 i 组的每台成员服务器都监听自己的 `listen_port`，把流量交给
//! **第 i+1 组**的成员；由上一跳按第 i+1 组的 `strategy` 选一台。
//! 因此 `DesiredForward.strategy` 取的是**下一组**的策略，而不是本组的。
//!
//! 单成员组走兼容字段：`targets` 为空，`target_host/target_port` 指向唯一的下一跳。
//! 这样迁移前创建的单台组、以及所有旧的 `hops` 请求，下发结果与旧版完全一致。
//!
//! 健康状态不属于链配置：它来自 Agent 心跳写入的 `forward_status`，按
//! `chain-<chain_id>-<seq>-<server_id>` 合并进成员视图；连续 2 次
//! `target_ok=false` 才算降级。

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::chains::GroupStrategy;
use pierwave_domain::models::{
    Chain, ChainGroupMember, ChainGroupWithMembers, ChainWithGroups, ForwardStatusRow, Server,
};
use pierwave_domain::{chains, engine, forwards, repo};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use pierwave_proto::{DesiredForward, ForwardEngine, ForwardStrategy, ForwardTarget};

/// 一条已通过校验的成员：带上服务器地址，供冲突提示与推导使用。
struct ValidatedMember {
    server_id: String,
    server_address: String,
    listen_port: i64,
    priority: i64,
    weight: i64,
}

/// 一条已通过校验的组。
struct ValidatedGroup {
    name: Option<String>,
    strategy: GroupStrategy,
    members: Vec<ValidatedMember>,
}

/// 组内成员的顺序：priority 小的优先（主备），同优先级保持输入顺序（轮询）。
///
/// 仓储查询已经按 `priority ASC, rowid ASC` 排序；这里再排一次是为了让纯函数
/// 在测试/其它调用方传入乱序成员时也得到确定结果。Rust 的排序是稳定的，
/// 所以同优先级不会打乱原有顺序。
fn ordered_members(group: &ChainGroupWithMembers) -> Vec<&ChainGroupMember> {
    let mut members: Vec<&ChainGroupMember> = group.members.iter().collect();
    members.sort_by_key(|member| member.priority);
    members
}

fn to_proto_strategy(strategy: GroupStrategy) -> ForwardStrategy {
    match strategy {
        GroupStrategy::RoundRobin => ForwardStrategy::RoundRobin,
        GroupStrategy::Failover => ForwardStrategy::Failover,
        GroupStrategy::LowestLatency => ForwardStrategy::LowestLatency,
        GroupStrategy::IpHashed => ForwardStrategy::IpHashed,
    }
}

/// 纯推导：第 i 组每台成员各自得到一条 forward。
///
/// * `listen_port` = 成员自己的监听端口；
/// * `targets` = 第 i+1 组全部成员（按 priority 排序）；下一组只有一台时留空，
///   退回 `target_host/target_port` 兼容字段；
/// * 最后一组的 `targets` 为空，兼容字段指向链目标；
/// * `strategy` = **下一组**的策略（执行选路的是上一跳）；最后一组无 downstream，
///   策略无意义，取协议默认值；
/// * 组与成员都按 seq / priority 排序，调用方传入乱序也能正确串联。
///
/// `id` 用 `chain-<chain_id>-<seq>-<server_id>`：同组多台成员不会互相覆盖心跳状态。
pub(crate) fn derive_forwards(
    chain: &Chain,
    groups: &[ChainGroupWithMembers],
) -> Vec<(String, DesiredForward)> {
    let mut ordered: Vec<&ChainGroupWithMembers> = groups.iter().collect();
    ordered.sort_by_key(|group| group.group.seq);

    let mut derived = Vec::new();
    for (index, group) in ordered.iter().enumerate() {
        let next = ordered.get(index + 1).copied();
        let strategy = next
            .map(|next| to_proto_strategy(GroupStrategy::from_db(&next.group.strategy)))
            .unwrap_or_default();

        // 下一组决定本组的目标。单成员组走兼容字段（targets 为空）；
        // 多成员组才填充 targets，让上一跳按策略选路。
        let (target_host, target_port, targets) = match next {
            Some(next) => {
                let next_members = ordered_members(next);
                match next_members.first() {
                    Some(first) => {
                        let targets = if next_members.len() > 1 {
                            next_members
                                .iter()
                                .map(|member| ForwardTarget {
                                    host: member.server_address.clone(),
                                    port: member.listen_port,
                                    server_id: member.server_id.clone(),
                                })
                                .collect()
                        } else {
                            Vec::new()
                        };
                        (first.server_address.clone(), first.listen_port, targets)
                    }
                    // 数据损坏（组没有成员）：退回链目标，至少不让下发 panic。
                    None => (chain.target_host.clone(), chain.target_port, Vec::new()),
                }
            }
            None => (chain.target_host.clone(), chain.target_port, Vec::new()),
        };

        for member in ordered_members(group) {
            derived.push((
                member.server_id.clone(),
                DesiredForward {
                    id: chains::forward_id(
                        &chain.id,
                        group.group.seq,
                        &member.server_id,
                        group.members.len(),
                    ),
                    listen_port: member.listen_port,
                    target_host: target_host.clone(),
                    target_port,
                    targets: targets.clone(),
                    strategy,
                    // 整条链共用一个引擎：推导时逐跳透传，Agent 按它分流。
                    engine: ForwardEngine::from_name(&chain.engine),
                    // UDP 同样是链级开关：每一跳在自己的 listen_port 上都开 UDP。
                    udp: chain.udp,
                },
            ));
        }
    }
    derived
}

fn default_enabled() -> bool {
    true
}

fn default_weight() -> i64 {
    1
}

#[derive(Deserialize)]
pub struct CreateChainHop {
    #[serde(default)]
    pub server_id: String,
    pub listen_port: i64,
}

/// 组内成员。`priority` 小的优先（主备）；`weight` 预留给加权，本轮只存不用。
#[derive(Deserialize)]
pub struct CreateChainMember {
    #[serde(default)]
    pub server_id: String,
    pub listen_port: i64,
    #[serde(default)]
    pub priority: i64,
    #[serde(default = "default_weight")]
    pub weight: i64,
}

#[derive(Deserialize)]
pub struct CreateChainGroup {
    #[serde(default)]
    pub name: Option<String>,
    /// 缺省 = `round_robin`。非法值由领域层给出中文错误 + code。
    #[serde(default)]
    pub strategy: Option<String>,
    #[serde(default)]
    pub members: Vec<CreateChainMember>,
}

#[derive(Deserialize)]
pub struct CreateChain {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub target_host: String,
    pub target_port: i64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 整条链的引擎：`native` / `realm`；缺省 = `native`。
    #[serde(default)]
    pub engine: Option<String>,
    /// 整条链是否同时监听 UDP（只对 `native` 有意义）；缺省 = `false`。
    #[serde(default)]
    pub udp: bool,
    /// 旧字段：每组一台成员。新请求优先用 `groups`。
    #[serde(default)]
    pub hops: Vec<CreateChainHop>,
    #[serde(default)]
    pub groups: Vec<CreateChainGroup>,
}

#[derive(Deserialize)]
pub struct PatchChain {
    pub name: Option<String>,
    pub target_host: Option<String>,
    pub target_port: Option<i64>,
    pub enabled: Option<bool>,
    /// `native` / `realm`；`None` = 不改。
    pub engine: Option<String>,
    /// `None` = 不改；`Some(false)` 用来关掉整条链的 UDP。
    pub udp: Option<bool>,
    /// 旧字段：`None` = 不改；`Some` = 整体替换（每组一台）。
    pub hops: Option<Vec<CreateChainHop>>,
    /// 新字段：`None` = 不改；`Some` = 整体替换。
    pub groups: Option<Vec<CreateChainGroup>>,
}

/// 旧 `hops` 请求 → 每组一台成员的 groups。旧行为因此完全保留。
fn groups_from_hops(hops: Vec<CreateChainHop>) -> Vec<CreateChainGroup> {
    hops.into_iter()
        .map(|hop| CreateChainGroup {
            name: None,
            strategy: None,
            members: vec![CreateChainMember {
                server_id: hop.server_id,
                listen_port: hop.listen_port,
                priority: 0,
                weight: 1,
            }],
        })
        .collect()
}

async fn load_server_for_hop(state: &AppState, server_id: &str) -> AppResult<Server> {
    repo::servers::find_by_id(&state.db.pool, server_id)
        .await
        .map_err(|error| match error.downcast_ref::<sqlx::Error>() {
            Some(sqlx::Error::RowNotFound) => {
                AppError::not_found("server.not_found", None, "服务器不存在")
            }
            _ => AppError::Internal(error),
        })
}

/// 校验组列表：组数、成员数、重复服务器、策略、端口范围/保留端口，以及与该服务器上
/// 节点 / 独立转发 / 其它链成员的端口冲突。
async fn resolve_groups(
    state: &AppState,
    inputs: &[CreateChainGroup],
    exclude_chain_id: Option<&str>,
) -> AppResult<Vec<ValidatedGroup>> {
    chains::validate_group_count(inputs.len())?;

    // 先做纯字段校验（不查库），让「9 个成员」这类错误优先于「服务器不存在」。
    let server_ids_by_group: Vec<Vec<String>> = inputs
        .iter()
        .map(|group| {
            group
                .members
                .iter()
                .map(|member| member.server_id.trim().to_string())
                .collect()
        })
        .collect();
    for (seq, server_ids) in server_ids_by_group.iter().enumerate() {
        chains::ensure_group_member_servers_unique(server_ids, seq as i64)?;
    }
    chains::ensure_chain_servers_unique(&server_ids_by_group)?;

    let mut groups = Vec::with_capacity(inputs.len());
    for (seq, input) in inputs.iter().enumerate() {
        let seq = seq as i64;
        chains::validate_group_member_count(input.members.len(), seq)?;
        let strategy = match input.strategy.as_deref() {
            Some(raw) => GroupStrategy::parse(raw)?,
            None => GroupStrategy::default(),
        };
        let name = chains::normalize_group_name(input.name.as_deref())?;

        let mut members = Vec::with_capacity(input.members.len());
        for (index, member) in input.members.iter().enumerate() {
            forwards::validate_listen_port(member.listen_port)?;
            forwards::ensure_port_not_reserved(member.listen_port)?;

            let server_id = &server_ids_by_group[seq as usize][index];
            let server = load_server_for_hop(state, server_id).await?;
            if let Some(node) =
                repo::nodes::find_by_port(&state.db.pool, &server.id, member.listen_port).await?
            {
                return Err(AppError::coded(
                    "forward.port_conflict_node",
                    Some(json!({
                        "port": member.listen_port,
                        "node": node.name,
                        "node_id": node.id,
                        "node_tag": node.tag,
                        "server_id": server.id,
                        "server_name": server.name,
                    })),
                    format!(
                        "监听端口 {} 与服务器「{}」上的节点「{}」（tag {}）冲突",
                        member.listen_port, server.name, node.name, node.tag
                    ),
                ));
            }
            if let Some(forward) = repo::forwards::find_by_listen_port(
                &state.db.pool,
                &server.id,
                member.listen_port,
                None,
            )
            .await?
            {
                return Err(AppError::coded(
                    "forward.port_conflict_forward",
                    Some(json!({
                        "port": member.listen_port,
                        "name": forward.name,
                        "id": forward.id,
                        "server_id": server.id,
                        "server_name": server.name,
                    })),
                    format!(
                        "监听端口 {} 已被服务器「{}」上的转发规则「{}」占用",
                        member.listen_port, server.name, forward.name
                    ),
                ));
            }
            if let Some(conflict) = repo::chains::find_member_port_conflict(
                &state.db.pool,
                &server.id,
                member.listen_port,
                exclude_chain_id,
            )
            .await?
            {
                return Err(AppError::coded(
                    "chain.port_conflict_hop",
                    Some(json!({
                        "port": member.listen_port,
                        "chain_id": conflict.chain_id,
                        "name": conflict.chain_name,
                        "seq": conflict.seq + 1,
                        "server_id": server.id,
                        "server_name": server.name,
                    })),
                    format!(
                        "监听端口 {} 已被服务器「{}」上的链「{}」第 {} 组占用",
                        member.listen_port,
                        server.name,
                        conflict.chain_name,
                        conflict.seq + 1
                    ),
                ));
            }

            members.push(ValidatedMember {
                server_id: server.id,
                server_address: server.address,
                listen_port: member.listen_port,
                priority: member.priority,
                weight: member.weight,
            });
        }

        groups.push(ValidatedGroup {
            name,
            strategy,
            members,
        });
    }
    Ok(groups)
}

/// 用已保存的组构造同样的校验结构（PATCH 不改组时仍要检查自连）。
fn validated_from_existing(groups: &[ChainGroupWithMembers]) -> Vec<ValidatedGroup> {
    groups
        .iter()
        .map(|group| ValidatedGroup {
            name: group.group.name.clone(),
            strategy: GroupStrategy::from_db(&group.group.strategy),
            members: group
                .members
                .iter()
                .map(|member| ValidatedMember {
                    server_id: member.server_id.clone(),
                    server_address: member.server_address.clone(),
                    listen_port: member.listen_port,
                    priority: member.priority,
                    weight: member.weight,
                })
                .collect(),
        })
        .collect()
}

/// 自连回环检查：每组每台成员的任何目标（下一组所有成员，或最终 target）
/// 都不能指回自己的监听端口。
fn ensure_targets_safe(
    groups: &[ValidatedGroup],
    target_host: &str,
    target_port: i64,
) -> AppResult<()> {
    for (index, group) in groups.iter().enumerate() {
        let next: Vec<(&str, i64)> = match groups.get(index + 1) {
            Some(next) => next
                .members
                .iter()
                .map(|member| (member.server_address.as_str(), member.listen_port))
                .collect(),
            None => vec![(target_host, target_port)],
        };
        for member in &group.members {
            for (host, port) in &next {
                forwards::ensure_not_self_loop("0.0.0.0", member.listen_port, host, *port)?;
            }
        }
    }
    Ok(())
}

fn new_groups(groups: &[ValidatedGroup]) -> Vec<repo::chains::NewChainGroup> {
    groups
        .iter()
        .map(|group| repo::chains::NewChainGroup {
            name: group.name.clone(),
            strategy: group.strategy.as_str().to_string(),
            members: group
                .members
                .iter()
                .map(|member| repo::chains::NewChainGroupMember {
                    server_id: member.server_id.clone(),
                    listen_port: member.listen_port,
                    priority: member.priority,
                    weight: member.weight,
                })
                .collect(),
        })
        .collect()
}

/// 链写操作后要立即下发到「所有受影响的服务器」：旧成员服务器也要，否则
/// PATCH 删掉一组后，那台机器上的转发会一直留到下一次对账。
async fn mark_servers_dirty_and_apply(state: &AppState, base_url: &str, server_ids: &[String]) {
    let mut seen = HashSet::new();
    for server_id in server_ids {
        if !seen.insert(server_id.as_str()) {
            continue;
        }
        match super::forwards::load_server(state, server_id).await {
            Ok(server) => {
                super::forwards::mark_dirty_and_apply(state, &server, base_url).await;
            }
            Err(error) => tracing::warn!(
                server_id = %server_id,
                error = %error,
                "链已保存，但加载服务器失败，跳过立即下发（已标脏，稍后重试）"
            ),
        }
    }
}

fn chain_server_ids(chain: &ChainWithGroups) -> Vec<String> {
    chain
        .groups
        .iter()
        .flat_map(|group| group.members.iter())
        .map(|member| member.server_id.clone())
        .collect()
}

fn member_forward_id(chain_id: &str, member: &ChainGroupMember, member_count: usize) -> String {
    chains::forward_id(chain_id, member.seq, &member.server_id, member_count)
}

async fn load_status_map(
    state: &AppState,
    chains_list: &[ChainWithGroups],
) -> AppResult<HashMap<String, ForwardStatusRow>> {
    let mut map = HashMap::new();
    let mut seen = HashSet::new();
    for chain in chains_list {
        for member in chain.groups.iter().flat_map(|group| group.members.iter()) {
            if !seen.insert(member.server_id.clone()) {
                continue;
            }
            for row in
                repo::forwards::list_status_by_server(&state.db.pool, &member.server_id).await?
            {
                map.insert(row.forward_id.clone(), row);
            }
        }
    }
    Ok(map)
}

/// 链视图：配置 + 每组/每个成员的运行状态（监听、目标可达、是否降级）。
///
/// 同时保留旧的 `hops` 数组（每组取排序后的第一台成员），让尚未升级的前端
/// 仍能展示/编辑单成员链；多成员组请读 `groups`。
fn chain_json(chain: &ChainWithGroups, statuses: &HashMap<String, ForwardStatusRow>) -> Value {
    let mut group_views = Vec::with_capacity(chain.groups.len());
    let mut hop_views = Vec::with_capacity(chain.groups.len());
    let mut degraded = false;

    for group in &chain.groups {
        let mut member_views = Vec::with_capacity(group.members.len());
        let mut group_degraded = false;
        for member in ordered_members(group) {
            let forward_id = member_forward_id(&chain.chain.id, member, group.members.len());
            let status = statuses.get(&forward_id);
            let member_degraded =
                status.is_some_and(|row| chains::is_degraded(row.target_fail_count));
            group_degraded |= member_degraded;
            member_views.push(json!({
                "server_id": member.server_id,
                "server_name": member.server_name,
                "listen_port": member.listen_port,
                "priority": member.priority,
                "weight": member.weight,
                "forward_id": forward_id,
                // 监听成功与目标可达是两件事：端口绑上了，目标仍可能不可达。
                "listening": status.map(|row| row.listening),
                "target_ok": status.and_then(|row| row.target_ok),
                "degraded": member_degraded,
                "error": status.map(|row| row.error.as_str()).unwrap_or(""),
                "updated_at": status.map(|row| row.updated_at),
            }));
        }
        degraded |= group_degraded;

        group_views.push(json!({
            "id": group.group.id,
            "seq": group.group.seq,
            "name": group.group.name,
            "strategy": group.group.strategy,
            "degraded": group_degraded,
            "members": member_views,
        }));

        // 旧 hops 视图：每组的第一台成员。
        if let Some(member) = ordered_members(group).first().copied() {
            let forward_id = member_forward_id(&chain.chain.id, member, group.members.len());
            let status = statuses.get(&forward_id);
            hop_views.push(json!({
                "seq": group.group.seq,
                "server_id": member.server_id,
                "server_name": member.server_name,
                "listen_port": member.listen_port,
                "listening": status.map(|row| row.listening),
                "target_ok": status.and_then(|row| row.target_ok),
                "degraded": status.is_some_and(|row| chains::is_degraded(row.target_fail_count)),
                "error": status.map(|row| row.error.as_str()).unwrap_or(""),
                "updated_at": status.map(|row| row.updated_at),
            }));
        }
    }

    json!({
        "id": chain.chain.id,
        "name": chain.chain.name,
        "target_host": chain.chain.target_host,
        "target_port": chain.chain.target_port,
        "enabled": chain.chain.enabled,
        "engine": chain.chain.engine,
        "udp": chain.chain.udp,
        "degraded": degraded,
        "groups": group_views,
        "hops": hop_views,
        "created_at": chain.chain.created_at,
        "updated_at": chain.chain.updated_at,
    })
}

/// 指定服务器参与的链的整体降级状态：`chain_id -> (链名, 是否降级)`。
///
/// 心跳处理用它在 `save_status` 前后各算一次，只有 false → true 的跃迁才告警，
/// 避免同一条降级链每 15 秒刷一次通知。状态本身不落库：`forward_status`
/// 才是事实来源，链视图每次现算。
pub(crate) async fn degradation_for_server(
    state: &AppState,
    server_id: &str,
) -> AppResult<HashMap<String, (String, bool)>> {
    let chains_list: Vec<ChainWithGroups> = repo::chains::list(&state.db.pool)
        .await?
        .into_iter()
        .filter(|chain| {
            chain
                .groups
                .iter()
                .flat_map(|group| group.members.iter())
                .any(|member| member.server_id == server_id)
        })
        .collect();
    if chains_list.is_empty() {
        return Ok(HashMap::new());
    }
    let statuses = load_status_map(state, &chains_list).await?;
    let mut result = HashMap::with_capacity(chains_list.len());
    for chain in chains_list {
        let degraded = chain.groups.iter().any(|group| {
            group.members.iter().any(|member| {
                let forward_id = member_forward_id(&chain.chain.id, member, group.members.len());
                statuses
                    .get(&forward_id)
                    .is_some_and(|row| chains::is_degraded(row.target_fail_count))
            })
        });
        result.insert(chain.chain.id, (chain.chain.name, degraded));
    }
    Ok(result)
}

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let chains_list = repo::chains::list(&state.db.pool).await?;
    let statuses = load_status_map(&state, &chains_list).await?;
    let items: Vec<Value> = chains_list
        .iter()
        .map(|chain| chain_json(chain, &statuses))
        .collect();
    Ok(Json(json!({ "items": items })))
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Json(req): Json<CreateChain>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let CreateChain {
        name: raw_name,
        target_host: raw_target_host,
        target_port,
        enabled,
        engine: raw_engine,
        udp,
        hops,
        groups,
    } = req;

    let name = chains::normalize_name(&raw_name)?;
    let target_host = forwards::normalize_target_host(&raw_target_host)?;
    forwards::validate_target_port(target_port)?;
    let engine = match raw_engine.as_deref() {
        Some(raw) => engine::normalize(raw)?,
        None => engine::DEFAULT.to_string(),
    };

    // 新字段优先；没传 groups 时把旧 hops 转成「每组一台」。
    let inputs = if groups.is_empty() {
        groups_from_hops(hops)
    } else {
        groups
    };
    let groups = resolve_groups(&state, &inputs, None).await?;
    ensure_targets_safe(&groups, &target_host, target_port)?;

    let chain = repo::chains::create(
        &state.db.pool,
        repo::chains::NewChain {
            name,
            target_host,
            target_port,
            enabled,
            engine,
            udp,
            groups: new_groups(&groups),
        },
    )
    .await?;

    crate::audit::record(
        &state,
        &user.0,
        "chain.create",
        &chain.chain.id,
        json!({
            "name": &chain.chain.name,
            "target_host": &chain.chain.target_host,
            "target_port": chain.chain.target_port,
            "enabled": chain.chain.enabled,
            "engine": &chain.chain.engine,
            "udp": chain.chain.udp,
            "hops": chain.groups.iter().map(|group| json!({
                "seq": group.group.seq,
                "server_id": group.members.first().map(|member| &member.server_id),
                "listen_port": group.members.first().map(|member| member.listen_port),
            })).collect::<Vec<_>>(),
            "groups": chain.groups.iter().map(|group| json!({
                "seq": group.group.seq,
                "name": &group.group.name,
                "strategy": &group.group.strategy,
                "members": group.members.iter().map(|member| json!({
                    "server_id": &member.server_id,
                    "listen_port": member.listen_port,
                    "priority": member.priority,
                    "weight": member.weight,
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        }),
    )
    .await;

    let base = super::install::external_base(&headers);
    mark_servers_dirty_and_apply(&state, &base, &chain_server_ids(&chain)).await;

    let statuses = load_status_map(&state, std::slice::from_ref(&chain)).await?;
    Ok(Json(json!({ "chain": chain_json(&chain, &statuses) })))
}

pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchChain>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let PatchChain {
        name: raw_name,
        target_host: raw_target_host,
        target_port,
        enabled,
        engine: raw_engine,
        udp,
        hops,
        groups,
    } = req;

    if raw_name.is_none()
        && raw_target_host.is_none()
        && target_port.is_none()
        && enabled.is_none()
        && raw_engine.is_none()
        && udp.is_none()
        && hops.is_none()
        && groups.is_none()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供 name / target_host / target_port / enabled / engine / udp / groups / hops 之一",
        ));
    }

    let existing = repo::chains::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("chain.not_found", None, "链不存在"))?;

    let name = match raw_name.as_deref() {
        Some(raw) => Some(chains::normalize_name(raw)?),
        None => None,
    };
    let target_host = match raw_target_host.as_deref() {
        Some(raw) => Some(forwards::normalize_target_host(raw)?),
        None => None,
    };
    if let Some(port) = target_port {
        forwards::validate_target_port(port)?;
    }
    let engine = match raw_engine.as_deref() {
        Some(raw) => Some(engine::normalize(raw)?),
        None => None,
    };
    let final_target_host = target_host
        .as_deref()
        .unwrap_or(&existing.chain.target_host);
    let final_target_port = target_port.unwrap_or(existing.chain.target_port);

    // 新字段优先；只传旧 hops 时转成「每组一台」。
    let group_input = match (groups, hops) {
        (Some(groups), _) => Some(groups),
        (None, Some(hops)) => Some(groups_from_hops(hops)),
        (None, None) => None,
    };
    let replace_groups = group_input.is_some();
    let groups = match group_input {
        Some(inputs) => resolve_groups(&state, &inputs, Some(&existing.chain.id)).await?,
        None => validated_from_existing(&existing.groups),
    };
    ensure_targets_safe(&groups, final_target_host, final_target_port)?;

    let updated = repo::chains::update(
        &state.db.pool,
        &id,
        repo::chains::UpdateChain {
            name,
            target_host,
            target_port,
            enabled,
            engine,
            udp,
            groups: replace_groups.then(|| new_groups(&groups)),
        },
    )
    .await?
    .ok_or_else(|| AppError::not_found("chain.not_found", None, "链不存在"))?;

    let changes = crate::audit::diff(vec![
        (
            "name",
            json!(&existing.chain.name),
            json!(&updated.chain.name),
        ),
        (
            "target_host",
            json!(&existing.chain.target_host),
            json!(&updated.chain.target_host),
        ),
        (
            "target_port",
            json!(existing.chain.target_port),
            json!(updated.chain.target_port),
        ),
        (
            "enabled",
            json!(existing.chain.enabled),
            json!(updated.chain.enabled),
        ),
        (
            "engine",
            json!(&existing.chain.engine),
            json!(&updated.chain.engine),
        ),
        ("udp", json!(existing.chain.udp), json!(updated.chain.udp)),
        (
            "hops",
            json!(existing.groups.len()),
            json!(updated.groups.len()),
        ),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "chain.update",
        &updated.chain.id,
        json!({
            "name": &updated.chain.name,
            "changes": changes,
        }),
    )
    .await;

    let mut affected = chain_server_ids(&existing);
    affected.extend(chain_server_ids(&updated));
    let base = super::install::external_base(&headers);
    mark_servers_dirty_and_apply(&state, &base, &affected).await;

    let statuses = load_status_map(&state, std::slice::from_ref(&updated)).await?;
    Ok(Json(json!({ "chain": chain_json(&updated, &statuses) })))
}

pub async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let existing = repo::chains::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("chain.not_found", None, "链不存在"))?;
    if !repo::chains::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found("chain.not_found", None, "链不存在"));
    }

    crate::audit::record(
        &state,
        &user.0,
        "chain.delete",
        &id,
        json!({
            "name": &existing.chain.name,
            "target_host": &existing.chain.target_host,
            "target_port": existing.chain.target_port,
        }),
    )
    .await;

    let base = super::install::external_base(&headers);
    mark_servers_dirty_and_apply(&state, &base, &chain_server_ids(&existing)).await;

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::models::Chain;
    use pierwave_domain::Db;

    struct Fixture {
        app: Router,
        state: AppState,
        cookie: String,
        /// 入口服务器。
        a: String,
        /// 中转/出口服务器。
        b: String,
        /// 组内候选服务器（多成员组用）。
        c: String,
        /// 组内候选服务器（多成员组用）。
        d: String,
    }

    async fn setup() -> Fixture {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = repo::users::create(
            &db.pool,
            repo::users::NewUser {
                username: "admin".into(),
                password: "devpass".into(),
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
            .await
            .unwrap();
        let (a, _) = repo::servers::create(&db.pool, "hk-a", "10.0.0.1", "external")
            .await
            .unwrap();
        let (b, _) = repo::servers::create(&db.pool, "jp-b", "10.0.0.2", "external")
            .await
            .unwrap();
        let (c, _) = repo::servers::create(&db.pool, "sg-c", "10.0.0.3", "external")
            .await
            .unwrap();
        let (d, _) = repo::servers::create(&db.pool, "us-d", "10.0.0.4", "external")
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        Fixture {
            app,
            state,
            cookie: format!("{}={token}", crate::auth::SESSION_COOKIE),
            a: a.id,
            b: b.id,
            c: c.id,
            d: d.id,
        }
    }

    async fn request(
        app: &Router,
        cookie: Option<&str>,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    fn chain_body(name: &str, target_host: &str, target_port: i64, hops: &[(&str, i64)]) -> Value {
        json!({
            "name": name,
            "target_host": target_host,
            "target_port": target_port,
            "hops": hops
                .iter()
                .map(|(server_id, port)| json!({
                    "server_id": server_id,
                    "listen_port": port,
                }))
                .collect::<Vec<_>>(),
        })
    }

    fn group_member(server_id: &str, listen_port: i64, priority: i64) -> Value {
        json!({
            "server_id": server_id,
            "listen_port": listen_port,
            "priority": priority,
        })
    }

    fn group(name: Option<&str>, strategy: Option<&str>, members: &[Value]) -> Value {
        json!({
            "name": name,
            "strategy": strategy,
            "members": members,
        })
    }

    fn groups_body(name: &str, target_host: &str, target_port: i64, groups: &[Value]) -> Value {
        json!({
            "name": name,
            "target_host": target_host,
            "target_port": target_port,
            "groups": groups,
        })
    }

    async fn add_node(state: &AppState, server_id: &str, port: i64) {
        repo::nodes::create(
            &state.db.pool,
            server_id,
            repo::nodes::NewNode {
                tag: None,
                name: "已有节点".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "none".into(),
                port,
                config_json: "{}".into(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();
    }

    fn test_chain(id: &str) -> Chain {
        Chain {
            id: id.into(),
            name: "测试链".into(),
            target_host: "1.1.1.1".into(),
            target_port: 443,
            enabled: true,
            engine: "native".into(),
            udp: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn test_group(
        chain_id: &str,
        seq: i64,
        strategy: &str,
        // (server_id, address, listen_port, priority)
        members: &[(&str, &str, i64, i64)],
    ) -> ChainGroupWithMembers {
        ChainGroupWithMembers {
            group: pierwave_domain::models::ChainGroup {
                id: format!("grp-{seq}"),
                chain_id: chain_id.into(),
                seq,
                name: None,
                strategy: strategy.into(),
            },
            members: members
                .iter()
                .map(
                    |(server_id, address, listen_port, priority)| ChainGroupMember {
                        group_id: format!("grp-{seq}"),
                        chain_id: chain_id.into(),
                        seq,
                        strategy: strategy.into(),
                        server_id: (*server_id).into(),
                        server_name: format!("server-{server_id}"),
                        server_address: (*address).into(),
                        listen_port: *listen_port,
                        priority: *priority,
                        weight: 1,
                    },
                )
                .collect(),
        }
    }

    fn target(host: &str, port: i64, server_id: &str) -> ForwardTarget {
        ForwardTarget {
            host: host.into(),
            port,
            server_id: server_id.into(),
        }
    }

    /// 单组 3 成员：没有下一组，三台都直接指向链目标，targets 为空。
    #[test]
    fn derives_single_group_with_three_members_to_chain_target() {
        let chain = test_chain("c1");
        let groups = vec![test_group(
            "c1",
            0,
            "round_robin",
            &[
                ("srv-a", "10.0.0.1", 9001, 0),
                ("srv-b", "10.0.0.2", 9002, 0),
                ("srv-c", "10.0.0.3", 9003, 0),
            ],
        )];

        let derived = derive_forwards(&chain, &groups);
        assert_eq!(derived.len(), 3, "组内每台成员各一条 forward");
        for (index, (server_id, forward)) in derived.iter().enumerate() {
            assert_eq!(server_id, &format!("srv-{}", ["a", "b", "c"][index]));
            assert_eq!(
                forward.id,
                format!("chain-c1-0-srv-{}", ["a", "b", "c"][index])
            );
            assert_eq!(forward.listen_port, [9001, 9002, 9003][index]);
            assert_eq!(forward.target_host, "1.1.1.1");
            assert_eq!(forward.target_port, 443);
            assert!(forward.targets.is_empty(), "最后一组没有 downstream");
            assert_eq!(forward.strategy, ForwardStrategy::RoundRobin);
        }
    }

    /// 1 台入口 → 3 台目标组：入口 forward 带 3 个 targets，
    /// 且 strategy 取的是**目标组**的 failover。
    #[test]
    fn derives_three_member_target_group_and_applies_its_strategy() {
        let chain = test_chain("c2");
        let groups = vec![
            test_group("c2", 0, "round_robin", &[("srv-a", "10.0.0.1", 9001, 0)]),
            test_group(
                "c2",
                1,
                "failover",
                &[
                    ("srv-b", "10.0.0.2", 9002, 0),
                    ("srv-c", "10.0.0.3", 9003, 1),
                    ("srv-d", "10.0.0.4", 9004, 2),
                ],
            ),
        ];

        let derived = derive_forwards(&chain, &groups);
        assert_eq!(derived.len(), 4, "1 台入口 + 3 台目标组成员");

        let entry = &derived[0];
        assert_eq!(entry.0, "srv-a");
        assert_eq!(entry.1.listen_port, 9001);
        assert_eq!(
            entry.1.id, "chain-c2-0",
            "入口是单成员组，必须沿用旧 id，升级不重建监听"
        );
        assert_eq!(
            entry.1.strategy,
            ForwardStrategy::Failover,
            "执行选路的是上一跳，策略必须取下一组的"
        );
        assert_eq!(
            entry.1.targets,
            vec![
                target("10.0.0.2", 9002, "srv-b"),
                target("10.0.0.3", 9003, "srv-c"),
                target("10.0.0.4", 9004, "srv-d"),
            ],
            "targets 必须包含下一组全部成员，按 priority 排序"
        );
        assert_eq!(
            entry.1.target_host, "10.0.0.2",
            "兼容字段指向下一组第一台，旧 Agent 也能工作"
        );
        assert_eq!(entry.1.target_port, 9002);

        // 目标组自己没有 downstream，三台都回落到链目标。
        for (server_id, forward) in &derived[1..] {
            assert!(["srv-b", "srv-c", "srv-d"].contains(&server_id.as_str()));
            assert!(forward.targets.is_empty());
            assert_eq!(forward.target_host, "1.1.1.1");
            assert_eq!(forward.target_port, 443);
            assert_eq!(forward.strategy, ForwardStrategy::RoundRobin);
        }
    }

    /// 两组各 2 成员：2×2=4 条 forward；前一组每条带 2 个 targets，后一组落到链目标。
    #[test]
    fn derives_two_groups_with_two_members_each() {
        let chain = test_chain("c3");
        let groups = vec![
            test_group(
                "c3",
                0,
                "round_robin",
                &[
                    ("srv-a", "10.0.0.1", 9001, 0),
                    ("srv-b", "10.0.0.2", 9002, 0),
                ],
            ),
            test_group(
                "c3",
                1,
                "lowest_latency",
                &[
                    ("srv-c", "10.0.0.3", 9003, 0),
                    ("srv-d", "10.0.0.4", 9004, 0),
                ],
            ),
        ];

        let derived = derive_forwards(&chain, &groups);
        assert_eq!(derived.len(), 4, "每条链 2 + 2 = 4 条 forward");

        for (server_id, forward) in &derived[..2] {
            assert!(["srv-a", "srv-b"].contains(&server_id.as_str()));
            assert_eq!(
                forward.strategy,
                ForwardStrategy::LowestLatency,
                "入口组的两台都必须拿到下一组的策略"
            );
            assert_eq!(
                forward.targets,
                vec![
                    target("10.0.0.3", 9003, "srv-c"),
                    target("10.0.0.4", 9004, "srv-d"),
                ]
            );
        }

        for (server_id, forward) in &derived[2..] {
            assert!(["srv-c", "srv-d"].contains(&server_id.as_str()));
            assert!(forward.targets.is_empty());
            assert_eq!(forward.target_host, "1.1.1.1");
            assert_eq!(forward.target_port, 443);
        }
    }

    /// 下一组只有 1 台时退回兼容字段：targets 为空，target_host/port 指向它。
    #[test]
    fn derives_single_member_next_group_to_compat_fields() {
        let chain = test_chain("c4");
        let groups = vec![
            test_group(
                "c4",
                0,
                "round_robin",
                &[
                    ("srv-a", "10.0.0.1", 9001, 0),
                    ("srv-b", "10.0.0.2", 9002, 0),
                ],
            ),
            test_group("c4", 1, "ip_hashed", &[("srv-c", "10.0.0.3", 9003, 0)]),
        ];

        let derived = derive_forwards(&chain, &groups);
        assert_eq!(derived.len(), 3);
        for (server_id, forward) in &derived[..2] {
            assert!(["srv-a", "srv-b"].contains(&server_id.as_str()));
            assert!(
                forward.targets.is_empty(),
                "单成员组必须回落到兼容字段，行为与旧版一致"
            );
            assert_eq!(forward.target_host, "10.0.0.3");
            assert_eq!(forward.target_port, 9003);
            assert_eq!(
                forward.strategy,
                ForwardStrategy::IpHashed,
                "策略仍取下一组（虽然单目标时 Agent 忽略）"
            );
        }
        assert!(derived[2].1.targets.is_empty());
        assert_eq!(derived[2].1.target_host, "1.1.1.1");
        assert_eq!(derived[2].1.id, "chain-c4-1", "单成员的目标组也应沿用旧 id");
    }

    /// 组按 seq 排序、成员按 priority 排序；传入乱序也要串对。
    #[test]
    fn derives_groups_in_seq_order_and_members_in_priority_order() {
        let chain = test_chain("c5");
        let groups = vec![
            // 故意先传 seq=1。
            test_group("c5", 1, "round_robin", &[("srv-c", "10.0.0.3", 9003, 0)]),
            test_group(
                "c5",
                0,
                "round_robin",
                &[
                    // 故意让 priority=1 的排在前面。
                    ("srv-b", "10.0.0.2", 9002, 1),
                    ("srv-a", "10.0.0.1", 9001, 0),
                ],
            ),
        ];

        let derived = derive_forwards(&chain, &groups);
        assert_eq!(derived.len(), 3);
        assert_eq!(derived[0].0, "srv-a", "同组内 priority 小的先出");
        assert_eq!(derived[1].0, "srv-b");
        assert_eq!(derived[0].1.target_host, "10.0.0.3");
        assert_eq!(derived[0].1.target_port, 9003);
        assert_eq!(derived[2].0, "srv-c");
        assert_eq!(derived[2].1.target_host, "1.1.1.1");
    }

    /// 校验：重复服务器、超过 6 跳、非法目标、节点/转发/其它链的端口冲突。
    #[tokio::test]
    async fn validation_rejects_bad_hops_targets_and_port_conflicts() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        // 0 跳 / 7 跳（上限 6）。
        for body in [
            chain_body("空链", "1.1.1.1", 443, &[]),
            chain_body(
                "太长",
                "1.1.1.1",
                443,
                &[
                    (fixture.a.as_str(), 8001),
                    (fixture.a.as_str(), 8002),
                    (fixture.a.as_str(), 8003),
                    (fixture.a.as_str(), 8004),
                    (fixture.a.as_str(), 8005),
                    (fixture.a.as_str(), 8006),
                    (fixture.a.as_str(), 8007),
                ],
            ),
        ] {
            let (status, value) = request(
                &fixture.app,
                Some(&fixture.cookie),
                Method::POST,
                uri,
                Some(body),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
            assert_eq!(value["code"], "chain.hop_count_invalid");
        }

        // 同一台服务器出现两次。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "重复服务器",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 8001), (fixture.a.as_str(), 8002)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.duplicate_server");

        // 目标非法：空地址 / 端口越界。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "空目标",
                "   ",
                443,
                &[(fixture.a.as_str(), 8001)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.target_host_required");

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "目标端口非法",
                "1.1.1.1",
                0,
                &[(fixture.a.as_str(), 8001)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.target_port_invalid");

        // 与节点端口冲突。
        add_node(&fixture.state, &fixture.a, 443).await;
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "撞节点",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 443)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.port_conflict_node");

        // 与独立转发冲突。
        repo::forwards::create(
            &fixture.state.db.pool,
            &fixture.a,
            repo::forwards::NewForward {
                name: "独立转发".into(),
                listen_port: 8443,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: true,
                engine: "native".into(),
                udp: false,
            },
        )
        .await
        .unwrap();
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "撞转发",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 8443)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.port_conflict_forward");

        // 与另一条链的跳冲突。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "第一条链",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 9443)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "第二条链",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 9443)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.port_conflict_hop");
    }

    /// CRUD + 运行时健康：目标连续失败两次才降级，恢复即清除。
    #[tokio::test]
    async fn crud_and_health_expose_target_ok_and_degraded() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "港-日",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 9001), (fixture.b.as_str(), 9002)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain = &value["chain"];
        let chain_id = chain["id"].as_str().unwrap().to_string();
        assert_eq!(chain["name"], "港-日");
        assert_eq!(chain["target_host"], "1.1.1.1");
        assert_eq!(chain["target_port"], 443);
        assert_eq!(chain["enabled"], true);
        assert_eq!(chain["degraded"], false);
        assert_eq!(chain["hops"].as_array().unwrap().len(), 2);
        assert_eq!(chain["hops"][0]["seq"], 0);
        assert_eq!(chain["hops"][0]["server_id"], fixture.a.as_str());
        assert_eq!(chain["hops"][0]["server_name"], "hk-a");
        assert_eq!(chain["hops"][0]["listen_port"], 9001);
        assert_eq!(chain["hops"][1]["seq"], 1);
        assert_eq!(chain["hops"][1]["server_name"], "jp-b");
        assert_eq!(chain["hops"][1]["listen_port"], 9002);
        assert!(chain["hops"][0]["target_ok"].is_null(), "还没探测时是 null");

        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(body["items"].as_array().unwrap().len(), 1);

        let hop_id = chains::legacy_forward_id(&chain_id, 0);
        let save = |target_ok: Option<bool>, listening: bool| {
            let pool = fixture.state.db.pool.clone();
            let server_id = fixture.a.clone();
            let forward_id = hop_id.clone();
            async move {
                repo::forwards::save_status(
                    &pool,
                    &server_id,
                    &[repo::forwards::NewForwardStatus {
                        forward_id,
                        listening,
                        error: String::new(),
                        target_ok,
                    }],
                )
                .await
                .unwrap();
            }
        };

        // 第一次 false：不降级。
        save(Some(false), true).await;
        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        let hop = &body["items"][0]["hops"][0];
        assert_eq!(hop["target_ok"], false);
        assert_eq!(hop["listening"], true, "监听成功与目标可达是两件事");
        assert_eq!(hop["degraded"], false);
        assert_eq!(body["items"][0]["degraded"], false);

        // 第二次 false：跳与链都降级。
        save(Some(false), true).await;
        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(body["items"][0]["hops"][0]["degraded"], true);
        assert_eq!(body["items"][0]["degraded"], true);

        // 恢复：降级立刻清除。
        save(Some(true), true).await;
        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(body["items"][0]["hops"][0]["target_ok"], true);
        assert_eq!(body["items"][0]["hops"][0]["degraded"], false);
        assert_eq!(body["items"][0]["degraded"], false);

        // PATCH：改名 + 停用。
        let chain_uri = format!("/api/v1/chains/{chain_id}");
        let (status, body) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::PATCH,
            &chain_uri,
            Some(json!({"name": "港-日-新", "enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["chain"]["name"], "港-日-新");
        assert_eq!(body["chain"]["enabled"], false);

        // 停用后不再进入期望态。
        let server_a = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.a)
            .await
            .unwrap();
        let rendered =
            super::super::desired::render(&fixture.state, &server_a, "https://panel.example.com")
                .await
                .unwrap();
        assert!(rendered.forwards.is_empty(), "停用的链不能下发任何跳");

        // 删除后列表清空，链推导的状态行也一并清掉。
        let (status, body) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::DELETE,
            &chain_uri,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["ok"], true);
        assert!(repo::chains::find_by_id(&fixture.state.db.pool, &chain_id)
            .await
            .unwrap()
            .is_none());
        assert!(
            repo::forwards::list_status_by_server(&fixture.state.db.pool, &fixture.a)
                .await
                .unwrap()
                .is_empty(),
            "删除链要清掉它推导出的 forward_status 行"
        );

        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert!(body["items"].as_array().unwrap().is_empty());
    }

    /// 组接口：响应里带每组策略/成员，运行状态按成员（而不是按组）合并。
    #[tokio::test]
    async fn groups_expose_members_strategy_and_per_member_health() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "港-日-新",
                "1.1.1.1",
                443,
                &[
                    group(
                        Some("入口"),
                        Some("failover"),
                        &[
                            group_member(&fixture.a, 9001, 0),
                            group_member(&fixture.b, 9002, 1),
                        ],
                    ),
                    group(
                        None,
                        Some("round_robin"),
                        &[group_member(&fixture.c, 9003, 0)],
                    ),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain = &value["chain"];
        let chain_id = chain["id"].as_str().unwrap().to_string();

        assert_eq!(chain["groups"].as_array().unwrap().len(), 2);
        assert_eq!(chain["groups"][0]["name"], "入口");
        assert_eq!(chain["groups"][0]["strategy"], "failover");
        assert_eq!(chain["groups"][0]["members"].as_array().unwrap().len(), 2);
        assert_eq!(chain["groups"][0]["members"][0]["server_name"], "hk-a");
        assert_eq!(chain["groups"][0]["members"][0]["listen_port"], 9001);
        assert_eq!(chain["groups"][0]["members"][0]["priority"], 0);
        assert_eq!(chain["groups"][0]["members"][1]["priority"], 1);
        assert_eq!(chain["groups"][1]["strategy"], "round_robin");
        assert_eq!(chain["groups"][1]["members"].as_array().unwrap().len(), 1);
        // 旧前端继续读 hops：每组取第一台成员。
        assert_eq!(chain["hops"].as_array().unwrap().len(), 2);
        assert_eq!(chain["hops"][0]["server_id"], fixture.a.as_str());

        // 两个成员分别上报：一个目标不可达、一个正常。
        let a_id = chains::forward_id(&chain_id, 0, &fixture.a, 2);
        let b_id = chains::forward_id(&chain_id, 0, &fixture.b, 2);
        let save = |server_id: String, forward_id: String, target_ok: bool| {
            let pool = fixture.state.db.pool.clone();
            async move {
                repo::forwards::save_status(
                    &pool,
                    &server_id,
                    &[repo::forwards::NewForwardStatus {
                        forward_id,
                        listening: true,
                        error: String::new(),
                        target_ok: Some(target_ok),
                    }],
                )
                .await
                .unwrap();
            }
        };
        save(fixture.a.clone(), a_id.clone(), false).await;
        save(fixture.b.clone(), b_id.clone(), true).await;

        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        let group = &body["items"][0]["groups"][0];
        assert_eq!(group["members"][0]["target_ok"], false);
        assert_eq!(group["members"][1]["target_ok"], true);
        assert_eq!(group["degraded"], false, "一次失败还不算降级");
        assert_eq!(body["items"][0]["degraded"], false);

        // 同一成员连续第二次失败：该组与整条链降级。
        save(fixture.a.clone(), a_id, false).await;
        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(body["items"][0]["groups"][0]["degraded"], true);
        assert_eq!(body["items"][0]["degraded"], true);
    }

    /// 旧 hops 请求（以及只传 hops 的 PATCH）继续可用：每组自动转成一台成员。
    #[tokio::test]
    async fn legacy_hops_requests_become_single_member_groups() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "旧请求",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 9001), (fixture.b.as_str(), 9002)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain = &value["chain"];
        assert_eq!(chain["groups"].as_array().unwrap().len(), 2);
        for group in chain["groups"].as_array().unwrap() {
            assert_eq!(group["strategy"], "round_robin");
            assert!(group["name"].is_null());
            let members = group["members"].as_array().unwrap();
            assert_eq!(members.len(), 1, "旧 hops 必须转成每组一台");
            assert_eq!(members[0]["priority"], 0);
            assert_eq!(members[0]["weight"], 1);
        }
        assert_eq!(chain["hops"].as_array().unwrap().len(), 2);

        // PATCH 只传旧 hops：整体替换为每组一台。
        let chain_id = chain["id"].as_str().unwrap();
        let chain_uri = format!("/api/v1/chains/{chain_id}");
        let (status, body) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::PATCH,
            &chain_uri,
            Some(json!({
                "hops": [
                    {"server_id": fixture.c, "listen_port": 9003},
                ]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["chain"]["groups"].as_array().unwrap().len(), 1);
        assert_eq!(
            body["chain"]["groups"][0]["members"][0]["server_id"],
            fixture.c.as_str()
        );
    }

    /// 组校验：策略枚举、组内成员数 1–8、组内/跨组重复服务器、组数与端口冲突。
    #[tokio::test]
    async fn group_validation_rejects_bad_strategy_member_count_and_duplicates() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        // 非法策略：中文错误 + 稳定 code。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "坏策略",
                "1.1.1.1",
                443,
                &[group(
                    None,
                    Some("random"),
                    &[group_member(&fixture.a, 9001, 0)],
                )],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.strategy_invalid");
        assert!(
            value["error"].as_str().unwrap().contains("只支持"),
            "中文错误: {value}"
        );
        assert_eq!(value["params"]["allowed"][0], "round_robin");

        // 空组 / 9 个成员。
        for members in [
            vec![],
            (0..9)
                .map(|index| group_member(&format!("s{index}"), 9000 + index, 0))
                .collect::<Vec<_>>(),
        ] {
            let (status, value) = request(
                &fixture.app,
                Some(&fixture.cookie),
                Method::POST,
                uri,
                Some(groups_body(
                    "成员数非法",
                    "1.1.1.1",
                    443,
                    &[group(None, None, &members)],
                )),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
            assert_eq!(value["code"], "chain.group_member_count_invalid");
        }

        // 同一组内同一台服务器出现两次。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "组内重复",
                "1.1.1.1",
                443,
                &[group(
                    None,
                    None,
                    &[
                        group_member(&fixture.a, 9001, 0),
                        group_member(&fixture.a, 9002, 1),
                    ],
                )],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.duplicate_group_member");

        // 同一台服务器出现在不同组。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "跨组重复",
                "1.1.1.1",
                443,
                &[
                    group(None, None, &[group_member(&fixture.a, 9001, 0)]),
                    group(None, None, &[group_member(&fixture.a, 9002, 0)]),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.duplicate_server");

        // 组数仍受 1–6 限制。
        let seven_groups = (0..7)
            .map(|index| group(None, None, &[group_member(&fixture.a, 9000 + index, 0)]))
            .collect::<Vec<_>>();
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body("七组", "1.1.1.1", 443, &seven_groups)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.hop_count_invalid");
    }

    /// 多成员组：上一跳的 DesiredForward 带下一组全部 targets，策略取下一组。
    #[tokio::test]
    async fn multi_member_group_targets_reach_desired_state() {
        let fixture = setup().await;

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(groups_body(
                "2×2",
                "1.1.1.1",
                443,
                &[
                    group(
                        None,
                        Some("failover"),
                        &[
                            group_member(&fixture.a, 9001, 0),
                            group_member(&fixture.b, 9002, 0),
                        ],
                    ),
                    group(
                        None,
                        Some("lowest_latency"),
                        &[
                            group_member(&fixture.c, 9003, 0),
                            group_member(&fixture.d, 9004, 1),
                        ],
                    ),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();

        let server_a = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.a)
            .await
            .unwrap();
        let rendered =
            super::super::desired::render(&fixture.state, &server_a, "https://panel.example.com")
                .await
                .unwrap();
        assert_eq!(rendered.forwards.len(), 1, "a 只收到自己这一条 forward");
        let forward = &rendered.forwards[0];
        assert_eq!(forward.id, chains::forward_id(&chain_id, 0, &fixture.a, 2));
        assert_eq!(forward.listen_port, 9001);
        assert_eq!(forward.strategy, ForwardStrategy::LowestLatency);
        assert_eq!(forward.targets.len(), 2, "下一组两台都给上去");
        assert_eq!(forward.targets[0].host, "10.0.0.3");
        assert_eq!(forward.targets[0].port, 9003);
        assert_eq!(forward.targets[0].server_id, fixture.c);
        assert_eq!(forward.targets[1].host, "10.0.0.4");
        assert_eq!(forward.targets[1].port, 9004);
        assert_eq!(forward.targets[1].server_id, fixture.d);

        // 出口组：没有 downstream，targets 为空，兼容字段指向链目标。
        let server_c = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.c)
            .await
            .unwrap();
        let rendered_c =
            super::super::desired::render(&fixture.state, &server_c, "https://panel.example.com")
                .await
                .unwrap();
        assert_eq!(rendered_c.forwards.len(), 1);
        assert!(rendered_c.forwards[0].targets.is_empty());
        assert_eq!(rendered_c.forwards[0].target_host, "1.1.1.1");
        assert_eq!(rendered_c.forwards[0].target_port, 443);
    }

    /// 链的引擎是链级字段：推导时逐跳透传，改引擎后重新推导即可切换。
    #[test]
    fn derived_forwards_carry_the_chain_engine() {
        let mut chain = test_chain("c-engine");
        chain.engine = "realm".into();
        let groups = vec![test_group(
            "c-engine",
            0,
            "round_robin",
            &[("srv-a", "10.0.0.1", 9001, 0)],
        )];

        let derived = derive_forwards(&chain, &groups);
        assert_eq!(derived.len(), 1);
        assert_eq!(derived[0].1.engine, ForwardEngine::Realm);

        // 非法的历史值按 native 读：不能因为一个脏值让整条链下发失败。
        chain.engine = "wireguard".into();
        assert_eq!(
            derive_forwards(&chain, &groups)[0].1.engine,
            ForwardEngine::Native
        );
    }

    /// 链级 UDP 开关：推导时透传到每一跳，与引擎一样是整条链共用的。
    #[test]
    fn derived_forwards_carry_the_chain_udp() {
        let mut chain = test_chain("c-udp");
        let groups = vec![
            test_group("c-udp", 0, "round_robin", &[("srv-a", "10.0.0.1", 9001, 0)]),
            test_group("c-udp", 1, "round_robin", &[("srv-b", "10.0.0.2", 9002, 0)]),
        ];

        // 缺省（历史数据）= 只开 TCP，行为与升级前一致。
        assert!(!chain.udp);
        let derived = derive_forwards(&chain, &groups);
        assert_eq!(derived.len(), 2);
        assert!(derived.iter().all(|(_, forward)| !forward.udp));

        // 开启后两跳都必须带 udp：链级开关不允许只开一半。
        chain.udp = true;
        let derived = derive_forwards(&chain, &groups);
        assert_eq!(derived.len(), 2);
        assert!(
            derived.iter().all(|(_, forward)| forward.udp),
            "链的 udp 必须透传到每一跳"
        );
    }

    /// 主控出口：链的 engine 要同时出现在 API 响应与每台服务器的期望态里。
    #[tokio::test]
    async fn chain_engine_reaches_api_and_desired_state() {
        let fixture = setup().await;

        let mut body = groups_body(
            "realm 链",
            "1.1.1.1",
            443,
            &[group(
                None,
                Some("round_robin"),
                &[group_member(&fixture.a, 9101, 0)],
            )],
        );
        body["engine"] = json!("realm");
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["chain"]["engine"], "realm", "响应必须带出 engine");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::GET,
            "/api/v1/chains",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["items"][0]["engine"], "realm");

        let server_a = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.a)
            .await
            .unwrap();
        let rendered =
            super::super::desired::render(&fixture.state, &server_a, "https://panel.example.com")
                .await
                .unwrap();
        assert_eq!(rendered.forwards.len(), 1);
        assert_eq!(
            rendered.forwards[0].engine,
            ForwardEngine::Realm,
            "链引擎必须透传到这一跳的 DesiredForward"
        );
        assert_eq!(
            rendered.forwards[0].id,
            chains::forward_id(&chain_id, 0, &fixture.a, 1)
        );

        // 切回 native：响应、期望态同步变化。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::PATCH,
            &format!("/api/v1/chains/{chain_id}"),
            Some(json!({"engine": "native"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["chain"]["engine"], "native");
        let rendered =
            super::super::desired::render(&fixture.state, &server_a, "https://panel.example.com")
                .await
                .unwrap();
        assert_eq!(rendered.forwards[0].engine, ForwardEngine::Native);

        // 不传 engine 的历史请求仍落 native。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(groups_body(
                "默认引擎",
                "1.1.1.1",
                443,
                &[group(
                    None,
                    Some("round_robin"),
                    &[group_member(&fixture.b, 9102, 0)],
                )],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["chain"]["engine"], "native");

        // 非法引擎：400 + 稳定错误码，链不落库。
        let mut bad = groups_body(
            "非法引擎",
            "1.1.1.1",
            443,
            &[group(
                None,
                Some("round_robin"),
                &[group_member(&fixture.c, 9103, 0)],
            )],
        );
        bad["engine"] = json!("wireguard");
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(bad),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.engine_invalid");
        let (_, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::GET,
            "/api/v1/chains",
            None,
        )
        .await;
        assert_eq!(
            value["items"].as_array().unwrap().len(),
            2,
            "非法引擎的链不能落库"
        );
    }

    /// 链的 UDP 开关：API 响应、列表、每台服务器的期望态三处一致，PATCH 能关掉。
    #[tokio::test]
    async fn chain_udp_reaches_api_and_every_hop() {
        let fixture = setup().await;
        let mut body = groups_body(
            "udp 链",
            "1.1.1.1",
            443,
            &[
                group(
                    None,
                    Some("round_robin"),
                    &[group_member(&fixture.a, 9101, 0)],
                ),
                group(
                    None,
                    Some("round_robin"),
                    &[group_member(&fixture.b, 9102, 0)],
                ),
            ],
        );
        body["udp"] = json!(true);
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["chain"]["udp"], true, "响应必须带出 udp");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();

        // 列表视图（chain_json 手写字段，最容易漏）。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::GET,
            "/api/v1/chains",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["items"][0]["udp"], true, "列表必须带出 udp");

        // 两跳的期望态都要带 udp=true，端口各自是自己的 listen_port。
        for (server_id, listen_port) in [(&fixture.a, 9101), (&fixture.b, 9102)] {
            let server = repo::servers::find_by_id(&fixture.state.db.pool, server_id)
                .await
                .unwrap();
            let rendered =
                super::super::desired::render(&fixture.state, &server, "https://panel.example.com")
                    .await
                    .unwrap();
            let hop = rendered
                .forwards
                .iter()
                .find(|forward| forward.id.starts_with(&format!("chain-{chain_id}-")))
                .expect("每一跳都要出现在自己的期望态里");
            assert!(hop.udp, "链的 udp 必须透传到这一跳");
            assert_eq!(hop.listen_port, listen_port);
        }

        // PATCH 关掉：false 不能被 COALESCE 当成「不改」。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::PATCH,
            &format!("/api/v1/chains/{chain_id}"),
            Some(json!({"udp": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["chain"]["udp"], false);

        let server_a = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.a)
            .await
            .unwrap();
        let rendered =
            super::super::desired::render(&fixture.state, &server_a, "https://panel.example.com")
                .await
                .unwrap();
        assert!(
            !rendered.forwards[0].udp,
            "关掉之后期望态必须同步回到只开 TCP"
        );

        // 不传 udp 的历史请求仍落 false。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(groups_body(
                "默认 udp",
                "1.1.1.1",
                443,
                &[group(
                    None,
                    Some("round_robin"),
                    &[group_member(&fixture.c, 9103, 0)],
                )],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["chain"]["udp"], false);
    }

    #[tokio::test]
    async fn chains_require_admin() {
        let fixture = setup().await;
        let user = repo::users::create(
            &fixture.state.db.pool,
            repo::users::NewUser {
                username: "bob".into(),
                password: "pw".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&fixture.state.db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);

        let (status, _) = request(
            &fixture.app,
            Some(&cookie),
            Method::GET,
            "/api/v1/chains",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = request(
            &fixture.app,
            Some(&cookie),
            Method::POST,
            "/api/v1/chains",
            Some(chain_body(
                "无权限",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 9001)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
