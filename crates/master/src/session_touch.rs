//! 会话 `last_seen_at` 的低频写回节流。
//!
//! 鉴权提取器每个请求都会经过，但「最近活跃」不需要精确到请求：默认 60 秒
//! 最多写一次库。节流状态放在进程内，主控重启后第一次请求会补写一次，
//! 这是可接受的（只多一次写，不会漏掉活跃时间）。
//!
//! 除了内存时间表，还会参考数据库里的 `last_seen_at`：多实例/刚重启时，
//! 即使内存表是空的，也不会对同一条会话重复写。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 默认写回间隔：60 秒。
pub const DEFAULT_SESSION_TOUCH_INTERVAL: Duration = Duration::from_secs(60);

/// 内存表上限；超过时直接清空（最坏每个会话多写一次库）。
const MAX_TRACKED_SESSIONS: usize = 4096;

#[derive(Clone)]
pub struct SessionTouch {
    interval: Duration,
    seen: Arc<Mutex<HashMap<String, Instant>>>,
}

impl Default for SessionTouch {
    fn default() -> Self {
        Self::new(DEFAULT_SESSION_TOUCH_INTERVAL)
    }
}

impl SessionTouch {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            seen: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 测试用：把间隔压到 0，强制每个请求都写。
    #[cfg(test)]
    pub fn always_touch() -> Self {
        Self::new(Duration::ZERO)
    }

    /// 是否应该把这条会话的 `last_seen_at` 写成 `now`。
    ///
    /// 返回 `true` 时调用方负责真正落库；返回 `false` 表示还在节流窗口内。
    /// `last_seen_at` 是数据库里的值（老会话可能为空）。
    pub fn should_touch(&self, session_id: &str, last_seen_at: Option<i64>, now: i64) -> bool {
        let current = Instant::now();
        let interval_secs = i64::try_from(self.interval.as_secs()).unwrap_or(i64::MAX);
        let mut seen = self
            .seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if seen
            .get(session_id)
            .is_some_and(|at| current.saturating_duration_since(*at) < self.interval)
        {
            return false;
        }

        // 数据库里已经足够新：只记内存，避免重启/多实例时重复写。
        if last_seen_at.is_some_and(|last| now.saturating_sub(last) < interval_secs) {
            seen.insert(session_id.to_string(), current);
            return false;
        }

        if seen.len() >= MAX_TRACKED_SESSIONS {
            seen.clear();
        }
        seen.insert(session_id.to_string(), current);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttles_repeated_touches_within_the_interval() {
        let touch = SessionTouch::new(Duration::from_secs(60));
        let now = 1_700_000_000;

        assert!(touch.should_touch("session-a", None, now), "第一次必须写");
        assert!(
            !touch.should_touch("session-a", None, now),
            "窗口内不能重复写"
        );
        // 其它会话互不影响。
        assert!(touch.should_touch("session-b", None, now));
    }

    #[test]
    fn recent_database_value_skips_the_write_after_a_restart() {
        let now = 1_700_000_000;

        // 重启后内存表为空：只看数据库的 last_seen_at。
        let fresh = SessionTouch::new(Duration::from_secs(60));
        assert!(
            !fresh.should_touch("session-a", Some(now - 10), now),
            "库里 10 秒前刚写过，不再写"
        );
        let restarted = SessionTouch::new(Duration::from_secs(60));
        assert!(
            restarted.should_touch("session-a", Some(now - 120), now),
            "超过窗口的库值必须更新"
        );
    }

    #[test]
    fn zero_interval_writes_every_time() {
        let touch = SessionTouch::always_touch();
        assert!(touch.should_touch("session-a", Some(1_700_000_000), 1_700_000_000));
        assert!(touch.should_touch("session-a", Some(1_700_000_000), 1_700_000_000));
    }
}
