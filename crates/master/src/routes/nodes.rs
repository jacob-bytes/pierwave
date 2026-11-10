use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::{Patch, Server};
use pierwave_domain::repo;
use pierwave_domain::xray;

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
            Some(sqlx::Error::RowNotFound) => {
                AppError::not_found("server.not_found", None, "资源不存在")
            }
            _ => AppError::Internal(e),
        })
}

fn normalize_enum(field: &str, value: &str, allowed: &[&str]) -> AppResult<String> {
    let value = value.trim().to_ascii_lowercase();
    if allowed.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(AppError::coded(
            "common.enum_invalid",
            Some(json!({
                "field": field,
                "value": value,
                "allowed": allowed,
            })),
            format!("不支持的{field}：{value}（可选：{}）", allowed.join(" / ")),
        ))
    }
}

fn validate_port(port: i64) -> AppResult<()> {
    if (1..=65535).contains(&port) {
        Ok(())
    } else {
        Err(AppError::coded(
            "node.port_invalid",
            Some(json!({ "min": 1, "max": 65535 })),
            "端口必须在 1-65535 之间",
        ))
    }
}

/// 带宽上限：0 = 不限；上限 10 Gbps。`None`（未配置）同样表示不限。
fn validate_bandwidth_kbps(bandwidth_kbps: Option<i64>) -> AppResult<()> {
    match bandwidth_kbps {
        None => Ok(()),
        Some(kbps) if (0..=10_000_000).contains(&kbps) => Ok(()),
        Some(_) => Err(AppError::coded(
            "node.bandwidth_kbps_invalid",
            Some(json!({ "min": 0, "max": 10_000_000 })),
            "带宽上限必须在 0-10000000 kbps 之间（0 表示不限）",
        )),
    }
}

/// 校验节点与证书的绑定关系：TLS 必须有且证书存在，非 TLS 不允许携带证书。
async fn validate_cert_binding(
    state: &AppState,
    security: &str,
    cert_id: Option<&str>,
) -> AppResult<()> {
    if security == "tls" {
        let Some(cert_id) = cert_id else {
            return Err(AppError::coded(
                "node.cert_required",
                None,
                "TLS 节点必须绑定证书",
            ));
        };
        if repo::certificates::find_by_id(&state.db.pool, cert_id)
            .await?
            .is_none()
        {
            return Err(AppError::coded(
                "node.cert_not_found",
                None,
                "绑定的证书不存在",
            ));
        }
        return Ok(());
    }
    if cert_id.is_some() {
        return Err(AppError::coded(
            "node.cert_tls_only",
            None,
            "只有 TLS 节点才能绑定证书",
        ));
    }
    Ok(())
}

fn normalize_cert_id(raw: Option<&str>) -> AppResult<Option<String>> {
    match raw.map(str::trim) {
        None | Some("") => Ok(None),
        Some(id) if id.chars().count() > 64 => Err(AppError::coded(
            "node.cert_id_invalid",
            None,
            "证书 id 不合法",
        )),
        Some(id) => Ok(Some(id.to_string())),
    }
}

fn ensure_object(config: &Value) -> AppResult<()> {
    if config.is_object() {
        Ok(())
    } else {
        Err(AppError::coded(
            "node.config_invalid",
            None,
            "config 必须是 JSON 对象",
        ))
    }
}

/// Shadowsocks 的 `settings` 校验：方法白名单、密钥长度、`network`。
///
/// 规则本身在 `pierwave_domain::xray` 里（配置生成与订阅共用同一套判定），
/// 这里只把领域错误翻成 HTTP 400。新建/修改都要过，否则会把「xray -test
/// 一定失败」的节点写进库：apply 时才被跳过，用户看到的是订阅里有、服务器上没有。
fn validate_shadowsocks(protocol: &str, config: &Value) -> AppResult<()> {
    if !matches!(protocol, "shadowsocks" | "ss") {
        return Ok(());
    }
    match xray::shadowsocks_problem(config) {
        Some(problem) => Err(AppError::coded(
            problem.code,
            problem.params_option(),
            problem.message,
        )),
        None => Ok(()),
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
    /// `security = tls` 时必填。
    #[serde(default)]
    pub cert_id: Option<String>,
    /// 节点带宽上限（kbps）；缺省 / 0 = 不限。
    #[serde(default)]
    pub bandwidth_kbps: Option<i64>,
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
        return Err(AppError::coded(
            "node.name_required",
            None,
            "节点名称不能为空",
        ));
    }
    let protocol = normalize_enum("协议", &req.protocol, PROTOCOLS)?;
    let transport = normalize_enum("传输方式", &req.transport, TRANSPORTS)?;
    let security = normalize_enum("安全类型", &req.security, SECURITIES)?;
    validate_port(req.port)?;
    validate_bandwidth_kbps(req.bandwidth_kbps)?;
    ensure_object(&req.config)?;
    validate_shadowsocks(&protocol, &req.config)?;
    let cert_id = normalize_cert_id(req.cert_id.as_deref())?;
    validate_cert_binding(&state, &security, cert_id.as_deref()).await?;

    let tag = req
        .tag
        .as_deref()
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_string);
    if let Some(tag) = &tag {
        if tag.chars().count() > 64 {
            return Err(AppError::coded(
                "node.tag_too_long",
                Some(json!({ "max": 64 })),
                "tag 不能超过 64 个字符",
            ));
        }
        let nodes = repo::nodes::list_by_server(&state.db.pool, &server_id).await?;
        if nodes.iter().any(|node| node.tag == *tag) {
            return Err(AppError::coded(
                "node.tag_conflict",
                None,
                "该服务器下已存在相同的 tag",
            ));
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
            cert_id,
            bandwidth_kbps: req.bandwidth_kbps,
        },
    )
    .await?;

    // config 里可能含 REALITY 私钥等敏感内容，审计只记元数据，不记 config 正文。
    crate::audit::record(
        &state,
        &user.0,
        "node.create",
        &node.id,
        json!({
            "server_id": &node.server_id,
            "tag": &node.tag,
            "name": &node.name,
            "protocol": &node.protocol,
            "transport": &node.transport,
            "security": &node.security,
            "port": node.port,
            "enabled": node.enabled != 0,
            "cert_id": &node.cert_id,
            "bandwidth_kbps": node.bandwidth_kbps,
        }),
    )
    .await;

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
    /// 带宽上限（kbps）：不传 = 不改，0 = 取消限速。
    pub bandwidth_kbps: Option<i64>,
    /// 三态：不传 = 不改，`null` = 解绑，字符串 = 绑定证书。
    #[serde(default)]
    pub cert_id: Patch<String>,
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchNode>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    if req.enabled.is_none()
        && req.config.is_none()
        && req.name.is_none()
        && req.port.is_none()
        && req.bandwidth_kbps.is_none()
        && !req.cert_id.is_set()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供 enabled / config / name / port / bandwidth_kbps / cert_id 之一",
        ));
    }
    if let Some(config) = &req.config {
        ensure_object(config)?;
    }
    if let Some(port) = req.port {
        validate_port(port)?;
    }
    validate_bandwidth_kbps(req.bandwidth_kbps)?;
    let name = match req.name.as_deref().map(str::trim) {
        Some("") => {
            return Err(AppError::coded(
                "node.name_required",
                None,
                "节点名称不能为空",
            ))
        }
        Some(name) if name.chars().count() > 64 => {
            return Err(AppError::coded(
                "node.name_too_long",
                Some(json!({ "max": 64 })),
                "节点名称最多 64 个字符",
            ))
        }
        other => other.map(str::to_string),
    };

    let existing = repo::nodes::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("node.not_found", None, "资源不存在"))?;

    // 协议不允许 PATCH，SS 的 settings 规则以库里已有的 protocol 为准。
    if let Some(config) = &req.config {
        validate_shadowsocks(&existing.protocol, config)?;
    }

    // PATCH 的 cert_id 是三态：没传就沿用原绑定；传 null 表示解绑。
    let cert_id = if req.cert_id.is_set() {
        let normalized = match req.cert_id.clone() {
            Patch::Value(value) => normalize_cert_id(Some(&value))?,
            Patch::Null | Patch::Missing => None,
        };
        if normalized.is_some() && existing.security != "tls" {
            return Err(AppError::coded(
                "node.cert_tls_only",
                None,
                "只有 TLS 节点才能绑定证书",
            ));
        }
        if normalized.is_none() && existing.security == "tls" {
            return Err(AppError::coded(
                "node.cert_required",
                None,
                "TLS 节点必须绑定证书",
            ));
        }
        if let Some(cert_id) = &normalized {
            if repo::certificates::find_by_id(&state.db.pool, cert_id)
                .await?
                .is_none()
            {
                return Err(AppError::coded(
                    "node.cert_not_found",
                    None,
                    "绑定的证书不存在",
                ));
            }
        }
        match normalized {
            Some(id) => Patch::Value(id),
            None => Patch::Null,
        }
    } else {
        // 没传就保持原样；但历史 TLS 节点若本来就没证书，不能继续让它空着。
        if existing.security == "tls" && existing.cert_id.is_none() {
            return Err(AppError::coded(
                "node.cert_required",
                None,
                "TLS 节点必须绑定证书",
            ));
        }
        Patch::Missing
    };

    let config_changed = req.config.is_some();
    let update = repo::nodes::UpdateNode {
        enabled: req.enabled,
        config_json: req.config.map(|config| config.to_string()),
        name,
        port: req.port,
        cert_id,
        bandwidth_kbps: req.bandwidth_kbps,
        ..Default::default()
    };
    let node = repo::nodes::update(&state.db.pool, &id, update)
        .await?
        .ok_or_else(|| AppError::not_found("node.not_found", None, "资源不存在"))?;

    // config 可能含私钥，只记「改过」；启用/端口/名称/证书按前后值记。
    let changes = crate::audit::diff(vec![
        (
            "enabled",
            json!(existing.enabled != 0),
            json!(node.enabled != 0),
        ),
        ("port", json!(existing.port), json!(node.port)),
        ("name", json!(existing.name), json!(node.name)),
        ("cert_id", json!(existing.cert_id), json!(node.cert_id)),
        (
            "bandwidth_kbps",
            json!(existing.bandwidth_kbps),
            json!(node.bandwidth_kbps),
        ),
        ("config", json!(false), json!(config_changed)),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "node.update",
        &id,
        json!({
            "server_id": &node.server_id,
            "tag": &node.tag,
            "changes": changes,
        }),
    )
    .await;

    Ok(Json(json!({ "node": node })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let removed = repo::nodes::find_by_id(&state.db.pool, &id).await?;
    if !repo::nodes::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found("node.not_found", None, "资源不存在"));
    }
    if let Some(removed) = removed {
        crate::audit::record(
            &state,
            &user.0,
            "node.delete",
            &id,
            json!({
                "server_id": &removed.server_id,
                "tag": &removed.tag,
                "name": &removed.name,
                "port": removed.port,
            }),
        )
        .await;
    }
    Ok(Json(json!({ "ok": true })))
}

/// 生成完整配置并把新版本广播给该服务器上已连接的 Agent。
///
/// 广播是「期望态」：Agent 只负责幂等收敛，失败通过 ApplyResult 回传。
/// 装配与推送收敛在 `routes::desired`，断流 worker 复用同一条路径。
pub async fn apply(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(server_id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let server = load_server(&state, &server_id).await?;

    let base = super::install::external_base(&headers);
    let outcome = super::desired::apply(&state, &server, &base).await?;
    let warning_count = outcome.warnings.len();
    crate::audit::record(
        &state,
        &user.0,
        "config.apply",
        &server_id,
        json!({
            "version": outcome.version,
            "warnings": warning_count,
        }),
    )
    .await;
    Ok(Json(
        json!({ "config_version": outcome.version, "warnings": outcome.warnings }),
    ))
}

/// 全局节点列表：跨服务器，供套餐范围选择器用。
pub async fn list_all(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let items = repo::nodes::list_all(&state.db.pool).await?;
    Ok(Json(json!({ "items": items })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::Db;
    use pierwave_proto::MasterMessage;

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
                rule_template_id: None,
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
            "security": "none",
            "port": 8443,
            "config": {
                "settings": {"clients": []},
                "stream": {"network": "ws", "security": "none"}
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
                rule_template_id: None,
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
                rule_template_id: None,

                speed_limit_kbps: None,
                node_ids: None,
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
                rule_template_id: None,
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
        let secret = pierwave_domain::credentials::master_secret(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(
            clients[0]["id"],
            pierwave_domain::credentials::sub_uuid(&secret, &eligible.id, &node_id)
        );
        assert_eq!(clients[0]["email"], format!("{}@{node_tag}", eligible.id));
    }

    #[tokio::test]
    async fn node_bandwidth_is_validated_and_carried_in_desired_state() {
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

        let mut payload = vless_node();
        payload["bandwidth_kbps"] = json!(100_000);
        let (status, body) =
            request(&app, Some(&cookie), Method::POST, &nodes_uri, Some(payload)).await;
        assert_eq!(status, StatusCode::OK);
        let node_id = body["node"]["id"].as_str().unwrap().to_string();
        assert_eq!(body["node"]["bandwidth_kbps"], 100_000);

        // 列表视图必须带出该字段，前端表单/列表不用再查详情。
        let (_, body) = request(&app, Some(&cookie), Method::GET, &nodes_uri, None).await;
        assert_eq!(body["items"][0]["bandwidth_kbps"], 100_000);

        let mut subscription = state.hub.subscribe(&server_id);
        let apply_uri = format!("/api/v1/servers/{server_id}/apply");
        let (status, _) = request(&app, Some(&cookie), Method::POST, &apply_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let MasterMessage::Desired(desired) = subscription.receiver.recv().await.unwrap() else {
            panic!("expected desired state");
        };
        assert_eq!(desired.nodes.len(), 1, "期望态必须带启用节点列表");
        assert_eq!(desired.nodes[0].id, node_id);
        assert_eq!(desired.nodes[0].port, 443);
        assert_eq!(desired.nodes[0].bandwidth_kbps, 100_000);

        // 0 = 取消限速；视图与期望态都要同步成 0（Agent 视为不限）。
        let node_uri = format!("/api/v1/nodes/{node_id}");
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &node_uri,
            Some(json!({"bandwidth_kbps": 0})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["node"]["bandwidth_kbps"], 0);

        let (status, _) = request(&app, Some(&cookie), Method::POST, &apply_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let MasterMessage::Desired(desired) = subscription.receiver.recv().await.unwrap() else {
            panic!("expected desired state");
        };
        assert_eq!(desired.nodes[0].bandwidth_kbps, 0);

        // 越界：-1 与 10_000_001 都要 400 + 稳定 code。
        for bad in [-1, 10_000_001] {
            let (status, body) = request(
                &app,
                Some(&cookie),
                Method::PATCH,
                &node_uri,
                Some(json!({"bandwidth_kbps": bad})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "bad={bad}");
            assert_eq!(body["code"], "node.bandwidth_kbps_invalid");
            assert!(body["error"].as_str().unwrap().contains("带宽上限"));
        }
    }

    #[tokio::test]
    async fn package_speed_limit_maps_user_to_policy_level() {
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
        let node_tag = body["node"]["tag"].as_str().unwrap().to_string();

        let alice = repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: "alice".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let package = repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: "限速卡".into(),
                quota_bytes: Some(10_000),
                period_days: Some(30),
                direction: "both".into(),
                node_ratio: 1.0,
                speed_limit_kbps: Some(50_000),
                rule_template_id: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        repo::user_packages::create(
            &state.db.pool,
            &alice.id,
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

        // 50Mbps -> level 1，bufferSize = 50_000 / 160 = 312 KB。
        let levels = &desired.xray["policy"]["levels"];
        assert_eq!(levels["0"]["statsUserUplink"], true);
        assert_eq!(levels["1"]["bufferSize"], 312);
        assert_eq!(levels["1"]["statsUserUplink"], true);

        let clients = desired.xray["inbounds"][0]["settings"]["clients"]
            .as_array()
            .unwrap();
        assert_eq!(clients.len(), 1);
        assert_eq!(
            clients[0]["email"],
            format!("{}@{node_tag}", alice.id),
            "client 必须属于 alice"
        );
        assert_eq!(clients[0]["level"], 1, "client 必须映射到套餐档位");
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
        assert_eq!(body["code"], "node.port_invalid");
        assert_eq!(body["params"]["min"], 1);
        assert_eq!(body["params"]["max"], 65535);

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

    /// 测试用 SS2022 密钥：`bytes` 个 0x07 的 standard base64。
    fn ss_key(bytes: usize) -> String {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        STANDARD.encode(vec![7u8; bytes])
    }

    fn ss_node(method: &str, password: &str, network: &str) -> Value {
        json!({
            "name": "ss-节点",
            "protocol": "shadowsocks",
            "transport": "tcp",
            "security": "none",
            "port": 9000,
            "config": {
                "settings": {
                    "method": method,
                    "password": password,
                    "network": network
                },
                "stream": {"network": "tcp", "security": "none"}
            }
        })
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

    #[tokio::test]
    async fn shadowsocks_create_rejects_invalid_method_key_and_network() {
        let (app, _state, cookie) = setup().await;
        let server_id = create_server(&app, &cookie).await;
        let uri = format!("/api/v1/servers/{server_id}/nodes");

        // 方法不在白名单里 → node.ss_method_invalid
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(ss_node("aes-256-cfb", &ss_key(32), "tcp")),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "node.ss_method_invalid");
        assert_eq!(body["params"]["method"], "aes-256-cfb");
        assert!(body["error"].as_str().unwrap().contains("aes-256-cfb"));

        // 2022 密钥长度不对 → node.ss_key_invalid（16 字节配 256 位方法）
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(ss_node("2022-blake3-aes-256-gcm", &ss_key(16), "tcp")),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "node.ss_key_invalid");
        assert_eq!(body["params"]["expected_bytes"], 32);
        assert_eq!(body["params"]["actual_bytes"], 16);

        // 空密钥 → node.ss_key_invalid（这就是本次要修的历史 bug 形态）
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(ss_node("2022-blake3-aes-256-gcm", "", "tcp")),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "node.ss_key_invalid");

        // 旧 AEAD 密码少于 8 字符 → node.ss_key_invalid
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(ss_node("aes-256-gcm", "short", "tcp")),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "node.ss_key_invalid");

        // network 只允许 tcp / udp / tcp,udp → node.ss_network_invalid
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(ss_node("2022-blake3-aes-256-gcm", &ss_key(32), "ws")),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "node.ss_network_invalid");
        assert_eq!(body["params"]["network"], "ws");

        // 全部被拒后不应留下半成品节点。
        let (status, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["items"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn shadowsocks_create_accepts_2022_and_legacy_keys() {
        let (app, _state, cookie) = setup().await;
        let server_id = create_server(&app, &cookie).await;
        let uri = format!("/api/v1/servers/{server_id}/nodes");

        for (method, password) in [
            ("2022-blake3-aes-256-gcm", ss_key(32)),
            ("2022-blake3-aes-128-gcm", ss_key(16)),
            ("2022-blake3-chacha20-poly1305", ss_key(32)),
            ("aes-256-gcm", "legacy-password".to_string()),
        ] {
            let (status, body) = request(
                &app,
                Some(&cookie),
                Method::POST,
                &uri,
                Some(ss_node(method, &password, "tcp,udp")),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{method} 应当通过：{body}");
            assert_eq!(body["node"]["protocol"], "shadowsocks");
        }

        // 非 SS 协议不受影响：vless 仍然可以不带 settings。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(json!({
                "name": "vless",
                "protocol": "vless",
                "transport": "tcp",
                "security": "none",
                "port": 443,
                "config": {}
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    #[tokio::test]
    async fn shadowsocks_update_validates_the_new_config() {
        let (app, _state, cookie) = setup().await;
        let server_id = create_server(&app, &cookie).await;
        let uri = format!("/api/v1/servers/{server_id}/nodes");

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(ss_node("2022-blake3-aes-256-gcm", &ss_key(32), "tcp")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let node_id = body["node"]["id"].as_str().unwrap().to_string();
        let node_uri = format!("/api/v1/nodes/{node_id}");

        let invalid = json!({
            "settings": {"method": "2022-blake3-aes-256-gcm", "password": "", "network": "tcp"}
        });
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &node_uri,
            Some(json!({ "config": invalid })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "node.ss_key_invalid");

        // 只改名字不该被旧配置拦住；改成合法 config 才落库。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &node_uri,
            Some(json!({ "name": "改名后的 SS" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["node"]["name"], "改名后的 SS");

        let valid = json!({
            "settings": {
                "method": "aes-256-gcm",
                "password": "legacy-password",
                "network": "udp"
            }
        });
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &node_uri,
            Some(json!({ "config": valid })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["node"]["config"]["settings"]["password"],
            "legacy-password"
        );
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
                rule_template_id: None,
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

    #[tokio::test]
    async fn global_node_list_includes_server_name() {
        let (app, state, cookie) = setup().await;
        let (server, _token) = repo::servers::create(&state.db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        repo::nodes::create(
            &state.db.pool,
            &server.id,
            repo::nodes::NewNode {
                tag: Some("vless-1".into()),
                name: "香港-01".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "none".into(),
                port: 443,
                config_json: "{}".into(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();

        let (status, body) = request(&app, Some(&cookie), Method::GET, "/api/v1/nodes", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["server_name"], "hk-1");
        assert_eq!(items[0]["name"], "香港-01");
    }
}
