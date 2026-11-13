//! P16 隧道的安全模式取值校验。
//!
//! 一条 `engine = tunnel` 的链可以选择两种模式：
//!
//! * [`TLS`]（默认）：主控自有 CA + 每台服务器属证书，P16.1 已验收的行为；
//! * [`NOISE`]：无证书，两端用 `hop_secret` 派生的静态密钥与 PSK 做
//!   Noise IK 握手（P16.2）。
//!
//! 这里只做「不查库」的字符串校验，与 [`crate::engine`] /
//! [`crate::hop_transport`] 同层。错误码固定为
//! `chain.tunnel_security_invalid`，前端按 code 查词典。
//!
//! 与 `hop_transport` 的 `transport` 是两个维度：`transport` 是 realm 的
//! 跳间 TLS（`none` / `tls`），`tunnel_security` 只对 tunnel 引擎有意义。
//! 两者互不影响，不能合并成一个字段。

use serde_json::json;

use crate::error::DomainError;

/// TLS + 自有 CA：默认值，与 P16.1 行为完全一致。
pub const TLS: &str = "tls";
/// Noise/PSK：不需要证书，只需要两端共享的 `hop_secret`。
pub const NOISE: &str = "noise";
/// 合法模式，错误提示里按顺序展示。
pub const NAMES: [&str; 2] = [TLS, NOISE];
/// 新建链时没填 `tunnel_security` 的默认值。
pub const DEFAULT: &str = TLS;

/// 严格解析：只接受 `tls` / `noise`（去掉首尾空白后完全匹配）。
///
/// 故意不忽略大小写：`Noise` / `TLS` 会让人以为是合法值，却让 Agent 侧
/// 多一套字符串比较规则；早失败更安全。
pub fn normalize(raw: &str) -> Result<String, DomainError> {
    let mode = raw.trim();
    match mode {
        TLS => Ok(TLS.to_string()),
        NOISE => Ok(NOISE.to_string()),
        other => Err(DomainError::with_params(
            "chain.tunnel_security_invalid",
            json!({ "tunnel_security": other, "allowed": NAMES }),
            format!("隧道安全模式「{other}」无效，只支持 {}", NAMES.join(" / ")),
        )),
    }
}

/// 从数据库读出的模式：非法/空值回落到 `tls`。
///
/// 写路径已经校验过，这里兜底的是历史数据/手工改库；读路径不能让一个脏值
/// 让整份期望态下发失败。回落 `tls` 也保证旧数据（迁移默认值）行为不变。
pub fn from_db(raw: &str) -> &'static str {
    if raw.trim() == NOISE {
        NOISE
    } else {
        TLS
    }
}

/// 是否是 Noise 模式（主控推导 TunnelSpec 时只需要这一个布尔判断）。
pub fn is_noise(raw: &str) -> bool {
    from_db(raw) == NOISE
}

/// 是否是 TLS 模式。
pub fn is_tls(raw: &str) -> bool {
    from_db(raw) == TLS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_known_modes() {
        assert_eq!(normalize("tls").unwrap(), "tls");
        assert_eq!(normalize("noise").unwrap(), "noise");
        assert_eq!(normalize("  noise  ").unwrap(), "noise", "允许首尾空白");
        assert_eq!(DEFAULT, "tls", "新建链默认 TLS");
    }

    #[test]
    fn rejects_unknown_modes_with_stable_code() {
        for bad in ["", "TLS", "Noise", "wireguard", "psk", "tls,noise"] {
            let error = normalize(bad).unwrap_err();
            assert_eq!(error.code, "chain.tunnel_security_invalid", "bad={bad:?}");
            assert_eq!(error.params["tunnel_security"], bad);
            assert_eq!(
                error.params["allowed"],
                json!(["tls", "noise"]),
                "错误参数必须稳定"
            );
            assert!(
                error.message.contains("只支持 tls / noise"),
                "{}",
                error.message
            );
        }
    }

    #[test]
    fn database_values_fall_back_to_tls() {
        assert_eq!(from_db("noise"), "noise");
        assert_eq!(from_db("tls"), "tls");
        assert_eq!(from_db("  noise "), "noise");
        assert_eq!(from_db("Noise"), "tls", "大小写不匹配也回落 tls");
        assert_eq!(from_db(""), "tls");
        assert!(is_noise("noise"));
        assert!(!is_noise("tls"));
        assert!(is_tls("tls"));
        assert!(!is_tls("noise"));
    }
}
