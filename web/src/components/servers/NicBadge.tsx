import { Badge } from "@/components/ui/badge";
import type { Server } from "@/lib/api";
import { nicBadgeTone, nicLabel, nicState } from "@/lib/nic";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

const toneClasses = {
  default: "text-muted-foreground",
  warning: "border-transparent bg-warning/10 text-warning",
  muted: "text-muted-foreground",
} as const;

/**
 * 服务器列表 / 详情里的网卡小标。
 *
 * 只有选了网卡才渲染；服务器还没上报网卡、或保存的网卡已不在最新列表里时
 * 用 warning 色调，并在 title 里说明原因，不额外占一行。
 */
export function NicBadge({
  server,
  compact = false,
  className,
}: {
  server: Server;
  /** 移动端卡片已有「网卡」字段名，只显示网卡名。 */
  compact?: boolean;
  className?: string;
}) {
  const name = nicLabel(server.nic_name);
  if (name === null) return null;

  const state = nicState(server);
  const title =
    state === "unverified"
      ? server.nic_unverified === true
        ? t("servers.nic.unverifiedTitle")
        : t("servers.nic.unknownTitle")
      : state === "empty"
        ? t("servers.nic.emptyHint")
        : undefined;

  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        "h-4 px-1 type-micro font-normal whitespace-nowrap",
        toneClasses[nicBadgeTone(state)],
        className,
      )}
    >
      {compact ? name : t("servers.nic.badge", { name })}
    </Badge>
  );
}
