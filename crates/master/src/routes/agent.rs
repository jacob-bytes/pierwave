use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::extract::ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Extension, State};
use axum::http::HeaderMap;
use axum::response::Response;
use tokio::sync::broadcast;

use pierwave_domain::apply::{ApplyReport, ApplyStatus};
use pierwave_domain::enforcement as enforcement_rules;
use pierwave_domain::metering;
use pierwave_domain::models::{package_status_at, Server, UserPackageView};
use pierwave_domain::repo;
use pierwave_domain::time;
use pierwave_proto::{
    AgentHello, AgentMessage, DesiredState, MasterMessage, ServerAck, TrafficReport,
    PROTOCOL_VERSION,
};

use crate::enforcement::RemovalCandidate;
use crate::routes::public_url::{self, PublicBaseKind};
use crate::state::AppState;

/// Agent 连上后必须在此时限内发出 Hello，否则直接关闭。
///
/// 不设超时的话，一个只握手不发 Hello 的连接会长期占用 socket 与任务。
const AGENT_HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// 单条 WS 消息的上限（1 MiB）。Agent 的心跳/上报远小于此。
const AGENT_MAX_MESSAGE: usize = 1024 * 1024;

/// 单个 WS 帧的上限（1 MiB），避免用分片绕开消息上限。
const AGENT_MAX_FRAME: usize = 1024 * 1024;

/// Hello 字段长度上限（字节）。在查库之前拒绝，超长输入不进入查询与日志。
const AGENT_TOKEN_MAX_LEN: usize = 128;
const AGENT_HOSTNAME_MAX_LEN: usize = 255;
const AGENT_VERSION_MAX_LEN: usize = 64;

pub async fn ws(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    // 生产由 `into_make_service_with_connect_info` 注入；测试里可以缺省，
    // 缺省时按 XFF / `unknown` 处理（与 HTTP 的 ClientIp 规则一致）。
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    State(state): State<AppState>,
) -> Response {
    let peer = peer.map(|Extension(ConnectInfo(addr))| addr.ip());
    upgrade(ws, state, headers, peer, AGENT_HELLO_TIMEOUT)
}

/// 握手：设置帧/消息上限，并在升级后按给定超时等待 Hello。
///
/// 超时参数拆出来是为了让测试用毫秒级超时，生产固定用 [`AGENT_HELLO_TIMEOUT`]。
fn upgrade(
    ws: WebSocketUpgrade,
    state: AppState,
    headers: HeaderMap,
    peer: Option<IpAddr>,
    hello_timeout: Duration,
) -> Response {
    ws.max_message_size(AGENT_MAX_MESSAGE)
        .max_frame_size(AGENT_MAX_FRAME)
        .on_upgrade(move |socket| handle_with_timeout(socket, state, headers, peer, hello_timeout))
}

/// Agent 反向连入：第一条消息必须是 Hello(token)。
/// token 校验通过后下发 Ack；之后 socket 与广播通道并行处理：
/// 一边收心跳/上报，一边把主控 apply 产生的期望态推下去。
async fn handle_with_timeout(
    mut socket: WebSocket,
    state: AppState,
    headers: HeaderMap,
    peer: Option<IpAddr>,
    hello_timeout: Duration,
) {
    // 与 HTTP 共用同一套 IP 信任边界：公网直连无视 XFF，只有回环/内网反代才采信。
    // 限流键用规范化后的 /64（IPv6）或 IPv4 地址；没有可用地址时跳过 IP 限流。
    let ip_key = super::auth::client_ip_with_peer(&headers, peer).map(|addr| addr.throttle_key());
    let first = match tokio::time::timeout(hello_timeout, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => text,
        // 客户端主动关闭 / 正常 EOF：还没登记，不查库也不标离线。
        Ok(Some(Ok(Message::Close(_)))) | Ok(None) => return,
        // 首帧必须是文本 Hello；二进制/控制帧直接拒绝。
        Ok(Some(Ok(_))) => {
            reject(&mut socket, "expected hello", close_code::POLICY).await;
            return;
        }
        Ok(Some(Err(e))) => {
            tracing::warn!(error = %e, "agent socket error before hello");
            return;
        }
        Err(_) => {
            // 日志只包含超时值：此时还没有 token，也绝不回显任何客户端输入。
            tracing::warn!(
                timeout_ms = hello_timeout.as_millis(),
                "agent hello timeout，关闭连接（未查库）"
            );
            close_socket(&mut socket, close_code::POLICY).await;
            return;
        }
    };

    let Ok(AgentMessage::Hello(hello)) = serde_json::from_str(&first) else {
        reject(&mut socket, "expected hello", close_code::POLICY).await;
        return;
    };

    // 长度校验必须在查库之前：超长字段不应进入 SQL 查询与日志。
    if let Some((field, max)) = hello_field_overflow(&hello) {
        tracing::warn!(field, max, "agent hello field too long，关闭连接（未查库）");
        reject(&mut socket, "invalid hello", close_code::POLICY).await;
        return;
    }

    // 心跳会带上 agent 版本一起落库，后续重连以最新 hello 为准。
    let agent_version = hello.agent_version.clone();
    // T2：先做 token 校验。合法 token 不受 IP 锁影响；只有失败的认证尝试
    // 才吃限流。先取「本次之前」的锁定状态，已锁定就不再继续累加。
    let existing_lock = ip_key
        .as_ref()
        .and_then(|key| state.ip_throttle.check(*key).err());
    let mut server = match repo::servers::find_by_token(&state.db.pool, &hello.token).await {
        Ok(Some(server)) => {
            // 认证成功清零该 IP 的失败计数。
            if let Some(key) = ip_key.as_ref() {
                state.ip_throttle.clear(*key);
            }
            server
        }
        Ok(None) => {
            // 只有「token 不存在」才算认证失败；数据库抖动不能把 Agent 的 IP 拉黑。
            if let Some(retry_after) = existing_lock {
                tracing::warn!(retry_after, "agent hello rejected: too many auth failures");
                reject(&mut socket, "too many auth failures", close_code::POLICY).await;
                return;
            }
            if let Some(key) = ip_key.as_ref() {
                state.ip_throttle.record_failure(*key);
            }
            tracing::warn!(hostname = %hello.hostname, "agent auth failed");
            reject(&mut socket, "invalid token", close_code::POLICY).await;
            return;
        }
        Err(error) => {
            // 查库失败时无法判断 token 是否有效，按临时故障拒绝（不计数）。
            tracing::error!(error = %error, "agent token lookup failed");
            reject(&mut socket, "temporary auth error", close_code::ERROR).await;
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
    // 渲染失败（网卡未上报等）不主动断开：连接仍可收心跳，等修好后下一次 apply 再补发。
    let _ = send_current_desired(&state, &server, &headers, &mut socket).await;

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
                            "desired state broadcast lagged；主动补发完整期望态"
                        );
                        // 积压期间可能有多次 apply：补发必须重新读库拿最新版本，
                        // 不能把连接建立时的旧快照再发一遍。
                        if send_current_desired(&state, &server, &headers, &mut socket).await
                            == ResendOutcome::Failed
                        {
                            // 补发失败就无法保证 Agent 收敛：关闭连接，让它重连后拿全量配置。
                            tracing::warn!(
                                server = %server.name,
                                "补发期望态失败，关闭连接等待 Agent 重连"
                            );
                            close_socket(&mut socket, close_code::AWAY).await;
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        // 同一服务器被新连接替换时旧通道会关闭；此时继续读上报即可，
                        // 真正的退出由下面的断开信号负责。
                        hub_open = false;
                        tracing::warn!(server = %server.name, "agent hub channel closed");
                    }
                }
            }
            // 新连接顶替 / 重置 token / 删除服务器：主动 Close 并退出。
            _ = subscription.disconnect.changed() => {
                tracing::info!(
                    server = %server.name,
                    "agent connection revoked; closing"
                );
                close_socket(&mut socket, close_code::AWAY).await;
                break;
            }
        }
    }

    // 只有当前登记的还是这条连接时，断开才代表「这台服务器离线」。
    // 被新连接顶替的旧连接如果也标离线，会把刚上线的新连接状态覆盖掉。
    let current = state.hub.is_current(&server.id, &subscription.sender);
    drop(subscription);

    if !current {
        tracing::info!(
            server = %server.name,
            "stale agent connection closed; skip offline marking"
        );
        return;
    }

    if let Err(e) = repo::servers::mark_offline(&state.db.pool, &server.id).await {
        tracing::error!(error = %e, "mark_offline failed");
    }
    tracing::info!(server = %server.name, "agent disconnected");
    // 删除服务器会先删行、再断开旧连接：此时「离线」已经无从谈起，
    // 用户刚删掉机器却收到一条离线告警只会是噪音。行仍在（改 token、断网、
    // 正常关闭）才告警；查库失败时保守地保留告警，不能因为一次查询失败
    // 把真实的离线事件吞掉。
    let row_exists = match repo::servers::exists(&state.db.pool, &server.id).await {
        Ok(exists) => exists,
        Err(error) => {
            tracing::error!(
                server = %server.name,
                %error,
                "检查服务器是否仍存在失败，按仍存在处理（照常发离线告警）"
            );
            true
        }
    };
    if !row_exists {
        tracing::info!(
            server = %server.name,
            "服务器行已被删除，跳过离线告警"
        );
        return;
    }
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

/// 一次补发的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResendOutcome {
    /// 已下发完整期望态。
    Sent,
    /// 服务器还没有任何配置版本（从未 apply），没有可补发的内容。
    NothingToSend,
    /// 渲染或发送失败；调用方决定是否断开连接。
    Failed,
}

/// 补发当前完整期望态：重连补偿与广播积压（`Lagged`）恢复共用。
///
/// 每次都重新读库：连接建立时的快照可能已经过期（积压期间 apply 会推进
/// `config_version`），补发旧快照会让 Agent 长期停在旧配置。
async fn send_current_desired(
    state: &AppState,
    server: &Server,
    headers: &HeaderMap,
    socket: &mut WebSocket,
) -> ResendOutcome {
    let server = match repo::servers::find_by_id(&state.db.pool, &server.id).await {
        Ok(server) => server,
        Err(error) => {
            tracing::error!(
                server_id = %server.id,
                error = %error,
                "读取服务器失败，无法补发期望态"
            );
            return ResendOutcome::Failed;
        }
    };
    if server.config_version <= 0 {
        return ResendOutcome::NothingToSend;
    }

    // 每次补发都重新解析对外地址：管理员改完设置后，已连接的 Agent 下一次补发
    // 也会用新值，不把地址缓存到进程或连接上。连接已经建立，不能在这里回 400；
    // 非法 Host 回退到默认对外地址并记日志，避免把客户端可控字符串拼进升级下载地址。
    let base_url = match public_url::resolve_checked(state, headers, PublicBaseKind::Agent).await {
        Ok(base) => base,
        Err(error) => {
            tracing::warn!(%error, "非法 Host，期望态回退到默认对外地址");
            super::desired::default_base_url()
        }
    };
    let rendered = match super::desired::render(state, &server, &base_url).await {
        Ok(rendered) => rendered,
        Err(error) => {
            // 网卡未上报/无可用地址等阻断原因会走到这里。
            tracing::error!(server = %server.name, error = %error, "render desired state for resync failed");
            return ResendOutcome::Failed;
        }
    };

    let desired = MasterMessage::Desired(DesiredState {
        version: server.config_version,
        xray: rendered.xray,
        files: rendered.files,
        agent_upgrade: rendered.agent_upgrade,
        forwards: rendered.forwards,
        nodes: rendered.nodes,
    });
    if !send_json(socket, &desired).await {
        tracing::warn!(server = %server.name, "发送期望态失败，连接已不可用");
        return ResendOutcome::Failed;
    }
    tracing::info!(
        server = %server.name,
        version = server.config_version,
        "resynced desired state"
    );
    ResendOutcome::Sent
}

/// Hello 字段长度（字节）超限时返回 `(字段名, 上限)`。
///
/// 只返回字段名与上限，不返回字段值：调用方据此拒绝，日志里也不会出现 token。
fn hello_field_overflow(hello: &AgentHello) -> Option<(&'static str, usize)> {
    [
        ("token", hello.token.len(), AGENT_TOKEN_MAX_LEN),
        ("hostname", hello.hostname.len(), AGENT_HOSTNAME_MAX_LEN),
        (
            "agent_version",
            hello.agent_version.len(),
            AGENT_VERSION_MAX_LEN,
        ),
    ]
    .into_iter()
    .find(|(_, len, max)| len > max)
    .map(|(field, _, max)| (field, max))
}

/// 回一条 Error 后尽力关闭；对端已断开时忽略发送错误。
async fn reject(socket: &mut WebSocket, message: &str, code: u16) {
    let err = MasterMessage::Error {
        message: message.into(),
    };
    if let Ok(payload) = serde_json::to_string(&err) {
        let _ = socket.send(Message::Text(payload.into())).await;
    }
    close_socket(socket, code).await;
}

async fn close_socket(socket: &mut WebSocket, code: u16) {
    let frame = CloseFrame {
        code,
        reason: "agent connection closed".into(),
    };
    let _ = socket.send(Message::Close(Some(frame))).await;
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
            // 先序列化网卡列表再逐个 move hb 的字段，避免部分移动。
            let interfaces_json = crate::nic::encode_interfaces(&hb.interfaces);
            let health = repo::servers::HealthSnapshot {
                arch: hb.arch,
                // 0 = 旧 Agent 未上报；仓储只在 > 0 时覆盖已有值。
                protocol_version: Some(i64::from(hb.protocol_version)),
                os_name: hb.os_name,
                os_version: hb.os_version,
                virt: hb.virt,
                realm_available: hb.realm_available,
                realm_transport: hb.realm_transport,
                nftables_available: hb.nftables_available,
                tunnel_available: hb.tunnel_available,
                xray_running: hb.xray_running,
                nginx_running: hb.nginx_running,
                load1: hb.load1 as f64,
                // u64 → i64 必须饱和：`as i64` 会把 u64::MAX 变成 -1，前端会展示
                // 负的内存/磁盘用量，计费边界也会跟着错。
                mem_used: saturating_i64(hb.mem_used),
                mem_total: saturating_i64(hb.mem_total),
                disk_used: saturating_i64(hb.disk_used),
                disk_total: saturating_i64(hb.disk_total),
                uptime_secs: saturating_i64(hb.uptime_secs),
                latency_ms: hb.latency_ms.map(i64::from),
                interfaces_json,
                interfaces_reported: hb.interfaces_reported,
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
            // 网卡累计计数 → 当前速率。三个字段缺一不可：没有 net_at 就没有
            // 分母，宁可保持「无数据」也不猜。旧 Agent 没有这些字段 → 整段跳过。
            if let (Some(rx), Some(tx), Some(at)) = (hb.net_rx_bytes, hb.net_tx_bytes, hb.net_at) {
                if let Err(e) =
                    repo::servers::update_net_counters(&state.db.pool, server_id, rx, tx, at).await
                {
                    // 只影响展示，不能把心跳判成失败。
                    tracing::warn!(error = %e, "网卡速率写入失败（不影响心跳）");
                }
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
                    target_error: status.target_error.clone(),
                    // 旧 Agent 没有 targets：空数组 → 落 NULL → 链路延迟保持 null。
                    targets: status
                        .targets
                        .iter()
                        .map(|probe| repo::forwards::NewTargetProbe {
                            server_id: probe.server_id.clone(),
                            ok: probe.ok,
                            latency_ms: probe.latency_ms,
                        })
                        .collect(),
                    // 旧 Agent 没有流量字段 → None → 链路视图 null，不能当 0。
                    traffic_in: status.traffic_in,
                    traffic_out: status.traffic_out,
                    // 旧 Agent 没有探测计数 → None：可用率显示 `—`，不是 0%。
                    probe_attempts: status.probe_attempts,
                    probe_failures: status.probe_failures,
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
                // 可用率口径的降级：最近窗口的探测失败率连续 N 次低于阈值。
                // 与上面的「目标连续不可达」是两条独立判定，共用
                // `chain_degraded` 事件类型（需求明确不新增事件类型）。
                super::chains::evaluate_availability_alerts_for_server(state, server_id).await;
            }
            settle_agent_upgrade(state, server_id, version, time::now()).await;
            tracing::debug!(seq = hb.seq, xray = hb.xray_running, "heartbeat");
        }
        Ok(AgentMessage::ApplyResult(result)) => {
            // `error` 只有文本：先按稳定标记解析成结构化结论，再落库。
            // 非 partial 的错误原样保留，展示层直接显示原文。
            let report =
                ApplyReport::from_result(result.version, result.ok, result.error.as_deref());
            match report.status {
                ApplyStatus::Ok => {
                    tracing::info!(version = report.version, "agent applied desired state")
                }
                ApplyStatus::Partial => {
                    let partial = report.partial.as_ref();
                    tracing::warn!(
                        version = report.version,
                        stage = partial.map(|p| p.stage.as_str()).unwrap_or_default(),
                        effective = partial.map(|p| p.effective_count()).unwrap_or(0),
                        total = partial.map(|p| p.total).unwrap_or(0),
                        "agent partially applied desired state"
                    )
                }
                ApplyStatus::Failed => tracing::error!(
                    version = report.version,
                    error = report.error.as_deref().unwrap_or_default(),
                    "agent failed to apply"
                ),
            }
            if let Err(e) =
                repo::servers::save_apply_report(&state.db.pool, server_id, &report).await
            {
                tracing::error!(server_id, error = %e, "apply result write failed");
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
    // 计费入账是概览流量数字的唯一来源：主动清一次短缓存。即使这里漏掉，
    // 日汇总触发器也会递增 generation，让下一次请求按新代际重建。
    state.overview_traffic.clear();
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
                subscription_template_id: None,
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
                subscription_template_id: None,

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

    /// 心跳里的 `realm_available` 必须落库；旧 Agent 的 JSON 没有该字段时
    /// 必须写 NULL（未知），不能默认成 false。
    #[tokio::test]
    async fn heartbeat_realm_availability_is_persisted() {
        let fixture = fixture().await;
        let (server, _) =
            repo::servers::create(&fixture.state.db.pool, "hk-1", "1.2.3.4", "external")
                .await
                .unwrap();

        let send = |seq: u64, realm_available: Option<bool>| {
            let mut heartbeat = serde_json::json!({
                "type": "heartbeat",
                "seq": seq,
                "agent_version": "0.8.0",
                "uptime_secs": 1,
                "load1": 0.0,
                "mem_used": 0,
                "mem_total": 0,
                "disk_used": 0,
                "disk_total": 0,
                "xray_running": true,
                "nginx_running": true,
            });
            // None 模拟旧 Agent：字段整个缺失，而不是显式 null。
            if let Some(value) = realm_available {
                heartbeat["realm_available"] = serde_json::json!(value);
            }
            let text = heartbeat.to_string();
            let state = fixture.state.clone();
            let server_id = server.id.clone();
            async move {
                handle_agent_message(&state, &server_id, "0.8.0", &text).await;
            }
        };

        send(1, None).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.realm_available, None, "旧 Agent 未上报时必须是 NULL");

        send(2, Some(true)).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.realm_available, Some(true));

        send(3, Some(false)).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.realm_available, Some(false));
    }

    /// 心跳里的 `realm_transport` 必须落库：NULL = 未知（按不支持处理），
    /// 1/0 = 明确支持/不支持。主控的下发能力门禁读的就是这一列。
    #[tokio::test]
    async fn heartbeat_realm_transport_is_persisted() {
        let fixture = fixture().await;
        let (server, _) =
            repo::servers::create(&fixture.state.db.pool, "hk-1", "1.2.3.4", "external")
                .await
                .unwrap();

        let send = |seq: u64, realm_transport: Option<bool>| {
            let mut heartbeat = serde_json::json!({
                "type": "heartbeat",
                "seq": seq,
                "agent_version": "0.8.0",
                "uptime_secs": 1,
                "load1": 0.0,
                "mem_used": 0,
                "mem_total": 0,
                "disk_used": 0,
                "disk_total": 0,
                "xray_running": true,
                "nginx_running": true,
            });
            // None 模拟旧 Agent：字段整个缺失，不能写成 false。
            if let Some(value) = realm_transport {
                heartbeat["realm_transport"] = serde_json::json!(value);
            }
            let text = heartbeat.to_string();
            let state = fixture.state.clone();
            let server_id = server.id.clone();
            async move {
                handle_agent_message(&state, &server_id, "0.8.0", &text).await;
            }
        };

        send(1, None).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.realm_transport, None, "旧 Agent 未上报时必须是 NULL");

        send(2, Some(true)).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.realm_transport, Some(true));

        send(3, Some(false)).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.realm_transport, Some(false));

        // 旧 Agent 重连后上报缺失字段：必须清回 NULL，不能沿用上一轮的 true。
        send(4, None).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(
            row.realm_transport, None,
            "旧 Agent 重连必须把旧能力清成未知，能力门禁才会挡住 TLS"
        );
    }

    /// 心跳里的 `nftables_available` 必须落库：旧 Agent 缺失为 NULL，明确值原样保存。
    #[tokio::test]
    async fn heartbeat_nftables_available_is_persisted() {
        let fixture = fixture().await;
        let (server, _) =
            repo::servers::create(&fixture.state.db.pool, "hk-1", "1.2.3.4", "external")
                .await
                .unwrap();

        let send = |seq: u64, nftables_available: Option<bool>| {
            let mut heartbeat = serde_json::json!({
                "type": "heartbeat",
                "seq": seq,
                "agent_version": "0.8.0",
                "uptime_secs": 1,
                "load1": 0.0,
                "mem_used": 0,
                "mem_total": 0,
                "disk_used": 0,
                "disk_total": 0,
                "xray_running": true,
                "nginx_running": true,
            });
            if let Some(value) = nftables_available {
                heartbeat["nftables_available"] = serde_json::json!(value);
            }
            let text = heartbeat.to_string();
            let state = fixture.state.clone();
            let server_id = server.id.clone();
            async move {
                handle_agent_message(&state, &server_id, "0.8.0", &text).await;
            }
        };

        send(1, None).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.nftables_available, None, "旧 Agent 未上报时必须是 NULL");

        send(2, Some(true)).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.nftables_available, Some(true));

        send(3, Some(false)).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.nftables_available, Some(false));

        send(4, None).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(
            row.nftables_available, None,
            "旧 Agent 重连必须把能力清成未知，写路径才会拒绝 nftables"
        );
    }

    /// 心跳里的 `tunnel_available` 必须落库：旧 Agent 缺失为 NULL，
    /// 明确 true/false 原样保存。保存 tunnel 链的门禁读的就是这一列。
    #[tokio::test]
    async fn heartbeat_tunnel_available_is_persisted() {
        let fixture = fixture().await;
        let (server, _) =
            repo::servers::create(&fixture.state.db.pool, "hk-tunnel", "1.2.3.4", "external")
                .await
                .unwrap();

        let send = |seq: u64, tunnel_available: Option<bool>| {
            let mut heartbeat = serde_json::json!({
                "type": "heartbeat",
                "seq": seq,
                "agent_version": "0.8.0",
                "uptime_secs": 1,
                "load1": 0.0,
                "mem_used": 0,
                "mem_total": 0,
                "disk_used": 0,
                "disk_total": 0,
                "xray_running": true,
                "nginx_running": true,
            });
            if let Some(value) = tunnel_available {
                heartbeat["tunnel_available"] = serde_json::json!(value);
            }
            let text = heartbeat.to_string();
            let state = fixture.state.clone();
            let server_id = server.id.clone();
            async move {
                handle_agent_message(&state, &server_id, "0.8.0", &text).await;
            }
        };

        send(1, None).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.tunnel_available, None, "旧 Agent 未上报时必须是 NULL");

        send(2, Some(true)).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.tunnel_available, Some(true));

        send(3, Some(false)).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.tunnel_available, Some(false));

        send(4, None).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(
            row.tunnel_available, None,
            "旧 Agent 重连必须把能力清成未知，写路径才会拒绝 tunnel"
        );
    }

    /// 心跳里的网卡累计计数 → 当前速率；HTTP 列表必须给出 null 或真实数值。
    #[tokio::test]
    async fn heartbeat_net_counters_become_rate_and_stay_null_without_data() {
        let fixture = fixture().await;
        let (server, _) =
            repo::servers::create(&fixture.state.db.pool, "hk-net", "1.2.3.4", "external")
                .await
                .unwrap();

        let send = |seq: u64, rx: Option<u64>, tx: Option<u64>, at: Option<i64>| {
            let mut heartbeat = serde_json::json!({
                "type": "heartbeat",
                "seq": seq,
                "agent_version": "0.13.2",
                "uptime_secs": 1,
                "load1": 0.0,
                "mem_used": 0,
                "mem_total": 0,
                "disk_used": 0,
                "disk_total": 0,
                "xray_running": true,
                "nginx_running": true,
            });
            if let Some(rx) = rx {
                heartbeat["net_rx_bytes"] = serde_json::json!(rx);
            }
            if let Some(tx) = tx {
                heartbeat["net_tx_bytes"] = serde_json::json!(tx);
            }
            if let Some(at) = at {
                heartbeat["net_at"] = serde_json::json!(at);
            }
            let text = heartbeat.to_string();
            let state = fixture.state.clone();
            let server_id = server.id.clone();
            async move {
                handle_agent_message(&state, &server_id, "0.13.2", &text).await;
            }
        };

        // 旧 Agent：没有三个字段 → 列表必须是 null（前端显示 —，不是 0）。
        send(1, None, None, None).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.net_rx_bps, None);
        assert_eq!(row.net_tx_bps, None);

        // 首次上报：只建立基线。
        send(2, Some(1_000), Some(2_000), Some(1_000)).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.net_rx_bps, None, "第一次心跳没有基线");

        // 60 秒后：+12.3 MB / +1.2 MB → 205000 / 20000 B/s。
        send(
            3,
            Some(1_000 + 12_300_000),
            Some(2_000 + 1_200_000),
            Some(1_060),
        )
        .await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert!((row.net_rx_bps.unwrap() - 205_000.0).abs() < 1e-6);
        assert!((row.net_tx_bps.unwrap() - 20_000.0).abs() < 1e-6);

        // 时间差 0：丢弃，不能除零。
        send(
            4,
            Some(1_000 + 12_400_000),
            Some(2_000 + 1_200_000),
            Some(1_060),
        )
        .await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.net_rx_bps, None, "时间差为 0 必须清空而不是除零");

        // 计数回绕：丢弃该次差值，不能写负数 / 异常峰值。
        send(5, Some(500), Some(400), Some(1_120)).await;
        let row = repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(row.net_rx_bps, None);
        assert_eq!(row.net_tx_bps, None);
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
                count_traffic: false,
                engine: "native".into(),
                protocol: "tcp".into(),
                proxy_protocol: false,
            },
        )
        .await
        .unwrap();

        let heartbeat =
            |seq: u64, forwards: Vec<pierwave_proto::ForwardStatus>| pierwave_proto::Heartbeat {
                seq,
                protocol_version: pierwave_proto::PROTOCOL_VERSION,
                agent_version: "0.5.7".into(),
                arch: "x86_64".into(),
                os_name: None,
                os_version: None,
                virt: None,
                realm_available: None,
                realm_transport: None,
                nftables_available: None,
                tunnel_available: None,
                forwards,
                latency_ms: None,
                interfaces: Vec::new(),
                interfaces_reported: false,
                net_rx_bytes: None,
                net_tx_bytes: None,
                net_at: None,
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
                target_error: Some("cert_expired".into()),
                targets: vec![
                    pierwave_proto::TargetProbe {
                        server_id: "srv-next".into(),
                        ok: true,
                        latency_ms: Some(17),
                    },
                    pierwave_proto::TargetProbe {
                        server_id: "srv-down".into(),
                        ok: false,
                        latency_ms: None,
                    },
                ],
                traffic_in: Some(4096),
                traffic_out: Some(8192),
                probe_attempts: None,
                probe_failures: None,
            }],
        )
        .await;
        // 心跳里的协议版本必须落库，仅 UDP 门禁才能拿到真实能力。
        assert_eq!(
            repo::servers::find_by_id(&fixture.state.db.pool, &server.id)
                .await
                .unwrap()
                .protocol_version,
            Some(pierwave_proto::PROTOCOL_VERSION as i64)
        );
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
        assert_eq!(
            runtime.target_error.as_deref(),
            Some("cert_expired"),
            "target_error 必须原样落入 forward_status（不做翻译）"
        );
        assert!(!runtime.degraded);

        // 逐目标 RTT 必须原样落库，供 /api/v1/chains 计算跳间延迟。
        let rows = repo::forwards::list_status_by_server(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        let raw = rows[0].targets_json.as_deref().expect("targets 必须落库");
        let probes: Vec<pierwave_proto::TargetProbe> = serde_json::from_str(raw).unwrap();
        assert_eq!(probes.len(), 2);
        assert_eq!(probes[0].server_id, "srv-next");
        assert_eq!(probes[0].latency_ms, Some(17));
        assert!(!probes[1].ok);
        assert_eq!(probes[1].latency_ms, None, "失败目标不能写成 0ms");

        // 流量原样落库；None 保持 NULL（realm / 旧 Agent），不能变成 0。
        assert_eq!(rows[0].traffic_in, Some(4096));
        assert_eq!(rows[0].traffic_out, Some(8192));

        // 只有成功探测写延迟样本；失败目标不能留下 0ms 的脏点。
        let samples = repo::latency::list_for_forwards(
            &fixture.state.db.pool,
            std::slice::from_ref(&forward.id),
            0,
        )
        .await
        .unwrap();
        assert_eq!(samples.len(), 1, "一次心跳每个成功目标一条样本");
        assert_eq!(samples[0].target_server_id, "srv-next");
        assert_eq!(samples[0].latency_ms, 17);

        send(
            2,
            vec![pierwave_proto::ForwardStatus {
                id: forward.id.clone(),
                listening: false,
                error: "端口已被占用".into(),
                target_ok: Some(false),
                target_error: None,
                targets: Vec::new(),
                traffic_in: None,
                traffic_out: None,
                probe_attempts: None,
                probe_failures: None,
            }],
        )
        .await;
        let views = repo::forwards::list_with_status(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        let rows = repo::forwards::list_status_by_server(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert!(
            rows[0].targets_json.is_none(),
            "空 targets 必须落 NULL（未探测），不能保留上一轮"
        );
        let runtime = views[0].runtime.as_ref().unwrap();
        assert!(!runtime.listening);
        assert_eq!(runtime.error, "端口已被占用");
        assert_eq!(runtime.target_ok, Some(false));
        assert_eq!(
            runtime.target_error, None,
            "新一轮没有原因时必须覆盖成 NULL，不能残留上一轮"
        );
        assert!(!runtime.degraded, "只失败一次不能判降级");

        // 空心跳清掉缓存：规则还在，但运行状态未知。
        send(3, Vec::new()).await;
        let views = repo::forwards::list_with_status(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(views.len(), 1);
        assert!(views[0].runtime.is_none(), "空心跳必须清掉旧运行状态");
    }

    /// 旧 Agent 的心跳 JSON 没有 target_error：必须落 NULL（未知），
    /// 而不是空串或反序列化失败。旧 Agent 与不解密链路的规则都应保持 NULL。
    #[tokio::test]
    async fn heartbeat_without_target_error_persists_null() {
        let fixture = fixture().await;
        let (server, _) =
            repo::servers::create(&fixture.state.db.pool, "hk-1", "1.2.3.4", "external")
                .await
                .unwrap();

        let heartbeat = serde_json::json!({
            "type": "heartbeat",
            "seq": 1,
            "agent_version": "0.8.0",
            "arch": "x86_64",
            "forwards": [{
                "id": "fwd-old",
                "listening": true,
                "error": "",
                "target_ok": true,
            }],
            "uptime_secs": 1,
            "load1": 0.0,
            "mem_used": 0,
            "mem_total": 0,
            "disk_used": 0,
            "disk_total": 0,
            "xray_running": true,
            "nginx_running": true,
        })
        .to_string();

        handle_agent_message(&fixture.state, &server.id, "0.8.0", &heartbeat).await;

        let rows = repo::forwards::list_status_by_server(&fixture.state.db.pool, &server.id)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target_ok, Some(true));
        assert_eq!(
            rows[0].target_error, None,
            "旧心跳没有 target_error 时必须落 NULL，不能落空串"
        );
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
                engine: "native".into(),
                protocol: "tcp".into(),
                transport: "none".into(),
                tunnel_security: "tls".into(),
                groups: vec![repo::chains::NewChainGroup {
                    name: None,
                    strategy: "round_robin".into(),
                    cert_id: None,
                    public_port: None,
                    use_internal_address: false,
                    members: vec![repo::chains::NewChainGroupMember {
                        server_id: server.id.clone(),
                        listen_port: 8443,
                        priority: 0,
                        weight: 1,
                    }],
                }],
                proxy_protocol: false,
            },
        )
        .await
        .unwrap();
        let forward_id = pierwave_domain::chains::legacy_forward_id(&chain.chain.id, 0);

        let send = |seq: u64, target_ok: bool| {
            let heartbeat = pierwave_proto::Heartbeat {
                seq,
                protocol_version: pierwave_proto::PROTOCOL_VERSION,
                agent_version: "0.5.7".into(),
                arch: "x86_64".into(),
                os_name: None,
                os_version: None,
                virt: None,
                realm_available: None,
                realm_transport: None,
                nftables_available: None,
                tunnel_available: None,
                forwards: vec![pierwave_proto::ForwardStatus {
                    id: forward_id.clone(),
                    listening: true,
                    error: String::new(),
                    target_ok: Some(target_ok),
                    target_error: None,
                    targets: Vec::new(),
                    traffic_in: None,
                    traffic_out: None,
                    probe_attempts: None,
                    probe_failures: None,
                }],
                latency_ms: None,
                interfaces: Vec::new(),
                interfaces_reported: false,
                net_rx_bytes: None,
                net_tx_bytes: None,
                net_at: None,
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

    /// 可用率告警：最近 15 分钟探测失败率连续 N 次低于阈值才发一次，
    /// 恢复后重新武装；不新增事件类型（复用 chain_degraded）。
    #[tokio::test]
    async fn chain_availability_alert_requires_streak_and_rearms() {
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
        // 去重交给「连续 N 次 + 已告警」状态机，不靠冷却窗口。
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
                engine: "native".into(),
                protocol: "tcp".into(),
                transport: "none".into(),
                tunnel_security: "tls".into(),
                groups: vec![repo::chains::NewChainGroup {
                    name: None,
                    strategy: "round_robin".into(),
                    cert_id: None,
                    public_port: None,
                    use_internal_address: false,
                    members: vec![repo::chains::NewChainGroupMember {
                        server_id: server.id.clone(),
                        listen_port: 8443,
                        priority: 0,
                        weight: 1,
                    }],
                }],
                proxy_protocol: false,
            },
        )
        .await
        .unwrap();
        let forward_id = pierwave_domain::chains::forward_id(&chain.chain.id, 0, &server.id, 1);

        // 最近窗口 95% 可用（100 次探测 5 次失败）→ 低于默认 99%。
        repo::chain_probe::record_sample(
            &fixture.state.db.pool,
            repo::now() - 60,
            &server.id,
            &forward_id,
            100,
            5,
        )
        .await
        .unwrap();

        let evaluate = || {
            let state = fixture.state.clone();
            let server_id = server.id.clone();
            async move {
                crate::routes::chains::evaluate_availability_alerts_for_server(&state, &server_id)
                    .await;
            }
        };

        // 第 1、2 次：连续次数不够，不发。
        evaluate().await;
        evaluate().await;
        transport
            .assert_no_more(0, std::time::Duration::from_millis(100))
            .await;

        // 第 3 次：触发一次 chain_degraded。
        evaluate().await;
        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "chain_degraded");
        assert_eq!(sent[0].target, chain.chain.id);
        assert!(
            sent[0].body.contains("可用率") && sent[0].body.contains("探测失败率近似"),
            "告警正文必须写清口径：{}",
            sent[0].body
        );

        // 仍然不健康：同一轮故障不能刷屏。
        evaluate().await;
        transport
            .assert_no_more(1, std::time::Duration::from_millis(100))
            .await;

        // 恢复（大量成功探测把窗口拉回 99% 以上）→ 状态清零、重新武装。
        repo::chain_probe::record_sample(
            &fixture.state.db.pool,
            repo::now() - 30,
            &server.id,
            &forward_id,
            5_000,
            0,
        )
        .await
        .unwrap();
        evaluate().await;
        transport
            .assert_no_more(1, std::time::Duration::from_millis(100))
            .await;

        // 新的故障：窗口 6100 次 105 次失败（98.3%）→ 再连续 3 次后重新告警。
        repo::chain_probe::record_sample(
            &fixture.state.db.pool,
            repo::now() - 20,
            &server.id,
            &forward_id,
            1_000,
            100,
        )
        .await
        .unwrap();
        evaluate().await;
        evaluate().await;
        transport
            .assert_no_more(1, std::time::Duration::from_millis(100))
            .await;
        evaluate().await;
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
                public_port: None,
                config_json: json!({
                    "settings": {"clients": [], "decryption": "none"},
                    "stream": {"network": "tcp", "security": "none"}
                })
                .to_string(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
                tags: Vec::new(),
                region: None,
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
                subscription_template_id: None,
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
                subscription_template_id: None,

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
                subscription_template_id: None,
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
                subscription_template_id: None,

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
                subscription_template_id: None,

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
            crate::auth::CurrentUser(admin, None),
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
            crate::auth::CurrentUser(admin, None),
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

/// Agent `ApplyResult` 的落库行为：partial 结构化保存，其它错误原文保存。
#[cfg(test)]
mod apply_result_tests {
    use super::*;

    use pierwave_domain::apply::PartialApply;
    use pierwave_domain::Db;

    const PARTIAL: &str = concat!(
        "[agent.apply_files.partial] 受管文件部分生效（partial success），",
        "阶段: 提交 rename / commit；",
        "已生效 2/3: /etc/pierwave/xray/server.crt, /etc/pierwave/xray/server.key；",
        "其余文件未生效、临时文件已清理；",
        "失败原因: 替换文件失败（/etc/pierwave/xray/ca.pem）: Is a directory"
    );

    const WRITE_FAILED: &str = concat!(
        "[agent.apply_files.write_failed] 受管文件应用失败（managed files apply failed），",
        "阶段: 写临时文件 / write-temp；没有任何文件生效（no managed file was changed）；",
        "失败原因: 创建目录失败: /etc/pierwave/xray"
    );

    async fn fixture() -> (AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let (server, _token) = repo::servers::create(&state.db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        (state, server.id)
    }

    fn apply_result(version: i64, ok: bool, error: Option<&str>) -> String {
        serde_json::json!({
            "type": "apply_result",
            "version": version,
            "ok": ok,
            "error": error,
        })
        .to_string()
    }

    /// 部分成功必须落成结构化字段：状态、原文、阶段、已生效路径、总数，
    /// 并且服务器 JSON 里是对象而不是一段需要前端再解析的字符串。
    #[tokio::test]
    async fn partial_result_is_persisted_and_serialized_as_structure() {
        let (state, server_id) = fixture().await;
        handle_agent_message(
            &state,
            &server_id,
            "0.9.5",
            &apply_result(7, false, Some(PARTIAL)),
        )
        .await;

        let row = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(row.apply_status.as_deref(), Some("partial"));
        assert_eq!(row.apply_error.as_deref(), Some(PARTIAL), "原文必须保留");
        assert_eq!(row.apply_version, Some(7));
        assert!(row.apply_at.is_some(), "必须记录收到时间");

        let partial: PartialApply =
            serde_json::from_str(row.apply_partial_json.as_deref().unwrap()).unwrap();
        assert_eq!(partial.stage, "提交 rename / commit");
        assert_eq!(partial.effective_count(), 2);
        assert_eq!(partial.total, 3);
        assert_eq!(
            partial.effective,
            vec![
                "/etc/pierwave/xray/server.crt".to_string(),
                "/etc/pierwave/xray/server.key".to_string()
            ]
        );

        // 管理端服务器 JSON：结构化对象 + 派生计数。
        let value = serde_json::to_value(&row).unwrap();
        assert_eq!(value["apply_status"], "partial");
        assert_eq!(value["apply_partial"]["effective_count"], 2);
        assert_eq!(value["apply_partial"]["total"], 3);
        assert_eq!(value["apply_partial"]["stage"], "提交 rename / commit");
        assert_eq!(
            value["apply_partial"]["effective"][0],
            "/etc/pierwave/xray/server.crt"
        );
    }

    /// 非 partial 错误不能被误判：状态 failed、partial 为空、错误一字不改。
    #[tokio::test]
    async fn non_partial_error_is_persisted_verbatim() {
        let (state, server_id) = fixture().await;
        handle_agent_message(
            &state,
            &server_id,
            "0.9.5",
            &apply_result(8, false, Some(WRITE_FAILED)),
        )
        .await;

        let row = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(row.apply_status.as_deref(), Some("failed"));
        assert_eq!(row.apply_error.as_deref(), Some(WRITE_FAILED));
        assert_eq!(row.apply_partial_json, None);
        let value = serde_json::to_value(&row).unwrap();
        assert_eq!(value["apply_partial"], serde_json::Value::Null);
    }

    /// 成功结果清空上一条错误：展示的是「最近一次结果」，不是历史。
    #[tokio::test]
    async fn success_clears_previous_failure() {
        let (state, server_id) = fixture().await;
        handle_agent_message(
            &state,
            &server_id,
            "0.9.5",
            &apply_result(7, false, Some(PARTIAL)),
        )
        .await;
        handle_agent_message(&state, &server_id, "0.9.5", &apply_result(8, true, None)).await;

        let row = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(row.apply_status.as_deref(), Some("ok"));
        assert_eq!(row.apply_error, None, "成功后不能残留上一条错误");
        assert_eq!(row.apply_partial_json, None);
        assert_eq!(row.apply_version, Some(8));
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

    /// 心跳里的网卡列表：新 Agent 落库并记录上报时间，服务器 JSON 里可见；
    /// 旧 Agent（没有新字段）不覆盖最近一次上报，行为与升级前一致。
    #[tokio::test]
    async fn heartbeat_interfaces_are_persisted_and_serialized() {
        let (state, server_id) = fixture().await;

        let send = |interfaces: Option<serde_json::Value>| {
            let mut heartbeat = serde_json::json!({
                "type": "heartbeat",
                "seq": 1,
                "agent_version": "0.9.5",
                "uptime_secs": 1,
                "load1": 0.0,
                "mem_used": 0,
                "mem_total": 0,
                "disk_used": 0,
                "disk_total": 0,
                "xray_running": true,
                "nginx_running": true,
            });
            // None 模拟旧 Agent：两个字段整个缺失。
            if let Some(interfaces) = interfaces {
                heartbeat["interfaces"] = interfaces;
                heartbeat["interfaces_reported"] = serde_json::json!(true);
            }
            let text = heartbeat.to_string();
            let state = state.clone();
            let server_id = server_id.clone();
            async move {
                handle_agent_message(&state, &server_id, "0.9.5", &text).await;
            }
        };

        send(Some(serde_json::json!([
            {"name": "eth0", "addresses": ["10.0.0.2", "2001:db8::2"]},
            {"name": "eth1", "addresses": []}
        ])))
        .await;
        let row = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(row.nic_name, None, "心跳不能自己启用网卡限制");
        assert!(
            row.interfaces_reported_at.is_some(),
            "新版 Agent 上报后必须记录时间戳"
        );
        let value = serde_json::to_value(&row).unwrap();
        assert_eq!(value["interfaces"][0]["name"], "eth0");
        assert_eq!(value["interfaces"][0]["addresses"][0], "10.0.0.2");
        assert_eq!(value["interfaces"][1]["name"], "eth1");

        // 旧 Agent 的心跳不带新字段：不能清掉最近一次上报（行为与升级前一致）。
        send(None).await;
        let row = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(
            row.interfaces_json,
            "[{\"name\":\"eth0\",\"addresses\":[\"10.0.0.2\",\"2001:db8::2\"]},{\"name\":\"eth1\",\"addresses\":[]}]"
        );
        assert!(row.interfaces_reported_at.is_some());
    }
}

/// 真实 WebSocket 集成测试：首帧超时、帧大小限制、断开语义。
///
/// 不 mock socket：用 axum 起一个只挂 `/api/agent/ws` 的本地服务，客户端用
/// `tokio-tungstenite` 真连、真发帧，断言连接层面的行为。
#[cfg(test)]
mod ws_tests {
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use axum::extract::connect_info::ConnectInfo;
    use axum::extract::{Extension, State, WebSocketUpgrade};
    use axum::http::HeaderMap;
    use axum::response::Response;
    use axum::routing::get;
    use axum::Router;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as ClientMessage;
    use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

    use pierwave_domain::repo;
    use pierwave_domain::Db;
    use pierwave_proto::AgentHello;

    use crate::alerts::{Alerts, RecordingTransport};
    use crate::throttle::IP_MAX_FAILURES;

    use super::*;

    type WsClient = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

    struct TestServer {
        addr: SocketAddr,
        task: tokio::task::JoinHandle<()>,
    }

    impl TestServer {
        async fn start(state: AppState, hello_timeout: Duration) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let app = Router::new()
                .route("/api/agent/ws", get(test_ws))
                // 真实服务里由 `into_make_service_with_connect_info` 注入对端地址；
                // 测试显式注入回环地址，保证 IP 限流拿到的是稳定值而不是 "unknown"。
                .layer(Extension(ConnectInfo(SocketAddr::from((
                    [127, 0, 0, 1],
                    0,
                )))))
                .with_state((state, hello_timeout));
            let task = tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            Self { addr, task }
        }

        async fn connect(&self) -> WsClient {
            let url = format!("ws://{}/api/agent/ws", self.addr);
            let (socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
            socket
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn test_ws(
        ws: WebSocketUpgrade,
        headers: HeaderMap,
        peer: Option<Extension<ConnectInfo<SocketAddr>>>,
        State((state, hello_timeout)): State<(AppState, Duration)>,
    ) -> Response {
        let peer = peer.map(|Extension(ConnectInfo(addr))| addr.ip());
        upgrade(ws, state, headers, peer, hello_timeout)
    }

    fn hello_json(token: &str, hostname: &str, agent_version: &str) -> String {
        serde_json::to_string(&AgentMessage::Hello(AgentHello {
            token: token.into(),
            hostname: hostname.into(),
            agent_version: agent_version.into(),
            xray_mode: "external".into(),
            capabilities: Vec::new(),
        }))
        .unwrap()
    }

    async fn next_message(socket: &mut WsClient) -> Option<MasterMessage> {
        loop {
            match socket.next().await {
                Some(Ok(ClientMessage::Text(text))) => {
                    return Some(serde_json::from_str(&text).unwrap());
                }
                Some(Ok(ClientMessage::Ping(_))) | Some(Ok(ClientMessage::Pong(_))) => continue,
                Some(Ok(ClientMessage::Close(_))) | None | Some(Err(_)) => return None,
                Some(Ok(_)) => continue,
            }
        }
    }

    /// 等到对端 Close / EOF；期间忽略数据帧。
    async fn wait_closed(socket: &mut WsClient) {
        let closed = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match socket.next().await {
                    Some(Ok(ClientMessage::Text(_)))
                    | Some(Ok(ClientMessage::Ping(_)))
                    | Some(Ok(ClientMessage::Pong(_))) => continue,
                    Some(Ok(ClientMessage::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(_)) => continue,
                }
            }
        })
        .await;
        assert!(closed.is_ok(), "连接应在 3s 内关闭");
    }

    async fn wait_status(state: &AppState, server_id: &str, expected: &str) {
        for _ in 0..200 {
            if let Ok(row) = repo::servers::find_by_id(&state.db.pool, server_id).await {
                if row.status == expected {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let row = repo::servers::find_by_id(&state.db.pool, server_id)
            .await
            .unwrap();
        panic!("等待服务器状态变为 {expected} 超时，当前 {}", row.status);
    }

    async fn state_with_server() -> (AppState, String, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let (server, token) = repo::servers::create(&db.pool, "hk-1", "1.2.3.4", "external")
            .await
            .unwrap();
        (AppState::new(db, "web/dist"), server.id, token)
    }

    /// 给 state 装上可观测的告警投递器，并启用 offline 事件。
    ///
    /// 返回替换过投递器的 state（`AppState` 里的 `alerts` 是值，不是共享引用，
    /// 必须用返回的副本启动服务，否则告警仍会走默认的无渠道实现）。
    async fn with_offline_alerts(mut state: AppState) -> (AppState, Arc<RecordingTransport>) {
        let transport = Arc::new(RecordingTransport::default());
        state.alerts = Alerts::new(transport.clone());
        repo::settings::set(&state.db.pool, "webhook_url", "https://example.test/hook")
            .await
            .unwrap();
        repo::settings::set(&state.db.pool, "alert_events", "server_offline")
            .await
            .unwrap();
        repo::settings::set(&state.db.pool, "alert_cooldown_secs", "0")
            .await
            .unwrap();
        (state, transport)
    }

    /// 连上但不发 Hello：必须在 hello 超时后关闭，且 1 秒内看到 Close/EOF。
    /// 池已关闭：任何一次查库都会失败并回文本错误，超时路径却不应发出任何文本帧。
    #[tokio::test]
    async fn hello_timeout_closes_connection_without_db_lookup() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        state.db.pool.close().await;

        let server = TestServer::start(state, Duration::from_millis(200)).await;
        let mut socket = server.connect().await;

        let started = Instant::now();
        let outcome = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match socket.next().await {
                    Some(Ok(ClientMessage::Text(text))) => {
                        panic!("首帧超时不应发送任何文本消息：{text}")
                    }
                    Some(Ok(ClientMessage::Ping(_))) | Some(Ok(ClientMessage::Pong(_))) => continue,
                    Some(Ok(ClientMessage::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(_)) => continue,
                }
            }
        })
        .await;

        assert!(outcome.is_ok(), "首帧超时后 1s 内必须收到 Close/EOF");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "关闭耗时 {:?}，超时参数只有 200ms",
            started.elapsed()
        );
    }

    /// 首帧是超大但**结构合法**的 Hello（> 1 MiB）：连接关闭，且不会把服务器
    /// 标成在线。没有帧/消息上限时它会被当作普通 Hello 接受（Ack + mark_online），
    /// 所以这个用例能真实区分上限有没有生效。
    #[tokio::test]
    async fn oversized_hello_is_rejected_without_touching_server_state() {
        let (state, server_id, token) = state_with_server().await;
        let server = TestServer::start(state.clone(), Duration::from_secs(5)).await;
        let mut socket = server.connect().await;

        // 用被忽略的 capabilities 填充：token/hostname/版本都合法，只有体积超限。
        let padding = "y".repeat(AGENT_MAX_MESSAGE);
        let hello = serde_json::json!({
            "type": "hello",
            "token": token,
            "hostname": "hk-1",
            "agent_version": "0.14.2",
            "xray_mode": "external",
            "capabilities": [padding],
        })
        .to_string();
        assert!(
            hello.len() > AGENT_MAX_MESSAGE,
            "测试消息必须真的超过上限：{}",
            hello.len()
        );

        // 客户端默认允许 16 MiB 帧，可以把超限消息真的发出去。
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            socket.send(ClientMessage::Text(hello)),
        )
        .await;

        // 超限时服务端不会把它当 Hello：既不能回 Ack，也不能回业务错误。
        let message = next_message(&mut socket).await;
        assert!(
            message.is_none(),
            "超大 Hello 不应得到任何响应：{message:?}"
        );
        wait_closed(&mut socket).await;

        let row = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(row.status, "offline", "超大帧不能把服务器标成在线");
        assert_eq!(row.agent_version, None, "超大帧不能产生任何落库更新");
        assert!(row.last_seen_at.is_none());
    }

    /// 超长 Hello 字段在查库之前就被拒绝。
    ///
    /// 池先关闭：若代码先查 token，`find_by_token` 会失败并回 `invalid token`；
    /// 只有「先校验长度」的路径才可能回 `invalid hello`。
    #[tokio::test]
    async fn overlong_hello_field_is_rejected_before_db_lookup() {
        let (state, server_id, token) = state_with_server().await;
        state.db.pool.close().await;

        let server = TestServer::start(state.clone(), Duration::from_secs(5)).await;
        let mut socket = server.connect().await;
        let hello = hello_json(&token, &"h".repeat(AGENT_HOSTNAME_MAX_LEN + 1), "0.14.2");
        socket.send(ClientMessage::Text(hello)).await.unwrap();

        let message = next_message(&mut socket).await.expect("必须回一条 Error");
        match message {
            MasterMessage::Error { message } => {
                assert_eq!(
                    message, "invalid hello",
                    "超长字段必须先于查库被拒绝；invalid token 说明已经查过库"
                );
            }
            other => panic!("expected error, got {other:?}"),
        }
        wait_closed(&mut socket).await;

        // 关闭的池不可能写库，这里只是把「没有被标在线」写清楚。
        assert!(
            repo::servers::find_by_id(&state.db.pool, &server_id)
                .await
                .is_err(),
            "池已关闭，不应有写入"
        );
    }

    /// Hello 字段长度上限的边界：等于上限通过，多 1 字节拒绝。
    #[test]
    fn hello_field_limits_are_enforced_at_the_boundary() {
        let hello = |token: usize, hostname: usize, version: usize| AgentHello {
            token: "t".repeat(token),
            hostname: "h".repeat(hostname),
            agent_version: "v".repeat(version),
            xray_mode: "external".into(),
            capabilities: Vec::new(),
        };

        assert_eq!(
            hello_field_overflow(&hello(
                AGENT_TOKEN_MAX_LEN,
                AGENT_HOSTNAME_MAX_LEN,
                AGENT_VERSION_MAX_LEN
            )),
            None
        );
        assert_eq!(
            hello_field_overflow(&hello(AGENT_TOKEN_MAX_LEN + 1, 0, 0)),
            Some(("token", AGENT_TOKEN_MAX_LEN))
        );
        assert_eq!(
            hello_field_overflow(&hello(0, AGENT_HOSTNAME_MAX_LEN + 1, 0)),
            Some(("hostname", AGENT_HOSTNAME_MAX_LEN))
        );
        assert_eq!(
            hello_field_overflow(&hello(0, 0, AGENT_VERSION_MAX_LEN + 1)),
            Some(("agent_version", AGENT_VERSION_MAX_LEN))
        );
    }

    /// 两个真实连接同一 token：新连接顶替旧连接后，旧连接关闭不能把新连接
    /// 标成离线，也不能发 offline 告警。
    #[tokio::test]
    async fn stale_connection_close_does_not_mark_new_online_server_offline() {
        let (state, server_id, token) = state_with_server().await;
        let (state, transport) = with_offline_alerts(state).await;

        let server = TestServer::start(state.clone(), Duration::from_secs(5)).await;

        let mut old = server.connect().await;
        old.send(ClientMessage::Text(hello_json(&token, "hk-old", "0.14.2")))
            .await
            .unwrap();
        assert!(matches!(
            next_message(&mut old).await,
            Some(MasterMessage::Ack(_))
        ));

        let mut new = server.connect().await;
        new.send(ClientMessage::Text(hello_json(&token, "hk-new", "0.14.2")))
            .await
            .unwrap();
        assert!(matches!(
            next_message(&mut new).await,
            Some(MasterMessage::Ack(_))
        ));

        // 旧连接被 hub 主动断开。
        wait_closed(&mut old).await;

        // 新连接才是当前连接：服务器必须仍然在线。
        wait_status(&state, &server_id, "online").await;
        assert_eq!(state.hub.publish(&server_id, MasterMessage::Ping), 1);
        assert!(matches!(
            next_message(&mut new).await,
            Some(MasterMessage::Ping)
        ));

        // 旧连接退出不能触发离线告警。
        transport
            .assert_no_more(0, Duration::from_millis(300))
            .await;

        // 收尾：新连接正常断开 → 标离线 + 一条离线告警。
        new.close(None).await.unwrap();
        wait_status(&state, &server_id, "offline").await;
        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "server_offline");
        assert_eq!(sent[0].target, server_id);
    }

    /// 回归：正常 Hello → Ack；正常断开 → 标离线并发出离线告警。
    #[tokio::test]
    async fn normal_hello_acks_and_normal_close_marks_offline_with_alert() {
        let (state, server_id, token) = state_with_server().await;
        let (state, transport) = with_offline_alerts(state).await;
        let server = TestServer::start(state.clone(), Duration::from_secs(5)).await;

        let mut socket = server.connect().await;
        socket
            .send(ClientMessage::Text(hello_json(&token, "hk-1", "0.14.2")))
            .await
            .unwrap();
        match next_message(&mut socket).await {
            Some(MasterMessage::Ack(ack)) => {
                assert_eq!(ack.server_id, server_id);
                assert_eq!(ack.protocol_version, pierwave_proto::PROTOCOL_VERSION);
            }
            other => panic!("expected ack, got {other:?}"),
        }
        wait_status(&state, &server_id, "online").await;

        socket.close(None).await.unwrap();
        wait_status(&state, &server_id, "offline").await;

        let sent = transport.wait_for(1).await;
        assert_eq!(sent[0].kind, "server_offline");
        assert_eq!(sent[0].target, server_id);
    }

    /// 删除服务器会断开旧连接：这行已经不存在了，不能再发「服务器离线」告警。
    #[tokio::test]
    async fn deleted_server_disconnect_does_not_send_offline_alert() {
        let (state, server_id, token) = state_with_server().await;
        let (state, transport) = with_offline_alerts(state).await;
        let server = TestServer::start(state.clone(), Duration::from_secs(5)).await;

        let mut socket = server.connect().await;
        socket
            .send(ClientMessage::Text(hello_json(&token, "hk-1", "0.14.2")))
            .await
            .unwrap();
        assert!(matches!(
            next_message(&mut socket).await,
            Some(MasterMessage::Ack(_))
        ));
        wait_status(&state, &server_id, "online").await;

        // 与删除路由相同的顺序：先删行，再断开旧连接。
        assert!(repo::servers::delete(&state.db.pool, &server_id)
            .await
            .unwrap());
        state.hub.disconnect(&server_id);
        wait_closed(&mut socket).await;

        transport
            .assert_no_more(0, Duration::from_millis(500))
            .await;
        assert!(
            repo::servers::find_by_id(&state.db.pool, &server_id)
                .await
                .is_err(),
            "服务器行已被删除"
        );
    }

    /// 心跳里的 u64 字段（内存/磁盘/uptime）必须饱和到 i64::MAX，不能回绕成负数。
    #[tokio::test]
    async fn heartbeat_u64_fields_saturate_instead_of_wrapping_negative() {
        let (state, server_id, _token) = state_with_server().await;
        let heartbeat = serde_json::json!({
            "type": "heartbeat",
            "seq": u64::MAX,
            "uptime_secs": u64::MAX,
            "load1": 0.0,
            "mem_used": u64::MAX,
            "mem_total": u64::MAX,
            "disk_used": u64::MAX,
            "disk_total": u64::MAX,
            "xray_running": false,
            "nginx_running": false,
        })
        .to_string();

        handle_agent_message(&state, &server_id, "0.15.3", &heartbeat).await;

        let row = repo::servers::find_by_id(&state.db.pool, &server_id)
            .await
            .expect("server row");
        assert_eq!(row.mem_used, Some(i64::MAX), "u64::MAX 必须饱和，不是 -1");
        assert_eq!(row.mem_total, Some(i64::MAX));
        assert_eq!(row.disk_used, Some(i64::MAX));
        assert_eq!(row.disk_total, Some(i64::MAX));
        assert_eq!(row.uptime_secs, Some(i64::MAX));
    }

    /// 首帧不是 Hello（二进制）时明确拒绝并关闭，不查库。
    #[tokio::test]
    async fn binary_first_frame_is_rejected() {
        let (state, _server_id, _token) = state_with_server().await;
        state.db.pool.close().await;
        let server = TestServer::start(state, Duration::from_secs(5)).await;
        let mut socket = server.connect().await;

        socket
            .send(ClientMessage::Binary(vec![0, 1, 2]))
            .await
            .unwrap();
        match next_message(&mut socket).await {
            Some(MasterMessage::Error { message }) => assert_eq!(message, "expected hello"),
            other => panic!("expected error, got {other:?}"),
        }
        wait_closed(&mut socket).await;
    }

    /// 广播积压（`Lagged`）时必须主动补发完整期望态，而不是只记一条 warn。
    ///
    /// 连接建立后才推进 `config_version`：握手时的快照还是 0，处理 `Lagged`
    /// 的补发只有重新读库才能拿到新版本，因此这个用例能区分「真的补发」与
    /// 「把连接建立时的旧快照再发一遍」。
    #[tokio::test]
    async fn broadcast_lag_resends_the_full_desired_state() {
        let (state, server_id, token) = state_with_server().await;
        let server = TestServer::start(state.clone(), Duration::from_secs(5)).await;

        let mut socket = server.connect().await;
        socket
            .send(ClientMessage::Text(hello_json(&token, "hk-1", "0.14.2")))
            .await
            .unwrap();
        assert!(matches!(
            next_message(&mut socket).await,
            Some(MasterMessage::Ack(_))
        ));

        let version = repo::servers::bump_config_version(&state.db.pool, &server_id)
            .await
            .unwrap();
        assert_eq!(version, 1);

        // 默认 current_thread 运行时：同步循环里没有 await，WS 任务不会被调度，
        // 64 条容量的广播缓冲必然溢出 → 下一次 recv 一定是 Lagged。
        for _ in 0..256 {
            state.hub.publish(&server_id, MasterMessage::Ping);
        }

        let mut resent = None;
        for _ in 0..512 {
            // 必须带超时：没有补发时连接不会关闭，裸 await 会让测试永远挂着。
            let message =
                tokio::time::timeout(Duration::from_millis(500), next_message(&mut socket)).await;
            match message {
                Ok(Some(MasterMessage::Desired(desired))) => {
                    resent = Some(desired);
                    break;
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
        let desired = resent.expect("Lagged 后必须补发 DesiredState");
        assert_eq!(
            desired.version, version,
            "补发必须用库里的最新版本，而不是连接建立时的旧快照"
        );
    }

    /// 补发失败（这里让查库失败）必须关闭连接，Agent 重连后会重新拿全量配置。
    #[tokio::test]
    async fn failed_lag_resend_closes_the_connection() {
        let (state, server_id, token) = state_with_server().await;
        let server = TestServer::start(state.clone(), Duration::from_secs(5)).await;

        let mut socket = server.connect().await;
        socket
            .send(ClientMessage::Text(hello_json(&token, "hk-1", "0.14.2")))
            .await
            .unwrap();
        assert!(matches!(
            next_message(&mut socket).await,
            Some(MasterMessage::Ack(_))
        ));

        // 池已关闭：补发时读库必失败，必须走「关闭连接」而不是无声卡住。
        state.db.pool.close().await;
        for _ in 0..256 {
            state.hub.publish(&server_id, MasterMessage::Ping);
        }

        wait_closed(&mut socket).await;
    }

    /// 猜安装 token 也按 IP 计数：同一 IP 失败 20 次后**坏 token** 以限流拒绝。
    ///
    /// T2：锁只约束「认证尝试」。合法 token 必须先校验、成功即放行，不能被
    /// 同一 NAT 里别人打出来的 IP 锁连坐；成功认证还会清零该 IP 的计数。
    #[tokio::test]
    async fn repeated_bad_agent_tokens_lock_the_ip_but_not_valid_tokens() {
        let (state, _server_id, token) = state_with_server().await;
        let server = TestServer::start(state, Duration::from_secs(5)).await;

        for _ in 0..IP_MAX_FAILURES {
            let mut socket = server.connect().await;
            socket
                .send(ClientMessage::Text(hello_json(
                    "bogus-token",
                    "hk-x",
                    "0.14.2",
                )))
                .await
                .unwrap();
            match next_message(&mut socket).await {
                Some(MasterMessage::Error { message }) => assert_eq!(message, "invalid token"),
                other => panic!("expected invalid token, got {other:?}"),
            }
            wait_closed(&mut socket).await;
        }

        // 锁定后坏 token 直接以限流拒绝。
        let mut socket = server.connect().await;
        socket
            .send(ClientMessage::Text(hello_json(
                "bogus-token",
                "hk-x",
                "0.14.2",
            )))
            .await
            .unwrap();
        match next_message(&mut socket).await {
            Some(MasterMessage::Error { message }) => assert_eq!(
                message, "too many auth failures",
                "锁定期内坏 token 必须直接拒绝"
            ),
            other => panic!("expected throttle rejection, got {other:?}"),
        }
        wait_closed(&mut socket).await;

        // 合法 token 不受 IP 锁影响：先做 token 校验，成功就下发 Ack。
        let mut socket = server.connect().await;
        socket
            .send(ClientMessage::Text(hello_json(&token, "hk-ok", "0.14.2")))
            .await
            .unwrap();
        assert!(
            matches!(next_message(&mut socket).await, Some(MasterMessage::Ack(_))),
            "合法 Agent token 不能被 IP 锁连坐"
        );
        socket.close(None).await.unwrap();

        // 成功认证清零计数：坏 token 回到普通的 invalid token，而不是继续 429。
        let mut socket = server.connect().await;
        socket
            .send(ClientMessage::Text(hello_json(
                "bogus-token",
                "hk-x",
                "0.14.2",
            )))
            .await
            .unwrap();
        match next_message(&mut socket).await {
            Some(MasterMessage::Error { message }) => {
                assert_eq!(message, "invalid token", "成功认证后 IP 计数应清零")
            }
            other => panic!("expected invalid token after clear, got {other:?}"),
        }
        wait_closed(&mut socket).await;
    }
}
