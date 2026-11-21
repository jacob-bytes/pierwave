import type { ReactNode } from "react";
import { Loader2Icon, SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 设置页三个表单 tab（常规 / 安全 / 通知）共用的页面级保存条。
 *
 * 它是内容滚动区之外的 flex 兄弟节点：上方滚动区负责内容，底部这条
 * 永远占住自己的高度，所以不会像 sticky 覆盖层那样压住卡片，也不会
 * 透出下方内容。`sticky bottom-0` 只是让它在极短内容时仍贴住底部；
 * 在正常结构里它本身就是最后一项。
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
      className="sticky bottom-0 z-20 flex w-full shrink-0 items-center justify-end gap-3 border-t border-border bg-background py-3"
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
 * 表单 tab 的外壳：滚动内容 + 固定的保存条。
 *
 * 保存条在滚动容器之外，最后一张卡只需在滚动区底部留 24px 内边距；
 * 滚到底时与条之间保持 24px，不会被覆盖。
 */
export function SettingsFormShell({
  children,
  footer,
}: {
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="pb-6">{children}</div>
      </div>
      {footer}
    </div>
  );
}
