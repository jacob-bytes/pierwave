/**
 * 选中指示器的几何计算 / Geometry for the sliding selection indicator.
 *
 * 输入都来自 `getBoundingClientRect()`（视口坐标）。指示器本身是容器内的
 * 绝对定位子元素，所以要把「容器滚动量」加回来：滚动容器里的选中项在视口
 * 中左 / 上移了多少，指示器在内容坐标里就要右 / 下补多少，两者相抵后
 * 视觉位置一致。`border` 是容器边框宽度——绝对定位的包含块是 padding box，
 * 而 `getBoundingClientRect()` 给的是 border box，因此还要减掉它。
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type IndicatorPlacement = "pill" | "underline";

/** 下划线指示器的高度：2px，与 `docs/DESIGN.md` 第四节第 10 条一致。 */
export const UNDERLINE_HEIGHT = 2;

/** 亚像素容差：小于 0.01px 的变化不值得触发一次 React 更新。 */
const BOX_TOLERANCE = 0.01;

/**
 * 把选中项的视口矩形换算成指示器的行内样式矩形。
 *
 * - `pill`：与选中项同尺寸、同偏移；
 * - `underline`：与选中项同宽、高 2px、贴容器底边。
 *
 * 选中项尚未布局（宽或高为 0）时返回 null，由调用方隐藏指示器。
 */
export function indicatorRect(
  active: Box,
  container: Box,
  scroll: { x: number; y: number },
  border: number,
  placement: IndicatorPlacement,
): Box | null {
  if (!(active.width > 0) || !(active.height > 0)) return null;

  const left = active.left - container.left - border + scroll.x;

  if (placement === "pill") {
    return {
      left,
      top: active.top - container.top - border + scroll.y,
      width: active.width,
      height: active.height,
    };
  }

  return {
    left,
    width: active.width,
    height: UNDERLINE_HEIGHT,
    // 贴容器底边：包含块是 padding box，底边在 border box 内侧再减一条边框。
    top:
      container.height - border * 2 - UNDERLINE_HEIGHT + scroll.y,
  };
}

/** 两个矩形在 0.01px 容差内是否相同（null 与 null 相同）。 */
export function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.left - b.left) <= BOX_TOLERANCE + 1e-9 &&
    Math.abs(a.top - b.top) <= BOX_TOLERANCE + 1e-9 &&
    Math.abs(a.width - b.width) <= BOX_TOLERANCE + 1e-9 &&
    Math.abs(a.height - b.height) <= BOX_TOLERANCE + 1e-9
  );
}
