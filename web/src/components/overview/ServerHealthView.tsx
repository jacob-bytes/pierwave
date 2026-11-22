import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CpuIcon,
  ServerIcon,
  ServerOffIcon,
} from "lucide-react";
import { EmptyState, ListError } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InsightMetrics } from "./InsightMetrics";
import { errorText } from "@/lib/errors";
import { useServerHealth } from "@/lib/queries";
import {
  anomalyWindowHours,
  buildAnomalyWindows,
  buildHeatmapColumns,
  buildServerResourceRows,
  formatHourTick,
  formatLoad,
  formatMonthDayHour,
  formatPercent,
  groupHeatmapColumnsByDay,
  heatmapCell,
  normalizeServerHealth,
  resolveHeatmapMetric,
  type AnomalyWindow,
  type HeatmapMetric,
  type ServerHealthParseResult,
  type ServerHealthSnapshot,
  type ServerHealthTone,
  type ServerResourceRow,
} from "@/lib/serverHealth";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const METRIC_LABEL: Record<HeatmapMetric, string> = {
  uptime: "overview.serverHealth.metricUptime",
  load: "overview.serverHealth.metricLoad",
  memory: "overview.serverHealth.metricMemory",
  disk: "overview.serverHealth.metricDisk",
};

const METRIC_LEGEND: Record<
  HeatmapMetric,
  { good: string; warn: string; bad: string }
> = {
  uptime: {
    good: "overview.serverHealth.legendGoodUptime",
    warn: "overview.serverHealth.legendWarnUptime",
    bad: "overview.serverHealth.legendBadUptime",
  },
  load: {
    good: "overview.serverHealth.legendGoodLoad",
    warn: "overview.serverHealth.legendWarnLoad",
    bad: "overview.serverHealth.legendBadLoad",
  },
  memory: {
    good: "overview.serverHealth.legendGoodMemory",
    warn: "overview.serverHealth.legendWarnMemory",
    bad: "overview.serverHealth.legendBadMemory",
  },
  disk: {
    good: "overview.serverHealth.legendGoodDisk",
    warn: "overview.serverHealth.legendWarnDisk",
    bad: "overview.serverHealth.legendBadDisk",
  },
};

/** 颜色只表达三档；离线 / 无采样另加纹理，不依赖颜色单一通道。 */
const TONE_CELL: Record<ServerHealthTone, string> = {
  good: "bg-primary/80",
  warn: "bg-warning/80",
  bad: "bg-destructive/80",
  nosample: "heatmap-nosample",
  offline: "heatmap-offline",
};

const ANOMALY_META: Record<
  AnomalyWindow["metric"],
  { labelKey: string; dot: string }
> = {
  offline: {
    labelKey: "overview.serverHealth.anomalyOffline",
    dot: "bg-destructive",
  },
  load: {
    labelKey: "overview.serverHealth.anomalyLoad",
    dot: "bg-warning",
  },
  memory: {
    labelKey: "overview.serverHealth.anomalyMemory",
    dot: "bg-warning",
  },
  disk: {
    labelKey: "overview.serverHealth.anomalyDisk",
    dot: "bg-warning",
  },
};

export default function ServerHealthView() {
  useI18n();
  const query = useServerHealth(168, 3600);

  if (query.isPending) return <ServerHealthSkeleton />;

  if (query.isError) {
    return (
      <Card>
        <CardContent>
          <ListError
            title={t("overview.serverHealth.loadFailed")}
            message={errorText(
              query.error,
              t("overview.serverHealth.loadFailed"),
            )}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  const parsed: ServerHealthParseResult =
    query.data === null
      ? { status: "unsupported" }
      : normalizeServerHealth(query.data);

  if (parsed.status === "unsupported") return <UnsupportedServerHealth />;
  if (parsed.status === "empty") return <EmptyServerHealth />;
  return <ServerHealthBody snapshot={parsed.snapshot} />;
}

function ServerHealthBody({ snapshot }: { snapshot: ServerHealthSnapshot }) {
  const desktop = useIsDesktop();
  const [metric, setMetric] = useState<HeatmapMetric>("uptime");

  const uptime24 = snapshot.summary.uptime24h;
  const uptime7d = snapshot.summary.uptime7d;
  const sampleServers =
    snapshot.servers.length - snapshot.summary.serversWithoutSamples;
  const anomalyHint =
    snapshot.summary.offlineServers + snapshot.summary.resourceServers > 0
      ? t("overview.serverHealth.anomalyHint", {
          offline: snapshot.summary.offlineServers,
          resource: snapshot.summary.resourceServers,
        })
      : t("overview.serverHealth.anomalyHintNone");
  const diskHint =
    snapshot.summary.diskMax === null
      ? t("overview.serverHealth.diskHintNoData")
      : snapshot.summary.maxDiskServer
        ? t("overview.serverHealth.diskHint", {
            name: snapshot.summary.maxDiskServer,
          })
        : t("overview.serverHealth.noData");

  return (
    <div className="space-y-4" data-server-health>
      <InsightMetrics
        items={[
          {
            label: t("overview.serverHealth.uptime24"),
            value: formatPercent(uptime24),
            hint: t(
              sampleServers === 1
                ? "overview.serverHealth.uptimeHintOne"
                : "overview.serverHealth.uptimeHint",
              {
                seven: formatPercent(uptime7d),
                n: sampleServers,
              },
            ),
          },
          {
            label: t("overview.serverHealth.anomalyServers"),
            value: snapshot.summary.anomalyServers,
            hint: anomalyHint,
          },
          {
            label: t("overview.serverHealth.diskMax"),
            value: formatPercent(snapshot.summary.diskMax),
            hint: diskHint,
          },
        ]}
      />

      <HeatmapCard
        snapshot={snapshot}
        metric={metric}
        onMetricChange={setMetric}
        desktop={desktop}
      />

      <section className="grid gap-4 xl:grid-cols-3">
        <CurrentResourcesCard snapshot={snapshot} />
        <AnomalyWindowsCard
          snapshot={snapshot}
          className="xl:col-span-2"
        />
      </section>
    </div>
  );
}

function LegendSwatch({ tone, label }: { tone: ServerHealthTone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        aria-hidden="true"
        className={cn("size-2.5 rounded-[2px]", TONE_CELL[tone])}
      />
      {label}
    </span>
  );
}

function HeatmapCard({
  snapshot,
  metric,
  onMetricChange,
  desktop,
}: {
  snapshot: ServerHealthSnapshot;
  metric: HeatmapMetric;
  onMetricChange: (metric: HeatmapMetric) => void;
  desktop: boolean;
}) {
  const step = Math.max(1, snapshot.window.bucketSecs || 3600);
  const columns = useMemo(
    () => buildHeatmapColumns(snapshot, desktop ? 168 : 24),
    [snapshot, desktop],
  );
  const dayGroups = useMemo(
    () => groupHeatmapColumnsByDay(columns),
    [columns],
  );
  const first = columns[0]?.ts;
  const last = columns.at(-1)?.ts;
  const legend = METRIC_LEGEND[metric];
  const gridStyle = {
    gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
  };
  const dayStyle = {
    gridTemplateColumns: dayGroups
      .map((group) => `${Math.max(1, group.columns)}fr`)
      .join(" "),
  };

  return (
    <Card className="min-w-0 gap-0">
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.serverHealth.heatmapTitle")}
          </CardTitle>
          <Tabs
            value={metric}
            onValueChange={(value) =>
              onMetricChange(resolveHeatmapMetric(value))
            }
          >
            <TabsList
              aria-label={t("overview.serverHealth.heatmapTitle")}
              className="max-w-full overflow-x-auto"
            >
              {(
                ["uptime", "load", "memory", "disk"] as HeatmapMetric[]
              ).map((value) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="px-2 text-xs"
                >
                  {t(METRIC_LABEL[value])}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <LegendSwatch tone="good" label={t(legend.good)} />
          <LegendSwatch tone="warn" label={t(legend.warn)} />
          <LegendSwatch tone="bad" label={t(legend.bad)} />
          <LegendSwatch
            tone="nosample"
            label={t("overview.serverHealth.legendNoSample")}
          />
          <LegendSwatch
            tone="offline"
            label={t("overview.serverHealth.legendOffline")}
          />
        </div>
      </CardHeader>

      <CardContent className="min-w-0 p-4">
        <div
          role="img"
          aria-label={t("overview.serverHealth.heatmapAria", {
            n: snapshot.servers.length,
          })}
          data-heatmap
        >
          <div className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-2 sm:grid-cols-[120px_minmax(0,1fr)]">
            <div className="min-w-0">
              {/* 与日期表头同高，保证行标签和格子对齐。 */}
              <div className="mb-1 h-4" aria-hidden="true" />
              {snapshot.servers.map((server) => (
                <div
                  key={server.id}
                  className="mb-px flex h-3.5 items-center gap-1.5"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      server.status === "online"
                        ? "bg-primary"
                        : server.status === "offline"
                          ? "bg-muted-foreground/40"
                          : "bg-muted-foreground/30",
                    )}
                  />
                  <span
                    className="truncate text-[11px] leading-none"
                    title={server.name}
                  >
                    {server.name}
                  </span>
                </div>
              ))}
            </div>

            <div className="min-w-0 overflow-x-auto pb-1" data-heatmap-scroll>
              <div className={desktop ? "min-w-0" : "min-w-[560px]"}>
                <div
                  className="mb-1 grid text-[10px] text-muted-foreground"
                  style={dayStyle}
                >
                  {dayGroups.map((group, index) => (
                    <span
                      key={`${group.day}-${index}`}
                      className="truncate text-center"
                    >
                      {group.day}
                    </span>
                  ))}
                </div>

                {snapshot.servers.map((server) => (
                  <div
                    key={server.id}
                    className="mb-px grid gap-px"
                    style={gridStyle}
                    data-heatmap-row={server.id}
                  >
                    {columns.map((column) => {
                      const cell = heatmapCell(
                        server,
                        column.ts,
                        metric,
                        step,
                      );
                      return (
                        <span
                          key={`${server.id}-${column.ts}`}
                          aria-hidden="true"
                          data-heatmap-cell
                          data-tone={cell.tone}
                          title={cellTitle(server.name, column.ts, cell.tone, cell.bucket)}
                          className={cn(
                            "h-3.5 w-full rounded-[2px]",
                            TONE_CELL[cell.tone],
                          )}
                        />
                      );
                    })}
                  </div>
                ))}

                {desktop ? null : (
                  <div className="mt-1 grid grid-cols-4 text-[10px] text-muted-foreground">
                    {[0, 6, 12, 18].map((offset, index) => (
                      <span
                        key={offset}
                        className={cn(
                          index === 0
                            ? "text-left"
                            : index === 3
                              ? "text-right"
                              : "text-center",
                        )}
                      >
                        {first === undefined
                          ? "—"
                          : formatHourTick(first + offset * step)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span>
              {first === undefined || last === undefined
                ? t("overview.serverHealth.heatmapNoSamples")
                : t("overview.serverHealth.heatmapRange", {
                    start: formatMonthDayHour(first),
                    end: formatMonthDayHour(last),
                  })}
            </span>
            {snapshot.hasSamples ? null : (
              <span>{t("overview.serverHealth.heatmapNoSamples")}</span>
            )}
          </div>
          {desktop ? null : (
            <p className="mt-1 text-[10px] text-muted-foreground">
              {t("overview.serverHealth.heatmapScroll")}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function cellTitle(
  name: string,
  ts: number,
  tone: ServerHealthTone,
  bucket: ReturnType<typeof heatmapCell>["bucket"],
): string {
  const time = formatMonthDayHour(ts);
  if (tone === "nosample") {
    return t("overview.serverHealth.cellNoSample", { name, time });
  }
  if (tone === "offline") {
    return t("overview.serverHealth.cellOffline", { name, time });
  }
  return t("overview.serverHealth.cellTitle", {
    name,
    time,
    online: formatPercent(bucket?.onlineRatio ?? null),
    load: formatLoad(bucket?.load1 ?? null),
    mem: formatPercent(bucket?.memRatio ?? null),
    disk: formatPercent(bucket?.diskRatio ?? null),
  });
}

function resourceBarClass(
  kind: "load" | "memory" | "disk",
  ratio: number | null,
): string {
  if (ratio === null) return "bg-muted";
  if (kind === "load") {
    if (ratio < 0.25) return "bg-primary";
    if (ratio < 1) return "bg-warning";
    return "bg-destructive";
  }
  if (ratio >= 0.9) return "bg-destructive";
  if (ratio >= 0.7) return "bg-warning";
  return "bg-primary";
}

function ResourceBar({
  kind,
  label,
  ratio,
  text,
}: {
  kind: "load" | "memory" | "disk";
  label: string;
  ratio: number | null;
  text: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-10 shrink-0 text-muted-foreground">{label}</span>
      <span
        aria-hidden="true"
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn(
            "block h-full rounded-full",
            resourceBarClass(kind, ratio),
          )}
          style={{
            width: ratio === null ? "0%" : `${Math.round(ratio * 100)}%`,
          }}
        />
      </span>
      <span className="w-10 shrink-0 text-right font-mono tabular-nums">
        {text}
      </span>
    </div>
  );
}

function ResourceRow({ row }: { row: ServerResourceRow }) {
  const alert =
    (row.load1 ?? 0) >= 4 ||
    (row.memRatio ?? 0) >= 0.9 ||
    (row.diskRatio ?? 0) >= 0.9;
  return (
    <li className="rounded-md px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            row.server.status === "online"
              ? "bg-primary"
              : row.server.status === "offline"
                ? "bg-muted-foreground/40"
                : "bg-muted-foreground/30",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm" title={row.server.name}>
          {row.server.name}
        </span>
        {alert ? (
          <Badge
            variant="outline"
            className="shrink-0 border-transparent bg-warning/10 font-normal text-warning"
          >
            {t("overview.serverHealth.resourceAlert")}
          </Badge>
        ) : null}
      </div>
      <div className="mt-1.5 grid gap-1">
        <ResourceBar
          kind="load"
          label={t("overview.serverHealth.loadLabel")}
          ratio={row.loadRatio}
          text={formatLoad(row.load1)}
        />
        <ResourceBar
          kind="memory"
          label={t("overview.serverHealth.memLabel")}
          ratio={row.memRatio}
          text={formatPercent(row.memRatio)}
        />
        <ResourceBar
          kind="disk"
          label={t("overview.serverHealth.diskLabel")}
          ratio={row.diskRatio}
          text={formatPercent(row.diskRatio)}
        />
      </div>
    </li>
  );
}

function CurrentResourcesCard({ snapshot }: { snapshot: ServerHealthSnapshot }) {
  const rows = buildServerResourceRows(snapshot, 6);
  const latest = snapshot.latestTs;

  return (
    <Card className="flex flex-col gap-0">
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.serverHealth.currentTitle")}
          </CardTitle>
          {latest === null ? null : (
            <Badge
              variant="outline"
              className="shrink-0 font-normal text-muted-foreground"
            >
              {t("overview.serverHealth.currentSnapshot", {
                time: formatMonthDayHour(latest),
              })}
            </Badge>
          )}
        </div>
      </CardHeader>
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={CpuIcon}
          title={t("overview.serverHealth.currentEmpty")}
          className="py-10"
        />
      ) : (
        <CardContent className="p-2">
          <ul className="flex flex-col gap-0.5">
            {rows.map((row) => (
              <ResourceRow key={row.server.id} row={row} />
            ))}
          </ul>
        </CardContent>
      )}
      <p className="px-4 pt-1 pb-4 text-[10px] leading-normal text-muted-foreground">
        {t("overview.serverHealth.loadFootnote")}
      </p>
    </Card>
  );
}

function AnomalyRow({
  window,
  bucketSecs,
}: {
  window: AnomalyWindow;
  bucketSecs: number;
}) {
  const meta = ANOMALY_META[window.metric];
  const hours = anomalyWindowHours(window, bucketSecs);
  const end = window.ongoing
    ? t("overview.serverHealth.anomalyNow")
    : formatMonthDayHour(window.endTs);

  return (
    <li className="flex items-start gap-2 rounded-md px-2.5 py-2 transition-colors duration-150 hover:bg-muted/40">
      <span
        aria-hidden="true"
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", meta.dot)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate text-sm" title={window.serverName}>
            {window.serverName}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
            {t("overview.serverHealth.anomalyDuration", { n: hours })}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {t(meta.labelKey)} · {formatMonthDayHour(window.startTs)} – {end}
        </p>
      </div>
    </li>
  );
}

function AnomalyWindowsCard({
  snapshot,
  className,
}: {
  snapshot: ServerHealthSnapshot;
  className?: string;
}) {
  const windows = useMemo(
    () =>
      buildAnomalyWindows(
        snapshot.servers,
        snapshot.window.bucketSecs,
        snapshot.latestTs,
      ),
    [snapshot],
  );

  return (
    <Card className={cn("flex flex-col gap-0", className)}>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.serverHealth.anomalyTitle")}
          </CardTitle>
          {windows.length === 0 ? null : (
            <Badge
              variant="outline"
              className="shrink-0 border-transparent bg-warning/10 font-normal text-warning"
            >
              {t(
                windows.length === 1
                  ? "overview.serverHealth.anomalyCountOne"
                  : "overview.serverHealth.anomalyCount",
                { n: windows.length },
              )}
            </Badge>
          )}
        </div>
      </CardHeader>
      {windows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={ServerOffIcon}
          title={t("overview.serverHealth.anomalyEmpty")}
          className="py-10"
        />
      ) : (
        <CardContent className="max-h-[420px] overflow-y-auto p-2">
          <ul className="flex flex-col gap-0.5">
            {windows.map((window) => (
              <AnomalyRow
                key={window.key}
                window={window}
                bucketSecs={snapshot.window.bucketSecs}
              />
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

function UnsupportedServerHealth() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          icon={ServerIcon}
          title={t("overview.serverHealth.unsupportedTitle")}
          description={t("overview.serverHealth.unsupportedDesc")}
          className="py-16"
        />
      </CardContent>
    </Card>
  );
}

function EmptyServerHealth() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          tone="primary"
          icon={ServerIcon}
          title={t("overview.serverHealth.emptyTitle")}
          description={t("overview.serverHealth.emptyDesc")}
          className="py-16"
          action={
            <Button asChild>
              <Link to="/servers">
                {t("overview.serverHealth.emptyAction")}
              </Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}

function ServerHealthSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <Skeleton className="h-[88px] w-full rounded-xl" />
      <Card className="gap-4">
        <CardHeader>
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-[238px] w-full" />
        </CardContent>
      </Card>
      <section className="grid gap-4 xl:grid-cols-3">
        <Skeleton className="h-[300px] w-full rounded-xl" />
        <Skeleton className="h-[300px] w-full rounded-xl xl:col-span-2" />
      </section>
    </div>
  );
}
