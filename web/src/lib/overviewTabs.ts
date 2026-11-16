/**
 * 概览页三组分段控件的纯逻辑：趋势（总流量 / 协议）、分布（协议 / 套餐）、
 * 榜单（服务器 / 节点 / 用户）。
 *
 * 三组标签都只是**页面内局部状态**：切换只更换已加载数据的视图，
 * 不写 URL、不触发新的请求。默认值与空态文案放在这里，方便单测。
 */

export const OVERVIEW_TREND_TABS = ["traffic", "protocol"] as const;
export type OverviewTrendTab = (typeof OVERVIEW_TREND_TABS)[number];
/** 默认看总流量：它是概览页最主要的一条趋势。 */
export const DEFAULT_OVERVIEW_TREND_TAB: OverviewTrendTab = "traffic";

export const OVERVIEW_DISTRIBUTION_TABS = ["protocol", "package"] as const;
export type OverviewDistributionTab =
  (typeof OVERVIEW_DISTRIBUTION_TABS)[number];
export const DEFAULT_OVERVIEW_DISTRIBUTION_TAB: OverviewDistributionTab =
  "protocol";

export const OVERVIEW_LEADERBOARD_TABS = ["server", "node", "user"] as const;
export type OverviewLeaderboardTab =
  (typeof OVERVIEW_LEADERBOARD_TABS)[number];
export const DEFAULT_OVERVIEW_LEADERBOARD_TAB: OverviewLeaderboardTab =
  "server";

/** 只接受字符串，且必须精确命中（不 trim、不转小写）。 */
function includes<T extends string>(
  ids: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (ids as readonly string[]).includes(value)
  );
}

export function isOverviewTrendTab(value: unknown): value is OverviewTrendTab {
  return includes(OVERVIEW_TREND_TABS, value);
}

export function isOverviewDistributionTab(
  value: unknown,
): value is OverviewDistributionTab {
  return includes(OVERVIEW_DISTRIBUTION_TABS, value);
}

export function isOverviewLeaderboardTab(
  value: unknown,
): value is OverviewLeaderboardTab {
  return includes(OVERVIEW_LEADERBOARD_TABS, value);
}

/** 非法值一律回落到默认标签，避免空白面板。 */
export function resolveOverviewTrendTab(
  value: unknown,
): OverviewTrendTab {
  return isOverviewTrendTab(value) ? value : DEFAULT_OVERVIEW_TREND_TAB;
}

export function resolveOverviewDistributionTab(
  value: unknown,
): OverviewDistributionTab {
  return isOverviewDistributionTab(value)
    ? value
    : DEFAULT_OVERVIEW_DISTRIBUTION_TAB;
}

export function resolveOverviewLeaderboardTab(
  value: unknown,
): OverviewLeaderboardTab {
  return isOverviewLeaderboardTab(value)
    ? value
    : DEFAULT_OVERVIEW_LEADERBOARD_TAB;
}

/**
 * 分布卡在数据为空时的兜底文案键。
 * 协议与套餐各自沿用原来的空态，聚合后不换一句话。
 */
export function overviewDistributionEmptyKey(
  tab: OverviewDistributionTab,
): string {
  return tab === "package"
    ? "overview.packageSplitEmpty"
    : "overview.protocolEmpty";
}

/** 榜单卡每类数据的空态文案键；三类互不相同。 */
export function overviewLeaderboardEmptyKey(
  tab: OverviewLeaderboardTab,
): string {
  switch (tab) {
    case "node":
      return "overview.topNodesEmpty";
    case "user":
      return "overview.topUsersEmpty";
    default:
      return "overview.topEmpty";
  }
}
