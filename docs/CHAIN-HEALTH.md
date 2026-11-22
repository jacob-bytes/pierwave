# 链路时延聚合（`/api/v1/overview/chain-health`）

> English follows the Chinese sections.

## 1. 接口

```
GET /api/v1/overview/chain-health?hours=24&bucket=900[&server_ids=...]
```

仅管理员（`require_admin`；未登录 401，普通用户 403）。`hours` 1..=168
（默认 24），`bucket` 300..=86400、必须是 300 的整数倍且能整除
`hours*3600`（默认 900）；非法参数返回 400，错误码
`query.chain_health_hours_invalid` / `query.chain_health_bucket_invalid`。

响应：

```jsonc
{
  "generated_at": 1795321276, "hours": 24, "bucket": 900,
  "summary": {
    "hop_p50_ms": 96, "delta_ms": 25, "slow_chains": 1, "total_chains": 3,
    "worst_hop": { "chain_id": "…", "chain_name": "港日中转链", "seq": 3, "p50_ms": 58 }
  },
  "chains": [{
    "id": "…", "name": "港日中转链", "hops": 4,
    "estimated": false,
    "missing_hops": [4],
    "series": [ { "ts": 1795312800, "p50": 71, "p10": 69, "p90": 74, "samples": 9 }, null ],
    "segments": [
      { "seq": 1, "from": "香港-01", "to": "东京-01",
        "p50": 16.0, "delta_ms": 0.0, "contribution_pct": 0 },
      { "seq": 3, "from": "新加坡-01", "to": "大阪-01",
        "p50": 58.0, "delta_ms": 25.0, "contribution_pct": 100 }
    ],
    "diagnosis": { "kind": "single_hop", "seq": 3 }
  }],
  "scope": { "server_ids": [], "servers_matched": 0, "filtered": false },
  "warnings": { "unknown_ids": [], "unmapped_forwards": 0 }
}
```

`series` 固定长度 = `hours*3600/bucket`，从旧到新；没有样本的桶是 `null`，
不是 0。`segments[].p50` / `delta_ms` 无数据时同样是 `null`。

## 2. 跳的映射

链的**组**才是「跳」：`hops = chain_groups` 的行数。4 组 = 4 跳、3 个
「组与组之间」的可测段 + 最后 1 跳（最后一组 → 链目标）。

- 第 N 组 → 第 N+1 组是一段，`segments[].seq` 取**目标组**的 `seq`
  （正常链是 1..hops-1）；
- 样本条件：`server_id ∈ group[N].members` 且
  `target_server_id ∈ group[N+1].members`；
- 旧 Agent 对单成员下一跳走兼容字段，`target_server_id` 是空串；主控按
  「下一组唯一成员」补回。多成员下一组必须带真实 `server_id`，空目标无法
  判断走了哪条路径，计入 `warnings.unmapped_forwards`；
- 最后一跳到链目标没有「下一台服务器」，历史样本不能归到任何段：它的
  seq = 最后一组 seq + 1，写进 `missing_hops`，**绝不补 0**。如果中间某组
  没有成员，相邻段也写进 `missing_hops`；
- 多成员组（多路径）：段内取所有成员样本的中位数，链级 `estimated: true`。
  整体 = 各段中位数之和，是估算值，不是某一条真实路径的端到端 RTT。

`warnings.unmapped_forwards` 只统计「本应映射到某段却失败」的样本：多成员
目标却上报空目标、链改过成员后的历史残留等。最后一跳到链目标的探测是
预期数据，由 `missing_hops` 表达，不计入这个警告。

## 3. 时间窗口与基线（选择说明）

- `series`：最近 `hours` 小时，按 `bucket` 对齐；
- **当前值**：最近 **2 小时**（`CURRENT_WINDOW_SECS`）的桶中位数；
- **基线**：当前窗口之前的 **24 小时**（`BASELINE_WINDOW_SECS`）的桶中位数。

为什么不是「最近 24h vs 前 24h」：文档里的造数形态是「某段最近 2 小时
+25ms」。24 小时中位数里 2 小时只占 1/12，p50 几乎不动，诊断会得到
`unknown`，headline 也看不到事故。因此当前值取最近 2h（足以过滤单桶抖动，
又能完整覆盖 2h 的短时劣化），基线仍取 24h（稳定、覆盖一天的潮汐）。
`hours`/`bucket` 只影响 `series` 与当前/基线的桶宽；顶部数字不随
`hours` 改变（窗口不足 2h 时当前窗口退化为请求窗口）。

`summary` 聚焦**退化最严重的链**：优先取正向 delta 最大的链（同 delta 取
当前整体更大、再按 id 稳定排序），`hop_p50_ms` = 该链当前整体 p50，
`delta_ms` = 该链当前整体 p50 - 基线整体 p50。这样一条链 +25ms、其它链
+0ms 时，headline 是 +25ms 而不是中位数 0。`worst_hop` 仍是所有链里当前
p50 最高的段。

## 4. 整体与诊断

- 同一个桶里：整体 p50 = 各段 p50 之和；p10/p90 同样按段求和（近似带，
  不是统计分位数）；任一段缺样本则该桶整体为 `null`，不能把未知当 0；
- 每段 `delta_ms` = 当前 p50 - 基线 p50；
- `contribution_pct` = 该段正向增量 / 所有段正向增量之和 × 100（四舍五入
  整数）。只把「变慢」的段放进分母，所以下行的段贡献是 0；
- `diagnosis.kind`：
  - 当前/基线整体缺任一 → `unknown`（样本不足）；
  - 整体 delta ≤ 0 → `unknown`（稳定/变快；契约只有三种 kind，不新增
    `stable`）；
  - 某段 `contribution_pct ≥ 80` → `single_hop`，`seq` 是主导段；
  - 其余整体上升 → `overall`。
- `summary.slow_chains`：整体 delta ≥ 8ms 的链数。8ms 是跨公网一跳的
  常见抖动上限，也与设计稿「稳定 = 没有超过 8ms 的变化」一致。

## 5. 筛选

`server_ids` 与 `/api/v1/overview`、`/overview/server-health` 完全同语义：

- 接受逗号分隔与重复参数，合并后 UUID 归一化、去重、升序；
- 不传 = 全部链；`?server_ids=`（空数组）= 空结果，不是全站；
- 未知 id 忽略并进 `warnings.unknown_ids`；非法 id 400
  （`query.server_ids_invalid`）；去重后上限 200
  （`query.server_ids_too_many`）；
- 保留「至少一个成员落在选中服务器」的链；链内的段仍完整返回，不改写；
  `summary` 只按保留的链重算；`scope.server_ids` 是命中库的 id，
  `servers_matched` 是台数，`filtered` 表示请求是否带参数（空数组也算 true）。

## 6. 性能与查询计划

查询次数固定，与链数/成员数无关：

1. `chains`：`SELECT * FROM chains ORDER BY created_at ASC, rowid ASC`；
2. `chain_groups`：全部组一次读出；
3. `chain_group_members` JOIN `servers`：全部成员一次读出；
4. `forward_latency_samples`：所有成员 forward id 一次 `IN (...)`，时间下界
   覆盖 `series` 与 24h 基线中更老的一侧。

在 `data/preview.db`（迁移建库、不跑 `ANALYZE`）上实测：

```
-- 链列表
SCAN chains USING INDEX idx_chains_created

-- 某条链的组
SEARCH chain_groups USING INDEX idx_chain_groups_chain (chain_id=?)

-- 某条链的成员
SEARCH g USING INDEX idx_chain_groups_chain (chain_id=?)
SEARCH m USING INDEX sqlite_autoindex_chain_group_members_1 (group_id=?)
SEARCH s USING INDEX sqlite_autoindex_servers_1 (id=?)
USE TEMP B-TREE FOR RIGHT PART OF ORDER BY

-- 时延样本（5 个 forward id）
SEARCH forward_latency_samples USING INDEX idx_forward_latency_samples_forward_ts (forward_id=? AND ts>?)
USE TEMP B-TREE FOR ORDER BY
```

没有 `SCAN forward_latency_samples` 全表扫描；`IN (...)` 对每个 forward id
各做一次 `(forward_id, ts)` 区间探测。`ORDER BY` 的临时 B 树只排序本窗口
命中的行，不是全表。`EXPLAIN QUERY PLAN` 的完整输出在
`crates/domain/tests/query_plan.rs` 的回归里也以同样 SQL 形状锁定。

结果缓存 30 秒（`crates/master/src/state.rs::ChainHealthCache`），key =
`(hours, bucket, 规范化后的请求 server_ids)`；命中的 + 未知的 id 都进 key，
因为 `scope` / `warnings` 和 body 一起缓存。响应头
`X-Chain-Health-Cache: hit|miss`。`None`（不筛选）与 `Some([])`（空集）
是不同 key。缓存是 TTL 语义：最多陈旧 30 秒，不写穿透。

## 7. 造数

`scripts/seed-preview.sh` 现在额外写入：

- 3 条链、9 个组、10 个成员（`chain_groups` 不再为空）：
  - 港日中转链：香港-01 → 东京-01 → 新加坡-01 → 大阪-01（4 组 / 3 段）；
  - 港新直达链：香港-02 → 新加坡-02（2 组 / 1 段）；
  - 港日多路径：香港-01 →（东京-01 / 东京-02）→ 大阪-01（中间组两台，
    `estimated: true`）；
- 最近 24h、每 5 分钟一条的 `forward_latency_samples`（2384 条）：
  - 港日中转链第 3 段最近 2h +25ms，其余段持平 → `single_hop`、贡献 100%；
  - 每条链最后一跳到目标的样本也有写入，用来验证不会混进段、且不计入
    `unmapped_forwards`；
  - 多路径链的入口组上报两个真实 `target_server_id`，中转组两台各自上报。

重复执行幂等：固定 id + 先删后插；只写 `data/preview.db`，不碰
`data/pierwave.db`。

## 8. 测试

- 领域层（`crates/domain/src/chain_health.rs`）：单跳、多跳、多路径估算、
  缺最后一跳、空样本、无成员链、部分桶不补 0、单段变慢的
  `contribution_pct` / `diagnosis`、整体均匀变慢；
- 路由层（`crates/master/src/routes/chain_health.rs`）：单跳/多跳映射、
  最后一跳不伪装 0、筛选（命中/未知/空数组/非法/201 个 id）、非法
  `hours`/`bucket`、缓存 key 隔离、非管理员 401/403；
- 缓存层（`crates/master/src/state.rs`）：`(hours, bucket, 筛选)` 三维
  key 隔离、TTL、禁用。

## 9. 未做

- 不新增表/迁移：现有 `forward_latency_samples` + 链组映射足够；最后一跳到
  目标仍没有可靠历史，只声明 `missing_hops`；
- 不提供逐段的完整时间序列（契约只要求段级 p50/delta/贡献；热力图若需要
  逐段序列，需要再扩字段）；
- 多路径按「段中位数求和」估算，不做按实际选路权重的加权；
- 不做跨进程缓存失效（30 秒 TTL，单进程）；
- 不改 `web/`、`agent/`、`proto/`。

---

## English

`GET /api/v1/overview/chain-health?hours=24&bucket=900[&server_ids=...]`
(admin only). `hours` is 1..=168 (default 24); `bucket` is 300..=86400, a
multiple of 300 that divides `hours*3600` (default 900). Invalid values return
400 with code `query.chain_health_hours_invalid` or
`query.chain_health_bucket_invalid`.

`hops` is the number of `chain_groups` rows. A chain with 4 groups has 3
measurable inter-group segments plus a final hop to the chain target. Segment
`seq` is the destination group's `seq`. A sample belongs to segment N when its
`server_id` is in group N and its `target_server_id` is in group N+1. Legacy
single-target probes report an empty `target_server_id`; it is resolved to the
only member of the next group. A multi-member next group with an empty target
cannot be attributed and is counted in `warnings.unmapped_forwards`. The final
hop to the chain target has no reliable history: its seq (last group seq + 1)
is listed in `missing_hops` and never replaced with 0. Multi-member groups make
`estimated` true; segment values are medians and the overall value is the sum
of those medians, not a real end-to-end path RTT.

Time windows: `series` covers the last `hours`; the current value uses the last
2 hours of bucket medians and the baseline uses the 24 hours before that. The
2-hour current window is deliberate: a 2-hour incident is only 1/12 of a 24-hour
median and would be invisible, while 2 hours still filters single-bucket noise.
The summary focuses on the most degraded chain (largest positive delta, then
largest current, then id), so one chain at +25ms is not hidden by a median of
zero. `worst_hop` is the highest current segment p50 across chains.

Within a bucket, overall p50/p10/p90 are sums of the segment values; a bucket
with any missing segment is `null`. Per-segment `delta_ms` is current minus
baseline. `contribution_pct` is the segment's positive delta divided by the sum
of all positive deltas. `diagnosis.kind` is `unknown` when data is insufficient
or the overall delta is ≤ 0, `single_hop` when one segment contributes at least
80%, and `overall` otherwise. `slow_chains` counts chains with an overall delta
of at least 8ms.

`server_ids` uses exactly the same semantics as `/api/v1/overview`: absent means
all chains, an empty array means an empty result, unknown ids are ignored and
reported, invalid ids return 400, the deduplicated cap is 200, and only chains
with at least one selected member are kept. `summary` is recomputed over the
kept chains.

Performance: three topology queries (chains / groups / members) plus one
`forward_latency_samples` query with `forward_id IN (...)`; no N+1. On the
preview database `EXPLAIN QUERY PLAN` shows `idx_chains_created`,
`idx_chain_groups_chain`, the `(group_id)` primary-key lookup, and
`idx_forward_latency_samples_forward_ts (forward_id=? AND ts>?)`; there is no
full table scan of the samples table. The response is cached for 30 seconds in
`ChainHealthCache` keyed by `(hours, bucket, normalized request server_ids)`
(unknown ids included because `scope` / `warnings` are cached with the body),
with `X-Chain-Health-Cache: hit|miss`.

`scripts/seed-preview.sh` adds 3 chains / 9 groups / 10 members and 24 hours of
5-minute samples (2384 rows). The third segment of 港日中转链 is +25ms for the
last 2 hours, the other segments stay flat, and the final-hop samples are
present to prove they are neither summed nor counted as unmapped. The script is
idempotent and only writes `data/preview.db`.

Tests cover single-hop, multi-hop, multi-path estimation, missing final hop,
empty samples, chains without members, partial buckets, single-segment and
uniform slowdowns, filtering (hit/unknown/empty/invalid/201 ids), bad
`hours`/`bucket`, cache-key isolation, and 401/403. No migration is added; no
`web/`, `agent/` or `proto/` changes are made.
