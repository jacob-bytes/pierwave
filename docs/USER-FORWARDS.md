# 用户自助转发（第一期）/ User self-service port forwarding (phase 1)

> 本期不含流量计量：`forwards.count_traffic` 只保留列与默认值，不参与任何判断。
> This phase does not meter traffic: `forwards.count_traffic` exists with its default
> value only and is never read by business logic.

## 规则 / Rules

- 条数 = 生效中套餐的 `forward_limit` **最大值**（多套餐不累加；无套餐 / 全部为 0 = 0）。
- 目标服务器必须出现在「生效中且 `forward_limit > 0`」的套餐
  `package_forward_servers` 并集里，否则 403 `me.forward_server_not_allowed`。
- 监听端口由服务器端口策略自动分配（区间 ∪ 额外端口；未限制时用 20000-29999 池）；
  请求里的 `listen_port` 会被忽略，用户不能指定端口。
- 协议缺省 `tcp`，允许 `tcp` / `both`；`udp` 仍要求目标服务器 Agent 协议版本 ≥ 16。
- 用户只能看 / 停用 / 删除自己的转发；管理员用原有
  `/api/v1/servers/{id}/forwards` 接口管理全部规则。
- 越权访问别人的规则返回 404 `me.forward_not_found`（不返回 403，避免枚举 id）。

- The quota is the **maximum** `forward_limit` among active packages (no stacking;
  no package = 0). The target server must be in the union of `package_forward_servers`
  of active packages with `forward_limit > 0`; otherwise 403.
- Listen ports are allocated by the server port policy (allowed range ∪ extra ports;
  the legacy 20000-29999 pool when unrestricted). Any client-supplied `listen_port`
  is ignored.
- `protocol` defaults to `tcp`; `tcp` / `both` are allowed, `udp` still requires the
  server agent to speak wire protocol ≥ 16.
- Users can only list / toggle / delete their own rules. Administrators keep using
  `/api/v1/servers/{id}/forwards` for every rule.
- Touching someone else's rule returns 404 `me.forward_not_found` (not 403, to avoid
  id enumeration).

## 服务器下拉 / Server picker

`GET /api/v1/me/summary` 顶层返回 `forward_servers`，与创建接口使用同一份额度快照：
多套餐白名单并集、去重、按名称排序；配额为 0 时是空数组。

`GET /api/v1/me/summary` exposes `forward_servers` computed from the same allowance
snapshot as creation: union of active package whitelists, de-duplicated, sorted by
name; an empty array when the quota is 0.

```json
{
  "forward_servers": [
    { "id": "srv-b", "name": "香港-01" },
    { "id": "srv-a", "name": "日本-02" }
  ]
}
```

## 接口 / Endpoints

### 列表 / List

`GET /api/v1/me/forwards`

```json
{
  "items": [
    {
      "id": "fwd-uuid",
      "server_id": "srv-b",
      "server_name": "香港-01",
      "server_address": "203.0.113.7",
      "entry_address": "203.0.113.7:20000",
      "name": "10.0.0.8:443",
      "listen_port": 20000,
      "target_host": "10.0.0.8",
      "target_port": 443,
      "enabled": true,
      "engine": "native",
      "protocol": "tcp",
      "udp": false,
      "owner_user_id": "user-uuid",
      "created_at": 1730000000,
      "updated_at": 1730000000
    }
  ],
  "quota": { "limit": 2, "used": 1 }
}
```

`entry_address` 已经拼好「服务器地址 + 分配端口」，前端直接展示即可。
`entry_address` is already `server address + allocated port`; render it as-is.

### 创建 / Create

`POST /api/v1/me/forwards`

```json
{ "server_id": "srv-b", "target_host": "10.0.0.8", "target_port": 443, "protocol": "tcp" }
```

成功返回 `{ "forward": { ...同上... }, "quota": { "limit": 2, "used": 2 } }`。
`protocol` 可省略（= `tcp`）；`listen_port` / `name` / `engine` 不接受。

Returns the same `forward` shape plus `quota`. `protocol` is optional (default `tcp`);
`listen_port` / `name` / `engine` are not accepted.

### 停用 / 启用 / Toggle

`PATCH /api/v1/me/forwards/{id}`

```json
{ "enabled": false }
```

### 删除 / Delete

`DELETE /api/v1/me/forwards/{id}` → `{ "ok": true }`

## 审计 / Audit

- `user_forward.create` / `user_forward.delete`
- `target` = 转发 id；detail 只含 `forward_id`、`server_id`、`server_name`、
  `listen_port`、`target_host`、`target_port`、`protocol`，不含用户名或邮箱。
- `target` = forward id; the detail only carries rule facts (no username or email).

## 错误码 / Error codes

见 `docs/ERRORS.md` 的「用户自助转发 / User self-service forwarding」一节：
`me.forward_quota_exceeded`、`me.forward_server_not_allowed`、`me.forward_not_found`，
以及套餐侧的 `package.forward_limit_invalid` / `package.forward_server_*`。
端口池耗尽复用 `chain.port_pool_exhausted` / `chain.port_allowed_exhausted`。

See the “User self-service forwarding” section in `docs/ERRORS.md`.
