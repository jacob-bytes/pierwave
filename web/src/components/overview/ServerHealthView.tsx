import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ServerIcon, ServerOffIcon, TriangleAlertIcon } from "lucide-react";
import { EmptyState, ListError } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InsightMetrics } from "./InsightMetrics";
import { ResourceLineChart } from "./ResourceLineChart";
import { ServerUptimeTrendChart } from "./ServerUptimeTrendChart";
import { errorText } from "@/lib/errors";
import { useServerHealth } from "@/lib/queries";
import {
  RESOURCE_METRICS,
  anomalyWindowHours,
  buildAnomalyWindows,
  buildHeatmapColumns,
  buildResourceChartData,
  buildUptimeTrend,
  formatHourTick,
  formatMonthDayHour,
  formatPercent,
  groupHeatmapColumnsByDay,
  heatmapCell,
  normalizeServerHealth,
  resolveResourceMetric,
  resourceServerRows,
  type AnomalyWindow,
  type ResourceMetric,
  type ServerHealthParseResult,
  type ServerHealthServer,
  type ServerHealthSnapshot,
} from "@/lib/serverHealth";
import {
  applyServerHealthMode,
  resolveServerHealthMode,
  type ServerHealthMode,
} from "@/lib/serverHealthView";
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
  filtered,
}: {
  /** 概览级筛选的选中集合；四个 tab 共用。 */
  selectedIds: readonly string[];
  /** 选中集合是否真的缩小了范围；全选时不传 `server_ids`。 */
  filtered: boolean;
}) {
  useI18n();
  // 全选（filtered=false）不传 server_ids：与「不筛选」等价，也避免 URL 过长。
  const scoped = filtered && selectedIds.length > 0;
  const query = useServerHealth(
    168,
    3600,
    scoped ? selectedIds : [],
    scoped || !filtered,
  );

  if (filtered && selectedIds.length === 0) return <EmptyServerHealthScope />;
  // 只有第一次请求才铺骨架；切换筛选时继续渲染上一份快照。
  if (query.isPending && query.data === undefined) {
    return <ServerHealthSkeleton />;
  }

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
      filtered={filtered}
    />
  );
}

function ServerHealthBody({
  snapshot,
  selectedIds,
  filtered,
}: {
  snapshot: ServerHealthSnapshot;
  selectedIds: readonly string[];
  filtered: boolean;
}) {
  const desktop = useIsDesktop();
  // 呈现方式的唯一来源是 URL：默认趋势不写参数，热力图写 `?mode=heatmap`。
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = resolveServerHealthMode(searchParams.get("mode"));
  const onModeChange = (value: string) => {
    setSearchParams(
      (previous) =>
        applyServerHealthMode(previous, resolveServerHealthMode(value)),
      { replace: true },
    );
  };
  // KPI 直接用后端 summary：筛选已由 `server_ids` 交给后端，前端不再重算。
  // 旧主控忽略筛选时，行数据仍按选中集合过滤，避免热力图混入范围外服务器。
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const scopedSnapshot = useMemo(
    () =>
      filtered
        ? {
            ...snapshot,
            servers: snapshot.servers.filter((server) =>
              selected.has(server.id),
            ),
          }
        : snapshot,
    [snapshot, selected, filtered],
  );
  const selectedServers = scopedSnapshot.servers;
  const effectiveSelectedIds = useMemo(
    () => selectedServers.map((server) => server.id),
    [selectedServers],
  );

  const uptime24 = scopedSnapshot.summary.uptime24h;
  const uptime7d = scopedSnapshot.summary.uptime7d;
  const sampleServers = Math.max(
    0,
    selectedServers.length - scopedSnapshot.summary.serversWithoutSamples,
  );
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
        mode={mode}
        onModeChange={onModeChange}
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

function UptimeLegend({ approximate }: { approximate: boolean }) {
  return (
    <div
      data-heatmap-legend
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground"
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
      {approximate ? (
        <span
          data-heatmap-approx
          className="inline-flex items-center gap-1 whitespace-nowrap text-warning"
          title={t("overview.serverHealth.legendApproximateHint")}
        >
          <TriangleAlertIcon className="size-3" aria-hidden="true" />
          {t("overview.serverHealth.legendApproximate")}
        </span>
      ) : null}
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
  mode,
  onModeChange,
}: {
  snapshot: ServerHealthSnapshot;
  servers: ServerHealthServer[];
  desktop: boolean;
  /** 热力图 / 趋势；由 `?mode=` 决定。 */
  mode: ServerHealthMode;
  onModeChange: (value: string) => void;
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

  const trend = useMemo(() => buildUptimeTrend(snapshot, 168), [snapshot]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const tipWrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState({
    row: 0,
    col: Math.max(0, columns.length - 1),
  });

  /**
   * 悬停 / 聚焦 / 触摸都立即显示。原生 `title` 有 1–3 秒延迟，不能用于
   * 「鼠标进入格子 → 提示出现」的即时反馈，因此改成受控浮层。
   *
   * 这里直接写 DOM 而不是 `useState`：热力图有 12×168 个格子，置 state 会
   * 让整张网格重渲染，反而把「立即显示」拖到 100ms 以上。
   */
  function showTip(target: HTMLElement, label: string) {
    const wrap = tipWrapRef.current;
    const tip = tipRef.current;
    if (!wrap || !tip) return;
    const wrapRect = wrap.getBoundingClientRect();
    const cellRect = target.getBoundingClientRect();
    const width = Math.min(288, Math.max(160, wrapRect.width - 16));
    const left = Math.min(
      Math.max(4, cellRect.left - wrapRect.left + cellRect.width / 2 - width / 2),
      Math.max(4, wrapRect.width - width - 4),
    );
    const aboveTop = cellRect.top - wrapRect.top - 6;
    const belowTop = cellRect.bottom - wrapRect.top + 6;
    const above = aboveTop >= 36;
    const top = above
      ? aboveTop
      : Math.min(belowTop, Math.max(4, wrapRect.height - 34));
    tip.textContent = label;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.width = `${width}px`;
    tip.style.transform = above ? "translateY(-100%)" : "none";
    tip.hidden = false;
  }

  function hideTip() {
    if (tipRef.current) tipRef.current.hidden = true;
  }

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
    <Card className="min-w-0 gap-0" data-heatmap-card data-uptime-mode={mode}>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.serverHealth.heatmapTitle")}
          </CardTitle>
          <div className="flex min-w-0 items-center gap-2">
            <Badge
              variant="outline"
              className="shrink-0 font-normal text-muted-foreground"
            >
              {t("overview.serverHealth.metricUptime")}
            </Badge>
            <Tabs value={mode} onValueChange={onModeChange}>
              <TabsList
                aria-label={t("overview.serverHealth.uptimeModeAria")}
                data-uptime-mode-tabs
                className="max-w-full overflow-x-auto"
              >
                <TabsTrigger value="heatmap" className="px-2 text-xs">
                  {t("overview.serverHealth.uptimeModeHeatmap")}
                </TabsTrigger>
                <TabsTrigger value="trend" className="px-2 text-xs">
                  {t("overview.serverHealth.uptimeModeTrend")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
        {mode === "heatmap" ? (
          <UptimeLegend approximate={snapshot.approximateUptime} />
        ) : null}
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
        ) : mode === "trend" ? (
          <ServerUptimeTrendChart
            trend={trend}
            approximate={snapshot.approximateUptime}
          />
        ) : (
          <div
            ref={tipWrapRef}
            role="group"
            aria-label={t("overview.serverHealth.heatmapAria", {
              n: servers.length,
            })}
            data-heatmap
            style={heatmapVars}
            className="relative"
            onMouseLeave={hideTip}
          >
            <div
              className="max-h-[420px] overflow-y-auto pr-1"
              data-heatmap-row-scroll
            >
              <div className="flex min-w-0 gap-1 sm:gap-2">
                <div className="w-[80px] shrink-0 sm:w-[120px]">
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
                          className="truncate text-[11px] leading-none"
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
                  onScroll={hideTip}
                >
                  <div style={{ width: "max-content" }}>
                    <div
                      className="flex flex-col"
                      style={{ gap: "var(--heatmap-gap)" }}
                    >
                      <div
                        className="grid text-[11px] text-muted-foreground"
                        style={gridStyle}
                      >
                        {dayGroups.map((group, index) => (
                          <span
                            key={`${group.day}-${index}`}
                            className="whitespace-nowrap text-center"
                            style={{ gridColumn: `span ${group.columns}` }}
                          >
                            {group.day}
                          </span>
                        ))}
                      </div>
                      <div
                        className="grid text-[11px] text-muted-foreground"
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
                      onMouseLeave={hideTip}
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
                                onMouseEnter={(event) =>
                                  showTip(event.currentTarget, label)
                                }
                                onPointerDown={(event) => {
                                  // 390 触摸端没有 hover；点按也要立即出提示。
                                  if (event.pointerType !== "mouse") {
                                    showTip(event.currentTarget, label);
                                  }
                                }}
                                onFocus={(event) => {
                                  setFocus({
                                    row: rowIndex,
                                    col: colIndex,
                                  });
                                  showTip(event.currentTarget, label);
                                }}
                                onBlur={hideTip}
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

            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
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
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("overview.serverHealth.heatmapNoSamples")}
              </p>
            )}
            <div
              ref={tipRef}
              data-heatmap-tooltip
              role="tooltip"
              hidden
              className="pointer-events-none absolute top-0 left-0 z-20 rounded-md border border-border bg-popover px-2 py-1 text-[11px] leading-normal text-popover-foreground shadow-md/30"
            />
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
      <p className="px-4 pt-1 pb-4 text-[11px] leading-normal text-muted-foreground">
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
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
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

function EmptyServerHealthScope() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          size="sm"
          icon={ServerOffIcon}
          title={t("overview.scope.emptyTitle")}
          description={t("overview.scope.emptyDesc")}
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
