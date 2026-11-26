import { createContext } from "react";
import type { TemplateHighlight } from "@/lib/chainTemplateGraph";

/**
 * 画布里的 hover / focus 高亮：点亮卡片或连线到入口的路径，其余压到 35%。
 *
 * 放在 context（而不是每个节点的 data）里：hover 只让读 context 的卡片 /
 * 连线重新渲染，`nodes` / `edges` 数组本身保持引用稳定，React Flow 不必
 * 重建整张图。
 */
export interface TemplateFlowInteraction {
  highlight: TemplateHighlight | null;
  /** 当前 hover / focus 的卡片 id（画焦点环用）。 */
  activeId: string | null;
  activate: (id: string) => void;
  deactivate: () => void;
  /** 当前 hover / focus 的连线 id（时延药丸 / 合并虚线）。 */
  activeEdgeId: string | null;
  activateEdge: (id: string) => void;
  deactivateEdge: () => void;
  /** 当前悬停 / 聚焦的竖线 x：密集药丸只有这一条线默认显示。 */
  activeRail: number | null;
  activateRail: (railX: number) => void;
  deactivateRail: () => void;
}

export const TemplateFlowInteractionContext =
  createContext<TemplateFlowInteraction | null>(null);

/** 卡片头部缩放栏用的命令式 API（`适应窗口` / `−` / `+`）。 */
export interface TemplateFlowApi {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
}
