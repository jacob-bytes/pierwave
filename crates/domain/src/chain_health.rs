//! 跨链时延聚合（`/api/v1/overview/chain-health`）的纯逻辑。
//!
//! 输入是**一次读出的链拓扑**与**一次取出的窗口样本**，这里只做内存归并，
//! 不碰 SQL、不读 HTTP 上下文。口径与限制见 `docs/CHAIN-HEALTH.md`：
//!
//! * 链的第 N 组 → 第 N+1 组为一「段」，段的 `seq` 取**目标组**的 seq；
//! * 样本条件：`server_id ∈ group[N].members` 且
//!   `target_server_id ∈ group[N+1].members`。单成员下一跳在旧 Agent 上会用
//!   兼容字段上报空 `target_server_id`，这里按「下一组唯一成员」补回；
//! * 最后一跳（最后一组 → 链目标）没有历史样本：写进 `missing_hops`，
//!   **不补 0**；
//! * 整体时延 = 同一桶里各段 p50 之和；任一段缺样本则该桶为 null；
//! * 当前值取最近 [`CURRENT_WINDOW_SECS`]（2 小时）的桶中位数，基线取此前
//!   [`BASELINE_WINDOW_SECS`]（24 小时）的桶中位数。选择 2h 而不是 24h 的
//!   原因：24h 中位数会把最近 2 小时的短时劣化稀释到 8% 的权重，回答不了
//!   「现在哪条链慢」；基线仍用 24h，避免单个桶的抖动。
//! * 丢包：每段取同一「当前窗口」（最近 2h，与 p50 一致）内
//!   `forward_probe_samples` 的 attempts / failures；单段 `loss = failures /
//!   attempts`，attempts = 0 时为 `null`（不是 0）。整链按各跳独立连乘
//!   `1 - Π(1 - loss_i)`；缺数据的段跳过，只有「部分段有数据」时才标
//!   `loss_partial`（全链无数据时 `loss_pct = null`、`loss_partial = false`）。
//! * 多成员组（多路径）按段中位数求和，链级 `estimated = true`；丢包则把
//!   各成员的探测计数相加后再算比值。

use std::collections::HashMap;

use serde::Serialize;

use crate::models::{ChainGroupMember, ChainGroupWithMembers, ChainWithGroups};
use crate::repo::latency::LatencySample;
use crate::telemetry::ProbeCounts;

/// 当前值窗口：最近 2 小时（按桶宽向下取整）。
pub const CURRENT_WINDOW_SECS: i64 = 2 * 60 * 60;
/// 基线窗口：当前窗口之前的 24 小时（按桶宽向下取整）。
pub const BASELINE_WINDOW_SECS: i64 = 24 * 60 * 60;
/// 「变慢的链」阈值：整体 p50 较基线上升 ≥ 8ms。
///
/// 与前端设计稿里的「稳定 = 没有超过 8ms 的变化」一致；8ms 也是跨公网
/// 一跳的常见抖动上限，低于它更像噪声而不是需要排障的事件。
pub const SLOW_DELTA_MS: f64 = 8.0;
/// 单段主导阈值：某段贡献 ≥ 80% 判 `single_hop`。
pub const SINGLE_HOP_CONTRIBUTION_PCT: f64 = 80.0;

/// 链级诊断。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diagnosis {
    /// `single_hop` / `overall` / `unknown`。
    pub kind: &'static str,
    /// 只有 `single_hop` 时给出主导段的 seq。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
}

impl Diagnosis {
    fn unknown() -> Self {
        Self {
            kind: "unknown",
            seq: None,
        }
    }
}

/// 一「段」的视图：第 N 组 → 第 N+1 组。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentView {
    /// 段编号：目标组的 `seq`（正常链是 1..hops-1）。
    pub seq: i64,
    /// 源组代表成员名；多路径时是当前窗口样本最多的那台。
    pub from: String,
    /// 目标组代表成员名。
    pub to: String,
    /// 当前窗口的桶中位数；没有样本时 null，不是 0。
    pub p50: Option<f64>,
    /// `p50 - 基线 p50`；任一侧无样本时 null。
    pub delta_ms: Option<f64>,
    /// 正向增量占比（0..100，整数）。只把「变慢」的段计入分母。
    pub contribution_pct: i64,
    /// 当前窗口内的探测次数；没有探测时 0（`loss_pct` 为 null）。
    pub attempts: i64,
    /// 当前窗口内的探测失败次数。
    pub failures: i64,
    /// `failures / attempts × 100`（保留 4 位）；attempts = 0 时 null，不是 0。
    pub loss_pct: Option<f64>,
}

/// 一组探测计数（整链各段之和）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct LossSamples {
    pub attempts: i64,
    pub failures: i64,
}

/// 整体时间序列的一个点；空桶在数组里是 `null`。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SeriesPoint {
    pub ts: i64,
    pub p50: f64,
    pub p10: f64,
    pub p90: f64,
    pub samples: i64,
}

/// 一条链的聚合结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChainHealth {
    pub id: String,
    pub name: String,
    /// 链的组数（入口 + 中转 + 出口）。4 组 = 4 跳、3 个可测段。
    pub hops: i64,
    /// 存在多成员组（多路径），整体/逐段都是估算值。
    pub estimated: bool,
    /// 无法测量的跳：最后一跳（到链目标）的 seq 恒在其中；成员为空的组
    /// 造成的断点也会列进去。空数组只可能出现在没有任何组的脏数据上。
    pub missing_hops: Vec<i64>,
    /// 固定长度 = `hours * 3600 / bucket`；无样本桶是 `null`。
    pub series: Vec<Option<SeriesPoint>>,
    /// 逐段视图，按目标组 seq 升序。
    pub segments: Vec<SegmentView>,
    /// 整链丢包：各段独立连乘 `1 - Π(1 - loss_i)`（%）；没有可用段时 null。
    pub loss_pct: Option<f64>,
    /// 参与连乘的各段探测次数 / 失败次数之和；没有可用段时是 `{0, 0}`。
    pub loss_samples: LossSamples,
    /// 有段缺探测数据且另有段有数据时为 true：该段被跳过，整链
    /// `loss_pct` 只覆盖有数据的段。**全部段都没有探测数据时是 false**
    /// （此时整链 `loss_pct` 为 null，前端只显示「无探测数据」，不能同时
    /// 声称「部分跳缺少数据」）。
    pub loss_partial: bool,
    pub diagnosis: Diagnosis,
}

/// 跨链汇总。
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct Summary {
    /// 退化最严重那条链的当前整体 p50（整数毫秒）；没有可用数据时 null。
    pub hop_p50_ms: Option<i64>,
    /// 上述链当前整体 p50 相对 24h 基线的变化；没有配对数据时 null。
    pub delta_ms: Option<i64>,
    /// 较基线上升 ≥ [`SLOW_DELTA_MS`] 的链数。
    pub slow_chains: i64,
    /// 本次响应里的链数（筛选后）。
    pub total_chains: i64,
    /// 当前窗口 p50 最高的段；没有段数据时 null。
    pub worst_hop: Option<HopRef>,
    /// 当前可见链里最差的一条的整链丢包（%）；没有可用丢包数据时 null。
    pub loss_pct: Option<f64>,
    /// 上述最差丢包链；与 `loss_pct` 同源，没有数据时 null。
    pub worst_loss: Option<LossRef>,
}

/// 最差丢包链的位置。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LossRef {
    pub chain_id: String,
    pub chain_name: String,
    pub loss_pct: f64,
}

/// 最慢段的位置。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HopRef {
    pub chain_id: String,
    pub chain_name: String,
    pub seq: i64,
    pub p50_ms: i64,
}

/// 一次聚合的完整结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Aggregate {
    pub summary: Summary,
    pub chains: Vec<ChainHealth>,
    /// 本应映射到某段却失败的样本数：目标组多成员但 Agent 只上报了空目标、
    /// 链改过成员后的历史残留等。最后一跳到链目标的预期探测不计入，它由
    /// `missing_hops` 表达。
    pub unmapped_forwards: i64,
}

/// 样本查询的起点：覆盖请求的时间轴窗口与 24h 基线中更老的一侧。
///
/// 路由层用它算出 `since`，保证「一次取窗口样本」就够聚合，不再为基线
/// 单独查一次。
pub fn sample_window_start(now: i64, hours: i64, bucket: i64) -> i64 {
    if hours <= 0 || bucket <= 0 {
        return now;
    }
    let end = aligned_end(now, bucket);
    let series_start = end - hours * 3600;
    let current_count = current_bucket_count(hours, bucket);
    let current_start = end - current_count * bucket;
    let baseline_count = baseline_bucket_count(bucket);
    (series_start).min(current_start - baseline_count * bucket)
}

fn aligned_end(now: i64, bucket: i64) -> i64 {
    now - now.rem_euclid(bucket) + bucket
}

fn current_bucket_count(hours: i64, bucket: i64) -> i64 {
    let series_buckets = (hours * 3600 / bucket).max(1);
    (CURRENT_WINDOW_SECS / bucket).clamp(1, series_buckets)
}

fn baseline_bucket_count(bucket: i64) -> i64 {
    (BASELINE_WINDOW_SECS / bucket).max(1)
}

/// 当前值窗口的 `[start, end)`（与 `sample_window_start` 同一套对齐规则）。
///
/// 路由层用它给 `forward_probe_samples` 取数，保证丢包和 p50 用的是**同一个
/// 当前窗口**（最近 2h，请求窗口不足 2h 时退化为请求窗口）。
pub fn current_window(now: i64, hours: i64, bucket: i64) -> (i64, i64) {
    if hours <= 0 || bucket <= 0 {
        return (now, now);
    }
    let end = aligned_end(now, bucket);
    let current_count = current_bucket_count(hours, bucket);
    (end - current_count * bucket, end)
}

/// 纯内存聚合。`chains` 必须已经按 `server_ids` 筛选过；`samples` 是这些链
/// 所有成员的 `forward_latency_samples`（`ts >= sample_window_start`）；
/// `probes` 是同一批成员 forward 在 [`current_window`] 内的探测计数之和
/// （没有探测的 forward 不在 map 里，读作 attempts = 0）。
pub fn aggregate(
    chains: &[ChainWithGroups],
    samples: &[LatencySample],
    probes: &HashMap<String, ProbeCounts>,
    now: i64,
    hours: i64,
    bucket: i64,
) -> Aggregate {
    if bucket <= 0 || hours <= 0 {
        return Aggregate {
            summary: Summary {
                total_chains: chains.len() as i64,
                ..Summary::default()
            },
            chains: Vec::new(),
            unmapped_forwards: 0,
        };
    }

    let count = (hours * 3600 / bucket).max(1);
    let end = aligned_end(now, bucket);
    let series_start = end - count * bucket;
    let (current_start, _) = current_window(now, hours, bucket);
    let baseline_count = baseline_bucket_count(bucket);
    let baseline_start = current_start - baseline_count * bucket;
    let since = series_start.min(baseline_start);

    let layouts: Vec<Layout> = chains.iter().map(Layout::from_chain).collect();
    let mut forward_map: HashMap<String, (usize, usize, usize)> = HashMap::new();
    for (chain_index, layout) in layouts.iter().enumerate() {
        for (group_index, members) in layout.groups.iter().enumerate() {
            let seq = layout.group_seq[group_index];
            for (member_index, member) in members.iter().enumerate() {
                let forward_id =
                    crate::chains::forward_id(&layout.chain_id, seq, &member.id, members.len());
                forward_map
                    .entry(forward_id)
                    .or_insert((chain_index, group_index, member_index));
            }
        }
    }

    // (chain, segment) → 当前窗口探测计数。forward 是「每跳入口」的探测，
    // 这里把同一段所有成员（多路径）的计数相加；最后一跳（最后一组 → 链
    // 目标）没有下一组可归属，和时延样本一样忽略。
    let mut segment_probes: HashMap<(usize, usize), ProbeCounts> = HashMap::new();
    for (forward_id, counts) in probes {
        let Some(&(chain_index, group_index, _)) = forward_map.get(forward_id) else {
            continue;
        };
        let layout = &layouts[chain_index];
        if group_index + 1 >= layout.groups.len() {
            continue;
        }
        segment_probes
            .entry((chain_index, group_index))
            .or_default()
            .add(*counts);
    }

    // (chain, segment, bucket) → 原始延迟值；桶内再算分位数。
    let mut bucket_values: HashMap<(usize, usize, i64), Vec<f64>> = HashMap::new();
    // 当前窗口内 (源, 目标) 的样本数，用来给多路径段挑代表成员。
    let mut pair_counts: PairCounts = HashMap::new();
    let mut unmapped_forwards = 0_i64;

    for sample in samples {
        if sample.ts < since || sample.ts >= end {
            continue;
        }
        let Some(&(chain_index, group_index, member_index)) = forward_map.get(&sample.forward_id)
        else {
            unmapped_forwards += 1;
            continue;
        };
        let layout = &layouts[chain_index];
        let Some(source) = layout
            .groups
            .get(group_index)
            .and_then(|members| members.get(member_index))
        else {
            unmapped_forwards += 1;
            continue;
        };
        if source.id != sample.server_id {
            // forward_id 与上报的 server_id 不自洽（链被改过/脏数据）。
            unmapped_forwards += 1;
            continue;
        }
        let Some(target_members) = layout.groups.get(group_index + 1) else {
            // 最后一跳到链目标：这是**预期**的历史样本（Agent 探测链目标），
            // 没有「下一台服务器」可归属。它已经由 missing_hops 表达，不能
            // 算成 unmapped 异常，也不能伪装成 0ms。
            continue;
        };
        let target_id = if sample.target_server_id.is_empty() {
            // 单成员下一跳走兼容字段，Agent 拿不到 server_id；唯一成员可确定。
            if target_members.len() == 1 {
                target_members[0].id.clone()
            } else {
                unmapped_forwards += 1;
                continue;
            }
        } else {
            sample.target_server_id.clone()
        };
        if !target_members.iter().any(|member| member.id == target_id) {
            unmapped_forwards += 1;
            continue;
        }
        let bucket_ts = sample.ts.div_euclid(bucket) * bucket;
        // `since` 同时覆盖 series 与基线里更老的一侧：hours > 26 时基线在
        // 时间轴内部，不能把基线之前的 series 桶误丢。
        if bucket_ts < since {
            continue;
        }
        bucket_values
            .entry((chain_index, group_index, bucket_ts))
            .or_default()
            .push(sample.latency_ms as f64);
        if bucket_ts >= current_start {
            pair_counts
                .entry((chain_index, group_index))
                .or_default()
                .entry((source.id.clone(), target_id))
                .and_modify(|count| *count += 1)
                .or_insert(1);
        }
    }

    // 桶内分位数只算一次，序列/当前/基线三条路径共用。
    let mut stats: HashMap<(usize, usize, i64), BucketStats> = HashMap::new();
    for ((chain_index, segment_index, ts), mut values) in bucket_values {
        values.sort_by(|a, b| a.total_cmp(b));
        stats.insert(
            (chain_index, segment_index, ts),
            BucketStats {
                p10: percentile(&values, 0.10),
                p50: percentile(&values, 0.50),
                p90: percentile(&values, 0.90),
                samples: values.len() as i64,
            },
        );
    }

    let mut views = Vec::with_capacity(chains.len());
    for (chain_index, layout) in layouts.iter().enumerate() {
        let segment_count = layout.hops.saturating_sub(1).max(0) as usize;

        // 时间轴：固定长度，空桶 null。
        let mut series = Vec::with_capacity(count as usize);
        for index in 0..count {
            let ts = series_start + index * bucket;
            let mut total = StatsAccumulator::default();
            let mut complete = segment_count > 0;
            for segment_index in 0..segment_count {
                match stats.get(&(chain_index, segment_index, ts)) {
                    Some(bucket_stats) => total.add(bucket_stats),
                    None => {
                        complete = false;
                        break;
                    }
                }
            }
            series.push(complete.then(|| total.into_point(ts)));
        }

        // 当前窗口（最近 2h）与基线窗口（此前 24h）：逐桶 p50，再取中位数。
        let current = window_segment_p50s(
            &stats,
            chain_index,
            segment_count,
            current_start,
            end,
            bucket,
        );
        let baseline = window_segment_p50s(
            &stats,
            chain_index,
            segment_count,
            baseline_start,
            current_start,
            bucket,
        );

        let mut segments = Vec::with_capacity(segment_count);
        let mut deltas = Vec::with_capacity(segment_count);
        let mut survival = 1.0_f64;
        let mut loss_samples = LossSamples::default();
        let mut loss_segments = 0_usize;
        let mut missing_segments = 0_usize;
        for segment_index in 0..segment_count {
            let current_p50 = current.segment_p50[segment_index];
            let baseline_p50 = baseline.segment_p50[segment_index];
            let delta = match (current_p50, baseline_p50) {
                (Some(current), Some(baseline)) => Some(current - baseline),
                _ => None,
            };
            deltas.push(delta);
            // 丢包只看当前窗口（与 p50 同窗口）。attempts = 0 是「没有探测」，
            // 必须保持 null：补 0 会被读成 0% 丢包。
            let counts = segment_probes
                .get(&(chain_index, segment_index))
                .copied()
                .unwrap_or_default();
            let loss = (counts.attempts > 0)
                .then(|| (counts.failures.max(0) as f64 / counts.attempts as f64).clamp(0.0, 1.0));
            match loss {
                Some(loss) => {
                    survival *= 1.0 - loss;
                    loss_segments += 1;
                    loss_samples.attempts = loss_samples.attempts.saturating_add(counts.attempts);
                    loss_samples.failures = loss_samples.failures.saturating_add(counts.failures);
                }
                None => missing_segments += 1,
            }
            let (from, to) = layout.representative(chain_index, segment_index, &pair_counts);
            segments.push(SegmentView {
                seq: layout.segment_seq[segment_index],
                from,
                to,
                p50: current_p50.map(round1),
                delta_ms: delta.map(round1),
                contribution_pct: 0,
                attempts: counts.attempts,
                failures: counts.failures,
                loss_pct: loss.map(|loss| round4(loss * 100.0)),
            });
        }
        // 各跳独立：整链 = 1 - Π(1 - loss_i)。缺数据的段已跳过，不能把
        // 「不知道」当成 0 后声称整链完好。
        // partial 只在「有的段有数据、有的段没有」时为 true；全链都没有
        // 探测时 loss_pct 本身就是 null，再标 partial 会自相矛盾。
        let loss_partial = loss_segments > 0 && missing_segments > 0;
        let chain_loss_pct = (loss_segments > 0).then(|| round4((1.0 - survival) * 100.0));

        // 正向增量占比：分母只算「变慢」的段。
        let total_positive: f64 = deltas
            .iter()
            .filter_map(|delta| *delta)
            .filter(|delta| *delta > 0.0)
            .sum();
        for (segment, delta) in segments.iter_mut().zip(deltas.iter()) {
            segment.contribution_pct = match delta {
                Some(delta) if *delta > 0.0 && total_positive > 0.0 => {
                    (delta / total_positive * 100.0).round() as i64
                }
                _ => 0,
            };
        }

        let current_overall = median(&current.overall);
        let baseline_overall = median(&baseline.overall);
        let diagnosis = diagnose(&segments, current_overall, baseline_overall);

        views.push(ChainViewBuild {
            view: ChainHealth {
                id: layout.chain_id.clone(),
                name: layout.chain_name.clone(),
                hops: layout.hops,
                estimated: layout.estimated,
                missing_hops: layout.missing_hops.clone(),
                series,
                segments,
                loss_pct: chain_loss_pct,
                loss_samples,
                loss_partial,
                diagnosis,
            },
            current_overall,
            baseline_overall,
        });
    }

    let summary = summarize(&views);
    Aggregate {
        summary,
        chains: views.into_iter().map(|build| build.view).collect(),
        unmapped_forwards,
    }
}

/// (链, 段) → (源成员, 目标成员) → 当前窗口样本数。
type PairCounts = HashMap<(usize, usize), HashMap<(String, String), i64>>;

struct ChainViewBuild {
    view: ChainHealth,
    current_overall: Option<f64>,
    baseline_overall: Option<f64>,
}

/// 一条链的拓扑在内存里的展开形态。
struct Layout {
    chain_id: String,
    chain_name: String,
    hops: i64,
    estimated: bool,
    missing_hops: Vec<i64>,
    /// 每组在链里的 `seq`，与 `groups` 下标一一对应。
    group_seq: Vec<i64>,
    /// 每组排好序的成员（priority, server_id）。
    groups: Vec<Vec<Member>>,
    /// 段编号：目标组 seq。
    segment_seq: Vec<i64>,
    /// 无样本时的 from/to 兜底。
    segment_from: Vec<String>,
    segment_to: Vec<String>,
}

#[derive(Debug, Clone)]
struct Member {
    id: String,
    name: String,
}

impl Layout {
    fn from_chain(chain: &ChainWithGroups) -> Self {
        let mut groups: Vec<&ChainGroupWithMembers> = chain.groups.iter().collect();
        groups.sort_by_key(|group| group.group.seq);
        let group_seq: Vec<i64> = groups.iter().map(|group| group.group.seq).collect();
        let members: Vec<Vec<Member>> = groups
            .iter()
            .map(|group| {
                let mut members: Vec<&ChainGroupMember> = group.members.iter().collect();
                // 仓储已经按 (priority, rowid) 排好；这里用 (priority, server_id)
                // 再兜一次，让测试构造的乱序输入也有确定结果。
                members.sort_by_key(|member| (member.priority, member.server_id.clone()));
                members
                    .into_iter()
                    .map(|member| Member {
                        id: member.server_id.clone(),
                        name: member.server_name.clone(),
                    })
                    .collect()
            })
            .collect();
        let estimated = members.iter().any(|group| group.len() > 1);
        let hops = groups.len() as i64;

        let mut missing_hops = Vec::new();
        for index in 0..groups.len().saturating_sub(1) {
            if members[index].is_empty() || members[index + 1].is_empty() {
                missing_hops.push(group_seq[index + 1]);
            }
        }
        if let Some(last) = group_seq.last() {
            // 最后一组 → 链目标没有历史样本；seq 用「下一跳」的编号。
            missing_hops.push(last + 1);
        }
        missing_hops.sort_unstable();
        missing_hops.dedup();

        let segment_count = groups.len().saturating_sub(1);
        let mut segment_seq = Vec::with_capacity(segment_count);
        let mut segment_from = Vec::with_capacity(segment_count);
        let mut segment_to = Vec::with_capacity(segment_count);
        for index in 0..segment_count {
            segment_seq.push(group_seq[index + 1]);
            segment_from.push(members[index].first().map_or_else(
                || groups[index].group.name.clone().unwrap_or_default(),
                |member| member.name.clone(),
            ));
            segment_to.push(members[index + 1].first().map_or_else(
                || groups[index + 1].group.name.clone().unwrap_or_default(),
                |member| member.name.clone(),
            ));
        }

        Self {
            chain_id: chain.chain.id.clone(),
            chain_name: chain.chain.name.clone(),
            hops,
            estimated,
            missing_hops,
            group_seq,
            groups: members,
            segment_seq,
            segment_from,
            segment_to,
        }
    }

    /// 当前窗口样本最多的 (源, 目标) 成员对；没有当前样本时退回每组第一台。
    fn representative(
        &self,
        chain_index: usize,
        segment_index: usize,
        pair_counts: &PairCounts,
    ) -> (String, String) {
        let best = pair_counts
            .get(&(chain_index, segment_index))
            .and_then(|pairs| {
                pairs.iter().fold(
                    None::<(&String, &String, i64)>,
                    |best, (pair, count)| match best {
                        Some((best_from, best_to, best_count))
                            if *count < best_count
                                || (*count == best_count
                                    && pair >= &(best_from.clone(), best_to.clone())) =>
                        {
                            Some((best_from, best_to, best_count))
                        }
                        _ => Some((&pair.0, &pair.1, *count)),
                    },
                )
            });
        match best {
            Some((from, to, _)) => (
                self.name_of(from)
                    .map_or_else(|| self.segment_from[segment_index].clone(), str::to_string),
                self.name_of(to)
                    .map_or_else(|| self.segment_to[segment_index].clone(), str::to_string),
            ),
            None => (
                self.segment_from[segment_index].clone(),
                self.segment_to[segment_index].clone(),
            ),
        }
    }

    /// 成员 server_id → 展示名；只在本链内查，跨链同名/同 id 不串。
    fn name_of(&self, server_id: &str) -> Option<&str> {
        self.groups
            .iter()
            .flatten()
            .find(|member| member.id == server_id)
            .map(|member| member.name.as_str())
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct BucketStats {
    p10: f64,
    p50: f64,
    p90: f64,
    samples: i64,
}

#[derive(Default)]
struct StatsAccumulator {
    p10: f64,
    p50: f64,
    p90: f64,
    samples: i64,
}

impl StatsAccumulator {
    fn add(&mut self, stats: &BucketStats) {
        self.p10 += stats.p10;
        self.p50 += stats.p50;
        self.p90 += stats.p90;
        self.samples += stats.samples;
    }

    fn into_point(self, ts: i64) -> SeriesPoint {
        SeriesPoint {
            ts,
            p50: round1(self.p50),
            p10: round1(self.p10),
            p90: round1(self.p90),
            samples: self.samples,
        }
    }
}

#[derive(Default)]
struct WindowStats {
    /// 每段在窗口内各桶 p50 的列表（用于取中位数）。
    segment_p50: Vec<Option<f64>>,
    /// 窗口内「各段都齐全」的桶的整体 p50。
    overall: Vec<f64>,
}

fn window_segment_p50s(
    stats: &HashMap<(usize, usize, i64), BucketStats>,
    chain_index: usize,
    segment_count: usize,
    start: i64,
    end: i64,
    bucket: i64,
) -> WindowStats {
    let mut result = WindowStats {
        segment_p50: vec![None; segment_count],
        overall: Vec::new(),
    };
    if segment_count == 0 || end <= start || bucket <= 0 {
        return result;
    }
    let mut per_segment: Vec<Vec<f64>> = vec![Vec::new(); segment_count];
    let mut overall = Vec::new();
    let mut ts = start;
    while ts < end {
        let mut total = 0.0;
        let mut complete = true;
        for (segment_index, values) in per_segment.iter_mut().enumerate() {
            match stats.get(&(chain_index, segment_index, ts)) {
                Some(bucket_stats) => {
                    values.push(bucket_stats.p50);
                    total += bucket_stats.p50;
                }
                None => {
                    complete = false;
                    break;
                }
            }
        }
        if complete {
            overall.push(total);
        }
        ts += bucket;
    }
    result.segment_p50 = per_segment
        .into_iter()
        .map(|values| median(&values))
        .collect();
    result.overall = overall;
    result
}

fn diagnose(
    segments: &[SegmentView],
    current_overall: Option<f64>,
    baseline_overall: Option<f64>,
) -> Diagnosis {
    let (Some(current), Some(baseline)) = (current_overall, baseline_overall) else {
        return Diagnosis::unknown();
    };
    if segments.is_empty() || current - baseline <= 0.0 {
        return Diagnosis::unknown();
    }
    let top = segments
        .iter()
        .filter(|segment| segment.p50.is_some())
        .max_by(|a, b| {
            a.contribution_pct
                .cmp(&b.contribution_pct)
                .then_with(|| b.seq.cmp(&a.seq))
        });
    match top {
        Some(segment) if segment.contribution_pct as f64 >= SINGLE_HOP_CONTRIBUTION_PCT => {
            Diagnosis {
                kind: "single_hop",
                seq: Some(segment.seq),
            }
        }
        _ => Diagnosis {
            kind: "overall",
            seq: None,
        },
    }
}

fn summarize(views: &[ChainViewBuild]) -> Summary {
    // 顶部数字聚焦**退化最严重的链**，而不是所有链的中位数：一条链 +25ms
    // 的另一条 +0ms 时，中位数永远是 0，headline 会看不到事故。这里取
    // 「正向 delta 最大」的链；都没有基线时退回「当前整体最大」；再按 id
    // 兜底，保证同一份数据每次选同一条。`worst_hop` 仍是所有链里最慢的段。
    let focus = views
        .iter()
        .filter(|build| build.current_overall.is_some())
        .max_by(|a, b| {
            let a_delta = a
                .baseline_overall
                .map(|baseline| a.current_overall.unwrap_or(baseline) - baseline);
            let b_delta = b
                .baseline_overall
                .map(|baseline| b.current_overall.unwrap_or(baseline) - baseline);
            a_delta
                .unwrap_or(f64::NEG_INFINITY)
                .total_cmp(&b_delta.unwrap_or(f64::NEG_INFINITY))
                .then_with(|| {
                    a.current_overall
                        .unwrap_or_default()
                        .total_cmp(&b.current_overall.unwrap_or_default())
                })
                .then_with(|| b.view.id.cmp(&a.view.id))
        });

    let delta_ms = focus.and_then(
        |build| match (build.current_overall, build.baseline_overall) {
            (Some(current), Some(baseline)) => Some((current - baseline).round() as i64),
            _ => None,
        },
    );
    let slow_chains = views
        .iter()
        .filter(
            |build| match (build.current_overall, build.baseline_overall) {
                (Some(current), Some(baseline)) => current - baseline >= SLOW_DELTA_MS,
                _ => false,
            },
        )
        .count() as i64;

    let mut worst: Option<HopRef> = None;
    for build in views {
        for segment in &build.view.segments {
            let Some(p50) = segment.p50 else {
                continue;
            };
            let candidate = HopRef {
                chain_id: build.view.id.clone(),
                chain_name: build.view.name.clone(),
                seq: segment.seq,
                p50_ms: p50.round() as i64,
            };
            let replace = worst.as_ref().is_none_or(|current| {
                p50 > current.p50_ms as f64
                    || (p50 == current.p50_ms as f64
                        && (&candidate.chain_id, candidate.seq) < (&current.chain_id, current.seq))
            });
            if replace {
                worst = Some(candidate);
            }
        }
    }

    let mut worst_loss: Option<LossRef> = None;
    for build in views {
        let Some(loss_pct) = build.view.loss_pct else {
            continue;
        };
        let candidate = LossRef {
            chain_id: build.view.id.clone(),
            chain_name: build.view.name.clone(),
            loss_pct,
        };
        let replace = worst_loss.as_ref().is_none_or(|current| {
            loss_pct > current.loss_pct
                || (loss_pct == current.loss_pct && candidate.chain_id < current.chain_id)
        });
        if replace {
            worst_loss = Some(candidate);
        }
    }
    let loss_pct = worst_loss.as_ref().map(|worst| worst.loss_pct);

    Summary {
        hop_p50_ms: focus
            .and_then(|build| build.current_overall)
            .map(|value| value.round() as i64),
        delta_ms,
        slow_chains,
        total_chains: views.len() as i64,
        worst_hop: worst,
        loss_pct,
        worst_loss,
    }
}

fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    Some(percentile(&sorted, 0.5))
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let rank = p.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    if lower == upper {
        sorted[lower]
    } else {
        sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower as f64)
    }
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// 丢包百分比保留 4 位小数：2/240 = 0.8333%，两段各 1% = 1.99%。
fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Chain, ChainGroup, ChainGroupWithMembers};

    const BUCKET: i64 = 900;
    const NOW: i64 = 1_800_000_000;

    fn member(
        chain_id: &str,
        group_id: &str,
        seq: i64,
        server_id: &str,
        server_name: &str,
        listen_port: i64,
        priority: i64,
    ) -> ChainGroupMember {
        ChainGroupMember {
            group_id: group_id.into(),
            chain_id: chain_id.into(),
            seq,
            strategy: "round_robin".into(),
            server_id: server_id.into(),
            server_name: server_name.into(),
            server_address: format!("10.0.0.{listen_port}"),
            server_internal_address: None,
            listen_port,
            priority,
            weight: 1,
            realm_transport: None,
            nftables_available: None,
            tunnel_available: None,
            server_protocol_version: None,
            last_seen_at: None,
        }
    }

    /// 构造一条链：`groups` 是 `(seq, [(server_id, name)])`。
    fn chain(id: &str, groups: Vec<(i64, Vec<(&str, &str)>)>) -> ChainWithGroups {
        let chain = Chain {
            id: id.into(),
            name: format!("chain-{id}"),
            target_host: "target".into(),
            target_port: 443,
            enabled: true,
            engine: "native".into(),
            udp: false,
            protocol: "tcp".into(),
            proxy_protocol: false,
            transport: "none".into(),
            tunnel_security: "tls".into(),
            template_id: None,
            owner_user_id: None,
            created_at: 1,
            updated_at: 1,
        };
        let groups = groups
            .into_iter()
            .map(|(seq, members)| {
                let group_id = format!("{id}-g{seq}");
                let group = ChainGroup {
                    id: group_id.clone(),
                    chain_id: id.into(),
                    seq,
                    name: None,
                    strategy: "round_robin".into(),
                    cert_id: None,
                    public_port: None,
                    use_internal_address: false,
                };
                let members = members
                    .into_iter()
                    .enumerate()
                    .map(|(index, (server_id, name))| {
                        member(
                            id,
                            &group_id,
                            seq,
                            server_id,
                            name,
                            10_000 + index as i64,
                            index as i64,
                        )
                    })
                    .collect();
                ChainGroupWithMembers { group, members }
            })
            .collect();
        ChainWithGroups { chain, groups }
    }

    fn sample(
        ts: i64,
        server_id: &str,
        forward_id: String,
        target_server_id: &str,
        latency_ms: i64,
    ) -> LatencySample {
        LatencySample {
            ts,
            server_id: server_id.into(),
            forward_id,
            target_server_id: target_server_id.into(),
            latency_ms,
        }
    }

    fn end_at(now: i64, bucket: i64) -> i64 {
        now - now.rem_euclid(bucket) + bucket
    }

    fn forward(chain_id: &str, seq: i64, server_id: &str, member_count: usize) -> String {
        crate::chains::forward_id(chain_id, seq, server_id, member_count)
    }

    /// 没有探测数据：丢包逐段为 null、整链 null，且不标 `loss_partial`。
    fn no_probes() -> HashMap<String, ProbeCounts> {
        HashMap::new()
    }

    /// 按 `(forward_id, attempts, failures)` 构造当前窗口的探测计数。
    fn probes(entries: &[(String, i64, i64)]) -> HashMap<String, ProbeCounts> {
        entries
            .iter()
            .map(|(forward_id, attempts, failures)| {
                (
                    forward_id.clone(),
                    ProbeCounts {
                        attempts: *attempts,
                        failures: *failures,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn maps_adjacent_groups_and_sums_the_same_bucket() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "香港-01")]),
                (1, vec![("b", "东京-01")]),
                (2, vec![("c", "大阪-01")]),
            ],
        );
        let end = end_at(NOW, BUCKET);
        let ts = end - 60;
        let samples = vec![
            // 单成员下一跳走兼容字段：target_server_id 为空，按唯一成员补回。
            sample(ts, "a", forward("c1", 0, "a", 1), "", 14),
            sample(ts, "b", forward("c1", 1, "b", 1), "", 56),
            // 最后一跳到链目标：没有下一台服务器，不能进任何段。
            sample(ts, "c", forward("c1", 2, "c", 1), "", 5),
        ];

        let aggregate = aggregate(&[chain], &samples, &no_probes(), NOW, 1, BUCKET);
        assert_eq!(
            aggregate.unmapped_forwards, 0,
            "最后一跳到链目标是预期样本，由 missing_hops 表达"
        );
        let view = &aggregate.chains[0];
        assert_eq!(view.hops, 3);
        assert_eq!(view.missing_hops, vec![3], "最后一跳必须声明为缺失");
        assert_eq!(
            view.segments.iter().map(|s| s.seq).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(view.segments[0].from, "香港-01");
        assert_eq!(view.segments[0].to, "东京-01");
        assert_eq!(view.segments[0].p50, Some(14.0));
        assert_eq!(view.segments[1].p50, Some(56.0));
        assert!(!view.estimated);

        let last = view.series.last().unwrap().as_ref().unwrap();
        assert_eq!(last.p50, 70.0, "整体 = 同一桶各段 p50 之和");
        assert_eq!(last.p10, 70.0);
        assert_eq!(last.p90, 70.0);
        assert_eq!(last.samples, 2, "最后一跳的目标样本不能混进 samples");
        assert!(view.series[0].is_none(), "没有样本的桶必须是 null");
        assert_eq!(view.diagnosis.kind, "unknown", "没有基线时不能编诊断");
        assert_eq!(aggregate.summary.total_chains, 1);
        assert_eq!(aggregate.summary.hop_p50_ms, Some(70));
        assert_eq!(aggregate.summary.delta_ms, None);
    }

    #[test]
    fn empty_target_on_a_multi_member_next_group_is_unmapped() {
        let chain = chain(
            "c1",
            vec![(0, vec![("a", "A")]), (1, vec![("b1", "B1"), ("b2", "B2")])],
        );
        let ts = end_at(NOW, BUCKET) - 60;
        let samples = vec![sample(ts, "a", forward("c1", 0, "a", 1), "", 10)];
        let aggregate = aggregate(&[chain], &samples, &no_probes(), NOW, 1, BUCKET);
        assert_eq!(aggregate.unmapped_forwards, 1);
        assert!(aggregate.chains[0].series.last().unwrap().is_none());
        assert!(aggregate.chains[0].segments[0].p50.is_none());
    }

    #[test]
    fn a_stale_target_is_counted_as_unmapped_instead_of_being_dropped_silently() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let ts = end_at(NOW, BUCKET) - 60;
        // 目标不在下一组里（链改过成员后的历史样本）：必须进 warnings。
        let samples = vec![sample(ts, "a", forward("c1", 0, "a", 1), "ghost", 10)];
        let aggregate = aggregate(&[chain], &samples, &no_probes(), NOW, 1, BUCKET);
        assert_eq!(aggregate.unmapped_forwards, 1);
        assert!(aggregate.chains[0].series.last().unwrap().is_none());
    }

    #[test]
    fn multi_member_group_is_estimated_and_uses_the_median_path() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b1", "B1"), ("b2", "B2")]),
                (2, vec![("c", "C")]),
            ],
        );
        let ts = end_at(NOW, BUCKET) - 60;
        let samples = vec![
            // 入口组单成员：forward id 走兼容格式，目标用真实 server_id。
            sample(ts, "a", forward("c1", 0, "a", 1), "b1", 10),
            sample(ts, "a", forward("c1", 0, "a", 1), "b2", 20),
            // 中转组多成员：forward id 带 server_id；下一组单成员 → 空目标。
            sample(ts, "b1", forward("c1", 1, "b1", 2), "", 30),
            sample(ts, "b2", forward("c1", 1, "b2", 2), "", 50),
        ];
        let aggregate = aggregate(&[chain], &samples, &no_probes(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert!(view.estimated, "多成员组必须标注估算");
        assert_eq!(view.segments[0].p50, Some(15.0), "10/20 的中位数");
        assert_eq!(view.segments[1].p50, Some(40.0), "30/50 的中位数");
        assert_eq!(
            view.series.last().unwrap().as_ref().unwrap().p50,
            55.0,
            "多路径按段中位数求和"
        );
        assert_eq!(view.segments[1].from, "B1", "同票时按 server id 稳定选择");
    }

    #[test]
    fn chains_without_samples_keep_null_series_and_unknown_diagnosis() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.hops, 2);
        assert_eq!(view.missing_hops, vec![2]);
        assert_eq!(view.segments.len(), 1);
        assert!(view.segments[0].p50.is_none());
        assert!(view.segments[0].delta_ms.is_none());
        assert_eq!(view.segments[0].contribution_pct, 0);
        assert!(view.series.iter().all(Option::is_none));
        assert_eq!(view.diagnosis.kind, "unknown");
        assert_eq!(aggregate.summary.hop_p50_ms, None);
        assert_eq!(aggregate.summary.delta_ms, None);
        assert_eq!(aggregate.summary.slow_chains, 0);
        assert_eq!(aggregate.summary.worst_hop, None);
    }

    #[test]
    fn a_single_group_chain_has_no_segments_and_no_fake_zero() {
        let chain = chain("c1", vec![(0, vec![("a", "A")])]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.hops, 1);
        assert_eq!(view.missing_hops, vec![1]);
        assert!(view.segments.is_empty());
        assert!(view.series.iter().all(Option::is_none));
        assert_eq!(view.diagnosis.kind, "unknown");
    }

    #[test]
    fn groups_without_members_are_reported_as_missing_instead_of_panicking() {
        let chain = chain("c1", vec![(0, vec![]), (1, vec![])]);
        let aggregate = aggregate(&[chain], &[], &no_probes(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.hops, 2);
        assert_eq!(view.missing_hops, vec![1, 2]);
        assert_eq!(view.segments.len(), 1);
        assert!(view.segments[0].p50.is_none());
        assert!(view.series.iter().all(Option::is_none));
    }

    /// 在 `[start, end)` 的每个桶里放一条样本；`latency` 是 `(桶序号, 值)`。
    fn per_bucket_samples(
        chain_id: &str,
        server_id: &str,
        seq: i64,
        target: &str,
        start: i64,
        end: i64,
        latency: impl Fn(i64) -> i64,
    ) -> Vec<LatencySample> {
        let mut samples = Vec::new();
        let mut ts = start;
        while ts < end {
            samples.push(sample(
                ts + 60,
                server_id,
                forward(chain_id, seq, server_id, 1),
                target,
                latency(ts),
            ));
            ts += BUCKET;
        }
        samples
    }

    #[test]
    fn a_single_segment_slowdown_is_diagnosed_as_single_hop() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
            ],
        );
        let end = end_at(NOW, BUCKET);
        let current_start = end - 2 * 3600;
        let baseline_start = current_start - 24 * 3600;
        let mut samples = Vec::new();
        // 第 1 段全程 20ms；第 2 段基线 30ms、最近 2h 55ms。
        samples.extend(per_bucket_samples(
            "c1",
            "a",
            0,
            "",
            baseline_start,
            end,
            |_| 20,
        ));
        samples.extend(per_bucket_samples(
            "c1",
            "b",
            1,
            "",
            baseline_start,
            current_start,
            |_| 30,
        ));
        samples.extend(per_bucket_samples(
            "c1",
            "b",
            1,
            "",
            current_start,
            end,
            |_| 55,
        ));

        let aggregate = aggregate(&[chain], &samples, &no_probes(), NOW, 24, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].p50, Some(20.0));
        assert_eq!(view.segments[1].p50, Some(55.0));
        assert_eq!(view.segments[1].delta_ms, Some(25.0));
        assert_eq!(view.segments[1].contribution_pct, 100);
        assert_eq!(view.segments[0].contribution_pct, 0);
        assert_eq!(view.diagnosis.kind, "single_hop");
        assert_eq!(view.diagnosis.seq, Some(2));
        assert_eq!(aggregate.summary.hop_p50_ms, Some(75), "20 + 55");
        assert_eq!(aggregate.summary.delta_ms, Some(25));
        assert_eq!(aggregate.summary.slow_chains, 1);
        assert_eq!(
            aggregate.summary.worst_hop.as_ref().map(|hop| hop.seq),
            Some(2)
        );
    }

    #[test]
    fn an_even_slowdown_is_diagnosed_as_overall() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
            ],
        );
        let end = end_at(NOW, BUCKET);
        let current_start = end - 2 * 3600;
        let baseline_start = current_start - 24 * 3600;
        let mut samples = Vec::new();
        for (server, seq) in [("a", 0), ("b", 1)] {
            samples.extend(per_bucket_samples(
                "c1",
                server,
                seq,
                "",
                baseline_start,
                current_start,
                |_| 30,
            ));
            samples.extend(per_bucket_samples(
                "c1",
                server,
                seq,
                "",
                current_start,
                end,
                |_| 40,
            ));
        }

        let aggregate = aggregate(&[chain], &samples, &no_probes(), NOW, 24, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].contribution_pct, 50);
        assert_eq!(view.segments[1].contribution_pct, 50);
        assert_eq!(view.diagnosis.kind, "overall");
        assert_eq!(view.diagnosis.seq, None);
        assert_eq!(aggregate.summary.delta_ms, Some(20));
    }

    #[test]
    fn a_long_series_keeps_buckets_older_than_the_baseline_window() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let end = end_at(NOW, BUCKET);
        // 30h 前：比 24h 基线更老，但仍在 48h 的 series 窗口里。
        let ts = end - 30 * 3600;
        let samples = vec![sample(ts, "a", forward("c1", 0, "a", 1), "", 20)];
        let aggregate = aggregate(&[chain], &samples, &no_probes(), NOW, 48, BUCKET);
        let view = &aggregate.chains[0];
        let index = ((ts - (end - 48 * 3600)) / BUCKET) as usize;
        assert!(
            view.series[index].is_some(),
            "48h 时间轴里 30h 前的桶不能被基线过滤丢掉"
        );
        assert_eq!(view.series[index].as_ref().unwrap().p50, 20.0);
        assert!(
            view.segments[0].p50.is_none(),
            "30h 前的样本不属于最近 2h 当前窗口"
        );
    }

    #[test]
    fn a_partial_bucket_does_not_get_summed_as_zero() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
            ],
        );
        let ts = end_at(NOW, BUCKET) - 60;
        // 只有第 1 段有样本：整体桶必须 null，第 1 段自己仍然有 p50。
        let samples = vec![sample(ts, "a", forward("c1", 0, "a", 1), "", 20)];
        let aggregate = aggregate(&[chain], &samples, &no_probes(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].p50, Some(20.0));
        assert!(view.segments[1].p50.is_none());
        assert!(view.series.last().unwrap().is_none());
    }

    #[test]
    fn zero_attempts_is_null_not_a_zero_loss() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        // 计数行存在但 attempts = 0（差分被丢弃等）：必须当作「没有探测」。
        let probes = probes(&[(forward("c1", 0, "a", 1), 0, 0)]);
        let aggregate = aggregate(&[chain], &[], &probes, NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].attempts, 0);
        assert_eq!(view.segments[0].failures, 0);
        assert_eq!(
            view.segments[0].loss_pct, None,
            "attempts=0 必须是 null 而不是 0"
        );
        assert_eq!(view.loss_pct, None, "没有可用段时整链丢包也是 null");
        assert_eq!(view.loss_samples, LossSamples::default());
        assert!(
            !view.loss_partial,
            "全链都没有探测数据时不能标 partial（否则与「无探测数据」矛盾）"
        );
        assert_eq!(aggregate.summary.loss_pct, None);
        assert!(aggregate.summary.worst_loss.is_none());
    }

    #[test]
    fn a_segment_loss_is_failures_over_attempts() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let probes = probes(&[(forward("c1", 0, "a", 1), 240, 2)]);
        let aggregate = aggregate(&[chain], &[], &probes, NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].attempts, 240);
        assert_eq!(view.segments[0].failures, 2);
        assert_eq!(view.segments[0].loss_pct, Some(0.8333), "2/240 = 0.8333%");
        assert_eq!(view.loss_pct, Some(0.8333), "只有一段时整链等于该段");
        assert_eq!(
            view.loss_samples,
            LossSamples {
                attempts: 240,
                failures: 2
            }
        );
        assert!(!view.loss_partial);
        assert_eq!(aggregate.summary.loss_pct, Some(0.8333));
        assert_eq!(
            aggregate
                .summary
                .worst_loss
                .as_ref()
                .map(|worst| worst.chain_id.as_str()),
            Some("c1")
        );
    }

    #[test]
    fn chain_loss_compounds_independent_hops() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
            ],
        );
        // 两段各 1%：1 - 0.99² = 1.99%，不是 2%。
        let probes = probes(&[
            (forward("c1", 0, "a", 1), 100, 1),
            (forward("c1", 1, "b", 1), 100, 1),
        ]);
        let aggregate = aggregate(&[chain], &[], &probes, NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].loss_pct, Some(1.0));
        assert_eq!(view.segments[1].loss_pct, Some(1.0));
        assert_eq!(view.loss_pct, Some(1.99));
        assert_eq!(
            view.loss_samples,
            LossSamples {
                attempts: 200,
                failures: 2
            }
        );
        assert!(!view.loss_partial);
        assert_eq!(aggregate.summary.loss_pct, Some(1.99));
    }

    #[test]
    fn a_missing_segment_is_skipped_and_flags_partial() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
            ],
        );
        // 只有第 1 段有探测：算法只能覆盖已知段，不能把第 2 段当 0%。
        let probes = probes(&[(forward("c1", 0, "a", 1), 100, 1)]);
        let aggregate = aggregate(&[chain], &[], &probes, NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].loss_pct, Some(1.0));
        assert_eq!(view.segments[1].loss_pct, None);
        assert_eq!(view.loss_pct, Some(1.0), "缺的段跳过，不补 0");
        assert!(view.loss_partial);
        assert_eq!(
            view.loss_samples,
            LossSamples {
                attempts: 100,
                failures: 1
            }
        );
    }

    #[test]
    fn all_missing_probes_are_null_and_not_partial() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
                (3, vec![("d", "D")]),
            ],
        );
        // 整链三段都没有探测：这是「无数据」，不是「部分跳缺数据」。
        let aggregate = aggregate(&[chain], &[], &no_probes(), NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments.len(), 3);
        assert!(view
            .segments
            .iter()
            .all(|segment| segment.loss_pct.is_none()));
        assert_eq!(view.loss_pct, None);
        assert_eq!(view.loss_samples, LossSamples::default());
        assert!(
            !view.loss_partial,
            "全部段都缺探测时 loss_partial 必须是 false"
        );
        assert_eq!(aggregate.summary.loss_pct, None);
        assert!(aggregate.summary.worst_loss.is_none());
    }

    #[test]
    fn two_probed_segments_and_one_missing_stay_partial() {
        let chain = chain(
            "c1",
            vec![
                (0, vec![("a", "A")]),
                (1, vec![("b", "B")]),
                (2, vec![("c", "C")]),
                (3, vec![("d", "D")]),
            ],
        );
        // 两段有数据（各 1%）、一段没有 → 连乘 1.99%，并标 partial。
        let probes = probes(&[
            (forward("c1", 0, "a", 1), 100, 1),
            (forward("c1", 1, "b", 1), 100, 1),
        ]);
        let aggregate = aggregate(&[chain], &[], &probes, NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].loss_pct, Some(1.0));
        assert_eq!(view.segments[1].loss_pct, Some(1.0));
        assert_eq!(view.segments[2].loss_pct, None);
        assert_eq!(view.loss_pct, Some(1.99));
        assert!(view.loss_partial, "部分段有数据、部分没有时必须是 true");
        assert_eq!(
            view.loss_samples,
            LossSamples {
                attempts: 200,
                failures: 2
            }
        );
    }

    #[test]
    fn the_last_hop_probe_is_not_attributed_to_a_segment() {
        let chain = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        // 最后一组的 forward 探测的是链目标，没有「下一组」，不能算进第 1 段。
        let probes = probes(&[(forward("c1", 1, "b", 1), 240, 240)]);
        let aggregate = aggregate(&[chain], &[], &probes, NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].attempts, 0);
        assert_eq!(view.segments[0].loss_pct, None);
        assert_eq!(view.loss_pct, None);
        assert!(!view.loss_partial, "整链无数据时不能标 partial");
    }

    #[test]
    fn a_multi_member_segment_sums_probe_counts_before_dividing() {
        let chain = chain(
            "c1",
            vec![(0, vec![("a1", "A1"), ("a2", "A2")]), (1, vec![("b", "B")])],
        );
        // 不能对两个成员的失败率取平均：必须先把计数相加。
        let probes = probes(&[
            (forward("c1", 0, "a1", 2), 100, 0),
            (forward("c1", 0, "a2", 2), 100, 10),
        ]);
        let aggregate = aggregate(&[chain], &[], &probes, NOW, 1, BUCKET);
        let view = &aggregate.chains[0];
        assert_eq!(view.segments[0].attempts, 200);
        assert_eq!(view.segments[0].failures, 10);
        assert_eq!(view.segments[0].loss_pct, Some(5.0));
        assert_eq!(view.loss_pct, Some(5.0));
    }

    #[test]
    fn the_summary_reports_the_worst_visible_chain() {
        let a = chain("c1", vec![(0, vec![("a", "A")]), (1, vec![("b", "B")])]);
        let b = chain("c2", vec![(0, vec![("c", "C")]), (1, vec![("d", "D")])]);
        let probes = probes(&[
            (forward("c1", 0, "a", 1), 100, 50),
            (forward("c2", 0, "c", 1), 100, 1),
        ]);
        let aggregate = aggregate(&[a, b], &[], &probes, NOW, 1, BUCKET);
        assert_eq!(aggregate.chains[0].loss_pct, Some(50.0));
        assert_eq!(aggregate.chains[1].loss_pct, Some(1.0));
        assert_eq!(aggregate.summary.loss_pct, Some(50.0));
        let worst = aggregate.summary.worst_loss.unwrap();
        assert_eq!(worst.chain_id, "c1");
        assert_eq!(worst.chain_name, "chain-c1");
        assert_eq!(worst.loss_pct, 50.0);
    }
}
