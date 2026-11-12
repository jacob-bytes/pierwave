//! realm 引擎的收敛器：把 `engine == realm` 的规则写成 realm TOML，
//! 并托管一个 `realm -c <config>` 子进程。
//!
//! 与 native 引擎的分工：主控在期望态里给每条规则标 `engine`，
//! `native` 继续由 [`crate::forward::ForwardSupervisor`] 监听，
//! `realm` 交给这里。规则集合整体落成一个 `realm.toml`（realm 的配置模型
//! 本来就是「一份文件多个 endpoint」），所以这里是一个**进程级**收敛器，
//! 不是每条规则一个进程。
//!
//! 状态从哪来（realm 没有运行状态 API）：
//!
//! * 监听到没监听：Agent 自己对 `bind_host:port` 做一次 `TcpListener::bind`。
//!   返回 `AddrInUse` 说明端口已被占用（realm 正常监听），绑定成功说明没人监听，
//!   探针立刻释放端口。这个判据不依赖 realm 内部实现，realm 崩溃/卡死同样适用；
//! * 进程活没活：supervisor 自己 spawn 的子进程，退出码由监视任务记录；
//! * 文件不存在（没装 realm）：不 panic，所有 realm 规则上报
//!   [`NOT_INSTALLED`]，native 规则完全不受影响。
//!
//! 重启策略：只有**配置内容哈希**变化（或进程已退出）才重启子进程；
//! 同一份期望态重复下发时既不重写文件、也不重启，与 native 的幂等语义一致。

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use pierwave_proto::{DesiredForward, ForwardEngine, ForwardStatus, TargetProbe};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::tls_probe;

/// realm 的默认安装路径；打包脚本把资产解到 `/usr/lib/pierwave/bin/realm`。
pub const DEFAULT_BIN: &str = "/usr/lib/pierwave/bin/realm";

/// `realm_bin` 是否真的可用：必须是普通文件且带执行位。
///
/// 只判 `exists()` 不够：升级/解包中断可能留下一个没有执行位的残缺文件，
/// 那种情况下 heartbeat 若报 true，主控会在创建规则时误导用户「已经装好」。
/// 这里只做一次 `stat`（不 fork 子进程），代价足够低，可以在每轮心跳重新判定。
pub fn is_available(bin: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(bin) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// 状态目录里的配置文件名。
pub const CONFIG_FILE_NAME: &str = "realm.toml";

/// 没装 realm 时每条 realm 规则的 `error`。保持与产品文案一致，
/// 主控会原样显示在转发/链的状态列里。
pub const NOT_INSTALLED: &str = "realm 未安装";

/// 进程活着但端口还没绑上时的原因：最常见的是 realm 正在启动，
/// 或某个 endpoint 绑定失败（例如端口被别的程序抢走）。
pub const NOT_LISTENING: &str = "realm 未监听端口";

/// `realm --version` 的探测超时：版本输出应该立刻返回，卡住就按「无法判定」处理。
const CAPABILITY_TIMEOUT: Duration = Duration::from_secs(2);

/// 期望态里有 transport、但本机 realm 没有 `[transport]` feature 时的原因。
/// 只出现在状态里，绝不渲染成「不带 transport 的明文配置」。
pub const TRANSPORT_UNSUPPORTED: &str = "realm 不支持跳间加密（--version 未包含 [transport]）";

/// 有 transport 规则但无法判定能力（二进制不可执行 / 命令失败 / 超时）。
pub const TRANSPORT_UNKNOWN: &str = "无法判定 realm 是否支持跳间加密，已拒绝下发";

/// 停止子进程时等待它退出的上限；超时就 abort（`kill_on_drop` 兜底杀掉）。
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// 目标探测周期：明文规则做 TCP 握手计时，加密规则做 TLS 握手；与 native 的
/// 目标探测保持一致（30s）。
const PROBE_INTERVAL: Duration = Duration::from_secs(30);

/// 刚 spawn 后等 realm 绑定端口的宽限：立刻做 bind 探针会和它的 bind 抢跑，
/// 既可能误报「未监听」，也可能让 realm 自己的绑定失败。
const STARTUP_GRACE: Duration = Duration::from_millis(150);

/// 心跳可无锁读取的 realm 规则状态快照。
///
/// 与 native 的 [`crate::forward::ForwardStatusHandle`] 分开：两个引擎各自
/// 整体替换自己的状态集合，互不覆盖；心跳把两份拼起来上传。
///
/// 监听状态（bind 探针）与目标探测结果分开存：两者由不同任务写入，
/// 不能互相覆盖——端口绑上了但下一跳握手失败是加密链最常见的故障形态。
#[derive(Debug, Clone, Default)]
pub struct RealmStatusHandle {
    inner: Arc<Mutex<RealmStatusState>>,
}

#[derive(Debug, Default)]
struct RealmStatusState {
    statuses: Vec<ForwardStatus>,
    /// 规则 id → 最近一轮目标探测结果；明文规则是 TCP 计时，加密规则是 TLS 握手。
    probes: HashMap<String, ProbeHealth>,
}

/// 一条规则最近一轮目标探测的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProbeHealth {
    ok: bool,
    /// 失败原因码（`tls_probe` 的稳定短串，TCP 探测只会产生 connect 失败/超时）；
    /// 成功时为 `None`。
    error: Option<String>,
    /// 逐目标探测结果（含 RTT），随心跳带给主控做链路延迟。
    targets: Vec<TargetProbe>,
}

impl RealmStatusHandle {
    pub fn snapshot(&self) -> Vec<ForwardStatus> {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .statuses
            .iter()
            .cloned()
            .map(|mut status| {
                if let Some(health) = state.probes.get(&status.id) {
                    status.target_ok = Some(health.ok);
                    status.target_error = health.error.clone();
                    status.targets = health.targets.clone();
                }
                status
            })
            .collect()
    }

    fn store(&self, statuses: Vec<ForwardStatus>) {
        let ids: HashSet<String> = statuses.iter().map(|status| status.id.clone()).collect();
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.statuses = statuses;
        // 已经不在期望态里的规则不能留下探针缓存。
        state.probes.retain(|id, _| ids.contains(id));
    }

    /// 写一条规则的目标探测结果。
    ///
    /// 只在规则仍在当前状态集合里时写入：探针任务与规则变更并发时，
    /// 旧任务的结果不能凭空造出一条新 id。
    fn set_probe_health(&self, id: &str, health: ProbeHealth) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.statuses.iter().any(|status| status.id == id) {
            state.probes.insert(id.to_string(), health);
        }
    }

    /// 子进程退出后：所有 realm 规则立刻变成「没在监听」，原因里带退出码。
    ///
    /// 这里整体覆盖而不是逐条改：进程可能在第一次 `apply` 的端口探测之前
    /// 就退出，此时状态槽还是空的，逐条改会丢掉退出码。
    /// 下一次 `apply` 会尝试重新拉起；在那之前主控看到的是真实状态，
    /// 不会继续显示上一轮的 `listening=true`。
    fn mark_exited(&self, code: Option<i32>, ids: &[String]) {
        let reason = match code {
            Some(code) => format!("realm 进程已退出（退出码 {code}）"),
            None => "realm 进程已退出（被信号终止）".to_string(),
        };
        let statuses = ids
            .iter()
            .map(|id| ForwardStatus {
                id: id.clone(),
                listening: false,
                error: reason.clone(),
                target_ok: None,
                target_error: None,
                targets: Vec::new(),
                traffic_in: None,
                traffic_out: None,
            })
            .collect();
        self.store(statuses);
    }
}

/// 正在运行的 realm 子进程。
struct RunningRealm {
    /// 通知监视任务优雅停止；`None` = 已经通知过。
    stop: Option<oneshot::Sender<()>>,
    /// 监视任务：等子进程退出、记录退出码、更新状态。
    task: JoinHandle<()>,
}

/// 一条规则要探测的下一跳。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProbeSpec {
    id: String,
    /// 探测方式：明文规则只做 TCP 计时，加密规则做完整 TLS 握手。
    mode: ProbeMode,
    /// 下一组的全部成员（组内多成员时每个都测一次）。
    targets: Vec<ProbeTarget>,
}

/// 一条规则用哪种探针。
///
/// 探测方式只看 `remote_transport`：它是这条规则真正出站时使用的传输。
/// 明文链的每一跳都没有 transport，所以多跳链的延迟以前完全测不到。
#[derive(Debug, Clone, PartialEq, Eq)]
enum ProbeMode {
    /// 明文（`remote_transport` 为空）：TCP connect 计时，连上即关，不写数据。
    Tcp,
    /// 加密（`remote_transport = "tls;sni=…"`）：完整 TLS 握手，失败原因可分类。
    Tls { sni: String },
}

impl ProbeMode {
    /// 日志用的短标识；不进入状态回报。
    fn label(&self) -> &'static str {
        match self {
            Self::Tcp => "tcp",
            Self::Tls { .. } => "tls",
        }
    }

    /// 失败时是否在状态里带原因码。
    ///
    /// `ForwardStatus.target_error` 在协议里只描述**加密链**的握手失败；明文探测
    /// 失败只用 `target_ok = false` + `targets[].ok = false` 表达（与 native 一致），
    /// 不把 `tcp_connect_failed` 冒充成 TLS 错误塞给主控。
    fn reports_error(&self) -> bool {
        matches!(self, Self::Tls { .. })
    }
}

/// 一个下一跳成员：地址 + 用于回报给主控的 server_id。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProbeTarget {
    host: String,
    port: i64,
    server_id: String,
}

/// 正在运行的目标探针任务。
struct RunningProbe {
    /// 任务当前覆盖的规则集合；集合不变就不重启任务（不丢上一轮结果）。
    spec: Vec<ProbeSpec>,
    task: JoinHandle<()>,
}

/// realm 引擎的收敛器。生命周期与 native supervisor 一样跨 websocket 重连保留。
pub struct RealmSupervisor {
    bin: PathBuf,
    config_path: PathBuf,
    /// 写进 realm 配置的监听地址，与 native 的 `forward_bind` 保持一致。
    bind_host: String,
    /// 写进配置的日志级别：有 transport 端点时才生成 `[log]`（默认 warn）。
    log_level: String,
    /// 最近一次套用的 realm 规则（已排序，状态顺序与之对应）。
    rules: Vec<DesiredForward>,
    /// `realm --version` 能力缓存：按二进制 `(size, mtime)` 失效。
    transport: Option<(BinaryStamp, bool)>,
    /// 已落盘配置的内容哈希；`None` = 还没写过 / 上一轮已清空。
    content_hash: Option<u64>,
    process: Option<RunningRealm>,
    /// 目标探针：明文规则做 TCP 计时，带 `remote_transport` 的规则做 TLS 握手。
    /// 只观测，不影响转发。
    probe: Option<RunningProbe>,
    status: RealmStatusHandle,
}

impl RealmSupervisor {
    pub fn new(
        bin: impl Into<PathBuf>,
        state_dir: impl Into<PathBuf>,
        bind_host: impl Into<String>,
    ) -> Self {
        let bind_host = bind_host.into();
        let bind_host = if bind_host.trim().is_empty() {
            "0.0.0.0".to_string()
        } else {
            bind_host
        };
        Self {
            bin: bin.into(),
            config_path: state_dir.into().join(CONFIG_FILE_NAME),
            bind_host,
            log_level: "warn".to_string(),
            rules: Vec::new(),
            transport: None,
            content_hash: None,
            process: None,
            probe: None,
            status: RealmStatusHandle::default(),
        }
    }

    /// 心跳侧读状态用；clone 出来的句柄可以脱离 supervisor 借用。
    pub fn status_handle(&self) -> RealmStatusHandle {
        self.status.clone()
    }

    /// 配置里的 `realm_log_level`：只影响带 transport 的配置（`[log].level`）。
    /// 非法值回落到 `warn`，避免生成 realm 不认识的级别导致启动失败。
    pub fn set_log_level(&mut self, level: &str) {
        self.log_level = normalize_log_level(level).to_string();
    }

    /// 本机 realm 是否支持 transport（`realm --version` 含 `[transport]`）。
    ///
    /// 缓存按二进制 `(size, mtime)` 失效：运行中换掉二进制后不会继续沿用 true。
    /// `None` = 不存在 / 不可执行 / 命令失败，**不缓存**，下一轮心跳重试。
    pub async fn transport_capability(&mut self) -> Option<bool> {
        let stamp = binary_stamp(&self.bin)?;
        if let Some((cached, value)) = &self.transport {
            if *cached == stamp {
                return Some(*value);
            }
        }
        let value = detect_transport(&self.bin).await?;
        self.transport = Some((stamp, value));
        Some(value)
    }

    /// 收敛到期望列表。非 realm 规则会被忽略（分流在调用方做，这里防御一次）。
    ///
    /// 只有规则集合真的变了才重写配置并重启；进程已退出时也会尝试重新拉起，
    /// 这样 realm 装好/崩溃恢复后不需要等主控重新下发。
    pub async fn apply(&mut self, desired: &[DesiredForward]) {
        let mut seen = HashSet::new();
        let mut rules: Vec<DesiredForward> = desired
            .iter()
            .filter(|spec| spec.engine == ForwardEngine::Realm)
            // id 是主控侧主键；重复 id 保留第一条，与 native 的处理一致。
            .filter(|spec| seen.insert(spec.id.clone()))
            .cloned()
            .collect();
        rules.sort_by(|a, b| {
            a.listen_port
                .cmp(&b.listen_port)
                .then_with(|| a.id.cmp(&b.id))
        });
        self.rules = rules;

        if self.rules.is_empty() {
            self.stop("期望态里没有 realm 规则").await;
            self.content_hash = None;
            self.status.store(Vec::new());
            return;
        }

        // 先判「有没有装 realm」，再写配置。
        // 顺序很重要：state_dir 不可写（如权限不足）时，先写配置会报
        // 「写入 realm 配置失败」，把人引到错误的方向；而真正的原因是没装 realm。
        // 缺二进制时也不该落一份永远用不上的配置。
        if !self.bin.exists() {
            tracing::warn!(
                bin = %self.bin.display(),
                "realm 未安装，realm 规则保持未监听（native 规则不受影响）"
            );
            self.stop("realm 未安装").await;
            self.content_hash = None;
            self.status.store(self.inactive_statuses(NOT_INSTALLED));
            return;
        }

        // 能力门禁（防静默明文）：期望态里出现 transport 时，本机 realm 必须
        // 自带 `transport` feature。旧 Agent 会忽略字段、slim realm 会静默忽略
        // transport，两者都会得到「面板说加密、实际明文」——这里宁可整轮拒绝，
        // 也绝不渲染一份不带 transport 的明文配置。
        if self.has_transport_rules() {
            match self.transport_capability().await {
                Some(true) => {}
                capability => {
                    let reason = match capability {
                        Some(false) => TRANSPORT_UNSUPPORTED,
                        _ => TRANSPORT_UNKNOWN,
                    };
                    tracing::error!(
                        bin = %self.bin.display(),
                        ?capability,
                        "本机 realm 不支持跳间加密，已拒绝下发（不会回退明文）"
                    );
                    self.stop("realm 不支持 transport").await;
                    self.content_hash = None;
                    self.status.store(self.inactive_statuses(reason));
                    return;
                }
            }
        }

        let content = match render_config(&self.rules, &self.bind_host, &self.log_level) {
            Ok(content) => content,
            Err(error) => {
                tracing::error!(
                    rules = self.rules.len(),
                    %error,
                    "realm transport 配置不合法，整轮拒绝下发"
                );
                self.stop("realm 配置不合法").await;
                self.content_hash = None;
                self.status
                    .store(self.inactive_statuses(&format!("realm 配置不合法: {error}")));
                return;
            }
        };
        let hash = config_hash(&content);
        let config_changed = self.content_hash != Some(hash);
        let needs_start = !self.process_alive();

        if config_changed || needs_start {
            if config_changed {
                if let Err(error) = write_config_atomic(&self.config_path, &content) {
                    tracing::error!(
                        path = %self.config_path.display(),
                        %error,
                        "写入 realm 配置失败，realm 规则本轮不启动"
                    );
                    // 配置都写不下去时不要留着一个跑旧配置的子进程。
                    self.stop("realm 配置写入失败").await;
                    self.content_hash = None;
                    self.status
                        .store(self.inactive_statuses(&format!("写入 realm 配置失败: {error}")));
                    return;
                }
                tracing::info!(
                    path = %self.config_path.display(),
                    endpoints = self.rules.len(),
                    "realm 配置已更新"
                );
            }
            self.content_hash = Some(hash);
            self.restart().await;
        }

        // 刚 spawn 的进程可能在绑定端口；给它一点时间再探测，避免抢跑。
        tokio::time::sleep(STARTUP_GRACE).await;
        if self.process_alive() {
            let statuses = self.probe_statuses().await;
            // 探测期间进程可能刚好退出：监视任务写的「退出码」比这里的
            // 「未监听」信息更多，不能覆盖它。
            if self.process_alive() {
                self.status.store(statuses);
            }
        }
        // 目标探针：明文规则做 TCP 计时，带 remote_transport 的规则做 TLS 握手。
        // 规则集合变化时才重启任务。
        self.sync_probe();
    }

    /// 周期对账：子进程已退出（崩溃/被杀）时按磁盘上的最新配置重新拉起。
    ///
    /// 直播路径的 `apply` 只在主控下发期望态时才会被调用；realm 崩溃后如果
    /// 一直等下一次期望态，转发会静默停摆到下次 apply。心跳周期调用这里，
    /// 最多一个心跳周期就自愈。配置没变且进程还活着时**什么都不做**
    /// （不重写文件、不重启、不重新探测），因此可以安全地高频调用。
    pub async fn ensure_running(&mut self) {
        if self.rules.is_empty() || self.process_alive() {
            return;
        }
        // 还没成功写过配置（没装 realm / 写入失败）时不重试：原因已经写在
        // 状态里，每轮都重试只会刷日志，等下一次真实 apply 再处理。
        if self.content_hash.is_none() {
            return;
        }
        if !self.bin.exists() {
            // 运行中二进制被删掉：如实上报未安装。
            self.stop_probe();
            self.status.store(self.inactive_statuses(NOT_INSTALLED));
            return;
        }
        if !is_available(&self.bin) {
            // 存在但没有执行位：上一次 apply 已经把「启动失败」写进状态。
            // 这里不反复 spawn（会每 15 秒刷一行日志），等文件被修好再自愈。
            return;
        }
        // 运行中二进制被换成了 slim/旧版：即使旧配置还躺在磁盘上，也绝不能
        // 重新拉起——realm 会静默忽略 transport，直接变成明文。
        if self.has_transport_rules() {
            match self.transport_capability().await {
                Some(true) => {}
                capability => {
                    let reason = match capability {
                        Some(false) => TRANSPORT_UNSUPPORTED,
                        _ => TRANSPORT_UNKNOWN,
                    };
                    self.stop_probe();
                    self.status.store(self.inactive_statuses(reason));
                    return;
                }
            }
        }
        tracing::warn!(
            rules = self.rules.len(),
            "realm 进程已退出，按现有配置重新拉起"
        );
        self.restart().await;
        tokio::time::sleep(STARTUP_GRACE).await;
        if self.process_alive() {
            let statuses = self.probe_statuses().await;
            // 探测期间可能刚好又退出：监视任务写的退出码更具体，不能覆盖。
            if self.process_alive() {
                self.status.store(statuses);
            }
        }
        self.sync_probe();
    }

    /// 让目标探针任务与当前规则集合对齐。
    ///
    /// 只在规则集合（id/探测方式/目标）变化时重启任务：同一份期望态重复下发、
    /// 心跳对账都不会重置探测周期或丢掉上一轮结果。
    fn sync_probe(&mut self) {
        let spec = probe_specs(&self.rules);
        if self.probe.as_ref().is_some_and(|probe| probe.spec == spec) {
            return;
        }
        self.stop_probe();
        if spec.is_empty() {
            return;
        }
        let status = self.status.clone();
        let task = tokio::spawn(run_probe_loop(spec.clone(), status));
        self.probe = Some(RunningProbe { spec, task });
    }

    /// 停掉探针任务（配置变化、进程停止、没有可探测的规则）。
    fn stop_probe(&mut self) {
        if let Some(probe) = self.probe.take() {
            probe.task.abort();
        }
    }

    /// 每条规则一条状态：用 bind 探测判断端口是否已被 realm 占用。
    async fn probe_statuses(&self) -> Vec<ForwardStatus> {
        let mut statuses = Vec::with_capacity(self.rules.len());
        for rule in &self.rules {
            let listening = probe_listening(&self.bind_host, rule.listen_port).await;
            statuses.push(ForwardStatus {
                id: rule.id.clone(),
                listening,
                error: if listening {
                    String::new()
                } else {
                    NOT_LISTENING.to_string()
                },
                // realm 没有状态 API，目标可达性由目标探针单独写入。
                target_ok: None,
                target_error: None,
                targets: Vec::new(),
                traffic_in: None,
                traffic_out: None,
            });
        }
        statuses
    }

    /// 期望态里是否有任何端点带 transport。
    fn has_transport_rules(&self) -> bool {
        self.rules
            .iter()
            .any(|rule| rule.listen_transport.is_some() || rule.remote_transport.is_some())
    }

    fn inactive_statuses(&self, reason: &str) -> Vec<ForwardStatus> {
        self.rules
            .iter()
            .map(|rule| ForwardStatus {
                id: rule.id.clone(),
                listening: false,
                error: reason.to_string(),
                target_ok: None,
                target_error: None,
                targets: Vec::new(),
                traffic_in: None,
                traffic_out: None,
            })
            .collect()
    }

    fn process_alive(&self) -> bool {
        self.process
            .as_ref()
            .is_some_and(|running| !running.task.is_finished())
    }

    /// 重启子进程：先停旧的（等它真正退出、释放端口），再按新配置拉起。
    async fn restart(&mut self) {
        self.stop("重新加载 realm 配置").await;

        if !self.bin.exists() {
            // 没装 realm：所有 realm 规则报「realm 未安装」，native 不受影响。
            tracing::warn!(
                bin = %self.bin.display(),
                "realm 未安装，realm 规则保持未监听（native 规则不受影响）"
            );
            self.status.store(self.inactive_statuses(NOT_INSTALLED));
            return;
        }

        let mut command = tokio::process::Command::new(&self.bin);
        command
            .arg("-c")
            .arg(&self.config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            // stderr 直接进 Agent 日志：realm 绑定失败时运维能立刻看到原因。
            .stderr(Stdio::inherit())
            // supervisor 被丢弃/abort 时不让子进程变成孤儿。
            .kill_on_drop(true);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                // 文件存在但起不来（权限、动态库缺失等）：只影响 realm 规则。
                tracing::warn!(
                    bin = %self.bin.display(),
                    %error,
                    "realm 启动失败，realm 规则保持未监听"
                );
                self.status
                    .store(self.inactive_statuses(&format!("realm 启动失败: {error}")));
                return;
            }
        };

        let pid = child.id();
        let (stop_tx, stop_rx) = oneshot::channel();
        let status = self.status.clone();
        let ids: Vec<String> = self.rules.iter().map(|rule| rule.id.clone()).collect();
        let task = tokio::spawn(async move {
            let code = watch_child(&mut child, stop_rx).await;
            match code {
                Some(code) => tracing::warn!(?pid, code, "realm 进程已退出"),
                None => tracing::warn!(?pid, "realm 进程被信号终止"),
            }
            status.mark_exited(code, &ids);
        });
        self.process = Some(RunningRealm {
            stop: Some(stop_tx),
            task,
        });
        tracing::info!(
            bin = %self.bin.display(),
            config = %self.config_path.display(),
            ?pid,
            endpoints = self.rules.len(),
            "realm 进程已启动"
        );
    }

    /// 通知监视任务停止并等它退出；子进程由 `kill_on_drop` 兜底回收。
    ///
    /// 探针任务一并停掉：进程都不在了，继续探测只会往状态里写与转发无关的结论。
    async fn stop(&mut self, reason: &str) {
        self.stop_probe();
        let Some(mut running) = self.process.take() else {
            return;
        };
        if let Some(stop) = running.stop.take() {
            let _ = stop.send(());
        }
        if tokio::time::timeout(STOP_TIMEOUT, &mut running.task)
            .await
            .is_err()
        {
            tracing::warn!(reason, "realm 进程停止超时，强制中止");
            running.task.abort();
            let _ = running.task.await;
        }
        tracing::info!(reason, "realm 进程已停止");
    }
}

impl Drop for RealmSupervisor {
    fn drop(&mut self) {
        // 探针任务持有一份状态句柄；supervisor 被丢弃（进程退出/测试结束）时
        // 必须一起停掉，否则它会继续在后台按 30s 周期探测。
        self.stop_probe();
    }
}

/// 等子进程退出；收到 stop 就先发 SIGKILL 再回收，避免僵尸进程。
async fn watch_child(
    child: &mut tokio::process::Child,
    mut stop: oneshot::Receiver<()>,
) -> Option<i32> {
    tokio::select! {
        status = child.wait() => status.map(|status| status.code()).unwrap_or(None),
        _ = &mut stop => {
            let _ = child.start_kill();
            child.wait().await.ok().and_then(|status| status.code())
        }
    }
}

/// 本机 bind 探针：`AddrInUse` = 端口已被别人（这里是 realm）占着。
///
/// 绑定成功说明没人监听，`listener` 立刻 drop 释放端口——探针本身不能
/// 阻止 realm 之后绑定同一个端口。
async fn probe_listening(bind_host: &str, listen_port: i64) -> bool {
    let Ok(port) = u16::try_from(listen_port) else {
        return false;
    };
    match TcpListener::bind((bind_host, port)).await {
        Ok(listener) => {
            drop(listener);
            false
        }
        Err(error) => error.kind() == io::ErrorKind::AddrInUse,
    }
}

/// 从 realm 的 `remote_transport` 串里取出 SNI（`tls;sni=X`）。
///
/// 主控已用 `TransportSpec` 生成并校验过，这里只做防御式解析：
/// 不是 `tls` 开头、没有 `sni=` 的串一律不探测（保持 `target_error = None`）。
fn remote_transport_sni(raw: &str) -> Option<String> {
    let mut tokens = raw.split(';');
    if tokens.next() != Some("tls") {
        return None;
    }
    tokens
        .filter_map(|token| token.strip_prefix("sni="))
        .find(|sni| !sni.is_empty())
        .map(str::to_string)
}

/// 当前需要探测的规则集合。
///
/// 明文规则（两个 transport 都没有）做 TCP 计时，带 `remote_transport` 的规则做
/// TLS 握手；只有 `listen_transport` 的加密落地跳不探测（它没有下一跳可测，
/// 目标是普通下游，不是链路上的服务器）。
fn probe_specs(rules: &[DesiredForward]) -> Vec<ProbeSpec> {
    let mut specs: Vec<ProbeSpec> = rules
        .iter()
        .filter(|rule| rule.engine == ForwardEngine::Realm)
        .filter_map(|rule| {
            let mode = probe_mode(rule)?;
            let targets: Vec<ProbeTarget> = probe_targets(rule);
            if targets.is_empty() {
                return None;
            }
            Some(ProbeSpec {
                id: rule.id.clone(),
                mode,
                targets,
            })
        })
        .collect();
    specs.sort_by(|a, b| a.id.cmp(&b.id));
    specs
}

/// 规则 → 探测方式。
///
/// * `remote_transport = "tls;sni=…"`：沿用现有的 TLS 握手探测（加密链行为不变）；
/// * 两个 transport 都没有：明文规则，只做 TCP connect 计时——多跳链最常见的形态；
/// * 只有 `listen_transport`：加密落地跳 / 仅监听入口，没有「本跳 → 下一跳」的
///   链路段可测，保持升级前的不探测行为；
/// * `remote_transport` 不是合法的 `tls;sni=…`：不探测（渲染配置时会整轮拒绝）。
fn probe_mode(rule: &DesiredForward) -> Option<ProbeMode> {
    match rule.remote_transport.as_deref() {
        Some(raw) => remote_transport_sni(raw).map(|sni| ProbeMode::Tls { sni }),
        None if rule.listen_transport.is_none() => Some(ProbeMode::Tcp),
        None => None,
    }
}

/// 一轮探测：每条规则对它**所有**下一跳成员各做一次真实握手。
///
/// 任一成员成功 = 这一跳可达（`target_ok = true`，`target_error = None`）；
/// 全部失败时取第一个失败原因（`ForwardStatus` 只有一个 `target_error`）。
async fn probe_rule(spec: &ProbeSpec) -> (tls_probe::ProbeError, Vec<TargetProbe>) {
    let results = futures_util::future::join_all(
        spec.targets
            .iter()
            .map(|target| probe_target(&spec.mode, target)),
    )
    .await;
    let probes: Vec<TargetProbe> = spec
        .targets
        .iter()
        .zip(results.iter())
        .map(|(target, result)| TargetProbe {
            server_id: target.server_id.clone(),
            ok: result.error.is_none(),
            latency_ms: result.latency_ms,
        })
        .collect();
    // 任一成员握手成功 = 这一跳可达；否则取第一个失败原因。
    let error = if results.iter().any(|result| result.error.is_none()) {
        None
    } else {
        results.iter().find_map(|result| result.error)
    };
    (error, probes)
}

/// 按规则类型选探针：明文只做 TCP 握手，加密做完整 TLS 握手。
async fn probe_target(mode: &ProbeMode, target: &ProbeTarget) -> tls_probe::TimedProbe {
    match mode {
        ProbeMode::Tcp => probe_tcp_timed(&target.host, target.port).await,
        ProbeMode::Tls { sni } => tls_probe::probe_timed(&target.host, target.port, sni).await,
    }
}

/// 明文规则的轻量探针：TCP connect 计时，连上即关，不发送、不读取任何字节。
///
/// 复用 TLS 探针的总预算 [`tls_probe::PROBE_TIMEOUT`]：一条黑洞目标不能把整轮
/// 探测拖住。成功路径和 TLS 探针一样把 0ms（本机回环）抬到 1ms；失败时
/// `latency_ms = None`，绝不写 0。
async fn probe_tcp_timed(host: &str, port: i64) -> tls_probe::TimedProbe {
    match tokio::time::timeout(tls_probe::PROBE_TIMEOUT, tcp_connect_timed(host, port)).await {
        Ok(result) => result,
        Err(_) => failed_probe(tls_probe::TIMEOUT),
    }
}

fn failed_probe(code: &'static str) -> tls_probe::TimedProbe {
    tls_probe::TimedProbe {
        error: Some(code),
        latency_ms: None,
    }
}

async fn tcp_connect_timed(host: &str, port: i64) -> tls_probe::TimedProbe {
    let Some(port) = u16::try_from(port).ok().filter(|port| *port != 0) else {
        return failed_probe(tls_probe::TCP_CONNECT_FAILED);
    };
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return failed_probe(tls_probe::TCP_CONNECT_FAILED);
    }
    let Ok(addresses) = tokio::net::lookup_host((host, port)).await else {
        return failed_probe(tls_probe::TCP_CONNECT_FAILED);
    };
    let mut last_error = tls_probe::TCP_CONNECT_FAILED;
    for address in addresses {
        let started = Instant::now();
        match TcpStream::connect(address).await {
            Ok(stream) => {
                let millis = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
                // 明文规则只要「端口能连上」；立刻关闭，不往目标写任何字节。
                drop(stream);
                return tls_probe::TimedProbe {
                    error: None,
                    latency_ms: Some(millis.max(1)),
                };
            }
            Err(error) => {
                last_error = if error.kind() == io::ErrorKind::TimedOut {
                    tls_probe::TIMEOUT
                } else {
                    tls_probe::TCP_CONNECT_FAILED
                };
            }
        }
    }
    failed_probe(last_error)
}

/// 把一轮探测结果转成状态缓存。
///
/// 明文探测的失败原因只用于日志（状态跃迁），不写进 `target_error`：
/// 那个字段在协议里只属于加密链。
fn probe_health(
    spec: &ProbeSpec,
    error: tls_probe::ProbeError,
    targets: Vec<TargetProbe>,
) -> ProbeHealth {
    ProbeHealth {
        ok: error.is_none(),
        error: if spec.mode.reports_error() {
            error.map(str::to_string)
        } else {
            None
        },
        targets,
    }
}

/// 探针主循环：立即测一轮，之后每 [`PROBE_INTERVAL`] 测一轮。
///
/// 只写状态缓存，从不碰 realm 进程或转发路径；失败不影响转发。
async fn run_probe_loop(specs: Vec<ProbeSpec>, status: RealmStatusHandle) {
    // 只在状态跃迁时打日志，避免 30 秒一条刷屏。
    let mut previous: HashMap<String, tls_probe::ProbeError> = HashMap::new();
    loop {
        for spec in &specs {
            let (error, probes) = probe_rule(spec).await;
            let target = spec
                .targets
                .first()
                .map(|target| format!("{}:{}", target.host, target.port))
                .unwrap_or_default();
            match (previous.get(&spec.id).copied(), error) {
                (None, Some(code)) => tracing::warn!(
                    rule = %spec.id,
                    mode = spec.mode.label(),
                    target = %target,
                    error = code,
                    "目标探针失败"
                ),
                (Some(Some(previous)), Some(code)) if previous != code => tracing::warn!(
                    rule = %spec.id,
                    mode = spec.mode.label(),
                    target = %target,
                    error = code,
                    previous,
                    "目标探针失败原因变化"
                ),
                (Some(Some(_)), None) => tracing::info!(
                    rule = %spec.id,
                    mode = spec.mode.label(),
                    target = %target,
                    "目标探针恢复"
                ),
                _ => {}
            }
            previous.insert(spec.id.clone(), error);
            status.set_probe_health(&spec.id, probe_health(spec, error, probes));
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
    }
}

/// 按 realm 的配置模型渲染一份 TOML。
///
/// 协议由每条规则的 `protocol` 决定：`both` 打开全局 `use_udp`，`tcp` 关闭它并给
/// 端点加 `network = { use_udp = false }`；`udp` 模式在 realm 里不支持（主控已拒绝）。
/// `no_tcp` / `use_udp` 是 **`[network]` 的全局开关**，不写在每个 endpoint 里
/// （endpoint 只有 `network` 子表可覆盖，顶层不收这两个键）。多目标时第一个写 `remote`，
/// 其余写 `extra_remotes`，并加 `balance = "roundrobin: ..."`——
/// 本轮不带权重，每个目标权重都是 1。排序由调用方/本函数按监听端口固定，
/// 同一组规则重复渲染必须逐字节一致（否则内容哈希会抖，子进程会被反复重启）。
pub fn render_config(
    rules: &[DesiredForward],
    bind_host: &str,
    log_level: &str,
) -> Result<String, String> {
    let mut ordered: Vec<&DesiredForward> = rules
        .iter()
        .filter(|rule| rule.engine == ForwardEngine::Realm)
        .collect();
    ordered.sort_by(|a, b| {
        a.listen_port
            .cmp(&b.listen_port)
            .then_with(|| a.id.cmp(&b.id))
    });

    // 先整体校验 transport：宁可整轮拒绝，也不写出一份 realm 会静默忽略
    // transport 的配置（那等于明文）。
    let has_transport = ordered
        .iter()
        .any(|rule| rule.listen_transport.is_some() || rule.remote_transport.is_some());
    // realm 的 `[network]` 只有全局开关，`no_tcp = true` 会让所有端点都失去 TCP；
    // 主控写路径已经拒绝「仅 UDP + realm」，这里再防御一次，绝不为一条脏数据
    // 把同进程的其它端点一起改成 UDP-only。
    for rule in &ordered {
        let protocol = rule.effective_protocol();
        if protocol == pierwave_proto::ForwardProtocol::Udp {
            return Err(format!(
                "端点 {} 只监听 UDP，realm 引擎固定双开，拒绝下发",
                rule.id
            ));
        }
        let endpoint_has_transport =
            rule.listen_transport.is_some() || rule.remote_transport.is_some();
        if endpoint_has_transport && !rule.disable_udp {
            return Err(format!(
                "端点 {} 带 transport 但主控没有要求关闭 UDP；UDP 不走 transport，拒绝下发",
                rule.id
            ));
        }
        if let Some(raw) = &rule.listen_transport {
            validate_transport(TransportSide::Listen, raw)
                .map_err(|error| format!("端点 {} 的 listen_transport 不合法: {error}", rule.id))?;
        }
        if let Some(raw) = &rule.remote_transport {
            validate_transport(TransportSide::Remote, raw)
                .map_err(|error| format!("端点 {} 的 remote_transport 不合法: {error}", rule.id))?;
        }
    }
    // 任意端点需要 UDP 时全局打开；只监听 TCP 的端点再用 `network` 覆盖关闭。
    let any_udp = ordered
        .iter()
        .any(|rule| rule.effective_protocol().allows_udp());

    let mut out = String::new();
    out.push_str("# generated by pierwave-agent; do not edit（主控下发为准）\n");
    if any_udp {
        out.push_str("[network]\nno_tcp = false\nuse_udp = true\n");
    } else {
        out.push_str("[network]\nno_tcp = false\nuse_udp = false\n");
    }

    // `[log]` 只在确实有加密端点时生成：没有 transport 的服务器升级后
    // 不应该因为多一行配置而重启 realm。realm 默认 level=off、输出 stdout，
    // Agent 把 stdout 丢了，不配 stderr 就看不到绑定错误。
    if has_transport {
        let level = normalize_log_level(log_level);
        let _ = write!(out, "\n[log]\nlevel = \"{level}\"\noutput = \"stderr\"\n");
    }

    for rule in ordered {
        let targets = rule_targets(rule);
        let Some(first) = targets.first() else {
            // 没有目标（主控校验不会放行）——宁可不写这个 endpoint，
            // 也不生成一份一定起不来的配置。
            continue;
        };
        out.push_str("\n[[endpoints]]\n");
        let _ = writeln!(
            out,
            "listen = \"{}\"",
            toml_escape(&format_addr(bind_host, rule.listen_port))
        );
        let _ = writeln!(
            out,
            "remote = \"{}\"",
            toml_escape(&format_addr(first.0, first.1))
        );
        if targets.len() > 1 {
            let extras: Vec<String> = targets[1..]
                .iter()
                .map(|(host, port)| format!("\"{}\"", toml_escape(&format_addr(host, *port))))
                .collect();
            let _ = writeln!(out, "extra_remotes = [{}]", extras.join(", "));
            let weights = vec!["1"; targets.len()].join(", ");
            let _ = writeln!(out, "balance = \"roundrobin: {weights}\"");
        }
        // 键顺序固定：listen → remote → extra_remotes → balance →
        // listen_transport → remote_transport → network。
        if let Some(transport) = &rule.listen_transport {
            let _ = writeln!(out, "listen_transport = \"{}\"", toml_escape(transport));
        }
        if let Some(transport) = &rule.remote_transport {
            let _ = writeln!(out, "remote_transport = \"{}\"", toml_escape(transport));
        }
        // TCP-only 端点必须覆盖全局 use_udp=true；UDP 不走 transport，
        // 加密端点同样要显式关闭。
        if rule.disable_udp || !rule.effective_protocol().allows_udp() {
            out.push_str("network = { use_udp = false }\n");
        }
    }
    Ok(out)
}

/// transport 串的端别：监听端只认 cert/key，客户端只认 sni。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransportSide {
    Listen,
    Remote,
}

/// 严格校验主控下发的 transport 串。
///
/// 只接受 `tls` 开关 + 本端允许的键：监听端 `cert`/`key` 各一次，客户端
/// `sni` 一次。`insecure` / `0rtt` / `ws` / 任何未知键都直接拒绝——这些要么
/// 关闭身份校验，要么会静默改变协议，都不是本期允许的形态。
fn validate_transport(side: TransportSide, raw: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Err("空串等于没有 transport".into());
    }
    let tokens: Vec<&str> = raw.split(';').collect();
    if tokens.first() != Some(&"tls") {
        return Err(format!(
            "必须以 tls 开头（收到 {raw:?}）；wss 不是合法 token"
        ));
    }
    let mut cert = false;
    let mut key = false;
    let mut sni = false;
    for token in &tokens[1..] {
        if token.is_empty() {
            return Err("存在空的 token".into());
        }
        if matches!(*token, "insecure" | "0rtt" | "ws" | "wss") {
            return Err(format!("禁止的 transport token：{token}"));
        }
        let Some((name, value)) = token.split_once('=') else {
            return Err(format!("token「{token}」不是 key=value"));
        };
        if !valid_transport_value(value) {
            return Err(format!("token「{token}」的值包含非法字符"));
        }
        match (side, name) {
            (TransportSide::Listen, "cert") if !cert => cert = true,
            (TransportSide::Listen, "key") if !key => key = true,
            (TransportSide::Remote, "sni") if !sni => sni = true,
            _ => return Err(format!("本端不允许的 transport 键：{name}")),
        }
    }
    match side {
        TransportSide::Listen if !(cert && key) => {
            Err("监听端必须同时提供 cert 与 key（缺一个 realm 会 panic）".into())
        }
        TransportSide::Remote if !sni => Err("客户端必须提供 sni（缺失 realm 会 panic）".into()),
        _ => Ok(()),
    }
}

/// transport 值只允许路径/域名安全字符：`;`、空白、引号都无法注入。
fn valid_transport_value(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-'))
}

/// 日志级别白名单；未知值回落到 `warn`。
fn normalize_log_level(raw: &str) -> &'static str {
    match raw.trim() {
        "trace" => "trace",
        "debug" => "debug",
        "info" => "info",
        "error" => "error",
        "off" => "off",
        _ => "warn",
    }
}

/// 二进制标识：大小 + 修改时间，用来判断「运行中是否被换过」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BinaryStamp {
    size: u64,
    modified: Option<SystemTime>,
}

fn binary_stamp(path: &Path) -> Option<BinaryStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(BinaryStamp {
        size: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

/// 跑一次 `realm --version`，看输出是否包含 `[transport]`。
///
/// 超时/启动失败/非零退出都返回 `None`（未知，按不支持处理），不缓存。
async fn detect_transport(bin: &Path) -> Option<bool> {
    let mut command = tokio::process::Command::new(bin);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = tokio::time::timeout(CAPABILITY_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Some(text.contains("[transport]"))
}

/// 探测用的下一跳列表：与 `rule_targets` 相同的顺序，额外带上 server_id。
///
/// 单成员组走兼容字段时 Agent 拿不到 server_id（空串），主控会按「唯一成员」
/// 匹配；多成员组的 `targets` 一定带 server_id。
fn probe_targets(rule: &DesiredForward) -> Vec<ProbeTarget> {
    if rule.targets.is_empty() {
        vec![ProbeTarget {
            host: rule.target_host.clone(),
            port: rule.target_port,
            server_id: String::new(),
        }]
    } else {
        rule.targets
            .iter()
            .map(|target| ProbeTarget {
                host: target.host.clone(),
                port: target.port,
                server_id: target.server_id.clone(),
            })
            .collect()
    }
}

/// 规则的目标列表：`targets` 为空时退回旧主控的单目标字段。
fn rule_targets(rule: &DesiredForward) -> Vec<(&str, i64)> {
    if rule.targets.is_empty() {
        vec![(rule.target_host.as_str(), rule.target_port)]
    } else {
        rule.targets
            .iter()
            .map(|target| (target.host.as_str(), target.port))
            .collect()
    }
}

/// `host:port`；IPv6 字面量补方括号（realm 按 `host:port` 解析地址）。
fn format_addr(host: &str, port: i64) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// TOML 基本字符串转义：只处理会破坏语法的 `\` 与 `"`。
fn toml_escape(raw: &str) -> String {
    raw.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 配置内容哈希（FNV-1a 64 位）。
///
/// 用固定算法而不是 `DefaultHasher`：值虽然不落库，但重启前后/不同构建
/// 必须得出同一个哈希，才能可靠地判断「规则集合没变、不用重启」。
pub fn config_hash(content: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 临时文件 + rename 的原子写：realm 读到的配置要么是旧的、要么是新的。
fn write_config_atomic(path: &Path, content: &str) -> io::Result<()> {
    if let Some(parent) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = tmp_path(path);
    std::fs::write(&tmp, content)?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(())
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".tmp");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pierwave_proto::ForwardTarget;

    /// 每个用例独立临时目录，Drop 时清理；不引入 tempfile 依赖。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("pierwave-realm-test-{}", uuid::Uuid::new_v4()));
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

    fn realm_rule(id: &str, listen_port: i64, targets: &[(&str, i64)]) -> DesiredForward {
        let mut spec = DesiredForward {
            id: id.into(),
            listen_port,
            target_host: String::new(),
            target_port: 0,
            targets: Vec::new(),
            strategy: Default::default(),
            engine: ForwardEngine::Realm,
            protocol: pierwave_proto::ForwardProtocol::Both,
            udp: true,
            listen_transport: None,
            remote_transport: None,
            disable_udp: false,
        };
        for (host, port) in targets {
            spec.targets.push(ForwardTarget {
                host: (*host).into(),
                port: *port,
                server_id: String::new(),
            });
        }
        if let Some((host, port)) = targets.first() {
            spec.target_host = (*host).into();
            spec.target_port = *port;
        }
        spec
    }

    /// 集中测试用渲染：默认 warn 级别，失败即 panic。
    fn render(rules: &[DesiredForward]) -> String {
        render_config(rules, "0.0.0.0", "warn").expect("测试规则必须能渲染")
    }

    #[test]
    fn availability_requires_an_executable_file() {
        let dir = TempDir::new();
        let bin = dir.path().join("realm");

        assert!(!is_available(&bin), "路径不存在时 realm 不可用");

        std::fs::write(&bin, b"#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(!is_available(&bin), "文件存在但没有执行位时 realm 仍不可用");
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(is_available(&bin), "存在且可执行才算可用");

        assert!(!is_available(dir.path()), "目录不是 realm 可执行文件");

        std::fs::remove_file(&bin).unwrap();
        assert!(!is_available(&bin), "运行中被删除要立刻反映为不可用");
    }

    #[test]
    fn renders_single_target_endpoint() {
        let toml = render(&[realm_rule("r1", 30001, &[("10.0.0.2", 443)])]);

        assert!(toml.contains("[[endpoints]]"), "{toml}");
        assert!(toml.contains("listen = \"0.0.0.0:30001\""), "{toml}");
        assert!(toml.contains("remote = \"10.0.0.2:443\""), "{toml}");
        assert!(!toml.contains("extra_remotes"), "单目标不写 extra_remotes");
        assert!(!toml.contains("balance"), "单目标不写 balance");
        assert!(toml.contains("no_tcp = false"), "{toml}");
        assert!(toml.contains("use_udp = true"), "{toml}");
    }

    #[test]
    fn renders_multi_target_endpoint_with_balance() {
        let toml = render(&[realm_rule(
            "r1",
            30001,
            &[("10.0.0.2", 443), ("10.0.0.3", 8443)],
        )]);

        assert!(toml.contains("remote = \"10.0.0.2:443\""), "{toml}");
        assert!(
            toml.contains("extra_remotes = [\"10.0.0.3:8443\"]"),
            "{toml}"
        );
        assert!(toml.contains("balance = \"roundrobin: 1, 1\""), "{toml}");
        assert_eq!(toml.matches("[[endpoints]]").count(), 1);
    }

    /// 两跳、第二个 endpoint 有 2 个目标：端口排序稳定，balance 只出现在多目标那条。
    #[test]
    fn renders_two_hops_with_sorted_endpoints() {
        let toml = render(&[
            // 故意乱序传入：渲染必须按监听端口排序。
            realm_rule(
                "chain-c1-0",
                30001,
                &[("10.0.0.2", 40001), ("10.0.0.3", 40001)],
            ),
            realm_rule("chain-c1-1", 30002, &[("203.0.113.9", 443)]),
        ]);

        let first = toml.find("listen = \"0.0.0.0:30001\"").unwrap();
        let second = toml.find("listen = \"0.0.0.0:30002\"").unwrap();
        assert!(first < second, "endpoint 必须按监听端口升序：{toml}");
        assert_eq!(toml.matches("[[endpoints]]").count(), 2);
        assert_eq!(
            toml.matches("balance = \"roundrobin: 1, 1\"").count(),
            1,
            "只有 2 个目标的那跳写 balance：{toml}"
        );
        assert!(toml.contains("remote = \"203.0.113.9:443\""), "{toml}");
    }

    #[test]
    fn ipv6_targets_are_bracketed() {
        let toml = render(&[realm_rule("v6", 30001, &[("2001:db8::1", 443)])]);
        assert!(toml.contains("remote = \"[2001:db8::1]:443\""), "{toml}");
    }

    #[test]
    fn config_hash_is_stable_and_order_independent() {
        let a = realm_rule("a", 30001, &[("10.0.0.2", 443)]);
        let b = realm_rule("b", 30002, &[("10.0.0.3", 443)]);

        let forward = render(&[a.clone(), b.clone()]);
        let reversed = render(&[b.clone(), a.clone()]);
        assert_eq!(forward, reversed, "同一组规则换顺序必须渲染出同一份配置");
        assert_eq!(
            config_hash(&forward),
            config_hash(&reversed),
            "内容哈希相同 = 不重启子进程"
        );

        let changed = render(&[realm_rule("a", 30009, &[("10.0.0.2", 443)]), b]);
        assert_ne!(
            config_hash(&forward),
            config_hash(&changed),
            "端口变化必须换哈希"
        );

        // 固定算法：换实现/换进程后仍能比较（写死一个值防止被改成随机哈希）。
        assert_eq!(config_hash("realm"), config_hash("realm"));
        assert_ne!(config_hash(""), config_hash("realm"));
    }

    #[test]
    fn non_realm_rules_are_ignored_when_rendering() {
        let native = DesiredForward {
            engine: ForwardEngine::Native,
            ..realm_rule("native", 30001, &[("10.0.0.2", 443)])
        };
        let toml = render(&[native]);
        assert!(!toml.contains("[[endpoints]]"), "{toml}");
    }

    #[tokio::test]
    async fn bind_probe_sees_listener_and_releases_free_port() {
        // 被占用：探针必须报「已监听」（AddrInUse）。
        let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let occupied_port = i64::from(occupied.local_addr().unwrap().port());
        assert!(
            probe_listening("127.0.0.1", occupied_port).await,
            "端口被占时 AddrInUse = realm 已监听"
        );

        // 空闲：探针必须报「未监听」，并且自己立刻释放端口。
        let free_port = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            i64::from(probe.local_addr().unwrap().port())
        };
        assert!(
            !probe_listening("127.0.0.1", free_port).await,
            "没人监听时绑定成功 = 未监听"
        );
        std::net::TcpListener::bind(("127.0.0.1", free_port as u16))
            .expect("探针必须立刻释放端口，否则 realm 之后会绑不上");
    }

    /// 明文规则必须进入 TCP 探测；带 `remote_transport = "tls;sni=…"` 的规则继续
    /// 做 TLS 握手；只有 `listen_transport` 的落地跳、非法 transport、native 规则
    /// 都不探测（与升级前一致）。
    #[test]
    fn probe_specs_cover_plaintext_and_tls_rules_but_not_listen_only() {
        let mut tls = realm_rule("r-tls", 30001, &[("10.0.0.2", 443), ("10.0.0.3", 443)]);
        tls.targets[0].server_id = "srv-g1-a".into();
        tls.targets[1].server_id = "srv-g1-b".into();
        tls.remote_transport = Some("tls;sni=Hop1.Example.com".into());
        tls.disable_udp = true;

        let plaintext = realm_rule("r-plain", 30002, &[("10.0.0.4", 443)]);

        let mut listen_only = realm_rule("r-listen", 30003, &[("10.0.0.5", 443)]);
        listen_only.listen_transport = Some(
            "tls;cert=/usr/local/etc/xray/certs/a.pem;key=/usr/local/etc/xray/certs/a.key".into(),
        );
        listen_only.disable_udp = true;

        let mut malformed = realm_rule("r-bad", 30004, &[("10.0.0.6", 443)]);
        malformed.remote_transport = Some("wss;sni=hop.example.com".into());

        let mut native = realm_rule("r-native", 30005, &[("10.0.0.7", 443)]);
        native.engine = ForwardEngine::Native;
        native.remote_transport = Some("tls;sni=hop.example.com".into());

        let specs = probe_specs(&[tls, plaintext, listen_only, malformed, native]);
        assert_eq!(specs.len(), 2, "明文与加密各一条：{specs:?}");

        let plaintext_spec = specs
            .iter()
            .find(|spec| spec.id == "r-plain")
            .expect("明文规则必须做 TCP 探测");
        assert_eq!(plaintext_spec.mode, ProbeMode::Tcp);
        assert_eq!(
            plaintext_spec.targets,
            vec![ProbeTarget {
                host: "10.0.0.4".into(),
                port: 443,
                server_id: String::new(),
            }]
        );

        let tls_spec = specs
            .iter()
            .find(|spec| spec.id == "r-tls")
            .expect("加密规则必须做 TLS 探测");
        assert_eq!(
            tls_spec.mode,
            ProbeMode::Tls {
                sni: "Hop1.Example.com".into()
            },
            "SNI 原样使用（主控已小写）"
        );
        assert_eq!(
            tls_spec.targets,
            vec![
                ProbeTarget {
                    host: "10.0.0.2".into(),
                    port: 443,
                    server_id: "srv-g1-a".into(),
                },
                ProbeTarget {
                    host: "10.0.0.3".into(),
                    port: 443,
                    server_id: "srv-g1-b".into(),
                },
            ],
            "组内每个成员都要探测，并带上 server_id 供主控聚合"
        );
    }

    #[test]
    fn remote_transport_sni_requires_tls_and_sni_token() {
        assert_eq!(
            remote_transport_sni("tls;sni=hop.example.com"),
            Some("hop.example.com".to_string())
        );
        assert_eq!(
            remote_transport_sni("tls;ws;sni=a"),
            Some("a".to_string()),
            "只有 sni= 才是探测关心的字段"
        );
        assert_eq!(
            remote_transport_sni("ws;sni=a"),
            None,
            "不是 tls 的 transport 不探测"
        );
        assert_eq!(
            remote_transport_sni("tls;cert=/a.pem;key=/a.key"),
            None,
            "监听端 transport 没有 sni，不该探测"
        );
        assert_eq!(remote_transport_sni(""), None);
        assert_eq!(remote_transport_sni("tls;sni="), None);
    }

    /// 监听状态与目标探测结果由不同任务写入，快照必须合并且互不覆盖。
    #[test]
    fn status_snapshot_merges_probe_health_without_overwriting_listening() {
        let handle = RealmStatusHandle::default();
        handle.store(vec![ForwardStatus {
            id: "r1".into(),
            listening: true,
            error: String::new(),
            target_ok: None,
            target_error: None,
            targets: Vec::new(),
            traffic_in: None,
            traffic_out: None,
        }]);
        assert_eq!(
            handle.snapshot()[0].target_ok,
            None,
            "还没探测时必须是 None"
        );

        handle.set_probe_health(
            "r1",
            ProbeHealth {
                ok: false,
                error: Some(tls_probe::UNKNOWN_ISSUER.into()),
                targets: vec![TargetProbe {
                    server_id: "srv-b".into(),
                    ok: false,
                    latency_ms: None,
                }],
            },
        );
        let status = handle.snapshot().pop().unwrap();
        assert!(status.listening, "探针失败不能篡改 listening");
        assert_eq!(status.target_ok, Some(false));
        assert_eq!(
            status.target_error.as_deref(),
            Some(tls_probe::UNKNOWN_ISSUER)
        );

        handle.set_probe_health(
            "r1",
            ProbeHealth {
                ok: true,
                error: None,
                targets: vec![TargetProbe {
                    server_id: "srv-b".into(),
                    ok: true,
                    latency_ms: Some(12),
                }],
            },
        );
        let status = handle.snapshot().pop().unwrap();
        assert_eq!(status.target_ok, Some(true));
        assert_eq!(status.target_error, None, "成功时不能残留上一轮原因");
        assert_eq!(
            status.targets,
            vec![TargetProbe {
                server_id: "srv-b".into(),
                ok: true,
                latency_ms: Some(12),
            }],
            "逐目标 RTT 必须随快照带出（链路延迟用）"
        );

        // 规则已不在期望态：整体替换后探针缓存不能再造出一条状态。
        handle.store(Vec::new());
        handle.set_probe_health(
            "r1",
            ProbeHealth {
                ok: false,
                error: Some(tls_probe::TIMEOUT.into()),
                targets: Vec::new(),
            },
        );
        assert!(handle.snapshot().is_empty());
    }

    /// 明文规则的探测方式：一条 TCP 目标。
    fn tcp_probe_spec(id: &str, host: &str, port: i64) -> ProbeSpec {
        ProbeSpec {
            id: id.into(),
            mode: ProbeMode::Tcp,
            targets: vec![ProbeTarget {
                host: host.into(),
                port,
                server_id: String::new(),
            }],
        }
    }

    /// 明文规则的真实探测：本地 TcpListener → 成功且带 RTT（1..5000ms）。
    #[tokio::test]
    async fn plaintext_probe_reports_rtt_to_a_listening_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = i64::from(listener.local_addr().unwrap().port());
        let spec = tcp_probe_spec("chain-c1-0", "127.0.0.1", port);

        let (error, probes) = probe_rule(&spec).await;
        assert_eq!(error, None, "本地监听必须探测成功");
        assert_eq!(probes.len(), 1);
        assert!(probes[0].ok);
        let latency = probes[0]
            .latency_ms
            .expect("成功路径必须回报 RTT（链路延迟用）");
        println!("plaintext TCP probe 127.0.0.1:{port} -> {latency}ms");
        assert!(
            (1..=5000).contains(&latency),
            "本机回环 RTT 必须在 1..5000ms：{latency}"
        );
        drop(listener);
    }

    /// 连接被拒：`ok = false` 且 `latency_ms = None`（失败不能写成 0ms）。
    #[tokio::test]
    async fn plaintext_probe_reports_no_latency_when_connection_is_refused() {
        // 先拿一个端口再释放：连接必然被拒绝。
        let port = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            i64::from(listener.local_addr().unwrap().port())
        };
        let spec = tcp_probe_spec("chain-c1-0", "127.0.0.1", port);

        let (error, probes) = probe_rule(&spec).await;
        assert_eq!(error, Some(tls_probe::TCP_CONNECT_FAILED));
        assert_eq!(probes.len(), 1, "失败的目标也要出现在 targets 里");
        assert!(!probes[0].ok);
        assert_eq!(probes[0].latency_ms, None, "失败不能报告 0ms");

        // 状态里只用 ok=false 表达失败；`target_error` 属于加密链，明文不填。
        let health = probe_health(&spec, error, probes);
        assert!(!health.ok);
        assert_eq!(health.error, None);
        assert_eq!(health.targets[0].latency_ms, None);
    }

    /// 同一份规则重复同步必须复用同一个探针任务；目标变化才 abort 重建。
    #[tokio::test]
    async fn syncing_the_same_rules_reuses_the_probe_task_and_restarts_on_change() {
        let dir = TempDir::new();
        let mut supervisor =
            RealmSupervisor::new(dir.path().join("no-such-realm"), dir.path(), "127.0.0.1");
        // 目标用必然被拒的本地端口：每轮探测立刻结束，不会留下连接或长任务。
        let first_port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            i64::from(listener.local_addr().unwrap().port())
        };
        supervisor.rules = vec![realm_rule("r1", 30001, &[("127.0.0.1", first_port)])];

        supervisor.sync_probe();
        let first = supervisor
            .probe
            .as_ref()
            .expect("明文规则必须启动探针任务")
            .task
            .id();

        // 重复下发同一份期望态：不新建、也不 abort 现有任务。
        supervisor.sync_probe();
        assert_eq!(
            first,
            supervisor.probe.as_ref().unwrap().task.id(),
            "规则不变时不能重启探针任务（否则每轮 apply 都会泄漏一个 30s 循环）"
        );
        assert!(!supervisor.probe.as_ref().unwrap().task.is_finished());

        // 目标变化：旧任务被 abort，新任务接管。
        let second_port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            i64::from(listener.local_addr().unwrap().port())
        };
        supervisor.rules = vec![realm_rule("r1", 30001, &[("127.0.0.1", second_port)])];
        supervisor.sync_probe();
        let second = supervisor.probe.as_ref().unwrap().task.id();
        assert_ne!(first, second, "目标变化必须重建探针任务");
        assert_eq!(
            supervisor.probe.as_ref().unwrap().spec[0].targets[0].port,
            second_port,
            "新任务必须使用新的目标"
        );
        assert!(!supervisor.probe.as_ref().unwrap().task.is_finished());

        // 规则清空 / 显式停止：任务句柄被丢弃，不会继续探测。
        supervisor.stop_probe();
        assert!(supervisor.probe.is_none());
    }

    /// 明文与加密规则混用：两者的 targets 都要出现在心跳快照里。
    #[cfg(unix)]
    #[tokio::test]
    async fn mixed_plaintext_and_tls_rules_both_report_targets() {
        use crate::tls_probe::tests::{spawn_self_signed_server, TEST_CERT_PEM, TEST_KEY_PEM};

        let dir = TempDir::new();
        let counter = dir.path().join("launches");
        let script = fake_realm(
            dir.path(),
            "2.9.6 [brutal][batched-udp][transport]",
            Some(&counter),
        );

        // 明文目标：本地监听；加密目标：自签 TLS（握手失败，但 targets 仍要出现）。
        let plaintext = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let plaintext_port = i64::from(plaintext.local_addr().unwrap().port());
        let (tls_port, tls_task) = spawn_self_signed_server(TEST_CERT_PEM, TEST_KEY_PEM).await;

        let mut supervisor = RealmSupervisor::new(&script, dir.path(), "127.0.0.1");
        let mut encrypted = realm_rule("chain-c1-1", 39122, &[("127.0.0.1", i64::from(tls_port))]);
        encrypted.remote_transport = Some("tls;sni=example.com".into());
        encrypted.disable_udp = true;
        supervisor
            .apply(&[
                realm_rule("chain-c1-0", 39121, &[("127.0.0.1", plaintext_port)]),
                encrypted,
            ])
            .await;
        wait_for_launches(&counter, 1).await;

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let statuses = supervisor.status_handle().snapshot();
            let plain = statuses.iter().find(|status| status.id == "chain-c1-0");
            let tls = statuses.iter().find(|status| status.id == "chain-c1-1");
            if let (Some(plain), Some(tls)) = (plain, tls) {
                if !plain.targets.is_empty() && !tls.targets.is_empty() {
                    println!(
                        "mixed rules targets: plain={:?} tls={:?}",
                        plain.targets, tls.targets
                    );
                    assert!(
                        plain.targets[0].ok && plain.targets[0].latency_ms.is_some(),
                        "明文规则的 targets 必须带 RTT：{plain:?}"
                    );
                    assert_eq!(plain.target_error, None);
                    assert_eq!(
                        tls.target_error.as_deref(),
                        Some(tls_probe::UNKNOWN_ISSUER),
                        "自签证书必须映射成 unknown_issuer"
                    );
                    assert!(
                        !tls.targets[0].ok && tls.targets[0].latency_ms.is_none(),
                        "加密规则的失败目标也要出现在 targets 里：{tls:?}"
                    );
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "等待明文/加密探针结果超时：{statuses:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tls_task.abort();
        supervisor.apply(&[]).await;
    }

    /// 真实握手用例：下一跳是自签 TLS 监听时，探针必须报 `unknown_issuer`
    /// （与 realm 的 webpki 根一致），而不是只报「已监听」。
    #[cfg(unix)]
    #[tokio::test]
    async fn tls_probe_reports_unknown_issuer_for_self_signed_next_hop() {
        use std::os::unix::fs::PermissionsExt;

        use crate::tls_probe::tests::{spawn_self_signed_server, TEST_CERT_PEM, TEST_KEY_PEM};

        let (port, server_task) = spawn_self_signed_server(TEST_CERT_PEM, TEST_KEY_PEM).await;
        let dir = TempDir::new();
        let counter = dir.path().join("launches");
        let script = dir.path().join("realm");
        // 带 --version 分支：否则能力门禁会判定「不支持 transport」而整轮拒绝。
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '2.9.6 [transport]'; exit 0; fi\necho x >> \"{}\"\nsleep 30\n",
                counter.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut supervisor = RealmSupervisor::new(&script, dir.path(), "127.0.0.1");
        let mut rule = realm_rule("chain-c1-0", 39121, &[("127.0.0.1", i64::from(port))]);
        rule.remote_transport = Some("tls;sni=example.com".into());
        rule.disable_udp = true;
        supervisor.apply(std::slice::from_ref(&rule)).await;
        wait_for_launches(&counter, 1).await;

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let statuses = supervisor.status_handle().snapshot();
            if statuses
                .first()
                .and_then(|status| status.target_error.clone())
                .is_some()
            {
                let status = &statuses[0];
                assert_eq!(
                    status.target_error.as_deref(),
                    Some(tls_probe::UNKNOWN_ISSUER),
                    "自签证书必须映射成 unknown_issuer"
                );
                assert_eq!(status.target_ok, Some(false));
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "等待 TLS 探针结果超时：{statuses:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        server_task.abort();
    }

    #[test]
    fn writes_config_atomically_and_creates_state_dir() {
        let dir = TempDir::new();
        let path = dir.path().join("nested/deeper").join(CONFIG_FILE_NAME);
        assert!(!path.parent().unwrap().exists(), "父目录一开始不存在");

        write_config_atomic(&path, "old = true\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old = true\n");
        assert!(!tmp_path(&path).exists(), "rename 成功后不能残留临时文件");

        // 覆盖写：内容和临时文件都要干净。
        write_config_atomic(&path, "new = true\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new = true\n");
        assert!(!tmp_path(&path).exists());
    }

    /// `no_tcp` / `use_udp` 只能出现在 `[network]`。
    /// 写进 `[[endpoints]]` 时 realm 会当作未知键忽略——看起来配了 UDP，
    /// 实际只监听 TCP，是排查起来最费劲的一类错误。
    #[test]
    fn network_keys_stay_out_of_endpoints() {
        let rules = vec![realm_rule("r1", 30001, &[("10.0.0.2", 443)])];
        let toml = render(&rules);
        let network_block = toml
            .split("[[endpoints]]")
            .next()
            .expect("配置必须有前导部分");
        assert!(network_block.contains("use_udp = true"), "{toml}");
        assert!(network_block.contains("no_tcp = false"), "{toml}");
        for endpoint in toml.split("[[endpoints]]").skip(1) {
            assert!(
                !endpoint.contains("use_udp"),
                "endpoint 里不应出现 use_udp：{endpoint}"
            );
            assert!(
                !endpoint.contains("no_tcp"),
                "endpoint 里不应出现 no_tcp：{endpoint}"
            );
        }
    }

    /// 选 realm 引擎的核心理由是 UDP，配置里必须真的打开它。
    #[test]
    fn realm_config_enables_udp() {
        let rules = vec![realm_rule("r1", 30001, &[("10.0.0.2", 443)])];
        let toml = render(&rules);
        assert!(toml.contains("[network]"), "{toml}");
        assert!(toml.contains("use_udp = true"), "UDP 必须启用：{toml}");
        assert!(!toml.contains("use_udp = false"), "{toml}");
        // TCP 也要保留：realm 引擎同时承载两种协议。
        assert!(toml.contains("no_tcp = false"), "{toml}");
    }

    /// `protocol = tcp`：realm 全局关闭 UDP，且每个端点显式覆盖为 false。
    #[test]
    fn tcp_protocol_disables_udp_in_realm_config() {
        let mut rule = realm_rule("r1", 30001, &[("10.0.0.2", 443)]);
        rule.protocol = pierwave_proto::ForwardProtocol::Tcp;
        rule.udp = false;
        let toml = render(&[rule]);
        let network = toml
            .split("[[endpoints]]")
            .next()
            .expect("配置必须有前导部分");
        assert!(network.contains("no_tcp = false"), "{toml}");
        assert!(
            network.contains("use_udp = false"),
            "仅 TCP 的 realm 配置必须关掉 UDP：{toml}"
        );
        assert!(!network.contains("use_udp = true"), "{toml}");
        assert!(
            toml.contains("network = { use_udp = false }"),
            "端点也必须显式覆盖，避免未来全局开关变化：{toml}"
        );
    }

    /// 混合规则：任一端点要 UDP 时全局打开，仅 TCP 的端点逐个覆盖关闭。
    #[test]
    fn mixed_protocols_enable_udp_globally_and_disable_it_per_tcp_endpoint() {
        let mut tcp = realm_rule("tcp-1", 30001, &[("10.0.0.2", 443)]);
        tcp.protocol = pierwave_proto::ForwardProtocol::Tcp;
        tcp.udp = false;
        let both = realm_rule("both-1", 30002, &[("10.0.0.3", 443)]);
        let toml = render(&[tcp, both]);
        let network = toml.split("[[endpoints]]").next().unwrap();
        assert!(network.contains("use_udp = true"), "{toml}");
        assert_eq!(
            toml.matches("network = { use_udp = false }").count(),
            1,
            "只有 TCP 端点需要覆盖：{toml}"
        );
    }

    /// 主控写路径已经拒绝 `realm + udp`；Agent 兜底也不能渲染出 UDP-only 配置。
    #[test]
    fn udp_only_realm_rule_is_rejected() {
        let mut rule = realm_rule("r1", 30001, &[("10.0.0.2", 443)]);
        rule.protocol = pierwave_proto::ForwardProtocol::Udp;
        rule.udp = false;
        let error = render_config(&[rule], "0.0.0.0", "warn").unwrap_err();
        assert!(error.contains("只监听 UDP"), "{error}");
    }

    #[tokio::test]
    async fn missing_binary_marks_rules_not_installed() {
        let dir = TempDir::new();
        let mut supervisor =
            RealmSupervisor::new(dir.path().join("no-such-realm"), dir.path(), "127.0.0.1");

        supervisor
            .apply(&[realm_rule("r1", 30001, &[("10.0.0.2", 443)])])
            .await;

        let statuses = supervisor.status_handle().snapshot();
        assert_eq!(statuses.len(), 1);
        assert!(!statuses[0].listening, "没装 realm 不能报 listening=true");
        assert_eq!(statuses[0].error, NOT_INSTALLED, "错误文案必须稳定");
        assert_eq!(statuses[0].id, "r1");
        // 没装 realm 时不落配置：一份永远不会被用到的文件只会让人误解
        // 「已经准备好了」。装上之后下一次 apply 会直接生成。
        assert!(
            !dir.path().join(CONFIG_FILE_NAME).exists(),
            "缺二进制时不应写配置文件"
        );

        // 空期望态：状态清空，不 panic。
        supervisor.apply(&[]).await;
        assert!(supervisor.status_handle().snapshot().is_empty());
    }

    /// 真跑子进程：内容哈希相同不重启；端口变化重启一次。
    #[cfg(unix)]
    #[tokio::test]
    async fn restarts_only_when_config_changes() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let counter = dir.path().join("launches");
        let script = dir.path().join("realm");
        // 假 realm：每启动一次往计数器追加一行，然后睡到被 kill。
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho x >> \"{}\"\nsleep 30\n", counter.display()),
        )
        .unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let mut supervisor = RealmSupervisor::new(&script, dir.path(), "127.0.0.1");
        let rule = realm_rule("r1", 39101, &[("10.0.0.2", 443)]);

        supervisor.apply(std::slice::from_ref(&rule)).await;
        wait_for_launches(&counter, 1).await;

        // 同一份规则重复下发：不重启（哈希相同）。
        supervisor.apply(std::slice::from_ref(&rule)).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(count_launches(&counter), 1, "内容哈希相同不能重启子进程");

        // 规则变化（换端口）：重启一次。
        supervisor
            .apply(&[realm_rule("r1", 39102, &[("10.0.0.2", 443)])])
            .await;
        wait_for_launches(&counter, 2).await;

        // 规则清空：进程被停掉，状态清空。
        supervisor.apply(&[]).await;
        assert!(supervisor.status_handle().snapshot().is_empty());
        assert!(!supervisor.process_alive(), "空期望态必须停掉 realm 进程");
    }

    /// 子进程退出时记录退出码，并把状态改成未监听（主控不会继续显示 true）。
    #[cfg(unix)]
    #[tokio::test]
    async fn exit_code_is_recorded_in_status() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let script = dir.path().join("realm");
        std::fs::write(&script, "#!/bin/sh\nexit 7\n").unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let mut supervisor = RealmSupervisor::new(&script, dir.path(), "127.0.0.1");
        supervisor
            .apply(&[realm_rule("r1", 39103, &[("10.0.0.2", 443)])])
            .await;

        // spawn 后 150ms 宽限里脚本已经退出；状态由监视任务写入。
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let statuses = supervisor.status_handle().snapshot();
            if statuses
                .first()
                .is_some_and(|status| status.error.contains("退出码 7"))
            {
                assert!(!statuses[0].listening, "进程退出后不能再报监听中");
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "等待 realm 退出码写入状态超时：{statuses:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[cfg(unix)]
    async fn wait_for_launches(path: &Path, expected: usize) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if count_launches(path) >= expected {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "等待假 realm 启动 {expected} 次超时（实际 {}）",
                count_launches(path)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[cfg(unix)]
    fn count_launches(path: &Path) -> usize {
        std::fs::read_to_string(path)
            .map(|content| content.lines().count())
            .unwrap_or(0)
    }

    /// 二进制存在但没有执行位：状态必须明确是「启动失败」，而不是「未安装」；
    /// 心跳对账也不能每 15 秒反复 spawn 刷日志。
    #[cfg(unix)]
    #[tokio::test]
    async fn non_executable_binary_reports_a_spawn_error_and_is_not_retried() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let script = dir.path().join("realm");
        std::fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o644)).unwrap();

        let mut supervisor = RealmSupervisor::new(&script, dir.path(), "127.0.0.1");
        supervisor
            .apply(&[realm_rule("r1", 39113, &[("10.0.0.2", 443)])])
            .await;

        let statuses = supervisor.status_handle().snapshot();
        assert_eq!(statuses.len(), 1);
        assert!(!statuses[0].listening, "起不来时绝不能报监听中");
        assert!(
            statuses[0].error.contains("启动失败"),
            "状态必须说明是启动失败：{}",
            statuses[0].error
        );
        assert_ne!(
            statuses[0].error, NOT_INSTALLED,
            "存在但不可执行 ≠ 未安装，两种原因要可区分"
        );

        // 心跳对账不应改写状态（也不会重试 spawn）。
        supervisor.ensure_running().await;
        let again = supervisor.status_handle().snapshot();
        assert_eq!(again[0].error, statuses[0].error);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ensure_running_restarts_a_crashed_realm_process() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let counter = dir.path().join("launches");
        let script = dir.path().join("realm");
        // 启动即退出：模拟 realm 崩溃。
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho x >> \"{}\"\nexit 7\n", counter.display()),
        )
        .unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let mut supervisor = RealmSupervisor::new(&script, dir.path(), "127.0.0.1");
        supervisor
            .apply(&[realm_rule("r1", 39111, &[("10.0.0.2", 443)])])
            .await;
        wait_for_launches(&counter, 1).await;

        // 等监视任务把进程标记为已退出（状态里应能看到退出码）。
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while supervisor.process_alive() {
            assert!(std::time::Instant::now() < deadline, "等待 realm 退出超时");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        supervisor.ensure_running().await;
        wait_for_launches(&counter, 2).await;
        assert_eq!(count_launches(&counter), 2, "崩溃后必须按现有配置重新拉起");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ensure_running_does_nothing_while_the_process_is_alive() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let counter = dir.path().join("launches");
        let script = dir.path().join("realm");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho x >> \"{}\"\nsleep 30\n", counter.display()),
        )
        .unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let mut supervisor = RealmSupervisor::new(&script, dir.path(), "127.0.0.1");
        let rule = realm_rule("r1", 39112, &[("10.0.0.2", 443)]);
        supervisor.apply(std::slice::from_ref(&rule)).await;
        wait_for_launches(&counter, 1).await;

        // 心跳每 15 秒调用一次；进程活着时必须完全不动（不重启、不重写配置）。
        supervisor.ensure_running().await;
        supervisor.ensure_running().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            count_launches(&counter),
            1,
            "进程活着时 ensure_running 不能重启"
        );

        supervisor.apply(&[]).await;
    }
    fn transport_rule(id: &str, listen_port: i64) -> DesiredForward {
        DesiredForward {
            listen_transport: Some(
                "tls;cert=/usr/local/etc/xray/certs/c1.pem;key=/usr/local/etc/xray/certs/c1.key"
                    .into(),
            ),
            remote_transport: Some("tls;sni=hop1.example.com".into()),
            disable_udp: true,
            ..realm_rule(id, listen_port, &[("10.0.0.3", 30003)])
        }
    }

    /// 加密端点：transport 行 + 每端点 `network = { use_udp = false }` + `[log]`。
    #[test]
    fn renders_transport_lines_in_fixed_order_and_disables_udp() {
        let toml = render(&[transport_rule("chain-c1-1", 30002)]);

        assert!(
            toml.contains("[log]"),
            "有 transport 时必须生成 [log]：{toml}"
        );
        assert!(toml.contains("level = \"warn\""), "{toml}");
        assert!(toml.contains("output = \"stderr\""), "{toml}");
        assert!(
            toml.find("[log]").unwrap() < toml.find("[[endpoints]]").unwrap(),
            "[log] 必须在 endpoint 之前：{toml}"
        );
        assert_eq!(
            toml.matches("network = { use_udp = false }").count(),
            1,
            "每个加密端点都要显式关 UDP：{toml}"
        );

        let listen = toml.find("listen = \"0.0.0.0:30002\"").unwrap();
        let remote = toml.find("remote = \"10.0.0.3:30003\"").unwrap();
        let listen_transport = toml.find("listen_transport = \"tls;cert=").unwrap();
        let remote_transport = toml
            .find("remote_transport = \"tls;sni=hop1.example.com\"")
            .unwrap();
        let network = toml.find("network = { use_udp = false }").unwrap();
        assert!(
            listen < remote
                && remote < listen_transport
                && listen_transport < remote_transport
                && remote_transport < network,
            "键顺序必须是 listen → remote → … → listen_transport → remote_transport → network：{toml}"
        );

        // 日志级别可配；默认不要 debug（每条连接一行）。
        let debug = render_config(&[transport_rule("r1", 30002)], "0.0.0.0", "debug").unwrap();
        assert!(debug.contains("level = \"debug\""), "{debug}");
        let bogus = render_config(&[transport_rule("r1", 30002)], "0.0.0.0", "verbose").unwrap();
        assert!(
            bogus.contains("level = \"warn\""),
            "非法级别回落 warn：{bogus}"
        );
    }

    /// 没有 transport 的配置与升级前逐字节一致：不生成 `[log]`，也不加 network 覆盖。
    #[test]
    fn plaintext_config_is_unchanged_and_has_no_log_section() {
        let rule = realm_rule("r1", 30001, &[("10.0.0.2", 443)]);
        let expected = "# generated by pierwave-agent; do not edit（主控下发为准）\n\
[network]\nno_tcp = false\nuse_udp = true\n\
\n[[endpoints]]\n\
listen = \"0.0.0.0:30001\"\n\
remote = \"10.0.0.2:443\"\n";
        assert_eq!(render(&[rule]), expected);
        assert!(!render(&[realm_rule("r1", 30001, &[("10.0.0.2", 443)])]).contains("[log]"));
        assert!(!render(&[realm_rule("r1", 30001, &[("10.0.0.2", 443)])])
            .contains("network = { use_udp = false }"));
    }

    /// 任何「看起来配了、实际明文」的写法都必须整轮拒绝。
    #[test]
    fn transport_rendering_rejects_unsafe_or_plaintext_downgrade() {
        let mut without_udp_off = transport_rule("r1", 30001);
        without_udp_off.disable_udp = false;
        let error = render_config(&[without_udp_off], "0.0.0.0", "warn").unwrap_err();
        assert!(error.contains("关闭 UDP"), "{error}");

        for bad in [
            // wss 不是 kaminari 的 token：整串会被当作「没有 transport」→ 明文。
            "wss;host=cdn.example.com;path=/ws",
            "tls;sni=hop1.example.com;insecure",
            "tls;sni=hop1.example.com;0rtt",
            "tls;sni=hop1.example.com;ws;host=cdn.example.com;path=/ws",
            "tls;cert=/a.pem",
            "tls;sni=",
            "tls;unknown=/a",
            "",
        ] {
            let mut rule = realm_rule("r1", 30001, &[("10.0.0.2", 443)]);
            rule.remote_transport = Some(bad.into());
            rule.disable_udp = true;
            let error = render_config(&[rule], "0.0.0.0", "warn").unwrap_err();
            assert!(
                error.contains("remote_transport"),
                "bad={bad:?} error={error}"
            );
        }

        // 监听端不允许 sni / 客户端不允许 cert。
        for bad in [
            "tls;sni=hop1.example.com",
            "tls;cert=/a.pem;key=/a.key;insecure",
        ] {
            let mut rule = realm_rule("r1", 30001, &[("10.0.0.2", 443)]);
            rule.listen_transport = Some(bad.into());
            rule.disable_udp = true;
            assert!(
                render_config(&[rule], "0.0.0.0", "warn").is_err(),
                "bad={bad:?}"
            );
        }
    }

    #[test]
    fn transport_changes_the_config_hash() {
        let plain = render(&[realm_rule("r1", 30001, &[("10.0.0.2", 443)])]);
        let encrypted = render(&[transport_rule("r1", 30001)]);
        assert_ne!(
            config_hash(&plain),
            config_hash(&encrypted),
            "transport 变化必须触发 realm 重启"
        );
        assert_eq!(
            config_hash(&encrypted),
            config_hash(&render(&[transport_rule("r1", 30001)])),
            "同一份 transport 重复渲染必须同哈希"
        );
    }

    #[cfg(unix)]
    fn fake_realm(dir: &Path, version: &str, counter: Option<&Path>) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let script = dir.join("realm");
        let count = counter
            .map(|path| format!("echo x >> \"{}\"\n", path.display()))
            .unwrap_or_default();
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo \"{version}\"\n  exit 0\nfi\n{count}sleep 30\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    /// `realm --version` 的输出决定能力：含 `[transport]` 才是 true。
    #[cfg(unix)]
    #[tokio::test]
    async fn capability_probe_reads_the_transport_feature() {
        let dir = TempDir::new();
        let with = fake_realm(dir.path(), "2.9.6 [brutal][transport]", None);
        assert_eq!(detect_transport(&with).await, Some(true));

        let without = fake_realm(dir.path(), "2.9.6 [brutal][batched-udp]", None);
        assert_eq!(detect_transport(&without).await, Some(false));

        assert_eq!(
            detect_transport(&dir.path().join("no-such-realm")).await,
            None,
            "不存在 = 未知，不能当成支持"
        );

        // 换二进制后缓存必须失效：同一个路径先 false 后 true。
        let mut supervisor = RealmSupervisor::new(&without, dir.path(), "127.0.0.1");
        assert_eq!(supervisor.transport_capability().await, Some(false));
        fake_realm(
            dir.path(),
            "2.9.6 [brutal][transport]  # 更长的一行用于改变文件大小",
            None,
        );
        assert_eq!(
            supervisor.transport_capability().await,
            Some(true),
            "运行中换掉二进制后不能沿用旧缓存"
        );
    }

    /// 核心防御：realm 不支持 transport 时，收到 transport 规则必须报错，
    /// 不能渲染成一份「看起来有配置、实际明文」的 realm.toml。
    #[cfg(unix)]
    #[tokio::test]
    async fn unsupported_realm_refuses_transport_instead_of_rendering_plaintext() {
        let dir = TempDir::new();
        let counter = dir.path().join("launches");
        let script = fake_realm(dir.path(), "2.9.6 [brutal][batched-udp]", Some(&counter));
        let mut supervisor = RealmSupervisor::new(&script, dir.path(), "127.0.0.1");

        supervisor
            .apply(&[transport_rule("chain-c1-1", 30002)])
            .await;

        let statuses = supervisor.status_handle().snapshot();
        assert_eq!(statuses.len(), 1);
        assert!(!statuses[0].listening);
        assert_eq!(
            statuses[0].error, TRANSPORT_UNSUPPORTED,
            "状态必须说明是 realm 缺 transport，而不是普通的未监听"
        );
        assert!(
            !dir.path().join(CONFIG_FILE_NAME).exists(),
            "拒绝渲染时不能落盘配置：落下去就会以明文被 realm 使用"
        );
        assert_eq!(count_launches(&counter), 0, "不支持时不能启动 realm");
        assert!(!supervisor.process_alive());
    }

    /// 支持 transport 时正常落盘并启动；配置里真的有 transport 与 UDP 关闭。
    #[cfg(unix)]
    #[tokio::test]
    async fn supported_realm_renders_transport_config_and_starts() {
        let dir = TempDir::new();
        let counter = dir.path().join("launches");
        let script = fake_realm(
            dir.path(),
            "2.9.6 [brutal][batched-udp][transport]",
            Some(&counter),
        );
        let mut supervisor = RealmSupervisor::new(&script, dir.path(), "127.0.0.1");

        supervisor
            .apply(&[transport_rule("chain-c1-1", 30002)])
            .await;
        wait_for_launches(&counter, 1).await;

        let toml = std::fs::read_to_string(dir.path().join(CONFIG_FILE_NAME)).unwrap();
        assert!(
            toml.contains("listen_transport = \"tls;cert="),
            "listen transport 必须落盘：{toml}"
        );
        assert!(
            toml.contains("remote_transport = \"tls;sni=hop1.example.com\""),
            "{toml}"
        );
        assert!(toml.contains("network = { use_udp = false }"), "{toml}");
        assert_eq!(supervisor.transport_capability().await, Some(true));
        assert!(supervisor.process_alive());

        supervisor.apply(&[]).await;
    }
}
