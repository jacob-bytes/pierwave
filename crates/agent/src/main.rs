mod config;

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use mmrust_proto::{
    AgentHello, AgentMessage, ApplyResult, DesiredState, Heartbeat, MasterMessage, TrafficReport,
    PROTOCOL_VERSION,
};
use tokio_tungstenite::tungstenite::Message;

use crate::config::Config;

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

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
                .unwrap_or_else(|_| "info,mmrust_agent=debug".into()),
        )
        .init();

    let path = std::env::args()
        .skip_while(|a| a != "-c")
        .nth(1)
        .or_else(|| std::env::var("MMRUST_CONFIG").ok())
        .unwrap_or_else(|| "/etc/mmrust-agent/config.toml".into());
    let cfg = Config::load(std::path::Path::new(&path))?;
    tracing::info!(%path, master = %cfg.master_url, "agent starting");

    // 断线重连：指数退避，上限 60s
    let mut backoff = 1u64;
    loop {
        match run_once(&cfg).await {
            Ok(()) => backoff = 1,
            Err(e) => {
                tracing::warn!(error = %e, backoff, "connection dropped");
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(60);
            }
        }
    }
}

async fn run_once(cfg: &Config) -> Result<()> {
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
    let mut traffic = tokio::time::interval(Duration::from_secs(60));
    let uptime_start = std::time::Instant::now();
    let mut seq = 0u64;
    let boot_id = uuid::Uuid::new_v4().to_string();

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
                // TODO(P1): 读 xray StatsService，按 email 算增量后再发
                let report = TrafficReport { seq, boot_id: boot_id.clone(), deltas: Vec::new() };
                ws.send(Message::Text(serde_json::to_string(&AgentMessage::Traffic(report))?)).await?;
            }
        }
    }
}

/// 收敛到期望态：先落文件，再重启 xray，失败返回错误让主控标记。
async fn apply_state(state: &DesiredState, cfg: &Config) -> ApplyResult {
    let result = apply_files(state)
        .and_then(|_| write_xray_config(state, &cfg.xray_config_path))
        .and_then(|_| restart_xray(&cfg.restart_command));
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

fn apply_files(state: &DesiredState) -> Result<()> {
    for f in &state.files {
        let path = std::path::Path::new(&f.path);
        let tmp = path.with_extension("tmp");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&tmp, &f.content)?;
        std::fs::rename(&tmp, path)?;
    }
    Ok(())
}

fn write_xray_config(state: &DesiredState, path: &str) -> Result<()> {
    let path = std::path::Path::new(path);
    let tmp = path.with_extension("json.tmp");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&tmp, serde_json::to_vec_pretty(&state.xray)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn restart_xray(command: &str) -> Result<()> {
    let mut parts = command.split_whitespace();
    let Some(program) = parts.next() else {
        return Ok(());
    };
    match std::process::Command::new(program).args(parts).output() {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => anyhow::bail!(
            "`{command}` 执行失败（{}）：{}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Err(e) => anyhow::bail!("无法执行 `{command}`: {e}"),
    }
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
    use super::should_apply;

    #[test]
    fn only_newer_versions_are_applied() {
        assert!(should_apply(2, 1));
        assert!(!should_apply(1, 1), "同一版本重放不应重启 xray");
        assert!(!should_apply(0, 1), "旧版本不能被接受");
    }
}
