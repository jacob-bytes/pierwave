use axum::extract::State;
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
