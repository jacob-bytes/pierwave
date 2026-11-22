import { useMemo } from "react";
import { CircleHelpIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  buildFxDetails,
  formatFxRateDisplay,
  type CostOverview,
  type FxRates,
} from "@/lib/costOverview";
import { formatAbsoluteTime } from "@/lib/time";
import { t, useI18n } from "@/i18n";

/**
 * 成本页的汇率明细。主视图只留一句「按汇率折算为 CNY」，完整列表收在
 * 小问号里；只展示实际用到的币种，不展开整张 FX 表。
 */
export function FxDetailsPopover({
  overview,
  fx,
  fxUpdatedAt,
  locale,
}: {
  overview: CostOverview;
  fx: FxRates;
  fxUpdatedAt: number | null;
  locale: string;
}) {
  useI18n();
  const details = useMemo(
    () => buildFxDetails(overview, fx.rates),
    [overview, fx.rates],
  );
  const source =
    fx.source?.toLowerCase() === "manual"
      ? t("overview.cost.fxSourceManual")
      : t("overview.cost.fxSourceAuto");
  const updated =
    fxUpdatedAt === null
      ? null
      : t("overview.cost.fxSourceUpdated", {
          source,
          time: formatAbsoluteTime(fxUpdatedAt),
        });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-5 shrink-0 rounded-full p-0 text-muted-foreground hover:text-foreground"
          aria-label={t("overview.cost.fxDetailsAria")}
          data-cost-fx-trigger
        >
          <CircleHelpIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="w-[min(22rem,calc(100vw-2rem))] gap-0 p-0"
        data-fx-popover
      >
        <div className="border-b border-border px-3 py-2 text-xs font-medium">
          {t("overview.cost.fxDetailsTitle")}
        </div>

        <div className="max-h-64 overflow-y-auto" data-fx-list>
          {details.rows.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              {t("overview.cost.fxNoCurrencies")}
            </p>
          ) : (
            details.rows.map((row) => (
              <div
                key={row.currency}
                data-fx-row
                className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-xs font-medium text-foreground">
                      {row.currency}
                    </span>
                    {row.currency === "CNY" ? (
                      <span className="rounded-sm bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                        {t("overview.cost.fxBase")}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    1 {row.currency} = ¥
                    {formatFxRateDisplay(row.rate, locale)}
                  </p>
                </div>
                <span className="shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {t(
                    row.count === 1
                      ? "overview.cost.fxServerCountOne"
                      : "overview.cost.fxServerCount",
                    { n: row.count },
                  )}
                </span>
              </div>
            ))
          )}
        </div>

        {details.unknownCount > 0 ? (
          <div
            data-fx-unknown
            className="flex items-start gap-1.5 border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-[10px] leading-normal text-destructive"
          >
            <TriangleAlertIcon
              className="mt-0.5 size-3 shrink-0"
              aria-hidden="true"
            />
            <span>
              {t(
                details.unknownCount === 1
                  ? "overview.cost.fxUnknownInlineOne"
                  : "overview.cost.fxUnknownInline",
                {
                  n: details.unknownCount,
                  codes: details.unknownCodes.join(" · "),
                },
              )}
            </span>
          </div>
        ) : null}

        <div
          data-fx-footer
          className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground"
        >
          {updated ?? source}
        </div>
      </PopoverContent>
    </Popover>
  );
}
