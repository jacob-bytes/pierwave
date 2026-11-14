use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct User {
    pub id: String,
    pub username: String,
    #[serde(skip)]
    pub password_hash: String,
    pub role: String,
    pub status: String,
    pub short_code: String,
    /// 订阅短码最后一次被重置的时间（Unix 秒）；建号时 = `created_at`。
    pub short_code_updated_at: i64,
    pub quota_bytes: Option<i64>,
    pub used_bytes: i64,
    /// 用户级规则模板绑定；`null` = 跟随当前套餐 / 全局默认。
    pub rule_template_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct Session {
    pub id: String,
    pub user_id: String,
    pub token_hash: String,
    pub expires_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub address: String,
    #[serde(skip)]
    pub token_hash: String,
    pub xray_mode: String,
    pub status: String,
    pub last_seen_at: Option<i64>,
    pub config_version: i64,
    pub created_at: i64,
    /// 以下是 Agent 心跳带来的健康数据；没连过的服务器全是 None。
    pub agent_version: Option<String>,
    pub xray_running: Option<bool>,
    pub nginx_running: Option<bool>,
    pub load1: Option<f64>,
    pub mem_used: Option<i64>,
    pub mem_total: Option<i64>,
    pub disk_used: Option<i64>,
    pub disk_total: Option<i64>,
    pub uptime_secs: Option<i64>,
    /// Agent 到公网探测目标的 TCP 握手 RTT（毫秒）；None = 探测失败或旧 Agent。
    pub latency_ms: Option<i64>,
    pub health_at: Option<i64>,
    /// 是否允许下发 Agent 升级计划。
    pub allow_agent_upgrade: bool,
    /// 期望的 Agent 版本；NULL = 没有待执行的升级。
    pub agent_target_version: Option<String>,
    /// Agent 上报的 CPU 架构（x86_64 / aarch64）；空串 = 未知。
    pub arch: String,
    /// Agent 从 `/etc/os-release` 读到的发行版名称；NULL = 旧 Agent 或读不到。
    pub os_name: Option<String>,
    /// Agent 从 `/etc/os-release` 读到的版本号；NULL = 旧 Agent 或读不到。
    pub os_version: Option<String>,
    /// Agent 探测到的虚拟化类型（kvm / vmware / ...）；NULL = 裸机或读不到。
    pub virt: Option<String>,
    /// Agent 上报的 realm 可用性（`realm_bin` 存在且可执行）。
    /// NULL = 旧 Agent 未上报 / 从未连过；false 才是明确「没装」。
    pub realm_available: Option<bool>,
    /// Agent 上报的 realm 是否带 `transport` feature（`realm --version` 含
    /// `[transport]`）。NULL = 未知（旧 Agent / 无法判定），按不支持处理。
    pub realm_transport: Option<bool>,
    /// Agent 上报的 nftables 引擎是否可用（`nft` 存在且有 CAP_NET_ADMIN）。
    /// NULL = 旧 Agent 未上报 / 从未连过；false = 明确不可用。
    pub nftables_available: Option<bool>,
    /// Agent 上报的 P16 隧道引擎是否可用。
    /// NULL = 旧 Agent 未上报 / 从未连过；只有 true 才允许保存 tunnel 链。
    pub tunnel_available: Option<bool>,
    /// 管理员填写的国家/地区代码（ISO 3166-1 alpha-2）；NULL = 未填写。
    pub country_code: Option<String>,
    /// 服务器分组名（最长 32 个字符）；NULL = 未分组。
    ///
    /// 只是展示维度：公开探针页按它聚合，不参与鉴权或期望态下发。
    pub group_name: Option<String>,
    /// 允许的端口区间起点（含）；`None` = 该侧不设边界。
    ///
    /// 与 [`Server::port_end`]、[`Server::port_allow_json`] 一起构成允许集合：
    /// 区间 ∪ 额外端口；三者都为空才是「不限制」（旧行为）。写路径由
    /// [`crate::port_policy::PortPolicy`] 统一校验。
    pub port_start: Option<i64>,
    /// 允许的端口区间终点（含）；`None` = 该侧不设边界。
    pub port_end: Option<i64>,
    /// 区间之外额外允许的端口，JSON 数组文本（库内是 TEXT）。
    ///
    /// 对外序列化成 `port_allow` 数组；非法/损坏的值按空数组处理，避免
    /// 一个坏字段把响应变成 500。
    #[serde(rename = "port_allow", serialize_with = "port_allow_json_as_value")]
    pub port_allow_json: String,
    /// 链路跳间寻址使用的内网地址；`None` = 未填写。
    ///
    /// 只有收到该服务器作为下一跳的链路组显式开启 `use_internal_address` 时
    /// 才生效；没有填写就必须在保存链时 400，绝不静默回退公网地址。
    pub internal_address: Option<String>,
}

/// 服务器 + 该服务器的节点统计（列表页只读聚合，不落库）。
///
/// SQL 只做一次 `GROUP BY`，把每台服务器的节点数、启用数与协议串一起带出来；
/// 协议排序在这里完成，避免主控为每台服务器再查一次节点（N+1）。
#[derive(Debug, Clone)]
pub struct ServerWithNodeStats {
    pub server: Server,
    /// 该服务器上的节点总数（含停用节点）。
    pub node_count: i64,
    /// 其中 `enabled = 1` 的节点数。
    pub node_enabled_count: i64,
    /// 去重后的协议，按节点数降序、同数按名称升序，最多 4 个。
    pub node_protocols: Vec<String>,
}

impl<'r> FromRow<'r, sqlx::sqlite::SqliteRow> for ServerWithNodeStats {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
        use sqlx::Row;

        // `s.*` 先按 [`Server`] 的字段读出来；聚合列是查询里额外选择的别名。
        let server = Server::from_row(row)?;
        let raw: String = row.try_get("node_protocols_raw")?;
        Ok(Self {
            server,
            node_count: row.try_get("node_count")?,
            node_enabled_count: row.try_get("node_enabled_count")?,
            node_protocols: rank_node_protocols(&raw),
        })
    }
}

/// 把 `GROUP_CONCAT(protocol)` 的原始串排成「节点数降序 → 名称升序」。
///
/// 不在这里截断：前端要显示「+N」，必须知道完整协议种类数。截断留给展示层。
///
/// 聚合里协议出现一次就代表一个节点，所以出现次数就是该协议的节点数。
/// 空串（服务器没有节点）返回空数组；未知协议原样保留，便于排查脏数据。
pub fn rank_node_protocols(raw: &str) -> Vec<String> {
    use std::collections::HashMap;

    let mut counts: HashMap<&str, usize> = HashMap::new();
    for protocol in raw.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        *counts.entry(protocol).or_default() += 1;
    }

    let mut ranked: Vec<(&str, usize)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    ranked
        .into_iter()
        .map(|(protocol, _)| protocol.to_string())
        .collect()
}

/// 一条单跳端口转发规则（协议由 [`Forward::protocol`] 决定）。
///
/// `listen_port` 在同一个 `server_id` 内唯一；`enabled = 0` 的规则不开监听，
/// 但仍保留在库里（方便随时恢复，也继续占用端口，避免恢复时才发现冲突）。
///
/// `engine` 只允许 `native` / `realm` / `nftables`，由 `engine::normalize`
/// 在写路径校验；历史行由迁移默认成 `native`。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Forward {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub listen_port: i64,
    pub target_host: String,
    pub target_port: i64,
    pub enabled: bool,
    /// 转发引擎：`native`（Agent 自己监听）、`realm`（受管子进程）
    /// 或 `nftables`（内核 DNAT）。
    pub engine: String,
    /// 是否在同一端口号上**再**监听一个 UDP socket。
    ///
    /// 仅为兼容旧 API/旧 Agent 保留的镜像列；读写路径以 [`Forward::protocol`]
    /// 为准，新写入时由仓储按协议同步这一列，不再单独修改。
    pub udp: bool,
    /// 监听的协议：`tcp`（默认）/ `udp` / `both`。迁移 0034 之前的 `udp`
    /// 布尔位只在迁移里作为来源，之后不再参与行为判断。
    pub protocol: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 心跳缓存的一行转发运行状态（原始行）。
#[derive(Debug, Clone, FromRow)]
pub struct ForwardStatusRow {
    pub server_id: String,
    pub forward_id: String,
    pub listening: bool,
    pub error: String,
    /// 目标可达性；`None` = 还没探测过 / 旧 Agent 没上报。
    pub target_ok: Option<bool>,
    /// 加密链握手失败原因码；`None` = 未探测 / 成功 / 旧 Agent 没上报。
    pub target_error: Option<String>,
    /// 连续 `target_ok=false` 的次数；非 false 会清零。
    pub target_fail_count: i64,
    /// 逐目标探测结果的 JSON 数组（迁移 0035）；`None` = 未探测 / 旧 Agent。
    ///
    /// 仓储只负责存取这段 JSON，不解释内容：主控把它反序列化成
    /// `pierwave_proto::TargetProbe`，避免 domain 依赖线协议。
    pub targets_json: Option<String>,
    /// Agent 统计的入方向累计字节（迁移 0036）。
    /// `None` = 没有数据源（realm）/ 旧 Agent 未上报；`Some(0)` = 确实为 0。
    pub traffic_in: Option<i64>,
    /// Agent 统计的出方向累计字节（迁移 0036）；nftables / realm 为 `None`。
    pub traffic_out: Option<i64>,
    pub updated_at: i64,
}

/// 合并进列表的运行时状态：心跳里没有这条规则时为 `None`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ForwardRuntime {
    pub listening: bool,
    pub error: String,
    /// 目标可达性；`None` = 还没探测过 / 旧 Agent 没上报。
    pub target_ok: Option<bool>,
    /// 加密链握手失败原因码；`None` = 未探测 / 成功 / 旧 Agent 没上报。
    pub target_error: Option<String>,
    /// 连续两次目标不可达。
    pub degraded: bool,
    pub updated_at: i64,
}

/// 转发列表视图：规则字段平铺，运行时状态放在 `runtime`，没有心跳时为 `null`。
#[derive(Debug, Clone, Serialize)]
pub struct ForwardView {
    #[serde(flatten)]
    pub forward: Forward,
    pub runtime: Option<ForwardRuntime>,
}

/// 一条线性多跳链。跳（组）的配置在 `chain_groups`，这里只放链级字段。
///
/// `engine` 是整条链的引擎：推导时透传到每一跳的 `DesiredForward`，
/// 不支持一条链里混用两种引擎（同一台服务器上的不同链可以不同）。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Chain {
    pub id: String,
    pub name: String,
    pub target_host: String,
    pub target_port: i64,
    pub enabled: bool,
    /// 链的转发引擎：`native`、`realm` 或 `nftables`。
    pub engine: String,
    /// 整条链是否同时监听 UDP：推导时透传到每一跳（每跳用各自的 `listen_port`）。
    ///
    /// 仅为兼容旧 API/旧 Agent 保留的镜像列；行为以 [`Chain::protocol`] 为准。
    pub udp: bool,
    /// 整条链的协议：`tcp`（默认）/ `udp` / `both`，推导时原样透传到每一跳。
    pub protocol: String,
    /// 跳间加密模式：`none`（默认，明文）或 `tls`（单向 TLS）。
    pub transport: String,
    /// P16 隧道引擎的安全模式：`tls`（默认，自有 CA）或 `noise`（Noise/PSK）。
    ///
    /// 只对 `engine = tunnel` 有意义；历史行由迁移 0038 默认成 `tls`，
    /// 读路径遇到未知值回落 `tls`（见 [`crate::tunnel_security`]）。
    pub tunnel_security: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 链里的一「组」：组内 1..N 台服务器，由上一跳按 `strategy` 选一台。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ChainGroup {
    pub id: String,
    pub chain_id: String,
    /// 组在链里的顺序，0 = 入口组。
    pub seq: i64,
    /// 可选展示名。
    pub name: Option<String>,
    /// 选路策略（`round_robin` / `failover` / `lowest_latency` / `ip_hashed`）。
    pub strategy: String,
    /// 该组 realm 监听使用的证书 id；`None` = 明文。入口组（seq = 0）必须为 `None`。
    pub cert_id: Option<String>,
    /// 入口组的公网展示端口；`None` = 与入口成员的 `listen_port` 相同。
    ///
    /// 仅 `seq = 0` 有意义，且**只用于展示**（链列表 / 拓扑入口列）；
    /// 链下发仍然只用 `chain_group_members.listen_port`。
    pub public_port: Option<i64>,
    /// 该组是否用**成员服务器的内网地址**被上一跳寻址。
    ///
    /// 每组一个开关：开启后，上一跳下发的 target 使用本组成员的
    /// `servers.internal_address`；本组任一成员没填内网地址时保存链直接 400。
    /// 入口组（seq = 0）没有上一跳，开关不产生地址变化。默认 false = 旧行为。
    pub use_internal_address: bool,
}

/// 组内一个成员 + 推导/展示所需的服务器字段。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ChainGroupMember {
    pub group_id: String,
    pub chain_id: String,
    /// 所属组的 seq；按组聚合时用。
    pub seq: i64,
    /// 所属组的策略；下发时取**下一组**的它。
    pub strategy: String,
    pub server_id: String,
    pub server_name: String,
    /// 下一跳 target 用；只给下发/校验，不直接出现在 API 响应里。
    pub server_address: String,
    /// 该成员服务器的内网地址；`None` = 未填写。组开关开启时用它替代
    /// [`ChainGroupMember::server_address`] 作为上一跳的 target。
    pub server_internal_address: Option<String>,
    pub listen_port: i64,
    /// 主备用：小的优先。
    pub priority: i64,
    /// 预留给加权，本轮只存不用。
    pub weight: i64,
    /// 该成员所在服务器的 realm transport 能力缓存（NULL = 未知）。
    /// 下发 TLS 链前必须逐台检查，未知按不支持处理。
    pub realm_transport: Option<bool>,
    /// 该成员所在服务器的 nftables 能力缓存（NULL = 未知）。
    /// nftables 链下发前逐台检查，未知按不支持处理。
    pub nftables_available: Option<bool>,
    /// 该成员所在服务器的 P16 隧道能力缓存（NULL = 未知）。
    /// tunnel 链下发前逐台检查，未知按不支持处理（旧 Agent 直接拒绝保存）。
    pub tunnel_available: Option<bool>,
    /// 该成员所在服务器的最后一次心跳（Unix 秒）；`None` = 从未连过。
    /// 链视图把它格式化成 ISO8601 字符串对外返回。
    pub last_seen_at: Option<i64>,
}

/// 一个有成员的组。
#[derive(Debug, Clone)]
pub struct ChainGroupWithMembers {
    pub group: ChainGroup,
    pub members: Vec<ChainGroupMember>,
}

/// 一条链及其按 `seq` 升序的组。
#[derive(Debug, Clone)]
pub struct ChainWithGroups {
    pub chain: Chain,
    pub groups: Vec<ChainGroupWithMembers>,
}

/// 另一条链已经占用了某台服务器的某个监听端口。
#[derive(Debug, Clone, FromRow)]
pub struct ChainMemberPortConflict {
    pub chain_id: String,
    pub chain_name: String,
    pub seq: i64,
    pub listen_port: i64,
}

/// 一次 Agent 自升级尝试。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct AgentUpgrade {
    pub id: String,
    pub server_id: String,
    pub from_version: String,
    pub to_version: String,
    /// pending | succeeded | failed
    pub status: String,
    pub error: String,
    /// 第一次看到「目标版本已生效」的时间；稳定窗口从这里开始计时。
    pub confirmed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 一次批量 Agent 升级。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct AgentUpgradeBatch {
    pub id: String,
    /// 各台起始版本可能不同，批量层留空。
    pub from_version: String,
    pub to_version: String,
    /// running | succeeded | failed | cancelled
    pub status: String,
    pub stop_on_failure: bool,
    pub concurrency: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 批量升级里的一台服务器。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct AgentUpgradeBatchItem {
    pub batch_id: String,
    pub server_id: String,
    pub upgrade_id: Option<String>,
    /// queued | running | succeeded | failed | skipped | cancelled
    pub status: String,
    pub error: String,
    pub updated_at: i64,
}

/// 批次详情里的 item：额外带服务器名与当前 Agent 版本，前端不用二次查询。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct AgentUpgradeBatchItemView {
    pub batch_id: String,
    pub server_id: String,
    pub server_name: String,
    pub agent_version: Option<String>,
    pub upgrade_id: Option<String>,
    pub status: String,
    pub error: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Node {
    pub id: String,
    pub server_id: String,
    pub tag: String,
    pub name: String,
    pub protocol: String,
    pub transport: String,
    pub security: String,
    pub port: i64,
    /// 订阅里给用户看的对外端口；`None` = 与 [`Node::port`] 相同。
    ///
    /// NAT 机器上监听端口（`port`）与公网端口往往不同；这里只影响订阅与展示，
    /// Agent 仍然只按 `port` 监听。
    pub public_port: Option<i64>,
    /// 库里存的是 JSON 文本；对外直接暴露成 JSON 对象，前端不用二次 parse。
    #[serde(rename = "config", serialize_with = "config_json_as_value")]
    pub config_json: String,
    pub enabled: i64,
    pub created_at: i64,
    /// 绑定的证书 id；`security = tls` 的节点必须非空（接口层校验）。
    pub cert_id: Option<String>,
    /// 节点带宽上限（kbps）。`None` / `0` = 不限；由 Agent 用 tc 精确限速。
    pub bandwidth_kbps: Option<i64>,
}

/// 服务器上的一条自定义出站。
///
/// `tag` / `protocol` 是权威字段：`config_json` 在生成配置时被合并进出站对象，
/// 但同名键一律以这两列为准（和 [`Node`] 的 tag/port/protocol 处理方式一致）。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Outbound {
    pub id: String,
    pub server_id: String,
    pub tag: String,
    pub protocol: String,
    /// 库里存 JSON 文本，对外直接暴露成 `config` 对象。
    #[serde(rename = "config", serialize_with = "config_json_as_value")]
    pub config_json: String,
    pub enabled: i64,
    pub created_at: i64,
}

/// 服务器上的一条路由规则。
///
/// `inbound_tag` / `domain` / `ip` 至少一个非空；`domain` / `ip` 是逗号分隔的
/// Xray 匹配串。生成配置时按 `sort_order, created_at` 顺序接在 api 规则后面。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct RoutingRule {
    pub id: String,
    pub server_id: String,
    pub sort_order: i64,
    pub inbound_tag: Option<String>,
    pub domain: Option<String>,
    pub ip: Option<String>,
    pub outbound_tag: String,
    pub enabled: i64,
    pub created_at: i64,
}

/// 上传的证书：私钥只落库，任何列表/详情视图都不带出去。
#[derive(Debug, Clone, FromRow)]
pub struct Certificate {
    pub id: String,
    pub name: String,
    /// JSON 数组文本，对外由 [`CertificateView`] 展开。
    pub domains: String,
    pub cert_pem: String,
    pub key_pem: String,
    pub not_before: i64,
    pub not_after: i64,
    pub created_at: i64,
}

/// 证书元数据视图：**没有** `cert_pem` / `key_pem`。
///
/// `days_left` 由仓储按调用时刻算好，口径见 `certificate::days_left`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CertificateView {
    pub id: String,
    pub name: String,
    pub domains: Vec<String>,
    pub not_before: i64,
    pub not_after: i64,
    pub days_left: i64,
    pub has_key: bool,
    pub created_at: i64,
}

/// 审计日志的原始行：`detail` 是库里存的 JSON 文本，`actor_name` 靠 LEFT JOIN 带出。
///
/// 单独拆一行模型是因为 `detail` 需要在读出后解析成 JSON 对象再对外，
/// 而 sqlx 不会替我们做这层转换。
#[derive(Debug, Clone, FromRow)]
pub struct AuditRow {
    pub id: String,
    pub actor_id: Option<String>,
    pub actor_name: Option<String>,
    pub action: String,
    pub target: Option<String>,
    pub detail: Option<String>,
    pub created_at: i64,
}

/// 审计日志对外视图：`detail` 已解析成 JSON 对象（解析失败时保留原始字符串）。
#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub id: String,
    pub actor_id: Option<String>,
    pub actor_name: Option<String>,
    pub action: String,
    pub target: Option<String>,
    pub detail: Option<Value>,
    pub created_at: i64,
}

impl From<AuditRow> for AuditEntry {
    fn from(row: AuditRow) -> Self {
        Self {
            id: row.id,
            actor_id: row.actor_id,
            actor_name: row.actor_name,
            action: row.action,
            target: row.target,
            detail: row
                .detail
                .map(|raw| serde_json::from_str(&raw).unwrap_or(Value::String(raw))),
            created_at: row.created_at,
        }
    }
}

/// 管理员视角的全局节点列表项：节点 + 所属服务器名（选择器要按服务器分组）。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct NodeListItem {
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub node: Node,
    pub server_name: String,
    /// 所属服务器地址（JOIN servers 带出，只读）。
    ///
    /// 建链时的「从节点选择」用它回填 `target_host`；不落 `nodes` 表，
    /// 服务器地址变更后无需同步节点行。
    pub server_address: String,
}

/// 订阅装配用：节点 + 所属服务器地址。
///
/// 订阅端点要跨服务器取节点，地址不在 `nodes` 表里，靠 JOIN 一次带出，
/// 避免 master 里出现 N+1 或直接写 SQL。
#[derive(Debug, Clone, FromRow)]
pub struct NodeWithServer {
    #[sqlx(flatten)]
    pub node: Node,
    pub server_address: String,
}

fn config_json_as_value<S>(raw: &str, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let value =
        serde_json::from_str::<serde_json::Value>(raw).unwrap_or_else(|_| serde_json::json!({}));
    value.serialize(serializer)
}

/// `servers.port_allow_json`（TEXT）→ 响应里的 `port_allow` 数组。
///
/// 损坏的值按空数组输出，避免一个坏字段让整台服务器的响应变成 500；
/// 写路径总是写规范化的升序数组（见 [`crate::port_policy::PortPolicy`]）。
fn port_allow_json_as_value<S>(raw: &str, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let value = serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .filter(serde_json::Value::is_array)
        .unwrap_or_else(|| serde_json::json!([]));
    value.serialize(serializer)
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Package {
    pub id: String,
    pub name: String,
    pub quota_bytes: Option<i64>,
    pub period_days: Option<i64>,
    pub direction: String,
    pub node_ratio: f64,
    /// 套餐限速档位（kbps）。`None` / `0` = 不限；只能映射成 Xray
    /// `policy.levels.N.bufferSize`，是近似限速而不是精确带宽。
    pub speed_limit_kbps: Option<i64>,
    /// 套餐级规则模板绑定；`null` = 套餐内用户未单独指定时跟随全局默认。
    pub rule_template_id: Option<String>,
    pub created_at: i64,
    /// 当前仍引用该套餐模板的实例数。
    ///
    /// `packages::list` / `find_by_id` 用一条聚合查询带出，前端删除前据此提前禁用按钮。
    pub user_count: i64,
    /// 显式绑定的节点 id（升序）；未设范围时为空，此时该套餐可见全部节点。
    ///
    /// 与 [`Self::node_count`] 搭配才能区分「未设范围」和「显式一个都不给」：
    /// 前者 `node_ids` 为空但 `node_count` 是全部节点数，后者两者都为 0。
    #[sqlx(skip)]
    pub node_ids: Vec<String>,
    /// 实际可见节点数：未设范围时 = 全部节点数；显式空范围时 = 0。
    #[sqlx(skip)]
    pub node_count: usize,
    /// `all` = 未设范围（含以后新增的节点）；`custom` = 显式设过范围。
    ///
    /// 只靠 `node_ids`/`node_count` 在「系统里一个节点都没有」时无法区分
    /// 「全部」和「一个都不给」，这个字段把意图直接暴露出来。
    #[sqlx(skip)]
    pub node_scope: String,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct UserPackage {
    pub id: String,
    pub user_id: String,
    pub package_id: String,
    pub quota_override: Option<i64>,
    pub used_bytes: i64,
    pub direction: String,
    pub node_ratio: f64,
    pub expires_at: Option<i64>,
    pub reset_day: Option<i64>,
    pub status: String,
    pub created_at: i64,
}

/// 套餐实例视图：join 套餐模板带出名称与「生效额度」。
///
/// `quota_bytes` 是生效值：`quota_override` 为空时沿用套餐额度；
/// 显式写 0 原样返回 0，由展示层按「显式不限」处理（区别于 null 的继承语义）。
/// `quota_override` 同时原样回显，前端才能把「改回继承」表达成显式 `null`。
///
/// `status` 是**计算值**（`active | expired | exhausted | disabled`），库里存的
/// 原始状态在 `raw_status` 里，不对外暴露。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct UserPackageView {
    pub id: String,
    /// 仅用于按用户分组装配，不对外暴露。
    #[serde(skip)]
    pub user_id: String,
    pub package_id: String,
    pub package_name: String,
    /// 原始覆写值：null = 继承套餐额度，0 = 显式不限，N = 覆写。
    pub quota_override: Option<i64>,
    pub quota_bytes: Option<i64>,
    pub used_bytes: i64,
    pub expires_at: Option<i64>,
    pub reset_day: Option<i64>,
    /// 库里存的原始状态，只用于计算 `status`。
    #[serde(skip)]
    pub raw_status: String,
    /// 视图层计算后的状态，见 [`UserPackageView::status_at`]。
    #[sqlx(default)]
    pub status: String,
    pub direction: String,
    pub node_ratio: f64,
}

/// 计算套餐实例状态所需的最小事实；视图与订阅授权共用同一套口径。
///
/// 顺序即优先级：`disabled` > `expired` > `exhausted` > `active`。
pub fn package_status_at(
    raw_status: &str,
    expires_at: Option<i64>,
    quota_bytes: Option<i64>,
    used_bytes: i64,
    now: i64,
) -> &'static str {
    if raw_status != "active" {
        return "disabled";
    }
    if expires_at.is_some_and(|expires_at| expires_at <= now) {
        return "expired";
    }
    // 0 表示显式不限，不算用尽；只有正额度且已用 >= 额度才算 exhausted。
    if quota_bytes.is_some_and(|quota| quota > 0 && used_bytes >= quota) {
        return "exhausted";
    }
    "active"
}

/// 套餐实例是否还能用（订阅资格/下发的唯一口径）。
pub fn package_is_usable_at(
    raw_status: &str,
    expires_at: Option<i64>,
    quota_bytes: Option<i64>,
    used_bytes: i64,
    now: i64,
) -> bool {
    package_status_at(raw_status, expires_at, quota_bytes, used_bytes, now) == "active"
}

impl UserPackageView {
    /// 按给定时刻计算状态。
    pub fn status_at(&self, now: i64) -> &'static str {
        package_status_at(
            &self.raw_status,
            self.expires_at,
            self.quota_bytes,
            self.used_bytes,
            now,
        )
    }

    /// 用给定时刻的状态覆盖 `status` 字段；仓储在读出原始行后统一调用。
    pub fn resolve_status(mut self, now: i64) -> Self {
        self.status = self.status_at(now).to_string();
        self
    }

    /// 该实例当前是否还能用（订阅资格判定复用它）。
    pub fn is_usable(&self) -> bool {
        self.is_usable_at(crate::time::now())
    }

    pub fn is_usable_at(&self, now: i64) -> bool {
        self.status_at(now) == "active"
    }
}

/// 规则模板的原始行：`rules` 是库里存的 JSON 数组文本。
///
/// 单独拆一行模型是因为 `rules` 需要在读出后解析成数组再对外，
/// 和 [`AuditRow`] / [`Certificate`] 的处理方式一致。
#[derive(Debug, Clone, FromRow)]
pub struct RuleTemplateRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub rules: String,
    pub is_default: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 规则模板对外视图：`rules` 已解析成字符串数组，`is_default` 是布尔值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuleTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub rules: Vec<String>,
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<RuleTemplateRow> for RuleTemplate {
    fn from(row: RuleTemplateRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            description: row.description,
            // 写入前都过校验，脏数据（手工改库）退化成空数组而不是 500。
            rules: serde_json::from_str(&row.rules).unwrap_or_default(),
            is_default: row.is_default != 0,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// 用户列表/详情视图：用户本体 + 名下所有套餐实例（一次查询装配）。
#[derive(Debug, Clone, Serialize)]
pub struct UserView {
    pub id: String,
    pub username: String,
    pub role: String,
    pub status: String,
    pub short_code: String,
    pub quota_bytes: Option<i64>,
    pub used_bytes: i64,
    /// 用户级规则模板绑定；订阅解析从这一级开始（`?rule=` 之后）。
    pub rule_template_id: Option<String>,
    pub created_at: i64,
    /// 名下套餐实例数；与 `packages.len()` 一致，方便前端分页/汇总时少算一次。
    pub package_count: i64,
    pub packages: Vec<UserPackageView>,
    /// 是否已超出账户总额度（`users.quota_bytes` 非空且 `used_bytes >= quota_bytes`）。
    /// 由后端算，前端不要自己拿 used/quota 去比。
    pub quota_exceeded: bool,
    /// 名下套餐实例的额度合计；`null` 表示其中至少一张不限量（合计也就无上限）。
    pub package_quota_bytes: Option<i64>,
    /// 名下套餐实例的已用合计。
    pub package_used_bytes: i64,
    /// 名下实例里最严重的状态：`exhausted > expired > disabled > active`；无实例为 `none`。
    ///
    /// 用户被断流时 `users.status` 仍是 `active`，只看账号状态会漏掉真正的问题。
    pub package_worst_status: String,
}

impl From<(User, Vec<UserPackageView>)> for UserView {
    fn from((user, packages): (User, Vec<UserPackageView>)) -> Self {
        Self {
            id: user.id,
            username: user.username,
            role: user.role,
            status: user.status,
            short_code: user.short_code,
            quota_bytes: user.quota_bytes,
            used_bytes: user.used_bytes,
            rule_template_id: user.rule_template_id,
            created_at: user.created_at,
            package_count: packages.len() as i64,
            quota_exceeded: user
                .quota_bytes
                .is_some_and(|quota| user.used_bytes >= quota),
            package_quota_bytes: aggregate_quota(&packages),
            package_used_bytes: packages.iter().map(|p| p.used_bytes).sum(),
            package_worst_status: worst_status(&packages).to_string(),
            packages,
        }
    }
}

/// PATCH 请求字段的三态：字段缺失 / 显式 null / 具体值。
///
/// 只用 `Option<T>` 无法区分「没传」和「传了 null」，而 PATCH 语义要求
/// 后者把可空列清空，所以这里显式建模。`#[serde(default)]` 负责缺失态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Patch<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<T> Patch<T> {
    pub fn is_set(&self) -> bool {
        !matches!(self, Self::Missing)
    }

    /// 转成要写库的值：缺失与 null 都是 `None`，调用方用 `is_set()` 区分是否更新。
    pub fn value(self) -> Option<T> {
        match self {
            Self::Value(value) => Some(value),
            Self::Missing | Self::Null => None,
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

/// 登录后的当前用户视图（不含密码哈希）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUser {
    pub id: String,
    pub username: String,
    pub role: String,
    pub short_code: String,
}

/// 管理端概览：只放聚合后的计数，不携带任何明细行。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Overview {
    pub servers: ServerStats,
    pub users: UserStats,
    pub packages: PackageStats,
    pub traffic: TrafficStats,
    pub alerts: AlertStats,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ServerStats {
    pub total: i64,
    pub online: i64,
}

/// 公开状态页的汇总数字。
///
/// 刻意不包含用户/套餐/证书等管理端口径：这个结构会被原样序列化到
/// 无需登录的 `/api/v1/public/status`，字段本身即白名单。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PublicSummary {
    pub servers_total: i64,
    pub servers_online: i64,
    pub nodes_total: i64,
    pub traffic_today: i64,
    pub traffic_month: i64,
}

/// 一条服务器采样（调度器每 5 分钟写一行）。
#[derive(Debug, Clone, PartialEq, FromRow)]
pub struct ServerSample {
    pub server_id: String,
    pub ts: i64,
    pub online: bool,
    pub load1: f64,
    pub mem_used: i64,
    pub mem_total: i64,
    pub disk_used: i64,
    pub disk_total: i64,
    /// 采样时刻的 TCP 握手 RTT（毫秒）；NULL = 当时没有有效探测结果。
    pub latency_ms: Option<i64>,
}

/// 一台服务器在 24h / 7d 窗口内的可用率；没有采样时对应字段为 `None`。
#[derive(Debug, Clone, FromRow)]
pub struct ServerUptime {
    pub server_id: String,
    pub uptime_24h: Option<f64>,
    pub uptime_7d: Option<f64>,
}

/// 一台服务器某个小时桶内的平均在线比例。
#[derive(Debug, Clone, FromRow)]
pub struct ServerHourlyBucket {
    pub server_id: String,
    /// 小时起点（Unix 秒，整点）。
    pub ts: i64,
    pub online_ratio: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct UserStats {
    pub total: i64,
    pub active: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PackageStats {
    /// 套餐模板数。
    pub total: i64,
    /// 已售出的套餐实例数（user_packages 行数）。
    pub instances: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TrafficStats {
    /// 今天（UTC+8）的加权流量。
    pub today_bytes: i64,
    /// 本月（UTC+8）的加权流量。
    pub month_bytes: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct AlertStats {
    pub expired_instances: i64,
    pub exhausted_instances: i64,
    pub offline_servers: i64,
    /// 30 天内到期（含已过期）的证书数；没有证书时恒为 0。
    pub expiring_certs: i64,
}

/// 趋势图的一天：`date` 是 UTC+8 自然日，缺数据的天由仓储补 0。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TrafficDay {
    pub date: String,
    pub uplink: i64,
    pub downlink: i64,
    pub weighted: i64,
}

/// 节点维度流量聚合（`days` 窗口内），附带今日/本月加权值。
///
/// `node_tag` 来自 `traffic_node_daily`，节点元数据来自 `nodes` JOIN；节点一旦
/// 删除，历史行仍在库里但不会再出现在列表/详情里（详见迁移 0009 的注释）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, FromRow)]
pub struct NodeTrafficRow {
    pub node_id: String,
    pub node_tag: String,
    pub name: String,
    pub server_id: String,
    pub server_name: String,
    pub protocol: String,
    pub transport: String,
    pub security: String,
    pub uplink: i64,
    pub downlink: i64,
    pub weighted: i64,
    pub today_bytes: i64,
    pub month_bytes: i64,
}

/// 某节点下单个用户的流量切片（`days` 窗口内，按 `weighted` 降序）。
///
/// `user_id = ''` 的无法归因流量不会出现在这里，但仍计入节点总量。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, FromRow)]
pub struct NodeUserRow {
    pub user_id: String,
    pub username: String,
    pub uplink: i64,
    pub downlink: i64,
    pub weighted: i64,
}

/// 一条断流事件：某用户被从某台服务器的下发配置中移除，或重新加回。
///
/// `kind` 是 `removed` / `restored`；`message` 是落库时定稿的中文说明，前端直接
/// 展示即可；`reason` 保留机器可读的原因码（`exhausted` / `expired` / `disabled` /
/// `inactive` / `recovered`，多因逗号分隔）供筛选/统计使用。
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct EnforcementEvent {
    pub id: String,
    /// `removed` | `restored`。
    pub kind: String,
    pub user_id: String,
    pub username: String,
    pub server_id: String,
    pub server_name: String,
    pub reason: String,
    pub message: String,
    pub created_at: i64,
}

/// 套餐实例额度合计：任意一张不限量（生效额度为 `None` 或 `0`）则整体不限。
fn aggregate_quota(packages: &[UserPackageView]) -> Option<i64> {
    let mut total: i64 = 0;
    for package in packages {
        match package.quota_bytes {
            Some(quota) if quota > 0 => total = total.saturating_add(quota),
            _ => return None,
        }
    }
    Some(total)
}

/// 取最严重状态；顺序与「影响用户的程度」一致。
fn worst_status(packages: &[UserPackageView]) -> &'static str {
    if packages.is_empty() {
        return "none";
    }
    let has = |status: &str| packages.iter().any(|p| p.status == status);
    if has("exhausted") {
        "exhausted"
    } else if has("expired") {
        "expired"
    } else if has("disabled") {
        "disabled"
    } else {
        "active"
    }
}

#[cfg(test)]
mod view_tests {
    use super::*;

    fn package(id: &str, quota: Option<i64>, used: i64, status: &str) -> UserPackageView {
        UserPackageView {
            id: id.into(),
            user_id: "u1".into(),
            package_id: "p1".into(),
            package_name: "月卡".into(),
            quota_override: None,
            quota_bytes: quota,
            used_bytes: used,
            expires_at: None,
            reset_day: None,
            raw_status: "active".into(),
            status: status.into(),
            direction: "both".into(),
            node_ratio: 1.0,
        }
    }

    fn user(packages: Vec<UserPackageView>) -> UserView {
        UserView::from((
            User {
                id: "u1".into(),
                username: "alice".into(),
                password_hash: String::new(),
                role: "user".into(),
                status: "active".into(),
                short_code: "abc".into(),
                short_code_updated_at: 0,
                quota_bytes: None,
                used_bytes: 0,
                rule_template_id: None,
                created_at: 0,
                updated_at: 0,
            },
            packages,
        ))
    }

    #[test]
    fn aggregates_package_quota_and_usage() {
        let view = user(vec![
            package("a", Some(100), 40, "active"),
            package("b", Some(200), 10, "active"),
        ]);
        assert_eq!(view.package_quota_bytes, Some(300));
        assert_eq!(view.package_used_bytes, 50);
        assert_eq!(view.package_worst_status, "active");
    }

    #[test]
    fn unlimited_instance_makes_total_unlimited() {
        let view = user(vec![
            package("a", Some(100), 40, "active"),
            package("b", Some(0), 10, "active"),
        ]);
        assert_eq!(view.package_quota_bytes, None, "0 表示显式不限");
    }

    #[test]
    fn worst_status_is_visible_even_when_account_is_active() {
        let view = user(vec![
            package("a", Some(100), 100, "exhausted"),
            package("b", Some(200), 10, "active"),
        ]);
        assert_eq!(
            view.package_worst_status, "exhausted",
            "账号是 active，但用户已被断流"
        );
        assert!(!view.quota_exceeded, "账户级额度未设，不算超额");
    }

    #[test]
    fn no_packages_is_none() {
        let view = user(vec![]);
        assert_eq!(view.package_worst_status, "none");
        assert_eq!(view.package_quota_bytes, Some(0));
    }
}
