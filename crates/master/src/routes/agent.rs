use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;

use mmrust_domain::repo;
use mmrust_proto::{AgentMessage, MasterMessage, ServerAck, PROTOCOL_VERSION};

use crate::state::AppState;

pub async fn ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle(socket, state))
}

/// Agent 反向连入：第一条消息必须是 Hello(token)。
/// token 校验通过后下发 Ack，之后只处理心跳/上报。
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
    if let Ok(payload) = serde_json::to_string(&ack) {
        if socket.send(Message::Text(payload.into())).await.is_err() {
            return;
        }
    }

    // TODO(P1): 若 server.config_version > 0，这里主动下发 DesiredState

    while let Some(frame) = socket.recv().await {
        let Ok(Message::Text(text)) = frame else {
            break;
        };
        match serde_json::from_str::<AgentMessage>(&text) {
            Ok(AgentMessage::Heartbeat(hb)) => {
                if let Err(e) = repo::servers::heartbeat(&state.db.pool, &server.id).await {
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
                if let Err(e) = record_traffic(&state, &server.id, &report).await {
                    tracing::error!(error = %e, "traffic report failed");
                }
            }
            Ok(AgentMessage::Hello(_)) => {}
            Err(e) => tracing::warn!(error = %e, "unparsable agent message"),
        }
    }

    if let Err(e) = repo::servers::mark_offline(&state.db.pool, &server.id).await {
        tracing::error!(error = %e, "mark_offline failed");
    }
    tracing::info!(server = %server.name, "agent disconnected");
}

async fn record_traffic(
    state: &AppState,
    server_id: &str,
    report: &mmrust_proto::TrafficReport,
) -> anyhow::Result<()> {
    // 幂等键 (server_id, boot_id, seq)：重复上报直接丢弃
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO traffic_reports (server_id, boot_id, seq, received_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(server_id)
    .bind(&report.boot_id)
    .bind(report.seq as i64)
    .bind(chrono::Utc::now().timestamp())
    .execute(&state.db.pool)
    .await?
    .rows_affected();

    if inserted == 0 {
        return Ok(());
    }

    let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
    for delta in &report.deltas {
        sqlx::query(
            "INSERT INTO traffic_daily (day, server_id, subject, uplink, downlink, weighted)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(day, server_id, subject) DO UPDATE SET
                uplink = uplink + excluded.uplink,
                downlink = downlink + excluded.downlink,
                weighted = weighted + excluded.weighted",
        )
        .bind(&day)
        .bind(server_id)
        .bind(&delta.email)
        .bind(delta.uplink as i64)
        .bind(delta.downlink as i64)
        .bind((delta.uplink + delta.downlink) as i64)
        .execute(&state.db.pool)
        .await?;
    }
    Ok(())
}
