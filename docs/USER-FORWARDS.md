# 用户自助转发 / User self-service port forwarding

> 第一期（0044）只做配额与白名单；第二期（0045）把 `count_traffic` 接上：
> 开启计费的转发，其流量会从 Agent 心跳采样后计入创建者的套餐用量。
> Phase 1 (0044) added quotas and the server whitelist; phase 2 (0045) wires up
> `count_traffic`: traffic on billing-enabled rules is sampled from Agent
> heartbeats and added to the owner's package usage.

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
      "count_traffic": true,
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
{ "enabled": false, "count_traffic": true }
```

两个字段都可单独提交；不传 = 不改。`count_traffic` 只能改自己的规则，
越权仍是 404 `me.forward_not_found`。用户新建的转发默认 `count_traffic = true`
（之后可以关掉）。管理员创建的规则没有 `owner_user_id`，即使置 1 也不计费。

Both fields can be patched independently; omitted = unchanged. `count_traffic`
can only be changed on your own rules (404 otherwise). User-created forwards
default to `count_traffic = true`; administrator-created rules have no owner and
never bill even when set to 1.

### 删除 / Delete

`DELETE /api/v1/me/forwards/{id}` → `{ "ok": true }`

## 流量计量（第二期）/ Traffic metering (phase 2)

主控后台每 **60 秒**跑一轮采样（`scheduler::spawn_forward_traffic_sampler`），
只处理满足以下全部条件的规则：

`owner_user_id IS NOT NULL AND count_traffic = 1 AND enabled = 1`。

- 数据源是心跳缓存的 `forward_status.traffic_in/out`（Agent 侧的**累计字节**）。
- `delta = current - last`；`current < last` 视为 Agent 重启 / 规则重建后的
  计数器归零，本轮 `delta = current`，不回退、不记负数，并更新基线。
- `delta` 累加到当天（UTC+8）的 `forward_traffic_daily(day, forward_id, user_id, bytes)`，
  同时累加到创建者的 `users.used_bytes` 与当前生效套餐的
  `user_packages.used_bytes`（按 `created_at` 瀑布分配，与 Xray 流量一致）。
- 没有生效套餐时只记日表，不累计到用户/套餐（没有可归属的额度）。
- 差值认领、日表 upsert、套餐累加在**同一个 `BEGIN IMMEDIATE` 事务**里完成；
  `UPDATE ... WHERE last_traffic_in = ? AND last_traffic_out = ?` 做条件更新，
  两轮采样并发也不会把同一份增量计两次。
- 单条规则采样失败只记 warn 并跳过，不影响其它规则、心跳、断流或每日重置。

`forward_traffic_daily` 与 `traffic_daily` **分账存储**：Xray 流量的既有口径
一行都不改；两张日表最终都汇总到 `user_packages.used_bytes`，因此配额判定
（`user_packages.used_bytes >= quota`）不需要改。

Every **60 seconds** the master samples rules that satisfy all of:
`owner_user_id IS NOT NULL AND count_traffic = 1 AND enabled = 1`.

- Source: `forward_status.traffic_in/out` from Agent heartbeats (**cumulative bytes**).
- `delta = current - last`. `current < last` means the counter reset (Agent
  restart or rule rebuild); the delta becomes `current` (never negative) and the
  baseline is updated.
- The delta is upserted into the current UTC+8 day in
  `forward_traffic_daily(day, forward_id, user_id, bytes)` and added to the
  owner's `users.used_bytes` and active `user_packages.used_bytes` (waterfall by
  `created_at`, same as Xray traffic).
- Without an active package only the daily row is written (nothing to bill).
- Claiming the delta, the daily upsert and the package update share one
  `BEGIN IMMEDIATE` transaction; the conditional
  `UPDATE ... WHERE last_traffic_in = ? AND last_traffic_out = ?` makes concurrent
  sampling rounds safe.
- A failure on one rule is logged and skipped; heartbeats, enforcement and daily
  resets are unaffected.

`forward_traffic_daily` is stored separately from `traffic_daily`: the existing
Xray accounting is untouched, but both feed into `user_packages.used_bytes`, so
quota checks stay unchanged.

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
