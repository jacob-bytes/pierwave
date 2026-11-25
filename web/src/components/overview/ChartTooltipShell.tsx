import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 允许调用方给外壳挂 `data-*` 标记（截图 / 回归测试定位用）。 */
type DataAttributes = {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

export type ChartTooltipShellProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "className" | "children"
> &
  DataAttributes & {
    children: ReactNode;
    className?: string;
  };

/**
 * 图表 tooltip 的统一外壳（概览页所有图表共用，成本页也可直接复用）。
 *
 * 统一项：`bg-popover` 背景、`border-border` 边框、`rounded-md` 圆角、
 * `shadow-lg/40` 阴影、12px 内边距、12px 正文字号、`tabular-nums` 数字对齐。
 * 次要信息（时间、注释）用 [`ChartTooltipHeading`] / `text-[11px]`，不另写外壳。
 */
export function ChartTooltipShell({
  children,
  className,
  ...rest
}: ChartTooltipShellProps) {
  return (
    <div
      data-chart-tooltip-shell
      className={cn(
        "min-w-44 max-w-72 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg/40 tabular-nums",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** tooltip 顶部的时间 / 日期行：11px、等宽、次要色。 */
export function ChartTooltipHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "mb-2 font-mono text-[11px] font-normal text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** tooltip 里的一行「标签 · 数值」，数值统一等宽 + tabular-nums。 */
export function ChartTooltipRow({
  label,
  value,
  marker,
  highlight = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  /** 颜色点 / 线型样本，放在标签左侧。 */
  marker?: ReactNode;
  /** 最高值等需要强调的行：低透明度 primary 底。 */
  highlight?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-5 rounded-sm px-1 py-0.5",
        highlight && "bg-primary/5",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {marker}
        <span className="truncate">{label}</span>
      </span>
      <span className="shrink-0 font-mono text-foreground tabular-nums">
        {value}
      </span>
    </div>
  );
}

/** tooltip 内的分组分隔线。 */
export function ChartTooltipDivider() {
  return <div aria-hidden="true" className="my-1 h-px bg-border" />;
}
