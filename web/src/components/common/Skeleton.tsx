import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SkeletonLineProps = React.ComponentProps<"div">;

/**
 * 一行骨架文本，默认占满宽度、高度对齐 `text-sm` 的行高。
 * 宽度用 className 控制（例如 `w-24`），不要写死颜色。
 */
export function SkeletonLine({ className, ...props }: SkeletonLineProps) {
  return (
    <Skeleton
      data-slot="skeleton-line"
      className={cn("h-3.5 w-full", className)}
      {...props}
    />
  );
}

export type PageSkeletonProps = {
  /** 无障碍标签，传当前路由的「正在加载…」文案。 */
  label: string;
  className?: string;
};

/**
 * 路由 / 页面级通用骨架：一个头部条 + 两行内容块。
 *
 * 不为每个路由单独定制：后台各页的头部都是标题 + 说明，内容都是成块的
 * 卡片 / 表格，通用骨架能覆盖这个大致结构，避免加载时整页只转一个 spinner。
 * 纯装饰的骨架块全部 `aria-hidden`，由外层 `role="status"` 朗读 label。
 */
export function PageSkeleton({ label, className }: PageSkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-slot="page-skeleton"
      className={cn("w-full space-y-6", className)}
    >
      <div aria-hidden="true" className="space-y-2">
        <SkeletonLine className="h-6 w-40" />
        <SkeletonLine className="h-3.5 w-64 max-w-full" />
      </div>
      <div aria-hidden="true" className="space-y-4">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </div>
  );
}

export type SkeletonCardProps = {
  /** 正文骨架行数，默认 3；标题区固定两行。 */
  lines?: number;
  className?: string;
};

/**
 * 卡片骨架：标题 + 说明 + 若干正文行，用于概览 / 设置等卡片式加载态。
 * 用 `aria-hidden` 把纯装饰内容挡在无障碍树外，页面自行提供 `aria-busy`。
 */
export function SkeletonCard({ lines = 3, className }: SkeletonCardProps) {
  return (
    <Card className={cn("gap-4", className)} aria-hidden="true">
      <CardHeader>
        <SkeletonLine className="h-4 w-1/3" />
        <SkeletonLine className="h-3 w-2/3" />
      </CardHeader>
      <CardContent className="space-y-2.5">
        {Array.from({ length: Math.max(0, lines) }, (_, index) => (
          <SkeletonLine
            key={index}
            className={index === lines - 1 ? "w-3/5" : "w-full"}
          />
        ))}
      </CardContent>
    </Card>
  );
}

export type SkeletonTableProps = {
  /** 数据行数，默认 5。 */
  rows?: number;
  /** 列数，默认 4；与真实表格的列数保持一致，避免加载结束跳动。 */
  columns?: number;
  className?: string;
};

/**
 * 表格骨架：带表头的一整张表。
 * 直接用 shadcn 的 Table 原语，列宽 / 行高与真实表格一致。
 */
export function SkeletonTable({
  rows = 5,
  columns = 4,
  className,
}: SkeletonTableProps) {
  const safeRows = Math.max(0, rows);
  const safeColumns = Math.max(1, columns);

  return (
    <div className={cn("w-full", className)} aria-hidden="true">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {Array.from({ length: safeColumns }, (_, column) => (
              <TableCell key={column} className="px-4 py-2.5">
                <SkeletonLine className="h-3 w-16" />
              </TableCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: safeRows }, (_, row) => (
            <TableRow key={row} className="hover:bg-transparent">
              {Array.from({ length: safeColumns }, (_, column) => (
                <TableCell key={column} className="px-4 py-3">
                  <SkeletonLine
                    className={cn(
                      "h-3.5",
                      column === 0 ? "w-28" : column === safeColumns - 1 ? "w-14" : "w-20",
                    )}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
