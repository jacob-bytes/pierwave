import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatMbps, isSpeedLimited } from "@/lib/speed";
import { t } from "@/i18n";

interface SpeedLimitBadgeProps {
  kbps: number | null | undefined;
  /**
   * 套餐限速只能映射 Xray `bufferSize`，是近似值；节点限速是 tc 精确上限。
   * 文案与 title 都据此切换，避免把两者的确定性说成一样。
   */
  approximate?: boolean;
  className?: string;
}

/** 列表里的「限速 100M」小徽标；未限速（0 / null）时不渲染。 */
export function SpeedLimitBadge({
  kbps,
  approximate = false,
  className,
}: SpeedLimitBadgeProps) {
  if (!isSpeedLimited(kbps)) return null;

  const mbps = formatMbps(kbps);
  const prefix = approximate ? "packages" : "nodes";

  return (
    <Badge
      variant="outline"
      title={t(`${prefix}.speedLimit.badgeTitle`, { mbps })}
      className={cn(
        "shrink-0 font-mono text-[11px] font-normal text-muted-foreground",
        className,
      )}
    >
      {t(`${prefix}.speedLimit.badge`, { mbps })}
    </Badge>
  );
}
