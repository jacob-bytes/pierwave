//! 单跳端口转发管理（管理员；协议支持 tcp / udp / both）。
//!
//! 契约：`GET/POST /api/v1/servers/{id}/forwards`、`PATCH/DELETE /api/v1/forwards/{id}`。
//!
//! * 字段校验（端口范围、目标地址、保留端口）走 `pierwave_domain::forwards`；
//! * 端口冲突需要查库：同服务器内的节点端口、其它转发端口；
//! * 每次写操作都标脏并立即下发一次，转发规则不必等 30 秒去抖；
//! * 运行时状态来自 Agent 心跳缓存（`forward_status`），列表里合并成 `runtime`。

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::{Server, UserForwardView};
use pierwave_domain::port_policy::PortPolicy;
use pierwave_domain::{engine, forwards, protocol, repo};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

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

async fn load_forward(state: &AppState, id: &str) -> AppResult<pierwave_domain::models::Forward> {
    repo::forwards::find_by_id(&state.db.pool, id)
        .await?
        .ok_or_else(|| AppError::not_found("forward.not_found", None, "资源不存在"))
}

/// 并发下仍可能撞 `UNIQUE(server_id, listen_port)`：翻译成 400 中文而不是 500。
fn map_port_conflict(error: anyhow::Error, port: i64, name: &str) -> AppError {
    let message = format!("{error:#}");
    if message.contains("UNIQUE constraint failed: forwards.server_id, forwards.listen_port") {
        AppError::coded(
            "forward.port_conflict_forward",
            Some(json!({ "port": port, "name": name })),
            format!("监听端口 {port} 已被其它转发规则占用"),
        )
    } else {
        AppError::Internal(error)
    }
}

/// tunnel 引擎必须带链上下文（hop_id / 证书 / 对端），独立转发表没有这些字段。
fn ensure_tunnel_not_standalone(engine_name: &str) -> AppResult<()> {
    if !engine::is_tunnel(engine_name) {
        return Ok(());
    }
    Err(AppError::coded(
        "forward.tunnel_requires_chain",
        Some(json!({ "engine": engine::TUNNEL })),
        "tunnel 引擎只能用于链，不能创建独立转发",
    ))
}

/// nftables 规则只能保存到「明确支持 nftables」的服务器。
///
/// 旧 Agent 收到 `engine = nftables` 会因为不认识的枚举值导致整份期望态解析失败，
/// 所以这里必须在写路径挡住；未知能力（离线 / 旧 Agent）也按不支持处理。
fn ensure_nftables_supported(server: &Server, engine_name: &str) -> AppResult<()> {
    if !engine::is_nftables(engine_name) || server.nftables_available == Some(true) {
        return Ok(());
    }
    let (code, message) = if server.nftables_available == Some(false) {
        (
            "forward.nftables_unavailable",
            format!(
                "服务器「{}」没有可用的 nftables（需要安装 nft 并以 root 运行）",
                server.name
            ),
        )
    } else {
        (
            "forward.nftables_unavailable",
            format!(
                "服务器「{}」尚未上报 nftables 能力，请等 Agent 上线后重试",
                server.name
            ),
        )
    };
    Err(AppError::coded(
        code,
        Some(json!({
            "server_id": server.id,
            "server_name": server.name,
            "available": server.nftables_available,
        })),
        message,
    ))
}

/// 同一服务器内的端口占用检查，顺序固定：
/// 1. 节点端口（含停用节点）；
/// 2. 其它转发规则（含停用规则）。
///
/// 保留端口在调用前已单独检查，所以这里不会把 22 / 10085 误报成「被节点占用」。
async fn ensure_port_available(
    state: &AppState,
    server_id: &str,
    listen_port: i64,
    exclude_forward_id: Option<&str>,
) -> AppResult<()> {
    if let Some(node) = repo::nodes::find_by_port(&state.db.pool, server_id, listen_port).await? {
        return Err(AppError::coded(
            "forward.port_conflict_node",
            Some(json!({
                "port": listen_port,
                "node": node.name,
                "node_id": node.id,
                "node_tag": node.tag,
            })),
            format!(
                "监听端口 {listen_port} 与节点「{}」（tag {}）的端口冲突",
                node.name, node.tag
            ),
        ));
    }
    if let Some(forward) = repo::forwards::find_by_listen_port(
        &state.db.pool,
        server_id,
        listen_port,
        exclude_forward_id,
    )
    .await?
    {
        return Err(AppError::coded(
            "forward.port_conflict_forward",
            Some(json!({
                "port": listen_port,
                "name": forward.name,
                "id": forward.id,
            })),
            format!(
                "监听端口 {listen_port} 已被转发规则「{}」占用",
                forward.name
            ),
        ));
    }
    Ok(())
}

/// 标脏 + 立即下发一次。
///
/// 立即下发失败不回滚已保存的规则：脏标记还在，后台对账稍后会重试。
pub(crate) async fn mark_dirty_and_apply(state: &AppState, server: &Server, base_url: &str) {
    state.enforcement.mark_server_dirty(&server.id);
    if let Err(error) = super::desired::apply(state, server, base_url).await {
        tracing::warn!(
            server = %server.name,
            error = %error,
            "转发规则已保存，但立即下发失败（已标脏，稍后重试）"
        );
    }
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(server_id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let server = load_server(&state, &server_id).await?;
    let mut items = repo::forwards::list_with_status(&state.db.pool, &server_id).await?;
    // 已保存的仅 UDP 规则遇到旧 Agent：列表直接标 blocked，并与下发路径同样跳过。
    for item in &mut items {
        if let Err(error) = protocol::ensure_forward_agent_supported(
            &item.forward.protocol,
            server.protocol_version,
            &server.name,
        ) {
            item.blocked_code = Some(error.code.to_string());
            item.blocked_reason = Some(error.message);
        }
    }
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateForward {
    /// 缺省为空串，交给统一校验返回 400 而不是 422。
    #[serde(default)]
    pub name: String,
    pub listen_port: i64,
    #[serde(default)]
    pub target_host: String,
    pub target_port: i64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// `native` / `realm` / `nftables`；缺省 = `native`（与迁移默认值一致）。
    #[serde(default)]
    pub engine: Option<String>,
    /// 是否把流量计入创建者套餐；缺省 `false`。
    ///
    /// 管理员创建的规则没有 `owner_user_id`，置 `true` 也不会计费；
    /// 这里开放字段是为了让全局 PATCH 能改用户规则。
    #[serde(default)]
    pub count_traffic: bool,
    /// 监听协议：`tcp`（缺省）/ `udp` / `both`。
    ///
    /// 不传时由旧 `udp` 布尔位推导（`true` → `both`），保证升级前的客户端
    /// 继续按原语义工作。
    #[serde(default)]
    pub protocol: Option<String>,
    /// 旧字段：是否同时监听同端口的 UDP；仅在没传 `protocol` 时生效。
    #[serde(default)]
    pub udp: bool,
}

fn default_enabled() -> bool {
    true
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(server_id): Path<String>,
    Json(req): Json<CreateForward>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let server = load_server(&state, &server_id).await?;

    let name = forwards::normalize_name(&req.name)?;
    let target_host = forwards::normalize_target_host(&req.target_host)?;
    forwards::validate_listen_port(req.listen_port)?;
    forwards::validate_target_port(req.target_port)?;
    forwards::ensure_port_not_reserved(req.listen_port)?;
    forwards::ensure_not_self_loop("0.0.0.0", req.listen_port, &target_host, req.target_port)?;
    ensure_port_available(&state, &server_id, req.listen_port, None).await?;
    let engine = match req.engine.as_deref() {
        Some(raw) => engine::normalize(raw)?,
        None => engine::DEFAULT.to_string(),
    };
    let protocol = match req.protocol.as_deref() {
        Some(raw) => protocol::normalize_forward(raw)?,
        None => protocol::from_legacy_udp(req.udp).to_string(),
    };
    protocol::ensure_realm_supported(&protocol, &engine)?;
    // 仅 UDP 从协议 16 开始支持；旧 Agent 会忽略 protocol 只监听 TCP，必须 400。
    protocol::ensure_forward_agent_supported(&protocol, server.protocol_version, &server.name)?;
    ensure_nftables_supported(&server, &engine)?;
    ensure_tunnel_not_standalone(&engine)?;

    let forward_name_for_error = name.clone();
    let forward = repo::forwards::create(
        &state.db.pool,
        &server_id,
        repo::forwards::NewForward {
            name,
            listen_port: req.listen_port,
            target_host,
            target_port: req.target_port,
            enabled: req.enabled,
            count_traffic: req.count_traffic,
            engine,
            protocol,
        },
    )
    .await
    .map_err(|error| map_port_conflict(error, req.listen_port, &forward_name_for_error))?;

    crate::audit::record(
        &state,
        &user.0,
        "forward.create",
        &forward.id,
        json!({
            "server_id": &forward.server_id,
            "name": &forward.name,
            "listen_port": forward.listen_port,
            "target_host": &forward.target_host,
            "target_port": forward.target_port,
            "enabled": forward.enabled,
            "count_traffic": forward.count_traffic,
            "engine": &forward.engine,
            "protocol": &forward.protocol,
            "udp": forward.udp,
        }),
    )
    .await;

    let base = super::install::external_base(&headers);
    mark_dirty_and_apply(&state, &server, &base).await;

    Ok(Json(json!({ "forward": forward })))
}

#[derive(Deserialize)]
pub struct PatchForward {
    pub name: Option<String>,
    pub listen_port: Option<i64>,
    pub target_host: Option<String>,
    pub target_port: Option<i64>,
    pub enabled: Option<bool>,
    /// 是否把流量计入创建者套餐；`None` = 不改。
    pub count_traffic: Option<bool>,
    /// `native` / `realm` / `nftables`；`None` = 不改。
    pub engine: Option<String>,
    /// `tcp` / `udp` / `both`；`None` = 不改。
    pub protocol: Option<String>,
    /// 旧字段：`None` = 不改；`Some(true)` → `both`、`Some(false)` → `tcp`。
    /// 同时传 `protocol` 时以 `protocol` 为准。
    pub udp: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchForward>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    if req.name.is_none()
        && req.listen_port.is_none()
        && req.target_host.is_none()
        && req.target_port.is_none()
        && req.enabled.is_none()
        && req.count_traffic.is_none()
        && req.engine.is_none()
        && req.protocol.is_none()
        && req.udp.is_none()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供 name / listen_port / target_host / target_port / enabled / count_traffic / engine / protocol / udp 之一",
        ));
    }

    let existing = load_forward(&state, &id).await?;
    let server = load_server(&state, &existing.server_id).await?;

    let name = match req.name.as_deref() {
        Some(raw) => Some(forwards::normalize_name(raw)?),
        None => None,
    };
    let target_host = match req.target_host.as_deref() {
        Some(raw) => Some(forwards::normalize_target_host(raw)?),
        None => None,
    };
    let engine = match req.engine.as_deref() {
        Some(raw) => Some(engine::normalize(raw)?),
        None => None,
    };
    let protocol = match req.protocol.as_deref() {
        Some(raw) => Some(protocol::normalize_forward(raw)?),
        None => req
            .udp
            .map(|udp| protocol::from_legacy_udp(udp).to_string()),
    };
    let final_engine = engine.as_deref().unwrap_or(&existing.engine);
    let final_protocol = protocol.as_deref().unwrap_or(&existing.protocol);
    protocol::ensure_realm_supported(final_protocol, final_engine)?;
    // 只有请求明确把协议改成 udp 时才要求新版 Agent；历史 udp 规则仍允许
    // 改名 / 停用 / 删除，渲染层按同一规则跳过而不是把用户锁死。
    if protocol.is_some() {
        protocol::ensure_forward_agent_supported(
            final_protocol,
            server.protocol_version,
            &server.name,
        )?;
    }
    ensure_nftables_supported(&server, final_engine)?;
    ensure_tunnel_not_standalone(final_engine)?;
    if let Some(port) = req.target_port {
        forwards::validate_target_port(port)?;
    }
    if let Some(port) = req.listen_port {
        forwards::validate_listen_port(port)?;
        forwards::ensure_port_not_reserved(port)?;
        // 端口没变就不必重新查冲突：否则节点后来占用了该端口时，
        // 连「只改目标地址」都会被卡住。端口变化才需要重新校验。
        if port != existing.listen_port {
            ensure_port_available(&state, &existing.server_id, port, Some(&existing.id)).await?;
        }
        // 端口或目标任一变化都要重新查自连，否则「先把目标改成自己」能绕过创建时的检查
        forwards::ensure_not_self_loop(
            "0.0.0.0",
            port,
            req.target_host.as_deref().unwrap_or(&existing.target_host),
            req.target_port.unwrap_or(existing.target_port),
        )?;
    }

    // 并发撞唯一约束时也要能给出规则名；name 马上会被 move 进 UpdateForward。
    let conflict_name = name.as_deref().unwrap_or(&existing.name).to_string();
    let forward = repo::forwards::update(
        &state.db.pool,
        &id,
        repo::forwards::UpdateForward {
            name,
            listen_port: req.listen_port,
            target_host,
            target_port: req.target_port,
            enabled: req.enabled,
            count_traffic: req.count_traffic,
            engine,
            protocol,
        },
    )
    .await
    .map_err(|error| {
        map_port_conflict(
            error,
            req.listen_port.unwrap_or(existing.listen_port),
            &conflict_name,
        )
    })?
    .ok_or_else(|| AppError::not_found("forward.not_found", None, "资源不存在"))?;

    let changes = crate::audit::diff(vec![
        ("name", json!(&existing.name), json!(&forward.name)),
        (
            "listen_port",
            json!(existing.listen_port),
            json!(forward.listen_port),
        ),
        (
            "target_host",
            json!(&existing.target_host),
            json!(&forward.target_host),
        ),
        (
            "target_port",
            json!(existing.target_port),
            json!(forward.target_port),
        ),
        ("enabled", json!(existing.enabled), json!(forward.enabled)),
        (
            "count_traffic",
            json!(existing.count_traffic),
            json!(forward.count_traffic),
        ),
        ("engine", json!(&existing.engine), json!(&forward.engine)),
        (
            "protocol",
            json!(&existing.protocol),
            json!(&forward.protocol),
        ),
        ("udp", json!(existing.udp), json!(forward.udp)),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "forward.update",
        &forward.id,
        json!({
            "server_id": &forward.server_id,
            "name": &forward.name,
            "changes": changes,
        }),
    )
    .await;

    // 计费开关从关到开：把基线对齐到当前计数，避免补记关闭期间的流量。
    if forward.count_traffic && !existing.count_traffic {
        if let Err(error) =
            repo::forwards::reset_traffic_baseline(&state.db.pool, &forward.id).await
        {
            tracing::warn!("重置转发计费基线失败: {error}");
        }
    }

    let base = super::install::external_base(&headers);
    mark_dirty_and_apply(&state, &server, &base).await;

    Ok(Json(json!({ "forward": forward })))
}

pub async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let existing = load_forward(&state, &id).await?;
    if !repo::forwards::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found("forward.not_found", None, "资源不存在"));
    }

    crate::audit::record(
        &state,
        &user.0,
        "forward.delete",
        &id,
        json!({
            "server_id": &existing.server_id,
            "name": &existing.name,
            "listen_port": existing.listen_port,
            "target_host": &existing.target_host,
            "target_port": existing.target_port,
            "engine": &existing.engine,
            "udp": existing.udp,
        }),
    )
    .await;

    let server = load_server(&state, &existing.server_id).await?;
    let base = super::install::external_base(&headers);
    mark_dirty_and_apply(&state, &server, &base).await;

    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// 用户自助转发：`/api/v1/me/forwards`
//
// 与管理端共用同一套校验/端口分配/下发实现，只多了三件事：
// 1. 身份只来自会话，绝不接受请求里的 user_id；
// 2. 额度与服务器白名单每次现查套餐（不缓存）；
// 3. 监听端口由服务器端口策略自动分配，用户不能指定。
// ---------------------------------------------------------------------------

fn quota_error(limit: i64, used: i64) -> AppError {
    let limit = limit.max(0);
    let message = if limit == 0 {
        "当前套餐没有开通自助转发配额".to_string()
    } else {
        format!("转发规则数量已达套餐上限（{used}/{limit}）")
    };
    AppError::coded(
        "me.forward_quota_exceeded",
        Some(json!({ "limit": limit, "used": used })),
        message,
    )
}

/// 取一条属于当前用户的转发；不属于自己时按「不存在」处理。
///
/// 用 404 而不是 403：否则可以靠错误码枚举出别人转发 id 是否存在。
async fn load_owned_forward(
    state: &AppState,
    owner_user_id: &str,
    id: &str,
) -> AppResult<pierwave_domain::models::Forward> {
    match repo::forwards::find_by_id(&state.db.pool, id).await? {
        Some(forward) if forward.owner_user_id.as_deref() == Some(owner_user_id) => Ok(forward),
        _ => Err(AppError::not_found(
            "me.forward_not_found",
            None,
            "转发规则不存在",
        )),
    }
}

/// 按服务器端口策略自动分配一个空闲端口。
///
/// 复用链的分配器（[`PortPolicy::allocate`]）：不限制时用 20000-29999 池，
/// 有限制时只在「区间 ∪ 额外端口」里挑。保留端口（API 10085 / SSH 22）与
/// 回环目标端口会先并入占用集合，避免刚分到就撞门禁。
async fn allocate_user_port(
    state: &AppState,
    server: &Server,
    target_host: &str,
    target_port: i64,
) -> AppResult<i64> {
    let policy = PortPolicy::from_server(server);
    let mut occupied =
        repo::chains::occupied_listen_ports(&state.db.pool, &server.id, None).await?;
    occupied.extend(forwards::RESERVED_PORTS.iter().copied());
    if forwards::is_loopback_host(target_host) {
        occupied.insert(target_port);
    }
    let listen_port = policy.allocate(&server.id, &server.name, &occupied)?;
    forwards::ensure_port_not_reserved(listen_port)?;
    forwards::ensure_not_self_loop("0.0.0.0", listen_port, target_host, target_port)?;
    Ok(listen_port)
}

/// 用户自己的转发列表：只按 `owner_user_id = 会话用户` 过滤。
pub async fn me_list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    let allowance =
        repo::packages::forward_allowance(&state.db.pool, &user.0.id, repo::now()).await?;
    let used = repo::forwards::count_by_owner(&state.db.pool, &user.0.id).await?;
    let servers: HashMap<String, Server> = repo::servers::list(&state.db.pool)
        .await?
        .into_iter()
        .map(|server| (server.id.clone(), server))
        .collect();

    let mut items = Vec::new();
    for forward in repo::forwards::list_by_owner(&state.db.pool, &user.0.id).await? {
        // 外键 ON DELETE CASCADE 保证服务器一定还在；真出现脏数据时跳过，
        // 不让一条孤立行把整页变成 500。
        let Some(server) = servers.get(&forward.server_id) else {
            tracing::warn!(
                forward_id = %forward.id,
                server_id = %forward.server_id,
                "用户转发的服务器不存在，已跳过"
            );
            continue;
        };
        let mut view = UserForwardView::new(forward, server);
        // 与管理员列表同口径：仅 UDP 遇到旧 Agent 时标 blocked。
        if let Err(error) = protocol::ensure_forward_agent_supported(
            &view.forward.protocol,
            server.protocol_version,
            &server.name,
        ) {
            view.blocked_code = Some(error.code.to_string());
            view.blocked_reason = Some(error.message);
        }
        items.push(view);
    }

    Ok(Json(json!({
        "items": items,
        "quota": { "limit": allowance.limit, "used": used },
    })))
}

#[derive(Deserialize)]
pub struct CreateUserForward {
    #[serde(default)]
    pub server_id: String,
    #[serde(default)]
    pub target_host: String,
    pub target_port: i64,
    /// `tcp`（缺省）/ `both`；`udp` 仍受 Agent 能力门禁约束。
    ///
    /// 有意不接受 `listen_port` / `engine` / `name`：端口由服务端分配，
    /// 引擎固定 native，名称由目标自动生成。
    #[serde(default)]
    pub protocol: Option<String>,
}

pub async fn me_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Json(req): Json<CreateUserForward>,
) -> AppResult<Json<Value>> {
    let server = load_server(&state, &req.server_id).await?;
    let allowance =
        repo::packages::forward_allowance(&state.db.pool, &user.0.id, repo::now()).await?;
    let used = repo::forwards::count_by_owner(&state.db.pool, &user.0.id).await?;

    // 顺序：完全没配额 → 400；有配额但服务器不在白名单 → 403；
    // 白名单通过但已满 → 400。两种失败原因不混在一条文案里。
    if allowance.limit <= 0 {
        return Err(quota_error(allowance.limit, used));
    }
    if !allowance.allows_server(&server.id) {
        return Err(AppError::forbidden(
            "me.forward_server_not_allowed",
            Some(json!({
                "server_id": &server.id,
                "server_name": &server.name,
            })),
            format!("当前套餐不允许在服务器「{}」上创建转发", server.name),
        ));
    }
    if used >= allowance.limit {
        return Err(quota_error(allowance.limit, used));
    }

    let target_host = forwards::normalize_target_host(&req.target_host)?;
    forwards::validate_target_port(req.target_port)?;
    let protocol = match req.protocol.as_deref() {
        Some(raw) => protocol::normalize_forward(raw)?,
        None => protocol::DEFAULT.to_string(),
    };
    protocol::ensure_forward_agent_supported(&protocol, server.protocol_version, &server.name)?;

    let listen_port = allocate_user_port(&state, &server, &target_host, req.target_port).await?;
    let name = forwards::default_owner_name(&target_host, req.target_port);
    let conflict_name = name.clone();
    let forward = repo::forwards::create_owned(
        &state.db.pool,
        &server.id,
        repo::forwards::NewForward {
            name,
            listen_port,
            target_host,
            target_port: req.target_port,
            enabled: true,
            // 用户自助转发默认计费；之后可以在列表里单独关掉。
            count_traffic: true,
            engine: engine::DEFAULT.to_string(),
            protocol,
        },
        &user.0.id,
        allowance.limit,
    )
    .await
    .map_err(|error| match AppError::from_domain_chain(&error) {
        // 并发下配额可能刚好被另一条请求抢走：仍按 400 返回，不能变成 500。
        Some(domain) => domain,
        None => map_port_conflict(error, listen_port, &conflict_name),
    })?;
    crate::audit::record(
        &state,
        &user.0,
        "user_forward.create",
        &forward.id,
        json!({
            // 只放 id 与规则事实，不放用户名/邮箱等隐私字段。
            "forward_id": &forward.id,
            "server_id": &forward.server_id,
            "server_name": &server.name,
            "listen_port": forward.listen_port,
            "target_host": &forward.target_host,
            "target_port": forward.target_port,
            "protocol": &forward.protocol,
        }),
    )
    .await;

    let base = super::install::external_base(&headers);
    mark_dirty_and_apply(&state, &server, &base).await;

    let used_after = repo::forwards::count_by_owner(&state.db.pool, &user.0.id).await?;
    Ok(Json(json!({
        "forward": UserForwardView::new(forward, &server),
        "quota": { "limit": allowance.limit, "used": used_after },
    })))
}

#[derive(Deserialize)]
pub struct PatchUserForward {
    pub enabled: Option<bool>,
    /// 是否把这条转发的流量计入自己的套餐；`None` = 不改。
    pub count_traffic: Option<bool>,
}

/// 用户只能改自己的启用状态与计费开关；目标/端口/协议一律不开放。
pub async fn me_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchUserForward>,
) -> AppResult<Json<Value>> {
    if req.enabled.is_none() && req.count_traffic.is_none() {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供 enabled / count_traffic 之一",
        ));
    }

    let existing = load_owned_forward(&state, &user.0.id, &id).await?;
    let server = load_server(&state, &existing.server_id).await?;
    let forward = repo::forwards::update(
        &state.db.pool,
        &id,
        repo::forwards::UpdateForward {
            enabled: req.enabled,
            count_traffic: req.count_traffic,
            ..Default::default()
        },
    )
    .await?
    .ok_or_else(|| AppError::not_found("me.forward_not_found", None, "转发规则不存在"))?;

    // 关 → 开：对齐基线，避免补记关闭期间的流量。
    if forward.count_traffic && !existing.count_traffic {
        if let Err(error) = repo::forwards::reset_traffic_baseline(&state.db.pool, &id).await {
            tracing::warn!(%id, %error, "重置转发计费基线失败");
        }
    }

    let base = super::install::external_base(&headers);
    mark_dirty_and_apply(&state, &server, &base).await;

    Ok(Json(json!({
        "forward": UserForwardView::new(forward, &server),
    })))
}

pub async fn me_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let existing = load_owned_forward(&state, &user.0.id, &id).await?;
    if !repo::forwards::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found(
            "me.forward_not_found",
            None,
            "转发规则不存在",
        ));
    }

    crate::audit::record(
        &state,
        &user.0,
        "user_forward.delete",
        &existing.id,
        json!({
            "forward_id": &existing.id,
            "server_id": &existing.server_id,
            "listen_port": existing.listen_port,
            "target_host": &existing.target_host,
            "target_port": existing.target_port,
            "protocol": &existing.protocol,
        }),
    )
    .await;

    let server = load_server(&state, &existing.server_id).await?;
    let base = super::install::external_base(&headers);
    mark_dirty_and_apply(&state, &server, &base).await;

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    use pierwave_domain::Db;
    use pierwave_proto::{DesiredForward, MasterMessage};

    #[test]
    fn domain_udp_min_protocol_version_matches_wire_constant() {
        assert_eq!(
            protocol::UDP_MIN_PROTOCOL_VERSION as u32,
            pierwave_proto::UDP_PROTOCOL_VERSION,
            "领域层门禁与线协议常量必须一致"
        );
    }

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

    async fn add_node(state: &AppState, server_id: &str, port: i64) -> String {
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
                public_port: None,
                config_json: "{}".into(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    fn forward_body(listen_port: i64) -> Value {
        json!({
            "name": "香港中转",
            "listen_port": listen_port,
            "target_host": "10.0.0.8",
            "target_port": 443,
        })
    }

    async fn next_forwards(
        receiver: &mut broadcast::Receiver<MasterMessage>,
    ) -> Vec<DesiredForward> {
        let message = tokio::time::timeout(Duration::from_secs(3), receiver.recv())
            .await
            .expect("写操作应立即下发一次期望态")
            .expect("hub 不应关闭");
        match message {
            MasterMessage::Desired(desired) => desired.forwards,
            other => panic!("expected desired state, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn crud_roundtrip_and_immediate_desired_state() {
        let (app, state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");
        let mut subscription = state.hub.subscribe(&server_id);

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let forward = &body["forward"];
        let id = forward["id"].as_str().unwrap().to_string();
        assert_eq!(forward["name"], "香港中转");
        assert_eq!(forward["listen_port"], 8443);
        assert_eq!(forward["target_host"], "10.0.0.8");
        assert_eq!(forward["target_port"], 443);
        assert_eq!(forward["enabled"], true);
        assert_eq!(forward["server_id"], server_id.as_str());

        // 创建后立即下发：规则必须在期望态里。
        let sent = next_forwards(&mut subscription.receiver).await;
        assert_eq!(sent.len(), 1, "创建后应下发这条转发");
        assert_eq!(sent[0].id, pierwave_domain::forwards::desired_id(&id));
        assert_eq!(sent[0].listen_port, 8443);
        assert_eq!(sent[0].target_host, "10.0.0.8");
        assert_eq!(sent[0].target_port, 443);

        // 列表：没有心跳时 runtime 为 null。
        let (status, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 1);
        assert_eq!(body["items"][0]["id"], id.as_str());
        assert_eq!(body["items"][0]["runtime"], Value::Null);

        // 改端口/目标：旧规则从期望态消失，新规则出现。
        let forward_uri = format!("/api/v1/forwards/{id}");
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &forward_uri,
            Some(json!({
                "listen_port": 9443,
                "target_host": "10.0.0.9",
                "target_port": 8443,
                "name": "香港中转-2",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["listen_port"], 9443);
        assert_eq!(body["forward"]["target_host"], "10.0.0.9");
        assert_eq!(body["forward"]["target_port"], 8443);
        assert_eq!(body["forward"]["name"], "香港中转-2");

        let sent = next_forwards(&mut subscription.receiver).await;
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].id, pierwave_domain::forwards::desired_id(&id));
        assert_eq!(sent[0].listen_port, 9443);
        assert_eq!(sent[0].target_host, "10.0.0.9");
        assert_eq!(sent[0].target_port, 8443);

        // 停用后不再下发。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &forward_uri,
            Some(json!({"enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["enabled"], false);
        assert!(
            next_forwards(&mut subscription.receiver).await.is_empty(),
            "停用的转发不能出现在期望态里"
        );

        // 删除：列表清空，期望态也不再包含它。
        let (status, body) = request(&app, Some(&cookie), Method::DELETE, &forward_uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["ok"], true);

        let (status, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert!(body["items"].as_array().unwrap().is_empty());
        assert!(
            next_forwards(&mut subscription.receiver).await.is_empty(),
            "删除后期望态里不能再出现该转发"
        );

        // 4 次写操作 = 4 次立即下发。
        assert_eq!(
            repo::servers::find_by_id(&state.db.pool, &server_id)
                .await
                .unwrap()
                .config_version,
            4
        );

        // 审计动作齐全。
        let actions: Vec<String> = repo::audit::list(&state.db.pool, 10)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.action)
            .collect();
        for action in ["forward.create", "forward.update", "forward.delete"] {
            assert!(actions.iter().any(|a| a == action), "actions={actions:?}");
        }
    }

    #[tokio::test]
    async fn listen_port_conflicts_with_nodes_and_other_forwards() {
        let (app, state, cookie, server_id) = setup().await;
        add_node(&state, &server_id, 443).await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");

        // 与节点端口冲突。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "forward.port_conflict_node");
        assert!(body["error"].as_str().unwrap().contains("已有节点"));

        // 第一条转发占 8443。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let first_id = body["forward"]["id"].as_str().unwrap().to_string();

        // 与其它转发冲突。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "forward.port_conflict_forward");
        assert!(body["error"].as_str().unwrap().contains("香港中转"));

        // PATCH 改到已占用端口同样拦截（不能绕过创建时的校验）。
        let mut second = forward_body(9443);
        second["name"] = json!("第二条");
        let (status, body) = request(&app, Some(&cookie), Method::POST, &uri, Some(second)).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let second_id = body["forward"]["id"].as_str().unwrap().to_string();
        let second_uri = format!("/api/v1/forwards/{second_id}");

        for port in [8443, 443] {
            let (status, body) = request(
                &app,
                Some(&cookie),
                Method::PATCH,
                &second_uri,
                Some(json!({"listen_port": port})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "port={port} body={body}");
            let expected = if port == 443 {
                "forward.port_conflict_node"
            } else {
                "forward.port_conflict_forward"
            };
            assert_eq!(body["code"], expected, "port={port} body={body}");
        }

        // 改回自己的端口是幂等的：排除自身后不产生冲突。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &second_uri,
            Some(json!({"listen_port": 9443})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");

        // 第一条仍可被独立删除，未被第二条影响。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/forwards/{first_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn blacklist_and_field_validation_return_stable_codes() {
        let (app, _state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");

        // 保留端口：API 10085 / SSH 22。
        for port in [22, 10085] {
            let (status, body) = request(
                &app,
                Some(&cookie),
                Method::POST,
                &uri,
                Some(forward_body(port)),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "port={port} body={body}");
            assert_eq!(body["code"], "forward.port_reserved", "port={port}");
            assert_eq!(body["params"]["port"], port);
        }

        // 端口越界。
        for (port, code) in [
            (0, "forward.listen_port_invalid"),
            (65536, "forward.listen_port_invalid"),
        ] {
            let (status, body) = request(
                &app,
                Some(&cookie),
                Method::POST,
                &uri,
                Some(forward_body(port)),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "port={port} body={body}");
            assert_eq!(body["code"], code);
        }

        // 目标端口越界。
        let mut body = forward_body(8443);
        body["target_port"] = json!(0);
        let (status, value) = request(&app, Some(&cookie), Method::POST, &uri, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.target_port_invalid");

        // 目标地址为空 / 超长。
        let mut empty_host = forward_body(8443);
        empty_host["target_host"] = json!("   ");
        let (status, value) =
            request(&app, Some(&cookie), Method::POST, &uri, Some(empty_host)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.target_host_required");

        let mut long_host = forward_body(8443);
        long_host["target_host"] = json!("a".repeat(256));
        let (status, value) =
            request(&app, Some(&cookie), Method::POST, &uri, Some(long_host)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.target_host_too_long");
        assert_eq!(value["params"]["max"], 255);

        // 名称必填。
        let mut no_name = forward_body(8443);
        no_name["name"] = json!("");
        let (status, value) = request(&app, Some(&cookie), Method::POST, &uri, Some(no_name)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.name_required");

        // 合法的 255 字符地址可以通过（边界值）。
        let mut max_host = forward_body(8443);
        max_host["target_host"] = json!("a".repeat(255));
        let (status, value) =
            request(&app, Some(&cookie), Method::POST, &uri, Some(max_host)).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(
            value["forward"]["target_host"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            255
        );
    }

    #[tokio::test]
    async fn heartbeat_status_is_merged_and_disappears_with_the_rule() {
        let (app, state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");

        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let id = body["forward"]["id"].as_str().unwrap().to_string();

        // 第一轮心跳：监听成功，但加密链握手失败（原因码必须原样带出）。
        repo::forwards::save_status(
            &state.db.pool,
            &server_id,
            &[repo::forwards::NewForwardStatus {
                forward_id: id.clone(),
                listening: true,
                error: String::new(),
                target_ok: Some(false),
                target_error: Some("unknown_issuer".into()),
                targets: Vec::new(),
                traffic_in: None,
                traffic_out: None,
            }],
        )
        .await
        .unwrap();

        let (_, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(body["items"][0]["runtime"]["listening"], true);
        assert_eq!(body["items"][0]["runtime"]["error"], "");
        assert_eq!(body["items"][0]["runtime"]["target_ok"], false);
        assert_eq!(
            body["items"][0]["runtime"]["target_error"], "unknown_issuer",
            "/forwards 的运行时状态必须带出握手失败原因"
        );
        assert!(body["items"][0]["runtime"]["updated_at"].as_i64().unwrap() > 0);

        // 下一轮心跳失败：错误信息覆盖上一轮，不应残留「成功」。
        repo::forwards::save_status(
            &state.db.pool,
            &server_id,
            &[repo::forwards::NewForwardStatus {
                forward_id: id.clone(),
                listening: false,
                error: "端口已被占用".into(),
                target_ok: Some(true),
                target_error: None,
                targets: Vec::new(),
                traffic_in: None,
                traffic_out: None,
            }],
        )
        .await
        .unwrap();
        let (_, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(body["items"][0]["runtime"]["listening"], false);
        assert_eq!(body["items"][0]["runtime"]["error"], "端口已被占用");
        assert!(
            body["items"][0]["runtime"]["target_error"].is_null(),
            "恢复后不能残留上一轮的失败原因"
        );

        // 删规则后：列表里不再出现（即使状态表还残留旧 id）。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/forwards/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (_, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert!(body["items"].as_array().unwrap().is_empty());

        // 空心跳（Agent 已经没有这条规则）也要能清掉缓存。
        repo::forwards::save_status(&state.db.pool, &server_id, &[])
            .await
            .unwrap();
        let (_, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert!(body["items"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn forwards_require_admin() {
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
            &format!("/api/v1/servers/{server_id}/forwards"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/forwards"),
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    /// nftables 保存要求 Agent 明确上报能力；成功后期望态必须带 Nftables。
    #[tokio::test]
    async fn nftables_requires_capability_and_reaches_desired_state() {
        use pierwave_proto::ForwardEngine;

        let (app, state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");

        let mut body = forward_body(8443);
        body["engine"] = json!("nftables");
        let (status, response) =
            request(&app, Some(&cookie), Method::POST, &uri, Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {response}");
        assert_eq!(
            response["code"], "forward.nftables_unavailable",
            "能力未知时必须 fail closed"
        );

        repo::servers::update_health(
            &state.db.pool,
            &server_id,
            "0.8.0",
            &repo::servers::HealthSnapshot {
                nftables_available: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let mut subscription = state.hub.subscribe(&server_id);
        let (status, response) = request(&app, Some(&cookie), Method::POST, &uri, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {response}");
        assert_eq!(response["forward"]["engine"], "nftables");
        let id = response["forward"]["id"].as_str().unwrap();
        let sent = next_forwards(&mut subscription.receiver).await;
        let forward = sent
            .iter()
            .find(|forward| forward.id == pierwave_domain::forwards::desired_id(id))
            .expect("nftables 规则必须出现在期望态里");
        assert_eq!(forward.engine, ForwardEngine::Nftables);
    }

    /// 引擎字段：缺省 native、显式 realm 原样下发、PATCH 可切换、非法值 400。
    #[tokio::test]
    async fn engine_defaults_to_native_and_realm_reaches_desired_state() {
        use pierwave_proto::ForwardEngine;

        let (app, state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");
        let mut subscription = state.hub.subscribe(&server_id);

        // 不填 engine = native（与迁移默认值一致）。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(
            body["forward"]["engine"], "native",
            "缺省必须是 native，旧客户端行为不变"
        );
        let native_id = body["forward"]["id"].as_str().unwrap().to_string();
        assert_eq!(
            next_forwards(&mut subscription.receiver).await[0].engine,
            ForwardEngine::Native,
            "native 规则下发时也要带引擎（旧 Agent 会忽略）"
        );

        // 显式 realm：响应、列表、期望态三处都要带出来。
        let mut realm_body = forward_body(9443);
        realm_body["engine"] = json!("realm");
        let (status, body) =
            request(&app, Some(&cookie), Method::POST, &uri, Some(realm_body)).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["engine"], "realm");
        let realm_id = body["forward"]["id"].as_str().unwrap().to_string();
        let sent = next_forwards(&mut subscription.receiver).await;
        let realm_forward = sent
            .iter()
            .find(|forward| forward.id == pierwave_domain::forwards::desired_id(&realm_id))
            .expect("realm 规则必须出现在期望态里");
        assert_eq!(realm_forward.engine, ForwardEngine::Realm);

        let (status, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let engines: Vec<&str> = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["engine"].as_str().unwrap())
            .collect();
        assert_eq!(engines.len(), 2);
        assert!(
            engines.contains(&"native") && engines.contains(&"realm"),
            "{engines:?}"
        );

        // native → realm：PATCH 只改引擎，期望态立即切换。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/forwards/{native_id}"),
            Some(json!({"engine": "realm"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["engine"], "realm");
        let sent = next_forwards(&mut subscription.receiver).await;
        let switched = sent
            .iter()
            .find(|forward| forward.id == pierwave_domain::forwards::desired_id(&native_id))
            .expect("切换引擎后规则仍在期望态里");
        assert_eq!(switched.engine, ForwardEngine::Realm);

        // 非法引擎：400 + 稳定错误码，规则不被创建。
        let mut bad_body = forward_body(10443);
        bad_body["engine"] = json!("wireguard");
        let (status, body) = request(&app, Some(&cookie), Method::POST, &uri, Some(bad_body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "forward.engine_invalid");
        assert_eq!(body["params"]["engine"], "wireguard");
        let (_, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(
            body["items"].as_array().unwrap().len(),
            2,
            "非法引擎不能落库"
        );
    }

    /// UDP 开关：缺省 false（只监听 TCP），开启后透传到期望态，PATCH 能真的关掉。
    #[tokio::test]
    async fn udp_toggle_roundtrips_and_reaches_desired_state() {
        let (app, state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");
        let mut subscription = state.hub.subscribe(&server_id);

        // 不填 udp = 只监听 TCP（与迁移默认值一致，旧客户端行为不变）。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["udp"], false, "缺省必须只开 TCP");
        let tcp_id = body["forward"]["id"].as_str().unwrap().to_string();
        assert!(
            !next_forwards(&mut subscription.receiver).await[0].udp,
            "缺省规则在期望态里也只能是 TCP"
        );

        // 显式开启：响应、期望态、列表三处都要带出来。
        let mut udp_body = forward_body(9443);
        udp_body["udp"] = json!(true);
        let (status, body) = request(&app, Some(&cookie), Method::POST, &uri, Some(udp_body)).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["udp"], true);
        let udp_id = body["forward"]["id"].as_str().unwrap().to_string();
        let sent = next_forwards(&mut subscription.receiver).await;
        let udp_forward = sent
            .iter()
            .find(|forward| forward.id == pierwave_domain::forwards::desired_id(&udp_id))
            .expect("udp 规则必须出现在期望态里");
        assert!(udp_forward.udp, "udp=true 必须透传到期望态");

        // PATCH 只带 udp 也要被接受（no_update_fields 必须认这个字段）。
        let forward_uri = format!("/api/v1/forwards/{tcp_id}");
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &forward_uri,
            Some(json!({"udp": true})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["udp"], true);
        assert!(
            next_forwards(&mut subscription.receiver)
                .await
                .iter()
                .find(|forward| forward.id == pierwave_domain::forwards::desired_id(&tcp_id))
                .unwrap()
                .udp
        );

        // 关掉：false 不能被 COALESCE 当成「不改」。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &forward_uri,
            Some(json!({"udp": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(
            body["forward"]["udp"], false,
            "PATCH udp=false 必须真的关掉"
        );
        assert!(
            !next_forwards(&mut subscription.receiver)
                .await
                .iter()
                .find(|forward| forward.id == pierwave_domain::forwards::desired_id(&tcp_id))
                .unwrap()
                .udp,
            "关掉之后期望态必须同步"
        );

        // 列表视图同样平铺 udp：一条关着、一条开着。
        let (status, body) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        let udp_flags: Vec<bool> = items
            .iter()
            .map(|item| item["udp"].as_bool().expect("列表必须平铺 udp"))
            .collect();
        assert_eq!(
            udp_flags.iter().filter(|open| **open).count(),
            1,
            "只有显式开过的那条仍是 true：{udp_flags:?}"
        );
        let by_id = |id: &str| {
            items
                .iter()
                .find(|item| item["id"] == id)
                .map(|item| item["udp"].as_bool().unwrap())
                .expect("规则必须在列表里")
        };
        assert!(!by_id(&tcp_id), "PATCH udp=false 必须落库");
        assert!(by_id(&udp_id), "另一条没被改过，必须保持 true");
    }

    /// 协议模式：三种取值往返；仅 UDP + realm 被拒；非法值有稳定错误码。
    #[tokio::test]
    async fn protocol_modes_roundtrip_and_realm_rejects_udp_only() {
        use pierwave_proto::ForwardProtocol;

        let (app, state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");
        let mut subscription = state.hub.subscribe(&server_id);
        // 仅 UDP 需要 Agent 协议 >= 16；本用例先用新 Agent。
        repo::servers::update_health(
            &state.db.pool,
            &server_id,
            "0.9.0",
            &repo::servers::HealthSnapshot {
                protocol_version: Some(16),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        // 缺省 = tcp，期望态也必须是 tcp（不是旧 udp 镜像位的推断结果）。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["protocol"], "tcp");
        assert_eq!(body["forward"]["udp"], false);
        let sent = next_forwards(&mut subscription.receiver).await;
        assert_eq!(sent[0].protocol, ForwardProtocol::Tcp);
        assert!(!sent[0].udp);

        // 仅 UDP：落库与下发都以 protocol 为准。
        let mut udp_body = forward_body(9443);
        udp_body["protocol"] = json!("udp");
        let (status, body) = request(&app, Some(&cookie), Method::POST, &uri, Some(udp_body)).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["protocol"], "udp");
        assert_eq!(body["forward"]["udp"], false, "仅 UDP 不能把旧位误标成双开");
        let udp_id = body["forward"]["id"].as_str().unwrap().to_string();
        let sent = next_forwards(&mut subscription.receiver).await;
        let udp_forward = sent
            .iter()
            .find(|forward| forward.id == pierwave_domain::forwards::desired_id(&udp_id))
            .expect("仅 UDP 规则必须下发");
        assert_eq!(udp_forward.protocol, ForwardProtocol::Udp);
        assert!(!udp_forward.udp);

        // both：protocol 与旧镜像位都打开。
        let mut both_body = forward_body(10443);
        both_body["protocol"] = json!("both");
        let (status, body) =
            request(&app, Some(&cookie), Method::POST, &uri, Some(both_body)).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["protocol"], "both");
        assert_eq!(body["forward"]["udp"], true);
        let sent = next_forwards(&mut subscription.receiver).await;
        let both_forward = sent
            .iter()
            .find(|forward| forward.protocol == ForwardProtocol::Both)
            .expect("both 规则必须下发");
        assert!(both_forward.udp, "旧 Agent 仍需收到 udp=true 镜像位");

        // 仅 UDP + realm：保存时就拒绝，不能靠下发时静默双开。
        let mut realm_udp = forward_body(11443);
        realm_udp["engine"] = json!("realm");
        realm_udp["protocol"] = json!("udp");
        let (status, body) =
            request(&app, Some(&cookie), Method::POST, &uri, Some(realm_udp)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "forward.protocol_udp_requires_native");
        assert_eq!(body["params"]["engine"], "realm");

        // 非法协议：两种字段都走域名层校验。
        let mut bad = forward_body(12443);
        bad["protocol"] = json!("sctp");
        let (status, body) = request(&app, Some(&cookie), Method::POST, &uri, Some(bad)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "forward.protocol_invalid");
        assert_eq!(body["params"]["protocol"], "sctp");

        // PATCH：已有 realm 规则改成仅 UDP 也必须被拦住。
        let realm_uri = format!("/api/v1/forwards/{udp_id}");
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &realm_uri,
            Some(json!({"engine": "realm"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "forward.protocol_udp_requires_native");

        // 旧客户端只发 udp=true 仍然映射成 both。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/forwards/{udp_id}"),
            Some(json!({"udp": true})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["protocol"], "both");
    }

    /// 仅 UDP 的 Agent 能力门禁：未知（NULL）/ 15 拒绝保存，tcp / both 不受影响，
    /// 16 起放行；历史 udp-only 规则在旧 Agent 下进列表 blocked。
    #[tokio::test]
    async fn udp_only_requires_agent_protocol_16() {
        let (app, state, cookie, server_id) = setup().await;
        let uri = format!("/api/v1/servers/{server_id}/forwards");

        async fn set_version(state: &AppState, server_id: &str, version: Option<i64>) {
            repo::servers::update_health(
                &state.db.pool,
                server_id,
                "0.9.0",
                &repo::servers::HealthSnapshot {
                    protocol_version: version,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }

        let udp_body = |port: i64| {
            let mut body = forward_body(port);
            body["protocol"] = json!("udp");
            body
        };

        // 从未上报 = 未知：必须拒绝，不能当成新 Agent。
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(udp_body(18443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.protocol_requires_agent_upgrade");
        assert_eq!(value["params"]["server"], "hk-1");
        assert_eq!(value["params"]["required"], 16);
        assert_eq!(value["params"]["version"], 0);
        assert!(
            value["error"].as_str().unwrap().contains("升级 Agent"),
            "{value}"
        );

        // 协议 15：旧 Agent，仍然拒绝。
        set_version(&state, &server_id, Some(15)).await;
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(udp_body(18444)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.protocol_requires_agent_upgrade");
        assert_eq!(value["params"]["version"], 15);

        // tcp / both 旧 Agent 能正确理解：必须照常保存。
        let mut tcp_id = String::new();
        for (port, protocol) in [(18445, "tcp"), (18446, "both")] {
            let mut body = forward_body(port);
            body["protocol"] = json!(protocol);
            let (status, value) =
                request(&app, Some(&cookie), Method::POST, &uri, Some(body)).await;
            assert_eq!(status, StatusCode::OK, "{protocol} unexpected: {value}");
            if protocol == "tcp" {
                tcp_id = value["forward"]["id"].as_str().unwrap().to_string();
            }
        }

        // 协议 16：放行。
        set_version(&state, &server_id, Some(16)).await;
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &uri,
            Some(udp_body(18447)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let udp_id = value["forward"]["id"].as_str().unwrap().to_string();

        // 已保存的 udp-only 规则遇到旧 Agent（版本回退 / 换机）：列表 blocked。
        set_version(&state, &server_id, Some(15)).await;
        let (status, value) = request(&app, Some(&cookie), Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        let item = value["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == udp_id.as_str())
            .expect("udp-only 规则仍在列表里");
        assert_eq!(
            item["blocked_code"],
            "forward.protocol_requires_agent_upgrade"
        );
        assert!(
            item["blocked_reason"]
                .as_str()
                .unwrap()
                .contains("升级 Agent"),
            "{item}"
        );
        // tcp / both 规则不标 blocked（旧响应形状不变）。
        let tcp_item = value["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["listen_port"] == 18445)
            .unwrap();
        assert!(tcp_item.get("blocked_reason").is_none(), "{tcp_item}");

        // 历史 udp-only 规则仍可停用（不能把用户锁死），渲染层继续跳过。
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/forwards/{udp_id}"),
            Some(json!({"enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {value}");
        assert_eq!(value["forward"]["enabled"], false);

        // PATCH 把 tcp 规则改成 udp：保存路径同样要门禁。
        let (status, value) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/forwards/{tcp_id}"),
            Some(json!({"protocol": "udp"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {value}");
        assert_eq!(value["code"], "forward.protocol_requires_agent_upgrade");
    }

    // 避免「只读 token 未使用」的假警告：`admin_id` 在 setup 里只用于建会话。
    #[tokio::test]
    async fn missing_forward_is_404() {
        let (app, _state, cookie, _server_id) = setup().await;
        let uri = "/api/v1/forwards/00000000-0000-0000-0000-000000000000";
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            uri,
            Some(json!({"enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "forward.not_found");

        let (status, body) = request(&app, Some(&cookie), Method::DELETE, uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "forward.not_found");
    }

    // ------------------------------------------------------------------
    // 用户自助转发（迁移 0044）：配额 / 白名单 / 端口自动分配 / 归属
    // ------------------------------------------------------------------

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

    async fn add_server(state: &AppState, name: &str, address: &str) -> String {
        repo::servers::create(&state.db.pool, name, address, "external")
            .await
            .unwrap()
            .0
            .id
    }

    async fn create_forward_package(
        state: &AppState,
        name: &str,
        forward_limit: i64,
        server_ids: &[String],
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
        repo::packages::set_forward_rules(&state.db.pool, &package.id, forward_limit, server_ids)
            .await
            .unwrap();
        package.id
    }

    async fn bind_user_to_package(state: &AppState, user_id: &str, package_id: &str) {
        bind_user_to_package_until(state, user_id, package_id, None).await;
    }

    async fn bind_user_to_package_until(
        state: &AppState,
        user_id: &str,
        package_id: &str,
        expires_at: Option<i64>,
    ) {
        let package = repo::packages::find_by_id(&state.db.pool, package_id)
            .await
            .unwrap()
            .unwrap();
        repo::user_packages::create(
            &state.db.pool,
            user_id,
            repo::user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap();
    }

    fn user_forward_body(server_id: &str, host: &str, port: i64) -> Value {
        json!({
            "server_id": server_id,
            "target_host": host,
            "target_port": port,
        })
    }

    /// 条数由套餐 `forward_limit` 限制；服务器必须在该套餐白名单里；
    /// 端口自动分配且请求里的 `listen_port` 被忽略。
    #[tokio::test]
    async fn user_forwards_use_package_quota_and_whitelist() {
        let (app, state, _admin_cookie, server_a) = setup().await;
        let server_b = add_server(&state, "hk-2", "5.6.7.8").await;
        let (alice_id, alice_cookie) = make_user(&state, "alice").await;
        let package_id =
            create_forward_package(&state, "两张卡", 2, std::slice::from_ref(&server_a)).await;
        bind_user_to_package(&state, &alice_id, &package_id).await;

        // 不在套餐白名单：403，且不消耗配额。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_b, "10.0.0.8", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "unexpected: {body}");
        assert_eq!(body["code"], "me.forward_server_not_allowed");
        assert_eq!(body["params"]["server_id"], server_b.as_str());

        // 第一条：即使请求里带 listen_port 也必须被忽略，由服务端分配。
        let mut body = user_forward_body(&server_a, "10.0.0.8", 443);
        body["listen_port"] = json!(12345);
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let first = &body["forward"];
        let first_id = first["id"].as_str().unwrap().to_string();
        assert_ne!(first["listen_port"], 12345, "用户不能指定端口");
        let first_port = first["listen_port"].as_i64().unwrap();
        assert_eq!(first["protocol"], "tcp", "缺省协议必须是 tcp");
        assert_eq!(first["engine"], "native");
        assert_eq!(first["owner_user_id"], alice_id.as_str());
        assert_eq!(first["server_name"], "hk-1");
        assert_eq!(
            first["entry_address"],
            format!("1.2.3.4:{first_port}"),
            "用户视角必须直接带出入口地址"
        );
        assert_eq!(body["quota"], json!({"limit": 2, "used": 1}));

        // 第二条：换一个目标地址，端口不能与第一条重复。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_a, "10.0.0.9", 8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let second_port = body["forward"]["listen_port"].as_i64().unwrap();
        assert_ne!(first_port, second_port, "自动分配不能重复");

        // 第三条：400 + 稳定错误码与插值参数。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_a, "10.0.0.10", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "me.forward_quota_exceeded");
        assert_eq!(body["params"], json!({"limit": 2, "used": 2}));

        // 列表只含自己的两条，并带 quota / entry_address。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::GET,
            "/api/v1/me/forwards",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(body["quota"], json!({"limit": 2, "used": 2}));
        for item in items {
            assert_eq!(item["server_id"], server_a.as_str());
            assert_eq!(
                item["entry_address"],
                format!("1.2.3.4:{}", item["listen_port"].as_i64().unwrap())
            );
        }
        assert!(items.iter().any(|item| item["id"] == first_id.as_str()));
    }

    /// 用户只能看/改/删自己的；管理员仍可用原管理端接口删任意规则。
    #[tokio::test]
    async fn user_forwards_are_scoped_to_the_owner_and_admin_keeps_access() {
        let (app, state, admin_cookie, server_id) = setup().await;
        let (alice_id, alice_cookie) = make_user(&state, "alice").await;
        let (bob_id, bob_cookie) = make_user(&state, "bob").await;
        let alice_package =
            create_forward_package(&state, "A", 1, std::slice::from_ref(&server_id)).await;
        let bob_package =
            create_forward_package(&state, "B", 1, std::slice::from_ref(&server_id)).await;
        bind_user_to_package(&state, &alice_id, &alice_package).await;
        bind_user_to_package(&state, &bob_id, &bob_package).await;

        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.8", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let id = body["forward"]["id"].as_str().unwrap().to_string();

        // 别人的列表为空。
        let (status, body) = request(
            &app,
            Some(&bob_cookie),
            Method::GET,
            "/api/v1/me/forwards",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert!(body["items"].as_array().unwrap().is_empty());

        // 别人的改/删都按「不存在」处理，不能靠错误码探测 id。
        let uri = format!("/api/v1/me/forwards/{id}");
        let (status, body) = request(
            &app,
            Some(&bob_cookie),
            Method::PATCH,
            &uri,
            Some(json!({"enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "unexpected: {body}");
        assert_eq!(body["code"], "me.forward_not_found");
        let (status, body) = request(&app, Some(&bob_cookie), Method::DELETE, &uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "unexpected: {body}");
        assert_eq!(body["code"], "me.forward_not_found");

        // 本人可以停用/启用。
        for enabled in [false, true] {
            let (status, body) = request(
                &app,
                Some(&alice_cookie),
                Method::PATCH,
                &uri,
                Some(json!({"enabled": enabled})),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "unexpected: {body}");
            assert_eq!(body["forward"]["enabled"], enabled);
        }
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::PATCH,
            &uri,
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "request.no_update_fields");

        // 管理员列表能看出归属，也能删任意一条。
        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::GET,
            &format!("/api/v1/servers/{server_id}/forwards"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let item = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id.as_str())
            .expect("管理员列表应包含用户转发");
        assert_eq!(item["owner_user_id"], alice_id.as_str());

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::DELETE,
            &format!("/api/v1/forwards/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::GET,
            "/api/v1/me/forwards",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert!(body["items"].as_array().unwrap().is_empty());

        // 管理员创建的规则 owner_user_id 为空，且旧响应形状不出现该字段。
        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/forwards"),
            Some(forward_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert!(
            body["forward"].get("owner_user_id").is_none(),
            "管理员创建的规则不应多出 owner 字段：{body}"
        );
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::GET,
            "/api/v1/me/forwards",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert!(
            body["items"].as_array().unwrap().is_empty(),
            "用户列表不能出现管理员创建的转发"
        );
    }

    /// 计费开关：用户列表带 `count_traffic`，创建默认开启，且只能改自己的规则。
    #[tokio::test]
    async fn user_forwards_expose_and_toggle_count_traffic_only_for_the_owner() {
        let (app, state, admin_cookie, server_id) = setup().await;
        let (alice_id, alice_cookie) = make_user(&state, "alice").await;
        let (_bob_id, bob_cookie) = make_user(&state, "bob").await;
        let package =
            create_forward_package(&state, "A", 1, std::slice::from_ref(&server_id)).await;
        bind_user_to_package(&state, &alice_id, &package).await;

        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.8", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let id = body["forward"]["id"].as_str().unwrap().to_string();
        assert_eq!(
            body["forward"]["count_traffic"], true,
            "用户自助转发默认计入套餐：{body}"
        );

        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::GET,
            "/api/v1/me/forwards",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let item = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id.as_str())
            .expect("列表应包含刚创建的转发");
        assert_eq!(item["count_traffic"], true);

        // 别人的规则按「不存在」处理（404，不是 403）。
        let uri = format!("/api/v1/me/forwards/{id}");
        let (status, body) = request(
            &app,
            Some(&bob_cookie),
            Method::PATCH,
            &uri,
            Some(json!({"count_traffic": true})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "unexpected: {body}");
        assert_eq!(body["code"], "me.forward_not_found");

        // 本人可以只改计费开关，不影响启用状态。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::PATCH,
            &uri,
            Some(json!({"count_traffic": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["count_traffic"], false);
        assert_eq!(body["forward"]["enabled"], true, "只改计费不能顺手停用");

        // 空 PATCH 仍是 400。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::PATCH,
            &uri,
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "request.no_update_fields");

        // 管理员列表能读到同一条规则的计费开关，也能通过全局 PATCH 改。
        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::GET,
            &format!("/api/v1/servers/{server_id}/forwards"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let admin_item = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id.as_str())
            .expect("管理员列表应包含用户转发");
        assert_eq!(admin_item["count_traffic"], false);

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::PATCH,
            &format!("/api/v1/forwards/{id}"),
            Some(json!({"count_traffic": true})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["count_traffic"], true);

        // 管理员创建时也可以直接指定；旧请求缺省仍是 false。
        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/forwards"),
            Some(json!({
                "name": "管理员计费",
                "listen_port": 8443,
                "target_host": "10.0.0.8",
                "target_port": 443,
                "count_traffic": true,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["count_traffic"], true);
        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/forwards"),
            Some(json!({
                "name": "管理员默认",
                "listen_port": 8444,
                "target_host": "10.0.0.8",
                "target_port": 443,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["forward"]["count_traffic"], false);
    }

    /// 自动分配遵守服务器端口策略与已占用端口；耗尽时是 400 而不是换池。
    #[tokio::test]
    async fn user_forward_ports_follow_the_server_port_policy() {
        let (app, state, _admin_cookie, server_id) = setup().await;
        repo::servers::set_port_policy(&state.db.pool, &server_id, Some(30000), Some(30002), "[]")
            .await
            .unwrap();
        // 30000 已被节点占用：自动分配必须绕开。
        add_node(&state, &server_id, 30000).await;

        let (alice_id, alice_cookie) = make_user(&state, "alice").await;
        let package_id =
            create_forward_package(&state, "三张卡", 3, std::slice::from_ref(&server_id)).await;
        bind_user_to_package(&state, &alice_id, &package_id).await;

        let mut ports = Vec::new();
        for host in ["10.0.0.8", "10.0.0.9"] {
            let mut body = user_forward_body(&server_id, host, 443);
            body["listen_port"] = json!(12345);
            let (status, response) = request(
                &app,
                Some(&alice_cookie),
                Method::POST,
                "/api/v1/me/forwards",
                Some(body),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "unexpected: {response}");
            ports.push(response["forward"]["listen_port"].as_i64().unwrap());
        }
        assert_eq!(ports, vec![30001, 30002], "只能从允许区间里取空闲端口");

        // 允许集合已满：400（复用链的分配耗尽错误码），不会回退到 20000 池。
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.10", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "chain.port_allowed_exhausted");
    }

    /// 套餐 API 接受并返回 `forward_limit` / `forward_server_ids`；
    /// 改套餐后下一条请求立即按新值判定（无缓存）。
    #[tokio::test]
    async fn package_forward_rules_roundtrip_and_take_effect_immediately() {
        let (app, state, admin_cookie, server_id) = setup().await;
        let server_b = add_server(&state, "hk-2", "5.6.7.8").await;

        // 非法配额 / 不存在的服务器都不能落库。
        for (body, code) in [
            (
                json!({"name": "负数", "forward_limit": -1}),
                "package.forward_limit_invalid",
            ),
            (
                json!({"name": "坏服务器", "forward_limit": 1, "forward_server_ids": ["nope"]}),
                "package.forward_server_not_found",
            ),
        ] {
            let (status, response) = request(
                &app,
                Some(&admin_cookie),
                Method::POST,
                "/api/v1/packages",
                Some(body),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {response}");
            assert_eq!(response["code"], code);
        }

        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({
                "name": "自助卡",
                "forward_limit": 1,
                "forward_server_ids": [server_id.clone()],
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["package"]["forward_limit"], 1);
        assert_eq!(
            body["package"]["forward_server_ids"],
            json!([server_id.clone()])
        );
        let package_id = body["package"]["id"].as_str().unwrap().to_string();

        let (alice_id, alice_cookie) = make_user(&state, "alice").await;
        bind_user_to_package(&state, &alice_id, &package_id).await;

        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.8", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.9", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "me.forward_quota_exceeded");

        // 改成 2：立即可再建一条。
        let package_uri = format!("/api/v1/packages/{package_id}");
        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::PATCH,
            &package_uri,
            Some(json!({"forward_limit": 2})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["package"]["forward_limit"], 2);
        assert_eq!(
            body["package"]["forward_server_ids"],
            json!([server_id.clone()]),
            "只改配额时白名单必须保持不变"
        );
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.9", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");

        // 清空白名单：即使还有条数也不允许再建（403 先于配额判定）。
        let (status, body) = request(
            &app,
            Some(&admin_cookie),
            Method::PATCH,
            &package_uri,
            Some(json!({"forward_server_ids": []})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        assert_eq!(body["package"]["forward_server_ids"], json!([]));
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.10", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "unexpected: {body}");
        assert_eq!(body["code"], "me.forward_server_not_allowed");

        // 关闭配额：立即 400，而不是继续沿用旧值。
        let (status, _) = request(
            &app,
            Some(&admin_cookie),
            Method::PATCH,
            &package_uri,
            Some(json!({"forward_limit": 0, "forward_server_ids": [server_b]})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.10", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "me.forward_quota_exceeded");
        assert_eq!(body["params"]["limit"], 0);
    }

    /// 只有生效中（未过期 / 未停用 / 未用尽）的套餐才发放额度。
    #[tokio::test]
    async fn only_active_packages_grant_forward_quota() {
        let (app, state, _admin_cookie, server_id) = setup().await;
        let (alice_id, alice_cookie) = make_user(&state, "alice").await;

        // 过期套餐：limit 再大也不生效。
        let expired =
            create_forward_package(&state, "过期卡", 5, std::slice::from_ref(&server_id)).await;
        bind_user_to_package_until(&state, &alice_id, &expired, Some(repo::now() - 60)).await;
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.8", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "me.forward_quota_exceeded");
        assert_eq!(body["params"], json!({"limit": 0, "used": 0}));

        // 生效套餐：limit 1 可用。
        let active =
            create_forward_package(&state, "生效卡", 1, std::slice::from_ref(&server_id)).await;
        bind_user_to_package(&state, &alice_id, &active).await;
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.8", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");

        // 停用该套餐实例：下一条请求立即不再授权。
        let views = repo::user_packages::list_views_by_user(&state.db.pool, &alice_id)
            .await
            .unwrap();
        let instance = views
            .iter()
            .find(|view| view.package_id == active)
            .expect("套餐实例必须存在");
        repo::user_packages::update(
            &state.db.pool,
            &instance.id,
            repo::user_packages::UpdateUserPackage {
                status: Some("disabled".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.9", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {body}");
        assert_eq!(body["code"], "me.forward_quota_exceeded");
        assert_eq!(body["params"]["limit"], 0, "停用套餐不再发条数");
    }

    /// 协议：缺省 tcp、允许 both；udp 沿用 Agent 能力门禁。
    #[tokio::test]
    async fn user_forward_protocol_defaults_and_udp_gate() {
        let (app, state, _admin_cookie, server_id) = setup().await;
        let (alice_id, alice_cookie) = make_user(&state, "alice").await;
        let package_id =
            create_forward_package(&state, "协议卡", 10, std::slice::from_ref(&server_id)).await;
        bind_user_to_package(&state, &alice_id, &package_id).await;

        let mut body = user_forward_body(&server_id, "10.0.0.8", 443);
        body["protocol"] = json!("both");
        let (status, response) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {response}");
        assert_eq!(response["forward"]["protocol"], "both");

        // Agent 协议未知：仅 UDP 必须 400（旧 Agent 会静默只监听 TCP）。
        let udp_body = |port: i64| {
            let mut body = user_forward_body(&server_id, "10.0.0.9", port);
            body["protocol"] = json!("udp");
            body
        };
        let (status, response) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(udp_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected: {response}");
        assert_eq!(response["code"], "forward.protocol_requires_agent_upgrade");

        repo::servers::update_health(
            &state.db.pool,
            &server_id,
            "0.9.0",
            &repo::servers::HealthSnapshot {
                protocol_version: Some(16),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let (status, response) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(udp_body(8443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {response}");
        assert_eq!(response["forward"]["protocol"], "udp");
    }

    /// 审计只记 id / 目标 / 端口，不写用户名等隐私字段。
    #[tokio::test]
    async fn user_forward_audit_has_no_user_privacy() {
        let (app, state, _admin_cookie, server_id) = setup().await;
        let (alice_id, alice_cookie) = make_user(&state, "alice").await;
        let package_id =
            create_forward_package(&state, "审计卡", 1, std::slice::from_ref(&server_id)).await;
        bind_user_to_package(&state, &alice_id, &package_id).await;

        let (status, body) = request(
            &app,
            Some(&alice_cookie),
            Method::POST,
            "/api/v1/me/forwards",
            Some(user_forward_body(&server_id, "10.0.0.8", 443)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "unexpected: {body}");
        let id = body["forward"]["id"].as_str().unwrap().to_string();
        let listen_port = body["forward"]["listen_port"].as_i64().unwrap();
        let (status, _) = request(
            &app,
            Some(&alice_cookie),
            Method::DELETE,
            &format!("/api/v1/me/forwards/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        type AuditDetailRow = (String, Option<String>, Option<String>, Option<String>);
        let rows: Vec<AuditDetailRow> = sqlx::query_as(
            "SELECT action, target, detail, actor_id FROM audit_log
             WHERE action LIKE 'user_forward.%' ORDER BY created_at ASC, rowid ASC",
        )
        .fetch_all(&state.db.pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 2, "创建和删除各一条审计");
        let actions: Vec<&str> = rows.iter().map(|row| row.0.as_str()).collect();
        assert_eq!(actions, vec!["user_forward.create", "user_forward.delete"]);
        for (_action, target, detail, actor_id) in rows {
            assert_eq!(
                target.as_deref(),
                Some(id.as_str()),
                "target 必须是 forward id"
            );
            assert_eq!(actor_id.as_deref(), Some(alice_id.as_str()));
            let detail = detail.unwrap();
            assert!(!detail.contains("alice"), "detail 不能出现用户名：{detail}");
            assert!(detail.contains(&id), "detail 必须带 forward id：{detail}");
            assert!(
                detail.contains(&listen_port.to_string()),
                "detail 必须带端口：{detail}"
            );
            assert!(detail.contains("10.0.0.8"), "detail 必须带目标：{detail}");
        }
    }

    /// 未登录访问 `/me/forwards` 一律 401。
    #[tokio::test]
    async fn user_forward_endpoints_require_login() {
        let (app, _state, _admin_cookie, server_id) = setup().await;
        for (method, uri, body) in [
            (Method::GET, "/api/v1/me/forwards".to_string(), None),
            (
                Method::POST,
                "/api/v1/me/forwards".to_string(),
                Some(user_forward_body(&server_id, "10.0.0.8", 443)),
            ),
            (
                Method::PATCH,
                "/api/v1/me/forwards/00000000-0000-0000-0000-000000000000".to_string(),
                Some(json!({"enabled": false})),
            ),
            (
                Method::DELETE,
                "/api/v1/me/forwards/00000000-0000-0000-0000-000000000000".to_string(),
                None,
            ),
        ] {
            let (status, _) = request(&app, None, method, &uri, body).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
        }
    }
}
