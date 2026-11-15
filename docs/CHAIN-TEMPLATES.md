# 链模板与用户自助建链 / Chain templates and user self-service chains

> 迁移 0046。管理员定义链的形态，用户只选模板 + 填目标；入口端口由后端自动分配。
> Migration 0046. Administrators define the shape of a chain; users only pick a
> template and enter a target. Entry ports are allocated by the backend.

## 规则 / Rules

- 用户可建链数 = **生效中**套餐 `chain_limit` 的最大值（多套餐不累加；无套餐 = 0）。
- 模板必须出现在「生效中且 `chain_limit > 0`」的套餐 `package_chain_templates`
  并集里，且模板本身 `enabled = 1`；否则 403 `me.chain_template_not_allowed`。
- 用户只提供 `target_host` + `target_port`。链的 groups 由模板展开；
  入口组（第 1 组）每个成员从所在服务器的端口策略自动分配端口，
  中间组沿用链既有的自动分配（同样受端口策略约束）。
- 模板不携带证书：`transport` 只允许 `none`；`transport = tls` 在模板 CRUD 时
  直接拒绝（`chain_template.transport_unsupported`）。
- 引擎 / 安全模式 / 协议组合复用链的既有校验函数与错误码：
  `engine` ∈ `native | realm | nftables | tunnel`，`security` ∈ `tls | noise`
  （`noise` 只允许 tunnel），`protocol` ∈ `tcp | udp | both`。
  隧道 2–6 跳且每组 1 台；nftables 中间组不能多成员；realm 不接受仅 UDP。
- 模板组里引用的服务器必须真实存在（`chain_template.server_not_found`）。
- 归属：`chains.owner_user_id` 过滤用户列表；别人的链返回 404
  `me.chain_not_found`（不返回 403，避免枚举 id）。
- 管理员 `GET /api/v1/chains` 仍返回全部链，但新增 `source = "admin" | "user"`、
  `owner_user_id`、`template_id` 字段，用户链不会被误认为手建链。

- The quota is the **maximum** `chain_limit` among active packages (no stacking;
  no package = 0). The template must be in the union of `package_chain_templates`
  of active packages with `chain_limit > 0` **and** be enabled; otherwise 403.
- Users only supply `target_host` + `target_port`. Groups are expanded from the
  template; every member of the entry group (group 1) gets a port allocated by
  its server's port policy, and middle groups reuse the existing automatic chain
  allocation (also bounded by the same policy).
- Templates carry no certificates: `transport` must be `none`; `transport = tls`
  is rejected during template CRUD.
- Engine / security / protocol combinations reuse the chain validators and error
  codes. Tunnel: 2–6 hops, exactly one member per group. nftables: no multi-member
  middle groups. realm does not accept UDP-only.
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
   - 入口组每个成员：`PortPolicy::allocate` 从服务器允许集合里挑最小空闲端口
     （保留端口、回环目标端口会先并入占用集合）；
   - 中间组：`listen_port` 留空，由 `resolve_groups` 走链既有自动分配。
4. **同一套链校验**：自连回环、nftables / tunnel 能力、realm 协议、
   UDP Agent 版本门禁。
5. **落库**：`create_owned` 在同一个事务里再次检查配额并写入
   `chains` + `chain_groups` + `chain_group_members`，`owner_user_id` /
   `template_id` 同时写入。
6. **下发**：标脏所有涉及服务器并立即推期望态；链的 `DesiredForward` 格式不变。
7. **审计**：`user_chain.create`（只含链路事实）。

English: snapshot the allowance → verify the template → expand groups and allocate
entry ports via `PortPolicy::allocate` (middle hops use the existing chain
auto-allocation) → run the same chain validators → insert quota-checked chain in a
single transaction → mark servers dirty and push desired state → audit. The wire
format of `DesiredForward` is unchanged.

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
{ "template_id": "tpl-1", "target_host": "10.0.0.8", "target_port": 443 }
```

成功返回 `{ "chain": {...同上...}, "quota": { "limit": 2, "used": 1 } }`。
`listen_port` / `engine` / `security` 一律不接受，端口与形态都由后端决定。

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
- 用户仍不能修改模板 / groups / 成员 / 入口端口（只能删除后重建）；停用中的链
  在列表里不展示原端口（组已释放），但仍保留记录与配额计数。
- 模板不绑定单台服务器能力快照：每次建链现查端口策略与 Agent 能力。
- 套餐删除仍受既有「有用户在用」保护；删除模板会级联清掉套餐授权，
  但不会删除已创建的链。

English: templates cannot carry certificates (no hop TLS templates); users still
cannot edit the template, groups, members or the entry port (delete and recreate
instead), and a disabled chain no longer shows its old entry port (its groups are
released) while its record and quota count stay; server capabilities and port
policies are re-checked at creation time and again when re-enabling; deleting a
template cascades to package grants but never deletes existing chains.
