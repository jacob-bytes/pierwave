//! 自定义出站管理（管理员）。
//!
//! 契约见 `docs/PLAN.md` P3：
//! * `tag` / `protocol` / `config` 在这里校验，仓储只负责落库；
//! * 写成功后只把对应服务器标记为脏（复用 30s 去抖），不同步 apply；
//! * 删除或改名仍被路由规则引用的出站返回 400，并说明被几条规则引用。

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::Server;
use pierwave_domain::{repo, routing};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 取服务器；不存在时统一转成 404，避免 SQLx 的 RowNotFound 泄漏成 500。
pub(crate) async fn load_server(state: &AppState, id: &str) -> AppResult<Server> {
    repo::servers::find_by_id(&state.db.pool, id)
        .await
        .map_err(|e| match e.downcast_ref::<sqlx::Error>() {
            Some(sqlx::Error::RowNotFound) => {
                AppError::not_found("server.not_found", None, "资源不存在")
            }
            _ => AppError::Internal(e),
        })
}

/// 并发下仍可能撞 `UNIQUE(server_id, tag)`：翻译成 400 中文而不是 500。
fn map_tag_conflict(error: anyhow::Error) -> AppError {
    let message = format!("{error:#}");
    if message.contains("UNIQUE constraint failed: server_outbounds") {
        AppError::coded(
            "outbound.tag_conflict",
            None,
            "该服务器下已存在相同的出站 tag",
        )
    } else {
        AppError::Internal(error)
    }
}

fn default_config() -> Value {
    json!({})
}

fn default_enabled() -> bool {
    true
}

fn ensure_referenced_outbound_can_change(references: i64, action: &str) -> AppResult<()> {
    if references > 0 {
        // `action` 用稳定 token，前端词典据此选择「删除 / 停用 / 改名」的动词。
        let what = match action {
            "delete" => "删除",
            "disable" => "停用",
            "rename" => "修改 tag",
            _ => "修改",
        };
        return Err(AppError::coded(
            "outbound.in_use",
            Some(json!({ "references": references, "action": action })),
            format!("该出站被 {references} 条路由规则引用，无法{what}"),
        ));
    }
    Ok(())
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(server_id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    load_server(&state, &server_id).await?;
    let items = repo::outbounds::list_by_server(&state.db.pool, &server_id).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateOutbound {
    pub tag: String,
    pub protocol: String,
    #[serde(default = "default_config")]
    pub config: Value,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(server_id): Path<String>,
    Json(req): Json<CreateOutbound>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    load_server(&state, &server_id).await?;

    let tag = routing::normalize_tag(&req.tag)?;
    let protocol = routing::normalize_protocol(&req.protocol)?;
    routing::ensure_config_object(&req.config)?;

    let outbound = repo::outbounds::create(
        &state.db.pool,
        &server_id,
        repo::outbounds::NewOutbound {
            tag,
            protocol,
            config_json: req.config.to_string(),
            enabled: req.enabled,
        },
    )
    .await
    .map_err(map_tag_conflict)?;

    // config 可能含中转账号密码，审计只记元数据。
    crate::audit::record(
        &state,
        &user.0,
        "outbound.create",
        &outbound.id,
        json!({
            "server_id": &outbound.server_id,
            "tag": &outbound.tag,
            "protocol": &outbound.protocol,
            "enabled": outbound.enabled != 0,
        }),
    )
    .await;
    state.enforcement.mark_server_dirty(&server_id);

    Ok(Json(json!({ "outbound": outbound })))
}

#[derive(Deserialize)]
pub struct PatchOutbound {
    pub tag: Option<String>,
    pub protocol: Option<String>,
    pub config: Option<Value>,
    pub enabled: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchOutbound>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    if req.tag.is_none() && req.protocol.is_none() && req.config.is_none() && req.enabled.is_none()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供 tag / protocol / config / enabled 之一",
        ));
    }

    let existing = repo::outbounds::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("outbound.not_found", None, "资源不存在"))?;

    let tag = match req.tag.as_deref() {
        Some(raw) => Some(routing::normalize_tag(raw)?),
        None => None,
    };
    let protocol = match req.protocol.as_deref() {
        Some(raw) => Some(routing::normalize_protocol(raw)?),
        None => None,
    };
    if let Some(config) = &req.config {
        routing::ensure_config_object(config)?;
    }

    // 改名会让已有规则指向旧 tag，和删除一样先拦下来并说明引用数。
    if let Some(new_tag) = &tag {
        if *new_tag != existing.tag {
            let references = repo::routing_rules::count_by_outbound(
                &state.db.pool,
                &existing.server_id,
                &existing.tag,
            )
            .await?;
            ensure_referenced_outbound_can_change(references, "rename")?;
        }
    }

    // 停用后出站不再进入配置，引用它的规则会变成悬挂引用（Xray 会拒载整份配置）。
    // 想停用先删/改规则；这里和删除一样给出引用数。
    if req.enabled == Some(false) && existing.enabled != 0 {
        let references = repo::routing_rules::count_by_outbound(
            &state.db.pool,
            &existing.server_id,
            &existing.tag,
        )
        .await?;
        ensure_referenced_outbound_can_change(references, "disable")?;
    }

    let config_changed = req.config.is_some();
    let outbound = repo::outbounds::update(
        &state.db.pool,
        &id,
        repo::outbounds::UpdateOutbound {
            tag,
            protocol,
            config_json: req.config.map(|config| config.to_string()),
            enabled: req.enabled,
        },
    )
    .await
    .map_err(map_tag_conflict)?
    .ok_or_else(|| AppError::not_found("outbound.not_found", None, "资源不存在"))?;

    let changes = crate::audit::diff(vec![
        ("tag", json!(&existing.tag), json!(&outbound.tag)),
        (
            "protocol",
            json!(&existing.protocol),
            json!(&outbound.protocol),
        ),
        (
            "enabled",
            json!(existing.enabled != 0),
            json!(outbound.enabled != 0),
        ),
        ("config", json!(false), json!(config_changed)),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "outbound.update",
        &outbound.id,
        json!({
            "server_id": &outbound.server_id,
            "tag": &outbound.tag,
            "changes": changes,
        }),
    )
    .await;
    state.enforcement.mark_server_dirty(&existing.server_id);

    Ok(Json(json!({ "outbound": outbound })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let existing = repo::outbounds::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("outbound.not_found", None, "资源不存在"))?;
    // 先给业务提示，避免规则里留下悬挂的 outboundTag。
    let references =
        repo::routing_rules::count_by_outbound(&state.db.pool, &existing.server_id, &existing.tag)
            .await?;
    ensure_referenced_outbound_can_change(references, "delete")?;

    if !repo::outbounds::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found(
            "outbound.not_found",
            None,
            "资源不存在",
        ));
    }

    crate::audit::record(
        &state,
        &user.0,
        "outbound.delete",
        &id,
        json!({
            "server_id": &existing.server_id,
            "tag": &existing.tag,
            "protocol": &existing.protocol,
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

    fn socks() -> Value {
        json!({
            "tag": "relay",
            "protocol": "socks",
            "config": {
                "settings": {
                    "servers": [{"address": "10.0.0.2", "port": 1080}]
                }
            }
        })
    }

    #[tokio::test]
    async fn outbound_crud_flow() {
        let (app, state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/outbounds");

        let (status, body) = request(&app, Some(&cookie), Method::POST, &uri, Some(socks())).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let outbound = &body["outbound"];
        let id = outbound["id"].as_str().unwrap().to_string();
        assert_eq!(outbound["tag"], "relay");
        assert_eq!(outbound["protocol"], "socks");
        assert_eq!(outbound["server_id"], server_id.as_str());
        assert_eq!(outbound["enabled"], 1);
        assert_eq!(
            outbound["config"]["settings"]["servers"][0]["address"],
            "10.0.0.2"
        );

        let (status, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 1);
        assert_eq!(body["items"][0]["id"], id.as_str());

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/outbounds/{id}"),
            Some(json!({"enabled": false, "config": {"settings": {}}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["outbound"]["enabled"], 0);
        assert_eq!(body["outbound"]["config"], json!({"settings": {}}));

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/outbounds/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["ok"], true);

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/outbounds/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // 写操作只标脏、不同步 apply：config_version 必须保持 0。
        assert_eq!(
            repo::servers::find_by_id(&state.db.pool, &server_id)
                .await
                .unwrap()
                .config_version,
            0
        );
    }

    #[tokio::test]
    async fn duplicate_tag_reserved_tag_and_bad_protocol_are_400() {
        let (app, _state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/outbounds");

        let (status, _) = request(&app, Some(&cookie), Method::POST, &uri, Some(socks())).await;
        assert_eq!(status, StatusCode::OK);

        let cases = [
            (socks(), "已存在", "outbound.tag_conflict"),
            (
                json!({"tag": "direct", "protocol": "freedom"}),
                "保留字",
                "outbound.tag_reserved",
            ),
            (
                json!({"tag": "blocked", "protocol": "blackhole"}),
                "保留字",
                "outbound.tag_reserved",
            ),
            (
                json!({"tag": "api", "protocol": "freedom"}),
                "保留字",
                "outbound.tag_reserved",
            ),
            (
                json!({"tag": "Upper", "protocol": "socks"}),
                "小写字母",
                "outbound.tag_invalid",
            ),
            (
                json!({"tag": "relay-2", "protocol": "wireguard"}),
                "不支持",
                "outbound.protocol_invalid",
            ),
            (
                json!({"tag": "relay-3", "protocol": "socks", "config": []}),
                "JSON 对象",
                "outbound.config_invalid",
            ),
        ];
        for (body, expected, code) in cases {
            let (status, value) =
                request(&app, Some(&cookie), Method::POST, &uri, Some(body.clone())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "body={body} value={value}");
            assert!(
                value["error"].as_str().unwrap().contains(expected),
                "body={body} value={value}"
            );
            assert_eq!(value["code"], code, "body={body} value={value}");
        }

        // PATCH 同样走 tag / protocol / config 校验。
        let (_, list) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        let id = list["items"][0]["id"].as_str().unwrap().to_string();
        let uri = format!("/api/v1/outbounds/{id}");
        for (body, expected, code) in [
            (json!({"tag": "direct"}), "保留字", "outbound.tag_reserved"),
            (
                json!({"protocol": "wireguard"}),
                "不支持",
                "outbound.protocol_invalid",
            ),
            (
                json!({"config": "not-an-object"}),
                "JSON 对象",
                "outbound.config_invalid",
            ),
        ] {
            let (status, value) =
                request(&app, Some(&cookie), Method::PATCH, &uri, Some(body.clone())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "body={body} value={value}");
            assert!(
                value["error"].as_str().unwrap().contains(expected),
                "body={body} value={value}"
            );
            assert_eq!(value["code"], code, "body={body} value={value}");
        }
    }

    #[tokio::test]
    async fn outbound_apis_require_admin() {
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
            &format!("/api/v1/servers/{server_id}/outbounds"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/outbounds"),
            Some(socks()),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
