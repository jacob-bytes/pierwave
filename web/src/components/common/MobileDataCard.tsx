import { useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { CopyButton } from "@/components/common/CopyButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/i18n";
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
  /** 副标识是否用等宽字体；分组名等自然语言传 false。 */
  subtitleMono?: boolean;
  /** 标题右侧的状态徽章等。 */
  badge?: ReactNode;
  /** 操作按钮 / `⋯` 菜单，与桌面行共用同一份回调。 */
  actions?: ReactNode;
  fields: MobileDataField[];
  /**
   * 折叠的「更多」字段：配置类信息（允许端口、内网地址、网卡、模式等）。
   * 不传 = 不渲染「更多」按钮，组件行为与之前完全一致，其它列表页无需改动。
   */
  moreFields?: MobileDataField[];
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
  subtitleMono = true,
  badge,
  actions,
  fields,
  moreFields,
  children,
  className,
}: MobileDataCardProps) {
  const { t } = useI18n();
  // 展开状态只活在这个卡片实例里：刷新 / 翻页 / 重新挂载都回到默认收起。
  // 刻意不做持久化——移动端列表的默认形态应该是可扫读的短卡，
  // 上一次展开的卡片不应该在下次打开时把整屏撑长。
  const [moreOpen, setMoreOpen] = useState(false);
  const hasMore = moreFields !== undefined && moreFields.length > 0;

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
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px] text-muted-foreground",
                  subtitleMono && "font-mono",
                )}
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
              "flex items-start justify-between gap-3 text-[13px]",
              field.className,
            )}
          >
            <dt className="shrink-0 text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 text-right">{field.value}</dd>
          </div>
        ))}
      </dl>
      {hasMore ? (
        <div className="border-t border-border px-2">
          <Button
            variant="ghost"
            size="xs"
            className="w-full justify-center gap-1 font-normal text-muted-foreground"
            aria-expanded={moreOpen}
            data-slot="mobile-card-more-toggle"
            onClick={() => setMoreOpen((open) => !open)}
          >
            {moreOpen ? t("common.showLess") : t("common.showMore")}
            <ChevronDownIcon
              aria-hidden="true"
              className={cn(
                "transition-transform duration-150",
                moreOpen && "rotate-180",
              )}
            />
          </Button>
          {moreOpen ? (
            <dl
              data-slot="mobile-card-more"
              className="space-y-1.5 px-1 pb-2.5"
            >
              {moreFields.map((field, index) => (
                <div
                  key={index}
                  className={cn(
                    "flex items-start justify-between gap-3 text-[13px]",
                    field.className,
                  )}
                >
                  <dt className="shrink-0 text-muted-foreground">
                    {field.label}
                  </dt>
                  <dd className="min-w-0 text-right">{field.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
      {children ? (
        <div className="border-t border-border px-3 py-2.5">{children}</div>
      ) : null}
    </Card>
  );
}
