//! 转发「组」内选路：给定一组候选目标的健康快照，按策略挑一个下标。
//!
//! 纯逻辑模块：不碰网络、不持有任何 IO，方便穷举边界（空目标、全部不健康、
//! 延迟并列等）。真正的连接由 `forward` 模块按这里返回的下标建立。
//!
//! 健康快照的顺序与规则里 `targets` 的顺序一致：`Failover` 依赖这个顺序
//! 表达主备优先级（主控已经排好序），`IpHashed` 也在**健康目标的有序子集**
//! 上取模，保证同一客户端 IP 始终落到同一个目标。

use std::net::IpAddr;

use pierwave_proto::ForwardStrategy;

/// 一个候选目标的健康快照。
///
/// `healthy` 由 TCP 探测或连接失败决定；`latency_ms` 是最近一次探测的握手
/// RTT，`None` 表示还没测到有效值（不等于「健康」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TargetHealth {
    pub healthy: bool,
    pub latency_ms: Option<u32>,
}

impl TargetHealth {
    /// 可达但没有延迟数据（例如还没测过）。
    pub const fn up() -> Self {
        Self {
            healthy: true,
            latency_ms: None,
        }
    }

    /// 可达且有延迟数据（测试构造用）。
    #[cfg(test)]
    pub const fn with_latency(latency_ms: u32) -> Self {
        Self {
            healthy: true,
            latency_ms: Some(latency_ms),
        }
    }

    /// 不可达（测试构造用）。
    #[cfg(test)]
    pub const fn down() -> Self {
        Self {
            healthy: false,
            latency_ms: None,
        }
    }
}

/// 每条转发规则各持有一个：只有轮询需要跨连接保留游标。
///
/// `Failover` / `LowestLatency` / `IpHashed` 都是无状态的（后者的状态是
/// 客户端 IP 本身），所以这里只存轮询游标。游标跨连接、跨探测保留，
/// 轮询才有意义；规则被重建时随 `RunningForward` 一起丢弃。
#[derive(Debug, Default)]
pub struct Selector {
    /// 下一个轮询槽位；对健康目标数量取模，所以能自然跳过不健康目标。
    round_robin_cursor: usize,
}

impl Selector {
    pub fn new() -> Self {
        Self::default()
    }

    /// 按策略从 `health` 里挑一个下标；空列表或全部不健康返回 `None`。
    ///
    /// 调用方（accept 循环）在 `None` 时必须直接关闭客户端连接，
    /// 不能 panic，也不能退回「随便试一个」。
    pub fn pick(
        &mut self,
        strategy: ForwardStrategy,
        client: IpAddr,
        health: &[TargetHealth],
    ) -> Option<usize> {
        if health.is_empty() {
            return None;
        }
        match strategy {
            ForwardStrategy::RoundRobin => {
                let healthy = healthy_indices(health);
                if healthy.is_empty() {
                    return None;
                }
                // 只推进已成功的挑选：全部不健康时留下游标，
                // 恢复后不会凭空跳过一轮。
                let slot = self.round_robin_cursor % healthy.len();
                self.round_robin_cursor = self.round_robin_cursor.wrapping_add(1);
                Some(healthy[slot])
            }
            ForwardStrategy::Failover => health.iter().position(|target| target.healthy),
            ForwardStrategy::LowestLatency => health
                .iter()
                .enumerate()
                .filter(|(_, target)| target.healthy)
                // 延迟未知的目标排在最后；并列时下标小的优先（顺序即优先级）。
                .min_by_key(|(index, target)| (target.latency_ms.unwrap_or(u32::MAX), *index))
                .map(|(index, _)| index),
            ForwardStrategy::IpHashed => {
                let healthy = healthy_indices(health);
                if healthy.is_empty() {
                    return None;
                }
                // 对健康目标的有序子集取模：同一个 IP 只要健康集合不变，
                // 永远落到同一个成员。
                let bucket = (ip_hash(client) % healthy.len() as u64) as usize;
                Some(healthy[bucket])
            }
        }
    }
}

/// 健康目标在原始列表里的下标，保持原始顺序。
fn healthy_indices(health: &[TargetHealth]) -> Vec<usize> {
    health
        .iter()
        .enumerate()
        .filter(|(_, target)| target.healthy)
        .map(|(index, _)| index)
        .collect()
}

/// FNV-1a：不引第三方依赖、结果跨进程/跨版本稳定（`DefaultHasher` 不保证）。
/// IPv4/IPv6 加一个版本字节，避免两类地址的字节序列撞在一起。
fn ip_hash(client: IpAddr) -> u64 {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    fn mix(mut hash: u64, byte: u8) -> u64 {
        hash ^= u64::from(byte);
        hash.wrapping_mul(FNV_PRIME)
    }

    let mut hash = FNV_OFFSET_BASIS;
    match client {
        IpAddr::V4(addr) => {
            hash = mix(hash, 4);
            for octet in addr.octets() {
                hash = mix(hash, octet);
            }
        }
        IpAddr::V6(addr) => {
            hash = mix(hash, 6);
            for octet in addr.octets() {
                hash = mix(hash, octet);
            }
        }
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(value: &str) -> IpAddr {
        value.parse().expect("测试用 IP 必须合法")
    }

    fn indices(picks: &[Option<usize>]) -> Vec<usize> {
        picks
            .iter()
            .map(|pick| pick.expect("这些用例里应该总能选中目标"))
            .collect()
    }

    // ---- RoundRobin ----

    #[test]
    fn round_robin_rotates_across_three_healthy_targets() {
        let mut selector = Selector::new();
        let health = [TargetHealth::up(); 3];
        let picks: Vec<_> = (0..6)
            .map(|_| selector.pick(ForwardStrategy::RoundRobin, ip("10.0.0.1"), &health))
            .collect();
        assert_eq!(
            indices(&picks),
            vec![0, 1, 2, 0, 1, 2],
            "3 个健康目标上连续 6 次必须是 0,1,2,0,1,2"
        );
    }

    #[test]
    fn round_robin_skips_unhealthy_targets() {
        let mut selector = Selector::new();
        let health = [TargetHealth::up(), TargetHealth::down(), TargetHealth::up()];
        let picks: Vec<_> = (0..4)
            .map(|_| selector.pick(ForwardStrategy::RoundRobin, ip("10.0.0.1"), &health))
            .collect();
        assert_eq!(
            indices(&picks),
            vec![0, 2, 0, 2],
            "不健康的目标不能出现在轮询序列里"
        );
    }

    #[test]
    fn round_robin_returns_none_when_nothing_is_healthy() {
        let mut selector = Selector::new();
        let health = [TargetHealth::down(), TargetHealth::down()];
        assert_eq!(
            selector.pick(ForwardStrategy::RoundRobin, ip("10.0.0.1"), &health),
            None
        );
        assert_eq!(
            selector.pick(ForwardStrategy::RoundRobin, ip("10.0.0.1"), &[]),
            None,
            "空目标列表同样返回 None"
        );
    }

    // ---- Failover ----

    #[test]
    fn failover_takes_first_healthy_in_list_order() {
        let mut selector = Selector::new();
        let health = [
            TargetHealth::down(),
            TargetHealth::with_latency(120),
            TargetHealth::with_latency(5),
        ];
        assert_eq!(
            selector.pick(ForwardStrategy::Failover, ip("10.0.0.1"), &health),
            Some(1),
            "主备必须按顺序取第一个健康的，不能按延迟"
        );
    }

    #[test]
    fn failover_uses_primary_again_when_it_recovers() {
        let mut selector = Selector::new();
        let down_primary = [TargetHealth::down(), TargetHealth::up()];
        assert_eq!(
            selector.pick(ForwardStrategy::Failover, ip("10.0.0.1"), &down_primary),
            Some(1)
        );
        let recovered = [TargetHealth::up(), TargetHealth::up()];
        assert_eq!(
            selector.pick(ForwardStrategy::Failover, ip("10.0.0.1"), &recovered),
            Some(0),
            "主目标恢复后必须切回来"
        );
    }

    #[test]
    fn failover_returns_none_when_all_down_or_empty() {
        let mut selector = Selector::new();
        assert_eq!(
            selector.pick(
                ForwardStrategy::Failover,
                ip("10.0.0.1"),
                &[TargetHealth::down(), TargetHealth::down()]
            ),
            None
        );
        assert_eq!(
            selector.pick(ForwardStrategy::Failover, ip("10.0.0.1"), &[]),
            None
        );
    }

    // ---- LowestLatency ----

    #[test]
    fn lowest_latency_picks_the_healthiest_fastest_target() {
        let mut selector = Selector::new();
        let health = [
            TargetHealth::with_latency(80),
            TargetHealth::with_latency(12),
            // 延迟最低但不健康：不能选。
            TargetHealth::down(),
        ];
        assert_eq!(
            selector.pick(ForwardStrategy::LowestLatency, ip("10.0.0.1"), &health),
            Some(1)
        );
    }

    #[test]
    fn lowest_latency_breaks_ties_by_list_order() {
        let mut selector = Selector::new();
        let health = [
            TargetHealth::with_latency(30),
            TargetHealth::with_latency(30),
            TargetHealth::with_latency(30),
        ];
        assert_eq!(
            selector.pick(ForwardStrategy::LowestLatency, ip("10.0.0.1"), &health),
            Some(0),
            "延迟相同必须按列表顺序"
        );
    }

    #[test]
    fn lowest_latency_returns_none_when_all_down_or_empty() {
        let mut selector = Selector::new();
        assert_eq!(
            selector.pick(
                ForwardStrategy::LowestLatency,
                ip("10.0.0.1"),
                &[TargetHealth::down(), TargetHealth::down()]
            ),
            None
        );
        assert_eq!(
            selector.pick(ForwardStrategy::LowestLatency, ip("10.0.0.1"), &[]),
            None
        );
    }

    #[test]
    fn lowest_latency_falls_back_to_first_healthy_without_measurements() {
        let mut selector = Selector::new();
        let health = [TargetHealth::up(), TargetHealth::up()];
        assert_eq!(
            selector.pick(ForwardStrategy::LowestLatency, ip("10.0.0.1"), &health),
            Some(0),
            "没有延迟数据时按顺序回退到第一个健康目标"
        );
    }

    // ---- IpHashed ----

    #[test]
    fn ip_hash_is_stable_for_the_same_client() {
        let mut selector = Selector::new();
        let health = [TargetHealth::up(); 3];
        let client = ip("203.0.113.7");
        let first = selector.pick(ForwardStrategy::IpHashed, client, &health);
        assert!(first.is_some());
        for _ in 0..64 {
            assert_eq!(
                selector.pick(ForwardStrategy::IpHashed, client, &health),
                first,
                "同一个 IP 的多次选择必须稳定"
            );
        }
    }

    #[test]
    fn ip_hash_spreads_different_clients_across_targets() {
        let mut selector = Selector::new();
        let health = [TargetHealth::up(); 3];
        let mut seen = [false; 3];
        for last in 0..=255u8 {
            let client = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, last));
            let picked = selector
                .pick(ForwardStrategy::IpHashed, client, &health)
                .expect("全部健康时必须能选中目标");
            seen[picked] = true;
        }
        assert!(
            seen.iter().all(|hit| *hit),
            "256 个不同 IP 应该覆盖全部 3 个目标，实际 {seen:?}"
        );
    }

    #[test]
    fn ip_hash_lands_on_the_ordered_healthy_subset() {
        let mut selector = Selector::new();
        // 下标 0 永远不健康；哈希只能落在 1 或 2。
        let health = [TargetHealth::down(), TargetHealth::up(), TargetHealth::up()];
        for last in 0..=255u8 {
            let client = IpAddr::V4(std::net::Ipv4Addr::new(192, 0, 2, last));
            let picked = selector
                .pick(ForwardStrategy::IpHashed, client, &health)
                .expect("还有健康目标");
            assert!(
                picked == 1 || picked == 2,
                "不健康的目标不能被哈希选中：{picked}"
            );
        }
    }

    #[test]
    fn ip_hash_returns_none_when_all_down_or_empty() {
        let mut selector = Selector::new();
        assert_eq!(
            selector.pick(
                ForwardStrategy::IpHashed,
                ip("10.0.0.1"),
                &[TargetHealth::down(), TargetHealth::down()]
            ),
            None
        );
        assert_eq!(
            selector.pick(ForwardStrategy::IpHashed, ip("10.0.0.1"), &[]),
            None
        );
    }

    #[test]
    fn ip_hash_keeps_ipv4_and_ipv6_distinct() {
        // 同一个尾号在 v4/v6 下不应被当成同一个 key（有版本字节区分）。
        let v4 = ip("10.0.0.1");
        let v6 = ip("::a00:1");
        assert_ne!(ip_hash(v4), ip_hash(v6));
    }
}
