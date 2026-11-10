//! Xray 配置生成：纯函数，不依赖数据库与 HTTP，方便单元测试。
//!
//! 节点在库里只存「入站片段」（`config_json`），真正的完整配置由这里拼装。
//! 同样的输入必须得到同样的输出，且 `inbounds` 顺序严格等于传入节点顺序。

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::credentials;
use crate::error::DomainError;
use crate::models::{Node, Outbound, RoutingRule};
use crate::routing;

/// 一条授权：某个用户有资格使用某个节点。
///
/// `uuid` 是 `(master_secret, user_id, node_id)` 的 HMAC 派生凭据，必须在进入
/// `build_config` 之前算好（用 [`Grant::new`]），这样配置生成保持纯函数、不碰数据库。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub user_id: String,
    pub node_id: String,
    pub uuid: String,
    /// SS2022 每用户密钥（标准 base64）。
    ///
    /// SS2022 的方法决定密钥长度：AES-128 必须 16 字节，AES-256 / ChaCha20
    /// 必须 32 字节。长度写错会让 Xray **拒绝整份配置**，所以这里两档都算好
    /// （[`Grant::ss_key_for`] 按方法取）。旧 AEAD 方法不用它（沿用 UUID 当密码）。
    pub ss_key: String,
    /// AES-128 档的 SS2022 每用户密钥（16 字节，标准 base64）。
    pub ss_key_128: String,
    /// 套餐档位（kbps）；`None` / 0 = 不限，生成的 client 不带 `level`。
    pub speed_limit_kbps: Option<i64>,
}

impl Grant {
    /// 派生一个 (user, node) 子账户；同一个三元组永远得到同一份凭据。
    pub fn new(secret: &str, user_id: &str, node_id: &str) -> Self {
        Self {
            user_id: user_id.to_string(),
            node_id: node_id.to_string(),
            uuid: credentials::sub_uuid(secret, user_id, node_id),
            ss_key: credentials::ss2022_user_key_len(secret, user_id, node_id, 32),
            ss_key_128: credentials::ss2022_user_key_len(secret, user_id, node_id, 16),
            speed_limit_kbps: None,
        }
    }

    /// 给定 SS2022 方法应使用的每用户密钥。
    ///
    /// 长度不匹配会被 Xray 当成坏凭据直接拒绝加载配置，因此调用方**必须**
    /// 用这个方法而不是直接读 `ss_key`。
    pub fn ss_key_for(&self, method: &str) -> &str {
        match ss2022_key_len(method) {
            Some(16) => &self.ss_key_128,
            _ => &self.ss_key,
        }
    }

    /// 同 [`Grant::new`]，额外带上套餐限速档位；0 与负数按「不限」处理。
    pub fn limited(
        secret: &str,
        user_id: &str,
        node_id: &str,
        speed_limit_kbps: Option<i64>,
    ) -> Self {
        let mut grant = Self::new(secret, user_id, node_id);
        grant.speed_limit_kbps = speed_limit_kbps.filter(|kbps| *kbps > 0);
        grant
    }
}

/// 节点绑定到的证书文件路径。
///
/// `render` 先按证书 id 去重，再把「节点 → 路径」传进来；配置生成保持纯函数，
/// 不关心路径背后是哪个上传的证书。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeCertificate {
    pub node_id: String,
    pub cert_path: String,
    pub key_path: String,
}

/// 一次配置生成所需的全部事实。
///
/// P3 之前 `build_config(server_name, nodes, grants)` 用的是位置参数：每多一类
/// 输入（证书、出站、路由规则）都要改所有调用点。收成一个结构体后，主控的
/// `desired::render` 一次性装配，手动 apply / 断流对账 / Agent 重连补发天然
/// 拿到同一份输入；纯函数也只读这个结构，不关心数据来自哪张表。
///
/// 所有字段都是借用：调用方持有 `Vec`，配置生成不复制节点与规则。
#[derive(Debug, Clone, Copy)]
pub struct ServerPlan<'a> {
    /// 只在节点没有显式 tag 时用于生成兜底 tag。
    pub server_name: &'a str,
    /// 参与生成的节点；是否过滤 disabled 由调用方决定。
    pub nodes: &'a [Node],
    /// (用户, 节点) 授权集合，用于派生 client 凭据。
    pub grants: &'a [Grant],
    /// 节点绑定的证书路径；没有证书时传空切片。
    pub certs: &'a [NodeCertificate],
    /// 启用的自定义出站，按创建顺序；内置 direct/blocked/api 由生成器补。
    pub outbounds: &'a [Outbound],
    /// 启用的路由规则，按 `sort_order, created_at`；api 规则由生成器固定放首位。
    pub rules: &'a [RoutingRule],
}

impl<'a> ServerPlan<'a> {
    /// 最小计划：只有节点与授权，证书/出站/规则全空。
    ///
    /// 让「只关心 inbound」的单元测试和调用点不用手写六个字段。
    pub fn new(server_name: &'a str, nodes: &'a [Node], grants: &'a [Grant]) -> Self {
        Self {
            server_name,
            nodes,
            grants,
            certs: &[],
            outbounds: &[],
            rules: &[],
        }
    }
}

/// 生成可直接落盘的完整 Xray 配置。
///
/// * 每个节点的 `config_json` 是「入站对象去掉 tag/port/protocol」的片段。
///   片段里即便混入这三个字段也会被节点自身字段覆盖，避免双写不一致；
/// * 片段缺 `settings` / `stream` 时按协议补安全默认值；
/// * `grants` 是「有资格的用户 × 节点」的授权集合：每个 (用户, 节点) 生成一条
///   client 追加到该 inbound 的 `settings.clients`，`email = {user_id}@{node_tag}`。
///   片段里手工导入的 client 原样保留、排在派生 client 前面；`grants` 为空时不改
///   `clients`（保持历史行为）；
/// * `outbounds` = 内置 direct/blocked/api + 启用的自定义出站（按创建顺序），
///   自定义项的 `config_json` 合并进对象、`tag`/`protocol` 以数据库为准；
/// * `routing.rules` = api 规则固定第一 + 自定义规则（调用方已按排序取好），
///   只带非空匹配字段，`inboundTag` / `domain` / `ip` 均为数组。
pub fn build_config(plan: &ServerPlan) -> Value {
    build_config_impl(plan, plan.nodes)
}

/// 套餐档位 → Xray level 的稳定映射。
///
/// 只收集**实际出现**在授权集合里的正整数档位，升序后从 1 开始编号；
/// level 0 永远保留给「不限速」的用户（Xray 的默认 level）。
/// 用 `BTreeMap` 而不是 `HashMap`：同样的授权集合必须生成逐字节相同的配置。
fn speed_tiers(grants: &[Grant]) -> BTreeMap<i64, i64> {
    let mut tiers = BTreeMap::new();
    for grant in grants {
        if let Some(kbps) = grant.speed_limit_kbps.filter(|kbps| *kbps > 0) {
            tiers.entry(kbps).or_insert(0);
        }
    }
    for (index, level) in tiers.values_mut().enumerate() {
        *level = index as i64 + 1;
    }
    tiers
}

/// 生成 `policy.levels`：`"0"` 是默认档，之后每个限速档位一个 level。
///
/// 每个档位都必须带 `statsUserUplink/Downlink`，否则用户一被分到 level > 0，
/// Xray 就不再为该用户累计流量，计费会静默归零。
fn policy_levels(tiers: &BTreeMap<i64, i64>) -> Value {
    let mut levels = Map::new();
    levels.insert(
        "0".into(),
        json!({
            "statsUserUplink": true,
            "statsUserDownlink": true
        }),
    );
    for (kbps, level) in tiers {
        levels.insert(
            level.to_string(),
            json!({
                "bufferSize": buffer_size_kb(*kbps),
                "statsUserUplink": true,
                "statsUserDownlink": true
            }),
        );
    }
    Value::Object(levels)
}

/// 把套餐档位（kbps）近似换算成 Xray `bufferSize`（单位 KB）。
///
/// Xray 的 `bufferSize` 不是限速器：它是每个请求的内部缓冲，写操作要等
/// 缓冲区回落到该值以下才继续读，所以单条连接的粗吞吐约为
/// `bufferSize / RTT`。取一个固定 RTT = 50ms（跨国公网常见量级）：
///
/// ```text
/// bufferSize(KB) = kbps / 8 (KB/s) × 0.05s = kbps / 160
/// ```
///
/// 下限 16KB：文档明确说过 buffer 太小/为 0 会让 UDP 满缓冲直接丢包；
/// 上限 1GB 只是为了挡住异常输入。真实吞吐还会被 RTT、并发连接数、
/// mux 子流数放大或缩小，所以这是**近似**，不是精确带宽。
fn buffer_size_kb(kbps: i64) -> i64 {
    if kbps <= 0 {
        return 512;
    }
    (kbps / 160).clamp(16, 1_048_576)
}

fn build_config_impl(plan: &ServerPlan, nodes: &[Node]) -> Value {
    // 套餐档位 -> Xray level（1..N）。level 0 固定留给「没配限速」的用户。
    let tiers = speed_tiers(plan.grants);
    let mut inbounds: Vec<Value> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| {
            build_inbound(
                plan.server_name,
                index,
                node,
                plan.grants,
                plan.certs,
                &tiers,
            )
        })
        .collect();
    inbounds.push(api_inbound());

    let custom = custom_outbounds(plan.outbounds);
    let custom_tags: Vec<String> = custom
        .iter()
        .filter_map(|outbound| outbound.get("tag").and_then(Value::as_str))
        .map(str::to_string)
        .collect();

    let mut outbounds = builtin_outbounds();
    outbounds.extend(custom);

    let mut rules = vec![api_rule()];
    rules.extend(plan.rules.iter().filter_map(|rule| {
        let tag = rule.outbound_tag.trim();
        // 防御脏数据：规则指向已停用/不存在的出站时不能写进配置，
        // 否则 Xray 会因为悬挂的 outboundTag 拒绝加载整份配置。
        let known = matches!(tag, "direct" | "blocked" | "api")
            || custom_tags.iter().any(|custom| custom.as_str() == tag);
        if !known {
            tracing::warn!(
                server = %plan.server_name,
                rule = %rule.id,
                outbound = %rule.outbound_tag,
                "路由规则指向的出站不可用，生成配置时跳过"
            );
            return None;
        }
        Some(routing::rule_value(rule))
    }));

    json!({
        "log": {
            "loglevel": "warning"
        },
        // Xray 进程内计数器：email 维度是计费口径，inbound 维度留给节点视图对账。
        "stats": {},
        // 用户级计数器挂在 policy.levels."0" 上，不是 policy.system——
        // 放到 system 里 Xray 会静默忽略，表现为「流量都跑了，但计费一直是 0」。
        // 限速档位从 level 1 开始，每个档位也必须打开同样的计数器，
        // 否则用户一旦被分到 level > 0，计费就会归零。
        "policy": {
            "levels": policy_levels(&tiers),
            "system": {
                "statsInboundUplink": true,
                "statsInboundDownlink": true
            }
        },
        // gRPC API：Agent 用 `xray api statsquery` 连 127.0.0.1:10085 取数。
        // 只监听回环，绝不能暴露公网。
        "api": {
            "tag": "api",
            "services": [
                "HandlerService",
                "LoggerService",
                "StatsService",
                "RoutingService"
            ]
        },
        "inbounds": inbounds,
        "outbounds": outbounds,
        "routing": {
            "domainStrategy": "AsIs",
            "rules": rules
        }
    })
}

/// 内置出站：直连、黑洞、API 通道。
///
/// api 显式占位与官方示例一致：旧版本会把 api 入站的流量按 inboundTag 选到它，
/// 而不是误送外网。自定义出站固定追加在它们之后，避免占用前三的位置。
fn builtin_outbounds() -> Vec<Value> {
    vec![
        json!({
            "tag": "direct",
            "protocol": "freedom",
            "settings": {}
        }),
        json!({
            "tag": "blocked",
            "protocol": "blackhole",
            "settings": {}
        }),
        json!({
            "tag": "api",
            "protocol": "freedom",
            "settings": {}
        }),
    ]
}

/// 自定义出站：`config_json` 合并进对象，`tag` / `protocol` 以数据库为准。
fn custom_outbounds(items: &[Outbound]) -> Vec<Value> {
    items
        .iter()
        .map(|outbound| {
            let mut object = parse_fragment(&outbound.config_json);
            object.insert("tag".into(), Value::String(outbound.tag.trim().to_string()));
            object.insert(
                "protocol".into(),
                Value::String(outbound.protocol.trim().to_ascii_lowercase()),
            );
            Value::Object(object)
        })
        .collect()
}

fn api_rule() -> Value {
    json!({
        "type": "field",
        "inboundTag": ["api"],
        "outboundTag": "api"
    })
}

/// 本机 gRPC API 入站：`xray api statsquery` 通过它读取计数器。
fn api_inbound() -> Value {
    json!({
        "tag": "api",
        "listen": "127.0.0.1",
        "port": 10085,
        "protocol": "dokodemo-door",
        "settings": {
            "address": "127.0.0.1",
            "network": "tcp"
        }
    })
}

/// 生成配置时被跳过的节点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedNode {
    pub node_id: String,
    pub node_name: String,
    pub reason: String,
}

impl SkippedNode {
    /// 面向管理员的单行中文说明。
    pub fn warning(&self) -> String {
        format!("节点 {} 被跳过：{}", self.node_name, self.reason)
    }
}

// ---------------------------------------------------------------------------
// Shadowsocks：方法白名单、密钥长度与网络模式
// ---------------------------------------------------------------------------

/// Xray 支持的 Shadowsocks 方法白名单（见 `docs/ERRORS.md`）。
pub const SS_METHODS: &[&str] = &[
    "2022-blake3-aes-128-gcm",
    "2022-blake3-aes-256-gcm",
    "2022-blake3-chacha20-poly1305",
    "aes-256-gcm",
    "aes-128-gcm",
    "chacha20-poly1305",
    "xchacha20-poly1305",
];

/// 新建 Shadowsocks 节点的默认方法：SS2022，密码必须由管理员填。
pub const SS_DEFAULT_METHOD: &str = "2022-blake3-aes-256-gcm";

/// `settings.network`：控制原生 UDP 监听；Xray 缺省为 `tcp`。
pub const SS_NETWORKS: &[&str] = &["tcp", "udp", "tcp,udp"];

/// 旧 AEAD 的密码最小长度（短密码是弱口令，而且多数客户端会直接拒绝）。
pub const SS_LEGACY_PASSWORD_MIN: usize = 8;

/// SS2022 方法要求的密钥字节数；旧 AEAD 返回 `None`（密码是任意字符串）。
pub fn ss2022_key_len(method: &str) -> Option<usize> {
    match method.trim().to_ascii_lowercase().as_str() {
        "2022-blake3-aes-128-gcm" => Some(16),
        "2022-blake3-aes-256-gcm" | "2022-blake3-chacha20-poly1305" => Some(32),
        _ => None,
    }
}

/// 是否 SS2022 方法。多用户形态（user 带不带 `method`）与密码编码都由它决定。
pub fn is_ss2022(method: &str) -> bool {
    ss2022_key_len(method).is_some()
}

/// 该方法能否用「每用户密钥」的多用户形态。
///
/// Xray 的 SS2022 多用户（`clients` 里每个 user 一把密钥）只实现了
/// `2022-blake3-aes-*`；`2022-blake3-chacha20-poly1305` 一旦出现 `clients`，
/// Xray 会直接报 `only blake3-aes-*-gcm methods are supported` 并**拒绝加载
/// 整份配置**（不是只跳过这个节点）。所以生成配置/订阅时必须先判定。
pub fn ss2022_supports_multiuser(method: &str) -> bool {
    matches!(
        method.trim().to_ascii_lowercase().as_str(),
        "2022-blake3-aes-128-gcm" | "2022-blake3-aes-256-gcm"
    )
}

/// 会进入多用户形态、但 Xray 不支持该方法的 SS2022 节点。
pub fn ss2022_multiuser_unsupported(method: &str) -> bool {
    is_ss2022(method) && !ss2022_supports_multiuser(method)
}

/// 宽松解码 SS2022 密钥：接受标准 / URL-safe base64、带不带 padding、多余 `=`。
///
/// 各种客户端/面板导出的 SS2022 密钥格式不一致：`openssl rand -base64` 是标准
/// 带 padding，`ss://` 链接里是 URL-safe，手工复制还常带换行或多余 `=`。
/// Xray 自己只认标准 base64（解码失败会退化成「把字面量当密钥」），长度对不上
/// 就静默握手失败。所以我们在入口统一解码，落盘和订阅再统一写规范形态。
fn decode_ss2022_key(raw: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
    use base64::Engine;

    let trimmed = raw.trim().trim_end_matches('=');
    if trimmed.is_empty() {
        return None;
    }
    STANDARD_NO_PAD
        .decode(trimmed)
        .or_else(|_| URL_SAFE_NO_PAD.decode(trimmed))
        .ok()
}

/// SS2022 密钥的规范形态：标准 base64 + 标准 padding（Xray 唯一稳定接受的写法）。
///
/// 解码失败返回 `None`（调用方应把它当作非法密钥）。
pub fn canonical_ss2022_key(raw: &str) -> Option<String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    decode_ss2022_key(raw).map(|bytes| STANDARD.encode(bytes))
}

/// 校验 Shadowsocks 入站片段；`None` = 合法，`Some` = 带稳定错误码的问题。
///
/// 片段里缺 `settings` 时按 [`default_settings`] 的默认值判定（2022 + 空密钥），
/// 所以「没填密钥」的历史节点同样会被拦下。
pub fn shadowsocks_problem(config: &Value) -> Option<DomainError> {
    ss_settings_problem(config.get("settings").and_then(Value::as_object))
}

fn ss_settings_problem(settings: Option<&Map<String, Value>>) -> Option<DomainError> {
    let method = ss_method(settings);
    if !SS_METHODS.contains(&method.as_str()) {
        return Some(DomainError::with_params(
            "node.ss_method_invalid",
            json!({ "method": method, "allowed": SS_METHODS }),
            format!(
                "不支持的 Shadowsocks 加密方法：{method}（可选：{}）",
                SS_METHODS.join(" / ")
            ),
        ));
    }

    let password = settings
        .and_then(|settings| settings.get("password"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();

    if let Some(expected) = ss2022_key_len(&method) {
        match decode_ss2022_key(password) {
            Some(key) if key.len() == expected => {}
            Some(key) => {
                return Some(DomainError::with_params(
                    "node.ss_key_invalid",
                    json!({
                        "method": method,
                        "expected_bytes": expected,
                        "actual_bytes": key.len(),
                    }),
                    format!(
                        "Shadowsocks 方法 {method} 要求 base64 解码后 {expected} 字节的密钥（实际 {} 字节）",
                        key.len()
                    ),
                ))
            }
            None => {
                return Some(DomainError::with_params(
                    "node.ss_key_invalid",
                    json!({ "method": method, "expected_bytes": expected }),
                    format!(
                        "Shadowsocks 密钥必须是 base64 编码的 {expected} 字节随机密钥（可参考 `openssl rand -base64 {expected}`）"
                    ),
                ))
            }
        }
    } else if password.chars().count() < SS_LEGACY_PASSWORD_MIN {
        return Some(DomainError::with_params(
            "node.ss_key_invalid",
            json!({ "method": method, "min_chars": SS_LEGACY_PASSWORD_MIN }),
            format!("Shadowsocks 密码至少 {SS_LEGACY_PASSWORD_MIN} 个字符"),
        ));
    }

    let network = ss_network(settings);
    if !SS_NETWORKS.contains(&network.as_str()) {
        return Some(DomainError::with_params(
            "node.ss_network_invalid",
            json!({ "network": network, "allowed": SS_NETWORKS }),
            format!(
                "不支持的 Shadowsocks 网络类型：{network}（可选：{}）",
                SS_NETWORKS.join(" / ")
            ),
        ));
    }

    None
}

/// 片段里的方法：去空白、转小写；缺失/空白按默认值处理。
fn ss_method(settings: Option<&Map<String, Value>>) -> String {
    settings
        .and_then(|settings| settings.get("method"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|method| !method.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| SS_DEFAULT_METHOD.to_string())
}

/// 片段里的网络模式：去空白、转小写；缺失/空白按 Xray 默认的 `tcp` 处理。
fn ss_network(settings: Option<&Map<String, Value>>) -> String {
    settings
        .and_then(|settings| settings.get("network"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|network| !network.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "tcp".to_string())
}

/// SS 的 `method` / `network` 大小写敏感（Xray 只认小写），`password` 两侧空白无意义。
///
/// 主控新建时已校验过，这里兜住导入的历史片段：把 `AES-256-GCM` 归一成
/// `aes-256-gcm`，避免「校验通过、Xray 却拒绝加载」。`network` 为空时直接移除，
/// 让 Xray 用默认的 `tcp`。
fn normalize_ss_settings(settings: &mut Map<String, Value>) {
    let method = ss_method(Some(settings));
    settings.insert("method".into(), Value::String(method.clone()));

    match settings
        .get("network")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
    {
        Some(network) if !network.is_empty() => {
            settings.insert("network".into(), Value::String(network));
        }
        Some(_) => {
            settings.remove("network");
        }
        None => {}
    }

    if let Some(password) = settings.get("password").and_then(Value::as_str) {
        let trimmed = password.trim();
        // SS2022 的密钥统一写规范形态：URL-safe / 缺 padding / 多余 `=` 的输入
        // 若原样写进配置，Xray 解码失败后会把它当字面量密钥，握手静默失败。
        let normalized = if is_ss2022(&method) {
            canonical_ss2022_key(trimmed).unwrap_or_else(|| trimmed.to_string())
        } else {
            trimmed.to_string()
        };
        if normalized != password {
            settings.insert("password".into(), Value::String(normalized));
        }
    }
}

/// 让 `settings` 与节点的 `protocol` 一致，并补齐该协议必需的骨架字段。
///
/// `config_json` 是自由的入站片段：节点协议改过、或从别的协议整段复制过来时，
/// `settings` 里会残留 `method` / `password` 这类只属于 Shadowsocks 的键。
/// Xray 对部分字段很严格（例如 vless 的 `decryption`、SS2022 的多用户形态），
/// 残留会让**整份配置**加载失败，而不是只影响这一个节点。
fn normalize_settings(protocol: &str, inbound: &mut Map<String, Value>) {
    if !matches!(inbound.get("settings"), Some(Value::Object(_))) {
        inbound.insert("settings".into(), default_settings(protocol));
    }
    let Some(settings) = inbound.get_mut("settings").and_then(Value::as_object_mut) else {
        return;
    };
    let protocol = protocol.trim().to_ascii_lowercase();
    match protocol.as_str() {
        "shadowsocks" | "ss" => normalize_ss_settings(settings),
        "vless" | "vmess" | "trojan" => normalize_client_settings(&protocol, settings),
        _ => {}
    }
}

/// vless / vmess / trojan 的 settings 骨架。
fn normalize_client_settings(protocol: &str, settings: &mut Map<String, Value>) {
    // `method` 只可能出现在 Shadowsocks 的 settings 里；看到它就说明整段
    // settings 是从别的协议残留/复制过来的，里面的 clients 也不可信，
    // 直接换成该协议的默认骨架（派生 client 随后由 inject_clients 注入）。
    if settings.contains_key("method") {
        if let Value::Object(defaults) = default_settings(protocol) {
            *settings = defaults;
        }
        return;
    }
    if protocol == "vless" {
        // VLESS 入站的 decryption 必须是 none；缺省或写成别的值都可能让
        // Xray 拒绝加载整份配置。
        settings.insert("decryption".into(), Value::String("none".into()));
    }
    if !matches!(settings.get("clients"), Some(Value::Array(_))) {
        settings.insert("clients".into(), Value::Array(Vec::new()));
    }
}

/// 校验节点能否生成 Xray 可接受的 inbound；不能时返回中文原因。
///
/// 只拦「一定会让 `xray -test` 失败」的硬错误。片段缺 `stream` / `settings`
/// 仍由 [`build_config`] 补默认值，不在这里判死。
pub fn node_problem(node: &Node) -> Option<String> {
    if !(1..=65_535).contains(&node.port) {
        return Some(format!("端口 {} 不合法（应为 1-65535）", node.port));
    }

    let fragment = parse_fragment(&node.config_json);
    let protocol = node.protocol.trim().to_ascii_lowercase();
    if matches!(protocol.as_str(), "shadowsocks" | "ss") {
        if let Some(problem) =
            ss_settings_problem(fragment.get("settings").and_then(Value::as_object))
        {
            return Some(problem.message);
        }
    }

    let stream = stream_settings(&fragment);
    // 片段是安全层的事实来源，缺省才回落到节点表里的冗余列（与 build_inbound 一致）。
    let security = stream
        .and_then(|stream| stream.get("security"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| node.security.trim().to_ascii_lowercase());
    if security != "reality" {
        return None;
    }

    // 没有 realitySettings 时保持历史行为（导入配置可能把安全层完整写在别处）；
    // 一旦给了 realitySettings，入站就必须有一把能解析的 privateKey。
    let reality = stream
        .and_then(|stream| stream.get("realitySettings"))
        .and_then(Value::as_object)?;
    match reality.get("privateKey").and_then(Value::as_str) {
        Some(key) if crate::reality::public_key_from_private(key).is_some() => None,
        Some(_) => Some("REALITY 私钥无法解析".into()),
        None => Some("REALITY 缺少 privateKey".into()),
    }
}

/// [`build_config`] 的校验版：跳过无法生成合法 inbound 的节点，并返回每个节点的中文警告。
///
/// apply 用它把「被跳过的节点」回报给管理员；纯函数本身仍保持
/// [`build_config`] 的历史行为，避免调用方（如单元测试/导入工具）被静默改变语义。
pub fn build_config_checked(plan: &ServerPlan) -> (Value, Vec<String>) {
    build_config_checked_impl(plan, false)
}

/// 下发用的校验版：除了 REALITY 私钥，还会把「TLS 节点缺证书」的节点跳过并
/// 给出中文 warning。API 层已拦住新建这类节点，这里兜住迁移前的历史数据。
pub fn build_config_checked_with_certs(plan: &ServerPlan) -> (Value, Vec<String>) {
    build_config_checked_impl(plan, true)
}

/// SS2022 节点是否会进入「每用户密钥」的多用户形态。
///
/// 两种来源：面板注入的授权用户，或片段里手工导入的 `clients`。只要有一种，
/// Xray 就会走多用户实现——而它只支持 `2022-blake3-aes-*`。chacha 带任何
/// clients 都会让**整份配置**加载失败，所以必须把节点整条跳过并告警，
/// 不能让它连累同一服务器上的其它节点。
fn ss_multiuser_problem(node: &Node) -> Option<String> {
    let protocol = node.protocol.trim().to_ascii_lowercase();
    if !matches!(protocol.as_str(), "shadowsocks" | "ss") {
        return None;
    }
    let fragment = parse_fragment(&node.config_json);
    let method = ss_method(fragment.get("settings").and_then(Value::as_object));
    if ss2022_multiuser_unsupported(&method) {
        return Some(format!(
            "SS2022 方法 {method} 不支持多用户（Xray 仅支持 2022-blake3-aes-*），已跳过"
        ));
    }
    None
}

/// 片段里是否已经有手工 client（会触发 Xray 的多用户形态）。
fn node_has_manual_clients(node: &Node) -> bool {
    parse_fragment(&node.config_json)
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("clients"))
        .and_then(Value::as_array)
        .is_some_and(|clients| !clients.is_empty())
}

fn build_config_checked_impl(plan: &ServerPlan, require_tls_certs: bool) -> (Value, Vec<String>) {
    let mut usable = Vec::with_capacity(plan.nodes.len());
    let mut warnings = Vec::new();
    for node in plan.nodes {
        let has_grants = plan.grants.iter().any(|grant| grant.node_id == node.id);
        let multiuser = has_grants || node_has_manual_clients(node);
        let problem = node_problem(node)
            .or_else(|| multiuser.then(|| ss_multiuser_problem(node)).flatten())
            .or_else(|| {
                require_tls_certs
                    .then(|| node_tls_cert_problem(node, plan.certs))
                    .flatten()
            });
        match problem {
            Some(reason) => {
                let name = node_display_name(node);
                let skipped = SkippedNode {
                    node_id: node.id.clone(),
                    node_name: name.to_string(),
                    reason,
                };
                tracing::warn!(
                    node = %skipped.node_id,
                    name = %skipped.node_name,
                    reason = %skipped.reason,
                    "生成配置时跳过节点"
                );
                warnings.push(skipped.warning());
            }
            None => usable.push(node.clone()),
        }
    }
    (build_config_impl(plan, &usable), warnings)
}

/// TLS 节点必须能落出证书文件：要么片段里已显式写了 `certificates`，要么
/// 绑定了一张本次下发里真实存在的证书。
fn node_tls_cert_problem(node: &Node, certs: &[NodeCertificate]) -> Option<String> {
    let fragment = parse_fragment(&node.config_json);
    let stream = stream_settings(&fragment);
    let security = stream
        .and_then(|stream| stream.get("security"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| node.security.trim().to_ascii_lowercase());
    if !matches!(security.as_str(), "tls" | "xtls") {
        return None;
    }
    let explicit = stream
        .and_then(|stream| stream.get("tlsSettings"))
        .and_then(Value::as_object)
        .and_then(|tls| tls.get("certificates"))
        .and_then(Value::as_array)
        .is_some_and(|certificates| !certificates.is_empty());
    if explicit {
        return None;
    }
    if node
        .cert_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .is_none()
    {
        return Some("TLS 节点未绑定证书".into());
    }
    if !certs.iter().any(|cert| cert.node_id == node.id) {
        return Some("绑定的证书不存在".into());
    }
    None
}

fn node_display_name(node: &Node) -> &str {
    let name = node.name.trim();
    if !name.is_empty() {
        return name;
    }
    let tag = node.tag.trim();
    if !tag.is_empty() {
        return tag;
    }
    &node.id
}

fn build_inbound(
    server_name: &str,
    index: usize,
    node: &Node,
    grants: &[Grant],
    certs: &[NodeCertificate],
    tiers: &BTreeMap<i64, i64>,
) -> Value {
    let mut inbound = parse_fragment(&node.config_json);

    // tag/port/protocol 的唯一事实来源是数据库字段，片段里的旧值一律丢弃。
    inbound.remove("tag");
    inbound.remove("port");
    inbound.remove("protocol");

    // settings 缺失时补协议默认骨架；与协议不符的残留键在这里清掉。
    normalize_settings(&node.protocol, &mut inbound);
    // Xray 认的字段名是 `streamSettings`；历史片段里写的是 `stream`，这里统一改名，
    // 否则即使配置能生成，真实 Xray 也会忽略整段传输/安全设置。
    if let Some(legacy) = inbound.remove("stream") {
        inbound.entry("streamSettings").or_insert(legacy);
    }
    if !matches!(inbound.get("streamSettings"), Some(Value::Object(_))) {
        inbound.insert("streamSettings".into(), default_stream(node));
    }

    apply_tls_certificate(&mut inbound, node, certs);

    let tag = effective_tag(server_name, index, node);
    inject_clients(&mut inbound, node, &tag, grants, tiers);

    inbound.insert("tag".into(), Value::String(tag));
    inbound.insert("port".into(), Value::from(node.port));
    inbound.insert(
        "protocol".into(),
        Value::String(node.protocol.trim().to_ascii_lowercase()),
    );

    Value::Object(inbound)
}

/// 把派生 client 追加到 `settings.clients`，手工 client 排在前、不被覆盖。
///
/// 只在协议支持「按用户建 client」时生效；`grants` 里没有该节点的授权时完全不动
/// `settings`，保证没有套餐/没有用户时生成的配置与历史版本一致。
fn inject_clients(
    inbound: &mut Map<String, Value>,
    node: &Node,
    tag: &str,
    grants: &[Grant],
    tiers: &BTreeMap<i64, i64>,
) {
    let protocol = node.protocol.trim().to_ascii_lowercase();
    if !matches!(
        protocol.as_str(),
        "vless" | "vmess" | "trojan" | "shadowsocks" | "ss"
    ) {
        return;
    }

    let node_grants: Vec<&Grant> = grants
        .iter()
        .filter(|grant| grant.node_id == node.id)
        .collect();
    if node_grants.is_empty() {
        return;
    }

    let security = inbound
        .get("streamSettings")
        .or_else(|| inbound.get("stream"))
        .and_then(Value::as_object)
        .and_then(|stream| stream.get("security"))
        .and_then(Value::as_str)
        .map(|security| security.trim().to_ascii_lowercase())
        .unwrap_or_default();
    // vless 的 flow 优先沿用片段里第一条 client 的写法，其次按安全层给默认值。
    let stream_flow = if protocol == "vless" && matches!(security.as_str(), "reality" | "xtls") {
        Some("xtls-rprx-vision".to_string())
    } else {
        None
    };

    let settings = inbound
        .get_mut("settings")
        .and_then(Value::as_object_mut)
        .expect("build_inbound 已保证 settings 是对象");
    if !matches!(settings.get("clients"), Some(Value::Array(_))) {
        settings.insert("clients".into(), Value::Array(Vec::new()));
    }

    // 先读片段里的手工 client（只看第一条的 flow，作为该 inbound 的默认值）。
    let manual = settings
        .get("clients")
        .and_then(Value::as_array)
        .expect("上一行已保证 clients 是数组");
    let fragment_flow = manual
        .first()
        .and_then(|client| client.get("flow"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|flow| !flow.is_empty())
        .map(str::to_string);
    let vless_flow = fragment_flow.or(stream_flow);

    // Shadowsocks 多用户有两种形态：
    // * SS2022：`method` 只写在 inbound 上，每个 user 只写自己的密钥，**不能**带 method；
    // * 旧 AEAD：`method` 只写在每个 user 上，inbound 的 `password` 会被忽略。
    let ss_method = settings
        .get("method")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|method| !method.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| SS_DEFAULT_METHOD.to_string());
    let ss_2022 = is_ss2022(&ss_method);
    // Xray 的 SS2022 多用户只支持 AES；chacha 一旦带 clients 会让整份配置加载
    // 失败（连累其它节点）。这里退化成单用户形态（不注入 clients），
    // `build_config_checked` 会把这个节点整条跳过并告警。
    if ss_2022 && ss2022_multiuser_unsupported(&ss_method) {
        tracing::warn!(
            node = %node.id,
            method = %ss_method,
            "SS2022 方法不支持多用户，跳过 client 注入（改用 2022-blake3-aes-*）"
        );
        return;
    }

    let clients = settings
        .get_mut("clients")
        .and_then(Value::as_array_mut)
        .expect("上面已保证 clients 是数组");

    for grant in node_grants {
        let mut client = Map::new();
        match protocol.as_str() {
            "vless" => {
                client.insert("id".into(), Value::String(grant.uuid.clone()));
                if let Some(flow) = &vless_flow {
                    client.insert("flow".into(), Value::String(flow.clone()));
                }
            }
            "vmess" => {
                client.insert("id".into(), Value::String(grant.uuid.clone()));
                client.insert("alterId".into(), Value::from(0));
            }
            "trojan" => {
                client.insert("password".into(), Value::String(grant.uuid.clone()));
            }
            "shadowsocks" | "ss" => {
                if ss_2022 {
                    // SS2022：per-user 密钥，长度随方法（AES-128 = 16 字节），
                    // 并且绝不能再带 method。
                    client.insert(
                        "password".into(),
                        Value::String(grant.ss_key_for(&ss_method).to_string()),
                    );
                } else {
                    // 旧 AEAD：user 密码沿用 UUID 派生，每个 user 带自己的 method。
                    client.insert("password".into(), Value::String(grant.uuid.clone()));
                    client.insert("method".into(), Value::String(ss_method.clone()));
                }
            }
            _ => unreachable!("上面已过滤协议白名单"),
        }
        client.insert(
            "email".into(),
            Value::String(credentials::sub_email(&grant.user_id, tag)),
        );
        // 有限速档位的用户落到对应 level；不限速的用户保持历史行为（不写 level，
        // 默认 level 0），所以没有档位时生成的配置与旧版本完全一致。
        if let Some(level) = grant
            .speed_limit_kbps
            .and_then(|kbps| tiers.get(&kbps).copied())
        {
            client.insert("level".into(), Value::from(level));
        }
        clients.push(Value::Object(client));
    }
}

/// 把节点绑定证书的路径写进 `stream.tlsSettings.certificates`。
///
/// 片段里已经有非空 `certificates` 时保持原样（导入配置以片段为准）。
fn apply_tls_certificate(inbound: &mut Map<String, Value>, node: &Node, certs: &[NodeCertificate]) {
    let Some(cert) = certs.iter().find(|cert| cert.node_id == node.id) else {
        return;
    };
    let Some(stream) = inbound
        .get_mut("streamSettings")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let security = stream
        .get("security")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !matches!(security.as_str(), "tls" | "xtls") {
        return;
    }
    let tls = stream
        .entry("tlsSettings")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(tls) = tls.as_object_mut() else {
        return;
    };
    let explicit = tls
        .get("certificates")
        .and_then(Value::as_array)
        .is_some_and(|certificates| !certificates.is_empty());
    if explicit {
        return;
    }
    tls.insert(
        "certificates".into(),
        json!([{
            "certificateFile": cert.cert_path,
            "keyFile": cert.key_path
        }]),
    );
}

/// 读取传输配置：优先 Xray 的 `streamSettings`，回落到历史片段里的 `stream`。
pub fn stream_settings(fragment: &Map<String, Value>) -> Option<&Map<String, Value>> {
    fragment
        .get("streamSettings")
        .or_else(|| fragment.get("stream"))
        .and_then(Value::as_object)
}

fn parse_fragment(raw: &str) -> Map<String, Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn default_settings(protocol: &str) -> Value {
    match protocol.trim().to_ascii_lowercase().as_str() {
        "vless" => json!({ "clients": [], "decryption": "none" }),
        "vmess" | "trojan" => json!({ "clients": [] }),
        // SS2022 是默认方法；空 password 是故意的：UI 必须让管理员填密钥，
        // 校验（`shadowsocks_problem`）会把空密钥的节点拦在 apply 之前。
        "shadowsocks" | "ss" => json!({
            "method": SS_DEFAULT_METHOD,
            "password": "",
            "network": "tcp,udp"
        }),
        _ => json!({}),
    }
}

fn default_stream(node: &Node) -> Value {
    let transport = node.transport.trim();
    let security = node.security.trim();
    json!({
        "network": if transport.is_empty() { "tcp" } else { transport },
        "security": if security.is_empty() { "none" } else { security }
    })
}

fn effective_tag(server_name: &str, index: usize, node: &Node) -> String {
    let tag = node.tag.trim();
    if !tag.is_empty() {
        return tag.to_string();
    }
    let base = sanitize_tag(server_name);
    let base = if base.is_empty() {
        "node"
    } else {
        base.as_str()
    };
    format!("{base}-{}-{index}", node.port)
}

/// tag 会进入 Xray 配置，限制为字母数字、`-`、`_`，避免奇怪字符。
fn sanitize_tag(raw: &str) -> String {
    let tag: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    tag.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(
        tag: &str,
        protocol: &str,
        transport: &str,
        security: &str,
        port: i64,
        config_json: &str,
    ) -> Node {
        Node {
            id: format!("id-{tag}"),
            server_id: "server-1".into(),
            tag: tag.into(),
            name: tag.into(),
            protocol: protocol.into(),
            transport: transport.into(),
            security: security.into(),
            port,
            config_json: config_json.into(),
            enabled: 1,
            created_at: 1,
            cert_id: None,
            bandwidth_kbps: None,
        }
    }

    /// 只有节点/授权的便捷入口；出站与规则由专门的测试显式构造。
    fn build(server_name: &str, nodes: &[Node], grants: &[Grant]) -> Value {
        build_config(&ServerPlan::new(server_name, nodes, grants))
    }

    #[test]
    fn empty_server_still_gets_a_valid_skeleton() {
        let config = build("hk-1", &[], &[]);

        assert_eq!(config["log"]["loglevel"], "warning");
        // 没有业务节点时仍要有 API 入站，Agent 才能查流量。
        let inbounds = config["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 1);
        let api = &inbounds[0];
        assert_eq!(api["tag"], "api");
        assert_eq!(api["listen"], "127.0.0.1");
        assert_eq!(api["port"], 10085);
        assert_eq!(api["protocol"], "dokodemo-door");
        assert_eq!(api["settings"]["address"], "127.0.0.1");

        assert_eq!(config["outbounds"][0]["tag"], "direct");
        assert_eq!(config["outbounds"][0]["protocol"], "freedom");
        assert_eq!(config["outbounds"][1]["tag"], "blocked");
        assert_eq!(config["outbounds"][1]["protocol"], "blackhole");
        assert_eq!(config["outbounds"][2]["tag"], "api");
        assert_eq!(config["routing"]["domainStrategy"], "AsIs");
        assert_eq!(
            config["routing"]["rules"],
            json!([{"type": "field", "inboundTag": ["api"], "outboundTag": "api"}])
        );
    }

    #[test]
    fn enables_stats_and_local_api() {
        let config = build("hk-1", &[], &[]);

        assert_eq!(config["stats"], json!({}));
        let system = &config["policy"]["system"];
        assert_eq!(system["statsInboundUplink"], true);
        assert_eq!(system["statsInboundDownlink"], true);
        // 用户级计数器必须在 levels 下，放 system 里 Xray 不报错但也不生效
        let level0 = &config["policy"]["levels"]["0"];
        assert_eq!(level0["statsUserUplink"], true);
        assert_eq!(level0["statsUserDownlink"], true);
        assert!(system.get("statsUserUplink").is_none());
        assert_eq!(config["api"]["tag"], "api");
        let services = config["api"]["services"].as_array().unwrap();
        assert!(services.iter().any(|s| s == "StatsService"));
        // API 端口只绑定回环，避免把 gRPC 管理面带进公网。
        let api = config["inbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|inbound| inbound["tag"] == "api")
            .unwrap();
        assert_eq!(api["listen"], "127.0.0.1");
    }

    #[test]
    fn builds_vless_tcp_reality_inbound() {
        let n = node(
            "vless-reality",
            "vless",
            "tcp",
            "reality",
            443,
            r#"{
                "settings": {
                    "clients": [{
                        "id": "11111111-1111-1111-1111-111111111111",
                        "flow": "xtls-rprx-vision"
                    }],
                    "decryption": "none"
                },
                "stream": {
                    "network": "tcp",
                    "security": "reality",
                    "realitySettings": {
                        "serverNames": ["www.example.com"],
                        "privateKey": "private-key",
                        "shortIds": ["abcd1234"]
                    }
                },
                "sniffing": {"enabled": true, "destOverride": ["http", "tls"]}
            }"#,
        );

        let config = build("hk-1", &[n], &[]);
        let inbound = &config["inbounds"][0];

        // 业务节点在前，API 入站固定追加在最后。
        assert_eq!(config["inbounds"].as_array().unwrap().len(), 2);
        assert_eq!(config["inbounds"][1]["tag"], "api");
        assert_eq!(inbound["tag"], "vless-reality");
        assert_eq!(inbound["port"], 443);
        assert_eq!(inbound["protocol"], "vless");
        assert_eq!(inbound["settings"]["decryption"], "none");
        assert_eq!(
            inbound["streamSettings"]["realitySettings"]["serverNames"][0],
            "www.example.com"
        );
        assert_eq!(inbound["sniffing"]["enabled"], true);
    }

    #[test]
    fn keeps_node_order_and_fills_defaults_for_two_protocols() {
        let vless = node(
            "vless-default",
            "vless",
            "ws",
            "none",
            10001,
            r#"{"stream": {"network": "ws", "wsSettings": {"path": "/ws"}}}"#,
        );
        let trojan = node("trojan-default", "trojan", "tcp", "tls", 10002, "{}");

        let config = build("hk-1", &[vless, trojan], &[]);
        let inbounds = config["inbounds"].as_array().unwrap();

        assert_eq!(inbounds.len(), 3);
        assert_eq!(inbounds[0]["tag"], "vless-default");
        assert_eq!(inbounds[1]["tag"], "trojan-default");
        assert_eq!(inbounds[2]["tag"], "api");
        // vless 片段只给了 stream，settings 应补默认值
        assert_eq!(inbounds[0]["settings"]["decryption"], "none");
        assert_eq!(inbounds[0]["settings"]["clients"], json!([]));
        // trojan 片段全空，settings/stream 都应补默认值
        assert_eq!(inbounds[1]["settings"]["clients"], json!([]));
        assert_eq!(inbounds[1]["streamSettings"]["network"], "tcp");
        assert_eq!(inbounds[1]["streamSettings"]["security"], "tls");
    }

    #[test]
    fn config_json_cannot_override_tag_port_or_protocol() {
        let n = node(
            "authoritative-tag",
            "vless",
            "tcp",
            "none",
            8443,
            r#"{"tag": "evil", "port": 1, "protocol": "vmess", "settings": {}}"#,
        );

        let config = build("hk-1", &[n], &[]);
        let inbound = &config["inbounds"][0];

        assert_eq!(inbound["tag"], "authoritative-tag");
        assert_eq!(inbound["port"], 8443);
        assert_eq!(inbound["protocol"], "vless");
    }

    #[test]
    fn invalid_fragment_falls_back_to_defaults() {
        let n = node("broken", "vless", "tcp", "none", 443, "not-json");

        let config = build("hk-1", &[n], &[]);
        let inbound = &config["inbounds"][0];

        assert_eq!(inbound["settings"]["decryption"], "none");
        assert_eq!(inbound["streamSettings"]["network"], "tcp");
        assert_eq!(inbound["streamSettings"]["security"], "none");
    }

    #[test]
    fn empty_tag_gets_a_deterministic_fallback() {
        let n = node("", "vless", "tcp", "none", 443, "{}");
        let nodes = [n];

        let first = build("HK 1", &nodes, &[]);
        let second = build("HK 1", &nodes, &[]);

        assert_eq!(first["inbounds"][0]["tag"], "hk-1-443-0");
        assert_eq!(first, second);
        assert_eq!(
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&second).unwrap()
        );
    }

    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    fn grants_for(secret: &str, users: &[&str], nodes: &[&Node]) -> Vec<Grant> {
        let mut grants = Vec::new();
        for user_id in users {
            for node in nodes {
                grants.push(Grant::new(secret, user_id, &node.id));
            }
        }
        grants
    }

    #[test]
    fn injects_one_client_per_user_per_node() {
        let vless = node(
            "vless-reality",
            "vless",
            "tcp",
            "reality",
            443,
            r#"{"settings": {"clients": [], "decryption": "none"},
                "stream": {"network": "tcp", "security": "reality"}}"#,
        );
        let vmess = node(
            "vmess-ws",
            "vmess",
            "ws",
            "tls",
            8443,
            r#"{"settings": {"clients": []},
                "stream": {"network": "ws", "security": "tls"}}"#,
        );
        let nodes = [vless, vmess];
        let grants = grants_for(SECRET, &["user-1", "user-2"], &[&nodes[0], &nodes[1]]);

        let config = build("hk-1", &nodes, &grants);
        let inbounds = config["inbounds"].as_array().unwrap();

        assert_eq!(inbounds.len(), 3);
        assert_eq!(inbounds[2]["tag"], "api");
        for (index, node) in nodes.iter().enumerate() {
            let clients = inbounds[index]["settings"]["clients"].as_array().unwrap();
            assert_eq!(clients.len(), 2, "每个节点每个用户一条 client");

            for (user_index, user_id) in ["user-1", "user-2"].iter().enumerate() {
                let client = &clients[user_index];
                assert_eq!(client["email"], format!("{user_id}@{}", node.tag));
            }
        }

        // vless：id 就是订阅里那把 sub_uuid，reality 默认 flow = xtls-rprx-vision。
        assert_eq!(
            inbounds[0]["settings"]["clients"][0]["id"],
            credentials::sub_uuid(SECRET, "user-1", &nodes[0].id)
        );
        assert_eq!(
            inbounds[0]["settings"]["clients"][1]["id"],
            credentials::sub_uuid(SECRET, "user-2", &nodes[0].id)
        );
        assert_eq!(
            inbounds[0]["settings"]["clients"][0]["flow"],
            "xtls-rprx-vision"
        );

        // vmess：id = sub_uuid，alterId 固定 0。
        assert_eq!(
            inbounds[1]["settings"]["clients"][0]["id"],
            credentials::sub_uuid(SECRET, "user-1", &nodes[1].id)
        );
        assert_eq!(inbounds[1]["settings"]["clients"][0]["alterId"], 0);
    }

    #[test]
    fn derived_clients_are_appended_after_manual_clients() {
        let vless = node(
            "vless-manual",
            "vless",
            "tcp",
            "tls",
            443,
            r#"{"settings": {
                    "clients": [{"id": "manual-id", "flow": "xtls-rprx-vision", "email": "hand@import"}],
                    "decryption": "none"
                },
                "stream": {"network": "tcp", "security": "tls"}}"#,
        );
        let nodes = [vless];
        let grants = grants_for(SECRET, &["user-1", "user-2"], &[&nodes[0]]);

        let config = build("hk-1", &nodes, &grants);
        let clients = config["inbounds"][0]["settings"]["clients"]
            .as_array()
            .unwrap();

        assert_eq!(clients.len(), 3, "手工 client 保留，派生 client 追加在后");
        assert_eq!(clients[0]["id"], "manual-id");
        assert_eq!(clients[0]["email"], "hand@import");
        assert_eq!(
            clients[1]["id"],
            credentials::sub_uuid(SECRET, "user-1", &nodes[0].id)
        );
        // 片段的 flow 优先于安全层默认值。
        assert_eq!(clients[1]["flow"], "xtls-rprx-vision");
        assert_eq!(clients[1]["email"], "user-1@vless-manual");
    }

    #[test]
    fn no_grants_keeps_fragment_clients_untouched() {
        let vless = node(
            "vless-manual",
            "vless",
            "tcp",
            "tls",
            443,
            r#"{"settings": {"clients": [{"id": "manual-id"}]},
                "stream": {"network": "tcp", "security": "tls"}}"#,
        );
        let empty = node(
            "vless-empty",
            "vless",
            "tcp",
            "none",
            8443,
            r#"{"settings": {"clients": []}, "stream": {"network": "tcp", "security": "none"}}"#,
        );
        let nodes = [vless, empty];

        let config = build("hk-1", &nodes, &[]);
        let inbounds = config["inbounds"].as_array().unwrap();

        assert_eq!(
            inbounds[0]["settings"]["clients"].as_array().unwrap().len(),
            1
        );
        assert_eq!(inbounds[1]["settings"]["clients"], json!([]));
    }

    #[test]
    fn shadowsocks_multiuser_clients_get_method_and_password() {
        let ss = node(
            "ss-1",
            "shadowsocks",
            "tcp",
            "none",
            9000,
            r#"{"settings": {"method": "aes-256-gcm", "password": "legacy"},
                "stream": {"network": "tcp", "security": "none"}}"#,
        );
        let nodes = [ss];
        let grants = grants_for(SECRET, &["user-1"], &[&nodes[0]]);

        let config = build("hk-1", &nodes, &grants);
        let clients = config["inbounds"][0]["settings"]["clients"]
            .as_array()
            .unwrap();

        assert_eq!(clients.len(), 1);
        assert_eq!(
            clients[0]["password"],
            credentials::sub_uuid(SECRET, "user-1", &nodes[0].id)
        );
        assert_eq!(clients[0]["method"], "aes-256-gcm");
        assert_eq!(clients[0]["email"], "user-1@ss-1");
        // 单用户 password 字段保留：Xray 在多用户模式下会忽略它。
        assert_eq!(config["inbounds"][0]["settings"]["password"], "legacy");
    }

    // -----------------------------------------------------------------
    // Shadowsocks：2022 与旧 AEAD 的两种多用户形态、密钥长度与网络校验
    // -----------------------------------------------------------------

    /// 与 `openssl rand -base64 N` 等价的测试密钥：`bytes` 个 0x07。
    fn ss_key(bytes: usize) -> String {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        STANDARD.encode(vec![7u8; bytes])
    }

    /// 最小的 SS 入站片段（`network` 传空串表示不写该字段）。
    fn ss_config(method: &str, password: &str, network: &str) -> Value {
        let mut settings = json!({ "method": method, "password": password });
        if !network.is_empty() {
            settings["network"] = json!(network);
        }
        json!({
            "settings": settings,
            "stream": {"network": "tcp", "security": "none"}
        })
    }

    fn ss_node(method: &str, password: &str, network: &str) -> Node {
        node(
            "ss-node",
            "shadowsocks",
            "tcp",
            "none",
            9000,
            &ss_config(method, password, network).to_string(),
        )
    }

    #[test]
    fn shadowsocks_2022_clients_only_carry_the_per_user_key() {
        let server_key = ss_key(32);
        let ss = ss_node("2022-blake3-aes-256-gcm", &server_key, "tcp,udp");
        let nodes = [ss];
        let grants = grants_for(SECRET, &["user-1", "user-2"], &[&nodes[0]]);

        let config = build("hk-1", &nodes, &grants);
        let settings = &config["inbounds"][0]["settings"];
        let clients = settings["clients"].as_array().unwrap();

        assert_eq!(clients.len(), 2);
        for (index, user_id) in ["user-1", "user-2"].iter().enumerate() {
            // 2022 的 user 只能写 password（= 每用户密钥），**不能**带 method。
            assert!(
                clients[index].get("method").is_none(),
                "SS2022 多用户的 user 不能带 method"
            );
            assert_eq!(
                clients[index]["password"],
                credentials::ss2022_user_key(SECRET, user_id, &nodes[0].id)
            );
            assert_eq!(clients[index]["email"], format!("{user_id}@ss-node"));
        }
        // 每用户密钥必须和服务器密钥不同，否则多用户隔离失效。
        assert_ne!(
            clients[0]["password"],
            Value::String(server_key.clone()),
            "用户密钥不能等于服务器密钥"
        );
        // inbound 的 method/password/network 原样保留。
        assert_eq!(settings["method"], "2022-blake3-aes-256-gcm");
        assert_eq!(settings["password"], server_key);
        assert_eq!(settings["network"], "tcp,udp");
    }

    #[test]
    fn shadowsocks_2022_user_key_is_32_bytes_of_base64() {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;

        // 32 字节档用 AES-256 验证（chacha 不支持多用户，不会注入 clients）。
        let ss = ss_node("2022-blake3-aes-256-gcm", &ss_key(32), "tcp");
        let nodes = [ss];
        let grants = grants_for(SECRET, &["user-1"], &[&nodes[0]]);
        let config = build("hk-1", &nodes, &grants);
        let password = config["inbounds"][0]["settings"]["clients"][0]["password"]
            .as_str()
            .unwrap();

        assert_eq!(STANDARD.decode(password).unwrap().len(), 32);
    }

    /// AES-128-GCM 的每用户密钥必须是 16 字节；发 32 字节会让 Xray 拒绝整份配置。
    #[test]
    fn shadowsocks_2022_aes_128_clients_get_a_16_byte_key() {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;

        let ss = ss_node("2022-blake3-aes-128-gcm", &ss_key(16), "tcp");
        let nodes = [ss];
        let grants = grants_for(SECRET, &["user-1", "user-2"], &[&nodes[0]]);
        let config = build("hk-1", &nodes, &grants);
        let clients = config["inbounds"][0]["settings"]["clients"]
            .as_array()
            .unwrap();

        assert_eq!(clients.len(), 2);
        for (index, user_id) in ["user-1", "user-2"].iter().enumerate() {
            let raw = STANDARD
                .decode(clients[index]["password"].as_str().unwrap())
                .expect("每用户密钥必须是标准 base64");
            assert_eq!(raw.len(), 16, "AES-128 的每用户密钥必须是 16 字节");
            assert_eq!(
                clients[index]["password"],
                credentials::ss2022_user_key_len(SECRET, user_id, &nodes[0].id, 16),
                "配置与订阅必须用同一把 16 字节密钥"
            );
        }

        // 32 字节档不能被截断逻辑影响（历史凭据不能漂移）。
        let ss = ss_node("2022-blake3-aes-256-gcm", &ss_key(32), "tcp");
        let nodes = [ss];
        let grants = grants_for(SECRET, &["user-1"], &[&nodes[0]]);
        let config = build("hk-1", &nodes, &grants);
        assert_eq!(
            config["inbounds"][0]["settings"]["clients"][0]["password"],
            credentials::ss2022_user_key(SECRET, "user-1", &nodes[0].id)
        );
    }

    /// Xray 的 SS2022 多用户只支持 AES：chacha + 任何授权用户都必须被跳过，
    /// 否则 Xray 会拒绝加载整份配置，同一服务器上的其它节点一起失联。
    #[test]
    fn shadowsocks_2022_chacha_multiuser_is_skipped_with_a_warning() {
        let ss = ss_node("2022-blake3-chacha20-poly1305", &ss_key(32), "tcp");
        let nodes = [ss];
        let grants = grants_for(SECRET, &["user-1"], &[&nodes[0]]);

        // 纯函数本身不能生成带 clients 的 chacha（防御性：调用方漏了 checked 版）。
        let config = build("hk-1", &nodes, &grants);
        assert!(
            config["inbounds"][0]["settings"]["clients"]
                .as_array()
                .is_none_or(|clients| clients.is_empty()),
            "chacha 不能注入 clients：{}",
            config["inbounds"][0]["settings"]
        );

        // 下发路径必须跳过整条节点并给出警告，而不是让整份配置失败。
        let (config, warnings) = build_config_checked(&ServerPlan::new("hk-1", &nodes, &grants));
        assert_eq!(config["inbounds"].as_array().unwrap().len(), 1, "只剩 api");
        assert_eq!(warnings.len(), 1);
        assert!(
            warnings[0].contains("不支持多用户"),
            "警告必须说明原因：{warnings:?}"
        );

        // 没有授权用户时是合法的单用户形态，不能被跳过。
        let (config, warnings) = build_config_checked(&ServerPlan::new("hk-1", &nodes, &[]));
        assert_eq!(warnings.len(), 0);
        assert_eq!(config["inbounds"][0]["protocol"], "shadowsocks");

        // 片段里手工导入的 clients 同样会触发多用户形态，也必须跳过。
        let manual = node(
            "ss-chacha-manual",
            "shadowsocks",
            "tcp",
            "none",
            9000,
            &json!({
                "settings": {
                    "method": "2022-blake3-chacha20-poly1305",
                    "password": ss_key(32),
                    "clients": [{"password": ss_key(32), "email": "hand@import"}]
                }
            })
            .to_string(),
        );
        let (config, warnings) =
            build_config_checked(&ServerPlan::new("hk-1", std::slice::from_ref(&manual), &[]));
        assert_eq!(config["inbounds"].as_array().unwrap().len(), 1, "只剩 api");
        assert_eq!(warnings.len(), 1, "手工 clients 也必须告警：{warnings:?}");
    }

    /// 客户端/面板导出的 SS2022 密钥格式不一：URL-safe、缺 padding、多余 `=`
    /// 都应该被接受，并在落盘配置里统一成标准 base64。
    #[test]
    fn shadowsocks_2022_key_encodings_are_normalized() {
        use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
        use base64::Engine;

        let raw = [7u8; 32];
        let standard = STANDARD.encode(raw);
        let url_safe = URL_SAFE_NO_PAD.encode(raw);
        // 缺 padding（标准字母表）和“多余 =”都是常见输入。
        let no_pad = standard.trim_end_matches('=').to_string();
        let extra_pad = format!("{standard}==");

        for input in [
            format!("  {standard}\n"),
            format!("\t{url_safe}\r\n"),
            no_pad.clone(),
            url_safe.clone(),
            extra_pad.clone(),
        ] {
            assert!(
                shadowsocks_problem(&ss_config("2022-blake3-aes-256-gcm", &input, "tcp")).is_none(),
                "{input:?} 应被接受"
            );
            let ss = ss_node("2022-blake3-aes-256-gcm", &input, "tcp");
            let config = build("hk-1", &[ss], &[]);
            assert_eq!(
                config["inbounds"][0]["settings"]["password"], standard,
                "{input:?} 必须被规范化成标准 base64"
            );
        }

        // 长度不符的 base64 仍要拒绝，不能靠“宽松解码”放行。
        let short = STANDARD.encode([7u8; 16]);
        assert_eq!(
            shadowsocks_problem(&ss_config("2022-blake3-aes-256-gcm", &short, "tcp"))
                .map(|problem| problem.code),
            Some("node.ss_key_invalid")
        );
    }

    /// 节点协议改过 / 片段从别的协议复制时，残留的 SS settings 不能把 Xray 弄挂。
    #[test]
    fn foreign_protocol_settings_are_rebuilt_for_client_protocols() {
        // vless 节点带着完整的 SS settings（method/password/network）。
        let vless = node(
            "vless-with-ss-settings",
            "vless",
            "tcp",
            "none",
            443,
            r#"{"settings": {"method": "aes-256-gcm", "password": "server-key-123",
                             "network": "tcp,udp"}}"#,
        );
        let nodes = [vless];
        let grants = grants_for(SECRET, &["user-1"], &[&nodes[0]]);
        let config = build("hk-1", &nodes, &grants);
        let settings = &config["inbounds"][0]["settings"];

        assert!(
            settings.get("method").is_none(),
            "不能把 SS 的 method 带进 vless"
        );
        assert_eq!(
            settings["decryption"], "none",
            "vless 必须有 decryption=none"
        );
        assert_eq!(
            settings["clients"][0]["id"],
            credentials::sub_uuid(SECRET, "user-1", &nodes[0].id)
        );

        // trojan 同理：残留 settings 被换成默认骨架，派生 client 照常注入。
        let trojan = node(
            "trojan-with-ss-settings",
            "trojan",
            "tcp",
            "none",
            8443,
            r#"{"settings": {"method": "aes-256-gcm", "password": "server-key-123"}}"#,
        );
        let nodes = [trojan];
        let grants = grants_for(SECRET, &["user-1"], &[&nodes[0]]);
        let config = build("hk-1", &nodes, &grants);
        let settings = &config["inbounds"][0]["settings"];
        assert!(settings.get("method").is_none());
        assert_eq!(
            settings["clients"][0]["password"],
            credentials::sub_uuid(SECRET, "user-1", &nodes[0].id)
        );
    }

    #[test]
    fn shadowsocks_legacy_clients_keep_their_own_method() {
        let ss = ss_node("aes-256-gcm", "legacy-server-key", "tcp,udp");
        let nodes = [ss];
        let grants = grants_for(SECRET, &["user-1"], &[&nodes[0]]);

        let config = build("hk-1", &nodes, &grants);
        let client = &config["inbounds"][0]["settings"]["clients"][0];

        // 旧 AEAD：user 密码沿用 UUID 派生，并且每个 user 必须带 method。
        assert_eq!(
            client["password"],
            credentials::sub_uuid(SECRET, "user-1", &nodes[0].id)
        );
        assert_eq!(client["method"], "aes-256-gcm");
    }

    #[test]
    fn shadowsocks_2022_key_length_must_match_the_method() {
        let key16 = ss_key(16);
        let key32 = ss_key(32);

        for (method, password) in [
            ("2022-blake3-aes-128-gcm", key16.as_str()),
            ("2022-blake3-aes-256-gcm", key32.as_str()),
            ("2022-blake3-chacha20-poly1305", key32.as_str()),
        ] {
            assert!(
                shadowsocks_problem(&ss_config(method, password, "tcp")).is_none(),
                "{method} 配 {} 字节密钥应当合法",
                password.len()
            );
        }

        // 16 字节密钥不能配 256 位方法，反之亦然。
        let wrong = shadowsocks_problem(&ss_config("2022-blake3-aes-256-gcm", &key16, "tcp"))
            .expect("长度不匹配必须被拒");
        assert_eq!(wrong.code, "node.ss_key_invalid");
        assert_eq!(
            shadowsocks_problem(&ss_config("2022-blake3-aes-128-gcm", &key32, "tcp"))
                .expect("长度不匹配必须被拒")
                .code,
            "node.ss_key_invalid"
        );
    }

    #[test]
    fn shadowsocks_2022_password_must_be_base64_and_present() {
        for password in ["", "not-base64!!", "AAAA", "   "] {
            let problem =
                shadowsocks_problem(&ss_config("2022-blake3-aes-256-gcm", password, "tcp"));
            assert_eq!(
                problem.map(|problem| problem.code),
                Some("node.ss_key_invalid"),
                "{password:?} 不是合法的 32 字节 base64 密钥"
            );
        }
    }

    #[test]
    fn legacy_aead_password_has_a_minimum_length() {
        assert!(shadowsocks_problem(&ss_config("aes-256-gcm", "12345678", "tcp")).is_none());
        let short = shadowsocks_problem(&ss_config("aes-256-gcm", "1234567", "tcp"))
            .expect("旧 AEAD 少于 8 个字符必须被拒");
        assert_eq!(short.code, "node.ss_key_invalid");
    }

    #[test]
    fn ss_method_whitelist_rejects_unknown_methods() {
        let problem = shadowsocks_problem(&ss_config("aes-256-cfb", "12345678", "tcp"))
            .expect("不在白名单里的方法必须被拒");
        assert_eq!(problem.code, "node.ss_method_invalid");

        // 白名单里的 7 个方法都要能通过（2022 用对应长度的密钥）。
        for method in SS_METHODS {
            let password = match ss2022_key_len(method) {
                Some(len) => ss_key(len),
                None => "legacy-password".to_string(),
            };
            assert!(
                shadowsocks_problem(&ss_config(method, &password, "tcp")).is_none(),
                "{method} 应在白名单里"
            );
        }
    }

    #[test]
    fn ss_network_accepts_only_tcp_udp_or_both() {
        for network in ["tcp", "udp", "tcp,udp"] {
            assert!(
                shadowsocks_problem(&ss_config("aes-256-gcm", "12345678", network)).is_none(),
                "{network} 应当合法"
            );
        }
        for network in ["both", "tcp, udp", "udp,tcp", "ws"] {
            let problem = shadowsocks_problem(&ss_config("aes-256-gcm", "12345678", network))
                .unwrap_or_else(|| panic!("{network} 不是合法的 SS network"));
            assert_eq!(problem.code, "node.ss_network_invalid");
        }
        // 缺省 = tcp：不写 network 也合法。
        assert!(shadowsocks_problem(&ss_config("aes-256-gcm", "12345678", "")).is_none());
    }

    #[test]
    fn shadowsocks_method_and_network_are_normalized_in_the_generated_config() {
        let ss = ss_node("AES-256-GCM", "legacy-password", "TCP,UDP");
        let config = build("hk-1", &[ss], &[]);
        let settings = &config["inbounds"][0]["settings"];

        assert_eq!(settings["method"], "aes-256-gcm");
        assert_eq!(settings["network"], "tcp,udp");
    }

    #[test]
    fn shadowsocks_default_settings_are_2022_with_an_empty_key() {
        let ss = node("ss-default", "shadowsocks", "tcp", "none", 9000, "{}");
        let config = build("hk-1", &[ss], &[]);
        let settings = &config["inbounds"][0]["settings"];

        // 空密码是故意的：UI 必须让管理员填，否则节点不合格（见下方 node_problem 测试）。
        assert_eq!(settings["method"], "2022-blake3-aes-256-gcm");
        assert_eq!(settings["password"], "");
        assert_eq!(settings["network"], "tcp,udp");
    }

    #[test]
    fn node_problem_reports_invalid_shadowsocks_settings() {
        let valid = ss_node("2022-blake3-aes-256-gcm", &ss_key(32), "tcp");
        assert_eq!(node_problem(&valid), None);

        let broken = node(
            "ss-broken",
            "shadowsocks",
            "tcp",
            "none",
            9000,
            r#"{"settings":{"method":"2022-blake3-aes-256-gcm","password":""}}"#,
        );
        let reason = node_problem(&broken).expect("空密钥的 SS 节点必须被拦下");
        assert!(reason.contains("Shadowsocks"), "unexpected: {reason}");

        // 历史数据里没有 settings 的 SS 节点同样不合格，不能静默下发。
        let legacy = node("ss-legacy", "shadowsocks", "tcp", "none", 9000, "{}");
        assert!(node_problem(&legacy).is_some());
    }

    fn outbound(tag: &str, protocol: &str, config_json: &str) -> Outbound {
        Outbound {
            id: format!("out-{tag}"),
            server_id: "server-1".into(),
            tag: tag.into(),
            protocol: protocol.into(),
            config_json: config_json.into(),
            enabled: 1,
            created_at: 1,
        }
    }

    fn rule(
        id: &str,
        sort_order: i64,
        inbound_tag: Option<&str>,
        domain: Option<&str>,
        ip: Option<&str>,
        outbound_tag: &str,
    ) -> RoutingRule {
        RoutingRule {
            id: id.into(),
            server_id: "server-1".into(),
            sort_order,
            inbound_tag: inbound_tag.map(str::to_string),
            domain: domain.map(str::to_string),
            ip: ip.map(str::to_string),
            outbound_tag: outbound_tag.into(),
            enabled: 1,
            created_at: 1,
        }
    }

    #[test]
    fn custom_outbound_config_is_merged_but_tag_and_protocol_come_from_db() {
        let socks = outbound(
            "relay",
            "socks",
            r#"{
                "tag": "evil",
                "protocol": "vmess",
                "settings": {"servers": [{"address": "10.0.0.2", "port": 1080}]}
            }"#,
        );

        let config = build_config(&ServerPlan {
            outbounds: std::slice::from_ref(&socks),
            ..ServerPlan::new("hk-1", &[], &[])
        });
        let outbounds = config["outbounds"].as_array().unwrap();

        // 内置三个 + 自定义一个。
        assert_eq!(outbounds.len(), 4);
        assert_eq!(outbounds[0]["tag"], "direct");
        assert_eq!(outbounds[1]["tag"], "blocked");
        assert_eq!(outbounds[2]["tag"], "api");
        assert_eq!(outbounds[3]["tag"], "relay", "config 里的 tag 不能覆盖库");
        assert_eq!(
            outbounds[3]["protocol"], "socks",
            "config 里的 protocol 不能覆盖库"
        );
        // 其余字段原样合并进来。
        assert_eq!(
            outbounds[3]["settings"]["servers"][0]["address"],
            "10.0.0.2"
        );
    }

    #[test]
    fn rules_keep_api_first_and_only_carry_non_empty_matches() {
        let socks = outbound("relay", "socks", r#"{"settings": {}}"#);
        let domain_rule = rule(
            "rule-domain",
            0,
            Some("hk-1"),
            Some("geosite:cn, domain:example.com"),
            None,
            "relay",
        );
        let ip_rule = rule("rule-ip", 10, None, None, Some("10.0.0.0/8"), "blocked");
        let rules = [domain_rule, ip_rule];

        let config = build_config(&ServerPlan {
            outbounds: std::slice::from_ref(&socks),
            rules: &rules,
            ..ServerPlan::new("hk-1", &[], &[])
        });
        let generated = config["routing"]["rules"].as_array().unwrap();

        assert_eq!(generated.len(), 3);
        // api 规则永远在第一条，且结构与旧版完全一致。
        assert_eq!(
            generated[0],
            json!({"type": "field", "inboundTag": ["api"], "outboundTag": "api"})
        );
        assert_eq!(
            generated[1],
            json!({
                "type": "field",
                "inboundTag": ["hk-1"],
                "domain": ["geosite:cn", "domain:example.com"],
                "outboundTag": "relay"
            })
        );
        assert_eq!(
            generated[2],
            json!({
                "type": "field",
                "ip": ["10.0.0.0/8"],
                "outboundTag": "blocked"
            })
        );
        // 只带非空匹配条件：第二条规则不应出现 inboundTag/domain。
        assert!(generated[2].get("inboundTag").is_none());
        assert!(generated[2].get("domain").is_none());
    }

    #[test]
    fn rules_pointing_at_unavailable_outbounds_are_skipped() {
        // 出站被停用（不在 plan.outbounds 里）时，规则不能写进配置，
        // 否则 Xray 会因为悬挂的 outboundTag 拒绝加载。
        let rules = [rule("rule-1", 0, None, Some("geosite:cn"), None, "relay")];
        let config = build_config(&ServerPlan {
            rules: &rules,
            ..ServerPlan::new("hk-1", &[], &[])
        });

        assert_eq!(
            config["routing"]["rules"],
            json!([{"type": "field", "inboundTag": ["api"], "outboundTag": "api"}])
        );
    }

    /// Xray 只认 `streamSettings`；历史片段里的 `stream` 必须被改名而不是原样透传，
    /// 否则配置能生成、真实 Xray 却会忽略整段传输/安全设置。
    #[test]
    fn legacy_stream_key_is_renamed_to_stream_settings() {
        let legacy = node(
            "legacy",
            "vless",
            "ws",
            "tls",
            443,
            r#"{"settings": {"clients": [], "decryption": "none"},
                "stream": {"network": "ws", "security": "tls", "tlsSettings": {"serverName": "a.com"},
                           "wsSettings": {"path": "/ws"}}}"#,
        );
        let plan = ServerPlan {
            server_name: "s",
            nodes: std::slice::from_ref(&legacy),
            grants: &[],
            certs: &[],
            outbounds: &[],
            rules: &[],
        };
        let cfg = build_config(&plan);
        let inbound = &cfg["inbounds"][0];
        assert!(inbound.get("stream").is_none(), "不应再出现旧的 stream 键");
        assert_eq!(inbound["streamSettings"]["network"], "ws");
        assert_eq!(
            inbound["streamSettings"]["tlsSettings"]["serverName"],
            "a.com"
        );

        let modern = node(
            "modern",
            "vless",
            "tcp",
            "tls",
            443,
            r#"{"settings": {"clients": [], "decryption": "none"},
                "streamSettings": {"network": "tcp", "security": "tls"}}"#,
        );
        let plan = ServerPlan {
            server_name: "s",
            nodes: std::slice::from_ref(&modern),
            grants: &[],
            certs: &[],
            outbounds: &[],
            rules: &[],
        };
        let cfg = build_config(&plan);
        assert_eq!(cfg["inbounds"][0]["streamSettings"]["network"], "tcp");
    }
    fn client_for<'a>(config: &'a Value, tag: &str, user_id: &str) -> &'a Value {
        let email = credentials::sub_email(user_id, tag);
        config["inbounds"][0]["settings"]["clients"]
            .as_array()
            .unwrap()
            .iter()
            .find(|client| client["email"] == email)
            .unwrap_or_else(|| panic!("找不到 {email} 的 client"))
    }

    #[test]
    fn speed_limit_tiers_generate_level_buffers_and_map_clients() {
        let n = node(
            "vless-reality",
            "vless",
            "tcp",
            "reality",
            443,
            r#"{"settings": {"clients": [], "decryption": "none"},
                "stream": {"network": "tcp", "security": "reality"}}"#,
        );
        let grants = vec![
            Grant::limited(SECRET, "user-fast", &n.id, Some(100_000)),
            Grant::limited(SECRET, "user-slow", &n.id, Some(10_000)),
            Grant::new(SECRET, "user-free", &n.id),
        ];
        let config = build("hk-1", &[n], &grants);
        let levels = &config["policy"]["levels"];

        // level 0 必须保留给默认档（计费口径挂在这里）。
        assert_eq!(levels["0"]["statsUserUplink"], true);
        assert_eq!(levels["0"]["statsUserDownlink"], true);
        assert!(levels["0"].get("bufferSize").is_none());

        // 档位按 kbps 升序编号：10Mbps -> level 1，100Mbps -> level 2。
        assert_eq!(levels["1"]["bufferSize"], 62);
        assert_eq!(levels["2"]["bufferSize"], 625);
        assert_ne!(
            levels["1"]["bufferSize"], levels["2"]["bufferSize"],
            "不同档位必须生成不同 bufferSize"
        );
        // 分到 level > 0 的用户仍要计费，否则流量统计会静默归零。
        for level in ["1", "2"] {
            assert_eq!(levels[level]["statsUserUplink"], true, "level {level}");
            assert_eq!(levels[level]["statsUserDownlink"], true, "level {level}");
        }

        let slow = client_for(&config, "vless-reality", "user-slow");
        let fast = client_for(&config, "vless-reality", "user-fast");
        let free = client_for(&config, "vless-reality", "user-free");
        assert_eq!(slow["level"], 1);
        assert_eq!(fast["level"], 2);
        assert!(
            free.get("level").is_none(),
            "不限速用户必须保持不写 level 的旧行为"
        );
    }

    #[test]
    fn same_limit_shares_one_level_across_users_and_nodes() {
        let a = node("a", "vless", "tcp", "none", 443, "{}");
        let b = node("b", "trojan", "tcp", "none", 8443, "{}");
        let grants = vec![
            Grant::limited(SECRET, "u1", &a.id, Some(50_000)),
            Grant::limited(SECRET, "u2", &a.id, Some(50_000)),
            Grant::limited(SECRET, "u1", &b.id, Some(50_000)),
        ];
        let config = build_config(&ServerPlan {
            server_name: "hk-1",
            nodes: &[a, b],
            grants: &grants,
            certs: &[],
            outbounds: &[],
            rules: &[],
        });
        let levels = config["policy"]["levels"].as_object().unwrap();
        assert_eq!(levels.len(), 2, "level 0 + 一个 50Mbps 档");
        assert_eq!(levels["1"]["bufferSize"], 312); // 50_000 / 160
        for inbound in config["inbounds"].as_array().unwrap() {
            if inbound["tag"] == "api" {
                continue;
            }
            for client in inbound["settings"]["clients"].as_array().unwrap() {
                assert_eq!(client["level"], 1);
            }
        }
    }

    #[test]
    fn no_speed_limit_keeps_legacy_policy_shape() {
        let n = node(
            "vless",
            "vless",
            "tcp",
            "none",
            443,
            r#"{"settings": {"clients": [], "decryption": "none"}}"#,
        );
        let grants = vec![Grant::new(SECRET, "u1", &n.id)];
        let config = build("hk-1", &[n], &grants);

        let levels = config["policy"]["levels"].as_object().unwrap();
        assert_eq!(levels.len(), 1, "没有限速档位时只有 level 0");
        assert_eq!(levels["0"]["statsUserUplink"], true);
        let client = client_for(&config, "vless", "u1");
        assert!(client.get("level").is_none());
    }

    #[test]
    fn buffer_size_conversion_is_bounded_and_monotonic() {
        assert_eq!(buffer_size_kb(100_000), 625);
        assert_eq!(buffer_size_kb(160_000), 1_000);
        assert_eq!(buffer_size_kb(10_000_000), 62_500);
        // 极低档位有下限，避免 UDP 满缓冲直接丢包。
        assert_eq!(buffer_size_kb(1_000), 16);
        assert_eq!(buffer_size_kb(0), 512);
        // 异常大输入有上限，但正常档位不会碰到。
        assert_eq!(buffer_size_kb(i64::MAX), 1_048_576);
        assert!(buffer_size_kb(20_000) < buffer_size_kb(40_000));
    }
}
