import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";

/**
 * 术语回归：宿主 = 服务器，Xray 入站 = 节点，管理端 = 转发链 / 链模板，
 * 用户端 = 我的转发链 / 新建转发链；拓扑仍叫「链路拓扑」。
 * 这些是跨页面一致性要求，散落在两份词典里，单独立一条用例守住。
 */
test("host is a server, not a node, on status and overview", () => {
  assert.equal(zh.publicStatus.summary.busiest, "最忙服务器");
  assert.equal(zh.publicStatus.summary.busiestHint, "无在线服务器");
  assert.equal(zh.publicStatus.groups.all, "全部服务器");
  assert.equal(zh.publicStatus.groups.emptyFilteredTitle, "该分组暂无服务器");

  assert.equal(en.publicStatus.summary.busiest, "Busiest server");
  assert.equal(en.publicStatus.summary.busiestHint, "No server online");
  assert.equal(en.publicStatus.groups.all, "All servers");
  assert.equal(en.publicStatus.groups.emptyFilteredTitle, "No servers in this group");
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
