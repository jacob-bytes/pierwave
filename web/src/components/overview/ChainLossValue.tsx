import {
  chainLossTone,
  formatLossPct,
  type ChainLossTone,
} from "@/lib/chainHealth";
import { cn } from "@/lib/utils";

/**
 * 丢包读数：色阶只复用既有的 foreground / warning / destructive，
 * 不引入新色相；无探测数据（null）显示 muted 的 `—`，绝不伪造 0%。
 */
const LOSS_TONE_CLASS: Record<ChainLossTone, string> = {
  normal: "text-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
};

export function ChainLossValue({
  value,
  className,
}: {
  value: number | null;
  className?: string;
}) {
  const tone = chainLossTone(value);
  return (
    <span
      data-loss-value
      data-loss-tone={tone ?? "none"}
      className={cn(
        "font-mono tabular-nums",
        tone === null ? "text-muted-foreground" : LOSS_TONE_CLASS[tone],
        className,
      )}
    >
      {formatLossPct(value)}
    </span>
  );
}
