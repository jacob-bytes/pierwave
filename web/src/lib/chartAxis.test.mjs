import assert from "node:assert/strict";
import test from "node:test";
import {
  byteAxisScale,
  formatByteAxisTick,
  niceStep,
  timeAxisTicks,
} from "./chartAxis.ts";

const GB = 1024 ** 3;
const TB = 1024 ** 4;

function close(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * 1e-9,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

test("niceStep 只取 1 / 2 / 2.5 / 5 × 10^n 并向上取整", () => {
  const cases = [
    [0.6, 1],
    [1, 1],
    [1.1, 2],
    [2, 2],
    [2.1, 2.5],
    [2.5, 2.5],
    [3, 5],
    [5, 5],
    [5.1, 10],
    [9, 10],
    [11.65, 20],
    [23.25, 25],
    [0.03, 0.05],
    [0.011, 0.02],
  ];
  for (const [raw, expected] of cases) {
    close(niceStep(raw), expected, `niceStep(${raw})`);
  }
});

test("niceStep 对 0 / 负数 / 非有限数返回 0，不把 NaN 带进坐标轴", () => {
  assert.equal(niceStep(0), 0);
  assert.equal(niceStep(-4), 0);
  assert.equal(niceStep(Number.NaN), 0);
  assert.equal(niceStep(Number.POSITIVE_INFINITY), 0);
});

test("byteAxisScale: 46.6 GB 得到 20 GB 步长，而不是 23.3 GB", () => {
  const scale = byteAxisScale(46.6 * GB);
  assert.equal(scale.max, 60 * GB);
  assert.equal(scale.step, 20 * GB);
  assert.deepEqual(
    scale.ticks.map(formatByteAxisTick),
    ["0", "20 GB", "40 GB", "60 GB"],
  );
  assert.ok(scale.ticks.at(-1) >= 46.6 * GB, "top tick must cover the data");
});

test("byteAxisScale: 0 也返回一根可用的 0 基线", () => {
  const scale = byteAxisScale(0);
  assert.equal(scale.max, 1);
  assert.deepEqual(scale.ticks, [0, 1]);
  assert.deepEqual(scale.ticks.map(formatByteAxisTick), ["0", "1 B"]);
});

test("byteAxisScale: 极小值落在 B 档，刻度仍是整数", () => {
  const scale = byteAxisScale(300);
  assert.deepEqual(
    scale.ticks.map(formatByteAxisTick),
    ["0", "100 B", "200 B", "300 B"],
  );
  const tiny = byteAxisScale(3);
  assert.deepEqual(
    tiny.ticks.map(formatByteAxisTick),
    ["0", "1 B", "2 B", "3 B"],
  );
});

test("byteAxisScale: TB 级按 1024 进位，不出现 0.9 TB 之类的换算残值", () => {
  const scale = byteAxisScale(3.2 * TB);
  assert.deepEqual(
    scale.ticks.map(formatByteAxisTick),
    ["0", "1 TB", "2 TB", "3 TB", "4 TB"],
  );
  assert.equal(scale.step, TB);
});

test("byteAxisScale: 非 1024 边界（1e9 B）不产生长小数标签", () => {
  const scale = byteAxisScale(1_000_000_000);
  // 1e9 B 不是整 GB：步长落在 MB 档，标签是整数 MB。
  assert.deepEqual(
    scale.ticks.map(formatByteAxisTick),
    ["0", "250 MB", "500 MB", "750 MB", "1000 MB"],
  );
  for (const label of scale.ticks.map(formatByteAxisTick)) {
    assert.doesNotMatch(label, /\.\d{2,}/, `too many decimals: ${label}`);
  }
});

test("formatByteAxisTick: 0 无单位，其余按 1024 单位并保留至多一位小数", () => {
  assert.equal(formatByteAxisTick(0), "0");
  assert.equal(formatByteAxisTick(2.5 * TB), "2.5 TB");
  assert.equal(formatByteAxisTick(512 * 1024), "512 KB");
  assert.equal(formatByteAxisTick(Number.NaN), "—");
});

test("timeAxisTicks: 168h 每天一个刻度，标签不重复", () => {
  const start = Date.UTC(2026, 10, 18, 1, 0, 0) / 1000; // 2026-11-18 09:00 UTC+8
  const end = start + 167 * 3600;
  const ticks = timeAxisTicks(start, end);
  assert.deepEqual(
    ticks.map((tick) => tick.label),
    ["11/19", "11/20", "11/21", "11/22", "11/23", "11/24", "11/25"],
  );
  assert.equal(new Set(ticks.map((tick) => tick.label)).size, ticks.length);
  for (const tick of ticks) {
    // UTC+8 的零点：加 8h 后能被 1 天整除。
    assert.equal((tick.ts + 8 * 3600) % 86_400, 0, "daily tick at midnight");
  }
});

test("timeAxisTicks: 右端正好是零点时不把日期标签压在边上", () => {
  const start = Date.UTC(2026, 10, 17, 16, 0, 0) / 1000; // 11/18 00:00 UTC+8
  const end = start + 168 * 3600; // 11/25 00:00 UTC+8
  const ticks = timeAxisTicks(start, end);
  // 左端零点刻度保留（落在 y 轴留白里），右端零点刻度丢弃（会被裁切）。
  assert.deepEqual(
    ticks.map((tick) => tick.label),
    ["11/18", "11/19", "11/20", "11/21", "11/22", "11/23", "11/24"],
  );
  assert.equal(ticks.at(-1).ts, end - 86_400);
  assert.ok(ticks.every((tick) => tick.ts < end));
});

test("timeAxisTicks: 24h 用带时刻的刻度，首尾同小时也不会重复", () => {
  const start = Date.UTC(2026, 10, 18, 1, 0, 0) / 1000; // 09:00 UTC+8
  const ticks = timeAxisTicks(start, start + 24 * 3600);
  assert.deepEqual(
    ticks.map((tick) => tick.label),
    ["09:00", "15:00", "21:00", "03:00"],
  );
  assert.equal(new Set(ticks.map((tick) => tick.label)).size, ticks.length);
});

test("timeAxisTicks: 只有一个点或非法窗口时不画刻度", () => {
  const start = Date.UTC(2026, 10, 18, 1, 0, 0) / 1000;
  assert.deepEqual(timeAxisTicks(start, start), []);
  assert.deepEqual(timeAxisTicks(Number.NaN, start), []);
  assert.deepEqual(timeAxisTicks(start, start - 10), []);
});
