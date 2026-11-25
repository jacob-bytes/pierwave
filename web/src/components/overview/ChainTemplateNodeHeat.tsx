import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPercentValue } from "@/lib/chainHealth";
import {
  chainTemplateNodeHeat,
  type ChainTemplateDetail,
  type ChainTemplateMemberStatus,
  type ChainTemplateNodeHeatRow,
} from "@/lib/chainTemplateInsight";
import { useI18n, type TFunction } from "@/i18n";
import { cn } from "@/lib/utils";

function statusText(
  status: ChainTemplateMemberStatus,
  translate: TFunction,
): string {
  if (status === "offline") return translate("overview.chainTemplateInsight.offline");
  if (status === "online") return translate("overview.chainTemplateInsight.online");
  if (status === "degraded") return translate("overview.chainTemplateInsight.degraded");
  return translate("overview.chainTemplateInsight.unknownStatus");
}

/**
 * 条形色：最高热点用满 primary，其余略浅；离线成员用 muted 底 + destructive
 * 文字标状态，不把离线画成第二个强调色。
 */
function barClass(row: ChainTemplateNodeHeatRow, index: number): string {
  if (row.status === "offline") return "bg-muted-foreground/40";
  return index === 0 ? "bg-primary" : "bg-primary/60";
}

function statusClass(status: ChainTemplateMemberStatus): string {
  if (status === "offline") return "text-destructive";
  if (status === "degraded") return "text-warning";
  return "text-muted-foreground";
}

/**
 * 节点热度：横向条形图，Top 5 节点按使用链数降序。
 *
 * 不使用饼图：同一节点会在多条链的每一跳被重复计入（这里按 serverId 取
 * 最大值合并），各节点链数之和远大于模板链数，饼图扇区之和没有业务含义。
 * 条形只做相对长短比较，占比分母是模板总链数，悬停 / 聚焦时给出明细。
 */
export function ChainTemplateNodeHeat({
  detail,
}: {
  detail: ChainTemplateDetail;
}) {
  const { t: translate } = useI18n();
  const heat = useMemo(() => chainTemplateNodeHeat(detail), [detail]);

  return (
    <Card className="min-w-0 gap-0" data-template-node-heat-card>
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-sm font-medium">
          {translate("overview.chainTemplateInsight.nodeHeatTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-1 flex-col p-3 sm:p-4">
        {heat.rows.length === 0 ? (
          <p
            data-template-node-heat-empty
            className="flex flex-1 items-center justify-center py-6 text-center text-xs text-muted-foreground"
          >
            {translate("overview.chainTemplateInsight.nodeHeatEmpty")}
          </p>
        ) : (
          <ul
            data-template-node-heat
            className="flex flex-col gap-2.5"
            aria-label={translate(
              "overview.chainTemplateInsight.nodeHeatListAria",
              { n: heat.rows.length },
            )}
          >
            {heat.rows.map((row, index) => {
              const barPct = Math.max(0, Math.min(100, row.barPct));
              const sharePct = Math.max(0, Math.min(100, row.sharePct));
              return (
                <li
                  key={row.key}
                  tabIndex={0}
                  data-template-heat-row
                  data-chains={row.chains}
                  data-users={row.users}
                  data-status={row.status}
                  data-share={Math.round(sharePct * 10) / 10}
                  aria-label={translate(
                    "overview.chainTemplateInsight.nodeHeatAria",
                    {
                      name: row.name,
                      chains: row.chains,
                      users: row.users,
                      status: statusText(row.status, translate),
                      pct: formatPercentValue(sharePct),
                    },
                  )}
                  className="group min-w-0 rounded-md outline-none transition-colors duration-150 hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <div className="flex min-w-0 items-baseline justify-between gap-3">
                    <span
                      className="min-w-0 truncate text-xs text-foreground"
                      title={row.name}
                    >
                      {row.name}
                    </span>
                    <span
                      className="shrink-0 font-mono text-xs tabular-nums"
                      title={translate(
                        "overview.chainTemplateInsight.memberChains",
                        { n: row.chains },
                      )}
                    >
                      {row.chains}
                    </span>
                  </div>
                  <div
                    aria-hidden="true"
                    className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      data-template-heat-bar
                      data-width={Math.round(barPct * 100) / 100}
                      className={cn(
                        "block h-full rounded-full transition-[width] duration-150",
                        barClass(row, index),
                      )}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2 text-[11px]">
                    <span className="min-w-0 truncate text-muted-foreground">
                      {translate("overview.chainTemplateInsight.usersValue", {
                        n: row.users,
                      })}
                    </span>
                    {row.status === "offline" ||
                    row.status === "degraded" ? (
                      <span
                        data-template-heat-status={row.status}
                        className={cn(
                          "shrink-0 font-medium",
                          statusClass(row.status),
                        )}
                      >
                        {statusText(row.status, translate)}
                      </span>
                    ) : null}
                  </div>
                  <div
                    aria-hidden="true"
                    data-template-node-heat-tooltip
                    className="mt-1.5 hidden rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] shadow-lg/40 group-hover:block group-focus:block"
                  >
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                      <dt className="text-muted-foreground">
                        {translate(
                          "overview.chainTemplateInsight.tooltipChains",
                        )}
                      </dt>
                      <dd className="text-right font-mono tabular-nums">
                        {row.chains}
                      </dd>
                      <dt className="text-muted-foreground">
                        {translate("overview.chainTemplateInsight.tooltipUsers")}
                      </dt>
                      <dd className="text-right font-mono tabular-nums">
                        {row.users}
                      </dd>
                      <dt className="text-muted-foreground">
                        {translate(
                          "overview.chainTemplateInsight.tooltipStatus",
                        )}
                      </dt>
                      <dd
                        className={cn(
                          "text-right",
                          statusClass(row.status),
                        )}
                      >
                        {statusText(row.status, translate)}
                      </dd>
                      <dt className="text-muted-foreground">
                        {translate("overview.chainTemplateInsight.nodeHeatShare")}
                      </dt>
                      <dd className="text-right font-mono tabular-nums">
                        {formatPercentValue(sharePct)}%
                      </dd>
                    </dl>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
