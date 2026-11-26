import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { countryDisplayName } from "@/lib/country";
import { useServers } from "@/lib/queries";
import { cn } from "@/lib/utils";
import worldMapPaths from "@/lib/worldMapPaths.json";
import {
  worldNodeStats,
  worldNodeStatus,
} from "@/lib/worldNodeStats";
import { t, useI18n } from "@/i18n";

/** 4 档 fill；无节点国家单独用 `fill-muted`。 */
const TIER_FILL = [
  "fill-primary/15",
  "fill-primary/30",
  "fill-primary/50",
  "fill-primary/75",
] as const;
const TIER_BG = [
  "bg-primary/15",
  "bg-primary/30",
  "bg-primary/50",
  "bg-primary/75",
] as const;
const TIER_RANGES = ["1", "2–3", "4–6", "7+"] as const;

const PATHS: Record<string, string> = worldMapPaths;

interface TipState {
  country: string;
  x: number;
  y: number;
  below: boolean;
}

/**
 * 概览「资源状态」里的节点分布世界地图。
 *
 * 数据完全来自已缓存的 `useServers`（国家代码 + 状态），不额外请求接口；
 * SVG 路径由 `web/scripts/build-world-map.mjs` 在构建期生成。国家统计走
 * `worldNodeStats` 纯函数，组件只负责配色、tooltip 与跳转。
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
  const [tip, setTip] = useState<TipState | null>(null);

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
  const hasOffline = stats.some((stat) => stat.offline > 0);
  const hasAbnormal = stats.some((stat) => stat.abnormal > 0);
  const tipStat = tip ? byCountry.get(tip.country) : undefined;

  /** 本地化国家名；`Intl.DisplayNames` 失败或环境不支持时回落到 ISO2。 */
  function countryName(code: string): string {
    return countryDisplayName(code, locale) ?? code;
  }

  function openCountry(country: string) {
    navigate(`/servers?country=${country}`);
  }

  function showTip(
    country: string,
    target: SVGPathElement,
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
          className="relative mx-auto w-full max-w-[840px]"
          data-world-map-canvas
        >
          <svg
            viewBox="0 0 1000 500"
            className="block h-auto w-full"
            aria-label={t("overview.serverHealth.mapAria")}
            data-world-map-svg
          >
            {Object.entries(PATHS).map(([country, d]) => {
              const stat = byCountry.get(country);
              if (!stat) {
                return (
                  <path
                    key={country}
                    d={d}
                    fillRule="evenodd"
                    data-country={country}
                    data-tier="none"
                    className="fill-muted stroke-card"
                    strokeWidth={0.5}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              }
              return (
                <path
                  key={country}
                  d={d}
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
                    "cursor-pointer outline-none",
                    TIER_FILL[stat.tier],
                    "stroke-card",
                    stat.worst === "offline" && "stroke-destructive",
                    stat.worst === "abnormal" && "stroke-warning",
                    "focus-visible:stroke-ring focus-visible:stroke-[2.5]",
                  )}
                  strokeWidth={stat.worst === "online" ? 0.5 : 1.4}
                  vectorEffect="non-scaling-stroke"
                  onClick={() => openCountry(country)}
                  onKeyDown={(event) => onCountryKeyDown(event, country)}
                  onMouseEnter={(event) =>
                    showTip(
                      country,
                      event.currentTarget,
                      event.clientX,
                      event.clientY,
                    )
                  }
                  onMouseLeave={() => setTip(null)}
                  onFocus={(event) => showTip(country, event.currentTarget)}
                  onBlur={() => setTip(null)}
                />
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
              <p className="mt-1 text-xs text-muted-foreground">
                {tipStat.topNames.join(" · ")}
              </p>
            </div>
          ) : null}
        </div>

        <div
          data-world-map-legend
          className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground"
        >
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span
              aria-hidden="true"
              className="size-3 rounded-[3px] bg-muted"
            />
            {t("overview.serverHealth.mapLegendNone")}
          </span>
          {TIER_RANGES.map((range, tier) => (
            <span
              key={range}
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <span
                aria-hidden="true"
                className={cn("size-3 rounded-[3px]", TIER_BG[tier])}
              />
              {t("overview.serverHealth.mapLegendTier", { range })}
            </span>
          ))}
          {hasOffline ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span
                aria-hidden="true"
                className="size-3 rounded-[3px] border border-destructive"
              />
              {t("overview.serverHealth.mapLegendOffline")}
            </span>
          ) : null}
          {hasAbnormal ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span
                aria-hidden="true"
                className="size-3 rounded-[3px] border border-warning"
              />
              {t("overview.serverHealth.mapLegendAbnormal")}
            </span>
          ) : null}
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
