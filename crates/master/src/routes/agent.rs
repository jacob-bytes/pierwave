use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use tokio::sync::broadcast;

use mmrust_domain::metering;
use mmrust_domain::repo;
use mmrust_domain::time;
use mmrust_proto::{
    AgentMessage, DesiredState, MasterMessage, ServerAck, TrafficReport, PROTOCOL_VERSION,
};

use crate::state::AppState;

pub async fn ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle(socket, state))
}

/// Agent 反向连入：第一条消息必须是 Hello(token)。
/// token 校验通过后下发 Ack；之后 socket 与广播通道并行处理：
/// 一边收心跳/上报，一边把主控 apply 产生的期望态推下去。
async fn handle(mut socket: WebSocket, state: AppState) {
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

    let server = match repo::servers::find_by_token(&state.db.pool, &hello.token).await {
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
        match super::desired::render(&state, &server).await {
            Ok(rendered) => {
                let desired = MasterMessage::Desired(DesiredState {
                    version: server.config_version,
                    xray: rendered.xray,
                    files: Vec::new(),
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
                        handle_agent_message(&state, &server.id, &text).await;
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

async fn handle_agent_message(state: &AppState, server_id: &str, text: &str) {
    match serde_json::from_str::<AgentMessage>(text) {
        Ok(AgentMessage::Heartbeat(hb)) => {
            if let Err(e) = repo::servers::heartbeat(&state.db.pool, server_id).await {
                tracing::error!(error = %e, "heartbeat write failed");
            }
            tracing::debug!(seq = hb.seq, load1 = hb.load1, "heartbeat");
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
    for delta in &report.deltas {
        record_delta(
            state,
            server_id,
            &day,
            &delta.email,
            delta.uplink,
            delta.downlink,
        )
        .await?;
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
) -> anyhow::Result<()> {
    // 按最后一个 `@` 切分：用户 ID 是 UUID（无 @），node_tag 里可能有 @。
    let user = match email.rsplit_once('@') {
        Some((user_id, node_tag)) if !user_id.is_empty() && !node_tag.is_empty() => {
            repo::users::find_by_id_opt(&state.db.pool, user_id).await?
        }
        _ => None,
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
        return Ok(());
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
    repo::users::add_used_bytes(&state.db.pool, &user.id, saturating_i64(weighted)).await?;

    // 瀑布分配：多张卡按 created_at 顺序填，先填满第一张再下一张。
    for (instance_id, amount) in metering::waterfall(weighted, &instances) {
        repo::user_packages::add_used_bytes(&state.db.pool, &instance_id, saturating_i64(amount))
            .await?;
    }
    Ok(())
}

/// u64 → SQLite 的 i64：正常流量远小于 i64::MAX，超出时饱和而不是回绕成负数。
fn saturating_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use mmrust_domain::models::UserPackageView;
    use mmrust_domain::Db;

    use super::*;
    use mmrust_proto::TrafficDelta;

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
        // 不存在的用户不能被凭空创建，也没有用户用量可加。
        assert!(
            repo::users::find_by_username(&fixture.state.db.pool, "ghost")
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(used_bytes(&fixture.state, &fixture.user_id).await, 0);
    }
}
