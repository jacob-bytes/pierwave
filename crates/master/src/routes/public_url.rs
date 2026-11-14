//! 对外地址的唯一出口：安装命令、升级包、订阅链接都从这里取 base。
//!
//! 两个设置项都为空时，回落到请求头推导（与历史行为逐字节一致）；后台任务
//! 没有请求头时回落到环境变量。设置每次请求重新读取，管理员保存后立即生效。

use axum::http::HeaderMap;

use crate::routes::desired;
use crate::routes::install::external_base;
use crate::routes::settings::{self, Settings};
use crate::state::AppState;

/// 地址用途：`Agent` 用于安装/升级，`Subscription` 用于订阅链接与二维码。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicBaseKind {
    Agent,
    Subscription,
}

/// 单个对外地址的最大长度；域名 + 端口远小于此值。
pub const MAX_PUBLIC_BASE_URL_CHARS: usize = 512;

/// 对外地址校验失败的原因。
///
/// 每个变体对应一个稳定错误码，前端按码翻译，后端附带中英双语兜底文案。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BaseUrlError {
    TooLong,
    Scheme,
    HostMissing,
    Whitespace,
    PathNotAllowed,
    UserInfo,
    PortInvalid,
}

impl BaseUrlError {
    pub fn code(self) -> &'static str {
        match self {
            Self::TooLong => "settings.base_url_too_long",
            Self::Scheme => "settings.base_url_scheme_invalid",
            Self::HostMissing => "settings.base_url_host_missing",
            Self::Whitespace => "settings.base_url_whitespace_invalid",
            Self::PathNotAllowed => "settings.base_url_path_invalid",
            Self::UserInfo => "settings.base_url_userinfo_invalid",
            Self::PortInvalid => "settings.base_url_port_invalid",
        }
    }

    pub fn message(self) -> String {
        match self {
            Self::TooLong => format!(
                "对外地址最多 {MAX_PUBLIC_BASE_URL_CHARS} 个字符 / Public address must be at most {MAX_PUBLIC_BASE_URL_CHARS} characters"
            ),
            Self::Scheme => {
                "对外地址必须以 http:// 或 https:// 开头 / Public address must start with http:// or https://"
                    .to_string()
            }
            Self::HostMissing => {
                "对外地址缺少有效主机名 / Public address is missing a valid host".to_string()
            }
            Self::Whitespace => {
                "对外地址不能包含空白或控制字符 / Public address must not contain whitespace or control characters"
                    .to_string()
            }
            Self::PathNotAllowed => {
                "对外地址不能包含路径、查询或片段 / Public address must not include a path, query or fragment"
                    .to_string()
            }
            Self::UserInfo => {
                "对外地址不能包含用户名或密码 / Public address must not include a username or password".to_string()
            }
            Self::PortInvalid => {
                "端口必须是 1-65535 的整数 / Port must be an integer from 1 to 65535".to_string()
            }
        }
    }
}

/// 解析并规范化对外地址。
///
/// 合法形状只有 `http(s)://host[:port]`：多一段路径、查询、片段、用户名密码
/// 都拒绝；scheme 大小写不敏感，统一写成小写；首尾空白 trim。
pub fn parse_public_base_url(raw: &str) -> Result<String, BaseUrlError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.chars().count() > MAX_PUBLIC_BASE_URL_CHARS {
        return Err(BaseUrlError::TooLong);
    }

    let lower = trimmed.to_ascii_lowercase();
    let (scheme, rest) = if lower.starts_with("http://") {
        ("http", &trimmed[7..])
    } else if lower.starts_with("https://") {
        ("https", &trimmed[8..])
    } else {
        return Err(BaseUrlError::Scheme);
    };

    if rest.is_empty() {
        return Err(BaseUrlError::HostMissing);
    }
    if rest
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(BaseUrlError::Whitespace);
    }
    if rest.contains(['/', '?', '#']) {
        return Err(BaseUrlError::PathNotAllowed);
    }
    if rest.contains('@') {
        return Err(BaseUrlError::UserInfo);
    }
    validate_authority(rest)?;
    Ok(format!("{scheme}://{rest}"))
}

fn validate_authority(authority: &str) -> Result<(), BaseUrlError> {
    if let Some(bracketed) = authority.strip_prefix('[') {
        let end = bracketed.find(']').ok_or(BaseUrlError::HostMissing)?;
        let host = &bracketed[..end];
        if !host.contains(':') || host.parse::<std::net::Ipv6Addr>().is_err() {
            return Err(BaseUrlError::HostMissing);
        }
        let after = &bracketed[end + 1..];
        if after.is_empty() {
            return Ok(());
        }
        let port = after.strip_prefix(':').ok_or(BaseUrlError::HostMissing)?;
        return validate_port(port);
    }

    if authority.contains(['[', ']']) {
        return Err(BaseUrlError::HostMissing);
    }
    let mut parts = authority.split(':');
    let host = parts.next().unwrap_or("");
    let port = parts.next();
    if parts.next().is_some() {
        return Err(BaseUrlError::HostMissing);
    }
    validate_host(host)?;
    match port {
        Some(port) => validate_port(port),
        None => Ok(()),
    }
}

fn validate_host(host: &str) -> Result<(), BaseUrlError> {
    if host.is_empty() {
        return Err(BaseUrlError::HostMissing);
    }
    if host.chars().any(|character| {
        !(character.is_alphanumeric() || character == '-' || character == '.' || character == '_')
    }) {
        return Err(BaseUrlError::HostMissing);
    }
    if !host.chars().any(char::is_alphanumeric) {
        return Err(BaseUrlError::HostMissing);
    }
    Ok(())
}

fn validate_port(port: &str) -> Result<(), BaseUrlError> {
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(BaseUrlError::PortInvalid);
    }
    match port.parse::<u16>() {
        Ok(0) | Err(_) => Err(BaseUrlError::PortInvalid),
        Ok(_) => Ok(()),
    }
}

/// 读取设置并算出当前请求应使用的 base。
pub async fn resolve(
    state: &AppState,
    headers: Option<&HeaderMap>,
    kind: PublicBaseKind,
) -> String {
    let settings = settings::load(&state.db.pool).await;
    public_base(headers, &settings, kind)
}

/// 纯函数：配置优先，其次请求头，最后后台任务的默认地址。
///
/// `Subscription` 在 `subscription_base_url` 为空时回退到 `agent_base_url`；
/// 两者都为空才回到请求头。
pub fn public_base(
    headers: Option<&HeaderMap>,
    settings: &Settings,
    kind: PublicBaseKind,
) -> String {
    let configured = match kind {
        PublicBaseKind::Agent => settings.agent_base_url.trim(),
        PublicBaseKind::Subscription => {
            let subscription = settings.subscription_base_url.trim();
            if subscription.is_empty() {
                settings.agent_base_url.trim()
            } else {
                subscription
            }
        }
    };
    if !configured.is_empty() {
        return configured.trim_end_matches('/').to_string();
    }
    match headers {
        Some(headers) => external_base(headers),
        None => desired::default_base_url(),
    }
}

/// 订阅链接：base 只在这里拼一次，`/me` 与订阅列表共用。
pub fn subscription_url(base: &str, short_code: &str) -> String {
    format!("{}/api/v1/sub/{short_code}", base.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::http::{header, HeaderMap};

    fn headers(host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, host.parse().unwrap());
        headers
    }

    fn configured(agent: &str, subscription: &str) -> Settings {
        Settings {
            agent_base_url: agent.to_string(),
            subscription_base_url: subscription.to_string(),
            ..Settings::default()
        }
    }

    #[test]
    fn empty_settings_use_headers_byte_for_byte() {
        let headers = headers("internal.panel:8787");
        let settings = Settings::default();
        for kind in [PublicBaseKind::Agent, PublicBaseKind::Subscription] {
            assert_eq!(
                public_base(Some(&headers), &settings, kind),
                external_base(&headers),
                "{kind:?} 都为空时必须与请求头推导完全一致"
            );
        }
        assert_eq!(
            public_base(Some(&headers), &settings, PublicBaseKind::Agent),
            "http://internal.panel:8787"
        );
    }

    #[test]
    fn forwarded_proto_is_still_honored_when_settings_are_empty() {
        let mut headers = headers("panel.example.com");
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        let settings = Settings::default();
        assert_eq!(
            public_base(Some(&headers), &settings, PublicBaseKind::Agent),
            "https://panel.example.com"
        );
        assert_eq!(
            public_base(Some(&headers), &settings, PublicBaseKind::Subscription),
            "https://panel.example.com"
        );
    }

    #[test]
    fn agent_only_overrides_agent_and_subscription_falls_back_to_it() {
        let headers = headers("10.0.0.5:8787");
        let settings = configured("https://panel.example.com", "");
        assert_eq!(
            public_base(Some(&headers), &settings, PublicBaseKind::Agent),
            "https://panel.example.com"
        );
        assert_eq!(
            public_base(Some(&headers), &settings, PublicBaseKind::Subscription),
            "https://panel.example.com",
            "订阅未配置时必须回退到 Agent 地址"
        );
    }

    #[test]
    fn subscription_only_overrides_subscription_and_agent_uses_headers() {
        let headers = headers("10.0.0.5:8787");
        let settings = configured("", "https://sub.example.com:8443");
        assert_eq!(
            public_base(Some(&headers), &settings, PublicBaseKind::Agent),
            "http://10.0.0.5:8787"
        );
        assert_eq!(
            public_base(Some(&headers), &settings, PublicBaseKind::Subscription),
            "https://sub.example.com:8443"
        );
    }

    #[test]
    fn both_configured_are_independent() {
        let headers = headers("10.0.0.5:8787");
        let settings = configured("https://panel.example.com", "https://sub.example.com");
        assert_eq!(
            public_base(Some(&headers), &settings, PublicBaseKind::Agent),
            "https://panel.example.com"
        );
        assert_eq!(
            public_base(Some(&headers), &settings, PublicBaseKind::Subscription),
            "https://sub.example.com"
        );
    }

    #[test]
    fn configured_values_apply_to_background_tasks_without_headers() {
        let settings = configured("https://panel.example.com", "https://sub.example.com");
        assert_eq!(
            public_base(None, &settings, PublicBaseKind::Agent),
            "https://panel.example.com"
        );
        assert_eq!(
            public_base(None, &settings, PublicBaseKind::Subscription),
            "https://sub.example.com"
        );
    }

    #[test]
    fn subscription_url_joins_exactly_one_slash() {
        assert_eq!(
            subscription_url("https://sub.example.com/", "abc123"),
            "https://sub.example.com/api/v1/sub/abc123"
        );
        assert_eq!(
            subscription_url("https://sub.example.com", "abc123"),
            "https://sub.example.com/api/v1/sub/abc123"
        );
    }

    #[test]
    fn accepts_host_port_ipv6_and_uppercase_scheme() {
        for (raw, expected) in [
            (" https://panel.example.com ", "https://panel.example.com"),
            ("http://10.0.0.5:8787", "http://10.0.0.5:8787"),
            (
                "HTTPS://Panel.Example.COM:443",
                "https://Panel.Example.COM:443",
            ),
            ("http://localhost", "http://localhost"),
            ("http://[::1]:8787", "http://[::1]:8787"),
            ("http://[2001:db8::1]", "http://[2001:db8::1]"),
            ("", ""),
        ] {
            assert_eq!(parse_public_base_url(raw).as_deref(), Ok(expected), "{raw}");
        }
    }

    #[test]
    fn rejects_paths_schemes_hosts_and_ports() {
        for (raw, code) in [
            ("panel.example.com", "settings.base_url_scheme_invalid"),
            (
                "ftp://panel.example.com",
                "settings.base_url_scheme_invalid",
            ),
            ("//panel.example.com", "settings.base_url_scheme_invalid"),
            (
                "https://panel.example.com/",
                "settings.base_url_path_invalid",
            ),
            (
                "https://panel.example.com/path",
                "settings.base_url_path_invalid",
            ),
            (
                "https://panel.example.com?x=1",
                "settings.base_url_path_invalid",
            ),
            (
                "https://panel.example.com#top",
                "settings.base_url_path_invalid",
            ),
            ("http://", "settings.base_url_host_missing"),
            ("http://:8787", "settings.base_url_host_missing"),
            ("http://-", "settings.base_url_host_missing"),
            ("http://[::1", "settings.base_url_host_missing"),
            ("http://[not-ipv6]", "settings.base_url_host_missing"),
            (
                "http://panel.example.com:",
                "settings.base_url_port_invalid",
            ),
            (
                "http://panel.example.com:abc",
                "settings.base_url_port_invalid",
            ),
            (
                "http://panel.example.com:0",
                "settings.base_url_port_invalid",
            ),
            (
                "http://panel.example.com:65536",
                "settings.base_url_port_invalid",
            ),
            (
                "https://user:pass@panel.example.com",
                "settings.base_url_userinfo_invalid",
            ),
            (
                "https://panel.example.com /x",
                "settings.base_url_whitespace_invalid",
            ),
        ] {
            let error = parse_public_base_url(raw).expect_err(raw);
            assert_eq!(error.code(), code, "{raw}");
            assert!(
                error.message().contains(" / "),
                "错误信息必须中英双语：{}",
                error.message()
            );
        }
    }
}
