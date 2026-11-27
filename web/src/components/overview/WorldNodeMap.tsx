import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { countryDisplayName } from "@/lib/country";
import { useServers } from "@/lib/queries";
import { cn } from "@/lib/utils";
import worldMapPaths from "@/lib/worldMapPaths.json";
import {
  worldNodeMarkerRadius,
  worldNodeStats,
  worldNodeStatus,
  type WorldNodeStatus,
} from "@/lib/worldNodeStats";
import { t, useI18n } from "@/i18n";

/**
 * 等距圆柱投影的完整坐标系是 1000×500（lat 90..-90）。这里只把 viewBox 纵向
 * 裁到 lat +78°..-56°：保留格陵兰南缘与新西兰，去掉南极与北极圈上方的大片
 * 空白，同时保持投影不变，路径坐标仍是完整坐标系。
 *
 * y(+78°) = (90 - 78) / 180 * 500 = 33.3
 * y(-56°) = (90 + 56) / 180 * 500 = 405.6 → 高 372.2
 */
const VIEW_BOX = "0 33.3 1000 372.2";
const VIEW_WIDTH = 1000;

/** 有节点国家四档 fill；无节点陆块单独用 muted-foreground。 */
const TIER_FILL = [
  "fill-primary/20",
  "fill-primary/35",
  "fill-primary/55",
  "fill-primary/80",
] as const;
/** hover / focus 时提亮一档；最高档没有下一档，用 /90 继续给反馈。 */
const TIER_HOVER_FILL = [
  "fill-primary/35",
  "fill-primary/55",
  "fill-primary/80",
  "fill-primary/90",
] as const;
const TIER_BG = [
  "bg-primary/20",
  "bg-primary/35",
  "bg-primary/55",
  "bg-primary/80",
] as const;
const TIER_RANGES = ["1", "2–3", "4–6", "7+"] as const;

/** 圆点半径按档位 3 / 4 / 5 / 6px（屏幕像素，缩放后换算回 viewBox）。 */
const MARKER_STROKE_PX = 2;
const MARKER_GAP_PX = 4;
const MARKER_LABEL_PX = 12;
const MARKER_FOCUS_GAP_PX = 3;
/** 有外环时把 N 标签 / focus ring 再让开，避免和状态环叠在一起。 */
const MARKER_RING_LABEL_GAP_PX = 7;
const MARKER_RING_FOCUS_GAP_PX = 6;
/** 状态外环：半径 +2.5px、2px 宽；在线没有外环。 */
const STATUS_RING_OFFSET_PX = 2.5;
const STATUS_RING_STROKE_PX = 2;
const STATUS_RING_STROKE = {
  online: null,
  offline: "stroke-destructive",
  abnormal: "stroke-warning",
} as const satisfies Record<WorldNodeStatus, string | null>;

interface CountryShape {
  d: string;
  c: [number, number];
}

const COUNTRIES = worldMapPaths as unknown as Record<string, CountryShape>;

interface TipState {
  country: string;
  x: number;
  y: number;
  below: boolean;
}

/**
 * 图例右侧的 12px 状态示意：实心 primary 圆点 = 有节点，外环 = 最差状态。
 * 和地图上的圆点 / 外环同色，避免图例与数据各说各话。
 */
function StatusLegendGlyph({ status }: { status: WorldNodeStatus }) {
  const ring = STATUS_RING_STROKE[status];
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      data-world-map-legend-glyph={status}
      className="shrink-0"
    >
      {ring ? (
        <circle
          cx="6"
          cy="6"
          r={4.6}
          fill="none"
          strokeWidth={1.2}
          className={ring}
        />
      ) : null}
      <circle
        cx="6"
        cy="6"
        r={2.4}
        className="fill-primary stroke-card"
        strokeWidth={1.4}
      />
    </svg>
  );
}

/**
 * 概览「资源状态」里的节点分布世界地图。
 *
 * 数据完全来自已缓存的 `useServers`（国家代码 + 状态），不额外请求接口；
 * SVG 路径与每个国家的质心由 `web/scripts/build-world-map.mjs` 在构建期生成。
 * 国家统计走 `worldNodeStats` 纯函数，组件只负责配色、圆点、tooltip 与跳转。
 *
 * 小地区（HK / SG / MO）的陆地轮廓可能只有一两个像素，所以圆点半径按屏幕
 * 像素固定为 3–6px：用 ResizeObserver 量出 SVG 的实际宽度，再把像素半径
 * 换算回 viewBox 单位，390 下也不会缩成看不见的点。
 */
export default function WorldNodeMap({
  selectedIds,
  filtered,
}: {
  /** 概览级筛选的选中集合；四个 tab 共用。 */
  selectedIds: readonly string[];
  /** 是否真的缩小了范围；全选时展示全部服务器。 */
  filtered: boolean;
}) {
  const { locale } = useI18n();
  const navigate = useNavigate();
  const servers = useServers();
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [mapWidth, setMapWidth] = useState(0);

  const stats = useMemo(() => {
    const source = servers.data ?? [];
    const selected = new Set(selectedIds);
    const scoped = filtered
      ? source.filter((server) => selected.has(server.id))
      : source;
    return worldNodeStats(
      scoped.map((server) => ({
        id: server.id,
        name: server.name,
        country_code: server.country_code,
        status: worldNodeStatus(server),
      })),
    );
  }, [servers.data, filtered, selectedIds]);

  const byCountry = useMemo(
    () => new Map(stats.map((stat) => [stat.country, stat])),
    [stats],
  );

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const syncWidth = () => {
      const width = svg.getBoundingClientRect().width;
      if (width > 0) {
        setMapWidth((previous) =>
          Math.abs(previous - width) < 0.5 ? previous : width,
        );
      }
    };
    syncWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncWidth);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  /** 屏幕 px → viewBox 单位；首帧宽度未知时先按 1 处理，量到后立即校正。 */
  const scale = mapWidth > 0 ? mapWidth / VIEW_WIDTH : 1;

  /**
   * 390 下欧洲的 N 标签会挤在一起（DE / FR 质心只差几个屏幕像素）。
   * 按屏幕坐标做一次简单的下移避让；标签仍在圆点右侧，只是垂直错开 17px。
   */
  const labelOffsets = useMemo(() => {
    const placed: { x: number; y: number }[] = [];
    const offsets = new Map<string, number>();
    const labeled = stats
      .filter((stat) => stat.total >= 2 && COUNTRIES[stat.country])
      .sort(
        (a, b) =>
          COUNTRIES[a.country].c[1] - COUNTRIES[b.country].c[1],
      );
    for (const stat of labeled) {
      const [centroidX, centroidY] = COUNTRIES[stat.country].c;
      const radius = worldNodeMarkerRadius(stat.tier);
      const gap = STATUS_RING_STROKE[stat.worst]
        ? MARKER_RING_LABEL_GAP_PX
        : MARKER_GAP_PX;
      const x = centroidX * scale + radius + gap;
      let offset = 0;
      while (
        placed.some(
          (item) =>
            Math.abs(item.x - x) < 18 &&
            Math.abs(item.y - (centroidY * scale + offset)) < 14,
        )
      ) {
        offset += 17;
      }
      offsets.set(stat.country, offset);
      placed.push({ x, y: centroidY * scale + offset });
    }
    return offsets;
  }, [stats, scale]);

  const tipStat = tip ? byCountry.get(tip.country) : undefined;

  /** 本地化国家名；`Intl.DisplayNames` 失败或环境不支持时回落到 ISO2。 */
  function countryName(code: string): string {
    return countryDisplayName(code, locale) ?? code;
  }

  /** 外环语义的文字版：tooltip 里必须能读到最差状态。 */
  function statusLabel(status: WorldNodeStatus): string {
    return t(
      status === "offline"
        ? "overview.serverHealth.mapStatusOffline"
        : status === "abnormal"
          ? "overview.serverHealth.mapStatusAbnormal"
          : "overview.serverHealth.mapStatusOnline",
    );
  }

  function openCountry(country: string) {
    navigate(`/servers?country=${country}`);
  }

  function showTip(
    country: string,
    target: Element,
    clientX?: number,
    clientY?: number,
  ) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wrapRect = wrap.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    const x = clientX ?? box.left + box.width / 2;
    const y = clientY ?? box.top + box.height / 2;
    // 最多 240px 宽的浮层，左右各留 120px，避免贴边被裁掉。
    const margin = Math.min(120, wrapRect.width / 2);
    const localX = Math.min(
      Math.max(x - wrapRect.left, margin),
      Math.max(margin, wrapRect.width - margin),
    );
    const localY = y - wrapRect.top;
    const below = localY < 104;
    setTip({
      country,
      x: localX,
      y: localY + (below ? 14 : -10),
      below,
    });
  }

  function onCountryEnter(
    event: MouseEvent<SVGGElement>,
    country: string,
  ) {
    setHovered(country);
    showTip(
      country,
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
  }

  function onCountryLeave() {
    setHovered(null);
    setTip(null);
  }

  function onCountryFocus(
    event: FocusEvent<SVGPathElement>,
    country: string,
  ) {
    setFocused(country);
    const dot = event.currentTarget.parentElement?.querySelector(
      "[data-world-map-dot]",
    );
    showTip(country, dot ?? event.currentTarget);
  }

  function onCountryBlur() {
    setFocused(null);
    setTip(null);
  }

  function onCountryKeyDown(
    event: KeyboardEvent<SVGPathElement>,
    country: string,
  ) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openCountry(country);
  }

  return (
    <Card data-world-map>
      <CardHeader>
        <CardTitle>{t("overview.serverHealth.mapTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          ref={wrapRef}
          className="relative w-full"
          data-world-map-canvas
        >
          <svg
            ref={svgRef}
            viewBox={VIEW_BOX}
            className="block h-auto w-full"
            aria-label={t("overview.serverHealth.mapAria")}
            data-world-map-svg
          >
            {Object.entries(COUNTRIES).map(([country, shape]) => {
              const stat = byCountry.get(country);
              if (!stat) {
                return (
                  <path
                    key={country}
                    d={shape.d}
                    fillRule="evenodd"
                    data-country={country}
                    data-tier="none"
                    // 海洋就是卡片底；无节点陆地用 muted-foreground/20，
                    // 在亮 / 暗两种卡片上都能看出轮廓（见截图 report）。
                    className="fill-muted-foreground/20 stroke-card"
                    strokeWidth={0.5}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              }
              const active = hovered === country || focused === country;
              const radius = worldNodeMarkerRadius(stat.tier) / scale;
              const [centroidX, centroidY] = shape.c;
              const ringClass = STATUS_RING_STROKE[stat.worst];
              const labelGap = ringClass
                ? MARKER_RING_LABEL_GAP_PX
                : MARKER_GAP_PX;
              const labelX = centroidX + radius + labelGap / scale;
              const labelY =
                centroidY + (labelOffsets.get(country) ?? 0) / scale;
              const labelFontSize = MARKER_LABEL_PX / scale;
              const labelStrokeWidth = 2 / scale;
              return (
                <g
                  key={country}
                  data-world-map-country={country}
                  onMouseEnter={(event) => onCountryEnter(event, country)}
                  onMouseLeave={onCountryLeave}
                  onClick={() => openCountry(country)}
                >
                  {focused === country ? (
                    <path
                      d={shape.d}
                      fill="none"
                      data-world-map-focus-ring
                      className="stroke-focus-ring"
                      strokeWidth={4}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  ) : null}
                  <path
                    d={shape.d}
                    fillRule="evenodd"
                    data-country={country}
                    data-tier={String(stat.tier)}
                    data-worst={stat.worst}
                    data-total={String(stat.total)}
                    role="button"
                    tabIndex={0}
                    aria-label={t("overview.serverHealth.mapCountryAria", {
                      country: countryName(country),
                      total: stat.total,
                      online: stat.online,
                      offline: stat.offline,
                      abnormal: stat.abnormal,
                    })}
                    className={cn(
                      "cursor-pointer outline-none transition-colors duration-150",
                      active ? TIER_HOVER_FILL[stat.tier] : TIER_FILL[stat.tier],
                      active ? "stroke-primary" : "stroke-primary/40",
                    )}
                    strokeWidth={active ? 1.5 : 0.5}
                    vectorEffect="non-scaling-stroke"
                    onKeyDown={(event) => onCountryKeyDown(event, country)}
                    onFocus={(event) => onCountryFocus(event, country)}
                    onBlur={onCountryBlur}
                  />
                  <g data-world-map-marker={country} aria-hidden="true">
                    {/* 圆点只表示「这里有节点」，状态全部交给外环。 */}
                    {ringClass ? (
                      <circle
                        data-world-map-ring={stat.worst}
                        cx={centroidX}
                        cy={centroidY}
                        r={radius + STATUS_RING_OFFSET_PX / scale}
                        className={cn("fill-none", ringClass)}
                        strokeWidth={STATUS_RING_STROKE_PX}
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : null}
                    <circle
                      data-world-map-dot
                      cx={centroidX}
                      cy={centroidY}
                      r={radius}
                      className="fill-primary stroke-card"
                      strokeWidth={MARKER_STROKE_PX}
                      vectorEffect="non-scaling-stroke"
                    />
                    {focused === country ? (
                      <circle
                        cx={centroidX}
                        cy={centroidY}
                        r={
                          radius +
                          (ringClass
                            ? MARKER_RING_FOCUS_GAP_PX
                            : MARKER_FOCUS_GAP_PX) /
                            scale
                        }
                        className="fill-none stroke-focus-ring"
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : null}
                    {stat.total >= 2 ? (
                      <text
                        data-world-map-count
                        x={labelX}
                        y={labelY}
                        fontSize={labelFontSize}
                        className="fill-primary font-medium"
                        stroke="var(--card)"
                        strokeWidth={labelStrokeWidth}
                        paintOrder="stroke"
                        dominantBaseline="central"
                        textAnchor="start"
                      >
                        {stat.total}
                      </text>
                    ) : null}
                  </g>
                </g>
              );
            })}
          </svg>

          {tip && tipStat ? (
            <div
              role="tooltip"
              data-world-map-tooltip
              className={cn(
                "pointer-events-none absolute z-10 w-max max-w-[240px] -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-lg/40",
                !tip.below && "-translate-y-full",
              )}
              style={{ left: tip.x, top: tip.y }}
            >
              <p className="text-xs font-medium">
                {countryName(tip.country)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                {t("overview.serverHealth.mapTooltipCount", {
                  total: tipStat.total,
                  online: tipStat.online,
                })}
              </p>
              <p
                data-world-map-tooltip-status
                className="mt-0.5 text-xs text-muted-foreground"
              >
                {t("overview.serverHealth.mapTooltipStatus", {
                  status: statusLabel(tipStat.worst),
                })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {tipStat.topNames.join(" · ")}
              </p>
            </div>
          ) : null}
        </div>

        <div
          data-world-map-legend
          className="mt-2 flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5 text-xs text-muted-foreground"
        >
          {/* 左段：档位只表示节点数，颜色 = 台数。 */}
          <span
            data-world-map-legend-tiers
            className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1.5"
          >
            <span
              data-world-map-legend-tiers-title
              className="font-medium whitespace-nowrap"
            >
              {t("overview.serverHealth.mapLegendTiersTitle")}
            </span>
            {TIER_RANGES.map((range, tier) => (
              <span
                key={range}
                data-world-map-legend-tier={tier}
                className="inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <span
                  aria-hidden="true"
                  className={cn("size-2.5 rounded-[2px]", TIER_BG[tier])}
                />
                {t("overview.serverHealth.mapLegendTier", { range })}
              </span>
            ))}
          </span>
          <span
            aria-hidden="true"
            className="hidden h-3 w-px shrink-0 bg-border sm:inline-block"
          />
          {/* 右段：实心圆点 = 有节点，外环 = 最差状态；在线无外环。 */}
          <span
            data-world-map-legend-status
            className="inline-flex flex-wrap items-center gap-x-3 gap-y-1.5"
          >
            <span
              data-world-map-legend-online
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <StatusLegendGlyph status="online" />
              {t("overview.serverHealth.mapLegendOnline")}
            </span>
            <span
              data-world-map-legend-offline
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <StatusLegendGlyph status="offline" />
              {t("overview.serverHealth.mapLegendOffline")}
            </span>
            <span
              data-world-map-legend-abnormal
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <StatusLegendGlyph status="abnormal" />
              {t("overview.serverHealth.mapLegendAbnormal")}
            </span>
          </span>
          {stats.length === 0 ? (
            <span data-world-map-empty>
              {t("overview.serverHealth.mapEmpty")}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
