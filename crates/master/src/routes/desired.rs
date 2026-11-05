//! 期望态装配：apply 与 Agent 重连补发必须生成**同一份**配置。
//!
//! 两处如果各写一遍（尤其是授权集合 + 凭据派生），重连补发就会和上次 apply
//! 不一致，用户会看到「订阅里有 uuid、服务器配置里没有」。所以收敛到这里。

use serde_json::Value;

use mmrust_domain::models::Server;
use mmrust_domain::{credentials, repo, xray};

use crate::error::AppResult;
use crate::state::AppState;

pub struct DesiredConfig {
    pub xray: Value,
    pub node_count: usize,
    pub grant_count: usize,
    /// 生成配置时被跳过的节点，每个节点一条中文说明。
    pub warnings: Vec<String>,
}

/// 按「服务器 enabled 节点 × 有资格用户」装配完整 Xray 配置。
///
/// 凭据在这里一次性派生（`Grant::new`），`xray::build_config` 保持纯函数。
pub async fn render(state: &AppState, server: &Server) -> AppResult<DesiredConfig> {
    let nodes = repo::nodes::list_enabled_by_server(&state.db.pool, &server.id).await?;
    let secret = credentials::master_secret(&state.db.pool).await?;
    let grants: Vec<xray::Grant> = repo::authorization::eligible_pairs(&state.db.pool, &server.id)
        .await?
        .iter()
        .map(|pair| xray::Grant::new(&secret, &pair.user_id, &pair.node_id))
        .collect();

    let (xray, warnings) = xray::build_config_checked(&server.name, &nodes, &grants);

    Ok(DesiredConfig {
        xray,
        node_count: nodes.len() - warnings.len(),
        grant_count: grants.len(),
        warnings,
    })
}
