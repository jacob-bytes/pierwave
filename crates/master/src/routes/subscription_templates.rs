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
use pierwave_domain::subscription_template::{
    is_template_format, normalize_groups, plan_for_format, SubscriptionGroup, TEMPLATE_FORMATS,
};

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
    let templates = repo::subscription_templates::list(&state.db.pool).await?;
    // 使用计数一次聚合取出：列表要显示「被 N 个用户 / M 个套餐使用」，
    // 删除前管理员也需要知道会解绑多少对象。
    let usage = repo::subscription_templates::usage_counts(&state.db.pool).await?;
    let items: Vec<Value> = templates
        .into_iter()
        .map(|template| {
            let counts = usage.get(&template.id).copied().unwrap_or_default();
            json!({
                "id": template.id,
                "name": template.name,
                "groups": template.groups,
                "created_at": template.created_at,
                "updated_at": template.updated_at,
                "usage": {
                    "users": counts.users,
                    "packages": counts.packages,
                },
            })
        })
        .collect();
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
    /// 按用户预览；与 `package_id` **二选一**，同时给 400。
    #[serde(default)]
    pub user_id: Option<String>,
    /// 按套餐预览：用该套餐的节点范围与规则模板绑定渲染；与 `user_id` 二选一。
    #[serde(default)]
    pub package_id: Option<String>,
    /// 导出格式；缺省 `mihomo`（与第一轮预览一致）。
    ///
    /// 前端可以传 `sing-box` / `surge full` 这类模糊写法，由
    /// [`resolve_preview_format`] 归一成注册表里的 id。
    #[serde(default, alias = "format")]
    pub target: Option<String>,
}

/// 预览对象：真实用户或套餐（互斥）。
enum PreviewSubject {
    User(pierwave_domain::models::User),
    Package(pierwave_domain::models::Package),
}

/// `user_id` / `package_id` 必须且只能给一个。
async fn resolve_preview_subject(
    state: &AppState,
    user_id: Option<&str>,
    package_id: Option<&str>,
) -> AppResult<PreviewSubject> {
    let user_id = user_id.map(str::trim).filter(|value| !value.is_empty());
    let package_id = package_id.map(str::trim).filter(|value| !value.is_empty());
    match (user_id, package_id) {
        (Some(_), Some(_)) => Err(AppError::coded(
            "subscription_template.preview_target_conflict",
            Some(json!({ "fields": ["user_id", "package_id"] })),
            "user_id 与 package_id 只能二选一",
        )),
        (None, None) => Err(AppError::coded(
            "subscription_template.preview_target_required",
            None,
            "需要提供 user_id 或 package_id",
        )),
        (Some(id), None) => Ok(PreviewSubject::User(
            repo::users::find_by_id_opt(&state.db.pool, id)
                .await?
                .ok_or_else(|| AppError::not_found("user.not_found", None, "资源不存在"))?,
        )),
        (None, Some(id)) => Ok(PreviewSubject::Package(
            repo::packages::find_by_id(&state.db.pool, id)
                .await?
                .ok_or_else(|| AppError::not_found("package.not_found", None, "资源不存在"))?,
        )),
    }
}

/// 预览支持的导出格式：只有能表达订阅模板的格式才有意义。
///
/// 模糊匹配至少覆盖 clash / mihomo / stash / singbox / singbox-full /
/// surge / surge-full / surfboard / loon / egern；未注册或/不支持模板的格式
/// 返回 `None`，由调用方给 400。
fn resolve_preview_format(raw: Option<&str>) -> Option<&'static str> {
    let raw = raw.map(str::trim).filter(|value| !value.is_empty());
    let Some(raw) = raw else {
        return Some("mihomo");
    };
    let normalized = raw.to_ascii_lowercase().replace([' ', '_'], "-");
    // 精确 id 优先（`singbox-full` / `surge-full` / `mihomo` …）。
    let resolved = if let Some(exporter) = subscribe::find_exporter(&normalized) {
        exporter.id()
    } else if normalized.contains("sing") {
        if normalized.contains("full") {
            "singbox-full"
        } else {
            "singbox"
        }
    } else if normalized.contains("surge") {
        if normalized.contains("full") {
            "surge-full"
        } else {
            "surge"
        }
    } else if normalized.contains("stash") {
        "stash"
    } else if normalized.contains("mihomo") || normalized.contains("clash-meta") {
        "mihomo"
    } else if normalized.contains("clash") {
        "clash"
    } else {
        return None;
    };
    is_template_format(resolved).then_some(resolved)
}

/// 用真实用户或套餐渲染目标格式的订阅，返回 `yaml` + `format` + `warnings`。
///
/// `user_id` 与 `package_id` 二选一：同时给 → 400，一个都不给 → 400。
/// 模板不存在 → 404；用户 / 套餐不存在 → 404。没有可用节点不是错误，
/// 会渲染出空 `proxies` / 回落分组并附 warning。
///
/// 按套餐预览用该套餐的节点范围（`packages.node_scope` → `package_nodes`）与
/// 规则模板绑定，分组仍然来自路径里的模板 `id`；没有具体用户，所以凭据是
/// 确定性的预览占位值。
///
/// `warnings` 同时包含模板告警（空组、格式无法表达的组、load-balance 近似）
/// 与「没有可用节点」的提示；渲染器与这里共用 [`plan_for_format`]，所以预览里
/// 说被跳过的组不会偷偷出现在输出里。
pub async fn preview(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PreviewSubscriptionTemplate>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let target = resolve_preview_format(req.target.as_deref()).ok_or_else(|| {
        AppError::coded(
            "subscription_template.preview_format_unsupported",
            Some(json!({ "supported": TEMPLATE_FORMATS })),
            format!(
                "预览不支持该导出格式（可选：{}）",
                TEMPLATE_FORMATS.join(" / ")
            ),
        )
    })?;

    let template = repo::subscription_templates::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| {
            AppError::not_found("subscription_template.not_found", None, "资源不存在")
        })?;
    let subject =
        resolve_preview_subject(&state, req.user_id.as_deref(), req.package_id.as_deref()).await?;

    let secret = credentials::master_secret(&state.db.pool, state.db.secret_key()).await?;
    let (nodes, effective_rules, label) = match &subject {
        PreviewSubject::User(target_user) => {
            let nodes =
                super::subscribe::subscription_nodes(&state.db.pool, &target_user.id, &secret)
                    .await?;
            let rules = super::subscribe::rules_for(&state.db.pool, target_user, None).await?;
            (nodes, rules, target_user.username.clone())
        }
        PreviewSubject::Package(package) => {
            let nodes = super::subscribe::subscription_nodes_for_package(
                &state.db.pool,
                &package.id,
                &secret,
            )
            .await?;
            let rules = super::subscribe::rules_for_package(&state.db.pool, package).await?;
            (nodes, rules, package.name.clone())
        }
    };

    let mut warnings = Vec::new();
    if nodes.is_empty() {
        warnings.push(match &subject {
            PreviewSubject::User(_) => {
                "该用户当前没有可用节点，渲染结果只有空 proxies / 回落分组 / This user has no available nodes; the preview renders empty proxies / fallback groups"
            }
            PreviewSubject::Package(_) => {
                "该套餐当前没有可用节点，渲染结果只有空 proxies / 回落分组 / This package has no available nodes; the preview renders empty proxies / fallback groups"
            }
        }
        .to_string());
    }
    if matches!(subject, PreviewSubject::Package(_)) {
        warnings.push(
            "按套餐预览没有具体用户，节点凭据是为该套餐派生的预览占位值 / A package preview has no user; node credentials are deterministic placeholders derived for the package"
                .to_string(),
        );
    }
    let plan = pierwave_domain::subscription_template::plan_groups(&template.groups, &nodes);
    let plan = plan_for_format(&plan, target);
    warnings.extend(plan.warnings.iter().cloned());

    let ctx = SubContext {
        nodes: &nodes,
        user_label: &label,
        traffic: None,
        rules: &effective_rules.rules,
        groups: Some(&plan),
    };
    let exporter = subscribe::find_exporter(target)
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("{target} 导出器未注册")))?;
    let yaml = exporter.render(&ctx)?;

    Ok(Json(json!({
        "yaml": yaml,
        "format": target,
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
    async fn preview_switches_export_format_fuzzily_and_reports_skips() {
        let (app, state, cookie, _admin) = setup().await;
        let user = seed_user_with_node(&state).await;
        let id = create_template(
            &state,
            "格式预览",
            json!([
                {"name":"香港组","type":"select","filters":[{"regions":["HK"]}]},
                {"name":"故障转移","type":"fallback","filters":[{}]},
                {"name":"哈希负载","type":"load-balance","strategy":"consistent-hashing","filters":[{}]}
            ]),
        )
        .await;

        // 模糊写法（大小写 / 空格 / 连字符）都能解析到注册表 id。
        for (target, expected) in [
            ("Mihomo", "mihomo"),
            ("clash", "clash"),
            ("Clash Meta", "mihomo"),
            ("Stash", "stash"),
            ("sing-box", "singbox"),
            ("sing box full", "singbox-full"),
            ("surge", "surge"),
            ("Surge Full", "surge-full"),
            // 第三轮接入的三种格式。
            ("Surfboard", "surfboard"),
            ("Loon", "loon"),
            ("Egern", "egern"),
        ] {
            let (status, body) = request(
                &app,
                &cookie,
                Method::POST,
                &format!("/api/v1/subscription-templates/{id}/preview"),
                Some(json!({ "user_id": user.id, "target": target })),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{target}: {body}");
            assert_eq!(body["format"], expected, "{target}: {body}");
        }

        // 缺省 target 保持第一轮行为：mihomo。
        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({ "user_id": user.id })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["format"], "mihomo");

        // clash 能表达全部组：没有跳过 warning。
        let (_, body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({ "user_id": user.id, "target": "clash" })),
        )
        .await;
        let warnings = body["warnings"].as_array().unwrap();
        assert!(
            warnings
                .iter()
                .all(|warning| !warning.as_str().unwrap().contains("已跳过")),
            "clash 不应跳过任何组：{warnings:?}"
        );

        // Surge 无法表达 consistent-hashing 的 load-balance：跳过并 warning。
        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({ "user_id": user.id, "target": "surge" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let surge = body["yaml"].as_str().unwrap();
        assert!(surge.contains("故障转移 = fallback"), "{surge}");
        assert!(
            !surge.contains("哈希负载"),
            "跳过的组不能出现在输出里：{surge}"
        );
        let warnings = body["warnings"].as_array().unwrap();
        assert!(
            warnings.iter().any(|warning| {
                let warning = warning.as_str().unwrap();
                warning.contains("哈希负载") && warning.contains("load-balance")
            }),
            "{warnings:?}"
        );

        // sing-box 没有 load-balance：保留组并用 urltest 近似，同时 warning。
        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({ "user_id": user.id, "target": "sing-box" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let singbox: Value = serde_json::from_str(body["yaml"].as_str().unwrap()).unwrap();
        assert!(
            singbox["outbounds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|outbound| outbound["tag"] == "哈希负载" && outbound["type"] == "urltest"),
            "{singbox}"
        );
        assert!(
            body["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| { warning.as_str().unwrap().contains("urltest") }),
            "{}",
            body["warnings"]
        );

        // 不支持模板的格式（qx / 未知）明确 400，而不是把 YAML 塞回去。
        for target in ["qx", "uri", "shadowrocket", "not-a-client"] {
            let (status, body) = request(
                &app,
                &cookie,
                Method::POST,
                &format!("/api/v1/subscription-templates/{id}/preview"),
                Some(json!({ "user_id": user.id, "target": target })),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{target}: {body}");
            assert_eq!(
                body["code"], "subscription_template.preview_format_unsupported",
                "{target}: {body}"
            );
        }
    }

    /// 列表要带「被 N 个用户 / M 个套餐使用」的计数；删除后外键自动解绑。
    #[tokio::test]
    async fn list_reports_usage_counts_and_delete_unbinds_references() {
        let (app, state, cookie, _admin) = setup().await;
        let id = create_template(&state, "使用中", groups()).await;

        let bound_user = repo::users::create(
            &state.db.pool,
            NewUser {
                username: "bound-user".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: Some(id.clone()),
            },
        )
        .await
        .unwrap();
        let bound_package = repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: "绑定模板的套餐".into(),
                quota_bytes: None,
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                speed_limit_kbps: None,
                rule_template_id: None,
                subscription_template_id: Some(id.clone()),
                node_ids: None,
            },
        )
        .await
        .unwrap();

        let (status, body) = request(
            &app,
            &cookie,
            Method::GET,
            "/api/v1/subscription-templates",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "{body}");
        assert_eq!(items[0]["usage"]["users"], 1, "{body}");
        assert_eq!(items[0]["usage"]["packages"], 1, "{body}");
        // 既有字段必须保持原样（前端仍按 groups / created_at 渲染）。
        assert_eq!(items[0]["groups"].as_array().unwrap().len(), 2);
        assert!(items[0]["created_at"].as_i64().is_some());

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
            repo::users::find_by_id_opt(&state.db.pool, &bound_user.id)
                .await
                .unwrap()
                .unwrap()
                .subscription_template_id
                .is_none(),
            "删除模板必须让用户绑定解绑"
        );
        assert!(
            repo::packages::find_by_id(&state.db.pool, &bound_package.id)
                .await
                .unwrap()
                .unwrap()
                .subscription_template_id
                .is_none(),
            "删除模板必须让套餐绑定解绑"
        );

        // 新建一个没人使用的模板：usage 必须显式给 0，而不是缺字段。
        create_template(&state, "未使用", groups()).await;
        let (_, body) = request(
            &app,
            &cookie,
            Method::GET,
            "/api/v1/subscription-templates",
            None,
        )
        .await;
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "{body}");
        assert_eq!(items[0]["usage"]["users"], 0, "{body}");
        assert_eq!(items[0]["usage"]["packages"], 0, "{body}");
    }

    /// 两个节点 + 「全部节点」套餐 + 「仅日本」套餐；用于按套餐预览的范围对比。
    async fn seed_scope_fixtures(state: &AppState) -> (String, String, String) {
        let user = repo::users::create(
            &state.db.pool,
            NewUser {
                username: "scope-user".into(),
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
            repo::servers::create(&state.db.pool, "scope-1", "203.0.113.50", "external")
                .await
                .unwrap();
        repo::nodes::create(
            &state.db.pool,
            &server.id,
            repo::nodes::NewNode {
                tag: Some("hk-scope".into()),
                name: "香港-SCOPE".into(),
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
                            "publicKey": "scope-public-key",
                            "shortIds": ["abcd1234"]
                        }
                    }
                })
                .to_string(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
                tags: vec!["香港".into()],
                region: Some("HK".into()),
            },
        )
        .await
        .unwrap();
        let jp = repo::nodes::create(
            &state.db.pool,
            &server.id,
            repo::nodes::NewNode {
                tag: Some("jp-scope".into()),
                name: "日本-SCOPE".into(),
                protocol: "trojan".into(),
                transport: "ws".into(),
                security: "none".into(),
                port: 8443,
                public_port: None,
                config_json: json!({
                    "settings": {"clients": [{"password": "scope-password"}]},
                    "stream": {
                        "network": "ws",
                        "security": "none",
                        "wsSettings": {"path": "/ws"}
                    }
                })
                .to_string(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
                tags: vec!["日本".into()],
                region: Some("JP".into()),
            },
        )
        .await
        .unwrap();

        let all = repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: "全部节点".into(),
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
                package_id: all.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &all,
        )
        .await
        .unwrap();
        let restricted = repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: "仅日本".into(),
                quota_bytes: None,
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                speed_limit_kbps: None,
                rule_template_id: None,
                subscription_template_id: None,
                node_ids: Some(vec![jp.id.clone()]),
            },
        )
        .await
        .unwrap();
        (user.id, all.id, restricted.id)
    }

    /// 按套餐预览：节点范围来自套餐，与按用户预览可以不同；同时给两个 id → 400。
    #[tokio::test]
    async fn preview_by_package_uses_its_node_scope() {
        let (app, state, cookie, _admin) = setup().await;
        let (user_id, all_package, restricted_package) = seed_scope_fixtures(&state).await;
        let id = create_template(
            &state,
            "范围预览",
            json!([
                {"name":"节点选择","type":"select","filters":[{}]}
            ]),
        )
        .await;

        // 按用户：套餐覆盖全部节点 → 两个节点都在。
        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({ "user_id": user_id })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let yaml = body["yaml"].as_str().unwrap();
        assert!(yaml.contains("香港-SCOPE"), "{yaml}");
        assert!(yaml.contains("日本-SCOPE"), "{yaml}");

        // 按套餐：只有显式范围里的日本节点。
        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({ "package_id": restricted_package })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let yaml = body["yaml"].as_str().unwrap();
        assert!(yaml.contains("日本-SCOPE"), "{yaml}");
        assert!(
            !yaml.contains("香港-SCOPE"),
            "套餐范围外的节点不能出现在预览里：{yaml}"
        );
        assert!(
            body["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| warning.as_str().unwrap().contains("占位值")),
            "占位凭据必须显式说明：{}",
            body["warnings"]
        );

        // 未设范围的套餐覆盖全部节点，与用户预览一致。
        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({ "package_id": all_package })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let yaml = body["yaml"].as_str().unwrap();
        assert!(
            yaml.contains("香港-SCOPE") && yaml.contains("日本-SCOPE"),
            "{yaml}"
        );

        // user_id / package_id 二选一：同时给、都不给都是 400。
        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({ "user_id": user_id, "package_id": all_package })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            body["code"], "subscription_template.preview_target_conflict",
            "{body}"
        );

        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            body["code"], "subscription_template.preview_target_required",
            "{body}"
        );

        // 套餐不存在 → 404 package.not_found，而不是回落到用户分支。
        let (status, body) = request(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/subscription-templates/{id}/preview"),
            Some(json!({ "package_id": "does-not-exist" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["code"], "package.not_found", "{body}");
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
