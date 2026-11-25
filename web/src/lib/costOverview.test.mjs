import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCostAxisTicks,
  buildCostOverview,
  buildFxDetails,
  buildMonthExpenses,
  buildRenewalMonth,
  costCycleOf,
  costFxMode,
  dayIndexOfDate,
  formatCny,
  formatCnyAxisTick,
  formatCnyCompact,
  formatCurrency,
  formatFxRateDisplay,
  formatMoney,
  formatMonthIndex,
  formatMonthLabel,
  formatSharePercent,
  monthIndexOfDate,
  parseFxRates,
  parseFxUpdatedAt,
  renewalRowsFromScope,
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

test("一次性 paid_until 早于今天（同月）视为已付，不再计入未来 12 个月", () => {
  // AUG = 2026-08-15 12:00 UTC+8：同月 1 日已经过去，15 日仍在今天。
  assert.equal(dayIndexOfDate("2026-08-01"), dayIndexOfDate("2026-08-15") - 14);
  assert.equal(dayIndexOfDate("2026-08-32"), null);

  const expired = buildCostOverview(
    [
      server("expired-today-month", {
        price_cents: 199900,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "once",
        paid_until: "2026-08-01",
      }),
    ],
    RATES.rates,
    AUG,
  );
  assert.equal(expired.next12CnyCents, 0);
  assert.equal(expired.calendarRows.length, 0);
  assert.equal(expired.oneTime[0].inNext12, false);

  // 今天到期仍然要计入（不能把当天该付的钱吞掉）。
  const today = buildCostOverview(
    [
      server("due-today", {
        price_cents: 199900,
        currency: "CNY",
        billing_cycle_count: 1,
        billing_cycle_unit: "once",
        paid_until: "2026-08-15",
      }),
    ],
    RATES.rates,
    AUG,
  );
  assert.equal(today.next12CnyCents, 199900);
  assert.equal(today.oneTime[0].inNext12, true);
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
  assert.equal(overview.top[0].cycleOriginalCents, 120000);

  const cny = overview.currencyMix.find((row) => row.currency === "CNY");
  assert.equal(cny.count, 2);
  assert.equal(cny.cycleOriginalCents, 125000);
  assert.equal(cny.cycleCnyCents, 125000);
  const usd = overview.currencyMix.find((row) => row.currency === "USD");
  assert.equal(usd.cycleOriginalCents, 1000);
  assert.equal(usd.cycleCnyCents, 7200);
});

test("Top 列表不截断，查看全部可拿到完整排序与原币金额", () => {
  const overview = buildCostOverview(
    Array.from({ length: 7 }, (_, index) =>
      billed(`srv-${index}`, {
        price_cents: (7 - index) * 1000,
        currency: "CNY",
      }),
    ),
    RATES.rates,
    AUG,
  );

  assert.equal(overview.top.length, 7);
  assert.deepEqual(
    overview.top.map((row) => row.serverId),
    Array.from({ length: 7 }, (_, index) => `srv-${index}`),
  );
  assert.equal(overview.top[0].cycleOriginalCents, 7000);
  assert.equal(overview.top[6].cycleOriginalCents, 1000);
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

test("buildRenewalMonth: 按 paid_until 归日、金额降序、摘要与空月", () => {
  const month = 2026 * 12 + 11; // 2026-12
  const rows = [
    {
      serverId: "a",
      name: "alpha",
      currency: "CNY",
      paidUntil: "2026-12-05",
      cycleCount: 1,
      cycleUnit: "month",
      amountOriginalCents: 10000,
      amountCnyCents: 10000,
    },
    {
      serverId: "b",
      name: "beta",
      currency: "USD",
      paidUntil: "2026-12-05",
      cycleCount: 1,
      cycleUnit: "month",
      amountOriginalCents: 200,
      amountCnyCents: 1440,
    },
    {
      serverId: "c",
      name: "charlie",
      currency: "CNY",
      paidUntil: "2026-12-05",
      cycleCount: 1,
      cycleUnit: "month",
      amountOriginalCents: null,
      amountCnyCents: null,
    },
    {
      serverId: "d",
      name: "delta",
      currency: "CNY",
      paidUntil: "2026-12-20",
      cycleCount: 2,
      cycleUnit: "month",
      amountOriginalCents: 5000,
      amountCnyCents: 5000,
    },
    {
      serverId: "e",
      name: "ignored",
      currency: "CNY",
      paidUntil: "2026-12-32",
      cycleCount: 1,
      cycleUnit: "month",
      amountOriginalCents: 100,
      amountCnyCents: 100,
    },
    {
      serverId: "f",
      name: "other-month",
      currency: "CNY",
      paidUntil: "2027-01-02",
      cycleCount: 1,
      cycleUnit: "month",
      amountOriginalCents: 100,
      amountCnyCents: 100,
    },
  ];
  const result = buildRenewalMonth(rows, month);
  assert.equal(result.daysInMonth, 31);
  assert.equal(result.firstWeekday, 1); // 2026-12-01 是周二
  assert.equal(result.activeDays, 2);
  assert.equal(result.totalServers, 4);
  assert.equal(result.busiestDay, 5);
  assert.equal(result.busiestCount, 3);
  assert.equal(result.days[4].count, 3);
  assert.deepEqual(
    result.days[4].events.map((event) => event.name),
    ["alpha", "beta", "charlie"],
  );
  // 无法折算的 charlie 计入台数但不计入金额，并显式标记。
  assert.equal(result.days[4].unconverted, 1);
  assert.equal(result.days[4].totalCnyCents, 10000 + 1440);
  assert.equal(result.days[19].count, 1);

  const empty = buildRenewalMonth([], month);
  assert.equal(empty.activeDays, 0);
  assert.equal(empty.totalServers, 0);
  assert.equal(empty.busiestDay, null);
});

test("续费日历只吃成本 scope：离线 / 费用不完整 / 未知币种都不出现", () => {
  const overview = buildCostOverview(
    [
      billed("keep", { paid_until: "2026-12-05" }),
      billed("offline", { status: "offline", paid_until: "2026-12-05" }),
      server("no-billing", { status: "online", paid_until: "2026-12-05" }),
      server("aed", {
        status: "online",
        currency: "AED",
        price_cents: 32000,
        billing_cycle_count: 1,
        billing_cycle_unit: "month",
        paid_until: "2026-12-05",
      }),
    ],
    RATES.rates,
    AUG,
  );
  assert.equal(overview.scopeCount, 1);
  assert.equal(overview.unknownCurrency.length, 1);

  const rows = renewalRowsFromScope(overview.scope);
  assert.deepEqual(
    rows.map((row) => row.serverId),
    ["keep"],
  );
  const month = buildRenewalMonth(rows, 2026 * 12 + 11);
  assert.equal(month.totalServers, 1);
  assert.deepEqual(
    month.days[4].events.map((event) => event.serverId),
    ["keep"],
  );
  assert.equal(month.days[4].unconverted, 0);
});

test("buildMonthExpenses: 12 个月合计、服务器降序、>8 提示与空月", () => {
  const months = Array.from({ length: 12 }, (_, index) => 2026 * 12 + 7 + index);
  const calendarRows = Array.from({ length: 10 }, (_, index) => ({
    serverId: `s-${index}`,
    name: `server-${String(index).padStart(2, "0")}`,
    currency: "CNY",
    kind: "periodic",
    cells: [
      { monthIndex: months[0], amountCnyCents: 100 + index, prepaid: false },
      { monthIndex: months[1], amountCnyCents: 0, prepaid: false },
    ],
  }));
  calendarRows.push({
    serverId: "once",
    name: "once-server",
    currency: "CNY",
    kind: "once",
    cells: [{ monthIndex: months[0], amountCnyCents: 5000, prepaid: false }],
  });
  calendarRows.push({
    serverId: "prepaid",
    name: "prepaid-server",
    currency: "CNY",
    kind: "periodic",
    cells: [{ monthIndex: months[0], amountCnyCents: 0, prepaid: true }],
  });

  const result = buildMonthExpenses({ months, calendarRows });
  assert.equal(result.length, 12);
  assert.equal(result[0].charges.length, 11);
  assert.equal(result[0].charges[0].serverId, "once");
  assert.equal(result[0].hiddenCharges, 3);
  assert.equal(result[0].oneTimeCount, 1);
  assert.equal(result[0].prepaid.length, 1);
  assert.equal(
    result[0].totalCnyCents,
    5000 + Array.from({ length: 10 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0),
  );
  assert.equal(result[1].totalCnyCents, 0);
  assert.equal(result[1].charges.length, 0);
  assert.equal(result[11].totalCnyCents, 0);
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

test("fx.provided=false：未知币种仍可列出，全 CNY 时不制造假警告", () => {
  const noRates = parseFxRates("");
  assert.equal(noRates.provided, false);

  const foreign = buildCostOverview(
    [
      billed("cny"),
      billed("usd", { currency: "USD" }),
      billed("aed", { currency: "AED" }),
    ],
    noRates.rates,
    AUG,
  );
  const details = buildFxDetails(foreign, noRates.rates);
  // CNY 仍可折算；USD/AED 都进未知列表，数量与币种都可展示。
  assert.deepEqual(details.rows.map((row) => row.currency), ["CNY"]);
  assert.deepEqual(details.unknownCodes, ["AED", "USD"]);
  assert.equal(details.unknownCount, 2);
  assert.equal(foreign.scope.some((row) => row.currency !== "CNY"), false);

  const allCny = buildCostOverview([billed("cny")], noRates.rates, AUG);
  const cnyDetails = buildFxDetails(allCny, noRates.rates);
  assert.equal(cnyDetails.unknownCount, 0);
  assert.deepEqual(cnyDetails.unknownCodes, []);
  assert.equal(allCny.scope.some((row) => row.currency !== "CNY"), false);
});

test("月份标签：中文 / 英文短月份，月份序号可解析", () => {
  assert.equal(formatMonthIndex(2026 * 12 + 10), "2026-11");
  assert.equal(monthIndexOfDate("2027-01-31"), 2027 * 12);
  assert.equal(monthIndexOfDate("2027-13-01"), null);
  assert.equal(formatMonthLabel(2026 * 12 + 10, "zh-CN"), "11月");
  assert.equal(formatMonthLabel(2026 * 12 + 10, "en-US"), "Nov");
  assert.equal(formatCnyCompact(26800, "zh-CN"), "268");
});

test("金额统一为「币种代码 + 空格 + 数字」：AED / USD / JPY / CNY、0 与负数", () => {
  // 不再用 Intl 窄符号：AED 没有窄符号时也不回退成 `AED AED 320.00`。
  assert.equal(formatMoney(32000, "AED", "zh-CN"), "AED 320.00");
  assert.equal(formatMoney(120000, "USD", "zh-CN"), "USD 1,200.00");
  assert.equal(formatMoney(0, "JPY", "zh-CN"), "JPY 0.00");
  assert.equal(formatMoney(99900, "CNY", "zh-CN"), "CNY 999.00");
  assert.equal(formatCny(99900), "CNY 999.00");
  assert.equal(formatCurrency(120000, "USD"), "USD 1,200.00");
  // 代码统一大写、去空白；负数只出现一次符号，仍然是代码在前。
  assert.equal(formatMoney(32000, " aed "), "AED 320.00");
  assert.equal(formatMoney(-12345, "USD"), "USD -123.45");
  assert.equal(formatMoney(-0, "CNY"), "CNY 0.00");
  // 英文环境同样不用 $ / ¥ / € 这类符号。
  assert.equal(formatMoney(120000, "USD", "en-US"), "USD 1,200.00");
  for (const value of [
    formatMoney(32000, "AED"),
    formatMoney(120000, "USD"),
    formatMoney(99900, "CNY"),
  ]) {
    assert.ok(!/[¥$€£]/.test(value), `must not contain a currency symbol: ${value}`);
    assert.ok(!/\b([A-Z]{3})\s+\1\b/.test(value), `duplicate code: ${value}`);
  }
});

test("金额格式化：非有限值与极大值也不会抛错", () => {
  // 极大值仍走千分位，不能用 toFixed 把精度截断。
  assert.equal(
    formatMoney(10 ** 18, "CNY"),
    "CNY 10,000,000,000,000,000.00",
  );
  assert.equal(formatMoney(Number.NaN, "USD"), "USD —");
  assert.equal(formatMoney(Number.POSITIVE_INFINITY, "JPY"), "JPY —");
});

test("占比：0 显示 0%，0 < share < 1 显示 <1%，≥1% 取整", () => {
  assert.equal(formatSharePercent(0), "0%");
  assert.equal(formatSharePercent(-3), "0%");
  assert.equal(formatSharePercent(Number.NaN), "0%");
  // JPY 0.36% 不能再被 toFixed(0) 变成 0%。
  assert.equal(formatSharePercent(0.36), "<1%");
  assert.equal(formatSharePercent(0.999), "<1%");
  assert.equal(formatSharePercent(1), "1%");
  assert.equal(formatSharePercent(1.4), "1%");
  assert.equal(formatSharePercent(14.6), "15%");
  assert.equal(formatSharePercent(49.9), "50%");
});

test("纵轴刻度：1 / 2 / 2.5 / 5 × 10^n 的整齐步长，刻度取整", () => {
  const scale = buildCostAxisTicks(902300);
  assert.equal(scale.stepCents, 250000);
  assert.equal(scale.maxCents, 1000000);
  assert.deepEqual(scale.ticksCents, [0, 250000, 500000, 750000, 1000000]);
  assert.equal(formatCnyAxisTick(1000000, scale.stepCents), "10,000");
  assert.equal(formatCnyAxisTick(0, scale.stepCents), "0");

  // 步长必须是 1 / 2 / 2.5 / 5 × 10^n，且顶端覆盖数据最大值。
  for (const max of [1, 12, 125, 902300, 171266, 12345678]) {
    const next = buildCostAxisTicks(max);
    const magnitude = 10 ** Math.floor(Math.log10(next.stepCents));
    assert.ok(
      [1, 2, 2.5, 5, 10].includes(next.stepCents / magnitude),
      `not a nice step: ${next.stepCents} (max ${max})`,
    );
    assert.ok(next.maxCents >= max, `axis max ${next.maxCents} < ${max}`);
    assert.equal(next.ticksCents[0], 0);
    assert.equal(next.ticksCents.at(-1), next.maxCents);
    for (let index = 1; index < next.ticksCents.length; index += 1) {
      assert.equal(
        next.ticksCents[index] - next.ticksCents[index - 1],
        next.stepCents,
      );
    }
  }

  // 没有数据时只显示一个 0，不编造高位刻度。
  assert.deepEqual(buildCostAxisTicks(0), {
    maxCents: 0,
    stepCents: 100,
    ticksCents: [0],
  });
});

test("汇率提示形态：正常收进卡头、缺汇率保留警告、全 CNY 不显示", () => {
  const allCny = buildCostOverview([billed("cny")], RATES.rates, AUG);
  assert.equal(costFxMode(allCny, true), "none");
  assert.equal(costFxMode(allCny, false), "none");

  const foreign = buildCostOverview(
    [billed("cny"), billed("usd", { currency: "USD" })],
    RATES.rates,
    AUG,
  );
  assert.equal(costFxMode(foreign, true), "normal");
  assert.equal(costFxMode(foreign, false), "warning");

  // 只有未配置汇率的币种、没有可折算金额时，也要保留可见警告。
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
  assert.equal(costFxMode(unknownOnly, false), "warning");
  assert.equal(costFxMode(unknownOnly, true), "normal");
});
