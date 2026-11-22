# 概览接口按服务器筛选（`?server_ids=`）

> 本轮只涉及 `crates/{domain,master}` 与 `docs/`；没有迁移、没有改响应里既有
> 字段的形状（只新增 `scope` / `warnings` / `global` 三个键）。
>
> English follows the Chinese section.

## 1. 参数形式

```
GET /api/v1/overview?days=7&server_ids=<uuid>,<uuid>,...
```

- 支持两种写法：`?server_ids=a,b,c`（逗号分隔）与
  `?server_ids=a&server_ids=b`（重复参数）；服务端把两者合并后再去重、排序
  （全部重复项按出现顺序参与解析，不存在「只取最后一个」的歧义）。
- 每个 id 必须是 UUID；`Uuid::parse_str` 接受大写、无连字符等写法，服务端统一
  归一到**小写连字符**形式（与库里 `Uuid::new_v4().to_string()` 一致），再去重、
  升序排序。因此 `?server_ids=b,a` 与 `?server_ids=a,b,b` 是同一个筛选、也是
  同一个缓存 key。
- 空项（`a,,b`、首尾逗号、纯空白）直接跳过。
- 一次最多 **200** 个 id（`MAX_FILTER_SERVERS`）：URL 长度与 SQLite 绑定变量数
  都不该被一个查询参数打穿；超过返回 400 `query.server_ids_too_many`。
- 不传 `server_ids` = 全站（`scope.filtered = false`）。

## 2. 过滤语义表

| 响应字段 | 带 `server_ids` 时 | 说明 |
|---|---|---|
| `kpi.servers_online` / `kpi.servers_total` | **只统计选中服务器** | `servers.id IN (...)` |
| `kpi.nodes` | **只统计选中服务器上的节点** | `nodes.server_id IN (...)` |
| `kpi.uptime_24h` | **只平均选中服务器** | 没有采样的服务器仍不参与均值 |
| `kpi.traffic_today` / `kpi.traffic_month` | **只统计选中服务器** | `traffic_daily_rollup` 的 `scope='server'` + `key IN (...)` |
| `series`（按天趋势） | **只统计选中服务器** | 同上 |
| `protocols[].nodes` | **只数选中服务器上的节点** | `nodes.server_id IN (...)` |
| `protocols[].traffic_7d` | **只统计选中服务器** | 原始 `traffic_node_daily` / `traffic_daily`（见第 4 节） |
| `protocol_series` | **只统计选中服务器** | 同上 |
| `top`（Top 服务器） | **只列选中服务器** | `servers.id IN (...)`，最多 5 台 |
| `top_users` | **只统计选中服务器上的流量** | 原始 `traffic_daily.server_id IN (...)` |
| `top_nodes` | **只统计选中服务器上的流量** | 原始 `traffic_node_daily.server_id IN (...)` |
| `package_split` | **只统计选中服务器上产生的流量** | 由 `top_users` 同一份用户流量归集 |
| `global.users_total` / `global.package_instances` / `global.package_templates` | **不变（全局）** | `scope.global = true` 标注 |
| `chains`（链 / 转发 / 握手失败） | **不变（全局）** | 见第 7 节「未做项」 |
| `scope` / `warnings` | 本次筛选的元信息 | 见第 3 节 |

**空数组**（`?server_ids=` 或全是空项）= 筛选后没有任何服务器：返回
**空结果**（KPI 全 0、`series` 仍补齐窗口日期但值为 0、所有数组为空数组），
**不是**回落到全站数字。`scope.filtered = true`、`scope.servers_matched = 0`
是前端显示空态的依据；`global` 与 `chains` 仍返回真实全局值。

**未知 id**（格式合法、库里不存在）：忽略并计入 `warnings.unknown_ids`，
其余命中项照常参与筛选；全部未知时同样是空结果。

**非法 id 格式**：400 `query.server_ids_invalid`，`params.value` 带出错的那一项。
不静默忽略——拼错一个字符应该立刻看到错误，而不是拿到一份少了服务器的报表。

## 3. 响应片段

```jsonc
{
  "kpi": { "servers_online": 1, "servers_total": 1, "nodes": 2,
           "traffic_today": 100, "traffic_month": 100, "uptime_24h": 1.0 },
  "series": [ /* 7 项，按天补齐；只有选中服务器的数字 */ ],
  "protocol_series": [ /* … */ ],
  "protocols": [ /* … */ ],
  "chains": { "total": 0, "degraded": 0, "blocked": 0,
              "forwards_total": 0, "forwards_failing": 0,
              "handshake_failures": 0 },          // 全局口径，不受筛选影响
  "top": [ { "server_id": "3f1a…0001", "kind": "server", "name": "香港-01",
             "traffic_7d": 100, "load1": null, "online": true, "rates": [] } ],
  "top_users": [ /* … */ ],
  "top_nodes": [ /* … */ ],
  "package_split": [ /* … */ ],
  "global": { "users_total": 2, "package_instances": 1, "package_templates": 1 },

  "scope": {
    "server_ids": ["3f1a1c2e-0000-4000-8000-000000000001"],
    "servers_matched": 1,
    "filtered": true,
    "global": true
  },
  "warnings": { "unknown_ids": [] }
}
```

- `scope.server_ids` 是**实际生效**（命中库）的 id，不是请求原文：未知 id 与
  重复项不会出现在这里，只在 `warnings.unknown_ids` 里。
- `scope.servers_matched` = 命中库的台数；不传参数时固定 0。
- `scope.filtered` = 请求是否带了 `server_ids`（空数组也是 `true`）。
- `scope.global` 固定 `true`：响应里的 `global` 与 `chains` 是全局口径，前端可
  据此给这两块加「全局」提示。
- 既有字段（`kpi` / `series` / `protocols` / `chains` / `top*` / `package_split`）
  的形状完全不变；这是**新增**字段，旧前端可以忽略。
- 响应头与旧接口一致：`Vary: Cookie` + `X-Overview-Cache: hit|miss`。

## 4. 查询与索引（`EXPLAIN QUERY PLAN`）

会话缓存命中时只做非流量部分；下面是**冷查询**（`CACHE=0` 等价路径）用到的
SQL。计划在「按迁移建库、不跑 `ANALYZE`」的库上采集（与主控运行方式一致；
`scripts/bench-overview.sh` 会 `ANALYZE`，届时 `key IN (...)` 的查询会改走
`idx_traffic_daily_rollup_key_day`，见 `docs/OVERVIEW-PERF.md`）。

| 查询 | 计划 |
|---|---|
| KPI 今日/本月 | `SEARCH traffic_daily_rollup USING PRIMARY KEY (scope=? AND day=? AND key=?)`、`… (scope=? AND day>? AND day<?)` |
| 日趋势 | `SEARCH traffic_daily_rollup USING PRIMARY KEY (scope=? AND day>? AND day<?)` |
| Top 服务器（带筛选） | `SEARCH s USING INDEX sqlite_autoindex_servers_1 (id=?)` + `SEARCH t USING PRIMARY KEY (scope=? AND day>? AND day<?) LEFT-JOIN` |
| Top 用户 / 套餐 | `SEARCH traffic_daily USING INDEX idx_traffic_daily_server_day (server_id=? AND day>? AND day<?)` |
| 协议归属 / Top 节点 | `SEARCH traffic_node_daily USING INDEX idx_traffic_node_daily_server_day (server_id=? AND day>? AND day<?)`，JOIN `nodes` 走 `(server_id, tag)` |
| 历史兜底（`subject` 带 `@`） | `idx_traffic_daily_server_day` + `NOT EXISTS` 走 `idx_traffic_node_daily_node (server_id=? AND node_tag=? AND day=?)`（覆盖索引） |
| 节点计数 | `idx_nodes_server_created (server_id=?)` |
| 服务器计数 / 可用率 | `servers` 主键、`server_samples` 主键 `(server_id, ts)` |

为什么分成两条路径：

- **服务器维度**（KPI 今日/本月、日趋势、Top 服务器）继续读日汇总
  `traffic_daily_rollup` 的 `server` scope：`key IN (...)` 把候选集限定在选中
  服务器，行数上限仍是「服务器数 × 天数」，与全站口径同阶，**不会**退化成
  「用户数 × 天数」；
- **用户/节点维度**（Top 用户、套餐分布、协议归属、Top 节点）必须回原始账本：
  `subject` scope 没有服务器维度；`node` / `legacy` scope 的 key 是
  `server_id \x1f node_tag`（前缀无法用 `IN` 表达）。原始表的
  `(server_id, day)` 索引正好覆盖这个条件，`traffic_daily.server_id` 就是
  需求里指定的过滤列；
- 筛选到空集时 `IN (...)` 拼成 `(NULL)`（`x IN (NULL)` 永不为真），所有查询
  自然返回「没有匹配行」，不需要为这种情况写第二套 SQL。

查询次数固定、与服务器数无关：KPI 1 条、日趋势 1 条、协议归属 1 条、Top 卡
1 条、Top 服务器 1 条 + 采样 1 条、计数/全局 2 条；**没有 N+1**。

回归测试：`crates/domain/tests/query_plan.rs::overview_server_filter_queries_use_their_indexes`
断言上述查询都走索引（`PRIMARY KEY` 或具名索引），且计划里没有
`SCAN <table>` 式整表扫描。

## 5. 缓存策略

`crates/master/src/state.rs` 的 `OverviewTrafficCache` 仍然只缓存**流量派生**
的 `TrafficSnapshot`（KPI 流量、日趋势、协议、四张 Top 卡），TTL 12 秒
（`PIERWAVE_OVERVIEW_CACHE_SECS`，`0` 关闭）。本轮只改 key：

```rust
enum OverviewTrafficKey {
    Snapshot { days: i64, server_ids: Option<Vec<String>> },
}
```

- key = **`(days, 规范化后的 server_ids)`**。`None`（不筛选）与
  `Some(vec![])`（筛选到空集）是**不同**的 key；
- id 在路由层已去重、升序，所以参数顺序不同也命中同一条；
- 缓存 key 包含筛选后有两个直接好处：先请求全量再筛选不会拿到全站数字；
  反之筛选结果也不会污染全量请求。测试
  `routes::overview::tests::overview_cache_is_keyed_by_server_ids` 正反两个
  方向都验证了；
- 条目上限 64：`server_ids` 组合可能远多于 `days`，超过上限时先清过期条目、
  再淘汰最早写入的一条（12 秒 TTL 下不值得引入 LRU）；
- `clear()` 语义不变（恢复备份等管理员动作显式失效），计费入账仍不失效；
- 非流量部分（服务器/节点计数、24h 可用率、Top 服务器、链路健康、全局计数）
  每次现算，不进缓存——新建节点或服务器上线立刻可见。

**语义边界**：缓存是 TTL 语义，不是强一致。筛选结果与全站一样最多陈旧 12 秒；
计费/账单/订阅额度始终读原始账本。

## 6. 测试

领域层（`crates/domain/src/repo.rs::overview::tests`）：

1. `server_filter_normalizes_and_deduplicates_ids`：去重、排序、空集判定；
2. `server_filter_scopes_server_and_traffic_but_not_global_counts`：两台各 100，
   筛一台得 100；在线/总数、节点数、可用率、Top 服务器、协议节点数、Top
   用户/节点/套餐都只算选中服务器；`global` / `chains` 不变；两台都选 = 全站；
3. `empty_server_filter_returns_empty_result_but_keeps_global_counts`：空数组 →
   全 0 + 空数组 + 全局计数与链路健康不变；
4. `filtering_to_the_only_server_matches_the_unfiltered_snapshot`：唯一服务器时
   「筛选」与「全站」逐字段相等（含历史 `user@tag` 兜底、已删节点归 `unknown`、
   归因失败只算一次）——两条 SQL 路径口径对齐的回归测试。

路由层（`crates/master/src/routes/overview.rs::tests`）：

1. `overview_server_ids_filter_traffic_and_scope`：单台 / 多台 / 顺序与重复 /
   `scope` 与 `warnings`；
2. `overview_server_ids_empty_array_returns_empty_result_and_keeps_globals`：
   空数组（`?server_ids=`）；
3. `overview_server_ids_unknown_are_reported_and_ignored`：未知 id 与「全部未知」；
4. `overview_rejects_invalid_server_ids_with_400`：非法格式与超过 200 个；
5. `overview_server_ids_requires_admin`：非管理员 403、未登录 401；
6. `overview_cache_is_keyed_by_server_ids`：先全量后筛选、先筛选后全量都不串；
7. 既有契约测试更新：顶层键集合 = 旧 9 个 + `scope` / `warnings` / `global`。

`state` 层：`overview_cache_key_includes_the_server_filter` /
`overview_cache_evicts_entries_above_the_cap`。

## 7. 未做项

- **`chains` 不按服务器筛**：一条链的成员可以分布在多台服务器上（还有
  `forwards` / 双向成员），「按服务器切链」没有唯一答案，会产生重复计数；
  本轮保持全局口径，并在 `scope.global = true` 里标注。
- 只能按具体服务器 id 筛，不能按分组名 / 国家 / 在线状态等条件筛；上限
  200 个 id，也没有分页/搜索式的筛选接口。服务器很多时前端应让用户选具体的
  几台，而不是「全选再裁」。
- 缓存仍是进程内 TTL 语义，多实例部署不互相通知；恢复备份重启后各实例都从空
  缓存开始。
- 不改 `web/`（另一条 lane 负责筛选控件与「全局」提示的展示），不改
  `crates/proto`、`crates/agent`，没有新增迁移。

---

# Overview API server filter (`?server_ids=`)

This round only touches `crates/{domain,master}` and `docs/`. No migration is
needed, and the shapes of the existing response fields are unchanged (only
`scope`, `warnings` and `global` are added).

## Parameter

`GET /api/v1/overview?days=7&server_ids=<uuid>,<uuid>,...`

Both the comma-separated form (`?server_ids=a,b,c`) and the repeated form
(`?server_ids=a&server_ids=b`) are accepted; they are merged before dedupe and
sort, in order of appearance. Each entry must be a UUID; uppercase and
non-hyphenated forms are accepted and normalized to lowercase hyphenated form
(the same representation `Uuid::new_v4().to_string()` produces), then deduped
and sorted, so `?server_ids=b,a` and `?server_ids=a,b,b` are the same filter and
the same cache key. Empty entries are skipped. At most **200** ids are accepted
(`query.server_ids_too_many` otherwise); omitting the parameter means all
servers (`scope.filtered = false`).

## Semantics

Server-related fields (online/total servers, node count, 24h uptime, Top
servers, per-protocol node counts) and traffic-related fields (today/month
traffic, daily series, protocol distribution/series, Top users/nodes/packages)
count only the selected servers. `global` (`users_total`,
`package_instances`, `package_templates`) and `chains` are **global** and carry
`scope.global = true`.

An **empty array** (`?server_ids=` or only empty entries) means "the filter
matched no servers": the response is an **empty result** (all KPIs zero, the
series is still padded with zero points, every list is empty) rather than the
global numbers; `scope.filtered = true` and `scope.servers_matched = 0` are the
frontend's empty-state signal. **Unknown ids** are ignored and listed in
`warnings.unknown_ids`; if all ids are unknown the result is empty as well. An
**invalid UUID** is a 400 `query.server_ids_invalid` (with the offending value in
`params.value`), never a silent drop.

## Response

```jsonc
"scope": { "server_ids": ["…"], "servers_matched": 1,
           "filtered": true, "global": true },
"global": { "users_total": 2, "package_instances": 1, "package_templates": 1 },
"warnings": { "unknown_ids": [] }
```

`scope.server_ids` lists the ids that actually exist (unknown ones only appear in
`warnings.unknown_ids`); `servers_matched` is the number of matched servers (0
when unfiltered); `filtered` is true whenever `server_ids` was supplied (even
when empty); `global` is always true and marks `global` + `chains` as
global-scope. Existing fields keep their exact shape, so older clients can
ignore the new keys.

## Queries and indexes

Server-dimension numbers keep reading the daily rollup (`scope = 'server'` with
`key IN (...)`), so they stay bounded by servers × days instead of users × days.
User/node-dimension numbers must read the raw ledgers: the `subject` scope has no
server dimension, and `node`/`legacy` keys are `server_id \x1f node_tag`, which
`IN` cannot express. There, `traffic_daily.server_id` / `traffic_node_daily.server_id`
are filtered directly through `idx_traffic_daily_server_day` and
`idx_traffic_node_daily_server_day`.

Measured plans (schema from migrations, no `ANALYZE`, matching how the master
runs; the benchmark script does `ANALYZE`, after which the `key IN (...)` queries
use `idx_traffic_daily_rollup_key_day`):

| Query | Plan |
|---|---|
| KPI today/month | `SEARCH traffic_daily_rollup USING PRIMARY KEY (scope=? AND day=? AND key=?)` / `(scope=? AND day>? AND day<?)` |
| Daily series | `SEARCH traffic_daily_rollup USING PRIMARY KEY (scope=? AND day>? AND day<?)` |
| Top servers (filtered) | `SEARCH s USING INDEX sqlite_autoindex_servers_1 (id=?)` + `SEARCH t USING PRIMARY KEY (scope=? AND day>? AND day<?) LEFT-JOIN` |
| Top users / packages | `SEARCH traffic_daily USING INDEX idx_traffic_daily_server_day (server_id=? AND day>? AND day<?)` |
| Protocols / Top nodes | `SEARCH traffic_node_daily USING INDEX idx_traffic_node_daily_server_day (server_id=? AND day>? AND day<?)` |
| Legacy fallback | `idx_traffic_daily_server_day` + `NOT EXISTS` via covering `idx_traffic_node_daily_node` |
| Node counts | `idx_nodes_server_created (server_id=?)` |
| Server counts / uptime | `servers` and `server_samples` primary keys |

An empty filter is emitted as `IN (NULL)` (never true), so every query naturally
returns no rows without a second SQL variant. The number of queries is fixed and
independent of the server count (no N+1).
`crates/domain/tests/query_plan.rs::overview_server_filter_queries_use_their_indexes`
asserts that these queries use an index and never a plain table scan.

## Cache

`OverviewTrafficCache` still caches only the traffic-derived `TrafficSnapshot`
with a 12 s TTL. Its key is now `(days, normalized server_ids)`, where
`None` (unfiltered) and `Some(vec![])` (filtered to nothing) are distinct. Ids
are deduped and sorted before the lookup, so parameter order does not matter.
The key change is what stops "full request first, filtered request second" from
serving stale global numbers (and vice versa); the route test
`overview_cache_is_keyed_by_server_ids` covers both directions. The map is
capped at 64 entries, dropping expired entries first and then the oldest one.
`clear()` semantics are unchanged (explicit admin actions only), and billing
writes still never invalidate the cache. Non-traffic parts are computed on every
request and never cached.

## Not done

- `chains` is not filtered: a chain can span several servers (and forwards),
  so a per-server split has no single correct answer; it stays global and is
  marked by `scope.global = true`.
- Filtering only accepts concrete server ids (not group names, countries or
  online state), capped at 200 ids, with no paged/searchable server picker.
- The cache is still per-process and TTL based; multi-instance deployments do
  not coordinate invalidation.
- No `web/` changes (another lane owns the filter control and the "global"
  hints), no `proto`/`agent` changes, no migration.
