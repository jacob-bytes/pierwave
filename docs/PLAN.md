# pierwave 施工计划

目标：用 Rust 重写一套「Xray 代理面板 + 节点拼车/订阅分发」系统。
早期参考过第三方公开文档（本地抓取，不入库），方案取舍见对话记录。

## 技术基线

- 后端：axum 0.8 + tokio + sqlx(SQLite) + serde；`crates/{proto,domain,master,agent}`
- 前端：React 19 + TypeScript + Vite + Tailwind 4 + TanStack Query + react-router
- 部署形态：master 单二进制（内嵌 `web/dist`）+ agent 单二进制，Agent 反向 WS 连入

## P0（当前）：一条竖线打通

| # | 任务 | 状态 | 归属 |
|---|---|---|---|
| 1 | workspace 骨架、CI 脚本、协议契约 | ✅ | 主控 |
| 2 | 会话登录 / 登出 / me | ✅ | 主控 |
| 3 | 服务器 CRUD + 一次性 token | ✅ | 主控 |
| 4 | Agent WS 握手 + 心跳 + 上下线 | ✅ | 主控 |
| 5 | SPA 基座（登录、布局、服务器页） | ✅ | 主控 |
| 6 | 节点/入站 CRUD + Xray 配置生成 + 期望态下发 | ✅ | 后端 lane |
| 7 | Xray 配置校验/回滚（`xray -test`） | ⬜ | 后端 lane |
| 8 | UI 组件基座（shadcn：表格/表单/对话框/Toast） | ✅ | 前端 lane |
| 9 | Agent 侧 `xray -test` 校验与回滚 | 🚧 | agent lane |
| 10 | 用户 / 套餐实例 API | 🚧 | 后端 lane |
| 11 | 用户管理页（表格 + 套餐抽屉） | ⬜ | 前端 lane |

### 已定的实现细节（后端 lane 落地的）

- 节点在库里只存「入站片段」（`config_json`），完整配置由 `pierwave_domain::xray::build_config` 纯函数拼装，输出确定性。
- 节点 API 返回的字段是 `config`（JSON 对象），前端不需要二次 parse。
- 主控用 `AgentHub`（tokio broadcast）按 server 广播期望态；`apply` 时 `config_version` 原子 +1。
- **重连补发 + 版本幂等**：Agent 连上就补发当前期望态；Agent 侧只有 `incoming > applied` 才真正重启 xray，
  所以补发不会造成重启风暴（旧版本消息被静默跳过）。

## API 契约（前端与后端共同遵守）

```
GET    /api/v1/health
POST   /api/v1/auth/login          {username,password} -> {user}
POST   /api/v1/auth/logout         -> {ok:true}
GET    /api/v1/auth/me             -> {user}
GET    /api/v1/servers             -> {items:[Server]}
POST   /api/v1/servers             {name,address,xray_mode} -> {server,token,install_command}
GET    /api/agent/ws               (WebSocket, Agent 专用)
```

约定：错误统一 `{"error":"中文信息"}`；时间一律 Unix 秒；ID 为 UUID 字符串。

新增节点相关（第 6 项，待实现）：

```
GET    /api/v1/servers/:id/nodes   -> {items:[Node]}
POST   /api/v1/servers/:id/nodes   {name,protocol,transport,security,port,config} -> {node}
PATCH  /api/v1/nodes/:id           {enabled?,config?} -> {node}
DELETE /api/v1/nodes/:id           -> {ok:true}
POST   /api/v1/servers/:id/apply   -> {config_version, warnings:[string]}
```

## 每轮验收

1. `make check` 全绿（fmt/clippy/test/web build）
2. 自动化冒烟：起 master → 登录 → 建服务器 → 起 agent → 状态 online
3. 新增页面能在浏览器里点到，且 401/403 路径有明确中文提示

## 明确不做

- MeowX 类跨平台客户端（另一个产品）
- 官方许可证 / `/api/secure/*` 通道
- 多语言文档站

## P1：用户与套餐（本轮契约）

拼车系统的核心是**套餐实例**（user_package），不是套餐模板：一个用户可以挂多张卡，
每张卡独立额度 / 到期 / 重置日 / 状态。所以 API 里 `users` 与 `user_packages` 是两个资源。

### 视图模型

```jsonc
// UserView
{ "id","username","role","status","short_code","quota_bytes","used_bytes","created_at",
  "package_count",
  "packages": [ { "id","package_id","package_name",
                  "quota_override",   // 原始覆写值：null=继承，0=显式不限，N=覆写
                  "quota_bytes",      // 生效额度（已把覆写与套餐兜底合并）
                  "used_bytes","expires_at","reset_day",
                  "status",           // active | expired | exhausted | disabled（后端计算）
                  "direction","node_ratio" } ] }

// Package
{ "id","name","quota_bytes","period_days","direction","node_ratio","created_at",
  "user_count" }                  // 引用该套餐模板的实例数
```

- `quota_bytes` 为 `null` 表示不限；`expires_at` / `reset_day` 可为 `null`。
- `quota_override` 必须原样回显，前端才能表达「改回继承」：`PATCH` 传 `{"quota_override": null}`
  即清空覆写，随后 `quota_bytes` 回落到套餐额度；传 `0` 是显式不限（`quota_bytes = 0`），两者语义不同。
- `UserPackageView.status` 由后端计算，库里仍存原始 `status`：
  1. `disabled`：原始状态不是 `active`；
  2. `expired`：`expires_at` 非空且 `<= now`；
  3. `exhausted`：生效额度非空且 `> 0`，且 `used_bytes >= 生效额度`（0 = 不限，不算用尽）；
  4. 其余为 `active`。
  「该实例是否还能用」统一走领域层的 `is_usable()`，订阅资格与 apply 注入复用同一口径。
- `Package.user_count` 由一条聚合查询带出（不要 N+1），前端删除前用它提前禁用按钮；
  `UserView.package_count` 与 `packages.len()` 一致，供分页/汇总使用。

### 接口（全部要求管理员）

```
GET    /api/v1/users?q=<用户名/昵称>&limit=200     -> {items:[UserView]}
POST   /api/v1/users                              {username,password,role?,quota_bytes?} -> {user}
PATCH  /api/v1/users/:id                          {status?,role?,password?,quota_bytes?} -> {user}
DELETE /api/v1/users/:id                          -> {ok:true}   // 不能删自己

GET    /api/v1/packages                           -> {items:[Package]}
POST   /api/v1/packages                           {name,quota_bytes?,period_days?,direction?,node_ratio?} -> {package}
PATCH  /api/v1/packages/:id                       {同上任意字段} -> {package}
DELETE /api/v1/packages/:id                       -> {ok:true}   // 有实例引用时 400

GET    /api/v1/users/:id/packages                 -> {items:[UserPackageView]}
POST   /api/v1/users/:id/packages                 {package_id,expires_at?,quota_override?,reset_day?} -> {item}
PATCH  /api/v1/user-packages/:id                  {expires_at?,quota_override?,reset_day?,status?} -> {item}
DELETE /api/v1/user-packages/:id                  -> {ok:true}
```

### 校验规则

- 用户名 3–32 字符，唯一；密码 ≥ 8 位；`role` ∈ {admin,user}；`status` ∈ {active,disabled}。
- `direction` ∈ {both,upload,download}；`node_ratio` ∈ (0,10]；`period_days` ∈ [1,3650] 或 null。
- `reset_day` ∈ [1,31] 或 null；`quota_override` 为 null 表示沿用套餐额度，0 表示显式不限。
- 删除仍被实例引用的套餐 → 400，提示"该套餐还有 N 个用户在用"。

### apply 的 warnings

`POST /api/v1/servers/:id/apply` 返回 `{config_version, warnings:[string]}`。
`warnings` 一定存在（没有跳过时是空数组），每个被跳过的节点一条中文说明，例如：

```json
{ "config_version": 7, "warnings": ["节点 香港-01 被跳过：REALITY 私钥无法解析"] }
```

节点是否可用的校验在 `pierwave_domain::xray::build_config_checked` 里；`config_version` 的语义不变
（每次 apply 仍原子 +1），跳过的节点只是不进入本次下发的 `inbounds`。

### 时间语义

- 所有时间戳一律以 **UTC Unix 秒**存储与传输；ID 为 UUID 字符串。
- 「本月流量重置日」与「到期判定」按 **UTC+8** 计算自然日：用固定偏移 `UTC+8`（28800 秒），不引入 `chrono-tz`。
  按 `period_days` 自动算出的到期时间落在 UTC+8 当天的 `23:59:59`。
- 日账本 `traffic_daily.day` 也用 UTC+8 的日期（`YYYY-MM-DD`），不要用 UTC 日期。

### 安全

- 不能删除自己、不能把自己降级成 user（避免锁死后台）。
- 密码字段永不回显；`UserView` 里没有 `password_hash`。

## 语义裁决（P1 联调后补）

| 问题 | 决定 |
|---|---|
| `Package.quota_bytes = 0` 与 `User.quota_bytes = 0` | **非法**，返回 400：「额度请留空表示不限，或填写大于 0 的数值」。只有实例级 `quota_override = 0` 保留「显式不限」语义，因为那里的 0 是有意义的（覆写为无限，区别于继承） |
| `reset_day = 29/30/31` 遇到小月 | 压到当月最后一天（2 月按 28/29 处理），不报错、不顺延到下月 |
| 时间戳时区 | 存储与传输一律 UTC 秒；业务日（重置日、到期、日账本）按 UTC+8 计算 |
| 节点被跳过（坏配置） | `apply` 响应返回 `warnings`；Agent 重连补发时仅写日志，面板若需常驻提示，后续在节点列表暴露 `problems` 字段 |
| `quota_override` 清空 | `PATCH {"quota_override": null}` = 改回继承套餐额度；前端必须预填原值，否则用户只能解绑重绑 |

## P3：概览与订阅（本轮契约）

### 概览

```
GET /api/v1/stats/overview -> {
  "servers":  { "total": 3, "online": 2 },
  "users":    { "total": 10, "active": 9 },
  "packages": { "total": 4, "instances": 12 },
  "traffic":  { "today_bytes": 123, "month_bytes": 456 },
  "alerts":   { "expired_instances": 2, "exhausted_instances": 1, "offline_servers": 1 }
}
```

### 流量趋势

```
GET /api/v1/stats/traffic?days=7 -> {
  "days": [ { "date": "2026-11-05", "uplink": 1, "downlink": 2, "weighted": 3 } ]
}
```

`date` 为 UTC+8 自然日；缺数据的日期要补 0 而不是跳过（前端画图更简单）。

### 订阅管理页要用的数据

不需要新接口：`GET /api/v1/users` 已包含 `short_code`、`packages`、`used_bytes`、`quota_bytes`。
订阅链接由前端拼 `{origin}/api/v1/sub/{short_code}`。

### 每日重置（METERING §4 的落地）

- 每小时唤醒一次，对 `reset_day == 今天(UTC+8)` 且今天还没重置过的实例执行清零；
- 需要记录「上次重置时间」→ 迁移 `0003_user_package_reset.sql` 加 `last_reset_at INTEGER`；
- 清零时同步扣减 `users.used_bytes`（扣到 0 为止，不要出现负数）。

## P4：用户端自助（本轮契约）

普通用户只能看到自己，接口一律**忽略传入参数、以会话用户为准**：

```
GET /api/v1/me/summary -> {
  "user":     { "id", "username", "role", "short_code", "used_bytes", "quota_bytes" },
  "packages": [ UserPackageView ],           // 与管理员视图同结构
  "traffic":  { "today_bytes": 123, "month_bytes": 456 },
  "subscription_url": "/api/v1/sub/{short_code}"
}

GET /api/v1/me/traffic?days=7 -> { "days": [ TrafficDay ] }   // 只统计该用户
```

规则：
- 未登录 401；管理员调用也返回自己的数据（不特殊处理）。
- 断流中的用户仍返回 200 与真实状态（`packages[].status` 为 `exhausted`/`expired`），不返回 403。
- 前端据此区分三种提示：**正常 / 已用尽 (exhausted) / 已过期 (expired)**，并给「续费联系管理员」的引导文案，不要只显示「无节点」。

## P0-2：用户级总额度（本轮落地）

`users.quota_bytes` 之前只是展示字段：能设、能显示，但资格判定从不读它。

### 语义

- `NULL` = 不限（唯一表示「不限」的方式；`0` 在 API 层已被 400 拒绝，避免歧义）。
- 非空 = 跨套餐的**总闸**：`users.used_bytes >= users.quota_bytes` 时，该用户在所有服务器上都失去资格。
- 与套餐实例额度**同时生效**（交集）：实例用尽会断，总额度用尽也会断。
- 重置：实例月度重置会把 `used_bytes` 扣减，总额度随之回落；管理员调大 `quota_bytes` 亦可恢复。

### 落点

1. `authorization::eligible_pairs` 的 SQL 增加：
   ```sql
   AND (u.quota_bytes IS NULL OR u.used_bytes < u.quota_bytes)
   ```
   与节点范围条件并列，仍是一处判定。
2. 断流触发：`record_traffic` 更新 `users.used_bytes` 后，若该用户跨过总额度边界 → 走既有的「标记脏 + 30s 去抖」路径，不新增机制。
3. 可见性：
   - `UserView` 增加 `quota_exceeded: bool`（后端算，前端不猜）；
   - 用户列表/详情显示「已超出总额度」；
   - `/me/summary` 的 `user` 也带这个字段，用户端横幅提示。
4. 恢复：依赖既有的双向对账（5 分钟）+ 管理端动作触发的脏标记。

### 不做

- 不做「按比例分摊到各套餐实例」：总额度是用户级闸门，实例计费仍按瀑布分配，两者语义不同，不强行对齐。

## 待实现接口：全局节点列表（套餐范围选择器需要）

```
GET /api/v1/nodes  -> { "items": [ {
  id, server_id, server_name, tag, name, protocol, transport, security,
  port, enabled, cert_id, config, created_at
} ] }
```

管理员接口。存在的理由：套餐的节点范围要跨服务器选，而现有接口只提供
`GET /api/v1/servers/:id/nodes`，前端只能按服务器逐个拉（N+1 且无法在一个选择器里呈现）。

### 套餐范围的 API 表达（与 P0-1 实现保持一致）

```
POST  /api/v1/packages        { name, ..., node_ids?: string[] }   // 不传 = 全部节点
PATCH /api/v1/packages/:id    { ..., node_ids?: string[] | null }  // 缺失=不动, null=恢复全部, []=一个不给
GET   /api/v1/packages        items[] 含 node_ids / node_count
```

前端回填规则（在后端补 `node_scope` 字段之前先用这个推导）：
`node_ids.length > 0` → 指定；`node_ids` 空且 `node_count > 0` → 全部；两者皆空 → 不给。

## P1：运维基础（登录限流 / 会话清理 / 设置页）

### 1. 登录限流

- 维度：`(username, 客户端 IP)`，两者任一命中即限流（防单 IP 撞多账号、也防单账号被多 IP 撞）。
- 默认：15 分钟窗口内失败 5 次 → 锁定 15 分钟；可用设置页调整。
- 命中时返回 `429` + `Retry-After: <秒>`，body `{"error":"尝试过于频繁，请 N 分钟后再试"}`。
- **不泄露账号是否存在**：未知用户名与密码错误的行为完全一致（都计数、都返回同样的 401）。
- 登录成功清零该 key 的计数。
- 存储放内存（单主控），重启即清空——可接受，并在文档里写明。

客户端 IP：优先 `X-Forwarded-For` 第一段，其次 `ConnectInfo<SocketAddr>`（需要在 `axum::serve` 上开启 `into_make_service_with_connect_info`）。

### 2. 会话清理

`repo::sessions::purge_expired` 已存在但无人调用。在主控调度器里每小时跑一次，日志记清理条数。

### 3. 设置页

```
GET   /api/v1/settings   -> { items: { panel_name, login_max_attempts, login_lock_secs, session_ttl_hours } }
PATCH /api/v1/settings   { ...部分字段 } -> { items }
POST  /api/v1/me/password { old_password, new_password } -> { ok: true }
```

- 全部走已有的 `settings` 表（key/value TEXT），缺失时回落到默认值。
- `PATCH` 只接受白名单键，未知键 400；数值做范围校验（如 `login_max_attempts` 1–20）。
- 改密码后**吊销该用户的其它会话**（保留当前这条），避免旧设备一直在线。
- 断流总开关仍由环境变量 `PIERWAVE_ENFORCE` 控制，本轮不做运行时可切（会牵扯 Enforcer 生命周期）。

## P2：节点维度流量明细

现有 `traffic_daily` 的 `subject` 是 **user_id**，节点维度在归因时被丢掉了。要回答
「哪个节点在跑流量」「某节点上谁占得最多」，必须把 `(user, node)` 这个维度落库。

### 表

```sql
-- 0009_traffic_node_daily.sql
CREATE TABLE traffic_node_daily (
    day       TEXT NOT NULL,              -- UTC+8 自然日
    server_id TEXT NOT NULL,
    node_tag  TEXT NOT NULL,              -- 来自 email 的 {user_id}@{node_tag} 后半段
    user_id   TEXT NOT NULL,              -- '' = 无法归因（脏 email）
    uplink    INTEGER NOT NULL DEFAULT 0,
    downlink  INTEGER NOT NULL DEFAULT 0,
    weighted  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, server_id, node_tag, user_id)
);
```

保留 `traffic_daily`（用户总量、月账单仍读它），新表只做节点/用户×节点的切片。

### 接口

```
GET /api/v1/stats/nodes?days=7&server_id=<可选>
-> { "items": [ {
     "node_id","node_tag","name","server_id","server_name","protocol","transport","security",
     "uplink","downlink","weighted",          // days 窗口内
     "today_bytes","month_bytes"              // 加权后
   } ] }

GET /api/v1/stats/nodes/{node_id}?days=30&top=10
-> { "node": { ...同上单条... },
     "days": [ { "date","uplink","downlink","weighted" } ],   // 缺失日补 0
     "users": [ { "user_id","username","uplink","downlink","weighted" } ] }  // 按 weighted 降序
```

规则：管理员专用；`days` 夹在 1..90，`top` 夹在 1..50；`day` 一律 UTC+8。

### 采集侧

`record_delta` 已经能拿到 `node_tag`（`email.rsplit_once('@')` 的后半段），
在写 `traffic_daily` 的同时写一行 `traffic_node_daily`；无法归因时 `user_id` 写 `''`。

### 前端

- 节点列表（`/servers/:id/nodes`）增加「7 天流量」列（下行/上行拆开，或合计 + tooltip 拆分）；
- 行内「流量」入口打开 Sheet：节点近 30 天趋势图 + Top N 用户表；
- 概览页的节点视图不做，避免和现有趋势图重复。

## P2：订阅自定义规则（规则模板）

现在 `rules` 在 `ClashExporter` 里写死 `GEOIP,CN,DIRECT` + `MATCH,PROXY`，用户没法按自己的
分流策略走。做成**规则模板**：管理员维护几套，订阅默认用其中一套，也可以在订阅链接上指定。

### 表

```sql
-- 0010_rule_templates.sql
CREATE TABLE rule_templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    rules       TEXT NOT NULL,              -- JSON 数组，每个元素是一条 Clash 规则
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
-- 初始数据：默认模板（与旧行为完全一致，保证升级后订阅内容不变）
```

### 接口

```
GET    /api/v1/rule-templates        -> { items: [ {id,name,description,rules[],is_default,created_at,updated_at} ] }
POST   /api/v1/rule-templates        { name, description?, rules: [..], is_default? } -> { template }
PATCH  /api/v1/rule-templates/{id}   { name?, description?, rules?, is_default? } -> { template }
DELETE /api/v1/rule-templates/{id}   -> { ok: true }
```

规则：

- `rules` 非空，每条 1–200 字符；
- **最后一条必须以 `MATCH` 开头**（Clash 没有兜底规则整份配置无效），否则 400 中文；
- 同时只能有一个 `is_default = 1`：设置新的默认时在同一事务里清掉旧的；
- 默认模板**不允许删除**；删除其它模板不影响已发出的订阅（订阅是按请求时选的模板渲染）。

### 订阅端点

```
GET /api/v1/sub/{short_code}?rule=<template_id>&target=clash
```

- `rule` 省略 → 用 `is_default = 1` 的模板；
- 没有任何模板（理论上不会，迁移里有初始数据）→ 回落到内置的两条规则。

### 前端

`/rules` 页面（系统组）：
- 列表：名称、说明、规则条数、是否默认、更新时间；
- 新建/编辑 Dialog：名称、说明、规则多行文本（一行一条）、设为默认开关；
- 删除：被设为默认的禁止删除并提示；其它二次确认；
- 订阅页在复制链接旁给一个「规则模板」下拉，选中后链接带 `?rule=`。

## P3：出站与路由（可视化）

现状：`build_config` 里 `outbounds` 写死 `direct(freedom)` + `blocked(blackhole)`，`routing.rules`
只有一条 api 规则。所以每台服务器只能「直连出站」，做不了中转/落地链路。

### 表（0012_outbounds_routing.sql）

```sql
CREATE TABLE server_outbounds (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL,
    protocol    TEXT NOT NULL,           -- socks / http / vmess / vless / trojan / shadowsocks / freedom / blackhole
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    UNIQUE(server_id, tag)
);

CREATE TABLE server_routing_rules (
    id           TEXT PRIMARY KEY,
    server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    inbound_tag  TEXT,                   -- 空 = 不限定入站
    domain       TEXT,                   -- 逗号分隔的 Xray 域名匹配串，空 = 不按域名
    ip           TEXT,                   -- 逗号分隔的 IP/CIDR，空 = 不按 IP
    outbound_tag TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL
);
```

### 校验

- `tag`：`^[a-z0-9_-]{1,32}$`，同服务器内唯一，**不能占用保留字** `direct` / `blocked` / `api`；
- `protocol` 白名单见上；`config` 必须是 JSON 对象；
- 路由规则：`domain` / `ip` / `inbound_tag` **至少给一个**（否则规则会吞掉所有流量），
  `outbound_tag` 必须是 `direct` / `blocked` 或该服务器已存在的自定义出站；
- `inbound_tag` 若填写，必须指向该服务器上存在的节点 tag。

### 配置生成

`build_config` 增加 `outbounds` 与 `rules` 入参（建议抽一个 `ServerPlan` 结构体，别再加一串位置参数）：

```
outbounds = [direct(freedom), blocked(blackhole)] + 自定义（enabled 的，按创建顺序）
routing.rules = [ {inboundTag:["api"], outboundTag:"api"} ] + 自定义规则（按 sort_order, created_at）
```

自定义出站的 `config_json` 原样合并进 outbound 对象（`tag`/`protocol` 以数据库为准）。

### 接口

```
GET    /api/v1/servers/{id}/outbounds        -> { items: [ {id,server_id,tag,protocol,config,enabled,created_at} ] }
POST   /api/v1/servers/{id}/outbounds        { tag, protocol, config, enabled? } -> { outbound }
PATCH  /api/v1/outbounds/{id}                { tag?, protocol?, config?, enabled? } -> { outbound }
DELETE /api/v1/outbounds/{id}                -> { ok:true }
GET    /api/v1/servers/{id}/routing-rules    -> { items: [...] }
POST   /api/v1/servers/{id}/routing-rules    { inbound_tag?, domain?, ip?, outbound_tag, sort_order? } -> { rule }
PATCH  /api/v1/routing-rules/{id}            { ...同上 } -> { rule }
DELETE /api/v1/routing-rules/{id}            -> { ok:true }
```

删除仍被路由规则引用的出站 → 400 并说明被几条规则引用。
所有写操作都要 `mark_all_servers_dirty` 之外的精确处理：**标脏对应服务器**即可（复用 30s 去抖）。

### 前端

`/servers/:id/outbounds` 页面（服务器行操作入口）：
- 上半「出站」：列表 + 新建/编辑对话框（tag、协议、JSON 配置、启用开关）；
- 下半「路由规则」：列表（可上移/下移调整顺序）+ 新建/编辑（入站/域名/IP → 出站 下拉）；
- 顶部提示「修改后需要应用配置才对服务器生效」，附「应用配置」按钮。

### 本轮不做

- 图形化的规则可视化（先做表格 + 表单）
- 出站连通性测试
- routed 子节点（按节点分流到不同出站）——需要先有节点级别的出站绑定，下一轮

## P4：Agent 自升级

### 原则

仍然走「期望态」：主控下发 `agent_upgrade: {version, asset_url, sums_url, sig_url}`，
Agent 每次收敛时比较目标版本与自身版本，**只有更新才执行**，重复下发幂等。
是否允许下发由服务器上的开关控制（默认关闭）。

### 数据（0013_agent_upgrade.sql）

```sql
ALTER TABLE servers ADD COLUMN allow_agent_upgrade INTEGER NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN agent_target_version TEXT;   -- 期望版本，NULL = 不升级

CREATE TABLE agent_upgrades (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    from_version TEXT NOT NULL,
    to_version   TEXT NOT NULL,
    status       TEXT NOT NULL,          -- pending | succeeded | failed
    error        TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
```

### 下载中转

```
GET /api/agent/release/{version}/{asset}        -> 二进制（主控回源 GitHub 并缓存）
GET /api/agent/release/{version}/SHA256SUMS-{target}
GET /api/agent/release/{version}/SHA256SUMS-{target}.sig
```

- 缓存目录 `PIERWAVE_AGENT_CACHE`（默认 `data/agent-cache`），命中直接返回；
- 回源失败且无缓存 → 503 中文错误；
- 该端点用 server token 鉴权（与 `/api/agent/ws` 一致），避免被当成公开 CDN。

### Agent 侧流程

1. 收到 plan，若 `version` 不新于自身 → 忽略；
2. 下载三个文件到临时目录；
3. **验签**：内置公钥验 `SHA256SUMS.sig` → 再校验二进制 sha256；
4. 替换：`pierwave-agent.new` → 原子 rename；旧文件保留 `.bak`；
5. 重启自身（`systemctl restart pierwave-agent`），进程退出由 systemd 拉起；
6. **看门狗**：升级前 `systemd-run --on-active=120s` 注册一个回滚任务，
   新版本启动后写 `upgrade-ok` 标记；120 秒内没有标记 → 回滚 `.bak` 并重启；
7. 成功/失败都写回主控（下一个心跳带 `upgrade_result`）。

### 接口

```
PATCH /api/v1/servers/{id}            { allow_agent_upgrade?: bool }   （已有 PATCH 扩展）
POST  /api/v1/servers/{id}/agent-upgrade { version } -> { upgrade }    （仅允许开启时）
GET   /api/v1/servers/{id}/agent-upgrades -> 历史
```

### 前端

服务器行：显示 agent 版本；开启「允许下发升级」后，行操作出现「升级 Agent」，
弹窗里选版本（默认最新），提交后展示 pending 状态并在心跳刷新后变 succeeded/failed。

### 本轮不做

- 批量升级（一次一台，串行由用户手动控制）
- 降级（明确拒绝）
- Docker 模式下 Agent 自升级（容器内升级由镜像版本决定）
