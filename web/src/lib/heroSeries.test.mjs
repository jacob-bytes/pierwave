import assert from "node:assert/strict";
import test from "node:test";
import {
  HERO_UPTIME_BUCKETS,
  heroLatencySeries,
  heroRateSeries,
  heroUptimeSeries,
} from "./heroSeries.ts";

/**
 * Hero 三张迷你图的数据整理。
 *
 * 这一层的三条硬约定，任何一条被破坏都会把「没有数据」画成「0」：
 * 1. null / 负数 / 非有限数 = 没有采样，保持 null，不转换成 0；
 * 2. 真实测到的 0 是有效值，必须留下；
 * 3. 数组长度以最长的一条为准，缺位补 null；完全没有任何数组时返回 null。
 */

test("rate series keeps null as a gap and keeps a real zero", () => {
  const series = {
    window_secs: 3600,
    step_secs: 300,
    t: [100, 200, 300, 400],
    rate_rx_bps: [10, null, 30, 0],
    rate_tx_bps: [1, 2, null, 0],
    latency_ms: [20, null, 40, 50],
  };

  assert.deepEqual(heroRateSeries(series), {
    ts: [100, 200, 300, 400],
    rx: [10, null, 30, 0],
    tx: [1, 2, null, 0],
  });
});

test("rate series is absent when the backend does not send it", () => {
  assert.equal(heroRateSeries(undefined), null);
  assert.equal(heroRateSeries(null), null);
  assert.equal(heroRateSeries({}), null);
  // 只有时间轴、没有速率数组：仍然是没有数据。
  assert.equal(heroRateSeries({ t: [1, 2, 3] }), null);
  // 空数组也是没有数据，不能画成一条 0 线。
  assert.equal(
    heroRateSeries({ t: [], rate_rx_bps: [], rate_tx_bps: [] }),
    null,
  );
  // 全 null（后端已上线但还没攒够采样）同样是空态。
  assert.equal(
    heroRateSeries({
      t: [1, 2],
      rate_rx_bps: [null, null],
      rate_tx_bps: [null, null],
    }),
    null,
  );
});

test("rate series keeps one direction when the other has no samples", () => {
  assert.deepEqual(
    heroRateSeries({
      t: [1, 2],
      rate_rx_bps: [10, 20],
      rate_tx_bps: [null, null],
    }),
    { ts: [1, 2], rx: [10, 20], tx: [null, null] },
  );
});

test("rate series aligns ragged arrays on the longest one", () => {
  assert.deepEqual(
    heroRateSeries({
      t: [10, 20],
      rate_rx_bps: [1, 2, 3, 4],
      rate_tx_bps: [5],
    }),
    {
      ts: [10, 20, null, null],
      rx: [1, 2, 3, 4],
      tx: [5, null, null, null],
    },
  );
});

test("rate series rejects dirty numbers but keeps zero", () => {
  const { rx, tx } = heroRateSeries({
    t: [1, 2, 3, 4, 5],
    rate_rx_bps: [-1, Number.NaN, Number.POSITIVE_INFINITY, "12", 0],
    rate_tx_bps: [null, undefined, 7, 0, -5],
  });

  assert.deepEqual(rx, [null, null, null, null, 0], "0 是有效流量");
  assert.deepEqual(tx, [null, null, 7, 0, null]);
});

test("latency series maps only the latency array", () => {
  assert.deepEqual(
    heroLatencySeries({
      window_secs: 3600,
      step_secs: 300,
      t: [1, 2, 3],
      latency_ms: [20, null, 0],
    }),
    { ts: [1, 2, 3], values: [20, null, 0] },
  );

  assert.equal(heroLatencySeries(undefined), null);
  assert.equal(heroLatencySeries({ t: [1, 2] }), null);
  assert.equal(
    heroLatencySeries({ latency_ms: [null, null] }),
    null,
    "全 null 时整张图进空态，不能退化成 0 ms 平线",
  );
});

test("latency series drops dirty readings and keeps null gaps", () => {
  assert.deepEqual(
    heroLatencySeries({
      t: [1, 2, 3, 4],
      latency_ms: [-3, Number.NaN, 41, "8"],
    }),
    { ts: [1, 2, 3, 4], values: [null, null, 41, null] },
  );
});

const bucket = (ts, online_ratio) => ({ ts, online_ratio });

/** 8 台服务器、24 个桶的公开页形状；每格可单独覆写。 */
function uptimeServer(buckets) {
  return { buckets_24h: buckets };
}

function emptyBuckets() {
  return Array.from({ length: HERO_UPTIME_BUCKETS }, () => null);
}

test("uptime series always has 24 buckets", () => {
  assert.equal(HERO_UPTIME_BUCKETS, 24);
  const result = heroUptimeSeries([]);
  assert.equal(result.ts.length, 24);
  assert.equal(result.values.length, 24);
  assert.ok(result.values.every((value) => value === null));
  assert.ok(result.ts.every((value) => value === null));
});

test("uptime series averages each hour across servers, skipping missing buckets", () => {
  const a = emptyBuckets();
  const b = emptyBuckets();
  a[0] = bucket(100, 1);
  a[2] = bucket(102, 0.5);
  b[0] = bucket(100, 0.5);
  b[1] = bucket(101, 1);
  b[2] = bucket(102, null);

  const result = heroUptimeSeries([
    uptimeServer(a),
    uptimeServer(b),
  ]);

  // 100 小时两台都有采样：均值 0.75；时间戳取第一台的非 null 桶。
  assert.equal(result.values[0], 0.75);
  assert.equal(result.ts[0], 100);
  // 101 小时只有 b 有采样，不能把 a 当成 0%。
  assert.equal(result.values[1], 1);
  assert.equal(result.ts[1], 101);
  // 102 小时 a 有 0.5、b 的桶存在但比例是 null：只算 a。
  assert.equal(result.values[2], 0.5);
  assert.equal(result.ts[2], 102);
  // 其余 21 个小时都没有采样。
  assert.deepEqual(result.values.slice(3), Array(21).fill(null));
});

test("uptime series clamps dirty ratios and tolerates bad shapes", () => {
  const buckets = emptyBuckets();
  buckets[0] = bucket(100, 2);
  buckets[1] = bucket(101, -1);
  buckets[2] = bucket(102, Number.NaN);
  buckets[3] = "not a bucket";
  buckets[4] = bucket(104, 0.98);

  const result = heroUptimeSeries([
    uptimeServer(buckets),
    { buckets_24h: null },
    { buckets_24h: undefined },
    {},
  ]);

  assert.equal(result.values[0], 1, ">1 的比例夹到 1");
  assert.equal(result.values[1], 0, "<0 的比例夹到 0");
  assert.equal(result.values[2], null, "NaN 是脏数据，不算 0");
  assert.equal(result.values[3], null, "非法桶跳过");
  assert.equal(result.values[4], 0.98);
});

test("uptime series tolerates a server list without buckets", () => {
  const result = heroUptimeSeries([
    { buckets_24h: undefined },
    { buckets_24h: [] },
  ]);
  assert.ok(result.values.every((value) => value === null));
});
