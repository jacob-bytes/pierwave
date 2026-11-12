//! 转发引擎的取值校验。
//!
//! 一条独立转发或一条链都可以选择用哪个引擎实现：
//!
//! * [`NATIVE`]：Agent 自己监听并转发（现有 `ForwardSupervisor`）；
//! * [`REALM`]：Agent 生成真实 realm 配置并托管 `realm` 子进程；
//! * [`NFTABLES`]：Agent 用内核 netfilter DNAT 转发（不经过用户态）；
//! * [`TUNNEL`]：P16 自研 TLS 隧道（2 跳链的入口 Dialer + 出口 Listener）。
//!
//! 这里只做「不查库」的字符串校验，和端口/目标校验一样由 master 的写路径调用。
//! 错误码固定为 `forward.engine_invalid`（转发与链共用），前端按 code 查词典。

use serde_json::json;

use crate::error::DomainError;

/// Agent 原生引擎：不需要任何外部程序，行为与升级前一致。
pub const NATIVE: &str = "native";

/// 外接 realm 子进程。
pub const REALM: &str = "realm";

/// 内核 nftables DNAT 引擎（需要 root / CAP_NET_ADMIN）。
pub const NFTABLES: &str = "nftables";

/// P16 自研 TLS 隧道引擎（帧中继 + 自有 CA）。
///
/// 只用于链：独立转发没有「下一跳」与证书角色，写路径会拒绝。
pub const TUNNEL: &str = "tunnel";

/// 合法的引擎名，错误提示里按顺序展示。
pub const NAMES: [&str; 4] = [NATIVE, REALM, NFTABLES, TUNNEL];

/// 新建规则时没填 `engine` 的默认值。
pub const DEFAULT: &str = NATIVE;

/// 严格解析：只接受 `native` / `realm` / `nftables` / `tunnel`（去掉首尾空白后完全匹配）。
///
/// 故意不忽略大小写：`Realm` / `NATIVE` 会让人以为是合法值，
/// 却让 Agent 侧的字符串比较多一套规则，早失败更安全。
pub fn normalize(raw: &str) -> Result<String, DomainError> {
    let engine = raw.trim();
    match engine {
        NATIVE => Ok(NATIVE.to_string()),
        REALM => Ok(REALM.to_string()),
        NFTABLES => Ok(NFTABLES.to_string()),
        TUNNEL => Ok(TUNNEL.to_string()),
        other => Err(DomainError::with_params(
            "forward.engine_invalid",
            json!({ "engine": other, "allowed": NAMES }),
            format!("转发引擎「{other}」无效，只支持 {}", NAMES.join(" / ")),
        )),
    }
}

/// 从数据库读出的引擎名：非法值回落到 native。
///
/// 写路径已经校验过，这里兜底的是历史数据/手工改库；
/// 读路径不能因为一个脏值让整份期望态下发失败。
pub fn from_db(raw: &str) -> &'static str {
    match raw.trim() {
        REALM => REALM,
        NFTABLES => NFTABLES,
        TUNNEL => TUNNEL,
        _ => NATIVE,
    }
}

/// 是否是 realm 引擎（Agent 侧也用它做一次布尔判断）。
pub fn is_realm(engine: &str) -> bool {
    from_db(engine) == REALM
}

/// 是否是内核 nftables 引擎。
pub fn is_nftables(engine: &str) -> bool {
    from_db(engine) == NFTABLES
}

/// 是否是 P16 隧道引擎。
pub fn is_tunnel(engine: &str) -> bool {
    from_db(engine) == TUNNEL
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_known_engines() {
        assert_eq!(normalize("native").unwrap(), "native");
        assert_eq!(normalize("realm").unwrap(), "realm");
        assert_eq!(normalize("nftables").unwrap(), "nftables");
        assert_eq!(normalize("tunnel").unwrap(), "tunnel");
        assert_eq!(normalize("  realm  ").unwrap(), "realm", "允许首尾空白");
        assert_eq!(normalize(" nftables ").unwrap(), "nftables");
        assert_eq!(DEFAULT, "native", "新建规则默认 native");
    }

    #[test]
    fn rejects_unknown_engines_with_stable_code() {
        for bad in ["", "Realm", "NATIVE", "wireguard", "realm2", "Tunnel"] {
            let error = normalize(bad).unwrap_err();
            assert_eq!(error.code, "forward.engine_invalid", "bad={bad:?}");
            assert!(
                error
                    .message
                    .contains("只支持 native / realm / nftables / tunnel"),
                "{}",
                error.message
            );
            assert_eq!(error.params["engine"], bad);
            assert_eq!(
                error.params["allowed"],
                json!(["native", "realm", "nftables", "tunnel"])
            );
        }
    }

    #[test]
    fn database_values_fall_back_to_native() {
        assert_eq!(from_db("realm"), "realm");
        assert_eq!(from_db("nftables"), "nftables");
        assert_eq!(from_db("tunnel"), "tunnel");
        assert_eq!(from_db(" native "), "native");
        assert_eq!(from_db("REALM"), "native", "大小写不匹配也回落 native");
        assert_eq!(from_db(""), "native");
        assert!(is_realm("realm"));
        assert!(!is_realm("native"));
        assert!(is_nftables("nftables"));
        assert!(!is_nftables("realm"));
        assert!(is_tunnel("tunnel"));
        assert!(!is_tunnel("realm"));
    }
}
