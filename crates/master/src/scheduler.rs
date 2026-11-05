//! 后台调度：目前只有每日流量重置。
//!
//! 每小时唤醒一次，启动后立刻先跑一轮（tokio `interval` 的第一次 tick 立即完成）。
//! 判定与幂等都在 `mmrust_domain::reset` / `repo::user_packages` 里，这里只负责
//! 触发和记日志，定时器不参与业务逻辑。

use std::sync::Arc;
use std::time::Duration;

use mmrust_domain::{reset, time, Db};

/// 每小时一轮。`reset_day` 只精确到天，每小时检查一次足够。
const RESET_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// 启动每日重置任务；句柄由调用方持有到进程退出即可（drop 不会停止任务）。
pub fn spawn_daily_reset(db: Arc<Db>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(RESET_INTERVAL);
        // 机器休眠/卡顿后不要补跑一堆错过的 tick，下一轮继续即可。
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match reset::run_daily_reset(&db.pool, time::now()).await {
                Ok(report) if report.instances > 0 => {
                    tracing::info!(
                        instances = report.instances,
                        deducted_bytes = report.deducted_bytes,
                        "已执行每日流量重置"
                    );
                }
                Ok(_) => tracing::debug!("每日重置检查：今天没有待重置的套餐实例"),
                Err(error) => tracing::error!(error = %error, "每日重置失败"),
            }
        }
    })
}
