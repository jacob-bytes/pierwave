//! 期望态装配：apply、断流 apply 与 Agent 重连补发必须生成**同一份**配置。
//!
//! 几处如果各写一遍（尤其是授权集合 + 凭据派生），重连补发就会和上次 apply
//! 不一致，用户会看到「订阅里有 uuid、服务器配置里没有」。所以收敛到这里。

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use pierwave_domain::certificate;
use pierwave_domain::models::{Certificate, Server};
use pierwave_domain::{
    chains, credentials, engine, hop_transport, protocol, release, repo, time, tunnel_security,
    xray,
};
use pierwave_proto::{
    AgentUpgradePlan, DesiredForward, DesiredNode, ForwardEngine, ForwardProtocol, ManagedFile,
};

use crate::error::AppResult;
use crate::state::AppState;
use crate::tunnel_cert;

pub struct DesiredConfig {
    pub xray: Value,
    pub node_count: usize,
    pub grant_count: usize,
    /// 本次配置里有资格的用户（去重）；断流据此判断谁真的被移除了。
    pub granted_user_ids: Vec<String>,
    /// 生成配置时被跳过的节点，每个节点一条中文说明。
    pub warnings: Vec<String>,
    /// 本次要随配置落盘的证书/私钥文件（按证书 id 去重，路径稳定）。
    pub files: Vec<ManagedFile>,
    /// 已启用节点的限速信息；Agent 只认这个列表生成/清理 tc 规则。
    pub nodes: Vec<DesiredNode>,
    /// 已启用的单跳 TCP 转发规则；Agent 按它收敛监听器。
    pub forwards: Vec<DesiredForward>,
    /// 本次是否要下发 Agent 升级计划；`None` = 不升级。
    pub agent_upgrade: Option<AgentUpgradePlan>,
}

/// 一次成功下发的产物。
pub struct ApplyOutcome {
    pub version: i64,
    pub warnings: Vec<String>,
    pub delivered: usize,
}

/// 按「服务器 enabled 节点 × 有资格用户」装配完整 Xray 配置。
///
/// 凭据在这里一次性派生（`Grant::new`），`xray::build_config` 保持纯函数。
///
/// `base_url` 是对外可访问的主控地址（HTTP 请求里由 `external_base` 推出），
/// Agent 升级计划里的三个 URL 都用它拼；后台任务没有请求上下文时用
/// [`default_base_url`]。
pub async fn render(state: &AppState, server: &Server, base_url: &str) -> AppResult<DesiredConfig> {
    // 网卡绑定先解析：未上报 / 网卡不存在 / 没有可用地址都必须阻断整台服务器的
    // 下发（返回 400），绝不生成一份监听 0.0.0.0 的「降级」配置。
    let nic_address = crate::nic::resolve(
        &server.name,
        server.nic_name.as_deref(),
        &server.interfaces_json,
    )?;
    let nodes = repo::nodes::list_enabled_by_server(&state.db.pool, &server.id).await?;
    let outbounds = repo::outbounds::list_enabled_by_server(&state.db.pool, &server.id).await?;
    let rules = repo::routing_rules::list_enabled_by_server(&state.db.pool, &server.id).await?;
    let forwards = repo::forwards::list_enabled_by_server(&state.db.pool, &server.id).await?;
    let chains = repo::chains::list_enabled(&state.db.pool).await?;
    let secret = credentials::master_secret(&state.db.pool).await?;
    let pairs = repo::authorization::eligible_pairs(&state.db.pool, &server.id).await?;

    let mut seen = HashSet::new();
    let mut granted_user_ids = Vec::new();
    for pair in &pairs {
        if seen.insert(pair.user_id.as_str()) {
            granted_user_ids.push(pair.user_id.clone());
        }
    }

    let grants: Vec<xray::Grant> = pairs
        .iter()
        .map(|pair| {
            xray::Grant::limited(&secret, &pair.user_id, &pair.node_id, pair.speed_limit_kbps)
        })
        .collect();

    // 证书按 id 去重：同一张证书被多个节点/链组引用时只写一份文件。
    // 先一次性查出「节点引用的 + 启用链组引用的」，再决定哪些真的落到本机。
    let node_cert_ids: Vec<String> = {
        let mut ids: Vec<String> = nodes
            .iter()
            .filter_map(|node| node.cert_id.as_deref())
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let chain_cert_ids: Vec<String> = {
        let mut ids: Vec<String> = chains
            .iter()
            .filter(|chain| hop_transport::is_tls(&chain.chain.transport))
            .flat_map(|chain| chain.groups.iter())
            .filter(|group| group.group.seq >= 1)
            .filter_map(|group| group.group.cert_id.as_deref())
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let mut cert_ids = node_cert_ids.clone();
    cert_ids.extend(chain_cert_ids);
    cert_ids.sort();
    cert_ids.dedup();
    let certificates = repo::certificates::find_by_ids(&state.db.pool, &cert_ids).await?;

    let by_id: HashMap<&str, &Certificate> = certificates
        .iter()
        .map(|cert| (cert.id.as_str(), cert))
        .collect();
    let node_certs: Vec<xray::NodeCertificate> = nodes
        .iter()
        .filter_map(|node| {
            let cert = by_id.get(node.cert_id.as_deref()?.trim())?;
            Some(xray::NodeCertificate {
                node_id: node.id.clone(),
                cert_path: certificate::cert_file_path(&cert.id),
                key_path: certificate::key_file_path(&cert.id),
            })
        })
        .collect();

    let plan = xray::ServerPlan {
        server_name: &server.name,
        nodes: &nodes,
        grants: &grants,
        certs: &node_certs,
        outbounds: &outbounds,
        rules: &rules,
        listen_address: nic_address.as_deref(),
    };
    let (xray, mut warnings) = xray::build_config_checked_with_certs(&plan);
    // 节点告警只用于算「实际生效的节点数」，链告警不能算进去。
    let node_warning_count = warnings.len();

    // tc 只需要 id/tag/port/bandwidth；NULL 与 0 统一成 0（不限），Agent 不解析 Option。
    let desired_nodes: Vec<DesiredNode> = nodes
        .iter()
        .map(|node| DesiredNode {
            id: node.id.clone(),
            tag: node.tag.clone(),
            port: node.port,
            bandwidth_kbps: node.bandwidth_kbps.unwrap_or(0).max(0),
        })
        .collect();

    // 转发走裸 TCP，不需要凭据；只把 Agent 监听必需的四列带下去。
    let mut desired_forwards: Vec<DesiredForward> = Vec::with_capacity(forwards.len());
    for forward in &forwards {
        let engine_name = engine::from_db(&forward.engine);
        // tunnel 需要链的 hop/证书/对端信息；独立转发没有这些，必须拒绝而不是
        // 下发一个 engine=tunnel、tunnel=None 的残缺规则。
        if engine::is_tunnel(engine_name) {
            warnings.push(format!(
                "转发「{}」未下发：tunnel 引擎只能用于链",
                forward.name
            ));
            continue;
        }
        // 仅 UDP 需要 Agent 协议 >= 16：旧 Agent 会忽略 protocol 只监听 TCP，
        // 宁可不下发也不能静默降级（保留规则，等 Agent 升级后自动恢复）。
        if let Err(error) = protocol::ensure_forward_agent_supported(
            &forward.protocol,
            server.protocol_version,
            &server.name,
        ) {
            warnings.push(format!("转发「{}」未下发：{}", forward.name, error.message));
            continue;
        }
        // 旧 Agent 不认识 nftables 枚举值：能力未确认时不发，避免整份期望态解析失败。
        if engine::is_nftables(engine_name) && server.nftables_available != Some(true) {
            warnings.push(format!(
                "转发「{}」未下发：服务器没有可用的 nftables（需要安装 nft 并以 root 运行）",
                forward.name
            ));
            continue;
        }
        desired_forwards.push(DesiredForward {
            // 独立转发用 `fwd-<uuid>`；链推导用 `chain-<id>-<seq>`，两套前缀不会撞。
            id: pierwave_domain::forwards::desired_id(&forward.id),
            listen_port: forward.listen_port,
            target_host: forward.target_host.clone(),
            target_port: forward.target_port,
            targets: Vec::new(),
            strategy: Default::default(),
            // 库里的字符串已由写路径校验；读路径用 from_name 兜底旧数据。
            engine: ForwardEngine::from_name(engine_name),
            // 旧 udp 位继续填镜像值：只用于兼容旧 Agent。
            udp: protocol::is_both(&forward.protocol),
            // 读路径以 protocol 为准；非法/空串回落 tcp。
            protocol: ForwardProtocol::from_name(protocol::from_db(&forward.protocol)),
            // 独立转发永远是明文；transport 只属于链。
            listen_transport: None,
            remote_transport: None,
            disable_udp: false,
            listen_host: None,
            tunnel: None,
        });
    }

    // 链推导：只保留落在本服务器上的跳。一条链可能经过多台服务器，
    // 每台服务器只收到「自己这一跳」的 DesiredForward。
    //
    // 加密链的失败是**整链**的：证书缺失/过期/域名不匹、成员服务器能力不满足
    // 时，整条链不进 forwards（也不下发它的证书文件），warning 里写清原因。
    // 绝不为「先跑通」而退回明文。
    let mut file_cert_ids: HashSet<String> = node_cert_ids.iter().cloned().collect();
    // Tunnel 证书与 node/realm 证书可能共用目录，但路径必须唯一；按 path 去重。
    let mut files: Vec<ManagedFile> = Vec::new();
    let mut file_paths: HashSet<String> = HashSet::new();
    for chain in &chains {
        // 内网地址缺失是整链失败：保存时已经 400，这里再挡一次手工改库 /
        // 后补空地址的情况——绝不把目标静默换回公网地址继续下发。
        if let Some(reason) = chains::internal_address_blocked_reason(&chain.groups) {
            warnings.push(format!(
                "链「{}」未下发：{}",
                chain.chain.name, reason.message
            ));
            continue;
        }
        // 仅 UDP 链要求每一跳的 Agent 协议 >= 16；旧 Agent 会把它悄悄变成 TCP，
        // 整链跳过而不是降级。
        if let Some(reason) = chains::agent_protocol_blocked_reason(&chain.chain, &chain.groups) {
            warnings.push(format!(
                "链「{}」未下发：{}",
                chain.chain.name, reason.message
            ));
            continue;
        }
        if engine::is_nftables(&chain.chain.engine) {
            if let Some((seq, _)) = chain
                .groups
                .iter()
                .enumerate()
                .find(|(seq, group)| *seq >= 1 && group.members.len() > 1)
            {
                warnings.push(format!(
                    "链「{}」未下发：nftables 引擎暂不支持第 {} 组的多成员选路",
                    chain.chain.name,
                    seq + 1
                ));
                continue;
            }
            let mut unsupported: Vec<&str> = chain
                .groups
                .iter()
                .flat_map(|group| group.members.iter())
                .filter(|member| member.nftables_available != Some(true))
                .map(|member| member.server_name.as_str())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            if !unsupported.is_empty() {
                unsupported.sort_unstable();
                warnings.push(format!(
                    "链「{}」未下发：以下服务器没有可用的 nftables：{}",
                    chain.chain.name,
                    unsupported.join("、")
                ));
                continue;
            }
        }
        // P16 隧道链：自己的 CA/属证书，不走 realm 的 transport 管线。
        // 失败是整链的：能力不满足、材料签发失败都整链跳过，绝不回退明文。
        if engine::is_tunnel(&chain.chain.engine) {
            if let Some(reason) = chains::tunnel_blocked_reason(&chain.chain, &chain.groups) {
                warnings.push(format!(
                    "链「{}」未下发：{}",
                    chain.chain.name, reason.message
                ));
                continue;
            }
            let assets = if tunnel_security::is_noise(&chain.chain.tunnel_security) {
                // Noise/PSK 不读任何证书/CA 文件，也不需要主控签发材料；
                // 跳过 ensure_chain_assets 意味着既不下发文件、也不碰 CA。
                None
            } else {
                match tunnel_cert::ensure_chain_assets(&state.db.pool, &chain.groups, time::now())
                    .await
                {
                    Ok(assets) => Some(assets),
                    Err(error) => {
                        warnings.push(format!(
                            "链「{}」未下发：签发隧道证书失败：{error}",
                            chain.chain.name
                        ));
                        continue;
                    }
                }
            };
            let chain_id = chain.chain.id.clone();
            let derived =
                match super::chains::derive_tunnel_forwards(&chain.chain, &chain.groups, &|seq| {
                    credentials::tunnel_hop_secret_b64(&secret, &chain_id, seq)
                }) {
                    Ok(derived) => derived,
                    Err(error) => {
                        // 推导失败（缺成员/缺下一跳/跳数越界）= 整链不下发；
                        // 绝不降级成更少跳数或让中间跳直连目标。
                        warnings.push(format!(
                            "链「{}」未下发：{}（{}）",
                            chain.chain.name, error.message, error.code
                        ));
                        continue;
                    }
                };
            for (server_id, forward) in derived {
                if server_id != server.id {
                    continue;
                }
                let Some(tunnel) = forward.tunnel.as_ref() else {
                    continue;
                };
                match tunnel.role {
                    pierwave_proto::TunnelRole::Listener => {
                        if let Some(assets) = assets.as_ref() {
                            let Some(cert) = assets.server(&server.id) else {
                                warnings.push(format!(
                                    "链「{}」未下发：服务器 {} 缺少隧道证书",
                                    chain.chain.name, server.name
                                ));
                                break;
                            };
                            let cert_path = tunnel_cert::cert_path(&server.id);
                            if file_paths.insert(cert_path.clone()) {
                                files.push(ManagedFile {
                                    path: cert_path,
                                    content: cert.cert_pem.clone(),
                                    mode: tunnel_cert::CERT_FILE_MODE,
                                });
                            }
                            let key_path = tunnel_cert::key_path(&server.id);
                            if file_paths.insert(key_path.clone()) {
                                files.push(ManagedFile {
                                    path: key_path,
                                    content: cert.key_pem.clone(),
                                    mode: tunnel_cert::KEY_FILE_MODE,
                                });
                            }
                            // 中间跳（Listener + downstream）自己也是 dialer：
                            // 必须同时拿到 CA，否则连不了下一跳。
                            if tunnel.downstream.is_some() {
                                let ca_path = tunnel_cert::ca_path();
                                if file_paths.insert(ca_path.clone()) {
                                    files.push(ManagedFile {
                                        path: ca_path,
                                        content: assets.ca_pem.clone(),
                                        mode: tunnel_cert::CA_FILE_MODE,
                                    });
                                }
                            }
                        }
                        desired_forwards.push(forward);
                    }
                    pierwave_proto::TunnelRole::Dialer => {
                        if let Some(assets) = assets.as_ref() {
                            let ca_path = tunnel_cert::ca_path();
                            if file_paths.insert(ca_path.clone()) {
                                files.push(ManagedFile {
                                    path: ca_path,
                                    content: assets.ca_pem.clone(),
                                    mode: tunnel_cert::CA_FILE_MODE,
                                });
                            }
                        }
                        desired_forwards.push(forward);
                    }
                }
            }
            continue;
        }

        let transports = match chains::plan_from_certificates(
            &chain.chain,
            &chain.groups,
            &by_id,
            time::now(),
        ) {
            Ok(transports) => transports,
            Err(error) => {
                warnings.push(format!(
                    "链「{}」未下发：{}",
                    chain.chain.name, error.message
                ));
                continue;
            }
        };

        // 证书只发给「本机是成员」的组（seq >= 1）：上一跳只需要 SNI 字符串，
        // 不需要证书文件。按 cert_id 去重，节点也引用的证书只写一份。
        for group in &chain.groups {
            if group.group.seq == 0
                || !group
                    .members
                    .iter()
                    .any(|member| member.server_id == server.id)
            {
                continue;
            }
            if let Some(cert_id) = group.group.cert_id.as_deref() {
                file_cert_ids.insert(cert_id.to_string());
            }
        }

        for (server_id, forward) in
            super::chains::derive_forwards_with_transports(&chain.chain, &chain.groups, &transports)
        {
            if server_id == server.id {
                desired_forwards.push(forward);
            }
        }
    }

    for cert in &certificates {
        if !file_cert_ids.contains(&cert.id) {
            continue;
        }
        let cert_path = certificate::cert_file_path(&cert.id);
        if file_paths.insert(cert_path.clone()) {
            files.push(ManagedFile {
                path: cert_path,
                content: cert.cert_pem.clone(),
                mode: certificate::CERT_FILE_MODE,
            });
        }
        let key_path = certificate::key_file_path(&cert.id);
        if file_paths.insert(key_path.clone()) {
            files.push(ManagedFile {
                path: key_path,
                content: cert.key_pem.clone(),
                mode: certificate::KEY_FILE_MODE,
            });
        }
    }

    // 链路/隧道/独立转发的入口监听同样固定到网卡地址；None 时一个字段都不改。
    pin_forwards_to_nic(&mut desired_forwards, nic_address.as_deref());

    Ok(DesiredConfig {
        xray,
        node_count: nodes.len() - node_warning_count,
        grant_count: grants.len(),
        granted_user_ids,
        warnings,
        files,
        nodes: desired_nodes,
        forwards: desired_forwards,
        agent_upgrade: upgrade_plan(state, server, base_url),
    })
}

/// 把每条转发的入口监听固定到网卡地址。
///
/// `listen_host` 驱动 native / realm / nftables 的监听；隧道的 `TunnelSpec.listen`
/// 是独立字符串，也要换 host（IPv6 由 [`crate::nic::pin_listen_host`] 补方括号）。
/// `None` 时一个字段都不改，保证未配置网卡的服务器逐字节不变。
fn pin_forwards_to_nic(forwards: &mut [DesiredForward], address: Option<&str>) {
    let Some(address) = address else {
        return;
    };
    for forward in forwards {
        forward.listen_host = Some(address.to_string());
        if let Some(tunnel) = &mut forward.tunnel {
            tunnel.listen = crate::nic::pin_listen_host(&tunnel.listen, address);
        }
    }
}

/// 后台任务没有请求头，按环境变量推出对外地址。
///
/// `PIERWAVE_PUBLIC_URL` 优先（反代后的公网地址），否则退回 `PIERWAVE_ADDR`
/// 的本地监听地址。只在断流/对账这类后台 apply 里用到；HTTP 请求始终用请求头。
pub fn default_base_url() -> String {
    if let Ok(url) = std::env::var("PIERWAVE_PUBLIC_URL") {
        let url = url.trim();
        if !url.is_empty() {
            return url.trim_end_matches('/').to_string();
        }
    }
    match std::env::var("PIERWAVE_ADDR") {
        Ok(addr) if !addr.trim().is_empty() => format!("http://{}", addr.trim()),
        _ => "http://127.0.0.1:8787".into(),
    }
}

/// 心跳上报的 `arch`（`uname -m` 风格）映射到发布目标三元组。
pub(crate) fn target_for_arch(arch: &str) -> Option<&'static str> {
    match arch.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" | "x86-64" => Some("x86_64-unknown-linux-musl"),
        "aarch64" | "arm64" => Some("aarch64-unknown-linux-musl"),
        _ => None,
    }
}

/// 配置里的默认值既允许短架构名，也允许写完整三元组。
fn configured_target(target: &str) -> Option<&'static str> {
    match target.trim() {
        "x86_64-unknown-linux-musl" => Some("x86_64-unknown-linux-musl"),
        "aarch64-unknown-linux-musl" => Some("aarch64-unknown-linux-musl"),
        other => target_for_arch(other),
    }
}

/// 组装下发的升级计划。
///
/// 三个条件必须同时满足：服务器显式开启、存在目标版本、目标比当前 Agent 版本新。
/// 任何一条不满足都返回 `None`——重复下发是幂等的，但降级/同版本永远不下发。
fn upgrade_plan(state: &AppState, server: &Server, base_url: &str) -> Option<AgentUpgradePlan> {
    if !server.allow_agent_upgrade {
        return None;
    }
    let target = server.agent_target_version.as_deref()?.trim();
    let current = server.agent_version.as_deref()?.trim();
    if !release::is_valid_version(target) || current.is_empty() {
        return None;
    }
    if !release::is_newer(target, current) {
        return None;
    }

    // 心跳带了架构就按服务器的真实架构挑产物；旧 Agent 没带才回落到配置默认值。
    let arch = server.arch.trim();
    let triple = if arch.is_empty() {
        configured_target(&state.agent_release.target)?
    } else {
        target_for_arch(arch)?
    };

    let base = base_url.trim().trim_end_matches('/');
    let base = if base.is_empty() {
        default_base_url()
    } else {
        base.to_string()
    };
    Some(AgentUpgradePlan {
        version: target.to_string(),
        asset_url: format!("{base}/api/agent/release/{target}/pierwave-agent-{triple}"),
        sums_url: format!("{base}/api/agent/release/{target}/SHA256SUMS-{triple}"),
        sig_url: format!("{base}/api/agent/release/{target}/SHA256SUMS-{triple}.sig"),
    })
}

/// 手动 apply 入口：渲染后立即推送（版本号每次 +1，保持既有语义）。
pub async fn apply(state: &AppState, server: &Server, base_url: &str) -> AppResult<ApplyOutcome> {
    let desired = render(state, server, base_url).await?;
    publish(state, server, desired).await
}

/// 把已装配的配置推给 Agent，并在 push 成功后 bump `config_version`。
///
/// 这是**唯一**的推送实现：手动 apply、断流 worker 都走它，保证两条路径的
/// 版本号、日志与快照行为一致。
pub async fn publish(
    state: &AppState,
    server: &Server,
    desired: DesiredConfig,
) -> AppResult<ApplyOutcome> {
    let fingerprint = fingerprint(&desired.xray);
    let version = repo::servers::bump_config_version(&state.db.pool, &server.id).await?;

    let delivered = state.hub.publish(
        &server.id,
        pierwave_proto::MasterMessage::Desired(pierwave_proto::DesiredState {
            version,
            xray: desired.xray,
            files: desired.files,
            agent_upgrade: desired.agent_upgrade,
            forwards: desired.forwards,
            nodes: desired.nodes,
        }),
    );

    // 快照有两份信息：
    // * fingerprint/config_version 判断「期望态有没有变化」；
    // * granted_users 是下一次对账判断「谁该恢复」的基准。
    // 写失败只影响下一轮对账的精度，不影响本次下发。
    if let Err(error) = repo::desired::save(
        &state.db.pool,
        &server.id,
        &fingerprint,
        version,
        &desired.granted_user_ids,
        time::now(),
    )
    .await
    {
        tracing::error!(server = %server.name, error = %error, "保存期望态快照失败");
    }

    for warning in &desired.warnings {
        tracing::warn!(server = %server.name, "{warning}");
    }
    tracing::info!(
        server = %server.name,
        version,
        nodes = desired.node_count,
        grants = desired.grant_count,
        skipped = desired.warnings.len(),
        delivered,
        "desired state published"
    );

    Ok(ApplyOutcome {
        version,
        warnings: desired.warnings,
        delivered,
    })
}

/// 渲染结果的稳定指纹（FNV-1a 64 位）。
///
/// 用固定算法而不是 `DefaultHasher`：指纹会落库，跨进程重启后必须还能比较。
pub fn fingerprint(xray: &Value) -> String {
    let bytes = serde_json::to_vec(xray).unwrap_or_default();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use serde_json::json;

    use pierwave_domain::Db;

    /// 领域层的多跳门禁与线协议常量必须一致（与 UDP 的同名断言同一目的）。
    #[test]
    fn domain_tunnel_multihop_min_protocol_matches_wire_constant() {
        assert_eq!(
            pierwave_domain::chains::TUNNEL_MULTIHOP_MIN_PROTOCOL_VERSION,
            i64::from(pierwave_proto::TUNNEL_MULTIHOP_PROTOCOL_VERSION),
            "主控门禁与线协议的多跳常量必须一致"
        );
    }

    /// 领域层的 Noise+UDP 门禁与线协议常量必须一致。
    #[test]
    fn domain_tunnel_noise_udp_min_protocol_matches_wire_constant() {
        assert_eq!(
            pierwave_domain::chains::TUNNEL_NOISE_UDP_MIN_PROTOCOL_VERSION,
            i64::from(pierwave_proto::TUNNEL_NOISE_UDP_PROTOCOL_VERSION),
            "主控门禁与线协议的 Noise+UDP 常量必须一致"
        );
    }

    #[test]
    fn fingerprint_is_stable_and_sensitive() {
        let a = json!({"inbounds": [{"tag": "hk-1", "port": 443}]});
        let b = json!({"inbounds": [{"tag": "hk-1", "port": 443}]});
        let c = json!({"inbounds": [{"tag": "hk-1", "port": 8443}]});

        assert_eq!(fingerprint(&a), fingerprint(&b), "同样输入必须同指纹");
        assert_ne!(fingerprint(&a), fingerprint(&c), "端口变化必须换指纹");
        // 固定算法：重启后仍能比较（写死一个期望值防止被误改成随机哈希）。
        assert_eq!(fingerprint(&json!({})), "08f44b07b5901a25");
    }

    /// 造一台带心跳版本的服务器；`target` / `allow` 通过 PATCH 同一套仓储写入。
    async fn fixture(allow: bool, current: &str, target: Option<&str>) -> (AppState, Server) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let (server, _token) = repo::servers::create(&db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        repo::servers::update(&db.pool, &server.id, None, None, None, Some(allow))
            .await
            .unwrap();
        repo::servers::update_health(
            &db.pool,
            &server.id,
            current,
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        repo::servers::set_agent_target_version(&db.pool, &server.id, target)
            .await
            .unwrap();

        let mut state = AppState::new(db, "web/dist");
        state.agent_release.target = "x86_64-unknown-linux-musl".into();
        let server = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();
        (state, server)
    }

    /// nftables 规则只在服务器明确上报能力后才进期望态；否则只加 warning。
    #[tokio::test]
    async fn nftables_forward_is_gated_by_agent_capability() {
        let (state, server) = fixture(false, "0.8.0", None).await;
        repo::forwards::create(
            &state.db.pool,
            &server.id,
            repo::forwards::NewForward {
                name: "nft".into(),
                listen_port: 18443,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: true,
                count_traffic: false,
                engine: "nftables".into(),
                protocol: "tcp".into(),
            },
        )
        .await
        .unwrap();

        let desired = render(&state, &server, "https://panel.example.com")
            .await
            .unwrap();
        assert!(
            desired.forwards.is_empty(),
            "能力未知时不能把 nftables 枚举发给旧 Agent"
        );
        assert!(
            desired
                .warnings
                .iter()
                .any(|warning| warning.contains("nftables")),
            "{:?}",
            desired.warnings
        );

        repo::servers::update_health(
            &state.db.pool,
            &server.id,
            "0.8.0",
            &repo::servers::HealthSnapshot {
                nftables_available: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let server = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();
        let desired = render(&state, &server, "https://panel.example.com")
            .await
            .unwrap();
        assert_eq!(desired.forwards.len(), 1);
        assert_eq!(desired.forwards[0].engine, ForwardEngine::Nftables);
    }

    /// 旧 Agent 的仅 UDP 转发：不下发、给 warning，绝不降级成 TCP。
    #[tokio::test]
    async fn udp_only_forward_is_skipped_for_old_agent() {
        let (state, server) = fixture(false, "0.9.0", None).await;
        assert_eq!(server.protocol_version, None, "fixture 默认未上报");
        repo::forwards::create(
            &state.db.pool,
            &server.id,
            repo::forwards::NewForward {
                name: "仅 UDP".into(),
                listen_port: 18443,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: true,
                count_traffic: false,
                engine: "native".into(),
                protocol: "udp".into(),
            },
        )
        .await
        .unwrap();

        // 从未上报 / 明确 15：都不下发，也不生成 TCP 规则。
        for version in [None, Some(15)] {
            repo::servers::update_health(
                &state.db.pool,
                &server.id,
                "0.9.0",
                &repo::servers::HealthSnapshot {
                    protocol_version: version,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let server = repo::servers::find_by_id(&state.db.pool, &server.id)
                .await
                .unwrap();
            let desired = render(&state, &server, "https://panel.example.com")
                .await
                .unwrap();
            assert!(
                desired.forwards.is_empty(),
                "version={version:?} 时不能下发（更不能降级成 TCP）：{:?}",
                desired.forwards
            );
            assert!(
                desired
                    .warnings
                    .iter()
                    .any(|warning| warning.contains("升级 Agent")),
                "version={version:?} warnings={:?}",
                desired.warnings
            );
        }

        // 协议 16 起恢复正常下发，协议保持 udp。
        repo::servers::update_health(
            &state.db.pool,
            &server.id,
            "0.9.0",
            &repo::servers::HealthSnapshot {
                protocol_version: Some(16),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let server = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();
        let desired = render(&state, &server, "https://panel.example.com")
            .await
            .unwrap();
        assert_eq!(desired.forwards.len(), 1);
        assert_eq!(desired.forwards[0].protocol, ForwardProtocol::Udp);
        assert!(!desired.forwards[0].udp, "仅 UDP 不能误标旧镜像位");
    }

    #[tokio::test]
    async fn no_plan_when_switch_is_off() {
        let (state, server) = fixture(false, "0.5.0", Some("0.6.0")).await;
        let desired = render(&state, &server, "https://panel.example.com")
            .await
            .unwrap();
        assert!(desired.agent_upgrade.is_none(), "开关关闭时不能下发升级");
    }

    #[tokio::test]
    async fn no_plan_when_target_is_not_newer() {
        // 同版本
        let (state, server) = fixture(true, "0.6.0", Some("0.6.0")).await;
        assert!(
            render(&state, &server, "https://panel.example.com")
                .await
                .unwrap()
                .agent_upgrade
                .is_none(),
            "同版本不应重复下发"
        );

        // 降级
        let (state, server) = fixture(true, "0.6.0", Some("0.5.0")).await;
        assert!(
            render(&state, &server, "https://panel.example.com")
                .await
                .unwrap()
                .agent_upgrade
                .is_none(),
            "降级不能下发"
        );

        // 目标存在但还没拿到当前版本：无法比较，同样不下发。
        let (state, server) = fixture(true, "", Some("0.6.0")).await;
        assert!(
            render(&state, &server, "https://panel.example.com")
                .await
                .unwrap()
                .agent_upgrade
                .is_none(),
            "当前版本未知时不应下发"
        );
    }

    #[tokio::test]
    async fn plans_upgrade_with_relay_urls_when_enabled_and_newer() {
        let (state, server) = fixture(true, "0.5.0", Some("0.6.0")).await;
        let plan = render(&state, &server, "https://panel.example.com")
            .await
            .unwrap()
            .agent_upgrade
            .expect("开启且更新时必须下发升级计划");

        assert_eq!(plan.version, "0.6.0");
        assert_eq!(
            plan.asset_url,
            "https://panel.example.com/api/agent/release/0.6.0/pierwave-agent-x86_64-unknown-linux-musl"
        );
        assert_eq!(
            plan.sums_url,
            "https://panel.example.com/api/agent/release/0.6.0/SHA256SUMS-x86_64-unknown-linux-musl"
        );
        assert_eq!(
            plan.sig_url,
            "https://panel.example.com/api/agent/release/0.6.0/SHA256SUMS-x86_64-unknown-linux-musl.sig"
        );
    }

    #[tokio::test]
    async fn picks_asset_arch_from_heartbeat() {
        let (state, server) = fixture(true, "0.5.0", Some("0.6.0")).await;
        repo::servers::update_health(
            &state.db.pool,
            &server.id,
            "0.5.0",
            &repo::servers::HealthSnapshot {
                arch: "aarch64".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let server = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();
        let plan = render(&state, &server, "https://panel.example.com")
            .await
            .unwrap()
            .agent_upgrade
            .expect("开启且更新时必须下发升级计划");
        assert!(
            plan.asset_url
                .contains("pierwave-agent-aarch64-unknown-linux-musl"),
            "{}",
            plan.asset_url
        );

        // 不认识的架构：宁可不升级，也不能下发一个必然验签失败的产物。
        repo::servers::update_health(
            &state.db.pool,
            &server.id,
            "0.5.0",
            &repo::servers::HealthSnapshot {
                arch: "mips".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let server = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();
        assert!(
            render(&state, &server, "https://panel.example.com")
                .await
                .unwrap()
                .agent_upgrade
                .is_none(),
            "未知架构不能下发升级"
        );
    }

    /// 独立单跳转发与链推导的转发必须合并进同一份 desired.forwards，
    /// 且 id 分别使用 `fwd-` 与 `chain-` 前缀，不能互相覆盖。
    #[tokio::test]
    async fn desired_state_merges_standalone_and_chain_forwards() {
        let (state, server_a) = fixture(false, "", None).await;
        let (server_b, _) = repo::servers::create(&state.db.pool, "jp-1", "10.0.0.2", "external")
            .await
            .unwrap();

        let standalone = repo::forwards::create(
            &state.db.pool,
            &server_a.id,
            repo::forwards::NewForward {
                name: "独立转发".into(),
                listen_port: 8443,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: true,
                count_traffic: false,
                engine: "native".into(),
                protocol: "tcp".into(),
            },
        )
        .await
        .unwrap();

        // 两跳链：A:9001 → B:9002 → 1.1.1.1:443。
        let chain = repo::chains::create(
            &state.db.pool,
            repo::chains::NewChain {
                name: "港-日".into(),
                target_host: "1.1.1.1".into(),
                target_port: 443,
                enabled: true,
                engine: "native".into(),
                protocol: "tcp".into(),
                transport: "none".into(),
                tunnel_security: "tls".into(),
                groups: vec![
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: None,
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: server_a.id.clone(),
                            listen_port: 9001,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: None,
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: server_b.id.clone(),
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

        let rendered = render(&state, &server_a, "https://panel.example.com")
            .await
            .unwrap();
        assert_eq!(rendered.forwards.len(), 2, "独立 + 链入口共两条");
        let standalone_id = pierwave_domain::forwards::desired_id(&standalone.id);
        let entry_id = pierwave_domain::chains::legacy_forward_id(&chain.chain.id, 0);
        assert_ne!(standalone_id, entry_id, "两种 id 前缀不能冲突");
        let standalone_forward = rendered
            .forwards
            .iter()
            .find(|forward| forward.id == standalone_id)
            .expect("独立转发必须在期望态里");
        assert_eq!(standalone_forward.listen_port, 8443);
        assert_eq!(standalone_forward.target_host, "10.0.0.8");
        assert_eq!(standalone_forward.target_port, 443);

        let entry = rendered
            .forwards
            .iter()
            .find(|forward| forward.id == entry_id)
            .expect("链入口必须出现在第一跳服务器的期望态里");
        assert_eq!(entry.listen_port, 9001);
        assert_eq!(
            entry.target_host, server_b.address,
            "第一跳指向下一跳服务器地址"
        );
        assert_eq!(entry.target_port, 9002);
        assert!(
            entry.targets.is_empty(),
            "单成员组必须继续走兼容字段，下发结果与旧版一致"
        );
        assert_eq!(entry.listen_transport, None, "明文链不能凭空多出 transport");
        assert_eq!(entry.remote_transport, None);
        assert!(!entry.disable_udp, "明文链必须保持全局 use_udp 行为");

        let rendered_b = render(&state, &server_b, "https://panel.example.com")
            .await
            .unwrap();
        assert_eq!(rendered_b.forwards.len(), 1, "第二台服务器只收到自己这一跳");
        let exit = &rendered_b.forwards[0];
        assert_eq!(
            exit.id,
            pierwave_domain::chains::legacy_forward_id(&chain.chain.id, 1)
        );
        assert_eq!(exit.listen_port, 9002);
        assert_eq!(exit.target_host, "1.1.1.1", "最后一跳指向链目标");
        assert_eq!(exit.target_port, 443);
        assert!(exit.targets.is_empty());
        assert_eq!(exit.listen_transport, None, "明文链没有加密端点");
        assert_eq!(exit.remote_transport, None);
        assert!(!exit.disable_udp);
    }

    /// 独立转发的 engine 必须透传到期望态；缺省（库默认值）是 native。
    #[tokio::test]
    async fn desired_state_carries_forward_engine() {
        let (state, server) = fixture(false, "", None).await;
        let realm_forward = repo::forwards::create(
            &state.db.pool,
            &server.id,
            repo::forwards::NewForward {
                name: "realm 转发".into(),
                listen_port: 8443,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: true,
                count_traffic: false,
                engine: "realm".into(),
                protocol: "tcp".into(),
            },
        )
        .await
        .unwrap();
        let native_forward = repo::forwards::create(
            &state.db.pool,
            &server.id,
            repo::forwards::NewForward {
                name: "native 转发".into(),
                listen_port: 9443,
                target_host: "10.0.0.9".into(),
                target_port: 443,
                enabled: true,
                count_traffic: false,
                engine: "native".into(),
                protocol: "tcp".into(),
            },
        )
        .await
        .unwrap();

        let rendered = render(&state, &server, "https://panel.example.com")
            .await
            .unwrap();
        let engine_of = |id: &str| {
            rendered
                .forwards
                .iter()
                .find(|forward| forward.id == pierwave_domain::forwards::desired_id(id))
                .map(|forward| forward.engine)
                .expect("规则必须在期望态里")
        };
        assert_eq!(
            engine_of(&realm_forward.id),
            ForwardEngine::Realm,
            "realm 规则必须带 realm 引擎"
        );
        assert_eq!(
            engine_of(&native_forward.id),
            ForwardEngine::Native,
            "native 规则必须带 native 引擎"
        );
    }

    /// 期望态只带启用的转发；`publish` 必须原样放进 DesiredState.forwards。
    #[tokio::test]
    async fn desired_state_carries_only_enabled_forwards() {
        let (state, server) = fixture(false, "", None).await;
        let enabled = repo::forwards::create(
            &state.db.pool,
            &server.id,
            repo::forwards::NewForward {
                name: "香港中转".into(),
                listen_port: 8443,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: true,
                count_traffic: false,
                engine: "native".into(),
                protocol: "tcp".into(),
            },
        )
        .await
        .unwrap();
        repo::forwards::create(
            &state.db.pool,
            &server.id,
            repo::forwards::NewForward {
                name: "已停用".into(),
                listen_port: 9443,
                target_host: "10.0.0.9".into(),
                target_port: 443,
                enabled: false,
                count_traffic: false,
                engine: "native".into(),
                protocol: "tcp".into(),
            },
        )
        .await
        .unwrap();

        let rendered = render(&state, &server, "https://panel.example.com")
            .await
            .unwrap();
        assert_eq!(rendered.forwards.len(), 1, "停用规则不能进入期望态");
        assert_eq!(
            rendered.forwards[0].id,
            pierwave_domain::forwards::desired_id(&enabled.id),
            "独立转发在期望态里的 id 必须带 fwd- 前缀"
        );
        assert_eq!(rendered.forwards[0].listen_port, 8443);
        assert_eq!(rendered.forwards[0].target_host, "10.0.0.8");
        assert_eq!(rendered.forwards[0].target_port, 443);

        let mut subscription = state.hub.subscribe(&server.id);
        let outcome = publish(&state, &server, rendered).await.unwrap();
        assert_eq!(outcome.version, 1);

        let message = subscription.receiver.recv().await.unwrap();
        match message {
            pierwave_proto::MasterMessage::Desired(desired) => {
                assert_eq!(
                    desired.forwards,
                    vec![DesiredForward {
                        id: pierwave_domain::forwards::desired_id(&enabled.id),
                        listen_port: 8443,
                        target_host: "10.0.0.8".into(),
                        target_port: 443,
                        targets: Vec::new(),
                        strategy: Default::default(),
                        engine: ForwardEngine::Native,
                        protocol: Default::default(),
                        udp: false,
                        listen_transport: None,
                        remote_transport: None,
                        disable_udp: false,
                        listen_host: None,
                        tunnel: None,
                    }]
                );
            }
            other => panic!("expected desired state, got {other:?}"),
        }
    }
    /// P16 隧道链：2 跳、成员都上报 tunnel 能力时，期望态必须带
    /// Dialer/Listener 两段 TunnelSpec 与对应证书文件。
    #[tokio::test]
    async fn desired_state_carries_tunnel_chain_specs_and_files() {
        let (state, server_a) = fixture(false, "0.8.0", None).await;
        let (server_b, _) =
            repo::servers::create(&state.db.pool, "jp-tunnel", "10.0.0.2", "external")
                .await
                .unwrap();
        for id in [&server_a.id, &server_b.id] {
            repo::servers::update_health(
                &state.db.pool,
                id,
                "0.8.0",
                &repo::servers::HealthSnapshot {
                    tunnel_available: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let server_a = repo::servers::find_by_id(&state.db.pool, &server_a.id)
            .await
            .unwrap();
        let server_b = repo::servers::find_by_id(&state.db.pool, &server_b.id)
            .await
            .unwrap();

        let chain = repo::chains::create(
            &state.db.pool,
            repo::chains::NewChain {
                name: "港-日 tunnel".into(),
                target_host: "1.1.1.1".into(),
                target_port: 443,
                enabled: true,
                engine: "tunnel".into(),
                protocol: "tcp".into(),
                transport: "none".into(),
                tunnel_security: "tls".into(),
                groups: vec![
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: None,
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: server_a.id.clone(),
                            listen_port: 19401,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: None,
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: server_b.id.clone(),
                            listen_port: 19402,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                ],
            },
        )
        .await
        .unwrap();

        let rendered_a = render(&state, &server_a, "https://panel.example.com")
            .await
            .unwrap();
        let entry = rendered_a
            .forwards
            .iter()
            .find(|forward| {
                forward.id == pierwave_domain::chains::legacy_forward_id(&chain.chain.id, 0)
            })
            .expect("入口 Dialer 必须出现在服务器 A 的期望态里");
        assert_eq!(entry.engine, ForwardEngine::Tunnel);
        let dialer = entry.tunnel.as_ref().expect("entry 必须带 tunnel 段");
        assert_eq!(dialer.role, pierwave_proto::TunnelRole::Dialer);
        assert_eq!(
            dialer.security,
            pierwave_proto::TunnelSecurity::Tls,
            "显式 tls 链必须下发 TLS 模式"
        );
        assert_eq!(dialer.listen, "0.0.0.0:19401");
        assert_eq!(dialer.remote, "10.0.0.2:19402");
        assert_eq!(dialer.ca_pem_path, "/usr/local/etc/pierwave/tunnel/ca.pem");
        assert!(!dialer.hop_secret.is_empty());
        assert_eq!(
            dialer.allowed_targets,
            vec![
                pierwave_proto::TunnelTargetRule {
                    host: "10.0.0.2".into(),
                    ports: Some((19402, 19402)),
                },
                pierwave_proto::TunnelTargetRule {
                    host: "1.1.1.1".into(),
                    ports: Some((443, 443)),
                },
            ],
            "Dialer 先用白名单约束 remote，再请求链目标"
        );
        assert!(
            rendered_a
                .files
                .iter()
                .any(|file| file.path.ends_with("/tunnel/ca.pem") && file.mode == 0o644),
            "Dialer 必须拿到 0644 的 ca.pem: {:?}",
            rendered_a.files
        );

        let rendered_b = render(&state, &server_b, "https://panel.example.com")
            .await
            .unwrap();
        let exit = rendered_b
            .forwards
            .iter()
            .find(|forward| {
                forward.id == pierwave_domain::chains::legacy_forward_id(&chain.chain.id, 1)
            })
            .expect("出口 Listener 必须出现在服务器 B 的期望态里");
        let listener = exit.tunnel.as_ref().expect("exit 必须带 tunnel 段");
        assert_eq!(listener.role, pierwave_proto::TunnelRole::Listener);
        assert_eq!(
            listener.security,
            pierwave_proto::TunnelSecurity::Tls,
            "TLS 链的 Listener 也必须下发 TLS 模式"
        );
        assert_eq!(listener.listen, "0.0.0.0:19402");
        assert!(listener.remote.is_empty());
        assert_eq!(
            listener.cert_pem_path,
            format!("/usr/local/etc/pierwave/tunnel/{}.pem", server_b.id)
        );
        assert_eq!(
            listener.key_pem_path,
            format!("/usr/local/etc/pierwave/tunnel/{}.key", server_b.id)
        );
        let cert_file = rendered_b
            .files
            .iter()
            .find(|file| file.path == listener.cert_pem_path)
            .expect("Listener 必须拿到属证书");
        assert_eq!(cert_file.mode, 0o600);
        assert!(cert_file.content.starts_with("-----BEGIN CERTIFICATE-----"));
        let key_file = rendered_b
            .files
            .iter()
            .find(|file| file.path == listener.key_pem_path)
            .expect("Listener 必须拿到私钥");
        assert_eq!(key_file.mode, 0o600);
        assert!(key_file.content.contains("PRIVATE KEY"));
        assert!(
            rendered_b
                .files
                .iter()
                .all(|file| !file.path.ends_with("/ca.pem")),
            "Listener 不需要 CA 文件: {:?}",
            rendered_b.files
        );

        // 两侧 hop_secret 必须一致且等于文档里的派生。
        assert_eq!(dialer.hop_secret, listener.hop_secret);
        let secret = credentials::master_secret(&state.db.pool).await.unwrap();
        let expected = base64::engine::general_purpose::STANDARD
            .encode(credentials::tunnel_hop_secret(&secret, &chain.chain.id, 1));
        assert_eq!(dialer.hop_secret, expected);

        // 2 跳配置与多跳改动前**逐字段**一致：TunnelSpec 只有新增的
        // `downstream`，且 None 时序列化根本不出现这个键。
        assert!(dialer.downstream.is_none());
        assert!(listener.downstream.is_none());
        let dialer_json = serde_json::to_value(dialer).unwrap();
        assert_eq!(
            dialer_json,
            serde_json::json!({
                "role": "dialer",
                "hop_id": format!("{}:1", chain.chain.id),
                "listen": "0.0.0.0:19401",
                "remote": "10.0.0.2:19402",
                "security": "tls",
                "cert_pem_path": "",
                "key_pem_path": "",
                "ca_pem_path": "/usr/local/etc/pierwave/tunnel/ca.pem",
                "hop_secret": expected,
                "allowed_targets": [
                    { "host": "10.0.0.2", "ports": [19402, 19402] },
                    { "host": "1.1.1.1", "ports": [443, 443] },
                ],
                "udp": false,
            }),
            "2 跳 Dialer 的线协议字段必须与升级前完全一致"
        );
        assert!(
            dialer_json.get("downstream").is_none(),
            "2 跳配置不能出现 downstream 键"
        );
        let listener_json = serde_json::to_value(listener).unwrap();
        assert_eq!(
            listener_json,
            serde_json::json!({
                "role": "listener",
                "hop_id": format!("{}:1", chain.chain.id),
                "listen": "0.0.0.0:19402",
                "remote": "",
                "security": "tls",
                "cert_pem_path": format!("/usr/local/etc/pierwave/tunnel/{}.pem", server_b.id),
                "key_pem_path": format!("/usr/local/etc/pierwave/tunnel/{}.key", server_b.id),
                "ca_pem_path": "",
                "hop_secret": expected,
                "allowed_targets": [
                    { "host": "1.1.1.1", "ports": [443, 443] },
                ],
                "udp": false,
            }),
            "2 跳 Listener 的线协议字段必须与升级前完全一致"
        );
        assert!(
            listener_json.get("downstream").is_none(),
            "2 跳配置不能出现 downstream 键"
        );
    }

    /// tunnel 链在成员能力未知时必须整链跳过（render 层门禁），并给出 warning。
    #[tokio::test]
    async fn tunnel_chain_is_skipped_when_capability_is_unknown() {
        let (state, server_a) = fixture(false, "0.8.0", None).await;
        let (server_b, _) = repo::servers::create(&state.db.pool, "jp-old", "10.0.0.2", "external")
            .await
            .unwrap();
        // 只有 A 明确支持；B 保持 NULL（旧 Agent）。
        repo::servers::update_health(
            &state.db.pool,
            &server_a.id,
            "0.8.0",
            &repo::servers::HealthSnapshot {
                tunnel_available: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let server_a = repo::servers::find_by_id(&state.db.pool, &server_a.id)
            .await
            .unwrap();

        repo::chains::create(
            &state.db.pool,
            repo::chains::NewChain {
                name: "旧 Agent".into(),
                target_host: "1.1.1.1".into(),
                target_port: 443,
                enabled: true,
                engine: "tunnel".into(),
                protocol: "tcp".into(),
                transport: "none".into(),
                tunnel_security: "tls".into(),
                groups: vec![
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: None,
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: server_a.id.clone(),
                            listen_port: 19401,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: None,
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: server_b.id.clone(),
                            listen_port: 19402,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                ],
            },
        )
        .await
        .unwrap();

        let rendered = render(&state, &server_a, "https://panel.example.com")
            .await
            .unwrap();
        assert!(
            rendered.forwards.is_empty(),
            "能力未知时整链不能下发: {:?}",
            rendered.forwards
        );
        assert!(
            rendered
                .warnings
                .iter()
                .any(|warning| warning.contains("tunnel") && warning.contains("不支持")),
            "{:?}",
            rendered.warnings
        );
    }

    async fn set_interfaces(state: &AppState, server_id: &str, interfaces: &str) {
        repo::servers::update_health(
            &state.db.pool,
            server_id,
            "0.9.5",
            &repo::servers::HealthSnapshot {
                interfaces_json: interfaces.to_string(),
                interfaces_reported: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    fn sample_node() -> repo::nodes::NewNode {
        repo::nodes::NewNode {
            tag: Some("vless-1".into()),
            name: "vless-1".into(),
            protocol: "vless".into(),
            transport: "tcp".into(),
            security: "none".into(),
            port: 443,
            public_port: None,
            config_json: r#"{"settings":{"clients":[],"decryption":"none"}}"#.into(),
            enabled: true,
            cert_id: None,
            bandwidth_kbps: None,
        }
    }

    /// 网卡地址同时注入 xray（入站 listen / 出站 sendThrough）与转发 listen_host。
    #[tokio::test]
    async fn nic_address_pins_xray_and_forward_listen_addresses() {
        let (state, server) = fixture(false, "0.9.5", None).await;
        repo::nodes::create(&state.db.pool, &server.id, sample_node())
            .await
            .unwrap();
        repo::forwards::create(
            &state.db.pool,
            &server.id,
            repo::forwards::NewForward {
                name: "入口".into(),
                listen_port: 18443,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: true,
                count_traffic: false,
                engine: "native".into(),
                protocol: "tcp".into(),
            },
        )
        .await
        .unwrap();
        set_interfaces(
            &state,
            &server.id,
            r#"[{"name":"eth0","addresses":["10.0.0.2","2001:db8::2"]}]"#,
        )
        .await;
        repo::servers::set_nic_name(&state.db.pool, &server.id, Some("eth0"))
            .await
            .unwrap();
        let server = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();

        let desired = render(&state, &server, "https://panel.example.com")
            .await
            .unwrap();
        let inbounds = desired.xray["inbounds"].as_array().unwrap();
        let node = inbounds
            .iter()
            .find(|inbound| inbound["tag"] != "api")
            .unwrap();
        assert_eq!(node["listen"], "10.0.0.2");
        let api = inbounds
            .iter()
            .find(|inbound| inbound["tag"] == "api")
            .unwrap();
        assert_eq!(api["listen"], "127.0.0.1", "API 入站永远只绑回环");
        for outbound in desired.xray["outbounds"].as_array().unwrap() {
            assert_eq!(
                outbound["streamSettings"]["sockopt"]["sendThrough"], "10.0.0.2",
                "每个出站都必须走网卡：{}",
                outbound["tag"]
            );
        }
        assert_eq!(desired.forwards.len(), 1);
        assert_eq!(
            desired.forwards[0].listen_host.as_deref(),
            Some("10.0.0.2"),
            "独立转发的监听地址也必须固定到网卡"
        );
    }

    /// 隧道 listen 是独立字符串：IPv6 要补方括号；None 时一个字段都不许改。
    #[test]
    fn pin_forwards_to_nic_handles_tunnel_listen_and_legacy_none() {
        let tunnel = pierwave_proto::TunnelSpec {
            role: pierwave_proto::TunnelRole::Listener,
            hop_id: "hop-1".into(),
            listen: "0.0.0.0:19401".into(),
            remote: String::new(),
            security: pierwave_proto::TunnelSecurity::Tls,
            cert_pem_path: String::new(),
            key_pem_path: String::new(),
            ca_pem_path: String::new(),
            hop_secret: String::new(),
            allowed_targets: Vec::new(),
            udp: false,
            downstream: None,
        };
        let make = |tunnel: Option<pierwave_proto::TunnelSpec>| DesiredForward {
            id: "fwd-1".into(),
            listen_port: 19401,
            target_host: "10.0.0.8".into(),
            target_port: 443,
            targets: Vec::new(),
            strategy: Default::default(),
            engine: ForwardEngine::Tunnel,
            udp: false,
            protocol: ForwardProtocol::Tcp,
            listen_transport: None,
            remote_transport: None,
            listen_host: None,
            disable_udp: false,
            tunnel,
        };
        let legacy = make(Some(tunnel.clone()));
        let mut pinned = vec![legacy.clone()];
        pin_forwards_to_nic(&mut pinned, Some("2001:db8::2"));
        assert_eq!(pinned[0].listen_host.as_deref(), Some("2001:db8::2"));
        assert_eq!(
            pinned[0].tunnel.as_ref().unwrap().listen,
            "[2001:db8::2]:19401"
        );

        let mut untouched = vec![legacy.clone()];
        pin_forwards_to_nic(&mut untouched, None);
        assert_eq!(untouched, vec![legacy], "没有网卡时转发必须逐字段不变");
    }

    /// 网卡没有可用地址：整台服务器阻断，错误里写清原因，绝不回退 0.0.0.0。
    #[tokio::test]
    async fn nic_without_usable_address_blocks_the_server() {
        let (state, server) = fixture(false, "0.9.5", None).await;
        set_interfaces(&state, &server.id, r#"[{"name":"eth1","addresses":[]}]"#).await;
        repo::servers::set_nic_name(&state.db.pool, &server.id, Some("eth1"))
            .await
            .unwrap();
        let server = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();

        let error = match render(&state, &server, "https://panel.example.com").await {
            Ok(_) => panic!("没有可用地址时不能生成期望态"),
            Err(error) => error,
        };
        let text = error.to_string();
        assert!(
            text.contains("eth1") && text.contains("没有可用地址"),
            "{text}"
        );
        match error {
            crate::error::AppError::Coded { code, .. } => {
                assert_eq!(code, "server.nic_address_unavailable")
            }
            other => panic!("必须是带 code 的 400：{other:?}"),
        }
    }

    /// 尚未上报网卡：同样阻断下发（不能猜地址），但允许保存由写路径负责。
    #[tokio::test]
    async fn unreported_interfaces_block_dispatch() {
        let (state, server) = fixture(false, "0.9.5", None).await;
        repo::servers::set_nic_name(&state.db.pool, &server.id, Some("eth0"))
            .await
            .unwrap();
        let server = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();
        let error = match render(&state, &server, "https://panel.example.com").await {
            Ok(_) => panic!("尚未上报网卡时不能生成期望态"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("尚未上报"), "{error}");
    }

    /// 旧 Agent（没有 interfaces、服务器没配 nic_name）：配置形状与升级前一致。
    #[tokio::test]
    async fn no_nic_keeps_legacy_xray_shape() {
        let (state, server) = fixture(false, "0.9.5", None).await;
        repo::nodes::create(&state.db.pool, &server.id, sample_node())
            .await
            .unwrap();
        let server = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();
        let desired = render(&state, &server, "https://panel.example.com")
            .await
            .unwrap();
        let inbound = desired.xray["inbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|inbound| inbound["tag"] != "api")
            .unwrap();
        assert!(inbound.get("listen").is_none());
        for outbound in desired.xray["outbounds"].as_array().unwrap() {
            assert!(outbound.get("streamSettings").is_none(), "{outbound}");
        }
        assert!(desired.forwards.is_empty());
    }
}
