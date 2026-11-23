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
    "worst_hop": { "chain_id": "…", "chain_name": "港日中转链", "seq": 3, "p50_ms": 58 },
    "loss_pct": 0.8333,
    "worst_loss": { "chain_id": "…", "chain_name": "港日中转链", "loss_pct": 0.8333 }
  },
  "chains": [{
    "id": "…", "name": "港日中转链", "hops": 4,
    "entry": { "server_id": "…", "server_name": "香港-01",
               "address": "203.0.113.11:443", "ip": "203.0.113.11", "port": 443 },
    "exit":  { "server_id": "…", "server_name": "大阪-01",
               "address": "198.51.100.21:21004", "ip": "198.51.100.21", "port": 21004 },
    "estimated": false,
    "missing_hops": [4],
    "series": [ { "ts": 1795312800, "p50": 71, "p10": 69, "p90": 74, "samples": 9, "loss_pct": 0.8 }, null ],
    "segments": [
      { "seq": 1, "from": "香港-01", "to": "东京-01",
        "series": [ { "ts": 1795312800, "p50": 16.0, "loss_pct": 0.8333 }, null, "…" ],
        "p50": 16.0, "delta_ms": 0.0, "contribution_pct": 0,
        "attempts": 240, "failures": 2, "loss_pct": 0.8333 },
      { "seq": 3, "from": "新加坡-01", "to": "大阪-01",
        "series": [ { "ts": 1795312800, "p50": 58.0, "loss_pct": 0.0 }, null, "…" ],
        "p50": 58.0, "delta_ms": 25.0, "contribution_pct": 100,
        "attempts": 240, "failures": 0, "loss_pct": 0.0 }
    ],
    "loss_pct": 0.8333,
    "loss_samples": { "attempts": 480, "failures": 2 },
    "loss_partial": false,
    "diagnosis": { "kind": "single_hop", "seq": 3 }
  }],
  "scope": { "server_ids": [], "servers_matched": 0, "filtered": false },
  "warnings": { "unknown_ids": [], "unmapped_forwards": 0 }
}
```

`entry` / `exit` 是链的展示起点/终点（口径见 §1.1）；链没有任何组或组内没有
成员时是 `null`。`series` 固定长度 = `hours*3600/bucket`，从旧到新；没有样本
的桶是 `null`，不是 0。`segments[].p50` / `delta_ms` / `segments[].series[]`
无数据时同样是 `null`。

## 1.1 起点与终点

`entry` / `exit` 只做展示，不参与链下发与探测口径；它们是**原链**的入口/出口，
与 `server_ids` 筛选无关（见 §5）。

- **起点**：第一个组（`seq` 最小）里优先级最高的成员。优先级按
  `(priority ASC, server_id ASC)` 稳定排序，所以 `priority` 相同时取
  `server_id` 较小的一台，与成员插入顺序无关。
  - 端口优先用 `chain_groups.public_port`；该字段为空（`null`）时回退该成员的
    `chain_group_members.listen_port`。`public_port` 只用于展示，链下发仍只用
    `listen_port`。
  - 地址 = `servers.address` + 该端口。
- **终点**：最后一个组里优先级最高的成员（同一排序规则），端口**恒为**该成员的
  `listen_port`——最后一跳由它监听并连链目标，没有 `public_port` 概念。
- **地址兜底**：
  - `servers.address` 为空或全空白时，回退 `servers.internal_address`，并在该
    端点上输出 `"address_source": "internal"`。公网地址正常时**省略**
    `address_source` 字段；
  - 两者都没有时 `ip` / `address` 都是 `null`，`port` 仍按上述口径返回；
  - 端口缺失或非正数（脏数据）时 `address: null`、`port: null`，但保留 `ip`，
    前端仍能展示主机名；
  - 组内没有成员时对应的 `entry` / `exit` 是 `null`。
- **格式**：统一 `ip:port`；IPv6 写 `[ip]:port`，而 `ip` 字段本身不带方括号。
  主机名按原样输出。不做 DNS 解析。

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
- 丢包用 `forward_probe_samples`，它是**每跳入口**的探测次数/失败次数，
  与上面同一套「组 → 成员 → forward」映射：源组每个成员的 forward 记为
  该段的一次探测；最后一组的 forward 探测的是链目标（没有下一组），不归入
  任何段。多路径时先把同段各成员的 attempts / failures 相加再算比值。

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

### 4.1 丢包

口径：**探测失败率**的近似，不是业务报文的真实丢包率（见
`docs/TELEMETRY.md`）。探测计数由 Agent 心跳上报，主控按 5 分钟桶存增量。

- **窗口**：只看**当前窗口**（最近 2 小时，`CURRENT_WINDOW_SECS`，按
  `bucket` 对齐），与逐段 p50 的当前值完全同一个窗口；`hours < 2` 时退化为
  请求窗口。`series[].loss_pct` 按每个时间桶单独算（见下）。两者都不使用
  24h 丢包基线；
- **单段**：`loss_pct = failures / attempts × 100`，保留 4 位小数
  （2/240 = 0.8333）。`attempts = 0` 时 `loss_pct = null`，**不是 0**：补 0
  会被读成「这段完全不丢包」；
- **整链**：各跳独立，`loss_pct = 1 - Π(1 - loss_i)`（同样保留 4 位）。
  例如两段各 1% → 1.99%，不是相加的 2%；
- **缺段**：任一段 `loss_pct = null` 时跳过该段，整链数字只覆盖有数据的段。
  `loss_partial` 只在「至少一段有数据、且至少一段缺数据」时为 `true`；
  全部段都缺数据时整链 `loss_pct = null`、
  `loss_samples = { "attempts": 0, "failures": 0 }`、**`loss_partial: false`**
  （否则会和「无探测数据」自相矛盾）；全部段都有数据时同样是 `false`；
- **`series[].loss_pct`（该时刻）**：每个时间桶各自算整链丢包，各段取
  **同一 `ts` 桶**的 attempts/failures 连乘（与 `p50` 同桶对齐）。某段该桶
  没探测就跳过；整桶所有段都没探测 → `loss_pct: null`。桶级**没有**
  partial 字段，缺失只由 `null` 表达。它和链级 `loss_pct`（当前 2h 窗口
  聚合值）是两个不同口径，不要混用；
- **`loss_samples`**：参与连乘的各段 attempts / failures **之和**（原始计数，
  不是比率）；`loss_pct` 是连乘结果，所以一般不等于
  `failures / attempts`；
- **`server_ids`**：与筛选同样的语义——只对保留的链取 forward 样本，未选中
  的链不会进入 `summary`；
- **`summary.loss_pct` / `worst_loss`**：当前可见（筛选后）链里丢包最高的
  一条及其 id / 名称；同值按 `chain_id` 稳定排序。没有任何可用丢包数据时
  两项都是 `null`。

### 4.2 逐段时间序列

`segments[].series` 把段级数据按时间桶展开，口径与链级 `series` 对齐：

- **长度与桶宽**：与链级 `series` 完全相同——长度 `hours*3600/bucket`，桶宽
  `bucket`，从旧到新，`ts` 是该桶起点；
- **p50**：该段在该桶内所有 forward 时延样本的 p50（与段级当前值同一批样本，
  只在时间上再切桶）。该段该桶**没有样本时整个元素是 `null`**，不是
  `{ "p50": 0 }`；只有探测、没有时延样本的桶同样是 `null`；
- **loss_pct**：该段在该桶的探测桶 `failures / attempts × 100`，保留 4 位小数。
  `attempts = 0` 时是 `null`，**不补 0**（补 0 会被读成“完全不丢包”）。有时延
  样本但该桶没有探测时元素仍存在，`p50` 有值、`loss_pct: null`；
- **多成员段**：同一段的多个成员在同一个桶内的时延样本一起算 p50；探测
  attempts / failures 先相加再算比值（与段级当前值同一口径）；
- **与链级序列的关系**：链级 `series[]` 只在**所有段**该桶都有样本时非 null，
  段级序列则是每段各自的可见性；两者不能互相推导；
- **性能**：段级序列完全由同一批 `forward_latency_samples` /
  `forward_probe_samples` 内存归并得到，**不按段发 SQL**。查询次数与段数无关。

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

查询次数固定，与链数/成员数/段数无关：

1. `chains`：`SELECT * FROM chains ORDER BY created_at ASC, rowid ASC`；
2. `chain_groups`：全部组一次读出；
3. `chain_group_members` JOIN `servers`：全部成员一次读出（`entry` / `exit`
   的地址、内网地址、端口、优先级都来自这一条）；
4. `forward_latency_samples`：所有成员 forward id 一次 `IN (...)`，时间下界
   覆盖 `series` 与 24h 基线中更老的一侧；
5. `forward_probe_samples`：同一批 forward id 在 `series` 窗口内的 5 分钟
   探测桶，一次 `IN (...)` 读出；逐桶丢包在内存里按 `bucket` 再合并。

起点/终点与逐段 `series` 都是这批结果的纯内存归并，**没有新增查询**，也不按
段/按桶循环查库。

在 `data/preview.db`（迁移建库、不跑 `ANALYZE`）上实测：

```
-- 链列表
SCAN chains USING INDEX idx_chains_created

-- 全部组（list_topology 的实际 SQL；SCAN ... USING INDEX 是按索引顺序读）
SCAN chain_groups USING INDEX idx_chain_groups_chain

-- 全部成员（同一次 JOIN 里带上 servers 的地址/内网地址）
SCAN m USING INDEX sqlite_autoindex_chain_group_members_1
SEARCH g USING INDEX sqlite_autoindex_chain_groups_1 (id=?)
SEARCH s USING INDEX sqlite_autoindex_servers_1 (id=?)
USE TEMP B-TREE FOR ORDER BY

-- 时延样本（4 个 forward id）
SEARCH forward_latency_samples USING INDEX idx_forward_latency_samples_forward_ts (forward_id=? AND ts>?)
USE TEMP B-TREE FOR ORDER BY

-- 每跳探测桶（同一批 forward id，series 窗口）
SEARCH forward_probe_samples USING INDEX idx_forward_probe_samples_forward_ts (forward_id=? AND ts>? AND ts<?)
USE TEMP B-TREE FOR ORDER BY
```

没有 `SCAN forward_latency_samples` / `SCAN forward_probe_samples` 全表扫描；
`IN (...)` 对每个 forward id 各做一次 `(forward_id, ts)` 区间探测。
`SCAN chain_groups USING INDEX ...` 是按索引顺序扫描，不是整表扫描。
`ORDER BY` 的临时 B 树只排序本窗口命中的行，不是全表。`EXPLAIN QUERY PLAN`
的完整输出在 `crates/domain/tests/query_plan.rs` 的回归里也以同样 SQL 形状
锁定（含 `forward_probe_samples` 的逐桶查询；那里用的是单链 `chain_id=?` 形状，
与 `list_topology` 的全量读走同一批索引）。

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
- 最近 24h、每 5 分钟一桶的 `forward_probe_samples`（10 个 forward ×
  289 个桶 = 2890 条）：
  - 港日中转链第 2 段（东京-01 → 新加坡-01）最近 2h 每桶 `7/240 ≈ 2.92%`；
  - 其余段 `<0.2%`（每 3 个桶 1 次失败，`1/240 ≈ 0.14%`）；
  - 整链连乘约 `3.2%`，用于对照「单段丢包 vs 整链」；
  - 最后一跳到链目标的探测也写入，聚合时不会归到任何段。

重复执行幂等：固定 id + 先删后插；只写 `data/preview.db`，不碰
`data/pierwave.db`。

## 8. 测试

- 领域层（`crates/domain/src/chain_health.rs`）：单跳、多跳、多路径估算、
  缺最后一跳、空样本、无成员链、部分桶不补 0、单段变慢的
  `contribution_pct` / `diagnosis`、整体均匀变慢；丢包的 attempts=0 → null、
  单段 2/240 = 0.8333、两段各 1% → 1.99、缺段跳过；全无数据 → null +
  `loss_partial=false`、部分段有数据 → 连乘 + `loss_partial=true`、
  最后一跳不计入段、多路径先加计数再算比值、`summary` 取最差链；
  `series[].loss_pct` 两个桶不同失败率 → 不同值、无探测桶 → null；
  起点/终点覆盖单成员、多成员按 `(priority, server_id)` 选第一台、
  `public_port` 为空回退 `listen_port`、内网地址兜底 + `address_source`、
  IPv6 方括号、缺端口保留 `ip`、空组 → `null`；逐段序列与链级同长、缺桶
  null、`attempts=0` → loss null、有时延无探测 → loss null、有探测无时延 →
  整桶 null、多成员同桶合并；
- 路由层（`crates/master/src/routes/chain_health.rs`）：单跳/多跳映射、
  最后一跳不伪装 0、段/整链丢包与时延回归、`series[]` 逐桶丢包、
  `entry` / `exit` 的 `public_port` 与 `listen_port` 口径、多成员优先级、
  `server_ids` 筛选后 entry/exit 仍取原链首尾、筛选后只汇总保留的链、
  筛选（命中/未知/空数组/非法/201 个 id）、非法 `hours`/`bucket`、缓存 key
  隔离、非管理员 401/403；
- 查询计划（`crates/domain/tests/query_plan.rs`）：`forward_probe_samples`
  的逐桶查询必须走 `idx_forward_probe_samples_forward_ts`，不允许全表扫描；
- 缓存层（`crates/master/src/state.rs`）：`(hours, bucket, 筛选)` 三维
  key 隔离、TTL、禁用。

## 9. 未做

- 不新增表/迁移：现有 `forward_latency_samples` + 链组映射足够；最后一跳到
  目标仍没有可靠历史，只声明 `missing_hops`；
- 逐段序列只给 `p50` + `loss_pct`，不返回 `p10` / `p90` / `samples`，也不做
  段级 24h 基线；热力图需要更多分布字段时要再扩契约；
- 丢包不单独提供曲线/基线：链级逐桶值随 `series[]`、段级逐桶值随
  `segments[].series[]` 一起返回，链级/段级当前值都取最近 2h 窗口，不做 24h
  丢包基线；
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

`entry` / `exit` are display-only endpoints of the **original** chain (they are
not affected by `server_ids` filtering; see below).

- **Entry**: the highest-priority member of the first group (smallest `seq`),
  ordered by `(priority ASC, server_id ASC)` so equal priorities are broken by
  server id, not insertion order. Its port is `chain_groups.public_port` when
  set; when it is `null` the member's `chain_group_members.listen_port` is used.
  `public_port` is display-only; the desired state still uses `listen_port`.
- **Exit**: the highest-priority member of the last group (same ordering). Its
  port is always that member's `listen_port`—the final hop listens there and
  connects to the chain target, so `public_port` does not apply.
- **Address fallback**: the address is `servers.address:port`. When
  `servers.address` is empty or whitespace-only, `servers.internal_address` is
  used instead and the endpoint carries `"address_source": "internal"`. The
  field is omitted when the public address is used. When neither address exists,
  `ip` and `address` are `null` while `port` is still reported as described
  above. A missing or non-positive port (dirty data) makes `address` and `port`
  `null` but keeps `ip`. Groups without members produce `entry` / `exit: null`.
- **Format**: `ip:port`, with IPv6 written as `[ip]:port` (`ip` itself has no
  brackets). Hostnames are returned verbatim; no DNS resolution is performed.

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

Loss is added per segment, per chain and in the summary. `forward_probe_samples`
stores per-hop entry probes using the same group → member → forward mapping as
the latency samples; the final group's forward probes the chain target and is
therefore not attributed to any segment. For multi-member groups the attempts
and failures are summed before dividing. A segment's `loss_pct` is
`failures / attempts × 100` rounded to 4 decimals; `attempts = 0` yields `null`,
never 0. The chain value assumes independent hops:
`loss_pct = 1 - Π(1 - loss_i)` (two segments at 1% give 1.99%, not 2%). Segments
without probe data are skipped. `loss_partial` is `true` only when at least one
segment has data and at least one does not; a chain with no probe data at all
has `loss_pct: null`, `loss_samples: { "attempts": 0, "failures": 0 }` and
`loss_partial: false` (never both "no data" and "partially probed"), and a fully
probed chain also uses `false`. `loss_samples` sums the raw counts of the
segments that entered the product, so it is not generally equal to
`failures / attempts`. The chain-level `loss_pct` uses the same current 2-hour
window as the segment p50 (or the request window when `hours < 2`), aligned to
`bucket`. Each non-null `series[]` point additionally carries `loss_pct` for
**that time bucket**: the same `1 - Π(1 - loss_i)` product over the segments'
probe counts in the same `ts` bucket. A segment without probes in that bucket
is skipped; a bucket where no segment has probes is `loss_pct: null` (there is
no per-bucket partial flag—missing data is expressed by `null` alone). The
series value and the chain-level window value are different measures and must
not be mixed. No 24-hour loss baseline is produced. `summary.loss_pct` is the
highest chain loss among the visible (filtered) chains and `worst_loss` names
that chain (id, name, loss); both are `null` when no chain has usable probe
data.

`segments[].series` expands each segment over the same time axis as the
chain-level `series`: identical length (`hours*3600/bucket`), identical bucket
width, oldest first, with `ts` at the bucket start. A point's `p50` is the p50
of that segment's forward latency samples in that bucket (the same sample set
as the segment's current value, sliced by time). A bucket with no samples for
that segment is `null`, never `{ "p50": 0 }`; a bucket with probes but no
latency samples is also `null`. The point's `loss_pct` is that segment's
`failures / attempts × 100` in that bucket, rounded to 4 decimals; `attempts = 0`
gives `null`, never 0. A point with latency but no probes keeps its `p50` and
has `loss_pct: null`. For multi-member segments, latency samples in a bucket are
pooled before taking the p50 and probe attempts/failures are summed before
dividing, matching the segment-level rules. The chain-level `series[]` is
non-null only when **all** segments have samples in that bucket; per-segment
series are independent views and cannot be derived from each other. All of this
is computed in memory from the same sample/probe rows—no SQL is issued per
segment—so the query count is independent of the number of segments.

Performance: three topology queries (chains / groups / members), one
`forward_latency_samples` query with `forward_id IN (...)`, and one
`forward_probe_samples` query reading the 5-minute buckets across the series
window with `forward_id IN (...)`; no N+1. Entry/exit and the per-segment series
add no queries—they are derived from those same rows in memory. On the preview
database `EXPLAIN QUERY PLAN` shows `SCAN chains USING INDEX idx_chains_created`,
`SCAN chain_groups USING INDEX idx_chain_groups_chain` (an index-order scan, not
a full table scan), the `chain_group_members` primary-key index plus primary-key
lookups on `chain_groups` and `servers`,
`idx_forward_latency_samples_forward_ts (forward_id=? AND ts>?)`, and
`idx_forward_probe_samples_forward_ts (forward_id=? AND ts>? AND ts<?)` plus a
temporary B-tree for the ordered result; there is no full table scan of either
samples table. The response is cached for 30 seconds in `ChainHealthCache` keyed
by `(hours, bucket, normalized request server_ids)` (unknown ids included
because `scope` / `warnings` are cached with the body), with
`X-Chain-Health-Cache: hit|miss`.

`scripts/seed-preview.sh` adds 3 chains / 9 groups / 10 members, 24 hours of
5-minute latency samples (2384 rows), and 24 hours of per-hop probe samples
(2890 rows: 10 forwards × 289 buckets). The third segment of 港日中转链 is +25ms
for the last 2 hours; the second segment's probe failure rate is about 2.92% for
the last 2 hours (7/240 per bucket) while the other segments stay below 0.2%
(1/240 every third bucket), so the compounded chain loss is about 3.2%. The
final-hop samples are present to prove they are neither summed nor counted as
unmapped. The script is idempotent and only writes `data/preview.db`.

Tests cover single-hop, multi-hop, multi-path estimation, missing final hop,
empty samples, chains without members, partial buckets, single-segment and
uniform slowdowns, loss edge cases (`attempts = 0` → `null`, 2/240 = 0.8333,
two 1% segments → 1.99%, missing segment → `loss_partial`, no probe data at all
→ `null` + `loss_partial: false`, per-bucket `series[].loss_pct` differing
between buckets and `null` for a bucket without probes, final hop ignored,
multi-member counts summed), entry/exit (single member, multi-member priority,
`public_port` → `listen_port` fallback, internal-address fallback with
`address_source`, IPv6 bracketing, missing port keeping `ip`, empty groups →
`null`), per-segment series (same length as the chain series, missing buckets
`null`, `attempts = 0` → `loss_pct: null`, probes without latency → `null`,
multi-member buckets pooled), summary worst-loss selection, filtering
(hit/unknown/empty/invalid/201 ids), entry/exit preserved under `server_ids`
filtering, loss under `server_ids` filtering, latency regression, bad
`hours`/`bucket`, cache-key isolation, query plans, and 401/403. No migration is
added; no `web/`, `agent/` or `proto/` changes are made.
