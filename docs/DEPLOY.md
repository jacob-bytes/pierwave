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
| `PIERWAVE_SECRET_KEY` | 未设置 | 备份/设置加密的主密钥，base64 的 32 字节；未设置时自动生成 `data/secret.key`（0600）。**必须备份**，丢失后已加密的备份与设置无法解密 / master key for backup and secret encryption; auto-generated as `data/secret.key` when unset. Back it up: losing it makes encrypted data unrecoverable |
| `PIERWAVE_ADMIN_PASSWORD` | 随机 | 仅首次建库时生效，密码会打印在日志里 |
| `PIERWAVE_AGENT_RELEASE_SOURCE` | `https://github.com/jacob-bytes/pierwave-agent/releases/download` | Agent 发布产物回源地址，按 `{source}/{version}/{file}` 拼接；离线时可指向本地目录 / Origin for agent release artifacts, joined as `{source}/{version}/{file}`; a local directory works offline |
| `PIERWAVE_AGENT_LATEST_URL` | `https://api.github.com/repos/jacob-bytes/pierwave-agent/releases/latest` | 查询 Agent 最新版本的 GitHub API；可指向本地 JSON 文件 / GitHub API endpoint for the latest agent version; a local JSON file works offline |
| `PIERWAVE_AGENT_DIST` | 未设置 | agent 二进制目录；设置后 `/api/agent/download/*` 才可用 |
| `PIERWAVE_ENFORCE` | 开 | 设为 `0` 关闭超额断流 |
| `PIERWAVE_CHAIN_AVAILABILITY_THRESHOLD` | `99` | 链可用率告警阈值（百分比 0–100）/ Chain availability alert threshold (percent, 0–100) |
| `PIERWAVE_CHAIN_DEGRADED_STREAK` | `3` | 连续多少次心跳低于阈值才告警（1–100）/ Consecutive low-availability checks before alerting (1–100) |
| `PIERWAVE_HEARTBEAT_TIMEOUT_SECS` | `90` | 心跳超时判定阈值（秒，正整数）：超过该时长没有心跳就把服务器标为离线并发 `server_offline` 告警 / Heartbeat timeout in seconds (positive integer); a server with no heartbeat for longer is marked offline and a `server_offline` alert is sent |
| `PIERWAVE_PUBLIC_RATE_LIMIT_PER_MIN` | `60` | 公开状态页每 IP 每分钟读取上限（正整数；空串 / `0` / 负数 / 非数字等非法值回落 60 并打一条 warn）/ Per-IP reads per minute for the public status page (positive integer; invalid values such as empty, `0`, negative or non-numeric fall back to 60 with a warning) |

登录限流的阈值、锁定时长、会话有效期、面板名称都在「设置」页里改（存 `settings` 表），不用重启。

**心跳超时 / Heartbeat timeout**：Agent 心跳默认 15 秒一次，主控每 60 秒扫一次
`servers.last_seen_at`，超过阈值（默认 90 秒）未更新就把仍在
`online` 的服务器标成 `offline`，并发出一次 `server_offline` 告警（走现有渠道与冷却）。

- 只处理 `status = 'online'` 的行：已经离线的服务器不会重复告警；
- `last_seen_at IS NULL`（从未连过）的服务器永远跳过，不会被判成「超时离线」；
- 心跳恢复后 `update_health` 会立刻把状态改回 `online`，无需人工介入；
- 该判定只改 `status`，不会断开 Agent 的 WebSocket；连接真的断了仍由原有的断开路径处理。

The master sweeps `servers.last_seen_at` every 60 seconds. A server that is still
`online` but has not been updated for longer than the timeout (default 90 seconds) is marked `offline` and one `server_offline` alert is delivered
through the existing channels and cooldown. Rows with `last_seen_at IS NULL` (never
connected) are skipped, already-offline rows are never re-alerted, and a recovered
heartbeat flips the server back to `online` automatically. The sweep only changes
`status`; it never closes the Agent WebSocket.

**反代要点**：`/api/agent/ws` 必须支持 WebSocket 升级；`X-Forwarded-Proto` 要透传——主控靠它生成安装命令里的 `https://`。

**关于 `X-Forwarded-For`**：主控只在直连方是回环/内网地址时才采信它（用于登录限流的 IP 维度）。
- 走 Nginx/Caddy 反代（master 监听 127.0.0.1）→ XFF 生效，建议用 `$remote_addr` 覆盖而不是透传客户端值；
- 直接 `IP:port` 暴露 → XFF 被忽略，一律按真实对端 IP 计数，避免伪造头绕过限流。

**公开状态页限流 / Public status rate limiting**：`GET /api/v1/public/status` 与
`GET /api/v1/public/status/{id}` 按客户端 IP 限流，默认每 IP **每分钟 60 次**，
超限返回 `429` + `Retry-After`（`code = public_status.rate_limited`）。

- 列表与详情**共用同一个桶**；阈值用 `PIERWAVE_PUBLIC_RATE_LIMIT_PER_MIN` 调整，
  空串 / `0` / 负数 / 非数字等非法值回落 60。
- `/api/v1/health` **不限流**：监控探针通常按秒级轮询，把它和公开页塞进同一个桶
  只会让面板被刷时变成监控误报。管理端 `/api/v1/public-status/*` 走鉴权，也不在这个桶里。
- 与登录 / Bearer 认证失败限流是**两张独立的表**：读公开页再多也不会把登录或
  Bearer 打成 `429`，撞库失败也不消耗公开页的额度。
- 反代必须按上面的 XFF 规则传真实客户端地址（`$remote_addr` 覆盖最稳），否则
  所有请求会落到同一个桶，或者被伪造头绕过。
- 30 秒快照过期或冷启动时只允许一个请求重建（单飞），其余请求等同一结果；
  等待超过 5 秒返回 `503`（`code = public_status.overloaded`）。细节与指标日志见
  [PUBLIC-STATUS.md](PUBLIC-STATUS.md)。

English: both public endpoints are rate-limited per client IP — 60 requests per
minute by default, `429` + `Retry-After` (code `public_status.rate_limited`)
when exceeded. The list and the detail share one bucket; tune the threshold with
`PIERWAVE_PUBLIC_RATE_LIMIT_PER_MIN` (invalid values fall back to 60).
`/api/v1/health` is deliberately **not** limited, because it is the monitoring
probe and folding it into the same bucket would turn load on the public page
into false alarms; the authenticated `/api/v1/public-status/*` admin endpoints
are outside this bucket too. This limiter is fully separate from the
login / Bearer auth-failure limiter in both directions. The reverse proxy must
forward the real client address following the XFF rules above (`$remote_addr`
overwrite is safest), otherwise every request lands in one bucket or forged
hops bypass the limit. When the 30-second snapshot expires (or on cold start)
only one request rebuilds it (single-flight); waiters share that result and get
`503` (`public_status.overloaded`) after waiting 5 seconds. See
[PUBLIC-STATUS.md](PUBLIC-STATUS.md) for details and the metric logs.

## Agent 一键安装

面板「服务器 → 添加」生成 token 后会给出一条命令，形如：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh?token=… | sudo bash
```

脚本会按 `uname -m` 选架构、下载 `/api/agent/download/pierwave-agent-<target>`、写
`/etc/pierwave-agent/config.toml`（0600）、装 systemd 单元并启动。

Agent 自 0.19.x 起在独立仓库发布，主控默认从
[jacob-bytes/pierwave-agent](https://github.com/jacob-bytes/pierwave-agent/releases) 回源；
主仓 `v*` 的 Releases 不再包含任何 agent 产物。升级走的是同一条回源链路
（`/api/agent/release/{version}/{file}`）。

部署前要做两件事（或者直接从上面 Agent 仓库的 Releases 下载对应架构的 `pierwave-agent-<target>`
放进分发目录，跳过编译）：

```bash
# 1) 交叉编译（本机没有对应 target 就先 rustup target add）
cargo build --release -p pierwave-agent --target x86_64-unknown-linux-musl
cargo build --release -p pierwave-agent --target aarch64-unknown-linux-musl

# 2) 把产物放进 PIERWAVE_AGENT_DIST 指向的目录，文件名必须与脚本预期一致
mkdir -p /srv/pierwave/dist
cp target/x86_64-unknown-linux-musl/release/pierwave-agent \
   /srv/pierwave/dist/pierwave-agent-x86_64-unknown-linux-musl
```

> **English.** The panel's one-click command is unchanged: the master fetches agent
> artifacts from the [pierwave-agent](https://github.com/jacob-bytes/pierwave-agent)
> repository by default, and `v*` releases in the master repository no longer contain any
> agent artifacts. Upgrades use the same origin path
> (`/api/agent/release/{version}/{file}`). For an offline install, download
> `pierwave-agent-<target>` from the agent repository and drop it into the
> `PIERWAVE_AGENT_DIST` directory, or build it from the transitional `crates/agent` source.

### 旧主控的兜底 / Older masters

0.19.0 之前的主控默认指向主仓 `jacob-bytes/pierwave`（那时 agent 产物还在主仓），而主仓 `v*`
已不再包含 agent 产物，这类主控的安装/升级会拿不到文件（回源 404）。不用换二进制，给主控设置两个环境变量并重启即可：

```bash
PIERWAVE_AGENT_RELEASE_SOURCE=https://github.com/jacob-bytes/pierwave-agent/releases/download
PIERWAVE_AGENT_LATEST_URL=https://api.github.com/repos/jacob-bytes/pierwave-agent/releases/latest
```

0.19.x 起这两个默认值已经指向 Agent 仓库，无需配置；显式设置仍会覆盖默认值，用于自建镜像或离线目录。
本地目录镜像按 `{source}/{tag}/{file}` 摆放，例如
`/srv/pierwave/agent/<tag>/pierwave-agent-x86_64-unknown-linux-musl`。

> **English.** Masters before 0.19.0 default to `jacob-bytes/pierwave`; because `v*`
> releases there no longer contain agent artifacts, install/upgrade cannot fetch the files
> (origin 404). No binary swap is needed — set the two environment variables above on the
> master and restart it. The 0.19.x defaults already point at the agent repository; explicit
> values still override them for a mirror or an offline directory laid out as
> `{source}/{tag}/{file}`.

### 签名密钥轮换后的升级 / Upgrading after a key rotation

签名密钥轮换前安装的 Agent 内置旧公钥，**批量升级会验签失败**，这类节点需要重新安装
（见 [RELEASE.md](RELEASE.md)）。

> **English.** Agents installed before the signing-key rotation embed the old public key;
> batch upgrades will fail signature verification, so those nodes must be reinstalled (see
> [RELEASE.md](RELEASE.md)).

## 明文 `ws://` 限制

Agent 支持 `http://`（内部转成 `ws://`）与 `https://`（`wss://`）。两者都能连，
但 `ws://` **不加密**：Agent token 与全部业务流量在链路上是明文。

因此从本版本起，Agent 启动时若 `master_url` 是 `http://` 且主机不是回环
（`127.0.0.1` / `::1` / `localhost`），**默认拒绝启动**并打印中英双语错误。
回环地址（本机反代 / 端口转发）不受影响。确需在受信任网络里用明文时，显式设置：

```bash
sudo systemctl edit pierwave-agent
# [Service]
# Environment=PIERWAVE_AGENT_ALLOW_INSECURE=1
sudo systemctl daemon-reload && sudo systemctl restart pierwave-agent
```

生产部署请直接给主控配 HTTPS 域名，让 Agent 用 `wss://`；不要用这个开关把暴露在公网的
主控降级成明文。

> **Plaintext `ws://` is rejected by default.** An Agent whose `master_url` is `http://`
> (which becomes `ws://`) and whose host is not loopback (`127.0.0.1`, `::1`, `localhost`)
> refuses to start, because the Agent token and all traffic would travel in clear text.
> Loopback setups (local reverse proxy / port forwarding) are unaffected. If you really
> need plaintext on a trusted network, set `PIERWAVE_AGENT_ALLOW_INSECURE=1` for the
> systemd unit as shown above. Production deployments should terminate TLS at the master
> and use `wss://` instead of disabling this check.

## 连接令牌重置与服务器命令

明文 token 只在创建与重置时返回一次。丢失后不必删服务器：管理员调用
`POST /api/v1/servers/{id}/token` 会生成新 token、覆盖 `token_hash` 并返回新的
`install_command`；旧的 token **立即失效**（已连上的 Agent 不会因此被踢下线，
但下次重连 / 重新安装会失败，需要到面板重新取命令）。审计动作是
`server.token_rotated`，只记服务器信息，不记明文 token。

服务器 JSON 还有一组不依赖 token 的常驻命令：

```json
"commands": {
  "install": null,
  "upgrade": "curl -fsSL https://panel.example.com/api/agent/install.sh | sh -s -- upgrade",
  "uninstall": "curl -fsSL https://panel.example.com/api/agent/install.sh | sh -s -- uninstall",
  "stop": "systemctl stop pierwave-agent",
  "restart": "systemctl restart pierwave-agent"
}
```

`install` 只在创建 / 重置响应里出现（一次性），其余四条随时可取。
`upgrade` / `uninstall` 的参数名与 `scripts/install.sh` 一致；`stop` / `restart`
操作 Agent 的 systemd 单元。

> **Token rotation.** The plaintext token is returned only on create and on
> `POST /api/v1/servers/{id}/token`. Rotation overwrites `token_hash`, so the old token stops
> working immediately (an already-connected Agent is not kicked out, but it cannot reconnect or
> reinstall until the command is fetched again). The audit action is `server.token_rotated`;
> plaintext tokens are never written to the audit log. The server JSON exposes a
> token-independent `commands` object: `install` is only present in create/rotate responses,
> while `upgrade`, `uninstall`, `stop`, and `restart` can be fetched at any time.

## 服务器分组

`servers.group_name`（迁移 `0039`，可空）只是展示维度。创建 / PATCH 时接受
`group_name`：自动去首尾空白，空串清空为 `NULL`，最长 32 个字符，拒绝控制字符
（错误码见 [ERRORS.md](ERRORS.md)）。公开状态页的 `GET /api/v1/public/status`
增加 `groups` 数组，具名分组按名称升序、未分组用 `name: null` 放在最后；`uptime_24h` 是组内可用率
的算术平均，无采样时为 `null`。同一接口的迷你图 `series`（窗口、桶、`null` 语义）见
[PUBLIC-STATUS.md](PUBLIC-STATUS.md)。

> **Server groups.** `servers.group_name` (migration `0039`, nullable) is presentation-only.
> Create/PATCH accept `group_name`, trimming whitespace, turning an empty string into `NULL`,
> limiting it to 32 characters, and rejecting control characters (see [ERRORS.md](ERRORS.md)).
> The public `GET /api/v1/public/status` response gains a `groups` array with named groups sorted by
> name and ungrouped servers (`name: null`) last; `uptime_24h` is the mean member uptime and is `null`
> when no samples exist. The same response's mini-chart `series` (window, buckets, `null` semantics)
> is documented in [PUBLIC-STATUS.md](PUBLIC-STATUS.md).

## 服务器费用与到期 / Server cost and expiry

迁移 `0061` 给 `servers` 增加费用/到期展示字段，迁移 `0067` 把计费周期扩展为
「数量 + 单位」并新增两列。它们都不参与鉴权、期望态下发、限速或用户计费，改它们
不会触发 Agent 下发；只是给公开探针页提供展示数据。迁移 `0062` / `0065` 是一次性
数据修复（见下）。

| 字段 | 类型 | 含义 |
|---|---|---|
| `paid_until` | `TEXT`，`YYYY-MM-DD` | 到期日：`1970-01-01` 到 `2100-12-31` 之间真实存在的日期 |
| `price_cents` | `INTEGER` | 价格（分）；`0` 合法，上限 `999_999_999`（约 1000 万元）；只接受整数或 `null` |
| `currency` | `TEXT` | 3 位大写币种代码（`CNY` / `USD` / `EUR` ...） |
| `billing_cycle_count` | `INTEGER` | 计费周期数量：`1..=1200`（1200 个月 = 100 年）；与单位成对 |
| `billing_cycle_unit` | `TEXT` | 计费周期单位：`month` / `year` / `once`；与数量成对 |
| `billing_cycle` | `TEXT` | 旧版单值周期（`monthly` / `yearly` / `once`），**只读派生镜像**，兼容旧客户端 |

创建与 `PATCH /api/v1/servers[/{id}]` 接受这些**扁平字段**（命名与列名一致）：

- `paid_until` 与计费周期可以独立填写；
- **`billing_cycle_count` 与 `billing_cycle_unit` 必须成对**：同时有值或同时为空。
  数量是 `1..=1200` 的整数，单位只能是 `month` / `year` / `once`；`once` 时数量
  必须是 `1`（`2 + once` 返回 400，而不是静默改成 1）。只填一半返回 400
  `server.billing_cycle_pair_incomplete`，`params.missing` 指明缺哪个。
- 旧字段 `billing_cycle` 仍可作为**兼容输入**（按 1 个月 / 1 年 / 一次性映射）；
  新字段同时出现时以新字段为准。响应里的 `billing_cycle` 永远是派生值：
  `1 month → monthly`、`1 year → yearly`、`once → once`，其它组合（3 个月、2 年）
  为 `null`，旧客户端读到的语义不变。
- **`price_cents` 与 `currency` 必须成对**：同时有值或同时为空。只填一半返回 400
  `server.billing_pair_incomplete`，`params.missing` 指明缺哪个（`price_cents` / `currency`）。
  这样后端与前端契约一致：不会出现「管理员填了价格，公开页却因为缺币种整组隐藏」。
- **`price_cents` 只接受整数或 `null`**；空串（`""`）不是合法整数，请发 `null`。JSON 类型
  错误（例如把 `""` 发给整数字段）由全局映射返回 422 + `request.invalid_json`，
  `params.detail` 带原始字段信息，前端可按 code 翻译。
- PATCH 不传 = 不改，传 `null` 或空串 = 清空。价格与币种按**成对写入**：只传其中
  一个时，另一列用读取到的有效值一起写进同一条 `UPDATE`，两个并发部分更新不会留下
  「有价格没币种」的半对行；读路径遇到历史半对行时把两列整组降级为 `null`。
- 校验失败返回 400，错误码 `server.paid_until_invalid` / `server.price_cents_invalid` /
  `server.currency_invalid` / `server.billing_cycle_count_invalid` /
  `server.billing_cycle_unit_invalid` / `server.billing_cycle_once_count_invalid` /
  `server.billing_cycle_pair_incomplete` / `server.billing_cycle_invalid`（旧字段）/
  `server.billing_pair_incomplete`，`params` 带 `field` 与允许范围（完整表见
  [ERRORS.md](ERRORS.md)）。管理员服务器列表与公开探针页都返回这些字段。
- 公开页是否展示它们由设置项 `public_billing_visible`（默认 `"1"`）整体控制：设为
  `"0"` 时费用字段（含计费周期三列）一律返回 `null`，响应顶层 `billing_hidden = true`，前端据此显示
  「未公开」而不是「未填写」。单个服务器是否出现在公开页由 `servers.public_visible`
  （迁移 `0064`，默认 `1`）控制，详见 [PUBLIC-STATUS.md](PUBLIC-STATUS.md)。

**脏数据承诺 / Dirty-data contract：值域非法按 `null` 处理；列类型被写坏由 `0062` 迁移
一次性修复。** 读路径（公开页、管理端列表）始终容错：非法值逐字段降级为 `null`，不会让
页面 500；但「TEXT 被写进 INTEGER 列」这类类型损坏会让 `Server::from_row` 解码失败，
迁移 `0062` 在升级时把类型损坏与值域非法的列一次性置 `NULL`（可重复执行，只改这四列）。
正常写入路径产生不了这类值。

> **Server cost and expiry.** Migration `0061` adds optional display columns to
> `servers`, and migration `0067` expands the billing cycle into a count + unit pair.
> Migration `0062` is a one-off repair of legacy dirty values. None of them affect auth,
> desired-state dispatch, rate limits or user billing.
> `paid_until` is a real `YYYY-MM-DD` date between `1970-01-01` and `2100-12-31`.
> `price_cents` accepts **only an integer or `null`** — send `null`, not `""`, to clear it;
> a JSON type error is mapped globally to 422 + `request.invalid_json`. `paid_until` and the
> billing cycle may be set independently, but **`price_cents` and `currency` must be
> provided together**, and so must **`billing_cycle_count` and `billing_cycle_unit`**
> (both set or both empty), otherwise 400 `server.billing_pair_incomplete` /
> `server.billing_cycle_pair_incomplete` with `params.missing`. The count is `1..=1200`,
> the unit is `month` / `year` / `once`, and `once` requires count `1` (rejected, not
> silently normalized). PATCH is tri-state per field (omitted = unchanged, `null`/empty =
> clear; an explicit `null` on either cycle field clears the pair). Price/currency are
> written **as a pair**, and the cycle's three columns (count, unit, derived legacy
> `billing_cycle`) are written together. The read path degrades legacy half pairs to
> `null`. Invalid values return 400 (codes and params in [ERRORS.md](ERRORS.md)). Admin
> lists and the public probe return the fields, including the derived legacy
> `billing_cycle`: `1 month → "monthly"`, `1 year → "yearly"`, `once → "once"`, anything
> else (3 months, 2 years) is `null`. The old `billing_cycle` input is still accepted as
> a compatibility fallback (mapped to one unit); new fields take precedence.
> Whether the public page shows them is controlled globally by
> `public_billing_visible` (default `"1"`): when `"0"`, all billing fields are `null`
> and the top-level `billing_hidden` is `true`, so the UI can say "not public"
> instead of "not set". Per-server page visibility is `servers.public_visible`
> (migration `0064`, default `1`); see [PUBLIC-STATUS.md](PUBLIC-STATUS.md).
>
> **Dirty-data contract: out-of-domain values read as `null`; wrong column storage classes
> are repaired once by migration `0062`.** Reads never 500 on dirty values; `0062` resets
> both wrong storage classes and out-of-domain values to `NULL` (idempotent, only these four
> columns). The normal write path cannot produce such values.

> **⚠️ 公开可见：探针页 `/status` 不需要登录。填写后价格与到期对所有人可见
> （除非管理员关闭 `public_billing_visible`）。不想公开就不要填。**
>
> **⚠️ Public by design: the probe page `/status` needs no login. Once filled in,
> the price and expiry date are visible to everyone unless the admin turns off
> `public_billing_visible`. If you do not want them public, leave them empty.**

## 日志与备份

- 日志走 stdout，交给 systemd/journald 或容器日志驱动；
- 备份数据库与证书：SQLite 用 WAL，拷之前先 `sqlite3 pierwave.db ".backup"`，不要直接 cp 主库；
- 证书私钥在库里，备份即包含私钥，注意存放权限；
- **不要把 `data/secret.key` 打进数据库备份包**：主密钥必须与数据分开保管，否则一份泄漏的
  备份包会同时带走密文和钥匙，加密备份/设置就失去意义；恢复时也容易把错误实例的密钥
  一起带过去。
  / **Never bundle `data/secret.key` into the database backup archive.** Keep the master key
  separate from the data: a leaked archive would otherwise contain both ciphertext and key,
  and a restore could silently carry over the wrong instance's key.
- 主密钥：未设置 `PIERWAVE_SECRET_KEY` 时首次启动会生成 `data/secret.key`（0600），
  **必须单独备份**；恢复加密备份或迁移到新机时，要么带上原
  `secret.key`，要么用同样的 `PIERWAVE_SECRET_KEY`（base64 的 32 字节）覆盖。丢失后已加密的
  备份与 `settings` 里的秘密无法解密，详见 [BACKUP_ENCRYPTION.md](BACKUP_ENCRYPTION.md)。
  / Master key: without `PIERWAVE_SECRET_KEY`, the first start creates `data/secret.key` (0600).
  **Back it up separately** from the database: restoring encrypted backups or moving to a new
  host requires either the original file or the same `PIERWAVE_SECRET_KEY` (32 bytes, base64).
  Losing it makes encrypted backups and encrypted `settings` unrecoverable.

- 恢复备份成功后，旧库会保留为 `<db>.pre-restore-<timestamp>` 以便回滚；这些文件是
  **完整旧业务库**（含证书私钥与密码哈希），启动时自动清理超过 7 天的副本。确认不再
  回滚后也可以停服手动删除：`rm -f data/pierwave.db.pre-restore-*`。
  / After a successful restore, the old database is kept as
  `<db>.pre-restore-<timestamp>` for rollback. These are **full old business databases**
  (including certificate private keys and password hashes); startup removes copies older
  than 7 days. Once rollback is no longer needed, stop the service and delete them with
  `rm -f data/pierwave.db.pre-restore-*`.

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

### 面板上的握手失败：TLS 探针

Agent 每 30 秒对**带 `remote_transport` 的 realm 规则**做一次真实 TLS 握手：
TCP connect（3 秒预算）→ 用与 realm **同一个信任根**（编译进二进制的 Mozilla 根）校验
下一跳证书 → 成功后立即关闭。它不等真实用户流量，所以证书过期/域名配错在链路还没被
访问时就能在面板里看到。

链详情/转发列表的成员行会出现 `target_ok=false` 和 `target_error`：

| `target_error` | 面板含义 |
|---|---|
| `tcp_connect_failed` | 连不上下一跳（端口没开、防火墙、服务器离线） |
| `cert_expired` | 下一跳证书已过期 |
| `unknown_issuer` | 证书不受信任（自签，或只传了 leaf、中间证书不完整） |
| `name_mismatch` | 证书 SAN 与 `sni` 不匹配 |
| `handshake_failed` | 其它 TLS 握手错误（看 realm 原始日志） |
| `timeout` | 3 秒内没完成 TCP 连接或握手 |

这些是稳定短串，主控/前端负责翻译；面板不会显示 rustls 的原始 Debug。**与 realm 日志的
关系**：realm 把单连接握手失败记在 `debug` 级，默认不输出，只有真实流量撞上错误时才看得到；
探针是主动握手，不需要流量就能暴露原因。需要 realm 的原文（例如证书链细节）时，把
`realm_log_level` 调成 `debug` 后重启 Agent，再看 `journalctl -u pierwave-agent`。

探针**只观测，不影响转发**：失败不会摘除成员、不会改 realm 配置，realm 仍按
`balance` 轮询到坏成员；明文中继与只有 `listen_transport` 的规则不会被探测，因此未加密
链路没有额外流量（每个加密出口每 30 秒最多一次握手）。

> The Agent performs a real TLS handshake every 30 seconds for realm rules that have a
> `remote_transport` (3-second budget, the same compiled-in Mozilla roots realm uses, then close).
> The panel shows `target_ok=false` plus a stable `target_error` code (`tcp_connect_failed`,
> `cert_expired`, `unknown_issuer`, `name_mismatch`, `handshake_failed`, `timeout`) that the UI
> translates; raw rustls debug text is never exposed. realm logs per-connection handshake failures
> at `debug` (hidden by default), so raise `realm_log_level` to `debug` when you need the original
> error. The probe only observes: it never removes members or changes realm config, and plaintext or
> listen-only rules are not probed, so unencrypted links see no extra traffic.

网络边界：加密端点的监听端口仍是**开放中继**（单向 TLS 不验证客户端），必须用防火墙只放行
上一跳的出口 IP；入口第一跳端口只放行实际客户端网段。最后一跳→目标、客户端→入口不在本功能内。

**English summary.** Hop-to-hop encryption applies only to `realm` chains with at least two groups. It requires
a realm build with the `transport` feature (`realm --version` must contain `[transport]`; slim builds
silently ignore the option) and one publicly trusted certificate per hop group from the second group
on. The private key is deployed to every member of that group, and certificates must be renewed
manually. Encrypted endpoints disable UDP, and the listener is still an open relay because TLS is
one-way: firewall it to the previous hop only. The first hop and the final hop-to-target leg remain
plaintext.
