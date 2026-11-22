import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Link } from "react-router-dom";
import { FilterIcon, ServerIcon, ServerOffIcon } from "lucide-react";
import { EmptyState, ListError } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InsightMetrics } from "./InsightMetrics";
import { ResourceAreaChart } from "./ResourceAreaChart";
import { errorText } from "@/lib/errors";
import { useServerHealth } from "@/lib/queries";
import {
  RESOURCE_METRICS,
  anomalyWindowHours,
  buildAnomalyWindows,
  buildHeatmapColumns,
  buildResourceChartData,
  formatHourTick,
  formatLoad,
  formatMonthDayHour,
  formatPercent,
  groupHeatmapColumnsByDay,
  heatmapCell,
  normalizeServerHealth,
  resolveHeatmapMetric,
  resolveResourceMetric,
  resourceServerRows,
  type AnomalyWindow,
  type HeatmapMetric,
  type ResourceMetric,
  type ServerHealthParseResult,
  type ServerHealthSnapshot,
} from "@/lib/serverHealth";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const HEATMAP_METRIC_LABEL: Record<HeatmapMetric, string> = {
  uptime: "overview.serverHealth.metricUptime",
  load: "overview.serverHealth.metricLoad",
  memory: "overview.serverHealth.metricMemory",
  disk: "overview.serverHealth.metricDisk",
};

const RESOURCE_METRIC_LABEL: Record<ResourceMetric, string> = {
  load: "overview.serverHealth.metricLoad",
  memory: "overview.serverHealth.metricMemory",
  disk: "overview.serverHealth.metricDisk",
};

/** 0 = 主色最浅（最好），4 = 主色最深（最差）；不引入新色相。 */
const STEP_CLASS = [
  "bg-primary/25",
  "bg-primary/40",
  "bg-primary/55",
  "bg-primary/70",
  "bg-primary/90",
];

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
        <CurrentResourcesCard
          snapshot={snapshot}
          className="xl:col-span-2"
        />
        <AnomalyWindowsCard snapshot={snapshot} />
      </section>
    </div>
  );
}

function LegendScale({ metric }: { metric: HeatmapMetric }) {
  const lowKey =
    metric === "uptime"
      ? "overview.serverHealth.legendGood"
      : "overview.serverHealth.legendLow";
  const highKey =
    metric === "uptime"
      ? "overview.serverHealth.legendBad"
      : "overview.serverHealth.legendHigh";
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span>{t(lowKey)}</span>
      {[0, 2, 4].map((step) => (
        <span
          key={step}
          aria-hidden="true"
          className={cn("size-3 rounded-[3px]", STEP_CLASS[step])}
        />
      ))}
      <span>{t(highKey)}</span>
    </span>
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

function heatmapCellClass(state: "sample" | "offline" | "nosample", step: number | null) {
  if (state === "offline") return "heatmap-offline";
  if (state === "nosample") return "heatmap-nosample";
  return STEP_CLASS[step ?? 0];
}

function cellLabel(
  serverName: string,
  ts: number,
  metric: HeatmapMetric,
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
  const value =
    metric === "load"
      ? formatLoad(cell.value)
      : formatPercent(cell.value);
  return t("overview.serverHealth.cellTitle", {
    name: serverName,
    time,
    metric: t(HEATMAP_METRIC_LABEL[metric]),
    value,
    online: formatPercent(cell.bucket?.onlineRatio ?? null),
    load: formatLoad(cell.bucket?.load1 ?? null),
    mem: formatPercent(cell.bucket?.memRatio ?? null),
    disk: formatPercent(cell.bucket?.diskRatio ?? null),
  });
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
  }, [columns.length]);

  const focusRow = Math.min(
    focus.row,
    Math.max(0, snapshot.servers.length - 1),
  );
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
  const legendLabel =
    metric === "uptime"
      ? t("overview.serverHealth.metricUptime")
      : t(HEATMAP_METRIC_LABEL[metric]);

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
        nextRow = Math.min(snapshot.servers.length - 1, row + 1);
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
                  {t(HEATMAP_METRIC_LABEL[value])}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div
          data-heatmap-legend
          className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground"
        >
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className="font-medium text-foreground">{legendLabel}</span>
            <LegendScale metric={metric} />
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
      </CardHeader>

      <CardContent className="min-w-0 p-2 sm:p-4">
        <div
          role="group"
          aria-label={t("overview.serverHealth.heatmapAria", {
            n: snapshot.servers.length,
          })}
          data-heatmap
          style={heatmapVars}
        >
          <div className="flex min-w-0 gap-1 sm:gap-2">
            <div className="w-[60px] shrink-0 sm:w-[120px]">
              <div style={{ height: "calc(var(--heatmap-cell-size) * 2 + 4px)" }} />
              <div
                className="flex flex-col"
                style={{ gap: "var(--heatmap-gap)" }}
              >
                {snapshot.servers.map((server) => (
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
                <div className="flex flex-col" style={{ gap: "var(--heatmap-gap)" }}>
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
                    n: snapshot.servers.length,
                  })}
                  aria-rowcount={snapshot.servers.length}
                  aria-colcount={columns.length}
                  className="mt-0.5 flex flex-col"
                  style={{ gap: "var(--heatmap-gap)" }}
                  onKeyDown={moveFocus}
                >
                  {snapshot.servers.map((server, rowIndex) => (
                    <div
                      key={server.id}
                      role="row"
                      aria-label={server.name}
                      className="grid"
                      style={gridStyle}
                    >
                      {columns.map((column, colIndex) => {
                        const cell = heatmapCell(
                          server,
                          column.ts,
                          metric,
                          stepSecs,
                        );
                        const label = cellLabel(
                          server.name,
                          column.ts,
                          metric,
                          cell,
                        );
                        const focused =
                          focusRow === rowIndex && focusCol === colIndex;
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
                              setFocus({ row: rowIndex, col: colIndex })
                            }
                            className={cn(
                              "aspect-square w-full rounded-[3px] outline-none transition-[box-shadow] duration-100 focus-visible:ring-2 focus-visible:ring-ring",
                              heatmapCellClass(cell.state, cell.step),
                              dayStarts.has(colIndex) && "heatmap-day-start",
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
      </CardContent>
    </Card>
  );
}

function CurrentResourcesCard({
  snapshot,
  className,
}: {
  snapshot: ServerHealthSnapshot;
  className?: string;
}) {
  const [metric, setMetric] = useState<ResourceMetric>("load");
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    resourceServerRows(snapshot, "load", 5).map((row) => row.serverId),
  );
  const latest = snapshot.latestTs;
  const allRows = useMemo(
    () => resourceServerRows(snapshot, metric, Number.POSITIVE_INFINITY),
    [snapshot, metric],
  );
  const columns = useMemo(
    () => buildHeatmapColumns(snapshot, 168),
    [snapshot],
  );
  const effectiveSelectedIds = useMemo(
    () =>
      selectedIds.filter((id) =>
        allRows.some((row) => row.serverId === id),
      ),
    [selectedIds, allRows],
  );

  const chartData = useMemo(
    () =>
      buildResourceChartData(
        snapshot,
        metric,
        effectiveSelectedIds,
        columns,
      ),
    [snapshot, metric, effectiveSelectedIds, columns],
  );

  function changeMetric(value: string) {
    const next = resolveResourceMetric(value);
    setMetric(next);
    setSelectedIds(
      resourceServerRows(snapshot, next, 5).map((row) => row.serverId),
    );
    setFilterOpen(false);
  }

  function toggleServer(id: string) {
    setSelectedIds((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id],
    );
  }

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
          <div className="flex flex-wrap items-center gap-2">
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-resource-filter
              onClick={() => setFilterOpen((open) => !open)}
              disabled={allRows.length === 0}
            >
              <FilterIcon />
              {t("overview.serverHealth.resourceFilter", {
                selected: effectiveSelectedIds.length,
                total: allRows.length,
              })}
            </Button>
          </div>
        </div>

        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <Tabs value={metric} onValueChange={changeMetric}>
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

        {filterOpen ? (
          <div
            className="mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto"
            data-resource-chips
          >
            {allRows.map((row) => {
              const selected = selectedIds.includes(row.serverId);
              return (
                <button
                  key={row.serverId}
                  type="button"
                  aria-pressed={selected}
                  data-resource-chip
                  onClick={() => toggleServer(row.serverId)}
                  className={cn(
                    "max-w-40 truncate rounded-full border px-2.5 py-1 text-[10px] transition-colors duration-150",
                    selected
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "border-border bg-muted/30 text-muted-foreground hover:text-foreground",
                  )}
                  title={row.name}
                >
                  {row.name}
                </button>
              );
            })}
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="min-w-0 p-2 sm:p-4">
        <ResourceAreaChart
          key={`${metric}-${effectiveSelectedIds.join(",")}`}
          data={chartData}
          metric={metric}
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
