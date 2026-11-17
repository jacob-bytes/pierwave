//! 最小 WebDAV 客户端：PUT / PROPFIND / DELETE，只覆盖异地备份用到的三种请求。
//!
//! 为什么用系统 `curl` 子进程而不是引入 HTTP 客户端：
//! * 仓库现有告警投递已经是这个模式（`crate::alerts`），依赖面最小；
//! * musl 静态构建不需要再背一个 TLS 栈；
//! * curl 默认校验证书，HTTPS 不需要额外配置。
//!
//! 安全约定：
//! * 用户名/密码只通过 `--config -` 的 stdin 传给 curl，**不进 argv**
//!   （`ps` / `/proc/*/cmdline` 看不到）；URL、文件名、请求头都在 argv，
//!   它们不是秘密；
//! * 任何错误信息都会先把密码替换成 `***` 再返回，日志与状态接口拿到的是
//!   已打码文本；
//! * 从不传 `-k` / `--insecure`，HTTPS 证书校验保持开启。
//!
//! 远端文件内容（备份）从不进入日志，也不进入错误信息。

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use pierwave_domain::remote_backup::{self, RemoteFile};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::alerts::escape_curl_config;

/// 单次请求最长耗时；备份文件可能不小，给足时间。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// 建连超时，避免远端地址不可达时任务长时间挂起。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// PROPFIND 请求体：只要文件大小与修改时间，不请求权限等无关属性。
const PROPFIND_BODY: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>"#,
    r#"<d:propfind xmlns:d="DAV:"><d:prop>"#,
    r#"<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>"#,
    r#"</d:prop></d:propfind>"#
);

/// WebDAV 请求失败；`message` 已对密码打码，可以直接进日志/状态接口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebDavError {
    message: String,
}

impl WebDavError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for WebDavError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for WebDavError {}

/// 一次 curl 调用的结果；`status` 是 HTTP 状态码。
struct CurlOutput {
    status: u16,
    body: Vec<u8>,
}

/// 已配置的 WebDAV 连接。
#[derive(Clone)]
pub struct WebDavClient {
    base_url: String,
    username: String,
    password: String,
    program: String,
}

impl WebDavClient {
    /// `base_url` 必须已经过 [`remote_backup::normalize_webdav_url`] 规范化。
    pub fn new(
        base_url: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            username: username.into(),
            password: password.into(),
            program: "curl".to_string(),
        }
    }

    /// 只做一次 Depth: 0 的 PROPFIND，确认地址、凭据与证书都没问题。
    pub async fn test_connection(&self) -> Result<(), WebDavError> {
        self.propfind(0).await.map(|_| ())
    }

    /// 列出目录下的普通文件（Depth: 1）。
    pub async fn list(&self) -> Result<Vec<RemoteFile>, WebDavError> {
        self.propfind(1).await
    }

    /// 上传一个本地文件；`name` 必须是本产品生成的备份名。
    pub async fn put_file(&self, name: &str, path: &Path) -> Result<(), WebDavError> {
        self.ensure_managed_name(name)?;
        let path = path
            .to_str()
            .ok_or_else(|| WebDavError::new("备份临时文件路径不是合法 UTF-8"))?;
        let url = self.url_for(name);
        let output = self.run(&["--upload-file", path, &url]).await?;
        if matches!(output.status, 200 | 201 | 204) {
            Ok(())
        } else {
            Err(self.status_error("上传备份", output.status))
        }
    }

    /// 删除一个本产品写入的备份；文件已经不存在时视为成功（幂等）。
    pub async fn delete(&self, name: &str) -> Result<(), WebDavError> {
        self.ensure_managed_name(name)?;
        let url = self.url_for(name);
        let output = self.run(&["--request", "DELETE", &url]).await?;
        match output.status {
            200 | 202 | 204 | 404 => Ok(()),
            status => Err(self.status_error("删除旧备份", status)),
        }
    }

    /// 只允许操作本产品命名的文件：避免保留策略因为脏数据误删别的文件。
    fn ensure_managed_name(&self, name: &str) -> Result<(), WebDavError> {
        if remote_backup::is_managed_backup_name(name, remote_backup::REMOTE_BACKUP_PREFIX) {
            Ok(())
        } else {
            Err(WebDavError::new(format!(
                "拒绝操作非本产品命名的远端文件：{name}"
            )))
        }
    }

    fn url_for(&self, name: &str) -> String {
        format!("{}/{}", self.base_url, encode_path_segment(name))
    }

    async fn propfind(&self, depth: u8) -> Result<Vec<RemoteFile>, WebDavError> {
        let depth = format!("Depth: {depth}");
        let output = self
            .run(&[
                "--request",
                "PROPFIND",
                "--header",
                &depth,
                "--header",
                "Content-Type: application/xml; charset=utf-8",
                "--data-binary",
                PROPFIND_BODY,
                &self.base_url,
            ])
            .await?;
        if matches!(output.status, 200 | 207) {
            let body = String::from_utf8_lossy(&output.body);
            Ok(remote_backup::parse_propfind(&body))
        } else {
            Err(self.status_error("读取远端目录", output.status))
        }
    }

    /// curl 的固定参数。`--config -` 从 stdin 读凭据，密码因此不会出现在 argv。
    fn connection_args(&self) -> Vec<String> {
        vec![
            "--silent".into(),
            "--show-error".into(),
            "--proto".into(),
            "=http,https".into(),
            "--connect-timeout".into(),
            CONNECT_TIMEOUT.as_secs().to_string(),
            "--max-time".into(),
            REQUEST_TIMEOUT.as_secs().to_string(),
            // 响应体上限：PROPFIND 目录列表可能被恶意/异常远端放大。
            "--max-filesize".into(),
            crate::outbound::max_filesize_arg(),
            "--write-out".into(),
            "\n%{http_code}".into(),
            "--config".into(),
            "-".into(),
        ]
    }

    /// 交给 curl 的 `--config` 内容；只包含 BASIC 凭据。
    fn curl_config(&self) -> String {
        if self.username.is_empty() && self.password.is_empty() {
            return String::new();
        }
        let credentials = format!("{}:{}", self.username, self.password);
        format!("user = \"{}\"\n", escape_curl_config(&credentials))
    }

    async fn run(&self, args: &[&str]) -> Result<CurlOutput, WebDavError> {
        let mut child = Command::new(&self.program)
            .args(self.connection_args())
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| WebDavError::new(format!("无法执行 `{}`：{error}", self.program)))?;

        let config = self.curl_config();
        if let Some(mut stdin) = child.stdin.take() {
            if let Err(error) = stdin.write_all(config.as_bytes()).await {
                let _ = child.kill().await;
                return Err(WebDavError::new(format!("向 curl 写入配置失败：{error}")));
            }
        }

        let output = child
            .wait_with_output()
            .await
            .map_err(|error| WebDavError::new(format!("等待 curl 退出失败：{error}")))?;
        let stderr = self.redact(&String::from_utf8_lossy(&output.stderr));
        if !output.status.success() {
            // curl 63 = CURLE_FILESIZE_EXCEEDED（`--max-filesize` 触发）。
            if output.status.code() == Some(63) {
                return Err(WebDavError::new(crate::outbound::too_large("WebDAV 响应")));
            }
            let detail: String = stderr.trim().chars().take(300).collect();
            return Err(WebDavError::new(if detail.is_empty() {
                format!("curl 退出码 {:?}", output.status.code())
            } else {
                format!("curl 退出码 {:?}：{detail}", output.status.code())
            }));
        }

        let (body, status) = split_status(&output.stdout);
        let status = status.ok_or_else(|| {
            let detail: String = stderr.trim().chars().take(300).collect();
            WebDavError::new(format!("无法解析 WebDAV 响应状态：{detail}"))
        })?;
        // `--max-filesize` 对 chunked 响应不生效，读回后按实际字节数兜底。
        if crate::outbound::exceeded(body.len() as u64) {
            return Err(WebDavError::new(crate::outbound::too_large("WebDAV 响应")));
        }
        Ok(CurlOutput { status, body })
    }

    fn redact(&self, text: &str) -> String {
        remote_backup::redact_secret(text, &self.password)
    }

    fn status_error(&self, action: &str, status: u16) -> WebDavError {
        let message = match status {
            401 => "WebDAV 认证失败（HTTP 401），请检查用户名与密码".to_string(),
            403 => "WebDAV 拒绝访问（HTTP 403）".to_string(),
            404 => "WebDAV 路径不存在（HTTP 404），请检查备份地址".to_string(),
            405 => "WebDAV 服务器不支持该操作（HTTP 405）".to_string(),
            507 => "WebDAV 服务器存储空间不足（HTTP 507）".to_string(),
            other => format!("WebDAV {action}失败（HTTP {other}）"),
        };
        WebDavError::new(self.redact(&message))
    }
}

/// 把 curl `--write-out` 追加的状态码从输出尾部拆出来。
fn split_status(stdout: &[u8]) -> (Vec<u8>, Option<u16>) {
    let Some(index) = stdout.iter().rposition(|byte| *byte == b'\n') else {
        return (stdout.to_vec(), None);
    };
    let status = std::str::from_utf8(&stdout[index + 1..])
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok());
    (stdout[..index].to_vec(), status)
}

/// 文件名按 URL 路径段编码；备份名本身只含 ASCII 安全字符，这里兜底。
fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::BTreeMap;

    use crate::webdav_fake::{FakeDav, FakeState};

    const USERNAME: &str = "pierwave";
    const PASSWORD: &str = "s3cret-pass";

    fn client(fake: &FakeDav) -> WebDavClient {
        WebDavClient::new(fake.base_url.clone(), USERNAME, PASSWORD)
    }

    fn temp_file(tag: &str, content: &[u8]) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("pierwave-webdav-{tag}-{}.gz", uuid::Uuid::new_v4()));
        std::fs::write(&path, content).unwrap();
        path
    }

    #[tokio::test]
    async fn put_list_delete_round_trip_against_local_server() {
        let fake = FakeDav::start(FakeState {
            files: BTreeMap::from([(
                "pierwave-backup-20260101-000000.db.gz".to_string(),
                (vec![1u8; 10], 1_767_225_600),
            )]),
            ..Default::default()
        })
        .await;
        let client = client(&fake);

        client.test_connection().await.unwrap();
        let before = client.list().await.unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].name, "pierwave-backup-20260101-000000.db.gz");
        assert_eq!(before[0].size, 10);
        assert_eq!(before[0].modified, Some(1_767_225_600));

        let path = temp_file("upload", b"gzip-bytes");
        client
            .put_file("pierwave-backup-20261115-190533.db.gz", &path)
            .await
            .unwrap();
        std::fs::remove_file(path).unwrap();

        {
            let state = fake.state();
            assert_eq!(
                state.files["pierwave-backup-20261115-190533.db.gz"].0, b"gzip-bytes",
                "PUT 的原始字节必须完整落到远端"
            );
            assert!(
                state
                    .requests
                    .iter()
                    .any(|line| line.starts_with("PROPFIND")),
                "必须发 PROPFIND：{:?}",
                state.requests
            );
            assert!(
                state.requests.iter().any(|line| line.starts_with("PUT")),
                "必须发 PUT：{:?}",
                state.requests
            );
            assert!(
                state
                    .authorization
                    .iter()
                    .all(|value| value.starts_with("Basic ")),
                "每个请求都要带 Basic 认证：{:?}",
                state.authorization
            );
        }

        let listed = client.list().await.unwrap();
        assert_eq!(listed.len(), 2);

        client
            .delete("pierwave-backup-20260101-000000.db.gz")
            .await
            .unwrap();
        assert!(
            !fake
                .state()
                .files
                .contains_key("pierwave-backup-20260101-000000.db.gz"),
            "DELETE 必须真的删掉文件"
        );
        // 重复删除不报错（幂等）。
        client
            .delete("pierwave-backup-20260101-000000.db.gz")
            .await
            .unwrap();
    }

    /// 恶意/异常远端返回超大 PROPFIND 时，客户端必须报错，不能把整段 XML 读进来当正常结果。
    #[tokio::test]
    async fn oversized_propfind_responses_are_rejected() {
        let fake = FakeDav::start(FakeState {
            oversized_propfind_bytes: (crate::outbound::MAX_OUTBOUND_BODY_BYTES + 1) as usize,
            ..Default::default()
        })
        .await;
        let client = client(&fake);

        let error = client
            .test_connection()
            .await
            .expect_err("17 MiB 的 PROPFIND 响应必须被拒绝");
        assert!(
            error.message().contains("16 MiB"),
            "错误要可读并带上限：{error}"
        );
        assert!(
            error.message().contains("超过") || error.message().contains("exceeds"),
            "错误要说明是响应体超限：{error}"
        );
    }

    #[tokio::test]
    async fn only_managed_file_names_can_be_put_or_deleted() {
        let fake = FakeDav::start(FakeState::default()).await;
        let client = client(&fake);

        let path = temp_file("unmanaged", b"x");
        let error = client
            .put_file("someone-elses-file.txt", &path)
            .await
            .unwrap_err();
        std::fs::remove_file(path).unwrap();
        assert!(error.message().contains("非本产品"), "{error}");
        assert!(fake.state().files.is_empty(), "拒绝后不能发请求");

        assert!(client.delete("notes.txt").await.is_err());
    }

    #[tokio::test]
    async fn http_errors_are_reported_and_password_is_redacted() {
        let fake = FakeDav::start(FakeState {
            fail_requests: 5,
            fail_status: 401,
            ..Default::default()
        })
        .await;
        let client = client(&fake);

        let error = client.test_connection().await.unwrap_err();
        assert!(error.message().contains("401"), "{error}");
        assert!(error.message().contains("认证失败"), "{error}");
        assert!(
            !error.message().contains(PASSWORD),
            "错误信息不能泄露密码：{error}"
        );

        // 认证头的编码里含密码，但错误信息与日志里不应出现原文。
        let password = "hunter2";
        let client = WebDavClient::new(fake.base_url.clone(), "u", password);
        assert!(
            !client.curl_config().is_empty(),
            "凭据要通过 stdin 配置传给 curl"
        );
        assert!(
            !client
                .connection_args()
                .iter()
                .any(|arg| arg.contains(password)),
            "密码不能进 argv：{:?}",
            client.connection_args()
        );
    }

    #[test]
    fn certificate_verification_is_never_disabled() {
        let client = WebDavClient::new("https://dav.example.com/dav", "u", "p");
        let args = client.connection_args();
        assert!(
            !args.iter().any(|arg| arg == "-k" || arg == "--insecure"),
            "HTTPS 必须校验证书：{args:?}"
        );
        assert!(args.iter().any(|arg| arg == "--proto"));
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "--config" && pair[1] == "-"),
            "凭据走 stdin 配置：{args:?}"
        );
    }

    #[test]
    fn credential_config_survives_quotes_and_backslashes() {
        let client = WebDavClient::new("https://dav.example.com", "u\"ser", "pa\\ss\"word");
        let config = client.curl_config();
        assert!(config.contains("user = \""), "{config}");
        assert!(config.contains("\\\""), "双引号必须转义：{config}");
        assert!(config.contains("\\\\"), "反斜杠必须转义：{config}");
    }
}
