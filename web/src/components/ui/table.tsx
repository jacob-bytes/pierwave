"use client"

import * as React from "react"
import { ArrowLeftRightIcon } from "lucide-react"
import { cn } from "cn"
import { useI18n } from "@/i18n"

/**
 * 表格容器统一处理窄屏横向裁切：
 * - `overflow-x-auto` + 显式滚动条（见 index.css），操作列可以滑到；
 * - 溢出时右侧出现渐隐遮罩与「左右滑动查看更多」提示，滚动到末尾后消失。
 *
 * 提示与遮罩都是绝对定位，不占据文档流，因此不会引入 layout shift。
 */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  const { t } = useI18n()
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = React.useState(false)
  const [atEnd, setAtEnd] = React.useState(false)

  React.useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const update = () => {
      const overflowing = container.scrollWidth > container.clientWidth + 1
      setOverflowing(overflowing)
      setAtEnd(
        !overflowing ||
          container.scrollLeft + container.clientWidth >=
            container.scrollWidth - 1,
      )
    }

    update()
    container.addEventListener("scroll", update, { passive: true })

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
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [])

  return (
    <div data-slot="table-shell" className="relative">
      <div
        ref={scrollRef}
        data-slot="table-container"
        data-overflowing={overflowing ? "true" : undefined}
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
          aria-hidden="true"
          data-slot="table-scroll-fade"
          className={cn(
            "pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-card via-card/70 to-transparent transition-opacity duration-150",
            atEnd && "opacity-0",
          )}
        />
      ) : null}

      {overflowing && !atEnd ? (
        <div
          data-slot="table-scroll-hint"
          className="pointer-events-none absolute right-2 bottom-2 z-10 inline-flex items-center gap-1 rounded-full border border-border bg-popover/95 px-2 py-0.5 text-[11px] whitespace-nowrap text-muted-foreground shadow-sm"
        >
          <ArrowLeftRightIcon className="size-3" aria-hidden="true" />
          {t("common.tableScrollHint")}
        </div>
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
        "border-b transition-colors duration-75 hover:bg-muted/40 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
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
