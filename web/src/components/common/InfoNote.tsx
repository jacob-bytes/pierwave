import type { ReactNode } from "react";
import { InfoIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type InfoNoteProps = {
  /** 左上角图标，默认 `Info`；颜色固定走 muted-foreground。 */
  icon?: LucideIcon;
  /** 提示块标题。 */
  title: string;
  /** 标题行右侧的次要操作，例如复制按钮。 */
  action?: ReactNode;
  /** 提示内容：只读文本、代码行等。 */
  children: ReactNode;
  className?: string;
};

/**
 * 只读提示块：淡底色 + 小图标 + 标题 + 内容 + 可选动作。
 *
 * 用来把「参考示例」「升级方法」这类只读信息与可输入的表单字段区分开：
 * 不加粗边框、不做输入控件。文案由调用方传入（走 i18n），
 * 这样设置页、服务器页等其它位置都能复用同一套排版。
 */
export function InfoNote({
  icon: Icon = InfoIcon,
  title,
  action,
  children,
  className,
}: InfoNoteProps) {
  return (
    <div
      data-slot="info-note"
      className={cn("rounded-lg bg-muted/40 px-3 py-2.5", className)}
    >
      <div className="flex items-start gap-2">
        <Icon
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs">
            <p className="font-medium">{title}</p>
            {action ? <div className="shrink-0">{action}</div> : null}
          </div>
          <div className="space-y-2 text-xs">{children}</div>
        </div>
      </div>
    </div>
  );
}

export type InfoNoteRowProps = {
  /** 行首标签，例如「安装命令」；省略时只展示代码。 */
  label?: string;
  /** 等宽展示的只读内容。 */
  code: string;
  /** 行右侧的操作，通常是一个复制按钮。 */
  action?: ReactNode;
  className?: string;
};

/**
 * 提示块里的一行「标签 + 等宽代码 + 右侧动作」。
 * 长命令/链接在窄屏用 `break-all` 换行，不撑破卡片。
 */
export function InfoNoteRow({
  label,
  code,
  action,
  className,
}: InfoNoteRowProps) {
  return (
    <div className={cn("flex items-start justify-between gap-2", className)}>
      <div className="min-w-0 space-y-0.5">
        {label ? <p className="text-muted-foreground">{label}</p> : null}
        <code className="block font-mono break-all text-foreground">
          {code}
        </code>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
