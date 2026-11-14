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
use std::net::IpAddr;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::chains::GroupStrategy;
use pierwave_domain::models::{
    Chain, ChainGroupMember, ChainGroupWithMembers, ChainWithGroups, ForwardStatusRow, Server,
};
use pierwave_domain::port_policy::PortPolicy;
use pierwave_domain::tunnel_security as tunnel_mode;
use pierwave_domain::{chains, engine, forwards, hop_transport, protocol, repo};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use pierwave_proto::{
    DesiredForward, ForwardEngine, ForwardProtocol, ForwardStrategy, ForwardTarget, TargetProbe,
    TunnelRole, TunnelSecurity, TunnelSpec, TunnelTargetRule,
};

/// 一条已通过校验的成员：带上服务器地址，供冲突提示与推导使用。
struct ValidatedMember {
    server_id: String,
    server_name: String,
    server_address: String,
    /// 该成员服务器的内网地址；组开关开启时用它替代 `server_address`。
    server_internal_address: Option<String>,
    listen_port: i64,
    priority: i64,
    weight: i64,
    /// 该服务器是否明确支持 nftables；未知按不支持处理。
    nftables_available: Option<bool>,
    /// 该服务器是否明确支持 P16 隧道；未知按不支持处理。
    tunnel_available: Option<bool>,
}

/// 一条已通过校验的组。
struct ValidatedGroup {
    name: Option<String>,
    strategy: GroupStrategy,
    /// 该组监听证书 id；入口组（seq = 0）必须为 `None`。
    cert_id: Option<String>,
    /// 入口组的公网展示端口；只用于展示，不参与下发。
    public_port: Option<i64>,
    /// 该组是否用成员服务器的内网地址被上一跳寻址。
    use_internal_address: bool,
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

/// 一台成员作为「下一跳」时实际使用的地址。
///
/// 下一组开启 `use_internal_address` 时用该成员服务器的 `internal_address`；
/// 保存路径已经保证它存在，期望态渲染也会用
/// [`chains::internal_address_blocked_reason`] 挡住缺失的链。这里的公网回退
/// 只针对手工改库 / 旧内存数据，正常 API 路径不会走到。
fn member_target_host(member: &ChainGroupMember, use_internal_address: bool) -> String {
    if !use_internal_address {
        return member.server_address.clone();
    }
    member
        .server_internal_address
        .as_deref()
        .map(str::trim)
        .filter(|address| !address.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| member.server_address.clone())
}

/// 组开关开启时，该组每一台成员都必须有内网地址；否则保存直接 400。
///
/// 入口组（seq = 0）没有上一跳，开关本身不产生地址变化；这里仍按「该组
/// 所有成员都填了」校验，保持前端「成员齐全才可勾选」的契约。
fn validate_internal_addresses(groups: &[ValidatedGroup]) -> AppResult<()> {
    for (seq, group) in groups.iter().enumerate() {
        if !group.use_internal_address {
            continue;
        }
        for member in &group.members {
            let has_address = member
                .server_internal_address
                .as_deref()
                .map(str::trim)
                .is_some_and(|address| !address.is_empty());
            if !has_address {
                return Err(AppError::coded(
                    "chain.internal_address_missing",
                    Some(json!({
                        "server": member.server_name,
                        "server_id": member.server_id,
                        "seq": seq,
                    })),
                    format!(
                        "服务器「{}」还没有填写内网地址，无法使用内网地址转发",
                        member.server_name
                    ),
                ));
            }
        }
    }
    Ok(())
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
        //
        // 内网地址开关属于**被寻址的那一组**：下一组开启时，本组下发的
        // target 用下一组成员的 internal_address 替代公网 address。
        let (target_host, target_port, targets) = match next {
            Some(next) => {
                let next_members = ordered_members(next);
                let use_internal = next.group.use_internal_address;
                match next_members.first() {
                    Some(first) => {
                        let targets = if next_members.len() > 1 {
                            next_members
                                .iter()
                                .map(|member| ForwardTarget {
                                    host: member_target_host(member, use_internal),
                                    port: member.listen_port,
                                    server_id: member.server_id.clone(),
                                })
                                .collect()
                        } else {
                            Vec::new()
                        };
                        (
                            member_target_host(first, use_internal),
                            first.listen_port,
                            targets,
                        )
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
                    // 协议同样是链级开关：每一跳在自己的 listen_port 上都按它监听。
                    protocol: ForwardProtocol::from_name(&chain.protocol),
                    // 旧 `udp` 位继续填镜像值：只用于兼容旧 Agent。
                    udp: protocol::is_both(&chain.protocol),
                    // transport 由 derive_forwards_with_transports 叠加：明文链保持 None。
                    listen_transport: None,
                    remote_transport: None,
                    disable_udp: false,
                    tunnel: None,
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
    /// 监听端口：入口组（seq = 0）必填；中间组省略时由主控从端口池分配。
    #[serde(default)]
    pub listen_port: Option<i64>,
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
    /// 该组 realm 监听证书；入口组（第一组）不允许填写。空串视为未填。
    #[serde(default)]
    pub cert_id: Option<String>,
    /// 入口组的公网展示端口（可选）；`null` / 省略 = 与入口成员监听端口相同。
    ///
    /// 只用于链列表 / 拓扑的入口展示，不参与下发；非入口组即使传了也会被忽略。
    #[serde(default)]
    pub public_port: Option<i64>,
    /// 该组是否用成员服务器的内网地址被上一跳寻址。
    ///
    /// 每组一个开关：开启后上一跳下发的 target 使用本组成员的
    /// `servers.internal_address`；组内任一成员没填内网地址时保存 400。
    /// 入口组（seq = 0）没有上一跳，开关保存后不产生地址变化。
    #[serde(default)]
    pub use_internal_address: bool,
    /// 组级监听端口（兼容契约）：成员自己没填时使用；中间组可省略。
    ///
    /// 多成员组的每个成员本来各有端口；组级值只是「都填同一个」的快捷写法，
    /// 省略时中间组的每个成员各自从所在服务器的端口池分配。
    #[serde(default)]
    pub listen_port: Option<i64>,
    /// 组的成员服务器列表（兼容契约）：`members` 为空时按顺序展开成单台成员。
    ///
    /// 新前端发 `members`；旧/简化客户端只发 `server_ids` 也能建链。
    #[serde(default)]
    pub server_ids: Vec<String>,
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
    /// 整条链的引擎：`native` / `realm` / `nftables`；缺省 = `native`。
    #[serde(default)]
    pub engine: Option<String>,
    /// 整条链的监听协议：`tcp`（缺省）/ `udp` / `both`。
    ///
    /// 不传时由旧 `udp` 布尔位推导（`true` → `both`），保证旧客户端语义不变。
    #[serde(default)]
    pub protocol: Option<String>,
    /// 旧字段：整条链是否同时监听 UDP；仅在没传 `protocol` 时生效。
    #[serde(default)]
    pub udp: bool,
    /// 跳间加密模式：`none`（缺省，明文）或 `tls`。
    #[serde(default)]
    pub transport: Option<String>,
    /// 隧道安全模式：`tls`（缺省）或 `noise`；只对 `engine = tunnel` 有意义。
    #[serde(default)]
    pub tunnel_security: Option<String>,
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
    /// `native` / `realm` / `nftables`；`None` = 不改。
    pub engine: Option<String>,
    /// `tcp` / `udp` / `both`；`None` = 不改。
    pub protocol: Option<String>,
    /// 旧字段：`None` = 不改；`Some(true)` → `both`、`Some(false)` → `tcp`。
    /// 同时传 `protocol` 时以 `protocol` 为准。
    pub udp: Option<bool>,
    /// `none` / `tls`；`None` = 不改。
    pub transport: Option<String>,
    /// `tls` / `noise`；`None` = 不改。
    pub tunnel_security: Option<String>,
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
            cert_id: None,
            public_port: None,
            use_internal_address: false,
            listen_port: None,
            server_ids: Vec::new(),
            members: vec![CreateChainMember {
                server_id: hop.server_id,
                listen_port: Some(hop.listen_port),
                priority: 0,
                weight: 1,
            }],
        })
        .collect()
}

/// 把一组输入展开成有效成员：`members` 优先，只有它为空时才用 `server_ids`。
///
/// 组级 `listen_port` 是成员缺省值；成员自己显式填的端口优先。这样
/// 旧请求（每台成员都带端口）逐字段不变，新请求可以只给入口组端口。
fn expanded_members(group: &CreateChainGroup) -> Vec<CreateChainMember> {
    if !group.members.is_empty() {
        return group
            .members
            .iter()
            .map(|member| CreateChainMember {
                server_id: member.server_id.clone(),
                listen_port: member.listen_port.or(group.listen_port),
                priority: member.priority,
                weight: member.weight,
            })
            .collect();
    }
    group
        .server_ids
        .iter()
        .enumerate()
        .map(|(index, server_id)| CreateChainMember {
            server_id: server_id.clone(),
            listen_port: group.listen_port,
            priority: index as i64,
            weight: 1,
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

/// 入口组对外端口只做范围校验：它不参与监听，也不与节点端口比较。
fn validate_public_port(port: i64) -> AppResult<()> {
    if (1..=65535).contains(&port) {
        Ok(())
    } else {
        Err(AppError::coded(
            "chain.public_port_invalid",
            Some(json!({ "min": 1, "max": 65535 })),
            "对外端口必须在 1-65535 之间",
        ))
    }
}

/// 校验组列表：组数、成员数、重复服务器、策略、端口范围/保留端口，以及与该服务器上
/// 节点 / 独立转发 / 其它链成员的端口冲突。
///
/// `listen_port` 的四种来源（优先级从高到低）：
/// 1. 成员显式填的端口（旧格式，逐字段兼容）；
/// 2. 组级 `listen_port`（兼容简化契约：多台成员共用同一个端口号）；
/// 3. PATCH 时该服务器在旧链里的端口（已有端口保持不变）；
/// 4. 中间组（seq >= 1）从端口池自动分配；入口组省略则 400。
///
/// 自动分配会先按服务器取出「forward + node + 其它链成员」占用集合，分配成功后
/// 立即写入集合，保证同一次保存内两组不会拿到同一个端口。
async fn resolve_groups(
    state: &AppState,
    inputs: &[CreateChainGroup],
    exclude_chain_id: Option<&str>,
    existing_groups: Option<&[ChainGroupWithMembers]>,
) -> AppResult<Vec<ValidatedGroup>> {
    chains::validate_group_count(inputs.len())?;

    // 先把兼容写法（members / server_ids）统一展开，后续只处理有效成员。
    let effective_members: Vec<Vec<CreateChainMember>> =
        inputs.iter().map(expanded_members).collect();

    // 先做纯字段校验（不查库），让「9 个成员」这类错误优先于「服务器不存在」。
    let server_ids_by_group: Vec<Vec<String>> = effective_members
        .iter()
        .map(|members| {
            members
                .iter()
                .map(|member| member.server_id.trim().to_string())
                .collect()
        })
        .collect();
    for (seq, server_ids) in server_ids_by_group.iter().enumerate() {
        chains::ensure_group_member_servers_unique(server_ids, seq as i64)?;
    }
    chains::ensure_chain_servers_unique(&server_ids_by_group)?;

    // 一条链里服务器不会重复（上面已校验），所以按 server_id 记录旧端口即可。
    // PATCH 只传了 groups 时，新增成员省略端口 → 分配新端口；已有成员省略端口 →
    // 保留它原来的端口。
    let existing_ports: HashMap<&str, i64> = existing_groups
        .into_iter()
        .flatten()
        .flat_map(|group| group.members.iter())
        .map(|member| (member.server_id.as_str(), member.listen_port))
        .collect();
    let mut occupied_by_server: HashMap<String, HashSet<i64>> = HashMap::new();

    let mut groups = Vec::with_capacity(inputs.len());
    for (seq, input) in inputs.iter().enumerate() {
        let seq = seq as i64;
        let members = &effective_members[seq as usize];
        chains::validate_group_member_count(members.len(), seq)?;
        let strategy = match input.strategy.as_deref() {
            Some(raw) => GroupStrategy::parse(raw)?,
            None => GroupStrategy::default(),
        };
        let name = chains::normalize_group_name(input.name.as_deref())?;
        let use_internal_address = input.use_internal_address;
        let cert_id = input
            .cert_id
            .as_deref()
            .map(str::trim)
            .filter(|cert| !cert.is_empty())
            .map(str::to_string);
        // 组级 public_port 只对入口组有意义；中间组的值没有展示位置，直接忽略。
        let public_port = match input.public_port {
            Some(port) if seq == 0 => {
                validate_public_port(port)?;
                Some(port)
            }
            _ => None,
        };

        let mut validated_members = Vec::with_capacity(members.len());
        for (index, member) in members.iter().enumerate() {
            let server_id = &server_ids_by_group[seq as usize][index];
            let server = load_server_for_hop(state, server_id).await?;
            let port_policy = PortPolicy::from_server(&server);

            let listen_port = match member.listen_port {
                Some(port) => {
                    forwards::validate_listen_port(port)?;
                    forwards::ensure_port_not_reserved(port)?;
                    // 手填端口同样受服务器的允许集合约束；不限制时是 no-op。
                    port_policy.ensure_allowed("chain.port_not_allowed", port, &server.name)?;
                    ensure_port_available(state, &server, port, exclude_chain_id).await?;
                    port
                }
                None => {
                    // 入口端口必须由用户明确给出：静默分配会让线上客户端失联。
                    chains::ensure_entry_port(seq, None)?;
                    if let Some(port) = existing_ports.get(server.id.as_str()).copied() {
                        // 更新链时保留旧端口；它已经在库里，跳过冲突检查以免
                        // 历史数据/并发写入把正常的“保存”卡死。端口策略只约束
                        // 本次新选择（手填 / 自动分配）的端口。
                        forwards::validate_listen_port(port)?;
                        forwards::ensure_port_not_reserved(port)?;
                        port
                    } else {
                        let occupied = match occupied_by_server.entry(server.id.clone()) {
                            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                            std::collections::hash_map::Entry::Vacant(entry) => entry.insert(
                                repo::chains::occupied_listen_ports(
                                    &state.db.pool,
                                    &server.id,
                                    exclude_chain_id,
                                )
                                .await?,
                            ),
                        };
                        let port = port_policy.allocate(&server.id, &server.name, occupied)?;
                        // 分配后立即加入集合：同一次保存内的后续组不会重复拿到它。
                        occupied.insert(port);
                        port
                    }
                }
            };

            validated_members.push(ValidatedMember {
                server_id: server.id,
                server_name: server.name,
                server_address: server.address,
                server_internal_address: server.internal_address,
                listen_port,
                priority: member.priority,
                weight: member.weight,
                nftables_available: server.nftables_available,
                tunnel_available: server.tunnel_available,
            });
        }

        groups.push(ValidatedGroup {
            name,
            strategy,
            cert_id,
            public_port,
            use_internal_address,
            members: validated_members,
        });
    }
    Ok(groups)
}

/// 一个显式端口是否和该服务器上的节点 / 独立转发 / 其它链成员冲突。
///
/// 错误码与文案保持原样（前端已经翻译过）；自动分配的端口不需要走这里，
/// 它从「已占用集合」里挑，天然避开这些冲突。
async fn ensure_port_available(
    state: &AppState,
    server: &Server,
    listen_port: i64,
    exclude_chain_id: Option<&str>,
) -> AppResult<()> {
    if let Some(node) = repo::nodes::find_by_port(&state.db.pool, &server.id, listen_port).await? {
        return Err(AppError::coded(
            "forward.port_conflict_node",
            Some(json!({
                "port": listen_port,
                "node": node.name,
                "node_id": node.id,
                "node_tag": node.tag,
                "server_id": server.id,
                "server_name": server.name,
            })),
            format!(
                "监听端口 {} 与服务器「{}」上的节点「{}」（tag {}）冲突",
                listen_port, server.name, node.name, node.tag
            ),
        ));
    }
    if let Some(forward) =
        repo::forwards::find_by_listen_port(&state.db.pool, &server.id, listen_port, None).await?
    {
        return Err(AppError::coded(
            "forward.port_conflict_forward",
            Some(json!({
                "port": listen_port,
                "name": forward.name,
                "id": forward.id,
                "server_id": server.id,
                "server_name": server.name,
            })),
            format!(
                "监听端口 {} 已被服务器「{}」上的转发规则「{}」占用",
                listen_port, server.name, forward.name
            ),
        ));
    }
    if let Some(conflict) = repo::chains::find_member_port_conflict(
        &state.db.pool,
        &server.id,
        listen_port,
        exclude_chain_id,
    )
    .await?
    {
        return Err(AppError::coded(
            "chain.port_conflict_hop",
            Some(json!({
                "port": listen_port,
                "chain_id": conflict.chain_id,
                "name": conflict.chain_name,
                "seq": conflict.seq + 1,
                "server_id": server.id,
                "server_name": server.name,
            })),
            format!(
                "监听端口 {} 已被服务器「{}」上的链「{}」第 {} 组占用",
                listen_port,
                server.name,
                conflict.chain_name,
                conflict.seq + 1
            ),
        ));
    }
    Ok(())
}

/// 用已保存的组构造同样的校验结构（PATCH 不改组时仍要检查自连）。
fn validated_from_existing(groups: &[ChainGroupWithMembers]) -> Vec<ValidatedGroup> {
    groups
        .iter()
        .map(|group| ValidatedGroup {
            name: group.group.name.clone(),
            strategy: GroupStrategy::from_db(&group.group.strategy),
            cert_id: group.group.cert_id.clone(),
            public_port: group.group.public_port,
            use_internal_address: group.group.use_internal_address,
            members: group
                .members
                .iter()
                .map(|member| ValidatedMember {
                    server_id: member.server_id.clone(),
                    server_name: member.server_name.clone(),
                    server_address: member.server_address.clone(),
                    server_internal_address: member.server_internal_address.clone(),
                    listen_port: member.listen_port,
                    priority: member.priority,
                    weight: member.weight,
                    nftables_available: member.nftables_available,
                    tunnel_available: member.tunnel_available,
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

/// 推导时携带的逐组 transport。
///
/// `derive_forwards` 只关心拓扑；transport 是「链级安全模式」的产物，单独叠加，
/// 明文链传空切片时逐字节保持旧行为。
pub(crate) fn derive_forwards_with_transports(
    chain: &Chain,
    groups: &[ChainGroupWithMembers],
    transports: &[hop_transport::HopTransport],
) -> Vec<(String, DesiredForward)> {
    let mut derived = derive_forwards(chain, groups);
    if transports.is_empty() {
        return derived;
    }

    let mut ordered: Vec<&ChainGroupWithMembers> = groups.iter().collect();
    ordered.sort_by_key(|group| group.group.seq);
    let mut index_by_server: HashMap<&str, usize> = HashMap::new();
    for (index, group) in ordered.iter().enumerate() {
        for member in &group.members {
            index_by_server.insert(member.server_id.as_str(), index);
        }
    }
    for (server_id, forward) in &mut derived {
        let Some(index) = index_by_server.get(server_id.as_str()) else {
            continue;
        };
        let Some(transport) = transports.get(*index) else {
            continue;
        };
        forward.listen_transport = transport.listen.clone();
        forward.remote_transport = transport.remote.clone();
        forward.disable_udp = transport.disable_udp;
    }
    derived
}

/// P16 隧道的链推导：2 跳链 → 入口 Dialer + 出口 Listener。
///
/// * 第 0 组（入口）每台成员一条 Dialer：公开监听自己的 `listen_port`，
///   每来一条客户端连接就用 TLS 连第 1 组唯一成员的 `listen_port`；
/// * 第 1 组（出口）唯一成员一条 Listener：接受隧道连接，只允许连链目标；
/// * `hop_secret` 由主控按 `HMAC(master_secret, "tunnel/{chain_id}/{1}")`
///   派生（`seq` = Listener 所在组），入口与出口拿到同一份；
/// * `allowed_targets` 两侧都是链目标：Dialer 把它作为首帧请求，
///   Listener 用它做白名单校验——任何一侧被篡改都连不到别的地址。
///
/// 返回值是 `(server_id, DesiredForward)`，与其它引擎的推导形状一致；
/// 证书材料（路径/内容）由 `desired::render` 另外放进 `DesiredState.files`。
pub(crate) fn derive_tunnel_forwards(
    chain: &Chain,
    groups: &[ChainGroupWithMembers],
    hop_secret_b64: &str,
) -> Vec<(String, DesiredForward)> {
    let mut ordered: Vec<&ChainGroupWithMembers> = groups.iter().collect();
    ordered.sort_by_key(|group| group.group.seq);
    let (Some(entry), Some(exit)) = (ordered.first(), ordered.get(1)) else {
        return Vec::new();
    };
    let (Some(entry_member), Some(exit_member)) = (entry.members.first(), exit.members.first())
    else {
        return Vec::new();
    };
    // 隧道也是「跳间」，出口组开启内网地址时 Dialer 连出口的内网地址；
    // allowed_targets 里的 remote 白名单必须与真实连接地址一致。
    let exit_host = member_target_host(exit_member, exit.group.use_internal_address);

    let hop_id = format!("{}:{}", chain.id, exit.group.seq);
    // `protocol = udp / both` 让隧道额外中继 UDP（P16.3）：两端同端口上
    // 起 QUIC datagram。`tcp` 链保持 udp=false，行为与升级前逐字节一致。
    let udp = protocol::allows_udp(&chain.protocol);
    // Noise 模式不需要任何证书/CA 文件：路径留空，Agent 据此完全不读文件
    // （空串是合法状态；TLS 模式仍按原路径下发，行为不变）。
    let noise = tunnel_mode::is_noise(&chain.tunnel_security);
    let security = if noise {
        TunnelSecurity::Noise
    } else {
        TunnelSecurity::Tls
    };
    let final_target_rule = TunnelTargetRule {
        host: chain.target_host.clone(),
        ports: Some((chain.target_port as u16, chain.target_port as u16)),
    };
    // Dialer：第一条约束 remote（下一跳 Listener），最后一条是每连接请求的
    // 链目标；Listener：只允许链目标。这样两侧都是 fail closed。
    let dialer_allowed = vec![
        TunnelTargetRule {
            host: exit_host.clone(),
            ports: Some((
                exit_member.listen_port as u16,
                exit_member.listen_port as u16,
            )),
        },
        final_target_rule.clone(),
    ];
    let listener_allowed = vec![final_target_rule];

    let mut derived = Vec::with_capacity(2);
    derived.push((
        entry_member.server_id.clone(),
        DesiredForward {
            id: chains::forward_id(
                &chain.id,
                entry.group.seq,
                &entry_member.server_id,
                entry.members.len(),
            ),
            listen_port: entry_member.listen_port,
            target_host: exit_host.clone(),
            target_port: exit_member.listen_port,
            targets: Vec::new(),
            strategy: Default::default(),
            engine: ForwardEngine::Tunnel,
            protocol: ForwardProtocol::Tcp,
            udp: false,
            listen_transport: None,
            remote_transport: None,
            disable_udp: false,
            tunnel: Some(TunnelSpec {
                role: TunnelRole::Dialer,
                hop_id: hop_id.clone(),
                listen: format!("0.0.0.0:{}", entry_member.listen_port),
                remote: host_port(&exit_host, exit_member.listen_port),
                security,
                cert_pem_path: String::new(),
                key_pem_path: String::new(),
                ca_pem_path: if noise {
                    String::new()
                } else {
                    crate::tunnel_cert::ca_path()
                },
                hop_secret: hop_secret_b64.to_string(),
                allowed_targets: dialer_allowed,
                udp,
            }),
        },
    ));
    derived.push((
        exit_member.server_id.clone(),
        DesiredForward {
            id: chains::forward_id(
                &chain.id,
                exit.group.seq,
                &exit_member.server_id,
                exit.members.len(),
            ),
            listen_port: exit_member.listen_port,
            target_host: chain.target_host.clone(),
            target_port: chain.target_port,
            targets: Vec::new(),
            strategy: Default::default(),
            engine: ForwardEngine::Tunnel,
            protocol: ForwardProtocol::Tcp,
            udp: false,
            listen_transport: None,
            remote_transport: None,
            disable_udp: false,
            tunnel: Some(TunnelSpec {
                role: TunnelRole::Listener,
                hop_id,
                listen: format!("0.0.0.0:{}", exit_member.listen_port),
                remote: String::new(),
                security,
                cert_pem_path: if noise {
                    String::new()
                } else {
                    crate::tunnel_cert::cert_path(&exit_member.server_id)
                },
                key_pem_path: if noise {
                    String::new()
                } else {
                    crate::tunnel_cert::key_path(&exit_member.server_id)
                },
                ca_pem_path: String::new(),
                hop_secret: hop_secret_b64.to_string(),
                allowed_targets: listener_allowed,
                udp,
            }),
        },
    ));
    derived
}

/// 拼接 `host:port`；IPv6 字面量必须加方括号，否则 Dialer 的
/// `SocketAddr` 解析会失败（虽然兼容分支也能拆，但方括号是标准写法）。
fn host_port(host: &str, port: i64) -> String {
    let host = host.trim();
    if host.parse::<IpAddr>().is_ok_and(|ip| ip.is_ipv6()) {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// tunnel 链的保存门禁：2 跳 / 每组 1 台 / 无 realm transport /
/// UDP 中继仅在 TLS 模式 / 所有成员都明确上报 `tunnel_available = true`。
///
/// 「未知」与 `false` 都拒绝：旧 Agent 收到 `engine = tunnel` 会因为不认识的
/// 枚举值让整份期望态解析失败，必须在写路径挡住。保存后成员能力可能变化
/// （换 Agent / 降级），下发路径由 [`pierwave_domain::chains::tunnel_blocked_reason`]
/// 再挡一次，两处语义一致。
fn validate_tunnel_chain(
    engine_name: &str,
    protocol: &str,
    transport: &str,
    tunnel_security: &str,
    groups: &[ValidatedGroup],
) -> AppResult<()> {
    if !engine::is_tunnel(engine_name) {
        return Ok(());
    }
    if groups.len() != 2 {
        return Err(AppError::coded(
            "chain.tunnel_requires_two_hops",
            Some(json!({ "hops": groups.len() })),
            format!(
                "tunnel 引擎当前只支持 2 跳链（入口 Dialer + 出口 Listener），当前 {} 跳",
                groups.len()
            ),
        ));
    }
    if let Some((seq, group)) = groups
        .iter()
        .enumerate()
        .find(|(_, group)| group.members.len() != 1)
    {
        return Err(AppError::coded(
            "chain.tunnel_single_member",
            Some(json!({ "seq": seq, "members": group.members.len() })),
            format!(
                "tunnel 引擎当前只支持每组 1 台成员（第 {} 组有 {} 台）",
                seq + 1,
                group.members.len()
            ),
        ));
    }
    // UDP 中继（P16.3）走 QUIC + TLS 证书；Noise 的 UDP 本轮不做，保存时
    // 直接拒绝，避免下发一个 Agent 必然启动失败的端点（fail closed）。
    if protocol::allows_udp(protocol) && tunnel_mode::is_noise(tunnel_security) {
        return Err(AppError::coded(
            "chain.tunnel_udp_requires_tls",
            Some(json!({
                "protocol": protocol,
                "tunnel_security": tunnel_mode::NOISE,
            })),
            "tunnel 的 UDP 中继需要 TLS 安全模式 / the tunnel UDP relay requires the TLS security mode（Noise 的 UDP 本轮不做 / Noise over UDP is not implemented yet）",
        ));
    }
    if hop_transport::is_tls(transport) {
        return Err(AppError::coded(
            "chain.tunnel_transport_conflict",
            Some(json!({ "transport": transport })),
            "tunnel 自带 TLS，不能再选择 realm 的 transport=tls",
        ));
    }
    let unsupported: Vec<&str> = groups
        .iter()
        .flat_map(|group| group.members.iter())
        .filter(|member| member.tunnel_available != Some(true))
        .map(|member| member.server_name.as_str())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if !unsupported.is_empty() {
        return Err(AppError::coded(
            "chain.tunnel_unavailable",
            Some(json!({ "servers": unsupported })),
            format!(
                "以下服务器的 Agent 不支持 tunnel 引擎（需要升级到带 tunnel 能力的版本）：{}",
                unsupported.join("、")
            ),
        ));
    }
    Ok(())
}

/// 保存时校验链的加密配置：结构规则 + 证书内容。
///
/// **不在这里拒绝「Agent 能力未知」**：服务器可能暂时离线，未知不等于不支持。
/// 保存后若仍不具备条件，`blocked_reason` 与 apply 的 warnings 会说明原因，
/// 下发时整链跳过（绝不回退明文）。
async fn validate_transport(
    state: &AppState,
    transport: &str,
    engine: &str,
    protocol: &str,
    groups: &[ValidatedGroup],
) -> AppResult<()> {
    let group_certs: Vec<Option<&str>> = groups
        .iter()
        .map(|group| group.cert_id.as_deref())
        .collect();
    hop_transport::validate_chain(transport, engine, protocol, &group_certs)?;
    if !hop_transport::is_tls(transport) {
        return Ok(());
    }
    for (seq, group) in groups.iter().enumerate().skip(1) {
        let cert_id = group.cert_id.as_deref().unwrap_or_default();
        let cert = repo::certificates::find_by_ids(&state.db.pool, &[cert_id.to_string()])
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| {
                AppError::coded(
                    "chain.tls_cert_not_found",
                    Some(json!({ "cert_id": cert_id, "seq": seq })),
                    format!("第 {} 组引用的证书不存在", seq + 1),
                )
            })?;
        hop_transport::validate_certificate(&cert, repo::now())?;
    }
    Ok(())
}

/// nftables 链的结构 / 能力门禁（保存与视图共用）。
///
/// * nftables 的 DNAT 只支持单目标；seq >= 1 的多成员组需要选路，当前不下发；
/// * 链上任意成员服务器没有明确上报 `nftables_available = true` 都拒绝，
///   避免旧 Agent 收到不认识的枚举值。
fn validate_nftables_chain(engine_name: &str, groups: &[ValidatedGroup]) -> AppResult<()> {
    if !engine::is_nftables(engine_name) {
        return Ok(());
    }
    if let Some((seq, _)) = groups
        .iter()
        .enumerate()
        .find(|(seq, group)| *seq >= 1 && group.members.len() > 1)
    {
        return Err(AppError::coded(
            "chain.nftables_multi_target",
            Some(json!({ "seq": seq + 1, "count": groups[seq].members.len() })),
            format!(
                "nftables 引擎暂不支持第 {} 组的多成员选路，请改成单成员组",
                seq + 1
            ),
        ));
    }
    let unsupported: Vec<&str> = groups
        .iter()
        .flat_map(|group| group.members.iter())
        .filter(|member| member.nftables_available != Some(true))
        .map(|member| member.server_name.as_str())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if !unsupported.is_empty() {
        let mut names = unsupported;
        names.sort_unstable();
        return Err(AppError::coded(
            "chain.nftables_unavailable",
            Some(json!({ "servers": names })),
            format!(
                "以下服务器没有可用的 nftables（需要安装 nft 并以 root 运行）：{}",
                names.join("、")
            ),
        ));
    }
    Ok(())
}

/// 链视图里的「为什么没下发」：capacity / 证书不满足时给用户看的原因。
///
/// 判定本身只有一份：[`pierwave_domain::chains::blocked_reason`]。这里只负责
/// 把证书批量读出来（仓储 `blocked_reasons` 一次 `IN (...)` 查完），
/// 与概览 `repo::overview` 的计数共用同一规则，不会再出现两套口径。
async fn chain_blocked_reason(
    state: &AppState,
    chain: &ChainWithGroups,
) -> AppResult<Option<pierwave_domain::chains::BlockedReason>> {
    let mut reasons =
        repo::chains::blocked_reasons(&state.db.pool, std::slice::from_ref(chain), repo::now())
            .await?;
    Ok(reasons.remove(&chain.chain.id))
}

fn new_groups(groups: &[ValidatedGroup]) -> Vec<repo::chains::NewChainGroup> {
    groups
        .iter()
        .map(|group| repo::chains::NewChainGroup {
            name: group.name.clone(),
            strategy: group.strategy.as_str().to_string(),
            cert_id: group.cert_id.clone(),
            public_port: group.public_port,
            use_internal_address: group.use_internal_address,
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

/// 读取一条 `forward_status` 行里的逐目标探测结果。
///
/// JSON 由仓储按 `pierwave_domain::repo::forwards::NewTargetProbe` 写入，
/// 与线协议的 `TargetProbe` 同形。旧 Agent 没有 targets（列为 NULL）或
/// 历史脏数据都按「未探测」处理，绝不让整条链视图 500。
fn status_target_probes(row: Option<&ForwardStatusRow>) -> Vec<TargetProbe> {
    row.and_then(|row| row.targets_json.as_deref())
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default()
}

/// 上一跳对某个成员的实测 RTT。
///
/// 一台成员可能被多台上一跳同时探测（上一组有多台成员），此时取**最小值**：
/// 链路的「第 i 段」应该代表最快可达的那条路径，而不是最慢的一次探测。
/// 没有任何上一跳成功测到它时返回 `None`（主控据此输出 null，不是 0ms）。
fn previous_hop_latency(
    statuses: &HashMap<String, ForwardStatusRow>,
    chain_id: &str,
    previous_group: &ChainGroupWithMembers,
    group: &ChainGroupWithMembers,
    member: &ChainGroupMember,
) -> Option<u32> {
    let multiple = group.members.len() > 1;
    ordered_members(previous_group)
        .into_iter()
        .filter_map(|previous| {
            let forward_id = member_forward_id(chain_id, previous, previous_group.members.len());
            status_target_probes(statuses.get(&forward_id))
                .into_iter()
                .filter(|probe| probe.ok)
                // 多成员组的目标一定带 server_id；单成员组走兼容字段时
                // Agent 拿不到 server_id（空串），按「唯一成员」匹配。
                .filter(|probe| {
                    if multiple {
                        probe.server_id == member.server_id
                    } else {
                        probe.server_id.is_empty() || probe.server_id == member.server_id
                    }
                })
                .filter_map(|probe| probe.latency_ms)
                .min()
        })
        .min()
}

/// 最后一跳成员到链目标的实测 RTT。
///
/// 链目标不是服务器，Agent 上报的 `server_id` 是空串；失败 / 未探测 = `None`。
fn chain_target_latency(
    statuses: &HashMap<String, ForwardStatusRow>,
    chain_id: &str,
    group: &ChainGroupWithMembers,
    member: &ChainGroupMember,
) -> Option<u32> {
    let forward_id = member_forward_id(chain_id, member, group.members.len());
    let probes = status_target_probes(statuses.get(&forward_id));
    probes
        .iter()
        .find(|probe| probe.server_id.is_empty())
        .or_else(|| probes.first())
        .filter(|probe| probe.ok)
        .and_then(|probe| probe.latency_ms)
}

/// 链视图：配置 + 每组/每个成员的运行状态（监听、目标可达、是否降级）。
///
/// 同时保留旧的 `hops` 数组（每组取排序后的第一台成员），让尚未升级的前端
/// 仍能展示/编辑单成员链；多成员组请读 `groups`。
fn chain_json(chain: &ChainWithGroups, statuses: &HashMap<String, ForwardStatusRow>) -> Value {
    let mut group_views = Vec::with_capacity(chain.groups.len());
    let mut hop_views = Vec::with_capacity(chain.groups.len());
    let mut degraded = false;
    // `path_mode` 只看「每组几台 + 多成员组的策略」；`total_latency_ms`
    // 只在单路径（single）时有意义，多路径下不冒充一个确定值。
    let path_mode = chains::path_mode(
        chain
            .groups
            .iter()
            .map(|group| (group.group.strategy.as_str(), group.members.len())),
    );
    // 各段延迟之和；任何一段缺数据就整体为 None（不能把未知当 0ms）。
    // 空链（脏数据）没有段可加，同样是 None 而不是 0。
    let mut total_latency: Option<u64> = if chain.groups.is_empty() {
        None
    } else {
        Some(0)
    };

    for (group_index, group) in chain.groups.iter().enumerate() {
        let previous_group = group_index
            .checked_sub(1)
            .and_then(|index| chain.groups.get(index));
        let is_last_group = group_index + 1 == chain.groups.len();
        let mut member_views = Vec::with_capacity(group.members.len());
        let mut group_degraded = false;
        if group.members.is_empty() {
            total_latency = None;
        }
        for member in ordered_members(group) {
            let forward_id = member_forward_id(&chain.chain.id, member, group.members.len());
            let status = statuses.get(&forward_id);
            let member_degraded =
                status.is_some_and(|row| chains::is_degraded(row.target_fail_count));
            group_degraded |= member_degraded;
            // 第 i 跳成员：取上一跳（可能多台）对它的实测 RTT，取最小值。
            let latency_ms = previous_group.and_then(|previous| {
                previous_hop_latency(statuses, &chain.chain.id, previous, group, member)
            });
            // 最后一跳成员：到链目标的实测 RTT；其它组为 null。
            let target_latency_ms = if is_last_group {
                chain_target_latency(statuses, &chain.chain.id, group, member)
            } else {
                None
            };
            if let Some(total) = total_latency.as_mut() {
                let mut sum = *total;
                let mut complete = true;
                // 首组没有「上一跳」段；其余每组都必须有值才能相加。
                if group_index > 0 {
                    match latency_ms {
                        Some(value) => sum += u64::from(value),
                        None => complete = false,
                    }
                }
                if is_last_group {
                    match target_latency_ms {
                        Some(value) => sum += u64::from(value),
                        None => complete = false,
                    }
                }
                if complete {
                    *total = sum;
                } else {
                    total_latency = None;
                }
            }
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
                "target_error": status.and_then(|row| row.target_error.clone()),
                "degraded": member_degraded,
                "error": status.map(|row| row.error.as_str()).unwrap_or(""),
                "updated_at": status.map(|row| row.updated_at),
                // 服务器最后一次心跳（ISO8601 UTC）；从未连过 / 旧数据 = null。
                "last_seen_at": member
                    .last_seen_at
                    .and_then(pierwave_domain::time::rfc3339_utc),
                // 每跳累计流量：None = 该引擎没有数据源（realm）或旧 Agent，
                // 绝不能把「未知」写成 0。
                "traffic_in": status.and_then(|row| row.traffic_in),
                "traffic_out": status.and_then(|row| row.traffic_out),
                // 上一跳 → 本成员这一段的实测 RTT（最小值）；无数据 = null。
                "latency_ms": latency_ms,
                // 仅最后一跳：本成员 → 链目标的实测 RTT；其它组为 null。
                "target_latency_ms": target_latency_ms,
            }));
        }
        degraded |= group_degraded;

        // 组级 `listen_port` 是便捷字段：单成员组就是该成员的端口；多成员组取
        // 第一台（与兼容用的 `hops` 视图一致）。每个成员的精确端口仍在 `members`。
        let group_listen_port = ordered_members(group)
            .first()
            .map(|member| member.listen_port);
        group_views.push(json!({
            "id": group.group.id,
            "seq": group.group.seq,
            "name": group.group.name,
            "strategy": group.group.strategy,
            "cert_id": group.group.cert_id,
            "public_port": group.group.public_port,
            "use_internal_address": group.group.use_internal_address,
            "listen_port": group_listen_port,
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
                "target_error": status.and_then(|row| row.target_error.clone()),
                "degraded": status.is_some_and(|row| chains::is_degraded(row.target_fail_count)),
                "error": status.map(|row| row.error.as_str()).unwrap_or(""),
                "updated_at": status.map(|row| row.updated_at),
            }));
        }
    }

    let total_latency_ms = if path_mode == chains::PATH_SINGLE {
        total_latency.and_then(|total| u32::try_from(total).ok())
    } else {
        None
    };

    json!({
        "id": chain.chain.id,
        "name": chain.chain.name,
        "target_host": chain.chain.target_host,
        "target_port": chain.chain.target_port,
        "enabled": chain.chain.enabled,
        "engine": chain.chain.engine,
        "protocol": chain.chain.protocol,
        "udp": chain.chain.udp,
        "transport": chain.chain.transport,
        "tunnel_security": chain.chain.tunnel_security,
        "degraded": degraded,
        // single | multi | hash：前端据此决定是否画「合计」。
        "path_mode": path_mode,
        // 只有 single 时是各段之和；缺任何一段数据、或非单路径都为 null。
        "total_latency_ms": total_latency_ms,
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
    // 一次批量读证书，逐链只做纯判定；不要退回循环里按链查库。
    let blocked = repo::chains::blocked_reasons(&state.db.pool, &chains_list, repo::now()).await?;
    let mut items = Vec::with_capacity(chains_list.len());
    for chain in &chains_list {
        let mut view = chain_json(chain, &statuses);
        if let Some(reason) = blocked.get(&chain.chain.id) {
            view["blocked_code"] = json!(reason.code);
            view["blocked_reason"] = json!(reason.message);
        }
        items.push(view);
    }
    Ok(Json(json!({ "items": items })))
}

/// 延迟历史的时间窗口：1..=168 小时（默认 24）。
const LATENCY_MIN_HOURS: i64 = 1;
const LATENCY_MAX_HOURS: i64 = 168;
const LATENCY_DEFAULT_HOURS: i64 = 24;

#[derive(Debug, Deserialize)]
pub struct LatencyQuery {
    /// 故意接成字符串：`hours=abc` 也要返回带 code 的 400，
    /// 而不是 axum 默认的纯文本 Query 拒绝。
    hours: Option<String>,
}

fn invalid_latency_hours() -> AppError {
    AppError::coded(
        "chain.latency_hours_invalid",
        Some(json!({"min": LATENCY_MIN_HOURS, "max": LATENCY_MAX_HOURS})),
        format!(
            "hours 必须是 {LATENCY_MIN_HOURS}-{LATENCY_MAX_HOURS} 之间的整数（默认 {LATENCY_DEFAULT_HOURS}）"
        ),
    )
}

/// 解析 `hours`：缺省/空白 = 24；非整数或越界 = 400。
fn parse_latency_hours(raw: Option<&str>) -> AppResult<i64> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(LATENCY_DEFAULT_HOURS);
    };
    let hours = raw.parse::<i64>().map_err(|_| invalid_latency_hours())?;
    if !(LATENCY_MIN_HOURS..=LATENCY_MAX_HOURS).contains(&hours) {
        return Err(invalid_latency_hours());
    }
    Ok(hours)
}

/// `forward_id -> (目标跳 seq, 目标成员 server_id)`，只用于单成员下一跳。
///
/// 单成员组下发时走兼容字段（`targets` 为空），Agent 拿不到 server_id，
/// 探测结果里的 `target_server_id` 是空串。主控知道这个 forward 的下一组
/// 只有一台成员，可以在读历史时把它映射回来；多成员组 Agent 会上报真实
/// server_id，直接按成员表匹配即可。
fn single_target_map(chain: &ChainWithGroups) -> HashMap<String, (i64, String)> {
    let mut map = HashMap::new();
    for (index, group) in chain.groups.iter().enumerate() {
        let Some(next) = chain.groups.get(index + 1) else {
            // 最后一跳的目标是链目标（不是服务器），没有成员可归属。
            continue;
        };
        if next.members.len() != 1 {
            continue;
        }
        let Some(target) = next.members.first() else {
            continue;
        };
        for member in &group.members {
            let forward_id = member_forward_id(&chain.chain.id, member, group.members.len());
            map.insert(forward_id, (next.group.seq, target.server_id.clone()));
        }
    }
    map
}

/// `GET /api/v1/chains/{id}/latency?hours=24`
///
/// 口径：只统计**跳与跳之间**的成功探测；每个 5 分钟桶对同一跳的所有成员取
/// 中位数（见 [`chains::aggregate_latency`]）。最后一跳 → 链目标的 RTT 不是
/// 服务器间链路，不进入历史；入口组没有上一跳，也不会有点。
pub async fn latency(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(query): Query<LatencyQuery>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let hours = parse_latency_hours(query.hours.as_deref())?;
    let chain = repo::chains::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("chain.not_found", None, "链不存在"))?;

    let since = repo::now() - hours * 60 * 60;
    let mut forward_ids = Vec::new();
    let mut seq_by_server: HashMap<String, i64> = HashMap::new();
    for group in &chain.groups {
        for member in &group.members {
            seq_by_server.insert(member.server_id.clone(), group.group.seq);
            forward_ids.push(member_forward_id(
                &chain.chain.id,
                member,
                group.members.len(),
            ));
        }
    }
    let single_targets = single_target_map(&chain);
    let samples = repo::latency::list_for_forwards(&state.db.pool, &forward_ids, since).await?;

    let mut points = Vec::with_capacity(samples.len());
    for sample in samples {
        let (seq, server_id) = if sample.target_server_id.is_empty() {
            match single_targets.get(&sample.forward_id) {
                Some((seq, server_id)) => (*seq, server_id.clone()),
                None => continue,
            }
        } else {
            match seq_by_server.get(&sample.target_server_id) {
                Some(seq) => (*seq, sample.target_server_id.clone()),
                // 链改过成员后残留的历史样本：目标已不在这条链里，跳过。
                None => continue,
            }
        };
        points.push(chains::LatencyPoint {
            ts: sample.ts,
            seq,
            server_id,
            latency_ms: sample.latency_ms,
        });
    }

    let points = chains::aggregate_latency(&points, chains::LATENCY_BUCKET_SECS);
    let points: Vec<Value> = points
        .into_iter()
        .map(|point| {
            json!({
                "ts": point.ts,
                "seq": point.seq,
                "server_id": point.server_id,
                "latency_ms": point.latency_ms,
            })
        })
        .collect();
    Ok(Json(json!({ "points": points })))
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
        protocol: raw_protocol,
        udp,
        transport: raw_transport,
        tunnel_security: raw_tunnel_security,
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
    let protocol = match raw_protocol.as_deref() {
        Some(raw) => protocol::normalize_chain(raw)?,
        None => protocol::from_legacy_udp(udp).to_string(),
    };
    let transport =
        hop_transport::normalize(raw_transport.as_deref().unwrap_or(hop_transport::DEFAULT))?;
    let tunnel_security = tunnel_mode::normalize(
        raw_tunnel_security
            .as_deref()
            .unwrap_or(tunnel_mode::DEFAULT),
    )?;

    // 新字段优先；没传 groups 时把旧 hops 转成「每组一台」。
    let inputs = if groups.is_empty() {
        groups_from_hops(hops)
    } else {
        groups
    };
    let groups = resolve_groups(&state, &inputs, None, None).await?;
    validate_internal_addresses(&groups)?;
    ensure_targets_safe(&groups, &target_host, target_port)?;
    validate_nftables_chain(&engine, &groups)?;
    validate_tunnel_chain(&engine, &protocol, &transport, &tunnel_security, &groups)?;
    validate_transport(&state, &transport, &engine, &protocol, &groups).await?;
    // TLS + UDP 的冲突优先于「realm 固定双开」：用户选了加密链时，
    // 更具体的 chain.protocol_udp_with_tls 才是能指导修复的错误。
    protocol::ensure_realm_supported(&protocol, &engine)?;

    let chain = repo::chains::create(
        &state.db.pool,
        repo::chains::NewChain {
            name,
            target_host,
            target_port,
            enabled,
            engine,
            protocol,
            transport,
            tunnel_security,
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
            "protocol": &chain.chain.protocol,
            "udp": chain.chain.udp,
            "transport": &chain.chain.transport,
            "tunnel_security": &chain.chain.tunnel_security,
            "hops": chain.groups.iter().map(|group| json!({
                "seq": group.group.seq,
                "server_id": group.members.first().map(|member| &member.server_id),
                "listen_port": group.members.first().map(|member| member.listen_port),
            })).collect::<Vec<_>>(),
            "groups": chain.groups.iter().map(|group| json!({
                "seq": group.group.seq,
                "name": &group.group.name,
                "strategy": &group.group.strategy,
                "cert_id": &group.group.cert_id,
                "public_port": group.group.public_port,
                "use_internal_address": group.group.use_internal_address,
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
    let mut view = chain_json(&chain, &statuses);
    if let Some(reason) = chain_blocked_reason(&state, &chain).await? {
        view["blocked_code"] = json!(reason.code);
        view["blocked_reason"] = json!(reason.message);
    }
    Ok(Json(json!({ "chain": view })))
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
        protocol: raw_protocol,
        udp,
        transport: raw_transport,
        tunnel_security: raw_tunnel_security,
        hops,
        groups,
    } = req;

    if raw_name.is_none()
        && raw_target_host.is_none()
        && target_port.is_none()
        && enabled.is_none()
        && raw_engine.is_none()
        && raw_protocol.is_none()
        && udp.is_none()
        && raw_transport.is_none()
        && raw_tunnel_security.is_none()
        && hops.is_none()
        && groups.is_none()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供 name / target_host / target_port / enabled / engine / protocol / udp / transport / tunnel_security / groups / hops 之一",
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
    let protocol = match raw_protocol.as_deref() {
        Some(raw) => Some(protocol::normalize_chain(raw)?),
        None => udp.map(|udp| protocol::from_legacy_udp(udp).to_string()),
    };
    let transport = match raw_transport.as_deref() {
        Some(raw) => Some(hop_transport::normalize(raw)?),
        None => None,
    };
    let tunnel_security = match raw_tunnel_security.as_deref() {
        Some(raw) => Some(tunnel_mode::normalize(raw)?),
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
        Some(inputs) => {
            resolve_groups(
                &state,
                &inputs,
                Some(&existing.chain.id),
                Some(&existing.groups),
            )
            .await?
        }
        None => validated_from_existing(&existing.groups),
    };
    validate_internal_addresses(&groups)?;
    ensure_targets_safe(&groups, final_target_host, final_target_port)?;
    let final_engine = engine.as_deref().unwrap_or(&existing.chain.engine);
    let final_transport = transport.as_deref().unwrap_or(&existing.chain.transport);
    let final_protocol = protocol.as_deref().unwrap_or(&existing.chain.protocol);
    let final_tunnel_security = tunnel_security
        .as_deref()
        .unwrap_or(&existing.chain.tunnel_security);
    // 只在「安全相关的字段真的被改」时校验证书内容：证书过期后仍然要允许
    // 用户改名/停用/删除这条链，否则会被卡在一个无法自救的状态里。
    let security_changed = raw_transport.is_some()
        || raw_tunnel_security.is_some()
        || engine.is_some()
        || replace_groups
        || protocol.is_some();
    if security_changed {
        validate_nftables_chain(final_engine, &groups)?;
        validate_tunnel_chain(
            final_engine,
            final_protocol,
            final_transport,
            final_tunnel_security,
            &groups,
        )?;
        validate_transport(
            &state,
            final_transport,
            final_engine,
            final_protocol,
            &groups,
        )
        .await?;
        protocol::ensure_realm_supported(final_protocol, final_engine)?;
    }

    let updated = repo::chains::update(
        &state.db.pool,
        &id,
        repo::chains::UpdateChain {
            name,
            target_host,
            target_port,
            enabled,
            engine,
            protocol,
            transport,
            tunnel_security,
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
        (
            "protocol",
            json!(&existing.chain.protocol),
            json!(&updated.chain.protocol),
        ),
        ("udp", json!(existing.chain.udp), json!(updated.chain.udp)),
        (
            "transport",
            json!(&existing.chain.transport),
            json!(&updated.chain.transport),
        ),
        (
            "tunnel_security",
            json!(&existing.chain.tunnel_security),
            json!(&updated.chain.tunnel_security),
        ),
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
    let mut view = chain_json(&updated, &statuses);
    if let Some(reason) = chain_blocked_reason(&state, &updated).await? {
        view["blocked_code"] = json!(reason.code);
        view["blocked_reason"] = json!(reason.message);
    }
    Ok(Json(json!({ "chain": view })))
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

    use pierwave_domain::chains::plan_from_certificates;
    use pierwave_domain::models::{Certificate, Chain};
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

    /// 中间组成员：省略 `listen_port`，由主控从端口池分配。
    fn auto_port_member(server_id: &str, priority: i64) -> Value {
        json!({
            "server_id": server_id,
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
                public_port: None,
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
            protocol: "tcp".into(),
            udp: false,
            transport: "none".into(),
            tunnel_security: "tls".into(),
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
                cert_id: None,
                public_port: None,
                use_internal_address: false,
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
                        server_internal_address: None,
                        listen_port: *listen_port,
                        priority: *priority,
                        weight: 1,
                        realm_transport: Some(true),
                        nftables_available: Some(true),
                        tunnel_available: Some(true),
                        // 测试 fixture 不关心心跳时间；链视图必须能处理 null。
                        last_seen_at: None,
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
                protocol: "tcp".into(),
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
        let save =
            |target_ok: Option<bool>, target_error: Option<&'static str>, listening: bool| {
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
                            target_error: target_error.map(str::to_string),
                            targets: Vec::new(),
                            traffic_in: None,
                            traffic_out: None,
                        }],
                    )
                    .await
                    .unwrap();
                }
            };

        // 第一次 false：不降级；握手失败原因原样带出（前端负责翻译）。
        save(Some(false), Some("cert_expired"), true).await;
        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        let hop = &body["items"][0]["hops"][0];
        assert_eq!(hop["target_ok"], false);
        assert_eq!(
            hop["target_error"], "cert_expired",
            "链跳状态必须带出握手失败原因码"
        );
        assert_eq!(hop["listening"], true, "监听成功与目标可达是两件事");
        assert_eq!(hop["degraded"], false);
        assert_eq!(body["items"][0]["degraded"], false);

        // 第二次 false：跳与链都降级。
        save(Some(false), Some("cert_expired"), true).await;
        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(body["items"][0]["hops"][0]["degraded"], true);
        assert_eq!(body["items"][0]["degraded"], true);

        // 恢复：降级立刻清除，失败原因不能残留。
        save(Some(true), None, true).await;
        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(body["items"][0]["hops"][0]["target_ok"], true);
        assert!(
            body["items"][0]["hops"][0]["target_error"].is_null(),
            "握手成功后 target_error 必须是 null，不能残留上一轮原因"
        );
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

    /// nftables 链：能力 + 单成员组两个门禁，成功后视图不带 blocked_reason。
    #[tokio::test]
    async fn nftables_chain_requires_capability_and_single_member_groups() {
        let fixture = setup().await;
        set_nftables_capability(&fixture.state, &fixture.a, Some(true)).await;
        set_nftables_capability(&fixture.state, &fixture.b, Some(true)).await;

        let mut body = groups_body(
            "nft 链",
            "10.0.0.9",
            443,
            &[
                group(
                    None,
                    Some("round_robin"),
                    &[group_member(&fixture.a, 30001, 0)],
                ),
                group(
                    None,
                    Some("round_robin"),
                    &[group_member(&fixture.b, 30002, 0)],
                ),
            ],
        );
        body["engine"] = json!("nftables");
        let (status, response) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {response}");

        let (status, list) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::GET,
            "/api/v1/chains",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let item = list["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == "nft 链")
            .unwrap();
        assert!(item.get("blocked_reason").is_none(), "{item}");

        // 第 2 组多成员：nftables 当前不支持选路。
        let mut multi = groups_body(
            "nft 多成员",
            "10.0.0.9",
            443,
            &[
                group(
                    None,
                    Some("round_robin"),
                    &[group_member(&fixture.a, 30011, 0)],
                ),
                group(
                    None,
                    Some("round_robin"),
                    &[
                        group_member(&fixture.b, 30012, 0),
                        group_member(&fixture.c, 30013, 0),
                    ],
                ),
            ],
        );
        multi["engine"] = json!("nftables");
        let (status, response) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(multi),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {response}");
        assert_eq!(response["code"], "chain.nftables_multi_target");

        // 能力不满足：已保存的链在视图里给出 blocked_reason；新保存直接拒绝。
        set_nftables_capability(&fixture.state, &fixture.b, None).await;
        let (_, list) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::GET,
            "/api/v1/chains",
            None,
        )
        .await;
        let blocked = list["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == "nft 链")
            .unwrap();
        assert_eq!(blocked["blocked_code"], "chain.nftables_unavailable");
        assert!(
            blocked["blocked_reason"]
                .as_str()
                .unwrap()
                .contains("nftables"),
            "{blocked}"
        );

        let mut unsupported = groups_body(
            "nft 无能力",
            "10.0.0.9",
            443,
            &[
                group(
                    None,
                    Some("round_robin"),
                    &[group_member(&fixture.a, 30021, 0)],
                ),
                group(
                    None,
                    Some("round_robin"),
                    &[group_member(&fixture.b, 30022, 0)],
                ),
            ],
        );
        unsupported["engine"] = json!("nftables");
        let (status, response) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(unsupported),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {response}");
        assert_eq!(response["code"], "chain.nftables_unavailable");
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
        let save = |server_id: String,
                    forward_id: String,
                    target_ok: bool,
                    target_error: Option<&'static str>| {
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
                        target_error: target_error.map(str::to_string),
                        targets: Vec::new(),
                        traffic_in: None,
                        traffic_out: None,
                    }],
                )
                .await
                .unwrap();
            }
        };
        save(
            fixture.a.clone(),
            a_id.clone(),
            false,
            Some("name_mismatch"),
        )
        .await;
        save(fixture.b.clone(), b_id.clone(), true, None).await;

        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        let group = &body["items"][0]["groups"][0];
        assert_eq!(group["members"][0]["target_ok"], false);
        assert_eq!(group["members"][1]["target_ok"], true);
        assert_eq!(
            group["members"][0]["target_error"], "name_mismatch",
            "多成员组的成员行也要带出握手失败原因"
        );
        assert!(
            group["members"][1]["target_error"].is_null(),
            "成功的成员不能凭空多出原因"
        );
        assert_eq!(group["degraded"], false, "一次失败还不算降级");
        assert_eq!(body["items"][0]["degraded"], false);

        // 同一成员连续第二次失败：该组与整条链降级。
        save(fixture.a.clone(), a_id, false, Some("name_mismatch")).await;
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

    /// 入口组对外端口只用于展示：API 带出该值，监听端口 / 下发字段不变。
    #[tokio::test]
    async fn entry_group_public_port_is_display_only() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let mut entry = group(None, None, &[group_member(&fixture.a, 9001, 0)]);
        entry["public_port"] = json!(40001);
        let mut middle = group(None, None, &[group_member(&fixture.b, 9002, 0)]);
        // 非入口组即使传了也不会落库，避免出现没有展示位置的脏值。
        middle["public_port"] = json!(40002);

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body("NAT 入口", "1.1.1.1", 443, &[entry, middle])),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain = &value["chain"];
        assert_eq!(chain["groups"][0]["public_port"], 40001);
        assert_eq!(chain["groups"][0]["listen_port"], 9001);
        assert_eq!(chain["groups"][0]["members"][0]["listen_port"], 9001);
        assert!(
            chain["groups"][1]["public_port"].is_null(),
            "非入口组的 public_port 必须被忽略：{chain}"
        );

        // 范围错误返回稳定的 400 code。
        let mut bad = group(None, None, &[group_member(&fixture.a, 9011, 0)]);
        bad["public_port"] = json!(70_000);
        let (status, body) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body("坏端口", "1.1.1.1", 443, &[bad])),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "chain.public_port_invalid", "{body}");
    }

    /// 中间组省略端口：创建成功，端口由主控从 20000-29999 分配并写回。
    #[tokio::test]
    async fn intermediate_groups_get_ports_from_the_pool() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "只填首尾",
                "1.1.1.1",
                443,
                &[
                    group(None, None, &[group_member(&fixture.a, 9001, 0)]),
                    group(None, None, &[auto_port_member(&fixture.b, 0)]),
                    group(None, None, &[auto_port_member(&fixture.c, 0)]),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain = &value["chain"];
        assert_eq!(chain["groups"][0]["listen_port"], 9001, "入口端口原样保留");
        for group in &chain["groups"].as_array().unwrap()[1..] {
            let port = group["listen_port"].as_i64().unwrap();
            assert!(
                (chains::PORT_POOL_START..=chains::PORT_POOL_END).contains(&port),
                "中间组端口 {port} 必须落在端口池内"
            );
            assert_eq!(
                group["members"][0]["listen_port"].as_i64(),
                Some(port),
                "成员端口与组级字段一致"
            );
        }
        // 两台不同的中间服务器都从池起点开始，各自拿到 20000。
        assert_eq!(chain["groups"][1]["listen_port"], 20000);
        assert_eq!(chain["groups"][2]["listen_port"], 20000);

        // 列表/编辑读取同样的值：前端下次打开仍能看到实际分配的端口。
        let chain_id = chain["id"].as_str().unwrap();
        let (status, listed) =
            request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {listed}");
        let item = listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == chain_id)
            .unwrap();
        assert_eq!(item["groups"][1]["listen_port"], 20000);
        assert_eq!(item["groups"][2]["listen_port"], 20000);
    }

    /// 兼容简化契约：组级 `listen_port` + `server_ids`（不带 members）也能建链。
    #[tokio::test]
    async fn group_level_port_and_server_ids_shorthand_work() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "简写请求",
                "1.1.1.1",
                443,
                &[
                    json!({"server_ids": [fixture.a], "listen_port": 9101}),
                    json!({"server_ids": [fixture.b], "strategy": "failover"}),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain = &value["chain"];
        assert_eq!(chain["groups"][0]["listen_port"], 9101);
        assert_eq!(
            chain["groups"][0]["members"][0]["server_id"],
            fixture.a.as_str()
        );
        assert_eq!(chain["groups"][1]["strategy"], "failover");
        assert_eq!(chain["groups"][1]["listen_port"], 20000);
    }

    /// 入口组仍然必须显式给端口：不允许静默改成池里的某个值。
    #[tokio::test]
    async fn entry_group_without_a_port_is_rejected() {
        let fixture = setup().await;

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(groups_body(
                "入口缺端口",
                "1.1.1.1",
                443,
                &[
                    group(None, None, &[auto_port_member(&fixture.a, 0)]),
                    group(None, None, &[auto_port_member(&fixture.b, 0)]),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.entry_port_required");
    }

    /// 同一台服务器上的两条链各自分配，不会撞同一个端口。
    #[tokio::test]
    async fn two_chains_on_the_same_server_get_distinct_ports() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let body = |name: &str, entry: &str, entry_port: i64| {
            groups_body(
                name,
                "1.1.1.1",
                443,
                &[
                    group(None, None, &[group_member(entry, entry_port, 0)]),
                    group(None, None, &[auto_port_member(&fixture.b, 0)]),
                ],
            )
        };

        let (status, first) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(body("第一条", &fixture.a, 9201)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {first}");
        let (status, second) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(body("第二条", &fixture.c, 9202)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {second}");

        let first_port = first["chain"]["groups"][1]["listen_port"].as_i64().unwrap();
        let second_port = second["chain"]["groups"][1]["listen_port"]
            .as_i64()
            .unwrap();
        assert_eq!(first_port, 20000);
        assert_eq!(second_port, 20001, "第二条链必须跳过已被占用的 20000");
    }

    /// 自动分配要跳过已有独立转发 / 节点占用的端口。
    #[tokio::test]
    async fn auto_allocation_skips_ports_used_by_forwards_and_nodes() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        add_node(&fixture.state, &fixture.b, 20000).await;
        repo::forwards::create(
            &fixture.state.db.pool,
            &fixture.b,
            repo::forwards::NewForward {
                name: "独立转发".into(),
                listen_port: 20001,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: false,
                engine: "native".into(),
                protocol: "tcp".into(),
            },
        )
        .await
        .unwrap();

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "跳过占用",
                "1.1.1.1",
                443,
                &[
                    group(None, None, &[group_member(&fixture.a, 9301, 0)]),
                    group(None, None, &[auto_port_member(&fixture.b, 0)]),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(
            value["chain"]["groups"][1]["listen_port"], 20002,
            "20000 被节点占用、20001 被停用转发占用（停用也继续占端口）"
        );
    }

    /// 端口池耗尽：400 + 稳定错误码，绝不回退到随机端口或其它范围。
    #[tokio::test]
    async fn exhausted_port_pool_returns_400() {
        let fixture = setup().await;

        for port in chains::PORT_POOL_START..=chains::PORT_POOL_END {
            repo::forwards::create(
                &fixture.state.db.pool,
                &fixture.b,
                repo::forwards::NewForward {
                    name: format!("占位 {port}"),
                    listen_port: port,
                    target_host: "10.0.0.8".into(),
                    target_port: 443,
                    enabled: false,
                    engine: "native".into(),
                    protocol: "tcp".into(),
                },
            )
            .await
            .unwrap();
        }

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(groups_body(
                "池耗尽",
                "1.1.1.1",
                443,
                &[
                    group(None, None, &[group_member(&fixture.a, 9401, 0)]),
                    group(None, None, &[auto_port_member(&fixture.b, 0)]),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.port_pool_exhausted");
        assert_eq!(value["params"]["server_id"], fixture.b.as_str());
        assert_eq!(value["params"]["pool_start"], 20000);
        assert_eq!(value["params"]["pool_end"], 29999);
    }

    /// 旧格式（每组显式带端口的 members）行为不变。
    #[tokio::test]
    async fn explicit_group_ports_are_kept_verbatim() {
        let fixture = setup().await;

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(groups_body(
                "旧格式",
                "1.1.1.1",
                443,
                &[
                    group(None, None, &[group_member(&fixture.a, 9501, 0)]),
                    group(None, None, &[group_member(&fixture.b, 9502, 0)]),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["chain"]["groups"][0]["listen_port"], 9501);
        assert_eq!(value["chain"]["groups"][1]["listen_port"], 9502);
    }

    /// 更新链：旧成员端口保持，新成员才分配；被删组随行删除自然释放。
    #[tokio::test]
    async fn update_keeps_existing_ports_and_allocates_only_for_new_groups() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "更新前",
                "1.1.1.1",
                443,
                &[
                    group(None, None, &[group_member(&fixture.a, 9601, 0)]),
                    group(None, None, &[group_member(&fixture.b, 9602, 0)]),
                    group(None, None, &[group_member(&fixture.c, 9603, 0)]),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();

        // 三组旧成员都省略端口 → 保留原值；新增的 d 组 → 分配 20000。
        let (status, updated) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::PATCH,
            &format!("/api/v1/chains/{chain_id}"),
            Some(json!({
                "groups": [
                    group(None, None, &[group_member(&fixture.a, 9601, 0)]),
                    group(None, None, &[auto_port_member(&fixture.b, 0)]),
                    group(None, None, &[auto_port_member(&fixture.c, 0)]),
                    group(None, None, &[auto_port_member(&fixture.d, 0)]),
                ]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {updated}");
        let groups = updated["chain"]["groups"].as_array().unwrap();
        assert_eq!(groups[1]["listen_port"], 9602, "旧组端口必须保留");
        assert_eq!(groups[2]["listen_port"], 9603, "旧组端口必须保留");
        assert_eq!(groups[3]["listen_port"], 20000, "新增组才分配");
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
        assert!(
            derived
                .iter()
                .all(|(_, forward)| forward.protocol == ForwardProtocol::Tcp),
            "缺省协议必须是 tcp"
        );

        // 开启后两跳都必须带 UDP：链级开关不允许只开一半。
        chain.protocol = "both".into();
        chain.udp = true;
        let derived = derive_forwards(&chain, &groups);
        assert_eq!(derived.len(), 2);
        assert!(
            derived.iter().all(|(_, forward)| forward.udp),
            "链的 udp 镜像位必须透传到每一跳"
        );
        assert!(
            derived
                .iter()
                .all(|(_, forward)| forward.protocol == ForwardProtocol::Both),
            "链的 protocol 必须透传到每一跳"
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

    /// 链的协议模式：透传到每一跳；仅 UDP / 非法值 / realm / TLS 的冲突全部在保存时拒绝。
    #[tokio::test]
    async fn chain_protocol_reaches_every_hop_and_rejects_bad_combinations() {
        use pierwave_proto::ForwardProtocol;

        let fixture = setup().await;
        let two_groups = |base: i64| {
            vec![
                group(
                    None,
                    Some("round_robin"),
                    &[group_member(&fixture.a, base, 0)],
                ),
                group(
                    None,
                    Some("round_robin"),
                    &[group_member(&fixture.b, base + 1, 0)],
                ),
            ]
        };

        let mut body = groups_body("仅 UDP 链", "1.1.1.1", 443, &two_groups(9201));
        body["protocol"] = json!("udp");
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["chain"]["protocol"], "udp");
        assert_eq!(value["chain"]["udp"], false, "仅 UDP 不能误标旧镜像位");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();

        for (server_id, listen_port) in [(&fixture.a, 9201), (&fixture.b, 9202)] {
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
            assert_eq!(hop.protocol, ForwardProtocol::Udp, "协议必须透传到每一跳");
            assert!(!hop.udp, "旧镜像位不能把仅 UDP 写成双开");
            assert_eq!(hop.listen_port, listen_port);
        }

        // 非法协议。
        let mut bad = groups_body("坏协议", "1.1.1.1", 443, &two_groups(9301));
        bad["protocol"] = json!("sctp");
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(bad),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.protocol_invalid");

        // realm 固定双开：没有 TLS 时给 realm 的专属错误。
        let mut realm_udp = groups_body("realm 仅 UDP", "1.1.1.1", 443, &two_groups(9401));
        realm_udp["engine"] = json!("realm");
        realm_udp["protocol"] = json!("udp");
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(realm_udp),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.protocol_udp_requires_native");

        // 加密链只走 TCP：仅 UDP + tls 给专属错误。
        let mut tls_udp = groups_body("TLS 仅 UDP", "1.1.1.1", 443, &two_groups(9501));
        tls_udp["engine"] = json!("realm");
        tls_udp["protocol"] = json!("udp");
        tls_udp["transport"] = json!("tls");
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(tls_udp),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.protocol_udp_with_tls");

        // both 含 UDP：走既有的「加密链不支持 UDP」错误。
        let mut tls_both = groups_body("TLS both", "1.1.1.1", 443, &two_groups(9601));
        tls_both["engine"] = json!("realm");
        tls_both["protocol"] = json!("both");
        tls_both["transport"] = json!("tls");
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(tls_both),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.tls_udp_unsupported");

        // 旧客户端只发 udp=true 仍映射成 both。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::PATCH,
            &format!("/api/v1/chains/{chain_id}"),
            Some(json!({"udp": true})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["chain"]["protocol"], "both");
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
    // ---------------------------------------------------------------- P15.3 跳间 TLS

    const TLS_TEST_CERT: &str = include_str!("../../../domain/tests/fixtures/test-cert.pem");
    const TLS_TEST_KEY: &str = include_str!("../../../domain/tests/fixtures/test-key.pem");
    const TLS_EXPIRED_CERT: &str =
        include_str!("../../../domain/tests/fixtures/test-expired-cert.pem");
    const TLS_EXPIRED_KEY: &str =
        include_str!("../../../domain/tests/fixtures/test-expired-key.pem");
    /// fixture 证书的 `not_after`（2036-11-02）。
    const TLS_NOT_AFTER: i64 = 2_109_208_713;

    async fn add_certificate(state: &AppState, name: &str, not_after: i64) -> Certificate {
        repo::certificates::create(
            &state.db.pool,
            repo::certificates::NewCertificate {
                name: name.into(),
                domains: vec!["example.com".into(), "www.example.com".into()],
                cert_pem: TLS_TEST_CERT.into(),
                key_pem: TLS_TEST_KEY.into(),
                not_before: 1_793_341_113,
                not_after,
            },
        )
        .await
        .unwrap()
    }

    async fn add_expired_certificate(state: &AppState, name: &str) -> Certificate {
        repo::certificates::create(
            &state.db.pool,
            repo::certificates::NewCertificate {
                name: name.into(),
                domains: vec!["expired.example.com".into()],
                cert_pem: TLS_EXPIRED_CERT.into(),
                key_pem: TLS_EXPIRED_KEY.into(),
                not_before: 1_577_836_800,
                not_after: 1_609_459_200,
            },
        )
        .await
        .unwrap()
    }

    async fn set_nftables_capability(state: &AppState, server_id: &str, value: Option<bool>) {
        repo::servers::update_health(
            &state.db.pool,
            server_id,
            "0.8.0",
            &repo::servers::HealthSnapshot {
                nftables_available: value,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    async fn set_transport_capability(state: &AppState, server_id: &str, value: Option<bool>) {
        repo::servers::update_health(
            &state.db.pool,
            server_id,
            "0.7.5",
            &repo::servers::HealthSnapshot {
                realm_transport: value,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    async fn set_tunnel_capability(state: &AppState, server_id: &str, value: Option<bool>) {
        repo::servers::update_health(
            &state.db.pool,
            server_id,
            "0.8.3",
            &repo::servers::HealthSnapshot {
                tunnel_available: value,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    fn tls_groups_body(
        name: &str,
        target_host: &str,
        target_port: i64,
        groups: &[Value],
        udp: bool,
    ) -> Value {
        let mut body = groups_body(name, target_host, target_port, groups);
        body["engine"] = json!("realm");
        body["transport"] = json!("tls");
        body["udp"] = json!(udp);
        body
    }

    fn group_with_cert(cert_id: Option<&str>, members: &[Value]) -> Value {
        let mut group = group(None, Some("round_robin"), members);
        if let Some(cert_id) = cert_id {
            group["cert_id"] = json!(cert_id);
        }
        group
    }

    /// 2 组加密链：入口只有 remote_transport，出口只有 listen_transport；
    /// 证书文件只发给「本机是成员」的组，入口服务器不需要证书。
    #[tokio::test]
    async fn tls_chain_reaches_desired_state_with_cert_files_only_for_members() {
        let fixture = setup().await;
        for server_id in [&fixture.a, &fixture.b, &fixture.c] {
            set_transport_capability(&fixture.state, server_id, Some(true)).await;
        }
        let cert = add_certificate(&fixture.state, "hop1", TLS_NOT_AFTER).await;

        let body = tls_groups_body(
            "加密链",
            "1.1.1.1",
            443,
            &[
                group_with_cert(None, &[group_member(&fixture.a, 9001, 0)]),
                group_with_cert(
                    Some(&cert.id),
                    &[
                        group_member(&fixture.b, 9002, 0),
                        group_member(&fixture.c, 9003, 0),
                    ],
                ),
            ],
            false,
        );
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["chain"]["transport"], "tls");
        assert_eq!(value["chain"]["groups"][0]["cert_id"], Value::Null);
        assert_eq!(
            value["chain"]["groups"][1]["cert_id"],
            json!(&cert.id),
            "组证书必须原样返回，前端靠它展示/轮换"
        );
        assert!(
            value["chain"].get("blocked_reason").is_none(),
            "能力与证书都满足时不应有 blocked_reason：{value}"
        );

        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();
        let server_a = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.a)
            .await
            .unwrap();
        let server_b = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.b)
            .await
            .unwrap();
        let server_c = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.c)
            .await
            .unwrap();
        let server_d = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.d)
            .await
            .unwrap();
        let base = "https://panel.example.com";

        let rendered_a = crate::routes::desired::render(&fixture.state, &server_a, base)
            .await
            .unwrap();
        let entry = rendered_a
            .forwards
            .iter()
            .find(|forward| forward.listen_port == 9001)
            .expect("入口跳必须在期望态里");
        assert_eq!(entry.id, format!("chain-{chain_id}-0"));
        assert_eq!(entry.listen_transport, None, "入口监听保持明文");
        assert_eq!(
            entry.remote_transport.as_deref(),
            Some("tls;sni=example.com"),
            "上一跳用下一组证书的首个具体域名做 SNI"
        );
        assert!(entry.disable_udp, "加密链所有端点都必须关 UDP");
        assert!(
            rendered_a.files.is_empty(),
            "入口服务器不需要下一跳的证书文件"
        );

        let rendered_b = crate::routes::desired::render(&fixture.state, &server_b, base)
            .await
            .unwrap();
        let middle = rendered_b
            .forwards
            .iter()
            .find(|forward| forward.listen_port == 9002)
            .expect("出口跳必须在期望态里");
        assert_eq!(
            middle.listen_transport.as_deref(),
            Some(
                format!(
                    "tls;cert={};key={}",
                    pierwave_domain::certificate::cert_file_path(&cert.id),
                    pierwave_domain::certificate::key_file_path(&cert.id)
                )
                .as_str()
            )
        );
        assert_eq!(middle.remote_transport, None, "落地到目标是明文");
        assert!(middle.disable_udp);
        assert_eq!(rendered_b.files.len(), 2, "证书 + 私钥各一份");
        let pem = rendered_b
            .files
            .iter()
            .find(|file| file.path.ends_with(".pem"))
            .expect("必须下发证书");
        let key = rendered_b
            .files
            .iter()
            .find(|file| file.path.ends_with(".key"))
            .expect("必须下发私钥");
        assert_eq!(pem.content, TLS_TEST_CERT);
        assert_eq!(pem.mode, 0o644);
        assert_eq!(key.content, TLS_TEST_KEY);
        assert_eq!(key.mode, 0o600, "私钥必须 0600");

        // 同组第二台成员也要拿到同一张证书，才能被同一个 SNI 校验通过。
        let rendered_c = crate::routes::desired::render(&fixture.state, &server_c, base)
            .await
            .unwrap();
        assert!(
            rendered_c
                .forwards
                .iter()
                .any(|forward| forward.listen_port == 9003),
            "组内每台成员各有一条 forward"
        );
        assert_eq!(rendered_c.files.len(), 2);

        // 与链无关的服务器：既没有这条链的 forward，也没有它的证书。
        let rendered_d = crate::routes::desired::render(&fixture.state, &server_d, base)
            .await
            .unwrap();
        assert!(rendered_d.forwards.is_empty());
        assert!(rendered_d.files.is_empty());
    }

    /// 保存时的所有非法组合都必须 400 + 稳定 code，不能「先存下再说」。
    #[tokio::test]
    async fn tls_chain_validation_rejects_invalid_combinations() {
        let fixture = setup().await;
        for server_id in [&fixture.a, &fixture.b] {
            set_transport_capability(&fixture.state, server_id, Some(true)).await;
        }
        let cert = add_certificate(&fixture.state, "hop1", TLS_NOT_AFTER).await;
        let expired = add_expired_certificate(&fixture.state, "expired").await;

        let two_groups =
            |transport: &str, engine: &str, udp: bool, cert_id: Option<&str>| -> Value {
                let mut body = groups_body(
                    "非法组合",
                    "1.1.1.1",
                    443,
                    &[
                        group_with_cert(None, &[group_member(&fixture.a, 9001, 0)]),
                        group_with_cert(cert_id, &[group_member(&fixture.b, 9002, 0)]),
                    ],
                );
                body["engine"] = json!(engine);
                body["transport"] = json!(transport);
                body["udp"] = json!(udp);
                body
            };

        let cases: Vec<(Value, &str)> = vec![
            (
                two_groups("tls", "native", false, Some(&cert.id)),
                "chain.tls_requires_realm",
            ),
            (
                // 1 组链没有「跳间」。
                tls_groups_body(
                    "单跳",
                    "1.1.1.1",
                    443,
                    &[group_with_cert(None, &[group_member(&fixture.a, 9001, 0)])],
                    false,
                ),
                "chain.tls_requires_two_hops",
            ),
            (
                two_groups("tls", "realm", true, Some(&cert.id)),
                "chain.tls_udp_unsupported",
            ),
            (
                two_groups("tls", "realm", false, None),
                "chain.tls_group_cert_required",
            ),
            (
                // 入口组（第一组）不允许证书。
                {
                    let mut body = two_groups("tls", "realm", false, Some(&cert.id));
                    body["groups"][0]["cert_id"] = json!(&cert.id);
                    body
                },
                "chain.tls_group_cert_forbidden",
            ),
            (
                two_groups("tls", "realm", false, Some(&expired.id)),
                "chain.tls_cert_expired",
            ),
            (
                two_groups("tls", "realm", false, Some("no-such-cert")),
                "chain.tls_cert_not_found",
            ),
        ];

        for (body, expected) in cases {
            let (status, value) = request(
                &fixture.app,
                Some(&fixture.cookie),
                Method::POST,
                "/api/v1/chains",
                Some(body),
            )
            .await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "expected {expected}: {value}"
            );
            assert_eq!(value["code"], expected, "unexpected: {value}");
            assert!(
                value["error"]
                    .as_str()
                    .is_some_and(|error| !error.is_empty()),
                "必须有中文兜底文案：{value}"
            );
        }
    }

    /// 能力门禁：链上任意成员未知/不支持 → 整链不进 forwards + warnings，
    /// 链视图给出 blocked_reason；绝不因为「先跑通」而降级明文。
    #[tokio::test]
    async fn tls_chain_is_skipped_whole_when_a_member_lacks_transport() {
        let fixture = setup().await;
        let cert = add_certificate(&fixture.state, "hop1", TLS_NOT_AFTER).await;

        // 直接走仓储建链：保存路径不因「能力未知」拒绝（服务器可能离线），
        // 下发路径必须整链跳过。
        let chain = repo::chains::create(
            &fixture.state.db.pool,
            repo::chains::NewChain {
                name: "能力不足".into(),
                target_host: "1.1.1.1".into(),
                target_port: 443,
                enabled: true,
                engine: "realm".into(),
                protocol: "tcp".into(),
                transport: "tls".into(),
                tunnel_security: "tls".into(),
                groups: vec![
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: None,
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: fixture.a.clone(),
                            listen_port: 9001,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: Some(cert.id.clone()),
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: fixture.b.clone(),
                            listen_port: 9002,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                ],
            },
        )
        .await
        .unwrap();

        let server_a = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.a)
            .await
            .unwrap();
        let rendered =
            crate::routes::desired::render(&fixture.state, &server_a, "https://panel.example.com")
                .await
                .unwrap();
        assert!(
            rendered
                .forwards
                .iter()
                .all(|forward| !forward.id.starts_with(&format!("chain-{}", chain.chain.id))),
            "整条链都不能下发：{:?}",
            rendered.forwards
        );
        assert!(
            rendered
                .warnings
                .iter()
                .any(|warning| warning.contains("未下发") && warning.contains("transport")),
            "warnings 必须说明原因：{:?}",
            rendered.warnings
        );

        // 只把一台成员标记为支持还不够：入口也要支持 transport。
        set_transport_capability(&fixture.state, &fixture.b, Some(true)).await;
        let rendered =
            crate::routes::desired::render(&fixture.state, &server_a, "https://panel.example.com")
                .await
                .unwrap();
        assert!(rendered
            .warnings
            .iter()
            .any(|warning| warning.contains("未下发")));

        // 两台都明确支持后才下发。
        set_transport_capability(&fixture.state, &fixture.a, Some(true)).await;
        let rendered =
            crate::routes::desired::render(&fixture.state, &server_a, "https://panel.example.com")
                .await
                .unwrap();
        assert!(rendered
            .forwards
            .iter()
            .any(|forward| forward.listen_port == 9001));
        assert!(rendered.warnings.is_empty(), "{:?}", rendered.warnings);
    }

    /// 保存后证书过期：下次 apply 整链跳过（连同证书文件），链视图给出 blocked_reason。
    #[tokio::test]
    async fn expired_certificate_blocks_the_whole_chain_at_render_time() {
        let fixture = setup().await;
        for server_id in [&fixture.a, &fixture.b] {
            set_transport_capability(&fixture.state, server_id, Some(true)).await;
        }
        let expired = add_expired_certificate(&fixture.state, "expired").await;

        let chain = repo::chains::create(
            &fixture.state.db.pool,
            repo::chains::NewChain {
                name: "过期证书".into(),
                target_host: "1.1.1.1".into(),
                target_port: 443,
                enabled: true,
                engine: "realm".into(),
                protocol: "tcp".into(),
                transport: "tls".into(),
                tunnel_security: "tls".into(),
                groups: vec![
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: None,
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: fixture.a.clone(),
                            listen_port: 9001,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: Some(expired.id.clone()),
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: fixture.b.clone(),
                            listen_port: 9002,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                ],
            },
        )
        .await
        .unwrap();

        let server_b = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.b)
            .await
            .unwrap();
        let rendered =
            crate::routes::desired::render(&fixture.state, &server_b, "https://panel.example.com")
                .await
                .unwrap();
        assert!(
            rendered.forwards.is_empty(),
            "整链不下发：{:?}",
            rendered.forwards
        );
        assert!(
            rendered.files.is_empty(),
            "失效链的证书文件也不能下发：{:?}",
            rendered.files
        );
        assert!(
            rendered
                .warnings
                .iter()
                .any(|warning| warning.contains("已过期")),
            "{:?}",
            rendered.warnings
        );

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::GET,
            "/api/v1/chains",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let chain_view = &value["items"][0];
        assert_eq!(chain_view["blocked_code"], "chain.tls_cert_expired");
        assert!(
            chain_view["blocked_reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("已过期")),
            "{chain_view}"
        );

        // 证书坏了也不能把用户锁死：改名 / 停用必须仍然可用。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::PATCH,
            &format!("/api/v1/chains/{}", chain.chain.id),
            Some(json!({ "enabled": false, "name": "已停用" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        assert_eq!(value["chain"]["enabled"], false);
        assert_eq!(value["chain"]["name"], "已停用");
    }

    /// 下发路径的前置校验：脏数据/手工改库留下「native+tls」「单组 tls」
    /// 「tls+udp」时整链跳过，不能退化成明文端点。
    #[test]
    fn plan_refuses_unsafe_tls_shapes_at_render_time() {
        let certs: HashMap<&str, &Certificate> = HashMap::new();
        let chain = Chain {
            transport: "tls".into(),
            engine: "realm".into(),
            protocol: "tcp".into(),
            udp: false,
            ..test_chain("c-tls-dirty")
        };
        let single = vec![test_group(
            "c-tls-dirty",
            0,
            "round_robin",
            &[("srv-a", "10.0.0.1", 9001, 0)],
        )];
        assert_eq!(
            plan_from_certificates(&chain, &single, &certs, 0)
                .unwrap_err()
                .code,
            "chain.tls_requires_two_hops"
        );

        let two = vec![
            test_group(
                "c-tls-dirty",
                0,
                "round_robin",
                &[("srv-a", "10.0.0.1", 9001, 0)],
            ),
            test_group(
                "c-tls-dirty",
                1,
                "round_robin",
                &[("srv-b", "10.0.0.2", 9002, 0)],
            ),
        ];
        assert_eq!(
            plan_from_certificates(
                &Chain {
                    engine: "native".into(),
                    ..chain.clone()
                },
                &two,
                &certs,
                0,
            )
            .unwrap_err()
            .code,
            "chain.tls_requires_realm"
        );
        assert_eq!(
            plan_from_certificates(
                &Chain {
                    protocol: "both".into(),
                    udp: true,
                    ..chain.clone()
                },
                &two,
                &certs,
                0,
            )
            .unwrap_err()
            .code,
            "chain.tls_udp_unsupported"
        );
    }

    /// 链里逐跳叠加 transport 的映射：入口只出、中间进出、落地只进。
    #[test]
    fn derive_forwards_applies_transports_per_group() {
        let chain = Chain {
            transport: "tls".into(),
            engine: "realm".into(),
            ..test_chain("c-tls")
        };
        let groups = vec![
            test_group("c-tls", 0, "round_robin", &[("srv-a", "10.0.0.1", 9001, 0)]),
            test_group("c-tls", 1, "round_robin", &[("srv-b", "10.0.0.2", 9002, 0)]),
            test_group("c-tls", 2, "round_robin", &[("srv-c", "10.0.0.3", 9003, 0)]),
        ];
        let transports = vec![
            hop_transport::HopTransport {
                listen: None,
                remote: Some("tls;sni=hop1.example.com".into()),
                disable_udp: true,
            },
            hop_transport::HopTransport {
                listen: Some("tls;cert=/c1.pem;key=/c1.key".into()),
                remote: Some("tls;sni=hop2.example.com".into()),
                disable_udp: true,
            },
            hop_transport::HopTransport {
                listen: Some("tls;cert=/c2.pem;key=/c2.key".into()),
                remote: None,
                disable_udp: true,
            },
        ];
        let derived = derive_forwards_with_transports(&chain, &groups, &transports);
        let by_port = |port: i64| {
            derived
                .iter()
                .find(|(_, forward)| forward.listen_port == port)
                .map(|(_, forward)| forward)
                .expect("每个成员一条 forward")
        };

        let entry = by_port(9001);
        assert_eq!(entry.listen_transport, None);
        assert_eq!(
            entry.remote_transport.as_deref(),
            Some("tls;sni=hop1.example.com")
        );
        assert!(entry.disable_udp);

        let middle = by_port(9002);
        assert_eq!(
            middle.listen_transport.as_deref(),
            Some("tls;cert=/c1.pem;key=/c1.key")
        );
        assert_eq!(
            middle.remote_transport.as_deref(),
            Some("tls;sni=hop2.example.com")
        );

        let exit = by_port(9003);
        assert_eq!(
            exit.listen_transport.as_deref(),
            Some("tls;cert=/c2.pem;key=/c2.key")
        );
        assert_eq!(exit.remote_transport, None);
        assert!(derived.iter().all(|(_, forward)| forward.disable_udp));

        // 明文链：传空 transport 列表，推导结果逐字段保持旧行为。
        let plain_chain = test_chain("c-plain");
        let plain = derive_forwards_with_transports(&plain_chain, &groups, &[]);
        assert!(plain
            .iter()
            .all(|(_, forward)| forward.listen_transport.is_none()
                && forward.remote_transport.is_none()
                && !forward.disable_udp));
    }

    /// 直接写一条 forward_status（与心跳落库走同一个仓储函数）。
    ///
    /// `probes` = `(server_id, ok, latency_ms)`；空数组表示「本轮没探测」。
    async fn save_probes(
        state: &AppState,
        server_id: &str,
        forward_id: &str,
        probes: &[(&str, bool, Option<u32>)],
    ) {
        repo::forwards::save_status(
            &state.db.pool,
            server_id,
            &[repo::forwards::NewForwardStatus {
                forward_id: forward_id.to_string(),
                listening: true,
                error: String::new(),
                target_ok: Some(probes.iter().any(|(_, ok, _)| *ok)),
                target_error: None,
                targets: probes
                    .iter()
                    .map(
                        |(server_id, ok, latency_ms)| repo::forwards::NewTargetProbe {
                            server_id: (*server_id).to_string(),
                            ok: *ok,
                            latency_ms: *latency_ms,
                        },
                    )
                    .collect(),
                traffic_in: None,
                traffic_out: None,
            }],
        )
        .await
        .unwrap();
    }

    /// 单路径（每组一台）：各段 RTT 直接相加；没有数据时全部 null。
    #[tokio::test]
    async fn chain_latency_single_path_sums_every_segment() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "单路径",
                "1.1.1.1",
                443,
                &[
                    group(None, None, &[group_member(&fixture.a, 9001, 0)]),
                    group(None, None, &[group_member(&fixture.b, 9002, 0)]),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();
        assert_eq!(value["chain"]["path_mode"], "single");
        assert!(
            value["chain"]["total_latency_ms"].is_null(),
            "还没探测时不能编造合计：{value}"
        );

        // 心跳：a 探测 b 用 20ms，b 探测链目标用 5ms。
        let a_id = chains::forward_id(&chain_id, 0, &fixture.a, 1);
        let b_id = chains::forward_id(&chain_id, 1, &fixture.b, 1);
        save_probes(&fixture.state, &fixture.a, &a_id, &[("", true, Some(20))]).await;
        save_probes(&fixture.state, &fixture.b, &b_id, &[("", true, Some(5))]).await;

        let (status, body) =
            request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let chain = &body["items"][0];
        assert_eq!(chain["path_mode"], "single");
        assert_eq!(chain["total_latency_ms"], 25, "20 + 5");
        assert!(
            chain["groups"][0]["members"][0]["latency_ms"].is_null(),
            "入口组没有上一跳，延迟必须是 null"
        );
        assert_eq!(chain["groups"][1]["members"][0]["latency_ms"], 20);
        assert_eq!(chain["groups"][1]["members"][0]["target_latency_ms"], 5);
        assert!(
            chain["groups"][0]["members"][0]["target_latency_ms"].is_null(),
            "非最后一跳不显示到链目标的延迟"
        );

        // 链路 JSON 只读观测值：把数据清空（心跳未探测）后必须回到全 null，不能 500。
        save_probes(&fixture.state, &fixture.a, &a_id, &[]).await;
        save_probes(&fixture.state, &fixture.b, &b_id, &[]).await;
        let (status, body) =
            request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let chain = &body["items"][0];
        assert!(chain["groups"][1]["members"][0]["latency_ms"].is_null());
        assert!(chain["groups"][1]["members"][0]["target_latency_ms"].is_null());
        assert!(chain["total_latency_ms"].is_null(), "缺数据不能求和");
    }

    /// 多台上一跳探测同一个成员：取最小值；多成员组下合计为 null。
    #[tokio::test]
    async fn chain_latency_takes_the_minimum_across_previous_hops() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "多路径",
                "1.1.1.1",
                443,
                &[
                    group(
                        None,
                        Some("round_robin"),
                        &[
                            group_member(&fixture.a, 9001, 0),
                            group_member(&fixture.b, 9002, 0),
                        ],
                    ),
                    group(None, None, &[group_member(&fixture.c, 9003, 0)]),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();
        assert_eq!(value["chain"]["path_mode"], "multi");

        let a_id = chains::forward_id(&chain_id, 0, &fixture.a, 2);
        let b_id = chains::forward_id(&chain_id, 0, &fixture.b, 2);
        let c_id = chains::forward_id(&chain_id, 1, &fixture.c, 1);
        // a 与 b 都探测 c：30ms 与 12ms。
        save_probes(
            &fixture.state,
            &fixture.a,
            &a_id,
            &[(&fixture.c, true, Some(30))],
        )
        .await;
        save_probes(
            &fixture.state,
            &fixture.b,
            &b_id,
            &[(&fixture.c, true, Some(12))],
        )
        .await;
        save_probes(&fixture.state, &fixture.c, &c_id, &[("", true, Some(7))]).await;

        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        let chain = &body["items"][0];
        assert_eq!(chain["path_mode"], "multi");
        assert!(
            chain["total_latency_ms"].is_null(),
            "多路径没有唯一的合计值"
        );
        assert_eq!(
            chain["groups"][1]["members"][0]["latency_ms"], 12,
            "取上一跳探测的最小值"
        );
        assert_eq!(chain["groups"][1]["members"][0]["target_latency_ms"], 7);
    }

    /// 多成员组且策略为 ip_hashed：path_mode = hash。
    #[tokio::test]
    async fn chain_path_mode_is_hash_for_ip_hashed_multi_member_group() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "哈希链",
                "1.1.1.1",
                443,
                &[group(
                    None,
                    Some("ip_hashed"),
                    &[
                        group_member(&fixture.a, 9001, 0),
                        group_member(&fixture.b, 9002, 0),
                    ],
                )],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();

        let a_id = chains::forward_id(&chain_id, 0, &fixture.a, 2);
        let b_id = chains::forward_id(&chain_id, 0, &fixture.b, 2);
        save_probes(&fixture.state, &fixture.a, &a_id, &[("", true, Some(9))]).await;
        save_probes(&fixture.state, &fixture.b, &b_id, &[("", true, Some(4))]).await;

        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        let chain = &body["items"][0];
        assert_eq!(chain["path_mode"], "hash");
        assert!(chain["total_latency_ms"].is_null());
        assert_eq!(chain["groups"][0]["members"][0]["target_latency_ms"], 9);
        assert_eq!(chain["groups"][0]["members"][1]["target_latency_ms"], 4);
    }

    /// 完全没有探测数据（旧 Agent / 刚建链）：字段存在、值为 null、接口不报错。
    #[tokio::test]
    async fn chain_latency_is_null_without_probe_data() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "无数据",
                "1.1.1.1",
                443,
                &[group(None, None, &[group_member(&fixture.a, 9001, 0)])],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain = &value["chain"];
        assert_eq!(chain["path_mode"], "single");
        assert!(chain["total_latency_ms"].is_null());
        assert!(chain["groups"][0]["members"][0]["latency_ms"].is_null());
        assert!(chain["groups"][0]["members"][0]["target_latency_ms"].is_null());
    }

    /// 延迟历史：写入 → 读取、窗口过滤、空数组、非法 hours 400；
    /// 同时验证单成员下一跳的空 server_id 能被主控映射回成员。
    #[tokio::test]
    async fn chain_latency_history_filters_windows_and_rejects_bad_hours() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "历史",
                "1.1.1.1",
                443,
                &[
                    group(None, None, &[group_member(&fixture.a, 9001, 0)]),
                    group(None, None, &[group_member(&fixture.b, 9002, 0)]),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();
        let history_uri = format!("/api/v1/chains/{chain_id}/latency");

        // 空数据：必须是 200 + 空数组，不是 404/500。
        let (status, body) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::GET,
            &history_uri,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["points"], json!([]));

        // 非法 hours：缺 code 的 400 不合格，前端要能翻译。
        for hours in ["0", "169", "abc", "-1"] {
            let (status, body) = request(
                &fixture.app,
                Some(&fixture.cookie),
                Method::GET,
                &format!("{history_uri}?hours={hours}"),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "hours={hours}: {body}");
            assert_eq!(body["code"], "chain.latency_hours_invalid");
            assert_eq!(body["params"]["min"], 1);
            assert_eq!(body["params"]["max"], 168);
        }

        let a_id = chains::forward_id(&chain_id, 0, &fixture.a, 1);
        let b_id = chains::forward_id(&chain_id, 1, &fixture.b, 1);
        let now = repo::now();
        // a → b 两次探测（2 小时前 / 1 分钟前）；单成员组走兼容字段，
        // Agent 上报的 target_server_id 是空串，历史接口必须映射到 b。
        repo::latency::record_sample(
            &fixture.state.db.pool,
            now - 7_200,
            &fixture.a,
            &a_id,
            "",
            20,
        )
        .await
        .unwrap();
        repo::latency::record_sample(&fixture.state.db.pool, now - 60, &fixture.a, &a_id, "", 40)
            .await
            .unwrap();
        // 最后一跳 → 链目标：不是服务器间链路，不能出现在历史里。
        repo::latency::record_sample(&fixture.state.db.pool, now - 60, &fixture.b, &b_id, "", 99)
            .await
            .unwrap();

        let (status, body) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::GET,
            &format!("{history_uri}?hours=1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["points"].as_array().unwrap().len(), 1, "{body}");
        assert_eq!(body["points"][0]["seq"], 1);
        assert_eq!(body["points"][0]["server_id"], fixture.b);
        assert_eq!(body["points"][0]["latency_ms"], 40);
        assert!(
            body["points"][0]["ts"].as_i64().unwrap() <= now - 60,
            "输出 ts 是 5 分钟桶起点，不能晚于样本时间"
        );

        // 窗口放宽到 3 小时：两个 5 分钟桶都在，按时间升序。
        let (status, body) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::GET,
            &format!("{history_uri}?hours=3"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let points = body["points"].as_array().unwrap();
        assert_eq!(points.len(), 2, "{body}");
        assert_eq!(points[0]["latency_ms"], 20);
        assert_eq!(points[1]["latency_ms"], 40);
        assert!(points[0]["ts"].as_i64() < points[1]["ts"].as_i64());
    }

    /// 链成员视图必须带服务器的最后上报时间（ISO8601）与每跳累计流量，
    /// 没有数据源时必须是 null（不是 0）。
    #[tokio::test]
    async fn chain_members_expose_last_seen_and_traffic() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(groups_body(
                "观测",
                "1.1.1.1",
                443,
                &[
                    group(None, None, &[group_member(&fixture.a, 9001, 0)]),
                    group(None, None, &[group_member(&fixture.b, 9002, 0)]),
                ],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();

        // 只有 b 上报过心跳：a 的 last_seen_at 必须是 null。
        repo::servers::heartbeat(&fixture.state.db.pool, &fixture.b)
            .await
            .unwrap();

        let a_id = chains::forward_id(&chain_id, 0, &fixture.a, 1);
        repo::forwards::save_status(
            &fixture.state.db.pool,
            &fixture.a,
            &[repo::forwards::NewForwardStatus {
                forward_id: a_id,
                listening: true,
                error: String::new(),
                target_ok: Some(true),
                target_error: None,
                targets: vec![repo::forwards::NewTargetProbe {
                    server_id: fixture.b.clone(),
                    ok: true,
                    latency_ms: Some(17),
                }],
                traffic_in: Some(1_024),
                traffic_out: Some(2_048),
            }],
        )
        .await
        .unwrap();

        let (status, body) =
            request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let chain = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|chain| chain["id"] == chain_id)
            .unwrap();
        let entry = &chain["groups"][0]["members"][0];
        let exit = &chain["groups"][1]["members"][0];
        assert!(entry["last_seen_at"].is_null(), "从未心跳必须是 null");
        assert!(
            exit["last_seen_at"]
                .as_str()
                .is_some_and(|value| value.ends_with('Z')),
            "last_seen_at 必须是 ISO8601 UTC 字符串：{exit}"
        );
        assert_eq!(entry["traffic_in"], 1_024);
        assert_eq!(entry["traffic_out"], 2_048);
        assert!(
            exit["traffic_in"].is_null() && exit["traffic_out"].is_null(),
            "没有心跳状态时流量必须是 null，不能编造 0：{exit}"
        );

        // realm 引擎没有计数器：Agent 报 null，链路视图也必须是 null。
        let (status, body) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::GET,
            &format!("/api/v1/chains/{chain_id}/latency"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            !body["points"].as_array().unwrap().is_empty(),
            "同一轮心跳写入了延迟样本，历史接口应能读到"
        );
    }
    /// Noise 链：保存时接受 `noise`、链 JSON 返回该字段，且下发时
    /// TunnelSpec.security = Noise、三个证书路径为空、files 里没有任何隧道证书。
    #[tokio::test]
    async fn noise_tunnel_chain_is_dispatched_without_certificate_files() {
        let fixture = setup().await;
        for server_id in [&fixture.a, &fixture.b] {
            set_tunnel_capability(&fixture.state, server_id, Some(true)).await;
        }
        let body = json!({
            "name": "noise 隧道",
            "target_host": "1.1.1.1",
            "target_port": 443,
            "engine": "tunnel",
            "protocol": "tcp",
            "transport": "none",
            "tunnel_security": "noise",
            "groups": [
                group(None, None, &[group_member(&fixture.a, 19401, 0)]),
                group(None, None, &[group_member(&fixture.b, 19402, 0)]),
            ],
        });
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        assert_eq!(
            value["chain"]["tunnel_security"], "noise",
            "创建响应必须回显 tunnel_security"
        );
        assert!(value["chain"]["blocked_code"].is_null(), "{value}");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::GET,
            "/api/v1/chains",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            value["items"][0]["tunnel_security"], "noise",
            "GET /chains 的 items[].tunnel_security 必须返回"
        );

        let server_a = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.a)
            .await
            .unwrap();
        let rendered_a =
            crate::routes::desired::render(&fixture.state, &server_a, "https://panel.example.com")
                .await
                .unwrap();
        assert!(rendered_a.warnings.is_empty(), "{:?}", rendered_a.warnings);
        let entry = rendered_a
            .forwards
            .iter()
            .find(|forward| forward.id == chains::legacy_forward_id(&chain_id, 0))
            .expect("入口 Dialer 必须出现在服务器 A 的期望态里");
        let dialer = entry.tunnel.as_ref().expect("entry 必须带 tunnel 段");
        assert_eq!(dialer.security, TunnelSecurity::Noise);
        assert!(
            dialer.cert_pem_path.is_empty()
                && dialer.key_pem_path.is_empty()
                && dialer.ca_pem_path.is_empty(),
            "Noise 模式不能带任何证书路径：{dialer:?}"
        );
        assert!(!dialer.hop_secret.is_empty(), "Noise 仍然需要 hop_secret");
        assert!(
            rendered_a
                .files
                .iter()
                .all(|file| !file.path.contains("/tunnel/")),
            "Noise 链不能下发隧道证书：{:?}",
            rendered_a.files
        );

        let server_b = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.b)
            .await
            .unwrap();
        let rendered_b =
            crate::routes::desired::render(&fixture.state, &server_b, "https://panel.example.com")
                .await
                .unwrap();
        assert!(rendered_b.warnings.is_empty(), "{:?}", rendered_b.warnings);
        let exit = rendered_b
            .forwards
            .iter()
            .find(|forward| forward.id == chains::legacy_forward_id(&chain_id, 1))
            .expect("出口 Listener 必须出现在服务器 B 的期望态里");
        let listener = exit.tunnel.as_ref().expect("exit 必须带 tunnel 段");
        assert_eq!(listener.security, TunnelSecurity::Noise);
        assert!(
            listener.cert_pem_path.is_empty()
                && listener.key_pem_path.is_empty()
                && listener.ca_pem_path.is_empty(),
            "Noise 模式不能带任何证书路径：{listener:?}"
        );
        assert!(
            rendered_b
                .files
                .iter()
                .all(|file| !file.path.contains("/tunnel/")),
            "Noise 链不能下发隧道证书：{:?}",
            rendered_b.files
        );
    }

    /// UDP 隧道（`protocol = both / udp`）：两跳的 `TunnelSpec.udp` 都是 true，
    /// 但 `DesiredForward.udp` 保持 false —— UDP 由隧道自己中继，不能让 native
    /// 的 UDP 转发路径在同一个端口上再绑一次。
    #[tokio::test]
    async fn udp_tunnel_chain_dispatches_tunnel_spec_udp() {
        let fixture = setup().await;
        for server_id in [&fixture.a, &fixture.b] {
            set_tunnel_capability(&fixture.state, server_id, Some(true)).await;
        }

        for (protocol, entry_port, exit_port) in [("both", 19401, 19402), ("udp", 19501, 19502)] {
            let body = json!({
                "name": format!("udp 隧道-{protocol}"),
                "target_host": "1.1.1.1",
                "target_port": 443,
                "engine": "tunnel",
                "protocol": protocol,
                "transport": "none",
                "tunnel_security": "tls",
                "groups": [
                    group(None, None, &[group_member(&fixture.a, entry_port, 0)]),
                    group(None, None, &[group_member(&fixture.b, exit_port, 0)]),
                ],
            });
            let (status, value) = request(
                &fixture.app,
                Some(&fixture.cookie),
                Method::POST,
                "/api/v1/chains",
                Some(body),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{protocol}: {value}");
            assert_eq!(value["chain"]["protocol"], protocol, "{value}");
            let chain_id = value["chain"]["id"].as_str().unwrap().to_string();

            let server_a = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.a)
                .await
                .unwrap();
            let rendered = crate::routes::desired::render(
                &fixture.state,
                &server_a,
                "https://panel.example.com",
            )
            .await
            .unwrap();
            let entry = rendered
                .forwards
                .iter()
                .find(|forward| forward.id == chains::legacy_forward_id(&chain_id, 0))
                .expect("入口 Dialer 必须在服务器 A 的期望态里");
            let dialer = entry.tunnel.as_ref().expect("entry 必须带 tunnel 段");
            assert!(dialer.udp, "{protocol}: 入口跳必须开启 UDP 中继");
            assert!(
                !entry.udp,
                "{protocol}: 隧道链不能让 native UDP 转发再绑一次同端口"
            );
            assert_eq!(
                dialer.allowed_targets.len(),
                2,
                "Dialer 的白名单仍是「下一跳 + 链目标」，UDP 选路只取最后一条"
            );
            assert_eq!(dialer.allowed_targets[1].host, "1.1.1.1");
            assert_eq!(dialer.allowed_targets[1].ports, Some((443, 443)));

            let server_b = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.b)
                .await
                .unwrap();
            let rendered_b = crate::routes::desired::render(
                &fixture.state,
                &server_b,
                "https://panel.example.com",
            )
            .await
            .unwrap();
            let exit = rendered_b
                .forwards
                .iter()
                .find(|forward| forward.id == chains::legacy_forward_id(&chain_id, 1))
                .expect("出口 Listener 必须在服务器 B 的期望态里");
            let listener = exit.tunnel.as_ref().expect("exit 必须带 tunnel 段");
            assert!(listener.udp, "{protocol}: 出口跳必须开启 UDP 中继");
            assert_eq!(
                listener.allowed_targets.len(),
                1,
                "Listener 的 UDP 白名单只能含链目标"
            );
            assert_eq!(listener.allowed_targets[0].host, "1.1.1.1");

            if protocol == "both" {
                println!(
                    "[tunnel udp spec dialer]\n{}",
                    serde_json::to_string_pretty(dialer).unwrap()
                );
                println!(
                    "[tunnel udp spec listener]\n{}",
                    serde_json::to_string_pretty(listener).unwrap()
                );
            }
        }
    }

    /// Noise + UDP 必须被明确拒绝（400），不能落库；TLS + TCP 的 Noise 隧道
    /// 仍然可用，证明拒绝只针对 UDP 中继。
    #[tokio::test]
    async fn noise_tunnel_chain_cannot_enable_udp() {
        let fixture = setup().await;
        for server_id in [&fixture.a, &fixture.b] {
            set_tunnel_capability(&fixture.state, server_id, Some(true)).await;
        }

        let body = json!({
            "name": "noise udp 隧道",
            "target_host": "1.1.1.1",
            "target_port": 443,
            "engine": "tunnel",
            "protocol": "both",
            "transport": "none",
            "tunnel_security": "noise",
            "groups": [
                group(None, None, &[group_member(&fixture.a, 19601, 0)]),
                group(None, None, &[group_member(&fixture.b, 19602, 0)]),
            ],
        });
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
        assert_eq!(value["code"], "chain.tunnel_udp_requires_tls", "{value}");
        assert_eq!(value["params"]["tunnel_security"], "noise");
        assert_eq!(value["params"]["protocol"], "both");
        let chains = repo::chains::list(&fixture.state.db.pool).await.unwrap();
        assert!(
            chains
                .iter()
                .all(|chain| chain.chain.name != "noise udp 隧道"),
            "被拒绝的链不能落库"
        );

        // TLS + both 先保存成功，再 PATCH 成 noise：也必须被拒，原值不变。
        let ok_body = json!({
            "name": "tls udp 隧道",
            "target_host": "1.1.1.1",
            "target_port": 443,
            "engine": "tunnel",
            "protocol": "both",
            "transport": "none",
            "tunnel_security": "tls",
            "groups": [
                group(None, None, &[group_member(&fixture.a, 19701, 0)]),
                group(None, None, &[group_member(&fixture.b, 19702, 0)]),
            ],
        });
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            "/api/v1/chains",
            Some(ok_body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::PATCH,
            &format!("/api/v1/chains/{chain_id}"),
            Some(json!({ "tunnel_security": "noise" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
        assert_eq!(value["code"], "chain.tunnel_udp_requires_tls", "{value}");
        let stored = repo::chains::find_by_id(&fixture.state.db.pool, &chain_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.chain.tunnel_security, "tls", "非法组合不能落库");

        // Noise + TCP 仍然允许（拒绝只针对 UDP 中继）。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::PATCH,
            &format!("/api/v1/chains/{chain_id}"),
            Some(json!({ "protocol": "tcp", "tunnel_security": "noise" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        assert_eq!(value["chain"]["tunnel_security"], "noise");
    }

    /// 非法 tunnel_security：POST / PATCH 都必须 400 + 稳定 code。
    #[tokio::test]
    async fn invalid_tunnel_security_is_rejected_with_stable_code() {
        let fixture = setup().await;
        for bad in ["wireguard", "Noise", "TLS", ""] {
            let body = json!({
                "name": "非法模式",
                "target_host": "1.1.1.1",
                "target_port": 443,
                "tunnel_security": bad,
            });
            let (status, value) = request(
                &fixture.app,
                Some(&fixture.cookie),
                Method::POST,
                "/api/v1/chains",
                Some(body),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "bad={bad:?}: {value}");
            assert_eq!(
                value["code"], "chain.tunnel_security_invalid",
                "bad={bad:?}: {value}"
            );
            assert_eq!(value["params"]["tunnel_security"], bad);
        }

        let chain = repo::chains::create(
            &fixture.state.db.pool,
            repo::chains::NewChain {
                name: "待改".into(),
                target_host: "1.1.1.1".into(),
                target_port: 443,
                enabled: true,
                engine: "native".into(),
                protocol: "tcp".into(),
                transport: "none".into(),
                tunnel_security: "tls".into(),
                groups: vec![repo::chains::NewChainGroup {
                    name: None,
                    strategy: "round_robin".into(),
                    cert_id: None,
                    public_port: None,
                    use_internal_address: false,
                    members: vec![repo::chains::NewChainGroupMember {
                        server_id: fixture.a.clone(),
                        listen_port: 9001,
                        priority: 0,
                        weight: 1,
                    }],
                }],
            },
        )
        .await
        .unwrap();
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::PATCH,
            &format!("/api/v1/chains/{}", chain.chain.id),
            Some(json!({ "tunnel_security": "wireguard" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
        assert_eq!(value["code"], "chain.tunnel_security_invalid");
        let stored = repo::chains::find_by_id(&fixture.state.db.pool, &chain.chain.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.chain.tunnel_security, "tls", "非法值不能落库");
    }

    /// tunnel 链的保存门禁：旧 Agent（NULL）与明确不支持（false）都拒绝；
    /// 跳数、成员数、transport 三类结构错误各有稳定 code；UDP 中继只在 TLS 模式。
    #[test]
    fn tunnel_chain_requires_capable_two_hop_single_member_tls_for_udp() {
        fn member(name: &str, tunnel: Option<bool>) -> ValidatedMember {
            ValidatedMember {
                server_id: format!("srv-{name}"),
                server_name: name.into(),
                server_address: "10.0.0.1".into(),
                server_internal_address: None,
                listen_port: 19401,
                priority: 0,
                weight: 1,
                nftables_available: None,
                tunnel_available: tunnel,
            }
        }
        fn coded(error: AppError) -> (String, String) {
            match error {
                AppError::Coded { code, message, .. } => (code.to_string(), message),
                other => panic!("期望带 code 的错误，实际 {other:?}"),
            }
        }
        fn group(members: Vec<ValidatedMember>) -> ValidatedGroup {
            ValidatedGroup {
                name: None,
                strategy: GroupStrategy::RoundRobin,
                cert_id: None,
                public_port: None,
                use_internal_address: false,
                members,
            }
        }

        let ok = vec![
            group(vec![member("a", Some(true))]),
            group(vec![member("b", Some(true))]),
        ];
        assert!(validate_tunnel_chain("tunnel", "tcp", "none", "tls", &ok).is_ok());
        // 非 tunnel 引擎完全不触发这些约束。
        assert!(validate_tunnel_chain("native", "both", "tls", "tls", &[]).is_ok());

        // UDP 中继（udp / both）在 TLS 模式下合法；Noise + UDP 必须拒绝。
        assert!(validate_tunnel_chain("tunnel", "both", "none", "tls", &ok).is_ok());
        assert!(validate_tunnel_chain("tunnel", "udp", "none", "tls", &ok).is_ok());
        let (code, message) =
            coded(validate_tunnel_chain("tunnel", "both", "none", "noise", &ok).unwrap_err());
        assert_eq!(code, "chain.tunnel_udp_requires_tls");
        assert!(
            message.contains("TLS") && message.contains("Noise"),
            "报错必须点名 TLS 与 Noise：{message}"
        );
        assert_eq!(
            coded(validate_tunnel_chain("tunnel", "udp", "none", "noise", &ok).unwrap_err()).0,
            "chain.tunnel_udp_requires_tls"
        );
        assert!(
            validate_tunnel_chain("tunnel", "tcp", "none", "noise", &ok).is_ok(),
            "Noise + TCP 隧道必须继续可用"
        );

        let unknown = vec![
            group(vec![member("a", Some(true))]),
            group(vec![member("b", None)]),
        ];
        let (code, message) =
            coded(validate_tunnel_chain("tunnel", "tcp", "none", "tls", &unknown).unwrap_err());
        assert_eq!(code, "chain.tunnel_unavailable");
        assert!(message.contains("b"), "{message}");

        let unsupported = vec![
            group(vec![member("a", Some(false))]),
            group(vec![member("b", Some(true))]),
        ];
        assert_eq!(
            coded(validate_tunnel_chain("tunnel", "tcp", "none", "tls", &unsupported).unwrap_err())
                .0,
            "chain.tunnel_unavailable"
        );

        let one_hop = vec![group(vec![member("a", Some(true))])];
        assert_eq!(
            coded(validate_tunnel_chain("tunnel", "tcp", "none", "tls", &one_hop).unwrap_err()).0,
            "chain.tunnel_requires_two_hops"
        );

        let multi_member = vec![
            group(vec![member("a", Some(true)), member("b", Some(true))]),
            group(vec![member("c", Some(true))]),
        ];
        assert_eq!(
            coded(
                validate_tunnel_chain("tunnel", "tcp", "none", "tls", &multi_member).unwrap_err()
            )
            .0,
            "chain.tunnel_single_member"
        );

        assert_eq!(
            coded(validate_tunnel_chain("tunnel", "tcp", "tls", "tls", &ok).unwrap_err()).0,
            "chain.tunnel_transport_conflict"
        );
    }

    /// 服务器端口约束：链的手填端口与中间跳自动分配都只能用允许集合；
    /// 集合耗尽时是 400，不换范围、不回退固定池。
    #[tokio::test]
    async fn server_port_policy_limits_manual_and_auto_allocated_chain_ports() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        // a 只额外允许 31000/31001；b 只允许 28000-28001。
        repo::servers::set_port_policy(
            &fixture.state.db.pool,
            &fixture.a,
            None,
            None,
            "[31000,31001]",
        )
        .await
        .unwrap();
        repo::servers::set_port_policy(
            &fixture.state.db.pool,
            &fixture.b,
            Some(28000),
            Some(28001),
            "[]",
        )
        .await
        .unwrap();

        // 手填的入口端口不在允许集合内 → 400 chain.port_not_allowed。
        let body = groups_body(
            "手填越界",
            "1.1.1.1",
            443,
            &[group(None, None, &[group_member(&fixture.a, 8443, 0)])],
        );
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
        assert_eq!(value["code"], "chain.port_not_allowed", "{value}");
        assert_eq!(value["params"]["port"], 8443, "{value}");
        assert_eq!(value["params"]["server"], "hk-a", "{value}");

        // 中间跳省略端口：只能从 b 的允许集合里拿到 28000（不是旧池 20000）。
        let body = groups_body(
            "受限自动分配",
            "1.1.1.1",
            443,
            &[
                group(None, None, &[group_member(&fixture.a, 31000, 0)]),
                group(None, None, &[auto_port_member(&fixture.b, 0)]),
            ],
        );
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();
        let stored = repo::chains::find_by_id(&fixture.state.db.pool, &chain_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            stored.groups[1].members[0].listen_port, 28000,
            "自动分配必须落在服务器的允许集合内"
        );

        // 占满 b 的两个允许端口后，自动分配必须硬失败。
        add_node(&fixture.state, &fixture.b, 28000).await;
        add_node(&fixture.state, &fixture.b, 28001).await;
        let body = groups_body(
            "受限耗尽",
            "1.1.1.1",
            443,
            &[
                group(None, None, &[group_member(&fixture.a, 31001, 0)]),
                group(None, None, &[auto_port_member(&fixture.b, 0)]),
            ],
        );
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
        assert_eq!(value["code"], "chain.port_allowed_exhausted", "{value}");
        assert_eq!(value["params"]["server"], "jp-b", "{value}");
    }

    /// 内网地址：开关属于「被寻址的那一组」，上一跳的 target 用该组成员
    /// 服务器的 internal_address；成员缺地址时保存 400，默认关闭时行为不变。
    #[tokio::test]
    async fn use_internal_address_changes_the_previous_hops_target() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        repo::servers::set_internal_address(&fixture.state.db.pool, &fixture.b, Some("10.9.0.2"))
            .await
            .unwrap();
        repo::servers::set_internal_address(&fixture.state.db.pool, &fixture.c, Some("10.9.0.3"))
            .await
            .unwrap();

        let body = groups_body(
            "内网链",
            "1.1.1.1",
            443,
            &[
                json!({"members": [group_member(&fixture.a, 5101, 0)]}),
                json!({
                    "use_internal_address": true,
                    "members": [
                        group_member(&fixture.b, 5102, 0),
                        group_member(&fixture.c, 5103, 1),
                    ],
                }),
            ],
        );
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        assert_eq!(
            value["chain"]["groups"][1]["use_internal_address"], true,
            "链视图必须带出组开关：{value}"
        );
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();
        let stored = repo::chains::find_by_id(&fixture.state.db.pool, &chain_id)
            .await
            .unwrap()
            .unwrap();
        let derived = derive_forwards(&stored.chain, &stored.groups);
        let entry = derived
            .iter()
            .find(|(server_id, _)| server_id == &fixture.a)
            .map(|(_, forward)| forward)
            .expect("入口组必须有下发配置");
        assert_eq!(entry.target_host, "10.9.0.2", "兼容字段也走内网地址");
        assert_eq!(entry.target_port, 5102);
        assert_eq!(entry.targets.len(), 2, "多成员下一跳要逐个给地址");
        assert_eq!(entry.targets[0].host, "10.9.0.2");
        assert_eq!(entry.targets[1].host, "10.9.0.3");

        // 默认 false：target 仍是服务器的公网 address，旧行为不变。
        let body = groups_body(
            "公网链",
            "1.1.1.1",
            443,
            &[
                json!({"members": [group_member(&fixture.a, 5201, 0)]}),
                json!({"members": [group_member(&fixture.b, 5202, 0)]}),
            ],
        );
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
        let chain_id = value["chain"]["id"].as_str().unwrap().to_string();
        let stored = repo::chains::find_by_id(&fixture.state.db.pool, &chain_id)
            .await
            .unwrap()
            .unwrap();
        let entry = derive_forwards(&stored.chain, &stored.groups)
            .into_iter()
            .find(|(server_id, _)| server_id == &fixture.a)
            .map(|(_, forward)| forward)
            .unwrap();
        assert_eq!(entry.target_host, "10.0.0.2", "默认必须保持公网地址");

        // 成员缺内网地址：保存 400，且不能落库。
        let before = repo::chains::list(&fixture.state.db.pool)
            .await
            .unwrap()
            .len();
        let body = groups_body(
            "缺内网地址",
            "1.1.1.1",
            443,
            &[
                json!({"members": [group_member(&fixture.a, 5301, 0)]}),
                json!({
                    "use_internal_address": true,
                    "members": [group_member(&fixture.d, 5302, 0)],
                }),
            ],
        );
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
        assert_eq!(value["code"], "chain.internal_address_missing", "{value}");
        assert_eq!(value["params"]["server"], "us-d", "{value}");
        assert_eq!(
            repo::chains::list(&fixture.state.db.pool)
                .await
                .unwrap()
                .len(),
            before,
            "校验失败不能落库"
        );
    }
}
