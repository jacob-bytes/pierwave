import assert from "node:assert/strict";
import test from "node:test";
import { trafficDayOverDay } from "./trafficDelta.ts";

const day = (date, weighted) => ({ date, weighted, uplink: 0, downlink: 0 });

test("trafficDayOverDay returns null when there is no previous period", () => {
  assert.equal(trafficDayOverDay(undefined), null);
  assert.equal(trafficDayOverDay([]), null);
  assert.equal(trafficDayOverDay([day("2026-11-08", 100)]), null);
});

test("trafficDayOverDay returns null when yesterday is zero or missing", () => {
  assert.equal(
    trafficDayOverDay([day("2026-11-07", 0), day("2026-11-08", 100)]),
    null,
  );
  assert.equal(
    trafficDayOverDay([day("2026-11-07", -5), day("2026-11-08", 100)]),
    null,
  );
  assert.equal(
    trafficDayOverDay([
      day("2026-11-07", Number.NaN),
      day("2026-11-08", 100),
    ]),
    null,
  );
});

test("trafficDayOverDay computes increase and decrease from the last two days", () => {
  assert.equal(
    trafficDayOverDay([
      day("2026-11-05", 999),
      day("2026-11-07", 90),
      day("2026-11-08", 99),
    ]),
    10,
  );
  assert.equal(
    trafficDayOverDay([day("2026-11-07", 200), day("2026-11-08", 150)]),
    -25,
  );
  assert.equal(
    trafficDayOverDay([day("2026-11-07", 100), day("2026-11-08", 0)]),
    -100,
  );
});
