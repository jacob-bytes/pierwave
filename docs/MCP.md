# PierWave MCP（只读服务）

[简体中文](#简体中文) | [English](#english)

---

## 简体中文

`pierwave-mcp` 是一个 **只读** 的 [MCP](https://modelcontextprotocol.io/) stdio 服务：
它通过逐行 JSON-RPC 2.0 与 MCP 客户端通信，直接以只读方式打开主控的 SQLite 数据库，
提供 5 个查询工具。它不经过主控 HTTP API，也没有任何写入、重启或下发配置的能力。

### 构建

```bash
cargo build --release -p pierwave-mcp
# 产物：target/release/pierwave-mcp
```

本仓库的沙箱把 cargo 缓存指到了仓库内；在这一环境下请显式带上缓存目录：

```bash
CARGO_HOME=$PWD/.cargo-home cargo build --release -p pierwave-mcp
```

运行测试：

```bash
CARGO_HOME=$PWD/.cargo-home cargo test -p pierwave-mcp
```

### 运行

```bash
# 显式指定数据库
pierwave-mcp --db ./data/pierwave.db

# 或读取环境变量（主控也使用同名变量，值可以是路径或 sqlite:// URL）
PIERWAVE_DB=./data/pierwave.db pierwave-mcp

# 都没有时回落到 data/pierwave.db
pierwave-mcp
```

参数：

| 参数 | 说明 |
|---|---|
| `--db <path>` | 主控 SQLite 文件路径；也接受 `sqlite://...?mode=rwc` 形式（查询串会被忽略，强制只读） |
| `-h`, `--help` | 显示双语帮助 |
| `-V`, `--version` | 显示版本 |

启动时会检查文件存在，并以 `SQLITE_OPEN_READONLY`（等价于 `?mode=ro`）打开；文件不存在
会直接失败并给出中英双语提示。stdout 只输出 JSON-RPC，日志全部走 stderr。

### 配置到 MCP 客户端

Claude Desktop（`claude_desktop_config.json`）或 Cursor（`~/.cursor/mcp.json`）示例：

```json
{
  "mcpServers": {
    "pierwave": {
      "command": "/absolute/path/to/pierwave-mcp",
      "args": ["--db", "/absolute/path/to/data/pierwave.db"]
    }
  }
}
```

用环境变量传路径：

```json
{
  "mcpServers": {
    "pierwave": {
      "command": "/absolute/path/to/pierwave-mcp",
      "env": {
        "PIERWAVE_DB": "/absolute/path/to/data/pierwave.db"
      }
    }
  }
}
```

任何支持 stdio MCP 的客户端都可以直接启动该命令。传输格式是**一行一个 JSON 对象**，
每个请求的响应也是一行。

### 协议

实现 MCP 2024-11-05 的基础方法：

| 方法 | 说明 |
|---|---|
| `initialize` | 返回 `protocolVersion: "2024-11-05"`、`capabilities.tools`、`serverInfo` |
| `tools/list` | 返回 5 个工具及各自的 JSON Schema `inputSchema` |
| `tools/call` | 执行只读工具，结果放在 `content: [{ "type": "text", "text": "<JSON>" }]` |
| `notifications/initialized` 等通知 | 没有 `id` 的通知直接忽略，不产生响应 |

`initialize` 的真实响应（为便于阅读已格式化，实际是一行）：

```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "capabilities": {
      "tools": {}
    },
    "protocolVersion": "2024-11-05",
    "serverInfo": {
      "name": "pierwave-mcp",
      "version": "0.5.10"
    }
  }
}
```

`tools/list` 返回的工具名固定为：

```text
list_servers
list_users
get_user_traffic
list_chains
get_status_summary
```

每个工具都有 `inputSchema`；无参工具也返回 `{"type":"object","properties":{}}`。

#### 错误码

| code | 场景 |
|---|---|
| `-32700` | 非法 JSON（Parse error） |
| `-32600` | 非法请求对象 / 缺少 `jsonrpc` 或 `method` |
| `-32601` | 未知方法（Method not found） |
| `-32602` | 未知工具、缺少/非法参数、未知用户名 |
| `-32603` | 数据库查询等内部错误 |

未知工具**不会**返回空结果，而是返回 `-32602`，并在 `message` 中列出可用工具。

### 工具

以下示例中的字节数均为整数；时间戳为 UTC Unix 秒；日期为 UTC+8 自然日。

#### 1. `list_servers`

输入：无参数。

```json
{"name":"list_servers","arguments":{}}
```

输出字段：`id`、`name`、`address`、`online`、`xray_running`、`load1`、
`mem`（`{used,total}`）、`disk`（`{used,total}`）、`mem_used`、`mem_total`、
`disk_used`、`disk_total`、`latency_ms`、`last_seen`。
没有心跳数据的字段为 `null`。

```json
{
  "servers": [
    {
      "id": "srv-hk",
      "name": "香港-01",
      "address": "hk1.example.com",
      "online": true,
      "xray_running": true,
      "load1": 0.42,
      "mem": { "used": 1610612736, "total": 4294967296 },
      "disk": { "used": 21474836480, "total": 107374182400 },
      "mem_used": 1610612736,
      "mem_total": 4294967296,
      "disk_used": 21474836480,
      "disk_total": 107374182400,
      "latency_ms": 18,
      "last_seen": 1794138184
    }
  ]
}
```

#### 2. `list_users`

输入：无参数。

```json
{"name":"list_users","arguments":{}}
```

输出字段：`user_id`、`username`、`role`、`package`、`used_bytes`、`limit_bytes`、
`expires_at`、`status`。

- 一个套餐实例一行；同一用户有多张卡时会出现多行（`username` 相同、`package` 不同）。
- 没有任何套餐实例的用户也会有一行，`package` / `limit_bytes` / `expires_at` 为 `null`，
  `used_bytes` 取用户账户总量。
- `status` 的优先级为 `disabled` > `expired` > `exhausted` > `active`；
  `limit_bytes = 0` 表示显式不限，不会判成 `exhausted`。

```json
{
  "users": [
    {
      "user_id": "user-alice",
      "username": "alice",
      "role": "user",
      "package": "基础套餐",
      "used_bytes": 3221225472,
      "limit_bytes": 107374182400,
      "expires_at": 1795866184,
      "status": "active"
    },
    {
      "user_id": "user-bob",
      "username": "bob",
      "role": "user",
      "package": "基础套餐",
      "used_bytes": 1073741824,
      "limit_bytes": 107374182400,
      "expires_at": 1794570184,
      "status": "active"
    }
  ]
}
```

#### 3. `get_user_traffic`

输入：

```json
{"username":"alice","days":7}
```

- `username` 必填，精确匹配。
- `days` 可选，默认 7，范围 1–90。
- 返回最近 `days` 个 UTC+8 自然日；没有数据的日期补 0，日期升序。
- 数据来自 `traffic_daily` 的 `subject = user_id`，字段为 `uplink` / `downlink` / `weighted`。

```json
{
  "username": "alice",
  "days": 3,
  "daily": [
    { "date": "2026-11-06", "uplink": 104857600, "downlink": 314572800, "weighted": 419430400 },
    { "date": "2026-11-07", "uplink": 209715200, "downlink": 629145600, "weighted": 838860800 },
    { "date": "2026-11-08", "uplink": 52428800, "downlink": 157286400, "weighted": 209715200 }
  ]
}
```

#### 4. `list_chains`

输入：无参数。

```json
{"name":"list_chains","arguments":{}}
```

输出：

- 链级：`id`、`name`、`enabled`、`target_host`、`target_port`、`group_count`、
  `member_count`、`degraded`、`groups`。
- 组级：`id`、`seq`、`name`、`strategy`、`member_count`、`degraded`、`members`。
- 成员级：`server_id`、`server_name`、`listen_port`、`priority`、`weight`、
  `forward_id`、`listening`、`target_ok`、`degraded`、`error`、`updated_at`。
- `listening` / `target_ok` 为 `null` 表示还没有对应的心跳状态；`degraded` 表示该成员
  连续 2 次上报 `target_ok = false`。任意成员降级会让所在组和整条链降级。
- `forward_id` 与主控推导的一致：单成员组为 `chain-<链id>-<组序号>`，
  多成员组为 `chain-<链id>-<组序号>-<server_id>`。

```json
{
  "chains": [
    {
      "id": "chain-main",
      "name": "香港 → 东京 → 目标",
      "enabled": true,
      "target_host": "target.example.com",
      "target_port": 443,
      "group_count": 2,
      "member_count": 3,
      "degraded": true,
      "groups": [
        {
          "id": "grp-entry",
          "seq": 0,
          "name": "入口",
          "strategy": "failover",
          "member_count": 2,
          "degraded": true,
          "members": [
            {
              "server_id": "srv-hk",
              "server_name": "香港-01",
              "listen_port": 9001,
              "priority": 0,
              "weight": 1,
              "forward_id": "chain-chain-main-0-srv-hk",
              "listening": true,
              "target_ok": true,
              "degraded": false,
              "error": "",
              "updated_at": 1794138184
            },
            {
              "server_id": "srv-jp",
              "server_name": "东京-01",
              "listen_port": 9002,
              "priority": 1,
              "weight": 1,
              "forward_id": "chain-chain-main-0-srv-jp",
              "listening": true,
              "target_ok": false,
              "degraded": true,
              "error": "connect timeout",
              "updated_at": 1794138184
            }
          ]
        }
      ]
    }
  ]
}
```

（示例省略了第二个组；真实输出会完整返回所有组。）

#### 5. `get_status_summary`

输入：无参数。

```json
{"name":"get_status_summary","arguments":{}}
```

输出：服务器总数/在线数、节点总数/启用数、今日与本月加权流量。

```json
{
  "generated_at": 1794138188,
  "servers": { "total": 3, "online": 2 },
  "nodes": { "total": 3, "enabled": 2 },
  "traffic": { "month_bytes": 6234832896, "today_bytes": 367001600 }
}
```

### 只读是怎么保证的

1. **打开方式**：`SqliteConnectOptions::read_only(true)`（等价于 URL 的 `?mode=ro`，
   设置 `SQLITE_OPEN_READONLY`），同时 `create_if_missing(false)`；文件不存在直接报错，
   不会创建一个空库。
2. **连接级保护**：连接建立后执行 `PRAGMA query_only = ON`，即使未来有人改错打开参数，
   这条连接也会拒绝写入。
3. **代码约束**：本 crate 的所有 SQL 都集中在 `crates/mcp/src/db.rs`，并且只有 `SELECT`；
   测试会扫描该文件，出现 `INSERT` / `UPDATE` / `DELETE` / `DROP` / `ALTER` / `CREATE`
   即失败。
4. **测试证明**：`read_only_connection_rejects_writes` 用真实临时数据库文件打开只读连接后
   执行 `INSERT`，断言 SQLite 返回只读错误；`missing_database_has_clear_error` 覆盖文件不存在。

### 为什么直接读 SQLite，而不是走主控 HTTP

- **不需要认证与管理员会话**：MCP 客户端是本地进程；走 HTTP 就要求它持有管理员 Cookie/Token，
  等于把写接口的凭据交给了客户端。只读 SQLite 天然没有这个风险。
- **不扩大主控的 API 面**：这 5 个查询不需要新增 HTTP 路由，也不需要改主控代码；主控保持
  单一职责，MCP 只是数据库的只读观察者。
- **拿到的是同一份事实**：面板、计费和 Agent 上报最终都落在 SQLite；直接查询避免
  「HTTP 视图字段不全 / 需要为 MCP 扩展 DTO」的二次维护。
- **故障时仍可诊断**：主控进程不在时，数据库文件（以及 WAL）仍可只读打开，便于排障。
- **代价**：查询直接绑定当前 schema。迁移只追加的约定降低了风险；schema 变化时需要同步
  更新 `crates/mcp/src/db.rs` 与测试。

### 限制与安全

- 没有鉴权：只应在可信的本机/本用户环境运行；不要把数据库文件或 MCP 服务暴露到公网。
- 需要数据库文件的读权限；如果主控使用 WAL 模式，还需要能读取同目录的 `-wal` / `-shm`。
- 不支持 `:memory:`；MCP 必须连接文件型数据库。
- 只读工具不会触发断流、下发、重启或任何副作用；它不能代替主控的管理操作。

---

## English

`pierwave-mcp` is a **read-only** [MCP](https://modelcontextprotocol.io/) stdio
server. It speaks line-delimited JSON-RPC 2.0, opens the master's SQLite database
in read-only mode, and exposes five query tools. It never calls the master HTTP
API and has no ability to write, restart anything, or push configuration.

### Build

```bash
cargo build --release -p pierwave-mcp
# binary: target/release/pierwave-mcp
```

This repository redirects the cargo cache into the workspace. In that sandbox, pass
the cache directory explicitly:

```bash
CARGO_HOME=$PWD/.cargo-home cargo build --release -p pierwave-mcp
```

Run the tests:

```bash
CARGO_HOME=$PWD/.cargo-home cargo test -p pierwave-mcp
```

### Run

```bash
# Explicit database path
pierwave-mcp --db ./data/pierwave.db

# Or the same environment variable the master uses (plain path or sqlite:// URL)
PIERWAVE_DB=./data/pierwave.db pierwave-mcp

# Falls back to data/pierwave.db
pierwave-mcp
```

| Option | Description |
|---|---|
| `--db <path>` | Master SQLite file. Accepts `sqlite://...?mode=rwc` too; the query string is ignored and the file is always opened read-only |
| `-h`, `--help` | Bilingual help |
| `-V`, `--version` | Version |

Startup checks that the file exists and opens it with `SQLITE_OPEN_READONLY`
(the typed equivalent of `?mode=ro`). A missing file is a startup error with a
bilingual message. stdout carries JSON-RPC only; diagnostics go to stderr.

### Client configuration

Claude Desktop (`claude_desktop_config.json`) or Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "pierwave": {
      "command": "/absolute/path/to/pierwave-mcp",
      "args": ["--db", "/absolute/path/to/data/pierwave.db"]
    }
  }
}
```

Passing the path through the environment:

```json
{
  "mcpServers": {
    "pierwave": {
      "command": "/absolute/path/to/pierwave-mcp",
      "env": {
        "PIERWAVE_DB": "/absolute/path/to/data/pierwave.db"
      }
    }
  }
}
```

Any MCP client that supports stdio can launch the command directly. The transport
is one JSON object per line; each response is one line as well.

### Protocol

Implements the MCP 2024-11-05 basics:

| Method | Behavior |
|---|---|
| `initialize` | Returns `protocolVersion: "2024-11-05"`, `capabilities.tools` and `serverInfo` |
| `tools/list` | Returns the five tools, each with a JSON Schema `inputSchema` |
| `tools/call` | Runs a read-only tool and returns `content: [{ "type": "text", "text": "<JSON>" }]` |
| `notifications/initialized` and other notifications | Ignored (no `id` means no response) |

Real `initialize` response (pretty-printed here; the wire format is one line):

```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "capabilities": {
      "tools": {}
    },
    "protocolVersion": "2024-11-05",
    "serverInfo": {
      "name": "pierwave-mcp",
      "version": "0.5.10"
    }
  }
}
```

`tools/list` always exposes:

```text
list_servers
list_users
get_user_traffic
list_chains
get_status_summary
```

Every tool has an `inputSchema`; no-argument tools return
`{"type":"object","properties":{}}`.

#### Error codes

| code | Meaning |
|---|---|
| `-32700` | Invalid JSON (parse error) |
| `-32600` | Invalid request object / missing `jsonrpc` or `method` |
| `-32601` | Unknown method |
| `-32602` | Unknown tool, missing/invalid arguments, unknown username |
| `-32603` | Internal error (database/query failure) |

An unknown tool is **not** an empty result: it returns `-32602` and the message
lists the available tools.

### Tools

Byte counts are integers; timestamps are UTC Unix seconds; dates are UTC+8
calendar days.

#### 1. `list_servers`

Input: no arguments.

```json
{"name":"list_servers","arguments":{}}
```

Output fields: `id`, `name`, `address`, `online`, `xray_running`, `load1`,
`mem` (`{used,total}`), `disk` (`{used,total}`), `mem_used`, `mem_total`,
`disk_used`, `disk_total`, `latency_ms`, `last_seen`.
Fields without heartbeat data are `null`.

```json
{
  "servers": [
    {
      "id": "srv-hk",
      "name": "香港-01",
      "address": "hk1.example.com",
      "online": true,
      "xray_running": true,
      "load1": 0.42,
      "mem": { "used": 1610612736, "total": 4294967296 },
      "disk": { "used": 21474836480, "total": 107374182400 },
      "mem_used": 1610612736,
      "mem_total": 4294967296,
      "disk_used": 21474836480,
      "disk_total": 107374182400,
      "latency_ms": 18,
      "last_seen": 1794138184
    }
  ]
}
```

#### 2. `list_users`

Input: no arguments.

```json
{"name":"list_users","arguments":{}}
```

Output fields: `user_id`, `username`, `role`, `package`, `used_bytes`,
`limit_bytes`, `expires_at`, `status`.

- One row per package instance. A user with multiple cards appears multiple times
  (same `username`, different `package`).
- A user with no package instances still appears once; `package` / `limit_bytes` /
  `expires_at` are `null`, and `used_bytes` is the account total.
- `status` precedence: `disabled` > `expired` > `exhausted` > `active`.
  `limit_bytes = 0` means explicitly unlimited and is never `exhausted`.

```json
{
  "users": [
    {
      "user_id": "user-alice",
      "username": "alice",
      "role": "user",
      "package": "基础套餐",
      "used_bytes": 3221225472,
      "limit_bytes": 107374182400,
      "expires_at": 1795866184,
      "status": "active"
    },
    {
      "user_id": "user-bob",
      "username": "bob",
      "role": "user",
      "package": "基础套餐",
      "used_bytes": 1073741824,
      "limit_bytes": 107374182400,
      "expires_at": 1794570184,
      "status": "active"
    }
  ]
}
```

#### 3. `get_user_traffic`

Input:

```json
{"username":"alice","days":7}
```

- `username` is required and matched exactly.
- `days` is optional, defaults to 7, range 1–90.
- Returns the last `days` UTC+8 calendar days, ascending; missing days are zero.
- Data comes from `traffic_daily` where `subject = user_id`; fields are
  `uplink` / `downlink` / `weighted`.

```json
{
  "username": "alice",
  "days": 3,
  "daily": [
    { "date": "2026-11-06", "uplink": 104857600, "downlink": 314572800, "weighted": 419430400 },
    { "date": "2026-11-07", "uplink": 209715200, "downlink": 629145600, "weighted": 838860800 },
    { "date": "2026-11-08", "uplink": 52428800, "downlink": 157286400, "weighted": 209715200 }
  ]
}
```

#### 4. `list_chains`

Input: no arguments.

```json
{"name":"list_chains","arguments":{}}
```

Output:

- Chain: `id`, `name`, `enabled`, `target_host`, `target_port`, `group_count`,
  `member_count`, `degraded`, `groups`.
- Group: `id`, `seq`, `name`, `strategy`, `member_count`, `degraded`, `members`.
- Member: `server_id`, `server_name`, `listen_port`, `priority`, `weight`,
  `forward_id`, `listening`, `target_ok`, `degraded`, `error`, `updated_at`.
- `listening` / `target_ok` are `null` when no matching heartbeat exists yet.
  `degraded` means the member reported `target_ok = false` twice in a row. Any
  degraded member marks its group and the whole chain degraded.
- `forward_id` matches the master's derivation: `chain-<chain_id>-<seq>` for a
  single-member group, `chain-<chain_id>-<seq>-<server_id>` for multi-member groups.

```json
{
  "chains": [
    {
      "id": "chain-main",
      "name": "香港 → 东京 → 目标",
      "enabled": true,
      "target_host": "target.example.com",
      "target_port": 443,
      "group_count": 2,
      "member_count": 3,
      "degraded": true,
      "groups": [
        {
          "id": "grp-entry",
          "seq": 0,
          "name": "入口",
          "strategy": "failover",
          "member_count": 2,
          "degraded": true,
          "members": [
            {
              "server_id": "srv-hk",
              "server_name": "香港-01",
              "listen_port": 9001,
              "priority": 0,
              "weight": 1,
              "forward_id": "chain-chain-main-0-srv-hk",
              "listening": true,
              "target_ok": true,
              "degraded": false,
              "error": "",
              "updated_at": 1794138184
            },
            {
              "server_id": "srv-jp",
              "server_name": "东京-01",
              "listen_port": 9002,
              "priority": 1,
              "weight": 1,
              "forward_id": "chain-chain-main-0-srv-jp",
              "listening": true,
              "target_ok": false,
              "degraded": true,
              "error": "connect timeout",
              "updated_at": 1794138184
            }
          ]
        }
      ]
    }
  ]
}
```

(The example omits the second group; the real response contains every group.)

#### 5. `get_status_summary`

Input: no arguments.

```json
{"name":"get_status_summary","arguments":{}}
```

Output: server total/online, node total/enabled, and today's/month's weighted traffic.

```json
{
  "generated_at": 1794138188,
  "servers": { "total": 3, "online": 2 },
  "nodes": { "total": 3, "enabled": 2 },
  "traffic": { "month_bytes": 6234832896, "today_bytes": 367001600 }
}
```

### How read-only is enforced

1. **Open flags**: `SqliteConnectOptions::read_only(true)` (the typed equivalent of
   `?mode=ro`, i.e. `SQLITE_OPEN_READONLY`) with `create_if_missing(false)`. A
   missing file fails instead of creating an empty database.
2. **Connection guard**: after connecting, `PRAGMA query_only = ON` makes the
   connection reject writes even if the open options are changed later.
3. **Code rule**: all SQL in this crate lives in `crates/mcp/src/db.rs` and is
   `SELECT`-only. A test scans that file and fails on `INSERT` / `UPDATE` /
   `DELETE` / `DROP` / `ALTER` / `CREATE`.
4. **Test proof**: `read_only_connection_rejects_writes` opens a real temporary
   database file read-only and asserts that `INSERT` fails; the missing-file path
   is covered as well.

### Why read SQLite directly instead of the master HTTP API

- **No admin credentials in the client**: the MCP client is a local process. Going
  through HTTP would require it to hold an admin cookie/token, effectively handing a
  write-capable surface to the client. Read-only SQLite avoids that.
- **No growth of the master API surface**: these five queries need no new HTTP
  routes and no master code changes; the master stays focused, and MCP is just a
  read-only observer.
- **Same source of truth**: panel, metering and agent reports all land in SQLite.
  Querying it avoids a second DTO/view layer maintained only for MCP.
- **Diagnostics when the master is down**: the database file (and WAL) can still be
  opened read-only for troubleshooting.
- **Trade-off**: queries are tied to the current schema. The append-only migration
  rule limits the risk; schema changes must update `crates/mcp/src/db.rs` and its tests.

### Limitations and safety

- No authentication: run it only on a trusted local host/user; never expose the DB
  file or the MCP service to the public internet.
- The process needs read access to the database file. With WAL mode it also needs to
  read the adjacent `-wal` / `-shm` files.
- `:memory:` is not supported; MCP needs a file-backed database.
- Read-only tools have no side effects: they never trigger enforcement, applies,
  restarts or any other master action, and cannot replace admin operations.
