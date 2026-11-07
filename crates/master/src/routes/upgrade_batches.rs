//! 批量 Agent 升级接口：只做校验与排队，真正的触发由 [`crate::scheduler`] 的 runner 完成。
//!
//! 批量层不重复实现升级逻辑：每个 item 触发时复用单台接口的
//! [`crate::routes::servers::trigger_single_upgrade`]，状态同步只看
//! `agent_upgrades` 表。

use std::collections::HashSet;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::AgentUpgradeBatch;
use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 单个批次最多包含的服务器数。
pub const MAX_BATCH_SERVERS: usize = 50;
/// `GET /batches` 的默认条数。
pub const DEFAULT_LIST_LIMIT: i64 = 20;

/// 进行中的批次最多再触发单台；创建时把设置里的并发数快照进来。
fn batch_concurrency(settings: &crate::routes::settings::Settings) -> i64 {
    settings.agent_upgrade_concurrency.clamp(
        crate::routes::settings::MIN_AGENT_UPGRADE_CONCURRENCY,
        crate::routes::settings::MAX_AGENT_UPGRADE_CONCURRENCY,
    )
}

#[derive(Deserialize)]
pub struct CreateBatchRequest {
    #[serde(default)]
    pub server_ids: Vec<String>,
    /// 目标版本；缺省/空串 = 最新 Release。
    #[serde(default)]
    pub version: String,
    /// 缺省 = true（遇错即停）。
    #[serde(default)]
    pub stop_on_failure: Option<bool>,
}

async fn load_batch(state: &AppState, id: &str) -> AppResult<AgentUpgradeBatch> {
    repo::upgrade_batches::find_by_id(&state.db.pool, id)
        .await
        .map_err(|error| match error.downcast_ref::<sqlx::Error>() {
            Some(sqlx::Error::RowNotFound) => AppError::NotFound,
            _ => AppError::Internal(error),
        })
}

/// 去空、去重，保持请求里的顺序（runner 按这个顺序执行）。
fn normalize_server_ids(raw: &[String]) -> AppResult<Vec<String>> {
    if raw.len() > MAX_BATCH_SERVERS {
        return Err(AppError::BadRequest(format!(
            "一个批次最多 {MAX_BATCH_SERVERS} 台服务器（当前 {} 台）",
            raw.len()
        )));
    }
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for value in raw {
        let id = value.trim();
        if id.is_empty() {
            return Err(AppError::BadRequest("server_ids 里不能有空值".into()));
        }
        if seen.insert(id.to_string()) {
            ids.push(id.to_string());
        }
    }
    if ids.is_empty() {
        return Err(AppError::BadRequest("server_ids 不能为空".into()));
    }
    if ids.len() > MAX_BATCH_SERVERS {
        return Err(AppError::BadRequest(format!(
            "一个批次最多 {MAX_BATCH_SERVERS} 台服务器（当前 {} 台）",
            ids.len()
        )));
    }
    Ok(ids)
}

/// 创建批次：校验 → 排队；不在请求里触发升级。
pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<CreateBatchRequest>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let server_ids = normalize_server_ids(&req.server_ids)?;

    // 批量只对显式开启升级的服务器生效；未开启的把名字都列出来。
    let mut servers = Vec::with_capacity(server_ids.len());
    let mut missing = Vec::new();
    for id in &server_ids {
        match repo::servers::find_by_id(&state.db.pool, id).await {
            Ok(server) => servers.push(server),
            Err(error)
                if matches!(
                    error.downcast_ref::<sqlx::Error>(),
                    Some(sqlx::Error::RowNotFound)
                ) =>
            {
                missing.push(id.clone());
            }
            Err(error) => return Err(AppError::Internal(error)),
        }
    }
    if !missing.is_empty() {
        return Err(AppError::BadRequest(format!(
            "以下服务器不存在：{}",
            missing.join("、")
        )));
    }

    let disabled: Vec<&str> = servers
        .iter()
        .filter(|server| !server.allow_agent_upgrade)
        .map(|server| server.name.as_str())
        .collect();
    if !disabled.is_empty() {
        return Err(AppError::BadRequest(format!(
            "以下服务器未开启 Agent 自升级（allow_agent_upgrade = false），不能加入批量升级：{}",
            disabled.join("、")
        )));
    }

    // 同一台不能同时出现在两个未终态批次里，否则会重复触发升级。
    let busy: HashSet<String> = repo::upgrade_batches::busy_server_ids(&state.db.pool)
        .await?
        .into_iter()
        .collect();
    let conflicts: Vec<&str> = servers
        .iter()
        .filter(|server| busy.contains(&server.id))
        .map(|server| server.name.as_str())
        .collect();
    if !conflicts.is_empty() {
        return Err(AppError::BadRequest(format!(
            "以下服务器已在进行中的批次里：{}",
            conflicts.join("、")
        )));
    }

    let version = super::servers::resolve_upgrade_version(&state, &req.version).await?;
    let settings = super::settings::load(&state.db.pool).await;
    let concurrency = batch_concurrency(&settings);
    let stop_on_failure = req.stop_on_failure.unwrap_or(true);

    let batch = repo::upgrade_batches::create(
        &state.db.pool,
        &server_ids,
        &version,
        stop_on_failure,
        concurrency,
    )
    .await?;

    crate::audit::record(
        &state,
        &user.0,
        "agent.upgrade.batch",
        &batch.id,
        json!({
            "count": server_ids.len(),
            "version": &batch.to_version,
            "stop_on_failure": batch.stop_on_failure,
            "concurrency": batch.concurrency,
        }),
    )
    .await;

    Ok(Json(json!({ "batch": batch })))
}

#[derive(Deserialize)]
pub struct ListBatchesQuery {
    pub limit: Option<i64>,
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<ListBatchesQuery>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let limit = query.limit.unwrap_or(DEFAULT_LIST_LIMIT);
    let items = repo::upgrade_batches::list(&state.db.pool, limit).await?;
    Ok(Json(json!({ "items": items })))
}

/// 批次详情：items 带 `server_name` 与当前 `agent_version`。
pub async fn detail(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let batch = load_batch(&state, &id).await?;
    let items = repo::upgrade_batches::items(&state.db.pool, &batch.id).await?;
    Ok(Json(json!({ "batch": batch, "items": items })))
}

/// 取消批次：剩余 queued 立即 cancelled；已经在跑的升级不打断，等它自然收敛。
///
/// 如果还有 running item，批次保持 running，由 runner 继续同步；
/// 等最后一个 item 终态时 runner 会把批次收敛为 cancelled。
pub async fn cancel(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let batch = load_batch(&state, &id).await?;
    if batch.status != "running" {
        return Err(AppError::BadRequest(format!(
            "批次已结束（{}），无法取消",
            batch.status
        )));
    }

    let cancelled =
        repo::upgrade_batches::cancel_queued(&state.db.pool, &batch.id, "批次已取消，任务未开始")
            .await?;

    let items = repo::upgrade_batches::items(&state.db.pool, &batch.id).await?;
    let still_running = items.iter().any(|item| item.status == "running");
    if !still_running {
        repo::upgrade_batches::mark(&state.db.pool, &batch.id, "cancelled").await?;
    }

    let batch = repo::upgrade_batches::find_by_id(&state.db.pool, &batch.id).await?;
    Ok(Json(
        json!({ "batch": batch, "cancelled_items": cancelled }),
    ))
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
        let bob = repo::users::create(
            &db.pool,
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
        let (admin_token, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
            .await
            .unwrap();
        let (bob_token, _) = repo::sessions::create(&db.pool, &bob.id, 3600, None)
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={admin_token}", crate::auth::SESSION_COOKIE),
            format!("{}={bob_token}", crate::auth::SESSION_COOKIE),
        )
    }

    async fn seed_server(state: &AppState, name: &str, allow: bool, version: &str) -> String {
        let (server, _token) = repo::servers::create(&state.db.pool, name, "1.2.3.4", "external")
            .await
            .unwrap();
        repo::servers::update(&state.db.pool, &server.id, None, None, None, Some(allow))
            .await
            .unwrap();
        repo::servers::update_health(
            &state.db.pool,
            &server.id,
            version,
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        server.id
    }

    async fn send(
        app: &Router,
        cookie: Option<&str>,
        method: Method,
        uri: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn create_queues_items_and_writes_audit() {
        let (app, state, admin, _bob) = setup().await;
        let hk = seed_server(&state, "hk-1", true, "0.5.0").await;
        let jp = seed_server(&state, "jp-1", true, "0.5.0").await;

        let (status, body) = send(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/agent-upgrades/batches",
            json!({"server_ids": [hk, jp], "version": "0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["batch"]["status"], "running");
        assert_eq!(body["batch"]["to_version"], "0.6.0");
        assert_eq!(body["batch"]["stop_on_failure"], true, "默认遇错即停");
        assert_eq!(body["batch"]["concurrency"], 1, "默认并发 1");
        let batch_id = body["batch"]["id"].as_str().unwrap().to_string();

        let (status, body) = send(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/agent-upgrades/batches?limit=20",
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 1);

        let (status, body) = send(
            &app,
            Some(&admin),
            Method::GET,
            &format!("/api/v1/agent-upgrades/batches/{batch_id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["server_id"], hk);
        assert_eq!(items[0]["server_name"], "hk-1");
        assert_eq!(items[0]["agent_version"], "0.5.0");
        assert_eq!(items[0]["status"], "queued");

        // 审计：action 与 count/version 必须都在。
        let logs = repo::audit::list(&state.db.pool, 10).await.unwrap();
        let log = logs
            .iter()
            .find(|entry| entry.action == "agent.upgrade.batch")
            .expect("批次创建必须写审计");
        let detail = log.detail.as_ref().expect("审计 detail 必须是 JSON");
        assert_eq!(detail["count"], 2);
        assert_eq!(detail["version"], "0.6.0");
    }

    #[tokio::test]
    async fn create_rejects_servers_without_upgrade_permission() {
        let (app, state, admin, _bob) = setup().await;
        let ok = seed_server(&state, "ok-1", true, "0.5.0").await;
        let locked = seed_server(&state, "locked-1", false, "0.5.0").await;

        let (status, body) = send(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/agent-upgrades/batches",
            json!({"server_ids": [ok, locked], "version": "0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let message = body["error"].as_str().unwrap();
        assert!(message.contains("未开启"), "{message}");
        assert!(message.contains("locked-1"), "必须指出是哪台：{message}");
    }

    #[tokio::test]
    async fn create_rejects_empty_oversized_and_busy_servers() {
        let (app, state, admin, _bob) = setup().await;
        let hk = seed_server(&state, "hk-1", true, "0.5.0").await;

        let (status, body) = send(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/agent-upgrades/batches",
            json!({"server_ids": [], "version": "0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

        let too_many: Vec<String> = (0..=MAX_BATCH_SERVERS)
            .map(|index| format!("server-{index}"))
            .collect();
        let (status, body) = send(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/agent-upgrades/batches",
            json!({"server_ids": too_many, "version": "0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"].as_str().unwrap().contains("最多"), "{body}");

        // 先占住 hk-1，再提交一次同一台。
        let (status, body) = send(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/agent-upgrades/batches",
            json!({"server_ids": [hk.clone()], "version": "0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let (status, body) = send(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/agent-upgrades/batches",
            json!({"server_ids": [hk], "version": "0.7.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(
            body["error"].as_str().unwrap().contains("进行中的批次"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn cancel_marks_queued_and_keeps_running_item() {
        let (app, state, admin, _bob) = setup().await;
        let first = seed_server(&state, "hk-1", true, "0.5.0").await;
        let second = seed_server(&state, "jp-1", true, "0.5.0").await;

        let (status, body) = send(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/agent-upgrades/batches",
            json!({"server_ids": [first.clone(), second.clone()], "version": "0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let batch_id = body["batch"]["id"].as_str().unwrap().to_string();

        // 模拟 runner 已经触发了第一台。
        let upgrade = repo::agent_upgrades::create(&state.db.pool, &first, "0.5.0", "0.6.0")
            .await
            .unwrap();
        repo::upgrade_batches::start_item(&state.db.pool, &batch_id, &first, &upgrade.id)
            .await
            .unwrap();

        let (status, body) = send(
            &app,
            Some(&admin),
            Method::POST,
            &format!("/api/v1/agent-upgrades/batches/{batch_id}/cancel"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["cancelled_items"], 1);
        assert_eq!(
            body["batch"]["status"], "running",
            "还有运行中的 item，批次不能提前结束"
        );

        let items = repo::upgrade_batches::items(&state.db.pool, &batch_id)
            .await
            .unwrap();
        assert_eq!(items[0].status, "running", "运行中的升级不能被打断");
        assert_eq!(items[1].status, "cancelled");
    }

    #[tokio::test]
    async fn detail_and_cancel_reject_unknown_batch() {
        let (app, _state, admin, _bob) = setup().await;
        let (status, _) = send(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/agent-upgrades/batches/nope",
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, _) = send(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/agent-upgrades/batches/nope/cancel",
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn batch_endpoints_require_admin() {
        let (app, state, admin, bob) = setup().await;
        let hk = seed_server(&state, "hk-1", true, "0.5.0").await;

        let (status, _) = send(
            &app,
            Some(&bob),
            Method::GET,
            "/api/v1/agent-upgrades/batches",
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = send(
            &app,
            Some(&bob),
            Method::POST,
            "/api/v1/agent-upgrades/batches",
            json!({"server_ids": [hk], "version": "0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, body) = send(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/agent-upgrades/batches",
            json!({"server_ids": [hk], "version": "0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
}
