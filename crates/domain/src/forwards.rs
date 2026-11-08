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
