import { useMemo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  TreeChart,
  type TreeChartTooltipTarget,
  type TreeNode,
} from "@/components/ui/charts/tree-chart";
import {
  chainTemplateHotspots,
  type ChainTemplateDetail,
} from "@/lib/chainTemplateInsight";
import {
  chainTemplateTree,
  chainTemplateTreeNodeMeta,
  type ChainTemplateUnusedMember,
} from "@/lib/chainTemplateTree";
import { t, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

function statusText(status: "online" | "offline" | "unknown"): string {
  if (status === "offline") return t("overview.chainTemplateInsight.offline");
  if (status === "online") return t("overview.chainTemplateInsight.online");
  return t("overview.chainTemplateInsight.unknownStatus");
}

function NodeTooltip({ node }: { node: TreeNode }) {
  const meta = chainTemplateTreeNodeMeta(node);
  if (meta === null) {
    return <p className="truncate font-medium">{node.name}</p>;
  }
  if (meta.kind === "fold") {
    return (
      <p data-template-tree-tooltip-fold className="font-medium">
        {node.name}
      </p>
    );
  }
  return (
    <div data-template-tree-tooltip data-kind={meta.kind}>
      <p className="truncate font-medium" title={node.name}>
        {node.name}
      </p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground">
          {t("overview.chainTemplateInsight.tooltipStatus")}
        </dt>
        <dd
          data-template-tree-tooltip-status={meta.status}
          className={cn(meta.offline && "text-destructive")}
        >
          {statusText(meta.status)}
        </dd>
        <dt className="text-muted-foreground">
          {t("overview.chainTemplateInsight.tooltipChains")}
        </dt>
        <dd className="font-mono tabular-nums">{meta.chains}</dd>
        <dt className="text-muted-foreground">
          {t("overview.chainTemplateInsight.tooltipUsers")}
        </dt>
        <dd className="font-mono tabular-nums">{meta.users}</dd>
      </dl>
    </div>
  );
}

function EdgeTooltip({ target }: { target: TreeChartTooltipTarget }) {
  if (target.kind !== "edge") return null;
  const { edge, link } = target;
  return (
    <div data-template-tree-edge-tooltip>
      <p className="truncate" title={`${target.sourceName} → ${target.targetName}`}>
        {target.sourceName} → {target.targetName}
      </p>
      <p className="mt-1 flex items-center gap-2 font-mono tabular-nums text-muted-foreground">
        <span>{edge.label ?? "—"}</span>
        <span>
          {t("overview.chainTemplateInsight.memberChains", { n: edge.value })}
        </span>
      </p>
      {link?.unavailable === true ? (
        <p className="mt-1 text-destructive">
          {t("overview.chainTemplateInsight.edgeUnavailable")}
        </p>
      ) : null}
    </div>
  );
}

function UnusedMembers({ rows }: { rows: readonly ChainTemplateUnusedMember[] }) {
  if (rows.length === 0) return null;
  return (
    <div
      data-template-unused
      className="mt-3 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2"
    >
      <p className="text-[10px] text-muted-foreground">
        {t("overview.chainTemplateInsight.unusedTitle", { n: rows.length })}
      </p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {rows.map((row) => (
          <li
            key={`${row.seq}-${row.key}`}
            data-template-unused-member
            data-status={row.status}
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] leading-tight",
              row.status === "offline"
                ? "border-destructive/40 text-destructive"
                : "text-muted-foreground",
            )}
            title={`${row.name} · ${statusText(row.status)}`}
          >
            <span className="truncate">{row.name}</span>
          </li>
        ))}
      </ul>
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
 * 转发链模板拓扑：shadcn TreeChart 风格的横向树。
 *
 * 根是聚合的「入口」；每个中间跳只画实际被链使用的成员（chains > 0），
 * 叶子是目标 host:port。DAG 的汇合 / 分流保留为曲线交叉边；hover / focus
 * 节点或边会点亮它到根的整条路径。点击中间节点折叠子树并显示 `+N`；
 * 目标超过 8 个时默认折叠成「+N 个目标」，点击展开。
 *
 * 边宽 ∝ 路径链数，边标签是 P50（缺失显示 `—`）。离线成员红色描边、
 * 路径标「不可用」且不参与脉冲；脉冲由 CSS 驱动，减少动效时退化为静态高亮。
 */
export function ChainTemplateTopology({
  detail,
}: {
  detail: ChainTemplateDetail;
}) {
  const { t: translate } = useI18n();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [targetsExpanded, setTargetsExpanded] = useState(false);
  const [hotspotsOpen, setHotspotsOpen] = useState(true);

  const model = useMemo(
    () =>
      chainTemplateTree(detail, {
        labels: {
          root: translate("overview.chainTemplateInsight.treeRoot"),
          targets: (count) =>
            translate("overview.chainTemplateInsight.treeTargetsFold", {
              n: count,
            }),
        },
        targetsExpanded,
      }),
    [detail, translate, targetsExpanded],
  );

  const toggleNode = (node: TreeNode): void => {
    const meta = chainTemplateTreeNodeMeta(node);
    if (meta?.kind === "fold") {
      setTargetsExpanded(true);
      return;
    }
    const id = node.id;
    if (id === undefined || (node.children?.length ?? 0) === 0) return;
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const ariaLabel = t("overview.chainTemplateInsight.topologyAria", {
    name: detail.template.name,
    nodes: model.nodeCount,
    edges: model.links.length,
  });

  return (
    <Card className="min-w-0 gap-0" data-template-topology-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <CardTitle className="text-sm font-medium">
            {t("overview.chainTemplateInsight.topologyTitle")}
          </CardTitle>
          <span className="inline-flex items-center gap-2 text-[9px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span
                aria-hidden="true"
                className="size-2 rounded-full border border-primary"
              />
              {t("overview.chainTemplateInsight.online")}
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                aria-hidden="true"
                className="size-2 rounded-full border border-destructive"
              />
              {t("overview.chainTemplateInsight.offline")}
            </span>
          </span>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 p-2 sm:p-4">
        <div data-template-topology>
          <TreeChart
            data={model.data}
            links={model.links}
            ariaLabel={ariaLabel}
            valueLabel={t("overview.chainTemplateInsight.chainsUnit")}
            collapsedIds={collapsed}
            onNodeToggle={toggleNode}
            pulse
            unavailableLabel={t(
              "overview.chainTemplateInsight.edgeUnavailable",
            )}
            renderTooltip={(target) =>
              target.kind === "node" ? (
                <NodeTooltip node={target.node} />
              ) : (
                <EdgeTooltip target={target} />
              )
            }
          />
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground sm:hidden">
          {t("overview.chainTemplateInsight.topologyScroll")}
        </p>
        <UnusedMembers rows={model.unusedMembers} />
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
          <span>{t("overview.chainTemplateInsight.topologyHintWidth")}</span>
          <span>{t("overview.chainTemplateInsight.topologyHintP50")}</span>
          <span>{t("overview.chainTemplateInsight.topologyHintPulse")}</span>
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
