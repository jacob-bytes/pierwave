mod config;
mod forward;
mod probe;
mod realm;
mod selector;
mod system_info;
mod tc;
mod traffic;
mod upgrade;

use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use pierwave_proto::{
    AgentHello, AgentMessage, AgentUpgradePlan, ApplyResult, DesiredForward, DesiredState,
    ForwardEngine, ForwardStatus, Heartbeat, MasterMessage, TrafficReport, PROTOCOL_VERSION,
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

/// 进程级不变的身份与系统信息，跨重连保留。
///
/// 打包成一个结构体送给 `run_once`，避免参数列表继续膨胀（clippy 上限 7 个）。
struct AgentContext {
    boot_id: String,
    system_info: system_info::SystemInfo,
}

/// 一次收敛的结果；`upgraded` 表示新二进制已替换、需要当前进程退场。
struct ApplyOutcome {
    result: ApplyResult,
    upgraded: bool,
}

/// 两个转发引擎的收敛集合。
///
/// 期望态里每条规则自带 `engine`，这里按引擎分流：`native` 交给原有的
/// [`forward::ForwardSupervisor`]（监听行为一字未改），`realm` 交给
/// [`realm::RealmSupervisor`]（一份配置 + 一个受管子进程）。
///
/// 两者共享同一份端口冲突校验（主控侧保证同一个端口只会有一条规则），
/// 所以这里可以放心让它们各自绑定自己的端口。
struct ForwardEngines {
    native: forward::ForwardSupervisor,
    realm: realm::RealmSupervisor,
}

impl ForwardEngines {
    fn new(cfg: &Config) -> Self {
        Self {
            native: forward::ForwardSupervisor::new(cfg.forward_bind.clone()),
            realm: realm::RealmSupervisor::new(
                cfg.realm_bin.clone(),
                cfg.state_dir.clone(),
                cfg.forward_bind.clone(),
            ),
        }
    }

    /// 先对齐 native、再对齐 realm，最后再给 native 一次重试机会。
    ///
    /// 引擎切换（同一条规则 native ↔ realm）时端口会短暂被另一边占着：
    /// native 的 apply 是幂等的，只重试绑定失败的规则，再跑一次就能在
    /// realm 释放端口后立刻恢复，不必等下一轮期望态。
    async fn apply(&mut self, desired: &[DesiredForward]) {
        let (native, realm): (Vec<DesiredForward>, Vec<DesiredForward>) = desired
            .iter()
            .cloned()
            .partition(|spec| spec.engine == ForwardEngine::Native);
        self.native.apply(&native).await;
        self.realm.apply(&realm).await;
        self.native.apply(&native).await;
    }

    /// 心跳用的状态快照：两个引擎各读自己的句柄，不会互相覆盖。
    fn status_snapshot(&self) -> Vec<ForwardStatus> {
        let mut statuses = self.native.status_handle().snapshot();
        statuses.extend(self.realm.status_handle().snapshot());
        statuses
    }
}

fn should_apply(incoming: i64, applied: i64) -> bool {
    incoming > applied
}

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args().any(|arg| arg == "--version" || arg == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    // 看门狗 helper 入口：必须在读配置之前处理。新版本如果连配置都读不了，
    // `--rollback-check` 仍然要能把旧二进制换回去。
    if let Some((ok_marker, backup, restart_command)) = rollback_args() {
        init_tracing();
        let outcome = match restart_command.as_deref() {
            Some(command) => upgrade::rollback_check_with(&ok_marker, &backup, command),
            None => upgrade::rollback_check(&ok_marker, &backup),
        };
        match outcome {
            Ok(outcome) => {
                tracing::info!(?outcome, "rollback check finished");
                return Ok(());
            }
            Err(e) => {
                tracing::error!(error = %e, "rollback check failed");
                return Err(e);
            }
        }
    }

    init_tracing();

    let path = std::env::args()
        .skip_while(|a| a != "-c")
        .nth(1)
        .or_else(|| std::env::var("PIERWAVE_CONFIG").ok())
        .unwrap_or_else(|| "/etc/pierwave-agent/config.toml".into());
    let cfg = Config::load(std::path::Path::new(&path))?;
    tracing::info!(%path, master = %cfg.master_url, "agent starting");

    // 发行版 / 虚拟化在进程生命周期内不会变：只在这里采集一次，心跳只读缓存。
    // 这样每 15 秒的心跳不会 fork `systemd-detect-virt`。
    let system_info = system_info::collect();
    tracing::info!(
        os_name = system_info.os_name.as_deref().unwrap_or("-"),
        os_version = system_info.os_version.as_deref().unwrap_or("-"),
        virt = system_info.virt.as_deref().unwrap_or("-"),
        "collected system info"
    );

    // 上次升级是否已经确认成功：成功就清标记；遗留的旧版本 pending 也在这里清理。
    let current_exe = std::env::current_exe().ok();
    if let Err(e) = upgrade::startup_check(
        Path::new(&cfg.upgrade_state_dir),
        AGENT_VERSION,
        current_exe.as_deref(),
        cfg.upgrade_watchdog_secs,
    ) {
        tracing::warn!(error = %e, "启动自检失败（继续运行）");
    }

    // 断线重连：指数退避，上限 60s。
    // boot_id / 流量 seq / 采样基线都放在重连循环外：进程级身份不变，
    // 重连后既不会换 id，也不会把已经上报过的累计流量再报一遍。
    let context = AgentContext {
        boot_id: uuid::Uuid::new_v4().to_string(),
        system_info,
    };
    let mut sampler = TrafficSampler::new();
    let mut traffic_seq = 0u64;
    let mut backoff = 1u64;
    // 探测任务跨重连常驻：每轮结果写进缓存，心跳只读缓存，不阻塞发送。
    let probe_cache = probe::spawn(
        cfg.probe_target.clone(),
        cfg.probe_timeout_ms,
        cfg.probe_interval_secs,
    );
    // 端口转发监听跨重连常驻：断线时继续服务，重连后主控重放期望态只做空 diff。
    let mut forward_engines = ForwardEngines::new(&cfg);
    // tc 状态跨重连保留：断线期间安全阀仍要能删掉自己的 qdisc，所以单独起一个
    // 每秒检查一次的看门狗，而不是只在 websocket 的 select 循环里检查。
    let tc_manager = Arc::new(Mutex::new(tc::TcManager::new(
        cfg.tc_interface.clone(),
        PathBuf::from(&cfg.tc_state_path),
    )));
    {
        // 上次进程可能被杀，先收敛残留的 1f00: 并恢复原始根队列。
        let mut manager = tc_manager
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        manager.recover_startup();
    }
    {
        let manager = tc_manager.clone();
        tokio::spawn(async move {
            wait_for_shutdown_signal().await;
            let mut guard = manager
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.cleanup();
            tracing::info!("收到退出信号，已清理节点限速");
            std::process::exit(0);
        });
    }
    {
        let manager = tc_manager.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tick.tick().await;
                let mut guard = manager
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.safety_check(Instant::now());
            }
        });
    }
    loop {
        match run_once(
            &cfg,
            &context,
            &mut sampler,
            &mut traffic_seq,
            &probe_cache,
            &tc_manager,
            &mut forward_engines,
        )
        .await
        {
            Ok(()) => backoff = 1,
            Err(e) => {
                tracing::warn!(error = %e, backoff, "connection dropped");
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(60);
            }
        }
    }
}

/// 等 SIGINT / SIGTERM；收到后由调用方清理 tc 再退出。
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => Some(signal),
                Err(error) => {
                    tracing::warn!(%error, "注册 SIGTERM 失败，只监听 Ctrl-C");
                    None
                }
            };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                match &mut terminate {
                    Some(signal) => { signal.recv().await; }
                    None => std::future::pending::<()>().await,
                }
            } => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,pierwave_agent=debug".into()),
        )
        .init();
}

/// 解析 `pierwave-agent --rollback-check <ok-marker> <backup-path> [restart-command]`。
///
/// 第三个参数是可选的：升级时的重启命令可能被配置成非默认值，回滚必须用同一条。
/// 参数不全时直接退 2：这是看门狗调用的内部入口，不能悄悄当成正常启动。
fn rollback_args() -> Option<(PathBuf, PathBuf, Option<String>)> {
    let args: Vec<String> = std::env::args().collect();
    let idx = args.iter().position(|arg| arg == "--rollback-check")?;
    if idx + 2 >= args.len() {
        eprintln!(
            "用法: pierwave-agent --rollback-check <ok-marker> <backup-path> [restart-command]"
        );
        std::process::exit(2);
    }
    Some((
        PathBuf::from(&args[idx + 1]),
        PathBuf::from(&args[idx + 2]),
        args.get(idx + 3).cloned(),
    ))
}

async fn run_once(
    cfg: &Config,
    context: &AgentContext,
    sampler: &mut TrafficSampler,
    traffic_seq: &mut u64,
    probe_cache: &probe::ProbeCache,
    tc_manager: &Arc<Mutex<tc::TcManager>>,
    forwards: &mut ForwardEngines,
) -> Result<()> {
    let boot_id = &context.boot_id;
    let system_info = &context.system_info;
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
                // 任何主控消息都证明链路还活着，刷新 tc 安全阀。
                tc_manager
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .mark_contact(Instant::now());
                match serde_json::from_str::<MasterMessage>(&text) {
                    Ok(MasterMessage::Ack(ack)) => {
                        tracing::info!(server_id = %ack.server_id, config_version = ack.config_version,
                            protocol = ack.protocol_version, "registered");
                        // 升级后的新进程只有「连上主控 + 收到 Ack」才算成功；
                        // 看门狗看到 upgrade-ok 就不会回滚。
                        let watchdog_unit = if cfg.upgrade_watchdog_secs > 0
                            && !cfg.upgrade_systemd_run.trim().is_empty()
                        {
                            Some(upgrade::DEFAULT_WATCHDOG_UNIT)
                        } else {
                            None
                        };
                        match upgrade::confirm_upgrade(
                            Path::new(&cfg.upgrade_state_dir),
                            watchdog_unit,
                        ) {
                            Ok(true) => tracing::info!("agent upgrade confirmed by master ack"),
                            Ok(false) => {}
                            Err(e) => tracing::error!(
                                error = %e,
                                "写入 upgrade-ok 失败，看门狗可能回滚本次升级"
                            ),
                        }
                    }
                    Ok(MasterMessage::Desired(state)) => {
                        let applied = APPLIED_VERSION.load(Ordering::Relaxed);
                        let outcome = if should_apply(state.version, applied) {
                            let outcome = apply_state(&state, cfg, forwards).await;
                            if outcome.result.ok {
                                APPLIED_VERSION.store(state.version, Ordering::Relaxed);
                            }
                            outcome
                        } else {
                            tracing::info!(
                                version = state.version,
                                applied,
                                "desired state already applied, skipping restart"
                            );
                            // 转发与 xray 版本无关：版本重放时也重新对齐一次。
                            // supervisor 内部做 diff，同一份列表不会重建监听，
                            // 但绑定失败的规则会借机重试（端口可能刚被释放）。
                            forwards.apply(&state.forwards).await;
                            ApplyOutcome {
                                result: ApplyResult { version: state.version, ok: true, error: None },
                                upgraded: false,
                            }
                        };
                        // tc 是独立于 xray 的收敛项：即使版本没变（重连补发同一版），
                        // 也要重新对齐——安全阀可能刚在断线期间拆过规则。
                        // 失败只 warn，绝不影响上面的 xray 配置应用。
                        if !outcome.upgraded {
                            if let Err(error) = tc_manager
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .apply(&state.nodes, Instant::now())
                            {
                                tracing::warn!(
                                    error = %error,
                                    "应用节点限速失败（不影响 xray 配置）"
                                );
                            }
                        }
                        // 新二进制已替换、重启命令已执行：当前进程必须退场，
                        // 让 systemd 拉起新版本（也避免旧进程和新进程同时在线）。
                        if outcome.upgraded {
                            // 升级退出前拆掉自己的 qdisc：新进程拉起前如果失败，
                            // 没有 Agent 的安全阀兜底，限速规则会永久残留。
                            tc_manager
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .cleanup();
                            tracing::info!("agent upgraded; exiting current process");
                            std::process::exit(0);
                        }
                        let msg = AgentMessage::ApplyResult(outcome.result);
                        ws.send(Message::Text(serde_json::to_string(&msg)?)).await?;
                    }
                    Ok(MasterMessage::Error { message }) => {
                        tracing::error!(%message, "master rejected agent");
                        anyhow::bail!("master rejected agent: {message}");
                    }
                    Ok(MasterMessage::Ping) => {
                        let forwards = forwards.status_snapshot();
                        let fallback = serde_json::json!({
                            "type": "heartbeat",
                            "seq": 0,
                            "uptime_secs": 0,
                            "load1": 0.0,
                            "mem_used": 0,
                            "mem_total": 0,
                            "disk_used": 0,
                            "disk_total": 0,
                            "xray_running": false,
                            "nginx_running": false,
                            "agent_version": env!("CARGO_PKG_VERSION"),
                            "arch": std::env::consts::ARCH,
                            "os_name": system_info.os_name,
                            "os_version": system_info.os_version,
                            "virt": system_info.virt,
                            "latency_ms": probe_cache.load(),
                            "forwards": forwards,
                        });
                        ws.send(Message::Text(fallback.to_string())).await.ok();
                    }
                    Err(e) => tracing::warn!(error = %e, "unknown master message"),
                }
            }
            _ = heartbeat.tick() => {
                seq += 1;
                let hb = AgentMessage::Heartbeat(sample_heartbeat(
                    seq,
                    uptime_start.elapsed().as_secs(),
                    probe_cache.load(),
                    forwards.status_snapshot(),
                    system_info,
                ));
                ws.send(Message::Text(serde_json::to_string(&hb)?)).await?;
                tc_manager
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .mark_contact(Instant::now());
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

/// 收敛到期望态：转发监听先对齐（与 xray 成败无关），其它文件原子落盘，
/// xray 配置走「校验 → 备份 → 替换 → 重启」，失败回滚。
async fn apply_state(
    state: &DesiredState,
    cfg: &Config,
    forwards: &mut ForwardEngines,
) -> ApplyOutcome {
    // 转发是独立于 xray 的收敛项：先对齐监听，再处理 xray。
    // 单条绑定失败只体现在 ForwardStatus 里，不会把整次 apply 判失败。
    forwards.apply(&state.forwards).await;
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
    if let Err(e) = result {
        tracing::error!(version = state.version, error = %e, "apply failed");
        return ApplyOutcome {
            result: ApplyResult {
                version: state.version,
                ok: false,
                error: Some(e.to_string()),
            },
            upgraded: false,
        };
    }
    tracing::info!(version = state.version, "desired state applied");

    // 配置成功之后才尝试升级：升级会重启进程，不能把没落盘的配置带过去。
    if let Some(plan) = &state.agent_upgrade {
        match run_agent_upgrade(plan, cfg).await {
            Ok(upgrade::UpgradeOutcome::Noop) => {}
            Ok(upgrade::UpgradeOutcome::Upgraded { version }) => {
                tracing::info!(%version, "agent upgrade applied");
                return ApplyOutcome {
                    result: ApplyResult {
                        version: state.version,
                        ok: true,
                        error: None,
                    },
                    upgraded: true,
                };
            }
            Err(e) => {
                tracing::error!(version = %plan.version, error = %e, "agent upgrade failed");
                return ApplyOutcome {
                    result: ApplyResult {
                        version: state.version,
                        ok: false,
                        error: Some(format!("Agent 升级失败: {e:#}")),
                    },
                    upgraded: false,
                };
            }
        }
    }

    ApplyOutcome {
        result: ApplyResult {
            version: state.version,
            ok: true,
            error: None,
        },
        upgraded: false,
    }
}

async fn run_agent_upgrade(
    plan: &AgentUpgradePlan,
    cfg: &Config,
) -> Result<upgrade::UpgradeOutcome> {
    let current_exe = std::env::current_exe().context("无法确定 Agent 可执行文件路径")?;
    let watchdog = if cfg.upgrade_watchdog_secs == 0 || cfg.upgrade_systemd_run.trim().is_empty() {
        None
    } else {
        Some(upgrade::WatchdogConfig {
            program: cfg.upgrade_systemd_run.clone(),
            unit: upgrade::DEFAULT_WATCHDOG_UNIT.into(),
            delay_secs: cfg.upgrade_watchdog_secs,
        })
    };
    let ctx = upgrade::UpgradeContext {
        current_version: AGENT_VERSION.into(),
        current_exe,
        state_dir: PathBuf::from(&cfg.upgrade_state_dir),
        restart_command: cfg.upgrade_restart_command.clone(),
        public_key: pierwave_domain::release::embedded_public_key().to_string(),
        watchdog,
    };
    upgrade::run(
        plan,
        &ctx,
        &upgrade::HttpDownloader::bearer(cfg.token.clone()),
    )
    .await
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

fn sample_heartbeat(
    seq: u64,
    uptime_secs: u64,
    latency_ms: Option<u32>,
    forwards: Vec<ForwardStatus>,
    system_info: &system_info::SystemInfo,
) -> Heartbeat {
    let (load1, mem_used, mem_total) = read_load_and_mem();
    let disk = read_disk();
    Heartbeat {
        seq,
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        arch: std::env::consts::ARCH.to_string(),
        os_name: system_info.os_name.clone(),
        os_version: system_info.os_version.clone(),
        virt: system_info.virt.clone(),
        latency_ms,
        forwards,
        uptime_secs,
        load1,
        mem_used,
        mem_total,
        disk_used: disk.0,
        disk_total: disk.1,
        xray_running: unit_active("xray"),
        nginx_running: unit_active("nginx"),
    }
}

/// 通过 `systemctl is-active` 判断某个 unit 是否在运行。
///
/// 单位不存在（没装）时 systemctl 返回非 0，也归为「没在跑」——对面板来说两者
/// 没有区别，都是「该服务不可用」。
fn unit_active(unit: &str) -> bool {
    std::process::Command::new("systemctl")
        .args(["is-active", unit])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// 根分区用量，返回 (已用, 总量)，单位字节。
///
/// 用 `df -kP` 而不是引 libc/statvfs：只需要一次系统调用级别的信息，
/// 不值得为它加一个 unsafe 依赖；`-P` 保证输出是固定的单行格式。
fn read_disk() -> (u64, u64) {
    let output = std::process::Command::new("df").args(["-kP", "/"]).output();
    match output {
        Ok(out) if out.status.success() => {
            parse_df(&String::from_utf8_lossy(&out.stdout)).unwrap_or((0, 0))
        }
        _ => (0, 0),
    }
}

/// 解析 `df -kP` 的输出：取最后一行的第 2、3 列（1K 块），换算成字节。
fn parse_df(raw: &str) -> Option<(u64, u64)> {
    let line = raw.lines().rfind(|line| !line.trim().is_empty())?;
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 3 {
        return None;
    }
    let total_kb: u64 = fields[1].parse().ok()?;
    let used_kb: u64 = fields[2].parse().ok()?;
    Some((used_kb * 1024, total_kb * 1024))
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
    fn parses_df_output() {
        let sample = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1s1 500000000 125000000 375000000 25% /\n";
        assert_eq!(
            parse_df(sample),
            Some((125_000_000 * 1024, 500_000_000 * 1024))
        );
        assert_eq!(parse_df(""), None);
        assert_eq!(parse_df("只 有 两 列"), None);
    }

    fn system_info_fixture() -> system_info::SystemInfo {
        system_info::SystemInfo {
            os_name: Some("Debian GNU/Linux".into()),
            os_version: Some("12".into()),
            virt: Some("kvm".into()),
        }
    }

    #[test]
    fn heartbeat_reports_cpu_arch_and_probe_latency() {
        let forwards = vec![ForwardStatus {
            id: "fwd".into(),
            listening: true,
            error: String::new(),
            target_ok: Some(true),
        }];
        let system_info = system_info_fixture();
        let hb = sample_heartbeat(1, 2, Some(23), forwards.clone(), &system_info);
        assert_eq!(hb.arch, std::env::consts::ARCH);
        assert!(!hb.arch.is_empty(), "主控靠心跳里的 arch 选升级产物");
        assert_eq!(hb.os_name.as_deref(), Some("Debian GNU/Linux"));
        assert_eq!(hb.os_version.as_deref(), Some("12"));
        assert_eq!(hb.virt.as_deref(), Some("kvm"));
        assert_eq!(hb.latency_ms, Some(23), "心跳应带上缓存的探测结果");
        assert_eq!(hb.forwards, forwards, "心跳应带上每条转发的监听状态");
        assert_eq!(
            hb.forwards[0].target_ok,
            Some(true),
            "目标可达性必须随心跳上报"
        );

        let missing = sample_heartbeat(1, 2, None, Vec::new(), &system_info::SystemInfo::default());
        assert_eq!(missing.latency_ms, None, "探测失败必须上报 null");
        assert_eq!(missing.os_name, None, "读不到 os-release 时必须上报 null");
        assert_eq!(missing.virt, None, "裸机/读不到时必须上报 null");
        assert!(missing.forwards.is_empty());
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

    /// 测试用的双引擎集合：realm 指向一个不存在的二进制，
    /// 只关心 native 行为的用例不会被 realm 影响。
    fn test_engines(state_dir: &Path) -> ForwardEngines {
        ForwardEngines {
            native: forward::ForwardSupervisor::new("127.0.0.1"),
            realm: realm::RealmSupervisor::new(
                state_dir.join("no-such-realm"),
                state_dir,
                "127.0.0.1",
            ),
        }
    }

    /// 接线测试：期望态里的 forwards 要经 apply_state 落到 supervisor，
    /// 空列表要停掉监听，心跳从状态句柄读到同一份结果。
    #[tokio::test]
    async fn apply_state_converges_forward_listeners_into_heartbeat() {
        let dir = TempDir::new();
        let toml = format!(
            "master_url = \"http://127.0.0.1:8787\"\n\
             token = \"t\"\n\
             xray_config_path = \"{}\"\n\
             xray_test_command = \"true\"\n\
             restart_command = \"true\"\n",
            dir.path().join("config.json").display()
        );
        let cfg: Config = toml::from_str(&toml).unwrap();
        let mut supervisor = test_engines(dir.path());

        let forward = pierwave_proto::DesiredForward {
            id: "f1".into(),
            // 0 交给内核选端口，测试不关心具体值，只要真的绑上。
            listen_port: 0,
            target_host: "127.0.0.1".into(),
            target_port: 1,
            targets: Vec::new(),
            strategy: Default::default(),
            engine: Default::default(),
        };
        let state = DesiredState {
            version: 1,
            xray: serde_json::json!({}),
            files: Vec::new(),
            agent_upgrade: None,
            forwards: vec![forward],
            nodes: Vec::new(),
        };

        let outcome = apply_state(&state, &cfg, &mut supervisor).await;
        assert!(outcome.result.ok, "转发监听不应影响 xray 应用结果");

        let status = supervisor.status_snapshot();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].id, "f1");
        assert!(status[0].listening);
        assert!(status[0].error.is_empty());

        let hb = sample_heartbeat(
            1,
            0,
            None,
            supervisor.status_snapshot(),
            &system_info::SystemInfo::default(),
        );
        assert_eq!(hb.forwards, status, "心跳必须带上 supervisor 的监听状态");

        // 空 forwards = 停止所有监听。
        let state = DesiredState {
            version: 2,
            forwards: Vec::new(),
            ..state
        };
        let outcome = apply_state(&state, &cfg, &mut supervisor).await;
        assert!(outcome.result.ok);
        assert!(
            supervisor.status_snapshot().is_empty(),
            "空期望列表必须停掉全部转发监听"
        );
    }

    /// realm 未安装时：realm 规则报「realm 未安装」，同一次收敛里的 native 规则
    /// 必须照常监听——两个引擎的状态互不影响。
    #[tokio::test]
    async fn apply_state_keeps_native_listening_when_realm_is_missing() {
        let dir = TempDir::new();
        let toml = format!(
            "master_url = \"http://127.0.0.1:8787\"\n\
             token = \"t\"\n\
             xray_config_path = \"{}\"\n\
             xray_test_command = \"true\"\n\
             restart_command = \"true\"\n\
             realm_bin = \"{}\"\n\
             state_dir = \"{}\"\n",
            dir.path().join("config.json").display(),
            dir.path().join("no-such-realm").display(),
            dir.path().display()
        );
        let cfg: Config = toml::from_str(&toml).unwrap();
        let mut engines = ForwardEngines::new(&cfg);

        let native = DesiredForward {
            id: "native-1".into(),
            listen_port: 0,
            target_host: "127.0.0.1".into(),
            target_port: 1,
            targets: Vec::new(),
            strategy: Default::default(),
            engine: ForwardEngine::Native,
        };
        let realm_rule = DesiredForward {
            id: "realm-1".into(),
            listen_port: 0,
            target_host: "10.0.0.8".into(),
            target_port: 443,
            targets: Vec::new(),
            strategy: Default::default(),
            engine: ForwardEngine::Realm,
        };
        let state = DesiredState {
            version: 1,
            xray: serde_json::json!({}),
            files: Vec::new(),
            agent_upgrade: None,
            forwards: vec![native, realm_rule],
            nodes: Vec::new(),
        };

        let outcome = apply_state(&state, &cfg, &mut engines).await;
        assert!(outcome.result.ok, "realm 未安装不能把整次 apply 判失败");

        let statuses = engines.status_snapshot();
        assert_eq!(statuses.len(), 2, "两条规则都要有状态：{statuses:?}");
        let native_status = statuses
            .iter()
            .find(|status| status.id == "native-1")
            .expect("native 规则必须有状态");
        assert!(
            native_status.listening && native_status.error.is_empty(),
            "native 规则不受 realm 缺失影响：{native_status:?}"
        );
        let realm_status = statuses
            .iter()
            .find(|status| status.id == "realm-1")
            .expect("realm 规则必须有状态");
        assert!(!realm_status.listening, "没装 realm 时必须报未监听");
        assert_eq!(realm_status.error, realm::NOT_INSTALLED);
    }
}
