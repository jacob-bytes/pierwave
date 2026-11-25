import {
  ChainKpiCell,
  ChainKpiGrid,
  type ChainKpiTone,
} from "@/components/overview/ChainKpi";
import { Skeleton } from "@/components/ui/skeleton";
import {
  chainTemplateKpis,
  type ChainTemplateListItem,
} from "@/lib/chainTemplateInsight";
import { t, useI18n } from "@/i18n";

/**
 * 模板子页的四格概览：模板总数 / 使用中的模板 / 使用用户 / 异常模板。
 *
 * 数据全部由 `chainTemplateKpis()` 从 `/api/v1/overview/chain-templates`
 * 的列表项聚合，不额外请求接口。空态与降级态不显示 0：没有模板时
 * 四格都是 `—`；接口失败 / 旧主控时同样是 `—`，并把 `data-state` 交给
 * 列表卡片一起显示降级原因，避免 KPI 用 0 假装「一切正常」。
 */
export type ChainTemplateKpiState = "ready" | "empty" | "unavailable";

const DASH = "—";

export function ChainTemplateKpis({
  items,
  state,
}: {
  items: readonly ChainTemplateListItem[];
  state: ChainTemplateKpiState;
}) {
  useI18n();
  const view = chainTemplateKpis(items);
  const empty = state !== "ready";
  const abnormalTone: ChainKpiTone =
    view.blocked > 0 ? "destructive" : view.degraded > 0 ? "warning" : "muted";

  return (
    <ChainKpiGrid data-chain-template-kpis data-state={state}>
      <ChainKpiCell
        data-template-kpi="total"
        label={t("overview.chainTemplateInsight.kpiTotal")}
        value={
          empty
            ? DASH
            : t("overview.chainTemplateInsight.kpiTotalValue", { n: view.total })
        }
        hint={
          empty
            ? undefined
            : t("overview.chainTemplateInsight.kpiTotalHint", {
                enabled: view.enabled,
                disabled: view.disabled,
              })
        }
      />
      <ChainKpiCell
        data-template-kpi="in-use"
        label={t("overview.chainTemplateInsight.kpiInUse")}
        value={
          empty
            ? DASH
            : t("overview.chainTemplateInsight.kpiInUseValue", {
                n: view.inUse,
              })
        }
        hint={
          empty
            ? undefined
            : t("overview.chainTemplateInsight.kpiInUseHint", {
                n: view.chains,
              })
        }
      />
      <ChainKpiCell
        data-template-kpi="users"
        label={t("overview.chainTemplateInsight.kpiUsers")}
        value={
          empty
            ? DASH
            : t("overview.chainTemplateInsight.kpiUsersValue", {
                n: view.users,
              })
        }
        hint={
          empty
            ? undefined
            : t("overview.chainTemplateInsight.kpiUsersHint")
        }
      />
      <ChainKpiCell
        data-template-kpi="abnormal"
        label={t("overview.chainTemplateInsight.kpiAbnormal")}
        value={
          empty
            ? DASH
            : t("overview.chainTemplateInsight.kpiAbnormalValue", {
                n: view.abnormal,
              })
        }
        hint={
          empty
            ? undefined
            : t("overview.chainTemplateInsight.kpiAbnormalHint", {
                blocked: view.blocked,
                degraded: view.degraded,
              })
        }
        tone={empty ? "muted" : abnormalTone}
      />
    </ChainKpiGrid>
  );
}

/** 与真实四格同高同栅格，避免加载完成时列表跳一下。 */
export function ChainTemplateKpisSkeleton() {
  return (
    <ChainKpiGrid data-chain-template-kpis-skeleton aria-hidden="true">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={index}
          data-chain-template-kpi-skeleton
          className="min-h-[164px] min-w-0 bg-card px-3 py-4 sm:px-5 xl:min-h-[136px]"
        >
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-3 h-7 w-14" />
          <Skeleton className="mt-3 h-3 w-24" />
        </div>
      ))}
    </ChainKpiGrid>
  );
}
