import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCostOverview,
  costCycleOf,
  formatCnyCompact,
  formatMonthIndex,
  formatMonthLabel,
  monthIndexOfDate,
  parseFxRates,
  parseFxUpdatedAt,
} from "./costOverview.ts";

const NOW = Date.UTC(2026, 10, 22, 4, 0, 0) / 1000; // 2026-11-22 12:00 UTC+8

const RATES = parseFxRates({ USD: 7.2, EUR: 7.8, JPY: 0.048 });

function server(id, overrides = {}) {
  return {
    id,
    name: `server-${id}`,
    status: "online",
    ...overrides,
  };
}

function monthly(id, price_cents, currency = "CNY", extra = {}) {
  return server(id, {
    price_cents,
    currency,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    ...extra,
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
  assert.equal(manual.fetchedAt, 1763700000);

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

test("costCycleOf: 新契约优先，旧 billing_cycle 回落，无周期返回 null", () => {
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
  assert.deepEqual(costCycleOf({ billing_cycle: "yearly" }), {
    kind: "months",
    months: 12,
  });
  assert.deepEqual(costCycleOf({ billing_cycle: "once" }), { kind: "once" });
  assert.equal(costCycleOf({}), null);
});

test("多币种：先按单台折算再加总，CNY 直接计入", () => {
  const overview = buildCostOverview(
    [
      monthly("usd", 1000, "USD"),
      monthly("eur", 2000, "EUR"),
      monthly("cny", 5000, "CNY"),
    ],
    RATES.rates,
    NOW,
  );

  // USD $10 * 7.2 = ¥72；EUR €20 * 7.8 = ¥156；CNY ¥50
  assert.equal(overview.monthlyCnyCents, 7200 + 15600 + 5000);
  assert.equal(overview.annualizedCnyCents, overview.monthlyCnyCents * 12);
  assert.equal(overview.periodicCount, 3);
  assert.deepEqual(
    overview.currencyMix.map((row) => row.currency),
    ["EUR", "USD", "CNY"],
  );
  assert.equal(overview.currencyMix[0].monthlyOriginalCents, 2000);
  assert.equal(overview.currencyMix[0].monthlyCnyCents, 15600);
  assert.equal(overview.top.length, 3);
  assert.equal(overview.top[0].serverId, "eur");
});

test("未知币种：不计入总额、不进入日历与 Top 5，单列台数和币种", () => {
  const overview = buildCostOverview(
    [monthly("usd", 1000, "USD"), monthly("aed", 32000, "AED")],
    RATES.rates,
    NOW,
  );

  assert.equal(overview.monthlyCnyCents, 7200);
  assert.equal(overview.annualizedCnyCents, 86400);
  assert.equal(overview.unknownCurrency.length, 1);
  assert.equal(overview.unknownCurrency[0].serverId, "aed");
  assert.equal(overview.unknownCurrency[0].currency, "AED");
  assert.equal(overview.calendarRows.length, 1);
  assert.equal(overview.calendarRows[0].serverId, "usd");
  assert.equal(overview.top.length, 1);
  assert.equal(overview.hasData, true);
});

test("年付：月均按 12 个月摊，未来 12 个月的当期金额是年付全额", () => {
  const overview = buildCostOverview(
    [
      server("yearly", {
        price_cents: 120000, // $1,200
        currency: "USD",
        billing_cycle: "yearly",
        billing_cycle_count: 1,
        billing_cycle_unit: "year",
      }),
    ],
    RATES.rates,
    NOW,
  );

  // $1,200 / 12 * 7.2 = ¥720/月
  assert.equal(overview.monthlyCnyCents, 72000);
  assert.equal(overview.annualizedCnyCents, 864000);
  // 没有 paid_until：从本月起付一期，金额是年付全额 $1,200 * 7.2 = ¥8,640
  assert.equal(overview.next12CnyCents, 864000);
  assert.equal(overview.calendarRows[0].cells[0].amountCnyCents, 864000);
  assert.equal(overview.calendarRows[0].cells[1].amountCnyCents, 0);
});

test("一次性：单独列出，不计入月均 / 年化 / 未来 12 个月 / Top 5", () => {
  const overview = buildCostOverview(
    [
      monthly("cny", 10000, "CNY"),
      server("once", {
        price_cents: 199900,
        currency: "CNY",
        billing_cycle: "once",
        billing_cycle_count: 1,
        billing_cycle_unit: "once",
        paid_until: "2027-06-30",
      }),
    ],
    RATES.rates,
    NOW,
  );

  assert.equal(overview.monthlyCnyCents, 10000);
  assert.equal(overview.annualizedCnyCents, 120000);
  assert.equal(overview.next12CnyCents, 120000);
  assert.equal(overview.oneTime.length, 1);
  assert.equal(overview.oneTime[0].serverId, "once");
  assert.equal(overview.oneTime[0].amountCnyCents, 199900);
  assert.equal(overview.calendarRows.length, 1);
  assert.equal(overview.top.length, 1);
});

test("无周期：有价格/币种但没有周期 → 不计入总额，单独计数", () => {
  const overview = buildCostOverview(
    [
      monthly("ok", 10000, "CNY"),
      server("no-cycle", { price_cents: 50000, currency: "CNY" }),
    ],
    RATES.rates,
    NOW,
  );

  assert.equal(overview.monthlyCnyCents, 10000);
  assert.equal(overview.annualizedCnyCents, 120000);
  assert.equal(overview.periodicCount, 1);
  assert.deepEqual(overview.incomplete, [
    { serverId: "no-cycle", name: "server-no-cycle", reason: "no_cycle" },
  ]);
  assert.equal(overview.hasData, true);
});

test("未来 12 个月：paid_until 之前的月份标已预付，不重复计费", () => {
  const overview = buildCostOverview(
    [monthly("hk", 26800, "CNY", { paid_until: "2027-01-31" })],
    RATES.rates,
    NOW,
  );

  // 2026-11 到 2027-10；2027-01 起付，覆盖 10 个月，11/12 月已预付
  assert.deepEqual(
    overview.months.map(formatMonthIndex),
    [
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
      "2027-03",
      "2027-04",
      "2027-05",
      "2027-06",
      "2027-07",
      "2027-08",
      "2027-09",
      "2027-10",
    ],
  );
  assert.equal(overview.next12CnyCents, 10 * 26800);
  assert.equal(overview.annualizedCnyCents, 12 * 26800);
  assert.equal(overview.prepaidSavingsCents, 2 * 26800);

  const cells = overview.calendarRows[0].cells;
  assert.equal(cells[0].prepaid, true);
  assert.equal(cells[0].amountCnyCents, 0);
  assert.equal(cells[1].prepaid, true);
  assert.equal(cells[2].prepaid, false);
  assert.equal(cells[2].amountCnyCents, 26800);
  assert.equal(cells[11].amountCnyCents, 26800);
});

test("季付：每 3 个月付一次，付款单元格是整期金额", () => {
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
    NOW,
  );

  assert.equal(overview.monthlyCnyCents, 10000);
  assert.equal(overview.next12CnyCents, 30000 * 4);
  const amounts = overview.calendarRows[0].cells.map(
    (cell) => cell.amountCnyCents,
  );
  assert.deepEqual(amounts, [
    30000, 0, 0, 30000, 0, 0, 30000, 0, 0, 30000, 0, 0,
  ]);
});

test("币种构成与 Top 5 的占比按折算后的月均计算", () => {
  const overview = buildCostOverview(
    [
      monthly("a", 1000, "USD"), // ¥72
      monthly("b", 2000, "USD"), // ¥144
      monthly("c", 1000, "CNY"), // ¥10
    ],
    RATES.rates,
    NOW,
  );

  assert.equal(overview.monthlyCnyCents, 22600);
  const usd = overview.currencyMix.find((row) => row.currency === "USD");
  assert.equal(usd.count, 2);
  assert.equal(usd.monthlyOriginalCents, 3000);
  assert.equal(usd.monthlyCnyCents, 21600);
  assert.equal(usd.share, (21600 / 22600) * 100);

  assert.deepEqual(
    overview.top.map((row) => row.serverId),
    ["b", "a", "c"],
  );
  assert.equal(overview.top[0].share, (14400 / 22600) * 100);
});

test("只有未配置完整的数据时不显示正常视图", () => {
  const overview = buildCostOverview(
    [server("no-price", { currency: "CNY", billing_cycle: "monthly" })],
    RATES.rates,
    NOW,
  );
  assert.equal(overview.hasData, false);
  assert.equal(overview.incomplete[0].reason, "missing_price");
});

test("月份标签：中文 / 英文短月份，月份序号可解析", () => {
  assert.equal(formatMonthIndex(2026 * 12 + 10), "2026-11");
  assert.equal(monthIndexOfDate("2027-01-31"), 2027 * 12);
  assert.equal(monthIndexOfDate("2027-13-01"), null);
  assert.equal(formatMonthLabel(2026 * 12 + 10, "zh-CN"), "11月");
  assert.equal(formatMonthLabel(2026 * 12 + 10, "en-US"), "Nov");
  assert.equal(formatCnyCompact(26800, "zh-CN"), "268");
});
