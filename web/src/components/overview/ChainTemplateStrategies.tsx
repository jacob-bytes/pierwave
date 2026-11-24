import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPercentValue } from "@/lib/chainHealth";
import {
  chainTemplateStrategyLabelKey,
  strategyShares,
  type ChainTemplateDetail,
} from "@/lib/chainTemplateInsight";
import { t, useI18n } from "@/i18n";

/**
 * 策略分布：每类策略一条横向条，显示占比 + 链数。
 *
 * 只画真实出现的策略（零链不占行），所以条形数量恒等于策略种类数；
 * 颜色只用 primary，不按策略换色相——这里回答的是「占比」而不是分类。
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
                      className="min-w-0 truncate text-[10px] text-muted-foreground"
                      title={share.strategy}
                    >
                      {label}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums">
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
      </CardContent>
    </Card>
  );
}
