import { TriangleAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { engineMeta } from "@/lib/engines";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

interface EngineBadgeProps {
  /** 后端返回的原始字符串；未知值显示「未知引擎」而不是空白。 */
  engine: unknown;
  /**
   * true = 规则引擎是 realm，但这条规则所在的服务器明确没装 realm。
   *
   * 这是**静态环境事实**（来自服务器列表），与运行时的「引擎缺失」不同：
   * 后者要保存并等 Agent 上报后才会出现。
   */
  realmUnavailable?: boolean;
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
export function EngineBadge({
  engine,
  realmUnavailable = false,
  className,
}: EngineBadgeProps) {
  const { t } = useI18n();
  const meta = engineMeta(engine);
  const realmMissingLabel = t("common.engine.realm.notInstalled");

  return (
    <>
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
      {realmUnavailable ? (
        <span
          role="img"
          aria-label={realmMissingLabel}
          title={realmMissingLabel}
          data-realm-unavailable="true"
          className="inline-flex shrink-0 text-warning"
        >
          <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
        </span>
      ) : null}
    </>
  );
}

/**
 * 名称旁的 `UDP` 小徽标：只在 native 规则真正开启 UDP 时显示，不新增列。
 *
 * 与 `EngineBadge` 同一套 outline + type-micro 视觉，紧挨着引擎徽标排；
 * realm 不显示（引擎徽标已说明它本来就转发 UDP）。
 */
export function UdpBadge({ className }: { className?: string }) {
  const { t } = useI18n();

  return (
    <Badge
      variant="outline"
      data-udp="true"
      className={cn(
        "h-5 px-1.5 type-micro font-normal whitespace-nowrap",
        ENGINE_TONES.native,
        className,
      )}
    >
      {t("common.udp")}
    </Badge>
  );
}
