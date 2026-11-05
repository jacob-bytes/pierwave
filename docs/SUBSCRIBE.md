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

## 6. 分组策略

先把「分组」做成纯函数而不是模板拼接：

- 默认组 `PROXY`（select）：手动选择
- `AUTO`（url-test）：间隔 300s，容差 50ms
- 地区组：从节点名里匹配 `香港|台湾|日本|新加坡|美国|韩国|英国|德国` 等关键词自动归组，
  匹配不到进 `其他`

规则集第一版只做「国内直连 + 其余走 PROXY」，复杂的路由留给后面的「覆写管理」。
