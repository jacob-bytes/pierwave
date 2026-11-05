//! Xray 配置生成：纯函数，不依赖数据库与 HTTP，方便单元测试。
//!
//! 节点在库里只存「入站片段」（`config_json`），真正的完整配置由这里拼装。
//! 同样的输入必须得到同样的输出，且 `inbounds` 顺序严格等于传入节点顺序。

use serde_json::{json, Map, Value};

use crate::models::Node;

/// 生成可直接落盘的完整 Xray 配置。
///
/// * `server_name` 只在节点没有显式 tag 时用于生成兜底 tag；
/// * 每个节点的 `config_json` 是「入站对象去掉 tag/port/protocol」的片段。
///   片段里即便混入这三个字段也会被节点自身字段覆盖，避免双写不一致；
/// * 片段缺 `settings` / `stream` 时按协议补安全默认值；
/// * 只生成调用方传入的节点，是否过滤 disabled 由调用方决定。
pub fn build_config(server_name: &str, nodes: &[Node]) -> Value {
    let inbounds: Vec<Value> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| build_inbound(server_name, index, node))
        .collect();

    json!({
        "log": {
            "loglevel": "warning"
        },
        "inbounds": inbounds,
        "outbounds": [
            {
                "tag": "direct",
                "protocol": "freedom",
                "settings": {}
            },
            {
                "tag": "blocked",
                "protocol": "blackhole",
                "settings": {}
            }
        ],
        "routing": {
            "domainStrategy": "AsIs",
            "rules": []
        }
    })
}

fn build_inbound(server_name: &str, index: usize, node: &Node) -> Value {
    let mut inbound = parse_fragment(&node.config_json);

    // tag/port/protocol 的唯一事实来源是数据库字段，片段里的旧值一律丢弃。
    inbound.remove("tag");
    inbound.remove("port");
    inbound.remove("protocol");

    if !matches!(inbound.get("settings"), Some(Value::Object(_))) {
        inbound.insert("settings".into(), default_settings(&node.protocol));
    }
    if !matches!(inbound.get("stream"), Some(Value::Object(_))) {
        inbound.insert("stream".into(), default_stream(node));
    }

    inbound.insert(
        "tag".into(),
        Value::String(effective_tag(server_name, index, node)),
    );
    inbound.insert("port".into(), Value::from(node.port));
    inbound.insert(
        "protocol".into(),
        Value::String(node.protocol.trim().to_ascii_lowercase()),
    );

    Value::Object(inbound)
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
        }
    }

    #[test]
    fn empty_server_still_gets_a_valid_skeleton() {
        let config = build_config("hk-1", &[]);

        assert_eq!(config["log"]["loglevel"], "warning");
        assert_eq!(config["inbounds"], json!([]));
        assert_eq!(config["outbounds"][0]["tag"], "direct");
        assert_eq!(config["outbounds"][0]["protocol"], "freedom");
        assert_eq!(config["outbounds"][1]["tag"], "blocked");
        assert_eq!(config["outbounds"][1]["protocol"], "blackhole");
        assert_eq!(config["routing"]["domainStrategy"], "AsIs");
        assert_eq!(config["routing"]["rules"], json!([]));
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

        let config = build_config("hk-1", &[n]);
        let inbound = &config["inbounds"][0];

        assert_eq!(config["inbounds"].as_array().unwrap().len(), 1);
        assert_eq!(inbound["tag"], "vless-reality");
        assert_eq!(inbound["port"], 443);
        assert_eq!(inbound["protocol"], "vless");
        assert_eq!(inbound["settings"]["decryption"], "none");
        assert_eq!(
            inbound["stream"]["realitySettings"]["serverNames"][0],
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

        let config = build_config("hk-1", &[vless, trojan]);
        let inbounds = config["inbounds"].as_array().unwrap();

        assert_eq!(inbounds.len(), 2);
        assert_eq!(inbounds[0]["tag"], "vless-default");
        assert_eq!(inbounds[1]["tag"], "trojan-default");
        // vless 片段只给了 stream，settings 应补默认值
        assert_eq!(inbounds[0]["settings"]["decryption"], "none");
        assert_eq!(inbounds[0]["settings"]["clients"], json!([]));
        // trojan 片段全空，settings/stream 都应补默认值
        assert_eq!(inbounds[1]["settings"]["clients"], json!([]));
        assert_eq!(inbounds[1]["stream"]["network"], "tcp");
        assert_eq!(inbounds[1]["stream"]["security"], "tls");
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

        let config = build_config("hk-1", &[n]);
        let inbound = &config["inbounds"][0];

        assert_eq!(inbound["tag"], "authoritative-tag");
        assert_eq!(inbound["port"], 8443);
        assert_eq!(inbound["protocol"], "vless");
    }

    #[test]
    fn invalid_fragment_falls_back_to_defaults() {
        let n = node("broken", "vless", "tcp", "none", 443, "not-json");

        let config = build_config("hk-1", &[n]);
        let inbound = &config["inbounds"][0];

        assert_eq!(inbound["settings"]["decryption"], "none");
        assert_eq!(inbound["stream"]["network"], "tcp");
        assert_eq!(inbound["stream"]["security"], "none");
    }

    #[test]
    fn empty_tag_gets_a_deterministic_fallback() {
        let n = node("", "vless", "tcp", "none", 443, "{}");
        let nodes = [n];

        let first = build_config("HK 1", &nodes);
        let second = build_config("HK 1", &nodes);

        assert_eq!(first["inbounds"][0]["tag"], "hk-1-443-0");
        assert_eq!(first, second);
        assert_eq!(
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&second).unwrap()
        );
    }
}
