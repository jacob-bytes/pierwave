/**
 * API Token 的前端纯逻辑：scope 文案、过期描述、一次性明文展示状态机。
 *
 * 放在这里而不是 `.tsx` 里，是为了让 `node --test` 能直接覆盖边界
 * （过期判定、吊销优先于过期、明文只保留到关闭对话框）。
 */

import { toDateInputValue } from "./time.ts";

export const API_TOKEN_SCOPES = ["read", "admin"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
export const DEFAULT_API_TOKEN_SCOPE: ApiTokenScope = "read";

/** 名称上限与后端 `repo::api_tokens::MAX_NAME_CHARS` 保持一致。 */
export const API_TOKEN_NAME_MAX = 64;

export type ApiTokenStatus = "active" | "expired" | "revoked";

export function isApiTokenScope(value: unknown): value is ApiTokenScope {
  return (
    typeof value === "string" &&
    (API_TOKEN_SCOPES as readonly string[]).includes(value)
  );
}

/** 选项/列表里的短标签 key。 */
export function scopeLabelKey(scope: string): string {
  return scope === "admin"
    ? "settings.apiTokens.scope.admin"
    : "settings.apiTokens.scope.read";
}

/**
 * scope 的一句权限说明。
 *
 * 只在「语义容易被误解」时写：read 不是「只能看自己的数据」，而是所有
 * 只读接口；admin 不是「能读更多」，而是等同管理员、可以写。
 */
export function scopeHintKey(scope: string): string {
  return scope === "admin"
    ? "settings.apiTokens.scope.adminHint"
    : "settings.apiTokens.scope.readHint";
}

export type ExpiryDescriptor =
  | { kind: "never" }
  | { kind: "expired"; date: string }
  | { kind: "at"; date: string };

/**
 * 过期时间 → 展示描述。空值 = 永久；已过期单独一档，
 * 避免列表里只显示一个和「创建时间」很像的日期。
 */
export function describeExpiry(
  expiresAt: number | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1_000),
): ExpiryDescriptor {
  if (expiresAt === null || expiresAt === undefined) return { kind: "never" };
  const date = toDateInputValue(expiresAt);
  if (!date) return { kind: "never" };
  return expiresAt <= nowSeconds ? { kind: "expired", date } : { kind: "at", date };
}

/** 吊销优先于过期：已吊销的 token 即使过期也显示「已吊销」。 */
export function tokenStatus(
  token: { revoked_at: number | null; expires_at: number | null },
  nowSeconds = Math.floor(Date.now() / 1_000),
): ApiTokenStatus {
  if (token.revoked_at !== null && token.revoked_at !== undefined) {
    return "revoked";
  }
  if (
    token.expires_at !== null &&
    token.expires_at !== undefined &&
    token.expires_at <= nowSeconds
  ) {
    return "expired";
  }
  return "active";
}

export type TokenNameProblem = "empty" | "too_long" | "control" | null;

/** 创建对话框的即时校验；提交前仍以后端校验为准。 */
export function validateTokenName(raw: string): TokenNameProblem {
  const name = raw.trim();
  if (!name) return "empty";
  if (name.length > API_TOKEN_NAME_MAX) return "too_long";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "control";
  return null;
}

/** 一次性明文状态机：只有 `created` 阶段持有明文。 */
export type TokenRevealState =
  | { phase: "idle" }
  | { phase: "created"; token: string }
  | { phase: "dismissed" };

export type TokenRevealAction =
  | { type: "created"; token: string }
  | { type: "dismissed" }
  | { type: "reset" };

export function tokenRevealReducer(
  state: TokenRevealState,
  action: TokenRevealAction,
): TokenRevealState {
  switch (action.type) {
    case "created":
      // 空明文不是合法状态：保持原状，避免 UI 展示一个空 code block。
      return action.token ? { phase: "created", token: action.token } : state;
    case "dismissed":
      // 关键不变量：关闭后明文从状态里彻底移除，无法「再显示一次」。
      return state.phase === "created" ? { phase: "dismissed" } : state;
    case "reset":
      return { phase: "idle" };
  }
}

/** 当前可展示的明文；不在 `created` 阶段一律为 null。 */
export function revealedToken(state: TokenRevealState): string | null {
  return state.phase === "created" ? state.token : null;
}
