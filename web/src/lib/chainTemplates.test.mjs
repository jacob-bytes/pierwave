import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../i18n/en.ts";
import zhCN from "../i18n/zh-CN.ts";

function lookup(messages, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), messages);
}

function leafKeys(node, prefix = "chainTemplates") {
  if (typeof node === "string") return [prefix];
  if (node === null || typeof node !== "object") return [];
  return Object.keys(node).flatMap((key) => leafKeys(node[key], `${prefix}.${key}`));
}

/**
 * 页面上引用的键必须真正挂在顶层 `chainTemplates` 下。
 *
 * 之前这个区块被误放进 `outbounds`，`lookup` 拿到 undefined，`t()` 兜底成
 * 裸键名（`chainTemplates.title`）。这个测试直接扫源码里的 `t("chainTemplates.*")`。
 */
function referencedKeys() {
  const sources = [
    new URL("../pages/ChainTemplates.tsx", import.meta.url),
    new URL("../components/chains/ChainTemplateFormDialog.tsx", import.meta.url),
  ].map((url) => readFileSync(url, "utf8"));
  const keys = new Set();
  const pattern = /["'](chainTemplates\.[A-Za-z0-9_.]+)["']/g;
  for (const source of sources) {
    for (const match of source.matchAll(pattern)) keys.add(match[1]);
  }
  return [...keys].sort();
}

test("chainTemplates keys resolve to real strings in both languages", () => {
  const keys = referencedKeys();
  assert.ok(keys.length > 20, `expected the page to reference many keys, got ${keys.length}`);
  for (const locale of [
    ["zh-CN", zhCN],
    ["en", en],
  ]) {
    const [name, messages] = locale;
    for (const key of keys) {
      const value = lookup(messages, key);
      assert.equal(typeof value, "string", `${name} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${name} has an empty ${key}`);
    }
  }
});

test("chainTemplates is a top-level dictionary, not nested under outbounds", () => {
  assert.equal(typeof zhCN.chainTemplates, "object");
  assert.equal(typeof en.chainTemplates, "object");
  assert.equal(zhCN.outbounds.chainTemplates, undefined);
  assert.equal(en.outbounds.chainTemplates, undefined);
});

test("both languages expose exactly the same chainTemplates key set", () => {
  assert.deepEqual(leafKeys(zhCN.chainTemplates).sort(), leafKeys(en.chainTemplates).sort());
});
