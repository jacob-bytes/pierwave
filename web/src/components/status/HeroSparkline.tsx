import { useId, useState, type PointerEvent } from "react";
import { AVAILABILITY_TEXT_CLASS } from "@/components/status/Availability";
import { useI18n } from "@/i18n";
import type {
  HeroLineSeries,
  HeroRateSeries,
  NullableSeries,
} from "@/lib/heroSeries";
import { formatRate } from "@/lib/netRate";
import {
  availabilityPercent,
  type AvailabilityTone,
} from "@/lib/publicStatus";
import { multiSparkGeometry } from "@/lib/sparkline";
import { formatClockTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * hero 三个 KPI 下方的迷你图。
 *
 * 视觉克制是硬要求：线宽 1.5px、无坐标轴 / 网格 / 图例，只有一条零基线
 * 面积的淡渐变（速率图）。数值仍然由上方的大数字给，图只表达「趋势」。
 *
 * 空态与断线：
 * - 没有数据（旧后端没有 `series`，或整段全是 null）→ 虚线基线 +「数据收集中」，
 *   **不画一条 0 的平线**；
 * - 部分 null → 抬笔断线，x 位置保留，时间轴不被压缩；
 * - 真实 0 → 贴底画线，和「没有数据」严格区分。
 *
 * 悬停稿只做读数，不做筛选 / 联动：一张 48px 高的图不该承载第二种交互。
 */

/** viewBox 宽度；实际显示宽度由容器决定（`preserveAspectRatio="none"`）。 */
const WIDTH = 240;
/** viewBox 高度；CSS 高度 40px（手机）/ 48px（桌面）。 */
const HEIGHT = 48;

type HeroSparklineProps =
  | {
      kind: "rate";
      data: HeroRateSeries;
      className?: string;
    }
  | {
      kind: "latency" | "uptime";
      data: HeroLineSeries;
      /** 可用率图跟随大数字的色阶（ok / warn / down / unknown）。 */
      tone?: AvailabilityTone;
      className?: string;
    };

function chartAriaKey(kind: HeroSparklineProps["kind"]): string {
  switch (kind) {
    case "rate":
      return "publicStatus.hero.rateChart";
    case "latency":
      return "publicStatus.hero.latencyChart";
    case "uptime":
      return "publicStatus.hero.uptimeChart";
  }
}

/** 悬停读数：手机上不出现（没有 hover），桌面用极简两行。 */
function HeroTooltip({
  kind,
  index,
  count,
  ts,
  values,
  rx,
  tx,
}: {
  kind: HeroSparklineProps["kind"];
  index: number;
  /** 采样点总数（与画线的 x 位置一致）。 */
  count: number;
  ts: NullableSeries;
  values: NullableSeries;
  rx: NullableSeries;
  tx: NullableSeries;
}) {
  const { t } = useI18n();
  const time = formatClockTime(ts[index]);

  const rows: { label: string; text: string }[] = [];
  if (kind === "rate") {
    rows.push(
      {
        label: t("publicStatus.server.trafficRx"),
        text: formatRate(rx[index]) ?? "—",
      },
      {
        label: t("publicStatus.server.trafficTx"),
        text: formatRate(tx[index]) ?? "—",
      },
    );
  } else {
    const value = values[index];
    const text =
      kind === "latency"
        ? value === null
          ? "—"
          : `${Math.round(value)} ms`
        : value === null
          ? "—"
          : `${availabilityPercent(value) ?? "—"}%`;
    rows.push({
      label: t(
        kind === "latency"
          ? "publicStatus.hero.averageLatency"
          : "publicStatus.hero.averageUptime",
      ),
      text,
    });
  }

  return (
    <div
      aria-hidden="true"
      data-slot="hero-sparkline-tooltip"
      className="pointer-events-none absolute bottom-full z-10 mb-1.5 min-w-24 rounded-md border border-border bg-popover px-2 py-1.5 text-[10px] leading-tight whitespace-nowrap text-popover-foreground shadow-lg/40"
      style={{
        left: `${(index / Math.max(1, count - 1)) * 100}%`,
        transform:
          index / Math.max(1, count - 1) < 0.15
            ? "translateX(0)"
            : index / Math.max(1, count - 1) > 0.85
              ? "translateX(-100%)"
              : "translateX(-50%)",
      }}
    >
      {time === "—" ? null : (
        <div className="tnum mb-1 text-muted-foreground">{time}</div>
      )}
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-3"
          >
            <span className="text-muted-foreground">{row.label}</span>
            <span className="tnum">{row.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HeroSparkline(props: HeroSparklineProps) {
  const { t } = useI18n();
  const [active, setActive] = useState<number | null>(null);
  // 同一个页面理论上只有一个速率图；`useId` 仍然保证多实例时渐变不串。
  const gradientId = `pw-hero-spark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const { kind } = props;
  const rate = kind === "rate" ? props.data : null;
  const line = kind === "rate" ? null : props.data;
  const ts = props.data.ts;
  const values: NullableSeries = line?.values ?? [];
  const rx: NullableSeries = rate?.rx ?? [];
  const tx: NullableSeries = rate?.tx ?? [];
  const length = Math.max(ts.length, values.length, rx.length, tx.length);

  // 速率图共用零基线（面积填充需要 0），延迟 / 可用率自适应纵轴，
  // 否则 97%–100% 这种窄区间会被压成一条直线。
  const geometry = multiSparkGeometry(
    kind === "rate"
      ? [
          { values: rx, area: true },
          { values: tx },
        ]
      : [{ values }],
    WIDTH,
    HEIGHT,
    {
      zeroBased: kind === "rate",
      // 可用率有绝对上限：固定 0–100%，100% 永远贴顶，不把 96% 与 98%
      // 的差别放大成满屏锯齿（延迟没有这种上限，仍用自适应）。
      ...(kind === "uptime" ? { domain: [0, 1] as const } : {}),
      minPoints: 2,
    },
  );
  const drawn = geometry?.series.some((line) => line.path !== null) ?? false;

  if (!geometry || !drawn) {
    return (
      <div
        role="img"
        aria-label={t("publicStatus.hero.chartEmpty")}
        data-slot="hero-sparkline"
        data-kind={kind}
        data-state="empty"
        className={cn(
          "relative flex h-10 w-full items-center justify-center md:h-12",
          props.className,
        )}
      >
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-1/2 border-t border-dashed border-border"
        />
        <span className="relative bg-card px-1.5 text-[10px] leading-none text-muted-foreground">
          {t("publicStatus.hero.chartEmpty")}
        </span>
      </div>
    );
  }

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    // 只响应鼠标悬停；触摸滑动留给页面滚动，不抢手势。
    if (event.pointerType !== "mouse" || length < 2) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    const next = Math.round(ratio * (length - 1));
    setActive((current) => (current === next ? current : next));
  };

  const uptimeTone = props.kind === "uptime" ? (props.tone ?? "unknown") : null;
  const lineClass = (index: number) => {
    if (kind === "rate") {
      return index === 0 ? "text-primary" : "text-muted-foreground";
    }
    if (kind === "latency") return "text-primary";
    return AVAILABILITY_TEXT_CLASS[uptimeTone ?? "unknown"];
  };

  return (
    <div
      className={cn("relative h-10 w-full md:h-12", props.className)}
      data-slot="hero-sparkline"
      data-kind={kind}
      data-state="ready"
    >
      <svg
        role="img"
        aria-label={t(chartAriaKey(kind))}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-full w-full overflow-visible"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setActive(null)}
      >
        {kind === "rate" ? (
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--primary)"
                stopOpacity="0.22"
              />
              <stop
                offset="100%"
                stopColor="var(--primary)"
                stopOpacity="0"
              />
            </linearGradient>
          </defs>
        ) : null}

        {geometry.series.map((line, index) =>
          line.area ? (
            <path
              key={`area-${index}`}
              d={line.area}
              fill={`url(#${gradientId})`}
              stroke="none"
            />
          ) : null,
        )}

        {geometry.series.map((line, index) =>
          line.path === null ? null : (
            <path
              key={`line-${index}`}
              d={line.path}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={
                kind === "rate" && index === 1 ? "3 3" : undefined
              }
              vectorEffect="non-scaling-stroke"
              className={lineClass(index)}
            />
          ),
        )}
      </svg>

      {active === null ? null : (
        <HeroTooltip
          kind={kind}
          index={active}
          count={length}
          ts={ts}
          values={values}
          rx={rx}
          tx={tx}
        />
      )}
    </div>
  );
}
