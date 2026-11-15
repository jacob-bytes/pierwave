//! 观测值的纯计算：网卡速率、探测可用率、链降级判定。
//!
//! 这里不碰数据库与 HTTP，全部是可以在单测里固定输入输出的函数：
//! * [`net_rate`]：两次心跳的累计字节差 / 时间差 → 当前速率；
//! * [`probe_health`]：探测次数 / 失败次数 → 可用率与探测失败率；
//! * [`observe_degradation`]：连续 N 次低于阈值才判降级（只报警一次）。
//!
//! **口径（同时写在 `docs/TELEMETRY.md`）**：
//! * 网速只用于展示，不参与计费；
//! * 「丢包」是**探测失败率**的近似，不是业务报文的真实丢包率；
//! * 样本不足（见 [`MIN_PROBE_ATTEMPTS`]）时一律返回 `None`，由前端显示 `—`，
//!   绝不返回 0——0 会被读成「完全没有流量」或「完全不可用」。

/// 24h 可用率进入展示 / 告警所需的最少探测次数。
///
/// Agent 每 30 秒探一次目标，20 次约等于「连续观测了 10 分钟」。
/// 少于这个量说明链路刚上线或样本被清理，此时显示 `—` 比给一个忽上忽下的
/// 百分比更诚实。
pub const MIN_PROBE_ATTEMPTS: i64 = 20;

/// 24h 趋势 / 可用率的时间桶（5 分钟，与延迟历史一致）。
pub const PROBE_BUCKET_SECS: i64 = 300;

/// 探测样本保留 7 天（与延迟样本一致）。
pub const PROBE_RETENTION_SECS: i64 = 7 * 86_400;

/// 告警判断用的「近期窗口」：只看最近 15 分钟的探测。
///
/// 24h 可用率适合展示（抗抖动），但用它告警会漏掉刚发生的故障：
/// 24h 里断 10 分钟仍可能高于 99%。告警必须看短窗口。
pub const DEGRADED_WINDOW_SECS: i64 = 900;

/// 可用率低于该百分比（默认 99%）算「不健康」。
pub const DEFAULT_AVAILABILITY_THRESHOLD_PERCENT: f64 = 99.0;

/// 连续多少次心跳观测都低于阈值才发告警（默认 3 次）。
pub const DEFAULT_DEGRADED_STREAK: i64 = 3;

/// 连续次数上限：防止环境变量写成天文数字后永远不告警。
pub const MAX_DEGRADED_STREAK: i64 = 100;

/// 速率上限（字节/秒）：1 Tbps。
///
/// 超过它只可能是脏数据（计数器重置成奇怪值、接口统计错乱），
/// 按「异常峰值」丢弃，宁可不显示也不画一根假的尖峰。
pub const MAX_PLAUSIBLE_NET_BPS: f64 = 1.25e11;

/// 一次网卡计数器快照（累计字节 + 采集时刻）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetCounters {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    /// 采集时刻（Unix 秒）。
    pub at: i64,
}

/// 两次快照之间算出的速率（字节/秒）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NetRate {
    pub rx_bps: f64,
    pub tx_bps: f64,
}

/// 由两次心跳的累计计数器算当前速率。
///
/// 返回 `None` 的情况（都必须被主控当成「无数据」而不是 0）：
/// * 没有上一份基线（服务器刚上线 / 旧 Agent 第一次上报）；
/// * 时间差 `<= 0`（同一秒的两次心跳、系统时钟回拨）——不能拿它做分母；
/// * 任一计数器变小——内核重启 / 计数重置（回绕）：这次差值不可信；
/// * 算出的速率超过 [`MAX_PLAUSIBLE_NET_BPS`]——异常峰值。
pub(crate) fn net_rate(previous: Option<NetCounters>, current: NetCounters) -> Option<NetRate> {
    let previous = previous?;
    let elapsed = current.at - previous.at;
    if elapsed <= 0 {
        return None;
    }
    if current.rx_bytes < previous.rx_bytes || current.tx_bytes < previous.tx_bytes {
        // 计数器回绕 / 网卡重置：丢弃这次差值，绝不写出负数或巨大尖峰。
        return None;
    }
    let seconds = elapsed as f64;
    let rx_bps = (current.rx_bytes - previous.rx_bytes) as f64 / seconds;
    let tx_bps = (current.tx_bytes - previous.tx_bytes) as f64 / seconds;
    if !rx_bps.is_finite()
        || !tx_bps.is_finite()
        || rx_bps > MAX_PLAUSIBLE_NET_BPS
        || tx_bps > MAX_PLAUSIBLE_NET_BPS
    {
        return None;
    }
    Some(NetRate { rx_bps, tx_bps })
}

/// 一个时间窗内的探测次数与失败次数。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProbeCounts {
    pub attempts: i64,
    pub failures: i64,
}

impl ProbeCounts {
    pub fn add(&mut self, other: ProbeCounts) {
        self.attempts = self.attempts.saturating_add(other.attempts);
        self.failures = self.failures.saturating_add(other.failures);
    }
}

/// 聚合后的可用率 / 探测失败率。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProbeHealth {
    /// 0..1；样本不足或数据自相矛盾时为 `None`。
    pub availability: Option<f64>,
    /// 0..1 的探测失败率；口径见模块文档。
    pub loss: Option<f64>,
    /// 进入计算的探测次数（即使样本不足也返回，前端可提示样本量）。
    pub attempts: i64,
}

/// 由探测计数算可用率与探测失败率。
///
/// * 样本不足（`attempts < MIN_PROBE_ATTEMPTS`）→ 两项都是 `None`；
/// * `failures` 越界（负数或大于次数，只可能来自脏数据）→ `None`；
/// * 全部成功 → 100% / 0%；全部失败 → 0% / 100%。
///
/// 注意 `0%` 是**有数据**的 0，`—` 才是没有数据。
pub fn probe_health(counts: ProbeCounts) -> ProbeHealth {
    if counts.attempts < MIN_PROBE_ATTEMPTS
        || counts.failures < 0
        || counts.failures > counts.attempts
    {
        return ProbeHealth {
            availability: None,
            loss: None,
            attempts: counts.attempts.max(0),
        };
    }
    let loss = counts.failures as f64 / counts.attempts as f64;
    ProbeHealth {
        availability: Some(1.0 - loss),
        loss: Some(loss),
        attempts: counts.attempts,
    }
}

/// 一条链的可用率：把所有成员的探测次数当作权重合并。
///
/// 不能对成员可用率取算术平均：一个探测 20 次的成员和一个探测 2000 次的成员
/// 权重不该相同，否则刚上线的成员会把整体数字带偏。
pub fn fold_probe_counts(counts: impl IntoIterator<Item = ProbeCounts>) -> ProbeCounts {
    let mut total = ProbeCounts::default();
    for item in counts {
        total.add(item);
    }
    total
}

/// 5 分钟桶里的一条探测记录（仓储读出来后的形态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbeBucket {
    /// 桶起点（Unix 秒，已对齐到 [`PROBE_BUCKET_SECS`]）。
    pub ts: i64,
    pub attempts: i64,
    pub failures: i64,
}

/// 把 5 分钟桶按目标顺序合并成趋势点（同一时间戳跨成员相加）。
///
/// 返回按 `ts` 升序、只包含**有探测**的桶；没有数据的时间段由前端留空，
/// 不补 0（补 0 会被画成「丢包 0%」，与「没有探测」是两件事）。
pub fn merge_probe_buckets(buckets: impl IntoIterator<Item = ProbeBucket>) -> Vec<ProbeBucket> {
    let mut merged: Vec<ProbeBucket> = Vec::new();
    for bucket in buckets {
        match merged.iter_mut().find(|item| item.ts == bucket.ts) {
            Some(item) => {
                item.attempts = item.attempts.saturating_add(bucket.attempts);
                item.failures = item.failures.saturating_add(bucket.failures);
            }
            None => merged.push(bucket),
        }
    }
    merged.sort_by_key(|bucket| bucket.ts);
    merged
}

/// 链降级判定策略（可由环境变量覆盖）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DegradationPolicy {
    /// 可用率阈值（百分比，0..=100）。
    pub threshold_percent: f64,
    /// 连续多少次观测低于阈值才告警。
    pub streak: i64,
}

impl Default for DegradationPolicy {
    fn default() -> Self {
        Self {
            threshold_percent: DEFAULT_AVAILABILITY_THRESHOLD_PERCENT,
            streak: DEFAULT_DEGRADED_STREAK,
        }
    }
}

impl DegradationPolicy {
    /// 从环境变量原文构造：非法值回落默认值，不做部分生效。
    pub fn from_raw(threshold: Option<&str>, streak: Option<&str>) -> Self {
        let defaults = Self::default();
        Self {
            threshold_percent: parse_threshold_percent(threshold)
                .unwrap_or(defaults.threshold_percent),
            streak: parse_degraded_streak(streak).unwrap_or(defaults.streak),
        }
    }
}

/// 解析阈值百分比：`0..=100` 的有限数，否则 `None`（调用方回落默认 99）。
pub fn parse_threshold_percent(raw: Option<&str>) -> Option<f64> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let value = raw.parse::<f64>().ok()?;
    if !value.is_finite() || !(0.0..=100.0).contains(&value) {
        return None;
    }
    Some(value)
}

/// 解析「连续 N 次」：1..=[`MAX_DEGRADED_STREAK`] 的整数，否则 `None`。
pub fn parse_degraded_streak(raw: Option<&str>) -> Option<i64> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let value = raw.parse::<i64>().ok()?;
    if !(1..=MAX_DEGRADED_STREAK).contains(&value) {
        return None;
    }
    Some(value)
}

/// 一条链的降级状态机状态（落库，重启后继续累计）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DegradationState {
    /// 连续低于阈值的观测次数。
    pub consecutive_below: i64,
    /// 本轮故障是否已经告警过（避免每轮心跳都发）。
    pub alerted: bool,
}

/// 观测一次链的近期可用率，返回新状态与「本轮是否要发告警」。
///
/// * 样本不足（`health.availability = None`）→ 状态不变、不告警：
///   没有数据不等于故障，不能因为探测样本被清理就误报；
/// * 恢复到阈值以上 → 清零并允许下一次故障重新告警；
/// * 连续低于阈值达到 `policy.streak` 次 → 只告警一次，
///   直到恢复后才重新武装。
pub fn observe_degradation(
    state: DegradationState,
    health: ProbeHealth,
    policy: DegradationPolicy,
) -> (DegradationState, bool) {
    let Some(availability) = health.availability else {
        return (state, false);
    };
    let healthy = availability * 100.0 >= policy.threshold_percent;
    if healthy {
        return (DegradationState::default(), false);
    }
    let consecutive_below = state.consecutive_below.saturating_add(1);
    let should_alert = !state.alerted && consecutive_below >= policy.streak.max(1);
    (
        DegradationState {
            consecutive_below,
            alerted: state.alerted || should_alert,
        },
        should_alert,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counters(rx_bytes: u64, tx_bytes: u64, at: i64) -> NetCounters {
        NetCounters {
            rx_bytes,
            tx_bytes,
            at,
        }
    }

    #[test]
    fn net_rate_is_delta_over_elapsed_seconds() {
        let previous = counters(1_000, 2_000, 1_000);
        let current = counters(1_000 + 12_300_000, 2_000 + 1_200_000, 1_060);
        let rate = net_rate(Some(previous), current).expect("两次心跳应能算出速率");
        assert!((rate.rx_bps - 205_000.0).abs() < 1e-6, "12.3MB/60s");
        assert!((rate.tx_bps - 20_000.0).abs() < 1e-6);
    }

    #[test]
    fn net_rate_without_baseline_is_none() {
        assert_eq!(
            net_rate(None, counters(10, 20, 1_000)),
            None,
            "第一次上报没有基线，必须无数据（前端显示 —）"
        );
    }

    #[test]
    fn net_rate_with_zero_or_negative_elapsed_is_none() {
        let previous = counters(100, 100, 1_000);
        assert_eq!(
            net_rate(Some(previous), counters(200, 200, 1_000)),
            None,
            "时间差为 0 不能做分母"
        );
        assert_eq!(
            net_rate(Some(previous), counters(200, 200, 999)),
            None,
            "时钟回拨同样不能被当成一个正常窗口"
        );
    }

    #[test]
    fn net_rate_discards_counter_wraparound() {
        let previous = counters(9_000_000, 8_000_000, 1_000);
        // 机器重启：计数器从 0 重新开始。
        let current = counters(500, 400, 1_060);
        assert_eq!(
            net_rate(Some(previous), current),
            None,
            "回绕时必须丢弃差值，不能记负数或异常峰值"
        );
        // 两个方向任意一个回绕都要丢弃。
        let mixed = counters(9_500_000, 100, 1_060);
        assert_eq!(net_rate(Some(previous), mixed), None);
    }

    #[test]
    fn net_rate_discards_implausible_peaks() {
        let previous = counters(0, 0, 1_000);
        // 60 秒内 10 PB：只可能是脏数据（计数器被写成奇怪值）。
        let current = counters(10_000_000_000_000_000, 0, 1_060);
        assert_eq!(net_rate(Some(previous), current), None);
    }

    #[test]
    fn probe_health_all_success_is_full_availability() {
        let health = probe_health(ProbeCounts {
            attempts: 100,
            failures: 0,
        });
        assert_eq!(health.availability, Some(1.0));
        assert_eq!(health.loss, Some(0.0));
        assert_eq!(health.attempts, 100);
    }

    #[test]
    fn probe_health_all_failure_is_zero_availability_not_unknown() {
        let health = probe_health(ProbeCounts {
            attempts: 20,
            failures: 20,
        });
        assert_eq!(
            health.availability,
            Some(0.0),
            "全失败是「有数据的 0%」，不是 —"
        );
        assert_eq!(health.loss, Some(1.0));
    }

    #[test]
    fn probe_health_insufficient_samples_is_none() {
        let health = probe_health(ProbeCounts {
            attempts: MIN_PROBE_ATTEMPTS - 1,
            failures: 0,
        });
        assert_eq!(health.availability, None);
        assert_eq!(health.loss, None);
        assert_eq!(health.attempts, MIN_PROBE_ATTEMPTS - 1);

        let zero = probe_health(ProbeCounts::default());
        assert_eq!(zero.availability, None, "0 次探测不能显示 100%");
    }

    #[test]
    fn probe_health_computes_probe_failure_rate() {
        let health = probe_health(ProbeCounts {
            attempts: 400,
            failures: 1,
        });
        let availability = health.availability.unwrap();
        assert!((availability - 0.9975).abs() < 1e-12, "99.75%");
        assert!((health.loss.unwrap() - 0.0025).abs() < 1e-12);

        // 脏数据（失败数比次数还多）不能算出一个负可用率。
        let broken = probe_health(ProbeCounts {
            attempts: 100,
            failures: 101,
        });
        assert_eq!(broken.availability, None);
        assert_eq!(broken.loss, None);
    }

    #[test]
    fn fold_probe_counts_weights_by_attempts() {
        let total = fold_probe_counts([
            ProbeCounts {
                attempts: 100,
                failures: 0,
            },
            ProbeCounts {
                attempts: 100,
                failures: 10,
            },
        ]);
        assert_eq!(total.attempts, 200);
        assert_eq!(total.failures, 10);
        let health = probe_health(total);
        assert!((health.availability.unwrap() - 0.95).abs() < 1e-12);
    }

    #[test]
    fn merge_probe_buckets_sums_same_timestamp_and_sorts() {
        let merged = merge_probe_buckets([
            ProbeBucket {
                ts: 600,
                attempts: 10,
                failures: 1,
            },
            ProbeBucket {
                ts: 300,
                attempts: 5,
                failures: 0,
            },
            ProbeBucket {
                ts: 600,
                attempts: 10,
                failures: 3,
            },
        ]);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].ts, 300);
        assert_eq!(merged[1].ts, 600);
        assert_eq!(merged[1].attempts, 20);
        assert_eq!(merged[1].failures, 4);
    }

    #[test]
    fn policy_parsing_falls_back_on_invalid_values() {
        let defaults = DegradationPolicy::default();
        assert_eq!(
            DegradationPolicy::from_raw(None, None),
            defaults,
            "缺省 99% / 3 次"
        );
        assert_eq!(DegradationPolicy::from_raw(Some("  "), Some("")), defaults);
        assert_eq!(
            DegradationPolicy::from_raw(Some("abc"), Some("2")),
            DegradationPolicy {
                threshold_percent: 99.0,
                streak: 2,
            }
        );
        assert_eq!(
            DegradationPolicy::from_raw(Some("120"), Some("0")),
            defaults,
            "越界值一律回落默认，不做部分生效"
        );
        assert_eq!(
            DegradationPolicy::from_raw(Some("99.5"), Some("5")),
            DegradationPolicy {
                threshold_percent: 99.5,
                streak: 5,
            }
        );
    }

    #[test]
    fn degradation_alerts_once_after_the_configured_streak_and_rearms() {
        let policy = DegradationPolicy {
            threshold_percent: 99.0,
            streak: 3,
        };
        let unhealthy = probe_health(ProbeCounts {
            attempts: 100,
            failures: 5,
        });
        assert!(unhealthy.availability.unwrap() < 0.99);

        let state = DegradationState::default();
        let (state, alert) = observe_degradation(state, unhealthy, policy);
        assert!(!alert, "第 1 次不告警");
        assert_eq!(state.consecutive_below, 1);
        let (state, alert) = observe_degradation(state, unhealthy, policy);
        assert!(!alert, "第 2 次不告警");
        let (state, alert) = observe_degradation(state, unhealthy, policy);
        assert!(alert, "第 3 次触发");
        assert!(state.alerted);
        let (state, alert) = observe_degradation(state, unhealthy, policy);
        assert!(!alert, "同一轮故障只告警一次");
        assert_eq!(state.consecutive_below, 4);

        let healthy = probe_health(ProbeCounts {
            attempts: 100,
            failures: 0,
        });
        let (state, alert) = observe_degradation(state, healthy, policy);
        assert!(!alert);
        assert_eq!(state, DegradationState::default(), "恢复后清零并重新武装");

        // 恢复后再次连续 3 次不健康：可以重新告警。
        let mut state = state;
        for _ in 0..2 {
            let (next, _) = observe_degradation(state, unhealthy, policy);
            state = next;
        }
        let (_, alert) = observe_degradation(state, unhealthy, policy);
        assert!(alert, "恢复后的新故障必须再次告警");
    }

    #[test]
    fn insufficient_samples_do_not_count_as_degraded() {
        let policy = DegradationPolicy::default();
        let unknown = probe_health(ProbeCounts::default());
        let state = DegradationState {
            consecutive_below: 2,
            alerted: false,
        };
        let (next, alert) = observe_degradation(state, unknown, policy);
        assert!(!alert);
        assert_eq!(next, state, "没有数据不能推进也不能重置降级计数");
    }
}
