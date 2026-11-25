import type { ComponentProps, ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * 全站概览 KPI 条的唯一栅格。
 *
 * 「资源状态」三个数字、「成本开支」三个金额、「链路时延」四格、
 * 「转发模板」四格都走这里，不再各自维护一套栅格与字号：
 *
 * - `grid-cols-2` / `sm:grid-cols-4`：390 下 2×2，桌面 4 列；
 * - 1px 分隔线（`gap-px` + `bg-border`）；
 * - 28px 数字 + 13px 副行 + 12px 标签。
 *
 * 三指标的视图（资源状态 / 成本）让第一格用 `col-span-2` 占满首行：
 * 它同时是「总量」的语义（在线率 / 总开销），也把 4 列栅格补满，
 * 避免右侧留出一块 --border 色的空格子。这样三格和四格在 390 下都是
 * 两行、桌面都是一行，切 tab 时 KPI 条高度不跳。
 *
 * 每个 cell 固定最小高度：副行最多两行、标签一行，数字在最窄处最多
 * 换两行（成本金额 `CNY 28,124.80` 在 390 的 171px 格子里会断成两行），
 * 于是四组 KPI 在两种断点下高度完全一致。`≥xl` 有足够宽度，数字回到
 * 单行，KPI 条随之收窄。`min-w-0` + `break-words` 保证长文案换行而不是
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
      className={cn(
        // 136px = 单行数字（16 + 16.2 + 8 + 28 + 8 + 41.6 + 16）；
        // 164px 再给数字多留一行 28px，覆盖 390 下成本金额的换行。
        "min-h-[164px] min-w-0 bg-card px-3 py-4 sm:px-5 xl:min-h-[136px]",
        className,
      )}
      {...props}
    >
      <p
        data-chain-kpi-label
        className="truncate text-xs leading-tight text-muted-foreground"
        title={label}
      >
        {label}
      </p>
      <p
        data-chain-kpi-value
        className={cn(
          "mt-2 text-[28px] leading-none font-medium tracking-tight break-words tabular-nums",
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
