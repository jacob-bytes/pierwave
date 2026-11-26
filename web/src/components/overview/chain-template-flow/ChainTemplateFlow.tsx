import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type CoordinateExtent,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import {
  TEMPLATE_MAX_ZOOM,
  TEMPLATE_MIN_ZOOM,
  TEMPLATE_PADDING,
  TEMPLATE_PAN_RATIO,
  clampTemplateZoom,
  stepTemplateZoom,
  fitViewport,
  foldTemplateGraph,
  hasHiddenContentBelow,
  hiddenRightColumns,
  highlightTemplateEdgePath,
  highlightTemplatePath,
  initialViewport,
  layoutTemplateGraph,
  templateCanvasHeight,
  templatePanDuration,
  type TemplateGraph,
  type TemplateSize,
  type TemplateViewport,
} from "@/lib/chainTemplateGraph";
import { TemplateCardNode } from "./FlowCard";
import { TemplateColumnHeaderNode } from "./FlowColumnHeader";
import { TemplateEdgeLayer } from "./FlowEdge";
import {
  TemplateFlowInteractionContext,
  type TemplateFlowApi,
} from "./context";

export interface ChainTemplateFlowProps {
  graph: TemplateGraph;
  /** 模板名，用于画布的 aria 描述。 */
  templateName: string;
  /** 被展开的列（seq）：该列不再折叠。 */
  expandedColumns: ReadonlySet<number>;
  /** 被展开的目标组（上游卡片 id）。 */
  expandedTargets: ReadonlySet<string>;
  onExpandColumn: (seq: number) => void;
  onExpandTargets: (upstreamId: string) => void;
  onZoomChange: (zoom: number) => void;
  onReady: (api: TemplateFlowApi | null) => void;
}

const nodeTypes: NodeTypes = {
  templateCard: TemplateCardNode,
  templateColumnHeader: TemplateColumnHeaderNode,
};
const edgeTypes: EdgeTypes = { templateEdge: TemplateEdgeLayer };

/** 移动端断点与 Tailwind `sm` 对齐：<640 不缩放，1 倍 + 横向滚动。 */
const COMPACT_QUERY = "(max-width: 639px)";

/**
 * 「右侧 / 下方还有」按钮共用的外观：同尺寸、同焦点环。
 * 与渐隐层同在 React Flow 根节点的 stacking context 里；z-20 高于署名
 * （z-index 6），按钮永远可点。
 */
const HINT_BUTTON_CLASS =
  "absolute z-20 inline-flex items-center gap-0.5 rounded-full border border-border bg-background/90 px-2 py-1 text-[11px] leading-none text-muted-foreground shadow-card backdrop-blur transition-colors duration-150 hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none";

function FlowCanvas({
  graph,
  templateName,
  expandedColumns,
  expandedTargets,
  onExpandColumn,
  onExpandTargets,
  onZoomChange,
  onReady,
}: ChainTemplateFlowProps) {
  const { t: translate } = useI18n();
  const prefersReducedMotion = usePrefersReducedMotion();
  const { getViewport, setViewport } = useReactFlow();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<TemplateSize | null>(null);
  const [compact, setCompact] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeRail, setActiveRail] = useState<number | null>(null);
  const railTimer = useRef<number | null>(null);
  const [viewport, setViewportState] = useState<TemplateViewport | null>(null);
  const [viewportHeight, setViewportHeight] = useState<number>(() =>
    typeof window === "undefined" ? 800 : window.innerHeight,
  );

  const folded = useMemo(
    () => foldTemplateGraph(graph, { expandedColumns, expandedTargets }),
    [expandedColumns, expandedTargets, graph],
  );
  const layout = useMemo(() => layoutTemplateGraph(folded), [folded]);
  /**
   * 高亮来源二选一：连线的悬停优先（它比卡片更具体），否则看卡片。
   * 展开 / 折叠后原来的卡片或连线可能已消失：空集合当成「没有高亮」，
   * 否则整张图会被 35% 压暗。
   */
  const [activeEdgeId, setActiveEdgeId] = useState<string | null>(null);
  const highlight = useMemo(() => {
    if (activeEdgeId !== null) {
      const next = highlightTemplateEdgePath(folded, activeEdgeId);
      if (next.nodes.size > 0) return next;
    }
    if (activeId === null) return null;
    const next = highlightTemplatePath(folded, activeId);
    return next.nodes.size === 0 ? null : next;
  }, [activeEdgeId, activeId, folded]);
  const activateRail = useCallback((railX: number) => {
    if (railTimer.current !== null) {
      window.clearTimeout(railTimer.current);
      railTimer.current = null;
    }
    setActiveRail(railX);
  }, []);
  const deactivateRail = useCallback(() => {
    if (railTimer.current !== null) window.clearTimeout(railTimer.current);
    // 从竖线移到药丸会先触发 leave：留 160ms 给指针进入药丸。
    railTimer.current = window.setTimeout(() => {
      railTimer.current = null;
      setActiveRail(null);
    }, 160);
  }, []);
  useEffect(
    () => () => {
      if (railTimer.current !== null) window.clearTimeout(railTimer.current);
    },
    [],
  );
  const interaction = useMemo(
    () => ({
      highlight,
      activeId,
      activate: (id: string) => setActiveId(id),
      deactivate: () => setActiveId(null),
      activeEdgeId,
      activateEdge: (id: string) => setActiveEdgeId(id),
      deactivateEdge: (id?: string) =>
        setActiveEdgeId((current) =>
          id === undefined || current === id ? null : current,
        ),
      activeRail,
      activateRail,
      deactivateRail,
    }),
    [activateRail, activeEdgeId, activeId, activeRail, deactivateRail, highlight],
  );

  /* ---------------- 断点：390 不缩放，1 倍 + 横向滚动 ---------------- */
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(COMPACT_QUERY);
    const sync = (): void => setCompact(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const sync = (): void => setViewportHeight(window.innerHeight);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  /* ---------------- 宿主尺寸：首次渲染前量好，视口不闪 ---------------- */
  useLayoutEffect(() => {
    const element = hostRef.current;
    if (element === null) return;
    const measure = (): void => {
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
      };
      setSize((previous) =>
        previous !== null &&
        previous.width === next.width &&
        previous.height === next.height
          ? previous
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact]);

  // 画布高度上限 min(640, 视口高度 × 0.52)：大屏下不把弹窗撑到看不见标题。
  const canvasHeight = templateCanvasHeight(
    layout.height + 32,
    viewportHeight,
  );

  const initial = useMemo(() => {
    if (size === null) return null;
    return compact ? { x: 0, y: 0, zoom: 1 } : initialViewport(layout, size);
  }, [compact, layout, size]);

  const translateExtent = useMemo<CoordinateExtent>(
    () => [
      [-TEMPLATE_PADDING, -TEMPLATE_PADDING],
      [layout.width + TEMPLATE_PADDING, layout.height + TEMPLATE_PADDING],
    ],
    [layout.height, layout.width],
  );

  /* ---------------- 节点 / 连线 ---------------- */
  const nodes = useMemo<Node[]>(
    () => [
      ...layout.cards.map((card) => ({
        id: card.id,
        type: "templateCard",
        position: { x: card.x, y: card.y },
        data: {
          card: card.card,
          onExpandColumn,
          onExpandTargets,
        },
        width: card.width,
        height: card.height,
        style: { width: card.width, height: card.height },
        draggable: false,
        selectable: false,
        focusable: false,
        connectable: false,
      })),
      // 列头也是节点：跟着画布缩放 / 平移，但不可拖、不可选、不可聚焦、
      // 不可连线，也不带 `data-template-flow-card`（卡片计数不含它）。
      ...layout.headers.map((header) => ({
        id: `header:${header.seq}`,
        type: "templateColumnHeader",
        position: { x: header.x, y: header.y },
        data: { header },
        width: header.width,
        height: header.height,
        style: { width: header.width, height: header.height },
        draggable: false,
        selectable: false,
        focusable: false,
        connectable: false,
      })),
    ],
    [layout.cards, layout.headers, onExpandColumn, onExpandTargets],
  );

  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: "out",
        targetHandle: "in",
        type: "templateEdge",
        data: { edge },
        selectable: false,
        focusable: false,
        deletable: false,
      })),
    [layout.edges],
  );

  /* ---------------- 缩放：Ctrl / ⌘ + 滚轮、触控板捏合 ---------------- */
  //
  // React Flow 自带的「捏合滚轮」会把 ctrlKey 当成触控板手势、把 delta 放大 10 倍，
  // 鼠标 Ctrl + 滚轮一格就跳 4 倍。这里关掉它的 pinch 滚轮，统一自己处理：
  // 普通滚轮一律不拦（滚弹窗），带修饰键时按指针位置缩放、每格约 1.28 倍。
  useEffect(() => {
    if (compact) return;
    const element = hostRef.current;
    if (element === null) return;
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const viewport = getViewport();
      const next = clampTemplateZoom(
        viewport.zoom * Math.exp(-event.deltaY * 0.0025),
      );
      if (next === viewport.zoom) return;
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const flowX = (pointerX - viewport.x) / viewport.zoom;
      const flowY = (pointerY - viewport.y) / viewport.zoom;
      void setViewport(
        {
          x: pointerX - flowX * next,
          y: pointerY - flowY * next,
          zoom: next,
        },
        { duration: 0 },
      );
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [compact, getViewport, setViewport]);

  const handleInit = useCallback(
    (instance: ReactFlowInstance) => {
      setViewportState(instance.getViewport());
      onZoomChange(instance.getZoom());
    },
    [onZoomChange],
  );

  const handleMove = useCallback(
    (_event: unknown, next: TemplateViewport) => {
      setViewportState(next);
      onZoomChange(next.zoom);
    },
    [onZoomChange],
  );

  /**
   * 右缘 / 下缘提示：首屏按适应窗口缩放，但内容大过 0.4 下限时仍可能
   * 有列 / 行落在视口外；手动放大后也会出现。
   * 判断交给纯函数（`hiddenRightColumns` / `hasHiddenContentBelow`）：
   * 右缘按列内卡片的右边缘算，半截露出的列也计入；下方只看卡片底边，
   * 不看布局尾部留白。视口变化（缩放 / 平移）后自动重算。
   */
  const hiddenRight = useMemo(
    () =>
      compact || size === null || viewport === null
        ? 0
        : hiddenRightColumns(layout, size, viewport),
    [compact, layout, size, viewport],
  );
  const hiddenBelow = useMemo(
    () =>
      !compact &&
      size !== null &&
      viewport !== null &&
      hasHiddenContentBelow(layout, size, viewport),
    [compact, layout, size, viewport],
  );
  // 平移动画是 JS 时长（React Flow `setViewport`），全局 reduced-motion 规则
  // 管不到：这里显式改成 0，减弱动效下直接到终点。
  const panDuration = templatePanDuration(prefersReducedMotion);

  // 点提示平移约一屏；到边界后隐藏的列 / 行归零，提示自然消失。
  const panRight = useCallback(() => {
    if (size === null) return;
    const current = getViewport();
    const minX = Math.min(0, size.width - layout.width * current.zoom);
    const nextX = Math.max(minX, current.x - size.width * TEMPLATE_PAN_RATIO);
    if (nextX === current.x) return;
    void setViewport({ ...current, x: nextX }, { duration: panDuration });
  }, [getViewport, layout.width, panDuration, setViewport, size]);

  const panBelow = useCallback(() => {
    if (size === null) return;
    const current = getViewport();
    const minY = Math.min(0, size.height - layout.height * current.zoom);
    const nextY = Math.max(minY, current.y - size.height * TEMPLATE_PAN_RATIO);
    if (nextY === current.y) return;
    void setViewport({ ...current, y: nextY }, { duration: panDuration });
  }, [getViewport, layout.height, panDuration, setViewport, size]);

  const api = useMemo<TemplateFlowApi>(
    () => ({
      // 按钮缩放锚在左上角：入口列留在视野里，不会「放大就把第一列裁掉」。
      zoomIn: () => {
        const viewport = getViewport();
        void setViewport(
          { ...viewport, zoom: stepTemplateZoom(viewport.zoom, 1) },
          { duration: 0 },
        );
      },
      zoomOut: () => {
        const viewport = getViewport();
        void setViewport(
          { ...viewport, zoom: stepTemplateZoom(viewport.zoom, -1) },
          { duration: 0 },
        );
      },
      fit: () => {
        if (size === null) return;
        void setViewport(fitViewport(layout, size), { duration: 0 });
      },
    }),
    [getViewport, layout, setViewport, size],
  );

  useEffect(() => {
    onReady(api);
    return () => onReady(null);
  }, [api, onReady]);

  return (
    <div
      ref={hostRef}
      role="group"
      aria-label={translate("overview.chainTemplateInsight.topologyAria", {
        name: templateName,
        nodes: layout.cards.length,
        edges: layout.edges.length,
      })}
      data-template-flow
      data-template-flow-mode={compact ? "compact" : "full"}
      data-columns={layout.columns.length}
      className={cn(
        "relative min-w-0 max-w-full",
        compact ? "overflow-x-auto overscroll-x-contain" : "overflow-hidden",
      )}
      style={compact ? { height: layout.height } : { height: canvasHeight }}
    >
      {size !== null && initial !== null ? (
        <TooltipProvider delayDuration={200}>
          <TemplateFlowInteractionContext.Provider value={interaction}>
            {/* React Flow 把 100% 宽高写在 style 后面，外面再套一层给 390 的
                横向滚动提供固定宽度（1 倍画布）。 */}
            <div
              style={
                compact
                  ? { width: layout.width, height: layout.height }
                  : { width: "100%", height: "100%" }
              }
            >
            <ReactFlow
              key={compact ? "compact" : "full"}
              data-template-flow-canvas
              className="template-flow"
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              defaultViewport={initial}
              minZoom={compact ? 1 : TEMPLATE_MIN_ZOOM}
              maxZoom={compact ? 1 : TEMPLATE_MAX_ZOOM}
              panOnDrag={!compact}
              panOnScroll={false}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              preventScrolling={false}
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              elementsSelectable={false}
              translateExtent={compact ? undefined : translateExtent}
              onInit={handleInit}
              onMove={handleMove}
              attributionPosition="bottom-right"
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={16}
                size={1}
                color="var(--border)"
              />
              {/*
               * 渐隐 / 平移提示放在 React Flow 根节点内部：署名
               * （`.react-flow__attribution`）也在这个 stacking context 里，
               * 只有同一层才能用 z-index 把署名抬到渐隐之上；放在根节点外面
               * 时 z-10 会整块压暗右下角的署名（渐隐本身仍盖住画布内容）。
               */}
              {!compact && hiddenRight > 0 ? (
                <>
                  {/* 右缘渐隐：告诉用户画布在视口外还有内容，而不是图就到这里。 */}
                  <div
                    data-template-flow-fade
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-0 z-[5] w-20"
                    style={{
                      background:
                        "linear-gradient(to left, var(--background), transparent)",
                    }}
                  />
                  <button
                    type="button"
                    data-template-flow-more
                    data-columns={hiddenRight}
                    data-pan-duration={panDuration}
                    onClick={panRight}
                    aria-label={translate(
                      "overview.chainTemplateInsight.flowMoreColumnsAria",
                      { n: hiddenRight },
                    )}
                    className={cn(HINT_BUTTON_CLASS, "right-2 bottom-7")}
                  >
                    <span>
                      {translate("overview.chainTemplateInsight.flowMoreColumns", {
                        n: hiddenRight,
                      })}
                    </span>
                    <ChevronRightIcon aria-hidden="true" className="icon-sm" />
                  </button>
                </>
              ) : null}
              {!compact && hiddenBelow ? (
                <>
                  {/* 下缘渐隐：与右缘同构，画布高度被上限卡住时提示下方还有卡片。 */}
                  <div
                    data-template-flow-fade-below
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-16"
                    style={{
                      background:
                        "linear-gradient(to top, var(--background), transparent)",
                    }}
                  />
                  <button
                    type="button"
                    data-template-flow-more-below
                    data-pan-duration={panDuration}
                    onClick={panBelow}
                    aria-label={translate(
                      "overview.chainTemplateInsight.flowMoreBelowAria",
                    )}
                    className={cn(
                      HINT_BUTTON_CLASS,
                      "bottom-2 left-1/2 -translate-x-1/2",
                    )}
                  >
                    <span>
                      {translate("overview.chainTemplateInsight.flowMoreBelow")}
                    </span>
                    <ChevronDownIcon aria-hidden="true" className="icon-sm" />
                  </button>
                </>
              ) : null}
            </ReactFlow>
            </div>
          </TemplateFlowInteractionContext.Provider>
        </TooltipProvider>
      ) : null}
    </div>
  );
}

/**
 * 转发链模板拓扑画布（React Flow）。
 *
 * 懒加载：这个模块只在模板详情弹窗打开时被动态 import，主 chunk 里没有
 * React Flow。卡片 192×64、直角折线、圆角 8、线宽按链数、颜色按状态；
 * hover / focus 卡片或连线（时延药丸 / 合并虚线）点亮它到入口的路径；
 * 折叠卡与目标 `+N` 只展开自己那一组。
 * 桌面滚轮滚弹窗（不缩放），Ctrl / ⌘ + 滚轮缩放 0.4–1.6；触屏只保留按钮缩放
 * （Safari 捏合未验证）。390 固定 1 倍 + 横向滚动；`touch-action: pan-y` 保证
 * 单指上下滑仍滚弹窗。首屏与「适应窗口」一致：整图（含全部列与行）按内容
 * 包围盒 + 内边距缩放到视口内并居中；缩到 0.4 下限仍放不下、或用户放大后，
 * 右缘渐隐并给出「右侧还有 N 列」的平移入口；下方仍有卡片时同样在下缘渐隐
 * 并给出「下方还有内容」。平移动画在减弱动效下改为瞬时（0ms）。
 * 高度上限 min(640, 视口高度 × 0.52)。
 */
export function ChainTemplateFlow(props: ChainTemplateFlowProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}

