import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
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
import { InsightMetrics } from "./InsightMetrics";
import { errorText } from "@/lib/errors";
import {
  buildCostOverview,
  formatCny,
  formatCnyCompact,
  formatCurrency,
  formatFxRate,
  formatMonthIndex,
  formatMonthLabel,
  parseFxRates,
  parseFxUpdatedAt,
  type CostCalendarCell,
  type CostCalendarGroup,
  type CostCurrencyMixRow,
  type CostOneTimeRow,
  type CostOverview,
  type CostTopRow,
  type FxRates,
} from "@/lib/costOverview";
import { useServers, useSettings } from "@/lib/queries";
import { formatAbsoluteTime } from "@/lib/time";
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

export default function CostView() {
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
  const overview = useMemo(
    () =>
      buildCostOverview(serversQuery.data ?? [], fx.rates),
    [serversQuery.data, fx.rates],
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
  const next12Hint =
    overview.prepaidSavingsCents > 0
      ? t("overview.cost.next12Less", {
          amount: formatCny(overview.prepaidSavingsCents, locale),
        })
      : t("overview.cost.next12Hint");

  return (
    <div className="space-y-4" data-cost-view>
      <InsightMetrics
        items={[
          {
            label: t("overview.cost.monthly"),
            value: formatCny(overview.monthlyCnyCents, locale),
            hint: t(
              overview.periodicCount === 1
                ? "overview.cost.monthlyHintOne"
                : "overview.cost.monthlyHint",
              { n: overview.periodicCount },
            ),
          },
          {
            label: t("overview.cost.annualized"),
            value: formatCny(overview.annualizedCnyCents, locale),
            hint: t("overview.cost.annualizedHint"),
          },
          {
            label: t("overview.cost.next12"),
            value: formatCny(overview.next12CnyCents, locale),
            hint: next12Hint,
          },
        ]}
      />

      <FxNote
        fx={fx}
        fxUpdatedAt={fxUpdatedAt}
        locale={locale}
        settingsError={settingsError}
        settingsFetching={settingsFetching}
        onRetry={onRetrySettings}
      />

      {overview.unknownCurrency.length > 0 ? (
        <UnknownCurrencyWarning rows={overview.unknownCurrency} />
      ) : null}

      <section className="grid gap-4 xl:grid-cols-3">
        <PaymentCalendarCard
          overview={overview}
          locale={locale}
          className="xl:col-span-2"
        />
        <div className="grid gap-4">
          <TopCostCard rows={overview.top} locale={locale} />
          <CurrencyMixCard rows={overview.currencyMix} locale={locale} />
        </div>
      </section>

      {overview.oneTime.length > 0 ? (
        <OneTimeCard rows={overview.oneTime} locale={locale} />
      ) : null}
    </div>
  );
}

function FxNote({
  fx,
  fxUpdatedAt,
  locale,
  settingsError,
  settingsFetching,
  onRetry,
}: {
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

  const rates = Object.entries(fx.rates)
    .filter(([currency]) => currency !== "CNY")
    .sort(([a], [b]) => a.localeCompare(b));
  const rateText = rates
    .map(([currency, rate]) => `${currency} ${formatFxRate(rate, locale)}`)
    .join(" / ");
  const updatedText =
    fxUpdatedAt === null
      ? null
      : t("overview.cost.fxUpdated", {
          time: formatAbsoluteTime(fxUpdatedAt),
        });

  return (
    <p className="text-xs leading-normal text-muted-foreground">
      {t(
        fx.source?.toLowerCase() === "manual"
          ? "overview.cost.fxNoteManual"
          : "overview.cost.fxNote",
      )}
      {rateText === ""
        ? null
        : t(
            updatedText === null
              ? "overview.cost.fxRatesInlineNoTime"
              : "overview.cost.fxRatesInline",
            { rates: rateText, updated: updatedText ?? "" },
          )}
    </p>
  );
}

function UnknownCurrencyWarning({
  rows,
}: {
  rows: CostOverview["unknownCurrency"];
}) {
  const codes = [...new Set(rows.map((row) => row.currency))].join(" · ");
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <p className="min-w-0">
        {t(
          rows.length === 1
            ? "overview.cost.unknownCurrenciesOne"
            : "overview.cost.unknownCurrencies",
          { n: rows.length, codes },
        )}
      </p>
    </div>
  );
}

/** 金额越高颜色越深；只用 primary 的透明度阶梯，亮 / 暗都保持文字可读。 */
function calendarCellClass(amount: number, max: number): string {
  if (amount <= 0) return "";
  const ratio = max > 0 ? amount / max : 0;
  if (ratio >= 0.75) return "bg-primary/55";
  if (ratio >= 0.5) return "bg-primary/40";
  if (ratio >= 0.25) return "bg-primary/25";
  return "bg-primary/15";
}

function CalendarCell({
  name,
  monthIndex,
  cell,
  max,
  locale,
}: {
  name: string;
  monthIndex: number;
  cell: CostCalendarCell;
  max: number;
  locale: string;
}) {
  const month = formatMonthIndex(monthIndex);
  if (cell.prepaid) {
    return (
      <span
        title={t("overview.cost.cellPrepaid", { name, month })}
        aria-label={t("overview.cost.cellPrepaidHint")}
        className="calendar-prepaid h-8 rounded-[4px] border border-dashed border-muted-foreground/50"
      />
    );
  }
  if (cell.amountCnyCents <= 0) {
    return (
      <span
        title={t("overview.cost.cellEmpty", { name, month })}
        className="flex h-8 items-center justify-center rounded-[4px] border border-border/40 text-[9px] text-muted-foreground"
      />
    );
  }
  return (
    <span
      data-cost-cell
      title={t("overview.cost.cellTitle", {
        name,
        month,
        amount: formatCny(cell.amountCnyCents, locale),
      })}
      className={cn(
        "flex h-8 items-center justify-center rounded-[4px] px-0.5 font-mono text-[10px] tabular-nums",
        calendarCellClass(cell.amountCnyCents, max),
      )}
    >
      {formatCnyCompact(cell.amountCnyCents, locale)}
    </span>
  );
}

function CalendarLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-primary/15" />
        {t("overview.cost.calendarLegendLow")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-primary/55" />
        {t("overview.cost.calendarLegendHigh")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="calendar-prepaid size-2.5 rounded-[2px] border border-dashed border-muted-foreground/50"
        />
        {t("overview.cost.calendarLegendPrepaid")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-2.5 rounded-[2px] border border-border/40"
        />
        {t("overview.cost.calendarLegendEmpty")}
      </span>
    </div>
  );
}

function PaymentCalendarCard({
  overview,
  locale,
  className,
}: {
  overview: CostOverview;
  locale: string;
  className?: string;
}) {
  const max = overview.calendarRows.reduce(
    (current, row) =>
      row.cells.reduce(
        (rowMax, cell) => Math.max(rowMax, cell.amountCnyCents),
        current,
      ),
    0,
  );
  const gridStyle = {
    gridTemplateColumns: `minmax(120px, 1.2fr) repeat(12, minmax(44px, 1fr))`,
  };

  return (
    <Card className={cn("flex flex-col gap-0", className)}>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.cost.calendarTitle")}
          </CardTitle>
          <CalendarLegend />
        </div>
      </CardHeader>

      {overview.calendarGroups.length === 0 ? (
        <EmptyState
          size="sm"
          icon={WalletIcon}
          title={t("overview.cost.calendarEmpty")}
          description={t("overview.cost.calendarEmptyDesc")}
          className="py-10"
        />
      ) : (
        <div
          className="overflow-x-auto"
          data-cost-calendar
          aria-label={t("overview.cost.calendarAria")}
        >
          <div className="min-w-[680px] p-4 xl:min-w-0">
            <div className="grid items-center gap-1" style={gridStyle}>
              <span aria-hidden="true" />
              {overview.months.map((monthIndex) => (
                <span
                  key={monthIndex}
                  className="truncate text-center text-[10px] text-muted-foreground"
                  title={formatMonthIndex(monthIndex)}
                >
                  {formatMonthLabel(monthIndex, locale)}
                </span>
              ))}
            </div>
            {overview.calendarGroups.map((group) => (
              <CalendarGroup
                key={group.currency}
                group={group}
                max={max}
                locale={locale}
                gridStyle={gridStyle}
              />
            ))}
          </div>
        </div>
      )}

      <p className="px-4 pt-1 pb-4 text-[10px] leading-normal text-muted-foreground xl:hidden">
        {t("overview.cost.calendarScroll")}
      </p>
      {overview.incomplete.length > 0 ? (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          {t(
            overview.incomplete.length === 1
              ? "overview.cost.incompleteOne"
              : "overview.cost.incomplete",
            { n: overview.incomplete.length },
          )}
        </p>
      ) : null}
    </Card>
  );
}

function CalendarGroup({
  group,
  max,
  locale,
  gridStyle,
}: {
  group: CostCalendarGroup;
  max: number;
  locale: string;
  gridStyle: { gridTemplateColumns: string };
}) {
  const { t } = useI18n();
  return (
    <div>
      <div className="mt-3 mb-1 grid items-center gap-1" style={gridStyle}>
        <span className="truncate text-[10px] text-muted-foreground">
          {t(
            group.count === 1
              ? "overview.cost.groupTitleOne"
              : "overview.cost.groupTitle",
            {
              currency: group.currency,
              n: group.count,
              amount: formatCny(group.monthlyCnyCents, locale),
            },
          )}
        </span>
      </div>
      {group.rows.map((row) => (
        <div
          key={row.serverId}
          className="grid items-center gap-1"
          style={gridStyle}
        >
          <div className="min-w-0 truncate text-xs" title={row.name}>
            {row.name}
          </div>
          {row.cells.map((cell) => (
            <CalendarCell
              key={`${row.serverId}-${cell.monthIndex}`}
              name={row.name}
              monthIndex={cell.monthIndex}
              cell={cell}
              max={max}
              locale={locale}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function TopCostCard({
  rows,
  locale,
}: {
  rows: CostTopRow[];
  locale: string;
}) {
  const max = rows[0]?.monthlyCnyCents ?? 0;

  return (
    <Card className="flex flex-col gap-0">
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
                    {formatCny(row.monthlyCnyCents, locale)}
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
                            ? `${Math.round((row.monthlyCnyCents / max) * 100)}%`
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
}: {
  rows: CostCurrencyMixRow[];
  locale: string;
}) {
  return (
    <Card className="flex flex-col gap-0">
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
                    row.monthlyOriginalCents,
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
                        row.monthlyOriginalCents,
                        row.currency,
                        locale,
                      )}
                </span>
                <span className="shrink-0 font-mono tabular-nums">
                  {formatCny(row.monthlyCnyCents, locale)}
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
}: {
  rows: CostOneTimeRow[];
  locale: string;
}) {
  return (
    <Card className="flex flex-col gap-0">
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
                    {row.amountCnyCents === null
                      ? t("overview.cost.oneTimeNoRate")
                      : formatCny(row.amountCnyCents, locale)}
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
