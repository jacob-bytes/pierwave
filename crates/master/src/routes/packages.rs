use std::collections::HashSet;

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

/// 去空白、去重；`None` 与 `Some([])` 语义不同，不能合并。
fn normalize_node_ids(raw: Option<Vec<String>>) -> AppResult<Option<Vec<String>>> {
    let Some(ids) = raw else {
        return Ok(None);
    };
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let id = id.trim();
        if id.is_empty() {
            return Err(AppError::BadRequest("节点 id 不能为空".into()));
        }
        if seen.insert(id.to_string()) {
            out.push(id.to_string());
        }
    }
    Ok(Some(out))
}

/// 显式指定范围时，所有节点必须真实存在；否则 400 而不是等外键报 500。
async fn validate_node_ids(state: &AppState, node_ids: Option<&[String]>) -> AppResult<()> {
    let Some(node_ids) = node_ids else {
        return Ok(());
    };
    let missing = repo::nodes::missing_ids(&state.db.pool, node_ids).await?;
    if !missing.is_empty() {
        return Err(AppError::BadRequest(format!(
            "节点不存在：{}",
            missing.join("、")
        )));
    }
    Ok(())
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
    /// 缺省 / `null` = 不限制（全部节点）；`[]` = 一个都不给；数组 = 只给这些节点。
    #[serde(default)]
    pub node_ids: Option<Vec<String>>,
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

    let node_ids = normalize_node_ids(req.node_ids)?;
    validate_node_ids(&state, node_ids.as_deref()).await?;

    let package = repo::packages::create(
        &state.db.pool,
        repo::packages::NewPackage {
            name: name.to_string(),
            quota_bytes: req.quota_bytes,
            period_days: req.period_days,
            direction,
            node_ratio: req.node_ratio,
            node_ids,
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
    /// `null` / 缺省 = 不改动范围；`[]` = 清空为「一个都不给」；数组 = 只给这些节点。
    #[serde(default)]
    pub node_ids: Option<Vec<String>>,
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
        && req.node_ids.is_none()
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

    let node_ids = normalize_node_ids(req.node_ids)?;
    validate_node_ids(&state, node_ids.as_deref()).await?;

    let package = repo::packages::update(
        &state.db.pool,
        &id,
        repo::packages::UpdatePackage {
            name,
            quota_bytes: req.quota_bytes,
            period_days: req.period_days,
            direction,
            node_ratio: req.node_ratio,
            node_ids,
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

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::json;
    use tower::ServiceExt;

    use mmrust_domain::models::Node;
    use mmrust_domain::repo::nodes::NewNode;
    use mmrust_domain::repo::user_packages::{self, NewUserPackage};
    use mmrust_domain::repo::users::{self, NewUser};
    use mmrust_domain::Db;

    fn trojan_node(tag: &str, name: &str, port: i64) -> NewNode {
        NewNode {
            tag: Some(tag.into()),
            name: name.into(),
            protocol: "trojan".into(),
            transport: "tcp".into(),
            security: "none".into(),
            port,
            config_json: json!({
                "settings": {"clients": []},
                "stream": {"network": "tcp", "security": "none"}
            })
            .to_string(),
            enabled: true,
            cert_id: None,
        }
    }

    async fn setup() -> (Router, AppState, String, String, Vec<Node>) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = users::create(
            &db.pool,
            NewUser {
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
        let (server, _) = repo::servers::create(&db.pool, "hk-1", "203.0.113.10", "external")
            .await
            .unwrap();
        let mut nodes = Vec::new();
        for (tag, name, port) in [("a", "节点-A", 443), ("b", "节点-B", 8443)] {
            nodes.push(
                repo::nodes::create(&db.pool, &server.id, trojan_node(tag, name, port))
                    .await
                    .unwrap(),
            );
        }
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
            server.id,
            nodes,
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

    async fn create_package(app: &Router, cookie: &str, body: Value) -> String {
        let (status, package) = request(
            app,
            Some(cookie),
            Method::POST,
            "/api/v1/packages",
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "建套餐失败：{package}");
        package["package"]["id"].as_str().unwrap().to_string()
    }

    async fn bind_user(state: &AppState, package_id: &str) -> String {
        let user = users::create(
            &state.db.pool,
            NewUser {
                username: "alice".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
            },
        )
        .await
        .unwrap();
        let package = repo::packages::find_by_id(&state.db.pool, package_id)
            .await
            .unwrap()
            .unwrap();
        user_packages::create(
            &state.db.pool,
            &user.id,
            NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap();
        user.id
    }

    fn package_item<'a>(body: &'a Value, id: &str) -> &'a Value {
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .unwrap()
    }

    #[tokio::test]
    async fn package_scope_semantics_are_exposed_by_api() {
        let (app, _state, cookie, _server_id, nodes) = setup().await;
        let a = nodes[0].id.clone();

        // 不传 node_ids → 可见全部节点（历史套餐的默认行为）。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "全部", "quota_bytes": 10_000})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([]));
        assert_eq!(body["package"]["node_count"], 2);

        // 显式指定 A → 只可见 A。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "指定", "node_ids": [a.clone()]})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([a.clone()]));
        assert_eq!(body["package"]["node_count"], 1);

        // 显式空数组 → 一个都不给，与「不传」区分开。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "空", "node_ids": []})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([]));
        assert_eq!(body["package"]["node_count"], 0);

        // 列表把三种语义一起带出。
        let (status, body) =
            request(&app, Some(&cookie), Method::GET, "/api/v1/packages", None).await;
        assert_eq!(status, StatusCode::OK);
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        let by_name = |name: &str| items.iter().find(|item| item["name"] == name).unwrap();
        assert_eq!(by_name("全部")["node_ids"], json!([]));
        assert_eq!(by_name("全部")["node_count"], 2);
        assert_eq!(by_name("指定")["node_ids"], json!([a]));
        assert_eq!(by_name("指定")["node_count"], 1);
        assert_eq!(by_name("空")["node_ids"], json!([]));
        assert_eq!(by_name("空")["node_count"], 0);

        // 不存在的节点 id → 400 中文错误，不能落库。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "坏", "node_ids": ["does-not-exist"]})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let error = body["error"].as_str().unwrap();
        assert!(error.contains("节点不存在"), "unexpected: {error}");
        assert!(error.contains("does-not-exist"), "unexpected: {error}");
    }

    #[tokio::test]
    async fn patch_scope_changes_eligible_pairs() {
        let (app, state, cookie, server_id, nodes) = setup().await;
        let a = nodes[0].id.clone();
        let b = nodes[1].id.clone();

        let package_id = create_package(
            &app,
            &cookie,
            json!({"name": "指定", "node_ids": [a.clone()]}),
        )
        .await;
        let user_id = bind_user(&state, &package_id).await;

        let pairs = repo::authorization::eligible_pairs(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(pairs.len(), 1, "只绑 A 时只有一条授权");
        assert_eq!(pairs[0].user_id, user_id);
        assert_eq!(pairs[0].node_id, a);

        // PATCH 成 B：资格集合立即跟着变。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": [b.clone()]})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([b.clone()]));
        assert_eq!(body["package"]["node_count"], 1);
        let pairs = repo::authorization::eligible_pairs(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].node_id, b);

        // PATCH []：清空范围 = 谁都看不到。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": []})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([]));
        assert_eq!(body["package"]["node_count"], 0);
        assert!(
            repo::authorization::eligible_pairs(&state.db.pool, &server_id)
                .await
                .unwrap()
                .is_empty(),
            "空范围不应产生任何授权"
        );

        // node_ids: null 与不传都表示「不动」：范围保持为空。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"name": "改名", "node_ids": null})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([]));
        assert_eq!(body["package"]["node_count"], 0);
        assert!(
            repo::authorization::eligible_pairs(&state.db.pool, &server_id)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn deleting_nodes_cascades_scope_without_widening() {
        let (app, state, cookie, server_id, nodes) = setup().await;
        let a = nodes[0].id.clone();
        let b = nodes[1].id.clone();
        let package_id = create_package(
            &app,
            &cookie,
            json!({"name": "两只", "node_ids": [a.clone(), b.clone()]}),
        )
        .await;
        let user_id = bind_user(&state, &package_id).await;

        // 删 A：package_nodes 级联清理，只剩 B。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/nodes/{a}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, body) = request(&app, Some(&cookie), Method::GET, "/api/v1/packages", None).await;
        let item = package_item(&body, &package_id);
        assert_eq!(item["node_ids"], json!([b.clone()]));
        assert_eq!(item["node_count"], 1);

        // 再删 B：显式范围仍然是「一个都不给」，不能因为没行就回落成全部。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/nodes/{b}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, body) = request(&app, Some(&cookie), Method::GET, "/api/v1/packages", None).await;
        let item = package_item(&body, &package_id);
        assert_eq!(item["node_ids"], json!([]));
        assert_eq!(item["node_count"], 0);

        // 新增节点 C 也不会被「没有行」的套餐自动放进来。
        repo::nodes::create(&state.db.pool, &server_id, trojan_node("c", "节点-C", 9443))
            .await
            .unwrap();
        let (_, body) = request(&app, Some(&cookie), Method::GET, "/api/v1/packages", None).await;
        let item = package_item(&body, &package_id);
        assert_eq!(item["node_ids"], json!([]));
        assert_eq!(item["node_count"], 0);
        assert!(
            repo::authorization::eligible_pairs(&state.db.pool, &server_id)
                .await
                .unwrap()
                .iter()
                .all(|pair| pair.user_id != user_id),
            "空范围不能因为新增节点而重新授权"
        );
    }

    #[tokio::test]
    async fn empty_scope_removes_client_from_desired_config() {
        let (app, state, cookie, server_id, nodes) = setup().await;
        let a = nodes[0].id.clone();

        let package_id = create_package(&app, &cookie, json!({"name": "空", "node_ids": []})).await;
        let user_id = bind_user(&state, &package_id).await;
        let server = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();

        let desired = crate::routes::desired::render(&state, &server)
            .await
            .unwrap();
        assert!(
            desired.granted_user_ids.is_empty(),
            "空范围用户不应出现在下发授权里"
        );
        let inbounds = desired.xray["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 3, "两个节点 + api");
        for inbound in &inbounds[..2] {
            assert_eq!(
                inbound["settings"]["clients"],
                json!([]),
                "空范围不应给任何节点注入 client"
            );
        }

        // 改成只给 A 后，只有 A 的 inbound 出现该用户的 client。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": [a.clone()]})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let desired = crate::routes::desired::render(&state, &server)
            .await
            .unwrap();
        assert_eq!(desired.granted_user_ids, vec![user_id]);
        let inbounds = desired.xray["inbounds"].as_array().unwrap();
        assert_eq!(
            inbounds[0]["settings"]["clients"].as_array().unwrap().len(),
            1,
            "节点 A 应有 1 个 client"
        );
        assert_eq!(
            inbounds[1]["settings"]["clients"].as_array().unwrap().len(),
            0,
            "节点 B 不应有 client"
        );
    }
}
