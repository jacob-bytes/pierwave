/**
 * 概览页 KPI 下方的四个视图：服务器状态 / 流量 / 成本开销 / 链路时延。
 *
 * URL 是视图的唯一来源：`?view=server|traffic|cost|chain`。默认的「服务器状态」
 * 不写参数（与设置 / 日志页的默认 tab 约定一致），切换用 `replace`，
 * 避免每切一次 tab 就往历史里塞一条记录。非法值统一回落到默认视图。
 *
 * 这里只放纯函数，方便 `node:test` 直接覆盖 URL 行为；组件只负责渲染。
 */

import { CHAIN_SERIES_PARAM } from "./chainTrendSeries.ts";

export const OVERVIEW_VIEWS = ["server", "traffic", "cost", "chain"] as const;

export type OverviewView = (typeof OVERVIEW_VIEWS)[number];

/** 默认视图：运维每天先看「现在有没有问题」。 */
export const DEFAULT_OVERVIEW_VIEW: OverviewView = "server";

/** 「流量」tab 的窗口天数；KPI 的日环比也复用这一份。 */
export const OVERVIEW_TRAFFIC_DAYS = 7;

/** 是否精确命中某个视图 id（大小写敏感，不 trim）。 */
export function isOverviewView(value: unknown): value is OverviewView {
  return (
    typeof value === "string" &&
    (OVERVIEW_VIEWS as readonly string[]).includes(value)
  );
}

/** 解析 `?view=`；空值、拼错、旧链接都回落到默认视图。 */
export function resolveOverviewView(value: unknown): OverviewView {
  return isOverviewView(value) ? value : DEFAULT_OVERVIEW_VIEW;
}

/**
 * 写回 URL 的参数值；默认视图返回 `null`，表示应当删除该参数。
 */
export function overviewViewParam(view: OverviewView): string | null {
  return view === DEFAULT_OVERVIEW_VIEW ? null : view;
}

/**
 * 在现有查询参数上应用一个视图，返回新的 `URLSearchParams`（不改入参）。
 * 其它参数（例如未来可能加的 `range`）原样保留。
 */
export function applyOverviewView(
  params: URLSearchParams,
  view: OverviewView,
): URLSearchParams {
  const next = new URLSearchParams(params);
  const param = overviewViewParam(view);
  if (param === null) next.delete("view");
  else next.set("view", param);
  // `chain` 只属于链路时延视图；离开时必须清掉，否则切回来会重新弹窗，
  // 后退历史里也会留下指向已关闭弹窗的脏参数。
  // `section`（转发链 / 转发模板）同理：它只在链路时延 tab 内有意义。
  // `status` / `q` 是链路列表自己的筛选与搜索，`series` 是趋势图的链选择；
  // 三者都只属于链路时延 tab，跟到流量 / 成本 tab 会让分享出去的链接带着
  // 一个看不见的筛选 / 选择条件，因此一并清理。
  if (view !== "chain") {
    next.delete("chain");
    next.delete("section");
    next.delete("status");
    next.delete("q");
    next.delete(CHAIN_SERIES_PARAM);
  }
  return next;
}
