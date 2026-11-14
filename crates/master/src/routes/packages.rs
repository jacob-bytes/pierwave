use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::Patch;
use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DIRECTIONS: &[&str] = &["both", "upload", "download"];

/// 去空白、去重。
fn normalize_node_id_list(ids: Vec<String>) -> AppResult<Vec<String>> {
    normalize_id_list(ids, "package.node_scope_invalid", "节点 id 不能为空")
}

/// 去空白、去重；`empty_code` 让调用方区分「节点范围」与「转发服务器白名单」。
fn normalize_id_list(
    ids: Vec<String>,
    empty_code: &'static str,
    empty_message: &'static str,
) -> AppResult<Vec<String>> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let id = id.trim();
        if id.is_empty() {
            return Err(AppError::coded(empty_code, None, empty_message));
        }
        if seen.insert(id.to_string()) {
            out.push(id.to_string());
        }
    }
    Ok(out)
}

/// 自助转发服务器白名单：去空白、去重。
fn normalize_forward_server_ids(ids: Vec<String>) -> AppResult<Vec<String>> {
    normalize_id_list(ids, "package.forward_server_invalid", "服务器 id 不能为空")
}

/// 新建：`None` 与 `Some([])` 语义不同（全部 vs 一个都不给），不能合并。
fn normalize_create_node_ids(raw: Option<Vec<String>>) -> AppResult<Option<Vec<String>>> {
    raw.map(normalize_node_id_list).transpose()
}

/// 更新：缺失 / null / 数组 三态原样保留，只清洗 Value 里的 id。
fn normalize_patch_node_ids(raw: Patch<Vec<String>>) -> AppResult<Patch<Vec<String>>> {
    match raw {
        Patch::Missing => Ok(Patch::Missing),
        Patch::Null => Ok(Patch::Null),
        Patch::Value(ids) => Ok(Patch::Value(normalize_node_id_list(ids)?)),
    }
}

/// 显式指定范围时，所有节点必须真实存在；否则 400 而不是等外键报 500。
async fn validate_node_id_list(state: &AppState, node_ids: &[String]) -> AppResult<()> {
    let missing = repo::nodes::missing_ids(&state.db.pool, node_ids).await?;
    if !missing.is_empty() {
        return Err(AppError::coded(
            "package.node_not_found",
            Some(json!({ "node_ids": &missing })),
            format!("节点不存在：{}", missing.join("、")),
        ));
    }
    Ok(())
}

/// 自助转发配额：0 = 不允许，负数没有意义。
pub(crate) fn validate_forward_limit(limit: i64) -> AppResult<()> {
    if limit < 0 {
        return Err(AppError::coded(
            "package.forward_limit_invalid",
            Some(json!({ "min": 0 })),
            "自助转发条数不能为负数（0 表示不允许）",
        ));
    }
    Ok(())
}

/// 白名单里的服务器必须真实存在；否则 400 而不是等外键报 500。
async fn validate_forward_server_id_list(state: &AppState, server_ids: &[String]) -> AppResult<()> {
    let missing = repo::servers::missing_ids(&state.db.pool, server_ids).await?;
    if !missing.is_empty() {
        return Err(AppError::coded(
            "package.forward_server_not_found",
            Some(json!({ "server_ids": &missing })),
            format!("服务器不存在：{}", missing.join("、")),
        ));
    }
    Ok(())
}

/// 范围真的变化时触发下发。
///
/// 订阅是即时生效的，而服务器配置要等 apply；这里走现有断流去抖队列
/// （[`crate::enforcement::mark_all_servers_dirty`]，30s 合并），避免出现
/// 「订阅里有节点、服务器上没 client」的窗口。失败只记日志，5 分钟对账仍兜底。
async fn mark_dirty_if_scope_changed(
    state: &AppState,
    package_id: &str,
    before: Option<repo::packages::NodeScope>,
    after: Option<repo::packages::NodeScope>,
) {
    let changed = match (before.as_ref(), after.as_ref()) {
        // 新建：未设范围（全部）是默认态，不算变化；显式设了范围才触发。
        (None, Some(after)) => after.explicit,
        (Some(before), Some(after)) => before != after,
        _ => false,
    };
    if !changed {
        return;
    }
    if let Err(error) = crate::enforcement::mark_all_servers_dirty(state).await {
        tracing::error!(%package_id, error = %error, "改套餐节点范围后标记期望态失败");
    }
}

fn normalize_enum(field: &str, value: &str, allowed: &[&str]) -> AppResult<String> {
    let value = value.trim().to_ascii_lowercase();
    if allowed.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(AppError::coded(
            "common.enum_invalid",
            Some(json!({
                "field": field,
                "value": value,
                "allowed": allowed,
            })),
            format!("不支持的{field}：{value}（可选：{}）", allowed.join(" / ")),
        ))
    }
}

pub(crate) fn validate_direction(value: &str) -> AppResult<String> {
    normalize_enum("计费方向", value, DIRECTIONS)
}

pub(crate) fn validate_quota_bytes(quota: Option<i64>) -> AppResult<()> {
    if quota.is_some_and(|quota| quota < 0) {
        return Err(AppError::coded(
            "package.quota_negative",
            None,
            "额度不能为负数",
        ));
    }
    Ok(())
}

pub(crate) fn validate_period_days(period_days: Option<i64>) -> AppResult<()> {
    if period_days.is_some_and(|days| !(1..=3650).contains(&days)) {
        return Err(AppError::coded(
            "package.period_days_invalid",
            Some(json!({ "min": 1, "max": 3650 })),
            "周期天数必须在 1-3650 之间",
        ));
    }
    Ok(())
}

pub(crate) fn validate_reset_day(reset_day: i64) -> AppResult<()> {
    if !(1..=31).contains(&reset_day) {
        return Err(AppError::coded(
            "package.reset_day_invalid",
            Some(json!({ "min": 1, "max": 31 })),
            "重置日必须在 1-31 之间",
        ));
    }
    Ok(())
}

pub(crate) fn validate_node_ratio(node_ratio: f64) -> AppResult<()> {
    if node_ratio.is_finite() && node_ratio > 0.0 && node_ratio <= 10.0 {
        Ok(())
    } else {
        Err(AppError::coded(
            "package.node_ratio_invalid",
            Some(json!({ "max": 10 })),
            "节点倍率必须大于 0 且不超过 10",
        ))
    }
}

/// 限速档位：0 = 不限；上限 10 Gbps。`None`（未配置）同样表示不限。
pub(crate) fn validate_speed_limit_kbps(speed_limit_kbps: Option<i64>) -> AppResult<()> {
    match speed_limit_kbps {
        None => Ok(()),
        Some(kbps) if (0..=10_000_000).contains(&kbps) => Ok(()),
        Some(_) => Err(AppError::coded(
            "package.speed_limit_kbps_invalid",
            Some(json!({ "min": 0, "max": 10_000_000 })),
            "限速档位必须在 0-10000000 kbps 之间（0 表示不限）",
        )),
    }
}

/// 校验规则模板存在；返回去空白后的 id。
pub(crate) async fn validate_rule_template_id(state: &AppState, id: &str) -> AppResult<String> {
    let id = id.trim();
    if id.is_empty() {
        return Err(AppError::coded(
            "rule_template.reference_not_found",
            None,
            "规则模板不存在",
        ));
    }
    if repo::rule_templates::find_by_id(&state.db.pool, id)
        .await?
        .is_none()
    {
        return Err(AppError::coded(
            "rule_template.reference_not_found",
            Some(json!({ "id": id })),
            format!("规则模板不存在：{id}"),
        ));
    }
    Ok(id.to_string())
}

/// 可空版本：`None` 表示不绑定（跟随套餐 / 全局默认），不做校验。
pub(crate) async fn validate_optional_rule_template_id(
    state: &AppState,
    id: Option<&str>,
) -> AppResult<Option<String>> {
    match id {
        Some(id) => Ok(Some(validate_rule_template_id(state, id).await?)),
        None => Ok(None),
    }
}

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let items = repo::packages::list(&state.db.pool).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreatePackage {
    pub name: String,
    #[serde(default)]
    pub quota_bytes: Option<i64>,
    #[serde(default)]
    pub period_days: Option<i64>,
    #[serde(default = "default_direction")]
    pub direction: String,
    #[serde(default = "default_node_ratio")]
    pub node_ratio: f64,
    /// 限速档位（kbps）；缺省 / 0 = 不限。只能映射成 bufferSize，是近似限速。
    #[serde(default)]
    pub speed_limit_kbps: Option<i64>,
    /// 缺省 / `null` = 不限制（全部节点）；`[]` = 一个都不给；数组 = 只给这些节点。
    #[serde(default)]
    pub node_ids: Option<Vec<String>>,
    /// 套餐级规则模板；缺省 / `null` = 不绑定（跟随全局默认）。
    #[serde(default)]
    pub rule_template_id: Option<String>,
    /// 每个用户最多能创建多少条自助转发；缺省 0 = 不允许。
    #[serde(default)]
    pub forward_limit: i64,
    /// 允许自助转发落地的服务器；缺省 `[]` = 一台都不允许。
    #[serde(default)]
    pub forward_server_ids: Vec<String>,
}

fn default_direction() -> String {
    "both".into()
}

fn default_node_ratio() -> f64 {
    1.0
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<CreatePackage>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::coded(
            "package.name_required",
            None,
            "套餐名称不能为空",
        ));
    }
    validate_quota_bytes(req.quota_bytes)?;
    validate_period_days(req.period_days)?;
    let direction = validate_direction(&req.direction)?;
    validate_node_ratio(req.node_ratio)?;
    validate_speed_limit_kbps(req.speed_limit_kbps)?;
    validate_forward_limit(req.forward_limit)?;

    let node_ids = normalize_create_node_ids(req.node_ids)?;
    if let Some(node_ids) = &node_ids {
        validate_node_id_list(&state, node_ids).await?;
    }
    let forward_server_ids = normalize_forward_server_ids(req.forward_server_ids)?;
    validate_forward_server_id_list(&state, &forward_server_ids).await?;
    let rule_template_id =
        validate_optional_rule_template_id(&state, req.rule_template_id.as_deref()).await?;

    let package = repo::packages::create(
        &state.db.pool,
        repo::packages::NewPackage {
            name: name.to_string(),
            quota_bytes: req.quota_bytes,
            period_days: req.period_days,
            direction,
            node_ratio: req.node_ratio,
            speed_limit_kbps: req.speed_limit_kbps,
            rule_template_id,
            node_ids,
        },
    )
    .await?;
    // 迁移 0044 的两列单独写：`packages::create` 的既有调用方（其它模块的测试/
    // 内部流程）不需要感知新字段，默认值 0 / 空表就是「不允许自助转发」。
    if !repo::packages::set_forward_rules(
        &state.db.pool,
        &package.id,
        req.forward_limit,
        &forward_server_ids,
    )
    .await?
    {
        return Err(AppError::Internal(anyhow::anyhow!(
            "套餐创建后写入自助转发规则失败"
        )));
    }
    let package = repo::packages::find_by_id(&state.db.pool, &package.id)
        .await?
        .ok_or_else(|| AppError::not_found("package.not_found", None, "资源不存在"))?;

    let scope = repo::packages::node_scope(&state.db.pool, &package.id).await?;
    mark_dirty_if_scope_changed(&state, &package.id, None, scope).await;

    crate::audit::record(
        &state,
        &user.0,
        "package.create",
        &package.id,
        json!({
            "name": &package.name,
            "quota_bytes": package.quota_bytes,
            "period_days": package.period_days,
            "direction": &package.direction,
            "node_ratio": package.node_ratio,
            "speed_limit_kbps": package.speed_limit_kbps,
            "rule_template_id": package.rule_template_id,
            "node_scope": &package.node_scope,
            "node_count": package.node_count,
            "node_ids": &package.node_ids,
            "forward_limit": package.forward_limit,
            "forward_server_ids": &package.forward_server_ids,
        }),
    )
    .await;

    Ok(Json(json!({ "package": package })))
}

#[derive(Deserialize)]
pub struct UpdatePackage {
    pub name: Option<String>,
    #[serde(default)]
    pub quota_bytes: Patch<i64>,
    #[serde(default)]
    pub period_days: Patch<i64>,
    pub direction: Option<String>,
    pub node_ratio: Option<f64>,
    /// 三态：缺失 = 不动；`null` = 取消限速；数值 = 档位 kbps（0 等价不限）。
    #[serde(default)]
    pub speed_limit_kbps: Patch<i64>,
    /// 三态：缺失 = 不动；`null` = 恢复全部；`[]` = 一个都不给；数组 = 指定。
    #[serde(default)]
    pub node_ids: Patch<Vec<String>>,
    /// 三态：缺失 = 不动；`null` = 解绑；具体 id = 绑定。
    #[serde(default)]
    pub rule_template_id: Patch<String>,
    /// `None` = 不动；`0` = 关闭自助转发；正数 = 每用户条数上限。
    #[serde(default)]
    pub forward_limit: Option<i64>,
    /// `None` = 不动；数组（含 `[]`）= 全量替换白名单。
    #[serde(default)]
    pub forward_server_ids: Option<Vec<String>>,
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<UpdatePackage>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    if req.name.is_none()
        && !req.quota_bytes.is_set()
        && !req.period_days.is_set()
        && req.direction.is_none()
        && req.node_ratio.is_none()
        && !req.speed_limit_kbps.is_set()
        && !req.node_ids.is_set()
        && !req.rule_template_id.is_set()
        && req.forward_limit.is_none()
        && req.forward_server_ids.is_none()
    {
        return Err(AppError::coded(
            "request.no_update_fields",
            None,
            "至少需要提供一个可更新字段",
        ));
    }

    let name = match req.name.as_deref().map(str::trim) {
        Some("") => {
            return Err(AppError::coded(
                "package.name_required",
                None,
                "套餐名称不能为空",
            ))
        }
        other => other.map(str::to_string),
    };
    if req.quota_bytes.is_set() {
        validate_quota_bytes(req.quota_bytes.value())?;
    }
    if req.period_days.is_set() {
        validate_period_days(req.period_days.value())?;
    }
    let direction = match &req.direction {
        Some(direction) => Some(validate_direction(direction)?),
        None => None,
    };
    if let Some(node_ratio) = req.node_ratio {
        validate_node_ratio(node_ratio)?;
    }
    if req.speed_limit_kbps.is_set() {
        validate_speed_limit_kbps(req.speed_limit_kbps.value())?;
    }
    if let Some(forward_limit) = req.forward_limit {
        validate_forward_limit(forward_limit)?;
    }

    let node_ids = normalize_patch_node_ids(req.node_ids)?;
    if let Patch::Value(node_ids) = &node_ids {
        validate_node_id_list(&state, node_ids).await?;
    }
    let forward_server_ids = match req.forward_server_ids.clone() {
        Some(ids) => Some(normalize_forward_server_ids(ids)?),
        None => None,
    };
    if let Some(server_ids) = &forward_server_ids {
        validate_forward_server_id_list(&state, server_ids).await?;
    }
    let rule_template_id = match req.rule_template_id {
        Patch::Missing => Patch::Missing,
        Patch::Null => Patch::Null,
        Patch::Value(id) => Patch::Value(validate_rule_template_id(&state, &id).await?),
    };

    // 审计与「范围是否变化」都要变更前快照：一次查询同时拿到 node_scope/node_count。
    let before_package = repo::packages::find_by_id(&state.db.pool, &id).await?;
    let before_scope = before_package
        .as_ref()
        .map(|package| repo::packages::NodeScope {
            explicit: package.node_scope == "custom",
            node_ids: package.node_ids.clone(),
        });
    let package = repo::packages::update(
        &state.db.pool,
        &id,
        repo::packages::UpdatePackage {
            name,
            quota_bytes: req.quota_bytes,
            period_days: req.period_days,
            direction,
            node_ratio: req.node_ratio,
            speed_limit_kbps: req.speed_limit_kbps,
            rule_template_id,
            node_ids,
        },
    )
    .await?
    .ok_or_else(|| AppError::not_found("package.not_found", None, "资源不存在"))?;

    // 自助转发规则单独写（迁移 0044），未传的两项保持原值。
    let mut package = package;
    if req.forward_limit.is_some() || forward_server_ids.is_some() {
        let forward_limit = req.forward_limit.unwrap_or(package.forward_limit);
        let server_ids = forward_server_ids
            .as_deref()
            .unwrap_or(package.forward_server_ids.as_slice());
        if !repo::packages::set_forward_rules(&state.db.pool, &id, forward_limit, server_ids)
            .await?
        {
            return Err(AppError::not_found("package.not_found", None, "资源不存在"));
        }
        package = repo::packages::find_by_id(&state.db.pool, &id)
            .await?
            .ok_or_else(|| AppError::not_found("package.not_found", None, "资源不存在"))?;
    }

    let after = repo::packages::node_scope(&state.db.pool, &id).await?;
    mark_dirty_if_scope_changed(&state, &id, before_scope, after).await;

    let changes = crate::audit::diff(vec![
        (
            "name",
            json!(before_package.as_ref().map(|package| &package.name)),
            json!(&package.name),
        ),
        (
            "quota_bytes",
            json!(before_package
                .as_ref()
                .and_then(|package| package.quota_bytes)),
            json!(package.quota_bytes),
        ),
        (
            "period_days",
            json!(before_package
                .as_ref()
                .and_then(|package| package.period_days)),
            json!(package.period_days),
        ),
        (
            "direction",
            json!(before_package.as_ref().map(|package| &package.direction)),
            json!(&package.direction),
        ),
        (
            "node_ratio",
            json!(before_package.as_ref().map(|package| package.node_ratio)),
            json!(package.node_ratio),
        ),
        (
            "speed_limit_kbps",
            json!(before_package
                .as_ref()
                .and_then(|package| package.speed_limit_kbps)),
            json!(package.speed_limit_kbps),
        ),
        (
            "rule_template_id",
            json!(before_package
                .as_ref()
                .and_then(|package| package.rule_template_id.clone())),
            json!(package.rule_template_id),
        ),
        (
            "forward_limit",
            json!(before_package.as_ref().map(|package| package.forward_limit)),
            json!(package.forward_limit),
        ),
        (
            "forward_server_ids",
            json!(before_package
                .as_ref()
                .map(|package| package.forward_server_ids.clone())),
            json!(&package.forward_server_ids),
        ),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "package.update",
        &id,
        json!({
            "name": &package.name,
            "changes": changes,
            // 节点范围单独摊平：这是删除节点/换范围时最需要回查的字段。
            "node_scope": {
                "from": before_package.as_ref().map(|package| package.node_scope.as_str()),
                "to": &package.node_scope,
            },
            "node_count": {
                "from": before_package.as_ref().map(|package| package.node_count),
                "to": package.node_count,
            },
            "node_ids": {
                "from": before_package.as_ref().map(|package| package.node_ids.clone()),
                "to": &package.node_ids,
            },
            // 自助转发额度/白名单同样摊平，方便回查「谁把配额改了」。
            "forward_limit": {
                "from": before_package.as_ref().map(|package| package.forward_limit),
                "to": package.forward_limit,
            },
            "forward_server_ids": {
                "from": before_package
                    .as_ref()
                    .map(|package| package.forward_server_ids.clone()),
                "to": &package.forward_server_ids,
            },
        }),
    )
    .await;

    Ok(Json(json!({ "package": package })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    // 先给业务提示，避免直接把外键错误暴露成 500。
    let references = repo::packages::count_references(&state.db.pool, &id).await?;
    if references > 0 {
        return Err(AppError::coded(
            "package.in_use",
            Some(json!({ "references": references })),
            format!("该套餐还有 {references} 个用户在用，无法删除"),
        ));
    }
    let removed = repo::packages::find_by_id(&state.db.pool, &id).await?;
    if !repo::packages::delete(&state.db.pool, &id).await? {
        return Err(AppError::not_found("package.not_found", None, "资源不存在"));
    }
    if let Some(removed) = removed {
        crate::audit::record(
            &state,
            &user.0,
            "package.delete",
            &id,
            json!({
                "name": &removed.name,
                "node_scope": &removed.node_scope,
                "node_count": removed.node_count,
                "node_ids": &removed.node_ids,
            }),
        )
        .await;
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::json;
    use tower::ServiceExt;

    use pierwave_domain::models::Node;
    use pierwave_domain::repo::nodes::NewNode;
    use pierwave_domain::repo::user_packages::{self, NewUserPackage};
    use pierwave_domain::repo::users::{self, NewUser};
    use pierwave_domain::Db;
    use pierwave_proto::MasterMessage;

    fn trojan_node(tag: &str, name: &str, port: i64) -> NewNode {
        NewNode {
            tag: Some(tag.into()),
            name: name.into(),
            protocol: "trojan".into(),
            transport: "tcp".into(),
            security: "none".into(),
            port,
            public_port: None,
            config_json: json!({
                "settings": {"clients": []},
                "stream": {"network": "tcp", "security": "none"}
            })
            .to_string(),
            enabled: true,
            cert_id: None,
            bandwidth_kbps: None,
        }
    }

    async fn setup() -> (Router, AppState, String, String, Vec<Node>) {
        setup_with(None).await
    }

    /// `enforcement_window = Some(w)` 时启用断流去抖（测试里用极小窗口），
    /// 默认关闭，避免没起 worker 的用例受环境变量影响。
    async fn setup_with(
        enforcement_window: Option<Duration>,
    ) -> (Router, AppState, String, String, Vec<Node>) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = users::create(
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
        let (server, _) = repo::servers::create(&db.pool, "hk-1", "203.0.113.10", "external")
            .await
            .unwrap();
        let mut nodes = Vec::new();
        for (tag, name, port) in [("a", "节点-A", 443), ("b", "节点-B", 8443)] {
            nodes.push(
                repo::nodes::create(&db.pool, &server.id, trojan_node(tag, name, port))
                    .await
                    .unwrap(),
            );
        }
        let state = match enforcement_window {
            Some(window) => AppState::new(db, "web/dist").with_enforcement(true, window),
            None => AppState::new(db, "web/dist").with_enforcement(false, Duration::ZERO),
        };
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
            server.id,
            nodes,
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

    async fn create_package(app: &Router, cookie: &str, body: Value) -> String {
        let (status, package) = request(
            app,
            Some(cookie),
            Method::POST,
            "/api/v1/packages",
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "建套餐失败：{package}");
        package["package"]["id"].as_str().unwrap().to_string()
    }

    async fn bind_user(state: &AppState, package_id: &str) -> String {
        let user = users::create(
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
        let package = repo::packages::find_by_id(&state.db.pool, package_id)
            .await
            .unwrap()
            .unwrap();
        user_packages::create(
            &state.db.pool,
            &user.id,
            NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap();
        user.id
    }

    fn package_item<'a>(body: &'a Value, id: &str) -> &'a Value {
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .unwrap()
    }

    #[tokio::test]
    async fn package_scope_semantics_are_exposed_by_api() {
        let (app, _state, cookie, _server_id, nodes) = setup().await;
        let a = nodes[0].id.clone();

        // 不传 node_ids → 可见全部节点（历史套餐的默认行为）。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "全部", "quota_bytes": 10_000})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([]));
        assert_eq!(body["package"]["node_count"], 2);

        // 显式指定 A → 只可见 A。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "指定", "node_ids": [a.clone()]})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([a.clone()]));
        assert_eq!(body["package"]["node_count"], 1);

        // 显式空数组 → 一个都不给，与「不传」区分开。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "空", "node_ids": []})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([]));
        assert_eq!(body["package"]["node_count"], 0);

        // 列表把三种语义一起带出。
        let (status, body) =
            request(&app, Some(&cookie), Method::GET, "/api/v1/packages", None).await;
        assert_eq!(status, StatusCode::OK);
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        let by_name = |name: &str| items.iter().find(|item| item["name"] == name).unwrap();
        assert_eq!(by_name("全部")["node_ids"], json!([]));
        assert_eq!(by_name("全部")["node_count"], 2);
        assert_eq!(by_name("指定")["node_ids"], json!([a]));
        assert_eq!(by_name("指定")["node_count"], 1);
        assert_eq!(by_name("空")["node_ids"], json!([]));
        assert_eq!(by_name("空")["node_count"], 0);

        // 不存在的节点 id → 400 中文错误，不能落库。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "坏", "node_ids": ["does-not-exist"]})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let error = body["error"].as_str().unwrap();
        assert!(error.contains("节点不存在"), "unexpected: {error}");
        assert!(error.contains("does-not-exist"), "unexpected: {error}");
    }

    #[tokio::test]
    async fn speed_limit_crud_validation_and_strictest_wins() {
        let (app, state, cookie, server_id, _nodes) = setup().await;

        // 创建时带档位；视图原样带出。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "限速卡", "quota_bytes": 10_000, "speed_limit_kbps": 50_000})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["speed_limit_kbps"], 50_000);
        let package_id = body["package"]["id"].as_str().unwrap().to_string();

        // 列表也必须带出该字段。
        let (_, body) = request(&app, Some(&cookie), Method::GET, "/api/v1/packages", None).await;
        assert_eq!(package_item(&body, &package_id)["speed_limit_kbps"], 50_000);

        // PATCH 数值：改档位。
        let uri = format!("/api/v1/packages/{package_id}");
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &uri,
            Some(json!({"speed_limit_kbps": 20_000})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["speed_limit_kbps"], 20_000);

        // PATCH null：取消限速。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &uri,
            Some(json!({"speed_limit_kbps": null})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["speed_limit_kbps"], Value::Null);

        // 越界：创建与更新都要 400 + 稳定 code。
        for bad in [-1, 10_000_001] {
            let (status, body) = request(
                &app,
                Some(&cookie),
                Method::POST,
                "/api/v1/packages",
                Some(json!({"name": "坏档位", "speed_limit_kbps": bad})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "create bad={bad}");
            assert_eq!(body["code"], "package.speed_limit_kbps_invalid");
            assert!(body["error"].as_str().unwrap().contains("限速档位"));

            let (status, body) = request(
                &app,
                Some(&cookie),
                Method::PATCH,
                &uri,
                Some(json!({"speed_limit_kbps": bad})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "patch bad={bad}");
            assert_eq!(body["code"], "package.speed_limit_kbps_invalid");
        }

        // 同一用户挂两张都覆盖全部节点的卡：生效档位必须取更严格的一个。
        let slow = create_package(
            &app,
            &cookie,
            json!({"name": "慢卡", "quota_bytes": 10_000, "speed_limit_kbps": 10_000}),
        )
        .await;
        let fast = create_package(
            &app,
            &cookie,
            json!({"name": "快卡", "quota_bytes": 10_000, "speed_limit_kbps": 100_000}),
        )
        .await;
        let alice = users::create(
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
        for id in [&slow, &fast] {
            let package = repo::packages::find_by_id(&state.db.pool, id)
                .await
                .unwrap()
                .unwrap();
            user_packages::create(
                &state.db.pool,
                &alice.id,
                NewUserPackage {
                    package_id: package.id.clone(),
                    quota_override: None,
                    expires_at: None,
                    reset_day: None,
                },
                &package,
            )
            .await
            .unwrap();
        }

        let mut subscription = state.hub.subscribe(&server_id);
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::POST,
            &format!("/api/v1/servers/{server_id}/apply"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let MasterMessage::Desired(desired) = subscription.receiver.recv().await.unwrap() else {
            panic!("expected desired state");
        };
        // 10Mbps -> level 1（buffer 62KB），不是 100Mbps 的 625KB。
        assert_eq!(desired.xray["policy"]["levels"]["1"]["bufferSize"], 62);
        assert!(
            desired.xray["policy"]["levels"].get("2").is_none(),
            "只应生成一个实际生效的档位：{}",
            desired.xray["policy"]["levels"]
        );
        let client = desired.xray["inbounds"][0]["settings"]["clients"]
            .as_array()
            .unwrap()
            .iter()
            .find(|client| client["level"].is_number())
            .unwrap();
        assert_eq!(client["level"], 1);
    }

    /// 三态转换：指定 → 全部（null）、全部 → 指定（数组）、指定 → 空（[]）→ 全部（null）。
    #[tokio::test]
    async fn patch_scope_tri_state_changes_eligible_pairs() {
        let (app, state, cookie, server_id, nodes) = setup().await;
        let a = nodes[0].id.clone();
        let b = nodes[1].id.clone();

        let package_id = create_package(
            &app,
            &cookie,
            json!({"name": "指定", "node_ids": [a.clone()]}),
        )
        .await;
        let user_id = bind_user(&state, &package_id).await;

        let pairs = repo::authorization::eligible_pairs(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(pairs.len(), 1, "只绑 A 时只有一条授权");
        assert_eq!(pairs[0].user_id, user_id);
        assert_eq!(pairs[0].node_id, a);

        // 指定 → 全部：`node_ids: null` 恢复为不限制。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": null})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([]));
        assert_eq!(
            body["package"]["node_count"], 2,
            "恢复到全部之后应返回当前全部节点数"
        );
        let pairs = repo::authorization::eligible_pairs(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(pairs.len(), 2, "恢复全部后 A、B 都应可授权");
        assert!(pairs.iter().any(|pair| pair.node_id == a));
        assert!(pairs.iter().any(|pair| pair.node_id == b));

        // 全部 → 指定：只给 A。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": [a.clone()]})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([a.clone()]));
        assert_eq!(body["package"]["node_count"], 1);
        let pairs = repo::authorization::eligible_pairs(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].node_id, a);

        // 指定 → 空：一个都不给。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": []})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([]));
        assert_eq!(body["package"]["node_count"], 0);
        assert!(
            repo::authorization::eligible_pairs(&state.db.pool, &server_id)
                .await
                .unwrap()
                .is_empty(),
            "空范围不应产生任何授权"
        );

        // 不传 node_ids = 不动：仍是空范围。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"name": "改名"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([]));
        assert_eq!(body["package"]["node_count"], 0);
        assert!(
            repo::authorization::eligible_pairs(&state.db.pool, &server_id)
                .await
                .unwrap()
                .is_empty(),
            "不传 node_ids 不应改范围"
        );

        // 空 → 全部：回到不限制。
        let (status, body) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": null})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_ids"], json!([]));
        assert_eq!(body["package"]["node_count"], 2);
        let pairs = repo::authorization::eligible_pairs(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(pairs.len(), 2);
        assert!(pairs.iter().any(|pair| pair.node_id == a));
        assert!(pairs.iter().any(|pair| pair.node_id == b));
    }

    #[tokio::test]
    async fn deleting_nodes_cascades_scope_without_widening() {
        let (app, state, cookie, server_id, nodes) = setup().await;
        let a = nodes[0].id.clone();
        let b = nodes[1].id.clone();
        let package_id = create_package(
            &app,
            &cookie,
            json!({"name": "两只", "node_ids": [a.clone(), b.clone()]}),
        )
        .await;
        let user_id = bind_user(&state, &package_id).await;

        // 删 A：package_nodes 级联清理，只剩 B。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/nodes/{a}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, body) = request(&app, Some(&cookie), Method::GET, "/api/v1/packages", None).await;
        let item = package_item(&body, &package_id);
        assert_eq!(item["node_ids"], json!([b.clone()]));
        assert_eq!(item["node_count"], 1);

        // 再删 B：显式范围仍然是「一个都不给」，不能因为没行就回落成全部。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            &format!("/api/v1/nodes/{b}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, body) = request(&app, Some(&cookie), Method::GET, "/api/v1/packages", None).await;
        let item = package_item(&body, &package_id);
        assert_eq!(item["node_ids"], json!([]));
        assert_eq!(item["node_count"], 0);

        // 新增节点 C 也不会被「没有行」的套餐自动放进来。
        repo::nodes::create(&state.db.pool, &server_id, trojan_node("c", "节点-C", 9443))
            .await
            .unwrap();
        let (_, body) = request(&app, Some(&cookie), Method::GET, "/api/v1/packages", None).await;
        let item = package_item(&body, &package_id);
        assert_eq!(item["node_ids"], json!([]));
        assert_eq!(item["node_count"], 0);
        assert!(
            repo::authorization::eligible_pairs(&state.db.pool, &server_id)
                .await
                .unwrap()
                .iter()
                .all(|pair| pair.user_id != user_id),
            "空范围不能因为新增节点而重新授权"
        );
    }

    #[tokio::test]
    async fn empty_scope_removes_client_from_desired_config() {
        let (app, state, cookie, server_id, nodes) = setup().await;
        let a = nodes[0].id.clone();

        let package_id = create_package(&app, &cookie, json!({"name": "空", "node_ids": []})).await;
        let user_id = bind_user(&state, &package_id).await;
        let server = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();

        let desired = crate::routes::desired::render(&state, &server, "http://127.0.0.1:8787")
            .await
            .unwrap();
        assert!(
            desired.granted_user_ids.is_empty(),
            "空范围用户不应出现在下发授权里"
        );
        let inbounds = desired.xray["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 3, "两个节点 + api");
        for inbound in &inbounds[..2] {
            assert_eq!(
                inbound["settings"]["clients"],
                json!([]),
                "空范围不应给任何节点注入 client"
            );
        }

        // 改成只给 A 后，只有 A 的 inbound 出现该用户的 client。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": [a.clone()]})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let desired = crate::routes::desired::render(&state, &server, "http://127.0.0.1:8787")
            .await
            .unwrap();
        assert_eq!(desired.granted_user_ids, vec![user_id]);
        let inbounds = desired.xray["inbounds"].as_array().unwrap();
        assert_eq!(
            inbounds[0]["settings"]["clients"].as_array().unwrap().len(),
            1,
            "节点 A 应有 1 个 client"
        );
        assert_eq!(
            inbounds[1]["settings"]["clients"].as_array().unwrap().len(),
            0,
            "节点 B 不应有 client"
        );
    }

    async fn wait_snapshot(state: &AppState, server_id: &str) -> repo::desired::Snapshot {
        for _ in 0..100 {
            if let Some(snapshot) = repo::desired::get(&state.db.pool, server_id).await.unwrap() {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("等待 desired_snapshots 超时");
    }

    async fn wait_version_after(
        state: &AppState,
        server_id: &str,
        version: i64,
    ) -> repo::desired::Snapshot {
        for _ in 0..100 {
            if let Some(snapshot) = repo::desired::get(&state.db.pool, server_id).await.unwrap() {
                if snapshot.config_version > version {
                    return snapshot;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("等待配置版本推进超时");
    }

    #[tokio::test]
    async fn scope_change_triggers_apply_and_unchanged_scope_does_not() {
        let (app, state, cookie, server_id, nodes) =
            setup_with(Some(Duration::from_millis(20))).await;
        let a = nodes[0].id.clone();

        // 新建时就指定范围：POST 也应标脏。绑卡后再起 worker，首个 apply 应带该用户。
        let package_id = create_package(
            &app,
            &cookie,
            json!({"name": "指定", "node_ids": [a.clone()]}),
        )
        .await;
        let user_id = bind_user(&state, &package_id).await;
        let _worker = crate::enforcement::spawn_worker(state.clone());

        // 去抖 worker apply 一次，快照里出现该用户。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": [a.clone()]})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let first = wait_snapshot(&state, &server_id).await;
        assert!(first.config_version >= 1, "范围变化应触发一次 apply");
        assert_eq!(first.granted_user_ids().unwrap(), vec![user_id.clone()]);

        // 范围没变（同一个数组）→ 不标脏，版本不再推进。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": [a.clone()]})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        tokio::time::sleep(Duration::from_millis(250)).await;
        let unchanged = repo::desired::get(&state.db.pool, &server_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            unchanged.config_version, first.config_version,
            "范围没变不应重复 apply"
        );

        // 改成空范围 → 再 apply 一次，用户从快照里消失。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": []})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let empty = wait_version_after(&state, &server_id, first.config_version).await;
        assert!(
            empty.granted_user_ids().unwrap().is_empty(),
            "空范围后用户应被移出下发配置"
        );

        // 恢复全部 → 再 apply 一次，用户回来。
        let (status, _) = request(
            &app,
            Some(&cookie),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": null})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let restored = wait_version_after(&state, &server_id, empty.config_version).await;
        assert_eq!(restored.granted_user_ids().unwrap(), vec![user_id]);
    }

    /// 系统里没有节点时，`node_ids`/`node_count` 无法区分「全部」和「一个都不给」，
    /// 所以 API 额外暴露 `node_scope`。
    #[tokio::test]
    async fn node_scope_distinguishes_all_from_empty_when_no_nodes_exist() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();

        let all = repo::packages::create(
            &db.pool,
            repo::packages::NewPackage {
                name: "全部".into(),
                quota_bytes: None,
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,
                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(all.node_scope, "all");
        assert_eq!(all.node_count, 0);

        let none = repo::packages::create(
            &db.pool,
            repo::packages::NewPackage {
                name: "不给".into(),
                quota_bytes: None,
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,
                speed_limit_kbps: None,
                node_ids: Some(Vec::new()),
            },
        )
        .await
        .unwrap();
        assert_eq!(none.node_scope, "custom");
        assert_eq!(none.node_count, 0);
    }
}
