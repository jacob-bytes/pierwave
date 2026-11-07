//! 看门狗 helper 的端到端入口测试。
//!
//! 单元测试只能验证纯函数；这里真正执行 `pierwave-agent --rollback-check ...`，
//! 覆盖参数解析、`.bak` 还原和重启命令。测试用假 `systemctl` 走 PATH，
//! 不依赖真实 systemd，也不会碰这台机器上的服务。

use std::path::{Path, PathBuf};
use std::process::Command;

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        // 只用 pid + 纳秒会撞车：同一进程里并行跑的测试，macOS 的时钟粒度可能给出相同的值，
        // 两个测试共用目录就会互相删文件。再加一个进程内自增序号。
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "pierwave-cli-test-{}-{}-{}",
            std::process::id(),
            seq,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
fn write_executable(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, body).unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

#[cfg(unix)]
fn fake_systemctl(dir: &Path) -> (PathBuf, PathBuf) {
    let fake_bin = dir.join("fake-bin");
    std::fs::create_dir_all(&fake_bin).unwrap();
    let args_file = dir.join("systemctl.args");
    let script = fake_bin.join("systemctl");
    write_executable(
        &script,
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n",
            args_file.display()
        ),
    );
    (fake_bin, args_file)
}

#[cfg(unix)]
fn run_cli(args: &[&str], path_prefix: &Path) -> std::process::Output {
    let path = format!(
        "{}:{}",
        path_prefix.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    Command::new(env!("CARGO_BIN_EXE_pierwave-agent"))
        .args(args)
        .env("PATH", path)
        .output()
        .unwrap()
}

#[cfg(unix)]
#[test]
fn rollback_cli_restores_backup_and_restarts() {
    let dir = TempDir::new();
    let bin_dir = dir.path().join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let live = bin_dir.join("pierwave-agent");
    let backup = bin_dir.join("pierwave-agent.bak");
    let ok = dir.path().join("upgrade-ok");
    let pending = dir.path().join("upgrade-pending");
    std::fs::write(&live, b"new-agent").unwrap();
    std::fs::write(&backup, b"old-agent").unwrap();
    std::fs::write(&pending, b"0.6.0").unwrap();
    let (fake_bin, args_file) = fake_systemctl(dir.path());

    let out = run_cli(
        &[
            "--rollback-check",
            ok.to_str().unwrap(),
            backup.to_str().unwrap(),
        ],
        &fake_bin,
    );

    assert!(
        out.status.success(),
        "helper 应成功退出，stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        std::fs::read(&live).unwrap(),
        b"old-agent",
        "没有 ok 标记时必须还原 .bak"
    );
    assert!(!backup.exists(), "回滚后 .bak 被换回线上路径");
    assert!(!pending.exists(), "回滚后清理 pending");
    let args = std::fs::read_to_string(&args_file).unwrap();
    assert!(args.contains("restart"), "{args}");
    assert!(args.contains("pierwave-agent"), "{args}");
}

#[cfg(unix)]
#[test]
fn rollback_cli_accepts_custom_restart_command() {
    let dir = TempDir::new();
    let live = dir.path().join("pierwave-agent");
    let backup = dir.path().join("pierwave-agent.bak");
    let ok = dir.path().join("upgrade-ok");
    std::fs::write(&live, b"new-agent").unwrap();
    std::fs::write(&backup, b"old-agent").unwrap();
    let (fake_bin, args_file) = fake_systemctl(dir.path());

    let out = run_cli(
        &[
            "--rollback-check",
            ok.to_str().unwrap(),
            backup.to_str().unwrap(),
            "true",
        ],
        &fake_bin,
    );

    assert!(
        out.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(std::fs::read(&live).unwrap(), b"old-agent");
    assert!(
        !args_file.exists(),
        "第三个参数应覆盖默认的 systemctl restart"
    );
}

#[cfg(unix)]
#[test]
fn rollback_cli_with_ok_marker_does_not_touch_binary() {
    let dir = TempDir::new();
    let live = dir.path().join("pierwave-agent");
    let backup = dir.path().join("pierwave-agent.bak");
    let ok = dir.path().join("upgrade-ok");
    std::fs::write(&live, b"new-agent").unwrap();
    std::fs::write(&backup, b"old-agent").unwrap();
    std::fs::write(&ok, b"ok\n").unwrap();
    let (fake_bin, args_file) = fake_systemctl(dir.path());

    let out = run_cli(
        &[
            "--rollback-check",
            ok.to_str().unwrap(),
            backup.to_str().unwrap(),
        ],
        &fake_bin,
    );

    assert!(
        out.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(std::fs::read(&live).unwrap(), b"new-agent");
    assert_eq!(std::fs::read(&backup).unwrap(), b"old-agent");
    assert!(
        !args_file.exists(),
        "已经确认的升级不应再执行 systemctl restart"
    );
}

#[cfg(unix)]
#[test]
fn rollback_cli_rejects_missing_arguments() {
    let out = Command::new(env!("CARGO_BIN_EXE_pierwave-agent"))
        .arg("--rollback-check")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2), "参数不全应退 2");
    assert!(String::from_utf8_lossy(&out.stderr).contains("用法"));
}
