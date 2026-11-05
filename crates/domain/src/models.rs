use serde::{Deserialize, Deserializer, Serialize, Serializer};
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
}

/// 趋势图的一天：`date` 是 UTC+8 自然日，缺数据的天由仓储补 0。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TrafficDay {
    pub date: String,
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
