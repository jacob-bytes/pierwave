import { Badge } from "@/components/ui/badge";
import {
  chainHealthState,
  type ChainHealthChain,
  type ChainHealthConfig,
  type ChainHealthState,
  type ChainNodeIssue,
} from "@/lib/chainHealth";
import { t, useI18n } from "@/i18n";
import {
  CHAIN_STATE_LABEL_KEYS,
  chainStatusText,
} from "@/lib/chainStatusText";
import { cn } from "@/lib/utils";

/**
 * 状态列 / 详情徽章共用的一套文案与色：正常 primary、降级 warning、
 * 阻断 destructive；停用与样本不足用 muted，不抢正常状态的注意力。
 */
export interface ChainHealthStateMeta {
  labelKey: string;
  titleKey?: string;
  dot: string;
  text: string;
  badge: string;
}

export const CHAIN_HEALTH_STATE_META: Record<
  ChainHealthState,
  ChainHealthStateMeta
> = {
  ok: {
    labelKey: CHAIN_STATE_LABEL_KEYS.ok,
    titleKey: "overview.chainLatency.healthHealthyTitle",
    dot: "bg-primary",
    text: "text-primary",
    badge: "border-primary/40 text-primary",
  },
  degraded: {
    labelKey: CHAIN_STATE_LABEL_KEYS.degraded,
    titleKey: "chains.status.degradedTitle",
    dot: "bg-warning",
    text: "text-warning",
    badge: "border-warning/40 text-warning",
  },
  blocked: {
    labelKey: CHAIN_STATE_LABEL_KEYS.blocked,
    dot: "bg-destructive",
    text: "text-destructive",
    badge: "border-destructive/40 text-destructive",
  },
  disabled: {
    labelKey: CHAIN_STATE_LABEL_KEYS.disabled,
    titleKey: "chains.status.disabledTitle",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    badge: "border-border text-muted-foreground",
  },
  insufficient: {
    labelKey: CHAIN_STATE_LABEL_KEYS.insufficient,
    titleKey: "overview.chainLatency.statusInsufficientTitle",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    badge: "border-border text-muted-foreground",
  },
  unknown: {
    labelKey: CHAIN_STATE_LABEL_KEYS.unknown,
    titleKey: "overview.chainLatency.unmeasurableTitle",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    badge: "border-border text-muted-foreground",
  },
};

/** 行内小字：`节点 大阪-01 离线` / `节点 大阪-01 异常`。 */
export function chainNodeIssueText(issue: ChainNodeIssue | null): string | null {
  if (issue === null) return null;
  return issue.kind === "offline"
    ? t("overview.chainLatency.nodeOffline", { name: issue.node.name })
    : t("overview.chainLatency.nodeUnhealthy", { name: issue.node.name });
}

/**
 * 详情弹窗顶部的链状态徽章。节点级原因带节点名（`阻断 · 大阪-01 离线`），
 * 链级的无样本 / 变慢原因只给短词（`降级 · 无样本` / `降级 · 变慢`）。
 */
export function ChainStatusBadge({
  chain,
  config = null,
  state,
  className,
}: {
  chain: ChainHealthChain;
  /** 链列表里的配置；详情弹窗用它保留「停用」与旧契约回退。 */
  config?: ChainHealthConfig | null;
  /** 已算好的状态；不传时按 chain + config 现算。 */
  state?: ChainHealthState;
  className?: string;
}) {
  const { t } = useI18n();
  const resolved = state ?? chainHealthState(chain, config);
  const text = chainStatusText(chain, config, t, resolved);
  const meta = CHAIN_HEALTH_STATE_META[resolved];
  return (
    <Badge
      variant="outline"
      data-chain-status-badge
      data-state={resolved}
      title={text}
      className={cn("shrink-0 gap-1.5 font-normal", meta.badge, className)}
    >
      <span
        aria-hidden="true"
        data-chain-status-badge-dot
        className={cn("size-2 shrink-0 rounded-full", meta.dot)}
      />
      <span data-chain-status-badge-text>{text}</span>
    </Badge>
  );
}
