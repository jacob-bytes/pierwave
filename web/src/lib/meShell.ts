import { useOutletContext } from "react-router-dom";
import type { MeSummary } from "@/lib/api";

/** `/me` 布局路由通过 `<Outlet context>` 传给四个分页的共享数据。 */
export interface MeShellContext {
  summary: MeSummary;
}

/**
 * 取 `MeShell` 已加载的 summary；四个分页共用同一份请求，切标签不重复加载。
 * 只允许在 `/me` 布局路由的子路由里调用。
 */
export function useMeShellSummary(): MeSummary {
  const context = useOutletContext<MeShellContext | undefined>();
  if (!context) {
    throw new Error("Me pages must be rendered inside the /me layout route");
  }
  return context.summary;
}
