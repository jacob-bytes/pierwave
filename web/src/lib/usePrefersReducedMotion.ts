import { useSyncExternalStore } from "react";

/** 与 `index.css` 的全局 reduced-motion 规则同一口径。 */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** 服务端没有媒体查询：默认不减弱，与桌面首帧一致。 */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * 系统是否要求减弱动效。
 *
 * CSS 里的全局 reduced-motion 规则管不到 React Flow 的 `setViewport`
 * 平移动画——那个时长由 JS 传入，不走 CSS transition。所以「右侧 / 下方还有」
 * 按钮要读这个值，把时长改成 0（瞬时到终点）。
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
