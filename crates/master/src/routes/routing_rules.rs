//! 路由规则管理（管理员）。
//!
//! 契约见 `docs/PLAN.md` P3：
//! * 入站 / 域名 / IP 至少给一个，否则规则会吞掉所有流量；
//! * `outbound_tag` 必须是 `direct` / `blocked` 或该服务器已存在的自定义出站；
//! * `inbound_tag` 若填写，必须指向该服务器上已存在的节点 tag；
//! * 写成功后只标记对应服务器脏（复用 30s 去抖），不同步 apply。

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::Patch;
use pierwave_domain::{repo, routing};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::outbounds::load_server;

fn default_enabled() -> bool {
    true
}

/// 校验 `outbound_tag`：内置直连/黑洞，或该服务器下真实存在的自定义出站。
async fn validate_outbound_tag(
    state: &AppState,
    server_id: &str,
    outbound_tag: &str,
) -> AppResult<()> {
    let tag = outbound_tag.trim();
    if tag.is_empty() {
        return Err(AppError::coded(
            "routing_rule.outbound_tag_required",
            None,
            "outbound_tag 不能为空",
        ));
    }
    if matches!(tag, "direct" | "blocked") {
        return Ok(());
    }
    let outbounds = repo::outbounds::list_by_server(&state.db.pool, server_id).await?;
    if outbounds.iter().any(|outbound| outbound.tag == tag) {
        Ok(())
    } else {
        Err(AppError::coded(
            "routing_rule.outbound_not_found",
            Some(json!({ "tag": tag })),
            format!("出站 tag「{tag}」不存在"),
        ))
    }
}

/// 校验 `inbound_tag` 指向本服务器上真实存在的节点 tag。
async fn validate_inbound_tag(
    state: &AppState,
    server_id: &str,
    inbound_tag: &str,
) -> AppResult<()> {
    let tag = inbound_tag.trim();
    if tag.is_empty() {
        return Ok(());
    }
    let nodes = repo::nodes::list_by_server(&state.db.pool, server_id).await?;
    if nodes.iter().any(|node| node.tag == tag) {
        Ok(())
    } else {
        Err(AppError::coded(
            "routing_rule.inbound_not_found",
            Some(json!({ "tag": tag })),
            format!("入站节点 tag「{tag}」不存在"),
        ))
    }
}

/// 把 PATCH 的字符串字段规范成三态：空串等同于显式清空。
fn normalize_patch(patch: Patch<String>) -> Patch<String> {
    match patch {
        Patch::Missing => Patch::Missing,
        Patch::Null => Patch::Null,
        Patch::Value(value) => match routing::normalize_condition(Some(&value)) {
            Some(value) => Patch::Value(value),
            None => Patch::Null,
        },
    }
}

/// 计算 PATCH 后的生效值：缺失沿用旧值，null/空串清空。
fn patched_value(current: &Option<String>, patch: &Patch<String>) -> Option<String> {
    match patch {
        Patch::Missing => current.clone(),
        Patch::Null => None,
        Patch::Value(value) => Some(value.clone()),
    }
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(server_id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    load_server(&state, &server_id).await?;
    let items = repo::routing_rules::list_by_server(&state.db.pool, &server_id).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateRoutingRule {
    #[serde(default)]
    pub inbound_tag: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub ip: Option<String>,
    pub outbound_tag: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(server_id): Path<String>,
    Json(req): Json<CreateRoutingRule>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    load_server(&state, &server_id).await?;

    let inbound_tag = routing::normalize_condition(req.inbound_tag.as_deref());
    let domain = routing::normalize_condition(req.domain.as_deref());
    let ip = routing::normalize_condition(req.ip.as_deref());
    routing::validate_rule_match(inbound_tag.as_deref(), domain.as_deref(), ip.as_deref())?;

    let outbound_tag = req.outbound_tag.trim().to_string();
    validate_outbound_tag(&state, &server_id, &outbound_tag).await?;
    if let Some(tag) = &inbound_tag {
        validate_inbound_tag(&state, &server_id, tag).await?;
    }

    let rule = repo::routing_rules::create(
        &state.db.pool,
        &server_id,
        repo::routing_rules::NewRoutingRule {
            sort_order: req.sort_order,
            inbound_tag,
            domain,
            ip,
            outbound_tag,
            enabled: req.enabled,
        },
    )
    .await?;

    crate::audit::record(
        &state,
        &user.0,
        "routing_rule.create",
        &rule.id,
        json!({
            "server_id": &rule.server_id,
            "inbound_tag": &rule.inbound_tag,
            "domain": &rule.domain,
            "ip": &rule.ip,
            "outbound_tag": &rule.outbound_tag,
            "sort_order": rule.sort_order,
        }),
    )
    .await;
    state.enforcement.mark_server_dirty(&server_id);

    Ok(Json(json!({ "rule": rule })))
}

#[derive(Deserialize)]
pub struct PatchRoutingRule {
    #[serde(default)]
    pub inbound_tag: Patch<String>,
    #[serde(default)]
    pub domain: Patch<String>,
    #[serde(default)]
    pub ip: Patch<String>,
    pub outbound_tag: Option<String>,
    pub sort_order: Option<i64>,
    pub enabled: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchRoutingRule>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    if !req.inbound_tag.is_set()
        && !req.domain.is_set()
        && !req.ip.is_set()
        && req.outbound_tag.is_none()
        && req.sort_order.is_none()
        && req.enabled.is_none()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供 inbound_tag / domain / ip / outbound_tag / sort_order / enabled 之一",
        ));
    }

    let existing = repo::routing_rules::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("routing_rule.not_found", None, "资源不存在"))?;

    let inbound_patch = normalize_patch(req.inbound_tag);
    let domain_patch = normalize_patch(req.domain);
    let ip_patch = normalize_patch(req.ip);
    let inbound_tag = patched_value(&existing.inbound_tag, &inbound_patch);
    let domain = patched_value(&existing.domain, &domain_patch);
    let ip = patched_value(&existing.ip, &ip_patch);

    // 清空最后一个匹配条件会让规则变成「全匹配」，必须拦住。
    routing::validate_rule_match(inbound_tag.as_deref(), domain.as_deref(), ip.as_deref())?;

    let outbound_tag = match req.outbound_tag.as_deref() {
        Some(raw) => raw.trim().to_string(),
        None => existing.outbound_tag.clone(),
    };
    validate_outbound_tag(&state, &existing.server_id, &outbound_tag).await?;
    if let Some(tag) = &inbound_tag {
        validate_inbound_tag(&state, &existing.server_id, tag).await?;
    }

    let rule = repo::routing_rules::update(
        &state.db.pool,
        &id,
        repo::routing_rules::UpdateRoutingRule {
            sort_order: req.sort_order,
            inbound_tag: inbound_patch,
            domain: domain_patch,
            ip: ip_patch,
            outbound_tag: Some(outbound_tag),
            enabled: req.enabled,
        },
    )
    .await?
    .ok_or_else(|| AppError::not_found("routing_rule.not_found", None, "资源不存在"))?;

    let changes = crate::audit::diff(vec![
        (
            "inbound_tag",
            json!(&existing.inbound_tag),
            json!(&rule.inbound_tag),
        ),
        ("domain", json!(&existing.domain), json!(&rule.domain)),
        ("ip", json!(&existing.ip), json!(&rule.ip)),
        (
            "outbound_tag",
            json!(&existing.outbound_tag),
            json!(&rule.outbound_tag),
        ),
        (
            "sort_order",
            json!(existing.sort_order),
            json!(rule.sort_order),
        ),
        (
            "enabled",
            json!(existing.enabled != 0),
            json!(rule.enabled != 0),
        ),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "routing_rule.update",
        &rule.id,
        json!({
            "server_id": &rule.server_id,
            "changes": changes,
        }),
    )
    .await;
    state.enforcement.mark_server_dirty(&existing.server_id);

    Ok(Json(json!({ "rule": rule })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let existing = repo::routing_rules::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("routing_rule.not_found", None, "资源不存在"))?;
    if !repo::routing_rules::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found(
            "routing_rule.not_found",
            None,
            "资源不存在",
        ));
    }

    crate::audit::record(
        &state,
        &user.0,
        "routing_rule.delete",
        &id,
        json!({
            "server_id": &existing.server_id,
            "outbound_tag": &existing.outbound_tag,
        }),
    )
    .await;
    state.enforcement.mark_server_dirty(&existing.server_id);

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::Db;
    use pierwave_proto::MasterMessage;

    async fn setup() -> (Router, AppState, String, String) {
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
        let (server, _) = repo::servers::create(&db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        repo::nodes::create(
            &db.pool,
            &server.id,
            repo::nodes::NewNode {
                tag: Some("vless-1".into()),
                name: "香港-01".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "none".into(),
                port: 443,
                public_port: None,
                config_json: "{}".into(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
            server.id,
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

    async fn create_outbound(app: &Router, cookie: &str, server_id: &str) -> String {
        let (status, body) = request(
            app,
            Some(cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/outbounds"),
            Some(json!({"tag": "relay", "protocol": "socks", "config": {"settings": {}}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        body["outbound"]["id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn rule_validation_rejects_empty_and_unknown_targets() {
        let (app, _state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/routing-rules");

        // 三个匹配条件全空：400。
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(json!({"outbound_tag": "direct"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert!(
            value["error"].as_str().unwrap().contains("至少"),
            "unexpected: {value}"
        );

        // outbound_tag 不存在：400。
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(json!({"domain": "geosite:cn", "outbound_tag": "nope"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert!(
            value["error"].as_str().unwrap().contains("不存在"),
            "unexpected: {value}"
        );

        // inbound_tag 指向不存在的节点：400。
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(json!({"inbound_tag": "ghost", "outbound_tag": "direct"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert!(
            value["error"].as_str().unwrap().contains("入站节点"),
            "unexpected: {value}"
        );

        // 合法：内置 direct + 本服务器节点 tag。
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(json!({
                "inbound_tag": "vless-1",
                "domain": "geosite:cn",
                "outbound_tag": "direct"
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["rule"]["inbound_tag"], "vless-1");

        // PATCH 清空最后一个匹配条件同样 400。
        let rule_id = value["rule"]["id"].as_str().unwrap().to_string();
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/routing-rules/{rule_id}"),
            Some(json!({"inbound_tag": null, "domain": ""})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert!(
            value["error"].as_str().unwrap().contains("至少"),
            "unexpected: {value}"
        );
    }

    #[tokio::test]
    async fn deleting_a_referenced_outbound_is_400_with_reference_count() {
        let (app, _state, cookie, server_id) = setup().await;
        let outbound_id = create_outbound(&app, &cookie, &server_id).await;

        let rules_uri = format!("/api/v1/servers/{server_id}/routing-rules");
        for (domain, sort_order) in [("geosite:cn", 0), ("domain:example.com", 10)] {
            let (status, value) = request(
                &app,
                Some(&cookie),
                Method::POST,
                &rules_uri,
                Some(json!({
                    "domain": domain,
                    "outbound_tag": "relay",
                    "sort_order": sort_order
                })),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        }

        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/outbounds/{outbound_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        let message = value["error"].as_str().unwrap();
        assert!(message.contains("2 条路由规则"), "unexpected: {message}");
        assert!(message.contains("引用"), "unexpected: {message}");

        // 被引用时改名也要拦，否则规则会指向旧 tag。
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/outbounds/{outbound_id}"),
            Some(json!({"tag": "relay-2"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert!(
            value["error"].as_str().unwrap().contains("引用"),
            "unexpected: {value}"
        );

        // 停用同样会让规则变悬挂，必须先改规则。
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/outbounds/{outbound_id}"),
            Some(json!({"enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert!(
            value["error"].as_str().unwrap().contains("2 条路由规则"),
            "unexpected: {value}"
        );

        // 删掉两条规则后即可删除出站。
        let (_, list) = request(&app, Some(&cookie), Method::GET, &rules_uri, None).await;
        for rule in list["items"].as_array().unwrap() {
            let id = rule["id"].as_str().unwrap();
            let (status, _) = request(
                &app,
                Some(&cookie),
                Method::DELETE,
                &format!("/api/v1/routing-rules/{id}"),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
        }
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/outbounds/{outbound_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["ok"], true);
    }

    #[tokio::test]
    async fn sort_order_controls_generated_rule_order_after_apply() {
        let (app, state, cookie, server_id) = setup().await;
        create_outbound(&app, &cookie, &server_id).await;
        let rules_uri = format!("/api/v1/servers/{server_id}/routing-rules");

        let (status, first) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &rules_uri,
            Some(json!({
                "domain": "geosite:cn",
                "outbound_tag": "direct",
                "sort_order": 10
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {first}");
        let first_id = first["rule"]["id"].as_str().unwrap().to_string();

        let (status, second) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &rules_uri,
            Some(json!({
                "domain": "geosite:google",
                "outbound_tag": "relay",
                "sort_order": 20
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {second}");
        let second_id = second["rule"]["id"].as_str().unwrap().to_string();

        // 把第二条调到最前：配置里的规则顺序必须跟着变。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/routing-rules/{second_id}"),
            Some(json!({"sort_order": 5})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let mut subscription = state.hub.subscribe(&server_id);
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/apply"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");

        let MasterMessage::Desired(desired) = subscription.receiver.recv().await.unwrap() else {
            panic!("expected desired state");
        };
        let rules = desired.xray["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 3, "api + 两条自定义：{rules:?}");
        assert_eq!(rules[0]["outboundTag"], "api");
        assert_eq!(rules[1]["domain"], json!(["geosite:google"]));
        assert_eq!(rules[2]["domain"], json!(["geosite:cn"]));

        // 自定义出站也在下发的配置里。
        let outbounds = desired.xray["outbounds"].as_array().unwrap();
        assert_eq!(outbounds.len(), 4, "{outbounds:?}");
        assert_eq!(outbounds[3]["tag"], "relay");
        assert_eq!(outbounds[3]["protocol"], "socks");

        // 再验证列表顺序与配置一致（sort_order, created_at）。
        let (_, list) = request(&app, Some(&cookie), Method::GET, &rules_uri, None).await;
        let items = list["items"].as_array().unwrap();
        assert_eq!(items[0]["id"], second_id.as_str());
        assert_eq!(items[1]["id"], first_id.as_str());

        // PATCH 不存在的规则：404。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            "/api/v1/routing-rules/does-not-exist",
            Some(json!({"sort_order": 1})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn routing_rule_apis_require_admin() {
        let (app, state, _admin_cookie, server_id) = setup().await;
        let user = repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: "bob".into(),
                password: "pw".into(),
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
            &format!("/api/v1/servers/{server_id}/routing-rules"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/routing-rules"),
            Some(json!({"domain": "geosite:cn", "outbound_tag": "direct"})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
