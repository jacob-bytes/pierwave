import type { ReactNode } from "react";
import { CopyButton } from "@/components/common/CopyButton";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type MobileDataField = {
  /** 字段名，例如「状态」「额度」；卡片里渲染为「标签：值」。 */
  label: ReactNode;
  value: ReactNode;
  className?: string;
};

export type MobileDataCardProps = {
  /** 主标识（名称 / 用户名 / 链名）。 */
  title: ReactNode;
  /** 主标识的完整文本：提供后窄屏行内出现复制按钮，并作为 title 提示。 */
  titleCopyValue?: string;
  /** 副标识（短码 / tag / 地址），可省略。 */
  subtitle?: ReactNode;
  /** 副标识的完整文本：与 `titleCopyValue` 同理。 */
  subtitleCopyValue?: string;
  /** 标题右侧的状态徽章等。 */
  badge?: ReactNode;
  /** 操作按钮 / `⋯` 菜单，与桌面行共用同一份回调。 */
  actions?: ReactNode;
  fields: MobileDataField[];
  /** 额外内容（例如转发链展开后的分组详情）。 */
  children?: ReactNode;
  className?: string;
};

/**
 * 窄屏列表卡片。桌面表格与移动端卡片使用同一份字段值和操作回调：
 * 页面只负责提供 `fields`，不在这里重复业务逻辑。
 */
export function MobileDataCard({
  title,
  titleCopyValue,
  subtitle,
  subtitleCopyValue,
  badge,
  actions,
  fields,
  children,
  className,
}: MobileDataCardProps) {
  return (
    <Card
      size="sm"
      data-slot="mobile-data-card"
      className={cn("gap-0 py-0", className)}
    >
      <div className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <div
              className="min-w-0 flex-1 truncate text-sm font-medium"
              title={titleCopyValue}
            >
              {title}
            </div>
            {titleCopyValue ? (
              <CopyButton
                value={titleCopyValue}
                label={titleCopyValue}
                iconOnly
                className="shrink-0 max-sm:min-h-7 max-sm:min-w-7"
              />
            ) : null}
          </div>
          {subtitle ? (
            <div className="flex min-w-0 items-center gap-1">
              <div
                className="min-w-0 flex-1 truncate font-mono type-micro text-muted-foreground"
                title={subtitleCopyValue}
              >
                {subtitle}
              </div>
              {subtitleCopyValue ? (
                <CopyButton
                  value={subtitleCopyValue}
                  label={subtitleCopyValue}
                  iconOnly
                  className="shrink-0 max-sm:min-h-7 max-sm:min-w-7"
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {badge ? <div className="shrink-0">{badge}</div> : null}
        {actions ? (
          <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
        ) : null}
      </div>
      <dl className="space-y-1.5 px-3 py-2.5">
        {fields.map((field, index) => (
          <div
            key={index}
            className={cn(
              "flex items-start justify-between gap-3 text-xs",
              field.className,
            )}
          >
            <dt className="shrink-0 text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 text-right">{field.value}</dd>
          </div>
        ))}
      </dl>
      {children ? (
        <div className="border-t border-border px-3 py-2.5">{children}</div>
      ) : null}
    </Card>
  );
}
