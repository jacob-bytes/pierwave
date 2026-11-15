//! API Token 的进程内限流与 `last_used_at` 写回缓冲。
//!
//! - **限流**：每个 token 每分钟最多 [`DEFAULT_REQUESTS_PER_MINUTE`] 次，
//!   固定窗口计数，主控重启后清空（与登录限流同一取舍，见 `throttle.rs`）。
//! - **last_used_at**：鉴权热路径只把 `(token id, 时间戳)` 放进内存 map，
//!   由调度器每 [`FLUSH_INTERVAL`] 批量写一次库；不按请求写库。
//!
//! 两者都只放在进程内，单主控部署下没有跨进程一致性问题。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use pierwave_domain::repo;

/// 每个 token 每分钟允许的请求数。
pub const DEFAULT_REQUESTS_PER_MINUTE: u32 = 120;
/// 固定窗口长度。
pub const WINDOW: Duration = Duration::from_secs(60);
/// `last_used_at` 批量落库间隔。
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(10);
/// 内存里最多保留多少个 token 的计数：超出时顺带清掉最久未使用的条目，
/// 防止有人拿一堆已删除 token 的 id 把 map 撑大（认证成功才会进 map）。
const MAX_ENTRIES: usize = 4096;

#[derive(Debug, Clone)]
struct Window {
    started: Instant,
    count: u32,
    last_seen: Instant,
}

/// 每 token 固定窗口限流器。
pub struct ApiTokenRateLimiter {
    inner: Mutex<Inner>,
}

struct Inner {
    limit: u32,
    windows: HashMap<String, Window>,
}

impl Default for ApiTokenRateLimiter {
    fn default() -> Self {
        Self::new(DEFAULT_REQUESTS_PER_MINUTE)
    }
}

impl ApiTokenRateLimiter {
    pub fn new(limit: u32) -> Self {
        Self {
            inner: Mutex::new(Inner {
                // 0 会让第一个请求就 429；兜底成 1，至少还能用。
                limit: limit.max(1),
                windows: HashMap::new(),
            }),
        }
    }

    /// 测试/运维用：调整每分钟上限。已开始的窗口保持原样，下一轮按新值算。
    #[cfg(test)]
    pub fn set_limit(&self, limit: u32) {
        self.lock().limit = limit.max(1);
    }

    /// 记一次请求；超出上限时返回建议的 `Retry-After` 秒数（>= 1）。
    pub fn check(&self, token_id: &str) -> Result<(), u64> {
        self.check_at(token_id, Instant::now())
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn check_at(&self, token_id: &str, now: Instant) -> Result<(), u64> {
        let mut inner = self.lock();
        let limit = inner.limit;

        // 窗口已过（或从未见过）就重开；否则累加。固定窗口实现简单，
        // 代价是窗口边界可能出现 2 倍突发，对「保护主控」这个目标足够。
        let window = inner
            .windows
            .entry(token_id.to_string())
            .or_insert_with(|| Window {
                started: now,
                count: 0,
                last_seen: now,
            });
        window.last_seen = now;
        if now.saturating_duration_since(window.started) >= WINDOW {
            window.started = now;
            window.count = 0;
        }

        if window.count >= limit {
            let elapsed = now.saturating_duration_since(window.started);
            let remaining = WINDOW.saturating_sub(elapsed);
            return Err(remaining.as_millis().div_ceil(1000).max(1) as u64);
        }
        window.count = window.count.saturating_add(1);

        if inner.windows.len() > MAX_ENTRIES {
            inner
                .windows
                .retain(|_, window| now.saturating_duration_since(window.last_seen) < WINDOW);
        }
        Ok(())
    }
}

/// `last_used_at` 的写回缓冲。
#[derive(Default)]
pub struct ApiTokenUsage {
    inner: Mutex<HashMap<String, i64>>,
}

impl ApiTokenUsage {
    /// 在鉴权热路径里调用：只写内存，不碰数据库。
    pub fn mark(&self, token_id: &str) {
        let mut usage = self.lock();
        usage.insert(token_id.to_string(), pierwave_domain::time::now());
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, i64>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 取出并清空当前缓冲；重复的 token id 保留最新时间戳。
    pub fn drain(&self) -> Vec<(String, i64)> {
        let mut usage = self.lock();
        usage.drain().collect()
    }

    /// 把缓冲批量写回数据库。失败只由调用方记日志：`last_used_at` 是展示字段，
    /// 不能因为它写失败而影响任何主操作。
    pub async fn flush(&self, pool: &sqlx::SqlitePool) -> anyhow::Result<usize> {
        let updates = self.drain();
        let count = updates.len();
        repo::api_tokens::touch_many(pool, &updates).await?;
        Ok(count)
    }

    #[cfg(test)]
    pub fn pending(&self) -> usize {
        self.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_the_limit_then_reports_retry_after() {
        let limiter = ApiTokenRateLimiter::new(3);
        let now = Instant::now();
        for _ in 0..3 {
            assert_eq!(limiter.check_at("tok-1", now), Ok(()));
        }
        let retry = limiter.check_at("tok-1", now).unwrap_err();
        assert!((1..=60).contains(&retry), "Retry-After 不合理：{retry}");
    }

    #[test]
    fn windows_are_per_token_and_reset_after_a_minute() {
        let limiter = ApiTokenRateLimiter::new(2);
        let now = Instant::now();
        assert_eq!(limiter.check_at("tok-1", now), Ok(()));
        assert_eq!(limiter.check_at("tok-1", now), Ok(()));
        assert!(limiter.check_at("tok-1", now).is_err());
        // 另一个 token 不受影响。
        assert_eq!(limiter.check_at("tok-2", now), Ok(()));

        let later = now + WINDOW + Duration::from_secs(1);
        assert_eq!(limiter.check_at("tok-1", later), Ok(()), "新窗口应重新计数");
    }

    #[test]
    fn retry_after_shrinks_within_the_window() {
        let limiter = ApiTokenRateLimiter::new(1);
        let now = Instant::now();
        assert_eq!(limiter.check_at("tok-1", now), Ok(()));
        let retry = limiter
            .check_at("tok-1", now + Duration::from_secs(50))
            .unwrap_err();
        assert!(retry <= 10, "过了 50 秒，剩余应不超过 10 秒：{retry}");
    }

    #[tokio::test]
    async fn usage_is_buffered_and_flushed_once() {
        let db = pierwave_domain::Db::connect("sqlite::memory:")
            .await
            .unwrap();
        db.migrate().await.unwrap();
        let (token, _) = repo::api_tokens::create(&db.pool, "ci", "read", None)
            .await
            .unwrap();

        let usage = ApiTokenUsage::default();
        usage.mark(&token.id);
        usage.mark(&token.id);
        assert_eq!(usage.pending(), 1, "同一 token 只保留一条");
        assert_eq!(usage.flush(&db.pool).await.unwrap(), 1);

        let row = repo::api_tokens::get(&db.pool, &token.id)
            .await
            .unwrap()
            .unwrap();
        assert!(row.last_used_at.is_some());
        assert_eq!(usage.pending(), 0, "flush 后缓冲应清空");
    }
}
