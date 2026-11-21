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
  uptimeLabelKey,
  uptimeParts,
  type PublicBilling,
} from "@/lib/publicStatus";
import { normalizeGroupName } from "@/lib/serverGroups";
import {
  formatAbsoluteTime,
  formatClockTime,
  formatRelativeTime,
} from "@/lib/time";
import { usePublicStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * 公开状态页的服务器详情 `/status/:id` · 方案 B 仪表盘。
 *
 * 数据完全来自列表页同一份 `GET /api/v1/public/status`（20 秒轮询），没有
 * 新接口，也不展示地址、节点、用户或流量明细。桌面两栏 420px + 右栏；
 * 缺失小时的可用率曲线画 hatch，不用高度假装 100%。
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

function StatusCard({
  server,
  className,
}: {
  server: PublicStatusServer;
  className?: string;
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

  return (
    <Card data-slot="detail-header" className={cn(CARD_CLASS, "flex flex-col", className)}>
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

      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
        <span>
          {server.xray_running === true
            ? t("publicStatus.server.xrayRunning")
            : server.xray_running === false
              ? t("publicStatus.server.xrayStopped")
              : "—"}
        </span>
      </div>
    </Card>
  );
}

function KeyNumbers({
  server,
  className,
}: {
  server: PublicStatusServer;
  className?: string;
}) {
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
    <Card
      data-slot="detail-key-numbers"
      className={cn(CARD_CLASS, "flex flex-col justify-center", className)}
    >
      <div className="grid grid-cols-3 gap-3">
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
    </Card>
  );
}

function Ring({
  label,
  percent,
  pair,
  className,
}: {
  label: string;
  percent: number | null;
  pair: string | null;
  className?: string;
}) {
  const { t } = useI18n();
  const size = 112;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fill = percent === null ? 0 : Math.min(100, Math.max(0, percent));

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-center gap-2 rounded-lg bg-muted/20 p-2",
        className,
      )}
    >
      <div
        role="img"
        aria-label={`${label} ${percent === null ? "—" : `${Math.round(percent)}%`}`}
        className="relative size-24 sm:size-28"
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
          <strong className="tnum text-xl leading-none font-semibold">
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

function Resources({
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

  return (
    <Card
      data-slot="detail-resources"
      className={cn(CARD_CLASS, "flex flex-col", className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>{t("publicStatus.detail.sections.resources")}</SectionTitle>
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
      <div className="grid flex-1 grid-cols-2 content-center gap-3 pt-4">
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
    </Card>
  );
}

function Billing({
  billing,
  className,
}: {
  billing: PublicBilling;
  className?: string;
}) {
  const { t } = useI18n();
  const expiry =
    billing.days === null
      ? null
      : expiryLabel(billing.days);
  const expiryText =
    expiry === null ? null : t(expiry.key, expiry.values);
  const cycle = billing.cycleKey === null ? null : t(billing.cycleKey);
  const price =
    billing.price === null ? null : `${billing.price}${cycle ? ` / ${cycle}` : ""}`;

  return (
    <Card data-slot="detail-billing" className={cn(CARD_CLASS, "flex flex-col", className)}>
      <SectionTitle>{t("publicStatus.detail.sections.billing")}</SectionTitle>
      <div className="flex flex-1 flex-col justify-center gap-1 pt-3">
        {price ? (
          <p className="tnum text-xl leading-tight font-semibold">{price}</p>
        ) : null}
        {expiryText ? (
          <p
            className={cn(
              "text-xs",
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
      </div>
    </Card>
  );
}

function SystemInfo({
  server,
  className,
}: {
  server: PublicStatusServer;
  className?: string;
}) {
  const { t } = useI18n();
  const os = [server.os_name, server.os_version]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  const rows = [
    { label: t("publicStatus.detail.system.os"), value: os || "—" },
    { label: t("publicStatus.detail.system.virt"), value: server.virt || "—" },
    { label: t("publicStatus.detail.system.arch"), value: server.arch || "—" },
  ];

  return (
    <Card data-slot="detail-system" className={cn(CARD_CLASS, "flex flex-col", className)}>
      <SectionTitle>{t("publicStatus.detail.sections.system")}</SectionTitle>
      <dl className="flex flex-1 flex-col justify-between gap-3 pt-3">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex min-w-0 items-baseline justify-between gap-3"
          >
            <dt className="shrink-0 text-[10px] text-muted-foreground">
              {row.label}
            </dt>
            <dd
              className="min-w-0 truncate text-right text-sm"
              title={row.value}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function TrafficBand({
  server,
  className,
}: {
  server: PublicStatusServer;
  className?: string;
}) {
  const { t } = useI18n();
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

  return (
    <Card
      data-slot="detail-traffic"
      className={cn(CARD_CLASS, "grid gap-3 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center", className)}
    >
      <div className="flex min-w-0 items-baseline gap-2">
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
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        {rxShare === null ? null : (
          <>
            <span className="h-full bg-primary" style={{ width: `${rxShare}%` }} />
            <span className="h-full bg-muted-foreground/40" style={{ width: `${100 - rxShare}%` }} />
          </>
        )}
      </div>

      <div className="tnum flex items-center justify-between gap-4 text-xs text-muted-foreground lg:justify-end">
        <span className="inline-flex items-center gap-1">
          <ArrowDownToLineIcon className="size-3" aria-hidden="true" />
          {rxText}
        </span>
        <span className="inline-flex items-center gap-1">
          <ArrowUpToLineIcon className="size-3" aria-hidden="true" />
          {txText}
        </span>
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
  const billing = publicBilling(server);
  const hasBilling =
    billing.paidUntil !== null ||
    billing.price !== null ||
    billing.cycleKey !== null;

  return (
    <div className="flex flex-1 flex-col">
      <div
        data-slot="detail-grid"
        className="grid flex-1 items-stretch gap-4 lg:grid-cols-[420px_minmax(0,1fr)]"
      >
        <StatusCard
          server={server}
          className="order-1 lg:col-start-1 lg:row-start-1"
        />
        <KeyNumbers
          server={server}
          className="order-2 lg:col-start-1 lg:row-start-2"
        />

        <Card
          data-slot="detail-chart"
          className={cn(
            CARD_CLASS,
            "order-3 flex flex-col lg:col-start-2 lg:row-span-2 lg:row-start-1",
          )}
        >
          <AvailabilityCurve
            server={server}
            generatedAt={generatedAt}
          />
        </Card>

        <Resources
          server={server}
          className="order-4 lg:col-start-1 lg:row-start-3"
        />

        <div
          data-slot="detail-bottom"
          className="order-5 grid items-stretch gap-4 lg:col-start-2 lg:row-start-3 lg:grid-cols-2"
        >
          {hasBilling ? <Billing billing={billing} /> : null}
          <SystemInfo
            server={server}
            className={hasBilling ? undefined : "lg:col-span-2"}
          />
        </div>

        <TrafficBand
          server={server}
          className="order-6 lg:col-span-2"
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
