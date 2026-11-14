# 订阅层设计（P2 的第一块）

订阅是这套系统对外的唯一出口，也是唯一「用户能直接看到你后台建模质量」的地方。
所以先定抽象，再写渲染器：**加第三种客户端格式时，不应该动前两种的一行代码。**

## 1. 三层结构

```
节点数据 (nodes + inbounds)         ← 事实：协议/传输/安全层/端口
        ↓ 解析 + 凭据注入
SubNode 视图模型                    ← 与客户端无关的中间层
        ↓ Exporter trait
Clash YAML / URI 列表 / Surge / ... ← 每种格式一个实现
```

中间的 `SubNode` 是关键。它不允许出现 `ws-opts`、`servername` 这种客户端字段，
只表达「这个节点是什么」：协议、地址、端口、传输、安全、以及一组**已命名**的参数
（`uuid` / `password` / `sni` / `path` / `host` / `flow` / `service_name` …）。
各协议的差异装进 `params: BTreeMap<String, String>`，渲染器只认视图。

### 1.1 对外端口（NAT）/ Public-facing port

订阅里的端口是 `nodes.public_port ?? nodes.port`，不是 Agent 的监听端口：
NAT 机器上两者往往不同（内网 443 → 公网 40001）。所有导出器都必须走
`SubNode::effective_port()`；`public_port = NULL` 时输出与旧版逐字节一致，
有 golden 测试锁定（`crates/domain/testdata/subscribe_golden_public_port_null.txt`）。
Agent 侧只认 `nodes.port`，下发配置不受影响。

> The subscription port is `nodes.public_port ?? nodes.port`, not the Agent's listen port.
> On NAT hosts these differ (internal 443 → public 40001). Every exporter must use
> `SubNode::effective_port()`; with `public_port = NULL` the output is byte-identical to the
> legacy output, locked by a golden test. The Agent still listens on `nodes.port` only.

## 2. 凭据：每个 (user, node) 一个子账户

妙妙屋的做法是「相同节点会创建独立子账户，流量、连接数和到期时间分别计算」。
我们不建表，用确定性派生：

```
secret_v1 = HMAC-SHA256(master_secret, "v1/{user_id}/{node_id}")
uuid      = 前 16 字节，按 RFC 4122 写成 UUIDv4 形式
```

- 稳定：同一对 (user, node) 永远得到同一个 UUID，重启/重装不变。
- 无需存储：省一张表，也省「先建节点还是先建用户」的顺序问题。
- 可归因：Xray 的 `email` 直接写成 `{user_id}@{node_tag}`，流量统计按 email 聚合就能落到人和节点。
- **轮换代价明确**：`master_secret` 换版本 → 所有订阅同时失效。所以 secret 存 `settings` 表并带 `v1` 前缀，
  迁移时写 `v2`，老订阅自然失效，不需要额外的兼容分支。
- **轮换会连带 SS2022**：同一份 master secret 也派生 SS2022 的每用户密钥，所以换 `hmac_secret_v1`
  会让 vless/vmess 的 UUID、trojan 密码、SS2022 的每用户密钥**同时全部失效**。已下发的 Agent
  配置里还是旧凭据，两边会一直错位；正确顺序是：轮换 secret → 重新 apply（下发新 client）→
  用户重新拉订阅。客户端还在用缓存订阅时表现为「密码错误」，不会自动恢复。

> Rotating `hmac_secret_v1` invalidates **every** derived credential: vless/vmess UUIDs,
> trojan passwords, and SS2022 per-user keys alike. The Agent keeps serving the previously
> applied clients until the next apply, so the order is: rotate the secret, re-apply the server
> config, then have users refresh their subscription. A client that still holds a cached
> subscription just sees "wrong password"; nothing recovers automatically.

> 为什么不存表：存表意味着每次加节点要给所有用户插 N 行（拼车场景下是 O(用户×节点)），
> 而且节点删除要级联清理。派生法在扩容时是 O(1)。

## 3. Exporter trait

```rust
pub struct SubContext<'a> {
    pub nodes: &'a [SubNode],
    pub user_label: &'a str,
    pub traffic: Option<TrafficInfo>,   // 已用/额度/到期，写进 Subscription-Userinfo 头
}

pub trait Exporter: Send + Sync {
    fn id(&self) -> &'static str;              // "clash" | "uri" | "surge" | ...
    fn content_type(&self) -> &'static str;
    fn render(&self, ctx: &SubContext) -> anyhow::Result<String>;
}
```

注册表用 `&'static [&'static dyn Exporter]`，新增格式 = 加一个文件 + 一行注册，不动既有实现。

## 4. 端点与内容协商

```
GET /api/v1/sub/{short_code}                 # 默认 clash
GET /api/v1/sub/{short_code}?target=uri
GET /api/v1/sub/{short_code}?target=singbox
```

- 优先 `?target=`，其次 UA 嗅探（`clash|mihomo|stash|surge|sing-box|shadowrocket`），最后回落到 clash。
- 响应头必带 `Subscription-Userinfo: upload=..; download=..; total=..; expire=..`（客户端会显示流量条）。
- 内容不允许缓存：`Cache-Control: no-store`。
- `short_code` 不是密钥，但泄漏等于送人流量，所以支持一键重置短码。

## 5. 本轮先做两个渲染器

| id | 目标 | 说明 |
|---|---|---|
| `clash` | mihomo / Stash / Clash Verge | `proxies:` + `proxy-groups:`（select + url-test）+ 最小 `rules:` |
| `uri` | Shadowrocket / v2rayN / 通用 | 每行 `vless://` `vmess://` `trojan://` `ss://` |

Surge / sing-box 等第二轮补——它们的差异主要在配置文件骨架，不在节点表达，等 `SubNode` 被两种格式验证过再加更稳。

### 5.1 已注册的客户端格式

后端注册表（`subscribe::exporter_ids()`）当前包含：

| id | 目标客户端 | 形态 |
|---|---|---|
| `clash` | mihomo / Clash Verge | YAML：`proxies` + `proxy-groups` + `rules` |
| `mihomo` | mihomo / Clash Meta | **完整** YAML：`ipv6` + `dns` + `proxies` + `proxy-groups` + `rules`，可直接导入 |
| `stash` | Stash | Clash 兼容 YAML，首行加 `# stash` |
| `surge` | Surge | INI：`[Proxy]` / `[Proxy Group]` / `[Rule]` |
| `egern` | Egern（iOS） | **Surge 兼容** INI：复用 Surge 生成器，文件头加 Egern 标识 |
| `surfboard` | Surfboard | INI，Surge 的 Android 变体 |
| `loon` | Loon | INI，WS 使用 `obfs-*` 字段 |
| `qx` | Quantumult X | INI：`[server_local]` / `[policy]` / `[filter_local]` |
| `singbox` | sing-box | JSON：`outbounds` + `route.rules` |
| `uri` | 通用 / v2rayN | 每行一条 `vless://` / `vmess://` / `trojan://` / `ss://` |
| `shadowrocket` | Shadowrocket | base64 的 URI 列表 |
| `v2ray` | V2RayN / NG | base64 的 URI 列表（与 `shadowrocket` 同族） |

> **关于 `egern` 的假设（Assumption）**
>
> Egern 是 iOS 客户端，官方支持导入 Surge 配置。我们无法访问它的完整规范文档，
> 因此 `egern` **复用 Surge 导出器的内容生成逻辑**（同一个内部函数，不是复制一份），
> 输出 Surge 兼容 profile，并在文件头加 Egern 标识注释：
> `#!MANAGED-CONFIG` 是 Surge 家族的 managed-config 标记（`?target=surge` 目前不带
> 文件头，保持升级前的逐字节输出），后面两行中英双语说明「按 Surge 兼容格式输出」。
> `Content-Type` 与 Surge 一致，为 `text/plain; charset=utf-8`。
>
> **这不是「完整支持 Egern」**：若 Egern 后续要求专有字段（专有传输、专有规则语法等），
> 需要单独适配，届时再补独立渲染器。
>
> Egern is an iOS client that officially supports importing Surge profiles. We do
> not have access to its complete specification, so `egern` **reuses the Surge
> exporter's content generation logic** (one shared internal function, not a
> copy) and emits a Surge-compatible profile with an Egern marker comment in the
> header. `#!MANAGED-CONFIG` is the Surge-family managed-config marker
> (`?target=surge` currently emits no header, preserving its previous
> byte-for-byte body), followed by two bilingual note lines stating that the
> output is Surge-compatible. The `Content-Type` matches Surge:
> `text/plain; charset=utf-8`.
>
> **This is not "full Egern support"**: if Egern later requires proprietary
> fields (custom transports, rule syntax, …), a dedicated adapter will be
> needed.

文件头的实际形态（`?target=egern`）：

```text
#!MANAGED-CONFIG
# Egern（Surge 兼容）：按 Surge 格式输出；若 Egern 后续要求专有字段，需要单独适配。
# Egern (Surge-compatible): exported as a Surge profile; if Egern later requires proprietary fields, a dedicated adapter is needed.
[Proxy]
```

`?target=surge` 不带以上三行，正文与 `egern` 去掉文件头后逐字节一致（单测覆盖）。

### 5.2 `mihomo`：完整可导入配置 / Complete, directly-importable config

`?target=clash` 一直是「兼容骨架」：顶层只有 `mixed-port` / `allow-lan` / `mode` /
`log-level`，没有 `ipv6`、`dns`，分组是 `PROXY` / `AUTO` / 地区组。`?target=mihomo`
输出的是**完整配置**，客户端可直接导入：

| 顶层 | 内容 |
|---|---|
| `mixed-port` / `allow-lan` / `mode` / `log-level` | `7890` / `false` / `rule` / `info` |
| `ipv6` | `true` |
| `dns` | `fake-ip`，`198.18.0.1/16`，阿里 + Cloudflare DoH |
| `proxies` | 与 `clash` **逐字段相同**（共用 `clash_proxy`，不复制第二份节点表达） |
| `proxy-groups` | `节点选择`（`select`，含 `自动选择` + 每个节点）、`自动选择`（`url-test`，300s） |
| `rules` | 默认 `GEOIP,CN,DIRECT` + `MATCH,节点选择` |

关键约定：

- **节点名同源**：与 `clash` 用同一个 `SubNode::name`，也就是端点 `dedupe_names`
  处理后的名字（跨服务器重名会追加 ` (2)`），组里引用的名字与 `proxies` 里的逐字节一致。
- **无节点也合法**：`proxies: []`；两个组仍存在，但组内 `proxies: []`；规则仍是
  `GEOIP,CN,DIRECT` + `MATCH,节点选择`（组存在，所以引用合法），能直接导入。
- **规则策略映射**：`DIRECT` 保留，`REJECT` / `REJECT-DROP` 映射为 `REJECT`；
  `PROXY`、`AUTO` 以及地区组名统一映射到 `节点选择`（这份配置只有两个组）。
  mihomo 无法安全表达的类型（例如没有 `rule-providers` 的 `RULE-SET`）跳过并告警；
  一条都映射不了时回落到内置两条，`rules:` 段永不为空。
- **转义**：节点名与规则全部走 `yaml_string` 的双引号转义，`:`、`#`、空格、引号、
  反斜杠、逗号、`]` 都不会破坏 YAML（含 flow 序列里的组内成员）。
- **内容协商**：`?target=mihomo`，`Content-Type: text/yaml; charset=utf-8`。
  UA 嗅探保持旧行为（`mihomo` UA 仍选 `clash`），要完整配置需显式带 `?target=mihomo`。

> `?target=clash` has always been a minimal compatible skeleton: `mixed-port`, `allow-lan`,
> `mode`, `log-level`, no `ipv6` / `dns`, with `PROXY` / `AUTO` / region groups.
> `?target=mihomo` emits a **complete** config that can be imported as-is: `ipv6: true`,
> a fake-ip `dns` block, the same `proxies` as `clash` (shared `clash_proxy`, not a second
> implementation), a `节点选择` selector group, a `自动选择` url-test group, and rules that
> map onto those groups.
>
> Node names come from the same `SubNode::name` as `clash`, i.e. after the endpoint's
> `dedupe_names` (` (2)` suffix for duplicates across servers), so group members match the
> `proxies` entries byte for byte. With no nodes the config is still importable: `proxies: []`,
> both groups kept with `proxies: []`, and the same `GEOIP,CN,DIRECT` + `MATCH,节点选择`
> rules. Policies are mapped (`DIRECT` kept, `REJECT*` → `REJECT`, everything else →
> `节点选择`); rule types mihomo cannot express safely are skipped with a warning, falling
> back to the built-in rules if none survive. Every name and rule goes through the
> double-quote escaping helper, so `:`, `#`, spaces, quotes, backslashes, commas and `]`
> cannot break the YAML. `Content-Type` is `text/yaml; charset=utf-8`. UA sniffing keeps its
> previous behaviour (`mihomo` UA → `clash`); request the complete config explicitly with
> `?target=mihomo`.

## 6. 分组策略

先把「分组」做成纯函数而不是模板拼接：

- 默认组 `PROXY`（select）：手动选择
- `AUTO`（url-test）：间隔 300s，容差 50ms
- 地区组：从节点名里匹配 `香港|台湾|日本|新加坡|美国|韩国|英国|德国` 等关键词自动归组，
  匹配不到进 `其他`

规则集第一版只做「国内直连 + 其余走 PROXY」，复杂的路由留给后面的「覆写管理」。

## 7. 闭环：服务端也要有同一份凭据（下一轮）

派生凭据只解决了「发给客户端的那一份」。**服务器 inbound 里必须有匹配的 client，否则用户连不上。**
`build_config()` 现在原样透传 `settings.clients`（通常是空数组），这就是当前最大的断点。

### 7.1 授权模型（MVP）

用户能拿到哪些节点，按套餐实例判定：

```
可见节点 = 该服务器上 enabled=1 的节点
受众     = status='active' 且至少有一个未过期 user_package 的用户
```

没有套餐的用户 → 订阅返回 200 + 空 `proxies`（客户端显示「无节点」，与「是否绑定套餐」的 FAQ 语义一致）。
包级的节点白名单（`packages.node_tags`）留到下一轮，本轮不做。

### 7.2 生成 client

对每个 (用户, 节点) 注入一条 client，`email` 固定为 `{user_id}@{node_tag}`（流量归因靠它）：

| 协议 | 字段 |
|---|---|
| vless | `id` = sub_uuid，`flow` 沿用片段，`email` |
| vmess | `id` = sub_uuid，`alterId` = 0，`email` |
| trojan | `password` = sub_uuid，`email` |
| shadowsocks | 2022：`password` = ss2022_user_key（**长度随方法**：AES-128 16 字节、AES-256 32 字节；user **不带** method）；旧 AEAD：`password` = sub_uuid + 自己的 `method`；`email` |

> Shadowsocks 的密码形态随方法不同：SS2022 多用户下客户端密码是
> `ServerPassword:UserPassword`（服务端密钥在前），旧 AEAD 多用户下用户密码就是客户端密码。
> 导出器统一走 `SubNode::ss_client_password()`，不允许直接读 `params["password"]`。
>
> SS2022 的每用户密钥长度必须与方法一致：Xray 会按方法的 `KeySaltLength` 校验每个 user 的
> `password`，长度不符会让它**拒绝加载整份配置**（不是只让这个用户连不上）。另外 Xray 的
> SS2022 多用户只支持 `2022-blake3-aes-*`；`2022-blake3-chacha20-poly1305` 只能单用户使用，
> 带授权用户时订阅与下发配置都会跳过该节点并告警。密钥输入接受标准 / URL-safe base64、
> 带不带 padding、多余 `=`，落盘与订阅统一写成标准 base64。
>
> The Shadowsocks client password depends on the method: for SS2022 it is
> `ServerPassword:UserPassword`, while legacy AEAD uses the per-user password as-is.
> Exporters must go through `SubNode::ss_client_password()` instead of reading
> `params["password"]` directly.
>
> The SS2022 per-user key length must match the method (16 bytes for AES-128, 32 bytes for
> AES-256). Xray validates every user key against the method's `KeySaltLength` and refuses to
> load the **entire** config on a mismatch. Xray's SS2022 multi-user mode also only supports
> `2022-blake3-aes-*`; `2022-blake3-chacha20-poly1305` is single-user only, so a node that has
> granted users is skipped (with a warning) in both the rendered config and the subscription.
> Keys accept standard / URL-safe base64 with or without padding and any trailing `=`; both the
> config and the subscription are written in canonical standard base64.

`build_config(server, nodes, users)` 的签名变化会波及 `nodes::apply` 与 agent 侧（不需要改协议，只改配置内容）。

**代价要写在明处**：生成复杂度是 O(用户 × 节点)，200 用户 × 10 节点 = 2000 条 client。
这是这类面板的固有形态（离线算一次，Xray 启动时加载），但 apply 会变慢，后续要做增量与缓存。

### 7.3 REALITY 的 publicKey：用 x25519 反推

现行片段只有 `privateKey`，客户端要 `publicKey`。两种解法里选**反推**：

```
publicKey = base64url_no_pad( X25519(privateKey_bytes, basepoint) )

> 编码必须是 **URL-safe 且无填充**，与 `xray x25519` 的输出一致。标准 base64 的
> `+ / =` 会让 v2rayN / Clash.Meta / sing-box 解析失败——密钥字节是对的，节点却连不上。
```

理由：面板不该要求管理员手填一对数学上绑定的密钥；手填错了要等用户连不上才发现。
片段里若已显式给了 `publicKey`（导入的配置），以显式值为准。

依赖 `x25519-dalek`，用 RFC 7748 §6.1 的官方测试向量做单测：
`a = 77076d0a...2c2a` → `pub = 8520f009...4e6a`。

### 7.4 顺带修掉

- `?target=singbox|surge` 目前静默回落成 clash，等于把 YAML 塞给 sing-box 用户 → 改成 400 + 支持列表。
- 节点名跨服务器重名已在端点做 `(2)` 后缀，要求**按 server_id 排序生成**，保证每次订阅顺序稳定，否则客户端每次刷新都重命名节点。
