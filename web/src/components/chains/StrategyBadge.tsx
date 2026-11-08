import {
  CircleHelpIcon,
  FingerprintIcon,
  GaugeIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { isChainStrategy, type ChainStrategy } from "@/lib/chains";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

interface StrategyBadgeProps {
  /** 后端返回的原始字符串；非法值会显示「未知策略」而不是静默当成轮询。 */
  strategy: string;
  className?: string;
}

/**
 * 统一的选路策略小徽标：列表、详情与表单说明共用同一套图标 / 文案。
 * 文案键在 `chains.strategy.*`，中英双语。
 */
const STRATEGY_META: Record<
  ChainStrategy,
  { icon: LucideIcon; tone: string }
> = {
  round_robin: {
    icon: RefreshCwIcon,
    tone: "border-border/80 bg-muted/40 text-muted-foreground",
  },
  failover: {
    icon: ShieldCheckIcon,
    tone: "border-primary/35 bg-primary/10 text-primary",
  },
  lowest_latency: {
    icon: GaugeIcon,
    tone: "border-border/80 bg-muted/40 text-foreground",
  },
  ip_hashed: {
    icon: FingerprintIcon,
    tone: "border-border/80 bg-muted/40 text-foreground",
  },
};

const UNKNOWN_META = {
  icon: CircleHelpIcon,
  tone: "border-warning/40 bg-warning/10 text-warning",
};

export function StrategyBadge({ strategy, className }: StrategyBadgeProps) {
  const { t } = useI18n();
  const known = isChainStrategy(strategy);
  const meta = known ? STRATEGY_META[strategy] : UNKNOWN_META;
  const Icon = meta.icon;
  const labelKey = known
    ? `chains.strategy.${strategy}.label`
    : "chains.strategy.unknown.label";
  const descKey = known
    ? `chains.strategy.${strategy}.desc`
    : "chains.strategy.unknown.desc";

  return (
    <Badge
      variant="outline"
      title={t(descKey)}
      className={cn(
        "h-5 gap-1 px-1.5 text-[10px] font-normal whitespace-nowrap",
        meta.tone,
        className,
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {t(labelKey)}
    </Badge>
  );
}
