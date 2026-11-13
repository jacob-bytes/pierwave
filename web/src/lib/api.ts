import { t } from "@/i18n";
import type { AgentUpgradeStatus } from "@/lib/agentUpgrade";
import type { AlertTestResult } from "@/lib/alerts";
import type {
  AgentUpgradeBatchItemStatus,
  AgentUpgradeBatchStatus,
} from "@/lib/agentUpgradeBatch";
import { ApiError } from "@/lib/apiError";
import type { ChainStrategy } from "@/lib/chains";

export { ApiError } from "@/lib/apiError";

/** 后端错误响应形状：`error` 是中文兜底，`code` / `params` 可选。 */
interface ErrorBody {
  error?: string;
  code?: string;
  params?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从响应体构造 ApiError：保留旧的 `error` 文案，同时带上 `code` 与
 * `params`，供 `errors.ts` 按当前语言翻译。字段类型不对时忽略。
 */
function toApiError(body: unknown, status: number): ApiError {
  const record = isRecord(body) ? body : {};
  const message =
    typeof record.error === "string" && record.error.trim()
      ? record.error
      : t("common.requestFailed", { status });
  const code =
    typeof record.code === "string" && record.code.trim()
      ? record.code
      : undefined;
  const params = isRecord(record.params) ? record.params : undefined;
  return new ApiError(message, status, code, params);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw toApiError(body, res.status);
  }
  return body as T;
}

/**
 * P7：上传备份文件。
 *
 * body 直接是文件字节（不套 FormData），所以不能复用 `request`：
 * 它固定发 JSON，并把响应体无条件当 JSON 读。这里单独解析，
 * 后端返回非 JSON（例如网关的 413 HTML）时回落到通用错误文案。
 */
async function uploadBinary<T>(path: string, file: Blob): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const text = await res.text();
  let body: ErrorBody | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as ErrorBody;
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    throw toApiError(body, res.status);
  }
  return body as T;
}

/**
 * P7：备份与恢复，见 docs/PLAN.md「P7：备份与恢复」。
 *
 * 备份 = 单个 SQLite 文件；恢复只落盘为待恢复文件，主控重启后才替换。
 * 后端可能暂时 404：页面按中文错误态兜底，不写 mock 数据。
 */
export interface BackupPending {
  /** 待恢复文件上传完成的 Unix 秒。 */
  uploaded_at: number;
  /** 待恢复文件大小（字节）。 */
  bytes: number;
}

export interface BackupInfo {
  /** 当前数据库文件大小（字节）。 */
  db_bytes: number;
  /** 非空表示已经上传、等待重启生效。 */
  pending: BackupPending | null;
}

export interface RestoreBackupResponse {
  restart_required: boolean;
  /** 后端可能直接带回待恢复详情；没有时前端用文件大小兜底展示。 */
  pending?: BackupPending | null;
}

export interface SessionUser {
  id: string;
  username: string;
  role: "admin" | "user";
  short_code: string;
}

export interface Health {
  status: string;
  version: string;
  /** 面板名称（公开接口，登录页在未鉴权时也要显示）。 */
  panel_name?: string;
}

/** P10：公开状态页的汇总数字，字段本身即白名单。 */
export interface PublicStatusSummary {
  servers_total: number;
  servers_online: number;
  nodes_total: number;
  traffic_today: number;
  traffic_month: number;
}

/** P10：公开状态页的单个小时桶；没有采样的小时为 null。 */
export interface PublicStatusBucket {
  /** 小时起点（Unix 秒，整点）。 */
  ts: number;
  /** 该小时内的平均在线比例，0..1。 */
  online_ratio: number;
}

/**
 * P10：公开状态页里的一台服务器。只包含白名单字段，不含地址与 token；
 * `load1` / `mem_*` / `disk_*` / `uptime_secs` / `last_seen` 可能在离线或
 * 从未上报时为 null。
 */
export interface PublicStatusServer {
  id: string;
  name: string;
  online: boolean;
  xray_running: boolean | null;
  load1: number | null;
  mem_used: number | null;
  mem_total: number | null;
  disk_used: number | null;
  disk_total: number | null;
  uptime_secs: number | null;
  last_seen: number | null;
  /**
   * Agent 到公网探测目标的 TCP 握手 RTT（毫秒）。
   * null = 这轮探测失败或旧 Agent 不上报；前端不显示该项。
   */
  latency_ms: number | null;
  /** 管理员填写的国家/地区代码（ISO 3166-1 alpha-2）；未填写为 null。 */
  country_code: string | null;
  /** Agent 上报的发行版名称；旧 Agent 或读不到为 null。 */
  os_name: string | null;
  /** Agent 上报的发行版版本；旧 Agent 或读不到为 null。 */
  os_version: string | null;
  /** Agent 上报的虚拟化类型；裸机或读不到为 null。 */
  virt: string | null;
  /** Agent 上报的 CPU 架构；旧 Agent 为空串。 */
  arch: string;
  /** 0..1，窗口内没有采样时为 null。 */
  uptime_24h: number | null;
  /** 0..1，窗口内没有采样时为 null。 */
  uptime_7d: number | null;
  /** 固定 24 个元素，从最早的小时到当前小时。 */
  buckets_24h: (PublicStatusBucket | null)[];
  /**
   * 所属分组；未分组为 null。旧后端不返回该字段（也能据此隐藏分组筛选）。
   */
  group_name?: string | null;
}

/** 公开状态页的分组聚合；`name = null` 是未分组。 */
export interface PublicStatusGroup {
  name: string | null;
  servers: number;
  online: number;
  /** 0..1，窗口内没有采样时为 null。 */
  uptime_24h: number | null;
}

/** P10：`GET /api/v1/public/status`，无需登录。 */
export interface PublicStatus {
  panel_name: string;
  /** 生成时间（Unix 秒）。 */
  generated_at: number;
  summary: PublicStatusSummary;
  servers: PublicStatusServer[];
  /** 旧后端可能不返回；页面据此决定是否画分组聚合。 */
  groups?: PublicStatusGroup[];
}

/** 主控生成的 Agent 运维命令；`install` 只在创建/重置后返回一次。 */
export interface ServerCommands {
  install: string | null;
  upgrade: string;
  uninstall: string;
  stop: string;
  restart: string;
}

export interface Server {
  id: string;
  name: string;
  address: string;
  xray_mode: string;
  status: "online" | "offline";
  last_seen_at: number | null;
  config_version: number;
  created_at: number;

  /** 分组名；null = 未分组。旧后端可能不返回该字段。 */
  group_name?: string | null;
  /** Agent 运维命令；旧后端可能不返回该字段。 */
  commands?: ServerCommands;

  /* 以下字段来自 Agent 心跳；从未连过的服务器整组为 null。 */
  agent_version: string | null;
  /** P4：是否允许主控向该服务器下发 Agent 升级；默认关闭。 */
  allow_agent_upgrade: boolean;
  /** P4：期望的 Agent 版本；null 表示当前没有待执行的升级。 */
  agent_target_version: string | null;
  xray_running: boolean | null;
  nginx_running: boolean | null;
  /** 1 分钟平均负载。 */
  load1: number | null;
  mem_used: number | null;
  mem_total: number | null;
  disk_used: number | null;
  disk_total: number | null;
  uptime_secs: number | null;
  /** Agent 到公网探测目标的 TCP 握手 RTT（毫秒）；null = 未上报或探测失败。 */
  latency_ms: number | null;
  /** 最后一次心跳的 Unix 秒。 */
  health_at: number | null;
  /** Agent 上报的 CPU 架构；空串 = 未知。 */
  arch: string;
  /**
   * 服务器上是否安装了 realm（realm 转发引擎必需）。
   * true = 已安装；false = 明确未安装；null / 缺失 = 旧 Agent 未上报。
   * 这是静态环境事实，与规则运行时的 `runtime.error` 是两回事。
   */
  realm_available?: boolean | null;
  /**
   * 服务器上是否有可用的 nftables（`nft` 存在且 Agent 有 CAP_NET_ADMIN）。
   * true = 可用；false = 明确不可用；null / 缺失 = 旧 Agent 未上报。
   */
  nftables_available?: boolean | null;
  /**
   * 服务器上的 Agent 是否支持 P16 tunnel 引擎。
   * 只有明确 `true` 才能参与 tunnel 链；`false` / `null` / 缺失都按不支持处理。
   */
  tunnel_available?: boolean | null;
  /** Agent 从 /etc/os-release 读到的发行版名称；null = 旧 Agent 或读不到。 */
  os_name: string | null;
  /** Agent 从 /etc/os-release 读到的版本号；null = 旧 Agent 或读不到。 */
  os_version: string | null;
  /** Agent 探测到的虚拟化类型；null = 裸机或读不到。 */
  virt: string | null;
  /** 管理员填写的国家/地区代码（ISO 3166-1 alpha-2）；null = 未填写。 */
  country_code: string | null;
}

export interface UpdateServerInput {
  /** P4：只允许改「是否允许下发升级」；其余字段后端暂未开放。 */
  allow_agent_upgrade?: boolean;
  /** ISO 3166-1 alpha-2；空串 = 清空。 */
  country_code?: string;
  /** 分组名；null = 清空分组。 */
  group_name?: string | null;
}

export interface CreateServerResponse {
  server: Server;
  token: string;
  install_command: string;
}

/** `POST /api/v1/servers/{id}/token`：旧 token 立即失效，返回新的安装命令。 */
export interface ResetServerTokenResponse {
  token: string;
  install_command: string;
}

/**
 * P4：Agent 自升级，见 docs/PLAN.md「P4：Agent 自升级」。
 *
 * `agent_target_version` 是服务器上的期望版本，`AgentUpgrade` 是一次升级的
 * 流水；`status = pending` 时列表会每 15 秒刷新，直到 Agent 回报结果。
 */
export interface AgentUpgrade {
  id: string;
  server_id: string;
  from_version: string;
  to_version: string;
  /** 后端未来新增状态时前端按 unknown 兜底。 */
  status: AgentUpgradeStatus;
  /** 失败原因；非失败状态通常为空串。 */
  error: string;
  created_at: number;
  updated_at: number;
}

export interface AgentUpgradeInput {
  /**
   * 目标版本；空串表示「使用最新版本」。
   * 前端目前拿不到版本列表，UI 不猜版本号，只把用户输入原样上报。
   */
  version: string;
}

/**
 * P5：批量 Agent 升级，见 docs/PLAN.md「P5：批量 Agent 升级」。
 *
 * 批量层只排队，真正的下载/校验/回滚仍复用单台升级流水；
 * `item.upgrade_id` 在触发后回填，可用于跳回单台升级记录。
 * 后端可能暂时没有这组接口，页面按 404 兜底成「尚未就绪」。
 */
export interface AgentUpgradeBatch {
  id: string;
  /** 各台起始版本可能不同，后端默认留空。 */
  from_version: string;
  to_version: string;
  status: AgentUpgradeBatchStatus;
  /** 后端目前序列化为 0/1，展示层用 Boolean() 归一。 */
  stop_on_failure: boolean | number;
  /** 同时执行的台数，被后端夹在 1–5。 */
  concurrency: number;
  created_at: number;
  updated_at: number;
}

export interface AgentUpgradeBatchItem {
  server_id: string;
  server_name: string;
  /** 触发时 Agent 上报的版本；从未上报过为 null。 */
  agent_version: string | null;
  status: AgentUpgradeBatchItemStatus;
  /** 失败原因；非失败状态通常为空串。 */
  error: string;
  /** 触发后回填的单台升级 id；尚未触发时为 null。 */
  upgrade_id: string | null;
}

export interface CreateAgentUpgradeBatchInput {
  /** 必须全部是已开启「允许下发升级」的服务器；后端限制 ≤ 50 台。 */
  server_ids: string[];
  /** 省略或空串表示「最新版本」。 */
  version?: string;
  /** 默认 true：任意一台失败后剩余排队项标记 skipped。 */
  stop_on_failure?: boolean;
}

/** 批次详情：批次本身 + 每台服务器的排队/执行结果。 */
export interface AgentUpgradeBatchDetail {
  batch: AgentUpgradeBatch;
  items: AgentUpgradeBatchItem[];
}

/** 断流 / 恢复事件；管理员接口，按时间倒序返回。 */
export type EnforcementEventKind = "removed" | "restored";

export interface EnforcementEvent {
  id: string;
  kind: EnforcementEventKind;
  user_id: string;
  username: string;
  server_id: string;
  server_name: string;
  /** exhausted / expired / disabled / recovered，未知值原样展示。 */
  reason: string;
  /** 后端生成的中文句子，直接展示。 */
  message: string;
  /** Unix 秒。 */
  created_at: number;
}

/**
 * 审计日志条目；管理员专用，按时间倒序返回。
 *
 * `detail` 后端已解析成 JSON 对象（解析失败时退化为原始字符串），
 * 前端不需要再 parse；变更摘要由页面从它里面提取。
 */
export interface AuditEntry {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  /** 形如 `user.create` / `package.update`；未知值原样展示。 */
  action: string;
  /** 被操作对象的 id；`settings` 这类没有单行 id 的是固定字符串。 */
  target: string | null;
  detail: unknown;
  /** Unix 秒。 */
  created_at: number;
}

/**
 * 审计列表查询参数（全部走服务端）。
 *
 * 只传 `limit` 时与旧接口等价：取最新的 N 条。
 */
export interface AuditListQuery {
  limit: number;
  /** 上一页返回的 `next_before`（记录 id 或 Unix 秒时间戳）；不传表示第一页。 */
  before?: string | null;
  /** 动作前缀；逗号分隔表示多个前缀（服务端按 OR 处理）。 */
  action?: string | null;
  /** 操作者用户名子串。 */
  actor?: string | null;
  /** 目标 id / 固定名字串的子串。 */
  target?: string | null;
}

/** 审计分页响应；`next_before` 为 null 表示没有更早的记录了。 */
export interface AuditPage {
  items: AuditEntry[];
  next_before: string | null;
}

/**
 * P2：订阅自定义规则模板，见 docs/PLAN.md「P2：订阅自定义规则（规则模板）」。
 *
 * `rules` 直接就是 Clash 规则文本；最后一条必须以 `MATCH` 开头（兜底规则）。
 * 订阅链接未带 `?rule=` 时使用 `is_default` 的那条模板。
 */
export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  rules: string[];
  is_default: boolean;
  created_at: number;
  updated_at: number;
}

export interface CreateRuleTemplateInput {
  name: string;
  description?: string;
  rules: string[];
  is_default?: boolean;
}

export type UpdateRuleTemplateInput = Partial<CreateRuleTemplateInput>;

/** 节点：config 是后端直接返回的 JSON 对象，不需要前端再 parse。 */
export interface Node {
  id: string;
  server_id: string;
  tag: string;
  name: string;
  protocol: string;
  transport: string;
  security: string;
  port: number;
  config: Record<string, unknown>;
  /** 后端目前序列化为 0/1，统一在展示层用 Boolean() 归一。 */
  enabled: boolean | number;
  /** 只有 `security = "tls"` 的节点才有值，其余为 null。 */
  cert_id?: string | null;
  /**
   * 节点带宽上限（kbps）；0 / null = 不限。
   * 由 Agent 用 tc 做**精确**下行限速，只限制下行。
   */
  bandwidth_kbps?: number | null;
  created_at: number;
  /** 后端暂时只回 created_at；保留字段以便主控补充更新时间后零改动接入。 */
  updated_at?: number;
}

/**
 * 全局节点（跨服务器）：在 `Node` 之上补 `server_name`，供套餐范围选择器分组。
 * 接口 `GET /api/v1/nodes` 是管理员接口，后端可能尚未上线。
 */
export interface NodeSummary extends Node {
  server_name: string;
}

export interface CreateNodeInput {
  name: string;
  protocol: string;
  transport: string;
  security: string;
  port: number;
  config: Record<string, unknown>;
  enabled?: boolean;
  /** TLS 节点必填；其它安全层必须省略。 */
  cert_id?: string | null;
  /** 节点带宽上限（kbps）；0 / 省略 = 不限。 */
  bandwidth_kbps?: number | null;
}

export interface UpdateNodeInput {
  name?: string;
  port?: number;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** 节点带宽上限（kbps）；省略 = 不改，0 = 取消限速。 */
  bandwidth_kbps?: number;
  /**
   * 三态：省略 = 不改，null = 解绑，字符串 = 绑定。
   * 但后端只接受「TLS 节点绑定 / 非 TLS 节点不携带」，解绑得先改安全层。
   */
  cert_id?: string | null;
}

/** P3：出站与路由，见 docs/PLAN.md「P3：出站与路由（可视化）」。 */
export type OutboundProtocol =
  | "socks"
  | "http"
  | "vmess"
  | "vless"
  | "trojan"
  | "shadowsocks"
  | "freedom"
  | "blackhole";

/** 自定义出站；`direct` / `blocked` 是内置出站，不会出现在该列表里。 */
export interface Outbound {
  id: string;
  server_id: string;
  tag: string;
  /** 白名单见 `OutboundProtocol`；未知值原样展示。 */
  protocol: string;
  /** 后端直接返回 JSON 对象；合并进出站对象时以 tag/protocol 为准。 */
  config: Record<string, unknown>;
  /** 后端目前序列化为 0/1，统一在展示层用 Boolean() 归一。 */
  enabled: boolean | number;
  created_at: number;
}

export interface CreateOutboundInput {
  tag: string;
  protocol: OutboundProtocol;
  config: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateOutboundInput {
  tag?: string;
  protocol?: OutboundProtocol;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

/** 路由规则：三个匹配条件（入站 / 域名 / IP）至少填一个。 */
export interface RoutingRule {
  id: string;
  server_id: string;
  sort_order: number;
  /** 空 = 不限定入站；值来自该服务器的节点 tag。 */
  inbound_tag: string | null;
  /** 逗号分隔的 Xray 域名匹配串；空 = 不按域名匹配。 */
  domain: string | null;
  /** 逗号分隔的 IP/CIDR；空 = 不按 IP 匹配。 */
  ip: string | null;
  /** `direct` / `blocked` 或该服务器上已存在的自定义出站 tag。 */
  outbound_tag: string;
  enabled: boolean | number;
  created_at: number;
}

export interface CreateRoutingRuleInput {
  inbound_tag?: string | null;
  domain?: string | null;
  ip?: string | null;
  outbound_tag: string;
  sort_order?: number;
  enabled?: boolean;
}

export type UpdateRoutingRuleInput = Partial<CreateRoutingRuleInput>;

/**
 * 转发引擎。
 *
 * - `native`：PierWave 自带实现（TCP/UDP，组内选路与降级）；
 * - `realm`：调用 realm 子进程（固定同时监听 TCP 与 UDP，带权重负载均衡）；
 * - `nftables`：内核 DNAT；
 * - `tunnel`：P16 自研加密隧道，**仅用于链**（实验性）。
 *
 * 与后端 `crates/domain/src/engine.rs` 的白名单一致；独立转发的可选项见
 * `lib/engines.ts` 的 `FORWARD_ENGINES`，链的可选项见 `CHAIN_ENGINES`。
 */
export type ForwardEngine = "native" | "realm" | "nftables" | "tunnel";

/**
 * 转发协议模式（转发与链共用）。
 *
 * - `tcp`：只监听 TCP（缺省）；
 * - `udp`：只监听 UDP，同端口的 TCP 不监听；
 * - `both`：同一端口号上 TCP 与 UDP 都监听。
 *
 * 与后端 `crates/domain/src/protocol.rs` 的白名单一致。
 */
export type ForwardProtocol = "tcp" | "udp" | "both";

/**
 * 单跳端口转发：Agent 在服务器上监听 `listen_port`，
 * 把入站连接原样转发到 `target_host:target_port`。
 *
 * 这套链路不经过 Xray，也不计入用户流量，与节点 / 出站是两套并行系统。
 */
export interface ForwardRuntime {
  listening: boolean;
  /** Agent 返回的失败原因；监听成功时为空串。 */
  error: string;
  /** 最近一次心跳回报该状态的时间（Unix 秒）。 */
  updated_at: number;
}

export interface Forward {
  id: string;
  server_id: string;
  name: string;
  listen_port: number;
  target_host: string;
  target_port: number;
  enabled: boolean;
  /** 实现这条规则所用的引擎；后端缺省 / 历史数据为 `native`。 */
  engine: ForwardEngine;
  /**
   * 监听协议：`tcp`（缺省）/ `udp` / `both`。
   * 旧后端可能不返回该字段，展示层用 `normalizeProtocol` 按 `udp` 位兜底。
   */
  protocol: ForwardProtocol;
  /**
   * @deprecated 旧布尔位，只为读取旧响应保留：`true` = 同时监听 UDP。
   * 读写行为以 `protocol` 为准；新写入由后端按协议同步这一列。
   */
  udp: boolean;
  created_at: number;
  updated_at: number;
  /**
   * 运行时状态；`null` = Agent 从未上报过这条规则，
   * 不代表监听失败，列表里展示为「未上报」。
   */
  runtime: ForwardRuntime | null;
}

export interface CreateForwardInput {
  name: string;
  listen_port: number;
  target_host: string;
  target_port: number;
  enabled?: boolean;
  /** 缺省 = `native`；表单总是显式发送，以便 edit 能把引擎改回 native。 */
  engine?: ForwardEngine;
  /** 监听协议：`tcp`（缺省）/ `udp` / `both`；与 `udp` 同传时以它为准。 */
  protocol?: ForwardProtocol;
  /**
   * @deprecated 旧布尔位，仅在没传 `protocol` 时由后端推导：
   * `true` → `both`、`false` → `tcp`。
   */
  udp?: boolean;
}

export type UpdateForwardInput = Partial<CreateForwardInput>;

/**
 * 组内一台成员服务器：在 `listen_port` 上监听，把流量交给下一组的成员
 * （最后一组交给链的 `target_host:target_port`）。
 *
 * 链不存在于 Agent 侧：主控把每个成员推导成一条独立转发规则
 * （id 形如 `chain-<chain_id>-<seq>-<server_id>`），运行时状态复用心跳。
 */
export interface ChainGroupMember {
  server_id: string;
  /** 服务器展示名；服务器被删除时后端仍会返回快照里的名字。 */
  server_name: string;
  listen_port: number;
  /** 组内顺序：小的优先（主备），同优先级保持配置顺序（轮询）。 */
  priority: number;
  /** 预留给加权，本轮只存不用。 */
  weight: number;
  /** 推导出的转发规则 id，用于和心跳状态对齐。 */
  forward_id: string;
  /** true = 已监听，false = 监听失败，null = Agent 未上报。 */
  listening: boolean | null;
  /** true = 目标可达，false = 不可达，null = 尚未探测。 */
  target_ok: boolean | null;
  /**
   * TLS 探针的稳定失败短串，例如 `cert_expired` / `timeout`；
   * `null` = 握手正常或尚未探测。翻译键见 `lib/chainTls.ts`。
   */
  target_error: string | null;
  /**
   * 该服务器最后一次心跳（ISO8601）；`null` = 未上报。
   * 旧后端可能不返回该字段，前端一律按 `null` 处理。
   */
  last_seen_at?: string | null;
  /** 本跳已转发的入站字节；`null` = 尚未上报。 */
  traffic_in?: number | null;
  /** 本跳已转发的出站字节；`null` = 尚未上报。 */
  traffic_out?: number | null;
  /**
   * 上一跳 → 这台成员这一段的实测 RTT（多台上一跳取最小值）。
   * 首组没有上一跳、Agent 未探测或探测失败时为 null。
   */
  latency_ms: number | null;
  /** 仅最后一跳：这台成员 → 链目标的实测 RTT；其它组为 null。 */
  target_latency_ms: number | null;
  /** 连续 2 次 target_ok=false 后为 true；不是实时探测结果。 */
  degraded: boolean;
  /** Agent 返回的监听失败原因；无错误时为空串。 */
  error: string;
  /** 最近一次上报的 Unix 秒；null = 未上报。 */
  updated_at: number | null;
}

/** 链里的一组：1–8 台成员，由上一跳按 `strategy` 选一台。 */
export interface ChainGroup {
  id: string;
  /** 从 0 开始，0 = 入口组。 */
  seq: number;
  /** 可选展示名。 */
  name: string | null;
  /** `round_robin` | `failover` | `lowest_latency` | `ip_hashed`。 */
  strategy: string;
  /** 该组 realm 监听证书；入口组（seq 0）始终为 null。 */
  cert_id: string | null;
  /** 组内任一成员 degraded 即为 true。 */
  degraded: boolean;
  /** 按 `priority` 升序排列。 */
  members: ChainGroupMember[];
}

/**
 * tunnel 引擎的隧道加密模式：
 * - `tls`（缺省，推荐）：自有 CA 证书，主控自动签发；
 * - `noise`：不需要证书，双方用预共享密钥认证，每 10 分钟重新协商会话密钥。
 *
 * 仅 `engine = tunnel` 时有意义；旧后端可能不返回，展示层用
 * `normalizeTunnelSecurity` 回落到 `tls`。
 */
export type TunnelSecurity = "tls" | "noise";

export interface Chain {
  id: string;
  name: string;
  target_host: string;
  target_port: number;
  enabled: boolean;
  /** 整条链共用的引擎，逐跳透传到每个成员的期望态。 */
  engine: ForwardEngine;
  /**
   * 整条链的监听协议：`tcp`（缺省）/ `udp` / `both`，逐跳透传到每个成员。
   * 旧后端可能不返回该字段，展示层用 `normalizeProtocol` 按 `udp` 位兜底。
   */
  protocol: ForwardProtocol;
  /**
   * @deprecated 旧布尔位，只为读取旧响应保留：`true` = 每个成员同时监听 UDP。
   * 读写行为以 `protocol` 为准。
   */
  udp: boolean;
  /** 跳间加密模式：`none`（明文）或 `tls`；旧后端缺失按 `none` 处理。 */
  transport: string;
  /**
   * 隧道引擎的加密模式：`tls`（缺省）/ `noise`，仅 `engine = tunnel` 时有意义。
   * 旧后端不返回该字段时按 `tls` 处理。
   */
  tunnel_security?: TunnelSecurity;
  /** 链因能力 / 证书不满足被下发跳过时的稳定错误码。 */
  blocked_code?: string | null;
  /** 链被跳过时的原因原文；非空时列表在链名旁显示 warning。 */
  blocked_reason?: string | null;
  /** 任一组 / 成员 degraded 即为 true。 */
  degraded: boolean;
  /**
   * 路径形态：`single`（每组一台，整链唯一路径）/ `multi`（存在按策略
   * 选路的多成员组）/ `hash`（多成员组全部 ip_hashed）。旧后端可能不返回。
   */
  path_mode?: string;
  /**
   * 各段实测延迟之和；仅 `path_mode = single` 且有完整数据时有值，
   * 多路径 / 缺任何一段 / 空链均为 null。
   */
  total_latency_ms?: number | null;
  /** 按 `seq` 升序排列；前端只读这个字段，不再读兼容用的 `hops`。 */
  groups: ChainGroup[];
  created_at: number;
  updated_at: number;
}

/**
 * `GET /api/v1/chains/{id}/latency` 的一个点。
 *
 * `ts` 是 5 分钟桶起点（Unix 秒）；`seq` 是被探测的那一跳，入口组没有点；
 * 同一桶已按该跳所有成员取中位数。
 */
export interface ChainLatencyPoint {
  ts: number;
  seq: number;
  server_id: string;
  latency_ms: number;
}

export interface ChainGroupMemberInput {
  server_id: string;
  /**
   * 监听端口：入口组（seq 0）必填；中间跳（seq ≥ 1）省略，
   * 由后端从 20000–29999 的端口池里分配。
   */
  listen_port?: number;
  /** 组内顺序，0 = 最高优先级。 */
  priority: number;
}

export interface ChainGroupInput {
  /** 可选展示名；空串表示不命名。 */
  name?: string;
  strategy: ChainStrategy;
  /** 该组 realm 监听证书；入口组必须省略，tls 链的 seq >= 1 组必填。 */
  cert_id?: string | null;
  /** 1–8 台，按 priority 顺序排列。 */
  members: ChainGroupMemberInput[];
}

export interface CreateChainInput {
  name: string;
  target_host: string;
  target_port: number;
  enabled?: boolean;
  /** 缺省 = `native`；整条链共用一个引擎。 */
  engine?: ForwardEngine;
  /** 整条链的监听协议：`tcp`（缺省）/ `udp` / `both`；与 `udp` 同传时以它为准。 */
  protocol?: ForwardProtocol;
  /**
   * @deprecated 旧布尔位，仅在没传 `protocol` 时由后端推导：
   * `true` → `both`、`false` → `tcp`。
   */
  udp?: boolean;
  /** `none`（缺省，明文）或 `tls`；tls 只允许 realm 且至少 2 组。 */
  transport?: "none" | "tls";
  /**
   * 隧道引擎的加密模式；缺省 `tls`，仅 `engine = tunnel` 时有意义。
   * 非 tunnel 引擎不传，避免把无意义的值写到别的引擎上。
   */
  tunnel_security?: TunnelSecurity;
  /** 1–4 组，按入口到目标的顺序排列。 */
  groups: ChainGroupInput[];
}

export type UpdateChainInput = Partial<CreateChainInput>;

export interface ApplyResult {
  config_version: number;
  /** 后端正在加；暂时没有时按空数组处理。 */
  warnings?: string[] | null;
}

/**
 * 证书元数据，契约见 docs/CERTS.md。
 *
 * 私钥与证书正文永不出现在任何 GET 响应里，列表只回 `has_key`；
 * `days_left` 由后端按 UTC 秒向下取整，可能为负（已过期）。
 */
export interface Certificate {
  id: string;
  name: string;
  domains: string[];
  not_before: number;
  not_after: number;
  days_left: number;
  has_key: boolean;
  created_at: number;
}

export interface CreateCertificateInput {
  name: string;
  cert_pem: string;
  key_pem: string;
}

/** P1：用户与套餐契约，见 docs/PLAN.md「P1：用户与套餐（本轮契约）」。 */
export type UserRole = "admin" | "user";
export type UserStatus = "active" | "disabled";
export type PackageDirection = "both" | "upload" | "download";
export type UserPackageStatus =
  | "active"
  | "expired"
  | "exhausted"
  | "disabled";

export interface UserPackageView {
  id: string;
  package_id: string;
  package_name: string;
  /** 原始覆写值：null = 继承套餐额度，0 = 显式不限，N = 覆写额度。 */
  quota_override: number | null;
  /** 生效额度：继承/覆写计算后的结果，0 表示显式不限。 */
  quota_bytes: number | null;
  used_bytes: number;
  expires_at: number | null;
  reset_day: number | null;
  status: UserPackageStatus;
  direction: PackageDirection;
  node_ratio: number;
}

export interface UserView {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  short_code: string;
  /** 账户级总额度；null = 不限，非空时是跨套餐的总闸。 */
  quota_bytes: number | null;
  used_bytes: number;
  /**
   * 是否已超出账户总额度（后端算好，前端不要自己拿 used/quota 比）。
   * 为真时该用户在所有节点上都失去资格，和单张套餐实例的「已用尽」是两回事。
   */
  quota_exceeded: boolean;
  created_at: number;
  /** 套餐实例数；分页时 packages 可能不是全量，计数以这个字段为准。 */
  package_count: number;
  /** 套餐明细；分页时可能只含前若干张。 */
  packages: UserPackageView[];
  /**
   * 名下套餐实例的额度合计；`null` = 其中至少一张不限量（合计也就无上限）。
   * 列表里的「套餐流量」只看这个，不看账户级 `quota_bytes`。
   */
  package_quota_bytes: number | null;
  /** 名下套餐实例的已用合计。 */
  package_used_bytes: number;
  /**
   * 名下实例里最严重的状态：`exhausted > expired > disabled > active`，无实例为 `none`。
   * 账号仍是 `active` 时也可能断流，列表状态列必须单独展示它。
   */
  package_worst_status: UserPackageStatus | "none";
  /**
   * P6：用户绑定的规则模板；`null` = 跟随套餐 / 全局默认。
   * 旧版后端可能暂时不返回该字段，展示层统一按 `null` 处理。
   */
  rule_template_id: string | null;
}

/** 后端返回的节点范围意图；UI 的三态见 `lib/schemas.ts` 的 `PackageNodeScope`。 */
export type PackageNodeScopeKind = "all" | "custom";

export interface Package {
  id: string;
  name: string;
  quota_bytes: number | null;
  period_days: number | null;
  direction: PackageDirection;
  node_ratio: number;
  /**
   * 套餐限速档位（kbps）；0 / null = 不限。
   * 只能映射到 Xray `policy.levels.N.bufferSize`，是**近似**限速。
   */
  speed_limit_kbps?: number | null;
  created_at?: number;
  /**
   * 范围意图：`all` = 未设范围（含以后新增的节点）；`custom` = 显式设过范围。
   * 系统里一个节点都没有时，只能靠这个字段区分「全部」和「一个都不给」。
   */
  node_scope: PackageNodeScopeKind;
  /**
   * 显式绑定的节点 id；只在 `node_scope = "custom"` 时有意义：
   * 非空 = 指定这些节点；空数组 = 一个都不给。
   */
  node_ids: string[];
  /** 实际可见节点数；未设范围时等于全部节点数。 */
  node_count: number;
  /** 当前仍引用该模板的套餐实例数，删除前用于禁用按钮。 */
  user_count: number;
  /**
   * P6：套餐的默认规则模板；`null` = 套餐内用户未单独指定时回落到全局默认。
   * 旧版后端可能暂时不返回该字段，展示层统一按 `null` 处理。
   */
  rule_template_id: string | null;
}

/**
 * P6：订阅列表行，见 docs/PLAN.md「P6：规则模板绑定到用户 / 套餐」。
 *
 * 与 `UserView` 同源，额外带后端按
 * `?rule=` > 用户绑定 > 当前套餐绑定 > 全局默认 > 内置规则 解析出的**生效**模板。
 * `rule_template_id` / `rule_template_name` 为 `null` 表示最终没有命中任何模板
 * （即使用全局默认或内置规则），前端展示为「默认规则」。
 */
export interface Subscription {
  id: string;
  username: string;
  short_code: string;
  used_bytes: number;
  quota_bytes: number | null;
  package_count: number;
  packages: UserPackageView[];
  rule_template_id: string | null;
  rule_template_name: string | null;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role?: UserRole;
  quota_bytes?: number | null;
  /**
   * P6：规则模板绑定。
   * `null` = 显式不绑定（跟随套餐 / 全局默认）；省略 = 使用后端默认值。
   */
  rule_template_id?: string | null;
}

export interface UpdateUserInput {
  status?: UserStatus;
  role?: UserRole;
  password?: string;
  quota_bytes?: number | null;
  /**
   * P6：规则模板绑定，三态：
   * - 省略 = 不改；
   * - `null` = 显式清空，回落到套餐 / 全局默认；
   * - 字符串 = 绑定到该模板。
   */
  rule_template_id?: string | null;
}

export interface CreatePackageInput {
  name: string;
  quota_bytes?: number | null;
  period_days?: number | null;
  direction?: PackageDirection;
  node_ratio?: number;
  /** 套餐限速档位（kbps）；0 / 省略 = 不限，近似限速。 */
  speed_limit_kbps?: number | null;
  /**
   * 三态节点范围：
   * - 省略（新建）/ `null`（编辑）= 全部节点；
   * - `[]` = 一个都不给（订阅为空）；
   * - 非空数组 = 只给这些节点。
   */
  node_ids?: string[] | null;
  /**
   * P6：套餐默认规则模板，三态同 `UpdatePackageInput`：
   * 省略 = 不改；`null` = 清空并回落到全局默认；字符串 = 绑定。
   */
  rule_template_id?: string | null;
}

export type UpdatePackageInput = Partial<CreatePackageInput>;

export interface BindUserPackageInput {
  package_id: string;
  expires_at?: number | null;
  quota_override?: number | null;
  reset_day?: number | null;
}

export interface UpdateUserPackageInput {
  expires_at?: number | null;
  quota_override?: number | null;
  reset_day?: number | null;
  status?: string;
}

/** P3：概览契约，见 docs/PLAN.md「P3：概览与订阅（本轮契约）」。 */
export interface OverviewStats {
  servers: { total: number; online: number };
  users: { total: number; active: number };
  packages: { total: number; instances: number };
  traffic: { today_bytes: number; month_bytes: number };
  alerts: {
    expired_instances: number;
    exhausted_instances: number;
    offline_servers: number;
    /** 30 天内到期（含已过期）的证书数量。 */
    expiring_certs: number;
  };
}

/** 流量趋势的 `date` 是 UTC+8 自然日，后端会把缺数据的日期补 0。 */
export interface TrafficDay {
  date: string;
  uplink: number;
  downlink: number;
  weighted: number;
}

export interface TrafficStats {
  days: TrafficDay[];
}

/** `GET /api/v1/overview?days=7` 的 KPI 汇总。 */
export interface OverviewKpi {
  servers_online: number;
  servers_total: number;
  nodes: number;
  traffic_today: number;
  traffic_month: number;
  /** 24 小时在线率（0–100）。 */
  uptime_24h: number;
}

/** 聚合接口的逐日流量；`day` 与 `/stats/traffic` 的 `date` 同为 UTC+8 自然日。 */
export interface OverviewSeriesPoint {
  day: string;
  uplink: number;
  downlink: number;
}

/** 协议维度：`nodes` 是该协议下的节点数，`traffic_7d` 是 7 天合计。 */
export interface OverviewProtocol {
  protocol: string;
  nodes: number;
  traffic_7d: number;
}

/** 转发链健康度；概览告警卡只消费 `degraded` 与 `handshake_failures`。 */
export interface OverviewChains {
  total: number;
  degraded: number;
  blocked: number;
  forwards_total: number;
  forwards_failing: number;
  handshake_failures: number;
}

/** Top 5 条目；当前契约只返回 `kind: "server"`。 */
export interface OverviewTopItem {
  kind: "server";
  name: string;
  traffic_7d: number;
  load1: number | null;
  online: boolean;
}

/**
 * 概览聚合契约（P14）：一次请求拿到图表、协议、链路与 Top 5。
 *
 * 既有的 `/api/v1/stats/overview` 继续供第一行 KPI 与告警计数使用，
 * 新接口失败时不会拖垮整页。
 */
export interface OverviewData {
  kpi: OverviewKpi;
  series: OverviewSeriesPoint[];
  /** 后端已按 `traffic_7d` 降序；前端仍会做一次防御性排序。 */
  protocols: OverviewProtocol[];
  chains: OverviewChains;
  /** 最多 5 条。 */
  top: OverviewTopItem[];
}

/**
 * P2：节点维度流量，见 docs/PLAN.md「P2：节点维度流量明细」。
 *
 * `uplink` / `downlink` / `weighted` 是 `days` 窗口内的合计，
 * `today_bytes` / `month_bytes` 是后端按 UTC+8 算好的加权值。
 */
export interface NodeTraffic {
  node_id: string;
  node_tag: string;
  name: string;
  server_id: string;
  server_name: string;
  protocol: string;
  transport: string;
  security: string;
  uplink: number;
  downlink: number;
  weighted: number;
  today_bytes: number;
  month_bytes: number;
}

/** 节点上按用户归因的流量切片，按 weighted 降序返回。 */
export interface NodeTrafficUser {
  user_id: string;
  username: string;
  uplink: number;
  downlink: number;
  weighted: number;
}

export interface NodeTrafficDetail {
  node: NodeTraffic;
  /** 缺失日期已由后端补 0，升序排列。 */
  days: TrafficDay[];
  /** Top N 用户，最多 `top` 条。 */
  users: NodeTrafficUser[];
}

/** P4：用户自助契约，见 docs/PLAN.md「P4：用户端自助（本轮契约）」。 */
export interface MeSummaryUser {
  id: string;
  username: string;
  /** 当前数据模型没有 email 列，后端固定返回 null；界面按「未填写」处理。 */
  email: string | null;
  role: UserRole;
  short_code: string;
  used_bytes: number;
  quota_bytes: number | null;
  /** 是否已超出账户总额度；后端算好，用于自助页的账户级横幅。 */
  quota_exceeded: boolean;
}

/** 概览卡用的主套餐（多张卡时后端取「最新可用」，否则取最新一张）。 */
export interface MePackageSummary {
  name: string;
  /** 生效额度；null / 0 都表示不限。 */
  traffic_limit: number | null;
  /** Unix 秒；null = 永不过期。 */
  expires_at: number | null;
}

/** 已用 / 剩余 / 剩余天数 / 状态，全部由后端算好。 */
export interface MeUsage {
  used_bytes: number;
  /** 不限量时为 null；用尽时为 0。 */
  remaining_bytes: number | null;
  /** 已过期 = 0，永不过期 = null。 */
  days_left: number | null;
  status: UserPackageStatus | "none";
}

/** 「我的节点」列表项：**只给名字，不含服务器地址/端口/配置**。 */
export interface MeNode {
  id: string;
  name: string;
  tag: string;
  protocol: string;
  server_name: string;
}

export interface MeSubscription {
  /** 后端可能返回站内相对地址，展示前统一转成绝对 URL。 */
  url: string;
  /** 订阅短码最后一次重置的 Unix 秒。 */
  updated_at: number;
}

export interface MeSummary {
  user: MeSummaryUser;
  /** 没有任何套餐实例时为 null。 */
  package: MePackageSummary | null;
  usage: MeUsage;
  nodes: MeNode[];
  subscription: MeSubscription;
  /** 兼容字段：套餐明细（quota_override=0 表示显式不限）。 */
  packages: UserPackageView[];
  /** 兼容字段：今日/本月流量。 */
  traffic: { today_bytes: number; month_bytes: number };
  /** 兼容字段：与 `subscription.url` 相同的相对地址。 */
  subscription_url: string;
}

export type MeTraffic = TrafficStats;

/** `POST /api/v1/me/subscription/reset`：旧链接立即失效。 */
export interface ResetSubscriptionResponse {
  url: string;
  updated_at: number;
}

/**
 * P13：`POST /api/v1/alerts/test` 的响应。
 *
 * 后端还会返回 `configured` 与 `message`（未配置渠道时的提示）；
 * 卡片只消费 `results`，其余字段忽略，避免旧后端缺字段时崩掉。
 */
export interface AlertTestResponse {
  results: AlertTestResult[];
}

/** P1：运维基础设置，见 docs/PLAN.md「P1：运维基础」。 */
export interface Settings {
  /** 面板名称；后端缺失该键时会回落到默认值。 */
  panel_name: string;
  /** 限流窗口内允许的连续失败次数，1–20。 */
  login_max_attempts: number;
  /** 触发限流后的锁定时长（秒），60–86400。 */
  login_lock_secs: number;
  /** 登录会话有效期（小时），1–720。 */
  session_ttl_hours: number;
  /**
   * P5：批量 Agent 升级的并发数，1–5，默认 1。
   * 旧版后端可能不返回该键，设置页按 1 兜底。
   */
  agent_upgrade_concurrency: number;
  /**
   * P13：告警通知。旧版后端可能不返回这些键，设置页按空值 / 默认值处理。
   * Telegram 需要 Token 与 Chat ID 同时存在才会发送。
   */
  telegram_bot_token?: string | null;
  telegram_chat_id?: string | null;
  /** 只接受 http(s) 绝对地址；空 = 不启用 Webhook。 */
  webhook_url?: string | null;
  /** 逗号分隔的事件白名单；空串 = 不发送任何告警。 */
  alert_events?: string | null;
  /** 同类告警去抖秒数，0–86400，默认 600。 */
  alert_cooldown_secs?: number | null;
}

export type UpdateSettingsInput = Partial<Settings>;

export interface ChangePasswordInput {
  old_password: string;
  new_password: string;
}

export const api = {
  health: () => request<Health>("/api/v1/health"),
  /**
   * P10：公开状态页。无需登录；设置里关闭开关时后端返回 404
   * （code `public_status.disabled`），页面按「状态页已关闭」处理。
   */
  publicStatus: () => request<PublicStatus>("/api/v1/public/status"),
  /** 概览聚合（P14）：图表、协议分布、链路健康度与 Top 5。 */
  overview: {
    get: (days: number) =>
      request<OverviewData>(
        `/api/v1/overview?days=${encodeURIComponent(String(days))}`,
      ),
  },
  stats: {
    overview: () => request<OverviewStats>("/api/v1/stats/overview"),
    traffic: (days: number) =>
      request<TrafficStats>(
        `/api/v1/stats/traffic?days=${encodeURIComponent(String(days))}`,
      ),
    /** 节点流量列表；`serverId` 缺省时统计全部服务器。后端可能尚未上线。 */
    nodes: ({ days, serverId }: { days: number; serverId?: string }) => {
      const params = new URLSearchParams({ days: String(days) });
      if (serverId) params.set("server_id", serverId);
      return request<{ items: NodeTraffic[] }>(
        `/api/v1/stats/nodes?${params.toString()}`,
      );
    },
    /** 单个节点的近 N 天趋势与 Top 用户。 */
    nodeDetail: (nodeId: string, { days, top }: { days: number; top: number }) =>
      request<NodeTrafficDetail>(
        `/api/v1/stats/nodes/${encodeURIComponent(nodeId)}?days=${encodeURIComponent(String(days))}&top=${encodeURIComponent(String(top))}`,
      ),
  },
  // 会话用户与自助接口共用 `me` 命名空间：api.me() / api.me.summary() / api.me.traffic(days)。
  me: Object.assign(
    () => request<{ user: SessionUser }>("/api/v1/auth/me"),
    {
      summary: () => request<MeSummary>("/api/v1/me/summary"),
      traffic: (days: number) =>
        request<MeTraffic>(
          `/api/v1/me/traffic?days=${encodeURIComponent(String(days))}`,
        ),
      /** 自己的断流/恢复事件；limit 由后端夹在 1..=200。 */
      events: (limit: number) =>
        request<{ items: EnforcementEvent[] }>(
          `/api/v1/me/events?limit=${encodeURIComponent(String(limit))}`,
        ),
      resetSubscription: () =>
        request<ResetSubscriptionResponse>("/api/v1/me/subscription/reset", {
          method: "POST",
        }),
      changePassword: (input: ChangePasswordInput) =>
        request<{ ok: true }>("/api/v1/me/password", {
          method: "POST",
          body: JSON.stringify(input),
        }),
    },
  ),
  login: (username: string, password: string) =>
    request<{ user: SessionUser }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>("/api/v1/auth/logout", { method: "POST" }),
  servers: () => request<{ items: Server[] }>("/api/v1/servers"),
  createServer: (input: {
    name: string;
    address: string;
    xray_mode: string;
    /** ISO 3166-1 alpha-2；省略或空串 = 不填。 */
    country_code?: string;
    /** 分组名；省略或 null = 未分组。 */
    group_name?: string | null;
  }) =>
    request<CreateServerResponse>("/api/v1/servers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** P4：服务器设置（目前开放「允许下发升级」、国家/地区与分组）。后端可能暂时 404。 */
  updateServer: (id: string, input: UpdateServerInput) =>
    request<{ server: Server }>(`/api/v1/servers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  /** 重置配对 token：旧 token 立即失效，已安装的 Agent 会断开。 */
  resetServerToken: (id: string) =>
    request<ResetServerTokenResponse>(
      `/api/v1/servers/${encodeURIComponent(id)}/token`,
      { method: "POST" },
    ),

  /** P4：单台服务器的 Agent 升级任务与历史。后端可能暂时 404。 */
  agentUpgrades: {
    list: (serverId: string) =>
      request<{ items: AgentUpgrade[] }>(
        `/api/v1/servers/${encodeURIComponent(serverId)}/agent-upgrades`,
      ),
    create: (serverId: string, input: AgentUpgradeInput) =>
      request<{ upgrade: AgentUpgrade }>(
        `/api/v1/servers/${encodeURIComponent(serverId)}/agent-upgrade`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
  },

  /** P5：批量升级批次；列表按创建时间倒序，`limit` 由后端夹在 1..20。 */
  agentUpgradeBatches: {
    list: (limit = 20) =>
      request<{ items: AgentUpgradeBatch[] }>(
        `/api/v1/agent-upgrades/batches?limit=${encodeURIComponent(String(limit))}`,
      ),
    get: (id: string) =>
      request<AgentUpgradeBatchDetail>(
        `/api/v1/agent-upgrades/batches/${encodeURIComponent(id)}`,
      ),
    create: (input: CreateAgentUpgradeBatchInput) =>
      request<{ batch: AgentUpgradeBatch }>(
        "/api/v1/agent-upgrades/batches",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    cancel: (id: string) =>
      request<{ batch: AgentUpgradeBatch }>(
        `/api/v1/agent-upgrades/batches/${encodeURIComponent(id)}/cancel`,
        { method: "POST" },
      ),
  },

  /** 管理员可见的断流 / 恢复事件流。 */
  enforcement: {
    events: (limit: number) =>
      request<{ items: EnforcementEvent[] }>(
        `/api/v1/enforcement/events?limit=${encodeURIComponent(String(limit))}`,
      ),
  },

  /** 管理员可见的审计日志，按 `(created_at, id)` 倒序做游标分页。 */
  audit: {
    list: (query: AuditListQuery) => {
      const params = new URLSearchParams({
        limit: String(query.limit),
      });
      if (query.before) params.set("before", query.before);
      if (query.action) params.set("action", query.action);
      if (query.actor) params.set("actor", query.actor);
      if (query.target) params.set("target", query.target);
      return request<AuditPage>(`/api/v1/audit?${params.toString()}`);
    },
  },

  /** 管理员维护的 Clash 规则模板；订阅链接用 `?rule=<id>` 引用。 */
  ruleTemplates: {
    list: () => request<{ items: RuleTemplate[] }>("/api/v1/rule-templates"),
    create: (input: CreateRuleTemplateInput) =>
      request<{ template: RuleTemplate }>("/api/v1/rule-templates", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    update: (id: string, input: UpdateRuleTemplateInput) =>
      request<{ template: RuleTemplate }>(
        `/api/v1/rule-templates/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      ),
    remove: (id: string) =>
      request<{ ok: true }>(
        `/api/v1/rule-templates/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
  },

  /** 面板设置：仅管理员可读写；后端可能尚未上线，页面按 404 兜底。 */
  settings: {
    get: () => request<{ items: Settings }>("/api/v1/settings"),
    patch: (input: UpdateSettingsInput) =>
      request<{ items: Settings }>("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
  },

  /**
   * P13：告警通知测试，见 docs/PLAN.md「P13：告警通知」。
   *
   * 只向已保存且配置完整的渠道发一条测试消息；未保存的修改不会生效。
   * 后端可能暂时 404，卡片按中文错误态兜底，不写 mock。
   */
  alerts: {
    test: () =>
      request<AlertTestResponse>("/api/v1/alerts/test", {
        method: "POST",
        body: JSON.stringify({}),
      }),
  },

  /**
   * P7：备份与恢复，仅管理员可用；后端可能暂时 404。
   *
   * 下载走同源直链，浏览器会带上会话 Cookie 并直接落盘；
   * 恢复上传必须发原始字节，见 `uploadBinary`。
   */
  backup: {
    /** 同源直链：`<a download>` 直接指向它即可，无需 fetch。 */
    downloadUrl: "/api/v1/backup",
    info: () => request<BackupInfo>("/api/v1/backup/info"),
    restore: (file: File) =>
      uploadBinary<RestoreBackupResponse>("/api/v1/backup/restore", file),
    cancelRestore: () =>
      request<{ ok: true }>("/api/v1/backup/restore", { method: "DELETE" }),
  },

  // 节点按服务器归属管理；`listAll` 是跨服务器的全局列表（套餐范围选择器用）。
  nodes: Object.assign(
    (serverId: string) =>
      request<{ items: Node[] }>(
        `/api/v1/servers/${encodeURIComponent(serverId)}/nodes`,
      ),
    {
      listAll: () => request<{ items: NodeSummary[] }>("/api/v1/nodes"),
    },
  ),
  createNode: (serverId: string, input: CreateNodeInput) =>
    request<{ node: Node }>(
      `/api/v1/servers/${encodeURIComponent(serverId)}/nodes`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  updateNode: (id: string, input: UpdateNodeInput) =>
    request<{ node: Node }>(`/api/v1/nodes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteNode: (id: string) =>
    request<{ ok: true }>(`/api/v1/nodes/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  applyServer: (serverId: string) =>
    request<ApplyResult>(
      `/api/v1/servers/${encodeURIComponent(serverId)}/apply`,
      { method: "POST" },
    ),

  /** 单台服务器的自定义出站；`direct` / `blocked` 由后端内置，不在列表里。 */
  outbounds: {
    list: (serverId: string) =>
      request<{ items: Outbound[] }>(
        `/api/v1/servers/${encodeURIComponent(serverId)}/outbounds`,
      ),
    create: (serverId: string, input: CreateOutboundInput) =>
      request<{ outbound: Outbound }>(
        `/api/v1/servers/${encodeURIComponent(serverId)}/outbounds`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    update: (id: string, input: UpdateOutboundInput) =>
      request<{ outbound: Outbound }>(
        `/api/v1/outbounds/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      ),
    remove: (id: string) =>
      request<{ ok: true }>(`/api/v1/outbounds/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },

  /**
   * 单跳 TCP 端口转发。写操作会立即标脏并下发一次期望态；
   * 列表里的 `runtime` 来自 Agent 心跳，用于展示真实的监听状态。
   */
  forwards: {
    list: (serverId: string) =>
      request<{ items: Forward[] }>(
        `/api/v1/servers/${encodeURIComponent(serverId)}/forwards`,
      ),
    create: (serverId: string, input: CreateForwardInput) =>
      request<{ forward: Forward }>(
        `/api/v1/servers/${encodeURIComponent(serverId)}/forwards`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    update: (id: string, input: UpdateForwardInput) =>
      request<{ forward: Forward }>(
        `/api/v1/forwards/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      ),
    remove: (id: string) =>
      request<{ ok: true }>(`/api/v1/forwards/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },

  /**
   * 线性多跳转发链。与单跳转发不同，链不属于某台服务器：
   * 写操作会自动标脏并下发所有涉及服务器的期望态，无需再手动应用。
   */
  chains: {
    list: () => request<{ items: Chain[] }>("/api/v1/chains"),
    create: (input: CreateChainInput) =>
      request<{ chain: Chain }>("/api/v1/chains", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    update: (id: string, input: UpdateChainInput) =>
      request<{ chain: Chain }>(`/api/v1/chains/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    remove: (id: string) =>
      request<{ ok: true }>(`/api/v1/chains/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    /** 延迟历史：`hours` 为 1..168，空数据返回 `{ points: [] }`。 */
    latency: (id: string, hours: number) =>
      request<{ points: ChainLatencyPoint[] }>(
        `/api/v1/chains/${encodeURIComponent(id)}/latency?hours=${hours}`,
      ),
  },

  /** 单台服务器的路由规则；内置的 api 规则不在列表里。 */
  routingRules: {
    list: (serverId: string) =>
      request<{ items: RoutingRule[] }>(
        `/api/v1/servers/${encodeURIComponent(serverId)}/routing-rules`,
      ),
    create: (serverId: string, input: CreateRoutingRuleInput) =>
      request<{ rule: RoutingRule }>(
        `/api/v1/servers/${encodeURIComponent(serverId)}/routing-rules`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    update: (id: string, input: UpdateRoutingRuleInput) =>
      request<{ rule: RoutingRule }>(
        `/api/v1/routing-rules/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      ),
    remove: (id: string) =>
      request<{ ok: true }>(
        `/api/v1/routing-rules/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
  },

  certificates: {
    list: () => request<{ items: Certificate[] }>("/api/v1/certificates"),
    create: (input: CreateCertificateInput) =>
      request<{ certificate: Certificate }>("/api/v1/certificates", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    remove: (id: string) =>
      request<{ ok: true }>(`/api/v1/certificates/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },

  users: (q: string) => {
    const params = new URLSearchParams({ limit: "200" });
    if (q) params.set("q", q);
    return request<{ items: UserView[] }>(`/api/v1/users?${params.toString()}`);
  },
  /**
   * P6：订阅列表（管理员），每行带后端解析好的生效规则模板。
   * 后端可能暂时 404：页面按中文错误态兜底并提供重试。
   */
  subscriptions: (q: string) => {
    const params = new URLSearchParams({ limit: "200" });
    if (q) params.set("q", q);
    return request<{ items: Subscription[] }>(
      `/api/v1/subscriptions?${params.toString()}`,
    );
  },
  createUser: (input: CreateUserInput) =>
    request<{ user: UserView }>("/api/v1/users", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateUser: (id: string, input: UpdateUserInput) =>
    request<{ user: UserView }>(`/api/v1/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteUser: (id: string) =>
    request<{ ok: true }>(`/api/v1/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  packages: () => request<{ items: Package[] }>("/api/v1/packages"),
  createPackage: (input: CreatePackageInput) =>
    request<{ package: Package }>("/api/v1/packages", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updatePackage: (id: string, input: UpdatePackageInput) =>
    request<{ package: Package }>(
      `/api/v1/packages/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
  deletePackage: (id: string) =>
    request<{ ok: true }>(`/api/v1/packages/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  userPackages: (userId: string) =>
    request<{ items: UserPackageView[] }>(
      `/api/v1/users/${encodeURIComponent(userId)}/packages`,
    ),
  bindUserPackage: (userId: string, input: BindUserPackageInput) =>
    request<{ item: UserPackageView }>(
      `/api/v1/users/${encodeURIComponent(userId)}/packages`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  updateUserPackage: (id: string, input: UpdateUserPackageInput) =>
    request<{ item: UserPackageView }>(
      `/api/v1/user-packages/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
  unbindUserPackage: (id: string) =>
    request<{ ok: true }>(`/api/v1/user-packages/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};
