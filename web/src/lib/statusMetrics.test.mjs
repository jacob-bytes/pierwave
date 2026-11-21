import assert from "node:assert/strict";
import test from "node:test";
import { compactRatePair } from "./netRate.ts";
import {
  inboundCount,
  latencyTrend,
  outageMinutesParts,
  serviceAgeDays,
  serviceAgeLabel,
  weekAvailability,
} from "./publicStatus.ts";

const DAY = 86_400;

test("outageMinutesParts splits precise minutes and rejects missing values", () => {
  assert.deepEqual(outageMinutesParts(0), { hours: 0, minutes: 0 });
  assert.deepEqual(outageMinutesParts(12), { hours: 0, minutes: 12 });
  assert.deepEqual(outageMinutesParts(60), { hours: 1, minutes: 0 });
  assert.deepEqual(outageMinutesParts(192), { hours: 3, minutes: 12 });
  assert.deepEqual(outageMinutesParts(180.9), { hours: 3, minutes: 0 });

  // null 是「不知道」，不是 0 分钟；UI 必须显示 —。
  assert.equal(outageMinutesParts(null), null);
  assert.equal(outageMinutesParts(undefined), null);
  assert.equal(outageMinutesParts(Number.NaN), null);
  assert.equal(outageMinutesParts(Number.POSITIVE_INFINITY), null);
  assert.equal(outageMinutesParts(-1), null);
});

test("serviceAgeDays counts whole service days and never goes negative", () => {
  const now = 1_792_000_000_000;
  assert.equal(serviceAgeDays(now / 1_000 - 45 * DAY, now), 45);
  assert.equal(serviceAgeDays(now / 1_000 - DAY, now), 1);
  assert.equal(serviceAgeDays(now / 1_000 - 1, now), 0);
  // 时钟偏差把 first_seen 放到未来时，显示「不足 1 天」，不显示负数。
  assert.equal(serviceAgeDays(now / 1_000 + 10 * DAY, now), 0);
  assert.equal(serviceAgeDays(null, now), null);
  assert.equal(serviceAgeDays(undefined, now), null);
  assert.equal(serviceAgeDays(0, now), null);
  assert.equal(serviceAgeDays(Number.NaN, now), null);
  assert.equal(serviceAgeDays(now / 1_000, 0), null);
});

test("serviceAgeLabel distinguishes a running service from a fresh one", () => {
  const now = 1_792_000_000_000;
  assert.deepEqual(serviceAgeLabel(now / 1_000 - 45 * DAY, now), {
    key: "publicStatus.detail.runningDays",
    values: { days: 45 },
  });
  assert.deepEqual(serviceAgeLabel(now / 1_000 - DAY, now), {
    key: "publicStatus.detail.runningOneDay",
  });
  assert.deepEqual(serviceAgeLabel(now / 1_000 - 60, now), {
    key: "publicStatus.detail.runningJustStarted",
  });
  assert.equal(serviceAgeLabel(null, now), null);
});

test("weekAvailability keeps seven slots, null days and clamped ratios", () => {
  const days = [
    { day: "2026-11-15", online_ratio: 1, samples: 288 },
    null,
    { day: "2026-11-17", online_ratio: 0.9123, samples: 288 },
    { day: "2026-11-18", online_ratio: 2, samples: -1 },
    { day: "2026-11-19", online_ratio: Number.NaN, samples: 288 },
    { day: " 2026-11-20 ", online_ratio: 0.5 },
    { day: "2026-11-21", online_ratio: 0.9973, samples: 288 },
  ];
  const result = weekAvailability(days);
  assert.equal(result.length, 7);
  assert.deepEqual(result[0], { day: "2026-11-15", ratio: 1, samples: 288 });
  assert.deepEqual(result[1], { day: null, ratio: null, samples: null });
  assert.deepEqual(result[2], {
    day: "2026-11-17",
    ratio: 0.9123,
    samples: 288,
  });
  assert.equal(result[3].ratio, 1, "越界比例夹到 0..1");
  assert.equal(result[3].samples, null, "负采样数按缺失处理");
  assert.equal(result[4].ratio, null, "NaN 是缺失，不是 0");
  assert.deepEqual(result[5], { day: "2026-11-20", ratio: 0.5, samples: null });
  assert.deepEqual(result[6], {
    day: "2026-11-21",
    ratio: 0.9973,
    samples: 288,
  });

  // 字段缺失 → 整条隐藏；空数组同样没有可画的内容。
  assert.equal(weekAvailability(undefined), null);
  assert.equal(weekAvailability(null), null);
  assert.equal(weekAvailability([]), null);

  // 少于 7 天时向「更早」补 null，最新一天仍在最右。
  const short = weekAvailability([
    { day: "2026-11-20", online_ratio: 1, samples: 1 },
    { day: "2026-11-21", online_ratio: 1, samples: 1 },
  ]);
  assert.equal(short.length, 7);
  assert.equal(short[5].day, "2026-11-20");
  assert.equal(short[6].day, "2026-11-21");
  assert.equal(short[0].ratio, null);

  // 多于 7 天只取最后 7 天。
  const long = weekAvailability(
    Array.from({ length: 10 }, (_, index) => ({
      day: `2026-11-${String(10 + index).padStart(2, "0")}`,
      online_ratio: 1,
      samples: 1,
    })),
  );
  assert.equal(long.length, 7);
  assert.equal(long[0].day, "2026-11-13");
  assert.equal(long[6].day, "2026-11-19");
});

test("compactRatePair uses one unit for both directions", () => {
  const MB = 1024 * 1024;
  const KB = 1024;
  assert.deepEqual(compactRatePair(17.5 * MB, 2.19 * MB), {
    rx: "17.5",
    tx: "2.19",
    unit: "MB/s",
  });
  // 上行明显更大时，两方向都换算到上行单位，避免 label 单位说谎。
  assert.deepEqual(compactRatePair(900 * KB, 2 * MB), {
    rx: "0.88",
    tx: "2",
    unit: "MB/s",
  });
  assert.deepEqual(compactRatePair(0, 0), {
    rx: "0",
    tx: "0",
    unit: "B/s",
  });
  assert.deepEqual(compactRatePair(0.4, null), {
    rx: "<1",
    tx: null,
    unit: "B/s",
  });
  assert.equal(compactRatePair(null, null), null);
  assert.equal(compactRatePair(Number.NaN, -1), null);
});

test("latencyTrend summarises valid 24h latency readings", () => {
  const series = {
    latency_ms: [18, null, 24, 12, Number.NaN, -3, 20],
  };
  assert.deepEqual(latencyTrend(series), {
    min: 12,
    max: 24,
    avg: 19,
    samples: 4,
  });
  assert.deepEqual(latencyTrend({ latency_ms: [18] }), {
    min: 18,
    max: 18,
    avg: 18,
    samples: 1,
  });
  assert.equal(latencyTrend({ latency_ms: [null, Number.NaN] }), null);
  assert.equal(latencyTrend({ latency_ms: [] }), null);
  assert.equal(latencyTrend(null), null);
  assert.equal(latencyTrend(undefined), null);
});

test("inboundCount keeps real zero and rejects invalid counts", () => {
  assert.equal(inboundCount(3), 3);
  assert.equal(inboundCount(0), 0);
  assert.equal(inboundCount(3.9), 3);
  assert.equal(inboundCount(null), null);
  assert.equal(inboundCount(undefined), null);
  assert.equal(inboundCount(-1), null);
  assert.equal(inboundCount(Number.NaN), null);
  assert.equal(inboundCount(Number.POSITIVE_INFINITY), null);
});
