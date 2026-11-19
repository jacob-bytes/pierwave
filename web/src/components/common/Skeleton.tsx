import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
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

export type SkeletonTableColumn = {
  /** 与真实列一致的响应式可见性 / 对齐；可同时带近似宽度。 */
  className?: string;
  /** 骨架条自身的宽度，例如 `w-28`。 */
  widthClassName?: string;
};

export type SkeletonTableProps = {
  /** 数据行数，默认 5。 */
  rows?: number;
  /**
   * 列数（旧调用）或列元数据数组。传数组时顺序、响应式可见性与宽度都应
   * 与真实表头同源，避免加载完成时列数 / 列宽跳变。
   */
  columns?: number | readonly SkeletonTableColumn[];
  /** 追加到 Table 上的类，例如真实表格的 `min-w-[...]`。 */
  tableClassName?: string;
  className?: string;
};

/**
 * 表格骨架：带表头的一整张表。
 *
 * 用 `TableHead` 渲染表头（与真实表格同为 `th`），列数 / 行高与真实表格一致；
 * 传列元数据时还复用真实列的响应式隐藏规则与近似宽度。
 */
export function SkeletonTable({
  rows = 5,
  columns = 4,
  tableClassName,
  className,
}: SkeletonTableProps) {
  const safeRows = Math.max(0, rows);
  const columnList: readonly SkeletonTableColumn[] =
    typeof columns === "number"
      ? Array.from({ length: Math.max(1, columns) }, () => ({}))
      : columns.length > 0
        ? columns
        : [{}];

  function barWidth(column: SkeletonTableColumn, index: number): string {
    if (column.widthClassName) return column.widthClassName;
    return index === 0
      ? "w-28"
      : index === columnList.length - 1
        ? "w-14"
        : "w-20";
  }

  return (
    <div className={cn("w-full", className)} aria-hidden="true">
      <Table className={tableClassName}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columnList.map((column, index) => (
              <TableHead
                key={index}
                className={cn("px-4 py-2.5", column.className)}
              >
                <SkeletonLine className={cn("h-3", barWidth(column, index))} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: safeRows }, (_, row) => (
            <TableRow key={row} className="hover:bg-transparent">
              {columnList.map((column, index) => (
                <TableCell
                  key={index}
                  className={cn("px-4 py-3", column.className)}
                >
                  <SkeletonLine
                    className={cn("h-3.5", barWidth(column, index))}
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
