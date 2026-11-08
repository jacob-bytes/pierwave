//! 单跳 TCP 端口转发管理（管理员）。
//!
//! 契约：`GET/POST /api/v1/servers/{id}/forwards`、`PATCH/DELETE /api/v1/forwards/{id}`。
//!
//! * 字段校验（端口范围、目标地址、保留端口）走 `pierwave_domain::forwards`；
//! * 端口冲突需要查库：同服务器内的节点端口、其它转发端口；
//! * 每次写操作都标脏并立即下发一次，转发规则不必等 30 秒去抖；
//! * 运行时状态来自 Agent 心跳缓存（`forward_status`），列表里合并成 `runtime`。

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::Server;
use pierwave_domain::{forwards, repo};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub(crate) async fn load_server(state: &AppState, id: &str) -> AppResult<Server> {
    repo::servers::find_by_id(&state.db.pool, id)
        .await
        .map_err(|e| match e.downcast_ref::<sqlx::Error>() {
            Some(sqlx::Error::RowNotFound) => {
                AppError::not_found("server.not_found", None, "资源不存在")
            }
            _ => AppError::Internal(e),
        })
}

async fn load_forward(state: &AppState, id: &str) -> AppResult<pierwave_domain::models::Forward> {
    repo::forwards::find_by_id(&state.db.pool, id)
        .await?
        .ok_or_else(|| AppError::not_found("forward.not_found", None, "资源不存在"))
}

/// 并发下仍可能撞 `UNIQUE(server_id, listen_port)`：翻译成 400 中文而不是 500。
fn map_port_conflict(error: anyhow::Error, port: i64, name: &str) -> AppError {
    let message = format!("{error:#}");
    if message.contains("UNIQUE constraint failed: forwards.server_id, forwards.listen_port") {
        AppError::coded(
            "forward.port_conflict_forward",
            Some(json!({ "port": port, "name": name })),
            format!("监听端口 {port} 已被其它转发规则占用"),
        )
    } else {
        AppError::Internal(error)
    }
}

/// 同一服务器内的端口占用检查，顺序固定：
/// 1. 节点端口（含停用节点）；
/// 2. 其它转发规则（含停用规则）。
///
/// 保留端口在调用前已单独检查，所以这里不会把 22 / 10085 误报成「被节点占用」。
async fn ensure_port_available(
    state: &AppState,
    server_id: &str,
    listen_port: i64,
    exclude_forward_id: Option<&str>,
) -> AppResult<()> {
    if let Some(node) = repo::nodes::find_by_port(&state.db.pool, server_id, listen_port).await? {
        return Err(AppError::coded(
            "forward.port_conflict_node",
            Some(json!({
                "port": listen_port,
                "node": node.name,
                "node_id": node.id,
                "node_tag": node.tag,
            })),
            format!(
                "监听端口 {listen_port} 与节点「{}」（tag {}）的端口冲突",
                node.name, node.tag
            ),
        ));
    }
    if let Some(forward) = repo::forwards::find_by_listen_port(
        &state.db.pool,
        server_id,
        listen_port,
        exclude_forward_id,
    )
    .await?
    {
        return Err(AppError::coded(
            "forward.port_conflict_forward",
            Some(json!({
                "port": listen_port,
                "name": forward.name,
                "id": forward.id,
            })),
            format!(
                "监听端口 {listen_port} 已被转发规则「{}」占用",
                forward.name
            ),
        ));
    }
    Ok(())
}

/// 标脏 + 立即下发一次。
///
/// 立即下发失败不回滚已保存的规则：脏标记还在，后台对账稍后会重试。
async fn mark_dirty_and_apply(state: &AppState, server: &Server, base_url: &str) {
    state.enforcement.mark_server_dirty(&server.id);
    if let Err(error) = super::desired::apply(state, server, base_url).await {
        tracing::warn!(
            server = %server.name,
            error = %error,
            "转发规则已保存，但立即下发失败（已标脏，稍后重试）"
        );
    }
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(server_id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    load_server(&state, &server_id).await?;
    let items = repo::forwards::list_with_status(&state.db.pool, &server_id).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateForward {
    /// 缺省为空串，交给统一校验返回 400 而不是 422。
    #[serde(default)]
    pub name: String,
    pub listen_port: i64,
    #[serde(default)]
    pub target_host: String,
    pub target_port: i64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(server_id): Path<String>,
    Json(req): Json<CreateForward>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let server = load_server(&state, &server_id).await?;

    let name = forwards::normalize_name(&req.name)?;
    let target_host = forwards::normalize_target_host(&req.target_host)?;
    forwards::validate_listen_port(req.listen_port)?;
    forwards::validate_target_port(req.target_port)?;
    forwards::ensure_port_not_reserved(req.listen_port)?;
    forwards::ensure_not_self_loop("0.0.0.0", req.listen_port, &target_host, req.target_port)?;
    ensure_port_available(&state, &server_id, req.listen_port, None).await?;

    let forward_name_for_error = name.clone();
    let forward = repo::forwards::create(
        &state.db.pool,
        &server_id,
        repo::forwards::NewForward {
            name,
            listen_port: req.listen_port,
            target_host,
            target_port: req.target_port,
            enabled: req.enabled,
        },
    )
    .await
    .map_err(|error| map_port_conflict(error, req.listen_port, &forward_name_for_error))?;

    crate::audit::record(
        &state,
        &user.0,
        "forward.create",
        &forward.id,
        json!({
            "server_id": &forward.server_id,
            "name": &forward.name,
            "listen_port": forward.listen_port,
            "target_host": &forward.target_host,
            "target_port": forward.target_port,
            "enabled": forward.enabled,
        }),
    )
    .await;

    let base = super::install::external_base(&headers);
    mark_dirty_and_apply(&state, &server, &base).await;

    Ok(Json(json!({ "forward": forward })))
}

#[derive(Deserialize)]
pub struct PatchForward {
    pub name: Option<String>,
    pub listen_port: Option<i64>,
    pub target_host: Option<String>,
    pub target_port: Option<i64>,
    pub enabled: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchForward>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    if req.name.is_none()
        && req.listen_port.is_none()
        && req.target_host.is_none()
        && req.target_port.is_none()
        && req.enabled.is_none()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供 name / listen_port / target_host / target_port / enabled 之一",
        ));
    }

    let existing = load_forward(&state, &id).await?;

    let name = match req.name.as_deref() {
        Some(raw) => Some(forwards::normalize_name(raw)?),
        None => None,
    };
    let target_host = match req.target_host.as_deref() {
        Some(raw) => Some(forwards::normalize_target_host(raw)?),
        None => None,
    };
    if let Some(port) = req.target_port {
        forwards::validate_target_port(port)?;
    }
    if let Some(port) = req.listen_port {
        forwards::validate_listen_port(port)?;
        forwards::ensure_port_not_reserved(port)?;
        // 端口没变就不必重新查冲突：否则节点后来占用了该端口时，
        // 连「只改目标地址」都会被卡住。端口变化才需要重新校验。
        if port != existing.listen_port {
            ensure_port_available(&state, &existing.server_id, port, Some(&existing.id)).await?;
        }
        // 端口或目标任一变化都要重新查自连，否则「先把目标改成自己」能绕过创建时的检查
        forwards::ensure_not_self_loop(
            "0.0.0.0",
            port,
            req.target_host.as_deref().unwrap_or(&existing.target_host),
            req.target_port.unwrap_or(existing.target_port),
        )?;
    }

    // 并发撞唯一约束时也要能给出规则名；name 马上会被 move 进 UpdateForward。
    let conflict_name = name.as_deref().unwrap_or(&existing.name).to_string();
    let forward = repo::forwards::update(
        &state.db.pool,
        &id,
        repo::forwards::UpdateForward {
            name,
            listen_port: req.listen_port,
            target_host,
            target_port: req.target_port,
            enabled: req.enabled,
        },
    )
    .await
    .map_err(|error| {
        map_port_conflict(
            error,
            req.listen_port.unwrap_or(existing.listen_port),
            &conflict_name,
        )
    })?
    .ok_or_else(|| AppError::not_found("forward.not_found", None, "资源不存在"))?;

    let changes = crate::audit::diff(vec![
        ("name", json!(&existing.name), json!(&forward.name)),
        (
            "listen_port",
            json!(existing.listen_port),
            json!(forward.listen_port),
        ),
        (
            "target_host",
            json!(&existing.target_host),
            json!(&forward.target_host),
        ),
        (
            "target_port",
            json!(existing.target_port),
            json!(forward.target_port),
        ),
        ("enabled", json!(existing.enabled), json!(forward.enabled)),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "forward.update",
        &forward.id,
        json!({
            "server_id": &forward.server_id,
            "name": &forward.name,
            "changes": changes,
        }),
    )
    .await;

    let server = load_server(&state, &existing.server_id).await?;
    let base = super::install::external_base(&headers);
    mark_dirty_and_apply(&state, &server, &base).await;

    Ok(Json(json!({ "forward": forward })))
}

pub async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let existing = load_forward(&state, &id).await?;
    if !repo::forwards::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found("forward.not_found", None, "资源不存在"));
    }

    crate::audit::record(
        &state,
        &user.0,
        "forward.delete",
        &id,
        json!({
            "server_id": &existing.server_id,
            "name": &existing.name,
            "listen_port": existing.listen_port,
            "target_host": &existing.target_host,
            "target_port": existing.target_port,
        }),
    )
    .await;

    let server = load_server(&state, &existing.server_id).await?;
    let base = super::install::external_base(&headers);
    mark_dirty_and_apply(&state, &server, &base).await;

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    use pierwave_domain::Db;
    use pierwave_proto::{DesiredForward, MasterMessage};

    async fn setup() -> (Router, AppState, String, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = repo::users::create(
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
        let (token, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
            .await
            .unwrap();
        let (server, _) = repo::servers::create(&db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
            server.id,
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

    async fn add_node(state: &AppState, server_id: &str, port: i64) -> String {
        repo::nodes::create(
            &state.db.pool,
            server_id,
            repo::nodes::NewNode {
                tag: None,
                name: "已有节点".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "none".into(),
                port,
                config_json: "{}".into(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    fn forward_body(listen_port: i64) -> Value {
        json!({
            "name": "香港中转",
            "listen_port": listen_port,
            "target_host": "10.0.0.8",
            "target_port": 443,
        })
    }

    async fn next_forwards(
        receiver: &mut broadcast::Receiver<MasterMessage>,
    ) -> Vec<DesiredForward> {
        let message = tokio::time::timeout(Duration::from_secs(3), receiver.recv())
            .await
            .expect("写操作应立即下发一次期望态")
            .expect("hub 不应关闭");
        match message {
            MasterMessage::Desired(desired) => desired.forwards,
            other => panic!("expected desired state, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn crud_roundtrip_and_immediate_desired_state() {
        let (app, state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");
        let mut subscription = state.hub.subscribe(&server_id);

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let forward = &body["forward"];
        let id = forward["id"].as_str().unwrap().to_string();
        assert_eq!(forward["name"], "香港中转");
        assert_eq!(forward["listen_port"], 8443);
        assert_eq!(forward["target_host"], "10.0.0.8");
        assert_eq!(forward["target_port"], 443);
        assert_eq!(forward["enabled"], true);
        assert_eq!(forward["server_id"], server_id.as_str());

        // 创建后立即下发：规则必须在期望态里。
        let sent = next_forwards(&mut subscription.receiver).await;
        assert_eq!(sent.len(), 1, "创建后应下发这条转发");
        assert_eq!(sent[0].id, id);
        assert_eq!(sent[0].listen_port, 8443);
        assert_eq!(sent[0].target_host, "10.0.0.8");
        assert_eq!(sent[0].target_port, 443);

        // 列表：没有心跳时 runtime 为 null。
        let (status, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 1);
        assert_eq!(body["items"][0]["id"], id.as_str());
        assert_eq!(body["items"][0]["runtime"], Value::Null);

        // 改端口/目标：旧规则从期望态消失，新规则出现。
        let forward_uri = format!("/api/v1/forwards/{id}");
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &forward_uri,
            Some(json!({
                "listen_port": 9443,
                "target_host": "10.0.0.9",
                "target_port": 8443,
                "name": "香港中转-2",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["listen_port"], 9443);
        assert_eq!(body["forward"]["target_host"], "10.0.0.9");
        assert_eq!(body["forward"]["target_port"], 8443);
        assert_eq!(body["forward"]["name"], "香港中转-2");

        let sent = next_forwards(&mut subscription.receiver).await;
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].id, id);
        assert_eq!(sent[0].listen_port, 9443);
        assert_eq!(sent[0].target_host, "10.0.0.9");
        assert_eq!(sent[0].target_port, 8443);

        // 停用后不再下发。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &forward_uri,
            Some(json!({"enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["enabled"], false);
        assert!(
            next_forwards(&mut subscription.receiver).await.is_empty(),
            "停用的转发不能出现在期望态里"
        );

        // 删除：列表清空，期望态也不再包含它。
        let (status, body) = request(&app, Some(&cookie), Method::DELETE, &forward_uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["ok"], true);

        let (status, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert!(body["items"].as_array().unwrap().is_empty());
        assert!(
            next_forwards(&mut subscription.receiver).await.is_empty(),
            "删除后期望态里不能再出现该转发"
        );

        // 4 次写操作 = 4 次立即下发。
        assert_eq!(
            repo::servers::find_by_id(&state.db.pool, &server_id)
                .await
                .unwrap()
                .config_version,
            4
        );

        // 审计动作齐全。
        let actions: Vec<String> = repo::audit::list(&state.db.pool, 10)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.action)
            .collect();
        for action in ["forward.create", "forward.update", "forward.delete"] {
            assert!(actions.iter().any(|a| a == action), "actions={actions:?}");
        }
    }

    #[tokio::test]
    async fn listen_port_conflicts_with_nodes_and_other_forwards() {
        let (app, state, cookie, server_id) = setup().await;
        add_node(&state, &server_id, 443).await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");

        // 与节点端口冲突。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "forward.port_conflict_node");
        assert!(body["error"].as_str().unwrap().contains("已有节点"));

        // 第一条转发占 8443。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let first_id = body["forward"]["id"].as_str().unwrap().to_string();

        // 与其它转发冲突。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "forward.port_conflict_forward");
        assert!(body["error"].as_str().unwrap().contains("香港中转"));

        // PATCH 改到已占用端口同样拦截（不能绕过创建时的校验）。
        let mut second = forward_body(9443);
        second["name"] = json!("第二条");
        let (status, body) = request(&app, Some(&cookie), Method::POST, &uri, Some(second)).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let second_id = body["forward"]["id"].as_str().unwrap().to_string();
        let second_uri = format!("/api/v1/forwards/{second_id}");

        for port in [8443, 443] {
            let (status, body) = request(
                &app,
                Some(&cookie),
                Method::PATCH,
                &second_uri,
                Some(json!({"listen_port": port})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "port={port} body={body}");
            let expected = if port == 443 {
                "forward.port_conflict_node"
            } else {
                "forward.port_conflict_forward"
            };
            assert_eq!(body["code"], expected, "port={port} body={body}");
        }

        // 改回自己的端口是幂等的：排除自身后不产生冲突。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &second_uri,
            Some(json!({"listen_port": 9443})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");

        // 第一条仍可被独立删除，未被第二条影响。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/forwards/{first_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn blacklist_and_field_validation_return_stable_codes() {
        let (app, _state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");

        // 保留端口：API 10085 / SSH 22。
        for port in [22, 10085] {
            let (status, body) = request(
                &app,
                Some(&cookie),
                Method::POST,
                &uri,
                Some(forward_body(port)),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "port={port} body={body}");
            assert_eq!(body["code"], "forward.port_reserved", "port={port}");
            assert_eq!(body["params"]["port"], port);
        }

        // 端口越界。
        for (port, code) in [
            (0, "forward.listen_port_invalid"),
            (65536, "forward.listen_port_invalid"),
        ] {
            let (status, body) = request(
                &app,
                Some(&cookie),
                Method::POST,
                &uri,
                Some(forward_body(port)),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "port={port} body={body}");
            assert_eq!(body["code"], code);
        }

        // 目标端口越界。
        let mut body = forward_body(8443);
        body["target_port"] = json!(0);
        let (status, value) = request(&app, Some(&cookie), Method::POST, &uri, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.target_port_invalid");

        // 目标地址为空 / 超长。
        let mut empty_host = forward_body(8443);
        empty_host["target_host"] = json!("   ");
        let (status, value) =
            request(&app, Some(&cookie), Method::POST, &uri, Some(empty_host)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.target_host_required");

        let mut long_host = forward_body(8443);
        long_host["target_host"] = json!("a".repeat(256));
        let (status, value) =
            request(&app, Some(&cookie), Method::POST, &uri, Some(long_host)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.target_host_too_long");
        assert_eq!(value["params"]["max"], 255);

        // 名称必填。
        let mut no_name = forward_body(8443);
        no_name["name"] = json!("");
        let (status, value) = request(&app, Some(&cookie), Method::POST, &uri, Some(no_name)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.name_required");

        // 合法的 255 字符地址可以通过（边界值）。
        let mut max_host = forward_body(8443);
        max_host["target_host"] = json!("a".repeat(255));
        let (status, value) =
            request(&app, Some(&cookie), Method::POST, &uri, Some(max_host)).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(
            value["forward"]["target_host"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            255
        );
    }

    #[tokio::test]
    async fn heartbeat_status_is_merged_and_disappears_with_the_rule() {
        let (app, state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let id = body["forward"]["id"].as_str().unwrap().to_string();

        // 第一轮心跳：监听成功。
        repo::forwards::save_status(
            &state.db.pool,
            &server_id,
            &[repo::forwards::NewForwardStatus {
                forward_id: id.clone(),
                listening: true,
                error: String::new(),
            }],
        )
        .await
        .unwrap();

        let (_, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(body["items"][0]["runtime"]["listening"], true);
        assert_eq!(body["items"][0]["runtime"]["error"], "");
        assert!(body["items"][0]["runtime"]["updated_at"].as_i64().unwrap() > 0);

        // 下一轮心跳失败：错误信息覆盖上一轮，不应残留「成功」。
        repo::forwards::save_status(
            &state.db.pool,
            &server_id,
            &[repo::forwards::NewForwardStatus {
                forward_id: id.clone(),
                listening: false,
                error: "端口已被占用".into(),
            }],
        )
        .await
        .unwrap();
        let (_, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(body["items"][0]["runtime"]["listening"], false);
        assert_eq!(body["items"][0]["runtime"]["error"], "端口已被占用");

        // 删规则后：列表里不再出现（即使状态表还残留旧 id）。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/forwards/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (_, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert!(body["items"].as_array().unwrap().is_empty());

        // 空心跳（Agent 已经没有这条规则）也要能清掉缓存。
        repo::forwards::save_status(&state.db.pool, &server_id, &[])
            .await
            .unwrap();
        let (_, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert!(body["items"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn forwards_require_admin() {
        let (app, state, _admin_cookie, server_id) = setup().await;
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

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::GET,
            &format!("/api/v1/servers/{server_id}/forwards"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/forwards"),
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    // 避免「只读 token 未使用」的假警告：`admin_id` 在 setup 里只用于建会话。
    #[tokio::test]
    async fn missing_forward_is_404() {
        let (app, _state, cookie, _server_id) = setup().await;
        let uri = "/api/v1/forwards/00000000-0000-0000-0000-000000000000";
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            uri,
            Some(json!({"enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "forward.not_found");

        let (status, body) = request(&app, Some(&cookie), Method::DELETE, uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "forward.not_found");
    }
}
