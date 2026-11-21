import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_SPARKLINE_POINTS,
  multiSparkGeometry,
  sparklineGeometry,
} from "./sparkline.ts";

const point = (rx, tx) => ({ rx_bps: rx, tx_bps: tx });

/** 从 path 里取出所有 "x y" 坐标对。 */
function coords(path) {
  return [...path.matchAll(/([ML])([\d.]+) ([\d.]+)/g)].map((match) => ({
    command: match[1],
    x: Number(match[2]),
    y: Number(match[3]),
  }));
}

test("sparkline needs at least three valid points", () => {
  assert.equal(MIN_SPARKLINE_POINTS, 3);
  assert.equal(sparklineGeometry([], 72, 24), null);
  assert.equal(sparklineGeometry(null, 72, 24), null);
  assert.equal(
    sparklineGeometry([point(10, 5), point(20, 8)], 72, 24),
    null,
    "两个点画不出趋势",
  );
  // 两侧都是 null 的点不算有效点。
  assert.equal(
    sparklineGeometry(
      [point(10, 5), point(null, null), point(20, 8)],
      72,
      24,
    ),
    null,
  );
  // 尺寸非法时不输出坐标。
  assert.equal(sparklineGeometry([point(1, 1), point(2, 2), point(3, 3)], 0, 24), null);
  assert.equal(sparklineGeometry([point(1, 1), point(2, 2), point(3, 3)], 72, Number.NaN), null);
});

test("sparkline maps samples to the full viewBox width, ascending x", () => {
  const geometry = sparklineGeometry(
    [point(0, 0), point(10, 10), point(20, 20)],
    72,
    24,
  );
  assert.ok(geometry);
  assert.equal(geometry.count, 3);
  assert.ok(geometry.rx && geometry.tx);
  const rx = coords(geometry.rx);
  assert.equal(rx.length, 3);
  assert.equal(rx[0].x, 0, "第一个点在左边缘");
  assert.equal(rx[2].x, 72, "最后一个点在右边缘");
  assert.ok(rx[0].x < rx[1].x && rx[1].x < rx[2].x);
});

test("sparkline shares one y scale and inverts the axis", () => {
  const geometry = sparklineGeometry(
    [point(0, 0), point(10, 5), point(20, 10)],
    72,
    24,
  );
  assert.ok(geometry?.rx);
  const rx = coords(geometry.rx);
  // 数值越大 y 越小（SVG 原点在左上）；0 贴底，最大值贴顶（上下各留 1px）。
  assert.equal(rx[0].y, 23);
  assert.equal(rx[2].y, 1);
  assert.ok(rx[0].y > rx[1].y && rx[1].y > rx[2].y);
});

test("sparkline treats null as a gap instead of zero", () => {
  const geometry = sparklineGeometry(
    [point(10, 10), point(null, 10), point(20, 10)],
    72,
    24,
  );
  assert.ok(geometry?.rx);
  const rx = coords(geometry.rx);
  assert.equal(
    rx.filter((entry) => entry.command === "M").length,
    2,
    "缺口处抬笔，再以 M 重新开始",
  );
  assert.equal(rx.length, 2, "缺口不生成 L 连线，也不补 0");
  assert.equal(rx[1].x, 72, "缺口仍占一个 x 位置，时间轴不被压缩");
});

test("sparkline skips a direction with fewer than two points", () => {
  const geometry = sparklineGeometry(
    [point(1, null), point(2, null), point(3, null)],
    72,
    24,
  );
  assert.ok(geometry);
  assert.equal(geometry.count, 3);
  assert.ok(geometry.rx);
  assert.equal(geometry.tx, null, "上行没有数据时不画虚线");
});

test("sparkline draws a flat baseline for all-zero traffic", () => {
  const geometry = sparklineGeometry(
    [point(0, 0), point(0, 0), point(0, 0)],
    72,
    24,
  );
  assert.ok(geometry?.rx);
  const rx = coords(geometry.rx);
  assert.ok(rx.every((entry) => entry.y === 23), "0 B/s 是有效数据，贴底画线");
  assert.equal(rx.length, 3);
});

test("sparkline ignores negative and non-finite rates", () => {
  const geometry = sparklineGeometry(
    [point(-1, Number.NaN), point(10, 10), point(20, 20), point(30, 30)],
    72,
    24,
  );
  assert.ok(geometry);
  assert.equal(geometry.count, 3, "脏数据不算有效点");
  assert.ok(geometry.rx);
  assert.ok(geometry.tx);
});

// ---------------------------------------------------------------------------
// `multiSparkGeometry`：hero 三张迷你图用的通用几何。
//
// 与上面 `sparklineGeometry` 的区别：可以只画一条线（延迟 / 可用率），
// 可以用零基线（速率）或 min–max 自适应（延迟 / 可用率），可带面积填充。
// null 一定是缺口，真实 0 一定贴底 —— 这条边界在两种缩放下都不能破。
// ---------------------------------------------------------------------------

const multi = (line, width = 100, height = 40, options) =>
  multiSparkGeometry([line], width, height, options);

test("multi spark geometry refuses empty and all-null data", () => {
  assert.equal(multiSparkGeometry([], 100, 40), null);
  assert.equal(multi({ values: [] }), null);
  assert.equal(
    multiSparkGeometry([{ values: [null, null, null] }], 100, 40),
    null,
    "全 null 必须返回 null，不能画成 0 的平线",
  );
  // 尺寸非法同样不输出坐标。
  assert.equal(multi({ values: [1, 2] }, 0, 40), null);
  assert.equal(multi({ values: [1, 2] }, 100, Number.NaN), null);
  // 调用方可以要求更多有效点（速率图沿用「至少 3 个点」）。
  assert.equal(
    multi({ values: [1, 2] }, 100, 40, { minPoints: 3 }),
    null,
  );
});

test("multi spark geometry treats a real zero as data at the zero baseline", () => {
  const zero = multi({ values: [0, 0, 0], area: true }, 100, 40, {
    zeroBased: true,
  });
  assert.ok(zero, "0 是有效数据，不能进空态");
  const points = coords(zero.series[0].path);
  assert.equal(points.length, 3);
  assert.ok(points.every((point) => point.y === 39), "0 贴底画线");
  assert.equal(
    (zero.series[0].area.match(/Z/g) ?? []).length,
    1,
    "面积闭合到底部",
  );
});

test("multi spark geometry lifts the pen at a null gap", () => {
  const gap = multi({ values: [1, 2, null, 4, 5] });
  assert.ok(gap);
  const points = coords(gap.series[0].path);
  assert.equal(
    points.filter((point) => point.command === "M").length,
    2,
    "缺口两侧各起一段",
  );
  assert.equal(points.length, 4, "缺口不生成连线");
  assert.equal(points[0].x, 0);
  assert.equal(points[1].x, 25);
  assert.equal(points[2].x, 75, "缺口仍占一个 x 位置");
  assert.equal(points[3].x, 100);
});

test("multi spark geometry skips isolated points that cannot form a line", () => {
  const isolated = multi({ values: [10, null, 30] });
  assert.ok(isolated, "两个有效位置仍可进几何层");
  assert.equal(isolated.count, 2);
  assert.equal(isolated.series[0].path, null, "两个孤立点画不成线");
  assert.equal(isolated.series[0].points.length, 3);
  assert.ok(isolated.series[0].points[0]);
  assert.equal(isolated.series[0].points[1], null);
});

test("multi spark geometry auto-scale spreads small variation", () => {
  const auto = multi({ values: [100, 200] });
  const points = coords(auto.series[0].path);
  assert.ok(points[0].y > points[1].y, "数值越大越靠上");
  assert.ok(
    points[0].y - points[1].y > 20,
    "自适应缩放要真的用上高度，而不是几条几像素的线",
  );
  assert.ok(points[1].y >= 1 && points[1].y <= 6);
});

test("multi spark geometry zero baseline anchors the axis at zero", () => {
  const zeroBased = multi({ values: [100, 200] }, 100, 40, {
    zeroBased: true,
  });
  const points = coords(zeroBased.series[0].path);
  assert.equal(points[0].y, 20, "100/200 落在高度的一半");
  assert.equal(points[1].y, 1);
});

test("multi spark geometry shares one y scale across both rate lines", () => {
  const both = multiSparkGeometry(
    [{ values: [100, 100] }, { values: [50, 100] }],
    100,
    40,
    { zeroBased: true },
  );
  const rx = coords(both.series[0].path);
  const tx = coords(both.series[1].path);
  assert.equal(rx[0].y, 1);
  assert.equal(tx[0].y, 20, "下行 100 是共同最大值，上行 50 在它下面");
  assert.equal(rx[1].y, tx[1].y, "同一采样位置共用比例尺");
});

test("multi spark geometry exposes point coordinates for the tooltip", () => {
  const geometry = multi({ values: [10, null, 30] }, 100, 40, {
    zeroBased: true,
  });
  assert.equal(geometry.series[0].points.length, 3);
  assert.equal(geometry.series[0].points[1], null);
  assert.equal(geometry.series[0].points[2].x, 100);
});

test("multi spark geometry closes an area per unbroken run", () => {
  const area = multi({ values: [10, 20, null, 30, 40], area: true }, 100, 40, {
    zeroBased: true,
  });
  assert.equal((area.series[0].area.match(/Z/g) ?? []).length, 2);
  assert.equal((area.series[0].path.match(/M/g) ?? []).length, 2);
});

test("multi spark geometry honours a fixed domain", () => {
  const fixed = multi({ values: [0, 0.5, 1] }, 100, 40, { domain: [0, 1] });
  const points = coords(fixed.series[0].path);
  assert.equal(points[0].y, 39, "0% 贴底");
  assert.equal(points[1].y, 20, "50% 在中线");
  assert.equal(points[2].y, 1, "100% 在顶部");

  // 非法 domain 回落到自适应（min–max），而不是用默认的 0..1。
  const fallback = multi({ values: [10, 20] }, 100, 40, {
    domain: [1, 1],
  });
  const fallbackPoints = coords(fallback.series[0].path);
  assert.ok(fallbackPoints[0].y > fallbackPoints[1].y);
  assert.ok(fallbackPoints[0].y - fallbackPoints[1].y > 20);
});

test("multi spark geometry keeps nonzero rates off the zero baseline", () => {
  const flat = multiSparkGeometry([{ values: [0, 1, 1000] }], 100, 24, {
    zeroBased: true,
    minNonZeroGap: 3,
  });
  const points = coords(flat.series[0].path);
  assert.equal(points[0].y, 23, "0 仍然贴底");
  assert.equal(points[1].y, 21, "非零值至少离底 2 个 CSS 像素（3 个 viewBox 单位）");
  assert.equal(points[2].y, 1);
});
