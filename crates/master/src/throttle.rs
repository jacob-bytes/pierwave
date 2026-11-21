//! 进程内限流：登录失败限流、认证失败 IP 限流、公开读取 IP 限流。
//!
//! 三张表互不相干，**绝不共用一个计数**：
//!
//! * [`LoginThrottle`]：登录失败的「(用户名, IP) / 用户名 / IP」三维计数；
//! * [`IpThrottle`]：Bearer / Agent Hello 认证失败的 IP 计数；
//! * [`PublicReadThrottle`]：公开状态页的**成功读取**计数（每 IP 每分钟 N 次）。
//!
//! 共用失败计数表会让「正常读公开页」被「密码撞库」连坐，反之亦然。
//!
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
//! 每条记录都带最后访问时间，超过「窗口 + 60 秒」且已解锁的条目最多每
//! 60 秒被清理一次，避免 map 无限增长；清理不再发生在每个请求上。

use std::collections::HashMap;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// 默认「窗口内失败次数」上限；与 `routes::settings` 的默认值保持一致。
pub const DEFAULT_MAX_ATTEMPTS: u32 = 5;
/// 默认锁定 15 分钟。
pub const DEFAULT_LOCK_SECS: u64 = 900;

/// 限流键：用固定大小的地址表示，不再为每个请求分配 `String`。
///
/// * IPv4 直接存 4 字节；
/// * IPv6 只存高 64 位（`/64` 前缀），一个 /64 内的地址共用一个桶；
/// * [`ThrottleKey::Unknown`] 用于确实拿不到客户端地址的登录请求（旧行为里
///   是字符串 `"unknown"`）；
/// * [`ThrottleKey::Aggregate`] 只作为 `(用户, *)` / `(*, IP)` 聚合桶的占位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ThrottleKey {
    V4(Ipv4Addr),
    V6([u8; 8]),
    Unknown,
    Aggregate,
}

impl ThrottleKey {
    /// 从已解析的地址构造；IPv4-mapped IPv6 由调用方先归一成 IPv4。
    pub fn from_ip(ip: IpAddr) -> Self {
        match ip {
            IpAddr::V4(v4) => Self::V4(v4),
            IpAddr::V6(v6) => {
                let segments = v6.segments();
                let mut high = [0_u8; 8];
                for (index, segment) in segments.iter().take(4).enumerate() {
                    high[index * 2] = (segment >> 8) as u8;
                    high[index * 2 + 1] = (segment & 0xff) as u8;
                }
                Self::V6(high)
            }
        }
    }
}

impl fmt::Display for ThrottleKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::V4(v4) => write!(f, "{v4}"),
            Self::V6(high) => {
                let segment =
                    |index: usize| u16::from_be_bytes([high[index * 2], high[index * 2 + 1]]);
                let network =
                    Ipv6Addr::new(segment(0), segment(1), segment(2), segment(3), 0, 0, 0, 0);
                write!(f, "{network}/64")
            }
            Self::Unknown => f.write_str("unknown"),
            Self::Aggregate => f.write_str("*"),
        }
    }
}

/// 测试与旧调用点的字符串入口：解析失败按 [`ThrottleKey::Unknown`] 处理。
///
/// 只在测试里编译，生产代码必须先把地址解析成 `IpAddr` 再走
/// [`ThrottleKey::from_ip`]，避免把未校验的字符串当限流键。
#[cfg(test)]
impl From<&str> for ThrottleKey {
    fn from(raw: &str) -> Self {
        raw.parse::<IpAddr>()
            .map(Self::from_ip)
            .unwrap_or(Self::Unknown)
    }
}

#[cfg(test)]
impl From<String> for ThrottleKey {
    fn from(raw: String) -> Self {
        Self::from(raw.as_str())
    }
}

#[cfg(test)]
impl From<&String> for ThrottleKey {
    fn from(raw: &String) -> Self {
        Self::from(raw.as_str())
    }
}

/// 一次登录尝试的限流键。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Key {
    pub username: String,
    pub ip: ThrottleKey,
}

impl Key {
    pub fn new(username: impl Into<String>, ip: ThrottleKey) -> Self {
        Self {
            username: username.into(),
            ip,
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
    ip: ThrottleKey,
}

/// 用户名最短 3 字符、IP 不可能是这个占位符，所以不会与真实键冲突。
const AGGREGATE: &str = "*";

/// 清理过期条目的最小间隔。
///
/// 旧实现每次 `check` / `record_failure` 都对整张表做一次 `retain`；表满时
/// 每个请求要扫 4096 条。过期条目只是内存卫生，不需要强实时，改成最多每
/// 60 秒扫一次，写入 / 读取路径都回到 O(1)（容量淘汰另算）。
const PURGE_INTERVAL: Duration = Duration::from_secs(60);

/// map 条目硬上限。每个失败最多写 3 个桶，5000 个不同用户名就能写出 1 万条；
/// 不设上限时，攻击者可以靠换用户名/换 IP 把主控内存打满。
const MAX_ENTRIES: usize = 4096;

/// 超过上限时一次淘汰到 3/4，避免每来一个请求就做一次全表排序。
const EVICT_TARGET: usize = MAX_ENTRIES * 3 / 4;

/// 锁定条目的独立上限。
///
/// 锁定条目不会被淘汰，所以必须单独限量：达到上限后拒绝把新条目转为锁定，
/// 而不是让内存随攻击者换 IP / 用户名无限增长。当前与表上限相同；将来若单独
/// 调大表上限，锁定条目不会跟着无界增长。
const MAX_LOCKED_ENTRIES: usize = MAX_ENTRIES;

/// 容量相关告警的最小间隔：灌表时每个请求都告警会刷爆日志。
const WARN_INTERVAL: Duration = Duration::from_secs(60);

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
    /// 上一次全表清理的时间；见 [`PURGE_INTERVAL`]。
    last_purge: Instant,
    /// 上一次「没有未锁定条目可淘汰」的 warn 时间（限频）。
    last_capacity_warn: Option<Instant>,
    /// 上一次「锁定条目达到上限」的 warn 时间（限频）。
    last_lock_cap_warn: Option<Instant>,
}

impl Inner {
    /// 清掉「已解锁且超过窗口 + 60 秒没活动」的条目。
    fn purge(&mut self, now: Instant) {
        let retain = self.window.max(self.lock) + Duration::from_secs(60);
        self.entries.retain(|_, entry| {
            let unlocked = entry.locked_until.is_none_or(|until| now >= until);
            !(unlocked && now.saturating_duration_since(entry.last_seen) > retain)
        });
        self.last_purge = now;
    }

    /// 按 [`PURGE_INTERVAL`] 节流后的清理；语义与每次清理相同，只是不会
    /// 让每个请求都为整张表付出代价。
    fn maybe_purge(&mut self, now: Instant) {
        if now.saturating_duration_since(self.last_purge) >= PURGE_INTERVAL {
            self.purge(now);
        }
    }
}

/// 在写入 `missing` 个新条目之前腾出空间。
///
/// **只淘汰未锁定条目**：锁定条目是限流的实际作用，被灌表挤掉就等于解锁。
/// 未锁定条目不足以腾出空间时返回 `false`，调用方拒绝这次新失败（不写入），
/// 而不是连锁定记录一起淘汰。返回 `true` 时保证
/// `entries.len() + missing <= MAX_ENTRIES`。
///
/// [`LoginThrottle`] 与 [`IpThrottle`] 共用这一份逻辑，避免两处淘汰语义漂移。
fn make_room<K, E>(
    entries: &mut HashMap<K, E>,
    missing: usize,
    is_locked: impl Fn(&E) -> bool,
    last_seen: impl Fn(&E) -> Instant,
) -> bool
where
    K: Clone + Eq + std::hash::Hash,
{
    if entries.len() + missing <= MAX_ENTRIES {
        return true;
    }

    // 需要腾到 3/4 以下（扣掉这次要新增的槽位），避免每来一个请求就全表排序。
    let target = EVICT_TARGET.saturating_sub(missing);
    if entries.len() > target {
        let need = entries.len() - target;
        let mut candidates: Vec<(Instant, K)> = entries
            .iter()
            .filter(|(_, entry)| !is_locked(entry))
            .map(|(key, entry)| (last_seen(entry), key.clone()))
            .collect();
        candidates.sort_by_key(|(seen, _)| *seen);
        for (_, key) in candidates.into_iter().take(need) {
            entries.remove(&key);
        }
    }

    entries.len() + missing <= MAX_ENTRIES
}

/// 限频告警：同一类容量问题一分钟最多记一次。
fn should_warn(slot: &mut Option<Instant>, now: Instant) -> bool {
    if slot.is_some_and(|at| now.saturating_duration_since(at) < WARN_INTERVAL) {
        return false;
    }
    *slot = Some(now);
    true
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
                last_purge: Instant::now(),
                last_capacity_warn: None,
                last_lock_cap_warn: None,
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
        inner.maybe_purge(now);

        let entry_keys = scopes_for(key);
        // 只有「计数已越线且当前未锁」的桶才可能新增锁定，也只有这时才需要
        // 全表数锁定条目。常见路径（没有越线）保持 O(1)，不再每个请求扫全表。
        let needs_lock = entry_keys.iter().any(|entry_key| {
            inner.entries.get(entry_key).is_some_and(|entry| {
                let unlocked = entry.locked_until.is_none_or(|until| now >= until);
                unlocked && entry.failures >= max_attempts
            })
        });
        let mut locked_count = if needs_lock {
            count_locked(&inner.entries, |entry| {
                entry.locked_until.is_some_and(|until| now < until)
            })
        } else {
            0
        };

        let mut retry_after = 0u64;
        let mut lock_cap_hit = false;
        for entry_key in entry_keys {
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
                if locked_count < MAX_LOCKED_ENTRIES {
                    let until = now + lock;
                    entry.locked_until = Some(until);
                    entry.last_seen = now;
                    locked_count += 1;
                    retry_after = retry_after.max(seconds_until(until, now));
                } else {
                    // 锁定条目已到上限：拒绝新锁定，避免锁定项无界增长。
                    lock_cap_hit = true;
                }
            }
        }

        if lock_cap_hit && should_warn(&mut inner.last_lock_cap_warn, now) {
            tracing::warn!(
                locked = locked_count,
                max = MAX_LOCKED_ENTRIES,
                "登录限流锁定条目已达上限，拒绝新的锁定"
            );
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
        inner.maybe_purge(now);

        // 先腾空间再写：只淘汰未锁定条目。腾不出空间就拒绝这次失败，
        // 不能为了容纳新键而把已锁定的 `admin` 挤掉。
        let entry_keys = scopes_for(key);
        let missing = entry_keys
            .iter()
            .filter(|entry_key| !inner.entries.contains_key(*entry_key))
            .count();
        let fits = make_room(
            &mut inner.entries,
            missing,
            |entry| entry.locked_until.is_some_and(|until| now < until),
            |entry| entry.last_seen,
        );
        if !fits {
            if should_warn(&mut inner.last_capacity_warn, now) {
                tracing::warn!(
                    entries = inner.entries.len(),
                    missing,
                    "登录限流表已满且没有可淘汰的未锁定条目，拒绝记录新的失败"
                );
            }
            return;
        }

        // 同 check_at：只有这次失败真的会把某个桶推到阈值时才数锁定条目。
        let needs_lock = entry_keys
            .iter()
            .any(|entry_key| match inner.entries.get(entry_key) {
                Some(entry) => {
                    let already_locked = entry.locked_until.is_some_and(|until| now < until);
                    !already_locked && entry.failures.saturating_add(1) >= max_attempts
                }
                None => max_attempts <= 1,
            });
        let mut locked_count = if needs_lock {
            count_locked(&inner.entries, |entry| {
                entry.locked_until.is_some_and(|until| now < until)
            })
        } else {
            0
        };
        let mut lock_cap_hit = false;
        for entry_key in entry_keys {
            let mut newly_locked = false;
            {
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
                    let already_locked = entry.locked_until.is_some_and(|until| now < until);
                    if already_locked {
                        // 已锁定：刷新锁定时间（与旧行为一致）。
                        entry.locked_until = Some(now + lock);
                    } else if locked_count < MAX_LOCKED_ENTRIES {
                        entry.locked_until = Some(now + lock);
                        newly_locked = true;
                    } else {
                        lock_cap_hit = true;
                    }
                }
            }
            if newly_locked {
                locked_count += 1;
            }
        }

        if lock_cap_hit && should_warn(&mut inner.last_lock_cap_warn, now) {
            tracing::warn!(
                locked = locked_count,
                max = MAX_LOCKED_ENTRIES,
                "登录限流锁定条目已达上限，拒绝新的锁定"
            );
        }
    }

    fn clear_at(&self, key: &Key, now: Instant) {
        let mut inner = self.lock();
        for entry_key in scopes_for(key) {
            inner.entries.remove(&entry_key);
        }
        inner.maybe_purge(now);
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
    entries: HashMap<ThrottleKey, IpEntry>,
    max_failures: u32,
    window: Duration,
    /// 上一次全表清理的时间；见 [`PURGE_INTERVAL`]。
    last_purge: Instant,
    /// 上一次「没有未锁定条目可淘汰」的 warn 时间（限频）。
    last_capacity_warn: Option<Instant>,
    /// 上一次「锁定条目达到上限」的 warn 时间（限频）。
    last_lock_cap_warn: Option<Instant>,
}

impl IpInner {
    /// 清掉「已解锁且超过窗口 + 60 秒没活动」的条目，避免 map 无限增长。
    fn purge(&mut self, now: Instant) {
        let retain = self.window + Duration::from_secs(60);
        self.entries.retain(|_, entry| {
            let unlocked = entry.locked_until.is_none_or(|until| now >= until);
            !(unlocked && now.saturating_duration_since(entry.last_seen) > retain)
        });
        self.last_purge = now;
    }

    fn maybe_purge(&mut self, now: Instant) {
        if now.saturating_duration_since(self.last_purge) >= PURGE_INTERVAL {
            self.purge(now);
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
                last_purge: Instant::now(),
                last_capacity_warn: None,
                last_lock_cap_warn: None,
            }),
        }
    }

    /// 已锁定时返回建议的重试秒数（`Retry-After`）。
    ///
    /// 生产调用方传 [`ThrottleKey`]（`IpAddr` 的紧凑表示）；`Into` 参数保留
    /// 测试里直接写地址字符串的写法，避免测试被类型转换淹没。
    pub fn check(&self, ip: impl Into<ThrottleKey>) -> Result<(), u64> {
        self.check_at(ip.into(), Instant::now())
    }

    /// 记录一次认证失败；达到阈值时立即锁定该 IP。
    pub fn record_failure(&self, ip: impl Into<ThrottleKey>) {
        self.record_failure_at(ip.into(), Instant::now());
    }

    /// 认证成功后清空该 IP 的失败计数。
    pub fn clear(&self, ip: impl Into<ThrottleKey>) {
        self.clear_at(ip.into(), Instant::now());
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

    fn check_at(&self, ip: impl Into<ThrottleKey>, now: Instant) -> Result<(), u64> {
        let ip = ip.into();
        let mut inner = self.lock();
        inner.maybe_purge(now);

        let Some(entry) = inner.entries.get_mut(&ip) else {
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

    fn record_failure_at(&self, ip: impl Into<ThrottleKey>, now: Instant) {
        let ip = ip.into();
        let mut inner = self.lock();
        let max_failures = inner.max_failures;
        let window = inner.window;
        inner.maybe_purge(now);

        // 先腾空间再写：只淘汰未锁定条目，腾不出空间就拒绝新键。
        let missing = usize::from(!inner.entries.contains_key(&ip));
        let fits = make_room(
            &mut inner.entries,
            missing,
            |entry| entry.locked_until.is_some_and(|until| now < until),
            |entry| entry.last_seen,
        );
        if !fits {
            if should_warn(&mut inner.last_capacity_warn, now) {
                tracing::warn!(
                    entries = inner.entries.len(),
                    ip = %ip,
                    "IP 认证失败表已满且没有可淘汰的未锁定条目，拒绝记录新的失败"
                );
            }
            return;
        }

        let needs_lock = match inner.entries.get(&ip) {
            Some(entry) => {
                let already_locked = entry.locked_until.is_some_and(|until| now < until);
                !already_locked && entry.failures.saturating_add(1) >= max_failures
            }
            None => max_failures <= 1,
        };
        let locked_count = if needs_lock {
            count_locked(&inner.entries, |entry| {
                entry.locked_until.is_some_and(|until| now < until)
            })
        } else {
            0
        };
        let mut lock_cap_hit = false;
        {
            let entry = inner.entries.entry(ip).or_insert_with(|| IpEntry {
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
                let already_locked = entry.locked_until.is_some_and(|until| now < until);
                if already_locked {
                    // 已锁定：刷新锁定时间（与旧行为一致）。
                    entry.locked_until = Some(now + window);
                } else if locked_count < MAX_LOCKED_ENTRIES {
                    entry.locked_until = Some(now + window);
                } else {
                    lock_cap_hit = true;
                }
            }
        }

        if lock_cap_hit && should_warn(&mut inner.last_lock_cap_warn, now) {
            tracing::warn!(
                locked = locked_count,
                max = MAX_LOCKED_ENTRIES,
                "IP 认证失败锁定条目已达上限，拒绝新的锁定"
            );
        }
    }

    fn clear_at(&self, ip: impl Into<ThrottleKey>, now: Instant) {
        let ip = ip.into();
        let mut inner = self.lock();
        inner.entries.remove(&ip);
        inner.maybe_purge(now);
    }
}

/// 公开读取限流的默认阈值：每个 IP 每分钟 60 次。
pub const PUBLIC_READ_LIMIT_PER_MIN: u32 = 60;
/// 公开读取限流的窗口：固定 60 秒，与「每分钟」的说法一致。
pub const PUBLIC_READ_WINDOW: Duration = Duration::from_secs(60);
/// 覆盖默认阈值的环境变量（正整数；非法值回落默认）。
pub const PUBLIC_READ_LIMIT_ENV: &str = "PIERWAVE_PUBLIC_RATE_LIMIT_PER_MIN";
/// 环境变量允许的最大值：再大等价于关闭限流，按非法值回落默认。
pub const PUBLIC_READ_LIMIT_MAX: u32 = 1_000_000;

/// 解析 `PIERWAVE_PUBLIC_RATE_LIMIT_PER_MIN` 的值。
///
/// 只接受 `1..=PUBLIC_READ_LIMIT_MAX` 的十进制整数：空串、`0`、负数、
/// 带单位（`60/min`）一律视为非法，由调用方回落默认值——配置写错时
/// 应该退回**安全默认**，而不是把限流关掉或把所有人挡在门外。
pub fn parse_public_read_limit(raw: &str) -> Option<u32> {
    raw.trim()
        .parse::<u32>()
        .ok()
        .filter(|limit| (1..=PUBLIC_READ_LIMIT_MAX).contains(limit))
}

/// 从环境变量读限流阈值；未设置或非法时用 [`PUBLIC_READ_LIMIT_PER_MIN`]。
pub fn public_read_limit_from_env() -> u32 {
    let Ok(raw) = std::env::var(PUBLIC_READ_LIMIT_ENV) else {
        return PUBLIC_READ_LIMIT_PER_MIN;
    };
    match parse_public_read_limit(&raw) {
        Some(limit) => limit,
        None => {
            tracing::warn!(
                value = %raw,
                default = PUBLIC_READ_LIMIT_PER_MIN,
                env = PUBLIC_READ_LIMIT_ENV,
                "公开读取限流阈值非法，回落到默认值"
            );
            PUBLIC_READ_LIMIT_PER_MIN
        }
    }
}

/// 单个 IP 在固定窗口内的公开读取计数。
#[derive(Debug, Clone)]
struct PublicReadEntry {
    window_started: Instant,
    count: u32,
    last_seen: Instant,
    /// 本窗口是否已经为「被限流」打过一次 warn：429 风暴时不能每个请求一行日志。
    warned: bool,
}

struct PublicReadInner {
    limit: u32,
    entries: HashMap<ThrottleKey, PublicReadEntry>,
    /// 上一次全表清理的时间；语义与 [`IpInner`] 一致。
    last_purge: Instant,
    /// 上一次「表满且腾不出空间」的 warn 时间（限频）。
    last_capacity_warn: Option<Instant>,
}

impl PublicReadInner {
    fn purge(&mut self, now: Instant) {
        let retain = PUBLIC_READ_WINDOW + Duration::from_secs(60);
        self.entries
            .retain(|_, entry| now.saturating_duration_since(entry.last_seen) <= retain);
        self.last_purge = now;
    }

    fn maybe_purge(&mut self, now: Instant) {
        if now.saturating_duration_since(self.last_purge) >= PURGE_INTERVAL {
            self.purge(now);
        }
    }
}

/// 公开读取限流：每个客户端 IP 每分钟最多 N 次（默认
/// [`PUBLIC_READ_LIMIT_PER_MIN`]）。
///
/// 只保护**匿名可读**的公开状态页（列表 + 详情），与认证失败限流完全分开：
/// 这里数的是「读得多」，不是「密码错」，所以没有锁定状态、不随时间延长，
/// 窗口一过计数归零。键来自 [`ThrottleKey`]（`ClientAddr` 已做 XFF 规范化与
/// IPv6 `/64` 聚合），不另写一套地址解析；IPv4-mapped 归一同理由
/// `ClientAddr` 负责，HTTP 层的「伪造 / mapped 写法不绕过」由 `app.rs` 的
/// 用例覆盖。
///
/// 与 [`IpThrottle`] 同一套内存取舍：进程内、重启清零、map 有
/// [`MAX_ENTRIES`] 硬上限。表满时淘汰最久未活动的条目（这里没有「锁定」
/// 条目需要保护）；真的腾不出空间就保守放行，而不是把正常读者挡在门外。
pub struct PublicReadThrottle {
    inner: Mutex<PublicReadInner>,
}

impl Default for PublicReadThrottle {
    fn default() -> Self {
        Self::new(PUBLIC_READ_LIMIT_PER_MIN)
    }
}

impl PublicReadThrottle {
    pub fn new(limit: u32) -> Self {
        Self {
            inner: Mutex::new(PublicReadInner {
                // 0 会让第一个请求就 429；兜底成 1，至少还能用。
                limit: limit.max(1),
                entries: HashMap::new(),
                last_purge: Instant::now(),
                last_capacity_warn: None,
            }),
        }
    }

    /// 从环境变量构造；非法值回落默认值（见 [`public_read_limit_from_env`]）。
    pub fn from_env() -> Self {
        Self::new(public_read_limit_from_env())
    }

    /// 记一次公开读取；超限时返回建议的 `Retry-After` 秒数（>= 1）。
    pub fn check(&self, ip: impl Into<ThrottleKey>) -> Result<(), u64> {
        self.check_at(ip.into(), Instant::now())
    }

    /// 当前 map 里的条目数；只给测试断言「表有上限」用。
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().entries.len()
    }

    fn lock(&self) -> MutexGuard<'_, PublicReadInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn check_at(&self, ip: ThrottleKey, now: Instant) -> Result<(), u64> {
        let mut inner = self.lock();
        let limit = inner.limit;
        inner.maybe_purge(now);

        // 先腾空间再写：公开读取全是「未锁定」条目，淘汰最久未活动的即可。
        let missing = usize::from(!inner.entries.contains_key(&ip));
        if !make_room(
            &mut inner.entries,
            missing,
            |_entry| false,
            |entry| entry.last_seen,
        ) {
            if should_warn(&mut inner.last_capacity_warn, now) {
                tracing::warn!(
                    entries = inner.entries.len(),
                    "公开读取限流表已满且腾不出空间，本条请求保守放行"
                );
            }
            return Ok(());
        }

        let entry = inner.entries.entry(ip).or_insert_with(|| PublicReadEntry {
            window_started: now,
            count: 0,
            last_seen: now,
            warned: false,
        });
        entry.last_seen = now;
        if now.saturating_duration_since(entry.window_started) >= PUBLIC_READ_WINDOW {
            // 窗口已过：计数归零，正常读者立即恢复。
            entry.window_started = now;
            entry.count = 0;
            entry.warned = false;
        }

        if entry.count >= limit {
            let elapsed = now.saturating_duration_since(entry.window_started);
            let remaining = PUBLIC_READ_WINDOW.saturating_sub(elapsed);
            let retry_after = remaining.as_millis().div_ceil(1000).max(1) as u64;
            // 每个 IP 每个窗口最多一行 warn：被刷时不能把日志打爆。
            if !entry.warned {
                entry.warned = true;
                tracing::warn!(
                    ip = %ip,
                    limit,
                    retry_after,
                    "公开读取超过每 IP 每分钟阈值，已返回 429"
                );
            }
            return Err(retry_after);
        }
        entry.count = entry.count.saturating_add(1);
        Ok(())
    }
}

fn scopes_for(key: &Key) -> [EntryKey; 3] {
    [
        EntryKey {
            scope: Scope::Pair,
            username: key.username.clone(),
            ip: key.ip,
        },
        EntryKey {
            scope: Scope::Account,
            username: key.username.clone(),
            ip: ThrottleKey::Aggregate,
        },
        EntryKey {
            scope: Scope::Address,
            username: AGGREGATE.to_string(),
            ip: key.ip,
        },
    ]
}

/// 数当前处于锁定状态的条目；只在即将新增锁定时调用。
fn count_locked<K, E>(entries: &HashMap<K, E>, is_locked: impl Fn(&E) -> bool) -> usize {
    entries.values().filter(|entry| is_locked(entry)).count()
}

fn seconds_until(until: Instant, now: Instant) -> u64 {
    let remaining = until.saturating_duration_since(now);
    remaining.as_millis().div_ceil(1000).max(1) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(username: &str, ip: &str) -> Key {
        Key::new(username, ThrottleKey::from(ip))
    }

    fn at(base: Instant, secs: u64) -> Instant {
        base + Duration::from_secs(secs)
    }

    /// 生成第 `index` 个测试地址（10.0.0.0/8 内），避免把非 IP 字符串当键。
    fn ip(index: usize) -> ThrottleKey {
        ThrottleKey::from_ip(IpAddr::V4(Ipv4Addr::new(
            10,
            ((index >> 16) & 0xff) as u8,
            ((index >> 8) & 0xff) as u8,
            (index & 0xff) as u8,
        )))
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
            throttle.record_failure_at(ip(index), now);
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
            throttle.record_failure_at(ip(MAX_ENTRIES + index), now);
        }

        assert!(
            throttle.check_at(locked, now).is_err(),
            "已锁定的 IP 不能被灌表淘汰"
        );
    }

    // ---- 锁定条目不能被灌表淘汰（T3） ----
    //
    // 只灌「未锁定」条目时旧实现会优先淘汰未锁定项，看起来没问题；真正的
    // 漏洞是灌入**已锁定**条目：表满后所有条目都是锁定的，旧实现会按
    // 「最久未活动」连锁定记录一起淘汰，攻击者因此能把 admin 的锁挤掉。
    // 下面用直接构造的表精确覆盖这个边界，不必真的打 20 次失败。

    fn seed_locked_ips(throttle: &IpThrottle, count: usize, now: Instant) {
        let mut inner = throttle.lock();
        for index in 0..count {
            inner.entries.insert(
                ip(index),
                IpEntry {
                    failures: IP_MAX_FAILURES,
                    window_started: now,
                    locked_until: Some(now + Duration::from_secs(IP_WINDOW_SECS)),
                    last_seen: now + Duration::from_millis(index as u64),
                },
            );
        }
    }

    /// 表里绝大多数条目已锁定时，灌表不能把 admin 的锁定记录挤掉。
    #[test]
    fn ip_admin_lock_survives_a_locked_address_flood() {
        let throttle = IpThrottle::new(IP_MAX_FAILURES, IP_WINDOW_SECS);
        let now = Instant::now();
        let admin = "203.0.113.200";
        for _ in 0..IP_MAX_FAILURES {
            throttle.record_failure_at(admin, now);
        }
        assert!(throttle.check_at(admin, now).is_err(), "admin 应先被锁定");

        // 把其余槽位全部填成锁定条目；admin 是最早的条目。
        seed_locked_ips(&throttle, MAX_ENTRIES - 1, now);
        assert_eq!(throttle.len(), MAX_ENTRIES);

        for index in 0..200 {
            for _ in 0..IP_MAX_FAILURES {
                throttle.record_failure_at(ip(MAX_ENTRIES + index), now);
            }
        }

        assert!(
            throttle.check_at(admin, now).is_err(),
            "灌表后 admin 的锁定必须仍在"
        );
        assert!(throttle.len() <= MAX_ENTRIES, "表大小不能超过上限");
    }

    /// 全锁定场景：没有可淘汰的未锁定条目时拒绝新键，而不是淘汰锁定项。
    #[test]
    fn ip_all_locked_table_rejects_new_keys_without_growing() {
        let throttle = IpThrottle::new(IP_MAX_FAILURES, IP_WINDOW_SECS);
        let now = Instant::now();
        seed_locked_ips(&throttle, MAX_ENTRIES, now);
        let before = throttle.len();

        for index in 0..500 {
            throttle.record_failure_at(ip(MAX_ENTRIES + index), now);
        }

        assert_eq!(
            throttle.len(),
            before,
            "全锁定时新失败不能写进表，表也不能增长"
        );
        assert!(
            throttle.check_at(ip(MAX_ENTRIES), now).is_ok(),
            "被拒绝的新键不能进入锁定状态"
        );
        assert!(
            throttle.check_at(ip(0), now).is_err(),
            "已有锁定项必须全部保留"
        );
        assert!(
            throttle.check_at(ip(MAX_ENTRIES - 1), now).is_err(),
            "最后一条锁定项也必须保留"
        );
    }

    /// 正常淘汰仍然工作：表满且全是未锁定条目时，淘汰最久未活动的那条。
    #[test]
    fn ip_unlocked_entries_are_still_evicted_normally() {
        // 阈值设到最大，失败永远到不了锁定，整张表都是未锁定条目。
        let throttle = IpThrottle::new(u32::MAX, IP_WINDOW_SECS);
        let now = Instant::now();
        for index in 0..MAX_ENTRIES {
            // 用毫秒递增 last_seen，保证「最久未活动」是可断言的确定值。
            throttle.record_failure_at(ip(index), now + Duration::from_millis(index as u64));
        }
        assert_eq!(throttle.len(), MAX_ENTRIES);

        throttle.record_failure_at(ip(MAX_ENTRIES + 7), now + Duration::from_secs(10));

        assert!(
            throttle.len() <= MAX_ENTRIES,
            "淘汰后仍必须有硬上限：{}",
            throttle.len()
        );
        assert!(
            throttle.lock().entries.contains_key(&ip(MAX_ENTRIES + 7)),
            "新键必须写入"
        );
        assert!(
            !throttle.lock().entries.contains_key(&ip(0)),
            "最久未活动的未锁定条目应被淘汰"
        );
    }

    fn seed_locked_accounts(throttle: &LoginThrottle, count: usize, now: Instant) {
        let mut inner = throttle.lock();
        for index in 0..count {
            inner.entries.insert(
                EntryKey {
                    scope: Scope::Account,
                    username: format!("locked-{index}"),
                    ip: ThrottleKey::Aggregate,
                },
                Entry {
                    failures: 5,
                    window_started: now,
                    locked_until: Some(now + Duration::from_secs(900)),
                    last_seen: now + Duration::from_millis(index as u64),
                },
            );
        }
    }

    /// 登录限流同样不能把已锁定的 `admin` 账号挤掉。
    #[test]
    fn login_admin_lock_survives_a_locked_username_flood() {
        let throttle = LoginThrottle::new(5, 900);
        let now = Instant::now();
        let admin = key("admin", "10.0.0.1");
        for _ in 0..5 {
            throttle.record_failure_at(&admin, now);
        }
        assert!(throttle.check_at(&admin, now).is_err(), "admin 应先被锁定");

        seed_locked_accounts(&throttle, MAX_ENTRIES - throttle.len(), now);
        assert_eq!(throttle.len(), MAX_ENTRIES);

        for index in 0..200 {
            let key = key(&format!("flood-{index}"), "10.0.0.2");
            for _ in 0..5 {
                throttle.record_failure_at(&key, now);
            }
        }

        assert!(
            throttle.check_at(&admin, now).is_err(),
            "灌表后 admin 的登录锁定必须仍在"
        );
        assert!(throttle.len() <= MAX_ENTRIES, "表大小不能超过上限");
    }

    /// 登录表全是锁定时，新账号的失败不记入，表保持原大小。
    #[test]
    fn login_all_locked_table_rejects_new_keys() {
        let throttle = LoginThrottle::new(5, 900);
        let now = Instant::now();
        seed_locked_accounts(&throttle, MAX_ENTRIES, now);
        let before = throttle.len();

        for index in 0..100 {
            let key = key(&format!("new-{index}"), "10.0.0.3");
            for _ in 0..5 {
                throttle.record_failure_at(&key, now);
            }
        }

        assert_eq!(throttle.len(), before, "全锁定时新失败不能写进表");
        assert!(
            throttle.check_at(&key("new-0", "10.0.0.3"), now).is_ok(),
            "被拒绝的新账号不能进入锁定状态"
        );
        assert!(
            throttle
                .check_at(&key("locked-0", "10.0.0.3"), now)
                .is_err(),
            "已有锁定账号必须保留"
        );
    }

    // ---- 公开读取限流（每 IP 每分钟 N 次） ----

    #[test]
    fn public_read_allows_the_limit_then_reports_retry_after() {
        let throttle = PublicReadThrottle::new(PUBLIC_READ_LIMIT_PER_MIN);
        let now = Instant::now();
        let ip = "203.0.113.5";

        for _ in 0..PUBLIC_READ_LIMIT_PER_MIN {
            assert_eq!(throttle.check_at(ThrottleKey::from(ip), now), Ok(()));
        }
        let retry = throttle
            .check_at(ThrottleKey::from(ip), now)
            .expect_err("第 61 次必须被限流");
        assert!(
            (1..=PUBLIC_READ_WINDOW.as_secs()).contains(&retry),
            "Retry-After 不合理：{retry}"
        );
    }

    #[test]
    fn public_read_window_resets_and_retry_after_shrinks() {
        let throttle = PublicReadThrottle::new(2);
        let now = Instant::now();
        let ip = ThrottleKey::from("198.51.100.9");

        assert_eq!(throttle.check_at(ip, now), Ok(()));
        assert_eq!(throttle.check_at(ip, now), Ok(()));
        assert!(throttle.check_at(ip, now).is_err());

        // 窗口过半：Retry-After 必须跟着缩短，且仍拒绝。
        let retry = throttle
            .check_at(ip, at(now, 50))
            .expect_err("窗口内仍应拒绝");
        assert!(retry <= 10, "过了 50 秒，剩余应不超过 10 秒：{retry}");

        // 窗口结束后立即恢复，新的窗口从头计数。
        assert_eq!(throttle.check_at(ip, at(now, 60)), Ok(()));
        assert_eq!(throttle.check_at(ip, at(now, 60)), Ok(()));
        assert!(throttle.check_at(ip, at(now, 60)).is_err());
    }

    #[test]
    fn public_read_is_isolated_per_address() {
        let throttle = PublicReadThrottle::new(1);
        let now = Instant::now();
        assert_eq!(
            throttle.check_at(ThrottleKey::from("10.0.0.1"), now),
            Ok(())
        );
        assert!(throttle
            .check_at(ThrottleKey::from("10.0.0.1"), now)
            .is_err());
        assert_eq!(
            throttle.check_at(ThrottleKey::from("10.0.0.2"), now),
            Ok(()),
            "别的 IP 不受影响"
        );
    }

    /// IPv6 按 /64 聚合：同一前缀里换地址不能换出新额度。
    #[test]
    fn public_read_ipv6_aggregates_the_64_prefix() {
        let throttle = PublicReadThrottle::new(1);
        let now = Instant::now();
        assert_eq!(
            throttle.check_at(ThrottleKey::from("2001:db8:1:2::1"), now),
            Ok(())
        );
        assert!(
            throttle
                .check_at(ThrottleKey::from("2001:db8:1:2::99"), now)
                .is_err(),
            "同一 /64 内的其它地址必须命中同一个桶"
        );
        assert_eq!(
            throttle.check_at(ThrottleKey::from("2001:db8:1:3::1"), now),
            Ok(()),
            "不同 /64 不应互相影响"
        );
    }

    #[test]
    fn public_read_threshold_env_parsing_rejects_invalid_values() {
        assert_eq!(parse_public_read_limit("120"), Some(120));
        assert_eq!(parse_public_read_limit(" 60 "), Some(60));
        for invalid in [
            "",
            "   ",
            "0",
            "-5",
            "abc",
            "60/min",
            "1.5",
            "99999999999999999999",
        ] {
            assert_eq!(
                parse_public_read_limit(invalid),
                None,
                "非法值必须回落默认：{invalid:?}"
            );
        }
        assert_eq!(
            parse_public_read_limit("1000001"),
            None,
            "超过上限按非法处理"
        );
    }

    /// 攻击者可以无限换 IP：公开读取计数表也必须有硬上限。
    #[test]
    fn public_read_entry_map_stays_bounded_under_a_flood() {
        let throttle = PublicReadThrottle::new(1_000);
        let now = Instant::now();
        for index in 0..5000 {
            let _ = throttle.check_at(ip(index), now);
        }
        assert!(
            throttle.len() <= MAX_ENTRIES,
            "5000 个不同 IP 后 map 仍有 {} 条，必须有硬上限",
            throttle.len()
        );
    }

    // ---- 手工微基准（不进 `make check`） ----
    //
    // 运行：CARGO_HOME=$PWD/.cargo-home cargo test -p pierwave-master --lib \
    //         throttle::tests::bench_ -- --ignored --nocapture
    //
    // 目的是量化「每次 check 都全表 purge + 数锁定条目」的开销；优化后同样
    // 的命令应显著变小。

    #[test]
    #[ignore = "manual microbenchmark"]
    fn bench_ip_throttle_check_with_a_full_table() {
        let throttle = IpThrottle::new(u32::MAX, IP_WINDOW_SECS);
        let now = Instant::now();
        for index in 0..MAX_ENTRIES {
            throttle.record_failure_at(format!("10.0.{}.{}", index / 256, index % 256), now);
        }
        assert_eq!(throttle.len(), MAX_ENTRIES);

        let rounds = 20_000;
        let start = Instant::now();
        for index in 0..rounds {
            let ip = format!("10.0.{}.{}", index / 256, index % 256);
            let _ = throttle.check_at(&ip, now);
        }
        let elapsed = start.elapsed();
        println!(
            "bench_ip_throttle_check_with_a_full_table: {rounds} checks in {:?} => {:.1} ns/check",
            elapsed,
            elapsed.as_nanos() as f64 / rounds as f64
        );
    }

    #[test]
    #[ignore = "manual microbenchmark"]
    fn bench_login_throttle_check_with_a_full_table() {
        let throttle = LoginThrottle::new(u32::MAX, 900);
        let now = Instant::now();
        for index in 0..MAX_ENTRIES / 3 {
            throttle.record_failure_at(&key(&format!("user-{index}"), "10.0.0.1"), now);
        }
        assert!(throttle.len() > MAX_ENTRIES / 2);

        let rounds = 20_000;
        let start = Instant::now();
        for index in 0..rounds {
            let probe = key(&format!("user-{}", index % (MAX_ENTRIES / 3)), "10.0.0.1");
            let _ = throttle.check_at(&probe, now);
        }
        let elapsed = start.elapsed();
        println!(
            "bench_login_throttle_check_with_a_full_table: {rounds} checks in {:?} => {:.1} ns/check",
            elapsed,
            elapsed.as_nanos() as f64 / rounds as f64
        );
    }
}
