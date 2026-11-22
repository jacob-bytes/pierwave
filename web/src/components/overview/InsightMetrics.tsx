import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface InsightMetric {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}

/**
 * 新视图顶部的一行三个数字：服务器状态的 24h 在线率 / 异常台数 / 磁盘最高，
 * 成本的月均 / 年化 / 未来 12 个月。
 *
 * 只做排版；数字与单位由调用方决定（金额、百分比、台数都走同一套字号）。
 * 390 下仍保持三列，金额用 `tabular-nums` 防止跳动。
 */
export function InsightMetrics({
  items,
  className,
}: {
  items: readonly InsightMetric[];
  className?: string;
}) {
  return (
    <Card className={cn("gap-0 py-0", className)}>
      <CardContent className="grid grid-cols-3 divide-x divide-border p-0">
        {items.map((item, index) => (
          <div
            key={`${item.label}-${index}`}
            data-insight-metric
            className="min-w-0 px-3 py-4 sm:px-5"
          >
            <p
              data-insight-metric-label
              className="text-xs leading-tight text-muted-foreground"
            >
              {item.label}
            </p>
            <div
              data-insight-metric-value
              className="mt-2 text-xl leading-none font-medium tracking-tight tabular-nums sm:text-2xl"
            >
              {item.value}
            </div>
            {item.hint ? (
              <p className="mt-2 line-clamp-2 text-xs leading-normal text-muted-foreground">
                {item.hint}
              </p>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
