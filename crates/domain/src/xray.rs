//! Xray 配置生成：纯函数，不依赖数据库与 HTTP，方便单元测试。
//!
//! 节点在库里只存「入站片段」（`config_json`），真正的完整配置由这里拼装。
//! 同样的输入必须得到同样的输出，且 `inbounds` 顺序严格等于传入节点顺序。

use serde_json::{json, Map, Value};

use crate::credentials;
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
}

impl Grant {
    /// 派生一个 (user, node) 子账户；同一个三元组永远得到同一份凭据。
    pub fn new(secret: &str, user_id: &str, node_id: &str) -> Self {
        Self {
            user_id: user_id.to_string(),
            node_id: node_id.to_string(),
            uuid: credentials::sub_uuid(secret, user_id, node_id),
        }
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

fn build_config_impl(plan: &ServerPlan, nodes: &[Node]) -> Value {
    let mut inbounds: Vec<Value> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| build_inbound(plan.server_name, index, node, plan.grants, plan.certs))
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
        "policy": {
            "system": {
                "statsInboundUplink": true,
                "statsInboundDownlink": true,
                "statsUserUplink": true,
                "statsUserDownlink": true
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

/// 校验节点能否生成 Xray 可接受的 inbound；不能时返回中文原因。
///
/// 只拦「一定会让 `xray -test` 失败」的硬错误。片段缺 `stream` / `settings`
/// 仍由 [`build_config`] 补默认值，不在这里判死。
pub fn node_problem(node: &Node) -> Option<String> {
    if !(1..=65_535).contains(&node.port) {
        return Some(format!("端口 {} 不合法（应为 1-65535）", node.port));
    }

    let fragment = parse_fragment(&node.config_json);
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

fn build_config_checked_impl(plan: &ServerPlan, require_tls_certs: bool) -> (Value, Vec<String>) {
    let mut usable = Vec::with_capacity(plan.nodes.len());
    let mut warnings = Vec::new();
    for node in plan.nodes {
        let problem = node_problem(node).or_else(|| {
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
) -> Value {
    let mut inbound = parse_fragment(&node.config_json);

    // tag/port/protocol 的唯一事实来源是数据库字段，片段里的旧值一律丢弃。
    inbound.remove("tag");
    inbound.remove("port");
    inbound.remove("protocol");

    if !matches!(inbound.get("settings"), Some(Value::Object(_))) {
        inbound.insert("settings".into(), default_settings(&node.protocol));
    }
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
    inject_clients(&mut inbound, node, &tag, grants);

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
fn inject_clients(inbound: &mut Map<String, Value>, node: &Node, tag: &str, grants: &[Grant]) {
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

    // Shadowsocks 非 2022 的多用户模式要求每个用户带自己的 method；2022 则必须留空。
    let ss_method = settings
        .get("method")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|method| !method.is_empty())
        .unwrap_or("aes-256-gcm")
        .to_string();
    let ss_per_user_method = !ss_method.to_ascii_lowercase().starts_with("2022-");

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
                client.insert("password".into(), Value::String(grant.uuid.clone()));
                if ss_per_user_method {
                    client.insert("method".into(), Value::String(ss_method.clone()));
                }
            }
            _ => unreachable!("上面已过滤协议白名单"),
        }
        client.insert(
            "email".into(),
            Value::String(credentials::sub_email(&grant.user_id, tag)),
        );
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
        "shadowsocks" => json!({ "method": "aes-256-gcm", "password": "" }),
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
        assert_eq!(system["statsUserUplink"], true);
        assert_eq!(system["statsUserDownlink"], true);
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
}
