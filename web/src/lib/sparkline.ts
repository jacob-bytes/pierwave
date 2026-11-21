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

/**
 * hero 三张迷你图用的通用几何：支持 1–2 条线、零基线或自适应纵轴、面积填充。
 *
 * 与上面的 `sparklineGeometry` 刻意分开：那个函数服务于概览页 Top 服务器
 * （固定零基线、双方向、没有面积），已经被现有页面与测试钉住；这里不复制
 * 它的边界，而是补上 hero 需要的三种能力：
 *
 * - **单线**：延迟 / 可用率只画一条折线；
 * - **自适应纵轴**（`zeroBased: false`）：延迟 18–62 ms、可用率 97–100%
 *   这种窄区间，零基线会把变化压成一条直线，看不出趋势；
 * - **面积**：速率图在线下方填一层淡渐变，面积从零基线闭合，不另造色相。
 *
 * 三条不变量：
 * - null / 负数 / 非有限数是**缺口**，不是 0：不连线，但保留 x 位置；
 * - 真实 0 是有效数据：零基线下贴底画线；
 * - 一条线里没有任何**连续两个**有效点时，`path` 为 null（孤立点画不成趋势）。
 */
export interface MultiSparkSeriesInput {
  values: readonly (number | null | undefined)[];
  /** true 时额外输出闭合到底部的面积 path。 */
  area?: boolean;
}

export interface MultiSparkSeriesGeometry {
  /** 折线 path；没有连续两个有效点时为 null。 */
  path: string | null;
  /** 面积 path；每段独立闭合，没有可画线段时为 null。 */
  area: string | null;
  /** 每个采样位置的坐标；null = 该位置没有数据（tooltip 取数用）。 */
  points: ({ x: number; y: number } | null)[];
}

export interface MultiSparkGeometry {
  series: MultiSparkSeriesGeometry[];
  /** 至少一条线有数据的采样位置数。 */
  count: number;
  /** 参与归一化的最小值（原始单位）。 */
  min: number;
  /** 参与归一化的最大值（原始单位）。 */
  max: number;
}

export interface MultiSparkOptions {
  /** true：纵轴底固定为 0（速率）；false：按 min–max 自适应（延迟）。 */
  zeroBased?: boolean;
  /**
   * 固定纵轴范围，优先于 `zeroBased`。可用率用 `[0, 1]`：100% 永远在顶部，
   * 99% 与 93% 的差别不会被自适应放大成满屏锯齿。
   */
  domain?: readonly [number, number];
  /** 至少多少个有效位置才返回几何；默认 2。 */
  minPoints?: number;
  /**
   * 非零值的最小可见高度（viewBox 单位）。30 倍、1000 倍的量级突变下，
   * 小值会贴到 0 基线上；给一个 2px 的地板，才能区分「有流量 / 真 0」。
   * 0 值不受影响，仍然贴底。
   */
  minNonZeroGap?: number;
}

export function multiSparkGeometry(
  series: readonly MultiSparkSeriesInput[],
  width: number,
  height: number,
  options: MultiSparkOptions = {},
): MultiSparkGeometry | null {
  if (!series.length) return null;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  const minPoints = Math.max(
    2,
    Number.isFinite(options.minPoints)
      ? Math.floor(options.minPoints as number)
      : 2,
  );
  const length = series.reduce(
    (longest, line) => Math.max(longest, line.values.length),
    0,
  );
  if (length === 0) return null;

  // 先对齐到同一组 x 位置：短数组缺的位置就是 null 缺口。
  const values = series.map((line) =>
    Array.from({ length }, (_, index) => valid(line.values[index])),
  );

  let count = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < length; index += 1) {
    let sampled = false;
    for (const line of values) {
      const value = line[index];
      if (value === null) continue;
      sampled = true;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    if (sampled) count += 1;
  }
  if (count < minPoints || !Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }

  // 纵轴：固定 domain > 零基线 0..max > 自适应（min–max 外各留 12%）。
  // 自适应下所有值相等时按当前值上下各撑半格，画一条居中的平线。
  let bottom = 0;
  let top = 1;
  const domain = options.domain;
  const fixedDomain =
    domain !== undefined &&
    Number.isFinite(domain[0]) &&
    Number.isFinite(domain[1]) &&
    domain[1] > domain[0];

  if (fixedDomain && domain) {
    [bottom, top] = domain;
  } else if (options.zeroBased) {
    top = Math.max(1, max);
  } else {
    const span = max - min;
    const padding =
      span > 0 ? span * 0.12 : Math.max(Math.abs(max) * 0.05, 0.5);
    bottom = min - padding;
    top = max + padding;
    if (!(top > bottom)) {
      bottom = min - 0.5;
      top = max + 0.5;
    }
  }

  const innerHeight = Math.max(0, height - 2);
  const x = (index: number) =>
    length === 1 ? width / 2 : (index / (length - 1)) * width;
  const floorGap =
    Number.isFinite(options.minNonZeroGap) && (options.minNonZeroGap ?? 0) > 0
      ? Math.min(height - 2, options.minNonZeroGap as number)
      : 0;
  const y = (value: number) => {
    const mapped = Math.min(
      height - 1,
      Math.max(
        1,
        height - 1 - ((value - bottom) / (top - bottom)) * innerHeight,
      ),
    );
    // 只抬非零值：0 必须仍然贴底，否则「没有流量」会被画成有一条线。
    return floorGap > 0 && value > 0
      ? Math.min(mapped, height - floorGap)
      : mapped;
  };
  const round = (value: number) => value.toFixed(2);

  const built = values.map((line, lineIndex) => {
    const points: ({ x: number; y: number } | null)[] = line.map(
      (value, index) => (value === null ? null : { x: x(index), y: y(value) }),
    );
    let path = "";
    let area = "";

    // 按连续有效段构建：null 处抬笔，面积每段单独闭合。
    let index = 0;
    while (index < length) {
      if (line[index] === null) {
        index += 1;
        continue;
      }
      let end = index;
      while (end < length && line[end] !== null) end += 1;
      const run = line.slice(index, end) as number[];

      if (run.length >= 2) {
        const segment = run
          .map(
            (value, offset) =>
              `${offset === 0 ? "M" : "L"}${round(x(index + offset))} ${round(y(value))}`,
          )
          .join(" ");
        path += `${segment} `;

        if (series[lineIndex].area) {
          const areaSegment = run
            .map(
              (value, offset) =>
                `L${round(x(index + offset))} ${round(y(value))}`,
            )
            .join(" ");
          area += `M${round(x(index))} ${round(height)} ${areaSegment} L${round(x(end - 1))} ${round(height)} Z `;
        }
      }

      index = end;
    }

    return {
      path: path.trim() || null,
      area: area.trim() || null,
      points,
    };
  });

  return { series: built, count, min, max };
}
