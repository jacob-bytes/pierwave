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
    throw new ApiError(body?.error ?? `请求失败 (${res.status})`, res.status);
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
  quota_bytes: number | null;
  used_bytes: number;
  created_at: number;
  /** 套餐实例数；分页时 packages 可能不是全量，汇总用这个字段。 */
  package_count: number;
  packages: UserPackageView[];
}

export interface Package {
  id: string;
  name: string;
  quota_bytes: number | null;
  period_days: number | null;
  direction: PackageDirection;
  node_ratio: number;
  created_at?: number;
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

/** P4：用户自助契约，见 docs/PLAN.md「P4：用户端自助（本轮契约）」。 */
export interface MeSummaryUser {
  id: string;
  username: string;
  role: UserRole;
  short_code: string;
  used_bytes: number;
  quota_bytes: number | null;
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

export const api = {
  health: () => request<Health>("/api/v1/health"),
  stats: {
    overview: () => request<OverviewStats>("/api/v1/stats/overview"),
    traffic: (days: number) =>
      request<TrafficStats>(
        `/api/v1/stats/traffic?days=${encodeURIComponent(String(days))}`,
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

  nodes: (serverId: string) =>
    request<{ items: Node[] }>(
      `/api/v1/servers/${encodeURIComponent(serverId)}/nodes`,
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
