use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use pierwave_domain::models::Server;
use pierwave_domain::release;
use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;
    let servers = repo::servers::list(&state.db.pool).await?;
    Ok(Json(json!({ "items": servers })))
}

#[derive(Deserialize)]
pub struct CreateServer {
    pub name: String,
    pub address: String,
    #[serde(default = "default_xray_mode")]
    pub xray_mode: String,
}

fn default_xray_mode() -> String {
    "external".into()
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Json(req): Json<CreateServer>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;
    let name = req.name.trim();
    let address = req.address.trim();
    if name.is_empty() || address.is_empty() {
        return Err(AppError::BadRequest("名称和地址不能为空".into()));
    }
    if req.xray_mode != "external" {
        return Err(AppError::BadRequest(
            "目前只支持外置 Xray（external）；内联模式尚未实现".into(),
        ));
    }
    let (server, token) =
        repo::servers::create(&state.db.pool, name, address, &req.xray_mode).await?;
    // 明文 token 不落审计：它只该在创建响应里出现一次。
    crate::audit::record(
        &state,
        &user.0,
        "server.create",
        &server.id,
        json!({
            "name": &server.name,
            "address": &server.address,
            "xray_mode": &server.xray_mode,
        }),
    )
    .await;
    // 明文 token 只在这里出现一次
    Ok(Json(json!({
        "server": server,
        "token": token,
        "install_command": format!(
            "curl -fsSL {}/api/agent/install.sh?token={token} | sudo bash",
            crate::routes::install::external_base(&headers)
        ),
    })))
}

#[derive(Deserialize)]
pub struct PatchServer {
    pub name: Option<String>,
    pub address: Option<String>,
    pub xray_mode: Option<String>,
    /// 是否允许主控向这台服务器下发 Agent 升级计划。
    pub allow_agent_upgrade: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchServer>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;
    let name = match req.name.as_deref().map(str::trim) {
        Some("") => return Err(AppError::BadRequest("服务器名称不能为空".into())),
        Some(name) if name.chars().count() > 64 => {
            return Err(AppError::BadRequest("服务器名称最多 64 个字符".into()))
        }
        other => other,
    };
    let address = match req.address.as_deref().map(str::trim) {
        Some("") => return Err(AppError::BadRequest("服务器地址不能为空".into())),
        other => other,
    };
    if let Some(mode) = req.xray_mode.as_deref() {
        if mode != "external" {
            return Err(AppError::BadRequest(
                "目前只支持外置 Xray（external）；内联模式尚未实现".into(),
            ));
        }
    }
    if name.is_none()
        && address.is_none()
        && req.xray_mode.is_none()
        && req.allow_agent_upgrade.is_none()
    {
        return Err(AppError::BadRequest(
            "至少需要提供 name / address / xray_mode / allow_agent_upgrade 之一".into(),
        ));
    }

    let before = repo::servers::find_by_id(&state.db.pool, &id).await.ok();
    let server = repo::servers::update(
        &state.db.pool,
        &id,
        name,
        address,
        req.xray_mode.as_deref(),
        req.allow_agent_upgrade,
    )
    .await?
    .ok_or(AppError::NotFound)?;

    let changes = crate::audit::diff(vec![
        (
            "name",
            json!(before.as_ref().map(|server| &server.name)),
            json!(&server.name),
        ),
        (
            "address",
            json!(before.as_ref().map(|server| &server.address)),
            json!(&server.address),
        ),
        (
            "xray_mode",
            json!(before.as_ref().map(|server| &server.xray_mode)),
            json!(&server.xray_mode),
        ),
        (
            "allow_agent_upgrade",
            json!(before.as_ref().map(|server| server.allow_agent_upgrade)),
            json!(server.allow_agent_upgrade),
        ),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "server.update",
        &id,
        json!({ "name": &server.name, "changes": changes }),
    )
    .await;

    Ok(Json(json!({ "server": server })))
}

#[derive(Deserialize)]
pub struct AgentUpgradeRequest {
    /// 目标版本，例如 `0.6.0` 或 `v0.6.0`。
    pub version: String,
}

async fn load_server(state: &AppState, id: &str) -> AppResult<Server> {
    repo::servers::find_by_id(&state.db.pool, id)
        .await
        .map_err(|error| match error.downcast_ref::<sqlx::Error>() {
            Some(sqlx::Error::RowNotFound) => AppError::NotFound,
            _ => AppError::Internal(error),
        })
}

/// 触发一次 Agent 自升级。
///
/// 只写「期望版本」这条状态；Agent 收到期望态后自己下载、验签、替换、重启。
/// 这里额外立即 apply 一次，避免后台对账因为「Xray 配置没变」而跳过下发，
/// 让升级计划能第一时间到达在线 Agent。
pub async fn trigger_agent_upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<AgentUpgradeRequest>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;
    let server = load_server(&state, &id).await?;

    if !server.allow_agent_upgrade {
        return Err(AppError::BadRequest(
            "该服务器未开启 Agent 自升级（allow_agent_upgrade = false），请先开启后再试".into(),
        ));
    }

    let version = req.version.trim();
    if !release::is_valid_version(version) {
        return Err(AppError::BadRequest(format!(
            "版本号格式不合法：{version}（示例：0.6.0 或 v0.6.0）"
        )));
    }

    let current = server.agent_version.as_deref().unwrap_or("").trim();
    if current.is_empty() {
        return Err(AppError::BadRequest(
            "服务器尚未上报 Agent 版本，无法判断升级方向；请先让 Agent 上线并发送一次心跳".into(),
        ));
    }
    if !release::is_newer(version, current) {
        return Err(AppError::BadRequest(format!(
            "不允许降级：目标版本 {version} 必须比当前 Agent 版本 {current} 新"
        )));
    }

    if let Some(latest) = repo::agent_upgrades::latest(&state.db.pool, &id).await? {
        if latest.status == "pending" {
            return Err(AppError::BadRequest(format!(
                "该服务器已有进行中的升级（{} → {}），请等待心跳确认完成后再触发",
                latest.from_version, latest.to_version
            )));
        }
    }

    let upgrade = repo::agent_upgrades::create(&state.db.pool, &id, current, version).await?;
    repo::servers::set_agent_target_version(&state.db.pool, &id, Some(version)).await?;

    // 标脏：断流 worker 下次 apply 会带上（或已完成的）升级计划。
    state.enforcement.mark_server_dirty(&id);

    // 立即下发一次：后台对账会因「Xray 配置未变」跳过，不能只依赖它。
    let refreshed = repo::servers::find_by_id(&state.db.pool, &id).await?;
    let base = crate::routes::install::external_base(&headers);
    if let Err(error) = super::desired::apply(&state, &refreshed, &base).await {
        tracing::warn!(server = %refreshed.name, error = %error, "触发升级后立即下发失败（已标脏，稍后重试）");
    }

    crate::audit::record(
        &state,
        &user.0,
        "agent.upgrade",
        &id,
        json!({
            "from": current,
            "to": version,
            "upgrade_id": &upgrade.id,
        }),
    )
    .await;

    Ok(Json(json!({ "upgrade": upgrade })))
}

/// 某台服务器的 Agent 升级历史，最新在前。
pub async fn list_agent_upgrades(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;
    let server = load_server(&state, &id).await?;
    let items = repo::agent_upgrades::list_by_server(&state.db.pool, &server.id).await?;
    Ok(Json(json!({ "items": items })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;
    let removed = repo::servers::find_by_id(&state.db.pool, &id).await.ok();
    if !repo::servers::delete(&state.db.pool, &id).await? {
        return Err(AppError::NotFound);
    }
    if let Some(removed) = removed {
        crate::audit::record(
            &state,
            &user.0,
            "server.delete",
            &id,
            json!({
                "name": &removed.name,
                "address": &removed.address,
                "xray_mode": &removed.xray_mode,
            }),
        )
        .await;
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use pierwave_domain::Db;

    async fn setup() -> (Router, AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = repo::users::create(
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
        let (token, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
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

    async fn send(
        app: &Router,
        cookie: &str,
        method: Method,
        uri: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("cookie", cookie)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn patch_updates_and_delete_cascades_nodes() {
        let (app, state, cookie) = setup().await;

        let (_, created) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"hk-1","address":"1.2.3.4"}),
        )
        .await;
        let id = created["server"]["id"].as_str().unwrap().to_string();
        repo::nodes::create(
            &state.db.pool,
            &id,
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
            },
        )
        .await
        .unwrap();

        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"name":"hk-2"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(patched["server"]["name"], "hk-2");
        assert_eq!(patched["server"]["xray_mode"], "external");
        assert_eq!(
            patched["server"]["address"], "1.2.3.4",
            "没传的字段不应被清空"
        );

        let (status, _) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"name":"  "}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, body) = send(
            &app,
            &cookie,
            Method::DELETE,
            &format!("/api/v1/servers/{id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);

        let nodes = repo::nodes::list_by_server(&state.db.pool, &id)
            .await
            .unwrap();
        assert!(nodes.is_empty(), "服务器删除后节点应级联清理");

        let (status, _) = send(
            &app,
            &cookie,
            Method::DELETE,
            &format!("/api/v1/servers/{id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// 内联 Xray 从未实现过：留着这个选项只会让用户以为它可用。
    #[tokio::test]
    async fn embedded_xray_mode_is_rejected() {
        let (app, _state, cookie) = setup().await;
        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"x","address":"1.2.3.4","xray_mode":"embedded"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"].as_str().unwrap().contains("内联"));
    }

    // ---- Agent 自升级 ----

    async fn seed_server(state: &AppState, allow: bool, agent_version: &str) -> String {
        let (server, _token) = repo::servers::create(&state.db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        repo::servers::update(&state.db.pool, &server.id, None, None, None, Some(allow))
            .await
            .unwrap();
        repo::servers::update_health(
            &state.db.pool,
            &server.id,
            agent_version,
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        server.id
    }

    #[tokio::test]
    async fn agent_upgrade_rejects_downgrade_and_disabled_switch() {
        let (app, state, cookie) = setup().await;

        let id = seed_server(&state, true, "0.6.0").await;
        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/agent-upgrade"),
            serde_json::json!({"version":"0.5.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let message = body["error"].as_str().unwrap();
        assert!(message.contains("不允许降级"), "{message}");

        let id = seed_server(&state, false, "0.5.0").await;
        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/agent-upgrade"),
            serde_json::json!({"version":"0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"].as_str().unwrap().contains("未开启"));
    }

    #[tokio::test]
    async fn agent_upgrade_creates_pending_and_rejects_duplicate() {
        let (app, state, cookie) = setup().await;
        let id = seed_server(&state, true, "0.5.0").await;

        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/agent-upgrade"),
            serde_json::json!({"version":"0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["upgrade"]["status"], "pending");
        assert_eq!(body["upgrade"]["from_version"], "0.5.0");
        assert_eq!(body["upgrade"]["to_version"], "0.6.0");

        let server = repo::servers::find_by_id(&state.db.pool, &id)
            .await
            .unwrap();
        assert_eq!(server.agent_target_version.as_deref(), Some("0.6.0"));
        assert!(server.allow_agent_upgrade);

        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/agent-upgrade"),
            serde_json::json!({"version":"0.7.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"].as_str().unwrap().contains("进行中"));

        let (status, body) = send(
            &app,
            &cookie,
            Method::GET,
            &format!("/api/v1/servers/{id}/agent-upgrades"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 1);
        assert_eq!(body["items"][0]["to_version"], "0.6.0");
    }
}
