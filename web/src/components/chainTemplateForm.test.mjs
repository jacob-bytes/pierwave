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

/** 按源码出现顺序检查控件 id；字段顺序是这次需求的验收项。 */
function assertFieldOrder(source, ids, label) {
  const positions = ids.map((id) => {
    const index = source.indexOf(`id="${id}"`);
    assert.notEqual(index, -1, `${label} is missing #${id}`);
    return index;
  });
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, `${label} fields are out of order`);
}

test("user chain dialog orders template → entry port → target host → target port", () => {
  assertFieldOrder(
    read("components/me/MyChainFormDialog.tsx"),
    [
      "my-chain-template",
      "my-chain-entry-port",
      "my-chain-target-host",
      "my-chain-target-port",
    ],
    "MyChainFormDialog",
  );
});

test("admin template dialog uses the same field order", () => {
  assertFieldOrder(
    read("components/chains/ChainFromTemplateDialog.tsx"),
    [
      "chain-from-template",
      "chain-from-template-entry-port",
      "chain-from-template-target-host",
      "chain-from-template-target-port",
    ],
    "ChainFromTemplateDialog",
  );
});

test("entry port is optional in both forms", () => {
  for (const path of [
    "components/me/MyChainFormDialog.tsx",
    "components/chains/ChainFromTemplateDialog.tsx",
  ]) {
    const source = read(path);
    // 字段本身不标 required；留空由系统分配。
    assert.doesNotMatch(
      source,
      /label=\{t\("[^"]*entryPort"\)\}[\s\S]{0,120}required/,
      `${path} marks the entry port as required`,
    );
    assert.match(source, /entryPortPayload\(/, `${path} must omit an empty entry port`);
  }
});

test("the admin page offers both custom and template creation", () => {
  const source = read("pages/Chains.tsx");
  assert.match(source, /chains\.list\.add/);
  assert.match(source, /chains\.templateCreate\.fromTemplate/);
  assert.match(source, /FromTemplateButton/);
  assert.match(source, /requiresNewMaster/);
  assert.match(source, /templateUnsupported/);
});

test("the new copy exists in both languages", () => {
  for (const [locale, messages] of [
    ["zh-CN", zhCN],
    ["en", en],
  ]) {
    for (const key of [
      "me.chains.form.entryPort",
      "me.chains.form.entryPortRange",
      "me.chains.form.hopCount",
      "me.chains.form.hopCountOne",
      "chains.templateCreate.fromTemplate",
      "chains.templateCreate.requiresNewMaster",
      "chains.templateCreate.needsNewMaster",
      "chains.templateCreate.entryPort",
      "chains.templateCreate.sequence",
      "common.portAllowed",
      "errors.chain.entry_port_taken",
    ]) {
      // errors 是扁平 code 字典，点号不是嵌套层级。
      const value = key.startsWith("errors.")
        ? messages.errors[key.slice("errors.".length)]
        : lookup(messages, key);
      assert.equal(typeof value, "string", `${locale} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale} has an empty ${key}`);
    }
  }
});
