//! 领域层：数据模型、仓储与不依赖 HTTP 的业务规则。
//! 这里不允许出现 axum / 请求上下文，方便被 master、CLI、测试共用。

pub mod apply;
pub mod backup;
pub mod billing;
pub mod certificate;
pub mod chain_templates;
pub mod chains;
pub mod country;
pub mod credentials;
pub mod enforcement;
pub mod engine;
pub mod error;
pub mod forwards;
pub mod fs_security;
pub mod fx;
pub mod hop_transport;
pub mod metering;
pub mod models;
pub mod password;
pub mod port_policy;
pub mod protocol;
pub mod reality;
pub mod release;
pub mod remote_backup;
pub mod repo;
pub mod reset;
pub mod routing;
pub mod secret_box;
pub mod subscribe;
pub mod subscription_template;
pub mod telemetry;
pub mod time;
pub mod tunnel_security;
pub mod updates;
pub mod xray;

use anyhow::Context;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::str::FromStr;

/// 编译期打进二进制的迁移集合；恢复校验用它判断「当前程序支持到哪一版」。
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// 当前二进制支持的最高迁移版本。
pub fn latest_migration_version() -> i64 {
    MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap_or(0)
}

pub struct Db {
    pub pool: SqlitePool,
    /// 文件型数据库的路径；`sqlite::memory:` 为 `None`。
    path: Option<PathBuf>,
    /// 备份与设置项共用的主密钥；来源见 [`secret_box`]。
    secret_key: secret_box::SecretKey,
}

impl Db {
    /// 从 `PIERWAVE_DB` 风格的 URL 解析出磁盘路径。
    ///
    /// 用 sqlx 自己的解析器（`SqliteConnectOptions::from_str`）而不是字符串
    /// 切割：`sqlite://`、`sqlite:`、百分号编码、绝对/相对路径都按 sqlx 的
    /// 规则落到同一个真实文件。`sqlite::memory:`（含 `?mode=memory`）返回
    /// `None`；空文件名或非 SQLite scheme 返回错误，**绝不静默当内存库**。
    pub fn database_path(url: &str) -> anyhow::Result<Option<PathBuf>> {
        let options = SqliteConnectOptions::from_str(url)
            .with_context(|| format!("数据库 URL 无法按 SQLite 解析：{url}"))?;
        database_path_from_options(url, &options)
    }

    /// 文件型数据库的路径；内存库返回 `None`。
    pub fn file_path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// 本进程使用的主密钥。**调用方不得把它写进日志或响应。**
    pub fn secret_key(&self) -> &secret_box::SecretKey {
        &self.secret_key
    }

    /// `sqlite://data/pierwave.db?mode=rwc`；目录不存在会自动创建。
    ///
    /// 文件库落盘后立即收紧权限：数据库文件和父目录（也是备份目录）默认都是
    /// 0600 / 0700，`-wal` / `-shm` 随主库一起收紧。升级前遗留的 0644 库会在
    /// 这里自动修正并 `warn`，不需要用户手动 `chmod`。
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        // 先按 sqlx 规则解析：单冒号 / 百分号编码都以这里为准，后续的路径、
        // 权限收紧、备份与主密钥位置都跟着同一个文件名走。
        let options = SqliteConnectOptions::from_str(url)
            .with_context(|| format!("数据库 URL 无法按 SQLite 解析：{url}"))?;
        let path = database_path_from_options(url, &options)?;
        // `sqlite::memory:` / `sqlite://:memory:` 由 sqlx 生成共享的
        // `file:sqlx-in-memory-N`，池里多条连接看到同一个库；而显式
        // `?mode=memory`（含空文件名、百分号编码与 `cache=private`）的每条
        // 连接都是独立库，必须锁成一条连接，且不能让它空闲超时被回收。
        let has_memory_mode = url
            .split_once('?')
            .is_some_and(|(_, query)| query_has_param(query, "mode", "memory"));
        let single_connection_memory = path.is_none()
            && (has_memory_mode
                || url
                    .split_once('?')
                    .is_some_and(|(_, query)| query_has_param(query, "cache", "private")));
        // 主密钥先于连接池加载：设置项解密/备份加密都依赖它。
        // 环境变量优先；文件型库用同目录的 secret.key；内存库用临时随机密钥。
        let secret_key = secret_box::SecretKey::for_database(path.as_deref())?;
        if let Some(path) = &path {
            if let Some(dir) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
                crate::fs_security::create_private_dir(dir)
                    .with_context(|| format!("创建数据库目录失败：{}", dir.display()))?;
            }
            // 先以 0600 建库文件：SQLite 不会放宽已有文件的权限，WAL/SHM 也会
            // 继承主库权限，而不是按默认 umask 落成 0644。
            crate::fs_security::prepare_private_file(path)
                .with_context(|| format!("准备数据库文件失败：{}", path.display()))?;
        }
        // 外键打开到连接选项里：池里每条连接都生效，删用户时套餐实例才会级联清理。
        let opts = options.create_if_missing(true).foreign_keys(true);
        let pool_options = if single_connection_memory {
            // 独立内存库只能有一条连接，且不能让它空闲超时被回收，否则
            // migrate 写在一号连接、查询跑到二号连接会报 `no such table`。
            SqlitePoolOptions::new()
                .min_connections(1)
                .max_connections(1)
                .idle_timeout(None)
                .max_lifetime(None)
        } else {
            SqlitePoolOptions::new().max_connections(5)
        };
        let pool = pool_options
            .connect_with(opts)
            .await
            .context("打开 SQLite 失败")?;
        // WAL + 忙等：高频心跳写入时避免整库被写锁住
        sqlx::query("PRAGMA journal_mode = WAL")
            .execute(&pool)
            .await
            .ok();
        sqlx::query("PRAGMA busy_timeout = 5000")
            .execute(&pool)
            .await
            .ok();
        if let Some(path) = &path {
            tighten_database_files(path);
        }
        Ok(Self {
            pool,
            path,
            secret_key,
        })
    }

    /// 执行迁移，并把已有的明文秘密就地加密（迁移 0058 的 Rust 侧）。
    ///
    /// 幂等：已带 `enc:v1:` 前缀的值会被跳过，所以重复调用不会重复加密。
    ///
    /// **顺序很重要**：先扫描有没有解不开的密文，再决定要不要加密明文。反过来的
    /// 话，混合状态（一个旧密钥写的密文 + 一些历史明文）会把明文用当前密钥重写，
    /// 而当前密钥很可能就是错的；管理员恢复原来的 `secret.key` 后，这些明文也
    /// 再也读不回来。发现异常时宁可这一轮不加密，把风险留给下一轮。
    pub async fn migrate(&self) -> anyhow::Result<()> {
        MIGRATOR
            .run(&self.pool)
            .await
            .context("执行数据库迁移失败")?;
        // 已带 `enc:v1:` 但当前密钥解不开的值不能静默跳过：日志里只出现键名。
        // 常见原因是恢复/迁移时换了主密钥；管理员需要据此恢复 secret.key。
        let unreadable = secret_box::find_unreadable_settings(&self.pool, &self.secret_key)
            .await
            .context("检查不可解密的秘密设置失败")?;
        if !unreadable.is_empty() {
            for key in &unreadable {
                tracing::error!(
                    key,
                    "秘密设置无法用当前主密钥解密；请恢复写入时使用的 data/secret.key 或 \
                     PIERWAVE_SECRET_KEY / a stored secret cannot be decrypted with the current \
                     master key"
                );
            }
            tracing::error!(
                keys = ?unreadable,
                "存在无法解密的秘密设置，已跳过历史明文的就地加密，避免把明文锁死在错误的密钥上"
            );
            return Ok(());
        }
        let encrypted = secret_box::encrypt_existing_settings(&self.pool, &self.secret_key)
            .await
            .context("加密已有设置项失败")?;
        if !encrypted.is_empty() {
            // 只记录键名，值可能是 Token / 密码。
            tracing::info!(keys = ?encrypted, "已把历史明文秘密设置加密落库");
        }
        Ok(())
    }

    /// 首次启动建管理员；返回生成的明文密码（仅当随机生成时）。
    pub async fn ensure_admin(&self, password: Option<String>) -> anyhow::Result<Option<String>> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&self.pool)
            .await?;
        if count > 0 {
            return Ok(None);
        }
        let (plain, generated) = match password {
            Some(p) => (p, None),
            None => {
                let p = password::random_password();
                (p.clone(), Some(p))
            }
        };
        repo::users::create(
            &self.pool,
            repo::users::NewUser {
                username: "admin".into(),
                password: plain,
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
            },
        )
        .await?;
        Ok(generated)
    }
}

/// 按 sqlx 解析出的文件名判断「是不是内存库」，并拒绝无法识别为空名的 URL。
fn database_path_from_options(
    url: &str,
    options: &SqliteConnectOptions,
) -> anyhow::Result<Option<PathBuf>> {
    if !url.starts_with("sqlite:") {
        anyhow::bail!("只支持 sqlite: 数据库 URL（当前：{url}）");
    }
    // sqlx 用 `url::form_urlencoded` 解析查询串并做 percent-decode，因此
    // `mode=mem%6Fry` 与 `mode=memory` 等价。只比较原始字符串会把它当成
    // 文件库，提前创建空数据库文件与 `secret.key`。
    let memory_mode = url
        .split_once('?')
        .is_some_and(|(_, query)| query_has_param(query, "mode", "memory"));
    let filename = options.get_filename();
    let as_text = filename.to_string_lossy();
    // sqlx 给 `sqlite::memory:` 生成 `file:sqlx-in-memory-<n>`；没有公开的
    // `in_memory()` getter，只能按这个内部文件名识别。
    if as_text.starts_with("file:sqlx-in-memory-") || memory_mode {
        return Ok(None);
    }
    if as_text.is_empty() {
        anyhow::bail!(
            "数据库 URL 没有文件名，无法确定落盘位置：{url}。请使用 \
             sqlite://data/pierwave.db?mode=rwc 这类形式，或用 sqlite::memory: \
             明确指定内存库 / the database URL has no filename"
        );
    }
    if as_text.starts_with("file:") {
        anyhow::bail!("数据库 URL 的文件名不是普通文件路径：{url}");
    }
    Ok(Some(filename.to_path_buf()))
}

/// 查询串里是否存在 `key=value`（两者都先做 form 风格 percent-decode）。
///
/// 不做完整的 URL 解析：只需要回答「mode 是不是 memory」，而且必须与 sqlx
/// 的解析口径一致（它用 `url::form_urlencoded::parse`）。
fn query_has_param(query: &str, wanted_key: &str, wanted_value: &str) -> bool {
    query.split('&').any(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        percent_decode_form(key) == wanted_key && percent_decode_form(value) == wanted_value
    })
}

/// 解码 form-urlencoded 组件：`+` 视为空格，非法 `%XX` 原样保留。
fn percent_decode_form(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = raw.get(index + 1..index + 3).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 主库与 SQLite 旁路文件（`-wal` / `-shm`）一起收紧到 0600。
///
/// 收紧失败只记 `warn`：文件可能属于 root 或位于不支持 chmod 的网络挂载上，
/// 但连接池已经可用，不能因此让整个服务起不来。
fn tighten_database_files(db_path: &Path) {
    if let Err(error) = crate::fs_security::ensure_private_file(db_path) {
        tracing::warn!(path = %db_path.display(), %error, "收紧数据库文件权限失败（继续运行）");
    }
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = db_path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        if let Err(error) = crate::fs_security::ensure_private_file(&sidecar) {
            tracing::warn!(path = %sidecar.display(), %error, "收紧数据库旁路文件权限失败（继续运行）");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "pierwave-domain-db-perm-{tag}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn db_path(&self) -> PathBuf {
            self.0.join("pierwave.db")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// 数据库 URL 必须按 sqlx 的规则解析，不能用字符串前缀切割。
    ///
    /// `sqlite:data/x.db`（单冒号）是 sqlx 合法写法；旧实现只认
    /// `sqlite://`，会把它当成内存库：随机密钥、权限作用错路径、备份报 400。
    #[test]
    fn database_url_parsing_follows_sqlx_rules() {
        for (url, expected) in [
            (
                "sqlite://data/pierwave.db?mode=rwc",
                Some(PathBuf::from("data/pierwave.db")),
            ),
            (
                "sqlite:data/pierwave.db?mode=rwc",
                Some(PathBuf::from("data/pierwave.db")),
            ),
            (
                "sqlite:///srv/pierwave/pierwave.db",
                Some(PathBuf::from("/srv/pierwave/pierwave.db")),
            ),
        ] {
            assert_eq!(
                Db::database_path(url).unwrap(),
                expected,
                "URL 必须解析成真实文件路径：{url}"
            );
        }

        // 百分号编码要解码后落到真实文件名，而不是带 `%20` 的目录。
        assert_eq!(
            Db::database_path("sqlite://data/pier%20wave.db?mode=rwc").unwrap(),
            Some(PathBuf::from("data/pier wave.db"))
        );

        // 真正的内存库才返回 None。
        for url in [
            "sqlite::memory:",
            "sqlite://:memory:",
            "sqlite://?mode=memory",
        ] {
            assert_eq!(
                Db::database_path(url).unwrap(),
                None,
                "内存库不应有文件路径：{url}"
            );
        }

        // 空文件名与不认识的 scheme 必须报错，不能静默当内存库。
        for url in ["sqlite://", "sqlite:", "postgres://localhost/pierwave"] {
            let error = Db::database_path(url).unwrap_err();
            let message = format!("{error:#}");
            assert!(
                message.contains("数据库 URL") || message.contains("SQLite"),
                "错误要可读：{url} -> {message}"
            );
        }
    }

    /// 内存库 URL 必须能完整跑通 connect + migrate + 读写。
    ///
    /// 空文件名 + `?mode=memory` 的每个连接都是独立内存库；连接池必须只开
    /// 一条连接（且不能让它在空闲时被回收），否则迁移写在一号连接、查询跑到
    /// 二号连接会报 `no such table`。
    #[tokio::test]
    async fn memory_urls_connect_migrate_and_read_write() {
        for url in [
            "sqlite://?mode=memory",
            "sqlite:?mode=memory",
            "sqlite://?mode=memory&cache=shared",
            "sqlite://?mode=memory&cache=private",
            "sqlite://?mode=mem%6Fry",
        ] {
            let db = Db::connect(url).await.unwrap();
            assert!(db.file_path().is_none(), "内存库不应有文件路径：{url}");
            db.migrate().await.unwrap();
            repo::settings::set(&db.pool, "panel_name", "Memory Panel")
                .await
                .unwrap();
            assert_eq!(
                repo::settings::get(&db.pool, "panel_name")
                    .await
                    .unwrap()
                    .as_deref(),
                Some("Memory Panel"),
                "迁移后的读写必须落在同一个内存库：{url}"
            );
            db.pool.close().await;
        }
    }

    /// 百分号编码的 `mode=mem%6Fry` 也必须按内存库处理。
    ///
    /// sqlx 在解析 URL 时会 percent-decode 查询参数；只用原始字符串比较
    /// `mode=memory` 会把它当成文件库，提前创建空数据库文件与 `secret.key`。
    #[tokio::test]
    async fn percent_encoded_memory_mode_never_creates_database_or_key_file() {
        let dir = TestDir::new("pct-memory");
        let path = dir.0.join("pierwave.db");
        let url = format!("sqlite://{}?mode=mem%6Fry", path.display());

        let db = Db::connect(&url).await.unwrap();
        assert!(
            db.file_path().is_none(),
            "百分号编码的 mode 也是内存库：{url}"
        );
        db.migrate().await.unwrap();
        repo::settings::set(&db.pool, "panel_name", "Pct Memory")
            .await
            .unwrap();
        assert_eq!(
            repo::settings::get(&db.pool, "panel_name")
                .await
                .unwrap()
                .as_deref(),
            Some("Pct Memory")
        );
        db.pool.close().await;

        assert!(
            !path.exists(),
            "内存库 URL 不能创建数据库文件：{}",
            path.display()
        );
        assert!(
            !dir.0.join(secret_box::SECRET_KEY_FILE_NAME).exists(),
            "内存库 URL 不能创建工作区 secret.key"
        );
    }

    /// 单冒号 URL 必须打开真实文件，并且两次 connect 复用同一个 `secret.key`。
    #[tokio::test]
    async fn single_colon_url_lands_on_disk_and_reuses_the_same_secret_key() {
        let dir = TestDir::new("single-colon");
        let path = dir.0.join("pier wave.db");
        let url = format!("sqlite:{}?mode=rwc", path.display());

        let first = Db::connect(&url).await.unwrap();
        assert_eq!(first.file_path(), Some(path.as_path()));
        first.migrate().await.unwrap();
        let key = first.secret_key().clone();
        first.pool.close().await;
        assert!(path.exists(), "单冒号 URL 必须真的落盘：{}", path.display());

        // 百分号编码形式指向同一个文件、同一把密钥。
        let encoded = url.replace(' ', "%20");
        let second = Db::connect(&encoded).await.unwrap();
        assert_eq!(second.file_path(), Some(path.as_path()));
        assert_eq!(
            second.secret_key(),
            &key,
            "同一 URL 两次 connect 必须同一密钥"
        );
        second.pool.close().await;
        assert!(
            path.with_file_name("secret.key").exists(),
            "文件型库必须生成同目录 secret.key"
        );
    }

    async fn open_db(path: &Path) -> Db {
        Db::connect(&format!("sqlite://{}?mode=rwc", path.display()))
            .await
            .unwrap()
    }

    /// 全部秘密都能解开时，迁移照常把历史明文加密。
    #[tokio::test]
    async fn migrate_encrypts_plaintext_when_every_secret_is_readable() {
        let dir = TestDir::new("migrate-healthy");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();
        repo::settings::set(&db.pool, "backup_webdav_password", "legacy-plain")
            .await
            .unwrap();

        db.migrate().await.unwrap();
        let raw = repo::settings::get(&db.pool, "backup_webdav_password")
            .await
            .unwrap()
            .unwrap();
        assert!(
            secret_box::is_encrypted_setting(&raw),
            "明文应被加密：{raw}"
        );
        assert_eq!(
            secret_box::reveal_setting(db.secret_key(), &raw).unwrap(),
            "legacy-plain"
        );
        db.pool.close().await;
    }

    /// 混合状态 + 错密钥：只要发现一个解不开的秘密，就不能再加密明文。
    ///
    /// 旧顺序是先 `encrypt_existing_settings` 再扫描：明文会被当前（错的）密钥
    /// 锁死，管理员即使之后恢复原来的 `secret.key` 也读不回来。
    #[tokio::test]
    async fn migrate_skips_encryption_when_a_secret_is_unreadable() {
        let dir = TestDir::new("migrate-mixed");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();

        let other = secret_box::SecretKey::generate().unwrap();
        repo::settings::set(
            &db.pool,
            "telegram_bot_token",
            &secret_box::encrypt_setting(&other, "written-with-another-key"),
        )
        .await
        .unwrap();
        repo::settings::set(&db.pool, "backup_webdav_password", "legacy-plain")
            .await
            .unwrap();

        db.migrate().await.unwrap();
        let raw = repo::settings::get(&db.pool, "backup_webdav_password")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            raw, "legacy-plain",
            "存在解不开的秘密时不能把明文锁死在错的密钥上"
        );
        db.pool.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn database_file_and_parent_directory_are_owner_only() {
        let dir = TestDir::new("new");
        let db = open_db(&dir.db_path()).await;
        db.migrate().await.unwrap();

        assert_eq!(mode_of(&dir.db_path()), 0o600, "数据库文件必须是 0600");
        assert_eq!(
            mode_of(&dir.0),
            0o700,
            "数据库目录（也是备份目录）必须是 0700"
        );
        db.pool.close().await;
    }

    /// 升级前已有的库通常是 0644：启动时必须自动收紧，而不是只对新建的库生效。
    #[cfg(unix)]
    #[tokio::test]
    async fn existing_world_readable_database_is_tightened_on_connect() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TestDir::new("existing");
        let path = dir.db_path();
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let db = open_db(&path).await;
        assert_eq!(mode_of(&path), 0o600, "已存在的 0644 库必须被收紧");
        db.pool.close().await;
    }

    /// WAL/SHM 与主库同级；主库 0600 时它们也必须是 0600。
    #[cfg(unix)]
    #[tokio::test]
    async fn wal_and_shm_sidecar_files_are_owner_only() {
        let dir = TestDir::new("wal");
        let path = dir.db_path();
        let db = open_db(&path).await;
        db.migrate().await.unwrap();
        // 写入落在 WAL 里，确保 -wal/-shm 真的存在再断言。
        sqlx::query("CREATE TABLE perm_probe (payload BLOB)")
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO perm_probe (payload) VALUES (?)")
            .bind(vec![1u8; 32 * 1024])
            .execute(&db.pool)
            .await
            .unwrap();

        for suffix in ["", "-wal", "-shm"] {
            let file = PathBuf::from(format!("{}{suffix}", path.display()));
            assert!(file.exists(), "旁路文件应存在：{}", file.display());
            assert_eq!(mode_of(&file), 0o600, "{} 必须是 0600", file.display());
        }
        db.pool.close().await;
    }
}
