//! 隧道目标白名单（防开放中继）。
//!
//! 服务端在解析出首帧目标地址后**先校验**，不在白名单内立即 CLOSE，
//! 绝不发起任何连接。空列表 = 拒绝一切（fail closed）。
//!
//! 规则语义：
//!
//! * `host` 是 IP 字面量 → 精确匹配这个 IP（`TargetAddr::Ip`）；
//! * `host` 是域名 → 后缀匹配：`example.com` 命中 `example.com` 与
//!   `*.example.com`；`*.example.com` 只命中子域；
//! * `ports = Some((lo, hi))` → 闭区间；`None` = 任意端口；
//! * 非法规则（空 host、`lo > hi`）永远不匹配。
//!
//! 域名比较前统一转小写并去掉末尾的点；不做 DNS 解析，所以不存在
//! 「白名单写域名、实际目标用 IP 绕过」的路径。

use std::net::IpAddr;

use crate::tunnel::framing::TargetAddr;

/// 一条目标白名单规则，与线协议 `pierwave_proto::TunnelTargetRule` 同构。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetRule {
    pub host: String,
    /// 端口闭区间；`None` = 任意端口。
    pub ports: Option<(u16, u16)>,
}

impl TargetRule {
    pub fn new(host: impl Into<String>, ports: Option<(u16, u16)>) -> Self {
        Self {
            host: host.into(),
            ports,
        }
    }

    /// 这条规则是否允许该目标。
    pub fn allows(&self, target: &TargetAddr) -> bool {
        if let Some((low, high)) = self.ports {
            if low > high {
                return false;
            }
        }

        let rule_host = normalize_host(&self.host);
        if rule_host.is_empty() {
            return false;
        }

        if let Ok(rule_ip) = rule_host.parse::<IpAddr>() {
            let TargetAddr::Ip(addr) = target else {
                return false;
            };
            return addr.ip() == rule_ip && self.port_allows(addr.port());
        }

        // 域名规则只匹配域名目标。把 IP 目标交给域名后缀匹配会让
        // 「example.com 解析到 127.0.0.1」变成一条绕过白名单的路径。
        let TargetAddr::Domain { host, port } = target else {
            return false;
        };
        if !self.port_allows(*port) {
            return false;
        }
        let host = normalize_host(host);
        if let Some(base) = rule_host.strip_prefix("*.") {
            !base.is_empty() && host.len() > base.len() && host.ends_with(&format!(".{base}"))
        } else {
            host == rule_host || host.ends_with(&format!(".{rule_host}"))
        }
    }

    fn port_allows(&self, port: u16) -> bool {
        match self.ports {
            None => true,
            Some((low, high)) => low <= port && port <= high,
        }
    }
}

/// 白名单整体判定：空列表拒绝一切；任意一条命中即通过。
pub fn allows(rules: &[TargetRule], target: &TargetAddr) -> bool {
    !rules.is_empty() && rules.iter().any(|rule| rule.allows(target))
}

fn normalize_host(raw: &str) -> String {
    raw.trim().trim_end_matches('.').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(addr: &str) -> TargetAddr {
        TargetAddr::Ip(addr.parse().expect("固定测试地址"))
    }

    fn domain(host: &str, port: u16) -> TargetAddr {
        TargetAddr::Domain {
            host: host.into(),
            port,
        }
    }

    #[test]
    fn exact_ip_and_port_range() {
        let rules = vec![TargetRule::new("203.0.113.7", Some((8000, 8100)))];
        assert!(allows(&rules, &ip("203.0.113.7:8000")));
        assert!(allows(&rules, &ip("203.0.113.7:8100")));
        assert!(allows(&rules, &ip("203.0.113.7:8050")));
        assert!(
            !allows(&rules, &ip("203.0.113.7:7999")),
            "低于端口区间必须拒绝"
        );
        assert!(
            !allows(&rules, &ip("203.0.113.7:8101")),
            "高于端口区间必须拒绝"
        );
        assert!(!allows(&rules, &ip("203.0.113.8:8000")), "IP 必须精确匹配");
        assert!(
            !allows(&rules, &domain("203.0.113.7", 8000)),
            "域名形态的 IP 不能绕过 IP 规则"
        );
    }

    #[test]
    fn domain_suffix_matches_apex_and_subdomains() {
        let rules = vec![TargetRule::new("example.com", None)];
        assert!(allows(&rules, &domain("example.com", 443)));
        assert!(allows(&rules, &domain("a.example.com", 443)));
        assert!(allows(&rules, &domain("deep.a.example.com", 443)));
        assert!(
            !allows(&rules, &domain("badexample.com", 443)),
            "后缀匹配必须落在点边界上"
        );
        assert!(!allows(&rules, &domain("example.com.evil", 443)));
        assert!(
            !allows(&rules, &ip("203.0.113.7:443")),
            "IP 目标不能命中域名规则"
        );
    }

    #[test]
    fn wildcard_matches_subdomains_only() {
        let rules = vec![TargetRule::new("*.example.com", Some((443, 443)))];
        assert!(allows(&rules, &domain("a.example.com", 443)));
        assert!(
            !allows(&rules, &domain("example.com", 443)),
            "通配符不含 apex"
        );
        assert!(
            !allows(&rules, &domain("a.example.com", 80)),
            "端口必须命中"
        );
        assert!(!allows(&rules, &domain("badexample.com", 443)));
    }

    #[test]
    fn host_matching_is_case_insensitive_and_ignores_trailing_dot() {
        let rules = vec![TargetRule::new(" Example.COM. ", None)];
        assert!(allows(&rules, &domain("EXAMPLE.com", 80)));
        assert!(allows(&rules, &domain("a.Example.Com.", 80)));
    }

    #[test]
    fn empty_whitelist_or_invalid_rule_denies_everything() {
        assert!(
            !allows(&[], &ip("127.0.0.1:80")),
            "空白名单必须 fail closed"
        );
        assert!(!allows(&[], &domain("example.com", 80)));

        let invalid = vec![TargetRule::new("", None)];
        assert!(!allows(&invalid, &domain("example.com", 80)));

        let bad_range = vec![TargetRule::new("example.com", Some((9000, 8000)))];
        assert!(!allows(&bad_range, &domain("example.com", 8500)));
    }

    #[test]
    fn multiple_rules_any_match_passes() {
        let rules = vec![
            TargetRule::new("203.0.113.7", Some((443, 443))),
            TargetRule::new("*.internal.example", Some((1000, 2000))),
        ];
        assert!(allows(&rules, &ip("203.0.113.7:443")));
        assert!(allows(&rules, &domain("db.internal.example", 1500)));
        assert!(!allows(&rules, &domain("db.internal.example", 2001)));
    }
}
