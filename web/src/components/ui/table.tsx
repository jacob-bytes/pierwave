"use client"

import * as React from "react"
import { ArrowLeftRightIcon } from "lucide-react"
import { cn } from "cn"
import { useI18n } from "@/i18n"

/**
 * 表格容器统一处理窄屏横向裁切：
 * - `overflow-x-auto` + 显式滚动条（见 index.css），操作列可以滑到；
 * - 溢出时在**表格右上角**出现一条「左右滑动查看更多」提示。
 *
 * 提示放在滚动容器外、表格上方：它不会跟着内容一起滑走，也不会被右侧
 * sticky 操作列（z-20）盖住——之前绝对定位在 wrapper 右下角时，提示正好
 * 压在操作列下面，用户根本看不到。表格很长时页脚提示要滚到最底部才可见，
 * 所以固定在上沿；只有这个表格确实溢出时才会出现。
 */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  const { t } = useI18n()
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = React.useState(false)
  const [scrolled, setScrolled] = React.useState(false)

  React.useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const update = () => {
      setOverflowing(container.scrollWidth > container.clientWidth + 1)
      // 只有真的离开左端才让 sticky 列投影浮现；回到 0 后淡出。
      setScrolled(container.scrollLeft > 1)
    }

    update()
    container.addEventListener("scroll", update, { passive: true })

    // Shift + 滚轮横向滚动表格。部分浏览器/触控板只把 Shift+滚轮当成
    // 页面纵向滚动，表格本身动不了；这里显式接管（仅在没有 deltaX、
    // 且表格确实溢出时），让「表格能左右滑」这件事在鼠标上也成立。
    const onWheel = (event: WheelEvent) => {
      if (!event.shiftKey || event.deltaX !== 0 || event.deltaY === 0) return
      if (container.scrollWidth <= container.clientWidth + 1) return
      container.scrollLeft += event.deltaY
      event.preventDefault()
    }
    container.addEventListener("wheel", onWheel, { passive: false })

    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(container)
    const table = container.querySelector("table")
    if (table) resizeObserver.observe(table)

    // 数据从骨架屏换成真实行、或行内容宽度变化时重新判断是否溢出。
    const mutationObserver = new MutationObserver(update)
    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    return () => {
      container.removeEventListener("scroll", update)
      container.removeEventListener("wheel", onWheel)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [])

  return (
    <div data-slot="table-shell" className="relative">
      {overflowing ? (
        <div
          data-slot="table-scroll-hint"
          className="relative z-10 flex items-center justify-end border-b border-border bg-card px-2 py-1.5"
        >
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-popover/95 px-2 py-0.5 type-micro whitespace-nowrap text-muted-foreground">
            <ArrowLeftRightIcon className="size-3" aria-hidden="true" />
            {t("common.tableScrollHint")}
          </span>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        data-slot="table-container"
        data-overflowing={overflowing ? "true" : undefined}
        data-scrolled-x={scrolled ? "true" : undefined}
        className="relative w-full overflow-x-auto"
      >
        <table
          data-slot="table"
          className={cn("w-full caption-bottom text-sm", className)}
          {...props}
        />
      </div>

      {overflowing ? (
        <div
          data-slot="table-scroll-fade"
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-card via-card/70 to-transparent"
        />
      ) : null}

    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        // 行高基线 40px（docs/DESIGN.md「表格行高 40px」）：单元格用 py-1.5，
        // 28px 的操作按钮 / 24px 的头像都正好落进 40px；单行文本由 h-10 补足。
        // 多行内容应收进同一行（或收进 title），否则行高会突破基线。
        "h-10 border-b transition-colors duration-75 hover:bg-muted/40 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

type StickySide = "left" | "right";

/**
 * 横向滚动时固定首列 / 操作列。
 *
 * 固定列不画分隔线：整张表靠行边框分隔，再加一条竖线会让固定的两列看起来
 * 像独立的「侧栏」，与表格主体割裂。固定列只需要不透明背景（由
 * index.css 按表头 / 行状态设置），滚动内容不会透出来。
 *
 * 「内容从固定列下面滑过」用一层内嵌的柔和投影提示：投影放在 sticky
 * 单元格内部的 absolute span 上，而不是 td 自己身上 —— 表格是
 * border-collapse: collapse，td 的 box-shadow 会被单元格边界裁掉。
 */
const stickyClasses: Record<StickySide, string> = {
  left: "sticky left-0 z-20",
  right: "sticky right-0 z-20",
};

/**
 * 仅当 `stickyShadow` 打开时渲染。是否可见由 Table 容器上的
 * `data-scrolled-x` 控制（index.css 里做 opacity 过渡）：
 * 未横向滚动时不出现任何阴影，滚回左端后淡出。
 */
function StickyScrollShadow({ side }: { side: StickySide }) {
  return (
    <span
      aria-hidden="true"
      data-slot="sticky-scroll-shadow"
      data-side={side}
    />
  );
}

function TableHead({
  className,
  sticky,
  stickyShadow,
  children,
  ...props
}: React.ComponentProps<"th"> & {
  sticky?: StickySide;
  /** 该固定列是否需要在滚动时投射内侧柔和阴影。 */
  stickyShadow?: boolean;
}) {
  return (
    <th
      data-slot="table-head"
      data-sticky={sticky}
      className={cn(
        "h-10 px-2 text-left align-middle font-[550] whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        sticky && stickyClasses[sticky],
        className
      )}
      {...props}
    >
      {stickyShadow && sticky ? <StickyScrollShadow side={sticky} /> : null}
      {children}
    </th>
  )
}

function TableCell({
  className,
  sticky,
  stickyShadow,
  children,
  ...props
}: React.ComponentProps<"td"> & {
  sticky?: StickySide;
  /** 该固定列是否需要在滚动时投射内侧柔和阴影。 */
  stickyShadow?: boolean;
}) {
  return (
    <td
      data-slot="table-cell"
      data-sticky={sticky}
      className={cn(
        // 与 TableRow 的 40px 基线配套：28px 的按钮 + 12px 上下内边距 = 40px。
        "px-2 py-1.5 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        sticky && stickyClasses[sticky],
        className
      )}
      {...props}
    >
      {stickyShadow && sticky ? <StickyScrollShadow side={sticky} /> : null}
      {children}
    </td>
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
