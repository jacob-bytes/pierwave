import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../i18n/en.ts";
import zhCN from "../i18n/zh-CN.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function lookup(messages, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), messages);
}

test("chain form disables servers taken elsewhere but keeps them in the list", () => {
  const source = read("components/chains/ChainFormDialog.tsx");
  // 跨跳 / 同跳占用都走同一个纯函数；整条链的当前值实时传入。
  assert.match(source, /serverUsagesElsewhere\(\s*allGroups,/);
  assert.match(source, /allGroups=\{watchedGroups\}/);
  // 置灰而不是过滤：列表仍然遍历全部服务器。
  assert.match(source, /servers\.map\(\(server\) => \{/);
  assert.match(source, /disabled=\{Boolean\(usage\)\}/);
  // 原因后缀中英成对。
  assert.match(source, /chains\.form\.serverUsedInHop/);
  assert.match(source, /chains\.form\.serverUsedInMember/);
  // 当前成员自己选中的那台永远不被置灰（否则看不到当前值）。
  assert.match(source, /server\.id === currentServerId/);
});

test("template form passes unavailable servers into the multi-select", () => {
  const source = read("components/chains/ChainTemplateFormDialog.tsx");
  assert.match(source, /templateServerUsagesElsewhere\(/);
  assert.match(source, /unavailable=\{unavailable\}/);
  assert.match(source, /collectTemplateGroupIssues\(groups\)/);

  const field = read("components/servers/ServerMultiSelectField.tsx");
  // 置灰项保留在列表里；已选中的仍可取消勾选。
  assert.match(field, /disabled=\{disabled \|\| locked\}/);
  assert.match(field, /data-server-unavailable=\{locked/);
  assert.match(field, /const reason = checked \? undefined : unavailable\.get/);
});

test("the occupancy copy exists in both languages", () => {
  for (const [locale, messages] of [
    ["zh-CN", zhCN],
    ["en", en],
  ]) {
    for (const key of [
      "chains.form.serverUsedInHop",
      "chains.form.serverUsedInMember",
      "validation.chainMemberDuplicate",
      "validation.chainServerDuplicate",
      "validation.chainTemplateMemberDuplicate",
      "validation.chainTemplateServerDuplicate",
    ]) {
      const value = lookup(messages, key);
      assert.equal(typeof value, "string", `${locale} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale} has an empty ${key}`);
    }
  }
});
