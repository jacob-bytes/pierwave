//! 转发「组」内选路：给定一组候选目标的健康快照，按策略挑一个下标。
//!
//! 纯逻辑模块：不碰网络、不持有任何 IO，方便穷举边界（空目标、全部不健康、
//! 延迟并列等）。真正的连接由 `forward` 模块按这里返回的下标建立。
//!
//! 健康快照的顺序与规则里 `targets` 的顺序一致：`Failover` 依赖这个顺序
//! 表达主备优先级（主控已经排好序），`IpHashed` 也在**健康目标的有序子集**
//! 上取模，保证同一客户端 IP 始终落到同一个目标。
//!
//! 加权与最少连接需要每个成员的静态权重和**当前活跃连接数**，所以 `Selector`
//! 不再是纯无状态游标：它按规则保存权重表与共享的原子连接计数（见
//! [`ConnectionGuard`]）。

use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use pierwave_proto::{ForwardStrategy, ForwardTarget};

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

/// 权重合法范围，与领域层 / 前端一致。
const WEIGHT_MIN: u32 = 1;
const WEIGHT_MAX: u32 = 100;

/// 连接计数的 RAII 守卫：选路成功后 `+1`，连接关闭 / 超时 / 出错 / panic
/// 解栈时由 `Drop` 无条件 `-1`。
///
/// 计数泄漏会让 `least_conn` 永久偏向某几台成员；因此不能靠调用方在每个
/// `return` 前手动递减——只允许通过这个守卫持有计数。
#[derive(Debug)]
pub struct ConnectionGuard {
    slot: Arc<AtomicUsize>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        // 连接结束时计数必须回到原值；用 fetch_sub 的返回值做防御性检查，
        // 任何 underflow 都说明有重复释放，记日志比静默回绕更好排查。
        let previous = self.slot.fetch_sub(1, Ordering::Relaxed);
        if previous == 0 {
            tracing::error!("转发连接计数出现 underflow（重复释放守卫）");
        }
    }
}

/// 每条转发规则各持有一个：轮询游标、权重表与活跃连接计数都按规则隔离。
///
/// `Failover` / `LowestLatency` / `IpHashed` 都是无状态的（后者的状态是
/// 客户端 IP 本身）；`RoundRobin` 需要一个游标，`LeastConn` 需要平局游标，
/// `Weighted` 需要「当前权重块的洗牌顺序」。
#[derive(Debug, Default)]
pub struct Selector {
    /// 下一个轮询槽位；对健康目标数量取模，所以能自然跳过不健康目标。
    round_robin_cursor: usize,
    /// 最少连接的平局游标：只在 `active` 相同的候选之间轮转。
    least_conn_cursor: usize,
    /// 每个目标的权重（构建时固定；缺省 1）。
    weights: Vec<u32>,
    /// 每个目标的活跃连接数，`ConnectionGuard` 与此共享同一个原子量。
    active: Vec<Arc<AtomicUsize>>,
    /// 当前平滑加权块：按权重重复每个健康目标后洗牌。
    weighted_slots: Vec<usize>,
    /// 当前块里下一个待用的下标。
    weighted_cursor: usize,
    /// 生成当前块时的「健康集合 + 权重」签名；变化时重新生成。
    weighted_signature: u64,
    /// 加权块的洗牌 PRNG（固定种子的 SplitMix64，测试可复现）。
    rng: SplitMix64,
}

impl Selector {
    pub fn new() -> Self {
        Self::default()
    }

    /// 按规则里的候选目标建游标：记录权重并为每台成员建一个连接计数器。
    ///
    /// 规则重建时 `Selector` 一起重建，旧计数随旧连接守卫释放；不会把上一版
    /// 目标列表的计数带到新列表上。
    pub fn for_targets(targets: &[ForwardTarget]) -> Self {
        let mut selector = Self::new();
        selector.weights = targets
            .iter()
            .map(|target| clamp_weight(target.weight))
            .collect();
        selector.active = targets
            .iter()
            .map(|_| Arc::new(AtomicUsize::new(0)))
            .collect();
        selector
    }

    /// 只给权重、不需要真实 `ForwardTarget` 的构造（测试与纯逻辑复用）。
    #[cfg(test)]
    pub fn with_weights(weights: &[u32]) -> Self {
        let mut selector = Self::new();
        selector.weights = weights.iter().copied().map(clamp_weight).collect();
        selector.active = weights
            .iter()
            .map(|_| Arc::new(AtomicUsize::new(0)))
            .collect();
        selector
    }

    /// 固定 PRNG 种子：加权块的洗牌顺序可复现（测试断言分布用）。
    #[cfg(test)]
    pub fn with_seed(mut self, seed: u64) -> Self {
        self.rng = SplitMix64::seeded(seed);
        self
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
            // 平滑加权随机：按权重把健康目标展开成一个「权重块」并洗牌，
            // 块内每个成员出现的次数严格等于权重；洗牌只改变顺序。
            //
            // 这比朴素独立随机更平滑：任意一个权重块内不会出现某台成员
            // 连续吃掉几十个连接，长期比例又收敛到权重占比。**不是**逐次
            // 严格比例（块内前几个连接仍可能偏多）。
            ForwardStrategy::Weighted => self.weighted_pick(health),
            // 最少连接：先按活跃连接数取最小，平局在候选之间按轮询轮转。
            ForwardStrategy::LeastConn => {
                let healthy = healthy_indices(health);
                if healthy.is_empty() {
                    return None;
                }
                let least = healthy
                    .iter()
                    .map(|index| self.active_count(*index))
                    .min()
                    .unwrap_or(0);
                let ties: Vec<usize> = healthy
                    .into_iter()
                    .filter(|index| self.active_count(*index) == least)
                    .collect();
                let slot = self.least_conn_cursor % ties.len();
                self.least_conn_cursor = self.least_conn_cursor.wrapping_add(1);
                Some(ties[slot])
            }
        }
    }

    /// 为一次已选中的连接登记 `+1`，返回的守卫必须活到连接结束。
    ///
    /// 目标下标越界（只可能来自手工构造的错误列表）返回 `None`，不 panic。
    pub fn track(&self, index: usize) -> Option<ConnectionGuard> {
        let slot = self.active.get(index)?.clone();
        slot.fetch_add(1, Ordering::Relaxed);
        Some(ConnectionGuard { slot })
    }

    /// 当前各目标的活跃连接数（测试断言「计数无泄漏」用）。
    #[cfg(test)]
    pub fn active_snapshot(&self) -> Vec<usize> {
        self.active
            .iter()
            .map(|slot| slot.load(Ordering::Relaxed))
            .collect()
    }

    fn weight(&self, index: usize) -> u32 {
        self.weights
            .get(index)
            .copied()
            .map(clamp_weight)
            .unwrap_or(WEIGHT_MIN)
    }

    fn active_count(&self, index: usize) -> usize {
        self.active
            .get(index)
            .map(|slot| slot.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    fn weighted_pick(&mut self, health: &[TargetHealth]) -> Option<usize> {
        let healthy = healthy_indices(health);
        if healthy.is_empty() {
            return None;
        }
        let signature = weight_signature(
            &healthy,
            &healthy
                .iter()
                .map(|index| self.weight(*index))
                .collect::<Vec<_>>(),
        );
        if signature != self.weighted_signature || self.weighted_cursor >= self.weighted_slots.len()
        {
            self.rebuild_weighted_block(&healthy);
            self.weighted_signature = signature;
        }
        let index = *self.weighted_slots.get(self.weighted_cursor)?;
        self.weighted_cursor += 1;
        Some(index)
    }

    /// 生成并洗牌一个权重块：每个健康目标重复 `weight` 次。
    ///
    /// 总长度最多 `8 × 100 = 800`，分配成本可以忽略；块用尽后才重排，
    /// 所以「谁先谁后」是随机的，但一个块内的出现次数是确定的。
    fn rebuild_weighted_block(&mut self, healthy: &[usize]) {
        self.weighted_slots.clear();
        for &index in healthy {
            for _ in 0..self.weight(index) {
                self.weighted_slots.push(index);
            }
        }
        // Fisher–Yates：从后往前与随机前缀位置交换，无偏且不需要额外内存。
        let len = self.weighted_slots.len();
        for position in (1..len).rev() {
            let swap_with = (self.rng.next_u64() % (position as u64 + 1)) as usize;
            self.weighted_slots.swap(position, swap_with);
        }
        self.weighted_cursor = 0;
    }
}

/// 权重夹紧到合法区间：线协议/主控已校验，这里兜底脏数据（0 会让成员永远
/// 选不中，超过 100 会让单个权重块过大）。
fn clamp_weight(weight: u32) -> u32 {
    weight.clamp(WEIGHT_MIN, WEIGHT_MAX)
}

/// 健康集合 + 权重的 FNV-1a 签名：健康状态变化时必须重排权重块。
fn weight_signature(healthy: &[usize], weights: &[u32]) -> u64 {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = FNV_OFFSET_BASIS;
    for (index, weight) in healthy.iter().zip(weights) {
        for byte in (*index as u64).to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        for byte in weight.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    hash
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

/// SplitMix64：小、快、无依赖，固定种子可复现。只用于加权块的洗牌，
/// 不承担任何密码学职责。
#[derive(Debug, Clone)]
struct SplitMix64 {
    state: u64,
}

impl Default for SplitMix64 {
    fn default() -> Self {
        Self::seeded(0x9E37_79B9_7F4A_7C15)
    }
}

impl SplitMix64 {
    fn seeded(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
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

    // ---- Weighted ----

    /// 1000 次抽样，权重 1:2:7：固定种子下每个成员的实际占比与期望值
    /// （10% / 20% / 70%）误差必须 ≤ 5 个百分点。
    #[test]
    fn weighted_sampling_matches_weights_within_five_percent() {
        let mut selector = Selector::with_weights(&[1, 2, 7]).with_seed(0x5EED_1234);
        let health = [TargetHealth::up(); 3];
        let mut counts = [0usize; 3];
        for _ in 0..1000 {
            let picked = selector
                .pick(ForwardStrategy::Weighted, ip("10.0.0.1"), &health)
                .expect("全部健康时必须能选中目标");
            counts[picked] += 1;
        }
        let expected = [100usize, 200, 700];
        for (index, (actual, expected)) in counts.iter().zip(expected).enumerate() {
            let error = actual.abs_diff(expected) as f64 / 1000.0;
            assert!(
                error <= 0.05,
                "成员 {index} 实际 {actual} 次，期望 {expected} 次（误差 {:.1}% > 5%）",
                error * 100.0
            );
        }
        assert_eq!(counts.iter().sum::<usize>(), 1000);
    }

    /// 不是朴素独立随机：任意一个权重块（1+2+7=10 次）内，三者的出现次数
    /// 精确等于权重，不会出现「7 次里全是同一台」的短期抖动。
    #[test]
    fn weighted_blocks_are_exact_and_shuffled() {
        let mut selector = Selector::with_weights(&[1, 2, 7]).with_seed(7);
        let health = [TargetHealth::up(); 3];
        let mut block_counts = [0usize; 3];
        let mut first_block = Vec::new();
        for position in 0..30 {
            let picked = selector
                .pick(ForwardStrategy::Weighted, ip("10.0.0.1"), &health)
                .unwrap();
            if position % 10 == 0 {
                assert_eq!(block_counts, [0, 0, 0], "新块必须从零开始计数");
            }
            block_counts[picked] += 1;
            if position < 10 {
                first_block.push(picked);
            }
            if position % 10 == 9 {
                assert_eq!(
                    block_counts,
                    [1, 2, 7],
                    "每个权重块内出现次数必须严格等于权重"
                );
                block_counts = [0, 0, 0];
            }
        }
        // 顺序必须被打乱过：固定种子下不能恰好是 [0,1,1,2,2,2,2,2,2,2]。
        assert!(
            first_block.windows(2).any(|pair| pair[0] != pair[1]),
            "权重块必须洗牌，不能按成员聚在一起：{first_block:?}"
        );
    }

    #[test]
    fn weighted_skips_unhealthy_and_handles_zero_weight() {
        let mut selector = Selector::with_weights(&[0, 1, 1]).with_seed(11);
        // 中间成员不健康，权重 0 的成员也被夹紧到 1：只剩 0 与 2 可选。
        let health = [TargetHealth::up(), TargetHealth::down(), TargetHealth::up()];
        for _ in 0..32 {
            let picked = selector
                .pick(ForwardStrategy::Weighted, ip("10.0.0.1"), &health)
                .unwrap();
            assert!(picked == 0 || picked == 2, "不健康成员不能被选中：{picked}");
        }
        assert_eq!(
            selector.pick(
                ForwardStrategy::Weighted,
                ip("10.0.0.1"),
                &[TargetHealth::down(), TargetHealth::down()]
            ),
            None,
            "全部不健康时返回 None"
        );
    }

    // ---- LeastConn ----

    #[test]
    fn least_conn_picks_the_target_with_fewest_active_connections() {
        let mut selector = Selector::with_weights(&[1, 1, 1]);
        // 让成员 1 有 2 条活跃连接、成员 2 有 1 条。
        let _guard_a = selector.track(1).unwrap();
        let _guard_b = selector.track(1).unwrap();
        let _guard_c = selector.track(2).unwrap();
        assert_eq!(selector.active_snapshot(), vec![0, 2, 1]);

        let health = [TargetHealth::up(); 3];
        assert_eq!(
            selector.pick(ForwardStrategy::LeastConn, ip("10.0.0.1"), &health),
            Some(0),
            "连接数最少的成员优先"
        );
    }

    #[test]
    fn least_conn_breaks_ties_round_robin() {
        let mut selector = Selector::with_weights(&[1, 1, 1]);
        let health = [TargetHealth::up(); 3];
        let picks: Vec<_> = (0..4)
            .map(|_| selector.pick(ForwardStrategy::LeastConn, ip("10.0.0.1"), &health))
            .collect();
        assert_eq!(
            indices(&picks),
            vec![0, 1, 2, 0],
            "全部 0 连接时必须按轮询平局"
        );
    }

    /// 连接计数在成功、错误、panic 解栈等所有路径都必须归零：
    /// 这里用一个作用域模拟「连接建立 → 出错 → 提前 return」。
    #[test]
    fn connection_guard_returns_to_zero_on_error_paths() {
        let selector = Selector::with_weights(&[1, 1]);
        assert_eq!(selector.active_snapshot(), vec![0, 0]);

        // 正常路径。
        {
            let _guard = selector.track(0).unwrap();
            assert_eq!(selector.active_snapshot(), vec![1, 0]);
        }
        assert_eq!(selector.active_snapshot(), vec![0, 0]);

        // 错误路径：拿到守卫后走一个会失败的函数，提前离开作用域。
        fn connect_and_fail(selector: &Selector) -> Result<(), &'static str> {
            let _guard = selector.track(1).expect("目标存在");
            Err("connection refused")
        }
        assert_eq!(connect_and_fail(&selector), Err("connection refused"));
        assert_eq!(
            selector.active_snapshot(),
            vec![0, 0],
            "连接失败返回后计数必须归零"
        );

        // panic 解栈同样由 Drop 递减。
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = selector.track(0).unwrap();
            assert_eq!(selector.active_snapshot(), vec![1, 0]);
            panic!("模拟连接任务 panic");
        }));
        assert!(outcome.is_err());
        assert_eq!(
            selector.active_snapshot(),
            vec![0, 0],
            "panic 解栈也必须归零"
        );

        // 越界下标不能 panic，也不产生计数。
        assert!(selector.track(9).is_none());
        assert_eq!(selector.active_snapshot(), vec![0, 0]);
    }

    #[test]
    fn least_conn_returns_none_when_all_down_or_empty() {
        let mut selector = Selector::with_weights(&[1, 1]);
        assert_eq!(
            selector.pick(
                ForwardStrategy::LeastConn,
                ip("10.0.0.1"),
                &[TargetHealth::down(), TargetHealth::down()]
            ),
            None
        );
        assert_eq!(
            selector.pick(ForwardStrategy::LeastConn, ip("10.0.0.1"), &[]),
            None
        );
    }

    #[test]
    fn weighted_and_least_conn_are_deterministic_with_fixed_seed() {
        let health = [TargetHealth::up(); 3];
        let mut first = Selector::with_weights(&[3, 1, 1]).with_seed(99);
        let mut second = Selector::with_weights(&[3, 1, 1]).with_seed(99);
        for _ in 0..40 {
            assert_eq!(
                first.pick(ForwardStrategy::Weighted, ip("10.0.0.1"), &health),
                second.pick(ForwardStrategy::Weighted, ip("10.0.0.1"), &health),
                "固定种子下加权序列必须可复现"
            );
        }
    }

    #[test]
    fn weights_are_clamped_to_one_through_one_hundred() {
        let selector = Selector::for_targets(&[
            ForwardTarget {
                host: "10.0.0.1".into(),
                port: 1,
                server_id: "a".into(),
                weight: 0,
            },
            ForwardTarget {
                host: "10.0.0.2".into(),
                port: 2,
                server_id: "b".into(),
                weight: 500,
            },
        ]);
        assert_eq!(selector.weight(0), 1, "0 必须夹紧到 1");
        assert_eq!(selector.weight(1), 100, "超过 100 必须夹紧到 100");
        assert_eq!(selector.active_snapshot(), vec![0, 0]);
    }
}
