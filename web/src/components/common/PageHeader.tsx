import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PageHeaderProps = {
  /** 页面标题，通常是 `t("xxx.title")`；需要加图标时传节点。 */
  title: ReactNode;
  /** 一句话说明，使用 `text-muted-foreground`，不要堆叠多段。 */
  description?: ReactNode;
  /** 右侧操作区；一屏最多一个 primary 按钮。 */
  actions?: ReactNode;
  className?: string;
};

/**
 * 统一的页面头部：标题 + 说明 + 右侧操作区。
 *
 * 间距基线来自现有页面：标题 `text-xl`、说明与标题间隔 4px，
 * 与下方内容的间距由页面容器的 `space-y-6` 负责，这里不再加外边距。
 * 窄屏下自动换行，操作区跟在标题下方而不是被挤成一行。
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        "flex flex-wrap items-end justify-between gap-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div
          data-slot="page-header-actions"
          className="flex flex-wrap items-center gap-2"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
