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
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct UserPackageView {
    pub id: String,
    /// 仅用于按用户分组装配，不对外暴露。
    #[serde(skip)]
    pub user_id: String,
    pub package_id: String,
    pub package_name: String,
    pub quota_bytes: Option<i64>,
    pub used_bytes: i64,
    pub expires_at: Option<i64>,
    pub reset_day: Option<i64>,
    pub status: String,
    pub direction: String,
    pub node_ratio: f64,
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
