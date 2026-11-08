//! 单跳 TCP 转发规则的纯逻辑校验。
//!
//! 这里只做「不查库」的字段校验；端口是否与节点/其它转发冲突依赖服务器上的
//! 现有数据，放在 master 的 `routes::forwards` 里查仓储后判断。
//!
//! 保留端口写死：API 入站固定监听 10085，SSH 默认 22。两者都不能被转发占用，
//! 否则 Agent 一旦监听成功就会顶掉主控或远程登录。

use serde_json::json;

use crate::error::DomainError;

/// 转发监听端口的合法范围。
pub const PORT_MIN: i64 = 1;
pub const PORT_MAX: i64 = 65535;

/// 目标地址最大字符数。
pub const TARGET_HOST_MAX_CHARS: usize = 255;

/// 规则名最大字符数（列表/审计里展示用）。
pub const NAME_MAX_CHARS: usize = 64;

/// 不允许被转发监听的端口：`10085` = API 入站，`22` = SSHD。
pub const RESERVED_PORTS: &[i64] = &[22, 10085];

/// 独立单跳转发下发时的 id 前缀。
///
/// 存储层主键仍是裸 UUID；下发前加前缀是为了和链推导出的
/// `chain-<chain_id>-<seq>` 在同一个 `DesiredState.forwards` 列表里不会撞 id。
pub const DESIRED_ID_PREFIX: &str = "fwd-";

/// 独立单跳转发在期望态里的稳定 id：`fwd-<uuid>`。
pub fn desired_id(forward_id: &str) -> String {
    format!("{DESIRED_ID_PREFIX}{forward_id}")
}

/// API 入站的固定端口；与 `xray::build_config` 里的 api inbound 保持一致。
pub const API_PORT: i64 = 10085;

/// SSHD 默认端口。
pub const SSHD_PORT: i64 = 22;

pub fn is_reserved_port(port: i64) -> bool {
    RESERVED_PORTS.contains(&port)
}

fn validate_port(port: i64, code: &'static str, label: &str) -> Result<(), DomainError> {
    if (PORT_MIN..=PORT_MAX).contains(&port) {
        Ok(())
    } else {
        Err(DomainError::with_params(
            code,
            json!({ "min": PORT_MIN, "max": PORT_MAX }),
            format!("{label}必须在 {PORT_MIN}-{PORT_MAX} 之间（当前 {port}）"),
        ))
    }
}

/// 监听端口范围校验（1..=65535）。
pub fn validate_listen_port(port: i64) -> Result<(), DomainError> {
    validate_port(port, "forward.listen_port_invalid", "监听端口")
}

/// 目标端口范围校验（1..=65535）。
pub fn validate_target_port(port: i64) -> Result<(), DomainError> {
    validate_port(port, "forward.target_port_invalid", "目标端口")
}

/// 黑名单端口：API（10085）与 SSHD（22）。
pub fn ensure_port_not_reserved(port: i64) -> Result<(), DomainError> {
    if is_reserved_port(port) {
        return Err(DomainError::with_params(
            "forward.port_reserved",
            json!({ "port": port }),
            format!("端口 {port} 是保留端口（API {API_PORT} / SSH {SSHD_PORT}），不能用于转发"),
        ));
    }
    Ok(())
}

/// 目标地址：去首尾空白后不能为空，且不超过 255 个字符。
pub fn normalize_target_host(raw: &str) -> Result<String, DomainError> {
    let host = raw.trim();
    if host.is_empty() {
        return Err(DomainError::new(
            "forward.target_host_required",
            "目标地址不能为空",
        ));
    }
    if host.chars().count() > TARGET_HOST_MAX_CHARS {
        return Err(DomainError::with_params(
            "forward.target_host_too_long",
            json!({ "max": TARGET_HOST_MAX_CHARS }),
            format!("目标地址最多 {TARGET_HOST_MAX_CHARS} 个字符"),
        ));
    }
    Ok(host.to_string())
}

/// 规则名：去首尾空白后不能为空，且不超过 64 个字符。
pub fn normalize_name(raw: &str) -> Result<String, DomainError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(DomainError::new(
            "forward.name_required",
            "转发名称不能为空",
        ));
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(DomainError::with_params(
            "forward.name_too_long",
            json!({ "max": NAME_MAX_CHARS }),
            format!("转发名称最多 {NAME_MAX_CHARS} 个字符"),
        ));
    }
    Ok(name.to_string())
}

/// 自连放大检查：目标指向「本机 + 与本规则相同的端口」时会形成无限回环。
///
/// `0.0.0.0` 监听意味着本机所有地址都可连，所以把通配地址与回环地址视为同一台机器；
/// 这是字符串级判断（不做 DNS 解析），能挡住最常见的手误，解析型自连由 Agent 侧日志暴露。
pub fn ensure_not_self_loop(
    listen_host: &str,
    listen_port: i64,
    target_host: &str,
    target_port: i64,
) -> Result<(), DomainError> {
    if listen_port != target_port {
        return Ok(());
    }
    let wildcard = matches!(listen_host.trim(), "0.0.0.0" | "[::]" | "::" | "");
    let target_is_loopback = matches!(
        target_host.trim().to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    );
    if wildcard && target_is_loopback {
        return Err(DomainError::with_params(
            "forward.self_loop",
            json!({ "port": listen_port }),
            format!(
                "目标指向本机同一端口 {listen_port}，会形成自连回环；请填写实际落地地址或换一个目标端口"
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listen_and_target_ports_are_range_checked() {
        assert!(validate_listen_port(1).is_ok());
        assert!(validate_listen_port(65535).is_ok());
        for bad in [0, -1, 65536] {
            let error = validate_listen_port(bad).unwrap_err();
            assert_eq!(error.code, "forward.listen_port_invalid", "bad={bad}");
            assert!(error.message.contains("1-65535"), "{}", error.message);
        }

        assert!(validate_target_port(443).is_ok());
        for bad in [0, 65536] {
            let error = validate_target_port(bad).unwrap_err();
            assert_eq!(error.code, "forward.target_port_invalid", "bad={bad}");
        }
    }

    #[test]
    fn self_loop_is_rejected() {
        let error = ensure_not_self_loop("0.0.0.0", 8443, "127.0.0.1", 8443).unwrap_err();
        assert_eq!(error.code, "forward.self_loop");
        // 端口不同、目标是外网地址、监听在具体地址上，都不算自连
        assert!(ensure_not_self_loop("0.0.0.0", 8443, "127.0.0.1", 443).is_ok());
        assert!(ensure_not_self_loop("0.0.0.0", 8443, "10.0.0.8", 8443).is_ok());
        assert!(ensure_not_self_loop("10.0.0.2", 8443, "127.0.0.1", 8443).is_ok());
    }

    #[test]
    fn api_and_sshd_ports_are_reserved() {
        for port in [22, 10085] {
            let error = ensure_port_not_reserved(port).unwrap_err();
            assert_eq!(error.code, "forward.port_reserved");
            assert_eq!(error.params, json!({ "port": port }));
            assert!(error.message.contains("保留端口"), "{}", error.message);
        }
        assert!(ensure_port_not_reserved(2222).is_ok(), "只黑名单 22 本身");
        assert!(is_reserved_port(API_PORT));
        assert!(is_reserved_port(SSHD_PORT));
    }

    #[test]
    fn target_host_is_trimmed_and_length_checked() {
        assert_eq!(
            normalize_target_host("  10.0.0.8 ").unwrap(),
            "10.0.0.8",
            "首尾空白必须去掉"
        );
        assert_eq!(
            normalize_target_host(&"a".repeat(TARGET_HOST_MAX_CHARS)).unwrap(),
            "a".repeat(TARGET_HOST_MAX_CHARS)
        );

        let empty = normalize_target_host("   ").unwrap_err();
        assert_eq!(empty.code, "forward.target_host_required");

        let too_long = normalize_target_host(&"a".repeat(TARGET_HOST_MAX_CHARS + 1)).unwrap_err();
        assert_eq!(too_long.code, "forward.target_host_too_long");
        assert_eq!(too_long.params, json!({ "max": TARGET_HOST_MAX_CHARS }));
    }

    #[test]
    fn desired_ids_are_prefixed_and_stable() {
        assert_eq!(desired_id("abc"), "fwd-abc");
        assert!(desired_id("abc").starts_with(DESIRED_ID_PREFIX));
        assert_ne!(
            desired_id("abc"),
            crate::chains::forward_id("abc", 0),
            "独立转发与链推导的 id 前缀必须不同"
        );
    }

    #[test]
    fn name_is_required_and_bounded() {
        assert_eq!(normalize_name(" 香港中转 ").unwrap(), "香港中转");
        assert_eq!(
            normalize_name(&"a".repeat(NAME_MAX_CHARS)).unwrap(),
            "a".repeat(NAME_MAX_CHARS)
        );
        assert_eq!(
            normalize_name("\t ").unwrap_err().code,
            "forward.name_required"
        );
        assert_eq!(
            normalize_name(&"a".repeat(NAME_MAX_CHARS + 1))
                .unwrap_err()
                .code,
            "forward.name_too_long"
        );
    }
}
