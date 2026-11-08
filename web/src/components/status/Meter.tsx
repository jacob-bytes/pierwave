import {
  AVAILABILITY_BAR_CLASS,
  AVAILABILITY_TEXT_CLASS,
} from "@/components/status/Availability";
import type { AvailabilityTone } from "@/lib/publicStatus";
import { cn } from "@/lib/utils";

/**
 * 卡片里的一个指标：标签与数值一行（左标签、右加粗数值），4px 细进度条，
 * 条下是原始值小字。与参考项目的 `Meter` 同构。
 *
 * 两种形态：
 * - `percent`：有分母的百分比（内存、硬盘、可用率）；
 * - `value`：没有分母的原始值（1 分钟负载）。此时不画进度条 —— 公开 API
 *   不提供核数，编一个百分比比不画更糟；空出的 4px 用等高占位撑住，
 *   让同一行两块指标的底部原始值仍然对齐。
 *
 * 可用率越低越差，不能套用资源占用「越高越红」的阈值，所以由调用方用
 * `tone` 指定色阶，与图例、24 格条共用同一份映射。
 */
export function Meter({
  label,
  percent,
  value,
  foot,
  footTitle,
  emptyLabel,
  tone,
  muted,
}: {
  label: string;
  /** 0..100；`null` 表示没有采样。与 `value` 二选一。 */
  percent?: number | null;
  /** 直接展示的原始值（负载）；提供时不画进度条。 */
  value?: string;
  foot: string;
  footTitle?: string;
  /** `percent` 为 `null` 时的占位文案。 */
  emptyLabel: string;
  tone?: AvailabilityTone;
  /** 数值本身是占位符（例如「—」）时用次要色，不冒充真实读数。 */
  muted?: boolean;
}) {
  const hasValue = value !== undefined;
  const missing = !hasValue && (percent === null || percent === undefined);
  const filled =
    percent === null || percent === undefined
      ? 0
      : Math.min(100, Math.max(0, percent));
  const severe = !missing && !tone && filled >= 90;
  const busy = !missing && !tone && filled >= 75;
  const percentText = missing
    ? "—"
    : `${filled < 10 ? filled.toFixed(1) : filled.toFixed(0)}%`;
  const display = hasValue ? value : percentText;

  const valueClass = muted
    ? "text-muted-foreground"
    : hasValue
      ? "text-foreground"
      : missing
        ? "text-muted-foreground"
        : tone
          ? AVAILABILITY_TEXT_CLASS[tone]
          : severe
            ? "text-destructive"
            : busy
              ? "text-warning"
              : "text-foreground";

  const fillClass = tone
    ? AVAILABILITY_BAR_CLASS[tone]
    : severe
      ? "bg-destructive"
      : busy
        ? "bg-warning"
        : "bg-primary";

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        <span
          className={cn("tnum shrink-0 text-xs font-semibold", valueClass)}
        >
          {display}
        </span>
      </div>

      {hasValue ? (
        // 等高占位：负载没有进度条，但同一行另一块的条下原始值必须对齐。
        <div className="mt-2 h-1" aria-hidden="true" />
      ) : (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(missing
            ? { "aria-valuetext": emptyLabel }
            : {
                "aria-valuenow": Math.round(filled),
                "aria-valuetext": percentText,
              })}
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted-foreground/20"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-200",
              // 0.2% 的填充不到一个像素，浏览器会画成看不见的毛边；
              // 给一个 3px 下限，让「几乎没有」至少还是「有一点」。
              filled > 0 && "min-w-[3px]",
              fillClass,
            )}
            style={{ width: `${filled}%` }}
          />
        </div>
      )}

      <div
        className="tnum mt-1.5 truncate text-xs text-muted-foreground"
        title={footTitle ?? foot}
      >
        {foot}
      </div>
    </div>
  );
}
