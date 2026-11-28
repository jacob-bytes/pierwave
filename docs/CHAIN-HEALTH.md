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
      { "seq": 0, "server_id": "…", "name": "香港入口", "role": "source", "status": "online",
        "member_count": 1,
        "members": [{ "server_id": "…", "name": "香港-01", "status": "online" }] },
      { "seq": 1, "server_id": "…", "name": "东京中转", "role": "hop", "status": "online",
        "member_count": 1,
        "members": [{ "server_id": "…", "name": "东京-01", "status": "online" }] },
      { "seq": 2, "server_id": "…", "name": "新加坡中转", "role": "hop", "status": "online",
        "member_count": 1,
        "members": [{ "server_id": "…", "name": "新加坡-01", "status": "online" }] },
      { "seq": 3, "server_id": "…", "name": "大阪出口", "role": "hop", "status": "offline",
        "member_count": 1,
        "members": [{ "server_id": "…", "name": "大阪-01", "status": "offline" }] },
      { "seq": 4, "server_id": null, "name": "链目标", "role": "target", "status": null,
        "member_count": 0, "members": [] }
    ],
    "estimated": false,
    "missing_hops": [],
    "last_hop": { "measurable": true, "reason": null },
    "status": { "kind": "blocked", "cause": "node_offline",
                "node": { "seq": 3, "name": "大阪-01", "member_name": "大阪-01" } },
    "series": [ null, "…", { "ts": 1795443300, "p50": 81.0, "p10": 74.6, "p90": 84.2,
                             "samples": 10, "loss_pct": 3.8577 }, "…", null ],
    "segments": [
      { "seq": 1, "from": "香港-01", "to": "东京-01",
        "series": [ null, "…", { "ts": 1795450500, "p50": 14.5, "loss_pct": 0.4167 }, "…" ],
        "p50": 15.5, "delta_ms": 0.0, "contribution_pct": 0,
        "attempts": 5280, "failures": 8, "loss_pct": 0.1515,
        "members": [
          { "server_id": "…", "name": "香港-01", "status": "online",
            "p50_ms": 15.5, "loss_pct": 0.1515,
            "attempts": 5280, "failures": 8, "active": false }
        ] },
      { "seq": 2, "from": "东京-01", "to": "新加坡-01",
        "series": [ null, "…", { "ts": 1795450500, "p50": 20.5, "loss_pct": 2.9167 }, "…" ],
        "p50": 21.5, "delta_ms": 0.0, "contribution_pct": 0,
        "attempts": 5280, "failures": 154, "loss_pct": 2.9167,
        "members": [
          { "server_id": "…", "name": "东京-01", "status": "online",
            "p50_ms": 21.5, "loss_pct": 2.9167,
            "attempts": 5280, "failures": 154, "active": false }
        ] },
      { "seq": 3, "from": "新加坡-01", "to": "大阪-01",
        "series": [ null, "…", { "ts": 1795443300, "p50": 33.0, "loss_pct": 0.4167 }, "…", null ],
        "p50": null, "delta_ms": null, "contribution_pct": 0,
        "attempts": 0, "failures": 0, "loss_pct": null,
        "members": [
          { "server_id": "…", "name": "新加坡-01", "status": "online",
            "p50_ms": null, "loss_pct": null,
            "attempts": 0, "failures": 0, "active": false }
        ] },
      { "seq": 4, "from": "大阪-01", "to": "链目标",
        "series": [ null, "…", { "ts": 1795443300, "p50": 8.0, "loss_pct": 0.4167 }, "…", null ],
        "p50": null, "delta_ms": null, "contribution_pct": 0,
        "attempts": 0, "failures": 0, "loss_pct": null,
        "members": [
          { "server_id": "…", "name": "大阪-01", "status": "offline",
            "p50_ms": null, "loss_pct": null,
            "attempts": 0, "failures": 0, "active": false }
        ] }
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

（示例：大阪-01 是单成员出口，离线时这一跳没有任何在线成员，所以第 3 /
最后一跳与最近 2h 的链级桶都是 `null`，链状态是 `blocked`；如果掉的是**均衡类**
多成员组的一台，链是 `degraded / node_offline`；如果是 `failover` /
`lowest_latency` 组掉了一台备用成员、仍有在线成员，链仍是 `ok`。）

`entry` / `exit` 是链的展示起点/终点（口径见 §1.1），保留不删；`nodes` 是
完整的拓扑节点（口径见 §1.2）；`status` 是链级可用性状态（口径见 §1.3）；
`last_hop` 说明最后一跳能不能被 Agent 探测（口径见 §1.4）。
链没有任何组或组内没有成员时 `entry` / `exit` 是 `null`。`series` 固定长度
= `hours*3600/bucket`，从旧到新；没有样本的桶是 `null`，不是 0。
`segments[].p50` / `delta_ms` / `segments[].series[]` 无数据时同样是 `null`。
`segments[].members` 是段**源组**的成员明细（口径见 §4.3），单成员段也返回
长度 1 的数组；它不提供逐成员时间序列。

## 1.1 起点与终点

`entry` / `exit` 只做展示，不参与链下发与探测口径；它们是**原链**的入口/出口，
与 `server_ids` 筛选无关（见 §5）。

- **起点**：第一个组（`seq` 最小）里优先级最高的成员。优先级按
  `(priority ASC, server_id ASC)` 稳定排序，所以 `priority` 相同时取
  `server_id` 较小的一台，与成员插入顺序无关。
  `/chains` 的组内成员顺序与 `derive_forwards` 的下一跳 target 顺序也用
  同一条规则，三个视图对「代表成员」不会给出不同的服务器。
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

`nodes` 按 `seq` 升序给出整条链的拓扑：每个组一个节点，**带该组全部成员**，
末尾再补一个链目标节点。

```jsonc
"nodes": [
  { "seq": 0, "server_id": "…", "name": "香港入口", "role": "source", "status": "online",
    "member_count": 1, "strategy": null, "active_server_id": null,
    "members": [{ "server_id": "…", "name": "香港-01", "status": "online" }] },
  { "seq": 1, "server_id": "…", "name": "东京中转（双路）", "role": "hop", "status": "offline",
    "member_count": 2, "strategy": "failover", "active_server_id": "…",
    "members": [
      { "server_id": "…", "name": "东京-01", "status": "online" },
      { "server_id": "…", "name": "东京-02", "status": "offline" }
    ] },
  { "seq": 2, "server_id": null, "name": "链目标", "role": "target", "status": null,
    "member_count": 0, "strategy": null, "active_server_id": null, "members": [] }
]
```

- **role**：第一组是 `source`，其余组是 `hop`，链目标节点是 `target`；
- **members / member_count**：组内**全部**成员，顺序沿用
  `(priority ASC, server_id ASC)`（与 `entry` / `exit` 同口径）；
  `member_count` 恒等于 `members` 长度。链目标节点与成员为空的脏组都是空
  数组 / `0`；
- **status（组级）**：取该组**最差成员**的状态：
  `offline` > `abnormal` / `no_data` 等非 `online` 值 > `online`。
  成员自身的 `servers.status` 原样保留在 `members[].status`，不被组级状态
  覆盖。空组没有成员可引用，组级 `status` 是 `null`；链目标节点也是 `null`。
  **组级状态只描述最差成员**：多成员组里一台离线会让组级变 `offline`，但链路
  是否可用取决于这一跳还有没有在线成员、以及该跳策略是否均衡类（见 §1.3）——
  组级 `offline` 既不等于链级 `blocked`，也不必然等于链级 `degraded`；
- **server_id / name（兼容字段）**：仍是该组 `(priority, server_id)` 最小的
  代表成员（与 `entry` / `exit` 同口径），保留给只读一台的旧前端。
  `name` 优先取组名，组名为空时回退代表成员名；空组回退 `第 N 跳`；
  链目标节点的 `name` 固定为 `链目标`，`server_id` 是 `null`；
- **seq**：组节点就是组的 `seq`；链目标节点是「最后一组 `seq` + 1」，与
  `missing_hops` 里最后一跳的编号一致；
- **strategy**：该组的选路策略，取值 `round_robin` / `failover` /
  `lowest_latency` / `ip_hashed` / `weighted` / `least_conn`。入口组没有上一跳、
  链目标节点没有选路，两者恒为 `null`；库里的非法值回落 `round_robin`。
  执行选路的是**上一跳**，所以这个字段描述的是「上一跳进入本组时用什么策略」；
- **active_server_id**：从入口代表成员（`(priority, server_id)` 最小，与
  `entry` 同口径）出发，沿 Agent 上报的「当前选中」逐跳走出的当前通路成员
  （`server_id`）。每一跳看上一跳 forward 的逐目标探测：恰好一个
  `targets[].active = true` 的成员就是这一跳的当前通路成员，再以它为起点
  继续下一跳。入口组与链目标恒为 `null`。以下任一情况都会从**该跳起**
  全部为 `null`（之前已经确定的成员保留）：上一跳通路成员不是 `online`、
  该 forward 没有心跳状态记录、没有 `active = true`、有多个
  `active = true`（没有单一选中项）、`active` 的 `server_id` 不在本组、
  或者本组策略不是 `failover` / `lowest_latency`（这两者才有确定的单一
  选中项；轮询 / 哈希 / 加权 / 最少连接即使收到脏的 `active` 也不采用）。
  单成员组走旧兼容字段时 Agent 上报的 `server_id` 是空串，此时归到该组
  唯一成员（与样本归属同一口径）。该字段是展示用的合成视图，不改变
  下发与探测口径；
- 多成员组全部展开后，链级 `estimated: true` 仍然只表示「段值是按多路径
  估算的」，不再表示 `nodes` 只展示一台；
- 没有任何组的脏数据返回空数组。

## 1.3 链级可用性状态（`status`）

```jsonc
"status": { "kind": "ok" | "degraded" | "blocked" | "unknown",
            "cause": "node_offline" | "node_unhealthy" | "unmeasurable" | "no_samples" | "slow" | null,
            "node": { "seq": 1, "name": "东京-02", "member_name": "东京-02" } | null }
```

`status` 把节点状态、选路策略与链路数据合成一个用户能直接看的状态。可用性
**按跳 + 策略**判断，不按成员：一条链的每个必需跳（`source` / `hop`）只要还有
**至少一台在线成员**，这一跳就能承载流量；仍有在线成员时是否降级取决于该跳的
策略（逐跳规则由 `crate::chains::hop_state` 统一给出，概览计数共用同一份实现）。
判定**按以下优先级**（高 → 低，命中即停）：

| 优先级 | 条件 | `kind` | `cause` | `node` |
|---|---|---|---|---|
| 1 | 任一必需跳**全部成员离线**（这一跳没有任何在线成员）或**没有成员**（空组） | `blocked` | `node_offline` | 拓扑上第一台离线成员（`seq` 是该成员所在组）；空组没有成员可点名时为 `null` |
| 2 | 每跳都至少有一台 `online`，但**均衡类**策略（`round_robin` / `ip_hashed` / `weighted` / `least_conn`）的跳存在 `offline` 成员 | `degraded` | `node_offline` | 这些均衡类跳里拓扑上第一台离线成员（`seq` 是该成员所在组） |
| 3 | 每跳都至少有一台 `online`，但存在 `abnormal` / `no_data` 等非在线成员 | `degraded` | `node_unhealthy` | `null` |
| 4 | 最后一跳不可测（`last_hop.measurable = false`；引擎 / 协议是链级字段，所以这条链的所有段都不可测） | `unknown` | `unmeasurable` | `null` |
| 5 | 当前 2h 窗口没有「所有段齐全」的整体样本，**或** `missing_hops` 非空 | `degraded` | `no_samples` | `null` |
| 6 | 整体较基线变慢（与 `summary.slow_chains` 同一个 `SLOW_DELTA_MS` = 8ms 阈值） | `degraded` | `slow` | `null` |
| 7 | 其余（包括 `failover` / `lowest_latency` 跳部分成员离线、但仍有在线成员） | `ok` | `null` | `null` |

- **首选可用就不该显示降级**：`failover` / `lowest_latency` 同一时刻只用一个
  成员，掉的是**备用成员**，当前通路不受影响。例如
  `[东京-02 offline, 东京-03 online]` 的 `failover` 组，当前选中东京-03，
  链是 `ok`，不是 `degraded`；
- **均衡类跳掉一台 = 少一份容量**：`round_robin` / `ip_hashed` / `weighted` /
  `least_conn` 把流量分给多台，`[东京-01 online, 东京-02 offline]` 的均衡类
  中转组会让链 `degraded` / `node_offline`（点名东京-02），不是 `blocked`——
  这一跳仍有在线成员可以承载流量。只有该跳**一台在线成员都不剩**（全部离线）
  才 `blocked`；
- **入口组按均衡类处理**：入口组没有上一跳执行选路，`nodes[].strategy` 为
  `null`，但它同样由多台等价入口分担容量，部分离线 → `degraded`；最后一跳
  同理按该组自己的策略判断。单成员组离线仍然 `blocked`（这一跳确实没有在线
  成员）；
- **空组**：没有任何成员能承载这一跳，与「全部离线」同档，判 `blocked`。它没有
  成员可点名，所以 `node` 是 `null`（旧口径把空组算作 `degraded/node_unhealthy`）。
  有成员的阻断跳仍会点名第一台离线成员；
- **只有 abnormal / no_data、没有离线成员的跳**沿用旧口径 `degraded` /
  `node_unhealthy`：这些状态没有被确认离线，仍可能恢复，不升级成 `blocked`；
  该规则**不看策略**（即使是 `failover`，成员状态不明也降级）；
- **`target` 不参与判定**：链目标节点没有成员，`members` 是空数组、`status`
  恒为 `null`；这个 `null` 不能把链判成 `node_unhealthy`；
- **成员优先于数据质量**：成员离线必然让相关段在当前窗口缺样本，但结果会是
  `blocked` / `node_offline` 或 `degraded` / `node_offline`，**不是** `no_samples`。
  `missing_hops` 仍按 §2 的原口径（窗口内完全没有样本）计算，两者回答不同问题：
  `missing_hops` 说「哪一跳没有数据」，`status` 说「这条链现在能不能用」，因此
  可以自洽共存（例如一个 `degraded/node_offline` 链的 `missing_hops` 仍可非空）；
- **`cause = "slow"` 与 `summary.slow_chains` 同口径**：都用
  `当前整体 p50 - 24h 基线整体 p50 ≥ 8ms`，不会出现「summary 说 1 条慢链、
  链上却没有 slow」；
- **`node` 语义**：只有 `node_offline` 时出现，`seq` 是离线成员**所在组**的
  `seq`，`name` / `member_name` 都是该**成员名**（`name` 保留旧字段语义，
  `member_name` 是显式的新字段，便于前端不区分组节点名与成员名）。
  `blocked` 时取拓扑上第一台离线成员；`degraded` 时**只**从均衡类跳里取第一台
  （`failover` / `lowest_latency` 的备用成员离线不构成降级，不能拿来当原因）。
  多个候选时取组 `seq` 最小、组内 `(priority, server_id)` 最早的那台。`blocked`
  与 `degraded` 都可能带 `node`；空组阻断时没有成员可点名，`node` 为 `null`；
- **`unknown` / `unmeasurable`**：Agent 只为 `native + tcp` 的 forward 跑目标
  探测（见 §1.4），所以 realm / nftables / tunnel / udp / both 链的探测数据
  **永远不会齐全**。这类链报 `degraded` / `no_samples` 会让人以为「Agent
  没上报」或「链路坏了」，因此单独给 `unknown` + `unmeasurable`。节点状态的
  优先级仍然更高：真正不可用的不可测链还是 `blocked` / `node_offline`；
- **概览计数同口径**：`summary` 里没有 `blocked` / `degraded` 计数字段，但
  `GET /api/v1/overview` 的 `chains.blocked` / `chains.degraded` 与本接口的
  `status.kind` 用**同一份逐跳规则**（`crate::chains::hop_state`）：
  * `blocked` = 配置不可下发（证书 / 能力等，`blocked_reason`）**或**任一必需跳
    没有在线成员；
  * `degraded` = 非 blocked，且仅均衡类策略的跳存在离线成员（容量下降）或存在
    `abnormal` / `no_data` 成员；`failover` / `lowest_latency` 的备用成员离线
    不计入；
  * **不再用 `forward_status.target_fail_count` 阈值**：那是运行态健康，不是
    成员可用性；概览的 `chains.degraded` 现在只反映上一条的成员状态；
  * 概览计数是**成员状态**口径，不含本接口的数据质量降级（`no_samples` /
    `slow` / `unmeasurable`）；同一批链在有完整当前样本时，逐条按
    `status.kind` 统计与概览计数一致（路由层测试覆盖）；
  * 实现是一次读出链拓扑后在内存归并，复杂度 O(链数 × 组数 × 成员数)，SQL
    次数固定（拓扑 3 条 + 证书至多 1 条 + 转发计数 1 条），没有 N+1；
- **口径变化的影响**：链列表上的 blocked 标记仍走配置 `blocked_reason`（不含
  成员离线）；概览的 blocked / degraded 走上面的统一口径。前端若自行按
  `status.kind` 汇总，得到的结果与概览端点一致（数据质量降级除外）。
  `summary.slow_chains` 仍是「可测链里整体 delta ≥ 8ms 的条数」这个**纯数值**
  口径，不按 `kind` 过滤：一条同时变慢的 `degraded/node_offline` 链仍会计入
  （旧版 `blocked` 链也同样计入），但它自己的 `status.cause` 是 `node_offline`
  （优先级更高），不会变成 `slow`；
- **其它字段不变**：`segments` / `series` / `loss_pct` / `loss_partial` /
  `diagnosis` / `missing_hops` 等口径都与之前完全一致，`status` 只是新增的
  合成视图，不改变任何数值。

`node_unhealthy` 的 `status` 直取 `servers.status`，所以 `abnormal` /
`no_data` 这类「服务器行存在但不是 online」的值都会命中；预览库里没有造
这类值，由领域层单测覆盖。

## 1.4 最后一跳可测性（`last_hop`）

```jsonc
"last_hop": { "measurable": true,  "reason": null }        // native + tcp
"last_hop": { "measurable": false, "reason": "engine_unsupported" }   // realm / nftables / tunnel
"last_hop": { "measurable": false, "reason": "protocol_unsupported" } // native + udp / both
```

判定以 **Agent 的实际探测条件**为准：只有 `engine = native && protocol = tcp`
的 forward 会启动 `target_health_loop`（`wants_tcp && !wants_udp`）；realm /
nftables / tunnel 的规则从不探测，`udp` / `both` 也不探测（TCP 握手证明不了
UDP 可达）。引擎 / 协议是链级字段（`derive_forwards` 逐跳透传），所以
`measurable = false` 时**整条链**都没有探测数据。不可测时：

- 最后一跳**不参与** `series` 的「所有段齐全」判定、`current_overall`；
  中间段有历史样本时曲线仍然可见（`667eba6` 之后整条曲线被最后一跳拖空的
  回归）；
- 最后一跳**不进** `missing_hops`：那是「缺数据」，不是「测不了」（§2）；
- 最后一跳**不参与** `loss_partial` 的「缺段」计数（§4.1）；
- `status` 是 `unknown` / `unmeasurable`（§1.3）；
- `segments[]` 仍保留最后一跳的位置（`p50` / `loss_pct` 为 `null`），
  前端据 `last_hop` 显示「最后一跳不可测量」，而不是「无历史数据」。

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
  中间段**完全同形**，段级 `to` 是 `链目标`；**只有可测链**（`last_hop.measurable
  = true`，见 §1.4）才把它算进整体值，不可测链的最后一跳只保留段位；
- 旧 Agent 对单成员下一跳走兼容字段，`target_server_id` 是空串；主控按
  「下一组唯一成员」补回。多成员下一组必须带真实 `server_id`，空目标无法
  判断走了哪条路径，计入 `warnings.unmapped_forwards`；
- `missing_hops` 只在**确实没有样本**时才包含最后一跳：该链窗口内既没有
  最后一跳的时延样本、也没有 `forward_probe_samples` 探测桶时，才把
  `最后一组 seq + 1` 写进去；有任一数据就不写。任何情况下都**绝不补 0**。
  这里的「窗口」是**请求的 `hours`（series 窗口）**，不是 26h 基线窗口：
  只在 24h 基线里出现过的旧样本不能把最后一跳从 `missing_hops` 里抹掉。
  最后一跳**不可测**时不写（§1.4）。如果中间某组没有成员，相邻段也写进
  `missing_hops`；
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
+0ms 时，headline 是 +25ms 而不是中位数 0。**headline 与 `slow_chains` 只
统计可测链**（`last_hop.measurable = true`）：不可测链的样本只可能是历史
残留，逐链状态是 `unknown`，不能让它抢 headline 或和 `status.cause = "slow"`
的口径打架。`worst_hop` 仍是所有链里当前 p50 最高的段。

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
- `summary.slow_chains`：整体 delta ≥ 8ms 的**可测**链数（不可测链不计：
  它们的逐链状态是 `unknown` / `unmeasurable`，永远不会有 `slow`）。8ms 是
  跨公网一跳的常见抖动上限，也与设计稿「稳定 = 没有超过 8ms 的变化」一致。

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
  **不可测的最后一跳不算「缺数据」**：它本来就不会有探测，不参与
  `loss_partial`（否则不可测链会永远显示「部分跳缺少数据」）；
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
- **最后一跳**：与中间段同长同形；可测链（native + tcp）里，有最后一跳
  时延样本的桶会参与链级 `series`「所有段齐全」的判定，所以链级整体 p50
  也包含到链目标的那一跳；不可测链（realm / nftables / tunnel / udp / both）
  的最后一跳不参与该判定，段级序列仍然全为 `null`（§1.4）；
- **与链级序列的关系**：链级 `series[]` 只在**所有段**该桶都有样本时非 null，
  段级序列则是每段各自的可见性；两者不能互相推导；
- **性能**：段级序列完全由同一批 `forward_latency_samples` /
  `forward_probe_samples` 内存归并得到，**不按段发 SQL**。查询次数与段数无关。

### 4.3 逐段成员明细（`segments[].members`）

`segments[].members` 给前端「逐段时延」悬停展开用：每个段返回其**源组**的
全部成员，但**不提供逐成员时间序列**（轮询段只画聚合线，悬停看明细）。

```jsonc
"segments": [
  { "seq": 2, "from": "东京-01", "to": "新加坡-01", "p50": 21.5, "loss_pct": 2.9167,
    "members": [
      { "server_id": "…", "name": "东京-01", "status": "online",
        "p50_ms": 21.5, "loss_pct": 2.9167, "attempts": 5280, "failures": 154,
        "active": true },
      { "server_id": "…", "name": "东京-02", "status": "offline",
        "p50_ms": null, "loss_pct": null, "attempts": 0, "failures": 0,
        "active": false }
    ] }
]
```

- **成员来源与顺序**：段 i（组 i → 组 i+1，最后一组 → 链目标）的成员就是
  组 i 的全部成员，顺序与 `nodes[i].members` 完全一致
  （`priority ASC, server_id ASC`）。单成员段也返回**一个元素**的数组，前端
  可据长度判断要不要展开；
- **字段**：`server_id` 是真实成员（`servers.id`），`name` 是服务器名，
  `status` 是 `servers.status` 原样透传（online / offline / abnormal /
  no_data …），不做二次推断；
- **`p50_ms`**：与段级当前值**同一个当前窗口**（最近 2 小时
  `CURRENT_WINDOW_SECS`，`hours < 2` 时退化为请求窗口，按 `bucket` 对齐），
  只取该成员自己 forward 规则的时延样本：先算每个桶的 p50，再取这些桶 p50
  的中位数（与段级同一个算法）。该成员没有样本时是 `null`，不是 0；
- **`loss_pct` / `attempts` / `failures`**：同一当前窗口内该成员 forward 的
  探测计数，`loss_pct = failures / attempts × 100`（保留 4 位小数）。
  `attempts = 0` 时 `loss_pct` 是 `null`，**不补 0**。`attempts` /
  `failures` 是该成员自己的计数，不是段级合计；
- **`active`**：该成员是否是源组的**当前通路成员**，即是否等于
  `nodes[i].active_server_id`（源组下标 = 段下标，口径见 §1.2）。只有
  **多成员组**且策略为 `failover` / `lowest_latency` 时才可能为 `true`：
  入口组没有上一跳、轮询 / 哈希 / 加权 / 最少连接没有单一选中项、单成员组
  没有「选中哪一台」可言，全部为 `false`；
- **段级口径不变**：段 `p50` 仍是该段所有成员样本池的中位数，段
  `attempts` / `failures` 仍是成员之和，段 `loss_pct` 仍是「先加计数再算
  比值」。`members` 只是把同一批数据按成员再切一刀，不改变
  `segments[].p50` / `loss_pct` / `series`、链级 `series` / `loss_pct`、
  `nodes` 与 `status`；
- **离线成员**：`status` 照常透传 `offline`；样本不按状态过滤（与段级
  一致），刚掉线的成员可能仍有当前窗口样本，也可能 `p50_ms: null`；
- **性能**：只由同一批 `forward_latency_samples` / `forward_probe_samples`
  内存归并，不新增 SQL，查询次数与成员数无关。

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
   探测桶，一次 `IN (...)` 读出；逐桶丢包在内存里按 `bucket` 再合并；
6. `forward_status`：同一批 forward id 的 `forward_id, targets_json`，一次
   `IN (...)` 读出，用于 `nodes[].active_server_id`；id 列表为空时不查。
   单行 JSON 解析失败只记 warn 并当「该跳没有数据」，不影响其它跳。

起点/终点、逐段 `series`、逐段成员明细与 `active_server_id` 都是这批结果的
纯内存归并，
**没有按段/按桶循环查库**；`active_server_id` 复用第 6 条查询，不按跳加查。

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
`(hours, bucket, (命中的 server_ids, 未知的 server_ids))`：命中的与未知的
**分开存**，因为 `scope` / `warnings` 和 body 一起缓存，合并成一个集合会让
同一个 id 从「未知」变成「存在」后仍命中旧响应。响应头
`X-Chain-Health-Cache: hit|miss`。`None`（不筛选）与 `Some(([], []))`
（空集）是不同 key。缓存是 TTL 语义：最多陈旧 30 秒，不写穿透。

## 7. 造数

`scripts/seed-preview.sh` 写入 15 台主机 / 8 个链模板 / 26 条链（80 组 /
98 成员），覆盖新的链级判定（§1.3）需要看到的每一种状态：

- **ok（多路径 / 单选择跳部分成员离线）**
  - 港日多路径（603）：香港-01 →（东京-01 在线 / 东京-02 离线）→ 大阪-01。
    中间组是 `lowest_latency`，东京-02 离线只是少一个候选，东京-01 仍在承载，
    链路是 `ok`；
  - 管理员 · 主备三跳（781）：中间组 `failover` 的 priority 0 东京-02 离线、
    priority 1 东京-03 在线，当前通路仍走东京-03，链路是 `ok`；
  - 港新直达链（602）、nora · 港日双路 C（717）、demo · 港新入口 C（733）、
    mei · 港日新四跳（722）、nora · 四跳空闲（763）等成员全部 `online` 的链
    都有完整 24h 样本，状态是 `ok`；763 只是累计流量为 0。
- **degraded（均衡类跳部分成员离线）**
  - kenji · 港日双路（711）：入口组 `ip_hashed` 两台成员，香港-02 在线 /
    香港-03 离线（其余跳在线）→ `degraded` / `node_offline`，点名香港-03。
- **blocked（必需跳整组离线 / 单成员跳离线）**
  - mei · 港日双路 B（713）：中转组 `lowest_latency` 只有东京-02 一台且离线，
    这一跳没有任何在线成员；
  - nora · 港日新四跳（723）：`ip_hashed` 东京跳只有离线的东京-02；
  - nora · 五跳备线（752）：入口 `ip_hashed` 的 4 台成员全部离线 / 无数据，
    是「整组离线」的证据；nora · 三跳空闲（772）的出口只有离线的香港-03。
- **停用**：美西备用线模板（703）保持 `enabled = 0`，模板洞察的 `status` 是
  `blocked` / `disabled`；链 716 仍保留，用于展示「停用模板仍有历史链」的
  计数口径，链路状态因美西-01 离线而是 `blocked`。
- **样本口径**：`servers.status = 'online'` 的成员（包括 Agent 在线但 Xray
  停止的新加坡-02 / 曼谷-01）都写满最近 24h；只有离线成员按 `last_seen_at`
  截断，指向离线下一跳的样本同样截断。因此不存在「成员全在线却
  `no_samples`」的链。
  - 时延 `forward_latency_samples` **32166 条**、每跳探测
    `forward_probe_samples` **26590 条**：最近 24h、5 分钟粒度；
  - 每条链最后一跳到目标的样本也写入（`target_server_id` 为空），归到最后一跳
    段，`missing_hops` 不再包含这一跳，也不计入 `unmapped_forwards`；
  - 706 活跃链第 4 跳（新加坡-01 → 新加坡-03）时延刻意偏高、丢包约 2.9%，
    其余路径约 0.2%，用于单跳诊断。
- **当前通路**：只有 781 / 782 两条管理员链的 `forward_status.targets_json`
  带 active 键（781 入口写东京-02 `active:false` / 东京-03 `active:true`，
  东京-03 的规则再写新加坡-01；782 入口只把时延最低的东京-01 标成
  `active:true`）。其余链保持旧格式（无 active 键），验证缺键不会被当成
  false / 当前通路。
- **幂等**：固定 id + 事务内先删后插；连续两次执行的 totals 一致（26 条链 /
  80 组 / 98 成员 / 32166 时延 / 26590 探测 / 9408 可用率样本）。只写
  `data/preview.db`，不碰 `data/pierwave.db`。

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
  `nodes` 的 role / 单成员节点 / 多成员组 `members` 完整且按
  `(priority, server_id)` 排序、`member_count`、组级状态取最差成员
  （`online` + `abnormal` → `abnormal`；`no_data` + `offline` → `offline`）、
  链目标 `members: []` / `member_count: 0` / `server_id: null`；链级 `status`
  的三种 kind：全在线 + 当前数据完整 → `ok`、`abnormal` / `no_data` →
  `degraded` / `node_unhealthy`、无样本 → `degraded` / `no_samples`、变慢 →
  `degraded` / `slow`、单成员组离线 → `blocked` / `node_offline` 并点名
  `seq` 最小的离线节点、**均衡类（round_robin / ip_hashed / weighted /
  least_conn）组只掉第二台成员 → `degraded` / `node_offline` 并点名该成员**、
  **failover / lowest_latency 组部分离线、但仍有在线成员 → `ok`（首选仍在线，
  不再 degraded）**、**该组两台全离线 → `blocked`**、
  **入口组部分离线 → `degraded`（不阻断）**、**多组分别降级仍是 `degraded`**、
  **部分离线 + abnormal 混合 → `degraded` 且 cause 优先 `node_offline`**、
  **degraded 只点名均衡类跳的离线成员，不拿 failover 的备用成员当原因**、
  **空组 → `blocked` 且 `node: null`**、离线优先于 slow、链目标
  `status: null` 不参与判定；起点/终点覆盖单成员、多成员按
  `(priority, server_id)` 选第一台、`public_port` 为空回退 `listen_port`、
  内网地址兜底 + `address_source`、IPv6 方括号、缺端口保留 `ip`、空组 →
  `null`；逐段序列与链级同长、缺桶 null、`attempts=0` → loss null、有时延
  无探测 → loss null、有探测无时延 → 整桶 null、多成员同桶合并；
  `segments[].members` 三成员段的长度 / 顺序（与 `nodes[].members` 一致）/
  逐成员 p50 与丢包、没有样本的成员 → null、`attempts=0` 不补 0、单成员段
  长度 1 且 `active=false`、failover / lowest_latency 只标当前成员 `active=true`、轮询段
  即使上报单一 active 也全 false、单成员 failover 组不标 active、离线成员
  `status=offline` 且 p50 可为 null、成员 p50 与段级同当前窗口（窗口外样本
  不计入、series 仍保留）；
- 路由层（`crates/master/src/routes/chain_health.rs`）：单跳/多跳映射、
  最后一跳的 p50 / loss / `missing_hops`、整体 p50 含最后一跳、
  realm / nftables / tunnel / udp / both 链的 `last_hop.measurable = false`、
  `series` 不被最后一跳拖空、`status = unknown/unmeasurable`、`missing_hops`
  不含它、native + tcp 回归、缓存 key 区分「X 存在」与「X 未知」、`nodes` 的
  role / 组级 status / 全部成员 JSON / 链目标空数组与 `entry`/`exit` 保留、
  第二台成员离线 → `degraded` 并点名 `member_name`、整组离线 → `blocked`、
  `status` 的 blocked / degraded(no_samples) / ok 与节点点名、段/整链丢包与时延
  回归、`series[]` 逐桶丢包、`segments[].members` 的三成员明细 JSON
  （p50 / 丢包 / 顺序 / active / 离线成员）、单成员段长度 1 与轮询全 false、
  `entry` / `exit` 的 `public_port` 与
  `listen_port` 口径、多成员优先级、`server_ids` 筛选后 entry/exit 仍取
  原链首尾、筛选后只汇总保留的链、筛选（命中/未知/空数组/非法/201 个 id）、
  非法 `hours`/`bucket`、缓存 key 隔离、非管理员 401/403；
- 概览计数（`crates/domain/src/repo.rs` / `crates/master/src/routes/overview.rs`）：
  failover 部分离线不算 degraded、均衡类部分离线算 degraded、整组离线算
  blocked、abnormal 成员算 degraded、`target_fail_count` 不再影响计数；同一批链
  同时请求概览与 chain-health，按 `status.kind` 统计出的 blocked / degraded 与
  概览计数一致；
- 查询计划（`crates/domain/tests/query_plan.rs`）：`forward_probe_samples`
  的逐桶查询必须走 `idx_forward_probe_samples_forward_ts`，不允许全表扫描；
- 缓存层（`crates/master/src/state.rs`）：`(hours, bucket, 筛选)` 三维
  key 隔离、TTL、禁用。

## 9. 未做

- 不新增表/迁移：现有 `forward_latency_samples` / `forward_probe_samples` +
  链组映射足够；`nodes[].members[].status` 直接读 `servers.status`，组级
  `nodes[].status` 是最差成员，`chains[].status` 是成员状态 + 已有样本的纯
  内存合成，不新增列；
- 不改探测条件：Agent 只对 `engine = native && protocol = tcp` 的 forward 跑
  `target_health_loop`（realm / nftables / tunnel / udp / both 都不探测），
  主控用 `last_hop` 显式标注这个边界；`active` 只是同一轮探测上的标记
  （协议 30），不新增探测动作；
- 逐段序列只给 `p50` + `loss_pct`，不返回 `p10` / `p90` / `samples`，也不做
  段级 24h 基线；热力图需要更多分布字段时要再扩契约；
- `segments[].members` **不提供逐成员时间序列**（用户明确：轮询段只显示聚合
  线，悬停看明细）。成员明细只给当前窗口的 `p50_ms` / `loss_pct` /
  `attempts` / `failures` / `active`，需要成员级曲线时要另立契约；
- 丢包不单独提供曲线/基线：链级逐桶值随 `series[]`、段级逐桶值随
  `segments[].series[]` 一起返回，链级/段级当前值都取最近 2h 窗口，不做 24h
  丢包基线；
- 多路径按「段中位数求和」估算，不做按实际选路权重的加权；
- 不做跨进程缓存失效（30 秒 TTL，单进程）；
- 不改表结构：`active` 存在既有 `forward_status.targets_json` 里，没有迁移；
  本轮只新增 `TargetProbe.active`（协议 30）与链视图的合成字段。

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
and the segment's `to` is `链目标`. `last_hop.measurable` says whether the
agent can probe the final hop at all: only `engine = native && protocol = tcp`
forwards run the agent's `target_health_loop` (realm / nftables / tunnel never
probe, and `udp` / `both` do not either). When it is `false`, the final hop does
not participate in the "all segments present" check, `current_overall`,
`missing_hops` or `loss_partial` (see `last_hop` below). `missing_hops` contains
the final hop only when the **requested `hours` window** (the series window, not
the 26-hour baseline window) has neither a latency sample nor a probe bucket for
it; it is never replaced with 0. Multi-member groups (including the final hop) are
attributed per source `server_id`; the segment pools their samples, the chain
value is the sum of the per-segment medians, and `estimated` is true — an
estimate, not a real end-to-end path RTT.

`entry` / `exit` are display-only endpoints of the **original** chain (they are
not affected by `server_ids` filtering; see below). They are kept for backward
compatibility.

- **Entry**: the highest-priority member of the first group (smallest `seq`),
  ordered by `(priority ASC, server_id ASC)` so equal priorities are broken by
  server id, not insertion order. The `/chains` member order and the
  `derive_forwards` target order use the same rule, so all three views agree on
  the representative member. Its port is `chain_groups.public_port` when
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

`chains[].nodes` lists the topology in `seq` order: one node per group, **with
every member of that group**, plus a final chain-target node at the end. The
first group's node has role `source`, the other group nodes have role `hop`, and
the target node has role `target`. `members` lists the whole group in
`(priority ASC, server_id ASC)` order and `member_count` is its length (the
target node and an empty group have `members: []` / `member_count: 0`). A group
node's `status` is the **worst member status**: `offline` > any non-`online`
value (`abnormal` / `no_data` …) > `online`; each member's own
`servers.status` is kept verbatim in `members[].status`. An empty group and the
target node have `status: null`. `server_id` / `name` remain compatibility
fields: they still name the group's smallest `(priority, server_id)` member (the
same rule as `entry` / `exit`), while `name` prefers the group name and only
falls back to the representative member name when the group has no name (an
empty group falls back to `第 N 跳`). The target node's name is `链目标`, its
`server_id` and `status` are `null`, and its `seq` is the last group's `seq + 1`,
matching the final-hop `seq` used by `missing_hops`. A multi-member group is
fully expanded; the chain-level `estimated: true` still only means the segment
value is an estimate. A chain with no groups returns an empty `nodes` array.
Each group node also carries `strategy` and `active_server_id`. `strategy` is the
group's routing strategy (`round_robin` / `failover` / `lowest_latency` /
`ip_hashed` / `weighted` / `least_conn`); it is `null` for the entry group (no
previous hop) and the target node, and invalid stored values fall back to
`round_robin`. `active_server_id` walks the current path from the entry
representative member (smallest `(priority, server_id)`, same rule as `entry`)
using the previous hop's `targets[].active = true`: exactly one member must be
marked active for the hop to be filled. Both fields are `null` on the entry
group and target node. From the first hop that cannot be resolved onward
everything is `null`: the previous path member is not `online`, the forward has
no heartbeat record, no target is active, more than one target is active, the
active `server_id` is not in this group, or this group's strategy is not
`failover` / `lowest_latency` (only those have a single current selection).
A legacy single-member group reports an empty `server_id`, which resolves to its
only member (the same fallback used for sample attribution). This is a
display-only composite and does not change dispatch or probing.

`chains[].status` is the chain-level availability verdict combining node state
with data quality: `kind` is `ok` / `degraded` / `blocked` / `unknown`, `cause`
is `node_offline` / `node_unhealthy` / `unmeasurable` / `no_samples` / `slow`
(`null` for `ok`), and `node` is `{ seq, name, member_name }` for the first
offline member, otherwise `null`. Availability is judged **per hop and
strategy**, not per member: as long as a required (`source` / `hop`) group still
has **at least one online member**, that hop can carry traffic; whether the chain
degrades depends on the hop's strategy (the per-hop rule lives in
`crate::chains::hop_state` and is shared with the overview counters). Rules are
applied in order, first match wins:

1. any `source` / `hop` group whose members are **all offline** (the hop has no
   online member left) or which has **no members** (empty group) → `blocked` /
   `node_offline`; `node` = the first offline member in topology order (`seq` is
   the group containing it, `name` / `member_name` are that member's name), or
   `null` when the blocking hop is empty and there is no member to name;
2. every hop still has an online member, but a **balanced** strategy hop
   (`round_robin` / `ip_hashed` / `weighted` / `least_conn`) has an `offline`
   member → `degraded` / `node_offline`, `node` = the first offline member among
   those balanced hops (the chain is still usable, only with less capacity);
3. every hop still has an online member, but some member has `abnormal` /
   `no_data` or another non-online status → `degraded` / `node_unhealthy` (this
   rule ignores strategy);
4. the final hop is unmeasurable (`last_hop.measurable = false`; engine and
   protocol are chain-wide, so no segment of the chain can be probed) →
   `unknown` / `unmeasurable`. Reporting `no_samples` here would suggest the
   agent is broken rather than that this engine / protocol is never probed;
5. no "all segments present" overall sample in the current 2-hour window, or a
   non-empty `missing_hops` → `degraded` / `no_samples`;
6. the overall delta is at least 8ms (`SLOW_DELTA_MS`, the same predicate used by
   `summary.slow_chains`) → `degraded` / `slow`;
7. otherwise → `ok`, including a `failover` / `lowest_latency` hop with some
   members offline but at least one online member left.

The selected member staying available must not show as degraded: `failover` /
`lowest_latency` pick a single member at a time, so an offline backup does not
reduce the current path. A balanced hop losing one member is real capacity loss,
so it degrades. The entry group has no previous hop to execute routing
(`nodes[].strategy` is `null`), but its members are equivalent entry points that
share capacity, so it is judged as balanced; the final hop follows its own
strategy. A hop whose members are all `abnormal` / `no_data` but none offline
stays `degraded` / `node_unhealthy` (not confirmed offline, may recover),
matching the previous behaviour. A single-member hop going offline is still
`blocked`. An empty required hop is `blocked` because nothing can carry it
(previously it was `degraded` / `node_unhealthy`); it has no member to name, so
`node` is `null`.

`last_hop` is `{ "measurable": bool, "reason": null | "engine_unsupported" |
"protocol_unsupported" }`: `engine_unsupported` for realm / nftables / tunnel,
`protocol_unsupported` for native chains whose protocol is `udp` / `both`, and
`measurable: true` with `reason: null` otherwise. When the final hop is
unmeasurable, its `segments[]` entry is kept (with `p50` / `loss_pct: null`) so
the UI can show "last hop not measurable" instead of "no history", while the
chain-level curve / current value only use the measurable middle segments.

The `target` node never participates: it has no members, its `status` is always
`null`, and that `null` must not degrade the chain. Member state outranks data
quality: an offline member necessarily removes recent samples, but the verdict
must be a `node_offline` verdict (`blocked` or `degraded`), never `no_samples`.
`missing_hops` keeps its original meaning (no sample at all in the window) and is
not rewritten by `status`; the two answer different questions ("which hop has no
data" vs "can this chain be used right now"). A group's own `nodes[].status` is
only the worst member: one offline member makes the group `offline` even when the
chain is still usable, so a group `offline` implies neither a chain `blocked`
nor necessarily a chain `degraded` (it also depends on the hop's strategy).
`node` is set for `node_offline` in both `blocked` and `degraded`: `seq` is the
group containing the offline member, and `name` / `member_name` both carry the
member name (`name` keeps its old meaning; `member_name` is the explicit new
field so clients do not have to distinguish group-node names from member names).
For `blocked` it names the first offline member in topology order; for
`degraded` it only considers **balanced** hops (an offline backup of a
`failover` / `lowest_latency` hop is not a degradation cause). With several
offline members it names the one with the smallest group `seq` and, within that
group, the earliest `(priority, server_id)`.

The response `summary` has no `blocked` / `degraded` counter, but the overview
endpoint (`GET /api/v1/overview`) exposes `chains.blocked` / `chains.degraded`
using **the same per-hop rule** (`crate::chains::hop_state`): `blocked` means the
configuration cannot be delivered (`blocked_reason`: certificate / capability)
**or** a required hop has no online member; `degraded` means not blocked and only
balanced hops have offline members (capacity loss) or some member is
`abnormal` / `no_data`. The old `forward_status.target_fail_count` threshold is no
longer used for the overview `degraded` counter — that is runtime health, not
member availability. The overview counters are the **member-state** verdict;
they do not include the data-quality downgrades of this endpoint (`no_samples` /
`slow` / `unmeasurable`). For the same batch of chains with complete current
samples, counting `status.kind` matches the overview counters (covered by a
route-level test). The computation reads the topology once and merges it in
memory: O(chains × groups × members), with a fixed number of SQL queries (three
topology queries + at most one certificate query + one forward counter query),
no N+1. `summary.slow_chains` keeps its purely numeric definition (measurable
chains whose overall delta is ≥ 8ms) and is not filtered by `kind`: a slow chain
with a `degraded` / `node_offline` verdict is still counted (as a `blocked` slow
chain was before), while its own `status.cause` is `node_offline` because that
rule has higher priority. Every pre-existing field (`segments` / `series` /
`loss_pct` / `loss_partial` / `diagnosis` / `missing_hops`) keeps its exact
semantics; `status` is an additive composite view.

Time windows: `series` covers the last `hours`; the current value uses the last
2 hours of bucket medians and the baseline uses the 24 hours before that. The
2-hour current window is deliberate: a 2-hour incident is only 1/12 of a 24-hour
median and would be invisible, while 2 hours still filters single-bucket noise.
The summary focuses on the most degraded chain (largest positive delta, then
largest current, then id), so one chain at +25ms is not hidden by a median of
zero. Both the headline and `slow_chains` only consider **measurable** chains
(`last_hop.measurable = true`): an unmeasurable chain's samples can only be
stale leftovers and its status is `unknown`, so it must not take over the
headline or contradict `status.cause = "slow"`. `worst_hop` is the highest
current segment p50 across chains.

Within a bucket, overall p50/p10/p90 are sums of the segment values; a bucket
with any missing segment is `null`. Per-segment `delta_ms` is current minus
baseline. `contribution_pct` is the segment's positive delta divided by the sum
of all positive deltas. `diagnosis.kind` is `unknown` when data is insufficient
or the overall delta is ≤ 0, `single_hop` when one segment contributes at least
80%, and `overall` otherwise. `slow_chains` counts **measurable** chains with an
overall delta of at least 8ms (unmeasurable chains are `unknown` and can never
be `slow`).

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
probed chain also uses `false`. An unmeasurable final hop does not count as a
missing segment (it is never probed, so it must not keep the chain "partially
probed" forever). `loss_samples` sums the raw counts of the
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
dividing, matching the segment-level rules. The final hop is a segment too: on
a measurable chain (native + tcp) a bucket with its latency samples participates
in the chain-level "all segments present" check, so the chain-level overall p50
includes the hop to the target. On an unmeasurable chain the final hop's
per-segment series stays all `null` and does not participate.
The chain-level `series[]` is non-null only when **all** segments have samples
in that bucket; per-segment series are independent views and cannot be derived
from each other. All of this
is computed in memory from the same sample/probe rows—no SQL is issued per
segment—so the query count is independent of the number of segments.

`segments[].members` is the per-member breakdown of a segment, meant for the
hover/detail view of the per-segment latency card. Every segment lists **all
members of its source group** (segment i is group i → group i+1, or the last
group → chain target), in the same order as `nodes[i].members`
(`priority ASC, server_id ASC`). A single-member segment still returns a
one-element array so the client can decide from the length whether to expand.
`server_id` is the real member (`servers.id`), `name` is the server name, and
`status` is `servers.status` verbatim (`online` / `offline` / `abnormal` /
`no_data` …). `p50_ms` uses the **same current window as the segment value**
(the last 2 hours of `CURRENT_WINDOW_SECS`, or the request window when
`hours < 2`, aligned to `bucket`) and only that member's own forward samples:
per-bucket p50, then the median of those bucket p50s—the same algorithm as the
segment value. A member with no samples is `null`, never 0. `loss_pct`,
`attempts` and `failures` use the same current window and that member's own
probe counts: `loss_pct = failures / attempts × 100` rounded to 4 decimals,
`null` when `attempts = 0`; the counts are per member, not the segment totals.
`active` says whether the member is the source group's current-path member
(`nodes[i].active_server_id`, with the segment index equal to the source group
index). It can only be `true` for a **multi-member group** whose strategy is
`failover` / `lowest_latency`: the entry group has no previous hop, round
robin / hashed / weighted / least-conn have no single selection, and a
single-member group has nothing to select, so all of those are `false`. The
segment-level rules are unchanged: the segment `p50` is still the median of the
pooled member samples, segment `attempts` / `failures` are member sums, and the
segment loss still divides summed counts. `members` only re-slices the same
rows per member and changes none of `segments[].p50` / `loss_pct` / `series`,
the chain-level `series` / `loss_pct`, `nodes` or `status`. Offline members keep
their verbatim `offline` status; samples are not filtered by status (matching
the segment value), so a just-offline member may still have samples or may have
`p50_ms: null`. It adds no SQL: everything is merged in memory from the same
latency-sample and probe rows, so the query count is independent of the number
of members. No per-member time series is returned—polling segments draw the
aggregate line only and the hover shows the breakdown.

Performance: three topology queries (chains / groups / members), one
`forward_latency_samples` query with `forward_id IN (...)`, one
`forward_probe_samples` query reading the 5-minute buckets across the series
window with `forward_id IN (...)`, and one `forward_status` query selecting
`forward_id, targets_json` for the same ids (skipped entirely when there are no
ids; a row whose JSON fails to parse is logged and treated as missing data);
no N+1. Entry/exit, `nodes`, `active_server_id`, the per-segment series and the
per-segment `members` breakdown add
no queries—they are derived from those same rows in memory. On the preview
database `EXPLAIN QUERY PLAN` shows `SCAN chains USING INDEX idx_chains_created`,
`SCAN chain_groups USING INDEX idx_chain_groups_chain` (an index-order scan, not
a full table scan), the `chain_group_members` primary-key index plus primary-key
lookups on `chain_groups` and `servers`,
`idx_forward_latency_samples_forward_ts (forward_id=? AND ts>?)`, and
`idx_forward_probe_samples_forward_ts (forward_id=? AND ts>? AND ts<?)` plus a
temporary B-tree for the ordered result; there is no full table scan of either
samples table. The response is cached for 30 seconds in `ChainHealthCache` keyed
by `(hours, bucket, (matched server ids, unknown server ids))` — the two sets
are kept apart because `scope` / `warnings` are cached with the body, so one id
changing from unknown to matched must not reuse the old entry — with
`X-Chain-Health-Cache: hit|miss`.

`scripts/seed-preview.sh` writes 15 servers / 8 chain templates / 26 chains
(80 groups / 98 members), covering every verdict the per-hop rules in §1.3 can
produce:

- **ok (multi-path / single-select hop with a lost member)**
  - 港日多路径 (603) is 香港-01 → (东京-01 online / 东京-02 offline) → 大阪-01;
    the middle group is `lowest_latency`, so the offline candidate only removes
    a spare and 东京-01 still carries the hop. The chain is `ok`.
  - 管理员 · 主备三跳 (781) has a `failover` middle group with priority 0
    东京-02 offline and priority 1 东京-03 online; the current path still runs
    through 东京-03, so the chain is `ok`.
  - 港新直达链 (602), nora · 港日双路 C (717), demo · 港新入口 C (733),
    mei · 港日新四跳 (722) and nora · 四跳空闲 (763) have only `online` members
    and complete 24-hour samples, so they are `ok`; 763 simply has zero traffic.
- **degraded (balanced hop with a lost member)** — kenji · 港日双路 (711) has an
  `ip_hashed` entry group with 香港-02 online / 香港-03 offline while the other
  hops stay online, so it is `degraded` / `node_offline` naming 香港-03.
- **blocked (a required hop with no online member)** — mei · 港日双路 B (713)
  has a single `lowest_latency` member 东京-02 offline, so that hop has no
  online member; nora · 港日新四跳 (723) has the same single offline 东京-02 in
  its `ip_hashed` hop; nora · 五跳备线 (752) has all four members of its
  `ip_hashed` entry group offline / no-data (the whole-group-offline case), and
  nora · 三跳空闲 (772) exits through the single offline 香港-03.
- **disabled** — the 美西备用线 template (703) stays `enabled = 0` and its
  template insight reports `blocked` / `disabled`; chain 716 stays as a
  historical chain on that template and is `blocked` because 美西-01 is offline.
- **Samples** — every `online` member (including 新加坡-02 / 曼谷-01, where the
  Agent is online but Xray is stopped) gets the full last 24 hours; only
  `offline` members stop at `last_seen_at`, and streams pointing at an offline
  next hop stop at the same point. There is therefore no chain whose members are
  all online but whose `status` is `no_samples`. The seed writes **32166**
  `forward_latency_samples` and **26590** `forward_probe_samples` at 5-minute
  granularity over 24 hours; final-hop samples use an empty `target_server_id`
  so they land on the final segment. The fourth hop of the active 706 chain
  (新加坡-01 → 新加坡-03) is deliberately slow and loses about 2.9% of probes
  (other paths ~0.2%). Only the three forwards of 781 / 782 carry `targets_json`
  with `active` keys; every other chain keeps the old format so the missing key
  is never read as false / a current path.
- **Idempotency** — fixed ids plus delete-then-insert inside one transaction;
  two consecutive runs report identical totals (26 chains / 80 groups / 98
  members / 32166 latency / 26590 probe / 9408 availability samples) and only
  write `data/preview.db`.

Tests also cover the unmeasurable-final-hop regression: realm / nftables /
tunnel / native+udp / native+both chains keep their `series` (the unmeasurable
final hop no longer empties it), report `last_hop.measurable = false` with the
right reason, keep the final hop out of `missing_hops`, and get `status =
unknown/unmeasurable` instead of `degraded/no_samples`; native + tcp keeps the
old behaviour; a final-hop sample that only exists in the 24-hour baseline
window still leaves the hop in `missing_hops`; both health caches prove that an
id switching from matched to unknown misses. The existing suite covers
single-hop, multi-hop, multi-path estimation, the final-hop rule
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
multi-member counts summed), `nodes` roles, single-member nodes, multi-member
`members` complete and ordered by `(priority, server_id)`, `member_count`,
group status as the worst member (`online` + `abnormal` → `abnormal`; `no_data` +
`offline` → `offline`), the target's `members: []` / `member_count: 0` /
`server_id: null`, chain `status` (all three kinds: `ok` with complete current
data, `degraded` / `node_unhealthy` for `abnormal` / `no_data`, `degraded` /
`no_samples`, `degraded` / `slow`, a single-member hop going offline →
`blocked` / `node_offline` naming the smallest-`seq` offline member, a second
member of a multi-member **balanced** group going offline → `degraded` /
`node_offline` naming that member, a `failover` / `lowest_latency` group
partially offline with an online member left → `ok` (the selected member is
still available, no longer degraded), every member of a group going offline →
`blocked`, a partially offline entry group → `degraded` (not blocked), several
degraded groups staying `degraded`, partial offline plus `abnormal` → `degraded`
with `node_offline` as the cause (and the named member comes from a balanced
hop, never a failover backup), an empty group → `blocked` with `node: null`,
offline outranking a slowdown, and the
target's `null` status not affecting the verdict), entry/exit (single member,
multi-member priority,
`public_port` → `listen_port` fallback, internal-address fallback with
`address_source`, IPv6 bracketing, missing port keeping `ip`, empty groups →
`null`), per-segment series (same length as the chain series, missing buckets
`null`, `attempts = 0` → `loss_pct: null`, probes without latency → `null`,
multi-member buckets pooled), per-segment `members` (three members in node
order, per-member p50/loss from each member's own samples, a member without
samples → `null`, `attempts = 0` not filled with 0, a single-member segment
returning one element with `active: false`, failover / lowest-latency marking
only the current member `active: true`, round robin staying all `false` even with a polluted
single `active` flag, a single-member failover group never active, an offline
member keeping `status: offline` with `p50` possibly `null`, and member p50
sharing the segment's current 2-hour window while the series still keeps older
samples), summary worst-loss selection, filtering
(hit/unknown/empty/invalid/201 ids), entry/exit preserved under `server_ids`
filtering, loss under `server_ids` filtering, latency regression, bad
`hours`/`bucket`, cache-key isolation, cross-view representative agreement plus
query plans and 401/403. Overview counters are covered as well: a failover chain
with one offline backup is not degraded, a balanced chain with one offline
member is degraded, an all-offline hop is blocked, an abnormal member is
degraded, the old `target_fail_count` threshold no longer affects the counter,
and requesting the overview and chain-health for the same three chains yields
identical `blocked` / `degraded` counts when aggregated by `status.kind`. No
migration is added; `crates/proto` and
`crates/agent` are unchanged (the agent only probes native + tcp forwards, which
is exactly the boundary `last_hop` reports), and no `web/` changes are made.
