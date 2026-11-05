# mmrust 施工计划

目标：用 Rust 重写一套「Xray 代理面板 + 节点拼车/订阅分发」系统。
参考手册在 `miaomiaowux-docs/`（只读），方案取舍见对话记录。

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
| 8 | UI 组件基座（表格/表单/对话框/Toast） | 🚧 | 前端 lane |
| 9 | 用户管理页 + 用户 API | ⬜ | 下一轮 |

### 已定的实现细节（后端 lane 落地的）

- 节点在库里只存「入站片段」（`config_json`），完整配置由 `mmrust_domain::xray::build_config` 纯函数拼装，输出确定性。
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
POST   /api/v1/servers/:id/apply   -> {config_version}
```

## 每轮验收

1. `make check` 全绿（fmt/clippy/test/web build）
2. 自动化冒烟：起 master → 登录 → 建服务器 → 起 agent → 状态 online
3. 新增页面能在浏览器里点到，且 401/403 路径有明确中文提示

## 明确不做

- MeowX 类跨平台客户端（另一个产品）
- 官方许可证 / `/api/secure/*` 通道
- 多语言文档站
