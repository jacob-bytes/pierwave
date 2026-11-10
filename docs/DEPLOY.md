# 部署

## Docker（推荐给只想快速看效果的人）

```bash
git clone https://github.com/jacob-bytes/pierwave.git && cd pierwave
cp .env.example .env      # 填 PIERWAVE_ADMIN_PASSWORD
docker compose up -d
```

- 面板：`http://<主机>:8787`
- 数据：`./data`（bind mount，含 `pierwave.db` 与 `agent-cache/`）
- 镜像内已包含前端静态资源与 `curl`（Agent 升级中转回源要用）
- **Agent 不进容器**：它需要操作宿主机的 xray 进程与 systemd

## systemd（生产推荐）

```bash
sudo bash scripts/install.sh install
sudo scripts/install.sh status
sudo scripts/install.sh upgrade
sudo scripts/install.sh uninstall --purge   # 连数据一起删，谨慎
```

## 从源码构建

```bash
make web-build
cargo build --release -p pierwave-master -p pierwave-agent
```

Linux 发布产物用 musl 静态链接；`aarch64` 需要 `cross`（见 `.github/workflows/release.yml`）。

## 发布签名

产物附带 `SHA256SUMS-<target>` 与 `.sig`；公钥编译期内置，安装脚本与 Agent 都会验签。
私钥只存在于仓库 Secret `PIERWAVE_RELEASE_SIGNING_KEY`，轮换步骤见 [RELEASE.md](RELEASE.md)。
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

因此部署前要做两件事（或者直接从 [Releases](https://github.com/jacob-bytes/pierwave/releases)
下载对应架构的 `pierwave-agent-<target>` 放进分发目录，跳过编译）：

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

## 可选：realm 转发引擎

`install.sh` 会尝试安装 realm **v2.9.6**（`/usr/lib/pierwave/bin/realm`），用于需要 **UDP** 或带权重负载均衡的转发规则。
二进制从 realm 官方 Release 下载，并**按脚本内联的 sha256 校验**；下载失败、校验不符或架构没有对应哈希时**跳过安装**，
面板照常工作，只是转发规则的「引擎」里选择 realm 时会显示「realm 未安装」。

离线环境可以手动放置：

```bash
install -m 0755 realm /usr/lib/pierwave/bin/realm
systemctl restart pierwave-agent
```

Agent 的 `realm_bin` 配置项可覆盖路径。realm 不可用时 **native 引擎的转发完全不受影响**。

realm 子进程崩溃或被 kill 后，Agent 最多等一个心跳周期（15 秒）就会按已落盘的配置自动重新拉起；
在那之前，面板的监听状态会如实显示「realm 进程已退出（退出码 N）」。二进制存在但不可执行、
或启动即退出时，状态文本同样带启动错误/退出码，不会伪装成监听中。

> If the realm child process crashes or is killed, the Agent restarts it from the on-disk config
> within one heartbeat (15 s). Until then the status column reports the exit code instead of
> pretending the listener is up. A binary that exists but is not executable, or that exits
> immediately, is reported with its spawn error / exit code.

## 可选：链路的跳间加密（P15.3）

只对 `engine = realm` 且 **≥2 组**的链生效；入口第一跳、最后一跳到目标仍是明文。

前置条件：

1. realm 必须是带 `transport` feature 的版本（`install.sh` 安装的官方默认资产满足；
   `realm-slim-*` **不带**，会静默忽略加密配置，禁止使用）：

   ```bash
   /usr/lib/pierwave/bin/realm --version
   # 期望形如：2.9.6 [brutal][batched-udp][proxy][balance][transport][multi-thread]
   /usr/lib/pierwave/bin/realm --version | grep -q '\[transport\]' && echo ok
   ```

2. 从第 2 组起，每组准备一张**公网 CA**证书（自签不可用，见 PLAN §2）：
   - 完整链 PEM（leaf + 中间证书），未加密私钥；
   - 必须有 DNS SAN；域名**不需要**解析到该服务器；
   - 同组多台服务器共用同一张证书，**私钥会下发到组内每一台**；
   - 证书到期需手动更换（没有 ACME），到期后链直接不可用，不会回退明文。

启用：先升级主控、再升级全部 Agent（等服务器列表里每台都上报支持 transport），然后
面板 → 转发链 → 引擎选 `realm`、至少两组、跳间加密选 `TLS` → 为每组选证书和域名 →
应用配置。改完先看 `apply` 的 warnings 与链状态。

验证（在入口服务器上，把地址/域名换成你的）：

```bash
# 1. 下一跳确实在做 TLS，且证书域名匹配
openssl s_client -connect 203.0.113.10:30002 -servername hop1.example.com -verify_return_error -brief

# 2. 加密端点不转发 UDP（应无输出）
ss -lun | grep 30002

# 3. 握手失败的原因：agent 会在状态跃迁时打一条 warn（目标/SNI/原因码）；
#    要看 realm 自己的逐连接日志，把 /etc/pierwave-agent/config.toml 里的 realm_log_level 调成 debug 后重启
journalctl -u pierwave-agent -f | grep -iE 'tls|handshake|cert'
```

网络边界：加密端点的监听端口仍是**开放中继**（单向 TLS 不验证客户端），必须用防火墙只放行
上一跳的出口 IP；入口第一跳端口只放行实际客户端网段。最后一跳→目标、客户端→入口不在本功能内。

**English summary.** Hop-to-hop encryption applies only to `realm` chains with at least two groups. It requires
a realm build with the `transport` feature (`realm --version` must contain `[transport]`; slim builds
silently ignore the option) and one publicly trusted certificate per hop group from the second group
on. The private key is deployed to every member of that group, and certificates must be renewed
manually. Encrypted endpoints disable UDP, and the listener is still an open relay because TLS is
one-way: firewall it to the previous hop only. The first hop and the final hop-to-target leg remain
plaintext.
