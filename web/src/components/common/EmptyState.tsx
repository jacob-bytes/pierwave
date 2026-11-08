import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type EmptyStateProps = {
  /** 可选图标；用 lucide 图标组件，尺寸由组件控制（20px）。 */
  icon?: LucideIcon;
  /** 空态标题，必须说明「现在没有什么」。 */
  title: string;
  /** 可选说明，一句话告诉用户下一步；文案走 i18n，由调用方传入。 */
  description?: string;
  /** 可选操作区，通常传一个 `<Button>`，也可以是链接等任意节点。 */
  action?: ReactNode;
  /** `sm` 用于表格单元格内，`default` 用于独立卡片 / 页面。 */
  size?: "default" | "sm";
  /** 图标底色：默认 muted；需要引导主操作时用 primary。 */
  tone?: "muted" | "primary";
  className?: string;
};

/**
 * 统一空态：图标 + 标题 + 说明 + 可选操作。
 *
 * 四态（loading / empty / error / 正常）里的 empty 一律用它，
 * 避免每页各写一套间距与字号。它只管排版，不读 i18n，
 * 文案由调用方传入，方便表格行内复用。
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = "default",
  tone = "muted",
  className,
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 text-center",
        size === "sm" ? "py-8" : "py-12",
        className,
      )}
    >
      {Icon ? (
        <div
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full",
            tone === "primary"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-5" aria-hidden="true" />
        </div>
      ) : null}
      <div className="max-w-sm space-y-1">
        <p
          className={cn(
            "font-medium",
            size === "sm" ? "text-sm" : "text-base",
          )}
        >
          {title}
        </p>
        {description ? (
          <p
            className={cn(
              "leading-relaxed text-muted-foreground",
              size === "sm" ? "text-xs" : "text-sm",
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
