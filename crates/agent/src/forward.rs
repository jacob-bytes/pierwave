//! 单跳 TCP 端口转发的收敛器。
//!
//! 主控在期望态里下发 [`DesiredForward`]，本模块负责让实际监听集合收敛到这份列表：
//!
//! - 新增 → 绑定监听并 spawn accept 循环；
//! - 删除 → 通知 accept 循环退出，并等它真正释放端口；
//! - 端口或目标变化 → 先关旧监听、再绑新监听（否则同端口换目标会自己撞自己）；
//! - 幂等 → 同一份列表重复下发只做 diff，不重建任何监听。
//!
//! `udp = true` 的规则在同一个端口号上**额外**绑一个 UDP socket（[`crate::udp`]），
//! TCP 监听照旧；`udp = false`（含旧主控不下发该字段）完全不碰 UDP，行为与升级前一致。
//!
//! 单条规则失败只写进它自己的 [`ForwardStatus`]，不影响其它规则：
//! 绑定失败（端口被占用）上报 `listening=false` + 原因；目标不可达时
//! 只关闭这条客户端连接、计数并打日志，绝不 panic。

use std::collections::{HashMap, HashSet};
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pierwave_proto::{DesiredForward, ForwardStatus, ForwardStrategy, ForwardTarget};
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::selector::{Selector, TargetHealth};
use crate::udp;

/// 连接目标的上限；超时按「目标不可达」处理，避免客户端永久挂起。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 关闭监听时等待 accept 循环退出的上限，超时就强制中止任务。
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
/// accept 出错（例如 fd 耗尽）后的退避，避免空转烧 CPU。
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
/// `forward_bind` 留空时的兜底值，与配置默认值保持一致。
const DEFAULT_BIND_HOST: &str = "0.0.0.0";
/// 目标可达性探测周期。与主控「连续 2 次失败」的判定配合，约 1 分钟内可见降级。
const TARGET_PROBE_INTERVAL: Duration = Duration::from_secs(30);
/// 单次目标探测预算；目标黑洞时不能拖住下一轮心跳。
const TARGET_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// 心跳可无锁读取的监听状态快照。
///
/// 心跳线程只 clone 这个 `Arc`，不碰 supervisor 本体，因此收敛期间
/// （关闭旧监听最多等 [`SHUTDOWN_TIMEOUT`]）心跳不会被锁住。
///
/// 目标健康按「规则 + 候选目标」逐条存在 map 里：探测任务每 30 秒写一次，
/// 连接失败时也会立即补测被选中的那个目标。心跳读取时把逐目标结果聚合成
/// 整体 `target_ok`。这样监听状态（端口绑定）和目标可达性互不覆盖。
#[derive(Debug, Clone, Default)]
pub struct ForwardStatusHandle {
    inner: Arc<Mutex<StatusState>>,
}

#[derive(Debug, Default)]
struct StatusState {
    statuses: Vec<ForwardStatus>,
    /// 规则 id → 每个候选目标的探测结果，顺序与规则里的 `targets` 一致。
    /// `None` = 这一轮还没测过（启动瞬间按健康处理，避免无谓断流）。
    target_health: HashMap<String, Vec<Option<TargetHealth>>>,
}

impl ForwardStatusHandle {
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
                // `ForwardStatus` 只有一个整体 `target_ok`：主控只关心
                // 「这条规则现在还有没有可用的成员」，不逐个回报。
                status.target_ok = state
                    .target_health
                    .get(&status.id)
                    .and_then(|health| overall_target_ok(health));
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
        // 已经不在期望态里的规则不能留下探测缓存。
        state.target_health.retain(|id, _| ids.contains(id));
    }

    /// 新规则接管监听前先建好逐目标槽位（全部 `None` = 尚未探测）。
    fn init_target_health(&self, id: &str, targets: usize) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .target_health
            .insert(id.to_string(), vec![None; targets]);
    }

    fn set_target_health(&self, id: &str, index: usize, health: TargetHealth) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(slot) = state
            .target_health
            .get_mut(id)
            .and_then(|targets| targets.get_mut(index))
        {
            *slot = Some(health);
        }
    }

    /// 供选路使用的健康快照；未探测过的目标按健康处理。
    fn healthy_targets(&self, id: &str) -> Vec<TargetHealth> {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .target_health
            .get(id)
            .map(|targets| {
                targets
                    .iter()
                    .map(|health| health.unwrap_or_else(TargetHealth::up))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn clear_target_health(&self, id: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .target_health
            .remove(id);
    }

    /// 测试辅助：读逐目标原始探测结果（`None` = 尚未探测）。
    #[cfg(test)]
    fn target_health_snapshot(&self, id: &str) -> Vec<Option<TargetHealth>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .target_health
            .get(id)
            .cloned()
            .unwrap_or_default()
    }
}

/// 整体 `target_ok`：是否存在任一健康目标。
///
/// 尚未探测的目标按健康处理——否则规则刚启动的那一瞬间会被报成全体不可用，
/// 主控可能据此误判。至少探测过一个目标后，就按已知结果聚合；还没测到的
/// 成员依旧默认健康，避免探测逐个完成的过程中状态抖动。
fn overall_target_ok(health: &[Option<TargetHealth>]) -> Option<bool> {
    if health.iter().all(Option::is_none) {
        return None;
    }
    Some(
        health
            .iter()
            .any(|entry| entry.is_none_or(|health| health.healthy)),
    )
}

/// 一条规则在 accept 循环、连接 task、探测循环之间共享的运行时上下文。
///
/// `selector` 是这条规则自己的（不是全局的）：游标必须跨连接保留，
/// 同时规则重建时随旧 `RunningForward` 一起丢弃，不会把旧目标的轮询相位
/// 带到新目标列表上。
#[derive(Clone)]
struct ForwardRuntime {
    id: String,
    /// 候选目标；`targets` 为空时这里已经归一化成单个兼容目标。
    targets: Arc<[ForwardTarget]>,
    /// 规则来自旧主控的单目标格式（`targets` 为空）。
    ///
    /// 单目标不做健康门控：旧版总是尝试连接 `target_host:target_port`，
    /// 目标探测只用于心跳上报。这样升级 Agent 不会改变旧规则的行为
    /// （例如目标短暂不可达时，连接仍按原来的方式尝试/超时）。
    legacy_single: bool,
    /// 这条规则同时监听 UDP。UDP 规则不做 TCP 目标探测，TCP 连接也不做健康门控。
    udp: bool,
    strategy: ForwardStrategy,
    selector: Arc<Mutex<Selector>>,
    status: ForwardStatusHandle,
    /// 连接失败时把目标下标丢给探测循环，立即补测这一个目标。
    probe_requests: mpsc::UnboundedSender<usize>,
    /// 连接目标失败 / 转发中断的累计次数。
    connect_failures: Arc<AtomicU64>,
}

/// 正在运行的一条转发。
struct RunningForward {
    spec: DesiredForward,
    /// `Some` 时用来通知 accept 循环优雅退出；`None` 表示已经通知过。
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
    /// `udp = true` 时的 UDP 转发；`None` = 这条规则只监听 TCP。
    udp: Option<udp::UdpForward>,
    /// 目标可达性探测循环；规则变化/删除时 abort。UDP 规则不做 TCP 探测，所以是 `Option`。
    health_task: Option<JoinHandle<()>>,
    /// 供测试断言「重复下发没有重建监听」。
    started_at: Instant,
    runtime: ForwardRuntime,
    /// 实际绑定的端口。规则写 `listen_port = 0` 时由内核分配，这里读回；
    /// 只切换 `udp` 位时要用它把 UDP socket 绑到同一个端口号上。
    bound_port: u16,
}

impl RunningForward {
    /// 通知 accept 循环退出，并等它 drop 掉 listener（端口真正释放）。
    async fn close(mut self, id: &str) {
        // 先停探测：规则已不在期望态，再写 target_ok 也没有意义。
        if let Some(health_task) = self.health_task.take() {
            health_task.abort();
        }
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if timeout(SHUTDOWN_TIMEOUT, &mut self.task).await.is_err() {
            // 理论上不会发生：accept 循环只 select 一个 oneshot。
            // 真卡住了也必须让端口尽快释放，否则下次同端口绑定会失败。
            tracing::warn!(%id, "转发监听关闭超时，强制中止任务");
            self.task.abort();
            let _ = self.task.await;
        }
        // UDP 端口与 TCP 端口是两套空间，都要真正释放，否则同端口改配置会撞自己。
        if let Some(udp) = self.udp.take() {
            udp.close().await;
        }
        tracing::info!(
            %id,
            uptime_secs = self.started_at.elapsed().as_secs(),
            failures = self.runtime.connect_failures.load(Ordering::Relaxed),
            "转发监听已停止"
        );
    }
}

/// 端口转发的收敛器。
///
/// 生命周期跨 websocket 重连保留：断线不影响已经在跑的监听，
/// 重连后主控重放同一份期望态时这里只做一次空 diff。
pub struct ForwardSupervisor {
    /// 监听地址（配置项 `forward_bind`，默认 `0.0.0.0`）。
    bind_host: String,
    running: HashMap<String, RunningForward>,
    /// 绑定失败的规则：id → 原因。保留到下次 `apply` 重试绑定。
    failed: HashMap<String, String>,
    /// 只切换 `udp` 位时 UDP 绑定失败的原因（TCP 仍在监听）。
    ///
    /// 与 `failed` 分开：`failed` 表示整条规则没起来；这里表示 TCP 已经可用、
    /// 但 UDP 那一半没绑上，状态必须如实报 `listening=false`，下一轮继续重试。
    udp_failures: HashMap<String, String>,
    /// 最近一次期望列表的顺序，保证心跳里的状态顺序稳定。
    order: Vec<String>,
    status: ForwardStatusHandle,
}

impl ForwardSupervisor {
    pub fn new(bind_host: impl Into<String>) -> Self {
        let bind_host = bind_host.into();
        let bind_host = if bind_host.trim().is_empty() {
            DEFAULT_BIND_HOST.to_string()
        } else {
            bind_host
        };
        Self {
            bind_host,
            running: HashMap::new(),
            failed: HashMap::new(),
            udp_failures: HashMap::new(),
            order: Vec::new(),
            status: ForwardStatusHandle::default(),
        }
    }

    /// 心跳侧读状态用；clone 出来的句柄可以脱离 supervisor 借用。
    pub fn status_handle(&self) -> ForwardStatusHandle {
        self.status.clone()
    }

    /// 测试辅助：读回内核实际分配的监听端口（规则里 `listen_port = 0` 时用）。
    #[cfg(test)]
    pub(crate) fn bound_port(&self, id: &str) -> Option<u16> {
        self.running.get(id).map(|running| running.bound_port)
    }

    /// 收敛到期望列表。空列表 = 关闭所有监听。
    ///
    /// 幂等：同样的列表重复调用不会重建监听；但绑定失败的规则会在每次
    /// `apply` 时重试一次——端口被释放后，下一次期望态重放就能自动恢复。
    pub async fn apply(&mut self, desired: &[DesiredForward]) {
        // 期望列表按 id 去重（id 是主控侧的主键），保留第一条与原始顺序。
        let mut wanted: Vec<&DesiredForward> = Vec::with_capacity(desired.len());
        let mut seen: HashSet<&str> = HashSet::new();
        for spec in desired {
            if !seen.insert(spec.id.as_str()) {
                tracing::warn!(id = %spec.id, "期望态里有重复的转发 id，忽略后一条");
                continue;
            }
            wanted.push(spec);
        }

        // 1a. 只切换 `udp` 位：TCP 监听保持不动，只增删 UDP 那一半。
        //     已验收的 TCP 服务不能因为补一个 UDP 监听就短暂拒绝新连接。
        let bind_host = self.bind_host.clone();
        let mut udp_retry_failed: Vec<(String, String)> = Vec::new();
        for spec in wanted.iter().copied() {
            let Some(running) = self.running.get_mut(&spec.id) else {
                continue;
            };
            if !differs_only_in_udp(&running.spec, spec) {
                continue;
            }
            if spec.udp {
                if running.udp.is_some() {
                    running.spec.udp = true;
                    self.udp_failures.remove(&spec.id);
                    continue;
                }
                // UDP 规则不做 TCP 目标探测：TCP 握手证明不了 UDP 可达。
                // 把旧的探测任务与结果清掉，避免心跳拿一个过期结论冒充 target_ok。
                if let Some(health_task) = running.health_task.take() {
                    health_task.abort();
                    // 等它真正停下再清结果，否则刚清完又可能被写回一个探测值。
                    let _ = health_task.await;
                }
                self.status.clear_target_health(&spec.id);
                let port = running.bound_port;
                let targets = running.runtime.targets.clone();
                let failures = running.runtime.connect_failures.clone();
                match udp::start(spec.id.clone(), &bind_host, port, targets, failures).await {
                    Ok(forward) => {
                        running.udp = Some(forward);
                        running.spec.udp = true;
                        self.udp_failures.remove(&spec.id);
                        tracing::info!(id = %spec.id, port, "补上 UDP 监听（TCP 未中断）");
                    }
                    Err(error) => {
                        udp_retry_failed.push((
                            spec.id.clone(),
                            format!("UDP 监听 {bind_host}:{port} 失败: {error}"),
                        ));
                    }
                }
            } else {
                if let Some(udp) = running.udp.take() {
                    udp.close().await;
                }
                running.spec.udp = false;
                self.udp_failures.remove(&spec.id);
                tracing::info!(id = %spec.id, "关闭 UDP 监听（TCP 未中断）");
            }
        }
        for (id, reason) in udp_retry_failed {
            tracing::warn!(%id, %reason, "UDP 监听绑定失败，TCP 继续监听");
            self.udp_failures.insert(id, reason);
        }

        // 1b. 再关掉「已删除」和「参数已变化」的监听。
        //     顺序很重要：同一端口换目标时，旧监听不先释放会让新绑定 EADDRINUSE。
        //     只差 udp 位的规则已经在 1a 里就地处理，不能在这里把 TCP 也拆掉。
        let stale: Vec<String> = self
            .running
            .iter()
            .filter(|(id, running)| {
                !wanted.iter().any(|spec| {
                    spec.id == **id
                        && (*spec == &running.spec || differs_only_in_udp(&running.spec, spec))
                })
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(running) = self.running.remove(&id) {
                running.close(&id).await;
            }
            self.status.clear_target_health(&id);
            self.udp_failures.remove(&id);
        }
        // 已经不在期望态里的失败项也清掉，别让心跳一直报旧规则。
        self.failed
            .retain(|id, _| wanted.iter().any(|spec| &spec.id == id));
        self.udp_failures
            .retain(|id, _| wanted.iter().any(|spec| &spec.id == id));

        // 2. 绑定新增 / 变化的监听。失败只记录状态，不影响其它规则。
        for spec in wanted.iter().copied() {
            let unchanged = self
                .running
                .get(&spec.id)
                .is_some_and(|running| running.spec == *spec);
            if unchanged {
                continue;
            }
            // 目标可能变了：旧探测结果不能带过来，等新探测任务写。
            self.status.clear_target_health(&spec.id);
            let listen = format!("{}:{}", self.bind_host, spec.listen_port);
            // `targets` 为空 = 旧主控的单目标兼容格式，归一化成一个成员。
            // 这样 accept 循环只有一条「先选、再连」的路径。
            let legacy_single = spec.targets.is_empty();
            let targets: Arc<[ForwardTarget]> = resolve_targets(spec).into();
            let target_count = targets.len();
            match TcpListener::bind(&listen).await {
                Ok(listener) => {
                    // 规则里写 0 时由内核挑端口；UDP 必须绑同一个端口号，
                    // 所以这里先读回实际端口，而不是直接用 spec.listen_port。
                    let Ok(local_addr) = listener.local_addr() else {
                        tracing::warn!(id = %spec.id, %listen, "转发监听无法读取本地地址");
                        self.failed
                            .insert(spec.id.clone(), format!("监听 {listen} 无法读取本地地址"));
                        continue;
                    };
                    let bound_port = local_addr.port();
                    let failures = Arc::new(AtomicU64::new(0));
                    // `udp = true`：在同一个端口号上再绑一个 UDP socket。
                    // 两种协议是独立的端口空间，同端口可以共存；任一绑定失败都算
                    // 这条规则没起来（listening=false），不会留下「TCP 通了但 UDP 没通」
                    // 这种自相矛盾的状态。
                    let udp_forward = if spec.udp {
                        let udp_listen = format!("{}:{}", self.bind_host, bound_port);
                        match udp::start(
                            spec.id.clone(),
                            &self.bind_host,
                            bound_port,
                            targets.clone(),
                            failures.clone(),
                        )
                        .await
                        {
                            Ok(forward) => Some(forward),
                            Err(error) => {
                                let reason = format!("UDP 监听 {udp_listen} 失败: {error}");
                                tracing::warn!(
                                    id = %spec.id,
                                    listen = %udp_listen,
                                    %error,
                                    "UDP 转发监听绑定失败"
                                );
                                // 释放已经绑上的 TCP 监听，避免占着端口却报失败。
                                drop(listener);
                                self.failed.insert(spec.id.clone(), reason);
                                continue;
                            }
                        }
                    } else {
                        None
                    };
                    let (shutdown_tx, shutdown_rx) = oneshot::channel();
                    // 探测请求：连接失败时 accept 侧只发一个下标，
                    // 由探测循环立即补测该目标（不必等 30 秒周期）。
                    let (probe_tx, probe_rx) = mpsc::unbounded_channel();
                    let runtime = ForwardRuntime {
                        id: spec.id.clone(),
                        targets: targets.clone(),
                        legacy_single,
                        udp: spec.udp,
                        strategy: spec.strategy,
                        selector: Arc::new(Mutex::new(Selector::new())),
                        status: self.status.clone(),
                        probe_requests: probe_tx,
                        connect_failures: failures,
                    };
                    let task = tokio::spawn(accept_loop(runtime.clone(), listener, shutdown_rx));
                    // 监听成功与目标可达是两件事：这里只负责周期探测目标，
                    // 结果写进 status handle，心跳把两者一起带上去。
                    //
                    // UDP 规则不做 TCP 目标探测：TCP 握手证明不了 UDP 可达，
                    // 对「只开 UDP」的目标会报出假降级；`target_ok` 保持 `None`（未知）。
                    let health_task = if spec.udp {
                        None
                    } else {
                        self.status.init_target_health(&spec.id, target_count);
                        Some(tokio::spawn(target_health_loop(
                            spec.id.clone(),
                            targets,
                            self.status.clone(),
                            probe_rx,
                        )))
                    };
                    tracing::info!(
                        id = %spec.id,
                        %listen,
                        target_count,
                        udp = spec.udp,
                        strategy = ?spec.strategy,
                        "转发监听已启动"
                    );
                    self.failed.remove(&spec.id);
                    self.udp_failures.remove(&spec.id);
                    self.running.insert(
                        spec.id.clone(),
                        RunningForward {
                            spec: spec.clone(),
                            shutdown: Some(shutdown_tx),
                            task,
                            udp: udp_forward,
                            health_task,
                            started_at: Instant::now(),
                            runtime,
                            bound_port,
                        },
                    );
                }
                Err(error) => {
                    let reason = format!("监听 {listen} 失败: {error}");
                    tracing::warn!(id = %spec.id, %listen, %error, "转发监听绑定失败");
                    self.failed.insert(spec.id.clone(), reason);
                }
            }
        }

        // 3. 刷新心跳状态快照（顺序 = 期望列表顺序，方便主控按 id 对齐）。
        self.order = wanted.iter().map(|spec| spec.id.clone()).collect();
        self.publish_status();
    }

    fn publish_status(&self) {
        let statuses = self
            .order
            .iter()
            .map(|id| match self.running.get(id) {
                // TCP 在跑、但补 UDP 时绑定失败：如实报 listening=false，
                // 原因里说明是哪一半失败，下一轮 apply 会继续重试。
                Some(_) if self.udp_failures.contains_key(id) => ForwardStatus {
                    id: id.clone(),
                    listening: false,
                    error: self
                        .udp_failures
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| "UDP 监听未启动".into()),
                    target_ok: None,
                },
                Some(_) => ForwardStatus {
                    id: id.clone(),
                    listening: true,
                    error: String::new(),
                    // 探测结果由 status handle 在 snapshot 时叠加。
                    target_ok: None,
                },
                None => ForwardStatus {
                    id: id.clone(),
                    listening: false,
                    // 正常流程里 failed 一定有值；保底也给出非空原因。
                    error: self
                        .failed
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| "监听未启动".into()),
                    target_ok: None,
                },
            })
            .collect();
        self.status.store(statuses);
    }
}

/// 两条规则是否只有 `udp` 位不同。
///
/// 只差这一位时可以就地补/撤 UDP socket，不必拆掉已经验收的 TCP 监听。
fn differs_only_in_udp(current: &DesiredForward, wanted: &DesiredForward) -> bool {
    let mut current = current.clone();
    let mut wanted = wanted.clone();
    current.udp = false;
    wanted.udp = false;
    current == wanted
}

/// 把规则里的候选目标归一化成运行时列表。
///
/// `targets` 非空时直接用（主控的「组」）；为空时退回旧字段
/// `target_host:target_port`，构造一个单成员列表。这样 accept 循环
/// 永远只面对「多目标」一种形态，单目标行为与旧版一致。
fn resolve_targets(spec: &DesiredForward) -> Vec<ForwardTarget> {
    if spec.targets.is_empty() {
        vec![ForwardTarget {
            host: spec.target_host.clone(),
            port: spec.target_port,
            server_id: String::new(),
        }]
    } else {
        spec.targets.clone()
    }
}

/// 探测一个目标，返回 TCP 握手 RTT（毫秒）；失败/超时为 `None`。
async fn probe_target(target_host: &str, target_port: i64) -> Option<u32> {
    let host = target_host.to_string();
    tokio::task::spawn_blocking(move || {
        crate::probe::measure_target(&host, target_port, TARGET_PROBE_TIMEOUT)
    })
    .await
    .ok()
    .flatten()
}

/// 并发探测一条规则的所有目标，逐目标写回状态。
///
/// 复用 `probe::measure_target`（内部就是 `probe::measure` 的 TCP 握手探测）；
/// 失败只写该目标的 `healthy=false`，绝不影响 `listening`——端口绑定是否成功
/// 由 accept 循环单独决定。
async fn probe_targets(id: &str, targets: &[ForwardTarget], status: &ForwardStatusHandle) {
    let measured = futures_util::future::join_all(
        targets
            .iter()
            .map(|target| probe_target(&target.host, target.port)),
    )
    .await;
    let healthy = measured.iter().filter(|latency| latency.is_some()).count();
    for (index, latency) in measured.into_iter().enumerate() {
        status.set_target_health(
            id,
            index,
            TargetHealth {
                healthy: latency.is_some(),
                latency_ms: latency,
            },
        );
    }
    tracing::debug!(%id, total = targets.len(), healthy, "转发目标批量探测完成");
}

/// 周期探测一条转发的**每个**目标，把逐目标结果写进心跳状态句柄。
///
/// 启动时立即测一轮，之后每 [`TARGET_PROBE_INTERVAL`] 一次；同时接收
/// accept 侧发来的补测请求——某条连接选中的目标连不上时，只补测那一个，
/// 让后续选择尽快跳过它。探测失败只写 `healthy=false`，不影响监听。
async fn target_health_loop(
    id: String,
    targets: Arc<[ForwardTarget]>,
    status: ForwardStatusHandle,
    mut probe_requests: mpsc::UnboundedReceiver<usize>,
) {
    probe_targets(&id, &targets, &status).await;
    let mut interval = tokio::time::interval(TARGET_PROBE_INTERVAL);
    // interval 的第一次 tick 立即就绪；上面已经测过一轮，消费掉避免连测两次。
    interval.tick().await;
    loop {
        tokio::select! {
            _ = interval.tick() => probe_targets(&id, &targets, &status).await,
            Some(index) = probe_requests.recv() => {
                let Some(target) = targets.get(index) else { continue };
                let latency = probe_target(&target.host, target.port).await;
                status.set_target_health(
                    &id,
                    index,
                    TargetHealth {
                        healthy: latency.is_some(),
                        latency_ms: latency,
                    },
                );
                tracing::debug!(
                    %id,
                    index,
                    host = %target.host,
                    port = target.port,
                    target_ok = latency.is_some(),
                    "连接失败后立即复测被选中的目标"
                );
            }
        }
    }
}

/// 监听 accept 循环：`shutdown` 一到就退出并 drop listener。
async fn accept_loop(
    runtime: ForwardRuntime,
    listener: TcpListener,
    mut shutdown: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            // 优先处理关闭：删除规则后不要再接受排队中的新连接。
            biased;
            _ = &mut shutdown => {
                tracing::debug!(id = %runtime.id, "转发 accept 循环退出");
                break;
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((client, peer)) => {
                        let runtime = runtime.clone();
                        // 每条连接独立 task：单条失败/卡住不影响 accept 循环。
                        tokio::spawn(async move {
                            handle_connection(runtime, client, peer).await;
                        });
                    }
                    Err(error) => {
                        // accept 失败（EMFILE 等）不能退出监听，否则整条规则假死。
                        tracing::warn!(id = %runtime.id, %error, "转发 accept 失败，稍后重试");
                        tokio::time::sleep(ACCEPT_BACKOFF).await;
                    }
                }
            }
        }
    }
}

/// 一条客户端连接：先按策略 `pick`，再连选中的那个目标。
///
/// 选中目标连接失败时**只关闭本次连接、计数、立即补测**，不回头重试其它
/// 目标：组内成员通常跨机跨地域，逐个重试会把连接延迟成倍放大，而且
/// 失败本身已经说明该成员此刻不可用；交给下一次新连接（探测结果更新后）
/// 重新选路代价更小。
async fn handle_connection(runtime: ForwardRuntime, client: TcpStream, peer: SocketAddr) {
    // 健康快照与选路都在连接开始时取一次：同一连接不会中途换目标。
    // 旧主控的单目标规则不做健康门控，保持升级前的行为：总是尝试连接。
    // UDP 规则同样不做门控：它没有 TCP 探测结果（见 `apply`），而 TCP 只是
    // 顺带监听的那一半，不能因为「没探测过」就把连接全关掉。
    let health = if runtime.legacy_single || runtime.udp {
        vec![TargetHealth::up(); runtime.targets.len()]
    } else {
        runtime.status.healthy_targets(&runtime.id)
    };
    let picked = runtime
        .selector
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .pick(runtime.strategy, peer.ip(), &health);
    let Some(index) = picked else {
        // 没有健康目标：直接关闭客户端（drop 即 FIN/RST），不 panic。
        tracing::debug!(id = %runtime.id, %peer, "没有健康目标，关闭新连接");
        return;
    };
    let Some(target) = runtime.targets.get(index) else {
        // 选择器的下标一定来自 targets；真越界只能记日志并关闭本次连接。
        tracing::error!(id = %runtime.id, index, "选择器返回了越界目标");
        return;
    };
    let target_label = format!("{}:{}", target.host, target.port);
    match proxy(client, &target.host, target.port).await {
        Ok((up, down)) => {
            tracing::debug!(
                id = %runtime.id,
                target = %target_label,
                server_id = %target.server_id,
                %peer,
                up,
                down,
                "转发连接关闭"
            );
        }
        Err(error) => {
            let count = runtime.connect_failures.fetch_add(1, Ordering::Relaxed) + 1;
            // 目标不可达 / 超时 / 半路断开都走这里：只计数 + 日志，
            // 客户端连接随函数返回被关闭；不在这里换目标重试。
            tracing::warn!(
                id = %runtime.id,
                target = %target_label,
                server_id = %target.server_id,
                %peer,
                %error,
                failures = count,
                "转发连接失败"
            );
            // 让探测循环立刻复测这一个目标，下一批连接就能跳过它。
            let _ = runtime.probe_requests.send(index);
        }
    }
}

/// 一条连接：连目标 → 双向拷贝；任一方向结束/出错都由 `copy_bidirectional` 收尾。
async fn proxy(client: TcpStream, target_host: &str, target_port: i64) -> io::Result<(u64, u64)> {
    let mut client = client;
    let port = u16::try_from(target_port).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("目标端口非法: {target_port}"),
        )
    })?;
    // 用 (host, port) 而不是拼字符串：目标写成 IPv6 时不需要手写方括号。
    let mut upstream = match timeout(CONNECT_TIMEOUT, TcpStream::connect((target_host, port))).await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => return Err(error),
        Err(_) => {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("连接目标超时（{}s）", CONNECT_TIMEOUT.as_secs()),
            ))
        }
    };
    copy_bidirectional(&mut client, &mut upstream).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 测试统一用 `listen_port = 0`：让内核在 bind 的同一刻分配端口，
    /// 再通过 `bound_port` 读回来。这样不会出现「先探测空闲端口、释放、
    /// 再绑定」的窗口，多个测试并行跑也不会互相抢端口。
    fn rule(id: &str, listen_port: u16, target: SocketAddr) -> DesiredForward {
        DesiredForward {
            id: id.into(),
            listen_port: i64::from(listen_port),
            target_host: target.ip().to_string(),
            target_port: i64::from(target.port()),
            targets: Vec::new(),
            strategy: Default::default(),
            engine: Default::default(),
            udp: false,
            listen_transport: None,
            remote_transport: None,
            disable_udp: false,
        }
    }

    fn forward_target(addr: SocketAddr) -> ForwardTarget {
        ForwardTarget {
            host: addr.ip().to_string(),
            port: i64::from(addr.port()),
            server_id: format!("srv-{}", addr.port()),
        }
    }

    /// 组规则：候选目标走 `targets`，兼容字段故意留成连不上的 `127.0.0.1:0`，
    /// 这样实现一旦错误地回退到单目标字段，测试会立刻失败。
    fn grouped_rule(
        id: &str,
        listen_port: u16,
        targets: Vec<SocketAddr>,
        strategy: ForwardStrategy,
    ) -> DesiredForward {
        DesiredForward {
            id: id.into(),
            listen_port: i64::from(listen_port),
            target_host: "127.0.0.1".into(),
            target_port: 0,
            targets: targets.into_iter().map(forward_target).collect(),
            strategy,
            engine: Default::default(),
            udp: false,
            listen_transport: None,
            remote_transport: None,
            disable_udp: false,
        }
    }

    /// 同一条规则额外监听 UDP：`udp = true`，其余字段与 [`rule`] 完全一致。
    fn udp_rule(id: &str, listen_port: u16, target: SocketAddr) -> DesiredForward {
        DesiredForward {
            udp: true,
            ..rule(id, listen_port, target)
        }
    }

    /// 本地 echo 服务：先吐一个 tag 字节（方便断言流量去了哪个 upstream），
    /// 然后把收到的字节原样写回。返回地址和 accept 循环句柄，
    /// 测试可以 abort 句柄模拟「目标中途下线」。
    async fn spawn_tagged_echo_with_handle(tag: u8) -> (SocketAddr, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    if stream.write_all(&[tag]).await.is_err() {
                        return;
                    }
                    let mut buf = [0u8; 4096];
                    loop {
                        match stream.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if stream.write_all(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        (addr, handle)
    }

    async fn spawn_tagged_echo(tag: u8) -> SocketAddr {
        spawn_tagged_echo_with_handle(tag).await.0
    }

    /// 连上转发端口，读 tag + 回显，返回 (tag, 回显字节)。
    async fn roundtrip(port: u16, payload: &[u8]) -> (u8, Vec<u8>) {
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut tag = [0u8; 1];
        timeout(Duration::from_secs(2), client.read_exact(&mut tag))
            .await
            .expect("读取 upstream tag 超时")
            .expect("读取 upstream tag 失败");
        client.write_all(payload).await.unwrap();
        let mut echoed = vec![0u8; payload.len()];
        timeout(Duration::from_secs(2), client.read_exact(&mut echoed))
            .await
            .expect("读取回显超时")
            .expect("读取回显失败");
        (tag[0], echoed)
    }

    /// 等探测任务写回 target_ok（首次探测是立即执行的，通常几十毫秒内完成）。
    async fn wait_for_target_ok(supervisor: &ForwardSupervisor, id: &str) -> Option<bool> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = supervisor
                .status_handle()
                .snapshot()
                .into_iter()
                .find(|status| status.id == id)
            {
                if status.target_ok.is_some() {
                    return status.target_ok;
                }
            }
            assert!(Instant::now() < deadline, "等待 {id} 的 target_ok 超时");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// 等一条规则的**所有**候选目标都完成至少一次探测。
    async fn wait_for_all_targets_probed(
        supervisor: &ForwardSupervisor,
        id: &str,
    ) -> Vec<Option<TargetHealth>> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let health = supervisor.status_handle().target_health_snapshot(id);
            if !health.is_empty() && health.iter().all(Option::is_some) {
                return health;
            }
            assert!(Instant::now() < deadline, "等待 {id} 的逐目标探测超时");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// 等某个目标被探测成指定健康状态。
    async fn wait_for_target_health(
        supervisor: &ForwardSupervisor,
        id: &str,
        index: usize,
        healthy: bool,
    ) -> TargetHealth {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(Some(health)) = supervisor
                .status_handle()
                .target_health_snapshot(id)
                .get(index)
            {
                if health.healthy == healthy {
                    return *health;
                }
            }
            assert!(
                Instant::now() < deadline,
                "等待 {id} 的目标 {index} 变成 healthy={healthy} 超时"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn forwards_client_bytes_to_target_and_back() {
        let target = spawn_tagged_echo(b'E').await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");

        // listen_port = 0 交给内核选端口，绑定后读回实际端口。
        supervisor.apply(&[rule("fwd", 0, target)]).await;
        let listen_port = supervisor
            .bound_port("fwd")
            .expect("绑定成功后应能读到实际端口");

        let status = supervisor.status_handle().snapshot();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].id, "fwd");
        assert!(status[0].listening, "绑定成功的规则应上报 listening=true");
        assert!(status[0].error.is_empty());

        // 双向字节流：客户端写入 → 目标收到并回显。
        let (tag, echoed) = roundtrip(listen_port, b"hello forward").await;
        assert_eq!(tag, b'E');
        assert_eq!(echoed, b"hello forward", "目标必须收到原始字节并原样回显");
    }

    /// 监听成功 ≠ 目标可达：目标不可达时 listening 仍为 true，但 target_ok=false。
    #[tokio::test]
    async fn target_health_is_reported_separately_from_listening() {
        let reachable = spawn_tagged_echo(b'E').await;
        let dead = SocketAddr::from(([127, 0, 0, 1], 0));
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");

        supervisor
            .apply(&[rule("good", 0, reachable), rule("dead", 0, dead)])
            .await;

        assert_eq!(
            wait_for_target_ok(&supervisor, "good").await,
            Some(true),
            "可达目标应上报 target_ok=true"
        );
        assert_eq!(
            wait_for_target_ok(&supervisor, "dead").await,
            Some(false),
            "不可达目标应上报 target_ok=false"
        );

        let status = supervisor.status_handle().snapshot();
        let good = status.iter().find(|status| status.id == "good").unwrap();
        let dead = status.iter().find(|status| status.id == "dead").unwrap();
        assert!(good.listening && dead.listening, "端口都已绑定成功");
        assert_eq!(good.target_ok, Some(true));
        assert_eq!(dead.target_ok, Some(false), "目标不可达不能改 listening");
        assert!(dead.error.is_empty(), "目标探测失败不是监听错误");
    }

    #[tokio::test]
    async fn unreachable_target_closes_connection_without_panic() {
        let target = spawn_tagged_echo(b'E').await;
        // 目标端口 0 一定连不上（内核直接拒绝），用来模拟目标不可达；
        // 监听端口同样交给内核分配，互不冲突。
        let dead_target = SocketAddr::from(([127, 0, 0, 1], 0));
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");

        supervisor
            .apply(&[rule("dead", 0, dead_target), rule("good", 0, target)])
            .await;
        let dead_listen_port = supervisor.bound_port("dead").unwrap();
        let good_port = supervisor.bound_port("good").unwrap();

        // 目标不可达：监听本身是成功的，所以 listening=true，
        // 但客户端连上后应看到连接被关闭（EOF 或 RST）。
        let mut client = TcpStream::connect(("127.0.0.1", dead_listen_port))
            .await
            .unwrap();
        client.write_all(b"into the void").await.unwrap();
        let mut buf = [0u8; 16];
        let read = timeout(Duration::from_secs(3), client.read(&mut buf))
            .await
            .expect("目标不可达时客户端不应被永久挂起");
        match read {
            // 干净关闭（Linux 常见）。
            Ok(0) => {}
            // 客户端还有未读数据时直接 drop 会发 RST（macOS 常见），同样算连接被关闭。
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
            Ok(n) => panic!("目标不可达时不应回显数据，实际收到 {n} 字节"),
            Err(error) => panic!("目标不可达时应关闭连接，实际错误: {error}"),
        }

        // 失败计数会由连接 task 异步写入，轮询等它 +1。
        let failures = supervisor
            .running
            .get("dead")
            .unwrap()
            .runtime
            .connect_failures
            .clone();
        let deadline = Instant::now() + Duration::from_secs(2);
        while failures.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            failures.load(Ordering::Relaxed) >= 1,
            "目标不可达必须被计数"
        );

        // 另一条规则完全不受影响。
        let (tag, echoed) = roundtrip(good_port, b"still alive").await;
        assert_eq!(tag, b'E');
        assert_eq!(echoed, b"still alive");
        assert!(supervisor
            .status_handle()
            .snapshot()
            .iter()
            .all(|status| status.listening));
    }

    #[tokio::test]
    async fn removing_rule_closes_listener() {
        let target = spawn_tagged_echo(b'E').await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");

        supervisor.apply(&[rule("fwd", 0, target)]).await;
        let listen_port = supervisor.bound_port("fwd").unwrap();
        let (tag, _) = roundtrip(listen_port, b"hi").await;
        assert_eq!(tag, b'E');

        supervisor.apply(&[]).await;

        assert!(
            supervisor.status_handle().snapshot().is_empty(),
            "期望态为空时不再上报任何转发状态"
        );
        assert!(
            TcpStream::connect(("127.0.0.1", listen_port))
                .await
                .is_err(),
            "删除规则后端口必须不再可连"
        );
    }

    #[tokio::test]
    async fn repeated_apply_is_idempotent() {
        let target = spawn_tagged_echo(b'E').await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");
        let spec = rule("fwd", 0, target);

        supervisor.apply(std::slice::from_ref(&spec)).await;
        let listen_port = supervisor.bound_port("fwd").unwrap();
        let started_at = supervisor.running.get("fwd").unwrap().started_at;
        let task_id = supervisor.running.get("fwd").unwrap().task.id();

        // 同一份列表重复下发：不应重建监听。
        supervisor.apply(std::slice::from_ref(&spec)).await;
        supervisor.apply(std::slice::from_ref(&spec)).await;

        let running = supervisor.running.get("fwd").unwrap();
        assert_eq!(
            running.started_at, started_at,
            "重复下发同一份列表不能重建监听"
        );
        assert_eq!(running.task.id(), task_id, "accept 任务不能被重启");

        // 监听仍可用。
        let (tag, echoed) = roundtrip(listen_port, b"idempotent").await;
        assert_eq!(tag, b'E');
        assert_eq!(echoed, b"idempotent");
    }

    #[tokio::test]
    async fn occupied_port_fails_only_its_own_rule() {
        // 先占住一个端口，且保持 listener 存活到断言结束。
        let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let occupied_port = occupied.local_addr().unwrap().port();
        let target = spawn_tagged_echo(b'E').await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");
        let busy = rule("busy", occupied_port, target);
        let good = rule("good", 0, target);

        supervisor.apply(&[busy.clone(), good.clone()]).await;
        let good_port = supervisor.bound_port("good").unwrap();

        let status = supervisor.status_handle().snapshot();
        assert_eq!(status.len(), 2);
        let busy_status = status.iter().find(|s| s.id == "busy").unwrap();
        assert!(
            !busy_status.listening,
            "端口被占用时该条必须 listening=false"
        );
        assert!(!busy_status.error.is_empty(), "失败原因不能是空串");
        let good_status = status.iter().find(|s| s.id == "good").unwrap();
        assert!(good_status.listening, "单条绑定失败不影响其它规则");
        assert!(good_status.error.is_empty());

        // 另一条规则确实可用。
        let (tag, echoed) = roundtrip(good_port, b"unaffected").await;
        assert_eq!(tag, b'E');
        assert_eq!(echoed, b"unaffected");

        // 释放占用后重新下发，同一 id 应自动恢复。
        drop(occupied);
        supervisor.apply(&[busy, good]).await;
        let status = supervisor.status_handle().snapshot();
        assert!(
            status.iter().find(|s| s.id == "busy").unwrap().listening,
            "端口释放后重放期望态应重试绑定并恢复"
        );
    }

    #[tokio::test]
    async fn changing_target_or_port_rebinds_listener() {
        let echo_a = spawn_tagged_echo(b'A').await;
        let echo_b = spawn_tagged_echo(b'B').await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");

        supervisor.apply(&[rule("fwd", 0, echo_a)]).await;
        let old_port = supervisor.bound_port("fwd").unwrap();
        let (tag, _) = roundtrip(old_port, b"a").await;
        assert_eq!(tag, b'A');
        let old_task = supervisor.running.get("fwd").unwrap().task.id();

        // 只换目标、监听端口不变：先关旧监听再绑同一端口，必须能重新绑上。
        supervisor.apply(&[rule("fwd", old_port, echo_b)]).await;
        let same_port_task = supervisor.running.get("fwd").unwrap().task.id();
        assert_ne!(same_port_task, old_task, "参数变化必须重建 accept 任务");
        assert!(supervisor.status_handle().snapshot()[0].listening);

        let (tag, echoed) = roundtrip(old_port, b"b").await;
        assert_eq!(tag, b'B', "新连接必须走新的目标");
        assert_eq!(echoed, b"b");

        // 再换监听端口：旧监听关闭，新端口可用。
        supervisor.apply(&[rule("fwd", 0, echo_b)]).await;
        let new_port = supervisor.bound_port("fwd").unwrap();
        let new_task = supervisor.running.get("fwd").unwrap().task.id();
        assert_ne!(new_task, same_port_task, "换端口必须重建 accept 任务");
        let (tag, echoed) = roundtrip(new_port, b"c").await;
        assert_eq!(tag, b'B');
        assert_eq!(echoed, b"c");
        // 内核可能把刚释放的旧端口又分回来；只有确实换了端口时才断言旧端口失效。
        if new_port != old_port {
            assert!(
                TcpStream::connect(("127.0.0.1", old_port)).await.is_err(),
                "换端口后旧端口必须被释放"
            );
        }
    }

    /// 真跑 TCP：一条组规则两个 echo 目标，轮询游标必须跨连接保留。
    /// 两个 echo 各自先吐 tag 字节，用 tag 区分连接落到了哪个目标。
    #[tokio::test]
    async fn round_robin_group_sends_second_connection_to_second_target() {
        let (echo_a, _handle_a) = spawn_tagged_echo_with_handle(b'A').await;
        let (echo_b, _handle_b) = spawn_tagged_echo_with_handle(b'B').await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");

        supervisor
            .apply(&[grouped_rule(
                "group",
                0,
                vec![echo_a, echo_b],
                ForwardStrategy::RoundRobin,
            )])
            .await;
        let listen_port = supervisor.bound_port("group").unwrap();

        let (first_tag, first_echo) = roundtrip(listen_port, b"first").await;
        assert_eq!(first_tag, b'A', "第 1 条连接应落到第 1 个目标");
        assert_eq!(first_echo, b"first");

        let (second_tag, second_echo) = roundtrip(listen_port, b"second").await;
        assert_eq!(
            second_tag, b'B',
            "第 2 条连接必须落到第 2 个目标（轮询游标跨连接保留）"
        );
        assert_eq!(second_echo, b"second");

        // 第 3 条回到第 1 个目标，确认不是「永远第二个」。
        let (third_tag, _) = roundtrip(listen_port, b"third").await;
        assert_eq!(third_tag, b'A', "轮询应在 3 条连接上回到起点");
    }

    /// 全部目标不健康：新连接必须被立即关闭（不尝试连接、不 panic），
    /// 监听本身仍然完好，换回可达目标后能继续工作。
    #[tokio::test]
    async fn group_with_all_targets_down_closes_connections_without_panic() {
        let dead_a = SocketAddr::from(([127, 0, 0, 1], 0));
        let dead_b = SocketAddr::from(([127, 0, 0, 1], 0));
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");

        supervisor
            .apply(&[grouped_rule(
                "dead",
                0,
                vec![dead_a, dead_b],
                ForwardStrategy::RoundRobin,
            )])
            .await;
        let listen_port = supervisor.bound_port("dead").unwrap();

        // 等两个目标都完成首轮探测，且都为不健康。
        let health = wait_for_all_targets_probed(&supervisor, "dead").await;
        assert!(
            health.iter().all(|entry| !entry.unwrap().healthy),
            "两个目标都应探测为不健康：{health:?}"
        );
        let status = supervisor.status_handle().snapshot();
        assert_eq!(status.len(), 1);
        assert!(status[0].listening, "目标全挂不能影响监听");
        assert_eq!(
            status[0].target_ok,
            Some(false),
            "整体 target_ok = 是否存在任一健康目标"
        );

        // 连上后应立刻关闭：读到 EOF 或 RST 都算关闭，但绝不能回显数据。
        for _ in 0..2 {
            let mut client = TcpStream::connect(("127.0.0.1", listen_port))
                .await
                .unwrap();
            let _ = client.write_all(b"nobody home").await;
            let mut buf = [0u8; 16];
            let read = timeout(Duration::from_secs(3), client.read(&mut buf))
                .await
                .expect("目标全不健康时客户端不应被永久挂起");
            match read {
                Ok(0) => {}
                Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
                Ok(n) => panic!("不应转发任何字节，实际收到 {n} 字节"),
                Err(error) => panic!("应关闭连接，实际错误: {error}"),
            }
        }

        // 监听没坏：换成可达目标重新下发（用新端口避免 TIME_WAIT 干扰），
        // 同一条规则能立刻恢复服务。
        let echo = spawn_tagged_echo(b'R').await;
        supervisor
            .apply(&[grouped_rule(
                "dead",
                0,
                vec![echo],
                ForwardStrategy::RoundRobin,
            )])
            .await;
        assert!(
            supervisor.status_handle().snapshot()[0].listening,
            "换目标重新下发后应继续监听"
        );
        let recovered_port = supervisor.bound_port("dead").unwrap();
        let (tag, echoed) = roundtrip(recovered_port, b"recovered").await;
        assert_eq!(tag, b'R');
        assert_eq!(echoed, b"recovered");
    }

    /// 组内只要有一个健康目标，整体 `target_ok` 就是 true；
    /// 逐目标探测结果分别记录（这里用内部快照断言）。
    #[tokio::test]
    async fn group_target_ok_is_any_healthy_target() {
        let dead = SocketAddr::from(([127, 0, 0, 1], 0));
        let good = spawn_tagged_echo(b'G').await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");

        supervisor
            .apply(&[grouped_rule(
                "mixed",
                0,
                vec![dead, good],
                ForwardStrategy::Failover,
            )])
            .await;
        let listen_port = supervisor.bound_port("mixed").unwrap();

        let health = wait_for_all_targets_probed(&supervisor, "mixed").await;
        assert_eq!(health[0].map(|entry| entry.healthy), Some(false));
        assert_eq!(health[1].map(|entry| entry.healthy), Some(true));

        let status = supervisor.status_handle().snapshot();
        assert_eq!(
            status[0].target_ok,
            Some(true),
            "只要有一个健康成员，整体 target_ok 就应为 true"
        );

        // Failover 按顺序跳过错的主目标，选中第二个。
        let (tag, echoed) = roundtrip(listen_port, b"failover").await;
        assert_eq!(tag, b'G');
        assert_eq!(echoed, b"failover");
    }

    /// 选中的目标连接失败时：本次不换目标重试、失败计数 +1，
    /// 并且立即补测该目标，让下一条连接跳过它。
    #[tokio::test]
    async fn failed_target_is_probed_immediately_and_skipped_by_next_connection() {
        let (echo_a, handle_a) = spawn_tagged_echo_with_handle(b'A').await;
        let (echo_b, _handle_b) = spawn_tagged_echo_with_handle(b'B').await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");

        supervisor
            .apply(&[grouped_rule(
                "group",
                0,
                vec![echo_a, echo_b],
                ForwardStrategy::RoundRobin,
            )])
            .await;
        let listen_port = supervisor.bound_port("group").unwrap();

        // 先让两个目标都探测为健康，再把第一个目标下线。
        let health = wait_for_all_targets_probed(&supervisor, "group").await;
        assert!(health.iter().all(|entry| entry.unwrap().healthy));
        handle_a.abort();
        let _ = handle_a.await;

        // 第 1 条连接按轮询选中已下线的 A：连接失败并被关闭。
        let mut first = TcpStream::connect(("127.0.0.1", listen_port))
            .await
            .unwrap();
        let mut buf = [0u8; 16];
        let read = timeout(Duration::from_secs(3), first.read(&mut buf))
            .await
            .expect("目标下线时客户端不应被永久挂起");
        match read {
            Ok(0) => {}
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
            Ok(n) => panic!("目标已下线，不应有数据返回，实际 {n} 字节"),
            Err(error) => panic!("目标已下线时应关闭连接，实际错误: {error}"),
        }

        // 失败计数 +1，且目标 A 在 30 秒周期探测之前就被立即复测为不健康。
        let failures = supervisor
            .running
            .get("group")
            .unwrap()
            .runtime
            .connect_failures
            .clone();
        let deadline = Instant::now() + Duration::from_secs(2);
        while failures.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            failures.load(Ordering::Relaxed),
            1,
            "连接失败必须计数，且本次连接不重试其它目标"
        );
        assert!(
            !wait_for_target_health(&supervisor, "group", 0, false)
                .await
                .healthy,
            "连接失败后目标 A 必须被立即探测为不健康"
        );

        // 下一条连接跳过不健康的 A，落到 B；游标也只在成功挑选时推进。
        let (tag, echoed) = roundtrip(listen_port, b"next").await;
        assert_eq!(tag, b'B', "下一条连接应跳过刚失败的目标");
        assert_eq!(echoed, b"next");
    }

    // ---- UDP 转发（真跑 socket）----

    /// 同一个端口号上的 TCP + UDP echo：UDP 原样回显，TCP 先吐 tag 'D' 再回显。
    /// 一条 `udp = true` 的规则要能把两种协议同时转给同一个目标。
    async fn spawn_dual_echo() -> SocketAddr {
        // UDP 先拿随机端口，再在同一个端口号上绑 TCP。并行测试里那个 TCP 端口
        // 可能刚好被别人占着（UDP/TCP 端口空间独立），撞了就换一个端口重试。
        let (udp, listener, addr) = loop {
            let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let addr = udp.local_addr().unwrap();
            match TcpListener::bind(addr).await {
                // 同一端口号再绑 TCP：两种协议互不影响。
                Ok(listener) => break (udp, listener, addr),
                Err(_) => continue,
            }
        };

        tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            while let Ok((size, peer)) = udp.recv_from(&mut buf).await {
                if udp.send_to(&buf[..size], peer).await.is_err() {
                    break;
                }
            }
        });

        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    if stream.write_all(b"D").await.is_err() {
                        return;
                    }
                    let mut buf = [0u8; 4096];
                    while let Ok(size) = stream.read(&mut buf).await {
                        if size == 0 {
                            break;
                        }
                        if stream.write_all(&buf[..size]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        addr
    }

    /// 同一客户端 socket 连发三个包，全部回显；TCP 那一半也照常可用。
    #[tokio::test]
    async fn udp_rule_forwards_datagrams_and_keeps_tcp_working() {
        let target = spawn_dual_echo().await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");
        supervisor.apply(&[udp_rule("fwd-udp", 0, target)]).await;
        let port = supervisor
            .bound_port("fwd-udp")
            .expect("UDP 规则同样要能被内核分配端口");

        let status = supervisor.status_handle().snapshot();
        assert_eq!(status.len(), 1);
        assert!(status[0].listening, "UDP 规则绑定成功后必须 listening=true");
        assert!(
            status[0].target_ok.is_none(),
            "UDP 规则不做 TCP 目标探测，target_ok 应为未知"
        );

        let client = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let mut buf = [0u8; 64];
        for payload in [b"one".as_slice(), b"two", b"three"] {
            client.send_to(payload, ("127.0.0.1", port)).await.unwrap();
            let (size, _) = timeout(Duration::from_secs(2), client.recv_from(&mut buf))
                .await
                .expect("UDP 回显超时")
                .expect("UDP 回显失败");
            assert_eq!(&buf[..size], payload, "三个包都必须原样回显");
        }

        // 回归红线：开 UDP 不能改变同一条规则的 TCP 行为。
        let (tag, echoed) = roundtrip(port, b"tcp still works").await;
        assert_eq!(tag, b'D');
        assert_eq!(echoed, b"tcp still works");
    }

    /// `udp = false` 的规则不能绑 UDP 端口（回归红线：升级前只有 TCP）。
    #[tokio::test]
    async fn rule_without_udp_does_not_listen_on_udp_port() {
        let target = spawn_tagged_echo(b'E').await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");
        supervisor.apply(&[rule("tcp-only", 0, target)]).await;
        let port = supervisor.bound_port("tcp-only").unwrap();

        // UDP 端口应该是空的：探针自己能绑上就说明没人监听。
        let probe = tokio::net::UdpSocket::bind(("127.0.0.1", port)).await;
        assert!(
            probe.is_ok(),
            "udp=false 的规则不能监听 UDP 端口，否则就是回归"
        );
    }

    /// 运行期间 UDP 端口被占住，删除规则后必须释放。
    #[tokio::test]
    async fn removing_udp_rule_releases_udp_port() {
        let target = spawn_dual_echo().await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");
        supervisor.apply(&[udp_rule("fwd-udp", 0, target)]).await;
        let port = supervisor.bound_port("fwd-udp").unwrap();

        assert!(
            tokio::net::UdpSocket::bind(("127.0.0.1", port))
                .await
                .is_err(),
            "运行期间 UDP 端口必须被规则占住"
        );

        supervisor.apply(&[]).await;
        assert!(
            tokio::net::UdpSocket::bind(("127.0.0.1", port))
                .await
                .is_ok(),
            "删除规则后 UDP 端口必须释放，否则同端口改配置会撞自己"
        );
    }

    /// 只把 udp 关掉（端口/目标不变）：TCP 监听必须完全不动，UDP 端口释放。
    #[tokio::test]
    async fn turning_udp_off_releases_only_the_udp_port() {
        let target = spawn_dual_echo().await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");
        supervisor.apply(&[udp_rule("fwd", 0, target)]).await;
        let port = supervisor.bound_port("fwd").unwrap();
        let tcp_task = supervisor.running.get("fwd").unwrap().task.id();
        let started_at = supervisor.running.get("fwd").unwrap().started_at;

        // listen_port 保持 0（期望态与运行时一致），只有 udp 位变化。
        supervisor.apply(&[rule("fwd", 0, target)]).await;

        let running = supervisor.running.get("fwd").unwrap();
        assert_eq!(
            running.task.id(),
            tcp_task,
            "关 UDP 不能重建 TCP accept 任务"
        );
        assert_eq!(running.started_at, started_at, "TCP 监听不能被重启");
        assert!(running.udp.is_none());
        assert!(
            supervisor.status_handle().snapshot()[0].listening,
            "关掉 UDP 后 TCP 监听必须仍在"
        );
        assert!(
            tokio::net::UdpSocket::bind(("127.0.0.1", port))
                .await
                .is_ok(),
            "udp 位变化必须触发重建并释放 UDP 端口"
        );

        // TCP 那一半完全没退化。
        let (tag, echoed) = roundtrip(port, b"tcp-only").await;
        assert_eq!(tag, b'D');
        assert_eq!(echoed, b"tcp-only");
    }

    /// 只把 udp 打开（同端口已在 TCP 监听）：必须只补 UDP 监听，不重建 TCP。
    #[tokio::test]
    async fn turning_udp_on_adds_udp_without_interrupting_tcp() {
        let target = spawn_dual_echo().await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");
        supervisor.apply(&[rule("fwd", 0, target)]).await;
        let port = supervisor.bound_port("fwd").unwrap();
        let tcp_task = supervisor.running.get("fwd").unwrap().task.id();

        // 先建立一条连接并保持打开：切换过程中它不能断。
        let mut long_lived = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut tag = [0u8; 1];
        timeout(Duration::from_secs(2), long_lived.read_exact(&mut tag))
            .await
            .expect("读取 tag 超时")
            .expect("读取 tag 失败");
        assert_eq!(tag[0], b'D');

        supervisor.apply(&[udp_rule("fwd", 0, target)]).await;

        let running = supervisor.running.get("fwd").unwrap();
        assert_eq!(
            running.task.id(),
            tcp_task,
            "补 UDP 不能重建 TCP accept 任务"
        );
        assert!(running.udp.is_some(), "UDP 监听必须补上");
        assert!(supervisor.status_handle().snapshot()[0].listening);

        // 已建立的 TCP 连接继续可用。
        long_lived.write_all(b"still here").await.unwrap();
        let mut echoed = [0u8; 10];
        timeout(Duration::from_secs(2), long_lived.read_exact(&mut echoed))
            .await
            .expect("旧连接读取超时")
            .expect("旧连接读取失败");
        assert_eq!(&echoed, b"still here", "切换期间旧 TCP 连接不能断");

        // 新连接与 UDP 都可用。
        let (tag, _) = roundtrip(port, b"new tcp").await;
        assert_eq!(tag, b'D');
        let client = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let mut buf = [0u8; 64];
        client
            .send_to(b"udp on", ("127.0.0.1", port))
            .await
            .unwrap();
        let (size, _) = timeout(Duration::from_secs(2), client.recv_from(&mut buf))
            .await
            .expect("UDP 回显超时")
            .expect("UDP 回显失败");
        assert_eq!(&buf[..size], b"udp on");
    }

    /// 补 UDP 时端口被占用：TCP 必须继续服务，状态如实报 UDP 失败；
    /// 占用释放后下一轮 apply 自动补上 UDP。
    #[tokio::test]
    async fn udp_bind_failure_while_toggling_keeps_tcp_alive() {
        let target = spawn_dual_echo().await;
        let occupied = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = occupied.local_addr().unwrap().port();
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");

        supervisor.apply(&[rule("fwd", port, target)]).await;
        let tcp_task = supervisor.running.get("fwd").unwrap().task.id();
        let (tag, _) = roundtrip(port, b"tcp first").await;
        assert_eq!(tag, b'D');

        supervisor.apply(&[udp_rule("fwd", port, target)]).await;

        let running = supervisor.running.get("fwd").unwrap();
        assert_eq!(
            running.task.id(),
            tcp_task,
            "UDP 绑定失败也不能拆掉 TCP 监听"
        );
        assert!(running.udp.is_none());
        let status = supervisor.status_handle().snapshot();
        assert!(
            !status[0].listening,
            "UDP 没绑上时不能报整体 listening=true"
        );
        assert!(
            status[0].error.contains("UDP"),
            "失败原因必须说明是 UDP：{:?}",
            status[0].error
        );

        // TCP 仍然可用。
        let (tag, echoed) = roundtrip(port, b"tcp survives").await;
        assert_eq!(tag, b'D');
        assert_eq!(echoed, b"tcp survives");

        // 释放占用后重放期望态：只补 UDP，TCP 任务仍不重建。
        drop(occupied);
        supervisor.apply(&[udp_rule("fwd", port, target)]).await;
        let running = supervisor.running.get("fwd").unwrap();
        assert_eq!(running.task.id(), tcp_task);
        assert!(running.udp.is_some(), "端口释放后必须自动补上 UDP");
        assert!(supervisor.status_handle().snapshot()[0].listening);

        let client = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let mut buf = [0u8; 64];
        client
            .send_to(b"udp later", ("127.0.0.1", port))
            .await
            .unwrap();
        let (size, _) = timeout(Duration::from_secs(2), client.recv_from(&mut buf))
            .await
            .expect("UDP 回显超时")
            .expect("UDP 回显失败");
        assert_eq!(&buf[..size], b"udp later");
    }

    /// UDP 端口被别人占着：这条规则必须 listening=false 且带原因，
    /// 已经绑上的 TCP 监听也要一起释放；其它规则不受影响。
    #[tokio::test]
    async fn occupied_udp_port_fails_only_its_own_rule() {
        let occupied = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let busy_port = i64::from(occupied.local_addr().unwrap().port());
        let target = spawn_dual_echo().await;
        let mut supervisor = ForwardSupervisor::new("127.0.0.1");

        let mut busy = udp_rule("busy-udp", 0, target);
        busy.listen_port = busy_port;
        let good = udp_rule("good-udp", 0, target);
        supervisor.apply(&[busy, good]).await;

        let status = supervisor.status_handle().snapshot();
        let busy = status.iter().find(|s| s.id == "busy-udp").unwrap();
        assert!(!busy.listening, "UDP 端口被占用时该条必须 listening=false");
        assert!(
            busy.error.contains("UDP"),
            "失败原因必须说明是 UDP 端口，实际：{}",
            busy.error
        );
        assert!(
            TcpListener::bind(("127.0.0.1", busy_port as u16))
                .await
                .is_ok(),
            "UDP 绑定失败时已绑上的 TCP 监听必须释放"
        );
        let good = status.iter().find(|s| s.id == "good-udp").unwrap();
        assert!(good.listening, "单条失败不能影响其它规则");

        drop(occupied);
    }
}
