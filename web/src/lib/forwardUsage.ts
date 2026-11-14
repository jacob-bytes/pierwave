/**
 * 转发日表对账的纯展示逻辑：窗口标签、总量计算、排序与去重。
 *
 * 不依赖 React / DOM / API 类型，`node --test` 可以直接 import。
 *
 * 口径：
 * - `bytes` 是原始上下行之和（对账）；
 * - `weighted` 是按套餐方向/倍率换算后的计费值（配额）。
 * 两者都按非负有限数处理，字段异常时计 0，绝不让 NaN/负数污染合计。
 */

/** 页面提供的时间窗（天）；与后端 `days` 的 1..=90 约束对齐。 */
export const FORWARD_USAGE_WINDOWS = [7, 30, 90] as const;

export type ForwardUsageWindow = (typeof FORWARD_USAGE_WINDOWS)[number];

export function isForwardUsageWindow(value: number): value is ForwardUsageWindow {
  return (FORWARD_USAGE_WINDOWS as readonly number[]).includes(value);
}

/** 只依赖 `t()` 的翻译函数签名，便于单测注入假翻译器。 */
export type TranslateFn = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** 窗口按钮文案；实际词典键在 `forwardUsage.windowDays`。 */
export function windowLabel(days: number, t: TranslateFn): string {
  return t("forwardUsage.windowDays", { n: days });
}

export interface ForwardUsageTotals {
  bytes: number;
  weighted: number;
}

export interface ForwardUsageDayLike {
  day?: string | null;
  bytes?: number | null;
  weighted?: number | null;
}

export interface ForwardUsageRowLike {
  forward_id: string;
  name: string;
  forward_deleted?: boolean | null;
  user_id: string;
  user_name?: string | null;
  user_deleted?: boolean | null;
  bytes?: number | null;
  weighted?: number | null;
}

/** 非负有限数；缺失 / NaN / Infinity / 负数一律按 0。 */
function usageNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value > 0 ? value : 0;
}

/** 窗口合计：分别累加原始与计费，供顶部总量展示。 */
export function sumUsageDays(
  days: readonly ForwardUsageDayLike[] | null | undefined,
): ForwardUsageTotals {
  let bytes = 0;
  let weighted = 0;
  for (const row of days ?? []) {
    bytes += usageNumber(row?.bytes);
    weighted += usageNumber(row?.weighted);
  }
  return { bytes, weighted };
}

/** 窗口内是否完全没有数据（用于 empty 态，而不是「所有天都补 0」）。 */
export function isUsageEmpty(
  totals: ForwardUsageTotals | null | undefined,
  rows: readonly ForwardUsageRowLike[] | null | undefined,
): boolean {
  return (
    (rows?.length ?? 0) === 0 &&
    usageNumber(totals?.bytes) === 0 &&
    usageNumber(totals?.weighted) === 0
  );
}

/**
 * 按用户筛选；空串 / null / 空白 = 全部，返回新数组（不改输入）。
 * `user_id` 精确匹配，已删除用户同样可筛。
 */
export function filterUsageRows<T extends ForwardUsageRowLike>(
  rows: readonly T[] | null | undefined,
  userId: string | null | undefined,
): T[] {
  const filter = typeof userId === "string" ? userId.trim() : "";
  if (!filter) return [...(rows ?? [])];
  return (rows ?? []).filter((row) => row.user_id === filter);
}

/**
 * 按计费值、原始值降序，再按 id 升序稳定排序；返回新数组。
 * 计费值相同但原始值不同时，原始值大的在前（对账时更直观）。
 */
export function sortUsageRows<T extends ForwardUsageRowLike>(
  rows: readonly T[] | null | undefined,
): T[] {
  return [...(rows ?? [])].sort((left, right) => {
    const weighted =
      usageNumber(right.weighted) - usageNumber(left.weighted);
    if (weighted !== 0) return weighted;
    const bytes = usageNumber(right.bytes) - usageNumber(left.bytes);
    if (bytes !== 0) return bytes;
    if (left.forward_id !== right.forward_id) {
      return left.forward_id < right.forward_id ? -1 : 1;
    }
    return left.user_id < right.user_id ? -1 : left.user_id > right.user_id ? 1 : 0;
  });
}

/** 转发展示名：已删除时用当前语言的占位文案，其余用后端返回的名字。 */
export function forwardUsageName(
  row: Pick<ForwardUsageRowLike, "name" | "forward_deleted">,
  deletedLabel: string,
): string {
  if (row.forward_deleted) return deletedLabel;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  return name || deletedLabel;
}

/** 用户展示名：同上；用户端响应没有 `user_name` 时不显示占位。 */
export function forwardUsageUserName(
  row: Pick<ForwardUsageRowLike, "user_name" | "user_deleted">,
  deletedLabel: string,
): string {
  if (row.user_deleted) return deletedLabel;
  const name = typeof row.user_name === "string" ? row.user_name.trim() : "";
  return name || deletedLabel;
}

/** 用户筛选项：按首次出现收集，标签排序；同一用户只出现一次。 */
export function usageUserOptions(
  rows: readonly ForwardUsageRowLike[] | null | undefined,
  deletedLabel: string,
): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const row of rows ?? []) {
    if (!row.user_id || seen.has(row.user_id)) continue;
    seen.set(row.user_id, forwardUsageUserName(row, deletedLabel));
  }
  return [...seen]
    .map(([id, label]) => ({ id, label }))
    .sort((left, right) => {
      // 大小写不敏感，避免 "Deleted" 因为大写 D 排到所有用户名之前。
      const leftLabel = left.label.toLowerCase();
      const rightLabel = right.label.toLowerCase();
      if (leftLabel !== rightLabel) return leftLabel < rightLabel ? -1 : 1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
}
