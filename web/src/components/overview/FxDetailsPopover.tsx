import { useEffect, useMemo, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/**
 * 成本页的汇率明细。正常汇率收进图表卡头的 `CNY` 标签（点击或悬停打开），
 * 缺汇率时由顶部警告行复用同一个触发器；完整列表只展示实际用到的币种。
 */
export function FxDetailsPopover({
  overview,
  fx,
  fxUpdatedAt,
  locale,
  triggerLabel,
}: {
  overview: CostOverview;
  fx: FxRates;
  fxUpdatedAt: number | null;
  locale: string;
  /** 传入时用「CNY ⓘ」标签代替问号图标，贴在图表卡头。 */
  triggerLabel?: string;
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

  // 桌面端悬停即看明细；触屏仍以点击为准。用 hoverOpened 区分「悬停打开」
  // 与「点击打开」，前者移开鼠标就关，后者要再点一次或按 Esc / 点空白。
  const [open, setOpen] = useState(false);
  const hoverOpened = useRef(false);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, 160);
  };

  useEffect(
    () => () => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
      }
    },
    [],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "shrink-0 text-muted-foreground hover:text-foreground",
            triggerLabel
              ? "h-6 w-auto gap-1 rounded-md px-1.5 text-[11px] font-normal"
              : "size-5 rounded-full p-0",
          )}
          aria-label={
            triggerLabel
              ? `${triggerLabel} · ${t("overview.cost.fxDetailsAria")}`
              : t("overview.cost.fxDetailsAria")
          }
          title={t("overview.cost.fxDetailsAria")}
          data-cost-fx-trigger
          data-cost-fx-trigger-label={triggerLabel ?? undefined}
          onPointerEnter={(event) => {
            if (event.pointerType !== "mouse") return;
            cancelClose();
            // 点击打开后再把鼠标移回来，不应让「移开即关」接管。
            if (open) return;
            hoverOpened.current = true;
            setOpen(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== "mouse") return;
            if (hoverOpened.current) scheduleClose();
          }}
          onClick={(event) => {
            // 由本组件接管开合：悬停已打开时点击不应把它关掉。
            event.preventDefault();
            cancelClose();
            if (open && !hoverOpened.current) {
              setOpen(false);
            } else {
              hoverOpened.current = false;
              setOpen(true);
            }
          }}
        >
          {triggerLabel ? (
            <>
              <span className="font-mono">{triggerLabel}</span>
              <CircleHelpIcon className="size-3" aria-hidden="true" />
            </>
          ) : (
            <CircleHelpIcon className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={triggerLabel ? "end" : "start"}
        collisionPadding={12}
        className="w-[min(22rem,calc(100vw-2rem))] gap-0 p-0"
        data-fx-popover
        data-fx-missing={!fx.provided || undefined}
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          cancelClose();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "mouse") return;
          if (hoverOpened.current) scheduleClose();
        }}
        onOpenAutoFocus={(event) => {
          // 悬停打开时不要把焦点从页面抢走；键盘/点击打开仍正常聚焦。
          if (hoverOpened.current) event.preventDefault();
        }}
      >
        <div className="border-b border-border px-3 py-2 text-xs font-medium">
          {t("overview.cost.fxDetailsTitle")}
        </div>

        <div className="max-h-64 overflow-y-auto" data-fx-list>
          {details.rows.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              {t(
                fx.provided
                  ? "overview.cost.fxNoCurrencies"
                  : "overview.cost.fxNoUsableCurrencies",
              )}
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
                      <span className="rounded-sm bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                        {t("overview.cost.fxBase")}
                      </span>
                    ) : null}
                  </div>
                  {row.currency === "CNY" ? null : (
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      1 {row.currency} = CNY{" "}
                      {formatFxRateDisplay(row.rate, locale)}
                    </p>
                  )}
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
            className="flex items-start gap-1.5 border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px] leading-normal text-destructive"
          >
            <TriangleAlertIcon
              className="mt-0.5 size-3 shrink-0"
              aria-hidden="true"
            />
            <span>
              {t("overview.cost.unknownCurrencies", {
                n: details.unknownCount,
                codes: details.unknownCodes.join(" · "),
              })}
            </span>
          </div>
        ) : null}

        {fx.provided ? null : (
          <div
            data-fx-missing-hint
            className="border-t border-border bg-muted/30 px-3 py-2 text-[11px] leading-normal text-muted-foreground"
          >
            <p>{t("overview.cost.fxNotConfigured")}</p>
            <p className="mt-0.5">{t("overview.cost.fxHowToConfigure")}</p>
          </div>
        )}

        <div
          data-fx-footer
          className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground"
        >
          {fx.provided ? (updated ?? source) : t("overview.cost.fxMissingShort")}
        </div>
      </PopoverContent>
    </Popover>
  );
}
