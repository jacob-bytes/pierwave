/**
 * 「成本开销」视图的纯逻辑：范围过滤、汇率归一化、总开销 / 本年度 / 未来 12 个月。
 *
 * 所有者定义的口径：
 * - 只统计 **在线** 且费用信息完整（price + currency + cycle count/unit）的服务器；
 *   离线、未填费用、未知币种都不进入总额；未知币种单列提示；
 * - 总开销 = 每台一个计费周期的价格（CNY）之和，一次性也计入；
 * - 本年度总开销 = 周期价格 / 周期月数 × 本年度剩余月数（当前月视为已付/已过）；
 *   一次性没有可信月数，不计入本年度；
 * - 未来 12 个月 = 按 `paid_until` 排期，已预付不重复；一次性按到期日计入；
 * - 排序 / Top 5 / 币种构成都用「一个周期的 CNY 价格」。
 *
 * 所有金额内部用 **CNY 分**：先把单台一个周期的价格折算成 CNY 分并四舍五入，
 * 再做加减；展示时再除以 100。
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

/** 进入成本统计范围的一台服务器（在线 + 费用完整 + 汇率可换算）。 */
export interface CostScopeRow {
  serverId: string;
  name: string;
  currency: string;
  rate: number;
  kind: "periodic" | "once";
  /** 一次性为 null。 */
  cycleMonths: number | null;
  /** 一个周期的原币价格（分）。 */
  cycleOriginalCents: number;
  /** 一个周期的价格折算 CNY（分）。 */
  cycleCnyCents: number;
  /** 本年度折算（分）；一次性恒为 0。 */
  currentYearCnyCents: number;
  paidUntil: string | null;
}

export interface CostOneTimeRow {
  serverId: string;
  name: string;
  currency: string;
  amountCents: number;
  amountCnyCents: number;
  paidUntil: string | null;
  /** 到期月份序号；没有 paid_until 时按当前月。 */
  dueMonth: number | null;
  /** 是否落在未来 12 个月窗口内并计入 next12。 */
  inNext12: boolean;
}

export interface CostUnknownCurrencyRow {
  serverId: string;
  name: string;
  currency: string;
  amountCents: number;
  cycle: CostCycle;
}

export type CostExcludedReason =
  | "offline"
  | "no_billing"
  | "missing_price"
  | "missing_currency"
  | "no_cycle";

export interface CostExcludedRow {
  serverId: string;
  name: string;
  reason: CostExcludedReason;
}

export interface CostCalendarCell {
  monthIndex: number;
  /** 0 = 该月没有付款。 */
  amountCnyCents: number;
  /** 已预付覆盖、不重复计费（仅周期性计费）。 */
  prepaid: boolean;
}

export interface CostCalendarRow {
  serverId: string;
  name: string;
  currency: string;
  kind: "periodic" | "once";
  /** 与 `CostOverview.months` 等长、按月份升序。 */
  cells: CostCalendarCell[];
}

export interface CostCalendarGroup {
  currency: string;
  count: number;
  cycleCnyCents: number;
  rows: CostCalendarRow[];
}

export interface CostTopRow {
  serverId: string;
  name: string;
  currency: string;
  kind: "periodic" | "once";
  cycleCnyCents: number;
  /** 占「一个周期总额」的百分比（0–100）。 */
  share: number;
}

export interface CostCurrencyMixRow {
  currency: string;
  count: number;
  cycleOriginalCents: number;
  cycleCnyCents: number;
  share: number;
}

export interface CostOverview {
  months: number[];
  /** 1–12（UTC+8）。 */
  currentMonth: number;
  /** 12 − 当前月；12 月为 0。 */
  remainingMonths: number;
  /** 在线 + 费用完整 + 汇率可换算的服务器，一个周期价格之和（含一次性）。 */
  totalCnyCents: number;
  /** 本年度剩余月份折算之和；不含一次性。 */
  currentYearCnyCents: number;
  /** 未来 12 个月排期之和；含一次性到期日。 */
  next12CnyCents: number;
  scope: CostScopeRow[];
  scopeCount: number;
  top: CostTopRow[];
  currencyMix: CostCurrencyMixRow[];
  calendarRows: CostCalendarRow[];
  calendarGroups: CostCalendarGroup[];
  oneTime: CostOneTimeRow[];
  unknownCurrency: CostUnknownCurrencyRow[];
  excluded: CostExcludedRow[];
  /** 有可展示的计费数据（含未知币种提示）；只有离线/未填费用时为 false。 */
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
 * 后端实际形状是 `{base, rates:{USD...}, fetched_at, source}` 的 JSON 字符串；
 * 兼容直接给 `{USD:7.2}` 的旧形态。非法键 / 非正汇率一律忽略；CNY 始终为 1。
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
    if (isRecord(value.rates)) {
      source =
        typeof value.source === "string" && value.source.trim()
          ? value.source.trim()
          : null;
      fetchedAt = parseFxUpdatedAt(value.fetched_at ?? value.fetchedAt);
      for (const [key, rateValue] of Object.entries(value.rates)) {
        add(key, rateValue);
      }
    } else {
      for (const [key, rateValue] of Object.entries(value)) {
        add(key, rateValue);
      }
    }
  }

  rates.CNY = 1;
  return { rates, provided, source, fetchedAt };
}

/** `fx_rates_updated_at` / `fetched_at`：Unix 秒 / 毫秒 / 数字字符串 / ISO。 */
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

/**
 * 完整费用信息 → 周期。按所有者口径，**必须**同时有合法的
 * `billing_cycle_count` 与 `billing_cycle_unit`；只有旧 `billing_cycle`
 * 视为「未填完整」，不进入成本统计。
 */
export function costCycleOf(server: Partial<Server>): CostCycle | null {
  const unit = server.billing_cycle_unit;
  const count = server.billing_cycle_count;
  if (
    unit !== "month" &&
    unit !== "year" &&
    unit !== "once"
  ) {
    return null;
  }
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1200
  ) {
    return null;
  }
  if (unit === "once") return { kind: "once" };
  return {
    kind: "months",
    months: unit === "year" ? count * 12 : count,
  };
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

/** CNY 分 → `¥1,810.75`（英文环境也使用窄符号 ¥）。 */
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
  scope: readonly CostScopeRow[],
  totalCnyCents: number,
): CostCurrencyMixRow[] {
  const groups = new Map<
    string,
    Omit<CostCurrencyMixRow, "share">
  >();
  for (const row of scope) {
    const existing = groups.get(row.currency);
    if (existing) {
      existing.count += 1;
      existing.cycleOriginalCents += row.cycleOriginalCents;
      existing.cycleCnyCents += row.cycleCnyCents;
    } else {
      groups.set(row.currency, {
        currency: row.currency,
        count: 1,
        cycleOriginalCents: row.cycleOriginalCents,
        cycleCnyCents: row.cycleCnyCents,
      });
    }
  }
  return [...groups.values()]
    .map((row) => ({
      ...row,
      share:
        totalCnyCents > 0 ? (row.cycleCnyCents / totalCnyCents) * 100 : 0,
    }))
    .sort(
      (a, b) =>
        b.cycleCnyCents - a.cycleCnyCents ||
        a.currency.localeCompare(b.currency),
    );
}

/**
 * 主入口：服务器列表 + 汇率 + 当前时间 → 成本视图。
 *
 * `now` 用 Unix 秒；测试固定它就能断言 8 月剩余 4 个月、12 月为 0。
 */
export function buildCostOverview(
  servers: readonly Partial<Server>[],
  rates: Readonly<Record<string, number>>,
  now = Date.now() / 1000,
): CostOverview {
  const todayMonth = monthIndexOf(now);
  const currentMonth = monthIndexParts(todayMonth).month + 1;
  const remainingMonths = 12 - currentMonth;
  const months = Array.from({ length: 12 }, (_, index) => todayMonth + index);
  const endMonth = months[months.length - 1] ?? todayMonth;

  const scope: CostScopeRow[] = [];
  const unknownCurrency: CostUnknownCurrencyRow[] = [];
  const excluded: CostExcludedRow[] = [];

  for (const server of servers) {
    if (!server || typeof server.id !== "string" || !server.id.trim()) {
      continue;
    }
    const serverId = server.id;
    const name =
      typeof server.name === "string" && server.name.trim()
        ? server.name.trim()
        : serverId;

    // 范围 1：当前在线。到期但仍在线的也保留（视为忘了续期）。
    if (server.status !== "online") {
      excluded.push({ serverId, name, reason: "offline" });
      continue;
    }

    const hasBilling = hasAnyBillingField(server);
    const price = normalizeCents(server.price_cents);
    const currency = normalizeCurrency(server.currency);
    const cycle = costCycleOf(server);

    if (!hasBilling) {
      excluded.push({ serverId, name, reason: "no_billing" });
      continue;
    }
    if (price === null) {
      excluded.push({ serverId, name, reason: "missing_price" });
      continue;
    }
    if (currency === null) {
      excluded.push({ serverId, name, reason: "missing_currency" });
      continue;
    }
    if (cycle === null) {
      excluded.push({ serverId, name, reason: "no_cycle" });
      continue;
    }

    const rate = currency === "CNY" ? 1 : rates[currency];
    if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
      // 范围 2：未知币种换算不了；不进总额，但单列提示。
      unknownCurrency.push({
        serverId,
        name,
        currency,
        amountCents: price,
        cycle,
      });
      continue;
    }

    const cycleCnyCents = Math.round(price * rate);
    const currentYearCnyCents =
      cycle.kind === "once"
        ? 0
        : Math.round((cycleCnyCents / cycle.months) * remainingMonths);
    const paidUntil =
      typeof server.paid_until === "string" && server.paid_until.trim()
        ? server.paid_until.trim()
        : null;

    scope.push({
      serverId,
      name,
      currency,
      rate,
      kind: cycle.kind === "once" ? "once" : "periodic",
      cycleMonths: cycle.kind === "once" ? null : cycle.months,
      cycleOriginalCents: price,
      cycleCnyCents,
      currentYearCnyCents,
      paidUntil,
    });
  }

  const totalCnyCents = scope.reduce(
    (sum, row) => sum + row.cycleCnyCents,
    0,
  );
  const currentYearCnyCents = scope.reduce(
    (sum, row) => sum + row.currentYearCnyCents,
    0,
  );

  let next12CnyCents = 0;
  const calendarRows: CostCalendarRow[] = [];

  for (const row of scope) {
    const paidMonth = monthIndexOfDate(row.paidUntil);
    const cells = new Map<number, CostCalendarCell>();

    if (row.kind === "periodic" && row.cycleMonths !== null) {
      const startMonth =
        paidMonth === null ? todayMonth : Math.max(todayMonth, paidMonth);
      const prepaid = new Set<number>();
      for (let month = todayMonth; month < startMonth; month += 1) {
        if (month >= todayMonth && month <= endMonth) prepaid.add(month);
      }
      for (
        let month = startMonth;
        month <= endMonth;
        month += row.cycleMonths
      ) {
        const cell = {
          monthIndex: month,
          amountCnyCents: row.cycleCnyCents,
          prepaid: false,
        };
        cells.set(month, cell);
        next12CnyCents += row.cycleCnyCents;
      }
      for (const month of prepaid) {
        cells.set(month, {
          monthIndex: month,
          amountCnyCents: 0,
          prepaid: true,
        });
      }
      calendarRows.push({
        serverId: row.serverId,
        name: row.name,
        currency: row.currency,
        kind: row.kind,
        cells: months.map(
          (monthIndex) =>
            cells.get(monthIndex) ?? {
              monthIndex,
              amountCnyCents: 0,
              prepaid: false,
            },
        ),
      });
    } else {
      // 一次性：按到期日一次性计入；没有 paid_until 视为当前月到期。
      // 已经过期的单次费用视为已付，不进未来 12 个月。
      const dueMonth = paidMonth ?? todayMonth;
      if (dueMonth < todayMonth || dueMonth > endMonth) continue;
      const cell = {
        monthIndex: dueMonth,
        amountCnyCents: row.cycleCnyCents,
        prepaid: false,
      };
      cells.set(dueMonth, cell);
      next12CnyCents += row.cycleCnyCents;
      calendarRows.push({
        serverId: row.serverId,
        name: row.name,
        currency: row.currency,
        kind: row.kind,
        cells: months.map(
          (monthIndex) =>
            cells.get(monthIndex) ?? {
              monthIndex,
              amountCnyCents: 0,
              prepaid: false,
            },
        ),
      });
    }
  }

  const mix = currencyMix(scope, totalCnyCents);
  const top = [...scope]
    .sort(
      (a, b) =>
        b.cycleCnyCents - a.cycleCnyCents ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 5)
    .map<CostTopRow>((row) => ({
      serverId: row.serverId,
      name: row.name,
      currency: row.currency,
      kind: row.kind,
      cycleCnyCents: row.cycleCnyCents,
      share: totalCnyCents > 0 ? (row.cycleCnyCents / totalCnyCents) * 100 : 0,
    }));

  const groupOrder = new Map(
    mix.map((row, index) => [row.currency, index] as const),
  );
  const scopeById = new Map(scope.map((row) => [row.serverId, row] as const));
  const calendarGroups: CostCalendarGroup[] = mix
    .map((row) => {
      const rows = calendarRows
        .filter((calendarRow) => calendarRow.currency === row.currency)
        .sort((a, b) => {
          const aRow = scopeById.get(a.serverId);
          const bRow = scopeById.get(b.serverId);
          return (
            (bRow?.cycleCnyCents ?? 0) - (aRow?.cycleCnyCents ?? 0) ||
            a.name.localeCompare(b.name)
          );
        });
      return {
        currency: row.currency,
        count: rows.length,
        cycleCnyCents: rows.reduce(
          (sum, calendarRow) =>
            sum + (scopeById.get(calendarRow.serverId)?.cycleCnyCents ?? 0),
          0,
        ),
        rows,
      };
    })
    .sort(
      (a, b) =>
        (groupOrder.get(a.currency) ?? 0) -
          (groupOrder.get(b.currency) ?? 0) ||
        a.currency.localeCompare(b.currency),
    )
    .filter((group) => group.rows.length > 0);

  const oneTime: CostOneTimeRow[] = scope
    .filter((row) => row.kind === "once")
    .map((row) => {
      const paidMonth = monthIndexOfDate(row.paidUntil);
      const dueMonth = paidMonth ?? todayMonth;
      return {
        serverId: row.serverId,
        name: row.name,
        currency: row.currency,
        amountCents: row.cycleOriginalCents,
        amountCnyCents: row.cycleCnyCents,
        paidUntil: row.paidUntil,
        dueMonth,
        inNext12:
          dueMonth >= todayMonth &&
          dueMonth <= endMonth,
      };
    })
    .sort(
      (a, b) =>
        b.amountCnyCents - a.amountCnyCents ||
        a.name.localeCompare(b.name),
    );

  return {
    months,
    currentMonth,
    remainingMonths,
    totalCnyCents,
    currentYearCnyCents,
    next12CnyCents,
    scope,
    scopeCount: scope.length,
    top,
    currencyMix: mix,
    calendarRows,
    calendarGroups,
    oneTime,
    unknownCurrency: unknownCurrency.sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
    excluded,
    hasData: scope.length > 0 || unknownCurrency.length > 0,
  };
}
