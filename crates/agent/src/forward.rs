//! 单跳 TCP 端口转发的收敛器。
//!
//! 主控在期望态里下发 [`DesiredForward`]，本模块负责让实际监听集合收敛到这份列表：
//!
//! - 新增 → 绑定监听并 spawn accept 循环；
//! - 删除 → 通知 accept 循环退出，并等它真正释放端口；
//! - 端口或目标变化 → 先关旧监听、再绑新监听（否则同端口换目标会自己撞自己）；
//! - 幂等 → 同一份列表重复下发只做 diff，不重建任何监听。
//!
//! 单条规则失败只写进它自己的 [`ForwardStatus`]，不影响其它规则：
//! 绑定失败（端口被占用）上报 `listening=false` + 原因；目标不可达时
//! 只关闭这条客户端连接、计数并打日志，绝不 panic。

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pierwave_proto::{DesiredForward, ForwardStatus};
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::timeout;

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
/// `target_ok` 单独放在 map 里：探测任务每 30 秒写一次，心跳读取时叠加到
/// 监听状态上。这样监听状态（端口绑定）和目标可达性互不覆盖。
#[derive(Debug, Clone, Default)]
pub struct ForwardStatusHandle {
    inner: Arc<Mutex<StatusState>>,
}

#[derive(Debug, Default)]
struct StatusState {
    statuses: Vec<ForwardStatus>,
    target_ok: HashMap<String, Option<bool>>,
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
                status.target_ok = state.target_ok.get(&status.id).copied().flatten();
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
        state.target_ok.retain(|id, _| ids.contains(id));
    }

    fn set_target_ok(&self, id: &str, ok: bool) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .target_ok
            .insert(id.to_string(), Some(ok));
    }

    fn clear_target_ok(&self, id: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .target_ok
            .remove(id);
    }
}

/// 正在运行的一条转发。
struct RunningForward {
    spec: DesiredForward,
    /// `Some` 时用来通知 accept 循环优雅退出；`None` 表示已经通知过。
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
    /// 目标可达性探测循环；规则变化/删除时 abort。
    health_task: JoinHandle<()>,
    /// 供测试断言「重复下发没有重建监听」。
    started_at: Instant,
    /// 连接目标失败 / 转发中断的累计次数。
    connect_failures: Arc<AtomicU64>,
    /// 实际绑定的端口。测试用 `listen_port = 0` 让内核分配端口，
    /// 通过这里读回来，避免「先找空闲端口再绑定」的抢端口竞态。
    #[cfg(test)]
    bound_port: u16,
}

impl RunningForward {
    /// 通知 accept 循环退出，并等它 drop 掉 listener（端口真正释放）。
    async fn close(mut self, id: &str) {
        // 先停探测：规则已不在期望态，再写 target_ok 也没有意义。
        self.health_task.abort();
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
        tracing::info!(
            %id,
            uptime_secs = self.started_at.elapsed().as_secs(),
            failures = self.connect_failures.load(Ordering::Relaxed),
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
    fn bound_port(&self, id: &str) -> Option<u16> {
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

        // 1. 先关掉「已删除」和「参数已变化」的监听。
        //    顺序很重要：同一端口换目标时，旧监听不先释放会让新绑定 EADDRINUSE。
        let stale: Vec<String> = self
            .running
            .iter()
            .filter(|(id, running)| {
                !wanted
                    .iter()
                    .any(|spec| spec.id == **id && *spec == &running.spec)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(running) = self.running.remove(&id) {
                running.close(&id).await;
            }
            self.status.clear_target_ok(&id);
        }
        // 已经不在期望态里的失败项也清掉，别让心跳一直报旧规则。
        self.failed
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
            self.status.clear_target_ok(&spec.id);
            let listen = format!("{}:{}", self.bind_host, spec.listen_port);
            let target = format!("{}:{}", spec.target_host, spec.target_port);
            match TcpListener::bind(&listen).await {
                Ok(listener) => {
                    #[cfg(test)]
                    let bound_port = listener
                        .local_addr()
                        .expect("已绑定的 listener 一定有 local_addr")
                        .port();
                    let failures = Arc::new(AtomicU64::new(0));
                    let (tx, rx) = oneshot::channel();
                    let task = tokio::spawn(accept_loop(
                        spec.id.clone(),
                        listener,
                        spec.target_host.clone(),
                        spec.target_port,
                        rx,
                        failures.clone(),
                    ));
                    // 监听成功与目标可达是两件事：这里只负责周期探测目标，
                    // 结果写进 status handle，心跳把两者一起带上去。
                    let health_task = tokio::spawn(target_health_loop(
                        spec.id.clone(),
                        spec.target_host.clone(),
                        spec.target_port,
                        self.status.clone(),
                    ));
                    tracing::info!(id = %spec.id, %listen, %target, "转发监听已启动");
                    self.failed.remove(&spec.id);
                    self.running.insert(
                        spec.id.clone(),
                        RunningForward {
                            spec: spec.clone(),
                            shutdown: Some(tx),
                            task,
                            health_task,
                            started_at: Instant::now(),
                            connect_failures: failures,
                            #[cfg(test)]
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

/// 周期探测一条转发的目标，把结果写进心跳状态句柄。
///
/// 复用 `probe::measure_target`（内部就是 `probe::measure` 的 TCP 握手探测）；
/// 立即测一次，之后每 [`TARGET_PROBE_INTERVAL`] 一次。失败只写 `target_ok=false`，
/// 绝不影响 `listening`——端口绑定是否成功由 accept 循环单独决定。
async fn target_health_loop(
    id: String,
    target_host: String,
    target_port: i64,
    status: ForwardStatusHandle,
) {
    loop {
        let probe_host = target_host.clone();
        let measured = tokio::task::spawn_blocking(move || {
            crate::probe::measure_target(&probe_host, target_port, TARGET_PROBE_TIMEOUT)
        })
        .await
        .ok()
        .flatten();
        status.set_target_ok(&id, measured.is_some());
        tracing::debug!(
            %id,
            %target_host,
            target_port,
            target_ok = measured.is_some(),
            "转发目标探测完成"
        );
        tokio::time::sleep(TARGET_PROBE_INTERVAL).await;
    }
}

/// 监听 accept 循环：`shutdown` 一到就退出并 drop listener。
async fn accept_loop(
    id: String,
    listener: TcpListener,
    target_host: String,
    target_port: i64,
    mut shutdown: oneshot::Receiver<()>,
    connect_failures: Arc<AtomicU64>,
) {
    loop {
        tokio::select! {
            // 优先处理关闭：删除规则后不要再接受排队中的新连接。
            biased;
            _ = &mut shutdown => {
                tracing::debug!(%id, "转发 accept 循环退出");
                break;
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((client, peer)) => {
                        let id = id.clone();
                        let target_host = target_host.clone();
                        let failures = connect_failures.clone();
                        // 每条连接独立 task：单条失败/卡住不影响 accept 循环。
                        tokio::spawn(async move {
                            let target = format!("{target_host}:{target_port}");
                            match proxy(client, &target_host, target_port).await {
                                Ok((up, down)) => {
                                    tracing::debug!(%id, %target, %peer, up, down, "转发连接关闭");
                                }
                                Err(error) => {
                                    let count =
                                        failures.fetch_add(1, Ordering::Relaxed) + 1;
                                    // 目标不可达 / 超时 / 半路断开都走这里：
                                    // 只计数 + 日志，客户端连接随函数返回被关闭。
                                    tracing::warn!(
                                        %id,
                                        %target,
                                        %peer,
                                        %error,
                                        failures = count,
                                        "转发连接失败"
                                    );
                                }
                            }
                        });
                    }
                    Err(error) => {
                        // accept 失败（EMFILE 等）不能退出监听，否则整条规则假死。
                        tracing::warn!(%id, %error, "转发 accept 失败，稍后重试");
                        tokio::time::sleep(ACCEPT_BACKOFF).await;
                    }
                }
            }
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
        }
    }

    /// 本地 echo 服务：先吐一个 tag 字节（方便断言流量去了哪个 upstream），
    /// 然后把收到的字节原样写回。
    async fn spawn_tagged_echo(tag: u8) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
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
        addr
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
}
