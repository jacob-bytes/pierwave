import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OVERVIEW_DISTRIBUTION_TAB,
  DEFAULT_OVERVIEW_LEADERBOARD_TAB,
  DEFAULT_OVERVIEW_TREND_TAB,
  OVERVIEW_DISTRIBUTION_TABS,
  OVERVIEW_LEADERBOARD_TABS,
  OVERVIEW_TREND_TABS,
  isOverviewDistributionTab,
  isOverviewLeaderboardTab,
  isOverviewTrendTab,
  overviewDistributionEmptyKey,
  overviewLeaderboardEmptyKey,
  resolveOverviewDistributionTab,
  resolveOverviewLeaderboardTab,
  resolveOverviewTrendTab,
} from "./overviewTabs.ts";

test("每组标签的顺序与默认值固定", () => {
  assert.deepEqual(OVERVIEW_TREND_TABS, ["traffic", "protocol"]);
  assert.equal(DEFAULT_OVERVIEW_TREND_TAB, "traffic");
  assert.deepEqual(OVERVIEW_DISTRIBUTION_TABS, ["protocol", "package"]);
  assert.equal(DEFAULT_OVERVIEW_DISTRIBUTION_TAB, "protocol");
  assert.deepEqual(OVERVIEW_LEADERBOARD_TABS, ["server", "node", "user"]);
  assert.equal(DEFAULT_OVERVIEW_LEADERBOARD_TAB, "server");
});

test("合法标签原样保留，非法值回落到默认标签", () => {
  for (const tab of OVERVIEW_TREND_TABS) {
    assert.equal(isOverviewTrendTab(tab), true);
    assert.equal(resolveOverviewTrendTab(tab), tab);
  }
  for (const tab of OVERVIEW_DISTRIBUTION_TABS) {
    assert.equal(isOverviewDistributionTab(tab), true);
    assert.equal(resolveOverviewDistributionTab(tab), tab);
  }
  for (const tab of OVERVIEW_LEADERBOARD_TABS) {
    assert.equal(isOverviewLeaderboardTab(tab), true);
    assert.equal(resolveOverviewLeaderboardTab(tab), tab);
  }

  // 大小写 / 空格 / 空串 / null / 原型链上的键都不是标签。
  assert.equal(resolveOverviewTrendTab("Traffic"), "traffic");
  assert.equal(resolveOverviewTrendTab(""), "traffic");
  assert.equal(resolveOverviewTrendTab(null), "traffic");
  assert.equal(resolveOverviewDistributionTab(" package"), "protocol");
  assert.equal(resolveOverviewDistributionTab(undefined), "protocol");
  assert.equal(resolveOverviewLeaderboardTab("toString"), "server");
  assert.equal(resolveOverviewLeaderboardTab("users"), "server");
});

test("切换标签只改变选择，不回写请求参数", () => {
  // 分段控件是纯局部状态：任意合法序列切换后解析结果始终等于选择值。
  const sequence = ["protocol", "traffic", "protocol"];
  let selected = DEFAULT_OVERVIEW_TREND_TAB;
  for (const next of sequence) {
    selected = resolveOverviewTrendTab(next);
    assert.equal(selected, next);
  }
  assert.equal(selected, "protocol");
  // 非法值不产生新状态，回到默认。
  assert.equal(resolveOverviewTrendTab("bogus"), DEFAULT_OVERVIEW_TREND_TAB);
});

test("分布卡的空态按标签给出对应文案", () => {
  assert.equal(
    overviewDistributionEmptyKey("protocol"),
    "overview.protocolEmpty",
  );
  assert.equal(
    overviewDistributionEmptyKey("package"),
    "overview.packageSplitEmpty",
  );
});

test("榜单卡的空态按标签给出对应文案", () => {
  assert.equal(overviewLeaderboardEmptyKey("server"), "overview.topEmpty");
  assert.equal(overviewLeaderboardEmptyKey("node"), "overview.topNodesEmpty");
  assert.equal(overviewLeaderboardEmptyKey("user"), "overview.topUsersEmpty");
  // 三个标签的文案互不相同，避免切过去看到同一句。
  const keys = OVERVIEW_LEADERBOARD_TABS.map(overviewLeaderboardEmptyKey);
  assert.equal(new Set(keys).size, keys.length);
});
