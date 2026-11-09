import { Badge } from "@/components/ui/badge";
import { engineMeta } from "@/lib/engines";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

interface EngineBadgeProps {
  /** 后端返回的原始字符串；未知值显示「未知引擎」而不是空白。 */
  engine: unknown;
  className?: string;
}

const ENGINE_TONES = {
  native: "border-border/80 bg-muted/40 text-muted-foreground",
  realm: "border-primary/35 bg-primary/10 text-primary",
} as const;

const UNKNOWN_TONE = "border-warning/40 bg-warning/10 text-warning";

/**
 * 列表名称旁的转发引擎小徽标：`native` → 「自带」，`realm` → 「realm」。
 *
 * 与 `StrategyBadge` 同一套视觉（outline + type-micro），不新增表格列；
 * 文案与说明统一在 `common.engine.*`，title 给出完整语义。
 */
export function EngineBadge({ engine, className }: EngineBadgeProps) {
  const { t } = useI18n();
  const meta = engineMeta(engine);

  return (
    <Badge
      variant="outline"
      title={t(meta.descKey)}
      data-engine={meta.engine ?? "unknown"}
      className={cn(
        "h-5 px-1.5 type-micro font-normal whitespace-nowrap",
        meta.engine ? ENGINE_TONES[meta.engine] : UNKNOWN_TONE,
        className,
      )}
    >
      {t(meta.labelKey)}
    </Badge>
  );
}
