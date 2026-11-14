import assert from "node:assert/strict";
import test from "node:test";
import {
  LOW_DAYS_LEFT,
  LOW_TRAFFIC_RATIO,
  OVERVIEW_TEXT_CLASS,
  dailyAverage,
  daysTone,
  trafficTone,
} from "./meOverview.ts";

const GB = 1024 ** 3;
const LIMIT = 100 * GB;

test("trafficTone keeps unlimited packages at the default tone", () => {
  assert.equal(trafficTone(null, LIMIT), "default");
  assert.equal(trafficTone(undefined, null), "default");
  // 显式不限（quota = 0）时后端可能仍给出剩余值：分母非正数不告警。
  assert.equal(trafficTone(50 * GB, 0), "default");
  assert.equal(trafficTone(50 * GB, null), "default");
});

test("trafficTone marks exhausted quota as destructive before ratio", () => {
  assert.equal(trafficTone(0, LIMIT), "destructive");
  // 防御：脏数据出现负剩余时也按已用尽处理，而不是画成 warning。
  assert.equal(trafficTone(-1, LIMIT), "destructive");
  assert.equal(trafficTone(0, 0), "destructive");
});

test("trafficTone warns only below the 20% line", () => {
  const low = LIMIT * LOW_TRAFFIC_RATIO;
  assert.equal(trafficTone(low - 1, LIMIT), "warning");
  // 边界：恰好 20% 仍是安全区。
  assert.equal(trafficTone(low, LIMIT), "default");
  assert.equal(trafficTone(LIMIT / 2, LIMIT), "default");
  // 剩余为 1 字节时是 warning，不会因为四舍五入丢掉告警。
  assert.equal(trafficTone(1, LIMIT), "warning");
});

test("trafficTone tolerates non-finite input", () => {
  assert.equal(trafficTone(Number.NaN, LIMIT), "default");
  assert.equal(trafficTone(Number.POSITIVE_INFINITY, LIMIT), "default");
  assert.equal(trafficTone(10 * GB, Number.NaN), "default");
});

test("daysTone warns at 7 days or fewer", () => {
  assert.equal(daysTone(LOW_DAYS_LEFT), "warning");
  assert.equal(daysTone(LOW_DAYS_LEFT - 1), "warning");
  assert.equal(daysTone(0), "warning");
  assert.equal(daysTone(-3), "warning");
  // 边界外侧不告警。
  assert.equal(daysTone(LOW_DAYS_LEFT + 1), "default");
  assert.equal(daysTone(365), "default");
});

test("daysTone leaves never-expiring and missing values neutral", () => {
  assert.equal(daysTone(null), "default");
  assert.equal(daysTone(undefined), "default");
  assert.equal(daysTone(Number.NaN), "default");
});

test("tone maps only reuse existing warning / destructive tokens", () => {
  assert.equal(OVERVIEW_TEXT_CLASS.default, "");
  assert.equal(OVERVIEW_TEXT_CLASS.warning, "text-warning");
  assert.equal(OVERVIEW_TEXT_CLASS.destructive, "text-destructive");
});

test("dailyAverage returns null when the window has no data", () => {
  // 没有序列（未加载 / 查询失败）时不能画成 0。
  assert.equal(dailyAverage([]), null);
  assert.equal(dailyAverage(null), null);
  assert.equal(dailyAverage(undefined), null);
});

test("dailyAverage divides by every day of the window, zeros included", () => {
  // 只有 1 天时，日均就是当天的值。
  assert.equal(dailyAverage([{ weighted: 800 }]), 800);
  // 0 是「缺失日补 0」的真实数据，仍占分母，不能被当成没数据丢掉。
  assert.equal(dailyAverage([{ weighted: 0 }]), 0);
  assert.equal(
    dailyAverage([
      { weighted: 700 },
      { weighted: 0 },
      { weighted: 0 },
      { weighted: 100 },
    ]),
    200,
  );
  // 7 天窗口：总和 / 7，而不是「有流量的天数」。
  assert.equal(
    dailyAverage([
      0, 0, 0, 0, 0, 0, 1200,
    ].map((weighted) => ({ weighted }))),
    1200 / 7,
  );
});

test("dailyAverage skips corrupted entries instead of blanking the metric", () => {
  // 非有限值不参与求和与分母，其他天仍能给出日均。
  assert.equal(
    dailyAverage([
      { weighted: 100 },
      { weighted: Number.NaN },
      { weighted: 300 },
    ]),
    200,
  );
  assert.equal(dailyAverage([{ weighted: Number.POSITIVE_INFINITY }]), null);
  assert.equal(dailyAverage([{ weighted: Number.NEGATIVE_INFINITY }]), null);
});
