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
}

export interface CreateServerResponse {
  server: Server;
  token: string;
  install_command: string;
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
}

export interface UpdateNodeInput {
  name?: string;
  port?: number;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface ApplyResult {
  config_version: number;
  /** 后端正在加；暂时没有时按空数组处理。 */
  warnings?: string[] | null;
}

/** P1：用户与套餐契约，见 docs/PLAN.md「P1：用户与套餐（本轮契约）」。 */
export type UserRole = "admin" | "user";
export type UserStatus = "active" | "disabled";
export type PackageDirection = "both" | "upload" | "download";

export interface UserPackageView {
  id: string;
  package_id: string;
  package_name: string;
  quota_bytes: number | null;
  used_bytes: number;
  expires_at: number | null;
  reset_day: number | null;
  status: string;
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

export const api = {
  health: () => request<Health>("/api/v1/health"),
  me: () => request<{ user: SessionUser }>("/api/v1/auth/me"),
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
