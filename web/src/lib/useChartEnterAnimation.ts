import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";

/**
 * 图表首次入场动画 / One-shot entrance animation for charts.
 *
 * Recharts 的 `isAnimationActive` 是逐 series 的开关：如果一直关着，图表
 * 挂载时直接出现终值，看起来像「贴上去的」；如果一直开着，每次数据刷新
 * （例如 20 秒轮询）都会重播一遍生长动画，读数就被动效打断。
 *
 * 这里只在**首次挂载**播放一次：`entered` 之后永久关闭动画，后续刷新
 * 直接呈现新值。`reducedMotion` 下从第一帧就是终值。
 *
 * `setTimeout` 是空数据 / 动画未触发的兜底：没有路径可画时 Recharts 不会
 * 调 `onAnimationEnd`，不能因此让图表一直处于「等待入场」的状态。
 */

/** 与全站 150–220ms 的动效区间一致。 */
export const CHART_ENTER_MS = 220;

/** 兜底：无论有没有触发 onAnimationEnd，620ms 后都当作已经入场。 */
const ENTER_FALLBACK_MS = 620;

export function useChartEnterAnimation() {
  const reduced = usePrefersReducedMotion();
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (reduced) return;
    const timer = window.setTimeout(() => setEntered(true), ENTER_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [reduced]);

  return {
    isAnimationActive: !reduced && !entered,
    animationDuration: CHART_ENTER_MS,
    animationEasing: "ease-out" as const,
    onAnimationEnd: () => setEntered(true),
  };
}
