//! 每日重置：把「重置日命中今天」的套餐实例清零，并回冲用户总用量。
//!
//! 调度器每小时调用一次 [`run_daily_reset`]；它同时是测试入口，所以这里不依赖
//! tokio 定时器。幂等由数据库里的 `last_reset_at` 水位保证：同一 UTC+8 自然日内
//! 重复调用不会二次清零（见 [`crate::repo::user_packages::apply_daily_reset`]）。

use sqlx::SqlitePool;

use crate::repo;
use crate::time;

/// 一轮重置的结果；调度器拿它决定是否打日志，测试拿它断言。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResetReport {
    /// 本轮真正被清零的实例数。
    pub instances: i64,
    /// 从 `users.used_bytes` 扣掉的字节总数。
    pub deducted_bytes: i64,
}

/// 今天（UTC+8）该触发的 `reset_day` 集合。
///
/// `reset_day = 29/30/31` 在小月压到当月最后一天：所以「今天是月末最后一天」
/// 时可能同时命中多个 reset_day（例如 2 月 28 日对应 28/29/30/31）。
/// 这个集合直接作为 `user_packages.reset_day IN (...)` 的过滤条件。
pub fn reset_days_due_on(now: i64) -> Vec<i64> {
    let (_, _, today) = time::business_ymd(now);
    let last_day = time::business_days_in_month(now);
    (1..=31i64)
        .filter(|reset_day| (*reset_day).min(last_day as i64) == today as i64)
        .collect()
}

/// 执行一次日重置扫描。
///
/// `now` 是判断「今天」的唯一依据（UTC+8 自然日），也是写进 `last_reset_at` 的水位。
/// 返回实际清零的实例数与扣减总额；没有命中时返回全 0，不报错。
pub async fn run_daily_reset(pool: &SqlitePool, now: i64) -> anyhow::Result<ResetReport> {
    let today = time::business_day(now);
    let day_start = time::business_day_start(today);
    let day_end = day_start + time::SECONDS_PER_DAY;

    let due_reset_days = reset_days_due_on(now);
    let candidates =
        repo::user_packages::list_reset_candidates(pool, &due_reset_days, day_start, day_end)
            .await?;
    let (instances, deducted_bytes) =
        repo::user_packages::apply_daily_reset(pool, &candidates, now, day_start, day_end).await?;

    Ok(ResetReport {
        instances,
        deducted_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::models::Package;
    use crate::repo::{packages, user_packages, users};
    use crate::Db;

    fn at(rfc3339: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .timestamp()
    }

    async fn setup() -> Db {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        db
    }

    async fn new_user(db: &Db, username: &str, used_bytes: i64) -> (String, Package) {
        let user = users::create(
            &db.pool,
            users::NewUser {
                username: username.into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        users::add_used_bytes(&db.pool, &user.id, used_bytes)
            .await
            .unwrap();
        let package = packages::create(
            &db.pool,
            packages::NewPackage {
                name: "月卡".into(),
                quota_bytes: Some(10_000),
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,

                node_ids: None,
            },
        )
        .await
        .unwrap();
        (user.id, package)
    }

    async fn bind(
        db: &Db,
        user_id: &str,
        package: &Package,
        reset_day: Option<i64>,
        used_bytes: i64,
    ) -> String {
        let view = user_packages::create(
            &db.pool,
            user_id,
            user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day,
            },
            package,
        )
        .await
        .unwrap();
        if used_bytes > 0 {
            user_packages::set_used_bytes(&db.pool, &view.id, used_bytes)
                .await
                .unwrap();
        }
        view.id
    }

    async fn user_used(db: &Db, user_id: &str) -> i64 {
        users::find_by_id(&db.pool, user_id)
            .await
            .unwrap()
            .used_bytes
    }

    async fn instance_used(db: &Db, id: &str) -> i64 {
        user_packages::find_view_by_id(&db.pool, id)
            .await
            .unwrap()
            .unwrap()
            .used_bytes
    }

    #[test]
    fn reset_day_clamps_to_the_last_day_of_short_months() {
        // 普通月份：只有当天命中。
        assert_eq!(reset_days_due_on(at("2026-11-05T12:00:00+08:00")), vec![5]);

        // 平年 2 月最后一天：28/29/30/31 全部压到 28。
        assert_eq!(
            reset_days_due_on(at("2023-02-28T12:00:00+08:00")),
            vec![28, 29, 30, 31]
        );
        // 闰年 2 月 29 日：29/30/31 压到 29。
        assert_eq!(
            reset_days_due_on(at("2024-02-29T12:00:00+08:00")),
            vec![29, 30, 31]
        );
        // 30 天的小月：31 压到 30。
        assert_eq!(
            reset_days_due_on(at("2024-04-30T12:00:00+08:00")),
            vec![30, 31]
        );
        // 大月月末仍然只有 31。
        assert_eq!(reset_days_due_on(at("2024-12-31T12:00:00+08:00")), vec![31]);
        // 小月的普通日期（离月末很远）不该被任何 29/30/31 误命中。
        assert_eq!(reset_days_due_on(at("2023-02-27T12:00:00+08:00")), vec![27]);
    }

    #[tokio::test]
    async fn resets_only_today_then_is_idempotent_within_the_day() {
        let db = setup().await;
        let now = at("2026-11-15T12:00:00+08:00");
        let (user_id, package) = new_user(&db, "alice", 5000).await;

        let due = bind(&db, &user_id, &package, Some(15), 3000).await;
        let tomorrow = bind(&db, &user_id, &package, Some(16), 800).await;
        let no_reset_day = bind(&db, &user_id, &package, None, 400).await;

        // 原始状态 disabled 的实例即使命中 reset_day 也不动。
        let disabled = bind(&db, &user_id, &package, Some(15), 600).await;
        user_packages::update(
            &db.pool,
            &disabled,
            user_packages::UpdateUserPackage {
                status: Some("disabled".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let report = run_daily_reset(&db.pool, now).await.unwrap();
        assert_eq!(
            report,
            ResetReport {
                instances: 1,
                deducted_bytes: 3000
            }
        );
        assert_eq!(instance_used(&db, &due).await, 0);
        assert_eq!(
            user_used(&db, &user_id).await,
            2000,
            "用户总量扣掉被清零的部分"
        );
        assert_eq!(
            user_packages::last_reset_at(&db.pool, &due).await.unwrap(),
            Some(now)
        );

        // 非今天的实例原样保留，也不写水位。
        assert_eq!(instance_used(&db, &tomorrow).await, 800);
        assert_eq!(
            user_packages::last_reset_at(&db.pool, &tomorrow)
                .await
                .unwrap(),
            None
        );
        assert_eq!(instance_used(&db, &no_reset_day).await, 400);
        assert_eq!(instance_used(&db, &disabled).await, 600);

        // 同一天再跑一次：不能二次清零，也不能再扣用户总量。
        let again = run_daily_reset(&db.pool, now).await.unwrap();
        assert_eq!(again, ResetReport::default());
        assert_eq!(instance_used(&db, &due).await, 0);
        assert_eq!(user_used(&db, &user_id).await, 2000);
    }

    #[tokio::test]
    async fn deduction_saturates_at_zero() {
        let db = setup().await;
        let now = at("2026-11-15T12:00:00+08:00");
        // 用户总量小于实例用量（例如历史数据/并发扣减后），扣到 0 为止。
        let (user_id, package) = new_user(&db, "bob", 100).await;
        let due = bind(&db, &user_id, &package, Some(15), 900).await;

        let report = run_daily_reset(&db.pool, now).await.unwrap();
        assert_eq!(report.deducted_bytes, 900);
        assert_eq!(instance_used(&db, &due).await, 0);
        assert_eq!(user_used(&db, &user_id).await, 0, "不能出现负数");
    }

    #[tokio::test]
    async fn small_month_resets_on_the_clamped_last_day() {
        let db = setup().await;
        let (user_id, package) = new_user(&db, "carol", 2000).await;
        // reset_day = 31，2 月（28 天）压到 28 号。
        let clamped = bind(&db, &user_id, &package, Some(31), 1200).await;

        // 2 月 27 日不是月末，不重置。
        let before = run_daily_reset(&db.pool, at("2023-02-27T23:59:59+08:00"))
            .await
            .unwrap();
        assert_eq!(before, ResetReport::default());
        assert_eq!(instance_used(&db, &clamped).await, 1200);

        // 2 月 28 日命中（压到当月最后一天）。
        let on_last_day = run_daily_reset(&db.pool, at("2023-02-28T00:30:00+08:00"))
            .await
            .unwrap();
        assert_eq!(
            on_last_day,
            ResetReport {
                instances: 1,
                deducted_bytes: 1200
            }
        );
        assert_eq!(instance_used(&db, &clamped).await, 0);
        assert_eq!(user_used(&db, &user_id).await, 800);

        // 3 月有 31 天，3 月 30 日不该提前重置。
        let march_30 = run_daily_reset(&db.pool, at("2023-03-30T12:00:00+08:00"))
            .await
            .unwrap();
        assert_eq!(march_30, ResetReport::default());
        // 3 月 31 日才是下一个重置日。
        let march_31 = run_daily_reset(&db.pool, at("2023-03-31T12:00:00+08:00"))
            .await
            .unwrap();
        assert_eq!(march_31.instances, 1);
    }
}
