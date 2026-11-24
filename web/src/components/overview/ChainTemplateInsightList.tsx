import { useState } from "react";
import { ChevronRightIcon, WaypointsIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { ChainTemplateInsightDialog } from "@/components/overview/ChainTemplateInsightDialog";
import { PanelError } from "@/components/overview/PanelError";
import { errorText } from "@/lib/errors";
import {
  type ChainTemplateListItem,
  type ChainTemplateStatus,
  type ChainTemplateStatusKind,
} from "@/lib/chainTemplateInsight";
import { useChainTemplateInsights } from "@/lib/queries";
import { t, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/** 模板名 1fr / 跳数 56 / 链数 140 / 用户数 140 / 状态 96 / chevron 24。 */
const LIST_GRID =
  "lg:grid-cols-[minmax(0,1fr)_56px_140px_140px_96px_24px]";

const STATUS_META: Record<
  ChainTemplateStatusKind,
  { labelKey: string; dot: string; text: string; titleKey: string }
> = {
  ok: {
    labelKey: "overview.chainTemplateInsight.statusOk",
    dot: "bg-primary",
    text: "text-foreground",
    titleKey: "overview.chainTemplateInsight.statusOkTitle",
  },
  degraded: {
    labelKey: "overview.chainTemplateInsight.statusDegraded",
    dot: "bg-warning",
    text: "text-warning",
    titleKey: "overview.chainTemplateInsight.statusDegradedTitle",
  },
  blocked: {
    labelKey: "overview.chainTemplateInsight.statusBlocked",
    dot: "bg-destructive",
    text: "text-destructive",
    titleKey: "overview.chainTemplateInsight.statusBlockedTitle",
  },
  unknown: {
    labelKey: "overview.chainTemplateInsight.statusUnknown",
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
    titleKey: "overview.chainTemplateInsight.statusUnknownTitle",
  },
};

function statusCause(cause: string): string {
  if (cause === "member_offline") {
    return t("overview.chainTemplateInsight.causeMemberOffline");
  }
  if (cause === "disabled") {
    return t("overview.chainTemplateInsight.causeDisabled");
  }
  return cause;
}

function statusTitle(status: ChainTemplateStatus): string {
  const meta = STATUS_META[status.kind];
  const label = t(meta.labelKey);
  if (status.cause !== null) {
    return t("overview.chainTemplateInsight.statusCauseTitle", {
      status: label,
      cause: statusCause(status.cause),
    });
  }
  return t(meta.titleKey);
}

function StatusCell({
  status,
  className,
}: {
  status: ChainTemplateStatus;
  className?: string;
}) {
  const meta = STATUS_META[status.kind];
  return (
    <span
      data-template-status
      data-status={status.kind}
      title={statusTitle(status)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap",
        meta.text,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 rounded-full", meta.dot)}
      />
      {t(meta.labelKey)}
    </span>
  );
}

function TemplateRow({
  item,
  onOpen,
}: {
  item: ChainTemplateListItem;
  onOpen: () => void;
}) {
  const statusLabel = t(STATUS_META[item.status.kind].labelKey);
  const label = t("overview.chainTemplateInsight.rowAria", {
    name: item.name,
    hops: item.hops,
    chains: item.chains,
    users: item.users,
    status: statusLabel,
  });
  return (
    <li className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        data-chain-template-row
        data-template-id={item.id}
        data-status={item.status.kind}
        onClick={onOpen}
        aria-label={label}
        className={cn(
          "group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-lg border border-transparent px-3 py-2 text-left outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 lg:py-3",
          LIST_GRID,
        )}
      >
        <span
          data-template-row-lead
          className="flex min-w-0 items-center gap-2 lg:col-start-1 lg:row-start-1"
        >
          <span
            className="min-w-0 truncate text-sm font-medium"
            title={item.name}
          >
            {item.name}
          </span>
          {item.enabled ? null : (
            <Badge
              variant="outline"
              className="shrink-0 px-1 py-0 font-normal text-muted-foreground"
            >
              {t("chainTemplates.disabled")}
            </Badge>
          )}
        </span>

        <StatusCell
          status={item.status}
          className="col-start-2 row-start-1 justify-self-end lg:col-start-5 lg:row-start-1 lg:justify-self-start"
        />

        <span
          data-template-row-metrics
          className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs lg:contents"
        >
          <span className="inline-flex items-baseline gap-1 lg:col-start-2 lg:row-start-1">
            <span className="text-[10px] text-muted-foreground lg:hidden">
              {t("overview.chainTemplateInsight.colHops")}
            </span>
            <span className="font-mono text-sm tabular-nums">{item.hops}</span>
          </span>
          <span
            data-template-row-chains
            className="inline-flex items-baseline gap-1 lg:col-start-3 lg:row-start-1"
          >
            <span className="text-[10px] text-muted-foreground lg:hidden">
              {t("overview.chainTemplateInsight.mobileChains")}
            </span>
            <span className="font-mono text-sm tabular-nums">
              {item.chains}
            </span>
          </span>
          <span
            data-template-row-users
            className="inline-flex items-baseline gap-1 lg:col-start-4 lg:row-start-1"
          >
            <span className="text-[10px] text-muted-foreground lg:hidden">
              {t("overview.chainTemplateInsight.mobileUsers")}
            </span>
            <span className="font-mono text-sm tabular-nums">
              {item.users}
            </span>
          </span>
          <ChevronRightIcon
            aria-hidden="true"
            className="hidden size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 lg:col-start-6 lg:row-start-1 lg:block"
          />
        </span>
      </button>
    </li>
  );
}

/**
 * 链路时延 tab 底部的「转发链模板」区块。
 *
 * 五列：模板名 / 跳数 / 使用它的转发链数 / 使用它的用户数 / 状态。
 * 数据来自模板洞察列表接口；旧主控 404 / 403 时整块降级成
 * 「需要新版本主控」，不会留下骨架或空白卡片。
 */
export function ChainTemplateInsightList() {
  useI18n();
  const query = useChainTemplateInsights();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const snapshot = query.data ?? null;
  const items = snapshot?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;

  return (
    <>
      <Card className="gap-0" data-chain-template-insight>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">
              {t("overview.chainTemplateInsight.sectionTitle")}
            </CardTitle>
            <div className="flex shrink-0 items-center gap-2">
              {snapshot !== null ? (
                <Badge
                  variant="outline"
                  className="shrink-0 font-mono font-normal text-muted-foreground"
                >
                  {t("overview.chainTemplateInsight.count", {
                    n: items.length,
                  })}
                </Badge>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-2">
          {query.isPending && query.data === undefined ? (
            <div
              className="flex flex-col gap-2 p-1"
              data-chain-template-skeleton
              aria-hidden="true"
            >
              {Array.from({ length: 3 }).map((_, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between gap-3 px-2 py-2"
                >
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </div>
          ) : query.isError ? (
            <PanelError
              message={errorText(
                query.error,
                t("overview.chainTemplateInsight.loadFailed"),
              )}
              retrying={query.isFetching}
              onRetry={() => void query.refetch()}
            />
          ) : snapshot === null ? (
            <EmptyState
              icon={WaypointsIcon}
              title={t("overview.chainTemplateInsight.unsupportedTitle")}
              description={t("overview.chainTemplateInsight.unsupportedDesc")}
              className="py-10"
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={WaypointsIcon}
              title={t("overview.chainTemplateInsight.emptyTitle")}
              className="py-10"
            />
          ) : (
            <>
              <div
                data-chain-template-head
                aria-hidden="true"
                className={cn(
                  "hidden items-center gap-x-3 px-3 pb-1 text-left text-[10px] text-muted-foreground lg:grid",
                  LIST_GRID,
                )}
              >
                <span>{t("overview.chainTemplateInsight.colName")}</span>
                <span>{t("overview.chainTemplateInsight.colHops")}</span>
                <span>{t("overview.chainTemplateInsight.colChains")}</span>
                <span>{t("overview.chainTemplateInsight.colUsers")}</span>
                <span>{t("overview.chainTemplateInsight.colStatus")}</span>
                <span />
              </div>
              <ul className="flex flex-col">
                {items.map((item) => (
                  <TemplateRow
                    key={item.id}
                    item={item}
                    onOpen={() => setSelectedId(item.id)}
                  />
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
      <ChainTemplateInsightDialog
        key={selectedId ?? "closed"}
        item={selected}
        onClose={() => setSelectedId(null)}
      />
    </>
  );
}
