import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zhCN from "../i18n/zh-CN.ts";
import {
  effectivePort,
  isValidPublicPortInput,
  parsePublicPortInput,
  portPairLabel,
} from "./publicPort.ts";

function lookup(messages, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), messages);
}

test("effectivePort prefers a valid public port and falls back to the listen port", () => {
  assert.equal(effectivePort(443, 40001), 40001);
  assert.equal(effectivePort(443, null), 443);
  assert.equal(effectivePort(443, undefined), 443);
  // 与本机监听端口相同的显式值仍然算「有效」，只是展示上不会重复。
  assert.equal(effectivePort(443, 443), 443);
});

test("effectivePort rejects dirty public ports instead of leaking them", () => {
  for (const invalid of [0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      effectivePort(443, invalid),
      443,
      `非法对外端口 ${invalid} 必须回落到监听端口`,
    );
  }
});

test("portPairLabel shows 内 → 外 only when the two ports differ", () => {
  assert.equal(portPairLabel(443, 40001), "443 → 40001");
  assert.equal(portPairLabel(443, null), "443");
  assert.equal(portPairLabel(443, undefined), "443");
  assert.equal(portPairLabel(443, 443), "443", "相同端口不显示箭头");
  assert.equal(portPairLabel(443, 0), "443", "脏值按未设置处理");
});

test("isValidPublicPortInput accepts empty and 1..65535 only", () => {
  for (const ok of ["", "   ", "1", "443", "65535"]) {
    assert.equal(isValidPublicPortInput(ok), true, `${JSON.stringify(ok)} 应合法`);
  }
  for (const bad of ["0", "-1", "65536", "1.5", "abc", "443a", "1e3"]) {
    assert.equal(isValidPublicPortInput(bad), false, `${JSON.stringify(bad)} 应非法`);
  }
});

test("parsePublicPortInput maps empty to null and keeps integer ports", () => {
  assert.equal(parsePublicPortInput(""), null);
  assert.equal(parsePublicPortInput("   "), null);
  assert.equal(parsePublicPortInput("40001"), 40001);
  assert.equal(parsePublicPortInput(" 443 "), 443);
  assert.equal(parsePublicPortInput("0"), undefined);
  assert.equal(parsePublicPortInput("65536"), undefined);
  assert.equal(parsePublicPortInput("x"), undefined);
});

test("public port i18n keys exist in both languages", () => {
  for (const key of [
    "nodes.form.publicPort",
    "nodes.form.publicPortPlaceholder",
    "nodes.form.publicPortHint",
    "nodes.portPairTitle",
    "chains.list.portPairHint",
  ]) {
    assert.equal(typeof lookup(zhCN, key), "string", `zh-CN 缺少 ${key}`);
    assert.equal(typeof lookup(en, key), "string", `en 缺少 ${key}`);
  }
  // 错误词典按扁平点号键存放（与 errors.ts 的查表方式一致）。
  for (const key of [
    "node.public_port_invalid",
    "node.public_port_conflict",
    "chain.public_port_invalid",
  ]) {
    assert.equal(typeof zhCN.errors[key], "string", `zh-CN 缺少 errors.${key}`);
    assert.equal(typeof en.errors[key], "string", `en 缺少 errors.${key}`);
  }
});
