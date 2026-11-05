use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use mmrust_domain::repo;

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
    if !matches!(req.xray_mode.as_str(), "external" | "embedded") {
        return Err(AppError::BadRequest(
            "xray_mode 只能是 external 或 embedded".into(),
        ));
    }
    let (server, token) =
        repo::servers::create(&state.db.pool, name, address, &req.xray_mode).await?;
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
        if !matches!(mode, "external" | "embedded") {
            return Err(AppError::BadRequest(
                "xray_mode 只能是 external 或 embedded".into(),
            ));
        }
    }
    if name.is_none() && address.is_none() && req.xray_mode.is_none() {
        return Err(AppError::BadRequest(
            "至少需要提供 name / address / xray_mode 之一".into(),
        ));
    }

    let server =
        repo::servers::update(&state.db.pool, &id, name, address, req.xray_mode.as_deref())
            .await?
            .ok_or(AppError::NotFound)?;
    Ok(Json(json!({ "server": server })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;
    if !repo::servers::delete(&state.db.pool, &id).await? {
        return Err(AppError::NotFound);
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

    use mmrust_domain::Db;

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
            serde_json::json!({"name":"hk-2","xray_mode":"embedded"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(patched["server"]["name"], "hk-2");
        assert_eq!(patched["server"]["xray_mode"], "embedded");
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
}
