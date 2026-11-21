import type { ComponentProps, ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  CloudOffIcon,
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
import { rateParts } from "@/lib/netRate";
import {
  availabilityPercentText,
  availabilityTone,
  expiryLabel,
  hasSamples,
  publicBilling,
  reportedLatency,
  resourcePercent,
  serverState,
  summarizeAvailability,
  uptimeLabelKey,
  uptimeParts,
} from "@/lib/publicStatus";
import { normalizeGroupName } from "@/lib/serverGroups";
import {
  formatAbsoluteTime,
  formatClockTime,
  formatHourRange,
  formatRelativeTime,
} from "@/lib/time";
import { usePublicStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * 公开状态页的服务器详情 `/status/:id` · 四张卡。
 *
 * ① 状态与趋势（头部 + 三个数字 + 24h 曲线）
 * ② 可用性明细（前端由 buckets_24h 推导）
 * ③ 运行环境（资源环 + 负载 + 系统 + Xray）
 * ④ 费用与流量（有费用才显示费用块）
 *
 * 仍然只用 `GET /api/v1/public/status` 的现有字段，没有新接口；桌面
 * 420px + 右栏的 2×2 网格，同一行卡片 stretch 等高。
 */

const VALUE_CLASS = "text-[19px] leading-none font-semibold sm:text-[28px]";
const CARD_CLASS =
  "h-full min-w-0 gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5";

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-xs font-medium tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

function DetailStat({
  name,
  label,
  children,
}: {
  name: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0" data-slot="detail-stat" data-stat={name}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-2 flex min-h-7 flex-wrap items-baseline gap-1">
        {children}
      </div>
    </div>
  );
}

function Dash() {
  return (
    <span className={cn(VALUE_CLASS, "text-muted-foreground")}>—</span>
  );
}

function Unit({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-normal text-muted-foreground">
      {children}
    </span>
  );
}

function OverviewHeader({ server }: { server: PublicStatusServer }) {
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
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
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
        </div>
      </div>
      <StatusChip state={state} uptime={uptime} />
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
  const rx = rateParts(server.net_rx_bps);
  const tx = rateParts(server.net_tx_bps);

  return (
    <div
      data-slot="detail-key-numbers"
      className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-3"
    >
      <DetailStat name="latency" label={t("publicStatus.detail.latency")}>
        {latency === null ? (
          <Dash />
        ) : (
          <span className={cn("tnum inline-flex items-baseline gap-1", VALUE_CLASS)}>
            {latency}
            <Unit>ms</Unit>
          </span>
        )}
      </DetailStat>

      <DetailStat name="uptime" label={t("publicStatus.hero.averageUptime")}>
        {uptime === null ? (
          <Dash />
        ) : (
          <span
            className={cn(
              "tnum inline-flex items-baseline gap-1",
              VALUE_CLASS,
              AVAILABILITY_TEXT_CLASS[tone],
            )}
          >
            {uptime}
            <Unit>%</Unit>
          </span>
        )}
      </DetailStat>

      <DetailStat name="rate" label={t("publicStatus.detail.rate")}>
        {rx === null && tx === null ? (
          <Dash />
        ) : (
          <div className="flex min-w-0 flex-col gap-0.5">
            {[
              { icon: ArrowDownIcon, parts: rx, label: t("publicStatus.server.trafficRx") },
              { icon: ArrowUpIcon, parts: tx, label: t("publicStatus.server.trafficTx") },
            ].map(({ icon: Icon, parts, label }) => (
              <span key={label} className="inline-flex min-w-0 items-baseline gap-1">
                <Icon
                  className="size-3 shrink-0 self-center text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="sr-only">{label}</span>
                {parts === null ? (
                  <Dash />
                ) : (
                  <span
                    className={cn(
                      "tnum inline-flex items-baseline gap-1 whitespace-nowrap",
                      VALUE_CLASS,
                    )}
                  >
                    {parts.value}
                    <Unit>{parts.unit}</Unit>
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </DetailStat>
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
      <OverviewHeader server={server} />
      <KeyNumbers server={server} />
      <div
        data-slot="detail-chart"
        className="mt-4 flex min-h-0 flex-1 flex-col border-t border-border pt-3"
      >
        <AvailabilityCurve server={server} generatedAt={generatedAt} />
      </div>
    </Card>
  );
}

function DetailRow({
  detail,
  label,
  value,
  sub,
  optional,
  tone,
}: {
  detail: string;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  optional?: boolean;
  tone?: "ok" | "warn" | "down" | "unknown";
}) {
  return (
    <div
      data-slot="availability-detail"
      data-detail={detail}
      className={cn(
        "flex min-w-0 items-baseline justify-between gap-4 border-b border-border/60 py-1 last:border-b-0 lg:py-3",
        optional && "hidden lg:flex",
      )}
    >
      <dt className="shrink-0 text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "tnum min-w-0 text-right text-base leading-tight font-semibold",
          tone ? AVAILABILITY_TEXT_CLASS[tone] : "text-foreground",
        )}
      >
        <div className="break-words">{value}</div>
        {sub ? (
          <div className="mt-0.5 text-[10px] leading-tight font-normal text-muted-foreground">
            {sub}
          </div>
        ) : null}
      </dd>
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

  const outageCount =
    summary.outageCount === null
      ? "—"
      : summary.outageCount === 1
        ? t("publicStatus.detail.outageCountOne")
        : t("publicStatus.detail.outageCountMany", {
            count: summary.outageCount,
          });
  const outageDuration =
    summary.outageHours === null
      ? "—"
      : t("publicStatus.detail.outageDurationValue", {
          hours: summary.outageHours,
        });
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
        <span className="text-xs text-muted-foreground">
          {hasData ? null : t("publicStatus.detail.noSample")}
        </span>
      </div>

      <dl className="mt-3 flex flex-1 flex-col justify-between">
        <DetailRow
          detail="outages"
          label={t("publicStatus.detail.outageCount")}
          value={outageCount}
        />
        <DetailRow
          detail="duration"
          label={t("publicStatus.detail.outageDuration")}
          value={outageDuration}
          sub={
            summary.outageHours === null
              ? undefined
              : t("publicStatus.detail.outageDurationHint")
          }
        />
        <DetailRow
          detail="coverage"
          label={t("publicStatus.detail.coverage")}
          value={coverage}
        />
        <DetailRow
          detail="lowest"
          label={t("publicStatus.detail.lowestHour")}
          value={
            <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5">
              <span>{range(summary.lowest)}</span>
              {summary.lowest ? (
                <span className="text-sm font-normal">
                  {percent(summary.lowest)}
                </span>
              ) : null}
            </span>
          }
          tone={summary.lowest ? availabilityTone(summary.lowest.ratio) : "unknown"}
        />
        <DetailRow
          detail="highest"
          label={t("publicStatus.detail.highestHour")}
          value={
            <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5">
              <span>{range(summary.highest)}</span>
              {summary.highest ? (
                <span className="text-sm font-normal">
                  {percent(summary.highest)}
                </span>
              ) : null}
            </span>
          }
          tone={summary.highest ? availabilityTone(summary.highest.ratio) : "unknown"}
        />
        <DetailRow
          detail="compare"
          label={t("publicStatus.detail.compare")}
          value={
            <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5">
              <span className="inline-flex items-baseline gap-1">
                <span className="text-[10px] font-normal text-muted-foreground">
                  {t("publicStatus.detail.compare24h")}
                </span>
                <span className={AVAILABILITY_TEXT_CLASS[tone24]}>
                  {uptime24 === null ? "—" : `${uptime24}%`}
                </span>
              </span>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="inline-flex items-baseline gap-1">
                <span className="text-[10px] font-normal text-muted-foreground">
                  {t("publicStatus.detail.compare7d")}
                </span>
                <span className={AVAILABILITY_TEXT_CLASS[tone7d]}>
                  {uptime7d === null ? "—" : `${uptime7d}%`}
                </span>
              </span>
            </span>
          }
          sub={`${t("publicStatus.detail.difference")} ${deltaText}`}
        />
        <DetailRow
          detail="longest"
          label={t("publicStatus.detail.longestNormal")}
          value={longestNormal}
          optional
        />
        <DetailRow
          detail="periods"
          label={t("publicStatus.detail.outagePeriods")}
          value={outageTimes}
          optional
        />
      </dl>
    </Card>
  );
}

function Ring({
  label,
  percent,
  pair,
}: {
  label: string;
  percent: number | null;
  pair: string | null;
}) {
  const { t } = useI18n();
  const size = 92;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fill = percent === null ? 0 : Math.min(100, Math.max(0, percent));

  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5 rounded-lg bg-muted/20 p-2">
      <div
        role="img"
        aria-label={`${label} ${percent === null ? "—" : `${Math.round(percent)}%`}`}
        className="relative size-24"
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
          <strong className="tnum text-lg leading-none font-semibold">
            {percent === null ? "—" : `${Math.round(percent)}%`}
          </strong>
          <span className="text-[10px] text-muted-foreground">{label}</span>
        </div>
      </div>
      <span className="tnum max-w-full truncate text-[10px] text-muted-foreground">
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

      <div className="mt-2 grid grid-cols-2 gap-3">
        <Ring
          label={t("publicStatus.server.memory")}
          percent={memPercent}
          pair={memPair}
        />
        <Ring
          label={t("publicStatus.server.disk")}
          percent={diskPercent}
          pair={diskPair}
        />
      </div>

      <dl className="mt-2 flex flex-1 flex-col justify-center gap-2 border-t border-border pt-2 text-xs">
        {[
          { label: t("publicStatus.detail.system.os"), value: os || "—" },
          { label: t("publicStatus.detail.system.virt"), value: server.virt || "—" },
          { label: t("publicStatus.detail.system.arch"), value: server.arch || "—" },
        ].map((row) => (
          <div
            key={row.label}
            className="flex min-w-0 items-baseline justify-between gap-3"
          >
            <dt className="shrink-0 text-[10px] text-muted-foreground">
              {row.label}
            </dt>
            <dd className="min-w-0 truncate text-right text-sm" title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      <div
        data-slot="xray-status"
        data-xray={xray.key}
        className="mt-auto flex items-center gap-2 border-t border-border pt-2 text-xs"
      >
        <span
          aria-hidden="true"
          className={cn("size-1.5 rounded-full", xray.className)}
        />
        <span className={xray.textClass}>{xray.text}</span>
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
  const hasBilling =
    billing.paidUntil !== null ||
    billing.price !== null ||
    billing.cycleKey !== null;
  const expiry =
    billing.days === null ? null : expiryLabel(billing.days);
  const expiryText =
    expiry === null ? null : t(expiry.key, expiry.values);
  const cycle = billing.cycleKey === null ? null : t(billing.cycleKey);
  const price =
    billing.price === null
      ? null
      : `${billing.price}${cycle ? ` / ${cycle}` : ""}`;

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
          "mt-3 flex flex-1 flex-col gap-4",
          hasBilling &&
            "lg:grid lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-6",
        )}
      >
        {hasBilling ? (
          <section className="flex min-w-0 flex-col justify-center lg:justify-between lg:rounded-lg lg:border lg:border-border/60 lg:bg-muted/15 lg:p-4">
            <SectionTitle>{t("publicStatus.detail.sections.billing")}</SectionTitle>
            {price ? (
              <p className="tnum mt-2 text-xl leading-tight font-semibold">
                {price}
              </p>
            ) : null}
            {expiryText ? (
              <p
                className={cn(
                  "mt-1 text-xs",
                  billing.days !== null && billing.days < 0
                    ? "text-warning"
                    : "text-muted-foreground",
                )}
                title={billing.paidUntil ?? undefined}
              >
                {expiryText}
                {billing.paidUntil ? (
                  <span className="tnum ml-2">{billing.paidUntil}</span>
                ) : null}
              </p>
            ) : null}
            {remainingDays !== null && remainingPercent !== null ? (
              <div className="mt-3 hidden lg:block">
                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>
                    {t("publicStatus.detail.remainingDays", {
                      remaining: remainingDays,
                      total: cycleDays ?? 0,
                    })}
                  </span>
                  <span>{cycleEstimate}</span>
                </div>
                <div
                  aria-hidden="true"
                  className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className={cn(
                      "h-full rounded-full",
                      billing.days !== null && billing.days < 0
                        ? "bg-warning"
                        : "bg-primary",
                    )}
                    style={{ width: `${remainingPercent}%` }}
                  />
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        <section
          data-slot="detail-traffic"
          className="flex min-w-0 flex-1 flex-col justify-center lg:justify-between lg:rounded-lg lg:border lg:border-border/60 lg:bg-muted/15 lg:p-4"
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-xs text-muted-foreground">
              {t("publicStatus.server.trafficTotal")}
            </span>
            <span className="text-[10px] text-muted-foreground">
              · {t("publicStatus.detail.sinceBoot")}
            </span>
            <strong className="tnum ml-auto text-lg font-semibold lg:ml-0">
              {totalText}
            </strong>
          </div>

          <div
            aria-hidden="true"
            className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
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

          <div className="tnum mt-2 flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <ArrowDownToLineIcon className="size-3" aria-hidden="true" />
              {rxText}
            </span>
            <span className="inline-flex items-center gap-1">
              <ArrowUpToLineIcon className="size-3" aria-hidden="true" />
              {txText}
            </span>
          </div>

          {avgRx !== null || avgTx !== null ? (
            <div className="mt-2 hidden items-center justify-between gap-3 text-[10px] text-muted-foreground lg:flex">
              <span>{t("publicStatus.detail.averageHourly")}</span>
              <span className="tnum">
                ↓ {avgRxText}/h · ↑ {avgTxText}/h
              </span>
            </div>
          ) : null}
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
        className="grid flex-1 items-stretch gap-4 lg:grid-cols-[420px_minmax(0,1fr)]"
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
  const disabled = status.isError && isNotFound(status.error);
  const server = status.data?.servers.find((item) => item.id === id) ?? null;
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
