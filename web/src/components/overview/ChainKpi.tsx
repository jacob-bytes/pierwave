import type { ComponentProps, ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * 「链路时延」两个子页共用的 KPI 栅格。
 *
 * 转发链 / 转发模板的概览必须看起来是同一套东西：2×2（≥sm 4 列）、1px
 * 分隔线、卡片内 16–20px 内边距、28px 数字与 13px 副行。这两个子页以前各自
 * 维护一份样式，改一处就会漂；所以把栅格和单元格抽到这里，只暴露文案。
 *
 * 4 格在 390 下固定 2×2：`min-w-0` + `break-words` 保证长文案换行而不是
 * 把卡片撑出横向滚动。
 */
export type ChainKpiTone = "muted" | "primary" | "warning" | "destructive";

const TONE_CLASS: Record<ChainKpiTone, string> = {
  muted: "text-foreground",
  primary: "text-primary",
  warning: "text-warning",
  destructive: "text-destructive",
};

export function ChainKpiGrid({
  children,
  ...props
}: { children: ReactNode } & ComponentProps<"div">) {
  return (
    <Card className="gap-0 overflow-hidden py-0" {...props}>
      <CardContent className="grid grid-cols-2 gap-px bg-border p-0 sm:grid-cols-4">
        {children}
      </CardContent>
    </Card>
  );
}

export function ChainKpiCell({
  label,
  value,
  hint,
  tone = "muted",
  className,
  ...props
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: ChainKpiTone;
} & ComponentProps<"div">) {
  return (
    <div
      data-chain-kpi-cell
      className={cn("min-w-0 bg-card px-3 py-4 sm:px-5", className)}
      {...props}
    >
      <p className="text-xs leading-tight text-muted-foreground">{label}</p>
      <p
        data-chain-kpi-value
        className={cn(
          "mt-2 text-[28px] leading-none font-medium tracking-tight tabular-nums",
          TONE_CLASS[tone],
        )}
      >
        {value}
      </p>
      {hint ? (
        <p
          data-chain-kpi-hint
          className="mt-2 line-clamp-2 text-[13px] leading-normal break-words text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
