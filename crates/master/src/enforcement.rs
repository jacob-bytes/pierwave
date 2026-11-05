//! 断流（enforcement）：把「记账」变成「处置」。
//!
//! 链路：
//! 1. 流量上报落库时，如果某张实例从「可用」跨到「不可用」，就调用
//!    [`mark_removal_candidates`] 把这些用户所在服务器的期望态标记为脏；
//! 2. [`spawn_worker`] 是一个去抖 worker：同一台服务器在一个窗口内只 apply 一次，
//!    窗口内继续到来的标记会合并，避免流量风暴触发几十次 apply；
//! 3. apply 复用 `routes::desired::render` + `publish`（和手动 apply / 重连补发同一条路径），
//!    并在 push 成功后 bump `config_version`、写 `desired_snapshots`；
//! 4. 只有真正从配置里消失的用户才写 `enforcement_events`，供管理端追溯；
//! 5. `MMRUST_ENFORCE=0` 时以上全部跳过（默认开启），方便排障。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mmrust_domain::models::Server;
use mmrust_domain::{enforcement as rules, repo, time};
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::routes::desired;
use crate::state::AppState;

/// 去抖窗口：同一台服务器在 30s 内最多 apply 一次。
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_secs(30);

/// 环境变量：`0/false/no/off` 关闭断流；其它值（含未设置）视为开启。
const ENFORCE_ENV: &str = "MMRUST_ENFORCE";

/// 一条待处理的移除：用户因为什么、是否来自可信的实时跨边界。
#[derive(Debug, Clone)]
pub struct RemovalCandidate {
    pub user_id: String,
    pub username: String,
    /// 逗号分隔的原因码，见 [`mmrust_domain::enforcement`]。
    pub reason: String,
    /// `true` = 流量上报当场发现（用户此前一定可用）；
    /// `false` = 5 分钟对账扫出来的（可能只是历史残留，写事件要保守）。
    pub confident: bool,
}

struct PendingApply {
    deadline: Instant,
    candidates: HashMap<String, RemovalCandidate>,
}

/// 去抖状态：每台服务器一个待处理批次 + 一个唤醒信号。
///
/// 用 `std::sync::Mutex` 而不是 tokio Mutex：临界区只有几次 HashMap 操作，
/// 不跨 await 持有，交给同步锁更便宜。
#[derive(Clone)]
pub struct Enforcer {
    enabled: bool,
    window: Duration,
    pending: Arc<Mutex<HashMap<String, PendingApply>>>,
    notify: Arc<Notify>,
}

impl Enforcer {
    pub fn new(enabled: bool, window: Duration) -> Self {
        Self {
            enabled,
            // 窗口为 0 时退化为「每次标记立即 apply」；保留这种形态便于排障。
            window,
            pending: Arc::new(Mutex::new(HashMap::new())),
            notify: Arc::new(Notify::new()),
        }
    }

    /// 默认 30s 窗口，是否启用从 `MMRUST_ENFORCE` 读取。
    pub fn from_env() -> Self {
        Self::new(env_enabled(), DEFAULT_DEBOUNCE)
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// 标记某台服务器的期望态为脏。窗口内重复标记会合并成同一批。
    pub fn mark_dirty(&self, server_id: &str, candidates: Vec<RemovalCandidate>) {
        if !self.enabled || candidates.is_empty() {
            return;
        }
        let now = Instant::now();
        {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // 截止时间固定在「窗口内第一次标记」：流量持续不断时也保证 30s 内
            // 至少 apply 一次，不会被无限顺延。
            let entry = pending
                .entry(server_id.to_string())
                .or_insert_with(|| PendingApply {
                    deadline: now + self.window,
                    candidates: HashMap::new(),
                });
            for candidate in candidates {
                entry
                    .candidates
                    .entry(candidate.user_id.clone())
                    .and_modify(|existing| {
                        existing.confident |= candidate.confident;
                        existing.reason = rules::merge_reasons([
                            existing.reason.as_str(),
                            candidate.reason.as_str(),
                        ]);
                        existing.username.clone_from(&candidate.username);
                    })
                    .or_insert(candidate);
            }
        }
        self.notify.notify_one();
    }

    /// 取出所有已到截止时间的批次（按插入顺序不保证，但互不影响）。
    fn take_due(&self) -> Vec<(String, HashMap<String, RemovalCandidate>)> {
        let now = Instant::now();
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let due: Vec<String> = pending
            .iter()
            .filter(|(_, batch)| batch.deadline <= now)
            .map(|(server_id, _)| server_id.clone())
            .collect();
        due.into_iter()
            .filter_map(|server_id| {
                pending
                    .remove(&server_id)
                    .map(|batch| (server_id, batch.candidates))
            })
            .collect()
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .map(|batch| batch.deadline)
            .min()
    }
}

fn env_enabled() -> bool {
    match std::env::var(ENFORCE_ENV) {
        Ok(raw) => !matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}

/// 启动去抖 worker；`MMRUST_ENFORCE=0` 时直接退出。
pub fn spawn_worker(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let enforcer = state.enforcement.clone();
        if !enforcer.enabled {
            tracing::info!("{ENFORCE_ENV}=0：断流触发已关闭，去抖 worker 不启动");
            return;
        }
        loop {
            enforcer.notify.notified().await;
            loop {
                let due = enforcer.take_due();
                if !due.is_empty() {
                    for (server_id, candidates) in due {
                        apply_dirty_server(&state, &server_id, candidates).await;
                    }
                    continue;
                }
                match enforcer.next_deadline() {
                    Some(deadline) => {
                        // 等到下一批到期，或有人在此期间又标记了新的服务器。
                        tokio::select! {
                            _ = tokio::time::sleep_until(deadline) => {}
                            _ = enforcer.notify.notified() => {}
                        }
                    }
                    None => break,
                }
            }
        }
    })
}

/// 流量上报跨过边界 / 对账发现残留后，标记所有「可能包含该用户 client」的服务器。
///
/// 资格是全局的（任何一台有启用节点的服务器都会给可用用户注入 client），
/// 所以用户一旦失去资格，就要让所有有启用节点的服务器重新收敛。
pub async fn mark_removal_candidates(
    state: &AppState,
    candidates: Vec<RemovalCandidate>,
) -> anyhow::Result<()> {
    if !state.enforcement.enabled() || candidates.is_empty() {
        return Ok(());
    }
    let server_ids = repo::servers::list_ids_with_enabled_nodes(&state.db.pool).await?;
    if server_ids.is_empty() {
        return Ok(());
    }
    tracing::info!(
        users = candidates.len(),
        servers = server_ids.len(),
        "流量上报跨过可用边界，标记服务器期望态为脏"
    );
    for server_id in &server_ids {
        state.enforcement.mark_dirty(server_id, candidates.clone());
    }
    Ok(())
}

/// 5 分钟对账：扫出「有 active 实例但全部不可用」的用户，标记脏。
///
/// 这里不直接 apply：交给去抖 worker 合并处理；worker 会先比对
/// `desired_snapshots.fingerprint/config_version`，期望态没变就跳过，不做空转。
pub async fn reconcile_once(state: &AppState) -> anyhow::Result<usize> {
    if !state.enforcement.enabled() {
        return Ok(0);
    }
    let unusable = repo::enforcement::list_unusable_users(&state.db.pool, time::now()).await?;
    if unusable.is_empty() {
        return Ok(0);
    }
    let server_ids = repo::servers::list_ids_with_enabled_nodes(&state.db.pool).await?;
    if server_ids.is_empty() {
        return Ok(0);
    }
    let users = unusable.len();
    let candidates: Vec<RemovalCandidate> = unusable
        .into_iter()
        .map(|user| RemovalCandidate {
            user_id: user.user_id,
            username: user.username,
            reason: user.reason,
            // 对账看到的是「当前状态」，不代表这次扫描时用户的 client 还在配置里。
            confident: false,
        })
        .collect();
    for server_id in &server_ids {
        state.enforcement.mark_dirty(server_id, candidates.clone());
    }
    tracing::info!(
        users,
        servers = server_ids.len(),
        "过期对账：发现不可用用户，已标记期望态为脏"
    );
    Ok(users)
}

async fn apply_dirty_server(
    state: &AppState,
    server_id: &str,
    candidates: HashMap<String, RemovalCandidate>,
) {
    let server = match repo::servers::find_by_id(&state.db.pool, server_id).await {
        Ok(server) => server,
        Err(error) => {
            if error
                .downcast_ref::<sqlx::Error>()
                .is_some_and(|error| matches!(error, sqlx::Error::RowNotFound))
            {
                tracing::debug!(server_id, "服务器已删除，丢弃断流批次");
            } else {
                tracing::error!(server_id, error = %error, "读取服务器失败，丢弃断流批次");
            }
            return;
        }
    };
    if let Err(error) = apply_server(state, &server, candidates).await {
        tracing::error!(server = %server.name, error = %error, "断流 apply 失败");
    }
}

/// 对单台服务器执行一次断流 apply。
///
/// 关键点：
/// * **先比对再 bump**：渲染结果与 `desired_snapshots` 完全一致时直接返回，
///   不递增 `config_version`、不广播（对账每 5 分钟跑一次也不会产生版本噪音）；
/// * **复用同一条推送路径**：[`desired::publish`] 与手动 apply、Agent 重连补发
///   共用装配/推送逻辑，避免凭据或入站顺序出现第二套实现；
/// * 只有 `version_before > 0`（此前确实下发过配置）且用户不在新配置里时才写事件。
async fn apply_server(
    state: &AppState,
    server: &Server,
    candidates: HashMap<String, RemovalCandidate>,
) -> anyhow::Result<()> {
    let version_before = server.config_version;
    let snapshot = repo::desired::get(&state.db.pool, &server.id).await?;

    let desired = desired::render(state, server).await?;
    let fingerprint = desired::fingerprint(&desired.xray);
    if let Some(snapshot) = &snapshot {
        if snapshot.fingerprint == fingerprint && snapshot.config_version == version_before {
            tracing::info!(
                server = %server.name,
                config_version = version_before,
                "期望态没有变化，跳过断流 apply"
            );
            return Ok(());
        }
    }

    // 新配置里仍然有资格的用户：他们不该收到移除事件。
    let granted: HashSet<String> = desired.granted_user_ids.iter().cloned().collect();
    let outcome = desired::publish(state, server, desired).await?;

    let mut removed = 0usize;
    if version_before > 0 {
        for candidate in candidates.values() {
            if granted.contains(&candidate.user_id) {
                continue;
            }
            // 对账候选在第一次没有历史快照时可能只是「早就不可用」的存量，
            // 不能凭空写一条「刚刚移除」；实时跨边界的候选则一定可信。
            if !candidate.confident && snapshot.is_none() {
                continue;
            }
            let message =
                rules::removal_message(&candidate.username, &candidate.reason, &server.name);
            if let Err(error) = repo::enforcement::insert_event(
                &state.db.pool,
                repo::enforcement::NewEvent {
                    user_id: &candidate.user_id,
                    username: &candidate.username,
                    server_id: &server.id,
                    server_name: &server.name,
                    reason: &candidate.reason,
                    message: &message,
                },
            )
            .await
            {
                tracing::error!(error = %error, user = %candidate.username, "写断流事件失败");
                continue;
            }
            removed += 1;
            tracing::info!(
                user = %candidate.username,
                user_id = %candidate.user_id,
                server = %server.name,
                reason = %candidate.reason,
                "{message}"
            );
        }
    }

    tracing::info!(
        server = %server.name,
        version = outcome.version,
        version_before,
        delivered = outcome.delivered,
        removed,
        "断流 apply 完成"
    );
    Ok(())
}
