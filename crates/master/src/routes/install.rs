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

use pierwave_domain::repo;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

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
        .ok_or_else(|| AppError::BadRequest("缺少 token 参数".into()))?;

    if repo::servers::find_by_token(&state.db.pool, token)
        .await?
        .is_none()
    {
        return Err(AppError::NotFound);
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
        return Err(AppError::BadRequest("非法的文件名".into()));
    }
    let Ok(dir) = std::env::var("PIERWAVE_AGENT_DIST") else {
        return Err(AppError::NotFound);
    };
    let path: PathBuf = PathBuf::from(dir).join(&file);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| AppError::NotFound)?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/octet-stream")],
        Body::from(bytes),
    )
        .into_response())
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
}
