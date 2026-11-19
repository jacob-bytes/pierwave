# 性能基线：索引、分页、概览 SQL 与限流（P1–P4）

> English follows the Chinese section.

本文记录 2026-11 这一轮「先测量、再优化」的结果，包含可复现的基准脚本
`scripts/bench-api.sh`、迁移 `0059_query_indexes.sql` 与回归测试
`crates/domain/tests/query_plan.rs`。改动只涉及 `crates/domain`、`crates/master`
与 `scripts/`。

## 测量方法

- 数据：`scripts/bench-api.sh` 内嵌造数 SQL，生成 10,001 用户、1,000 节点、
  10 台服务器、20 个套餐、30 天用户/节点/转发日账本（30 万 + 3 万 + 3 万行）、
  5 万条审计、1 万条会话；随后执行 `ANALYZE`。
- 接口：overview、stats/overview、stats/traffic、stats/nodes、nodes（全局 /
  深页 / 服务器内）、users、forward-traffic、audit。
- 每接口预热 3 次，重复 20–30 次，取 p50 / p95；单位毫秒。
- 构建为 **debug**（与 `make check` / `make e2e` 一致）。sqlx 自带的 SQLite
  在 debug 下是未优化的 C 代码，绝对耗时偏高，但前后使用同一构建，趋势可比。
- 机器为共享开发机，端到端数字有 ±5–10% 抖动；因此额外做了「同一份数据、
  同一份代码、仅开/关 0059 索引」的对照，以及直接用系统 sqlite3 的 SQL 计时。

复跑：

```bash
REPEAT=20 ./scripts/bench-api.sh            # 重建数据并跑一轮
NO_SEED=1 REPEAT=20 ./scripts/bench-api.sh  # 复用已有数据库
```

## P1：索引（迁移 0059）

只加实际查询用得到的组合。主键已经覆盖的组合不重复加：

| 查询 | 旧计划 | 索引 |
|---|---|---|
| `stats::subject_totals`（`WHERE subject = ?`） | `SEARCH ... (ANY(day) AND ANY(server_id) AND subject=?)` skip-scan | `traffic_daily(subject, day)` |
| `stats::traffic_trend_for_subject` | 同上 | 同上 |
| `overview::top_servers` 的 `LEFT JOIN traffic_daily` | 每台服务器重扫日期区间 | `traffic_daily(server_id, day)` |
| `stats::node_traffic?server_id=` | 按 `day` 区间扫描后过滤 | `traffic_node_daily(server_id, day)` |
| `audit::recent_logins` | `SCAN audit_log USING INDEX (created_at,id)` | `audit_log(actor_id, action, created_at, id)` |
| `sessions::purge_expired` | `SCAN sessions` | `sessions(expires_at)` |
| `users::list_with_query` 排序 | `SCAN users` + 临时排序 | `users(created_at)` |
| 服务器内节点分页 | `SEARCH UNIQUE(server_id,tag)` + 临时排序 | `nodes(server_id, created_at)` |

以下组合**已经**由主键/既有索引覆盖，因此没有新增：

- `traffic_daily(day, ...)`：主键前缀就是 `day`；
- `traffic_node_daily(day, server_id, node_tag)`：主键前缀；
- `forward_traffic_daily(day, forward_id)`：主键；按用户的 `(user_id, day)`
  在迁移 0045 已有；
- `server_samples(server_id, ts)`：主键；`ts` 另有迁移 0018 的索引；
- `sessions(user_id)`：迁移 0001 已有；
- `audit_log(created_at, id)`：迁移 0019 已有。

同一份数据、同一份代码，只开/关 0059 索引：

| 接口 | 无 0059 p50 | 有 0059 p50 | 变化 |
|---|---:|---:|---:|
| overview | 821.23 | 754.89 | −8% |
| stats/nodes | 137.72 | 131.81 | −4% |
| users | 21.31 | 7.52 | −65%（2.8×） |
| nodes（服务器内） | 2.54 | 2.38 | −6% |
| stats/traffic / forward-traffic / audit | 493.3 / 93.19 / 1.46 | 501.4 / 93.65 / 1.49 | 噪声内 |

直接 SQL 计时（系统 sqlite3，10 次均值，毫秒）：

| 查询 | 无索引 | 有索引 | 加速 |
|---|---:|---:|---:|
| subject_totals | 0.42 | 0.01 | 81× |
| subject_trend | 0.43 | 0.01 | 81× |
| top_servers | 66.06 | 37.20 | 1.78× |
| recent_logins | 5.79 | ≈0.002 | ≈2600× |
| users 首页 200 条 | 4.45 | 0.18 | 25× |
| nodes 服务器内列表 | 0.13 | 0.11 | 1.24× |
| node_traffic（按服务器筛选） | 1.87 | 0.87 | 2.15× |

写入代价：0059 的 7 个索引让基准库从 40.3 MB 涨到 65.0 MB（+61%）。两条日账本
的 upsert 每次多维护 2 个 / 1 个索引；这是为按用户、按服务器的时间窗查询付的
代价，索引按查询保留，没有「每列一个」。

## P2：节点列表与 total

`nodes::list_page` 原先每次请求 `SELECT * FROM nodes ORDER BY ...` 把整张表读进
内存，再在 Rust 里过滤 / 分页。`total` 直接取过滤后 `len()`，所以列表与 total
天然共用条件，不存在两条 SQL 条件分叉；代价是每页都读全部节点（含
`config_json`）。

本轮把能下推的条件放进 SQL：

- `server_id`、`protocol`、`enabled` → `WHERE`（索引可用）；
- `tag`（JSON 数组精确匹配）与 `region`（大小写不敏感）仍在内存；
- 分页仍是内存 `skip/take`，SQL 没有 `OFFSET`，翻到第 20 页与第 1 页库内代价相同。

效果：服务器内列表 9.59 → 2.38 ms（4×）。全局列表按 `servers.created_at` 排序，
形状不同，仍是 1000 行内的扫描 + 排序（约 13 ms）；若节点规模到十万级，下一步
应改成「独立 COUNT + 键集分页」，但那需要 API 增加游标，属于本轮之外的大改。

## P3：概览 SQL 条数 14 → 9

无链时固定 9 条；有链时 `count_blocked` 再追加链/组/成员与最多 1 条证书查询，
最多 12 条（与数据量无关，没有 N+1）。

| # | 优化前 | 优化后 |
|---|---|---|
| 1 | KPI 标量 5 个（servers/nodes/traffic 今日+本月） | 与 24h 可用率合并为 1 条（`AVG(AVG(...))` 等价） |
| 2 | `server_samples::uptime_all` | 并入 #1 |
| 3 | `stats::traffic_trend` | 保留（按天一行，粒度不同） |
| 4 | `protocol_traffic` | 保留（按天 × 协议，且口径不能替代总量趋势） |
| 5 | `protocol_rows` 的节点数 | 保留（多行 `GROUP BY protocol`，塞不进标量） |
| 6 | 链健康（chains/groups/members + forward_status） | 与 #7、#8 合并为 1 条 |
| 7 | forwards 总数 / 失败数 | 并入 #6 |
| 8 | handshake failures | 并入 #6 |
| 9 | `count_blocked` | 保留（复用 `chains::blocked_reason`，保证与链列表同口径） |
| 10 | `top_servers` | 保留（服务器驱动 LEFT JOIN，零流量服务器也参与排序，且驱动网速采样查询） |
| 11 | `load_rate_series` | 保留（按 top server 批量取采样） |
| 12 | `top_users` | 与 #13、#14 合并为 1 条 CTE |
| 13 | `top_nodes` | 并入 #12 |
| 14 | `package_split` | 并入 #12 |

合并后的 Top 卡在**每个分支内部** `ORDER BY ... LIMIT ?` 再 UNION ALL（保留
top-N 排序），Rust 侧按 `kind` 拆回三个数组。曾尝试 `ROW_NUMBER()` 排名，实测
同一条查询 240 ms vs 85 ms，因此没有采用。

## P4：限流每请求开销

| 微基准（debug） | 优化前 | 优化后 |
|---|---:|---:|
| `IpThrottle::check`（4096 条满表） | 64,193 ns/次 | 414 ns/次（≈155×） |
| `LoginThrottle::check`（4096 条满表） | 75,246 ns/次 | 2,139 ns/次（≈35×） |
| XFF 解析（5 段） | 1,311 ns/次 | 1,299 ns/次（单次不变） |
| 命中请求内缓存 | — | 64 ns/次 |

- 限流键改为 `ThrottleKey`（IPv4 4 字节；IPv6 高 64 位），登录键不再为每个请求
  克隆 `String`；`Key` 的 3 个聚合桶从 6 次 `String` 克隆降到 2 次。
- XFF 解析结果写入请求扩展 `ResolvedClientAddr`：`ip_auth_throttle_middleware`
  解析一次，Bearer 中间件与 `ClientIp` 提取器复用；优化前 Bearer 请求会解析 2 次。
- 锁内全表清理改为最多每 60 秒一次；`locked_count` 只在「即将新增锁定」时才数，
  常见路径从 O(表大小) 回到 O(1)。
- 语义不变：窗口、锁定上限、灌表淘汰、已锁定项不被挤掉等测试全部保留。

## 未做 / 取舍

- 没有合并 `traffic_trend` 与 `protocol_traffic`：粒度不同，且协议归属只覆盖
  节点切片 + 历史 `user@tag` 行，直接相加会少算没有协议归属的流量。
- 没有把 `count_blocked` 改成 SQL 计数：会与链列表的 `blocked_reason` 逻辑分叉。
- 没有改 API 分页协议做键集分页：节点量级仍小，改协议属于大改。
- 端到端 benchmark 中 overview / stats/traffic 的轻微波动来自 debug 版 SQLite
  与共享机器噪声；对应 SQL 未改、索引不适用，属于测量噪声而非回归。

---

# Performance baseline: indexes, pagination, overview SQL and throttling (P1–P4)

This document records the "measure first, then optimize" pass: the reproducible
`scripts/bench-api.sh`, migration `0059_query_indexes.sql`, and the
`crates/domain/tests/query_plan.rs` regression test.

## Method

- `scripts/bench-api.sh` seeds 10,001 users, 1,000 nodes, 10 servers, 20 packages,
  30 days of user/node/forward ledgers (300k + 30k + 30k rows), 50k audit rows and
  10k sessions, then runs `ANALYZE`.
- Endpoints: overview, stats/overview, stats/traffic, stats/nodes, nodes (global,
  deep page, server-scoped), users, forward-traffic, audit.
- 3 warm-up rounds, 20–30 measured rounds, p50/p95 in ms.
- Debug build (same as `make check` / `make e2e`); sqlx's bundled SQLite is
  unoptimized C in debug, so absolute numbers are high but before/after use the
  same build.
- Shared machine: ±5–10% end-to-end drift. We therefore also compare the same
  code/data with only the 0059 indexes toggled, and time the SQL directly with
  the system sqlite3.

## P1: indexes

Migration 0059 adds seven indexes tied to real queries: `traffic_daily(subject,
day)` (subject totals/trend), `traffic_daily(server_id, day)` (top-servers join),
`traffic_node_daily(server_id, day)` (node stats by server),
`audit_log(actor_id, action, created_at, id)` (`recent_logins`),
`sessions(expires_at)` (scheduled purge), `users(created_at)` (user list order)
and `nodes(server_id, created_at)` (server-scoped node list order).

Combinations already covered by primary keys/existing indexes were not repeated:
`traffic_daily(day, …)`, `traffic_node_daily(day, server_id, node_tag)`,
`forward_traffic_daily(day, forward_id)` plus `(user_id, day)`,
`server_samples(server_id, ts)`, `sessions(user_id)`, `audit_log(created_at, id)`.

Same code/data, only 0059 toggled (p50 ms):

| Endpoint | without | with | change |
|---|---:|---:|---:|
| overview | 821.23 | 754.89 | −8% |
| stats/nodes | 137.72 | 131.81 | −4% |
| users | 21.31 | 7.52 | −65% (2.8×) |
| nodes (server) | 2.54 | 2.38 | −6% |
| stats/traffic / forward-traffic / audit | 493.3 / 93.19 / 1.46 | 501.4 / 93.65 / 1.49 | noise |

Direct SQL (system sqlite3, mean of 10): subject totals 0.42 → 0.01 ms (81×),
subject trend 0.43 → 0.01 ms (81×), top-servers join 66.06 → 37.20 ms (1.78×),
recent logins 5.79 → ≈0.002 ms (≈2600×), users first page 4.45 → 0.18 ms (25×),
server node list 0.13 → 0.11 ms (1.24×), node traffic filtered by server
1.87 → 0.87 ms (2.15×).

Write cost: the seven indexes grow the benchmark DB from 40.3 MB to 65.0 MB
(+61%). The two daily ledgers pay one/two extra index updates per upsert.

## P2: node list and total

`nodes::list_page` used to read the whole `nodes` table on every request and
filter/paginate in memory. `total` is the filtered `len()`, so list and total
always share the same conditions; the cost was re-reading every node (including
`config_json`) per page.

Now `server_id`, `protocol` and `enabled` are pushed into SQL (indexable);
`tag` (JSON array membership) and `region` (case-insensitive) stay in memory.
Pagination is still in-memory `skip/take` with no SQL `OFFSET`, so page 20 costs
the same as page 1. Server-scoped list: 9.59 → 2.38 ms (4×). The global list is
ordered by `servers.created_at`, so it still sorts ~1k rows (~13 ms); at 100k
nodes the next step would be a separate COUNT + keyset pagination, which needs an
API cursor and is out of scope here.

## P3: overview SQL count 14 → 9

Nine fixed queries without chains; `count_blocked` adds chains/groups/members
plus at most one certificate query when chains exist (max 12), independent of
data volume.

Merged: KPI scalars + 24h uptime (5+1 → 1); chain health + forwards counters +
handshake failures (3 → 1); top users + top nodes + package split (3 → 1 CTE,
split back by `kind` in Rust). Kept separate: `traffic_trend` (daily rows vs
day × protocol), `protocol_traffic` (attribution cannot replace total traffic),
`protocol_rows` (multi-row GROUP BY), `top_servers` (server-driven LEFT JOIN plus
its rate-series follow-up), and `count_blocked` (must reuse
`chains::blocked_reason`).

Each Top branch uses `ORDER BY … LIMIT ?` inside a subquery before the UNION ALL
to keep top-N sorting. A `ROW_NUMBER()` variant measured 240 ms vs 85 ms on the
same data and was rejected.

## P4: throttle per-request cost

Microbenchmarks (debug): `IpThrottle::check` on a full 4096-entry table
64,193 → 414 ns (≈155×); `LoginThrottle::check` 75,246 → 2,139 ns (≈35×); XFF
parsing 1,311 → 1,299 ns per call; cached per-request lookup 64 ns.

Throttle keys are now `ThrottleKey` (4-byte IPv4 / high 64 bits of IPv6) instead
of `String`; the login key's three aggregate buckets clone two strings instead of
six. The resolved client address is cached in request extensions, so a Bearer
request parses XFF once instead of twice. Full-table purge runs at most once per
60 s, and `locked_count` is only computed when a new lock is about to be created.
Window/lock/eviction semantics and their tests are unchanged.

## Not done

- No merge of `traffic_trend` and `protocol_traffic`: different granularity, and
  protocol attribution cannot stand in for total traffic.
- No SQL count for `count_blocked`: it would fork from the chain-list logic.
- No keyset-pagination API change: node counts are still small and it is a larger
  contract change.
- End-to-end overview / stats/traffic drift is debug-SQLite and shared-machine
  noise, not a regression: those SQL statements are unchanged and the new indexes
  do not apply to them.
