//! Agent 一键安装：脚本 + 二进制分发。
//!
//! 面板给出的安装命令是 `curl -fsSL .../api/agent/install.sh?token=... | sudo bash`，
//! 这个模块负责让它真的能跑：校验 token、按架构给下载地址、生成配置与 systemd 单元。

use std::path::PathBuf;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use pierwave_domain::release;
use pierwave_domain::repo;

use crate::error::{AppError, AppResult};
use crate::state::{AgentReleaseConfig, AppState};

#[derive(Deserialize)]
pub struct InstallQuery {
    pub token: Option<String>,
}

/// 从反向代理头或 Host 推出对外的 base url，用于写进 Agent 配置。
pub fn external_base(headers: &HeaderMap) -> String {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| *v == "http" || *v == "https")
        .unwrap_or("http");
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1:8787");
    format!("{scheme}://{host}")
}

pub async fn script(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<InstallQuery>,
) -> AppResult<Response> {
    let token = query
        .token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AppError::coded("install.token_required", None, "缺少 token 参数"))?;

    if repo::servers::find_by_token(&state.db.pool, token)
        .await?
        .is_none()
    {
        return Err(AppError::not_found(
            "install.token_not_found",
            None,
            "资源不存在",
        ));
    }

    let base = external_base(&headers);
    let body = render_script(&base, token);
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/x-shellscript; charset=utf-8")],
        body,
    )
        .into_response())
}

fn render_script(base: &str, token: &str) -> String {
    format!(
        r#"#!/bin/sh
# pierwave-agent 一键安装（由主控生成，token 只对一台服务器有效）
set -eu

TOKEN='{token}'
MASTER_URL='{base}'
DOWNLOAD='{base}/api/agent/download'

if [ "$(id -u)" != "0" ]; then
  echo "请用 root 运行：curl ... | sudo bash" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64)  TARGET='x86_64-unknown-linux-musl' ;;
  aarch64|arm64) TARGET='aarch64-unknown-linux-musl' ;;
  *) echo "不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

echo "==> 下载 pierwave-agent ($TARGET)"
curl -fsSL "$DOWNLOAD/pierwave-agent-$TARGET" -o /usr/local/bin/pierwave-agent
chmod 0755 /usr/local/bin/pierwave-agent

echo "==> 写入配置"
install -d -m 0755 /etc/pierwave-agent
cat > /etc/pierwave-agent/config.toml <<CONF
mode = "remote"
master_url = "$MASTER_URL"
token = "$TOKEN"
connection_mode = "websocket"
xray_mode = "external"
CONF
chmod 0600 /etc/pierwave-agent/config.toml

echo "==> 安装 systemd 单元"
cat > /etc/systemd/system/pierwave-agent.service <<'UNIT'
[Unit]
Description=pierwave Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/pierwave-agent -c /etc/pierwave-agent/config.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now pierwave-agent
echo "==> 完成，查看状态：systemctl status pierwave-agent"
"#,
        token = token,
        base = base.trim_end_matches('/'),
    )
}

/// 从 `PIERWAVE_AGENT_DIST` 目录下发预编译的 agent 二进制。
pub async fn download(
    State(_state): State<AppState>,
    Path(file): Path<String>,
) -> AppResult<Response> {
    if file.contains('/') || file.contains("..") {
        return Err(AppError::coded(
            "install.filename_invalid",
            None,
            "非法的文件名",
        ));
    }
    let Ok(dir) = std::env::var("PIERWAVE_AGENT_DIST") else {
        return Err(AppError::not_found(
            "install.file_not_found",
            None,
            "资源不存在",
        ));
    };
    let path: PathBuf = PathBuf::from(dir).join(&file);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::not_found("install.file_not_found", None, "资源不存在"))?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/octet-stream")],
        Body::from(bytes),
    )
        .into_response())
}

/// 发布资产白名单：每个架构只允许二进制、校验清单、清单签名三种文件。
const RELEASE_TARGETS: [&str; 2] = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];

fn allowed_release_file(file: &str) -> bool {
    RELEASE_TARGETS.iter().any(|target| {
        file == format!("pierwave-agent-{target}")
            || file == format!("SHA256SUMS-{target}")
            || file == format!("SHA256SUMS-{target}.sig")
    })
}

/// 版本只允许出现在 URL 的一个路径段里；规则见
/// [`pierwave_domain::release::is_valid_version`]。
fn valid_release_version(version: &str) -> bool {
    release::is_valid_version(version)
}

fn release_content_type(file: &str) -> &'static str {
    if file.starts_with("SHA256SUMS-") && file.ends_with(".sig") {
        "application/octet-stream"
    } else if file.starts_with("SHA256SUMS-") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

fn release_response(file: &str, bytes: Vec<u8>) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, release_content_type(file)),
            (header::CACHE_CONTROL, "private, max-age=300"),
        ],
        Body::from(bytes),
    )
        .into_response()
}

/// 回源：`http(s)://` 走 curl，其它值按本地目录读取（离线镜像 / 测试）。
///
/// 这里刻意不引入 HTTP 客户端依赖：主控只需要一个「把 URL 拉成字节」的能力，
/// 而安装脚本本来就要求目标机有 curl；把它收敛在一个函数里，测试则完全走本地目录。
async fn fetch_origin(version: &str, file: &str, source: &str) -> Option<Vec<u8>> {
    let source = source.trim_end_matches('/');
    if source.starts_with("http://") || source.starts_with("https://") {
        let url = format!("{source}/{version}/{file}");
        let output = tokio::process::Command::new("curl")
            .args(["-fsSL", "--max-time", "120", "-o", "-", &url])
            .output()
            .await
            .ok()?;
        if output.status.success() {
            Some(output.stdout)
        } else {
            tracing::warn!(
                url,
                status = ?output.status.code(),
                "回源下载 Agent 发布产物失败"
            );
            None
        }
    } else {
        let path = PathBuf::from(source).join(version).join(file);
        tokio::fs::read(&path).await.ok()
    }
}

/// 写缓存：先写临时文件再 rename，避免并发请求读到半截文件。
async fn cache_release(cache_path: &std::path::Path, bytes: &[u8]) {
    let Some(parent) = cache_path.parent() else {
        return;
    };
    if tokio::fs::create_dir_all(parent).await.is_err() {
        return;
    }
    let tmp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    if tokio::fs::write(&tmp, bytes).await.is_ok()
        && tokio::fs::rename(&tmp, cache_path).await.is_err()
    {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
}

/// 中转端点的 server token：优先 `Authorization: Bearer`，兼容 `?token=`。
///
/// Agent 走请求头（避免 token 出现在访问日志/代理日志里），curl 手工调试走 query。
fn request_token<'a>(headers: &'a HeaderMap, query: &'a InstallQuery) -> Option<&'a str> {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            let (scheme, token) = value.split_once(' ')?;
            scheme
                .eq_ignore_ascii_case("bearer")
                .then_some(token.trim())
        })
        .filter(|token| !token.is_empty());
    bearer.or_else(|| {
        query
            .token
            .as_deref()
            .map(str::trim)
            .filter(|token| !token.is_empty())
    })
}

/// 解析最新 Release 的 tag（`v0.6.0`）。
///
/// 生产打 GitHub API；`PIERWAVE_AGENT_LATEST_URL` 指向本地 JSON 文件时读文件，
/// 测试/离线环境完全不碰网络。结果由调用方缓存 5 分钟。
pub async fn fetch_latest_version(config: &AgentReleaseConfig) -> Option<String> {
    let url = config.latest_url.trim();
    if url.is_empty() {
        return None;
    }
    let raw = if url.starts_with("http://") || url.starts_with("https://") {
        let output = tokio::process::Command::new("curl")
            .args([
                "-fsSL",
                "--max-time",
                "15",
                "-H",
                "Accept: application/vnd.github+json",
                "-H",
                "User-Agent: pierwave-master",
                url,
            ])
            .output()
            .await
            .ok()?;
        if !output.status.success() {
            tracing::warn!(
                url,
                status = ?output.status.code(),
                "查询最新 Agent 版本失败"
            );
            return None;
        }
        String::from_utf8(output.stdout).ok()?
    } else {
        tokio::fs::read_to_string(url).await.ok()?
    };

    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let tag = value.get("tag_name")?.as_str()?.trim();
    release::is_valid_version(tag).then(|| tag.to_string())
}

/// `GET /api/agent/release/{version}/{file}`：带 server token 的发布产物中转。
///
/// Agent 在内网也能升级：主控回源 GitHub 一次并落缓存，后续请求直接读盘。
/// 鉴权与安装脚本一致（token 只对一台服务器有效），避免被当成公开 CDN。
///
/// 路由用通配段再手工切分，而不是 `{version}/{file}`：这样多出来的路径段
/// （目录穿越）不会落到 SPA 的 index.html 上变成 200，而是统一 404。
pub async fn release(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(rest): Path<String>,
    Query(query): Query<InstallQuery>,
) -> AppResult<Response> {
    let token = request_token(&headers, &query)
        .ok_or_else(|| AppError::unauthorized("auth.unauthorized", None, "未登录"))?;
    if repo::servers::find_by_token(&state.db.pool, token)
        .await?
        .is_none()
    {
        return Err(AppError::unauthorized("auth.unauthorized", None, "未登录"));
    }

    // 必须恰好是 `{version}/{file}` 两段。
    let mut segments = rest.split('/');
    let (Some(version), Some(file), None) = (segments.next(), segments.next(), segments.next())
    else {
        return Err(AppError::not_found(
            "install.release_not_found",
            None,
            "资源不存在",
        ));
    };
    if version.is_empty() || file.is_empty() {
        return Err(AppError::not_found(
            "install.release_not_found",
            None,
            "资源不存在",
        ));
    }

    // 非法版本/文件名一律 404：既不暴露「哪个文件存在」，也防目录穿越。
    if !valid_release_version(version) || !allowed_release_file(file) {
        return Err(AppError::not_found(
            "install.release_not_found",
            None,
            "资源不存在",
        ));
    }

    let cache_path = state.agent_release.cache_path(version, file);
    if let Ok(bytes) = tokio::fs::read(&cache_path).await {
        return Ok(release_response(file, bytes));
    }

    let Some(bytes) = fetch_origin(version, file, &state.agent_release.source).await else {
        return Err(AppError::service_unavailable(
            "install.release_unavailable",
            Some(json!({ "file": file, "version": version })),
            format!(
                "无法获取 Agent 发布产物 {file}（版本 {version}）：主控回源 GitHub 失败，且本地没有缓存。\
                 请确认主控能访问外网，或稍后重试。"
            ),
        ));
    };

    cache_release(&cache_path, &bytes).await;
    Ok(release_response(file, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::Db;

    async fn setup() -> (Router, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let (_server, token) = repo::servers::create(&db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        let state = crate::state::AppState::new(db, "web/dist");
        (crate::app::router(state), token)
    }

    async fn get(app: &Router, uri: &str, host: &str) -> (StatusCode, String) {
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header(header::HOST, host)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 22)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).to_string())
    }

    #[tokio::test]
    async fn serves_script_with_token_and_host() {
        let (app, token) = setup().await;
        let (status, body) = get(
            &app,
            &format!("/api/agent/install.sh?token={token}"),
            "panel.example.com",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("TOKEN='"), "脚本里应有 token");
        assert!(body.contains(&token));
        assert!(body.contains("MASTER_URL='http://panel.example.com'"));
        assert!(body.contains("systemctl enable --now pierwave-agent"));
    }

    #[tokio::test]
    async fn respects_forwarded_proto() {
        let (app, token) = setup().await;
        let request = Request::builder()
            .method(Method::GET)
            .uri(format!("/api/agent/install.sh?token={token}"))
            .header(header::HOST, "panel.example.com")
            .header("x-forwarded-proto", "https")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 22)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("MASTER_URL='https://panel.example.com'"));
    }

    #[tokio::test]
    async fn rejects_unknown_or_missing_token() {
        let (app, _) = setup().await;
        let (status, _) = get(&app, "/api/agent/install.sh?token=nope", "p.example.com").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = get(&app, "/api/agent/install.sh", "p.example.com").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn download_404_without_dist_dir() {
        let (app, _) = setup().await;
        let (status, _) = get(
            &app,
            "/api/agent/download/pierwave-agent-x86_64",
            "p.example.com",
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    // ---- 发布产物中转 ----

    use crate::state::AgentReleaseConfig;

    /// 每个用例一个独立目录，避免并行测试互相污染。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pierwave-release-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn setup_release(cache: &std::path::Path, source: &std::path::Path) -> (Router, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let (_server, token) = repo::servers::create(&db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        let mut state = crate::state::AppState::new(db, "web/dist");
        state.agent_release = AgentReleaseConfig {
            cache_dir: cache.to_path_buf(),
            source: source.to_string_lossy().into_owned(),
            target: crate::state::DEFAULT_AGENT_TARGET.into(),
            latest_url: source.join("latest.json").to_string_lossy().into_owned(),
        };
        (crate::app::router(state), token)
    }

    async fn get_bytes(app: &Router, uri: &str) -> (StatusCode, Vec<u8>) {
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header(header::HOST, "panel.example.com")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 22)
            .await
            .unwrap();
        (status, bytes.to_vec())
    }

    #[tokio::test]
    async fn release_requires_server_token() {
        let cache = temp_dir("auth-cache");
        let source = temp_dir("auth-source");
        let (app, token) = setup_release(&cache, &source).await;
        let uri = "/api/agent/release/0.6.0/pierwave-agent-x86_64-unknown-linux-musl";

        // 没 token / token 不对都应该是 401，不能退化成公开 CDN。
        assert_eq!(get_bytes(&app, uri).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(
            get_bytes(&app, &format!("{uri}?token=nope")).await.0,
            StatusCode::UNAUTHORIZED
        );
        // 合法 token 通过鉴权（文件不存在 → 503，说明已经走到回源逻辑）。
        assert_eq!(
            get_bytes(&app, &format!("{uri}?token={token}")).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn release_accepts_bearer_token() {
        let cache = temp_dir("bearer-cache");
        let source = temp_dir("bearer-source");
        let file = "pierwave-agent-x86_64-unknown-linux-musl";
        std::fs::create_dir_all(cache.join("0.6.0")).unwrap();
        std::fs::write(cache.join("0.6.0").join(file), b"bearer-binary").unwrap();
        let (app, token) = setup_release(&cache, &source).await;

        let request = Request::builder()
            .method(Method::GET)
            .uri(format!("/api/agent/release/0.6.0/{file}"))
            .header(header::HOST, "panel.example.com")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 22)
            .await
            .unwrap();
        assert_eq!(bytes.as_ref(), b"bearer-binary");

        // 非法 Bearer 同样 401。
        let request = Request::builder()
            .method(Method::GET)
            .uri(format!("/api/agent/release/0.6.0/{file}"))
            .header(header::HOST, "panel.example.com")
            .header(header::AUTHORIZATION, "Bearer nope")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn release_serves_cache_without_touching_origin() {
        let cache = temp_dir("hit-cache");
        let source = temp_dir("hit-source");
        let file = "pierwave-agent-x86_64-unknown-linux-musl";
        std::fs::create_dir_all(cache.join("0.6.0")).unwrap();
        std::fs::write(cache.join("0.6.0").join(file), b"cached-binary").unwrap();
        // 回源目录故意留空：命中缓存时不应该去读它。
        let (app, token) = setup_release(&cache, &source).await;

        let (status, body) = get_bytes(
            &app,
            &format!("/api/agent/release/0.6.0/{file}?token={token}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, b"cached-binary");
    }

    #[tokio::test]
    async fn release_fetches_miss_from_origin_and_caches_it() {
        let cache = temp_dir("miss-cache");
        let source = temp_dir("miss-source");
        let file = "SHA256SUMS-aarch64-unknown-linux-musl";
        std::fs::create_dir_all(source.join("v0.6.0")).unwrap();
        std::fs::write(source.join("v0.6.0").join(file), b"deadbeef  agent\n").unwrap();
        let (app, token) = setup_release(&cache, &source).await;

        let (status, body) = get_bytes(
            &app,
            &format!("/api/agent/release/v0.6.0/{file}?token={token}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, b"deadbeef  agent\n");
        // 成功回源后必须落缓存，下一次离线也能用。
        assert_eq!(
            std::fs::read(cache.join("v0.6.0").join(file)).unwrap(),
            b"deadbeef  agent\n"
        );

        // 删掉回源目录再请求一次：现在应该只走缓存。
        std::fs::remove_dir_all(&source).unwrap();
        let (status, body) = get_bytes(
            &app,
            &format!("/api/agent/release/v0.6.0/{file}?token={token}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, b"deadbeef  agent\n");
    }

    #[tokio::test]
    async fn release_rejects_paths_outside_the_whitelist() {
        let cache = temp_dir("whitelist-cache");
        let source = temp_dir("whitelist-source");
        let (app, token) = setup_release(&cache, &source).await;

        for uri in [
            // 不在三类文件里
            "/api/agent/release/0.6.0/install.sh",
            "/api/agent/release/0.6.0/pierwave-agent-x86_64",
            "/api/agent/release/0.6.0/SHA256SUMS",
            "/api/agent/release/0.6.0/../master",
            // 多出来的路径段不能落到 SPA 兜底上
            "/api/agent/release/0.6.0/pierwave-agent-x86_64-unknown-linux-musl/extra",
            // 非法版本段
            "/api/agent/release/../pierwave-agent-x86_64-unknown-linux-musl",
            "/api/agent/release/0.6.0%2F..%2Fevil/pierwave-agent-x86_64-unknown-linux-musl",
            "/api/agent/release/latest/pierwave-agent-x86_64-unknown-linux-musl",
        ] {
            let status = get_bytes(&app, &format!("{uri}?token={token}")).await.0;
            assert_eq!(status, StatusCode::NOT_FOUND, "应拒绝：{uri}");
        }
    }

    #[tokio::test]
    async fn release_returns_503_with_chinese_hint_when_origin_fails() {
        let cache = temp_dir("fail-cache");
        let source = temp_dir("fail-source"); // 空目录：mock 回源失败
        let (app, token) = setup_release(&cache, &source).await;
        let (status, body) = get_bytes(
            &app,
            &format!(
                "/api/agent/release/0.6.0/pierwave-agent-x86_64-unknown-linux-musl?token={token}"
            ),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        let message = String::from_utf8_lossy(&body);
        assert!(message.contains("回源 GitHub 失败"), "{message}");
        assert!(message.contains("缓存"), "{message}");
    }
}
