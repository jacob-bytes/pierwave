/**
 * 「成本开销」视图的纯逻辑：汇率归一化、月度/年化/未来 12 个月、付款日历、
 * Top 5 与币种构成。
 *
 * 计算口径（与设计稿一致）：
 * - `monthly_cny = price_cents / cycle_months * rate`，先按单台四舍五入到「分」，
 *   再求和，避免先加总再取整产生漂移；
 * - 所有金额内部都用 **CNY 分**，展示时再除以 100；
 * - 一次性费用 **不计入** 月均 / 年化 / 未来 12 个月，单列；
 * - 未知币种（不在 `fx_rates` 里）**不计入总额**，单列台数与币种；
 * - 没有计费周期的服务器无法年化，同样不计入，并单独计数；
 * - 未来 12 个月按 `paid_until` 起排期：`paid_until` 之前的月份标「已预付」，
 *   当期金额是**该周期的全额**（年付就是年付全额），不是月均。
 *
 * 不依赖 React / DOM / i18n。
 */

import type { Server } from "./api.ts";

export interface FxRates {
  /** 币种 → CNY/单位；CNY 恒为 1。 */
  rates: Record<string, number>;
  /** 后端是否真的提供了 `fx_rates`（空对象按未提供处理）。 */
  provided: boolean;
  /** `manual` = 管理员手动覆盖；其它字符串（或 null）= 自动抓取。 */
  source: string | null;
  /** JSON 里的 `fetched_at`；顶层 `fx_rates_updated_at` 缺失时兜底。 */
  fetchedAt: number | null;
}

export interface CostCycleMonths {
  kind: "months";
  months: number;
}

export interface CostCycleOnce {
  kind: "once";
}

export type CostCycle = CostCycleMonths | CostCycleOnce;

export interface CostPeriodicServer {
  serverId: string;
  name: string;
  currency: string;
  rate: number;
  cycleMonths: number;
  /** 原币月均（分，已四舍五入）。 */
  monthlyOriginalCents: number;
  /** 折算 CNY 月均（分）。 */
  monthlyCnyCents: number;
  /** 该周期全额折算 CNY（分），用于付款日历。 */
  cycleCnyCents: number;
  paidUntil: string | null;
}

export interface CostOneTimeRow {
  serverId: string;
  name: string;
  currency: string;
  amountCents: number;
  /** 未知币种时为 null：原币金额保留，但不进入任何 CNY 汇总。 */
  amountCnyCents: number | null;
  paidUntil: string | null;
}

export interface CostUnknownCurrencyRow {
  serverId: string;
  name: string;
  currency: string;
  amountCents: number;
  cycle: CostCycle;
}

export type CostIncompleteReason =
  | "missing_price"
  | "missing_currency"
  | "no_cycle";

export interface CostIncompleteRow {
  serverId: string;
  name: string;
  reason: CostIncompleteReason;
}

export interface CostCalendarCell {
  monthIndex: number;
  /** 0 = 该月没有付款。 */
  amountCnyCents: number;
  /** 已预付覆盖、不重复计费。 */
  prepaid: boolean;
}

export interface CostCalendarRow {
  serverId: string;
  name: string;
  currency: string;
  /** 与 `CostOverview.months` 等长、按月份升序。 */
  cells: CostCalendarCell[];
}

export interface CostCalendarGroup {
  currency: string;
  count: number;
  monthlyCnyCents: number;
  rows: CostCalendarRow[];
}

export interface CostTopRow {
  serverId: string;
  name: string;
  currency: string;
  monthlyCnyCents: number;
  /** 占周期性月均总额的百分比（0–100）。 */
  share: number;
}

export interface CostCurrencyMixRow {
  currency: string;
  count: number;
  monthlyOriginalCents: number;
  monthlyCnyCents: number;
  share: number;
}

export interface CostOverview {
  months: number[];
  monthlyCnyCents: number;
  annualizedCnyCents: number;
  next12CnyCents: number;
  /** 年化 - 未来 12 个月；负数按 0 处理。 */
  prepaidSavingsCents: number;
  periodicCount: number;
  periodic: CostPeriodicServer[];
  top: CostTopRow[];
  currencyMix: CostCurrencyMixRow[];
  calendarRows: CostCalendarRow[];
  calendarGroups: CostCalendarGroup[];
  oneTime: CostOneTimeRow[];
  unknownCurrency: CostUnknownCurrencyRow[];
  incomplete: CostIncompleteRow[];
  /** 是否有任何可展示的计费数据；只有「未配置完整」时为 false。 */
  hasData: boolean;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC8_OFFSET_SECONDS = 8 * 60 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return CURRENCY_PATTERN.test(code) ? code : null;
}

/** 去掉金额上的小数；负数按无效处理。 */
function normalizeCents(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number < 0) return null;
  return Math.round(number);
}

/**
 * 汇率归一化：接受对象、JSON 字符串，以及 `[{currency, rate}]` 数组。
 * 非法键 / 非正汇率一律忽略；CNY 始终为 1。
 */
export function parseFxRates(raw: unknown): FxRates {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return {
        rates: { CNY: 1 },
        provided: false,
        source: null,
        fetchedAt: null,
      };
    }
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return {
        rates: { CNY: 1 },
        provided: false,
        source: null,
        fetchedAt: null,
      };
    }
  }

  const rates: Record<string, number> = {};
  let provided = false;
  let source: string | null = null;
  let fetchedAt: number | null = null;

  const add = (key: unknown, rateValue: unknown) => {
    const code = normalizeCurrency(key);
    const rate = finiteNumber(rateValue);
    if (!code || rate === null || rate <= 0) return;
    rates[code] = rate;
    provided = true;
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      add(
        item.currency ?? item.code ?? item.id,
        item.rate ?? item.value,
      );
    }
  } else if (isRecord(value)) {
    // 后端实际形状：{base, rates:{USD...}, fetched_at, source}
    if (isRecord(value.rates)) {
      source =
        typeof value.source === "string" && value.source.trim()
          ? value.source.trim()
          : null;
      fetchedAt = parseFxUpdatedAt(
        value.fetched_at ?? value.fetchedAt,
      );
      for (const [key, rateValue] of Object.entries(value.rates)) {
        add(key, rateValue);
      }
    } else {
      // 兼容直接给对象 / 数组的旧形态。
      for (const [key, rateValue] of Object.entries(value)) {
        add(key, rateValue);
      }
    }
  }

  rates.CNY = 1;
  return { rates, provided, source, fetchedAt };
}

/** `fx_rates_updated_at`：Unix 秒 / 毫秒 / 数字字符串 / ISO 日期。 */
export function parseFxUpdatedAt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const number = Number(trimmed);
      return number > 1e12 ? Math.floor(number / 1000) : Math.floor(number);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed / 1000);
    }
  }
  return null;
}

/** 新契约（数量 + 单位）优先，旧 `billing_cycle` 回落；一次性固定 `once`。 */
export function costCycleOf(server: Partial<Server>): CostCycle | null {
  const unit = server.billing_cycle_unit;
  const count = server.billing_cycle_count;

  if (unit === "once") return { kind: "once" };
  if (unit === "month" || unit === "year") {
    const amount =
      typeof count === "number" && Number.isInteger(count) && count >= 1
        ? count
        : null;
    if (amount !== null) {
      return {
        kind: "months",
        months: unit === "year" ? amount * 12 : amount,
      };
    }
  }

  switch (server.billing_cycle) {
    case "monthly":
      return { kind: "months", months: 1 };
    case "yearly":
      return { kind: "months", months: 12 };
    case "once":
      return { kind: "once" };
    default:
      return null;
  }
}

function hasAnyBillingField(server: Partial<Server>): boolean {
  return [
    server.price_cents,
    server.currency,
    server.billing_cycle,
    server.billing_cycle_count,
    server.billing_cycle_unit,
    server.paid_until,
  ].some((value) => value !== null && value !== undefined);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Unix 秒 → UTC+8 的月份序号（year * 12 + month0）。 */
export function monthIndexOf(unixSeconds: number): number {
  const date = new Date((unixSeconds + UTC8_OFFSET_SECONDS) * 1000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/** `YYYY-MM-DD` → 月份序号；格式非法返回 null。 */
export function monthIndexOfDate(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = ISO_DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  return year * 12 + (month - 1);
}

export function monthIndexParts(monthIndex: number): {
  year: number;
  /** 0–11。 */
  month: number;
} {
  return {
    year: Math.floor(monthIndex / 12),
    month: ((monthIndex % 12) + 12) % 12,
  };
}

/** `2026-11`，用于付款日历 tooltip。 */
export function formatMonthIndex(monthIndex: number): string {
  const parts = monthIndexParts(monthIndex);
  return `${parts.year}-${pad(parts.month + 1)}`;
}

/** `11月` / `Nov`；按当前语言取短月份。 */
export function formatMonthLabel(
  monthIndex: number,
  locale = "zh-CN",
): string {
  const parts = monthIndexParts(monthIndex);
  const date = new Date(Date.UTC(parts.year, parts.month, 1));
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

function safeNumberFormat(
  locale: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(locale, options);
  } catch {
    return new Intl.NumberFormat("zh-CN", options);
  }
}

/** CNY 分 → `¥1,810.75`（英文环境会得到 `CN¥…`，仍是 CNY）。 */
export function formatCny(cents: number, locale = "zh-CN"): string {
  return safeNumberFormat(locale, {
    style: "currency",
    currency: "CNY",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** 原币金额；未知币种代码也能安全展示。 */
export function formatCurrency(
  cents: number,
  currency: string,
  locale = "zh-CN",
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

/** 付款日历格子里的紧凑金额：整数不带小数，保持 12 列不换行。 */
export function formatCnyCompact(cents: number, locale = "zh-CN"): string {
  return safeNumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** 汇率展示：最多 4 位小数，去掉无意义的尾零。 */
export function formatFxRate(rate: number, locale = "zh-CN"): string {
  return safeNumberFormat(locale, {
    maximumFractionDigits: 4,
  }).format(rate);
}

function currencyMix(
  periodic: readonly CostPeriodicServer[],
  totalMonthly: number,
): CostCurrencyMixRow[] {
  const groups = new Map<
    string,
    Omit<CostCurrencyMixRow, "share">
  >();
  for (const row of periodic) {
    const existing = groups.get(row.currency);
    if (existing) {
      existing.count += 1;
      existing.monthlyOriginalCents += row.monthlyOriginalCents;
      existing.monthlyCnyCents += row.monthlyCnyCents;
    } else {
      groups.set(row.currency, {
        currency: row.currency,
        count: 1,
        monthlyOriginalCents: row.monthlyOriginalCents,
        monthlyCnyCents: row.monthlyCnyCents,
      });
    }
  }
  return [...groups.values()]
    .map((row) => ({
      ...row,
      share: totalMonthly > 0 ? (row.monthlyCnyCents / totalMonthly) * 100 : 0,
    }))
    .sort(
      (a, b) =>
        b.monthlyCnyCents - a.monthlyCnyCents ||
        a.currency.localeCompare(b.currency),
    );
}

/**
 * 主入口：把服务器列表 + 汇率 + 当前时间算成完整成本视图。
 *
 * `now` 用 Unix 秒；测试固定它就能断言「未来 12 个月」的排期。
 */
export function buildCostOverview(
  servers: readonly Partial<Server>[],
  rates: Readonly<Record<string, number>>,
  now = Date.now() / 1000,
): CostOverview {
  const periodic: CostPeriodicServer[] = [];
  const oneTime: CostOneTimeRow[] = [];
  const unknownCurrency: CostUnknownCurrencyRow[] = [];
  const incomplete: CostIncompleteRow[] = [];

  for (const server of servers) {
    if (!server || typeof server.id !== "string" || !server.id.trim()) {
      continue;
    }
    if (!hasAnyBillingField(server)) continue;

    const serverId = server.id;
    const name =
      typeof server.name === "string" && server.name.trim()
        ? server.name.trim()
        : serverId;
    const price = normalizeCents(server.price_cents);
    const currency = normalizeCurrency(server.currency);
    const cycle = costCycleOf(server);
    const paidUntil =
      typeof server.paid_until === "string" && server.paid_until.trim()
        ? server.paid_until.trim()
        : null;

    if (price === null) {
      incomplete.push({ serverId, name, reason: "missing_price" });
      continue;
    }
    if (currency === null) {
      incomplete.push({ serverId, name, reason: "missing_currency" });
      continue;
    }
    if (cycle === null) {
      incomplete.push({ serverId, name, reason: "no_cycle" });
      continue;
    }

    const rate = currency === "CNY" ? 1 : rates[currency];
    if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
      unknownCurrency.push({
        serverId,
        name,
        currency,
        amountCents: price,
        cycle,
      });
      continue;
    }

    if (cycle.kind === "once") {
      oneTime.push({
        serverId,
        name,
        currency,
        amountCents: price,
        amountCnyCents: Math.round(price * rate),
        paidUntil,
      });
      continue;
    }

    periodic.push({
      serverId,
      name,
      currency,
      rate,
      cycleMonths: cycle.months,
      monthlyOriginalCents: Math.round(price / cycle.months),
      monthlyCnyCents: Math.round((price / cycle.months) * rate),
      cycleCnyCents: Math.round(price * rate),
      paidUntil,
    });
  }

  const monthlyCnyCents = periodic.reduce(
    (sum, row) => sum + row.monthlyCnyCents,
    0,
  );
  const annualizedCnyCents = monthlyCnyCents * 12;
  const todayMonth = monthIndexOf(now);
  const months = Array.from({ length: 12 }, (_, index) => todayMonth + index);
  const endMonth = months[months.length - 1] ?? todayMonth;

  let next12CnyCents = 0;
  const calendarRows = periodic.map<CostCalendarRow>((row) => {
    const paidMonth = monthIndexOfDate(row.paidUntil);
    const startMonth =
      paidMonth === null ? todayMonth : Math.max(todayMonth, paidMonth);
    const payments = new Map<number, number>();
    for (
      let month = startMonth;
      month <= endMonth;
      month += row.cycleMonths
    ) {
      payments.set(month, row.cycleCnyCents);
    }
    const prepaid = new Set<number>();
    for (let month = todayMonth; month < startMonth; month += 1) {
      if (month >= todayMonth && month <= endMonth) prepaid.add(month);
    }

    const cells = months.map<CostCalendarCell>((monthIndex) => {
      const amount = payments.get(monthIndex) ?? 0;
      return {
        monthIndex,
        amountCnyCents: amount,
        prepaid: amount === 0 && prepaid.has(monthIndex),
      };
    });
    next12CnyCents += [...payments.values()].reduce(
      (sum, amount) => sum + amount,
      0,
    );

    return {
      serverId: row.serverId,
      name: row.name,
      currency: row.currency,
      cells,
    };
  });

  const mix = currencyMix(periodic, monthlyCnyCents);
  const top = [...periodic]
    .sort(
      (a, b) =>
        b.monthlyCnyCents - a.monthlyCnyCents ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 5)
    .map<CostTopRow>((row) => ({
      serverId: row.serverId,
      name: row.name,
      currency: row.currency,
      monthlyCnyCents: row.monthlyCnyCents,
      share: monthlyCnyCents > 0 ? (row.monthlyCnyCents / monthlyCnyCents) * 100 : 0,
    }));

  const groupOrder = new Map(
    mix.map((row, index) => [row.currency, index] as const),
  );
  const calendarGroups: CostCalendarGroup[] = mix
    .map((row) => ({
      currency: row.currency,
      count: row.count,
      monthlyCnyCents: row.monthlyCnyCents,
      rows: calendarRows
        .filter((calendarRow) => calendarRow.currency === row.currency)
        .sort(
          (a, b) =>
            (periodic.find((item) => item.serverId === b.serverId)
              ?.monthlyCnyCents ?? 0) -
              (periodic.find((item) => item.serverId === a.serverId)
                ?.monthlyCnyCents ?? 0) ||
            a.name.localeCompare(b.name),
        ),
    }))
    .sort(
      (a, b) =>
        (groupOrder.get(a.currency) ?? 0) -
          (groupOrder.get(b.currency) ?? 0) || a.currency.localeCompare(b.currency),
    )
    .filter((group) => group.rows.length > 0);

  return {
    months,
    monthlyCnyCents,
    annualizedCnyCents,
    next12CnyCents,
    prepaidSavingsCents: Math.max(0, annualizedCnyCents - next12CnyCents),
    periodicCount: periodic.length,
    periodic,
    top,
    currencyMix: mix,
    calendarRows,
    calendarGroups,
    oneTime: oneTime.sort(
      (a, b) =>
        (b.amountCnyCents ?? -1) - (a.amountCnyCents ?? -1) ||
        a.name.localeCompare(b.name),
    ),
    unknownCurrency: unknownCurrency.sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
    incomplete,
    hasData:
      periodic.length > 0 ||
      oneTime.length > 0 ||
      unknownCurrency.length > 0,
  };
}
