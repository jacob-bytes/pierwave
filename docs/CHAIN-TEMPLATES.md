# 链模板与用户自助建链 / Chain templates and user self-service chains

> 迁移 0046。管理员定义链的形态，用户只选模板 + 填目标；入口端口默认由后端
> 自动分配，也可以在创建时显式指定（只覆盖第一跳的对外监听端口）。
> Migration 0046. Administrators define the shape of a chain; users only pick a
> template and enter a target. The entry port is allocated by the backend by
> default and may also be given explicitly at creation time (it only overrides
> the first hop's public listen port).

> 模板使用情况（多少链 / 用户、候选成员、真实路径边）见
> [`docs/CHAIN-TEMPLATE-INSIGHT.md`](CHAIN-TEMPLATE-INSIGHT.md)。
> Template usage insight (chain/user counts, candidates, real path edges) lives
> in [`docs/CHAIN-TEMPLATE-INSIGHT.md`](CHAIN-TEMPLATE-INSIGHT.md).

## 规则 / Rules

- 用户可建链数 = **生效中**套餐 `chain_limit` 的最大值（多套餐不累加；无套餐 = 0）。
- 模板必须出现在「生效中且 `chain_limit > 0`」的套餐 `package_chain_templates`
  并集里，且模板本身 `enabled = 1`；否则 403 `me.chain_template_not_allowed`。
- 用户只提供 `target_host` + `target_port`（可选 `entry_port`）。链的 groups
  由模板展开；入口组（第 1 组）每个成员从所在服务器的端口策略自动分配端口，
  中间组沿用链既有的自动分配（同样受端口策略约束）。给了 `entry_port` 时，
  **只有被选中的入口成员**（priority 最小、也就是 `entry_address` 展示的那台）
  用它，其它入口成员与所有中间跳仍自动分配。
- 模板不携带证书：`transport` 只允许 `none`；`transport = tls` 在模板 CRUD 时
  直接拒绝（`chain_template.transport_unsupported`）。
- 引擎 / 安全模式 / 协议组合复用链的既有校验函数与错误码：
  `engine` ∈ `native | realm | nftables | tunnel`，`security` ∈ `tls | noise`
  （`noise` 只允许 tunnel），`protocol` ∈ `tcp | udp | both`。
  隧道 2–6 跳且每组 1 台；nftables 多成员组只允许轮询 / 加权 / IP 哈希；realm 不接受仅 UDP。
- 模板组里引用的服务器必须真实存在（`chain_template.server_not_found`）。
- 归属：`chains.owner_user_id` 过滤用户列表；别人的链返回 404
  `me.chain_not_found`（不返回 403，避免枚举 id）。
- 管理员 `GET /api/v1/chains` 仍返回全部链，但新增 `source = "admin" | "user"`、
  `owner_user_id`、`template_id` 字段，用户链不会被误认为手建链。

- The quota is the **maximum** `chain_limit` among active packages (no stacking;
  no package = 0). The template must be in the union of `package_chain_templates`
  of active packages with `chain_limit > 0` **and** be enabled; otherwise 403.
- Users supply `target_host` + `target_port` (optionally `entry_port`). Groups
  are expanded from the template; every member of the entry group (group 1) gets
  a port allocated by its server's port policy, and middle groups reuse the
  existing automatic chain allocation (also bounded by the same policy). When
  `entry_port` is present it applies to the **selected entry member only** (the
  lowest priority one, i.e. the address shown in `entry_address`); the other
  entry members and every middle hop are still allocated automatically.
- Templates carry no certificates: `transport` must be `none`; `transport = tls`
  is rejected during template CRUD.
- Engine / security / protocol combinations reuse the chain validators and error
  codes. Tunnel: 2–6 hops, exactly one member per group. nftables: multi-member
  middle groups must use round robin, weighted or IP hashing. realm does not accept UDP-only.
- Every server referenced by a template must exist.
- Ownership: user lists are filtered by `chains.owner_user_id`; touching someone
  else's chain returns 404 `me.chain_not_found` (never 403, to avoid id enumeration).
- The admin chain list keeps returning every chain, now annotated with
  `source` (`admin` / `user`), `owner_user_id` and `template_id`.

## 数据模型 / Data model

```sql
CREATE TABLE chain_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  engine TEXT NOT NULL,               -- native / realm / nftables / tunnel
  security TEXT NOT NULL DEFAULT 'tls',
  transport TEXT NOT NULL DEFAULT 'none',
  protocol TEXT NOT NULL DEFAULT 'tcp',
  groups_json TEXT NOT NULL,          -- [{ seq, strategy, server_ids: [...] }]
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
ALTER TABLE packages ADD COLUMN chain_limit INTEGER NOT NULL DEFAULT 0;
CREATE TABLE package_chain_templates (
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES chain_templates(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, template_id)
);
ALTER TABLE chains ADD COLUMN template_id TEXT;
ALTER TABLE chains ADD COLUMN owner_user_id TEXT;
-- 迁移 0055：用户停用链时保存的组形态快照（不含端口）；管理员停用的链不写。
ALTER TABLE chains ADD COLUMN disabled_groups_json TEXT;
```

`security` 对应链的 `tunnel_security`（`tls` / `noise`），`transport` 对应
realm 的跳间加密（`none` / `tls`）；两个维度不要混用。`groups_json` 落库前会
排序并重新编号为 `0..n-1`。`disabled_groups_json` 只在用户停用链时写入：
`{ groups: [{ name, strategy, cert_id, public_port, use_internal_address,
members: [{ server_id, priority, weight }] }] }`，**不含端口**，启用时重新分配。
`security` maps to the chain's `tunnel_security`; `transport` maps to realm hop
TLS. `groups_json` is sorted and renumbered to `0..n-1` before it is stored.
`disabled_groups_json` is written only when a user disables a chain; it holds the
topology without ports, so enabling can allocate fresh ones.

## 一条用户链的创建流程 / Creation flow

1. **额度快照**：`chain_allowance` 读生效中套餐 → `{ limit, template_ids }`。
2. **模板校验**：模板必须在白名单里且启用，否则 403。
3. **展开 groups**：模板的每一组 → 链的一组；
   - 入口组第一台成员：显式 `entry_port` 优先；缺省时 `PortPolicy::allocate`
     从服务器允许集合里挑最小空闲端口（保留端口、回环目标端口会先并入占用集合）；
   - 入口组其余成员：同样自动分配（多成员入口是候选池，不能共用一个端口）；
   - 中间组：`listen_port` 留空，由 `resolve_groups` 走链既有自动分配。
4. **同一套链校验**：自连回环、nftables / tunnel 能力、realm 协议、
   UDP Agent 版本门禁。
5. **落库**：`create_owned` 在同一个事务里再次检查配额并写入
   `chains` + `chain_groups` + `chain_group_members`，`owner_user_id` /
   `template_id` 同时写入。
6. **下发**：标脏所有涉及服务器并立即推期望态；链的 `DesiredForward` 格式不变。
7. **审计**：`user_chain.create`（只含链路事实）。

English: snapshot the allowance → verify the template → expand groups and allocate
entry ports via `PortPolicy::allocate` (the selected entry member may use an
explicit `entry_port`; middle hops use the existing chain auto-allocation) → run
the same chain validators → insert quota-checked chain in a single transaction →
mark servers dirty and push desired state → audit. The wire format of
`DesiredForward` is unchanged.

## 接口 / Endpoints

### 管理员模板 / Admin templates

```
GET    /api/v1/chain-templates
POST   /api/v1/chain-templates
PATCH  /api/v1/chain-templates/{id}
DELETE /api/v1/chain-templates/{id}
```

`POST` body：

```json
{
  "name": "香港 → 日本",
  "engine": "realm",
  "security": "tls",
  "transport": "none",
  "protocol": "tcp",
  "enabled": true,
  "groups": [
    { "seq": 0, "strategy": "round_robin", "server_ids": ["srv-hk"] },
    { "seq": 1, "strategy": "failover", "server_ids": ["srv-jp"] }
  ]
}
```

响应 `{ "template": { ...同上, "servers": [{ "id", "name" }] } }`；
`groups[].servers` 由后端带出服务器名，前端不必再查一遍。
Response includes `groups[].servers` with names so the UI needn't re-query.

### 用户可见模板 / Templates visible to the user

`GET /api/v1/me/chain-templates` → `{ items: [...], quota: { limit, used } }`

```json
{
  "items": [
    {
      "id": "tpl-1",
      "name": "香港 → 日本",
      "engine": "realm",
      "security": "tls",
      "transport": "none",
      "protocol": "tcp",
      "enabled": true,
      "groups": [
        { "seq": 0, "strategy": "round_robin",
          "server_ids": ["srv-hk"],
          "servers": [{ "id": "srv-hk", "name": "香港-01" }] },
        { "seq": 1, "strategy": "failover",
          "server_ids": ["srv-jp"],
          "servers": [{ "id": "srv-jp", "name": "日本-02" }] }
      ]
    }
  ],
  "quota": { "limit": 2, "used": 0 }
}
```

### 用户链 / User chains

`GET /api/v1/me/chains`

```json
{
  "items": [
    {
      "id": "chain-uuid",
      "name": "香港 → 日本 · 10.0.0.8:443",
      "template_id": "tpl-1",
      "template_name": "香港 → 日本",
      "target_host": "10.0.0.8",
      "target_port": 443,
      "engine": "realm",
      "security": "tls",
      "transport": "none",
      "protocol": "tcp",
      "enabled": true,
      "entry_address": "203.0.113.7:20000",
      "entry_server_id": "srv-hk",
      "entry_server_name": "香港-01",
      "groups": [
        { "seq": 0, "strategy": "round_robin",
          "servers": [{ "server_id": "srv-hk", "server_name": "香港-01", "listen_port": 20000 }] },
        { "seq": 1, "strategy": "failover",
          "servers": [{ "server_id": "srv-jp", "server_name": "日本-02", "listen_port": 20000 }] }
      ],
      "blocked_code": null,
      "blocked_reason": null,
      "created_at": 1730000000,
      "updated_at": 1730000000
    }
  ],
  "quota": { "limit": 2, "used": 1 }
}
```

`POST /api/v1/me/chains`

```json
{ "template_id": "tpl-1", "entry_port": 24321, "target_host": "10.0.0.8", "target_port": 443 }
```

`entry_port` 可省略（或传 `null`）= 全部自动分配（旧行为）；传入则必须是
1–65535 且在该服务器的允许端口范围内，冲突 / 越界见
[`docs/ERRORS.md`](ERRORS.md) 的 `chain.entry_port_*`。
`listen_port` / `engine` / `security` 仍一律不接受，形态由后端决定。
成功返回 `{ "chain": {...同上...}, "quota": { "limit": 2, "used": 1 } }`。

English: `POST /api/v1/me/chains` accepts an optional `entry_port`. Omitted or
`null` keeps the previous fully automatic allocation; when present it must be
`1..=65535` and inside the entry server's allowed port policy. Conflicts and
out-of-range values use the `chain.entry_port_*` codes in `docs/ERRORS.md`.
`listen_port` / `engine` / `security` are still rejected — the shape comes from
the template.

`PATCH /api/v1/me/chains/{id}`（迁移 0055）→ `{ "chain": {...}, "quota": {...} }`

```json
{ "name": "香港出口", "target_host": "10.0.0.9", "target_port": 8443, "enabled": true }
```

可编辑字段只有 `name` / `target_host` / `target_port` / `enabled`；模板、groups、
成员与入口端口**不接受**修改（换模板 = 换整条链，入口端口变化会让现有客户端失联，
请删除后重建）。

- **改目标**：组与入口端口原样保留，只改出口；保存后立即重建期望态并下发。
- **停用**：把组形态快照到 `chains.disabled_groups_json`，删掉 `chain_groups` /
  `chain_group_members`（`(server_id, listen_port)` 唯一索引随之释放端口），
  链记录与配额计数保留；生效中的链停用需要前端二次确认。
- **启用**：按快照（用户停用）或现有组（管理员停用）重建拓扑，入口组按服务器
  端口策略**重新分配**端口，可能拿到不同端口；中间组同样重新分配。
- **配额**：编辑不计入配额，只有删除才释放配额（与现状一致）。
- **校验**：目标地址/端口范围沿用自助转发（`forward.target_host_required` /
  `forward.target_port_invalid`）；启用的链目标不可为空；停用的链端口冲突检查
  直接跳过（它此时不占端口）；别人的链仍返回 404 `me.chain_not_found`。
- **回滚**：快照、删组、端口重分配、字段更新都在同一个 `BEGIN IMMEDIATE`
  事务里；任何一步失败都不 COMMIT，旧配置原样可用。

`DELETE /api/v1/me/chains/{id}` → `{ "ok": true }`

English: `PATCH /api/v1/me/chains/{id}` edits only `name` / `target_host` /
`target_port` / `enabled`. Template, groups, members and the entry port are
rejected — switching templates means deleting and recreating. A target change
keeps every entry port and re-renders the desired state immediately. Disabling
snapshots the topology into `chains.disabled_groups_json` and deletes the groups
and members, so the unique `(server_id, listen_port)` index really frees the
ports while the record and quota count stay. Enabling rebuilds the topology from
the snapshot (or from existing groups for admin-disabled chains) and allocates
fresh ports, which may differ. Edits never consume quota. Validation reuses the
self-service forward rules, an enabled chain may not have an empty target, port
conflict checks are skipped while disabled, and other users' chains are 404.
All writes share one transaction, so a failure rolls back to the old config.

### 入口端口语义 / Entry port semantics

- **默认自动分配**：不传 `entry_port` 时，入口组每个成员各自按所在服务器的
  端口策略挑最小空闲端口（固定池 `20000..=29999`，或策略允许集合）。
- **只覆盖第一跳**：`entry_port` 改的是入口成员自己的对外监听端口；中间跳与
  出口跳仍自动分配。链的每一跳都需要独立监听，不能把同一个端口串成一条链。
- **多成员入口组**：`entry_port` 只落到被选中的入口成员（priority 最小、也就是
  `entry_address` 展示的那台），其它候选成员仍各自分配。
- **校验顺序**：范围（`chain.entry_port_out_of_range`）→ 保留端口
  （`forward.port_reserved`，22 / 10085）→ 服务器允许集合
  （`chain.port_not_allowed`；策略为空 = 不限制）→ 同服务器上的链 / 节点 /
  转发占用（409 `chain.entry_port_taken`）。
- **冲突不改端口**：409 时链**不会创建**，不做「悄悄换一个端口」的降级；
  入口端口是用户实际连接的地址，静默改写会造成失联。
- **不可后改**：`entry_port` 只在创建时生效；`PATCH /api/v1/me/chains/{id}`
  仍不接受入口端口（换端口 = 换整条链，请删除后重建）。

English: by default every entry member gets its own port from its server's policy.
`entry_port` overrides **the first hop only**; middle and exit hops are still
allocated automatically, because every hop needs its own listener. In a
multi-member entry group the explicit port applies to the selected member (lowest
priority, the one shown in `entry_address`) only. Validation order: range →
reserved ports (22 / 10085) → server port policy (empty policy = unrestricted) →
conflict with existing chains / nodes / forwards on the same server (409
`chain.entry_port_taken`). A conflict does **not** silently pick another port and
the chain is not created (the write transaction rolls back); silently rewriting an
entry address would disconnect live clients. `entry_port` is creation-only —
`PATCH /api/v1/me/chains/{id}` still rejects it; change the port by deleting and
recreating the chain.

### 管理员从模板创建 / Admin creates from a template

`POST /api/v1/chains` 接受两种**互斥**入参：

```jsonc
// A. 手建（原有）：自己给 groups
{ "name": "港日", "target_host": "1.1.1.1", "target_port": 443,
  "groups": [ { "members": [{ "server_id": "srv-hk", "listen_port": 20000 }] },
              { "members": [{ "server_id": "srv-jp" }] } ] }

// B. 从模板（新增）：模板展开 groups，引擎 / 协议 / 安全模式直接沿用模板
{ "name": "港日专线", "template_id": "tpl-1", "entry_port": 24321,
  "target_host": "1.1.1.1", "target_port": 443 }
```

- `name` 可省略：缺省用「模板名 · target_host:target_port」（超过 64 字符时截断）。
- `entry_port` 可选，语义与用户自助建链完全一致（只覆盖第一跳、冲突 409）。
- `template_id` 与 `groups` / `hops` / `engine` / `protocol` / `transport` /
  `tunnel_security` 同时出现 → 400 `chain.template_conflict`（不静默取其一）。
- 模板不存在 → 404 `chain_template.not_found`；已停用 → 400
  `chain_template.disabled`。
- 建出来的链 `owner_user_id = null`（管理员链），`template_id` 记下来源；
  `GET /api/v1/chains` 的 `source` 仍是 `admin`。
- 与手建等价：组序号 / 策略 / 服务器来自模板，写入的是同一种
  `chain_groups + chain_group_members`，下发也是同一份 `DesiredForward`。

English: `POST /api/v1/chains` now accepts two mutually exclusive payloads — the
existing manual `groups` (or legacy `hops`) and the new `template_id` +
optional `entry_port` + `target_host` + `target_port`. `name` is optional and
defaults to `template name · host:port`. Engine / protocol / security come from
the template; sending `groups`/`hops`/`engine`/`protocol`/`transport`/
`tunnel_security` together with `template_id` is a 400 `chain.template_conflict`.
A missing template is 404 `chain_template.not_found`; a disabled one is 400
`chain_template.disabled`. The created chain keeps `owner_user_id = null` and
records `template_id`; the expansion is equivalent to a manual chain with the
same groups (same tables, same `DesiredForward` wire format).

### 套餐 / Packages

创建/更新接受：

```json
{ "chain_limit": 2, "chain_template_ids": ["tpl-1"] }
```

- `chain_limit` 0 = 不允许，负数 400 `package.chain_limit_invalid`；
- `chain_template_ids` 是**全量替换**，`[]` = 一个模板都不允许；
- 不存在/空 id 分别 400 `package.chain_template_not_found` /
  `package.chain_template_invalid`；
- 响应里的 `Package` 带 `chain_limit` 与 `chain_template_ids`。

## 审计 / Audit

- `chain_template.create` / `chain_template.update` / `chain_template.delete`：
  `target` = 模板 id，detail 含名称、引擎/协议/安全模式与组（server_ids）。
- `user_chain.create` / `user_chain.delete`：`target` = 链 id，detail 只含
  `chain_id`、`template_id`、`target_host/port`、`engine`、`protocol`、逐组成员
  与端口，**不含用户名/邮箱**。
- `user_chain.update`：`target` = 链 id，detail 只含 `chain_id`、变化字段名数组
  （`name` / `target_host` / `target_port` / `enabled`）与 `enabled` 终值，
  **不记录目标明文**。

## 前端 / Frontend

- 管理员侧栏新增「链模板」页：列表（四态）+ 新建/编辑对话框（引擎、协议、
  隧道加密、启用、按跳选服务器与策略）+ 删除确认 + 行内启停。
- 套餐表单新增「自助建链条数」与「允许的链模板」多选（只列出模板名与路径）。
- 用户端「我的转发」页追加「我的链路」区块：列表（四态）+ 配额 +
  「选模板 + 填目标」新建 + 删除；入口地址可一键复制。
- 每行新增「编辑」：对话框只含名称、目标与启用开关；停用要二次确认并说明
  「会从服务器移除、重新启用时入口端口可能变化」；启用成功提示带新入口地址，
  改目标成功提示带新目标（入口端口不变，因此不显示）。
- 管理员链列表对用户链标注 `source = user`（UI 可据 `source` 显示来源）。

## 未做 / Not in this iteration

- 模板不携带证书，因此不支持跳间 TLS 模板；需要 TLS 的链仍由管理员手建。
- 用户仍不能修改模板 / groups / 成员 / 入口端口（只能删除后重建）；创建时可以
  指定入口端口，`PATCH` 不能改。停用中的链在列表里不展示原端口（组已释放），
  但仍保留记录与配额计数。
- 没有新增 `chain.template_unsupported`：`template_id` 本身是**新字段**，旧客户端
  根本不会发它；旧主控忽略该字段后仍按空 `groups` 返回既有的
  `chain.hop_count_invalid`，前端已经用这个信号做降级（见
  `web/src/lib/chainTemplateCreate.ts`）。再加一个「仅旧客户端」的错误码不会
  增加可区分的信息，反而多一条需要长期兼容的约定。
- 模板不绑定单台服务器能力快照：每次建链现查端口策略与 Agent 能力。
- 套餐删除仍受既有「有用户在用」保护；删除模板会级联清掉套餐授权，
  但不会删除已创建的链。

English: templates cannot carry certificates (no hop TLS templates); the entry
port may be chosen at creation but is still immutable afterwards, so changing it
means delete and recreate. A disabled chain no longer shows its old entry port
(its groups are released) while its record and quota count stay; server
capabilities and port policies are re-checked at creation time and again when
re-enabling; deleting a template cascades to package grants but never deletes
existing chains. No `chain.template_unsupported` code was added: `template_id` is
a brand-new field that old clients never send, and an old master that ignores it
already fails with the existing `chain.hop_count_invalid`, which the UI uses as
its fallback signal. Adding a dedicated "old client" code would not add any
distinguishable information.
