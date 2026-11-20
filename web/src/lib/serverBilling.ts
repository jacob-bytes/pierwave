/**
 * 管理端「费用与到期」表单的纯逻辑（不依赖 React / DOM / i18n）。
 *
 * 后端的四个字段是**可选公开展示数据**（见 `crates/domain/src/billing.rs`）：
 * 填了会出现在公开状态页，留空 / null = 不填写。这里只做三件事：
 * 1. 服务器对象 → 表单值（编辑回填，脏值按未填写处理）；
 * 2. 表单值 → 提交载荷（元 → 分、空串 → null，显式清空）；
 * 3. 表单值 → 字段级错误 key，以及后端错误码 → 字段的映射。
 *
 * 价格在界面上用「元」输入，提交时转为后端要的「分」；小数最多两位，
 * 用字符串拆分换算，避免 `49.99 * 100 = 4998.999…` 这类浮点误差。
 */

import { ApiError } from "./apiError.ts";
import type { Server } from "./api";

/** 常用币种；其余走「自定义」，后端只校验 3 位大写字母。 */
export const BILLING_CURRENCIES = ["CNY", "USD", "EUR"] as const;

/** 与后端 `BILLING_CYCLES` 一致。 */
export const BILLING_CYCLES = ["monthly", "yearly", "once"] as const;

export type BillingCycle = (typeof BILLING_CYCLES)[number];

/** 四个字段在后端错误 `params.field` 与表单里用同一组键名。 */
export type BillingField =
  | "paid_until"
  | "price_cents"
  | "currency"
  | "billing_cycle";

/** 表单持有的是「用户看到的字符串」：日期、元、币种、周期。 */
export interface ServerBillingForm {
  /** `YYYY-MM-DD`；空串 = 不填写。 */
  paidUntil: string;
  /** 价格（元）；空串 = 不填写。 */
  price: string;
  /** 3 位大写币种；空串 = 不填写。 */
  currency: string;
  /** `monthly` / `yearly` / `once`；空串 = 不填写。 */
  cycle: string;
}

export const EMPTY_BILLING_FORM: ServerBillingForm = {
  paidUntil: "",
  price: "",
  currency: "",
  cycle: "",
};

/**
 * 字段 → **已翻译**的错误文案（直接渲染在字段下方）。
 *
 * `validateBillingForm` 返回的是 i18n key，调用方用 `translateBillingErrors`
 * 翻译一次；后端错误码走 `errorText()` 直接得到译文。这样 `BillingFields`
 * 不关心文案来源，也不会对已经是句子的文本再跑一次 `t()`。
 */
export type BillingFieldErrors = Partial<Record<BillingField, string>>;

/** 后端价格上界：999_999_999 分 = 9_999_999.99 元。 */
export const PRICE_CENTS_MAX = 999_999_999;

/** 币种下拉里「未填写」与「自定义」的哨兵值；不会提交给后端。 */
export const CURRENCY_NONE = "none";
export const CURRENCY_CUSTOM = "custom";
/** 周期下拉里的「未填写」哨兵值；Radix 不允许空字符串作为 item value。 */
export const BILLING_NONE = "none";

/** 严格 `YYYY-MM-DD` 且日期真实存在（拒绝 2026-02-30、2026-2-01）。 */
export function isIsoDate(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** 恰好 3 位 ASCII 大写字母；与后端 `is_currency` 同一规则。 */
export function isCurrencyCode(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

/** 分 → 元输入框的文本；无效 / 空值返回空串。 */
export function formatPriceYuan(
  cents: number | null | undefined,
): string {
  if (
    cents === null ||
    cents === undefined ||
    !Number.isFinite(cents) ||
    cents < 0 ||
    cents > PRICE_CENTS_MAX
  ) {
    return "";
  }
  // 4999 → "49.99"、4990 → "49.9"、5000 → "50"；不做千分位，输入框里别加逗号。
  return String(cents / 100);
}

export type PriceParseResult =
  | { ok: true; cents: number | null }
  | { ok: false; reason: "format" | "range" };

/**
 * 元输入 → 分。空串 = 不填写（`cents: null`）。
 *
 * 只接受非负十进制、最多两位小数：`0`、`0.5`、`49.99`、`9999999.99`。
 * 负号、逗号、超过两位小数、科学计数法都是格式错误；超过上界是范围错误。
 * 用字符串拆分整 / 小数部分，避免浮点乘法把 49.99 变成 4998。
 */
export function parsePriceYuan(input: string): PriceParseResult {
  const value = input.trim();
  if (value === "") return { ok: true, cents: null };

  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    return { ok: false, reason: "format" };
  }

  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > PRICE_CENTS_MAX) {
    return { ok: false, reason: "range" };
  }
  return { ok: true, cents };
}

/**
 * 编辑回填：服务器字段 → 表单字符串。
 *
 * 后端读路径已经会把脏值降级为 null；这里再兜一层，保证旧后端 / 手工数据
 * 不会把非法值塞进输入框（否则用户一保存就被后端拒绝）。
 */
export function billingFormFromServer(
  server: Pick<
    Server,
    "paid_until" | "price_cents" | "currency" | "billing_cycle"
  >,
): ServerBillingForm {
  const paidUntil = server.paid_until;
  const currency = server.currency;
  const cycle = server.billing_cycle;
  return {
    paidUntil:
      typeof paidUntil === "string" && isIsoDate(paidUntil)
        ? paidUntil.trim()
        : "",
    price: formatPriceYuan(server.price_cents),
    currency:
      typeof currency === "string" && isCurrencyCode(currency)
        ? currency.trim()
        : "",
    cycle:
      typeof cycle === "string" &&
      (BILLING_CYCLES as readonly string[]).includes(cycle)
        ? cycle
        : "",
  };
}

/** 四个字段里是否至少填了一个（决定「会公开」提示与清空按钮是否出现）。 */
export function hasAnyBillingField(form: ServerBillingForm): boolean {
  return (
    form.paidUntil.trim() !== "" ||
    form.price.trim() !== "" ||
    form.currency.trim() !== "" ||
    form.cycle.trim() !== ""
  );
}

/**
 * 提交前的前端校验：返回字段 → 文案 key；空对象 = 通过。
 *
 * 错误 key 与「会公开」提示都在 `servers.billing` 命名空间下；调用方只
 * 负责 `t()`，不自己拼句子。客户端先拦一次，后端仍然是权威（错误码映射见
 * `billingFieldForError`）。
 */
export function validateBillingForm(
  form: ServerBillingForm,
): BillingFieldErrors {
  const errors: BillingFieldErrors = {};

  const paidUntil = form.paidUntil.trim();
  if (paidUntil !== "" && !isIsoDate(paidUntil)) {
    errors.paid_until = "servers.billing.errors.paidUntil";
  }

  const price = parsePriceYuan(form.price);
  if (!price.ok) {
    errors.price_cents = "servers.billing.errors.price";
  }

  const currency = form.currency.trim();
  if (currency !== "" && !isCurrencyCode(currency)) {
    errors.currency = "servers.billing.errors.currency";
  }

  const cycle = form.cycle.trim();
  if (
    cycle !== "" &&
    !(BILLING_CYCLES as readonly string[]).includes(cycle)
  ) {
    errors.billing_cycle = "servers.billing.errors.cycle";
  }

  return errors;
}

/** 把 `validateBillingForm` 返回的 key 翻成最终文案，供表单直接渲染。 */
export function translateBillingErrors(
  errors: BillingFieldErrors,
  translate: (key: string) => string,
): BillingFieldErrors {
  const translated: BillingFieldErrors = {};
  for (const [field, key] of Object.entries(errors)) {
    if (key) translated[field as BillingField] = translate(key);
  }
  return translated;
}

/** `/api/v1/servers` 的 POST / PATCH 里的四个费用字段。 */
export interface BillingPayload {
  paid_until: string | null;
  price_cents: number | null;
  currency: string | null;
  billing_cycle: BillingCycle | null;
}

/**
 * 表单 → 提交载荷。空 = `null`（显式清空），不是省略。
 *
 * PATCH 的三态语义是「缺省沿用 / null 清空 / 值覆盖」；编辑弹窗每次都把四个
 * 字段一起发出去，所以留空必须发 null，否则用户永远清不掉旧值。
 * 调用方应先跑 `validateBillingForm`；非法值在这里一律按 null 处理，
 * 绝不把脏数据提交给后端。
 */
export function billingPayload(form: ServerBillingForm): BillingPayload {
  const paidUntil = form.paidUntil.trim();
  const price = parsePriceYuan(form.price);
  const currency = form.currency.trim().toUpperCase();
  const cycle = form.cycle.trim();

  return {
    paid_until: isIsoDate(paidUntil) ? paidUntil : null,
    price_cents: price.ok ? price.cents : null,
    currency: isCurrencyCode(currency) ? currency : null,
    billing_cycle: (BILLING_CYCLES as readonly string[]).includes(cycle)
      ? (cycle as BillingCycle)
      : null,
  };
}

/** 后端错误码 → 表单字段；不认识的错误返回 null（由页面走通用错误）。 */
export function billingFieldForError(error: unknown): BillingField | null {
  if (!(error instanceof ApiError)) return null;

  switch (error.code) {
    case "server.paid_until_invalid":
      return "paid_until";
    case "server.price_cents_invalid":
      return "price_cents";
    case "server.currency_invalid":
      return "currency";
    case "server.billing_cycle_invalid":
      return "billing_cycle";
    default:
      break;
  }

  // 旧后端可能只有 params.field：能对上就落到字段，对不上走通用错误。
  const field = error.params?.field;
  return field === "paid_until" ||
    field === "price_cents" ||
    field === "currency" ||
    field === "billing_cycle"
    ? field
    : null;
}

/** 币种下拉当前该选中哪一项：已知币种原样，未知非空 = 自定义，空 = 未填写。 */
export function currencySelectValue(currency: string): string {
  const value = currency.trim().toUpperCase();
  if (value === "") return CURRENCY_NONE;
  return (BILLING_CURRENCIES as readonly string[]).includes(value)
    ? value
    : CURRENCY_CUSTOM;
}

/** 下拉选择「自定义」时的输入框清洗：只留字母并转大写，最多 3 位。 */
export function sanitizeCurrencyInput(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3);
}
