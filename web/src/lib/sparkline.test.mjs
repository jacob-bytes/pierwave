import assert from "node:assert/strict";
import test from "node:test";
import { MIN_SPARKLINE_POINTS, sparklineGeometry } from "./sparkline.ts";

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
