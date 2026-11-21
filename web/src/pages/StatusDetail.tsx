import type { ComponentProps, ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CloudOffIcon,
  FolderIcon,
  GlobeIcon,
  RefreshCwIcon,
  ServerOffIcon,
  ShieldIcon,
} from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/common";
import {
  AVAILABILITY_BAR_CLASS,
  AVAILABILITY_TEXT_CLASS,
} from "@/components/status/Availability";
import { Meter } from "@/components/status/Meter";
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
import { formatBytePair } from "@/lib/format";
import { rateParts } from "@/lib/netRate";
import {
  availabilityPercentText,
  availabilityTone,
  expiryLabel,
  hasSamples,
  lowestAvailabilityBucket,
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
  formatHourRange,
  formatRelativeTime,
} from "@/lib/time";
import { usePublicStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * 公开状态页的服务器详情 `/status/:id`。
 *
 * 数据完全来自列表页同一份 `GET /api/v1/public/status`（20 秒轮询），没有
 * 新接口，也不展示地址、节点、用户或流量明细。离线服务器仍可打开：页面
 * 展示最后一次上报的读数，状态 chip 明确写「离线」；从未上报的字段是 `—`。
 */

const VALUE_CLASS = "text-[19px] leading-none font-semibold sm:text-[28px]";

/** 三列关键数字的标签；值由调用方给。 */
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
      <div className="mt-2 flex min-h-7 flex-wrap items-baseline gap-1.5">
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

function Unit({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-normal text-muted-foreground">
      {children}
    </span>
  );
}

function KeyNumbers({ server }: { server: PublicStatusServer }) {
  const { t } = useI18n();
  const latency = reportedLatency(server.latency_ms);
  // 与列表 hero 同一口径：24h 桶全空时不展示一个无法由折线佐证的百分比。
  const buckets = Array.isArray(server.buckets_24h) ? server.buckets_24h : [];
  const uptime = hasSamples(buckets)
    ? availabilityPercentText(server.uptime_24h)
    : null;
  const tone = availabilityTone(
    hasSamples(buckets) ? server.uptime_24h : null,
  );
  const rx = rateParts(server.net_rx_bps);
  const tx = rateParts(server.net_tx_bps);

  return (
    <Card
      data-slot="detail-key-numbers"
      className="gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
    >
      <div className="grid gap-5 sm:grid-cols-3 sm:gap-4">
        <DetailStat name="latency" label={t("publicStatus.hero.averageLatency")}>
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

        <DetailStat name="rate" label={t("publicStatus.hero.totalRate")}>
          {rx === null && tx === null ? (
            <Dash />
          ) : (
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              {[
                { icon: ArrowDownIcon, parts: rx, label: t("publicStatus.server.trafficRx") },
                { icon: ArrowUpIcon, parts: tx, label: t("publicStatus.server.trafficTx") },
              ].map(({ icon: Icon, parts, label }) => (
                <span
                  key={label}
                  className="inline-flex min-w-0 items-baseline gap-1"
                >
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

function AvailabilityBars({ server }: { server: PublicStatusServer }) {
  const { t } = useI18n();
  const source = Array.isArray(server.buckets_24h) ? server.buckets_24h : [];
  const buckets = Array.from(
    { length: 24 },
    (_, index) => source[index] ?? null,
  );
  const lowest = lowestAvailabilityBucket(buckets);
  const lowestPercent =
    lowest === null ? null : availabilityPercentText(lowest.ratio);

  return (
    <Card
      data-slot="detail-availability"
      className="gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
    >
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground">
        {t("publicStatus.detail.sections.availability")}
      </h2>

      <div
        role="img"
        data-slot="detail-bars"
        aria-label={t("publicStatus.detail.availabilityAria", {
          name: server.name,
        })}
        className="mt-4 flex h-14 items-end gap-1"
      >
        {buckets.map((bucket, index) => {
          const ratio = bucket?.online_ratio ?? null;
          const percent =
            ratio === null || !Number.isFinite(ratio)
              ? null
              : availabilityPercentText(ratio);
          const tone = availabilityTone(ratio);
          const height =
            ratio === null || !Number.isFinite(ratio)
              ? 100
              : Math.max(2, Math.min(1, Math.max(0, ratio)) * 100);
          return (
            <span
              key={index}
              data-slot="detail-bar"
              data-ratio={ratio === null ? "null" : ratio}
              aria-hidden="true"
              title={
                bucket && percent !== null
                  ? `${formatAbsoluteTime(bucket.ts)} · ${percent}%`
                  : t("publicStatus.availability.unknown")
              }
              className={cn(
                "min-w-0 flex-1 rounded-[2px]",
                ratio === null || !Number.isFinite(ratio)
                  ? "bg-muted-foreground/15"
                  : AVAILABILITY_BAR_CLASS[tone],
              )}
              style={{ height: `${height}%` }}
            />
          );
        })}
      </div>

      {lowest !== null && lowestPercent !== null ? (
        <p
          data-slot="detail-lowest"
          className="tnum mt-3 text-xs text-muted-foreground"
        >
          {t("publicStatus.detail.lowest", {
            range: formatHourRange(lowest.ts),
            percent: lowestPercent,
          })}
        </p>
      ) : null}
    </Card>
  );
}

function Resources({ server }: { server: PublicStatusServer }) {
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
      className="gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
    >
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground">
        {t("publicStatus.detail.sections.resources")}
      </h2>
      <div className="mt-4 grid gap-5 sm:grid-cols-3 sm:gap-4">
        <Meter
          label={t("publicStatus.server.load")}
          value={load === null ? "—" : load.toFixed(2)}
          muted={load === null}
          foot={
            load === null
              ? t("publicStatus.server.notReported")
              : t("publicStatus.server.loadHint")
          }
          emptyLabel={t("publicStatus.server.notReported")}
        />
        <Meter
          label={t("publicStatus.server.memory")}
          percent={memPercent}
          foot={memPair ?? t("publicStatus.server.notReported")}
          footTitle={memPair ?? undefined}
          emptyLabel={t("publicStatus.server.notReported")}
        />
        <Meter
          label={t("publicStatus.server.disk")}
          percent={diskPercent}
          foot={diskPair ?? t("publicStatus.server.notReported")}
          footTitle={diskPair ?? undefined}
          emptyLabel={t("publicStatus.server.notReported")}
        />
      </div>
    </Card>
  );
}

function Billing({ server }: { server: PublicStatusServer }) {
  const { t } = useI18n();
  const billing: PublicBilling = publicBilling(server);
  const expiryLabelKey =
    billing.days === null ? null : expiryLabel(billing.days);
  const expiry =
    expiryLabelKey === null
      ? null
      : t(expiryLabelKey.key, expiryLabelKey.values);
  const cycle = billing.cycleKey === null ? null : t(billing.cycleKey);
  const price =
    billing.price === null
      ? null
      : cycle
        ? `${billing.price} / ${cycle}`
        : billing.price;

  if (expiry === null && price === null) return null;

  return (
    <Card
      data-slot="detail-billing"
      className="gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
    >
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground">
        {t("publicStatus.detail.sections.billing")}
      </h2>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        {expiry ? (
          <span
            className={cn(
              billing.days !== null && billing.days < 0 && "text-warning",
            )}
            title={billing.paidUntil ?? undefined}
          >
            {expiry}
          </span>
        ) : null}
        {expiry && price ? (
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
        ) : null}
        {price ? <span className="tnum">{price}</span> : null}
      </p>
    </Card>
  );
}

function SystemInfo({ server }: { server: PublicStatusServer }) {
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
    <Card
      data-slot="detail-system"
      className="gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
    >
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground">
        {t("publicStatus.detail.sections.system")}
      </h2>
      <dl className="mt-4 grid gap-3 sm:grid-cols-3 sm:gap-4">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="mt-1 truncate text-sm text-foreground" title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function DetailHeader({ server }: { server: PublicStatusServer }) {
  const { t, locale } = useI18n();
  const state = serverState(server);
  const uptime = (() => {
    if (state === "offline") return null;
    const parts = uptimeParts(server.uptime_secs);
    return parts ? t(uptimeLabelKey(parts), parts) : null;
  })();
  const group = normalizeGroupName(server.group_name);
  const country = normalizeCountryCode(server.country_code);
  const flag = countryCodeToFlag(server.country_code);
  const countryTitle = country
    ? t("publicStatus.server.countryTitle", {
        name: countryDisplayName(country, locale) ?? country,
        code: country,
      })
    : t("publicStatus.server.countryUnset");

  return (
    <Card
      data-slot="detail-header"
      className="gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
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
                <span aria-hidden="true" className="text-sm leading-none select-none">
                  {flag}
                </span>
              ) : (
                <GlobeIcon
                  aria-hidden="true"
                  className="icon-sm text-muted-foreground"
                />
              )}
            </span>
            {group ? (
              <span
                className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
                title={t("publicStatus.detail.groupTitle", { name: group })}
              >
                <FolderIcon className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{group}</span>
              </span>
            ) : null}
            <StatusChip state={state} uptime={uptime} />
          </div>
        </div>

        <Button variant="ghost" asChild className="ml-auto h-10 shrink-0 px-3">
          <Link to="/status" data-slot="detail-back">
            <ArrowLeftIcon className="icon-sm" aria-hidden="true" />
            {t("publicStatus.detail.back")}
          </Link>
        </Button>
      </div>
    </Card>
  );
}

function Footer({ server }: { server: PublicStatusServer }) {
  const { t } = useI18n();
  const lastSeen = server.last_seen;
  const hasLastSeen =
    typeof lastSeen === "number" &&
    Number.isFinite(lastSeen) &&
    lastSeen > 0;
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

function DetailContent({ server }: { server: PublicStatusServer }) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <DetailHeader server={server} />
      <KeyNumbers server={server} />
      <AvailabilityBars server={server} />
      <Resources server={server} />
      <Billing server={server} />
      <SystemInfo server={server} />
      <Footer server={server} />
    </div>
  );
}

function StatePanel({
  children,
  ...props
}: ComponentProps<typeof Card>) {
  return <Card className="mx-auto w-full max-w-4xl rounded-xl py-0" {...props}>{children}</Card>;
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

      <main className={cn(PAGE_CONTAINER, "flex-1 py-4")}>
        {disabled ? (
          <StatePanel role="status" aria-live="polite">
            <EmptyState
              icon={ShieldIcon}
              title={t("publicStatus.disabled.title")}
              description={t("publicStatus.disabled.description")}
            />
          </StatePanel>
        ) : status.isError ? (
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
        ) : status.data === undefined ? (
          <StatusDetailSkeleton label={t("publicStatus.loading")} />
        ) : server === null ? (
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
        ) : (
          <DetailContent server={server} />
        )}
      </main>
    </div>
  );
}
