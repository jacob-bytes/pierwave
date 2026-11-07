//! 期望态装配：apply、断流 apply 与 Agent 重连补发必须生成**同一份**配置。
//!
//! 几处如果各写一遍（尤其是授权集合 + 凭据派生），重连补发就会和上次 apply
//! 不一致，用户会看到「订阅里有 uuid、服务器配置里没有」。所以收敛到这里。

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use pierwave_domain::certificate;
use pierwave_domain::models::Server;
use pierwave_domain::{credentials, repo, time, xray};
use pierwave_proto::ManagedFile;

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
pub async fn render(state: &AppState, server: &Server) -> AppResult<DesiredConfig> {
    let nodes = repo::nodes::list_enabled_by_server(&state.db.pool, &server.id).await?;
    let outbounds = repo::outbounds::list_enabled_by_server(&state.db.pool, &server.id).await?;
    let rules = repo::routing_rules::list_enabled_by_server(&state.db.pool, &server.id).await?;
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
        .map(|pair| xray::Grant::new(&secret, &pair.user_id, &pair.node_id))
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

    Ok(DesiredConfig {
        xray,
        node_count: nodes.len() - warnings.len(),
        grant_count: grants.len(),
        granted_user_ids,
        warnings,
        files,
    })
}

/// 手动 apply 入口：渲染后立即推送（版本号每次 +1，保持既有语义）。
pub async fn apply(state: &AppState, server: &Server) -> AppResult<ApplyOutcome> {
    let desired = render(state, server).await?;
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
            agent_upgrade: None, // 后端 lane 接入后改为 desired.agent_upgrade
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
}
