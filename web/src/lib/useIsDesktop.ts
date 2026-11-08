import { useSyncExternalStore } from "react";

/** 与 Tailwind 的 `md` 断点保持一致（>=768px 显示表格）。 */
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/**
 * 服务端没有窗口；这个 SPA 只在浏览器渲染，默认按桌面处理，
 * 保证首次客户端快照与桌面布局一致。
 */
function getServerSnapshot(): boolean {
  return true;
}

/**
 * 列表页用它决定渲染「桌面表格」还是「窄屏卡片」。
 *
 * 不用纯 CSS 隐藏表格：卡片模式（<md）下表格不应出现在 DOM 中，
 * 否则空态会留下一个不可见的 `<table>`，读屏与 DOM 断言都会误判。
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
