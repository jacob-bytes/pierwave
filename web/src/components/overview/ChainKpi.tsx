import type { ComponentProps, ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * 全站概览 KPI 条的唯一栅格。
 *
 * 「资源状态」三个数字、「成本开支」四个金额、「链路时延」四格、
 * 「转发模板」四格都走这里，不再各自维护一套栅格与字号：
 *
 * - `grid-cols-2` / `sm:grid-cols-4`：390 下 2×2，桌面 4 列；
 * - 1px 分隔线（`gap-px` + `bg-border`）；
 * - 28px 数字 + 13px 副行 + 12px 标签。
 *
 * 三指标的视图（资源状态）让第一格用 `col-span-2` 占满首行：
 * 它同时是「总量」的语义（在线率），也把 4 列栅格补满，避免右侧留出
 * 一块 --border 色的空格子。这样三格和四格在 390 下都是两行、桌面都是
 * 一行，切 tab 时 KPI 条高度不跳；成本开支的四格不跨列，390 直接 2×2。
 *
 * cell 高度只由内容 + 固定内边距决定，不再用 `min-h` 凑高度：同一行的
 * 格子由 grid 自动等高，底部只有 `py-3.5` 的 padding，不会出现红框那种
 * 「数字下面空一截」的留白。副行固定单行（`line-clamp-1` + title），
 * 所以副行文案长短不会把卡片撑高；数字在最窄处仍允许换行，390 下成本
 * 金额可能占两行，该卡会自然高一点（这是唯一允许的高度差）。
 *
 * `min-w-0` + `break-words` 保证长文案换行而不是把卡片撑出横向滚动。
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

/** 与真实 KPI 同 padding / 同行高的骨架：加载完成时高度不会跳。 */
export function ChainKpiSkeletonGrid({
  cells = 4,
  ...props
}: { cells?: number } & ComponentProps<"div">) {
  return (
    <ChainKpiGrid aria-hidden="true" {...props}>
      {Array.from({ length: cells }).map((_, index) => (
        <div
          key={index}
          data-chain-kpi-skeleton
          className={cn(
            "min-w-0 bg-card px-3 py-3.5 sm:px-5",
            // 三指标的视图首格跨两列，骨架也保持同样的两行 / 一行结构。
            index === 0 && cells === 3 && "col-span-2",
          )}
        >
          <Skeleton className="h-4 w-16" />
          <Skeleton className="mt-1 h-7 w-14" />
          <Skeleton className="mt-1 h-[21px] w-24" />
        </div>
      ))}
    </ChainKpiGrid>
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
        // 14 + 16.2 + 4 + 28 + 4 + 20.8 + 14 = 101：内容有多高卡片就多高，
        // 底边只留 14px padding；同一行由 grid 自动拉齐。
        // flex-col + hint 的 mt-auto：若同行有更高的卡把这一格拉高，
        // 副行贴底而不是在数字下面留一截空白。
        "flex min-w-0 flex-col bg-card px-3 py-3.5 sm:px-5",
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
        // `key={value}`：只有数字真的变了才重挂载，`value-settle` 才会重播；
        // 拿回同样的值时不闪。外层 cell / 卡片不重挂载，布局不跳。
        key={value}
        data-chain-kpi-value
        className={cn(
          "mt-1 text-[28px] leading-none font-medium tracking-tight break-words tabular-nums",
          "value-settle",
          TONE_CLASS[tone],
        )}
      >
        {value}
      </p>
      {hint ? (
        <p
          data-chain-kpi-hint
          title={hint}
          className="mt-auto pt-1 line-clamp-1 text-[13px] leading-normal break-words text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
