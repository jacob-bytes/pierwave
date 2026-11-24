import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMs } from "@/lib/chainHealth";
import {
  TEMPLATE_NODE_HEADER,
  TEMPLATE_NODE_PADDING_Y,
  TEMPLATE_ROW_HEIGHT,
  chainTemplateHotspots,
  chainTemplateTopology,
  templatePulseSchedule,
  targetLabel,
  type ChainTemplateDetail,
  type ChainTemplateMemberStatus,
  type TopologyColumn,
  type TopologyEdge,
  type TopologyMember,
  type TopologyTarget,
} from "@/lib/chainTemplateInsight";
import { t, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/** 热力背景最多 4 档，全部走 primary 透明度阶梯，不引入新色相。 */
const HEAT_BG: Record<number, string> = {
  0: "",
  1: "bg-primary/[0.06]",
  2: "bg-primary/[0.12]",
  3: "bg-primary/[0.18]",
  4: "bg-primary/[0.26]",
};

const HEAT_LEGEND = [1, 2, 3, 4] as const;

function statusLabel(status: ChainTemplateMemberStatus): string | null {
  if (status === "offline") return t("overview.chainTemplateInsight.offline");
  if (status === "unknown") {
    return t("overview.chainTemplateInsight.unknownStatus");
  }
  return null;
}

function memberTitle(member: TopologyMember): string {
  const parts = [member.name];
  const status = statusLabel(member.status);
  if (status !== null) parts.push(status);
  parts.push(
    t("overview.chainTemplateInsight.memberChains", { n: member.chains }),
    t("overview.chainTemplateInsight.usersValue", { n: member.users }),
  );
  return parts.join(" · ");
}

function nodeLabel(column: TopologyColumn): string {
  if (column.role === "source") {
    return t("overview.chainTemplateInsight.sourceLabel");
  }
  if (column.role === "target") {
    return t("overview.chainTemplateInsight.targetLabel");
  }
  return t("overview.chainTemplateInsight.hopLabel", { seq: column.seq });
}

function columnHasOffline(column: TopologyColumn): boolean {
  return column.members.some((member) => member.offline);
}

function TopologyNode({ column }: { column: TopologyColumn }) {
  const offline = columnHasOffline(column);
  return (
    <div
      data-template-node
      data-role={column.role}
      data-seq={column.seq}
      data-offline={offline ? "true" : "false"}
      style={{
        left: column.x,
        top: column.y,
        width: column.width,
        height: column.height,
      }}
      className={cn(
        "absolute z-10 flex flex-col rounded-md border bg-card px-1.5",
        column.role === "target"
          ? "border-dashed border-border"
          : "border-border",
        offline && "border-destructive/50",
      )}
    >
      <div
        data-template-node-head
        style={{
          height: TEMPLATE_NODE_HEADER,
          marginTop: TEMPLATE_NODE_PADDING_Y,
        }}
        className="flex shrink-0 items-center justify-between gap-1 px-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
      >
        <span className="truncate">{nodeLabel(column)}</span>
        {column.role !== "target" && column.members.length > 0 ? (
          <span
            data-template-node-count
            className="shrink-0 normal-case tracking-normal tabular-nums"
          >
            {t("overview.chainTemplateInsight.memberCount", {
              n: column.members.length,
            })}
          </span>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-col">
        {column.members.length === 0 ? (
          <span className="flex items-center justify-center text-[10px] text-muted-foreground">
            —
          </span>
        ) : null}
        {column.members.map((member) => (
          <div
            key={member.key}
            data-template-member
            data-status={member.status}
            data-heat={member.heat}
            data-chains={member.chains}
            title={memberTitle(member)}
            style={{ height: TEMPLATE_ROW_HEIGHT }}
            className={cn(
              "flex min-w-0 items-center gap-1 rounded-sm px-1",
              HEAT_BG[member.heat] ?? "",
              member.offline &&
                "border border-destructive/50 bg-destructive/5",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                member.offline
                  ? "bg-destructive"
                  : member.status === "online"
                    ? "bg-primary"
                    : "bg-muted-foreground/60",
              )}
            />
            <span
              data-template-member-name
              className={cn(
                "min-w-0 flex-1 truncate text-[10px] leading-tight",
                member.offline
                  ? "text-destructive"
                  : "text-foreground",
              )}
            >
              {member.name}
            </span>
            <span
              data-template-member-chains
              className="shrink-0 font-mono text-[9px] leading-none tabular-nums text-muted-foreground"
            >
              {t("overview.chainTemplateInsight.memberChains", {
                n: member.chains,
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EdgeShape({
  edge,
  delay,
}: {
  edge: TopologyEdge;
  delay: number;
}) {
  return (
    <g data-template-edge-group data-chains={edge.chains}>
      <title>
        {edge.fromMember} → {edge.toMember} ·{" "}
        {edge.unavailable
          ? t("overview.chainTemplateInsight.edgeUnavailable")
          : formatMs(edge.p50Ms)}{" "}
        · {t("overview.chainTemplateInsight.memberChains", { n: edge.chains })}
      </title>
      <path
        data-template-edge
        data-chains={edge.chains}
        data-width={edge.width}
        data-unavailable={edge.unavailable ? "true" : "false"}
        d={edge.path}
        fill="none"
        stroke={edge.unavailable ? "var(--destructive)" : "var(--primary)"}
        strokeOpacity={edge.unavailable ? 0.55 : edge.opacity}
        strokeWidth={edge.width}
        strokeLinecap="round"
        strokeDasharray={edge.unavailable ? "4 4" : undefined}
      />
      {edge.pulse ? (
        <path
          data-template-pulse
          className="template-pulse"
          d={edge.path}
          fill="none"
          pathLength={100}
          stroke="var(--primary)"
          strokeWidth={Math.max(2.2, edge.width * 0.6)}
          strokeLinecap="round"
          strokeDasharray="12 4 3 100"
          style={{ animationDelay: `${delay.toFixed(3)}s` }}
        />
      ) : null}
      {edge.pulse ? (
        <path
          data-template-pulse-static
          className="template-pulse-static"
          d={edge.path}
          fill="none"
          pathLength={100}
          stroke="var(--primary)"
          strokeWidth={Math.max(1.5, edge.width * 0.6)}
          strokeLinecap="round"
        />
      ) : null}
    </g>
  );
}

function EdgeLabel({ edge }: { edge: TopologyEdge }) {
  const x = edge.labelX;
  const y = edge.labelY;
  return (
    <text
      data-template-edge-label
      data-unavailable={edge.unavailable ? "true" : "false"}
      x={x}
      y={edge.unavailable ? y - 4 : y}
      textAnchor="middle"
      dominantBaseline="auto"
      fill="var(--muted-foreground)"
      fontSize={9}
      fontFamily="var(--font-mono, ui-monospace, monospace)"
      paintOrder="stroke"
      stroke="var(--card)"
      strokeWidth={3}
      strokeLinejoin="round"
    >
      {formatMs(edge.p50Ms)}
      {edge.unavailable ? (
        <tspan
          x={x}
          dy={10}
          fill="var(--destructive)"
          fontSize={8}
          fontFamily="var(--font-sans, ui-sans-serif, system-ui, sans-serif)"
          strokeWidth={2.5}
        >
          {t("overview.chainTemplateInsight.edgeUnavailable")}
        </tspan>
      ) : null}
    </text>
  );
}

function TargetNode({
  target,
  open,
  onHover,
  onToggle,
  delay,
}: {
  target: TopologyTarget;
  open: boolean;
  onHover: (open: boolean) => void;
  onToggle: () => void;
  delay: number;
}) {
  const count = target.count;
  const first = target.items[0];
  return (
    <>
      <div
        data-template-target-glow
        aria-hidden="true"
        className="template-target-glow"
        style={{
          left: target.x - 3,
          top: target.y - 3,
          width: target.width + 6,
          height: target.height + 6,
          animationDelay: `${delay.toFixed(3)}s`,
        }}
      />
      <button
        type="button"
        data-template-target-node
        aria-expanded={open}
        aria-label={t("overview.chainTemplateInsight.targetCount", { n: count })}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        onFocus={() => onHover(true)}
        onBlur={() => onHover(false)}
        onClick={onToggle}
        style={{
          left: target.x,
          top: target.y,
          width: target.width,
          height: target.height,
        }}
        className={cn(
          "absolute z-20 flex flex-col items-center justify-center gap-1 rounded-md border border-dashed bg-card px-2 text-center outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50",
          count > 0 ? "border-border" : "border-warning/40",
        )}
      >
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("overview.chainTemplateInsight.targetLabel")}
        </span>
        <span className="text-xs font-medium tabular-nums">
          {count > 0
            ? t("overview.chainTemplateInsight.targetCount", { n: count })
            : t("overview.chainTemplateInsight.targetNone")}
        </span>
        {first !== undefined ? (
          <span
            data-template-target-preview
            className="max-w-full truncate font-mono text-[9px] leading-none text-muted-foreground"
          >
            {first.label}
            {count > 1
              ? ` ${t("overview.chainTemplateInsight.targetMore", {
                  n: count - 1,
                })}`
              : ""}
          </span>
        ) : null}
      </button>
    </>
  );
}

function TargetDetail({
  detail,
  open,
  onHover,
}: {
  detail: ChainTemplateDetail;
  open: boolean;
  onHover: (open: boolean) => void;
}) {
  if (!open) return null;
  return (
    <div
      data-template-target-detail
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className="mt-2 rounded-md border border-border bg-muted/30 px-3 py-2"
    >
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {t("overview.chainTemplateInsight.targetDetailTitle")}
      </p>
      {detail.targets.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("overview.chainTemplateInsight.targetNone")}
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {detail.targets.map((target, index) => {
            const label = targetLabel(target);
            return (
              <li
                key={`${label}-${index}`}
                data-template-target-row
                className="flex min-w-0 items-baseline justify-between gap-3 font-mono text-[11px] tabular-nums"
              >
                <span className="min-w-0 truncate" title={label}>
                  {label}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {t("overview.chainTemplateInsight.memberChains", {
                    n: target.chains,
                  })}{" "}
                  ·{" "}
                  {t("overview.chainTemplateInsight.usersValue", {
                    n: target.users.length,
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Hotspots({
  detail,
  open,
  onToggle,
}: {
  detail: ChainTemplateDetail;
  open: boolean;
  onToggle: () => void;
}) {
  const rows = useMemo(
    () => chainTemplateHotspots(detail.nodes),
    [detail.nodes],
  );
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 border-t border-border pt-2">
      <button
        type="button"
        data-template-hotspots-toggle
        aria-expanded={open}
        onClick={onToggle}
        className="inline-flex min-h-6 items-center gap-1 rounded-md px-1 text-[10px] text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-3 transition-transform duration-150",
            open ? "" : "-rotate-90",
          )}
        />
        {t("overview.chainTemplateInsight.hotspotsTitle")}
      </button>
      {open ? (
        <table
          data-template-hotspots
          className="mt-1 w-full table-fixed border-collapse text-left text-[10px] tabular-nums"
        >
          <thead className="text-muted-foreground">
            <tr className="border-b border-border/60">
              <th scope="col" className="py-1 pr-2 font-medium">
                {t("overview.chainTemplateInsight.hotspotNode")}
              </th>
              <th scope="col" className="w-14 py-1 pr-2 text-right font-medium">
                {t("overview.chainTemplateInsight.hotspotChains")}
              </th>
              <th scope="col" className="w-14 py-1 text-right font-medium">
                {t("overview.chainTemplateInsight.hotspotUsers")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                data-template-hotspot-row
                className="border-b border-border/40 last:border-0"
              >
                <th
                  scope="row"
                  className="min-w-0 truncate py-1 pr-2 font-normal"
                  title={row.name}
                >
                  {row.name}
                  {row.offline ? (
                    <span className="ml-1.5 text-[9px] text-destructive">
                      {t("overview.chainTemplateInsight.offline")}
                    </span>
                  ) : null}
                </th>
                <td className="py-1 pr-2 text-right font-mono">{row.chains}</td>
                <td className="py-1 text-right font-mono">{row.users}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/**
 * 丝带状脉冲拓扑：SOURCE → 中间每一跳（成员分行）→ 聚合 TARGET。
 *
 * 边宽 ∝ 路径链数，节点底色按经过链数分 4 档；离线成员红色描边且路径
 * 标「不可用」、不参与脉冲。脉冲完全由 CSS 动画驱动（负延迟对齐级联），
 * React 不逐帧重渲染；`prefers-reduced-motion` 下切到静态高亮。
 */
export function ChainTemplateTopology({
  detail,
}: {
  detail: ChainTemplateDetail;
}) {
  useI18n();
  const topology = useMemo(() => chainTemplateTopology(detail), [detail]);
  const schedule = useMemo(
    () => templatePulseSchedule(topology.hopDepth),
    [topology.hopDepth],
  );
  const [hotspotsOpen, setHotspotsOpen] = useState(true);
  const [targetHover, setTargetHover] = useState(false);
  const [targetPinned, setTargetPinned] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const targetOpen = targetHover || targetPinned;

  // 从 TARGET 移到下方明细面板时留 160ms 缓冲，否则面板会在鼠标到达前卸载。
  useEffect(
    () => () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    },
    [],
  );
  function hoverTarget(next: boolean) {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (next) {
      setTargetHover(true);
      return;
    }
    hoverTimer.current = window.setTimeout(() => {
      setTargetHover(false);
      hoverTimer.current = null;
    }, 160);
  }
  return (
    <Card className="min-w-0 gap-0" data-template-topology-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <CardTitle className="text-sm font-medium">
            {t("overview.chainTemplateInsight.topologyTitle")}
          </CardTitle>
          <span
            data-template-heat-legend
            className="inline-flex items-center gap-1 text-[9px] text-muted-foreground"
            title={t("overview.chainTemplateInsight.topologyHeatHint")}
          >
            <span>{t("overview.chainTemplateInsight.heatLegend")}</span>
            {HEAT_LEGEND.map((tier) => (
              <span
                key={tier}
                aria-hidden="true"
                className={cn(
                  "size-2 rounded-[2px] border border-primary/20",
                  HEAT_BG[tier],
                )}
              />
            ))}
          </span>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 p-2 sm:p-4">
        <div
          data-template-topology-scroll
          className="-mx-1 overflow-x-auto px-1 pb-2"
        >
          <div
            data-template-topology
            data-node-count={topology.columns.reduce(
              (sum, column) => sum + column.members.length,
              0,
            )}
            data-edge-count={topology.edges.length}
            data-pulse-count={topology.pulseCount}
            className="relative"
            style={{ width: topology.width, height: topology.height }}
          >
            <svg
              aria-hidden="true"
              width={topology.width}
              height={topology.height}
              className="absolute inset-0 overflow-visible"
            >
              {topology.edges.map((edge) => (
                <EdgeShape
                  key={edge.key}
                  edge={edge}
                  delay={schedule.edgeDelaySec(edge.depth)}
                />
              ))}
              {topology.edges.map((edge) => (
                <EdgeLabel key={`label-${edge.key}`} edge={edge} />
              ))}
            </svg>
            {topology.columns
              .filter((column) => column.role !== "target")
              .map((column) => (
                <TopologyNode key={`${column.seq}-${column.role}`} column={column} />
              ))}
            <TargetNode
              target={topology.target}
              open={targetOpen}
              onHover={hoverTarget}
              onToggle={() => setTargetPinned((value) => !value)}
              delay={schedule.targetDelaySec}
            />
          </div>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground sm:hidden">
          {t("overview.chainTemplateInsight.topologyScroll")}
        </p>
        <TargetDetail
          detail={detail}
          open={targetOpen}
          onHover={hoverTarget}
        />
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
          <span>{t("overview.chainTemplateInsight.topologyHintWidth")}</span>
          <span>{t("overview.chainTemplateInsight.topologyHintP50")}</span>
          <span>{t("overview.chainTemplateInsight.topologyHeatHint")}</span>
        </p>
        <Hotspots
          detail={detail}
          open={hotspotsOpen}
          onToggle={() => setHotspotsOpen((value) => !value)}
        />
      </CardContent>
    </Card>
  );
}
