import { useMemo, useState } from "react";
import { ChevronDownIcon, WaypointsIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common";
import {
  TreeChart,
  type TreeChartLayoutEdge,
  type TreeChartLink,
  type TreeChartTooltipTarget,
  type TreeNode,
} from "@/components/ui/charts/tree-chart";
import {
  chainTemplateHotspots,
  type ChainTemplateDetail,
  type ChainTemplateMemberStatus,
} from "@/lib/chainTemplateInsight";
import {
  chainTemplateTree,
  chainTemplateTreeNodeMeta,
  type ChainTemplateUnusedMember,
} from "@/lib/chainTemplateTree";
import { formatMs } from "@/lib/chainHealth";
import { useI18n, type TFunction } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * 成员状态文案。四档与链路详情一致：online / offline / degraded（后端
 * abnormal、no_data）/ unknown；`degraded` 用 warning 色，不当 unknown。
 */
function statusText(status: ChainTemplateMemberStatus, translate: TFunction): string {
  if (status === "offline") return translate("overview.chainTemplateInsight.offline");
  if (status === "online") return translate("overview.chainTemplateInsight.online");
  if (status === "degraded") return translate("overview.chainTemplateInsight.degraded");
  return translate("overview.chainTemplateInsight.unknownStatus");
}

function statusClass(status: ChainTemplateMemberStatus): string {
  if (status === "offline") return "text-destructive";
  if (status === "degraded") return "text-warning";
  return "";
}

/** 节点 aria 追加的状态 / 用户数；折叠节点说明折了几个目标。 */
function nodeAriaExtra(
  node: TreeNode,
  translate: TFunction,
): string {
  const meta = chainTemplateTreeNodeMeta(node);
  if (meta === null) return "";
  if (meta.kind === "fold") {
    return translate("overview.chainTemplateInsight.treeTargetsFold", {
      n: meta.hiddenTargets ?? 0,
    });
  }
  return [
    statusText(meta.status, translate),
    translate("overview.chainTemplateInsight.usersValue", { n: meta.users }),
  ].join(", ");
}

/** 边 aria 追加：不可用 / 降级 / 最近已知 / 用户数。 */
function edgeAriaExtra(
  edge: TreeChartLayoutEdge,
  link: TreeChartLink | undefined,
  translate: TFunction,
): string {
  const parts: string[] = [];
  if (edge.unavailable || link?.unavailable === true) {
    parts.push(translate("overview.chainTemplateInsight.edgeUnavailable"));
    if (edge.lastP50Ms !== null) {
      parts.push(
        translate("overview.chainTemplateInsight.edgeLastKnown", {
          value: formatMs(edge.lastP50Ms),
        }),
      );
    }
  } else if (edge.degraded || link?.degraded === true) {
    parts.push(translate("overview.chainTemplateInsight.degraded"));
    if (edge.label !== null && edge.label !== "—") {
      parts.push(
        translate("overview.chainTemplateInsight.edgeLastKnown", {
          value: edge.label,
        }),
      );
    }
  }
  if (edge.users > 0) {
    parts.push(
      translate("overview.chainTemplateInsight.usersValue", { n: edge.users }),
    );
  }
  return parts.join(", ");
}

function NodeTooltip({ node }: { node: TreeNode }) {
  const { t: translate } = useI18n();
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
          {translate("overview.chainTemplateInsight.tooltipStatus")}
        </dt>
        <dd
          data-template-tree-tooltip-status={meta.status}
          className={cn(statusClass(meta.status))}
        >
          {statusText(meta.status, translate)}
        </dd>
        <dt className="text-muted-foreground">
          {translate("overview.chainTemplateInsight.tooltipChains")}
        </dt>
        <dd className="font-mono tabular-nums">{meta.chains}</dd>
        <dt className="text-muted-foreground">
          {translate("overview.chainTemplateInsight.tooltipUsers")}
        </dt>
        <dd className="font-mono tabular-nums">{meta.users}</dd>
      </dl>
    </div>
  );
}

function EdgeTooltip({ target }: { target: TreeChartTooltipTarget }) {
  const { t: translate } = useI18n();
  if (target.kind !== "edge") return null;
  const { edge, link } = target;
  const unavailable = edge.unavailable || link?.unavailable === true;
  const degraded = !unavailable && (edge.degraded || link?.degraded === true);
  // 不可用路径不给当前值：标签固定 —，历史 P50 只作为「最近已知」出现。
  const value = unavailable ? "—" : (edge.label ?? "—");
  const lastKnown = unavailable ? edge.lastP50Ms : null;
  return (
    <div data-template-tree-edge-tooltip>
      <p
        className="truncate"
        title={`${target.sourceName} → ${target.targetName}`}
      >
        {target.sourceName} → {target.targetName}
      </p>
      <p className="mt-1 flex items-center gap-2 font-mono tabular-nums text-muted-foreground">
        <span className={cn(unavailable && "text-destructive", degraded && "text-warning")}>
          {value}
        </span>
        <span>
          {translate("overview.chainTemplateInsight.memberChains", {
            n: edge.value,
          })}
        </span>
        {edge.users > 0 ? (
          <span>
            {translate("overview.chainTemplateInsight.usersValue", {
              n: edge.users,
            })}
          </span>
        ) : null}
      </p>
      {unavailable ? (
        <p className="mt-1 text-destructive">
          {translate("overview.chainTemplateInsight.edgeUnavailable")}
        </p>
      ) : degraded ? (
        <p className="mt-1 text-warning">
          {translate("overview.chainTemplateInsight.edgeDegradedHint")}
        </p>
      ) : null}
      {lastKnown !== null && lastKnown !== undefined ? (
        <p className="mt-1 text-muted-foreground">
          {translate("overview.chainTemplateInsight.edgeLastKnown", {
            value: formatMs(lastKnown),
          })}
        </p>
      ) : null}
    </div>
  );
}

function UnusedMembers({ rows }: { rows: readonly ChainTemplateUnusedMember[] }) {
  const { t: translate } = useI18n();
  if (rows.length === 0) return null;
  return (
    <div
      data-template-unused
      className="mt-3 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2"
    >
      <p className="text-[10px] text-muted-foreground">
        {translate("overview.chainTemplateInsight.unusedTitle", {
          n: rows.length,
        })}
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
                : row.status === "degraded"
                  ? "border-warning/40 text-warning"
                  : "text-muted-foreground",
            )}
            title={`${row.name} · ${statusText(row.status, translate)}`}
          >
            {/* 状态除颜色外的文字标记：离线 / 降级都有 sr-only 文案。 */}
            {row.status === "offline" || row.status === "degraded" ? (
              <span className="sr-only">{statusText(row.status, translate)}</span>
            ) : null}
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
  const { t: translate } = useI18n();
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
        {translate("overview.chainTemplateInsight.hotspotsTitle")}
      </button>
      {open ? (
        <table
          data-template-hotspots
          className="mt-1 w-full table-fixed border-collapse text-left text-[10px] tabular-nums"
        >
          <thead className="text-muted-foreground">
            <tr className="border-b border-border/60">
              <th scope="col" className="py-1 pr-2 font-medium">
                {translate("overview.chainTemplateInsight.hotspotNode")}
              </th>
              <th scope="col" className="w-14 py-1 pr-2 text-right font-medium">
                {translate("overview.chainTemplateInsight.hotspotChains")}
              </th>
              <th scope="col" className="w-14 py-1 text-right font-medium">
                {translate("overview.chainTemplateInsight.hotspotUsers")}
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
                      {translate("overview.chainTemplateInsight.offline")}
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
 * 节点或边会点亮它到根的整条路径（含汇入该节点的交叉边）。
 *
 * 0 链模板不画孤立根节点，直接给空态。目标折叠按父节点分组：每个父节点
 * 至少留 1 个目标，多余的折成自己的「+N 个目标」，点 `+N` 只展开这一组，
 * 卡片头部提供「收起目标」回到折叠态。
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
  const [expandedParents, setExpandedParents] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
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
        expandedParents,
      }),
    [detail, expandedParents, translate],
  );

  const toggleNode = (node: TreeNode): void => {
    const meta = chainTemplateTreeNodeMeta(node);
    if (meta?.kind === "fold") {
      const parentId = meta.foldParent;
      if (parentId === undefined) return;
      setExpandedParents((previous) => {
        const next = new Set(previous);
        next.add(parentId);
        return next;
      });
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

  const collapseTargets = (): void => {
    setExpandedParents(new Set<string>());
  };

  const describeNode = (node: TreeNode): string => nodeAriaExtra(node, translate);
  const describeEdge = (
    edge: TreeChartLayoutEdge,
    link: TreeChartLink | undefined,
  ): string => edgeAriaExtra(edge, link, translate);

  return (
    <Card className="min-w-0 gap-0" data-template-topology-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <CardTitle className="text-sm font-medium">
            {translate("overview.chainTemplateInsight.topologyTitle")}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            <span className="inline-flex items-center gap-2 text-[9px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full border border-primary"
                />
                {translate("overview.chainTemplateInsight.online")}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full border border-warning"
                />
                {translate("overview.chainTemplateInsight.degraded")}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full border border-destructive"
                />
                {translate("overview.chainTemplateInsight.offline")}
              </span>
            </span>
            {expandedParents.size > 0 ? (
              <button
                type="button"
                data-template-targets-collapse
                onClick={collapseTargets}
                className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[10px] text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {translate("overview.chainTemplateInsight.collapseTargets")}
              </button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 p-2 sm:p-4">
        <div data-template-topology>
          {model.isEmpty ? (
            <EmptyState
              icon={WaypointsIcon}
              title={translate("overview.chainTemplateInsight.emptyTopologyTitle")}
              description={translate(
                "overview.chainTemplateInsight.emptyTopologyDesc",
              )}
              className="py-10"
            />
          ) : (
            <TreeChart
              data={model.data}
              links={model.links}
              ariaLabel={({ nodes, edges }) =>
                translate("overview.chainTemplateInsight.topologyAria", {
                  name: detail.template.name,
                  nodes,
                  edges,
                })
              }
              valueLabel={translate("overview.chainTemplateInsight.chainsUnit")}
              collapsedIds={collapsed}
              onNodeToggle={toggleNode}
              pulse
              unavailableLabel={translate(
                "overview.chainTemplateInsight.edgeUnavailable",
              )}
              describeNode={describeNode}
              describeEdge={describeEdge}
              renderTooltip={(target) =>
                target.kind === "node" ? (
                  <NodeTooltip node={target.node} />
                ) : (
                  <EdgeTooltip target={target} />
                )
              }
            />
          )}
        </div>
        <UnusedMembers rows={model.unusedMembers} />
        {/* 0 链时热点全是 0，只是噪音；空态下面不再叠一张全 0 的表。 */}
        {model.isEmpty ? null : (
          <Hotspots
            detail={detail}
            open={hotspotsOpen}
            onToggle={() => setHotspotsOpen((value) => !value)}
          />
        )}
      </CardContent>
    </Card>
  );
}
