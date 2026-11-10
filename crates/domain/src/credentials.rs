//! 订阅凭据派生：不建表，按 `(user, node)` 确定性生成子账户。
//!
//! 设计见 `docs/SUBSCRIBE.md` §2：
//!
//! ```text
//! sub_uuid  = UUIDv4(HMAC-SHA256(master_secret, "v1/{user_id}/{node_id}")[..16])
//! ss_key    = base64(HMAC-SHA256(master_secret, "ss2022/{user_id}/{node_id}"))
//! email     = "{user_id}@{node_tag}"
//! ```
//!
//! * master secret 存 `settings(key = hmac_secret_v1)`，首次调用时随机生成；
//! * `v1/` 前缀是轮换锚点：换 secret 只要写 `hmac_secret_v2`，老订阅自然失效；
//! * Shadowsocks 2022 的每用户密钥走**独立前缀** `ss2022/`：它和 vless 的 UUID
//!   是两套凭据，不能共用同一段密钥材料（否则泄漏一个等于泄漏另一个）；
//! * 派生是纯函数，同一对 `(user, node)` 在任何一次重启后都得到同一个凭据。

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

/// SS2022 每用户密钥：32 字节随机等价物，base64 标准编码。
///
/// SS2022 的 user 密码必须是「和 `openssl rand -base64 32` 等价」的密钥：
/// Xray 会先 base64 解码、再按方法要求的长度校验。这里用 HMAC-SHA256 的完整
/// 32 字节摘要，既是确定性的（同一个 `(user, node)` 永远得到同一把钥匙），
/// 又不需要额外存表。
///
/// **派生域**是 `ss2022/{user_id}/{node_id}`，和 [`sub_uuid`] 的 `v1/` 明确分开：
/// 两套凭据由同一份 master secret 派生，但绝不能互相泄露等价关系。
pub fn ss2022_user_key(secret: &str, user_id: &str, node_id: &str) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC 接受任意长度密钥，不会失败");
    mac.update(format!("ss2022/{user_id}/{node_id}").as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

/// 客户端实际填写的 Shadowsocks 密码。
///
/// * SS2022 多用户：客户端密码 = `ServerPassword:UserPassword`（服务端密钥在前，
///   每个用户的密钥在后）；
/// * 旧 AEAD 多用户：inbound 的 `password` 被忽略，用户密码就是客户端密码。
///
/// `server_key` 只在 SS2022 下传入；空串/纯空白按「没有服务端密钥」处理，
/// 避免拼出 `:user` 这种客户端一定连不上的形态。
pub fn ss_client_password(server_key: Option<&str>, user_password: &str) -> String {
    match server_key.map(str::trim).filter(|key| !key.is_empty()) {
        Some(server_key) => format!("{server_key}:{user_password}"),
        None => user_password.to_string(),
    }
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

    /// 测试内复算 HMAC，用来证明 `ss2022/` 与 `v1/` 是两个不同的派生域。
    fn hmac_b64(prefix: &str, secret: &str, user_id: &str, node_id: &str) -> String {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(format!("{prefix}{user_id}/{node_id}").as_bytes());
        STANDARD.encode(mac.finalize().into_bytes())
    }

    #[test]
    fn ss2022_user_key_is_stable_and_32_bytes_of_base64() {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;

        let first = ss2022_user_key(SECRET, "user-1", "node-1");
        assert_eq!(first, ss2022_user_key(SECRET, "user-1", "node-1"));

        let raw = STANDARD
            .decode(&first)
            .expect("2022 密钥必须是标准 base64（含 padding）");
        assert_eq!(raw.len(), 32, "SS2022 每用户密钥固定 32 字节");
        // `openssl rand -base64 32` 的输出是 44 字符（含一个 `=`）。
        assert_eq!(first.len(), 44);
        assert!(first.ends_with('='));
    }

    #[test]
    fn ss2022_user_key_differs_by_user_node_and_secret() {
        let base = ss2022_user_key(SECRET, "user-1", "node-1");

        assert_ne!(base, ss2022_user_key(SECRET, "user-1", "node-2"));
        assert_ne!(base, ss2022_user_key(SECRET, "user-2", "node-1"));
        assert_ne!(base, ss2022_user_key("another-secret", "user-1", "node-1"));
    }

    #[test]
    fn ss2022_user_key_uses_its_own_prefix_not_the_uuid_one() {
        let key = ss2022_user_key(SECRET, "user-1", "node-1");

        assert_eq!(key, hmac_b64("ss2022/", SECRET, "user-1", "node-1"));
        assert_ne!(
            key,
            hmac_b64("v1/", SECRET, "user-1", "node-1"),
            "SS2022 密钥不能复用 vless 的派生域"
        );
        // UUID 是前 16 字节的另一种编码，两者不可能相等。
        assert_ne!(key, sub_uuid(SECRET, "user-1", "node-1"));
    }

    #[test]
    fn ss_client_password_joins_server_and_user_for_2022() {
        assert_eq!(
            ss_client_password(Some("SERVER_KEY="), "USER_KEY="),
            "SERVER_KEY=:USER_KEY="
        );
    }

    #[test]
    fn ss_client_password_falls_back_to_user_password_for_legacy_aead() {
        assert_eq!(ss_client_password(None, "user-password"), "user-password");
        // 空 server key 等同于「旧 AEAD 没有服务端密钥」，不能拼出 `:user`。
        assert_eq!(
            ss_client_password(Some(""), "user-password"),
            "user-password"
        );
        assert_eq!(
            ss_client_password(Some("   "), "user-password"),
            "user-password"
        );
    }
}
