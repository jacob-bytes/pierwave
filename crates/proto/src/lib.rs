//! 主控 ↔ Agent 的线协议，以及给前端/订阅器复用的视图模型。
//!
//! 原则：消息只增不改。改字段必须同时升 `PROTOCOL_VERSION`，
//! 旧 Agent 收到不认识的 variant 应当忽略而不是崩溃。

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 14;

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
    /// 操作系统名称（`/etc/os-release` 的 `NAME`）。
    /// 旧 Agent 不上报时为 `None`，主控保持 null。
    #[serde(default)]
    pub os_name: Option<String>,
    /// 操作系统版本（`/etc/os-release` 的 `VERSION_ID`）。
    #[serde(default)]
    pub os_version: Option<String>,
    /// 虚拟化类型（`kvm` / `vmware` / `none` 等）。
    /// 裸机、探测失败或旧 Agent 不上报时为 `None`。
    #[serde(default)]
    pub virt: Option<String>,
    /// Agent 本机是否装有可用的 realm 引擎（`realm_bin` 存在且可执行）。
    /// `None` = 旧 Agent 未上报，主控保持 NULL（未知），不能当成「没装」。
    #[serde(default)]
    pub realm_available: Option<bool>,
    /// 本机 realm 是否带 `transport` feature（`realm --version` 输出包含
    /// `[transport]`）。
    ///
    /// `None` = 旧 Agent 未上报 / 无法判定（二进制不存在、命令超时）；
    /// `Some(false)` = 明确不支持。主控只有看到 `Some(true)` 才会下发 TLS 链，
    /// 未知一律按不支持处理（fail closed，绝不回退明文）。
    #[serde(default)]
    pub realm_transport: Option<bool>,
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
    /// 单目标兼容字段：旧主控只下发这一对，`targets` 为空时 Agent 用它。
    pub target_host: String,
    pub target_port: i64,
    /// 候选目标（组内成员）。空 = 退回 `target_host:target_port`。
    #[serde(default)]
    pub targets: Vec<ForwardTarget>,
    /// 从候选里怎么挑一个。旧主控不下发时为轮询。
    #[serde(default)]
    pub strategy: ForwardStrategy,
    /// 用哪个转发引擎实现这条规则。
    ///
    /// 旧主控不下发该字段，反序列化后是 [`ForwardEngine::Native`]，
    /// 与升级前的行为完全一致。
    #[serde(default)]
    pub engine: ForwardEngine,
    /// 这条规则是否**同时**在 `listen_port` 上监听 UDP（与 TCP 同端口号）。
    ///
    /// 只对 `native` 引擎有意义：`realm` 的配置固定 `use_udp = true`，总是转发
    /// UDP，不看这个字段。旧主控不下发时按 `false`，也就是与升级前完全一致
    /// （只监听 TCP）。
    #[serde(default)]
    pub udp: bool,
    /// realm 这一跳的**入站** transport 串，例如
    /// `tls;cert=/usr/local/etc/xray/certs/<id>.pem;key=/usr/local/etc/xray/certs/<id>.key`。
    ///
    /// `None` = 明文监听（旧主控不下发时也是 `None`，行为与升级前一致）。
    /// 只对 `engine == realm` 有意义；字符串由主控的 `TransportSpec` 生成，
    /// Agent 不接受用户自由文本，只按白名单校验后写进 realm.toml。
    #[serde(default)]
    pub listen_transport: Option<String>,
    /// realm 这一跳的**出站** transport 串，例如 `tls;sni=hop1.example.com`。
    ///
    /// `None` = 明文出站。
    #[serde(default)]
    pub remote_transport: Option<String>,
    /// `true` = 该端点的 realm 配置必须写 `network = { use_udp = false }`。
    ///
    /// UDP 不走 transport，加密端点必须显式关掉，否则同端口仍会明文转发 UDP。
    /// 旧主控不下发时为 `false`，保持原有行为（全局 `use_udp = true`）。
    #[serde(default)]
    pub disable_udp: bool,
}

/// 转发引擎。
///
/// `native` 是 Agent 自带的 TCP 监听（[`DesiredForward`] 里的实现）；
/// `realm` 交给受管的 realm 子进程（`realm -c <config>`），TCP 与 UDP
/// 同时转发（配置里 `use_udp = true`）。
///
/// 存储与 API 里的字符串值就是这里的 snake_case 名字，两侧必须保持一致。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ForwardEngine {
    /// Agent 自己监听并转发（默认，行为与旧版本一致）。
    #[default]
    Native,
    /// 外接 realm 子进程。
    Realm,
}

impl ForwardEngine {
    /// 把数据库/API 里的引擎名映射成协议枚举。
    ///
    /// 只认 `realm`，其余（含未知值与空串）一律按 `native` 处理：
    /// 写路径已由领域层严格校验，读路径的兜底必须保证旧数据仍能下发。
    pub fn from_name(raw: &str) -> Self {
        if raw.trim() == "realm" {
            Self::Realm
        } else {
            Self::Native
        }
    }
}

/// 一个候选目标：某台服务器的地址与端口。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForwardTarget {
    pub host: String,
    pub port: i64,
    /// 用于把运行状态回报给主控（哪个成员在接流量）。
    #[serde(default)]
    pub server_id: String,
}

/// 组内选路策略。Agent 侧按连接执行。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ForwardStrategy {
    /// 按顺序轮流（默认）。
    #[default]
    RoundRobin,
    /// 主备：总是用第一个可用的，前面的通了就换回来。
    Failover,
    /// 只选当前探测延迟最低的，全部不通时按顺序回退。
    LowestLatency,
    /// 按客户端 IP 做一致性哈希，同一来源尽量落到同一台。
    IpHashed,
}

/// Agent 回报的转发运行状态（心跳里带）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ForwardStatus {
    pub id: String,
    /// 监听是否成功。与 `target_ok` 是两件事：端口绑上了不等于目标可达。
    pub listening: bool,
    /// 监听失败的原因（端口被占用等）；正常时为空串。
    #[serde(default)]
    pub error: String,
    /// 目标 TCP 探测结果。`None` = 本轮尚未探测 / 旧 Agent 不认识该字段。
    #[serde(default)]
    pub target_ok: Option<bool>,
    /// 加密链路的握手失败原因（`None` = 未探测或成功）。
    ///
    /// 只对带 `remote_transport = "tls;sni=…"` 的 realm 规则填写；值是稳定的
    /// 英文短串（`tcp_connect_failed` / `cert_expired` / `unknown_issuer` /
    /// `name_mismatch` / `handshake_failed` / `timeout`），由主控/前端翻译，
    /// 不带 rustls 的 Debug 文本。旧 Agent 不认识该字段时为 `None`。
    #[serde(default)]
    pub target_error: Option<String>,
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

    #[test]
    fn forward_status_target_ok_is_optional_for_old_agents() {
        // 旧 Agent 的 JSON 没有 target_ok / target_error：反序列化必须是 None，而不是报错。
        let old = r#"{"id":"fwd-1","listening":true,"error":""}"#;
        let status: ForwardStatus = serde_json::from_str(old).unwrap();
        assert_eq!(status.target_ok, None);
        assert_eq!(
            status.target_error, None,
            "旧 Agent 没有 target_error 时必须解析为 None（主控落 NULL）"
        );

        // 新 Agent 上报的目标可达性与 listening 相互独立。
        let new = ForwardStatus {
            id: "fwd-2".into(),
            listening: true,
            error: String::new(),
            target_ok: Some(false),
            target_error: Some("cert_expired".into()),
        };
        let json = serde_json::to_value(&new).unwrap();
        assert_eq!(json["listening"], true);
        assert_eq!(json["target_ok"], false);
        assert_eq!(json["target_error"], "cert_expired");
        let back: ForwardStatus = serde_json::from_value(json).unwrap();
        assert_eq!(back, new, "新字段必须能往返");
    }

    /// 握手成功 / 未探测时 `target_error` 序列化成 null（与 target_ok 一致），
    /// 主控反序列化后仍是 None，不能变成空串。
    #[test]
    fn forward_status_target_error_serializes_null_when_none() {
        let status = ForwardStatus {
            id: "fwd-3".into(),
            listening: true,
            error: String::new(),
            target_ok: Some(true),
            target_error: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["target_error"], serde_json::Value::Null, "{json}");
        let back: ForwardStatus = serde_json::from_value(json).unwrap();
        assert_eq!(back.target_error, None);
    }

    #[test]
    fn forward_udp_defaults_to_false_for_old_masters() {
        assert_eq!(
            PROTOCOL_VERSION, 14,
            "新增 ForwardStatus.target_error 必须升协议版本"
        );

        // 旧主控的 JSON 没有 udp：必须解析成 false，也就是「只监听 TCP」，
        // 升级 Agent 不能因此凭空多开一个 UDP 端口。
        let old = r#"{
            "id": "fwd-1",
            "listen_port": 8443,
            "target_host": "10.0.0.8",
            "target_port": 443,
            "targets": [],
            "strategy": "round_robin",
            "engine": "native"
        }"#;
        let forward: DesiredForward = serde_json::from_str(old).unwrap();
        assert!(!forward.udp, "旧主控不下发 udp 时必须按 false 处理");
        // 旧主控没有 transport 字段：必须解析成「明文 + 不关 UDP」，
        // 升级 Agent 不能因此改变任何既有明文规则的行为。
        assert_eq!(forward.listen_transport, None);
        assert_eq!(forward.remote_transport, None);
        assert!(!forward.disable_udp);

        // 新主控显式开启时按布尔值往返，不能丢字段。
        let enabled = DesiredForward {
            udp: true,
            ..forward
        };
        let json = serde_json::to_value(&enabled).unwrap();
        assert_eq!(json["udp"], true);
        let back: DesiredForward = serde_json::from_value(json).unwrap();
        assert_eq!(back, enabled);
    }

    #[test]
    fn hop_transport_fields_roundtrip_and_stay_optional() {
        let mut forward: DesiredForward = serde_json::from_str(
            r#"{
                "id": "chain-c1-1",
                "listen_port": 30002,
                "target_host": "10.0.0.3",
                "target_port": 30003,
                "targets": [],
                "strategy": "round_robin",
                "engine": "realm"
            }"#,
        )
        .unwrap();
        assert_eq!(forward.listen_transport, None);
        assert_eq!(forward.remote_transport, None);
        assert!(!forward.disable_udp);

        forward.listen_transport = Some(
            "tls;cert=/usr/local/etc/xray/certs/c1.pem;key=/usr/local/etc/xray/certs/c1.key".into(),
        );
        forward.remote_transport = Some("tls;sni=hop2.example.com".into());
        forward.disable_udp = true;

        let json = serde_json::to_value(&forward).unwrap();
        assert_eq!(json["disable_udp"], true);
        assert_eq!(json["remote_transport"], "tls;sni=hop2.example.com");
        assert_eq!(
            json["listen_transport"],
            forward.listen_transport.clone().unwrap()
        );
        let back: DesiredForward = serde_json::from_value(json).unwrap();
        assert_eq!(back, forward);
    }

    #[test]
    fn old_heartbeat_without_os_fields_deserializes_as_none() {
        // 旧 Agent 的 JSON 没有 os_name / os_version / virt：
        // 必须能解析成功且保持 None，主控据此落 NULL，而不是报错或写空串。
        let old = r#"{
            "seq": 1,
            "agent_version": "0.1.0",
            "arch": "x86_64",
            "uptime_secs": 2,
            "load1": 0.1,
            "mem_used": 1,
            "mem_total": 2,
            "disk_used": 1,
            "disk_total": 2,
            "xray_running": true,
            "nginx_running": true
        }"#;
        let heartbeat: Heartbeat = serde_json::from_str(old).unwrap();
        assert_eq!(heartbeat.os_name, None);
        assert_eq!(heartbeat.os_version, None);
        assert_eq!(heartbeat.virt, None);
        assert_eq!(
            heartbeat.realm_available, None,
            "旧 Agent 没有 realm_available 时必须解析为 None（主控落 NULL）"
        );
        assert_eq!(
            heartbeat.realm_transport, None,
            "旧 Agent 没有 realm_transport 时必须解析为 None（未知按不支持处理）"
        );

        // 新 Agent 上报后 round-trip 不丢字段。
        let heartbeat = Heartbeat {
            os_name: Some("Debian GNU/Linux".into()),
            os_version: Some("12".into()),
            virt: Some("kvm".into()),
            realm_available: Some(true),
            realm_transport: Some(true),
            ..heartbeat
        };
        let json = serde_json::to_value(&heartbeat).unwrap();
        let back: Heartbeat = serde_json::from_value(json).unwrap();
        assert_eq!(back.os_name.as_deref(), Some("Debian GNU/Linux"));
        assert_eq!(back.os_version.as_deref(), Some("12"));
        assert_eq!(back.virt.as_deref(), Some("kvm"));
        assert_eq!(back.realm_available, Some(true));
        assert_eq!(back.realm_transport, Some(true));

        // false 是「明确没装」，与 None（未知）必须能区分。
        let not_installed = Heartbeat {
            realm_available: Some(false),
            ..heartbeat
        };
        let json = serde_json::to_value(&not_installed).unwrap();
        assert_eq!(json["realm_available"], false);
        let back: Heartbeat = serde_json::from_value(json).unwrap();
        assert_eq!(back.realm_available, Some(false));
        assert_eq!(
            back.realm_transport,
            Some(true),
            "未安装 realm 不代表 transport 能力字段被丢掉"
        );
    }

    #[test]
    fn forward_engine_defaults_to_native_for_old_masters() {
        // 旧主控的 JSON 没有 engine：必须解析成 native，行为与升级前一致。
        let old = r#"{
            "id": "fwd-1",
            "listen_port": 8443,
            "target_host": "10.0.0.8",
            "target_port": 443,
            "targets": [],
            "strategy": "round_robin"
        }"#;
        let forward: DesiredForward = serde_json::from_str(old).unwrap();
        assert_eq!(forward.engine, ForwardEngine::Native);
        assert_eq!(ForwardEngine::default(), ForwardEngine::Native);

        // 新主控显式下发 realm 时按 snake_case 往返。
        let realm = DesiredForward {
            engine: ForwardEngine::Realm,
            ..forward.clone()
        };
        let json = serde_json::to_value(&realm).unwrap();
        assert_eq!(json["engine"], "realm");
        let back: DesiredForward = serde_json::from_value(json).unwrap();
        assert_eq!(back, realm);

        // 未知值按 native 处理：读路径不能因为脏数据拒绝整份期望态。
        assert_eq!(
            ForwardEngine::from_name("  native "),
            ForwardEngine::Native,
            "允许首尾空白"
        );
        assert_eq!(
            ForwardEngine::from_name("wireguard"),
            ForwardEngine::Native,
            "未知引擎回落 native"
        );
        assert_eq!(
            ForwardEngine::from_name("realm"),
            ForwardEngine::Realm,
            "realm 必须被识别"
        );
    }
}
