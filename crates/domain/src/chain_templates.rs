//! 链模板：管理员预先定义一条链的形态（跳 / 引擎 / 加密方式），用户只选模板 + 填目标。
//!
//! 这里只放**不查库**的规则：
//! * 名称长度；
//! * `groups_json` 的解析与规范化（seq 连续、成员不重复）；
//! * 引擎/安全模式/加密模式/协议的组合校验——复用 [`crate::chains`] 已有的
//!   组数、成员数、选路策略与隧道/nftables 规则，不新造第二套口径。
//!
//! 模板只定义形态，不携带证书：`transport = tls` 无法展开成合法链
//! （realm 的跳间 TLS 要求每跳都有证书），因此在模板层直接拒绝而不是留到
//! 用户建链时才失败。
//!
//! 端口分配与服务器能力门禁在 master 侧：模板只存 `server_ids`，每次建链
//! 都重新读服务器（端口策略、Agent 版本可能已经变化）。

use serde_json::json;

use crate::chains::{self, GroupStrategy};
use crate::error::DomainError;
use crate::models::ChainTemplateGroup;
use crate::{engine, hop_transport, protocol, tunnel_security};

/// 模板名称最大字符数，与链名称保持一致。
pub const NAME_MAX_CHARS: usize = crate::chains::NAME_MAX_CHARS;

/// 模板名称：去首尾空白后不能为空，且不超过 64 个字符。
pub fn normalize_name(raw: &str) -> Result<String, DomainError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(DomainError::new(
            "chain_template.name_required",
            "链模板名称不能为空",
        ));
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(DomainError::with_params(
            "chain_template.name_too_long",
            json!({ "max": NAME_MAX_CHARS }),
            format!("链模板名称最多 {NAME_MAX_CHARS} 个字符"),
        ));
    }
    Ok(name.to_string())
}

/// 解析数据库里的 `groups_json`。
///
/// 写路径已经校验过；这里兜底的是手工改库 / 旧数据。损坏时返回带 code 的
/// [`DomainError`]（400），而不是把整页变成 500。
pub fn parse_groups(raw: &str) -> Result<Vec<ChainTemplateGroup>, DomainError> {
    let groups: Vec<ChainTemplateGroup> = serde_json::from_str(raw).map_err(|error| {
        DomainError::with_params(
            "chain_template.groups_invalid",
            json!({ "reason": error.to_string() }),
            "链模板的组配置不是合法 JSON / the template groups are not valid JSON",
        )
    })?;
    normalize_groups(groups)
}

/// 把一组组输入规范化为「seq 连续、策略合法、成员非空且不重复」。
///
/// 顺序以输入里的 `seq` 为准（稳定排序），输出重新编号为 `0..n-1`；
/// 这样 API 客户端可以只给数组、也可以显式带 `seq`，落库形态始终一致。
pub fn normalize_groups(
    mut groups: Vec<ChainTemplateGroup>,
) -> Result<Vec<ChainTemplateGroup>, DomainError> {
    // 稳定排序：相同 seq 保持输入顺序，便于定位错误。
    groups.sort_by_key(|group| group.seq);

    let mut normalized = Vec::with_capacity(groups.len());
    for (seq, group) in groups.iter().enumerate() {
        let strategy = if group.strategy.trim().is_empty() {
            GroupStrategy::default()
        } else {
            GroupStrategy::parse(&group.strategy)?
        };

        let mut server_ids = Vec::with_capacity(group.server_ids.len());
        for raw in &group.server_ids {
            let server_id = raw.trim();
            if server_id.is_empty() {
                return Err(DomainError::with_params(
                    "chain_template.server_required",
                    json!({ "seq": seq }),
                    format!("第 {} 组的服务器 id 不能为空", seq + 1),
                ));
            }
            server_ids.push(server_id.to_string());
        }

        normalized.push(ChainTemplateGroup {
            seq: seq as i64,
            strategy: strategy.as_str().to_string(),
            server_ids,
        });
    }

    chains::validate_group_count(normalized.len())?;
    for group in &normalized {
        chains::validate_group_member_count(group.server_ids.len(), group.seq)?;
        chains::ensure_group_member_servers_unique(&group.server_ids, group.seq)?;
    }
    let all: Vec<Vec<String>> = normalized
        .iter()
        .map(|group| group.server_ids.clone())
        .collect();
    chains::ensure_chain_servers_unique(&all)?;

    Ok(normalized)
}

/// 校验通过后的规范化链级配置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateConfig {
    pub engine: String,
    /// 隧道安全模式（`tls` / `noise`）。
    pub security: String,
    /// realm 跳间加密（模板只允许 `none`）。
    pub transport: String,
    pub protocol: String,
}

/// 校验「引擎 / 安全模式 / 加密模式 / 协议」组合，并返回规范化后的值。
///
/// 复用链既有的校验函数与错误码：
/// * `engine::normalize`、`protocol::normalize_chain`、`hop_transport::normalize`、
///   `tunnel_security::normalize`；
/// * 隧道：2–6 跳、每组 1 台、UDP 只支持 2 跳（`chain.tunnel_*`）；
/// * nftables：中间组不能多成员（`chain.nftables_multi_target`）；
/// * realm 固定双开（`forward.protocol_udp_requires_native`）。
///
/// `groups` 必须已经过 [`normalize_groups`]（这里再查一次组数，防止调用方
/// 传空数组绕过）。
pub fn validate_config(
    engine: &str,
    security: &str,
    transport: &str,
    protocol: &str,
    groups: &[ChainTemplateGroup],
) -> Result<TemplateConfig, DomainError> {
    let engine = engine::normalize(engine)?;
    let security = tunnel_security::normalize(security)?;
    let transport = hop_transport::normalize(transport)?;
    let protocol = protocol::normalize_chain(protocol)?;

    // 模板不携带证书：realm 的跳间 TLS 每跳都要证书，必然展开失败。
    // 与其让用户建链时才报 `chain.tls_group_cert_required`，不如在模板层拒绝。
    if hop_transport::is_tls(&transport) {
        return Err(DomainError::new(
            "chain_template.transport_unsupported",
            "链模板不支持跳间加密（模板不携带证书）；请使用明文模板，或在链页面手动建带证书的链 / chain templates cannot enable hop TLS (templates carry no certificates); use a plaintext template or create the TLS chain manually",
        ));
    }

    // `security` 只对 tunnel 有意义；native/realm/nftables 带 noise 是配置错误，
    // 不能悄悄存下来让读路径忽略它。
    if tunnel_security::is_noise(&security) && !engine::is_tunnel(&engine) {
        return Err(DomainError::with_params(
            "chain_template.security_requires_tunnel",
            json!({ "engine": &engine, "security": &security }),
            "只有 tunnel 引擎的链模板才能使用 noise 安全模式 / only tunnel templates may use the noise security mode",
        ));
    }

    chains::validate_group_count(groups.len())?;
    for group in groups {
        chains::validate_group_member_count(group.server_ids.len(), group.seq)?;
    }

    if engine::is_tunnel(&engine) {
        if groups.len() < chains::TUNNEL_MIN_HOPS {
            return Err(DomainError::with_params(
                "chain.tunnel_requires_two_hops",
                json!({ "hops": groups.len() }),
                "tunnel 引擎至少需要 2 跳（入口 Dialer + 出口 Listener）/ the tunnel engine needs at least 2 hops (entry dialer + exit listener)",
            ));
        }
        if groups.len() > chains::TUNNEL_MAX_HOPS {
            return Err(DomainError::with_params(
                "chain.tunnel_hop_limit",
                json!({ "hops": groups.len(), "max": chains::TUNNEL_MAX_HOPS }),
                format!(
                    "tunnel 引擎最多支持 {} 跳 / the tunnel engine supports at most {} hops",
                    chains::TUNNEL_MAX_HOPS,
                    chains::TUNNEL_MAX_HOPS
                ),
            ));
        }
        if let Some((seq, group)) = groups
            .iter()
            .enumerate()
            .find(|(_, group)| group.server_ids.len() != 1)
        {
            return Err(DomainError::with_params(
                "chain.tunnel_single_member",
                json!({ "seq": seq, "members": group.server_ids.len() }),
                format!(
                    "tunnel 引擎当前只支持每组 1 台成员（第 {} 组有 {} 台）/ the tunnel engine supports exactly one member per group (group {} has {})",
                    seq + 1,
                    group.server_ids.len(),
                    seq + 1,
                    group.server_ids.len()
                ),
            ));
        }
        if protocol::allows_udp(&protocol) && groups.len() > chains::TUNNEL_MIN_HOPS {
            return Err(DomainError::with_params(
                "chain.tunnel_udp_requires_two_hops",
                json!({ "protocol": &protocol, "hops": groups.len() }),
                "tunnel 的 UDP 中继当前只支持 2 跳链 / the tunnel UDP relay currently supports exactly 2 hops",
            ));
        }
    } else if engine::is_nftables(&engine) {
        if let Some((seq, group)) = groups
            .iter()
            .enumerate()
            .find(|(seq, group)| *seq >= 1 && group.server_ids.len() > 1)
        {
            return Err(DomainError::with_params(
                "chain.nftables_multi_target",
                json!({ "seq": seq + 1, "count": group.server_ids.len() }),
                format!(
                    "nftables 引擎暂不支持第 {} 组的多成员选路，请改成单成员组 / the nftables engine does not support multi-member groups (group {})",
                    seq + 1,
                    seq + 1
                ),
            ));
        }
    }

    protocol::ensure_realm_supported(&protocol, &engine)?;

    Ok(TemplateConfig {
        engine,
        security,
        transport,
        protocol,
    })
}

/// 一条链模板对某个用户是否可见/可用：生效中套餐里的 `chain_limit` 最大值
/// 与模板白名单并集。
///
/// 语义与 [`crate::forwards::ForwardAllowance`] 完全一致：多套餐不累加；
/// `chain_limit = 0` 的套餐不会顺带放行模板；无套餐 = 0。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChainTemplateAllowance {
    pub limit: i64,
    /// 升序去重。
    pub template_ids: Vec<String>,
}

impl ChainTemplateAllowance {
    /// `grants` 只应包含**生效中**的套餐：`(chain_limit, 模板白名单)`。
    pub fn from_grants(grants: &[(i64, Vec<String>)]) -> Self {
        let limit = grants.iter().map(|(limit, _)| *limit).max().unwrap_or(0);
        let mut template_ids = std::collections::BTreeSet::new();
        for (grant_limit, templates) in grants {
            if *grant_limit <= 0 {
                continue;
            }
            template_ids.extend(templates.iter().filter(|id| !id.is_empty()).cloned());
        }
        Self {
            limit,
            template_ids: template_ids.into_iter().collect(),
        }
    }

    /// 该模板是否在当前套餐的白名单里。
    pub fn allows_template(&self, template_id: &str) -> bool {
        self.template_ids.iter().any(|id| id == template_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(seq: i64, strategy: &str, server_ids: &[&str]) -> ChainTemplateGroup {
        ChainTemplateGroup {
            seq,
            strategy: strategy.into(),
            server_ids: server_ids.iter().map(|id| (*id).to_string()).collect(),
        }
    }

    #[test]
    fn names_are_required_and_bounded() {
        assert_eq!(normalize_name(" 港-日 ").unwrap(), "港-日");
        assert_eq!(
            normalize_name(&"a".repeat(NAME_MAX_CHARS)).unwrap(),
            "a".repeat(NAME_MAX_CHARS)
        );
        assert_eq!(
            normalize_name("  ").unwrap_err().code,
            "chain_template.name_required"
        );
        assert_eq!(
            normalize_name(&"a".repeat(NAME_MAX_CHARS + 1))
                .unwrap_err()
                .code,
            "chain_template.name_too_long"
        );
    }

    #[test]
    fn groups_are_sorted_and_renumbered() {
        let groups = normalize_groups(vec![
            group(2, "failover", &["c"]),
            group(0, "", &["a"]),
            group(1, "ip_hashed", &["b"]),
        ])
        .unwrap();
        assert_eq!(
            groups,
            vec![
                group(0, "round_robin", &["a"]),
                group(1, "ip_hashed", &["b"]),
                group(2, "failover", &["c"]),
            ]
        );
    }

    #[test]
    fn groups_reject_empty_duplicate_and_out_of_range_shapes() {
        assert_eq!(
            normalize_groups(vec![group(0, "", &[" "])])
                .unwrap_err()
                .code,
            "chain_template.server_required"
        );
        assert_eq!(
            normalize_groups(vec![group(0, "", &["a", "a"])])
                .unwrap_err()
                .code,
            "chain.duplicate_group_member"
        );
        assert_eq!(
            normalize_groups(vec![group(0, "", &["a"]), group(1, "", &["a"])])
                .unwrap_err()
                .code,
            "chain.duplicate_server"
        );
        assert_eq!(
            normalize_groups(Vec::new()).unwrap_err().code,
            "chain.hop_count_invalid"
        );
        assert_eq!(
            normalize_groups(vec![group(0, "random", &["a"])])
                .unwrap_err()
                .code,
            "chain.strategy_invalid"
        );
        assert_eq!(
            normalize_groups((0..4).map(|seq| group(seq, "", &["a"])).collect())
                .unwrap_err()
                .code,
            "chain.duplicate_server",
            "同一台服务器跨组重复必须被拒绝"
        );
    }

    #[test]
    fn config_accepts_native_and_realm_plaintext_templates() {
        let groups = normalize_groups(vec![group(0, "", &["a"]), group(1, "", &["b"])]).unwrap();
        let config = validate_config("native", "tls", "none", "tcp", &groups).unwrap();
        assert_eq!(config.engine, "native");
        assert_eq!(config.security, "tls", "非 tunnel 忽略安全模式默认值");
        assert_eq!(config.transport, "none");
        assert_eq!(config.protocol, "tcp");

        let config = validate_config("realm", "tls", "none", "both", &groups).unwrap();
        assert_eq!(config.engine, "realm");
        assert_eq!(config.protocol, "both");
    }

    #[test]
    fn config_rejects_invalid_engine_security_and_protocol() {
        let groups = normalize_groups(vec![group(0, "", &["a"])]).unwrap();
        assert_eq!(
            validate_config("wireguard", "tls", "none", "tcp", &groups)
                .unwrap_err()
                .code,
            "forward.engine_invalid"
        );
        assert_eq!(
            validate_config("native", "wireguard", "none", "tcp", &groups)
                .unwrap_err()
                .code,
            "chain.tunnel_security_invalid"
        );
        assert_eq!(
            validate_config("native", "tls", "none", "sctp", &groups)
                .unwrap_err()
                .code,
            "chain.protocol_invalid"
        );
        assert_eq!(
            validate_config("native", "tls", "wss", "tcp", &groups)
                .unwrap_err()
                .code,
            "chain.transport_invalid"
        );
        assert_eq!(
            validate_config("native", "noise", "none", "tcp", &groups)
                .unwrap_err()
                .code,
            "chain_template.security_requires_tunnel"
        );
        assert_eq!(
            validate_config("native", "tls", "tls", "tcp", &groups)
                .unwrap_err()
                .code,
            "chain_template.transport_unsupported"
        );
        assert_eq!(
            validate_config("realm", "tls", "none", "udp", &groups)
                .unwrap_err()
                .code,
            "forward.protocol_udp_requires_native"
        );
    }

    #[test]
    fn tunnel_templates_follow_the_chain_tunnel_rules() {
        let one = normalize_groups(vec![group(0, "", &["a"])]).unwrap();
        assert_eq!(
            validate_config("tunnel", "noise", "none", "tcp", &one)
                .unwrap_err()
                .code,
            "chain.tunnel_requires_two_hops"
        );

        let two = normalize_groups(vec![group(0, "", &["a"]), group(1, "", &["b"])]).unwrap();
        let config = validate_config("tunnel", "noise", "none", "tcp", &two).unwrap();
        assert_eq!(config.engine, "tunnel");
        assert_eq!(config.security, "noise");

        // 多成员组不允许。
        let multi =
            normalize_groups(vec![group(0, "", &["a", "b"]), group(1, "", &["c"])]).unwrap();
        assert_eq!(
            validate_config("tunnel", "tls", "none", "tcp", &multi)
                .unwrap_err()
                .code,
            "chain.tunnel_single_member"
        );

        // 3 跳 + UDP 不允许。
        let three = normalize_groups(vec![
            group(0, "", &["a"]),
            group(1, "", &["b"]),
            group(2, "", &["c"]),
        ])
        .unwrap();
        assert_eq!(
            validate_config("tunnel", "tls", "none", "both", &three)
                .unwrap_err()
                .code,
            "chain.tunnel_udp_requires_two_hops"
        );
    }

    #[test]
    fn nftables_templates_reject_multi_member_middle_groups() {
        let groups =
            normalize_groups(vec![group(0, "", &["a"]), group(1, "", &["b", "c"])]).unwrap();
        assert_eq!(
            validate_config("nftables", "tls", "none", "tcp", &groups)
                .unwrap_err()
                .code,
            "chain.nftables_multi_target"
        );

        let entry_multi =
            normalize_groups(vec![group(0, "", &["a", "b"]), group(1, "", &["c"])]).unwrap();
        assert!(
            validate_config("nftables", "tls", "none", "tcp", &entry_multi).is_ok(),
            "入口组多成员只是候选，不是多目标"
        );
    }

    #[test]
    fn groups_json_roundtrips_and_reports_corruption() {
        let groups =
            normalize_groups(vec![group(0, "", &["a"]), group(1, "failover", &["b"])]).unwrap();
        let raw = serde_json::to_string(&groups).unwrap();
        assert_eq!(parse_groups(&raw).unwrap(), groups);
        assert_eq!(
            parse_groups("not-json").unwrap_err().code,
            "chain_template.groups_invalid"
        );
        assert_eq!(
            parse_groups("[]").unwrap_err().code,
            "chain.hop_count_invalid"
        );
    }

    #[test]
    fn allowance_takes_the_maximum_limit_and_unions_templates() {
        let allowance = ChainTemplateAllowance::from_grants(&[
            (1, vec!["t1".into()]),
            (3, vec!["t2".into(), "t1".into()]),
            (0, vec!["never".into()]),
        ]);
        assert_eq!(allowance.limit, 3);
        assert_eq!(allowance.template_ids, vec!["t1", "t2"]);
        assert!(allowance.allows_template("t1"));
        assert!(allowance.allows_template("t2"));
        assert!(!allowance.allows_template("never"));
        assert!(!allowance.allows_template("missing"));

        assert_eq!(
            ChainTemplateAllowance::from_grants(&[]),
            ChainTemplateAllowance::default()
        );
        assert_eq!(
            ChainTemplateAllowance::from_grants(&[(0, vec!["t1".into()])]),
            ChainTemplateAllowance {
                limit: 0,
                template_ids: Vec::new()
            }
        );
    }

    #[test]
    fn template_group_constants_match_chain_bounds() {
        assert_eq!(chains::MIN_GROUP_MEMBERS, 1);
    }
}
