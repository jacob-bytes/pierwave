//! 出站与路由规则的业务规则（纯函数）。
//!
//! 这里只管「什么值能被写进配置 / 数据库」，不碰 SQL、HTTP 与时钟；
//! 引用完整性（该服务器下 tag 是否存在、被几条规则引用）由 master 调仓储判断。
//!
//! 为什么需要这些约束：
//! * 出站 tag 会直接进 Xray 配置，格式必须可预测，且不能占用内置的
//!   `direct` / `blocked` / `api`；
//! * 路由规则三个匹配条件全空等于「匹配所有流量」，会吞掉整台服务器的流量；
//! * `domain` / `ip` 在库里是逗号分隔串，而 Xray 只认数组，转换统一放这里。

use serde_json::{json, Map, Value};

use crate::error::DomainError;
use crate::models::RoutingRule;

/// 允许的出站协议白名单（见 `docs/PLAN.md` P3）。
pub const OUTBOUND_PROTOCOLS: &[&str] = &[
    "socks",
    "http",
    "vmess",
    "vless",
    "trojan",
    "shadowsocks",
    "freedom",
    "blackhole",
];

/// 内置出站与 API 出站占用的 tag；自定义出站不能复用。
pub const RESERVED_TAGS: &[&str] = &["direct", "blocked", "api"];

/// tag 的最大长度（按字符数算）。
pub const MAX_TAG_CHARS: usize = 32;

/// 校验并返回规范化的出站 tag。
///
/// 规则：`^[a-z0-9_-]{1,32}$`，且不能是保留字。大小写不做自动转换——
/// tag 是 Xray 配置里的稳定标识，静默改写会让用户看到的和实际配置不一致。
pub fn normalize_tag(raw: &str) -> Result<String, DomainError> {
    let tag = raw.trim();
    if tag.is_empty() {
        return Err(DomainError::with_params(
            "outbound.tag_invalid",
            json!({ "tag": tag }),
            "出站 tag 不能为空",
        ));
    }
    if tag.chars().count() > MAX_TAG_CHARS {
        return Err(DomainError::with_params(
            "outbound.tag_invalid",
            json!({ "tag": tag, "max": MAX_TAG_CHARS }),
            format!("出站 tag 最多 {MAX_TAG_CHARS} 个字符"),
        ));
    }
    if !tag
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(DomainError::with_params(
            "outbound.tag_invalid",
            json!({ "tag": tag }),
            "出站 tag 只能包含小写字母、数字、- 和 _",
        ));
    }
    if RESERVED_TAGS.contains(&tag) {
        return Err(DomainError::with_params(
            "outbound.tag_reserved",
            json!({ "tag": tag }),
            format!("tag「{tag}」是保留字，请换一个"),
        ));
    }
    Ok(tag.to_string())
}

/// 校验协议并返回小写规范值。
pub fn normalize_protocol(raw: &str) -> Result<String, DomainError> {
    let protocol = raw.trim().to_ascii_lowercase();
    if OUTBOUND_PROTOCOLS.contains(&protocol.as_str()) {
        Ok(protocol)
    } else {
        Err(DomainError::with_params(
            "outbound.protocol_invalid",
            json!({ "protocol": protocol }),
            format!(
                "不支持的出站协议：{protocol}（可选：{}）",
                OUTBOUND_PROTOCOLS.join(" / ")
            ),
        ))
    }
}

/// 出站 `config` 必须是 JSON 对象，否则无法与 tag/protocol 合并成出站对象。
pub fn ensure_config_object(config: &Value) -> Result<(), DomainError> {
    if config.is_object() {
        Ok(())
    } else {
        Err(DomainError::new(
            "outbound.config_invalid",
            "config 必须是 JSON 对象",
        ))
    }
}

/// 把可空的匹配条件规范成「去空白后的非空值」；空串等同于没填。
pub fn normalize_condition(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 路由规则至少要有入站 / 域名 / IP 中的一个匹配条件。
pub fn validate_rule_match(
    inbound_tag: Option<&str>,
    domain: Option<&str>,
    ip: Option<&str>,
) -> Result<(), DomainError> {
    let present = [inbound_tag, domain, ip]
        .into_iter()
        .flatten()
        .any(|value| !value.trim().is_empty());
    if present {
        Ok(())
    } else {
        Err(DomainError::new(
            "routing_rule.match_required",
            "路由规则至少要填写入站、域名、IP 中的一项，否则会吞掉所有流量",
        ))
    }
}

/// 把逗号分隔的 Xray 匹配串拆成数组（去空白、去重、保持顺序）。
///
/// Xray 的 `domain` / `ip` 字段只接受字符串数组；库里为了编辑方便存成
/// 逗号分隔文本。空串返回空数组，调用方据此决定是否带这个字段。
pub fn split_match_list(raw: &str) -> Vec<String> {
    let mut values = Vec::new();
    for part in raw.split(',') {
        let part = part.trim();
        if !part.is_empty() && !values.iter().any(|existing| existing == part) {
            values.push(part.to_string());
        }
    }
    values
}

/// 生成一条 Xray routing rule：`{"type":"field", ...}`，只带非空字段。
///
/// `inboundTag` 固定为数组（Xray 的口径）；`domain` / `ip` 由逗号串拆成数组。
pub fn rule_value(rule: &RoutingRule) -> Value {
    let mut value = Map::new();
    value.insert("type".into(), json!("field"));

    if let Some(inbound_tag) = normalize_condition(rule.inbound_tag.as_deref()) {
        value.insert("inboundTag".into(), json!([inbound_tag]));
    }
    if let Some(domain) = normalize_condition(rule.domain.as_deref()) {
        value.insert("domain".into(), json!(split_match_list(&domain)));
    }
    if let Some(ip) = normalize_condition(rule.ip.as_deref()) {
        value.insert("ip".into(), json!(split_match_list(&ip)));
    }
    value.insert(
        "outboundTag".into(),
        json!(rule.outbound_tag.trim().to_string()),
    );

    Value::Object(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(inbound_tag: Option<&str>, domain: Option<&str>, ip: Option<&str>) -> RoutingRule {
        RoutingRule {
            id: "rule-1".into(),
            server_id: "server-1".into(),
            sort_order: 0,
            inbound_tag: inbound_tag.map(str::to_string),
            domain: domain.map(str::to_string),
            ip: ip.map(str::to_string),
            outbound_tag: "proxy".into(),
            enabled: 1,
            created_at: 1,
        }
    }

    #[test]
    fn tag_accepts_lowercase_and_rejects_bad_values() {
        assert_eq!(normalize_tag(" relay_1 ").unwrap(), "relay_1");
        for bad in ["", "Relay", "relay.1", "relay 1", "直连"] {
            let error = normalize_tag(bad).unwrap_err();
            assert_eq!(error.code, "outbound.tag_invalid", "bad={bad:?}");
            assert_eq!(error.params["tag"], bad.trim());
        }
        let too_long = normalize_tag(&"a".repeat(MAX_TAG_CHARS + 1)).unwrap_err();
        assert_eq!(too_long.code, "outbound.tag_invalid");
        assert_eq!(too_long.params["max"], json!(MAX_TAG_CHARS));
        assert!(normalize_tag(&"a".repeat(MAX_TAG_CHARS)).is_ok());
    }

    #[test]
    fn reserved_tags_are_rejected() {
        for tag in RESERVED_TAGS {
            let error = normalize_tag(tag).unwrap_err();
            assert_eq!(error.code, "outbound.tag_reserved");
            assert_eq!(error.params, json!({ "tag": tag }));
            assert!(error.message.contains("保留字"), "unexpected: {error}");
        }
    }

    #[test]
    fn protocol_is_normalized_and_whitelisted() {
        assert_eq!(normalize_protocol(" SOCKS ").unwrap(), "socks");
        assert_eq!(normalize_protocol("shadowsocks").unwrap(), "shadowsocks");
        let error = normalize_protocol("wireguard").unwrap_err();
        assert_eq!(error.code, "outbound.protocol_invalid");
        assert_eq!(error.params, json!({ "protocol": "wireguard" }));
        assert!(error.message.contains("不支持"), "unexpected: {error}");
    }

    #[test]
    fn config_must_be_a_json_object() {
        assert!(ensure_config_object(&json!({})).is_ok());
        let error = ensure_config_object(&json!([])).unwrap_err();
        assert_eq!(error.code, "outbound.config_invalid");
        assert_eq!(error.message, "config 必须是 JSON 对象");
    }

    #[test]
    fn rule_requires_at_least_one_match_condition() {
        let error = validate_rule_match(None, None, None).unwrap_err();
        assert_eq!(error.code, "routing_rule.match_required");
        assert_eq!(
            error.message,
            "路由规则至少要填写入站、域名、IP 中的一项，否则会吞掉所有流量"
        );
        // 纯空白等同没填。
        assert!(validate_rule_match(Some("  "), Some(""), None).is_err());
        assert!(validate_rule_match(Some("hk-1"), None, None).is_ok());
        assert!(validate_rule_match(None, Some("geosite:cn"), None).is_ok());
        assert!(validate_rule_match(None, None, Some("10.0.0.0/8")).is_ok());
    }

    #[test]
    fn match_list_splits_trims_and_dedupes() {
        assert_eq!(
            split_match_list(" geosite:cn, domain:example.com ,, geosite:cn "),
            vec!["geosite:cn", "domain:example.com"]
        );
        assert!(split_match_list("   ").is_empty());
    }

    #[test]
    fn rule_value_only_carries_non_empty_fields() {
        let value = rule_value(&rule(
            Some("hk-1"),
            Some("geosite:cn,domain:example.com"),
            None,
        ));
        assert_eq!(value["type"], "field");
        assert_eq!(value["inboundTag"], json!(["hk-1"]));
        assert_eq!(value["domain"], json!(["geosite:cn", "domain:example.com"]));
        assert!(value.get("ip").is_none(), "没填 IP 不应出现空数组");
        assert_eq!(value["outboundTag"], "proxy");

        let by_ip = rule_value(&rule(None, None, Some("10.0.0.0/8")));
        assert!(by_ip.get("inboundTag").is_none());
        assert_eq!(by_ip["ip"], json!(["10.0.0.0/8"]));
    }
}
