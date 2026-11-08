import { cn } from "@/lib/utils";

/**
 * 卡片里的一个指标：名称与百分比在上，进度条在中间，原始数字在下。
 * 与参考项目的 `Meter` 同构，只是保留了公开页需要的「未上报」空态。
 *
 * 负载不在这里：`load1` 没有可归一化的分母（API 不公开核数），
 * 所以卡片用原始值 + 「1 分钟平均」呈现，而不是编一个百分比。
 */
export function Meter({
  label,
  percent,
  foot,
  footTitle,
  emptyLabel,
}: {
  label: string;
  percent: number | null;
  foot: string;
  footTitle?: string;
  /** `percent` 为 `null` 时的占位文案。 */
  emptyLabel: string;
}) {
  const filled = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const severe = percent !== null && filled >= 90;
  const busy = percent !== null && filled >= 75;
  const percentText =
    percent === null
      ? "—"
      : `${filled < 10 ? filled.toFixed(1) : filled.toFixed(0)}%`;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        <span
          className={cn(
            "tnum shrink-0 text-xs font-medium",
            percent === null
              ? "text-muted-foreground"
              : severe
                ? "text-destructive"
                : busy
                  ? "text-warning"
                  : "text-foreground",
          )}
        >
          {percentText}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent === null
          ? { "aria-valuetext": emptyLabel }
          : {
              "aria-valuenow": Math.round(filled),
              "aria-valuetext": percentText,
            })}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted-foreground/20"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200",
            filled > 0 && "min-w-[3px]",
            severe
              ? "bg-destructive"
              : busy
                ? "bg-warning"
                : "bg-primary",
          )}
          style={{ width: `${filled}%` }}
        />
      </div>
      <div
        className="tnum mt-1.5 truncate text-xs text-muted-foreground"
        title={footTitle ?? foot}
      >
        {foot}
      </div>
    </div>
  );
}
