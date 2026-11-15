import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 网格契约：字段一律是「标签在上、控件在下」的块（`FormField` 默认纵向布局），
 * 在分组内按两列排布——≥1024px 两列，窄屏单列。
 *
 * 语义上不与其它字段并列的块（说明、只读信息、操作行、整块勾选卡）
 * 自己带上这个类独占一整行，避免被挤到半列里。
 */
export const SETTINGS_FULL_ROW = "lg:col-span-2";

/**
 * 设置页的分组：标题 + 说明在上，两列字段网格在下。
 *
 * 分组之间只用一条 `border-t`（站内统一无竖线），组内不再画线。
 * 放在同一张 `Card` 里由页面组合，避免退化成卡片堆叠。
 */
export function SettingsGroup({
  icon: Icon,
  title,
  description,
  action,
  className,
  contentClassName,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  /** 标题行右侧的次要信息或操作，例如版本状态。 */
  action?: ReactNode;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "border-t border-border px-5 py-5 first:border-t-0",
        className,
      )}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            {title}
          </h2>
          {description ? (
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? (
          <div className="min-w-0 lg:shrink-0 lg:text-right">{action}</div>
        ) : null}
      </div>
      <div
        className={cn(
          "mt-4 grid grid-cols-1 gap-x-5 gap-y-5 lg:grid-cols-2",
          contentClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}
