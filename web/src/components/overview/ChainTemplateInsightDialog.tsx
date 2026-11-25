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
import { ChainTemplateNodeHeat } from "@/components/overview/ChainTemplateNodeHeat";
import { ChainTemplateStrategies } from "@/components/overview/ChainTemplateStrategies";
import { ChainTemplateTopology } from "@/components/overview/ChainTemplateTopology";
import { ChainTemplateStaleNotice } from "@/components/overview/ChainTemplateStaleNotice";
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-[300px] w-full rounded-xl md:col-span-2 lg:col-span-1" />
        <Skeleton className="h-[300px] w-full rounded-xl" />
        <Skeleton className="h-[300px] w-full rounded-xl" />
      </div>
    </div>
  );
}

/**
 * 四块内容：横向树拓扑（整宽）、使用量折线、策略分布、节点热度。
 *
 * 拓扑回答「流量怎么走」，下面三张等宽卡回答「用得多不多」「为什么这么走」
 * 与「哪些节点最吃链」。拓扑单独整宽，因为它需要横向空间；三张卡在桌面
 * 三列、平板两列（使用量占整行）、390 单列堆叠。
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
      <ChainTemplateStaleNotice detail={detail} />
      <ChainTemplateTopology key={detail.template.id} detail={detail} />
      <div
        className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 lg:grid-cols-3"
        data-template-detail-grid
      >
        <ChainTemplateUsageChart
          className="md:col-span-2 lg:col-span-1"
          detail={detail}
          range={range}
          onRangeChange={onRangeChange}
        />
        <ChainTemplateStrategies detail={detail} />
        <ChainTemplateNodeHeat detail={detail} />
      </div>
    </div>
  );
}

/**
 * 转发链模板详情弹窗：标题给模板名 + 跳数 + 链数/用户数，内容四块。
 *
 * 打开状态由列表决定；详情请求只在有选中项时发出。旧主控没有详情接口
 * （只有 404）时整块降级成「需要新版本主控」，不显示半张空图；403 是权限
 * 问题，仍然按错误态提示。
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
