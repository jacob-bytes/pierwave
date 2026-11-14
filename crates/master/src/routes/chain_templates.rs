//! 链模板：管理员 CRUD + 用户可见模板列表。
//!
//! 模板只定义「链的形态」，不参与任何下发；用户建链时（`/api/v1/me/chains`）
//! 才把模板展开成真实的 groups 并分配端口。因此模板的写操作**不需要**触发
//! apply、也不会改动任何已有链。
//!
//! 校验口径与管理员手工建链一致：`engine / security / transport / protocol`
//! 复用 `pierwave_domain` 的同一组校验函数，组数 / 成员数 / 策略 / 重复服务器
//! 复用 `chains` 的规则；模板只额外拒绝 `transport = tls`（模板不携带证书）。

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::chain_templates::{self, TemplateConfig};
use pierwave_domain::models::{ChainTemplate, ChainTemplateGroup};
use pierwave_domain::repo;
use pierwave_domain::{engine, hop_transport, protocol, tunnel_security};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

fn default_enabled() -> bool {
    true
}

/// 模板组的请求形态。`seq` 缺省按数组顺序编号（`normalize_groups` 会重排并
/// 重新编号），`strategy` 缺省是 `round_robin`。
#[derive(Deserialize)]
pub struct ChainTemplateGroupInput {
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub strategy: Option<String>,
    #[serde(default)]
    pub server_ids: Vec<String>,
}

fn to_domain_groups(inputs: Vec<ChainTemplateGroupInput>) -> Vec<ChainTemplateGroup> {
    inputs
        .into_iter()
        .map(|input| ChainTemplateGroup {
            seq: input.seq,
            strategy: input.strategy.unwrap_or_default(),
            server_ids: input.server_ids,
        })
        .collect()
}

/// 所有引用到的服务器必须真实存在；模板是管理员配置，返回 400 而不是让
/// 用户建链时才发现某台机器已经删了。
async fn validate_server_ids(state: &AppState, groups: &[ChainTemplateGroup]) -> AppResult<()> {
    let server_ids: Vec<String> = groups
        .iter()
        .flat_map(|group| group.server_ids.iter().cloned())
        .collect();
    let missing = repo::servers::missing_ids(&state.db.pool, &server_ids).await?;
    if !missing.is_empty() {
        return Err(AppError::coded(
            "chain_template.server_not_found",
            Some(json!({ "server_ids": missing })),
            format!("服务器不存在：{}", missing.join("、")),
        ));
    }
    Ok(())
}

fn groups_json(groups: &[ChainTemplateGroup]) -> AppResult<String> {
    serde_json::to_string(groups).map_err(|error| AppError::Internal(error.into()))
}

/// `server_id -> name` 快照：模板列表一次读全部服务器，避免逐模板查库。
async fn server_names(state: &AppState) -> AppResult<HashMap<String, String>> {
    Ok(repo::servers::list(&state.db.pool)
        .await?
        .into_iter()
        .map(|server| (server.id, server.name))
        .collect())
}

/// 模板的对外形态：组里同时给 `server_ids` 与带名字的 `servers`，
/// 前端不必再查一遍服务器列表；被删除的服务器显示原 id（不会静默消失）。
pub fn template_json(template: &ChainTemplate, names: &HashMap<String, String>) -> Value {
    let groups = chain_templates::parse_groups(&template.groups_json).unwrap_or_default();
    json!({
        "id": &template.id,
        "name": &template.name,
        "engine": &template.engine,
        "security": &template.security,
        "transport": &template.transport,
        "protocol": &template.protocol,
        "enabled": template.enabled,
        "created_at": template.created_at,
        "groups": groups.iter().map(|group| json!({
            "seq": group.seq,
            "strategy": &group.strategy,
            "server_ids": &group.server_ids,
            "servers": group.server_ids.iter().map(|server_id| json!({
                "id": server_id,
                "name": names.get(server_id).cloned().unwrap_or_else(|| server_id.clone()),
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn load_error() -> AppError {
    AppError::not_found("chain_template.not_found", None, "链模板不存在")
}

// ---------------------------------------------------------------------------
// 管理员：`/api/v1/chain-templates`
// ---------------------------------------------------------------------------

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let templates = repo::chain_templates::list(&state.db.pool).await?;
    let names = server_names(&state).await?;
    let items: Vec<Value> = templates
        .iter()
        .map(|template| template_json(template, &names))
        .collect();
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateChainTemplate {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub security: Option<String>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub groups: Vec<ChainTemplateGroupInput>,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<CreateChainTemplate>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let name = chain_templates::normalize_name(&req.name)?;
    let groups = chain_templates::normalize_groups(to_domain_groups(req.groups))?;
    let config = chain_templates::validate_config(
        req.engine.as_deref().unwrap_or(engine::DEFAULT),
        req.security.as_deref().unwrap_or(tunnel_security::DEFAULT),
        req.transport.as_deref().unwrap_or(hop_transport::DEFAULT),
        req.protocol.as_deref().unwrap_or(protocol::DEFAULT),
        &groups,
    )?;
    validate_server_ids(&state, &groups).await?;

    let template = repo::chain_templates::create(
        &state.db.pool,
        repo::chain_templates::NewChainTemplate {
            name,
            engine: config.engine.clone(),
            security: config.security.clone(),
            transport: config.transport.clone(),
            protocol: config.protocol.clone(),
            groups_json: groups_json(&groups)?,
            enabled: req.enabled,
        },
    )
    .await?;

    crate::audit::record(
        &state,
        &user.0,
        "chain_template.create",
        &template.id,
        json!({
            "name": &template.name,
            "engine": &template.engine,
            "security": &template.security,
            "transport": &template.transport,
            "protocol": &template.protocol,
            "enabled": template.enabled,
            "groups": groups.iter().map(|group| json!({
                "seq": group.seq,
                "strategy": &group.strategy,
                "server_ids": &group.server_ids,
            })).collect::<Vec<_>>(),
        }),
    )
    .await;

    let names = server_names(&state).await?;
    Ok(Json(
        json!({ "template": template_json(&template, &names) }),
    ))
}

#[derive(Deserialize)]
pub struct PatchChainTemplate {
    pub name: Option<String>,
    pub engine: Option<String>,
    pub security: Option<String>,
    pub transport: Option<String>,
    pub protocol: Option<String>,
    pub enabled: Option<bool>,
    /// `None` = 不改组；`Some` = 整体替换。
    pub groups: Option<Vec<ChainTemplateGroupInput>>,
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchChainTemplate>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    if req.name.is_none()
        && req.engine.is_none()
        && req.security.is_none()
        && req.transport.is_none()
        && req.protocol.is_none()
        && req.enabled.is_none()
        && req.groups.is_none()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供 name / engine / security / transport / protocol / enabled / groups 之一",
        ));
    }

    let existing = repo::chain_templates::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(load_error)?;

    let name = match req.name.as_deref() {
        Some(raw) => Some(chain_templates::normalize_name(raw)?),
        None => None,
    };
    // 组替换时才校验服务器存在：避免「某台服务器被删 → 模板连停用都改不了」。
    let groups = match req.groups {
        Some(inputs) => {
            let groups = chain_templates::normalize_groups(to_domain_groups(inputs))?;
            validate_server_ids(&state, &groups).await?;
            Some(groups)
        }
        None => None,
    };
    let effective_groups = match &groups {
        Some(groups) => groups.clone(),
        None => chain_templates::parse_groups(&existing.groups_json)?,
    };

    let final_engine = req.engine.as_deref().unwrap_or(&existing.engine);
    let final_security = req.security.as_deref().unwrap_or(&existing.security);
    let final_transport = req.transport.as_deref().unwrap_or(&existing.transport);
    let final_protocol = req.protocol.as_deref().unwrap_or(&existing.protocol);
    let TemplateConfig {
        engine,
        security,
        transport,
        protocol,
    } = chain_templates::validate_config(
        final_engine,
        final_security,
        final_transport,
        final_protocol,
        &effective_groups,
    )?;

    let updated = repo::chain_templates::update(
        &state.db.pool,
        &id,
        repo::chain_templates::UpdateChainTemplate {
            name,
            engine: Some(engine),
            security: Some(security),
            transport: Some(transport),
            protocol: Some(protocol),
            groups_json: groups.as_deref().map(groups_json).transpose()?,
            enabled: req.enabled,
        },
    )
    .await?
    .ok_or_else(load_error)?;

    crate::audit::record(
        &state,
        &user.0,
        "chain_template.update",
        &updated.id,
        json!({
            "name": &updated.name,
            "changes": crate::audit::diff(vec![
                ("name", json!(&existing.name), json!(&updated.name)),
                ("engine", json!(&existing.engine), json!(&updated.engine)),
                ("security", json!(&existing.security), json!(&updated.security)),
                ("transport", json!(&existing.transport), json!(&updated.transport)),
                ("protocol", json!(&existing.protocol), json!(&updated.protocol)),
                ("enabled", json!(existing.enabled), json!(updated.enabled)),
                (
                    "groups",
                    json!(chain_templates::parse_groups(&existing.groups_json).unwrap_or_default()),
                    json!(chain_templates::parse_groups(&updated.groups_json).unwrap_or_default()),
                ),
            ]),
        }),
    )
    .await;

    let names = server_names(&state).await?;
    Ok(Json(json!({ "template": template_json(&updated, &names) })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let existing = repo::chain_templates::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(load_error)?;
    if !repo::chain_templates::delete(&state.db.pool, &id).await? {
        return Err(load_error());
    }

    crate::audit::record(
        &state,
        &user.0,
        "chain_template.delete",
        &id,
        json!({
            "name": &existing.name,
            "engine": &existing.engine,
            "security": &existing.security,
            "transport": &existing.transport,
            "protocol": &existing.protocol,
            "groups": chain_templates::parse_groups(&existing.groups_json).unwrap_or_default(),
        }),
    )
    .await;

    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// 用户：`/api/v1/me/chain-templates`
// ---------------------------------------------------------------------------

/// 当前用户可见的模板（启用中 + 生效套餐白名单），带服务器名与配额快照。
///
/// 配额为 0 时 items 为空：`chain_limit = 0` 的套餐不会顺带放行模板，
/// 与自助转发的白名单语义一致。
pub async fn me_list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    let now = repo::now();
    let allowance = repo::chain_templates::chain_allowance(&state.db.pool, &user.0.id, now).await?;
    let used = repo::chains::count_by_owner(&state.db.pool, &user.0.id).await?;

    let templates = if allowance.limit > 0 {
        repo::chain_templates::list_enabled_by_ids(&state.db.pool, &allowance.template_ids).await?
    } else {
        Vec::new()
    };
    let names = server_names(&state).await?;
    let items: Vec<Value> = templates
        .iter()
        .map(|template| template_json(template, &names))
        .collect();

    Ok(Json(json!({
        "items": items,
        "quota": { "limit": allowance.limit, "used": used },
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::models::ChainTemplateGroup;
    use pierwave_domain::port_policy::PortPolicy;
    use pierwave_domain::Db;

    struct Fixture {
        app: Router,
        state: AppState,
        admin_cookie: String,
        admin_id: String,
        /// 入口服务器。
        a: String,
        /// 中转/出口服务器。
        b: String,
    }

    async fn setup() -> Fixture {
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
        let (a, _) = repo::servers::create(&db.pool, "hk-a", "10.0.0.1", "external")
            .await
            .unwrap();
        let (b, _) = repo::servers::create(&db.pool, "jp-b", "10.0.0.2", "external")
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        Fixture {
            app,
            state,
            admin_cookie: format!("{}={token}", crate::auth::SESSION_COOKIE),
            admin_id: admin.id,
            a: a.id,
            b: b.id,
        }
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

    async fn make_user(state: &AppState, username: &str) -> (String, String) {
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
        let (token, _) = repo::sessions::create(&state.db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        (user.id, format!("{}={token}", crate::auth::SESSION_COOKIE))
    }

    fn make_groups(groups: &[&[&str]]) -> Vec<ChainTemplateGroup> {
        groups
            .iter()
            .enumerate()
            .map(|(seq, server_ids)| ChainTemplateGroup {
                seq: seq as i64,
                strategy: "round_robin".into(),
                server_ids: server_ids.iter().map(|id| (*id).to_string()).collect(),
            })
            .collect()
    }

    /// 直接走仓储建模板：跑的是写路径校验之后的落库形态，避免每个用例都
    /// 先拼一遍 admin HTTP 请求。
    async fn create_template(
        state: &AppState,
        name: &str,
        engine: &str,
        security: &str,
        protocol: &str,
        groups: &[&[&str]],
    ) -> String {
        let groups =
            pierwave_domain::chain_templates::normalize_groups(make_groups(groups)).unwrap();
        repo::chain_templates::create(
            &state.db.pool,
            repo::chain_templates::NewChainTemplate {
                name: name.into(),
                engine: engine.into(),
                security: security.into(),
                transport: "none".into(),
                protocol: protocol.into(),
                groups_json: serde_json::to_string(&groups).unwrap(),
                enabled: true,
            },
        )
        .await
        .unwrap()
        .id
    }

    async fn bind_package(
        state: &AppState,
        name: &str,
        chain_limit: i64,
        template_ids: &[String],
        user_id: &str,
    ) -> String {
        let package = repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: name.into(),
                quota_bytes: None,
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                speed_limit_kbps: None,
                rule_template_id: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        repo::chain_templates::set_package_templates(
            &state.db.pool,
            &package.id,
            chain_limit,
            template_ids,
        )
        .await
        .unwrap();
        let package = repo::packages::find_by_id(&state.db.pool, &package.id)
            .await
            .unwrap()
            .unwrap();
        repo::user_packages::create(
            &state.db.pool,
            user_id,
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
        package.id
    }

    fn chain_body(template_id: &str, host: &str, port: i64) -> Value {
        json!({
            "template_id": template_id,
            "target_host": host,
            "target_port": port,
        })
    }

    async fn audit_actions(state: &AppState) -> Vec<String> {
        repo::audit::list(&state.db.pool, 50)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.action)
            .collect()
    }

    /// 模板 CRUD 的校验：非法引擎 / 安全模式 / 加密模式 / 服务器。
    #[tokio::test]
    async fn admin_template_crud_rejects_invalid_combinations() {
        let Fixture {
            app,
            state,
            admin_cookie,
            a,
            b,
            ..
        } = setup().await;
        let uri = "/api/v1/chain-templates";
        let valid_groups = json!([
            {"server_ids": [&a]},
            {"server_ids": [&b]},
        ]);

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            uri,
            Some(json!({
                "name": "坏引擎",
                "engine": "wireguard",
                "groups": valid_groups.clone(),
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "forward.engine_invalid");

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            uri,
            Some(json!({
                "name": "坏安全模式",
                "engine": "tunnel",
                "security": "wireguard",
                "groups": valid_groups.clone(),
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "chain.tunnel_security_invalid");

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            uri,
            Some(json!({
                "name": "模板不支持 TLS",
                "engine": "realm",
                "transport": "tls",
                "groups": valid_groups.clone(),
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "chain_template.transport_unsupported");

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            uri,
            Some(json!({
                "name": "服务器不存在",
                "groups": [{"server_ids": ["missing-server"]}],
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "chain_template.server_not_found");

        // 合法模板：realm + 明文 + 两跳。
        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            uri,
            Some(json!({
                "name": "港日",
                "engine": "realm",
                "security": "tls",
                "transport": "none",
                "protocol": "tcp",
                "groups": [
                    {"server_ids": [&a]},
                    {"server_ids": [&b], "strategy": "failover"},
                ],
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let id = body["template"]["id"].as_str().unwrap().to_string();
        assert_eq!(body["template"]["engine"], "realm");
        assert_eq!(body["template"]["groups"][1]["seq"], 1);
        assert_eq!(body["template"]["groups"][0]["servers"][0]["name"], "hk-a");
        assert_eq!(body["template"]["groups"][1]["strategy"], "failover");
        assert_eq!(body["template"]["enabled"], true);

        // 列表。
        let (status, body) = request(&app, Some(&admin_cookie), Method::GET, uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 1);

        // 组合校验在 PATCH 上同样生效：native 不允许 noise。
        let item_uri = format!("{uri}/{id}");
        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::PATCH,
            &item_uri,
            Some(json!({"security": "noise"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "chain_template.security_requires_tunnel");

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::PATCH,
            &item_uri,
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "request.no_update_fields");

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::PATCH,
            &item_uri,
            Some(json!({"enabled": false, "name": "港日-停用"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["template"]["enabled"], false);
        assert_eq!(body["template"]["name"], "港日-停用");

        // 普通用户不能管理模板。
        let (_user_id, user_cookie) = make_user(&state, "alice").await;
        let (status, body) = request(&app, Some(&user_cookie), Method::GET, uri, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "unexpected: {body}");
        let (status, _) = request(&app, Some(&user_cookie), Method::DELETE, &item_uri, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // 删除。
        let (status, body) =
            request(&app, Some(&admin_cookie), Method::DELETE, &item_uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["ok"], true);
        let (status, body) = request(&app, Some(&admin_cookie), Method::GET, uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["items"].as_array().unwrap().is_empty());

        let actions = audit_actions(&state).await;
        for action in [
            "chain_template.create",
            "chain_template.update",
            "chain_template.delete",
        ] {
            assert!(actions.iter().any(|a| a == action), "actions={actions:?}");
        }
    }

    /// 套餐 API 接受/返回 `chain_limit` 与 `chain_template_ids`，且拒绝非法值。
    #[tokio::test]
    async fn package_api_roundtrips_chain_limit_and_templates() {
        let Fixture {
            app,
            state,
            admin_cookie,
            a,
            b,
            ..
        } = setup().await;
        let template_id =
            create_template(&state, "港日", "native", "tls", "tcp", &[&[&a], &[&b]]).await;

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({
                "name": "带链套餐",
                "chain_limit": -1,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "package.chain_limit_invalid");

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({
                "name": "带链套餐",
                "chain_limit": 2,
                "chain_template_ids": ["missing-template"],
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "package.chain_template_not_found");

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({
                "name": "带链套餐",
                "chain_limit": 2,
                "chain_template_ids": [&template_id],
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let package_id = body["package"]["id"].as_str().unwrap().to_string();
        assert_eq!(body["package"]["chain_limit"], 2);
        assert_eq!(body["package"]["chain_template_ids"], json!([&template_id]));

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"chain_limit": 0, "chain_template_ids": []})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["package"]["chain_limit"], 0);
        assert_eq!(body["package"]["chain_template_ids"], json!([]));
    }

    /// 配额：limit = 1 第一条成功、第二条 400；模板不在套餐内 → 403。
    #[tokio::test]
    async fn user_chain_quota_and_template_whitelist() {
        let Fixture {
            app, state, a, b, ..
        } = setup().await;
        let template =
            create_template(&state, "港日", "native", "tls", "tcp", &[&[&a], &[&b]]).await;
        let other_template =
            create_template(&state, "港日-备用", "native", "tls", "tcp", &[&[&a], &[&b]]).await;
        let (alice_id, alice_cookie) = make_user(&state, "alice").await;
        bind_package(
            &state,
            "单链套餐",
            1,
            std::slice::from_ref(&template),
            &alice_id,
        )
        .await;

        // 用户可见模板只包含套餐白名单里的那一张。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::GET,
            "/api/v1/me/chain-templates",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 1);
        assert_eq!(body["items"][0]["id"], template.as_str());
        assert_eq!(body["items"][0]["groups"][0]["servers"][0]["name"], "hk-a");
        assert_eq!(body["quota"], json!({"limit": 1, "used": 0}));

        // 第一条成功。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/chains",
            Some(chain_body(&template, "10.9.9.9", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let chain = &body["chain"];
        let chain_id = chain["id"].as_str().unwrap().to_string();
        assert_eq!(chain["template_id"], template.as_str());
        assert_eq!(chain["template_name"], "港日");
        assert_eq!(chain["target_host"], "10.9.9.9");
        assert_eq!(chain["target_port"], 443);
        assert_eq!(chain["engine"], "native");
        assert_eq!(chain["entry_server_id"], a.as_str());
        assert_eq!(chain["entry_address"], "10.0.0.1:20000");
        assert_eq!(chain["groups"].as_array().unwrap().len(), 2);
        assert_eq!(chain["groups"][0]["servers"][0]["listen_port"], 20000);
        // 中间跳在另一台服务器上，同样从自动池分配。
        assert_eq!(chain["groups"][1]["servers"][0]["listen_port"], 20000);
        assert_eq!(body["quota"], json!({"limit": 1, "used": 1}));

        // 列表 + 配额。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::GET,
            "/api/v1/me/chains",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 1);
        assert_eq!(body["items"][0]["id"], chain_id.as_str());
        assert_eq!(body["quota"], json!({"limit": 1, "used": 1}));

        // 第二条：配额已满 → 400。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/chains",
            Some(chain_body(&template, "10.9.9.10", 8443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "me.chain_quota_exceeded");
        assert_eq!(body["params"], json!({"limit": 1, "used": 1}));

        // 模板不在套餐内 → 403（配额已满也先报 403，原因不混）。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/chains",
            Some(chain_body(&other_template, "10.9.9.10", 8443)),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "unexpected: {body}");
        assert_eq!(body["code"], "me.chain_template_not_allowed");

        // 审计只含链事实，不含用户名/邮箱。
        let entries = repo::audit::list(&state.db.pool, 50).await.unwrap();
        let create = entries
            .iter()
            .find(|entry| entry.action == "user_chain.create")
            .expect("缺少 user_chain.create 审计");
        assert_eq!(create.target.as_deref(), Some(chain_id.as_str()));
        let detail = create.detail.as_ref().unwrap().to_string();
        assert!(!detail.contains("alice"), "detail={detail}");
        assert!(detail.contains(&template), "detail={detail}");
    }

    /// 归属：别人的链看不到、删不掉；管理员列表能看到并标注来源。
    #[tokio::test]
    async fn user_chains_are_scoped_to_the_owner_and_admin_lists_them_as_user_chains() {
        let Fixture {
            app,
            state,
            admin_cookie,
            admin_id: _admin_id,
            a,
            b,
        } = setup().await;
        let template =
            create_template(&state, "港日", "native", "tls", "tcp", &[&[&a], &[&b]]).await;
        let (alice_id, alice_cookie) = make_user(&state, "alice").await;
        let (_bob_id, bob_cookie) = make_user(&state, "bob").await;
        let package_id = bind_package(
            &state,
            "双链套餐",
            2,
            std::slice::from_ref(&template),
            &alice_id,
        )
        .await;
        // bob 用同一个套餐实例口径：另建实例，但共享套餐模板。
        let package = repo::packages::find_by_id(&state.db.pool, &package_id)
            .await
            .unwrap()
            .unwrap();
        repo::user_packages::create(
            &state.db.pool,
            &_bob_id,
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

        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/chains",
            Some(chain_body(&template, "10.9.9.9", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let chain_id = body["chain"]["id"].as_str().unwrap().to_string();

        // 管理员列表仍能看到这条链，但明确标注 source=user / owner / template。
        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::GET,
            "/api/v1/chains",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], chain_id.as_str());
        assert_eq!(items[0]["source"], "user");
        assert_eq!(items[0]["owner_user_id"], alice_id.as_str());
        assert_eq!(items[0]["template_id"], template.as_str());

        // bob 看不到、删不掉 alice 的链。
        let (status, body) = request(
            &app,
            Some(&bob_cookie),
            Method::GET,
            "/api/v1/me/chains",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert!(body["items"].as_array().unwrap().is_empty());

        let delete_uri = format!("/api/v1/me/chains/{chain_id}");
        let (status, body) =
            request(&app, Some(&bob_cookie), Method::DELETE, &delete_uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "unexpected: {body}");
        assert_eq!(body["code"], "me.chain_not_found");

        // alice 自己删成功。
        let (status, body) =
            request(&app, Some(&alice_cookie), Method::DELETE, &delete_uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::GET,
            "/api/v1/me/chains",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["items"].as_array().unwrap().is_empty());

        let entries = repo::audit::list(&state.db.pool, 50).await.unwrap();
        for action in ["user_chain.create", "user_chain.delete"] {
            assert!(
                entries.iter().any(|entry| entry.action == action),
                "缺少审计 {action}"
            );
        }
    }

    /// 入口端口自动分配且遵守服务器端口策略：区间只剩一个端口时用尽即 400。
    #[tokio::test]
    async fn user_chain_entry_port_follows_the_server_port_policy() {
        let Fixture {
            app, state, a, b, ..
        } = setup().await;
        let policy = PortPolicy::validated(Some(21000), Some(21000), &[]).unwrap();
        repo::servers::set_port_policy(
            &state.db.pool,
            &a,
            Some(21000),
            Some(21000),
            &policy.allow_json(),
        )
        .await
        .unwrap();

        let template =
            create_template(&state, "港日", "native", "tls", "tcp", &[&[&a], &[&b]]).await;
        let (alice_id, alice_cookie) = make_user(&state, "alice").await;
        bind_package(
            &state,
            "双链套餐",
            2,
            std::slice::from_ref(&template),
            &alice_id,
        )
        .await;

        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/chains",
            Some(chain_body(&template, "10.9.9.9", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(
            body["chain"]["entry_address"], "10.0.0.1:21000",
            "入口端口必须在服务器的允许集合里，而不是固定 20000 池"
        );

        // 唯一的允许端口已被占用：第二条 400，且不消耗配额之外的任何东西。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/chains",
            Some(chain_body(&template, "10.9.9.10", 8443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "chain.port_allowed_exhausted");
    }

    /// 模板停用后用户不可见、也不能再建链。
    #[tokio::test]
    async fn disabled_templates_disappear_from_the_user_list() {
        let Fixture {
            app, state, a, b, ..
        } = setup().await;
        let template =
            create_template(&state, "港日", "native", "tls", "tcp", &[&[&a], &[&b]]).await;
        let (alice_id, alice_cookie) = make_user(&state, "alice").await;
        bind_package(
            &state,
            "单链套餐",
            1,
            std::slice::from_ref(&template),
            &alice_id,
        )
        .await;

        repo::chain_templates::update(
            &state.db.pool,
            &template,
            repo::chain_templates::UpdateChainTemplate {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::GET,
            "/api/v1/me/chain-templates",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["items"].as_array().unwrap().is_empty());

        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/chains",
            Some(chain_body(&template, "10.9.9.9", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "unexpected: {body}");
        assert_eq!(body["code"], "me.chain_template_not_allowed");
    }

    /// 未登录访问用户自助接口一律 401。
    #[tokio::test]
    async fn user_chain_endpoints_require_login() {
        let Fixture { app, .. } = setup().await;
        for (method, uri) in [
            (Method::GET, "/api/v1/me/chains".to_string()),
            (Method::POST, "/api/v1/me/chains".to_string()),
            (Method::GET, "/api/v1/me/chain-templates".to_string()),
            (
                Method::DELETE,
                "/api/v1/me/chains/00000000-0000-0000-0000-000000000000".to_string(),
            ),
        ] {
            let body = (method == Method::POST).then(|| json!({}));
            let (status, _) = request(&app, None, method, &uri, body).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "uri={uri}");
        }
    }
}
