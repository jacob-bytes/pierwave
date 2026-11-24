import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SERVER_HEALTH_MODE,
  SERVER_HEALTH_MODES,
  applyServerHealthMode,
  isServerHealthMode,
  resolveServerHealthMode,
  serverHealthModeParam,
} from "./serverHealthView.ts";

test("呈现方式顺序与默认值是趋势", () => {
  assert.deepEqual(SERVER_HEALTH_MODES, ["heatmap", "trend"]);
  assert.equal(DEFAULT_SERVER_HEALTH_MODE, "trend");
});

test("合法模式原样保留，非法值 / 空值回落到趋势", () => {
  for (const mode of SERVER_HEALTH_MODES) {
    assert.equal(isServerHealthMode(mode), true);
    assert.equal(resolveServerHealthMode(mode), mode);
  }
  for (const value of [null, undefined, "", "Trend", "heat-map", "0"]) {
    assert.equal(isServerHealthMode(value), false);
    assert.equal(resolveServerHealthMode(value), "trend");
  }
  assert.equal(resolveServerHealthMode("toString"), "trend");
});

test("默认趋势不写 URL 参数，热力图写 ?mode=heatmap", () => {
  assert.equal(serverHealthModeParam("trend"), null);
  assert.equal(serverHealthModeParam("heatmap"), "heatmap");
});

test("切换模式只改 mode，保留 view / servers", () => {
  const params = new URLSearchParams("view=server&servers=a,b");
  const heatmap = applyServerHealthMode(params, "heatmap");

  assert.equal(heatmap.get("view"), "server");
  assert.equal(heatmap.get("servers"), "a,b");
  assert.equal(heatmap.get("mode"), "heatmap");
  assert.equal(params.get("mode"), null);

  const trend = applyServerHealthMode(heatmap, "trend");
  assert.equal(trend.get("mode"), null);
  assert.equal(trend.get("servers"), "a,b");
});

test("非法 ?mode= 解析为趋势，切换走后参数被清掉", () => {
  const params = new URLSearchParams("view=server&mode=bogus");
  const mode = resolveServerHealthMode(params.get("mode"));
  const next = applyServerHealthMode(params, mode);

  assert.equal(mode, "trend");
  assert.equal(next.get("mode"), null);
  assert.equal(next.get("view"), "server");
});
