# 公开状态页接口 / Public status API

公开探针页有**两个**无需登录的只读接口：

| 接口 | 作用 | 缓存 |
|---|---|---|
| `GET /api/v1/public/status` | 列表 + 全站迷你图 + 分组 + 汇总 | 30 秒（进程内，单飞重建） |
| `GET /api/v1/public/status/{id}` | 单台服务器的完整行 + 24h 逐小时趋势 | 与列表共用同一份 30 秒快照 |

两个接口都**按 IP 限流**（默认每分钟 60 次，超限 `429` + `Retry-After`），
见下文「限流与单飞」/ Both endpoints are rate-limited per client IP (60
requests per minute by default, `429` + `Retry-After` when exceeded); see
"Rate limiting and single-flight" below.

本文描述这两个接口、`series`（三张迷你图的历史序列）、每台服务器上的详情字段
（`outage_minutes_24h` / `first_seen_at` / `inbound_count` / `buckets_7d` /
`series_24h`）、gzip 压缩与缓存语义；服务器其余白名单字段见
[PLAN.md](PLAN.md) 的 P10，速率的实时口径见 [TELEMETRY.md](TELEMETRY.md)。

所有新增字段都是**纯增量**：旧客户端忽略即可，旧后端不返回时前端按「无数据」
处理。除费用成对修复（迁移 `0065`）外都不需要迁移——它们是对已有列
（`server_samples` / `servers` / `nodes`）的只读聚合。

English: the public probe page has **two** unauthenticated, read-only endpoints:
the list (`GET /api/v1/public/status`) and a per-server detail
(`GET /api/v1/public/status/{id}`). This document covers both, the global
`series` (mini charts), the per-server detail fields, gzip compression and the
30-second cache. Every field is purely additive: old clients can ignore it, and
these fields need no migration because they are read-only aggregations over
existing columns (`server_samples` / `servers` / `nodes`). Migration `0065` is a
separate data repair for legacy unpaired billing rows (price without currency or
the reverse).

## 列表与详情：为什么拆 / Why the payload is split

1000 台服务器时，每台 24 个小时桶 + 24 点 `series_24h` 会让列表响应接近 3 MB。
趋势只有「点开某台服务器」时才需要，列表页不渲染它，因此：

- **列表**只保留列表页真正用到的字段，**不再返回** `series_24h`；
- **详情**返回 `{ server, series_24h }`：`server` 与列表行**完全同形**，趋势
  单独放在顶层，客户端可以复用同一套行解析逻辑。

```jsonc
// GET /api/v1/public/status
{ "panel_name": "...", "generated_at": 1763703499, "billing_hidden": false,
  "summary": { /* ... */ },
  "servers": [ { "id": "...", "name": "香港-01", /* ... 列表行，无 series_24h ... */ } ],
  "groups": [ /* ... */ ],
  "series": { /* 全站 60 分钟迷你图 ... */ } }

// GET /api/v1/public/status/{id}
{ "server": { /* 与列表行完全同形的字段 */ },
  "series_24h": {
    "window_secs": 86400, "step_secs": 3600,
    "t": [ /* 24 个整点桶起点，升序 */ ],
    "rate_rx_bps": [ /* 24 项，number|null */ ],
    "rate_tx_bps": [ /* 24 项，number|null */ ],
    "latency_ms": [ /* 24 项，integer|null */ ]
  } }
```

### 404 语义 / 404 semantics

| 情况 | 状态 | `code` | `params` |
|---|---|---|---|
| 页面被关闭（`public_status_enabled = "0"`） | `404` | `public_status.disabled` | 无 |
| 未知 id | `404` | `public_status.not_found` | `{ "id": "<请求里的 id>" }` |
| 服务器存在但被白名单隐藏 | `404` | `public_status.not_found` | `{ "id": "<请求里的 id>" }` |

「被隐藏」与「不存在」必须返回**完全一样**的响应：否则读者可以用详情接口
枚举出被隐藏服务器的 id，白名单就形同虚设。页面关闭的判断在 id 查找之前，
所以关闭后任何 id（包括不存在的）都是 `public_status.disabled`。

详情不会额外暴露服务器地址、token、用户名、套餐或证书：`server` 就是列表行
的白名单字段，`series_24h` 只有这台服务器自己的聚合数值。

English: the list no longer carries `series_24h`; it moved to
`GET /api/v1/public/status/{id}`, whose `server` object is byte-for-byte the same
shape as a list row and whose top-level `series_24h` holds the 24 hourly buckets.
A disabled page is `404 public_status.disabled` for both endpoints. An unknown id
and a whitelist-hidden server both return the identical
`404 public_status.not_found` with `params.id`, so the detail endpoint cannot be
used to enumerate hidden servers. The disabled check runs before the id lookup.

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
- `summary.traffic_today` / `traffic_month` 是**账号维度**的全局流量：**这是
  账号级流量，白名单隐藏节点不会减少它**。口径见下面单独一节。
- 该列只影响公开读接口，不参与鉴权、期望态下发、计费或订阅。
- 存量数据兼容：迁移 `0064` 的默认值是 `1`，升级前已有的服务器全部继续
  公开，行为与升级前一致；管理员需要时再显式隐藏。

English: a server with `public_visible = 0` disappears from `servers`,
`groups`, `summary` (`servers_total` / `servers_online` / `nodes_total`) and
the global `series` at the same time, so group counts can never disagree with
the visible list. `summary.traffic_today` / `traffic_month` are
**account-level** totals: hiding a server does not subtract its traffic. The
column never affects auth, desired state, billing or subscriptions. Migration
`0064` defaults to `1`, so every existing server stays public after upgrading.

### `traffic_today` / `traffic_month` 是账号级流量 / Account-level traffic

`summary.traffic_today` / `traffic_month` 是**账号级流量**：
`SUM(traffic_daily.weighted)`（今天 / 本月，UTC+8 自然日），覆盖**所有**用户
和**所有**服务器，包括未公开的服务器。**这是账号级流量，白名单隐藏节点不会
减少它**——隐藏一台服务器只影响它是否出现在 `servers` / `groups` / `series`，
不会修改这两个汇总数字。转发规则（`forward_traffic_daily`）的流量也不计入
这两个数字，它们是 Xray 流量的口径。

为什么不做「按服务器拆分」：

- **技术上可以拆**：`traffic_daily` 与 `traffic_node_daily` 都有 `server_id`
  （`traffic_daily` 的主键就是 `(day, server_id, subject)`，`traffic_node_daily`
  是 `(day, server_id, node_tag, user_id)`），按 `server_id` 聚合一行的 SQL
  成本很低。早期文档写「`traffic_daily` 没有服务器列」是错的，这里更正。
- **但语义会变**：这两个数字是面板首页的「今日 / 本月总流量」KPI，公开页只是
  复用它。改成「只算可见服务器」会让管理员一隐藏服务器，历史总量就突然变小；
  这是对已验收行为的静默改口径，比不做更糟。
- **拆分结果也不该公开**：逐服务器的流量属于客户用量，公开页的 allow-list
  刻意只给全站汇总。真要做，应该新增独立的逐服务器字段（纯增量、可单独隐藏），
  而不是改这两个汇总的含义。本轮不做，保持全站口径并在文档里写清楚。

English: `summary.traffic_today` / `traffic_month` are account-level totals:
`SUM(traffic_daily.weighted)` for today / this month (UTC+8), across every user
and every server — **including servers hidden from the page**. Hiding a server
does not reduce these numbers; it only removes the server from `servers` /
`groups` / the global `series`. Forwarded traffic (`forward_traffic_daily`) is
not included. Per-server splitting is technically cheap (`traffic_daily` and
`traffic_node_daily` both carry `server_id`; the older claim that
`traffic_daily` has no server column was wrong), but it would silently change
the meaning of an accepted KPI: hiding a server would shrink the historical
totals. Per-server traffic is also customer usage that the public allow-list
deliberately does not expose. If needed, add a separate additive per-server
field instead of redefining these totals.

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

列表行（**不含** `series_24h`）：

```jsonc
"servers": [{
  // ... 既有的白名单字段 ...
  "outage_minutes_24h": 180,        // 最近 24h 内 online=0 的采样分钟数；无采样 → null
  "first_seen_at": 1763000000,      // 首次记录（servers.created_at）；未知 → null
  "inbound_count": 3,               // 启用的入站数量；没有节点是 0
  "buckets_7d": [                   // 固定 7 项，最早 → 最新
    { "day": "2025-11-15", "online_ratio": 0.9973, "samples": 288 }
  ]
}]
```

详情接口 `GET /api/v1/public/status/{id}`（`server` 与上面同形，趋势在顶层）：

```jsonc
{
  "server": { /* 与列表行完全同形 */ },
  "series_24h": {                   // 该服务器最近 24h 的逐小时趋势（仅在线采样）
    "window_secs": 86400,
    "step_secs": 3600,
    "t": [ /* 24 个整点桶起点，升序 */ ],
    "rate_rx_bps": [ /* 24 项，number|null */ ],
    "rate_tx_bps": [ /* 24 项，number|null */ ],
    "latency_ms": [ /* 24 项，integer|null */ ]
  }
}
```

| 字段 | 位置 | 类型 | 含义 |
|---|---|---|---|
| `outage_minutes_24h` | 列表 / 详情 | `integer \| null` | 最近 24 小时内 `online = 0` 的采样分钟数之和（每条采样 5 分钟）。**没有任何采样是 `null`，不是 0。** |
| `first_seen_at` | 列表 / 详情 | `integer \| null` | 首次记录时间，取 `servers.created_at`（Unix 秒）；0 / 未知是 `null`。 |
| `inbound_count` | 列表 / 详情 | `integer` | 该服务器上 `enabled = 1` 的入站数量；没有节点是 `0`。只暴露数量。 |
| `buckets_7d` | 列表 / 详情 | `object[]` | 固定 7 项，按 UTC+8 自然日从最早到最新；`online_ratio` 是当天 `AVG(online)`，`samples` 是当天采样行数。 |
| `series_24h` | **仅详情** | `object` | 该服务器最近 24 小时的逐小时趋势，24 个整点桶。 |

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

### `series_24h`（仅详情接口）/ Per-server 24h series (detail only)

- **只在 `GET /api/v1/public/status/{id}` 的顶层返回**；列表行不含该字段，
  列表页也不渲染趋势。`server` 对象仍与列表行同形，趋势是它的兄弟字段。
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

详情字段**不引入 N+1**：每类数据都是**一条**跨服务器聚合 SQL，再在内存里按
`server_id` 映射到每台服务器。拆分后列表不再返回 `series_24h`，但这次聚合仍然
要跑——`outage_minutes_24h` 与趋势由同一条 `hourly_series_all` 算出，省掉它
只会让详情变慢；趋势算完直接进共享快照，等详情请求来取。

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
`idx_nodes_server_created`. After the split the list no longer returns
`series_24h`, but the aggregation still runs: `outage_minutes_24h` and the series
come from the same `hourly_series_all` query, and the result goes straight into
the shared snapshot for the detail endpoint. Regression tests assert these
plans.

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

列表与详情共用**同一份**进程内快照，有效期 **30 秒**。一次聚合同时产出：

1. 列表响应（`servers` / `groups` / `summary` / 全局 `series`，不含
   `series_24h`）；
2. `server_id → series_24h` 的映射（只含公开可见的服务器）。

两者一起写、一起失效，所以不会出现「列表是新的、详情是旧的」。详情命中缓存
时只做一次 1000 行里的查找，不再打库聚合；缓存过期后的第一次详情请求会做一次
与列表相同的完整聚合，然后重新缓存。开关 `public_status_enabled = 0` 的判断在
缓存之前，关闭后列表与详情都立即 404（即使有旧缓存）；白名单 / 费用可见性
变更时写路径会清空缓存，改动立刻生效，不会等 30 秒 TTL。

English: the list and the detail share **one** in-process snapshot with a
30-second TTL. A single aggregation produces both the list payload and a
`server_id → series_24h` map, so the list can never be newer than the detail.
A cache hit for the detail does one lookup in the 1000-row array instead of
re-aggregating; the first detail request after expiry performs the same full
aggregation as the list and re-caches it. The `public_status_enabled = 0` check
runs before the cache (both endpoints 404 immediately), and whitelist / billing
visibility writes flush the cache instead of waiting for the TTL.

### 限流与单飞 / Rate limiting and single-flight

这一节是防刷（S1）与缓存击穿（S2）的行为契约，**只影响匿名公开读取**：
管理端接口 `/api/v1/public-status/*`（白名单）仍走鉴权，不受这里的限流约束。

#### 公开读取限流 / Public read rate limit

| 项 | 值 |
|---|---|
| 覆盖接口 | `GET /api/v1/public/status`、`GET /api/v1/public/status/{id}`（**共用同一个桶**） |
| 维度 | 客户端 IP（复用 `ClientAddr`：XFF 信任边界 + IPv4-mapped 归一 + IPv6 `/64` 聚合） |
| 默认阈值 | 每 IP **每分钟 60 次** |
| 超限响应 | `429`，`code = public_status.rate_limited`，`params.retry_after_secs`，响应头 `Retry-After`（秒，`1..=60`） |
| 窗口 | 固定 60 秒；窗口一过计数归零，**不会**因为继续请求而延长 |
| 状态 | 进程内计数，主控重启即清零（与登录/认证失败限流同一取舍） |

**为什么健康检查不限流**：`/api/v1/health` 是监控探针，通常按秒级轮询；
把它和公开页塞进同一个桶，会让「面板被刷」直接变成「监控误报」。它只做一次
内存检查、不打库聚合，保护它的收益远小于误伤成本。**故 `health` 不参与公开
读取限流**。订阅入口 `/api/v1/sub/{short_code}` 也不在本限流范围内（它有自己的
短码语义，本轮未改）。

限流在 handler **之前**执行：被 429 的请求不读设置、不碰缓存、更不会触发聚合，
这正是它要挡掉的成本。

**与认证失败限流完全分开**：公开读取数的是「读得多」，认证失败（Bearer /
Agent Hello / 登录）数的是「凭据错」。两张表互不写入——把公开页读爆不会让
登录或 Bearer 被 429，撞库失败也不会消耗公开页的额度。公开读取**没有锁定
状态**：不存在「被锁 N 分钟」，只有「本分钟剩余 0 次」。

**绕过测试**：`X-Forwarded-For` 的伪造第一跳不生效（只采信右侧真实地址，
信任边界见 [DEPLOY.md](DEPLOY.md) 的 XFF 一节）；`::ffff:1.2.3.4` 与
`1.2.3.4` 共用桶；IPv6 同一 `/64` 内的地址轮换共用桶；列表与详情互不赠送额度。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PIERWAVE_PUBLIC_RATE_LIMIT_PER_MIN` | `60` | 每 IP 每分钟读取上限（正整数）。空串 / `0` / 负数 / 非数字 / 带单位一律视为非法，**回落 60** 并打一条 warn——配置写错时应该退回安全默认，而不是关掉限流。 |

English: both public endpoints share **one** per-IP bucket (60 requests per
minute by default). Exceeding it returns `429` with `code =
public_status.rate_limited`, `params.retry_after_secs` and a `Retry-After`
header (1–60 seconds). It is a fixed 60-second window: the counter resets when
the window ends and is never extended by hammering. Counters live in process
memory and reset on restart (same trade-off as the login/auth-failure limiters).

`/api/v1/health` is deliberately **not** rate-limited: it is the monitoring
probe, polled every few seconds, and folding it into the same bucket would turn
"the page is being hammered" into "monitoring is down". It only performs an
in-memory check and never aggregates the database, so the protection is worth
less than the false alarms. The rate limit runs **before** the handler: a 429
request never loads settings, never touches the cache and never triggers an
aggregation — that is the cost it exists to prevent.

The table is completely separate from the auth-failure limiter (Bearer / Agent
Hello / login): reading the public page heavily never locks out login or
Bearer, and credential stuffing never consumes the public read budget. There is
no lockout state here — only "0 requests left in this minute".

Forged `X-Forwarded-For` first hops do not bypass the limit (only the rightmost
real address is trusted; see the XFF section of [DEPLOY.md](DEPLOY.md));
`::ffff:1.2.3.4` shares the bucket with `1.2.3.4`; addresses inside one IPv6
`/64` share a bucket; the list and the detail do not grant each other extra
budget. `PIERWAVE_PUBLIC_RATE_LIMIT_PER_MIN` overrides the threshold; any
invalid value (empty, `0`, negative, non-numeric, with a unit) falls back to the
default `60` and logs a warning.

#### 单飞重建 / Single-flight rebuild

30 秒缓存过期或冷启动时，**同一时刻只有一个请求**真正聚合（1000 台约 500ms），
其余请求等它把快照写进缓存后直接复用：

1. 缓存命中 → 直接返回，不加锁；
2. 未命中 → 取一把 `tokio::sync::Mutex` 单飞锁（**不是**阻塞锁，不跨 `.await`
   持 `std::sync::MutexGuard`）；
3. 拿到锁后再看一次缓存：前一位重建者可能刚好写完 → 记为「等待命中」，直接复用；
4. 仍然没有 → 由持有者聚合、写缓存、释放锁。

**失败与超时语义**：

| 情况 | 行为 |
|---|---|
| 聚合失败 | 错误原样返回给 leader，**不缓存错误**；锁随 guard 释放，下一次请求重新尝试（不会被一次失败卡 30 秒）。 |
| 等待者等锁超过 **5 秒** | 返回 `503`，`code = public_status.overloaded`，`params.retry_after_secs = 1`；**不各自重算**（那正是缓存击穿本身）。 |
| leader 写缓存后 | 排队的等待者依次拿到同一份结果，不再聚合。 |

5 秒远大于 1000 台冷缓存的重建耗时（约 500ms），只有数据库卡死这类异常才会
触发 503。这段等待窗口不额外读取数据库，也不持有任何 `std` 锁。

**指标（只记日志，不接 Prometheus）**：`PublicStatusCache` 在进程内累计
`rebuilds`（真实聚合次数）、`waited_hits`（等到锁后复用结果的次数）、
`wait_timeouts`（503 次数）与 `failures`（聚合失败次数）。每次重建成功打一条
`info` 日志 `公开状态页快照已重建 / public status snapshot rebuilt`，带
`rebuilds` / `waited_hits` / `elapsed_ms`；等待命中打 `debug`；聚合失败打 `warn`；
等待超时打 `warn`。并发回归：20 个并发请求只允许 1 次重建（单元测试与 HTTP
测试各一份），见 `crates/master/src/state.rs` 与 `crates/master/src/app.rs`。

English: when the 30-second snapshot expires (or on cold start) only **one**
request actually aggregates (~500ms at 1000 servers); the rest wait for that
result and reuse it. Cache hits take no lock. A miss takes a
`tokio::sync::Mutex` single-flight lock (never a blocking lock; a
`std::sync::MutexGuard` is never held across `.await`), re-checks the cache once
the lock is acquired (a "waited hit" reuses the previous builder's result), and
otherwise builds, stores and releases.

A failed aggregation returns the error to the leader and is **not cached**; the
guard is released so the next request retries instead of being stuck for 30
seconds. A waiter that cannot get the lock within **5 seconds** gets `503`
`public_status.overloaded` with `params.retry_after_secs = 1` instead of
recomputing (recomputing is exactly the cache stampede this prevents). 5
seconds is an order of magnitude above the ~500ms cold rebuild at 1000 servers,
so only a stuck database triggers it. Log-only counters (`rebuilds`,
`waited_hits`, `wait_timeouts`, `failures`) are kept in the cache; a successful
rebuild logs `info` with `rebuilds` / `waited_hits` / `elapsed_ms`, waited hits
log at `debug`, failures and wait timeouts at `warn`. Regression tests assert
that 20 concurrent requests trigger exactly one rebuild, both at the cache layer
and through HTTP.

### gzip 压缩 / gzip compression

全站 JSON 响应（含公开状态页、MCP、订阅、管理端接口）启用 gzip：

- 客户端发送 `Accept-Encoding: gzip` 时，响应带 `Content-Encoding: gzip` 与
  `Vary: Accept-Encoding`（后者保证反代 / CDN 不会把压缩版发给不支持的客户端）；
- 不压缩**已经压缩过的二进制**：`application/octet-stream`（`/api/agent/download/*`、
  `/api/agent/release/*` 下发的 Agent 二进制）、`application/zip`、
  `application/gzip`；图片、SSE、gRPC 与小于 32 字节的响应也跳过；
- 压缩是传输层优化，不改变 JSON 内容：解压后与不压缩的响应逐字节一致；
- 注册在路由最外层（`CompressionLayer`），静态资源里的 HTML / JS / CSS 同样
  受益；`Vary` 由中间件自动补齐，不需要每个 handler 自己写。

English: gzip is enabled for every JSON response on the router (public status,
MCP, subscriptions, admin APIs) via a single outer `CompressionLayer`.
Responses carry `Content-Encoding: gzip` and `Vary: Accept-Encoding` when the
client sends `Accept-Encoding: gzip`. Already-compressed binaries are skipped:
`application/octet-stream` (the agent binary downloads), `application/zip`,
`application/gzip`, plus images, SSE, gRPC and responses under 32 bytes.
Compression never changes the decompressed JSON — it is byte-for-byte identical
to the identity response.

### 1000 台基线（拆前 / 拆后、压缩前后）/ Baseline at 1000 servers

测量方法：临时 SQLite，1000 台服务器，每台填满白名单字段（UUID、中文名、国家、
分组、费用四列）、24 个小时桶（每小时 2 条采样，`online_ratio` 出现 0 / 0.5 / 1）、
7 个自然日桶；响应体是 gzip 前的原始 JSON 字节数。耗时是本机 loopback、debug
构建、15 轮热缓存（30 秒缓存命中）的 p50；冷缓存 = 进程启动后第一次请求。
复跑：`scripts/bench-public-status.sh`（造数与 curl 都在脚本里），单元级的
冷缓存回归见 `crates/master/src/routes/public_status/payload.rs`。

| 场景（1000 台） | 列表原始体积 | 每台 | gzip 后 | 每台 | gzip 比例 |
|---|---|---|---|---|---|
| **拆前**：列表含 `series_24h` | 2,953,262 B（2.82 MB） | 2953 B | 280,950 B¹ | 281 B | 9.5% |
| **拆后**：列表不含 `series_24h` | ≈2,019,000 B（1.93 MB） | 2019 B | ≈40,900 B | 41 B | 2.0% |
| **详情**（单台，含 24 点趋势） | ≈2,990 B | 2990 B | ≈1,030 B | 1030 B | 34.5% |

¹ 拆前服务端还没有 `CompressionLayer`；这一列是把同一份响应体用 gzip level 6
压缩得到的对照值，不是当时线上实际发出的字节数。

合成数据里每台服务器的桶时间戳完全相同、`online_ratio` 只有 0 / 0.5 / 1 三种值，
gzip 会比真实数据更乐观（真实库里每台的可用率是 12 条采样的分数，序列各不相同）。
拆前那一行包含逐台变化的速率数值，压缩率反而更接近真实；拆后这一行的 2.0% 应当
理解为「结构高度重复时的下界」，真实数据会略高，但量级不变。

| 场景 | 冷缓存耗时 | 热缓存 p50（identity） | 热缓存 p50（gzip） |
|---|---|---|---|
| 列表（拆前） | 663 ms | 92 ms | —（未启用） |
| 列表（拆后） | 635 ms | 72 ms | 106 ms |
| 详情（拆后） | 19 ms² | 18 ms | 18 ms |

² 这个 19 ms 是在列表刚把共享快照填好之后测的；缓存完全为空时，详情会做一次
与列表相同的完整聚合（与列表冷缓存同一量级，≈0.6 s），然后重新缓存 30 秒。

怎么读这张表：

- **拆分的收益在响应体**：列表字节数下降 32%，gzip 后下降 85%。冷缓存耗时几乎
  不变，因为 `series_24h` 所在的 `hourly_series_all` 查询同时产出
  `outage_minutes_24h`（同一条 SQL），列表仍然需要它——拆走的是「列表不该承载
  的字段」，不是这次聚合。
- **gzip 的收益在传输**：2 MB → 41 KB。本机 loopback 上压缩的 CPU 成本会让热缓存
  p50 从 72 ms 涨到 106 ms（debug 构建、压缩 2 MB JSON），但真实网络的 2 MB
  传输远不止几十毫秒；客户端带 `Accept-Encoding: gzip` 即可。
- **详情很轻**：命中共享缓存时是 1000 行里的一次查找（约 19 ms），不会再打库聚合。
- 体积是「所有白名单字段都填满」的上界；真实库里字段为空（`null`）只会更小。
  回归阈值取 **2.2 KB/台**（实测 2013 B/台 + 约 10% 余量），见 payload 测试。

English: baseline measured on a temporary SQLite database with 1000 servers, all
whitelist fields populated, 24 hourly buckets (two samples per hour, so
`online_ratio` takes 0 / 0.5 / 1) and 7 daily buckets. Sizes are raw JSON bytes;
timings are loopback debug-build p50 over 15 warm-cache requests. Splitting
removes 32% of the list payload (85% after gzip) while cold latency stays the
same, because the `hourly_series_all` query also produces `outage_minutes_24h`
and the list still needs it. gzip cuts the wire size from 2 MB to 42 KB at the
cost of server CPU (72 ms → 106 ms warm p50 on loopback, debug build). The
post-split gzip ratio is a best-case lower bound: the synthetic timestamps are
identical across every server and `online_ratio` only takes 0/0.5/1, whereas a
real database has per-server fractions. Real data compresses slightly less, but
the order of magnitude holds. The detail request is a single lookup on the
shared snapshot once warm (~19 ms). The
regression budget is 2.2 KB per server (measured ~2019 B); the test lives in
`crates/master/src/routes/public_status/payload.rs`. Reproduce with
`scripts/bench-public-status.sh`.

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
- 拆分列表 / 详情、启用 gzip 都**不需要迁移**：前者只改响应形状，后者是路由层
  中间件。
- 迁移 `0065` 是一次**数据修复**（不是结构变更）：把历史上「只有价格没币种」或
  「只有币种没价格」的单边行整组清成 `NULL`，成对行保留。写路径
  （`BillingMeta::validated`）本来就拒绝单边组合，所以这些行只可能来自旧版本 /
  手工改库。迁移只 `UPDATE` 这两列，可重复执行；同行的 `paid_until` /
  `billing_cycle` 不受影响。
- 采样行保留 7 天，正好覆盖 `buckets_7d` 的窗口；更早的行在写入时清理。

English: `server_samples` was created by migration `0018`; `latency_ms` was added
by `0020`, `rx_bps` / `tx_bps` by `0053`, and the sampler writes them together.
`servers.public_visible` was added by migration `0064`
(`INTEGER NOT NULL DEFAULT 1`): one additive column, existing servers stay
public, and the public page filters by it both in SQL and in memory.
Neither `series` nor the five detail fields need a migration — they are
read-only aggregations over existing columns (`servers.created_at`,
`nodes.enabled`). Legacy rows simply have `NULL`. The list/detail split and gzip
need no migration either (response shape + router middleware). Migration `0065`
is a **data repair**: it resets unpaired `price_cents` / `currency` rows to
`NULL` and keeps complete pairs; the write path already rejects one-sided pairs,
so these rows can only come from older versions or hand-edited databases. It
only updates those two columns (idempotent; `paid_until` / `billing_cycle` are
untouched). Samples are retained for 7 days, enough for `buckets_7d`; older rows
are pruned on write.

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
    ]
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

详情接口 `GET /api/v1/public/status/{id}` 的响应：

```jsonc
{
  "server": {
    "id": "6f1c...",
    "name": "香港-01",
    // ... 与列表行完全同形的字段，不含 series_24h ...
    "outage_minutes_24h": 15,
    "buckets_7d": [ /* ... 同上 7 项 ... */ ]
  },
  "series_24h": {
    "window_secs": 86400,
    "step_secs": 3600,
    "t": [1763618400, 1763622000, 1763625600, /* ... 共 24 项 ... */ 1763701200],
    "rate_rx_bps": [118400.5, 131200.0, null, /* ... 共 24 项 ... */ 99000.0],
    "rate_tx_bps": [20400.0, 41200.5, null, /* ... 共 24 项 ... */ 38000.0],
    "latency_ms": [28, 31, null, /* ... 共 24 项 ... */ 27]
  }
}
```

示例里被 `null` 占据的桶表示「那一轮没有任何在线采样」；`2025-11-17` 的
`online_ratio: null` 表示那天没有采样（不是 0%）。数值只用于说明形状，
不是固定值。速率单位是**字节/秒**，不是 bit/s。
