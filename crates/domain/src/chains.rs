//! 线性多跳链的纯校验逻辑。
//!
//! 链的推导（哪一跳转到哪台服务器的 address:port）在 master 侧完成，
//! 因为它产出的是跨端 DTO `DesiredForward`；本模块只放「不查库」的规则：
//! 跳数、重复服务器、名称，以及「连续失败几次算降级」。
//!
//! 目标地址/端口、监听端口范围、保留端口、自连回环都复用
//! [`crate::forwards`] 里的现有函数，避免两套口径。

use std::collections::HashSet;

use serde_json::json;

use crate::error::DomainError;

/// 一条链最少 1 跳（入口直接指向 target）。
pub const MIN_HOPS: usize = 1;

/// 一条链最多 4 跳；再长对线性转发没有额外价值，只会放大故障面。
pub const MAX_HOPS: usize = 4;

/// 链名称最大字符数，与单跳转发保持一致。
pub const NAME_MAX_CHARS: usize = crate::forwards::NAME_MAX_CHARS;

/// 连续多少次 `target_ok=false` 判定为降级。
pub const DEGRADED_AFTER_FAILURES: i64 = 2;

/// 链推导出的 `DesiredForward.id` 前缀；与独立转发的 `fwd-` 前缀区分开。
pub const FORWARD_ID_PREFIX: &str = "chain-";

/// 链推导出的转发 id：`chain-<chain_id>-<seq>`，稳定且不会与 `fwd-<uuid>` 冲突。
pub fn forward_id(chain_id: &str, seq: i64) -> String {
    format!("{FORWARD_ID_PREFIX}{chain_id}-{seq}")
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
        assert_eq!(forward_id("c1", 0), "chain-c1-0");
        assert_eq!(forward_id("c1", 3), "chain-c1-3");
        assert!(forward_id("c1", 0).starts_with(FORWARD_ID_PREFIX));
    }
}
