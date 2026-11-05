# PierWave

用 Rust 重写的 Xray 代理面板：主控（面板 + 订阅分发 + 计费）与 Agent（服务器侧收敛器）分离，
Agent 反向连入主控，服务器不需要开放任何入站端口。

> 早期调研阶段参考过某商业面板的公开文档（本地抓取，未纳入版本库），本项目与其无代码关系。

## 组成

```
crates/proto    主控 ↔ Agent 线协议（serde，版本化，只增不改）
crates/domain   数据模型 / SQL / 业务规则（不依赖 axum）
crates/master   axum 服务：API、会话鉴权、静态 SPA、Agent WS
crates/agent    服务器侧：连主控、收敛 Xray 配置、上报心跳与流量
web             React 19 + TS + Tailwind 4 的 SPA
```

## 快速开始

```bash
make web-install     # 装前端依赖（首次）
make web-build       # 产出 web/dist，master 会直接托管
make run             # 起主控 http://127.0.0.1:8787
```

首次启动会创建管理员 `admin`，随机密码打印在日志里（或启动前设 `PIERWAVE_ADMIN_PASSWORD`）。

单独跑前端热更新：

```bash
make web-dev         # http://127.0.0.1:5173 ，/api 已代理到 8787
```

## 环境变量（master）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PIERWAVE_ADDR` | `127.0.0.1:8787` | 监听地址 |
| `PIERWAVE_DB` | `sqlite://data/pierwave.db?mode=rwc` | SQLite 连接串 |
| `PIERWAVE_WEB_DIR` | `web/dist` | SPA 产物目录 |
| `PIERWAVE_ADMIN_PASSWORD` | 随机 | 初始管理员密码（仅首次建库生效） |

## Agent

```toml
# /etc/pierwave-agent/config.toml
mode = "remote"
master_url = "https://panel.example.com"
token = "<面板里生成的一次性 token>"
connection_mode = "websocket"
xray_mode = "external"
```

```bash
./pierwave-agent -c /etc/pierwave-agent/config.toml
```

## 开发

提交前跑 `make check`（fmt + clippy `-D warnings` + test + 前端构建）。
分层与硬性规则见 `AGENTS.md`，施工计划见 `docs/PLAN.md`。
