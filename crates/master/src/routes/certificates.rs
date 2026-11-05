//! 证书管理（第一步：上传 + 被节点引用 + 随期望态下发，暂不做 ACME）。
//!
//! 契约见 `docs/CERTS.md`：
//! * 列表/创建响应只回元数据，私钥与证书正文永不出现在任何 GET 里；
//! * 删除被节点引用的证书返回 400 并提示引用数；
//! * 解析失败是业务错误（400），不是 500。

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use mmrust_domain::{certificate, repo};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let items = repo::certificates::list_views(&state.db.pool, repo::now()).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateCertificate {
    pub name: String,
    pub cert_pem: String,
    pub key_pem: String,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<CreateCertificate>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("证书名称不能为空".into()));
    }
    if name.chars().count() > 64 {
        return Err(AppError::BadRequest("证书名称最多 64 个字符".into()));
    }

    let parsed = certificate::parse(&req.cert_pem, &req.key_pem)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;

    let cert = repo::certificates::create(
        &state.db.pool,
        repo::certificates::NewCertificate {
            name: name.to_string(),
            domains: parsed.domains,
            cert_pem: req.cert_pem,
            key_pem: req.key_pem,
            not_before: parsed.not_before,
            not_after: parsed.not_after,
        },
    )
    .await?;

    let view = repo::certificates::view_by_id(&state.db.pool, &cert.id, repo::now())
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(json!({ "certificate": view })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    // 先给业务提示，避免外键/悬挂引用变成 500。
    let references = repo::certificates::count_node_references(&state.db.pool, &id).await?;
    if references > 0 {
        return Err(AppError::BadRequest(format!(
            "该证书被 {references} 个节点引用，无法删除"
        )));
    }
    if !repo::certificates::delete(&state.db.pool, &id).await? {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::json;
    use tower::ServiceExt;

    use mmrust_domain::models::CertificateView;
    use mmrust_domain::Db;
    use mmrust_proto::MasterMessage;

    // 一次性自签测试证书（CN=example.com），仅用于测试；不是任何真实环境的密钥。
    const TEST_CERT_PEM: &str = include_str!("../../../domain/tests/fixtures/test-cert.pem");
    const TEST_KEY_PEM: &str = include_str!("../../../domain/tests/fixtures/test-key.pem");
    const TEST_OTHER_KEY_PEM: &str =
        include_str!("../../../domain/tests/fixtures/test-other-key.pem");

    async fn setup() -> (Router, AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let user = repo::users::create(
            &db.pool,
            repo::users::NewUser {
                username: "admin".into(),
                password: "devpass".into(),
                role: "admin".into(),
                quota_bytes: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
        )
    }

    async fn request(
        app: &Router,
        cookie: Option<&str>,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    async fn create_server(app: &Router, cookie: &str) -> String {
        let (status, body) = request(
            app,
            Some(cookie),
            Method::POST,
            "/api/v1/servers",
            Some(json!({"name": "hk-1", "address": "1.2.3.4"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        body["server"]["id"].as_str().unwrap().to_string()
    }

    async fn upload_cert(app: &Router, cookie: &str) -> CertificateView {
        let (status, body) = request(
            app,
            Some(cookie),
            Method::POST,
            "/api/v1/certificates",
            Some(json!({
                "name": "example.com",
                "cert_pem": TEST_CERT_PEM,
                "key_pem": TEST_KEY_PEM,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "上传应成功：{body}");
        serde_json::from_value(body["certificate"].clone()).unwrap()
    }

    fn tls_node(cert_id: Option<&str>, port: i64) -> Value {
        let mut node = json!({
            "name": format!("tls-{port}"),
            "protocol": "trojan",
            "transport": "ws",
            "security": "tls",
            "port": port,
            "config": {
                "settings": {"clients": []},
                "stream": {"network": "ws", "security": "tls", "wsSettings": {"path": "/ws"}}
            }
        });
        if let Some(cert_id) = cert_id {
            node["cert_id"] = json!(cert_id);
        }
        node
    }

    #[tokio::test]
    async fn upload_lists_metadata_only_and_delete_works() {
        let (app, _state, cookie) = setup().await;

        let cert = upload_cert(&app, &cookie).await;
        assert_eq!(cert.name, "example.com");
        assert_eq!(cert.domains, vec!["example.com", "www.example.com"]);
        assert!(cert.days_left > 0, "证书有效期应在未来：{cert:?}");
        assert!(cert.has_key);
        assert!(cert.not_after > cert.not_before);

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/certificates",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], cert.id);
        assert!(items[0]["days_left"].as_i64().unwrap() > 0);
        assert_eq!(items[0]["has_key"], true);
        // 私钥与证书正文绝不能出现在列表响应里。
        let raw = body.to_string();
        assert!(!raw.contains("key_pem"), "列表不能返回私钥字段：{raw}");
        assert!(!raw.contains("cert_pem"), "列表不能返回证书正文字段：{raw}");
        assert!(!raw.contains("PRIVATE KEY"), "列表不能返回私钥正文：{raw}");
        assert!(
            !raw.contains("BEGIN CERTIFICATE"),
            "列表不能返回证书正文：{raw}"
        );

        let uri = format!("/api/v1/certificates/{}", cert.id);
        let (status, body) = request(&app, Some(&cookie), Method::DELETE, &uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/certificates",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["items"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn invalid_pem_returns_400_with_chinese_error() {
        let (app, _state, cookie) = setup().await;

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/certificates",
            Some(json!({"name": "坏证书", "cert_pem": "not-a-pem", "key_pem": "not-a-key"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"].as_str().unwrap().contains("证书"),
            "错误信息应为中文业务提示：{body}"
        );

        // 证书与私钥不是一对：400，而不是把不可用的密钥下发出去。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/certificates",
            Some(json!({"name": "错配", "cert_pem": TEST_CERT_PEM, "key_pem": TEST_OTHER_KEY_PEM})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("不匹配"), "{body}");
    }

    #[tokio::test]
    async fn tls_node_needs_cert_and_apply_ships_two_files_once() {
        let (app, state, cookie) = setup().await;
        let server_id = create_server(&app, &cookie).await;
        let nodes_uri = format!("/api/v1/servers/{server_id}/nodes");

        // TLS 节点不绑证书：直接 400。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &nodes_uri,
            Some(tls_node(None, 8443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"].as_str().unwrap().contains("必须绑定证书"),
            "{body}"
        );

        // 不存在的证书 id 也是 400。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &nodes_uri,
            Some(tls_node(Some("missing-cert"), 8443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("不存在"), "{body}");

        let cert = upload_cert(&app, &cookie).await;

        // 两个节点共用一张证书。
        for port in [8443, 9443] {
            let (status, body) = request(
                &app,
                Some(&cookie),
                Method::POST,
                &nodes_uri,
                Some(tls_node(Some(&cert.id), port)),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "TLS 节点绑定证书应成功：{body}");
            assert_eq!(body["node"]["cert_id"], cert.id);
        }

        // 非 TLS 节点不允许携带 cert_id。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &nodes_uri,
            Some(json!({
                "name": "plain",
                "protocol": "vless",
                "transport": "tcp",
                "security": "none",
                "port": 443,
                "config": {"settings": {"clients": []}},
                "cert_id": cert.id,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"].as_str().unwrap().contains("TLS 节点"),
            "{body}"
        );

        let mut subscription = state.hub.subscribe(&server_id);
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/apply"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["warnings"].as_array().unwrap().is_empty(), "{body}");

        let MasterMessage::Desired(desired) = subscription.receiver.recv().await.unwrap() else {
            panic!("expected desired state");
        };

        // 两个节点共用一个 cert_id：只写一份 .pem + 一份 .key。
        assert_eq!(
            desired.files.len(),
            2,
            "共用证书必须去重：{:?}",
            desired.files
        );
        let cert_path = format!("/usr/local/etc/xray/certs/{}.pem", cert.id);
        let key_path = format!("/usr/local/etc/xray/certs/{}.key", cert.id);
        let cert_file = desired.files.iter().find(|f| f.path == cert_path).unwrap();
        let key_file = desired.files.iter().find(|f| f.path == key_path).unwrap();
        assert_eq!(cert_file.mode, 0o644);
        assert_eq!(key_file.mode, 0o600);
        assert_eq!(cert_file.content, TEST_CERT_PEM);
        assert_eq!(key_file.content, TEST_KEY_PEM);

        let inbounds = desired.xray["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 3, "两个业务节点 + api");
        for inbound in &inbounds[..2] {
            let certificates = inbound["stream"]["tlsSettings"]["certificates"]
                .as_array()
                .unwrap_or_else(|| panic!("TLS 节点必须带 certificates：{inbound}"));
            assert_eq!(certificates.len(), 1);
            assert_eq!(certificates[0]["certificateFile"], cert_path);
            assert_eq!(certificates[0]["keyFile"], key_path);
        }

        // 被节点引用时删除证书 → 400，并提示引用数。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/certificates/{}", cert.id),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"].as_str().unwrap().contains("2 个节点"),
            "应提示引用数：{body}"
        );

        // TLS 节点通过 PATCH 解绑证书 → 400。
        let node_id = {
            let (_, body) = request(&app, Some(&cookie), Method::GET, &nodes_uri, None).await;
            body["items"][0]["id"].as_str().unwrap().to_string()
        };
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/nodes/{node_id}"),
            Some(json!({"cert_id": null})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"].as_str().unwrap().contains("必须绑定证书"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn patch_can_rebind_and_rejects_clearing_tls_cert() {
        let (app, state, cookie) = setup().await;
        let server_id = create_server(&app, &cookie).await;
        let nodes_uri = format!("/api/v1/servers/{server_id}/nodes");
        let cert_a = upload_cert(&app, &cookie).await;

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &nodes_uri,
            Some(tls_node(Some(&cert_a.id), 8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let node_id = body["node"]["id"].as_str().unwrap().to_string();

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &nodes_uri,
            Some(json!({
                "name": "plain",
                "protocol": "vless",
                "transport": "tcp",
                "security": "none",
                "port": 443,
                "config": {"settings": {"clients": []}}
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let plain_id = body["node"]["id"].as_str().unwrap().to_string();

        // 非 TLS 节点禁止绑定证书。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/nodes/{plain_id}"),
            Some(json!({"cert_id": cert_a.id})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("TLS"), "{body}");

        // 造第二张证书，验证 PATCH 能真正改绑定。
        let now = repo::now();
        let cert_b = repo::certificates::create(
            &state.db.pool,
            repo::certificates::NewCertificate {
                name: "second".into(),
                domains: vec!["second.example.com".into()],
                cert_pem: TEST_CERT_PEM.into(),
                key_pem: TEST_KEY_PEM.into(),
                not_before: now - 86_400,
                not_after: now + 365 * 86_400,
            },
        )
        .await
        .unwrap();
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/nodes/{node_id}"),
            Some(json!({"cert_id": cert_b.id})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["node"]["cert_id"], cert_b.id);

        // TLS 节点解绑 → 400。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/nodes/{node_id}"),
            Some(json!({"cert_id": null})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"].as_str().unwrap().contains("必须绑定证书"),
            "{body}"
        );

        // 下发时用的是改绑后的证书。
        let mut subscription = state.hub.subscribe(&server_id);
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/apply"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let MasterMessage::Desired(desired) = subscription.receiver.recv().await.unwrap() else {
            panic!("expected desired state");
        };
        assert_eq!(desired.files.len(), 2);
        assert_eq!(
            desired.files[0].path,
            format!("/usr/local/etc/xray/certs/{}.pem", cert_b.id)
        );
        assert_eq!(
            desired.files[1].path,
            format!("/usr/local/etc/xray/certs/{}.key", cert_b.id)
        );
    }

    #[tokio::test]
    async fn apply_skips_legacy_tls_node_without_cert() {
        let (app, state, cookie) = setup().await;
        let server_id = create_server(&app, &cookie).await;
        // 迁移前的历史数据可以绕过接口直接落库，apply 时必须降级成 warning。
        repo::nodes::create(
            &state.db.pool,
            &server_id,
            repo::nodes::NewNode {
                tag: Some("legacy".into()),
                name: "历史 TLS 节点".into(),
                protocol: "trojan".into(),
                transport: "ws".into(),
                security: "tls".into(),
                port: 8443,
                config_json: json!({
                    "settings": {"clients": []},
                    "stream": {"network": "ws", "security": "tls"}
                })
                .to_string(),
                enabled: true,
                cert_id: None,
            },
        )
        .await
        .unwrap();

        let mut subscription = state.hub.subscribe(&server_id);
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/apply"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let warnings = body["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 1, "{body}");
        assert!(
            warnings[0].as_str().unwrap().contains("未绑定证书"),
            "{body}"
        );

        let MasterMessage::Desired(desired) = subscription.receiver.recv().await.unwrap() else {
            panic!("expected desired state");
        };
        assert_eq!(
            desired.xray["inbounds"].as_array().unwrap().len(),
            1,
            "只剩 api"
        );
        assert!(desired.files.is_empty());
    }

    #[tokio::test]
    async fn overview_counts_certs_expiring_within_30_days() {
        let (app, state, cookie) = setup().await;

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/stats/overview",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["alerts"]["expiring_certs"], 0, "没有证书时为 0");

        let now = repo::now();
        for (name, not_after) in [
            ("10 天后到期", now + 10 * 86_400),
            ("已过期", now - 86_400),
            ("一年后到期", now + 365 * 86_400),
        ] {
            repo::certificates::create(
                &state.db.pool,
                repo::certificates::NewCertificate {
                    name: name.into(),
                    domains: vec!["example.com".into()],
                    cert_pem: TEST_CERT_PEM.into(),
                    key_pem: TEST_KEY_PEM.into(),
                    not_before: now - 86_400,
                    not_after,
                },
            )
            .await
            .unwrap();
        }

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/stats/overview",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["alerts"]["expiring_certs"], 2,
            "10 天内到期 + 已过期都计入：{body}"
        );
        // 原有字段不能被破坏。
        assert!(body["alerts"]["expired_instances"].is_number());
        assert!(body["alerts"]["offline_servers"].is_number());
    }
}
