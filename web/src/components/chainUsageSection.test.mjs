/**
 * 「转发用量」并入概览 → 链路时延的源码级回归测试。
 *
 * 覆盖验收里靠纯函数测不到的部分：
 * - 第三个子页 `usage` 的顺序与 i18n 键；
 * - 旧 `/forward-usage` 路由重定向到 `/?view=chain&section=usage`；
 * - 侧边栏不再有「转发用量」入口；
 * - 用量子页复用原页面的四态 / 窗口 / 用户筛选，且**不**传 server_ids、
 *   不显示服务器筛选生效的暗示（后端 `/api/v1/forward-traffic` 不支持）；
 * - 子页 tab 与链路筛选参数各写各的，互不覆盖。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

function exists(relative) {
  return existsSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)));
}

const app = read("App.tsx");
const shell = read("components/AppShell.tsx");
const tabs = read("components/overview/ChainSectionTabs.tsx");
const chainView = read("components/overview/ChainLatencyView.tsx");
const usage = read("components/overview/ChainUsageView.tsx");
const zh = read("i18n/zh-CN.ts");
const en = read("i18n/en.ts");

test("旧链接 /forward-usage 重定向到链路时延的用量子页", () => {
  assert.ok(!app.includes("pages/ForwardUsage"), "ForwardUsage page must be gone");
  assert.ok(
    !exists("pages/ForwardUsage.tsx"),
    "the standalone ForwardUsage page must be deleted",
  );
  const routeStart = app.indexOf('path="forward-usage"');
  assert.ok(routeStart >= 0, "legacy redirect route missing");
  const route = app.slice(routeStart, app.indexOf("/>", routeStart));
  assert.match(route, /<Navigate/);
  assert.match(route, /CHAIN_USAGE_URL/);
  assert.match(route, /replace/);
});

test("侧边栏不再有转发用量入口，双语文案也没有对应导航键", () => {
  assert.ok(!shell.includes('"/forward-usage"'));
  assert.ok(!shell.includes("nav.forwardUsage"));
  // 链路时延已经覆盖该入口：/chains 与 /chain-templates 仍在。
  assert.ok(shell.includes('"/chains"'));
  assert.ok(shell.includes('"/chain-templates"'));
  assert.ok(!zh.includes('forwardUsage: "转发用量"'));
  assert.ok(!en.includes('forwardUsage: "Forward usage"'));
});

test("第三个子页是 usage，顺序 chains → templates → usage", () => {
  const order = [...tabs.matchAll(/^\s{2}(chains|templates|usage):/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(order, ["chains", "templates", "usage"]);
  assert.match(tabs, /usage: "overview\.chainLatency\.sections\.usage"/);
  assert.match(zh, /usage: "转发用量"/);
  assert.match(en, /usage: "Usage"/);
});

test("链路时延切到 usage 渲染复用的用量视图", () => {
  assert.match(chainView, /section === "usage"/);
  assert.match(chainView, /<ChainUsageView/);
  assert.match(chainView, /data-chain-sections/);
});

test("用量子页保留窗口 / 用户筛选 / 四态，且不伪造服务器过滤", () => {
  // 注释里说明「后端没有 server_ids」是允许的；只检查真正的代码。
  const code = usage
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const forbidden = [
    "PageHeader",
    "server_ids",
    "serverIds",
    "selectedIds",
    "ScopeWarning",
    "scopeUnsupported",
  ];
  for (const pattern of forbidden) {
    assert.ok(!code.includes(pattern), `usage view must not use ${pattern}`);
  }
  assert.match(usage, /useForwardUsage\(days\)/);
  assert.match(usage, /FORWARD_USAGE_WINDOWS/);
  assert.match(usage, /filterUsageRows/);
  assert.match(usage, /forwardUsage\.emptyTitle/);
  assert.match(usage, /forwardUsage\.loadFailed/);
  assert.match(usage, /forwardUsage\.byForwardTitle/);
  assert.match(usage, /data-chain-usage/);
});
