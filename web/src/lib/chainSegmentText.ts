/**
 * 逐段标题的文案：`第 2 段 · 最低延迟 · 3 选 1`。
 *
 * 单独成模块的原因和 `chainStatusText.ts` 一样：组件只负责排布，标题的
 * 策略名 / 台数口径可以脱离 React 单测。策略取自链拓扑节点（段的 seq 就是
 * 目标组 seq），契约缺 `strategy` / 成员数时标题退化成旧的「第 N 段」。
 */

import {
  type ChainRouteStrategy,
  type ChainSegmentTitlePlan,
  type ChainHealthSegment,
} from "./chainHealth.ts";
import { t as translate } from "../i18n/index.ts";
import type { TFunction } from "../i18n/index.ts";

/**
 * 策略短名：与拓扑画布列头的「故障转移 / 最低延迟 / N 台分担」不同，
 * 逐段标题要在一行里同时放段号与台数，所以用更短的口径
 * （`主备` / `轮询` …）。两者都指同一个契约值，不改变后端语义。
 */
export const CHAIN_SEGMENT_STRATEGY_KEYS: Record<ChainRouteStrategy, string> =
  {
    failover: "overview.chainLatency.segmentStrategyFailover",
    lowest_latency: "overview.chainLatency.segmentStrategyLowestLatency",
    round_robin: "overview.chainLatency.segmentStrategyRoundRobin",
    ip_hashed: "overview.chainLatency.segmentStrategyIpHash",
    weighted: "overview.chainLatency.segmentStrategyWeighted",
    least_conn: "overview.chainLatency.segmentStrategyLeastConn",
  };

export function chainSegmentStrategyLabel(
  strategy: ChainRouteStrategy,
  t: TFunction = translate,
): string {
  return t(CHAIN_SEGMENT_STRATEGY_KEYS[strategy]);
}

/**
 * 段标题：没有策略计划时就是「第 N 段」；有策略时补上策略与台数。
 *
 * `choose`（failover / lowest_latency）写 `N 选 1`；`balanced`（round_robin
 * 等）写 `N 台分担`——后者没有「首选 / 当前」，不能暗示顺序。
 */
export function chainSegmentTitle(
  segment: Pick<ChainHealthSegment, "seq">,
  plan: ChainSegmentTitlePlan | null,
  t: TFunction = translate,
): string {
  if (plan === null) return t("overview.chainLatency.segment", { seq: segment.seq });
  return t(
    plan.kind === "balanced"
      ? "overview.chainLatency.segmentTitleBalanced"
      : "overview.chainLatency.segmentTitleChoose",
    {
      seq: segment.seq,
      strategy: chainSegmentStrategyLabel(plan.strategy, t),
      n: plan.count,
    },
  );
}
