use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::{AgentUpgrade, Patch, Server};
use pierwave_domain::port_policy::{self, PortPolicy};
use pierwave_domain::release;
use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 服务器分组名最大字符数；空串 = 未分组。
pub(crate) const GROUP_NAME_MAX_CHARS: usize = 32;

/// Agent 一键安装脚本的固定路径（与 `routes::install::script` 一致）。
const AGENT_INSTALL_SCRIPT: &str = "/api/agent/install.sh";

/// 一条可直接复制的安装命令；明文 token 只出现在这里。
fn install_command(base: &str, token: &str) -> String {
    format!(
        "curl -fsSL {}{AGENT_INSTALL_SCRIPT}?token={token} | sudo bash",
        base.trim_end_matches('/')
    )
}

/// 不依赖 token 的常驻命令；`install` 只有创建 / 重置响应里才有值。
///
/// upgrade / uninstall 的参数名取自 `scripts/install.sh` 的命令表，
/// stop / restart 操作的是 Agent 自己的 systemd 单元。
fn commands_view(base: &str, install: Option<&str>) -> Value {
    let script = format!("{}{AGENT_INSTALL_SCRIPT}", base.trim_end_matches('/'));
    json!({
        "install": install,
        "upgrade": format!("curl -fsSL {script} | sh -s -- upgrade"),
        "uninstall": format!("curl -fsSL {script} | sh -s -- uninstall"),
        "stop": "systemctl stop pierwave-agent",
        "restart": "systemctl restart pierwave-agent",
    })
}

/// 管理端服务器 JSON：`Server` 的所有字段 + `commands`。
fn server_view(server: &Server, base: &str, install: Option<&str>) -> AppResult<Value> {
    let mut value = serde_json::to_value(server)
        .map_err(|error| AppError::Internal(anyhow::Error::from(error)))?;
    value["commands"] = commands_view(base, install);
    // 前端据此提示「网卡尚未验证」：nic_name 已保存，但 Agent 还没上报过
    // 网卡列表，无法确认它存在（也无法据此下发配置）。
    value["nic_unverified"] = json!(crate::nic::is_unverified(server.interfaces_reported_at));
    Ok(value)
}

/// 分组名：去首尾空白，空串 = 未分组；最长 32 个字符；拒绝控制字符。
pub(crate) fn normalize_group_name(raw: Option<&str>) -> AppResult<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let name = raw.trim();
    if name.is_empty() {
        return Ok(None);
    }
    if name.chars().count() > GROUP_NAME_MAX_CHARS {
        return Err(AppError::coded(
            "server.group_name_too_long",
            Some(json!({ "max": GROUP_NAME_MAX_CHARS })),
            format!(
                "分组名称最多 {GROUP_NAME_MAX_CHARS} 个字符 / Group name must be at most {GROUP_NAME_MAX_CHARS} characters"
            ),
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(AppError::coded(
            "server.group_name_invalid",
            Some(json!({ "value": name })),
            "分组名称包含非法字符（不能包含换行、制表符等控制字符） / Group name contains invalid characters (newlines and tabs are not allowed)",
        ));
    }
    Ok(Some(name.to_string()))
}

/// 内网地址：去首尾空白；空串 = 清空（落 NULL）。地址格式不做 DNS/IP 校验，
/// 管理员可能填内部域名或 IPv6，这里只保证「空白 = 没有」这一条。
pub(crate) fn normalize_internal_address(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 把允许端口策略写回服务器，并同步内存里的响应字段。
async fn save_port_policy(
    state: &AppState,
    server: &mut Server,
    policy: &PortPolicy,
    internal_address: Option<String>,
) -> AppResult<()> {
    repo::servers::set_port_policy(
        &state.db.pool,
        &server.id,
        policy.start,
        policy.end,
        &policy.allow_json(),
    )
    .await?;
    repo::servers::set_internal_address(&state.db.pool, &server.id, internal_address.as_deref())
        .await?;
    server.port_start = policy.start;
    server.port_end = policy.end;
    server.port_allow_json = policy.allow_json();
    server.internal_address = internal_address;
    Ok(())
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let servers = repo::servers::list_with_node_stats(&state.db.pool).await?;
    let base = super::install::external_base(&headers);
    let items = servers
        .iter()
        .map(|row| {
            let mut value = server_view(&row.server, &base, None)?;
            // 只读聚合：不改表结构，列表查询时一次算出。
            value["node_count"] = json!(row.node_count);
            value["node_enabled_count"] = json!(row.node_enabled_count);
            value["node_protocols"] = json!(row.node_protocols);
            Ok(value)
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateServer {
    pub name: String,
    pub address: String,
    #[serde(default = "default_xray_mode")]
    pub xray_mode: String,
    /// ISO 3166-1 alpha-2（如 CN / US / JP）；空 = 不填。
    #[serde(default)]
    pub country_code: Option<String>,
    /// 分组名；空串 = 未分组，最长 32 个字符。
    #[serde(default)]
    pub group_name: Option<String>,
    /// 允许的端口区间起点（含）；省略 / null = 该侧不设边界。
    #[serde(default)]
    pub port_start: Option<i64>,
    /// 允许的端口区间终点（含）。
    #[serde(default)]
    pub port_end: Option<i64>,
    /// 区间外额外允许的端口；省略 / null = 没有额外端口。
    #[serde(default)]
    pub port_allow: Option<Vec<i64>>,
    /// 跳间寻址用的内网地址；省略 / null = 未填写。
    #[serde(default)]
    pub internal_address: Option<String>,
    /// 限定出入流量的网卡名；省略 / null / 空串 = 不限制。
    #[serde(default)]
    pub nic_name: Option<String>,
}

fn default_xray_mode() -> String {
    "external".into()
}

/// 国家/地区代码校验：空串 = 清空；否则必须是 ISO 3166-1 alpha-2 白名单内的
/// 两位大写字母。
///
/// 公开探针页用这两个字母转国旗 emoji，所以不接受小写、数字、三位代码，
/// 也不接受 `ZZ` / `XK` 这类非官方分配代码——宁可显示地球图标，也不猜国家。
pub(crate) fn normalize_country_code(raw: Option<&str>) -> AppResult<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let code = raw.trim();
    if code.is_empty() {
        return Ok(None);
    }
    if code.len() == 2
        && code.chars().all(|ch| ch.is_ascii_uppercase())
        && pierwave_domain::country::is_valid_country_code(code)
    {
        return Ok(Some(code.to_string()));
    }
    Err(AppError::coded(
        "server.country_code_invalid",
        Some(json!({ "value": code })),
        "国家/地区代码无效：请填写 ISO 3166-1 两位字母代码（如 CN / US / JP），或留空 / Invalid country/region code: enter an ISO 3166-1 two-letter code (e.g. CN / US / JP), or leave it empty",
    ))
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Json(req): Json<CreateServer>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;
    let name = req.name.trim();
    let address = req.address.trim();
    if name.is_empty() || address.is_empty() {
        return Err(AppError::coded(
            "server.name_address_required",
            None,
            "名称和地址不能为空",
        ));
    }
    if req.xray_mode != "external" {
        return Err(AppError::coded(
            "server.xray_mode_unsupported",
            Some(json!({ "mode": &req.xray_mode })),
            "目前只支持外置 Xray（external）；内联模式尚未实现",
        ));
    }
    let group_name = normalize_group_name(req.group_name.as_deref())?;
    let port_policy = PortPolicy::validated(
        req.port_start,
        req.port_end,
        req.port_allow.as_deref().unwrap_or_default(),
    )?;
    let internal_address = normalize_internal_address(req.internal_address.as_deref());
    let nic_name = crate::nic::normalize_nic_name(req.nic_name.as_deref());
    let (mut server, token) = repo::servers::create_with_country_and_group(
        &state.db.pool,
        name,
        address,
        &req.xray_mode,
        normalize_country_code(req.country_code.as_deref())?.as_deref(),
        group_name.as_deref(),
    )
    .await?;
    save_port_policy(&state, &mut server, &port_policy, internal_address).await?;
    // 新服务器还没有心跳，网卡列表为空：允许先保存 nic_name，响应里由
    // `server_view` 标成 `nic_unverified`，等 Agent 首次上报后再校验。
    if let Some(name) = &nic_name {
        repo::servers::set_nic_name(&state.db.pool, &server.id, Some(name)).await?;
        server.nic_name = Some(name.clone());
    }
    // 明文 token 不落审计：它只该在创建响应里出现一次。
    crate::audit::record(
        &state,
        &user.0,
        "server.create",
        &server.id,
        json!({
            "name": &server.name,
            "address": &server.address,
            "xray_mode": &server.xray_mode,
            "group_name": &server.group_name,
            "port_start": server.port_start,
            "port_end": server.port_end,
            "port_allow": serde_json::from_str::<Value>(&server.port_allow_json)
                .unwrap_or_else(|_| json!([])),
            "internal_address": &server.internal_address,
            "nic_name": &server.nic_name,
        }),
    )
    .await;
    // 明文 token 只在这里出现一次
    let base = crate::routes::install::external_base(&headers);
    let command = install_command(&base, &token);
    let server = server_view(&server, &base, Some(&command))?;
    Ok(Json(json!({
        "server": server,
        "token": token,
        "install_command": command,
    })))
}

#[derive(Deserialize)]
pub struct PatchServer {
    pub name: Option<String>,
    pub address: Option<String>,
    pub xray_mode: Option<String>,
    /// 是否允许主控向这台服务器下发 Agent 升级计划。
    pub allow_agent_upgrade: Option<bool>,
    /// ISO 3166-1 alpha-2；空串 = 清空，缺省 = 不改。
    pub country_code: Option<String>,
    /// 分组名；空串 / `null` = 清空，缺省 = 不改。
    ///
    /// 用 `Option<Option<_>>` + 自定义反序列化区分「没传」与「显式 null」：
    /// Web 编辑弹窗用 null 表示清空分组，不能和「不改」混为一谈。
    #[serde(default, deserialize_with = "deserialize_present_group_name")]
    pub group_name: Option<Option<String>>,
    /// 端口区间起点：缺省 = 不改，`null` = 清空，数字 = 设置。
    #[serde(default)]
    pub port_start: Patch<i64>,
    /// 端口区间终点：缺省 = 不改，`null` = 清空，数字 = 设置。
    #[serde(default)]
    pub port_end: Patch<i64>,
    /// 额外允许端口：缺省 = 不改，`null` = 清空，数组 = 整体替换。
    #[serde(default)]
    pub port_allow: Patch<Vec<i64>>,
    /// 内网地址：缺省 = 不改，`null` / 空串 = 清空。
    #[serde(default)]
    pub internal_address: Patch<String>,
    /// 限定网卡：缺省 = 不改，`null` / 空串 = 不限制，值 = 必须存在于最近上报列表。
    #[serde(default)]
    pub nic_name: Patch<String>,
}

fn deserialize_present_group_name<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<PatchServer>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let name = match req.name.as_deref().map(str::trim) {
        Some("") => {
            return Err(AppError::coded(
                "server.name_required",
                None,
                "服务器名称不能为空",
            ))
        }
        Some(name) if name.chars().count() > 64 => {
            return Err(AppError::coded(
                "server.name_too_long",
                Some(json!({ "max": 64 })),
                "服务器名称最多 64 个字符",
            ))
        }
        other => other,
    };
    let address = match req.address.as_deref().map(str::trim) {
        Some("") => {
            return Err(AppError::coded(
                "server.address_required",
                None,
                "服务器地址不能为空",
            ))
        }
        other => other,
    };
    if let Some(mode) = req.xray_mode.as_deref() {
        if mode != "external" {
            return Err(AppError::coded(
                "server.xray_mode_unsupported",
                Some(json!({ "mode": mode })),
                "目前只支持外置 Xray（external）；内联模式尚未实现",
            ));
        }
    }
    if name.is_none()
        && address.is_none()
        && req.xray_mode.is_none()
        && req.allow_agent_upgrade.is_none()
        && req.country_code.is_none()
        && req.group_name.is_none()
        && !req.port_start.is_set()
        && !req.port_end.is_set()
        && !req.port_allow.is_set()
        && !req.internal_address.is_set()
        && !req.nic_name.is_set()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供 name / address / xray_mode / allow_agent_upgrade / country_code / group_name / port_start / port_end / port_allow / internal_address / nic_name 之一",
        ));
    }

    let country_code = match req.country_code.as_deref() {
        Some(raw) => Some(normalize_country_code(Some(raw))?),
        None => None,
    };
    let group_name = match req.group_name.as_ref() {
        Some(raw) => Some(normalize_group_name(raw.as_deref())?),
        None => None,
    };

    let before = repo::servers::find_by_id(&state.db.pool, &id).await.ok();

    // 端口策略是三态 PATCH：缺省沿用旧值、null 清空、数字/数组覆盖。
    // 先合成最终值再校验，避免「只改一半」产生非法区间。
    let policy_changed =
        req.port_start.is_set() || req.port_end.is_set() || req.port_allow.is_set();
    let internal_changed = req.internal_address.is_set();
    let nic_changed = req.nic_name.is_set();
    let current = if policy_changed || internal_changed || nic_changed {
        Some(
            repo::servers::find_by_id(&state.db.pool, &id)
                .await
                .map_err(|error| match error.downcast_ref::<sqlx::Error>() {
                    Some(sqlx::Error::RowNotFound) => {
                        AppError::not_found("server.not_found", None, "资源不存在")
                    }
                    _ => AppError::Internal(error),
                })?,
        )
    } else {
        None
    };
    let policy = if policy_changed {
        let current = current.as_ref().expect("policy_changed 时必已读取服务器");
        let port_start = match req.port_start {
            Patch::Missing => current.port_start,
            Patch::Null => None,
            Patch::Value(port) => Some(port),
        };
        let port_end = match req.port_end {
            Patch::Missing => current.port_end,
            Patch::Null => None,
            Patch::Value(port) => Some(port),
        };
        let port_allow = match &req.port_allow {
            Patch::Missing => Some(port_policy::parse_allow_json_vec(&current.port_allow_json)),
            Patch::Null => Some(Vec::new()),
            Patch::Value(ports) => Some(ports.clone()),
        };
        Some(PortPolicy::validated(
            port_start,
            port_end,
            port_allow.as_deref().unwrap_or_default(),
        )?)
    } else {
        None
    };
    let internal_address = if internal_changed {
        normalize_internal_address(req.internal_address.value().as_deref())
    } else {
        None
    };
    // 网卡校验：已上报过列表就必须命中；尚未上报（空列表）允许保存，
    // 仅标记 nic_unverified，绝不把未验证的名字当成已确认。
    let nic_name = if nic_changed {
        crate::nic::normalize_nic_name(req.nic_name.value().as_deref())
    } else {
        None
    };
    if let (Some(name), Some(current)) = (nic_name.as_deref(), current.as_ref()) {
        crate::nic::validate(
            &current.interfaces_json,
            current.interfaces_reported_at.is_some(),
            name,
        )?;
    }

    let mut server = repo::servers::update(
        &state.db.pool,
        &id,
        name,
        address,
        req.xray_mode.as_deref(),
        req.allow_agent_upgrade,
    )
    .await?
    .ok_or_else(|| AppError::not_found("server.not_found", None, "资源不存在"))?;
    // `country_code` / `group_name` 单独写：空串要落成 NULL（清空），
    // COALESCE 表达不了这个语义。
    if let Some(code) = country_code {
        repo::servers::set_country_code(&state.db.pool, &id, code.as_deref()).await?;
        server.country_code = code;
    }
    if let Some(group) = group_name {
        repo::servers::set_group_name(&state.db.pool, &id, group.as_deref()).await?;
        server.group_name = group;
    }
    if let Some(policy) = &policy {
        repo::servers::set_port_policy(
            &state.db.pool,
            &id,
            policy.start,
            policy.end,
            &policy.allow_json(),
        )
        .await?;
        server.port_start = policy.start;
        server.port_end = policy.end;
        server.port_allow_json = policy.allow_json();
    }
    if internal_changed {
        repo::servers::set_internal_address(&state.db.pool, &id, internal_address.as_deref())
            .await?;
        server.internal_address = internal_address;
    }
    if nic_changed {
        repo::servers::set_nic_name(&state.db.pool, &id, nic_name.as_deref()).await?;
        server.nic_name = nic_name;
    }

    let changes = crate::audit::diff(vec![
        (
            "name",
            json!(before.as_ref().map(|server| &server.name)),
            json!(&server.name),
        ),
        (
            "address",
            json!(before.as_ref().map(|server| &server.address)),
            json!(&server.address),
        ),
        (
            "xray_mode",
            json!(before.as_ref().map(|server| &server.xray_mode)),
            json!(&server.xray_mode),
        ),
        (
            "allow_agent_upgrade",
            json!(before.as_ref().map(|server| server.allow_agent_upgrade)),
            json!(server.allow_agent_upgrade),
        ),
        (
            "country_code",
            json!(before
                .as_ref()
                .and_then(|server| server.country_code.as_deref())),
            json!(server.country_code.as_deref()),
        ),
        (
            "group_name",
            json!(before
                .as_ref()
                .and_then(|server| server.group_name.as_deref())),
            json!(server.group_name.as_deref()),
        ),
        (
            "port_start",
            json!(before.as_ref().and_then(|server| server.port_start)),
            json!(server.port_start),
        ),
        (
            "port_end",
            json!(before.as_ref().and_then(|server| server.port_end)),
            json!(server.port_end),
        ),
        (
            "port_allow",
            json!(before
                .as_ref()
                .map(|server| port_policy::parse_allow_json_vec(&server.port_allow_json))
                .unwrap_or_default()),
            json!(port_policy::parse_allow_json_vec(&server.port_allow_json)),
        ),
        (
            "internal_address",
            json!(before
                .as_ref()
                .and_then(|server| server.internal_address.as_deref())),
            json!(server.internal_address.as_deref()),
        ),
        (
            "nic_name",
            json!(before
                .as_ref()
                .and_then(|server| server.nic_name.as_deref())),
            json!(server.nic_name.as_deref()),
        ),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "server.update",
        &id,
        json!({ "name": &server.name, "changes": changes }),
    )
    .await;

    let base = crate::routes::install::external_base(&headers);
    Ok(Json(
        json!({ "server": server_view(&server, &base, None)? }),
    ))
}

/// 重置连接令牌：旧 token 立即失效，新明文 token 只在这里返回一次。
///
/// 与创建一样，审计只记动作与目标，绝不落明文 token。
pub async fn rotate_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let Some((server, token)) = repo::servers::rotate_token(&state.db.pool, &id).await? else {
        return Err(AppError::not_found("server.not_found", None, "资源不存在"));
    };
    crate::audit::record(
        &state,
        &user.0,
        "server.token_rotated",
        &server.id,
        json!({
            "name": &server.name,
            "address": &server.address,
            "group_name": &server.group_name,
        }),
    )
    .await;

    let base = crate::routes::install::external_base(&headers);
    Ok(Json(json!({
        "token": token,
        "install_command": install_command(&base, &token),
    })))
}

#[derive(Deserialize)]
pub struct AgentUpgradeRequest {
    /// 目标版本，例如 `0.6.0` 或 `v0.6.0`；空串/缺省 = 解析最新 Release。
    #[serde(default)]
    pub version: String,
}

async fn load_server(state: &AppState, id: &str) -> AppResult<Server> {
    repo::servers::find_by_id(&state.db.pool, id)
        .await
        .map_err(|error| match error.downcast_ref::<sqlx::Error>() {
            Some(sqlx::Error::RowNotFound) => {
                AppError::not_found("server.not_found", None, "资源不存在")
            }
            _ => AppError::Internal(error),
        })
}

/// 解析目标版本：留空 = 最新 Release（结果缓存 5 分钟），否则只校验格式。
///
/// 单台接口和批量创建都需要同一套规则，所以抽到这里，避免两处漂移。
pub(crate) async fn resolve_upgrade_version(
    state: &AppState,
    requested: &str,
) -> AppResult<String> {
    let requested = requested.trim();
    let version = if requested.is_empty() {
        if let Some(cached) = state.latest_version.get() {
            cached
        } else {
            let Some(latest) =
                crate::routes::install::fetch_latest_version(&state.agent_release).await
            else {
                return Err(AppError::coded(
                    "agent.upgrade.version_unavailable",
                    None,
                    "无法获取最新版本，请显式指定 version（例如 0.6.0）",
                ));
            };
            state.latest_version.put(&latest);
            latest
        }
    } else {
        requested.to_string()
    };
    if !release::is_valid_version(&version) {
        return Err(AppError::coded(
            "agent.upgrade.version_invalid",
            Some(json!({ "version": version })),
            format!("版本号格式不合法：{version}（示例：0.6.0 或 v0.6.0）"),
        ));
    }
    Ok(version)
}

/// 触发单台 Agent 自升级；HTTP 单台接口与批量 runner 共用这一份逻辑。
///
/// 后台任务没有请求头，下发计划里的主控地址按环境变量推断。
pub(crate) async fn trigger_single_upgrade(
    state: &AppState,
    server_id: &str,
    version: &str,
) -> AppResult<AgentUpgrade> {
    trigger_single_upgrade_with_base(
        state,
        server_id,
        version,
        &super::desired::default_base_url(),
    )
    .await
}

/// 同 [`trigger_single_upgrade`]，但显式指定主控对外地址。
///
/// HTTP 入口用请求头里的 `Host` / `X-Forwarded-Proto`；批量 runner 走默认地址。
pub(crate) async fn trigger_single_upgrade_with_base(
    state: &AppState,
    server_id: &str,
    version: &str,
    base_url: &str,
) -> AppResult<AgentUpgrade> {
    let server = load_server(state, server_id).await?;

    if !server.allow_agent_upgrade {
        return Err(AppError::coded(
            "agent.upgrade.disabled",
            None,
            "该服务器未开启 Agent 自升级（allow_agent_upgrade = false），请先开启后再试",
        ));
    }
    if !release::is_valid_version(version) {
        return Err(AppError::coded(
            "agent.upgrade.version_invalid",
            Some(json!({ "version": version })),
            format!("版本号格式不合法：{version}（示例：0.6.0 或 v0.6.0）"),
        ));
    }

    // 心跳没带架构时回落到主控配置；带了但不在白名单就必须拒绝，不能发错产物。
    let arch = server.arch.trim();
    if !arch.is_empty() && super::desired::target_for_arch(arch).is_none() {
        return Err(AppError::coded(
            "agent.upgrade.arch_unsupported",
            Some(json!({ "arch": arch })),
            format!("不支持的 CPU 架构：{arch}（仅支持 x86_64 / aarch64）"),
        ));
    }

    let current = server.agent_version.as_deref().unwrap_or("").trim();
    if current.is_empty() {
        return Err(AppError::coded(
            "agent.upgrade.current_unknown",
            None,
            "服务器尚未上报 Agent 版本，无法判断升级方向；请先让 Agent 上线并发送一次心跳",
        ));
    }
    if !release::is_newer(version, current) {
        return Err(AppError::coded(
            "agent.upgrade.not_newer",
            Some(json!({ "current": current, "target": version })),
            format!(
                "目标版本 {version} 必须比当前 Agent 版本 {current} 新（不支持降级，也不支持重复升级到同一版本）"
            ),
        ));
    }

    if let Some(latest) = repo::agent_upgrades::latest(&state.db.pool, server_id).await? {
        if latest.status == "pending" {
            return Err(AppError::coded(
                "agent.upgrade.in_progress",
                Some(json!({
                    "current": &latest.from_version,
                    "target": &latest.to_version,
                })),
                format!(
                    "该服务器已有进行中的升级（{} → {}），请等待心跳确认完成后再触发",
                    latest.from_version, latest.to_version
                ),
            ));
        }
    }

    let upgrade = repo::agent_upgrades::create(&state.db.pool, server_id, current, version).await?;
    repo::servers::set_agent_target_version(&state.db.pool, server_id, Some(version)).await?;

    // 标脏：断流 worker 下次 apply 会带上（或已完成的）升级计划。
    state.enforcement.mark_server_dirty(server_id);

    // 立即下发一次：后台对账会因「Xray 配置未变」跳过，不能只依赖它。
    let refreshed = repo::servers::find_by_id(&state.db.pool, server_id).await?;
    if let Err(error) = super::desired::apply(state, &refreshed, base_url).await {
        tracing::warn!(server = %refreshed.name, error = %error, "触发升级后立即下发失败（已标脏，稍后重试）");
    }

    Ok(upgrade)
}

/// 触发一次 Agent 自升级。
///
/// 只写「期望版本」这条状态；Agent 收到期望态后自己下载、验签、替换、重启。
/// 这里额外立即 apply 一次，避免后台对账因为「Xray 配置没变」而跳过下发，
/// 让升级计划能第一时间到达在线 Agent。
pub async fn trigger_agent_upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<AgentUpgradeRequest>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;

    // 先确认服务器存在且允许升级，再做可能回源 GitHub 的版本解析：
    // 未知 server id 不应因为空版本先去打网络，错误优先级保持 404 > 400。
    let server = load_server(&state, &id).await?;
    if !server.allow_agent_upgrade {
        return Err(AppError::coded(
            "agent.upgrade.disabled",
            None,
            "该服务器未开启 Agent 自升级（allow_agent_upgrade = false），请先开启后再试",
        ));
    }

    // 前端拿不到版本列表，留空 = 使用最新 Release；结果缓存 5 分钟。
    let version = resolve_upgrade_version(&state, &req.version).await?;
    let base = super::install::external_base(&headers);
    let upgrade = trigger_single_upgrade_with_base(&state, &id, &version, &base).await?;

    crate::audit::record(
        &state,
        &user.0,
        "agent.upgrade",
        &id,
        json!({
            "from": &upgrade.from_version,
            "to": &upgrade.to_version,
            "upgrade_id": &upgrade.id,
        }),
    )
    .await;

    Ok(Json(json!({ "upgrade": upgrade })))
}

/// 某台服务器的 Agent 升级历史，最新在前。
pub async fn list_agent_upgrades(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;
    let server = load_server(&state, &id).await?;
    let items = repo::agent_upgrades::list_by_server(&state.db.pool, &server.id).await?;
    Ok(Json(json!({ "items": items })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;
    let removed = repo::servers::find_by_id(&state.db.pool, &id).await.ok();
    if !repo::servers::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found("server.not_found", None, "资源不存在"));
    }
    if let Some(removed) = removed {
        crate::audit::record(
            &state,
            &user.0,
            "server.delete",
            &id,
            json!({
                "name": &removed.name,
                "address": &removed.address,
                "xray_mode": &removed.xray_mode,
            }),
        )
        .await;
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;

    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use pierwave_domain::Db;

    async fn setup() -> (Router, AppState, String) {
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
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
        )
    }

    async fn send(
        app: &Router,
        cookie: &str,
        method: Method,
        uri: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("cookie", cookie)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// 安装脚本是 text/x-shellscript，不是 JSON：单独读原文。
    async fn get_text(app: &Router, uri: &str) -> (StatusCode, String) {
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tokio::test]
    async fn patch_updates_and_delete_cascades_nodes() {
        let (app, state, cookie) = setup().await;

        let (_, created) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"hk-1","address":"1.2.3.4"}),
        )
        .await;
        let id = created["server"]["id"].as_str().unwrap().to_string();
        repo::nodes::create(
            &state.db.pool,
            &id,
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

        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"name":"hk-2"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(patched["server"]["name"], "hk-2");
        assert_eq!(patched["server"]["xray_mode"], "external");
        assert_eq!(
            patched["server"]["address"], "1.2.3.4",
            "没传的字段不应被清空"
        );

        let (status, _) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"name":"  "}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, body) = send(
            &app,
            &cookie,
            Method::DELETE,
            &format!("/api/v1/servers/{id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);

        let nodes = repo::nodes::list_by_server(&state.db.pool, &id)
            .await
            .unwrap();
        assert!(nodes.is_empty(), "服务器删除后节点应级联清理");

        let (status, _) = send(
            &app,
            &cookie,
            Method::DELETE,
            &format!("/api/v1/servers/{id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// 国家/地区代码：创建与 PATCH 都接受两位大写字母，空串可清空；
    /// 小写、数字、超长都拒绝，避免前端拿不到能转国旗的代码。
    #[tokio::test]
    async fn country_code_is_validated_and_editable() {
        let (app, _state, cookie) = setup().await;

        let (status, created) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"hk-1","address":"1.2.3.4","country_code":"hk"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{created}");
        assert_eq!(created["code"], "server.country_code_invalid");

        let (status, created) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"hk-1","address":"1.2.3.4","country_code":"HK"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert_eq!(created["server"]["country_code"], "HK");
        let id = created["server"]["id"].as_str().unwrap().to_string();

        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"country_code":"jp"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{patched}");
        assert_eq!(patched["code"], "server.country_code_invalid");

        // `ZZ` 是用户分配代码，不在官方白名单：必须拒绝，前端才会显示地球。
        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"country_code":"ZZ"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{patched}");
        assert_eq!(patched["code"], "server.country_code_invalid");

        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"country_code":"JP"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["server"]["country_code"], "JP");

        // 空串 = 清空；列表接口也必须带出这个字段（null）。
        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"country_code":""}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert!(patched["server"]["country_code"].is_null());

        let (status, listed) =
            send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert!(listed["items"][0].get("country_code").is_some(), "{listed}");
        assert!(listed["items"][0]["country_code"].is_null(), "{listed}");
    }

    /// 列表接口带只读节点统计：总数、启用数、按节点数排序的协议（最多 4 个）。
    #[tokio::test]
    async fn list_includes_read_only_node_stats() {
        let (app, state, cookie) = setup().await;

        let (_, created) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"hk-1","address":"1.2.3.4","group_name":"香港"}),
        )
        .await;
        let id = created["server"]["id"].as_str().unwrap().to_string();

        let (_, created) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"empty","address":"5.6.7.8"}),
        )
        .await;
        let empty_id = created["server"]["id"].as_str().unwrap().to_string();

        for (tag, protocol, enabled) in [
            ("vless-1", "vless", true),
            ("vless-2", "vless", false),
            ("vmess-1", "vmess", true),
        ] {
            repo::nodes::create(
                &state.db.pool,
                &id,
                repo::nodes::NewNode {
                    tag: Some(tag.into()),
                    name: tag.into(),
                    protocol: protocol.into(),
                    transport: "tcp".into(),
                    security: "none".into(),
                    port: 443,
                    public_port: None,
                    config_json: "{}".into(),
                    enabled,
                    cert_id: None,
                    bandwidth_kbps: None,
                },
            )
            .await
            .unwrap();
        }

        let (status, listed) =
            send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{listed}");

        let hk = listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .unwrap();
        assert_eq!(hk["group_name"], "香港");
        assert_eq!(hk["node_count"], 3);
        assert_eq!(hk["node_enabled_count"], 2);
        assert_eq!(hk["node_protocols"], serde_json::json!(["vless", "vmess"]));

        let empty = listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == empty_id)
            .unwrap();
        assert_eq!(empty["node_count"], 0);
        assert_eq!(empty["node_enabled_count"], 0);
        assert_eq!(empty["node_protocols"], serde_json::json!([]));
    }

    /// 内联 Xray 从未实现过：留着这个选项只会让用户以为它可用。
    #[tokio::test]
    async fn embedded_xray_mode_is_rejected() {
        let (app, _state, cookie) = setup().await;
        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"x","address":"1.2.3.4","xray_mode":"embedded"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"].as_str().unwrap().contains("内联"));
        assert_eq!(body["code"], "server.xray_mode_unsupported");
        assert_eq!(body["params"]["mode"], "embedded");
    }

    // ---- Agent 自升级 ----

    async fn seed_server(state: &AppState, allow: bool, agent_version: &str) -> String {
        let (server, _token) = repo::servers::create(&state.db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        repo::servers::update(&state.db.pool, &server.id, None, None, None, Some(allow))
            .await
            .unwrap();
        repo::servers::update_health(
            &state.db.pool,
            &server.id,
            agent_version,
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        server.id
    }

    /// 和 `setup` 一样，但把「最新版本」指向本地 JSON，测试绝不打 GitHub。
    async fn setup_with_latest(latest_url: String) -> (Router, AppState, String) {
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
        let mut state = AppState::new(db, "web/dist");
        state.agent_release.latest_url = latest_url;
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
        )
    }

    fn latest_file(tag: &str) -> (PathBuf, String) {
        let path =
            std::env::temp_dir().join(format!("pierwave-latest-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, format!(r#"{{"tag_name":"{tag}"}}"#)).unwrap();
        (path.clone(), path.to_string_lossy().into_owned())
    }

    #[tokio::test]
    async fn agent_upgrade_rejects_downgrade_and_disabled_switch() {
        let (app, state, cookie) = setup().await;

        let id = seed_server(&state, true, "0.6.0").await;
        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/agent-upgrade"),
            serde_json::json!({"version":"0.5.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let message = body["error"].as_str().unwrap();
        assert!(message.contains("不支持降级"), "{message}");

        let id = seed_server(&state, false, "0.5.0").await;
        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/agent-upgrade"),
            serde_json::json!({"version":"0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"].as_str().unwrap().contains("未开启"));
    }

    #[tokio::test]
    async fn agent_upgrade_creates_pending_and_rejects_duplicate() {
        let (app, state, cookie) = setup().await;
        let id = seed_server(&state, true, "0.5.0").await;

        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/agent-upgrade"),
            serde_json::json!({"version":"0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["upgrade"]["status"], "pending");
        assert_eq!(body["upgrade"]["from_version"], "0.5.0");
        assert_eq!(body["upgrade"]["to_version"], "0.6.0");

        let server = repo::servers::find_by_id(&state.db.pool, &id)
            .await
            .unwrap();
        assert_eq!(server.agent_target_version.as_deref(), Some("0.6.0"));
        assert!(server.allow_agent_upgrade);

        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/agent-upgrade"),
            serde_json::json!({"version":"0.7.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"].as_str().unwrap().contains("进行中"));

        let (status, body) = send(
            &app,
            &cookie,
            Method::GET,
            &format!("/api/v1/servers/{id}/agent-upgrades"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 1);
        assert_eq!(body["items"][0]["to_version"], "0.6.0");
    }

    #[tokio::test]
    async fn empty_version_resolves_latest_and_caches_it() {
        let (latest_path, latest_url) = latest_file("v0.6.0");
        let (app, state, cookie) = setup_with_latest(latest_url).await;

        let first = seed_server(&state, true, "0.5.0").await;
        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{first}/agent-upgrade"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["upgrade"]["to_version"], "v0.6.0");

        // 删掉「GitHub API」后第二台服务器仍能留空提交：说明走了 5 分钟缓存。
        std::fs::remove_file(latest_path).unwrap();
        let second = seed_server(&state, true, "0.5.0").await;
        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{second}/agent-upgrade"),
            serde_json::json!({"version": ""}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "缓存应避免再次回源：{body}");
        assert_eq!(body["upgrade"]["to_version"], "v0.6.0");
    }

    #[tokio::test]
    async fn empty_version_fails_with_chinese_hint_when_latest_unavailable() {
        let (app, state, cookie) = setup_with_latest("/definitely/not/a/latest.json".into()).await;
        let id = seed_server(&state, true, "0.5.0").await;
        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/agent-upgrade"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"].as_str().unwrap().contains("无法获取最新版本"));
    }

    #[tokio::test]
    async fn unsupported_arch_is_rejected() {
        let (app, state, cookie) = setup().await;
        let id = seed_server(&state, true, "0.5.0").await;
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.5.0",
            &repo::servers::HealthSnapshot {
                arch: "mips".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/agent-upgrade"),
            serde_json::json!({"version":"0.6.0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("不支持的 CPU 架构"));
    }

    /// API 契约：`allow_agent_upgrade` 必须是 boolean，不是 0/1。
    #[tokio::test]
    async fn server_view_serializes_allow_agent_upgrade_as_boolean() {
        let (app, state, cookie) = setup().await;
        seed_server(&state, true, "0.5.0").await;

        let (status, body) = send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["items"][0];
        assert_eq!(
            server["allow_agent_upgrade"].as_bool(),
            Some(true),
            "必须是 JSON boolean：{server}"
        );
        assert!(server["agent_target_version"].is_null());
    }

    /// 管理端列表必须带出新增的 OS / 虚拟化 / 国家字段：
    /// 旧 Agent 没有 os_* / virt 时为 null，arch 为空串。
    #[tokio::test]
    async fn server_list_exposes_os_virt_and_country() {
        let (app, state, cookie) = setup().await;
        let (server, _token) = repo::servers::create_with_country(
            &state.db.pool,
            "hk-1",
            "1.2.3.4",
            "external",
            Some("HK"),
        )
        .await
        .unwrap();
        repo::servers::update_health(
            &state.db.pool,
            &server.id,
            "0.7.2",
            &repo::servers::HealthSnapshot {
                arch: "x86_64".into(),
                os_name: Some("Debian GNU/Linux".into()),
                os_version: Some("12".into()),
                virt: Some("kvm".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let (status, body) = send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let row = &body["items"][0];
        assert_eq!(row["country_code"], "HK");
        assert_eq!(row["os_name"], "Debian GNU/Linux");
        assert_eq!(row["os_version"], "12");
        assert_eq!(row["virt"], "kvm");
        assert_eq!(row["arch"], "x86_64");
    }

    /// 管理端列表必须带出 `realm_available`：null = 未知（旧 Agent），
    /// true / false 是 Agent 明确上报的静态事实，前端据此在创建前提示。
    #[tokio::test]
    async fn server_list_exposes_realm_availability() {
        let (app, state, cookie) = setup().await;
        let (server, _token) = repo::servers::create(&state.db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();

        // 从未上报过：字段存在且为 null，不能是 false。
        let (status, body) = send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let row = &body["items"][0];
        assert!(row.get("realm_available").is_some(), "{row}");
        assert!(row["realm_available"].is_null(), "{row}");

        for (reported, expected) in [(true, true), (false, false)] {
            repo::servers::update_health(
                &state.db.pool,
                &server.id,
                "0.8.0",
                &repo::servers::HealthSnapshot {
                    realm_available: Some(reported),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            let (status, body) =
                send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                body["items"][0]["realm_available"], expected,
                "心跳写入后列表必须原样带出：{body}"
            );
        }

        // 旧 Agent 再接回来：没有该字段 = 未知，重新落 NULL。
        repo::servers::update_health(
            &state.db.pool,
            &server.id,
            "0.7.0",
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        let (status, body) = send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["items"][0]["realm_available"].is_null(), "{body}");
    }

    /// 离线只改 status，不能清空最后一次心跳带来的 realm 可用性。
    #[tokio::test]
    async fn offline_server_keeps_last_realm_availability() {
        let (app, state, cookie) = setup().await;
        let (server, _token) = repo::servers::create(&state.db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        repo::servers::update_health(
            &state.db.pool,
            &server.id,
            "0.8.0",
            &repo::servers::HealthSnapshot {
                realm_available: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::servers::mark_offline(&state.db.pool, &server.id)
            .await
            .unwrap();

        let (status, body) = send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let row = &body["items"][0];
        assert_eq!(row["status"], "offline");
        assert_eq!(
            row["realm_available"], false,
            "离线服务器必须保留最后一次上报值：{row}"
        );
    }

    // ---- 连接令牌重置 / 静态命令 ----

    /// 创建响应是唯一可能带 `commands.install` 的地方；列表里必须是 null。
    #[tokio::test]
    async fn server_json_exposes_static_commands_and_null_install_in_list() {
        let (app, _state, cookie) = setup().await;
        let (status, created) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"hk-1","address":"1.2.3.4"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");

        let token = created["token"].as_str().unwrap();
        let install = created["install_command"].as_str().unwrap();
        assert!(
            install.contains(token),
            "安装命令必须带一次性 token：{install}"
        );
        assert_eq!(created["server"]["commands"]["install"], install);

        let commands = &created["server"]["commands"];
        assert_eq!(commands["stop"], "systemctl stop pierwave-agent");
        assert_eq!(commands["restart"], "systemctl restart pierwave-agent");
        let upgrade = commands["upgrade"].as_str().unwrap();
        let uninstall = commands["uninstall"].as_str().unwrap();
        assert!(
            upgrade.contains("/api/agent/install.sh") && upgrade.ends_with("| sh -s -- upgrade"),
            "{upgrade}"
        );
        assert!(
            uninstall.contains("/api/agent/install.sh")
                && uninstall.ends_with("| sh -s -- uninstall"),
            "{uninstall}"
        );
        assert!(
            !upgrade.contains(token),
            "静态命令不能包含 token：{upgrade}"
        );
        assert!(
            !uninstall.contains(token),
            "静态命令不能包含 token：{uninstall}"
        );

        let (status, listed) =
            send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert!(
            listed["items"][0]["commands"]["install"].is_null(),
            "{listed}"
        );
        assert_eq!(
            listed["items"][0]["commands"]["stop"],
            "systemctl stop pierwave-agent"
        );
    }

    /// 重置后旧 token 立即失效；新 token 能重新取安装脚本；审计里不能出现明文 token。
    #[tokio::test]
    async fn token_rotation_invalidates_old_token_and_audits() {
        let (app, state, cookie) = setup().await;
        let (_, created) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"hk-1","address":"1.2.3.4"}),
        )
        .await;
        let id = created["server"]["id"].as_str().unwrap().to_string();
        let old_token = created["token"].as_str().unwrap().to_string();

        let (status, body) =
            get_text(&app, &format!("/api/agent/install.sh?token={old_token}")).await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let (status, rotated) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/token"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{rotated}");
        let new_token = rotated["token"].as_str().unwrap().to_string();
        assert_ne!(new_token, old_token);
        let install = rotated["install_command"].as_str().unwrap();
        assert!(install.contains(&new_token), "{install}");
        assert!(install.contains("| sudo bash"), "{install}");

        // 旧 token 立刻不能下载安装脚本。
        let (status, body) =
            get_text(&app, &format!("/api/agent/install.sh?token={old_token}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        // 新 token 可用。
        let (status, body) =
            get_text(&app, &format!("/api/agent/install.sh?token={new_token}")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(&new_token));

        // 仓储层也只认新哈希。
        assert!(repo::servers::find_by_token(&state.db.pool, &old_token)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            repo::servers::find_by_token(&state.db.pool, &new_token)
                .await
                .unwrap()
                .unwrap()
                .id,
            id
        );

        // 审计：动作正确，detail 里绝不能出现明文 token。
        let filter = repo::audit::Filter {
            action_prefixes: vec!["server.token_rotated".into()],
            ..Default::default()
        };
        let page = repo::audit::page(&state.db.pool, &filter, None, 10)
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1, "{:?}", page.items);
        assert_eq!(page.items[0].target.as_deref(), Some(id.as_str()));
        let detail = page.items[0].detail.clone().unwrap_or(Value::Null);
        assert!(
            !detail.to_string().contains(&new_token),
            "审计不能落明文 token：{detail}"
        );
        assert!(
            !detail.to_string().contains(&old_token),
            "审计不能落明文 token：{detail}"
        );

        // 再重置一次：上一个新 token 也必须立即失效。
        let (status, _) = send(
            &app,
            &cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/token"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = get_text(&app, &format!("/api/agent/install.sh?token={new_token}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn token_rotation_requires_admin_and_known_server() {
        let (app, state, cookie) = setup().await;

        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers/00000000-0000-0000-0000-000000000000/token",
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["code"], "server.not_found");

        let bob = repo::users::create(
            &state.db.pool,
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
        let (bob_token, _) = repo::sessions::create(&state.db.pool, &bob.id, 3600, None)
            .await
            .unwrap();
        let bob_cookie = format!("{}={bob_token}", crate::auth::SESSION_COOKIE);

        let (_, created) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"hk-1","address":"1.2.3.4"}),
        )
        .await;
        let id = created["server"]["id"].as_str().unwrap();
        let (status, body) = send(
            &app,
            &bob_cookie,
            Method::POST,
            &format!("/api/v1/servers/{id}/token"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }

    // ---- 服务器分组 ----

    #[tokio::test]
    async fn group_name_is_trimmed_validated_and_editable() {
        let (app, _state, cookie) = setup().await;

        let (status, created) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"hk-1","address":"1.2.3.4","group_name":"  香港  "}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert_eq!(created["server"]["group_name"], "香港");
        let id = created["server"]["id"].as_str().unwrap().to_string();

        // 只改名不能把分组清空。
        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"name":"hk-2"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["server"]["group_name"], "香港");

        // 空串 / 纯空白 = 清空。
        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"group_name":"   "}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert!(patched["server"]["group_name"].is_null(), "{patched}");

        // Web 编辑弹窗用显式 null 表示清空：必须与「没传」区分开。
        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"group_name":"日本"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["server"]["group_name"], "日本");
        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"group_name": null}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert!(patched["server"]["group_name"].is_null(), "{patched}");

        // 32 个字符是上限，33 个拒绝。
        let max = "组".repeat(32);
        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"group_name": max}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["server"]["group_name"], max);

        let too_long = "组".repeat(33);
        let (status, body) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            serde_json::json!({"group_name": too_long}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "server.group_name_too_long");
        assert_eq!(body["params"]["max"], 32);

        // 换行 / NUL 等控制字符属于非法字符。
        for invalid in ["a\nb", "a\u{0000}b", "a\tb"] {
            let (status, body) = send(
                &app,
                &cookie,
                Method::PATCH,
                &format!("/api/v1/servers/{id}"),
                serde_json::json!({"group_name": invalid}),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(body["code"], "server.group_name_invalid", "{body}");
        }

        // 创建路径同样校验；缺省 = null。
        let (status, body) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"jp-1","address":"5.6.7.8","group_name":"a\nb"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "server.group_name_invalid");

        let (status, plain) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"jp-2","address":"5.6.7.9"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{plain}");
        assert!(plain["server"]["group_name"].is_null(), "{plain}");
    }

    #[tokio::test]
    async fn group_name_is_returned_in_list() {
        let (app, _state, cookie) = setup().await;
        send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            serde_json::json!({"name":"hk-1","address":"1.2.3.4","group_name":"香港"}),
        )
        .await;

        let (status, listed) =
            send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert_eq!(listed["items"][0]["group_name"], "香港");
    }

    /// 管理端列表复用 `servers.latency_ms`：有心跳值就是 number，没有就是 null。
    #[tokio::test]
    async fn server_list_exposes_heartbeat_latency() {
        let (app, state, cookie) = setup().await;
        let id = seed_server(&state, true, "0.5.0").await;

        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.5.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(17),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let (status, body) = send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"][0]["latency_ms"], 17);

        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.5.0",
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        let (status, body) = send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            body["items"][0]["latency_ms"].is_null(),
            "没有探测结果时必须序列化为 null：{body}"
        );
    }

    /// 端口策略与内网地址：创建/修改都校验，`port_allow` 对外是数组，
    /// PATCH 用三态区分「不改 / 清空 / 覆盖」。
    #[tokio::test]
    async fn port_policy_and_internal_address_round_trip_and_validate() {
        let (app, _state, cookie) = setup().await;
        let uri = "/api/v1/servers";

        for body in [
            json!({"name":"p1","address":"1.2.3.4","port_start":31000,"port_end":30000}),
            json!({"name":"p1","address":"1.2.3.4","port_start":30000}),
            json!({"name":"p1","address":"1.2.3.4","port_start":0,"port_end":100}),
            json!({"name":"p1","address":"1.2.3.4","port_start":30000,"port_end":70000}),
        ] {
            let (status, value) = send(&app, &cookie, Method::POST, uri, body).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
            assert_eq!(value["code"], "server.port_range_invalid", "{value}");
        }

        for allow in [json!([0]), json!([70000]), json!([443, -1])] {
            let (status, value) = send(
                &app,
                &cookie,
                Method::POST,
                uri,
                json!({"name":"p1","address":"1.2.3.4","port_allow": allow}),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
            assert_eq!(value["code"], "server.port_allow_invalid", "{value}");
        }

        let (status, created) = send(
            &app,
            &cookie,
            Method::POST,
            uri,
            json!({
                "name": "hk-1",
                "address": "1.2.3.4",
                "port_start": 30000,
                "port_end": 31000,
                "port_allow": [8443, 443, 8443],
                "internal_address": " 10.0.0.9 ",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let server = &created["server"];
        assert_eq!(server["port_start"], 30000);
        assert_eq!(server["port_end"], 31000);
        assert_eq!(
            server["port_allow"],
            json!([443, 8443]),
            "对外必须是升序去重的数组：{created}"
        );
        assert_eq!(server["internal_address"], "10.0.0.9");
        let id = server["id"].as_str().unwrap().to_string();

        // PATCH 只改内网地址：端口策略原样保留。
        let patch_uri = format!("/api/v1/servers/{id}");
        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &patch_uri,
            json!({"internal_address": "10.0.0.10"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["server"]["port_start"], 30000);
        assert_eq!(patched["server"]["port_allow"], json!([443, 8443]));
        assert_eq!(patched["server"]["internal_address"], "10.0.0.10");

        // 显式 null 清空区间，额外端口继续保留。
        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &patch_uri,
            json!({"port_start": null, "port_end": null}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert!(patched["server"]["port_start"].is_null());
        assert!(patched["server"]["port_end"].is_null());
        assert_eq!(patched["server"]["port_allow"], json!([443, 8443]));

        // 非法组合（只给一边 / 倒置）必须 400，且不落库。
        for body in [
            json!({"port_start": 32000}),
            json!({"port_start": 32000, "port_end": 31000}),
        ] {
            let (status, value) =
                send(&app, &cookie, Method::PATCH, &patch_uri, body.clone()).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
            assert_eq!(value["code"], "server.port_range_invalid", "{value}");
        }
        let (status, listed) = send(&app, &cookie, Method::GET, uri, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert!(listed["items"][0]["port_start"].is_null(), "{listed}");

        // 清空额外端口 + 内网地址。
        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &patch_uri,
            json!({"port_allow": null, "internal_address": null}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["server"]["port_allow"], json!([]));
        assert!(patched["server"]["internal_address"].is_null());
    }

    /// 网卡：未上报时允许保存并标 nic_unverified；上报后必须命中列表，
    /// 未知网卡 400 且不落库；服务器 JSON 能看到最近上报的列表。
    #[tokio::test]
    async fn nic_name_validation_and_unverified_flag() {
        let (app, state, cookie) = setup().await;

        let (status, created) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            json!({"name":"hk-1","address":"1.2.3.4","nic_name":" eth0 "}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let id = created["server"]["id"].as_str().unwrap().to_string();
        assert_eq!(created["server"]["nic_name"], "eth0", "网卡名要 trim");
        assert_eq!(
            created["server"]["nic_unverified"], true,
            "新服务器没有心跳，必须提示网卡未验证"
        );
        assert_eq!(created["server"]["interfaces"], json!([]));

        // 上报过但当前没有网卡：interfaces 仍为空，但不再提示「尚未上报」。
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.9.5",
            &repo::servers::HealthSnapshot {
                interfaces_json: "[]".into(),
                interfaces_reported: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let (status, reported_empty) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            json!({"name":"hk-1"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{reported_empty}");
        assert_eq!(reported_empty["server"]["interfaces"], json!([]));
        assert_eq!(
            reported_empty["server"]["nic_unverified"], false,
            "上报过空列表 = 没有可用网卡，不是尚未上报"
        );
        // 上报过但列表为空：任何网卡都不存在于列表里，必须拒绝。
        let (status, body) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{id}"),
            json!({"nic_name":"eth0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "server.nic_name_not_found", "{body}");

        // 模拟心跳上报：eth0 有地址，eth1 没有地址。
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.9.5",
            &repo::servers::HealthSnapshot {
                interfaces_json:
                    r#"[{"name":"eth0","addresses":["10.0.0.2"]},{"name":"eth1","addresses":[]}]"#
                        .into(),
                interfaces_reported: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let patch_uri = format!("/api/v1/servers/{id}");
        let (status, body) = send(
            &app,
            &cookie,
            Method::PATCH,
            &patch_uri,
            json!({"nic_name":"eth9"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "server.nic_name_not_found", "{body}");
        assert!(
            body["params"]["interfaces"]
                .as_str()
                .unwrap()
                .contains("eth0"),
            "{body}"
        );
        assert_eq!(
            repo::servers::find_by_id(&state.db.pool, &id)
                .await
                .unwrap()
                .nic_name
                .as_deref(),
            Some("eth0"),
            "400 时不能把未知网卡写进库"
        );

        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &patch_uri,
            json!({"nic_name":"eth1"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["server"]["nic_name"], "eth1");
        assert_eq!(
            patched["server"]["nic_unverified"], false,
            "已上报且命中时不再是 unverified"
        );
        assert_eq!(patched["server"]["interfaces"][0]["name"], "eth0");
        assert_eq!(
            patched["server"]["interfaces"][0]["addresses"][0],
            "10.0.0.2"
        );

        // 列表页同样带出 interfaces 与 nic_unverified。
        let (status, listed) =
            send(&app, &cookie, Method::GET, "/api/v1/servers", Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert_eq!(listed["items"][0]["interfaces"][1]["name"], "eth1");
        assert_eq!(listed["items"][0]["nic_unverified"], false);

        // null = 取消限制。
        let (status, cleared) = send(
            &app,
            &cookie,
            Method::PATCH,
            &patch_uri,
            json!({"nic_name":null}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{cleared}");
        assert!(cleared["server"]["nic_name"].is_null());
        assert_eq!(cleared["server"]["nic_unverified"], false);

        // 从未上报过的服务器：PATCH 保存 nic_name 也允许，只提示 unverified。
        let (status, fresh) = send(
            &app,
            &cookie,
            Method::POST,
            "/api/v1/servers",
            json!({"name":"hk-2","address":"5.6.7.8"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{fresh}");
        let fresh_id = fresh["server"]["id"].as_str().unwrap();
        assert_eq!(fresh["server"]["nic_unverified"], true);
        let (status, patched) = send(
            &app,
            &cookie,
            Method::PATCH,
            &format!("/api/v1/servers/{fresh_id}"),
            json!({"nic_name":"eth0"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["server"]["nic_name"], "eth0");
        assert_eq!(patched["server"]["nic_unverified"], true);
        assert_eq!(patched["server"]["interfaces"], json!([]));
    }
}
