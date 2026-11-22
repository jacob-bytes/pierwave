import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { Server } from "@/lib/api";
import {
  filterServersByIds,
  isOverviewScopeFiltered,
  resolveOverviewSelection,
  serverIdsSelectionParam,
} from "@/lib/overviewScope";
import { useServers } from "@/lib/queries";

/**
 * 概览级服务器筛选的唯一状态源：URL 的 `?servers=id1,id2`。
 *
 * 默认全选：参数缺失 = 全部服务器；用户主动缩小范围后才写进 URL。
 * 「全选」按钮会删除该参数，「清空」写成空串（空选择 → 四个 tab 都走空态）。
 * 全选不写参数也保证 200+ 台服务器时 URL 不会过长。
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
  const allSelected = useMemo(
    () => !isOverviewScopeFiltered(servers, selectedIds),
    [servers, selectedIds],
  );

  const setSelectedIds = useCallback(
    (ids: readonly string[]) => {
      // 用函数式更新：避免「刚改完筛选立刻切 tab」时用旧的 searchParams
      // 覆盖掉另一个参数（view / servers 互相覆盖）。
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          const value = serverIdsSelectionParam(servers, ids);
          if (value === null) next.delete("servers");
          // 空集合写成 `?servers=`：与「参数缺失 → 全选」区分开。
          else next.set("servers", value);
          return next;
        },
        { replace: true },
      );
    },
    [servers, setSearchParams],
  );

  return {
    servers,
    selectedIds,
    selectedServers,
    filtered,
    allSelected,
    ready: query.isSuccess,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    isFetching: query.isFetching,
    refetch: query.refetch,
    setSelectedIds,
  };
}

export type OverviewScopeState = ReturnType<typeof useOverviewScope>;
