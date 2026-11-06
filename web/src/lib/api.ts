import { t } from "@/i18n";

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

export interface CreateServerResponse {
  server: Server;
  token: string;
  install_command: string;
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
}

export interface CreateUserInput {
  username: string;
  password: string;
  role?: UserRole;
  quota_bytes?: number | null;
}

export interface UpdateUserInput {
  status?: UserStatus;
  role?: UserRole;
  password?: string;
  quota_bytes?: number | null;
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
