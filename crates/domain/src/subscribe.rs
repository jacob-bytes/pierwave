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
use crate::models::Node;

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
    /// `tcp` / `ws` / `grpc` / `h2` / ...
    pub transport: String,
    /// `none` / `tls` / `reality`。
    pub security: String,
    /// 已命名的协议参数，见 `docs/SUBSCRIBE.md` §1。
    pub params: BTreeMap<String, String>,
}

impl SubNode {
    pub fn param(&self, key: &str) -> Option<&str> {
        self.params.get(key).map(String::as_str)
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
        let stream = fragment.get("stream").filter(|value| value.is_object());
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
                // 与 xray::default_settings 的兜底保持一致。
                let method = settings
                    .and_then(|settings| get_str(settings, "method"))
                    .unwrap_or("aes-256-gcm");
                params.insert("method".into(), method.to_string());
                params.insert("password".into(), uuid.clone());
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
                // 面板在片段里显式带 publicKey（Xray 会忽略这个多余字段），这里只做搬运。
                set(
                    &mut params,
                    "public_key",
                    get_str(reality, "publicKey").map(str::to_string),
                );
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
                    "reality 节点缺少 publicKey（入站片段只有 privateKey），订阅跳过该节点"
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

static EXPORTERS: &[&dyn Exporter] = &[&ClashExporter, &UriExporter];

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

/// `?target=` → UA 嗅探 → 回落 clash。
///
/// 还没实现的格式（surge / sing-box）先回落到 clash：宁可给一份能看的配置，
/// 也不要 4xx 把用户挡在门外。
pub fn select_exporter(target: Option<&str>, user_agent: Option<&str>) -> &'static dyn Exporter {
    if let Some(exporter) = target.and_then(find_exporter) {
        return exporter;
    }
    if let Some(user_agent) = user_agent {
        let user_agent = user_agent.to_ascii_lowercase();
        if user_agent.contains("shadowrocket") || user_agent.contains("v2rayng") {
            if let Some(exporter) = find_exporter("uri") {
                return exporter;
            }
        }
    }
    find_exporter("clash").expect("clash 渲染器必须注册")
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

        out.push_str("proxies:");
        if ctx.nodes.is_empty() {
            out.push_str(" []\n");
        } else {
            out.push('\n');
            for node in ctx.nodes {
                out.push_str(&clash_proxy(node));
            }
        }
        out.push('\n');

        out.push_str(&clash_groups(ctx.nodes));
        out.push_str("\nrules:\n  - \"GEOIP,CN,DIRECT\"\n  - \"MATCH,PROXY\"\n");
        Ok(out)
    }
}

fn clash_proxy(node: &SubNode) -> String {
    let mut out = String::new();
    out.push_str(&format!("  - name: {}\n", yaml_string(&node.name)));
    out.push_str(&format!("    type: {}\n", node.protocol));
    out.push_str(&format!("    server: {}\n", yaml_string(&node.server)));
    out.push_str(&format!("    port: {}\n", node.port));

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
                yaml_string(node.param("method").unwrap_or("aes-256-gcm"))
            ));
            out.push_str(&format!(
                "    password: {}\n",
                yaml_string(node.param("password").unwrap_or_default())
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
        node.port,
        query.finish(),
        percent_encode(&node.name)
    )
}

fn render_vmess(node: &SubNode) -> String {
    let mut payload = json!({
        "v": "2",
        "ps": node.name,
        "add": node.server,
        "port": node.port.to_string(),
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
        node.port,
        query.finish(),
        percent_encode(&node.name)
    )
}

fn render_ss(node: &SubNode) -> String {
    let method = node.param("method").unwrap_or("aes-256-gcm");
    let password = node.param("password").unwrap_or_default();
    let userinfo = URL_SAFE_NO_PAD.encode(format!("{method}:{password}"));
    format!(
        "ss://{userinfo}@{}:{}#{}",
        uri_host(&node.server),
        node.port,
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
        let ctx = SubContext {
            nodes: &nodes,
            user_label: "alice",
            traffic: None,
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
        let ctx = SubContext {
            nodes: &nodes,
            user_label: "alice",
            traffic: None,
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
    fn uri_export_has_one_line_per_node_with_right_scheme() {
        let nodes = fixtures();
        let ctx = SubContext {
            nodes: &nodes,
            user_label: "alice",
            traffic: None,
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
        let ctx = SubContext {
            nodes: &nodes,
            user_label: "alice",
            traffic: None,
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
        assert_eq!(select_exporter(Some("uri"), Some("clash")).id(), "uri");
        assert_eq!(
            select_exporter(None, Some("Shadowrocket/2.2.0")).id(),
            "uri"
        );
        assert_eq!(
            select_exporter(None, Some("clash-verge/1.5 mihomo")).id(),
            "clash"
        );
        assert_eq!(select_exporter(None, None).id(), "clash");
        assert_eq!(select_exporter(Some("singbox"), None).id(), "clash");
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
            config_json: config.to_string(),
            enabled: 1,
            created_at: 1,
        }
    }
}
