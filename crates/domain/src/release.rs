//! 发布产物校验：Ed25519 签名 + SHA256 清单。
//!
//! 为什么不是「只校验 SHA256」：`SHA256SUMS` 与二进制来自同一个发布源，
//! 源被篡改时两者会一起被改，校验等于没做。签名用的私钥只存在 CI 的 Secrets 里，
//! 公钥内置在二进制中，篡改者拿不到私钥就无法伪造清单。
//!
//! 兼容性：签名是对 `SHA256SUMS` 整体签的，清单再逐行覆盖每个产物。

use anyhow::{Context, Result};
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::DomainError;

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
    let actual = bytes.len();
    let arr: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        DomainError::with_params(
            "release.key_length_invalid",
            json!({ "expected": 32, "actual": actual }),
            "密钥长度必须是 32 字节",
        )
    })?;
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
    let verifying = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| DomainError::new("release.public_key_invalid", "公钥格式不合法"))?;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_b64.trim())
        .context("签名不是合法的 base64")?;
    let actual = sig_bytes.len();
    let signature = Signature::from_slice(&sig_bytes).map_err(|_| {
        DomainError::with_params(
            "release.signature_length_invalid",
            json!({ "expected": 64, "actual": actual }),
            "签名长度不合法",
        )
    })?;
    verifying
        .verify(manifest.as_bytes(), &signature)
        .map_err(|_| {
            DomainError::new(
                "release.signature_invalid",
                "清单签名校验失败：产物可能被篡改，或公钥不匹配",
            )
        })?;
    Ok(())
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
    let expected = map.get(asset).ok_or_else(|| {
        DomainError::with_params(
            "release.asset_missing",
            json!({ "asset": asset }),
            format!("清单里没有 {asset}"),
        )
    })?;
    let actual = hex::encode(Sha256::digest(content));
    if &actual != expected {
        return Err(DomainError::with_params(
            "release.checksum_mismatch",
            json!({ "asset": asset, "expected": expected, "actual": actual }),
            format!("{asset} 的 sha256 不匹配：期望 {expected}，实际 {actual}"),
        )
        .into());
    }
    Ok(())
}

/// 发布版本号的路径安全校验。
///
/// 版本号会被拼进缓存路径与回源 URL，因此只允许单个路径段里的安全字符：
/// 字母、数字、`.`、`-`、`_`、`+`；禁止 `..`、`/`、空白与开头 `.`/`-`。
/// 同时要求至少包含一个数字，避免把 `latest` 之类当版本号。
pub fn is_valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && !version.starts_with(['.', '-'])
        && !version.contains("..")
        && version.chars().any(|c| c.is_ascii_digit())
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
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

    fn domain_error(error: &anyhow::Error) -> &DomainError {
        error
            .chain()
            .find_map(|cause| cause.downcast_ref::<DomainError>())
            .expect("发布校验错误必须携带 DomainError")
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
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
        let error = verify_manifest("abd  a\n", &sig, &public).unwrap_err();
        assert_eq!(domain_error(&error).code, "release.signature_invalid");
        assert!(error.to_string().contains("签名校验失败"), "{error}");
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
        let error = verify_manifest("m", &sig, &other).unwrap_err();
        assert_eq!(domain_error(&error).code, "release.signature_invalid");
    }

    #[test]
    fn rejects_bad_key_and_signature_shapes() {
        let (secret, public) = keypair();

        // 密钥不是 32 字节：私钥/公钥共用的解码路径。
        let short_key = b64(&[0u8; 31]);
        let error = sign_manifest(&short_key, "m").unwrap_err();
        assert_eq!(domain_error(&error).code, "release.key_length_invalid");
        assert_eq!(
            domain_error(&error).params,
            json!({ "expected": 32, "actual": 31 })
        );

        // 32 字节但不是合法的 compressed Edwards 点（y=2 不在曲线上）。
        let mut invalid_key = [0u8; 32];
        invalid_key[0] = 2;
        let invalid_public = b64(&invalid_key);
        let error = verify_manifest("m", &b64(&[0u8; 64]), &invalid_public).unwrap_err();
        assert_eq!(domain_error(&error).code, "release.public_key_invalid");

        // 签名长度不是 64 字节。
        let sig = sign_manifest(&secret, "m").unwrap();
        let short_sig = b64(&[0u8; 10]);
        let error = verify_manifest("m", &short_sig, &public).unwrap_err();
        assert_eq!(
            domain_error(&error).code,
            "release.signature_length_invalid"
        );
        assert_eq!(
            domain_error(&error).params,
            json!({ "expected": 64, "actual": 10 })
        );

        // 长度正确但内容与清单不匹配。
        let wrong_sig = b64(&[0u8; 64]);
        let error = verify_manifest("m", &wrong_sig, &public).unwrap_err();
        assert_eq!(domain_error(&error).code, "release.signature_invalid");
        assert!(verify_manifest("m", &sig, &public).is_ok());
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

        let error = verify_asset(&manifest, "agent", b"tampered").unwrap_err();
        let domain = domain_error(&error);
        assert_eq!(domain.code, "release.checksum_mismatch");
        assert_eq!(
            domain.params,
            json!({
                "asset": "agent",
                "expected": hash,
                "actual": hex::encode(Sha256::digest(b"tampered")),
            })
        );

        let error = verify_asset(&manifest, "other", content).unwrap_err();
        let domain = domain_error(&error);
        assert_eq!(domain.code, "release.asset_missing");
        assert_eq!(domain.params, json!({ "asset": "other" }));
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
    fn validates_version_path_segment() {
        for ok in ["0.5.1", "v0.5.1", "v0.6.0-rc.1", "0.5.1+build.7"] {
            assert!(is_valid_version(ok), "应接受：{ok}");
        }
        for bad in ["", ".", "..", "../x", "0.5/1", "latest", "v1.0 "] {
            assert!(!is_valid_version(bad), "应拒绝：{bad}");
        }
    }

    #[test]
    fn embedded_key_is_valid_base64() {
        // 兜底公钥必须能被解码，否则本地构建一切校验都会报“公钥格式不合法”
        assert!(decode_key(embedded_public_key()).is_ok());
    }
}
