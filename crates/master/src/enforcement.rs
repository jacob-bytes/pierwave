//! 断流（enforcement）：把「记账」变成「处置」，并保证处置是可逆的。
//!
//! 链路：
//! 1. 流量上报落库时，如果某张实例从「可用」跨到「不可用」，就调用
//!    [`mark_removal_candidates`] 把这些用户所在服务器的期望态标记为脏；
//! 2. [`spawn_worker`] 是一个去抖 worker：同一台服务器在一个窗口内只 apply 一次，
//!    窗口内继续到来的标记会合并，避免流量风暴触发几十次 apply；
//! 3. apply 复用 `routes::desired::render` + `publish`（和手动 apply / 重连补发同一条路径），
//!    并在 push 成功后 bump `config_version`、写 `desired_snapshots`；
//! 4. 只有真正从配置里消失/回到配置里的用户才写 `enforcement_events`；
//! 5. `PIERWAVE_ENFORCE=0` 时以上全部跳过（默认开启），方便排障。
//!
//! 双向对账：`reconcile_once` 每 5 分钟比较「当前 eligible 用户集合」与
//! `desired_snapshots.granted_users`（上一次真正下发的内容）：
//! * 快照里有、现在不 eligible → 移除；
//! * 现在 eligible、快照里没有 → 恢复（额度重置、管理员加额度、重新绑卡）。
//!
//! 判定复用 `authorization::eligible_pairs`，与真正渲染时同一套逻辑。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pierwave_domain::models::Server;
use pierwave_domain::{enforcement as rules, repo, time};
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::routes::desired;
use crate::state::AppState;

/// 去抖窗口：同一台服务器在 30s 内最多 apply 一次。
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_secs(30);

/// 环境变量：`0/false/no/off` 关闭断流（含恢复）；其它值（含未设置）视为开启。
const ENFORCE_ENV: &str = "PIERWAVE_ENFORCE";

/// 一条待处理的用户变化：用户因为什么、是否来自可信的实时跨边界。
///
/// 「移除还是恢复」不在这里写死：apply 时用旧快照的用户集合与当前渲染结果做
/// 精确差集，差集方向才是最终事实。这里只携带用户名/原因，供写事件时复用。
#[derive(Debug, Clone)]
pub struct RemovalCandidate {
    pub user_id: String,
    pub username: String,
    /// 逗号分隔的原因码，见 [`pierwave_domain::enforcement`]。
    pub reason: String,
    /// `true` = 流量上报/对账当场发现；`false` = 旧快照兜底扫描出的不可用用户。
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

    /// 默认 30s 窗口，是否启用从 `PIERWAVE_ENFORCE` 读取。
    pub fn from_env() -> Self {
        Self::new(env_enabled(), DEFAULT_DEBOUNCE)
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// 标记某台服务器的期望态为脏。窗口内重复标记会合并成同一批。
    pub fn mark_dirty(&self, server_id: &str, candidates: Vec<RemovalCandidate>) {
        self.mark(server_id, candidates, false);
    }

    /// 标记某台服务器的期望态为脏，但不携带候选用户。
    ///
    /// 用于「用户状态明确变了，但方向交给 apply 时按快照差集判断」的触发点
    /// （每日重置、绑卡、改额度）；apply 会自己加载用户名并计算移除原因。
    pub fn mark_server_dirty(&self, server_id: &str) {
        self.mark(server_id, Vec::new(), true);
    }

    fn mark(&self, server_id: &str, candidates: Vec<RemovalCandidate>, force: bool) {
        if !self.enabled || (candidates.is_empty() && !force) {
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

/// 启动去抖 worker；`PIERWAVE_ENFORCE=0` 时直接退出。
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

/// 流量上报跨过边界后，标记所有「可能包含该用户 client」的服务器。
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

/// 每日重置清零后：标记所有有启用节点的服务器。
///
/// 不判断某个用户应该恢复还是移除；apply 会用快照差集自己算。
/// 这样所有「用户状态变了」的触发点共用同一个入口。
pub async fn mark_all_servers_dirty(state: &AppState) -> anyhow::Result<usize> {
    if !state.enforcement.enabled() {
        return Ok(0);
    }
    let server_ids = repo::servers::list_ids_with_enabled_nodes(&state.db.pool).await?;
    for server_id in &server_ids {
        state.enforcement.mark_server_dirty(server_id);
    }
    if !server_ids.is_empty() {
        tracing::info!(
            servers = server_ids.len(),
            "状态变更：标记所有有启用节点的服务器期望态为脏"
        );
    }
    Ok(server_ids.len())
}

/// 用户绑卡 / 改额度 / 改到期 / 改状态后：标记该用户可能出现的服务器。
///
/// 资格是全局的：用户 eligible 时会被注入所有有启用节点的服务器，
/// 所以这里同样标记这些服务器；具体移除还是恢复由 apply 的快照差集决定。
pub async fn mark_user_servers_dirty(state: &AppState, user_id: &str) -> anyhow::Result<usize> {
    if !state.enforcement.enabled() {
        return Ok(0);
    }
    let server_ids = repo::servers::list_ids_with_enabled_nodes(&state.db.pool).await?;
    for server_id in &server_ids {
        state.enforcement.mark_server_dirty(server_id);
    }
    if !server_ids.is_empty() {
        tracing::info!(
            user_id,
            servers = server_ids.len(),
            "用户套餐变更：标记服务器期望态为脏"
        );
    }
    Ok(server_ids.len())
}

/// 5 分钟双向对账：移除「该走但还在」的，恢复「该回但不在」的。
///
/// 基准是 `desired_snapshots.granted_users`（上一次真正下发的内容），不是当前库状态；
/// 判定当前资格复用 [`repo::authorization::eligible_pairs`]，与 apply 渲染完全同口径。
///
/// 返回本轮「关注到」的用户数（不可用用户 + 需要恢复的用户），仅用于日志/测试；
/// 真正是否 apply 由去抖 worker 再比对 fingerprint 决定。
pub async fn reconcile_once(state: &AppState) -> anyhow::Result<usize> {
    if !state.enforcement.enabled() {
        return Ok(0);
    }
    let server_ids = repo::servers::list_ids_with_enabled_nodes(&state.db.pool).await?;
    if server_ids.is_empty() {
        return Ok(0);
    }

    // 不可用用户的全集：给「移除」候选提供原因与用户名，也用于旧快照兜底。
    let unusable = repo::enforcement::list_unusable_users(&state.db.pool, time::now()).await?;
    let unusable_by_user: HashMap<String, repo::enforcement::UnusableUser> = unusable
        .iter()
        .cloned()
        .map(|user| (user.user_id.clone(), user))
        .collect();

    // 返回值语义与旧版保持一致：不可用用户即使已经不在快照里也计数，
    // 这样「对账还在跑」这件事对日志/测试仍然可见。
    let mut touched: HashSet<String> = unusable_by_user.keys().cloned().collect();
    let mut legacy_servers = Vec::new();
    let mut dirty_servers = 0usize;

    for server_id in &server_ids {
        let Some(snapshot) = repo::desired::get(&state.db.pool, server_id).await? else {
            legacy_servers.push(server_id.clone());
            continue;
        };
        let previous: HashSet<String> = match snapshot.granted_user_ids() {
            Some(ids) => ids.into_iter().collect(),
            // 0005 之前的旧快照没有用户集合：若当前渲染与它指纹一致，可以安全回填；
            // 否则无法判断已下发内容，退回旧口径（只做移除，不做恢复）。
            None => match backfill_legacy_snapshot(state, server_id, &snapshot).await? {
                Some(ids) => ids.into_iter().collect(),
                None => {
                    legacy_servers.push(server_id.clone());
                    continue;
                }
            },
        };

        let eligible = eligible_user_ids(state, server_id).await?;
        let mut candidates: Vec<RemovalCandidate> = Vec::new();

        // 快照里有、现在不 eligible：应该移除。
        for user_id in previous.difference(&eligible) {
            touched.insert(user_id.clone());
            candidates.push(removed_candidate(state, &unusable_by_user, user_id).await?);
        }
        // 现在 eligible、快照里没有：应该恢复。
        for user_id in eligible.difference(&previous) {
            touched.insert(user_id.clone());
            candidates.push(RemovalCandidate {
                user_id: user_id.clone(),
                username: display_name(state, user_id).await?,
                reason: rules::REASON_RECOVERED.to_string(),
                confident: true,
            });
        }

        if !candidates.is_empty() {
            dirty_servers += 1;
            tracing::info!(
                server_id,
                changes = candidates.len(),
                "双向对账：标记服务器期望态为脏（移除/恢复）"
            );
            state.enforcement.mark_dirty(server_id, candidates);
        }
    }

    // 旧快照兜底：至少保住原来的移除能力；恢复检测要等快照被回填/下一次 apply 后生效。
    if !legacy_servers.is_empty() && !unusable_by_user.is_empty() {
        let candidates: Vec<RemovalCandidate> = unusable_by_user
            .values()
            .map(|user| RemovalCandidate {
                user_id: user.user_id.clone(),
                username: user.username.clone(),
                reason: user.reason.clone(),
                confident: false,
            })
            .collect();
        for server_id in &legacy_servers {
            dirty_servers += 1;
            state.enforcement.mark_dirty(server_id, candidates.clone());
        }
    }

    let users = touched.len();
    if users > 0 {
        tracing::info!(
            users,
            servers = server_ids.len(),
            dirty_servers,
            "双向对账完成"
        );
    }
    Ok(users)
}

/// 旧快照回填：只有「当前渲染 == 上次下发」时才能确定已下发用户集合。
///
/// 指纹一致说明配置自上次 apply 后没变，此时当前 eligible 用户集合就是已下发集合；
/// 指纹不一致（例如管理员改了节点还没 apply）就不能猜，返回 `None` 交给旧口径兜底。
async fn backfill_legacy_snapshot(
    state: &AppState,
    server_id: &str,
    snapshot: &repo::desired::Snapshot,
) -> anyhow::Result<Option<Vec<String>>> {
    let Ok(server) = repo::servers::find_by_id(&state.db.pool, server_id).await else {
        return Ok(None);
    };
    // 单台服务器被阻断（例如 nic_name 指向的网卡没有可用地址）不能让整轮
    // 对账失败；跳过它的旧快照回填，其它服务器照常处理。
    let desired = match desired::render(state, &server, &desired::default_base_url()).await {
        Ok(desired) => desired,
        // 网卡阻断是单台服务器的状态，不应让整轮对账失败；其它错误保持原样上报。
        Err(error)
            if matches!(
                &error,
                crate::error::AppError::Coded { code, .. }
                    if *code == "server.nic_address_unavailable"
            ) =>
        {
            tracing::warn!(
                server = %server.name,
                error = %error,
                "网卡不可用，跳过旧快照回填"
            );
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    if snapshot.config_version != server.config_version
        || snapshot.fingerprint != desired::fingerprint(&desired.xray)
    {
        return Ok(None);
    }
    repo::desired::save(
        &state.db.pool,
        server_id,
        &snapshot.fingerprint,
        snapshot.config_version,
        &desired.granted_user_ids,
        time::now(),
    )
    .await?;
    tracing::info!(
        server = %server.name,
        config_version = snapshot.config_version,
        users = desired.granted_user_ids.len(),
        "回填旧快照的已下发用户集合"
    );
    Ok(Some(desired.granted_user_ids))
}

/// 当前资格用户集合，与 `desired::render` 注入 client 用的是同一个查询。
async fn eligible_user_ids(state: &AppState, server_id: &str) -> anyhow::Result<HashSet<String>> {
    Ok(
        repo::authorization::eligible_pairs(&state.db.pool, server_id)
            .await?
            .into_iter()
            .map(|pair| pair.user_id)
            .collect(),
    )
}

/// 为「快照里有但已不 eligible」的用户构造候选：优先用不可用扫描的原因，
/// 否则按用户状态兜底（被禁用 / 删号 / 解绑全部套餐）。
async fn removed_candidate(
    state: &AppState,
    unusable: &HashMap<String, repo::enforcement::UnusableUser>,
    user_id: &str,
) -> anyhow::Result<RemovalCandidate> {
    if let Some(user) = unusable.get(user_id) {
        return Ok(RemovalCandidate {
            user_id: user_id.to_string(),
            username: user.username.clone(),
            reason: user.reason.clone(),
            confident: false,
        });
    }
    let (username, reason) = match repo::users::find_by_id_opt(&state.db.pool, user_id).await? {
        Some(user) if user.status == "active" => {
            (user.username, rules::REASON_INACTIVE.to_string())
        }
        Some(user) => (user.username, rules::REASON_DISABLED.to_string()),
        None => (user_id.to_string(), rules::REASON_INACTIVE.to_string()),
    };
    Ok(RemovalCandidate {
        user_id: user_id.to_string(),
        username,
        reason,
        confident: false,
    })
}

/// 没有候选元数据时（例如改额度/重置触发）的移除事件信息：
/// 按用户状态与实例状态现算，避免把「额度用尽」写成笼统的「不可用」。
async fn resolve_removal(state: &AppState, user_id: &str) -> anyhow::Result<(String, String)> {
    let Some(user) = repo::users::find_by_id_opt(&state.db.pool, user_id).await? else {
        return Ok((user_id.to_string(), rules::REASON_INACTIVE.to_string()));
    };
    if user.status != "active" {
        return Ok((user.username, rules::REASON_DISABLED.to_string()));
    }

    let now = time::now();
    let views = repo::user_packages::list_views_by_user(&state.db.pool, &user.id).await?;
    let mut reasons: Vec<&'static str> = Vec::new();
    for view in &views {
        let status = view.status_at(now);
        if status != "active" && !reasons.contains(&status) {
            reasons.push(status);
        }
    }
    let reason = if reasons.is_empty() {
        rules::REASON_INACTIVE.to_string()
    } else {
        rules::merge_reasons(reasons)
    };
    Ok((user.username, reason))
}

async fn display_name(state: &AppState, user_id: &str) -> anyhow::Result<String> {
    Ok(repo::users::find_by_id_opt(&state.db.pool, user_id)
        .await?
        .map(|user| user.username)
        .unwrap_or_else(|| user_id.to_string()))
}

/// 原因清洗：恢复方向的原因不应出现在移除事件里。
fn removal_reason(reason: &str) -> String {
    let codes: Vec<&str> = reason
        .split(',')
        .map(str::trim)
        .filter(|code| !code.is_empty() && *code != rules::REASON_RECOVERED)
        .collect();
    let merged = rules::merge_reasons(codes);
    if merged.is_empty() {
        rules::REASON_INACTIVE.to_string()
    } else {
        merged
    }
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
/// * **事件按真实差集写**：用 apply 前快照里的用户集合与本次渲染结果比较，
///   快照有→本次无写 `removed`，快照无→本次有写 `restored`；
/// * 没有已下发用户集合的旧快照走候选兜底，只写 `removed`，避免误判恢复。
async fn apply_server(
    state: &AppState,
    server: &Server,
    candidates: HashMap<String, RemovalCandidate>,
) -> anyhow::Result<()> {
    let version_before = server.config_version;
    let snapshot = repo::desired::get(&state.db.pool, &server.id).await?;

    let desired = desired::render(state, server, &desired::default_base_url()).await?;
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

    // apply 前的已下发集合：事件差集的基准。
    let previous: Option<HashSet<String>> = snapshot
        .as_ref()
        .and_then(repo::desired::Snapshot::granted_user_ids)
        .map(|ids| ids.into_iter().collect());
    // 本次配置里有资格的用户。
    let current: HashSet<String> = desired.granted_user_ids.iter().cloned().collect();

    let outcome = desired::publish(state, server, desired).await?;

    let mut removed = 0usize;
    let mut restored = 0usize;
    if version_before > 0 {
        match previous {
            Some(previous) => {
                // 快照有、本次没有 → 移除。
                for user_id in previous.difference(&current) {
                    let (username, reason) = match candidates.get(user_id) {
                        Some(candidate) => (
                            candidate.username.clone(),
                            removal_reason(&candidate.reason),
                        ),
                        None => resolve_removal(state, user_id).await?,
                    };
                    let message = rules::removal_message(&username, &reason, &server.name);
                    if let Err(error) = write_event(
                        state, "removed", server, user_id, &username, &reason, &message,
                    )
                    .await
                    {
                        tracing::error!(error = %error, user = %username, "写断流事件失败");
                    }
                    notify_removed(state, server, user_id, &username, &reason).await;
                    removed += 1;
                }
                // 快照没有、本次有 → 恢复。
                for user_id in current.difference(&previous) {
                    let username = match candidates.get(user_id) {
                        Some(candidate) => candidate.username.clone(),
                        None => display_name(state, user_id).await?,
                    };
                    let message = rules::restore_message(&username, &server.name);
                    if let Err(error) = write_event(
                        state,
                        "restored",
                        server,
                        user_id,
                        &username,
                        rules::REASON_RECOVERED,
                        &message,
                    )
                    .await
                    {
                        tracing::error!(error = %error, user = %username, "写恢复事件失败");
                    }
                    restored += 1;
                }
            }
            None => {
                // 旧快照：无法判断「之前到底有没有」，只按候选保守写移除。
                for candidate in candidates.values() {
                    if current.contains(&candidate.user_id) {
                        continue;
                    }
                    if !candidate.confident && snapshot.is_none() {
                        continue;
                    }
                    let reason = removal_reason(&candidate.reason);
                    let message =
                        rules::removal_message(&candidate.username, &reason, &server.name);
                    if let Err(error) = write_event(
                        state,
                        "removed",
                        server,
                        &candidate.user_id,
                        &candidate.username,
                        &reason,
                        &message,
                    )
                    .await
                    {
                        tracing::error!(error = %error, user = %candidate.username, "写断流事件失败");
                    }
                    notify_removed(
                        state,
                        server,
                        &candidate.user_id,
                        &candidate.username,
                        &reason,
                    )
                    .await;
                    removed += 1;
                }
            }
        }
    }

    tracing::info!(
        server = %server.name,
        version = outcome.version,
        version_before,
        delivered = outcome.delivered,
        removed,
        restored,
        "断流 apply 完成"
    );
    Ok(())
}

/// 用户因额度/到期/禁用被移出配置时发一条告警；失败不影响断流主流程。
async fn notify_removed(
    state: &AppState,
    server: &Server,
    user_id: &str,
    username: &str,
    reason: &str,
) {
    crate::alerts::notify(
        state,
        crate::alerts::AlertKind::UserExhausted,
        user_id,
        "用户断流 / User enforcement",
        &format!(
            "用户 {username} 已从服务器 {} 的配置中移除（{reason}）/ User {username} was removed from {} ({reason})",
            server.name, server.name
        ),
    )
    .await;
}

async fn write_event(
    state: &AppState,
    kind: &str,
    server: &Server,
    user_id: &str,
    username: &str,
    reason: &str,
    message: &str,
) -> anyhow::Result<()> {
    repo::enforcement::insert_event(
        &state.db.pool,
        repo::enforcement::NewEvent {
            kind,
            user_id,
            username,
            server_id: &server.id,
            server_name: &server.name,
            reason,
            message,
        },
    )
    .await?;
    tracing::info!(
        kind,
        user = %username,
        user_id,
        server = %server.name,
        reason,
        "{message}"
    );
    Ok(())
}
