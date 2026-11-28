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
- `status`：模板被停用 → `blocked/disabled`；否则与链级可用性同一口径，
  **按组**判断：模板**某个组的候选全部离线**（这一跳没有任何在线候选）→
  `blocked/member_offline`；组内还有在线候选、只是掉了部分成员 → `degraded`
  （`cause` 为 `null`，容量下降）；任一非 `online` 但没有被确认离线的候选
  （`abnormal` / `no_data` / 服务器已被删除）→ `degraded`（`cause` 为
  `null`）；全部 online → `ok`；模板没有任何候选成员 → `degraded`
  （`cause` 为 `null`）。模板状态只看模板定义，不看某条链是否停用；
- `strategies`：按**每条链第一跳**（`seq` 最小且非空组）的
  `chain_groups.strategy` 聚合。一条链即使中间跳策略不同也只贡献第一跳，
  所以按链去重；`chains` 是该策略的链数（不是跳数）；
- `targets`：实际链的 `target_host:target_port` 聚合，按 `chains` 降序；
- 排序：`chains` 降序 → `name` 升序 → `id` 升序（稳定兜底）。

English: `chains` counts every row whose `template_id` matches (user and admin
chains, enabled or disabled). `users` deduplicates non-null `owner_user_id`;
admin chains (owner NULL) are not users. `status` is `blocked/disabled` for a
disabled template; otherwise it follows the same per-group rule as chain
availability: a template group whose candidates are **all offline** (no online
candidate left on that hop) makes the template `blocked/member_offline`, while a
group that still has an online candidate and only lost some members makes it
`degraded` with a null cause (capacity reduced). Any non-online candidate that
is not confirmed offline (`abnormal` / `no_data`, including a deleted server)
also makes it `degraded` with a null cause; no candidates at all is `degraded`,
and all online is `ok`. The template status only looks at the template
definition, not at whether a particular chain is disabled. `strategies` counts
each chain once by the strategy of its first non-empty group. `targets` aggregate
actual chain targets. Items are ordered by `chains` desc, `name` asc, then `id`
asc.

### 1.2 详情 / Detail

```jsonc
{
  "generated_at": 1795529469,
  "template": {
    "id": "c0ffee00-0007-4000-8000-000000000701",
    "name": "港日双路", "hops": 3, "created_at": 1787753422,
    "stale": false, "stale_reason": null
  },
  "nodes": [
    {
      "seq": 0, "role": "source", "name": "入口",
      "members": [
        { "server_id": "…0001", "name": "香港-01", "status": "online",
          "chains": 4, "users": 2 }
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
  "series_basis": "existing_chains",
  "unused_candidates": [
    { "seq": 0, "server_id": "…0002", "name": "香港-02", "status": "online" }
  ],
  "strategies": [{ "strategy": "ip_hashed", "chains": 4, "users": 2 }]
}
```

#### nodes

`nodes` **只来自真实链的实际拓扑**（`chain_groups` / `chain_group_members`），
模板只提供候选清单。这样模板改过跳数 / 成员之后，详情仍然按链真实走法画图，
不会出现「模板 3 跳、链 2 跳」时节点与边错位、计数大面积归零。

- **组节点**：真实链出现过的每个组 `seq` 一个节点，`members` 是该组**实际
  被链使用**的成员（按 `(priority, server_id)` 排序），不再是模板候选；
  成员 `chains` / `users` = 在该组包含该成员的去重链 / 用户数；
- **顺序 / seq**：组节点按真实 `seq` 升序；目标节点 `seq = 真实最后一组
  seq + 1`。**没有链就没有 nodes**（模板从未被使用时不画假拓扑）；
- **role**：真实第一组 `source`，其余组 `hop`，末尾 `target`；
- **name**：优先用真实链的组名（`chain_groups.name`，多条链取第一个非空），
  没有组名时回退 `入口` / `第 N 跳`；目标节点固定 `目标`；
- 服务器成员的 `status` 是 `servers.status` 原样；服务器已被删除时
  `status = "unknown"`、`name` 回退服务器 id。目标成员只有 `name`
  （`host:port`，IPv6 带方括号）与 `chains` / `users`，没有 `server_id` /
  `status`；
- 目标成员按 `chains` 降序 → `name` 升序；
- **没有被任何链用到的候选成员**放在 `unused_candidates`：
  `{ seq, server_id, name, status }`（`seq` 是它在**模板**里的组号），
  不混进 `nodes`；
- **`template.stale`**：存在链的跳数或成员与模板**当前定义**不一致时为
  `true`，`template.stale_reason` 给出中英双语说明（跳数不一致 / 某跳有
  成员不在当前候选里）。候选是「菜单」，链只选中其中几台是正常的，不算
  stale。

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
  `ts` 是桶起点，从旧到新；用 `chains.created_at` 派生。
  **口径是「按当前存在的链回填」**（响应里的 `series_basis =
  "existing_chains"`）：创建即计入，**删除链会让它在所有历史桶里一起消失**
  ——没有删除时间，无法保留删除前的历史，文档旧版里「删除不扣减历史」的说法
  是错的。链在桶结束前创建就出现在该桶；最后一个点是**当前未完成桶**
  （`ts` 向下对齐 15 分钟，统计到 `now`）。窗口内没有创建时仍返回补齐的
  0 值数组，长度 = `hours * 4`（24h = 96，168h = 672）。

English: `nodes` come **only from the actual topology of existing chains**
(`chain_groups` / `chain_group_members`); the template only supplies the
candidate list. After a template edit the detail still draws the real chain, so
nodes and edges cannot drift out of place and counts do not collapse to zero.
There is one node per group `seq` actually used by a chain, with that group's
**actually used** members ordered by `(priority, server_id)`; `chains` / `users`
on a member are the distinct actual chains / owners that include it in that
group. The target node's `seq` is the real last group's `seq + 1`; a template
that no chain uses has no `nodes` at all. Node names prefer the real
`chain_groups.name`, then `入口` / `第 N 跳`; the target is `目标`.
`template.stale` is `true` when any chain's hop count or members differ from the
template's current definition, with a bilingual `template.stale_reason`
(hop-count mismatch / a hop containing members outside the current candidates;
picking only a subset of the candidates is normal and is **not** stale).
Candidates that no chain uses are listed separately in `unused_candidates`
(`{ seq, server_id, name, status }`, `seq` being the template group) instead of
being mixed into `nodes`. `edges` aggregate real chain groups: every actual
member pair between adjacent groups, plus each last-group member to the chain
target; the same member pair across chains is merged. `seq` is the destination
group's `seq` (the final hop is `last seq + 1`), the same convention as
chain-health segments. `p50_ms` is the median of the
`(forward_id, target_server_id)` samples in the current 2-hour window;
`loss_pct` is `failures / attempts × 100` from the same window, `null` when
`attempts = 0` (never 0). Multi-target probes cannot distinguish targets, so all
outgoing edges of a source member share that forward's counts. `targets` and
`users` carry the user id/name for tooltips. `strategies` counts each chain once
by its first-hop strategy. `series` is a cumulative 15-minute-bucket curve
derived from **the chains that exist now**, declared by
`series_basis: "existing_chains"`: creation counts immediately and deleting a
chain removes it from every historical bucket (there is no deletion timestamp to
preserve history). The last point is the current unfinished 15-minute bucket
(`ts` floor-aligned, counting up to `now`); a window with no creations still
returns the full array of zeroes (`hours * 4` points: 96 / 672).

## 2. 统计口径 / Semantics summary

| 字段 | 口径 |
|---|---|
| 列表 `chains` | `chains.template_id = id`，未删除，含用户链 / 管理员链 / 停用链 |
| 列表 / 详情 `users` | 上述链的 `owner_user_id` 去重；NULL 不计 |
| `nodes[].members[].chains` | **真实链**在该组包含该服务器成员的链数（键是真实组 `seq`） |
| `nodes[].members[].users` | 同上链的 owner 去重 |
| `nodes` | 只来自真实链的 `chain_groups` / `chain_group_members`；没有链时为空 |
| `unused_candidates` | 模板候选里没有被任何链用到的成员（`seq` 是模板组号） |
| `template.stale` | 链的跳数 / 成员与模板当前定义不一致时为 true |
| `edges[].chains` | 实际包含该 from→to 成员对的链数 |
| `edges[].users` | 这些链的 owner 去重 |
| 目标节点 / `targets` | 实际链的 `host:port` 聚合，不含模板里没被用到的目标 |
| `series` | 截至桶末的累计链数 / 用户数，`created_at` 派生；按当前存在的链回填（`series_basis = "existing_chains"`） |
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

`scripts/seed-preview.sh` 每次重建 **8 个模板 + 24 条链**（22 条模板链 +
2 条不挂模板的管理员链；15 台主机、23 个节点），并写入相应 groups /
members / 样本。原有 5 个模板 / 17 条链的 id、名称、目标、成员与端口原样
保留；新增 3 个深链模板 / 7 条链（706 / 707 / 708），端口从 26001 起分配，
`(server_id, listen_port)` 全局唯一，priority 取 0..4：

- `港日双路`（`…701`）：3 跳，候选 `[香港-01, 香港-02, 香港-03]` →
  `[东京-01, 东京-02]` → `[新加坡-01, 新加坡-02, 大阪-01]`；香港-03、东京-02
  离线但每个组都还有在线候选 → `degraded`（`cause` 为 `null`，容量下降）；
  5 条链（管理员 `港日多路径` + kenji +
  mei 两条 + nora），`users = 3`。603「港日多路径」的中转组有两台成员
  （东京-01 / 东京-02），东京-02 离线只让这条链 `degraded/node_offline`
  （东京-01 仍承载这一跳）；
  `香港-03` 是未被使用的候选（`chains = 0`）；
- `港日新四跳`（`…704`）：4 跳，候选 `[香港-01, 香港-02]` →
  `[东京-01, 东京-02]` → `[新加坡-01, 新加坡-02]` → `[大阪-01]`；最后一跳
  单成员、大阪-01 在线，4 条链（kenji / mei / nora / demo，`users = 4`）的
  最后一跳都有当前 `p50_ms` / `loss_pct`；东京-02 仍是候选 → 模板
  `degraded`（第二跳还有东京-01 在线）；723 的第二跳是单成员东京-02（离线），
  链级因此是 `blocked`，721 / 724 是完整四跳路径；
- `港新入口分叉`（`…705`）：2 跳，入口组 3 台 `[香港-01, 香港-02,
  新加坡-02]`，三条链各用一个入口、都汇入新加坡-01；`status = ok`，
  `chains = 3`、`users = 3`；
- `港新单跳`（`…702`）：1 跳 `[香港-02]`，2 条链（kenji / nora），目标相同，
  `users = 2`、`status = ok`；
- `美西备用线`（`…703`）：2 跳，已停用；nora 的历史链仍挂在模板上 →
  `blocked/disabled`，`chains = 1`、`users = 1`；
- `五跳全展开`（`…706`）：5 跳，候选 5 / 3 / 2 / 4 / 1，15 台服务器每跳一组、
  组间不重复。751 kenji 是活跃链（每跳单成员，全在线：香港-01 → 东京-01 →
  东京-03 → 新加坡-01 → 新加坡-03），752 nora 是空闲链（入口 4 台含离线、
  第 2 跳两台 Xray 停止、第 3 跳与 751 共用东京-03、出口共用新加坡-03）。
  `stale = false`、`unused_candidates = []`，详情 5 层节点 + 2 个目标
  （`targets = 2`），27 条边 > 17 个节点；751 第 4 跳（新加坡-01 →
  新加坡-03）`p50 ≈ 158ms`、`loss ≈ 2.9%`，其余跳 `p50` 9–27ms、`loss`
  约 0.2%；
- `四跳混合`（`…707`）：4 跳，候选 1 / 4 / 3 / 2；761 kenji / 762 mei 活跃、
  763 nora 空闲。761 与 762 共享入口新加坡-01 与目标
  `203.0.113.250:443`，在第 2–4 跳分开；763 只走在线 / Xray 停止的成员
  （新加坡-01 → 新加坡-02 → 曼谷-01 → 首尔-01），成员状态都是 `online`，
  所以链级是 `degraded/no_samples` 而不是 `blocked`；模板候选全部 `online`
  → 模板 `status = ok`，详情 1 / 4 / 3 / 2 个节点、14 条边、2 个目标；
- `三跳大扇出`（`…708`）：3 跳，候选 1 / 5 / 3；771 kenji 活跃（中间跳 4 个
  在线候选、出口 2 个），772 nora 空闲（新加坡-01 → 新加坡-02 异常 →
  香港-03 离线 → 链级 `blocked/node_offline`）；详情 1 / 5 / 3 个节点、
  17 条边、2 个目标；
- 活跃 / 空闲：流量表是「服务器 × 节点/账号」维度，没有 `chain_id`，所以
  链级活跃度以 `forward_status` 上按链推导的 forward id 为准——活跃链
  （751 / 761 / 762 / 771）累计 `traffic_in/out > 0`，空闲链（752 / 763 /
  772）固定为 0；`traffic_daily` / `traffic_node_daily` 用来证明成员机器上
  有没有搬数据：活跃链的成员服务器今天都有行，空闲链的专属成员（香港-03、
  东京-02、美西-01、探针、新加坡-02、曼谷-01、吉隆坡-01）今天没有行。
  752 / 763 / 772 会与活跃链共用入口等在线服务器，因此按成员服务器直接求和
  会带上别的链的流量；按「空闲链专属成员」统计时为 0；
- 空闲链的样本：成员停止后不再写，所以 752 / 772 只有 24h 窗口前半段；
  763 的成员都还在线（Xray 只是停止），能保留到 3 小时前的样本，用来证明
  「链路配置可用但没流量」；
- 用户链的 `owner_user_id` 落到真实的 `kenji` / `mei` / `nora` / `demo`；
  701 的 712 / 713 目标相同，用来验证 users 去重、chains 不去重与目标节点
  合并（707 的 761 / 762 也共享目标）；
- 策略覆盖四种：`ip_hashed`（港日双路 / 港新入口分叉 / 五跳全展开）、
  `round_robin`（港日新四跳 / 港新单跳 / 四跳混合 / 三跳大扇出）、
  `lowest_latency` / `failover`（各模板的中间 / 最后一跳）；
- 样本：每条链的每个 forward 都有最近 24h、5 分钟粒度的时延与探测样本；
  东京-02（2h 前）、香港-03（3h 前）、吉隆坡-01（6h 前）、美西-01（2 天前）
  在停止后不再写入，新加坡-02 / 曼谷-01（Agent 在线、Xray 停止）按 3 小时前
  停止；从未上报的探针机不写。离线成员的截止槽位先减 30 秒再向上取整，
  避免 `last_seen_secs` 正好落在 300 秒边界时两次执行的样本数相差 1 行。
  模板洞察的成员状态直接透传 `servers.status`，所以新加坡-02 在详情里仍是
  `online`，只有样本在它停止后截断（状态契约见 §1.1 / §2）；
- 状态分布：模板层 `degraded`（`cause` 为 `null`）是 `港日双路` / `港日新四跳` /
  `五跳全展开` / `三跳大扇出`（候选含离线的香港-03 / 东京-02 / 吉隆坡-01，但
  每个组都还有在线候选，只降低容量）；`ok` 是 `港新单跳` / `港新入口分叉` /
  `四跳混合`，`美西备用线` 是
  `blocked/disabled`；链层 `港日多路径` 为 `degraded/node_offline`（东京-02
  离线，东京-01 仍承载这一跳），`nora · 五跳备线` / `nora · 三跳空闲` 为
  `blocked/node_offline`（前者入口四台全部离线，后者最后一跳是离线的单成员
  香港-03），`nora · 四跳空闲` 为
  `degraded/no_samples`；既有链 `港新直达链` / `mei · 港日新四跳` /
  `nora · 港日双路 C` / `demo · 港新入口 C` 仍是
  `degraded/no_samples`（Xray 停止、没有当前样本；`servers.status` 未改）。

English: the seed rebuilds **eight templates and 24 chains** (22 template chains
plus two admin chains without a template; 15 servers and 23 nodes). The original
five templates / 17 chains keep their ids, names, targets, members and ports.
Three deep templates add seven chains and six targets, with ports from 26001:
`五跳全展开` (706) is a 5-hop template with 5 / 3 / 2 / 4 / 1 candidates over 15
distinct servers. 751 (kenji) is active with one online member per hop
(香港-01 → 东京-01 → 东京-03 → 新加坡-01 → 新加坡-03); 752 (nora) is idle with
four entry candidates including offline machines, two Xray-stopped second-hop
members, the shared 东京-03 at hop 3 and the shared 新加坡-03 exit. Its detail
shows five node levels plus two targets, 27 edges over 17 nodes, and 751's
fourth hop (新加坡-01 → 新加坡-03) has p50 ≈ 158 ms and ≈ 2.9 % loss while the
other hops sit at 9–27 ms / ≈ 0.2 %. `四跳混合` (707) has 1 / 4 / 3 / 2
candidates: 761 (kenji) and 762 (mei) are active and share the 新加坡-01 entry
and the 203.0.113.250:443 target while diverging on hops 2–4; 763 (nora) is idle
and only uses online / Xray-stopped members (新加坡-01 → 新加坡-02 → 曼谷-01 →
首尔-01), so the chain is degraded/no_samples rather than blocked and the
template (all candidates online) is `ok`. `三跳大扇出` (708) has 1 / 5 / 3
candidates: 771 (kenji) is active with four online middle-hop candidates and two
exits, and 772 (nora) is idle through the Xray-stopped 新加坡-02 to the offline
香港-03, so it is blocked/node_offline.

Traffic is keyed by server × node/account and has no `chain_id`: chain activity
comes from the per-chain forward ids in `forward_status` (active 751 / 761 / 762
/ 771 have counters > 0, idle 752 / 763 / 772 are 0), while `traffic_daily` /
`traffic_node_daily` show whether the member machines moved data: every
active-chain member server has a row for today and the idle-only members
(香港-03, 东京-02, 美西-01, the probe, 新加坡-02, 曼谷-01, 吉隆坡-01) have none.
Idle chains share entry servers with active chains, so summing their member
servers picks up other chains' traffic; counting only their exclusive members
gives 0. Idle samples stop at the member's stop time: 752 / 772 keep only the
first part of the 24h window, while 763's members are still online (Xray is
stopped), so it keeps samples up to three hours ago to show “configured but
idle”. The older templates are unchanged: `港日双路` is a 3-hop degraded template
with three entry / two middle / three exit candidates, five chains (an admin
multi-path chain plus four user chains) and three users; its admin chain
`港日多路径` has a multi-member middle hop and is `degraded/node_offline` because
东京-02 is offline while 东京-01 still carries that hop. `港日新四跳` is a 4-hop
template whose last hop is a single online member (大阪-01), so all four chains
have current p50/loss on their final edges while the template itself is
`degraded` because the offline 东京-02 candidate still leaves 东京-01 online on
the middle hop; 721 / 724 are complete 4-hop paths. `港新入口分叉`
uses three entry machines (one per chain) and is `ok`. The single-hop `港新单跳`
is `ok`; the disabled `美西备用线` keeps nora's historical chain
(`blocked/disabled`). Owners are the real kenji / mei / nora / demo users;
712 / 713 share a target to exercise user deduplication and target merging
(761 / 762 do the same in 707). All four strategies are covered, and every chain
forward has 24h of 5-minute latency/probe samples; offline members (东京-02,
香港-03, 吉隆坡-01, 美西-01) stop at their last heartbeat and the Xray-stopped
新加坡-02 / 曼谷-01 stop three hours ago. The cutoff slot subtracts 30 seconds
before rounding up so that two runs never differ by a row when `last_seen_secs`
sits exactly on a 300-second boundary. The insight contract passes
`servers.status` through, so 新加坡-02 still shows as `online` in the detail
while its samples are cut off. At the template level `港日双路` / `港日新四跳` /
`五跳全展开` / `三跳大扇出` are `degraded` (null cause: offline candidates
remain but every group still has an online candidate), `港新单跳` /
`港新入口分叉` / `四跳混合` are `ok`, and `美西备用线` is `blocked/disabled`;
at the chain level `港日多路径` is `degraded/node_offline` (东京-02 is offline
but 东京-01 still carries the hop), `nora · 五跳备线` and `nora · 三跳空闲` are
`blocked/node_offline` (the former has all four entry members offline, the latter
ends on the offline single-member 香港-03), `nora · 四跳空闲` is
`degraded/no_samples`, and the
chains through 新加坡-02 (`港新直达链`, `mei · 港日新四跳`, `nora · 港日双路 C`,
`demo · 港新入口 C`) remain `degraded/no_samples` because the Xray-stopped
member has no current samples (its `servers.status` is untouched).

## 5. 测试 / Tests

- 领域层（`crates/domain/src/chain_template_insight.rs`）：列表链数 / 用户
  去重 / 管理员链不计 users / 状态 disabled / degraded / 无成员 / 服务器已删除、
  **组内部分成员离线 → `degraded`、整组候选全离线 → `blocked/member_offline`
  （入口组同规则）**；排序 `chains` 降序 → 名称升序；详情节点跟随真实链
  （模板 2 跳→1 跳后仍是 2 组、计数不归零；模板 1 跳→2 跳不会凭空多节点）、
  `stale` / `stale_reason`（跳数 / 候选成员变化）、`unused_candidates`、
  目标节点、同目标 / 不同目标、边合并、边 p50 与丢包、管理员链不产生用户、
  `series` 按现有链回填（删链后历史一起回退）、最后一个点是当前未完成桶
  （now 不对齐 900）、168h 长度、IPv6 目标；
- 路由层（`crates/master/src/routes/chain_template_insight.rs`）：列表 /
  详情真实 JSON、模板无链、单链、多链多用户、多模板共享服务器不串、
  停用模板、**组内部分离线 → `degraded`、整组离线 → `blocked/member_offline`**、
  **模板编辑后详情仍画真实链 + `stale` + `unused_candidates` +
  `series_basis` + 最后桶 `ts`**、目标相同 / 不同 / 无目标、404 / 400 /
  403 / 401、缓存 `hit/miss` 与 hours 隔离；
- 缓存层（`crates/master/src/state.rs`）：`(id, hours)` key 隔离、TTL、
  禁用；
- 查询计划（`crates/domain/tests/query_plan.rs`）：模板列表必须走
  `idx_chain_templates_created`，用户名字必须走 `users` 主键。

English: domain tests cover counts/status (a group with all candidates offline →
`blocked/member_offline`; a group with some offline candidates but an online one
left → `degraded`, including the entry group), edges/series/formatting, nodes
following the real chain after template edits (`stale` / `stale_reason` /
`unused_candidates`, counts never collapsing), `series` backfilled from the
existing chains (deleting one rewinds history) and the current unfinished
bucket; route tests cover the real JSON contract and every requested boundary
(no chain, single chain, multi-user, shared server across templates, disabled,
partially / fully offline groups, template edited after the chain was created,
same/different/no targets,
404/400/403, cache hit/miss); state tests cover key isolation and TTL; the
query-plan test locks the template index and the users primary key.

## 6. 未做 / Not in this iteration

- 不新增表 / 列：只追加一个模板排序索引（迁移 0068）；
- `series` 按**当前存在的链**回填：删除链会让它从所有历史桶一起消失（没有删除
  时间可保留删除前历史），响应用 `series_basis = "existing_chains"` 显式声明；
- 边级 `p50_ms` / `loss_pct` 固定最近 2h，不随 `hours` 放大到 24h / 168h
  （`hours` 只影响 `series`）；这是为了与 chain-health 的段值同口径，避免
  长窗口把最近的事故稀释掉；
- 多成员下一跳的探测无法拆到具体目标，同一源成员的出边共享 attempts /
  failures；
- 不改 `crates/proto`、`crates/agent`、`web/`：接口只读现有表与链拓扑。
