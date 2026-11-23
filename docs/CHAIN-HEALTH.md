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
  "generated_at": 1795450991, "hours": 24, "bucket": 900,
  "summary": {
    "hop_p50_ms": 44, "delta_ms": 0, "slow_chains": 0, "total_chains": 3,
    "worst_hop": { "chain_id": "…", "chain_name": "港新直达链", "seq": 1, "p50_ms": 37 },
    "loss_pct": 3.0638,
    "worst_loss": { "chain_id": "…", "chain_name": "港日中转链", "loss_pct": 3.0638 }
  },
  "chains": [{
    "id": "…", "name": "港日中转链", "hops": 4,
    "entry": { "server_id": "…", "server_name": "香港-01",
               "address": "203.0.113.11:21001", "ip": "203.0.113.11", "port": 21001 },
    "exit":  { "server_id": "…", "server_name": "大阪-01",
               "address": "198.51.100.23:21004", "ip": "198.51.100.23", "port": 21004 },
    "nodes": [
      { "seq": 0, "server_id": "…", "name": "香港-01", "role": "source", "status": "online" },
      { "seq": 1, "server_id": "…", "name": "东京-01", "role": "hop", "status": "online" },
      { "seq": 2, "server_id": "…", "name": "新加坡-01", "role": "hop", "status": "online" },
      { "seq": 3, "server_id": "…", "name": "大阪-01", "role": "hop", "status": "offline" },
      { "seq": 4, "server_id": null, "name": "链目标", "role": "target", "status": null }
    ],
    "estimated": false,
    "missing_hops": [],
    "status": { "kind": "blocked", "cause": "node_offline",
                "node": { "seq": 3, "name": "大阪-01" } },
    "series": [ null, "…", { "ts": 1795443300, "p50": 81.0, "p10": 74.6, "p90": 84.2,
                             "samples": 10, "loss_pct": 3.8577 }, "…", null ],
    "segments": [
      { "seq": 1, "from": "香港-01", "to": "东京-01",
        "series": [ null, "…", { "ts": 1795450500, "p50": 14.5, "loss_pct": 0.4167 }, "…" ],
        "p50": 15.5, "delta_ms": 0.0, "contribution_pct": 0,
        "attempts": 5280, "failures": 8, "loss_pct": 0.1515 },
      { "seq": 2, "from": "东京-01", "to": "新加坡-01",
        "series": [ null, "…", { "ts": 1795450500, "p50": 20.5, "loss_pct": 2.9167 }, "…" ],
        "p50": 21.5, "delta_ms": 0.0, "contribution_pct": 0,
        "attempts": 5280, "failures": 154, "loss_pct": 2.9167 },
      { "seq": 3, "from": "新加坡-01", "to": "大阪-01",
        "series": [ null, "…", { "ts": 1795443300, "p50": 33.0, "loss_pct": 0.4167 }, "…", null ],
        "p50": null, "delta_ms": null, "contribution_pct": 0,
        "attempts": 0, "failures": 0, "loss_pct": null },
      { "seq": 4, "from": "大阪-01", "to": "链目标",
        "series": [ null, "…", { "ts": 1795443300, "p50": 8.0, "loss_pct": 0.4167 }, "…", null ],
        "p50": null, "delta_ms": null, "contribution_pct": 0,
        "attempts": 0, "failures": 0, "loss_pct": null }
    ],
    "loss_pct": 3.0638,
    "loss_samples": { "attempts": 10560, "failures": 162 },
    "loss_partial": true,
    "diagnosis": { "kind": "unknown" }
  }],
  "scope": { "server_ids": [], "servers_matched": 0, "filtered": false },
  "warnings": { "unknown_ids": [], "unmapped_forwards": 0 }
}
```

（片段取自预览库：大阪-01 已离线，所以第 3 / 最后一跳与最近 2h 的链级
桶都是 `null`，链状态是 `blocked`。）

`entry` / `exit` 是链的展示起点/终点（口径见 §1.1），保留不删；`nodes` 是
完整的拓扑节点（口径见 §1.2）；`status` 是链级可用性状态（口径见 §1.3）。
链没有任何组或组内没有成员时 `entry` / `exit` 是 `null`。`series` 固定长度
= `hours*3600/bucket`，从旧到新；没有样本的桶是 `null`，不是 0。
`segments[].p50` / `delta_ms` / `segments[].series[]` 无数据时同样是 `null`。

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

## 1.2 拓扑节点（`nodes`）

`nodes` 按 `seq` 升序给出整条链的拓扑：每个组一个节点，末尾再补一个链目标节点。

```jsonc
"nodes": [
  { "seq": 0, "server_id": "…", "name": "香港-01", "role": "source", "status": "online" },
  { "seq": 1, "server_id": "…", "name": "东京-01", "role": "hop", "status": "online" },
  { "seq": 2, "server_id": null, "name": "链目标", "role": "target", "status": null }
]
```

- **role**：第一组是 `source`，其余组是 `hop`，链目标节点是 `target`；
- **server_id / name**：组节点取该组 `(priority, server_id)` 最小的成员（与
  `entry` / `exit` 同口径，`priority` 小的优先，同优先级按 `server_id` 稳定
  排序）。多成员组只展开这一个代表成员，其他成员不进 `nodes`；链级
  `estimated: true` 表示这一段是按多路径估算的，不表示 `nodes` 只有一台；
- **status**：直接取该成员服务器的 `servers.status`（`online` / `offline` /
  其他库内值），不做二次推断。链目标节点没有服务器行，`server_id` 与
  `status` 都是 `null`；组内没有成员的脏数据也输出 `server_id: null`、
  `status: null`，`name` 回退组名（没有组名时是 `第 N 跳`）；
- **seq**：组节点就是组的 `seq`；链目标节点是「最后一组 `seq` + 1」，与
  `missing_hops` 里最后一跳的编号一致；
- 链目标节点的 `name` 固定为 `链目标`；
- 没有任何组的脏数据返回空数组。

## 1.3 链级可用性状态（`status`）

```jsonc
"status": { "kind": "ok" | "degraded" | "blocked",
            "cause": "node_offline" | "node_unhealthy" | "no_samples" | "slow" | null,
            "node": { "seq": 3, "name": "大阪-01" } | null }
```

`status` 把节点状态与链路数据合成一个用户能直接看的状态。判定**按以下优先级**
（高 → 低，命中即停）：

| 优先级 | 条件 | `kind` | `cause` | `node` |
|---|---|---|---|---|
| 1 | 任一 `role ∈ {source, hop}` 节点的 `status == "offline"` | `blocked` | `node_offline` | 第一台离线节点（`seq` 最小） |
| 2 | 任一 `role ∈ {source, hop}` 节点的 `status != "online"`（`abnormal` / `no_data` / 空组的 `null` 等） | `degraded` | `node_unhealthy` | `null` |
| 3 | 当前 2h 窗口没有「所有段齐全」的整体样本，**或** `missing_hops` 非空 | `degraded` | `no_samples` | `null` |
| 4 | 整体较基线变慢（与 `summary.slow_chains` 同一个 `SLOW_DELTA_MS` = 8ms 阈值） | `degraded` | `slow` | `null` |
| 5 | 其余 | `ok` | `null` | `null` |

- **`target` 不参与判定**：链目标节点没有服务器行，`status` 恒为 `null`；
  这个 `null` 不能把链判成 `node_unhealthy`；
- **节点优先于数据质量**：节点离线必然让相关段在当前窗口缺样本，但结果必须是
  `blocked` / `node_offline`，**不是** `no_samples`。`missing_hops` 仍按 §2 的
  原口径（窗口内完全没有样本）计算，两者回答不同问题：`missing_hops` 说
  「哪一跳没有数据」，`status` 说「这条链现在能不能用」，因此可以自洽共存；
- **`cause = "slow"` 与 `summary.slow_chains` 同口径**：都用
  `当前整体 p50 - 24h 基线整体 p50 ≥ 8ms`，不会出现「summary 说 1 条慢链、
  链上却没有 slow」；
- **`node` 只在 `node_offline` 时出现**，且只带展示用的 `seq` / `name`；
  多台离线时取 `seq` 最小（即拓扑上最先遇到）的那台；
- **既有字段不变**：`segments` / `series` / `loss_pct` / `loss_partial` /
  `diagnosis` / `summary.slow_chains` 等口径都与之前完全一致，`status` 只是
  新增的合成视图，不改变任何数值。

`node_unhealthy` 的 `status` 直取 `servers.status`，所以 `abnormal` /
`no_data` 这类「服务器行存在但不是 online」的值都会命中；预览库里没有造
这类值，由领域层单测覆盖。

## 2. 跳的映射

链的**组**才是「跳」：`hops = chain_groups` 的行数。`hops` 也是段数：
4 组 = 3 个「组与组之间」的段 + 最后 1 段（最后一组 → 链目标）。

- **中间段**：第 N 组 → 第 N+1 组是一段，`segments[].seq` 取**目标组**的
  `seq`（正常链是 1..hops-1）。样本条件：`server_id ∈ group[N].members`
  且 `target_server_id ∈ group[N+1].members`；
- **最后一跳**：最后一组 → 链目标，`segments[].seq = 最后一组 seq + 1`。
  Agent 对最后一组的 forward 目标就是链目标，没有下一台服务器，所以
  `target_server_id` 是空串；`server_id ∈ 最后一组` 且目标为空的样本归到
  这一段。它的 `p50` / `series` / `attempts` / `failures` / `loss_pct` 与
  中间段**完全同形**，段级 `to` 是 `链目标`；
- 旧 Agent 对单成员下一跳走兼容字段，`target_server_id` 是空串；主控按
  「下一组唯一成员」补回。多成员下一组必须带真实 `server_id`，空目标无法
  判断走了哪条路径，计入 `warnings.unmapped_forwards`；
- `missing_hops` 只在**确实没有样本**时才包含最后一跳：该链窗口内既没有
  最后一跳的时延样本、也没有 `forward_probe_samples` 探测桶时，才把
  `最后一组 seq + 1` 写进去；有任一数据就不写。任何情况下都**绝不补 0**。
  如果中间某组没有成员，相邻段也写进 `missing_hops`；
- **多成员组（多路径）**：段内取所有成员样本的中位数，链级
  `estimated: true`；最后一跳也按成员的 `server_id` 分别归属，不会把不同
  服务器的探测混成同一个来源。整体 = 各段中位数之和，是估算值，不是某一条
  真实路径的端到端 RTT；
- **丢包**用 `forward_probe_samples`，它是**每跳入口**的探测次数/失败次数，
  与上面同一套「组 → 成员 → forward」映射：源组每个成员的 forward 记为
  该段的一次探测；最后一组的 forward 探测的是链目标，归到最后一跳段。
  多路径时先把同段各成员的 attempts / failures 相加再算比值。

`warnings.unmapped_forwards` 只统计「本应映射到某段却失败」的样本：多成员
目标却上报空目标、最后一跳却带非空目标（链改过成员后的历史残留）等。
最后一跳用空目标上报是**预期**格式，不计入这个警告。

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
  attempts / failures 先相加再算比值（与段级当前值同一口径）。最后一跳也
  一样：`server_id ∈ 最后一组`、`target_server_id` 为空的样本属于它；
- **最后一跳**：与中间段同长同形；有最后一跳时延样本的桶会参与链级
  `series`「所有段齐全」的判定，所以链级整体 p50 也包含到链目标的那一跳；
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
3. `chain_group_members` JOIN `servers`：全部成员一次读出（`entry` / `exit` /
   `nodes` 的地址、内网地址、端口、优先级与 `servers.status` 都来自这一条）；
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
  - 港日中转链：香港-01 → 东京-01 → 新加坡-01 → 大阪-01（4 组 / **4 段**，
    最后一段是 大阪-01 → 链目标）；
  - 港新直达链：香港-02 → 新加坡-02（2 组 / 2 段，含最后一跳）；
  - 港日多路径：香港-01 →（东京-01 / 东京-02）→ 大阪-01（中间组两台，
    `estimated: true`）；
- **大阪-01 在 2 小时前掉线**（`servers.status = offline`，`last_seen_at` 同步
  回拨 2h）。为了避免「已离线却仍有最新样本」的自相矛盾，凡是由它发起、或以
  它为目标的数据都只写到掉线之前：
  - 港日中转链的第 3 段（新加坡-01 → 大阪-01）和最后一跳（大阪-01 → 链目标）
    最近 2h 没有时延样本、也没有探测桶；
  - 港日多路径进入大阪-01 的第 2 段与它的最后一跳同样停在掉线前；
  - 上游段照常上报，所以这两条链的 `status` 是 `blocked` / `node_offline`
    （`node` 分别指向 `seq 3` / `seq 2` 的大阪-01），**不是** `no_samples`：
    这就是「节点离线优先于数据质量」在预览库里的可见证据；
  - 港新直达链的两台机器都在线，数据完整，`status` 是 `ok`；
- 最近 24h、每 5 分钟一条的 `forward_latency_samples`（**3059 条**；11 个
  forward/target 组合 × 289 个桶，其中 5 个与大阪-01 相关的流各少 24 条）：
  - 每条链最后一跳到目标的样本也写入（`target_server_id` 为空），用来验证
    它归到最后一跳段、`missing_hops` 不再包含这一跳、且不计入
    `unmapped_forwards`；
  - 多路径链的入口组上报两个真实 `target_server_id`，中转组两台各自上报；
- 最近 24h、每 5 分钟一桶的 `forward_probe_samples`（**2770 条**；10 个
  forward × 289 个桶，其中 5 个与大阪-01 相关的流各少 24 条）：
  - 港日中转链第 2 段（东京-01 → 新加坡-01）最近 2h 每桶 `7/240 ≈ 2.92%`；
  - 其余在线段 `<0.2%`（每 3 个桶 1 次失败，`1/240 ≈ 0.14%`）；
  - 整链连乘约 `3.06%`，用于对照「单段丢包 vs 整链」；
  - 最后一跳到链目标的探测也写入，聚合时归到最后一跳段（不再被丢弃）。

> 预览页上港日中转链的最近 2h 是空的（第 3 / 最后一跳没有数据），它的
> `diagnosis` 因此是 `unknown`；这不是缺陷，而是 `blocked` 链的真实形态。
> 「单段变慢 → single_hop」由领域层/路由层单测覆盖，不依赖预览库。

重复执行幂等：固定 id + 先删后插；只写 `data/preview.db`，不碰
`data/pierwave.db`。

## 8. 测试

- 领域层（`crates/domain/src/chain_health.rs`）：单跳、多跳、多路径估算、
  最后一跳归属（有 NULL target 样本 → 不进 `missing_hops`、段 p50 正确；
  无样本 → 仍在 `missing_hops`；只有探测 → 不算缺失）、同服务器中间段与
  最后一跳不混淆、最后一跳带非空目标 → unmapped、多成员最后一跳按成员
  归属、单组链只有最后一跳、空样本、无成员链、部分桶不补 0、单段变慢的
  `contribution_pct` / `diagnosis`、整体均匀变慢；丢包的 attempts=0 → null、
  单段 2/240 = 0.8333、两段各 1% → 1.99、缺段跳过；全无数据 → null +
  `loss_partial=false`、部分段有数据 → 连乘 + `loss_partial=true`、
  多路径先加计数再算比值、最后一跳探测只进最后一跳段、`summary` 取最差链；
  `series[].loss_pct` 两个桶不同失败率 → 不同值、无探测桶 → null；
  `nodes` 的 role / status / 链目标 `server_id: null`、多成员组取
  `(priority, server_id)` 最小成员；链级 `status` 的三种 kind：全在线 + 当前
  数据完整 → `ok`、`abnormal` / `no_data` → `degraded` / `node_unhealthy`、
  无样本 → `degraded` / `no_samples`、变慢 → `degraded` / `slow`、离线 →
  `blocked` / `node_offline` 并点名 `seq` 最小的离线节点、离线优先于 slow、
  链目标 `status: null` 不参与判定；起点/终点覆盖单成员、多成员按
  `(priority, server_id)` 选第一台、`public_port` 为空回退 `listen_port`、
  内网地址兜底 + `address_source`、IPv6 方括号、缺端口保留 `ip`、空组 →
  `null`；逐段序列与链级同长、缺桶 null、`attempts=0` → loss null、有时延
  无探测 → loss null、有探测无时延 → 整桶 null、多成员同桶合并；
- 路由层（`crates/master/src/routes/chain_health.rs`）：单跳/多跳映射、
  最后一跳的 p50 / loss / `missing_hops`、整体 p50 含最后一跳、`nodes` 的
  role / status / 链目标 null 与 `entry`/`exit` 保留、`status` 的
  blocked / degraded(no_samples) / ok 与节点点名、段/整链丢包与时延
  回归、`series[]` 逐桶丢包、`entry` / `exit` 的 `public_port` 与
  `listen_port` 口径、多成员优先级、`server_ids` 筛选后 entry/exit 仍取
  原链首尾、筛选后只汇总保留的链、筛选（命中/未知/空数组/非法/201 个 id）、
  非法 `hours`/`bucket`、缓存 key 隔离、非管理员 401/403；
- 查询计划（`crates/domain/tests/query_plan.rs`）：`forward_probe_samples`
  的逐桶查询必须走 `idx_forward_probe_samples_forward_ts`，不允许全表扫描；
- 缓存层（`crates/master/src/state.rs`）：`(hours, bucket, 筛选)` 三维
  key 隔离、TTL、禁用。

## 9. 未做

- 不新增表/迁移：现有 `forward_latency_samples` / `forward_probe_samples` +
  链组映射足够；`nodes` 的 `status` 直接读 `servers.status`，`chains[].status`
  是节点状态 + 已有样本的纯内存合成，不新增列；
- 不改 `crates/proto`、`crates/agent`：Agent 一直会探测最后一组到链目标的
  TCP 握手（`derive_forwards` 对最后一组下发 `target_host/target_port`，
  Agent 的 `target_health_loop` 探测它并按空 `server_id` 上报），本轮只是把
  这批样本归到最后一跳，不需要新字段或协议版本；
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

`hops` is the number of `chain_groups` rows and also the number of segments: a
chain with 4 groups has 3 inter-group segments plus one final segment from the
last group to the chain target. An inter-group segment's `seq` is the
destination group's `seq`; a sample belongs to segment N when its `server_id` is
in group N and its `target_server_id` is in group N+1. Legacy single-target
probes report an empty `target_server_id`; it is resolved to the only member of
the next group. A multi-member next group with an empty target cannot be
attributed and is counted in `warnings.unmapped_forwards`. The final hop to the
chain target is a segment too: its `seq` is the last group's `seq + 1`, and a
sample belongs to it when its `server_id` is in the last group and its
`target_server_id` is empty (the agent's forward for the last group targets the
chain target, so there is no next member id). Its `p50` / `series` / `attempts`
/ `failures` / `loss_pct` have exactly the same shape as an inter-group segment
and the segment's `to` is `链目标`. `missing_hops` contains the final hop only
when the window has neither a latency sample nor a probe bucket for it; it is
never replaced with 0. Multi-member groups (including the final hop) are
attributed per source `server_id`; the segment pools their samples, the chain
value is the sum of the per-segment medians, and `estimated` is true — an
estimate, not a real end-to-end path RTT.

`entry` / `exit` are display-only endpoints of the **original** chain (they are
not affected by `server_ids` filtering; see below). They are kept for backward
compatibility.

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

`chains[].nodes` lists the topology in `seq` order: one node per group plus a
final chain-target node at the end. The first group's node has role `source`,
the other group nodes have role `hop`, and the target node has role `target`.
Each group node takes the group's smallest `(priority, server_id)` member (the
same rule as `entry` / `exit`); for a multi-member group only that
representative member is expanded and the chain-level `estimated: true` says
the segment is an estimate. `status` is the member server's `servers.status`
verbatim (`online` / `offline` / any stored value) and is never inferred. The
target node has `server_id: null` and `status: null`; a group with no members is
also emitted with `server_id: null` / `status: null` and its name falls back to
the group name (or `第 N 跳`). The target node's name is `链目标` and its `seq`
is the last group's `seq + 1`, matching the final-hop `seq` used by
`missing_hops`. A chain with no groups returns an empty `nodes` array.

`chains[].status` is the chain-level availability verdict combining node state
with data quality: `kind` is `ok` / `degraded` / `blocked`, `cause` is
`node_offline` / `node_unhealthy` / `no_samples` / `slow` (`null` for `ok`), and
`node` is `{ seq, name }` for the first offline node, otherwise `null`. Rules are
applied in order, first match wins:

1. any `source` / `hop` node with `status == "offline"` → `blocked` /
   `node_offline`, `node` = the first offline node (smallest `seq`);
2. any `source` / `hop` node with `status != "online"` (`abnormal` / `no_data`,
   or a `null` from an empty group) → `degraded` / `node_unhealthy`;
3. no "all segments present" overall sample in the current 2-hour window, or a
   non-empty `missing_hops` → `degraded` / `no_samples`;
4. the overall delta is at least 8ms (`SLOW_DELTA_MS`, the same predicate used by
   `summary.slow_chains`) → `degraded` / `slow`;
5. otherwise → `ok`.

The `target` node never participates: it has no server row, its `status` is
always `null`, and that `null` must not degrade the chain. Node state outranks
data quality: an offline node necessarily removes recent samples, but the verdict
must be `blocked` / `node_offline`, never `no_samples`. `missing_hops` keeps its
original meaning (no sample at all in the window) and is not rewritten by
`status`; the two answer different questions ("which hop has no data" vs "can
this chain be used right now"). `node` is only set for `node_offline`, and with
several offline nodes it names the one with the smallest `seq`. Every
pre-existing field keeps its exact semantics; `status` is an additive composite
view.

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
attributed to the final segment. For multi-member groups the attempts
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
dividing, matching the segment-level rules. The final hop is a segment too: a
bucket with its latency samples participates in the chain-level "all segments
present" check, so the chain-level overall p50 includes the hop to the target.
The chain-level `series[]` is non-null only when **all** segments have samples
in that bucket; per-segment series are independent views and cannot be derived
from each other. All of this
is computed in memory from the same sample/probe rows—no SQL is issued per
segment—so the query count is independent of the number of segments.

Performance: three topology queries (chains / groups / members), one
`forward_latency_samples` query with `forward_id IN (...)`, and one
`forward_probe_samples` query reading the 5-minute buckets across the series
window with `forward_id IN (...)`; no N+1. Entry/exit, `nodes` and the
per-segment series add no queries—they are derived from those same rows in
memory. On the preview
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

`scripts/seed-preview.sh` adds 3 chains / 9 groups / 10 members and keeps
大阪-01 offline. It went offline 2 hours ago (`servers.status = offline`, with
`last_seen_at` moved back 2 hours), and **no sample is written for it after that
point**: the third segment of 港日中转链 (新加坡-01 → 大阪-01) and its final hop
(大阪-01 → 链目标) have neither latency samples nor probe buckets in the last
2 hours, and the same holds for the multi-path chain's inbound segment and final
hop. Upstream segments keep reporting, so both chains are
`blocked` / `node_offline` (with `node` pointing at seq 3 and seq 2 respectively)
rather than `no_samples`, which is the visible proof that node state outranks
data quality. 港新直达链 has both nodes online and complete data, so it is `ok`.
The seed writes 24 hours of 5-minute latency samples (**3059 rows**: 11
forward/target streams × 289 buckets, minus 24 rows for each of the 5 streams
touching 大阪-01) and per-hop probes (**2770 rows**: 10 forwards × 289 buckets,
minus the same 5 × 24). The second segment's probe failure rate is about 2.92%
for the last 2 hours (7/240 per bucket) while the remaining online segments stay
below 0.2% (1/240 every third bucket), so the compounded chain loss is about
3.06%. Final-hop latency samples are written with an empty `target_server_id`
for every stream that is still online. Because the blocked chain has no current
data, its `diagnosis` is `unknown`; the "single-segment slowdown → `single_hop`"
rule is covered by unit and route tests rather than by the preview database. The
script is idempotent and only writes `data/preview.db`.

Tests cover single-hop, multi-hop, multi-path estimation, the final-hop rule
(an empty-target sample removes it from `missing_hops` and produces the segment
p50; no sample keeps it in `missing_hops`; probe-only data is not "missing"),
the same server appearing as both a middle-segment source and the final-hop
source (target disambiguates them), an empty target on an intermediate hop with
a multi-member next group still being unmapped, final-hop samples with a
non-empty target being unmapped, multi-member final-hop attribution, single-group
chains (only the final segment), empty samples, chains without members, partial
buckets, single-segment and uniform slowdowns, loss edge cases (`attempts = 0` →
`null`, 2/240 = 0.8333, two 1% segments → 1.99%, missing segment →
`loss_partial`, no probe data at all → `null` + `loss_partial: false`,
per-bucket `series[].loss_pct` differing between buckets and `null` for a bucket
without probes, final-hop probes attributed only to the final segment,
multi-member counts summed), `nodes` roles/status/target null and multi-member
representative selection, chain `status` (all three kinds: `ok` with complete
current data, `degraded` / `node_unhealthy` for `abnormal` / `no_data`,
`degraded` / `no_samples`, `degraded` / `slow`, `blocked` / `node_offline` naming
the smallest-`seq` offline node, offline outranking a slowdown, and the target's
`null` status not affecting the verdict), entry/exit (single member, multi-member
priority,
`public_port` → `listen_port` fallback, internal-address fallback with
`address_source`, IPv6 bracketing, missing port keeping `ip`, empty groups →
`null`), per-segment series (same length as the chain series, missing buckets
`null`, `attempts = 0` → `loss_pct: null`, probes without latency → `null`,
multi-member buckets pooled), summary worst-loss selection, filtering
(hit/unknown/empty/invalid/201 ids), entry/exit preserved under `server_ids`
filtering, loss under `server_ids` filtering, latency regression, bad
`hours`/`bucket`, cache-key isolation, query plans, and 401/403. No migration is
added; `crates/proto` and `crates/agent` are unchanged (the agent already probes
the final target), and no `web/` changes are made.
