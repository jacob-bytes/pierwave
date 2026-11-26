import { useContext } from "react";
import { EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n, type TFunction } from "@/i18n";
import { formatMs } from "@/lib/chainHealth";
import type { TemplateLayoutEdge } from "@/lib/chainTemplateGraph";
import { cn } from "@/lib/utils";
import { TemplateFlowInteractionContext } from "./context";

export type TemplateEdgeData = {
  edge: TemplateLayoutEdge;
};

const PULSE_PERIOD_SEC = 3.6;
const PULSE_STEP_SEC = 0.18;

/** 药丸只放得下短标签：`120ms` / `1.2s`；精确值在 aria 与 tooltip 里。 */
function pillText(edge: TemplateLayoutEdge): string {
  if (edge.unavailable || edge.p50Ms === null) return "—";
  if (edge.p50Ms >= 1000) {
    return `${(Math.round(edge.p50Ms / 100) / 10).toFixed(1)}s`;
  }
  return `${Math.round(edge.p50Ms)}ms`;
}

/**
 * tooltip / aria 用的时延文案：不可用路径说「最近已知」，没有历史值就说
 * 「不可用」，绝不把 lastP50Ms 当成当前值。
 */
function latencyText(edge: TemplateLayoutEdge, translate: TFunction): string {
  if (!edge.unavailable) {
    return edge.p50Ms === null ? "—" : formatMs(edge.p50Ms);
  }
  if (edge.lastP50Ms !== null) {
    return translate("overview.chainTemplateInsight.edgeLastKnown", {
      value: formatMs(edge.lastP50Ms),
    });
  }
  return translate("overview.chainTemplateInsight.edgeUnavailable");
}

function pulseDelay(seq: number): number {
  return -PULSE_PERIOD_SEC + Math.max(0, seq) * PULSE_STEP_SEC;
}

/** 药丸 / 合并虚线的悬停与聚焦内容：时延、链数、用户数，合并线再说来源。 */
function EdgeTooltip({
  edge,
  latency,
  translate,
}: {
  edge: TemplateLayoutEdge;
  latency: string;
  translate: TFunction;
}) {
  return (
    <div data-template-flow-edge-tooltip>
      <p className="truncate font-medium" title={`${edge.sourceName} → ${edge.targetName}`}>
        {edge.sourceName} → {edge.targetName}
      </p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        {edge.merged ? null : (
          <>
            <dt className="text-background/70">
              {translate("overview.chainTemplateInsight.flowLatency")}
            </dt>
            <dd className="font-mono tabular-nums">{latency}</dd>
          </>
        )}
        <dt className="text-background/70">
          {translate("overview.chainTemplateInsight.tooltipChains")}
        </dt>
        <dd className="font-mono tabular-nums">{edge.chains}</dd>
        <dt className="text-background/70">
          {translate("overview.chainTemplateInsight.tooltipUsers")}
        </dt>
        <dd className="font-mono tabular-nums">{edge.users}</dd>
      </dl>
      {edge.merged ? (
        <p data-template-flow-edge-merged className="mt-1 font-mono tabular-nums">
          {translate("overview.chainTemplateInsight.flowEdgeMergedTooltip", {
            n: edge.paths,
            chains: edge.chains,
          })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 一条连接：直角折线 + 8px 圆角 + 两端小圆点；线宽按链数、颜色按状态。
 * 不可用 / 被折成员的连线是虚线，且不脉冲；时延用白色药丸贴在竖线上。
 *
 * 药丸可聚焦：tooltip 给出时延、链数、用户数（不可用显示「最近已知」）。
 * 同一竖线超过 6 个药丸时默认隐藏，悬停该竖线或聚焦才显示；合并虚线
 * 没有药丸，直接在线条上提供同样的 tooltip 与键盘入口。
 *
 * 路径与药丸落点都由 `layoutTemplateGraph` 算好（纯函数），这里只负责画。
 */
export function TemplateEdgeLayer({ data }: EdgeProps) {
  const { t } = useI18n();
  const edge = (data as unknown as TemplateEdgeData | undefined)?.edge;
  const interaction = useContext(TemplateFlowInteractionContext);
  if (edge === undefined) return null;
  const hot = interaction?.highlight?.edges.has(edge.id) ?? false;
  const dimmed = interaction !== null && interaction.highlight !== null && !hot;
  const latency = latencyText(edge, t);
  const aria = t("overview.chainTemplateInsight.flowEdgeAria", {
    source: edge.sourceName,
    target: edge.targetName,
    value: latency,
    chains: edge.chains,
    users: edge.users,
  });
  const hotAttribute =
    interaction?.highlight != null
      ? hot
        ? "true"
        : "false"
      : undefined;
  const pill = edge.pill;
  const dense = edge.pillDense && pill !== null;
  const railActive =
    interaction?.activeRail != null &&
    pill !== null &&
    Math.abs(interaction.activeRail - pill.x) < 0.5;
  const pillVisible = !dense || railActive;

  // 药丸 / 合并虚线 hover 或聚焦：点亮这条连线到入口的路径（与卡片同一口径，
  // 其余卡片与连线压到 35%）。密集药丸还要顺带点亮整条竖线，否则药丸本身是
  // 隐藏的（`opacity: 0` + `pointer-events: none`），指针根本进不来。
  //
  // 这里会触发 context 更新，但药丸的 DOM 引用不变（同一个元素、同一个
  // TooltipTrigger），Radix 的开启计时不会被重置。
  const onEdgeFocus = (): void => {
    interaction?.activateEdge(edge.id);
    if (dense && pill !== null) interaction?.activateRail(pill.x);
  };
  const onEdgeBlur = (): void => {
    interaction?.deactivateEdge();
    if (dense) interaction?.deactivateRail();
  };

  const edgePath = (
    <path
      data-template-flow-edge
      data-edge-id={edge.id}
      data-chains={edge.chains}
      data-width={edge.width}
      data-unavailable={edge.unavailable ? "true" : "false"}
      data-merged={edge.merged ? "true" : "false"}
      data-pulsed={edge.pulse ? "true" : "false"}
      data-status={edge.status}
      data-dashed={edge.dashed ? "true" : "false"}
      d={edge.path}
      strokeWidth={edge.width}
      className={cn("template-flow-edge", edge.merged && "opacity-80")}
    />
  );

  return (
    <g
      role="img"
      data-template-flow-edge-group
      data-hot={hotAttribute}
      data-dimmed={dimmed ? "true" : undefined}
      aria-label={aria}
    >
      {edgePath}
      {edge.pulse ? (
        <path
          data-template-flow-pulse
          className="template-flow-pulse"
          d={edge.path}
          pathLength={100}
          strokeWidth={Math.max(3, edge.width * 0.9)}
          style={{ animationDelay: `${pulseDelay(edge.sourceSeq).toFixed(3)}s` }}
        />
      ) : null}
      <circle
        data-template-flow-dot
        data-status={edge.status}
        data-end="source"
        cx={edge.x1}
        cy={edge.y1}
        r={2.4}
        className="template-flow-dot"
      />
      <circle
        data-template-flow-dot
        data-status={edge.status}
        data-end="target"
        cx={edge.x2}
        cy={edge.y2}
        r={2.4}
        className="template-flow-dot"
      />
      {/*
       * React Flow 的连线 SVG 层整层 pointer-events: none，SVG 路径吃不到 hover；
       * 密集竖线 / 合并虚线的交互入口因此放在 EdgeLabelRenderer 的 HTML 层。
       */}
      {dense && pill !== null ? (
        <EdgeLabelRenderer>
          <div
            data-template-flow-rail-hit
            data-rail={pill.x}
            aria-hidden="true"
            className="template-flow-rail-hit nodrag nopan"
            style={{
              left: pill.x - 8,
              top: Math.min(edge.y1, edge.y2) - 8,
              width: 16,
              height: Math.abs(edge.y2 - edge.y1) + 16,
            }}
            // 竖带是「揭开密集药丸」的入口，不点亮某条具体连线：同一竖线上的
            // 多条边会叠出多块命中带，落到哪一块是任意的。药丸出来后由药丸
            // 自己点亮它那一条。
            onPointerEnter={() => interaction?.activateRail(pill.x)}
            onPointerLeave={() => interaction?.deactivateRail()}
          />
        </EdgeLabelRenderer>
      ) : null}
      {pill === null && edge.merged ? (
        <EdgeLabelRenderer>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                data-template-flow-edge-trigger
                tabIndex={0}
                role="note"
                aria-label={aria}
                className="template-flow-merged-hit nodrag nopan"
                style={{
                  transform: `translate(-50%, -50%) translate(${edge.railX}px, ${(edge.y1 + edge.y2) / 2}px)`,
                }}
                onPointerEnter={onEdgeFocus}
                onPointerLeave={onEdgeBlur}
                onFocus={onEdgeFocus}
                onBlur={onEdgeBlur}
              />
            </TooltipTrigger>
            <TooltipContent
              side="top"
              sideOffset={6}
              className="max-w-64 bg-foreground text-background"
            >
              <EdgeTooltip edge={edge} latency={latency} translate={t} />
            </TooltipContent>
          </Tooltip>
        </EdgeLabelRenderer>
      ) : null}
      {pill !== null ? (
        <EdgeLabelRenderer>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                data-template-flow-pill
                data-status={edge.status}
                data-unavailable={edge.unavailable ? "true" : "false"}
                data-dense={edge.pillDense ? "true" : "false"}
                data-pill-hidden={pillVisible ? "false" : "true"}
                data-rail={pill.x}
                tabIndex={0}
                role="note"
                aria-label={aria}
                className={cn(
                  "template-flow-pill nodrag nopan transition-opacity duration-150",
                  !pillVisible && "pointer-events-none opacity-0",
                )}
                onFocusCapture={onEdgeFocus}
                onBlurCapture={onEdgeBlur}
                onPointerEnter={onEdgeFocus}
                onPointerLeave={onEdgeBlur}
                style={{
                  transform: `translate(-50%, -50%) translate(${pill.x}px, ${pill.y}px)`,
                }}
              >
                {pillText(edge)}
              </div>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              sideOffset={6}
              className="max-w-64 bg-foreground text-background"
            >
              <EdgeTooltip edge={edge} latency={latency} translate={t} />
            </TooltipContent>
          </Tooltip>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}
