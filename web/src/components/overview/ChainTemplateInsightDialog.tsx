import { useLayoutEffect, useRef, useState } from "react";
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
  templateFlowCountKey,
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
      <Skeleton className="h-[360px] w-full rounded-xl" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-[300px] w-full rounded-xl" />
        <Skeleton className="h-[300px] w-full rounded-xl" />
      </div>
    </div>
  );
}

/**
 * 四块内容：横向树拓扑（整宽）、使用量折线（独占整行）、策略分布 | 节点热度。
 *
 * 拓扑回答「流量怎么走」，使用量折线需要宽度（7d 有 672 个数据点），所以独占
 * 整行；第二行放两张 Top N 列表卡，各自按内容取自然高度（`items-start`），
 * 不为了对齐底边把策略卡撑出空白。390 三张卡按使用量 → 策略分布 → 节点热度
 * 单列堆叠。
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
        className="grid grid-cols-1 items-start gap-4 md:grid-cols-2"
        data-template-detail-grid
      >
        <ChainTemplateUsageChart
          className="md:col-span-2"
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

/** 打开弹窗时真正持有焦点的元素；`body` 视作没有触发元素。 */
function openerElement(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (active === document.body || active === document.documentElement) {
    return null;
  }
  return active;
}

/**
 * 关闭后把焦点还给打开弹窗的模板行；行被筛选 / 刷新移除时退到列表容器。
 *
 * 模板列表没有搜索框，所以直接落到 `[data-chain-template-list]`；容器不在
 * Tab 序里，临时补 `tabindex=-1` 接住焦点。
 */
function focusAfterClose(trigger: HTMLElement | null) {
  if (trigger !== null && trigger.isConnected) {
    trigger.focus();
    return;
  }
  const list =
    document.querySelector<HTMLElement>("[data-chain-template-list]") ??
    document.querySelector<HTMLElement>("[data-chain-template-page]");
  if (list === null) return;
  if (!list.hasAttribute("tabindex")) list.setAttribute("tabindex", "-1");
  list.focus();
}

/**
 * 转发链模板详情弹窗：标题给模板名 + 跳数 + 链数/用户数，内容四块。
 *
 * 打开状态由列表决定；详情请求只在有选中项时发出。旧主控没有详情接口
 * （只有 404）时整块降级成「需要新版本主控」，不显示半张空图；403 是权限
 * 问题，仍然按错误态提示。
 *
 * 焦点行为与链路详情弹窗一致：打开落在标题，关闭回到触发行，行没了回到
 * 列表容器。
 */
export function ChainTemplateInsightDialog({
  item,
  onClose,
}: {
  item: ChainTemplateListItem | null;
  onClose: () => void;
}) {
  useI18n();
  const open = item !== null;
  // 列表行按钮是触发元素：layout effect 早于 Radix 的焦点陷阱，记下的
  // 还是行；`!== null` 挡住 StrictMode 第二次执行。
  const triggerRef = useRef<HTMLElement | null>(null);
  const isOpenRef = useRef(open);
  useLayoutEffect(() => {
    isOpenRef.current = open;
    if (!open || triggerRef.current !== null) return;
    triggerRef.current = openerElement();
  }, [open]);
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
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-template-dialog
        className="flex max-h-[92dvh] w-[calc(100vw-0.5rem)] max-w-[1040px] flex-col gap-0 overflow-hidden p-0 sm:w-[calc(100vw-2rem)] sm:max-w-[1040px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const container = event.currentTarget;
          if (!(container instanceof HTMLElement)) return;
          container
            .querySelector<HTMLElement>('[data-slot="dialog-title"]')
            ?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const container = event.currentTarget;
          // StrictMode 的假卸载：内容还在文档里，弹窗仍然开着。
          if (
            isOpenRef.current &&
            container instanceof HTMLElement &&
            container.isConnected
          ) {
            return;
          }
          const active = document.activeElement;
          if (
            active !== null &&
            active !== document.body &&
            active !== document.documentElement
          ) {
            triggerRef.current = null;
            return;
          }
          const trigger = triggerRef.current;
          triggerRef.current = null;
          focusAfterClose(trigger);
        }}
      >
        {item ? (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-12 text-left">
              <DialogTitle
                tabIndex={-1}
                className="truncate rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
                  {t(templateFlowCountKey("metaChains", totals.chains), {
                    n: totals.chains,
                  })}
                </Badge>
                <Badge variant="outline" className="font-normal">
                  {t(templateFlowCountKey("metaUsers", totals.users), {
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
