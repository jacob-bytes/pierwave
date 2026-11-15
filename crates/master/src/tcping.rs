//! 节点可达性探测（TCPing）。
//!
//! 目标地址的优先级只有两条规则：
//!
//! 1. **端口**：`public_port`（合法时）优先，否则用节点的监听端口 `port`。
//!    NAT 机器上 `port` 是 Agent 实际监听的端口，用户能连到的是 `public_port`。
//! 2. **主机**：服务器的 `internal_address` 只在**主控与服务器同网**时优先；
//!    否则用服务器的公网 `address`。同网判定复用 `if-addrs` 读到的本机网卡
//!    与掩码，只有内网地址落在主控某个网卡的同一子网里才算同网——绝不靠
//!    「试着连一下内网地址」来猜，避免每次探测白白多花一个超时。
//!
//! 结果不落库：这里只做一次 `TcpStream::connect`，返回实时值。并发/频控状态
//! 放在 [`Registry`]（进程内）：同一节点同一时刻只跑一次探测，5 秒窗口内
//! 复用上一次结果，所以重复点击既不会放大扫描面，也不会拿到 429。

use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use if_addrs::IfAddr;
use serde::Serialize;
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;

/// 单次 TCP 握手超时。
pub const TIMEOUT: Duration = Duration::from_secs(3);

/// 同一节点两次**真实**探测的最小间隔；窗口内复用上一次结果。
pub const MIN_INTERVAL: Duration = Duration::from_secs(5);

/// 目标地址用的是内网还是公网主机。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetSource {
    Internal,
    Public,
}

impl TargetSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Internal => "internal",
            Self::Public => "public",
        }
    }
}

/// 超时是 [`probe`] 自己造出来的结果，没有对应的 `std::io::Error`。
const TIMEOUT_MESSAGE: &str = "连接超时 / Connection timed out";

/// 一次探测要连接的 `host:port`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub source: TargetSource,
}

impl Target {
    /// 展示/审计用的 `host:port`；IPv6 自动补方括号。
    pub fn address(&self) -> String {
        format_host_port(&self.host, self.port)
    }
}

/// 地址选择的纯输入；从 `Node` / `Server` 装配，便于单测覆盖优先级。
#[derive(Debug, Clone, Copy)]
pub struct TargetInput<'a> {
    pub server_address: &'a str,
    pub internal_address: Option<&'a str>,
    pub port: i64,
    pub public_port: Option<i64>,
}

/// 端口：合法的 `public_port` 优先，否则回落到监听端口。
///
/// `nodes.public_port` 写入时已经校验过，这里再挡一次历史脏数据：
/// 非法值不能让探测连到一个不存在的端口上，更不能把 `:0` 写进响应。
pub fn effective_port(port: i64, public_port: Option<i64>) -> u16 {
    public_port
        .and_then(valid_port)
        .or_else(|| valid_port(port))
        .unwrap_or(0)
}

fn valid_port(value: i64) -> Option<u16> {
    u16::try_from(value).ok().filter(|port| *port != 0)
}

/// 选择探测目标：内网地址仅在 `same_lan = true` 时优先。
pub fn select_target(input: TargetInput<'_>, same_lan: bool) -> Target {
    let internal = input
        .internal_address
        .map(str::trim)
        .filter(|address| !address.is_empty());
    let (host, source) = match internal {
        Some(address) if same_lan => (address.to_string(), TargetSource::Internal),
        _ => (
            input.server_address.trim().to_string(),
            TargetSource::Public,
        ),
    };
    Target {
        host,
        port: effective_port(input.port, input.public_port),
        source,
    }
}

/// 主控本机的网卡地址；读取失败按「不同网」处理，绝不猜测。
pub fn local_interfaces() -> Vec<IfAddr> {
    if_addrs::get_if_addrs()
        .map(|interfaces| {
            interfaces
                .into_iter()
                .map(|interface| interface.addr)
                .collect()
        })
        .unwrap_or_default()
}

/// 服务器内网地址是否落在主控某个网卡的同一子网里。
///
/// 只比较 IP 字面量：内网地址填的是主机名时无法判断子网，按不同网处理。
pub fn same_lan(internal_address: Option<&str>, interfaces: &[IfAddr]) -> bool {
    let Some(target) = internal_address
        .map(str::trim)
        .filter(|address| !address.is_empty())
        .and_then(|address| address.parse::<IpAddr>().ok())
    else {
        return false;
    };
    interfaces
        .iter()
        .any(|interface| in_same_subnet(interface, target))
}

fn in_same_subnet(interface: &IfAddr, target: IpAddr) -> bool {
    match (interface, target) {
        (IfAddr::V4(interface), IpAddr::V4(target)) => {
            let mask = u32::from(netmask_from_prefix(interface.prefixlen));
            interface.ip != Ipv4Addr::UNSPECIFIED
                && interface.prefixlen != 0
                && (u32::from(interface.ip) & mask) == (u32::from(target) & mask)
        }
        (IfAddr::V6(interface), IpAddr::V6(target)) => {
            let mask = netmask_v6_from_prefix(interface.prefixlen);
            !interface.ip.is_unspecified()
                && interface.prefixlen != 0
                && (u128::from(interface.ip) & mask) == (u128::from(target) & mask)
        }
        _ => false,
    }
}

fn netmask_from_prefix(prefixlen: u8) -> Ipv4Addr {
    let bits = prefixlen.min(32);
    let mask = if bits == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(bits))
    };
    Ipv4Addr::from(mask)
}

fn netmask_v6_from_prefix(prefixlen: u8) -> u128 {
    let bits = prefixlen.min(128);
    if bits == 0 {
        0
    } else {
        u128::MAX << (128 - u32::from(bits))
    }
}

fn format_host_port(host: &str, port: u16) -> String {
    let host = host.trim();
    if host.parse::<IpAddr>().is_ok_and(|ip| ip.is_ipv6()) {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// 探测结果（响应体）；成功只有 `latency_ms`，失败只有 `error`。
#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub address: String,
    pub checked_at: i64,
}

impl ProbeResult {
    fn success(address: String, latency_ms: u64, checked_at: i64) -> Self {
        Self {
            reachable: true,
            latency_ms: Some(latency_ms),
            error: None,
            address,
            checked_at,
        }
    }

    fn failure(address: String, error: String, checked_at: i64) -> Self {
        Self {
            reachable: false,
            latency_ms: None,
            error: Some(error),
            address,
            checked_at,
        }
    }

    /// 审计用：只保留结果，不含地址明文。
    pub fn audit_detail(&self) -> serde_json::Value {
        let mut detail = serde_json::json!({ "reachable": self.reachable });
        if let Some(latency_ms) = self.latency_ms {
            detail["latency_ms"] = serde_json::json!(latency_ms);
        }
        if let Some(error) = &self.error {
            detail["error"] = serde_json::json!(error);
        }
        detail
    }
}

/// 真正建立一次 TCP 连接；任何失败都是正常结果，不向上抛错。
pub async fn probe(target: &Target) -> ProbeResult {
    let address = target.address();
    let started = Instant::now();
    let outcome = tokio::time::timeout(
        TIMEOUT,
        TcpStream::connect((target.host.as_str(), target.port)),
    )
    .await;
    let checked_at = pierwave_domain::repo::now();
    match outcome {
        Ok(Ok(stream)) => {
            drop(stream);
            let elapsed = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            ProbeResult::success(address, elapsed, checked_at)
        }
        Ok(Err(error)) => ProbeResult::failure(address, describe_error(&error), checked_at),
        Err(_) => ProbeResult::failure(address, TIMEOUT_MESSAGE.to_string(), checked_at),
    }
}

/// 把底层 I/O 错误翻成可读的双语原因。
pub fn describe_error(error: &std::io::Error) -> String {
    use std::io::ErrorKind;
    let (zh, en) = match error.kind() {
        ErrorKind::ConnectionRefused => ("连接被拒绝", "Connection refused"),
        ErrorKind::TimedOut => ("连接超时", "Connection timed out"),
        ErrorKind::NetworkUnreachable => ("网络不可达", "Network unreachable"),
        ErrorKind::HostUnreachable => ("主机不可达", "Host unreachable"),
        ErrorKind::PermissionDenied => ("权限不足，连接被拒绝", "Permission denied"),
        ErrorKind::InvalidInput | ErrorKind::AddrNotAvailable => {
            ("地址不可用", "Address unavailable")
        }
        ErrorKind::Other => {
            let message = error.to_string().to_ascii_lowercase();
            if message.contains("lookup") || message.contains("resolve") {
                ("无法解析地址", "Could not resolve address")
            } else {
                return format!("连接失败 / Connection failed: {error}");
            }
        }
        _ => return format!("连接失败 / Connection failed: {error}"),
    };
    format!("{zh} / {en}")
}

/// 每节点一个槽位：记录上次真实探测的开始时间与结果。
#[derive(Default)]
struct Slot {
    last_started: Option<Instant>,
    last: Option<ProbeResult>,
}

impl Slot {
    /// 5 秒窗口内复用；窗口从**开始探测**时算，探测本身耗时也计入。
    fn fresh(&self, interval: Duration) -> Option<ProbeResult> {
        let last_started = self.last_started?;
        if last_started.elapsed() < interval {
            self.last.clone()
        } else {
            None
        }
    }

    fn record(&mut self, result: ProbeResult, started: Instant) {
        self.last_started = Some(started);
        self.last = Some(result);
    }
}

/// 进程内的每节点探测状态；由 `AppState` 持有，所有请求共享。
#[derive(Clone)]
pub struct Registry {
    slots: Arc<Mutex<HashMap<String, Arc<AsyncMutex<Slot>>>>>,
    interval: Duration,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new(MIN_INTERVAL)
    }
}

impl Registry {
    pub fn new(interval: Duration) -> Self {
        Self {
            slots: Arc::new(Mutex::new(HashMap::new())),
            interval,
        }
    }

    fn slot(&self, node_id: &str) -> Arc<AsyncMutex<Slot>> {
        let mut slots = self
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slots
            .entry(node_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(Slot::default())))
            .clone()
    }

    /// 执行（或复用）一次探测，返回 `(结果, 是否真的发起了探测)`。
    ///
    /// 槽位的 async 锁同时承担「同节点并发限 1」与「窗口内复用」：
    /// 后到的请求排队等前一个跑完，然后直接读到新鲜结果，不会重复连目标。
    pub async fn run<F, Fut>(&self, node_id: &str, probe: F) -> (ProbeResult, bool)
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = ProbeResult>,
    {
        let slot = self.slot(node_id);
        let mut slot = slot.lock().await;
        if let Some(cached) = slot.fresh(self.interval) {
            return (cached, false);
        }
        let started = Instant::now();
        let result = probe().await;
        slot.record(result.clone(), started);
        (result, true)
    }

    /// 测试与诊断：当前缓存的槽位数量。
    #[cfg(test)]
    fn len(&self) -> usize {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::net::Ipv6Addr;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use if_addrs::{Ifv4Addr, Ifv6Addr};

    fn v4(ip: [u8; 4], prefixlen: u8) -> IfAddr {
        IfAddr::V4(Ifv4Addr {
            ip: Ipv4Addr::from(ip),
            netmask: netmask_from_prefix(prefixlen),
            prefixlen,
            broadcast: None,
        })
    }

    fn v6(ip: Ipv6Addr, prefixlen: u8) -> IfAddr {
        IfAddr::V6(Ifv6Addr {
            ip,
            netmask: Ipv6Addr::from(netmask_v6_from_prefix(prefixlen)),
            prefixlen,
            broadcast: None,
        })
    }

    fn result(reachable: bool, checked_at: i64) -> ProbeResult {
        if reachable {
            ProbeResult::success("203.0.113.10:443".into(), 7, checked_at)
        } else {
            ProbeResult::failure(
                "203.0.113.10:443".into(),
                "连接超时 / Connection timed out".into(),
                checked_at,
            )
        }
    }

    #[test]
    fn effective_port_prefers_a_valid_public_port() {
        assert_eq!(effective_port(443, Some(40001)), 40001);
        assert_eq!(effective_port(443, None), 443);
        // 历史脏数据：越界/零值不能顶掉监听端口。
        for invalid in [Some(0), Some(-1), Some(65_536), Some(i64::MAX)] {
            assert_eq!(effective_port(8443, invalid), 8443, "{invalid:?}");
        }
        assert_eq!(effective_port(0, None), 0, "两边都非法时不能 panic");
    }

    #[test]
    fn internal_address_wins_only_when_master_shares_the_network() {
        let input = TargetInput {
            server_address: "203.0.113.10",
            internal_address: Some(" 10.9.0.2 "),
            port: 443,
            public_port: Some(40001),
        };
        let internal = select_target(input, true);
        assert_eq!(internal.host, "10.9.0.2", "内网地址要 trim 后使用");
        assert_eq!(internal.port, 40001, "NAT 场景必须用 public_port");
        assert_eq!(internal.source, TargetSource::Internal);

        let public = select_target(input, false);
        assert_eq!(public.host, "203.0.113.10");
        assert_eq!(public.port, 40001);
        assert_eq!(public.source, TargetSource::Public);
    }

    #[test]
    fn blank_or_missing_internal_address_falls_back_to_public() {
        for internal in [None, Some(""), Some("   ")] {
            let target = select_target(
                TargetInput {
                    server_address: "203.0.113.10",
                    internal_address: internal,
                    port: 443,
                    public_port: None,
                },
                true,
            );
            assert_eq!(target.host, "203.0.113.10");
            assert_eq!(target.source, TargetSource::Public);
        }
    }

    #[test]
    fn same_lan_compares_ipv4_and_ipv6_subnets() {
        let interfaces = vec![
            v4([10, 0, 0, 2], 8),
            v4([192, 168, 1, 5], 24),
            v6(Ipv6Addr::new(0x2001, 0xdb8, 0, 1, 0, 0, 0, 2), 64),
        ];

        assert!(same_lan(Some("10.1.2.3"), &interfaces), "10/8 同网");
        assert!(same_lan(Some("192.168.1.99"), &interfaces), "同 /24");
        assert!(
            !same_lan(Some("192.168.2.99"), &interfaces),
            "不同 /24 不能算同网"
        );
        assert!(same_lan(Some("2001:db8:0:1::99"), &interfaces));
        assert!(!same_lan(Some("2001:db8:0:2::99"), &interfaces));
        assert!(!same_lan(Some("not-an-ip"), &interfaces));
        assert!(!same_lan(None, &interfaces));
        // 0.0.0.0 / prefix 0 的网卡不能匹配任何地址。
        assert!(!same_lan(Some("10.0.0.9"), &[v4([0, 0, 0, 0], 0)]));
        assert!(!same_lan(Some("10.0.0.9"), &[v4([10, 0, 0, 2], 0)]));
    }

    #[test]
    fn address_formats_ipv6_with_brackets() {
        assert_eq!(format_host_port("203.0.113.10", 443), "203.0.113.10:443");
        assert_eq!(
            format_host_port("hk.example.com", 443),
            "hk.example.com:443"
        );
        assert_eq!(format_host_port("2001:db8::1", 8443), "[2001:db8::1]:8443");
        assert_eq!(format_host_port(" 10.0.0.2 ", 80), "10.0.0.2:80");
    }

    #[test]
    fn io_errors_become_bilingual_reasons() {
        use std::io::ErrorKind;
        for (kind, zh, en) in [
            (ErrorKind::ConnectionRefused, "拒绝", "refused"),
            (ErrorKind::TimedOut, "超时", "timed out"),
            (
                ErrorKind::NetworkUnreachable,
                "网络不可达",
                "Network unreachable",
            ),
            (ErrorKind::HostUnreachable, "主机不可达", "Host unreachable"),
        ] {
            let message = describe_error(&std::io::Error::from(kind));
            assert!(message.contains(zh), "{kind:?}: {message}");
            assert!(message.contains(en), "{kind:?}: {message}");
        }
        let resolve = std::io::Error::other("failed to lookup address information");
        assert_eq!(
            describe_error(&resolve),
            "无法解析地址 / Could not resolve address"
        );
        assert!(
            describe_error(&std::io::Error::other("boom")).contains("连接失败"),
            "未知错误也要有可读兜底"
        );
    }

    #[test]
    fn audit_detail_has_result_but_never_the_address() {
        let success = result(true, 100);
        let detail = success.audit_detail();
        assert_eq!(detail["reachable"], true);
        assert_eq!(detail["latency_ms"], 7);
        assert!(
            detail.get("address").is_none(),
            "审计不能带地址明文：{detail}"
        );

        let failure = result(false, 100);
        let detail = failure.audit_detail();
        assert_eq!(detail["reachable"], false);
        assert!(detail["error"].as_str().unwrap().contains("超时"));
        assert!(detail.get("address").is_none());
    }

    #[tokio::test]
    async fn registry_dedupes_concurrent_probes_for_one_node() {
        let registry = Registry::new(Duration::from_secs(60));
        let calls = Arc::new(AtomicUsize::new(0));

        let first = {
            let registry = &registry;
            let calls = Arc::clone(&calls);
            async move {
                registry
                    .run("node-1", || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        async {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            result(true, 111)
                        }
                    })
                    .await
            }
        };
        let second = {
            let registry = &registry;
            let calls = Arc::clone(&calls);
            async move {
                registry
                    .run("node-1", || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        async { result(true, 222) }
                    })
                    .await
            }
        };
        let ((first, first_fresh), (second, second_fresh)) = tokio::join!(first, second);

        assert_eq!(calls.load(Ordering::SeqCst), 1, "并发只能真的连一次");
        assert!(first_fresh, "先到的请求负责真实探测");
        assert!(!second_fresh, "后到的请求复用结果");
        assert_eq!(first.checked_at, second.checked_at);
        assert_eq!(registry.len(), 1);
    }

    #[tokio::test]
    async fn registry_reuses_within_the_window_and_reprobes_after_it() {
        // 窗口设得足够短：第一次在窗口内复用，睡过窗口后重新探测。
        let registry = Registry::new(Duration::from_millis(30));
        let calls = Arc::new(AtomicUsize::new(0));
        let probe = || {
            let calls = Arc::clone(&calls);
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                result(true, calls.load(Ordering::SeqCst) as i64)
            }
        };

        let (first, fresh) = registry.run("node-1", probe).await;
        assert!(fresh);
        let (cached, fresh) = registry.run("node-1", probe).await;
        assert!(!fresh, "窗口内必须复用");
        assert_eq!(first.checked_at, cached.checked_at);

        tokio::time::sleep(Duration::from_millis(40)).await;
        let (again, fresh) = registry.run("node-1", probe).await;
        assert!(fresh, "窗口过期后重新探测");
        assert_eq!(again.checked_at, 2);

        // 不同节点互不影响。
        let (_other, fresh) = registry.run("node-2", probe).await;
        assert!(fresh);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
}
