import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatUpdatedClock,
  forwardChainsKpiLink,
  forwardChainsKpiTone,
  kpiToneIconClass,
  kpiToneTextClass,
  onlineServersKpiLink,
  onlineServersKpiTone,
  todayTrafficKpiLink,
  usersKpiLink,
} from "./overviewKpiLinks.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERVIEW = readFileSync(
  path.resolve(HERE, "../pages/Overview.tsx"),
  "utf8",
);
const ZH = readFileSync(path.resolve(HERE, "../i18n/zh-CN.ts"), "utf8");
const EN = readFileSync(path.resolve(HERE, "../i18n/en.ts"), "utf8");

/** `?...` 留在概览页；`/...` 才是离开概览的绝对路径。 */
function assertRelativeSearch(link) {
  assert.match(link, /^\?/, `${link} 应该是相对搜索串`);
  assert.doesNotMatch(link, /^\//);
}

function assertAbsolutePath(link) {
  assert.match(link, /^\//, `${link} 应该是绝对路径`);
  assert.doesNotMatch(link, /^\?/);
}

test("在线服务器卡：有离线去异常服务器，全部在线回概览服务器视图", () => {
  assert.equal(onlineServersKpiLink(0), "?view=server");
  assertRelativeSearch(onlineServersKpiLink(0));

  assert.equal(onlineServersKpiLink(1), "/servers?only=abnormal");
  assert.equal(onlineServersKpiLink(12), "/servers?only=abnormal");
  assertAbsolutePath(onlineServersKpiLink(1));

  // 异常计数不可能是负数，按 0 处理，避免脏数据把用户带离概览。
  assert.equal(onlineServersKpiLink(-1), "?view=server");
});

test("转发链卡：阻断 > 降级 > 默认列表，0 值不带 status", () => {
  assert.equal(
    forwardChainsKpiLink(2, 3),
    "?view=chain&section=chains&status=blocked",
  );
  assertRelativeSearch(forwardChainsKpiLink(2, 3));

  assert.equal(
    forwardChainsKpiLink(0, 3),
    "?view=chain&section=chains&status=degraded",
  );
  assertRelativeSearch(forwardChainsKpiLink(0, 3));

  assert.equal(
    forwardChainsKpiLink(0, 0),
    "?view=chain&section=chains",
  );
  assertRelativeSearch(forwardChainsKpiLink(0, 0));

  // 只有阻断时也不带降级参数；两者都为 0 时不残留 status / 其它筛选。
  assert.equal(
    forwardChainsKpiLink(1, 0),
    "?view=chain&section=chains&status=blocked",
  );
  assert.equal(
    forwardChainsKpiLink(-1, -1),
    "?view=chain&section=chains",
  );
});

test("今日流量 / 用户与套餐卡：相对搜索与绝对路径", () => {
  assert.equal(todayTrafficKpiLink(), "?view=traffic");
  assertRelativeSearch(todayTrafficKpiLink());

  assert.equal(usersKpiLink(), "/users");
  assertAbsolutePath(usersKpiLink());
});

test("在线服务器卡：0 台离线保持中性，有离线才是 destructive", () => {
  assert.equal(onlineServersKpiTone(0), "neutral");
  assert.equal(onlineServersKpiTone(3), "destructive");
  assert.equal(onlineServersKpiTone(-2), "neutral");
});

test("转发链卡：阻断 destructive、仅降级 warning、0 值中性", () => {
  assert.equal(forwardChainsKpiTone(0, 0), "neutral");
  assert.equal(forwardChainsKpiTone(1, 0), "destructive");
  assert.equal(forwardChainsKpiTone(0, 1), "warning");
  assert.equal(forwardChainsKpiTone(3, 2), "destructive");
  assert.equal(forwardChainsKpiTone(-1, -1), "neutral");
});

test("语义色只用 token：异常数字 destructive / warning，0 值 muted", () => {
  assert.equal(kpiToneTextClass("neutral"), "text-muted-foreground");
  assert.match(kpiToneTextClass("warning"), /\btext-warning\b/);
  assert.match(kpiToneTextClass("destructive"), /\btext-destructive\b/);
  assert.doesNotMatch(kpiToneTextClass("neutral"), /warning|destructive/);

  // 图标块无异常时必须是中性 muted 背景，不能沿用强调色 primary。
  assert.match(kpiToneIconClass("neutral"), /\bbg-muted\b/);
  assert.match(kpiToneIconClass("neutral"), /\btext-muted-foreground\b/);
  assert.doesNotMatch(kpiToneIconClass("neutral"), /primary|warning|destructive/);

  assert.match(kpiToneIconClass("warning"), /\bbg-warning\/10\b/);
  assert.match(kpiToneIconClass("warning"), /\btext-warning\b/);
  assert.match(kpiToneIconClass("destructive"), /\bbg-destructive\/10\b/);
  assert.match(kpiToneIconClass("destructive"), /\btext-destructive\b/);
});

test("更新时间格式固定为 24 小时制 HH:MM", () => {
  assert.equal(formatUpdatedClock(0), "—");
  assert.equal(formatUpdatedClock(Number.NaN), "—");
  assert.equal(formatUpdatedClock(Number.POSITIVE_INFINITY), "—");

  const utcMorning = Date.UTC(2026, 0, 2, 8, 5);
  assert.equal(formatUpdatedClock(utcMorning, "en-GB", "UTC"), "08:05");
  assert.equal(formatUpdatedClock(utcMorning, "zh-CN", "UTC"), "08:05");
  assert.equal(
    formatUpdatedClock(Date.UTC(2026, 0, 2, 0, 0), "en-GB", "UTC"),
    "00:00",
  );
  // 不传时区 = 浏览器本地时区；用本地构造的时间验证同一时刻。
  assert.equal(
    formatUpdatedClock(new Date(2026, 0, 2, 8, 5).getTime(), "en-GB"),
    "08:05",
  );
});

test("概览页刷新按钮：aria-busy + 重入保护，不再 disabled", () => {
  assert.match(OVERVIEW, /aria-busy=\{refreshing\}/);
  assert.doesNotMatch(OVERVIEW, /disabled=\{refreshing\}/);
  // 请求中按钮保持可聚焦；防重入靠 ref，而不是把按钮禁用。
  assert.match(OVERVIEW, /refreshInFlight/);
  assert.match(OVERVIEW, /Promise\.allSettled/);
});

test("页头显示「更新于 HH:MM」，时间取成功刷新的 dataUpdatedAt", () => {
  assert.match(OVERVIEW, /t\("overview\.updatedAt"/);
  assert.match(OVERVIEW, /dataUpdatedAt/);
  assert.match(OVERVIEW, /formatUpdatedClock\(/);
  assert.match(ZH, /updatedAt:\s*"更新于 \{time\}"/);
  assert.match(EN, /updatedAt:\s*"Updated \{time\}"/);
});

test("四张 KPI 卡都是整卡链接，链接来自纯函数", () => {
  assert.match(OVERVIEW, /<Link[\s\S]*?to=\{/);
  for (const link of [
    "onlineServersKpiLink",
    "forwardChainsKpiLink",
    "todayTrafficKpiLink",
    "usersKpiLink",
  ]) {
    assert.match(OVERVIEW, new RegExp(`${link}\\(`));
  }
});

test("转发链卡与用户卡一样带「全局」标", () => {
  const start = OVERVIEW.indexOf('label={t("overview.forwardChains")}');
  assert.notEqual(start, -1, "找不到转发链 KpiCard");
  // 卡片到下一个同缩进的 `/>` 结束；不能用 indexOf("/>")，`</>` 里也含 "/>"。
  const end = OVERVIEW.indexOf("\n            />", start);
  assert.notEqual(end, -1, "找不到转发链 KpiCard 的结尾");
  const block = OVERVIEW.slice(start, end);
  assert.match(block, /^\s*global\s*$/m);
});

test("异常计数用语义色：离线 / 阻断 / 降级分别取自 tone helper", () => {
  assert.match(OVERVIEW, /kpiToneIconClass\(/);
  assert.match(OVERVIEW, /kpiToneTextClass\(/);
  assert.match(OVERVIEW, /onlineServersKpiTone\(/);
  assert.match(OVERVIEW, /forwardChainsKpiTone\(/);
  assert.match(OVERVIEW, /t\("overview\.offlineUnit"\)/);
  assert.match(ZH, /offlineUnit:\s*"台离线"/);
  assert.match(EN, /offlineUnit:\s*"offline"/);
  assert.match(ZH, /chainDegraded:\s*"降级"/);
  assert.match(EN, /chainDegraded:\s*"degraded"/);
});
