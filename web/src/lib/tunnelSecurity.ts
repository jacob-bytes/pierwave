/**
 * tunnel 引擎的隧道加密模式纯逻辑：不依赖 React / DOM。
 *
 * 与后端契约对齐：
 * - `tls`（缺省，推荐）：双方使用主控自有 CA 签发的证书，主控自动签发；
 * - `noise`：不需要证书，双方用预共享密钥认证，每 10 分钟重新协商会话密钥；
 * - 字段只在 `engine = tunnel` 时有意义，其它引擎不显示、不提交；
 * - 读路径对缺失 / 未知 / 大小写不匹配的值一律回落到 `tls`，与后端缺省一致。
 */

import type { TunnelSecurity } from "./api.ts";
import { normalizeEngine } from "./engines.ts";

/** 模式白名单；顺序也是表单里的展示顺序。 */
export const TUNNEL_SECURITY_MODES = ["tls", "noise"] as const;

export type { TunnelSecurity };

/** 新建链 / 表单初始值：证书模式是推荐项。 */
export const DEFAULT_TUNNEL_SECURITY: TunnelSecurity = "tls";

/**
 * 表单与序列化用：`tls` / `noise` 原样返回，其余（缺省、未知值、
 * 大小写不匹配）回落到 `tls`，保证 PATCH 不会把脏值写回去。
 */
export function normalizeTunnelSecurity(value: unknown): TunnelSecurity {
  if (typeof value !== "string") return DEFAULT_TUNNEL_SECURITY;
  const trimmed = value.trim();
  return trimmed === "tls" || trimmed === "noise"
    ? trimmed
    : DEFAULT_TUNNEL_SECURITY;
}

/** 二选一的模式标签键（`chains.tunnelSecurity.*`），未知值按 `tls`。 */
export function securityLabelKey(value: unknown): string {
  return `chains.tunnelSecurity.${normalizeTunnelSecurity(value)}.label`;
}

/** 列表小标的键：`tls` → TLS、`noise` → PSK。 */
export function securityBadgeKey(value: unknown): string {
  return `chains.tunnelSecurity.${normalizeTunnelSecurity(value)}.badge`;
}

/**
 * 该链是否显示「隧道加密」项：只有 tunnel 引擎有这条语义。
 *
 * 未知引擎、旧后端缺失字段一律按 `native` 处理（与 `normalizeEngine` 一致），
 * 因此不会凭空出现一个对其它引擎无意义的选项。
 */
export function securityVisible(engine: unknown): boolean {
  return normalizeEngine(engine) === "tunnel";
}
