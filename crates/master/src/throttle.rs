//! 登录失败限流：进程内计数，主控重启即清空。
//!
//! 维度同时看「账号」和「客户端 IP」：一次失败会同时计入
//! `(用户名, IP)`、`用户名`、`IP` 三个桶，任一桶在窗口内达到阈值就锁定。
//! 这样既能拦住单 IP 撞多账号，也能拦住单账号被多 IP 撞。
//!
//! 只在内存里放，不落库：
//! - 单主控部署下没有跨进程一致性问题；
//! - 重启后锁自然解除，管理员可以通过重启自救（可接受，见 docs/PLAN.md §1）。
//!
//! 计数的窗口时长与锁定时长一致（设置项只有 `login_lock_secs`），
//! 每条记录都带最后访问时间，超过「窗口 + 60 秒」且已解锁的条目会在
//! 每次 `check` / `record_failure` 时被清掉，避免 map 无限增长。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// 默认「窗口内失败次数」上限；与 `routes::settings` 的默认值保持一致。
pub const DEFAULT_MAX_ATTEMPTS: u32 = 5;
/// 默认锁定 15 分钟。
pub const DEFAULT_LOCK_SECS: u64 = 900;

/// 一次登录尝试的限流键。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Key {
    pub username: String,
    pub ip: String,
}

impl Key {
    pub fn new(username: impl Into<String>, ip: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            ip: ip.into(),
        }
    }
}

/// 三个聚合维度；`Pair` 是调用方传入的原始键，另外两个用于跨 IP / 跨账号聚合。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Scope {
    Pair,
    Account,
    Address,
}

/// 实际参与计数的 map key。聚合维度的另一半用 `AGGREGATE` 占位。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct EntryKey {
    scope: Scope,
    username: String,
    ip: String,
}

/// 用户名最短 3 字符、IP 不可能是这个占位符，所以不会与真实键冲突。
const AGGREGATE: &str = "*";

#[derive(Debug, Clone)]
struct Entry {
    failures: u32,
    window_started: Instant,
    locked_until: Option<Instant>,
    last_seen: Instant,
}

struct Inner {
    entries: HashMap<EntryKey, Entry>,
    max_attempts: u32,
    window: Duration,
    lock: Duration,
}

impl Inner {
    /// 清掉「已解锁且超过窗口 + 60 秒没活动」的条目。
    fn purge(&mut self, now: Instant) {
        let retain = self.window.max(self.lock) + Duration::from_secs(60);
        self.entries.retain(|_, entry| {
            let unlocked = entry.locked_until.is_none_or(|until| now >= until);
            !(unlocked && now.saturating_duration_since(entry.last_seen) > retain)
        });
    }
}

/// 登录限流器；`Arc` 由 `AppState` 持有，所有请求共享同一份计数。
pub struct LoginThrottle {
    inner: Mutex<Inner>,
}

impl Default for LoginThrottle {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_ATTEMPTS, DEFAULT_LOCK_SECS)
    }
}

impl LoginThrottle {
    pub fn new(max_attempts: u32, lock_secs: u64) -> Self {
        let lock = Duration::from_secs(lock_secs.max(1));
        Self {
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
                // 设置页已做范围校验；这里再兜一次底，避免 0 次失败就永久锁。
                max_attempts: max_attempts.max(1),
                window: lock,
                lock,
            }),
        }
    }

    /// 每次登录前用当前设置刷新阈值；设置页改了立即生效。
    ///
    /// 已存在的锁不会因为调大时长而延长或缩短，锁到期后按新阈值重新计数。
    pub fn configure(&self, max_attempts: u32, lock_secs: u64) {
        let mut inner = self.lock();
        let lock = Duration::from_secs(lock_secs.max(1));
        inner.max_attempts = max_attempts.max(1);
        inner.window = lock;
        inner.lock = lock;
    }

    /// 已锁定时返回建议的重试秒数（`Retry-After`）。
    pub fn check(&self, key: &Key) -> Result<(), u64> {
        self.check_at(key, Instant::now())
    }

    /// 记录一次失败；达到阈值时立即锁定。
    pub fn record_failure(&self, key: &Key) {
        self.record_failure_at(key, Instant::now());
    }

    /// 登录成功后清空与该账号/该 IP 相关的全部计数。
    pub fn clear(&self, key: &Key) {
        self.clear_at(key, Instant::now());
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn check_at(&self, key: &Key, now: Instant) -> Result<(), u64> {
        let mut inner = self.lock();
        let max_attempts = inner.max_attempts;
        let lock = inner.lock;
        inner.purge(now);

        let mut retry_after = 0u64;
        for entry_key in scopes_for(key) {
            let Some(entry) = inner.entries.get_mut(&entry_key) else {
                continue;
            };

            if let Some(until) = entry.locked_until {
                if now >= until {
                    // 锁已过期：计数归零，允许重新尝试。
                    entry.failures = 0;
                    entry.window_started = now;
                    entry.locked_until = None;
                } else {
                    retry_after = retry_after.max(seconds_until(until, now));
                    continue;
                }
            }

            // 设置页把阈值调低后，历史计数可能已经越线：下一轮直接锁。
            if entry.failures >= max_attempts {
                let until = now + lock;
                entry.locked_until = Some(until);
                entry.last_seen = now;
                retry_after = retry_after.max(seconds_until(until, now));
            }
        }

        if retry_after == 0 {
            Ok(())
        } else {
            Err(retry_after)
        }
    }

    fn record_failure_at(&self, key: &Key, now: Instant) {
        let mut inner = self.lock();
        let max_attempts = inner.max_attempts;
        let lock = inner.lock;
        let window = inner.window;
        inner.purge(now);

        for entry_key in scopes_for(key) {
            let entry = inner.entries.entry(entry_key).or_insert_with(|| Entry {
                failures: 0,
                window_started: now,
                locked_until: None,
                last_seen: now,
            });
            entry.last_seen = now;

            if entry.locked_until.is_some_and(|until| now >= until) {
                // 锁过期后的第一次失败：重新开一个窗口。
                entry.failures = 0;
                entry.window_started = now;
                entry.locked_until = None;
            }
            if entry.locked_until.is_none()
                && now.saturating_duration_since(entry.window_started) >= window
            {
                // 窗口已过：旧失败不再累计。
                entry.failures = 0;
                entry.window_started = now;
            }

            entry.failures = entry.failures.saturating_add(1);
            if entry.failures >= max_attempts {
                entry.locked_until = Some(now + lock);
            }
        }
    }

    fn clear_at(&self, key: &Key, now: Instant) {
        let mut inner = self.lock();
        for entry_key in scopes_for(key) {
            inner.entries.remove(&entry_key);
        }
        inner.purge(now);
    }
}

fn scopes_for(key: &Key) -> [EntryKey; 3] {
    [
        EntryKey {
            scope: Scope::Pair,
            username: key.username.clone(),
            ip: key.ip.clone(),
        },
        EntryKey {
            scope: Scope::Account,
            username: key.username.clone(),
            ip: AGGREGATE.to_string(),
        },
        EntryKey {
            scope: Scope::Address,
            username: AGGREGATE.to_string(),
            ip: key.ip.clone(),
        },
    ]
}

fn seconds_until(until: Instant, now: Instant) -> u64 {
    let remaining = until.saturating_duration_since(now);
    remaining.as_millis().div_ceil(1000).max(1) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(username: &str, ip: &str) -> Key {
        Key::new(username, ip)
    }

    fn at(base: Instant, secs: u64) -> Instant {
        base + Duration::from_secs(secs)
    }

    #[test]
    fn repeated_failures_lock_the_key_and_report_retry_after() {
        let throttle = LoginThrottle::new(5, 900);
        let now = Instant::now();
        let key = key("admin", "10.0.0.1");

        for _ in 0..4 {
            throttle.record_failure_at(&key, now);
        }
        assert_eq!(throttle.check_at(&key, now), Ok(()), "4 次失败还不该锁");

        throttle.record_failure_at(&key, now);
        let retry = throttle.check_at(&key, now).unwrap_err();
        assert_eq!(retry, 900, "刚锁定时应提示完整 900 秒");
        assert_eq!(
            throttle.check_at(&key, at(now, 300)).unwrap_err(),
            600,
            "过了 5 分钟，剩余应递减"
        );
    }

    #[test]
    fn success_clears_all_failure_counters() {
        let throttle = LoginThrottle::new(5, 900);
        let now = Instant::now();
        let key = key("admin", "10.0.0.1");

        for _ in 0..4 {
            throttle.record_failure_at(&key, now);
        }
        throttle.clear_at(&key, now);
        assert_eq!(throttle.check_at(&key, now), Ok(()));

        // 清零后再积累 4 次仍然不到阈值。
        for _ in 0..4 {
            throttle.record_failure_at(&key, now);
        }
        assert_eq!(
            throttle.check_at(&key, now),
            Ok(()),
            "成功登录应让失败计数从头开始"
        );
    }

    #[test]
    fn lock_expires_after_the_window() {
        let throttle = LoginThrottle::new(5, 60);
        let now = Instant::now();
        let key = key("admin", "10.0.0.1");

        for _ in 0..5 {
            throttle.record_failure_at(&key, now);
        }
        assert!(
            throttle.check_at(&key, at(now, 59)).is_err(),
            "锁定期内仍拒绝"
        );
        assert_eq!(
            throttle.check_at(&key, at(now, 60)),
            Ok(()),
            "锁定时间到点后自动解锁"
        );

        // 解锁后第一次失败重新计数，不会因为旧账立刻再锁。
        throttle.record_failure_at(&key, at(now, 61));
        assert_eq!(throttle.check_at(&key, at(now, 61)), Ok(()));
    }

    #[test]
    fn failures_spread_beyond_the_window_do_not_lock() {
        let throttle = LoginThrottle::new(5, 60);
        let now = Instant::now();
        let key = key("admin", "10.0.0.1");

        for _ in 0..4 {
            throttle.record_failure_at(&key, now);
        }
        // 窗口按最后一次窗口起点算：61 秒后旧的 4 次作废。
        throttle.record_failure_at(&key, at(now, 61));
        assert_eq!(
            throttle.check_at(&key, at(now, 61)),
            Ok(()),
            "跨窗口的 5 次失败不应触发锁定"
        );
    }

    #[test]
    fn one_account_from_many_ips_and_one_ip_for_many_accounts_both_lock() {
        let throttle = LoginThrottle::new(5, 900);
        let now = Instant::now();

        // 单账号被多 IP 撞：3 + 2 次来自不同 IP，账号维度到 5。
        for ip in ["10.0.0.1", "10.0.0.1", "10.0.0.1", "10.0.0.2", "10.0.0.2"] {
            throttle.record_failure_at(&key("admin", ip), now);
        }
        assert!(
            throttle.check_at(&key("admin", "10.0.0.99"), now).is_err(),
            "换 IP 也要能锁住同一个账号"
        );

        // 单 IP 撞多账号：3 + 2 次不同用户名，IP 维度到 5。
        let throttle = LoginThrottle::new(5, 900);
        for username in ["alice", "alice", "alice", "bob", "bob"] {
            throttle.record_failure_at(&key(username, "10.0.0.7"), now);
        }
        assert!(
            throttle.check_at(&key("charlie", "10.0.0.7"), now).is_err(),
            "同一 IP 换用户名也要被限流"
        );
    }

    #[test]
    fn stale_entries_are_purged() {
        let throttle = LoginThrottle::new(5, 60);
        let now = Instant::now();

        throttle.record_failure_at(&key("admin", "10.0.0.1"), now);
        assert_eq!(throttle.lock().entries.len(), 3, "一次失败对应三个维度桶");

        // 很久以后来一次新请求：旧条目应被窗口清理掉。
        let later = at(now, 24 * 3600);
        let _ = throttle.check_at(&key("someone", "10.0.0.2"), later);
        assert!(
            throttle.lock().entries.is_empty(),
            "过期条目必须被清理，避免 map 无限增长"
        );
    }

    #[test]
    fn lowering_the_threshold_locks_existing_counters() {
        let throttle = LoginThrottle::new(5, 900);
        let now = Instant::now();
        let key = key("admin", "10.0.0.1");

        for _ in 0..3 {
            throttle.record_failure_at(&key, now);
        }
        throttle.configure(2, 900);
        assert!(
            throttle.check_at(&key, now).is_err(),
            "阈值调低后旧计数立即生效"
        );
    }
}
