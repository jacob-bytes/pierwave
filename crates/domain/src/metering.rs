//! 计费口径：方向 → 字节数 → 节点倍率 → 整数，以及多实例的瀑布分配。
//!
//! 「计费增量」只在这里定义一次，master 落库与单测共用；这样「单向 ×1 / 双向 ×2」
//! 那类把「算哪几个方向」和「乘几倍」混在一起的写法不会重新长出来。

/// 计费方向：上行、下行或两者。
const DIRECTION_UPLOAD: &str = "upload";
const DIRECTION_DOWNLOAD: &str = "download";
const DIRECTION_BOTH: &str = "both";

/// 按方向取出参与计费的原始字节数。
///
/// 未知/空方向按 `both` 处理：套餐校验理论上已经挡住非法值，这里兜底保证
/// 计费函数对任何输入都是全函数，不会因为脏数据 panic 或漏计。
pub fn direction_bytes(uplink: u64, downlink: u64, direction: &str) -> u64 {
    match direction.trim().to_ascii_lowercase().as_str() {
        DIRECTION_UPLOAD => uplink,
        DIRECTION_DOWNLOAD => downlink,
        _ => uplink.saturating_add(downlink),
    }
}

/// 计费增量 = 方向字节数 × 节点倍率，四舍五入到整数。
///
/// 倍率来自绑卡时冻结的 `user_packages.node_ratio`（不是套餐模板现值）。
/// 非法倍率（NaN / 负数 / 无穷）按 0 处理；正常校验下不会出现。
pub fn weighted_bytes(uplink: u64, downlink: u64, direction: &str, node_ratio: f64) -> u64 {
    if !node_ratio.is_finite() || node_ratio < 0.0 {
        return 0;
    }
    let raw = direction_bytes(uplink, downlink, direction) as f64;
    // Rust 的 f64 -> u64 转换是饱和的；极大倍率不会回绕成小数。
    (raw * node_ratio).round() as u64
}

/// 参与瀑布分配的一张套餐实例。
#[derive(Debug, Clone, PartialEq)]
pub struct BillableInstance {
    pub id: String,
    pub used_bytes: i64,
    /// 生效额度：`quota_override` 优先，其次套餐模板额度；`None` / `0` 表示不限。
    pub quota_bytes: Option<i64>,
    pub direction: String,
    pub node_ratio: f64,
}

impl BillableInstance {
    /// 还能再扣多少字节；`None` 表示不限（永远填不满）。
    pub fn remaining(&self) -> Option<u64> {
        match self.quota_bytes {
            Some(quota) if quota > 0 => Some(quota.saturating_sub(self.used_bytes).max(0) as u64),
            _ => None,
        }
    }

    /// 这张实例是否还能继续扣费（不限额度也算）。
    pub fn is_fillable(&self) -> bool {
        self.remaining() != Some(0)
    }
}

/// 本轮计费用的 (方向, 节点倍率)：取第一张还能继续扣费的实例。
///
/// 第一张卡用尽后，后续流量自然改用下一张卡的快照倍率；全部用尽时退回
/// 1 倍双向（仍会累加用户总用量，只是不再往实例上写）。
pub fn billing_terms(instances: &[BillableInstance]) -> (&str, f64) {
    instances
        .iter()
        .find(|instance| instance.is_fillable())
        .map(|instance| (instance.direction.trim(), instance.node_ratio))
        .unwrap_or((DIRECTION_BOTH, 1.0))
}

/// 瀑布分配：按给定顺序（调用方按 `created_at` 排好）依次填满实例。
///
/// 返回 `(instance_id, 本次增量)`，只包含真正分到钱的实例。额度为 `None`
/// 或 `0`（显式不限）的实例会一口气吃掉剩余全部。所有实例都用尽时返回的
/// 总额小于 `amount`——溢出的部分不再落到任何实例上。
pub fn waterfall(amount: u64, instances: &[BillableInstance]) -> Vec<(String, u64)> {
    let mut remaining = amount;
    let mut allocations = Vec::new();
    for instance in instances {
        if remaining == 0 {
            break;
        }
        let take = match instance.remaining() {
            Some(capacity) => remaining.min(capacity),
            None => remaining,
        };
        if take == 0 {
            continue;
        }
        remaining -= take;
        allocations.push((instance.id.clone(), take));
    }
    allocations
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance(id: &str, used: i64, quota: Option<i64>) -> BillableInstance {
        BillableInstance {
            id: id.into(),
            used_bytes: used,
            quota_bytes: quota,
            direction: "both".into(),
            node_ratio: 1.0,
        }
    }

    #[test]
    fn direction_selects_the_right_bytes() {
        assert_eq!(direction_bytes(1000, 500, "both"), 1500);
        assert_eq!(direction_bytes(1000, 500, "upload"), 1000);
        assert_eq!(direction_bytes(1000, 500, "download"), 500);
        assert_eq!(direction_bytes(1000, 500, " UPLOAD "), 1000);
        // 脏数据按 both 兜底，不 panic。
        assert_eq!(direction_bytes(1000, 500, "sideways"), 1500);
    }

    #[test]
    fn weighting_multiplies_then_rounds() {
        // 1000 + 500 = 1500，× 2.0 = 3000
        assert_eq!(weighted_bytes(1000, 500, "both", 2.0), 3000);
        // 只有上行参与：1000 × 2.0
        assert_eq!(weighted_bytes(1000, 500, "upload", 2.0), 2000);
        // 只有下行参与：500 × 2.0
        assert_eq!(weighted_bytes(1000, 500, "download", 2.0), 1000);
        // 1.5 倍四舍五入：4.5 → 5，1.5 → 2，2.5 → 3
        assert_eq!(weighted_bytes(3, 0, "upload", 1.5), 5);
        assert_eq!(weighted_bytes(1, 0, "both", 1.5), 2);
        assert_eq!(weighted_bytes(5, 0, "upload", 0.5), 3);
        assert_eq!(weighted_bytes(1000, 500, "both", 1.0), 1500);
    }

    #[test]
    fn invalid_ratio_never_panics() {
        assert_eq!(weighted_bytes(1000, 500, "both", f64::NAN), 0);
        assert_eq!(weighted_bytes(1000, 500, "both", f64::INFINITY), 0);
        assert_eq!(weighted_bytes(1000, 500, "both", -1.0), 0);
        assert_eq!(weighted_bytes(0, 0, "both", 2.0), 0);
    }

    #[test]
    fn waterfall_fills_instances_in_order() {
        let first = instance("a", 0, Some(1000));
        let second = instance("b", 0, Some(5000));

        assert_eq!(
            waterfall(3000, &[first.clone(), second.clone()]),
            vec![("a".to_string(), 1000), ("b".to_string(), 2000)]
        );
        // 第一张已用 400 / 1000，只剩 600 容量。
        let partly_used = instance("a", 400, Some(1000));
        assert_eq!(
            waterfall(1000, &[partly_used, second.clone()]),
            vec![("a".to_string(), 600), ("b".to_string(), 400)]
        );
        // 不限额度（None 或 0）的第一张吃掉全部。
        assert_eq!(
            waterfall(3000, &[instance("a", 0, None), second.clone()]),
            vec![("a".to_string(), 3000)]
        );
        assert_eq!(
            waterfall(3000, &[instance("a", 99999, Some(0)), second]),
            vec![("a".to_string(), 3000)]
        );
    }

    #[test]
    fn waterfall_skips_exhausted_and_leaves_overflow_unallocated() {
        let exhausted = instance("a", 1000, Some(1000));
        let second = instance("b", 0, Some(500));

        // a 已满 → 直接填 b；b 只有 500 容量，剩下 500 不再分配。
        assert_eq!(
            waterfall(1000, &[exhausted, second.clone()]),
            vec![("b".to_string(), 500)]
        );
        assert!(waterfall(0, &[second]).is_empty());
        assert!(waterfall(
            100,
            &[instance("a", 10, Some(10)), instance("b", 5, Some(5))]
        )
        .is_empty());
    }

    #[test]
    fn billing_terms_use_first_fillable_instance() {
        let exhausted = BillableInstance {
            direction: "upload".into(),
            node_ratio: 9.0,
            ..instance("a", 1000, Some(1000))
        };
        let active = BillableInstance {
            direction: "download".into(),
            node_ratio: 2.5,
            ..instance("b", 0, Some(1000))
        };
        let unlimited = instance("c", 0, None);

        let mixed = [exhausted.clone(), active.clone()];
        let (direction, ratio) = billing_terms(&mixed);
        assert_eq!(direction, "download");
        assert_eq!(ratio, 2.5);

        let only_unlimited = [unlimited];
        let (direction, ratio) = billing_terms(&only_unlimited);
        assert_eq!(direction, "both");
        assert_eq!(ratio, 1.0);

        // 全部用尽 → 退回 1 倍双向。
        let exhausted_only = [exhausted];
        let (direction, ratio) = billing_terms(&exhausted_only);
        assert_eq!(direction, "both");
        assert_eq!(ratio, 1.0);
        let (direction, ratio) = billing_terms(&[]);
        assert_eq!(direction, "both");
        assert_eq!(ratio, 1.0);
    }
}
