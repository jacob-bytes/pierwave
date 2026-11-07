//! 规则模板管理（管理员）。
//!
//! 规则模板决定订阅 clash 配置里的 `rules:` 段。校验在 HTTP 层做，仓储只负责
//! 落库与「默认唯一」的事务约束；两条规则必须由这里守死：
//!
//! - `rules` 非空，每条 1–200 字符；
//! - 最后一条必须以大写 `MATCH` 开头（Clash 没有兜底规则整份配置无效）。

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::repo;
use pierwave_domain::repo::rule_templates::{DeleteOutcome, NewRuleTemplate, UpdateRuleTemplate};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 单条规则的最大字符数（按 Unicode 字符算，不按字节）。
const MAX_RULE_CHARS: usize = 200;

fn normalize_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("规则模板名称不能为空".into()));
    }
    Ok(name.to_string())
}

fn normalize_description(raw: Option<String>, fallback: &str) -> String {
    raw.map(|value| value.trim().to_string())
        .unwrap_or_else(|| fallback.to_string())
}

/// 去空白并逐条校验；返回的就是要落库/渲染的最终规则。
fn validate_rules(raw: Vec<String>) -> AppResult<Vec<String>> {
    if raw.is_empty() {
        return Err(AppError::BadRequest(
            "规则不能为空，至少需要一条以 MATCH 开头的兜底规则".into(),
        ));
    }

    let mut rules = Vec::with_capacity(raw.len());
    for (index, rule) in raw.iter().enumerate() {
        let rule = rule.trim();
        let chars = rule.chars().count();
        if chars == 0 {
            return Err(AppError::BadRequest(format!(
                "第 {} 条规则不能为空",
                index + 1
            )));
        }
        if chars > MAX_RULE_CHARS {
            return Err(AppError::BadRequest(format!(
                "第 {} 条规则超过 {MAX_RULE_CHARS} 个字符",
                index + 1
            )));
        }
        rules.push(rule.to_string());
    }

    // Clash 习惯用大写 MATCH；这里严格匹配大写，避免把 `match,PROXY`
    // 这类客户端不认的写法写进配置。
    let last = rules.last().expect("rules 非空已校验");
    if !last.starts_with("MATCH") {
        return Err(AppError::BadRequest(
            "最后一条规则必须以大写 MATCH 开头（例如 MATCH,PROXY），否则 Clash 配置没有兜底规则"
                .into(),
        ));
    }

    Ok(rules)
}

/// 名称唯一性预检；`current_id` 是更新时的自身 id（允许保持原名）。
async fn ensure_name_available(
    state: &AppState,
    name: &str,
    current_id: Option<&str>,
) -> AppResult<()> {
    if let Some(existing) = repo::rule_templates::find_by_name(&state.db.pool, name).await? {
        if Some(existing.id.as_str()) != current_id {
            return Err(AppError::BadRequest(format!(
                "规则模板名称「{name}」已存在"
            )));
        }
    }
    Ok(())
}

/// 并发下仍可能撞唯一索引：把数据库错误翻译成 400 中文，而不是 500。
fn map_name_conflict(error: anyhow::Error) -> AppError {
    if format!("{error:#}").contains("UNIQUE constraint failed: rule_templates.name") {
        AppError::BadRequest("规则模板名称已存在".into())
    } else {
        AppError::Internal(error)
    }
}

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let items = repo::rule_templates::list(&state.db.pool).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateRuleTemplate {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub rules: Vec<String>,
    #[serde(default)]
    pub is_default: bool,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<CreateRuleTemplate>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let name = normalize_name(&req.name)?;
    let rules = validate_rules(req.rules)?;
    ensure_name_available(&state, &name, None).await?;

    let template = repo::rule_templates::create(
        &state.db.pool,
        NewRuleTemplate {
            name,
            description: normalize_description(req.description, ""),
            rules,
            is_default: req.is_default,
        },
    )
    .await
    .map_err(map_name_conflict)?;

    crate::audit::record(
        &state,
        &user.0,
        "rule_template.create",
        &template.id,
        json!({
            "name": &template.name,
            "rule_count": template.rules.len(),
            "is_default": template.is_default,
        }),
    )
    .await;

    Ok(Json(json!({ "template": template })))
}

#[derive(Deserialize)]
pub struct UpdateRuleTemplateBody {
    pub name: Option<String>,
    pub description: Option<String>,
    pub rules: Option<Vec<String>>,
    pub is_default: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<UpdateRuleTemplateBody>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    if req.name.is_none()
        && req.description.is_none()
        && req.rules.is_none()
        && req.is_default.is_none()
    {
        return Err(AppError::BadRequest("至少需要提供一个可更新字段".into()));
    }

    let name = match req.name.as_deref() {
        Some(raw) => Some(normalize_name(raw)?),
        None => None,
    };
    if let Some(name) = &name {
        ensure_name_available(&state, name, Some(&id)).await?;
    }
    let rules = req.rules.map(validate_rules).transpose()?;

    let before = repo::rule_templates::find_by_id(&state.db.pool, &id).await?;
    let template = repo::rule_templates::update(
        &state.db.pool,
        &id,
        UpdateRuleTemplate {
            name,
            // 显式传空串 = 清空说明；未传 = 不动。
            description: req.description.map(|value| value.trim().to_string()),
            rules,
            is_default: req.is_default,
        },
    )
    .await
    .map_err(map_name_conflict)?
    .ok_or(AppError::NotFound)?;

    let changes = crate::audit::diff(vec![
        (
            "name",
            json!(before.as_ref().map(|item| &item.name)),
            json!(&template.name),
        ),
        (
            "description",
            json!(before.as_ref().map(|item| &item.description)),
            json!(&template.description),
        ),
        (
            "rule_count",
            json!(before.as_ref().map(|item| item.rules.len())),
            json!(template.rules.len()),
        ),
        (
            "is_default",
            json!(before.as_ref().map(|item| item.is_default)),
            json!(template.is_default),
        ),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "rule_template.update",
        &template.id,
        json!({
            "changes": changes,
            "rules": &template.rules,
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

    let template = repo::rule_templates::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    match repo::rule_templates::delete(&state.db.pool, &id).await? {
        DeleteOutcome::Deleted => {}
        DeleteOutcome::NotFound => return Err(AppError::NotFound),
        DeleteOutcome::IsDefault => {
            return Err(AppError::BadRequest(
                "默认规则模板不能删除，请先把其它模板设为默认".into(),
            ))
        }
    }

    crate::audit::record(
        &state,
        &user.0,
        "rule_template.delete",
        &id,
        json!({
            "name": &template.name,
            "rule_count": template.rules.len(),
        }),
    )
    .await;

    Ok(Json(json!({ "ok": true })))
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

    async fn setup() -> (Router, AppState, String) {
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

    async fn list_templates(app: &Router, cookie: &str) -> Vec<Value> {
        let (status, body) = request(
            app,
            Some(cookie),
            Method::GET,
            "/api/v1/rule-templates",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        body["items"].as_array().unwrap().clone()
    }

    fn template_by_name(items: &[Value], name: &str) -> Value {
        items
            .iter()
            .find(|item| item["name"] == name)
            .unwrap_or_else(|| panic!("找不到模板 {name}：{items:?}"))
            .clone()
    }

    fn rule_list(value: &Value) -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|rule| rule.as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn migration_seeds_default_template_identical_to_legacy_rules() {
        let (app, _state, cookie) = setup().await;
        let items = list_templates(&app, &cookie).await;

        assert_eq!(items.len(), 1, "迁移只应有一条初始数据：{items:?}");
        let item = &items[0];
        assert_eq!(item["name"], "默认");
        assert_eq!(item["description"], "大陆直连，其余走代理");
        assert_eq!(
            rule_list(&item["rules"]),
            vec!["GEOIP,CN,DIRECT", "MATCH,PROXY"]
        );
        assert_eq!(item["is_default"], true);
        assert_eq!(item["created_at"], 0);
        assert_eq!(item["updated_at"], 0);
    }

    #[tokio::test]
    async fn crud_flow_keeps_exactly_one_default_and_protects_it_from_delete() {
        let (app, _state, cookie) = setup().await;

        let (status, created) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/rule-templates",
            Some(json!({
                "name": "全局代理",
                "description": "先代理后直连",
                "rules": ["DOMAIN-SUFFIX,example.com,PROXY", "MATCH,PROXY"],
                "is_default": true,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {created}");
        let custom_a = created["template"]["id"].as_str().unwrap().to_string();
        assert_eq!(created["template"]["is_default"], true);
        assert_eq!(created["template"]["rules"].as_array().unwrap().len(), 2);

        // 设新默认后旧的默认必须被清 0，列表里的默认排在最前。
        let items = list_templates(&app, &cookie).await;
        let seeded = template_by_name(&items, "默认");
        assert_eq!(seeded["is_default"], false, "旧默认应被清掉：{items:?}");
        assert_eq!(template_by_name(&items, "全局代理")["is_default"], true);
        assert_eq!(
            items
                .iter()
                .filter(|item| item["is_default"] == true)
                .count(),
            1
        );
        assert_eq!(items[0]["name"], "全局代理", "默认模板应排最前");

        // 再建一个普通模板，然后把它设为默认：默认仍然只有一个。
        let (status, created_b) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/rule-templates",
            Some(json!({
                "name": "直连优先",
                "rules": ["MATCH,DIRECT"],
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {created_b}");
        let custom_b = created_b["template"]["id"].as_str().unwrap().to_string();
        assert_eq!(created_b["template"]["is_default"], false);

        let (status, patched) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/rule-templates/{custom_b}"),
            Some(json!({
                "name": "直连优先",
                "description": "全部直连",
                "rules": ["DOMAIN-SUFFIX,corp.example,DIRECT", "MATCH,DIRECT"],
                "is_default": true,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {patched}");
        assert_eq!(patched["template"]["description"], "全部直连");
        assert_eq!(
            rule_list(&patched["template"]["rules"]),
            vec!["DOMAIN-SUFFIX,corp.example,DIRECT", "MATCH,DIRECT"]
        );

        let items = list_templates(&app, &cookie).await;
        assert_eq!(template_by_name(&items, "直连优先")["is_default"], true);
        assert_eq!(
            template_by_name(&items, "全局代理")["is_default"],
            false,
            "第二次设默认也要清掉上一个"
        );
        assert_eq!(
            items
                .iter()
                .filter(|item| item["is_default"] == true)
                .count(),
            1
        );

        // 默认模板不可删；非默认可以。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/rule-templates/{custom_b}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"].as_str().unwrap().contains("默认"),
            "unexpected: {body}"
        );

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/rule-templates/{custom_a}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "非默认模板应可删除");

        let seeded = template_by_name(&list_templates(&app, &cookie).await, "默认");
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/rule-templates/{}", seeded["id"].as_str().unwrap()),
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "被顶替后的初始模板已不是默认，可删除"
        );

        let items = list_templates(&app, &cookie).await;
        assert_eq!(items.len(), 1, "只剩当前的默认模板：{items:?}");
        assert_eq!(items[0]["name"], "直连优先");

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            "/api/v1/rule-templates/does-not-exist",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn rule_validation_rejects_empty_missing_match_and_too_long() {
        let (app, _state, cookie) = setup().await;
        let seeded_id = list_templates(&app, &cookie).await[0]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let cases = [
            (json!({"name": "空规则", "rules": []}), "不能为空"),
            (
                json!({"name": "没有兜底", "rules": ["GEOIP,CN,DIRECT"]}),
                "MATCH",
            ),
            (
                json!({"name": "小写 match", "rules": ["match,PROXY"]}),
                "MATCH",
            ),
            (
                json!({"name": "超长规则", "rules": ["A".repeat(MAX_RULE_CHARS + 1), "MATCH,PROXY"]}),
                "200",
            ),
            (
                json!({"name": "", "rules": ["MATCH,PROXY"]}),
                "名称不能为空",
            ),
        ];
        for (body, expected) in cases {
            let (status, value) = request(
                &app,
                Some(&cookie),
                Method::POST,
                "/api/v1/rule-templates",
                Some(body.clone()),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "body={body} value={value}");
            assert!(
                value["error"].as_str().unwrap().contains(expected),
                "body={body} value={value}"
            );
        }

        // PATCH 同样走校验。
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/rule-templates/{seeded_id}"),
            Some(json!({"rules": ["GEOIP,CN,DIRECT"]})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(value["error"].as_str().unwrap().contains("MATCH"));
    }

    #[tokio::test]
    async fn duplicate_name_is_400_on_create_and_update() {
        let (app, _state, cookie) = setup().await;

        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/rule-templates",
            Some(json!({"name": "默认", "rules": ["MATCH,PROXY"]})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(value["error"].as_str().unwrap().contains("已存在"));

        let (_, created) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/rule-templates",
            Some(json!({"name": "另一个", "rules": ["MATCH,DIRECT"]})),
        )
        .await;
        let id = created["template"]["id"].as_str().unwrap();
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/rule-templates/{id}"),
            Some(json!({"name": "默认"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(value["error"].as_str().unwrap().contains("已存在"));

        // 更新时保持原名是允许的（不能把自己当成冲突）。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/rule-templates/{id}"),
            Some(json!({"name": "另一个", "description": "改了说明"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn non_admin_cannot_manage_rule_templates() {
        let (app, state, _cookie) = setup().await;
        let user = repo::users::create(
            &state.db.pool,
            NewUser {
                username: "alice".into(),
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
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/rule-templates",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/rule-templates",
            Some(json!({"name": "越权", "rules": ["MATCH,PROXY"]})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
