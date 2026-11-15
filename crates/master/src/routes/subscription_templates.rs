//! 订阅模板管理（管理员）与预览。
//!
//! 模板决定 mihomo / clash 订阅里的 `proxy-groups`；校验在 HTTP 层做，
//! 仓储只负责落库。`groups_json` 是声明式结构，不接受任何脚本：
//! 未知字段会在反序列化阶段被拒绝，语义校验（组名、filter、interval）
//! 全部走 `pierwave_domain::subscription_template::normalize_groups`。
//!
//! 预览用真实用户 + 真实节点 + 真实规则模板渲染 mihomo，返回渲染结果与
//! warning；这样管理员看到的就是用户真正拿到的分组。

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::credentials;
use pierwave_domain::repo;
use pierwave_domain::repo::subscription_templates::{
    NewSubscriptionTemplate, UpdateSubscriptionTemplate,
};
use pierwave_domain::subscribe::{self, SubContext};
use pierwave_domain::subscription_template::{normalize_groups, SubscriptionGroup};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 模板名称上限（Unicode 字符）。
const MAX_TEMPLATE_NAME_CHARS: usize = 32;

fn normalize_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::coded(
            "subscription_template.name_required",
            None,
            "订阅模板名称不能为空",
        ));
    }
    if name.chars().count() > MAX_TEMPLATE_NAME_CHARS {
        return Err(AppError::coded(
            "subscription_template.name_too_long",
            Some(json!({ "max": MAX_TEMPLATE_NAME_CHARS })),
            format!("订阅模板名称最多 {MAX_TEMPLATE_NAME_CHARS} 个字符"),
        ));
    }
    Ok(name.to_string())
}

/// 领域校验错误 → 带 code 的 400；前端按 `code + params` 做双语。
fn validate_groups(groups: &[SubscriptionGroup]) -> AppResult<Vec<SubscriptionGroup>> {
    normalize_groups(groups)
        .map_err(|problem| AppError::coded(problem.code, Some(problem.params), problem.message))
}

async fn ensure_name_available(
    state: &AppState,
    name: &str,
    current_id: Option<&str>,
) -> AppResult<()> {
    if let Some(existing) = repo::subscription_templates::find_by_name(&state.db.pool, name).await?
    {
        if Some(existing.id.as_str()) != current_id {
            return Err(AppError::coded(
                "subscription_template.name_taken",
                Some(json!({ "name": name })),
                format!("订阅模板名称「{name}」已存在"),
            ));
        }
    }
    Ok(())
}

/// 并发下仍可能撞唯一索引：把数据库错误翻译成 400 中文，而不是 500。
fn map_name_conflict(error: anyhow::Error) -> AppError {
    if format!("{error:#}").contains("UNIQUE constraint failed: subscription_templates.name") {
        AppError::coded(
            "subscription_template.name_taken",
            None,
            "订阅模板名称已存在",
        )
    } else {
        AppError::Internal(error)
    }
}

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let items = repo::subscription_templates::list(&state.db.pool).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateSubscriptionTemplate {
    pub name: String,
    pub groups: Vec<SubscriptionGroup>,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<CreateSubscriptionTemplate>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let name = normalize_name(&req.name)?;
    let groups = validate_groups(&req.groups)?;
    ensure_name_available(&state, &name, None).await?;

    let template = repo::subscription_templates::create(
        &state.db.pool,
        NewSubscriptionTemplate { name, groups },
    )
    .await
    .map_err(map_name_conflict)?;

    crate::audit::record(
        &state,
        &user.0,
        "subscription_template.create",
        &template.id,
        json!({
            "name": &template.name,
            "group_count": template.groups.len(),
            "groups": template.groups.iter().map(|group| &group.name).collect::<Vec<_>>(),
        }),
    )
    .await;

    Ok(Json(json!({ "template": template })))
}

#[derive(Deserialize)]
pub struct UpdateSubscriptionTemplateBody {
    pub name: Option<String>,
    pub groups: Option<Vec<SubscriptionGroup>>,
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<UpdateSubscriptionTemplateBody>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    if req.name.is_none() && req.groups.is_none() {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供一个可更新字段",
        ));
    }

    let name = match req.name.as_deref() {
        Some(raw) => Some(normalize_name(raw)?),
        None => None,
    };
    if let Some(name) = &name {
        ensure_name_available(&state, name, Some(&id)).await?;
    }
    let groups = req.groups.as_deref().map(validate_groups).transpose()?;

    let before = repo::subscription_templates::find_by_id(&state.db.pool, &id).await?;
    let template = repo::subscription_templates::update(
        &state.db.pool,
        &id,
        UpdateSubscriptionTemplate { name, groups },
    )
    .await
    .map_err(map_name_conflict)?
    .ok_or_else(|| AppError::not_found("subscription_template.not_found", None, "资源不存在"))?;

    let changes = crate::audit::diff(vec![
        (
            "name",
            json!(before.as_ref().map(|item| &item.name)),
            json!(&template.name),
        ),
        (
            "group_count",
            json!(before.as_ref().map(|item| item.groups.len())),
            json!(template.groups.len()),
        ),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "subscription_template.update",
        &template.id,
        json!({
            "changes": changes,
            "groups": template.groups.iter().map(|group| &group.name).collect::<Vec<_>>(),
        }),
    )
    .await;

    Ok(Json(json!({ "template": template })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let template = repo::subscription_templates::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| {
            AppError::not_found("subscription_template.not_found", None, "资源不存在")
        })?;
    if !repo::subscription_templates::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found(
            "subscription_template.not_found",
            None,
            "资源不存在",
        ));
    }

    crate::audit::record(
        &state,
        &user.0,
        "subscription_template.delete",
        &id,
        json!({
            "name": &template.name,
            "group_count": template.groups.len(),
        }),
    )
    .await;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct PreviewSubscriptionTemplate {
    pub user_id: String,
}

/// 用真实用户渲染 mihomo 完整配置，返回 `yaml` + `warnings`。
///
/// 模板不存在 → 404；用户不存在 → 404。用户没有可用节点不是错误，
/// 会渲染出 `proxies: []` 并附 warning。
pub async fn preview(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PreviewSubscriptionTemplate>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let template = repo::subscription_templates::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| {
            AppError::not_found("subscription_template.not_found", None, "资源不存在")
        })?;
    let target_user = repo::users::find_by_id_opt(&state.db.pool, req.user_id.trim())
        .await?
        .ok_or_else(|| AppError::not_found("user.not_found", None, "资源不存在"))?;

    let secret = credentials::master_secret(&state.db.pool).await?;
    let nodes =
        super::subscribe::subscription_nodes(&state.db.pool, &target_user.id, &secret).await?;
    let effective_rules = super::subscribe::rules_for(&state.db.pool, &target_user, None).await?;

    let mut warnings = Vec::new();
    if nodes.is_empty() {
        warnings.push(
            "该用户当前没有可用节点，渲染结果只有空 proxies / 回落分组 / This user has no available nodes; the preview renders empty proxies / fallback groups"
                .to_string(),
        );
    }
    let plan = pierwave_domain::subscription_template::plan_groups(&template.groups, &nodes);
    warnings.extend(plan.warnings.iter().cloned());

    let ctx = SubContext {
        nodes: &nodes,
        user_label: &target_user.username,
        traffic: None,
        rules: &effective_rules.rules,
        groups: Some(&plan),
    };
    let exporter = subscribe::select_exporter(Some("mihomo"), None)
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("mihomo 导出器未注册")))?;
    let yaml = exporter.render(&ctx)?;

    Ok(Json(json!({
        "yaml": yaml,
        "warnings": warnings,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::repo::users::NewUser;
    use pierwave_domain::Db;

    const GROUPS: &str = r#"[
        {"name":"节点选择","type":"select","filters":[{"tags":["香港"]}],"include_auto":true},
        {"name":"自动选择","type":"url-test","filters":[{}],"interval":120}
    ]"#;

    async fn setup() -> (Router, AppState, String, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = repo::users::create(
            &db.pool,
            NewUser {
                username: "admin".into(),
                password: "devpass".into(),
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
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
            admin.id,
        )
    }

    async fn request(
        app: &Router,
        cookie: &str,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::COOKIE, cookie);
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
            // 反序列化失败时 axum 回纯文本 422，测试助手不能因此 panic。
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        (status, value)
    }

    async fn create_template(state: &AppState, name: &str, groups: serde_json::Value) -> String {
        let groups: Vec<SubscriptionGroup> = serde_json::from_value(groups).unwrap();
        repo::subscription_templates::create(
            &state.db.pool,
            NewSubscriptionTemplate {
                name: name.into(),
                groups: validate_groups(&groups).unwrap(),
            },
        )
        .await
        .unwrap()
        .id
    }

    fn groups() -> serde_json::Value {
        serde_json::from_str(GROUPS).unwrap()
    }

    #[tokio::test]
    async fn crud_round_trip() {
        let (app, state, cookie, _admin) = setup().await;

        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/subscription-templates",
            Some(json!({ "name": "  默认分组 ", "groups": groups() })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let id = body["template"]["id"].as_str().unwrap().to_string();
        assert_eq!(body["template"]["name"], "默认分组");
        assert_eq!(body["template"]["groups"].as_array().unwrap().len(), 2);
        // 落库的是规范化形态：url-test 的 interval 保留，select 的不写。
        assert_eq!(body["template"]["groups"][1]["interval"], 120);
        assert!(body["template"]["groups"][0].get("interval").is_none());

        let (status, body) = request(
            &app,
            &cookie,
            Method::GET,
            "/api/v1/subscription-templates",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"].as_array().unwrap().len(), 1);

        let (status, body) = request(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/subscription-templates/{id}"),
            Some(json!({ "name": "改名", "groups": [
                {"name":"全部","type":"select","filters":[{}]}
            ] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["template"]["name"], "改名");
        assert_eq!(body["template"]["groups"].as_array().unwrap().len(), 1);

        let (status, _body) = request(
            &app,
            &cookie,
            Method::DELETE,
            &format!("/api/v1/subscription-templates/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            repo::subscription_templates::find_by_id(&state.db.pool, &id)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn invalid_templates_are_rejected_with_codes() {
        let (app, _state, cookie, _admin) = setup().await;

        let cases = [
            (
                json!({ "name": " ", "groups": groups() }),
                "subscription_template.name_required",
            ),
            (
                json!({ "name": "空组", "groups": [] }),
                "subscription_template.groups_empty",
            ),
            (
                json!({ "name": "没组名", "groups": [
                    {"name":" ","type":"select","filters":[{}]}
                ] }),
                "subscription_template.group_name_required",
            ),
            (
                json!({ "name": "没条件", "groups": [
                    {"name":"节点选择","type":"select","filters":[]}
                ] }),
                "subscription_template.filters_empty",
            ),
            (
                json!({ "name": "错协议", "groups": [
                    {"name":"节点选择","type":"select","filters":[{"protocols":["kcp"]}]}
                ] }),
                "subscription_template.filter_protocol_invalid",
            ),
            (
                json!({ "name": "间隔越界", "groups": [
                    {"name":"自动","type":"url-test","filters":[{}],"interval":5}
                ] }),
                "subscription_template.interval_invalid",
            ),
            (
                json!({ "name": "auto 放错组", "groups": [
                    {"name":"自动","type":"url-test","filters":[{}],"include_auto":true}
                ] }),
                "subscription_template.include_auto_select_only",
            ),
        ];
        for (payload, code) in cases {
            let (status, body) = request(
                &app,
                &cookie,
                Method::POST,
                "/api/v1/subscription-templates",
                Some(payload),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(body["code"], code, "{body}");
        }

        // 重名：先成功建一个，再建同名。
        let (status, _body) = request(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/subscription-templates",
            Some(json!({ "name": "重名", "groups": groups() })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/subscription-templates",
            Some(json!({ "name": "重名", "groups": groups() })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "subscription_template.name_taken");

        // 未知字段（声明式，不允许脚本）：反序列化阶段拒绝。
        let (status, _body) = request(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/subscription-templates",
            Some(json!({ "name": "脚本", "groups": [
                {"name":"节点选择","type":"select","filters":[{}],"script":"return nodes"}
            ] })),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

        // 未知组类型同样拒绝。
        let (status, _body) = request(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/subscription-templates",
            Some(json!({ "name": "未知类型", "groups": [
                {"name":"组","type":"script","filters":[{}]}
            ] })),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

        let (status, _body) = request(
            &app,
            &cookie,
            Method::PATCH,
            "/api/v1/subscription-templates/does-not-exist",
            Some(json!({ "name": "x" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    async fn seed_user_with_node(state: &AppState) -> pierwave_domain::models::User {
        let user = repo::users::create(
            &state.db.pool,
            NewUser {
                username: "alice".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
            },
        )
        .await
        .unwrap();
        let (server, _token) =
            repo::servers::create(&state.db.pool, "hk-1", "203.0.113.10", "external")
                .await
                .unwrap();
        repo::nodes::create(
            &state.db.pool,
            &server.id,
            repo::nodes::NewNode {
                tag: Some("hk-reality".into()),
                name: "香港-REALITY".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "reality".into(),
                port: 443,
                public_port: None,
                config_json: json!({
                    "settings": {"clients": []},
                    "stream": {
                        "network": "tcp",
                        "security": "reality",
                        "realitySettings": {
                            "serverNames": ["www.example.com"],
                            "publicKey": "public-key-abc",
                            "shortIds": ["abcd1234"]
                        }
                    }
                })
                .to_string(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
                tags: vec!["香港".into(), "中转".into()],
                region: Some("HK".into()),
            },
        )
        .await
        .unwrap();
        let package = repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: "月卡".into(),
                quota_bytes: None,
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                speed_limit_kbps: None,
                rule_template_id: None,
                subscription_template_id: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        repo::user_packages::create(
            &state.db.pool,
            &user.id,
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
        user
    }

    #[tokio::test]
    async fn preview_renders_the_template_and_reports_warnings() {
        let (app, state, cookie, _admin) = setup().await;
        let user = seed_user_with_node(&state).await;

        let id = create_template(
            &state,
            "预览",
            json!([
                {"name":"节点选择","type":"select","filters":[{"tags":["香港"],"regions":["HK"],"protocols":["vless"]}],"include_auto":true},
                {"name":"自动选择","type":"url-test","filters":[{}]},
                {"name":"韩国","type":"url-test","filters":[{"regions":["KR"]}]}
            ]),
        )
        .await;

        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({ "user_id": user.id })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let yaml = body["yaml"].as_str().unwrap();
        assert!(yaml.contains("name: \"节点选择\""), "{yaml}");
        assert!(yaml.contains("香港-REALITY"), "{yaml}");
        assert!(yaml.contains("MATCH,节点选择"), "{yaml}");
        let warnings = body["warnings"].as_array().unwrap();
        assert!(
            warnings
                .iter()
                .any(|warning| warning.as_str().unwrap().contains("韩国")),
            "空组必须进 warning：{warnings:?}"
        );

        let (status, _body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({ "user_id": "does-not-exist" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, _body) = request(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/subscription-templates/does-not-exist/preview",
            Some(json!({ "user_id": user.id })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn non_admin_cannot_manage_templates() {
        let (app, state, _cookie, _admin) = setup().await;
        let user = seed_user_with_node(&state).await;
        let (token, _) = repo::sessions::create(&state.db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);

        let (status, _body) = request(
            &app,
            &cookie,
            Method::GET,
            "/api/v1/subscription-templates",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
