//! 主控 ↔ Agent 的线协议，以及给前端/订阅器复用的视图模型。
//!
//! 原则：消息只增不改。改字段必须同时升 `PROTOCOL_VERSION`，
//! 旧 Agent 收到不认识的 variant 应当忽略而不是崩溃。

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 22;

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

/// Agent 本机的一块网卡。
///
/// `addresses` 只放 IP 字面量（v4 / v6），**不带 CIDR 前缀**：主控要把它
/// 直接写进 Xray 的 `listen` / `sendThrough`，带 `/24` 会让配置非法。
/// 旧主控会忽略整个字段（`#[serde(default)]`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkInterface {
    /// 网卡名，例如 `eth0` / `ens3`。
    pub name: String,
    /// 本机该网卡的 IP（v4 / v6），不含 CIDR。
    #[serde(default)]
    pub addresses: Vec<String>,
}

impl NetworkInterface {
    /// 选一个可以写进 Xray 配置的地址：优先 IPv4，其次 IPv6。
    ///
    /// 跳过 unspecified（`0.0.0.0` / `::`）与 link-local（`169.254.0.0/16` /
    /// `fe80::/10`）：前者等于「没限制」，后者离开本链路就不可达，都不能
    /// 用来实现「限定从某块网卡出入流量」。没有可用地址时返回 `None`，
    /// 调用方必须把服务器标成 blocked，绝不回退 `0.0.0.0`。
    pub fn preferred_address(&self) -> Option<&str> {
        let parsed: Vec<(&str, std::net::IpAddr)> = self
            .addresses
            .iter()
            .filter_map(|raw| {
                raw.trim()
                    .parse::<std::net::IpAddr>()
                    .ok()
                    .map(|ip| (raw.trim(), ip))
            })
            .collect();
        parsed
            .iter()
            .find(|(_, ip)| match ip {
                std::net::IpAddr::V4(addr) => !addr.is_unspecified() && !addr.is_link_local(),
                std::net::IpAddr::V6(_) => false,
            })
            .or_else(|| {
                parsed.iter().find(|(_, ip)| match ip {
                    std::net::IpAddr::V6(addr) => {
                        !addr.is_unspecified() && !addr.is_unicast_link_local()
                    }
                    std::net::IpAddr::V4(_) => false,
                })
            })
            .map(|(raw, _)| *raw)
    }
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
    /// 本机是否具备可用的 nftables 引擎（`nft` 可执行且当前进程有
    /// CAP_NET_ADMIN；心跳时实际执行一次 `nft list tables` 判定）。
    ///
    /// `None` = 旧 Agent 未上报；`Some(false)` = 明确不可用。
    /// 主控只有看到 `Some(true)` 才允许保存/下发 nftables 规则，避免旧 Agent
    /// 收到不认识的新枚举值而整份期望态解析失败。
    #[serde(default)]
    pub nftables_available: Option<bool>,
    /// 本机是否具备 P16 隧道引擎（TLS + 自有 CA 的帧中继）。
    ///
    /// `None` = 旧 Agent 未上报；只有 `Some(true)` 才允许主控保存/下发
    /// `engine = tunnel` 的链，未知一律按不支持处理（fail closed）。
    #[serde(default)]
    pub tunnel_available: Option<bool>,
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
    /// 本机网卡（名称 + 地址），供主控做「限定从某块网卡出入流量」的配置注入。
    ///
    /// 旧 Agent 没有该字段 → 空数组。空数组本身无法区分「旧 Agent」
    /// 与「新 Agent 采集失败」，所以另带 [`Heartbeat::interfaces_reported`]。
    #[serde(default)]
    pub interfaces: Vec<NetworkInterface>,
    /// 本 Agent 是否支持网卡上报：新版每次心跳都写 `true`（即使采集失败、
    /// `interfaces` 为空）；旧 Agent 没有该字段 → `false`。
    ///
    /// 主控用 `true` 推进 `servers.interfaces_reported_at`，从而区分
    /// 「从未上报」（`nic_unverified = true`）与「上报过但当前没有网卡」。
    #[serde(default)]
    pub interfaces_reported: bool,
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
    /// 旧版兼容位：这条规则是否**额外**在 `listen_port` 上监听 UDP。
    ///
    /// 新主控以 [`DesiredForward::protocol`] 为准；这一位只用于让升级后的
    /// Agent 继续兼容「只会下发 `udp` 布尔值」的旧主控。读时必须用
    /// [`DesiredForward::effective_protocol`]，它会把 `protocol = tcp` 且
    /// `udp = true` 的旧报文解释成 [`ForwardProtocol::Both`]。
    #[serde(default)]
    pub udp: bool,
    /// 这条规则要监听的协议（`tcp` / `udp` / `both`）。
    ///
    /// 新主控下发该字段；旧主控没有它，反序列化后是 [`ForwardProtocol::Tcp`]，
    /// 再由 [`DesiredForward::effective_protocol`] 结合旧 `udp` 位还原语义。
    #[serde(default)]
    pub protocol: ForwardProtocol,
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
    /// 这条规则在本机监听的地址；`None` = 沿用 Agent 的全局 `forward_bind`。
    ///
    /// 主控给服务器配置了 `nic_name` 时才会下发具体地址（例如 `10.0.0.2`），
    /// 让链路/隧道的入口只在这块网卡上监听。旧主控不下发时为 `None`，
    /// Agent 的行为与升级前逐字节一致。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_host: Option<String>,
    /// `true` = 该端点的 realm 配置必须写 `network = { use_udp = false }`。
    ///
    /// UDP 不走 transport，加密端点必须显式关掉，否则同端口仍会明文转发 UDP。
    /// 旧主控不下发时为 `false`，保持原有行为（全局 `use_udp = true`）。
    #[serde(default)]
    pub disable_udp: bool,
    /// P16 隧道参数；`Some` 时 `engine` 必须是 [`ForwardEngine::Tunnel`]。
    ///
    /// 旧主控不下发该字段（`None`），行为与升级前完全一致。
    #[serde(default)]
    pub tunnel: Option<TunnelSpec>,
}

/// 隧道里一端扮演的角色。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelRole {
    /// 接受对端隧道连接，校验首帧目标后连出去（出口）。
    Listener,
    /// 监听客户端明文连接，把它送进对端 Listener（入口）。
    Dialer,
}

/// 隧道的安全模式：两端必须一致。
///
/// * [`TunnelSecurity::Tls`]：主控自有 CA 签发的证书 + rustls（P16.1，默认）；
/// * [`TunnelSecurity::Noise`]：无证书，`hop_secret` 派生的静态密钥 + PSK
///   （P16.2，Noise IK）。
///
/// 旧主控不下发该字段，反序列化后是 [`TunnelSecurity::Tls`]，
/// 与升级前「只支持 TLS」的行为完全一致。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TunnelSecurity {
    /// TLS + 自有 CA（默认）。
    #[default]
    Tls,
    /// Noise/PSK：不需要证书，只共享 `hop_secret`。
    Noise,
}

impl TunnelSecurity {
    /// 从数据库/API 里的字符串读取；未知值回落 `tls`（读路径不能因脏值失败）。
    pub fn from_name(raw: &str) -> Self {
        match raw.trim() {
            "noise" => Self::Noise,
            _ => Self::Tls,
        }
    }

    /// 稳定的 snake_case 名字（与线协议、数据库、API 一致）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tls => "tls",
            Self::Noise => "noise",
        }
    }

    /// 是否是 Noise 模式。
    pub fn is_noise(self) -> bool {
        self == Self::Noise
    }
}

impl std::fmt::Display for TunnelSecurity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// P16 隧道的一条链路参数。
///
/// 2 跳链的形态：
///
/// * 入口服务器（第 0 跳）拿 [`TunnelRole::Dialer`]：公开监听 `listen`，
///   每来一条客户端连接就连 `remote`（下一跳 Listener），首帧请求
///   `allowed_targets` 里的地址；
/// * 出口服务器（第 1 跳）拿 [`TunnelRole::Listener`]：在 `listen` 上接受
///   TLS 隧道，首帧地址必须命中 `allowed_targets`，然后才连目标。
///
/// `hop_secret` 是 base64 的 32 字节 HMAC 密钥，由主控按
/// `HMAC(master_secret, "tunnel/{chain_id}/{seq}")` 派生。证书/CA 的路径
/// 由主控决定，并通过 `DesiredState.files` 同批下发。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TunnelSpec {
    pub role: TunnelRole,
    /// 两端一致的链路标识（ClientHello 用；1..=255 字节）。
    pub hop_id: String,
    /// Listener/Dialer 监听的地址，如 `0.0.0.0:19401`。
    pub listen: String,
    /// Dialer 连接的对端 Listener 地址；Listener 侧为空串。
    pub remote: String,
    /// 两端一致的隧道安全模式。
    ///
    /// 旧主控不下发时为 [`TunnelSecurity::Tls`]；`Noise` 模式下三个证书
    /// 路径字段都为空串，Agent 不会读取它们。
    #[serde(default)]
    pub security: TunnelSecurity,
    /// Listener 的证书路径（PEM）；Dialer 侧为空串，Noise 模式为空串。
    pub cert_pem_path: String,
    /// Listener 的私钥路径（PEM）；Dialer 侧为空串，Noise 模式为空串。
    pub key_pem_path: String,
    /// Dialer 只信任的 CA 路径（PEM）；Listener 侧为空串，Noise 模式为空串。
    pub ca_pem_path: String,
    /// base64(32B) 的每链路 HMAC 密钥。
    pub hop_secret: String,
    /// 允许/请求的目标地址白名单。空 = 拒绝一切（fail closed）。
    #[serde(default)]
    pub allowed_targets: Vec<TunnelTargetRule>,
    /// 这条隧道是否同时中继 UDP（P16.3，QUIC datagram）。
    ///
    /// 由链的 `protocol = udp / both` 推导：`true` 时 Dialer 在 `listen`
    /// 端口上额外绑一个 UDP 监听，Listener 在同一端口上起 QUIC endpoint。
    /// 旧主控不下发时为 `false`，也就是纯 TCP 隧道，行为与升级前一致。
    #[serde(default)]
    pub udp: bool,
}

/// 隧道目标白名单规则。
///
/// * `host` 是 IP 字面量时按**精确 IP**匹配；
/// * 否则按域名后缀匹配：`example.com` 命中 `example.com` 与
///   `*.example.com`，`*.example.com` 只命中子域；
/// * `ports` 是闭区间；`None` = 任意端口。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TunnelTargetRule {
    pub host: String,
    #[serde(default)]
    pub ports: Option<(u16, u16)>,
}

/// 一条转发规则监听的协议。
///
/// 存储与 API 里的字符串值就是这里的 snake_case 名字，两侧必须保持一致。
/// 旧的布尔列 `udp` 只作为迁移来源，读路径以本枚举为准。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ForwardProtocol {
    /// 只监听 TCP（默认，与升级前 `udp = false` 完全一致）。
    #[default]
    Tcp,
    /// 只监听 UDP（仅 `native` / `nftables` 引擎支持）。
    Udp,
    /// 同一端口号上 TCP 与 UDP 都监听。
    Both,
}

impl ForwardProtocol {
    /// 把数据库/API 里的协议名映射成协议枚举。
    ///
    /// 未知值与空串一律回落 `tcp`：写路径由领域层严格校验，读路径的兜底
    /// 必须保证旧数据仍能下发，而且最保守的结果是「只监听 TCP」，不会
    /// 凭空多开一个 UDP 端口。
    pub fn from_name(raw: &str) -> Self {
        match raw.trim() {
            "udp" => Self::Udp,
            "both" => Self::Both,
            _ => Self::Tcp,
        }
    }

    /// 稳定的 snake_case 名字（与数据库/API 一致）。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Tcp => "tcp",
            Self::Udp => "udp",
            Self::Both => "both",
        }
    }

    /// 是否监听 TCP。
    pub const fn allows_tcp(self) -> bool {
        matches!(self, Self::Tcp | Self::Both)
    }

    /// 是否监听 UDP。
    pub const fn allows_udp(self) -> bool {
        matches!(self, Self::Udp | Self::Both)
    }
}

impl DesiredForward {
    /// 实际生效的协议：兼容旧主控的 `udp = true`。
    ///
    /// 新主控会把 `protocol` 与旧 `udp` 位同时填好；旧主控没有 `protocol`
    /// （默认 `tcp`），但可能下发 `udp = true`，那种报文必须继续同时监听两种协议。
    pub fn effective_protocol(&self) -> ForwardProtocol {
        if self.protocol == ForwardProtocol::Tcp && self.udp {
            ForwardProtocol::Both
        } else {
            self.protocol
        }
    }
}

/// 转发引擎。
///
/// `native` 是 Agent 自带的 TCP 监听（[`DesiredForward`] 里的实现）；
/// `realm` 交给受管的 realm 子进程（`realm -c <config>`）；哪些协议监听
/// 由 [`DesiredForward::protocol`] 决定（`both` 写 `use_udp = true`，
/// `tcp` 写 `use_udp = false`，`udp` 被主控拒绝）。
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
    /// 内核 nftables DNAT（需要 root / CAP_NET_ADMIN）。
    Nftables,
    /// P16 自研 TLS 隧道（帧中继，自有 CA）。
    Tunnel,
}

impl ForwardEngine {
    /// 把数据库/API 里的引擎名映射成协议枚举。
    ///
    /// 认 `realm` / `nftables`，其余（含未知值与空串）一律按 `native` 处理：
    /// 写路径已由领域层严格校验，读路径的兜底必须保证旧数据仍能下发。
    pub fn from_name(raw: &str) -> Self {
        match raw.trim() {
            "realm" => Self::Realm,
            "nftables" => Self::Nftables,
            "tunnel" => Self::Tunnel,
            _ => Self::Native,
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
    /// 逐目标 TCP 握手探测结果。
    ///
    /// 每个元素对应这条规则的一个 target（`server_id` 来自
    /// [`ForwardTarget::server_id`]）。空数组 = 本轮没有探测（旧 Agent、
    /// UDP 规则、nftables 引擎），主控必须把链路延迟显示成 null 而不是 0。
    /// 失败的目标也要出现在数组里（`ok = false`、`latency_ms = None`），
    /// 这样主控才能区分「探了但不可达」与「根本没探」。
    #[serde(default)]
    pub targets: Vec<TargetProbe>,
    /// 这条规则自监听启动以来从客户端方向收到的字节数（累计值）。
    ///
    /// `None` = 该引擎/协议没有数据源（realm、native 的 UDP-only 规则）或
    /// 旧 Agent 根本没上报。**绝不能把未知写成 0**：0 只表示「确实累计了 0 字节」。
    /// 目前 native 只统计 TCP accept 循环里的字节；nftables 只统计 DNAT 规则
    /// 入方向的计数。单位是字节。
    #[serde(default)]
    pub traffic_in: Option<u64>,
    /// 这条规则自监听启动以来发回客户端方向的字节数（累计值）。
    ///
    /// nftables 的 DNAT counter 只看到一个方向，因此该字段为 `None`；
    /// 只有 native 的 TCP 双向拷贝能同时给出两个方向。
    #[serde(default)]
    pub traffic_out: Option<u64>,
}

/// 一个目标最近一轮 TCP 握手探测的结果。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct TargetProbe {
    /// 目标服务器 id；旧主控的单目标兼容格式没有它（空串）。
    pub server_id: String,
    /// 这一轮 TCP 握手是否成功。
    pub ok: bool,
    /// TCP 握手往返毫秒数；失败 / 旧 Agent 未记录时为 `None`，绝不能是 0。
    #[serde(default)]
    pub latency_ms: Option<u32>,
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
        assert!(
            status.targets.is_empty(),
            "旧 Agent 没有 targets 时必须解析成空数组（未探测，不是 0ms）"
        );

        // 新 Agent 上报的目标可达性与 listening 相互独立。
        let new = ForwardStatus {
            id: "fwd-2".into(),
            listening: true,
            error: String::new(),
            target_ok: Some(false),
            target_error: Some("cert_expired".into()),
            targets: Vec::new(),
            traffic_in: Some(1024),
            traffic_out: Some(2048),
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
            targets: Vec::new(),
            traffic_in: None,
            traffic_out: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["target_error"], serde_json::Value::Null, "{json}");
        let back: ForwardStatus = serde_json::from_value(json).unwrap();
        assert_eq!(back.target_error, None);
    }

    #[test]
    fn forward_udp_defaults_to_false_for_old_masters() {
        assert_eq!(
            PROTOCOL_VERSION, 22,
            "新增 Heartbeat.interfaces 与 DesiredForward.listen_host 必须升协议版本"
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
        assert_eq!(
            forward.protocol,
            ForwardProtocol::Tcp,
            "旧主控没有 protocol 时必须解析成 tcp"
        );
        assert_eq!(forward.effective_protocol(), ForwardProtocol::Tcp);
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
        assert_eq!(
            back.effective_protocol(),
            ForwardProtocol::Both,
            "旧主控 udp=true 必须继续表示两种协议都开"
        );
    }

    #[test]
    fn forward_protocol_defaults_to_tcp_and_roundtrips() {
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
        assert_eq!(ForwardProtocol::default(), ForwardProtocol::Tcp);
        assert_eq!(forward.protocol, ForwardProtocol::Tcp);
        assert_eq!(ForwardProtocol::from_name(" tcp "), ForwardProtocol::Tcp);
        assert_eq!(ForwardProtocol::from_name("udp"), ForwardProtocol::Udp);
        assert_eq!(ForwardProtocol::from_name("both"), ForwardProtocol::Both);
        assert_eq!(
            ForwardProtocol::from_name("wireguard"),
            ForwardProtocol::Tcp,
            "未知值必须保守回落 tcp"
        );
        assert_eq!(ForwardProtocol::Tcp.as_str(), "tcp");

        for protocol in [
            ForwardProtocol::Tcp,
            ForwardProtocol::Udp,
            ForwardProtocol::Both,
        ] {
            let spec = DesiredForward {
                protocol,
                ..forward.clone()
            };
            let json = serde_json::to_value(&spec).unwrap();
            assert_eq!(json["protocol"], protocol.as_str());
            let back: DesiredForward = serde_json::from_value(json).unwrap();
            assert_eq!(back.protocol, protocol);
            assert_eq!(back, spec);
            assert_eq!(back.effective_protocol(), protocol);
        }

        assert!(ForwardProtocol::Tcp.allows_tcp());
        assert!(!ForwardProtocol::Tcp.allows_udp());
        assert!(!ForwardProtocol::Udp.allows_tcp());
        assert!(ForwardProtocol::Udp.allows_udp());
        assert!(ForwardProtocol::Both.allows_tcp());
        assert!(ForwardProtocol::Both.allows_udp());
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

    /// 逐目标探测结果只加字段：旧 Agent 报文解析成空数组，新报文原样往返，
    /// 失败的延迟必须是 null（而不是 0ms）。
    #[test]
    fn forward_status_carries_per_target_probes() {
        let old = r#"{"id":"fwd-1","listening":true,"error":"","target_ok":true}"#;
        let status: ForwardStatus = serde_json::from_str(old).unwrap();
        assert!(status.targets.is_empty(), "旧 Agent 没有 targets 字段");

        let status = ForwardStatus {
            id: "fwd-2".into(),
            listening: true,
            error: String::new(),
            target_ok: Some(true),
            target_error: None,
            targets: vec![
                TargetProbe {
                    server_id: "srv-a".into(),
                    ok: true,
                    latency_ms: Some(23),
                },
                TargetProbe {
                    server_id: "srv-b".into(),
                    ok: false,
                    latency_ms: None,
                },
            ],
            traffic_in: None,
            traffic_out: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["targets"][0]["server_id"], "srv-a");
        assert_eq!(json["targets"][0]["latency_ms"], 23);
        assert_eq!(
            json["targets"][1]["latency_ms"],
            serde_json::Value::Null,
            "失败目标不能把延迟写成 0"
        );
        let back: ForwardStatus = serde_json::from_value(json).unwrap();
        assert_eq!(back, status, "逐目标探测结果必须能往返");
    }

    /// 每跳流量是可选字段：旧 Agent 不上报时必须是 None（主控落 NULL），
    /// 新 Agent 的 0 与「没有数据源」必须能区分。
    #[test]
    fn forward_status_traffic_is_optional_and_roundtrips() {
        let old = r#"{"id":"fwd-1","listening":true,"error":"","target_ok":true}"#;
        let status: ForwardStatus = serde_json::from_str(old).unwrap();
        assert_eq!(status.traffic_in, None);
        assert_eq!(status.traffic_out, None);

        let status = ForwardStatus {
            id: "fwd-2".into(),
            listening: true,
            error: String::new(),
            target_ok: Some(true),
            target_error: None,
            targets: Vec::new(),
            traffic_in: Some(0),
            traffic_out: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["traffic_in"], 0, "0 是「已统计但确实是 0 字节」");
        assert_eq!(
            json["traffic_out"],
            serde_json::Value::Null,
            "无数据源必须是 null，不能编造 0"
        );
        let back: ForwardStatus = serde_json::from_value(json).unwrap();
        assert_eq!(back, status);

        // 未知引擎/旧 Agent 的缺省反序列化不能报错。
        let old = r#"{"id":"fwd-3","listening":false,"error":"x"}"#;
        let status: ForwardStatus = serde_json::from_str(old).unwrap();
        assert_eq!(status.traffic_in, None);
        assert_eq!(status.traffic_out, None);
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
        assert_eq!(
            ForwardEngine::from_name("tunnel"),
            ForwardEngine::Tunnel,
            "tunnel 必须被识别"
        );
    }

    /// 隧道字段是新增的可选段：旧主控报文没有它，新报文原样往返，
    /// 且引擎 `tunnel` 必须能序列化成稳定的 snake_case。
    #[test]
    fn tunnel_spec_roundtrips_and_defaults_to_none() {
        let old = r#"{
            "id": "chain-c1-0",
            "listen_port": 19401,
            "target_host": "10.0.0.2",
            "target_port": 19402,
            "targets": [],
            "strategy": "round_robin",
            "engine": "native"
        }"#;
        let forward: DesiredForward = serde_json::from_str(old).unwrap();
        assert_eq!(
            forward.tunnel, None,
            "旧主控没有 tunnel 段时必须解析成 None"
        );

        let spec = TunnelSpec {
            role: TunnelRole::Listener,
            hop_id: "c1:1".into(),
            listen: "0.0.0.0:19402".into(),
            remote: String::new(),
            security: TunnelSecurity::Tls,
            cert_pem_path: "/usr/local/etc/pierwave/tunnel/srv-b.pem".into(),
            key_pem_path: "/usr/local/etc/pierwave/tunnel/srv-b.key".into(),
            ca_pem_path: String::new(),
            hop_secret: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=".into(),
            allowed_targets: vec![TunnelTargetRule {
                host: "example.com".into(),
                ports: Some((443, 443)),
            }],
            udp: false,
        };
        let mut with_tunnel = forward.clone();
        with_tunnel.engine = ForwardEngine::Tunnel;
        with_tunnel.tunnel = Some(spec.clone());
        let json = serde_json::to_value(&with_tunnel).unwrap();
        assert_eq!(json["engine"], "tunnel");
        assert_eq!(json["tunnel"]["role"], "listener");
        assert_eq!(
            json["tunnel"]["security"], "tls",
            "security 必须是稳定的 snake_case 字符串"
        );
        assert_eq!(
            json["tunnel"]["allowed_targets"][0]["ports"],
            serde_json::json!([443, 443])
        );
        let back: DesiredForward = serde_json::from_value(json).unwrap();
        assert_eq!(back, with_tunnel);
        assert_eq!(back.tunnel, Some(spec));

        // 旧主控没有 security：必须按 TLS 解析，行为与升级前一致。
        let old_tunnel = with_tunnel.clone();
        let mut old_json = serde_json::to_value(&old_tunnel).unwrap();
        old_json["tunnel"]
            .as_object_mut()
            .unwrap()
            .remove("security");
        let back: DesiredForward = serde_json::from_value(old_json).unwrap();
        assert_eq!(
            back.tunnel.as_ref().map(|tunnel| tunnel.security),
            Some(TunnelSecurity::Tls),
            "旧主控不下发 security 时必须默认 TLS"
        );
        assert_eq!(
            back.tunnel.as_ref().map(|tunnel| tunnel.udp),
            Some(false),
            "旧主控不下发 udp 时必须是纯 TCP 隧道"
        );

        // 新主控显式开启 UDP 时按布尔值往返，不能丢字段。
        let udp_tunnel = TunnelSpec {
            udp: true,
            ..with_tunnel.tunnel.clone().unwrap()
        };
        let json = serde_json::to_value(&udp_tunnel).unwrap();
        assert_eq!(json["udp"], true);
        let back: TunnelSpec = serde_json::from_value(json).unwrap();
        assert!(back.udp, "udp=true 必须原样往返");

        // Noise 模式原样往返；证书路径为空串是合法状态。
        let mut noise_tunnel = old_tunnel.tunnel.clone().unwrap();
        noise_tunnel.security = TunnelSecurity::Noise;
        noise_tunnel.cert_pem_path.clear();
        noise_tunnel.key_pem_path.clear();
        noise_tunnel.ca_pem_path.clear();
        let json = serde_json::to_value(&noise_tunnel).unwrap();
        assert_eq!(json["security"], "noise");
        assert_eq!(json["cert_pem_path"], "");
        let back: TunnelSpec = serde_json::from_value(json).unwrap();
        assert_eq!(back.security, TunnelSecurity::Noise);
        assert!(back.cert_pem_path.is_empty());

        // Dialer 是另一个稳定枚举值。
        let dialer = TunnelSpec {
            role: TunnelRole::Dialer,
            ..with_tunnel.tunnel.clone().unwrap()
        };
        let json = serde_json::to_value(&dialer).unwrap();
        assert_eq!(json["role"], "dialer");
        let back: TunnelSpec = serde_json::from_value(json).unwrap();
        assert_eq!(back.role, TunnelRole::Dialer);
    }

    /// 心跳新增 `tunnel_available`：旧 Agent 缺失 = None，明确值原样往返。
    #[test]
    fn heartbeat_tunnel_availability_is_optional() {
        let old = r#"{
            "seq": 1,
            "uptime_secs": 1,
            "load1": 0.0,
            "mem_used": 0,
            "mem_total": 0,
            "disk_used": 0,
            "disk_total": 0,
            "xray_running": false,
            "nginx_running": false
        }"#;
        let hb: Heartbeat = serde_json::from_str(old).unwrap();
        assert_eq!(hb.tunnel_available, None, "旧 Agent 未上报必须是 None");

        let hb = Heartbeat {
            tunnel_available: Some(true),
            ..hb
        };
        let json = serde_json::to_value(&hb).unwrap();
        assert_eq!(json["tunnel_available"], true);
        let back: Heartbeat = serde_json::from_value(json).unwrap();
        assert_eq!(back.tunnel_available, Some(true));
    }

    #[test]
    fn old_heartbeat_has_no_interfaces_and_new_one_roundtrips() {
        let old = r#"{
            "seq": 1,
            "uptime_secs": 1,
            "load1": 0.0,
            "mem_used": 0,
            "mem_total": 0,
            "disk_used": 0,
            "disk_total": 0,
            "xray_running": false,
            "nginx_running": false
        }"#;
        let hb: Heartbeat = serde_json::from_str(old).unwrap();
        assert!(
            hb.interfaces.is_empty(),
            "旧 Agent 没有 interfaces 时必须解析成空数组，不能报错"
        );
        assert!(
            !hb.interfaces_reported,
            "旧 Agent 没有 interfaces_reported 时必须解析成 false"
        );

        let hb = Heartbeat {
            interfaces_reported: true,
            interfaces: vec![NetworkInterface {
                name: "eth0".into(),
                addresses: vec!["10.0.0.2".into(), "2001:db8::2".into()],
            }],
            ..hb
        };
        let json = serde_json::to_value(&hb).unwrap();
        assert_eq!(json["interfaces"][0]["name"], "eth0");
        assert_eq!(
            json["interfaces"][0]["addresses"][0], "10.0.0.2",
            "线协议里地址不能带 CIDR"
        );
        let back: Heartbeat = serde_json::from_value(json).unwrap();
        assert_eq!(back.interfaces, hb.interfaces);
        assert!(back.interfaces_reported);
    }

    #[test]
    fn preferred_interface_address_skips_unspecified_and_link_local() {
        let iface = NetworkInterface {
            name: "eth0".into(),
            addresses: vec![
                "fe80::1".into(),
                "0.0.0.0".into(),
                "169.254.10.1".into(),
                "2001:db8::2".into(),
                "10.0.0.2".into(),
            ],
        };
        assert_eq!(
            iface.preferred_address(),
            Some("10.0.0.2"),
            "有 IPv4 时必须优先 IPv4，并跳过 link-local / unspecified"
        );

        let v6_only = NetworkInterface {
            name: "eth0".into(),
            addresses: vec!["fe80::1".into(), "2001:db8::2".into()],
        };
        assert_eq!(v6_only.preferred_address(), Some("2001:db8::2"));

        let none = NetworkInterface {
            name: "eth0".into(),
            addresses: vec!["fe80::1".into(), "0.0.0.0".into(), "not-an-ip".into()],
        };
        assert_eq!(
            none.preferred_address(),
            None,
            "没有可用地址时不能回退 0.0.0.0"
        );
    }
}
