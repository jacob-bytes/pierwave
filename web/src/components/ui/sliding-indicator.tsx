import * as React from "react";
import { cn } from "@/lib/utils";
import {
  indicatorRect,
  sameBox,
  type Box,
  type IndicatorPlacement,
} from "@/lib/indicatorRect";

/**
 * 一个可以滑动的选中指示器 / A selection indicator that glides between items.
 *
 * 它只做三件事：量出「当前选中项」相对容器的矩形、把它写成绝对定位的行内
 * 样式、在位置变化时用 200ms `ease-out-soft` 过渡。选中项本身不再涂底色，
 * 所以 tab / 分段控件 / 侧栏的选中态只有这一个来源。
 *
 * 测量用 `getBoundingClientRect()` 而不是元素的 offset 偏移：容器可能横向
 * 滚动，视口矩形 + `scrollLeft/Top` 才能换算回内容坐标。
 *
 * 重新测量的触发源：
 * - `ResizeObserver`：容器尺寸、当前选中项尺寸（切换选中项时换观察目标）；
 * - `MutationObserver`：容器内的选中属性与文字 / 子节点变化；
 * - `document.fonts.ready`：字体加载完成后标签宽度会变；
 * - `document` 捕获阶段的 `animationend` / `transitionend`；
 * - 容器滚动与窗口尺寸；
 * - 挂载后 300ms 内逐帧重量：首屏的布局 / 字体 / 动画都可能还没落定。
 *
 * 首次拿到位置（以及容器从隐藏变可见）时先把位置写进去、下一帧才打开
 * 过渡，否则会从 (0, 0) 滑进来，看起来像页面自己动了一下。
 */

/** 首帧逐帧重量的时长 / How long to re-measure every frame after mount. */
const SETTLE_FRAME_MS = 300;

/** 选中项变化时监听这些属性；`data-state` 由 Radix 写入。 */
const ACTIVE_ATTRIBUTES = [
  "data-state",
  "aria-current",
  "aria-selected",
  "aria-pressed",
];

export interface SlidingIndicatorProps {
  containerRef: React.RefObject<HTMLElement | null>;
  /** CSS 选择器：容器内当前选中的那个元素。 */
  activeSelector: string;
  placement: IndicatorPlacement;
  className?: string;
}

interface IndicatorState {
  rect: Box | null;
  /** `false` 时禁用 left/top/width/height 过渡（首帧 / 重新出现）。 */
  ready: boolean;
}

export function SlidingIndicator({
  containerRef,
  activeSelector,
  placement,
  className,
}: SlidingIndicatorProps) {
  const indicatorRef = React.useRef<HTMLSpanElement>(null);
  const [state, setState] = React.useState<IndicatorState>({
    rect: null,
    ready: false,
  });
  // 观察器回调里读最新状态，避免因为闭包停留在旧值上反复重挂载。
  // 所有状态更新都走 `commit`，所以不需要在 render 期间同步这个 ref。
  const stateRef = React.useRef<IndicatorState>({ rect: null, ready: false });
  // 父组件的 ref 可能比子组件的 layout effect 晚一步挂载；下一帧重试。
  const [, retry] = React.useReducer((count: number) => count + 1, 0);
  const retryCount = React.useRef(0);

  React.useLayoutEffect(() => {
    // 子组件的 layout effect 可能先于父组件 ref 挂载；指示器自己的
    // `parentElement` 就是那个容器（组件约定它必须是容器第一个子元素），
    // 用它兜底可以免掉一次空白帧。两者都没有时再下一帧重试。
    const container =
      containerRef.current ?? indicatorRef.current?.parentElement ?? null;
    if (!container) {
      if (retryCount.current < 10) {
        retryCount.current += 1;
        const frame = window.requestAnimationFrame(retry);
        return () => window.cancelAnimationFrame(frame);
      }
      return;
    }
    retryCount.current = 0;

    let cancelled = false;
    let measureFrame: number | null = null;
    let readyFrame: number | null = null;
    let observedActive: HTMLElement | null = null;

    const commit = (next: IndicatorState) => {
      stateRef.current = next;
      setState(next);
    };

    /** 首帧 / 重新出现：位置先落定，下一帧才允许过渡。 */
    const armReady = () => {
      if (readyFrame !== null) return;
      readyFrame = window.requestAnimationFrame(() => {
        readyFrame = null;
        const current = stateRef.current;
        if (current.rect !== null && !current.ready) {
          commit({ rect: current.rect, ready: true });
        }
      });
    };

    const measure = () => {
      if (cancelled) return;
      const indicator = indicatorRef.current;
      const active = container.querySelector<HTMLElement>(activeSelector);

      // 选中项换了就换 ResizeObserver 的观察目标。
      if (observedActive !== active) {
        if (observedActive) resizeObserver?.unobserve(observedActive);
        observedActive = active;
        if (active) resizeObserver?.observe(active);
      }

      let next: Box | null = null;
      if (active && active !== indicator && !indicator?.contains(active)) {
        const containerRect = container.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        const computed = window.getComputedStyle(container);
        // 容器边框：绝对定位的包含块是 padding box。
        const border =
          Number.parseFloat(computed.borderTopWidth) || 0;
        next = indicatorRect(
          {
            left: activeRect.left,
            top: activeRect.top,
            width: activeRect.width,
            height: activeRect.height,
          },
          {
            left: containerRect.left,
            top: containerRect.top,
            width: containerRect.width,
            height: containerRect.height,
          },
          { x: container.scrollLeft, y: container.scrollTop },
          border,
          placement,
        );
      }

      const previous = stateRef.current;
      if (next === null) {
        if (readyFrame !== null) {
          window.cancelAnimationFrame(readyFrame);
          readyFrame = null;
        }
        if (previous.rect !== null || previous.ready) {
          commit({ rect: null, ready: false });
        }
        return;
      }

      if (sameBox(previous.rect, next)) {
        // 位置没变：可能只是等待首帧 ready 的请求被合并了。
        if (!previous.ready) armReady();
        return;
      }

      commit({ rect: next, ready: previous.ready });
      if (!previous.ready) armReady();
    };

    const scheduleMeasure = () => {
      if (measureFrame !== null) return;
      measureFrame = window.requestAnimationFrame(() => {
        measureFrame = null;
        measure();
      });
    };

    // 容器尺寸变化（侧栏折叠、窗口变窄、换语言后标签变宽）。
    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(scheduleMeasure)
        : null;
    resizeObserver?.observe(container);

    // 容器内的选中属性、子节点与文字变化。
    const mutationObserver =
      typeof MutationObserver === "function"
        ? new MutationObserver((records) => {
            const indicator = indicatorRef.current;
            // 指示器自己的行内样式 / data-ready 变化不算选中变化。
            if (
              indicator &&
              records.every(
                (record) =>
                  record.target === indicator ||
                  indicator.contains(record.target),
              )
            ) {
              return;
            }
            scheduleMeasure();
          })
        : null;
    mutationObserver?.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ACTIVE_ATTRIBUTES,
    });

    // 字体加载完成后标签宽度会变，尤其是首屏的 fallback 字体。
    void document.fonts?.ready.then(() => {
      if (!cancelled) scheduleMeasure();
    });

    // 任何进入 / 退出动画结束后布局都可能变了；捕获阶段才能收到子节点事件。
    const onMotionEnd = (event: Event) => {
      const indicator = indicatorRef.current;
      if (
        indicator &&
        event.target instanceof Node &&
        indicator.contains(event.target)
      ) {
        return;
      }
      scheduleMeasure();
    };
    document.addEventListener("animationend", onMotionEnd, { capture: true });
    document.addEventListener("transitionend", onMotionEnd, { capture: true });

    container.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);

    // 先同步量一次（useLayoutEffect 在 paint 前），首帧就落在正确位置。
    measure();

    // 前 300ms 逐帧重量：字体、吸顶、入场动画都可能在这段时间里改布局。
    const startedAt = performance.now();
    let frame = window.requestAnimationFrame(function tick() {
      if (cancelled) return;
      measure();
      if (performance.now() - startedAt < SETTLE_FRAME_MS) {
        frame = window.requestAnimationFrame(tick);
      }
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      if (measureFrame !== null) window.cancelAnimationFrame(measureFrame);
      if (readyFrame !== null) window.cancelAnimationFrame(readyFrame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      document.removeEventListener("animationend", onMotionEnd, { capture: true });
      document.removeEventListener("transitionend", onMotionEnd, { capture: true });
      container.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [activeSelector, containerRef, placement, retry]);

  const { rect, ready } = state;

  return (
    <span
      ref={indicatorRef}
      aria-hidden="true"
      data-slot="sliding-indicator"
      data-ready={ready ? "ready" : "hidden"}
      className={cn(
        "pointer-events-none absolute block",
        // 过渡只在 ready 后启用：首次出现 / 从隐藏恢复时不能从 (0,0) 滑进来。
        ready
          ? "transition-[left,top,width,height] duration-200 ease-out-soft motion-reduce:transition-none"
          : "",
        className,
      )}
      style={{
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        opacity: rect ? 1 : 0,
      }}
    />
  );
}
