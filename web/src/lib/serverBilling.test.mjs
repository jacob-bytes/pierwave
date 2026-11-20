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
  parsePriceYuan,
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

test("validateBillingForm allows empty and partial values", () => {
  assert.deepEqual(validateBillingForm(EMPTY_BILLING_FORM), {});
  assert.deepEqual(
    validateBillingForm({
      paidUntil: "",
      price: "268",
      currency: "",
      cycle: "",
    }),
    {},
    "只填价格合法",
  );
  assert.deepEqual(
    validateBillingForm({
      paidUntil: "2026-12-31",
      price: "",
      currency: "",
      cycle: "",
    }),
    {},
    "只填到期合法",
  );
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

  // 0 元是有效价格，必须提交 0 而不是 null。
  assert.equal(
    billingPayload({ ...EMPTY_BILLING_FORM, price: "0" }).price_cents,
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
  for (const key of ["paidUntil", "price", "currency", "cycle"]) {
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

test("the four backend error codes are translated in both locales", () => {
  const codes = [
    "server.paid_until_invalid",
    "server.price_cents_invalid",
    "server.currency_invalid",
    "server.billing_cycle_invalid",
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

test("the shared billing form renders the four inputs and the public hint", () => {
  const source = read("../components/servers/BillingFields.tsx");
  assert.match(source, /type="date"/);
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
