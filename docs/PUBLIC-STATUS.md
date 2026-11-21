# 公开状态页接口 / Public status API

`GET /api/v1/public/status` 是**无需登录**的只读探针页接口。本文描述
`series`（三张迷你图的历史序列）、每台服务器上的 5 个详情字段
（`outage_minutes_24h` / `first_seen_at` / `inbound_count` / `buckets_7d` /
`series_24h`）以及它们依赖的采样口径；服务器其余白名单字段见
[PLAN.md](PLAN.md) 的 P10，速率的实时口径见 [TELEMETRY.md](TELEMETRY.md)。

所有新增字段都是**纯增量**：旧客户端忽略即可，旧后端不返回时前端按「无数据」
处理。新增字段不需要迁移——它们是对已有列（`server_samples` / `servers` /
`nodes`）的只读聚合。

English: `GET /api/v1/public/status` is a read-only, unauthenticated probe page.
This document covers the global `series` (mini charts) and the five per-server
detail fields added for the node detail page. Every field is purely additive:
old clients can ignore it, and no migration is required because all of them are
read-only aggregations over existing columns.

## 可见性与费用公开 / Visibility and billing visibility

公开页有两层「看不看得见」的配置，互不影响：

| 配置 | 位置 | 默认 | 语义 |
|---|---|---|---|
| `public_status_enabled` | `settings` 表（`"0"` / `"1"`） | `"1"` | 整页总开关；`"0"` 时接口 404（`public_status.disabled`）。 |
| `servers.public_visible` | 每台服务器一列（迁移 `0064`） | `1` | 该服务器是否出现在公开页。 |
| `public_billing_visible` | `settings` 表（`"0"` / `"1"`） | `"1"` | 费用与到期四列是否公开；`"0"` 时四列一律 `null`。 |

两层配置都在**缓存之前**或写入时清缓存，改动立即生效，不会等 30 秒 TTL。

English: two independent visibility layers. `public_status_enabled` is the
whole-page switch (404 when `"0"`); `servers.public_visible` decides whether a
single server appears; `public_billing_visible` hides the four billing columns
globally. Both settings are applied before the 30s response cache (and writes
flush it), so changes take effect immediately.

### 每台服务器的白名单 / Per-server allow-list

- `servers.public_visible = 0` 的服务器**同时**从 `servers`、`groups`、
  `summary`（`servers_total` / `servers_online` / `nodes_total`）和全局
  `series` 里消失。不存在「分组里还有 5 台、列表只显示 3 台」的错位：
  `groups` 的 `servers` / `online` / `uptime_24h` 只按可见集合累加，全局
  `series` 的 SQL 也只聚合 `public_visible = 1` 的采样。
- `summary.traffic_today` / `traffic_month` 是**账号维度**的全局流量
  （`traffic_daily` 没有服务器列），无法按服务器拆分，因此保持全站口径，
  不受白名单影响。
- 该列只影响公开读接口，不参与鉴权、期望态下发、计费或订阅。
- 存量数据兼容：迁移 `0064` 的默认值是 `1`，升级前已有的服务器全部继续
  公开，行为与升级前一致；管理员需要时再显式隐藏。

English: a server with `public_visible = 0` disappears from `servers`,
`groups`, `summary` (`servers_total` / `servers_online` / `nodes_total`) and
the global `series` at the same time, so group counts can never disagree with
the visible list. `summary.traffic_today` / `traffic_month` are account-level
totals (`traffic_daily` has no server column) and stay global. The column never
affects auth, desired state, billing or subscriptions. Migration `0064` defaults
to `1`, so every existing server stays public after upgrading.

### 管理端白名单接口 / Admin allow-list endpoints

两个端点都要求管理员会话（`require_admin`，非管理员 403）：

```http
GET /api/v1/public-status/servers
-> { "items": [ { "id": "...", "name": "香港-01", "online": true,
                  "public_visible": true } ] }   // 按名称升序，同名的按 id

PUT /api/v1/public-status/servers
<- { "ids": ["...", "..."] }
-> { "visible": 2, "hidden": 1 }
```

- `PUT` 是**整体替换**：列出的设为可见，其余全部隐藏；`{ "ids": [] }` 表示
  全部隐藏（不是「不改」）。
- 未知 id → `400`，错误码 `public_status.unknown_servers`，`params.ids` 里是
  不存在的 id 列表；**整单失败，不做部分成功**，已有配置保持不变。
  `ids` 不是字符串数组 → `400` / `public_status.ids_invalid`。
- 审计动作 `settings.public_status_servers`，`detail.changes` 只记录可见 /
  隐藏数量（`visible` / `hidden`）的 `from` / `to`，**不记录 id 列表**。

English: both endpoints require an admin session. `PUT` replaces the whole
allow-list (`{ "ids": [] }` hides everything). Unknown ids return `400`
`public_status.unknown_servers` with `params.ids`, and the whole request fails
without partial writes; a non-array `ids` is `400` `public_status.ids_invalid`.
The audit action is `settings.public_status_servers`, recording only the before
/ after visible and hidden counts — never the id list.

### `billing_hidden` 与费用字段 / `billing_hidden` and billing fields

公开响应顶层新增 `billing_hidden`：

```jsonc
{
  "panel_name": "Pierwave",
  "billing_hidden": true,
  "servers": [{ "paid_until": null, "price_cents": null,
                "currency": null, "billing_cycle": null, /* ... */ }]
}
```

| `public_billing_visible` | `billing_hidden` | `paid_until` / `price_cents` / `currency` / `billing_cycle` |
|---|---|---|
| `"1"`（默认） | `false` | 管理员填了就返回真实值；没填 / 存量值非法是 `null`。 |
| `"0"` | `true` | 一律 `null`，不看数据库里的实际值。 |

- 它解决的是**歧义**：`paid_until: null` 既可能是「没有配置」，也可能是
  「配置了但不公开」。`billing_hidden = true` 说明是后者，前端应显示
  「未公开」而不是「未填写」。
- 隐藏是**服务端**行为：四个字段在 JSON 里根本不会出现真实值，不是前端
  不渲染。
- 旧数据兼容：没有 `public_billing_visible` 键（升级前就存在的库）按默认
  `"1"` 处理，`billing_hidden = false`，公开页行为与升级前完全一致。旧客户端
  不认识这个新字段时直接忽略即可。
- 迁移 `0061` 的存量脏值（越界价格、坏币种等）仍按 `null` 降级处理，与
  `billing_hidden` 无关；迁移 `0062` 的修复逻辑不变。

English: the top-level `billing_hidden` disambiguates `null`. With the default
`"1"` it is `false` and the four fields carry real values when configured (or
`null` when unset/invalid). With `"0"` it is `true` and all four are `null`
regardless of the stored values — hiding happens on the server, not in the
client. Databases without the `public_billing_visible` key behave exactly like
before the upgrade (`billing_hidden: false`); old clients can ignore the new
field. Dirty legacy billing values still degrade to `null` as before.

## 节点详情字段 / Node detail fields

```jsonc
"servers": [{
  // ... 既有的白名单字段 ...
  "outage_minutes_24h": 180,        // 最近 24h 内 online=0 的采样分钟数；无采样 → null
  "first_seen_at": 1763000000,      // 首次记录（servers.created_at）；未知 → null
  "inbound_count": 3,               // 启用的入站数量；没有节点是 0
  "buckets_7d": [                   // 固定 7 项，最早 → 最新
    { "day": "2025-11-15", "online_ratio": 0.9973, "samples": 288 }
  ],
  "series_24h": {                   // 该服务器最近 24h 的逐小时趋势（仅在线采样）
    "window_secs": 86400,
    "step_secs": 3600,
    "t": [ /* 24 个整点桶起点，升序 */ ],
    "rate_rx_bps": [ /* 24 项，number|null */ ],
    "rate_tx_bps": [ /* 24 项，number|null */ ],
    "latency_ms": [ /* 24 项，integer|null */ ]
  }
}]
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `outage_minutes_24h` | `integer \| null` | 最近 24 小时内 `online = 0` 的采样分钟数之和（每条采样 5 分钟）。**没有任何采样是 `null`，不是 0。** |
| `first_seen_at` | `integer \| null` | 首次记录时间，取 `servers.created_at`（Unix 秒）；0 / 未知是 `null`。 |
| `inbound_count` | `integer` | 该服务器上 `enabled = 1` 的入站数量；没有节点是 `0`。只暴露数量。 |
| `buckets_7d` | `object[]` | 固定 7 项，按 UTC+8 自然日从最早到最新；`online_ratio` 是当天 `AVG(online)`，`samples` 是当天采样行数。 |
| `series_24h` | `object` | 该服务器最近 24 小时的逐小时趋势，24 个整点桶。 |

### `outage_minutes_24h` / Outage minutes

- 窗口是 `[now - 86400, now]`，与 `uptime_24h` 同一时间口径。
- `server_samples` 每 5 分钟一行，`online = 0` 的行计 5 分钟；`online = 1` 不
  计。因此 36 条离线采样 = 180 分钟。
- **没有采样时是 `null`**：可能服务器刚建、Agent 从未连上，或采样任务还没跑。
  `null` 表示「未知」，`0` 表示「有采样且全程在线」，两者绝不混用。
- 中断计数与 `series_24h` 由同一条 `GROUP BY server_id, 小时` 的 SQL 算出，
  不额外扫一遍样本表。

English: the window is `[now - 86400, now]`. Each `online = 0` sample counts as
5 minutes; `online = 1` samples do not. With no samples at all the field is
`null` (unknown), never `0` — `0` means "samples exist and the server was online
the whole time". The outage count rides on the same `GROUP BY server_id, hour`
query as `series_24h`.

### `first_seen_at`

- 直接取 `servers.created_at`（建服务器时写入，Unix 秒），不额外查询。
- 值为 `0` 或负数（历史脏数据 / 手工改库）时输出 `null`，绝不编造
  `1970-01-01` 之类的假时间。
- 它表示「这条纪录第一次出现」，不是「第一次在线」，也不等于最后上线时间。

English: `first_seen_at` mirrors `servers.created_at`. Zero/negative (legacy or
hand-edited rows) becomes `null`; the API never invents an epoch timestamp. It
means "when the record was created", not "when it first came online".

### `inbound_count` / Inbound count

- 统计 `nodes` 中 `server_id` 匹配且 `enabled = 1` 的行数；停用节点不计。
- **只暴露数量**：不返回协议、端口、tag、名称、地址或配置。公开页拿不到任何
  入站拓扑，读者只能看到「有 N 个可用入站」。
- 没有节点（或全部停用）时是 `0`，不是 `null`：0 个入站是确定的事实。

English: counts enabled nodes (`nodes.enabled = 1`) per server. Only the number
is exposed — never protocol, port, tag, name, address, or config. No nodes (or
all disabled) is `0`, because "zero enabled inbounds" is a known fact.

### `buckets_7d` / Seven-day buckets

- 固定 **7** 项，从最早到最新，最后一项是 UTC+8 的「今天」。
- 按 **UTC+8 自然日**切分（与 `traffic_daily.day` 同口径）：UTC+8 午夜前的采样
  归前一天，午夜起归新的一天；不用 UTC 日期，否则东八区凌晨会记错天。
- `online_ratio = AVG(online)`，范围 0..1；`samples` 是该日的采样行数（5 分钟
  粒度，整日为 288）。
- **当天没有任何采样时 `online_ratio = null`、`samples = 0`**：`null` 表示未知，
  不是「完美可用」，也不是「全天离线」。

English: exactly 7 buckets, oldest first, ending with today (UTC+8). Days are
split at UTC+8 midnight, the same calendar as `traffic_daily.day`. `online_ratio`
is `AVG(online)`; `samples` is the row count for that day. A day without samples
gets `online_ratio: null` and `samples: 0` — unknown, not perfect uptime.

### `series_24h` / Per-server 24h series

- 窗口 24 小时 = 24 个整点桶；`t` 是桶起点（Unix 秒，升序），最后一个桶是
  **当前小时**（可能只过了一部分）。
- **只统计该小时 `online = 1` 的采样**（与全局 `series` 同口径）：`rate_rx_bps` /
  `rate_tx_bps` 是在线采样的 `AVG(rx_bps)` / `AVG(tx_bps)`（单位字节/秒），
  SQLite 的 `AVG` 自动跳过 NULL，旧 Agent 不会把均值拉成 0。
- `latency_ms` 是在线采样的 `ROUND(AVG(latency_ms))`，NULL 不参与平均，返回整数。
- 离线采样不参与：它带的 `rx_bps` / `latency_ms` 只是掉线前的最后一帧，算进去
  会画出「机器已经离线、曲线还在跑流量和延迟」。`outage_minutes_24h` 仍按
  `online = 0` 单独统计，两者互不影响。
- **该小时没有在线采样、或在线采样里的对应列全为 NULL 时是 `null`**，不是 0：
  前端据此画断点 / 显示 `—`。只有离线采样的小时同样整桶为 `null`，不沿用旧值。
- 它与全局 `series` 形状相同（`t` + 三条等长数组），但口径是**单台服务器**，
  不是全站汇总。

English: 24 hourly buckets (`t` ascending, last = current hour). Only samples
with `online = 1` participate, matching the global `series`: rates are the hourly
`AVG(rx_bps)` / `AVG(tx_bps)` in bytes/sec (SQL `AVG` skips NULL), and latency is
`ROUND(AVG(latency_ms))`. Offline samples are excluded because they only carry
the last frame before the disconnect; counting them would draw traffic and
latency for a machine that is down. `outage_minutes_24h` still counts
`online = 0` separately. An hour with no online sample — or whose online samples
are all NULL — is `null`, never `0`; an hour with only offline samples stays
`null` instead of reusing stale values. The shape matches the global `series`,
but the values are for this one server.

## 迷你图 `series` / Mini charts

`series` 是**纯增量字段**：旧客户端忽略它即可；旧后端不返回时前端把它当
「无数据」。它只有三条序列和窗口元数据，不包含任何服务器标识。

```jsonc
"series": {
  "window_secs": 3600,                    // 窗口长度（秒），固定 60 分钟
  "step_secs": 300,                       // 桶宽（秒），与 5 分钟采样一致
  "t": [1763700000, 1763700300, ...],     // 12 个桶起点，升序
  "rate_rx_bps": [123456, null, ...],     // 桶内在线机器接收速率之和（字节/秒）
  "rate_tx_bps": [null, ...],             // 同上，发送方向
  "latency_ms": [28, null, ...]           // 桶内在线机器延迟均值（整数毫秒）
}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `window_secs` | `integer` | 窗口长度，固定 `3600` 秒。 |
| `step_secs` | `integer` | 桶宽，固定 `300` 秒（与 `server_samples` 采样粒度一致）。 |
| `t` | `integer[]` | 12 个桶起点（Unix 秒），升序；最后一个桶是**当前** 5 分钟桶。 |
| `rate_rx_bps` | `(number \| null)[]` | 该桶内所有**在线**服务器的接收速率之和，字节/秒。 |
| `rate_tx_bps` | `(number \| null)[]` | 同上，发送方向。 |
| `latency_ms` | `(integer \| null)[]` | 该桶内在线服务器的延迟算术平均，四舍五入为整数毫秒。 |

四条数组（`t` + 三条序列）长度都固定为 **12**，一一对应、下标共享。

### 窗口与桶 / Window and buckets

- 窗口 60 分钟 = 12 个 5 分钟桶；桶起点按 300 秒向下对齐。
- 最后一个桶是 `now` 所在的当前桶（可能只过了一部分）；向前共 12 个桶。
- 因此「刚好 60 分钟前」的采样（对齐后是第一个桶的前一个桶）**不在窗口内**，
  不会挤进 `t[0]`。
- 缺桶补 `null`，不补 0，也不插入伪造的时间戳。

### 聚合口径 / Aggregation

- 只统计该桶内 `server_samples.online = 1` 的采样。离线采样不参与：它带的
  `rx_bps` / `tx_bps` 只是掉线前的最后一帧，算进去会画出「离线机器仍在跑流量」。
- `rate_*` 是 `SUM(rx_bps)` / `SUM(tx_bps)`：SQL 的 `SUM` 自动跳过 NULL，
  所以一台旧 Agent 不会把总和拉低，也不会变成 0。
- `latency_ms` 是 `ROUND(AVG(latency_ms))`：NULL 不参与平均，返回整数毫秒。
- 整段窗口用**一条** `GROUP BY ts` 的 SQL 聚合（`repo::server_samples::series_buckets`），
  不按服务器循环，没有 N+1；查询命中 `idx_server_samples_ts(ts)` 的区间扫描。

### 性能与查询计划 / Performance and query plan

新增的详情字段**不引入 N+1**：每类数据都是**一条**跨服务器聚合 SQL，再在内存里
按 `server_id` 映射到每台服务器。

| 数据 | SQL | 聚合键 | 索引 |
|---|---|---|---|
| `buckets_7d` | `repo::server_samples::daily_buckets_all` | `GROUP BY server_id, date(ts + 28800, 'unixepoch')` | `idx_server_samples_ts` |
| `outage_minutes_24h` + `series_24h` | `repo::server_samples::hourly_series_all` | `GROUP BY server_id, (ts / 3600) * 3600` | `idx_server_samples_ts` |
| `inbound_count` | `repo::nodes::enabled_counts_by_server` | `GROUP BY server_id` | `idx_nodes_server_created`（`server_id` 前缀） |

`EXPLAIN QUERY PLAN` 实测（SQLite 3.45）：

```text
-- daily_buckets_all
SEARCH server_samples USING INDEX idx_server_samples_ts (ts>? AND ts<?)
USE TEMP B-TREE FOR GROUP BY

-- hourly_series_all
SEARCH server_samples USING INDEX idx_server_samples_ts (ts>? AND ts<?)
USE TEMP B-TREE FOR GROUP BY

-- enabled_counts_by_server
SCAN nodes USING INDEX idx_nodes_server_created
```

两条 `server_samples` 聚合都先走 `(ts)` 索引做时间窗区间扫描，再对命中行做
临时 B 树分组；`nodes` 的计数按 `server_id` 索引前缀扫描，不是整表全扫。
回归测试见 `crates/domain/tests/query_plan.rs` 的
`public_status_detail_aggregates_use_the_sample_time_index` 与
`inbound_counts_use_the_nodes_server_index`。

English: the detail fields add no N+1. Each family is a single cross-server
aggregate (`daily_buckets_all`, `hourly_series_all`, `enabled_counts_by_server`)
mapped to servers in memory. Both `server_samples` queries use
`idx_server_samples_ts` for the time-window range scan, then a temp B-tree for
grouping; the inbound count walks the `server_id` prefix of
`idx_nodes_server_created`. Regression tests assert these plans.

### `null` 语义 / `null` semantics

**`null` 表示「没有数据」，`0` 表示「有数据且确实是 0」。两者绝不能混用。**

以下情况对应桶是 `null`：

- 该桶没有任何在线采样（空库、服务器还没采样、全部离线）；
- 在线采样存在，但速率列全为 NULL：旧 Agent 未上报网卡计数、首次心跳只有
  基线、计数回绕被丢弃；
- 在线采样存在，但延迟列全为 NULL：旧 Agent 不上报延迟，或本轮探测失败。

详情字段的 `null`：

- `outage_minutes_24h`：最近 24h **没有任何采样** → `null`（未知）；有采样且
  全程在线 → `0`。
- `buckets_7d`：某个自然日没有采样 → 该日 `online_ratio: null`、
  `samples: 0`，不补 0。
- `series_24h`：某小时没有**在线**采样，或在线采样里对应列全为 NULL → `null`；
  只有离线采样的小时整桶为 `null`（不沿用掉线前旧值），有在线采样且值为 0 才是 `0`。
- `first_seen_at`：`created_at` 为 0 / 未知 → `null`。
- `inbound_count` **永远是数字**：0 个启用入站是确定事实，不用 `null`。

前端据此画缺口 / 显示 `—`，不画 0 值的点。旧 Agent（无 `rx_bps` /
`latency_ms`）不会让任何序列出现 `0`。

English: `null` means "no data" and `0` means "data exists and is really zero".
`outage_minutes_24h` is `null` only when the server has no samples in the last
24h; a server with samples that stayed online is `0`. Empty days in `buckets_7d`
get `online_ratio: null` with `samples: 0`, and hours without data in
`series_24h` stay `null`. `first_seen_at` is `null` when `created_at` is unknown.
`inbound_count` is always a number because "zero enabled inbounds" is a fact.

### 缓存 / Cache

响应按进程内缓存 **30 秒**。命中缓存时 `series`、`series_24h`、`buckets_7d`
与其余字段一起原样返回，不会先返回旧字段、再异步补新字段。开关
`public_status_enabled = 0` 的判断在缓存之前，关闭后立即 404（即使有旧缓存）。

English: the response is cached in-process for 30 seconds. `series`,
`series_24h`, `buckets_7d` and every other field are cached together — a cache
hit never returns a payload with a missing or partial detail field. The
`public_status_enabled = 0` check runs before the cache, so disabling the page
returns 404 immediately even if a cached value exists.

### 隐私边界 / Privacy boundary

公开页字段本身即白名单。本次新增的字段里：

- `inbound_count` **只有数量**，不返回协议、端口、tag、名称、地址或配置；
- `series_24h` 只有这台服务器自己的聚合数值，不包含任何服务器标识；
- `buckets_7d` 只有日期、可用率与样本数；
- 查询 `nodes` 时只 `SELECT server_id, COUNT(*)`，不把节点的其它列读进内存。

公开响应仍然不含服务器地址（`address`）、token、用户名、套餐、证书，也不含
逐节点明细。

English: the public payload is an allow-list. `inbound_count` is only a count;
`series_24h` carries this server's aggregates and no identifiers; `buckets_7d`
only has day/ratio/samples. The nodes query selects just `server_id, COUNT(*)`.
Addresses, tokens, users, packages, certificates and per-node details are still
never exposed.

### 与计费无关 / Display only — not billing

- `series` 里的速率是**网卡链路速率**，只用于展示。**不参与计费、不参与配额、
  不触发期望态下发。**
- 计费仍走 Xray 计数器与转发规则的 `last_traffic_*` / `forward_traffic_daily`，
  两套数据互不影响。
- 采样行保留 7 天（每轮写入顺带清理更早的行）；公开页只读最近 60 分钟。

English: rates in `series` are NIC link rates for display only. They never feed
billing, quotas, or desired-state dispatch. Billing keeps using the Xray and
per-forward cumulative counters. Sample rows are retained for 7 days and pruned
on write; the public page only reads the last 60 minutes.

### 存储与迁移 / Storage and migrations

- `server_samples` 由迁移 `0018` 创建，每 5 分钟一行，主键 `(server_id, ts)`；
  `idx_server_samples_ts` 覆盖本接口的时间窗查询。
- `servers.public_visible` 由迁移 `0064` 加入（`INTEGER NOT NULL DEFAULT 1`）：
  只追加一列，存量服务器默认公开；公开页在 SQL 与内存两处按它过滤。
- `server_samples.latency_ms` 由迁移 `0020` 加入，`rx_bps` / `tx_bps` 由 `0053`
  加入；采样任务（`repo::server_samples::record_round`）每轮一起写入。
- `series` 与 5 个详情字段**都不需要新迁移**：它们是对已有列的只读聚合。
  `first_seen_at` 用 `0018` 之前就存在的 `servers.created_at`；
  `inbound_count` 用 `nodes.enabled`；历史行没有对应值时自然是 `NULL`，接口
  按 `null` 返回。
- 采样行保留 7 天，正好覆盖 `buckets_7d` 的窗口；更早的行在写入时清理。

English: `server_samples` was created by migration `0018`; `latency_ms` was added
by `0020`, `rx_bps` / `tx_bps` by `0053`, and the sampler writes them together.
`servers.public_visible` was added by migration `0064`
(`INTEGER NOT NULL DEFAULT 1`): one additive column, existing servers stay
public, and the public page filters by it both in SQL and in memory.
Neither `series` nor the five detail fields need a migration — they are
read-only aggregations over existing columns (`servers.created_at`,
`nodes.enabled`). Legacy rows simply have `NULL`. Samples are retained for 7
days, enough for `buckets_7d`; older rows are pruned on write.

### 响应示例 / Example

```jsonc
{
  "panel_name": "Pierwave",
  "generated_at": 1763703499,
  "billing_hidden": false,
  "summary": { "servers_total": 3, "servers_online": 2, "nodes_total": 7,
               "traffic_today": 123456789, "traffic_month": 9876543210 },
  "servers": [{
    "id": "6f1c...",
    "name": "香港-01",
    "online": true,
    // ... 其余既有白名单字段 ...
    "outage_minutes_24h": 15,
    "first_seen_at": 1763000000,
    "inbound_count": 3,
    "buckets_7d": [
      { "day": "2025-11-15", "online_ratio": 0.9973, "samples": 288 },
      { "day": "2025-11-16", "online_ratio": 1.0,    "samples": 288 },
      { "day": "2025-11-17", "online_ratio": null,   "samples": 0   },
      { "day": "2025-11-18", "online_ratio": 0.9832, "samples": 288 },
      { "day": "2025-11-19", "online_ratio": 1.0,    "samples": 288 },
      { "day": "2025-11-20", "online_ratio": 0.9990, "samples": 288 },
      { "day": "2025-11-21", "online_ratio": 1.0,    "samples": 144 }
    ],
    "series_24h": {
      "window_secs": 86400,
      "step_secs": 3600,
      "t": [1763618400, 1763622000, 1763625600, /* ... 共 24 项 ... */ 1763701200],
      "rate_rx_bps": [118400.5, 131200.0, null, /* ... 共 24 项 ... */ 99000.0],
      "rate_tx_bps": [20400.0, 41200.5, null, /* ... 共 24 项 ... */ 38000.0],
      "latency_ms": [28, 31, null, /* ... 共 24 项 ... */ 27]
    }
  }],
  "groups": [ /* ... */ ],
  "series": {
    "window_secs": 3600,
    "step_secs": 300,
    "t": [1763700000, 1763700300, 1763700600, 1763700900,
          1763701200, 1763701500, 1763701800, 1763702100,
          1763702400, 1763702700, 1763703000, 1763703300],
    "rate_rx_bps": [null, 118400.5, 131200.0, null, 99000.0,
                    120500.5, 140000.0, 138500.5, null, 126000.0,
                    125400.0, 133300.0],
    "rate_tx_bps": [null, 20400.0, 41200.5, null, 38000.0,
                    45500.0, 50100.5, 48000.0, null, 43000.0,
                    44000.5, 39200.0],
    "latency_ms": [null, 28, 31, null, 27, 29, 33, 30,
                   null, 26, 28, 29]
  }
}
```

示例里被 `null` 占据的桶表示「那一轮没有任何在线采样」；`2025-11-17` 的
`online_ratio: null` 表示那天没有采样（不是 0%）。数值只用于说明形状，
不是固定值。速率单位是**字节/秒**，不是 bit/s。
