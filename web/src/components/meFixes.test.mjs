import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import zh from "../i18n/zh-CN.ts";
import en from "../i18n/en.ts";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

function hasKey(dict, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), dict);
}

// ---------------------------------------------------------------------------
// U1：两张卡片共用同一套新建状态机，徽章带单位且不会出现 `N / 0`
// ---------------------------------------------------------------------------
test("MyForwardsCard drives the list, badge and button from createGate", () => {
  const source = read("components/me/MyForwardsCard.tsx");
  assert.match(source, /createGate\(\{/);
  assert.match(source, /itemCount: items\.length/);
  assert.match(source, /availableCount,/);
  assert.match(source, /forwardServersReason\(summary\.forward_servers_reason\)/);
  assert.match(source, /quotaValue/);
  assert.match(source, /quotaStock/);
  assert.match(source, /aria-describedby=/);
  assert.match(source, /CREATE_REASON_ID/);
  // 旧的硬编码 `used / limit` 徽章必须消失。
  assert.equal(source.includes("{quota.used} / {quota.limit}"), false);
  assert.equal(source.includes("state === \"none\" ? null"), false);
});

test("MyChainsCard shares the same create gate instead of a second rule set", () => {
  const source = read("components/me/MyChainsCard.tsx");
  assert.match(source, /createGate\(\{/);
  assert.match(source, /availableCount: templateCount/);
  assert.match(source, /quotaValue/);
  assert.match(source, /quotaStock/);
  assert.equal(source.includes("{quota.used} / {quota.limit}"), false);
  // 模板数量未知（加载中）时不能误报「没有可用模板」。
  assert.match(source, /templates\.isPending \? null : availableTemplates\.length/);
});

test("both quota cards stack their header actions below sm", () => {
  for (const file of [
    "components/me/MyForwardsCard.tsx",
    "components/me/MyChainsCard.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /<CardHeader className="card-header-stack">/);
  }
  // 覆盖规则必须在 @layer 之外，才能压过 CardHeader 的 grid 工具类。
  const css = read("index.css");
  assert.match(css, /@media \(max-width: 39\.999rem\) \{/);
  assert.match(css, /\.card-header-stack \{/);
  assert.match(css, /display: flex;/);
});

// ---------------------------------------------------------------------------
// U2：英文 390 页头刷新右对齐 + 分页条复用 ScrollFade
// ---------------------------------------------------------------------------
test("MeShell keeps refresh right-aligned and wraps tabs in ScrollFade", () => {
  const source = read("components/me/MeShell.tsx");
  assert.match(source, /className="ml-auto shrink-0"/);
  assert.match(source, /<ScrollFade>/);
  assert.match(source, /<\/ScrollFade>/);
  assert.match(source, /import \{ ListError, ScrollFade \}/);
});

// ---------------------------------------------------------------------------
// U3：未知与 0 分开
// ---------------------------------------------------------------------------
test("/me overview gates today, daily average and total on real samples", () => {
  const source = read("pages/me/Overview.tsx");
  assert.match(source, /hasTrafficSamples\(traffic\.data\?\.days\)/);
  assert.match(source, /trafficWindowTotal\(traffic\.data\?\.days\)/);
  assert.match(source, /t\("me\.noSamples"\)/);
  const chart = read("components/overview/TrafficChart.tsx");
  // 无采样时图例不再出现「累计 0 B」。
  assert.match(chart, /cumulative > 0/);
});

// ---------------------------------------------------------------------------
// U4：焦点不变（已有 --focus-ring），卡标题 h2 / skip link / 侧栏 nav 标签
// ---------------------------------------------------------------------------
test("CardTitle renders an h2 heading", () => {
  const source = read("components/ui/card.tsx");
  assert.match(source, /function CardTitle\([^)]*React\.ComponentProps<"h2">/);
  assert.match(source, /<h2/);
});

test("AppShell provides a skip link, labels the sidebar nav and marks main", () => {
  const source = read("components/AppShell.tsx");
  assert.match(source, /href="#main-content"/);
  assert.match(source, /id="main-content"/);
  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /aria-label=\{t\("app\.mainNav"\)\}/);
  assert.match(source, /app\.skipToContent/);
});

test("focus ring stays an opaque 2px outline using the dedicated token", () => {
  const css = read("index.css");
  assert.match(css, /outline: 2px solid var\(--focus-ring\)/);
  assert.match(css, /--focus-ring: oklch\(0\.74 0\.16 264\.6\)/);
  assert.match(css, /--focus-ring: oklch\(0\.42 0\.2 265\.6\)/);
});

// ---------------------------------------------------------------------------
// U5：触控尺寸
// ---------------------------------------------------------------------------
test("forward switches expand their hit area and the format select is 40px", () => {
  const forwards = read("components/me/MyForwardsCard.tsx");
  assert.equal(
    (forwards.match(/after:-inset-x-3\.5 after:-inset-y-3\.5/g) ?? []).length,
    2,
  );
  const subscription = read("pages/me/Subscription.tsx");
  assert.match(subscription, /className="h-10! w-\[150px\] text-xs"/);
});

// ---------------------------------------------------------------------------
// U6：空态与数量单位
// ---------------------------------------------------------------------------
test("packages page keeps one page-level empty state", () => {
  const source = read("pages/me/Packages.tsx");
  // 无任何套餐时只渲染页面级空态；历史与事件区都不出现。
  assert.match(source, /hasInstances \? \(/);
  assert.match(source, /<EventsCard events=\{events\} \/>/);
  assert.match(source, /useMeEvents\(hasInstances \? EVENTS_LIMIT : 0\)/);
  // 有套餐但历史为空时，历史区只给一行提示，不再用大空态。
  assert.match(source, /historyEmptyLine/);
  assert.equal(source.includes("history.length > 0 ? ("), true);
  assert.match(source, /packagesValueOne/);
});

test("node empty state distinguishes active package with zero nodes", () => {
  const source = read("pages/me/Subscription.tsx");
  assert.match(source, /const noPackage = summary\.usage\.status === "none"/);
  assert.match(source, /me\.nodes\.emptyActive/);
  assert.match(source, /me\.nodes\.emptyActiveDesc/);
  // 新后端字段 nodes_unavailable：缺失时按 0 处理，存在时单独说明。
  assert.match(source, /summary\.nodes_unavailable/);
  assert.match(source, /me\.nodes\.unavailableCount/);
});

test("forward_servers_reason is consumed with a servers.length fallback", () => {
  const source = read("components/me/MyForwardsCard.tsx");
  assert.match(source, /forwardServersReason\(summary\.forward_servers_reason\)/);
  assert.match(source, /serversReason === "no-limit" \? 0 : servers\.length/);
  const api = read("lib/api.ts");
  assert.match(api, /nodes_unavailable\?: number \| null/);
  assert.match(api, /forward_limit\?: number \| null/);
  assert.match(api, /forward_servers_reason\?: string \| null/);
});

// ---------------------------------------------------------------------------
// i18n：新增键必须中英成对，英文带单位
// ---------------------------------------------------------------------------
test("new i18n keys exist in both dictionaries", () => {
  const keys = [
    "app.skipToContent",
    "app.mainNav",
    "me.noSamples",
    "me.packagesValueOne",
    "me.forwards.quotaValue",
    "me.forwards.quotaStock",
    "me.forwards.stockTitle",
    "me.forwards.noServersTitle",
    "me.forwards.noServersDesc",
    "me.chains.quotaValue",
    "me.chains.quotaStock",
    "me.chains.stockTitle",
    "me.nodes.emptyActive",
    "me.nodes.emptyActiveDesc",
    "me.nodes.unavailableCount",
    "me.nodes.unavailableCountOne",
  ];
  for (const key of keys) {
    assert.equal(typeof hasKey(zh, key), "string", `zh missing ${key}`);
    assert.equal(typeof hasKey(en, key), "string", `en missing ${key}`);
  }
  assert.match(hasKey(zh, "me.forwards.quotaValue"), /条/);
  assert.match(hasKey(en, "me.forwards.quotaValue"), /of/);
  assert.match(hasKey(en, "me.packagesValueOne"), /package/);
  assert.match(hasKey(en, "me.packagesValue"), /packages/);
  assert.match(hasKey(zh, "me.forwards.quotaStock"), /存量/);
});

test("repeated own-data claims and chain-template wording are cleaned up", () => {
  // 「这里只显示你自己的数据」只在页头保留 1 处。
  assert.equal(typeof hasKey(zh, "me.onlyOwnData"), "string");
  assert.equal(hasKey(zh, "me.events.desc"), undefined);
  assert.equal(hasKey(zh, "me.subscription.desc"), undefined);
  assert.equal(hasKey(en, "me.events.desc"), undefined);
  assert.equal(hasKey(en, "me.subscription.desc"), undefined);
  assert.equal(hasKey(zh, "me.traffic.desc").includes("你自己的"), false);
  assert.equal(hasKey(zh, "me.nodes.desc").includes("你自己的"), false);
  // 链空态统一叫「转发链模板」。
  assert.match(hasKey(zh, "me.chains.noTemplateTitle"), /转发链模板/);
  assert.match(hasKey(zh, "me.chains.emptyDesc"), /转发链模板/);
  assert.match(hasKey(en, "me.chains.noTemplateTitle"), /forward chain templates/i);
});
