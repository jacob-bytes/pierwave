# 自动汇率与服务器态势 / Automatic FX rates and server health

本文覆盖两条只读/后台能力：成本视图用的 **自动汇率**，以及管理员用的
**服务器态势聚合**。两条都不新增数据库迁移：汇率复用 `settings` 表，
态势聚合只读现有 `server_samples`。

This document covers two capabilities: the **automatic FX cache** used by the
cost view, and the admin **server-health aggregate**. Neither needs a migration:
FX lives in the existing `settings` table, and the health aggregate only reads
`server_samples`.

---

## 1. 自动汇率 / Automatic FX rates

### 缓存形状 / Cache shape

设置键 `fx_rates`（`settings` 表，key/value TEXT），值是 JSON：

```json
{
  "base": "CNY",
  "rates": { "USD": 7.2, "EUR": 7.8, "JPY": 0.048 },
  "fetched_at": 1763700000,
  "source": "open.er-api.com"
}
```

- `rates` 的语义是 **1 单位外币 = 多少 CNY**（已从上游反向报价换算）；
- `fetched_at` 是最近一次成功抓取/手动覆盖的 Unix 秒；过期判断只看它；
- `source` 是 `open.er-api.com` 或 `manual`（管理员覆盖不冒充上游）；
- 空串 / 缺失 = 从未抓到过。

English: the setting stores CNY-per-foreign-unit rates, the fetch/override
timestamp, and a source. Empty means "never fetched".

### 抓取与失败回退 / Fetch and fallback

- 上游：`https://open.er-api.com/v6/latest/CNY`，无需 API key；
  上游返回 `rates: {"USD": 0.139, ...}`（1 CNY = x 外币），缓存时换算成
  `1 / x`。
- 调度：启动后立即检查一轮；`fetched_at` 缺失或超过 24 小时才真正抓取；
  之后每 6 小时检查一次，超过 24 小时才抓。判定逻辑在
  `pierwave_domain::fx::is_due`（正好 24 小时不算「超过」）。
- 安全：只允许 `https://`；curl 连接/整体超时均为 5 秒；响应体沿用全局
  16 MiB 上限。
- 校验：JSON 必须是 `result = "success"`、`base_code = "CNY"`；每个报价必须是
  有限数字且落在 `0.0001..=10000`，反算后的汇率也在同一范围；`USD/EUR/JPY`
  必须存在。**必需币种越界/非数字 → 整轮失败**；其它币种越界/非数字 → 丢弃
  （上游真实响应含 IRR 这类反算约 26 万的极端报价，整轮拒绝会让自动汇率永远
  失败）。
- 失败策略：网络、超时、非 2xx、坏 JSON、缺币种、越界任何一步失败都**只记
  warn、不写库**，旧缓存继续生效；启动不会因为抓取失败而失败。
- 未知币种：上游返回的其它币种照常保存；前端按「汇率表里没有就不计入」展示。
- **没有新增 HTTP 客户端依赖**：master 已有的版本检测/告警/WebDAV 都走系统
  `curl` 子进程，汇率沿用同一模式（`--proto =https`、超时、响应体上限），
  生产路径是真实请求，测试注入 fetcher，绝不联网。

English: the scheduler checks immediately at startup and every 6 hours, fetching
only when the cache is missing or older than 24 hours. Requests are https-only,
time out after 5 seconds, and reuse the global 16 MiB response cap. Any failure
(network, timeout, non-2xx, malformed JSON, missing required currency, out-of-range
rate) logs a warning and keeps the previous cache. No new HTTP client dependency
is introduced: like the existing release check, alerts and WebDAV, production
shells out to `curl`; tests inject a fetcher and never touch the network.

### 设置接口 / Settings API

`GET /api/v1/settings`（仅管理员）新增两个字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `fx_rates` | string | 上述 JSON 的**字符串**形式（与 `settings` 表 key/value TEXT 同形），前端 `JSON.parse` 使用；从未抓取为 `""` |
| `fx_rates_updated_at` | int | `fx_rates.fetched_at`，Unix 秒；从未抓取为 `0`；**只读** |

`PATCH /api/v1/settings` 接受 `fx_rates`：

- 值可以是 JSON 对象或 JSON 字符串；
- 用与自动抓取相同的形状/范围/必填币种校验；
- 服务端重写 `fetched_at = now`、`source = "manual"`，并因此更新
  `fx_rates_updated_at`；
- 非法值返回 400 `settings.fx_rates_invalid`（`params.reason` 是具体错误码），
  **不会覆盖旧缓存**；
- `fx_rates_updated_at` 不能作为 PATCH 键（400 `settings.unknown_key`）。

English: `GET /settings` exposes `fx_rates` as a JSON string plus read-only
`fx_rates_updated_at`. `PATCH` accepts an object or a JSON string with the same
validation, rewrites the timestamp/source to the manual override, and rejects
bad values with 400 without touching the old cache.

### 手动覆盖与自动抓取的先后 / Manual vs automatic

**手动覆盖后 24 小时内自动任务不会覆盖；满 24 小时后自动任务重新接管。**

实现上手动覆盖和自动抓取共用 `AppState` 里的一把异步锁：自动抓取在持锁期间
完成「读缓存 → 判断过期 → 联网 → 写库」，手动覆盖在写库前拿同一把锁。因此
不存在「手动刚保存、一轮更早开始的抓取又把旧结果盖回去」。

**为什么不加 `fx_auto` 开关**：自动汇率只是成本视图的辅助数据，多一个开关
会让「为什么汇率不动了」变成第二种故障原因；当前语义（手动值 ≈ 一次成功
抓取，24 小时后恢复自动）只有一条规则，前端和排障都简单。手动覆盖适合短期
修正错误汇率或固定内部结算价，长期固定值应通过上游/代理解决。

English: a manual override wins for 24 hours; after that the automatic fetcher
takes over again. Manual writes and automatic rounds share one async lock, so an
in-flight fetch can never clobber a just-saved override. There is deliberately no
`fx_auto` switch: a manual override behaves exactly like a successful fetch, so
there is only one rule to reason about.

### 错误码 / Error codes

`fx.not_https`、`fx.invalid_json`、`fx.invalid_shape`、`fx.missing_currency`、
`fx.invalid_currency`、`fx.invalid_rate`、`fx.rate_out_of_range`、`fx.timeout`、
`fx.network`、`fx.http`；设置接口对外统一映射为
`settings.fx_rates_invalid`。

---

## 2. 服务器态势 / Server health

### 接口 / Endpoint

`GET /api/v1/overview/server-health?hours=168&bucket=3600`（`require_admin`）：

```json
{
  "generated_at": 1763700000,
  "hours": 168,
  "bucket": 3600,
  "summary": {
    "online_ratio_24h": 0.964,
    "abnormal_servers": 3,
    "worst_disk_ratio": 0.91
  },
  "servers": [{
    "id": "…",
    "name": "香港-01",
    "online_ratio": 0.98,
    "buckets": [
      { "ts": 1795161600, "online": true, "load1": 0.42, "mem_ratio": 0.42, "disk_ratio": 0.53 },
      null
    ]
  }]
}
```

### 参数 / Parameters

| 参数 | 默认 | 约束 |
|---|---|---|
| `hours` | `24` | 1..=168（采样只保留 7 天） |
| `bucket` | `3600` | `300..=86400`，且必须是 300 的倍数、能整除 `hours*3600` |

非法参数统一 400：`query.server_health_hours_invalid` /
`query.server_health_bucket_invalid`。非管理员 403，未登录 401。

### 聚合口径 / Semantics

- `buckets` 长度固定 = `hours * 3600 / bucket`；最后一个桶是**当前桶**（可能只过了
  一部分），没有采样的桶是 `null`（不是 0）。
- 桶内在线判定：`AVG(online) >= 0.5`，即**多数采样在线**；5 分钟粒度下平局
  只可能出现在偶数个采样时，平局算在线（与「离线时段进入可用率分母」的直觉
  一致）。实现用 `online_samples * 2 >= samples`，避免浮点比较。
- `load1`、`mem_ratio`、`disk_ratio` 取桶内平均；`mem_total` / `disk_total` 为 0
  的旧采样不参与对应平均，因此可能是 `null` 而不是 0。
- `online_ratio`（每台服务器）是请求窗口内 `SUM(online) / COUNT(*)`，按采样数
  加权；窗口内没有采样时为 `null`。
- `summary.online_ratio_24h` 独立于 `hours`：总是按最近 24 小时、按采样数加权；
  没有采样时为 `null`。
- `summary.worst_disk_ratio` = 最近 24 小时单次采样的最大磁盘占用比；没有有效
  分母时为 `null`。
- `summary.abnormal_servers`：最近 24 小时可用率 `< 90%`，或最坏磁盘 `>= 90%`
  的服务器数；窗口内完全没有采样的服务器不计（新机器不应先被标异常）。
- `generated_at` 是本次聚合时间（缓存命中时是缓存生成时间）。

English: fixed-length buckets (current partial bucket last), `null` for no data,
majority-online (ties online), averaged load/memory/disk, sample-weighted
per-server and 24 h uptime, worst single-sample disk in 24 h, and abnormal =
24 h uptime < 90% or worst disk >= 90%. Servers with no samples in the window
are not counted as abnormal.

### 查询与索引 / Queries and index

两条查询都是**跨服务器一次 `GROUP BY`**，服务器数增加时查询次数不变：

```sql
-- 24h 汇总（每台服务器一行）
SELECT server_id, COUNT(*) AS samples, SUM(online) AS online_samples,
       MAX(CASE WHEN disk_total > 0
                THEN CAST(disk_used AS REAL) / disk_total END) AS worst_disk_ratio
FROM server_samples
WHERE ts >= ? AND ts <= ?
GROUP BY server_id;

-- 请求窗口的桶（只返回有采样的 (server, bucket)）
SELECT server_id, (ts / ?) * ? AS ts, COUNT(*) AS samples,
       SUM(online) AS online_samples, AVG(load1),
       AVG(CASE WHEN mem_total > 0
                THEN CAST(mem_used AS REAL) / mem_total END),
       AVG(CASE WHEN disk_total > 0
                THEN CAST(disk_used AS REAL) / disk_total END)
FROM server_samples
WHERE ts >= ? AND ts < ?
GROUP BY server_id, (ts / ?) * ?;
```

`EXPLAIN QUERY PLAN`（迁移 0018 的索引）：

```
|--SEARCH server_samples USING INDEX idx_server_samples_ts (ts>? AND ts<?)
`--USE TEMP B-TREE FOR GROUP BY
```

即时间窗口走 `idx_server_samples_ts` 区间扫描，`GROUP BY` 用临时 B 树聚合；
不会按服务器循环，也不会全表扫描。域层测试
`repo::server_samples::tests::health_queries_use_the_timestamp_index` 锁定该计划。

### 缓存 / Cache

结果缓存 **30 秒**，key = `(hours, bucket)`。理由：采样本身 5 分钟才写一行，
30 秒不会让页面明显滞后，却能把多个管理员同时刷新时的 7 天窗口聚合压成一次。
缓存是 TTL 语义、不做写穿透；`generated_at` 与 body 一起缓存，保证同一份数据
的时间戳一致。响应头 `X-Server-Health-Cache: hit|miss` 便于排障。

English: a 30-second TTL cache keyed by `(hours, bucket)`; samples arrive every
five minutes, so 30 seconds hides no meaningful change while collapsing
concurrent admin refreshes into one window aggregation.

### 未做项 / Out of scope

- 不做多路径/多链路的服务器态势合并（当前按单台服务器聚合）；
- 不做跨服务器的同小时总负载曲线（本接口只给每台服务器的桶）；
- 不新增采样表或迁移；7 天保留期由现有采样任务维护。
