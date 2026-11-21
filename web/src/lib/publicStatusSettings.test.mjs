import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import {
  billingHidden,
  filterPublicServerChoices,
  flagSettingValue,
  publicVisibilitySummary,
  settingsFlag,
  sortPublicServerChoices,
  withBillingVisibility,
} from "./publicStatusSettings.ts";

const server = (id, name, publicVisible, online = true) => ({
  id,
  name,
  online,
  public_visible: publicVisible,
});

test("settingsFlag accepts 0/1 numbers, strings and booleans", () => {
  assert.equal(settingsFlag(1, false), true);
  assert.equal(settingsFlag(0, true), false);
  assert.equal(settingsFlag("1", false), true);
  assert.equal(settingsFlag("0", true), false);
  assert.equal(settingsFlag(" 1 ", false), true);
  assert.equal(settingsFlag(true, false), true);
  assert.equal(settingsFlag(false, true), false);
});

test("settingsFlag falls back for missing or unknown values", () => {
  // 缺失 / null / 空串 / 非法数字都不是开关：不能猜成开，也不能猜成关。
  for (const value of [undefined, null, "", "  ", 2, 9, "2", "true", "on", {}]) {
    assert.equal(settingsFlag(value, true), true);
    assert.equal(settingsFlag(value, false), false);
  }
});

test("flagSettingValue submits the documented 0/1 contract", () => {
  assert.equal(flagSettingValue(true), 1);
  assert.equal(flagSettingValue(false), 0);
});

test("publicVisibilitySummary counts only explicitly public nodes", () => {
  assert.deepEqual(
    publicVisibilitySummary([
      server("1", "香港-01", true),
      server("2", "香港-02", false),
      server("3", "东京-01", true),
    ]),
    { visible: 2, total: 3 },
  );
  assert.deepEqual(publicVisibilitySummary([]), { visible: 0, total: 0 });

  // 旧后端缺 public_visible 时不能把节点误算成公开。
  const legacy = [{ id: "1", name: "旧节点", online: true }];
  assert.deepEqual(
    publicVisibilitySummary(legacy),
    { visible: 0, total: 1 },
  );
});

test("sortPublicServerChoices sorts by name without mutating the input", () => {
  const input = [
    server("3", "香港-10", true),
    server("1", "香港-2", true),
    server("2", "Alpha", false),
  ];
  const sorted = sortPublicServerChoices(input);
  assert.deepEqual(
    sorted.map((item) => item.name),
    ["Alpha", "香港-2", "香港-10"],
  );
  // 原数组顺序不变，改的是副本。
  assert.deepEqual(
    input.map((item) => item.name),
    ["香港-10", "香港-2", "Alpha"],
  );
});

test("sortPublicServerChoices keeps equal names stable by id", () => {
  const sorted = sortPublicServerChoices([
    server("b", "同名", true),
    server("a", "同名", true),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["a", "b"],
  );
});

test("filterPublicServerChoices matches names case-insensitively", () => {
  const items = [
    server("1", "HongKong-01", true),
    server("2", "东京-01", false),
  ];
  assert.deepEqual(
    filterPublicServerChoices(items, "hongkong").map((item) => item.id),
    ["1"],
  );
  assert.deepEqual(
    filterPublicServerChoices(items, " 香港 ").map((item) => item.id),
    [],
  );
  assert.deepEqual(filterPublicServerChoices(items, "   "), items);
});

test("billingHidden only treats an explicit true as hidden", () => {
  assert.equal(billingHidden({ billing_hidden: true }), true);
  assert.equal(billingHidden({ billing_hidden: false }), false);
  // 旧后端不返回该字段、或返回 null：价格照常显示，不是「未公开」。
  assert.equal(billingHidden({}), false);
  assert.equal(billingHidden({ billing_hidden: null }), false);
});

test("withBillingVisibility merges the top-level flag into every server", () => {
  const status = {
    panel_name: "PierWave",
    generated_at: 1,
    summary: {},
    servers: [
      { id: "1", name: "a", billing_hidden: false },
      { id: "2", name: "b" },
    ],
    billing_hidden: true,
  };
  const merged = withBillingVisibility(status);
  assert.equal(merged.servers[0].billing_hidden, true);
  assert.equal(merged.servers[1].billing_hidden, true);
  // 入参不被修改，避免缓存里的旧响应被就地改写。
  assert.equal(status.servers[0].billing_hidden, false);
  assert.equal(status.servers[1].billing_hidden, undefined);

  // 顶层缺失 / false 时保留 per-server 契约：只隐藏被标记的那台。
  const perServer = {
    ...status,
    billing_hidden: undefined,
    servers: [
      { id: "1", name: "a", billing_hidden: true },
      { id: "2", name: "b", billing_hidden: false },
    ],
  };
  assert.equal(withBillingVisibility(perServer).servers[0].billing_hidden, true);
  assert.equal(withBillingVisibility(perServer).servers[1].billing_hidden, false);
  // 未隐藏时返回原对象，页面不会因为一次 map 产生新引用。
  assert.equal(withBillingVisibility(perServer), perServer);
});

test("new settings and billing copy exists in both locales", () => {
  assert.equal(zh.settings.publicStatus.title, "公开状态页");
  assert.equal(en.settings.publicStatus.title, "Public status page");
  assert.match(zh.settings.publicStatus.offWarning, /\/status 对所有人不可见/);
  assert.match(en.settings.publicStatus.offWarning, /not visible to anyone/);
  assert.match(
    zh.settings.publicStatus.whitelist.dialogDesc,
    /不会出现在公开页/,
  );
  assert.match(
    en.settings.publicStatus.whitelist.dialogDesc,
    /do not appear on the public page/,
  );
  assert.equal(
    zh.settings.publicStatus.whitelist.note,
    "未选中的节点不会出现在公开页，也不计入在线率。",
  );
  assert.match(en.settings.publicStatus.whitelist.note, /do not appear on the public page/);
  assert.match(zh.settings.publicStatus.billingNote, /未公开/);
  assert.match(en.settings.publicStatus.billingNote, /Not public/);
  assert.equal(zh.settings.publicStatus.whitelist.unsupported, "当前后端不支持该功能");
  assert.equal(zh.publicStatus.server.notPublic, "未公开");
  assert.equal(en.publicStatus.server.notPublic, "Not public");
});
