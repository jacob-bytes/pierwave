//! 订阅凭据派生：不建表，按 `(user, node)` 确定性生成子账户。
//!
//! 设计见 `docs/SUBSCRIBE.md` §2：
//!
//! ```text
//! sub_uuid = UUIDv4(HMAC-SHA256(master_secret, "v1/{user_id}/{node_id}")[..16])
//! email    = "{user_id}@{node_tag}"
//! ```
//!
//! * master secret 存 `settings(key = hmac_secret_v1)`，首次调用时随机生成；
//! * `v1/` 前缀是轮换锚点：换 secret 只要写 `hmac_secret_v2`，老订阅自然失效；
//! * 派生是纯函数，同一对 `(user, node)` 在任何一次重启后都得到同一个 UUID。

use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::SqlitePool;

use crate::repo;

/// settings 表里 master secret 的键名；版本号写在键里，便于整体轮换。
pub const MASTER_SECRET_KEY: &str = "hmac_secret_v1";

/// 32 字节随机 secret。用两个 UUIDv4 拼出来，不额外引入 rand。
const SECRET_LEN: usize = 32;

/// 读取 master secret；不存在时生成并写入，之后所有调用复用同一份。
///
/// 并发首启时以先写入者为准（`INSERT ... ON CONFLICT DO NOTHING` + 回读），
/// 否则同一实例上会出现两批互相不认的订阅。
pub async fn master_secret(pool: &SqlitePool) -> anyhow::Result<String> {
    if let Some(existing) = repo::settings::get(pool, MASTER_SECRET_KEY).await? {
        return Ok(existing);
    }

    let mut secret = [0u8; SECRET_LEN];
    secret[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    repo::settings::get_or_init(pool, MASTER_SECRET_KEY, &hex::encode(secret)).await
}

/// 某个用户在某节点上的子账户 UUID（稳定、可归因）。
pub fn sub_uuid(secret: &str, user_id: &str, node_id: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC 接受任意长度密钥，不会失败");
    mac.update(format!("v1/{user_id}/{node_id}").as_bytes());
    let digest = mac.finalize().into_bytes();

    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);

    // RFC 4122：version = 4，variant = RFC 4122（最高两位 10）。
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    uuid::Uuid::from_bytes(bytes).to_string()
}

/// Xray 流量统计用的 email，按 `{user_id}@{node_tag}` 聚合就能落到人和节点。
pub fn sub_email(user_id: &str, node_tag: &str) -> String {
    format!("{user_id}@{node_tag}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn same_pair_is_stable() {
        let first = sub_uuid(SECRET, "user-1", "node-1");
        let second = sub_uuid(SECRET, "user-1", "node-1");

        assert_eq!(first, second);
    }

    #[test]
    fn different_node_or_user_changes_the_uuid() {
        let base = sub_uuid(SECRET, "user-1", "node-1");

        assert_ne!(base, sub_uuid(SECRET, "user-1", "node-2"));
        assert_ne!(base, sub_uuid(SECRET, "user-2", "node-1"));
        assert_ne!(base, sub_uuid("another-secret", "user-1", "node-1"));
    }

    #[test]
    fn uuid_is_rfc4122_version_4() {
        let raw = sub_uuid(SECRET, "user-1", "node-1");

        assert_eq!(raw.len(), 36);
        let parsed = uuid::Uuid::parse_str(&raw).expect("输出必须是合法 UUID");
        assert_eq!(parsed.get_version_num(), 4);
        assert_eq!(parsed.get_variant(), uuid::Variant::RFC4122);

        let bytes = raw.as_bytes();
        assert_eq!(bytes[8], b'-');
        assert_eq!(bytes[13], b'-');
        assert_eq!(bytes[18], b'-');
        assert_eq!(bytes[23], b'-');
        assert_eq!(bytes[14], b'4');
        assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'));
    }

    #[test]
    fn email_is_user_at_node_tag() {
        assert_eq!(sub_email("user-1", "hk-01"), "user-1@hk-01");
    }
}
