import { useContext } from "react";
import { EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { useI18n } from "@/i18n";
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

function pulseDelay(seq: number): number {
  return -PULSE_PERIOD_SEC + Math.max(0, seq) * PULSE_STEP_SEC;
}

/**
 * 一条连接：直角折线 + 8px 圆角 + 两端小圆点；线宽按链数、颜色按状态。
 * 不可用 / 被折成员的连线是虚线，且不脉冲；时延用白色药丸贴在竖线上。
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
  const value = edge.unavailable
    ? "—"
    : edge.p50Ms === null
      ? "—"
      : formatMs(edge.p50Ms);
  const aria = t("overview.chainTemplateInsight.flowEdgeAria", {
    source: edge.sourceName,
    target: edge.targetName,
    value,
    chains: edge.chains,
    users: edge.users,
  });
  const hotAttribute =
    interaction?.highlight != null
      ? hot
        ? "true"
        : "false"
      : undefined;

  return (
    <g
      role="img"
      data-template-flow-edge-group
      data-hot={hotAttribute}
      data-dimmed={dimmed ? "true" : undefined}
      aria-label={aria}
    >
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
      {edge.pill !== null ? (
        <EdgeLabelRenderer>
          <div
            data-template-flow-pill
            data-status={edge.status}
            data-unavailable={edge.unavailable ? "true" : "false"}
            className="template-flow-pill nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${edge.pill.x}px, ${edge.pill.y}px)`,
            }}
          >
            {pillText(edge)}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}
