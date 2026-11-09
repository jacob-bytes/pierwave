use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use tokio::sync::broadcast;

use pierwave_domain::enforcement as enforcement_rules;
use pierwave_domain::metering;
use pierwave_domain::models::{package_status_at, UserPackageView};
use pierwave_domain::repo;
use pierwave_domain::time;
use pierwave_proto::{
    AgentMessage, DesiredState, MasterMessage, ServerAck, TrafficReport, PROTOCOL_VERSION,
};

use crate::enforcement::RemovalCandidate;
use crate::state::AppState;

pub async fn ws(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    let base = super::install::external_base(&headers);
    ws.on_upgrade(move |socket| handle(socket, state, base))
}

/// Agent 反向连入：第一条消息必须是 Hello(token)。
/// token 校验通过后下发 Ack；之后 socket 与广播通道并行处理：
/// 一边收心跳/上报，一边把主控 apply 产生的期望态推下去。
async fn handle(mut socket: WebSocket, state: AppState, base_url: String) {
    let Some(Ok(Message::Text(first))) = socket.recv().await else {
        return;
    };
    let Ok(AgentMessage::Hello(hello)) = serde_json::from_str(&first) else {
        let err = MasterMessage::Error {
            message: "expected hello".into(),
        };
        if let Ok(payload) = serde_json::to_string(&err) {
            let _ = socket.send(Message::Text(payload.into())).await;
        }
        return;
    };

    // 心跳会带上 agent 版本一起落库，后续重连以最新 hello 为准。
    let agent_version = hello.agent_version.clone();
    let mut server = match repo::servers::find_by_token(&state.db.pool, &hello.token).await {
        Ok(Some(server)) => server,
        _ => {
            tracing::warn!(hostname = %hello.hostname, "agent auth failed");
            let err = MasterMessage::Error {
                message: "invalid token".into(),
            };
            if let Ok(payload) = serde_json::to_string(&err) {
                let _ = socket.send(Message::Text(payload.into())).await;
            }
            return;
        }
    };

    // 握手带的版本比库里的新（Agent 刚重启升级过）：先用于本次补发的比较，
    // 心跳落库后两端就一致了。
    if !agent_version.trim().is_empty() {
        server.agent_version = Some(agent_version.clone());
    }

    // 先注册再发 Ack：避免 Ack 与进入循环之间漏掉 apply 广播。
    // subscription 在 Drop 时自动注销。
    let mut subscription = state.hub.subscribe(&server.id);

    if let Err(e) = repo::servers::mark_online(&state.db.pool, &server.id).await {
        tracing::error!(error = %e, "mark_online failed");
    }
    tracing::info!(
        server = %server.name,
        hostname = %hello.hostname,
        agent_version = %hello.agent_version,
        "agent connected"
    );

    let ack = MasterMessage::Ack(ServerAck {
        server_id: server.id.clone(),
        protocol_version: PROTOCOL_VERSION,
        config_version: server.config_version,
        heartbeat_secs: 15,
    });
    if !send_json(&mut socket, &ack).await {
        return;
    }

    // 重连补发：Agent 按版本号幂等，只有比本地已应用版本新才会真正重启 xray。
    // 配置装配与 apply 共用 routes::desired，保证补发的 client 凭据和上次下发的完全一致。
    if server.config_version > 0 {
        match super::desired::render(&state, &server, &base_url).await {
            Ok(rendered) => {
                let desired = MasterMessage::Desired(DesiredState {
                    version: server.config_version,
                    xray: rendered.xray,
                    files: rendered.files,
                    agent_upgrade: rendered.agent_upgrade,
                    forwards: rendered.forwards,
                    nodes: rendered.nodes,
                });
                if !send_json(&mut socket, &desired).await {
                    return;
                }
                tracing::info!(
                    server = %server.name,
                    version = server.config_version,
                    "resynced desired state on connect"
                );
            }
            Err(e) => tracing::error!(error = %e, "load nodes for resync failed"),
        }
    }

    let mut hub_open = true;
    loop {
        tokio::select! {
            frame = socket.recv() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        handle_agent_message(&state, &server.id, &agent_version, &text).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        tracing::warn!(error = %e, "agent socket error");
                        break;
                    }
                }
            }
            message = subscription.receiver.recv(), if hub_open => {
                match message {
                    Ok(message) => {
                        if !send_json(&mut socket, &message).await {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(
                            server = %server.name,
                            skipped,
                            "desired state broadcast lagged"
                        );
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        // 同一服务器被新连接替换时旧通道会关闭；此时继续读上报即可。
                        hub_open = false;
                        tracing::warn!(server = %server.name, "agent hub channel closed");
                    }
                }
            }
        }
    }
    drop(subscription);

    if let Err(e) = repo::servers::mark_offline(&state.db.pool, &server.id).await {
        tracing::error!(error = %e, "mark_offline failed");
    }
    tracing::info!(server = %server.name, "agent disconnected");
    // 告警是旁路：notify 内部吞掉所有错误，且投递在独立任务里，不会影响断开流程。
    crate::alerts::notify(
        &state,
        crate::alerts::AlertKind::ServerOffline,
        &server.id,
        "服务器离线 / Server offline",
        &format!(
            "服务器 {} 的 Agent 连接已断开 / Agent connection for {} was closed",
            server.name, server.name
        ),
    )
    .await;
}

async fn send_json(socket: &mut WebSocket, message: &MasterMessage) -> bool {
    match serde_json::to_string(message) {
        Ok(payload) => socket.send(Message::Text(payload.into())).await.is_ok(),
        Err(e) => {
            tracing::error!(error = %e, "serialize master message failed");
            false
        }
    }
}

async fn handle_agent_message(state: &AppState, server_id: &str, agent_version: &str, text: &str) {
    match serde_json::from_str::<AgentMessage>(text) {
        Ok(AgentMessage::Heartbeat(hb)) => {
            let health = repo::servers::HealthSnapshot {
                arch: hb.arch,
                os_name: hb.os_name,
                os_version: hb.os_version,
                virt: hb.virt,
                xray_running: hb.xray_running,
                nginx_running: hb.nginx_running,
                load1: hb.load1 as f64,
                mem_used: hb.mem_used as i64,
                mem_total: hb.mem_total as i64,
                disk_used: hb.disk_used as i64,
                disk_total: hb.disk_total as i64,
                uptime_secs: hb.uptime_secs as i64,
                latency_ms: hb.latency_ms.map(i64::from),
            };
            // 心跳自带的版本优先：Agent 升级重启后，第一个心跳就能把新版本带上来，
            // 不用等下次重连才更新 UI。
            let version = if hb.agent_version.is_empty() {
                agent_version
            } else {
                hb.agent_version.as_str()
            };
            if let Err(e) =
                repo::servers::update_health(&state.db.pool, server_id, version, &health).await
            {
                tracing::error!(error = %e, "heartbeat write failed");
            }
            // 转发运行状态是观测值：每轮心跳整体覆盖该服务器的缓存。
            // 规则本身在 forwards 表里，这里只负责「上一轮说在监听，这一轮是否还在」。
            let forward_status: Vec<repo::forwards::NewForwardStatus> = hb
                .forwards
                .iter()
                .map(|status| repo::forwards::NewForwardStatus {
                    forward_id: status.id.clone(),
                    listening: status.listening,
                    error: status.error.clone(),
                    target_ok: status.target_ok,
                })
                .collect();
            // 链降级是「状态跃迁」事件：save 前后各算一次，只在 false → true 时通知。
            // 读失败只 warn，不影响心跳落库。
            let chains_before = match super::chains::degradation_for_server(state, server_id).await
            {
                Ok(map) => map,
                Err(error) => {
                    tracing::warn!(error = %error, "读取链降级状态失败（心跳前）");
                    Default::default()
                }
            };
            let status_saved =
                match repo::forwards::save_status(&state.db.pool, server_id, &forward_status).await
                {
                    Ok(()) => true,
                    Err(e) => {
                        tracing::error!(error = %e, "forward status write failed");
                        false
                    }
                };
            if status_saved {
                match super::chains::degradation_for_server(state, server_id).await {
                    Ok(chains_after) => {
                        for (chain_id, (chain_name, degraded)) in chains_after {
                            if !degraded {
                                continue;
                            }
                            let was_degraded = chains_before
                                .get(&chain_id)
                                .is_some_and(|(_, before)| *before);
                            if was_degraded {
                                continue;
                            }
                            crate::alerts::notify(
                                state,
                                crate::alerts::AlertKind::ChainDegraded,
                                &chain_id,
                                "转发链降级 / Relay chain degraded",
                                &format!(
                                    "链 {chain_name} 连续 2 次探测目标不可达，已标记降级 / Chain {chain_name} is degraded after 2 consecutive failed probes"
                                ),
                            )
                            .await;
                        }
                    }
                    Err(error) => {
                        tracing::warn!(error = %error, "读取链降级状态失败（心跳后）")
                    }
                }
            }
            settle_agent_upgrade(state, server_id, version, time::now()).await;
            tracing::debug!(seq = hb.seq, xray = hb.xray_running, "heartbeat");
        }
        Ok(AgentMessage::ApplyResult(result)) => {
            if result.ok {
                tracing::info!(version = result.version, "agent applied desired state");
            } else {
                tracing::error!(
                    version = result.version,
                    error = result.error.unwrap_or_default(),
                    "agent failed to apply"
                );
            }
        }
        Ok(AgentMessage::Traffic(report)) => {
            tracing::debug!(
                server_id,
                seq = report.seq,
                deltas = report.deltas.len(),
                "收到流量上报"
            );
            if let Err(e) = record_traffic(state, server_id, &report).await {
                tracing::error!(error = %e, "traffic report failed");
            }
        }
        Ok(AgentMessage::Hello(_)) => {}
        Err(e) => tracing::warn!(error = %e, "unparsable agent message"),
    }
}

/// 心跳确认升级完成：`agent_version == agent_target_version` 且有 pending 记录时，
/// 把 pending 翻成 succeeded 并清空目标版本。
///
/// 只由在线 Agent 的心跳触发。超时不算失败（本轮不做自动失败），前端看到
/// 长期 pending 自行判断；Agent 重启后仍会带上新版本，下一次心跳即可翻转。
/// 升级后需要稳定观察的秒数。心跳默认 60 秒一次，正好等于「至少再收到一次心跳」。
const UPGRADE_STABLE_SECS: i64 = 60;
async fn settle_agent_upgrade(state: &AppState, server_id: &str, version: &str, now: i64) {
    let version = version.trim();
    if version.is_empty() {
        return;
    }
    let server = match repo::servers::find_by_id(&state.db.pool, server_id).await {
        Ok(server) => server,
        Err(e) => {
            tracing::warn!(server_id, error = %e, "读取服务器状态失败，跳过升级确认");
            return;
        }
    };
    let Some(target) = server.agent_target_version.as_deref() else {
        return;
    };
    // 版本号可能带 `v` 前缀（Release tag 风格）；Agent 心跳上报的是
    // `CARGO_PKG_VERSION`，没有前缀。比较时统一忽略前导 `v`。
    if target.trim().trim_start_matches('v') != version.trim_start_matches('v') {
        return;
    }

    let pending = match repo::agent_upgrades::find_pending(&state.db.pool, server_id).await {
        Ok(pending) => pending,
        Err(e) => {
            tracing::error!(server_id, error = %e, "读取升级记录失败");
            return;
        }
    };
    let Some(upgrade) = pending else {
        return;
    };

    // 稳定窗口：第一次看到新版本只是「起来了」，还要再撑过一个窗口才算成功。
    // 否则一个能连上、但几秒后就崩的坏版本会被立刻判成功，随后失联且无人回滚。
    let Some(confirmed_at) = upgrade.confirmed_at else {
        if let Err(e) = repo::agent_upgrades::mark_confirmed(&state.db.pool, &upgrade.id, now).await
        {
            tracing::error!(server_id, upgrade = %upgrade.id, error = %e, "记录升级确认时间失败");
        }
        tracing::info!(
            server_id,
            to = %upgrade.to_version,
            "Agent 已上报新版本，进入稳定窗口观察"
        );
        return;
    };
    if now - confirmed_at < UPGRADE_STABLE_SECS {
        tracing::debug!(
            server_id,
            remaining = UPGRADE_STABLE_SECS - (now - confirmed_at),
            "稳定窗口未满"
        );
        return;
    }

    if let Err(e) = repo::agent_upgrades::mark(&state.db.pool, &upgrade.id, "succeeded", "").await {
        tracing::error!(server_id, upgrade = %upgrade.id, error = %e, "标记升级成功失败");
        return;
    }
    if let Err(e) = repo::servers::set_agent_target_version(&state.db.pool, server_id, None).await {
        tracing::error!(server_id, error = %e, "清空 Agent 目标版本失败");
        return;
    }
    tracing::info!(
        server_id,
        from = %upgrade.from_version,
        to = %upgrade.to_version,
        "Agent 自升级完成（心跳已带新版本）"
    );
}

/// 流量上报落库：归因 → 加权 → 日账本 / 用户总量 / 实例瀑布分配。
///
/// 幂等键是 `(server_id, boot_id, seq)`：重复上报在这里直接丢弃，绝不二次累加。
async fn record_traffic(
    state: &AppState,
    server_id: &str,
    report: &TrafficReport,
) -> anyhow::Result<()> {
    let received_at = time::now();
    let claimed = repo::traffic::claim_report(
        &state.db.pool,
        server_id,
        &report.boot_id,
        report.seq,
        received_at,
    )
    .await?;
    if !claimed {
        tracing::debug!(
            server_id,
            boot_id = %report.boot_id,
            seq = report.seq,
            "重复的流量上报，已丢弃"
        );
        return Ok(());
    }

    let day = time::business_date(received_at);
    let mut removals = Vec::new();
    for delta in &report.deltas {
        if let Some(candidate) = record_delta(
            state,
            server_id,
            &day,
            &delta.email,
            delta.uplink,
            delta.downlink,
        )
        .await?
        {
            removals.push(candidate);
        }
    }
    // 整份报告处理完再统一标记：同一用户的多条 delta 只触发一次去抖。
    if !removals.is_empty() {
        crate::enforcement::mark_removal_candidates(state, removals).await?;
    }
    Ok(())
}

/// 处理单个 email 的增量。
///
/// 归因失败（切不出用户 / 用户不存在）只 warn 并用原始 email 记账，不中断整份报告；
/// 这样一台服务器上的脏数据不会让别人也漏计。
async fn record_delta(
    state: &AppState,
    server_id: &str,
    day: &str,
    email: &str,
    uplink: u64,
    downlink: u64,
) -> anyhow::Result<Option<RemovalCandidate>> {
    // 按最后一个 `@` 切分：用户 ID 是 UUID（无 @），node_tag 里可能有 @。
    // 归因失败也要保留能拿到的 node_tag：节点总量不能因为用户脏数据而丢。
    let (user, node_tag) = match email.rsplit_once('@') {
        Some((user_id, node_tag)) => {
            let user = if user_id.is_empty() || node_tag.is_empty() {
                None
            } else {
                repo::users::find_by_id_opt(&state.db.pool, user_id).await?
            };
            (user, node_tag)
        }
        None => (None, ""),
    };

    let Some(user) = user else {
        tracing::warn!(email, "流量上报无法归因到用户，按原始 email 记账");
        let weighted = metering::weighted_bytes(uplink, downlink, "both", 1.0);
        repo::traffic::accumulate_daily(
            &state.db.pool,
            day,
            server_id,
            email,
            uplink,
            downlink,
            weighted,
        )
        .await?;
        // 节点维度单独留一行：`user_id = ''` 表示无法归因，仍计入节点总量。
        repo::traffic::accumulate_node_daily(
            &state.db.pool,
            day,
            server_id,
            repo::traffic::NodeTrafficDelta {
                node_tag,
                user_id: "",
                uplink,
                downlink,
                weighted,
            },
        )
        .await?;
        return Ok(None);
    };

    // 断流开启时才额外读一次视图：需要「扣费前」的可用状态来识别跨边界。
    let before_views = if state.enforcement.enabled() {
        Some(repo::user_packages::list_views_by_user(&state.db.pool, &user.id).await?)
    } else {
        None
    };

    let instances = repo::user_packages::list_billable(&state.db.pool, &user.id).await?;
    let (direction, node_ratio) = metering::billing_terms(&instances);
    if instances.is_empty() {
        tracing::warn!(
            user = %user.id,
            email,
            "用户没有可用的套餐实例，按 1 倍双向计费且不分配到实例"
        );
    }
    let weighted = metering::weighted_bytes(uplink, downlink, direction, node_ratio);

    // 日账本的 subject 用 user_id：同一用户跨节点、跨邮件都归到同一行；
    // 归因失败时才回落到原始 email。
    repo::traffic::accumulate_daily(
        &state.db.pool,
        day,
        server_id,
        &user.id,
        uplink,
        downlink,
        weighted,
    )
    .await?;
    // 同一个 weighted 原样写节点切片，不能二次加权。
    repo::traffic::accumulate_node_daily(
        &state.db.pool,
        day,
        server_id,
        repo::traffic::NodeTrafficDelta {
            node_tag,
            user_id: &user.id,
            uplink,
            downlink,
            weighted,
        },
    )
    .await?;
    repo::users::add_used_bytes(&state.db.pool, &user.id, saturating_i64(weighted)).await?;

    // 瀑布分配：多张卡按 created_at 顺序填，先填满第一张再下一张。
    let allocations = metering::waterfall(weighted, &instances);
    for (instance_id, amount) in &allocations {
        repo::user_packages::add_used_bytes(&state.db.pool, instance_id, saturating_i64(*amount))
            .await?;
    }

    // 账户总额度：跨过 users.quota_bytes 这条线时，该用户全站失去资格，
    // 与「某张卡被扣满」走同一套标脏/去抖路径。
    let quota_crossed = enforcement_rules::crosses_total_quota(
        user.used_bytes,
        saturating_i64(weighted),
        user.quota_bytes,
    );

    let Some(views) = before_views else {
        return Ok(None);
    };
    let reason = crossing_reason(&views, &allocations, time::now())
        .or_else(|| quota_crossed.then(|| enforcement_rules::REASON_OVER_TOTAL_QUOTA.to_string()));
    let Some(reason) = reason else {
        return Ok(None);
    };
    tracing::info!(
        user = %user.id,
        username = %user.username,
        reason = %reason,
        "套餐实例从可用跨到不可用，待去抖后从下发配置移除"
    );
    Ok(Some(RemovalCandidate {
        user_id: user.id,
        username: user.username,
        reason,
        confident: true,
    }))
}

/// 本次瀑布分配是否让某张实例从「可用」跨到「不可用」。
///
/// 只比较**这次真的分到字节**的实例：没被扣费的实例不可能因为本次上报跨越边界。
/// `before` 是扣费前的视图（含生效额度与到期时间），`now` 与状态判定共用同一时刻。
fn crossing_reason(
    before: &[UserPackageView],
    allocations: &[(String, u64)],
    now: i64,
) -> Option<String> {
    let mut reasons: Vec<&'static str> = Vec::new();
    for (instance_id, amount) in allocations {
        let Some(view) = before.iter().find(|view| view.id == *instance_id) else {
            continue;
        };
        // 扣费前就不可用的实例，本次上报不会让它「跨过」边界。
        if !view.is_usable_at(now) {
            continue;
        }
        let used_after = view
            .used_bytes
            .saturating_add(i64::try_from(*amount).unwrap_or(i64::MAX));
        let status = package_status_at(
            &view.raw_status,
            view.expires_at,
            view.quota_bytes,
            used_after,
            now,
        );
        if status != "active" && !reasons.contains(&status) {
            reasons.push(status);
        }
    }
    if reasons.is_empty() {
        None
    } else {
        Some(enforcement_rules::merge_reasons(reasons))
    }
}

/// u64 → SQLite 的 i64：正常流量远小于 i64::MAX，超出时饱和而不是回绕成负数。
fn saturating_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use pierwave_domain::models::UserPackageView;
    use pierwave_domain::Db;

    use crate::alerts::{Alerts, RecordingTransport};

    use super::*;
    use pierwave_proto::TrafficDelta;

    struct Fixture {
        state: AppState,
        user_id: String,
    }

    async fn fixture() -> Fixture {
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
        Fixture {
            state: AppState::new(db, "web/dist"),
            user_id: user.id,
        }
    }

    async fn add_package(
        state: &AppState,
        user_id: &str,
        quota_bytes: Option<i64>,
        direction: &str,
        node_ratio: f64,
    ) -> UserPackageView {
        let package = repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: "测试卡".into(),
                quota_bytes,
                period_days: None,
                direction: direction.into(),
                node_ratio,
                rule_template_id: None,

                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        repo::user_packages::create(
            &state.db.pool,
            user_id,
            repo::user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap()
    }

    fn report(seq: u64, email: &str, uplink: u64, downlink: u64) -> TrafficReport {
        TrafficReport {
            seq,
            boot_id: "boot-1".into(),
            deltas: vec![TrafficDelta {
                email: email.into(),
                uplink,
                downlink,
            }],
        }
    }

    fn instance_used(view: &UserPackageView) -> i64 {
        view.used_bytes
    }

    async fn used_bytes(state: &AppState, user_id: &str) -> i64 {
        repo::users::find_by_id(&state.db.pool, user_id)
            .await
            .unwrap()
            .used_bytes
    }

    #[tokio::test]
    async fn records_weighted_daily_and_user_usage() {
        let fixture = fixture().await;
        let package = add_package(&fixture.state, &fixture.user_id, None, "both", 2.0).await;
        let email = format!("{}@hk-1", fixture.user_id);

        record_traffic(&fixture.state, "server-1", &report(1, &email, 1000, 500))
            .await
            .unwrap();

        let user = repo::users::find_by_id(&fixture.state.db.pool, &fixture.user_id)
            .await
            .unwrap();
        assert_eq!(user.used_bytes, 3000, "(1000+500)×2.0");
        assert_eq!(instance_used(&package), 0, "旧视图只是快照");
        let view = repo::user_packages::find_view_by_id(&fixture.state.db.pool, &package.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(view.used_bytes, 3000);

        let day = time::business_date(time::now());
        let daily =
            repo::traffic::find_daily(&fixture.state.db.pool, &day, "server-1", &fixture.user_id)
                .await
                .unwrap()
                .expect("应有日账本");
        assert_eq!(daily.uplink, 1000);
        assert_eq!(daily.downlink, 500);
        assert_eq!(daily.weighted, 3000);

        // 节点维度用同一个 weighted，不能重复加权。
        let node_daily = repo::traffic::find_node_daily(
            &fixture.state.db.pool,
            &day,
            "server-1",
            "hk-1",
            &fixture.user_id,
        )
        .await
        .unwrap()
        .expect("应有节点维度日账本");
        assert_eq!(
            (node_daily.uplink, node_daily.downlink, node_daily.weighted),
            (1000, 500, 3000)
        );
    }

    #[tokio::test]
    async fn duplicate_report_is_dropped() {
        let fixture = fixture().await;
        add_package(&fixture.state, &fixture.user_id, None, "both", 2.0).await;
        let email = format!("{}@hk-1", fixture.user_id);

        record_traffic(&fixture.state, "server-1", &report(1, &email, 1000, 500))
            .await
            .unwrap();
        // 同 seq 重放，即使金额更大也不能翻倍。
        record_traffic(
            &fixture.state,
            "server-1",
            &report(1, &email, 999_999, 999_999),
        )
        .await
        .unwrap();

        assert_eq!(used_bytes(&fixture.state, &fixture.user_id).await, 3000);
        assert_eq!(
            repo::traffic::count_reports(&fixture.state.db.pool, "server-1")
                .await
                .unwrap(),
            1
        );

        // 换 seq 才是真的新增。
        record_traffic(&fixture.state, "server-1", &report(2, &email, 2000, 1000))
            .await
            .unwrap();
        assert_eq!(
            used_bytes(&fixture.state, &fixture.user_id).await,
            9000,
            "第二轮 (2000+1000)×2.0 累加"
        );
        assert_eq!(
            repo::traffic::count_reports(&fixture.state.db.pool, "server-1")
                .await
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn direction_is_respected() {
        let fixture = fixture().await;
        add_package(&fixture.state, &fixture.user_id, None, "upload", 1.0).await;
        let email = format!("{}@hk-1", fixture.user_id);

        record_traffic(&fixture.state, "server-1", &report(1, &email, 1000, 500))
            .await
            .unwrap();

        assert_eq!(
            used_bytes(&fixture.state, &fixture.user_id).await,
            1000,
            "upload 方向只算上行"
        );
        let day = time::business_date(time::now());
        let daily =
            repo::traffic::find_daily(&fixture.state.db.pool, &day, "server-1", &fixture.user_id)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            (daily.uplink, daily.downlink, daily.weighted),
            (1000, 500, 1000)
        );
    }

    #[tokio::test]
    async fn waterfall_fills_first_instance_then_spills_over() {
        let fixture = fixture().await;
        let first = add_package(&fixture.state, &fixture.user_id, Some(1000), "both", 2.0).await;
        let second = add_package(&fixture.state, &fixture.user_id, Some(10_000), "both", 3.0).await;
        let email = format!("{}@hk-1", fixture.user_id);

        // (300+200)×2.0 = 1000 加权 → 第一张刚好填满。
        record_traffic(&fixture.state, "server-1", &report(1, &email, 300, 200))
            .await
            .unwrap();
        let first_after = repo::user_packages::find_view_by_id(&fixture.state.db.pool, &first.id)
            .await
            .unwrap()
            .unwrap();
        let second_after = repo::user_packages::find_view_by_id(&fixture.state.db.pool, &second.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first_after.used_bytes, 1000);
        assert_eq!(second_after.used_bytes, 0);

        // 第二张还有容量 → 换用第二张的 3.0 倍率算权重（500×3=1500），填进第二张。
        record_traffic(&fixture.state, "server-1", &report(2, &email, 500, 0))
            .await
            .unwrap();
        let first_after = repo::user_packages::find_view_by_id(&fixture.state.db.pool, &first.id)
            .await
            .unwrap()
            .unwrap();
        let second_after = repo::user_packages::find_view_by_id(&fixture.state.db.pool, &second.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first_after.used_bytes, 1000, "第一张已满，不再加");
        assert_eq!(second_after.used_bytes, 1500, "第二轮按第二张倍率计费");
        assert_eq!(
            used_bytes(&fixture.state, &fixture.user_id).await,
            2500,
            "1000 + 1500"
        );
    }

    #[tokio::test]
    async fn unattributed_email_is_recorded_under_raw_subject() {
        let fixture = fixture().await;
        let day = time::business_date(time::now());

        // 切不出 user：没有 @。
        record_traffic(
            &fixture.state,
            "server-1",
            &report(1, "not-an-email", 100, 50),
        )
        .await
        .unwrap();
        // 切得出但用户不存在。
        record_traffic(
            &fixture.state,
            "server-1",
            &report(2, "ghost@hk-1", 200, 100),
        )
        .await
        .unwrap();

        let first =
            repo::traffic::find_daily(&fixture.state.db.pool, &day, "server-1", "not-an-email")
                .await
                .unwrap()
                .expect("原始的不可解析 email 也要记账");
        assert_eq!(
            (first.uplink, first.downlink, first.weighted),
            (100, 50, 150)
        );

        let second =
            repo::traffic::find_daily(&fixture.state.db.pool, &day, "server-1", "ghost@hk-1")
                .await
                .unwrap()
                .expect("找不到用户时 subject 用原字符串");
        assert_eq!(
            (second.uplink, second.downlink, second.weighted),
            (200, 100, 300)
        );

        // 归因失败的流量：节点维度也要落库，`user_id = ''` 表示无法归因。
        // 没有 @ 时拿不到 node_tag，写空串；有 @ 时保留后半段。
        let no_tag =
            repo::traffic::find_node_daily(&fixture.state.db.pool, &day, "server-1", "", "")
                .await
                .unwrap()
                .expect("无法解析的 email 也要留在节点维度（node_tag 为空）");
        assert_eq!(
            (no_tag.uplink, no_tag.downlink, no_tag.weighted),
            (100, 50, 150)
        );
        let ghost =
            repo::traffic::find_node_daily(&fixture.state.db.pool, &day, "server-1", "hk-1", "")
                .await
                .unwrap()
                .expect("用户不存在时 node_tag 仍要保留");
        assert_eq!(
            (ghost.uplink, ghost.downlink, ghost.weighted),
            (200, 100, 300)
        );

        // 不存在的用户不能被凭空创建，也没有用户用量可加。
        assert!(
            repo::users::find_by_username(&fixture.state.db.pool, "ghost")
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(used_bytes(&fixture.state, &fixture.user_id).await, 0);
    }

    /// 心跳里的 forwards 必须落到 forward_status，并整体覆盖上一轮；
    /// 空心跳 = Agent 已没有转发，旧状态要被清掉。
    #[tokio::test]
    async fn heartbeat_forward_status_is_persisted_and_replaced() {
        let fixture = fixture().await;
        let (server, _) =
            repo::servers::create(&fixture.state.db.pool, "hk-1", "1.2.3.4", "external")
                .await
                .unwrap();
        let forward = repo::forwards::create(
            &fixture.state.db.pool,
            &server.id,
            repo::forwards::NewForward {
                name: "香港中转".into(),
                listen_port: 8443,
                target_host: "10.0.0.8".into(),
                target_port: 443,
                enabled: true,
            },
        )
        .await
        .unwrap();

        let heartbeat =
            |seq: u64, forwards: Vec<pierwave_proto::ForwardStatus>| pierwave_proto::Heartbeat {
                seq,
                agent_version: "0.5.7".into(),
                arch: "x86_64".into(),
                os_name: None,
                os_version: None,
                virt: None,
                forwards,
                latency_ms: None,
                uptime_secs: 1,
                load1: 0.0,
                mem_used: 0,
                mem_total: 0,
                disk_used: 0,
                disk_total: 0,
                xray_running: true,
                nginx_running: true,
            };
        let send = |seq: u64, forwards: Vec<pierwave_proto::ForwardStatus>| {
            let message = AgentMessage::Heartbeat(heartbeat(seq, forwards));
            let text = serde_json::to_string(&message).unwrap();
            let state = fixture.state.clone();
            let server_id = server.id.clone();
            async move {
                handle_agent_message(&state, &server_id, "0.5.7", &text).await;
            }
        };

        send(
            1,
            vec![pierwave_proto::ForwardStatus {
                id: forward.id.clone(),
                listening: true,
                error: String::new(),
                target_ok: Some(true),
            }],
        )
        .await;
        let views = repo::forwards::list_with_status(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(views.len(), 1);
        let runtime = views[0].runtime.as_ref().expect("第一轮心跳应有状态");
        assert!(runtime.listening);
        assert_eq!(runtime.error, "");
        assert_eq!(
            runtime.target_ok,
            Some(true),
            "target_ok 必须落入 forward_status"
        );
        assert!(!runtime.degraded);

        send(
            2,
            vec![pierwave_proto::ForwardStatus {
                id: forward.id.clone(),
                listening: false,
                error: "端口已被占用".into(),
                target_ok: Some(false),
            }],
        )
        .await;
        let views = repo::forwards::list_with_status(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        let runtime = views[0].runtime.as_ref().unwrap();
        assert!(!runtime.listening);
        assert_eq!(runtime.error, "端口已被占用");
        assert_eq!(runtime.target_ok, Some(false));
        assert!(!runtime.degraded, "只失败一次不能判降级");

        // 空心跳清掉缓存：规则还在，但运行状态未知。
        send(3, Vec::new()).await;
        let views = repo::forwards::list_with_status(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(views.len(), 1);
        assert!(views[0].runtime.is_none(), "空心跳必须清掉旧运行状态");
    }

    /// 链降级只在 false → true 的跃迁时告警；恢复后再次降级会再发一次。
    #[tokio::test]
    async fn chain_degradation_alerts_only_on_transition() {
        let mut fixture = fixture().await;
        let transport = Arc::new(RecordingTransport::default());
        fixture.state.alerts = Alerts::new(transport.clone());
        repo::settings::set(
            &fixture.state.db.pool,
            "webhook_url",
            "https://example.test/hook",
        )
        .await
        .unwrap();
        // 测试要验证「跃迁去重」，不能靠冷却窗口掩盖重复发送。
        repo::settings::set(&fixture.state.db.pool, "alert_cooldown_secs", "0")
            .await
            .unwrap();

        let (server, _token) =
            repo::servers::create(&fixture.state.db.pool, "hk-1", "1.2.3.4", "external")
                .await
                .unwrap();
        let chain = repo::chains::create(
            &fixture.state.db.pool,
            repo::chains::NewChain {
                name: "relay".into(),
                target_host: "10.0.0.9".into(),
                target_port: 443,
                enabled: true,
                groups: vec![repo::chains::NewChainGroup {
                    name: None,
                    strategy: "round_robin".into(),
                    members: vec![repo::chains::NewChainGroupMember {
                        server_id: server.id.clone(),
                        listen_port: 8443,
                        priority: 0,
                        weight: 1,
                    }],
                }],
            },
        )
        .await
        .unwrap();
        let forward_id = pierwave_domain::chains::legacy_forward_id(&chain.chain.id, 0);

        let send = |seq: u64, target_ok: bool| {
            let heartbeat = pierwave_proto::Heartbeat {
                seq,
                agent_version: "0.5.7".into(),
                arch: "x86_64".into(),
                os_name: None,
                os_version: None,
                virt: None,
                forwards: vec![pierwave_proto::ForwardStatus {
                    id: forward_id.clone(),
                    listening: true,
                    error: String::new(),
                    target_ok: Some(target_ok),
                }],
                latency_ms: None,
                uptime_secs: 1,
                load1: 0.0,
                mem_used: 0,
                mem_total: 0,
                disk_used: 0,
                disk_total: 0,
                xray_running: true,
                nginx_running: true,
            };
            let text = serde_json::to_string(&AgentMessage::Heartbeat(heartbeat)).unwrap();
            let state = fixture.state.clone();
            let server_id = server.id.clone();
            async move {
                handle_agent_message(&state, &server_id, "0.5.7", &text).await;
            }
        };

        // 第一次失败：未达降级阈值，不发。
        send(1, false).await;
        transport
            .assert_no_more(0, std::time::Duration::from_millis(100))
            .await;

        // 第二次连续失败：false → true，必须发一条。
        send(2, false).await;
        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "chain_degraded");
        assert_eq!(sent[0].target, chain.chain.id);

        // 仍然降级：每次心跳都发就是刷屏，必须不发。
        send(3, false).await;
        transport
            .assert_no_more(1, std::time::Duration::from_millis(100))
            .await;

        // 恢复 → 再次连续失败：这是新的跃迁，应该再发一条。
        send(4, true).await;
        transport
            .assert_no_more(1, std::time::Duration::from_millis(100))
            .await;
        send(5, false).await;
        send(6, false).await;
        let sent = transport.wait_for(2).await;
        assert_eq!(sent[1].kind, "chain_degraded");
    }
}

/// 断流（enforcement）集成测试：流量上报 → 跨边界 → 去抖 apply → 配置里没有该用户。
#[cfg(test)]
mod enforcement_tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use tokio::sync::broadcast;

    use pierwave_domain::models::{Patch, Server};
    use pierwave_domain::repo;
    use pierwave_domain::Db;
    use pierwave_proto::{MasterMessage, TrafficDelta, TrafficReport};

    use super::*;
    use crate::alerts::{Alerts, RecordingTransport};

    struct Fixture {
        state: AppState,
        server: Server,
        node_tag: String,
    }

    async fn fixture(window: Duration) -> Fixture {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let (server, _token) = repo::servers::create(&db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        let node = repo::nodes::create(
            &db.pool,
            &server.id,
            repo::nodes::NewNode {
                tag: Some("vless-1".into()),
                name: "香港-1".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "none".into(),
                port: 443,
                config_json: json!({
                    "settings": {"clients": [], "decryption": "none"},
                    "stream": {"network": "tcp", "security": "none"}
                })
                .to_string(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();
        Fixture {
            state: AppState::new(db, "web/dist").with_enforcement(true, window),
            server,
            node_tag: node.tag,
        }
    }

    async fn add_user(state: &AppState, username: &str) -> String {
        repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: username.into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    /// 建一张卡；返回实例 id。
    async fn add_package(
        state: &AppState,
        user_id: &str,
        quota_bytes: Option<i64>,
        expires_at: Option<i64>,
    ) -> String {
        let package = repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: "测试卡".into(),
                quota_bytes,
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,

                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        repo::user_packages::create(
            &state.db.pool,
            user_id,
            repo::user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap()
        .id
    }

    fn traffic(seq: u64, email: &str, bytes: u64) -> TrafficReport {
        TrafficReport {
            seq,
            boot_id: "boot-1".into(),
            deltas: vec![TrafficDelta {
                email: email.into(),
                uplink: bytes,
                downlink: 0,
            }],
        }
    }

    async fn init_desired(fixture: &Fixture) {
        let outcome =
            crate::routes::desired::apply(&fixture.state, &fixture.server, "http://127.0.0.1:8787")
                .await
                .unwrap();
        assert_eq!(outcome.version, 1, "初始 apply 应为 v1");
        assert_eq!(outcome.delivered, 0, "测试里没有在线 Agent");
    }

    async fn next_desired(receiver: &mut broadcast::Receiver<MasterMessage>) -> MasterMessage {
        tokio::time::timeout(Duration::from_secs(3), receiver.recv())
            .await
            .expect("断流 apply 应在 3s 内下发")
            .expect("hub 不应关闭")
    }

    /// 事件是在广播之后落库的，测试里给一点收敛时间（生产无影响）。
    async fn wait_event_count(state: &AppState, expected: i64) {
        for _ in 0..200 {
            let count = repo::enforcement::count_events(&state.db.pool)
                .await
                .unwrap();
            if count == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let count = repo::enforcement::count_events(&state.db.pool)
            .await
            .unwrap();
        panic!("等待断流事件超时：期望 {expected} 条，实际 {count} 条");
    }

    async fn assert_no_more_desired(
        receiver: &mut broadcast::Receiver<MasterMessage>,
        wait: Duration,
    ) {
        tokio::time::sleep(wait).await;
        match receiver.try_recv() {
            Err(broadcast::error::TryRecvError::Empty) => {}
            Ok(_) => panic!("不应再产生 apply"),
            Err(error) => panic!("意外的 hub 状态：{error}"),
        }
    }

    fn clients_of(desired: &pierwave_proto::DesiredState) -> Vec<serde_json::Value> {
        desired.xray["inbounds"][0]["settings"]["clients"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    fn has_client(desired: &pierwave_proto::DesiredState, user_id: &str, node_tag: &str) -> bool {
        let email = format!("{user_id}@{node_tag}");
        clients_of(desired)
            .iter()
            .any(|client| client["email"] == email)
    }

    #[tokio::test]
    async fn exhausting_quota_triggers_one_apply_without_the_client() {
        let mut fixture = fixture(Duration::from_millis(80)).await;
        let transport = Arc::new(RecordingTransport::default());
        fixture.state.alerts = Alerts::new(transport.clone());
        repo::settings::set(
            &fixture.state.db.pool,
            "webhook_url",
            "https://example.test/hook",
        )
        .await
        .unwrap();
        let user_id = add_user(&fixture.state, "alice").await;
        add_package(&fixture.state, &user_id, Some(1000), None).await;
        init_desired(&fixture).await;

        let mut subscription = fixture.state.hub.subscribe(&fixture.server.id);
        let _worker = crate::enforcement::spawn_worker(fixture.state.clone());

        record_traffic(
            &fixture.state,
            &fixture.server.id,
            &traffic(1, &format!("{user_id}@{}", fixture.node_tag), 2000),
        )
        .await
        .unwrap();

        let desired = next_desired(&mut subscription.receiver).await;
        let MasterMessage::Desired(desired) = &desired else {
            panic!("expected desired state");
        };
        assert_eq!(desired.version, 2, "跨边界后应 apply 一次并 bump 版本");
        assert!(
            !has_client(desired, &user_id, &fixture.node_tag),
            "超额用户的 client 必须从下发配置里消失"
        );
        // 版本再确认一次：worker 只 apply 了一次。
        assert_no_more_desired(&mut subscription.receiver, Duration::from_millis(250)).await;

        let server = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.server.id)
            .await
            .unwrap();
        assert_eq!(server.config_version, 2);

        wait_event_count(&fixture.state, 1).await;
        let events = repo::enforcement::list_events(&fixture.state.db.pool, 10)
            .await
            .unwrap();
        assert_eq!(events.len(), 1, "只应写一条断流事件");
        assert_eq!(events[0].kind, "removed");
        assert_eq!(events[0].user_id, user_id);
        assert_eq!(events[0].reason, "exhausted");
        assert_eq!(events[0].server_id, fixture.server.id);
        assert!(
            events[0].message.contains("额度用尽"),
            "{}",
            events[0].message
        );
        assert!(
            events[0].message.contains("已从服务器 hk-1 的配置中移除"),
            "{}",
            events[0].message
        );

        // 移除用户时同步发 UserExhausted 告警（投递在独立任务里）。
        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "user_exhausted");
        assert_eq!(sent[0].target, user_id);

        // 已经不可用之后再上报：不得重复触发 apply / 事件。
        record_traffic(
            &fixture.state,
            &fixture.server.id,
            &traffic(2, &format!("{user_id}@{}", fixture.node_tag), 500),
        )
        .await
        .unwrap();
        assert_no_more_desired(&mut subscription.receiver, Duration::from_millis(250)).await;
        assert_eq!(
            repo::enforcement::count_events(&fixture.state.db.pool)
                .await
                .unwrap(),
            1,
            "同一用户只应移除一次"
        );
    }

    #[tokio::test]
    async fn three_crossings_on_one_server_coalesce_into_one_apply() {
        let fixture = fixture(Duration::from_millis(300)).await;
        let mut users = Vec::new();
        for name in ["alice", "bob", "carol"] {
            let user_id = add_user(&fixture.state, name).await;
            add_package(&fixture.state, &user_id, Some(1000), None).await;
            users.push(user_id);
        }
        init_desired(&fixture).await;

        let mut subscription = fixture.state.hub.subscribe(&fixture.server.id);
        let _worker = crate::enforcement::spawn_worker(fixture.state.clone());

        for (index, user_id) in users.iter().enumerate() {
            record_traffic(
                &fixture.state,
                &fixture.server.id,
                &traffic(
                    index as u64 + 1,
                    &format!("{user_id}@{}", fixture.node_tag),
                    2000,
                ),
            )
            .await
            .unwrap();
        }

        let desired = next_desired(&mut subscription.receiver).await;
        let MasterMessage::Desired(desired) = desired else {
            panic!("expected desired state");
        };
        assert_eq!(desired.version, 2, "三次触发应合并成一次 apply");
        let clients = desired.xray["inbounds"][0]["settings"]["clients"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(clients.is_empty(), "三个用户都应被移除：{clients:?}");

        // 窗口过后也不能补跑：批次已经合并并消费掉了。
        assert_no_more_desired(&mut subscription.receiver, Duration::from_millis(600)).await;
        wait_event_count(&fixture.state, 3).await;
    }

    #[tokio::test]
    async fn normal_report_does_not_trigger_any_apply() {
        let fixture = fixture(Duration::from_millis(50)).await;
        let user_id = add_user(&fixture.state, "alice").await;
        add_package(&fixture.state, &user_id, Some(1_000_000), None).await;
        init_desired(&fixture).await;

        let mut subscription = fixture.state.hub.subscribe(&fixture.server.id);
        let _worker = crate::enforcement::spawn_worker(fixture.state.clone());

        record_traffic(
            &fixture.state,
            &fixture.server.id,
            &traffic(1, &format!("{user_id}@{}", fixture.node_tag), 1000),
        )
        .await
        .unwrap();

        assert_no_more_desired(&mut subscription.receiver, Duration::from_millis(250)).await;
        let server = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.server.id)
            .await
            .unwrap();
        assert_eq!(server.config_version, 1, "未超额不得 bump 版本");
        assert_eq!(
            repo::enforcement::count_events(&fixture.state.db.pool)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn reconciliation_removes_expired_user_and_stays_idempotent() {
        let fixture = fixture(Duration::from_millis(50)).await;
        let user_id = add_user(&fixture.state, "alice").await;
        let instance_id = add_package(
            &fixture.state,
            &user_id,
            Some(10_000),
            Some(pierwave_domain::time::now() + 3600),
        )
        .await;
        // 先让用户进入下发配置。
        init_desired(&fixture).await;

        // 时间流逝 → 到期。没有流量上报能触发它，只能靠 5 分钟对账。
        repo::user_packages::update(
            &fixture.state.db.pool,
            &instance_id,
            repo::user_packages::UpdateUserPackage {
                expires_at: Patch::Value(pierwave_domain::time::now() - 1),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let mut subscription = fixture.state.hub.subscribe(&fixture.server.id);
        let _worker = crate::enforcement::spawn_worker(fixture.state.clone());

        let users = crate::enforcement::reconcile_once(&fixture.state)
            .await
            .unwrap();
        assert_eq!(users, 1, "应扫出这个过期用户");

        let desired = next_desired(&mut subscription.receiver).await;
        let MasterMessage::Desired(desired) = desired else {
            panic!("expected desired state");
        };
        assert_eq!(desired.version, 2);
        let clients = desired.xray["inbounds"][0]["settings"]["clients"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(clients.is_empty(), "过期用户应被移除：{clients:?}");

        wait_event_count(&fixture.state, 1).await;
        let events = repo::enforcement::list_events(&fixture.state.db.pool, 10)
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "removed");
        assert_eq!(events[0].reason, "expired");
        assert!(
            events[0].message.contains("套餐已到期"),
            "{}",
            events[0].message
        );

        // 再对账一轮：用户仍然不可用，但期望态没变 → 不 bump、不重复写事件。
        let users = crate::enforcement::reconcile_once(&fixture.state)
            .await
            .unwrap();
        assert_eq!(users, 1);
        assert_no_more_desired(&mut subscription.receiver, Duration::from_millis(300)).await;
        let server = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.server.id)
            .await
            .unwrap();
        assert_eq!(server.config_version, 2, "期望态没变时不得空转 bump");
        assert_eq!(
            repo::enforcement::count_events(&fixture.state.db.pool)
                .await
                .unwrap(),
            1,
            "不得重复写事件"
        );
    }

    #[tokio::test]
    async fn restoring_quota_re_adds_client_and_writes_restored_event() {
        let fixture = fixture(Duration::from_millis(50)).await;
        let user_id = add_user(&fixture.state, "alice").await;
        let instance_id = add_package(&fixture.state, &user_id, Some(1000), None).await;
        init_desired(&fixture).await;

        let mut subscription = fixture.state.hub.subscribe(&fixture.server.id);
        let _worker = crate::enforcement::spawn_worker(fixture.state.clone());

        // 1) 跑满额度 → 自动移除（v2）。
        record_traffic(
            &fixture.state,
            &fixture.server.id,
            &traffic(1, &format!("{user_id}@{}", fixture.node_tag), 2000),
        )
        .await
        .unwrap();
        let desired = next_desired(&mut subscription.receiver).await;
        let MasterMessage::Desired(desired) = desired else {
            panic!("expected desired state");
        };
        assert_eq!(desired.version, 2);
        assert!(
            !has_client(&desired, &user_id, &fixture.node_tag),
            "跑满后 client 应消失"
        );
        wait_event_count(&fixture.state, 1).await;

        // 2) 管理员把 quota_override 调大 → 用户重新 eligible。
        repo::user_packages::update(
            &fixture.state.db.pool,
            &instance_id,
            repo::user_packages::UpdateUserPackage {
                quota_override: Patch::Value(10_000),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        // 3) 对账发现「现在 eligible 但不在上次下发快照里」→ 恢复（v3）。
        let users = crate::enforcement::reconcile_once(&fixture.state)
            .await
            .unwrap();
        assert_eq!(users, 1, "对账应发现一个待恢复用户");

        let desired = next_desired(&mut subscription.receiver).await;
        let MasterMessage::Desired(desired) = desired else {
            panic!("expected desired state");
        };
        assert_eq!(desired.version, 3, "恢复必须 bump config_version");
        assert!(
            has_client(&desired, &user_id, &fixture.node_tag),
            "恢复后 client 应回到下发配置里"
        );

        wait_event_count(&fixture.state, 2).await;
        let events = repo::enforcement::list_events(&fixture.state.db.pool, 10)
            .await
            .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "restored", "最新一条应是恢复事件");
        assert_eq!(events[0].reason, "recovered");
        assert_eq!(events[0].user_id, user_id);
        assert!(
            events[0].message.contains("已加入服务器 hk-1 的配置"),
            "{}",
            events[0].message
        );
        assert_eq!(events[1].kind, "removed", "前一条仍是移除事件");

        // 4) 再跑一轮对账：期望态没变 → 不 bump、不重复写事件。
        let users = crate::enforcement::reconcile_once(&fixture.state)
            .await
            .unwrap();
        assert_eq!(users, 0, "没有新的移除/恢复");
        assert_no_more_desired(&mut subscription.receiver, Duration::from_millis(300)).await;
        let server = repo::servers::find_by_id(&fixture.state.db.pool, &fixture.server.id)
            .await
            .unwrap();
        assert_eq!(server.config_version, 3, "幂等：不得重复 bump");
        assert_eq!(
            repo::enforcement::count_events(&fixture.state.db.pool)
                .await
                .unwrap(),
            2,
            "幂等：不得重复写事件"
        );
    }

    async fn add_admin(state: &AppState) -> pierwave_domain::models::User {
        repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: "admin".into(),
                password: "password123".into(),
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap()
    }

    async fn package_template(state: &AppState, quota_bytes: i64) -> String {
        repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: "测试卡".into(),
                quota_bytes: Some(quota_bytes),
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,

                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    async fn add_package_with_reset_day(
        state: &AppState,
        user_id: &str,
        quota_bytes: i64,
        reset_day: i64,
    ) -> String {
        let package = repo::packages::create(
            &state.db.pool,
            repo::packages::NewPackage {
                name: "重置卡".into(),
                quota_bytes: Some(quota_bytes),
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,

                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        repo::user_packages::create(
            &state.db.pool,
            user_id,
            repo::user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: Some(reset_day),
            },
            &package,
        )
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn binding_new_package_restores_without_reconcile() {
        let fixture = fixture(Duration::from_millis(50)).await;
        let user_id = add_user(&fixture.state, "alice").await;
        let admin = add_admin(&fixture.state).await;
        // 初始配置：用户还没有卡 → 快照 granted_users 为空。
        init_desired(&fixture).await;

        let mut subscription = fixture.state.hub.subscribe(&fixture.server.id);
        let _worker = crate::enforcement::spawn_worker(fixture.state.clone());

        let package_id = package_template(&fixture.state, 10_000).await;
        let _ = crate::routes::users::create_user_package(
            axum::extract::State(fixture.state.clone()),
            crate::auth::CurrentUser(admin),
            axum::extract::Path(user_id.clone()),
            axum::Json(crate::routes::users::CreateUserPackage {
                package_id,
                expires_at: Patch::Missing,
                quota_override: None,
                reset_day: None,
            }),
        )
        .await
        .unwrap();

        // 不调用 reconcile_once：仅靠 route 里的 mark + 去抖完成恢复。
        let desired = next_desired(&mut subscription.receiver).await;
        let MasterMessage::Desired(desired) = desired else {
            panic!("expected desired state");
        };
        assert_eq!(desired.version, 2);
        assert!(
            has_client(&desired, &user_id, &fixture.node_tag),
            "绑卡后 client 应通过 mark+去抖自动回到配置"
        );

        wait_event_count(&fixture.state, 1).await;
        let events = repo::enforcement::list_events(&fixture.state.db.pool, 10)
            .await
            .unwrap();
        assert_eq!(events[0].kind, "restored");
        assert_eq!(events[0].user_id, user_id);
    }

    #[tokio::test]
    async fn raising_quota_via_patch_restores_without_reconcile() {
        let fixture = fixture(Duration::from_millis(50)).await;
        let user_id = add_user(&fixture.state, "alice").await;
        let admin = add_admin(&fixture.state).await;
        let instance_id = add_package(&fixture.state, &user_id, Some(1000), None).await;
        init_desired(&fixture).await;

        let mut subscription = fixture.state.hub.subscribe(&fixture.server.id);
        let _worker = crate::enforcement::spawn_worker(fixture.state.clone());

        // 先跑满，让断流把 client 移除（v2）。
        record_traffic(
            &fixture.state,
            &fixture.server.id,
            &traffic(1, &format!("{user_id}@{}", fixture.node_tag), 2000),
        )
        .await
        .unwrap();
        let desired = next_desired(&mut subscription.receiver).await;
        let MasterMessage::Desired(desired) = desired else {
            panic!("expected desired state");
        };
        assert_eq!(desired.version, 2);
        assert!(!has_client(&desired, &user_id, &fixture.node_tag));
        wait_event_count(&fixture.state, 1).await;

        // 管理员改额度：route 里直接 mark，不等 5 分钟对账。
        let _ = crate::routes::users::update_user_package(
            axum::extract::State(fixture.state.clone()),
            crate::auth::CurrentUser(admin),
            axum::extract::Path(instance_id),
            axum::Json(crate::routes::users::UpdateUserPackage {
                expires_at: Patch::Missing,
                quota_override: Patch::Value(10_000),
                reset_day: Patch::Missing,
                status: None,
            }),
        )
        .await
        .unwrap();

        let desired = next_desired(&mut subscription.receiver).await;
        let MasterMessage::Desired(desired) = desired else {
            panic!("expected desired state");
        };
        assert_eq!(desired.version, 3);
        assert!(
            has_client(&desired, &user_id, &fixture.node_tag),
            "改额度后 client 应通过 mark+去抖自动恢复"
        );
        wait_event_count(&fixture.state, 2).await;
        let events = repo::enforcement::list_events(&fixture.state.db.pool, 10)
            .await
            .unwrap();
        assert_eq!(events[0].kind, "restored");
    }

    #[tokio::test]
    async fn daily_reset_restores_without_reconcile() {
        let fixture = fixture(Duration::from_millis(50)).await;
        let user_id = add_user(&fixture.state, "alice").await;
        let (_, _, today) = pierwave_domain::time::business_ymd(pierwave_domain::time::now());
        let _instance_id =
            add_package_with_reset_day(&fixture.state, &user_id, 1000, i64::from(today)).await;
        init_desired(&fixture).await;

        let mut subscription = fixture.state.hub.subscribe(&fixture.server.id);
        let _worker = crate::enforcement::spawn_worker(fixture.state.clone());

        // 跑满 → 移除（v2）。
        record_traffic(
            &fixture.state,
            &fixture.server.id,
            &traffic(1, &format!("{user_id}@{}", fixture.node_tag), 2000),
        )
        .await
        .unwrap();
        let desired = next_desired(&mut subscription.receiver).await;
        let MasterMessage::Desired(desired) = desired else {
            panic!("expected desired state");
        };
        assert_eq!(desired.version, 2);
        assert!(!has_client(&desired, &user_id, &fixture.node_tag));
        wait_event_count(&fixture.state, 1).await;

        // 每日重置清零：调度器这一轮会直接 mark，不等 5 分钟对账。
        let report = crate::scheduler::run_reset_round(&fixture.state)
            .await
            .unwrap();
        assert_eq!(report.instances, 1, "今天应命中这张重置卡");

        let desired = next_desired(&mut subscription.receiver).await;
        let MasterMessage::Desired(desired) = desired else {
            panic!("expected desired state");
        };
        assert_eq!(desired.version, 3);
        assert!(
            has_client(&desired, &user_id, &fixture.node_tag),
            "每日重置后 client 应通过 mark+去抖自动恢复"
        );
        wait_event_count(&fixture.state, 2).await;
        let events = repo::enforcement::list_events(&fixture.state.db.pool, 10)
            .await
            .unwrap();
        assert_eq!(events[0].kind, "restored");
    }

    #[tokio::test]
    async fn enforcement_can_be_disabled() {
        let fixture = fixture(Duration::from_millis(20)).await;
        // 覆盖开关：模拟 PIERWAVE_ENFORCE=0。
        let state = fixture
            .state
            .clone()
            .with_enforcement(false, Duration::from_millis(20));
        let user_id = add_user(&state, "alice").await;
        let instance_id = add_package(&state, &user_id, Some(1000), None).await;

        let mut subscription = state.hub.subscribe(&fixture.server.id);
        let _worker = crate::enforcement::spawn_worker(state.clone());

        record_traffic(
            &state,
            &fixture.server.id,
            &traffic(1, &format!("{user_id}@{}", fixture.node_tag), 2000),
        )
        .await
        .unwrap();

        assert_no_more_desired(&mut subscription.receiver, Duration::from_millis(200)).await;
        assert_eq!(
            repo::enforcement::count_events(&state.db.pool)
                .await
                .unwrap(),
            0
        );

        // 恢复逻辑也必须一并停掉：额度调大后对账不返回用户、不 apply。
        repo::user_packages::update(
            &state.db.pool,
            &instance_id,
            repo::user_packages::UpdateUserPackage {
                quota_override: Patch::Value(10_000),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            crate::enforcement::reconcile_once(&state).await.unwrap(),
            0,
            "关闭时恢复对账也必须停"
        );
        assert_no_more_desired(&mut subscription.receiver, Duration::from_millis(200)).await;
    }

    /// 心跳必须把健康指标和 agent 版本落库，否则面板只能看到「在线」，
    /// 而「agent 活着但 xray 崩了」会完全不可见。
    #[tokio::test]
    async fn heartbeat_persists_health_and_version() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let (server, _token) = repo::servers::create(&state.db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();

        let health = repo::servers::HealthSnapshot {
            arch: "aarch64".into(),
            xray_running: false,
            nginx_running: true,
            load1: 1.25,
            mem_used: 512,
            mem_total: 1024,
            disk_used: 10,
            disk_total: 100,
            uptime_secs: 3600,
            latency_ms: Some(23),
            ..Default::default()
        };
        repo::servers::update_health(&state.db.pool, &server.id, "0.1.0", &health)
            .await
            .unwrap();

        let listed = repo::servers::list(&state.db.pool).await.unwrap();
        let row = &listed[0];
        assert_eq!(row.agent_version.as_deref(), Some("0.1.0"));
        assert_eq!(row.arch, "aarch64", "架构要落库，升级时据此挑产物");
        assert_eq!(row.xray_running, Some(false), "xray 挂了必须能看出来");
        assert_eq!(row.load1, Some(1.25));
        assert_eq!(row.mem_total, Some(1024));
        assert_eq!(row.uptime_secs, Some(3600));
        assert_eq!(row.latency_ms, Some(23), "探测 RTT 要随心跳落库");
        assert!(row.health_at.is_some());
        assert_eq!(row.status, "online");
    }

    /// 旧 Agent 的 JSON 没有 `latency_ms`：deserialize 必须成功，库里保持 NULL，
    /// 不能回落到 0（0 在 UI 上会被读成「极快」）。
    #[tokio::test]
    async fn heartbeat_without_latency_field_leaves_null() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let (server, _token) = repo::servers::create(&state.db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();

        let heartbeat = serde_json::json!({
            "type": "heartbeat",
            "seq": 1,
            "uptime_secs": 2,
            "load1": 0.1,
            "mem_used": 1,
            "mem_total": 2,
            "disk_used": 1,
            "disk_total": 2,
            "xray_running": true,
            "nginx_running": true,
        })
        .to_string();
        handle_agent_message(&state, &server.id, "0.1.0", &heartbeat).await;

        let row = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.latency_ms, None, "旧 Agent 不上报时必须是 NULL");
        assert_eq!(row.os_name, None, "旧 Agent 没有 os_name 时必须 NULL");
        assert_eq!(row.os_version, None, "旧 Agent 没有 os_version 时必须 NULL");
        assert_eq!(row.virt, None, "旧 Agent 没有 virt 时必须 NULL");
    }

    /// 新 Agent 心跳带 OS / 虚拟化：走同一条 message 解析路径落库。
    #[tokio::test]
    async fn heartbeat_with_os_fields_persists_values() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let (server, _token) = repo::servers::create(&state.db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();

        let heartbeat = serde_json::json!({
            "type": "heartbeat",
            "seq": 1,
            "uptime_secs": 2,
            "load1": 0.1,
            "mem_used": 1,
            "mem_total": 2,
            "disk_used": 1,
            "disk_total": 2,
            "xray_running": true,
            "nginx_running": true,
            "arch": "x86_64",
            "os_name": "Debian GNU/Linux",
            "os_version": "12",
            "virt": "kvm",
        })
        .to_string();
        handle_agent_message(&state, &server.id, "0.1.0", &heartbeat).await;

        let row = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.os_name.as_deref(), Some("Debian GNU/Linux"));
        assert_eq!(row.os_version.as_deref(), Some("12"));
        assert_eq!(row.virt.as_deref(), Some("kvm"));
        assert_eq!(row.arch, "x86_64");
    }

    /// 新 Agent 的心跳带 `latency_ms`：走同一条 message 解析路径落库。
    #[tokio::test]
    async fn heartbeat_with_latency_field_persists_value() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let (server, _token) = repo::servers::create(&state.db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();

        let heartbeat = serde_json::json!({
            "type": "heartbeat",
            "seq": 1,
            "uptime_secs": 2,
            "load1": 0.1,
            "mem_used": 1,
            "mem_total": 2,
            "disk_used": 1,
            "disk_total": 2,
            "xray_running": true,
            "nginx_running": true,
            "latency_ms": 42,
        })
        .to_string();
        handle_agent_message(&state, &server.id, "0.1.0", &heartbeat).await;

        let row = repo::servers::find_by_id(&state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.latency_ms, Some(42));
    }
}

/// Agent 自升级：心跳把 pending 翻成 succeeded 的集成测试。
#[cfg(test)]
mod upgrade_tests {
    use super::*;
    use serde_json::json;

    use pierwave_domain::Db;

    async fn fixture() -> (AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let (server, _token) = repo::servers::create(&db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        repo::servers::update(&db.pool, &server.id, None, None, None, Some(true))
            .await
            .unwrap();
        repo::servers::update_health(
            &db.pool,
            &server.id,
            "0.5.0",
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        repo::servers::set_agent_target_version(&db.pool, &server.id, Some("v0.6.0"))
            .await
            .unwrap();
        repo::agent_upgrades::create(&db.pool, &server.id, "0.5.0", "v0.6.0")
            .await
            .unwrap();
        (AppState::new(db, "web/dist"), server.id)
    }

    fn heartbeat(seq: u64, version: &str) -> String {
        json!({
            "type": "heartbeat",
            "seq": seq,
            "agent_version": version,
            "uptime_secs": 1,
            "load1": 0.1,
            "mem_used": 1,
            "mem_total": 2,
            "disk_used": 1,
            "disk_total": 2,
            "xray_running": true,
            "nginx_running": true,
        })
        .to_string()
    }

    #[tokio::test]
    async fn heartbeat_with_target_version_flips_pending_to_succeeded() {
        let (state, server_id) = fixture().await;

        // 旧版本心跳：目标未达成，必须保持 pending。
        handle_agent_message(&state, &server_id, "0.5.0", &heartbeat(1, "0.5.0")).await;
        let latest = repo::agent_upgrades::latest(&state.db.pool, &server_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.status, "pending");
        let server = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(server.agent_target_version.as_deref(), Some("v0.6.0"));

        // 第一次报上新版本：只是「起来了」，进入稳定窗口，仍保持 pending。
        handle_agent_message(&state, &server_id, "0.6.0", &heartbeat(2, "0.6.0")).await;
        let latest = repo::agent_upgrades::latest(&state.db.pool, &server_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.status, "pending", "稳定窗口未满前不能判成功");
        let confirmed_at = latest.confirmed_at.expect("第一次看到新版本应记录确认时间");

        // 窗口内再次心跳：仍然 pending。
        settle_agent_upgrade(&state, &server_id, "0.6.0", confirmed_at + 30).await;
        let latest = repo::agent_upgrades::latest(&state.db.pool, &server_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.status, "pending");

        // 撑过稳定窗口：翻 succeeded 并清空 target。
        settle_agent_upgrade(
            &state,
            &server_id,
            "0.6.0",
            confirmed_at + UPGRADE_STABLE_SECS + 1,
        )
        .await;
        let latest = repo::agent_upgrades::latest(&state.db.pool, &server_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.status, "succeeded");
        assert_eq!(latest.error, "");
        let server = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(server.agent_target_version, None);
        assert_eq!(server.agent_version.as_deref(), Some("0.6.0"));

        // 再发一次同样的心跳不会重复处理（没有 pending 了）。
        handle_agent_message(&state, &server_id, "0.6.0", &heartbeat(3, "0.6.0")).await;
        assert_eq!(
            repo::agent_upgrades::list_by_server(&state.db.pool, &server_id)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    /// 卡住的 pending 必须被巡检判失败并清空目标，否则前端永远转圈、也无法重新发起升级。
    #[tokio::test]
    async fn stale_pending_upgrade_expires_and_clears_target() {
        let (state, server_id) = fixture().await;
        let upgrade = repo::agent_upgrades::latest(&state.db.pool, &server_id)
            .await
            .unwrap()
            .unwrap();

        // 把创建时间往前拨，模拟一次两周前就卡住的升级。
        sqlx::query("UPDATE agent_upgrades SET created_at = created_at - 2000, updated_at = updated_at - 2000 WHERE id = ?")
            .bind(&upgrade.id)
            .execute(&state.db.pool)
            .await
            .unwrap();

        let expired = crate::scheduler::run_upgrade_sweep(&state).await.unwrap();
        assert_eq!(expired, vec![server_id.clone()]);

        let latest = repo::agent_upgrades::latest(&state.db.pool, &server_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.status, "failed");
        assert!(latest.error.contains("超时"), "{}", latest.error);

        let server = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(server.agent_target_version, None, "超时后要清空目标版本");
    }

    /// 刚创建的 pending 不能被误判超时。
    #[tokio::test]
    async fn fresh_pending_upgrade_is_not_expired() {
        let (state, server_id) = fixture().await;
        let expired = crate::scheduler::run_upgrade_sweep(&state).await.unwrap();
        assert!(expired.is_empty());
        let latest = repo::agent_upgrades::latest(&state.db.pool, &server_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.status, "pending");
    }
}
