//! 订阅视图模型与渲染器。
//!
//! 三层结构（见 `docs/SUBSCRIBE.md`）：
//!
//! ```text
//! nodes + config_json  ──解析/凭据注入──▶  SubNode（与客户端无关）
//!                                           │
//!                          Exporter trait ──┴─▶ Clash YAML / URI 列表 / ...
//! ```
//!
//! `SubNode.params` 里只放**已命名**的语义参数（`uuid` / `password` / `sni` / `path` …），
//! 不允许出现 `ws-opts`、`servername` 这类某一种客户端的字段。加第三种格式时，
//! 只新增一个 `Exporter` 实现并在注册表里加一行，前两种渲染器不用动。

use std::collections::BTreeMap;

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::{json, Value};

use crate::credentials;
use crate::models::{Node, RuleTemplate};
use crate::reality;
use crate::xray;

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

/// 与客户端无关的节点视图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubNode {
    pub name: String,
    /// `vless` / `vmess` / `trojan` / `ss`。
    pub protocol: String,
    /// 地址（服务器 `address` 字段，可能是域名或 IP）。
    pub server: String,
    pub port: u16,
    /// 对外（公网）端口；`None` = 与 [`SubNode::port`] 相同。
    ///
    /// NAT 机器上 `port` 是 Agent 实际监听的端口，`public_port` 才是用户真正能连到的
    /// 端口。所有导出器必须走 [`SubNode::effective_port`]，不能直接读 `port`。
    pub public_port: Option<u16>,
    /// `tcp` / `ws` / `grpc` / `h2` / ...
    pub transport: String,
    /// `none` / `tls` / `reality`。
    pub security: String,
    /// 已命名的协议参数，见 `docs/SUBSCRIBE.md` §1。
    pub params: BTreeMap<String, String>,
}

/// 片段里的 Shadowsocks 方法：去空白、转小写；缺失/空白按默认 2022 方法。
///
/// 与 `xray::build_config` 的判定保持一致，否则订阅和服务器会各用一套方法。
fn ss_method(settings: Option<&Value>) -> String {
    settings
        .and_then(|settings| get_str(settings, "method"))
        .map(str::trim)
        .filter(|method| !method.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| xray::SS_DEFAULT_METHOD.to_string())
}

impl SubNode {
    pub fn param(&self, key: &str) -> Option<&str> {
        self.params.get(key).map(String::as_str)
    }

    /// 订阅里给用户的端口：对外端口优先，`None` 时与监听端口相同。
    ///
    /// 所有导出器都只能通过这里取端口；监听端口仍由 Agent 按 `port` 使用。
    pub fn effective_port(&self) -> u16 {
        self.public_port.unwrap_or(self.port)
    }

    /// Shadowsocks 的**客户端密码**。
    ///
    /// * SS2022 多用户：`ServerPassword:UserPassword`（服务端密钥在前）；
    /// * 旧 AEAD 多用户：用户密码就是客户端密码。
    ///
    /// 所有导出器都必须走这个访问器，而不是直接读 `params["password"]`：
    /// 漏拼服务端密钥的订阅在客户端看起来只是「密码错误」，极难排查。
    pub fn ss_client_password(&self) -> String {
        let user_password = self.param("password").unwrap_or_default();
        let server_key = if self.param("method").is_some_and(xray::is_ss2022) {
            self.param("server_password")
        } else {
            None
        };
        credentials::ss_client_password(server_key, user_password)
    }

    /// 从库里的节点（`config_json` 是 Xray 入站片段）装配视图模型。
    ///
    /// 缺关键字段时返回 `None` 并 `tracing::warn!`，**绝不 panic**：订阅是公开端点，
    /// 一条脏数据不能把整个用户的订阅打挂。
    ///
    /// `user_id` / `secret` 用于注入派生凭据（每个 `(user, node)` 一个子账户）。
    pub fn from_node(
        node: &Node,
        server_address: &str,
        user_id: &str,
        secret: &str,
    ) -> Option<Self> {
        let server = server_address.trim();
        if server.is_empty() {
            tracing::warn!(node = %node.id, "节点所属服务器地址为空，订阅跳过该节点");
            return None;
        }
        let Some(port) = u16::try_from(node.port).ok().filter(|port| *port > 0) else {
            tracing::warn!(node = %node.id, port = node.port, "节点端口非法，订阅跳过该节点");
            return None;
        };
        // 对外端口只影响订阅。脏数据（0 / 越界）回落到监听端口并记 warn：
        // 订阅是公开端点，不能因为一个展示字段把整条节点打挂。
        let public_port = node
            .public_port
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0);
        if node.public_port.is_some() && public_port.is_none() {
            tracing::warn!(
                node = %node.id,
                public_port = node.public_port.unwrap_or_default(),
                "节点对外端口非法，订阅回落到监听端口"
            );
        }

        let protocol = match node.protocol.trim().to_ascii_lowercase().as_str() {
            "vless" => "vless",
            "vmess" => "vmess",
            "trojan" => "trojan",
            "shadowsocks" | "ss" => "ss",
            other => {
                tracing::warn!(node = %node.id, protocol = other, "订阅暂不支持该协议，跳过该节点");
                return None;
            }
        };

        let name = node.name.trim();
        let name = if name.is_empty() {
            let tag = node.tag.trim();
            if tag.is_empty() {
                tracing::warn!(node = %node.id, "节点缺少名称与 tag，订阅跳过该节点");
                return None;
            }
            tag.to_string()
        } else {
            name.to_string()
        };

        let fragment = match serde_json::from_str::<Value>(node.config_json.trim()) {
            Ok(value) if value.is_object() => value,
            _ => {
                tracing::warn!(node = %node.id, "节点 config_json 不是 JSON 对象，订阅跳过该节点");
                return None;
            }
        };
        // 片段里的传输配置可能叫 stream（历史）或 streamSettings（Xray 原生）
        let stream = fragment
            .get("streamSettings")
            .or_else(|| fragment.get("stream"))
            .filter(|value| value.is_object());
        let settings = fragment.get("settings").filter(|value| value.is_object());

        // 片段是事实来源，缺省才回落到节点表里的冗余列（和 xray::build_config 一致）。
        let transport = stream
            .and_then(|stream| get_str(stream, "network"))
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| node.transport.trim().to_ascii_lowercase());
        let transport = if transport.is_empty() {
            "tcp".to_string()
        } else {
            transport
        };
        let security = stream
            .and_then(|stream| get_str(stream, "security"))
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| node.security.trim().to_ascii_lowercase());
        let security = if security.is_empty() {
            "none".to_string()
        } else {
            security
        };

        let mut params = BTreeMap::new();

        // Shadowsocks 的 settings 是订阅凭据的事实来源：方法/密钥/network 任何一项
        // 不合格，发出去的节点都连不上。与 `xray::build_config` 用同一套判定，
        // 脏节点跳过并记 warn，而不是把「订阅里有、服务器上没有」的节点发给用户。
        if protocol == "ss" {
            if let Some(problem) = xray::shadowsocks_problem(&fragment) {
                tracing::warn!(
                    node = %node.id,
                    code = problem.code,
                    reason = %problem.message,
                    "Shadowsocks 节点设置不合法，订阅跳过该节点"
                );
                return None;
            }
            // 订阅天然是「每用户一把密钥」的多用户形态；Xray 只对 AES 实现了
            // SS2022 多用户。发出去的 chacha 节点在服务器上根本不成立，跳过。
            let method = ss_method(settings);
            if xray::ss2022_multiuser_unsupported(&method) {
                tracing::warn!(
                    node = %node.id,
                    method = %method,
                    "SS2022 方法不支持多用户（Xray 仅支持 2022-blake3-aes-*），订阅跳过该节点"
                );
                return None;
            }
        }

        // 凭据：vless/vmess 用派生 UUID，trojan/ss 用同一个 UUID 当密码，
        // 保证一个 (user, node) 只有一个可替换的凭据。
        let uuid = credentials::sub_uuid(secret, user_id, &node.id);
        match protocol {
            "vless" => {
                params.insert("uuid".into(), uuid.clone());
                set(
                    &mut params,
                    "flow",
                    first_client(&fragment)
                        .and_then(|client| get_str(client, "flow"))
                        .map(str::to_string),
                );
            }
            "vmess" => {
                params.insert("uuid".into(), uuid.clone());
                let alter_id = first_client(&fragment)
                    .and_then(|client| client.get("alterId"))
                    .and_then(Value::as_i64)
                    .or_else(|| {
                        settings
                            .and_then(|settings| settings.get("alterId"))
                            .and_then(Value::as_i64)
                    });
                if let Some(alter_id) = alter_id {
                    params.insert("alter_id".into(), alter_id.to_string());
                }
            }
            "trojan" => {
                params.insert("password".into(), uuid.clone());
            }
            "ss" => {
                let method = ss_method(settings);
                // 与 `xray::build_config` 的每用户凭据保持一致：
                // * SS2022：每用户密钥，长度必须随方法（AES-128 = 16，AES-256 = 32）；
                // * 旧 AEAD：用户密码就是 UUID。
                let user_password = if let Some(key_len) = xray::ss2022_key_len(&method) {
                    credentials::ss2022_user_key_len(secret, user_id, &node.id, key_len)
                } else {
                    uuid.clone()
                };
                params.insert("method".into(), method.clone());
                params.insert("password".into(), user_password);
                if xray::is_ss2022(&method) {
                    set(
                        &mut params,
                        "server_password",
                        settings
                            .and_then(|settings| get_str(settings, "password"))
                            .map(str::trim)
                            .filter(|key| !key.is_empty())
                            // 与落盘配置统一成标准 base64：订阅里的
                            // `ServerPassword:UserPassword` 必须和服务器逐字节一致。
                            .map(|key| {
                                xray::canonical_ss2022_key(key).unwrap_or_else(|| key.to_string())
                            }),
                    );
                }
            }
            _ => {
                tracing::warn!(node = %node.id, protocol, "未知协议，订阅跳过该节点");
                return None;
            }
        }

        // 安全层参数。
        if security == "tls" {
            if let Some(tls) = stream
                .and_then(|stream| stream.get("tlsSettings"))
                .filter(|value| value.is_object())
            {
                set(
                    &mut params,
                    "sni",
                    get_str(tls, "serverName").map(str::to_string),
                );
                set(
                    &mut params,
                    "fingerprint",
                    get_str(tls, "fingerprint").map(str::to_string),
                );
                set(&mut params, "alpn", join_string_array(tls.get("alpn")));
                set_bool(&mut params, "allow_insecure", tls.get("allowInsecure"));
            }
        } else if security == "reality" {
            if let Some(reality) = stream
                .and_then(|stream| stream.get("realitySettings"))
                .filter(|value| value.is_object())
            {
                set(
                    &mut params,
                    "sni",
                    get_first_str(reality, "serverNames").map(str::to_string),
                );
                // Xray 入站只存 privateKey，客户端需要的是 publicKey。
                // 显式给了 publicKey（导入的配置）就用显式值，否则用 X25519 反推。
                let explicit = get_str(reality, "publicKey").map(str::to_string);
                let derived = if explicit.is_none() {
                    get_str(reality, "privateKey").and_then(reality::public_key_from_private)
                } else {
                    None
                };
                set(&mut params, "public_key", explicit.or(derived));
                set(
                    &mut params,
                    "short_id",
                    get_first_str(reality, "shortIds").map(str::to_string),
                );
                set(
                    &mut params,
                    "fingerprint",
                    get_str(reality, "fingerprint").map(str::to_string),
                );
            }
            if !params.contains_key("public_key") {
                tracing::warn!(
                    node = %node.id,
                    tag = %node.tag,
                    "reality 节点缺少可用的 publicKey（私钥缺失或非法），订阅跳过该节点"
                );
                return None;
            }
        }

        // 传输层参数。
        match transport.as_str() {
            "ws" => {
                if let Some(ws) = stream
                    .and_then(|stream| stream.get("wsSettings"))
                    .filter(|value| value.is_object())
                {
                    let path = get_str(ws, "path")
                        .map(str::to_string)
                        .unwrap_or_else(|| "/".to_string());
                    set(&mut params, "path", Some(path));
                    set(&mut params, "host", header_host(ws.get("headers")));
                }
            }
            "grpc" => {
                if let Some(grpc) = stream
                    .and_then(|stream| stream.get("grpcSettings"))
                    .filter(|value| value.is_object())
                {
                    set(
                        &mut params,
                        "service_name",
                        get_str(grpc, "serviceName").map(str::to_string),
                    );
                }
            }
            "h2" | "http" => {
                let http = stream
                    .and_then(|stream| {
                        stream
                            .get("httpSettings")
                            .or_else(|| stream.get("h2Settings"))
                    })
                    .filter(|value| value.is_object());
                if let Some(http) = http {
                    set(
                        &mut params,
                        "path",
                        get_str(http, "path").map(str::to_string),
                    );
                    set(&mut params, "host", get_host(http.get("host")));
                }
            }
            _ => {}
        }

        Some(Self {
            name,
            protocol: protocol.to_string(),
            server: server.to_string(),
            port,
            public_port,
            transport,
            security,
            params,
        })
    }
}

/// 订阅上下文：渲染器只读它，不查库、不碰 HTTP。
pub struct SubContext<'a> {
    pub nodes: &'a [SubNode],
    pub user_label: &'a str,
    pub traffic: Option<TrafficInfo>,
    /// Clash `rules:` 段。URI 渲染器不读它，所以切换规则模板不影响 URI 订阅。
    pub rules: &'a [String],
}

/// 内置兜底规则：与旧版写死的两条完全一致。
///
/// 正常情况下订阅端总会拿到默认模板；只有模板表为空（理论上不会）时才用它，
/// 保证「没有任何模板」的极端情况下订阅内容仍和升级前一致。
pub fn default_rules() -> Vec<String> {
    vec!["GEOIP,CN,DIRECT".to_string(), "MATCH,PROXY".to_string()]
}

/// 最终生效的规则：`rules` 用于渲染，`rule_template_*` 用于订阅列表展示。
///
/// 空规则模板视为脏数据（写入校验会拦住），这里仍回落到内置规则，
/// 同时把生效模板报成 `None`，避免前端显示一个实际没参与渲染的模板。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EffectiveRules {
    pub rule_template_id: Option<String>,
    pub rule_template_name: Option<String>,
    pub rules: Vec<String>,
}

/// 把解析出的模板（或 `None`）落成最终生效值。
pub fn effective_rules(template: Option<RuleTemplate>) -> EffectiveRules {
    match template {
        Some(template) if !template.rules.is_empty() => EffectiveRules {
            rule_template_id: Some(template.id),
            rule_template_name: Some(template.name),
            rules: template.rules,
        },
        _ => EffectiveRules {
            rule_template_id: None,
            rule_template_name: None,
            rules: default_rules(),
        },
    }
}

/// 写进 `Subscription-Userinfo` 头的流量信息。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TrafficInfo {
    pub upload: u64,
    pub download: u64,
    pub total: Option<u64>,
    pub expire: Option<i64>,
}

impl TrafficInfo {
    /// `upload=..; download=..; total=..; expire=..`，`total` / `expire` 缺失时省略该段。
    pub fn userinfo_header(&self) -> String {
        let mut parts = vec![
            format!("upload={}", self.upload),
            format!("download={}", self.download),
        ];
        if let Some(total) = self.total {
            parts.push(format!("total={total}"));
        }
        if let Some(expire) = self.expire {
            parts.push(format!("expire={expire}"));
        }
        parts.join("; ")
    }
}

// ---------------------------------------------------------------------------
// Exporter 注册表
// ---------------------------------------------------------------------------

pub trait Exporter: Send + Sync {
    fn id(&self) -> &'static str;
    fn content_type(&self) -> &'static str;
    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String>;
}

static EXPORTERS: &[&dyn Exporter] = &[
    &ClashExporter,
    &MihomoExporter,
    &StashExporter,
    &SurgeExporter,
    &EgernExporter,
    &SurfboardExporter,
    &LoonExporter,
    &QxExporter,
    &SingboxExporter,
    &UriExporter,
    &ShadowrocketExporter,
    &V2RayExporter,
    // 完整配置格式追加在末尾：注册表顺序被 400 文案、前端下拉与 golden 输出依赖，
    // 只追加不插队，既有格式的内容与顺序都不变。
    &SingboxFullExporter,
    &SurgeFullExporter,
];

/// 已注册的渲染器；新增格式 = 加一个文件 + 这里加一行。
pub fn exporters() -> &'static [&'static dyn Exporter] {
    EXPORTERS
}

pub fn find_exporter(id: &str) -> Option<&'static dyn Exporter> {
    let id = id.trim();
    EXPORTERS
        .iter()
        .copied()
        .find(|exporter| exporter.id().eq_ignore_ascii_case(id))
}

/// 已注册渲染器的 id 列表，用于 400 错误里告诉用户当前支持什么。
pub fn exporter_ids() -> Vec<&'static str> {
    EXPORTERS.iter().map(|exporter| exporter.id()).collect()
}

/// `?target=` → UA 嗅探 → 回落 clash。
///
/// 显式给了 `target` 就只认已注册的渲染器；未知目标返回 `None`，由调用方转成 400，
/// 而不是把 clash YAML 塞给 sing-box 用户。没给 `target` 时才按 UA 嗅探并回落 clash。
///
/// UA 表按「越具体越靠前」排序：`Shadowrocket` 不能落到 clash，`Stash` 也不能
/// 被 `clash` 兜走；都不认识时才回落 clash。
pub fn select_exporter(
    target: Option<&str>,
    user_agent: Option<&str>,
) -> Option<&'static dyn Exporter> {
    if let Some(target) = target.map(str::trim).filter(|target| !target.is_empty()) {
        return find_exporter(target);
    }
    if let Some(user_agent) = user_agent {
        let user_agent = user_agent.to_ascii_lowercase();
        let id = if user_agent.contains("shadowrocket") {
            "shadowrocket"
        } else if user_agent.contains("v2rayng") || user_agent.contains("v2rayn") {
            "v2ray"
        } else if user_agent.contains("sing-box") || user_agent.contains("singbox") {
            "singbox"
        } else if user_agent.contains("stash") {
            "stash"
        } else if user_agent.contains("surfboard") {
            "surfboard"
        } else if user_agent.contains("quantumult") {
            "qx"
        } else if user_agent.contains("loon") {
            "loon"
        } else if user_agent.contains("egern") {
            "egern"
        } else if user_agent.contains("surge") {
            "surge"
        } else if user_agent.contains("clash") || user_agent.contains("mihomo") {
            "clash"
        } else {
            return find_exporter("clash");
        };
        if let Some(exporter) = find_exporter(id) {
            return Some(exporter);
        }
    }
    find_exporter("clash")
}

// ---------------------------------------------------------------------------
// Clash / mihomo
// ---------------------------------------------------------------------------

/// mihomo / Stash / Clash Verge 的 YAML。
pub struct ClashExporter;

impl Exporter for ClashExporter {
    fn id(&self) -> &'static str {
        "clash"
    }

    fn content_type(&self) -> &'static str {
        "text/yaml; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        let mut out = String::new();
        out.push_str("mixed-port: 7890\n");
        out.push_str("allow-lan: false\n");
        out.push_str("mode: rule\n");
        out.push_str("log-level: info\n\n");

        out.push_str(&clash_proxies_section(ctx.nodes));
        out.push('\n');

        out.push_str(&clash_groups(ctx.nodes));
        out.push_str("\nrules:\n");
        if ctx.rules.is_empty() {
            push_clash_rules(&mut out, &default_rules());
        } else {
            push_clash_rules(&mut out, ctx.rules);
        }
        Ok(out)
    }
}

/// `proxies:` 段，Clash 与 mihomo 共用。
///
/// 端口、密码、SNI、传输层等字段全在 [`clash_proxy`] 里，mihomo 只换配置骨架，
/// 节点表达不复制第二份——否则两个 YAML 格式迟早漂移。
fn clash_proxies_section(nodes: &[SubNode]) -> String {
    let mut out = String::from("proxies:");
    if nodes.is_empty() {
        out.push_str(" []\n");
    } else {
        out.push('\n');
        for node in nodes {
            out.push_str(&clash_proxy(node));
        }
    }
    out
}

/// 规则原样作为 YAML 双引号标量输出（与旧版 `  - "GEOIP,CN,DIRECT"` 逐字节一致）。
fn push_clash_rules(out: &mut String, rules: &[String]) {
    for rule in rules {
        out.push_str(&format!("  - {}\n", yaml_string(rule)));
    }
}

fn clash_proxy(node: &SubNode) -> String {
    let mut out = String::new();
    out.push_str(&format!("  - name: {}\n", yaml_string(&node.name)));
    out.push_str(&format!("    type: {}\n", node.protocol));
    out.push_str(&format!("    server: {}\n", yaml_string(&node.server)));
    out.push_str(&format!("    port: {}\n", node.effective_port()));

    match node.protocol.as_str() {
        "vless" => {
            out.push_str(&format!(
                "    uuid: {}\n",
                yaml_string(node.param("uuid").unwrap_or_default())
            ));
            push_line(&mut out, "    flow", node.param("flow"));
        }
        "vmess" => {
            out.push_str(&format!(
                "    uuid: {}\n",
                yaml_string(node.param("uuid").unwrap_or_default())
            ));
            let alter_id = node.param("alter_id").unwrap_or("0");
            out.push_str(&format!("    alterId: {alter_id}\n"));
            out.push_str("    cipher: auto\n");
        }
        "trojan" => {
            out.push_str(&format!(
                "    password: {}\n",
                yaml_string(node.param("password").unwrap_or_default())
            ));
        }
        "ss" => {
            out.push_str(&format!(
                "    cipher: {}\n",
                yaml_string(node.param("method").unwrap_or(xray::SS_DEFAULT_METHOD))
            ));
            // SS2022 的客户端密码是 `server:user`，不能直接写用户密钥。
            out.push_str(&format!(
                "    password: {}\n",
                yaml_string(&node.ss_client_password())
            ));
        }
        _ => {}
    }
    out.push_str("    udp: true\n");

    let reality = node.security == "reality";
    if matches!(node.protocol.as_str(), "vless" | "vmess") && is_tls(&node.security) {
        out.push_str("    tls: true\n");
        push_line(&mut out, "    servername", node.param("sni"));
        push_alpn(&mut out, node);
        if node.param("allow_insecure") == Some("true") {
            out.push_str("    skip-cert-verify: true\n");
        }
        if let Some(fingerprint) = node.param("fingerprint") {
            push_line(&mut out, "    client-fingerprint", Some(fingerprint));
        } else if reality {
            out.push_str("    client-fingerprint: chrome\n");
        }
        if reality {
            out.push_str("    reality-opts:\n");
            push_line(&mut out, "      public-key", node.param("public_key"));
            push_line(&mut out, "      short-id", node.param("short_id"));
        }
    } else if node.protocol == "trojan" && is_tls(&node.security) {
        push_line(&mut out, "    sni", node.param("sni"));
        push_alpn(&mut out, node);
        if node.param("allow_insecure") == Some("true") {
            out.push_str("    skip-cert-verify: true\n");
        }
    }

    // ss 没有可用的 Clash 传输层表达，跳过。
    if node.protocol != "ss" {
        clash_transport(&mut out, node);
    }
    out
}

fn clash_transport(out: &mut String, node: &SubNode) {
    match node.transport.as_str() {
        "ws" => {
            out.push_str("    network: ws\n");
            out.push_str("    ws-opts:\n");
            out.push_str(&format!(
                "      path: {}\n",
                yaml_string(node.param("path").unwrap_or("/"))
            ));
            if let Some(host) = node.param("host") {
                out.push_str("      headers:\n");
                out.push_str(&format!("        Host: {}\n", yaml_string(host)));
            }
        }
        "grpc" => {
            out.push_str("    network: grpc\n");
            if let Some(service_name) = node.param("service_name") {
                out.push_str("    grpc-opts:\n");
                out.push_str(&format!(
                    "      grpc-service-name: {}\n",
                    yaml_string(service_name)
                ));
            }
        }
        "h2" => {
            out.push_str("    network: h2\n");
            out.push_str("    h2-opts:\n");
            out.push_str(&format!(
                "      path: {}\n",
                yaml_string(node.param("path").unwrap_or("/"))
            ));
            if let Some(host) = node.param("host") {
                out.push_str("      host:\n");
                out.push_str(&format!("        - {}\n", yaml_string(host)));
            }
        }
        "httpupgrade" => {
            out.push_str("    network: httpupgrade\n");
            out.push_str("    httpupgrade-opts:\n");
            out.push_str(&format!(
                "      path: {}\n",
                yaml_string(node.param("path").unwrap_or("/"))
            ));
            if let Some(host) = node.param("host") {
                out.push_str("      headers:\n");
                out.push_str(&format!("        Host: {}\n", yaml_string(host)));
            }
        }
        transport if transport != "tcp" && !transport.is_empty() => {
            out.push_str(&format!("    network: {transport}\n"));
        }
        _ => {}
    }
}

/// 地区关键词表；命中第一个就归组，都没命中进「其他」。
const REGIONS: &[&str] = &[
    "香港",
    "台湾",
    "日本",
    "新加坡",
    "美国",
    "韩国",
    "英国",
    "德国",
    "澳门",
    "法国",
    "加拿大",
    "澳大利亚",
    "俄罗斯",
    "荷兰",
    "印度",
];

const OTHER_REGION: &str = "其他";

fn region_of(name: &str) -> Option<&'static str> {
    REGIONS.iter().copied().find(|region| name.contains(region))
}

fn clash_groups(nodes: &[SubNode]) -> String {
    let mut regions: Vec<(&'static str, Vec<&str>)> = Vec::new();
    for region in REGIONS {
        let members: Vec<&str> = nodes
            .iter()
            .filter(|node| region_of(&node.name) == Some(*region))
            .map(|node| node.name.as_str())
            .collect();
        if !members.is_empty() {
            regions.push((region, members));
        }
    }
    let others: Vec<&str> = nodes
        .iter()
        .filter(|node| region_of(&node.name).is_none())
        .map(|node| node.name.as_str())
        .collect();
    if !others.is_empty() {
        regions.push((OTHER_REGION, others));
    }

    let mut out = String::from("proxy-groups:\n");
    out.push_str("  - name: \"PROXY\"\n    type: select\n    proxies:\n");
    if !nodes.is_empty() {
        out.push_str("      - \"AUTO\"\n");
    }
    for (region, _) in &regions {
        out.push_str(&format!("      - {}\n", yaml_string(region)));
    }
    out.push_str("      - \"DIRECT\"\n");

    if !nodes.is_empty() {
        push_url_test_group(&mut out, "AUTO", &node_names(nodes));
        for (region, members) in &regions {
            push_url_test_group(&mut out, region, members);
        }
    }
    out
}

fn node_names(nodes: &[SubNode]) -> Vec<&str> {
    nodes.iter().map(|node| node.name.as_str()).collect()
}

fn push_url_test_group(out: &mut String, name: &str, members: &[&str]) {
    out.push_str(&format!("  - name: {}\n", yaml_string(name)));
    out.push_str("    type: url-test\n");
    out.push_str("    url: \"http://www.gstatic.com/generate_204\"\n");
    out.push_str("    interval: 300\n");
    out.push_str("    tolerance: 50\n");
    out.push_str("    proxies:\n");
    for member in members {
        out.push_str(&format!("      - {}\n", yaml_string(member)));
    }
}

fn is_tls(security: &str) -> bool {
    matches!(security, "tls" | "reality" | "xtls")
}

/// 双引号 YAML 标量：节点名里可能有冒号、井号、中文，统一转义最稳。
fn yaml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch.is_control() => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn push_line(out: &mut String, key: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        out.push_str(&format!("{key}: {}\n", yaml_string(value)));
    }
}

fn push_alpn(out: &mut String, node: &SubNode) {
    let Some(alpn) = node.param("alpn") else {
        return;
    };
    out.push_str("    alpn:\n");
    for item in alpn
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        out.push_str(&format!("      - {}\n", yaml_string(item)));
    }
}

// ---------------------------------------------------------------------------
// mihomo（完整配置）
// ---------------------------------------------------------------------------

/// mihomo 的代理组名。规则里的 `PROXY` / `AUTO` / 地区组都归到「节点选择」，
/// 因为这份配置只生成两个组；不映射就会让客户端报「未知策略」。
const MIHOMO_SELECT_GROUP: &str = "节点选择";
const MIHOMO_AUTO_GROUP: &str = "自动选择";
const MIHOMO_TEST_URL: &str = "http://www.gstatic.com/generate_204";

/// mihomo 的**完整**配置（不是片段）：`mixed-port` / `dns` / `proxies` /
/// `proxy-groups` / `rules` 一次给全，可直接导入。
///
/// 节点表达与 Clash 共用 [`clash_proxy`]（端口、密码、SNI、REALITY、传输层），
/// 本渲染器只负责骨架、两个固定分组和规则策略名映射。无节点时仍输出合法骨架：
/// `proxies: []`、两个组保留但 `proxies: []`、规则仍指向存在的组。
pub struct MihomoExporter;

impl Exporter for MihomoExporter {
    fn id(&self) -> &'static str {
        "mihomo"
    }

    fn content_type(&self) -> &'static str {
        "text/yaml; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        let mut out = String::new();
        out.push_str("mixed-port: 7890\n");
        out.push_str("allow-lan: false\n");
        out.push_str("mode: rule\n");
        out.push_str("log-level: info\n");
        out.push_str("ipv6: true\n\n");

        out.push_str("dns:\n");
        out.push_str("  enable: true\n");
        out.push_str("  enhanced-mode: fake-ip\n");
        out.push_str("  fake-ip-range: 198.18.0.1/16\n");
        out.push_str("  nameserver:\n");
        out.push_str("    - https://223.5.5.5/dns-query\n");
        out.push_str("    - https://1.1.1.1/dns-query\n\n");

        // 与 clash 逐字段一致；节点名也来自同一个 `SubNode::name`（端点已去重）。
        out.push_str(&clash_proxies_section(ctx.nodes));
        out.push('\n');

        out.push_str("proxy-groups:\n");
        out.push_str(&format!(
            "  - name: {}\n    type: select\n",
            yaml_string(MIHOMO_SELECT_GROUP)
        ));
        let mut select_members: Vec<&str> = Vec::new();
        if !ctx.nodes.is_empty() {
            select_members.push(MIHOMO_AUTO_GROUP);
        }
        select_members.extend(node_names(ctx.nodes));
        push_mihomo_group_proxies(&mut out, &select_members);

        out.push_str(&format!(
            "  - name: {}\n    type: url-test\n    url: {}\n    interval: 300\n",
            yaml_string(MIHOMO_AUTO_GROUP),
            yaml_string(MIHOMO_TEST_URL)
        ));
        push_mihomo_group_proxies(&mut out, &node_names(ctx.nodes));
        out.push('\n');

        out.push_str("rules:\n");
        for rule in mihomo_rules(ctx) {
            out.push_str(&format!("  - {}\n", yaml_string(&rule)));
        }
        Ok(out)
    }
}

/// 组内成员用 flow 序列：空组输出 `proxies: []`，有成员时逐个双引号转义。
///
/// 节点名可能含 `,`、`]`、`"`，只有走 [`yaml_string`] 才不会把 flow 序列截断。
fn push_mihomo_group_proxies(out: &mut String, members: &[&str]) {
    out.push_str("    proxies: [");
    for (index, member) in members.iter().enumerate() {
        if index > 0 {
            out.push_str(", ");
        }
        out.push_str(&yaml_string(member));
    }
    out.push_str("]\n");
}

/// 把规则模板映射成 mihomo 可用的规则。
///
/// 策略名必须指向本配置里真实存在的出站或组：`DIRECT` / `REJECT` 原样保留，
/// 其余（`PROXY`、`AUTO`、地区组名）统一指向「节点选择」。mihomo 不认识的
/// 规则类型（例如没有 providers 的 `RULE-SET`）直接跳过并告警，避免整份配置被拒收。
fn mihomo_rules(ctx: &SubContext<'_>) -> Vec<String> {
    let mut rules: Vec<String> = rules_or_default(ctx)
        .iter()
        .filter_map(|rule| mihomo_rule(rule))
        .collect();
    // 模板里的规则一条都表达不了时回落到内置两条，保证 rules 段永不为空。
    if rules.is_empty() {
        rules = default_rules()
            .iter()
            .filter_map(|rule| mihomo_rule(rule))
            .collect();
    }
    rules
}

fn mihomo_rule(rule: &str) -> Option<String> {
    let (kind, value, policy, no_resolve) = parse_rule(rule)?;
    if !matches!(
        kind.as_str(),
        "DOMAIN" | "DOMAIN-SUFFIX" | "DOMAIN-KEYWORD" | "GEOIP" | "IP-CIDR" | "IP-CIDR6" | "MATCH"
    ) {
        tracing::warn!(rule = %rule, "规则类型无法在 mihomo 里安全表达，跳过该条规则");
        return None;
    }
    let policy = match policy.to_ascii_uppercase().as_str() {
        "DIRECT" => "DIRECT",
        "REJECT" | "REJECT-DROP" => "REJECT",
        _ => MIHOMO_SELECT_GROUP,
    };
    let mut line = kind;
    if let Some(value) = value {
        line.push(',');
        line.push_str(&value);
    }
    line.push(',');
    line.push_str(policy);
    if no_resolve {
        line.push_str(",no-resolve");
    }
    Some(line)
}

// ---------------------------------------------------------------------------
// URI 列表（Shadowrocket / v2rayN / 通用）
// ---------------------------------------------------------------------------

pub struct UriExporter;

impl Exporter for UriExporter {
    fn id(&self) -> &'static str {
        "uri"
    }

    fn content_type(&self) -> &'static str {
        "text/plain; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        let mut out = String::new();
        for node in ctx.nodes {
            let line = match node.protocol.as_str() {
                "vless" => render_vless(node),
                "vmess" => render_vmess(node),
                "trojan" => render_trojan(node),
                "ss" => render_ss(node),
                other => {
                    tracing::warn!(protocol = other, "URI 渲染器不支持该协议，跳过");
                    continue;
                }
            };
            out.push_str(&line);
            out.push('\n');
        }
        Ok(out)
    }
}

fn render_vless(node: &SubNode) -> String {
    let mut query = Query::default();
    query.push("encryption", Some("none"));
    query.push("type", Some(node.transport.as_str()));
    query.push("security", Some(node.security.as_str()));
    push_transport_query(&mut query, node);
    query.push("flow", node.param("flow"));
    query.push("sni", node.param("sni"));
    query.push("fp", node.param("fingerprint"));
    query.push("pbk", node.param("public_key"));
    query.push("sid", node.param("short_id"));
    query.push("alpn", node.param("alpn"));
    push_allow_insecure(&mut query, node);
    format!(
        "vless://{}@{}:{}{}#{}",
        node.param("uuid").unwrap_or_default(),
        uri_host(&node.server),
        node.effective_port(),
        query.finish(),
        percent_encode(&node.name)
    )
}

fn render_vmess(node: &SubNode) -> String {
    let mut payload = json!({
        "v": "2",
        "ps": node.name,
        "add": node.server,
        "port": node.effective_port().to_string(),
        "id": node.param("uuid").unwrap_or_default(),
        "aid": node.param("alter_id").unwrap_or("0"),
        "scy": "auto",
        "net": node.transport,
        "type": "none",
    });
    if let Some(path) = node.param("path") {
        payload["path"] = json!(path);
    }
    if let Some(host) = node.param("host") {
        payload["host"] = json!(host);
    }
    if node.transport == "grpc" {
        if let Some(service_name) = node.param("service_name") {
            payload["path"] = json!(service_name);
        }
    }
    if is_tls(&node.security) {
        payload["tls"] = json!("tls");
        if let Some(sni) = node.param("sni") {
            payload["sni"] = json!(sni);
        }
        if let Some(fingerprint) = node.param("fingerprint") {
            payload["fp"] = json!(fingerprint);
        }
        if let Some(alpn) = node.param("alpn") {
            payload["alpn"] = json!(alpn);
        }
    }
    format!("vmess://{}", STANDARD.encode(payload.to_string()))
}

fn render_trojan(node: &SubNode) -> String {
    let mut query = Query::default();
    query.push(
        "security",
        Some(if node.security == "none" {
            "none"
        } else {
            "tls"
        }),
    );
    query.push("type", Some(node.transport.as_str()));
    push_transport_query(&mut query, node);
    query.push("sni", node.param("sni"));
    query.push("alpn", node.param("alpn"));
    push_allow_insecure(&mut query, node);
    format!(
        "trojan://{}@{}:{}{}#{}",
        percent_encode(node.param("password").unwrap_or_default()),
        uri_host(&node.server),
        node.effective_port(),
        query.finish(),
        percent_encode(&node.name)
    )
}

fn render_ss(node: &SubNode) -> String {
    let method = node.param("method").unwrap_or(xray::SS_DEFAULT_METHOD);
    // SS2022：`userinfo = base64(method:ServerPassword:UserPassword)`。
    let password = node.ss_client_password();
    let userinfo = URL_SAFE_NO_PAD.encode(format!("{method}:{password}"));
    format!(
        "ss://{userinfo}@{}:{}#{}",
        uri_host(&node.server),
        node.effective_port(),
        percent_encode(&node.name)
    )
}

fn push_transport_query(query: &mut Query, node: &SubNode) {
    match node.transport.as_str() {
        "ws" => {
            query.push("path", node.param("path"));
            query.push("host", node.param("host"));
        }
        "grpc" => query.push("serviceName", node.param("service_name")),
        "h2" | "http" => {
            query.push("path", node.param("path"));
            query.push("host", node.param("host"));
        }
        _ => {}
    }
}

fn push_allow_insecure(query: &mut Query, node: &SubNode) {
    if node.param("allow_insecure") == Some("true") {
        query.push("allowInsecure", Some("1"));
    }
}

/// 按 RFC 3986 的 unreserved 集合做百分号编码（query 值与 fragment 名称共用）。
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// IPv6 字面量在 URI 里必须加方括号。
fn uri_host(server: &str) -> String {
    if server.contains(':') && !server.starts_with('[') {
        format!("[{server}]")
    } else {
        server.to_string()
    }
}

#[derive(Default)]
struct Query {
    parts: Vec<String>,
}

impl Query {
    fn push(&mut self, key: &str, value: Option<&str>) {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            self.parts.push(format!("{key}={}", percent_encode(value)));
        }
    }

    fn finish(self) -> String {
        if self.parts.is_empty() {
            String::new()
        } else {
            format!("?{}", self.parts.join("&"))
        }
    }
}

// ---------------------------------------------------------------------------
// Stash（Clash 兼容 YAML）
// ---------------------------------------------------------------------------

/// Stash 的配置骨架与 Clash 几乎一致：`proxies` / `proxy-groups` / `rules`，
/// 只是 Stash 识别首行注释为客户端标记，AUTO 组用 `url-test`（Clash 生成器已是）。
///
/// 复用 `ClashExporter` 而不复制一份生成器：以后 Clash 侧新增传输表达时，
/// Stash 自动跟上，不会出现两份逐渐漂移的 YAML 逻辑。
pub struct StashExporter;

impl Exporter for StashExporter {
    fn id(&self) -> &'static str {
        "stash"
    }

    fn content_type(&self) -> &'static str {
        "text/yaml; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        Ok(format!("# stash\n{}", ClashExporter.render(ctx)?))
    }
}

// ---------------------------------------------------------------------------
// Surge / Surfboard / Loon / Quantumult X（INI 家族）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IniFlavor {
    Surge,
    Surfboard,
    Loon,
    Qx,
}

impl IniFlavor {
    fn id(self) -> &'static str {
        match self {
            Self::Surge => "surge",
            Self::Surfboard => "surfboard",
            Self::Loon => "loon",
            Self::Qx => "qx",
        }
    }

    fn is_qx(self) -> bool {
        matches!(self, Self::Qx)
    }
}

/// INI 渲染结果：正文 + 跳过计数。
///
/// 计数不写进正文（客户端不认注释之外的统计），而是回给调用方记 warn；
/// 单测直接断言计数，避免「跳过了一条但没人知道」。
struct IniOutput {
    body: String,
    skipped_nodes: usize,
    skipped_rules: usize,
}

fn log_skipped(client: &str, skipped_nodes: usize, skipped_rules: usize) {
    if skipped_nodes > 0 {
        tracing::warn!(
            client,
            skipped = skipped_nodes,
            "订阅渲染跳过该客户端不支持的节点"
        );
    }
    if skipped_rules > 0 {
        tracing::warn!(
            client,
            skipped = skipped_rules,
            "规则模板里有该客户端映射不了的规则，已跳过"
        );
    }
}

fn rules_or_default(ctx: &SubContext<'_>) -> Vec<String> {
    if ctx.rules.is_empty() {
        default_rules()
    } else {
        ctx.rules.to_vec()
    }
}

/// 节点名放进 INI 的键/值里要避开分隔符：逗号会截断字段，等号会被当成键值分隔。
/// 只替换真正有歧义的字符，普通中英文名保持原样。
fn ini_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            ',' => out.push('，'),
            '=' => out.push('＝'),
            '\n' | '\r' | '\t' => out.push(' '),
            ch if ch.is_control() => {}
            ch => out.push(ch),
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        "node".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 地区分组（与 Clash 同一套 `REGIONS` 顺序），`members` 里是渲染成功的节点。
fn region_groups<'a>(nodes: &[&'a SubNode]) -> Vec<(&'static str, Vec<&'a SubNode>)> {
    let mut groups = Vec::new();
    for region in REGIONS {
        let members: Vec<&SubNode> = nodes
            .iter()
            .copied()
            .filter(|node| region_of(&node.name) == Some(*region))
            .collect();
        if !members.is_empty() {
            groups.push((*region, members));
        }
    }
    let others: Vec<&SubNode> = nodes
        .iter()
        .copied()
        .filter(|node| region_of(&node.name).is_none())
        .collect();
    if !others.is_empty() {
        groups.push((OTHER_REGION, others));
    }
    groups
}

/// 这家客户端能不能表达这个节点。
///
/// 规则偏保守：表达不了就跳过，绝不输出一条会被客户端整份拒收的配置。
/// - REALITY：只有 Surge / Surfboard 支持（写 `reality=true`），必须带 public_key；
/// - 传输：INI 家族只支持 tcp / ws，gRPC / h2 / httpupgrade 一律跳过；
/// - Shadowsocks：没有传输层与安全层的表达，只接受 `tcp + none`。
fn ini_supported(flavor: IniFlavor, node: &SubNode) -> bool {
    if !matches!(node.protocol.as_str(), "vless" | "vmess" | "trojan" | "ss") {
        return false;
    }
    if !matches!(node.security.as_str(), "none" | "tls" | "reality" | "xtls") {
        return false;
    }
    if node.security == "reality" {
        if node.protocol != "vless" || node.param("public_key").is_none() {
            return false;
        }
        if matches!(flavor, IniFlavor::Loon | IniFlavor::Qx) {
            return false;
        }
    }
    if node.protocol == "ss" && (node.transport != "tcp" || node.security != "none") {
        return false;
    }
    matches!(node.transport.as_str(), "tcp" | "" | "ws")
}

/// Surge / Surfboard / Loon 的节点行；三家的字段名差异集中在这里。
fn family_node_line(flavor: IniFlavor, node: &SubNode) -> Option<String> {
    if !ini_supported(flavor, node) {
        return None;
    }
    let host = uri_host(&node.server);
    let mut parts: Vec<String> = match node.protocol.as_str() {
        "vless" => vec![
            "vless".into(),
            host,
            node.effective_port().to_string(),
            format!("username={}", node.param("uuid").unwrap_or_default()),
        ],
        "vmess" => vec![
            "vmess".into(),
            host,
            node.effective_port().to_string(),
            format!("username={}", node.param("uuid").unwrap_or_default()),
        ],
        "trojan" => vec![
            "trojan".into(),
            host,
            node.effective_port().to_string(),
            format!("password={}", node.param("password").unwrap_or_default()),
        ],
        "ss" => vec![
            "ss".into(),
            host,
            node.effective_port().to_string(),
            format!(
                "encrypt-method={}",
                node.param("method").unwrap_or(xray::SS_DEFAULT_METHOD)
            ),
            // SS2022 的密码必须带 `server:user` 前缀。
            format!("password={}", node.ss_client_password()),
        ],
        _ => return None,
    };

    if matches!(node.protocol.as_str(), "vless" | "vmess") && is_tls(&node.security) {
        parts.push("tls=true".into());
        if let Some(sni) = node.param("sni") {
            parts.push(format!("sni={sni}"));
        }
        if node.param("allow_insecure") == Some("true") {
            parts.push("skip-cert-verify=true".into());
        }
        if node.security == "reality" {
            parts.push("reality=true".into());
            parts.push(format!(
                "public-key={}",
                node.param("public_key").unwrap_or_default()
            ));
            if let Some(short_id) = node.param("short_id") {
                parts.push(format!("short-id={short_id}"));
            }
        }
        if let Some(flow) = node.param("flow") {
            parts.push(format!("flow={flow}"));
        }
    } else if node.protocol == "trojan" {
        if let Some(sni) = node.param("sni") {
            parts.push(format!("sni={sni}"));
        }
        if node.param("allow_insecure") == Some("true") {
            parts.push("skip-cert-verify=true".into());
        }
    }

    if node.transport == "ws" {
        match flavor {
            // Surge / Surfboard 用 ws-* 参数族。
            IniFlavor::Surge | IniFlavor::Surfboard => {
                parts.push("ws=true".into());
                parts.push(format!("ws-path={}", node.param("path").unwrap_or("/")));
                if let Some(ws_host) = node.param("host") {
                    parts.push(format!("ws-headers=Host:{ws_host}"));
                }
            }
            // Loon 用 obfs-* 参数族（字段名与 Surge 不同）。
            IniFlavor::Loon => {
                parts.push("obfs=ws".into());
                parts.push(format!("obfs-uri={}", node.param("path").unwrap_or("/")));
                if let Some(ws_host) = node.param("host") {
                    parts.push(format!("obfs-host={ws_host}"));
                }
            }
            IniFlavor::Qx => return None,
        }
    }

    if !matches!(flavor, IniFlavor::Loon) {
        parts.push("udp-relay=true".into());
    }

    Some(format!("{} = {}", ini_name(&node.name), parts.join(", ")))
}

/// Quantumult X 的 `[server_local]` 行：`协议=host:port, key=value, ...`。
fn qx_node_line(node: &SubNode) -> Option<String> {
    if !ini_supported(IniFlavor::Qx, node) {
        return None;
    }
    let host_port = format!("{}:{}", uri_host(&node.server), node.effective_port());
    let mut parts: Vec<String> = match node.protocol.as_str() {
        "vless" => vec![
            format!("vless={host_port}"),
            "method=none".into(),
            format!("password={}", node.param("uuid").unwrap_or_default()),
        ],
        "vmess" => vec![
            format!("vmess={host_port}"),
            "method=chacha20-poly1305".into(),
            format!("password={}", node.param("uuid").unwrap_or_default()),
        ],
        "trojan" => vec![
            format!("trojan={host_port}"),
            format!("password={}", node.param("password").unwrap_or_default()),
        ],
        "ss" => vec![
            format!("shadowsocks={host_port}"),
            format!(
                "method={}",
                node.param("method").unwrap_or(xray::SS_DEFAULT_METHOD)
            ),
            format!("password={}", node.ss_client_password()),
        ],
        _ => return None,
    };

    let insecure = node.param("allow_insecure") == Some("true");
    if node.transport == "ws" {
        parts.push(format!(
            "obfs={}",
            if is_tls(&node.security) { "wss" } else { "ws" }
        ));
        parts.push(format!("obfs-uri={}", node.param("path").unwrap_or("/")));
        if let Some(ws_host) = node.param("host") {
            parts.push(format!("obfs-host={ws_host}"));
        }
        if insecure {
            parts.push("tls-verification=false".into());
        }
    } else if is_tls(&node.security) {
        if node.protocol == "trojan" {
            parts.push("over-tls=true".into());
            if let Some(sni) = node.param("sni") {
                parts.push(format!("tls-host={sni}"));
            }
        } else {
            parts.push("obfs=over-tls".into());
            if let Some(sni) = node.param("sni") {
                parts.push(format!("obfs-host={sni}"));
            }
        }
        if insecure {
            parts.push("tls-verification=false".into());
        }
    }

    parts.push("udp-relay=true".into());
    parts.push(format!("tag={}", ini_name(&node.name)));
    Some(parts.join(", "))
}

fn push_test_group(out: &mut String, flavor: IniFlavor, name: &str, members: &[&SubNode]) {
    let names: Vec<String> = members.iter().map(|node| ini_name(&node.name)).collect();
    if flavor.is_qx() {
        out.push_str(&format!(
            "url-latency-benchmark={name}, {}, check-interval=300, tolerance=50\n",
            names.join(", ")
        ));
    } else {
        out.push_str(&format!(
            "{name} = url-test, {}, url=http://www.gstatic.com/generate_204, interval=300, tolerance=50\n",
            names.join(", ")
        ));
    }
}

fn push_ini_groups(out: &mut String, flavor: IniFlavor, nodes: &[&SubNode]) {
    let groups = region_groups(nodes);
    let has_nodes = !nodes.is_empty();
    let direct = if flavor.is_qx() { "direct" } else { "DIRECT" };
    let mut members: Vec<String> = Vec::new();
    if has_nodes {
        members.push("AUTO".into());
    }
    members.extend(groups.iter().map(|(region, _)| (*region).to_string()));
    members.push(direct.into());

    if flavor.is_qx() {
        out.push_str(&format!("static=PROXY, {}\n", members.join(", ")));
    } else {
        out.push_str(&format!("PROXY = select, {}\n", members.join(", ")));
    }
    if !has_nodes {
        return;
    }
    push_test_group(out, flavor, "AUTO", nodes);
    for (region, members) in &groups {
        push_test_group(out, flavor, region, members);
    }
}

/// 解析 `TYPE,value,policy[,no-resolve]`；`MATCH` 只有 `TYPE,policy`。
fn parse_rule(rule: &str) -> Option<(String, Option<String>, String, bool)> {
    let parts: Vec<&str> = rule.split(',').map(str::trim).collect();
    let kind = parts.first().copied().filter(|kind| !kind.is_empty())?;
    let kind = kind.to_ascii_uppercase();
    if kind == "MATCH" {
        let policy = parts.get(1).copied().filter(|policy| !policy.is_empty())?;
        if parts.len() > 2 {
            return None;
        }
        return Some((kind, None, policy.to_string(), false));
    }
    if parts.len() < 3 {
        return None;
    }
    let value = parts[1];
    let policy = parts[2];
    if value.is_empty() || policy.is_empty() {
        return None;
    }
    let no_resolve = match parts.get(3) {
        None => false,
        Some(option) if option.eq_ignore_ascii_case("no-resolve") => true,
        Some(_) => return None,
    };
    if parts.len() > 4 {
        return None;
    }
    Some((
        kind,
        Some(value.to_string()),
        policy.to_string(),
        no_resolve,
    ))
}

fn surge_rule_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "DOMAIN" => Some("DOMAIN"),
        "DOMAIN-SUFFIX" => Some("DOMAIN-SUFFIX"),
        "DOMAIN-KEYWORD" => Some("DOMAIN-KEYWORD"),
        "IP-CIDR" => Some("IP-CIDR"),
        "IP-CIDR6" => Some("IP-CIDR6"),
        "GEOIP" => Some("GEOIP"),
        _ => None,
    }
}

fn qx_rule_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "DOMAIN" => Some("host"),
        "DOMAIN-SUFFIX" => Some("host-suffix"),
        "DOMAIN-KEYWORD" => Some("host-keyword"),
        "IP-CIDR" => Some("ip-cidr"),
        "IP-CIDR6" => Some("ip6-cidr"),
        "GEOIP" => Some("geoip"),
        _ => None,
    }
}

/// 只把策略名映射到本格式真实存在的出站/策略，映射不到就跳过整条规则，
/// 不生成客户端会报「未知策略」的条目。
fn ini_policy(flavor: IniFlavor, raw: &str, nodes: &[&SubNode]) -> Option<String> {
    let upper = raw.to_ascii_uppercase();
    let qx = flavor.is_qx();
    match upper.as_str() {
        "DIRECT" => Some(if qx { "direct" } else { "DIRECT" }.to_string()),
        "REJECT" | "REJECT-DROP" => Some(if qx { "reject" } else { "REJECT" }.to_string()),
        "PROXY" => Some("PROXY".to_string()),
        "AUTO" if !nodes.is_empty() => Some("AUTO".to_string()),
        other => {
            let region = REGIONS
                .iter()
                .copied()
                .find(|region| region.eq_ignore_ascii_case(other))?;
            if !nodes
                .iter()
                .any(|node| region_of(&node.name) == Some(region))
            {
                return None;
            }
            Some(region.to_string())
        }
    }
}

/// 返回 `(规则行, 是否 FINAL)`；`None` 表示该格式映射不了。
fn ini_rule_line(flavor: IniFlavor, rule: &str, nodes: &[&SubNode]) -> Option<(String, bool)> {
    let (kind, value, policy_raw, no_resolve) = parse_rule(rule)?;
    let policy = ini_policy(flavor, &policy_raw, nodes)?;
    let qx = flavor.is_qx();
    if kind == "MATCH" {
        let line = if qx {
            format!("final, {policy}")
        } else {
            format!("FINAL,{policy}")
        };
        return Some((line, true));
    }
    let kind = if qx {
        qx_rule_kind(&kind)?
    } else {
        surge_rule_kind(&kind)?
    };
    let value = value?;
    if no_resolve && !matches!(kind, "IP-CIDR" | "IP-CIDR6" | "ip-cidr" | "ip6-cidr") {
        return None;
    }
    // GEOIP 的值在 Quantumult X 里习惯小写（geoip, cn, ...）。
    let value = if qx && kind == "geoip" {
        value.to_ascii_lowercase()
    } else {
        value
    };
    let suffix = if no_resolve {
        if qx {
            ", no-resolve"
        } else {
            ",no-resolve"
        }
    } else {
        ""
    };
    let line = if qx {
        format!("{kind}, {value}, {policy}{suffix}")
    } else {
        format!("{kind},{value},{policy}{suffix}")
    };
    Some((line, false))
}

/// 规则段；没有可用的 FINAL 时补一条 `FINAL,DIRECT`，保证配置永远合法。
fn push_ini_rules(
    out: &mut String,
    flavor: IniFlavor,
    rules: &[String],
    nodes: &[&SubNode],
) -> usize {
    let mut skipped = 0;
    let mut final_written = false;
    for rule in rules {
        let mapped = ini_rule_line(flavor, rule, nodes);
        let Some((line, is_final)) = mapped else {
            tracing::warn!(client = flavor.id(), rule = %rule, "规则模板映射不了，跳过该条规则");
            skipped += 1;
            continue;
        };
        if is_final && final_written {
            // 模板里出现多条 MATCH 时只保留第一条，客户端不接受重复兜底。
            skipped += 1;
            continue;
        }
        out.push_str(&line);
        out.push('\n');
        final_written = final_written || is_final;
    }
    if !final_written {
        out.push_str(if flavor.is_qx() {
            "final, direct\n"
        } else {
            "FINAL,DIRECT\n"
        });
    }
    skipped
}

fn render_ini(flavor: IniFlavor, ctx: &SubContext<'_>) -> IniOutput {
    let mut proxies: Vec<(&SubNode, String)> = Vec::new();
    for node in ctx.nodes {
        let line = if flavor.is_qx() {
            qx_node_line(node)
        } else {
            family_node_line(flavor, node)
        };
        match line {
            Some(line) => proxies.push((node, line)),
            None => tracing::warn!(
                client = flavor.id(),
                node = %node.name,
                protocol = %node.protocol,
                transport = %node.transport,
                security = %node.security,
                "该节点在此格式里无法表达，跳过"
            ),
        }
    }
    let skipped_nodes = ctx.nodes.len() - proxies.len();
    let rendered: Vec<&SubNode> = proxies.iter().map(|(node, _)| *node).collect();

    let mut body = String::new();
    if flavor.is_qx() {
        body.push_str("[server_local]\n");
    } else {
        body.push_str("[Proxy]\n");
    }
    for (_, line) in &proxies {
        body.push_str(line);
        body.push('\n');
    }
    body.push('\n');
    body.push_str(if flavor.is_qx() {
        "[policy]\n"
    } else {
        "[Proxy Group]\n"
    });
    push_ini_groups(&mut body, flavor, &rendered);
    body.push('\n');
    body.push_str(if flavor.is_qx() {
        "[filter_local]\n"
    } else {
        "[Rule]\n"
    });

    let rules = rules_or_default(ctx);
    let skipped_rules = push_ini_rules(&mut body, flavor, &rules, &rendered);
    IniOutput {
        body,
        skipped_nodes,
        skipped_rules,
    }
}

/// Surge 与 Egern 共用的正文生成函数。
///
/// Egern 官方支持导入 Surge 配置（我们拿不到它的完整规范文档），所以这里只生成
/// 一份 Surge INI 正文；两个 exporter 的差异只有 `client`（日志归因）与 `header`
/// （文件头标识）。以后修 Surge 的节点/规则表达时 Egern 自动跟上，不会出现两份
/// 逐渐漂移的渲染逻辑。
///
/// **这不是 Egern 专有格式**：若 Egern 后续要求专有字段，需要单独适配。
fn render_surge_compatible(
    client: &'static str,
    header: &str,
    ctx: &SubContext<'_>,
) -> anyhow::Result<String> {
    let output = render_ini(IniFlavor::Surge, ctx);
    log_skipped(client, output.skipped_nodes, output.skipped_rules);
    Ok(format!("{header}{}", output.body))
}

pub struct SurgeExporter;

impl Exporter for SurgeExporter {
    fn id(&self) -> &'static str {
        "surge"
    }

    fn content_type(&self) -> &'static str {
        "text/plain; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        // Surge 正文不加文件头，保持升级前的逐字节输出。
        render_surge_compatible(self.id(), "", ctx)
    }
}

/// `[General]` 段：日志级别、DNS、局域网绕行与测速地址。
///
/// 与节点无关，所以无节点时这份 profile 仍可导入；不含任何 `443` 之类的端口字面量。
const SURGE_GENERAL_SECTION: &str = concat!(
    "[General]\n",
    "loglevel = notify\n",
    "dns-server = 223.5.5.5, 1.1.1.1\n",
    "skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local\n",
    "bypass-system = true\n",
    "ipv6 = false\n",
    "test-timeout = 5\n",
    "internet-test-url = http://www.gstatic.com/generate_204\n",
    "proxy-test-url = http://www.gstatic.com/generate_204\n",
    "\n",
);

/// Surge 的**完整**配置（不是片段）：`[General]` / `[Proxy]` / `[Proxy Group]` /
/// `[Rule]` 四段齐全，可直接导入。
///
/// 节点行、分组与规则全部复用 [`render_ini`]（`IniFlavor::Surge`）——也就是
/// `?target=surge` 的同一份生成逻辑，不复制第二份协议映射；本渲染器只补 `[General]`
/// 段。`?target=surge` 的片段输出保持逐字节不变。空节点时仍输出四段齐全的最小
/// profile（`[Proxy]` 为空、`PROXY = select, DIRECT`、`FINAL,PROXY`）。
pub struct SurgeFullExporter;

impl Exporter for SurgeFullExporter {
    fn id(&self) -> &'static str {
        "surge-full"
    }

    fn content_type(&self) -> &'static str {
        "text/plain; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        let output = render_ini(IniFlavor::Surge, ctx);
        log_skipped(self.id(), output.skipped_nodes, output.skipped_rules);
        Ok(format!("{SURGE_GENERAL_SECTION}{}", output.body))
    }
}

/// Egern（iOS）订阅。
///
/// **假设（assumption）**：Egern 官方支持导入 Surge 配置，我们在无法访问其完整
/// 规范文档的情况下复用 [`SurgeExporter`] 的生成逻辑，输出 Surge 兼容 profile，
/// 只在文件头加 Egern 标识；`Content-Type` 也与 Surge 一致。
///
/// 若 Egern 后续要求专有字段，需要单独适配；**不要据此宣称「完整支持 Egern」**。
pub struct EgernExporter;

/// Egern 文件头：第一行是 Surge 家族约定的 `MANAGED-CONFIG` 指令（Surge 导出器
/// 当前不带文件头，保持升级前的逐字节输出）；后面两行中英双语写明「Surge 兼容」
/// 这个假设，避免被误读成专有格式。
const EGERN_HEADER: &str = concat!(
    "#!MANAGED-CONFIG\n",
    "# Egern（Surge 兼容）：按 Surge 格式输出；若 Egern 后续要求专有字段，需要单独适配。\n",
    "# Egern (Surge-compatible): exported as a Surge profile; if Egern later requires proprietary fields, a dedicated adapter is needed.\n",
);

impl Exporter for EgernExporter {
    fn id(&self) -> &'static str {
        "egern"
    }

    fn content_type(&self) -> &'static str {
        "text/plain; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        render_surge_compatible(self.id(), EGERN_HEADER, ctx)
    }
}

pub struct SurfboardExporter;

impl Exporter for SurfboardExporter {
    fn id(&self) -> &'static str {
        "surfboard"
    }

    fn content_type(&self) -> &'static str {
        "text/plain; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        let output = render_ini(IniFlavor::Surfboard, ctx);
        log_skipped(self.id(), output.skipped_nodes, output.skipped_rules);
        Ok(output.body)
    }
}

pub struct LoonExporter;

impl Exporter for LoonExporter {
    fn id(&self) -> &'static str {
        "loon"
    }

    fn content_type(&self) -> &'static str {
        "text/plain; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        let output = render_ini(IniFlavor::Loon, ctx);
        log_skipped(self.id(), output.skipped_nodes, output.skipped_rules);
        Ok(output.body)
    }
}

pub struct QxExporter;

impl Exporter for QxExporter {
    fn id(&self) -> &'static str {
        "qx"
    }

    fn content_type(&self) -> &'static str {
        "text/plain; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        let output = render_ini(IniFlavor::Qx, ctx);
        log_skipped(self.id(), output.skipped_nodes, output.skipped_rules);
        Ok(output.body)
    }
}

// ---------------------------------------------------------------------------
// sing-box
// ---------------------------------------------------------------------------

struct SingboxOutput {
    body: String,
    skipped_nodes: usize,
}

/// 单个节点 → sing-box outbound；返回 `None` 表示这个组合 sing-box 也表达不了。
fn singbox_outbound(node: &SubNode) -> Option<Value> {
    if !matches!(node.protocol.as_str(), "vless" | "vmess" | "trojan" | "ss") {
        return None;
    }
    if !matches!(node.security.as_str(), "none" | "tls" | "reality" | "xtls") {
        return None;
    }
    if node.security == "reality" && node.protocol != "vless" {
        return None;
    }
    // Shadowsocks 在 sing-box 里没有传输层字段。
    if node.protocol == "ss" && node.transport != "tcp" {
        return None;
    }

    let mut outbound = json!({
        "type": node.protocol,
        "tag": node.name,
        "server": node.server,
        "server_port": node.effective_port(),
    });
    match node.protocol.as_str() {
        "vless" => {
            outbound["uuid"] = json!(node.param("uuid").unwrap_or_default());
            if let Some(flow) = node.param("flow") {
                outbound["flow"] = json!(flow);
            }
        }
        "vmess" => {
            outbound["uuid"] = json!(node.param("uuid").unwrap_or_default());
            outbound["security"] = json!("auto");
            outbound["alter_id"] = json!(node
                .param("alter_id")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0));
        }
        "trojan" => {
            outbound["password"] = json!(node.param("password").unwrap_or_default());
        }
        "ss" => {
            outbound["method"] = json!(node.param("method").unwrap_or(xray::SS_DEFAULT_METHOD));
            // sing-box 里 SS2022 的密码同样是 `server:user`。
            outbound["password"] = json!(node.ss_client_password());
        }
        _ => return None,
    }

    if is_tls(&node.security) {
        let mut tls = json!({ "enabled": true });
        if let Some(sni) = node.param("sni") {
            tls["server_name"] = json!(sni);
        }
        if node.param("allow_insecure") == Some("true") {
            tls["insecure"] = json!(true);
        }
        if let Some(alpn) = node.param("alpn") {
            let items: Vec<&str> = alpn
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .collect();
            if !items.is_empty() {
                tls["alpn"] = json!(items);
            }
        }
        if node.security == "reality" {
            // SubNode::from_node 保证 reality 节点一定有 public_key；手工构造的
            // 脏数据在这里兜底成跳过，而不是产出缺字段的配置。
            let public_key = node.param("public_key")?;
            tls["utls"] = json!({
                "enabled": true,
                "fingerprint": node.param("fingerprint").unwrap_or("chrome"),
            });
            let mut reality = json!({ "enabled": true, "public_key": public_key });
            if let Some(short_id) = node.param("short_id") {
                reality["short_id"] = json!(short_id);
            }
            tls["reality"] = reality;
        }
        outbound["tls"] = tls;
    }

    match node.transport.as_str() {
        "tcp" | "" => {}
        "ws" => {
            let mut transport = json!({
                "type": "ws",
                "path": node.param("path").unwrap_or("/"),
            });
            if let Some(host) = node.param("host") {
                transport["headers"] = json!({ "Host": host });
            }
            outbound["transport"] = transport;
        }
        "grpc" => {
            let mut transport = json!({ "type": "grpc" });
            if let Some(service_name) = node.param("service_name") {
                transport["service_name"] = json!(service_name);
            }
            outbound["transport"] = transport;
        }
        "h2" | "http" => {
            let mut transport = json!({
                "type": "http",
                "path": node.param("path").unwrap_or("/"),
            });
            if let Some(host) = node.param("host") {
                transport["host"] = json!([host]);
            }
            outbound["transport"] = transport;
        }
        "httpupgrade" => {
            let mut transport = json!({
                "type": "httpupgrade",
                "path": node.param("path").unwrap_or("/"),
            });
            if let Some(host) = node.param("host") {
                transport["host"] = json!(host);
            }
            outbound["transport"] = transport;
        }
        _ => return None,
    }

    Some(outbound)
}

/// 规则 → sing-box route rule；`MATCH` 映射成 `route.final`（不是一条 rule）。
fn singbox_rule(rule: &str, has_nodes: bool) -> Option<(Value, Option<String>)> {
    let (kind, value, policy_raw, _no_resolve) = parse_rule(rule)?;
    let outbound = match policy_raw.to_ascii_uppercase().as_str() {
        "DIRECT" => "direct".to_string(),
        "REJECT" | "REJECT-DROP" => "blocker".to_string(),
        "PROXY" => "selector".to_string(),
        "AUTO" if has_nodes => "AUTO".to_string(),
        _ => return None,
    };
    if kind == "MATCH" {
        return Some((Value::Null, Some(outbound)));
    }
    let value = value?;
    let condition = match kind.as_str() {
        "DOMAIN" => json!({ "domain": [value] }),
        "DOMAIN-SUFFIX" => json!({ "domain_suffix": [value] }),
        "DOMAIN-KEYWORD" => json!({ "domain_keyword": [value] }),
        "IP-CIDR" | "IP-CIDR6" => json!({ "ip_cidr": [value] }),
        "GEOIP" => json!({ "geoip": [value.to_ascii_lowercase()] }),
        _ => return None,
    };
    let mut condition = condition;
    condition["outbound"] = json!(outbound);
    Some((condition, None))
}

/// 节点出站 + 固定分组（`AUTO` / `selector` / `direct`）。
///
/// `singbox`（片段）与 `singbox-full`（完整配置）共用这一份节点与分组表达；
/// 片段另加 legacy `block` 出站（保持原有逐字节输出），完整配置改用
/// `action: reject` 规则动作——sing-box 1.13 起移除了 legacy 特殊出站。
struct SingboxCore {
    outbounds: Vec<Value>,
    has_nodes: bool,
    skipped_nodes: usize,
}

fn singbox_core(ctx: &SubContext<'_>) -> SingboxCore {
    let mut outbounds: Vec<Value> = Vec::new();
    let mut node_tags: Vec<&str> = Vec::new();
    let mut skipped_nodes = 0;
    for node in ctx.nodes {
        match singbox_outbound(node) {
            Some(outbound) => {
                node_tags.push(&node.name);
                outbounds.push(outbound);
            }
            None => {
                tracing::warn!(
                    node = %node.name,
                    protocol = %node.protocol,
                    transport = %node.transport,
                    security = %node.security,
                    "该节点在 sing-box 里无法表达，跳过"
                );
                skipped_nodes += 1;
            }
        }
    }

    if !node_tags.is_empty() {
        outbounds.push(json!({
            "type": "urltest",
            "tag": "AUTO",
            "outbounds": node_tags,
            "url": "http://www.gstatic.com/generate_204",
            "interval": "5m",
            "tolerance": 50,
        }));
        outbounds.push(json!({
            "type": "selector",
            "tag": "selector",
            "outbounds": ["AUTO", "direct"],
            "default": "AUTO",
        }));
    } else {
        outbounds.push(json!({
            "type": "selector",
            "tag": "selector",
            "outbounds": ["direct"],
            "default": "direct",
        }));
    }
    outbounds.push(json!({ "type": "direct", "tag": "direct" }));

    SingboxCore {
        has_nodes: !node_tags.is_empty(),
        outbounds,
        skipped_nodes,
    }
}

/// 规则模板 → (`route.rules`, `route.final`)；`MATCH` 映射成 `route.final`。
///
/// 片段与完整配置共用：两边映射出来的规则必须完全一致，否则同一个模板在两种
/// 订阅里会走不同的出口。
fn singbox_route(ctx: &SubContext<'_>, has_nodes: bool) -> (Vec<Value>, String) {
    let mut route_rules: Vec<Value> = Vec::new();
    let mut final_outbound = "selector".to_string();
    for rule in rules_or_default(ctx) {
        let Some((condition, final_policy)) = singbox_rule(&rule, has_nodes) else {
            tracing::warn!(rule = %rule, "规则模板映射不了 sing-box 规则，跳过该条规则");
            continue;
        };
        if let Some(policy) = final_policy {
            final_outbound = policy;
        } else {
            route_rules.push(condition);
        }
    }
    (route_rules, final_outbound)
}

fn render_singbox(ctx: &SubContext<'_>) -> SingboxOutput {
    let core = singbox_core(ctx);
    let (route_rules, final_outbound) = singbox_route(ctx, core.has_nodes);

    // 片段保持升级前的输出：legacy `block` 出站仍在。
    let mut outbounds = core.outbounds;
    outbounds.push(json!({ "type": "block", "tag": "blocker" }));

    let document = json!({
        "log": { "level": "info" },
        "outbounds": outbounds,
        "route": {
            "rules": route_rules,
            "final": final_outbound,
        },
    });
    let body = serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{}".to_string());
    SingboxOutput {
        body,
        skipped_nodes: core.skipped_nodes,
    }
}

/// 完整配置的规则：复用 [`singbox_route`]，只把 `REJECT` 从 legacy `blocker`
/// 出站换成 1.11+ 的 `action: reject` 规则动作。
///
/// `MATCH,REJECT` 无法作为 `route.final`（它不是出站），改成末尾一条无条件的
/// `reject` 规则，语义等价。
fn singbox_full_route(ctx: &SubContext<'_>, has_nodes: bool) -> (Vec<Value>, String) {
    let (route_rules, mut final_outbound) = singbox_route(ctx, has_nodes);
    let mut rules: Vec<Value> = route_rules
        .into_iter()
        .map(|mut rule| {
            if rule.get("outbound").and_then(Value::as_str) == Some("blocker") {
                if let Some(object) = rule.as_object_mut() {
                    object.remove("outbound");
                    object.insert("action".into(), json!("reject"));
                }
            }
            rule
        })
        .collect();
    if final_outbound == "blocker" {
        final_outbound = "selector".to_string();
        rules.push(json!({ "action": "reject" }));
    }
    (rules, final_outbound)
}

/// sing-box 的**完整**配置：`log` / `dns` / `inbounds`（mixed）/ `outbounds` /
/// `route` 一次给全，可直接 `sing-box run -c`。
///
/// 节点与分组表达复用 [`singbox_core`]（同一个 [`singbox_outbound`]），所以节点字段
/// 与 `?target=singbox` 逐字段一致，不存在第二份协议映射。与片段的两处差异是为了
/// 跟上 sing-box 1.12+：DNS 用新的 server 格式，`REJECT` 用规则动作而不是 legacy
/// `block` 出站。空节点时仍是合法可运行的配置：`selector` 只含 `direct`，DNS 仍
/// 指向真实存在的出站。
fn render_singbox_full(ctx: &SubContext<'_>) -> SingboxOutput {
    let core = singbox_core(ctx);
    let (route_rules, final_outbound) = singbox_full_route(ctx, core.has_nodes);

    // DNS 取向与 mihomo 一致：国内 DoH 走 direct、其余走 selector；两个 DoH 地址
    // 都是 IP 字面量，不会触发自举解析。`type: https` 是 sing-box 1.12+ 的新格式。
    let document = json!({
        "log": { "level": "info", "timestamp": true },
        "dns": {
            "servers": [
                {
                    "type": "https",
                    "tag": "dns-local",
                    "server": "223.5.5.5",
                    "detour": "direct",
                },
                {
                    "type": "https",
                    "tag": "dns-remote",
                    "server": "1.1.1.1",
                    "detour": "selector",
                },
            ],
            "final": "dns-remote",
        },
        "inbounds": [
            {
                "type": "mixed",
                "tag": "mixed-in",
                "listen": "127.0.0.1",
                "listen_port": 7890,
            },
        ],
        "outbounds": core.outbounds,
        "route": {
            "rules": route_rules,
            "final": final_outbound,
            "auto_detect_interface": true,
        },
    });
    let body = serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{}".to_string());
    SingboxOutput {
        body,
        skipped_nodes: core.skipped_nodes,
    }
}

pub struct SingboxExporter;

impl Exporter for SingboxExporter {
    fn id(&self) -> &'static str {
        "singbox"
    }

    fn content_type(&self) -> &'static str {
        "application/json; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        let output = render_singbox(ctx);
        log_skipped(self.id(), output.skipped_nodes, 0);
        Ok(output.body)
    }
}

/// sing-box 的**完整**配置（`log` / `dns` / `inbounds` / `outbounds` / `route`），
/// 可直接 `sing-box run -c`。
///
/// 与 `singbox` 的片段格式共用 [`singbox_core`] 与 [`singbox_route`]，差别只有 DNS、
/// mixed 入站与 `auto_detect_interface`；既有片段输出逐字节不变。
pub struct SingboxFullExporter;

impl Exporter for SingboxFullExporter {
    fn id(&self) -> &'static str {
        "singbox-full"
    }

    fn content_type(&self) -> &'static str {
        "application/json; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        let output = render_singbox_full(ctx);
        log_skipped(self.id(), output.skipped_nodes, 0);
        Ok(output.body)
    }
}

// ---------------------------------------------------------------------------
// Shadowrocket / V2Ray（base64 的 URI 列表）
// ---------------------------------------------------------------------------

/// 标准 base64（带填充）编码 `UriExporter` 的输出。
///
/// Shadowrocket 与 V2RayN 的订阅都接受这种形态；解码后与 `?target=uri`
/// 逐字节一致，只是多了一层传输编码。
fn render_uri_base64(ctx: &SubContext<'_>) -> anyhow::Result<String> {
    let body = UriExporter.render(ctx)?;
    Ok(STANDARD.encode(body.as_bytes()))
}

pub struct ShadowrocketExporter;

impl Exporter for ShadowrocketExporter {
    fn id(&self) -> &'static str {
        "shadowrocket"
    }

    fn content_type(&self) -> &'static str {
        "text/plain; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        render_uri_base64(ctx)
    }
}

pub struct V2RayExporter;

impl Exporter for V2RayExporter {
    fn id(&self) -> &'static str {
        "v2ray"
    }

    fn content_type(&self) -> &'static str {
        "text/plain; charset=utf-8"
    }

    fn render(&self, ctx: &SubContext<'_>) -> anyhow::Result<String> {
        render_uri_base64(ctx)
    }
}

// ---------------------------------------------------------------------------
// 片段解析小工具
// ---------------------------------------------------------------------------

fn get_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn get_first_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn get_host(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(host) = value
        .as_str()
        .map(str::trim)
        .filter(|host| !host.is_empty())
    {
        return Some(host.to_string());
    }
    value
        .as_array()
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .map(str::to_string)
}

fn header_host(headers: Option<&Value>) -> Option<String> {
    let headers = headers?.as_object()?;
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("host"))
        .and_then(|(_, value)| value.as_str())
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .map(str::to_string)
}

fn join_string_array(value: Option<&Value>) -> Option<String> {
    let items: Vec<&str> = value?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .collect();
    if items.is_empty() {
        None
    } else {
        Some(items.join(","))
    }
}

fn first_client(fragment: &Value) -> Option<&Value> {
    fragment
        .get("settings")?
        .get("clients")?
        .as_array()?
        .first()
}

fn set(params: &mut BTreeMap<String, String>, key: &str, value: Option<String>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        params.insert(key.to_string(), value);
    }
}

fn set_bool(params: &mut BTreeMap<String, String>, key: &str, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_bool) {
        params.insert(key.to_string(), value.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::models::Node;

    fn node(
        name: &str,
        protocol: &str,
        transport: &str,
        security: &str,
        port: u16,
        params: &[(&str, &str)],
    ) -> SubNode {
        SubNode {
            name: name.into(),
            protocol: protocol.into(),
            server: "203.0.113.10".into(),
            port,
            public_port: None,
            transport: transport.into(),
            security: security.into(),
            params: params
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect(),
        }
    }

    fn fixtures() -> Vec<SubNode> {
        vec![
            node(
                "香港-REALITY",
                "vless",
                "tcp",
                "reality",
                443,
                &[
                    ("uuid", "11111111-1111-4111-8111-111111111111"),
                    ("flow", "xtls-rprx-vision"),
                    ("sni", "www.example.com"),
                    ("public_key", "public-key-abc"),
                    ("short_id", "abcd1234"),
                ],
            ),
            node(
                "日本-WS-TLS",
                "trojan",
                "ws",
                "tls",
                8443,
                &[
                    ("password", "22222222-2222-4222-8222-222222222222"),
                    ("sni", "jp.example.com"),
                    ("path", "/ws"),
                    ("host", "cdn.example.com"),
                ],
            ),
        ]
    }

    #[test]
    fn clash_yaml_parses_with_two_proxies_and_full_groups() {
        let nodes = fixtures();
        let rules = default_rules();
        let ctx = SubContext {
            nodes: &nodes,
            user_label: "alice",
            traffic: None,
            rules: &rules,
        };
        let yaml = ClashExporter.render(&ctx).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).expect("必须是合法 YAML");

        let proxies = parsed
            .get("proxies")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("proxies 必须是列表");
        assert_eq!(proxies.len(), 2);

        let vless = &proxies[0];
        assert_eq!(vless.get("type").unwrap().as_str(), Some("vless"));
        assert_eq!(vless.get("tls").unwrap().as_bool(), Some(true));
        assert_eq!(
            vless
                .get("reality-opts")
                .and_then(|opts| opts.get("public-key"))
                .and_then(serde_yaml::Value::as_str),
            Some("public-key-abc")
        );
        assert_eq!(
            vless
                .get("client-fingerprint")
                .and_then(serde_yaml::Value::as_str),
            Some("chrome")
        );

        let trojan = &proxies[1];
        assert_eq!(trojan.get("type").unwrap().as_str(), Some("trojan"));
        assert_eq!(
            trojan.get("sni").and_then(serde_yaml::Value::as_str),
            Some("jp.example.com")
        );
        assert_eq!(
            trojan
                .get("ws-opts")
                .and_then(|opts| opts.get("path"))
                .and_then(serde_yaml::Value::as_str),
            Some("/ws")
        );
        assert_eq!(
            trojan
                .get("ws-opts")
                .and_then(|opts| opts.get("headers"))
                .and_then(|headers| headers.get("Host"))
                .and_then(serde_yaml::Value::as_str),
            Some("cdn.example.com")
        );

        let groups = parsed
            .get("proxy-groups")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("proxy-groups 必须是列表");
        let group_names: Vec<&str> = groups
            .iter()
            .filter_map(|group| group.get("name"))
            .filter_map(serde_yaml::Value::as_str)
            .collect();
        for expected in ["PROXY", "AUTO", "香港", "日本"] {
            assert!(group_names.contains(&expected), "缺少分组 {expected}");
        }
        let auto = groups
            .iter()
            .find(|group| group.get("name").and_then(serde_yaml::Value::as_str) == Some("AUTO"))
            .unwrap();
        assert_eq!(
            auto.get("type").and_then(serde_yaml::Value::as_str),
            Some("url-test")
        );
        assert_eq!(
            auto.get("interval").and_then(serde_yaml::Value::as_i64),
            Some(300)
        );
        assert_eq!(
            auto.get("tolerance").and_then(serde_yaml::Value::as_i64),
            Some(50)
        );

        let rules = parsed
            .get("rules")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("rules 必须是列表");
        let rules: Vec<&str> = rules.iter().filter_map(serde_yaml::Value::as_str).collect();
        assert_eq!(rules, vec!["GEOIP,CN,DIRECT", "MATCH,PROXY"]);
    }

    #[test]
    fn clash_yaml_without_nodes_stays_valid() {
        let nodes: Vec<SubNode> = Vec::new();
        let rules = default_rules();
        let ctx = SubContext {
            nodes: &nodes,
            user_label: "alice",
            traffic: None,
            rules: &rules,
        };
        let yaml = ClashExporter.render(&ctx).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();

        assert!(parsed
            .get("proxies")
            .and_then(serde_yaml::Value::as_sequence)
            .unwrap()
            .is_empty());
        assert!(parsed.get("rules").is_some());
    }

    #[test]
    fn clash_rules_come_from_context_and_fall_back_to_builtin() {
        let nodes = fixtures();
        let custom = vec![
            "DOMAIN-SUFFIX,example.com,DIRECT".to_string(),
            "MATCH,DIRECT".to_string(),
        ];
        let ctx = SubContext {
            nodes: &nodes,
            user_label: "alice",
            traffic: None,
            rules: &custom,
        };
        let yaml = ClashExporter.render(&ctx).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
        let rules: Vec<&str> = parsed
            .get("rules")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("rules 必须是列表")
            .iter()
            .filter_map(serde_yaml::Value::as_str)
            .collect();
        assert_eq!(
            rules,
            vec!["DOMAIN-SUFFIX,example.com,DIRECT", "MATCH,DIRECT"]
        );

        // 上下文没给规则时回落到内置两条，YAML 不会出现空的 rules 段。
        let empty: Vec<String> = Vec::new();
        let ctx = SubContext {
            nodes: &nodes,
            user_label: "alice",
            traffic: None,
            rules: &empty,
        };
        let yaml = ClashExporter.render(&ctx).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
        let rules: Vec<&str> = parsed
            .get("rules")
            .and_then(serde_yaml::Value::as_sequence)
            .unwrap()
            .iter()
            .filter_map(serde_yaml::Value::as_str)
            .collect();
        assert_eq!(rules, vec!["GEOIP,CN,DIRECT", "MATCH,PROXY"]);
    }

    #[test]
    fn mihomo_yaml_has_complete_structure_and_two_group_types() {
        let nodes = fixtures();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = MihomoExporter.render(&ctx).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&body).expect("必须是合法 YAML");

        // 顶层小节顺序（人眼与客户端都按这个顺序读）。
        let positions: Vec<usize> = ["mixed-port:", "dns:", "proxies:", "proxy-groups:", "rules:"]
            .iter()
            .map(|key| {
                body.find(key)
                    .unwrap_or_else(|| panic!("缺少顶层小节 {key}：{body}"))
            })
            .collect();
        assert!(
            positions.windows(2).all(|pair| pair[0] < pair[1]),
            "顶层小节顺序不对：{positions:?}"
        );

        assert_eq!(parsed["mixed-port"].as_i64(), Some(7890));
        assert_eq!(parsed["allow-lan"].as_bool(), Some(false));
        assert_eq!(parsed["mode"].as_str(), Some("rule"));
        assert_eq!(parsed["log-level"].as_str(), Some("info"));
        assert_eq!(parsed["ipv6"].as_bool(), Some(true));

        let dns = &parsed["dns"];
        assert_eq!(dns["enable"].as_bool(), Some(true));
        assert_eq!(dns["enhanced-mode"].as_str(), Some("fake-ip"));
        assert_eq!(dns["fake-ip-range"].as_str(), Some("198.18.0.1/16"));
        let nameservers: Vec<&str> = dns["nameserver"]
            .as_sequence()
            .expect("nameserver 必须是列表")
            .iter()
            .filter_map(serde_yaml::Value::as_str)
            .collect();
        assert_eq!(
            nameservers,
            vec!["https://223.5.5.5/dns-query", "https://1.1.1.1/dns-query"]
        );

        assert_eq!(parsed["proxies"].as_sequence().unwrap().len(), 2);

        let groups = parsed["proxy-groups"]
            .as_sequence()
            .expect("proxy-groups 必须是列表");
        assert_eq!(groups.len(), 2, "只应有两个固定分组：{groups:?}");

        let select = &groups[0];
        assert_eq!(select["name"].as_str(), Some("节点选择"));
        assert_eq!(select["type"].as_str(), Some("select"));
        assert_eq!(
            yaml_strings(&select["proxies"]),
            vec!["自动选择", "香港-REALITY", "日本-WS-TLS"]
        );

        let auto = &groups[1];
        assert_eq!(auto["name"].as_str(), Some("自动选择"));
        assert_eq!(auto["type"].as_str(), Some("url-test"));
        assert_eq!(
            auto["url"].as_str(),
            Some("http://www.gstatic.com/generate_204")
        );
        assert_eq!(auto["interval"].as_i64(), Some(300));
        assert_eq!(
            yaml_strings(&auto["proxies"]),
            vec!["香港-REALITY", "日本-WS-TLS"]
        );

        assert_eq!(
            yaml_strings(&parsed["rules"]),
            vec!["GEOIP,CN,DIRECT", "MATCH,节点选择"]
        );

        assert_eq!(MihomoExporter.id(), "mihomo");
        assert_eq!(MihomoExporter.content_type(), "text/yaml; charset=utf-8");
    }

    #[test]
    fn mihomo_single_node_keeps_both_groups_and_switches_to_the_select_group() {
        let nodes = vec![fixtures().remove(0)];
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = MihomoExporter.render(&ctx).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&body).expect("必须是合法 YAML");

        assert_eq!(parsed["proxies"].as_sequence().unwrap().len(), 1);
        let groups = parsed["proxy-groups"].as_sequence().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(
            yaml_strings(&groups[0]["proxies"]),
            vec!["自动选择", "香港-REALITY"]
        );
        assert_eq!(yaml_strings(&groups[1]["proxies"]), vec!["香港-REALITY"]);
        assert_eq!(
            yaml_strings(&parsed["rules"]),
            vec!["GEOIP,CN,DIRECT", "MATCH,节点选择"]
        );
    }

    #[test]
    fn mihomo_multiple_nodes_preserve_order_in_every_group() {
        let mut nodes = fixtures();
        nodes.push(node(
            "美国-VMess",
            "vmess",
            "ws",
            "tls",
            443,
            &[
                ("uuid", "33333333-3333-4333-8333-333333333333"),
                ("alter_id", "0"),
                ("sni", "us.example.com"),
                ("path", "/vm"),
                ("host", "us.example.com"),
            ],
        ));
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = MihomoExporter.render(&ctx).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&body).expect("必须是合法 YAML");

        let expected = vec!["香港-REALITY", "日本-WS-TLS", "美国-VMess"];
        assert_eq!(parsed["proxies"].as_sequence().unwrap().len(), 3);
        let groups = parsed["proxy-groups"].as_sequence().unwrap();
        assert_eq!(
            yaml_strings(&groups[0]["proxies"]),
            vec!["自动选择", "香港-REALITY", "日本-WS-TLS", "美国-VMess"]
        );
        assert_eq!(yaml_strings(&groups[1]["proxies"]), expected);
    }

    /// 无节点也必须是「能导入」的完整配置，而不是空文件或缺字段的骨架。
    #[test]
    fn mihomo_without_nodes_is_still_an_importable_config() {
        let nodes: Vec<SubNode> = Vec::new();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = MihomoExporter.render(&ctx).unwrap();
        let parsed: serde_yaml::Value =
            serde_yaml::from_str(&body).expect("空节点也必须是合法 YAML");

        assert_eq!(parsed["proxies"].as_sequence().unwrap().len(), 0);

        let groups = parsed["proxy-groups"].as_sequence().unwrap();
        assert_eq!(groups.len(), 2, "空节点时两个组仍必须存在");
        for group in groups {
            let proxies = group["proxies"]
                .as_sequence()
                .unwrap_or_else(|| panic!("组的 proxies 必须是列表（不能是 null）：{group:?}"));
            assert!(proxies.is_empty(), "空节点时组应为空：{group:?}");
        }
        // 组仍然存在，所以 MATCH 指向它依然合法；顺序与有节点时一致。
        assert_eq!(
            yaml_strings(&parsed["rules"]),
            vec!["GEOIP,CN,DIRECT", "MATCH,节点选择"]
        );
    }

    /// 防止 mihomo 与 clash 各写一份节点表达后逐渐漂移：proxies 必须逐字段一致。
    #[test]
    fn mihomo_proxies_match_clash_field_by_field() {
        let mut nodes = fixtures();
        nodes.push(node(
            "美国-VMess",
            "vmess",
            "ws",
            "tls",
            443,
            &[
                ("uuid", "33333333-3333-4333-8333-333333333333"),
                ("alter_id", "0"),
                ("sni", "us.example.com"),
                ("path", "/vm"),
                ("host", "us.example.com"),
            ],
        ));
        nodes.push(node(
            "其他-ss",
            "ss",
            "tcp",
            "none",
            8388,
            &[("method", "aes-256-gcm"), ("password", "secret")],
        ));
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);

        let clash: serde_yaml::Value =
            serde_yaml::from_str(&ClashExporter.render(&ctx).unwrap()).unwrap();
        let mihomo: serde_yaml::Value =
            serde_yaml::from_str(&MihomoExporter.render(&ctx).unwrap()).unwrap();

        assert_eq!(
            mihomo["proxies"], clash["proxies"],
            "mihomo 的 proxies 段必须与 clash 逐字段一致"
        );
        // 节点名（含去重后的名字）也必须来自同一处，组里引用的就是 proxies 里的名字。
        assert_eq!(mihomo["proxies"][0]["name"].as_str(), Some("香港-REALITY"));
    }

    /// 节点名里的 `:`、`#`、空格、引号、反斜杠、逗号都不能破坏 YAML。
    #[test]
    fn mihomo_escapes_yaml_special_characters_in_node_names() {
        let names = [
            "香港: 01 # 主力",
            "美国 \"Quoted\" 节点",
            "日本 \\ 反斜杠",
            "逗号, 方括号] 冒号: 井号#",
            "带\"引号\"和,逗号的: #名字",
        ];
        let nodes: Vec<SubNode> = names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                node(
                    name,
                    "vless",
                    "tcp",
                    "tls",
                    443 + index as u16,
                    &[
                        ("uuid", "11111111-1111-4111-8111-111111111111"),
                        ("sni", "example.com"),
                    ],
                )
            })
            .collect();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = MihomoExporter.render(&ctx).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&body)
            .unwrap_or_else(|error| panic!("特殊字符节点名破坏了 YAML：{error}\n{body}"));

        let parsed_proxy_names: Vec<&str> = parsed["proxies"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter_map(|proxy| proxy["name"].as_str())
            .collect();
        assert_eq!(parsed_proxy_names, names);

        let groups = parsed["proxy-groups"].as_sequence().unwrap();
        let expected_auto: Vec<&str> = std::iter::once("自动选择")
            .chain(names.iter().copied())
            .collect();
        assert_eq!(yaml_strings(&groups[0]["proxies"]), expected_auto);
        assert_eq!(yaml_strings(&groups[1]["proxies"]), names);

        // 双引号名字在原始文本里必须转义，而不是裸写。
        assert!(body.contains("\\\"Quoted\\\""), "{body}");
    }

    fn yaml_strings(value: &serde_yaml::Value) -> Vec<&str> {
        value
            .as_sequence()
            .unwrap_or_else(|| panic!("期望 YAML 列表：{value:?}"))
            .iter()
            .filter_map(serde_yaml::Value::as_str)
            .collect()
    }

    #[test]
    fn uri_export_has_one_line_per_node_with_right_scheme() {
        let nodes = fixtures();
        let rules = default_rules();
        let ctx = SubContext {
            nodes: &nodes,
            user_label: "alice",
            traffic: None,
            rules: &rules,
        };
        let body = UriExporter.render(&ctx).unwrap();
        let lines: Vec<&str> = body.lines().filter(|line| !line.is_empty()).collect();

        assert_eq!(lines.len(), 2);
        assert!(
            lines[0].starts_with("vless://11111111-1111-4111-8111-111111111111@203.0.113.10:443?")
        );
        assert!(lines[0].contains("security=reality"));
        assert!(lines[0].contains("pbk=public-key-abc"));
        assert!(lines[0].contains("flow=xtls-rprx-vision"));
        // 名称做了 URL 编码，中文不会以裸字符出现在 URI 里。
        assert!(lines[0].ends_with("#%E9%A6%99%E6%B8%AF-REALITY"));

        assert!(lines[1]
            .starts_with("trojan://22222222-2222-4222-8222-222222222222@203.0.113.10:8443?"));
        assert!(lines[1].contains("type=ws"));
        assert!(lines[1].contains("path=%2Fws"));
        assert!(lines[1].contains("host=cdn.example.com"));
    }

    #[test]
    fn vmess_and_ss_uris_are_well_formed() {
        let vmess = node(
            "美国-01",
            "vmess",
            "ws",
            "tls",
            443,
            &[
                ("uuid", "33333333-3333-4333-8333-333333333333"),
                ("alter_id", "0"),
                ("path", "/vm"),
                ("sni", "us.example.com"),
            ],
        );
        let ss = node(
            "其他-ss",
            "ss",
            "tcp",
            "none",
            8388,
            &[("method", "aes-256-gcm"), ("password", "secret")],
        );
        let nodes = [vmess, ss];
        let rules = default_rules();
        let ctx = SubContext {
            nodes: &nodes,
            user_label: "alice",
            traffic: None,
            rules: &rules,
        };
        let body = UriExporter.render(&ctx).unwrap();
        let lines: Vec<&str> = body.lines().collect();

        let vmess_payload = lines[0].strip_prefix("vmess://").unwrap();
        let decoded = STANDARD.decode(vmess_payload).unwrap();
        let payload: Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(payload["v"], "2");
        assert_eq!(payload["add"], "203.0.113.10");
        assert_eq!(payload["port"], "443");
        assert_eq!(payload["net"], "ws");
        assert_eq!(payload["tls"], "tls");

        let ss_payload = lines[1].strip_prefix("ss://").unwrap();
        let (userinfo, rest) = ss_payload.split_once('@').unwrap();
        let decoded = URL_SAFE_NO_PAD.decode(userinfo).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "aes-256-gcm:secret");
        assert_eq!(rest, "203.0.113.10:8388#%E5%85%B6%E4%BB%96-ss");
    }

    // -----------------------------------------------------------------
    // Shadowsocks：订阅里每一处密码都必须是客户端可用的形态
    // -----------------------------------------------------------------

    const SS_SECRET: &str = "0123456789abcdef0123456789abcdef";

    fn ss_server_key(bytes: usize) -> String {
        STANDARD.encode(vec![7u8; bytes])
    }

    /// 从真实节点片段走一遍 `SubNode::from_node`，凭据派生和渲染都覆盖到。
    fn ss_sub_node(id: &str, method: &str, server_key: &str) -> SubNode {
        let raw = fragment_node(
            id,
            "香港-SS",
            "shadowsocks",
            "tcp",
            "none",
            8388,
            json!({
                "settings": {"method": method, "password": server_key, "network": "tcp,udp"},
                "stream": {"network": "tcp", "security": "none"}
            }),
        );
        SubNode::from_node(&raw, "203.0.113.10", "user-1", SS_SECRET)
            .expect("合法的 SS 节点应能进订阅")
    }

    fn expected_ss_password(method: &str, server_key: &str, node_id: &str) -> String {
        if let Some(key_len) = xray::ss2022_key_len(method) {
            let user_key = credentials::ss2022_user_key_len(SS_SECRET, "user-1", node_id, key_len);
            format!("{server_key}:{user_key}")
        } else {
            credentials::sub_uuid(SS_SECRET, "user-1", node_id)
        }
    }

    /// 每个导出器都要同时断言 SS2022 与旧 AEAD 两种密码形态。
    ///
    /// 这是本模块最容易漏的地方：clash/uri/INI/sing-box 各写一遍密码字段，
    /// 任何一处直接读 `params["password"]` 都会漏掉 `ServerPassword:` 前缀。
    #[test]
    fn every_exporter_emits_a_client_usable_ss_password() {
        let cases = [
            ("2022-blake3-aes-256-gcm", ss_server_key(32)),
            ("2022-blake3-aes-128-gcm", ss_server_key(16)),
            ("aes-256-gcm", "legacy-server-key".to_string()),
        ];

        for (method, server_key) in cases {
            let node_id = format!("ss-{}", method.replace(['.', ':'], "-"));
            let node = ss_sub_node(&node_id, method, &server_key);
            let expected = expected_ss_password(method, &server_key, &node_id);
            assert_eq!(
                node.ss_client_password(),
                expected,
                "{method}: SubNode 访问器必须给出客户端密码"
            );
            let nodes = [node];
            let rules = default_rules();
            let ctx = sub_context(&nodes, &rules);

            // Clash / mihomo / Stash（同一份 proxies 生成器）。
            for id in ["clash", "mihomo", "stash"] {
                let body = find_exporter(id).unwrap().render(&ctx).unwrap();
                let yaml: serde_yaml::Value = serde_yaml::from_str(&body).unwrap();
                let proxy = &yaml["proxies"][0];
                assert_eq!(proxy["type"].as_str(), Some("ss"), "{id}");
                assert_eq!(proxy["cipher"].as_str(), Some(method), "{id}");
                assert_eq!(
                    proxy["password"].as_str(),
                    Some(expected.as_str()),
                    "{id} 的 password 不是客户端可用的形态：{body}"
                );
            }

            // URI 列表：`ss://base64(method:password)@host:port`。
            let uri_body = find_exporter("uri").unwrap().render(&ctx).unwrap();
            let uri_line = uri_body.trim();
            let (userinfo, _rest) = uri_line
                .strip_prefix("ss://")
                .unwrap()
                .split_once('@')
                .unwrap();
            let decoded = URL_SAFE_NO_PAD.decode(userinfo).unwrap();
            assert_eq!(
                String::from_utf8(decoded).unwrap(),
                format!("{method}:{expected}"),
                "uri 的 userinfo 必须编码完整的客户端密码"
            );

            // Shadowrocket / v2ray 是整份 base64 的 URI 列表。
            for id in ["shadowrocket", "v2ray"] {
                let body = find_exporter(id).unwrap().render(&ctx).unwrap();
                let decoded = STANDARD.decode(body.trim()).unwrap();
                let text = String::from_utf8(decoded).unwrap();
                assert_eq!(text.trim(), uri_line, "{id} 必须复用同一条 ss:// URI");
            }

            // Surge / Egern / Surfboard / Loon / surge-full 的 INI 节点行。
            for id in ["surge", "egern", "surfboard", "loon", "surge-full"] {
                let body = find_exporter(id).unwrap().render(&ctx).unwrap();
                assert!(
                    body.contains(&format!("encrypt-method={method}")),
                    "{id} 缺少 encrypt-method：{body}"
                );
                assert!(
                    body.contains(&format!("password={expected}")),
                    "{id} 的 password 不是客户端可用的形态：{body}"
                );
            }

            // Quantumult X 的 `[server_local]` 行。
            let qx = find_exporter("qx").unwrap().render(&ctx).unwrap();
            assert!(qx.contains(&format!("method={method}")), "{qx}");
            assert!(
                qx.contains(&format!("password={expected}")),
                "qx 的 password 不是客户端可用的形态：{qx}"
            );

            // sing-box 的 outbound（片段与完整配置共用同一份节点表达）。
            for id in ["singbox", "singbox-full"] {
                let singbox = find_exporter(id).unwrap().render(&ctx).unwrap();
                let parsed: Value = serde_json::from_str(&singbox).unwrap();
                let outbound = parsed["outbounds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|outbound| outbound["type"] == "ss")
                    .unwrap_or_else(|| panic!("{id} 缺少 ss 出站：{singbox}"));
                assert_eq!(outbound["method"], method, "{id}");
                assert_eq!(
                    outbound["password"], expected,
                    "{id} 的 password 不是客户端可用的形态"
                );
            }
        }
    }

    #[test]
    fn ss_2022_password_is_never_the_bare_user_key() {
        let method = "2022-blake3-aes-256-gcm";
        let server_key = ss_server_key(32);
        let node = ss_sub_node("ss-2022-only", method, &server_key);
        let user_key = credentials::ss2022_user_key(SS_SECRET, "user-1", "ss-2022-only");

        assert_eq!(node.param("password"), Some(user_key.as_str()));
        assert_eq!(
            node.ss_client_password(),
            format!("{server_key}:{user_key}"),
            "2022 客户端密码必须是 server:user"
        );
    }

    /// AES-128 的每用户密钥必须是 16 字节，且订阅与下发配置逐字节一致。
    #[test]
    fn ss_2022_aes_128_user_key_is_16_bytes_and_matches_the_config() {
        let method = "2022-blake3-aes-128-gcm";
        let server_key = ss_server_key(16);
        let node = ss_sub_node("ss-2022-128", method, &server_key);
        let expected = credentials::ss2022_user_key_len(SS_SECRET, "user-1", "ss-2022-128", 16);

        assert_eq!(STANDARD.decode(&expected).unwrap().len(), 16);
        assert_eq!(node.param("password"), Some(expected.as_str()));
        assert_eq!(
            node.ss_client_password(),
            format!("{server_key}:{expected}"),
            "客户端密码必须是 server:user，且 user 是 16 字节"
        );
    }

    /// Xray 不支持 SS2022 chacha 的多用户形态，订阅不能发这种节点。
    #[test]
    fn ss_2022_chacha_is_skipped_in_subscriptions() {
        let raw = fragment_node(
            "ss-chacha",
            "香港-SS",
            "shadowsocks",
            "tcp",
            "none",
            8388,
            json!({
                "settings": {
                    "method": "2022-blake3-chacha20-poly1305",
                    "password": ss_server_key(32),
                    "network": "tcp"
                }
            }),
        );
        assert!(
            SubNode::from_node(&raw, "203.0.113.10", "user-1", SS_SECRET).is_none(),
            "chacha 的每用户密钥无法在 Xray 上成立，订阅必须跳过"
        );
    }

    /// 库里存着 URL-safe / 缺 padding 的 SS2022 服务端密钥时，订阅必须同样
    /// 输出标准 base64，否则客户端拿到的 `server:user` 和服务器不一致。
    #[test]
    fn ss_2022_server_key_is_canonicalized_in_the_subscription() {
        let url_safe = URL_SAFE_NO_PAD.encode([7u8; 32]);
        assert!(!url_safe.contains('='));
        let node = ss_sub_node("ss-canonical", "2022-blake3-aes-256-gcm", &url_safe);
        let canonical = ss_server_key(32);
        let user_key = credentials::ss2022_user_key_len(SS_SECRET, "user-1", "ss-canonical", 32);

        assert_eq!(node.param("server_password"), Some(canonical.as_str()));
        assert_eq!(
            node.ss_client_password(),
            format!("{canonical}:{user_key}"),
            "客户端密码里的服务端密钥必须是规范形态"
        );
    }

    #[test]
    fn legacy_ss_password_ignores_the_server_key() {
        let node = ss_sub_node("ss-legacy", "aes-256-gcm", "legacy-server-key");

        assert_eq!(
            node.ss_client_password(),
            credentials::sub_uuid(SS_SECRET, "user-1", "ss-legacy"),
            "旧 AEAD 的用户密码就是客户端密码"
        );
        assert_ne!(node.ss_client_password(), "legacy-server-key");
    }

    #[test]
    fn from_node_skips_shadowsocks_without_a_usable_key() {
        let cases = [
            // 历史 bug 的形态：2022 + 空密钥
            json!({"settings": {"method": "2022-blake3-aes-256-gcm", "password": ""}}),
            // 密钥长度与方法不匹配
            json!({"settings": {"method": "2022-blake3-aes-256-gcm", "password": "AAAA"}}),
            // 旧 AEAD 密码过短
            json!({"settings": {"method": "aes-256-gcm", "password": "short"}}),
            // 方法不在白名单
            json!({"settings": {"method": "aes-256-cfb", "password": "legacy-password"}}),
            // 完全缺 settings：默认 2022 + 空密钥
            json!({}),
        ];

        for (index, config) in cases.into_iter().enumerate() {
            let raw = fragment_node(
                &format!("ss-broken-{index}"),
                "香港-SS",
                "shadowsocks",
                "tcp",
                "none",
                8388,
                config.clone(),
            );
            assert!(
                SubNode::from_node(&raw, "203.0.113.10", "user-1", SS_SECRET).is_none(),
                "不合格的 SS 节点必须被跳过：{config}"
            );
        }
    }

    #[test]
    fn from_node_parses_reality_fragment_and_injects_derived_uuid() {
        let node = fragment_node(
            "node-1",
            "香港 01",
            "vless",
            "tcp",
            "reality",
            443,
            json!({
                "settings": {"clients": [{"id": "ignored", "flow": "xtls-rprx-vision"}], "decryption": "none"},
                "stream": {
                    "network": "tcp",
                    "security": "reality",
                    "realitySettings": {
                        "serverNames": ["www.example.com"],
                        "publicKey": "public-key-xyz",
                        "shortIds": ["deadbeef"]
                    }
                }
            }),
        );

        let sub = SubNode::from_node(&node, "1.2.3.4", "user-1", "secret").unwrap();
        let expected = credentials::sub_uuid("secret", "user-1", "node-1");

        assert_eq!(sub.name, "香港 01");
        assert_eq!(sub.protocol, "vless");
        assert_eq!(sub.transport, "tcp");
        assert_eq!(sub.security, "reality");
        assert_eq!(sub.param("uuid"), Some(expected.as_str()));
        assert_eq!(sub.param("flow"), Some("xtls-rprx-vision"));
        assert_eq!(sub.param("sni"), Some("www.example.com"));
        assert_eq!(sub.param("public_key"), Some("public-key-xyz"));
        assert_eq!(sub.param("short_id"), Some("deadbeef"));
    }

    #[test]
    fn from_node_derives_reality_public_key_from_private_key() {
        // RFC 7748 §6.1 的私钥；Xray 实际输出的是 URL-safe 无填充，这里两种都覆盖。
        let private_hex = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
        let private_bytes = hex::decode(private_hex).unwrap();
        let private_key = URL_SAFE_NO_PAD.encode(private_bytes);
        let node = fragment_node(
            "node-rfc",
            "香港 REALITY",
            "vless",
            "tcp",
            "reality",
            443,
            json!({
                "settings": {"clients": [], "decryption": "none"},
                "stream": {
                    "network": "tcp",
                    "security": "reality",
                    "realitySettings": {
                        "serverNames": ["www.example.com"],
                        "privateKey": private_key,
                        "shortIds": ["abcd1234"]
                    }
                }
            }),
        );

        let sub = SubNode::from_node(&node, "1.2.3.4", "user-1", "secret").unwrap();
        // 必须与 `xray x25519` 同格式：URL-safe 无填充
        let encoded = sub
            .param("public_key")
            .expect("应从 privateKey 反推出 publicKey");
        assert!(
            !encoded.contains(['+', '/', '=']),
            "订阅里的 publicKey 用了标准 base64：{encoded}"
        );
        let public = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .unwrap();

        assert_eq!(
            hex::encode(public),
            "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"
        );
    }

    #[test]
    fn from_node_parses_trojan_ws_tls_fragment() {
        let node = fragment_node(
            "node-2",
            "日本 02",
            "trojan",
            "ws",
            "tls",
            8443,
            json!({
                "settings": {"clients": []},
                "stream": {
                    "network": "ws",
                    "security": "tls",
                    "tlsSettings": {"serverName": "jp.example.com", "allowInsecure": true},
                    "wsSettings": {"path": "/ws", "headers": {"Host": "cdn.example.com"}}
                }
            }),
        );

        let sub = SubNode::from_node(&node, "5.6.7.8", "user-1", "secret").unwrap();

        assert_eq!(sub.transport, "ws");
        assert_eq!(sub.security, "tls");
        assert_eq!(sub.param("password").map(str::len), Some(36));
        assert_eq!(sub.param("sni"), Some("jp.example.com"));
        assert_eq!(sub.param("path"), Some("/ws"));
        assert_eq!(sub.param("host"), Some("cdn.example.com"));
        assert_eq!(sub.param("allow_insecure"), Some("true"));
    }

    #[test]
    fn from_node_skips_reality_without_public_key_instead_of_panicking() {
        let node = fragment_node(
            "node-3",
            "坏节点",
            "vless",
            "tcp",
            "reality",
            443,
            json!({"stream": {"network": "tcp", "security": "reality", "realitySettings": {"serverNames": ["a.com"]}}}),
        );
        assert!(SubNode::from_node(&node, "1.2.3.4", "user-1", "secret").is_none());
    }

    #[test]
    fn from_node_skips_broken_json_and_unknown_protocol() {
        let mut node = fragment_node("node-4", "坏节点", "vless", "tcp", "none", 443, json!({}));
        node.config_json = "not-json".into();
        assert!(SubNode::from_node(&node, "1.2.3.4", "user-1", "secret").is_none());

        let node = fragment_node("node-5", "socks", "socks", "tcp", "none", 1080, json!({}));
        assert!(SubNode::from_node(&node, "1.2.3.4", "user-1", "secret").is_none());
    }

    #[test]
    fn traffic_userinfo_omits_missing_total_and_expire() {
        let info = TrafficInfo {
            upload: 1,
            download: 2,
            total: None,
            expire: None,
        };
        assert_eq!(info.userinfo_header(), "upload=1; download=2");

        let info = TrafficInfo {
            upload: 1,
            download: 2,
            total: Some(100),
            expire: Some(1_900_000_000),
        };
        assert_eq!(
            info.userinfo_header(),
            "upload=1; download=2; total=100; expire=1900000000"
        );
    }

    #[test]
    fn selector_prefers_target_then_user_agent_then_clash() {
        assert_eq!(
            select_exporter(Some("uri"), Some("clash")).map(|e| e.id()),
            Some("uri")
        );
        assert_eq!(
            select_exporter(None, Some("Shadowrocket/2.2.0")).map(|e| e.id()),
            Some("shadowrocket")
        );
        assert_eq!(
            select_exporter(None, Some("clash-verge/1.5 mihomo")).map(|e| e.id()),
            Some("clash")
        );
        assert_eq!(select_exporter(None, None).map(|e| e.id()), Some("clash"));
        // 已注册的 egern 走 ?target=；未注册的 id 不再静默回落，交给调用方转 400。
        assert_eq!(
            select_exporter(Some("egern"), None).map(|e| e.id()),
            Some("egern")
        );
        assert!(select_exporter(Some("hiddify"), None).is_none());
    }

    #[test]
    fn selector_recognizes_every_registered_id_and_new_user_agents() {
        let ids = exporter_ids();
        for id in &ids {
            assert!(ids.contains(id), "注册表里缺少 {id}：{ids:?}");
            assert!(
                select_exporter(Some(id), None).is_some(),
                "?target={id} 没有解析到渲染器"
            );
        }
        for expected in [
            "clash",
            "mihomo",
            "stash",
            "surge",
            "egern",
            "loon",
            "qx",
            "surfboard",
            "singbox",
            "uri",
            "shadowrocket",
            "v2ray",
        ] {
            assert!(ids.contains(&expected), "注册表缺少格式 {expected}");
        }

        let ua_cases = [
            ("Shadowrocket/2.2.0", "shadowrocket"),
            ("v2rayNG/1.8.0", "v2ray"),
            ("sing-box/1.8.0", "singbox"),
            ("Stash/2.2.0", "stash"),
            ("Surfboard/2.0", "surfboard"),
            ("Quantumult%20X/1.4", "qx"),
            ("Loon/3.1", "loon"),
            ("Egern/1.0", "egern"),
            ("Surge/5.0", "surge"),
            ("ClashForAndroid/2.5", "clash"),
        ];
        for (ua, expected) in ua_cases {
            assert_eq!(
                select_exporter(None, Some(ua)).map(|e| e.id()),
                Some(expected),
                "UA {ua} 选错了格式"
            );
        }
    }

    fn sub_context<'a>(nodes: &'a [SubNode], rules: &'a [String]) -> SubContext<'a> {
        SubContext {
            nodes,
            user_label: "alice",
            traffic: None,
            rules,
        }
    }

    /// `[Proxy]` 段里的节点行（切到 `[Proxy Group]` 之前）。
    fn proxy_lines(body: &str) -> Vec<&str> {
        body.split("[Proxy Group]")
            .next()
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains(" = "))
            .collect()
    }

    #[test]
    fn stash_reuses_clash_yaml_with_header_and_url_test_auto() {
        let nodes = fixtures();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = StashExporter.render(&ctx).unwrap();

        assert!(body.starts_with("# stash\n"));
        let parsed: serde_yaml::Value = serde_yaml::from_str(&body).expect("stash 必须是合法 YAML");
        let proxies = parsed
            .get("proxies")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("proxies 必须是列表");
        assert_eq!(proxies.len(), 2);
        let groups = parsed
            .get("proxy-groups")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("proxy-groups 必须是列表");
        let auto = groups
            .iter()
            .find(|group| group.get("name").and_then(serde_yaml::Value::as_str) == Some("AUTO"))
            .expect("缺少 AUTO 组");
        assert_eq!(
            auto.get("type").and_then(serde_yaml::Value::as_str),
            Some("url-test")
        );
        let rules = parsed
            .get("rules")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("rules 必须是列表");
        assert_eq!(rules[0].as_str(), Some("GEOIP,CN,DIRECT"));
        assert_eq!(rules[1].as_str(), Some("MATCH,PROXY"));
        for node in &nodes {
            assert!(body.contains(&node.name), "缺少节点 {}", node.name);
        }
    }

    #[test]
    fn surge_ini_has_sections_reality_and_final() {
        let nodes = fixtures();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let output = render_ini(IniFlavor::Surge, &ctx);
        let body = &output.body;

        assert_eq!(output.skipped_nodes, 0);
        assert!(body.contains("[Proxy]"));
        assert!(body.contains("[Proxy Group]"));
        assert!(body.contains("[Rule]"));

        // [Proxy] 段恰好两条节点行。
        let proxy_section = body.split("[Proxy Group]").next().unwrap();
        let proxy_lines = proxy_section
            .lines()
            .filter(|line| line.contains(" = "))
            .count();
        assert_eq!(proxy_lines, 2, "{proxy_section}");

        assert!(body.contains("香港-REALITY = vless, "));
        assert!(body.contains("reality=true"));
        assert!(body.contains("public-key=public-key-abc"));
        assert!(body.contains("short-id=abcd1234"));
        assert!(body.contains("flow=xtls-rprx-vision"));
        assert!(body.contains("tls=true"));
        assert!(body.contains("日本-WS-TLS = trojan, "));
        assert!(body.contains("ws=true"));
        assert!(body.contains("ws-path=/ws"));
        assert!(body.contains("ws-headers=Host:cdn.example.com"));

        assert!(body.contains("PROXY = select, AUTO, 香港, 日本, DIRECT"));
        assert!(body.contains("AUTO = url-test, 香港-REALITY, 日本-WS-TLS"));
        assert!(body.contains("url=http://www.gstatic.com/generate_204"));
        assert!(body.contains("GEOIP,CN,DIRECT"));
        assert_eq!(body.lines().last(), Some("FINAL,PROXY"));
    }

    #[test]
    fn surge_maps_rules_and_skips_unknown_kinds() {
        let nodes = fixtures();
        let rules = vec![
            "DOMAIN-SUFFIX,example.com,DIRECT".to_string(),
            "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve".to_string(),
            "RULE-SET,reject,REJECT".to_string(),
            "MATCH,PROXY".to_string(),
        ];
        let ctx = sub_context(&nodes, &rules);
        let output = render_ini(IniFlavor::Surge, &ctx);

        assert!(output.body.contains("DOMAIN-SUFFIX,example.com,DIRECT"));
        assert!(output.body.contains("IP-CIDR,10.0.0.0/8,DIRECT,no-resolve"));
        assert!(!output.body.contains("RULE-SET"));
        assert_eq!(output.skipped_rules, 1);
        assert_eq!(output.body.lines().last(), Some("FINAL,PROXY"));
    }

    #[test]
    fn surge_skips_unsupported_transport_and_counts() {
        let nodes = vec![
            node(
                "gRPC-不支持",
                "vless",
                "grpc",
                "tls",
                443,
                &[("uuid", "44444444-4444-4444-8444-444444444444")],
            ),
            node(
                "香港-WS",
                "vless",
                "ws",
                "tls",
                443,
                &[("uuid", "55555555-5555-4555-8555-555555555555")],
            ),
        ];
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let output = render_ini(IniFlavor::Surge, &ctx);

        assert_eq!(output.skipped_nodes, 1);
        assert!(!output.body.contains("gRPC-不支持"));
        assert!(output.body.contains("香港-WS = vless, "));
    }

    #[test]
    fn surge_without_nodes_is_still_a_valid_skeleton() {
        let nodes: Vec<SubNode> = Vec::new();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let output = render_ini(IniFlavor::Surge, &ctx);

        assert_eq!(output.skipped_nodes, 0);
        assert!(output.body.contains("[Proxy]\n\n[Proxy Group]"));
        assert!(output.body.contains("PROXY = select, DIRECT"));
        assert!(!output.body.contains("AUTO = url-test"));
        assert!(output.body.contains("GEOIP,CN,DIRECT"));
        assert_eq!(output.body.lines().last(), Some("FINAL,PROXY"));
    }

    #[test]
    fn egern_reuses_the_surge_body_and_only_differs_in_the_header() {
        let nodes = fixtures();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let surge = SurgeExporter.render(&ctx).unwrap();
        let egern = EgernExporter.render(&ctx).unwrap();

        // 文件头：MANAGED-CONFIG 指令 + 中英双语说明「按 Surge 兼容格式输出」。
        assert!(egern.starts_with("#!MANAGED-CONFIG\n"), "{egern}");
        assert!(egern.contains("Surge 兼容"), "{egern}");
        assert!(egern.contains("Surge-compatible"), "{egern}");

        // 去掉文件头后逐字节一致：两个格式共享同一个生成器，没有复制的一份。
        let body = egern
            .strip_prefix(EGERN_HEADER)
            .expect("Egern 必须带统一文件头");
        assert_eq!(body, surge, "Egern 正文必须与 Surge 逐字节一致");

        // 代理行也逐行一致（本轮要求的最直接断言）。
        assert_eq!(proxy_lines(body), proxy_lines(&surge));
        assert_eq!(proxy_lines(body).len(), 2);
    }

    #[test]
    fn egern_renders_nodes_groups_and_rules_with_surge_fields() {
        let nodes = fixtures();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = EgernExporter.render(&ctx).unwrap();

        assert!(body.contains("[Proxy]"));
        assert!(body.contains("[Proxy Group]"));
        assert!(body.contains("[Rule]"));

        // 节点行与 Surge 的字段语义一致（REALITY / WS-TLS 都能表达）。
        assert!(body.contains("香港-REALITY = vless, "));
        assert!(body.contains("reality=true"));
        assert!(body.contains("public-key=public-key-abc"));
        assert!(body.contains("flow=xtls-rprx-vision"));
        assert!(body.contains("日本-WS-TLS = trojan, "));
        assert!(body.contains("ws=true"));
        assert!(body.contains("ws-path=/ws"));
        assert!(body.contains("ws-headers=Host:cdn.example.com"));

        // 分组与规则复用 Surge 的映射，节点一个都不少。
        assert!(body.contains("PROXY = select, AUTO, 香港, 日本, DIRECT"));
        assert!(body.contains("AUTO = url-test, 香港-REALITY, 日本-WS-TLS"));
        assert!(body.contains("GEOIP,CN,DIRECT"));
        assert_eq!(body.lines().last(), Some("FINAL,PROXY"));

        assert_eq!(EgernExporter.id(), "egern");
        assert_eq!(EgernExporter.content_type(), "text/plain; charset=utf-8");
    }

    #[test]
    fn surfboard_supports_reality_and_skips_grpc() {
        let nodes = vec![
            node(
                "香港-REALITY",
                "vless",
                "tcp",
                "reality",
                443,
                &[
                    ("uuid", "11111111-1111-4111-8111-111111111111"),
                    ("sni", "www.example.com"),
                    ("public_key", "public-key-abc"),
                    ("short_id", "abcd1234"),
                ],
            ),
            node(
                "gRPC-节点",
                "trojan",
                "grpc",
                "tls",
                8443,
                &[("password", "secret")],
            ),
        ];
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let output = render_ini(IniFlavor::Surfboard, &ctx);

        assert_eq!(output.skipped_nodes, 1);
        assert!(output.body.contains("香港-REALITY = vless, "));
        assert!(output.body.contains("reality=true"));
        assert!(output.body.contains("public-key=public-key-abc"));
        assert!(!output.body.contains("gRPC-节点"));
        assert_eq!(output.body.lines().last(), Some("FINAL,PROXY"));
    }

    #[test]
    fn loon_uses_obfs_fields_and_skips_reality() {
        let nodes = vec![
            node(
                "香港-REALITY",
                "vless",
                "tcp",
                "reality",
                443,
                &[
                    ("uuid", "11111111-1111-4111-8111-111111111111"),
                    ("public_key", "public-key-abc"),
                ],
            ),
            node(
                "日本-WS-TLS",
                "trojan",
                "ws",
                "tls",
                8443,
                &[
                    ("password", "22222222-2222-4222-8222-222222222222"),
                    ("sni", "jp.example.com"),
                    ("path", "/ws"),
                    ("host", "cdn.example.com"),
                ],
            ),
            node(
                "美国-VMess",
                "vmess",
                "ws",
                "tls",
                443,
                &[
                    ("uuid", "33333333-3333-4333-8333-333333333333"),
                    ("sni", "us.example.com"),
                    ("path", "/vm"),
                    ("host", "us.example.com"),
                ],
            ),
        ];
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let output = render_ini(IniFlavor::Loon, &ctx);

        // Loon 不支持 REALITY：该节点跳过并计数。
        assert_eq!(output.skipped_nodes, 1);
        assert!(!output.body.contains("香港-REALITY"));
        assert!(output.body.contains("日本-WS-TLS = trojan, "));
        assert!(output.body.contains("美国-VMess = vmess, "));
        // Loon 的 TLS / WS 字段名与 Surge 不同。
        assert!(output.body.contains("tls=true"));
        assert!(output.body.contains("obfs=ws"));
        assert!(output.body.contains("obfs-uri=/ws"));
        assert!(output.body.contains("obfs-host=cdn.example.com"));
        // Loon 没有 udp-relay 参数，不要生成。
        assert!(!output.body.contains("udp-relay=true"));
        assert!(output
            .body
            .contains("PROXY = select, AUTO, 日本, 美国, DIRECT"));
        assert!(output.body.contains("GEOIP,CN,DIRECT"));
        assert_eq!(output.body.lines().last(), Some("FINAL,PROXY"));
    }

    #[test]
    fn qx_uses_server_local_policy_and_filter_sections() {
        let nodes = vec![
            node(
                "香港-REALITY",
                "vless",
                "tcp",
                "reality",
                443,
                &[
                    ("uuid", "11111111-1111-4111-8111-111111111111"),
                    ("public_key", "public-key-abc"),
                ],
            ),
            node(
                "日本-WS-TLS",
                "trojan",
                "ws",
                "tls",
                8443,
                &[
                    ("password", "22222222-2222-4222-8222-222222222222"),
                    ("sni", "jp.example.com"),
                    ("path", "/ws"),
                    ("host", "cdn.example.com"),
                ],
            ),
            node(
                "plain-vless",
                "vless",
                "tcp",
                "none",
                80,
                &[("uuid", "66666666-6666-4666-8666-666666666666")],
            ),
        ];
        let rules = vec![
            "DOMAIN-SUFFIX,example.com,DIRECT".to_string(),
            "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve".to_string(),
            "GEOIP,CN,DIRECT".to_string(),
            "MATCH,PROXY".to_string(),
        ];
        let ctx = sub_context(&nodes, &rules);
        let output = render_ini(IniFlavor::Qx, &ctx);
        let body = &output.body;

        // REALITY 在 Quantumult X 里无法表达，跳过并计数。
        assert_eq!(output.skipped_nodes, 1);
        assert!(!body.contains("香港-REALITY"));
        assert!(body.contains("[server_local]"));
        assert!(body.contains("[policy]"));
        assert!(body.contains("[filter_local]"));
        assert!(body.contains("tag=plain-vless"));
        assert!(body.contains("vless=203.0.113.10:80, method=none, password="));
        assert!(body.contains("trojan=203.0.113.10:8443, password="));
        assert!(body.contains("obfs=wss"));
        assert!(body.contains("tag=日本-WS-TLS"));
        assert!(body.contains("static=PROXY, AUTO, 日本, 其他, direct"));
        assert!(body.contains("url-latency-benchmark=AUTO, 日本-WS-TLS, plain-vless"));
        assert!(body.contains("host-suffix, example.com, direct"));
        assert!(body.contains("ip-cidr, 10.0.0.0/8, direct, no-resolve"));
        assert!(body.contains("geoip, cn, direct"));
        assert_eq!(body.lines().last(), Some("final, PROXY"));
    }

    #[test]
    fn qx_skips_unmapped_rules_and_falls_back_to_direct_final() {
        let nodes = fixtures();
        let rules = vec![
            "RULE-SET,reject,REJECT".to_string(),
            "MATCH,UNKNOWN-POLICY".to_string(),
        ];
        let ctx = sub_context(&nodes, &rules);
        let output = render_ini(IniFlavor::Qx, &ctx);

        assert!(!output.body.contains("RULE-SET"));
        assert_eq!(output.skipped_rules, 2);
        assert_eq!(output.body.lines().last(), Some("final, direct"));
    }

    #[test]
    fn qx_without_nodes_is_still_a_valid_skeleton() {
        let nodes: Vec<SubNode> = Vec::new();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let output = render_ini(IniFlavor::Qx, &ctx);

        assert!(output.body.contains("[server_local]\n\n[policy]"));
        assert!(output.body.contains("static=PROXY, direct"));
        assert!(output.body.contains("geoip, cn, direct"));
        assert_eq!(output.body.lines().last(), Some("final, PROXY"));
    }

    #[test]
    fn singbox_json_has_outbounds_selector_and_reality() {
        let nodes = fixtures();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let output = render_singbox(&ctx);
        let parsed: Value = serde_json::from_str(&output.body).expect("sing-box 必须是合法 JSON");

        assert_eq!(output.skipped_nodes, 0);
        let outbounds = parsed["outbounds"].as_array().unwrap();
        let tags: Vec<&str> = outbounds
            .iter()
            .filter_map(|outbound| outbound["tag"].as_str())
            .collect();
        for expected in [
            "香港-REALITY",
            "日本-WS-TLS",
            "AUTO",
            "selector",
            "direct",
            "blocker",
        ] {
            assert!(tags.contains(&expected), "缺少出站 {expected}: {tags:?}");
        }

        let vless = outbounds
            .iter()
            .find(|outbound| outbound["tag"] == "香港-REALITY")
            .unwrap();
        assert_eq!(vless["type"], "vless");
        assert_eq!(vless["uuid"], "11111111-1111-4111-8111-111111111111");
        assert_eq!(vless["flow"], "xtls-rprx-vision");
        assert_eq!(vless["tls"]["enabled"], true);
        assert_eq!(vless["tls"]["server_name"], "www.example.com");
        assert_eq!(vless["tls"]["reality"]["enabled"], true);
        assert_eq!(vless["tls"]["reality"]["public_key"], "public-key-abc");
        assert_eq!(vless["tls"]["reality"]["short_id"], "abcd1234");
        assert_eq!(vless["tls"]["utls"]["enabled"], true);

        let trojan = outbounds
            .iter()
            .find(|outbound| outbound["tag"] == "日本-WS-TLS")
            .unwrap();
        assert_eq!(trojan["type"], "trojan");
        assert_eq!(trojan["transport"]["type"], "ws");
        assert_eq!(trojan["transport"]["path"], "/ws");
        assert_eq!(trojan["transport"]["headers"]["Host"], "cdn.example.com");

        // 默认规则：GEOIP,CN,DIRECT → geoip + direct；MATCH,PROXY → route.final。
        assert_eq!(parsed["route"]["rules"][0]["geoip"][0], "cn");
        assert_eq!(parsed["route"]["rules"][0]["outbound"], "direct");
        assert_eq!(parsed["route"]["final"], "selector");
    }

    #[test]
    fn singbox_maps_domain_cidr_rules_and_skips_unknown() {
        let nodes = fixtures();
        let rules = vec![
            "DOMAIN-SUFFIX,example.com,DIRECT".to_string(),
            "IP-CIDR,10.0.0.0/8,DIRECT".to_string(),
            "RULE-SET,cn,DIRECT".to_string(),
            "MATCH,PROXY".to_string(),
        ];
        let ctx = sub_context(&nodes, &rules);
        let output = render_singbox(&ctx);
        let parsed: Value = serde_json::from_str(&output.body).unwrap();
        let rules = parsed["route"]["rules"].as_array().unwrap();

        assert_eq!(rules.len(), 2, "RULE-SET 应被跳过：{rules:?}");
        assert_eq!(rules[0]["domain_suffix"][0], "example.com");
        assert_eq!(rules[0]["outbound"], "direct");
        assert_eq!(rules[1]["ip_cidr"][0], "10.0.0.0/8");
        assert_eq!(parsed["route"]["final"], "selector");
    }

    #[test]
    fn singbox_without_nodes_still_has_the_three_required_outbounds() {
        let nodes: Vec<SubNode> = Vec::new();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let output = render_singbox(&ctx);
        let parsed: Value = serde_json::from_str(&output.body).expect("空节点也必须是合法 JSON");

        let outbounds = parsed["outbounds"].as_array().unwrap();
        assert_eq!(outbounds.len(), 3);
        let tags: Vec<&str> = outbounds
            .iter()
            .filter_map(|outbound| outbound["tag"].as_str())
            .collect();
        for expected in ["direct", "blocker", "selector"] {
            assert!(tags.contains(&expected));
        }
        assert_eq!(parsed["route"]["final"], "selector");
    }

    #[test]
    fn singbox_skips_unsupported_transport_and_counts() {
        let nodes = vec![
            node(
                "kcp-节点",
                "vless",
                "kcp",
                "none",
                443,
                &[("uuid", "77777777-7777-4777-8777-777777777777")],
            ),
            node(
                "ws-节点",
                "vless",
                "ws",
                "tls",
                443,
                &[("uuid", "88888888-8888-4888-8888-888888888888")],
            ),
        ];
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let output = render_singbox(&ctx);
        let parsed: Value = serde_json::from_str(&output.body).unwrap();

        assert_eq!(output.skipped_nodes, 1);
        let tags: Vec<&str> = parsed["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|outbound| outbound["tag"].as_str())
            .collect();
        assert!(tags.contains(&"ws-节点"));
        assert!(!tags.contains(&"kcp-节点"));
    }

    // -----------------------------------------------------------------
    // 完整配置：singbox-full / surge-full
    // -----------------------------------------------------------------

    /// 四个协议各一条，用于「与 clash 的 proxies 逐字段一致」的断言。
    fn full_config_nodes() -> Vec<SubNode> {
        let mut nodes = fixtures();
        nodes.push(node(
            "美国-VMess",
            "vmess",
            "ws",
            "tls",
            443,
            &[
                ("uuid", "33333333-3333-4333-8333-333333333333"),
                ("alter_id", "0"),
                ("sni", "us.example.com"),
                ("path", "/vm"),
                ("host", "us.example.com"),
            ],
        ));
        nodes.push(node(
            "其他-SS",
            "ss",
            "tcp",
            "none",
            8388,
            &[("method", "aes-256-gcm"), ("password", "secret")],
        ));
        nodes
    }

    fn outbound_tags(parsed: &Value) -> Vec<&str> {
        parsed["outbounds"]
            .as_array()
            .unwrap_or_else(|| panic!("outbounds 必须是列表：{parsed}"))
            .iter()
            .filter_map(|outbound| outbound["tag"].as_str())
            .collect()
    }

    /// 完整配置里所有被引用的出站（route.final、规则、组、DNS detour）都必须真实存在，
    /// 否则客户端会整份拒收——这比「JSON 能解析」更接近「能 run」。
    fn assert_singbox_references_resolve(parsed: &Value) {
        let tags = outbound_tags(parsed);
        let mut referenced: Vec<&str> = vec![parsed["route"]["final"]
            .as_str()
            .unwrap_or_else(|| panic!("route.final 必须是字符串：{parsed}"))];
        for rule in parsed["route"]["rules"].as_array().unwrap() {
            // `REJECT` 规则是 `action: reject`，没有 outbound；只校验真正指向出站的规则。
            if let Some(outbound) = rule["outbound"].as_str() {
                referenced.push(outbound);
            }
        }
        for outbound in parsed["outbounds"].as_array().unwrap() {
            if let Some(members) = outbound["outbounds"].as_array() {
                for member in members {
                    referenced.push(member.as_str().unwrap());
                }
            }
        }
        for tag in referenced {
            assert!(tags.contains(&tag), "引用了不存在的出站 {tag}：{tags:?}");
        }
        for server in parsed["dns"]["servers"].as_array().unwrap() {
            let detour = server["detour"].as_str().unwrap();
            assert!(
                tags.contains(&detour),
                "DNS detour 指向不存在的出站 {detour}：{tags:?}"
            );
        }
    }

    #[test]
    fn singbox_full_json_has_log_dns_inbounds_outbounds_route() {
        let nodes = full_config_nodes();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = SingboxFullExporter.render(&ctx).unwrap();
        let parsed: Value = serde_json::from_str(&body).expect("singbox-full 必须是合法 JSON");

        for key in ["log", "dns", "inbounds", "outbounds", "route"] {
            assert!(parsed.get(key).is_some(), "缺少顶层小节 {key}：{body}");
        }
        assert_eq!(parsed["log"]["level"], "info");
        assert_eq!(parsed["log"]["timestamp"], true);

        // DNS：两个 DoH 服务（sing-box 1.12+ 的 `type: https` 新格式），
        // final 指向其中真实存在的 tag。
        let servers = parsed["dns"]["servers"].as_array().unwrap();
        assert_eq!(servers.len(), 2);
        for server in servers {
            assert_eq!(server["type"], "https", "{server:?}");
            assert!(server["server"].as_str().is_some(), "{server:?}");
        }
        assert!(servers
            .iter()
            .any(|server| server["tag"] == parsed["dns"]["final"]));

        // 入站：mixed，监听 7890。
        let inbounds = parsed["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 1);
        assert_eq!(inbounds[0]["type"], "mixed");
        assert_eq!(inbounds[0]["listen"], "127.0.0.1");
        assert_eq!(inbounds[0]["listen_port"], 7890);

        // 节点出站：四个协议各一条，tag 与 clash 的 name 同源。
        let node_outbounds: Vec<&Value> = parsed["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|outbound| {
                matches!(
                    outbound["type"].as_str(),
                    Some("vless" | "vmess" | "trojan" | "ss")
                )
            })
            .collect();
        assert_eq!(node_outbounds.len(), nodes.len(), "{body}");

        let tags = outbound_tags(&parsed);
        for expected in ["AUTO", "selector", "direct"] {
            assert!(tags.contains(&expected), "缺少出站 {expected}：{tags:?}");
        }
        // 完整配置不能带 legacy 特殊出站（sing-box 1.13 起已移除）。
        assert!(
            !parsed["outbounds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|outbound| outbound["type"] == "block" || outbound["tag"] == "blocker"),
            "singbox-full 不应输出 legacy block 出站：{body}"
        );
        let auto = parsed["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|outbound| outbound["tag"] == "AUTO")
            .unwrap();
        let auto_members: Vec<&str> = auto["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|member| member.as_str().unwrap())
            .collect();
        let node_names: Vec<&str> = nodes.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(auto_members, node_names);

        assert_eq!(parsed["route"]["final"], "selector");
        assert_eq!(parsed["route"]["auto_detect_interface"], true);
        assert_eq!(parsed["route"]["rules"][0]["geoip"][0], "cn");
        assert_eq!(parsed["route"]["rules"][0]["outbound"], "direct");
        assert_singbox_references_resolve(&parsed);

        assert_eq!(SingboxFullExporter.id(), "singbox-full");
        assert_eq!(
            SingboxFullExporter.content_type(),
            "application/json; charset=utf-8"
        );
    }

    #[test]
    fn singbox_full_single_node_keeps_the_complete_skeleton() {
        let nodes = vec![fixtures().remove(0)];
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = SingboxFullExporter.render(&ctx).unwrap();
        let parsed: Value = serde_json::from_str(&body).expect("必须是合法 JSON");

        let node_outbounds: Vec<&Value> = parsed["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|outbound| outbound["type"] == "vless")
            .collect();
        assert_eq!(node_outbounds.len(), 1);
        assert_eq!(node_outbounds[0]["tag"], "香港-REALITY");

        let auto = parsed["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|outbound| outbound["tag"] == "AUTO")
            .unwrap();
        assert_eq!(auto["outbounds"], json!(["香港-REALITY"]));
        assert!(parsed["inbounds"].as_array().is_some());
        assert_eq!(parsed["route"]["final"], "selector");
        assert_singbox_references_resolve(&parsed);
    }

    /// 无节点也必须是「能 run」的最小配置：五段齐全、出站引用全部可解析。
    #[test]
    fn singbox_full_without_nodes_is_still_runnable() {
        let nodes: Vec<SubNode> = Vec::new();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = SingboxFullExporter.render(&ctx).unwrap();
        let parsed: Value =
            serde_json::from_str(&body).expect("空节点 singbox-full 也必须是合法 JSON");

        for key in ["log", "dns", "inbounds", "outbounds", "route"] {
            assert!(parsed.get(key).is_some(), "缺少顶层小节 {key}：{body}");
        }
        let tags = outbound_tags(&parsed);
        assert_eq!(tags, vec!["selector", "direct"]);

        let selector = &parsed["outbounds"][0];
        assert_eq!(selector["type"], "selector");
        assert_eq!(selector["outbounds"], json!(["direct"]));
        assert_eq!(selector["default"], "direct");

        assert_eq!(parsed["inbounds"][0]["type"], "mixed");
        assert_eq!(parsed["route"]["final"], "selector");
        assert_eq!(parsed["route"]["rules"][0]["outbound"], "direct");
        assert_singbox_references_resolve(&parsed);
    }

    /// 防止 singbox-full 与 clash 各写一份节点表达后逐渐漂移：关键字段必须一致。
    #[test]
    fn singbox_full_matches_clash_field_by_field() {
        let nodes = full_config_nodes();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);

        let clash: serde_yaml::Value =
            serde_yaml::from_str(&ClashExporter.render(&ctx).unwrap()).unwrap();
        let full: Value = serde_json::from_str(&SingboxFullExporter.render(&ctx).unwrap()).unwrap();
        let outbounds = full["outbounds"].as_array().unwrap();

        for proxy in clash["proxies"].as_sequence().unwrap() {
            let name = proxy["name"].as_str().unwrap();
            let outbound = outbounds
                .iter()
                .find(|outbound| outbound["tag"] == name)
                .unwrap_or_else(|| panic!("singbox-full 缺少节点出站 {name}"));
            assert_eq!(
                outbound["server"].as_str(),
                proxy["server"].as_str(),
                "{name} 的 server 与 clash 不一致"
            );
            assert_eq!(
                outbound["server_port"].as_u64(),
                proxy["port"].as_u64(),
                "{name} 的 port 与 clash 不一致"
            );
            match proxy["type"].as_str().unwrap() {
                "vless" | "vmess" => assert_eq!(
                    outbound["uuid"].as_str(),
                    proxy["uuid"].as_str(),
                    "{name} 的 uuid 与 clash 不一致"
                ),
                "trojan" | "ss" => assert_eq!(
                    outbound["password"].as_str(),
                    proxy["password"].as_str(),
                    "{name} 的 password 与 clash 不一致"
                ),
                other => panic!("未覆盖的协议 {other}"),
            }
            if proxy["type"].as_str() == Some("ss") {
                assert_eq!(
                    outbound["method"].as_str(),
                    proxy["cipher"].as_str(),
                    "{name} 的 method 与 clash 不一致"
                );
            }
            let sni = proxy["servername"]
                .as_str()
                .or_else(|| proxy["sni"].as_str());
            if let Some(sni) = sni {
                assert_eq!(
                    outbound["tls"]["server_name"].as_str(),
                    Some(sni),
                    "{name} 的 sni 与 clash 不一致"
                );
            }
        }
    }

    /// JSON 里节点名的引号、反斜杠、换行必须转义，且组引用同一个名字。
    #[test]
    fn singbox_full_escapes_json_special_characters_in_node_names() {
        let names = [
            "香港 \"引号\" 节点",
            "日本 \\ 反斜杠",
            "美国\n换行",
            "逗号, 方括号] 冒号: #",
        ];
        let nodes: Vec<SubNode> = names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                node(
                    name,
                    "vless",
                    "tcp",
                    "tls",
                    443 + index as u16,
                    &[
                        ("uuid", "11111111-1111-4111-8111-111111111111"),
                        ("sni", "example.com"),
                    ],
                )
            })
            .collect();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = SingboxFullExporter.render(&ctx).unwrap();
        let parsed: Value = serde_json::from_str(&body)
            .unwrap_or_else(|error| panic!("特殊字符节点名破坏了 JSON：{error}\n{body}"));

        let parsed_names: Vec<&str> = parsed["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|outbound| outbound["type"] == "vless")
            .map(|outbound| outbound["tag"].as_str().unwrap())
            .collect();
        assert_eq!(parsed_names, names);

        let auto = parsed["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|outbound| outbound["tag"] == "AUTO")
            .unwrap();
        let auto_members: Vec<&str> = auto["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|member| member.as_str().unwrap())
            .collect();
        assert_eq!(auto_members, names);

        assert!(body.contains("\\\"引号\\\""), "{body}");
        assert!(body.contains("美国\\n换行"), "{body}");
    }

    /// `REJECT` 不能用 legacy `block` 出站（1.13 移除）：规则要映射成
    /// `action: reject`，`MATCH,REJECT` 则落到末尾一条无条件 reject 规则。
    #[test]
    fn singbox_full_maps_reject_rules_to_rule_actions() {
        let nodes = fixtures();
        let rules = vec![
            "DOMAIN-SUFFIX,ads.example,REJECT".to_string(),
            "MATCH,DIRECT".to_string(),
        ];
        let ctx = sub_context(&nodes, &rules);
        let body = SingboxFullExporter.render(&ctx).unwrap();
        let parsed: Value = serde_json::from_str(&body).expect("必须是合法 JSON");

        let reject = &parsed["route"]["rules"][0];
        assert_eq!(reject["domain_suffix"][0], "ads.example");
        assert_eq!(reject["action"], "reject");
        assert!(reject.get("outbound").is_none(), "{reject:?}");
        assert!(
            !body.contains("blocker"),
            "不应再引用 legacy blocker：{body}"
        );
        assert_singbox_references_resolve(&parsed);

        // 模板以 `MATCH,REJECT` 收尾时，final 不能是 blockers：改成末尾 reject 规则。
        let rules = vec!["MATCH,REJECT".to_string()];
        let ctx = sub_context(&nodes, &rules);
        let body = SingboxFullExporter.render(&ctx).unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["route"]["final"], "selector");
        let last = parsed["route"]["rules"].as_array().unwrap().last().unwrap();
        assert_eq!(last["action"], "reject");
        assert!(last.get("outbound").is_none(), "{last:?}");
        assert_singbox_references_resolve(&parsed);
    }

    #[test]
    fn shadowrocket_is_padded_base64_of_the_uri_list() {
        let nodes = fixtures();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = ShadowrocketExporter.render(&ctx).unwrap();
        let plain = UriExporter.render(&ctx).unwrap();

        assert!(body.len().is_multiple_of(4), "标准 base64 应带填充");
        assert!(body
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=')));
        let decoded = STANDARD.decode(&body).expect("必须是标准 base64");
        let text = String::from_utf8(decoded).unwrap();
        assert_eq!(text, plain);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("vless://"));
        assert!(lines[1].starts_with("trojan://"));
        assert!(lines[1].contains("path=%2Fws"));
    }

    #[test]
    fn v2ray_is_base64_alias_of_uri_and_handles_empty_nodes() {
        let nodes = fixtures();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let v2ray = V2RayExporter.render(&ctx).unwrap();
        let shadowrocket = ShadowrocketExporter.render(&ctx).unwrap();
        let plain = UriExporter.render(&ctx).unwrap();

        assert_eq!(v2ray, shadowrocket);
        let decoded = STANDARD.decode(&v2ray).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), plain);
        assert_eq!(V2RayExporter.id(), "v2ray");
        assert_eq!(V2RayExporter.content_type(), "text/plain; charset=utf-8");

        let empty: Vec<SubNode> = Vec::new();
        let ctx = sub_context(&empty, &rules);
        let body = V2RayExporter.render(&ctx).unwrap();
        assert!(STANDARD.decode(body).unwrap().is_empty());
    }

    #[test]
    fn exporter_ids_are_stable_and_ordered() {
        // 400 的 supported 列表直接来自这里；顺序必须稳定，不能受 HashMap 影响。
        assert_eq!(
            exporter_ids(),
            vec![
                "clash",
                "mihomo",
                "stash",
                "surge",
                "egern",
                "surfboard",
                "loon",
                "qx",
                "singbox",
                "uri",
                "shadowrocket",
                "v2ray",
                "singbox-full",
                "surge-full",
            ]
        );
    }

    #[test]
    fn empty_subscription_is_valid_for_every_format() {
        let nodes: Vec<SubNode> = Vec::new();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);

        for exporter in exporters() {
            let id = exporter.id();
            let body = exporter
                .render(&ctx)
                .unwrap_or_else(|error| panic!("{id} 空节点渲染失败：{error}"));
            match id {
                "clash" | "stash" => {
                    let yaml: serde_yaml::Value =
                        serde_yaml::from_str(&body).unwrap_or_else(|error| {
                            panic!("{id} 空节点不是合法 YAML：{error}\n{body}")
                        });
                    let proxies = yaml
                        .get("proxies")
                        .and_then(serde_yaml::Value::as_sequence)
                        .unwrap_or_else(|| panic!("{id} 缺少 proxies：{body}"));
                    assert!(proxies.is_empty(), "{id} 空节点不应有代理：{body}");
                }
                "mihomo" => {
                    let yaml: serde_yaml::Value =
                        serde_yaml::from_str(&body).unwrap_or_else(|error| {
                            panic!("{id} 空节点不是合法 YAML：{error}\n{body}")
                        });
                    assert!(
                        yaml.get("proxies")
                            .and_then(serde_yaml::Value::as_sequence)
                            .unwrap_or_else(|| panic!("{id} 缺少 proxies：{body}"))
                            .is_empty(),
                        "{id} 空节点不应有代理：{body}"
                    );
                    let groups = yaml
                        .get("proxy-groups")
                        .and_then(serde_yaml::Value::as_sequence)
                        .unwrap_or_else(|| panic!("{id} 缺少 proxy-groups：{body}"));
                    assert_eq!(groups.len(), 2, "{id} 空节点仍应保留两个组：{body}");
                    for group in groups {
                        assert!(
                            group
                                .get("proxies")
                                .and_then(serde_yaml::Value::as_sequence)
                                .is_some_and(|proxies| proxies.is_empty()),
                            "{id} 空节点时组 proxies 必须是 []：{group:?}"
                        );
                    }
                }
                "singbox" | "singbox-full" => {
                    let parsed: Value = serde_json::from_str(&body).unwrap_or_else(|error| {
                        panic!("{id} 空节点不是合法 JSON：{error}\n{body}")
                    });
                    let tags: Vec<&str> = parsed["outbounds"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|outbound| outbound["tag"].as_str())
                        .collect();
                    for expected in ["direct", "selector"] {
                        assert!(tags.contains(&expected), "{id} 缺少 {expected}");
                    }
                    // 片段保持 legacy `blocker`；完整配置改用规则动作。
                    assert_eq!(
                        tags.contains(&"blocker"),
                        id == "singbox",
                        "{id} 的 blocker 出站与格式约定不一致：{tags:?}"
                    );
                    if id == "singbox-full" {
                        for key in ["log", "dns", "inbounds", "route"] {
                            assert!(
                                parsed.get(key).is_some(),
                                "{id} 空节点缺少顶层小节 {key}：{body}"
                            );
                        }
                        assert_singbox_references_resolve(&parsed);
                    }
                }
                "surge" | "surge-full" | "egern" | "surfboard" | "loon" => {
                    assert!(body.contains("[Proxy]"), "{id} 缺少 [Proxy]");
                    assert!(body.contains("[Proxy Group]"), "{id} 缺少 [Proxy Group]");
                    assert!(body.contains("[Rule]"), "{id} 缺少 [Rule]");
                    assert!(
                        body.lines()
                            .last()
                            .unwrap_or_default()
                            .starts_with("FINAL,"),
                        "{id} 缺少 FINAL：{body}"
                    );
                    if id == "surge-full" {
                        assert!(body.contains("[General]"), "{id} 缺少 [General]");
                    }
                }
                "qx" => {
                    for section in ["[server_local]", "[policy]", "[filter_local]"] {
                        assert!(body.contains(section), "qx 缺少 {section}");
                    }
                    assert!(
                        body.lines()
                            .last()
                            .unwrap_or_default()
                            .starts_with("final,"),
                        "qx 缺少 final：{body}"
                    );
                }
                "uri" => assert!(body.is_empty(), "uri 空节点应输出空文本：{body}"),
                "shadowrocket" | "v2ray" => {
                    let decoded = STANDARD
                        .decode(body.trim())
                        .unwrap_or_else(|error| panic!("{id} 空节点不是合法 base64：{error}"));
                    assert!(decoded.is_empty(), "{id} 空节点解码后应为空");
                }
                other => panic!("新增格式 {other} 没有覆盖空结构断言"),
            }
        }
    }

    #[test]
    fn singbox_single_reality_node_has_reality_tls() {
        let nodes = vec![node(
            "单节点-REALITY",
            "vless",
            "tcp",
            "reality",
            443,
            &[
                ("uuid", "11111111-1111-4111-8111-111111111111"),
                ("flow", "xtls-rprx-vision"),
                ("sni", "www.example.com"),
                ("public_key", "public-key-abc"),
                ("short_id", "abcd1234"),
                ("fingerprint", "chrome"),
            ],
        )];
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let output = render_singbox(&ctx);

        assert_eq!(output.skipped_nodes, 0);
        let parsed: Value = serde_json::from_str(&output.body).expect("必须是合法 JSON");
        let outbounds = parsed["outbounds"].as_array().unwrap();
        let node_outbounds: Vec<&Value> = outbounds
            .iter()
            .filter(|outbound| outbound["type"] == "vless")
            .collect();
        assert_eq!(node_outbounds.len(), 1, "单节点只应生成一条 vless 出站");
        let vless = node_outbounds[0];
        assert_eq!(vless["tag"], "单节点-REALITY");
        assert_eq!(vless["tls"]["enabled"], true);
        assert_eq!(vless["tls"]["server_name"], "www.example.com");
        assert_eq!(vless["tls"]["reality"]["enabled"], true);
        assert_eq!(vless["tls"]["reality"]["public_key"], "public-key-abc");
        assert_eq!(vless["tls"]["reality"]["short_id"], "abcd1234");
        assert_eq!(vless["tls"]["utls"]["fingerprint"], "chrome");
        assert_eq!(vless["flow"], "xtls-rprx-vision");
    }

    #[test]
    fn surge_single_reality_node_emits_reality_parameters() {
        let nodes = vec![node(
            "单节点-REALITY",
            "vless",
            "tcp",
            "reality",
            443,
            &[
                ("uuid", "11111111-1111-4111-8111-111111111111"),
                ("flow", "xtls-rprx-vision"),
                ("sni", "www.example.com"),
                ("public_key", "public-key-abc"),
                ("short_id", "abcd1234"),
            ],
        )];
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let output = render_ini(IniFlavor::Surge, &ctx);

        assert_eq!(output.skipped_nodes, 0);
        let proxy_section = output.body.split("[Proxy Group]").next().unwrap();
        assert_eq!(
            proxy_section
                .lines()
                .filter(|line| line.contains(" = "))
                .count(),
            1
        );
        assert!(output.body.contains("单节点-REALITY = vless, "));
        assert!(output.body.contains("tls=true"));
        assert!(output.body.contains("sni=www.example.com"));
        assert!(output.body.contains("reality=true"));
        assert!(output.body.contains("public-key=public-key-abc"));
        assert!(output.body.contains("short-id=abcd1234"));
        assert_eq!(output.body.lines().last(), Some("FINAL,PROXY"));
    }

    // -----------------------------------------------------------------
    // surge-full：四段齐全的完整 profile
    // -----------------------------------------------------------------

    /// 解析 surge-full 的 `[Proxy]` 段：`name = proto, host, port, k=v, ...` → 字段表。
    ///
    /// 只取 `[Proxy]` 与 `[Proxy Group]` 之间，避免把 `[General]` 的 `key = value` 行
    /// 也算成节点。
    fn surge_proxy_fields(body: &str) -> BTreeMap<String, BTreeMap<String, String>> {
        let proxy_section = body
            .split_once("[Proxy]\n")
            .map(|(_, rest)| rest)
            .and_then(|rest| rest.split_once("\n[Proxy Group]").map(|(proxy, _)| proxy))
            .unwrap_or_else(|| panic!("缺少 [Proxy] / [Proxy Group] 段：{body}"));
        let mut proxies = BTreeMap::new();
        for line in proxy_section.lines().filter(|line| !line.trim().is_empty()) {
            let (name, rest) = line
                .split_once(" = ")
                .unwrap_or_else(|| panic!("节点行格式不对：{line}"));
            let mut parts = rest.split(", ");
            let protocol = parts.next().unwrap_or_default();
            let server = parts.next().unwrap_or_default();
            let port = parts
                .next()
                .unwrap_or_else(|| panic!("节点行缺少端口：{line}"));
            let mut fields = BTreeMap::from([
                ("protocol".to_string(), protocol.to_string()),
                ("server".to_string(), server.to_string()),
                ("port".to_string(), port.to_string()),
            ]);
            for part in parts {
                let (key, value) = part
                    .split_once('=')
                    .unwrap_or_else(|| panic!("字段格式不对：{part}"));
                fields.insert(key.to_string(), value.to_string());
            }
            proxies.insert(name.to_string(), fields);
        }
        proxies
    }

    #[test]
    fn surge_full_has_all_four_sections_and_reuses_the_surge_body() {
        let nodes = full_config_nodes();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = SurgeFullExporter.render(&ctx).unwrap();
        let surge = SurgeExporter.render(&ctx).unwrap();

        assert!(body.starts_with("[General]\n"), "{body}");
        let positions: Vec<usize> = ["[General]\n", "[Proxy]\n", "[Proxy Group]\n", "[Rule]\n"]
            .iter()
            .map(|section| {
                body.find(section)
                    .unwrap_or_else(|| panic!("缺少段落 {section}：{body}"))
            })
            .collect();
        assert!(
            positions.windows(2).all(|pair| pair[0] < pair[1]),
            "段落顺序不对：{positions:?}"
        );

        assert!(body.contains("loglevel = notify"), "{body}");
        assert!(body.contains("dns-server = 223.5.5.5, 1.1.1.1"), "{body}");
        assert!(
            body.contains("proxy-test-url = http://www.gstatic.com/generate_204"),
            "{body}"
        );

        // 节点行、分组、规则与 ?target=surge 共用同一份正文，没有第二份映射。
        assert_eq!(
            body.strip_prefix(SURGE_GENERAL_SECTION).unwrap(),
            surge,
            "surge-full 的正文必须与 surge 逐字节一致"
        );
        let proxies = surge_proxy_fields(&body);
        assert_eq!(proxies.len(), nodes.len());
        assert!(
            body.contains("PROXY = select, AUTO, 香港, 日本, 美国, 其他, DIRECT"),
            "{body}"
        );
        assert!(
            body.contains("AUTO = url-test, 香港-REALITY, 日本-WS-TLS, 美国-VMess, 其他-SS"),
            "{body}"
        );
        assert!(body.contains("GEOIP,CN,DIRECT"), "{body}");
        assert_eq!(body.lines().last(), Some("FINAL,PROXY"));

        assert_eq!(SurgeFullExporter.id(), "surge-full");
        assert_eq!(
            SurgeFullExporter.content_type(),
            "text/plain; charset=utf-8"
        );
    }

    #[test]
    fn surge_full_single_node_keeps_four_sections_and_final() {
        let nodes = vec![fixtures().remove(0)];
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = SurgeFullExporter.render(&ctx).unwrap();

        let proxies = surge_proxy_fields(&body);
        assert_eq!(proxies.len(), 1);
        assert!(proxies.contains_key("香港-REALITY"));
        assert!(
            body.contains("PROXY = select, AUTO, 香港, DIRECT"),
            "{body}"
        );
        assert!(body.contains("[Proxy]\n香港-REALITY = vless, "), "{body}");
        assert_eq!(body.lines().last(), Some("FINAL,PROXY"));
    }

    /// 无节点也必须是能导入的最小 profile，而不是空文件。
    #[test]
    fn surge_full_without_nodes_is_still_an_importable_profile() {
        let nodes: Vec<SubNode> = Vec::new();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = SurgeFullExporter.render(&ctx).unwrap();

        for section in ["[General]", "[Proxy]", "[Proxy Group]", "[Rule]"] {
            assert!(body.contains(section), "缺少段落 {section}：{body}");
        }
        assert!(body.contains("[Proxy]\n\n[Proxy Group]"), "{body}");
        assert!(body.contains("PROXY = select, DIRECT"), "{body}");
        assert!(!body.contains("AUTO = url-test"), "{body}");
        assert!(body.contains("loglevel = notify"), "{body}");
        assert!(body.contains("GEOIP,CN,DIRECT"), "{body}");
        assert_eq!(body.lines().last(), Some("FINAL,PROXY"));
    }

    /// 与 clash 的 proxies 逐字段一致：server / port / password / uuid / sni。
    #[test]
    fn surge_full_matches_clash_field_by_field() {
        let nodes = full_config_nodes();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);

        let clash: serde_yaml::Value =
            serde_yaml::from_str(&ClashExporter.render(&ctx).unwrap()).unwrap();
        let body = SurgeFullExporter.render(&ctx).unwrap();
        let proxies = surge_proxy_fields(&body);

        for proxy in clash["proxies"].as_sequence().unwrap() {
            let name = proxy["name"].as_str().unwrap();
            let fields = proxies
                .get(name)
                .unwrap_or_else(|| panic!("surge-full 缺少节点 {name}：{proxies:?}"));
            assert_eq!(
                fields["server"],
                proxy["server"].as_str().unwrap(),
                "{name} 的 server 与 clash 不一致"
            );
            assert_eq!(
                fields["port"],
                proxy["port"].as_u64().unwrap().to_string(),
                "{name} 的 port 与 clash 不一致"
            );
            match proxy["type"].as_str().unwrap() {
                "vless" | "vmess" => assert_eq!(
                    fields["username"],
                    proxy["uuid"].as_str().unwrap(),
                    "{name} 的 uuid 与 clash 不一致"
                ),
                "trojan" | "ss" => assert_eq!(
                    fields["password"],
                    proxy["password"].as_str().unwrap(),
                    "{name} 的 password 与 clash 不一致"
                ),
                other => panic!("未覆盖的协议 {other}"),
            }
            if proxy["type"].as_str() == Some("ss") {
                assert_eq!(
                    fields["encrypt-method"],
                    proxy["cipher"].as_str().unwrap(),
                    "{name} 的 method 与 clash 不一致"
                );
            }
            let sni = proxy["servername"]
                .as_str()
                .or_else(|| proxy["sni"].as_str());
            if let Some(sni) = sni {
                assert_eq!(
                    fields.get("sni").map(String::as_str),
                    Some(sni),
                    "{name} 的 sni 与 clash 不一致"
                );
            }
        }
    }

    /// INI 的节点名转义：逗号会截断字段、等号会成为键值分隔，换行/制表会破行。
    /// 转义后节点名与组内引用必须逐字节一致。
    #[test]
    fn surge_full_escapes_ini_special_characters_in_node_names() {
        let names = [
            "香港, 01",
            "美国 = 主力",
            "日本\t制表",
            "美国\n换行",
            "带\"引号\"和: 井号#",
        ];
        let nodes: Vec<SubNode> = names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                node(
                    name,
                    "vless",
                    "tcp",
                    "tls",
                    443 + index as u16,
                    &[
                        ("uuid", "11111111-1111-4111-8111-111111111111"),
                        ("sni", "example.com"),
                    ],
                )
            })
            .collect();
        let rules = default_rules();
        let ctx = sub_context(&nodes, &rules);
        let body = SurgeFullExporter.render(&ctx).unwrap();

        let expected: Vec<String> = names.iter().map(|name| ini_name(name)).collect();
        let proxies = surge_proxy_fields(&body);
        assert_eq!(
            proxies.len(),
            names.len(),
            "特殊字符节点名把节点行截断了：{body}"
        );
        // 每个节点名都按 `ini_name` 的规则转义后出现在 `[Proxy]` 里。
        for name in &expected {
            assert!(proxies.contains_key(name), "缺少节点 {name}：{body}");
        }

        // 组内成员引用的是同一套转义后的名字。
        let auto_line = format!("AUTO = url-test, {}", expected.join(", "));
        assert!(body.contains(&auto_line), "{body}");
        assert!(body.contains("美国 ＝ 主力"), "{body}");
        assert!(body.contains("美国 换行"), "{body}");
        assert!(!body.contains("美国 = 主力"), "{body}");
    }

    // -----------------------------------------------------------------
    // 对外端口（public_port）：只改订阅展示，不改监听
    // -----------------------------------------------------------------

    /// 固定单节点：金标准输出要求它不随测试数据漂移。
    fn golden_nodes() -> Vec<SubNode> {
        vec![node(
            "golden-node",
            "vless",
            "ws",
            "tls",
            443,
            &[
                ("uuid", "11111111-1111-4111-8111-111111111111"),
                ("sni", "example.com"),
                ("path", "/ws"),
                ("host", "cdn.example.com"),
            ],
        )]
    }

    fn golden_subscription() -> String {
        let nodes = golden_nodes();
        let rules = vec!["MATCH,PROXY".to_string()];
        let ctx = sub_context(&nodes, &rules);
        let mut out = String::new();
        for exporter in exporters() {
            let body = exporter
                .render(&ctx)
                .unwrap_or_else(|error| panic!("{} 渲染失败：{error}", exporter.id()));
            out.push_str(&format!("=== {} ===\n{body}\n", exporter.id()));
        }
        out
    }

    /// 金标准：`public_port = NULL` 时所有导出格式必须与引入该字段前逐字节一致。
    #[test]
    fn public_port_null_is_byte_identical_to_the_golden_output() {
        const GOLDEN: &str = include_str!("../testdata/subscribe_golden_public_port_null.txt");
        assert_eq!(golden_subscription(), GOLDEN);
    }

    /// 每个导出格式都必须使用对外端口，而不是监听端口。
    #[test]
    fn public_port_overrides_the_port_in_every_exporter() {
        let mut nodes = golden_nodes();
        nodes[0].public_port = Some(40001);
        let rules = vec!["MATCH,PROXY".to_string()];
        let ctx = sub_context(&nodes, &rules);

        for exporter in exporters() {
            let id = exporter.id();
            let mut body = exporter
                .render(&ctx)
                .unwrap_or_else(|error| panic!("{id} 渲染失败：{error}"));
            // shadowrocket / v2ray 是 base64 包裹的 URI 列表，先解码再断言。
            if matches!(id, "shadowrocket" | "v2ray") {
                body = String::from_utf8(STANDARD.decode(body).unwrap()).unwrap();
            }
            assert!(
                body.contains("40001"),
                "{id} 必须输出对外端口 40001：{body}"
            );
            assert!(!body.contains("443"), "{id} 不应再输出监听端口 443：{body}");
        }
    }

    #[test]
    fn public_port_is_read_from_the_node_and_invalid_values_fall_back() {
        let raw = fragment_node(
            "public-1",
            "NAT-节点",
            "vless",
            "tcp",
            "none",
            443,
            json!({
                "settings": {"clients": [], "decryption": "none"},
                "stream": {"network": "tcp", "security": "none"}
            }),
        );
        let mut raw = raw;
        raw.public_port = Some(40001);
        let sub = SubNode::from_node(&raw, "203.0.113.10", "user-1", "secret").unwrap();
        assert_eq!(sub.port, 443, "监听端口保持原值");
        assert_eq!(sub.effective_port(), 40001);

        // NULL = 与监听端口相同。
        raw.public_port = None;
        let sub = SubNode::from_node(&raw, "203.0.113.10", "user-1", "secret").unwrap();
        assert_eq!(sub.effective_port(), 443);

        // 脏值回落到监听端口，而不是把节点从订阅里丢掉。
        for invalid in [0_i64, -1, 65_536] {
            raw.public_port = Some(invalid);
            let sub = SubNode::from_node(&raw, "203.0.113.10", "user-1", "secret")
                .expect("非法对外端口不能让节点从订阅里消失");
            assert_eq!(sub.effective_port(), 443, "非法值 {invalid} 应回落");
        }
    }

    fn fragment_node(
        id: &str,
        name: &str,
        protocol: &str,
        transport: &str,
        security: &str,
        port: i64,
        config: Value,
    ) -> Node {
        Node {
            id: id.into(),
            server_id: "server-1".into(),
            tag: format!("{protocol}-{id}"),
            name: name.into(),
            protocol: protocol.into(),
            transport: transport.into(),
            security: security.into(),
            port,
            public_port: None,
            config_json: config.to_string(),
            enabled: 1,
            created_at: 1,
            cert_id: None,
            bandwidth_kbps: None,
        }
    }
}
