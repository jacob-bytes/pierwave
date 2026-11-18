import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
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
 *
 * 所有列表页的错误态都必须走这里：`role="alert"`、固定的 `py` / 图标尺寸 /
 * `max-w`，「重试」按钮不可省略。表格里用 `ListErrorRow` 包一层行结构。
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
        "mx-auto flex w-full max-w-md flex-col items-center gap-3 px-4 py-12 text-center",
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

export type ListErrorRowProps = Omit<ListErrorProps, "className"> & {
  /** 表格总列数，用于跨列铺满。 */
  colSpan: number;
  className?: string;
};

/**
 * 表格行内的错误态：保留 `TableRow` / `TableCell` 结构（列宽、吸顶列、边框
 * 都与正常行一致），内容复用 `ListError`。
 */
export function ListErrorRow({ colSpan, className, ...props }: ListErrorRowProps) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="px-4 py-0">
        <ListError {...props} className={className} />
      </TableCell>
    </TableRow>
  );
}
