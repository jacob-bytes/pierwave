# 概览接口性能：日汇总 + 短缓存（p50 831.6 → 2.8 ms）

> 本轮只涉及 `crates/{domain,master}`、`scripts/` 与 `docs/`；迁移只追加
> `0066_traffic_rollup.sql`，没有改历史迁移或响应 JSON 形状。
>
> English follows the Chinese section.

## 1. 目标与测量方法

- 数据：`scripts/bench-overview.sh` 造 10,001 用户、1,000 节点、10 台服务器、
  20 个套餐、30 天 `traffic_daily`（300,030 行）、30 天
  `traffic_node_daily`（30,000 行）、2,880 条服务器采样，然后 `ANALYZE`。
- 查询：`GET /api/v1/overview?days=7`；预热 3 次，重复 20 次，nearest-rank
  取 p50 / p95。
- 构建：debug（与 `make check` / `make e2e` 一致）。debug 版 SQLite 的绝对
  耗时偏高，但前后使用同一构建，趋势可比。
- 机器为共享开发机，p50 抖动约 ±5–10%。

复跑：

```bash
./scripts/bench-overview.sh                 # 缓存开启（默认 12s TTL）
CACHE=0 ./scripts/bench-overview.sh         # 关闭缓存，测日汇总冷成本
PLAN=1 ./scripts/bench-overview.sh          # 额外打印 EXPLAIN QUERY PLAN
REPEAT=50 ./scripts/bench-overview.sh       # 更多轮次
```

## 2. 前后基准

| 场景 | 数据量 | p50 | p95 | 说明 |
|---|---|---:|---:|---|
| 优化前 | 1 万用户 / 1000 节点 / 30 天 | **831.6 ms** | 847.3 ms | `scripts/bench-api.sh`，原始表聚合 |
| 优化后（默认缓存） | 同上 | **2.8 ms** | 3.1 ms | 命中 12s 短缓存；20/20 次 `X-Overview-Cache: hit` |
| 优化后（`CACHE=0`，冷查询） | 同上 | 124.3 ms | 134.1 ms | 只读日汇总，无缓存；首次冷请求 112.5 ms |

`bench-api.sh` 同轮其它接口不受影响：`stats/overview` 349.6 ms、`stats/traffic`
513.5 ms、`stats/nodes` 137.9 ms、`users` 8.3 ms、`audit` 1.5 ms。

验收目标「p50 ≤ 100 ms（debug）」在默认配置下余量很大；即使关掉缓存，冷查询
也从 831.6 ms 降到约 124 ms（≈6.7×）。

## 3. 迁移 `0066_traffic_rollup.sql`

新增两张表，只追加，不改原始账本：

```sql
CREATE TABLE traffic_daily_rollup (
    scope    TEXT NOT NULL,              -- subject / server / node / legacy
    day      TEXT NOT NULL,              -- UTC+8 自然日
    key      TEXT NOT NULL,              -- node/legacy 为 server_id \x1f node_tag
    uplink   INTEGER NOT NULL DEFAULT 0,
    downlink INTEGER NOT NULL DEFAULT 0,
    weighted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, day, key)
) WITHOUT ROWID;

CREATE INDEX idx_traffic_daily_rollup_key_day
    ON traffic_daily_rollup (scope, key, day);

CREATE TABLE traffic_rollup_meta (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL DEFAULT 0,
    rebuilt_at INTEGER NOT NULL DEFAULT 0
);
```

主键顺序是 `(scope, day, key)`：概览的日窗口都带 `scope`，同一 scope 的日期
区间落在聚簇主键的一段连续区间里，扫描行数从「用户数 × 天数」降到
「服务器数 × 天数」。`(scope, key, day)` 索引服务 `top_servers` 的逐服务器
LEFT JOIN。

维护方式：**触发器与写入同一条语句**。

- `traffic_daily` 的 INSERT / UPDATE / DELETE 维护 `subject`、`server`、
  `legacy` 三个 scope；
- `traffic_node_daily` 的 INSERT / UPDATE / DELETE 维护 `node` scope；
- UPDATE / DELETE 用负增量，显式修正或删除历史流量也会同步；
- 每次写入 `traffic_rollup_meta.generation += 1`；
- 迁移内一次性回填历史数据，之后由触发器增量维护。

`legacy` scope 只收 `subject` 带 `@` 的历史行；协议归属查询用
`NOT EXISTS(node)` 判断是否存在节点切片，与原始表语义逐条对齐。节点切片被
删除且汇总归零时，DELETE 触发器会把对应的 `node` 汇总行一起删掉，避免
`NOT EXISTS` 误判。

## 4. 概览查询改造

`repo::overview` 拆成两层：

- `traffic_snapshot(pool, now, days)`：KPI 今日/本月、日趋势、协议归属与趋势、
  Top 用户/节点/套餐，全部只读 `traffic_daily_rollup`；
- `compose(pool, now, days, traffic)`：服务器/节点计数、24h 可用率、协议节点数、
  链路健康，以及带实时状态/网速采样的 Top 服务器，每次现算；
- `snapshot()` 仍是无缓存组合，保持测试和内部调用兼容。

`EXPLAIN QUERY PLAN`（`PLAN=1`）：

| 查询 | 计划 |
|---|---|
| KPI 今日/本月 | `SEARCH traffic_daily_rollup USING PRIMARY KEY (scope=? AND day>? AND day<?)` |
| 日趋势 | 同上 + `TEMP B-TREE FOR GROUP BY`（7 行） |
| 协议归属 | `SEARCH r USING PRIMARY KEY` + `SEARCH nodes USING UNIQUE(server_id,tag)` |
| Top 用户 | `SEARCH traffic_daily_rollup USING PRIMARY KEY`（subject scope）+ GROUP BY |
| Top 服务器 | `SEARCH t USING INDEX idx_traffic_daily_rollup_key_day` |

Top 用户/套餐共用 `user_traffic` CTE：早期版本在 `top_user` 分支又扫了一遍
原始日账本，实测占概览冷查询近一半。

## 5. 一致性与回填验证

`crates/domain/src/repo.rs` 的 `repo::traffic_rollup` 提供：

- `generation(pool)`：读代际，供缓存 key；
- `is_consistent(pool)`：把原始表与汇总表的 `uplink/downlink/weighted` 总和
  逐项比较（`server`、`subject`、`node`、`legacy` 四个 scope）；
- `rebuild(pool)`：事务内从两张原始账本全量重建，成功后代际 +1；
- `ensure_backfilled(pool)`：启动时校验，一致返回 `false`，不一致重建一次并
  再校验；仍不一致则让主控启动失败，避免长期展示错误账单。

单元测试（`repo::traffic_rollup::tests`）：

1. **5 个不同日期逐字段相等**（跨 10/11 月的固定伪随机日期）：`subject` / `server` / `node` / `legacy` 四个 scope
   的 `uplink/downlink/weighted` 与直接聚合原始表逐字段相等；
2. **跨日边界（UTC+8）**：`2026-11-21T15:59:59Z` 属于 11-21，
   `16:00:00Z` 属于 11-22，两天不串账；
3. **更新 / 删除历史流量**：显式 `UPDATE`、`DELETE` 原始行后，汇总用负增量
   跟上；节点汇总归零后行被删除；
4. **回填幂等**：人为破坏汇总 → `ensure_backfilled` 重建 → 逐行等于触发器维护
   的结果；连续两次 `rebuild` 结果相同，代际递增。

`ensure_backfilled` 在主控 `main` 中于 `Db::migrate()` 之后调用一次；老库升级、
备份恢复、或绕过触发器批量导入后都会自动补齐。

## 6. 缓存策略与失效点

`crates/master/src/state.rs` 的 `OverviewTrafficCache`：

- 只缓存**流量派生**的 `TrafficSnapshot`（趋势、协议、Top 用户/节点/套餐、
  KPI 流量）；Top 服务器与网速采样每次现算，保持在线状态实时；
- key = `(days, generation)`，默认 TTL 12 秒（`PIERWAVE_OVERVIEW_CACHE_SECS`
  可覆盖，`0` 关闭）；
- `generation` 由日汇总触发器在每次计费入账时 +1，因此写入后下一次请求一定
  miss，不需要遍历缓存；
- `put()` 会清掉旧代际条目，避免内存随写入增长；
- `routes/agent.rs` 在整份流量报告处理完后额外调用 `clear()`，作为显式失效；
- 响应带 `Vary: Cookie`（管理员专属；`/api/` 本身还有 `Cache-Control:
  no-store`）与 `X-Overview-Cache: hit|miss` 便于排障；
- 非流量部分（节点/服务器计数、链路健康、24h 可用率）不进缓存，新建节点或
  链路状态变化立刻可见。

缓存测试：

- `state::tests::overview_cache_hits_only_for_the_same_days_and_generation`：
  命中 / days 不同 / generation 不同 / TTL 过期 / clear / 旧代际清理；
- `overview_traffic_snapshot_is_cached_and_invalidated_by_writes`：第一次 miss、
  第二次 hit、写入流量后 miss 且 `kpi.traffic_today` 立刻更新、不同 `days` 重建；
- `overview_cache_with_zero_ttl_never_hits`：环境变量 `0` 的禁用语义。

## 7. 未做项与取舍

- `/api/v1/stats/traffic`、`/api/v1/stats/overview` 仍读原始 `traffic_daily`，
  本轮没有改（目标只要求概览）；它们可以直接复用同一张日汇总，是下一步的
  低风险优化。
- 概览缓存是**进程内**的；多实例部署时每个进程各自缓存，但 `generation` 来自
  数据库，所以写后最多 12 秒内各实例都会失效，不会出现长期旧值。
- 缓存对流量数字最多容忍 12 秒延迟；正常计费入账会通过代际立即失效。若运维
  直接改原始表并绕过触发器，需要等启动时的 `ensure_backfilled` 或手动重启。
- 日汇总表新增约 33 万行（本基准），换来概览冷查询 6.8× 加速；写入侧每次
  upsert 多维护 2–3 行汇总与一次 meta 更新，由触发器在同一条语句内完成。

---

# Overview API performance: daily rollup + short cache (p50 831.6 → 2.8 ms)

This round only touches `crates/{domain,master}`, `scripts/` and `docs/`; the
append-only migration `0066_traffic_rollup.sql` is added and the response JSON
shape is unchanged.

## Measurement

`scripts/bench-overview.sh` seeds 10,001 users, 1,000 nodes, 10 servers, 20
packages, 300,030 `traffic_daily` rows, 30,000 `traffic_node_daily` rows and
2,880 server samples, then runs `ANALYZE`. It measures
`GET /api/v1/overview?days=7` with 3 warmups and 20 repetitions on a debug
build, reporting nearest-rank p50/p95. The machine is shared, so expect ±5–10%
jitter.

| Scenario | p50 | p95 |
|---|---:|---:|
| Before (raw-table aggregation) | **831.6 ms** | 847.3 ms |
| After, default cache | **2.8 ms** | 3.1 ms |
| After, `CACHE=0` (rollup-only, cold) | 124.3 ms | 134.1 ms |

The ≤100 ms target is comfortably met with the default configuration; even with
the cache disabled the cold query is ~6.7× faster than before.

## Migration

`traffic_daily_rollup(scope, day, key, uplink, downlink, weighted)` is a
`WITHOUT ROWID` table with `PRIMARY KEY (scope, day, key)`: a date window for
one scope is a contiguous clustered range, so the overview scans
`servers × days` rows instead of `users × days`. The `(scope, key, day)` index
serves per-server time windows. Scopes are `subject`, `server`, `node` and
`legacy`; `node`/`legacy` keys are `server_id \x1f node_tag`.

Triggers on `traffic_daily` and `traffic_node_daily` maintain the rollup in the
same statement, applying negative deltas on `UPDATE`/`DELETE`, and bump
`traffic_rollup_meta.generation` on every change. The migration backfills
existing history once; after that the triggers keep it current.

`repo::overview` is split into `traffic_snapshot()` (rollup-only: KPI traffic,
daily series, protocol attribution, Top users/nodes/packages) and `compose()`
(server and node counts, 24h uptime, protocol node counts, chain health, plus
the Top servers card with live status and rate samples). `snapshot()` remains
the uncached composition used by tests and internal callers.

## Consistency and backfill

`repo::traffic_rollup` provides `generation()`, `is_consistent()` (checks the
three sums across the four scopes against the raw ledgers), `rebuild()` (one
transaction, idempotent, bumps generation) and `ensure_backfilled()` (called
from master startup; rebuilds once on mismatch and fails startup if the second
check still fails).

Tests cover five pseudo-random days compared field-by-field with direct raw
aggregation, the UTC+8 midnight boundary (`15:59:59Z` vs `16:00:00Z`), explicit
history `UPDATE`/`DELETE`, and idempotent rebuild/repair.

## Cache

`OverviewTrafficCache` stores only the traffic-derived snapshot (trend,
protocols, Top users/nodes/packages, KPI traffic), keyed by `(days, generation)`
with a 12 s TTL (`PIERWAVE_OVERVIEW_CACHE_SECS`, `0` disables it). The Top
servers card and rate samples are computed on every request to keep online
state live. Because the rollup triggers bump `generation` on every billing
write, the next request misses and sees fresh numbers without walking the
cache; `put()` drops older generations, and `routes/agent.rs` also calls
`clear()` after a traffic report. Responses carry `Vary: Cookie` and
`X-Overview-Cache: hit|miss`. Non-traffic cards are never cached, so node and
chain changes appear immediately.

## Not done

- `/api/v1/stats/traffic` and `/api/v1/stats/overview` still read the raw
  ledger; they can reuse this rollup in a follow-up.
- The cache is per process; multi-instance deployments share invalidation
  through the database `generation`, with at most a 12 s staleness window.
- Direct raw-table edits that bypass the triggers need a restart (where
  `ensure_backfilled` repairs the rollup) or an explicit rebuild.
- The rollup adds ~330k rows in this benchmark and 2–3 row upserts plus one meta
  update per write, all inside the same statement.
