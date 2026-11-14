//! 服务器网卡（`nic_name`）的校验与地址解析。
//!
//! 规则只有一份，创建/更新校验、期望态注入与前端提示都从这里取：
//!
//! * Agent 最近上报过网卡（含报告空列表）→ `nic_name` 必须命中，否则 400；
//! * 从未上报（新服务器 / 离线 / 旧 Agent）→ 允许保存，但响应标
//!   `nic_unverified`，且下发时**阻断**该服务器，绝不猜测地址；
//! * 网卡存在但没有可用地址（只有 link-local / unspecified）→ 阻断下发，
//!   绝不回退 `0.0.0.0`。

use std::net::IpAddr;

use serde_json::json;

use pierwave_proto::NetworkInterface;

use crate::error::{AppError, AppResult};

/// 解析库里存的网卡列表；损坏的 JSON 按空列表处理（是否「尚未上报」由
/// `interfaces_reported_at` 决定，不能只看列表）。
pub fn parse_interfaces(raw: &str) -> Vec<NetworkInterface> {
    serde_json::from_str(raw).unwrap_or_default()
}

/// 把 Agent 上报的网卡列表序列化成库内文本。序列化失败只能是内存问题，
/// 此时退回 `[]`：主控按「尚未上报」处理，不会拿半份数据去注入配置。
pub fn encode_interfaces(interfaces: &[NetworkInterface]) -> String {
    serde_json::to_string(interfaces).unwrap_or_else(|_| "[]".into())
}

/// 去首尾空白；空串 = 不限制。
pub fn normalize_nic_name(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// `nic_unverified`：该服务器**从未**被新版 Agent 上报过网卡。
///
/// 注意这与「上报过但当前没有网卡」不同：后者 `interfaces` 也是空数组，
/// 但 `interfaces_reported_at` 非 NULL，前端应显示「没有可用网卡」而不是
/// 「尚未上报网卡」。
pub fn is_unverified(interfaces_reported_at: Option<i64>) -> bool {
    interfaces_reported_at.is_none()
}

/// 校验管理员填写的网卡名。
///
/// 规则：
/// * 从未上报（`reported = false`）→ 允许保存，响应标 `nic_unverified`；
/// * 上报过（包括上报为空列表）→ `nic_name` 必须命中，否则 400。
///
/// 上报为空表示「这台机器当前没有可用网卡」，因此任何选择都不成立；
/// 只有「从未上报」才允许先保存、等 Agent 上线后再说。
pub fn validate(interfaces_json: &str, reported: bool, nic_name: &str) -> AppResult<()> {
    let name = nic_name.trim();
    if name.is_empty() {
        return Ok(());
    }
    if !reported {
        return Ok(());
    }
    let interfaces = parse_interfaces(interfaces_json);
    if interfaces.iter().any(|interface| interface.name == name) {
        return Ok(());
    }
    let mut names: Vec<&str> = interfaces
        .iter()
        .map(|interface| interface.name.as_str())
        .collect();
    names.sort_unstable();
    Err(AppError::coded(
        "server.nic_name_not_found",
        Some(json!({ "nic": name, "interfaces": names.join(", ") })),
        format!(
            "网卡「{name}」不在服务器最近上报的网卡列表中 / NIC \"{name}\" is not in the server's most recently reported interface list"
        ),
    ))
}

/// 解析要注入 Xray/转发的网卡地址。
///
/// * `None` = 服务器没有限制网卡（旧行为，不注入任何东西）；
/// * `Some(address)` = 使用该网卡的可用地址；
/// * 未上报 / 网卡不存在 / 没有可用地址 → 返回带稳定错误码的 400，调用方
///   应当阻断该服务器的下发，**不能**回退 `0.0.0.0`。
pub fn resolve(
    server_name: &str,
    nic_name: Option<&str>,
    interfaces_json: &str,
) -> AppResult<Option<String>> {
    let Some(name) = normalize_nic_name(nic_name) else {
        return Ok(None);
    };
    let interfaces = parse_interfaces(interfaces_json);
    if interfaces.is_empty() {
        return Err(blocked(format!(
                "服务器「{server_name}」尚未上报网卡列表或上报为空，无法按网卡「{name}」下发 / Server \"{server_name}\" has not reported any interfaces (or reported an empty list), so NIC \"{name}\" cannot be applied"
            )));
    }
    let Some(interface) = interfaces.iter().find(|interface| interface.name == name) else {
        return Err(blocked(format!(
                "网卡「{name}」不在服务器「{server_name}」最近上报的网卡列表中，已阻断下发 / NIC \"{name}\" is not in server \"{server_name}\"'s most recently reported interface list; dispatch is blocked"
            )));
    };
    let Some(address) = interface.preferred_address() else {
        return Err(blocked(format!(
                "网卡「{name}」在服务器「{server_name}」上没有可用地址（只有 0.0.0.0 / link-local），已阻断下发 / NIC \"{name}\" on server \"{server_name}\" has no usable address (only 0.0.0.0 / link-local); dispatch is blocked"
            )));
    };
    Ok(Some(address.to_string()))
}

fn blocked(message: String) -> AppError {
    AppError::coded("server.nic_address_unavailable", None, message)
}

/// 把 `host:port` 里的 host 换成网卡地址；IPv6 自动补方括号。
///
/// 只用于隧道/链路的 listen 字符串，端口部分原样保留。
pub fn pin_listen_host(listen: &str, address: &str) -> String {
    let port = listen.rsplit_once(':').map(|(_, port)| port).unwrap_or("");
    if port.is_empty() {
        return address.to_string();
    }
    if address
        .trim()
        .parse::<IpAddr>()
        .is_ok_and(|ip| ip.is_ipv6())
    {
        format!("[{}]:{port}", address.trim())
    } else {
        format!("{}:{port}", address.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reported() -> &'static str {
        r#"[{"name":"eth0","addresses":["10.0.0.2","2001:db8::2"]},{"name":"eth1","addresses":[]}]"#
    }

    #[test]
    fn validate_accepts_known_nic_and_rejects_unknown() {
        validate(reported(), true, "eth0").unwrap();
        assert!(
            !is_unverified(Some(1)),
            "上报过网卡（即使列表为空）就不是 unverified"
        );

        let error = validate(reported(), true, "eth9").unwrap_err();
        let message = error.to_string();
        assert!(message.contains("eth9"), "{message}");
        match error {
            AppError::Coded { code, params, .. } => {
                assert_eq!(code, "server.nic_name_not_found");
                assert_eq!(params.unwrap()["interfaces"], "eth0, eth1");
            }
            other => panic!("必须是 400 带 code：{other:?}"),
        }
    }

    #[test]
    fn empty_report_is_allowed_but_never_reported_is_unverified() {
        validate("[]", true, "eth0").unwrap_err();
        validate("[]", false, "eth0").unwrap();
        assert!(
            is_unverified(None),
            "从未上报时 nic_unverified = true（与是否选了网卡无关）"
        );
        assert!(
            !is_unverified(Some(1)),
            "上报过但列表为空属于「没有可用网卡」，不是「尚未上报」"
        );
    }

    #[test]
    fn resolve_returns_none_without_nic_and_address_with_nic() {
        assert_eq!(resolve("hk-1", None, "[]").unwrap(), None);
        assert_eq!(
            resolve("hk-1", Some("eth0"), reported())
                .unwrap()
                .as_deref(),
            Some("10.0.0.2"),
            "多地址时优先 IPv4"
        );
    }

    #[test]
    fn resolve_blocks_missing_unreported_and_addressless_nics() {
        for (json, needle) in [("[]", "尚未上报"), (reported(), "不在")] {
            let error = resolve("hk-1", Some("eth9"), json).unwrap_err();
            assert!(error.to_string().contains(needle), "{error}");
            match error {
                AppError::Coded { code, .. } => {
                    assert_eq!(code, "server.nic_address_unavailable")
                }
                other => panic!("必须是 400 带 code：{other:?}"),
            }
        }

        let error = resolve("hk-1", Some("eth1"), reported()).unwrap_err();
        assert!(error.to_string().contains("没有可用地址"), "{error}");
        assert!(
            !error.to_string().contains("0.0.0.0:0"),
            "阻断原因不能把 0.0.0.0 当成可用地址"
        );
    }

    #[test]
    fn pin_listen_host_handles_ipv4_and_ipv6() {
        assert_eq!(pin_listen_host("0.0.0.0:8443", "10.0.0.2"), "10.0.0.2:8443");
        assert_eq!(
            pin_listen_host("0.0.0.0:8443", "2001:db8::2"),
            "[2001:db8::2]:8443"
        );
        assert_eq!(
            pin_listen_host("0.0.0.0:8443", " 10.0.0.2 "),
            "10.0.0.2:8443"
        );
    }
}
