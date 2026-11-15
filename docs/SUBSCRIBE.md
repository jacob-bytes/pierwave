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
| `singbox-full` | sing-box | **完整** JSON：`log` + `dns` + `inbounds`(mixed) + `outbounds` + `route`，可直接 `sing-box run -c` |
| `surge-full` | Surge | **完整** profile：`[General]` + `[Proxy]` + `[Proxy Group]` + `[Rule]` |

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

### 5.3 `singbox-full`：完整可运行配置 / Complete, runnable config

`?target=singbox` 只输出片段（`log.level` + `outbounds` + `route`）；`?target=singbox-full`
补成可直接 `sing-box run -c` 的完整配置（面向 sing-box 1.12+ 的新配置格式）：

| 顶层 | 内容 |
|---|---|
| `log` | `level: info`，`timestamp: true` |
| `dns` | 两个 `type: https` 的 DoH server：国内走 `detour: direct`，其余走 `detour: selector`；`final: dns-remote` |
| `inbounds` | 一条 `mixed`：`127.0.0.1:7890` |
| `outbounds` | 节点出站 + `AUTO`（`urltest`）+ `selector` + `direct` |
| `route` | 规则模板映射出的 `rules`、`final`、`auto_detect_interface: true` |

关键约定：

- **节点字段同源**：节点出站复用 `singbox_outbound`，分组复用同一份生成逻辑，
  所以 `server` / `server_port` / `uuid` / `password` / `method` / `tls.server_name`
  与 `?target=clash` 的 `proxies` 逐字段一致（解析后比较，单测覆盖）。
- **不用 legacy 特殊出站**：sing-box 1.13 移除了 `block` / `dns` 特殊出站，完整配置
  把 `REJECT` 规则映射成 `action: reject`；`MATCH,REJECT` 不能当 `route.final`，改成
  末尾一条无条件 `reject` 规则，`final` 仍指向真实存在的 `selector`。
- **无节点也合法**：五个顶层小节都在，`selector` 只含 `direct`，`route.final` 指向它，
  DNS `detour` 指向真实存在的出站；不会输出空文件或缺字段的骨架。
- **转义**：节点名与组引用都走 `serde_json`，引号、反斜杠、换行不会破坏 JSON。
- **内容协商**：`?target=singbox-full`，`Content-Type: application/json; charset=utf-8`；
  UA 嗅探保持旧行为（`sing-box` UA 仍选 `singbox` 片段），要完整配置需显式带 `target`。
- 兼容性边界：`?target=singbox` 片段为了保持逐字节兼容，仍保留 legacy `block` 出站
  （sing-box 1.13+ 会拒绝该字段）；新版本客户端请用 `singbox-full`。

> `?target=singbox` only emits a fragment (`log.level` + `outbounds` + `route`);
> `?target=singbox-full` completes it into a config that can be run directly with
> `sing-box run -c`, targeting the sing-box 1.12+ config format: `log` (level + timestamp),
> two `type: https` DoH servers (domestic via `detour: direct`, the rest via
> `detour: selector`), a `mixed` inbound on `127.0.0.1:7890`, node outbounds plus `AUTO`
> (urltest), `selector` and `direct`, and a `route` with the mapped rules, `final` and
> `auto_detect_interface`.
>
> Node outbounds reuse `singbox_outbound` and the grouping logic is shared, so `server`,
> `server_port`, `uuid`, `password`, `method` and `tls.server_name` match the `proxies` of
> `?target=clash` field by field (verified by parsing both in tests). Legacy special
> outbounds are not emitted — sing-box 1.13 removed `block` / `dns` — so `REJECT` rules
> become `action: reject`, and `MATCH,REJECT` (which cannot be `route.final`) becomes a
> trailing unconditional `reject` rule while `final` keeps pointing at a real `selector`.
> With no nodes all five top-level sections are still present, `selector` contains only
> `direct`, `route.final` points at it and every DNS `detour` refers to an existing outbound
> — never an empty file or a skeleton with missing fields. Names go through `serde_json`,
> so quotes, backslashes and newlines cannot break the JSON. `Content-Type` is
> `application/json; charset=utf-8`; UA sniffing keeps its previous behaviour (`sing-box`
> UA → the `singbox` fragment), so request the full config explicitly. Compatibility
> boundary: the `singbox` fragment keeps its legacy `block` outbound for byte-for-byte
> compatibility (rejected by sing-box 1.13+); use `singbox-full` with newer clients.

### 5.4 `surge-full`：四段齐全的完整 profile / Complete four-section profile

`?target=surge` 是片段（`[Proxy]` / `[Proxy Group]` / `[Rule]`）；`?target=surge-full`
补上 `[General]`，四段齐全，可直接导入：

| 段落 | 内容 |
|---|---|
| `[General]` | `loglevel` / `dns-server` / `skip-proxy` / `bypass-system` / `ipv6` / `test-timeout` / 两条测速 URL |
| `[Proxy]` | 节点行（与 `surge` 逐字节相同） |
| `[Proxy Group]` | `PROXY`（select）+ `AUTO`（url-test）+ 地区组 |
| `[Rule]` | 规则模板映射 + 兜底 `FINAL,PROXY` |

关键约定：

- **正文同源**：`[Proxy]` / `[Proxy Group]` / `[Rule]` 直接复用 `render_ini(IniFlavor::Surge)`，
  去掉 `[General]` 后与 `?target=surge` 逐字节一致（单测覆盖），不存在第二份节点映射。
- **与 clash 字段一致**：解析 `[Proxy]` 行后，`server` / `port` / `username`(uuid) /
  `password` / `sni` / `encrypt-method` 与 clash 的 `proxies` 逐字段一致。
- **无节点也合法**：四段都在，`[Proxy]` 为空，`PROXY = select, DIRECT`，规则仍以
  `FINAL,PROXY` 结尾（策略存在，引用合法）。
- **转义**：节点名走 `ini_name`（`,` → `，`、`=` → `＝`、换行/制表 → 空格），
  组内引用用同一套转义后的名字，节点行不会被逗号或等号截断。
- **内容协商**：`?target=surge-full`，`Content-Type: text/plain; charset=utf-8`。

> `?target=surge` is a fragment (`[Proxy]` / `[Proxy Group]` / `[Rule]`); `?target=surge-full`
> adds `[General]` so all four sections are present and the profile can be imported as-is.
> The other three sections reuse `render_ini(IniFlavor::Surge)`, so stripping `[General]`
> leaves a body byte-identical to `?target=surge` (covered by a unit test) — there is no
> second node mapping. Parsing the `[Proxy]` lines shows `server`, `port`, `username` (uuid),
> `password`, `sni` and `encrypt-method` match clash's `proxies` field by field. With no
> nodes all four sections remain, `[Proxy]` is empty, `PROXY = select, DIRECT`, and the rules
> still end with `FINAL,PROXY` (the policy exists, so the reference is valid). Names go
> through `ini_name` (`,` → `，`, `=` → `＝`, newlines/tabs → spaces) and group members use
> the same escaped names, so a comma or equals sign cannot truncate a proxy line.
> `Content-Type` is `text/plain; charset=utf-8`.

## 6. 分组策略

先把「分组」做成纯函数而不是模板拼接：

- 默认组 `PROXY`（select）：手动选择
- `AUTO`（url-test）：间隔 300s，容差 50ms
- 地区组：从节点名里匹配 `香港|台湾|日本|新加坡|美国|韩国|英国|德国` 等关键词自动归组，
  匹配不到进 `其他`

规则集第一版只做「国内直连 + 其余走 PROXY」，复杂的路由留给后面的「覆写管理」。

### 6.1 订阅模板（迁移 0052）/ Subscription templates (migration 0052)

写死的 `PROXY` / `AUTO` / 按中文名猜地区只覆盖最朴素的场景。模板把「分组」变成
管理员可配置的声明式数据。第一轮只对 `mihomo` 与 `clash` 生效；第二轮（§6.2）把
`stash` / `singbox` / `singbox-full` / `surge` / `surge-full` 也接入，其余导出器保持原样。

> The hard-coded `PROXY` / `AUTO` / name-guessed region groups only cover simple cases.
> Templates turn grouping into declarative admin-managed data. Round one applied **only to
> `mihomo` and `clash`**; round two (§6.2) also wires up `stash`, `singbox`, `singbox-full`,
> `surge` and `surge-full`, while every other exporter stays unchanged.

```
subscription_templates(id, name, groups_json, created_at, updated_at)
users.subscription_template_id / packages.subscription_template_id
nodes.tags (JSON 数组) / nodes.region (单值)
```

`groups_json` 结构与语义：

```jsonc
[
  { "name": "节点选择", "type": "select",
    "filters": [ { "tags": ["香港"], "regions": ["HK"], "protocols": ["vless"] } ],
    "include_auto": true },
  { "name": "自动选择", "type": "url-test", "filters": [ {} ], "interval": 300 }
]
```

- **声明式，不允许脚本**：未知字段在反序列化阶段被拒绝（`deny_unknown_fields`），
  组类型只接受 `select` / `url-test`；校验在写入前完成（组名必填且唯一、每组至少
  一个 filter、filter 值长度上限、`url-test` 的 `interval` 在 10–86400 秒）。
- **AND / OR**：一个 filter 内的 `tags` / `regions` / `protocols` 必须同时命中
  （空数组 = 不限制；空对象 `{}` = 全部节点）；多个 filter 之间是 **OR**，
  按声明顺序拼接后去重。
- **成员顺序**：始终按节点在订阅里的原始顺序（`created_at`），不按 filter 重排。
  `select` 的成员 = 自动选择组（`include_auto` 且模板里存在存活的 url-test 组）
  + 各 filter 命中的节点 + `DIRECT`；`url-test` 的成员 = 命中的节点。
- **空组跳过**：命中 0 个节点的组不会生成（Clash/mihomo 会拒绝 `proxies: []`），
  并在预览接口的 `warnings` 里说明；`select` 即使只命中 `DIRECT` 也算空组。
- **全空回落**：模板存在但所有组都没命中时，回落旧硬编码分组（`PROXY` / `AUTO` /
  地区组），输出与升级前逐字节一致；没有任何模板时同理（golden 覆盖）。
- **规则策略映射**：模板生效时，`rules` 仍来自规则模板，但策略列会映射到
  第一个存活的 `select` 组（没有 select 时映射到第一个组），避免引用不存在的
  `PROXY` / 地区组；`DIRECT` / `REJECT*` 与模板里真实存在的组名保持原样。
- **绑定优先级**：`user.subscription_template_id` > 最近创建的、绑定了模板的生效套餐
  > 无模板。多个生效套餐时取「`subscription_template_id` 非空的最新创建」那一个，
  而不是「最新套餐的绑定列」——新卡没配模板时不应覆盖旧卡上明确配置过的分组。

管理接口（管理员）：

```
GET/POST    /api/v1/subscription-templates
PATCH/DELETE/api/v1/subscription-templates/{id}
POST        /api/v1/subscription-templates/{id}/preview   { "user_id": "..." }
            → { "yaml": "...", "warnings": ["..."] }
```

预览用真实用户的节点与规则模板渲染 `mihomo` 完整配置，返回的就是用户拿到的内容；
`warnings` 同时包含模板告警（空组、`include_auto` 无可用自动组、全空回落）与
「该用户当前没有可用节点」的提示。

> The hard-coded `PROXY` / `AUTO` / name-guessed region groups only cover simple cases.
> Templates turn grouping into declarative admin-managed data, and apply **only to
> `mihomo` and `clash`** — every other exporter is unchanged.
>
> `groups_json` is declarative, never scripted: unknown fields are rejected at
> deserialization (`deny_unknown_fields`), group types are limited to `select` /
> `url-test`, and validation runs before writing (group name required and unique, at
> least one filter per group, per-value length caps, `url-test` interval 10–86400s).
> Conditions inside one filter (`tags` / `regions` / `protocols`) are AND-ed (an empty
> array means "no restriction"; `{}` means all nodes); filters are OR-ed in declaration
> order and de-duplicated. Members always keep the subscription's node order. `select`
> members are the auto group (when `include_auto` is set and a surviving `url-test`
> group exists) plus matched nodes plus `DIRECT`; `url-test` members are the matched
> nodes. A group with zero matching nodes is skipped (Clash/mihomo reject
> `proxies: []`) and reported in the preview's `warnings`; a `select` that only has
> `DIRECT` counts as empty. If a template exists but no group matches, rendering falls
> back to the legacy hard-coded groups — byte-identical to before the feature (golden
> test), exactly like having no template at all. Rules still come from the rule
> template, but when a template is active the policy column is remapped to the first
> surviving `select` group (or the first group when there is no `select`), while
> `DIRECT` / `REJECT*` and real group names are preserved.
>
> Binding priority: `user.subscription_template_id` > the latest created active package
> that actually has a template > no template. With multiple active packages the newest
> one **whose binding is non-null** wins, not simply the newest package's column: a new
> card without a template must not override groups explicitly configured on an older
> card. Admins manage templates through `/api/v1/subscription-templates`, and
> `POST /{id}/preview` renders the `mihomo` config for a real user together with the
> template warnings.

### 6.2 订阅模板第二轮：新组类型、排除条件与多格式 / Round two: new group kinds, exclusions, more formats

#### 6.2.1 `groups_json` 新结构（只增字段）/ New `groups_json` shape (additive only)

```jsonc
[
  {
    "name": "故障转移",
    "type": "fallback",                 // select | url-test | fallback | load-balance
    "filters": [
      {
        "tags": ["香港"],                 // 包含条件之间 AND
        "regions": ["HK"],
        "protocols": ["vless"],
        "name_contains": "HK",           // 大小写不敏感子串；不是正则
        "exclude_tags": ["中转"],         // 排除优先：命中任意一条就出局
        "exclude_regions": ["US"],
        "exclude_protocols": ["ss"]
      }
    ],
    "interval": 60                       // 自动测速类组：url-test / fallback / load-balance
  },
  {
    "name": "负载均衡",
    "type": "load-balance",
    "strategy": "consistent-hashing",    // round-robin（缺省）| consistent-hashing
    "filters": [{}]
  }
]
```

向后兼容：

- 新字段全部带默认值：旧模板（第一轮写入的 `groups_json`）反序列化后
  `exclude_*` 为空、`name_contains` 为 `None`、`strategy` 为 `None`，语义不变；
- `select` 仍会把 `interval` / `strategy` 清空；`load-balance` 未写 `strategy`
  时在落库前显式规范化为 `round-robin`；
- **不需要数据库迁移**：表结构没变，只是 `groups_json` 里多了可选键；
- 校验仍是「声明式、不允许脚本」：未知字段在反序列化阶段被拒绝，
  `type` 只接受四种值，`name_contains` 有 64 字符上限。

> All new fields have defaults. Templates written in round one deserialize with empty
> `exclude_*`, no `name_contains` and no `strategy`, so their behaviour is unchanged.
> `select` still drops `interval` / `strategy`; `load-balance` without `strategy` is
> normalized to `round-robin` before writing. **No database migration is needed**: the
> table is unchanged, only optional keys are added inside `groups_json`. Validation stays
> declarative (no scripts): unknown fields are rejected at deserialization, `type` accepts
> exactly four values, and `name_contains` is capped at 64 characters.

排除语义：同一个 filter 内先看排除条件，命中任意一条 `exclude_*` 就不进该组；
没被排除时才按 `tags` / `regions` / `protocols` / `name_contains` 做 AND。
只有排除条件（例如 `{"exclude_tags":["测试"]}`）仍是合法 filter，表示「全部节点
减去测试标签」。`{}` 依旧表示全部节点。

> Exclusions are evaluated first inside a filter: any matching `exclude_*` drops the node
> from the group. Only then are `tags` / `regions` / `protocols` / `name_contains` AND-ed.
> A filter with exclusions only (e.g. `{"exclude_tags":["test"]}`) is valid and means
> "all nodes except those tagged test". `{}` still means all nodes.

#### 6.2.2 各格式的表达能力 / What each format can express

| 格式 | select | url-test | fallback | load-balance | consistent-hashing |
|---|---|---|---|---|---|
| `clash` / `mihomo` | ✅ | ✅ | ✅ | ✅ `strategy` | ✅ |
| `stash` | ✅ | ✅ | ✅ | ✅ `strategy`（与 Clash 同形） | ✅ |
| `surge` / `surge-full` | ✅ | ✅ | ✅ | ✅ 轮询语法 | ❌ 跳过该组 + warning |
| `singbox` / `singbox-full` | ✅ `selector` | ✅ `urltest` | ✅ `fallback` | ⚠️ 用 `urltest` 近似 + warning | ⚠️ 近似 |

无法表达的组合**跳过该组并 warning**，绝不输出会被客户端整份拒收的配置；如果所有组
都被跳过（或模板本来就没有命中节点），渲染层回落到内置 `PROXY` / `AUTO` / 地区组，
输出与没有模板时逐字节一致。`stash` 直接复用 Clash 生成器（首行 `# stash` 标识），
Stash 与 Clash 的组字段差异（`strategy` 等）目前同形，所以没有第二份 YAML 逻辑。
其它格式（`egern` / `surfboard` / `loon` / `qx` / `uri` / `shadowrocket` / `v2ray`）
本轮不接模板，行为与第一轮一致。

> Combinations a client cannot express are **skipped with a warning** — never emitted as an
> invalid config. If every group is skipped (or no group matches any node), rendering falls
> back to the built-in `PROXY` / `AUTO` / region groups, byte-identical to having no
> template. `stash` reuses the Clash generator (with a leading `# stash` marker); Stash and
> Clash currently share the same group fields (`strategy`, …), so there is no second YAML
> implementation. Other formats (`egern`, `surfboard`, `loon`, `qx`, `uri`, `shadowrocket`,
> `v2ray`) do not consume templates in this round and keep their round-one behaviour.

#### 6.2.3 真实渲染片段 / Real rendered snippets

Clash / mihomo / stash（Templates → `proxy-groups`）：

```yaml
proxy-groups:
  - name: "故障转移"
    type: fallback
    url: "http://www.gstatic.com/generate_204"
    interval: 60
    proxies:
      - "香港-1"
  - name: "负载均衡"
    type: load-balance
    url: "http://www.gstatic.com/generate_204"
    interval: 300
    strategy: consistent-hashing
    proxies:
      - "日本-1"
```

Surge / surge-full（`[Proxy Group]`）：

```text
故障转移 = fallback, 香港-1, url=http://www.gstatic.com/generate_204, interval=60
负载均衡 = load-balance, 日本-1, url=http://www.gstatic.com/generate_204, interval=300
```

surge 会把 `MATCH,PROXY` 映射成 `FINAL,故障转移` 这类指向真实组的兜底规则；
`load-balance + consistent-hashing` 在 Surge 下被跳过，`warnings` 里会看到：

```text
代理组「负载均衡」的类型 load-balance 无法在 surge 中表达，已跳过 / Group "负载均衡" of type load-balance cannot be expressed in surge; skipped
```

sing-box / sing-box-full（`outbounds`，组按模板顺序输出）：

```json
{
  "type": "fallback",
  "tag": "故障转移",
  "outbounds": ["香港-1"],
  "url": "http://www.gstatic.com/generate_204",
  "interval": "60s"
}
```

`load-balance` 在 sing-box 里没有原生类型，输出 `"type": "urltest"`，并附 warning：

```text
代理组「负载均衡」是 load-balance，singbox 没有该组类型，已用 urltest 近似 / Group "负载均衡" is load-balance, which singbox cannot express; approximated with urltest
```

> The snippets above are also covered by unit tests for all four formats (clash / mihomo /
> stash, surge / surge-full, singbox / singbox-full). Surge maps `MATCH,PROXY` to a
> `FINAL,<real group>` fallback; `load-balance + consistent-hashing` is skipped there with
> the warning shown above. sing-box has no native load-balance, so it is emitted as
> `urltest` with the approximation warning.

#### 6.2.4 预览接口 / Preview API

`POST /api/v1/subscription-templates/{id}/preview` 新增可选 `target`（兼容别名
`format`）：

```jsonc
{ "user_id": "...", "target": "sing-box" }
→ { "yaml": "...", "format": "singbox", "warnings": ["..."] }
```

- 缺省仍渲染 `mihomo`（`format: "mihomo"`），`yaml` 字段名保持不变；
- 模糊匹配大小写、空格、下划线：`Mihomo` / `Clash` / `Clash Meta` / `Stash` /
  `sing-box` / `sing box full` / `Surge` / `surge full` 都能解析；
  可切换格式至少覆盖 `mihomo` / `clash` / `stash` / `singbox` / `singbox-full` /
  `surge` / `surge-full`；
- `warnings` 与真实渲染共用 `plan_for_format`：空组、格式无法表达的组
  （跳过）、`load-balance` 被近似、全空回落都会原样返回；
- 不支持模板的格式（`loon` / 未知 id）返回 400
  `subscription_template.preview_format_unsupported`，而不是把 YAML 塞回去；
- **按套餐预览本轮未做**：预览仍然只接受 `user_id`。

> The preview endpoint gains an optional `target` (alias `format`); omitting it still
> renders `mihomo` and keeps the `yaml` key. Format matching is case-, space- and
> underscore-insensitive and covers at least `mihomo`, `clash`, `stash`, `singbox`,
> `singbox-full`, `surge` and `surge-full`. Warnings come from the same `plan_for_format`
> used by real rendering, so skipped groups / approximations / fallbacks match the output.
> Formats without template support (e.g. `loon`, unknown ids) return 400
> `subscription_template.preview_format_unsupported`. **Previewing by package is not
> implemented in this round**: the endpoint still takes `user_id` only.

#### 6.2.5 编辑器 / Editor

- **拖拽排序**：组顺序就是输出顺序；卡片左侧手柄可拖，另提供上移/下移按钮
  （键盘与触屏可用）。后端不做额外排序，`proxy-groups` / `[Proxy Group]` /
  `outbounds` 都保持模板声明顺序。
- **复制模板**：列表里的复制按钮把模板复制成**草稿**（名称为 `<原名>（副本）`，
  自动避让重名），打开新建对话框；保存前不写库，改副本不影响原件。
- **按套餐预览**：第三轮已实现（见 §6.3.4）；选择器里用户与套餐分组展示。
- **预览切格式**：预览对话框里可选上述 7 种格式（第三轮增至 10 种），切换后重新生成。

> Drag-and-drop reorders groups (plus up/down buttons for keyboard and touch); the output
> keeps the template order. Duplicate opens the create dialog prefilled with a fresh draft
> named `<name> (copy)` and a de-duplicated name — nothing is written until saved, and
> editing the copy never touches the original. Previewing by package is implemented in
> round three (§6.3.4); the picker groups users and packages. The preview dialog can switch
> between the seven formats above (ten in round three).

### 6.3 订阅模板第三轮：更多格式、`include_auto` 扩展、按套餐预览与使用计数 / Round three: more formats, wider `include_auto`, package preview and usage counts

#### 6.3.1 新增接入的格式 / Newly template-aware formats

在第二轮的基础上，`surfboard` / `loon` / `egern` 也开始消费订阅模板。它们都复用已有的
INI 渲染器，**没有第二份节点映射**：`surfboard` / `loon` 走 `render_ini`，`egern` 继续
复用 Surge 兼容正文（文件头不变）。

各格式的表达能力（`subscription_template::group_capabilities`）：

| 格式 | select | url-test | fallback | load-balance | consistent-hashing |
|---|---|---|---|---|---|
| `clash` / `mihomo` / `stash` | ✅ | ✅ | ✅ | ✅ `strategy` | ✅ |
| `surge` / `surge-full` | ✅ | ✅ | ✅ | ✅ 轮询 | ❌ 跳过 + warning |
| `egern` | ✅ | ✅ | ✅ | ✅ 轮询（与 Surge 同一份 profile） | ❌ 跳过 + warning |
| `surfboard` | ✅ | ✅ | ✅ | ❌ 只有随机分配，整类跳过 + warning | ❌ 跳过 + warning |
| `loon` | ✅ | ✅ | ✅ | ✅ `algorithm=Round-Robin` | ❌ 跳过 + warning（只有 Random / PCC / Round-Robin） |
| `singbox` / `singbox-full` | ✅ `selector` | ✅ `urltest` | ✅ `fallback` | ⚠️ 用 `urltest` 近似 + warning | ⚠️ 近似 |

无法表达的组合**跳过该组并 warning**，绝不输出会被客户端整份拒收的配置；所有组都被
跳过时，渲染层回落到内置 `PROXY` / `AUTO` / 地区组，输出与没有模板时逐字节一致。

> `surfboard`, `loon` and `egern` now consume subscription templates too, reusing the
> existing INI renderer — there is no second node mapping (`surfboard` / `loon` go through
> `render_ini`, `egern` keeps reusing the Surge-compatible body and its header). Combinations
> a client cannot express are skipped with a warning and never emitted as an invalid config:
> Surfboard's `load-balance` is random-only, so the whole group kind is skipped; Loon can
> express round-robin (`algorithm=Round-Robin`) but has no consistent-hashing algorithm;
> Egern shares Surge's capability boundary. If every group is skipped, rendering falls back
> to the built-in groups byte-identically to having no template.

#### 6.3.2 `include_auto` 的新语义 / Wider `include_auto`

`select` 组开启 `include_auto` 后，不再只找「第一个存活的 `url-test` 组」，而是按
**`url-test` > `fallback` > `load-balance`** 的优先级取第一个存活的自动组；同一类型内
仍按模板声明顺序取第一个。旧模板只会写 `url-test`，所以行为与第一轮逐字节一致。

「存活」是**按目标格式**判定的：如果模板里的自动组在当前格式里无法表达（例如
Surfboard 里的 `load-balance`），`select` 的成员会重新挑选下一个可表达的自动组；
一个都没有时把该成员移除并 warning，**绝不留下指向不存在组的引用**。

> `include_auto` no longer stops at the first surviving `url-test` group: it picks the
> first surviving auto group in the order **url-test > fallback > load-balance** (declaration
> order within one kind). Templates written in round one only contain `url-test`, so their
> behaviour is byte-identical to before. "Surviving" is evaluated **per target format**:
> when the template's auto group cannot be expressed by that format (e.g. `load-balance`
> in Surfboard), the `select` members are rebuilt with the next expressible auto group; if
> none survives the member is removed with a warning, so no member ever points at a group
> that was not emitted.

#### 6.3.3 渲染片段 / Rendered snippets

Surfboard（`[Proxy Group]`，`load-balance` 被跳过）：

```text
节点选择 = select, 故障转移, 香港-1, 日本-1, DIRECT
故障转移 = fallback, 香港-1, url=http://www.gstatic.com/generate_204, interval=60
```

```text
代理组「负载均衡」的类型 load-balance 无法在 surfboard 中表达，已跳过 / Group "负载均衡" of type load-balance cannot be expressed in surfboard; skipped
```

Loon（轮询显式写 `algorithm=Round-Robin`）：

```text
节点选择 = select, 故障转移, 香港-1, 日本-1, DIRECT
故障转移 = fallback, 香港-1, url=http://www.gstatic.com/generate_204, interval=60
负载均衡 = load-balance, 香港-1, 日本-1, url=http://www.gstatic.com/generate_204, interval=90, algorithm=Round-Robin
```

`load-balance + consistent-hashing` 在 Loon 下被跳过：

```text
代理组「负载均衡」的类型 load-balance 无法在 loon 中表达，已跳过 / Group "负载均衡" of type load-balance cannot be expressed in loon; skipped
```

Egern（Surge 兼容：去掉 `#!MANAGED-CONFIG` 与两行注释后与 `?target=surge` 逐字节一致）：

```text
#!MANAGED-CONFIG
# Egern（Surge 兼容）：按 Surge 格式输出；若 Egern 后续要求专有字段，需要单独适配。
# Egern (Surge-compatible): exported as a Surge profile; if Egern later requires proprietary fields, a dedicated adapter is needed.
[Proxy]
...
[Proxy Group]
节点选择 = select, 故障转移, 香港-1, 日本-1, DIRECT
故障转移 = fallback, 香港-1, url=http://www.gstatic.com/generate_204, interval=60
```

> The snippets above are locked by unit tests, one per new format, each including a group
> that is skipped with a warning. Egern's body (after stripping the managed-config header)
> is byte-identical to `?target=surge`.

#### 6.3.4 按套餐预览 / Preview by package

`POST /api/v1/subscription-templates/{id}/preview` 现在接受 `user_id` **或**
`package_id`，二选一：

```jsonc
{ "package_id": "...", "target": "loon" }
→ { "yaml": "...", "format": "loon", "warnings": ["..."] }
```

- 同时给 `user_id` 与 `package_id` → 400
  `subscription_template.preview_target_conflict`；一个都不给 → 400
  `subscription_template.preview_target_required`；套餐不存在 → 404 `package.not_found`。
- 按套餐预览使用**该套餐的节点范围**（`packages.node_scope` → `package_nodes`；
  未设范围 = 全部 enabled 节点）与**套餐自己的规则模板绑定**
  （`packages.rule_template_id` → 默认模板 → 内置两条）；被预览的分组仍然是路径里的
  模板 `id`，不会被套餐上的订阅模板绑定覆盖。
- 套餐预览没有具体用户，节点凭据是用确定性占位值派生的（`package-preview:{id}`），
  真实用户凭据按 `(user, node)` 派生，永远不同；预览的 `warnings` 会明确提示这一点。

> The preview endpoint now accepts `user_id` **or** `package_id` (exactly one). Passing
> both is a 400 `preview_target_conflict`; passing neither is a 400
> `preview_target_required`; an unknown package is a 404 `package.not_found`. A package
> preview uses that package's node scope (`node_scope` / `package_nodes`; unset = all
> enabled nodes) and its own rule-template binding (`rule_template_id` → default template
> → built-in rules); the groups still come from the template `id` in the path, never from
> the package's subscription-template binding. There is no user, so node credentials are
> deterministic placeholders (`package-preview:{id}`) — real credentials are derived per
> `(user, node)` and always differ; the response warnings state this explicitly.

#### 6.3.5 使用计数与删除确认 / Usage counts and delete confirmation

`GET /api/v1/subscription-templates` 的每一项新增 `usage`：

```jsonc
{ "id": "...", "name": "...", "groups": [], "created_at": 0, "updated_at": 0,
  "usage": { "users": 3, "packages": 1 } }
```

- 计数来自一条聚合 SQL（`repo::subscription_templates::usage_counts`），**不需要数据库迁移**；
  前端列表显示「被 N 个用户 / M 个套餐使用」，未使用时显示「未被使用」。
- 删除确认框在仍被使用时追加一句「删除后会解绑 N 个用户与 M 个套餐，它们的订阅立即
  回落到内置分组」；实际解绑仍由外键 `ON DELETE SET NULL` 完成，后端行为不变。

> Each list item gains `usage` (`users` / `packages`) from a single aggregate query
> (`usage_counts`) — **no migration**. The list shows "used by N users / M packages" (or
> "not in use"), and the delete confirmation adds an explicit unbind sentence when the
> template is still referenced. The actual unbinding is still done by
> `ON DELETE SET NULL`; backend deletion behaviour is unchanged.

#### 6.3.6 仍不支持模板分组的格式 / Formats that still ignore templates

| 格式 | 原因 |
|---|---|
| `qx`（Quantumult X） | `[policy]` 只有 `static` / `url-latency-benchmark`，没有 `fallback` / `load-balance`；混合模板只能静默降级，所以保持原行为。 |
| `uri` | 每行一条 URI，本身没有分组概念。 |
| `shadowrocket` / `v2ray` | base64 的 URI 列表，同样没有分组概念。 |

这些格式**忽略**模板：有模板与无模板的输出逐字节一致（单测覆盖）。预览接口对它们返回
400 `subscription_template.preview_format_unsupported`，不会把 YAML 塞回去。

> `qx` only has `static` / `url-latency-benchmark` and cannot express fallback or
> load-balance, so a mixed template would silently degrade; URI-list formats (`uri`,
> `shadowrocket`, `v2ray`) have no grouping concept at all. These formats ignore templates,
> so their output is byte-identical with or without one (covered by unit tests), and the
> preview endpoint returns 400 `subscription_template.preview_format_unsupported` instead of
> returning the wrong format.

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
