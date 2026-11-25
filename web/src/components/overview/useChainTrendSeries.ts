import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { ChainHealthChain } from "@/lib/chainHealth";
import {
  CHAIN_SERIES_PARAM,
  defaultChainSeriesIds,
  resolveChainSeriesIds,
  serializeChainSeriesParam,
} from "@/lib/chainTrendSeries";

/**
 * 「链路时延趋势」显示哪些链的唯一状态源：URL 的 `?series=id1,id2`。
 *
 * - 参数缺失 = 首次进入，按当前窗口 P50 降序默认勾选前 5 条；
 *   默认集合会**写回 URL**，这样 30 秒轮询导致排名变化时选择不会跳，
 *   刷新 / 切时窗也能保持同一批线；离开链路时延 tab 时由
 *   `applyOverviewView` 清掉 `series`（与 `status` / `q` / `section` 一致）；
 * - 参数为空串 = 用户主动清空，保持空选择，图表走空态；
 * - 只保留仍有整体曲线的链；无样本链永远不进入选择。
 *
 * 写 URL 一律 `replace`：选择线是一块持续调整的视图状态，不该为每次勾选
 * 往历史里塞一条记录，也不能覆盖 `view` / `section` / `servers` 等参数。
 */
export function useChainTrendSeries(chains: readonly ChainHealthChain[]) {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(CHAIN_SERIES_PARAM);
  const explicit = raw !== null;

  const selectedIds = useMemo(
    () => resolveChainSeriesIds(raw, chains),
    [raw, chains],
  );
  const defaultIds = useMemo(
    () => defaultChainSeriesIds(chains),
    [chains],
  );

  // 首次访问把默认选择固化到 URL；之后即使 P50 排名变化也不重新洗牌。
  useEffect(() => {
    if (explicit || defaultIds.length === 0) return;
    const value = serializeChainSeriesParam(defaultIds);
    setSearchParams(
      (previous) => {
        if (previous.get(CHAIN_SERIES_PARAM) === value) return previous;
        const next = new URLSearchParams(previous);
        next.set(CHAIN_SERIES_PARAM, value);
        return next;
      },
      { replace: true },
    );
  }, [defaultIds, explicit, setSearchParams]);

  const setSelectedIds = useCallback(
    (ids: readonly string[]) => {
      const value = serializeChainSeriesParam(ids);
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          // 空选择也写成 `?series=`：与「参数缺失 → 默认 5 条」区分开。
          next.set(CHAIN_SERIES_PARAM, value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { selectedIds, setSelectedIds };
}
