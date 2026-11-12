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

/// `ts` 所属的 UTC+8 自然日，格式 `YYYY-MM-DD`。
///
/// 日账本 `traffic_daily.day` 用它；不要用 UTC 日期，否则东八区凌晨 0-8 点
/// 的流量会记到前一天。
pub fn business_date(ts: i64) -> String {
    let offset =
        chrono::FixedOffset::east_opt(BUSINESS_UTC_OFFSET_SECS as i32).expect("UTC+8 偏移固定合法");
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|utc| utc.with_timezone(&offset).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "1970-01-01".to_string())
}

/// Unix 秒 → ISO8601 UTC 字符串（`2026-11-12T13:46:12Z`）。
///
/// 链视图的 `last_seen_at` 契约是 ISO8601 字符串（不是 Unix 秒）；本项目的
/// 存储时区仍是 UTC，所以直接用 `Z` 后缀，不做 UTC+8 换算。无效时间戳返回
/// `None`，调用方输出 null，绝不用 `1970-01-01` 冒充「从未连过」。
pub fn rfc3339_utc(ts: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(ts, 0).map(|utc| utc.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// `ts` 所属 UTC+8 自然日的 `(年, 月, 日)`。
///
/// 月度重置日需要「当月第几天 / 当月最后一天」，字符串比较做不了，
/// 所以在这里统一换算成本地日历字段。
pub fn business_ymd(ts: i64) -> (i32, u32, u32) {
    use chrono::Datelike;

    let offset =
        chrono::FixedOffset::east_opt(BUSINESS_UTC_OFFSET_SECS as i32).expect("UTC+8 偏移固定合法");
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|utc| {
            let local = utc.with_timezone(&offset);
            (local.year(), local.month(), local.day())
        })
        .unwrap_or((1970, 1, 1))
}

/// `ts` 所属 UTC+8 自然月的天数（28/29/30/31）。
///
/// `reset_day = 29/30/31` 遇到小月要压到当月最后一天，判定就靠它。
pub fn business_days_in_month(ts: i64) -> u32 {
    let (year, month, _) = business_ymd(ts);
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let first = chrono::NaiveDate::from_ymd_opt(year, month, 1)
        .unwrap_or_else(|| chrono::NaiveDate::from_ymd_opt(1970, 1, 1).expect("回退日期合法"));
    let next = chrono::NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .unwrap_or_else(|| chrono::NaiveDate::from_ymd_opt(1970, 2, 1).expect("回退日期合法"));
    (next - first).num_days() as u32
}

/// `ts` 所属 UTC+8 自然月的首日与末日，格式 `YYYY-MM-DD`。
pub fn business_month_bounds(ts: i64) -> (String, String) {
    let (year, month, _) = business_ymd(ts);
    let last = business_days_in_month(ts);
    (
        format!("{year:04}-{month:02}-01"),
        format!("{year:04}-{month:02}-{last:02}"),
    )
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

    #[test]
    fn business_date_uses_utc_plus_eight() {
        // 2024-01-01 00:00:00 UTC = 2024-01-01 08:00:00 UTC+8
        assert_eq!(business_date(1_704_067_200), "2024-01-01");
        // 2024-01-01 15:59:59 UTC 仍是 2024-01-01 23:59:59 UTC+8
        assert_eq!(business_date(1_704_067_200 + 16 * 3600 - 1), "2024-01-01");
        // 2024-01-01 16:00:00 UTC = 2024-01-02 00:00:00 UTC+8
        assert_eq!(business_date(1_704_067_200 + 16 * 3600), "2024-01-02");
        assert_eq!(business_date(0), "1970-01-01");
    }

    #[test]
    fn business_calendar_fields_follow_utc_plus_eight() {
        // 2024-01-01 00:00:00 UTC = 2024-01-01 08:00:00 UTC+8
        assert_eq!(business_ymd(1_704_067_200), (2024, 1, 1));
        assert_eq!(business_days_in_month(1_704_067_200), 31);
        assert_eq!(
            business_month_bounds(1_704_067_200),
            ("2024-01-01".to_string(), "2024-01-31".to_string())
        );

        // 闰年 2 月与平年 2 月。
        let leap_feb = 1_709_164_800; // 2024-02-29 00:00:00 UTC
        assert_eq!(business_ymd(leap_feb), (2024, 2, 29));
        assert_eq!(business_days_in_month(leap_feb), 29);
        let feb_2023 = 1_677_542_400; // 2023-02-28 00:00:00 UTC
        assert_eq!(business_ymd(feb_2023), (2023, 2, 28));
        assert_eq!(business_days_in_month(feb_2023), 28);

        // 跨年 12 月的下一个月要回到 1 月。
        let dec = 1_704_067_200 + 360 * 86_400; // 2024-12-26 00:00:00 UTC 附近
        let (year, month, _) = business_ymd(dec);
        assert_eq!((year, month), (2024, 12));
        assert_eq!(business_days_in_month(dec), 31);
    }

    #[test]
    fn rfc3339_uses_utc_and_rejects_garbage() {
        assert_eq!(
            rfc3339_utc(1_704_067_200).as_deref(),
            Some("2024-01-01T00:00:00Z")
        );
        assert_eq!(rfc3339_utc(0).as_deref(), Some("1970-01-01T00:00:00Z"));
        assert_eq!(rfc3339_utc(i64::MAX), None, "无效时间必须是 null，不能编造");
    }
}
