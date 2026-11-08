//! 主控 ↔ Agent 的线协议，以及给前端/订阅器复用的视图模型。
//!
//! 原则：消息只增不改。改字段必须同时升 `PROTOCOL_VERSION`，
//! 旧 Agent 收到不认识的 variant 应当忽略而不是崩溃。

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 6;

/// Agent 建连后的第一条消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHello {
    pub token: String,
    pub hostname: String,
    pub agent_version: String,
    /// external | embedded
    pub xray_mode: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerAck {
    pub server_id: String,
    pub protocol_version: u32,
    pub config_version: i64,
    pub heartbeat_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Heartbeat {
    pub seq: u64,
    /// Agent 版本。心跳也带一份，主控才能在「重连间隙」和「升级后」感知版本变化；
    /// 缺省为空串，兼容不认识这个字段的旧 Agent。
    #[serde(default)]
    pub agent_version: String,
    /// CPU 架构（`x86_64` / `aarch64`），主控据此选择升级产物。
    /// 缺省为空串时主控回落到 `PIERWAVE_AGENT_TARGET` 配置。
    #[serde(default)]
    pub arch: String,
    /// 各转发规则的监听状态。
    #[serde(default)]
    pub forwards: Vec<ForwardStatus>,
    /// Agent 到探测目标（默认 1.1.1.1:443）的 TCP 握手往返毫秒数。
    /// `None` = 这轮没探测成功或旧 Agent 不认识该字段。
    #[serde(default)]
    pub latency_ms: Option<u32>,
    pub uptime_secs: u64,
    pub load1: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub xray_running: bool,
    pub nginx_running: bool,
}

/// 期望态：Agent 幂等收敛到这份配置，失败回滚上一版。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesiredState {
    pub version: i64,
    /// 完整的 Xray 配置（原样落盘，不做二次建模）
    pub xray: serde_json::Value,
    #[serde(default)]
    pub files: Vec<ManagedFile>,
    /// 期望的 Agent 升级目标。None = 不需要升级。
    #[serde(default)]
    pub agent_upgrade: Option<AgentUpgradePlan>,
    /// 期望的端口转发规则（Agent 原生 TCP 监听，不经 Xray）。
    /// 旧主控不下发时为空，Agent 视为「没有转发」并停掉自己的监听。
    #[serde(default)]
    pub forwards: Vec<DesiredForward>,
    /// 本次期望态里**已启用**节点的限速信息，供 Agent 生成 tc 规则。
    ///
    /// 只放 Agent 需要的最小集合：它拿不到服务器的节点表，而 xray JSON 里
    /// 没有「这个 inbound 对应哪个节点 id」。旧主控不下发该字段时为空，
    /// Agent 视为「没有任何限速」并清掉自己建的 qdisc。
    #[serde(default)]
    pub nodes: Vec<DesiredNode>,
}

/// 一条端口转发：Agent 在 `listen_port` 上监听，把连接原样转到 `target`。
///
/// 与 Xray 节点是两套并行系统：转发走裸 TCP，不进代理协议栈，
/// 因此也没有 `email`/统计计数器——它不计入用户流量。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesiredForward {
    pub id: String,
    pub listen_port: i64,
    pub target_host: String,
    pub target_port: i64,
}

/// Agent 回报的转发运行状态（心跳里带）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ForwardStatus {
    pub id: String,
    pub listening: bool,
    /// 监听失败的原因（端口被占用等）；正常时为空串。
    #[serde(default)]
    pub error: String,
}

/// 期望态里的单个节点（仅 Agent 生成 tc 规则需要的字段）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesiredNode {
    pub id: String,
    pub tag: String,
    pub port: i64,
    /// 节点带宽上限（kbps）；`0` = 不限。
    #[serde(default)]
    pub bandwidth_kbps: i64,
}

/// 主控下发的 Agent 自升级计划。
///
/// 它仍然属于「期望态」：Agent 每次收敛都会比较 `version` 与自身版本，
/// 只有目标版本更新时才执行一次，重复下发是幂等的。
/// 所有 URL 指向主控中转（`/api/agent/release/...`），由主控负责回源 GitHub 并缓存，
/// 这样内网机器不直连 GitHub 也能升级。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentUpgradePlan {
    pub version: String,
    pub asset_url: String,
    pub sums_url: String,
    pub sig_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedFile {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub mode: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyResult {
    pub version: i64,
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
}

/// 按用户凭据（Xray email）聚合的增量；采集时已冻结加权倍率。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficDelta {
    pub email: String,
    pub uplink: u64,
    pub downlink: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficReport {
    /// 单调递增，主控用 (server_id, seq) 去重
    pub seq: u64,
    /// Agent 每次启动生成，用于识别 xray 计数器重置
    pub boot_id: String,
    pub deltas: Vec<TrafficDelta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMessage {
    Hello(AgentHello),
    Heartbeat(Heartbeat),
    ApplyResult(ApplyResult),
    Traffic(TrafficReport),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MasterMessage {
    Ack(ServerAck),
    Desired(DesiredState),
    Ping,
    /// 握手失败等致命错误：Agent 应记录并退出重试
    Error {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_messages_roundtrip() {
        let msg = AgentMessage::Hello(AgentHello {
            token: "t".into(),
            hostname: "hk-1".into(),
            agent_version: "0.1.0".into(),
            xray_mode: "external".into(),
            capabilities: vec!["xray".into()],
        });
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"hello\""));
        let back: AgentMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, AgentMessage::Hello(_)));
    }

    #[test]
    fn desired_state_carries_raw_xray_json() {
        let state = MasterMessage::Desired(DesiredState {
            version: 7,
            xray: serde_json::json!({"inbounds": [], "outbounds": []}),
            files: vec![],
            agent_upgrade: None,
            nodes: vec![],
            forwards: vec![],
        });
        let json = serde_json::to_string(&state).unwrap();
        let back: MasterMessage = serde_json::from_str(&json).unwrap();
        match back {
            MasterMessage::Desired(d) => assert_eq!(d.version, 7),
            _ => panic!("wrong variant"),
        }
    }
}
