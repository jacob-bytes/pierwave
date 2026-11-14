import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SUBSCRIPTION_FORMAT,
  SUBSCRIPTION_FORMAT_DESCRIPTIONS,
  SUBSCRIPTION_FORMATS,
  withSubscriptionFormat,
} from "./subscriptionFormats.ts";

// 浏览器里由 `window.location.origin` 补全相对路径；Node 测试用同样的形状。
globalThis.window = { location: { origin: "https://panel.example" } };

test("SUBSCRIPTION_FORMATS matches the backend exporter registry order", () => {
  assert.deepEqual(SUBSCRIPTION_FORMATS, [
    "clash",
    "mihomo",
    "stash",
    "surge",
    "egern",
    "surfboard",
    "loon",
    "qx",
    "singbox",
    "shadowrocket",
    "v2ray",
    "singbox-full",
    "surge-full",
  ]);
  assert.equal(DEFAULT_SUBSCRIPTION_FORMAT, "clash");
});

test("registry has 13 unique ids and egern builds a target URL", () => {
  assert.equal(SUBSCRIPTION_FORMATS.length, 13);
  assert.equal(
    new Set(SUBSCRIPTION_FORMATS).size,
    SUBSCRIPTION_FORMATS.length,
    "格式 id 不能重复",
  );
  // Egern 是 Surge 兼容输出：label 在 i18n，描述单独给一个 i18n 键。
  assert.equal(
    SUBSCRIPTION_FORMAT_DESCRIPTIONS.egern,
    "subscriptions.formatDescriptions.egern",
  );
  // mihomo 是完整配置，和 clash（片段式骨架）不同，下拉里需要一句区分。
  assert.equal(
    SUBSCRIPTION_FORMAT_DESCRIPTIONS.mihomo,
    "subscriptions.formatDescriptions.mihomo",
  );
  // 两个完整配置格式同样需要一句区分。
  assert.equal(
    SUBSCRIPTION_FORMAT_DESCRIPTIONS["singbox-full"],
    "subscriptions.formatDescriptions.singboxFull",
  );
  assert.equal(
    SUBSCRIPTION_FORMAT_DESCRIPTIONS["surge-full"],
    "subscriptions.formatDescriptions.surgeFull",
  );
  assert.equal(
    withSubscriptionFormat("https://panel.example/api/v1/sub/abc", "egern"),
    "https://panel.example/api/v1/sub/abc?target=egern",
  );
});

test("default format keeps the link clean", () => {
  const url = "https://panel.example/api/v1/sub/abc";
  assert.equal(withSubscriptionFormat(url, "clash"), url);
});

test("non-default formats append target and keep the existing query", () => {
  const url =
    "https://panel.example/api/v1/sub/abc?rule=tpl-1&target=surge";
  assert.equal(
    withSubscriptionFormat(url, "singbox"),
    "https://panel.example/api/v1/sub/abc?rule=tpl-1&target=singbox",
  );
});

test("relative links are resolved against the current origin", () => {
  assert.equal(
    withSubscriptionFormat("/api/v1/sub/abc", "v2ray"),
    "https://panel.example/api/v1/sub/abc?target=v2ray",
  );
});

test("an unparsable url is returned unchanged", () => {
  assert.equal(withSubscriptionFormat("", "uri"), "");
});
