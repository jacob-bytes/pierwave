# API Token / API tokens

[简体中文](#简体中文) | [English](#english)

---

## 简体中文

API Token 用于脚本、CI 与 MCP 等非浏览器客户端。它和浏览器 Cookie 会话**并行**：
同一个 `Authorization: Bearer pwt_...` 既能访问 `/api/v1/*`，也能访问 `/mcp`；但
**`/mcp` 只接受 admin scope**，read scope 仅限健康检查与公开状态（见下文）。

### 创建与保管

- 明文格式：`pwt_` + 64 位十六进制（两个 UUIDv4），只在创建响应里出现一次；
- 库里只存 `SHA-256(明文)` 的十六进制，和 Agent token / 会话 token 同一种方式；
- 列表接口不会返回明文或哈希；忘记后只能吊销并重新创建。

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/api-tokens` | 列表（名称、scope、创建/上次使用/过期/吊销时间）；仅管理员 |
| `POST` | `/api/v1/api-tokens` | `{ name, scope, expires_at? }` → `{ token, item }`，`token` 仅此一次；仅管理员 |
| `DELETE` | `/api/v1/api-tokens/{id}` | 吊销（幂等）；仅管理员 |

`scope` 只能是：

| scope | 权限 |
|---|---|
| `read`（默认） | 只能访问 `/api/v1/health` 与 `/api/v1/public/status`；其它 GET 返回 `403 api_token.sensitive_endpoint`，写操作返回 `403 api_token.read_only`，**不能用于 MCP**（`403 api_token.mcp_requires_admin`） |
| `admin` | 等同管理员会话，可读写；MCP 必须使用 admin |

**read token 只能访问健康检查与公开状态，MCP 一律需要 admin。** `/mcp` 的 5 个工具虽然只读，
但返回服务器地址、用户清单与链拓扑，与 REST 敏感 GET 是同一份数据；因此 read scope 调用
`/mcp` 一律返回 JSON-RPC `403`，`error.data.code = "api_token.mcp_requires_admin"`。
把 MCP 当成「只读所以 read 够用」的旧用法会失效，请改用 admin scope 的 token。

「仅管理员」指 Cookie 管理员或 **admin scope** 的 token；read scope 连 token 列表也不能看
（返回 `403 api_token.sensitive_endpoint`）。

### read 只用于健康检查与公开状态

read scope 的定位是**健康检查与监控探针**，不是「能看大部分数据的只读账号」。
它只允许两个精确路径：

| 路径 | 说明 |
|---|---|
| `/api/v1/health` | 面板存活、版本与名称 |
| `/api/v1/public/status` | 公开状态页（本身无需登录） |

除这两个路径外的所有 `/api/v1/*` GET 一律返回 `403 api_token.sensitive_endpoint`，
包括但不限于 overview / stats / enforcement / forward-traffic / servers / nodes /
users / subscriptions / agent-upgrades/batches。要读业务数据请用 admin scope。

匹配是**精确路径**：`/api/v1/health/extra`、`/api/v1/public/status/extra` 都不会
被放行。`SENSITIVE_READ_PREFIXES` / `SENSITIVE_READ_DETAIL_PREFIXES` 仍保留为纵深
防御名单：即使未来某个接口被加进 allowlist，只要它在敏感名单里仍会被拒绝。
allowlist 与敏感名单集中定义在 `crates/master/src/auth.rs`。

### 鉴权与限流

- 请求头：`Authorization: Bearer pwt_...`；
- 无效、已过期、已吊销 → `401 api_token.invalid`；
- 每个 token 每分钟 120 次（普通 API 与 `/mcp` 共用额度），超出 → `429 api_token.rate_limited`
  （带 `Retry-After`）；
- `last_used_at` 在内存里聚合，每 10 秒批量写回一次库，不在每个请求上写 SQLite。

### 审计

`api_token.create` 与 `api_token.revoke` 只记录名称、scope、过期时间与目标 id；
**不记录明文，也不记录哈希**。

### curl 示例

```bash
# 创建（用管理员 Cookie 或 admin scope token）
curl -s -b cookie.txt -X POST http://127.0.0.1:8787/api/v1/api-tokens \
  -H 'Content-Type: application/json' \
  -d '{"name":"CI","scope":"read"}'

# 读：脚本用 Bearer（read token 仅允许健康检查/公开状态）
curl -s -H "Authorization: Bearer pwt_..." http://127.0.0.1:8787/api/v1/health

# 写：read scope 会 403 api_token.read_only
curl -s -X PATCH -H "Authorization: Bearer pwt_..." \
  -H 'Content-Type: application/json' \
  -d '{"panel_name":"x"}' http://127.0.0.1:8787/api/v1/settings
```

### 界面

![Token 列表](images/api-tokens/list-1440-dark.png)

![创建后一次性明文（已脱敏）](images/api-tokens/reveal-once-1440-dark.png)

MCP 的 HTTP 接入见 [MCP.md](./MCP.md#http-接入streamable-http)。

---

## English

API tokens are for scripts, CI and MCP clients. They work **alongside** browser
cookie sessions: the same `Authorization: Bearer pwt_...` header works for both
`/api/v1/*` and `/mcp`, but **`/mcp` only accepts the admin scope** — read scope is
limited to health checks and public status (see below).

### Creation and storage

- Plaintext format: `pwt_` + 64 hex characters (two UUIDv4s), returned once at
  creation only;
- only `SHA-256(plaintext)` in hex is stored — the same approach as agent and
  session tokens;
- list responses never contain the plaintext or the hash. If lost, revoke and
  create a new one.

### Endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/v1/api-tokens` | List (name, scope, created/last used/expires/revoked); administrators only |
| `POST` | `/api/v1/api-tokens` | `{ name, scope, expires_at? }` → `{ token, item }`; `token` is shown once; administrators only |
| `DELETE` | `/api/v1/api-tokens/{id}` | Revoke (idempotent); administrators only |

`scope` is one of:

| scope | Permission |
|---|---|
| `read` (default) | Only `/api/v1/health` and `/api/v1/public/status`; other GETs return `403 api_token.sensitive_endpoint`, writes return `403 api_token.read_only`, and it **cannot be used for MCP** (`403 api_token.mcp_requires_admin`) |
| `admin` | Equivalent to an administrator session; read and write; required for MCP |

**A read token can only access health checks and public status; MCP always requires admin.** The
five `/mcp` tools are read-only, but they return server addresses, the user list and
chain topology — the same data as the sensitive REST GETs. A read-scoped token calling
`/mcp` therefore gets a JSON-RPC `403` with
`error.data.code = "api_token.mcp_requires_admin"`. The old "read is enough because MCP
is read-only" usage no longer works; use an admin-scoped token.

"Administrators only" means an administrator cookie session or an **admin-scoped**
token. A read-scoped token cannot even list tokens
(`403 api_token.sensitive_endpoint`).

### read is only for health checks and public status

The read scope is intended for **health checks and monitoring probes**, not as a
read-mostly account. It allows exactly two paths:

| Path | Purpose |
|---|---|
| `/api/v1/health` | Panel liveness, version and name |
| `/api/v1/public/status` | Public status page (public anyway) |

Every other `/api/v1/*` GET returns `403 api_token.sensitive_endpoint`, including
overview / stats / enforcement / forward-traffic / servers / nodes / users /
subscriptions / agent-upgrades/batches. Use an admin-scoped token to read business
data.

Matching is **exact**: `/api/v1/health/extra` and
`/api/v1/public/status/extra` are not allowed. `SENSITIVE_READ_PREFIXES` /
`SENSITIVE_READ_DETAIL_PREFIXES` remain as defense-in-depth: even if an endpoint is
added to the allowlist later, it is still denied when present in the sensitive lists.
The allowlist and sensitive lists live in `crates/master/src/auth.rs`.

### Auth and rate limiting

- Header: `Authorization: Bearer pwt_...`;
- invalid, expired or revoked → `401 api_token.invalid`;
- 120 requests per minute per token (shared by the regular API and `/mcp`); over
  the limit → `429 api_token.rate_limited` with `Retry-After`;
- `last_used_at` is aggregated in memory and flushed every 10 seconds, so the hot
  path never writes SQLite per request.

### Audit

`api_token.create` and `api_token.revoke` record the name, scope, expiry and
target id only. **Neither the plaintext nor the hash is audited.**

### curl examples

```bash
# Create (administrator cookie or admin-scoped token)
curl -s -b cookie.txt -X POST http://127.0.0.1:8787/api/v1/api-tokens \
  -H 'Content-Type: application/json' \
  -d '{"name":"CI","scope":"read"}'

# Read via Bearer
curl -s -H "Authorization: Bearer pwt_..." http://127.0.0.1:8787/api/v1/settings

# Write with a read-scoped token → 403 api_token.read_only
curl -s -X PATCH -H "Authorization: Bearer pwt_..." \
  -H 'Content-Type: application/json' \
  -d '{"panel_name":"x"}' http://127.0.0.1:8787/api/v1/settings
```

### UI

![Token list](images/api-tokens/list-1440-dark.png)

![One-time plaintext after creation (redacted)](images/api-tokens/reveal-once-1440-dark.png)

For the MCP HTTP transport see [MCP.md](./MCP.md#http-access-streamable-http).
