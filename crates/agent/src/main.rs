mod config;
mod traffic;

use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use pierwave_proto::{
    AgentHello, AgentMessage, ApplyResult, DesiredState, Heartbeat, MasterMessage, TrafficReport,
    PROTOCOL_VERSION,
};
use tokio_tungstenite::tungstenite::Message;

use crate::config::Config;
use crate::traffic::TrafficSampler;

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 校验失败时回传主控的输出上限
const ERROR_OUTPUT_LIMIT: usize = 2048;
/// 默认备份后缀；配置里留空也退回这个值
const DEFAULT_BACKUP_SUFFIX: &str = ".bak";

/// 本进程已成功应用的配置版本；跨重连保留，重启后归零（会重新收敛一次）。
static APPLIED_VERSION: AtomicI64 = AtomicI64::new(0);

fn should_apply(incoming: i64, applied: i64) -> bool {
    incoming > applied
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,pierwave_agent=debug".into()),
        )
        .init();

    let path = std::env::args()
        .skip_while(|a| a != "-c")
        .nth(1)
        .or_else(|| std::env::var("PIERWAVE_CONFIG").ok())
        .unwrap_or_else(|| "/etc/pierwave-agent/config.toml".into());
    let cfg = Config::load(std::path::Path::new(&path))?;
    tracing::info!(%path, master = %cfg.master_url, "agent starting");

    // 断线重连：指数退避，上限 60s。
    // boot_id / 流量 seq / 采样基线都放在重连循环外：进程级身份不变，
    // 重连后既不会换 id，也不会把已经上报过的累计流量再报一遍。
    let boot_id = uuid::Uuid::new_v4().to_string();
    let mut sampler = TrafficSampler::new();
    let mut traffic_seq = 0u64;
    let mut backoff = 1u64;
    loop {
        match run_once(&cfg, &boot_id, &mut sampler, &mut traffic_seq).await {
            Ok(()) => backoff = 1,
            Err(e) => {
                tracing::warn!(error = %e, backoff, "connection dropped");
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(60);
            }
        }
    }
}

async fn run_once(
    cfg: &Config,
    boot_id: &str,
    sampler: &mut TrafficSampler,
    traffic_seq: &mut u64,
) -> Result<()> {
    let url = cfg.ws_url();
    let (mut ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .with_context(|| format!("连接主控失败: {url}"))?;

    let hello = AgentMessage::Hello(AgentHello {
        token: cfg.token.clone(),
        hostname: hostname(),
        agent_version: AGENT_VERSION.into(),
        xray_mode: cfg.xray_mode.clone(),
        capabilities: vec!["xray".into(), "nginx".into()],
    });
    ws.send(Message::Text(serde_json::to_string(&hello)?))
        .await?;

    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    let traffic_interval = cfg.stats_interval_secs.max(1);
    let mut traffic = tokio::time::interval(Duration::from_secs(traffic_interval));
    let uptime_start = std::time::Instant::now();
    let mut seq = 0u64;

    loop {
        tokio::select! {
            incoming = ws.next() => {
                let Some(frame) = incoming else { return Ok(()) };
                let frame = frame?;
                let Message::Text(text) = frame else { continue };
                match serde_json::from_str::<MasterMessage>(&text) {
                    Ok(MasterMessage::Ack(ack)) => {
                        tracing::info!(server_id = %ack.server_id, config_version = ack.config_version,
                            protocol = ack.protocol_version, "registered");
                    }
                    Ok(MasterMessage::Desired(state)) => {
                        let applied = APPLIED_VERSION.load(Ordering::Relaxed);
                        let result = if should_apply(state.version, applied) {
                            let result = apply_state(&state, cfg).await;
                            if result.ok {
                                APPLIED_VERSION.store(state.version, Ordering::Relaxed);
                            }
                            result
                        } else {
                            tracing::info!(
                                version = state.version,
                                applied,
                                "desired state already applied, skipping restart"
                            );
                            ApplyResult { version: state.version, ok: true, error: None }
                        };
                        let msg = AgentMessage::ApplyResult(result);
                        ws.send(Message::Text(serde_json::to_string(&msg)?)).await?;
                    }
                    Ok(MasterMessage::Error { message }) => {
                        tracing::error!(%message, "master rejected agent");
                        anyhow::bail!("master rejected agent: {message}");
                    }
                    Ok(MasterMessage::Ping) => {
                        ws.send(Message::Text(r#"{"type":"heartbeat","seq":0,"uptime_secs":0,"load1":0.0,"mem_used":0,"mem_total":0,"disk_used":0,"disk_total":0,"xray_running":false,"nginx_running":false}"#.into())).await.ok();
                    }
                    Err(e) => tracing::warn!(error = %e, "unknown master message"),
                }
            }
            _ = heartbeat.tick() => {
                seq += 1;
                let hb = AgentMessage::Heartbeat(sample_heartbeat(seq, uptime_start.elapsed().as_secs()));
                ws.send(Message::Text(serde_json::to_string(&hb)?)).await?;
            }
            _ = traffic.tick() => {
                match sampler.sample(&cfg.stats_query_command) {
                    Ok(sample) => {
                        if sample.reset {
                            tracing::warn!(
                                "Xray 计数器归零（可能已重启），本轮按当前计数全量上报"
                            );
                        }
                        if !sample.deltas.is_empty() {
                            *traffic_seq += 1;
                            let uplink: u64 = sample.deltas.iter().map(|delta| delta.uplink).sum();
                            let downlink: u64 =
                                sample.deltas.iter().map(|delta| delta.downlink).sum();
                            tracing::debug!(
                                seq = *traffic_seq,
                                users = sample.deltas.len(),
                                uplink,
                                downlink,
                                "上报流量增量"
                            );
                            let report = TrafficReport {
                                seq: *traffic_seq,
                                boot_id: boot_id.to_string(),
                                deltas: sample.deltas,
                            };
                            ws.send(Message::Text(serde_json::to_string(
                                &AgentMessage::Traffic(report),
                            )?))
                            .await?;
                        }
                    }
                    // 失败不 panic、也不回滚基线：下一轮从上一份成功快照继续算增量。
                    Err(e) => tracing::warn!(error = %e, "采集 Xray 流量失败，跳过本轮"),
                }
            }
        }
    }
}

/// 收敛到期望态：其它文件原子落盘，xray 配置走「校验 → 备份 → 替换 → 重启」，失败回滚。
async fn apply_state(state: &DesiredState, cfg: &Config) -> ApplyResult {
    let backup_suffix = match cfg.backup_suffix.as_deref() {
        Some(s) if !s.is_empty() => s,
        _ => DEFAULT_BACKUP_SUFFIX,
    };
    let result = apply_files(state).and_then(|()| {
        let content = serde_json::to_vec_pretty(&state.xray).context("序列化 xray 配置失败")?;
        apply_xray_atomic(
            Path::new(&cfg.xray_config_path),
            &content,
            &cfg.xray_test_command,
            backup_suffix,
            &cfg.restart_command,
        )
    });
    match result {
        Ok(()) => {
            tracing::info!(version = state.version, "desired state applied");
            ApplyResult {
                version: state.version,
                ok: true,
                error: None,
            }
        }
        Err(e) => {
            tracing::error!(version = state.version, error = %e, "apply failed");
            ApplyResult {
                version: state.version,
                ok: false,
                error: Some(e.to_string()),
            }
        }
    }
}

/// 其它受管文件同样「写临时文件 → rename」，但不参与 xray 校验。
fn apply_files(state: &DesiredState) -> Result<()> {
    for f in &state.files {
        let path = Path::new(&f.path);
        let tmp = with_suffix(path, ".tmp");
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("创建目录失败: {}", parent.display()))?;
        }
        std::fs::write(&tmp, &f.content)
            .with_context(|| format!("写入临时文件失败: {}", tmp.display()))?;
        if let Err(e) = std::fs::rename(&tmp, path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(anyhow::anyhow!("替换文件失败（{}）: {e}", path.display()));
        }
    }
    Ok(())
}

/// 原子应用 xray 配置：
/// 1. 写 `<path>.new`；2. 校验，失败只删 `.new`、不碰线上文件；
/// 3. 备份线上文件到 `<path><backup_suffix>`；4. rename 替换；
/// 5. 重启失败用备份还原；6. 全部成功才返回 Ok。
fn apply_xray_atomic(
    path: &Path,
    content: &[u8],
    test_command: &str,
    backup_suffix: &str,
    restart_command: &str,
) -> Result<()> {
    let new_path = with_suffix(path, ".new");
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("创建配置目录失败: {}", parent.display()))?;
    }

    // a. 新配置写在同目录的 `.new`，保证后续 rename 原子
    std::fs::write(&new_path, content)
        .with_context(|| format!("写入临时配置失败: {}", new_path.display()))?;

    // b. 校验失败：删掉 `.new` 原样返回，线上文件一行都不动
    if let Err(e) = validate_xray(test_command, &new_path) {
        let _ = std::fs::remove_file(&new_path);
        return Err(e);
    }

    // c. 线上文件存在才备份，内容保持旧版本
    let backup_path = with_suffix(path, backup_suffix);
    let has_backup = path.exists();
    if has_backup {
        std::fs::copy(path, &backup_path)
            .with_context(|| format!("备份现有配置失败: {}", backup_path.display()))?;
    }

    // d. 原子替换
    if let Err(e) = std::fs::rename(&new_path, path) {
        let _ = std::fs::remove_file(&new_path);
        return Err(anyhow::anyhow!("替换配置失败（{}）: {e}", path.display()));
    }

    // e. 重启失败：有备份就还原，原本没有配置则删掉刚写入的文件
    if let Err(restart_err) = restart_xray(restart_command) {
        let restore = if has_backup {
            std::fs::rename(&backup_path, path).map_err(|e| e.to_string())
        } else {
            std::fs::remove_file(path).map_err(|e| e.to_string())
        };
        return match restore {
            Ok(()) => Err(anyhow::anyhow!(
                "重启 xray 失败，已回滚到上一版配置：{restart_err:#}"
            )),
            Err(e) => Err(anyhow::anyhow!(
                "重启 xray 失败，且回滚失败（{e}）：{restart_err:#}"
            )),
        };
    }

    // f. 全部成功
    Ok(())
}

/// 把 `.new` 交给 `xray run -test -config` 之类的命令校验；命令与路径分属独立 argv。
fn validate_xray(command: &str, config: &Path) -> Result<()> {
    if command.trim().is_empty() {
        anyhow::bail!("xray_test_command 为空，拒绝应用未校验的配置");
    }
    let out = run_program(command, Some(config))?;
    if out.status.success() {
        return Ok(());
    }
    let detail = command_output(&out);
    if detail.is_empty() {
        anyhow::bail!("xray 配置校验失败（{}）", out.status);
    }
    anyhow::bail!("xray 配置校验失败（{}）：{}", out.status, detail)
}

fn restart_xray(command: &str) -> Result<()> {
    if command.trim().is_empty() {
        return Ok(());
    }
    let out = run_program(command, None)?;
    if out.status.success() {
        return Ok(());
    }
    let detail = command_output(&out);
    if detail.is_empty() {
        anyhow::bail!("`{command}` 执行失败（{}）", out.status);
    }
    anyhow::bail!("`{command}` 执行失败（{}）：{}", out.status, detail)
}

/// 按空白切分命令后直接 exec（不经过 shell），可追加一个独立参数。
pub(crate) fn run_program(command: &str, extra_arg: Option<&Path>) -> Result<Output> {
    let mut parts = command.split_whitespace();
    let Some(program) = parts.next() else {
        anyhow::bail!("命令为空");
    };
    let mut cmd = std::process::Command::new(program);
    cmd.args(parts);
    if let Some(arg) = extra_arg {
        cmd.arg(arg);
    }
    cmd.output()
        .with_context(|| format!("无法执行 `{command}`"))
}

/// 合并 stdout/stderr，去 ANSI 后截断到 2KB。
pub(crate) fn command_output(out: &Output) -> String {
    let mut parts = Vec::new();
    let stdout = strip_ansi(&String::from_utf8_lossy(&out.stdout));
    if !stdout.trim().is_empty() {
        parts.push(format!("标准输出: {}", stdout.trim()));
    }
    let stderr = strip_ansi(&String::from_utf8_lossy(&out.stderr));
    if !stderr.trim().is_empty() {
        parts.push(format!("标准错误: {}", stderr.trim()));
    }
    truncate_output(&parts.join("\n"), ERROR_OUTPUT_LIMIT)
}

/// 去掉 CSI 转义序列，避免把颜色控制符写进主控日志/前端提示。
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            // CSI 以 @..~ 的最后一个字节结束
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        } else {
            // 其它转义序列：吞掉紧随的一个字符
            chars.next();
        }
    }
    out
}

/// 按 UTF-8 字符边界截断，并注明原始长度。
fn truncate_output(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（已截断，原始输出 {} 字节）", &text[..end], text.len())
}

/// 在完整文件名后追加后缀（`config.json` → `config.json.new`），不替换扩展名。
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn sample_heartbeat(seq: u64, uptime_secs: u64) -> Heartbeat {
    let (load1, mem_used, mem_total) = read_load_and_mem();
    Heartbeat {
        seq,
        uptime_secs,
        load1,
        mem_used,
        mem_total,
        disk_used: 0,
        disk_total: 0,
        xray_running: std::process::Command::new("systemctl")
            .args(["is-active", "xray"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false),
        nginx_running: false,
    }
}

#[cfg(target_os = "linux")]
fn read_load_and_mem() -> (f32, u64, u64) {
    let load1 = std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse::<f32>().ok())
        .unwrap_or(0.0);
    let mem = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let get = |key: &str| -> u64 {
        mem.lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
            .unwrap_or(0)
            * 1024
    };
    let total = get("MemTotal:");
    (load1, total.saturating_sub(get("MemAvailable:")), total)
}

#[cfg(not(target_os = "linux"))]
fn read_load_and_mem() -> (f32, u64, u64) {
    (0.0, 0, 0)
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

#[allow(dead_code)]
fn _protocol_version() -> u32 {
    PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例独立临时目录，Drop 时清理；不引入 tempfile 依赖。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("pierwave-agent-test-{}", uuid::Uuid::new_v4()));
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

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn only_newer_versions_are_applied() {
        assert!(should_apply(2, 1));
        assert!(!should_apply(1, 1), "同一版本重放不应重启 xray");
        assert!(!should_apply(0, 1), "旧版本不能被接受");
    }

    #[test]
    fn validation_failure_leaves_live_file_untouched() {
        let dir = TempDir::new();
        let live = dir.path().join("config.json");
        std::fs::write(&live, "old-config").unwrap();

        let err = apply_xray_atomic(&live, b"new-config", "false", ".bak", "true").unwrap_err();

        assert!(err.to_string().contains("校验失败"), "{err}");
        assert_eq!(read(&live), "old-config", "校验失败时线上文件必须原样保留");
        assert!(
            !with_suffix(&live, ".new").exists(),
            "校验失败不能残留 .new"
        );
        assert!(!with_suffix(&live, ".bak").exists(), "校验失败不应产生备份");
    }

    #[test]
    fn restart_failure_restores_previous_config() {
        let dir = TempDir::new();
        let live = dir.path().join("config.json");
        std::fs::write(&live, "old-config").unwrap();

        let err = apply_xray_atomic(&live, b"new-config", "true", ".bak", "false").unwrap_err();

        assert!(err.to_string().contains("回滚"), "{err}");
        assert_eq!(read(&live), "old-config", "重启失败必须还原旧配置");
        assert!(!with_suffix(&live, ".new").exists(), "回滚后不能残留 .new");
    }

    #[test]
    fn restart_failure_without_previous_file_removes_new_file() {
        let dir = TempDir::new();
        let live = dir.path().join("config.json");

        apply_xray_atomic(&live, b"new-config", "true", ".bak", "false").unwrap_err();

        assert!(!live.exists(), "原本没有线上文件时，失败应回到「无文件」");
    }

    #[test]
    fn success_installs_new_config_and_keeps_backup() {
        let dir = TempDir::new();
        let live = dir.path().join("config.json");
        std::fs::write(&live, "old-config").unwrap();

        apply_xray_atomic(&live, b"new-config", "true", ".bak", "true").unwrap();

        assert_eq!(read(&live), "new-config");
        assert_eq!(read(&with_suffix(&live, ".bak")), "old-config");
        assert!(!with_suffix(&live, ".new").exists());
    }

    #[test]
    fn custom_backup_suffix_is_respected() {
        let dir = TempDir::new();
        let live = dir.path().join("config.json");
        std::fs::write(&live, "old-config").unwrap();

        apply_xray_atomic(&live, b"new-config", "true", ".old", "true").unwrap();

        assert_eq!(read(&with_suffix(&live, ".old")), "old-config");
        assert!(!with_suffix(&live, ".bak").exists());
    }

    #[test]
    fn empty_test_command_rejects_apply() {
        let dir = TempDir::new();
        let live = dir.path().join("config.json");
        std::fs::write(&live, "old-config").unwrap();

        let err = apply_xray_atomic(&live, b"new-config", "  ", ".bak", "true").unwrap_err();

        assert!(err.to_string().contains("xray_test_command"), "{err}");
        assert_eq!(read(&live), "old-config");
        assert!(!with_suffix(&live, ".new").exists());
    }

    /// 用假 xray 脚本验证：错误回传会去掉 ANSI，并把长输出截断到 2KB。
    #[cfg(unix)]
    #[test]
    fn validation_error_includes_ansi_stripped_and_truncated_output() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let script = dir.path().join("bad-xray");
        let body = format!(
            "#!/bin/sh\nprintf '\\033[31m{}\\033[0m\\n' >&2\nexit 2\n",
            "x".repeat(3000)
        );
        std::fs::write(&script, body).unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let live = dir.path().join("config.json");
        std::fs::write(&live, "old-config").unwrap();
        let err = apply_xray_atomic(
            &live,
            b"new-config",
            script.to_str().unwrap(),
            ".bak",
            "true",
        )
        .unwrap_err();
        let msg = err.to_string();

        assert!(msg.contains("校验失败"), "{msg}");
        assert!(!msg.contains('\u{1b}'), "错误里不应残留 ANSI: {msg}");
        assert!(msg.contains("已截断"), "超长输出应被截断: {}", msg.len());
        assert!(msg.len() < ERROR_OUTPUT_LIMIT + 128, "输出应限制在 2KB");
        assert_eq!(read(&live), "old-config");
        assert!(!with_suffix(&live, ".new").exists());
    }

    #[test]
    fn strips_ansi_escape_sequences() {
        assert_eq!(strip_ansi("\u{1b}[31m失败\u{1b}[0m\r\n"), "失败\r\n");
        assert_eq!(strip_ansi("plain text"), "plain text");
        assert_eq!(strip_ansi("\u{1b}[1;32mok\u{1b}[m"), "ok");
    }

    #[test]
    fn truncates_output_to_limit_on_char_boundary() {
        let long = "错".repeat(2000);
        let out = truncate_output(&long, ERROR_OUTPUT_LIMIT);
        assert!(out.contains("已截断"));
        assert!(out.starts_with(&"错".repeat(ERROR_OUTPUT_LIMIT / 3)));
        assert!(out.len() <= ERROR_OUTPUT_LIMIT + 64);
        assert_eq!(truncate_output("短", ERROR_OUTPUT_LIMIT), "短");
    }

    #[test]
    fn appends_suffix_to_full_file_name() {
        assert_eq!(
            with_suffix(Path::new("/etc/xray/config.json"), ".new"),
            PathBuf::from("/etc/xray/config.json.new")
        );
    }
}
