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

/// map 条目硬上限。每个失败最多写 3 个桶，5000 个不同用户名就能写出 1 万条；
/// 不设上限时，攻击者可以靠换用户名/换 IP 把主控内存打满。
const MAX_ENTRIES: usize = 4096;

/// 超过上限时一次淘汰到 3/4，避免每来一个请求就做一次全表排序。
const EVICT_TARGET: usize = MAX_ENTRIES * 3 / 4;

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

    /// 超过硬上限时按「最久未活动」淘汰到 3/4。
    ///
    /// 排序键先看锁定状态：**已锁定的条目排到最后淘汰**。否则攻击者只要灌满
    /// 一堆新用户名，就能把 `admin` 的锁定记录挤掉，限流形同虚设。若表里全是
    /// 锁定条目（极端情况），仍然淘汰最旧的，保证内存不会无界增长。
    fn enforce_entry_limit(&mut self, now: Instant) {
        if self.entries.len() <= MAX_ENTRIES {
            return;
        }
        let candidates: Vec<(bool, Instant, EntryKey)> = self
            .entries
            .iter()
            .map(|(key, entry)| {
                let locked = entry.locked_until.is_some_and(|until| now < until);
                (locked, entry.last_seen, key.clone())
            })
            .collect();
        let remove = self.entries.len().saturating_sub(EVICT_TARGET);
        for key in oldest_keys(candidates, remove) {
            self.entries.remove(&key);
        }
    }
}

/// 淘汰候选：先排「未锁定」，同组内按最久未活动。
///
/// [`LoginThrottle`] 与 [`IpThrottle`] 共用这一份排序，避免两处淘汰语义漂移。
fn oldest_keys<K: Clone>(mut candidates: Vec<(bool, Instant, K)>, remove: usize) -> Vec<K> {
    candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    candidates
        .into_iter()
        .take(remove)
        .map(|(_, _, key)| key)
        .collect()
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

    /// 当前 map 里的条目数；只给测试断言「表有上限」用。
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().entries.len()
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

        inner.enforce_entry_limit(now);
    }

    fn clear_at(&self, key: &Key, now: Instant) {
        let mut inner = self.lock();
        for entry_key in scopes_for(key) {
            inner.entries.remove(&entry_key);
        }
        inner.purge(now);
    }
}

/// 认证失败按 IP 限流的默认阈值：10 分钟内 20 次。
pub const IP_MAX_FAILURES: u32 = 20;
/// 计数窗口（同时是锁定时长）：10 分钟。
pub const IP_WINDOW_SECS: u64 = 600;

/// 单个 IP 的失败计数。
#[derive(Debug, Clone)]
struct IpEntry {
    failures: u32,
    window_started: Instant,
    locked_until: Option<Instant>,
    last_seen: Instant,
}

struct IpInner {
    entries: HashMap<String, IpEntry>,
    max_failures: u32,
    window: Duration,
}

impl IpInner {
    /// 清掉「已解锁且超过窗口 + 60 秒没活动」的条目，避免 map 无限增长。
    fn purge(&mut self, now: Instant) {
        let retain = self.window + Duration::from_secs(60);
        self.entries.retain(|_, entry| {
            let unlocked = entry.locked_until.is_none_or(|until| now >= until);
            !(unlocked && now.saturating_duration_since(entry.last_seen) > retain)
        });
    }

    /// 与 [`LoginThrottle`] 相同的淘汰策略：先淘汰未锁定、最久未活动的条目。
    fn enforce_entry_limit(&mut self, now: Instant) {
        if self.entries.len() <= MAX_ENTRIES {
            return;
        }
        let candidates: Vec<(bool, Instant, String)> = self
            .entries
            .iter()
            .map(|(ip, entry)| {
                let locked = entry.locked_until.is_some_and(|until| now < until);
                (locked, entry.last_seen, ip.clone())
            })
            .collect();
        let remove = self.entries.len().saturating_sub(EVICT_TARGET);
        for ip in oldest_keys(candidates, remove) {
            self.entries.remove(&ip);
        }
    }
}

/// 认证失败按客户端 IP 限流。
///
/// 覆盖两类此前没有 IP 维度的入口：`Authorization: Bearer` 认证失败与 Agent
/// WebSocket Hello 的 token 校验失败。与 [`LoginThrottle`] 同一套取舍：
///
/// * 只存进程内存，重启清零（单主控部署，重启也是管理员的自救手段）；
/// * 表有 [`MAX_ENTRIES`] 硬上限，灌表不能挤掉已锁定的 IP；
/// * 窗口与锁定时长一致，直到多打一次失败才重新开窗。
pub struct IpThrottle {
    inner: Mutex<IpInner>,
}

impl Default for IpThrottle {
    fn default() -> Self {
        Self::new(IP_MAX_FAILURES, IP_WINDOW_SECS)
    }
}

impl IpThrottle {
    pub fn new(max_failures: u32, window_secs: u64) -> Self {
        let window = Duration::from_secs(window_secs.max(1));
        Self {
            inner: Mutex::new(IpInner {
                entries: HashMap::new(),
                max_failures: max_failures.max(1),
                window,
            }),
        }
    }

    /// 已锁定时返回建议的重试秒数（`Retry-After`）。
    pub fn check(&self, ip: &str) -> Result<(), u64> {
        self.check_at(ip, Instant::now())
    }

    /// 记录一次认证失败；达到阈值时立即锁定该 IP。
    pub fn record_failure(&self, ip: &str) {
        self.record_failure_at(ip, Instant::now());
    }

    /// 认证成功后清空该 IP 的失败计数。
    pub fn clear(&self, ip: &str) {
        self.clear_at(ip, Instant::now());
    }

    /// 当前 map 里的条目数；只给测试断言「表有上限」用。
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().entries.len()
    }

    fn lock(&self) -> MutexGuard<'_, IpInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn check_at(&self, ip: &str, now: Instant) -> Result<(), u64> {
        let mut inner = self.lock();
        inner.purge(now);

        let Some(entry) = inner.entries.get_mut(ip) else {
            return Ok(());
        };
        let Some(until) = entry.locked_until else {
            return Ok(());
        };
        if now >= until {
            // 锁过期：计数归零，允许重新尝试。
            entry.failures = 0;
            entry.window_started = now;
            entry.locked_until = None;
            return Ok(());
        }
        Err(seconds_until(until, now))
    }

    fn record_failure_at(&self, ip: &str, now: Instant) {
        let mut inner = self.lock();
        let max_failures = inner.max_failures;
        let window = inner.window;
        inner.purge(now);

        let entry = inner
            .entries
            .entry(ip.to_string())
            .or_insert_with(|| IpEntry {
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
        if entry.failures >= max_failures {
            entry.locked_until = Some(now + window);
        }

        inner.enforce_entry_limit(now);
    }

    fn clear_at(&self, ip: &str, now: Instant) {
        let mut inner = self.lock();
        inner.entries.remove(ip);
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

    /// 攻击者可以无限换用户名：map 必须有硬上限，否则内存会随请求数线性增长。
    #[test]
    fn entry_map_stays_bounded_under_a_username_flood() {
        let throttle = LoginThrottle::new(5, 900);
        let now = Instant::now();

        for index in 0..5000 {
            throttle.record_failure_at(&key(&format!("flood-{index}"), "10.0.0.1"), now);
        }

        assert!(
            throttle.len() <= 4096,
            "5000 个不同用户名后 map 仍有 {} 条，必须有硬上限",
            throttle.len()
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

    // ---- 按 IP 的认证失败限流（Bearer / Agent Hello） ----

    #[test]
    fn ip_throttle_locks_after_twenty_failures_within_the_window() {
        let throttle = IpThrottle::new(IP_MAX_FAILURES, IP_WINDOW_SECS);
        let now = Instant::now();
        let ip = "203.0.113.5";

        for _ in 0..IP_MAX_FAILURES - 1 {
            throttle.record_failure_at(ip, now);
        }
        assert_eq!(
            throttle.check_at(ip, now),
            Ok(()),
            "{} 次失败还不该锁",
            IP_MAX_FAILURES - 1
        );

        throttle.record_failure_at(ip, now);
        assert_eq!(
            throttle.check_at(ip, now),
            Err(IP_WINDOW_SECS),
            "达到阈值后应立即锁定并提示完整窗口"
        );
        assert_eq!(
            throttle.check_at(ip, at(now, 300)).unwrap_err(),
            300,
            "剩余时间必须递减"
        );
        assert_eq!(
            throttle.check_at(ip, at(now, IP_WINDOW_SECS)),
            Ok(()),
            "窗口结束后自动解锁"
        );
    }

    #[test]
    fn ip_success_clears_the_counter_for_that_address_only() {
        let throttle = IpThrottle::new(IP_MAX_FAILURES, IP_WINDOW_SECS);
        let now = Instant::now();
        let ip = "198.51.100.7";

        for _ in 0..IP_MAX_FAILURES - 1 {
            throttle.record_failure_at(ip, now);
        }
        throttle.clear_at(ip, now);
        for _ in 0..IP_MAX_FAILURES - 1 {
            throttle.record_failure_at(ip, now);
        }
        assert_eq!(
            throttle.check_at(ip, now),
            Ok(()),
            "成功认证清零后必须从头计数"
        );
    }

    #[test]
    fn ip_failures_are_isolated_per_address() {
        let throttle = IpThrottle::new(IP_MAX_FAILURES, IP_WINDOW_SECS);
        let now = Instant::now();

        for _ in 0..IP_MAX_FAILURES {
            throttle.record_failure_at("10.0.0.1", now);
        }
        assert!(throttle.check_at("10.0.0.1", now).is_err(), "该 IP 应被锁");

        assert_eq!(
            throttle.check_at("10.0.0.2", now),
            Ok(()),
            "别的 IP 不受影响"
        );
        // 别的 IP 成功一次也不能把被锁的 IP 解开。
        throttle.clear_at("10.0.0.2", now);
        assert!(
            throttle.check_at("10.0.0.1", now).is_err(),
            "清零必须只作用于同一个 IP"
        );
    }

    #[test]
    fn ip_failures_spread_beyond_the_window_do_not_lock() {
        let throttle = IpThrottle::new(IP_MAX_FAILURES, IP_WINDOW_SECS);
        let now = Instant::now();
        let ip = "192.0.2.9";

        for _ in 0..IP_MAX_FAILURES - 1 {
            throttle.record_failure_at(ip, now);
        }
        // 窗口过期后的又一次失败重新开窗，旧的 19 次不累计。
        throttle.record_failure_at(ip, at(now, IP_WINDOW_SECS + 1));
        assert_eq!(
            throttle.check_at(ip, at(now, IP_WINDOW_SECS + 1)),
            Ok(()),
            "跨窗口的失败不应触发锁定"
        );
    }

    /// 攻击者可以无限换 IP：map 必须有硬上限，否则内存随请求数线性增长。
    #[test]
    fn ip_entry_map_stays_bounded_under_a_flood() {
        let throttle = IpThrottle::new(IP_MAX_FAILURES, IP_WINDOW_SECS);
        let now = Instant::now();

        for index in 0..5000 {
            throttle.record_failure_at(&format!("flood-{index}"), now);
        }

        assert!(
            throttle.len() <= 4096,
            "5000 个不同 IP 后 map 仍有 {} 条，必须有硬上限",
            throttle.len()
        );
    }

    /// 灌表淘汰不能把已锁定的 IP 挤掉——否则限流形同虚设。
    #[test]
    fn ip_locked_entry_survives_an_address_flood() {
        let throttle = IpThrottle::new(IP_MAX_FAILURES, IP_WINDOW_SECS);
        let now = Instant::now();
        let locked = "198.51.100.1";
        for _ in 0..IP_MAX_FAILURES {
            throttle.record_failure_at(locked, now);
        }

        for index in 0..5000 {
            throttle.record_failure_at(&format!("flood-{index}"), now);
        }

        assert!(
            throttle.check_at(locked, now).is_err(),
            "已锁定的 IP 不能被灌表淘汰"
        );
    }
}
