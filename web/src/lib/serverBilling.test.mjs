import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import { setCurrentLocale } from "../i18n/locale.ts";
import { ApiError } from "./apiError.ts";
import { errorText } from "./errors.ts";
import {
  BILLING_CYCLES,
  BILLING_CYCLE_COUNT_MAX,
  BILLING_CYCLE_COUNT_MIN,
  BILLING_CYCLE_UNITS,
  BILLING_NONE,
  billingCycleFor,
  billingCyclePayload,
  billingCycleUnitFor,
  billingFieldForError,
  billingFormFromServer,
  billingPayload,
  CURRENCY_CUSTOM,
  CURRENCY_NONE,
  currencySelectValue,
  cycleCountForUnit,
  EMPTY_BILLING_FORM,
  formatPriceYuan,
  hasAnyBillingField,
  isBillingCycleCount,
  isBillingCycleUnit,
  isCurrencyCode,
  isIsoDate,
  isPaidUntilInRange,
  parseCycleCount,
  parsePriceYuan,
  PAID_UNTIL_MAX,
  PAID_UNTIL_MIN,
  PRICE_CENTS_MAX,
  sanitizeCurrencyInput,
  sanitizeCycleCountInput,
  translateBillingErrors,
  validateBillingForm,
} from "./serverBilling.ts";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function withLocale(locale, fn) {
  setCurrentLocale(locale);
  try {
    fn();
  } finally {
    setCurrentLocale("en");
  }
}

/** 只覆盖关心的字段，其余按「未填写」处理。 */
function form(patch = {}) {
  return { ...EMPTY_BILLING_FORM, ...patch };
}

test("isIsoDate accepts real dates and rejects impossible/malformed ones", () => {
  assert.equal(isIsoDate("2026-12-31"), true);
  assert.equal(isIsoDate("2024-02-29"), true, "闰日是真日期");
  assert.equal(isIsoDate("2028-02-29"), true);
  for (const bad of [
    "2026-02-30",
    "2026-13-01",
    "2026-2-01",
    "20260101",
    "2026/12/31",
    "2026-00-10",
    "",
    "   ",
    null,
    undefined,
  ]) {
    assert.equal(isIsoDate(bad), false, `${bad} 不应通过`);
  }
});

test("parsePriceYuan converts yuan to cents without float drift", () => {
  assert.deepEqual(parsePriceYuan("49.99"), { ok: true, cents: 4999 });
  assert.deepEqual(parsePriceYuan("0.1"), { ok: true, cents: 10 });
  assert.deepEqual(parsePriceYuan("0.01"), { ok: true, cents: 1 });
  assert.deepEqual(parsePriceYuan("268"), { ok: true, cents: 26800 });
  assert.deepEqual(parsePriceYuan(" 268.5 "), { ok: true, cents: 26850 });
  // 空串 = 不填写，不是 0。
  assert.deepEqual(parsePriceYuan(""), { ok: true, cents: null });
  assert.deepEqual(parsePriceYuan("   "), { ok: true, cents: null });
  // 0 是合法价格。
  assert.deepEqual(parsePriceYuan("0"), { ok: true, cents: 0 });
  assert.deepEqual(parsePriceYuan("0.00"), { ok: true, cents: 0 });
  // 上界：999,999,999 分。
  assert.deepEqual(parsePriceYuan("9999999.99"), {
    ok: true,
    cents: PRICE_CENTS_MAX,
  });
});

test("parsePriceYuan rejects formats and out-of-range prices", () => {
  for (const bad of ["1.234", "1.", ".5", "-1", "1,000", "abc", "1e3", "¥1", "1 000"]) {
    assert.equal(parsePriceYuan(bad).ok, false, `${bad} 应被拒绝`);
    assert.equal(parsePriceYuan(bad).reason, "format", bad);
  }
  assert.deepEqual(parsePriceYuan("10000000"), {
    ok: false,
    reason: "range",
  });
  assert.deepEqual(parsePriceYuan("999999999999999999999"), {
    ok: false,
    reason: "range",
  });
});

test("formatPriceYuan renders cents as editable yuan text", () => {
  assert.equal(formatPriceYuan(4999), "49.99");
  assert.equal(formatPriceYuan(4990), "49.9");
  assert.equal(formatPriceYuan(5000), "50");
  assert.equal(formatPriceYuan(0), "0");
  assert.equal(formatPriceYuan(null), "");
  assert.equal(formatPriceYuan(undefined), "");
  // 超出后端允许范围 / 负数 / 非有限值都不进输入框（避免一保存就被拒）。
  assert.equal(formatPriceYuan(PRICE_CENTS_MAX + 1), "");
  assert.equal(formatPriceYuan(-100), "");
  assert.equal(formatPriceYuan(Number.NaN), "");
});

test("cycle constants match the new quantity + unit contract", () => {
  assert.deepEqual(BILLING_CYCLE_UNITS, ["month", "year", "once"]);
  assert.deepEqual(BILLING_CYCLES, ["monthly", "yearly", "once"]);
  assert.equal(BILLING_CYCLE_COUNT_MIN, 1);
  assert.equal(BILLING_CYCLE_COUNT_MAX, 1200);
  assert.equal(BILLING_NONE, "none");
});

test("isBillingCycleUnit / billingCycleUnitFor map legacy and new values", () => {
  assert.equal(isBillingCycleUnit("month"), true);
  assert.equal(isBillingCycleUnit("year"), true);
  assert.equal(isBillingCycleUnit("once"), true);
  for (const bad of ["monthly", "MONTH", "", "  ", null, undefined, 1]) {
    assert.equal(isBillingCycleUnit(bad), false, String(bad));
  }

  assert.equal(billingCycleUnitFor("monthly"), "month");
  assert.equal(billingCycleUnitFor(" Yearly "), "year");
  assert.equal(billingCycleUnitFor("once"), "once");
  assert.equal(billingCycleUnitFor("weekly"), null);
  assert.equal(billingCycleUnitFor(null), null);

  assert.equal(billingCycleFor("month"), "monthly");
  assert.equal(billingCycleFor("year"), "yearly");
  assert.equal(billingCycleFor("once"), "once");
});

test("parseCycleCount accepts 1..1200 integers and blank", () => {
  assert.deepEqual(parseCycleCount(""), { ok: true, count: null });
  assert.deepEqual(parseCycleCount("   "), { ok: true, count: null });
  assert.deepEqual(parseCycleCount("1"), { ok: true, count: 1 });
  assert.deepEqual(parseCycleCount("3"), { ok: true, count: 3 });
  assert.deepEqual(parseCycleCount(" 1200 "), { ok: true, count: 1200 });
  // 前导零按数值处理。
  assert.deepEqual(parseCycleCount("03"), { ok: true, count: 3 });

  for (const bad of ["0", "1201", "9999", "-1", "1.5", "1e3", "abc", "１"]) {
    const result = parseCycleCount(bad);
    assert.equal(result.ok, false, `${bad} 应被拒绝`);
  }
  assert.equal(parseCycleCount("0").reason, "range");
  assert.equal(parseCycleCount("1201").reason, "range");
  assert.equal(parseCycleCount("1.5").reason, "format");
  assert.equal(parseCycleCount("abc").reason, "format");

  assert.equal(isBillingCycleCount(1), true);
  assert.equal(isBillingCycleCount(1200), true);
  assert.equal(isBillingCycleCount(0), false);
  assert.equal(isBillingCycleCount(1201), false);
  assert.equal(isBillingCycleCount(1.5), false);
  assert.equal(isBillingCycleCount(null), false);
});

test("cycleCountForUnit fills the default 1 and freezes once at 1", () => {
  assert.equal(cycleCountForUnit("month", ""), "1");
  assert.equal(cycleCountForUnit("year", "   "), "1");
  assert.equal(cycleCountForUnit("month", "3"), "3");
  // 一次性固定 1，不沿用旧数量。
  assert.equal(cycleCountForUnit("once", "3"), "1");
  assert.equal(cycleCountForUnit("once", ""), "1");
});

test("sanitizeCycleCountInput only keeps digits and caps at 4", () => {
  assert.equal(sanitizeCycleCountInput("12a3"), "123");
  assert.equal(sanitizeCycleCountInput("-1"), "1");
  assert.equal(sanitizeCycleCountInput("1.5"), "15");
  assert.equal(sanitizeCycleCountInput("12345"), "1234");
  assert.equal(sanitizeCycleCountInput("abc"), "");
  assert.equal(sanitizeCycleCountInput(" 1 2 "), "12");
});

test("EMPTY_BILLING_FORM is the create default and submits no cycle", () => {
  // 新建表单默认全空：管理员没填过的周期不能被写进服务器。
  assert.deepEqual(EMPTY_BILLING_FORM, {
    paidUntil: "",
    price: "",
    currency: "",
    cycleCount: "",
    cycleUnit: "",
  });
  assert.equal(hasAnyBillingField(EMPTY_BILLING_FORM), false);
  assert.deepEqual(billingPayload(EMPTY_BILLING_FORM), {
    paid_until: null,
    price_cents: null,
    currency: null,
    billing_cycle: null,
    billing_cycle_count: null,
    billing_cycle_unit: null,
  });
  // 用户选中单位时数量才补默认 1。
  assert.equal(cycleCountForUnit("month", ""), "1");
});

test("billingFormFromServer backfills count + unit and falls back to legacy", () => {
  const base = {
    paid_until: "2026-12-31",
    price_cents: 4999,
    currency: "CNY",
  };

  // 新契约优先，原样回填。
  assert.deepEqual(
    billingFormFromServer({
      ...base,
      billing_cycle: "monthly",
      billing_cycle_count: 3,
      billing_cycle_unit: "month",
    }),
    {
      paidUntil: "2026-12-31",
      price: "49.99",
      currency: "CNY",
      cycleCount: "3",
      cycleUnit: "month",
    },
  );
  assert.equal(
    billingFormFromServer({
      ...base,
      billing_cycle_count: 2,
      billing_cycle_unit: "year",
    }).cycleCount,
    "2",
  );
  assert.equal(
    billingFormFromServer({
      ...base,
      billing_cycle_count: 2,
      billing_cycle_unit: "year",
    }).cycleUnit,
    "year",
  );
  // 一次性没有数量语义：控件固定 1（即使存量值是 100）。
  assert.deepEqual(
    billingFormFromServer({
      ...base,
      billing_cycle: "once",
      billing_cycle_count: 100,
      billing_cycle_unit: "once",
    }),
    {
      paidUntil: "2026-12-31",
      price: "49.99",
      currency: "CNY",
      cycleCount: "1",
      cycleUnit: "once",
    },
  );

  // 旧数据只有 billing_cycle：按 monthly → 1 个月、yearly → 1 年、once → 一次性。
  const legacy = (cycle) =>
    billingFormFromServer({ ...base, billing_cycle: cycle });
  assert.deepEqual(legacy("monthly"), {
    paidUntil: "2026-12-31",
    price: "49.99",
    currency: "CNY",
    cycleCount: "1",
    cycleUnit: "month",
  });
  assert.equal(legacy("yearly").cycleUnit, "year");
  assert.equal(legacy("once").cycleUnit, "once");
  assert.equal(legacy("weekly").cycleUnit, "");

  // 新字段缺一半 / 脏值：回落到旧派生字段。
  assert.equal(
    billingFormFromServer({
      ...base,
      billing_cycle: "yearly",
      billing_cycle_count: 3,
      billing_cycle_unit: null,
    }).cycleUnit,
    "year",
  );
  assert.equal(
    billingFormFromServer({
      ...base,
      billing_cycle: "yearly",
      billing_cycle_count: null,
      billing_cycle_unit: "month",
    }).cycleCount,
    "1",
  );
  assert.equal(
    billingFormFromServer({
      ...base,
      billing_cycle: null,
      billing_cycle_count: 0,
      billing_cycle_unit: "month",
    }).cycleUnit,
    "",
  );

  // 旧后端整组缺失 / 未填写 = 未填写；编辑不回填默认值。
  assert.deepEqual(
    billingFormFromServer({
      paid_until: null,
      price_cents: null,
      currency: null,
      billing_cycle: null,
      billing_cycle_count: null,
      billing_cycle_unit: null,
    }),
    EMPTY_BILLING_FORM,
  );
  assert.deepEqual(billingFormFromServer({}), EMPTY_BILLING_FORM);

  // 脏值不进输入框；未知币种保留给「自定义」，非法周期丢掉。
  const dirty = billingFormFromServer({
    paid_until: "2026-02-30",
    price_cents: 1_000_000_000,
    currency: "JPY",
    billing_cycle: "weekly",
    billing_cycle_count: 1201,
    billing_cycle_unit: "week",
  });
  assert.deepEqual(dirty, {
    paidUntil: "",
    price: "",
    currency: "JPY",
    cycleCount: "",
    cycleUnit: "",
  });

  // 年份越界的存量值也不进输入框（后端读路径同样按未填写处理）。
  for (const date of ["1969-12-31", "2101-01-01"]) {
    assert.equal(
      billingFormFromServer({
        paid_until: date,
        price_cents: null,
        currency: null,
        billing_cycle: null,
      }).paidUntil,
      "",
      date,
    );
  }

  // 0 元是有效值，不能被当成空。
  assert.equal(
    billingFormFromServer({ paid_until: null, price_cents: 0 }).price,
    "0",
  );
});

test("hasAnyBillingField ignores whitespace-only input", () => {
  assert.equal(hasAnyBillingField(EMPTY_BILLING_FORM), false);
  assert.equal(
    hasAnyBillingField(
      form({ paidUntil: " ", price: "", currency: "", cycleCount: " ", cycleUnit: " " }),
    ),
    false,
  );
  for (const filled of [
    { paidUntil: "2026-12-31" },
    { price: "0" },
    { currency: "CNY" },
    { cycleCount: "3" },
    { cycleUnit: "once" },
    { cycleCount: "1", cycleUnit: "month" },
  ]) {
    assert.equal(
      hasAnyBillingField(form(filled)),
      true,
      JSON.stringify(filled),
    );
  }
});

test("validateBillingForm allows empty and independent fields", () => {
  assert.deepEqual(validateBillingForm(EMPTY_BILLING_FORM), {});
  assert.deepEqual(
    validateBillingForm(form({ paidUntil: "2026-12-31" })),
    {},
    "只填到期合法（与价格/币种独立）",
  );
  assert.deepEqual(
    validateBillingForm(form({ cycleCount: "1", cycleUnit: "month" })),
    {},
    "1 个月合法",
  );
  assert.deepEqual(
    validateBillingForm(form({ cycleCount: "3", cycleUnit: "month" })),
    {},
    "3 个月合法",
  );
  assert.deepEqual(
    validateBillingForm(form({ cycleCount: "2", cycleUnit: "year" })),
    {},
    "2 年合法",
  );
  assert.deepEqual(
    validateBillingForm(form({ cycleCount: "1", cycleUnit: "once" })),
    {},
    "一次性合法",
  );
  // 一次性固定 1；即使数量为空也不该报「缺一半」。
  assert.deepEqual(
    validateBillingForm(form({ cycleUnit: "once" })),
    {},
    "一次性不要求数量",
  );
  assert.deepEqual(
    validateBillingForm(form({ price: "268", currency: "CNY" })),
    {},
    "价格与币种成对合法",
  );
});

test("validateBillingForm requires the cycle quantity and unit as a pair", () => {
  // 只有数量：错误落在单位上。
  assert.deepEqual(
    validateBillingForm(form({ cycleCount: "3" })),
    { billing_cycle_unit: "servers.billing.errors.cycleUnitPair" },
  );
  // 只有月 / 年单位：错误落在数量上。
  for (const unit of ["month", "year"]) {
    assert.deepEqual(
      validateBillingForm(form({ cycleUnit: unit })),
      { billing_cycle_count: "servers.billing.errors.cycleCountPair" },
      unit,
    );
  }
  // 两者都空：通过（未填写）。
  assert.deepEqual(validateBillingForm(form({})), {});
  // 数量格式非法时只报数量，不叠加「缺单位」。
  assert.deepEqual(
    validateBillingForm(form({ cycleCount: "1.5", cycleUnit: "month" })),
    { billing_cycle_count: "servers.billing.errors.cycleCount" },
  );
  assert.deepEqual(
    validateBillingForm(form({ cycleCount: "1201", cycleUnit: "month" })),
    { billing_cycle_count: "servers.billing.errors.cycleCount" },
  );
  // 单位枚举外：错误落在单位上。
  assert.deepEqual(
    validateBillingForm(form({ cycleCount: "3", cycleUnit: "week" })),
    { billing_cycle_unit: "servers.billing.errors.cycleUnit" },
  );
});

test("validateBillingForm requires price and currency as a pair", () => {
  // 只填价格：错误落在缺的币种上。
  assert.deepEqual(
    validateBillingForm(form({ price: "268" })),
    { currency: "servers.billing.errors.currencyPair" },
  );
  // 只填币种：错误落在缺的价格上。
  assert.deepEqual(
    validateBillingForm(form({ currency: "CNY" })),
    { price_cents: "servers.billing.errors.pricePair" },
  );
  // 两边都空 / 两边都有：通过。
  assert.deepEqual(
    validateBillingForm(
      form({ paidUntil: "2026-12-31", cycleCount: "1", cycleUnit: "once" }),
    ),
    {},
  );
  // 价格本身非法时只报格式，不叠加「缺币种」，避免同一字段两条信息。
  assert.deepEqual(
    validateBillingForm(form({ price: "abc" })),
    { price_cents: "servers.billing.errors.price" },
  );
});

test("isPaidUntilInRange enforces 1970-01-01..=2100-12-31", () => {
  assert.equal(isPaidUntilInRange(PAID_UNTIL_MIN), true);
  assert.equal(isPaidUntilInRange(PAID_UNTIL_MAX), true);
  assert.equal(isPaidUntilInRange("2026-12-31"), true);
  assert.equal(isPaidUntilInRange("1969-12-31"), false);
  assert.equal(isPaidUntilInRange("2101-01-01"), false);
  assert.equal(isPaidUntilInRange("0000-01-01"), false);
  assert.equal(isPaidUntilInRange("9999-12-31"), false);
  // 格式非法同样是「不合法」。
  assert.equal(isPaidUntilInRange("2026-02-30"), false);
  assert.equal(isPaidUntilInRange("2026-1-01"), false);
  assert.equal(isPaidUntilInRange(""), false);
  assert.equal(isPaidUntilInRange(null), false);
});

test("validateBillingForm rejects dates outside the allowed years", () => {
  for (const date of ["1969-12-31", "2101-01-01", "9999-12-31"]) {
    assert.deepEqual(
      validateBillingForm(form({ paidUntil: date })),
      { paid_until: "servers.billing.errors.paidUntil" },
      date,
    );
  }
  // 边界日期本身合法。
  for (const date of [PAID_UNTIL_MIN, PAID_UNTIL_MAX]) {
    assert.deepEqual(
      validateBillingForm(form({ paidUntil: date })),
      {},
      date,
    );
  }
});

test("validateBillingForm points every bad field at its own message", () => {
  const errors = validateBillingForm({
    paidUntil: "2026-02-30",
    price: "1.234",
    currency: "cny",
    cycleCount: "1201",
    cycleUnit: "week",
  });
  assert.equal(errors.paid_until, "servers.billing.errors.paidUntil");
  assert.equal(errors.price_cents, "servers.billing.errors.price");
  assert.equal(errors.currency, "servers.billing.errors.currency");
  assert.equal(errors.billing_cycle_count, "servers.billing.errors.cycleCount");
  assert.equal(errors.billing_cycle_unit, "servers.billing.errors.cycleUnit");

  assert.equal(
    validateBillingForm(form({ price: "10000000" })).price_cents,
    "servers.billing.errors.price",
  );
});

test("translateBillingErrors turns validation keys into final copy once", () => {
  const translated = translateBillingErrors(
    validateBillingForm({
      paidUntil: "2026-02-30",
      price: "1.234",
      currency: "cny",
      cycleCount: "3",
      cycleUnit: "week",
    }),
    (key) => `T:${key}`,
  );
  assert.deepEqual(translated, {
    paid_until: "T:servers.billing.errors.paidUntil",
    price_cents: "T:servers.billing.errors.price",
    currency: "T:servers.billing.errors.currency",
    billing_cycle_unit: "T:servers.billing.errors.cycleUnit",
  });
  assert.deepEqual(translateBillingErrors({}, String), {});
});

test("billingCyclePayload emits count + unit and the legacy derived cycle", () => {
  assert.deepEqual(billingCyclePayload({ cycleCount: "1", cycleUnit: "month" }), {
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
  });
  // 3 个月 / 2 年不能谎报成旧字段 monthly / yearly：派生值必须是 null。
  assert.deepEqual(billingCyclePayload({ cycleCount: "3", cycleUnit: "month" }), {
    billing_cycle: null,
    billing_cycle_count: 3,
    billing_cycle_unit: "month",
  });
  assert.deepEqual(billingCyclePayload({ cycleCount: "2", cycleUnit: "year" }), {
    billing_cycle: null,
    billing_cycle_count: 2,
    billing_cycle_unit: "year",
  });
  // 1 个对应单位才保留旧派生镜像。
  assert.equal(
    billingCyclePayload({ cycleCount: "1", cycleUnit: "year" }).billing_cycle,
    "yearly",
  );
  // 一次性始终发 1，不沿用输入框里可能残留的旧数量。
  assert.deepEqual(billingCyclePayload({ cycleCount: "9", cycleUnit: "once" }), {
    billing_cycle: "once",
    billing_cycle_count: 1,
    billing_cycle_unit: "once",
  });
  // 两者留空 = 两列都 null（显式清空）。
  assert.deepEqual(billingCyclePayload({ cycleCount: "", cycleUnit: "" }), {
    billing_cycle: null,
    billing_cycle_count: null,
    billing_cycle_unit: null,
  });
  // 缺一半 / 脏值：绝不提交半对。
  assert.deepEqual(billingCyclePayload({ cycleCount: "3", cycleUnit: "" }), {
    billing_cycle: null,
    billing_cycle_count: null,
    billing_cycle_unit: null,
  });
  assert.deepEqual(billingCyclePayload({ cycleCount: "", cycleUnit: "month" }), {
    billing_cycle: null,
    billing_cycle_count: null,
    billing_cycle_unit: null,
  });
  assert.deepEqual(billingCyclePayload({ cycleCount: "1201", cycleUnit: "month" }), {
    billing_cycle: null,
    billing_cycle_count: null,
    billing_cycle_unit: null,
  });
});

test("billingPayload always sends every billing field, empty = null", () => {
  assert.deepEqual(billingPayload(EMPTY_BILLING_FORM), {
    paid_until: null,
    price_cents: null,
    currency: null,
    billing_cycle: null,
    billing_cycle_count: null,
    billing_cycle_unit: null,
  });

  assert.deepEqual(
    billingPayload({
      paidUntil: "2026-12-31",
      price: "49.99",
      currency: "cny",
      cycleCount: "3",
      cycleUnit: "month",
    }),
    {
      paid_until: "2026-12-31",
      price_cents: 4999,
      currency: "CNY",
      billing_cycle: null,
      billing_cycle_count: 3,
      billing_cycle_unit: "month",
    },
  );

  // 一次性的数量固定 1；旧派生字段仍是 once。
  assert.deepEqual(
    billingPayload({
      paidUntil: "",
      price: "199",
      currency: "CNY",
      cycleCount: "1",
      cycleUnit: "once",
    }),
    {
      paid_until: null,
      price_cents: 19900,
      currency: "CNY",
      billing_cycle: "once",
      billing_cycle_count: 1,
      billing_cycle_unit: "once",
    },
  );

  // 0 元是有效价格，必须提交 0 而不是 null（需与币种成对）。
  assert.equal(
    billingPayload(form({ price: "0", currency: "CNY" })).price_cents,
    0,
  );

  // 未通过前端校验的值一律不提交脏数据。
  assert.deepEqual(
    billingPayload({
      paidUntil: "2026-02-30",
      price: "-1",
      currency: "CNY1",
      cycleCount: "1201",
      cycleUnit: "week",
    }),
    {
      paid_until: null,
      price_cents: null,
      currency: null,
      billing_cycle: null,
      billing_cycle_count: null,
      billing_cycle_unit: null,
    },
  );
});

test("billingPayload never submits a half price/currency or cycle pair", () => {
  // 只填价格 / 只填币种：整对清空（要么都清，要么都不清）。
  assert.deepEqual(
    billingPayload(form({ price: "268" })),
    {
      paid_until: null,
      price_cents: null,
      currency: null,
      billing_cycle: null,
      billing_cycle_count: null,
      billing_cycle_unit: null,
    },
  );
  assert.deepEqual(
    billingPayload(form({ currency: "CNY" })),
    {
      paid_until: null,
      price_cents: null,
      currency: null,
      billing_cycle: null,
      billing_cycle_count: null,
      billing_cycle_unit: null,
    },
  );
  // 成对时两个都保留。
  assert.deepEqual(
    billingPayload(form({ price: "0", currency: "eur" })),
    {
      paid_until: null,
      price_cents: 0,
      currency: "EUR",
      billing_cycle: null,
      billing_cycle_count: null,
      billing_cycle_unit: null,
    },
  );
  // 周期只填一半：两列都 null。
  assert.deepEqual(
    billingPayload(form({ cycleCount: "3" })),
    {
      paid_until: null,
      price_cents: null,
      currency: null,
      billing_cycle: null,
      billing_cycle_count: null,
      billing_cycle_unit: null,
    },
  );
});

test("billingPayload drops a date outside the allowed year range", () => {
  assert.equal(billingPayload(form({ paidUntil: "1969-12-31" })).paid_until, null);
  assert.equal(billingPayload(form({ paidUntil: "2101-01-01" })).paid_until, null);
  assert.equal(
    billingPayload(form({ paidUntil: PAID_UNTIL_MAX })).paid_until,
    PAID_UNTIL_MAX,
  );
});

test("billingFieldForError maps backend codes to the new form fields", () => {
  const cases = {
    "server.paid_until_invalid": "paid_until",
    "server.price_cents_invalid": "price_cents",
    "server.currency_invalid": "currency",
    "server.billing_cycle_count_invalid": "billing_cycle_count",
    "server.billing_cycle_unit_invalid": "billing_cycle_unit",
      "server.billing_cycle_once_count_invalid": "billing_cycle_count",
    // 旧后端的合并错误码现在对应单位下拉。
    "server.billing_cycle_invalid": "billing_cycle_unit",
  };
  for (const [code, field] of Object.entries(cases)) {
    assert.equal(
      billingFieldForError(new ApiError("bad", 400, code)),
      field,
      code,
    );
  }

  // 新后端的「周期缺一半」：params.missing 指哪边缺，错误就落哪边。
  assert.equal(
    billingFieldForError(
      new ApiError("bad", 400, "server.billing_cycle_pair_incomplete", {
        missing: "billing_cycle_count",
      }),
    ),
    "billing_cycle_count",
  );
  assert.equal(
    billingFieldForError(
      new ApiError("bad", 400, "server.billing_cycle_pair_incomplete", {
        missing: "billing_cycle_unit",
      }),
    ),
    "billing_cycle_unit",
  );

  // 价格/币种成对：params.missing 指哪边缺，错误就落哪边。
  assert.equal(
    billingFieldForError(
      new ApiError("bad", 400, "server.billing_pair_incomplete", {
        missing: "currency",
      }),
    ),
    "currency",
  );
  assert.equal(
    billingFieldForError(
      new ApiError("bad", 400, "server.billing_pair_incomplete", {
        missing: "price_cents",
      }),
    ),
    "price_cents",
  );
  assert.equal(
    billingFieldForError(
      new ApiError("bad", 400, "server.billing_pair_incomplete"),
    ),
    "currency",
  );

  // 旧后端只有 params.field：能对上就落字段（含旧 billing_cycle）。
  assert.equal(
    billingFieldForError(
      new ApiError("bad", 400, "backend.unknown_code", {
        field: "billing_cycle_count",
      }),
    ),
    "billing_cycle_count",
  );
  assert.equal(
    billingFieldForError(
      new ApiError("bad", 400, "backend.unknown_code", { field: "billing_cycle" }),
    ),
    "billing_cycle_unit",
  );
  assert.equal(
    billingFieldForError(
      new ApiError("bad", 400, "backend.unknown_code", { field: "currency" }),
    ),
    "currency",
  );
  assert.equal(
    billingFieldForError(
      new ApiError("bad", 400, "backend.unknown_code", { field: "name" }),
    ),
    null,
  );
  assert.equal(billingFieldForError(new ApiError("bad", 500)), null);
  assert.equal(billingFieldForError(new Error("plain")), null);
  assert.equal(billingFieldForError(null), null);
});

test("currency select helpers pick preset / custom / none", () => {
  assert.equal(currencySelectValue(""), CURRENCY_NONE);
  assert.equal(currencySelectValue("   "), CURRENCY_NONE);
  assert.equal(currencySelectValue("CNY"), "CNY");
  assert.equal(currencySelectValue("usd"), "USD");
  assert.equal(currencySelectValue("JPY"), CURRENCY_CUSTOM);
  assert.equal(currencySelectValue("cny"), "CNY");

  assert.equal(sanitizeCurrencyInput("cny"), "CNY");
  assert.equal(sanitizeCurrencyInput("j p y"), "JPY");
  assert.equal(sanitizeCurrencyInput("中1C2N3Y4"), "CNY");
  assert.equal(sanitizeCurrencyInput("c"), "C");
  assert.equal(isCurrencyCode("CNY"), true);
  assert.equal(isCurrencyCode("cny"), false);
  assert.equal(isCurrencyCode("CN"), false);
  assert.equal(isCurrencyCode("CNYY"), false);
});

test("billing i18n keys exist in both locales", () => {
  const keys = [
    "title",
    "clear",
    "paidUntil",
    "price",
    "pricePlaceholder",
    "currency",
    "currencyPlaceholder",
    "currencyCustom",
    "currencyCustomPlaceholder",
    "cycle",
    "cyclePlaceholder",
    "cycleCount",
    "cycleCountPlaceholder",
    "cycleUnit",
    "cycleUnitMonth",
    "cycleUnitYear",
    "cycleUnitOnce",
    "none",
    "publicHint",
  ];
  for (const key of keys) {
    assert.equal(
      typeof zh.servers.billing[key],
      "string",
      `zh servers.billing.${key}`,
    );
    assert.equal(
      typeof en.servers.billing[key],
      "string",
      `en servers.billing.${key}`,
    );
  }
  for (const key of [
    "paidUntil",
    "price",
    "currency",
    "currencyPair",
    "pricePair",
    "cycle",
    "cycleCount",
    "cycleUnit",
    "cycleCountPair",
    "cycleUnitPair",
  ]) {
    assert.equal(
      typeof zh.servers.billing.errors[key],
      "string",
      `zh error.${key}`,
    );
    assert.equal(
      typeof en.servers.billing.errors[key],
      "string",
      `en error.${key}`,
    );
  }
});

test("backend billing and request error codes are translated in both locales", () => {
  const codes = [
    "server.paid_until_invalid",
    "server.price_cents_invalid",
    "server.currency_invalid",
    "server.billing_cycle_invalid",
    "server.billing_cycle_count_invalid",
    "server.billing_cycle_unit_invalid",
    "server.billing_cycle_once_count_invalid",
    "server.billing_cycle_pair_incomplete",
    "server.billing_pair_incomplete",
    "request.invalid_json",
  ];
  for (const code of codes) {
    assert.equal(typeof zh.errors[code], "string", `zh ${code}`);
    assert.equal(typeof en.errors[code], "string", `en ${code}`);
  }

  withLocale("zh-CN", () => {
    const text = errorText(
      new ApiError("价格（分）不合法", 400, "server.price_cents_invalid"),
      "fallback",
    );
    assert.match(text, /价格/);
  });
  withLocale("en", () => {
    const text = errorText(
      new ApiError("价格（分）不合法", 400, "server.price_cents_invalid"),
      "fallback",
    );
    assert.match(text, /price/i);
  });
});

test("request.invalid_json and the pair error have bilingual copy", () => {
  assert.equal(zh.errors["request.invalid_json"], "请求格式不正确");
  assert.equal(en.errors["request.invalid_json"], "Invalid request format");
  assert.match(
    zh.errors["server.billing_pair_incomplete"],
    /价格与币种/,
  );
  assert.match(
    en.errors["server.billing_pair_incomplete"],
    /Price and currency/,
  );

  withLocale("zh-CN", () => {
    assert.equal(
      errorText(
        new ApiError("invalid json", 400, "request.invalid_json", {
          detail: "expected value at line 1",
        }),
        "fallback",
      ),
      "请求格式不正确",
      "不应把 detail 展示给用户",
    );
  });
  withLocale("en", () => {
    assert.equal(
      errorText(new ApiError("invalid json", 400, "request.invalid_json"), "fallback"),
      "Invalid request format",
    );
  });
});

test("the shared billing form renders the count + unit row and the public hint", () => {
  const source = read("../components/servers/BillingFields.tsx");
  assert.match(source, /type="date"/);
  assert.match(source, /min=\{PAID_UNTIL_MIN\}/);
  assert.match(source, /max=\{PAID_UNTIL_MAX\}/);
  assert.match(source, /inputMode="decimal"/);
  assert.match(source, /BILLING_CURRENCIES\.map/);
  assert.match(source, /CURRENCY_CUSTOM/);
  assert.match(source, /hasAnyBillingField/);
  assert.match(source, /servers\.billing\.publicHint/);
  assert.match(source, /servers\.billing\.clear/);
  // 数量 + 单位同一行；数量是可校验的文本输入（不用原生 number 拦提交）。
  assert.match(source, /cycleCountId/);
  assert.match(source, /cycleUnitId/);
  assert.match(source, /inputMode="numeric"/);
  assert.match(source, /cycleCountForUnit/);
  assert.doesNotMatch(source, /type="number"/);
  // 一次性：数量固定 1 并禁用。
  assert.match(source, /const cycleOnce = value\.cycleUnit === "once"/);
  assert.match(source, /disabled=\{disabled \|\| cycleOnce\}/);
  assert.match(source, /cycleUnitOnce/);
  // 错误走 FormField 的行内 error，不弹 toast。
  assert.match(source, /<FormField/);
  // 字段错误只在行内显示，这个组件不引入 sonner。
  assert.doesNotMatch(source, /from "sonner"/);
});

test("both server dialogs submit the billing payload and map field errors", () => {
  for (const file of [
    "../pages/Servers.tsx",
    "../components/servers/ServerEditDialog.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /<BillingFields/, `${file} 缺少费用表单组`);
    assert.match(source, /billingPayload\(billing\)/, `${file} 未提交费用字段`);
    assert.match(source, /validateBillingForm\(billing\)/, `${file} 未做前端校验`);
    assert.match(source, /billingFieldForError/, `${file} 未映射后端字段错误`);
  }
  // 新建弹窗初值为空（不预填周期）；编辑以服务器真实值为准（billingFormFromServer）。
  const serversPage = read("../pages/Servers.tsx");
  assert.match(serversPage, /useState<ServerBillingForm>\(EMPTY_BILLING_FORM\)/);
  assert.doesNotMatch(serversPage, /DEFAULT_BILLING_FORM/);
  assert.match(
    read("../components/servers/ServerEditDialog.tsx"),
    /billingFormFromServer\(server\)/,
  );
});
