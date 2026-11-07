import { t } from "@/i18n";
import type { AgentUpgradeStatus } from "@/lib/agentUpgrade";
import type {
  AgentUpgradeBatchItemStatus,
  AgentUpgradeBatchStatus,
} from "@/lib/agentUpgradeBatch";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
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
    throw new ApiError(
      body?.error ?? t("errors.requestFailed", { status: res.status }),
      res.status,
    );
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
  let body: { error?: string } | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as { error?: string };
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    throw new ApiError(
      body?.error ?? t("errors.requestFailed", { status: res.status }),
      res.status,
    );
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

export interface Server {
  id: string;
  name: string;
  address: string;
  xray_mode: string;
  status: "online" | "offline";
  last_seen_at: number | null;
  config_version: number;
  created_at: number;

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
  /** 最后一次心跳的 Unix 秒。 */
  health_at: number | null;
}

export interface UpdateServerInput {
  /** P4：只允许改「是否允许下发升级」；其余字段后端暂未开放。 */
  allow_agent_upgrade?: boolean;
}

export interface CreateServerResponse {
  server: Server;
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
}

export interface UpdateNodeInput {
  name?: string;
  port?: number;
  enabled?: boolean;
  config?: Record<string, unknown>;
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
  role: UserRole;
  short_code: string;
  used_bytes: number;
  quota_bytes: number | null;
  /** 是否已超出账户总额度；后端算好，用于自助页的账户级横幅。 */
  quota_exceeded: boolean;
}

export interface MeSummary {
  user: MeSummaryUser;
  /** 与管理员视图同结构；quota_override=0 表示显式不限。 */
  packages: UserPackageView[];
  traffic: { today_bytes: number; month_bytes: number };
  /** 后端可能返回站内相对地址，展示前统一转成绝对 URL。 */
  subscription_url: string;
}

export type MeTraffic = TrafficStats;

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
}

export type UpdateSettingsInput = Partial<Settings>;

export interface ChangePasswordInput {
  old_password: string;
  new_password: string;
}

export const api = {
  health: () => request<Health>("/api/v1/health"),
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
  createServer: (input: { name: string; address: string; xray_mode: string }) =>
    request<CreateServerResponse>("/api/v1/servers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** P4：服务器设置（目前只开放「允许下发升级」）。后端可能暂时 404。 */
  updateServer: (id: string, input: UpdateServerInput) =>
    request<{ server: Server }>(`/api/v1/servers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

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

  /** 管理员可见的审计日志，按时间倒序；limit 由后端夹在 1..500。 */
  audit: {
    list: (limit: number) =>
      request<{ items: AuditEntry[] }>(
        `/api/v1/audit?limit=${encodeURIComponent(String(limit))}`,
      ),
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
