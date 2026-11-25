import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPercentValue } from "@/lib/chainHealth";
import {
  chainTemplateStrategyLabelKey,
  chainTemplateStrategySummary,
  strategyShares,
  type ChainTemplateDetail,
} from "@/lib/chainTemplateInsight";
import { t, useI18n } from "@/i18n";

/**
 * 策略分布：每类策略一条横向条，显示占比 + 链数，底部一行摘要。
 *
 * 只画真实出现的策略（零链不占行），所以条形数量恒等于策略种类数；
 * 颜色只用 primary，不按策略换色相——这里回答的是「占比」而不是分类。
 * 策略种类少时卡片比旁边的节点热度卡短，摘要用同一条数据补出「最常用
 * 哪种、覆盖多少链、一共几种」，不靠空白把卡片撑高。
 */
export function ChainTemplateStrategies({
  detail,
}: {
  detail: ChainTemplateDetail;
}) {
  useI18n();
  const shares = useMemo(
    () => strategyShares(detail.strategies),
    [detail.strategies],
  );
  const summary = useMemo(
    () => chainTemplateStrategySummary(detail.strategies),
    [detail.strategies],
  );
  // 摘要文案随语言切换，所以不缓存（比 useMemo 省一次陈旧依赖的坑）。
  const topLabelKey =
    summary === null ? null : chainTemplateStrategyLabelKey(summary.top.strategy);
  const topLabel = topLabelKey ? t(topLabelKey) : (summary?.top.strategy ?? "");

  return (
    <Card className="min-w-0 gap-0" data-template-strategies-card>
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-sm font-medium">
          {t("overview.chainTemplateInsight.strategiesTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 p-3 sm:p-4">
        {shares.length === 0 ? (
          <p
            data-template-strategies-empty
            className="py-6 text-center text-xs text-muted-foreground"
          >
            {t("overview.chainTemplateInsight.strategiesEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5" data-template-strategies>
            {shares.map((share) => {
              const pct = Math.max(0, Math.min(100, share.pct));
              const labelKey = chainTemplateStrategyLabelKey(share.strategy);
              const label = labelKey ? t(labelKey) : share.strategy;
              return (
                <li
                  key={share.strategy}
                  data-template-strategy-bar
                  data-strategy={share.strategy}
                  data-chains={share.chains}
                  className="min-w-0"
                >
                  <div className="flex min-w-0 items-baseline justify-between gap-3">
                    <span
                      className="min-w-0 truncate text-[11px] text-muted-foreground"
                      title={share.strategy}
                    >
                      {label}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums">
                      {t("overview.chainTemplateInsight.strategyValue", {
                        pct: formatPercentValue(pct),
                        chains: share.chains,
                      })}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(pct)}
                    aria-label={share.strategy}
                    className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {summary !== null ? (
          <p
            data-template-strategies-summary
            className="mt-3 text-[11px] leading-normal text-muted-foreground"
          >
            {t("overview.chainTemplateInsight.strategiesSummary", {
              name: topLabel,
              chains: summary.top.chains,
            })}
            {summary.kinds > 1
              ? ` · ${t("overview.chainTemplateInsight.strategiesSummaryKinds", {
                  n: summary.kinds,
                })}`
              : ""}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
