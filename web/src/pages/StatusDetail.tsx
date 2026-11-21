import type { ComponentProps, ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  CloudOffIcon,
  EyeOffIcon,
  FolderIcon,
  GlobeIcon,
  RefreshCwIcon,
  ServerOffIcon,
  ShieldIcon,
} from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/common";
import { AVAILABILITY_TEXT_CLASS } from "@/components/status/Availability";
import { AvailabilityCurve } from "@/components/status/AvailabilityCurve";
import { AvailabilityDays } from "@/components/status/AvailabilityDays";
import { RateTrend } from "@/components/status/RateTrend";
import { StatusChip } from "@/components/status/ServerCard";
import { StatusHeader } from "@/components/status/StatusHeader";
import { StatusDetailSkeleton } from "@/components/status/StatusDetailSkeleton";
import { PAGE_CONTAINER } from "@/components/status/StatusSkeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useDocumentTitle, useI18n } from "@/i18n";
import type { PublicStatusServer } from "@/lib/api";
import {
  countryCodeToFlag,
  countryDisplayName,
  normalizeCountryCode,
} from "@/lib/country";
import { isNotFound } from "@/lib/errors";
import { formatBytePair, formatBytes } from "@/lib/format";
import { compactRatePair, formatRatePairText } from "@/lib/netRate";
import {
  availabilityPercentText,
  availabilityTone,
  expiryLabel,
  hasSamples,
  inboundCount,
  latencyTrend,
  outageMinutesParts,
  publicBilling,
  reportedLatency,
  resourcePercent,
  serverState,
  serviceAgeLabel,
  summarizeAvailability,
  uptimeLabelKey,
  uptimeParts,
  type OutageMinutesParts,
} from "@/lib/publicStatus";
import { billingHidden } from "@/lib/publicStatusSettings";
import { normalizeGroupName } from "@/lib/serverGroups";
import {
  formatAbsoluteTime,
  formatClockTime,
  formatHourRange,
  formatRelativeTime,
} from "@/lib/time";
import { usePublicStatus, usePublicStatusDetail } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * 公开状态页的服务器详情 `/status/:id` · 四张卡（方案 1「指标栅格」）。
 *
 * ① 状态与趋势：头部 + 三个单行 KPI（速率改成 ↓/↑ 紧凑式，单位进 label）
 *    + 112px 可用率曲线（y 轴 100/50/0）+ 当前速率下的 20px 24h 迷你趋势。
 * ② 可用性明细：2×3 指标栅格（任何宽度都显示全部 6 格）+ 底部 2 条明细
 *    + 近 7 天日条（`buckets_7d`，null 日斜线）。
 * ③ 运行环境：82px 资源环（390 为 70px 且与用量并排）+ 系统信息 + Xray
 *    + 入站数量 / 延迟趋势。
 * ④ 费用与流量：58/42 分栏，去掉嵌套盒；390 堆叠且保留全部数值。
 *
 * 数据来自 `GET /api/v1/public/status/:id`（单机详情，含 24h 序列）；
 * 旧后端没有该接口时回落到列表 `GET /api/v1/public/status`，此时若列表
 * 也不再返回 `series_24h`，迷你趋势整体隐藏而不是报错。新增字段全部可选，
 * 缺失时按 `—` 或整项隐藏处理（见各字段旁的注释）。
 */

/** 主数字 28px（390 22px）；②/④ 的次要数字 16–18px；标签与单位 12px。 */
const KPI_VALUE_CLASS = "tnum text-[22px] leading-none font-semibold sm:text-[28px]";
const METRIC_VALUE_CLASS = "tnum text-[20px] leading-none font-semibold sm:text-[22px]";
const SECONDARY_VALUE_CLASS = "tnum text-base leading-none font-semibold sm:text-[18px]";
const UNIT_CLASS = "text-xs font-normal text-muted-foreground";
const CARD_CLASS =
  "h-full min-w-0 gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5";

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-xs font-medium tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

function Dash({ className = KPI_VALUE_CLASS }: { className?: string }) {
  return (
    <span className={cn("tnum font-semibold text-muted-foreground", className)}>
      —
    </span>
  );
}

function Unit({ children }: { children: ReactNode }) {
  return <span className={UNIT_CLASS}>{children}</span>;
}

function OverviewHeader({
  server,
  generatedAt,
}: {
  server: PublicStatusServer;
  generatedAt: number;
}) {
  const { t, locale } = useI18n();
  const state = serverState(server);
  const uptime = (() => {
    if (state === "offline") return null;
    const parts = uptimeParts(server.uptime_secs);
    return parts ? t(uptimeLabelKey(parts), parts) : null;
  })();
  const group = normalizeGroupName(server.group_name);
  const country = normalizeCountryCode(server.country_code);
  const countryName = country
    ? (countryDisplayName(country, locale) ?? country)
    : null;
  const flag = countryCodeToFlag(server.country_code);
  const countryTitle = country
    ? t("publicStatus.server.countryTitle", {
        name: countryName ?? country,
        code: country,
      })
    : t("publicStatus.server.countryUnset");
  // 服务年龄来自 first_seen_at（不是会因重启归零的 uptime_secs）；旧后端缺失
  // 时整项隐藏。generated_at 是服务端时间，避免浏览器时钟造成「已运行 46 天」。
  const age = serviceAgeLabel(server.first_seen_at, generatedAt * 1_000);

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="min-w-0 text-lg leading-tight font-semibold tracking-tight break-words sm:text-xl">
            {server.name}
          </h1>
          <span
            role="img"
            aria-label={countryTitle}
            title={countryTitle}
            className="shrink-0"
          >
            {flag ? (
              <span
                aria-hidden="true"
                className="text-sm leading-none select-none"
              >
                {flag}
              </span>
            ) : (
              <GlobeIcon
                aria-hidden="true"
                className="icon-sm text-muted-foreground"
              />
            )}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {countryName ? <span>{countryName}</span> : null}
          {group ? (
            <span
              className="inline-flex min-w-0 items-center gap-1"
              title={t("publicStatus.detail.groupTitle", { name: group })}
            >
              <FolderIcon className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{group}</span>
            </span>
          ) : null}
          {age ? (
            <span className="tnum">{t(age.key, age.values)}</span>
          ) : null}
        </div>
      </div>
      <StatusChip state={state} uptime={uptime} />
    </div>
  );
}

function Kpi({
  name,
  label,
  unit,
  footer,
  children,
}: {
  name: string;
  label: string;
  /** 单位放进 label（方案 1 的速率不再把单位写在数字后面）。 */
  unit?: string | null;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="detail-kpi"
      data-kpi={name}
      className="min-w-0 border-l border-border px-2.5 first:border-l-0 first:pl-0 last:pr-0 sm:px-3"
    >
      <div className="tnum flex min-w-0 items-baseline gap-1 text-xs whitespace-nowrap text-muted-foreground">
        <span className="truncate">{label}</span>
        {unit ? <span className={cn(UNIT_CLASS, "shrink-0")}>{unit}</span> : null}
      </div>
      <div className="mt-1.5 flex min-w-0 items-baseline gap-1 whitespace-nowrap">
        {children}
      </div>
      {footer}
    </div>
  );
}

function KeyNumbers({ server }: { server: PublicStatusServer }) {
  const { t } = useI18n();
  const latency = reportedLatency(server.latency_ms);
  const buckets = Array.isArray(server.buckets_24h) ? server.buckets_24h : [];
  const uptime = hasSamples(buckets)
    ? availabilityPercentText(server.uptime_24h)
    : null;
  const tone = availabilityTone(uptime === null ? null : server.uptime_24h);
  const rate = compactRatePair(server.net_rx_bps, server.net_tx_bps);
  const rateTitle = formatRatePairText(server.net_rx_bps, server.net_tx_bps);

  return (
    <div
      data-slot="detail-key-numbers"
      className="mt-2.5 grid grid-cols-[minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.2fr)] border-t border-border pt-2.5"
    >
      <Kpi name="latency" label={t("publicStatus.detail.latency")}>
        {latency === null ? (
          <Dash />
        ) : (
          <span className="tnum inline-flex items-baseline gap-1">
            <span className={KPI_VALUE_CLASS}>{latency}</span>
            <Unit>ms</Unit>
          </span>
        )}
      </Kpi>

      <Kpi name="uptime" label={t("publicStatus.hero.averageUptime")}>
        {uptime === null ? (
          <Dash />
        ) : (
          <span
            className={cn("tnum inline-flex items-baseline gap-1", AVAILABILITY_TEXT_CLASS[tone])}
          >
            <span className={KPI_VALUE_CLASS}>{uptime}</span>
            <Unit>%</Unit>
          </span>
        )}
      </Kpi>

      <Kpi
        name="rate"
        label={t("publicStatus.detail.rate")}
        unit={rate?.unit ?? null}
        footer={
          <RateTrend
            series={server.series_24h}
            className="mt-1 max-w-full"
          />
        }
      >
        {rate === null ? (
          <Dash />
        ) : (
          <span
            data-slot="detail-rate"
            title={rateTitle ?? undefined}
            className="tnum inline-flex min-w-0 items-baseline gap-1 text-base leading-none font-semibold sm:text-[18px]"
          >
            <span className="inline-flex items-baseline gap-0.5">
              <ArrowDownIcon
                className="size-3 shrink-0 self-center text-muted-foreground"
                aria-hidden="true"
              />
              <span className="sr-only">
                {t("publicStatus.server.trafficRx")}
              </span>
              {rate.rx ?? "—"}
            </span>
            <span aria-hidden="true" className="text-muted-foreground/60">
              ·
            </span>
            <span className="inline-flex items-baseline gap-0.5">
              <ArrowUpIcon
                className="size-3 shrink-0 self-center text-muted-foreground"
                aria-hidden="true"
              />
              <span className="sr-only">
                {t("publicStatus.server.trafficTx")}
              </span>
              {rate.tx ?? "—"}
            </span>
          </span>
        )}
      </Kpi>
    </div>
  );
}

function OverviewCard({
  server,
  generatedAt,
  className,
}: {
  server: PublicStatusServer;
  generatedAt: number;
  className?: string;
}) {
  return (
    <Card
      data-slot="detail-overview"
      className={cn(CARD_CLASS, "flex flex-col", className)}
    >
      <OverviewHeader server={server} generatedAt={generatedAt} />
      <KeyNumbers server={server} />
      <div
        data-slot="detail-chart"
        className="mt-2.5 border-t border-border pt-2.5"
      >
        <AvailabilityCurve server={server} generatedAt={generatedAt} />
      </div>
    </Card>
  );
}

function DurationValue({ parts }: { parts: OutageMinutesParts }) {
  const { t } = useI18n();
  return (
    <span className="tnum inline-flex min-w-0 flex-wrap items-baseline gap-x-1">
      {parts.hours > 0 ? (
        <span className="inline-flex items-baseline gap-0.5">
          <span className={METRIC_VALUE_CLASS}>{parts.hours}</span>
          <Unit>{t("publicStatus.detail.outageDurationHour")}</Unit>
        </span>
      ) : null}
      {parts.hours === 0 || parts.minutes > 0 ? (
        <span className="inline-flex items-baseline gap-0.5">
          <span className={METRIC_VALUE_CLASS}>{parts.minutes}</span>
          <Unit>{t("publicStatus.detail.outageDurationMinute")}</Unit>
        </span>
      ) : null}
    </span>
  );
}

function Metric({
  name,
  label,
  tone,
  sub,
  className,
  children,
}: {
  name: string;
  label: string;
  tone?: "ok" | "warn" | "down" | "unknown";
  sub?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="detail-metric"
      data-metric={name}
      className={cn(
        "flex min-w-0 flex-col justify-center py-3",
        className,
      )}
    >
      <div className="tnum truncate text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-0.5",
          tone ? AVAILABILITY_TEXT_CLASS[tone] : undefined,
        )}
      >
        {children}
      </div>
      {sub ? (
        <div className="tnum mt-0.5 truncate text-[10px] leading-tight font-normal text-muted-foreground">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function AvailabilityDetailsCard({
  server,
  className,
}: {
  server: PublicStatusServer;
  className?: string;
}) {
  const { t } = useI18n();
  const buckets = Array.isArray(server.buckets_24h) ? server.buckets_24h : [];
  const summary = summarizeAvailability(buckets);
  const hasData = summary.sampled > 0;
  const has24h = hasData && Number.isFinite(server.uptime_24h);
  const uptime24 = has24h
    ? availabilityPercentText(server.uptime_24h)
    : null;
  const uptime7d = availabilityPercentText(server.uptime_7d);
  const tone24 = availabilityTone(has24h ? server.uptime_24h : null);
  const tone7d = availabilityTone(server.uptime_7d);
  const delta =
    has24h && uptime7d !== null && Number.isFinite(server.uptime_7d)
      ? (Number(server.uptime_24h) - Number(server.uptime_7d)) * 100
      : null;
  const deltaText =
    delta === null
      ? "—"
      : `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${Math.abs(delta).toFixed(1)} pp`;
  const range = (hour: { ts: number } | null) =>
    hour ? formatHourRange(hour.ts) : "—";
  const percent = (hour: { ratio: number } | null) =>
    hour ? `${availabilityPercentText(hour.ratio)}%` : "—";

  // 精确中断分钟优先。undefined = 旧后端（回落到按小时近似）；null = 后端
  // 明确说没有数据，显示 —，绝不显示「0 分钟」。
  const exactOutage =
    server.outage_minutes_24h === undefined
      ? null
      : outageMinutesParts(server.outage_minutes_24h);
  const exactOutageMissing =
    server.outage_minutes_24h === null ||
    (server.outage_minutes_24h !== undefined && exactOutage === null);
  const fallbackOutageHours =
    server.outage_minutes_24h === undefined
      ? (summary.outageHours ?? null)
      : null;

  const outageCount =
    summary.outageCount === null ? null : summary.outageCount;
  const coverage =
    summary.coverageRatio === null
      ? "—"
      : t("publicStatus.detail.coverageValue", {
          sampled: summary.sampled,
          total: summary.total,
        });
  const longestNormal =
    summary.longestNormalHours === null
      ? "—"
      : t("publicStatus.detail.outageDurationValue", {
          hours: summary.longestNormalHours,
        });
  const timeOnly = (ts: number) => formatHourRange(ts).slice(0, 5);
  const outageTimes =
    summary.outagePeriods === null
      ? "—"
      : summary.outagePeriods.length === 0
        ? t("publicStatus.detail.noOutage")
        : summary.outagePeriods
            .slice(0, 2)
            .map((period) => `${timeOnly(period.startTs)}–${timeOnly(period.endTs)}`)
            .join(" · ");

  return (
    <Card
      data-slot="detail-availability"
      className={cn(CARD_CLASS, "flex flex-col", className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>{t("publicStatus.detail.availabilityDetails")}</SectionTitle>
        <span className="text-[11px] text-muted-foreground">
          {hasData ? null : t("publicStatus.detail.noSample")}
        </span>
      </div>

      <div
        data-slot="detail-metric-grid"
        className="mt-2.5 grid grid-cols-2 border-t border-border"
      >
        <Metric
          name="outages"
          label={t("publicStatus.detail.outageCount")}
          className="border-r border-border pr-3"
        >
          {outageCount === null ? (
            <Dash className={METRIC_VALUE_CLASS} />
          ) : (
            <span className="tnum inline-flex items-baseline gap-0.5">
              <span className={METRIC_VALUE_CLASS}>{outageCount}</span>
              <Unit>
                {outageCount === 1
                  ? t("publicStatus.detail.outageUnitOne")
                  : t("publicStatus.detail.outageUnitMany")}
              </Unit>
            </span>
          )}
        </Metric>

        <Metric
          name="duration"
          label={t("publicStatus.detail.outageDuration")}
          sub={
            fallbackOutageHours === null
              ? undefined
              : t("publicStatus.detail.outageDurationHint")
          }
          className="border-b border-border pl-3"
        >
          {exactOutage !== null ? (
            <DurationValue parts={exactOutage} />
          ) : exactOutageMissing ? (
            <Dash className={METRIC_VALUE_CLASS} />
          ) : fallbackOutageHours === null ? (
            <Dash className={METRIC_VALUE_CLASS} />
          ) : (
            <span className="tnum inline-flex items-baseline gap-0.5">
              <span className={METRIC_VALUE_CLASS}>{fallbackOutageHours}</span>
              <Unit>{t("publicStatus.detail.outageDurationHour")}</Unit>
            </span>
          )}
        </Metric>

        <Metric
          name="coverage"
          label={t("publicStatus.detail.coverage")}
          className="border-r border-b border-border pr-3"
        >
          <span className={METRIC_VALUE_CLASS}>{coverage}</span>
        </Metric>

        <Metric
          name="lowest"
          label={t("publicStatus.detail.lowestHour")}
          tone={summary.lowest ? availabilityTone(summary.lowest.ratio) : "unknown"}
          sub={summary.lowest ? range(summary.lowest) : "—"}
          className="border-b border-border pl-3"
        >
          <span className={METRIC_VALUE_CLASS}>
            {summary.lowest ? percent(summary.lowest) : "—"}
          </span>
        </Metric>

        <Metric
          name="highest"
          label={t("publicStatus.detail.highestHour")}
          tone={summary.highest ? availabilityTone(summary.highest.ratio) : "unknown"}
          sub={summary.highest ? range(summary.highest) : "—"}
          className="border-r border-border pr-3"
        >
          <span className={METRIC_VALUE_CLASS}>
            {summary.highest ? percent(summary.highest) : "—"}
          </span>
        </Metric>

        <Metric
          name="compare"
          label={t("publicStatus.detail.compare")}
          sub={
            <>
              {t("publicStatus.detail.difference")}{" "}
              <span className="tnum">{deltaText}</span>
            </>
          }
          className="pl-3"
        >
          <span className={SECONDARY_VALUE_CLASS}>
            <span className={AVAILABILITY_TEXT_CLASS[tone24]}>
              {uptime24 === null ? "—" : `${uptime24}%`}
            </span>
            <span aria-hidden="true" className="px-1.5 text-muted-foreground/50">
              ·
            </span>
            <span className={AVAILABILITY_TEXT_CLASS[tone7d]}>
              {uptime7d === null ? "—" : `${uptime7d}%`}
            </span>
          </span>
        </Metric>
      </div>

      <div
        data-slot="detail-availability-foot"
        className="mt-2.5 border-t border-border pt-2.5"
      >
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t("publicStatus.detail.longestNormal")}{" "}
            <b className="tnum font-medium text-foreground">{longestNormal}</b>
          </span>
          <span>
            {t("publicStatus.detail.outagePeriods")}{" "}
            <b className="tnum font-medium text-foreground">{outageTimes}</b>
          </span>
        </div>
        <AvailabilityDays
          buckets={server.buckets_7d}
          className="mt-2"
        />
      </div>
    </Card>
  );
}

function Ring({
  name,
  label,
  percent,
  pair,
}: {
  name: string;
  label: string;
  percent: number | null;
  pair: string | null;
}) {
  const { t } = useI18n();
  const size = 82;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fill = percent === null ? 0 : Math.min(100, Math.max(0, percent));

  return (
    <div
      data-slot="detail-ring"
      data-ring={name}
      className="flex min-w-0 flex-1 items-center gap-2 sm:flex-col sm:justify-center sm:gap-1.5"
    >
      <div
        role="img"
        aria-label={`${label} ${percent === null ? "—" : `${Math.round(percent)}%`}`}
        className="relative size-[70px] shrink-0 sm:size-[82px]"
      >
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${size} ${size}`}
          className="size-full -rotate-90"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--muted)"
            strokeWidth={stroke}
          />
          {percent !== null && fill > 0 ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${(fill / 100) * circumference} ${circumference}`}
            />
          ) : null}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
          <strong className="tnum text-sm leading-none font-semibold sm:text-base">
            {percent === null ? "—" : `${Math.round(percent)}%`}
          </strong>
          <span className="text-[10px] text-muted-foreground">{label}</span>
        </div>
      </div>
      <span className="tnum min-w-0 text-[10px] leading-tight text-muted-foreground sm:max-w-full sm:truncate">
        {pair ?? t("publicStatus.server.notReported")}
      </span>
    </div>
  );
}

function RuntimeCard({
  server,
  className,
}: {
  server: PublicStatusServer;
  className?: string;
}) {
  const { t } = useI18n();
  const load =
    server.load1 !== null && Number.isFinite(server.load1)
      ? server.load1
      : null;
  const memPercent = resourcePercent(server.mem_used, server.mem_total);
  const diskPercent = resourcePercent(server.disk_used, server.disk_total);
  const memPair = formatBytePair(server.mem_used, server.mem_total);
  const diskPair = formatBytePair(server.disk_used, server.disk_total);
  const os = [server.os_name, server.os_version]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  const inbounds = inboundCount(server.inbound_count);
  const latency = latencyTrend(server.series_24h);
  const latencyText =
    latency === null
      ? null
      : latency.min === latency.max
        ? t("publicStatus.detail.latencyTrendSingle", { value: latency.min })
        : t("publicStatus.detail.latencyTrendRange", {
            min: latency.min,
            max: latency.max,
          });
  const xray =
    server.xray_running === true
      ? {
          key: "running",
          text: t("publicStatus.server.xrayRunning"),
          className: "bg-primary",
          textClass: "text-foreground",
        }
      : server.xray_running === false
        ? {
            key: "not-running",
            text: t("publicStatus.detail.xrayNotRunning"),
            className: "bg-warning",
            textClass: "text-warning",
          }
        : {
            key: "unknown",
            text: t("publicStatus.detail.xrayUnknown"),
            className: "bg-muted-foreground",
            textClass: "text-muted-foreground",
          };

  return (
    <Card
      data-slot="detail-runtime"
      className={cn(CARD_CLASS, "flex flex-col", className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>{t("publicStatus.detail.runtime")}</SectionTitle>
        <span className="inline-flex items-baseline gap-1 text-xs text-muted-foreground">
          {t("publicStatus.server.load")}
          <strong className="tnum text-sm font-semibold text-foreground">
            {load === null ? "—" : load.toFixed(2)}
          </strong>
          <span className="text-[10px]">
            {load === null
              ? t("publicStatus.server.notReported")
              : t("publicStatus.server.loadHint")}
          </span>
        </span>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 sm:flex-row sm:gap-4">
        <div
          data-slot="detail-rings"
          className="flex min-w-0 gap-2 sm:basis-[56%] sm:flex-none"
        >
          <Ring
            name="memory"
            label={t("publicStatus.server.memory")}
            percent={memPercent}
            pair={memPair}
          />
          <Ring
            name="disk"
            label={t("publicStatus.server.disk")}
            percent={diskPercent}
            pair={diskPair}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center border-t border-border pt-2 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-4">
          <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-1.5 sm:flex sm:flex-col sm:gap-1.5">
            {[
              { label: t("publicStatus.detail.system.os"), value: os || "—" },
              { label: t("publicStatus.detail.system.virt"), value: server.virt || "—" },
              { label: t("publicStatus.detail.system.arch"), value: server.arch || "—" },
            ].map((row, index) => (
              <div
                key={row.label}
                className={cn("min-w-0", index === 0 && "col-span-2 sm:col-auto")}
              >
                <dt className="text-[10px] leading-tight text-muted-foreground">
                  {row.label}
                </dt>
                <dd
                  className="tnum truncate text-xs leading-tight"
                  title={row.value}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div
        data-slot="runtime-foot"
        className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 text-xs"
      >
        <span
          data-slot="xray-status"
          data-xray={xray.key}
          className="inline-flex items-center gap-1.5"
        >
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", xray.className)}
          />
          <span className={xray.textClass}>{xray.text}</span>
        </span>
        {inbounds === null ? null : (
          <span className="text-[10px] text-muted-foreground">
            {inbounds === 1
              ? t("publicStatus.detail.inboundCountOne", { count: inbounds })
              : t("publicStatus.detail.inboundCountMany", {
                  count: inbounds,
                })}
          </span>
        )}
        {latencyText === null ? null : (
          <span className="inline-flex items-baseline gap-1 text-[10px] text-muted-foreground">
            <span>{t("publicStatus.detail.latencyTrend")}</span>
            <span className="tnum text-foreground">{latencyText}</span>
          </span>
        )}
      </div>
    </Card>
  );
}

function BillingTrafficCard({
  server,
  className,
}: {
  server: PublicStatusServer;
  className?: string;
}) {
  const { t } = useI18n();
  const billing = publicBilling(server);
  const hiddenBilling = billingHidden(server);
  const hasBilling =
    hiddenBilling ||
    billing.paidUntil !== null ||
    billing.price !== null ||
    billing.cycleKey !== null;
  const expiry =
    billing.days === null ? null : expiryLabel(billing.days);
  const expiryText =
    expiry === null ? null : t(expiry.key, expiry.values);
  const cycle = billing.cycleKey === null ? null : t(billing.cycleKey);
  const expired = billing.days !== null && billing.days < 0;

  const rx =
    typeof server.net_rx_bytes === "number" &&
    Number.isFinite(server.net_rx_bytes) &&
    server.net_rx_bytes >= 0
      ? server.net_rx_bytes
      : null;
  const tx =
    typeof server.net_tx_bytes === "number" &&
    Number.isFinite(server.net_tx_bytes) &&
    server.net_tx_bytes >= 0
      ? server.net_tx_bytes
      : null;
  const total = rx !== null && tx !== null ? rx + tx : (rx ?? tx);
  const totalText = total === null ? "—" : formatBytes(total);
  const rxText = rx === null ? "—" : formatBytes(rx);
  const txText = tx === null ? "—" : formatBytes(tx);
  const rxShare =
    rx !== null && tx !== null && rx + tx > 0
      ? Math.min(100, Math.max(0, (rx / (rx + tx)) * 100))
      : null;

  const cycleDays =
    billing.cycleKey === "publicStatus.server.cycle.monthly"
      ? 30
      : billing.cycleKey === "publicStatus.server.cycle.yearly"
        ? 365
        : null;
  const remainingDays =
    billing.days === null || cycleDays === null
      ? null
      : Math.max(0, Math.min(cycleDays, billing.days));
  const remainingPercent =
    remainingDays === null || cycleDays === null
      ? null
      : (remainingDays / cycleDays) * 100;
  const cycleEstimate =
    cycleDays === 30
      ? t("publicStatus.detail.estimatedMonthly")
      : cycleDays === 365
        ? t("publicStatus.detail.estimatedYearly")
        : null;

  const uptimeHours =
    typeof server.uptime_secs === "number" &&
    Number.isFinite(server.uptime_secs) &&
    server.uptime_secs > 0
      ? server.uptime_secs / 3_600
      : null;
  const avgRx =
    rx !== null && uptimeHours !== null ? rx / uptimeHours : null;
  const avgTx =
    tx !== null && uptimeHours !== null ? tx / uptimeHours : null;
  const avgRxText = avgRx === null ? "—" : formatBytes(avgRx);
  const avgTxText = avgTx === null ? "—" : formatBytes(avgTx);

  return (
    <Card
      data-slot="detail-billing"
      className={cn(CARD_CLASS, "flex flex-col", className)}
    >
      <SectionTitle>{t("publicStatus.detail.billingTraffic")}</SectionTitle>

      <div
        className={cn(
          "mt-3 flex flex-1 flex-col gap-3",
          hasBilling && "sm:flex-row sm:gap-5",
        )}
      >
        {hasBilling ? (
          <section
            data-slot="billing-primary"
            className="flex min-w-0 flex-col justify-center gap-1.5 sm:basis-[58%] sm:flex-none"
          >
            <div className="text-[11px] text-muted-foreground">
              {t("publicStatus.detail.sections.billing")}
            </div>
            {hiddenBilling ? (
              <p className="flex min-w-0 items-center gap-1.5 text-base leading-tight font-semibold text-muted-foreground">
                <EyeOffIcon className="size-4 shrink-0" aria-hidden="true" />
                {t("publicStatus.server.notPublic")}
              </p>
            ) : (
              <>
                <div className="flex min-w-0 items-baseline gap-1">
                  {billing.price === null ? (
                    <Dash className="text-[22px] leading-none font-semibold sm:text-2xl" />
                  ) : (
                    <span className="tnum text-[22px] leading-none font-semibold sm:text-2xl">
                      {billing.price}
                    </span>
                  )}
                  {cycle === null ? null : (
                    <span className={cn(UNIT_CLASS, "shrink-0")}>/ {cycle}</span>
                  )}
                </div>
                {expiryText === null ? null : (
                  <p
                    className={cn(
                      "tnum flex min-w-0 flex-wrap items-baseline gap-x-2 text-base leading-tight font-semibold sm:text-[17px]",
                      expired ? "text-warning" : "text-foreground",
                    )}
                    title={billing.paidUntil ?? undefined}
                  >
                    <span>{expiryText}</span>
                    {billing.paidUntil === null ? null : (
                      <span className="text-[11px] font-normal text-muted-foreground">
                        {billing.paidUntil}
                      </span>
                    )}
                  </p>
                )}
                {remainingDays !== null && remainingPercent !== null ? (
                  <div className="mt-0.5">
                    <div
                      aria-hidden="true"
                      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                    >
                      <div
                        className={cn(
                          "h-full rounded-full",
                          expired ? "bg-warning" : "bg-primary",
                        )}
                        style={{ width: `${remainingPercent}%` }}
                      />
                    </div>
                    <div
                      data-slot="billing-meta"
                      className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground"
                    >
                      <span className="tnum">
                        {t("publicStatus.detail.remainingDays", {
                          remaining: remainingDays,
                          total: cycleDays ?? 0,
                        })}
                      </span>
                      {cycleEstimate === null ? null : <span>{cycleEstimate}</span>}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </section>
        ) : null}

        <section
          data-slot="detail-traffic"
          className={cn(
            "flex min-w-0 flex-1 flex-col justify-center gap-1.5",
            hasBilling &&
              "border-t border-border pt-3 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-5",
          )}
        >
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
            <span className="text-[11px] text-muted-foreground">
              {t("publicStatus.server.trafficTotal")}{" "}
              <span className="text-muted-foreground/70">
                · {t("publicStatus.detail.sinceBoot")}
              </span>
            </span>
            <strong className="tnum text-lg leading-none font-semibold sm:text-xl">
              {totalText}
            </strong>
          </div>

          <div
            aria-hidden="true"
            className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            {rxShare === null ? null : (
              <>
                <span
                  className="h-full bg-primary"
                  style={{ width: `${rxShare}%` }}
                />
                <span
                  className="h-full bg-muted-foreground/40"
                  style={{ width: `${100 - rxShare}%` }}
                />
              </>
            )}
          </div>

          <div className="tnum flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <ArrowDownToLineIcon className="size-3" aria-hidden="true" />
              {rxText}
            </span>
            <span className="inline-flex items-center gap-1">
              <ArrowUpToLineIcon className="size-3" aria-hidden="true" />
              {txText}
            </span>
          </div>

          {avgRx === null && avgTx === null ? null : (
            <div
              data-slot="traffic-average"
              className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"
            >
              <span>{t("publicStatus.detail.averageHourly")}</span>
              <span className="tnum">
                ↓ {avgRxText}/h · ↑ {avgTxText}/h
              </span>
            </div>
          )}
        </section>
      </div>
    </Card>
  );
}

function Footer({ server }: { server: PublicStatusServer }) {
  const { t } = useI18n();
  const lastSeen = server.last_seen;
  const hasLastSeen =
    typeof lastSeen === "number" && Number.isFinite(lastSeen) && lastSeen > 0;
  const relative = hasLastSeen
    ? formatRelativeTime(lastSeen)
    : t("publicStatus.server.neverSeen");
  const absolute = hasLastSeen ? formatAbsoluteTime(lastSeen) : undefined;

  return (
    <div
      data-slot="detail-footer"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground"
    >
      <span className="tnum" title={absolute}>
        {t("publicStatus.detail.lastReported", { time: relative })}
      </span>
      <span aria-hidden="true" className="hidden h-3 w-px bg-border sm:block" />
      <span>{t("publicStatus.detail.refreshHint")}</span>
    </div>
  );
}

function DetailContent({
  server,
  generatedAt,
}: {
  server: PublicStatusServer;
  generatedAt: number;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <div
        data-slot="detail-grid"
        className="grid items-stretch gap-4 lg:grid-cols-[420px_minmax(0,1fr)]"
      >
        <OverviewCard
          server={server}
          generatedAt={generatedAt}
          className="order-1 lg:col-start-1 lg:row-start-1"
        />
        <AvailabilityDetailsCard
          server={server}
          className="order-2 lg:col-start-2 lg:row-start-1"
        />
        <RuntimeCard
          server={server}
          className="order-3 lg:col-start-1 lg:row-start-2"
        />
        <BillingTrafficCard
          server={server}
          className="order-4 lg:col-start-2 lg:row-start-2"
        />
      </div>
      <div className="mt-4">
        <Footer server={server} />
      </div>
    </div>
  );
}

function StatePanel({
  children,
  ...props
}: ComponentProps<typeof Card>) {
  return (
    <Card className="mx-auto w-full max-w-4xl rounded-xl py-0" {...props}>
      {children}
    </Card>
  );
}

export default function StatusDetailPage({ id }: { id: string }) {
  const { t } = useI18n();
  const status = usePublicStatus();
  // 详情接口与列表并行请求：列表负责页头 / 404 判定与兜底，详情负责
  // `series_24h`（新后端已从列表里移除逐机序列）。旧后端没有该接口时
  // 一直 404，页面照常用列表数据渲染，不进入错误态。
  const detail = usePublicStatusDetail(id);
  const disabled = status.isError && isNotFound(status.error);
  const listServer =
    status.data?.servers.find((item) => item.id === id) ?? null;
  const detailData = detail.data?.server?.id === id ? detail.data : undefined;
  const server = detailData
    ? {
        ...detailData.server,
        // 详情接口的顶层序列优先；列表兜底时沿用旧后端仍可能带上的字段。
        series_24h:
          detailData.series_24h ?? detailData.server.series_24h ?? null,
      }
    : listServer;
  const panelName =
    status.data?.panel_name?.trim() || t("publicStatus.headingFallback");

  useDocumentTitle(
    `${server?.name ?? t("publicStatus.detail.titleFallback")} · ${panelName}`,
  );

  const lastSuccessAt =
    status.isError && !disabled && status.dataUpdatedAt > 0
      ? formatClockTime(status.dataUpdatedAt / 1_000)
      : null;

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <StatusHeader
        data={status.data}
        isError={status.isError}
        disabled={disabled}
      />

      <main className={cn(PAGE_CONTAINER, "flex flex-1 flex-col py-4")}>
        {disabled ? (
          <div className="flex flex-1 items-center justify-center">
            <StatePanel role="status" aria-live="polite">
              <EmptyState
                icon={ShieldIcon}
                title={t("publicStatus.disabled.title")}
                description={t("publicStatus.disabled.description")}
              />
            </StatePanel>
          </div>
        ) : status.isError ? (
          <div className="flex flex-1 items-center justify-center">
            <StatePanel role="alert" aria-live="assertive">
              <EmptyState
                icon={CloudOffIcon}
                title={t("publicStatus.error.title")}
                description={
                  lastSuccessAt
                    ? t("publicStatus.error.lastSuccess", {
                        time: lastSuccessAt,
                      })
                    : t("publicStatus.error.description")
                }
                action={
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button
                      variant="outline"
                      className="h-10"
                      onClick={() => void status.refetch()}
                      disabled={status.isFetching}
                    >
                      <RefreshCwIcon
                        className={cn(
                          "icon-sm",
                          status.isFetching && "animate-spin",
                        )}
                        aria-hidden="true"
                      />
                      {t("publicStatus.error.retry")}
                    </Button>
                    <Button variant="ghost" asChild className="h-10">
                      <Link to="/status">{t("publicStatus.detail.back")}</Link>
                    </Button>
                  </div>
                }
              />
            </StatePanel>
          </div>
        ) : status.data === undefined ? (
          <StatusDetailSkeleton label={t("publicStatus.loading")} />
        ) : server === null ? (
          <div className="flex flex-1 items-center justify-center">
            <StatePanel role="status" aria-live="polite">
              <EmptyState
                icon={ServerOffIcon}
                title={t("publicStatus.detail.notFoundTitle")}
                action={
                  <Button variant="outline" asChild className="h-10">
                    <Link to="/status">{t("publicStatus.detail.back")}</Link>
                  </Button>
                }
              />
            </StatePanel>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center">
              <Button
                variant="ghost"
                asChild
                className="-ml-2 h-10 shrink-0 px-2"
              >
                <Link to="/status" data-slot="detail-back">
                  <ArrowLeftIcon className="icon-sm" aria-hidden="true" />
                  {t("publicStatus.detail.back")}
                </Link>
              </Button>
            </div>
            <DetailContent
              server={server}
              generatedAt={status.data.generated_at}
            />
          </>
        )}
      </main>
    </div>
  );
}
