//! P16 隧道的自有 CA 与服务器属证书签发。
//!
//! 设计约束（docs/PLAN.md P16 §4/§6）：
//!
//! * **主控是唯一的签发者**：CA 私钥只留在主控数据库里，绝不通过
//!   `DesiredState.files` 下发；
//! * 每台服务器一张属证书，SAN 精确等于它的 `address`（IP 或域名），
//!   因此 Dialer 用 `remote` 的主机名做标准 rustls 校验即可；
//! * 地址变化或证书临近过期时自动重签，旧证书由 Agent 下次 `apply_files`
//!   覆盖；
//! * 证书/私钥写入路径与权限由这里统一决定：Listener 拿 cert+key（0600），
//!   Dialer 只拿 ca.pem（0644）。
//!
//! 不实现任何 AEAD/KDF：签名与证书编码都由 `rcgen` + `ring` 完成。

use std::collections::HashMap;

use anyhow::{Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose,
};
use sqlx::SqlitePool;

use pierwave_domain::repo;

/// 隧道证书在 Agent 上的固定目录。与 xray 节点证书分开，便于按整目录清理。
pub const TUNNEL_DIR: &str = "/usr/local/etc/pierwave/tunnel";

/// CA 文件路径（Dialer 信任根，0644）。
pub fn ca_path() -> String {
    format!("{TUNNEL_DIR}/ca.pem")
}

/// 一台服务器的属证书路径（Listener，0600）。
pub fn cert_path(server_id: &str) -> String {
    format!("{TUNNEL_DIR}/{server_id}.pem")
}

/// 一台服务器的私钥路径（Listener，0600）。
pub fn key_path(server_id: &str) -> String {
    format!("{TUNNEL_DIR}/{server_id}.key")
}

/// Listener 的证书文件权限。证书本身是公开材料，但这里与私钥同目录，
/// 统一 0600 降低误读风险（需求明确要求 Listener 拿 cert+key 0600）。
pub const CERT_FILE_MODE: u32 = 0o600;
/// 私钥权限。
pub const KEY_FILE_MODE: u32 = 0o600;
/// CA 是公开信任根，Dialer 需要可读。
pub const CA_FILE_MODE: u32 = 0o644;

/// 一张服务器属证书（PEM）。
#[derive(Debug, Clone)]
pub struct ServerCert {
    pub cert_pem: String,
    pub key_pem: String,
}

/// 一条链需要的全部证书材料（CA + 每个成员一张属证书）。
#[derive(Debug, Clone)]
pub struct ChainAssets {
    pub ca_pem: String,
    pub servers: HashMap<String, ServerCert>,
}

impl ChainAssets {
    pub fn server(&self, server_id: &str) -> Option<&ServerCert> {
        self.servers.get(server_id)
    }
}

/// 读取或生成单例 CA，返回 PEM。
pub async fn ensure_ca(pool: &SqlitePool) -> Result<(String, String)> {
    if let Some(ca) = repo::tunnel::get_ca(pool).await? {
        return Ok((ca.cert_pem, ca.key_pem));
    }

    let key =
        KeyPair::generate().context("生成隧道 CA 私钥失败 / failed to generate tunnel CA key")?;
    let params = ca_params();
    let cert = params
        .self_signed(&key)
        .context("自签隧道 CA 失败 / failed to self-sign tunnel CA")?;
    let ca = repo::tunnel::put_ca_if_absent(pool, &cert.pem(), &key.serialize_pem()).await?;
    Ok((ca.cert_pem, ca.key_pem))
}

/// 确保某台服务器有一张与 `subject`（服务器地址）匹配、且未临近过期的属证书。
pub async fn ensure_server_cert(
    pool: &SqlitePool,
    server_id: &str,
    subject: &str,
    now: i64,
) -> Result<ServerCert> {
    let subject = subject.trim();
    if subject.is_empty() {
        anyhow::bail!("服务器地址为空，无法签发隧道证书 / server address is empty");
    }

    // 提前 7 天重签，避免刚好在链路上过期。
    const RENEW_BEFORE_SECS: i64 = 7 * 24 * 60 * 60;
    if let Some(existing) = repo::tunnel::get_server_cert(pool, server_id).await? {
        if existing.subject == subject && existing.not_after > now + RENEW_BEFORE_SECS {
            return Ok(ServerCert {
                cert_pem: existing.cert_pem,
                key_pem: existing.key_pem,
            });
        }
    }

    let (_ca_cert_pem, ca_key_pem) = ensure_ca(pool).await?;
    let ca_key = KeyPair::from_pem(&ca_key_pem)
        .context("解析隧道 CA 私钥失败 / failed to parse tunnel CA key")?;
    let ca_params = ca_params();
    let issuer = Issuer::from_params(&ca_params, &ca_key);

    let key =
        KeyPair::generate().context("生成服务器属证书私钥失败 / failed to generate server key")?;
    let mut params = CertificateParams::new(vec![subject.to_string()])
        .with_context(|| format!("服务器地址无法作为证书 SAN: {subject}"))?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, format!("pierwave-tunnel-{server_id}"));
    params.distinguished_name = dn;
    params.is_ca = IsCa::NoCa;
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let not_after = now + 5 * 365 * 24 * 60 * 60;
    params.not_before = offset_now() - time::Duration::days(1);
    params.not_after = offset_now() + time::Duration::days(5 * 365);
    let cert = params
        .signed_by(&key, &issuer)
        .context("用隧道 CA 签发服务器证书失败 / failed to sign server certificate")?;
    let cert_pem = cert.pem();
    let key_pem = key.serialize_pem();
    let stored =
        repo::tunnel::put_server_cert(pool, server_id, &cert_pem, &key_pem, subject, not_after)
            .await?;

    Ok(ServerCert {
        cert_pem: stored.cert_pem,
        key_pem: stored.key_pem,
    })
}

fn offset_now() -> time::OffsetDateTime {
    time::OffsetDateTime::now_utc()
}

/// CA 的固定参数。重签属证书时用同一份 DN，保证 issuer 字段与 CA 一致。
fn ca_params() -> CertificateParams {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "PierWave Tunnel CA");
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params.not_before = offset_now() - time::Duration::days(1);
    params.not_after = offset_now() + time::Duration::days(3650);
    params
}

/// 为一条 2 跳链确保 CA 与两台服务器的属证书。
///
/// 调用方已经完成「2 跳、单成员、能力可用」的校验；这里只负责材料。
pub async fn ensure_chain_assets(
    pool: &SqlitePool,
    groups: &[pierwave_domain::models::ChainGroupWithMembers],
    now: i64,
) -> Result<ChainAssets> {
    let (ca_pem, _) = ensure_ca(pool).await?;
    let mut servers = HashMap::new();
    for member in groups.iter().flat_map(|group| group.members.iter()) {
        let cert = ensure_server_cert(pool, &member.server_id, &member.server_address, now).await?;
        servers.insert(member.server_id.clone(), cert);
    }
    Ok(ChainAssets { ca_pem, servers })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_stable_and_under_the_tunnel_directory() {
        assert_eq!(ca_path(), "/usr/local/etc/pierwave/tunnel/ca.pem");
        assert_eq!(
            cert_path("srv-1"),
            "/usr/local/etc/pierwave/tunnel/srv-1.pem"
        );
        assert_eq!(
            key_path("srv-1"),
            "/usr/local/etc/pierwave/tunnel/srv-1.key"
        );
        assert_eq!(CERT_FILE_MODE, 0o600);
        assert_eq!(KEY_FILE_MODE, 0o600);
        assert_eq!(CA_FILE_MODE, 0o644);
    }
}
