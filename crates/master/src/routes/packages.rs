use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use mmrust_domain::models::Patch;
use mmrust_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DIRECTIONS: &[&str] = &["both", "upload", "download"];

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

pub(crate) fn validate_direction(value: &str) -> AppResult<String> {
    normalize_enum("计费方向", value, DIRECTIONS)
}

pub(crate) fn validate_quota_bytes(quota: Option<i64>) -> AppResult<()> {
    if quota.is_some_and(|quota| quota < 0) {
        return Err(AppError::BadRequest("额度不能为负数".into()));
    }
    Ok(())
}

pub(crate) fn validate_period_days(period_days: Option<i64>) -> AppResult<()> {
    if period_days.is_some_and(|days| !(1..=3650).contains(&days)) {
        return Err(AppError::BadRequest("周期天数必须在 1-3650 之间".into()));
    }
    Ok(())
}

pub(crate) fn validate_reset_day(reset_day: i64) -> AppResult<()> {
    if !(1..=31).contains(&reset_day) {
        return Err(AppError::BadRequest("重置日必须在 1-31 之间".into()));
    }
    Ok(())
}

pub(crate) fn validate_node_ratio(node_ratio: f64) -> AppResult<()> {
    if node_ratio.is_finite() && node_ratio > 0.0 && node_ratio <= 10.0 {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "节点倍率必须大于 0 且不超过 10".into(),
        ))
    }
}

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let items = repo::packages::list(&state.db.pool).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreatePackage {
    pub name: String,
    #[serde(default)]
    pub quota_bytes: Option<i64>,
    #[serde(default)]
    pub period_days: Option<i64>,
    #[serde(default = "default_direction")]
    pub direction: String,
    #[serde(default = "default_node_ratio")]
    pub node_ratio: f64,
}

fn default_direction() -> String {
    "both".into()
}

fn default_node_ratio() -> f64 {
    1.0
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<CreatePackage>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("套餐名称不能为空".into()));
    }
    validate_quota_bytes(req.quota_bytes)?;
    validate_period_days(req.period_days)?;
    let direction = validate_direction(&req.direction)?;
    validate_node_ratio(req.node_ratio)?;

    let package = repo::packages::create(
        &state.db.pool,
        repo::packages::NewPackage {
            name: name.to_string(),
            quota_bytes: req.quota_bytes,
            period_days: req.period_days,
            direction,
            node_ratio: req.node_ratio,
        },
    )
    .await?;

    Ok(Json(json!({ "package": package })))
}

#[derive(Deserialize)]
pub struct UpdatePackage {
    pub name: Option<String>,
    #[serde(default)]
    pub quota_bytes: Patch<i64>,
    #[serde(default)]
    pub period_days: Patch<i64>,
    pub direction: Option<String>,
    pub node_ratio: Option<f64>,
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<UpdatePackage>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    if req.name.is_none()
        && !req.quota_bytes.is_set()
        && !req.period_days.is_set()
        && req.direction.is_none()
        && req.node_ratio.is_none()
    {
        return Err(AppError::BadRequest("至少需要提供一个可更新字段".into()));
    }

    let name = match req.name.as_deref().map(str::trim) {
        Some("") => return Err(AppError::BadRequest("套餐名称不能为空".into())),
        other => other.map(str::to_string),
    };
    if req.quota_bytes.is_set() {
        validate_quota_bytes(req.quota_bytes.value())?;
    }
    if req.period_days.is_set() {
        validate_period_days(req.period_days.value())?;
    }
    let direction = match &req.direction {
        Some(direction) => Some(validate_direction(direction)?),
        None => None,
    };
    if let Some(node_ratio) = req.node_ratio {
        validate_node_ratio(node_ratio)?;
    }

    let package = repo::packages::update(
        &state.db.pool,
        &id,
        repo::packages::UpdatePackage {
            name,
            quota_bytes: req.quota_bytes,
            period_days: req.period_days,
            direction,
            node_ratio: req.node_ratio,
        },
    )
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(json!({ "package": package })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    // 先给业务提示，避免直接把外键错误暴露成 500。
    let references = repo::packages::count_references(&state.db.pool, &id).await?;
    if references > 0 {
        return Err(AppError::BadRequest(format!(
            "该套餐还有 {references} 个用户在用，无法删除"
        )));
    }
    if !repo::packages::delete(&state.db.pool, &id).await? {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}
