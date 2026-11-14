//! 转发协议模式（`tcp` / `udp` / `both`）的取值校验与引擎约束。
//!
//! 旧的布尔列 `forwards.udp` / `chains.udp` 只作为迁移来源保留；读写路径
//! 一律以 `protocol` 为准。这里只做「不查库」的字符串校验：
//!
//! * [`normalize_forward`] / [`normalize_chain`]：写路径严格校验，错误码分别是
//!   `forward.protocol_invalid` / `chain.protocol_invalid`；
//! * [`ensure_realm_supported`]：realm 固定双开，不接受「仅 UDP」；
//! * [`ensure_tls_compatible`]：加密链只走 TCP，不接受「仅 UDP」。
//!
//! 读路径用 [`from_db`] 兜底：非法值回落 `tcp`，保证一条脏数据不会让整份
//! 期望态下发失败。

use serde_json::json;

use crate::engine;
use crate::error::DomainError;

/// 只监听 TCP（默认）。
pub const TCP: &str = "tcp";
/// 只监听 UDP。
pub const UDP: &str = "udp";
/// 同一端口号上 TCP 与 UDP 都监听。
pub const BOTH: &str = "both";

/// 合法的协议名，错误提示里按顺序展示。
pub const NAMES: [&str; 3] = [TCP, UDP, BOTH];

/// 「仅 UDP」需要的最低 Agent 线协议版本。
///
/// `protocol = udp` 从协议 16（v0.8.0）开始支持；旧 Agent 会忽略该字段，
/// 按旧的 `udp` 镜像位只监听 TCP，导致静默失效。与
/// `pierwave_proto::UDP_PROTOCOL_VERSION` 必须保持一致（master 有断言测试）。
pub const UDP_MIN_PROTOCOL_VERSION: i64 = 16;

/// 新建转发/链时没填 `protocol` 的默认值。
pub const DEFAULT: &str = TCP;

/// 旧 `udp` 布尔列到协议模式的映射：`true` = 两种协议都开，`false` = 只开 TCP。
///
/// 这正是迁移 `0034` 的 `CASE WHEN udp = 1 THEN 'both' ELSE 'tcp' END`。
pub fn from_legacy_udp(udp: bool) -> &'static str {
    if udp {
        BOTH
    } else {
        TCP
    }
}

fn normalize(raw: &str, code: &'static str, label: &str) -> Result<String, DomainError> {
    let protocol = raw.trim();
    match protocol {
        TCP => Ok(TCP.to_string()),
        UDP => Ok(UDP.to_string()),
        BOTH => Ok(BOTH.to_string()),
        other => Err(DomainError::with_params(
            code,
            json!({ "protocol": other, "allowed": NAMES }),
            format!("{label}「{other}」无效，只支持 {}", NAMES.join(" / ")),
        )),
    }
}

/// 单跳转发的协议校验，错误码 `forward.protocol_invalid`。
///
/// 故意不忽略大小写：`UDP` 会被当成非法值，避免写进库后再被读路径悄悄回落。
pub fn normalize_forward(raw: &str) -> Result<String, DomainError> {
    normalize(raw, "forward.protocol_invalid", "转发协议")
}

/// 链的协议校验，错误码 `chain.protocol_invalid`。
pub fn normalize_chain(raw: &str) -> Result<String, DomainError> {
    normalize(raw, "chain.protocol_invalid", "链的转发协议")
}

/// 从数据库读出的协议：非法值/空串回落 `tcp`。
///
/// 写路径已经校验过，这里兜底的是历史数据/手工改库；读路径不能让一个脏值
/// 把整份期望态下发搞失败。回落 TCP 也最保守：不会凭空多开 UDP 端口。
pub fn from_db(raw: &str) -> &'static str {
    match raw.trim() {
        UDP => UDP,
        BOTH => BOTH,
        _ => TCP,
    }
}

/// 是否会监听 TCP。
pub fn allows_tcp(raw: &str) -> bool {
    matches!(from_db(raw), TCP | BOTH)
}

/// 是否会监听 UDP。
pub fn allows_udp(raw: &str) -> bool {
    matches!(from_db(raw), UDP | BOTH)
}

/// 是否只监听 UDP。realm / TLS 的拒绝条件都以它为准。
pub fn is_udp_only(raw: &str) -> bool {
    from_db(raw) == UDP
}

/// 是否同端口双开。旧的 `udp` 布尔列只是「是否**额外**开 UDP」，
/// 因此只有 `both` 能映射成 `true`；`udp` 模式不能把旧位写成 true
/// （旧 Agent 收到 `udp = true` 会同时绑 TCP）。
pub fn is_both(raw: &str) -> bool {
    from_db(raw) == BOTH
}

/// realm 固定双开（`no_tcp = false` + `use_udp = true`），没有「仅 UDP」的配置形态。
///
/// 错误码固定为 `forward.protocol_udp_requires_native`：转发与链共用同一个
/// 错误码，前端只需要翻译一条文案；具体是哪条规则由 `params.feature` 区分。
pub fn ensure_realm_supported(protocol: &str, engine_name: &str) -> Result<(), DomainError> {
    if !engine::is_realm(engine_name) || !is_udp_only(protocol) {
        return Ok(());
    }
    Err(DomainError::with_params(
        "forward.protocol_udp_requires_native",
        json!({ "protocol": UDP, "engine": engine::REALM, "feature": "realm" }),
        "realm 引擎固定同时转发 TCP 与 UDP，不支持仅 UDP；请改用 native 或 nftables 引擎",
    ))
}

/// 加密链只走 TCP：UDP 不经过 realm 的 transport，只开 UDP 没有任何意义。
///
/// 错误码 `chain.protocol_udp_with_tls`。`both` 由既有的
/// `chain.tls_udp_unsupported` 拦截（那一条包含 UDP 的明文穿透风险）。
pub fn ensure_tls_compatible(protocol: &str, transport: &str) -> Result<(), DomainError> {
    if !crate::hop_transport::is_tls(transport) || !is_udp_only(protocol) {
        return Ok(());
    }
    Err(DomainError::with_params(
        "chain.protocol_udp_with_tls",
        json!({ "protocol": UDP, "transport": crate::hop_transport::TLS }),
        "加密链只走 TCP，不能选择仅 UDP",
    ))
}

/// 该协议版本是否理解 `protocol = udp`。
///
/// `None`（旧 Agent 未上报 / 从未连过）一律按不支持处理；`tcp` / `both`
/// 不调用这个判断，旧 Agent 能正确理解它们。
pub fn agent_supports_udp(version: Option<i64>) -> bool {
    version.is_some_and(|version| version >= UDP_MIN_PROTOCOL_VERSION)
}

/// 单跳转发保存前的「仅 UDP」能力门禁，错误码
/// `forward.protocol_requires_agent_upgrade`。
///
/// 只在 `protocol = udp` 时生效；`tcp` / `both` 对旧 Agent 完全不变。
pub fn ensure_forward_agent_supported(
    protocol: &str,
    version: Option<i64>,
    server: &str,
) -> Result<(), DomainError> {
    if !is_udp_only(protocol) || agent_supports_udp(version) {
        return Ok(());
    }
    let current = version.filter(|version| *version > 0).unwrap_or(0);
    Err(DomainError::with_params(
        "forward.protocol_requires_agent_upgrade",
        json!({
            "server": server,
            "required": UDP_MIN_PROTOCOL_VERSION,
            "protocol": UDP,
            "version": current,
        }),
        format!(
            "服务器「{server}」的 Agent 版本过旧（协议版本 {current}，需要 ≥ {UDP_MIN_PROTOCOL_VERSION}），仅 UDP 转发需要先升级 Agent / server \"{server}\" runs an agent that is too old for UDP-only forwarding (protocol {current}, requires >= {UDP_MIN_PROTOCOL_VERSION}); upgrade the agent first"
        ),
    ))
}

/// 链保存前的「仅 UDP」能力门禁，错误码
/// `chain.protocol_requires_agent_upgrade`。
///
/// 链的每一跳都要自己监听，所以**任意**成员版本过低都会拒绝整条链。
/// `servers` 由调用方从成员服务器读出来，未知（NULL）按不支持处理。
pub fn ensure_chain_agent_supported(
    protocol: &str,
    servers: &[(&str, Option<i64>)],
) -> Result<(), DomainError> {
    if !is_udp_only(protocol) {
        return Ok(());
    }
    let mut stale: Vec<&str> = Vec::new();
    for (name, version) in servers {
        if !agent_supports_udp(*version) && !stale.contains(name) {
            stale.push(name);
        }
    }
    if stale.is_empty() {
        return Ok(());
    }
    Err(DomainError::with_params(
        "chain.protocol_requires_agent_upgrade",
        json!({
            "server": stale.join("、"),
            "servers": stale,
            "required": UDP_MIN_PROTOCOL_VERSION,
            "protocol": UDP,
        }),
        format!(
            "以下服务器的 Agent 版本过旧（需要协议版本 ≥ {UDP_MIN_PROTOCOL_VERSION}），无法使用仅 UDP 链：{} / the following servers run agents too old for a UDP-only chain (protocol >= {UDP_MIN_PROTOCOL_VERSION} required): {}",
            stale.join("、"),
            stale.join(", ")
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_only_three_protocols() {
        for (raw, expected) in [(TCP, TCP), (UDP, UDP), (BOTH, BOTH)] {
            assert_eq!(normalize_forward(raw).unwrap(), expected);
            assert_eq!(normalize_chain(raw).unwrap(), expected);
        }
        assert_eq!(normalize_forward("  udp ").unwrap(), UDP, "允许首尾空白");
        assert_eq!(DEFAULT, TCP, "默认只监听 TCP");
    }

    #[test]
    fn rejects_unknown_protocols_with_scope_specific_codes() {
        for bad in ["", "TCP", "Udp", "tcp/udp", "all", "wireguard"] {
            let forward = normalize_forward(bad).unwrap_err();
            assert_eq!(forward.code, "forward.protocol_invalid", "bad={bad:?}");
            assert_eq!(forward.params["protocol"], bad);
            assert_eq!(forward.params["allowed"], json!([TCP, UDP, BOTH]));
            assert!(forward.message.contains("只支持 tcp / udp / both"));

            let chain = normalize_chain(bad).unwrap_err();
            assert_eq!(chain.code, "chain.protocol_invalid", "bad={bad:?}");
            assert_eq!(chain.params["protocol"], bad);
        }
    }

    #[test]
    fn database_values_fall_back_to_tcp() {
        assert_eq!(from_db("udp"), UDP);
        assert_eq!(from_db(" both "), BOTH);
        assert_eq!(from_db("garbage"), TCP);
        assert_eq!(from_db(""), TCP);
        assert_eq!(from_db("UDP"), TCP, "大小写不匹配也回落 tcp");
    }

    #[test]
    fn legacy_udp_maps_to_tcp_or_both() {
        assert_eq!(from_legacy_udp(false), TCP);
        assert_eq!(from_legacy_udp(true), BOTH);
        assert!(!allows_udp(from_legacy_udp(false)));
        assert!(allows_udp(from_legacy_udp(true)));
        assert!(allows_tcp(from_legacy_udp(true)));
    }

    #[test]
    fn protocol_capabilities_are_exclusive() {
        assert!(allows_tcp(TCP) && !allows_udp(TCP));
        assert!(!allows_tcp(UDP) && allows_udp(UDP));
        assert!(allows_tcp(BOTH) && allows_udp(BOTH));
        for (value, tcp, udp) in [(TCP, true, false), (UDP, false, true), (BOTH, true, true)] {
            assert_eq!(allows_tcp(value), tcp, "{value}");
            assert_eq!(allows_udp(value), udp, "{value}");
            assert_eq!(is_udp_only(value), udp && !tcp, "{value}");
        }
    }

    #[test]
    fn realm_rejects_udp_only() {
        let error = ensure_realm_supported(UDP, engine::REALM).unwrap_err();
        assert_eq!(error.code, "forward.protocol_udp_requires_native");
        assert_eq!(error.params["engine"], "realm");
        assert_eq!(error.params["protocol"], "udp");
        assert!(error.message.contains("仅 UDP"), "{}", error.message);

        // tcp / both 与 realm 兼容；非 realm 引擎不触发这条约束。
        assert!(ensure_realm_supported(TCP, engine::REALM).is_ok());
        assert!(ensure_realm_supported(BOTH, engine::REALM).is_ok());
        assert!(ensure_realm_supported(UDP, engine::NATIVE).is_ok());
        assert!(ensure_realm_supported(UDP, engine::NFTABLES).is_ok());
    }

    #[test]
    fn encrypted_chains_reject_udp_only() {
        let error = ensure_tls_compatible(UDP, crate::hop_transport::TLS).unwrap_err();
        assert_eq!(error.code, "chain.protocol_udp_with_tls");
        assert_eq!(error.params["transport"], "tls");
        assert!(error.message.contains("只走 TCP"), "{}", error.message);

        assert!(ensure_tls_compatible(TCP, crate::hop_transport::TLS).is_ok());
        assert!(
            ensure_tls_compatible(BOTH, crate::hop_transport::TLS).is_ok(),
            "both 交给既有的 chain.tls_udp_unsupported 拦截"
        );
        assert!(ensure_tls_compatible(UDP, crate::hop_transport::NONE).is_ok());
    }

    #[test]
    fn udp_only_requires_agent_protocol_16() {
        assert_eq!(UDP_MIN_PROTOCOL_VERSION, 16);
        assert!(!agent_supports_udp(None), "未知版本必须按不支持处理");
        assert!(!agent_supports_udp(Some(0)), "0 = 旧 Agent");
        assert!(!agent_supports_udp(Some(15)), "15 是旧 Agent");
        assert!(agent_supports_udp(Some(16)), "16 起支持仅 UDP");
        assert!(agent_supports_udp(Some(22)));

        let error =
            ensure_forward_agent_supported(UDP, None, "hk-1").expect_err("未知版本必须拒绝");
        assert_eq!(error.code, "forward.protocol_requires_agent_upgrade");
        assert_eq!(error.params["server"], "hk-1");
        assert_eq!(error.params["required"], 16);
        assert_eq!(error.params["version"], 0);
        assert_eq!(error.params["protocol"], "udp");
        assert!(error.message.contains("升级 Agent"), "{}", error.message);

        let error = ensure_forward_agent_supported(UDP, Some(15), "hk-1").expect_err("15 必须拒绝");
        assert_eq!(error.params["version"], 15);

        assert!(ensure_forward_agent_supported(UDP, Some(16), "hk-1").is_ok());
        assert!(ensure_forward_agent_supported(UDP, Some(22), "hk-1").is_ok());
        // tcp / both 旧 Agent 能正确理解，任何时候都放行。
        for protocol in [TCP, BOTH] {
            for version in [None, Some(0), Some(15), Some(16)] {
                assert!(
                    ensure_forward_agent_supported(protocol, version, "hk-1").is_ok(),
                    "{protocol} / {version:?}"
                );
            }
        }
    }

    #[test]
    fn udp_only_chain_requires_every_member_on_protocol_16() {
        let servers = [("hk-a", Some(22)), ("jp-b", Some(16))];
        assert!(ensure_chain_agent_supported(UDP, &servers).is_ok());
        assert!(ensure_chain_agent_supported(TCP, &[("hk-a", None)]).is_ok());
        assert!(ensure_chain_agent_supported(BOTH, &[("hk-a", Some(15))]).is_ok());

        let error = ensure_chain_agent_supported(
            UDP,
            &[("hk-a", Some(22)), ("jp-b", Some(15)), ("sg-c", None)],
        )
        .expect_err("任意成员过旧都要拒绝整条链");
        assert_eq!(error.code, "chain.protocol_requires_agent_upgrade");
        assert_eq!(error.params["servers"], json!(["jp-b", "sg-c"]));
        assert_eq!(error.params["server"], "jp-b、sg-c");
        assert_eq!(error.params["required"], 16);
        assert!(
            error.message.contains("Agent 版本过旧"),
            "{}",
            error.message
        );
    }
}
