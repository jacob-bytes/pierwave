import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

export type ListErrorProps = {
  title: string;
  message: string;
  retrying?: boolean;
  onRetry: () => void;
  className?: string;
};

/**
 * 列表错误态（不依赖表格结构）。
 * 桌面表格行内与移动端卡片列表共用，避免两套错误文案/重试按钮。
 */
export function ListError({
  title,
  message,
  retrying = false,
  onRetry,
  className,
}: ListErrorProps) {
  return (
    <div
      data-slot="list-error"
      role="alert"
      className={cn(
        "mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-12 text-center",
        className,
      )}
    >
      <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlertIcon className="size-5" aria-hidden="true" />
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        <RefreshCwIcon className={cn("size-3.5", retrying && "animate-spin")} />
        {t("common.retry")}
      </Button>
    </div>
  );
}
