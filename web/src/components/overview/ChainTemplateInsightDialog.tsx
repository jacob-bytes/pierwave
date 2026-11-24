import { useState } from "react";
import { WaypointsIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { ChainTemplateStrategies } from "@/components/overview/ChainTemplateStrategies";
import { ChainTemplateTopology } from "@/components/overview/ChainTemplateTopology";
import { ChainTemplateUsageChart } from "@/components/overview/ChainTemplateUsageChart";
import { PanelError } from "@/components/overview/PanelError";
import { errorText } from "@/lib/errors";
import {
  chainTemplateDetailTotals,
  type ChainTemplateDetail,
  type ChainTemplateListItem,
  type ChainTemplateUsageRange,
} from "@/lib/chainTemplateInsight";
import { useChainTemplateInsight } from "@/lib/queries";
import { t, useI18n } from "@/i18n";

function DetailSkeleton() {
  return (
    <div className="space-y-4" data-template-detail-skeleton aria-hidden="true">
      <Skeleton className="h-[320px] w-full rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[300px] w-full rounded-xl" />
        <Skeleton className="h-[300px] w-full rounded-xl" />
      </div>
    </div>
  );
}

/**
 * 四块内容：丝带脉冲拓扑（含可折叠热点排序）、使用量折线、策略分布。
 *
 * 拓扑回答「流量怎么走」，使用量回答「用得多不多」，策略回答「为什么这么走」；
 * 热点排序与拓扑着色同源，收在拓扑卡底部，不另起一张等权重的表。
 */
function TemplateDetailBody({
  detail,
  range,
  onRangeChange,
}: {
  detail: ChainTemplateDetail;
  range: ChainTemplateUsageRange;
  onRangeChange: (range: ChainTemplateUsageRange) => void;
}) {
  return (
    <div className="space-y-4" data-template-detail>
      <ChainTemplateTopology key={detail.template.id} detail={detail} />
      <div className="grid gap-4 lg:grid-cols-2">
        <ChainTemplateUsageChart
          detail={detail}
          range={range}
          onRangeChange={onRangeChange}
        />
        <ChainTemplateStrategies detail={detail} />
      </div>
    </div>
  );
}

/**
 * 转发链模板详情弹窗：标题给模板名 + 跳数 + 链数/用户数，内容四块。
 *
 * 打开状态由列表决定；详情请求只在有选中项时发出。旧主控没有详情接口
 * （404 / 403）时整块降级成「需要新版本主控」，不显示半张空图。
 */
export function ChainTemplateInsightDialog({
  item,
  onClose,
}: {
  item: ChainTemplateListItem | null;
  onClose: () => void;
}) {
  useI18n();
  const [range, setRange] = useState<ChainTemplateUsageRange>("24h");
  const hours = range === "24h" ? 24 : 168;
  const query = useChainTemplateInsight(item?.id ?? null, hours);
  const detail = query.data ?? null;
  // 标题以列表项为准：它是模板级聚合；详情里的源成员链数可能按入口重复。
  const derived = detail ? chainTemplateDetailTotals(detail) : null;
  const totals = {
    hops: item?.hops ?? derived?.hops ?? 0,
    chains: item?.chains ?? derived?.chains ?? 0,
    users: item?.users ?? derived?.users ?? 0,
  };
  const name = item?.name ?? detail?.template.name ?? "—";

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-template-dialog
        className="flex max-h-[92dvh] w-[calc(100vw-0.5rem)] max-w-[1040px] flex-col gap-0 overflow-hidden p-0 sm:w-[calc(100vw-2rem)] sm:max-w-[1040px]"
      >
        {item ? (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-12 text-left">
              <DialogTitle
                className="truncate text-sm font-medium"
                title={name}
              >
                {name}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t("overview.chainTemplateInsight.dialogDesc", { name })}
              </DialogDescription>
              <div
                data-template-dialog-meta
                className="mt-1.5 flex flex-wrap items-center gap-1.5"
              >
                <Badge variant="outline" className="font-normal">
                  {t("overview.chainTemplateInsight.metaHops", {
                    n: totals.hops,
                  })}
                </Badge>
                <Badge variant="outline" className="font-normal">
                  {t("overview.chainTemplateInsight.metaChains", {
                    n: totals.chains,
                  })}
                </Badge>
                <Badge variant="outline" className="font-normal">
                  {t("overview.chainTemplateInsight.metaUsers", {
                    n: totals.users,
                  })}
                </Badge>
              </div>
            </DialogHeader>
            <div
              data-template-dialog-scroll
              className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4"
            >
              {query.isPending && query.data === undefined ? (
                <DetailSkeleton />
              ) : query.isError ? (
                <PanelError
                  message={errorText(
                    query.error,
                    t("overview.chainTemplateInsight.loadFailed"),
                  )}
                  retrying={query.isFetching}
                  onRetry={() => void query.refetch()}
                />
              ) : detail === null ? (
                <EmptyState
                  icon={WaypointsIcon}
                  title={t("overview.chainTemplateInsight.unsupportedTitle")}
                  description={t(
                    "overview.chainTemplateInsight.unsupportedDesc",
                  )}
                  className="py-16"
                />
              ) : (
                <TemplateDetailBody
                  detail={detail}
                  range={range}
                  onRangeChange={setRange}
                />
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
