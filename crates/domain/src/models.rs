use serde::{Deserialize, Serialize};
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
    pub config_json: String,
    pub enabled: i64,
    pub created_at: i64,
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

/// 登录后的当前用户视图（不含密码哈希）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUser {
    pub id: String,
    pub username: String,
    pub role: String,
    pub short_code: String,
}
