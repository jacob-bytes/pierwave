import { Badge } from "@/components/ui/badge";
import type { Node } from "@/lib/api";
import { ssMethodBadge, ssSettings } from "@/lib/shadowsocks";
import { cn } from "@/lib/utils";

interface SsMethodBadgeProps {
  node: Node;
  className?: string;
}

/** 节点列表名称旁的 `SS · 2022-256` 小徽标；非 Shadowsocks 节点不渲染。 */
export function SsMethodBadge({ node, className }: SsMethodBadgeProps) {
  if (node.protocol !== "shadowsocks" && node.protocol !== "ss") return null;

  const { method } = ssSettings(node);
  return (
    <Badge
      variant="outline"
      title={method}
      className={cn(
        "shrink-0 font-mono type-micro font-normal text-muted-foreground",
        className,
      )}
    >
      {ssMethodBadge(method)}
    </Badge>
  );
}
