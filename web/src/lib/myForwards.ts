/**
 * 用户自助转发的纯展示逻辑：不依赖 React / DOM / API 类型。
 *
 * 配额语义（顺序很重要）：
 * 1. 没有配额对象、`limit <= 0` 或 `limit` 不是有限数字 → `none`：
 *    当前套餐不支持自助转发，空态与隐藏新建按钮都以它为准；
 * 2. `used >= limit` → `exhausted`：条数已用尽，不能再建；
 * 3. 其余（`0 <= used < limit`）→ `available`。
 *
 * `used` 缺失 / 非数字 / 负数都按 0 处理：后端字段异常时宁可多给一次
 * 新建机会（后端仍会校验），也不要把可用配额算成负数。
 */

export interface ForwardQuotaLike {
  used?: number | null;
  limit?: number | null;
}

export type QuotaState = "none" | "available" | "exhausted";

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < 0 ? 0 : value;
}

export function quotaState(
  quota: ForwardQuotaLike | null | undefined,
): QuotaState {
  if (!quota) return "none";

  const limit = nonNegativeNumber(quota.limit);
  if (limit === null || limit <= 0) return "none";

  const used = nonNegativeNumber(quota.used) ?? 0;
  return used >= limit ? "exhausted" : "available";
}

/** 只有 `available` 才允许新建；`none` / `exhausted` 都不可创建。 */
export function canCreate(
  quota: ForwardQuotaLike | null | undefined,
): boolean {
  return quotaState(quota) === "available";
}

/** 入口地址的最小字段集：不要求完整 item，方便测试与骨架屏复用。 */
export interface ForwardEntryLike {
  entry_address?: string | null;
  listen_port?: number | null;
}

/**
 * 列表 / 复制按钮展示的入口地址。
 *
 * 后端返回的 `entry_address` 已经含端口；这里只去掉首尾空白，
 * 不做任何拼接。缺失时给占位符「—」，**不拿 `listen_port` 拼一个
 * 用户无法直接使用的地址**（缺主机名时拼出来只会误导）。
 */
export function entryLabel(
  item: ForwardEntryLike | null | undefined,
): string {
  const raw = item?.entry_address;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || "—";
}
