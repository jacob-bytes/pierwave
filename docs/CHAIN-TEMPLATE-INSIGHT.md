# 转发链模板洞察（`/api/v1/overview/chain-templates`）

> English follows the Chinese sections.
>
> 本接口给「概览 → 链路时延」页底部使用：列表回答每个模板被谁在用、现在
> 能不能用；详情把模板的候选成员、真实链的路径边、目标与用户增长放在同一
> 份响应里。与 [`docs/CHAIN-TEMPLATES.md`](CHAIN-TEMPLATES.md) 的模板 CRUD、
> [`docs/CHAIN-HEALTH.md`](CHAIN-HEALTH.md) 的链健康是两个不同视图。

## 1. 接口 / Endpoints

```
GET /api/v1/overview/chain-templates
GET /api/v1/overview/chain-templates/{id}?hours=24
```

仅管理员（`require_admin`）：未登录 401，普通用户 403。详情 `hours` 只接受
`24` / `168`（缺省或空串 = 24），其它整数 / 非整数一律 400，错误码
`query.chain_templates_hours_invalid`。模板不存在返回 404
`chain_template.not_found`。

English: admin only (401 unauthenticated, 403 for normal users). `hours` accepts
only 24 or 168 (omitted/empty = 24); anything else is 400
`query.chain_templates_hours_invalid`. A missing template is 404
`chain_template.not_found`.

### 1.1 列表 / List

```jsonc
{
  "generated_at": 1795500000,
  "items": [{
    "id": "c0ffee00-0007-4000-8000-000000000701",
    "name": "港日双路",
    "hops": 3,
    "enabled": true,
    "chains": 4,
    "users": 2,
    "status": { "kind": "blocked", "cause": "member_offline" },
    "strategies": [{ "strategy": "ip_hashed", "chains": 4 }],
    "targets": [
      { "host": "198.51.100.201", "port": 443, "chains": 2 },
      { "host": "198.51.100.101", "port": 8443, "chains": 1 },
      { "host": "198.51.100.200", "port": 443, "chains": 1 }
    ]
  }]
}
```

- `hops` = 模板定义的组数（`groups_json` 解析后的长度），与链视图的
  `hops = chain_groups` 行数同口径；
- `chains` = 仍然存在（未删除）且 `chains.template_id = 模板 id` 的链数，
  **含用户链与管理员链、含停用链**；
- `users` = 这些链的 `owner_user_id` 去重数；管理员链 owner 为空，不计入；
- `status`：模板被停用 → `blocked/disabled`；否则模板**每个组的候选成员**
  里任一 `servers.status = offline` → `blocked/member_offline`；任一非
  `online`（`abnormal` / `no_data` / 服务器已被删除）→ `degraded`（`cause`
  为 `null`）；全部 online → `ok`；模板没有任何候选成员 → `degraded`
  （`cause` 为 `null`）。模板状态只看模板定义，不看某条链是否停用；
- `strategies`：按**每条链第一跳**（`seq` 最小且非空组）的
  `chain_groups.strategy` 聚合。一条链即使中间跳策略不同也只贡献第一跳，
  所以按链去重；`chains` 是该策略的链数（不是跳数）；
- `targets`：实际链的 `target_host:target_port` 聚合，按 `chains` 降序；
- 排序：`chains` 降序 → `name` 升序 → `id` 升序（稳定兜底）。

English: `chains` counts every row whose `template_id` matches (user and admin
chains, enabled or disabled). `users` deduplicates non-null `owner_user_id`;
admin chains (owner NULL) are not users. `status` is `blocked/disabled` for a
disabled template; otherwise any offline candidate member of **any** template
group makes it `blocked/member_offline`, any non-online candidate (including a
deleted server) makes it `degraded` with a null cause, no candidates at all is
also `degraded`, and all online is `ok`. `strategies` counts each chain once by
the strategy of its first non-empty group. `targets` aggregate actual chain
targets. Items are ordered by `chains` desc, `name` asc, then `id` asc.

### 1.2 详情 / Detail

```jsonc
{
  "generated_at": 1795529469,
  "template": {
    "id": "c0ffee00-0007-4000-8000-000000000701",
    "name": "港日双路", "hops": 3, "created_at": 1787753422
  },
  "nodes": [
    {
      "seq": 0, "role": "source", "name": "入口",
      "members": [
        { "server_id": "…0001", "name": "香港-01", "status": "online",
          "chains": 4, "users": 2 },
        { "server_id": "…0002", "name": "香港-02", "status": "online",
          "chains": 0, "users": 0 }
      ]
    },
    {
      "seq": 1, "role": "hop", "name": "第 2 跳",
      "members": [
        { "server_id": "…0004", "name": "东京-01", "status": "online",
          "chains": 4, "users": 2 },
        { "server_id": "…0005", "name": "东京-02", "status": "offline",
          "chains": 4, "users": 2 }
      ]
    },
    {
      "seq": 2, "role": "hop", "name": "第 3 跳",
      "members": [
        { "server_id": "…0006", "name": "大阪-01", "status": "offline",
          "chains": 4, "users": 2 }
      ]
    },
    {
      "seq": 3, "role": "target", "name": "目标",
      "members": [
        { "name": "198.51.100.201:443", "chains": 2, "users": 1 },
        { "name": "198.51.100.101:8443", "chains": 1, "users": 0 },
        { "name": "198.51.100.200:443", "chains": 1, "users": 1 }
      ]
    }
  ],
  "edges": [
    { "seq": 1,
      "from": { "seq": 0, "member": "香港-01" },
      "to":   { "seq": 1, "member": "东京-01" },
      "chains": 4, "users": 2, "p50_ms": 13.5, "loss_pct": 0.1515 },
    { "seq": 1,
      "from": { "seq": 0, "member": "香港-01" },
      "to":   { "seq": 1, "member": "东京-02" },
      "chains": 4, "users": 2, "p50_ms": null, "loss_pct": 0.1515 },
    { "seq": 2,
      "from": { "seq": 1, "member": "东京-01" },
      "to":   { "seq": 2, "member": "大阪-01" },
      "chains": 4, "users": 2, "p50_ms": null, "loss_pct": null },
    { "seq": 3,
      "from": { "seq": 2, "member": "大阪-01" },
      "to":   { "seq": 3, "member": "198.51.100.201:443" },
      "chains": 2, "users": 1, "p50_ms": null, "loss_pct": null }
  ],
  "targets": [
    { "host": "198.51.100.201", "port": 443, "chains": 2,
      "users": [{ "id": "…0202", "name": "mei" }] }
  ],
  "users": [
    { "id": "…0202", "name": "mei", "chains": 2 },
    { "id": "…0201", "name": "kenji", "chains": 1 }
  ],
  "series": [{ "ts": 1795442400, "chains": 4, "users": 2 }],
  "strategies": [{ "strategy": "ip_hashed", "chains": 4, "users": 2 }]
}
```

#### nodes

- 来自**模板定义**（`groups_json`），不是某条链的实际拓扑：模板每个组一个
  节点，`members` 是该组**全部候选成员**（顺序沿用 `groups_json` 的
  `server_ids`），末尾补一个 `role = "target"` 的目标节点；
- `seq`：组节点用模板组的 `seq`（规范化后 0..n-1），目标节点 =
  `hops`（例如 3 跳 → 目标 `seq = 3`）；
- `name`：入口 `入口`，其余 `第 N 跳`，目标 `目标`（模板组没有名称字段）；
- 成员 `chains` / `users` = **实际链**在该组包含该成员的去重链 / 用户数；
  候选成员没有链经过时是 0，但仍出现在 `nodes` 里；
- 服务器成员的 `status` 是 `servers.status` 原样；服务器已被删除时
  `status = "unknown"`、`name` 回退服务器 id。目标成员只有 `name`
  （`host:port`，IPv6 带方括号）与 `chains` / `users`，没有 `server_id` /
  `status`；
- 目标成员按 `chains` 降序 → `name` 升序。

#### edges

- **按真实链的 groups 聚合**，不按模板的候选组合：
  - 相邻两组：链实际包含的「源成员 → 下一组成员」每个成员对一条边；
  - 最后一组：每个成员 → 该链目标（`host:port`）一条边，`to.seq =
    最后一组 seq + 1`；
  - 同一 `(from.member → to.member)` 跨链合并，`chains` / `users` 去重；
- `seq` 是**目标** side 的 `seq`，与 chain-health 的「段」编号一致；
- `p50_ms` / `loss_pct` 复用 chain-health 的样本口径：
  - 时延：最近 **2 小时**（`CURRENT_WINDOW_SECS`）内该成员对
    （`forward_id` + `target_server_id`）的样本中位数，保留 1 位小数；
  - 丢包：同一窗口 `forward_probe_samples` 的
    `failures / attempts × 100`，保留 4 位小数；`attempts = 0` 时 `null`，
    **不补 0**；
  - 拿不到就是 `null`。多成员下一跳的探测不区分目标，同一源成员的每条
    出边共享该 forward 的 attempts/failures（与 chain-health 的段级口径
    一致），所以 `loss_pct` 可能相同而 `p50_ms` 不同；
- 排序：`seq` 升序 → `chains` 降序 → `from.member` → `to.member`。

#### targets / users / strategies / series

- `targets`：实际目标明细，按 `chains` 降序 → `host` → `port`；`users` 只含
  `id` / `name`，用于前端 tooltip「有哪些用户在用」，按名称升序；
- `users`：这些链的 owner 明细，`chains` 是该用户在本模板下的链数，按
  `chains` 降序 → 名称升序；管理员链没有 owner，不出现；
- `strategies`：按每条链第一跳策略聚合，`chains` 是链数、`users` 是去重
  owner 数；
- `series`：`hours` 窗口内按 **15 分钟** 桶的「累计链数 / 去重用户数」。
  `ts` 是桶起点，从旧到新；用 `chains.created_at` 派生——创建即计入，
  删除不扣减历史（没有删除时间可扣）。链在桶结束前创建就出现在该桶；
  窗口内没有创建时仍返回补齐的 0 值数组，长度 = `hours * 4`（24h = 96，
  168h = 672）。

English: `nodes` come from the template definition and list **every candidate
member** per group, not only the members a particular chain selected. `chains`
and `users` on a member are the distinct actual chains / owners that include
that member in that group; an unused candidate stays visible with zeroes. The
target node has one member per actual `host:port`. `edges` aggregate real chain
groups: every actual member pair between adjacent groups, plus each last-group
member to the chain target; the same member pair across chains is merged.
`seq` is the destination group's `seq` (the final hop is `last seq + 1`), the
same convention as chain-health segments. `p50_ms` is the median of the
`(forward_id, target_server_id)` samples in the current 2-hour window;
`loss_pct` is `failures / attempts × 100` from the same window, `null` when
`attempts = 0` (never 0). Multi-target probes cannot distinguish targets, so all
outgoing edges of a source member share that forward's counts. `targets` and
`users` carry the user id/name for tooltips. `strategies` counts each chain once
by its first-hop strategy. `series` is a cumulative 15-minute-bucket curve
derived from `chains.created_at`: creation counts immediately, deletion never
rewinds history, and a window with no creations still returns the full array of
zeroes (`hours * 4` points: 96 / 672).

## 2. 统计口径 / Semantics summary

| 字段 | 口径 |
|---|---|
| 列表 `chains` | `chains.template_id = id`，未删除，含用户链 / 管理员链 / 停用链 |
| 列表 / 详情 `users` | 上述链的 `owner_user_id` 去重；NULL 不计 |
| `nodes[].members[].chains` | 在该组包含该服务器成员的链数 |
| `nodes[].members[].users` | 同上链的 owner 去重 |
| `edges[].chains` | 实际包含该 from→to 成员对的链数 |
| `edges[].users` | 这些链的 owner 去重 |
| 目标节点 / `targets` | 实际链的 `host:port` 聚合，不含模板里没被用到的目标 |
| `series` | 截至桶末的累计链数 / 用户数，`created_at` 派生 |
| `strategies` | 每条链第一跳 `chain_groups.strategy`，按链去重 |

English: the table above is the complete counting contract. A chain is never
counted twice in `chains`, `users`, target nodes, `series` or `strategies`; the
only place a chain can contribute to more than one row is `edges` (one row per
actual member pair it contains, and the final target edge).

## 3. 查询与缓存 / Queries and cache

查询次数固定，与模板 / 链 / 成员数量无关，没有 N+1：

- 列表（5 条 SQL）：`chain_templates` 1 +
  `chains` / `chain_groups` / `chain_group_members JOIN servers` 3 +
  `servers` 状态快照 1；
- 详情（8 条 SQL）：模板 1 + 链拓扑 3 + 服务器状态 1 + 用户名字 1 +
  `forward_latency_samples` 1 + `forward_probe_samples` 1。样本只在详情页
  查，且只覆盖当前 2h；所有 forward id 一次 `IN (...)` 读完。

在 `data/preview.db`（迁移建库、不跑 `ANALYZE`）上实测：

```
-- 模板列表：新增索引，无临时 B 树
SCAN chain_templates USING INDEX idx_chain_templates_created

-- 用户名字：主键 IN
SEARCH users USING INDEX sqlite_autoindex_users_1 (id=?)

-- 链 / 组 / 成员（与 chain-health 同一批查询）
SCAN chains USING INDEX idx_chains_created
SCAN chain_groups USING INDEX idx_chain_groups_chain
SCAN m USING INDEX sqlite_autoindex_chain_group_members_1
SEARCH g USING INDEX sqlite_autoindex_chain_groups_1 (id=?)
SEARCH s USING INDEX sqlite_autoindex_servers_1 (id=?)
USE TEMP B-TREE FOR ORDER BY

-- 当前 2h 时延样本（每个 forward id 一次 (forward_id, ts) 区间探测）
SEARCH forward_latency_samples USING INDEX idx_forward_latency_samples_forward_ts (forward_id=? AND ts>?)
USE TEMP B-TREE FOR ORDER BY

-- 当前 2h 探测总数（同一批 forward id）
SEARCH forward_probe_samples USING INDEX idx_forward_probe_samples_forward_ts (forward_id=? AND ts>? AND ts<?)
```

没有 `SCAN forward_latency_samples` / `SCAN forward_probe_samples` 全表扫描。
`SCAN ... USING INDEX` 是按索引顺序扫描，不是整表扫描。迁移 0068 只追加
`idx_chain_templates_created(created_at)`，不新增表 / 列。

缓存 30 秒（`ChainTemplateInsightCache`，`AppState` 内），key =
`(template_id, hours)`：列表固定 `(None, 0)`，详情是 `(Some(id), 24|168)`。
响应头 `X-Chain-Templates-Cache: hit|miss`。TTL 语义，最多陈旧 30 秒；`0`
TTL 用于测试关闭缓存。列表与详情、24h 与 168h 不会互相命中。

English: fixed query counts (list 5, detail 8), no N+1; the SQL plan above is
the measured one on the preview database. Migration 0068 only adds the
`(created_at)` index. The response is cached for 30 seconds keyed by
`(template_id, hours)` (list = `(None, 0)`), with
`X-Chain-Templates-Cache: hit|miss`.

## 4. 造数 / Preview seed

`scripts/seed-preview.sh` 每次重建 3 个模板 + 9 条链（3 条原管理员链 + 6 条
用户链），并写入相应 groups / members / 样本：

- `港日双路`：3 跳，入口组 `[香港-01, 香港-02]`、中转组
  `[东京-01, 东京-02]`、出口组 `[大阪-01]`；东京-02 与大阪-01 离线 →
  `blocked/member_offline`；4 条链（1 条管理员 + kenji + mei 两条），
  `users = 2`；`香港-02` 是未被使用的候选（`chains = 0`）；
- `港新单跳`：1 跳 `[香港-02]`，2 条链（kenji / nora），目标相同，
  `users = 2`、`status = ok`；
- `美西备用线`：2 跳，已停用；nora 的历史链仍挂在模板上 →
  `blocked/disabled`，`chains = 1`、`users = 1`；
- 用户链的 `owner_user_id` 落到真实的 `kenji` / `mei` / `nora`；mei 的两条
  港日双路链目标相同，用来验证 users 去重而 chains 不去重；
- 三条策略都有链在用：`ip_hashed`（港日双路）、`round_robin`（港新单跳）、
  `lowest_latency`（美西备用线）；
- 港新单跳链有 24h 时延 / 探测样本，详情里能看到边 `p50_ms ≈ 18ms`。

English: the seed rebuilds three templates and nine chains (three original admin
chains plus six user chains), with groups, members and samples. It covers a
blocked multi-member template, a healthy single-hop template, a disabled
template with a historical chain, distinct owners, duplicate targets for the
same user, and all three strategies.

## 5. 测试 / Tests

- 领域层（`crates/domain/src/chain_template_insight.rs`）：列表链数 / 用户
  去重 / 管理员链不计 users / 状态 disabled / member_offline / degraded /
  无成员 / 服务器已删除；排序 `chains` 降序 → 名称升序；详情候选成员全部
  出现（含 0 链成员）、目标节点、同目标 / 不同目标、边合并、边 p50 与
  丢包、管理员链不产生用户、series 累计与 0 值补齐、168h 长度、IPv6 目标；
- 路由层（`crates/master/src/routes/chain_template_insight.rs`）：列表 /
  详情真实 JSON、模板无链、单链、多链多用户、多模板共享服务器不串、
  停用模板、目标相同 / 不同 / 无目标、404 / 400 / 403 / 401、缓存
  `hit/miss` 与 hours 隔离；
- 缓存层（`crates/master/src/state.rs`）：`(id, hours)` key 隔离、TTL、
  禁用；
- 查询计划（`crates/domain/tests/query_plan.rs`）：模板列表必须走
  `idx_chain_templates_created`，用户名字必须走 `users` 主键。

English: domain tests cover counts/status/edges/series/formatting; route tests
cover the real JSON contract and every requested boundary (no chain, single
chain, multi-user, shared server across templates, disabled, same/different/no
targets, 404/400/403, cache hit/miss); state tests cover key isolation and TTL;
the query-plan test locks the template index and the users primary key.

## 6. 未做 / Not in this iteration

- 不新增表 / 列：只追加一个模板排序索引（迁移 0068）；
- 不记录删除历史：`series` 的累计值只增不减，删除链不会让过去的点变低；
- 边级 `p50_ms` / `loss_pct` 固定最近 2h，不随 `hours` 放大到 24h / 168h
  （`hours` 只影响 `series`）；这是为了与 chain-health 的段值同口径，避免
  长窗口把最近的事故稀释掉；
- 多成员下一跳的探测无法拆到具体目标，同一源成员的出边共享 attempts /
  failures；
- 不改 `crates/proto`、`crates/agent`、`web/`：接口只读现有表与链拓扑。
