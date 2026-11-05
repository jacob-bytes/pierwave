import { formatBytes, usagePercent } from "@/lib/format";
import { cn } from "@/lib/utils";

interface UsageBarProps {
  usedBytes: number;
  quotaBytes: number | null | undefined;
  /** 套餐实例的 quota_override=0 表示显式不限。 */
  zeroAsUnlimited?: boolean;
  /** 表格里列头已经写了「流量」时传 null。 */
  label?: string | null;
  className?: string;
}

export function UsageBar({
  usedBytes,
  quotaBytes,
  zeroAsUnlimited = false,
  label = "流量",
  className,
}: UsageBarProps) {
  const quota =
    zeroAsUnlimited && quotaBytes === 0 ? null : (quotaBytes ?? null);
  const percent = usagePercent(usedBytes, quota);
  const overQuota = quota !== null && quota > 0 && usedBytes >= quota;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div
        className={cn(
          "flex items-center gap-3 text-xs",
          label ? "justify-between" : "justify-start",
        )}
      >
        {label ? <span className="text-muted-foreground">{label}</span> : null}
        <span className="font-mono text-foreground/80">
          {formatBytes(usedBytes)} /{" "}
          {formatBytes(quotaBytes, { zeroAsUnlimited })}
        </span>
      </div>
      {percent === null ? null : (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-200",
              overQuota ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}
