/**
 * 节点热度明细浮层的定位 / Placement for the node-heat detail overlay.
 *
 * 坐标系是**卡片本地坐标**：浮层用 `absolute` 挂在卡片里，随卡片一起滚动，
 * 因此只需在打开、卡片尺寸变化时算一次，不需要监听列表滚动。
 * 竖直方向优先贴在行下方，贴底时翻到行上方，再夹紧到卡片内；水平方向按
 * 卡片宽度夹紧——390 窄卡也不会把浮层推出卡片。
 *
 * Coordinates are **card-local**: the overlay is `absolute` inside the card, so
 * it scrolls with it and only needs re-placing on open and on card resize.
 * Vertically it prefers below the row, flips above near the bottom edge, then
 * clamps inside the card; horizontally it clamps to the card width.
 */
export interface NodeHeatTooltipRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface NodeHeatTooltipSize {
  width: number;
  height: number;
}

export interface NodeHeatTooltipPlacementInput {
  /** 触发行，相对卡片。 / The active row, in card-local coordinates. */
  anchor: NodeHeatTooltipRect;
  /** 浮层实测尺寸（`offsetWidth` / `offsetHeight`）。 */
  size: NodeHeatTooltipSize;
  /** 卡片内部可用尺寸（`clientWidth` / `clientHeight`）。 */
  container: NodeHeatTooltipSize;
  /**
   * 弹窗滚动窗口在卡片坐标系里的可见区间（`scrollTop` 变化时传入）。
   * 不传时可见区间就是整张卡片。
   */
  visible?: { top: number; height: number };
  /** 与触发行之间的间距。 */
  gap?: number;
  /** 与卡片边缘的最小间距。 */
  margin?: number;
}

export interface NodeHeatTooltipPlacement {
  x: number;
  y: number;
  /** true = 贴在行的下方；false = 翻到行的上方。 */
  below: boolean;
  clampedX: boolean;
  clampedY: boolean;
}

export const NODE_HEAT_TOOLTIP_GAP = 8;
export const NODE_HEAT_TOOLTIP_MARGIN = 8;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampAxis(
  value: number,
  min: number,
  max: number,
): { value: number; clamped: boolean } {
  // 容器比浮层还小时（max < min）优先保证左边 / 上边距，不产生负坐标。
  if (max < min) return { value: min, clamped: true };
  if (value < min) return { value: min, clamped: true };
  if (value > max) return { value: max, clamped: true };
  return { value, clamped: false };
}

export function placeNodeHeatTooltip(
  input: NodeHeatTooltipPlacementInput,
): NodeHeatTooltipPlacement {
  const gap = input.gap ?? NODE_HEAT_TOOLTIP_GAP;
  const margin = input.margin ?? NODE_HEAT_TOOLTIP_MARGIN;
  const width = Math.max(0, input.size.width);
  const height = Math.max(0, input.size.height);
  const containerWidth = Math.max(0, input.container.width);
  const containerHeight = Math.max(0, input.container.height);
  // 竖直方向只在「卡片 ∩ 滚动可见窗口」内放置：卡片被滚出弹窗时也看得到。
  const visibleTop = Math.max(0, input.visible?.top ?? 0);
  const visibleBottom = Math.min(
    containerHeight,
    (input.visible?.top ?? 0) + (input.visible?.height ?? containerHeight),
  );
  const boundsTop = visibleTop + margin;
  const boundsBottom = visibleBottom - margin;

  // 水平：以触发行中心对齐，再夹进卡片。
  const anchorCenter = (input.anchor.left + input.anchor.right) / 2;
  const horizontal = clampAxis(
    anchorCenter - width / 2,
    margin,
    containerWidth - width - margin,
  );

  // 竖直：下方放得下就向下；否则上方放得下就向上；两边都放不下就夹紧。
  const belowTop = input.anchor.bottom + gap;
  const aboveTop = input.anchor.top - gap - height;
  const fitsBelow = belowTop + height <= boundsBottom;
  const fitsAbove = aboveTop >= boundsTop;
  const below = fitsBelow || !fitsAbove;
  const vertical = clampAxis(
    below ? belowTop : aboveTop,
    boundsTop,
    boundsBottom - height,
  );

  return {
    x: round2(horizontal.value),
    y: round2(vertical.value),
    below,
    clampedX: horizontal.clamped,
    clampedY: vertical.clamped,
  };
}
