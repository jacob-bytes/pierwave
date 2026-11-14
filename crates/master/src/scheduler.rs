//! 后台调度：每日流量重置 + 断流过期对账 + 过期会话清理。
//!
//! 三个任务都用 `tokio::time::interval`，启动后立刻先跑一轮（第一次 tick 立即完成）。
//! 判定与幂等都在领域层/`crate::enforcement` 里，这里只负责触发和记日志，
//! 定时器不参与业务逻辑。

use std::time::Duration;

use pierwave_domain::{repo, reset, time};

use crate::enforcement;
use crate::state::AppState;

/// 每小时一轮。`reset_day` 只精确到天，每小时检查一次足够。
const RESET_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// 断流对账：每 5 分钟扫一次「有 active 实例但全部不可用」的用户。
///
/// 流量上报能实时发现「刚跑满」，但「到期」没有事件源，只能靠对账兜底；
/// 对账只标记脏，真正的 apply 由去抖 worker 合并执行。
const ENFORCEMENT_RECONCILE_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// 过期会话清理：每小时扫一次库即可，清理量与登录量成正比、单次很轻。
const SESSION_PURGE_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// 服务器采样：5 分钟一笔，公开状态页的可用率依赖它。
const SERVER_SAMPLE_INTERVAL: Duration =
    Duration::from_secs(repo::server_samples::SAMPLE_INTERVAL_SECS as u64);

/// 转发流量采样：60 秒一轮。
///
/// Agent 心跳默认 15 秒一次，60 秒足够把累计计数器转成稳定的增量；
/// 计数器归零（Agent 重启 / 规则重建）由 `forwards::traffic_delta` 兜底。
const FORWARD_TRAFFIC_SAMPLE_INTERVAL: Duration = Duration::from_secs(60);

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

/// 执行一轮过期会话清理，返回删除条数。
///
/// 会话过期后 `user_for_token` 已经不会认它，这里只是把死行清出库，
/// 避免 `sessions` 表随登录次数无限增长。
/// 升级超时巡检间隔：一分钟一次足够，不影响正常升级。
const UPGRADE_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// 超过这个时间仍未确认的升级判失败（心跳默认 1 分钟一次，15 分钟足够完成一次升级 + 稳定窗口）。
const UPGRADE_TIMEOUT_SECS: i64 = 900;

/// 把卡住的 pending 升级标成失败并清空目标版本。
pub async fn run_upgrade_sweep(state: &AppState) -> anyhow::Result<Vec<String>> {
    let expired = pierwave_domain::repo::agent_upgrades::expire_stale(
        &state.db.pool,
        pierwave_domain::time::now(),
        UPGRADE_TIMEOUT_SECS,
        "升级超时：Agent 在预期时间内没有上报新版本，已视为失败（本地看门狗会自动回滚）",
    )
    .await?;
    for server_id in &expired {
        tracing::warn!(server_id, "Agent 升级超时，已标记失败并清空目标版本");
        // 告警是旁路；同一台机器短时间内重复超时由 alerts 的冷却窗口兜底。
        crate::alerts::notify(
            state,
            crate::alerts::AlertKind::UpgradeFailed,
            server_id,
            "Agent 升级失败 / Agent upgrade failed",
            &format!(
                "服务器 {server_id} 的 Agent 升级超时，已标记失败 / Agent upgrade on server {server_id} timed out and was marked failed"
            ),
        )
        .await;
    }
    Ok(expired)
}

/// 启动升级超时巡检。
pub fn spawn_upgrade_sweep(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(UPGRADE_SWEEP_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(error) = run_upgrade_sweep(&state).await {
                tracing::error!(error = %error, "升级超时巡检失败");
            }
        }
    })
}

/// 批量升级 runner 间隔：10 秒足够让状态同步看起来是实时的，也不会太吵。
const UPGRADE_BATCH_INTERVAL: Duration = Duration::from_secs(10);
/// 遇错即停时给剩余 queued 的说明。
const SKIPPED_ERROR: &str = "同批次已有失败，剩余任务已跳过（stop_on_failure = true）";

/// 一轮批量升级的总览，方便日志与测试断言。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct BatchRoundReport {
    /// 本轮扫描到的、还有 queued/running item 的批次数。
    pub batches: usize,
    /// 从 `agent_upgrades` 同步成终态的 item 数。
    pub synced: usize,
    /// 本轮新触发的升级数。
    pub triggered: usize,
    /// 收敛为终态的批次数。
    pub finalized: usize,
}

/// 批量升级 runner 的一轮：只通过读写数据库协调，不重写升级逻辑。
///
/// 五步（对应 PLAN）：
/// 1. 读取设置里的并发数并夹在 1..=5；
/// 2. 把 running item 与 `agent_upgrades.status` 同步；
/// 3. `stop_on_failure` 时把剩余 queued 标 skipped、批次 failed；
/// 4. 未到并发上限就按顺序触发 queued（复用单台触发函数）；
/// 5. 全部终态时收敛批次状态。
pub async fn run_batch_round(state: &AppState) -> anyhow::Result<BatchRoundReport> {
    let settings = crate::routes::settings::load(&state.db.pool).await;
    let concurrency = settings.agent_upgrade_concurrency.clamp(
        crate::routes::settings::MIN_AGENT_UPGRADE_CONCURRENCY,
        crate::routes::settings::MAX_AGENT_UPGRADE_CONCURRENCY,
    );

    let batches = repo::upgrade_batches::active(&state.db.pool).await?;
    let mut report = BatchRoundReport {
        batches: batches.len(),
        ..Default::default()
    };
    for batch in batches {
        process_batch(state, &batch, concurrency, &mut report).await?;
    }
    Ok(report)
}

async fn process_batch(
    state: &AppState,
    batch: &pierwave_domain::models::AgentUpgradeBatch,
    concurrency: i64,
    report: &mut BatchRoundReport,
) -> anyhow::Result<()> {
    // 步骤 2：running item 以 `agent_upgrades.status` 为准。
    let items = repo::upgrade_batches::items(&state.db.pool, &batch.id).await?;
    for item in items.iter().filter(|item| item.status == "running") {
        let upgrade = match item.upgrade_id.as_deref() {
            Some(id) => repo::agent_upgrades::find_by_id(&state.db.pool, id).await?,
            None => {
                // 进程可能死在「创建升级记录」和「回填 upgrade_id」之间。
                // 只认同一目标版本的记录，避免把批次之前的历史升级误认成自己的。
                let recovered = repo::agent_upgrades::latest(&state.db.pool, &item.server_id)
                    .await?
                    .filter(|upgrade| upgrade.to_version == batch.to_version);
                if let Some(upgrade) = &recovered {
                    repo::upgrade_batches::set_item_upgrade(
                        &state.db.pool,
                        &batch.id,
                        &item.server_id,
                        &upgrade.id,
                    )
                    .await?;
                }
                recovered
            }
        };
        let (status, error) = match upgrade {
            None => ("failed", "升级记录不存在或已被清理".to_string()),
            Some(upgrade) => match upgrade.status.as_str() {
                "succeeded" => ("succeeded", String::new()),
                "failed" => (
                    "failed",
                    if upgrade.error.is_empty() {
                        "升级失败".to_string()
                    } else {
                        upgrade.error
                    },
                ),
                // pending：Agent 还在下载/重启，保持 running 等下一轮。
                _ => continue,
            },
        };
        repo::upgrade_batches::mark_item(
            &state.db.pool,
            &batch.id,
            &item.server_id,
            status,
            &error,
        )
        .await?;
        report.synced += 1;
    }

    // 步骤 3：只要出现过 failed，遇错即停就把剩余 queued 全部跳过。
    let mut items = repo::upgrade_batches::items(&state.db.pool, &batch.id).await?;
    if batch.stop_on_failure && items.iter().any(|item| item.status == "failed") {
        repo::upgrade_batches::skip_queued(&state.db.pool, &batch.id, SKIPPED_ERROR).await?;
        if batch.status == "running" {
            repo::upgrade_batches::mark(&state.db.pool, &batch.id, "failed").await?;
            report.finalized += 1;
        }
        items = repo::upgrade_batches::items(&state.db.pool, &batch.id).await?;
    }

    // 步骤 5（提前收敛）：所有 item 都已终态，不再触发。
    if items.iter().all(|item| is_terminal(&item.status)) {
        let status = final_batch_status(&items);
        if batch.status != status {
            repo::upgrade_batches::mark(&state.db.pool, &batch.id, status).await?;
            report.finalized += 1;
        }
        return Ok(());
    }

    // 取消或遇错即停后批次可能已是终态；不再触发新升级，但仍保留在 active()
    // 里继续同步 running item，直到它们自然收敛。
    if batch.status != "running" {
        return Ok(());
    }

    // 步骤 4：按 item 插入顺序（即请求里的 server_ids 顺序）触发。
    let running = items.iter().filter(|item| item.status == "running").count() as i64;
    let slots = (concurrency - running).max(0);
    if slots == 0 {
        return Ok(());
    }
    let queued: Vec<pierwave_domain::models::AgentUpgradeBatchItemView> = items
        .into_iter()
        .filter(|item| item.status == "queued")
        .take(slots as usize)
        .collect();

    let mut saw_failure = false;
    for item in &queued {
        match crate::routes::servers::trigger_single_upgrade(
            state,
            &item.server_id,
            &batch.to_version,
        )
        .await
        {
            Ok(upgrade) => {
                repo::upgrade_batches::start_item(
                    &state.db.pool,
                    &batch.id,
                    &item.server_id,
                    &upgrade.id,
                )
                .await?;
                report.triggered += 1;
            }
            Err(error) => {
                repo::upgrade_batches::mark_item(
                    &state.db.pool,
                    &batch.id,
                    &item.server_id,
                    "failed",
                    &error.to_string(),
                )
                .await?;
                report.synced += 1;
                saw_failure = true;
                if batch.stop_on_failure {
                    break;
                }
            }
        }
    }

    // 触发阶段产生的失败同样要落到「剩余 skipped / 批次 failed」。
    if saw_failure && batch.stop_on_failure {
        repo::upgrade_batches::skip_queued(&state.db.pool, &batch.id, SKIPPED_ERROR).await?;
        repo::upgrade_batches::mark(&state.db.pool, &batch.id, "failed").await?;
        report.finalized += 1;
    }

    let items = repo::upgrade_batches::items(&state.db.pool, &batch.id).await?;
    if items.iter().all(|item| is_terminal(&item.status)) {
        let status = final_batch_status(&items);
        repo::upgrade_batches::mark(&state.db.pool, &batch.id, status).await?;
        report.finalized += 1;
    }
    Ok(())
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "skipped" | "cancelled")
}

/// 有失败就是 failed；用户取消过、但全部跑完的批次是 cancelled；否则 succeeded。
fn final_batch_status(
    items: &[pierwave_domain::models::AgentUpgradeBatchItemView],
) -> &'static str {
    if items.iter().any(|item| item.status == "failed") {
        "failed"
    } else if items.iter().any(|item| item.status == "cancelled") {
        "cancelled"
    } else {
        "succeeded"
    }
}

/// 启动批量升级 runner。
pub fn spawn_upgrade_batch_runner(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(UPGRADE_BATCH_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match run_batch_round(&state).await {
                Ok(report) if report.triggered > 0 || report.finalized > 0 => {
                    tracing::info!(
                        batches = report.batches,
                        triggered = report.triggered,
                        synced = report.synced,
                        finalized = report.finalized,
                        "批量升级 runner 已推进"
                    );
                }
                Ok(_) => tracing::debug!("批量升级 runner：没有需要推进的批次"),
                Err(error) => tracing::error!(error = %error, "批量升级 runner 失败"),
            }
        }
    })
}

/// 执行一轮服务器采样：把 `servers` 当前状态抄进 `server_samples`，并清理 7 天前的行。
///
/// 离线服务器也会写 `online = 0`；否则离线时段不进入可用率的分母。
pub async fn run_sample_round(
    state: &AppState,
) -> anyhow::Result<repo::server_samples::SampleRound> {
    let report = repo::server_samples::record_round(&state.db.pool, repo::now()).await?;
    if report.recorded > 0 || report.pruned > 0 {
        tracing::debug!(
            recorded = report.recorded,
            pruned = report.pruned,
            "服务器采样完成"
        );
    }
    Ok(report)
}

/// 启动服务器采样任务；第一次 tick 立即执行，启动时先落一笔。
pub fn spawn_server_samples(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SERVER_SAMPLE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(error) = run_sample_round(&state).await {
                tracing::error!(error = %error, "服务器采样失败");
            }
        }
    })
}

/// 执行一轮转发流量采样：把 Agent 心跳的累计计数器差值计入日表与用户套餐。
///
/// 这里只负责触发与日志；差值/重置/并发规则全在
/// [`pierwave_domain::repo::forward_traffic`] 里，调度器不参与业务判断。
pub async fn run_forward_traffic_round(
    state: &AppState,
) -> anyhow::Result<repo::forward_traffic::SampleReport> {
    let report = repo::forward_traffic::run_round(&state.db.pool, time::now()).await?;
    if report.bytes > 0 || report.weighted > 0 {
        tracing::info!(
            rules = report.rules,
            bytes = report.bytes,
            weighted = report.weighted,
            failed = report.failed,
            "转发流量采样完成"
        );
    } else {
        tracing::debug!(
            rules = report.rules,
            failed = report.failed,
            "转发流量采样：本轮没有新增流量"
        );
    }
    Ok(report)
}

/// 启动转发流量采样任务；第一次 tick 立即执行。
pub fn spawn_forward_traffic_sampler(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(FORWARD_TRAFFIC_SAMPLE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(error) = run_forward_traffic_round(&state).await {
                // 采样失败只记日志：不阻塞心跳、不影响断流/重置等其它任务。
                tracing::error!(error = %error, "转发流量采样失败");
            }
        }
    })
}

pub async fn run_session_purge(state: &AppState) -> anyhow::Result<u64> {
    let purged = repo::sessions::purge_expired(&state.db.pool).await?;
    if purged > 0 {
        tracing::info!(purged, "已清理过期会话");
    } else {
        tracing::debug!("会话清理：没有过期会话");
    }
    Ok(purged)
}

/// 启动过期会话清理任务；第一次 tick 立即执行，所以启动时就会先扫一遍。
pub fn spawn_session_purge(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SESSION_PURGE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(error) = run_session_purge(&state).await {
                tracing::error!(error = %error, "过期会话清理失败");
            }
        }
    })
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

/// 启动断流过期对账；`PIERWAVE_ENFORCE=0` 时直接退出。
pub fn spawn_enforcement_reconcile(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if !state.enforcement.enabled() {
            tracing::info!("PIERWAVE_ENFORCE=0：断流触发已关闭，对账任务不启动");
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    use pierwave_domain::Db;

    use crate::alerts::{Alerts, RecordingTransport};

    async fn setup_with_expired_session(valid_session: bool) -> AppState {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let user = repo::users::create(
            &db.pool,
            repo::users::NewUser {
                username: "alice".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        repo::sessions::create(&db.pool, &user.id, -60, None)
            .await
            .unwrap();
        if valid_session {
            repo::sessions::create(&db.pool, &user.id, 3600, None)
                .await
                .unwrap();
        }
        AppState::new(db, "web/dist")
    }

    #[tokio::test]
    async fn session_purge_empties_a_table_with_only_expired_rows() {
        let state = setup_with_expired_session(false).await;
        assert_eq!(repo::sessions::count(&state.db.pool).await.unwrap(), 1);

        assert_eq!(run_session_purge(&state).await.unwrap(), 1);
        assert_eq!(
            repo::sessions::count(&state.db.pool).await.unwrap(),
            0,
            "过期会话必须清空"
        );

        // 再跑一轮没有可清理的，保持幂等。
        assert_eq!(run_session_purge(&state).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn session_purge_keeps_valid_rows() {
        let state = setup_with_expired_session(true).await;
        assert_eq!(repo::sessions::count(&state.db.pool).await.unwrap(), 2);

        assert_eq!(run_session_purge(&state).await.unwrap(), 1);
        assert_eq!(
            repo::sessions::count(&state.db.pool).await.unwrap(),
            1,
            "有效会话不能被误删"
        );
    }

    // ---- 批量 Agent 升级 runner ----

    async fn setup_batch_state() -> AppState {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        AppState::new(db, "web/dist")
    }

    async fn seed_upgrade_server(state: &AppState, name: &str, version: &str) -> String {
        let (server, _token) = repo::servers::create(&state.db.pool, name, "1.2.3.4", "external")
            .await
            .unwrap();
        repo::servers::update(&state.db.pool, &server.id, None, None, None, Some(true))
            .await
            .unwrap();
        repo::servers::update_health(
            &state.db.pool,
            &server.id,
            version,
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        server.id
    }

    async fn set_concurrency(state: &AppState, value: i64) {
        repo::settings::set(
            &state.db.pool,
            "agent_upgrade_concurrency",
            &value.to_string(),
        )
        .await
        .unwrap();
    }

    async fn items_of(state: &AppState, batch_id: &str) -> Vec<(String, String)> {
        repo::upgrade_batches::items(&state.db.pool, batch_id)
            .await
            .unwrap()
            .into_iter()
            .map(|item| (item.status, item.server_id))
            .collect()
    }

    async fn batch_status(state: &AppState, batch_id: &str) -> String {
        repo::upgrade_batches::find_by_id(&state.db.pool, batch_id)
            .await
            .unwrap()
            .status
    }

    #[tokio::test]
    async fn batch_runner_with_concurrency_one_is_strictly_serial() {
        let state = setup_batch_state().await;
        set_concurrency(&state, 1).await;
        let first = seed_upgrade_server(&state, "a", "0.5.0").await;
        let second = seed_upgrade_server(&state, "b", "0.5.0").await;
        let batch = repo::upgrade_batches::create(
            &state.db.pool,
            &[first.clone(), second.clone()],
            "0.6.0",
            true,
            1,
        )
        .await
        .unwrap();

        let report = run_batch_round(&state).await.unwrap();
        assert_eq!(report.triggered, 1);
        let items = items_of(&state, &batch.id).await;
        assert_eq!(items[0].0, "running");
        assert_eq!(items[1].0, "queued", "并发 1 时第二台必须排队");
        assert_eq!(
            repo::agent_upgrades::list_by_server(&state.db.pool, &second)
                .await
                .unwrap()
                .len(),
            0,
            "第一台未终态前不能触发第二台"
        );

        // 第一台仍在 pending：再跑几轮也不应该发第二台。
        for _ in 0..3 {
            assert_eq!(run_batch_round(&state).await.unwrap().triggered, 0);
        }
        let items = items_of(&state, &batch.id).await;
        assert_eq!(items[0].0, "running");
        assert_eq!(items[1].0, "queued");
        assert_eq!(
            repo::agent_upgrades::list_by_server(&state.db.pool, &second)
                .await
                .unwrap()
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn batch_runner_honors_concurrency_two_and_never_exceeds_it() {
        let state = setup_batch_state().await;
        set_concurrency(&state, 2).await;
        let first = seed_upgrade_server(&state, "a", "0.5.0").await;
        let second = seed_upgrade_server(&state, "b", "0.5.0").await;
        let third = seed_upgrade_server(&state, "c", "0.5.0").await;
        let batch = repo::upgrade_batches::create(
            &state.db.pool,
            &[first.clone(), second.clone(), third.clone()],
            "0.6.0",
            true,
            2,
        )
        .await
        .unwrap();

        let report = run_batch_round(&state).await.unwrap();
        assert_eq!(report.triggered, 2);
        let items = items_of(&state, &batch.id).await;
        assert_eq!(items[0].0, "running");
        assert_eq!(items[1].0, "running");
        assert_eq!(items[2].0, "queued", "并发上限 2，第三台不能启动");

        // 两个 running 占满名额，再跑一轮不会多触发。
        assert_eq!(run_batch_round(&state).await.unwrap().triggered, 0);
        let items = items_of(&state, &batch.id).await;
        assert_eq!(
            items
                .iter()
                .filter(|(status, _)| status == "running")
                .count(),
            2
        );
        assert_eq!(
            repo::agent_upgrades::list_by_server(&state.db.pool, &third)
                .await
                .unwrap()
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn stop_on_failure_marks_remaining_items_skipped() {
        let state = setup_batch_state().await;
        set_concurrency(&state, 1).await;
        let first = seed_upgrade_server(&state, "a", "0.5.0").await;
        let second = seed_upgrade_server(&state, "b", "0.5.0").await;
        let third = seed_upgrade_server(&state, "c", "0.5.0").await;
        let batch = repo::upgrade_batches::create(
            &state.db.pool,
            &[first.clone(), second.clone(), third.clone()],
            "0.6.0",
            true,
            1,
        )
        .await
        .unwrap();

        run_batch_round(&state).await.unwrap();
        let upgrade = repo::agent_upgrades::latest(&state.db.pool, &first)
            .await
            .unwrap()
            .unwrap();
        repo::agent_upgrades::mark(&state.db.pool, &upgrade.id, "failed", "模拟失败")
            .await
            .unwrap();

        run_batch_round(&state).await.unwrap();
        let items = items_of(&state, &batch.id).await;
        assert_eq!(items[0].0, "failed");
        assert_eq!(items[1].0, "skipped");
        assert_eq!(items[2].0, "skipped");
        assert_eq!(batch_status(&state, &batch.id).await, "failed");
        assert_eq!(
            repo::agent_upgrades::list_by_server(&state.db.pool, &second)
                .await
                .unwrap()
                .len(),
            0,
            "遇错即停后剩余的不能再触发"
        );
        assert_eq!(
            repo::agent_upgrades::list_by_server(&state.db.pool, &third)
                .await
                .unwrap()
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn continue_on_failure_runs_the_rest_then_marks_batch_failed() {
        let state = setup_batch_state().await;
        set_concurrency(&state, 1).await;
        let first = seed_upgrade_server(&state, "a", "0.5.0").await;
        let second = seed_upgrade_server(&state, "b", "0.5.0").await;
        let batch = repo::upgrade_batches::create(
            &state.db.pool,
            &[first.clone(), second.clone()],
            "0.6.0",
            false,
            1,
        )
        .await
        .unwrap();

        run_batch_round(&state).await.unwrap();
        let upgrade = repo::agent_upgrades::latest(&state.db.pool, &first)
            .await
            .unwrap()
            .unwrap();
        repo::agent_upgrades::mark(&state.db.pool, &upgrade.id, "failed", "模拟失败")
            .await
            .unwrap();

        // stop_on_failure=false：第一台失败后，同一轮里第二台立刻被触发。
        let report = run_batch_round(&state).await.unwrap();
        assert_eq!(report.triggered, 1);
        let items = items_of(&state, &batch.id).await;
        assert_eq!(items[0].0, "failed");
        assert_eq!(items[1].0, "running");

        let second_upgrade = repo::agent_upgrades::latest(&state.db.pool, &second)
            .await
            .unwrap()
            .unwrap();
        repo::agent_upgrades::mark(&state.db.pool, &second_upgrade.id, "succeeded", "")
            .await
            .unwrap();

        run_batch_round(&state).await.unwrap();
        let items = items_of(&state, &batch.id).await;
        assert_eq!(items[0].0, "failed");
        assert_eq!(items[1].0, "succeeded", "允许继续时剩余任务必须跑完");
        assert_eq!(
            batch_status(&state, &batch.id).await,
            "failed",
            "有失败时批次最终仍是 failed，但明细保留"
        );
    }

    #[tokio::test]
    async fn cancel_does_not_interrupt_running_item_and_converges_to_cancelled() {
        let state = setup_batch_state().await;
        set_concurrency(&state, 1).await;
        let first = seed_upgrade_server(&state, "a", "0.5.0").await;
        let second = seed_upgrade_server(&state, "b", "0.5.0").await;
        let batch = repo::upgrade_batches::create(
            &state.db.pool,
            &[first.clone(), second.clone()],
            "0.6.0",
            true,
            1,
        )
        .await
        .unwrap();

        run_batch_round(&state).await.unwrap();
        let cancelled = repo::upgrade_batches::cancel_queued(
            &state.db.pool,
            &batch.id,
            "批次已取消，任务未开始",
        )
        .await
        .unwrap();
        assert_eq!(cancelled, 1);

        // 运行中的升级不打断：状态仍是 running，批次也保持 running。
        run_batch_round(&state).await.unwrap();
        let items = items_of(&state, &batch.id).await;
        assert_eq!(items[0].0, "running");
        assert_eq!(items[1].0, "cancelled");
        assert_eq!(batch_status(&state, &batch.id).await, "running");

        // 运行中的升级自然成功；没有 queued 了，批次收敛为 cancelled。
        let upgrade = repo::agent_upgrades::latest(&state.db.pool, &first)
            .await
            .unwrap()
            .unwrap();
        repo::agent_upgrades::mark(&state.db.pool, &upgrade.id, "succeeded", "")
            .await
            .unwrap();
        run_batch_round(&state).await.unwrap();
        let items = items_of(&state, &batch.id).await;
        assert_eq!(items[0].0, "succeeded");
        assert_eq!(items[1].0, "cancelled");
        assert_eq!(batch_status(&state, &batch.id).await, "cancelled");
    }

    /// 超时巡检把 `agent_upgrades` 标 failed 后，批量 runner 下一轮必须同步到 item。
    /// 时间通过「把 created_at 往前拨」注入，测试不依赖真实等待 15 分钟。
    #[tokio::test]
    async fn timed_out_upgrade_is_synced_to_failed_item() {
        let state = setup_batch_state().await;
        set_concurrency(&state, 1).await;
        let first = seed_upgrade_server(&state, "a", "0.5.0").await;
        let second = seed_upgrade_server(&state, "b", "0.5.0").await;
        let batch = repo::upgrade_batches::create(
            &state.db.pool,
            &[first.clone(), second.clone()],
            "0.6.0",
            true,
            1,
        )
        .await
        .unwrap();

        run_batch_round(&state).await.unwrap();
        let upgrade = repo::agent_upgrades::latest(&state.db.pool, &first)
            .await
            .unwrap()
            .unwrap();
        sqlx::query(
            "UPDATE agent_upgrades SET created_at = created_at - 2000, updated_at = updated_at - 2000 WHERE id = ?",
        )
        .bind(&upgrade.id)
        .execute(&state.db.pool)
        .await
        .unwrap();

        assert_eq!(
            run_upgrade_sweep(&state).await.unwrap(),
            vec![first.clone()]
        );
        run_batch_round(&state).await.unwrap();
        let items = items_of(&state, &batch.id).await;
        assert_eq!(items[0].0, "failed");
        assert_eq!(items[1].0, "skipped");
        assert_eq!(batch_status(&state, &batch.id).await, "failed");

        // 失败原因来自 upgrade 记录，不是空串。
        let detail = repo::upgrade_batches::items(&state.db.pool, &batch.id)
            .await
            .unwrap();
        assert!(detail[0].error.contains("超时"), "{}", detail[0].error);
    }

    /// 超时巡检标记 failed 时也要发 UpgradeFailed 告警。
    #[tokio::test]
    async fn timed_out_upgrade_sends_upgrade_failed_alert() {
        let mut state = setup_batch_state().await;
        let transport = Arc::new(RecordingTransport::default());
        state.alerts = Alerts::new(transport.clone());
        repo::settings::set(&state.db.pool, "webhook_url", "https://example.test/hook")
            .await
            .unwrap();
        repo::settings::set(&state.db.pool, "alert_events", "upgrade_failed")
            .await
            .unwrap();
        repo::settings::set(&state.db.pool, "alert_cooldown_secs", "0")
            .await
            .unwrap();

        let server_id = seed_upgrade_server(&state, "a", "0.5.0").await;
        repo::servers::set_agent_target_version(&state.db.pool, &server_id, Some("0.6.0"))
            .await
            .unwrap();
        let upgrade = repo::agent_upgrades::create(&state.db.pool, &server_id, "0.5.0", "0.6.0")
            .await
            .unwrap();
        sqlx::query(
            "UPDATE agent_upgrades SET created_at = created_at - 2000, updated_at = updated_at - 2000 WHERE id = ?",
        )
        .bind(&upgrade.id)
        .execute(&state.db.pool)
        .await
        .unwrap();

        assert_eq!(
            run_upgrade_sweep(&state).await.unwrap(),
            vec![server_id.clone()]
        );

        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "upgrade_failed");
        assert_eq!(sent[0].target, server_id);
    }

    // ---- 探针采样 ----

    #[tokio::test]
    async fn sample_round_writes_aligned_rows_for_online_and_offline_servers() {
        let state = setup_batch_state().await;
        let online = seed_upgrade_server(&state, "a", "0.5.0").await;
        let (offline, _token) = repo::servers::create(&state.db.pool, "b", "10.0.0.2", "external")
            .await
            .unwrap();

        let report = run_sample_round(&state).await.unwrap();
        assert_eq!(report.recorded, 2, "在线和离线服务器都要落一行");

        let online_rows = repo::server_samples::list(&state.db.pool, &online, 0)
            .await
            .unwrap();
        assert_eq!(online_rows.len(), 1);
        assert_eq!(online_rows[0].ts % 300, 0, "ts 必须对齐到 5 分钟");
        assert!(online_rows[0].online);

        let offline_rows = repo::server_samples::list(&state.db.pool, &offline.id, 0)
            .await
            .unwrap();
        assert_eq!(offline_rows.len(), 1);
        assert!(
            !offline_rows[0].online,
            "离线服务器也必须写 online = 0，否则可用率分母少一段"
        );

        // 同一个 5 分钟桶再跑一轮：upsert 覆盖，不新增行。
        let again = run_sample_round(&state).await.unwrap();
        assert_eq!(again.recorded, 2);
        assert_eq!(
            repo::server_samples::list(&state.db.pool, &online, 0)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn sample_round_prunes_rows_older_than_seven_days() {
        let state = setup_batch_state().await;
        let (server, _token) = repo::servers::create(&state.db.pool, "a", "10.0.0.1", "external")
            .await
            .unwrap();
        let now = repo::now();
        let old_ts = now - 8 * 86_400;

        repo::server_samples::record_round(&state.db.pool, old_ts)
            .await
            .unwrap();
        assert_eq!(
            repo::server_samples::list(&state.db.pool, &server.id, 0)
                .await
                .unwrap()
                .len(),
            1,
            "先造一条 8 天前的行"
        );

        let report = run_sample_round(&state).await.unwrap();
        assert_eq!(report.pruned, 1, "每轮都要顺带清理 7 天前的行");

        let rows = repo::server_samples::list(&state.db.pool, &server.id, 0)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "只应剩下本轮新写入的行");
        assert!(
            rows[0].ts >= now - repo::server_samples::RETENTION_SECS,
            "7 天前的行必须被删：{rows:?}"
        );
    }

    #[tokio::test]
    async fn trigger_error_marks_item_failed_and_stops_the_batch() {
        let state = setup_batch_state().await;
        set_concurrency(&state, 1).await;
        let first = seed_upgrade_server(&state, "a", "0.6.0").await;
        let second = seed_upgrade_server(&state, "b", "0.6.0").await;
        // 目标版本不比当前新：触发必然失败。
        let batch = repo::upgrade_batches::create(
            &state.db.pool,
            &[first.clone(), second.clone()],
            "0.5.0",
            true,
            1,
        )
        .await
        .unwrap();

        run_batch_round(&state).await.unwrap();
        let items = items_of(&state, &batch.id).await;
        assert_eq!(items[0].0, "failed");
        assert_eq!(items[1].0, "skipped");
        assert_eq!(batch_status(&state, &batch.id).await, "failed");
        assert_eq!(
            repo::agent_upgrades::list_by_server(&state.db.pool, &first)
                .await
                .unwrap()
                .len(),
            0,
            "触发失败不应留下升级记录"
        );
    }

    // ---- 转发流量采样 ----

    /// 心跳写入累计计数器 → 采样轮 → 套餐用量增长（与生产同一条链路）。
    #[tokio::test]
    async fn forward_traffic_round_turns_heartbeat_counters_into_package_usage() {
        let state = setup_batch_state().await;
        let user = repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: "alice".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let package = repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: "计费卡".into(),
                quota_bytes: Some(1_000_000),
                period_days: None,
                direction: "both".into(),
                node_ratio: 2.0,
                rule_template_id: None,
                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        let instance = repo::user_packages::create(
            &state.db.pool,
            &user.id,
            repo::user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap();
        let (server, _token) = repo::servers::create(&state.db.pool, "hk", "1.2.3.4", "external")
            .await
            .unwrap();
        let forward = repo::forwards::create_owned(
            &state.db.pool,
            &server.id,
            repo::forwards::NewForward {
                name: "web".into(),
                listen_port: 20000,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: true,
                count_traffic: true,
                engine: "native".into(),
                protocol: "tcp".into(),
            },
            &user.id,
            10,
        )
        .await
        .unwrap();

        // 第一次心跳：入 1 KiB、出 2 KiB 的累计值。
        repo::forwards::save_status(
            &state.db.pool,
            &server.id,
            &[repo::forwards::NewForwardStatus {
                forward_id: pierwave_domain::forwards::desired_id(&forward.id),
                listening: true,
                error: String::new(),
                target_ok: Some(true),
                target_error: None,
                targets: Vec::new(),
                traffic_in: Some(1024),
                traffic_out: Some(2048),
            }],
        )
        .await
        .unwrap();
        let report = run_forward_traffic_round(&state).await.unwrap();
        // 套餐 node_ratio = 2.0、direction = both：
        // 原始 3072 字节，加权 6144 字节。
        assert_eq!(report.bytes, 3072, "日表 bytes 记原始值");
        assert_eq!(report.weighted, 6144, "套餐用量记加权值");
        assert_eq!(report.failed, 0);

        // 第二次心跳：累计值变成入 4 KiB、出 6 KiB → 只计新增的 7168。
        repo::forwards::save_status(
            &state.db.pool,
            &server.id,
            &[repo::forwards::NewForwardStatus {
                forward_id: pierwave_domain::forwards::desired_id(&forward.id),
                listening: true,
                error: String::new(),
                target_ok: Some(true),
                target_error: None,
                targets: Vec::new(),
                traffic_in: Some(4096),
                traffic_out: Some(6144),
            }],
        )
        .await
        .unwrap();
        let report = run_forward_traffic_round(&state).await.unwrap();
        assert_eq!(report.bytes, 7168);
        assert_eq!(report.weighted, 14_336, "7168 × 2.0");

        let view = repo::user_packages::find_view_by_id(&state.db.pool, &instance.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(view.used_bytes, 20_480, "套餐用量 = 首轮 + 增量（加权）");
        assert_eq!(
            repo::users::find_by_id(&state.db.pool, &user.id)
                .await
                .unwrap()
                .used_bytes,
            20_480
        );
    }
}
