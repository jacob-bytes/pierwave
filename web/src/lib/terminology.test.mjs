import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";

/**
 * 术语回归：公开探针页把主机称为「节点」（刻意不同于管理端的「服务器」），
 * Xray 入站 = 节点，管理端 = 转发链 / 链模板，用户端 = 我的转发链 / 新建转发链；
 * 拓扑仍叫「链路拓扑」。这些是跨页面一致性要求，散落在两份词典里，单独立用例守住。
 */
test("public status calls hosts nodes, deliberately unlike the admin server term", () => {
  assert.equal(zh.publicStatus.groups.title, "节点分组");
  assert.equal(zh.publicStatus.groups.all, "全部节点");
  assert.equal(zh.publicStatus.groups.emptyFilteredTitle, "该分组暂无节点");
  assert.equal(zh.publicStatus.summary.busiest, "最忙节点");
  assert.equal(zh.publicStatus.summary.busiestHint, "无在线节点");

  assert.equal(en.publicStatus.groups.title, "Node groups");
  assert.equal(en.publicStatus.groups.all, "All nodes");
  assert.equal(en.publicStatus.groups.emptyFilteredTitle, "No nodes in this group");
  assert.equal(en.publicStatus.summary.busiest, "Busiest node");
  assert.equal(en.publicStatus.summary.busiestHint, "No node online");
});

/** 收集一个词条对象里的所有用户可见字符串（键名不算）。 */
function values(node) {
  if (typeof node === "string") return [node];
  if (node === null || typeof node !== "object") return [];
  return Object.values(node).flatMap(values);
}

test("the public status page never mixes servers and nodes", () => {
  // 访客页面统一用「节点」：连「全部 {n} 台服务器在线」这类句子也改成不含名词。
  assert.deepEqual(
    values(zh.publicStatus).filter((text) => text.includes("服务器")),
    [],
  );
  assert.deepEqual(
    values(en.publicStatus).filter((text) => /\bservers?\b/i.test(text)),
    [],
  );
});

test("group buttons keep the count in aria-label only", () => {
  // 可见分组标签只有名称；数量由 aria-label 承载，屏幕阅读器不丢信息。
  assert.equal(zh.publicStatus.groups.countAria, "{name}，{count} 台");
  assert.equal(en.publicStatus.groups.countAria, "{name}, {count} nodes");
  assert.equal(en.publicStatus.groups.countAriaOne, "{name}, {count} node");
});

test("admin forward-chain terms are consistent in both locales", () => {
  assert.equal(zh.overview.chainHealth, "转发链健康");
  assert.equal(zh.overview.degradedChains, "降级转发链");
  assert.equal(en.overview.chainHealth, "Forward chain health");
  assert.equal(en.overview.degradedChains, "Degraded forward chains");

  assert.match(zh.chainTemplates.delete.desc, /已创建的转发链/);
  assert.match(en.chainTemplates.delete.desc, /existing forward chains/);
  assert.match(zh.chains.form.groups, /转发链/);
});

test("user self-service calls them forward chains", () => {
  assert.equal(zh.me.chains.title, "我的转发链");
  assert.equal(zh.me.chains.add, "新建转发链");
  assert.equal(zh.me.chains.emptyTitle, "还没有转发链");
  assert.match(zh.me.chains.removeAria, /删除转发链/);

  assert.equal(en.me.chains.title, "My forward chains");
  assert.equal(en.me.chains.add, "New forward chain");
  assert.equal(en.me.chains.emptyTitle, "No forward chains yet");
  assert.match(en.me.chains.removeAria, /Delete forward chain/);
});

test("topology keeps the chain-topology name", () => {
  assert.equal(zh.chains.detail.title, "链路拓扑");
  assert.equal(en.chains.detail.title, "Chain topology");
  assert.match(zh.chains.list.expandAria, /链路拓扑/);
  assert.match(en.chains.list.expandAria, /topology/);
});
