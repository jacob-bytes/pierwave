# 部署

## 主控（一台有公网域名的机器）

```bash
cargo build --release -p mmrust-master          # 或从 CI 取产物
MMRUST_ADMIN_PASSWORD='换成强密码' ./mmrust-master
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MMRUST_ADDR` | `127.0.0.1:8787` | 监听地址；建议只监听回环，由 nginx/caddy 反代 |
| `MMRUST_DB` | `sqlite://data/mmrust.db?mode=rwc` | 数据库 |
| `MMRUST_WEB_DIR` | `web/dist` | 前端产物（`make web-build` 生成） |
| `MMRUST_ADMIN_PASSWORD` | 随机 | 仅首次建库时生效，密码会打印在日志里 |
| `MMRUST_AGENT_DIST` | 未设置 | agent 二进制目录；设置后 `/api/agent/download/*` 才可用 |
| `MMRUST_ENFORCE` | 开 | 设为 `0` 关闭超额断流 |

**反代要点**：`/api/agent/ws` 必须支持 WebSocket 升级；`X-Forwarded-Proto` 要透传——主控靠它生成安装命令里的 `https://`。

## Agent 一键安装

面板「服务器 → 添加」生成 token 后会给出一条命令，形如：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh?token=… | sudo bash
```

脚本会按 `uname -m` 选架构、下载 `/api/agent/download/mmrust-agent-<target>`、写
`/etc/mmrust-agent/config.toml`（0600）、装 systemd 单元并启动。

因此部署前要做两件事：

```bash
# 1) 交叉编译（本机没有对应 target 就先 rustup target add）
cargo build --release -p mmrust-agent --target x86_64-unknown-linux-musl
cargo build --release -p mmrust-agent --target aarch64-unknown-linux-musl

# 2) 把产物放进 MMRUST_AGENT_DIST 指向的目录，文件名必须与脚本预期一致
mkdir -p /srv/mmrust/dist
cp target/x86_64-unknown-linux-musl/release/mmrust-agent \
   /srv/mmrust/dist/mmrust-agent-x86_64-unknown-linux-musl
```

## 日志与备份

- 日志走 stdout，交给 systemd/journald 或容器日志驱动；
- 备份就是拷 `data/`（SQLite 用 WAL，拷之前先 `sqlite3 mmrust.db ".backup"`，不要直接 cp 主库）；
- 证书私钥在库里，备份即包含私钥，注意存放权限。

## 已知边界

- 单主控单写库：SQLite 够用到几千用户，写入放大集中在流量上报（已做批量与幂等）；
- 证书目前只支持手动上传，ACME 未实现；
- 不支持多主控/高可用。
