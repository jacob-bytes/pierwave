//! REALITY 密钥推导：入站片段只存 `privateKey`，客户端要的是 `publicKey`。
//!
//! 两者在数学上绑定，面板让管理员手填一对密钥只会制造「用户连不上才发现」的故障，
//! 所以这里用 X25519 反推（见 `docs/SUBSCRIBE.md` §7.3）：
//!
//! ```text
//! publicKey = base64url_no_pad( X25519(privateKey_bytes, basepoint) )
//! ```
//!
//! 编码必须是 **URL-safe 且无填充**：这是 Xray `x25519` 的输出格式，客户端（v2rayN /
//! Clash.Meta / sing-box）按这个格式解析。用标准 base64 会带上 `+ / =`，反推出的密钥
//! 字节完全正确、但客户端解析失败，表现为「REALITY 节点连不上」。
//!
//! 片段里若显式给出了 `publicKey`（导入的配置），由调用方优先使用显式值。

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use x25519_dalek::{x25519, X25519_BASEPOINT_BYTES};

/// 从 base64 的 REALITY 私钥推出 base64url（无填充）公钥，与 `xray x25519` 输出一致。
///
/// 私钥常见两种编码：Xray 自己生成的是 URL-safe 无填充（43 字符），
/// 手工导入的可能是标准 base64。这里都接受；长度不是 32 字节或解码失败返回 `None`，
/// 由调用方记 warn 并跳过该节点（订阅是公开端点，不能 panic）。
pub fn public_key_from_private(private_key: &str) -> Option<String> {
    let private = decode_private_key(private_key)?;
    let public = x25519(private, X25519_BASEPOINT_BYTES);
    Some(URL_SAFE_NO_PAD.encode(public))
}

fn decode_private_key(raw: &str) -> Option<[u8; 32]> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let bytes = STANDARD
        .decode(raw)
        .ok()
        .or_else(|| STANDARD_NO_PAD.decode(raw).ok())
        .or_else(|| URL_SAFE.decode(raw).ok())
        .or_else(|| URL_SAFE_NO_PAD.decode(raw).ok())?;
    bytes.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7748 §6.1 官方向量。
    const RFC7748_PRIVATE_HEX: &str =
        "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
    const RFC7748_PUBLIC_HEX: &str =
        "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";

    #[test]
    fn derives_rfc7748_public_key() {
        let private_bytes = hex::decode(RFC7748_PRIVATE_HEX).unwrap();
        let private_b64 = STANDARD.encode(&private_bytes);

        let public_b64 = public_key_from_private(&private_b64).expect("RFC 向量必须能推导");
        let public_bytes = URL_SAFE_NO_PAD.decode(&public_b64).unwrap();

        assert_eq!(hex::encode(public_bytes), RFC7748_PUBLIC_HEX);
        // 编码必须和 `xray x25519` 一致：URL-safe、无填充
        assert!(
            !public_b64.contains(['+', '/', '=']),
            "输出了标准 base64：{public_b64}"
        );
    }

    #[test]
    fn accepts_url_safe_unpadded_private_key() {
        let private_bytes = hex::decode(RFC7748_PRIVATE_HEX).unwrap();
        let private_b64 = URL_SAFE_NO_PAD.encode(&private_bytes);

        let public_b64 =
            public_key_from_private(&private_b64).expect("Xray 私钥是 URL-safe 无填充");
        let public_bytes = URL_SAFE_NO_PAD.decode(&public_b64).unwrap();

        assert_eq!(hex::encode(public_bytes), RFC7748_PUBLIC_HEX);
    }

    #[test]
    fn invalid_private_key_returns_none_instead_of_panicking() {
        assert!(public_key_from_private("").is_none());
        assert!(public_key_from_private("not base64!!!").is_none());
        // 合法 base64 但长度不是 32 字节。
        assert!(public_key_from_private(&STANDARD.encode([0u8; 16])).is_none());
    }
}
