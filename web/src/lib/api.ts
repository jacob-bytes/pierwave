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

export const api = {
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
};
