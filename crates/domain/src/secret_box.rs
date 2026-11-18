//! 主密钥与 AEAD 信封：备份文件与 `settings` 表中的秘密共用同一套密钥机制。
//!
//! ## 主密钥来源（优先级从高到低）
//!
//! 1. 环境变量 `PIERWAVE_SECRET_KEY`：base64 编码的 32 字节密钥；
//! 2. 数据库同目录的 `secret.key`（默认 `data/secret.key`）：不存在时自动生成，
//!    权限固定 0600，并 `warn` 提示备份。
//!
//! **绝不把密钥或明文写进日志/错误信息。** 生成密钥时的 `warn` 只包含文件路径；
//! 解密失败的提示只说「主密钥不匹配或数据已损坏」，不包含密文、明文或具体原因。
//!
//! ## 信封格式
//!
//! ```text
//! MAGIC(4) = "PWSB" | VERSION(1) = 0x01 | NONCE(12) | CIPHERTEXT(+16 字节 GCM tag)
//! ```
//!
//! 使用 AES-256-GCM（ring）。每次 `seal` 生成新的 12 字节随机 nonce；`open`
//! 校验 MAGIC/VERSION 后解密并验证 tag，任何一字节被篡改都会失败。
//!
//! ## `settings` 表里的文本编码
//!
//! 密文值以 `enc:v1:` 为前缀，后面是完整信封的 base64。没有前缀的历史明文
//! 仍按明文读取（升级兼容），迁移 0058 会把它就地加密（已带前缀的跳过，幂等）。

use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};
use sqlx::SqlitePool;

use crate::repo;

/// 信封魔数：`PWSB` = PierWave Secret Box。恢复接口按它识别加密备份。
pub const MAGIC: [u8; 4] = *b"PWSB";

/// 信封版本；不认识的版本一律拒绝，避免把未来格式当成本格式解。
pub const VERSION: u8 = 1;

/// AES-256 的密钥长度。
pub const KEY_LEN: usize = 32;

/// GCM nonce 长度。
pub const NONCE_LEN: usize = 12;

/// GCM 认证标签长度。
pub const TAG_LEN: usize = 16;

/// 信封头部长度：MAGIC + VERSION + NONCE。
pub const HEADER_LEN: usize = MAGIC.len() + 1 + NONCE_LEN;

/// 最短合法密文：头部 + 空明文也要有的 tag。
pub const MIN_BLOB_LEN: usize = HEADER_LEN + TAG_LEN;

/// `settings` 表中的密文前缀。
pub const ENCRYPTED_SETTING_PREFIX: &str = "enc:v1:";

/// 主密钥的环境变量名。
pub const SECRET_KEY_ENV: &str = "PIERWAVE_SECRET_KEY";

/// 数据库同目录下的主密钥文件名。
pub const SECRET_KEY_FILE_NAME: &str = "secret.key";

/// 没有文件型数据库时（例如 `sqlite::memory:`）的默认密钥路径，仅用于文档与
/// `Db` 的默认推导；内存库本身使用进程内随机密钥，不落盘。
pub const DEFAULT_SECRET_KEY_FILE: &str = "data/secret.key";

/// 落盘时需要加密的设置项。
///
/// * `telegram_bot_token` / `backup_webdav_password`：管理员填写的凭据；
/// * `webhook_url`：Webhook 地址的路径里经常直接带 token；
/// * `hmac_secret_v1`：订阅凭据派生用的内部 master secret（不可从设置页修改）。
pub const SECRET_SETTING_KEYS: [&str; 4] = [
    "telegram_bot_token",
    "backup_webdav_password",
    "webhook_url",
    "hmac_secret_v1",
];

/// 32 字节主密钥。
///
/// `Debug` 故意只输出 `<redacted>`：`tracing` 的 `?key`、测试失败信息都不会
/// 把密钥材料带出去。
#[derive(Clone, PartialEq, Eq)]
pub struct SecretKey([u8; KEY_LEN]);

impl fmt::Debug for SecretKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretKey(<redacted>)")
    }
}

impl SecretKey {
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// 解析 base64 编码的 32 字节密钥（环境变量与 `secret.key` 文本共用）。
    pub fn from_base64(raw: &str) -> anyhow::Result<Self> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            bail!("主密钥为空（需要 base64 编码的 32 字节密钥）");
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(trimmed)
            .context("主密钥不是合法的 base64（需要 base64 编码的 32 字节密钥）")?;
        if bytes.len() != KEY_LEN {
            bail!("主密钥长度是 {} 字节，必须是 {KEY_LEN} 字节", bytes.len());
        }
        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(&bytes);
        Ok(Self(key))
    }

    /// 生成新的随机密钥。只在 `seal`/文件初始化时使用，不打印结果。
    pub fn generate() -> anyhow::Result<Self> {
        let mut bytes = [0u8; KEY_LEN];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| anyhow::anyhow!("系统随机数生成器不可用，无法生成主密钥"))?;
        Ok(Self(bytes))
    }

    fn to_base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.0)
    }

    /// 读取 `PIERWAVE_SECRET_KEY`；未设置返回 `Ok(None)`。
    ///
    /// 设置了但格式非法时返回错误而不是回落文件：静默换一把密钥会让已加密的
    /// 备份与设置全部解不开，宁可启动失败。
    pub fn load_from_env() -> anyhow::Result<Option<Self>> {
        match std::env::var(SECRET_KEY_ENV) {
            Ok(raw) => Self::from_base64(&raw)
                .with_context(|| format!("{SECRET_KEY_ENV} 不是合法的主密钥"))
                .map(Some),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(std::env::VarError::NotUnicode(_)) => {
                bail!("{SECRET_KEY_ENV} 不是合法的 UTF-8 文本")
            }
        }
    }

    /// 数据库文件同目录的 `secret.key`；没有文件路径时用默认 `data/secret.key`。
    pub fn key_file_path(db_path: Option<&Path>) -> PathBuf {
        match db_path.and_then(Path::parent) {
            Some(parent) if !parent.as_os_str().is_empty() => parent.join(SECRET_KEY_FILE_NAME),
            _ => PathBuf::from(DEFAULT_SECRET_KEY_FILE),
        }
    }

    /// 按「环境变量 > 文件 > 针对内存库的临时随机密钥」加载主密钥。
    pub fn for_database(db_path: Option<&Path>) -> anyhow::Result<Self> {
        if let Some(key) = Self::load_from_env()? {
            return Ok(key);
        }
        match db_path {
            Some(path) => Ok(Self::load_or_create(&Self::key_file_path(Some(path)))?.0),
            // 内存库没有可持久化的位置：用进程内随机密钥。测试与临时实例不会
            // 在工作区留下 `data/secret.key`，也不会与真实部署共用密钥。
            None => Self::generate(),
        }
    }

    /// 读取已有密钥文件；不存在时以 0600 原子创建并 `warn` 提示备份。
    ///
    /// 返回 `(key, generated)`。已存在的文件会被收紧到 0600（升级前可能是 0644）。
    pub fn load_or_create(path: &Path) -> anyhow::Result<(Self, bool)> {
        match std::fs::read(path) {
            Ok(bytes) => {
                crate::fs_security::ensure_private_file(path)
                    .with_context(|| format!("收紧主密钥文件权限失败：{}", path.display()))?;
                let key = Self::from_file_bytes(&bytes)
                    .with_context(|| format!("解析主密钥文件失败：{}", path.display()))?;
                Ok((key, false))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Some(parent) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
                    crate::fs_security::create_private_dir(parent)
                        .with_context(|| format!("创建主密钥目录失败：{}", parent.display()))?;
                }
                Self::create_key_file(path)
            }
            Err(error) => {
                Err(error).with_context(|| format!("读取主密钥文件失败：{}", path.display()))
            }
        }
    }

    /// `create_new` 保证并发首启时只有一方生成密钥；另一方读到先写入的文件。
    fn create_key_file(path: &Path) -> anyhow::Result<(Self, bool)> {
        let key = Self::generate()?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(crate::fs_security::PRIVATE_FILE_MODE);
        }
        match options.open(path) {
            Ok(mut file) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    file.set_permissions(std::fs::Permissions::from_mode(
                        crate::fs_security::PRIVATE_FILE_MODE,
                    ))?;
                }
                file.write_all(key.to_base64().as_bytes())?;
                file.write_all(b"\n")?;
                file.sync_all()?;
                // 只记录路径，绝不记录密钥内容。
                tracing::warn!(
                    path = %path.display(),
                    "已生成主密钥文件，请备份该文件；丢失后已加密的备份与设置无法解密 / \
                     Generated the master key file. Back it up: losing it makes encrypted \
                     backups and settings unrecoverable"
                );
                Ok((key, true))
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // 另一个进程抢先创建：读它写下的密钥，禁止覆盖。
                let bytes = std::fs::read(path)
                    .with_context(|| format!("读取主密钥文件失败：{}", path.display()))?;
                let key = Self::from_file_bytes(&bytes)
                    .with_context(|| format!("解析主密钥文件失败：{}", path.display()))?;
                Ok((key, false))
            }
            Err(error) => {
                Err(error).with_context(|| format!("创建主密钥文件失败：{}", path.display()))
            }
        }
    }

    /// 文件内容既接受 base64 文本（本产品写入的格式），也接受裸 32 字节。
    fn from_file_bytes(bytes: &[u8]) -> anyhow::Result<Self> {
        if bytes.len() == KEY_LEN {
            let mut key = [0u8; KEY_LEN];
            key.copy_from_slice(bytes);
            return Ok(Self(key));
        }
        let text = std::str::from_utf8(bytes).context("主密钥文件不是 UTF-8 文本")?;
        Self::from_base64(text)
    }
}

/// 把明文封装成信封：`MAGIC | VERSION | NONCE | CIPHERTEXT(+tag)`。
///
/// 随机源失败属于不可恢复的环境错误，直接 panic（与 `ring` 示例一致）；
/// 正常路径不会失败。
pub fn seal(key: &SecretKey, plaintext: &[u8]) -> Vec<u8> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .expect("系统随机数生成器不可用，无法加密");
    let unbound =
        UnboundKey::new(&AES_256_GCM, &key.0).expect("AES-256-GCM 的密钥长度固定为 32 字节");
    let sealing = LessSafeKey::new(unbound);

    let mut ciphertext = plaintext.to_vec();
    sealing
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::empty(),
            &mut ciphertext,
        )
        .expect("AES-256-GCM 加密不会因输入长度失败");

    let mut blob = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    blob.extend_from_slice(&MAGIC);
    blob.push(VERSION);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    blob
}

/// 解密信封并验证 tag；任何格式/密钥/篡改问题都返回可读但**不含敏感信息**的错误。
pub fn open(key: &SecretKey, blob: &[u8]) -> anyhow::Result<Vec<u8>> {
    if blob.len() < MIN_BLOB_LEN {
        bail!("加密数据长度不足，不是有效的密文");
    }
    if blob[..MAGIC.len()] != MAGIC {
        bail!("加密数据头不匹配，不是本产品生成的密文");
    }
    if blob[MAGIC.len()] != VERSION {
        bail!("不支持的加密数据版本：{}", blob[MAGIC.len()]);
    }
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&blob[MAGIC.len() + 1..HEADER_LEN]);
    let mut ciphertext = blob[HEADER_LEN..].to_vec();

    let unbound =
        UnboundKey::new(&AES_256_GCM, &key.0).expect("AES-256-GCM 的密钥长度固定为 32 字节");
    let opening = LessSafeKey::new(unbound);
    let plaintext = opening
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::empty(),
            &mut ciphertext,
        )
        .map_err(|_| anyhow::anyhow!("解密失败：主密钥与写入时不一致，或数据已损坏"))?;
    Ok(plaintext.to_vec())
}

/// 某个 `settings` 键是否需要落盘加密。
pub fn is_secret_setting(name: &str) -> bool {
    SECRET_SETTING_KEYS.contains(&name)
}

/// 值是否已经是加密格式。
pub fn is_encrypted_setting(raw: &str) -> bool {
    raw.starts_with(ENCRYPTED_SETTING_PREFIX)
}

/// 把明文设置值封装成可落库的 `enc:v1:<base64>` 文本。
pub fn encrypt_setting(key: &SecretKey, plaintext: &str) -> String {
    let blob = seal(key, plaintext.as_bytes());
    format!(
        "{ENCRYPTED_SETTING_PREFIX}{}",
        base64::engine::general_purpose::STANDARD.encode(blob)
    )
}

/// 解密一个 `enc:v1:` 设置值；没有前缀的值当作历史明文返回。
///
/// 读取侧保持明文兼容，保证「迁移 0058 尚未跑到的库」和「旧二进制写下的值」
/// 都不会突然失效。
pub fn reveal_setting(key: &SecretKey, raw: &str) -> anyhow::Result<String> {
    let Some(encoded) = raw.strip_prefix(ENCRYPTED_SETTING_PREFIX) else {
        return Ok(raw.to_string());
    };
    let blob = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("设置密文不是合法的 base64")?;
    let plaintext = open(key, &blob)?;
    String::from_utf8(plaintext).context("解密后的设置不是合法的 UTF-8")
}

/// 迁移 0058 的 Rust 侧：把已有明文秘密就地加密。
///
/// 完全幂等：空值与已带 `enc:v1:` 前缀的值跳过；返回本次实际改写的键名，
/// 调用方只记录键名（不记录值）。
pub async fn encrypt_existing_settings(
    pool: &SqlitePool,
    key: &SecretKey,
) -> anyhow::Result<Vec<&'static str>> {
    let mut changed = Vec::new();
    for name in SECRET_SETTING_KEYS {
        let Some(raw) = repo::settings::get(pool, name).await? else {
            continue;
        };
        if raw.is_empty() || is_encrypted_setting(&raw) {
            continue;
        }
        let sealed = encrypt_setting(key, &raw);
        repo::settings::set(pool, name, &sealed).await?;
        changed.push(name);
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::Db;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "pierwave-secret-box-{tag}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn key() -> SecretKey {
        SecretKey::from_bytes([7u8; KEY_LEN])
    }

    #[test]
    fn seal_and_open_round_trip_including_empty_and_large_payloads() {
        let key = key();
        for plaintext in [b"".as_slice(), b"hello", &vec![9u8; 1024 * 1024]] {
            let blob = seal(&key, plaintext);
            assert!(blob.starts_with(&MAGIC));
            assert_eq!(blob[MAGIC.len()], VERSION);
            assert_eq!(blob.len(), HEADER_LEN + plaintext.len() + TAG_LEN);
            assert_eq!(open(&key, &blob).unwrap(), plaintext);
        }
    }

    #[test]
    fn nonce_is_fresh_for_every_seal() {
        let key = key();
        let first = seal(&key, b"same");
        let second = seal(&key, b"same");
        assert_ne!(
            first[MAGIC.len() + 1..HEADER_LEN],
            second[MAGIC.len() + 1..HEADER_LEN],
            "每次加密都必须使用新的随机 nonce"
        );
        assert_ne!(first, second);
    }

    #[test]
    fn tampering_any_byte_fails_with_readable_error() {
        let key = key();
        let blob = seal(&key, b"database-bytes");

        // 篡改 tag / 密文。
        let mut tampered = blob.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        let error = open(&key, &tampered).unwrap_err();
        assert!(error.to_string().contains("解密失败"), "{error}");
        assert!(!error.to_string().contains("database-bytes"));

        // 篡改 nonce。
        let mut tampered = blob.clone();
        tampered[MAGIC.len() + 1] ^= 0x01;
        assert!(open(&key, &tampered).is_err());

        // 篡改 MAGIC / VERSION。
        let mut tampered = blob.clone();
        tampered[0] ^= 0x01;
        assert!(open(&key, &tampered).is_err());
        let mut tampered = blob.clone();
        tampered[MAGIC.len()] = 0xff;
        assert!(open(&key, &tampered).is_err());

        // 截断。
        assert!(open(&key, &blob[..MIN_BLOB_LEN - 1]).is_err());
    }

    #[test]
    fn wrong_key_fails_without_leaking_anything() {
        let sealed = seal(&key(), b"top-secret-value");
        let error = open(&SecretKey::from_bytes([8u8; KEY_LEN]), &sealed).unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("主密钥"), "{message}");
        assert!(!message.contains("top-secret-value"), "{message}");
        assert!(!format!("{error:?}").contains("top-secret-value"));
    }

    #[test]
    fn base64_key_parsing_requires_exactly_32_bytes() {
        let encoded = base64::engine::general_purpose::STANDARD.encode([3u8; KEY_LEN]);
        let parsed = SecretKey::from_base64(&format!("  {encoded}\n")).unwrap();
        assert_eq!(parsed, SecretKey::from_bytes([3u8; KEY_LEN]));

        assert!(SecretKey::from_base64("not-base64!!").is_err());
        let short = base64::engine::general_purpose::STANDARD.encode([1u8; 16]);
        assert!(SecretKey::from_base64(&short).is_err());
        assert!(SecretKey::from_base64("   ").is_err());
    }

    #[test]
    fn debug_never_prints_key_material() {
        let debug = format!("{:?}", SecretKey::from_bytes([0xab; KEY_LEN]));
        assert_eq!(debug, "SecretKey(<redacted>)");
        assert!(!debug.contains("ab"));
    }

    #[cfg(unix)]
    #[test]
    fn generated_key_file_is_owner_only_and_stable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new("keyfile");
        let path = dir.0.join(SECRET_KEY_FILE_NAME);
        let (first, generated) = SecretKey::load_or_create(&path).unwrap();
        assert!(generated);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "secret.key 必须是 0600");

        // 再次读取必须得到同一把密钥，且不会重新生成。
        let (second, generated) = SecretKey::load_or_create(&path).unwrap();
        assert!(!generated);
        assert_eq!(first, second);

        // 升级前遗留的 0644 文件会被收紧。
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let _ = SecretKey::load_or_create(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn key_file_path_sits_next_to_the_database() {
        assert_eq!(
            SecretKey::key_file_path(Some(Path::new("data/pierwave.db"))),
            PathBuf::from("data/secret.key")
        );
        assert_eq!(
            SecretKey::key_file_path(Some(Path::new("/srv/pierwave/pierwave.db"))),
            PathBuf::from("/srv/pierwave/secret.key")
        );
    }

    #[test]
    fn setting_text_is_prefixed_and_round_trips() {
        let key = key();
        let sealed = encrypt_setting(&key, "123456:ABC");
        assert!(sealed.starts_with(ENCRYPTED_SETTING_PREFIX));
        assert!(!sealed.contains("123456:ABC"));
        assert_eq!(reveal_setting(&key, &sealed).unwrap(), "123456:ABC");

        // 历史明文没有前缀：读取侧继续可用，不会被当成损坏。
        assert_eq!(
            reveal_setting(&key, "legacy-plain").unwrap(),
            "legacy-plain"
        );
        // 空值也保持为空，不写 `enc:v1:`。
        assert!(encrypt_setting(&key, "").starts_with(ENCRYPTED_SETTING_PREFIX));
    }

    #[tokio::test]
    async fn migration_encrypts_plaintext_settings_once_and_keeps_them_readable() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();

        // 模拟升级前的库：迁移之后再写入历史明文（迁移不会碰这些新值）。
        for (name, value) in [
            ("telegram_bot_token", "123456:ABC-def"),
            ("backup_webdav_password", "p@ss word"),
            ("webhook_url", "https://example.test/hook/secret"),
            ("hmac_secret_v1", "aabbccdd"),
        ] {
            repo::settings::set(&db.pool, name, value).await.unwrap();
        }

        let changed = encrypt_existing_settings(&db.pool, db.secret_key())
            .await
            .unwrap();
        assert_eq!(changed.len(), 4, "四个秘密项都应被加密：{changed:?}");
        for (name, expected) in [
            ("telegram_bot_token", "123456:ABC-def"),
            ("backup_webdav_password", "p@ss word"),
            ("webhook_url", "https://example.test/hook/secret"),
            ("hmac_secret_v1", "aabbccdd"),
        ] {
            let raw = repo::settings::get(&db.pool, name).await.unwrap().unwrap();
            assert!(is_encrypted_setting(&raw), "{name} 应存密文：{raw}");
            assert!(!raw.contains(expected), "{name} 的明文不能落库：{raw}");
            assert_eq!(
                reveal_setting(db.secret_key(), &raw).unwrap(),
                expected,
                "{name} 迁移后必须仍可读取"
            );
        }

        // 幂等：第二次没有改动，密文逐字节不变。
        let before: Vec<String> = {
            let mut values = Vec::new();
            for name in SECRET_SETTING_KEYS {
                values.push(repo::settings::get(&db.pool, name).await.unwrap().unwrap());
            }
            values
        };
        let changed = encrypt_existing_settings(&db.pool, db.secret_key())
            .await
            .unwrap();
        assert!(changed.is_empty(), "第二次迁移不应改写：{changed:?}");
        for (name, previous) in SECRET_SETTING_KEYS.iter().zip(before) {
            assert_eq!(
                repo::settings::get(&db.pool, name).await.unwrap().unwrap(),
                previous
            );
        }
    }

    #[tokio::test]
    async fn migration_skips_empty_secret_values() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        repo::settings::set(&db.pool, "telegram_bot_token", "")
            .await
            .unwrap();

        let changed = encrypt_existing_settings(&db.pool, db.secret_key())
            .await
            .unwrap();
        assert!(changed.is_empty());
        assert_eq!(
            repo::settings::get(&db.pool, "telegram_bot_token")
                .await
                .unwrap()
                .unwrap(),
            ""
        );
    }

    #[test]
    fn db_migrate_creates_backup_encrypt_default_and_is_idempotent() {
        // 迁移只追加：0058 写入默认开关，重复执行不会重复插入。
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let db = Db::connect("sqlite::memory:").await.unwrap();
            db.migrate().await.unwrap();
            db.migrate().await.unwrap();
            assert_eq!(
                repo::settings::get(&db.pool, "backup_encrypt")
                    .await
                    .unwrap()
                    .as_deref(),
                Some("1")
            );
        });
    }
}
