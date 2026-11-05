//! 公开订阅端点：`GET /api/v1/sub/{short_code}`。
//!
//! 短码不是密钥，但泄漏等于送人流量，所以这里只按短码精确匹配；
//! 用户不存在、被禁用、短码写错一律 404，不暴露「这个人存在」。

use std::collections::HashSet;

use axum::extract::{Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, USER_AGENT};
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use sqlx::SqlitePool;

use mmrust_domain::models::User;
use mmrust_domain::subscribe::{self, SubContext, SubNode, TrafficInfo};
use mmrust_domain::{credentials, repo};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SubscribeQuery {
    /// `clash` / `uri`；缺省时按 UA 嗅探。
    pub target: Option<String>,
}

pub async fn get(
    State(state): State<AppState>,
    Path(short_code): Path<String>,
    Query(query): Query<SubscribeQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    // 不存在与禁用共用 404，避免枚举订阅短码。
    let Some(user) = repo::users::find_by_short_code(&state.db.pool, &short_code).await? else {
        return Err(AppError::NotFound);
    };
    if user.status != "active" {
        return Err(AppError::NotFound);
    }

    let secret = credentials::master_secret(&state.db.pool).await?;
    let mut nodes = Vec::new();
    for row in repo::nodes::list_enabled_with_server(&state.db.pool).await? {
        // 缺字段/脏片段的节点在这里被跳过并记 warn，订阅本身照常渲染。
        if let Some(node) = SubNode::from_node(&row.node, &row.server_address, &user.id, &secret) {
            nodes.push(node);
        }
    }
    dedupe_names(&mut nodes);

    let traffic = traffic_for(&state.db.pool, &user).await?;
    let ctx = SubContext {
        nodes: &nodes,
        user_label: &user.username,
        traffic: Some(traffic),
    };

    let user_agent = headers
        .get(USER_AGENT)
        .and_then(|value| value.to_str().ok());
    let exporter = subscribe::select_exporter(query.target.as_deref(), user_agent);
    let body = exporter.render(&ctx)?;

    let mut response = body.into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static(exporter.content_type()),
    );
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));

    if let Some(traffic) = &ctx.traffic {
        let userinfo = traffic.userinfo_header();
        if let Ok(value) = HeaderValue::from_str(&userinfo) {
            response_headers.insert(HeaderName::from_static("subscription-userinfo"), value);
        }
    }

    Ok(response)
}

/// 流量/额度/到期信息。拆不出上下行，`used_bytes` 记到 download 上。
async fn traffic_for(pool: &SqlitePool, user: &User) -> AppResult<TrafficInfo> {
    let packages = repo::user_packages::list_views_by_user(pool, &user.id).await?;
    let expire = packages
        .iter()
        .filter(|item| item.status == "active")
        .filter_map(|item| item.expires_at)
        .max();

    Ok(TrafficInfo {
        upload: 0,
        download: user.used_bytes.max(0) as u64,
        total: user.quota_bytes.and_then(|quota| u64::try_from(quota).ok()),
        expire,
    })
}

/// 节点名只在 `(server_id, tag)` 内唯一，而 Clash 的 proxies 名必须全局唯一：
/// 跨服务器重名时按出现顺序追加 ` (2)`、` (3)`，否则整份配置会被客户端判为非法。
fn dedupe_names(nodes: &mut [SubNode]) {
    let mut used: HashSet<String> = HashSet::new();
    for node in nodes.iter_mut() {
        if used.insert(node.name.clone()) {
            continue;
        }
        let base = node.name.clone();
        let mut index = 2;
        loop {
            let candidate = format!("{base} ({index})");
            if used.insert(candidate.clone()) {
                node.name = candidate;
                break;
            }
            index += 1;
        }
        tracing::warn!(name = %base, "订阅内节点重名，已追加序号");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::json;
    use tower::ServiceExt;

    use mmrust_domain::models::Patch;
    use mmrust_domain::repo::users::NewUser;
    use mmrust_domain::repo::{nodes::NewNode, servers};
    use mmrust_domain::Db;

    const ADDRESS: &str = "203.0.113.10";

    async fn setup() -> (Router, AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();

        let user = repo::users::create(
            &db.pool,
            NewUser {
                username: "alice".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: Some(10_000),
            },
        )
        .await
        .unwrap();
        let (server, _token) = servers::create(&db.pool, "hk-1", ADDRESS, "external")
            .await
            .unwrap();

        repo::nodes::create(
            &db.pool,
            &server.id,
            NewNode {
                tag: Some("hk-reality".into()),
                name: "香港-REALITY".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "reality".into(),
                port: 443,
                config_json: json!({
                    "settings": {"clients": [], "decryption": "none"},
                    "stream": {
                        "network": "tcp",
                        "security": "reality",
                        "realitySettings": {
                            "serverNames": ["www.example.com"],
                            "publicKey": "public-key-abc",
                            "shortIds": ["abcd1234"]
                        }
                    }
                })
                .to_string(),
                enabled: true,
            },
        )
        .await
        .unwrap();

        repo::nodes::create(
            &db.pool,
            &server.id,
            NewNode {
                tag: Some("jp-trojan".into()),
                name: "日本-WS-TLS".into(),
                protocol: "trojan".into(),
                transport: "ws".into(),
                security: "tls".into(),
                port: 8443,
                config_json: json!({
                    "settings": {"clients": []},
                    "stream": {
                        "network": "ws",
                        "security": "tls",
                        "tlsSettings": {"serverName": "jp.example.com"},
                        "wsSettings": {"path": "/ws", "headers": {"Host": "cdn.example.com"}}
                    }
                })
                .to_string(),
                enabled: true,
            },
        )
        .await
        .unwrap();

        // 禁用节点不能出现在订阅里。
        repo::nodes::create(
            &db.pool,
            &server.id,
            NewNode {
                tag: Some("disabled".into()),
                name: "禁用节点".into(),
                protocol: "trojan".into(),
                transport: "ws".into(),
                security: "tls".into(),
                port: 9443,
                config_json: json!({}).to_string(),
                enabled: false,
            },
        )
        .await
        .unwrap();

        let short_code = user.short_code.clone();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (app, state, short_code)
    }

    async fn get(
        app: &Router,
        uri: &str,
        user_agent: Option<&str>,
    ) -> (StatusCode, HeaderMap, String) {
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(user_agent) = user_agent {
            builder = builder.header(header::USER_AGENT, user_agent);
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (status, headers, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
        headers.get(name).and_then(|value| value.to_str().ok())
    }

    #[tokio::test]
    async fn clash_subscription_has_nodes_groups_and_headers() {
        let (app, _state, short_code) = setup().await;

        let (status, headers, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;

        assert_eq!(status, StatusCode::OK);
        assert!(header_str(&headers, "content-type")
            .unwrap()
            .contains("yaml"));
        assert_eq!(header_str(&headers, "cache-control"), Some("no-store"));

        let userinfo = header_str(&headers, "subscription-userinfo").expect("必须有流量头");
        assert!(userinfo.contains("upload=0"), "unexpected: {userinfo}");
        assert!(userinfo.contains("download=0"), "unexpected: {userinfo}");
        assert!(userinfo.contains("total=10000"), "unexpected: {userinfo}");
        assert!(
            !userinfo.contains("expire="),
            "无套餐时应省略 expire：{userinfo}"
        );

        assert!(body.contains("proxies:"), "缺少 proxies 段");
        assert!(body.contains("香港-REALITY"), "缺少节点名");
        assert!(body.contains("日本-WS-TLS"), "缺少节点名");
        assert!(body.contains("reality-opts:"), "缺少 reality 配置");
        assert!(body.contains("ws-opts:"), "缺少 ws 配置");
        assert!(body.contains("GEOIP,CN,DIRECT"));
        assert!(!body.contains("禁用节点"), "禁用节点不应导出");
    }

    #[tokio::test]
    async fn target_and_user_agent_pick_the_exporter() {
        let (app, _state, short_code) = setup().await;

        let (status, headers, body) =
            get(&app, &format!("/api/v1/sub/{short_code}?target=uri"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(header_str(&headers, "content-type")
            .unwrap()
            .contains("text/plain"));
        let lines: Vec<&str> = body.lines().filter(|line| !line.is_empty()).collect();
        assert_eq!(lines.len(), 2, "两个启用节点应各占一行：{body}");
        assert!(lines[0].starts_with("vless://"));
        assert!(lines[1].starts_with("trojan://"));

        // UA 嗅探：Shadowrocket 得到 URI 列表。
        let (status, headers, body) = get(
            &app,
            &format!("/api/v1/sub/{short_code}"),
            Some("Shadowrocket/2.2.0 CFNetwork"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(header_str(&headers, "content-type")
            .unwrap()
            .contains("text/plain"));
        assert!(body.starts_with("vless://"));

        // clash UA 得到 YAML。
        let (status, _headers, body) = get(
            &app,
            &format!("/api/v1/sub/{short_code}"),
            Some("clash-verge/1.5.0 mihomo"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("proxy-groups:"));
    }

    #[tokio::test]
    async fn unknown_short_code_and_disabled_user_are_404() {
        let (app, state, short_code) = setup().await;

        let (status, _headers, _body) = get(&app, "/api/v1/sub/does-not-exist", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        repo::users::update(
            &state.db.pool,
            &repo::users::find_by_short_code(&state.db.pool, &short_code)
                .await
                .unwrap()
                .unwrap()
                .id,
            repo::users::UpdateUser {
                status: Some("disabled".into()),
                quota_bytes: Patch::Missing,
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let (status, _headers, _body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn duplicate_node_names_across_servers_are_made_unique() {
        let (app, state, short_code) = setup().await;

        // 第二台服务器上放一个和第一台同名的节点。
        let (server, _token) = servers::create(&state.db.pool, "jp-1", "198.51.100.7", "external")
            .await
            .unwrap();
        repo::nodes::create(
            &state.db.pool,
            &server.id,
            NewNode {
                tag: Some("hk-reality".into()),
                name: "香港-REALITY".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "tls".into(),
                port: 443,
                config_json: json!({
                    "settings": {"clients": []},
                    "stream": {"network": "tcp", "security": "tls", "tlsSettings": {"serverName": "a.com"}}
                })
                .to_string(),
                enabled: true,
            },
        )
        .await
        .unwrap();

        let (status, _headers, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"香港-REALITY (2)\""));
    }
}
