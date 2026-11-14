//! Noise over QUIC：由 `hop_secret` 确定性派生的自签证书 + 指纹固定。
//!
//! QUIC 的握手固定是 TLS 1.3，无法像 TCP 那样把 Noise 握手塞进同一条流。
//! Noise 模式又要求「不要证书、只认 PSK」，因此这里把 PSK 换一种用法：
//!
//! ```text
//! seed        = HMAC-SHA256(hop_secret, "pierwave/tunnel/quic/ed25519-seed/v1")
//! private_key = Ed25519(seed)             // 写入 PKCS#8，交给 rcgen/ring
//! serial      = HMAC-SHA256(hop_secret, "pierwave/tunnel/quic/serial/v1")[..20]
//! certificate = self_signed(private_key, 固定 DN / 固定有效期 / 上面的 serial)
//! fingerprint = SHA-256(DER(certificate))
//! ```
//!
//! 两端只要持有同一个 `hop_secret`，就**各自独立**算出同一张证书（DER 逐字节
//! 相同）与同一个指纹，不需要交换任何额外材料。客户端用下面的
//! [`PinnedCertVerifier`] 只接受指纹等于本地派生值的对端：
//!
//! * 指纹不匹配 → 握手失败，错误里带可读的中英双语原因；
//! * 证书里的公钥与指纹绑定，攻击者只有拿到证书副本、没有对应私钥时，
//!   `CertificateVerify` 签名校验必然失败；
//! * **没有** `insecure` / 跳过校验收敛开关：`PinnedCertVerifier` 是唯一的
//!   Noise-QUIC 客户端校验器，服务端也用同一对派生密钥。
//!
//! # 为什么证书是确定性的
//!
//! 客户端必须在握手**之前**就知道该信任哪张证书。所以除了密钥由 `hop_secret`
//! 派生，证书的序列号、有效期、主题也必须固定，不能使用 `now()` 或随机数：
//!
//! * 序列号：由 `hop_secret` 的另一个 HMAC 标签派生（域分离）；
//! * 有效期：固定 2020-01-01 .. 2120-01-01（不是安全边界——身份由指纹固定）；
//! * DN 与 key usage 都是常量；
//! * Ed25519 签名本身是确定性的。
//!
//! 因此「同一 hop_secret → 同一 DER → 同一指纹」可以在两端复现。
//! 改派生标签、DN、有效期或 rcgen 版本都会改变指纹——**两端必须升级到同一
//! 实现**，否则会以「指纹不匹配」fail closed，而不是降级成明文。
//!
//! # 多个 hop 的限制
//!
//! QUIC 的 TLS 握手发生在应用层 `ClientHello`（hop 认证）之前，服务端此时还
//! 不知道对端是哪个 hop。监听端有多个 hop 时无法选择该出示哪张派生证书，
//! 因此 Noise + UDP 要求监听端**恰好一个 hop**（生产下发路径本来就是每段一个
//! hop）；多于一个时 [`super::QuicUdpServer`] 启动失败并给出可读原因，绝不
//! 猜测或退化成信任任意证书。

use std::fmt;

use anyhow::{bail, Context, Result};
use rcgen::{
    date_time_ymd, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose, SerialNumber, PKCS_ED25519,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use rustls::{DigitallySignedStruct, Error as TlsError, SignatureScheme};
use sha2::{Digest, Sha256};

/// Ed25519 私钥种子的 HMAC 标签。改它等于换协议（指纹会变）。
pub const SEED_LABEL: &[u8] = b"pierwave/tunnel/quic/ed25519-seed/v1";
/// 证书序列号的 HMAC 标签（与种子分开，避免复用同一段密钥流）。
pub const SERIAL_LABEL: &[u8] = b"pierwave/tunnel/quic/serial/v1";

/// Noise-QUIC 使用的固定 SNI。
///
/// 证书与名字无关（校验器只比对指纹），但 QUIC/rustls 的客户端 API 必须给
/// 一个合法 `ServerName`。`.invalid` 是 RFC 2606 保留的顶级域，永远不会被
/// 真实 DNS 解析，避免有人误以为它会做名字校验。
pub const NOISE_SNI: &str = "pierwave-tunnel.invalid";

/// 证书固定的生效时间下界（UTC）。身份由指纹固定，有效期只为让证书可解析。
const NOT_BEFORE: (i32, u8, u8) = (2020, 1, 1);
/// 证书固定的生效时间上界（UTC）。
const NOT_AFTER: (i32, u8, u8) = (2120, 1, 1);

/// 由 `hop_secret` 确定性派生的 Noise-QUIC 身份（证书 + 私钥 + 指纹）。
///
/// 私钥与种子只保存在内存里，`Debug` 只打印指纹，绝不打印密钥。
#[derive(Clone)]
pub struct NoiseQuicIdentity {
    certificate: CertificateDer<'static>,
    /// PKCS#8 DER。`PrivateKeyDer` 本身不实现 `Clone`，存字节、用时再封装，
    /// 这样身份可以安全地在多个 QUIC 客户端配置之间共享。
    key_pkcs8: Vec<u8>,
    fingerprint: [u8; 32],
}

impl fmt::Debug for NoiseQuicIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NoiseQuicIdentity")
            .field("fingerprint", &self.fingerprint_hex())
            .field(
                "certificate",
                &format!("{} bytes", self.certificate.as_ref().len()),
            )
            .finish_non_exhaustive()
    }
}

impl NoiseQuicIdentity {
    /// 证书 DER（服务端 TLS 配置用）。
    pub fn certificate(&self) -> &CertificateDer<'static> {
        &self.certificate
    }

    /// 私钥 DER（PKCS#8，服务端 TLS 配置用）；每次返回一份新的封装。
    pub fn key(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key_pkcs8.clone()))
    }

    /// SHA-256(DER)，客户端比对的就是它。
    pub fn fingerprint(&self) -> [u8; 32] {
        self.fingerprint
    }

    /// 指纹的十六进制形式，只用于日志与错误文案。
    pub fn fingerprint_hex(&self) -> String {
        hex_lower(&self.fingerprint)
    }
}

/// 从每跳预共享密钥派生证书、私钥与指纹；两端独立计算结果相同。
///
/// 派生失败（HMAC 输出不足、PKCS#8 被 ring 拒绝、rcgen 签发失败）一律返回
/// 带上下文的错误，调用方必须让端点启动失败——绝不回退到不校验证书。
pub fn derive_identity(hop_secret: &[u8]) -> Result<NoiseQuicIdentity> {
    if hop_secret.is_empty() {
        bail!("hop_secret 不能为空，无法派生 QUIC 证书 / empty hop_secret cannot derive a QUIC certificate");
    }

    let seed = hmac_sha256(hop_secret, SEED_LABEL);
    let key = KeyPair::from_pkcs8_der_and_sign_algo(
        &PrivatePkcs8KeyDer::from(ed25519_pkcs8(&seed).to_vec()),
        &PKCS_ED25519,
    )
    .context(
        "由 hop_secret 派生 Ed25519 私钥失败 / failed to derive the Ed25519 key from hop_secret",
    )?;

    let mut params = CertificateParams::default();
    // 自签叶子证书：不签子证书，也不带 CA 标记。
    params.is_ca = IsCa::NoCa;
    params.not_before = date_time_ymd(NOT_BEFORE.0, NOT_BEFORE.1, NOT_BEFORE.2);
    params.not_after = date_time_ymd(NOT_AFTER.0, NOT_AFTER.1, NOT_AFTER.2);
    let mut serial = hmac_sha256(hop_secret, SERIAL_LABEL);
    // RFC 5280：序列号必须是正整数且不超过 20 字节。清掉最高位、保证非零，
    // 避免 DER 长度因为符号位翻转而变化（确定性要求）。
    serial[0] &= 0x7f;
    if serial.iter().all(|byte| *byte == 0) {
        serial[19] = 1;
    }
    params.serial_number = Some(SerialNumber::from_slice(&serial));
    params.distinguished_name = {
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "pierwave tunnel (noise-quic)");
        dn
    };
    // SAN 留空：身份只由指纹固定，名字不参与校验。
    params.subject_alt_names.clear();
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];

    let certificate = params
        .self_signed(&key)
        .context("签发派生 QUIC 证书失败 / failed to sign the derived QUIC certificate")?;
    let certificate: CertificateDer<'static> = certificate.der().clone();
    let fingerprint = sha256(certificate.as_ref());
    let key_pkcs8 = key.serialize_der();

    Ok(NoiseQuicIdentity {
        certificate,
        key_pkcs8,
        fingerprint,
    })
}

/// Noise-QUIC 客户端使用的固定 `ServerName`。
///
/// 名字本身不参与身份判断（见 [`PinnedCertVerifier`]），但 QUIC 客户端 API
/// 需要一个合法的 `ServerName`；固定值让两端行为可复现。
pub fn noise_server_name() -> ServerName<'static> {
    ServerName::try_from(NOISE_SNI)
        .expect("NOISE_SNI 必须是合法的 DNS 名 / must be a valid DNS name")
}

/// 只信任「指纹等于本地派生值」的对端证书。
///
/// 与「跳过校验」的区别：
///
/// 1. 证书指纹必须与 `hop_secret` 派生值逐字节相等，否则连接失败；
/// 2. 握手签名（`CertificateVerify`）仍由 rustls 用证书里的公钥做真实验签，
///    所以只有证书副本、没有私钥的冒充者过不了这一步。
///
/// 两个检查缺一不可：只比指纹不验签 = 任何人都能重放公开证书；只验签不固定
/// 指纹 = 接受任意自签证书，等于没有认证。
pub struct PinnedCertVerifier {
    expected: [u8; 32],
    provider: CryptoProvider,
}

impl PinnedCertVerifier {
    pub fn new(expected: [u8; 32]) -> Self {
        Self {
            expected,
            provider: rustls::crypto::ring::default_provider(),
        }
    }
}

impl fmt::Debug for PinnedCertVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PinnedCertVerifier")
            .field("expected", &hex_lower(&self.expected))
            .finish_non_exhaustive()
    }
}

impl ServerCertVerifier for PinnedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let actual = sha256(end_entity.as_ref());
        if actual != self.expected {
            return Err(TlsError::General(format!(
                "QUIC 证书指纹不匹配（hop_secret 不一致或对端不是本链）/ QUIC certificate fingerprint mismatch (hop_secret differs or wrong peer): expected {}, got {}",
                hex_lower(&self.expected),
                hex_lower(&actual)
            )));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        // QUIC 只跑 TLS 1.3，这个回调不会被调用；仍然实现成真实验签，
        // 避免以后有人把同一份校验器接到 TLS 1.2 上时静默放行。
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// 构造 Ed25519 PKCS#8 v1 私钥 DER（RFC 8410）。
///
/// ```text
/// 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 <32 字节种子>
/// ```
///
/// ring 的 `Ed25519KeyPair::from_pkcs8` 接受这个固定前缀；不自己实现
/// 任何密钥运算，只做 Der 封装。
fn ed25519_pkcs8(seed: &[u8; 32]) -> [u8; 48] {
    const PREFIX: [u8; 16] = [
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    let mut der = [0u8; 48];
    der[..PREFIX.len()].copy_from_slice(&PREFIX);
    der[PREFIX.len()..].copy_from_slice(seed);
    der
}

fn hmac_sha256(key: &[u8], label: &[u8]) -> [u8; 32] {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<Sha256>::new_from_slice(key)
        .expect("HMAC-SHA256 接受任意长度密钥 / HMAC accepts keys of any length");
    mac.update(label);
    let digest = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn sha256(input: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(input);
    let mut out = [0u8; 32];
    out.copy_from_slice(&hasher.finalize());
    out
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // 写入 String 不会失败。
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-hop-secret-32-bytes-long!!!";
    const OTHER: &[u8] = b"another-hop-secret-32-bytes!!!!";

    /// 派生是确定性的：同一 hop_secret → 同一证书 DER、同一指纹。
    #[test]
    fn derivation_is_deterministic_for_the_same_secret() {
        let first = derive_identity(SECRET).expect("派生必须成功");
        let second = derive_identity(SECRET).expect("派生必须成功");

        assert_eq!(
            first.certificate().as_ref(),
            second.certificate().as_ref(),
            "同一 hop_secret 必须得到逐字节相同的证书 DER"
        );
        assert_eq!(
            first.fingerprint(),
            second.fingerprint(),
            "同一 hop_secret 必须得到相同的证书指纹"
        );
        assert_eq!(
            first.fingerprint(),
            sha256(first.certificate().as_ref()),
            "指纹必须就是证书 DER 的 SHA-256"
        );
        println!(
            "[noise-quic cert] fingerprint={} der_bytes={}",
            first.fingerprint_hex(),
            first.certificate().as_ref().len()
        );
    }

    /// 不同 hop_secret → 不同证书与不同指纹（两端必须有区分度）。
    #[test]
    fn different_secrets_derive_different_fingerprints() {
        let first = derive_identity(SECRET).expect("派生必须成功");
        let other = derive_identity(OTHER).expect("派生必须成功");

        assert_ne!(
            first.fingerprint(),
            other.fingerprint(),
            "不同 hop_secret 必须得到不同指纹"
        );
        assert_ne!(
            first.certificate().as_ref(),
            other.certificate().as_ref(),
            "不同 hop_secret 必须得到不同证书"
        );
        assert_ne!(
            first.key().secret_der(),
            other.key().secret_der(),
            "不同 hop_secret 必须得到不同私钥"
        );
    }

    /// 空 hop_secret 必须明确失败，不能悄悄派生出一张「谁都能算」的证书。
    #[test]
    fn empty_secret_is_rejected() {
        let error = derive_identity(&[]).expect_err("空 hop_secret 必须失败");
        assert!(
            format!("{error:#}").contains("hop_secret"),
            "错误必须点名 hop_secret：{error:#}"
        );
    }

    /// 私钥是 PKCS#8 且能被再次解析（rcgen 接受 = ring 接受）。
    #[test]
    fn derived_key_is_a_parseable_pkcs8_private_key() {
        let identity = derive_identity(SECRET).expect("派生必须成功");
        let key = identity.key();
        let PrivateKeyDer::Pkcs8(pkcs8) = &key else {
            panic!("派生私钥必须是 PKCS#8");
        };
        let key = KeyPair::from_pkcs8_der_and_sign_algo(pkcs8, &PKCS_ED25519)
            .expect("派生私钥必须能被 rcgen/ring 重新解析");
        assert_eq!(key.algorithm(), &PKCS_ED25519);
    }

    /// 固定 SNI 必须是合法 DNS 名，且是 `.invalid` 保留域。
    #[test]
    fn noise_sni_is_a_valid_reserved_name() {
        assert!(NOISE_SNI.ends_with(".invalid"), "{NOISE_SNI}");
        let name = noise_server_name();
        assert_eq!(name.to_str().as_ref(), NOISE_SNI);
    }
}
