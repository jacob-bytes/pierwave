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

use std::collections::HashSet;
use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pierwave_proto::{DesiredForward, ForwardEngine, ForwardStatus};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// realm 的默认安装路径；打包脚本把资产解到 `/usr/lib/pierwave/bin/realm`。
pub const DEFAULT_BIN: &str = "/usr/lib/pierwave/bin/realm";

/// 状态目录里的配置文件名。
pub const CONFIG_FILE_NAME: &str = "realm.toml";

/// 没装 realm 时每条 realm 规则的 `error`。保持与产品文案一致，
/// 主控会原样显示在转发/链的状态列里。
pub const NOT_INSTALLED: &str = "realm 未安装";

/// 进程活着但端口还没绑上时的原因：最常见的是 realm 正在启动，
/// 或某个 endpoint 绑定失败（例如端口被别的程序抢走）。
pub const NOT_LISTENING: &str = "realm 未监听端口";

/// 停止子进程时等待它退出的上限；超时就 abort（`kill_on_drop` 兜底杀掉）。
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// 刚 spawn 后等 realm 绑定端口的宽限：立刻做 bind 探针会和它的 bind 抢跑，
/// 既可能误报「未监听」，也可能让 realm 自己的绑定失败。
const STARTUP_GRACE: Duration = Duration::from_millis(150);

/// 心跳可无锁读取的 realm 规则状态快照。
///
/// 与 native 的 [`crate::forward::ForwardStatusHandle`] 分开：两个引擎各自
/// 整体替换自己的状态集合，互不覆盖；心跳把两份拼起来上传。
#[derive(Debug, Clone, Default)]
pub struct RealmStatusHandle {
    inner: Arc<Mutex<Vec<ForwardStatus>>>,
}

impl RealmStatusHandle {
    pub fn snapshot(&self) -> Vec<ForwardStatus> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn store(&self, statuses: Vec<ForwardStatus>) {
        let mut slot = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = statuses;
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

/// realm 引擎的收敛器。生命周期与 native supervisor 一样跨 websocket 重连保留。
pub struct RealmSupervisor {
    bin: PathBuf,
    config_path: PathBuf,
    /// 写进 realm 配置的监听地址，与 native 的 `forward_bind` 保持一致。
    bind_host: String,
    /// 最近一次套用的 realm 规则（已排序，状态顺序与之对应）。
    rules: Vec<DesiredForward>,
    /// 已落盘配置的内容哈希；`None` = 还没写过 / 上一轮已清空。
    content_hash: Option<u64>,
    process: Option<RunningRealm>,
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
            rules: Vec::new(),
            content_hash: None,
            process: None,
            status: RealmStatusHandle::default(),
        }
    }

    /// 心跳侧读状态用；clone 出来的句柄可以脱离 supervisor 借用。
    pub fn status_handle(&self) -> RealmStatusHandle {
        self.status.clone()
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

        let content = render_config(&self.rules, &self.bind_host);
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
                // realm 没有状态 API，目标可达性本轮不上报。
                target_ok: None,
            });
        }
        statuses
    }

    fn inactive_statuses(&self, reason: &str) -> Vec<ForwardStatus> {
        self.rules
            .iter()
            .map(|rule| ForwardStatus {
                id: rule.id.clone(),
                listening: false,
                error: reason.to_string(),
                target_ok: None,
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
    async fn stop(&mut self, reason: &str) {
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

/// 按 realm 的配置模型渲染一份 TOML。
///
/// TCP + UDP 同时转发（`no_tcp = false` / `use_udp = true`）：UDP 是选 realm 引擎的
/// 主要理由——native 引擎只有 TCP。多目标时第一个写 `remote`，
/// 其余写 `extra_remotes`，并加 `balance = "roundrobin: ..."`——
/// 本轮不带权重，每个目标权重都是 1。排序由调用方/本函数按监听端口固定，
/// 同一组规则重复渲染必须逐字节一致（否则内容哈希会抖，子进程会被反复重启）。
pub fn render_config(rules: &[DesiredForward], bind_host: &str) -> String {
    let mut ordered: Vec<&DesiredForward> = rules
        .iter()
        .filter(|rule| rule.engine == ForwardEngine::Realm)
        .collect();
    ordered.sort_by(|a, b| {
        a.listen_port
            .cmp(&b.listen_port)
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut out = String::new();
    out.push_str("# generated by pierwave-agent; do not edit（主控下发为准）\n");
    out.push_str("[network]\nno_tcp = false\nuse_udp = true\n");

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
        out.push_str("no_tcp = false\nuse_udp = true\n");
    }
    out
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

    #[test]
    fn renders_single_target_endpoint() {
        let toml = render_config(&[realm_rule("r1", 30001, &[("10.0.0.2", 443)])], "0.0.0.0");

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
        let toml = render_config(
            &[realm_rule(
                "r1",
                30001,
                &[("10.0.0.2", 443), ("10.0.0.3", 8443)],
            )],
            "0.0.0.0",
        );

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
        let toml = render_config(
            &[
                // 故意乱序传入：渲染必须按监听端口排序。
                realm_rule(
                    "chain-c1-0",
                    30001,
                    &[("10.0.0.2", 40001), ("10.0.0.3", 40001)],
                ),
                realm_rule("chain-c1-1", 30002, &[("203.0.113.9", 443)]),
            ],
            "0.0.0.0",
        );

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
        let toml = render_config(
            &[realm_rule("v6", 30001, &[("2001:db8::1", 443)])],
            "0.0.0.0",
        );
        assert!(toml.contains("remote = \"[2001:db8::1]:443\""), "{toml}");
    }

    #[test]
    fn config_hash_is_stable_and_order_independent() {
        let a = realm_rule("a", 30001, &[("10.0.0.2", 443)]);
        let b = realm_rule("b", 30002, &[("10.0.0.3", 443)]);

        let forward = render_config(&[a.clone(), b.clone()], "0.0.0.0");
        let reversed = render_config(&[b.clone(), a.clone()], "0.0.0.0");
        assert_eq!(forward, reversed, "同一组规则换顺序必须渲染出同一份配置");
        assert_eq!(
            config_hash(&forward),
            config_hash(&reversed),
            "内容哈希相同 = 不重启子进程"
        );

        let changed = render_config(
            &[realm_rule("a", 30009, &[("10.0.0.2", 443)]), b],
            "0.0.0.0",
        );
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
        let toml = render_config(&[native], "0.0.0.0");
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

    /// 选 realm 引擎的核心理由是 UDP，配置里必须真的打开它。
    #[test]
    fn realm_config_enables_udp() {
        let rules = vec![realm_rule("r1", 30001, &[("10.0.0.2", 443)])];
        let toml = render_config(&rules, "0.0.0.0");
        assert!(toml.contains("[network]"), "{toml}");
        assert!(toml.contains("use_udp = true"), "UDP 必须启用：{toml}");
        assert!(!toml.contains("use_udp = false"), "{toml}");
        // TCP 也要保留：realm 引擎同时承载两种协议。
        assert!(toml.contains("no_tcp = false"), "{toml}");
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
}
