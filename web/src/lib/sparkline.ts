/**
 * 概览页 Top 服务器 mini 折线的纯几何计算（不依赖 React / DOM / recharts）。
 *
 * 输入是后端按 `ts` 升序返回的最近 N 个 `server_samples`：每个点带
 * `rx_bps` / `tx_bps`（字节/秒，任一侧可能为 null）。
 *
 * 约定：
 * - **有效点** = rx 或 tx 至少一侧是有限非负数；有效点少于
 *   [`MIN_SPARKLINE_POINTS`] 时返回 `null`，页面显示 `—`，不画线；
 * - 两个方向共用同一个 y 轴最大值，这样两条线的斜率可以直接比较；
 * - null 是**缺口**而不是 0：该点不连线，但仍占一个 x 位置，时间轴不被压缩；
 * - 单个方向少于 2 个有效点时不画该方向的线（一个点画不成趋势）；
 * - 只表达趋势：没有坐标轴、刻度与 tooltip。
 */

/** 少于 3 个有效点画不出趋势，页面显示 `—`。 */
export const MIN_SPARKLINE_POINTS = 3;

/** 输入点：字段名与 `OverviewRatePoint` 保持一致。 */
export interface SparklineInputPoint {
  ts?: number;
  rx_bps?: number | null;
  tx_bps?: number | null;
}

/** 输出：SVG path 的 `d`；某方向没有足够点时为 null。 */
export interface SparklineGeometry {
  rx: string | null;
  tx: string | null;
  /** 有效点数（下发给 aria-label / 测试断言）。 */
  count: number;
}

type Direction = "rx" | "tx";

/** null / 负数 / 非有限数都是「没有数据」，不参与归一化。 */
function valid(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * 把采样点映射成两条 SVG path（0..width / 0..height 的 viewBox 坐标）。
 *
 * `points` 为空、尺寸非法、或有效点不足时返回 `null`。返回值里的 `rx` /
 * `tx` 可能各自为 `null`（该方向没有足够点），但 `count` 一定 >= 3。
 */
export function sparklineGeometry(
  points: readonly SparklineInputPoint[] | null | undefined,
  width: number,
  height: number,
): SparklineGeometry | null {
  if (!points?.length) return null;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  const values = points.map((point) => ({
    rx: valid(point.rx_bps),
    tx: valid(point.tx_bps),
  }));
  let count = 0;
  let max = 0;
  for (const point of values) {
    if (point.rx === null && point.tx === null) continue;
    count += 1;
    max = Math.max(max, point.rx ?? 0, point.tx ?? 0);
  }
  if (count < MIN_SPARKLINE_POINTS) return null;
  // 全是 0 时用 1 做分母，画一条贴底的直线，而不是 NaN。
  const scale = Math.max(1, max);

  // 上下各留 1px，避免 1.25px 的描边在 viewBox 边缘被裁掉。
  const innerHeight = Math.max(0, height - 2);
  const x = (index: number) =>
    values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
  const y = (value: number) => height - 1 - (value / scale) * innerHeight;

  const path = (direction: Direction): string | null => {
    let drawn = 0;
    let penDown = false;
    let d = "";
    values.forEach((point, index) => {
      const value = point[direction];
      if (value === null) {
        // 缺口：抬笔，但下标不变，时间位置仍然保留。
        penDown = false;
        return;
      }
      d += `${penDown ? "L" : "M"}${x(index).toFixed(2)} ${y(value).toFixed(2)} `;
      penDown = true;
      drawn += 1;
    });
    return drawn >= 2 ? d.trim() : null;
  };

  return { rx: path("rx"), tx: path("tx"), count };
}
