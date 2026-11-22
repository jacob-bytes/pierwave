import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { Server } from "@/lib/api";
import {
  SCOPE_ALL_LIMIT,
  filterServersByIds,
  isOverviewScopeFiltered,
  resolveOverviewSelection,
  serializeServerIds,
} from "@/lib/overviewScope";
import { useServers } from "@/lib/queries";

/**
 * 概览级服务器筛选的唯一状态源：URL 的 `?servers=id1,id2`。
 *
 * 默认选择由服务器列表算出（≤10 台全选，更多时取问题优先的 8 台），
 * 只有用户实际改动后才写进 URL；因此默认页面链接保持干净，分享链接
 * 会带上明确的选择。参数存在但为空串时表示「明确空选」，用于空态截图。
 */
export function useOverviewScope() {
  const query = useServers();
  const servers: Server[] = query.data ?? [];
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("servers");

  const selectedIds = useMemo(
    () => resolveOverviewSelection(servers, raw),
    [servers, raw],
  );
  const selectedServers = useMemo(
    () => filterServersByIds(servers, selectedIds),
    [servers, selectedIds],
  );
  const filtered = isOverviewScopeFiltered(servers, selectedIds);
  const defaulted = raw === null && servers.length > SCOPE_ALL_LIMIT;

  const setSelectedIds = useCallback(
    (ids: readonly string[]) => {
      // 用函数式更新：避免「刚改完筛选立刻切 tab」时用旧的 searchParams
      // 覆盖掉另一个参数（view / servers 互相覆盖）。
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          // 空集合写成 `?servers=`：与「参数缺失 → 默认选择」区分开。
          next.set("servers", serializeServerIds(ids));
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return {
    servers,
    selectedIds,
    selectedServers,
    filtered,
    defaulted,
    ready: query.isSuccess,
    isPending: query.isPending,
    isError: query.isError,
    setSelectedIds,
  };
}

export type OverviewScopeState = ReturnType<typeof useOverviewScope>;
