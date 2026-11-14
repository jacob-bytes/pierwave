/**
 * 概览页批量操作的纯逻辑：天数校验与两个对话框的状态机。
 *
 * 组件只负责渲染与网络请求；这里不 import React，方便用 `node --test` 直接覆盖
 * 「空 / 非法 / 超范围」以及「输入 → 确认 → 提交 / 返回」的状态迁移。
 */

export const RENEW_DAY_PRESETS = [7, 30, 90] as const;
export const RENEW_DAYS_MIN = 1;
export const RENEW_DAYS_MAX = 365;

export type RenewDaysProblem = "empty" | "invalid" | "outOfRange";

export type RenewDaysValidation =
  | { ok: true; days: number }
  | { ok: false; problem: RenewDaysProblem };

/**
 * 校验续期天数输入。
 *
 * 只接受纯十进制整数（前后空白忽略）；`7.0`、`+7`、`1e2`、`0`、`366` 全部拒绝。
 * 空串单独返回 `empty`，让 UI 在用户还没输入时不显示错误。
 */
export function validateRenewDays(raw: string): RenewDaysValidation {
  const value = raw.trim();
  if (value === "") return { ok: false, problem: "empty" };
  if (!/^\d+$/.test(value)) return { ok: false, problem: "invalid" };

  const days = Number(value);
  if (
    !Number.isSafeInteger(days) ||
    days < RENEW_DAYS_MIN ||
    days > RENEW_DAYS_MAX
  ) {
    return { ok: false, problem: "outOfRange" };
  }
  return { ok: true, days };
}

export type RenewDialogStage = "input" | "confirm";

export interface RenewDialogState {
  stage: RenewDialogStage;
  daysInput: string;
  submitting: boolean;
  error: string | null;
}

export type RenewDialogAction =
  | { type: "reset" }
  | { type: "input"; value: string }
  | { type: "preset"; days: number }
  | { type: "next" }
  | { type: "back" }
  | { type: "submit" }
  | { type: "failure"; message: string };

/** 默认 30 天；每次打开对话框都从这一步开始。 */
export function initialRenewDialogState(): RenewDialogState {
  return { stage: "input", daysInput: "30", submitting: false, error: null };
}

export function renewDialogReducer(
  state: RenewDialogState,
  action: RenewDialogAction,
): RenewDialogState {
  switch (action.type) {
    case "reset":
      return initialRenewDialogState();
    case "input":
      return { ...state, daysInput: action.value, error: null };
    case "preset":
      return { ...state, daysInput: String(action.days), error: null };
    case "next":
      // 非法输入不能进入二次确认；校验文案由组件按 problem 渲染。
      return validateRenewDays(state.daysInput).ok && state.stage === "input"
        ? { ...state, stage: "confirm", error: null }
        : state;
    case "back":
      return { ...state, stage: "input", submitting: false, error: null };
    case "submit":
      return state.stage === "confirm"
        ? { ...state, submitting: true, error: null }
        : state;
    case "failure":
      return {
        ...state,
        stage: "confirm",
        submitting: false,
        error: action.message,
      };
  }
}

export type CleanupRange = "7" | "30" | "all";

export interface CleanupPreset {
  value: CleanupRange;
  days: number | null;
}

/** 「全部」用 `null` 表示，不是 0：0 天没有意义，也容易被误当成「今天」。 */
export const CLEANUP_PRESETS: readonly CleanupPreset[] = [
  { value: "7", days: 7 },
  { value: "30", days: 30 },
  { value: "all", days: null },
];

export function cleanupDaysFor(range: CleanupRange): number | null {
  return CLEANUP_PRESETS.find((preset) => preset.value === range)?.days ?? null;
}

export type CleanupDialogStage = "input" | "confirm";

export interface CleanupDialogState {
  stage: CleanupDialogStage;
  range: CleanupRange;
  submitting: boolean;
  error: string | null;
}

export type CleanupDialogAction =
  | { type: "reset" }
  | { type: "select"; range: CleanupRange }
  | { type: "next" }
  | { type: "back" }
  | { type: "submit" }
  | { type: "failure"; message: string };

/** 默认 30 天以前：比 7 天删得少，是更保守的破坏性操作默认值。 */
export function initialCleanupDialogState(): CleanupDialogState {
  return { stage: "input", range: "30", submitting: false, error: null };
}

export function cleanupDialogReducer(
  state: CleanupDialogState,
  action: CleanupDialogAction,
): CleanupDialogState {
  switch (action.type) {
    case "reset":
      return initialCleanupDialogState();
    case "select":
      return { ...state, range: action.range, error: null };
    case "next":
      return state.stage === "input"
        ? { ...state, stage: "confirm", error: null }
        : state;
    case "back":
      return { ...state, stage: "input", submitting: false, error: null };
    case "submit":
      return state.stage === "confirm"
        ? { ...state, submitting: true, error: null }
        : state;
    case "failure":
      return {
        ...state,
        stage: "confirm",
        submitting: false,
        error: action.message,
      };
  }
}

/** 非负整数人数：NaN / Infinity / 负数 / 小数都归一化成 0 或截断值。 */
function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

export type DisableOverQuotaDialogStage = "count" | "confirm";

export interface DisableOverQuotaDialogState {
  stage: DisableOverQuotaDialogStage;
  /** 进入确认页时冻结的人数；后台 refetch 不会改掉正在确认的文案。 */
  count: number;
  submitting: boolean;
  error: string | null;
}

export type DisableOverQuotaDialogAction =
  | { type: "reset" }
  | { type: "next"; count: number }
  | { type: "back" }
  | { type: "submit" }
  | { type: "failure"; message: string };

/** 每次都从第一步（展示影响范围）开始。 */
export function initialDisableOverQuotaDialogState(): DisableOverQuotaDialogState {
  return { stage: "count", count: 0, submitting: false, error: null };
}

export function disableOverQuotaDialogReducer(
  state: DisableOverQuotaDialogState,
  action: DisableOverQuotaDialogAction,
): DisableOverQuotaDialogState {
  switch (action.type) {
    case "reset":
      return initialDisableOverQuotaDialogState();
    case "next": {
      // 0 人时没有可确认的操作：停在第一步，由 UI 提示「没有需要停用的用户」。
      const count = normalizeCount(action.count);
      return state.stage === "count" && count > 0
        ? { ...state, stage: "confirm", count, error: null }
        : state;
    }
    case "back":
      return { ...state, stage: "count", submitting: false, error: null };
    case "submit":
      return state.stage === "confirm"
        ? { ...state, submitting: true, error: null }
        : state;
    case "failure":
      return {
        ...state,
        stage: "confirm",
        submitting: false,
        error: action.message,
      };
  }
}

/** 第一步的人数文案：0 单独一句，避免出现「将影响 0 个用户」。 */
export function overQuotaScopeNotice(count: number): {
  key: string;
  params?: { n: number };
} {
  const n = normalizeCount(count);
  return n === 0
    ? { key: "overview.disableDialog.noTargets" }
    : { key: "overview.disableDialog.scope", params: { n } };
}

export interface BatchResultNotice {
  tone: "success" | "info";
  key: string;
  params?: { n: number };
}

/** 提交结果提示：停用了 N 人 / 没有需要停用的用户（0 不是错误）。 */
export function overQuotaResultNotice(disabled: number): BatchResultNotice {
  const n = normalizeCount(disabled);
  return n === 0
    ? { tone: "info", key: "overview.disableDialog.empty" }
    : {
        tone: "success",
        key: "overview.disableDialog.success",
        params: { n },
      };
}
