import type { ReactNode } from "react";
import { Loader2Icon, SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 设置页三个表单 tab（常规 / 安全 / 通知）共用的页面级保存条。
 *
 * 它只是内容流里的最后一个普通块：卡片结束后出现，随页面一起滚动。
 * 不 sticky / fixed，所以页面中部看不到它；只有滚到最底部才出现。
 */
export function SettingsSaveBar({
  formId,
  pending,
  dirty,
  hint,
  dirtyHint,
  saveLabel,
  savingLabel,
}: {
  formId: string;
  pending: boolean;
  dirty: boolean;
  hint: string;
  dirtyHint: string;
  saveLabel: string;
  savingLabel: string;
}) {
  const message = dirty ? dirtyHint : hint;

  return (
    <div
      data-slot="settings-savebar"
      className="flex w-full items-center justify-end gap-3 border-t border-border bg-background py-3"
    >
      <p
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          dirty ? "text-warning" : "text-muted-foreground",
        )}
        title={message}
      >
        {message}
      </p>
      <Button
        type="submit"
        form={formId}
        className="shrink-0"
        disabled={pending || !dirty}
      >
        {pending ? (
          <Loader2Icon className="animate-spin" />
        ) : (
          <SaveIcon />
        )}
        {pending ? savingLabel : saveLabel}
      </Button>
    </div>
  );
}

/**
 * 表单 tab 的外壳：表单内容之后接保存条，全部在正常文档流里。
 * 两者之间留 24px，滚到底时最后一张卡不会贴住条。
 */
export function SettingsFormShell({
  children,
  footer,
}: {
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="space-y-6">
      {children}
      {footer}
    </div>
  );
}
