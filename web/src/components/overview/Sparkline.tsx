import { useI18n } from "@/i18n";
import type { OverviewRatePoint } from "@/lib/api";
import { sparklineGeometry } from "@/lib/sparkline";
import { cn } from "@/lib/utils";

/** mini 折线的 viewBox；实际显示宽度由容器决定（preserveAspectRatio=none）。 */
const WIDTH = 72;
const HEIGHT = 24;

/**
 * Top 服务器行里的网速 mini 折线。
 *
 * - 下行（rx）实线用主色，上行（tx）虚线用次要文字色，不新增色相；
 * - 无坐标轴、无 tooltip、无图例：只用线型表达趋势，数值由同行文字给；
 * - 采样不足（有效点 < 3）时整块换成 `—`，不画一条假的平线。
 *
 * 几何计算在 `lib/sparkline.ts`，这里只负责 token 与 a11y 文案。
 */
export function RateSparkline({
  name,
  points,
  className,
}: {
  name: string;
  points: OverviewRatePoint[] | undefined;
  className?: string;
}) {
  const { t } = useI18n();
  const geometry = sparklineGeometry(points, WIDTH, HEIGHT);

  if (!geometry || (!geometry.rx && !geometry.tx)) {
    return (
      <span
        role="img"
        aria-label={t("overview.sparklineEmpty")}
        title={t("overview.sparklineEmpty")}
        className={cn(
          "w-[72px] shrink-0 text-right text-xs text-muted-foreground",
          className,
        )}
      >
        —
      </span>
    );
  }

  return (
    <svg
      role="img"
      aria-label={t("overview.sparklineAria", { name })}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={cn(
        "h-6 w-[72px] shrink-0 overflow-visible text-primary",
        className,
      )}
    >
      {geometry.rx ? (
        <path
          d={geometry.rx}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {geometry.tx ? (
        <path
          d={geometry.tx}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeDasharray="2 2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          className="text-muted-foreground"
        />
      ) : null}
    </svg>
  );
}
