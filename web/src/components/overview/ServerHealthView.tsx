import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Link } from "react-router-dom";
import { ServerIcon, ServerOffIcon } from "lucide-react";
import { EmptyState, ListError } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InsightMetrics } from "./InsightMetrics";
import { ResourceLineChart } from "./ResourceLineChart";
import { errorText } from "@/lib/errors";
import { useServerHealth } from "@/lib/queries";
import {
  RESOURCE_METRICS,
  anomalyWindowHours,
  buildAnomalyWindows,
  buildHeatmapColumns,
  buildResourceChartData,
  formatHourTick,
  formatMonthDayHour,
  formatPercent,
  groupHeatmapColumnsByDay,
  heatmapCell,
  normalizeServerHealth,
  resolveResourceMetric,
  resourceServerRows,
  scopeServerHealthSnapshot,
  type AnomalyWindow,
  type ResourceMetric,
  type ServerHealthParseResult,
  type ServerHealthServer,
  type ServerHealthSnapshot,
} from "@/lib/serverHealth";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const RESOURCE_METRIC_LABEL: Record<ResourceMetric, string> = {
  load: "overview.serverHealth.metricLoad",
  memory: "overview.serverHealth.metricMemory",
  disk: "overview.serverHealth.metricDisk",
};

/** 0 = 在线率最低（最浅），4 = 在线率最高（最深）；不引入新色相。 */
const STEP_CLASS = [
  "heatmap-step-0",
  "heatmap-step-1",
  "heatmap-step-2",
  "heatmap-step-3",
  "heatmap-step-4",
];

const UPTIME_BANDS = [
  { step: 0, label: "< 90%" },
  { step: 1, label: "90–95%" },
  { step: 2, label: "95–97%" },
  { step: 3, label: "97–99%" },
  { step: 4, label: "≥ 99%" },
] as const;

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

export default function ServerHealthView({
  selectedIds,
}: {
  /** 概览级筛选的选中集合；四个 tab 共用。 */
  selectedIds: readonly string[];
}) {
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
  return (
    <ServerHealthBody
      snapshot={parsed.snapshot}
      selectedIds={selectedIds}
    />
  );
}

function ServerHealthBody({
  snapshot,
  selectedIds,
}: {
  snapshot: ServerHealthSnapshot;
  selectedIds: readonly string[];
}) {
  const desktop = useIsDesktop();
  // 后端的 summary 是全量口径；这里按选中集合重算 KPI、热力图与折线图。
  const scopedSnapshot = useMemo(
    () => scopeServerHealthSnapshot(snapshot, selectedIds),
    [snapshot, selectedIds],
  );
  const selectedServers = scopedSnapshot.servers;
  const effectiveSelectedIds = useMemo(
    () => selectedServers.map((server) => server.id),
    [selectedServers],
  );

  const uptime24 = scopedSnapshot.summary.uptime24h;
  const uptime7d = scopedSnapshot.summary.uptime7d;
  const sampleServers =
    scopedSnapshot.servers.length -
    scopedSnapshot.summary.serversWithoutSamples;
  const anomalyHint =
    scopedSnapshot.summary.offlineServers +
      scopedSnapshot.summary.resourceServers >
    0
      ? t("overview.serverHealth.anomalyHint", {
          offline: scopedSnapshot.summary.offlineServers,
          resource: scopedSnapshot.summary.resourceServers,
        })
      : t("overview.serverHealth.anomalyHintNone");
  const diskHint =
    scopedSnapshot.summary.diskMax === null
      ? t("overview.serverHealth.diskHintNoData")
      : scopedSnapshot.summary.maxDiskServer
        ? t("overview.serverHealth.diskHint", {
            name: scopedSnapshot.summary.maxDiskServer,
          })
        : t("overview.serverHealth.noData");

  if (selectedServers.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            size="sm"
            icon={ServerOffIcon}
            title={
              selectedIds.length === 0
                ? t("overview.scope.emptyTitle")
                : t("overview.scope.noDataTitle")
            }
            description={
              selectedIds.length === 0
                ? t("overview.scope.emptyDesc")
                : t("overview.scope.noDataDesc")
            }
            className="py-16"
          />
        </CardContent>
      </Card>
    );
  }

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
            value: scopedSnapshot.summary.anomalyServers,
            hint: anomalyHint,
          },
          {
            label: t("overview.serverHealth.diskMax"),
            value: formatPercent(scopedSnapshot.summary.diskMax),
            hint: diskHint,
          },
        ]}
      />

      <HeatmapCard
        snapshot={scopedSnapshot}
        servers={selectedServers}
        desktop={desktop}
      />

      <section className="grid gap-4 xl:grid-cols-3">
        <CurrentResourcesCard
          snapshot={scopedSnapshot}
          selectedIds={effectiveSelectedIds}
          className="xl:col-span-2"
        />
        <AnomalyWindowsCard snapshot={scopedSnapshot} />
      </section>
    </div>
  );
}

function LegendTexture({
  kind,
  label,
}: {
  kind: "nosample" | "offline";
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        aria-hidden="true"
        className={cn(
          "size-3 rounded-[3px]",
          kind === "offline" ? "heatmap-offline" : "heatmap-nosample",
        )}
      />
      {label}
    </span>
  );
}

function UptimeLegend() {
  return (
    <div
      data-heatmap-legend
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] text-muted-foreground"
    >
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground">
          {t("overview.serverHealth.legendBad")}
        </span>
        {UPTIME_BANDS.map((band) => (
          <span
            key={band.step}
            className="inline-flex items-center gap-1 whitespace-nowrap"
          >
            <span
              aria-hidden="true"
              className={cn("size-3 rounded-[3px]", STEP_CLASS[band.step])}
            />
            {band.label}
          </span>
        ))}
        <span className="text-muted-foreground">
          {t("overview.serverHealth.legendGood")}
        </span>
      </span>
      <LegendTexture
        kind="offline"
        label={t("overview.serverHealth.legendOffline")}
      />
      <LegendTexture
        kind="nosample"
        label={t("overview.serverHealth.legendNoSample")}
      />
    </div>
  );
}

function heatmapCellClass(
  state: "sample" | "offline" | "nosample",
  step: number | null,
) {
  if (state === "offline") return "heatmap-offline";
  if (state === "nosample") return "heatmap-nosample";
  return STEP_CLASS[step ?? 0];
}

function cellLabel(
  serverName: string,
  ts: number,
  cell: ReturnType<typeof heatmapCell>,
): string {
  const time = formatMonthDayHour(ts);
  if (cell.state === "nosample") {
    return t("overview.serverHealth.cellNoSample", {
      name: serverName,
      time,
    });
  }
  if (cell.state === "offline") {
    return t("overview.serverHealth.cellOffline", {
      name: serverName,
      time,
    });
  }
  return t("overview.serverHealth.cellTitle", {
    name: serverName,
    time,
    value: formatPercent(cell.value),
  });
}

function HeatmapCard({
  snapshot,
  servers,
  desktop,
}: {
  snapshot: ServerHealthSnapshot;
  servers: ServerHealthServer[];
  desktop: boolean;
}) {
  const stepSecs = Math.max(1, snapshot.window.bucketSecs || 3600);
  const columns = useMemo(
    () => buildHeatmapColumns(snapshot, 168),
    [snapshot],
  );
  const dayGroups = useMemo(
    () => groupHeatmapColumnsByDay(columns),
    [columns],
  );
  const hourGroups = useMemo(() => {
    const groups: { label: string; columns: number }[] = [];
    for (let index = 0; index < columns.length; index += 6) {
      const chunk = columns.slice(index, index + 6);
      groups.push({
        label: formatHourTick(chunk[0].ts),
        columns: chunk.length,
      });
    }
    return groups;
  }, [columns]);
  const dayStarts = useMemo(() => {
    const starts = new Set<number>();
    let index = 0;
    for (const group of dayGroups) {
      starts.add(index);
      index += group.columns;
    }
    return starts;
  }, [dayGroups]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState({
    row: 0,
    col: Math.max(0, columns.length - 1),
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [columns.length, servers.length]);

  const focusRow = Math.min(focus.row, Math.max(0, servers.length - 1));
  const focusCol = Math.min(focus.col, Math.max(0, columns.length - 1));

  const heatmapVars = {
    "--heatmap-cell-size": desktop ? "14px" : "9px",
    "--heatmap-gap": "2px",
  } as CSSProperties;
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${columns.length}, var(--heatmap-cell-size))`,
    columnGap: "var(--heatmap-gap)",
  };
  const first = columns[0]?.ts;
  const last = columns.at(-1)?.ts;

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!target.hasAttribute("data-heatmap-cell")) return;
    const row = Number(target.dataset.row ?? 0);
    const col = Number(target.dataset.col ?? 0);
    let nextRow = row;
    let nextCol = col;
    switch (event.key) {
      case "ArrowLeft":
        nextCol = Math.max(0, col - 1);
        break;
      case "ArrowRight":
        nextCol = Math.min(columns.length - 1, col + 1);
        break;
      case "ArrowUp":
        nextRow = Math.max(0, row - 1);
        break;
      case "ArrowDown":
        nextRow = Math.min(servers.length - 1, row + 1);
        break;
      case "Home":
        nextCol = 0;
        break;
      case "End":
        nextCol = columns.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    setFocus({ row: nextRow, col: nextCol });
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(
          `[data-heatmap-cell][data-row="${nextRow}"][data-col="${nextCol}"]`,
        )
        ?.focus();
    });
  }

  return (
    <Card className="min-w-0 gap-0" data-heatmap-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.serverHealth.heatmapTitle")}
          </CardTitle>
          <Badge
            variant="outline"
            className="shrink-0 font-normal text-muted-foreground"
          >
            {t("overview.serverHealth.metricUptime")}
          </Badge>
        </div>
        <UptimeLegend />
      </CardHeader>

      <CardContent className="min-w-0 p-2 sm:p-4">
        {servers.length === 0 ? (
          <EmptyState
            size="sm"
            icon={ServerOffIcon}
            title={t("overview.scope.emptyTitle")}
            description={t("overview.scope.emptyDesc")}
            className="py-12"
          />
        ) : (
          <div
            role="group"
            aria-label={t("overview.serverHealth.heatmapAria", {
              n: servers.length,
            })}
            data-heatmap
            style={heatmapVars}
          >
            <div
              className="max-h-[420px] overflow-y-auto pr-1"
              data-heatmap-row-scroll
            >
              <div className="flex min-w-0 gap-1 sm:gap-2">
                <div className="w-[60px] shrink-0 sm:w-[120px]">
                  <div
                    style={{
                      height: "calc(var(--heatmap-cell-size) * 2 + 4px)",
                    }}
                  />
                  <div
                    className="flex flex-col"
                    style={{ gap: "var(--heatmap-gap)" }}
                  >
                    {servers.map((server) => (
                      <div
                        key={server.id}
                        className="flex items-center gap-1.5 overflow-hidden"
                        style={{ height: "var(--heatmap-cell-size)" }}
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
                          className="truncate text-[9px] leading-none sm:text-[11px]"
                          title={server.name}
                        >
                          {server.name}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div
                  ref={scrollRef}
                  className="min-w-0 flex-1 overflow-x-auto pb-1"
                  data-heatmap-scroll
                >
                  <div style={{ width: "max-content" }}>
                    <div
                      className="flex flex-col"
                      style={{ gap: "var(--heatmap-gap)" }}
                    >
                      <div
                        className="grid text-[9px] text-muted-foreground sm:text-[10px]"
                        style={gridStyle}
                      >
                        {dayGroups.map((group, index) => (
                          <span
                            key={`${group.day}-${index}`}
                            className="truncate text-center"
                            style={{ gridColumn: `span ${group.columns}` }}
                          >
                            {group.day}
                          </span>
                        ))}
                      </div>
                      <div
                        className="grid text-[8px] text-muted-foreground sm:text-[9px]"
                        style={gridStyle}
                      >
                        {hourGroups.map((group, index) => (
                          <span
                            key={`${group.label}-${index}`}
                            className="truncate text-center"
                            style={{ gridColumn: `span ${group.columns}` }}
                          >
                            {group.label}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div
                      role="grid"
                      aria-label={t("overview.serverHealth.heatmapAria", {
                        n: servers.length,
                      })}
                      aria-rowcount={servers.length}
                      aria-colcount={columns.length}
                      className="mt-0.5 flex flex-col"
                      style={{ gap: "var(--heatmap-gap)" }}
                      onKeyDown={moveFocus}
                    >
                      {servers.map((server, rowIndex) => (
                        <div
                          key={server.id}
                          role="row"
                          aria-label={server.name}
                          data-heatmap-row
                          className="grid"
                          style={gridStyle}
                        >
                          {columns.map((column, colIndex) => {
                            const cell = heatmapCell(
                              server,
                              column.ts,
                              stepSecs,
                            );
                            const label = cellLabel(
                              server.name,
                              column.ts,
                              cell,
                            );
                            const focused =
                              focusRow === rowIndex &&
                              focusCol === colIndex;
                            return (
                              <div
                                key={`${server.id}-${column.ts}`}
                                role="gridcell"
                                tabIndex={focused ? 0 : -1}
                                data-heatmap-cell
                                data-row={rowIndex}
                                data-col={colIndex}
                                data-state={cell.state}
                                data-step={cell.step ?? ""}
                                aria-label={label}
                                title={label}
                                onFocus={() =>
                                  setFocus({
                                    row: rowIndex,
                                    col: colIndex,
                                  })
                                }
                                className={cn(
                                  "aspect-square w-full rounded-[3px] outline-none transition-[box-shadow] duration-100 focus-visible:ring-2 focus-visible:ring-ring",
                                  heatmapCellClass(
                                    cell.state,
                                    cell.step,
                                  ),
                                  dayStarts.has(colIndex) &&
                                    "heatmap-day-start",
                                )}
                              />
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
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
              <span>
                {desktop
                  ? t("overview.serverHealth.heatmapScrollAll")
                  : t("overview.serverHealth.heatmapScrollMobile")}
              </span>
            </div>
            {snapshot.hasSamples ? null : (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {t("overview.serverHealth.heatmapNoSamples")}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CurrentResourcesCard({
  snapshot,
  selectedIds,
  className,
}: {
  snapshot: ServerHealthSnapshot;
  selectedIds: readonly string[];
  className?: string;
}) {
  const [metric, setMetric] = useState<ResourceMetric>("load");
  const latest = snapshot.latestTs;
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allRows = useMemo(
    () => resourceServerRows(snapshot, metric, Number.POSITIVE_INFINITY),
    [snapshot, metric],
  );
  const selectedRows = useMemo(
    () => allRows.filter((row) => selected.has(row.serverId)),
    [allRows, selected],
  );
  const seriesIds = useMemo(
    () => selectedRows.map((row) => row.serverId),
    [selectedRows],
  );
  const defaultVisibleIds = useMemo(
    () => seriesIds.slice(0, 5),
    [seriesIds],
  );
  const columns = useMemo(
    () => buildHeatmapColumns(snapshot, 168),
    [snapshot],
  );
  const chartData = useMemo(
    () => buildResourceChartData(snapshot, metric, seriesIds, columns),
    [snapshot, metric, seriesIds, columns],
  );

  return (
    <Card
      className={cn("flex min-w-0 flex-col gap-0", className)}
      data-resource-card
    >
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
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

        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <Tabs
            value={metric}
            onValueChange={(value) =>
              setMetric(resolveResourceMetric(value))
            }
          >
            <TabsList
              aria-label={t("overview.serverHealth.resourceMetricAria")}
              className="max-w-full overflow-x-auto"
            >
              {RESOURCE_METRICS.map((value) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="px-2 text-xs"
                >
                  {t(RESOURCE_METRIC_LABEL[value])}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>

      <CardContent className="min-w-0 p-2 sm:p-4">
        <ResourceLineChart
          key={`${metric}-${selectedIds.join(",")}-${defaultVisibleIds.join(",")}`}
          data={chartData}
          metric={metric}
          defaultVisibleIds={defaultVisibleIds}
        />
      </CardContent>
      <p className="px-4 pt-1 pb-4 text-[10px] leading-normal text-muted-foreground">
        {t("overview.serverHealth.resourceFootnote")}
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
          <Skeleton className="h-[268px] w-full" />
        </CardContent>
      </Card>
      <section className="grid gap-4 xl:grid-cols-3">
        <Skeleton className="h-[360px] w-full rounded-xl xl:col-span-2" />
        <Skeleton className="h-[360px] w-full rounded-xl" />
      </section>
    </div>
  );
}
