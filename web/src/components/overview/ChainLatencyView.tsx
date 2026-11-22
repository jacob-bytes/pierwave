import { useMemo } from "react";
import { Link } from "react-router-dom";
import { WaypointsIcon } from "lucide-react";
import { EmptyState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { InsightMetrics } from "@/components/overview/InsightMetrics";
import { PanelError } from "@/components/overview/PanelError";
import type { Chain } from "@/lib/api";
import { errorText } from "@/lib/errors";
import {
  chainHealthRows,
  chainHealthStatus,
  type ChainHealthStatus,
} from "@/lib/overview";
import { filterChainsByScope } from "@/lib/overviewScope";
import { useChains } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** 转发链健康卡的状态样式；阻断用 destructive，降级用 warning，与链列表一致。 */
const CHAIN_HEALTH_META: Record<
  ChainHealthStatus,
  { labelKey: string; titleKey?: string; dot: string; text: string }
> = {
  blocked: {
    labelKey: "overview.chainBlocked",
    dot: "bg-destructive",
    text: "text-destructive",
  },
  degraded: {
    labelKey: "chains.status.degraded",
    titleKey: "chains.status.degradedTitle",
    dot: "bg-warning",
    text: "text-warning",
  },
  disabled: {
    labelKey: "chains.status.disabled",
    titleKey: "chains.status.disabledTitle",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
  ok: {
    labelKey: "chains.status.ok",
    titleKey: "chains.status.okTitle",
    dot: "bg-primary",
    text: "text-primary",
  },
};

function ChainHealthCard({
  chains,
  isPending,
  error,
  retrying,
  onRetry,
}: {
  chains: Chain[] | undefined;
  isPending: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const rows = chainHealthRows(chains);

  return (
    <Card className="flex flex-col gap-0">
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-sm font-medium">
          {t("overview.chainHealth")}
        </CardTitle>
      </CardHeader>
      {isPending ? (
        <CardContent className="flex flex-col gap-3 p-4" aria-hidden="true">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="h-3 w-32" />
            </div>
          ))}
        </CardContent>
      ) : error ? (
        <PanelError
          message={errorText(error, t("chains.loadError"))}
          retrying={retrying}
          onRetry={onRetry}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={WaypointsIcon}
          title={t("overview.chainHealthEmpty")}
          className="py-10"
        />
      ) : (
        <CardContent className="p-2">
          <ul className="flex flex-col gap-0.5">
            {rows.map((row) => {
              const meta = CHAIN_HEALTH_META[row.status];
              const statusTitle =
                row.reason ?? (meta.titleKey ? t(meta.titleKey) : undefined);
              return (
                <li key={row.id}>
                  <Link
                    to="/chains"
                    className="group flex flex-col gap-1 rounded-md px-2.5 py-2.5 transition-colors duration-150 hover:bg-muted/40"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="min-w-0 flex-1 truncate text-sm"
                        title={row.name}
                      >
                        {row.name}
                      </span>
                      <span
                        className={cn(
                          "flex shrink-0 items-center gap-1.5 text-xs",
                          meta.text,
                        )}
                        title={statusTitle}
                      >
                        <span
                          aria-hidden="true"
                          className={cn("size-1.5 rounded-full", meta.dot)}
                        />
                        {t(meta.labelKey)}
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
                      <span className="shrink-0">
                        {t(
                          row.hops === 1
                            ? "overview.chainHopsOne"
                            : "overview.chainHops",
                          { n: row.hops },
                        )}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span
                        className="truncate font-mono"
                        title={`${t("overview.chainEntry")} ${row.entry}`}
                      >
                        {row.entry}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

function ChainPlaceholderCard() {
  return (
    <Card className="gap-0">
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.chainLatency.title")}
          </CardTitle>
          <Badge variant="outline" className="shrink-0 font-normal">
            {t("overview.chainLatency.soon")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <EmptyState
          icon={WaypointsIcon}
          title={t("overview.chainLatency.emptyTitle")}
          description={t("overview.chainLatency.emptyDesc")}
          className="py-16"
        />
      </CardContent>
    </Card>
  );
}

/**
 * 「链路时延」tab：先放从原概览搬来的转发链健康卡，其余保持占位。
 * 只有这个 tab 挂载时才请求 `/api/v1/chains`。
 *
 * 服务器筛选口径：链的任意一跳落在选中服务器即保留；
 * 顶部的三个数字按过滤后的链重算，空选择时走空态而不是显示 0。
 */
export default function ChainLatencyView({
  selectedIds,
}: {
  selectedIds: readonly string[];
}) {
  useI18n();
  const chains = useChains();
  const scopedChains = useMemo(
    () => filterChainsByScope(chains.data ?? [], selectedIds),
    [chains.data, selectedIds],
  );
  const healthy = scopedChains.filter(
    (chain) => chainHealthStatus(chain) === "ok",
  ).length;
  const attention = scopedChains.length - healthy;

  if (selectedIds.length === 0) {
    return (
      <div className="space-y-4" data-chain-view>
        <ChainScopeEmpty
          title={t("overview.scope.emptyTitle")}
          description={t("overview.scope.emptyDesc")}
        />
      </div>
    );
  }

  if (!chains.isPending && !chains.isError && scopedChains.length === 0) {
    return (
      <div className="space-y-4" data-chain-view>
        <ChainScopeEmpty
          title={t("overview.chainLatency.emptyScopeTitle")}
          description={t("overview.chainLatency.emptyScopeDesc")}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-chain-view>
      {chains.isPending || chains.isError ? null : (
        <InsightMetrics
          items={[
            {
              label: t("overview.chainLatency.metricChains"),
              value: scopedChains.length,
              hint: t("overview.chainLatency.metricChainsHint"),
            },
            {
              label: t("overview.chainLatency.metricHealthy"),
              value: healthy,
              hint: t("overview.chainLatency.metricHealthyHint"),
            },
            {
              label: t("overview.chainLatency.metricAttention"),
              value: attention,
              hint: t("overview.chainLatency.metricAttentionHint"),
            },
          ]}
        />
      )}
      <ChainHealthCard
        chains={scopedChains}
        isPending={chains.isPending}
        error={chains.isError ? chains.error : null}
        retrying={chains.isFetching}
        onRetry={() => void chains.refetch()}
      />
      <ChainPlaceholderCard />
    </div>
  );
}

function ChainScopeEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardContent>
        <EmptyState
          size="sm"
          icon={WaypointsIcon}
          title={title}
          description={description}
          className="py-16"
        />
      </CardContent>
    </Card>
  );
}
