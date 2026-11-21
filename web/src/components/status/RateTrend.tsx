import { useI18n } from "@/i18n";
import type { PublicStatusSeries } from "@/lib/api";
import { heroRateSeries } from "@/lib/heroSeries";
import { multiSparkGeometry } from "@/lib/sparkline";
import { cn } from "@/lib/utils";

/**
 * ① 当前速率下方的 24 点迷你趋势（20px 高，无坐标轴 / 网格 / 图例）。
 *
 * 数据来自后端新字段 `series_24h`（1 小时粒度，窗口 24h）。旧后端没有该
 * 字段、或整段没有有效读数时**整条隐藏** —— 这里不画「数据收集中」，
 * 因为 ① 已经有可用率曲线，多一行空态只会挤占 KPI。
 *
 * null 是缺口，不是 0：`multiSparkGeometry` 会抬笔断线并保留 x 位置，
 * 真实的 0 才贴底。上下行共用零基线，两条线可以直接比较斜率。
 */

const WIDTH = 160;
const HEIGHT = 20;

export function RateTrend({
  series,
  className,
}: {
  series: PublicStatusSeries | null | undefined;
  className?: string;
}) {
  const { t } = useI18n();
  const rate = heroRateSeries(series);
  const geometry = rate
    ? multiSparkGeometry(
        [{ values: rate.rx, area: true }, { values: rate.tx }],
        WIDTH,
        HEIGHT,
        { zeroBased: true, minPoints: 2, minNonZeroGap: 2 },
      )
    : null;

  if (!geometry || !geometry.series.some((line) => line.path !== null)) {
    return null;
  }

  return (
    <div
      role="img"
      aria-label={t("publicStatus.detail.rateTrend")}
      data-slot="detail-rate-trend"
      className={cn("relative h-5 w-full", className)}
    >
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-full w-full overflow-visible"
      >
        {geometry.series.map((line, index) =>
          line.area === null ? null : (
            <path
              key={`area-${index}`}
              d={line.area}
              fill="currentColor"
              opacity={0.08}
              stroke="none"
              className="text-primary"
            />
          ),
        )}
        {geometry.series.map((line, index) =>
          line.path === null ? null : (
            <path
              key={`line-${index}`}
              d={line.path}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className={index === 0 ? "text-primary" : "text-muted-foreground"}
            />
          ),
        )}
      </svg>
    </div>
  );
}
