import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SUBSCRIPTION_FORMAT,
  SUBSCRIPTION_FORMATS,
  withSubscriptionFormat,
} from "./subscriptionFormats.ts";

// 浏览器里由 `window.location.origin` 补全相对路径；Node 测试用同样的形状。
globalThis.window = { location: { origin: "https://panel.example" } };

test("SUBSCRIPTION_FORMATS matches the backend exporter registry order", () => {
  assert.deepEqual(SUBSCRIPTION_FORMATS, [
    "clash",
    "stash",
    "surge",
    "surfboard",
    "loon",
    "qx",
    "singbox",
    "shadowrocket",
    "v2ray",
  ]);
  assert.equal(DEFAULT_SUBSCRIPTION_FORMAT, "clash");
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
