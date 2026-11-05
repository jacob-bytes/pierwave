//! 后台调度：每日流量重置 + 断流过期对账。
//!
//! 两个任务都用 `tokio::time::interval`，启动后立刻先跑一轮（第一次 tick 立即完成）。
//! 判定与幂等都在领域层/`crate::enforcement` 里，这里只负责触发和记日志，
//! 定时器不参与业务逻辑。

use std::time::Duration;

use mmrust_domain::{reset, time};

use crate::enforcement;
use crate::state::AppState;

/// 每小时一轮。`reset_day` 只精确到天，每小时检查一次足够。
const RESET_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// 断流对账：每 5 分钟扫一次「有 active 实例但全部不可用」的用户。
///
/// 流量上报能实时发现「刚跑满」，但「到期」没有事件源，只能靠对账兜底；
/// 对账只标记脏，真正的 apply 由去抖 worker 合并执行。
const ENFORCEMENT_RECONCILE_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// 执行一轮每日重置；有实例被清零时立刻标记所有服务器。
///
/// 三重触发之一（另外两个是绑卡、改额度）：用户状态变了就直接走 30s 去抖，
/// 不再等 5 分钟对账。方向（恢复/移除）由 apply 时的快照差集决定。
pub async fn run_reset_round(state: &AppState) -> anyhow::Result<reset::ResetReport> {
    let report = reset::run_daily_reset(&state.db.pool, time::now()).await?;
    if report.instances > 0 {
        // 标记失败不影响重置本身：5 分钟对账仍是兜底。
        if let Err(error) = enforcement::mark_all_servers_dirty(state).await {
            tracing::error!(error = %error, "每日重置后标记期望态失败");
        }
    }
    Ok(report)
}

/// 启动每日重置任务；句柄由调用方持有到进程退出即可（drop 不会停止任务）。
pub fn spawn_daily_reset(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(RESET_INTERVAL);
        // 机器休眠/卡顿后不要补跑一堆错过的 tick，下一轮继续即可。
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match run_reset_round(&state).await {
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

/// 启动断流过期对账；`MMRUST_ENFORCE=0` 时直接退出。
pub fn spawn_enforcement_reconcile(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if !state.enforcement.enabled() {
            tracing::info!("MMRUST_ENFORCE=0：断流触发已关闭，对账任务不启动");
            return;
        }
        let mut ticker = tokio::time::interval(ENFORCEMENT_RECONCILE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match enforcement::reconcile_once(&state).await {
                Ok(users) if users > 0 => {
                    tracing::info!(users, "断流对账完成，已标记待收敛的服务器");
                }
                Ok(_) => tracing::debug!("断流对账：没有发现需要移除的用户"),
                Err(error) => tracing::error!(error = %error, "断流对账失败"),
            }
        }
    })
}
