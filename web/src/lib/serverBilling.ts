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

/** 与后端 `BILLING_CYCLES` 一致的旧派生值（`billing_cycle`）。 */
export const BILLING_CYCLES = ["monthly", "yearly", "once"] as const;

export type BillingCycle = (typeof BILLING_CYCLES)[number];

/** 新契约的计费单位；与旧 `monthly` / `yearly` / `once` 一一对应。 */
export const BILLING_CYCLE_UNITS = ["month", "year", "once"] as const;

export type BillingCycleUnit = (typeof BILLING_CYCLE_UNITS)[number];

/** 数量范围（含），与后端的 1..=1200 一致。 */
export const BILLING_CYCLE_COUNT_MIN = 1;
export const BILLING_CYCLE_COUNT_MAX = 1200;

/** 四个字段在后端错误 `params.field` 与表单里用同一组键名。 */
export type BillingField =
  | "paid_until"
  | "price_cents"
  | "currency"
  | "billing_cycle_count"
  | "billing_cycle_unit";

/** 表单持有的是「用户看到的字符串」：日期、元、币种、周期数量与单位。 */
export interface ServerBillingForm {
  /** `YYYY-MM-DD`；空串 = 不填写。 */
  paidUntil: string;
  /** 价格（元）；空串 = 不填写。 */
  price: string;
  /** 3 位大写币种；空串 = 不填写。 */
  currency: string;
  /** 周期数量（整数字符串）；空串 = 不填写。 */
  cycleCount: string;
  /** `month` / `year` / `once`；空串 = 不填写。 */
  cycleUnit: string;
}

/**
 * 全部留空 = 未填写；新建表单初值、清空按钮与创建成功后的重置都用它。
 *
 * 新建表单**不预填** 1 个月：管理员没填过的周期不应该被写进服务器，否则
 * 公开页会对每台新服务器显示「未配置 / 1 个月」。用户选择单位时，数量才
 * 由 [`cycleCountForUnit`] 补默认 1。
 */
export const EMPTY_BILLING_FORM: ServerBillingForm = {
  paidUntil: "",
  price: "",
  currency: "",
  cycleCount: "",
  cycleUnit: "",
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

/** 到期日允许范围（含），与后端 `PAID_UNTIL_MIN/MAX` 一致。 */
export const PAID_UNTIL_MIN = "1970-01-01";
export const PAID_UNTIL_MAX = "2100-12-31";

/** 币种下拉里「未填写」与「自定义」的哨兵值；不会提交给后端。 */
export const CURRENCY_NONE = "none";
export const CURRENCY_CUSTOM = "custom";
/** 周期单位下拉里的「未填写」哨兵值；Radix 不允许空字符串作为 item value。 */
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

/**
 * 到期日是否在允许范围内：格式合法且 `1970-01-01 <= value <= 2100-12-31`。
 *
 * 日期是零填充的 `YYYY-MM-DD`，字符串比较等价于按日期比较；范围与后端
 * `PAID_UNTIL_MIN..=PAID_UNTIL_MAX` 一致，越界值在写路径会被 400 拒绝。
 */
export function isPaidUntilInRange(
  value: string | null | undefined,
): boolean {
  if (!isIsoDate(value)) return false;
  const date = (value as string).trim();
  return date >= PAID_UNTIL_MIN && date <= PAID_UNTIL_MAX;
}

/** 恰好 3 位 ASCII 大写字母；与后端 `is_currency` 同一规则。 */
export function isCurrencyCode(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

/** 是否是合法的周期单位（`month` / `year` / `once`）。 */
export function isBillingCycleUnit(
  value: string | null | undefined,
): value is BillingCycleUnit {
  return (
    typeof value === "string" &&
    (BILLING_CYCLE_UNITS as readonly string[]).includes(value)
  );
}

/** 旧派生值 → 新单位；`monthly → month`、`yearly → year`、`once → once`。 */
export function billingCycleUnitFor(
  cycle: string | null | undefined,
): BillingCycleUnit | null {
  if (typeof cycle !== "string") return null;
  switch (cycle.trim().toLowerCase()) {
    case "monthly":
      return "month";
    case "yearly":
      return "year";
    case "once":
      return "once";
    default:
      return null;
  }
}

/** 新单位 → 旧派生值；只用于兼容性提交。 */
export function billingCycleFor(unit: BillingCycleUnit): BillingCycle {
  return unit === "month" ? "monthly" : unit === "year" ? "yearly" : "once";
}

/** 数量是否落在 1..=1200 的整数区间。 */
export function isBillingCycleCount(
  value: number | null | undefined,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= BILLING_CYCLE_COUNT_MIN &&
    value <= BILLING_CYCLE_COUNT_MAX
  );
}

export type CycleCountParseResult =
  | { ok: true; count: number | null }
  | { ok: false; reason: "format" | "range" };

/**
 * 数量输入 → 整数。空串 = 未填写（`count: null`）。
 *
 * 只接受纯数字（不允许负号、小数点、科学计数法）。`0` 与大于 1200 是范围
 * 错误；`1.5`、`1e3`、`-1` 是格式错误。前导零按数值处理（`03` → 3）。
 */
export function parseCycleCount(input: string): CycleCountParseResult {
  const value = input.trim();
  if (value === "") return { ok: true, count: null };
  if (!/^\d+$/.test(value)) return { ok: false, reason: "format" };
  const count = Number(value);
  if (!Number.isSafeInteger(count)) return { ok: false, reason: "range" };
  if (!isBillingCycleCount(count)) return { ok: false, reason: "range" };
  return { ok: true, count };
}

/**
 * 选中某个单位时数量该变成什么：
 * - `once` 固定 1（控件同时禁用）；
 * - 月 / 年：数量为空时补默认 1，已有值保持不动。
 */
export function cycleCountForUnit(
  unit: BillingCycleUnit,
  current: string,
): string {
  if (unit === "once") return "1";
  return current.trim() === "" ? "1" : current;
}

/** 数量输入框清洗：只留数字，最多 4 位（1200 是上界）。不做范围裁剪。 */
export function sanitizeCycleCountInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, 4);
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
 * 新契约优先（`billing_cycle_count` + `billing_cycle_unit` 同时合法才用）；
 * 旧后端 / 旧数据只有 `billing_cycle` 时按 `monthly → 1 个月`、`yearly → 1 年`、
 * `once → 一次性` 回落。两者都没有 = 未填写（不回填默认值，避免编辑别的
 * 字段时给服务器悄悄写入周期）。
 *
 * 后端读路径已经会把脏值降级为 null；这里再兜一层，保证旧后端 / 手工数据
 * 不会把非法值塞进输入框（否则用户一保存就被后端拒绝）。
 */
export function billingFormFromServer(
  server: Pick<
    Server,
    | "paid_until"
    | "price_cents"
    | "currency"
    | "billing_cycle"
    | "billing_cycle_count"
    | "billing_cycle_unit"
  >,
): ServerBillingForm {
  const paidUntil = server.paid_until;
  const currency = server.currency;

  const unit = isBillingCycleUnit(server.billing_cycle_unit)
    ? server.billing_cycle_unit
    : null;
  const countParsed = parseCycleCount(
    server.billing_cycle_count == null
      ? ""
      : String(server.billing_cycle_count),
  );

  let cycleCount = "";
  let cycleUnit = "";
  if (unit === "once") {
    // 一次性没有「数量」语义；控件固定显示 1。
    cycleCount = "1";
    cycleUnit = "once";
  } else if (
    unit !== null &&
    countParsed.ok &&
    countParsed.count !== null
  ) {
    cycleCount = String(countParsed.count);
    cycleUnit = unit;
  } else {
    // 缺失一半 / 脏值都回落到旧派生字段。
    const legacyUnit = billingCycleUnitFor(server.billing_cycle);
    if (legacyUnit !== null) {
      cycleCount = "1";
      cycleUnit = legacyUnit;
    }
  }

  return {
    paidUntil:
      typeof paidUntil === "string" && isPaidUntilInRange(paidUntil)
        ? paidUntil.trim()
        : "",
    price: formatPriceYuan(server.price_cents),
    currency:
      typeof currency === "string" && isCurrencyCode(currency)
        ? currency.trim()
        : "",
    cycleCount,
    cycleUnit,
  };
}

/** 四个字段里是否至少填了一个（决定「会公开」提示与清空按钮是否出现）。 */
export function hasAnyBillingField(form: ServerBillingForm): boolean {
  return (
    form.paidUntil.trim() !== "" ||
    form.price.trim() !== "" ||
    form.currency.trim() !== "" ||
    form.cycleCount.trim() !== "" ||
    form.cycleUnit.trim() !== ""
  );
}

/**
 * 提交前的前端校验：返回字段 → 文案 key；空对象 = 通过。
 *
 * 错误 key 与「会公开」提示都在 `servers.billing` 命名空间下；调用方只
 * 负责 `t()`，不自己拼句子。客户端先拦一次，后端仍然是权威（错误码映射见
 * `billingFieldForError`）。
 *
 * 计费周期是「数量 + 单位」一对：
 * - 两者都空 = 未填写，合法；
 * - 只填一半 = 错误落在缺的那一格；
 * - `once` 的数量固定 1，缺数量不算「缺一半」。
 */
export function validateBillingForm(
  form: ServerBillingForm,
): BillingFieldErrors {
  const errors: BillingFieldErrors = {};

  const paidUntil = form.paidUntil.trim();
  if (paidUntil !== "" && !isPaidUntilInRange(paidUntil)) {
    errors.paid_until = "servers.billing.errors.paidUntil";
  }

  const price = parsePriceYuan(form.price);
  const priceFilled = form.price.trim() !== "";
  if (!price.ok) {
    errors.price_cents = "servers.billing.errors.price";
  }

  const currency = form.currency.trim();
  const currencyFilled = currency !== "";
  if (currencyFilled && !isCurrencyCode(currency)) {
    errors.currency = "servers.billing.errors.currency";
  }

  const unitRaw = form.cycleUnit.trim();
  const unitFilled = unitRaw !== "";
  const unit = isBillingCycleUnit(unitRaw) ? unitRaw : null;
  const count = parseCycleCount(form.cycleCount);
  const countFilled = form.cycleCount.trim() !== "";

  if (!count.ok) {
    // 格式 / 范围错误优先：数量本身不合法时不再叠加「缺单位」这类次生提示。
    errors.billing_cycle_count = "servers.billing.errors.cycleCount";
  }
  if (unitFilled && unit === null) {
    errors.billing_cycle_unit = "servers.billing.errors.cycleUnit";
  } else if (count.ok && unit === null && countFilled) {
    // 数量已填、单位留空：错误落在单位上。
    errors.billing_cycle_unit = "servers.billing.errors.cycleUnitPair";
  }
  if (
    count.ok &&
    count.count === null &&
    (unit === "month" || unit === "year")
  ) {
    // 单位已选、数量留空：一次性不要求数量，月 / 年要求。
    errors.billing_cycle_count = "servers.billing.errors.cycleCountPair";
  }

  // 价格与币种必须成对（后端 `server.billing_pair_incomplete`）：缺哪一侧，
  // 错误就落在哪一侧。只在已填的那一侧本身合法时提示，避免同一个字段
  // 同时报「格式不对」和「缺另一半」两条互相干扰的信息。
  if (priceFilled && !currencyFilled && price.ok) {
    errors.currency = "servers.billing.errors.currencyPair";
  } else if (!priceFilled && currencyFilled && isCurrencyCode(currency)) {
    errors.price_cents = "servers.billing.errors.pricePair";
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

/** `/api/v1/servers` 的 POST / PATCH 里的费用字段。 */
export interface BillingPayload {
  paid_until: string | null;
  price_cents: number | null;
  currency: string | null;
  /** 旧派生字段，保留兼容；由数量 + 单位推导。 */
  billing_cycle: BillingCycle | null;
  billing_cycle_count: number | null;
  billing_cycle_unit: BillingCycleUnit | null;
}

/** 表单里的周期 → 新契约（数量 + 单位）与旧派生字段。 */
export function billingCyclePayload(
  form: Pick<ServerBillingForm, "cycleCount" | "cycleUnit">,
): Pick<
  BillingPayload,
  "billing_cycle" | "billing_cycle_count" | "billing_cycle_unit"
> {
  const unitRaw = form.cycleUnit.trim();
  const unit = isBillingCycleUnit(unitRaw) ? unitRaw : null;
  const count = parseCycleCount(form.cycleCount);

  const empty = {
    billing_cycle: null,
    billing_cycle_count: null,
    billing_cycle_unit: null,
  } as const;
  if (unit === null || !count.ok) return { ...empty };

  // 一次性：数量没有意义，固定发 1（后端也要求 1..=1200 或 null）。
  if (unit === "once") {
    return {
      billing_cycle: "once",
      billing_cycle_count: 1,
      billing_cycle_unit: "once",
    };
  }
  if (count.count === null) return { ...empty };

  return {
    // 旧派生字段只承载「一个周期」：1 month → monthly、1 year → yearly；
    // 3 个月 / 2 年这类新周期不能谎报成 monthly / yearly（公开页文档 0067）。
    billing_cycle: count.count === 1 ? billingCycleFor(unit) : null,
    billing_cycle_count: count.count,
    billing_cycle_unit: unit,
  };
}

/**
 * 表单 → 提交载荷。空 = `null`（显式清空），不是省略。
 *
 * PATCH 的三态语义是「缺省沿用 / null 清空 / 值覆盖」；编辑弹窗每次都把
 * 费用字段一起发出去，所以留空必须发 null，否则用户永远清不掉旧值。
 * 计费周期同时发新契约的两个字段与旧派生的 `billing_cycle`，旧后端忽略
 * 不认识的字段、新后端以数量 + 单位为准。
 * 调用方应先跑 `validateBillingForm`；非法值在这里一律按 null 处理，
 * 绝不把脏数据提交给后端。
 */
export function billingPayload(form: ServerBillingForm): BillingPayload {
  const paidUntil = form.paidUntil.trim();
  const price = parsePriceYuan(form.price);
  const currency = form.currency.trim().toUpperCase();

  let priceCents = price.ok ? price.cents : null;
  let currencyCode = isCurrencyCode(currency) ? currency : null;
  // 后端要求价格与币种成对：只落单一个就整对清空（「要么都清，要么都不清」），
  // 绝不提交半对字段换来 400。正常情况下 validateBillingForm 已经拦住。
  if ((priceCents === null) !== (currencyCode === null)) {
    priceCents = null;
    currencyCode = null;
  }

  return {
    paid_until: isPaidUntilInRange(paidUntil) ? paidUntil : null,
    price_cents: priceCents,
    currency: currencyCode,
    ...billingCyclePayload(form),
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
    case "server.billing_cycle_count_invalid":
      return "billing_cycle_count";
    case "server.billing_cycle_unit_invalid":
      return "billing_cycle_unit";
    case "server.billing_cycle_once_count_invalid":
      // 一次性只允许数量 1：错误落在数量输入上。
      return "billing_cycle_count";
    case "server.billing_cycle_invalid":
      // 旧后端的合并错误码：现在对应单位下拉。
      return "billing_cycle_unit";
    case "server.billing_cycle_pair_incomplete": {
      // 新后端的「缺一半」：有 params.missing 就落到缺的那一格。
      const missing = error.params?.missing;
      if (missing === "billing_cycle_count" || missing === "count") {
        return "billing_cycle_count";
      }
      if (missing === "billing_cycle_unit" || missing === "unit") {
        return "billing_cycle_unit";
      }
      return "billing_cycle_unit";
    }
    case "server.billing_pair_incomplete": {
      // 后端用 params.missing 指明缺的那一半；缺币种就落到币种，缺价格就落到价格。
      const missing = error.params?.missing;
      if (missing === "currency") return "currency";
      if (missing === "price_cents") return "price_cents";
      return "currency";
    }
    default:
      break;
  }

  // 旧后端可能只有 params.field：能对上就落到字段，对不上走通用错误。
  const field = error.params?.field;
  if (field === "billing_cycle") return "billing_cycle_unit";
  return field === "paid_until" ||
    field === "price_cents" ||
    field === "currency" ||
    field === "billing_cycle_count" ||
    field === "billing_cycle_unit"
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
