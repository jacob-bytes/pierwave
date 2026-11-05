//! 证书解析与固定落盘路径。
//!
//! 上传时只做三件事：解析 X.509 拿 SAN / 有效期、校验私钥可用且与证书匹配、
//! 把结果交给仓储落库。这里不碰数据库与 HTTP，解析失败一律返回中文错误，
//! 由 master 映射成 400（不能变成 500）。
//!
//! 匹配策略：
//! * RSA：从证书 SPKI 取 modulus/exponent，与私钥里的对应值逐字节比较；
//! * EC：私钥里带公钥点时与证书 SPKI 的点比较，缺公钥点时只校验 PEM 标签；
//! * 证书与私钥的算法类型不一致时直接判为不匹配；
//! * 加密私钥（`ENCRYPTED PRIVATE KEY`）明确拒绝，避免把无法使用的密钥下发到 Agent。

use x509_parser::certificate::X509Certificate;
use x509_parser::extensions::GeneralName;
use x509_parser::oid_registry::{OID_KEY_TYPE_EC_PUBLIC_KEY, OID_PKCS1_RSAENCRYPTION};
use x509_parser::parse_x509_certificate;
use x509_parser::pem::parse_x509_pem;
use x509_parser::public_key::PublicKey;

/// 证书落盘目录（Agent 侧 Xray 的工作目录约定）。
pub const CERT_DIR: &str = "/usr/local/etc/xray/certs";
/// 证书文件权限：证书是公开信息，允许同组/其他读。
pub const CERT_FILE_MODE: u32 = 0o644;
/// 私钥文件权限：只允许属主读写。
pub const KEY_FILE_MODE: u32 = 0o600;
/// 概览告警阈值：30 天内到期（含已过期）。
pub const EXPIRING_DAYS: i64 = 30;

const DAY_SECS: i64 = 86_400;

pub fn cert_file_path(cert_id: &str) -> String {
    format!("{CERT_DIR}/{cert_id}.pem")
}

pub fn key_file_path(cert_id: &str) -> String {
    format!("{CERT_DIR}/{cert_id}.key")
}

/// 剩余天数口径：`(not_after - now) / 86400`，按整 24 小时向下取整。
///
/// * 纯 UTC 秒差，不做时区转换（证书有效期是绝对时刻，不是业务日）；
/// * 已过期返回负数（例如 -1 表示过期不到一天），便于前端区分「即将过期/已过期」；
/// * 30 天整为 `30`，30 天零 1 秒为 `30`，29 天 23 小时为 `29`。
pub fn days_left(not_after: i64, now: i64) -> i64 {
    (not_after - now).div_euclid(DAY_SECS)
}

/// 是否应在概览里告警：30 天内到期（含已经过期）。
pub fn is_expiring(not_after: i64, now: i64) -> bool {
    not_after - now <= EXPIRING_DAYS * DAY_SECS
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CertError {
    #[error("证书 PEM 无法解析，请上传有效的 X.509 证书")]
    BadCertPem,
    #[error("私钥 PEM 无法解析，请上传 PEM 格式的私钥")]
    BadKeyPem,
    #[error("不支持加密的私钥，请上传未加密的私钥")]
    EncryptedKey,
    #[error("证书与私钥不匹配")]
    KeyMismatch,
}

/// 一次成功解析的证书事实。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCertificate {
    /// SAN 里的 DNS 域名，按证书出现顺序去重。
    pub domains: Vec<String>,
    pub not_before: i64,
    pub not_after: i64,
}

/// 解析证书 PEM、校验私钥并提取元数据。
pub fn parse(cert_pem: &str, key_pem: &str) -> Result<ParsedCertificate, CertError> {
    let (_, cert_pem_block) =
        parse_x509_pem(cert_pem.trim().as_bytes()).map_err(|_| CertError::BadCertPem)?;
    if cert_pem_block.label != "CERTIFICATE" {
        return Err(CertError::BadCertPem);
    }
    let (_, cert) =
        parse_x509_certificate(&cert_pem_block.contents).map_err(|_| CertError::BadCertPem)?;

    let mut domains: Vec<String> = Vec::new();
    if let Some(san) = cert
        .subject_alternative_name()
        .map_err(|_| CertError::BadCertPem)?
    {
        for name in &san.value.general_names {
            if let GeneralName::DNSName(name) = name {
                let name = name.trim();
                if !name.is_empty() && !domains.iter().any(|existing| existing == name) {
                    domains.push(name.to_string());
                }
            }
        }
    }

    let not_before = cert.validity().not_before.timestamp();
    let not_after = cert.validity().not_after.timestamp();

    verify_key(&cert, key_pem)?;

    Ok(ParsedCertificate {
        domains,
        not_before,
        not_after,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyKind {
    Rsa,
    Ec,
}

fn verify_key(cert: &X509Certificate<'_>, key_pem: &str) -> Result<(), CertError> {
    let (_, pem) = parse_x509_pem(key_pem.trim().as_bytes()).map_err(|_| CertError::BadKeyPem)?;
    let der = pem.contents.as_slice();

    let (key_kind, key_numbers) = match pem.label.as_str() {
        "ENCRYPTED PRIVATE KEY" => return Err(CertError::EncryptedKey),
        "RSA PRIVATE KEY" => (
            KeyKind::Rsa,
            KeyNumbers::Rsa(rsa_private_numbers(der).ok_or(CertError::BadKeyPem)?),
        ),
        "EC PRIVATE KEY" => (KeyKind::Ec, KeyNumbers::Ec(ec_private_point(der))),
        "PRIVATE KEY" => pkcs8_key(der)?,
        _ => return Err(CertError::BadKeyPem),
    };

    let cert_kind = if cert.public_key().algorithm.algorithm == OID_PKCS1_RSAENCRYPTION {
        Some(KeyKind::Rsa)
    } else if cert.public_key().algorithm.algorithm == OID_KEY_TYPE_EC_PUBLIC_KEY {
        Some(KeyKind::Ec)
    } else {
        None
    };

    let Some(cert_kind) = cert_kind else {
        // 未知/不常见算法（如 Ed25519）没有内建比对能力，只保证 PEM 标签合法。
        return Ok(());
    };
    if cert_kind != key_kind {
        return Err(CertError::KeyMismatch);
    }

    match (cert.public_key().parsed(), key_numbers) {
        (Ok(PublicKey::RSA(public)), KeyNumbers::Rsa((modulus, exponent))) => {
            if strip_leading_zero(public.modulus) == modulus
                && strip_leading_zero(public.exponent) == exponent
            {
                Ok(())
            } else {
                Err(CertError::KeyMismatch)
            }
        }
        (Ok(PublicKey::EC(public)), KeyNumbers::Ec(Some(point))) => {
            if public.data() == point {
                Ok(())
            } else {
                Err(CertError::KeyMismatch)
            }
        }
        // EC 私钥没有内嵌公钥点（部分 PKCS#8 写法）：只能信 PEM 标签。
        (Ok(PublicKey::EC(_)), KeyNumbers::Ec(None)) => Ok(()),
        _ => Err(CertError::KeyMismatch),
    }
}

enum KeyNumbers<'a> {
    Rsa((&'a [u8], &'a [u8])),
    Ec(Option<&'a [u8]>),
}

/// 解析 PKCS#8 `PRIVATE KEY`：返回算法类型与可比对的公钥参数。
fn pkcs8_key(der: &[u8]) -> Result<(KeyKind, KeyNumbers<'_>), CertError> {
    let seq = read_sequence(der).ok_or(CertError::BadKeyPem)?;
    let mut reader = DerReader::new(seq);
    let (tag, _version) = reader.next().ok_or(CertError::BadKeyPem)?;
    if tag != DER_INTEGER {
        return Err(CertError::BadKeyPem);
    }
    let (tag, algorithm) = reader.next().ok_or(CertError::BadKeyPem)?;
    if tag != DER_SEQUENCE {
        return Err(CertError::BadKeyPem);
    }
    let (tag, oid) = DerReader::new(algorithm)
        .next()
        .ok_or(CertError::BadKeyPem)?;
    if tag != DER_OID {
        return Err(CertError::BadKeyPem);
    }
    let (tag, private_key) = reader.next().ok_or(CertError::BadKeyPem)?;
    if tag != DER_OCTET_STRING {
        return Err(CertError::BadKeyPem);
    }

    if oid == OID_PKCS1_RSAENCRYPTION.as_bytes() {
        let numbers = rsa_private_numbers(private_key).ok_or(CertError::BadKeyPem)?;
        Ok((KeyKind::Rsa, KeyNumbers::Rsa(numbers)))
    } else if oid == OID_KEY_TYPE_EC_PUBLIC_KEY.as_bytes() {
        Ok((KeyKind::Ec, KeyNumbers::Ec(ec_private_point(private_key))))
    } else {
        Err(CertError::BadKeyPem)
    }
}

/// PKCS#1 RSAPrivateKey ::= SEQUENCE { version, modulus, publicExponent, ... }
fn rsa_private_numbers(der: &[u8]) -> Option<(&[u8], &[u8])> {
    let seq = read_sequence(der)?;
    let mut reader = DerReader::new(seq);
    let (tag, _version) = reader.next()?;
    if tag != DER_INTEGER {
        return None;
    }
    let (tag, modulus) = reader.next()?;
    if tag != DER_INTEGER {
        return None;
    }
    let (tag, exponent) = reader.next()?;
    if tag != DER_INTEGER {
        return None;
    }
    Some((strip_leading_zero(modulus), strip_leading_zero(exponent)))
}

/// SEC1 ECPrivateKey 里可选的 publicKey 位串；缺省返回 `None`。
fn ec_private_point(der: &[u8]) -> Option<&[u8]> {
    let seq = read_sequence(der)?;
    let mut reader = DerReader::new(seq);
    let (tag, _version) = reader.next()?;
    if tag != DER_INTEGER {
        return None;
    }
    let (tag, _private_key) = reader.next()?;
    if tag != DER_OCTET_STRING {
        return None;
    }
    while let Some((tag, value)) = reader.next() {
        // [1] EXPLICIT BIT STRING
        if tag == 0xa1 {
            let (tag, bits) = DerReader::new(value).next()?;
            if tag != DER_BIT_STRING || bits.is_empty() || bits[0] != 0 {
                return None;
            }
            return Some(&bits[1..]);
        }
    }
    None
}

const DER_INTEGER: u8 = 0x02;
const DER_BIT_STRING: u8 = 0x03;
const DER_OCTET_STRING: u8 = 0x04;
const DER_OID: u8 = 0x06;
const DER_SEQUENCE: u8 = 0x30;

fn read_sequence(der: &[u8]) -> Option<&[u8]> {
    let (tag, value) = DerReader::new(der).next()?;
    (tag == DER_SEQUENCE).then_some(value)
}

/// 去掉 DER INTEGER 的正数符号位 0，避免同一把 RSA 密钥因编码差异被误判不匹配。
fn strip_leading_zero(bytes: &[u8]) -> &[u8] {
    let mut index = 0;
    while index + 1 < bytes.len() && bytes[index] == 0 {
        index += 1;
    }
    &bytes[index..]
}

/// 极简 DER TLV 读取器：只支持 definite-length（证书/私钥都是 DER）。
struct DerReader<'a> {
    rest: &'a [u8],
}

impl<'a> DerReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { rest: data }
    }

    fn next(&mut self) -> Option<(u8, &'a [u8])> {
        let tag = *self.rest.first()?;
        let first = *self.rest.get(1)? as usize;
        let (length, header) = if first < 0x80 {
            (first, 2)
        } else {
            let count = first & 0x7f;
            if count == 0 || count > 4 || self.rest.len() < 2 + count {
                return None;
            }
            let mut length = 0usize;
            for index in 0..count {
                length = (length << 8) | self.rest[2 + index] as usize;
            }
            (length, 2 + count)
        };
        let end = header.checked_add(length)?;
        if self.rest.len() < end {
            return None;
        }
        let value = &self.rest[header..end];
        self.rest = &self.rest[end..];
        Some((tag, value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 一次性自签测试证书（CN=example.com，SAN=example.com / www.example.com），
    // 只用于单元测试，不是任何真实环境的密钥。
    pub(crate) const TEST_CERT_PEM: &str = include_str!("../tests/fixtures/test-cert.pem");
    pub(crate) const TEST_KEY_PEM: &str = include_str!("../tests/fixtures/test-key.pem");
    pub(crate) const TEST_OTHER_KEY_PEM: &str =
        include_str!("../tests/fixtures/test-other-key.pem");

    #[test]
    fn parses_san_and_validity() {
        let parsed = parse(TEST_CERT_PEM, TEST_KEY_PEM).unwrap();
        assert_eq!(parsed.domains, vec!["example.com", "www.example.com"]);
        assert!(parsed.not_before > 1_700_000_000);
        assert!(parsed.not_after > parsed.not_before);
    }

    #[test]
    fn rejects_broken_pem() {
        assert_eq!(parse("not-a-pem", TEST_KEY_PEM), Err(CertError::BadCertPem));
        assert_eq!(parse(TEST_CERT_PEM, "not-a-pem"), Err(CertError::BadKeyPem));
        assert_eq!(
            parse(TEST_CERT_PEM, TEST_OTHER_KEY_PEM),
            Err(CertError::KeyMismatch)
        );
    }

    #[test]
    fn days_left_is_floor_of_utc_seconds() {
        assert_eq!(days_left(10 * DAY_SECS, 0), 10);
        assert_eq!(days_left(10 * DAY_SECS + 1, 0), 10);
        assert_eq!(days_left(10 * DAY_SECS - 1, 0), 9);
        assert_eq!(days_left(0, 1), -1);
        assert!(is_expiring(EXPIRING_DAYS * DAY_SECS, 0));
        assert!(!is_expiring(EXPIRING_DAYS * DAY_SECS + 1, 0));
    }

    #[test]
    fn file_paths_and_modes_follow_contract() {
        assert_eq!(
            cert_file_path("abc"),
            "/usr/local/etc/xray/certs/abc.pem".to_string()
        );
        assert_eq!(
            key_file_path("abc"),
            "/usr/local/etc/xray/certs/abc.key".to_string()
        );
        assert_eq!(CERT_FILE_MODE, 0o644);
        assert_eq!(KEY_FILE_MODE, 0o600);
    }
}
