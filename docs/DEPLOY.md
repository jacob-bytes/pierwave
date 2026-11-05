# 部署

## 主控（一台有公网域名的机器）

```bash
cargo build --release -p pierwave-master          # 或从 CI 取产物
PIERWAVE_ADMIN_PASSWORD='换成强密码' ./pierwave-master
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PIERWAVE_ADDR` | `127.0.0.1:8787` | 监听地址；建议只监听回环，由 nginx/caddy 反代 |
| `PIERWAVE_DB` | `sqlite://data/pierwave.db?mode=rwc` | 数据库 |
| `PIERWAVE_WEB_DIR` | `web/dist` | 前端产物（`make web-build` 生成） |
| `PIERWAVE_ADMIN_PASSWORD` | 随机 | 仅首次建库时生效，密码会打印在日志里 |
| `PIERWAVE_AGENT_DIST` | 未设置 | agent 二进制目录；设置后 `/api/agent/download/*` 才可用 |
| `PIERWAVE_ENFORCE` | 开 | 设为 `0` 关闭超额断流 |

登录限流的阈值、锁定时长、会话有效期、面板名称都在「设置」页里改（存 `settings` 表），不用重启。

**反代要点**：`/api/agent/ws` 必须支持 WebSocket 升级；`X-Forwarded-Proto` 要透传——主控靠它生成安装命令里的 `https://`。

**关于 `X-Forwarded-For`**：主控只在直连方是回环/内网地址时才采信它（用于登录限流的 IP 维度）。
- 走 Nginx/Caddy 反代（master 监听 127.0.0.1）→ XFF 生效，建议用 `$remote_addr` 覆盖而不是透传客户端值；
- 直接 `IP:port` 暴露 → XFF 被忽略，一律按真实对端 IP 计数，避免伪造头绕过限流。

## Agent 一键安装

面板「服务器 → 添加」生成 token 后会给出一条命令，形如：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh?token=… | sudo bash
```

脚本会按 `uname -m` 选架构、下载 `/api/agent/download/pierwave-agent-<target>`、写
`/etc/pierwave-agent/config.toml`（0600）、装 systemd 单元并启动。

因此部署前要做两件事：

```bash
# 1) 交叉编译（本机没有对应 target 就先 rustup target add）
cargo build --release -p pierwave-agent --target x86_64-unknown-linux-musl
cargo build --release -p pierwave-agent --target aarch64-unknown-linux-musl

# 2) 把产物放进 PIERWAVE_AGENT_DIST 指向的目录，文件名必须与脚本预期一致
mkdir -p /srv/pierwave/dist
cp target/x86_64-unknown-linux-musl/release/pierwave-agent \
   /srv/pierwave/dist/pierwave-agent-x86_64-unknown-linux-musl
```

## 日志与备份

- 日志走 stdout，交给 systemd/journald 或容器日志驱动；
- 备份就是拷 `data/`（SQLite 用 WAL，拷之前先 `sqlite3 pierwave.db ".backup"`，不要直接 cp 主库）；
- 证书私钥在库里，备份即包含私钥，注意存放权限。

## 已知边界

- 单主控单写库：SQLite 够用到几千用户，写入放大集中在流量上报（已做批量与幂等）；
- 证书目前只支持手动上传，ACME 未实现；
- 不支持多主控/高可用。
