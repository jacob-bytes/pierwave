//! 秘密文件 / 私有目录的权限工具。
//!
//! 数据库、备份、Agent 的配置里都可能出现凭据或私钥；这类文件默认必须只有
//! 属主可读写（0600），目录只有属主可进入（0700）。这里把 `set_permissions`
//! 收敛成几个 helper，避免每个调用点各写一遍（写漏一处就是一次信息泄露）。
//!
//! 只在 unix 下改变权限：其它平台保持原有行为，避免引入不可移植的语义。
//! 对**已存在且权限过宽**的文件会先 `warn` 再自动收紧——升级前的库通常是
//! 0644，不能要求用户手动 `chmod`。
//!
//! 收紧失败（例如只读挂载 / NFS root-squash 拒绝 chmod）在**启动路径**上只
//! `warn`、不阻断启动；只有真正写入秘密文件时才会把权限错误上抛。

use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

/// 秘密文件的目标权限：仅属主可读写。
pub const PRIVATE_FILE_MODE: u32 = 0o600;

/// 私有目录的目标权限：仅属主可进入。
pub const PRIVATE_DIR_MODE: u32 = 0o700;

/// `""`、`.`、`/` 不是本产品创建的目录：收紧它们要么无意义（根目录），
/// 要么会把用户的工作目录一起改掉，必须跳过。
fn protected_dir(path: &Path) -> bool {
    path.as_os_str().is_empty() || path == Path::new(".") || path == Path::new("/")
}

/// 权限位不够私有时给出可读告警（双语，便于排障与前端日志聚合）。
fn warn_too_open(kind: &str, path: &Path, mode: u32, target: u32) {
    tracing::warn!(
        path = %path.display(),
        mode = format!("{mode:04o}"),
        target = format!("{target:04o}"),
        "{}权限过宽，已自动收紧 / {} was accessible to group/other, tightened to {:04o}",
        kind,
        kind,
        target
    );
}

/// 确保已存在的文件是 0600。
///
/// - 文件不存在：视为 déjà fait（调用方通常会先创建），返回 `Ok(())`；
/// - 权限过宽（group/other 有任何位）：`warn` 后自动收紧；
/// - 只有属主可读但具体位不同（例如 0400）：也校正到 0600，保持契约一致。
pub fn ensure_private_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if !metadata.is_file() {
            return Ok(());
        }
        let current = metadata.permissions().mode() & 0o7777;
        if current == PRIVATE_FILE_MODE {
            return Ok(());
        }
        if current & 0o077 != 0 {
            warn_too_open("文件", path, current, PRIVATE_FILE_MODE);
        }
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(PRIVATE_FILE_MODE))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// 确保已存在的目录是 0700；不存在或就是根/当前目录时跳过。
///
/// 收紧失败只 `warn`：只读挂载等场景下启动不能被权限问题卡死。
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    if protected_dir(path) {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if !metadata.is_dir() {
            return Ok(());
        }
        let current = metadata.permissions().mode() & 0o7777;
        if current == PRIVATE_DIR_MODE {
            return Ok(());
        }
        if current & 0o077 != 0 {
            warn_too_open("目录", path, current, PRIVATE_DIR_MODE);
        }
        if let Err(error) =
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE))
        {
            tracing::warn!(
                path = %path.display(),
                %error,
                "收紧目录权限失败（继续运行）/ failed to tighten directory; continuing"
            );
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// 递归创建目录，并只把**本次新建**的层级设成 0700；最后确保目标目录是 0700。
///
/// 只收紧新建层级而不是所有祖先：`/var/lib`、`/usr/local/etc` 这类系统目录
/// 不属于本产品，改它们的权限会影响同机其它服务。权限设置失败只 `warn`。
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    if protected_dir(path) {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut missing = Vec::new();
        let mut cursor = Some(path.to_path_buf());
        while let Some(dir) = cursor {
            if protected_dir(&dir) || dir.exists() {
                break;
            }
            missing.push(dir.clone());
            cursor = dir.parent().map(Path::to_path_buf);
        }
        std::fs::create_dir_all(path)?;
        // 从最浅的一层开始设权限，读起来与创建顺序一致。
        for dir in missing.iter().rev() {
            if let Err(error) =
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE))
            {
                tracing::warn!(
                    path = %dir.display(),
                    %error,
                    "收紧新建目录权限失败（继续运行）/ failed to tighten new directory; continuing"
                );
            }
        }
        ensure_private_dir(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)
    }
}

/// 以 0600 打开一个用于写入的文件（创建 / 截断）。
///
/// 已经存在的文件也会被校正：`OpenOptions::create(true)` 不会修改旧文件的
/// 权限，而升级前落下的临时文件完全可能是 0644。
pub fn open_private_file(path: &Path) -> io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(PRIVATE_FILE_MODE);
    }
    let file = options.open(path)?;
    // umask 只会去掉权限位；这里再写一次绝对值，保证任何 umask 下都是 0600。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(PRIVATE_FILE_MODE))?;
    }
    Ok(file)
}

/// 一次性写入并 `fsync`，权限固定为 0600。
pub fn write_private_file(path: &Path, content: &[u8]) -> io::Result<()> {
    let mut file = open_private_file(path)?;
    file.write_all(content)?;
    file.sync_all()
}

/// `fsync` 一个目录项：保证此前的 `rename` / 创建在崩溃后仍然可见。
///
/// 只需要在 Unix 上做（其它平台的目录 fsync 语义不同）；目录不存在或不是
/// 目录时视为 no-op，避免把「目录被清理」误报成密钥写入失败。
pub fn sync_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if !metadata.is_dir() {
            return Ok(());
        }
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// 为数据库准备主文件：不存在时先以 0600 创建，已存在时收紧。
///
/// 先创建再交给 SQLite 有两个好处：SQLite 不会放宽已有文件的权限，WAL/SHM
/// 旁路文件也会继承主库的 0600，而不是按默认 umask 落成 0644。
///
/// 已存在的库收紧失败只 `warn`：只读挂载 / 非属主场景下，启动不能因此失败。
pub fn prepare_private_file(path: &Path) -> io::Result<()> {
    if !path.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(PRIVATE_FILE_MODE)
                .open(path)
            {
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
    }
    if let Err(error) = ensure_private_file(path) {
        tracing::warn!(
            path = %path.display(),
            %error,
            "收紧数据库文件权限失败（继续启动）/ failed to tighten database file; continuing"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "pierwave-fs-security-{tag}-{}",
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

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// 已存在的 0644 文件必须被收紧；不存在的路径是 no-op（启动时扫全局路径用）。
    #[cfg(unix)]
    #[test]
    fn tightens_existing_file_and_ignores_missing_one() {
        let dir = TempDir::new("tighten");
        let path = dir.0.join("config.toml");
        std::fs::write(&path, b"token = \"x\"").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        ensure_private_file(&path).unwrap();
        assert_eq!(mode_of(&path), 0o600);

        ensure_private_file(&dir.0.join("absent.toml")).unwrap();
    }

    /// 递归创建时只收紧新建层级，目标目录必须是 0700。
    #[cfg(unix)]
    #[test]
    fn creates_missing_parents_owner_only() {
        let dir = TempDir::new("mkdir");
        let target = dir.0.join("a/b/c");
        create_private_dir(&target).unwrap();
        assert_eq!(mode_of(&target), 0o700);
        assert_eq!(mode_of(&dir.0.join("a")), 0o700);
        // 已存在的父目录（temp 根）不被改动。
        assert_ne!(mode_of(&dir.0), 0o700);
    }

    /// 写入时是 0600，覆盖一个 0644 旧文件后也必须回到 0600。
    #[cfg(unix)]
    #[test]
    fn writes_private_file_and_tightens_existing_target() {
        let dir = TempDir::new("write");
        let path = dir.0.join("realm.toml");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_private_file(&path, b"secret = true").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"secret = true");
        assert_eq!(mode_of(&path), 0o600);
    }
}
