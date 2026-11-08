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

/// 一条链最少 1 跳（入口直接指向 target）。
pub const MIN_HOPS: usize = 1;

/// 一条链最多 4 跳；再长对线性转发没有额外价值，只会放大故障面。
/// 一条链最多 4 跳。
///
/// 这是**产品规格**，不是技术硬限制：每多一跳就多一次 TCP 中转，
/// 端到端延迟、故障点和排查成本都随之线性增长；而 4 跳已能覆盖
/// 「国内入口 → 中转 → 中转/落地 → 目标」的常见线路组合。
/// 若要放开，需要同时评估：拓扑 UI 的横向容量、逐跳延迟的归因难度、
/// 以及链路上任何一台故障都会整链中断的可用性代价。
pub const MAX_HOPS: usize = 4;

/// 一个组最少 1 台成员。
pub const MIN_GROUP_MEMBERS: usize = 1;

/// 一个组最多 8 台成员；再多的候选池对单条链没有收益，只会放大端口冲突面。
pub const MAX_GROUP_MEMBERS: usize = 8;

/// 链名称最大字符数，与单跳转发保持一致。
pub const NAME_MAX_CHARS: usize = crate::forwards::NAME_MAX_CHARS;

/// 组名最大字符数，与链名保持一致。
pub const GROUP_NAME_MAX_CHARS: usize = NAME_MAX_CHARS;

/// 连续多少次 `target_ok=false` 判定为降级。
pub const DEGRADED_AFTER_FAILURES: i64 = 2;

/// 链推导出的 `DesiredForward.id` 前缀；与独立转发的 `fwd-` 前缀区分开。
pub const FORWARD_ID_PREFIX: &str = "chain-";

/// 组内选路策略的四个合法值（与 `PROTOCOL_VERSION = 8` 的线协议一致）。
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

/// 连续失败次数是否已经达到降级阈值。
///
/// 只读计数，不在这里记录历史；计数由 `repo::forwards::save_status` 维护。
pub fn is_degraded(target_fail_count: i64) -> bool {
    target_fail_count >= DEGRADED_AFTER_FAILURES
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    #[test]
    fn hop_count_is_limited_to_one_through_four() {
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
            assert!(error.message.contains("1-4"), "{}", error.message);
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
}
