//! 线性多跳链管理（管理员）。
//!
//! 契约：`GET/POST /api/v1/chains`、`PATCH/DELETE /api/v1/chains/{id}`。
//!
//! 链本身不在 Agent 侧存在：主控把一条链推导成每台服务器上的若干
//! `DesiredForward`，复用既有转发通道。推导函数 [`derive_forwards`] 是纯函数，
//! 输入是「按 seq 排好序的跳 + 链目标」，输出 `(server_id, DesiredForward)`。
//!
//! 健康状态不属于链配置：它来自 Agent 心跳写入的 `forward_status`，按
//! `chain-<chain_id>-<seq>` 合并进跳视图；连续 2 次 `target_ok=false` 才算降级。

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::{ChainHopWithServer, ChainWithHops, ForwardStatusRow, Server};
use pierwave_domain::{chains, forwards, repo};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use pierwave_proto::DesiredForward;

/// 一条已通过校验的跳：带上服务器地址，供冲突提示与推导使用。
struct ValidatedHop {
    server_id: String,
    server_address: String,
    listen_port: i64,
}

/// 纯推导：第 i 跳的目标 = 第 i+1 跳服务器的 `address:listen_port`；
/// 最后一跳的目标 = 链的 `target_host:target_port`。
///
/// 单跳链因此就是「入口直接指向 target」，和独立单跳转发行为一致。
/// `seq` 用于稳定 id：`chain-<chain_id>-<seq>`，重复渲染不会让 Agent 重建监听。
pub(crate) fn derive_forwards(
    chain_id: &str,
    target_host: &str,
    target_port: i64,
    hops: &[ChainHopWithServer],
) -> Vec<(String, DesiredForward)> {
    // 按 seq 排序后再串联，调用方即使传入乱序也不会把 target 接错。
    let mut ordered: Vec<&ChainHopWithServer> = hops.iter().collect();
    ordered.sort_by_key(|hop| hop.seq);

    ordered
        .iter()
        .enumerate()
        .map(|(index, hop)| {
            let (next_host, next_port) = match ordered.get(index + 1) {
                Some(next) => (next.server_address.clone(), next.listen_port),
                None => (target_host.to_string(), target_port),
            };
            (
                hop.server_id.clone(),
                DesiredForward {
                    id: chains::forward_id(chain_id, hop.seq),
                    listen_port: hop.listen_port,
                    target_host: next_host,
                    target_port: next_port,
                },
            )
        })
        .collect()
}

fn default_enabled() -> bool {
    true
}

#[derive(Deserialize)]
pub struct CreateChainHop {
    #[serde(default)]
    pub server_id: String,
    pub listen_port: i64,
}

#[derive(Deserialize)]
pub struct CreateChain {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub target_host: String,
    pub target_port: i64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub hops: Vec<CreateChainHop>,
}

#[derive(Deserialize)]
pub struct PatchChain {
    pub name: Option<String>,
    pub target_host: Option<String>,
    pub target_port: Option<i64>,
    pub enabled: Option<bool>,
    /// `None` = 不改跳；`Some` = 整体替换。
    pub hops: Option<Vec<CreateChainHop>>,
}

async fn load_server_for_hop(state: &AppState, server_id: &str) -> AppResult<Server> {
    repo::servers::find_by_id(&state.db.pool, server_id)
        .await
        .map_err(|error| match error.downcast_ref::<sqlx::Error>() {
            Some(sqlx::Error::RowNotFound) => {
                AppError::not_found("server.not_found", None, "服务器不存在")
            }
            _ => AppError::Internal(error),
        })
}

/// 校验跳列表：数量、重复服务器、端口范围/保留端口，以及与该服务器上
/// 节点 / 独立转发 / 其它链跳的端口冲突。
async fn resolve_hops(
    state: &AppState,
    inputs: &[CreateChainHop],
    exclude_chain_id: Option<&str>,
) -> AppResult<Vec<ValidatedHop>> {
    chains::validate_hop_count(inputs.len())?;

    let server_ids: Vec<String> = inputs
        .iter()
        .map(|hop| hop.server_id.trim().to_string())
        .collect();
    chains::ensure_unique_servers(&server_ids)?;

    let mut hops = Vec::with_capacity(inputs.len());
    for input in inputs {
        forwards::validate_listen_port(input.listen_port)?;
        forwards::ensure_port_not_reserved(input.listen_port)?;

        let server = load_server_for_hop(state, input.server_id.trim()).await?;
        if let Some(node) =
            repo::nodes::find_by_port(&state.db.pool, &server.id, input.listen_port).await?
        {
            return Err(AppError::coded(
                "forward.port_conflict_node",
                Some(json!({
                    "port": input.listen_port,
                    "node": node.name,
                    "node_id": node.id,
                    "node_tag": node.tag,
                    "server_id": server.id,
                    "server_name": server.name,
                })),
                format!(
                    "监听端口 {} 与服务器「{}」上的节点「{}」（tag {}）冲突",
                    input.listen_port, server.name, node.name, node.tag
                ),
            ));
        }
        if let Some(forward) =
            repo::forwards::find_by_listen_port(&state.db.pool, &server.id, input.listen_port, None)
                .await?
        {
            return Err(AppError::coded(
                "forward.port_conflict_forward",
                Some(json!({
                    "port": input.listen_port,
                    "name": forward.name,
                    "id": forward.id,
                    "server_id": server.id,
                    "server_name": server.name,
                })),
                format!(
                    "监听端口 {} 已被服务器「{}」上的转发规则「{}」占用",
                    input.listen_port, server.name, forward.name
                ),
            ));
        }
        if let Some(conflict) = repo::chains::find_hop_port_conflict(
            &state.db.pool,
            &server.id,
            input.listen_port,
            exclude_chain_id,
        )
        .await?
        {
            return Err(AppError::coded(
                "chain.port_conflict_hop",
                Some(json!({
                    "port": input.listen_port,
                    "chain_id": conflict.chain_id,
                    "name": conflict.chain_name,
                    "seq": conflict.seq,
                    "server_id": server.id,
                    "server_name": server.name,
                })),
                format!(
                    "监听端口 {} 已被服务器「{}」上的链「{}」第 {} 跳占用",
                    input.listen_port,
                    server.name,
                    conflict.chain_name,
                    conflict.seq + 1
                ),
            ));
        }

        hops.push(ValidatedHop {
            server_id: server.id,
            server_address: server.address,
            listen_port: input.listen_port,
        });
    }
    Ok(hops)
}

/// 自连回环检查：每一跳的目标（下一跳 address:port 或最终 target）都不能
/// 指回本跳的监听端口。
fn ensure_targets_safe(
    hops: &[ValidatedHop],
    target_host: &str,
    target_port: i64,
) -> AppResult<()> {
    for (index, hop) in hops.iter().enumerate() {
        let (next_host, next_port) = match hops.get(index + 1) {
            Some(next) => (next.server_address.as_str(), next.listen_port),
            None => (target_host, target_port),
        };
        forwards::ensure_not_self_loop("0.0.0.0", hop.listen_port, next_host, next_port)?;
    }
    Ok(())
}

fn new_hops(hops: &[ValidatedHop]) -> Vec<repo::chains::NewChainHop> {
    hops.iter()
        .map(|hop| repo::chains::NewChainHop {
            server_id: hop.server_id.clone(),
            listen_port: hop.listen_port,
        })
        .collect()
}

/// 链写操作后要立即下发到「所有受影响的服务器」：旧跳服务器也要，否则
/// PATCH 删掉一跳后，那台机器上的转发会一直留到下一次对账。
async fn mark_servers_dirty_and_apply(state: &AppState, base_url: &str, server_ids: &[String]) {
    let mut seen = HashSet::new();
    for server_id in server_ids {
        if !seen.insert(server_id.as_str()) {
            continue;
        }
        match super::forwards::load_server(state, server_id).await {
            Ok(server) => {
                super::forwards::mark_dirty_and_apply(state, &server, base_url).await;
            }
            Err(error) => tracing::warn!(
                server_id = %server_id,
                error = %error,
                "链已保存，但加载服务器失败，跳过立即下发（已标脏，稍后重试）"
            ),
        }
    }
}

fn hop_server_ids(chain: &ChainWithHops) -> Vec<String> {
    chain.hops.iter().map(|hop| hop.server_id.clone()).collect()
}

async fn load_status_map(
    state: &AppState,
    chains_list: &[ChainWithHops],
) -> AppResult<HashMap<String, ForwardStatusRow>> {
    let mut map = HashMap::new();
    let mut seen = HashSet::new();
    for chain in chains_list {
        for hop in &chain.hops {
            if !seen.insert(hop.server_id.clone()) {
                continue;
            }
            for row in repo::forwards::list_status_by_server(&state.db.pool, &hop.server_id).await?
            {
                map.insert(row.forward_id.clone(), row);
            }
        }
    }
    Ok(map)
}

/// 链视图：配置 + 每跳的运行状态（监听、目标可达、是否降级）。
fn chain_json(chain: &ChainWithHops, statuses: &HashMap<String, ForwardStatusRow>) -> Value {
    let mut hop_views = Vec::with_capacity(chain.hops.len());
    let mut degraded = false;
    for hop in &chain.hops {
        let forward_id = chains::forward_id(&chain.chain.id, hop.seq);
        let status = statuses.get(&forward_id);
        let hop_degraded = status.is_some_and(|row| chains::is_degraded(row.target_fail_count));
        degraded |= hop_degraded;
        hop_views.push(json!({
            "seq": hop.seq,
            "server_id": hop.server_id,
            "server_name": hop.server_name,
            "listen_port": hop.listen_port,
            // 监听成功与目标可达是两件事：端口绑上了，目标仍可能不可达。
            "listening": status.map(|row| row.listening),
            "target_ok": status.and_then(|row| row.target_ok),
            "degraded": hop_degraded,
            "error": status.map(|row| row.error.as_str()).unwrap_or(""),
            "updated_at": status.map(|row| row.updated_at),
        }));
    }

    json!({
        "id": chain.chain.id,
        "name": chain.chain.name,
        "target_host": chain.chain.target_host,
        "target_port": chain.chain.target_port,
        "enabled": chain.chain.enabled,
        "degraded": degraded,
        "hops": hop_views,
        "created_at": chain.chain.created_at,
        "updated_at": chain.chain.updated_at,
    })
}

/// 指定服务器参与的链的整体降级状态：`chain_id -> (链名, 是否降级)`。
///
/// 心跳处理用它在 `save_status` 前后各算一次，只有 false → true 的跃迁才告警，
/// 避免同一条降级链每 15 秒刷一次通知。状态本身不落库：`forward_status`
/// 才是事实来源，链视图每次现算。
pub(crate) async fn degradation_for_server(
    state: &AppState,
    server_id: &str,
) -> AppResult<HashMap<String, (String, bool)>> {
    let chains_list: Vec<ChainWithHops> = repo::chains::list(&state.db.pool)
        .await?
        .into_iter()
        .filter(|chain| chain.hops.iter().any(|hop| hop.server_id == server_id))
        .collect();
    if chains_list.is_empty() {
        return Ok(HashMap::new());
    }
    let statuses = load_status_map(state, &chains_list).await?;
    let mut result = HashMap::with_capacity(chains_list.len());
    for chain in chains_list {
        let degraded = chain.hops.iter().any(|hop| {
            let forward_id = chains::forward_id(&chain.chain.id, hop.seq);
            statuses
                .get(&forward_id)
                .is_some_and(|row| chains::is_degraded(row.target_fail_count))
        });
        result.insert(chain.chain.id, (chain.chain.name, degraded));
    }
    Ok(result)
}

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let chains_list = repo::chains::list(&state.db.pool).await?;
    let statuses = load_status_map(&state, &chains_list).await?;
    let items: Vec<Value> = chains_list
        .iter()
        .map(|chain| chain_json(chain, &statuses))
        .collect();
    Ok(Json(json!({ "items": items })))
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Json(req): Json<CreateChain>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let name = chains::normalize_name(&req.name)?;
    let target_host = forwards::normalize_target_host(&req.target_host)?;
    forwards::validate_target_port(req.target_port)?;
    let hops = resolve_hops(&state, &req.hops, None).await?;
    ensure_targets_safe(&hops, &target_host, req.target_port)?;

    let chain = repo::chains::create(
        &state.db.pool,
        repo::chains::NewChain {
            name,
            target_host,
            target_port: req.target_port,
            enabled: req.enabled,
            hops: new_hops(&hops),
        },
    )
    .await?;

    crate::audit::record(
        &state,
        &user.0,
        "chain.create",
        &chain.chain.id,
        json!({
            "name": &chain.chain.name,
            "target_host": &chain.chain.target_host,
            "target_port": chain.chain.target_port,
            "enabled": chain.chain.enabled,
            "hops": chain.hops.iter().map(|hop| json!({
                "seq": hop.seq,
                "server_id": &hop.server_id,
                "listen_port": hop.listen_port,
            })).collect::<Vec<_>>(),
        }),
    )
    .await;

    let base = super::install::external_base(&headers);
    mark_servers_dirty_and_apply(&state, &base, &hop_server_ids(&chain)).await;

    let statuses = load_status_map(&state, std::slice::from_ref(&chain)).await?;
    Ok(Json(json!({ "chain": chain_json(&chain, &statuses) })))
}

pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchChain>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    if req.name.is_none()
        && req.target_host.is_none()
        && req.target_port.is_none()
        && req.enabled.is_none()
        && req.hops.is_none()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供 name / target_host / target_port / enabled / hops 之一",
        ));
    }

    let existing = repo::chains::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("chain.not_found", None, "链不存在"))?;

    let name = match req.name.as_deref() {
        Some(raw) => Some(chains::normalize_name(raw)?),
        None => None,
    };
    let target_host = match req.target_host.as_deref() {
        Some(raw) => Some(forwards::normalize_target_host(raw)?),
        None => None,
    };
    if let Some(port) = req.target_port {
        forwards::validate_target_port(port)?;
    }
    let final_target_host = target_host
        .as_deref()
        .unwrap_or(&existing.chain.target_host);
    let final_target_port = req.target_port.unwrap_or(existing.chain.target_port);

    let replace_hops = req.hops.is_some();
    let hops = match req.hops.as_deref() {
        Some(inputs) => resolve_hops(&state, inputs, Some(&existing.chain.id)).await?,
        None => existing
            .hops
            .iter()
            .map(|hop| ValidatedHop {
                server_id: hop.server_id.clone(),
                server_address: hop.server_address.clone(),
                listen_port: hop.listen_port,
            })
            .collect(),
    };
    ensure_targets_safe(&hops, final_target_host, final_target_port)?;

    let updated = repo::chains::update(
        &state.db.pool,
        &id,
        repo::chains::UpdateChain {
            name,
            target_host,
            target_port: req.target_port,
            enabled: req.enabled,
            hops: replace_hops.then(|| new_hops(&hops)),
        },
    )
    .await?
    .ok_or_else(|| AppError::not_found("chain.not_found", None, "链不存在"))?;

    let changes = crate::audit::diff(vec![
        (
            "name",
            json!(&existing.chain.name),
            json!(&updated.chain.name),
        ),
        (
            "target_host",
            json!(&existing.chain.target_host),
            json!(&updated.chain.target_host),
        ),
        (
            "target_port",
            json!(existing.chain.target_port),
            json!(updated.chain.target_port),
        ),
        (
            "enabled",
            json!(existing.chain.enabled),
            json!(updated.chain.enabled),
        ),
        (
            "hops",
            json!(existing.hops.len()),
            json!(updated.hops.len()),
        ),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "chain.update",
        &updated.chain.id,
        json!({
            "name": &updated.chain.name,
            "changes": changes,
        }),
    )
    .await;

    let mut affected = hop_server_ids(&existing);
    affected.extend(hop_server_ids(&updated));
    let base = super::install::external_base(&headers);
    mark_servers_dirty_and_apply(&state, &base, &affected).await;

    let statuses = load_status_map(&state, std::slice::from_ref(&updated)).await?;
    Ok(Json(json!({ "chain": chain_json(&updated, &statuses) })))
}

pub async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let existing = repo::chains::find_by_id(&state.db.pool, &id)
        .await?
        .ok_or_else(|| AppError::not_found("chain.not_found", None, "链不存在"))?;
    if !repo::chains::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found("chain.not_found", None, "链不存在"));
    }

    crate::audit::record(
        &state,
        &user.0,
        "chain.delete",
        &id,
        json!({
            "name": &existing.chain.name,
            "target_host": &existing.chain.target_host,
            "target_port": existing.chain.target_port,
        }),
    )
    .await;

    let base = super::install::external_base(&headers);
    mark_servers_dirty_and_apply(&state, &base, &hop_server_ids(&existing)).await;

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::models::Chain;
    use pierwave_domain::Db;

    struct Fixture {
        app: Router,
        state: AppState,
        cookie: String,
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
            cookie: format!("{}={token}", crate::auth::SESSION_COOKIE),
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

    fn chain_body(name: &str, target_host: &str, target_port: i64, hops: &[(&str, i64)]) -> Value {
        json!({
            "name": name,
            "target_host": target_host,
            "target_port": target_port,
            "hops": hops
                .iter()
                .map(|(server_id, port)| json!({
                    "server_id": server_id,
                    "listen_port": port,
                }))
                .collect::<Vec<_>>(),
        })
    }

    async fn add_node(state: &AppState, server_id: &str, port: i64) {
        repo::nodes::create(
            &state.db.pool,
            server_id,
            repo::nodes::NewNode {
                tag: None,
                name: "已有节点".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "none".into(),
                port,
                config_json: "{}".into(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();
    }

    fn test_chain(id: &str) -> Chain {
        Chain {
            id: id.into(),
            name: "测试链".into(),
            target_host: "1.1.1.1".into(),
            target_port: 443,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn test_hop(
        chain_id: &str,
        seq: i64,
        server_id: &str,
        address: &str,
        listen_port: i64,
    ) -> ChainHopWithServer {
        ChainHopWithServer {
            chain_id: chain_id.into(),
            seq,
            server_id: server_id.into(),
            server_name: format!("server-{server_id}"),
            server_address: address.into(),
            listen_port,
        }
    }

    /// 单跳链：入口直接指向 target，与独立单跳转发行为一致。
    #[test]
    fn derives_single_hop_chain_to_target() {
        let chain = test_chain("c1");
        let hops = vec![test_hop("c1", 0, "srv-a", "10.0.0.1", 9001)];

        let derived = derive_forwards(&chain.id, &chain.target_host, chain.target_port, &hops);
        assert_eq!(
            derived,
            vec![(
                "srv-a".to_string(),
                DesiredForward {
                    id: "chain-c1-0".into(),
                    listen_port: 9001,
                    target_host: "1.1.1.1".into(),
                    target_port: 443,
                }
            )]
        );
    }

    /// 两跳链：第一跳指向第二跳服务器的 address + listen_port，最后一跳指向 target。
    #[test]
    fn derives_two_hop_chain_to_next_server_address() {
        let chain = test_chain("c2");
        let hops = vec![
            test_hop("c2", 0, "srv-a", "10.0.0.1", 9001),
            test_hop("c2", 1, "srv-b", "10.0.0.2", 9002),
        ];

        let derived = derive_forwards(&chain.id, &chain.target_host, chain.target_port, &hops);
        assert_eq!(derived.len(), 2);
        assert_eq!(derived[0].0, "srv-a");
        assert_eq!(derived[0].1.id, "chain-c2-0");
        assert_eq!(derived[0].1.listen_port, 9001);
        assert_eq!(derived[0].1.target_host, "10.0.0.2");
        assert_eq!(derived[0].1.target_port, 9002);
        assert_eq!(derived[1].0, "srv-b");
        assert_eq!(derived[1].1.id, "chain-c2-1");
        assert_eq!(derived[1].1.listen_port, 9002);
        assert_eq!(derived[1].1.target_host, "1.1.1.1");
        assert_eq!(derived[1].1.target_port, 443);
    }

    /// 三跳链：中间每跳都指向下一跳，最后一跳才落到 target。
    #[test]
    fn derives_three_hop_chain_to_next_server_address() {
        let chain = test_chain("c3");
        let hops = vec![
            test_hop("c3", 0, "srv-a", "10.0.0.1", 9001),
            test_hop("c3", 1, "srv-b", "10.0.0.2", 9002),
            test_hop("c3", 2, "srv-c", "10.0.0.3", 9003),
        ];

        let derived = derive_forwards(&chain.id, &chain.target_host, chain.target_port, &hops);
        assert_eq!(derived.len(), 3);
        for (index, (server_id, forward)) in derived.iter().enumerate() {
            assert_eq!(server_id, &format!("srv-{}", ["a", "b", "c"][index]));
            assert_eq!(forward.id, format!("chain-c3-{index}"));
            assert_eq!(forward.listen_port, [9001, 9002, 9003][index]);
        }
        assert_eq!(derived[0].1.target_host, "10.0.0.2");
        assert_eq!(derived[0].1.target_port, 9002);
        assert_eq!(derived[1].1.target_host, "10.0.0.3");
        assert_eq!(derived[1].1.target_port, 9003);
        assert_eq!(derived[2].1.target_host, "1.1.1.1");
        assert_eq!(derived[2].1.target_port, 443);
    }

    /// 校验：重复服务器、超过 4 跳、非法目标、节点/转发/其它链的端口冲突。
    #[tokio::test]
    async fn validation_rejects_bad_hops_targets_and_port_conflicts() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        // 0 跳 / 5 跳。
        for body in [
            chain_body("空链", "1.1.1.1", 443, &[]),
            chain_body(
                "太长",
                "1.1.1.1",
                443,
                &[
                    (fixture.a.as_str(), 8001),
                    (fixture.a.as_str(), 8002),
                    (fixture.a.as_str(), 8003),
                    (fixture.a.as_str(), 8004),
                    (fixture.a.as_str(), 8005),
                ],
            ),
        ] {
            let (status, value) = request(
                &fixture.app,
                Some(&fixture.cookie),
                Method::POST,
                uri,
                Some(body),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
            assert_eq!(value["code"], "chain.hop_count_invalid");
        }

        // 同一台服务器出现两次。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "重复服务器",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 8001), (fixture.a.as_str(), 8002)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.duplicate_server");

        // 目标非法：空地址 / 端口越界。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "空目标",
                "   ",
                443,
                &[(fixture.a.as_str(), 8001)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.target_host_required");

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "目标端口非法",
                "1.1.1.1",
                0,
                &[(fixture.a.as_str(), 8001)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.target_port_invalid");

        // 与节点端口冲突。
        add_node(&fixture.state, &fixture.a, 443).await;
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "撞节点",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 443)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.port_conflict_node");

        // 与独立转发冲突。
        repo::forwards::create(
            &fixture.state.db.pool,
            &fixture.a,
            repo::forwards::NewForward {
                name: "独立转发".into(),
                listen_port: 8443,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: true,
            },
        )
        .await
        .unwrap();
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "撞转发",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 8443)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.port_conflict_forward");

        // 与另一条链的跳冲突。
        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "第一条链",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 9443)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "第二条链",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 9443)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "chain.port_conflict_hop");
    }

    /// CRUD + 运行时健康：目标连续失败两次才降级，恢复即清除。
    #[tokio::test]
    async fn crud_and_health_expose_target_ok_and_degraded() {
        let fixture = setup().await;
        let uri = "/api/v1/chains";

        let (status, value) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::POST,
            uri,
            Some(chain_body(
                "港-日",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 9001), (fixture.b.as_str(), 9002)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let chain = &value["chain"];
        let chain_id = chain["id"].as_str().unwrap().to_string();
        assert_eq!(chain["name"], "港-日");
        assert_eq!(chain["target_host"], "1.1.1.1");
        assert_eq!(chain["target_port"], 443);
        assert_eq!(chain["enabled"], true);
        assert_eq!(chain["degraded"], false);
        assert_eq!(chain["hops"].as_array().unwrap().len(), 2);
        assert_eq!(chain["hops"][0]["seq"], 0);
        assert_eq!(chain["hops"][0]["server_id"], fixture.a.as_str());
        assert_eq!(chain["hops"][0]["server_name"], "hk-a");
        assert_eq!(chain["hops"][0]["listen_port"], 9001);
        assert_eq!(chain["hops"][1]["seq"], 1);
        assert_eq!(chain["hops"][1]["server_name"], "jp-b");
        assert_eq!(chain["hops"][1]["listen_port"], 9002);
        assert!(chain["hops"][0]["target_ok"].is_null(), "还没探测时是 null");

        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(body["items"].as_array().unwrap().len(), 1);

        let hop_id = chains::forward_id(&chain_id, 0);
        let save = |target_ok: Option<bool>, listening: bool| {
            let pool = fixture.state.db.pool.clone();
            let server_id = fixture.a.clone();
            let forward_id = hop_id.clone();
            async move {
                repo::forwards::save_status(
                    &pool,
                    &server_id,
                    &[repo::forwards::NewForwardStatus {
                        forward_id,
                        listening,
                        error: String::new(),
                        target_ok,
                    }],
                )
                .await
                .unwrap();
            }
        };

        // 第一次 false：不降级。
        save(Some(false), true).await;
        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        let hop = &body["items"][0]["hops"][0];
        assert_eq!(hop["target_ok"], false);
        assert_eq!(hop["listening"], true, "监听成功与目标可达是两件事");
        assert_eq!(hop["degraded"], false);
        assert_eq!(body["items"][0]["degraded"], false);

        // 第二次 false：跳与链都降级。
        save(Some(false), true).await;
        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(body["items"][0]["hops"][0]["degraded"], true);
        assert_eq!(body["items"][0]["degraded"], true);

        // 恢复：降级立刻清除。
        save(Some(true), true).await;
        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert_eq!(body["items"][0]["hops"][0]["target_ok"], true);
        assert_eq!(body["items"][0]["hops"][0]["degraded"], false);
        assert_eq!(body["items"][0]["degraded"], false);

        // PATCH：改名 + 停用。
        let chain_uri = format!("/api/v1/chains/{chain_id}");
        let (status, body) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::PATCH,
            &chain_uri,
            Some(json!({"name": "港-日-新", "enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["chain"]["name"], "港-日-新");
        assert_eq!(body["chain"]["enabled"], false);

        // 停用后不再进入期望态。
        let server_a = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.a)
            .await
            .unwrap();
        let rendered =
            super::super::desired::render(&fixture.state, &server_a, "https://panel.example.com")
                .await
                .unwrap();
        assert!(rendered.forwards.is_empty(), "停用的链不能下发任何跳");

        // 删除后列表清空，链推导的状态行也一并清掉。
        let (status, body) = request(
            &fixture.app,
            Some(&fixture.cookie),
            Method::DELETE,
            &chain_uri,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["ok"], true);
        assert!(repo::chains::find_by_id(&fixture.state.db.pool, &chain_id)
            .await
            .unwrap()
            .is_none());
        assert!(
            repo::forwards::list_status_by_server(&fixture.state.db.pool, &fixture.a)
                .await
                .unwrap()
                .is_empty(),
            "删除链要清掉它推导出的 forward_status 行"
        );

        let (_, body) = request(&fixture.app, Some(&fixture.cookie), Method::GET, uri, None).await;
        assert!(body["items"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn chains_require_admin() {
        let fixture = setup().await;
        let user = repo::users::create(
            &fixture.state.db.pool,
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
        let (token, _) = repo::sessions::create(&fixture.state.db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);

        let (status, _) = request(
            &fixture.app,
            Some(&cookie),
            Method::GET,
            "/api/v1/chains",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = request(
            &fixture.app,
            Some(&cookie),
            Method::POST,
            "/api/v1/chains",
            Some(chain_body(
                "无权限",
                "1.1.1.1",
                443,
                &[(fixture.a.as_str(), 9001)],
            )),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
