use axum::extract::State;
use axum::Json;
use serde_json::json;

use pierwave_domain::repo;

use crate::state::AppState;

/// 公开接口：登录页在未鉴权时也要能拿到面板名称。
///
/// 面板名称存在 `settings` 表里，但 `GET /api/v1/settings` 要管理员权限，
/// 所以这里单独暴露一个字段，而不是让登录页去猜。
pub async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let panel_name = repo::settings::get(&state.db.pool, "panel_name")
        .await
        .ok()
        .flatten()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "PierWave".to_string());

    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "panel_name": panel_name,
    }))
}
