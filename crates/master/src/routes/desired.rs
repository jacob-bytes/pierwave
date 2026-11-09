//! 期望态装配：apply、断流 apply 与 Agent 重连补发必须生成**同一份**配置。
//!
//! 几处如果各写一遍（尤其是授权集合 + 凭据派生），重连补发就会和上次 apply
//! 不一致，用户会看到「订阅里有 uuid、服务器配置里没有」。所以收敛到这里。

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use pierwave_domain::certificate;
use pierwave_domain::models::Server;
use pierwave_domain::{credentials, release, repo, time, xray};
use pierwave_proto::{AgentUpgradePlan, DesiredForward, DesiredNode, ForwardEngine, ManagedFile};

use crate::error::AppResult;
use crate::state::AppState;

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

    // 证书按 id 去重：同一张证书被多个节点引用时只写一份文件。
    let cert_ids: Vec<String> = {
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
    let certificates = repo::certificates::find_by_ids(&state.db.pool, &cert_ids).await?;

    let by_id: BTreeMap<&str, &pierwave_domain::models::Certificate> = certificates
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

    let mut files = Vec::with_capacity(certificates.len() * 2);
    for cert in &certificates {
        files.push(ManagedFile {
            path: certificate::cert_file_path(&cert.id),
            content: cert.cert_pem.clone(),
            mode: certificate::CERT_FILE_MODE,
        });
        files.push(ManagedFile {
            path: certificate::key_file_path(&cert.id),
            content: cert.key_pem.clone(),
            mode: certificate::KEY_FILE_MODE,
        });
    }

    let plan = xray::ServerPlan {
        server_name: &server.name,
        nodes: &nodes,
        grants: &grants,
        certs: &node_certs,
        outbounds: &outbounds,
        rules: &rules,
    };
    let (xray, warnings) = xray::build_config_checked_with_certs(&plan);

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
    let mut desired_forwards: Vec<DesiredForward> = forwards
        .iter()
        .map(|forward| DesiredForward {
            // 独立转发用 `fwd-<uuid>`；链推导用 `chain-<id>-<seq>`，两套前缀不会撞。
            id: pierwave_domain::forwards::desired_id(&forward.id),
            listen_port: forward.listen_port,
            target_host: forward.target_host.clone(),
            target_port: forward.target_port,
            targets: Vec::new(),
            strategy: Default::default(),
            // 库里的字符串已由写路径校验；读路径用 from_name 兜底旧数据。
            engine: ForwardEngine::from_name(&forward.engine),
        })
        .collect();

    // 链推导：只保留落在本服务器上的跳。一条链可能经过多台服务器，
    // 每台服务器只收到「自己这一跳」的 DesiredForward。
    for chain in &chains {
        for (server_id, forward) in super::chains::derive_forwards(&chain.chain, &chain.groups) {
            if server_id == server.id {
                desired_forwards.push(forward);
            }
        }
    }

    Ok(DesiredConfig {
        xray,
        node_count: nodes.len() - warnings.len(),
        grant_count: grants.len(),
        granted_user_ids,
        warnings,
        files,
        nodes: desired_nodes,
        forwards: desired_forwards,
        agent_upgrade: upgrade_plan(state, server, base_url),
    })
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
    use serde_json::json;

    use pierwave_domain::Db;

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
                engine: "native".into(),
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
                groups: vec![
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
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
                engine: "realm".into(),
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
                engine: "native".into(),
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
                engine: "native".into(),
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
                engine: "native".into(),
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
                    }]
                );
            }
            other => panic!("expected desired state, got {other:?}"),
        }
    }
}
