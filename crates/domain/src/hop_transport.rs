//! 跳间 TLS：模式取值、transport 串生成、证书/SNI 校验与逐跳推导。
//!
//! 这一层是**纯逻辑**：不查库、不碰网络，输入是已读出的 `Certificate` 行与链的组，
//! 输出是每个组该用的 `HopTransport`（`listen_transport` / `remote_transport` /
//! `disable_udp`）。
//!
//! 为什么 transport 串只能由这里生成：realm 把字符串原样交给 kaminari 解析，
//! 写错不会报错、只会**静默变成明文**（例如 `wss;` 不是合法 token）。因此：
//!
//! * 只提供 `tls_server` / `tls_client` 两个构造器，永不产出 `ws` / `wss`；
//! * 路径只允许 `[A-Za-z0-9/._-]`，SNI 只允许合法 DNS 名，从根上消除 `;` 注入；
//! * 加密端点一律 `disable_udp = true`：UDP 不走 transport，不关就是明文穿透。
//!
//! 证书的硬性要求来自 realm 2.9.6 的客户端实现：它只信任编译进二进制的 Mozilla
//! 根，没有自定义 CA 选项，所以只能用公网 CA 证书（自签 + `insecure` 被明确禁止）。

use serde_json::json;

use crate::certificate::{self, CertError};
use crate::error::DomainError;
use crate::models::Certificate;

/// 不加密（默认）。
pub const NONE: &str = "none";
/// 单向 TLS。
pub const TLS: &str = "tls";
/// 合法的加密模式，错误提示里按顺序展示。
pub const NAMES: [&str; 2] = [NONE, TLS];
/// 新建链的默认值：与升级前完全一致。
pub const DEFAULT: &str = NONE;

/// 严格解析加密模式：只接受 `none` / `tls`（去掉首尾空白后完全匹配）。
pub fn normalize(raw: &str) -> Result<String, DomainError> {
    let mode = raw.trim();
    match mode {
        NONE | "" => Ok(NONE.to_string()),
        TLS => Ok(TLS.to_string()),
        other => Err(DomainError::with_params(
            "chain.transport_invalid",
            json!({ "transport": other, "allowed": NAMES }),
            format!("链的加密模式「{other}」无效，只支持 {}", NAMES.join(" / ")),
        )),
    }
}

/// 从数据库读出的模式：非法值回落到 `none`。
///
/// 写路径已经校验过，这里兜底的是历史数据/手工改库；读路径不能让一个脏值
/// 让整份期望态下发失败（回落明文只影响该链，而且明文是显式选项）。
pub fn from_db(raw: &str) -> &'static str {
    if raw.trim() == TLS {
        TLS
    } else {
        NONE
    }
}

/// 是否是加密链（Agent/主控都只做这一个布尔判断）。
pub fn is_tls(raw: &str) -> bool {
    from_db(raw) == TLS
}

/// 一个已校验的组证书事实。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupCertificate {
    pub cert_id: String,
    pub cert_path: String,
    pub key_path: String,
    /// 证书里的域名（DNS SAN，原样保留）。
    pub domains: Vec<String>,
    /// 选定的具体主机名，作为上一跳的 `tls;sni=`（绝不放通配符本身）。
    pub sni: String,
}

/// 一个组（同一组的所有成员共用）的 transport 配置。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HopTransport {
    /// 本组监听的 transport；`None` = 明文监听（入口组永远是明文）。
    pub listen: Option<String>,
    /// 本组出站的 transport；`None` = 明文出站（落地组到目标永远是明文）。
    pub remote: Option<String>,
    /// 是否必须给该端点写 `network = { use_udp = false }`。
    pub disable_udp: bool,
}

/// 一条链的组证书识别结果；`groups[0]` 必须是 `None`（入口组明文）。
pub type GroupCerts = Vec<Option<GroupCertificate>>;

/// 生成 realm 的**服务端** transport 串：`tls;cert=<pem>;key=<key>`。
///
/// 两个字段缺一不可（realm 会在解析阶段 panic 退出）。路径只允许固定字符集，
/// 因此 `;` / 空白 / 引号无法注入额外的 token。
pub fn tls_server(cert_path: &str, key_path: &str) -> Result<String, DomainError> {
    validate_path(cert_path)?;
    validate_path(key_path)?;
    Ok(format!("tls;cert={cert_path};key={key_path}"))
}

/// 生成 realm 的**客户端** transport 串：`tls;sni=<domain>`。
///
/// SNI 必填（缺了 realm 会 panic）；IP 字面量拒绝——webpki 按 DNS 名校验证书，
/// 而且本期要求用证书里的公网域名做身份校验。
pub fn tls_client(sni: &str) -> Result<String, DomainError> {
    if is_ip_literal(sni) {
        return Err(DomainError::with_params(
            "chain.tls_sni_invalid",
            json!({ "sni": sni }),
            format!("SNI「{sni}」不能是 IP 地址，必须使用证书里的 DNS 域名"),
        ));
    }
    if !is_valid_dns_name(sni) {
        return Err(DomainError::with_params(
            "chain.tls_sni_invalid",
            json!({ "sni": sni }),
            format!("SNI「{sni}」不是合法的 DNS 域名"),
        ));
    }
    Ok(format!("tls;sni={}", sni.to_ascii_lowercase()))
}

fn validate_path(path: &str) -> Result<(), DomainError> {
    let ok = !path.is_empty()
        && path.len() <= 4096
        && path
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-'));
    if ok {
        return Ok(());
    }
    Err(DomainError::with_params(
        "chain.tls_transport_invalid",
        json!({ "value": path }),
        format!("证书路径「{path}」不合法（只允许字母、数字与 / . _ -）"),
    ))
}

/// SNI / 主机名是否是 IP 字面量（含方括号 IPv6）。
pub fn is_ip_literal(raw: &str) -> bool {
    let trimmed = raw.trim();
    let bare = trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(trimmed);
    bare.parse::<std::net::IpAddr>().is_ok()
}

/// 是否是语法合法的 DNS 主机名（不含通配符）。
///
/// 规则与 RFC 1123 对齐：总长 1..=253，每段 1..=63，字母数字与 `-`，
/// 段首尾不能是 `-`。故意不接受空串、空白、下划线与单个点。
pub fn is_valid_dns_name(raw: &str) -> bool {
    let name = raw.trim();
    if name.is_empty() || name.len() > 253 || name != raw {
        return false;
    }
    if name.ends_with('.') {
        return false;
    }
    name.split('.').all(|label| {
        (1..=63).contains(&label.len())
            && label
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

/// 证书 SAN 是否覆盖某个具体主机名。
///
/// * 大小写不敏感（DNS 不区分大小写）；
/// * `*.example.com` 只匹配**一层**子域：`hop1.example.com` 可以，
///   `a.b.example.com` 不行（与 webpki 的规则一致）；
/// * IP 字面量一律返回 `false`（本期不用 IP SAN）。
pub fn sni_matches(san: &str, name: &str) -> bool {
    let san = san.trim().to_ascii_lowercase();
    let name = name.trim().to_ascii_lowercase();
    if name.is_empty() || is_ip_literal(&name) || san.is_empty() {
        return false;
    }
    match san.strip_prefix("*.") {
        Some(suffix) => {
            let suffix = format!(".{suffix}");
            match name.strip_suffix(&suffix) {
                Some(label) => !label.is_empty() && !label.contains('.'),
                None => false,
            }
        }
        None => san == name,
    }
}

/// 从证书的 DNS SAN 里选一个**具体**主机名作为 SNI。
///
/// 通配符不能自己做 SNI（`sni=*.example.com` 会被 webpki 拒绝），所以优先取
/// 第一个非通配符名字；只有通配符时明确报错，而不是悄悄选一个不能用的值。
pub fn select_sni(domains: &[String], cert_name: &str) -> Result<String, DomainError> {
    if domains.is_empty() {
        return Err(DomainError::with_params(
            "chain.tls_cert_no_dns_san",
            json!({ "name": cert_name }),
            format!("证书「{cert_name}」没有 DNS SAN，不能用于跳间 TLS"),
        ));
    }
    let mut concrete: Option<&str> = None;
    let mut wildcard_only = true;
    for domain in domains {
        let domain = domain.trim();
        if domain.is_empty() || domain.starts_with("*.") {
            continue;
        }
        wildcard_only = false;
        if concrete.is_none() {
            concrete = Some(domain);
        }
        if is_ip_literal(domain) || !is_valid_dns_name(domain) {
            continue;
        }
        return Ok(domain.to_ascii_lowercase());
    }
    if wildcard_only {
        return Err(DomainError::with_params(
            "chain.tls_cert_wildcard_only",
            json!({ "name": cert_name, "domains": domains }),
            format!("证书「{cert_name}」只有通配符 SAN，不能直接作为 SNI，请改用具体域名"),
        ));
    }
    let domain = concrete.unwrap_or_default();
    Err(DomainError::with_params(
        "chain.tls_cert_domain_invalid",
        json!({ "domain": domain, "name": cert_name }),
        format!("证书「{cert_name}」的 DNS SAN「{domain}」不是可用的具体域名"),
    ))
}

/// 校验一张证书能否用于跳间 TLS，并返回选定的 SNI 与落盘路径。
///
/// 复用 [`certificate::parse`]：PEM 可解析、私钥与证书匹配、有效期。额外要求
/// 有 DNS SAN 且能选出一个具体域名。`now` 是调用时刻的 Unix 秒。
///
/// 过期边界按「`not_after <= now` 即过期」处理：与 realm/webpki 的行为一致，
/// 不让「刚好这一秒到期」的证书被下发。
pub fn validate_certificate(cert: &Certificate, now: i64) -> Result<GroupCertificate, DomainError> {
    let parsed = certificate::parse(&cert.cert_pem, &cert.key_pem)
        .map_err(|error| cert_error(&cert.name, error))?;
    if parsed.not_after <= now {
        return Err(DomainError::with_params(
            "chain.tls_cert_expired",
            json!({ "name": cert.name, "not_after": parsed.not_after }),
            format!(
                "证书「{}」已过期（到期时间 {}），不能用于跳间 TLS",
                cert.name, parsed.not_after
            ),
        ));
    }
    let sni = select_sni(&parsed.domains, &cert.name)?;
    Ok(GroupCertificate {
        cert_id: cert.id.clone(),
        cert_path: certificate::cert_file_path(&cert.id),
        key_path: certificate::key_file_path(&cert.id),
        domains: parsed.domains,
        sni,
    })
}

fn cert_error(name: &str, error: CertError) -> DomainError {
    let (code, message) = match error {
        CertError::KeyMismatch => (
            "chain.tls_cert_key_mismatch",
            format!("证书「{name}」与私钥不匹配"),
        ),
        CertError::EncryptedKey => (
            "chain.tls_cert_invalid",
            format!("证书「{name}」的私钥是加密的，realm 无法使用"),
        ),
        CertError::BadCertPem | CertError::BadKeyPem => (
            "chain.tls_cert_invalid",
            format!("证书「{name}」或它的私钥无法解析"),
        ),
    };
    DomainError::with_params(code, json!({ "name": name }), message)
}

/// 校验某个具体域名确实在证书 SAN 里（精确或单层通配符）。
///
/// 主控自动从 SAN 里选 SNI，正常不会失败；保留这个纯函数是为了在推导时
/// 做一次防御性断言，并给「手工改库/未来允许用户选域名」留出统一校验点。
pub fn check_certificate_sni(cert: &Certificate, sni: &str) -> Result<(), DomainError> {
    if is_ip_literal(sni) {
        return Err(DomainError::with_params(
            "chain.tls_cert_domain_invalid",
            json!({ "domain": sni }),
            format!("SNI「{sni}」不能是 IP 地址"),
        ));
    }
    let parsed = certificate::parse(&cert.cert_pem, &cert.key_pem)
        .map_err(|error| cert_error(&cert.name, error))?;
    if parsed.domains.iter().any(|san| sni_matches(san, sni)) {
        return Ok(());
    }
    Err(DomainError::with_params(
        "chain.tls_cert_domain_invalid",
        json!({ "domain": sni, "name": cert.name }),
        format!("域名「{sni}」不在证书「{}」的 SAN 中", cert.name),
    ))
}

/// 链级前置校验：模式与引擎/组数/UDP/每组证书是否自洽。
///
/// `group_certs` 按 seq 升序，元素是写路径收到的 `cert_id`（已 trim，空串视为
/// `None`）。入口组（下标 0）永远不允许有证书；`tls` 时每个 seq >= 1 的组必填。
/// 证书**内容**（过期/域名/私钥）由 [`validate_certificate`] 另行校验。
pub fn validate_chain(
    transport: &str,
    engine: &str,
    udp: bool,
    group_certs: &[Option<&str>],
) -> Result<(), DomainError> {
    let mode = normalize(transport)?;
    if group_certs
        .first()
        .and_then(|cert| cert.as_deref())
        .is_some_and(|cert| !cert.trim().is_empty())
    {
        return Err(DomainError::new(
            "chain.tls_group_cert_forbidden",
            "入口组不需要证书：入口监听始终是明文",
        ));
    }
    if mode != TLS {
        return Ok(());
    }
    if !crate::engine::is_realm(engine) {
        return Err(DomainError::new(
            "chain.tls_requires_realm",
            "只有 realm 引擎的链才能启用跳间加密",
        ));
    }
    if group_certs.len() < 2 {
        return Err(DomainError::new(
            "chain.tls_requires_two_hops",
            "至少两跳的链才有跳间链路",
        ));
    }
    if udp {
        return Err(DomainError::new(
            "chain.tls_udp_unsupported",
            "加密链不支持 UDP，请关闭该链的 UDP",
        ));
    }
    for (seq, cert) in group_certs.iter().enumerate().skip(1) {
        if cert.is_none_or(|cert| cert.trim().is_empty()) {
            return Err(DomainError::with_params(
                "chain.tls_group_cert_required",
                json!({ "seq": seq }),
                format!("第 {} 组缺少证书", seq + 1),
            ));
        }
    }
    Ok(())
}

/// 逐组推导 transport。
///
/// * 组 0（入口）：只加密**出站**，`listen` 保持明文；
/// * 组 i：`listen` 用本组证书，`remote` 用下一组证书的 SNI；
/// * 最后一组：只加密**入站**，到目标仍是明文；
/// * 所有组的 `disable_udp` 都是 `true`（UDP 不走 transport）。
///
/// 调用方传空切片表示明文链（此时返回空 Vec）。
pub fn derive_hop_transports(
    groups: &[Option<GroupCertificate>],
) -> Result<Vec<HopTransport>, DomainError> {
    if groups.is_empty() {
        return Ok(Vec::new());
    }
    if groups[0].is_some() {
        return Err(DomainError::new(
            "chain.tls_group_cert_forbidden",
            "入口组不需要证书：入口监听始终是明文",
        ));
    }
    let remote = |seq: usize| -> Result<Option<String>, DomainError> {
        match groups.get(seq + 1).and_then(|next| next.as_ref()) {
            Some(next) => Ok(Some(tls_client(&next.sni)?)),
            None => Ok(None),
        }
    };
    let mut transports = Vec::with_capacity(groups.len());
    for (seq, group) in groups.iter().enumerate() {
        if seq == 0 {
            // 入口组不挂证书：监听保持明文，只加密出站。
            transports.push(HopTransport {
                listen: None,
                remote: remote(seq)?,
                disable_udp: true,
            });
            continue;
        }
        let Some(cert) = group else {
            return Err(DomainError::with_params(
                "chain.tls_group_cert_required",
                json!({ "seq": seq }),
                format!("第 {} 组缺少证书", seq + 1),
            ));
        };
        // 上一跳会拿这个 SNI 去验本组证书；这里再断言一次，防止选错域名。
        if !cert.domains.iter().any(|san| sni_matches(san, &cert.sni)) {
            return Err(DomainError::with_params(
                "chain.tls_cert_domain_invalid",
                json!({ "domain": cert.sni, "name": cert.cert_id }),
                format!("域名「{}」不在组证书的 SAN 中", cert.sni),
            ));
        }
        transports.push(HopTransport {
            listen: Some(tls_server(&cert.cert_path, &cert.key_path)?),
            remote: remote(seq)?,
            disable_udp: true,
        });
    }
    Ok(transports)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CERT_PEM: &str = include_str!("../tests/fixtures/test-cert.pem");
    const KEY_PEM: &str = include_str!("../tests/fixtures/test-key.pem");
    const OTHER_KEY_PEM: &str = include_str!("../tests/fixtures/test-other-key.pem");
    const EXPIRED_CERT_PEM: &str = include_str!("../tests/fixtures/test-expired-cert.pem");
    const EXPIRED_KEY_PEM: &str = include_str!("../tests/fixtures/test-expired-key.pem");
    /// fixture 的 `not_after`（2036-11-02），测试里用来构造过期边界。
    const NOT_AFTER: i64 = 2_109_208_713;

    fn certificate(id: &str) -> Certificate {
        Certificate {
            id: id.into(),
            name: format!("cert-{id}"),
            domains: r#"["example.com","www.example.com"]"#.into(),
            cert_pem: CERT_PEM.into(),
            key_pem: KEY_PEM.into(),
            not_before: 1_793_341_113,
            not_after: NOT_AFTER,
            created_at: 0,
        }
    }

    fn group(cert_id: &str, sni: &str, domains: &[&str]) -> Option<GroupCertificate> {
        Some(GroupCertificate {
            cert_id: cert_id.into(),
            cert_path: certificate::cert_file_path(cert_id),
            key_path: certificate::key_file_path(cert_id),
            domains: domains.iter().map(|domain| (*domain).to_string()).collect(),
            sni: sni.into(),
        })
    }

    #[test]
    fn transport_modes_accept_only_none_and_tls() {
        assert_eq!(normalize("none").unwrap(), "none");
        assert_eq!(normalize("").unwrap(), "none", "空串按默认明文处理");
        assert_eq!(normalize(" tls ").unwrap(), "tls", "允许首尾空白");
        for bad in ["TLS", "plaintext", "ws", "wss", "tls,ws"] {
            let error = normalize(bad).unwrap_err();
            assert_eq!(error.code, "chain.transport_invalid", "bad={bad:?}");
            assert!(
                error.message.contains("只支持 none / tls"),
                "{}",
                error.message
            );
        }
        assert_eq!(from_db("tls"), "tls");
        assert_eq!(from_db("wss"), "none");
        assert!(is_tls("tls"));
        assert!(!is_tls(""));
    }

    #[test]
    fn transport_builders_are_byte_stable() {
        assert_eq!(
            tls_server(
                "/usr/local/etc/xray/certs/a.pem",
                "/usr/local/etc/xray/certs/a.key"
            )
            .unwrap(),
            "tls;cert=/usr/local/etc/xray/certs/a.pem;key=/usr/local/etc/xray/certs/a.key"
        );
        assert_eq!(
            tls_client("Hop1.Example.COM").unwrap(),
            "tls;sni=hop1.example.com",
            "SNI 统一小写"
        );
    }

    #[test]
    fn transport_builders_reject_injection_and_missing_fields() {
        // 路径里出现 `;` / 空白 / 引号会注入 token 或破坏 realm 解析。
        for bad in [
            "",
            "/tmp/a;key=/tmp/b",
            "/tmp/a b",
            "/tmp/a\"b",
            "/tmp/a\nb",
            "/tmp/a=b",
        ] {
            let error = tls_server(bad, "/tmp/a.key").unwrap_err();
            assert_eq!(error.code, "chain.tls_transport_invalid", "bad={bad:?}");
        }
        let error = tls_server("/tmp/a.pem", "").unwrap_err();
        assert_eq!(error.code, "chain.tls_transport_invalid");

        // SNI 必填、必须是 DNS 名、不能是 IP。
        for bad in [
            "",
            "  ",
            "a b",
            "a;b",
            "-bad.example.com",
            "bad-.example.com",
            "1.2.3.4",
            "[::1]",
        ] {
            let error = tls_client(bad).unwrap_err();
            assert_eq!(error.code, "chain.tls_sni_invalid", "bad={bad:?}");
        }
        // wss 永远不会被生成。
        assert!(!tls_client("hop1.example.com").unwrap().contains("wss"));
        assert!(!tls_server("/a.pem", "/a.key").unwrap().contains("wss"));
    }

    #[test]
    fn sni_matching_is_case_insensitive_and_single_level_for_wildcards() {
        assert!(sni_matches("example.com", "example.com"));
        assert!(sni_matches("Example.COM", "example.com"));
        assert!(!sni_matches("example.com", "www.example.com"));
        assert!(sni_matches("*.example.com", "hop1.example.com"));
        assert!(sni_matches("*.Example.com", "HOP1.example.com"));
        assert!(
            !sni_matches("*.example.com", "a.b.example.com"),
            "通配符只匹配一层子域"
        );
        assert!(!sni_matches("*.example.com", "example.com"));
        assert!(!sni_matches("*.example.com", ".example.com"));
        assert!(
            !sni_matches("*.example.com", "1.2.3.4"),
            "IP 字面量永远不匹配"
        );
        assert!(!sni_matches("1.2.3.4", "1.2.3.4"), "IP SAN 不作为本期路径");
    }

    #[test]
    fn dns_names_and_ip_literals() {
        assert!(is_valid_dns_name("hop1.example.com"));
        assert!(is_valid_dns_name("a-b.example.com"));
        assert!(is_valid_dns_name("localhost"));
        for bad in [
            "",
            " example.com",
            "example.com ",
            "example..com",
            "example.com.",
            "-a.com",
            "a-.com",
            "a_b.com",
            "* .example.com",
            "*.example.com",
        ] {
            assert!(!is_valid_dns_name(bad), "bad={bad:?}");
        }
        assert!(is_ip_literal("1.2.3.4"));
        assert!(is_ip_literal("2001:db8::1"));
        assert!(is_ip_literal("[2001:db8::1]"));
        assert!(!is_ip_literal("hop1.example.com"));
    }

    #[test]
    fn select_sni_prefers_a_concrete_name_and_rejects_wildcard_only() {
        assert_eq!(
            select_sni(&["example.com".into(), "www.example.com".into()], "cert").unwrap(),
            "example.com"
        );
        assert_eq!(
            select_sni(&["*.example.com".into(), "hop1.example.com".into()], "cert").unwrap(),
            "hop1.example.com",
            "跳过通配符，选具体主机名"
        );
        assert_eq!(
            select_sni(&["192.0.2.1".into()], "cert").unwrap_err().code,
            "chain.tls_cert_domain_invalid",
            "IP SAN 不能作为 SNI"
        );
        assert_eq!(
            select_sni(&[], "cert").unwrap_err().code,
            "chain.tls_cert_no_dns_san"
        );
        assert_eq!(
            select_sni(&["*.example.com".into()], "cert")
                .unwrap_err()
                .code,
            "chain.tls_cert_wildcard_only"
        );
    }

    #[test]
    fn certificate_validation_checks_expiry_domains_and_key_pair() {
        let cert = certificate("c1");
        let valid = validate_certificate(&cert, 1_800_000_000).unwrap();
        assert_eq!(valid.sni, "example.com");
        assert_eq!(valid.cert_path, "/usr/local/etc/xray/certs/c1.pem");
        assert_eq!(valid.key_path, "/usr/local/etc/xray/certs/c1.key");

        // 过期边界：not_after == now 即过期。
        let error = validate_certificate(&cert, NOT_AFTER).unwrap_err();
        assert_eq!(error.code, "chain.tls_cert_expired");
        assert!(error.message.contains("已过期"), "{}", error.message);
        assert!(validate_certificate(&cert, NOT_AFTER - 1).is_ok());

        // 真正过期（PEM 的 not_after 在过去）：不能只看数据库列。
        let expired = Certificate {
            cert_pem: EXPIRED_CERT_PEM.into(),
            key_pem: EXPIRED_KEY_PEM.into(),
            ..certificate("c-expired")
        };
        let error = validate_certificate(&expired, 1_800_000_000).unwrap_err();
        assert_eq!(error.code, "chain.tls_cert_expired");
        assert_eq!(error.params["not_after"], 1_609_459_200_i64);

        // 私钥不匹配。
        let mismatched = Certificate {
            key_pem: OTHER_KEY_PEM.into(),
            ..certificate("c2")
        };
        assert_eq!(
            validate_certificate(&mismatched, 1_800_000_000)
                .unwrap_err()
                .code,
            "chain.tls_cert_key_mismatch"
        );

        // 证书 PEM 坏了。
        let broken = Certificate {
            cert_pem: "not-a-pem".into(),
            ..certificate("c3")
        };
        assert_eq!(
            validate_certificate(&broken, 1_800_000_000)
                .unwrap_err()
                .code,
            "chain.tls_cert_invalid"
        );
    }

    #[test]
    fn certificate_sni_must_be_covered_by_san() {
        let cert = certificate("c1");
        check_certificate_sni(&cert, "www.example.com").unwrap();
        check_certificate_sni(&cert, "EXAMPLE.com").unwrap();
        assert_eq!(
            check_certificate_sni(&cert, "hop1.example.com")
                .unwrap_err()
                .code,
            "chain.tls_cert_domain_invalid"
        );
        assert_eq!(
            check_certificate_sni(&cert, "1.2.3.4").unwrap_err().code,
            "chain.tls_cert_domain_invalid"
        );
    }

    #[test]
    fn chain_rules_cover_engine_hops_udp_and_certs() {
        let certs = [None, Some("c1"), Some("c2")];
        validate_chain("tls", "realm", false, &certs).unwrap();
        validate_chain("none", "native", true, &[None, None]).unwrap();
        validate_chain("none", "realm", true, &[None]).unwrap();

        assert_eq!(
            validate_chain("tls", "native", false, &certs)
                .unwrap_err()
                .code,
            "chain.tls_requires_realm"
        );
        assert_eq!(
            validate_chain("tls", "realm", false, &[None])
                .unwrap_err()
                .code,
            "chain.tls_requires_two_hops"
        );
        assert_eq!(
            validate_chain("tls", "realm", true, &certs)
                .unwrap_err()
                .code,
            "chain.tls_udp_unsupported"
        );
        assert_eq!(
            validate_chain("tls", "realm", false, &[None, None, Some("c2")])
                .unwrap_err()
                .code,
            "chain.tls_group_cert_required"
        );
        assert_eq!(
            validate_chain("none", "realm", false, &[Some("c0")])
                .unwrap_err()
                .code,
            "chain.tls_group_cert_forbidden",
            "入口组在任何模式下都不允许挂证书"
        );
        assert_eq!(
            validate_chain("tls", "realm", false, &[Some("c0"), Some("c1")])
                .unwrap_err()
                .code,
            "chain.tls_group_cert_forbidden"
        );
    }

    #[test]
    fn two_group_mapping_encrypts_only_the_entry_exit() {
        let transports =
            derive_hop_transports(&[None, group("c1", "hop1.example.com", &["hop1.example.com"])])
                .unwrap();
        assert_eq!(transports.len(), 2);
        assert_eq!(transports[0].listen, None, "入口监听保持明文");
        assert_eq!(
            transports[0].remote.as_deref(),
            Some("tls;sni=hop1.example.com")
        );
        assert!(transports[0].disable_udp);
        assert_eq!(
            transports[1].listen.as_deref(),
            Some("tls;cert=/usr/local/etc/xray/certs/c1.pem;key=/usr/local/etc/xray/certs/c1.key")
        );
        assert_eq!(transports[1].remote, None, "落地到目标是明文");
        assert!(transports[1].disable_udp);
    }

    #[test]
    fn three_group_mapping_chains_listen_and_remote() {
        let transports = derive_hop_transports(&[
            None,
            group("c1", "hop1.example.com", &["hop1.example.com"]),
            group("c2", "hop2.example.com", &["hop2.example.com"]),
        ])
        .unwrap();
        assert_eq!(transports.len(), 3);
        assert_eq!(transports[0].listen, None);
        assert_eq!(
            transports[0].remote.as_deref(),
            Some("tls;sni=hop1.example.com")
        );
        assert_eq!(
            transports[1].listen.as_deref(),
            Some("tls;cert=/usr/local/etc/xray/certs/c1.pem;key=/usr/local/etc/xray/certs/c1.key")
        );
        assert_eq!(
            transports[1].remote.as_deref(),
            Some("tls;sni=hop2.example.com")
        );
        assert_eq!(
            transports[2].listen.as_deref(),
            Some("tls;cert=/usr/local/etc/xray/certs/c2.pem;key=/usr/local/etc/xray/certs/c2.key")
        );
        assert_eq!(transports[2].remote, None);
        assert!(transports.iter().all(|transport| transport.disable_udp));
    }

    #[test]
    fn mapping_refuses_missing_certs_wildcard_sni_and_mismatched_domains() {
        assert_eq!(
            derive_hop_transports(&[None, None]).unwrap_err().code,
            "chain.tls_group_cert_required"
        );
        assert_eq!(
            derive_hop_transports(&[None, group("c1", "*.example.com", &["*.example.com"]),])
                .unwrap_err()
                .code,
            "chain.tls_sni_invalid",
            "通配符不能作为 SNI"
        );
        assert_eq!(
            derive_hop_transports(&[None, group("c1", "hop1.example.com", &["hop2.example.com"]),])
                .unwrap_err()
                .code,
            "chain.tls_cert_domain_invalid",
            "SNI 必须在本组证书 SAN 里"
        );
        assert!(
            derive_hop_transports(&[]).unwrap().is_empty(),
            "明文链不产生 transport"
        );
    }
}
