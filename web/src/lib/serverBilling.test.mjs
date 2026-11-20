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
  BILLING_NONE,
  billingFieldForError,
  billingFormFromServer,
  billingPayload,
  CURRENCY_CUSTOM,
  CURRENCY_NONE,
  currencySelectValue,
  EMPTY_BILLING_FORM,
  formatPriceYuan,
  hasAnyBillingField,
  isCurrencyCode,
  isIsoDate,
  isPaidUntilInRange,
  parsePriceYuan,
  PAID_UNTIL_MAX,
  PAID_UNTIL_MIN,
  PRICE_CENTS_MAX,
  sanitizeCurrencyInput,
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

test("billingFormFromServer backfills valid fields and drops dirty ones", () => {
  assert.deepEqual(
    billingFormFromServer({
      paid_until: "2026-12-31",
      price_cents: 4999,
      currency: "CNY",
      billing_cycle: "monthly",
    }),
    {
      paidUntil: "2026-12-31",
      price: "49.99",
      currency: "CNY",
      cycle: "monthly",
    },
  );

  // 旧后端整组缺失 / 未填写。
  assert.deepEqual(
    billingFormFromServer({
      paid_until: null,
      price_cents: null,
      currency: null,
      billing_cycle: null,
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
  });
  assert.deepEqual(dirty, {
    paidUntil: "",
    price: "",
    currency: "JPY",
    cycle: "",
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
    hasAnyBillingField({ paidUntil: " ", price: "", currency: "", cycle: "" }),
    false,
  );
  for (const filled of [
    { ...EMPTY_BILLING_FORM, paidUntil: "2026-12-31" },
    { ...EMPTY_BILLING_FORM, price: "0" },
    { ...EMPTY_BILLING_FORM, currency: "CNY" },
    { ...EMPTY_BILLING_FORM, cycle: "once" },
  ]) {
    assert.equal(hasAnyBillingField(filled), true, JSON.stringify(filled));
  }
});

test("validateBillingForm allows empty and independent fields", () => {
  assert.deepEqual(validateBillingForm(EMPTY_BILLING_FORM), {});
  assert.deepEqual(
    validateBillingForm({
      paidUntil: "2026-12-31",
      price: "",
      currency: "",
      cycle: "",
    }),
    {},
    "只填到期合法（与价格/币种独立）",
  );
  assert.deepEqual(
    validateBillingForm({
      paidUntil: "",
      price: "",
      currency: "",
      cycle: "yearly",
    }),
    {},
    "只填周期合法",
  );
  assert.deepEqual(
    validateBillingForm({
      paidUntil: "",
      price: "268",
      currency: "CNY",
      cycle: "",
    }),
    {},
    "价格与币种成对合法",
  );
});

test("validateBillingForm requires price and currency as a pair", () => {
  // 只填价格：错误落在缺的币种上。
  assert.deepEqual(
    validateBillingForm({
      paidUntil: "",
      price: "268",
      currency: "",
      cycle: "",
    }),
    { currency: "servers.billing.errors.currencyPair" },
  );
  // 只填币种：错误落在缺的价格上。
  assert.deepEqual(
    validateBillingForm({
      paidUntil: "",
      price: "",
      currency: "CNY",
      cycle: "",
    }),
    { price_cents: "servers.billing.errors.pricePair" },
  );
  // 两边都空 / 两边都有：通过。
  assert.deepEqual(
    validateBillingForm({
      paidUntil: "2026-12-31",
      price: "",
      currency: "",
      cycle: "once",
    }),
    {},
  );
  // 价格本身非法时只报格式，不叠加「缺币种」，避免同一字段两条信息。
  assert.deepEqual(
    validateBillingForm({
      paidUntil: "",
      price: "abc",
      currency: "",
      cycle: "",
    }),
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
      validateBillingForm({
        paidUntil: date,
        price: "",
        currency: "",
        cycle: "",
      }),
      { paid_until: "servers.billing.errors.paidUntil" },
      date,
    );
  }
  // 边界日期本身合法。
  for (const date of [PAID_UNTIL_MIN, PAID_UNTIL_MAX]) {
    assert.deepEqual(
      validateBillingForm({
        paidUntil: date,
        price: "",
        currency: "",
        cycle: "",
      }),
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
    cycle: "weekly",
  });
  assert.equal(errors.paid_until, "servers.billing.errors.paidUntil");
  assert.equal(errors.price_cents, "servers.billing.errors.price");
  assert.equal(errors.currency, "servers.billing.errors.currency");
  assert.equal(errors.billing_cycle, "servers.billing.errors.cycle");

  assert.equal(
    validateBillingForm({ ...EMPTY_BILLING_FORM, price: "10000000" })
      .price_cents,
    "servers.billing.errors.price",
  );
});

test("translateBillingErrors turns validation keys into final copy once", () => {
  const translated = translateBillingErrors(
    validateBillingForm({
      paidUntil: "2026-02-30",
      price: "1.234",
      currency: "cny",
      cycle: "weekly",
    }),
    (key) => `T:${key}`,
  );
  assert.deepEqual(translated, {
    paid_until: "T:servers.billing.errors.paidUntil",
    price_cents: "T:servers.billing.errors.price",
    currency: "T:servers.billing.errors.currency",
    billing_cycle: "T:servers.billing.errors.cycle",
  });
  assert.deepEqual(translateBillingErrors({}, String), {});
});

test("billingPayload always sends four explicit values, empty = null", () => {
  assert.deepEqual(billingPayload(EMPTY_BILLING_FORM), {
    paid_until: null,
    price_cents: null,
    currency: null,
    billing_cycle: null,
  });

  assert.deepEqual(
    billingPayload({
      paidUntil: "2026-12-31",
      price: "49.99",
      currency: "cny",
      cycle: "yearly",
    }),
    {
      paid_until: "2026-12-31",
      price_cents: 4999,
      currency: "CNY",
      billing_cycle: "yearly",
    },
  );

  // 0 元是有效价格，必须提交 0 而不是 null（需与币种成对）。
  assert.equal(
    billingPayload({ ...EMPTY_BILLING_FORM, price: "0", currency: "CNY" })
      .price_cents,
    0,
  );

  // 未通过前端校验的值一律不提交脏数据。
  assert.deepEqual(
    billingPayload({
      paidUntil: "2026-02-30",
      price: "-1",
      currency: "CNY1",
      cycle: "weekly",
    }),
    {
      paid_until: null,
      price_cents: null,
      currency: null,
      billing_cycle: null,
    },
  );
});

test("billingPayload never submits a half price/currency pair", () => {
  // 只填价格 / 只填币种：整对清空（要么都清，要么都不清）。
  assert.deepEqual(
    billingPayload({
      paidUntil: "",
      price: "268",
      currency: "",
      cycle: "",
    }),
    {
      paid_until: null,
      price_cents: null,
      currency: null,
      billing_cycle: null,
    },
  );
  assert.deepEqual(
    billingPayload({
      paidUntil: "",
      price: "",
      currency: "CNY",
      cycle: "",
    }),
    {
      paid_until: null,
      price_cents: null,
      currency: null,
      billing_cycle: null,
    },
  );
  // 成对时两个都保留。
  assert.deepEqual(
    billingPayload({
      paidUntil: "",
      price: "0",
      currency: "eur",
      cycle: "",
    }),
    {
      paid_until: null,
      price_cents: 0,
      currency: "EUR",
      billing_cycle: null,
    },
  );
});

test("billingPayload drops a date outside the allowed year range", () => {
  assert.equal(
    billingPayload({ ...EMPTY_BILLING_FORM, paidUntil: "1969-12-31" })
      .paid_until,
    null,
  );
  assert.equal(
    billingPayload({ ...EMPTY_BILLING_FORM, paidUntil: "2101-01-01" })
      .paid_until,
    null,
  );
  assert.equal(
    billingPayload({ ...EMPTY_BILLING_FORM, paidUntil: PAID_UNTIL_MAX })
      .paid_until,
    PAID_UNTIL_MAX,
  );
});

test("billingFieldForError maps the four backend codes to form fields", () => {
  const cases = {
    "server.paid_until_invalid": "paid_until",
    "server.price_cents_invalid": "price_cents",
    "server.currency_invalid": "currency",
    "server.billing_cycle_invalid": "billing_cycle",
  };
  for (const [code, field] of Object.entries(cases)) {
    assert.equal(
      billingFieldForError(new ApiError("bad", 400, code)),
      field,
      code,
    );
  }

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
  // 缺参数时默认落到币种（价格已填的形状更常见）。
  assert.equal(
    billingFieldForError(
      new ApiError("bad", 400, "server.billing_pair_incomplete"),
    ),
    "currency",
  );

  // 旧后端只有 params.field：能对上就落字段。
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

test("billing constants match the backend contract", () => {
  assert.deepEqual(BILLING_CYCLES, ["monthly", "yearly", "once"]);
  assert.equal(PRICE_CENTS_MAX, 999_999_999);
  assert.equal(BILLING_NONE, "none");
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
    "cycleMonthly",
    "cycleYearly",
    "cycleOnce",
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

test("the shared billing form renders the four inputs and the public hint", () => {
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
});
