//! 发布产物校验：Ed25519 签名 + SHA256 清单。
//!
//! 为什么不是「只校验 SHA256」：`SHA256SUMS` 与二进制来自同一个发布源，
//! 源被篡改时两者会一起被改，校验等于没做。签名用的私钥只存在 CI 的 Secrets 里，
//! 公钥内置在二进制中，篡改者拿不到私钥就无法伪造清单。
//!
//! 兼容性：签名是对 `SHA256SUMS` 整体签的，清单再逐行覆盖每个产物。

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

/// 开发用的兜底公钥：发布构建通过 `PIERWAVE_RELEASE_PUBKEY` 编译期注入真实公钥。
///
/// 这里刻意留一个固定的开发密钥，让本地构建也能跑通签名验证流程；
/// 正式发布必须注入真实公钥，否则「校验通过」只是一场自娱自乐。
pub const DEV_PUBLIC_KEY_B64: &str = "vTmZY2HhvEOMbXKvxKYFuSWJLa5e5qjwxBNBSpJVhMM=";

/// 当前构建内置的发布公钥（base64，32 字节 Ed25519 公钥）。
pub fn embedded_public_key() -> &'static str {
    option_env!("PIERWAVE_RELEASE_PUBKEY").unwrap_or(DEV_PUBLIC_KEY_B64)
}

fn decode_key(raw: &str) -> Result<[u8; 32]> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .context("公钥/私钥不是合法的 base64")?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("密钥长度必须是 32 字节"))?;
    Ok(arr)
}

/// 用私钥对清单签名，返回 base64 签名。CI 发布时调用。
pub fn sign_manifest(secret_key_b64: &str, manifest: &str) -> Result<String> {
    let key = SigningKey::from_bytes(&decode_key(secret_key_b64)?);
    let signature = key.sign(manifest.as_bytes());
    Ok(base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()))
}

/// 校验清单签名。公钥来自参数或编译期内置值。
pub fn verify_manifest(manifest: &str, signature_b64: &str, public_key_b64: &str) -> Result<()> {
    let key_bytes = decode_key(public_key_b64)?;
    let verifying = VerifyingKey::from_bytes(&key_bytes).map_err(|_| anyhow!("公钥格式不合法"))?;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_b64.trim())
        .context("签名不是合法的 base64")?;
    let signature = Signature::from_slice(&sig_bytes).map_err(|_| anyhow!("签名长度不合法"))?;
    verifying
        .verify(manifest.as_bytes(), &signature)
        .map_err(|_| anyhow!("清单签名校验失败：产物可能被篡改，或公钥不匹配"))
}

/// 解析 `sha256sum` 格式的清单。兼容 `hex  name` 与 `hex *name` 两种写法。
pub fn parse_manifest(manifest: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in manifest.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((hash, rest)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let name = rest.trim_start_matches('*').trim();
        if !hash.is_empty() && !name.is_empty() {
            map.insert(name.to_string(), hash.to_ascii_lowercase());
        }
    }
    map
}

/// 从清单里取出某个产物的 sha256，并与实际文件内容比对。
pub fn verify_asset(manifest: &str, asset: &str, content: &[u8]) -> Result<()> {
    let map = parse_manifest(manifest);
    let expected = map
        .get(asset)
        .ok_or_else(|| anyhow!("清单里没有 {asset}"))?;
    let actual = hex::encode(Sha256::digest(content));
    if &actual != expected {
        bail!("{asset} 的 sha256 不匹配：期望 {expected}，实际 {actual}");
    }
    Ok(())
}

/// 版本比较：忽略前缀 `v`，按数字段比较；`0.10.0` 必须大于 `0.9.9`。
pub fn is_newer(candidate: &str, current: &str) -> bool {
    fn parts(v: &str) -> Vec<u64> {
        v.trim_start_matches('v')
            .split(['.', '-', '+'])
            .map(|seg| seg.parse::<u64>().unwrap_or(0))
            .collect()
    }
    let (a, b) = (parts(candidate), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keypair() -> (String, String) {
        // 固定种子，避免测试依赖随机数
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let public = signing.verifying_key().to_bytes();
        (
            base64::engine::general_purpose::STANDARD.encode(signing.to_bytes()),
            base64::engine::general_purpose::STANDARD.encode(public),
        )
    }

    #[test]
    fn signature_roundtrip() {
        let (secret, public) = keypair();
        let manifest = "abc  pierwave-master-x86_64\n";
        let sig = sign_manifest(&secret, manifest).unwrap();
        assert!(verify_manifest(manifest, &sig, &public).is_ok());
    }

    #[test]
    fn tampered_manifest_is_rejected() {
        let (secret, public) = keypair();
        let sig = sign_manifest(&secret, "abc  a\n").unwrap();
        assert!(verify_manifest("abd  a\n", &sig, &public).is_err());
    }

    #[test]
    fn wrong_public_key_is_rejected() {
        let (secret, _public) = keypair();
        let other = base64::engine::general_purpose::STANDARD.encode(
            SigningKey::from_bytes(&[9u8; 32])
                .verifying_key()
                .to_bytes(),
        );
        let sig = sign_manifest(&secret, "m").unwrap();
        assert!(verify_manifest("m", &sig, &other).is_err());
    }

    #[test]
    fn parses_both_manifest_styles() {
        let map = parse_manifest("# comment\nabc  file-a\nDEF *file-b\n\n");
        assert_eq!(map.get("file-a").unwrap(), "abc");
        assert_eq!(map.get("file-b").unwrap(), "def");
        assert!(!map.contains_key("missing"));
    }

    #[test]
    fn verifies_asset_checksum() {
        let content = b"hello";
        let hash = hex::encode(Sha256::digest(content));
        let manifest = format!("{hash}  agent\n");
        assert!(verify_asset(&manifest, "agent", content).is_ok());
        assert!(verify_asset(&manifest, "agent", b"tampered").is_err());
        assert!(verify_asset(&manifest, "other", content).is_err());
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("0.5.1", "0.5.0"));
        assert!(is_newer("v0.5.1", "0.5.0"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(!is_newer("0.5.0", "0.5.0"));
        assert!(!is_newer("0.5.0", "0.5.1"));
        assert!(is_newer("1.0.0", "0.99.99"));
    }

    #[test]
    fn embedded_key_is_valid_base64() {
        // 兜底公钥必须能被解码，否则本地构建一切校验都会报“公钥格式不合法”
        assert!(decode_key(embedded_public_key()).is_ok());
    }
}
