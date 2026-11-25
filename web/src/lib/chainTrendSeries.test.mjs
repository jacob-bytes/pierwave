import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAIN_SERIES_PARAM,
  DEFAULT_CHAIN_SERIES_COUNT,
  chainTrendSeriesP50,
  chainTrendTimeDomain,
  defaultChainSeriesIds,
  parseChainSeriesParam,
  resolveChainSeriesIds,
  selectChainTrendChains,
  serializeChainSeriesParam,
} from "../lib/chainTrendSeries.ts";

/** 构造一条只带测试关心字段的链；默认有一个有效样本。 */
function chain(id, samples = [{ ts: 1_000, p50: 10 }]) {
  return {
    id,
    name: id,
    series: samples.map((point) => ({
      ts: point.ts,
      p50: point.p50 ?? null,
      p10: null,
      p90: null,
      samples: point.p50 === null ? 0 : (point.samples ?? 1),
      lossPct: null,
    })),
  };
}

test("series 参数名固定为 series，默认显示 5 条", () => {
  assert.equal(CHAIN_SERIES_PARAM, "series");
  assert.equal(DEFAULT_CHAIN_SERIES_COUNT, 5);
});

test("parseChainSeriesParam 区分『参数缺失』与『用户清空』", () => {
  assert.equal(parseChainSeriesParam(null), null);
  assert.equal(parseChainSeriesParam(undefined), null);
  // 空串 / 只有逗号：用户主动清空，不能回落到默认。
  assert.deepEqual(parseChainSeriesParam(""), []);
  assert.deepEqual(parseChainSeriesParam(" , ,"), []);
  assert.deepEqual(parseChainSeriesParam("a,b"), ["a", "b"]);
  // trim、去空、去重，保留第一次出现的顺序。
  assert.deepEqual(parseChainSeriesParam(" b , a ,, b "), ["b", "a"]);
});

test("serializeChainSeriesParam 去空去重并保持顺序", () => {
  assert.equal(serializeChainSeriesParam([]), "");
  assert.equal(serializeChainSeriesParam(["a", "b"]), "a,b");
  assert.equal(serializeChainSeriesParam([" b ", "", "a", "b"]), "b,a");
});

test("chainTrendSeriesP50 取最后一个有效样本，不被尾部空桶覆盖", () => {
  const value = chain("a", [
    { ts: 1_000, p50: 20 },
    { ts: 1_900, p50: 40 },
    { ts: 2_800, p50: null },
  ]);
  assert.equal(chainTrendSeriesP50(value), 40);
  assert.equal(
    chainTrendSeriesP50(chain("empty", [{ ts: 1_000, p50: null }])),
    null,
  );
});

test("默认勾选当前窗口 P50 最高的 5 条有样本链", () => {
  const chains = [
    chain("a", [{ ts: 1_000, p50: 10 }]),
    chain("b", [{ ts: 1_000, p50: 90 }]),
    chain("c", [{ ts: 1_000, p50: 30 }]),
    // 无样本链不进入候选，也不占默认的 5 个名额。
    chain("nosamples", [{ ts: 1_000, p50: null }]),
    chain("d", [{ ts: 1_000, p50: 70 }]),
    chain("e", [{ ts: 1_000, p50: 50 }]),
    chain("f", [{ ts: 1_000, p50: 20 }]),
  ];
  assert.deepEqual(defaultChainSeriesIds(chains), ["b", "d", "e", "c", "f"]);
  // 只有 2 条候选时返回 2 条，不补无样本链。
  assert.deepEqual(defaultChainSeriesIds(chains, 2), ["b", "d"]);
  assert.deepEqual(defaultChainSeriesIds([chains[3]]), []);
});

test("默认选择按当前 P50 降序；P50 相同保持原列表顺序", () => {
  const chains = [
    chain("first", [{ ts: 1_000, p50: 40 }]),
    chain("second", [{ ts: 1_000, p50: 40 }]),
    chain("third", [{ ts: 1_000, p50: 80 }]),
  ];
  assert.deepEqual(defaultChainSeriesIds(chains, 3), [
    "third",
    "first",
    "second",
  ]);
});

test("resolveChainSeriesIds：缺失走默认，空串保持空，过期 id 被过滤", () => {
  const chains = [
    chain("a", [{ ts: 1_000, p50: 10 }]),
    chain("b", [{ ts: 1_000, p50: 20 }]),
    chain("nosamples", [{ ts: 1_000, p50: null }]),
  ];
  assert.deepEqual(resolveChainSeriesIds(null, chains), ["b", "a"]);
  // 用户明确清空时，即便有数据也保持空选择，图表走空态。
  assert.deepEqual(resolveChainSeriesIds("", chains), []);
  // 已删除 / 无样本的 id 不画，但合法 id 顺序按 URL 保留。
  assert.deepEqual(resolveChainSeriesIds("a,gone,nosamples,b", chains), [
    "a",
    "b",
  ]);
  assert.deepEqual(resolveChainSeriesIds("gone,nosamples", chains), []);
});

test("selectChainTrendChains 按列表顺序筛出选中链，颜色下标保持稳定", () => {
  const chains = [
    chain("a", [{ ts: 1_000, p50: 10 }]),
    chain("b", [{ ts: 1_000, p50: 20 }]),
    chain("c", [{ ts: 1_000, p50: 30 }]),
    chain("nosamples", [{ ts: 1_000, p50: null }]),
  ];
  assert.deepEqual(
    selectChainTrendChains(chains, ["c", "a", "nosamples"]).map(
      (item) => item.id,
    ),
    ["a", "c"],
  );
});

test("时间轴取有效样本的最小 / 最大时间，窗口首尾空桶不算数据范围", () => {
  const chains = [
    chain("a", [
      { ts: 1_000, p50: null },
      { ts: 1_900, p50: 12 },
      { ts: 2_800, p50: 15 },
      { ts: 3_700, p50: 14 },
      { ts: 4_600, p50: null },
    ]),
    chain("b", [
      { ts: 1_000, p50: null },
      { ts: 1_900, p50: null },
      { ts: 2_800, p50: 20 },
    ]),
  ];
  assert.deepEqual(chainTrendTimeDomain(chains), {
    startTs: 1_900,
    endTs: 3_700,
  });
});

test("没有有效样本时时间轴为 null；单点向右扩一个桶避免退化 domain", () => {
  assert.equal(
    chainTrendTimeDomain([chain("a", [{ ts: 1_000, p50: null }])]),
    null,
  );
  assert.deepEqual(chainTrendTimeDomain([chain("a")], 900), {
    startTs: 1_000,
    endTs: 1_900,
  });
  // 非法桶宽回落到 15 分钟，不产生 NaN / 负值。
  assert.deepEqual(chainTrendTimeDomain([chain("a")], 0), {
    startTs: 1_000,
    endTs: 1_900,
  });
});

test("时间轴按传入的选中链计算，不把未选中链的范围算进来", () => {
  const early = chain("early", [{ ts: 1_000, p50: 10 }]);
  const late = chain("late", [{ ts: 9_000, p50: 10 }]);
  assert.deepEqual(chainTrendTimeDomain([early, late]), {
    startTs: 1_000,
    endTs: 9_000,
  });
  assert.deepEqual(chainTrendTimeDomain([late]), {
    startTs: 9_000,
    endTs: 9_900,
  });
});
