import { formatBytes, usagePercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

export type UsageTone = "primary" | "warning" | "destructive";

const TONE_FILL: Record<UsageTone, string> = {
  primary: "bg-primary",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

/**
 * 进度条本体（轨道 + 填充）。`UsageBar` 与用户端概览卡共用这一份，
 * 概览卡只是把「已用 / 总量」挪到条的右侧，不另写一套颜色与动效。
 */
export function UsageTrack({
  percent,
  tone = "primary",
  label,
  className,
}: {
  /** 0..100，调用方负责夹紧。 */
  percent: number;
  tone?: UsageTone;
  /** 无障碍名称；省略时仍保留 progressbar 角色。 */
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-200",
          TONE_FILL[tone],
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

interface UsageBarProps {
  usedBytes: number;
  quotaBytes: number | null | undefined;
  /** 套餐实例的 quota_override=0 表示显式不限。 */
  zeroAsUnlimited?: boolean;
  /** 表格里列头已经写了「流量」时传 null。 */
  label?: string | null;
  /** 超额时的颜色；默认 destructive，用户自助概览用 warning。 */
  overTone?: "destructive" | "warning";
  /** 数字行是否靠右：数值列统一 `end`，卡片/详情保持默认 `start`。 */
  align?: "start" | "end";
  className?: string;
}

export function UsageBar({
  usedBytes,
  quotaBytes,
  zeroAsUnlimited = false,
  label = t("usage.label"),
  overTone = "destructive",
  align = "start",
  className,
}: UsageBarProps) {
  const quota =
    zeroAsUnlimited && quotaBytes === 0 ? null : (quotaBytes ?? null);
  const percent = usagePercent(usedBytes, quota);
  const overQuota = quota !== null && quota > 0 && usedBytes >= quota;

  return (
    <div
      className={cn(
        "space-y-1.5",
        // 数值列：整块（数字 + 进度条）贴右，进度条不会悬在列中间。
        align === "end" && "ml-auto",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center gap-3 text-xs",
          label
            ? "justify-between"
            : align === "end"
              ? "justify-end"
              : "justify-start",
        )}
      >
        {label ? <span className="text-muted-foreground">{label}</span> : null}
        <span className="font-mono tabular-nums text-foreground/80">
          {formatBytes(usedBytes)} /{" "}
          {formatBytes(quotaBytes, { zeroAsUnlimited })}
        </span>
      </div>
      {percent === null ? null : (
        <UsageTrack
          percent={percent}
          tone={overQuota ? overTone : "primary"}
        />
      )}
    </div>
  );
}
