import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCostOverview,
  buildFxDetails,
  costCycleOf,
  formatCnyCompact,
  formatFxRateDisplay,
  formatMonthIndex,
  formatMonthLabel,
  monthIndexOfDate,
  parseFxRates,
  parseFxUpdatedAt,
} from "./costOverview.ts";

const AUG = Date.UTC(2026, 7, 15, 4, 0, 0) / 1000; // 2026-08-15 12:00 UTC+8
const DEC = Date.UTC(2026, 11, 15, 4, 0, 0) / 1000;
const JAN = Date.UTC(2027, 0, 15, 4, 0, 0) / 1000;

const RATES = parseFxRates({ USD: 7.2, EUR: 7.8, JPY: 0.048 });

function server(id, overrides = {}) {
  return {
    id,
    name: `server-${id}`,
    status: "online",
    ...overrides,
  };
}

function billed(id, overrides = {}) {
  return server(id, {
    price_cents: 10000,
    currency: "CNY",
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    ...overrides,
  });
}

test("parseFxRates: 对象 / JSON 字符串 / 数组都归一化，CNY 恒为 1", () => {
  const fromObject = parseFxRates({ USD: 7.2, EUR: "7.8", BAD: 0, XX: "x" });
  assert.deepEqual(fromObject.rates, { USD: 7.2, EUR: 7.8, CNY: 1 });
  assert.equal(fromObject.provided, true);

  const fromString = parseFxRates('{"USD":"7.2","JPY":0.048}');
  assert.deepEqual(fromString.rates, { USD: 7.2, JPY: 0.048, CNY: 1 });

  const stored = parseFxRates(
    '{"base":"CNY","rates":{"USD":7.2,"EUR":7.8,"JPY":0.048},"fetched_at":1763700000,"source":"open.er-api.com"}',
  );
  assert.deepEqual(stored.rates, {
    USD: 7.2,
    EUR: 7.8,
    JPY: 0.048,
    CNY: 1,
  });
  assert.equal(stored.provided, true);
  assert.equal(stored.source, "open.er-api.com");
  assert.equal(stored.fetchedAt, 1763700000);

  const manual = parseFxRates(
    '{"base":"CNY","rates":{"USD":7.2},"fetched_at":1763700000,"source":"manual"}',
  );
  assert.equal(manual.source, "manual");

  const fromArray = parseFxRates([
    { currency: "USD", rate: 7.2 },
    { code: "EUR", rate: 7.8 },
    { code: "BAD", rate: -1 },
  ]);
  assert.deepEqual(fromArray.rates, { USD: 7.2, EUR: 7.8, CNY: 1 });

  assert.deepEqual(parseFxRates(null).rates, { CNY: 1 });
  assert.equal(parseFxRates(null).provided, false);
  assert.equal(parseFxRates({}).provided, false);
  assert.equal(parseFxRates("not json").provided, false);
});

test("parseFxUpdatedAt: 秒 / 毫秒 / ISO 字符串", () => {
  assert.equal(parseFxUpdatedAt(1795318800), 1795318800);
  assert.equal(parseFxUpdatedAt(1795318800000), 1795318800);
  assert.equal(parseFxUpdatedAt("1795318800"), 1795318800);
  assert.equal(
    parseFxUpdatedAt("2026-11-22T04:00:00Z"),
    Date.UTC(2026, 10, 22, 4, 0, 0) / 1000,
  );
  assert.equal(parseFxUpdatedAt("bogus"), null);
  assert.equal(parseFxUpdatedAt(null), null);
});

test("costCycleOf: 只接受完整的 count + unit；旧 billing_cycle 不算完整", () => {
  assert.deepEqual(
    costCycleOf({ billing_cycle_count: 3, billing_cycle_unit: "month" }),
    { kind: "months", months: 3 },
  );
  assert.deepEqual(
    costCycleOf({ billing_cycle_count: 2, billing_cycle_unit: "year" }),
    { kind: "months", months: 24 },
  );
  assert.deepEqual(
    costCycleOf({ billing_cycle_count: 1, billing_cycle_unit: "once" }),
    { kind: "once" },
  );
  assert.equal(costCycleOf({ billing_cycle: "yearly" }), null);
  assert.equal(costCycleOf({ billing_cycle_unit: "month" }), null);
  assert.equal(costCycleOf({ billing_cycle_count: 1 }), null);
  assert.equal(costCycleOf({ billing_cycle_count: 0, billing_cycle_unit: "month" }), null);
});

test("范围过滤：离线 / 未填费用 / 未填完整 / 未知币种都不进总额", () => {
  const overview = buildCostOverview(
    [
      server("online-ok", {
        price_cents: 10000,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "month",
      }),
      server("offline", {
        status: "offline",
        price_cents: 8888,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "month",
      }),
      server("no-fee", { status: "online" }),
      server("no-cycle", {
        price_cents: 50000,
        currency: "CNY",
      }),
      server("unknown", {
        price_cents: 32000,
        currency: "AED",
        billing_cycle_count: 1,
        billing_cycle_unit: "month",
      }),
    ],
    RATES.rates,
    AUG,
  );

  assert.equal(overview.scopeCount, 1);
  assert.equal(overview.totalCnyCents, 10000);
  assert.equal(overview.currentYearCnyCents, 4 * 10000);
  assert.equal(overview.unknownCurrency.length, 1);
  assert.equal(overview.unknownCurrency[0].serverId, "unknown");
  assert.equal(overview.calendarRows.length, 1);
  assert.equal(overview.top.length, 1);
  assert.deepEqual(
    overview.excluded.map((row) => ({ id: row.serverId, reason: row.reason })),
    [
      { id: "offline", reason: "offline" },
      { id: "no-fee", reason: "no_billing" },
      { id: "no-cycle", reason: "no_cycle" },
    ],
  );
});

test("两台不同周期的服务器：总开销 = 一个周期价格之和", () => {
  const overview = buildCostOverview(
    [
      server("monthly", {
        price_cents: 10000,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "month",
      }),
      server("yearly", {
        price_cents: 120000,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "year",
      }),
    ],
    RATES.rates,
    AUG,
  );

  // 月付 ¥100 + 年付 ¥1,200 = ¥1,300（不是月均相加）
  assert.equal(overview.totalCnyCents, 130000);
  // 月付 ¥100 × 剩余 4 个月 + 年付 ¥1,200 / 12 × 4
  assert.equal(overview.currentYearCnyCents, 4 * 10000 + 40000);
  assert.equal(overview.top[0].serverId, "yearly");
  assert.equal(overview.top[0].share, (120000 / 130000) * 100);
});

test("8 月：1 年期 ¥1200 → 本年度 ¥400；剩余月数 4", () => {
  const overview = buildCostOverview(
    [
      server("yearly", {
        price_cents: 120000,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "year",
      }),
    ],
    RATES.rates,
    AUG,
  );

  assert.equal(overview.currentMonth, 8);
  assert.equal(overview.remainingMonths, 4);
  assert.equal(overview.totalCnyCents, 120000);
  assert.equal(overview.currentYearCnyCents, 40000);
});

test("1 月：本年度剩余 11 个月", () => {
  const overview = buildCostOverview(
    [
      server("yearly", {
        price_cents: 120000,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "year",
      }),
    ],
    RATES.rates,
    JAN,
  );
  assert.equal(overview.currentMonth, 1);
  assert.equal(overview.remainingMonths, 11);
  assert.equal(overview.currentYearCnyCents, 110000);
});

test("12 月：本年度为 0，不是 null / 破折号", () => {
  const overview = buildCostOverview(
    [billed("monthly", { price_cents: 10000 })],
    RATES.rates,
    DEC,
  );

  assert.equal(overview.currentMonth, 12);
  assert.equal(overview.remainingMonths, 0);
  assert.equal(overview.currentYearCnyCents, 0);
  assert.equal(overview.totalCnyCents, 10000);
});

test("3 个月周期：价格 / 3 × 剩余月数，不按周期数取整", () => {
  const overview = buildCostOverview(
    [
      server("quarterly", {
        price_cents: 30000,
        currency: "CNY",
        billing_cycle_count: 3,
        billing_cycle_unit: "month",
      }),
    ],
    RATES.rates,
    AUG,
  );

  assert.equal(overview.totalCnyCents, 30000);
  // 300 / 3 * 4 = 400
  assert.equal(overview.currentYearCnyCents, 40000);
});

test("一次性：计入总开销，不计入本年度；到期日在窗口内计入未来 12 个月", () => {
  const overview = buildCostOverview(
    [
      server("once", {
        price_cents: 199900,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "once",
        paid_until: "2027-06-30",
      }),
    ],
    RATES.rates,
    AUG,
  );

  assert.equal(overview.totalCnyCents, 199900);
  assert.equal(overview.currentYearCnyCents, 0);
  assert.equal(overview.next12CnyCents, 199900);
  assert.equal(overview.oneTime.length, 1);
  assert.equal(overview.oneTime[0].amountCnyCents, 199900);
  assert.equal(overview.oneTime[0].inNext12, true);
  assert.equal(
    overview.calendarRows[0].cells.find((cell) => cell.amountCnyCents > 0)
      ?.monthIndex,
    monthIndexOfDate("2027-06-30"),
  );
});

test("一次性到期日超出 12 个月 / 已过期：不进未来 12 个月，但仍在一次性单列", () => {
  const far = buildCostOverview(
    [
      server("far-once", {
        price_cents: 199900,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "once",
        paid_until: "2029-01-01",
      }),
    ],
    RATES.rates,
    AUG,
  );
  assert.equal(far.totalCnyCents, 199900);
  assert.equal(far.next12CnyCents, 0);
  assert.equal(far.oneTime.length, 1);
  assert.equal(far.oneTime[0].inNext12, false);
  assert.equal(far.calendarRows.length, 0);

  const past = buildCostOverview(
    [
      server("past-once", {
        price_cents: 199900,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "once",
        paid_until: "2026-01-01",
      }),
    ],
    RATES.rates,
    AUG,
  );
  assert.equal(past.next12CnyCents, 0);
});

test("未来 12 个月：只包含在线且费用完整的服务器；预付不重复；一次性按到期日", () => {
  const overview = buildCostOverview(
    [
      billed("hk", {
        price_cents: 26800,
        paid_until: "2027-01-31",
      }),
      billed("offline", {
        status: "offline",
        price_cents: 50000,
      }),
      server("once", {
        price_cents: 199900,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "once",
        paid_until: "2027-06-30",
      }),
    ],
    RATES.rates,
    AUG,
  );

  // 2026-08 到 2027-07；HK 从 2027-01 起 7 期，8-12 月已预付
  assert.equal(overview.next12CnyCents, 7 * 26800 + 199900);
  const hk = overview.calendarRows.find((row) => row.serverId === "hk");
  assert.equal(hk.cells[0].prepaid, true);
  assert.equal(hk.cells[4].prepaid, true);
  assert.equal(hk.cells[5].amountCnyCents, 26800);
  assert.equal(overview.calendarRows.some((row) => row.serverId === "offline"), false);
});

test("Top 5 / 币种构成：按一个周期的 CNY 价格排序，一次性也参与", () => {
  const overview = buildCostOverview(
    [
      billed("usd", { price_cents: 1000, currency: "USD" }),
      server("cny-yearly", {
        price_cents: 120000,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "year",
      }),
      server("once", {
        price_cents: 5000,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "once",
      }),
    ],
    RATES.rates,
    AUG,
  );

  // USD $10*7.2=¥72；年付 ¥1,200；一次性 ¥50
  assert.equal(overview.totalCnyCents, 7200 + 120000 + 5000);
  assert.deepEqual(
    overview.top.map((row) => row.serverId),
    ["cny-yearly", "usd", "once"],
  );
  assert.equal(overview.top[0].share, (120000 / 132200) * 100);

  const cny = overview.currencyMix.find((row) => row.currency === "CNY");
  assert.equal(cny.count, 2);
  assert.equal(cny.cycleOriginalCents, 125000);
  assert.equal(cny.cycleCnyCents, 125000);
  const usd = overview.currencyMix.find((row) => row.currency === "USD");
  assert.equal(usd.cycleOriginalCents, 1000);
  assert.equal(usd.cycleCnyCents, 7200);
});

test("只有离线 / 未填费用时不显示正常视图；只有未知币种时仍显示提示", () => {
  const empty = buildCostOverview(
    [
      server("offline", {
        status: "offline",
        price_cents: 10000,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "month",
      }),
      server("no-fee"),
    ],
    RATES.rates,
    AUG,
  );
  assert.equal(empty.hasData, false);

  const unknownOnly = buildCostOverview(
    [
      server("aed", {
        price_cents: 32000,
        currency: "AED",
        billing_cycle_count: 1,
        billing_cycle_unit: "month",
      }),
    ],
    RATES.rates,
    AUG,
  );
  assert.equal(unknownOnly.hasData, true);
  assert.equal(unknownOnly.totalCnyCents, 0);
  assert.equal(unknownOnly.unknownCurrency.length, 1);
});

test("buildFxDetails: 只列在用币种，CNY 在前，未知币种单独返回", () => {
  const overview = buildCostOverview(
    [
      billed("cny"),
      billed("usd-1", { currency: "USD" }),
      billed("usd-2", { currency: "USD" }),
      billed("eur", { currency: "EUR" }),
      billed("aed", { currency: "AED" }),
      billed("xxx", { currency: "XXX" }),
    ],
    RATES.rates,
    AUG,
  );
  const details = buildFxDetails(overview, RATES.rates);
  assert.deepEqual(
    details.rows.map((row) => row.currency),
    ["CNY", "EUR", "USD"],
  );
  assert.equal(details.rows[0].count, 1);
  assert.equal(details.rows[1].count, 1);
  assert.equal(details.rows[2].count, 2);
  assert.deepEqual(details.unknownCodes, ["AED", "XXX"]);
  assert.equal(details.unknownCount, 2);
  // 未使用的 JPY 不出现
  assert.ok(!details.rows.some((row) => row.currency === "JPY"));
  assert.equal(formatFxRateDisplay(7.2), "7.20");
});

test("月份标签：中文 / 英文短月份，月份序号可解析", () => {
  assert.equal(formatMonthIndex(2026 * 12 + 10), "2026-11");
  assert.equal(monthIndexOfDate("2027-01-31"), 2027 * 12);
  assert.equal(monthIndexOfDate("2027-13-01"), null);
  assert.equal(formatMonthLabel(2026 * 12 + 10, "zh-CN"), "11月");
  assert.equal(formatMonthLabel(2026 * 12 + 10, "en-US"), "Nov");
  assert.equal(formatCnyCompact(26800, "zh-CN"), "268");
});
