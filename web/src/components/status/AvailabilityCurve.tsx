import {
  useId,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useI18n } from "@/i18n";
import type { PublicStatusServer } from "@/lib/api";
import { AVAILABILITY_BAR_CLASS } from "@/components/status/Availability";
import {
  availabilityPercentText,
  availabilityTone,
  type AvailabilityTone,
} from "@/lib/publicStatus";
import { formatHourRange } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * 24 小时可用率曲线：0–100% 纵轴 + 时间横轴，step line + area。
 *
 * 高度只编码「有采样」的在线比例；**null 不参与高度映射**：缺失小时画成
 * 全高斜线竖列，既不连线也不填充，避免把「没有数据」画成 100%。
 * 0% 落在基线上（有 1.5px 的线，可见），不会被误读成没有采样。
 *
 * 相邻采样才连线；缺口两侧不画水平线，也不画跨缺口的竖线。
 * 颜色按三档：≥99 primary、95–99 warning、<95 destructive；
 * 全 100% 时只剩 primary + 很淡的 area，保持安静。
 */

const HOURS = 24;
const Y_TOP = 4;
const Y_BOTTOM = 96;
/** 方案 1：曲线固定 112px，纵轴只保留 100 / 50 / 0 三档。 */
const PLOT_HEIGHT_CLASS = "h-[112px]";
const Y_TICKS = [100, 50, 0] as const;
/** 时间刻度：0 / 6 / 12 / 18 小时；<sm 只显示 0 / 12 与「现在」。 */
const TICK_INDICES = [0, 6, 12, 18] as const;
const MOBILE_HIDDEN_TICKS: ReadonlySet<number> = new Set([6, 18]);

const TONE_LINE: Record<AvailabilityTone, string> = {
  ok: "text-primary",
  warn: "text-warning",
  down: "text-destructive",
  unknown: "text-muted-foreground",
};

/** 面积填充透明度：健康态最淡，故障态略深但不铺满高饱和红色。 */
const TONE_AREA: Record<AvailabilityTone, number> = {
  ok: 0.06,
  warn: 0.09,
  down: 0.12,
  unknown: 0,
};

function clampRatio(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function yFor(ratio: number): number {
  return Y_TOP + (1 - ratio) * (Y_BOTTOM - Y_TOP);
}

function toneForRatio(ratio: number): AvailabilityTone {
  return availabilityTone(ratio);
}

function toneLabelKey(tone: AvailabilityTone): string {
  switch (tone) {
    case "ok":
      return "publicStatus.detail.legend.ok";
    case "warn":
      return "publicStatus.detail.legend.warn";
    case "down":
      return "publicStatus.detail.legend.down";
    case "unknown":
      return "publicStatus.detail.legend.none";
  }
}

export function AvailabilityCurve({
  server,
  generatedAt,
}: {
  server: PublicStatusServer;
  /** 没有桶 ts 时的锚点（公开响应的 generated_at），避免在 render 里读 Date.now。 */
  generatedAt: number;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const tooltipId = `pw-curve-tip-${uid}`;

  const source = Array.isArray(server.buckets_24h) ? server.buckets_24h : [];
  const buckets = Array.from(
    { length: HOURS },
    (_, index) => source[index] ?? null,
  );

  // null 桶没有 ts；用最近一个有 ts 的桶按小时推回来，让横轴与 tooltip
  // 对缺失小时也有时间位置。
  let anchorIndex = -1;
  let anchorTs: number | null = null;
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (bucket && Number.isFinite(bucket.ts)) {
      anchorIndex = index;
      anchorTs = bucket.ts;
      break;
    }
  }
  // 24 个桶全是 null 时没有 ts；用当前时刻作为最后一个桶的锚点，
  // 横轴仍然有 5 个真实时间，而不是一排「—」。
  if (anchorTs === null) {
    anchorIndex = HOURS - 1;
    anchorTs = generatedAt;
  }
  const tsAt = (index: number): number =>
    anchorTs + (index - anchorIndex) * 3_600;

  const ratios = buckets.map((bucket) =>
    clampRatio(bucket?.online_ratio ?? null),
  );
  const sampledCount = ratios.filter((ratio) => ratio !== null).length;
  const lastSampledIndex = (() => {
    for (let index = HOURS - 1; index >= 0; index -= 1) {
      if (ratios[index] !== null) return index;
    }
    return HOURS - 1;
  })();

  const activeRatio = active === null ? null : ratios[active];
  const activeTone =
    activeRatio === null ? "unknown" : toneForRatio(activeRatio);
  const activePercent =
    activeRatio === null ? null : availabilityPercentText(activeRatio);
  const activeCenter = active === null ? 50 : ((active + 0.5) / HOURS) * 100;
  const tooltipTransform =
    activeCenter < 15
      ? "translateX(0)"
      : activeCenter > 85
        ? "translateX(-100%)"
        : "translateX(-50%)";

  const moveActive = (delta: -1 | 1) => {
    setActive((current) => {
      const start = current ?? lastSampledIndex;
      return Math.min(HOURS - 1, Math.max(0, start + delta));
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "Escape") setActive(null);
  };

  const indexFromClientX = (clientX: number, element: HTMLDivElement): number => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = Math.min(
      0.999,
      Math.max(0, (clientX - rect.left) / rect.width),
    );
    return Math.floor(ratio * HOURS);
  };

  const indexFromPointer = (event: PointerEvent<HTMLDivElement>): number =>
    indexFromClientX(event.clientX, event.currentTarget);

  // <sm 只保留首 / 中 / 现在三个时间刻度（5 → 3）：plot 不变，hover /
  // 键盘读数仍按 24 个小时桶取，隐藏的只是刻度文字。
  const tickLabels = TICK_INDICES.map((index) => {
    const ts = tsAt(index);
    const range = formatHourRange(ts);
    return range === "—" ? range : range.slice(0, 5);
  });

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground">
          {t("publicStatus.detail.sections.availability")}
        </h2>
        <span className="tnum text-[11px] text-muted-foreground">
          {t("publicStatus.detail.samples", {
            sampled: sampledCount,
            total: HOURS,
          })}
        </span>
      </div>

      <div className="mt-2.5 flex gap-2">
        {/* 0–100% 纵轴：只保留 100 / 50 / 0，避免 112px 里挤 5 条标签。 */}
        <div
          data-slot="availability-yaxis"
          aria-hidden="true"
          className="relative w-7 shrink-0 text-[11px] text-muted-foreground"
        >
          {Y_TICKS.map((value) => (
            <span
              key={value}
              data-tick={value}
              className="absolute right-0 -translate-y-1/2"
              style={{ top: `${yFor(value / 100)}%` }}
            >
              {value}%
            </span>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div
            data-slot="availability-plot"
            role="img"
            tabIndex={0}
            aria-label={t("publicStatus.detail.availabilityAria", {
              name: server.name,
            })}
            aria-describedby={active === null ? undefined : tooltipId}
            className={cn(
              "relative w-full touch-pan-y border-b border-border select-none",
              PLOT_HEIGHT_CLASS,
            )}
            onPointerDown={(event) => {
              setActive(indexFromPointer(event));
            }}
            onPointerMove={(event) => {
              if (event.pointerType !== "mouse") return;
              setActive(indexFromPointer(event));
            }}
            onTouchStart={(event) => {
              const touch = event.touches[0];
              if (touch) {
                setActive(indexFromClientX(touch.clientX, event.currentTarget));
              }
            }}
            onClick={(event) => {
              setActive(indexFromClientX(event.clientX, event.currentTarget));
            }}
            onPointerLeave={() => {
              if (!focused) setActive(null);
            }}
            onFocus={(event) => {
              setFocused(true);
              // 触摸点按也会让 plot 获得 focus；只有键盘 focus-visible 才
              // 默认跳到最后一个采样，否则会覆盖刚点中的小时。
              if (event.currentTarget.matches(":focus-visible")) {
                setActive((current) => current ?? lastSampledIndex);
              }
            }}
            onBlur={() => {
              setFocused(false);
              setActive(null);
            }}
            onKeyDown={onKeyDown}
          >
            {/* 50 / 100% 网格线（0% 用 plot 的下边框当基线） */}
            {[50, 100].map((value) => (
              <span
                key={value}
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 border-t border-border/60"
                style={{ top: `${yFor(value / 100)}%` }}
              />
            ))}

            {/* 缺失小时：斜线竖列，不参与高度编码 */}
            {ratios.map((ratio, index) =>
              ratio === null ? (
                <span
                  key={`missing-${index}`}
                  data-slot="availability-missing"
                  data-index={index}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0"
                  style={{
                    left: `${(index / HOURS) * 100}%`,
                    width: `${100 / HOURS}%`,
                    backgroundImage:
                      "repeating-linear-gradient(45deg, color-mix(in oklab, var(--muted-foreground) 32%, transparent) 0 1px, transparent 1px 5px)",
                  }}
                />
              ) : null,
            )}

            <svg
              aria-hidden="true"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            >
              {/* 面积：每个有采样的小时一段，顶部是 step，底部到 0% 基线 */}
              {ratios.map((ratio, index) => {
                if (ratio === null) return null;
                const y = yFor(ratio);
                return (
                  <rect
                    key={`area-${index}`}
                    data-slot="availability-area"
                    data-index={index}
                    x={(index / HOURS) * 100}
                    y={y}
                    width={100 / HOURS}
                    height={Y_BOTTOM - y}
                    fill="currentColor"
                    opacity={TONE_AREA[toneForRatio(ratio)]}
                    className={TONE_LINE[toneForRatio(ratio)]}
                  />
                );
              })}

              {/* 横段：每个有采样的小时一条；相邻采样才在边界画竖线 */}
              {ratios.map((ratio, index) => {
                if (ratio === null) return null;
                const y = yFor(ratio);
                return (
                  <line
                    key={`step-${index}`}
                    data-slot="availability-step"
                    data-index={index}
                    data-ratio={ratio}
                    data-tone={toneForRatio(ratio)}
                    x1={(index / HOURS) * 100}
                    x2={((index + 1) / HOURS) * 100}
                    y1={y}
                    y2={y}
                    stroke="currentColor"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    className={TONE_LINE[toneForRatio(ratio)]}
                  />
                );
              })}

              {ratios.map((ratio, index) => {
                if (index === 0 || ratio === null) return null;
                const previous = ratios[index - 1];
                if (previous === null) return null;
                const y1 = yFor(previous);
                const y2 = yFor(ratio);
                if (y1 === y2) return null;
                const worse = Math.min(previous, ratio);
                return (
                  <line
                    key={`transition-${index}`}
                    data-slot="availability-transition"
                    data-from={index - 1}
                    data-to={index}
                    x1={(index / HOURS) * 100}
                    x2={(index / HOURS) * 100}
                    y1={y1}
                    y2={y2}
                    stroke="currentColor"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    className={TONE_LINE[toneForRatio(worse)]}
                  />
                );
              })}
            </svg>

            {/* 现在：最后一段的右边界 */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-px bg-primary/50"
            />

            {/* crosshair + tooltip */}
            {active === null ? null : (
              <>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 w-px bg-muted-foreground/50"
                  style={{ left: `${activeCenter}%` }}
                />
                {activeRatio === null ? null : (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
                    style={{
                      left: `${activeCenter}%`,
                      top: `${yFor(activeRatio)}%`,
                    }}
                  />
                )}
                <div
                  id={tooltipId}
                  aria-live="polite"
                  aria-atomic="true"
                  data-slot="availability-tooltip"
                  className="pointer-events-none absolute bottom-full z-10 mb-2 rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] leading-tight whitespace-nowrap text-popover-foreground shadow-lg/40"
                  style={{
                    left: `${activeCenter}%`,
                    transform: tooltipTransform,
                  }}
                >
                  <div className="tnum text-muted-foreground">
                    {formatHourRange(tsAt(active))}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 rounded-full",
                        AVAILABILITY_BAR_CLASS[activeTone],
                      )}
                    />
                    <span className="tnum">
                      {activePercent === null
                        ? t("publicStatus.detail.noSample")
                        : `${activePercent}%`}
                    </span>
                    {activePercent === null ? null : (
                      <span className="text-muted-foreground">
                        {t(toneLabelKey(activeTone))}
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          <div
            aria-hidden="true"
            className="mt-1.5 flex justify-between text-[11px] leading-none text-muted-foreground"
          >
            {TICK_INDICES.map((tick, index) => (
              <span
                key={`tick-${tick}`}
                data-tick-index={tick}
                className={cn(
                  "tnum",
                  MOBILE_HIDDEN_TICKS.has(tick) && "max-sm:hidden",
                )}
              >
                {tickLabels[index]}
              </span>
            ))}
            <span>{t("publicStatus.detail.now")}</span>
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 leading-tight">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {[
            ["ok", AVAILABILITY_BAR_CLASS.ok],
            ["warn", AVAILABILITY_BAR_CLASS.warn],
            ["down", AVAILABILITY_BAR_CLASS.down],
          ].map(([tone, className]) => (
            <span key={tone} className="inline-flex items-center gap-1">
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", className)}
              />
              {t(toneLabelKey(tone as AvailabilityTone))}
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-[1px]"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(45deg, color-mix(in oklab, var(--muted-foreground) 45%, transparent) 0 1px, transparent 1px 4px)",
              }}
            />
            {t("publicStatus.detail.legend.none")}
          </span>
        </div>

      </div>

      {/* 读屏逐小时文本；视觉隐藏，但每个小时的区间 / 比例 / 状态都可取。 */}
      <ul className="sr-only">
        {buckets.map((_bucket, index) => {
          const ratio = ratios[index];
          const percent =
            ratio === null ? null : availabilityPercentText(ratio);
          return (
            <li key={`sr-${index}`}>
              {`${formatHourRange(tsAt(index))} · ${
                percent === null
                  ? t("publicStatus.detail.noSample")
                  : `${percent}%`
              }${
                ratio === null
                  ? ""
                  : ` · ${t(toneLabelKey(toneForRatio(ratio)))}`
              }`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
