import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOGS_TAB,
  LOGS_TAB_IDS,
  isLogsTabId,
  resolveLogsTab,
  logsTabParam,
} from "./logsTabs.ts";

test("LOGS_TAB_IDS keeps the documented order", () => {
  assert.deepEqual(LOGS_TAB_IDS, ["events", "audit"]);
  assert.equal(DEFAULT_LOGS_TAB, "events");
});

test("isLogsTabId only accepts known ids", () => {
  for (const id of LOGS_TAB_IDS) assert.equal(isLogsTabId(id), true);
  assert.equal(isLogsTabId("Events"), false);
  assert.equal(isLogsTabId(" events"), false);
  assert.equal(isLogsTabId("bogus"), false);
  assert.equal(isLogsTabId(""), false);
  assert.equal(isLogsTabId(null), false);
  assert.equal(isLogsTabId(undefined), false);
  // 原型链上的键不能被误判成合法 tab。
  assert.equal(isLogsTabId("toString"), false);
});

test("resolveLogsTab falls back to events for missing or illegal values", () => {
  assert.equal(resolveLogsTab("events"), "events");
  assert.equal(resolveLogsTab("audit"), "audit");
  assert.equal(resolveLogsTab(null), "events");
  assert.equal(resolveLogsTab(undefined), "events");
  assert.equal(resolveLogsTab(""), "events");
  assert.equal(resolveLogsTab("  "), "events");
  assert.equal(resolveLogsTab("nope"), "events");
  assert.equal(resolveLogsTab("Audit"), "events");
});

test("logsTabParam keeps an explicit tab= for both tabs", () => {
  // 与设置页不同：`/logs` 不带参数等价于 events，但两个 tab 都写显式参数，
  // 这样旧书签重定向后的 URL（?tab=events / ?tab=audit）保持稳定。
  assert.equal(logsTabParam("events"), "events");
  assert.equal(logsTabParam("audit"), "audit");
  // 从 URL 值到参数值再到解析值必须能往返。
  for (const id of LOGS_TAB_IDS) {
    const param = logsTabParam(id);
    assert.equal(resolveLogsTab(param), id);
  }
});
