import { chainHasTrend, type ChainHealthChain } from "./chainHealth.ts";

/**
 * 链路时延趋势图的「显示哪些链」纯逻辑：URL 参数、默认选择与时间轴范围。
 *
 * 需求（`?series=id1,id2`）：
 * - 参数缺失 = 首次访问，默认勾选当前窗口 P50 最高的 5 条有样本链；
 * - 参数为空串 = 用户主动清空，必须保持空选择（图表走空态），不能回落到默认；
 * - 参数里的 id 只保留当前仍「有整体曲线」的链，无样本链永远不参与选择；
 * - 时间轴取**数据实际覆盖**的最小 / 最大时间，而不是整个窗口的起止。
 *
 * 不依赖 React / DOM，`node:test` 可直接覆盖边界。
 */

/** URL 参数名；与 `?servers=` 一个风格，值是逗号分隔的链 id。 */
export const CHAIN_SERIES_PARAM = "series";

/** 首次访问默认显示几条；24 条链时 5 条足够看出趋势，又不会把卡片压满。 */
export const DEFAULT_CHAIN_SERIES_COUNT = 5;

/**
 * 一条链当前窗口的「当前值」：整体序列里最后一个有效 P50。
 *
 * 与 `chain.latestP50` 不同，这里只看整体曲线（不带逐段求和兜底），
 * 因为下拉里的当前值必须和图上那条线的右端点是同一个数。
 */
export function chainTrendSeriesP50(
  chain: Pick<ChainHealthChain, "series">,
): number | null {
  for (let index = chain.series.length - 1; index >= 0; index -= 1) {
    const point = chain.series[index];
    if (point.p50 !== null && point.samples > 0) return point.p50;
  }
  return null;
}

/**
 * 解析 URL 里的 `series`。
 *
 * - `null` / `undefined`（参数缺失）→ `null`，调用方据此走默认选择；
 * - 空串 / 只有逗号 → `[]`，表示用户明确清空；
 * - 其余按逗号切分、trim、去空、去重并保留原顺序。
 */
export function parseChainSeriesParam(
  raw: string | null | undefined,
): string[] | null {
  if (raw === null || raw === undefined) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** 写回 URL 的值：去空、去重、保持顺序；空选择写成空串。 */
export function serializeChainSeriesParam(ids: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.join(",");
}

/**
 * 默认勾选：当前窗口 P50 **降序**的前 `limit` 条有样本链。
 *
 * 选择降序而不是列表原顺序：默认画面应该先回答「哪几条最慢」。
 * P50 相同（含都取不到值）时按列表原顺序，保证同一份数据每次结果一致。
 * 无整体曲线的链不进入候选，`limit` 只数有样本链。
 */
export function defaultChainSeriesIds(
  chains: readonly ChainHealthChain[],
  limit = DEFAULT_CHAIN_SERIES_COUNT,
): string[] {
  const max = Math.max(0, Math.floor(limit));
  if (max === 0) return [];
  return chains
    .map((chain, index) => ({ chain, index }))
    .filter(({ chain }) => chainHasTrend(chain))
    .map(({ chain, index }) => {
      const p50 = chainTrendSeriesP50(chain);
      return {
        id: chain.id,
        index,
        // 取不到当前值排最后；NaN / Infinity 不参与排序。
        p50: p50 === null || !Number.isFinite(p50) ? null : p50,
      };
    })
    .sort((a, b) => {
      if (a.p50 !== null && b.p50 !== null && a.p50 !== b.p50) {
        return b.p50 - a.p50;
      }
      if (a.p50 === null && b.p50 !== null) return 1;
      if (a.p50 !== null && b.p50 === null) return -1;
      return a.index - b.index;
    })
    .slice(0, max)
    .map((entry) => entry.id);
}

/**
 * 把 URL 状态解析成最终选择集：
 * - 参数缺失 → 默认前 5；
 * - 参数存在（含空串）→ 原样保留其中仍属于「有整体曲线」的 id。
 *
 * 这里**不**回写 URL、也不把不存在的 id 从 URL 删掉：服务器筛选或时窗
 * 切换会让部分链暂时不可见，保留 id 才能切回来时恢复选择。
 */
export function resolveChainSeriesIds(
  raw: string | null | undefined,
  chains: readonly ChainHealthChain[],
): string[] {
  const parsed = parseChainSeriesParam(raw);
  if (parsed === null) return defaultChainSeriesIds(chains);
  const available = new Set(
    chains.filter((chain) => chainHasTrend(chain)).map((chain) => chain.id),
  );
  return parsed.filter((id) => available.has(id));
}

/** 按链列表顺序筛出要画的序列；顺序固定，颜色 / 线型不会因选择而跳。 */
export function selectChainTrendChains(
  chains: readonly ChainHealthChain[],
  ids: readonly string[],
): ChainHealthChain[] {
  const selected = new Set(ids);
  return chains.filter((chain) => selected.has(chain.id) && chainHasTrend(chain));
}

export interface ChainTrendTimeDomain {
  startTs: number;
  endTs: number;
}

/**
 * 折线图 x 轴的实际数据范围：所有**有效样本**（`p50` 非空且 `samples > 0`）
 * 的最小 / 最大时间。
 *
 * `series` 是定长数组，窗口开头 / 结尾的空桶也是点；如果直接用
 * `dataMin` / `dataMax`，轴又会回到整个窗口，左右空白照旧。这里只认有效样本。
 *
 * 只有一个有效样本（或极端情况下时间相同）时向右扩一个桶，避免
 * `start === end` 这种退化的 domain；没有任何样本返回 `null`。
 */
export function chainTrendTimeDomain(
  chains: readonly Pick<ChainHealthChain, "series">[],
  bucketSecs = 900,
): ChainTrendTimeDomain | null {
  let startTs: number | null = null;
  let endTs: number | null = null;
  for (const chain of chains) {
    for (const point of chain.series) {
      if (point.p50 === null || point.samples <= 0) continue;
      if (!Number.isFinite(point.ts)) continue;
      if (startTs === null || point.ts < startTs) startTs = point.ts;
      if (endTs === null || point.ts > endTs) endTs = point.ts;
    }
  }
  if (startTs === null || endTs === null) return null;
  const bucket = Math.max(1, Math.floor(bucketSecs) || 900);
  return endTs > startTs
    ? { startTs, endTs }
    : { startTs, endTs: startTs + bucket };
}
