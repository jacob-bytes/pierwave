//! 登录失败告警的进程内计数。
//!
//! 判定规则（与设置页文案一致）：
//! * 同一用户名在 **10 分钟** 窗口内连续失败达到 `login_max_attempts`
//!   （默认 5，与登录限流共用同一个设置项）时，触发**一次** `login_failed`；
//! * 成功登录或窗口过期后计数清零；触发后同一窗口内不再重复触发
//!   （渠道层的 `alert_cooldown_secs` 是第二道保险）；
//! * 状态放进程内：重启只可能让一条告警多发一次，不会漏发；这与现有
//!   告警去抖的取舍一致，不值得为通知功能加一张热写表。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 连续失败统计窗口：10 分钟。
pub const LOGIN_FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);

const MAX_TRACKED_USERS: usize = 1024;

#[derive(Debug, Clone, Copy)]
struct Window {
    count: u32,
    started: Instant,
}

#[derive(Clone, Default)]
pub struct LoginWatch {
    windows: Arc<Mutex<HashMap<String, Window>>>,
}

impl LoginWatch {
    /// 记录一次失败；返回 `true` 表示本次刚好达到阈值，调用方应发一条告警。
    pub fn record_failure(&self, username: &str, threshold: u32, window: Duration) -> bool {
        self.record_failure_at(username, threshold, window, Instant::now())
    }

    /// 成功登录后清零该用户名的连续失败计数。
    pub fn clear(&self, username: &str) {
        self.windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(username);
    }

    /// 内部/测试入口：显式传入当前时刻，便于验证窗口边界。
    fn record_failure_at(
        &self,
        username: &str,
        threshold: u32,
        window: Duration,
        now: Instant,
    ) -> bool {
        let threshold = threshold.max(1);
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if windows.len() >= MAX_TRACKED_USERS && !windows.contains_key(username) {
            windows.clear();
        }

        let entry = windows.entry(username.to_string()).or_insert(Window {
            count: 0,
            started: now,
        });
        if now.saturating_duration_since(entry.started) >= window {
            entry.count = 0;
            entry.started = now;
        }
        entry.count = entry.count.saturating_add(1);
        entry.count == threshold
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THRESHOLD: u32 = 5;

    fn at(now: Instant, offset: Duration) -> Instant {
        now.checked_sub(offset).unwrap()
    }

    #[test]
    fn alert_fires_exactly_once_at_the_threshold() {
        let watch = LoginWatch::default();
        let now = Instant::now();

        for count in 1..THRESHOLD {
            assert!(
                !watch.record_failure_at("alice", THRESHOLD, LOGIN_FAILURE_WINDOW, now),
                "第 {count} 次失败不应告警"
            );
        }
        assert!(
            watch.record_failure_at("alice", THRESHOLD, LOGIN_FAILURE_WINDOW, now),
            "第 {THRESHOLD} 次失败必须告警"
        );
        assert!(
            !watch.record_failure_at("alice", THRESHOLD, LOGIN_FAILURE_WINDOW, now),
            "同一窗口内只告警一次"
        );
    }

    #[test]
    fn success_clears_the_counter() {
        let watch = LoginWatch::default();
        let now = Instant::now();

        for _ in 0..THRESHOLD - 1 {
            watch.record_failure_at("alice", THRESHOLD, LOGIN_FAILURE_WINDOW, now);
        }
        watch.clear("alice");
        for count in 1..THRESHOLD {
            assert!(
                !watch.record_failure_at("alice", THRESHOLD, LOGIN_FAILURE_WINDOW, now),
                "清零后第 {count} 次不应告警"
            );
        }
        assert!(
            watch.record_failure_at("alice", THRESHOLD, LOGIN_FAILURE_WINDOW, now),
            "清零后重新累计到阈值仍要告警"
        );
    }

    #[test]
    fn window_expiry_resets_the_counter() {
        let watch = LoginWatch::default();
        let start = Instant::now();

        for _ in 0..THRESHOLD - 1 {
            watch.record_failure_at("alice", THRESHOLD, LOGIN_FAILURE_WINDOW, start);
        }
        let later = start + LOGIN_FAILURE_WINDOW + Duration::from_secs(1);
        assert!(
            !watch.record_failure_at("bob", THRESHOLD, LOGIN_FAILURE_WINDOW, start),
            "另一个用户名独立计数"
        );
        assert!(
            !watch.record_failure_at("alice", THRESHOLD, LOGIN_FAILURE_WINDOW, later),
            "窗口过期后重新从 1 开始"
        );
        for _ in 0..THRESHOLD - 2 {
            watch.record_failure_at("alice", THRESHOLD, LOGIN_FAILURE_WINDOW, later);
        }
        assert!(
            watch.record_failure_at("alice", THRESHOLD, LOGIN_FAILURE_WINDOW, later),
            "新窗口内重新达到阈值应再次告警"
        );
    }

    #[test]
    fn usernames_are_independent_and_threshold_one_works() {
        let watch = LoginWatch::default();
        let now = Instant::now();

        assert!(watch.record_failure_at("alice", 1, LOGIN_FAILURE_WINDOW, now));
        assert!(watch.record_failure_at("bob", 1, LOGIN_FAILURE_WINDOW, now));
        assert!(
            !watch.record_failure_at("alice", 1, LOGIN_FAILURE_WINDOW, now),
            "各自只发一次"
        );
        // 阈值 0 按 1 处理，不能出现「永远不告警」。
        assert!(watch.record_failure_at(
            "carol",
            0,
            LOGIN_FAILURE_WINDOW,
            at(now, Duration::from_secs(1))
        ));
    }
}
