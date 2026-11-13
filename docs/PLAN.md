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

## P5：批量 Agent 升级

### 决策（已拍板）

- 失败策略：**默认遇错即停**（剩余标 `skipped`），批次可传 `stop_on_failure: false`；
- 并发：**默认 1**，可在设置里调大，**上限 5**（`agent_upgrade_concurrency`）；
- 批量只对 `allow_agent_upgrade = 1` 的服务器生效，未开启的在 UI 里不可选、API 里 400。

### 表（0016_upgrade_batches.sql）

```sql
CREATE TABLE agent_upgrade_batches (
    id            TEXT PRIMARY KEY,
    from_version  TEXT NOT NULL DEFAULT '',   -- 状态里各台不一致，留空
    to_version    TEXT NOT NULL,
    status        TEXT NOT NULL,              -- running | succeeded | failed | cancelled
    stop_on_failure INTEGER NOT NULL DEFAULT 1,
    concurrency   INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE agent_upgrade_batch_items (
    batch_id   TEXT NOT NULL REFERENCES agent_upgrade_batches(id) ON DELETE CASCADE,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    upgrade_id TEXT,                          -- 触发后回填
    status     TEXT NOT NULL,                 -- queued | running | succeeded | failed | skipped | cancelled
    error      TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (batch_id, server_id)
);
```

### 执行模型：批量层只排队，不重写升级逻辑

后台 runner（每 10 秒一次）扫 `status = 'running'` 的批次：

1. 读取设置 `agent_upgrade_concurrency`（夹在 1..=5）；
2. 把 `running` 中的 item 与各自 `agent_upgrades.status` 同步：
   `pending → running`、`succeeded → succeeded`、`failed → failed`；
3. 若某 item 变 `failed` 且 `stop_on_failure = 1` → 剩余 `queued` 全部标 `skipped`，批次 `failed`；
4. 若 `running < concurrency` 且有 `queued` → 按创建顺序触发（复用单台触发路径），item 置 `running`；
5. 全部终态 → 批次 `succeeded`（有 failed 且允许继续时仍标 `failed` 但记录明细）。

### 接口

```
POST /api/v1/agent-upgrades/batches
     { server_ids: [..], version?: string, stop_on_failure?: bool } -> { batch }
GET  /api/v1/agent-upgrades/batches?limit=20                       -> { items: [batch] }
GET  /api/v1/agent-upgrades/batches/{id}                           -> { batch, items: [{server_id, server_name, agent_version, status, error, upgrade_id}] }
POST /api/v1/agent-upgrades/batches/{id}/cancel                    -> { batch }
```

校验：`server_ids` 非空且 ≤ 50；必须全部开启 `allow_agent_upgrade`；同一台不能同时出现在两个 running 批次里。

### 前端

服务器列表多选（仅可选已开启升级的服务器）→ 顶部操作条「已选 N 台 · 升级到 ▾ · 开始批量升级」→
进度面板逐台显示 `等待中/进行中/成功/失败(原因)`，失败项给「重试本台」；
设置页新增「Agent 升级并发数」（1–5，默认 1）并说明「并发越大，同时中断的节点越多」。

## P6：规则模板绑定到用户 / 套餐

规则模板已经能存、订阅也能用 `?rule=` 指定，但每个用户都要手动拼参数。这一轮把
「谁用哪套规则」落到数据里。

### 数据（0017_rule_template_binding.sql）

```sql
ALTER TABLE users    ADD COLUMN rule_template_id TEXT REFERENCES rule_templates(id) ON DELETE SET NULL;
ALTER TABLE packages ADD COLUMN rule_template_id TEXT REFERENCES rule_templates(id) ON DELETE SET NULL;
```

### 解析顺序（订阅端点）

```
?rule=<id>                    1. 链接参数（最高优先级，临时覆盖）
users.rule_template_id        2. 用户绑定
packages.rule_template_id     3. 用户当前套餐的绑定
is_default = 1                4. 全局默认
内置两条规则                   5. 兜底
```

- 「当前套餐」= 该用户最近一次绑定的、未过期的实例；同优先级下多实例取最新一条。
- 模板被删除时 `SET NULL`：绑定自动失效并回落到下一级，**不会让订阅变成 502**。

### 接口

- `users` / `packages` 的视图与写接口都增加 `rule_template_id`（string | null）；
- 校验：指向不存在的模板 → 400；
- `GET /api/v1/subscriptions` 每行增加 `rule_template_id` 与 `rule_template_name`（生效值，
  来自上面的解析顺序），前端直接展示「这个用户实际用的是哪套规则」。

### 前端

- 用户新建/编辑对话框：增加「规则模板」下拉（空 = 跟随套餐/全局默认）；
- 套餐对话框：增加「默认规则模板」下拉，说明「套餐内用户未单独指定时用它」；
- 订阅列表：每行显示生效的模板名（只读），点击可跳到规则模板页。

### 不做

- 按订阅链接的 `?rule=` 参数做鉴权（它本来就是公开端点，能改的只有规则，不影响计费）。

## P7：备份与恢复

所有数据（含证书 PEM）都在 SQLite 里，所以备份 = 单个数据库文件。

### 接口（管理员）

```
GET    /api/v1/backup            -> application/gzip
                                    文件名 pierwave-backup-<YYYYmmdd-HHMMSS>.db.gz
                                    内容：`VACUUM INTO` 的一致性快照再 gzip
POST   /api/v1/backup/restore    -> body 为 .db 或 .db.gz（Content-Type: application/octet-stream）
                                    { restart_required: true, pending: {...} }
GET    /api/v1/backup/info       -> { db_bytes, pending: null | { uploaded_at, bytes } }
DELETE /api/v1/backup/restore    -> 取消待恢复
```

### 恢复为什么不在线替换

热替换正在使用的 SQLite 文件会让连接池持有旧 inode，轻则数据错乱重则损坏。所以：

1. 上传后**只落盘**为 `<db>.restore-pending`，返回 `restart_required`；
2. 主控启动时若发现该文件且通过校验 → 把当前库改名成 `<db>.pre-restore-<ts>`（保留回滚）→ 用待恢复文件替换 → 继续启动；
3. 校验不通过 → 不替换，日志报错并保留现场。

### 校验

- 文件头必须是 `SQLite format 3\0`；
- 必须含 `users` 与 `_sqlx_migrations` 表（不是随便一个 sqlite 文件）；
- 备份里的迁移版本 **不能高于** 当前二进制支持的版本（防止把新库恢复到旧版）；
- 大小上限 512 MB。

### 前端

设置页新增「备份与恢复」卡片：
- 「下载备份」按钮（浏览器直接下载）；
- 「恢复」上传区：选择文件 → 二次确认（勾选「我明白会覆盖当前全部数据并需要重启」）→ 上传 → 展示「已就绪，重启后生效」与「取消待恢复」；
- 显示当前库大小；恢复待生效时显眼提示。

## P8：后端错误双语（错误码）

现在所有 `AppError` 的文案都是中文，英文界面下报错仍是中文，违反双语规则。

### 响应形状（向后兼容）

```json
{ "error": "目标版本必须比当前版本新", "code": "agent.upgrade.not_newer",
  "params": { "current": "0.5.3", "target": "0.5.2" } }
```

`error` 保留（中文兜底），`code` 与 `params` 是新增。**旧前端不受影响，新前端按 code 翻译。**

### 约定

- code 用 `模块.对象.原因` 三段式，全小写下划线，例如 `user.not_found`、
  `package.node_scope_invalid`、`backup.restore_bad_header`；
- 同一个 code 的含义与文案必须稳定，**不要按句子造 code**（否则词典爆炸）；
- `params` 只放前端需要插值的值，且必须是可 JSON 序列化的短值；
- 前端 `errors.ts`：有 `code` 且词典命中 → 用翻译；否则回落到 `error` 原文
  （保证未翻译的旧错误不显示成 `errors.xxx` 这种键名）。

### 落地顺序

1. 后端：`AppError` 增加 coded 构造 + 全部 `BadRequest/NotFound/Conflict/Unauthorized/Forbidden`
   站点改造，并输出 code 清单；
2. 前端：`errors.ts` 按 code 查表 + `i18n` 的 `errors.*` 词典（中英各一份）+ 单测。

## P9：订阅格式扩展

参考实现对客户端格式的覆盖：Clash/Meta、Surge、Loon、Quantumult X、Shadowrocket、
sing-box、Stash、Surfboard、V2Ray、Egern。我们目前只有 Clash 与 URI 两种。

### 目标格式

| id | 客户端 | 形态 |
|---|---|---|
| `clash` | mihomo / Verge | YAML（已有） |
| `stash` | Stash | YAML，与 clash 结构接近（可复用生成器 + 少量差异） |
| `surge` | Surge | INI 段落（`[Proxy]` / `[Proxy Group]` / `[Rule]`） |
| `loon` | Loon | INI，与 surge 类似但字段名不同 |
| `qx` | Quantumult X | INI（`[server_local]` / `[policy]` / `[filter_local]`） |
| `surfboard` | Surfboard | INI，surge 的安卓变体 |
| `singbox` | sing-box | JSON（`outbounds` + `route.rules`） |
| `shadowrocket` | Shadowrocket | base64 的 URI 列表（与 v2ray 同族） |
| `v2ray` | V2RayN / NG | base64 的 URI 列表（现有 `uri` 的别名） |
| `egern` | Egern | YAML，与 clash 接近 |

### 约束

- 只加 `Exporter` 实现 + 注册表一行，**不改渲染器的调用方式**；
- 每个格式都要有单测：至少断言节点数量、每条节点名出现、协议关键字正确、
  JSON 格式（singbox）能被 `serde_json` 解析、YAML（stash/egern）能被解析；
- REALITY / WS / gRPC 等传输在每个格式里的表达方式不同：不支持的组合**跳过该节点并计数**，
  不要生成一条客户端会拒收的配置；
- 规则模板要映射到各格式的规则语法（Surge 家族用 `DOMAIN-SUFFIX,x,y` 与 `FINAL,y`，
  Quantumult X 用 `host-suffix` 等），映射不了的规则跳过；
- `?target=` 与 UA 嗅探都要认识新 id。

### 前端

订阅行增加「格式」下拉（默认 Clash），复制/二维码用 `?target=<id>`；
订阅页给一张「客户端支持」小表（折叠），列出 id 与对应客户端。

## P10：探针公开页

给未登录访客一个只读状态页（`/status`），视觉参考本机的 `miniprobe/monitor-theme-default`
（shadcn + 靛蓝，与我们同源）。数据只用**已有 + 新增采样**，不造假。

### 采样（0018_server_samples.sql）

```sql
CREATE TABLE server_samples (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ts         INTEGER NOT NULL,       -- 采样时间（5 分钟对齐）
    online     INTEGER NOT NULL,
    load1      REAL NOT NULL DEFAULT 0,
    mem_used   INTEGER NOT NULL DEFAULT 0,
    mem_total  INTEGER NOT NULL DEFAULT 0,
    disk_used  INTEGER NOT NULL DEFAULT 0,
    disk_total INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, ts)
);
```

调度器每 5 分钟写一行（在线状态取 `servers.status`），保留 7 天（每小时清理）。

### 公开接口（**无需登录**）

```
GET /api/v1/public/status
-> { panel_name, generated_at,
     summary: { servers_total, servers_online, nodes_total, traffic_today, traffic_month },
     servers: [ { id, name, online, xray_running, load1, mem_used, mem_total,
                  disk_used, disk_total, uptime_secs, last_seen,
                  uptime_24h, uptime_7d,           // 0..1，无采样时为 null
                  buckets_24h: [ { ts, online_ratio } ] } ] }
```

- **不返回服务器地址、用户数、套餐等敏感信息**；
- 设置项 `public_status_enabled`（默认 1）可整体关闭，关闭时 404；
- 结果缓存 30 秒，避免被打爆。

### 前端

`/status` 公开路由（不需要登录、不套 AppShell 侧栏）：
- 顶部：面板名 + 汇总（在线 x/y、节点数、今日/本月流量）；
- 节点卡/表：状态点、负载、内存、磁盘、最后心跳、24h/7d 可用率条；
- 复用参考项目的视觉语言（卡片、状态点、迷你条），但**不照搬我们没有的数据**（延迟、运营商、事件时间线）。

## P11：限速（A + C）

### 先说清楚 Xray 的能力边界

Xray **没有**按用户限速、也没有并发连接数上限的配置项。能用的旋钮只有：

- `policy.levels.<n>.bufferSize`：连接缓冲区大小，间接影响吞吐；
- `policy.levels.<n>.connIdle`：空闲连接回收时间；
- 用户可分配 `level`，从而套用某一档策略。

所以「按用户限速」只能做成**近似**（buffer 越小吞吐越低），不是精确的 kbps 控制。
精确的按用户限速需要「每用户一个 inbound tag」——那会改变订阅模型，不在本轮。

### A. 节点级带宽上限（tc，精确）

```sql
ALTER TABLE nodes ADD COLUMN bandwidth_kbps INTEGER;   -- NULL / 0 = 不限
```

- Agent 按节点端口在该服务器出口网卡上加 `tc` 规则（HTTPS/HTB + u32 filter 匹配 dport），
  **只管理自己的 qdisc handle（`1f00:`）**，删除时只删这一条，绝不 `tc qdisc del dev root`；
- 幂等：每次 apply 先删自己的 handle 再加；没有限额的节点不加规则；
- 安全：Agent 应用后如果 30 秒内与主控失联，自动删除自己的 qdisc（避免把服务器网络锁死）；
- 失败只 warn，不影响 xray 配置应用。

### C. 每用户近似限速（bufferSize）

```sql
ALTER TABLE packages ADD COLUMN speed_limit_kbps INTEGER;  -- NULL / 0 = 不限
```

- 套餐上配一个档位；渲染 Xray 配置时，为每个用量档生成一个 `policy.levels.N.bufferSize`，
  用户按套餐映射到对应 level；
- UI 上必须标注**「近似限速：基于缓冲区大小，不是精确带宽」**，不能让人以为是精确值。

### 接口 / 前端

- 节点表单：`带宽上限（Mbps）`，0/空 = 不限；
- 套餐表单：`限速档位（Mbps，近似）`；
- 服务器列表/节点列表展示限速标记。

## P12：转发第一梯队（多跳 / 健康检查）

### 范围（有意收窄）

| 做 | 不做（下一轮） |
|---|---|
| 线性多跳链：入口 → 中转(1..n) → 出口 → 目标 | 组、分支、选路段、画布 |
| 每跳健康检查（TCP connect 目标） | 轮询/加权/最少连接等负载策略 |
| 不健康自动摘除、恢复自动加回 | 入口 DNS 多线路 |
| —— | 用户级「我的转发」 |

### 模型（0023_chains.sql）

```sql
CREATE TABLE chains (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    target_host TEXT NOT NULL, target_port INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, created_at, updated_at
);
CREATE TABLE chain_hops (          -- 按 seq 升序；seq=0 是入口
    chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, server_id TEXT NOT NULL,
    listen_port INTEGER NOT NULL,
    PRIMARY KEY (chain_id, seq)
);
```

**推导**：第 N 跳的 Agent 在 `listen_port` 监听，转发到第 N+1 跳服务器的地址 + 它的
`listen_port`；最后一跳转发到 `target_host:target_port`。主控把每条链推导成
各服务器上的若干 `DesiredForward`（复用现有转发下发通道，Agent 无需改动）。

### 健康检查与摘除

- Agent 已有的 TCP 探测复用它：对每条 forward 的目标做周期性 `connect`；
- 心跳的 `ForwardStatus` 增加 `target_ok: Option<bool>`（proto 增量，版本 +1）；
- 主控：某跳连续 2 次 `target_ok=false` → 该跳标 `degraded`，**链整体标 degraded**；
  恢复 → 自动清除。前端链列表与跳列表显示状态；
- 不做自动改路由（线性链没有备用路径），只做**可见的告警**——这是范围内最诚实的做法。

## P13：告警通知（Telegram + Webhook）

### 设置项（沿用现有白名单）

| key | 默认 | 说明 |
|---|---|---|
| `telegram_bot_token` | 空 | 空 = 不启用 |
| `telegram_chat_id` | 空 | 群或个人 id |
| `webhook_url` | 空 | POST JSON |
| `alert_events` | `server_offline,user_exhausted,chain_degraded` | 逗号分隔 |
| `alert_cooldown_secs` | `600` | 同类告警去抖 |

### 事件与去抖

去抖键 `(kind, target_id)`：冷却期内同一对象同一类只发一条，避免反复上下线刷屏。

### 投递

主控用 `curl` 子进程投递（与现有「回源 GitHub」一致，不引入 HTTP 客户端依赖）。
失败只 `tracing::warn!`，**绝不影响主流程**。

### 触发点

- 服务器离线（WS 断开）
- 用户因额度/过期被断流（enforcement 移除）
- 转发链降级（degraded 由 false → true）
- Agent 升级失败（超时巡检标记 failed）

### 接口

```
POST /api/v1/alerts/test   -> 向已配置的渠道发一条测试消息（管理员）
```

## P14：管理员 Telegram Bot（长轮询）

只做管理员 Bot，不做租户绑定；所有命令只对 `telegram_admin_chat_ids` 里的 chat 生效。
其它 chat 一律回 `未授权 / Unauthorized`，且授权判断发生在任何数据库读取之前。

### 设置项（沿用现有白名单）

| key | 默认 | 说明 |
|---|---|---|
| `telegram_bot_token` | 空 | 与告警共用同一个 token |
| `telegram_admin_chat_ids` | 空 | 逗号分隔，trim / 去重，最多 10 个；空 = 不授权 |
| `telegram_bot_enabled` | `false` | 布尔总开关；还要求 token 与管理员列表都非空 |

### 命令（纯文本，不设 `parse_mode`）

```
/status     服务器在线 x/y、节点数、今日流量、告警数
/servers    服务器列表：名称 / 在线 / 负载 / 延迟（最多 20 行）
/user <名>  套餐、已用/总量、到期、状态
/chain      转发链：名称 / 组数 / 成员数 / 是否降级
/help       命令列表；非法命令也回这里
```

- 单条消息超过 Telegram 的 4096 字符上限时截断，并追加 `已截断 / truncated`。
- 回复不含内部 id、异常堆栈；数据库错误只回「请稍后再试」。

### 实现

- `crates/master/src/telegram_bot.rs`：`getUpdates` 长轮询（`timeout=30`）+ 分发 +
  `sendMessage`，两者都走 `curl` 子进程；token / chat_id / 正文通过 `--config -`
  从 stdin 传入，**不进 argv**。
- offset 只存进程内存：重启后可能重复处理上一条命令，可接受。
- supervisor 在主控启动时拉起，每 30 秒读一次设置；`enabled=false`、token 或管理员
  列表清空时中止长轮询，配置变化时先 abort 旧任务（同时 kill curl）再起新任务。
- 所有错误只 `tracing::warn!`，不影响主控启动、WS、心跳等其它功能。

### 安全边界

- 如果 `telegram_admin_chat_ids` 填的是群 id，**群里每个人**都能执行这些只读管理命令；
  建议只填个人 chat id，或明确接受群成员的读取权限。
- bot token 一旦泄漏等于泄漏整套运维数据（设置表 / 数据库备份里都有它），
  轮换 token 时应同时在 BotFather 失效旧 token。
- 未授权回复本身也是对外可见行为；当前不做按 chat 的限流，异常流量由 Telegram
  侧的 bot 限流兜底。

### English summary

The admin Telegram bot long-polls `getUpdates` (timeout 30s) and only answers chat ids
listed in `telegram_admin_chat_ids`; every other chat gets `Unauthorized` without any
database access. Commands are `/status`, `/servers`, `/user <name>`, `/chain` and
`/help`, rendered as plain text (no Markdown parse mode), truncated at 4096 characters
with a `truncated` notice. Delivery uses a `curl` subprocess and the bot token travels
through `--config -` on stdin, never in argv. A supervisor task re-reads settings every
30 seconds and stops/restarts polling when the feature is disabled or reconfigured.

## P15：转发引擎（native / realm / 自研隧道）

### 结论先说

转发不再只有一种实现，而是**引擎可选**：

| 引擎 | TCP | UDP | 负载均衡 | 链路加密（ws/tls） | 状态精度 |
|---|:--:|:--:|:--:|:--:|---|
| `native`（现有） | ✅ | ✅ 同端口会话表（按客户端地址哈希） | ✅ 4 种策略 | ❌ | 端口级（listening / target_ok；UDP 的 target_ok 为未知） |
| `realm`（集成） | ✅ | ✅ `batched-udp` | ✅ roundrobin / iphash + 权重 | ✅ Kaminari ws/tls/wss | 进程级 + 端口探测 |
| `tunnel`（自研，规划） | ✅ | 规划 | 复用 native 策略 | ✅ 自己的加密 | 端口级 |

### 为什么用 realm 的「进程」而不是「库」

`realm_core` 已经发布到 crates.io，理论上可以嵌入。但它有三处与我们冲突：

1. **配置模型是 CLI 导向**（`Config`/`Endpoint`），我们的期望态是"链 → 组 → 成员 + 策略"，
   嵌入后要在两套模型间做映射，改一次策略要动两层；
2. **没有运行状态接口**：嵌入后我们能看到的也只是"它内部有没有 panic"，
   拿不到"哪个 endpoint 绑定失败"——这点用子进程也一样，但子进程至少崩溃隔离；
3. **feature 组合复杂**（transport/tls 后端/udp/balance），嵌入会把构建矩阵传染给 Agent。

所以：**realm 作为受管子进程**，与现有 Xray 的托管方式一致（同一个 supervisor 模型）。

### 状态从哪来（子进程没有 API 的解法）

- **绑定是否成功**：Agent 自己对 `0.0.0.0:port` 做一次 `bind` 尝试——
  成功说明 realm 没占到端口（失败态），`EADDRINUSE` 说明 realm 已绑定（正常态）。
  这是**不依赖 realm 内部**的可靠判据；
- **进程存活**：supervisor 直接知道退出码；
- **stderr 解析**：只用于在 `listening=false` 时补充原因（如 `Address already in use`）。

### 引擎选择放在哪

- 全局默认：设置项 `forward_engine`（`native` | `realm`），影响新建规则；
- 每条链/每条独立转发可覆盖：`engine` 字段（迁移 0028）；
- native 与 realm 的规则**不能共存于同一端口**（沿用现有端口冲突校验）。

### realm 的额外能力（我们直接获得）

- `batched-udp`：Linux 上 `recvmmsg`/`sendmmsg`，游戏场景的包速率远高于朴素 UDP 循环；
- `balance = "roundrobin: 4, 2, 1"`：带权重的组内分发；
- `listen_transport` / `remote_transport`：**跳与跳之间**可用 ws/tls 加密
  （Kaminari 选项），解决"中转链路裸奔"的问题；
- `through` / `interface`：指定出口网卡或源地址，多线服务器按线路出流量。

### 分阶段

1. **P15.1**：`engine` 字段 + realm 子进程 + 配置生成 + 端口级状态（TCP 先跑通）
2. **P15.2**：UDP 转发（realm `use_udp`）+ 会话超时透出
3. **P15.3**：链路的 hop-to-hop 加密（realm transport）
4. **P16（规划）**：自研加密隧道（自有协议、复用 native 的选路与状态模型）

### 不做的事

- 不把 realm 的 loader（从 URL 拉配置）接进来——配置只由主控生成；
- 不允许手写 realm 配置注入（那会绕过端口冲突校验）。

## P15.3：链路跳间加密（ws / tls）

> 版本锚点：realm **v2.9.6**（2026-08-30 发布）→ `realm_core` **0.5.1** → `kaminari` **0.14**
> （realm 的 `transport` feature；选项细节按 0.14.0 的源码核对）。本文的选项名、解析规则和能力判断都按这组版本核对过，
> 依据链接见 §11；换 realm 版本必须重新核对，不能假设兼容。

### 结论先说（TL;DR）

1. **加密只发生在 realm 的跳与跳之间**：第 i 组（服务器）的 realm 连第 i+1 组的 realm。
   客户端→入口、入口第一跳的本机监听、最后一跳→目标，都不属于 P15.3。
2. **不能做自签 CA**：realm 2.9.6 的 TLS **客户端没有自定义 CA / 信任根选项**，只信任编译进
   二进制的 Mozilla 根（`webpki-roots`）；自签证书只能配 `insecure` 跳过校验，等于没有身份认证
   （可被中间人）。**MVP 复用现有 `certificates` 里的公网 CA 证书**。
3. **一组一张证书**：同一跳组的所有成员共用同一张证书和私钥；上一跳的 `remote_transport`
   用该证书的域名做 `sni`。证书域名**不需要在运行时解析到那台服务器**——SNI 与 TCP 连接地址是
   两个东西，用 IP 直连也能通过校验（证书 SAN 里有这个名字即可）。
4. **UDP 不经过 transport**：realm 的 UDP 转发走独立路径，根本不看 transport；必须给每个
   加密端点写 `network = { use_udp = false }`，否则同一端口仍会**明文**转发 UDP。
5. **一律 fail closed**：证书缺失/过期/域名不匹配/能力不满足 → 整条链不下发并给出可见原因，
   **绝不静默回退明文**。旧 Agent 和 `realm-slim` 会忽略 transport 字段，必须靠能力协商挡住（§5.3）。
6. **ws 不是加密**，只是混淆；`wss` 也不是一个 token。本轮只做 TLS，ws/wss 留到有 CDN 前置
   需求时再做（写法见 §3.8，本期不生成）。

**English summary.** P15.3 encrypts only the realm-to-realm legs of a chain; the client-to-entry
leg, the first hop's listener and the final hop-to-target leg stay outside scope. realm 2.9.6's
TLS client has no custom trust anchor: it only trusts compiled-in Mozilla roots, so a private CA
would require `insecure` (no authentication) and is rejected. The MVP therefore reuses uploaded
public-CA certificates, one per hop group, with the group's domain as the dialer's `sni`. UDP never
goes through the transport, so encrypted endpoints must disable UDP explicitly. Every failure is
fail-closed: never silently fall back to plaintext.

### 1. 加密发生在哪一段（边界）

链的模型是「组 → 成员」：第 i 组的每台成员在自己的 `listen_port` 上监听，把流量交给第 i+1 组
的成员（由上一跳按策略选一台）；最后一组交给链的 `target_host:target_port`。realm 在每台成员
上各是一个 `[[endpoints]]`，`listen_transport` 管**这一跳的入**，`remote_transport` 管
**这一跳的出**。因此一条 n 组的链只有 **n−1 段**可加密：

```
client ──①──> 入口（Xray inbound / 客户端自己的协议）──②──> realm G0
realm G0 ──③──> realm G1 ──③──> ... ──③──> realm G(n-1)
realm G(n-1) ──④──> target
```

| 段 | 谁负责 | 本期 |
|---|---|---|
| ① 客户端 → 入口 | Xray 的 inbound（REALITY/TLS/WS）或客户端自身协议 | **不做** |
| ② 入口本机进程 → G0 的 `listen_port` | 本机回环 / 防火墙 | **不做**；要求只绑回环或网段 ACL |
| ③ G(i) 的 `remote` → G(i+1) 的 `listen` | realm `remote_transport` / `listen_transport` | **做**（TLS 单向） |
| ④ G(n−1) → 目标 | realm 明文转发 | **不做**；目标不是我们的，不能替它加 TLS |

硬性前提：

- `engine = realm`；`native` 引擎没有 transport，永远明文。
- 组数 ≥ 2；单跳链没有「跳间」，`hop_security = tls` 直接 400（`chain.tls_requires_two_hops`）。
- 一条链**整体**一种模式（`plaintext` / `tls`），本期不支持逐段混搭；逐段混搭只会让某一段
  静默错配（TLS 客户端连上明文监听），没有产品价值。
- `hop_security = tls` 时链的 `udp` 必须为 false：加密端点不转发 UDP，如果用户以为开了 UDP
  却只拿到 TCP，迟早会当成故障。保存时直接 400 `chain.tls_udp_unsupported`，不要静默忽略。
- 第 0 组的监听保持明文。它通常由同机 Xray 经回环访问；如果入口与实际发包方不在同一台机器，
  这一段不在 P15.3 内，需要靠防火墙或后续「Xray outbound 也走 TLS」解决。
- 最后一跳到目标是明文。目标若是 HTTPS，它自己的 TLS 仍保护载荷，但 SNI/域名对落地服务器的
  上游可见。

还要说清一个预期：**加密 ≠ 不可识别**。TLS 让载荷不可读、可校验完整性、能确认服务端身份；
但「长期连接某非标准端口、固定包长节奏」这类流量特征仍然在，**TLS 的 SNI/证书域名在握手时也是
明文可见的**。ws/wss 只是改变握手的形状，不等于隐蔽。P15.3 解决的是「裸 TCP 上什么都能看」，
不是「对抗全流量分析」。

**English summary.** With n groups there are exactly n−1 encryptable legs: each group's
`remote_transport` dials the next group's `listen_transport`. The client-to-entry leg, the entry
host's local hop-0 listener, and the final hop-to-target leg remain plaintext by design and are
out of scope. TLS hides payload and authenticates the server; it does not make the flow
unobservable.

### 2. 证书从哪来

#### 2.1 先把 realm 的能力钉死

realm 的 `listen_transport` / `remote_transport` 直接交给 kaminari 解析
（[`src/conf/endpoint.rs`](https://github.com/zhboner/realm/blob/v2.9.6/src/conf/endpoint.rs)）。
kaminari 0.14 的 TLS 配置长这样（[`opt.rs`](https://docs.rs/kaminari/0.14.0/src/kaminari/opt.rs.html)、
[`tls.rs`](https://docs.rs/kaminari/0.14.0/src/kaminari/tls.rs.html)）：

| 端 | 可用字段 | 没有的 |
|---|---|---|
| 服务端 | `cert`、`key`、`ocsp`、`servername`（只给 `servername` 时自动生成自签） | 自定义 CA、客户端证书 |
| 客户端 | `sni`（必填）、`alpn`、`insecure`（裸 token）、`0rtt`（裸 token） | **`ca=` / 信任根路径**、`server-name` |

客户端的验证器固定是 `WebPkiServerVerifier` + `webpki_roots::TLS_SERVER_ROOTS`（Mozilla 根）；
`insecure` 则换成 `SkipVerify`。服务端是 `with_no_client_auth()`，即**单向认证**。
**结论：realm 2.9.6 无法验证自签 CA。** 这不是配置写法问题，是库的 API 就没有这个旋钮。

如果未来要自签 CA，只有三条路：给 kaminari/realm 提 PR 增加 `ca=`（我们再升级 pin 的版本）；
自己维护一个 patched realm 构建（会把「realm 是受管子进程、二进制来自官方 Release」的假设打破，
还要承担多架构构建与签名）；或者等 P16 自研隧道。三条都不在本期。

#### 2.2 两种方案对比

| | A. 复用现有 `certificates`（公网 CA） | B. 主控自签 CA，Agent 落地 |
|---|---|---|
| 身份信任 | 浏览器/系统级公网根（realm 内置 Mozilla 根） | 自建根，需要 dialer 显式信任 |
| realm 2.9.6 支持 | ✅ 默认即可 | ❌ 无 CA 选项，只能用 `insecure`（无身份认证） |
| 域名/DNS | 签发时需要控制域名；**运行时不需要解析** | 不需要 |
| 轮换 | 手动上传新证书（ACME 未实现）；组内共享私钥 | 可自动签发/续期 |
| 私钥暴露面 | 已上传证书的私钥本来就在库/备份里；额外下发到**同组所有成员** | 每台一张，暴露面更小 |
| 过期影响 | 到期即握手失败，链断；需人工续期 | 可自动续期；CA 私钥在库里 |
| 运维成本 | 每跳组准备一张证书，90 天左右手动换 | 代码量大（X.509 签发、CA 存储、分发、轮换） |
| 本期结论 | **推荐 / MVP** | **不可安全实现，不做** |

#### 2.3 推荐

**A：复用现有 `certificates`。** 理由不是「省事」，而是它是当前 realm 下**唯一能同时做到
加密 + 服务端身份认证**的路径；B 的唯一实现方式是 `insecure`，那是「加密但不认证」，
比明文更危险——它会让人以为链路是可信的。

证书域名的选择：从证书的 DNS SAN 里选一个（存到 `chain_groups.tls_server_name`）。
它**不必**解析到那台服务器，也**不必**和 `server_address` 相同；realm 客户端把 `sni` 与 TCP
连接地址分开处理（`TlsConnect` 用 `sni` 建 `ServerName`，连接仍走 `remote` 的 IP:port）。

#### 2.4 公网证书的硬性要求

- 必须是**完整链 PEM**：leaf 在前，中间证书在后；只放 leaf 时 rustls 可能报 `UnknownIssuer`。
- 私钥必须是未加密的 PKCS#8 / RSA / SEC1（现有上传解析已拒绝加密私钥）。
- 必须有 **DNS SAN**；只有 CN 的旧证书不行（webpki 不认 CN）。IP SAN 不作为本期路径
  （`sni` 按 DNS 名解析，且公网 IP 证书少见）。
- 未过期；建议有效期余量 ≥ 30 天再启用。
- 通配符可用：`*.example.com` 能匹配 `hop1.example.com`，不能匹配 `a.b.example.com`。
  但 `tls_server_name` 必须是**具体主机名**，不能把 `*.example.com` 本身当 SNI 写进去。
- 同一组的**所有成员共用同一张证书和私钥**。这是多成员组 + 远端只有一个 `sni` 的必然结果；
  UI 必须明确提示「私钥会下发到本组每一台服务器」。

**English summary.** kaminari 0.14 exposes no client-side CA option: it verifies against compiled-in
Mozilla roots or skips verification entirely. A master-issued private CA is therefore impossible to
use securely with realm 2.9.6. The recommendation is to reuse existing uploaded public-CA
certificates: one certificate per hop group, deployed (including its private key) to every member of
that group, with a DNS SAN used as the next hop's `sni`. The name does not need to resolve at
runtime.

### 3. 配置怎么生成

#### 3.1 数据模型与线协议

迁移 `0031_hop_tls.sql`（只追加）：

```sql
-- 链级开关：plaintext（默认，行为不变）| tls
ALTER TABLE chains ADD COLUMN hop_security TEXT NOT NULL DEFAULT 'plaintext';

-- 每组的监听证书。seq = 0（入口组）必须为 NULL；其余组在 tls 模式下必填。
ALTER TABLE chain_groups ADD COLUMN cert_id TEXT;
-- 该组证书里选定的 DNS SAN，作为上一跳 remote_transport 的 sni。
ALTER TABLE chain_groups ADD COLUMN tls_server_name TEXT;

-- Agent 能力缓存：NULL = 未知（旧 Agent / 未上报）；1 = realm --version 带 [transport]；0 = 不支持。
ALTER TABLE servers ADD COLUMN realm_transport INTEGER;

-- 目标探测失败原因码（tls.*）；空串 = 没有原因。心跳把它和 target_ok 一起落库。
ALTER TABLE forward_status ADD COLUMN target_error TEXT NOT NULL DEFAULT '';
```

线协议 `PROTOCOL_VERSION` 11 → **12**，只加字段：

```rust
pub struct DesiredForward {
    // ... 现有字段
    #[serde(default)] pub listen_transport: Option<String>,  // None = 明文监听
    #[serde(default)] pub remote_transport: Option<String>,  // None = 明文出站
    /// 健康探测用：目标（下一跳）的 TLS SNI；None = TCP 探测。
    #[serde(default)] pub probe_tls_sni: Option<String>,
}

pub struct ForwardStatus {
    // ... 现有字段
    /// 目标探测失败的原因码，例如 tls.cert_expired（UI 查 i18n；未知码回落通用文案）。
    #[serde(default)] pub target_error: Option<String>,
}

pub struct Heartbeat {
    // ... 现有字段
    #[serde(default)] pub realm_transport: Option<bool>,
}

pub struct AgentHello {
    // ... 现有字段
    /// 12 起才有；旧 Agent 反序列化为 0。主控据此决定能不能下发 transport。
    #[serde(default)] pub protocol_version: u32,
}
```

为什么 transport 字符串由**主控**生成而不是 Agent：一条链的「下一跳是谁、SNI 是什么、证书
在哪台机器上」只有主控知道；Agent 只拿到自己这一跳的最终字符串，保持「期望态」模型不变。

链更新（PATCH）时必须按 `seq` 保留 `cert_id` / `tls_server_name`：现有更新路径会重建组成员，
如果只重建 members 而丢掉这两列，下一次 apply 会突然变成「缺证书」并把整条链停掉。

#### 3.2 每一跳生成什么

| 组 | `listen_transport` | `remote_transport` |
|---|---|---|
| 0（入口） | 不写（明文） | `tls;sni=<G1.tls_server_name>` |
| i（1 … n−2） | `tls;cert=<Gi.cert_path>;key=<Gi.key_path>` | `tls;sni=<G(i+1).tls_server_name>` |
| n−1（落地） | `tls;cert=<G(n-1).cert_path>;key=<G(n-1).key_path>` | 不写（明文到 target） |
| 明文链 | 不写 | 不写 |

证书路径复用 `pierwave_domain::certificate::cert_file_path` / `key_file_path`，即
`/usr/local/etc/xray/certs/{cert_id}.pem` 与 `.key`。同一张证书既被 Xray 节点引用、又被链引用时
只写一份（按 cert_id 去重）。

#### 3.3 具体 TOML 示例

一条 3 组链，证书域名分别是 `hop1.example.com`、`hop2.example.com`
（每台服务器各有一份完整的 realm.toml；下面只展示相关段落，`[network]`/`[log]` 全文件一份）：

**入口服务器（G0）**——只加密出口：

```toml
[network]
no_tcp = false
use_udp = true

[log]
level = "warn"
output = "stderr"

[[endpoints]]
listen = "0.0.0.0:30001"
remote = "203.0.113.10:30002"
remote_transport = "tls;sni=hop1.example.com"
network = { use_udp = false }
```

**中转服务器（G1）**——TLS 进、TLS 出：

```toml
[[endpoints]]
listen = "0.0.0.0:30002"
remote = "192.0.2.20:30003"
listen_transport = "tls;cert=/usr/local/etc/xray/certs/5f0c9a.pem;key=/usr/local/etc/xray/certs/5f0c9a.key"
remote_transport = "tls;sni=hop2.example.com"
network = { use_udp = false }
```

**落地服务器（G2）**——TLS 进、明文到目标：

```toml
[[endpoints]]
listen = "0.0.0.0:30003"
remote = "198.51.100.9:443"
listen_transport = "tls;cert=/usr/local/etc/xray/certs/9a1d44.pem;key=/usr/local/etc/xray/certs/9a1d44.key"
network = { use_udp = false }
```

`[log]` 只在「本机存在至少一个带 transport 的端点」时生成，避免没有加密规则的服务器在升级后
因为多了一行配置而重启 realm；`level = "warn"`、`output = "stderr"` 让 agent 的
`stderr(inherit)` 能收到绑定/accept 错误（realm 默认 `log.level = off`、输出 stdout，而 agent
把 stdout 设成了 `null`，不配这个等于**什么都看不到**）。

> 注意：realm 的**握手失败**在 `realm_core::tcp::middle` 里是 `log::debug!`
> （[源码](https://github.com/zhboner/realm/blob/v2.9.6/realm_core/src/tcp/middle.rs)），
> `warn` 看不到。Agent 加一个配置项 `realm_log_level`（默认 `warn`；排障时设 `debug`），
> 渲染进 `[log].level`。默认不要开 `debug`（每条连接一行，量大）；用户可见的失败原因由
> agent 的 TLS 探针负责（§6.2），不依赖 realm 日志。

#### 3.4 字符串语法与禁止写法

每个端点的值是一个用 `;` 分隔的 token 串；token 前后空白会被 trim，**值里不能有 `;`**。
`tls` / `ws` 是「开关 token」，必须精确等于 `tls` / `ws`；其余是 `key=value`。

| 目的 | 正确写法 | 说明 |
|---|---|---|
| 服务端证书 | `tls;cert=/path/cert.pem;key=/path/key.pem` | 两个都要有，缺一个 realm 会 panic 退出 |
| 客户端 SNI | `tls;sni=hop1.example.com` | **必填**；没有 `sni` 会 panic「tls: require sni」 |
| 服务端自签（禁用） | `tls;servername=example.com` | 是 `servername`，不是 `server-name`；禁用 |
| 客户端跳过校验（禁用） | `tls;sni=...;insecure` | 只认**裸 token** `insecure`，`insecure=true` 反而不生效；仍然禁用 |
| WebSocket | `ws;host=cdn.example.com;path=/ws` | host 与 path 都必填；两端一致 |
| WS over TLS | `tls;...;ws;host=...;path=...` | 同一个串里同时有 `tls` 和 `ws`，kaminari 组合成 Wss |

**必须避免的坑（会导致「以为加密了，其实没有」）：**

- ❌ `wss;host=...;path=...`：kaminari 没有 `wss` 这个 token，`has_opt` 只认精确的 `ws` 和
  `tls`。整串会被解析成「没有任何 transport」→ **静默明文**。这是本期最危险的写法，代码生成器
  必须禁止（我们的 builder 根本不会产出 `wss`）。
- ❌ `tls;server-name=...`：没有这个键。服务端只认 `servername`，客户端只认 `sni`。
  客户端写错会 panic；服务端若 cert/key 齐全则只是忽略这个键，**不会报错**，更不能靠运气。
- ❌ `tls;cert=...`（缺 key）或 `tls;sni=`（空值）：panic，realm 进程退出。
- ❌ `ws;host=...`（缺 path）：panic。
- ❌ 空串 / 只有空白：等于没有 transport（明文）。
- ❌ 把 `insecure` 当成选项值；或为了「先跑通」加 `insecure`。语义上它是「不验证服务端」，
  本项目的安全承诺不允许。
- ❌ `0rtt`：0-RTT 数据有重放风险，本期不用（kaminari 也只认裸 token `0rtt`）。

transport 串由 domain 层的 `TransportSpec` builder 生成（只有 `tls_server(cert,key)`、
`tls_client(sni)`、`ws_server(host,path)`、`ws_client(host,path)` 四个构造器），**不接受用户
自由文本**，也不允许从 API 直接透传。路径只允许 `[A-Za-z0-9/._-]`，SNI 只允许合法 DNS 名，
从根上消除 `;` 注入。

#### 3.5 「每一项都要一致吗？」

不要求整串相同，要求**每一段两侧配对兼容**：

| 检查 | 规则 |
|---|---|
| 协议 | 对同一条跳间链路，上文 G(i) 的 `remote_transport` 有 `tls`，下文 G(i+1) 的 `listen_transport` 也必须有 `tls`；否则握手必失败 |
| 证书 ↔ SNI | 监听端证书的 SAN 必须覆盖拨号端的 `sni`（支持通配符，大小写不敏感） |
| 证书链 | 拨号端只信 Mozilla 根；监听端必须给完整链 |
| WS | 两端 `host`、`path` 必须一致；两端都必填 |
| ALPN | 服务端没有配 ALPN，客户端不要写 `alpn=`；写了也可能协商不出协议，没有任何收益 |
| 认证方向 | 服务端 `with_no_client_auth()`，没有 mTLS；两端字符串里都不该出现客户端证书相关键 |
| 同一端点 | `listen_transport` 与 `remote_transport` 可以不同（入口通常「明文进、TLS 出」；落地「TLS 进、明文出」），这正是设计的一部分 |

#### 3.6 多成员组：一张组证书

第 i 组可能有 1..8 台成员，但上一跳的 **一个 endpoint 只有一个 `remote_transport`**，也就只有
一个 `sni`。因此：**第 i 组的所有成员必须装同一张证书**（同一个 cert_id），远端才能对任意一台
成员用同一个 SNI 校验通过。由此带来的约束写进 UI 文案：

- 该证书的私钥会下发到本组每一台服务器；任何一台成员被攻破都等于拿到本组监听的私钥。
- 不支持「每台成员一张自己的证书」；如果必须，组只能留 1 台（这不是限制，是 realm 的模型边界）。

#### 3.7 渲染细节

- 每个 endpoint 的键顺序固定：`listen`、`remote`、`extra_remotes`、`balance`、
  `listen_transport`、`remote_transport`、`network`。同一组规则重复渲染必须逐字节一致
  （现有的内容哈希/重启抑制依赖这一点）。
- 所有字符串走现有的 TOML 转义；transport 串本身再做一次字符白名单校验。
- 带 transport 的端点追加 `network = { use_udp = false }`。realm 的配置合并逻辑是
  「endpoint 自己有的不继承全局」（`take_field`），所以这一行能精确关掉该端点的 UDP，
  不影响同机其它明文转发规则的 UDP。
- realm 是**一个进程一份配置**：改一条链的 transport 会让这台服务器上所有 realm endpoint
  一起重启。证书轮换、加跳、改 SNI 都会造成该服务器上所有 realm 链路短暂中断；这个代价要在
  UI/文档里写明。
- `[log]` 的位置在所有 endpoint 之前；`[network]` 保持现状。

#### 3.8 ws / wss（本期只留参考，不实现）

```toml
# ws（无加密，仅混淆；P15.4 再评估）
listen_transport = "ws;host=cdn.example.com;path=/ws"
remote_transport = "ws;host=cdn.example.com;path=/ws"

# wss = tls + ws 同一个串；不是 "wss;"
listen_transport = "tls;cert=/path/cert.pem;key=/path/key.pem;ws;host=cdn.example.com;path=/ws"
remote_transport = "tls;sni=cdn.example.com;ws;host=cdn.example.com;path=/ws"
```

**English summary.** The master derives per-hop transport strings from the chain groups and ships
them in `DesiredForward` (protocol v12). Each group except the entry needs one certificate; the
group's chosen DNS SAN becomes the previous hop's `tls;sni=`. The generated realm config uses only
`tls;cert=...;key=...` on listeners and `tls;sni=...` on dialers, adds per-endpoint
`network = { use_udp = false }`, and enables warn-level stderr logging only when transports exist.
A literal `wss;...` token is a silent-plaintext trap: kaminari only recognises exact `ws` and `tls`
tokens, and wss is the combination of both.

### 4. 证书分发与轮换

#### 4.1 路径与权限

复用现有 `ManagedFile` 与证书路径：

| 文件 | 路径 | 权限 |
|---|---|---|
| 证书链 | `/usr/local/etc/xray/certs/{cert_id}.pem` | `0644` |
| 私钥 | `/usr/local/etc/xray/certs/{cert_id}.key` | `0600` |

`DesiredState.files` 由 `desired::render` 装配：原来只收集「节点引用的证书」，现在再加
「本服务器所属链组（seq ≥ 1）引用的证书」，按 cert_id 去重。上一跳**不需要**证书文件，
只需要 SNI 字符串。

#### 4.2 现有实现的两个缺口（必须先补）

1. **`ManagedFile.mode` 现在被忽略**：`crates/agent/src/main.rs::apply_files` 只做
   `write(tmp) → rename`，不 `set_permissions`。私钥会按 umask 落成 `0644` 甚至更宽。
   P15.3 必须改成「以目标 mode 创建临时文件（`OpenOptionsExt::mode`，避免写入窗口期可读）→
   `set_permissions` 校正 → `sync_all` → rename」，并加测试。
2. **顺序错了**：`apply_state` 现在是「先 `forwards.apply`（realm 重启）→ 再 `apply_files`」。
   证书轮换时 realm 会拿着**还没写下去的新路径**启动，直接 panic。必须改成
   **`apply_files` → `forwards.apply` → xray apply**；文件写失败就整轮 apply 失败、不碰 realm。
   这样旧的 realm 进程继续用旧证书跑，链不中断。

#### 4.3 原子替换与轮换

- 证书行是不可变的：轮换 = 上传新证书（新 id）→ 改组的 `cert_id` → 新路径。
  因此**不会原地覆盖**正在被 realm 读的文件；新旧文件自然共存。
- Agent 写文件用「同目录临时文件 + rename」，rename 前 chmod + fsync；rename 是原子的。
- 轮换流程：主控 apply（新路径 + 新 SNI 如有）→ Agent 写文件 → realm 配置哈希变化 → 重启 →
  探针确认新证书握手成功。上一跳只有在 SNI 变化时才需要改配置；同一域名换证书时上一跳
  无感，这是公网 CA + 稳定 SNI 带来的好处。
- 旧文件不会自动删除（Agent 现在没有 prune 机制）。它们是历史私钥，留在磁盘上属可控风险；
  彻底清理放 P15.4，做「只删 `/usr/local/etc/xray/certs/` 下不在当前 desired 集合里的文件」
  的白名单式 GC，且必须排除 Xray 仍在引用的证书。
- 没有 ACME：到期前必须人工上传新证书。面板已有 `days_left` 与 `expiring_certs` 告警
  （按 `certificates.not_after` 统计，天然覆盖链证书），P15.3 再在链详情里显示到期日。

#### 4.4 私钥暴露面

- 证书私钥本来就在 SQLite（备份即包含）；链组会把它复制到同组每台成员的磁盘。
- CA 私钥不存在（没有自签 CA），所以没有「一把根钥匙泄漏全盘皆输」的问题；但一张组证书
  泄漏 = 可以冒充该组监听端。
- realm 配置里只有路径，没有密钥内容；日志里只允许出现路径和指纹。

**English summary.** Chain certificates reuse the existing `ManagedFile` pipeline and the
`/usr/local/etc/xray/certs/{id}.{pem,key}` paths. Two fixes are mandatory before shipping: honour
`ManagedFile.mode` (0600 keys) and write files **before** restarting realm, otherwise a rotation
starts realm with paths that do not exist yet. Rotation uses a new certificate row and a new path,
so files are never overwritten in place; old files are left for a later whitelist GC.

### 5. 失败与降级

#### 5.1 策略：fail closed，不降级明文

**推荐并且只允许 fail closed。** 理由：

1. 静默降级会把「以为加密」变成「其实明文」，比直接不可用更危险；
2. 降级不可观测：用户只会看到能用，不会知道公网链路已经裸奔；
3. 明文是一个**显式**选项（`hop_security = plaintext`，UI 上可见），不需要偷偷做。

#### 5.2 各种失败下的行为

| 场景 | 主控 | Agent | 用户看到 |
|---|---|---|---|
| 保存链时缺证书/域名不匹配/证书过期 | 400 + 具体 code，不落库 | 不下发 | 表单内联错误 |
| 保存时某成员服务器 `realm_transport != true`（旧 Agent / slim realm） | 400：旧 Agent 用 `chain.tls_agent_unsupported`，realm 缺 transport 用 `chain.tls_realm_unsupported`，列出服务器 | 不下发 | 表单错误 + 「升级 Agent / 换官方 realm」 |
| 保存后证书过期 | 下次 apply 时**整条链**跳过（不是跳过某一跳），连同它的证书文件一起不进 `files`；`warnings` 里说明；链详情 `blocked_reason` | 该链所有监听被收敛掉（链断） | 链状态「未下发：证书已过期」 |
| 运行中证书到期 | 不自动改配置；心跳/探针发现握手失败 | TLS 探针 `target_ok=false`，连续 2 次标 degraded | 链「降级」+ 告警（P13 `chain_degraded`） |
| 证书文件写失败 | apply 失败，返回错误 | 不重启 realm，旧监听继续用旧文件 | apply 报错，链保持旧状态 |
| realm 读到坏证书/缺文件 | — | realm panic 退出，所有 realm 规则 `listening=false`，error 带退出码 | 该服务器所有 realm 链不可用；日志有 panic 原因 |
| 旧 Agent 收到 transport 字段 | 能力门禁挡住，不下发 | （不会被下发） | 不会出现「面板说加密、实际明文」 |
| 某跳 TLS 握手失败 | — | 上一跳探针失败 → 该成员 degraded；主控告警 | 连接超时/重置；链状态降级；日志有原因 |
| UDP 打到加密端口 | — | 端点 `use_udp=false`，没有 UDP 监听 | 无响应（不是明文转发） |

#### 5.3 能力协商（这条不做，整套加密就是假的）

有两个「静默明文」来源，必须同时挡住：

1. **旧 Agent**：`DesiredForward` 新增的 `listen_transport`/`remote_transport` 对旧 Agent 是
   未知字段，serde 默认忽略；它会照常生成没有 transport 的 realm.toml → 明文。
2. **slim realm**：`realm-slim-*` 资产没有 `transport` feature。`EndpointConf` 的字段仍然能
   反序列化，但 `build_transport` 不编译，配置被**静默忽略** → 明文。官方默认资产有
   transport，`install.sh` 装的是默认资产；但用户可能手动装 slim/旧版。

门禁分三层：

- **Agent 启动时**跑 `realm --version`（带 1–2s 超时），输出形如
  `2.9.6 [brutal][batched-udp][proxy][balance][transport][multi-thread]`（realm 的
  `--version` 把 `FEATURES` 一起打印），包含 `[transport]` 才上报 `realm_transport = true`；
  反之 false；命令失败/文件不存在 → `None`。缓存按二进制 `(path, mtime, size)` 失效，
  或**每次准备写 transport 配置前重测**（apply 不频繁，spawn 一次 `--version` 的成本可以接受），
  避免「运行中换掉二进制」后缓存仍为 true。
- **Agent hello** 带 `protocol_version = 12`。主控收到 `< 12` 的 hello 时，立即把该服务器的
  `realm_transport` 置 NULL，并在本次下发里**剥掉所有 TLS 链**。这堵住「新 Agent 被换回旧
  二进制，但数据库里还留着旧 true」的窗口。
- **每次 render/apply** 重新检查 `servers.realm_transport == Some(true)`；未知一律视为不支持。
  链保存时检查全部成员服务器，未知直接 400，不要「先存下再说」。
- **Agent 侧的防御**：即使主控因为数据库里的旧 true 而发来了 transport，只要 Agent 自己
  `realm --version` 判定 `realm_transport = false`，`RealmSupervisor` 必须拒绝把这些规则渲染成
  **不带 transport 的明文配置**：报 apply 错误 / 保持旧进程，状态写「realm 不支持 transport」。
  这条是兜底，防止「重连后第一条心跳之前」的 15 秒窗口被 slim realm 变成静默明文。

上线顺序：**先升主控**（此阶段不下发任何 transport）→ **再升完全部 Agent**，等每台心跳都上报
`realm_transport = true` → **最后才允许把链改成 `tls`**。反过来做会被能力门禁挡住，不会造成
明文，但会让用户困惑「为什么保存不了」。

补发窗口：Agent 重连时主控在收到第一条心跳**之前**就会补发期望态。如果能力还是 NULL，
TLS 链会被跳过；等心跳把它写成 true 后并不会自动再发一次。所以：心跳使
`realm_transport` 发生 `NULL→true` 或 `true→false` 跃迁时，**标脏该服务器**（复用现有 30s
去抖），让期望态自动重算，不需要用户手动再点一次「应用配置」。

#### 5.4 过期

- 证书 `not_after` 是绝对时刻；不引入自动续期。
- 面板已有 30 天告警（`repo::certificates::count_expiring`），链详情显示到期日。
- 运行中到期不自动改配置：TLS 握手失败 → 探针降级 → 告警；下一次 apply 时链被跳过并给出
  `warnings`。两种情况都不会回退明文。

**English summary.** Every failure is fail-closed: missing, expired, mismatched, unsupported or
legacy conditions remove the whole chain (or reject the request) and never downgrade to plaintext.
Silent downgrades are real: old agents ignore unknown transport fields and slim realm builds ignore
transports entirely. Three gates prevent this: `realm --version` must report `[transport]`,
`AgentHello.protocol_version` must be 12, and every render re-checks the cached capability.

### 6. 可观测性

#### 6.1 用户看到什么

- **保存时**：表单内联错误（code + 中文），例如「第 2 组缺少证书」「证书 `hop1.example.com`
  已过期」「服务器 A、B 的 Agent 不支持跳间加密」。
- **apply 时**：`warnings` 里一条「链『X』未下发：…」；链列表/详情显示 `blocked_reason`。
- **运行时**：链状态 `degraded`，成员行显示 `target_error`（如「证书已过期」「证书不受信任
  （链不完整或非公网 CA）」「证书域名与 SNI 不匹配」「无法连接」）；P13 的链降级告警。
- **客户端侧**：链路仍在下发时，入口端口还能 TCP 连接，但数据过不去（超时/连接被重置）——
  入口只负责转发，TLS 失败发生在下一跳；精确原因在面板和日志里。若链已被 fail-closed
  收敛掉，则是连接直接被拒。

#### 6.2 主动探测：把「监听中」和「能握手」分开

现状有两个洞：native 的健康探测只做 TCP connect（`crates/agent/src/probe.rs`）；
**realm 规则根本不做目标探测**（`RealmSupervisor` 只做 bind 探测，`target_ok` 恒为 `None`）。
所以 TLS 配错时，加密链会显示 `listening=true`、`target_ok=null`，面板一片绿、实际全断。
P15.3 必须补：

- 在 **realm supervisor** 里，对 `probe_tls_sni = Some(sni)` 的规则启动周期性探测：
  对每个目标（下一跳成员）做 **TLS 握手**，验证用与 realm 相同的 Mozilla 根
  （agent 引入 `rustls`（`ring` backend）+ `webpki-roots`，不开 `aws-lc` 以避免 musl
  构建负担）。native 的既有探测路径不动。
- 成功：`target_ok=true` + 握手耗时；失败：`target_ok=false` + `target_error` 错误码
  （`tls.cert_expired` / `tls.unknown_issuer` / `tls.hostname_mismatch` /
  `tls.connect_failed` / `tls.handshake_failed`），由前端翻译，agent 不拼人类文案。
- 探测频率沿用 30s；上一跳对每个下一跳成员各测一次，因此多成员组能快速暴露坏成员。
  **注意：realm 没有健康检查 API，`balance` 仍会按 roundrobin/iphash 把流量发给坏成员；
  探针只负责告警与展示，不负责自动摘除。** 真正的健康感知选路属于 P16 自研隧道（或回到
  native，但没有加密）。多成员组在 TLS 链里仍有容灾价值（客户端重试可能命中健康成员），
  但不能在 UI 上承诺「自动切换」。
- 探针失败 ≠ 监听失败：继续保留 `listening` 的独立判据；apply 时的 bind 探测结果与周期探针
  结果必须**合并**（listening 由 bind 写、target_ok/target_error 由探针写），不能互相覆盖；
  配置变化/规则删除时同步取消旧探测任务，避免旧任务把状态写回新规则。

#### 6.3 日志记什么

| 位置 | 内容 | 不记 |
|---|---|---|
| master | 链 render 决策、跳过原因、证书指纹（sha256 前 12 位）、组/跳、SNI、目标地址 | 私钥、PEM 内容 |
| agent | realm 配置哈希、endpoint 数、transport 种类（tls/plain）、证书路径、realm 退出码；TLS 探针**状态跃迁**时一条 warn（目标、SNI、错误码） | 私钥、完整 transport 串（可含路径，但没必要） |
| realm | `[log]`：绑定/accept 错误在 `warn`；**单连接握手失败在 `debug`**；排障时把 `realm_log_level` 调成 `debug` | — |

realm 的 `stderr` 已经 `inherit` 到 agent；现在缺的是 `[log]` 段。没有它，realm 默认
`level=off` 且输出 stdout（agent 把 stdout 丢了），**连绑定错误都看不到**。但不要把用户可见
状态建立在 realm 日志上：握手失败是 debug 级、版本一换文案就会变；状态由 TLS 探针负责，
journal 里的 realm 日志只给人排障用。

#### 6.4 新增错误码（同时更新 `docs/ERRORS.md` 与 i18n）

| code | 中文兜底 | params |
|---|---|---|
| `chain.tls_requires_realm` | 只有 realm 引擎的链才能启用跳间加密 | — |
| `chain.tls_requires_two_hops` | 至少两跳的链才有跳间链路 | — |
| `chain.tls_udp_unsupported` | 加密链不支持 UDP，请关闭该链的 UDP | — |
| `chain.tls_group_cert_required` | 第 {seq} 组缺少证书 | seq |
| `chain.tls_group_cert_forbidden` | 入口组不需要证书 | — |
| `chain.tls_cert_expired` | 证书已过期 | name, not_after |
| `chain.tls_cert_domain_invalid` | 域名 {domain} 不在证书 SAN 中 | domain |
| `chain.tls_cert_no_dns_san` | 证书没有 DNS SAN，不能用于跳间 TLS | — |
| `chain.tls_agent_unsupported` | 以下服务器不支持跳间加密：{servers} | servers |
| `chain.tls_realm_unsupported` | 以下服务器的 realm 未启用 transport：{servers} | servers |

`certificate.in_use` 的引用计数要加上链组：删除仍被链引用的证书 → 400，提示「被 N 个节点、
M 条链引用」。

`target_error` 不是 `AppError`，但它同样是给用户看的文案来源；词条放进同一个 `errors.*`
词典（中英各一份），前端遇到未知码回落到「目标不可达 / target unreachable」，绝不直接显示码。

**English summary.** Users get precise errors at save time and a `blocked_reason`/degraded state at
runtime; the client itself only sees a timeout. A new TLS health probe (same Mozilla roots as realm)
turns `target_ok` into a real handshake check and reports `target_error` such as expired,
untrusted or hostname-mismatched certificates. realm logging must be enabled explicitly
(`[log] level=warn output=stderr`), otherwise handshake failures are invisible. New error codes are
listed for both the error registry and the i18n dictionaries.

### 7. MVP：TLS 单向 + 公网证书（推荐）

| 方案 | 机密性 | 完整性 | 服务端身份 | DPI 对抗 | 前置条件 | 结论 |
|---|---|---|---|---|---|---|
| **TLS + 公网证书** | ✅ | ✅ | ✅ | 中（流量特征仍在） | 每组一张可用公网证书 | **MVP** |
| TLS + 自签 + `insecure` | ✅ | ✅ | ❌ 可被中间人 | 中 | 无 | **不做**（伪安全） |
| 仅 ws | ❌ | ❌ | ❌ | 弱（只是换个握手形状） | 无 | **不做**（不满足目标） |
| wss（tls+ws） | ✅ | ✅ | ✅ | 中 | 公网证书 + CDN/域名前置 | P15.4 |

**MVP 一句话**：只对 `engine = realm` 且 ≥2 组的链，用现有 `certificates` 里的公网证书做跳间
**单向 TLS**（每组一张、组内成员共用），加密端点关 UDP；证书/能力不满足时**整链拒绝下发**，
绝不回退明文。

为什么不是 ws：它不提供机密性、完整性和身份认证，只改变握手形状；「公网链路上可被识别」的
问题它只解决表面一层。为什么不是自签 CA：realm 的 TLS 客户端没有自定义信任根，只能 `insecure`，
那等于把「防中间人」这件事删掉。

单向 TLS 的已知代价：监听端只验证服务端、不验证客户端（realm 服务端固定
`with_no_client_auth`），所以**任何能连到该端口的人都能把它当跳板**。当前明文转发本来也是
开放的，P15.3 不会让它更糟，但也不要在文案里暗示「已经安全」；真正的访问控制要靠防火墙
（只允许上一跳的出口 IP）或后续 mTLS/自研隧道。这一条必须写进 UI 提示与 DEPLOY。

**English summary.** The MVP is one-way TLS with existing public-CA certificates, one per group,
with UDP disabled on encrypted endpoints and fail-closed behaviour. Self-signed TLS plus
`insecure` is rejected because it provides no server authentication; ws alone provides no
confidentiality at all. One-way TLS still leaves each listener an open relay for anyone who can
reach it, so firewall allow-listing or later mTLS is required.

### 8. 测试策略

#### 8.1 纯函数 / 单元测试（不碰网络）

- `TransportSpec`：四种构造器输出逐字节固定；`tls_server` 缺 key、`tls_client` 无 sni、
  含 `;`/换行/空白的输入被拒绝；`wss` 永不出现。
- SNI 校验：精确匹配、大小写、通配符、单层/多层子域、IP 字面量拒绝。
- 证书校验：过期边界（`not_after == now`）、无 DNS SAN、域名不在 SAN、证书与私钥不匹配
  （复用现有 `certificate::parse`）。
- 链规则：native 引擎拒绝、1 组拒绝、组 0 带证书拒绝、多成员组允许、缺失证书拒绝。
- 生成映射：2 组 / 3 组 / 多成员组，逐跳断言 `listen_transport` / `remote_transport` 的有无与内容。

#### 8.2 主控（内存 SQLite + HTTP）

- `desired::render` 的 golden：入口只有 remote、中转两者都有、落地只有 listen；明文链两者都无。
- 证书文件装配：只在组成员服务器上出现、按 id 去重、mode 正确；不泄漏 key 到响应。
- 失败路径：证书过期 → 整链不在 forwards 里 + warnings 一条；能力 false/未知 → 同上；
  旧 protocol hello → 剥离 TLS 链。
- 证书删除保护：被链组引用时 400；解除引用后可删。
- 表单校验：400 code/params 与 i18n 键存在（错误码表同步测试）。

#### 8.3 Agent

- `render_config` golden：含 transport 行、`network = { use_udp = false }`、`[log]`；
  顺序稳定；无 TLS 规则时不生成 `[log]`（避免无谓重启）。
- `apply_files`：unix 下私钥文件 mode 必须是 0600；写入失败时不重启 realm；文件先于
  forwards 的顺序用可注入的失败点测试。
- 能力探测：假 realm 脚本输出带/不带 `[transport]` 的 `--version`，断言上报值；当能力为 false
  且期望态里出现 transport 时，断言 agent **报错而不是渲染明文**（防御性测试）。
- TLS 探针：本地起一个自签 TLS 监听，断言 `target_ok=false` 且 `target_error` 是
  「证书不受信任」类；本地明文监听断言 TCP 路径不受影响；错误映射单测覆盖
  `CertExpired`/`UnknownIssuer`/`NotValidForName`。

#### 8.4 真实 realm 的 CI（可行，但有边界）

**可行**：GitHub Actions 的 Linux x86_64 runner 下载 pin 死的 realm v2.9.6 默认资产
（与 `install.sh` 相同的 sha256），跑：

1. **监听端正向**：realm endpoint A = TLS listener（测试用自签证书），
   `openssl s_client -connect 127.0.0.1:port -servername test.local -verify_return_error`
   不带 CA 时应按预期失败，`-CAfile` 指定自签根时应成功并打印证书——证明 listener 真的在
   做 TLS 且用对了证书。
2. **客户端校验负向**：realm endpoint B = 明文监听 + `remote_transport = "tls;sni=test.local"`，
   remote 指向一个自签 TLS 服务；客户端连 B 发数据，应被断开（`UnknownIssuer`），证明 realm
   客户端**确实在校验**而不是静默明文。
3. **UDP 关闭**：全局 `use_udp = true` + 端点 `network = { use_udp = false }`；向端口发 UDP
   包无响应，`ss -lun` 不出现该端口。
4. **能力/版本**：`realm --version` 输出包含 `[transport]`；对 slim 资产（可选）断言不包含，
   用于验证门禁文案。
5. **配置形状**：用生成的配置（证书文件就位）启动 realm，断言进程不因语法/未知键立刻退出；
   再删掉证书文件重启，断言进程退出并留下可读错误（证明失败是响亮的，不是静默明文）。

**不可行/不能做成 hermetic 的**：realm 客户端只信 Mozilla 根，CI 里**无法**用自签证书做
「客户端验证通过」的正向测试（除非发一个公网可信证书，TLS 也要求私钥，不能进仓库）。
所以：

- 「客户端验证通过」的完整链路放到**双机手工验收**（§8.5），用真实域名证书；
- CI 只覆盖「监听端 TLS 正确」「客户端验证确实开启」「配置合法」「UDP 关闭」「能力探测」；
- 如果哪天给 realm 打了 `ca=` 补丁，才可以把自签正向测试搬进 CI。

#### 8.5 双机手工验收（发版前必做）

- 两台 VPS + 一张真实域名证书（或通配符），建 2 组链，`hop_security = tls`；
- 入口用该链访问一个 TCP 回显/HTTP 目标，确认可用；
- 在入口 `openssl s_client -connect <中转>:<port> -servername <domain>` 成功，证书域名正确；
- `tcpdump -i any -A port <中转端口>` 看不到明文 HTTP/业务字节；
- 改错 SNI / 换成过期证书：链在 30–60s 内变 degraded，日志出现 handshake 错误，**没有明文回退**；
- 只留 UDP：确认加密端口不响应 UDP；
- 把中转 Agent 换回旧版本：面板在重连后拒绝下发 TLS 链（能力门禁生效），而不是明文继续跑。

**English summary.** Unit and HTTP tests cover the deterministic parts (transport strings, mapping,
expiry, capability gating, file modes and ordering). Real-realm CI can verify the TLS listener, the
fact that the realm client rejects a self-signed certificate, UDP being off, and the version
capability check. A fully verified client handshake needs a publicly trusted certificate that
cannot live in CI, so that case stays a two-host manual acceptance test.

### 9. 任务书（每步可验收）

| # | 工作 | 规模 | 验收 |
|---|---|---|---|
| 0 | **运行时契约钉死**：起 realm v2.9.6，验证 `--version` 的 `[transport]`、`tls;cert/key` 监听、`tls;sni` 客户端、入口「明文进/TLS 出」与落地「TLS 进/明文出」的不对称端点、`wss;` 的静默明文、每端点 `use_udp=false`、`[log]` 的 warn/debug 边界 | S（0.5d） | 一份可复现的命令记录（回填本文 §11），结论与本方案一致；不一致先停下来改方案 |
| 1 | 迁移 `0031_hop_tls.sql` + domain models/repo 字段（`hop_security`、`cert_id`、`tls_server_name`、`servers.realm_transport`、`forward_status.target_error`） | M | 旧库升级后默认 `plaintext`，现有链的下发结果逐字节不变；迁移测试与 repo 测试通过 |
| 2 | domain `hop_transport`：`TransportSpec` builder、SNI/证书/通配符/过期校验、链前置规则 | M | §8.1 全部单测；无网络、无 DB |
| 3 | proto v12：`DesiredForward.listen_transport/remote_transport/probe_tls_sni`、`ForwardStatus.target_error`、`Heartbeat.realm_transport`、`AgentHello.protocol_version` | M | 旧 JSON 反序列化为 `None/0`；新字段往返；`PROTOCOL_VERSION == 12` 断言 |
| 4 | master 推导与下发：逐跳 transport、组成员证书进 `files`、证书删除保护、能力门禁、过期/缺失整链跳过、`warnings`、`blocked_reason` | L | §8.2 全部测试；2/3 组 golden；过期/未知/旧协议都不产生明文；无证书时不生成任何 transport |
| 5 | agent 渲染与落盘：transport 行、`network use_udp=false`、条件 `[log]` + `realm_log_level`、`ManagedFile.mode`、files-before-realm、`realm_transport` 能力探测与「不支持时拒绝明文渲染」 | L | §8.3 渲染/权限/顺序/能力测试；`make check` 绿 |
| 6 | agent TLS 探针：在 realm supervisor 侧对 `probe_tls_sni` 规则走 rustls 握手、错误映射、`target_error` 上报（native 探测不动） | M | 自签负向测试；明文路径无回归；degraded 计数与告警沿用现有逻辑 |
| 7 | API + 前端：链表单 `hop_security`、每组证书/域名选择、共享私钥/到期提示、`blocked_reason`/`target_error` 展示、i18n 中英 | M | 表单能阻止非法组合；错误码双语；链列表四态不回归 |
| 8 | 测试与 CI：真实 realm 用例（§8.4）、golden、`make check` | M | CI 用例除下载 pin 死的 realm 资产外不依赖外网；失败信息可读 |
| 9 | 双机验收 + 文档：DEPLOY 段、回滚说明、`make check` | S | §8.5 全过；未加密链路/旧数据回归通过；不提交、不发版 |

依赖顺序：0 → 1/2/3 可并行 → 4 → 5 → 6 → 7 → 8 → 9。第 0 步是硬门禁：结论不成立就停止，
不要带着「可能不支持」的假设写代码。

**English summary.** Step 0 pins the runtime contract before any code. Steps 1–3 add schema,
domain builders and protocol fields; step 4 derives transports in master; step 5 renders and writes
them safely in the agent; step 6 adds real handshake health checks; step 7 exposes the minimum UI
and bilingual errors; steps 8–9 provide CI and two-host acceptance. Every step has a concrete
acceptance criterion, and the sequence is gated on step 0.

### 10. 不做什么（本期范围边界）

- **不做自签 CA / 自定义信任根**：realm 2.9.6 的客户端没有这个能力，`insecure` 明确禁止。
- **不做 ws / wss**：ws 不加密；wss 等 CDN 前置需求明确后再做（写法已记录，本期不生成）。
- **不加密**客户端→入口、入口本机→G0、最后一跳→目标这三段。
- **不做 UDP over TLS**：加密端点 `use_udp=false`，这些端口不转发 UDP；不引入第二个 realm 进程。
- **不做 mTLS / 客户端证书**：监听端仍是开放中继，访问控制交给防火墙或 P16。
- **不做 ACME / 自动续期**：证书仍手动上传；到期即断链，只告警不自动换。
- **不做多成员组各自独立证书**：远端只有一个 `sni`，同组必须共用一张证书。
- **不做证书吊销/CRL/OCSP**。
- **不做 CA/证书轮换的零停机编排**：realm 进程重启会短暂中断该服务器所有 realm 链。
- **不做 realm 配置的自动回滚**：新配置启动失败就保持错误状态，修正后重新 apply；不要偷偷
  跑回旧配置（会让面板状态与磁盘不一致）。
- **不做 realm 自动升级**，也不接受用户手写 transport 串（绕过校验）。
- **不做「加密后自动降级明文」**，任何情况都不。
- **不做全链路端到端探测**：只做「上一跳→下一跳」的 TLS 探针；最后一跳到目标仍按现有 TCP 探测。

**English summary.** The scope excludes private CAs, ws/wss, client-side and last-mile encryption,
UDP-over-TLS, mTLS, ACME, per-member certificates, revocation, zero-downtime realm restarts, realm
auto-upgrade, plaintext downgrade, and full end-to-end chain probing.

### 11. 风险、待确认与依据

**三个最大风险：**

1. **公网证书的运维成本**：没有 ACME，90 天左右必须人工换；忘记换 = 链断。缓解：30 天告警、
   链详情到期日、apply 前预检、文档写清「到期不会回退明文」。
2. **静默明文**：旧 Agent / `realm-slim` / 写错 `wss;` 都会得到「看起来配了、实际明文」。
   缓解：三层能力门禁 + `wss` 永不生成 + CI 负向用例 + 日志打印 transport 种类。
   这是本期最需要测试兜底的风险。
3. **UDP 明文穿透**：realm 的 UDP 路径完全不看 transport；如果 `network = { use_udp = false }`
   的端点级覆盖在某版本上失效，同一个端口会继续明文转发 UDP。缓解：第 0 步用 UDP 包验证；
   CI 固化；必要时退化为「整份配置 `use_udp = false`」（代价是同机明文规则也没有 UDP，需在
   UI 明示）。

**其它需要注意的：**

- **realm 的信任根会随版本变**：客户端只信编译进二进制的 Mozilla 根；极老的根或私有 CA
  都会被拒。升级 realm 后要重跑 TLS 用例。
- **单向认证 = 开放中继**：任何能连到监听端口的人都能用这条链；必须配防火墙。
- **realm 单进程**：一次配置变化重启该服务器所有 realm 端点，所有链短暂中断。
- **多成员组共享私钥**：一台成员被攻破 = 该组监听身份泄露。
- **TLS 握手开销**：每条新 TCP 连接多一次握手 RTT；短连接场景吞吐/延迟会受影响，双机验收
  要记录基线。
- **服务器时钟**：证书有效期校验依赖系统时间；成员服务器必须开 NTP，时钟漂移会让「证书明明
  没过期」变成握手失败。
- **探针与 realm 的信任根一致性**：agent 探针必须用 `webpki-roots`（与 kaminari 同源），
  不要用系统 CA store，否则会出现「面板红、实际能用」或反之。

**待确认（第 0 步回答，写回本节）：**

1. 选定的 realm v2.9.6 资产（x86_64/aarch64）`--version` 是否都带 `[transport]`？
2. 端点级 `network = { use_udp = false }` 在该版本上是否确实覆盖全局 `use_udp = true`？
3. `wss;` 写法是否确实解析为「无 transport」→ 明文（用抓包确认）？
4. `[log] output = "stderr"` 下，`warn` 能看到哪些错误、`debug` 的握手失败文案长什么样；
   默认 `warn` 是否够运维（不够就只把排障流程写成「临时调 debug」）；
5. 真实域名证书 + IP 直连 + `sni` 在双机上是否稳定通过？

**依据（2026-11-10 核对）：**

- realm v2.9.6 的 `realm_core` 依赖 kaminari 0.14：
  [realm_core/Cargo.toml@v2.9.6](https://github.com/zhboner/realm/blob/v2.9.6/realm_core/Cargo.toml)
- realm 把 transport 串交给 kaminari 的 `get_ws_conf` / `get_tls_client_conf` /
  `get_tls_server_conf`：
  [src/conf/endpoint.rs@v2.9.6](https://github.com/zhboner/realm/blob/v2.9.6/src/conf/endpoint.rs)
- 客户端只有 `sni/alpn/insecure/0rtt`，信任 webpki 根；服务端 `with_no_client_auth`：
  [kaminari 0.14 tls.rs](https://docs.rs/kaminari/0.14.0/src/kaminari/tls.rs.html)
- token 精确匹配与 `wss` 不被识别：
  [kaminari 0.14 opt.rs](https://docs.rs/kaminari/0.14.0/src/kaminari/opt.rs.html)，
  选项说明见 [kaminari README](https://github.com/zephyrchien/kaminari#options)
- endpoint 级 network 覆盖全局（`take_field` 只在 endpoint 为空时继承）：
  [src/conf/mod.rs@v2.9.6](https://github.com/zhboner/realm/blob/v2.9.6/src/conf/mod.rs)
- UDP 路径不使用 transport：
  [realm_core/src/udp/middle.rs@v2.9.6](https://github.com/zhboner/realm/blob/v2.9.6/realm_core/src/udp/middle.rs)
- 单连接转发错误（含 TLS 握手失败）以 `debug` 记录：
  [realm_core/src/tcp/middle.rs@v2.9.6](https://github.com/zhboner/realm/blob/v2.9.6/realm_core/src/tcp/middle.rs)
- `realm --version` 打印版本 + 编译 feature（`FEATURES`）：
  [src/cmd/mod.rs@v2.9.6](https://github.com/zhboner/realm/blob/v2.9.6/src/cmd/mod.rs)、
  [src/consts.rs@v2.9.6](https://github.com/zhboner/realm/blob/v2.9.6/src/consts.rs)

**English summary.** The top risks are certificate operations without ACME, silent plaintext due to
old agents/slim realm/mistyped `wss;`, and UDP bypassing the transport. Step 0 must answer five
runtime questions (transport feature in both release assets, endpoint-level UDP override, `wss;`
plaintext behaviour, stderr log shape, and real-cert IP/SNI behaviour). The cited realm 2.9.6 and
kaminari 0.14 sources are the basis for the design; re-check them whenever realm is upgraded.

## P16：自研隧道（tunnel 引擎）

> 目标：替换 realm 在**链路跳间**的角色，解决它三个硬限制——只能用公网 CA 证书、
> 没有 ws/wss 混淆、UDP 与 transport 完全解耦。**不替换**客户端到入口那一段。

### 1. 三种安全模式

| 模式 | 证书 | 认证 | 说明 |
|---|---|---|---|
| `tls` | 自签，主控签发 | CA 链 | **默认**。解决"必须买公网证书、90 天人工换"的痛点 |
| `noise` | 无 | PSK（Noise IK） | 完全不要证书。用 `snow` crate，WireGuard 同一套握手 |
| ~~`pinned`~~ | — | — | **不做**：换证书必须两端同步更新，硬耦合，收益不如 CA |

两种模式共用同一个监听端口，握手首字节区分：

```
[0x01] TLS ClientHello
[0x02] Noise 握手消息 1
```

### 2. 传输选择

- **TCP 中继：TCP + TLS 1.3 / Noise**，**不做多路复用**。
  理由：跳间链路 RTT 稳定、丢包低，队头阻塞不是主要矛盾；TLS 会话复用已把握手成本降到接近 0；
  多路复用会引入流控状态机和 HOL，复杂度高一个数量级。
- **UDP 中继：QUIC datagram**（`quinn`）。不做 UDP-over-TCP——弱网下延迟会被放大，做了也会被弃用。

### 3. 协议

握手（两步）：
```
ClientHello: { version: 1, hop_id, proof }
ServerHello: { version: 1, ok, reason? }
proof = HMAC(hop_secret, hop_id || timestamp)   // ±5 分钟窗口 + 服务端最近 proof 缓存
```

数据帧：
```
[u8 kind][u32 len][payload]
kind: 0x01 数据 | 0x02 关闭 | 0x03 心跳
```
首帧带目标地址（SOCKS5 地址格式），同一个入口可按需连不同下一跳。

### 4. 密钥与轮换

```
hop_secret = HMAC(master_secret, "tunnel/{chain_id}/{hop_seq}")   // 32 字节
static_psk  = 派生同上，只用于认证
session_key = 每次期望态下发时重新协商的临时密钥（Noise IK 的临时公钥）
```

**硬要求**：PSK 泄漏无法靠到期兜底，所以静态 PSK **只用于认证**，实际加密必须用临时会话密钥，
把泄漏窗口压到一个心跳周期内。

轮换 = 改 master secret 或 chain_id → 全链换钥 → **链路瞬断**（两端需同时 apply）。与 SS2022 同一类坑，文档必须写清。

### 5. 性能与资源（设计目标，非承诺）

```
单连接常驻     rustls 会话 8KB + 读写缓冲 64KB ≈ 72KB
10k 并发       ≈ 700MB  ← 必须由 max_connections 硬上限兜住
max_connections 默认 8192，超限拒绝新连接并按 30s 节流记一次 warn（不踢在线连接）
```

优化项（按收益排序）：
1. `copy_bidirectional` 缓冲 8KB → 32–64KB（一行改动，收益最大）；
2. 每核一个 accept 循环（`SO_REUSEPORT`）；现在单循环跑不满多核；
3. 加密固定用 `ring` 后端，不引入 aws-lc；
4. **不用 `splice`**：加密后不存在零拷贝路径，任何"零拷贝加密隧道"的说法都不成立（除非上 kTLS）。

验收基准（**与链路带宽无关**，200 Mbps 的机器也能完整跑）：

| 指标 | 目标 | 为什么这样定 |
|---|---|---|
| 同机回环吞吐 | ≥ 1 GiB/s 单连接 | 测的是加密+拷贝的上限，与真实带宽无关 |
| tunnel / 直连（同机回环） | 仅作参考 | 直连是纯 memcpy（约 4 GiB/s），比值天然低，**不作为通过标准** |
| tunnel / realm（同一真实链路） | ≥ 0.90 | 与既有方案对比，链路带宽抵消 |
| tunnel / 直连（同一真实链路） | ≥ 0.85 | 真实链路上才有意义 |
| 延迟增量 p99 | < 2 ms | 小包往返，与带宽无关 |
| 单核吞吐 | ≥ 800 Mbps | 可外推：10 Gbps 需要几个核 |

**已测（2026-11-13，M 系 Mac，release，loopback）**：单连接 896 MiB/s（约 7.5 Gbps），
直连 3991 MiB/s。该数字受"1 MiB 窗口往返"的测试方式限制，是**下限**而非上限。

### 6. 安全边界

- **不自己实现任何 AEAD/KDF**：TCP 用 rustls，Noise 用 snow，UDP 用 quinn；
- 代码里**不提供 `insecure` 开关**；
- 隧道绑定 `hop_id`，服务端只允许转发到该跳预配置的下一跳（防开放中继）；
- 私钥落盘 0600（复用 `ManagedFile.mode`）；
- 握手 `version` 精确匹配，**不向下兼容**；
- 失败一律 fail-closed：证书/密钥/握手失败 → 整链不下发，绝不回退明文。

### 7. 接入现有架构

```
ForwardEngine 新增 Tunnel
DesiredForward 增加 tunnel 段（hop_id、对端、证书路径、hop_secret）
DesiredState.files 带证书（复用现有管线）
Agent 新增 tunnel.rs supervisor（与 native/realm 同层）
观测复用 ForwardStatus：延迟、流量、listening、target_error 无需新通道
```

### 8. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P16.1** | TLS + 自有 CA，1:1 连接，帧协议，单跳回环 | 两台机器跑通；iperf3 与裸链对比；丢包 <1% 时吞吐损失 <10% |
| **P16.2** | Noise/PSK 模式（同一套帧与调度，只换握手层） | 无证书链路跑通；密钥轮换流程验证 |
| **P16.3** | UDP over QUIC | 游戏 UDP 回环；10% 丢包下抖动可控 |
| **P16.4** | 混淆层（ws / fake-http） | **有明确需求再做**；不解决安全，做早会掩盖真实缺陷 |

### 8.1 实现状态（2026-11）

> P16.1 的帧/TLS/握手骨架已在 `2d5fef0` 合并。本轮把隧道接入了
> `ForwardEngine` / `DesiredState`，并完成三件事：
>
> 1. **帧适配器**：`FrameIo` 直接暴露 `FrameKind::Data` 的 payload，
>    `copy_bidirectional_with_sizes(32 KiB)` 直接跑在它和 `TcpStream` 之间；
>    删除了 `tokio::io::duplex(32 KiB)` 与两个泵任务。10 个并发回环连接的
>    进程物理足迹增量从 **2144 KiB（旧）降到 1808–1968 KiB（新，多次运行）**
>    （macOS `vmmap` 的 Physical footprint，测试名 `tunnel_rss_delta_*`）。
> 2. **白名单**：`TunnelServerConfig.allowed_targets` 在首帧地址解析后、
>    `connect_target` 之前校验；空列表拒绝一切。域名后缀 / 精确 IP /
>    端口闭区间，拒绝时回 CLOSE + 30s 节流 warn。
> 3. **2 跳链接入**：第 0 跳 Dialer、第 1 跳 Listener；主控生成自有 CA +
>    每台服务器属证书，经 `DesiredState.files` 下发（cert/key 0600、
>    ca.pem 0644）；`hop_secret = HMAC(master_secret, "tunnel/{chain_id}/{seq}")`。
>
> **当前限制**：tunnel 引擎只支持 2 跳、每组 1 台成员（多成员会把流量
> 全部压到第一台，因此先拒绝而不是静默降级）；3+ 跳、UDP/QUIC
> 仍按原计划留在后续阶段。
>
> **Status (2026-11, English)**: P16.1 framing/TLS/handshake landed in
> `2d5fef0`. This round wires the tunnel into `ForwardEngine` /
> `DesiredState`: a frame adapter replaces the 32 KiB duplex bridge (10
> loopback connections: 2144 KiB → 1808–1968 KiB physical footprint), the
> listener validates an allowlist before any outbound connect (empty = deny
> all), and a 2-hop chain is derived into an entry dialer plus an exit
> listener with a master-owned CA and per-server leaf certificates. The
> current engine is limited to 2 hops with one member per group; UDP/QUIC
> and 3+ hop topologies remain future work.

### 8.2 P16.2 Noise/PSK 的下发路径（2026-11）

P16.2 的 Noise 握手（`d393d4d`）最初只做到 Agent 侧 API，没有下发路径。
本轮把它接到链配置上：

* **线协议 v20**：`TunnelSpec` 增加 `security`（`tls` / `noise`，缺省 `tls`），
  旧主控报文反序列化后仍是 TLS，升级 Agent 行为不变；
* **存储**：迁移 0038 给 `chains` 追加 `tunnel_security TEXT NOT NULL DEFAULT 'tls'`，
  读路径对未知/脏值回落 `tls`；
* **API**：`POST/PATCH /api/v1/chains` 接受 `tunnel_security`，非法值返回
  `chain.tunnel_security_invalid`；`GET /api/v1/chains` 的 `items[].tunnel_security`
  原样返回；
* **下发**：`noise` 链不签发、也不下发任何隧道证书/CA，`TunnelSpec` 的三个证书
  路径均为空串，只带 `hop_secret`；`tls` 链仍走 P16.1 的 CA + 属证书；
* **Agent**：`TunnelSupervisor` 按 `spec.security` 选择
  `TunnelServerConfig::new` / `TunnelClient::trusting_ca_file`（TLS）或
  `TunnelServerConfig::noise` / `TunnelClient::noise`（Noise）。Noise 模式不读
  证书路径；TLS 模式缺证书仍在启动前失败并报「证书缺失」。

> **Status (2026-11, English)**: the P16.2 Noise handshake shipped in `d393d4d`
> without a dispatch path. This round adds protocol v20 `TunnelSpec.security`
> (default `tls`), migration 0038 `chains.tunnel_security`, API validation with
> `chain.tunnel_security_invalid`, and mode-aware rendering: `noise` chains ship
> no certificates or CA files (empty path fields, only `hop_secret`), while
> `tls` chains keep P16.1 assets. `TunnelSupervisor` selects TLS or Noise from
> `spec.security`; Noise never reads certificate paths, and TLS still fails fast
> with a missing-certificate status.

### 8.3 P16.3 UDP over QUIC 的接线（2026-11）

`79a691f` 已交付 QUIC datagram 中继（`crates/agent/src/tunnel/quic.rs`），但
没有生产调用点。本轮把它接进 `ForwardEngine` 的 UDP 路径——**零数据报格式
改动**（§8.1 末尾「UDP/QUIC 留待后续阶段」已被本节取代）：

* **线协议 v21**：`TunnelSpec` 增加 `#[serde(default)] udp: bool`；旧主控报文
  解析成 `false`（纯 TCP 隧道），升级 Agent 行为不变。主控对
  `protocol = udp / both` 的 tunnel 链下发 `udp = true`，`tcp` 链保持不变；
* **保存门禁**：`noise + udp` 返回 `chain.tunnel_udp_requires_tls`（Noise 的
  UDP 本轮不做）；`protocol = udp / both` 在 TLS 模式下合法。下发路径的
  `tunnel_blocked_reason` 用同一判定再挡一次；
* **出口跳（Listener）**：`TunnelServer::with_udp(chain_target_rules)` 在隧道
  端口上起 QUIC endpoint，白名单**只含链目标**；UDP 绑定或证书失败 =
  端点启动失败（`ForwardStatus.listening = false`）；
* **入口跳（Dialer）**：在 TCP 入口的同一端口号上绑 UDP socket；会话表键 =
  本地客户端 `SocketAddr`，**一个客户端一条 QUIC 连接**（回包只带目标地址，
  单连接无法区分同一目标上的多个客户端）。建连期间最多缓存 8 个数据报，
  连上后按序补发；空闲 60s 回收（关 QUIC 连接），上限 4096，超限丢新包 +
  30s 节流 warn；连接断开立刻清掉该客户端会话；
* **UDP 选路**：Dialer 只把**链目标那一条**规则传给 `send_from`；把「下一跳
  Listener + 链目标」的整份白名单传进去会让一致性哈希把下一跳当成 UDP 后端；
* **QUIC 认证**：不再查时间戳重放缓存。proof 只由 `(hop_secret, hop_id, 秒级
  时间戳)` 决定，而「一个本地客户端一条连接」同一秒内必然产生相同 proof；
  QUIC 的 ClientHello 在 TLS 1.3 加密流里，被动攻击者既拿不到 proof，也无法
  重放整段 QUIC 握手（服务端每次生成新密钥）。TCP 路径的重放缓存不变；
* **测试**：两端 tunnel + 本地 UDP echo（3 包全回显、`datagrams_in == 3`）、
  两个不同源地址客户端各自会话（`sessions == 2`，互不串包）、空闲回收后
  会话归零、白名单外目标 `denied` 增加且 echo 收包为 0、`noise + udp` 在
  主控 400。

> **Status (2026-11, English)**: `79a691f` shipped the QUIC datagram relay
> without a production call site. This round wires it into the tunnel engine
> with **no datagram-format change**: protocol v21 adds
> `TunnelSpec.udp` (default `false`), derived from chain `protocol = udp /
> both`; `noise + udp` is rejected with `chain.tunnel_udp_requires_tls` on both
> save and dispatch. The exit hop starts a QUIC endpoint on the tunnel port with
> an allowlist containing only the chain target. The entry hop binds UDP on the
> same port and keeps one QUIC connection **per local client** (replies carry
> only the target address), buffers up to 8 datagrams while connecting, reclaims
> idle sessions after 60s, caps sessions at 4096 with a 30s-throttled warn, and
> drops the session as soon as the connection closes. Only the chain-target rule
> is passed to UDP target selection, and QUIC authentication no longer consults
> the timestamp replay cache (one connection per client would otherwise collide
> within the same second; TLS 1.3 channel protection already prevents replay).
> `ForwardStatus.listening` now requires the UDP bind to succeed.

### 9. 不做

- 不做证书固定（pinned）模式；
- 不做通用多路复用；
- 不做 kTLS / 内核旁路；
- 不替换客户端到入口那一段（Xray 继续负责）。
