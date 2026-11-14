use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::{Patch, User};
use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::packages::{
    validate_optional_rule_template_id, validate_quota_bytes, validate_reset_day,
    validate_rule_template_id,
};

const ROLES: &[&str] = &["admin", "user"];
const STATUSES: &[&str] = &["active", "disabled"];

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

fn validate_username(username: &str) -> AppResult<String> {
    let username = username.trim();
    let len = username.chars().count();
    if !(3..=32).contains(&len) {
        return Err(AppError::coded(
            "user.username_length_invalid",
            Some(json!({ "min": 3, "max": 32 })),
            "用户名长度必须在 3-32 个字符之间",
        ));
    }
    Ok(username.to_string())
}

fn validate_password(password: &str) -> AppResult<()> {
    if password.chars().count() < 8 {
        return Err(AppError::coded(
            "user.password_too_short",
            Some(json!({ "min": 8 })),
            "密码至少 8 位",
        ));
    }
    Ok(())
}

async fn load_user(state: &AppState, id: &str) -> AppResult<User> {
    repo::users::find_by_id_opt(&state.db.pool, id)
        .await?
        .ok_or_else(|| AppError::not_found("user.not_found", None, "资源不存在"))
}

async fn user_view(state: &AppState, id: &str) -> AppResult<Value> {
    let view = repo::users::view_by_id(&state.db.pool, id)
        .await?
        .ok_or_else(|| AppError::not_found("user.not_found", None, "资源不存在"))?;
    Ok(json!({ "user": view }))
}

#[derive(Deserialize)]
pub struct ListUsersQuery {
    /// 用户名 / 订阅短码模糊搜索。
    pub q: Option<String>,
    pub limit: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<ListUsersQuery>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let limit = match query.limit.as_deref() {
        None => 200,
        Some(raw) => raw.parse::<i64>().map_err(|_| {
            AppError::coded(
                "query.limit_invalid",
                Some(json!({ "max": 200 })),
                "limit 必须是整数",
            )
        })?,
    };
    let items = repo::users::list_views(&state.db.pool, query.q.as_deref(), limit).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateUser {
    pub username: String,
    pub password: String,
    pub role: Option<String>,
    #[serde(default)]
    pub quota_bytes: Option<i64>,
    /// 用户级规则模板；缺省 / `null` = 跟随套餐 / 全局默认。
    #[serde(default)]
    pub rule_template_id: Option<String>,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<CreateUser>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let username = validate_username(&req.username)?;
    validate_password(&req.password)?;
    validate_quota_bytes(req.quota_bytes)?;
    let rule_template_id =
        validate_optional_rule_template_id(&state, req.rule_template_id.as_deref()).await?;
    let role = match req.role.as_deref() {
        Some(role) => normalize_enum("角色", role, ROLES)?,
        None => "user".to_string(),
    };

    if repo::users::find_by_username(&state.db.pool, &username)
        .await?
        .is_some()
    {
        return Err(AppError::coded("user.username_taken", None, "用户名已存在"));
    }

    let created = repo::users::create(
        &state.db.pool,
        repo::users::NewUser {
            username,
            password: req.password,
            role,
            quota_bytes: req.quota_bytes,
            rule_template_id,
        },
    )
    .await?;

    crate::audit::record(
        &state,
        &user.0,
        "user.create",
        &created.id,
        json!({
            "username": &created.username,
            "role": &created.role,
            "quota_bytes": created.quota_bytes,
            "rule_template_id": created.rule_template_id,
        }),
    )
    .await;

    Ok(Json(user_view(&state, &created.id).await?))
}

#[derive(Deserialize)]
pub struct UpdateUser {
    pub role: Option<String>,
    pub status: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub quota_bytes: Patch<i64>,
    /// 三态：缺失 = 不改；`null` = 解绑；具体 id = 绑定。
    #[serde(default)]
    pub rule_template_id: Patch<String>,
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<UpdateUser>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    if req.role.is_none()
        && req.status.is_none()
        && req.password.is_none()
        && !req.quota_bytes.is_set()
        && !req.rule_template_id.is_set()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供一个可更新字段",
        ));
    }

    let role = match req.role.as_deref() {
        Some(role) => Some(normalize_enum("角色", role, ROLES)?),
        None => None,
    };
    let status = match req.status.as_deref() {
        Some(status) => Some(normalize_enum("状态", status, STATUSES)?),
        None => None,
    };
    if let Some(password) = &req.password {
        validate_password(password)?;
    }
    if req.quota_bytes.is_set() {
        validate_quota_bytes(req.quota_bytes.value())?;
    }
    let rule_template_id = match req.rule_template_id {
        Patch::Missing => Patch::Missing,
        Patch::Null => Patch::Null,
        Patch::Value(id) => Patch::Value(validate_rule_template_id(&state, &id).await?),
    };

    // 防止管理员把自己锁在门外。
    if id == user.0.id && role.as_deref() == Some("user") {
        return Err(AppError::coded(
            "user.cannot_demote_self",
            None,
            "不能把自己降级为普通用户",
        ));
    }
    if id == user.0.id && status.as_deref() == Some("disabled") {
        return Err(AppError::coded(
            "user.cannot_disable_self",
            None,
            "不能禁用自己的账号（否则将无法登录后台）",
        ));
    }

    // 审计要给出「改了什么」，先取一份变更前的快照。
    let before = load_user(&state, &id).await?;

    let updated = repo::users::update(
        &state.db.pool,
        &id,
        repo::users::UpdateUser {
            role,
            status,
            quota_bytes: req.quota_bytes,
            rule_template_id,
        },
    )
    .await?
    .ok_or_else(|| AppError::not_found("user.not_found", None, "资源不存在"))?;

    if let Some(password) = &req.password {
        if !repo::users::set_password(&state.db.pool, &id, password).await? {
            return Err(AppError::not_found("user.not_found", None, "资源不存在"));
        }
    }

    // 只记字段级变更摘要；密码只记「是否改过」，绝不记内容。
    let changes = crate::audit::diff(vec![
        ("role", json!(before.role), json!(updated.role)),
        ("status", json!(before.status), json!(updated.status)),
        (
            "quota_bytes",
            json!(before.quota_bytes),
            json!(updated.quota_bytes),
        ),
        (
            "rule_template_id",
            json!(before.rule_template_id),
            json!(updated.rule_template_id),
        ),
        ("password", json!(false), json!(req.password.is_some())),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "user.update",
        &id,
        json!({ "username": &updated.username, "changes": changes }),
    )
    .await;

    Ok(Json(user_view(&state, &id).await?))
}

pub async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    if id == user.0.id {
        return Err(AppError::coded(
            "user.cannot_delete_self",
            None,
            "不能删除自己",
        ));
    }
    let removed = load_user(&state, &id).await?;
    let outcome = repo::users::delete(&state.db.pool, &id).await?;
    if !outcome.deleted {
        return Err(AppError::not_found("user.not_found", None, "资源不存在"));
    }
    crate::audit::record(
        &state,
        &user.0,
        "user.delete",
        &id,
        json!({
            "username": &removed.username,
            "role": &removed.role,
            "status": &removed.status,
            "affected_servers": outcome.affected_servers.len(),
        }),
    )
    .await;

    // 用户的套餐实例随外键级联删除：所有有启用节点的服务器都要重算授权。
    if let Err(error) = crate::enforcement::mark_user_servers_dirty(&state, &id).await {
        tracing::warn!(user_id = %id, error = %error, "用户删除后标记节点服务器失败");
    }
    // 该用户名下的自助转发/链所在的服务器需要立即下发，否则监听会残留。
    let base = super::install::external_base(&headers);
    for server_id in &outcome.affected_servers {
        match super::forwards::load_server(&state, server_id).await {
            Ok(server) => super::forwards::mark_dirty_and_apply(&state, &server, &base).await,
            Err(error) => tracing::warn!(
                server_id = %server_id,
                error = %error,
                "用户删除后加载服务器失败，跳过立即下发（已标脏，稍后重试）"
            ),
        }
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn list_user_packages(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(user_id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    load_user(&state, &user_id).await?;
    let items = repo::user_packages::list_views_by_user(&state.db.pool, &user_id).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateUserPackage {
    pub package_id: String,
    /// 缺失 = 按套餐周期算到期；显式 null = 永久；具体值 = 指定时间。
    #[serde(default)]
    pub expires_at: Patch<i64>,
    #[serde(default)]
    pub quota_override: Option<i64>,
    pub reset_day: Option<i64>,
}

pub async fn create_user_package(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(user_id): Path<String>,
    Json(req): Json<CreateUserPackage>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    load_user(&state, &user_id).await?;

    let package = repo::packages::find_by_id(&state.db.pool, &req.package_id)
        .await?
        .ok_or_else(|| AppError::not_found("package.not_found", None, "资源不存在"))?;

    validate_quota_bytes(req.quota_override)?;
    if let Some(reset_day) = req.reset_day {
        validate_reset_day(reset_day)?;
    }

    let expires_at = match req.expires_at {
        Patch::Value(ts) => Some(ts),
        Patch::Null => None,
        // 按周期算的到期日落在 UTC+8 自然日的 23:59:59，而不是「绑定时刻 + N×86400」。
        Patch::Missing => package
            .period_days
            .map(|days| pierwave_domain::time::end_of_business_day_after(repo::now(), days)),
    };

    let item = repo::user_packages::create(
        &state.db.pool,
        &user_id,
        repo::user_packages::NewUserPackage {
            package_id: req.package_id,
            quota_override: req.quota_override,
            expires_at,
            reset_day: req.reset_day,
        },
        &package,
    )
    .await?;

    // 新绑卡可能让用户从「不可用」变「可用」：立刻标记，走 30s 去抖恢复；
    // 失败只记日志，5 分钟对账仍会兜底。
    if let Err(error) = crate::enforcement::mark_user_servers_dirty(&state, &user_id).await {
        tracing::error!(%user_id, error = %error, "绑卡后标记期望态失败");
    }

    crate::audit::record(
        &state,
        &user.0,
        "user_package.bind",
        &item.id,
        json!({
            "user_id": &user_id,
            "package_id": &item.package_id,
            "package_name": &item.package_name,
            "quota_override": item.quota_override,
            "quota_bytes": item.quota_bytes,
            "expires_at": item.expires_at,
            "reset_day": item.reset_day,
        }),
    )
    .await;

    Ok(Json(json!({ "item": item })))
}

#[derive(Deserialize)]
pub struct UpdateUserPackage {
    #[serde(default)]
    pub expires_at: Patch<i64>,
    #[serde(default)]
    pub quota_override: Patch<i64>,
    #[serde(default)]
    pub reset_day: Patch<i64>,
    pub status: Option<String>,
}

pub async fn update_user_package(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<UpdateUserPackage>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    if !req.expires_at.is_set()
        && !req.quota_override.is_set()
        && !req.reset_day.is_set()
        && req.status.is_none()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供一个可更新字段",
        ));
    }

    if req.quota_override.is_set() {
        validate_quota_bytes(req.quota_override.value())?;
    }
    if let Some(reset_day) = req.reset_day.value() {
        validate_reset_day(reset_day)?;
    }
    let status = match req.status.as_deref() {
        Some(status) => Some(normalize_enum("状态", status, STATUSES)?),
        None => None,
    };

    let before = repo::user_packages::find_view_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("user_package.not_found", None, "资源不存在"))?;

    let item = repo::user_packages::update(
        &state.db.pool,
        &id,
        repo::user_packages::UpdateUserPackage {
            expires_at: req.expires_at,
            quota_override: req.quota_override,
            reset_day: req.reset_day,
            status,
        },
    )
    .await?
    .ok_or_else(|| AppError::not_found("user_package.not_found", None, "资源不存在"))?;

    // 额度 / 到期 / 状态任一变更都可能跨过可用边界：立刻标记该用户涉及的服务器，
    // 由 apply 时的快照差集决定移除还是恢复；5 分钟对账仍作兜底。
    if let Err(error) = crate::enforcement::mark_user_servers_dirty(&state, &item.user_id).await {
        tracing::error!(user_id = %item.user_id, error = %error, "改套餐后标记期望态失败");
    }

    let changes = crate::audit::diff(vec![
        (
            "quota_override",
            json!(before.quota_override),
            json!(item.quota_override),
        ),
        (
            "quota_bytes",
            json!(before.quota_bytes),
            json!(item.quota_bytes),
        ),
        (
            "expires_at",
            json!(before.expires_at),
            json!(item.expires_at),
        ),
        ("reset_day", json!(before.reset_day), json!(item.reset_day)),
        ("status", json!(before.raw_status), json!(item.raw_status)),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "user_package.update",
        &item.id,
        json!({
            "user_id": &item.user_id,
            "package_id": &item.package_id,
            "package_name": &item.package_name,
            "changes": changes,
        }),
    )
    .await;

    Ok(Json(json!({ "item": item })))
}

/// 批量续期允许的天数范围；与前端输入校验保持一致。
const BATCH_RENEW_MIN_DAYS: i64 = 1;
const BATCH_RENEW_MAX_DAYS: i64 = 365;

#[derive(Deserialize)]
pub struct BatchRenewUserPackages {
    pub days: i64,
}

/// 对所有**已过期**的套餐实例续期。
///
/// 到期时间从请求处理时刻（`now`）起顺延，而不是从原到期时间起算；重复/
/// 并发请求不会把同一实例顺延两次（见
/// [`repo::user_packages::batch_renew_expired`] 的并发说明）。
pub async fn batch_renew_user_packages(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<BatchRenewUserPackages>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    if !(BATCH_RENEW_MIN_DAYS..=BATCH_RENEW_MAX_DAYS).contains(&req.days) {
        return Err(AppError::coded(
            "package_instance.batch_renew_days_invalid",
            Some(json!({
                "min": BATCH_RENEW_MIN_DAYS,
                "max": BATCH_RENEW_MAX_DAYS,
            })),
            format!("续期天数必须在 {BATCH_RENEW_MIN_DAYS}-{BATCH_RENEW_MAX_DAYS} 天之间"),
        ));
    }

    let updated =
        repo::user_packages::batch_renew_expired(&state.db.pool, req.days, repo::now()).await?;

    // 过期实例恢复可用后，Agent 侧要重新注入这些用户；失败只记日志，
    // 5 分钟对账仍会兜底。
    if updated > 0 {
        if let Err(error) = crate::enforcement::mark_all_servers_dirty(&state).await {
            tracing::error!(updated, error = %error, "批量续期后标记期望态失败");
        }
    }

    crate::audit::record(
        &state,
        &user.0,
        "package_instance.batch_renew",
        "user_packages",
        json!({ "days": req.days, "updated": updated }),
    )
    .await;

    Ok(Json(json!({ "updated": updated })))
}

pub async fn delete_user_package(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let removed = repo::user_packages::find_view_by_id(&state.db.pool, &id).await?;
    if !repo::user_packages::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found(
            "user_package.not_found",
            None,
            "资源不存在",
        ));
    }
    if let Some(removed) = removed {
        crate::audit::record(
            &state,
            &user.0,
            "user_package.unbind",
            &id,
            json!({
                "user_id": &removed.user_id,
                "package_id": &removed.package_id,
                "package_name": &removed.package_name,
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
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use pierwave_domain::Db;

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

    #[tokio::test]
    async fn user_listing_and_package_binding_flow() {
        let (app, _state, admin) = setup().await;

        // 建用户：响应里不能出现 password_hash。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/users",
            Some(json!({"username": "alice", "password": "password123"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.to_string().contains("password_hash"));
        let alice_id = body["user"]["id"].as_str().unwrap().to_string();
        assert_eq!(body["user"]["username"], "alice");
        assert_eq!(body["user"]["role"], "user");
        assert_eq!(body["user"]["status"], "active");
        assert_eq!(body["user"]["packages"].as_array().unwrap().len(), 0);
        assert_eq!(body["user"]["package_count"], 0);

        // 列表可见，同样不回显密码哈希。
        let (status, body) =
            request(&app, Some(&admin), Method::GET, "/api/v1/users?q=ali", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.to_string().contains("password_hash"));
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["username"], "alice");

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/users?q=nobody",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["items"].as_array().unwrap().is_empty());

        // 重复用户名 → 400。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/users",
            Some(json!({"username": "alice", "password": "password123"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("已存在"));

        // 两张不同额度的套餐模板。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "月卡", "quota_bytes": 1000, "period_days": 30})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let monthly = body["package"]["id"].as_str().unwrap().to_string();
        assert_eq!(body["package"]["direction"], "both");
        assert_eq!(body["package"]["node_ratio"], 1.0);

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "年卡", "quota_bytes": 12000, "period_days": 365})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let yearly = body["package"]["id"].as_str().unwrap().to_string();

        // 绑两张卡：一张覆盖额度，一张继承套餐额度。
        let bind_uri = format!("/api/v1/users/{alice_id}/packages");
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            &bind_uri,
            Some(json!({
                "package_id": &monthly,
                "quota_override": 100,
                "expires_at": 2_000_000_000_i64,
                "reset_day": 5
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["item"]["package_name"], "月卡");
        assert_eq!(body["item"]["quota_bytes"], 100);
        assert_eq!(body["item"]["expires_at"], 2_000_000_000_i64);
        assert_eq!(body["item"]["reset_day"], 5);
        assert_eq!(body["item"]["status"], "active");

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            &bind_uri,
            Some(json!({"package_id": &yearly})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["item"]["package_name"], "年卡");
        assert_eq!(body["item"]["quota_bytes"], 12000);
        // expires_at 缺省时按套餐周期自动计算。
        assert!(body["item"]["expires_at"].as_i64().unwrap() > repo::now());
        let yearly_binding = body["item"]["id"].as_str().unwrap().to_string();

        // 列表一次装配出两张卡，额度互相独立。
        let (status, body) = request(&app, Some(&admin), Method::GET, "/api/v1/users", None).await;
        assert_eq!(status, StatusCode::OK);
        let alice = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|user| user["id"] == alice_id.as_str())
            .unwrap();
        let packages = alice["packages"].as_array().unwrap();
        assert_eq!(packages.len(), 2);
        assert_eq!(alice["package_count"], 2, "package_count 与 packages 一致");
        let quota_of = |package_id: &str| {
            packages
                .iter()
                .find(|item| item["package_id"] == package_id)
                .unwrap()["quota_bytes"]
                .as_i64()
                .unwrap()
        };
        assert_eq!(quota_of(&monthly), 100);
        assert_eq!(quota_of(&yearly), 12000);
        let monthly_binding = packages
            .iter()
            .find(|item| item["package_id"] == monthly.as_str())
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        // quota_override = 0 表示显式不限：生效额度原样返回 0，与「继承」的 null 区分。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/user-packages/{yearly_binding}"),
            Some(json!({"quota_override": 0})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["item"]["quota_bytes"], 0);

        // 删除仍被引用的套餐 → 400，并提示占用数量。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/packages/{monthly}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let error = body["error"].as_str().unwrap();
        assert!(error.contains("还有 1 个用户在用"), "unexpected: {error}");

        // 解绑后套餐可以删除。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/user-packages/{monthly_binding}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        let (status, _) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/packages/{monthly}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        // 删用户级联清掉名下实例，随后年卡也能删。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/users/{alice_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        let (status, _) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/packages/{yearly}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn admin_guards_and_chinese_validation() {
        let (app, state, admin) = setup().await;

        // 普通用户调用管理接口 → 403。
        let bob = repo::users::create(
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
        let (token, _) = repo::sessions::create(&state.db.pool, &bob.id, 3600, None)
            .await
            .unwrap();
        let bob_cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);

        let (status, body) =
            request(&app, Some(&bob_cookie), Method::GET, "/api/v1/users", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");

        let (status, body) = request(
            &app,
            Some(&bob_cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "偷偷建的套餐"})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");

        let (status, body) = request(&app, None, Method::GET, "/api/v1/packages", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "未登录");

        // 不能删除自己。
        let admin_id = repo::users::find_by_username(&state.db.pool, "admin")
            .await
            .unwrap()
            .unwrap()
            .id;
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/users/{admin_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("不能删除自己"));

        // 不能把自己从 admin 降成 user。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/users/{admin_id}"),
            Some(json!({"role": "user"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("降级"));

        // 也不能把自己禁用（等于把后台锁死）。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/users/{admin_id}"),
            Some(json!({"status": "disabled"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("禁用自己"));

        // 用户字段校验。
        for (bad, expected_code) in [
            (
                json!({"username": "ab", "password": "password123"}),
                "user.username_length_invalid",
            ),
            (
                json!({"username": "charlie", "password": "short"}),
                "user.password_too_short",
            ),
            (
                json!({"username": "charlie", "password": "password123", "role": "root"}),
                "common.enum_invalid",
            ),
            (
                json!({"username": "charlie", "password": "password123", "quota_bytes": -1}),
                "package.quota_negative",
            ),
        ] {
            let (status, body) = request(
                &app,
                Some(&admin),
                Method::POST,
                "/api/v1/users",
                Some(bad.clone()),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "payload: {bad}");
            assert_eq!(body["code"], expected_code, "payload: {bad}");
            assert!(!body["error"].as_str().unwrap().is_empty());
        }

        // 下限放进 params，前端词典不需要把 8 写死。
        let (_, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/users",
            Some(json!({"username": "shortpw", "password": "short"})),
        )
        .await;
        assert_eq!(body["code"], "user.password_too_short");
        assert_eq!(body["params"]["min"], 8);

        // 套餐字段校验。
        for bad in [
            json!({"name": "  "}),
            json!({"name": "x", "period_days": 0}),
            json!({"name": "x", "period_days": 3651}),
            json!({"name": "x", "direction": "sideways"}),
            json!({"name": "x", "node_ratio": 0}),
            json!({"name": "x", "node_ratio": 10.5}),
            json!({"name": "x", "quota_bytes": -5}),
        ] {
            let (status, body) = request(
                &app,
                Some(&admin),
                Method::POST,
                "/api/v1/packages",
                Some(bad.clone()),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "payload: {bad}");
            assert!(!body["error"].as_str().unwrap().is_empty());
        }

        // 绑卡时 reset_day / quota_override 校验。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "月卡", "quota_bytes": 1000})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let package_id = body["package"]["id"].as_str().unwrap().to_string();
        let bind_uri = format!("/api/v1/users/{}/packages", bob.id);

        for bad in [
            json!({"package_id": &package_id, "reset_day": 32}),
            json!({"package_id": &package_id, "reset_day": 0}),
            json!({"package_id": &package_id, "quota_override": -1}),
        ] {
            let (status, body) = request(
                &app,
                Some(&admin),
                Method::POST,
                &bind_uri,
                Some(bad.clone()),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "payload: {bad}");
            assert!(!body["error"].as_str().unwrap().is_empty());
        }

        // PATCH 用户：quota_bytes 显式 null 表示不限，且空 PATCH 被拒绝。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/users/{}", bob.id),
            Some(json!({"quota_bytes": null})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["user"]["quota_bytes"].is_null());

        let (status, _) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/users/{}", bob.id),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/users/{}", bob.id),
            Some(json!({"status": "frozen"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("状态"));
    }

    #[tokio::test]
    async fn clearing_quota_override_falls_back_to_package_quota() {
        let (app, _state, admin) = setup().await;

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "月卡", "quota_bytes": 1000})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["user_count"], 0, "新建套餐没有引用");
        let package_id = body["package"]["id"].as_str().unwrap().to_string();

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/users",
            Some(json!({"username": "alice", "password": "password123"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let user_id = body["user"]["id"].as_str().unwrap().to_string();

        let bind_uri = format!("/api/v1/users/{user_id}/packages");
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            &bind_uri,
            Some(json!({"package_id": &package_id, "quota_override": 100})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["item"]["quota_override"], 100);
        assert_eq!(body["item"]["quota_bytes"], 100);
        let binding_id = body["item"]["id"].as_str().unwrap().to_string();

        // 核心验收点：显式 null 把覆写清回继承，生效额度回落到套餐值。
        let item_uri = format!("/api/v1/user-packages/{binding_id}");
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &item_uri,
            Some(json!({"quota_override": null})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body["item"]["quota_override"].is_null(),
            "PATCH 后视图必须回显 null：{body}"
        );
        assert_eq!(body["item"]["quota_bytes"], 1000);

        // GET 再确认一次（不是只在 PATCH 响应里正确）。
        let (status, body) = request(&app, Some(&admin), Method::GET, &bind_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let item = &body["items"][0];
        assert!(item["quota_override"].is_null());
        assert_eq!(item["quota_bytes"], 1000);

        // 显式 0 与 null 语义不同：0 = 不限，且原样回显。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &item_uri,
            Some(json!({"quota_override": 0})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["item"]["quota_override"], 0);
        assert_eq!(body["item"]["quota_bytes"], 0);

        // 再清回继承一次，证明两个方向都可逆。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &item_uri,
            Some(json!({"quota_override": null})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["item"]["quota_override"].is_null());
        assert_eq!(body["item"]["quota_bytes"], 1000);
    }

    #[tokio::test]
    async fn package_instance_status_is_computed_by_view() {
        let (app, state, admin) = setup().await;

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
                name: "月卡".into(),
                quota_bytes: Some(1000),
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,

                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        let bind_uri = format!("/api/v1/users/{}/packages", alice.id);

        let bind = |body: Value| {
            let app = app.clone();
            let admin = admin.clone();
            let bind_uri = bind_uri.clone();
            async move {
                let (status, body) =
                    request(&app, Some(&admin), Method::POST, &bind_uri, Some(body)).await;
                assert_eq!(status, StatusCode::OK, "绑卡失败：{body}");
                body["item"]["id"].as_str().unwrap().to_string()
            }
        };

        let active_id = bind(json!({"package_id": &package.id})).await;
        let expired_id = bind(json!({
            "package_id": &package.id,
            "expires_at": repo::now() - 3600
        }))
        .await;
        let exhausted_id = bind(json!({"package_id": &package.id})).await;
        let disabled_id = bind(json!({
            "package_id": &package.id,
            "expires_at": repo::now() - 3600
        }))
        .await;
        let unlimited_id = bind(json!({"package_id": &package.id, "quota_override": 0})).await;

        // 已用满 1000/1000 → exhausted；显式不限（0）即使 used 很大也仍是 active。
        assert!(
            repo::user_packages::set_used_bytes(&state.db.pool, &exhausted_id, 1000)
                .await
                .unwrap()
        );
        assert!(
            repo::user_packages::set_used_bytes(&state.db.pool, &unlimited_id, 999_999)
                .await
                .unwrap()
        );

        // disabled 覆盖 expired：原始状态不是 active 时优先显示 disabled。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/user-packages/{disabled_id}"),
            Some(json!({"status": "disabled"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["item"]["status"], "disabled");

        let (status, body) = request(&app, Some(&admin), Method::GET, &bind_uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let status_of = |id: &str| {
            body["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == id)
                .unwrap()["status"]
                .as_str()
                .unwrap()
                .to_string()
        };

        assert_eq!(status_of(&active_id), "active");
        assert_eq!(status_of(&expired_id), "expired");
        assert_eq!(status_of(&exhausted_id), "exhausted");
        assert_eq!(status_of(&disabled_id), "disabled");
        assert_eq!(status_of(&unlimited_id), "active", "0 = 显式不限，不算用尽");
    }

    #[tokio::test]
    async fn package_user_count_tracks_references() {
        let (app, state, admin) = setup().await;

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "月卡", "quota_bytes": 1000})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let package_id = body["package"]["id"].as_str().unwrap().to_string();

        let mut bindings = Vec::new();
        for username in ["alice", "bob"] {
            let user = repo::users::create(
                &state.db.pool,
                repo::users::NewUser {
                    username: username.into(),
                    password: "password123".into(),
                    role: "user".into(),
                    quota_bytes: None,
                    rule_template_id: None,
                },
            )
            .await
            .unwrap();
            let (status, body) = request(
                &app,
                Some(&admin),
                Method::POST,
                &format!("/api/v1/users/{}/packages", user.id),
                Some(json!({"package_id": &package_id})),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            bindings.push(body["item"]["id"].as_str().unwrap().to_string());
        }

        let user_count = |body: &Value| {
            body["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == package_id.as_str())
                .unwrap()["user_count"]
                .as_i64()
                .unwrap()
        };

        let (status, body) =
            request(&app, Some(&admin), Method::GET, "/api/v1/packages", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(user_count(&body), 2, "绑 2 个用户 → user_count = 2");

        let (status, _) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/user-packages/{}", bindings[0]),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, body) =
            request(&app, Some(&admin), Method::GET, "/api/v1/packages", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(user_count(&body), 1, "解绑一个 → user_count = 1");
    }

    #[tokio::test]
    async fn unknown_rule_template_id_is_400_for_users_and_packages() {
        let (app, state, admin) = setup().await;
        let template = repo::rule_templates::create(
            &state.db.pool,
            repo::rule_templates::NewRuleTemplate {
                name: "绑定用模板".into(),
                description: String::new(),
                rules: vec!["MATCH,DIRECT".into()],
                is_default: false,
            },
        )
        .await
        .unwrap();

        // 用户新建：不存在的模板 → 400 中文。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/users",
            Some(json!({
                "username": "bad-template",
                "password": "password123",
                "rule_template_id": "does-not-exist",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"].as_str().unwrap().contains("规则模板不存在"),
            "unexpected: {body}"
        );

        // 用户新建：存在的模板 → 视图回显 id。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/users",
            Some(json!({
                "username": "bound-user",
                "password": "password123",
                "rule_template_id": &template.id,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["user"]["rule_template_id"], template.id.as_str());
        let user_id = body["user"]["id"].as_str().unwrap().to_string();

        // 用户更新：非法 → 400；合法 → 生效；null → 解绑。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/users/{user_id}"),
            Some(json!({"rule_template_id": "does-not-exist"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("规则模板不存在"));

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/users/{user_id}"),
            Some(json!({"rule_template_id": &template.id})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["user"]["rule_template_id"], template.id.as_str());

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/users/{user_id}"),
            Some(json!({"rule_template_id": null})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["user"]["rule_template_id"].is_null());

        // 套餐新建 / 更新走同一套校验。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "坏模板套餐", "rule_template_id": "does-not-exist"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("规则模板不存在"));

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "绑定模板套餐", "rule_template_id": &template.id})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["rule_template_id"], template.id.as_str());
        let package_id = body["package"]["id"].as_str().unwrap().to_string();

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"rule_template_id": "does-not-exist"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("规则模板不存在"));

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"rule_template_id": null})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["package"]["rule_template_id"].is_null());
    }

    async fn seed_package(state: &AppState, name: &str) -> String {
        repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: name.into(),
                quota_bytes: Some(1000),
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                speed_limit_kbps: None,
                rule_template_id: None,
                node_ids: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    async fn seed_user(state: &AppState, username: &str) -> String {
        repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: username.into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    async fn bind_instance(
        state: &AppState,
        user_id: &str,
        package_id: &str,
        expires_at: Option<i64>,
    ) -> String {
        let package = repo::packages::find_by_id(&state.db.pool, package_id)
            .await
            .unwrap()
            .unwrap();
        repo::user_packages::create(
            &state.db.pool,
            user_id,
            repo::user_packages::NewUserPackage {
                package_id: package_id.to_string(),
                quota_override: None,
                expires_at,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn batch_renew_only_extends_expired_active_from_now_and_records_audit() {
        let (app, state, admin) = setup().await;
        let package_id = seed_package(&state, "月卡").await;
        let user_id = seed_user(&state, "alice").await;

        let now = repo::now();
        let expired_a = bind_instance(&state, &user_id, &package_id, Some(now - 3600)).await;
        let expired_b = bind_instance(&state, &user_id, &package_id, Some(now - 10 * 86_400)).await;
        let future_expiry = now + 86_400;
        let future = bind_instance(&state, &user_id, &package_id, Some(future_expiry)).await;
        let exhausted = bind_instance(&state, &user_id, &package_id, Some(future_expiry)).await;
        repo::user_packages::set_used_bytes(&state.db.pool, &exhausted, 1000)
            .await
            .unwrap();
        let permanent = bind_instance(&state, &user_id, &package_id, None).await;
        let disabled = bind_instance(&state, &user_id, &package_id, Some(now - 3600)).await;
        repo::user_packages::update(
            &state.db.pool,
            &disabled,
            repo::user_packages::UpdateUserPackage {
                status: Some("disabled".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let before = repo::now();
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/user-packages/batch-renew",
            Some(json!({ "days": 30 })),
        )
        .await;
        let after = repo::now();
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["updated"], 2, "只续期两张 active 且已过期的实例");

        let views = repo::user_packages::list_views_by_user(&state.db.pool, &user_id)
            .await
            .unwrap();
        let view = |id: &str| views.iter().find(|item| item.id == id).unwrap();

        // 基准必须是「现在」：若从原到期时间起算，过期卡仍会落在 now 之前。
        let lower = before + 30 * 86_400;
        let upper = after + 30 * 86_400;
        for id in [&expired_a, &expired_b] {
            let item = view(id);
            let expires_at = item.expires_at.expect("续期后应有到期时间");
            assert!(
                expires_at >= lower && expires_at <= upper,
                "续期基准不是当前时间：expires_at={expires_at}, lower={lower}, upper={upper}"
            );
            assert_eq!(item.status, "active");
        }

        assert_eq!(
            view(&future).expires_at,
            Some(future_expiry),
            "未过期实例不应被改动"
        );
        assert_eq!(
            view(&exhausted).expires_at,
            Some(future_expiry),
            "只用尽但未过期的实例不应被续期"
        );
        assert_eq!(view(&permanent).expires_at, None, "永久实例不应被改动");
        assert_eq!(view(&disabled).status, "disabled");

        // 审计落库，detail 只有天数和数量，不含用户隐私数据。
        let entries = repo::audit::list(&state.db.pool, 20).await.unwrap();
        let entry = entries
            .iter()
            .find(|entry| {
                entry.action == "package_instance.batch_renew"
                    && entry
                        .detail
                        .as_ref()
                        .and_then(|detail| detail["updated"].as_u64())
                        == Some(2)
            })
            .expect("缺少批量续期审计");
        let detail = entry.detail.as_ref().unwrap();
        assert_eq!(detail["days"], 30);
        assert_eq!(detail["updated"], 2);
        let serialized = detail.to_string();
        assert!(!serialized.contains("alice"));
        assert!(!serialized.contains(&user_id));
        assert!(entry.target.as_deref() == Some("user_packages"));

        // 再次点击：所有实例都已不满足「已过期」，返回 0 且不再叠加天数。
        let renewed = view(&expired_a).expires_at;
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/user-packages/batch-renew",
            Some(json!({ "days": 7 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["updated"], 0);
        let views = repo::user_packages::list_views_by_user(&state.db.pool, &user_id)
            .await
            .unwrap();
        let again = views.iter().find(|item| item.id == expired_a).unwrap();
        assert_eq!(again.expires_at, renewed, "重复调用不得叠加续期天数");
    }

    #[tokio::test]
    async fn concurrent_batch_renew_extends_each_instance_only_once() {
        let (app, state, admin) = setup().await;
        let package_id = seed_package(&state, "月卡").await;
        let user_id = seed_user(&state, "alice").await;
        let expired = bind_instance(&state, &user_id, &package_id, Some(repo::now() - 3600)).await;

        let body = json!({ "days": 30 });
        let before = repo::now();
        let (first, second) = tokio::join!(
            request(
                &app,
                Some(&admin),
                Method::POST,
                "/api/v1/user-packages/batch-renew",
                Some(body.clone()),
            ),
            request(
                &app,
                Some(&admin),
                Method::POST,
                "/api/v1/user-packages/batch-renew",
                Some(body),
            )
        );
        let after = repo::now();

        assert_eq!(first.0, StatusCode::OK, "第一次请求失败：{}", first.1);
        assert_eq!(second.0, StatusCode::OK, "第二次请求失败：{}", second.1);
        let total = first.1["updated"].as_u64().unwrap() + second.1["updated"].as_u64().unwrap();
        assert_eq!(total, 1, "两个并发请求只能有一个命中同一实例");

        let views = repo::user_packages::list_views_by_user(&state.db.pool, &user_id)
            .await
            .unwrap();
        let expires_at = views
            .iter()
            .find(|item| item.id == expired)
            .unwrap()
            .expires_at
            .unwrap();
        assert!(
            expires_at >= before + 30 * 86_400 && expires_at <= after + 30 * 86_400,
            "并发请求把天数叠加了：expires_at={expires_at}"
        );
    }

    #[tokio::test]
    async fn batch_renew_rejects_invalid_days_and_non_admin() {
        let (app, state, admin) = setup().await;
        for days in [0, 366, -1] {
            let (status, body) = request(
                &app,
                Some(&admin),
                Method::POST,
                "/api/v1/user-packages/batch-renew",
                Some(json!({ "days": days })),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(body["code"], "package_instance.batch_renew_days_invalid");
        }

        let normal = seed_user(&state, "bob").await;
        let (token, _) = repo::sessions::create(&state.db.pool, &normal, 3600, None)
            .await
            .unwrap();
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/user-packages/batch-renew",
            Some(json!({ "days": 30 })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");
    }
    /// 删除用户必须同事务清掉 owner_user_id 名下的转发/链与运行状态，
    /// 并把相关服务器标脏下发；旧行为只删 users 行，留下孤儿规则继续监听。
    #[tokio::test]
    async fn deleting_a_user_removes_owned_forwards_and_chains() {
        let (app, state, admin) = setup().await;
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
        let (server, _token) = repo::servers::create(&state.db.pool, "hk", "1.2.3.4", "external")
            .await
            .unwrap();

        let forward = repo::forwards::create_owned(
            &state.db.pool,
            &server.id,
            repo::forwards::NewForward {
                name: "alice-web".into(),
                listen_port: 20000,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: true,
                count_traffic: true,
                engine: "native".into(),
                protocol: "tcp".into(),
            },
            &alice.id,
            10,
        )
        .await
        .unwrap();
        repo::forwards::save_status(
            &state.db.pool,
            &server.id,
            &[repo::forwards::NewForwardStatus {
                forward_id: pierwave_domain::forwards::desired_id(&forward.id),
                listening: true,
                error: String::new(),
                target_ok: Some(true),
                target_error: None,
                targets: Vec::new(),
                traffic_in: Some(10),
                traffic_out: Some(20),
            }],
        )
        .await
        .unwrap();

        let chain = repo::chains::create_owned(
            &state.db.pool,
            repo::chains::NewChain {
                name: "alice-chain".into(),
                target_host: "1.1.1.1".into(),
                target_port: 443,
                enabled: true,
                engine: "native".into(),
                protocol: "tcp".into(),
                transport: "none".into(),
                tunnel_security: "tls".into(),
                groups: vec![repo::chains::NewChainGroup {
                    name: None,
                    strategy: "round_robin".into(),
                    cert_id: None,
                    public_port: None,
                    use_internal_address: false,
                    members: vec![repo::chains::NewChainGroupMember {
                        server_id: server.id.clone(),
                        listen_port: 20001,
                        priority: 0,
                        weight: 1,
                    }],
                }],
            },
            "tpl-1",
            &alice.id,
            10,
        )
        .await
        .unwrap();

        // 链的 forward_status 用推导 id 投毒，删除后必须一并清掉。
        sqlx::query(
            "INSERT INTO forward_status (server_id, forward_id, listening, error, updated_at)
             VALUES (?, ?, 1, '', 1)",
        )
        .bind(&server.id)
        .bind(format!("chain-{}-0", chain.chain.id))
        .execute(&state.db.pool)
        .await
        .unwrap();

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/users/{}", alice.id),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");

        assert!(
            repo::users::find_by_id(&state.db.pool, &alice.id)
                .await
                .is_err(),
            "用户必须已删除"
        );
        assert_eq!(
            repo::forwards::count_by_owner(&state.db.pool, &alice.id)
                .await
                .unwrap(),
            0,
            "用户删除后不能留下孤儿转发"
        );
        assert_eq!(
            repo::chains::count_by_owner(&state.db.pool, &alice.id)
                .await
                .unwrap(),
            0,
            "用户删除后不能留下孤儿链"
        );
        let status_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM forward_status WHERE server_id = ?")
                .bind(&server.id)
                .fetch_one(&state.db.pool)
                .await
                .unwrap();
        assert_eq!(status_rows, 0, "forward_status 也要同事务清理");
    }
}
