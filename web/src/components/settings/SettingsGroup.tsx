import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
 * 设置页的分组：一个分组 = 一张独立卡片（标题 + 说明 + 内容）。
 *
 * 不同配置内容之间不再用横线分隔：卡片之间由父容器的纵向间距分开，
 * 组内仍是「标签在上、控件在下」的两列网格。版本更新卡、通知页各分组、
 * 备份页各分组都用同一套结构，四个 tab 视觉统一。
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
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          {title}
        </CardTitle>
        {description ? (
          <CardDescription className="text-xs">{description}</CardDescription>
        ) : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "grid grid-cols-1 gap-x-5 gap-y-5 lg:grid-cols-2",
            contentClassName,
          )}
        >
          {children}
        </div>
      </CardContent>
    </Card>
  );
}
