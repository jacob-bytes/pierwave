//! 本机到公网探测目标的 TCP 握手 RTT。
//!
//! 只做一件事：定时 `connect_timeout` 一个 TCP 端口，把毫秒数缓存进内存。
//! 心跳只读缓存，永远不会等探测完成；探测失败缓存 `None`，绝不写 0。
//!
//! 为什么不用 ICMP：raw socket 需要 root/CAP_NET_RAW，容器里通常没有；
//! TCP 握手只要普通 socket，能覆盖「这台机器到公网是否通、握手多快」。

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 缓存值 0 表示「没有有效 RTT」；实际毫秒数从 1 起。
const NO_VALUE: u64 = 0;

/// 测量一次到 `addr` 的 TCP 握手 RTT（毫秒）。
///
/// 解析出的地址会依次尝试，总预算不超过 `timeout`；
/// 任一地址握手成功即返回。失败、超时、解析失败都返回 `None`。
///
/// 成功但不足 1ms（本机 loopback）也会向上取到 1ms：接口上 0 会被读成
/// 「极快」，而 1ms 至少是一个诚实的最小值。
pub fn measure(addr: &str, timeout: Duration) -> Option<u32> {
    let timeout = timeout.max(Duration::from_millis(1));
    let addresses: Vec<_> = addr.to_socket_addrs().ok()?.collect();
    let deadline = Instant::now() + timeout;

    for socket in addresses {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        if remaining.is_zero() {
            break;
        }
        let started = Instant::now();
        if TcpStream::connect_timeout(&socket, remaining).is_ok() {
            let millis = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
            return Some(millis.max(1));
        }
    }
    None
}

/// 同 [`measure`]，但目标用 `(host, port)` 表示，避免 IPv6 地址手工拼方括号。
///
/// 端口非法（越界）或解析失败都返回 `None`，与「目标不可达」同义。
pub fn measure_target(target_host: &str, target_port: i64, timeout: Duration) -> Option<u32> {
    let port = u16::try_from(target_port).ok()?;
    let host = target_host.trim();
    if host.is_empty() {
        return None;
    }
    let addr = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    measure(&addr, timeout)
}

/// 心跳可无锁读取的最近一次测量结果。
#[derive(Debug, Default)]
pub struct ProbeCache {
    latency_ms: AtomicU64,
}

impl ProbeCache {
    pub fn store(&self, latency_ms: Option<u32>) {
        let value = latency_ms.map(u64::from).unwrap_or(NO_VALUE);
        self.latency_ms.store(value, Ordering::Relaxed);
    }

    pub fn load(&self) -> Option<u32> {
        let value = self.latency_ms.load(Ordering::Relaxed);
        u32::try_from(value).ok().filter(|value| *value != 0)
    }
}

/// 启动后台探测任务，立即测一次，之后每隔 `interval_secs` 测一次。
///
/// 真正的阻塞 connect 放在 `spawn_blocking` 里，并用 `tokio::time::timeout`
/// 兜住 DNS 解析等不受 `connect_timeout` 约束的部分；心跳只读 `ProbeCache`，
/// 不会因为探测卡住而延迟。
pub fn spawn(target: String, timeout_ms: u64, interval_secs: u64) -> Arc<ProbeCache> {
    let cache = Arc::new(ProbeCache::default());
    let writer = Arc::clone(&cache);
    let timeout = Duration::from_millis(timeout_ms.max(1));
    let interval = Duration::from_secs(interval_secs.max(1));

    tokio::spawn(async move {
        loop {
            let probe_target = target.clone();
            let measured = tokio::time::timeout(
                // connect 本身受 timeout 约束，额外给调度/解析留一点余量。
                timeout + Duration::from_millis(250),
                tokio::task::spawn_blocking(move || measure(&probe_target, timeout)),
            )
            .await
            .ok()
            .and_then(Result::ok)
            .flatten();

            writer.store(measured);
            match measured {
                Some(ms) => tracing::debug!(target = %target, latency_ms = ms, "probe ok"),
                None => tracing::debug!(target = %target, "probe failed; reporting null"),
            }

            tokio::time::sleep(interval).await;
        }
    });

    cache
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use super::*;

    #[test]
    fn measure_reports_rtt_to_a_listening_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let measured = measure(&addr.to_string(), Duration::from_millis(500));
        assert!(
            measured.is_some(),
            "本地监听端口应该能完成 TCP 握手：{addr}"
        );
        assert!(measured.unwrap() >= 1, "成功路径不能报告 0ms");
    }

    #[test]
    fn measure_returns_none_for_a_refused_port() {
        let addr = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap()
            // listener 在这里 drop，端口没有进程监听，握手必然失败。
        };

        assert_eq!(
            measure(&addr.to_string(), Duration::from_millis(500)),
            None,
            "失败必须返回 None，不能是 0"
        );
    }

    #[test]
    fn measure_returns_none_for_unparsable_target() {
        assert_eq!(measure("", Duration::from_millis(500)), None);
    }

    #[test]
    fn measure_target_uses_host_and_port_without_manual_brackets() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(measure_target("127.0.0.1", i64::from(port), Duration::from_millis(500)).is_some());
        assert_eq!(
            measure_target("127.0.0.1", 0, Duration::from_millis(500)),
            None
        );
        assert_eq!(
            measure_target("", i64::from(port), Duration::from_millis(500)),
            None
        );
        assert_eq!(
            measure_target("127.0.0.1", 65536, Duration::from_millis(500)),
            None,
            "非法端口不能当成可达"
        );
    }

    #[test]
    fn cache_distinguishes_none_from_zero_and_roundtrips() {
        let cache = ProbeCache::default();
        assert_eq!(cache.load(), None);
        cache.store(Some(23));
        assert_eq!(cache.load(), Some(23));
        cache.store(None);
        assert_eq!(cache.load(), None, "失败必须清成 None");
        cache.store(Some(0));
        assert_eq!(cache.load(), None, "0 不是合法 RTT，不能当成极快");
    }
}
