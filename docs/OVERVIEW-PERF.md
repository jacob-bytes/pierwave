# 概览接口性能：日汇总 + TTL 短缓存（p50 831.6 → 2.6 ms；带后台写入 4.5 ms）

> 本轮只涉及 `crates/{domain,master}`、`scripts/` 与 `docs/`；迁移只追加
> `0066_traffic_rollup.sql`，没有改历史迁移或响应 JSON 形状。
>
> English follows the Chinese section.

## 1. 目标与测量方法

- 数据：`scripts/bench-overview.sh` 造 10,001 用户、1,000 节点、10 台服务器、
  20 个套餐、30 天 `traffic_daily`（300,030 行）、30 天
  `traffic_node_daily`（30,000 行）、2,880 条服务器采样，然后 `ANALYZE`。
- 查询：`GET /api/v1/overview?days=7`；预热 3 次，nearest-rank 取 p50 / p95。
  静态场景重复 20 次；带后台写入场景重复 50 次、请求间隔 250ms（跨过 12s TTL）。
- 构建：debug（与 `make check` / `make e2e` 一致）。debug 版 SQLite 的绝对
  耗时偏高，但前后使用同一构建，趋势可比。
- 机器为共享开发机，p50 抖动约 ±5–10%。

复跑：

```bash
./scripts/bench-overview.sh                 # 缓存开启（默认 12s TTL）
CACHE=0 ./scripts/bench-overview.sh         # 关闭缓存，测日汇总冷成本
WRITE_EVERY_MS=200 INTERVAL_MS=250 REPEAT=50 ./scripts/bench-overview.sh
                                            # 后台每 200ms 写 + 每 250ms 请求，跨 TTL
PLAN=1 ./scripts/bench-overview.sh          # 额外打印 EXPLAIN QUERY PLAN
REPEAT=50 ./scripts/bench-overview.sh       # 更多轮次
```

## 2. 前后基准

| 场景 | 数据量 | p50 | p95 | 说明 |
|---|---|---:|---:|---|
| 优化前 | 1 万用户 / 1000 节点 / 30 天 | **831.6 ms** | 847.3 ms | `scripts/bench-api.sh`，原始表聚合 |
| 优化后（默认缓存，无并发写） | 同上 | **2.6 ms** | 3.1 ms | 命中 12s 短缓存；20/20 次 `X-Overview-Cache: hit` |
| 优化后（**后台每 200ms 写一次**，50 次请求 / 250ms 间隔） | 同上 | **4.5 ms** | 6.5 ms | 49/50 命中；1 次正常 TTL 重建，max 113.2 ms |
| 优化后（`CACHE=0` + 后台写入） | 同上 | 112.3 ms | 114.0 ms | 只读日汇总，无缓存 |
| 优化后（`CACHE=0`，静态数据冷查询） | 同上 | 124.3 ms | 134.1 ms | 只读日汇总，无缓存；首次冷请求 112.5 ms |

`bench-api.sh` 同轮其它接口：`stats/overview` 343.1 → 7.4 ms、`stats/traffic`
506.0 → 1.0 ms（见第 7 节）、`stats/nodes` 116.8 ms、`users` 7.8 ms、
`audit` 1.5 ms。

验收目标「p50 ≤ 100 ms（debug）」在默认配置下余量很大；即使**后台每 200ms
持续写入**，TTL 缓存下 p50 仍为 4.5 ms（仅 TTL 正常过期时出现一次 ~113ms 的
重建）。关掉缓存后，静态冷查询 124.3 ms、带写入 112.3 ms，仍比 831.6 ms 快
约 7×。

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
- 每次写入 `traffic_rollup_meta.generation += 1`（仅诊断/测试用；
  缓存不再以它作 key，见第 6 节）；
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

- `generation(pool)`：读代际；仅用于诊断/测试，不参与缓存 key；
- `is_consistent(pool)`：把原始表与汇总表的 `uplink/downlink/weighted` 总和
  逐项比较（`server`、`subject`、`node`、`legacy` 四个 scope）；
- `rebuild(pool)`：事务内从两张原始账本全量重建，成功后代际 +1（诊断用）；
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
   的结果；连续两次 `rebuild` 结果相同。

`ensure_backfilled` 在主控 `main` 中于 `Db::migrate()` 之后调用一次；老库升级、
备份恢复、或绕过触发器批量导入后都会自动补齐。

## 6. 缓存策略与失效点（TTL 语义）

`crates/master/src/state.rs` 的 `OverviewTrafficCache`：

- 只缓存**流量派生**的 `TrafficSnapshot`（趋势、协议、Top 用户/节点/套餐、
  KPI 流量）；Top 服务器与网速采样每次现算，保持在线状态实时；
- **key 只有 `days`**，默认 TTL 12 秒（`PIERWAVE_OVERVIEW_CACHE_SECS` 可覆盖，
  `0` 关闭）；
- **计费入账不参与缓存 key，也不主动清缓存**。生产里 Agent 持续上报，如果按
  `generation` 作为 key（或每次写入都 `clear()`），缓存会几乎永远 miss；
- `put()` 用同一 `days` 覆盖旧条目；
- `clear()` 保留给管理员动作：`POST /api/v1/backup/restore` 落位待恢复文件后
  会调用一次，避免重启前看到旧流量；常规 `record_traffic` 不再调用；
- 响应带 `Vary: Cookie`（管理员专属；`/api/` 本身还有 `Cache-Control:
  no-store`）与 `X-Overview-Cache: hit|miss` 便于排障；
- 非流量部分（节点/服务器计数、链路健康、24h 可用率）不进缓存，新建节点或
  链路状态变化立刻可见。

### 6.1 持续写入场景实测

测试 `overview_cache_holds_up_under_continuous_billing_writes`：

- 后台每 200ms 写一次 `traffic_daily` + `traffic_node_daily`，同时连续请求
  概览 50 次（每次间隔 250ms，整体跨过 12s TTL）；
- 测试期间后台实际写入 **63 次**；
- 旧策略（`(days, generation)` key，使用同一份 lookup 逻辑）：**0/50 命中**，
  命中率 0%，证明生产里“每秒都有写入 → 缓存永远 miss”的问题真实存在；
- 新策略（`days` + TTL）：**48/50 命中（96%）**，唯一的 miss 是 12 秒 TTL
  正常过期后的重建。

带后台写入的基准（`REPEAT=50 INTERVAL_MS=250 WRITE_EVERY_MS=200`）：

| 场景 | p50 | p95 | max | 缓存头 |
|---|---:|---:|---:|---|
| TTL 缓存 + 每 200ms 写入 | **4.5 ms** | 6.5 ms | 113.2 ms | hit 49 / miss 1 |
| 关闭缓存 + 每 200ms 写入 | 112.3 ms | 114.0 ms | 114.2 ms | miss 50 |

**语义边界**：缓存是 TTL 语义，不是强一致。流量数字（KPI、趋势、Top）
最多陈旧 **12 秒**；`traffic_daily`、计费扣费、订阅额度始终读原始账本/实例，
不受缓存影响。若管理员要求立即看到最新数字，可调用 `clear()`（目前恢复备份
路径已调用），或等待 TTL 过期。

缓存测试：

- `state::tests::overview_cache_is_keyed_by_days_and_expires_by_ttl`：命中 /
  days 不同 / 覆盖 / TTL 过期 / `clear()`；
- `state::tests::generation_keyed_lookup_misses_when_generation_changes`：锁定
  旧 `(days, generation)` lookup 的 miss 语义，防止误改回；
- `routes::overview::tests::overview_traffic_snapshot_is_ttl_cached_and_clear_invalidates_it`：
  第一次 miss、第二次 hit、TTL 内写入仍命中（允许旧数字）、`clear()` 后立刻
  重建、TTL 过期后重建、不同 `days` 重建；
- `routes::overview::tests::overview_cache_holds_up_under_continuous_billing_writes`：
  上述持续写入场景（0% vs 96%）；
- `state::tests::overview_cache_with_zero_ttl_never_hits`：环境变量 `0` 的禁用语义。

## 7. `/stats/*` 复用日汇总 / `/stats/*` reuses the rollup

`repo::stats::overview` 的今日/本月流量与 `repo::stats::traffic` 的日趋势改为读
`traffic_daily_rollup`：全局用 `scope='server'`（与 `/api/v1/overview` 的 KPI
同一份），单用户趋势用 `scope='subject'`。响应 JSON 形状完全不变；没有新增
缓存，只把读路径从「扫 30 天原始行」换成「扫服务器数 × 天数行」。

同一轮 `scripts/bench-api.sh`（10,001 用户 / 1,000 节点 / 300,030 行
`traffic_daily`，debug，30 轮）前后对比：

| 接口 | 优化前 p50 | 优化后 p50 | 加速 | 优化前 p95 | 优化后 p95 |
|---|---:|---:|---:|---:|---:|
| `GET /api/v1/stats/overview` | 343.06 ms | **7.41 ms** | 46.3× | 358.58 ms | 7.62 ms |
| `GET /api/v1/stats/traffic?days=30` | 506.00 ms | **0.97 ms** | 521.6× | 599.61 ms | 1.19 ms |

一致性测试 `repo::stats_rollup_tests::stats_read_model_matches_raw_ledger_for_at_least_three_days`
构造 3 天、两台服务器、两个用户的流量，逐日逐字段比较
`traffic_trend` / `traffic_trend_for_subject` / `overview.traffic` 与原始
`traffic_daily` 聚合，三者必须完全相等。

`repo::stats::overview` now reads today/month traffic from
`traffic_daily_rollup`, and `repo::stats::traffic` reads its daily trend from the
same table: global rows use `scope='server'` (the exact read model behind
`/api/v1/overview` KPI), per-subject rows use `scope='subject'`. The response
JSON shape is unchanged. No extra cache was added; the read path simply scans
`servers × days` rows instead of 30 days of raw ledger rows.

Same `scripts/bench-api.sh` run (10,001 users / 1,000 nodes / 300,030
`traffic_daily` rows, debug build, 30 rounds):

| Endpoint | Before p50 | After p50 | Speedup | Before p95 | After p95 |
|---|---:|---:|---:|---:|---:|
| `GET /api/v1/stats/overview` | 343.06 ms | **7.41 ms** | 46.3× | 358.58 ms | 7.62 ms |
| `GET /api/v1/stats/traffic?days=30` | 506.00 ms | **0.97 ms** | 521.6× | 599.61 ms | 1.19 ms |

The consistency test
`repo::stats_rollup_tests::stats_read_model_matches_raw_ledger_for_at_least_three_days`
seeds three days for two servers and two users, then compares
`traffic_trend` / `traffic_trend_for_subject` / `overview.traffic` field by field
against aggregates over the raw `traffic_daily` rows; they must match exactly.

## 8. 未做项与取舍

- 概览缓存是**进程内、TTL 语义**的；多实例部署时每个进程各自缓存，写入不会
  互相通知，最坏 12 秒陈旧。管理员动作（如恢复备份）只清当前进程的缓存，
  恢复本身需要重启，重启后所有实例都是空的。
- 写路径不主动清缓存；若要求“写完立刻可见”，需要管理员显式 `clear()` 或把
  轮询间隔调到大于 TTL。若运维直接改原始表并绕过触发器，需要等启动时的
  `ensure_backfilled` 或手动重启。
- 日汇总表新增约 33 万行（本基准），换来概览冷查询 6.8× 加速；写入侧每次
  upsert 多维护 2–3 行汇总与一次 meta 更新，由触发器在同一条语句内完成。

---

# Overview API performance: daily rollup + TTL cache (p50 831.6 → 2.6 ms; 4.5 ms under writes)

This round only touches `crates/{domain,master}`, `scripts/` and `docs/`; the
append-only migration `0066_traffic_rollup.sql` is added and the response JSON
shape is unchanged.

## Measurement

`scripts/bench-overview.sh` seeds 10,001 users, 1,000 nodes, 10 servers, 20
packages, 300,030 `traffic_daily` rows, 30,000 `traffic_node_daily` rows and
2,880 server samples, then runs `ANALYZE`. It measures
`GET /api/v1/overview?days=7` with 3 warmups, 20 repetitions for the static
case, and 50 repetitions spaced 250 ms apart for the background-write case
(crossing the 12 s TTL), reporting nearest-rank p50/p95 on a debug build. The
machine is shared, so expect ±5–10% jitter.

| Scenario | p50 | p95 | max |
|---|---:|---:|---:|
| Before (raw-table aggregation) | **831.6 ms** | 847.3 ms | — |
| After, default cache (no concurrent writes) | **2.6 ms** | 3.1 ms | 3.6 ms |
| After, **background write every 200 ms** (50 requests / 250 ms apart) | **4.5 ms** | 6.5 ms | 113.2 ms |
| After, `CACHE=0` + background writes | 112.3 ms | 114.0 ms | 114.2 ms |
| After, `CACHE=0` (rollup-only, cold) | 124.3 ms | 134.1 ms | — |

The ≤100 ms target is comfortably met with the default configuration, including
the background-write run (4.5 ms). With the cache disabled the cold query is
~7× faster than before.

## Migration

`traffic_daily_rollup(scope, day, key, uplink, downlink, weighted)` is a
`WITHOUT ROWID` table with `PRIMARY KEY (scope, day, key)`: a date window for
one scope is a contiguous clustered range, so the overview scans
`servers × days` rows instead of `users × days`. The `(scope, key, day)` index
serves per-server time windows. Scopes are `subject`, `server`, `node` and
`legacy`; `node`/`legacy` keys are `server_id \x1f node_tag`.

Triggers on `traffic_daily` and `traffic_node_daily` maintain the rollup in the
same statement, applying negative deltas on `UPDATE`/`DELETE`, and bump
`traffic_rollup_meta.generation` on every change (diagnostics/tests only; the
cache no longer keys on it). The migration backfills existing history once;
after that the triggers keep it current.

`repo::overview` is split into `traffic_snapshot()` (rollup-only: KPI traffic,
daily series, protocol attribution, Top users/nodes/packages) and `compose()`
(server and node counts, 24h uptime, protocol node counts, chain health, plus
the Top servers card with live status and rate samples). `snapshot()` remains
the uncached composition used by tests and internal callers.

## Consistency and backfill

`repo::traffic_rollup` provides `generation()` (diagnostics only),
`is_consistent()` (checks the three sums across the four scopes against the raw
ledgers), `rebuild()` (one transaction, idempotent) and `ensure_backfilled()`
(called from master startup; rebuilds once on mismatch and fails startup if the
second check still fails).

Tests cover five pseudo-random days compared field-by-field with direct raw
aggregation, the UTC+8 midnight boundary (`15:59:59Z` vs `16:00:00Z`), explicit
history `UPDATE`/`DELETE`, and idempotent rebuild/repair.

## Cache (TTL semantics)

`OverviewTrafficCache` stores only the traffic-derived snapshot (trend,
protocols, Top users/nodes/packages, KPI traffic). The key is **only `days`**;
the 12 s TTL (`PIERWAVE_OVERVIEW_CACHE_SECS`, `0` disables it) is the only
expiry mechanism. Billing writes neither enter the key nor call `clear()`:
production agents report continuously, so a `(days, generation)` key or a
clear-on-write would make the cache miss almost every time. `put()` overwrites
the entry for the same `days`. `clear()` remains for explicit admin actions;
the backup-restore handler calls it after staging a restore. The Top servers
card and rate samples are computed on every request to keep online state live.
Responses carry `Vary: Cookie` and `X-Overview-Cache: hit|miss`.

### Concurrent-write measurement

`overview_cache_holds_up_under_continuous_billing_writes` runs a background
writer every 200 ms while issuing 50 overview requests 250 ms apart (crossing
the 12 s TTL). With 63 background writes, the old `(days, generation)` lookup
hit **0/50 (0%)**, while the TTL-only strategy hit **48/50 (96%)**; the single
miss is a normal TTL refresh.

Benchmark with background writes (`REPEAT=50 INTERVAL_MS=250
WRITE_EVERY_MS=200`): p50 **4.5 ms**, p95 6.5 ms, max 113.2 ms (the one TTL
refresh). With the cache disabled and the same writes, p50 112.3 ms.

**Boundary**: the cache is TTL, not strongly consistent. Traffic numbers can be
up to **12 seconds stale**; the raw ledger, billing and package quota always
read the authoritative rows. Use `clear()` (or wait one TTL) when an immediate
refresh is required.

## Not done

- The cache is per process and TTL-based; multi-instance deployments do not
  coordinate invalidation and each may serve up to 12 s stale traffic. Admin
  restores restart the process, so all instances start with an empty cache.
- Direct raw-table edits that bypass the triggers need a restart (where
  `ensure_backfilled` repairs the rollup) or an explicit rebuild.
- The rollup adds ~330k rows in this benchmark and 2–3 row upserts plus one meta
  update per write, all inside the same statement. The generation counter is
  still maintained for diagnostics/tests but no longer drives cache keys.
