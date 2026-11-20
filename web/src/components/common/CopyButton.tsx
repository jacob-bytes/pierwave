import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/** 复制成功后图标与文字保持「已复制」的时长。 */
const COPIED_FEEDBACK_MS = 1600;

/**
 * 只读文本的复制按钮：成功给 toast，并在按钮上短暂显示对勾。
 *
 * 复制能力走 `lib/clipboard.ts`（Clipboard API + textarea 回退），
 * 失败时提示手动选择文本；不在这里做任何格式化或截断。
 */
export function CopyButton({
  value,
  label,
  className,
  iconOnly = false,
}: {
  /** 要复制到剪贴板的完整文本。 */
  value: string;
  /** 给屏幕阅读器/日志用的对象名，例如「安装命令」。 */
  label?: string;
  className?: string;
  /** 窄屏行内空间不足时只要图标；aria-label 仍带完整对象名。 */
  iconOnly?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function handleCopy() {
    if (!(await copyText(value))) {
      toast.error(t("common.copyFailed"));
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    toast.success(t("common.copied"));
  }

  const text = t("common.copy");

  return (
    <Button
      type="button"
      variant="ghost"
      size={iconOnly ? "icon-xs" : "xs"}
      onClick={() => void handleCopy()}
      aria-label={label ? `${text} ${label}` : text}
      className={cn("text-muted-foreground", className)}
    >
      {copied ? <CheckIcon className="text-primary" /> : <CopyIcon />}
      {iconOnly ? null : copied ? t("common.copied") : text}
    </Button>
  );
}
