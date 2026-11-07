use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct User {
    pub id: String,
    pub username: String,
    #[serde(skip)]
    pub password_hash: String,
    pub role: String,
    pub status: String,
    pub short_code: String,
    pub quota_bytes: Option<i64>,
    pub used_bytes: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct Session {
    pub id: String,
    pub user_id: String,
    pub token_hash: String,
    pub expires_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub address: String,
    #[serde(skip)]
    pub token_hash: String,
    pub xray_mode: String,
    pub status: String,
    pub last_seen_at: Option<i64>,
    pub config_version: i64,
    pub created_at: i64,
    /// 以下是 Agent 心跳带来的健康数据；没连过的服务器全是 None。
    pub agent_version: Option<String>,
    pub xray_running: Option<bool>,
    pub nginx_running: Option<bool>,
    pub load1: Option<f64>,
    pub mem_used: Option<i64>,
    pub mem_total: Option<i64>,
    pub disk_used: Option<i64>,
    pub disk_total: Option<i64>,
    pub uptime_secs: Option<i64>,
    pub health_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Node {
    pub id: String,
    pub server_id: String,
    pub tag: String,
    pub name: String,
    pub protocol: String,
    pub transport: String,
    pub security: String,
    pub port: i64,
    /// 库里存的是 JSON 文本；对外直接暴露成 JSON 对象，前端不用二次 parse。
    #[serde(rename = "config", serialize_with = "config_json_as_value")]
    pub config_json: String,
    pub enabled: i64,
    pub created_at: i64,
    /// 绑定的证书 id；`security = tls` 的节点必须非空（接口层校验）。
    pub cert_id: Option<String>,
}

/// 服务器上的一条自定义出站。
///
/// `tag` / `protocol` 是权威字段：`config_json` 在生成配置时被合并进出站对象，
/// 但同名键一律以这两列为准（和 [`Node`] 的 tag/port/protocol 处理方式一致）。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Outbound {
    pub id: String,
    pub server_id: String,
    pub tag: String,
    pub protocol: String,
    /// 库里存 JSON 文本，对外直接暴露成 `config` 对象。
    #[serde(rename = "config", serialize_with = "config_json_as_value")]
    pub config_json: String,
    pub enabled: i64,
    pub created_at: i64,
}

/// 服务器上的一条路由规则。
///
/// `inbound_tag` / `domain` / `ip` 至少一个非空；`domain` / `ip` 是逗号分隔的
/// Xray 匹配串。生成配置时按 `sort_order, created_at` 顺序接在 api 规则后面。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct RoutingRule {
    pub id: String,
    pub server_id: String,
    pub sort_order: i64,
    pub inbound_tag: Option<String>,
    pub domain: Option<String>,
    pub ip: Option<String>,
    pub outbound_tag: String,
    pub enabled: i64,
    pub created_at: i64,
}

/// 上传的证书：私钥只落库，任何列表/详情视图都不带出去。
#[derive(Debug, Clone, FromRow)]
pub struct Certificate {
    pub id: String,
    pub name: String,
    /// JSON 数组文本，对外由 [`CertificateView`] 展开。
    pub domains: String,
    pub cert_pem: String,
    pub key_pem: String,
    pub not_before: i64,
    pub not_after: i64,
    pub created_at: i64,
}

/// 证书元数据视图：**没有** `cert_pem` / `key_pem`。
///
/// `days_left` 由仓储按调用时刻算好，口径见 `certificate::days_left`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CertificateView {
    pub id: String,
    pub name: String,
    pub domains: Vec<String>,
    pub not_before: i64,
    pub not_after: i64,
    pub days_left: i64,
    pub has_key: bool,
    pub created_at: i64,
}

/// 审计日志的原始行：`detail` 是库里存的 JSON 文本，`actor_name` 靠 LEFT JOIN 带出。
///
/// 单独拆一行模型是因为 `detail` 需要在读出后解析成 JSON 对象再对外，
/// 而 sqlx 不会替我们做这层转换。
#[derive(Debug, Clone, FromRow)]
pub struct AuditRow {
    pub id: String,
    pub actor_id: Option<String>,
    pub actor_name: Option<String>,
    pub action: String,
    pub target: Option<String>,
    pub detail: Option<String>,
    pub created_at: i64,
}

/// 审计日志对外视图：`detail` 已解析成 JSON 对象（解析失败时保留原始字符串）。
#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub id: String,
    pub actor_id: Option<String>,
    pub actor_name: Option<String>,
    pub action: String,
    pub target: Option<String>,
    pub detail: Option<Value>,
    pub created_at: i64,
}

impl From<AuditRow> for AuditEntry {
    fn from(row: AuditRow) -> Self {
        Self {
            id: row.id,
            actor_id: row.actor_id,
            actor_name: row.actor_name,
            action: row.action,
            target: row.target,
            detail: row
                .detail
                .map(|raw| serde_json::from_str(&raw).unwrap_or(Value::String(raw))),
            created_at: row.created_at,
        }
    }
}

/// 管理员视角的全局节点列表项：节点 + 所属服务器名（选择器要按服务器分组）。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct NodeListItem {
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub node: Node,
    pub server_name: String,
}

/// 订阅装配用：节点 + 所属服务器地址。
///
/// 订阅端点要跨服务器取节点，地址不在 `nodes` 表里，靠 JOIN 一次带出，
/// 避免 master 里出现 N+1 或直接写 SQL。
#[derive(Debug, Clone, FromRow)]
pub struct NodeWithServer {
    #[sqlx(flatten)]
    pub node: Node,
    pub server_address: String,
}

fn config_json_as_value<S>(raw: &str, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let value =
        serde_json::from_str::<serde_json::Value>(raw).unwrap_or_else(|_| serde_json::json!({}));
    value.serialize(serializer)
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Package {
    pub id: String,
    pub name: String,
    pub quota_bytes: Option<i64>,
    pub period_days: Option<i64>,
    pub direction: String,
    pub node_ratio: f64,
    pub created_at: i64,
    /// 当前仍引用该套餐模板的实例数。
    ///
    /// `packages::list` / `find_by_id` 用一条聚合查询带出，前端删除前据此提前禁用按钮。
    pub user_count: i64,
    /// 显式绑定的节点 id（升序）；未设范围时为空，此时该套餐可见全部节点。
    ///
    /// 与 [`Self::node_count`] 搭配才能区分「未设范围」和「显式一个都不给」：
    /// 前者 `node_ids` 为空但 `node_count` 是全部节点数，后者两者都为 0。
    #[sqlx(skip)]
    pub node_ids: Vec<String>,
    /// 实际可见节点数：未设范围时 = 全部节点数；显式空范围时 = 0。
    #[sqlx(skip)]
    pub node_count: usize,
    /// `all` = 未设范围（含以后新增的节点）；`custom` = 显式设过范围。
    ///
    /// 只靠 `node_ids`/`node_count` 在「系统里一个节点都没有」时无法区分
    /// 「全部」和「一个都不给」，这个字段把意图直接暴露出来。
    #[sqlx(skip)]
    pub node_scope: String,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct UserPackage {
    pub id: String,
    pub user_id: String,
    pub package_id: String,
    pub quota_override: Option<i64>,
    pub used_bytes: i64,
    pub direction: String,
    pub node_ratio: f64,
    pub expires_at: Option<i64>,
    pub reset_day: Option<i64>,
    pub status: String,
    pub created_at: i64,
}

/// 套餐实例视图：join 套餐模板带出名称与「生效额度」。
///
/// `quota_bytes` 是生效值：`quota_override` 为空时沿用套餐额度；
/// 显式写 0 原样返回 0，由展示层按「显式不限」处理（区别于 null 的继承语义）。
/// `quota_override` 同时原样回显，前端才能把「改回继承」表达成显式 `null`。
///
/// `status` 是**计算值**（`active | expired | exhausted | disabled`），库里存的
/// 原始状态在 `raw_status` 里，不对外暴露。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct UserPackageView {
    pub id: String,
    /// 仅用于按用户分组装配，不对外暴露。
    #[serde(skip)]
    pub user_id: String,
    pub package_id: String,
    pub package_name: String,
    /// 原始覆写值：null = 继承套餐额度，0 = 显式不限，N = 覆写。
    pub quota_override: Option<i64>,
    pub quota_bytes: Option<i64>,
    pub used_bytes: i64,
    pub expires_at: Option<i64>,
    pub reset_day: Option<i64>,
    /// 库里存的原始状态，只用于计算 `status`。
    #[serde(skip)]
    pub raw_status: String,
    /// 视图层计算后的状态，见 [`UserPackageView::status_at`]。
    #[sqlx(default)]
    pub status: String,
    pub direction: String,
    pub node_ratio: f64,
}

/// 计算套餐实例状态所需的最小事实；视图与订阅授权共用同一套口径。
///
/// 顺序即优先级：`disabled` > `expired` > `exhausted` > `active`。
pub fn package_status_at(
    raw_status: &str,
    expires_at: Option<i64>,
    quota_bytes: Option<i64>,
    used_bytes: i64,
    now: i64,
) -> &'static str {
    if raw_status != "active" {
        return "disabled";
    }
    if expires_at.is_some_and(|expires_at| expires_at <= now) {
        return "expired";
    }
    // 0 表示显式不限，不算用尽；只有正额度且已用 >= 额度才算 exhausted。
    if quota_bytes.is_some_and(|quota| quota > 0 && used_bytes >= quota) {
        return "exhausted";
    }
    "active"
}

/// 套餐实例是否还能用（订阅资格/下发的唯一口径）。
pub fn package_is_usable_at(
    raw_status: &str,
    expires_at: Option<i64>,
    quota_bytes: Option<i64>,
    used_bytes: i64,
    now: i64,
) -> bool {
    package_status_at(raw_status, expires_at, quota_bytes, used_bytes, now) == "active"
}

impl UserPackageView {
    /// 按给定时刻计算状态。
    pub fn status_at(&self, now: i64) -> &'static str {
        package_status_at(
            &self.raw_status,
            self.expires_at,
            self.quota_bytes,
            self.used_bytes,
            now,
        )
    }

    /// 用给定时刻的状态覆盖 `status` 字段；仓储在读出原始行后统一调用。
    pub fn resolve_status(mut self, now: i64) -> Self {
        self.status = self.status_at(now).to_string();
        self
    }

    /// 该实例当前是否还能用（订阅资格判定复用它）。
    pub fn is_usable(&self) -> bool {
        self.is_usable_at(crate::time::now())
    }

    pub fn is_usable_at(&self, now: i64) -> bool {
        self.status_at(now) == "active"
    }
}

/// 规则模板的原始行：`rules` 是库里存的 JSON 数组文本。
///
/// 单独拆一行模型是因为 `rules` 需要在读出后解析成数组再对外，
/// 和 [`AuditRow`] / [`Certificate`] 的处理方式一致。
#[derive(Debug, Clone, FromRow)]
pub struct RuleTemplateRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub rules: String,
    pub is_default: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 规则模板对外视图：`rules` 已解析成字符串数组，`is_default` 是布尔值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuleTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub rules: Vec<String>,
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<RuleTemplateRow> for RuleTemplate {
    fn from(row: RuleTemplateRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            description: row.description,
            // 写入前都过校验，脏数据（手工改库）退化成空数组而不是 500。
            rules: serde_json::from_str(&row.rules).unwrap_or_default(),
            is_default: row.is_default != 0,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// 用户列表/详情视图：用户本体 + 名下所有套餐实例（一次查询装配）。
#[derive(Debug, Clone, Serialize)]
pub struct UserView {
    pub id: String,
    pub username: String,
    pub role: String,
    pub status: String,
    pub short_code: String,
    pub quota_bytes: Option<i64>,
    pub used_bytes: i64,
    pub created_at: i64,
    /// 名下套餐实例数；与 `packages.len()` 一致，方便前端分页/汇总时少算一次。
    pub package_count: i64,
    pub packages: Vec<UserPackageView>,
    /// 是否已超出账户总额度（`users.quota_bytes` 非空且 `used_bytes >= quota_bytes`）。
    /// 由后端算，前端不要自己拿 used/quota 去比。
    pub quota_exceeded: bool,
    /// 名下套餐实例的额度合计；`null` 表示其中至少一张不限量（合计也就无上限）。
    pub package_quota_bytes: Option<i64>,
    /// 名下套餐实例的已用合计。
    pub package_used_bytes: i64,
    /// 名下实例里最严重的状态：`exhausted > expired > disabled > active`；无实例为 `none`。
    ///
    /// 用户被断流时 `users.status` 仍是 `active`，只看账号状态会漏掉真正的问题。
    pub package_worst_status: String,
}

impl From<(User, Vec<UserPackageView>)> for UserView {
    fn from((user, packages): (User, Vec<UserPackageView>)) -> Self {
        Self {
            id: user.id,
            username: user.username,
            role: user.role,
            status: user.status,
            short_code: user.short_code,
            quota_bytes: user.quota_bytes,
            used_bytes: user.used_bytes,
            created_at: user.created_at,
            package_count: packages.len() as i64,
            quota_exceeded: user
                .quota_bytes
                .is_some_and(|quota| user.used_bytes >= quota),
            package_quota_bytes: aggregate_quota(&packages),
            package_used_bytes: packages.iter().map(|p| p.used_bytes).sum(),
            package_worst_status: worst_status(&packages).to_string(),
            packages,
        }
    }
}

/// PATCH 请求字段的三态：字段缺失 / 显式 null / 具体值。
///
/// 只用 `Option<T>` 无法区分「没传」和「传了 null」，而 PATCH 语义要求
/// 后者把可空列清空，所以这里显式建模。`#[serde(default)]` 负责缺失态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Patch<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<T> Patch<T> {
    pub fn is_set(&self) -> bool {
        !matches!(self, Self::Missing)
    }

    /// 转成要写库的值：缺失与 null 都是 `None`，调用方用 `is_set()` 区分是否更新。
    pub fn value(self) -> Option<T> {
        match self {
            Self::Value(value) => Some(value),
            Self::Missing | Self::Null => None,
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

/// 登录后的当前用户视图（不含密码哈希）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUser {
    pub id: String,
    pub username: String,
    pub role: String,
    pub short_code: String,
}

/// 管理端概览：只放聚合后的计数，不携带任何明细行。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Overview {
    pub servers: ServerStats,
    pub users: UserStats,
    pub packages: PackageStats,
    pub traffic: TrafficStats,
    pub alerts: AlertStats,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ServerStats {
    pub total: i64,
    pub online: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct UserStats {
    pub total: i64,
    pub active: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PackageStats {
    /// 套餐模板数。
    pub total: i64,
    /// 已售出的套餐实例数（user_packages 行数）。
    pub instances: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TrafficStats {
    /// 今天（UTC+8）的加权流量。
    pub today_bytes: i64,
    /// 本月（UTC+8）的加权流量。
    pub month_bytes: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct AlertStats {
    pub expired_instances: i64,
    pub exhausted_instances: i64,
    pub offline_servers: i64,
    /// 30 天内到期（含已过期）的证书数；没有证书时恒为 0。
    pub expiring_certs: i64,
}

/// 趋势图的一天：`date` 是 UTC+8 自然日，缺数据的天由仓储补 0。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TrafficDay {
    pub date: String,
    pub uplink: i64,
    pub downlink: i64,
    pub weighted: i64,
}

/// 节点维度流量聚合（`days` 窗口内），附带今日/本月加权值。
///
/// `node_tag` 来自 `traffic_node_daily`，节点元数据来自 `nodes` JOIN；节点一旦
/// 删除，历史行仍在库里但不会再出现在列表/详情里（详见迁移 0009 的注释）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, FromRow)]
pub struct NodeTrafficRow {
    pub node_id: String,
    pub node_tag: String,
    pub name: String,
    pub server_id: String,
    pub server_name: String,
    pub protocol: String,
    pub transport: String,
    pub security: String,
    pub uplink: i64,
    pub downlink: i64,
    pub weighted: i64,
    pub today_bytes: i64,
    pub month_bytes: i64,
}

/// 某节点下单个用户的流量切片（`days` 窗口内，按 `weighted` 降序）。
///
/// `user_id = ''` 的无法归因流量不会出现在这里，但仍计入节点总量。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, FromRow)]
pub struct NodeUserRow {
    pub user_id: String,
    pub username: String,
    pub uplink: i64,
    pub downlink: i64,
    pub weighted: i64,
}

/// 一条断流事件：某用户被从某台服务器的下发配置中移除，或重新加回。
///
/// `kind` 是 `removed` / `restored`；`message` 是落库时定稿的中文说明，前端直接
/// 展示即可；`reason` 保留机器可读的原因码（`exhausted` / `expired` / `disabled` /
/// `inactive` / `recovered`，多因逗号分隔）供筛选/统计使用。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct EnforcementEvent {
    pub id: String,
    /// `removed` | `restored`。
    pub kind: String,
    pub user_id: String,
    pub username: String,
    pub server_id: String,
    pub server_name: String,
    pub reason: String,
    pub message: String,
    pub created_at: i64,
}

/// 套餐实例额度合计：任意一张不限量（生效额度为 `None` 或 `0`）则整体不限。
fn aggregate_quota(packages: &[UserPackageView]) -> Option<i64> {
    let mut total: i64 = 0;
    for package in packages {
        match package.quota_bytes {
            Some(quota) if quota > 0 => total = total.saturating_add(quota),
            _ => return None,
        }
    }
    Some(total)
}

/// 取最严重状态；顺序与「影响用户的程度」一致。
fn worst_status(packages: &[UserPackageView]) -> &'static str {
    if packages.is_empty() {
        return "none";
    }
    let has = |status: &str| packages.iter().any(|p| p.status == status);
    if has("exhausted") {
        "exhausted"
    } else if has("expired") {
        "expired"
    } else if has("disabled") {
        "disabled"
    } else {
        "active"
    }
}

#[cfg(test)]
mod view_tests {
    use super::*;

    fn package(id: &str, quota: Option<i64>, used: i64, status: &str) -> UserPackageView {
        UserPackageView {
            id: id.into(),
            user_id: "u1".into(),
            package_id: "p1".into(),
            package_name: "月卡".into(),
            quota_override: None,
            quota_bytes: quota,
            used_bytes: used,
            expires_at: None,
            reset_day: None,
            raw_status: "active".into(),
            status: status.into(),
            direction: "both".into(),
            node_ratio: 1.0,
        }
    }

    fn user(packages: Vec<UserPackageView>) -> UserView {
        UserView::from((
            User {
                id: "u1".into(),
                username: "alice".into(),
                password_hash: String::new(),
                role: "user".into(),
                status: "active".into(),
                short_code: "abc".into(),
                quota_bytes: None,
                used_bytes: 0,
                created_at: 0,
                updated_at: 0,
            },
            packages,
        ))
    }

    #[test]
    fn aggregates_package_quota_and_usage() {
        let view = user(vec![
            package("a", Some(100), 40, "active"),
            package("b", Some(200), 10, "active"),
        ]);
        assert_eq!(view.package_quota_bytes, Some(300));
        assert_eq!(view.package_used_bytes, 50);
        assert_eq!(view.package_worst_status, "active");
    }

    #[test]
    fn unlimited_instance_makes_total_unlimited() {
        let view = user(vec![
            package("a", Some(100), 40, "active"),
            package("b", Some(0), 10, "active"),
        ]);
        assert_eq!(view.package_quota_bytes, None, "0 表示显式不限");
    }

    #[test]
    fn worst_status_is_visible_even_when_account_is_active() {
        let view = user(vec![
            package("a", Some(100), 100, "exhausted"),
            package("b", Some(200), 10, "active"),
        ]);
        assert_eq!(
            view.package_worst_status, "exhausted",
            "账号是 active，但用户已被断流"
        );
        assert!(!view.quota_exceeded, "账户级额度未设，不算超额");
    }

    #[test]
    fn no_packages_is_none() {
        let view = user(vec![]);
        assert_eq!(view.package_worst_status, "none");
        assert_eq!(view.package_quota_bytes, Some(0));
    }
}
