use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use mmrust_domain::models::{Patch, User};
use mmrust_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::packages::{validate_quota_bytes, validate_reset_day};

const ROLES: &[&str] = &["admin", "user"];
const STATUSES: &[&str] = &["active", "disabled"];

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

fn validate_username(username: &str) -> AppResult<String> {
    let username = username.trim();
    let len = username.chars().count();
    if !(3..=32).contains(&len) {
        return Err(AppError::BadRequest(
            "用户名长度必须在 3-32 个字符之间".into(),
        ));
    }
    Ok(username.to_string())
}

fn validate_password(password: &str) -> AppResult<()> {
    if password.chars().count() < 8 {
        return Err(AppError::BadRequest("密码至少 8 位".into()));
    }
    Ok(())
}

async fn load_user(state: &AppState, id: &str) -> AppResult<User> {
    repo::users::find_by_id_opt(&state.db.pool, id)
        .await?
        .ok_or(AppError::NotFound)
}

async fn user_view(state: &AppState, id: &str) -> AppResult<Value> {
    let view = repo::users::view_by_id(&state.db.pool, id)
        .await?
        .ok_or(AppError::NotFound)?;
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
        Some(raw) => raw
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("limit 必须是整数".into()))?,
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
    let role = match req.role.as_deref() {
        Some(role) => normalize_enum("角色", role, ROLES)?,
        None => "user".to_string(),
    };

    if repo::users::find_by_username(&state.db.pool, &username)
        .await?
        .is_some()
    {
        return Err(AppError::BadRequest("用户名已存在".into()));
    }

    let created = repo::users::create(
        &state.db.pool,
        repo::users::NewUser {
            username,
            password: req.password,
            role,
            quota_bytes: req.quota_bytes,
        },
    )
    .await?;

    Ok(Json(user_view(&state, &created.id).await?))
}

#[derive(Deserialize)]
pub struct UpdateUser {
    pub role: Option<String>,
    pub status: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub quota_bytes: Patch<i64>,
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
    {
        return Err(AppError::BadRequest("至少需要提供一个可更新字段".into()));
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

    // 防止管理员把自己锁在门外。
    if id == user.0.id && role.as_deref() == Some("user") {
        return Err(AppError::BadRequest("不能把自己降级为普通用户".into()));
    }
    if id == user.0.id && status.as_deref() == Some("disabled") {
        return Err(AppError::BadRequest(
            "不能禁用自己的账号（否则将无法登录后台）".into(),
        ));
    }

    repo::users::update(
        &state.db.pool,
        &id,
        repo::users::UpdateUser {
            role,
            status,
            quota_bytes: req.quota_bytes,
        },
    )
    .await?
    .ok_or(AppError::NotFound)?;

    if let Some(password) = &req.password {
        if !repo::users::set_password(&state.db.pool, &id, password).await? {
            return Err(AppError::NotFound);
        }
    }

    Ok(Json(user_view(&state, &id).await?))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    if id == user.0.id {
        return Err(AppError::BadRequest("不能删除自己".into()));
    }
    if !repo::users::delete(&state.db.pool, &id).await? {
        return Err(AppError::NotFound);
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
        .ok_or(AppError::NotFound)?;

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
            .map(|days| mmrust_domain::time::end_of_business_day_after(repo::now(), days)),
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
        return Err(AppError::BadRequest("至少需要提供一个可更新字段".into()));
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
    .ok_or(AppError::NotFound)?;

    Ok(Json(json!({ "item": item })))
}

pub async fn delete_user_package(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    if !repo::user_packages::delete(&state.db.pool, &id).await? {
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
    use serde_json::Value;
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
        for bad in [
            json!({"username": "ab", "password": "password123"}),
            json!({"username": "charlie", "password": "short"}),
            json!({"username": "charlie", "password": "password123", "role": "root"}),
            json!({"username": "charlie", "password": "password123", "quota_bytes": -1}),
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
            assert!(!body["error"].as_str().unwrap().is_empty());
        }

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
}
