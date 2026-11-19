//! 版本更新检测的纯逻辑：GitHub Releases 响应解析、版本比较、失败文案。
//!
//! 这里不读数据库、不发网络请求，只处理「把一段 JSON 变成 ReleaseInfo」与
//! 「新版本是不是真的更新」；网络与调度在 master 的 `updates` 模块里。
//!
//! 版本号规则（只覆盖本项目实际会出现的形态）：
//! * 允许前导 `v` / `V`（GitHub tag 是 `v0.11.3`，心跳里是 `0.11.3`）；
//! * 按数字段比较，缺失段补 0（`0.11.10 > 0.11.9`）；
//! * 带 `-` 的预发布版本小于同号正式版（`0.12.0-rc.1 < 0.12.0`）；
//! * 无法解析的版本号不 panic，按「无法比较」处理（返回 false）。

use chrono::DateTime;
use serde_json::Value;

/// GitHub Releases 唯一版本源；不做自建清单。
pub const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/jacob-bytes/pierwave/releases/latest";

/// 解析出的最新发布。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseInfo {
    /// 规范化后的版本号（去掉前导 `v`），例如 `0.12.0`。
    pub version: String,
    /// Release 页面；`html_url` 缺失时按 tag 拼一个。
    ///
    /// **只接受 `https://`**：这个字段会被前端直接放进 `<a href>`，`javascript:`
    /// / `data:` / `http:` 都可能变成脚本注入或降级链接。上游给了不安全的
    /// scheme 时置 `None` 并 warn，不保留、也不做「清洗后猜测」。
    pub url: Option<String>,
    /// `published_at`（Unix 秒），缺失或格式错误为 `None`。
    pub released_at: Option<i64>,
}

/// 检测失败的可读原因。
///
/// 前端不翻译这些字符串：`message()` 已经同时给出简体中文与英文，
/// 与现有告警文案（`中文 / English`）保持同一种写法。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateError {
    /// 版本源返回非 2xx。
    Http(u16),
    /// 连不上版本源（DNS、TLS、连接被拒绝等）。
    Network(String),
    /// 请求超时。
    Timeout,
    /// 响应不是合法 JSON，或缺少必要字段。
    InvalidJson(String),
    /// 响应里没有 `tag_name`。
    MissingTag,
    /// `tag_name` 不是合法版本号。
    InvalidVersion(String),
    /// 响应体超过出站上限；`limit_mib` 是上限的 MiB 值。
    TooLarge { limit_mib: u64 },
    /// 本地文件等离线版本源读取失败。
    Unavailable(String),
}

impl UpdateError {
    /// 稳定的机器可读 code（日志与排查用）。
    pub fn code(&self) -> &'static str {
        match self {
            UpdateError::Http(_) => "update.http",
            UpdateError::Network(_) => "update.network",
            UpdateError::Timeout => "update.timeout",
            UpdateError::InvalidJson(_) => "update.invalid_json",
            UpdateError::MissingTag => "update.missing_tag",
            UpdateError::InvalidVersion(_) => "update.invalid_version",
            UpdateError::TooLarge { .. } => "update.too_large",
            UpdateError::Unavailable(_) => "update.unavailable",
        }
    }

    /// 中英双语的可读原因。
    pub fn message(&self) -> String {
        match self {
            UpdateError::Http(status) => format!(
                "GitHub Releases 返回 HTTP {status} / GitHub Releases responded with HTTP {status}"
            ),
            UpdateError::Network(detail) => format!(
                "无法访问 GitHub Releases：{detail} / Failed to reach GitHub Releases: {detail}"
            ),
            UpdateError::Timeout => {
                "请求 GitHub Releases 超时 / Request to GitHub Releases timed out".to_string()
            }
            UpdateError::InvalidJson(detail) => format!(
                "GitHub 响应格式不正确：{detail} / Unexpected GitHub response: {detail}"
            ),
            UpdateError::MissingTag => {
                "GitHub 响应缺少版本号 / GitHub response has no release tag".to_string()
            }
            UpdateError::InvalidVersion(version) => format!(
                "GitHub 返回的版本号不合法：{version} / GitHub returned an invalid version: {version}"
            ),
            UpdateError::TooLarge { limit_mib } => format!(
                "GitHub 响应超过 {limit_mib} MiB 上限 / GitHub response exceeds the {limit_mib} MiB limit"
            ),
            UpdateError::Unavailable(detail) => format!(
                "无法读取版本信息：{detail} / Failed to read release information: {detail}"
            ),
        }
    }
}

/// 规范化版本号：trim、去掉前导 `v` / `V`，再用发布路径的安全规则校验。
///
/// 返回 `None` 表示这不是一个可以展示/比较的版本号。
pub fn normalize_version(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let without_prefix = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if crate::release::is_valid_version(without_prefix) {
        Some(without_prefix.to_string())
    } else {
        None
    }
}

/// 解析 GitHub `releases/latest` 的响应。
///
/// 只依赖三个字段：`tag_name`、`html_url`、`published_at`；其余字段忽略，
/// 避免 GitHub 调整响应结构时解析失败。
pub fn parse_release(raw: &str) -> Result<ReleaseInfo, UpdateError> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| UpdateError::InvalidJson(truncate(&error.to_string())))?;
    let tag = value
        .get("tag_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .ok_or(UpdateError::MissingTag)?;
    let version =
        normalize_version(tag).ok_or_else(|| UpdateError::InvalidVersion(truncate(tag)))?;

    let fallback_url = || {
        Some(format!(
            "https://github.com/jacob-bytes/pierwave/releases/tag/{tag}"
        ))
    };
    let url = match value
        .get("html_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
    {
        Some(raw) => safe_release_url(raw).map(str::to_string).or_else(|| {
            tracing::warn!(
                url = %truncate(raw),
                "GitHub Release 的 html_url 不是 https，已丢弃该字段"
            );
            None
        }),
        // 字段缺失时按 tag 拼一个固定 https 链接，保持原有行为。
        None => fallback_url(),
    };

    // 预发布字段理论上不会出现在 latest 接口里；写库时保留原值即可。
    let released_at = value
        .get("published_at")
        .and_then(Value::as_str)
        .and_then(parse_rfc3339)
        .or_else(|| {
            value
                .get("created_at")
                .and_then(Value::as_str)
                .and_then(parse_rfc3339)
        });

    Ok(ReleaseInfo {
        version,
        url,
        released_at,
    })
}

fn truncate(value: &str) -> String {
    value.chars().take(200).collect()
}

/// 只接受 `https://` 的绝对 URL。
///
/// 不引 `url` crate：这里只需要拒绝危险 scheme，规则越简单越不容易被绕过。
/// * scheme 大小写不敏感（RFC 3986），但必须是 `https`；
/// * scheme 之后必须有内容；
/// * 不允许空白/控制字符（浏览器会容忍部分字符，导致「看起来是 https、
///   实际被解释成别的」的歧义）。
///
/// 因此 `javascript:`、`data:`、`http:`（含自建镜像想用明文 HTTP 的情况）
/// 一律拒绝。**不接受 http 镜像**：版本页链接只在设置页展示，没有必须用
/// 明文的场景；为它开一个口子等于给上游一次降级/注入的机会。
fn safe_release_url(raw: &str) -> Option<&str> {
    let prefix = raw.get(..8)?;
    if !prefix.eq_ignore_ascii_case("https://") {
        return None;
    }
    let rest = &raw[8..];
    if rest.is_empty()
        || rest
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return None;
    }
    Some(raw)
}

fn parse_rfc3339(raw: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(raw.trim())
        .ok()
        .map(|at| at.timestamp())
}

/// 解析后的版本号：数字核心 + 可选预发布串。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedVersion {
    core: Vec<u64>,
    /// `0.12.0-rc.1` 里的 `rc.1`；`None` = 正式版。
    pre: Option<String>,
}

/// 解析版本号；无法解析（没有数字、只有前缀等）返回 `None`。
fn parse_version(raw: &str) -> Option<ParsedVersion> {
    let trimmed = raw.trim();
    let without_prefix = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    // build metadata（`+build.7`）不参与比较。
    let without_build = without_prefix.split('+').next().unwrap_or(without_prefix);
    let (core_part, pre) = match without_build.split_once('-') {
        Some((core, pre)) if !pre.is_empty() => (core, Some(pre.to_string())),
        Some((core, _)) => (core, None),
        None => (without_build, None),
    };
    if !core_part.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let core = core_part
        .split('.')
        .map(|segment| {
            segment
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect();
    Some(ParsedVersion { core, pre })
}

/// 比较两个版本号：`a > b` 返回正数，相等返回 0，`a < b` 返回负数。
///
/// 任一侧无法解析时返回 0（按「无法比较」处理），调用方据此不判定更新。
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let (Some(left), Some(right)) = (parse_version(a), parse_version(b)) else {
        return 0;
    };
    for index in 0..left.core.len().max(right.core.len()) {
        let l = left.core.get(index).copied().unwrap_or(0);
        let r = right.core.get(index).copied().unwrap_or(0);
        if l != r {
            return if l > r { 1 } else { -1 };
        }
    }
    // 数字核心相同：没有预发布串的正式版更大。
    match (&left.pre, &right.pre) {
        (None, None) => 0,
        (None, Some(_)) => 1,
        (Some(_), None) => -1,
        (Some(l), Some(r)) => compare_pre_release(l, r),
    }
}

fn compare_pre_release(a: &str, b: &str) -> i32 {
    let mut left = a.split('.');
    let mut right = b.split('.');
    loop {
        match (left.next(), right.next()) {
            (None, None) => return 0,
            (None, Some(_)) => return -1,
            (Some(_), None) => return 1,
            (Some(l), Some(r)) => {
                let ordering = match (l.parse::<u64>(), r.parse::<u64>()) {
                    (Ok(l), Ok(r)) => l.cmp(&r),
                    // 数字段比字母段小：`rc.1 < rc.beta`。
                    (Ok(_), Err(_)) => std::cmp::Ordering::Less,
                    (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
                    (Err(_), Err(_)) => l.cmp(r),
                };
                match ordering {
                    std::cmp::Ordering::Less => return -1,
                    std::cmp::Ordering::Greater => return 1,
                    std::cmp::Ordering::Equal => {}
                }
            }
        }
    }
}

/// `candidate` 是否比 `current` 新。任一侧非法时一律返回 false。
pub fn is_newer(candidate: &str, current: &str) -> bool {
    compare_versions(candidate, current) > 0
}

/// 最新版本是否构成一次可提示的更新。
///
/// `latest` 为空（从未成功检测过）或 `current` 非法时返回 false：宁可不提醒，
/// 也不要因为一次解析异常给管理员一个假红点。
pub fn has_update(latest: Option<&str>, current: &str) -> bool {
    let Some(latest) = latest.map(str::trim).filter(|latest| !latest.is_empty()) else {
        return false;
    };
    if parse_version(latest).is_none() || parse_version(current).is_none() {
        return false;
    }
    is_newer(latest, current)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(extra: &str) -> String {
        format!(
            r#"{{"tag_name":"v0.12.0","html_url":"https://github.com/jacob-bytes/pierwave/releases/tag/v0.12.0","published_at":"2026-11-20T10:00:00Z"{extra}}}"#
        )
    }

    #[test]
    fn parses_a_github_release_payload() {
        let release = parse_release(&json("")).unwrap();
        assert_eq!(release.version, "0.12.0");
        assert_eq!(
            release.url.as_deref(),
            Some("https://github.com/jacob-bytes/pierwave/releases/tag/v0.12.0")
        );
        assert_eq!(release.released_at, Some(1_795_168_800));
    }

    #[test]
    fn accepts_plain_version_tags_without_v_prefix() {
        let release = parse_release(
            r#"{"tag_name":"0.12.0","html_url":"https://example.test/r","published_at":null}"#,
        )
        .unwrap();
        assert_eq!(release.version, "0.12.0");
        assert_eq!(release.url.as_deref(), Some("https://example.test/r"));
        assert_eq!(release.released_at, None, "published_at 为 null 时不能报错");
    }

    #[test]
    fn falls_back_to_a_tag_url_when_html_url_is_missing() {
        let release = parse_release(r#"{"tag_name":"v1.2.3"}"#).unwrap();
        assert_eq!(release.version, "1.2.3");
        assert_eq!(
            release.url.as_deref(),
            Some("https://github.com/jacob-bytes/pierwave/releases/tag/v1.2.3")
        );
    }

    #[test]
    fn rejects_release_urls_whose_scheme_is_not_https() {
        // 只允许 https：js/data/http/协议相对地址都置 None，字段不会被前端
        // 直接放进 <a href>。
        for url in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "http://github.com/jacob-bytes/pierwave/releases/tag/v1.2.3",
            "data:text/html,<script>alert(1)</script>",
            "//github.com/jacob-bytes/pierwave/releases/tag/v1.2.3",
            "https://",
            "https://evil.test/a b",
        ] {
            let payload = format!(r#"{{"tag_name":"v1.2.3","html_url":"{url}"}}"#);
            let release = parse_release(&payload).unwrap();
            assert_eq!(release.url, None, "不安全的 release URL 必须置 None：{url}");
        }

        // https 大小写不敏感；合法链接原样保留。
        let release =
            parse_release(r#"{"tag_name":"v1.2.3","html_url":"HTTPS://example.test/release"}"#)
                .unwrap();
        assert_eq!(release.url.as_deref(), Some("HTTPS://example.test/release"));
    }

    #[test]
    fn malformed_payloads_are_readable_errors() {
        let error = parse_release("not json").unwrap_err();
        assert_eq!(error.code(), "update.invalid_json");
        assert!(error.message().contains("响应格式不正确"));
        assert!(error.message().contains("Unexpected GitHub response"));

        let error = parse_release(r#"{"tag_name":""}"#).unwrap_err();
        assert_eq!(error.code(), "update.missing_tag");

        let error = parse_release(r#"{"tag_name":"latest"}"#).unwrap_err();
        assert_eq!(error.code(), "update.invalid_version");
        assert!(error.message().contains("latest"));

        // 过长的错误信息要截断，避免把整段 HTML 写进设置页。
        let long = "x".repeat(500);
        let error = parse_release(&long).unwrap_err();
        assert!(error.message().len() < 400, "{}", error.message().len());
    }

    #[test]
    fn normalizes_v_prefix_and_rejects_junk() {
        assert_eq!(normalize_version("v0.11.3").as_deref(), Some("0.11.3"));
        assert_eq!(normalize_version(" V0.11.3 ").as_deref(), Some("0.11.3"));
        assert_eq!(normalize_version("0.11.3").as_deref(), Some("0.11.3"));
        assert_eq!(normalize_version("latest"), None);
        assert_eq!(normalize_version("v"), None);
        assert_eq!(normalize_version(""), None);
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("0.12.0", "0.11.3"));
        assert!(is_newer("v0.12.0", "0.11.3"));
        assert!(is_newer("0.11.10", "0.11.9"), "按数字段比较，不是字符串");
        assert!(!is_newer("0.11.3", "0.11.3"));
        assert!(!is_newer("0.11.3", "0.12.0"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert_eq!(compare_versions("0.11.3", "0.11.3"), 0);
    }

    #[test]
    fn pre_release_is_older_than_the_release() {
        assert!(!is_newer("0.12.0-rc.1", "0.12.0"));
        assert!(is_newer("0.12.0", "0.12.0-rc.1"));
        assert!(is_newer("0.12.0-rc.2", "0.12.0-rc.1"));
        assert!(is_newer("0.12.0-rc.1", "0.12.0-beta"), "rc > beta");
        assert!(
            !is_newer("0.12.0+build.7", "0.12.0"),
            "build 元数据不参与比较"
        );
    }

    #[test]
    fn non_numeric_versions_never_panic_or_claim_an_update() {
        assert!(!is_newer("0.12.0", "banana"));
        assert!(!is_newer("banana", "0.11.3"));
        assert_eq!(compare_versions("banana", "0.11.3"), 0);
        assert!(!has_update(None, "0.11.3"));
        assert!(!has_update(Some(""), "0.11.3"));
        assert!(!has_update(Some("0.12.0"), "dev"));
        assert!(has_update(Some("0.12.0"), "0.11.3"));
    }

    #[test]
    fn error_messages_are_bilingual() {
        for error in [
            UpdateError::Http(404),
            UpdateError::Network("Connection refused".into()),
            UpdateError::Timeout,
            UpdateError::MissingTag,
            UpdateError::Unavailable("no such file".into()),
        ] {
            let message = error.message();
            assert!(message.contains(" / "), "{message} 必须同时包含中文与英文");
        }
    }
}
