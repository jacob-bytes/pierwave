use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use mmrust_domain::models::Server;
use mmrust_domain::repo;
use mmrust_proto::{DesiredState, MasterMessage};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const PROTOCOLS: &[&str] = &["vless", "vmess", "trojan", "shadowsocks", "socks", "http"];
const TRANSPORTS: &[&str] = &[
    "tcp",
    "ws",
    "grpc",
    "http",
    "h2",
    "quic",
    "kcp",
    "httpupgrade",
    "xhttp",
];
const SECURITIES: &[&str] = &["none", "tls", "reality"];

async fn load_server(state: &AppState, id: &str) -> AppResult<Server> {
    repo::servers::find_by_id(&state.db.pool, id)
        .await
        .map_err(|e| match e.downcast_ref::<sqlx::Error>() {
            Some(sqlx::Error::RowNotFound) => AppError::NotFound,
            _ => AppError::Internal(e),
        })
}

fn normalize_enum(field: &str, value: &str, allowed: &[&str]) -> AppResult<String> {
    let value = value.trim().to_ascii_lowercase();
    if allowed.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(AppError::BadRequest(format!(
            "不支持的{field}：{value}（可选：{}）",
            allowed.join(" / ")
        )))
    }
}

fn validate_port(port: i64) -> AppResult<()> {
    if (1..=65535).contains(&port) {
        Ok(())
    } else {
        Err(AppError::BadRequest("端口必须在 1-65535 之间".into()))
    }
}

fn ensure_object(config: &Value) -> AppResult<()> {
    if config.is_object() {
        Ok(())
    } else {
        Err(AppError::BadRequest("config 必须是 JSON 对象".into()))
    }
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(server_id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    load_server(&state, &server_id).await?;
    let items = repo::nodes::list_by_server(&state.db.pool, &server_id).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateNode {
    /// 可选；留空自动生成 `<protocol>-<随机后缀>`。
    #[serde(default)]
    pub tag: Option<String>,
    pub name: String,
    pub protocol: String,
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default = "default_security")]
    pub security: String,
    pub port: i64,
    #[serde(default = "default_config")]
    pub config: Value,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_transport() -> String {
    "tcp".into()
}

fn default_security() -> String {
    "none".into()
}

fn default_config() -> Value {
    json!({})
}

fn default_enabled() -> bool {
    true
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(server_id): Path<String>,
    Json(req): Json<CreateNode>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    load_server(&state, &server_id).await?;

    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("节点名称不能为空".into()));
    }
    let protocol = normalize_enum("协议", &req.protocol, PROTOCOLS)?;
    let transport = normalize_enum("传输方式", &req.transport, TRANSPORTS)?;
    let security = normalize_enum("安全类型", &req.security, SECURITIES)?;
    validate_port(req.port)?;
    ensure_object(&req.config)?;

    let tag = req
        .tag
        .as_deref()
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_string);
    if let Some(tag) = &tag {
        if tag.chars().count() > 64 {
            return Err(AppError::BadRequest("tag 不能超过 64 个字符".into()));
        }
        let nodes = repo::nodes::list_by_server(&state.db.pool, &server_id).await?;
        if nodes.iter().any(|node| node.tag == *tag) {
            return Err(AppError::BadRequest("该服务器下已存在相同的 tag".into()));
        }
    }

    let node = repo::nodes::create(
        &state.db.pool,
        &server_id,
        repo::nodes::NewNode {
            tag,
            name: name.to_string(),
            protocol,
            transport,
            security,
            port: req.port,
            config_json: req.config.to_string(),
            enabled: req.enabled,
        },
    )
    .await?;

    Ok(Json(json!({ "node": node })))
}

#[derive(Deserialize)]
pub struct PatchNode {
    pub enabled: Option<bool>,
    pub config: Option<Value>,
    /// 允许改名：节点名会进订阅，改名后需要重新 apply 才能同步到服务器 tag 以外的地方
    pub name: Option<String>,
    /// 允许改端口：改完不 apply 不生效，前端会提示
    pub port: Option<i64>,
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchNode>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    if req.enabled.is_none() && req.config.is_none() && req.name.is_none() && req.port.is_none() {
        return Err(AppError::BadRequest(
            "至少需要提供 enabled / config / name / port 之一".into(),
        ));
    }
    if let Some(config) = &req.config {
        ensure_object(config)?;
    }
    if let Some(port) = req.port {
        validate_port(port)?;
    }
    let name = match req.name.as_deref().map(str::trim) {
        Some("") => return Err(AppError::BadRequest("节点名称不能为空".into())),
        Some(name) if name.chars().count() > 64 => {
            return Err(AppError::BadRequest("节点名称最多 64 个字符".into()))
        }
        other => other.map(str::to_string),
    };

    let update = repo::nodes::UpdateNode {
        enabled: req.enabled,
        config_json: req.config.map(|config| config.to_string()),
        name,
        port: req.port,
        ..Default::default()
    };
    let node = repo::nodes::update(&state.db.pool, &id, update)
        .await?
        .ok_or(AppError::NotFound)?;

    Ok(Json(json!({ "node": node })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    if !repo::nodes::delete(&state.db.pool, &id).await? {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

/// 生成完整配置并把新版本广播给该服务器上已连接的 Agent。
///
/// 广播是「期望态」：Agent 只负责幂等收敛，失败通过 ApplyResult 回传。
pub async fn apply(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(server_id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let server = load_server(&state, &server_id).await?;

    let desired = super::desired::render(&state, &server).await?;
    let version = repo::servers::bump_config_version(&state.db.pool, &server.id).await?;

    let delivered = state.hub.publish(
        &server.id,
        MasterMessage::Desired(DesiredState {
            version,
            xray: desired.xray,
            files: Vec::new(),
        }),
    );
    for warning in &desired.warnings {
        tracing::warn!(server = %server.name, "{warning}");
    }
    tracing::info!(
        server = %server.name,
        version,
        nodes = desired.node_count,
        grants = desired.grant_count,
        skipped = desired.warnings.len(),
        delivered,
        "desired state published"
    );

    Ok(Json(
        json!({ "config_version": version, "warnings": desired.warnings }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use mmrust_domain::Db;

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

    fn vless_node() -> Value {
        json!({
            "name": "vless-reality",
            "protocol": "vless",
            "transport": "tcp",
            "security": "reality",
            "port": 443,
            "config": {
                "settings": {"clients": [], "decryption": "none"},
                "stream": {"network": "tcp", "security": "reality"}
            }
        })
    }

    fn trojan_node() -> Value {
        json!({
            "name": "trojan-ws",
            "protocol": "trojan",
            "transport": "ws",
            "security": "tls",
            "port": 8443,
            "config": {
                "settings": {"clients": []},
                "stream": {"network": "ws", "security": "tls"}
            }
        })
    }

    #[tokio::test]
    async fn node_crud_and_apply_flow() {
        let (app, state, cookie) = setup().await;

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/servers",
            Some(json!({"name": "hk-1", "address": "1.2.3.4"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let server_id = body["server"]["id"].as_str().unwrap().to_string();

        let nodes_uri = format!("/api/v1/servers/{server_id}/nodes");
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &nodes_uri,
            Some(vless_node()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let vless_id = body["node"]["id"].as_str().unwrap().to_string();
        assert_eq!(body["node"]["config"]["settings"]["decryption"], "none");
        assert!(body["node"]["tag"].as_str().unwrap().starts_with("vless-"));

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &nodes_uri,
            Some(trojan_node()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, body) = request(&app, Some(&cookie), Method::GET, &nodes_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["name"], "vless-reality");
        assert_eq!(items[1]["name"], "trojan-ws");

        // 订阅广播后再 apply，验证下发的是完整配置且顺序与库一致。
        let mut subscription = state.hub.subscribe(&server_id);
        let apply_uri = format!("/api/v1/servers/{server_id}/apply");
        let (status, body) = request(&app, Some(&cookie), Method::POST, &apply_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["config_version"], 1);
        assert!(
            body["warnings"].as_array().unwrap().is_empty(),
            "没有坏节点时 warnings 应为空数组：{body}"
        );

        let desired = subscription.receiver.recv().await.unwrap();
        match desired {
            MasterMessage::Desired(desired) => {
                assert_eq!(desired.version, 1);
                let inbounds = desired.xray["inbounds"].as_array().unwrap();
                // 两个业务节点 + 固定追加在最后的 api 入站。
                assert_eq!(inbounds.len(), 3);
                assert_eq!(inbounds[0]["name"], Value::Null);
                assert_eq!(inbounds[0]["tag"], items[0]["tag"]);
                assert_eq!(inbounds[0]["port"], 443);
                assert_eq!(inbounds[1]["tag"], items[1]["tag"]);
                assert_eq!(inbounds[2]["tag"], "api");
                assert_eq!(desired.xray["outbounds"][0]["protocol"], json!("freedom"));
            }
            _ => panic!("expected desired state"),
        }

        let (status, body) =
            request(&app, Some(&cookie), Method::GET, "/api/v1/servers", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"][0]["config_version"], 1);

        let node_uri = format!("/api/v1/nodes/{vless_id}");
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &node_uri,
            Some(json!({"enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["node"]["enabled"], 0);

        // disabled 节点不再进入期望态。
        let (status, body) = request(&app, Some(&cookie), Method::POST, &apply_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["config_version"], 2);
        match subscription.receiver.recv().await.unwrap() {
            MasterMessage::Desired(desired) => {
                let inbounds = desired.xray["inbounds"].as_array().unwrap();
                assert_eq!(inbounds.len(), 2, "剩一个业务节点 + api");
                assert_eq!(inbounds[1]["tag"], "api");
            }
            _ => panic!("expected desired state"),
        }

        let trojan_id = items[1]["id"].as_str().unwrap().to_string();
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/nodes/{trojan_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/nodes/{trojan_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn apply_injects_clients_for_users_with_active_packages() {
        let (app, state, cookie) = setup().await;

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/servers",
            Some(json!({"name": "hk-1", "address": "1.2.3.4"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let server_id = body["server"]["id"].as_str().unwrap().to_string();

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/nodes"),
            Some(vless_node()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let node_id = body["node"]["id"].as_str().unwrap().to_string();
        let node_tag = body["node"]["tag"].as_str().unwrap().to_string();

        let eligible = repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: "alice".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
            },
        )
        .await
        .unwrap();
        let package = repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: "月卡".into(),
                quota_bytes: Some(10_000),
                period_days: Some(30),
                direction: "both".into(),
                node_ratio: 1.0,
            },
        )
        .await
        .unwrap();
        repo::user_packages::create(
            &state.db.pool,
            &eligible.id,
            repo::user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap();
        // 没有套餐的用户不能拿到 client。
        repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
            },
        )
        .await
        .unwrap();

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
        let clients = desired.xray["inbounds"][0]["settings"]["clients"]
            .as_array()
            .unwrap();
        assert_eq!(clients.len(), 1, "只有有套餐的用户被注入");
        let secret = mmrust_domain::credentials::master_secret(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(
            clients[0]["id"],
            mmrust_domain::credentials::sub_uuid(&secret, &eligible.id, &node_id)
        );
        assert_eq!(clients[0]["email"], format!("{}@{node_tag}", eligible.id));
    }

    #[tokio::test]
    async fn invalid_input_returns_chinese_errors() {
        let (app, _state, cookie) = setup().await;
        let (_, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/servers",
            Some(json!({"name": "hk-1", "address": "1.2.3.4"})),
        )
        .await;
        let server_id = body["server"]["id"].as_str().unwrap();
        let uri = format!("/api/v1/servers/{server_id}/nodes");

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(json!({
                "name": "bad",
                "protocol": "vless",
                "transport": "tcp",
                "security": "none",
                "port": 70000,
                "config": {}
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("端口"));

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(json!({
                "name": "bad",
                "protocol": "vless",
                "transport": "tcp",
                "security": "none",
                "port": 443,
                "config": "not-an-object"
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("JSON"));
    }

    #[tokio::test]
    async fn node_apis_require_admin() {
        let (app, state, _admin_cookie) = setup().await;
        let user = repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: "bob".into(),
                password: "pw".into(),
                role: "user".into(),
                quota_bytes: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&state.db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);

        let (status, body) = request(&app, None, Method::GET, "/api/v1/servers", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "未登录");

        let (status, body) =
            request(&app, Some(&cookie), Method::GET, "/api/v1/servers", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");
    }

    #[tokio::test]
    async fn apply_reports_skipped_nodes_in_warnings() {
        let (app, state, cookie) = setup().await;

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/servers",
            Some(json!({"name": "hk-1", "address": "1.2.3.4"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let server_id = body["server"]["id"].as_str().unwrap().to_string();
        let nodes_uri = format!("/api/v1/servers/{server_id}/nodes");

        // 一个好节点：没有 REALITY 安全层，保持原样进入配置。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &nodes_uri,
            Some(trojan_node()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let good_tag = body["node"]["tag"].as_str().unwrap().to_string();

        // 一个坏节点：REALITY 私钥不是合法的 32 字节，apply 时必须跳过并给出中文说明。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &nodes_uri,
            Some(json!({
                "name": "香港-01",
                "protocol": "vless",
                "transport": "tcp",
                "security": "reality",
                "port": 8443,
                "config": {
                    "settings": {"clients": [], "decryption": "none"},
                    "stream": {
                        "network": "tcp",
                        "security": "reality",
                        "realitySettings": {
                            "serverNames": ["www.example.com"],
                            "privateKey": "not-a-valid-reality-key",
                            "shortIds": ["abcd1234"]
                        }
                    }
                }
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

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
        assert_eq!(body["config_version"], 1, "跳过的节点不改变版本语义");

        let warnings = body["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 1, "每个被跳过的节点一条说明：{body}");
        assert_eq!(warnings[0], "节点 香港-01 被跳过：REALITY 私钥无法解析");

        // 下发的配置里只剩好节点。
        let MasterMessage::Desired(desired) = subscription.receiver.recv().await.unwrap() else {
            panic!("expected desired state");
        };
        let inbounds = desired.xray["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 2);
        assert_eq!(inbounds[0]["tag"], good_tag.as_str());
        assert_eq!(inbounds[1]["tag"], "api");
    }
}
