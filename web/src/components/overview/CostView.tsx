import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
} from "recharts";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  renewalRowsFromScope,
  type CostCurrencyMixRow,
  type CostMonthExpense,
  type RenewalDay,
  type RenewalEvent,
  type RenewalMonth,
  type RenewalSourceRow,
  type CostOneTimeRow,
  type CostOverview,
  type CostTopRow,
  type FxRates,
} from "@/lib/costOverview";
import { useServers, useSettings } from "@/lib/queries";
import { formatAbsoluteTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** 饼图沿用单一 primary 色相，仅用透明度阶梯区分。 */
const PIE_OPACITY = [1, 0.8, 0.65, 0.5, 0.35];

interface CurrencyPieRow {
  key: string;
  label: string;
  originalCents: number | null;
  cnyCents: number;
  share: number;
  count: number;
  items: CostCurrencyMixRow[];
  isOther: boolean;
}

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
  fx,
  fxUpdatedAt,
  settingsError,
  settingsFetching,
  onRetrySettings,
}: {
  overview: CostOverview;
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
        <div
          className="grid h-full min-h-0 gap-4 xl:grid-rows-[minmax(0,1fr)_auto]"
          data-cost-right-column
        >
          <TopCostCard
            rows={overview.top}
            locale={locale}
            className="h-full min-h-0"
          />
          <OneTimeCard
            rows={overview.oneTime}
            locale={locale}
            className="h-full"
          />
        </div>
      </section>

      <section className="grid items-stretch gap-4 xl:grid-cols-3">
        <CurrencyMixCard
          rows={overview.currencyMix}
          totalCnyCents={overview.totalCnyCents}
          source={fx.source}
          updatedAt={fxUpdatedAt}
          locale={locale}
          className="h-full xl:col-span-2"
        />
        <RenewalCalendarCard
          servers={renewalRowsFromScope(overview.scope)}
          months={overview.months}
          locale={locale}
          className="h-full"
        />
      </section>
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
  // 只有真的用到非 CNY 金额时，「未提供汇率 → 非 CNY 未计入」才是有效警告；
  // 全 CNY 时不该用一句看不懂的警告占据成本页顶部。
  const usesForeign =
    overview.unknownCurrency.length > 0 ||
    overview.scope.some((row) => row.currency !== "CNY");

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs",
        !fx.provided && usesForeign
          ? "text-warning"
          : "text-muted-foreground",
      )}
      data-cost-fx
      data-fx-provided={fx.provided || undefined}
    >
      {!fx.provided && usesForeign ? (
        <>
          <TriangleAlertIcon
            className="size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0">
            {settingsError
              ? t("overview.cost.fxLoadFailed")
              : t("overview.cost.fxMissing")}
          </span>
        </>
      ) : (
        <span>
          {t(
            fx.provided
              ? "overview.cost.fxShort"
              : "overview.cost.fxAllCny",
          )}
        </span>
      )}
      {/* 无汇率时也要能打开明细：说明缺哪些币种、几台、去哪里配置。 */}
      <FxDetailsPopover
        overview={overview}
        fx={fx}
        fxUpdatedAt={fxUpdatedAt}
        locale={locale}
      />
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
          <p
            data-cost-note="excluded"
            className="mt-auto border-t border-border pt-3 text-xs leading-normal text-muted-foreground"
          >
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
    <div className="flex min-h-[300px] flex-1 flex-col" data-cost-bar-chart>
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
  months,
  locale,
  className,
}: {
  /** 只来自成本 scope：离线 / 费用不完整 / 未知币种已被排除。 */
  servers: readonly RenewalSourceRow[];
  months: number[];
  locale: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [monthIndex, setMonthIndex] = useState(months[0] ?? 0);
  const [dialogDay, setDialogDay] = useState<RenewalDay | null>(null);
  const month: RenewalMonth = useMemo(
    () => buildRenewalMonth(servers, monthIndex),
    [servers, monthIndex],
  );
  const position = months.indexOf(monthIndex);
  const canPrev = position > 0;
  const canNext = position >= 0 && position < months.length - 1;
  const years = useMemo(
    () =>
      [...new Set(months.map((value) => Math.floor(value / 12)))].sort(
        (a, b) => a - b,
      ),
    [months],
  );

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

  const previousMonthDays = new Date(
    Date.UTC(month.year, month.month, 0),
  ).getUTCDate();
  const leading = Array.from(
    { length: month.firstWeekday },
    (_, index) => previousMonthDays - month.firstWeekday + index + 1,
  );
  const trailing = Array.from(
    {
      length: Math.max(
        0,
        42 - month.firstWeekday - month.daysInMonth,
      ),
    },
    (_, index) => index + 1,
  );
  const now = new Date();
  const today = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const isToday = (day: number) =>
    month.year === today.getUTCFullYear() &&
    month.month === today.getUTCMonth() &&
    day === today.getUTCDate();

  function edgeClass(index: number) {
    return cn(
      "border-border/60",
      index % 7 !== 6 && "border-r",
      index < 35 && "border-b",
    );
  }

  function changeMonth(next: number) {
    setMonthIndex(next);
    setDialogDay(null);
  }

  function chooseMonth(monthNumber: number) {
    const candidate = month.year * 12 + monthNumber - 1;
    if (months.includes(candidate)) changeMonth(candidate);
  }

  function chooseYear(year: number) {
    const sameMonth = months.find(
      (value) =>
        Math.floor(value / 12) === year && value % 12 === month.month,
    );
    const firstInYear = months.find(
      (value) => Math.floor(value / 12) === year,
    );
    const next = sameMonth ?? firstInYear;
    if (next !== undefined) changeMonth(next);
  }

  return (
    <>
      <Card
        className={cn(
          "flex h-full min-h-[330px] min-w-0 flex-col gap-0",
          className,
        )}
        data-cost-card="renewal"
      >
        <CardHeader className="border-b border-border pb-2">
          {/* 窄屏 / 英文长标题时允许换行：月份与年份选择器整体落到第二行，
              最后一个 › 不能被卡片的 overflow-hidden 裁掉。 */}
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
            <CardTitle className="shrink-0 text-sm font-medium">
              {t("overview.cost.renewalTitle")}
            </CardTitle>
            <div
              data-renewal-controls
              className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-0.5"
            >
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
              <Select
                value={String(month.month + 1)}
                onValueChange={(value) => chooseMonth(Number(value))}
              >
                <SelectTrigger
                  size="sm"
                  data-renewal-month-select
                  aria-label={t("overview.cost.renewalMonthSelect")}
                  className="h-7 w-[64px] px-1.5 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 12 }, (_, index) => index + 1).map(
                    (monthNumber) => (
                      <SelectItem
                        key={monthNumber}
                        value={String(monthNumber)}
                        data-renewal-month-option={monthNumber}
                        disabled={
                          !months.includes(
                            month.year * 12 + monthNumber - 1,
                          )
                        }
                      >
                        {formatMonthLabel(
                          month.year * 12 + monthNumber - 1,
                          locale,
                        )}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              <Select
                value={String(month.year)}
                onValueChange={(value) => chooseYear(Number(value))}
              >
                <SelectTrigger
                  size="sm"
                  data-renewal-year-select
                  aria-label={t("overview.cost.renewalYearSelect")}
                  className="h-7 w-[72px] px-1.5 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((year) => (
                    <SelectItem
                      key={year}
                      value={String(year)}
                      data-renewal-year-option={year}
                    >
                      {year}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
            <span data-renewal-month className="sr-only">
              {monthTitle}
            </span>
          </div>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col p-2">
          <div className="flex flex-1 flex-col">
            <div className="grid grid-cols-7 pb-1 text-center text-[9px] text-muted-foreground">
              {weekdays.map((weekday) => (
                <span key={weekday} data-renewal-weekday>
                  {weekday}
                </span>
              ))}
            </div>

            <div
              className="grid flex-1 auto-rows-fr grid-cols-7 overflow-hidden rounded-md border border-border/60"
              data-renewal-grid
            >
              {leading.map((day, index) => (
                <span
                  key={`prev-${day}`}
                  data-renewal-cell
                  data-renewal-adjacent
                  data-renewal-leading
                  className={cn(
                    "flex min-h-11 flex-col items-center justify-center bg-muted/20 p-1 text-center text-sm text-muted-foreground/50",
                    edgeClass(index),
                  )}
                >
                  {day}
                </span>
              ))}

              {month.days.map((day, dayIndex) => {
                const index = leading.length + dayIndex;
                if (day.events.length === 0) {
                  return (
                    <span
                      key={`current-${day.day}`}
                      data-renewal-cell
                      data-renewal-day-number={day.day}
                      data-renewal-today={isToday(day.day) || undefined}
                      className={cn(
                        "flex min-h-11 flex-col items-center justify-center p-1 text-center text-sm text-muted-foreground",
                        edgeClass(index),
                        isToday(day.day) &&
                          "shadow-[inset_0_0_0_1px_var(--primary)]",
                      )}
                    >
                      {day.day}
                    </span>
                  );
                }

                return (
                  <button
                    key={`current-${day.day}`}
                    type="button"
                    data-renewal-day
                    data-renewal-cell
                    data-renewal-day-number={day.day}
                    data-renewal-date={`${month.year}-${String(month.month + 1).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`}
                    data-renewal-count={day.count}
                    data-renewal-total={day.totalCnyCents}
                    data-renewal-today={isToday(day.day) || undefined}
                    aria-haspopup="dialog"
                    aria-label={t("overview.cost.renewalDayAria", {
                      date: `${month.month + 1}/${day.day}`,
                      n: day.count,
                      amount: day.events.some(
                        (event) => event.amountCnyCents !== null,
                      )
                        ? formatCny(day.totalCnyCents, locale)
                        : "—",
                    })}
                    onClick={() => setDialogDay(day)}
                    className={cn(
                      "flex min-h-11 flex-col items-center justify-center bg-primary/5 p-1 text-center text-sm transition-colors duration-150 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      edgeClass(index),
                      isToday(day.day) &&
                        "shadow-[inset_0_0_0_1px_var(--primary)]",
                    )}
                  >
                    <span className="text-sm leading-none text-muted-foreground">
                      {day.day}
                    </span>
                    <span
                      data-renewal-badge
                      className="mt-1 rounded-full bg-primary/10 px-1.5 text-[11px] leading-tight text-primary tabular-nums"
                    >
                      {t("overview.cost.renewalBadge", {
                        n: day.count,
                      })}
                    </span>
                    {day.unconverted > 0 ? (
                      <span
                        data-renewal-unconverted
                        className="mt-0.5 text-[10px] leading-none text-warning"
                        title={t("overview.cost.renewalUnconverted", {
                          n: day.unconverted,
                        })}
                      >
                        !
                      </span>
                    ) : null}
                  </button>
                );
              })}

              {trailing.map((day, trailingIndex) => {
                const index =
                  leading.length + month.daysInMonth + trailingIndex;
                return (
                  <span
                    key={`next-${day}`}
                    data-renewal-cell
                    data-renewal-adjacent
                    data-renewal-trailing
                    className={cn(
                      "flex min-h-11 flex-col items-center justify-center bg-muted/20 p-1 text-center text-sm text-muted-foreground/50",
                      edgeClass(index),
                    )}
                  >
                    {day}
                  </span>
                );
              })}
            </div>
          </div>

          <p
            data-renewal-summary
            data-cost-note="renewal"
            className="mt-2 border-t border-border pt-2 text-xs leading-normal text-muted-foreground"
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
          {month.days.some((day) => day.unconverted > 0) ? (
            <p
              data-renewal-unconverted-note
              data-cost-note="renewal-unconverted"
              className="mt-1 text-xs leading-normal text-muted-foreground"
            >
              {t("overview.cost.renewalUnconverted", {
                n: month.days.reduce(
                  (sum, day) => sum + day.unconverted,
                  0,
                ),
              })}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <RenewalDayDialog
        day={dialogDay}
        monthTitle={monthTitle}
        locale={locale}
        onClose={() => setDialogDay(null)}
      />
    </>
  );
}

function RenewalDayDialog({
  day,
  monthTitle,
  locale,
  onClose,
}: {
  day: RenewalDay | null;
  monthTitle: string;
  locale: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  if (!day) return null;
  const total = day.events.reduce(
    (sum, event) => sum + (event.amountCnyCents ?? 0),
    0,
  );
  const dialogDate =
    day.events[0] !== undefined
      ? formatRenewalDate(day.events[0], locale)
      : `${monthTitle} ${day.day}`;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        data-renewal-dialog
        className="max-h-[85vh] w-[calc(100%-1.5rem)] max-w-2xl overflow-y-auto p-0 sm:max-w-2xl"
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>
            {t("overview.cost.renewalDialogTitle", {
              date: dialogDate,
              n: day.count,
            })}
          </DialogTitle>
        </DialogHeader>

        <div className="min-w-0">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 bg-muted/40 px-4 py-1.5 text-[10px] text-muted-foreground">
            <span>{t("overview.cost.renewalDialogServer")}</span>
            <span className="text-right">
              {t("overview.cost.renewalDialogAmount")}
            </span>
          </div>
          <ul className="divide-y divide-border/60">
            {day.events.map((event) => (
              <li
                key={event.serverId}
                data-renewal-dialog-row
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p
                    className="truncate text-sm text-foreground"
                    title={event.name}
                  >
                    {event.name}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {cycleLabel(event, locale)}
                    {" · "}
                    {t("overview.cost.renewalDue", {
                      date: formatRenewalDate(event, locale),
                    })}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-xs tabular-nums text-foreground">
                    {event.amountOriginalCents === null ||
                    event.currency === null ? (
                      "—"
                    ) : (
                      <>
                        <span className="mr-1 text-[9px] text-muted-foreground">
                          {event.currency}
                        </span>
                        {formatCurrency(
                          event.amountOriginalCents,
                          event.currency,
                          locale,
                        )}
                      </>
                    )}
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {event.amountCnyCents === null
                      ? "—"
                      : formatCny(event.amountCnyCents, locale)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter className="flex-row items-center justify-between">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="text-muted-foreground">
              {t("overview.cost.renewalDialogTotal")}
            </span>
            <span
              data-renewal-dialog-total
              className="font-mono text-sm tabular-nums text-foreground"
            >
              {formatCny(total, locale)}
            </span>
            {day.unconverted > 0 ? (
              <span
                data-renewal-dialog-unconverted
                className="text-[10px] text-warning"
              >
                {t("overview.cost.renewalUnconverted", {
                  n: day.unconverted,
                })}
              </span>
            ) : null}
          </div>
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm">
              {t("common.close")}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatRenewalDate(event: RenewalEvent, locale: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event.paidUntil);
  if (!match) return event.paidUntil;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(
    new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    ),
  );
}

function cycleLabel(event: RenewalEvent, locale: string): string {
  void locale;
  if (event.cycleUnit === "once") return t("overview.cost.onceShort");
  if (event.cycleUnit === "month" && event.cycleCount !== null) {
    return t("overview.cost.renewalCycleMonths", {
      n: event.cycleCount,
    });
  }
  if (event.cycleUnit === "year" && event.cycleCount !== null) {
    return t("overview.cost.renewalCycleYears", {
      n: event.cycleCount,
    });
  }
  return "—";
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
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const max = rows[0]?.cycleCnyCents ?? 0;
  const topRows = rows.slice(0, 3);

  return (
    <>
      <Card
        className={cn("flex h-full flex-col gap-0", className)}
        data-cost-card="top"
      >
        <CardHeader className="border-b border-border pb-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">
              {t("overview.cost.topTitle")}
            </CardTitle>
            <div className="flex shrink-0 items-center gap-1">
              <Badge variant="outline" className="font-normal">
                Top 3
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                data-cost-top-view-all
                onClick={() => setOpen(true)}
              >
                {t("overview.cost.topViewAll")}
              </Button>
            </div>
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
          <CardContent className="flex flex-1 items-center p-2">
            <ul className="flex w-full flex-col gap-0.5">
              {topRows.map((row, index) => (
                <TopCostRowItem
                  key={row.serverId}
                  row={row}
                  index={index}
                  max={max}
                  locale={locale}
                />
              ))}
            </ul>
          </CardContent>
        )}
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-cost-top-dialog
          className="max-h-[80vh] w-[calc(100%-1.5rem)] max-w-lg overflow-y-auto p-0 sm:max-w-lg"
        >
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>
              {t("overview.cost.topAllTitle", { n: rows.length })}
            </DialogTitle>
          </DialogHeader>
          <ul className="divide-y divide-border/60">
            {rows.map((row, index) => (
              <li
                key={row.serverId}
                data-cost-top-dialog-row
                className="px-4 py-2.5"
              >
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="w-4 shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    title={row.name}
                  >
                    {row.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {row.share.toFixed(0)}%
                  </span>
                </div>
                <div className="mt-1 flex items-baseline gap-2 pl-6 font-mono text-[10px] tabular-nums">
                  <span className="text-muted-foreground">{row.currency}</span>
                  <span className="text-muted-foreground">
                    {formatCurrency(
                      row.cycleOriginalCents,
                      row.currency,
                      locale,
                    )}
                  </span>
                  <span className="ml-auto text-xs text-foreground">
                    {formatCny(row.cycleCnyCents, locale)}
                  </span>
                </div>
                <div className="mt-1 pl-6">
                  <span
                    aria-hidden="true"
                    className="block h-1 overflow-hidden rounded-full bg-muted"
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
                </div>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                {t("common.close")}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TopCostRowItem({
  row,
  index,
  max,
  locale,
}: {
  row: CostTopRow;
  index: number;
  max: number;
  locale: string;
}) {
  const { t } = useI18n();
  return (
    <li className="rounded-md px-2.5 py-1.5" data-cost-top-row>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="w-3 shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm" title={row.name}>
          {row.name}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {row.currency}
        </span>
        <span className="max-w-20 shrink-0 truncate font-mono text-[10px] text-muted-foreground tabular-nums">
          {formatCurrency(row.cycleOriginalCents, row.currency, locale)}
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
  );
}

function CurrencyMixCard({
  rows,
  totalCnyCents,
  source,
  updatedAt,
  locale,
  className,
}: {
  rows: CostCurrencyMixRow[];
  totalCnyCents: number;
  source: string | null;
  updatedAt: number | null;
  locale: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const pieRows = useMemo(
    () => buildCurrencyPieRows(rows, t("overview.cost.mixOther")),
    [rows, t],
  );
  const totalServers = rows.reduce((sum, row) => sum + row.count, 0);
  const sourceLabel =
    source?.trim().toLowerCase() === "manual"
      ? t("overview.cost.fxSourceManual")
      : t("overview.cost.fxSourceAuto");
  const summary =
    updatedAt === null
      ? t("overview.cost.mixSummary", {
          currencies: rows.length,
          servers: totalServers,
          source: sourceLabel,
        })
      : t("overview.cost.mixSummaryTime", {
          currencies: rows.length,
          servers: totalServers,
          source: sourceLabel,
          time: formatAbsoluteTime(updatedAt),
        });

  return (
    <Card
      className={cn("flex h-full flex-col gap-0", className)}
      data-cost-card="mix"
    >
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
        <CardContent className="relative flex flex-1 flex-col p-3">
          <div className="flex flex-1 items-center">
            <div className="grid w-full grid-cols-1 items-center gap-4 sm:grid-cols-[minmax(0,45fr)_minmax(0,55fr)]">
            <div
              className="relative mx-auto h-[280px] w-full max-w-[300px]"
              data-currency-pie
            >
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieRows}
                    dataKey="cnyCents"
                    nameKey="label"
                    innerRadius="60%"
                    outerRadius="92%"
                    paddingAngle={2}
                    stroke="none"
                    isAnimationActive={false}
                    onMouseEnter={(_, index) => setActiveIndex(index)}
                    onMouseLeave={() => setActiveIndex(null)}
                  >
                    {pieRows.map((row, index) => (
                      <Cell
                        key={row.key}
                        data-pie-sector={row.label}
                        fill="var(--primary)"
                        fillOpacity={
                          activeIndex === null || activeIndex === index
                            ? PIE_OPACITY[index % PIE_OPACITY.length]
                            : 0.18
                        }
                      />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 z-0 flex flex-col items-center justify-center text-center transition-opacity duration-150",
                  activeIndex !== null && "opacity-0",
                )}
              >
                <span className="text-[11px] text-muted-foreground">
                  {t("overview.cost.mixCenter")}
                </span>
                <span
                  data-pie-center-amount
                  className="font-mono text-lg tabular-nums text-foreground"
                >
                  {formatCny(totalCnyCents, locale)}
                </span>
              </div>
            </div>

                <ul className="min-w-0" data-pie-legend>
                  {pieRows.map((row, index) => (
                    <li
                      key={row.key}
                      data-pie-legend-row
                      data-pie-currency={row.label}
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseLeave={() => setActiveIndex(null)}
                      className={cn(
                        "flex items-center gap-2 rounded px-1 py-1 transition-colors duration-150",
                        activeIndex === index && "bg-muted/50",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-[2px] bg-primary"
                        style={{
                          opacity: PIE_OPACITY[index % PIE_OPACITY.length],
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span
                            data-pie-legend-code
                            className="min-w-0 truncate font-mono text-sm"
                          >
                            {row.label}
                            <span className="ml-1 text-[11px] text-muted-foreground">
                              {t("overview.cost.mixServersCount", {
                                n: row.count,
                              })}
                            </span>
                          </span>
                          <span
                            data-pie-legend-share
                            className="w-8 shrink-0 text-right text-[13px] text-muted-foreground tabular-nums"
                          >
                            {row.share.toFixed(0)}%
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
                          <span className="min-w-0 truncate font-mono tabular-nums">
                            {row.originalCents === null
                              ? "—"
                              : formatCurrency(
                                  row.originalCents,
                                  row.items[0]?.currency ?? "",
                                  locale,
                                )}
                          </span>
                          <span
                            data-pie-legend-amount
                            className="shrink-0 font-mono text-[13px] text-foreground tabular-nums"
                          >
                            {formatCny(row.cnyCents, locale)}
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p
              data-mix-summary
              data-cost-note="mix"
              className="mt-2 border-t border-border pt-2 text-xs leading-normal text-muted-foreground"
            >
              {summary}
            </p>
            {activeIndex !== null && pieRows[activeIndex] ? (
              <div className="pointer-events-none absolute right-3 top-3 z-30 w-52 max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto">
                <CurrencyPieDetail row={pieRows[activeIndex]} />
              </div>
            ) : null}
          </CardContent>
      )}
    </Card>
  );
}

function buildCurrencyPieRows(
  rows: CostCurrencyMixRow[],
  otherLabel: string,
): CurrencyPieRow[] {
  const mapped: CurrencyPieRow[] = rows.map((row) => ({
    key: row.currency,
    label: row.currency,
    originalCents: row.cycleOriginalCents,
    cnyCents: row.cycleCnyCents,
    share: row.share,
    count: row.count,
    items: [row],
    isOther: false,
  }));
  if (mapped.length <= 5) return mapped;

  const head = mapped.slice(0, 4);
  const rest = mapped.slice(4);
  return [
    ...head,
    {
      key: "__other__",
      label: otherLabel,
      originalCents: null,
      cnyCents: rest.reduce((sum, row) => sum + row.cnyCents, 0),
      share: rest.reduce((sum, row) => sum + row.share, 0),
      count: rest.reduce((sum, row) => sum + row.count, 0),
      items: rest.flatMap((row) => row.items),
      isOther: true,
    },
  ];
}

function CurrencyPieDetail({ row }: { row: CurrencyPieRow }) {
  const { locale } = useI18n();

  return (
    <div
      data-pie-tooltip
      className="w-52 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg/40"
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5">
        <span className="font-medium">{row.label}</span>
        <span className="font-mono tabular-nums">
          {row.share.toFixed(0)}%
        </span>
      </div>
      {row.isOther ? (
        <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto">
          {row.items.map((item) => (
            <li
              key={item.currency}
              data-pie-tooltip-item
              className="flex items-center justify-between gap-3"
            >
              <span className="font-mono text-muted-foreground">
                {item.currency}
              </span>
              <span className="font-mono tabular-nums">
                {formatCny(item.cycleCnyCents, locale)}
              </span>
              <span className="w-7 text-right text-muted-foreground tabular-nums">
                {item.share.toFixed(0)}%
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 font-mono tabular-nums">
          {formatCny(row.cnyCents, locale)}
        </p>
      )}
    </div>
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
          >
            {t("overview.cost.oneTimeBadge")}
          </Badge>
        </div>
      </CardHeader>
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={CircleDollarSignIcon}
          title={t("overview.cost.oneTimeEmpty")}
          className="py-8"
        />
      ) : (
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
      )}
      <p
        data-cost-note="once"
        className="px-4 pb-3 text-xs leading-normal text-muted-foreground"
      >
        {t("overview.cost.oneTimeHint")}
      </p>
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
