# 公开状态页接口 / Public status API

`GET /api/v1/public/status` 是**无需登录**的只读探针页接口。本文只描述
`series`（三张迷你图的历史序列）与它依赖的采样口径；服务器白名单字段见
[PLAN.md](PLAN.md) 的 P10，速率的实时口径见 [TELEMETRY.md](TELEMETRY.md)。

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

### `null` 语义 / `null` semantics

**`null` 表示「没有数据」，`0` 表示「有数据且确实是 0」。两者绝不能混用。**

以下情况对应桶是 `null`：

- 该桶没有任何在线采样（空库、服务器还没采样、全部离线）；
- 在线采样存在，但速率列全为 NULL：旧 Agent 未上报网卡计数、首次心跳只有
  基线、计数回绕被丢弃；
- 在线采样存在，但延迟列全为 NULL：旧 Agent 不上报延迟，或本轮探测失败。

前端据此画缺口 / 显示 `—`，不画 0 值的点。旧 Agent（无 `rx_bps` /
`latency_ms`）不会让任何序列出现 `0`。

### 缓存 / Cache

响应按进程内缓存 **30 秒**。命中缓存时 `series` 与其余字段一起原样返回，
不会先返回旧字段、再异步补 `series`。开关 `public_status_enabled = 0` 的判断
在缓存之前，关闭后立即 404（即使有旧缓存）。

English: the response is cached in-process for 30 seconds and `series` is cached
together with everything else — a cache hit never returns a payload with a
missing or partial `series`. The `public_status_enabled = 0` check runs before
the cache, so disabling the page returns 404 immediately even if a cached value
exists.

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
- `server_samples.latency_ms` 由迁移 `0020` 加入，`rx_bps` / `tx_bps` 由 `0053`
  加入；采样任务（`repo::server_samples::record_round`）每轮一起写入。
- `series` 本身**不需要新迁移**：它是对已有列的只读聚合。历史行没有对应值时
  自然是 `NULL`，接口按 `null` 返回。

English: `server_samples` was created by migration `0018`; `latency_ms` was added
by `0020`, `rx_bps` / `tx_bps` by `0053`, and the sampler writes them together.
`series` needs no new migration — it is a read-only aggregation over existing
columns, and legacy rows simply have `NULL`.

### 响应示例 / Example

```jsonc
{
  "panel_name": "Pierwave",
  "generated_at": 1763703499,
  "summary": { "servers_total": 3, "servers_online": 2, "nodes_total": 7,
               "traffic_today": 123456789, "traffic_month": 9876543210 },
  "servers": [ /* ... */ ],
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

示例里被 `null` 占据的桶表示「那一轮没有任何在线采样」；数值只用于说明形状，
不是固定值。速率单位是**字节/秒**，不是 bit/s。
