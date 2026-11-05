//! 业务时间语义。
//!
//! 存储与传输一律用 **UTC Unix 秒**；需要「自然日」语义的地方（套餐到期、
//! 月度重置日、`traffic_daily.day`）按 **UTC+8** 计算。这里只用一个固定偏移，
//! 不引入 `chrono-tz`：本项目服务的自然日就是东八区，没有跨时区用户。

use chrono::Utc;

/// UTC+8 相对 UTC 的秒偏移。
pub const BUSINESS_UTC_OFFSET_SECS: i64 = 8 * 60 * 60;

/// 一天的秒数。
pub const SECONDS_PER_DAY: i64 = 24 * 60 * 60;

/// 当前 UTC Unix 秒。
pub fn now() -> i64 {
    Utc::now().timestamp()
}

/// 时间戳所属的 UTC+8 自然日序号（1970-01-01 为第 0 天）。
pub fn business_day(ts: i64) -> i64 {
    (ts + BUSINESS_UTC_OFFSET_SECS).div_euclid(SECONDS_PER_DAY)
}

/// UTC+8 某个自然日 00:00:00 对应的 Unix 秒。
pub fn business_day_start(day: i64) -> i64 {
    day * SECONDS_PER_DAY - BUSINESS_UTC_OFFSET_SECS
}

/// `ts` 所在 UTC+8 自然日的 23:59:59。
pub fn end_of_business_day(ts: i64) -> i64 {
    business_day_start(business_day(ts) + 1) - 1
}

/// 从 `ts` 起的第 `days` 个自然日的 23:59:59（UTC+8）。
///
/// 套餐按 `period_days` 自动算到期时用它，保证到期时间总落在 UTC+8 的日末，
/// 而不是「绑定时刻 + N×86400」这种带时分秒的随机边界。
pub fn end_of_business_day_after(ts: i64, days: i64) -> i64 {
    business_day_start(business_day(ts) + days.max(0) + 1) - 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn business_day_is_utc_plus_eight() {
        // 2024-01-01 00:00:00 UTC = 2024-01-01 08:00:00 UTC+8
        assert_eq!(business_day(1_704_067_200), business_day(1_704_067_200 + 1));
        // UTC 的 15:59:59 仍是 UTC+8 当天 23:59:59，16:00:00 进入次日。
        assert_eq!(
            business_day(1_704_067_200 + 16 * 3600 - 1),
            business_day(1_704_067_200)
        );
        assert_eq!(
            business_day(1_704_067_200 + 16 * 3600),
            business_day(1_704_067_200) + 1
        );
    }

    #[test]
    fn end_of_day_round_trips() {
        let ts = 1_704_067_200; // 2024-01-01 00:00:00 UTC
        let end = end_of_business_day(ts);
        assert_eq!(business_day(end), business_day(ts));
        assert_eq!(business_day(end + 1), business_day(ts) + 1);
        assert_eq!(end + 1, business_day_start(business_day(ts) + 1));
    }

    #[test]
    fn period_days_lands_on_end_of_business_day() {
        let ts = 1_704_067_200;
        let end = end_of_business_day_after(ts, 30);
        assert_eq!(business_day(end), business_day(ts) + 30);
        assert_eq!(
            end % SECONDS_PER_DAY,
            SECONDS_PER_DAY - 1 - BUSINESS_UTC_OFFSET_SECS
        );
    }
}
