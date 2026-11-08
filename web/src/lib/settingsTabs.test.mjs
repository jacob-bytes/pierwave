import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TAB_IDS,
  isSettingsTabId,
  resolveSettingsTab,
  settingsTabParam,
} from "./settingsTabs.ts";

test("SETTINGS_TAB_IDS keeps the documented order", () => {
  assert.deepEqual(SETTINGS_TAB_IDS, [
    "general",
    "security",
    "alerts",
    "backup",
  ]);
  assert.equal(DEFAULT_SETTINGS_TAB, "general");
});

test("isSettingsTabId only accepts known ids", () => {
  for (const id of SETTINGS_TAB_IDS) assert.equal(isSettingsTabId(id), true);
  assert.equal(isSettingsTabId("General"), false);
  assert.equal(isSettingsTabId(" security"), false);
  assert.equal(isSettingsTabId("bogus"), false);
  assert.equal(isSettingsTabId(""), false);
  assert.equal(isSettingsTabId(null), false);
  assert.equal(isSettingsTabId(undefined), false);
  // 原型链上的键不能被误判成合法 tab。
  assert.equal(isSettingsTabId("toString"), false);
});

test("resolveSettingsTab falls back to the first tab for illegal values", () => {
  assert.equal(resolveSettingsTab("security"), "security");
  assert.equal(resolveSettingsTab("alerts"), "alerts");
  assert.equal(resolveSettingsTab("backup"), "backup");
  assert.equal(resolveSettingsTab(null), "general");
  assert.equal(resolveSettingsTab(undefined), "general");
  assert.equal(resolveSettingsTab(""), "general");
  assert.equal(resolveSettingsTab("  "), "general");
  assert.equal(resolveSettingsTab("nope"), "general");
  assert.equal(resolveSettingsTab("General"), "general");
});

test("settingsTabParam keeps the URL clean for the default tab", () => {
  assert.equal(settingsTabParam("general"), null);
  assert.equal(settingsTabParam("security"), "security");
  assert.equal(settingsTabParam("alerts"), "alerts");
  assert.equal(settingsTabParam("backup"), "backup");
  // 从 URL 值到参数值再到解析值必须能往返。
  for (const id of SETTINGS_TAB_IDS) {
    const param = settingsTabParam(id);
    assert.equal(resolveSettingsTab(param), id);
  }
});
