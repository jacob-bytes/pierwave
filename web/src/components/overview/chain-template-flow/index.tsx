import { lazy } from "react";
import type { ChainTemplateFlowProps } from "./ChainTemplateFlow";

/**
 * React Flow 只在模板详情弹窗打开时加载：这里只做动态 import，
 * 静态图 / 主 chunk 不会因此多出 `@xyflow/react`。
 */
export const ChainTemplateFlowLazy = lazy(() =>
  import("./ChainTemplateFlow").then((module) => ({
    default: module.ChainTemplateFlow,
  })),
);

export type { ChainTemplateFlowProps };
