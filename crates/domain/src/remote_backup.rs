//! 异地备份（WebDAV）的纯逻辑：设置校验、文件名约定、PROPFIND 解析与保留策略。
//!
//! 这里不发起任何 HTTP 请求，也不依赖 axum：真正的 WebDAV 客户端在
//! `crates/master/src/webdav.rs`。把「哪些文件属于我们」「该删哪几个」放在
//! 领域层，是为了让保留策略能被单元测试覆盖，且永远不会因为远端目录里有
//! 别人的文件而误删。
//!
//! 约定：本产品写入的文件名固定为 `{prefix}-{yyyyMMdd-HHmmss}.db.gz`（明文）
//! 或 `{prefix}-{yyyyMMdd-HHmmss}.db.gz.enc`（默认，AES-256-GCM 加密）。
//! 保留策略只认这两种形状、且前缀完全相同的文件名，历史明文备份仍可识别。

use chrono::DateTime;

/// 远端备份文件名前缀；与本地导出文件名保持同一个形状。
pub const REMOTE_BACKUP_PREFIX: &str = "pierwave-backup";

/// 定时上传间隔（小时），默认 24，范围 1–168。
pub const DEFAULT_INTERVAL_HOURS: i64 = 24;
pub const MIN_INTERVAL_HOURS: i64 = 1;
pub const MAX_INTERVAL_HOURS: i64 = 168;

/// 远端保留份数，默认 7，范围 1–30。
pub const DEFAULT_KEEP: i64 = 7;
pub const MIN_KEEP: i64 = 1;
pub const MAX_KEEP: i64 = 30;

/// 状态接口最多返回的文件条数。
pub const MAX_STATUS_FILES: usize = 30;

/// WebDAV 地址长度上限。
pub const MAX_URL_CHARS: usize = 2048;
/// 用户名长度上限。
pub const MAX_USERNAME_CHARS: usize = 256;
/// 密码长度上限。
pub const MAX_PASSWORD_CHARS: usize = 512;

/// 远端目录里的一个普通文件（PROPFIND 解析结果）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFile {
    /// 文件名（已去掉目录部分并做百分号解码）。
    pub name: String,
    /// 字节数；PROPFIND 没给时为 0。
    pub size: u64,
    /// 修改时间的 Unix 秒；无法解析时为 `None`。
    pub modified: Option<i64>,
}

/// 明文备份后缀；关闭 `backup_encrypt` 时的输出。
pub const PLAIN_BACKUP_SUFFIX: &str = ".db.gz";

/// 加密备份后缀；默认输出（gzip 后再用主密钥加密）。
pub const ENCRYPTED_BACKUP_SUFFIX: &str = ".db.gz.enc";

/// 生成本产品的远端文件名：`{prefix}-{yyyyMMdd-HHmmss}.db.gz[.enc]`。
pub fn remote_file_name(prefix: &str, timestamp: &str, encrypted: bool) -> String {
    if encrypted {
        format!("{prefix}-{timestamp}{ENCRYPTED_BACKUP_SUFFIX}")
    } else {
        format!("{prefix}-{timestamp}{PLAIN_BACKUP_SUFFIX}")
    }
}

/// 判断一个文件名是否是本产品写入的备份。
///
/// 必须是 `{prefix}-` + 8 位日期 + `-` + 6 位时间 + `.db.gz` 或 `.db.gz.enc`；
/// 别的文件名（哪怕前缀相同）一律返回 `false`，保留策略就不会碰它。
pub fn is_managed_backup_name(name: &str, prefix: &str) -> bool {
    let Some(rest) = name.strip_prefix(prefix) else {
        return false;
    };
    let Some(rest) = rest.strip_prefix('-') else {
        return false;
    };
    // `.db.gz.enc` 必须先匹配：它同时也是以 `.gz` 结尾的更长后缀。
    let Some(stamp) = rest
        .strip_suffix(ENCRYPTED_BACKUP_SUFFIX)
        .or_else(|| rest.strip_suffix(PLAIN_BACKUP_SUFFIX))
    else {
        return false;
    };
    let bytes = stamp.as_bytes();
    bytes.len() == 15
        && bytes[8] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 8 || byte.is_ascii_digit())
}

/// 校验并规范化 WebDAV 地址。
///
/// - 空串合法（= 未配置）；
/// - 只接受 `http://` 或 `https://`（内网允许 http）；
/// - 不允许带用户名/密码（凭据通过独立设置项传递，避免出现在 URL 里）；
/// - 不允许 query / fragment（WebDAV 目录地址没有它们的语义）；
/// - 末尾 `/` 会被去掉，scheme 统一小写。
pub fn normalize_webdav_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Ok(String::new());
    }
    if url.chars().count() > MAX_URL_CHARS {
        return Err(format!("WebDAV 地址最多 {MAX_URL_CHARS} 个字符"));
    }
    if url
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("WebDAV 地址不能包含空白或控制字符".to_string());
    }

    let lower = url.to_ascii_lowercase();
    let (scheme, rest) = if let Some(rest) = lower
        .strip_prefix("https://")
        .map(|_| &url["https://".len()..])
    {
        ("https", rest)
    } else if let Some(rest) = lower
        .strip_prefix("http://")
        .map(|_| &url["http://".len()..])
    {
        ("http", rest)
    } else {
        return Err("WebDAV 地址必须以 http:// 或 https:// 开头".to_string());
    };

    if rest.is_empty() {
        return Err("WebDAV 地址缺少主机名".to_string());
    }
    if rest.contains('?') || rest.contains('#') {
        return Err("WebDAV 地址不能包含查询参数或锚点".to_string());
    }

    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    if authority.is_empty() {
        return Err("WebDAV 地址缺少主机名".to_string());
    }
    if authority.contains('@') {
        return Err("WebDAV 地址不能包含用户名或密码".to_string());
    }

    validate_authority(authority)?;
    let path = path.trim_end_matches('/');
    Ok(format!("{scheme}://{authority}{path}"))
}

/// 主机名 + 可选端口；IPv6 允许 `[::1]:8080` 形式。
fn validate_authority(authority: &str) -> Result<(), String> {
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err("WebDAV 地址的 IPv6 主机格式不合法".to_string());
        };
        let host = &rest[..end];
        let after = &rest[end + 1..];
        let port = if after.is_empty() {
            None
        } else {
            let Some(port) = after.strip_prefix(':') else {
                return Err("WebDAV 地址的端口格式不合法".to_string());
            };
            Some(port)
        };
        (host, port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };

    if host.is_empty() {
        return Err("WebDAV 地址缺少主机名".to_string());
    }
    if let Some(port) = port {
        let value: u16 = port
            .parse()
            .map_err(|_| "WebDAV 地址的端口必须是 1-65535 的整数".to_string())?;
        if value == 0 {
            return Err("WebDAV 地址的端口必须是 1-65535 的整数".to_string());
        }
    }
    Ok(())
}

/// 对错误信息里的密码打码，避免日志/状态接口泄露凭据。
pub fn redact_secret(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        return text.to_string();
    }
    text.replace(secret, "***")
}

/// 解析 PROPFIND（Depth: 1）的 XML 响应，返回其中的普通文件。
///
/// 只做我们真正需要的字段（href / getcontentlength / getlastmodified），
/// 命名空间前缀（`D:`、`d:`、`lp1:`）与大小写都无所谓；目录条目被跳过。
/// 解析是容错的：未知字段、缺失字段、被截断的 XML 都不会 panic。
pub fn parse_propfind(xml: &str) -> Vec<RemoteFile> {
    let mut files = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut current: Option<Entry> = None;
    let mut text = String::new();
    let mut rest = xml;

    while let Some(index) = rest.find('<') {
        text.push_str(&rest[..index]);
        rest = &rest[index..];
        let Some(end) = rest.find('>') else {
            break;
        };
        let raw_tag = &rest[1..end];
        rest = &rest[end + 1..];

        if raw_tag.starts_with('!') || raw_tag.starts_with('?') {
            continue;
        }
        let closing = raw_tag.starts_with('/');
        let self_closing = raw_tag.ends_with('/');
        let name = local_name(raw_tag);

        if closing {
            dispatch_text(&text, stack.last(), &mut current);
            text.clear();
            if let Some(position) = stack.iter().rposition(|item| item == &name) {
                stack.truncate(position);
            }
            if name == "response" {
                if let Some(entry) = current.take() {
                    push_entry(entry, &mut files);
                }
            }
            continue;
        }

        dispatch_text(&text, stack.last(), &mut current);
        text.clear();

        if name == "response" {
            current = Some(Entry::default());
        } else if name == "collection" && current.is_some() {
            if let Some(entry) = current.as_mut() {
                entry.is_dir = true;
            }
        }
        if !self_closing {
            stack.push(name);
        }
    }

    // 被截断的 XML：闭合当前 <response>，尽量保留已解析到的内容。
    if let Some(entry) = current.take() {
        push_entry(entry, &mut files);
    }
    files
}

fn push_entry(entry: Entry, files: &mut Vec<RemoteFile>) {
    if entry.is_dir || entry.href.is_empty() {
        return;
    }
    let name = file_name_from_href(&entry.href);
    if name.is_empty() {
        return;
    }
    files.push(RemoteFile {
        name,
        size: entry.size,
        modified: entry.modified,
    });
}

/// PROPFIND 里一个 `<response>` 的中间结构。
#[derive(Default)]
struct Entry {
    href: String,
    size: u64,
    modified: Option<i64>,
    is_dir: bool,
}

fn dispatch_text(text: &str, top: Option<&String>, current: &mut Option<Entry>) {
    let (Some(top), Some(entry)) = (top, current.as_mut()) else {
        return;
    };
    let value = text.trim();
    if value.is_empty() {
        return;
    }
    let value = decode_entities(value);
    match top.as_str() {
        "href" => entry.href.push_str(&value),
        "getcontentlength" => entry.size = value.parse().unwrap_or(0),
        "getlastmodified" => entry.modified = parse_http_date(&value),
        _ => {}
    }
}

/// 标签的本地名（去掉命名空间前缀、`/` 与属性），统一小写。
fn local_name(tag: &str) -> String {
    let tag = tag.trim();
    let tag = tag.strip_prefix('/').unwrap_or(tag);
    let tag = tag.split_whitespace().next().unwrap_or("");
    let tag = tag.trim_end_matches('/');
    tag.rsplit(':').next().unwrap_or(tag).to_ascii_lowercase()
}

/// `href` → 文件名：取最后一段并做百分号解码。
fn file_name_from_href(href: &str) -> String {
    let path = href.split(['?', '#']).next().unwrap_or(href);
    let last = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    percent_decode(last)
}

fn decode_entities(value: &str) -> String {
    if !value.contains('&') {
        return value.to_string();
    }
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// 只处理 `%XX`；非法序列原样保留。
fn percent_decode(value: &str) -> String {
    if !value.contains('%') {
        return value.to_string();
    }
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            // 用 get 而不是索引：截断到非 UTF-8 边界时不能 panic。
            let hex = value.get(index + 1..index + 3).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// HTTP 日期（RFC 1123 / RFC 2822，通常是 `... GMT`）。
fn parse_http_date(raw: &str) -> Option<i64> {
    if let Ok(date) = DateTime::parse_from_rfc2822(raw) {
        return Some(date.timestamp());
    }
    chrono::NaiveDateTime::parse_from_str(raw, "%a, %d %b %Y %H:%M:%S GMT")
        .ok()
        .map(|date| date.and_utc().timestamp())
}

/// 计算保留策略要删除的文件名。
///
/// 只看 `is_managed_backup_name` 为真的文件（同前缀 + 固定时间戳格式），
/// 按文件名倒序（即时间从新到旧）保留最近 `keep` 份，其余返回删除。
/// 远端目录里其它产品的文件永远不会进入结果。
pub fn plan_retention(files: &[RemoteFile], prefix: &str, keep: i64) -> Vec<String> {
    let keep = keep.max(MIN_KEEP) as usize;
    let mut managed: Vec<&RemoteFile> = files
        .iter()
        .filter(|file| is_managed_backup_name(&file.name, prefix))
        .collect();
    managed.sort_by(|left, right| right.name.cmp(&left.name));
    managed.dedup_by(|left, right| left.name == right.name);

    managed
        .into_iter()
        .skip(keep)
        .map(|file| file.name.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_http_and_trims_trailing_slash() {
        assert_eq!(
            normalize_webdav_url("https://dav.example.com/remote.php/dav/files/user/pierwave")
                .unwrap(),
            "https://dav.example.com/remote.php/dav/files/user/pierwave"
        );
        assert_eq!(
            normalize_webdav_url("  HTTPS://dav.example.com/dav/  ").unwrap(),
            "https://dav.example.com/dav",
            "scheme 统一小写、末尾斜杠去掉"
        );
        assert_eq!(
            normalize_webdav_url("http://10.0.0.5:8080/dav").unwrap(),
            "http://10.0.0.5:8080/dav",
            "内网允许 http"
        );
        assert_eq!(
            normalize_webdav_url("http://[::1]:8080/dav").unwrap(),
            "http://[::1]:8080/dav"
        );
        assert_eq!(normalize_webdav_url("   ").unwrap(), "", "空串 = 未配置");
    }

    #[test]
    fn rejects_invalid_webdav_urls() {
        for raw in [
            "dav.example.com/dav",
            "ftp://dav.example.com/dav",
            "https://",
            "https:///dav",
            "https://user:pass@dav.example.com/dav",
            "https://user@dav.example.com/dav",
            "https://dav.example.com/dav?x=1",
            "https://dav.example.com/dav#top",
            "https://dav example.com/dav",
            "https://dav.example.com:0/dav",
            "https://dav.example.com:99999/dav",
            "https://[::1/dav",
        ] {
            assert!(normalize_webdav_url(raw).is_err(), "应拒绝非法地址：{raw}");
        }
    }

    #[test]
    fn managed_file_names_are_strictly_matched() {
        let prefix = REMOTE_BACKUP_PREFIX;
        assert_eq!(
            remote_file_name(prefix, "20261115-190533", false),
            "pierwave-backup-20261115-190533.db.gz"
        );
        assert_eq!(
            remote_file_name(prefix, "20261115-190533", true),
            "pierwave-backup-20261115-190533.db.gz.enc"
        );
        assert!(is_managed_backup_name(
            "pierwave-backup-20261115-190533.db.gz",
            prefix
        ));
        assert!(is_managed_backup_name(
            "pierwave-backup-20261115-190533.db.gz.enc",
            prefix
        ));
        for name in [
            "pierwave-backup-20261115-190533.db",
            "pierwave-backup-20261115-19053.db.gz",
            "pierwave-backup-2026-1115-190533.db.gz",
            "pierwave-backup-latest.db.gz",
            "other-backup-20261115-190533.db.gz",
            "pierwave-backup-20261115-190533.db.gz.bak",
            "pierwave-backup-20261115-190533.db.gz.enc.bak",
            "pierwave-backup-20261115-190533.enc",
            "pierwave-backup-20261115-190533.db.gz ",
            "xpierwave-backup-20261115-190533.db.gz",
        ] {
            assert!(
                !is_managed_backup_name(name, prefix),
                "不应认作本产品文件：{name}"
            );
        }
        // 前缀不同也互不影响。
        assert!(is_managed_backup_name(
            "nightly-20261115-190533.db.gz",
            "nightly"
        ));
    }

    #[test]
    fn retention_keeps_newest_same_prefix_files_and_nothing_else() {
        let prefix = REMOTE_BACKUP_PREFIX;
        let file = |name: &str| RemoteFile {
            name: name.to_string(),
            size: 1,
            modified: None,
        };
        let files = vec![
            file("pierwave-backup-20260101-000000.db.gz"),
            file("pierwave-backup-20260103-000000.db.gz"),
            file("pierwave-backup-20260102-000000.db.gz"),
            file("pierwave-backup-20260104-000000.db.gz"),
            // 非本产品写入的文件：任何情况下都不能删。
            file("notes.txt"),
            file("pierwave-backup-manual.db.gz"),
            file("another-pierwave-backup-20260101-000000.db.gz"),
            file("pierwave-backup-20260101-000000.db"),
        ];

        assert_eq!(
            plan_retention(&files, prefix, 2),
            vec![
                "pierwave-backup-20260102-000000.db.gz".to_string(),
                "pierwave-backup-20260101-000000.db.gz".to_string(),
            ],
            "保留最新 2 份，按时间倒序删其余同前缀文件"
        );
        assert!(
            plan_retention(&files, prefix, 7).is_empty(),
            "文件不足时一份都不删"
        );
        assert_eq!(
            plan_retention(&files, prefix, 1).len(),
            3,
            "keep=1 时只留最新一份"
        );
        assert!(
            plan_retention(&files, prefix, 0).len() == 3,
            "小于 1 的 keep 夹到 1，不会把所有文件删光"
        );
        assert!(plan_retention(&[], prefix, 7).is_empty());
    }

    #[test]
    fn propfind_parses_namespaced_multistatus_response() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/files/user/pierwave/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/user/pierwave/pierwave-backup-20261115-190533.db.gz</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype/>
        <d:getcontentlength>1048576</d:getcontentlength>
        <d:getlastmodified>Sun, 15 Nov 2026 09:05:33 GMT</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/user/pierwave/with%20space%26more.txt</d:href>
    <d:propstat><d:prop>
      <d:getcontentlength>12</d:getcontentlength>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>"#;

        let files = parse_propfind(xml);
        assert_eq!(files.len(), 2, "目录条目必须被跳过：{files:?}");
        assert_eq!(files[0].name, "pierwave-backup-20261115-190533.db.gz");
        assert_eq!(files[0].size, 1_048_576);
        assert_eq!(
            files[0].modified,
            Some(1_794_733_533),
            "GMT 时间要转成 Unix 秒"
        );
        assert_eq!(files[1].name, "with space&more.txt", "百分号解码");
        assert_eq!(files[1].size, 12);
        assert_eq!(files[1].modified, None);
    }

    #[test]
    fn propfind_tolerates_small_and_truncated_bodies() {
        assert!(parse_propfind("").is_empty());
        assert!(parse_propfind("<d:multistatus xmlns:d=\"DAV:\"/>").is_empty());
        // 缺少闭合标签也尽量保留已解析字段，绝不 panic。
        let partial = parse_propfind(
            "<d:response><d:href>/dav/a.db.gz</d:href>\
             <d:getcontentlength>7</d:getcontentlength>",
        );
        assert_eq!(partial.len(), 1);
        assert_eq!(partial[0].name, "a.db.gz");
        assert_eq!(partial[0].size, 7);
    }

    #[test]
    fn redacts_secret_from_any_text() {
        assert_eq!(
            redact_secret("curl: password=hunter2 rejected", "hunter2"),
            "curl: password=*** rejected"
        );
        assert_eq!(
            redact_secret("no secret here", ""),
            "no secret here",
            "空密码不能把整段文本替换掉"
        );
    }
}
