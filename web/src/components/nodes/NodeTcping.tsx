import { LoaderCircleIcon, RadarIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { t } from "@/i18n";
import type { Node } from "@/lib/api";
import {
  isTcpingLoading,
  tcpingHint,
  tcpingLabel,
  type TcpingState,
} from "@/lib/tcping";
import { cn } from "@/lib/utils";

/**
 * 行内「探测」按钮：图标 + tooltip，点击后进入 loading。
 *
 * 结果由 [`NodeTcpingResult`] 渲染；桌面放在按钮旁，移动端放到名称下方一行。
 */
export function NodeTcpingAction({
  node,
  state,
  onProbe,
  className,
}: {
  node: Node;
  state: TcpingState;
  onProbe: () => void;
  className?: string;
}) {
  const loading = isTcpingLoading(state);

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={loading}
            aria-busy={loading}
            aria-label={
              loading
                ? t("nodes.tcping.probing")
                : t("nodes.tcping.probeAria", { name: node.name })
            }
            onClick={onProbe}
          >
            {loading ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <RadarIcon className="size-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {loading ? t("nodes.tcping.probing") : t("nodes.tcping.probe")}
        </TooltipContent>
      </Tooltip>
      <NodeTcpingResult state={state} className="hidden md:inline-flex" />
    </div>
  );
}

/**
 * 行内结果：成功 `42 ms`（状态点 + primary 文字），失败 `不可达`（muted）。
 * 失败时悬停显示后端返回的可读原因。
 */
export function NodeTcpingResult({
  state,
  className,
}: {
  state: TcpingState;
  className?: string;
}) {
  const label = tcpingLabel(state, t("nodes.tcping.unreachable"));
  if (!label) return null;
  const hint = tcpingHint(state, t("nodes.tcping.failureFallback"));

  if (state.status === "success") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs text-primary",
          className,
        )}
        title={hint ?? undefined}
      >
        <span
          className="size-1.5 shrink-0 rounded-full bg-primary"
          aria-hidden="true"
        />
        <span className="font-mono tabular-nums">{label}</span>
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex cursor-help items-center text-xs text-muted-foreground",
            className,
          )}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
