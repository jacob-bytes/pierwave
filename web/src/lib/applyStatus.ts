/**
 * 受管文件应用结果的展示逻辑（不依赖 React / i18n）。
 *
 * 契约见 `docs/APPLY-STATUS.md`：
 * - `partial` 是「提交阶段失败，失败点之前的文件已生效」，不是整体失败；
 * - `effective_count` 由后端派生，但前端仍按 `effective.length` 兜底，避免
 *   旧缓存或手写数据少一个字段就把计数显示错；
 * - `apply_error` 是错误原文，失败时**原样展示**，这里不做改写或截断。
 */

import type { ServerApplyPartial, ServerApplyStatus } from "./api.ts";

export type ApplyFailureStatus = "partial" | "failed";

export interface ApplySummary {
  /** 只有 partial / failed 会生成摘要；ok 与 null 返回 null。 */
  status: ApplyFailureStatus;
  /** 已生效文件数；partial 时 = effective.length。 */
  count: number;
  /** 本轮期望文件总数；脏数据会至少夹到 count。 */
  total: number;
  /** Agent 报告的失败阶段；缺字段时为 null。 */
  stage: string | null;
  /** 已生效文件路径，保持后端顺序。 */
  effective: string[];
  /** `apply_error` 原文；空串/null 为 null。 */
  error: string | null;
}

/** 从 Server 里只取应用结果需要的字段，方便 node:test 直接传最小对象。 */
export interface ApplyServerFields {
  apply_status?: ServerApplyStatus | string | null;
  apply_error?: string | null;
  apply_partial?: ServerApplyPartial | null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function cleanPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * 把服务器上的应用字段归一成展示摘要。
 *
 * - `ok` / `null` / 未知状态 → `null`（不制造徽标噪音）；
 * - `partial` → 计数取 `effective.length`，total 至少不小于计数；
 * - `failed` → 只带 `apply_error` 原文。
 */
export function applySummary(server: ApplyServerFields): ApplySummary | null {
  const status = server.apply_status;
  if (status !== "partial" && status !== "failed") return null;

  const error =
    typeof server.apply_error === "string" &&
    server.apply_error.trim().length > 0
      ? server.apply_error
      : null;

  if (status === "failed") {
    return {
      status,
      count: 0,
      total: 0,
      stage: null,
      effective: [],
      error,
    };
  }

  const partial = server.apply_partial ?? null;
  const effective = cleanPaths(partial?.effective);
  const reportedCount = integerOrNull(partial?.effective_count);
  const count = effective.length > 0 ? effective.length : (reportedCount ?? 0);
  const reportedTotal = integerOrNull(partial?.total);
  const stage =
    typeof partial?.stage === "string" && partial.stage.trim().length > 0
      ? partial.stage.trim()
      : null;

  return {
    status,
    count,
    total: reportedTotal === null ? count : Math.max(reportedTotal, count),
    stage,
    effective,
    error,
  };
}
