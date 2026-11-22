import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDollarSignIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  WalletIcon,
} from "lucide-react";
import { EmptyState, ListError } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FxDetailsPopover } from "./FxDetailsPopover";
import { InsightMetrics } from "./InsightMetrics";
import { errorText } from "@/lib/errors";
import {
  buildCostOverview,
  buildMonthExpenses,
  buildRenewalMonth,
  formatCny,
  formatCnyCompact,
  formatCurrency,
  formatMonthIndex,
  formatMonthLabel,
  parseFxRates,
  parseFxUpdatedAt,
  type CostCurrencyMixRow,
  type CostMonthExpense,
  type RenewalMonth,
  type CostOneTimeRow,
  type CostOverview,
  type CostTopRow,
  type FxRates,
} from "@/lib/costOverview";
import type { Server } from "@/lib/api";
import { useServers, useSettings } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** 币种构成用的单色阶：全部走 primary / muted token，不新增色相。 */
const MIX_BAR_CLASS = [
  "bg-primary",
  "bg-primary/60",
  "bg-primary/35",
  "bg-muted-foreground/45",
  "bg-muted-foreground/25",
];

export default function CostView({
  selectedIds,
}: {
  /** 概览级筛选的选中集合；只统计这些服务器的费用。 */
  selectedIds: readonly string[];
}) {
  useI18n();
  const serversQuery = useServers();
  const settingsQuery = useSettings();
  const fx = useMemo(
    () => parseFxRates(settingsQuery.data?.fx_rates),
    [settingsQuery.data?.fx_rates],
  );
  const fxUpdatedAt = useMemo(
    () =>
      parseFxUpdatedAt(settingsQuery.data?.fx_rates_updated_at) ??
      fx.fetchedAt,
    [settingsQuery.data?.fx_rates_updated_at, fx.fetchedAt],
  );
  const scopedServers = useMemo(() => {
    const selected = new Set(selectedIds);
    return (serversQuery.data ?? []).filter((server) =>
      selected.has(server.id),
    );
  }, [serversQuery.data, selectedIds]);
  const overview = useMemo(
    () => buildCostOverview(scopedServers, fx.rates),
    [scopedServers, fx.rates],
  );

  if (serversQuery.isPending || settingsQuery.isPending) {
    return <CostSkeleton />;
  }

  if (serversQuery.isError) {
    return (
      <Card>
        <CardContent>
          <ListError
            title={t("overview.cost.loadFailed")}
            message={errorText(
              serversQuery.error,
              t("overview.cost.loadFailed"),
            )}
            retrying={serversQuery.isFetching}
            onRetry={() => void serversQuery.refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  if (selectedIds.length === 0) return <EmptyCostScope />;
  if (!overview.hasData) return <EmptyCost />;

  return (
    <CostBody
      overview={overview}
      servers={scopedServers}
      fx={fx}
      fxUpdatedAt={fxUpdatedAt}
      settingsError={settingsQuery.isError}
      settingsFetching={settingsQuery.isFetching}
      onRetrySettings={() => void settingsQuery.refetch()}
    />
  );
}

function CostBody({
  overview,
  servers,
  fx,
  fxUpdatedAt,
  settingsError,
  settingsFetching,
  onRetrySettings,
}: {
  overview: CostOverview;
  servers: readonly Partial<Server>[];
  fx: FxRates;
  fxUpdatedAt: number | null;
  settingsError: boolean;
  settingsFetching: boolean;
  onRetrySettings: () => void;
}) {
  const { locale } = useI18n();
  const currentYearHint =
    overview.remainingMonths === 0
      ? t("overview.cost.currentYearZeroHint")
      : t(
          overview.remainingMonths === 1
            ? "overview.cost.currentYearHintOne"
            : "overview.cost.currentYearHint",
          { n: overview.remainingMonths },
        );

  return (
    <div className="space-y-4 -mb-4" data-cost-view>
      <InsightMetrics
        items={[
          {
            label: t("overview.cost.total"),
            value: formatCny(overview.totalCnyCents, locale),
            hint: t("overview.cost.totalHint"),
          },
          {
            label: t("overview.cost.currentYear"),
            value: formatCny(overview.currentYearCnyCents, locale),
            hint: currentYearHint,
          },
          {
            label: t("overview.cost.next12"),
            value: formatCny(overview.next12CnyCents, locale),
            hint: t("overview.cost.next12Hint"),
          },
        ]}
      />

      <FxSummary
        overview={overview}
        fx={fx}
        fxUpdatedAt={fxUpdatedAt}
        locale={locale}
        settingsError={settingsError}
        settingsFetching={settingsFetching}
        onRetry={onRetrySettings}
      />

      <section className="grid items-stretch gap-4 xl:grid-cols-3">
        <MonthExpenseCard
          overview={overview}
          locale={locale}
          className="xl:col-span-2"
        />
        <TopCostCard
          rows={overview.top}
          locale={locale}
          className="h-full"
        />
      </section>

      <section className="grid items-stretch gap-4 xl:grid-cols-2">
        <CurrencyMixCard
          rows={overview.currencyMix}
          locale={locale}
          className="h-full"
        />
        <RenewalCalendarCard
          servers={servers}
          rates={fx.rates}
          months={overview.months}
          locale={locale}
          className="h-full"
        />
      </section>

      {overview.oneTime.length > 0 ? (
        <OneTimeCard
          rows={overview.oneTime}
          locale={locale}
          className="h-full"
        />
      ) : null}
    </div>
  );
}

function FxSummary({
  overview,
  fx,
  fxUpdatedAt,
  locale,
  settingsError,
  settingsFetching,
  onRetry,
}: {
  overview: CostOverview;
  fx: FxRates;
  fxUpdatedAt: number | null;
  locale: string;
  settingsError: boolean;
  settingsFetching: boolean;
  onRetry: () => void;
}) {
  if (!fx.provided) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-warning">
        <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          {settingsError
            ? t("overview.cost.fxLoadFailed")
            : t("overview.cost.fxMissing")}
        </span>
        {settingsError ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={onRetry}
            disabled={settingsFetching}
          >
            <RefreshCwIcon
              className={cn("size-3", settingsFetching && "animate-spin")}
            />
            {t("common.retry")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
      data-cost-fx
    >
      <span>{t("overview.cost.fxShort")}</span>
      <FxDetailsPopover
        overview={overview}
        fx={fx}
        fxUpdatedAt={fxUpdatedAt}
        locale={locale}
      />
    </div>
  );
}

function MonthExpenseCard({
  overview,
  locale,
  className,
}: {
  overview: CostOverview;
  locale: string;
  className?: string;
}) {
  const months = useMemo(() => buildMonthExpenses(overview), [overview]);

  return (
    <Card
      className={cn("flex h-full min-w-0 flex-col gap-0", className)}
      data-cost-card="month"
    >
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.cost.calendarTitle")}
          </CardTitle>
          <span className="text-[10px] text-muted-foreground">
            {t("overview.cost.monthUnit")}
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col p-3 sm:p-4">
        <MonthBarChart months={months} locale={locale} />
        {overview.excluded.length > 0 ? (
          <p className="mt-auto border-t border-border pt-3 text-xs text-muted-foreground">
            {t("overview.cost.excluded", { n: overview.excluded.length })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MonthBarChart({
  months,
  locale,
}: {
  months: CostMonthExpense[];
  locale: string;
}) {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const max = Math.max(0, ...months.map((month) => month.totalCnyCents));
  const scaleMax = max > 0 ? max : 1;
  const spansYears =
    new Set(months.map((month) => Math.floor(month.monthIndex / 12)))
      .size > 1;
  const active =
    activeIndex === null ? null : (months[activeIndex] ?? null);
  const plotRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (!plot || !tooltip || activeIndex === null) return;
    const bar = plot.querySelectorAll<HTMLElement>("[data-month-bar]")[
      activeIndex
    ];
    if (!bar) return;

    const plotRect = plot.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const fill = bar.firstElementChild?.getBoundingClientRect() ?? null;
    const gap = 10;
    const edge = 4;

    const center = barRect.left + barRect.width / 2 - plotRect.left;
    const barLeft = barRect.left - plotRect.left;
    const barRight = barRect.right - plotRect.left;
    const visualLeft = fill ? fill.left - plotRect.left : barLeft;
    const visualRight = fill ? fill.right - plotRect.left : barRight;
    const barTop = fill
      ? fill.top - plotRect.top
      : barRect.bottom - plotRect.top;
    const barBottom = fill
      ? fill.bottom - plotRect.top
      : barRect.bottom - plotRect.top;
    const barHeight = Math.max(0, barBottom - barTop);
    const maxLeft = plotRect.width - tooltipRect.width - edge;

    let placement = "above";
    let left = Math.max(
      edge,
      Math.min(maxLeft, center - tooltipRect.width / 2),
    );
    let top = barTop - tooltipRect.height - gap;

    if (top < edge) {
      placement = "below";
      top = barBottom + gap;
    }

    if (top < edge || top + tooltipRect.height > plotRect.height - edge) {
      const aboveFits = barTop - tooltipRect.height - gap >= edge;
      const belowFits =
        barBottom + gap + tooltipRect.height <= plotRect.height - edge;
      if (aboveFits) {
        placement = "above";
        top = barTop - tooltipRect.height - gap;
      } else if (belowFits) {
        placement = "below";
        top = barBottom + gap;
      } else {
        const rightFits =
          visualRight + gap + tooltipRect.width <= plotRect.width - edge;
        const leftFits = visualLeft - gap - tooltipRect.width >= edge;
        if (center < plotRect.width / 2 && rightFits) {
          placement = "right";
          left = visualRight + gap;
        } else if (leftFits) {
          placement = "left";
          left = visualLeft - gap - tooltipRect.width;
        } else {
          placement = "overlap";
        }
        top = barTop + (barHeight - tooltipRect.height) / 2;
      }
    }

    left = Math.max(edge, Math.min(maxLeft, left));
    top = Math.max(
      edge,
      Math.min(plotRect.height - tooltipRect.height - edge, top),
    );

    tooltip.dataset.placement = placement;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.opacity = "1";
  }, [activeIndex, active]);

  return (
    <div className="flex min-h-[340px] flex-1 flex-col" data-cost-bar-chart>
      <div className="relative flex min-h-0 flex-1 gap-2">
        <div className="flex w-9 shrink-0 flex-col justify-between pb-1 text-right text-[9px] text-muted-foreground tabular-nums">
          {[max, max * (2 / 3), max * (1 / 3), 0].map(
            (value, index) => (
              <span key={index} className="truncate">
                ¥{formatCnyCompact(value, locale)}
              </span>
            ),
          )}
        </div>

        <div
          ref={plotRef}
          className="relative flex min-w-0 flex-1 items-end gap-1"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex flex-col justify-between"
          >
            {[0, 1, 2, 3].map((line) => (
              <span key={line} className="border-t border-border/40" />
            ))}
          </div>

          {months.map((month, index) => {
            const height =
              scaleMax > 0
                ? Math.max(0, (month.totalCnyCents / scaleMax) * 100)
                : 0;
            const empty =
              month.totalCnyCents === 0 && month.prepaid.length === 0;
            return (
              <button
                key={month.monthIndex}
                type="button"
                data-month-bar
                data-month-index={index}
                data-month-key={month.monthIndex}
                data-month-total-cents={month.totalCnyCents}
                data-month-charge-count={month.charges.length}
                aria-label={
                  empty
                    ? t("overview.cost.monthBarAriaEmpty", {
                        month: formatMonthIndex(month.monthIndex),
                      })
                    : t("overview.cost.monthBarAria", {
                        month: formatMonthIndex(month.monthIndex),
                        amount: formatCny(month.totalCnyCents, locale),
                        n: month.charges.length,
                      })
                }
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onMouseLeave={(event) => {
                  if (event.currentTarget.matches(":focus")) return;
                  setActiveIndex((current) =>
                    current === index ? null : current,
                  );
                }}
                onBlur={() =>
                  setActiveIndex((current) =>
                    current === index ? null : current,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape") setActiveIndex(null);
                }}
                className="group relative flex h-full min-w-0 flex-1 items-end justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "w-full max-w-9 rounded-t-[3px] transition-colors duration-150",
                    month.totalCnyCents > 0
                      ? "bg-primary/80 group-hover:bg-primary group-focus-visible:bg-primary"
                      : "bg-transparent",
                  )}
                  style={{ height: `${height}%` }}
                />
              </button>
            );
          })}

          {active ? (
            <MonthExpenseTooltip
              month={active}
              locale={locale}
              containerRef={tooltipRef}
              className="absolute z-20"
            />
          ) : null}
        </div>
      </div>

      {spansYears ? (
        <p className="ml-11 mt-1 text-right text-[8px] text-muted-foreground sm:hidden">
          {Math.floor(months[0].monthIndex / 12)}–
          {Math.floor(months.at(-1)!.monthIndex / 12)}
        </p>
      ) : null}
      <div className="ml-11 mt-1 flex gap-1">
        {months.map((month) => {
          const year = Math.floor(month.monthIndex / 12);
          const showYear = spansYears && month.monthIndex % 12 === 0;
          return (
            <span
              key={month.monthIndex}
              className="flex min-w-0 flex-1 flex-col items-center text-[9px] leading-tight text-muted-foreground"
              title={formatMonthIndex(month.monthIndex)}
            >
              <span className="truncate">
                {formatMonthLabel(month.monthIndex, locale)}
              </span>
              {showYear ? (
                <span className="text-[8px] opacity-70 max-sm:hidden">
                  {year}
                </span>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function MonthExpenseTooltip({
  month,
  locale,
  className,
  containerRef,
}: {
  month: CostMonthExpense;
  locale: string;
  className?: string;
  containerRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const hasSpending = month.charges.length > 0;

  return (
    <div
      ref={containerRef}
      role="tooltip"
      data-month-tooltip
      data-month-key={month.monthIndex}
      style={{ left: 0, top: 0, opacity: 0 }}
      className={cn(
        "pointer-events-none w-[min(18rem,calc(100%-1rem))] rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg/40",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5">
        <span className="font-medium text-foreground">
          {formatMonthIndex(month.monthIndex)}
        </span>
        <span
          data-month-tooltip-total
          className="font-mono tabular-nums text-foreground"
        >
          {formatCny(month.totalCnyCents, locale)}
        </span>
      </div>

      {hasSpending ? (
        <ul
          className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto"
          data-month-tooltip-list
        >
          {month.charges.slice(0, 8).map((row) => (
            <li
              key={row.serverId}
              data-month-tooltip-server
              className="flex min-w-0 items-center justify-between gap-3"
            >
              <span className="min-w-0 truncate text-muted-foreground" title={row.name}>
                {row.name}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {row.kind === "once" ? (
                  <span className="rounded-sm bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                    {t("overview.cost.onceShort")}
                  </span>
                ) : null}
                {row.prepaid ? (
                  <span className="rounded-sm bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                    {t("overview.cost.calendarLegendPrepaid")}
                  </span>
                ) : null}
                <span className="font-mono tabular-nums text-foreground">
                  {formatCny(row.amountCnyCents, locale)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p
          data-month-tooltip-empty
          className="mt-1.5 text-[11px] text-muted-foreground"
        >
          {t("overview.cost.monthNoSpend")}
        </p>
      )}

      {month.hiddenCharges > 0 ? (
        <p
          data-month-tooltip-more
          className="mt-1 text-[10px] text-muted-foreground"
        >
          {t("overview.cost.monthMore", { n: month.hiddenCharges })}
        </p>
      ) : null}

      {month.prepaid.length > 0 ? (
        <div
          data-month-tooltip-prepaid
          className="mt-1.5 border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground"
        >
          <p>
            {t("overview.cost.monthPrepaid", {
              n: month.prepaid.length,
            })}
          </p>
          <p className="truncate">
            {month.prepaid
              .slice(0, 4)
              .map((row) => row.name)
              .join(" · ")}
            {month.prepaid.length > 4
              ? ` · +${month.prepaid.length - 4}`
              : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function RenewalCalendarCard({
  servers,
  rates,
  months,
  locale,
  className,
}: {
  servers: readonly Partial<Server>[];
  rates: Readonly<Record<string, number>>;
  months: number[];
  locale: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [cardElement, setCardElement] = useState<HTMLDivElement | null>(null);
  const [monthIndex, setMonthIndex] = useState(months[0] ?? 0);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const month: RenewalMonth = useMemo(
    () => buildRenewalMonth(servers, rates, monthIndex),
    [servers, rates, monthIndex],
  );
  const position = months.indexOf(monthIndex);
  const canPrev = position > 0;
  const canNext = position >= 0 && position < months.length - 1;

  const monthTitle = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "long",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(month.year, month.month, 1))),
    [locale, month.month, month.year],
  );
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) =>
        new Intl.DateTimeFormat(locale, {
          weekday: "short",
          timeZone: "UTC",
        }).format(new Date(Date.UTC(2024, 0, index + 1))),
      ),
    [locale],
  );
  const busiestLabel =
    month.busiestDay === null
      ? null
      : new Intl.DateTimeFormat(locale, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(
          new Date(Date.UTC(month.year, month.month, month.busiestDay)),
        );

  function changeMonth(next: number) {
    setMonthIndex(next);
    setSelectedDay(null);
  }

  return (
    <Card
      ref={setCardElement}
      className={cn(
        "flex h-full min-h-[380px] min-w-0 flex-col gap-0",
        className,
      )}
      data-cost-card="renewal"
    >
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.cost.renewalTitle")}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              data-renewal-prev
              aria-label={t("overview.cost.renewalPrev")}
              disabled={!canPrev}
              onClick={() => changeMonth(months[position - 1] ?? monthIndex)}
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
            <span
              data-renewal-month
              className="min-w-24 text-center text-xs font-medium tabular-nums"
            >
              {monthTitle}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              data-renewal-next
              aria-label={t("overview.cost.renewalNext")}
              disabled={!canNext}
              onClick={() => changeMonth(months[position + 1] ?? monthIndex)}
            >
              <ChevronRightIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col p-2 sm:p-3">
        <TooltipProvider delayDuration={80}>
          <div
            className="grid flex-1 auto-rows-fr grid-cols-7 gap-1 text-center"
            data-renewal-grid
          >
            {weekdays.map((weekday) => (
              <span
                key={weekday}
                data-renewal-weekday
                className="pb-1 text-[9px] text-muted-foreground"
              >
                {weekday}
              </span>
            ))}
            {Array.from({ length: month.firstWeekday }, (_, index) => (
              <span key={`blank-${index}`} aria-hidden="true" />
            ))}
            {Array.from(
              {
                length: Math.max(
                  0,
                  42 - month.firstWeekday - month.daysInMonth,
                ),
              },
              (_, index) => (
                <span key={`trailing-${index}`} aria-hidden="true" />
              ),
            )}
            {month.days.map((day) => {
              if (day.events.length === 0) {
                return (
                  <span
                    key={day.day}
                    data-renewal-cell
                    data-renewal-day-number={day.day}
                    className="flex min-h-12 flex-col items-start rounded-md border border-border/30 p-1 text-left text-[9px] text-muted-foreground"
                  >
                    {day.day}
                  </span>
                );
              }
              const knownAmount = day.events.some(
                (event) => event.amountCnyCents !== null,
              );
              const selected = selectedDay === day.day;
              return (
                <Tooltip key={day.day}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-renewal-day
                      data-renewal-cell
                      data-renewal-day-number={day.day}
                      data-renewal-date={`${month.year}-${String(month.month + 1).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`}
                      data-renewal-count={day.count}
                      data-renewal-total={day.totalCnyCents}
                      aria-pressed={selected}
                      aria-label={t("overview.cost.renewalDayAria", {
                        date: `${month.month + 1}/${day.day}`,
                        n: day.count,
                        amount: knownAmount
                          ? formatCny(day.totalCnyCents, locale)
                          : "—",
                      })}
                      onClick={() =>
                        setSelectedDay((current) =>
                          current === day.day ? null : day.day,
                        )
                      }
                      className={cn(
                        "relative flex min-h-12 min-w-0 flex-col items-start justify-between rounded-md border p-1 text-left transition-colors duration-150",
                        selected
                          ? "border-primary bg-primary/10 ring-1 ring-primary"
                          : "border-border/60 bg-primary/5 hover:bg-primary/10",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                    >
                      <span className="text-[9px] text-muted-foreground">
                        {day.day}
                      </span>
                      <span className="w-full truncate text-left font-mono text-[10px] text-primary tabular-nums">
                        {knownAmount
                          ? `¥${formatCnyCompact(day.totalCnyCents, locale)}`
                          : "—"}
                      </span>
                      <span
                        data-renewal-badge
                        className="absolute right-1 top-1 rounded-full bg-primary/10 px-1 text-[8px] text-primary tabular-nums"
                      >
                        {t("overview.cost.renewalBadge", {
                          n: day.count,
                        })}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={8}
                    collisionPadding={12}
                    collisionBoundary={cardElement ?? undefined}
                    data-renewal-tooltip
                    className="block w-72 max-w-[calc(100vw-2rem)] border border-border bg-popover p-0 text-popover-foreground shadow-lg/40 [&>svg]:bg-popover [&>svg]:fill-popover"
                  >
                    <div className="p-3">
                      <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5">
                        <span className="text-xs font-medium">
                          {monthTitle} {day.day}
                        </span>
                        <span className="font-mono text-xs tabular-nums">
                          {knownAmount
                            ? formatCny(day.totalCnyCents, locale)
                            : "—"}
                        </span>
                      </div>
                      <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto">
                        {day.events.slice(0, 8).map((event) => (
                          <li
                            key={event.serverId}
                            data-renewal-tooltip-row
                            className="flex min-w-0 items-center justify-between gap-3"
                          >
                            <span
                              className="min-w-0 truncate text-muted-foreground"
                              title={event.name}
                            >
                              {event.name}
                            </span>
                            <span className="shrink-0 font-mono tabular-nums">
                              {event.amountCnyCents === null
                                ? "—"
                                : formatCny(event.amountCnyCents, locale)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {day.events.length > 8 ? (
                        <p
                          data-renewal-tooltip-more
                          className="mt-1 text-[10px] text-muted-foreground"
                        >
                          {t("overview.cost.monthMore", {
                            n: day.events.length - 8,
                          })}
                        </p>
                      ) : null}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </TooltipProvider>

        <p
          data-renewal-summary
          className="mt-auto border-t border-border pt-3 text-[11px] leading-normal text-muted-foreground"
        >
          {month.activeDays === 0
            ? t("overview.cost.renewalEmpty")
            : t("overview.cost.renewalSummary", {
                days: month.activeDays,
                n: month.totalServers,
                date: busiestLabel ?? "—",
                k: month.busiestCount,
              })}
        </p>
      </CardContent>
    </Card>
  );
}

function TopCostCard({
  rows,
  locale,
  className,
}: {
  rows: CostTopRow[];
  locale: string;
  className?: string;
}) {
  const max = rows[0]?.cycleCnyCents ?? 0;

  return (
    <Card className={cn("flex h-full flex-col gap-0", className)} data-cost-card="top">
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.cost.topTitle")}
          </CardTitle>
          <Badge variant="outline" className="shrink-0 font-normal">
            Top 5
          </Badge>
        </div>
      </CardHeader>
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={CircleDollarSignIcon}
          title={t("overview.cost.topEmpty")}
          className="py-10"
        />
      ) : (
        <CardContent className="p-2">
          <ul className="flex flex-col gap-0.5">
            {rows.map((row, index) => (
              <li key={row.serverId} className="rounded-md px-2.5 py-1.5">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="w-3 shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    title={row.name}
                  >
                    {row.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {row.currency}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums">
                    {formatCny(row.cycleCnyCents, locale)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 pl-5">
                  <span
                    aria-hidden="true"
                    className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{
                        width:
                          max > 0
                            ? `${Math.round((row.cycleCnyCents / max) * 100)}%`
                            : "0%",
                      }}
                    />
                  </span>
                  <span
                    className="w-8 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums"
                    title={t("overview.cost.topShare", {
                      share: row.share.toFixed(0),
                    })}
                  >
                    {row.share.toFixed(0)}%
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

function CurrencyMixCard({
  rows,
  locale,
  className,
}: {
  rows: CostCurrencyMixRow[];
  locale: string;
  className?: string;
}) {
  return (
    <Card className={cn("flex h-full flex-col gap-0", className)} data-cost-card="mix">
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.cost.mixTitle")}
          </CardTitle>
          <Badge variant="outline" className="shrink-0 font-normal">
            {t(
              rows.length === 1
                ? "overview.cost.mixCountOne"
                : "overview.cost.mixCount",
              { n: rows.length },
            )}
          </Badge>
        </div>
      </CardHeader>
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={CircleDollarSignIcon}
          title={t("overview.cost.mixEmpty")}
          className="py-10"
        />
      ) : (
        <CardContent className="p-2">
          <div
            aria-hidden="true"
            className="mb-2 flex h-2 overflow-hidden rounded-full bg-muted"
          >
            {rows.map((row, index) => (
              <span
                key={row.currency}
                className={cn(
                  "block h-full",
                  MIX_BAR_CLASS[index % MIX_BAR_CLASS.length],
                )}
                style={{ width: `${Math.max(0, Math.min(100, row.share))}%` }}
              />
            ))}
          </div>
          <ul className="flex flex-col">
            {rows.map((row, index) => (
              <li
                key={row.currency}
                className="flex min-w-0 items-center gap-2 px-2.5 py-1 text-xs"
                title={t("overview.cost.mixOriginal", {
                  amount: formatCurrency(
                    row.cycleOriginalCents,
                    row.currency,
                    locale,
                  ),
                })}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-[2px]",
                    MIX_BAR_CLASS[index % MIX_BAR_CLASS.length],
                  )}
                />
                <span className="w-9 shrink-0 font-mono">{row.currency}</span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-muted-foreground tabular-nums">
                  {row.currency === "CNY"
                    ? "—"
                    : formatCurrency(
                        row.cycleOriginalCents,
                        row.currency,
                        locale,
                      )}
                </span>
                <span className="shrink-0 font-mono tabular-nums">
                  {formatCny(row.cycleCnyCents, locale)}
                </span>
                <span className="w-8 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
                  {row.share.toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

function OneTimeCard({
  rows,
  locale,
  className,
}: {
  rows: CostOneTimeRow[];
  locale: string;
  className?: string;
}) {
  return (
    <Card className={cn("flex h-full flex-col gap-0", className)} data-cost-card="once">
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.cost.oneTimeTitle")}
          </CardTitle>
          <Badge
            variant="outline"
            className="shrink-0 font-normal text-muted-foreground"
            title={t("overview.cost.oneTimeHint")}
          >
            {t("overview.cost.oneTimeBadge")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-2">
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li
              key={row.serverId}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md px-2.5 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm" title={row.name}>
                {row.name}
              </span>
              {row.currency === "CNY" ? (
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  {formatCny(row.amountCents, locale)}
                </span>
              ) : (
                <>
                  <span className="shrink-0 font-mono text-xs tabular-nums">
                    {formatCurrency(row.amountCents, row.currency, locale)}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {formatCny(row.amountCnyCents, locale)}
                  </span>
                </>
              )}
              {row.paidUntil ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {t("overview.cost.oneTimePaidUntil", {
                    date: row.paidUntil,
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function EmptyCostScope() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          size="sm"
          icon={WalletIcon}
          title={t("overview.scope.emptyTitle")}
          description={t("overview.scope.emptyDesc")}
          className="py-16"
        />
      </CardContent>
    </Card>
  );
}

function EmptyCost() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          tone="primary"
          icon={WalletIcon}
          title={t("overview.cost.emptyTitle")}
          description={t("overview.cost.emptyDesc")}
          className="py-16"
          action={
            <Button asChild>
              <Link to="/servers">{t("overview.cost.emptyAction")}</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}

function CostSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <Skeleton className="h-[88px] w-full rounded-xl" />
      <Skeleton className="h-3 w-72 max-w-full" />
      <section className="grid gap-4 xl:grid-cols-3">
        <Skeleton className="h-[420px] w-full rounded-xl xl:col-span-2" />
        <div className="grid gap-4">
          <Skeleton className="h-[220px] w-full rounded-xl" />
          <Skeleton className="h-[200px] w-full rounded-xl" />
        </div>
      </section>
    </div>
  );
}
