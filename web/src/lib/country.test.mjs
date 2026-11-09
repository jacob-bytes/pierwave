import assert from "node:assert/strict";
import test from "node:test";
import {
  countryCodeToFlag,
  countryDisplayName,
  ISO_COUNTRY_CODES,
  isCountryCode,
  normalizeCountryCode,
} from "./country.ts";

test("whitelist holds the official 249 two-letter codes", () => {
  assert.equal(ISO_COUNTRY_CODES.length, 249);
  assert.ok(ISO_COUNTRY_CODES.every((code) => /^[A-Z]{2}$/.test(code)));
  assert.ok(ISO_COUNTRY_CODES.includes("CN"));
  assert.ok(!ISO_COUNTRY_CODES.includes("ZZ"), "ZZ 是用户分配代码，不在白名单");
  assert.ok(!ISO_COUNTRY_CODES.includes("XK"), "XK 不是官方分配代码");
});

test("countryCodeToFlag maps valid codes and normalizes case", () => {
  assert.equal(countryCodeToFlag("CN"), "🇨🇳");
  assert.equal(countryCodeToFlag(" us "), "🇺🇸", "前后空白与小写都要归一");
  assert.equal(countryCodeToFlag("JP"), "🇯🇵");
});

test("countryCodeToFlag returns null for empty and invalid codes", () => {
  assert.equal(countryCodeToFlag(""), null);
  assert.equal(countryCodeToFlag(null), null);
  assert.equal(countryCodeToFlag(undefined), null);
  assert.equal(countryCodeToFlag("C"), null);
  assert.equal(countryCodeToFlag("CHN"), null);
  assert.equal(countryCodeToFlag("1A"), null);
  assert.equal(countryCodeToFlag("ZZ"), null, "不存在的代码不能猜成某个国家");
  assert.equal(countryCodeToFlag("XK"), null);
});

test("isCountryCode and normalizeCountryCode agree with the whitelist", () => {
  assert.equal(isCountryCode("CN"), true);
  assert.equal(isCountryCode("zz"), false);
  assert.equal(isCountryCode(null), false);
  assert.equal(normalizeCountryCode(" jp "), "JP");
  assert.equal(normalizeCountryCode("ZZ"), null);
});

test("countryDisplayName localizes known codes and refuses invalid ones", () => {
  if (typeof Intl === "undefined" || !("DisplayNames" in Intl)) return;
  assert.equal(countryDisplayName("CN", "zh-CN"), "中国");
  assert.equal(countryDisplayName("CN", "en"), "China");
  assert.equal(countryDisplayName("ZZ", "en"), null);
});
