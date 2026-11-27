import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Tabs as TabsPrimitive } from "radix-ui"
import { SlidingIndicator } from "@/components/ui/sliding-indicator"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  // `justify-start` 而不是 `justify-center`：`overflow-x-auto` 下居中会把两端
  // 内容推到负坐标，左侧的「General」永远滑不到（见 UI-AUDIT P1-2）。
  "group/tabs-list relative inline-flex w-fit items-center justify-start rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 max-sm:h-12 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  const listRef = React.useRef<HTMLDivElement>(null)

  /*
   * 当前 tab 可能因为英文标签更宽而落在可视区外。`data-state` 变化时把
   * 激活项滚回可视区；只在列表确实横向溢出时执行，避免带动整页滚动。
   */
  React.useEffect(() => {
    const list = listRef.current
    if (!list) return

    const revealActive = () => {
      if (list.scrollWidth <= list.clientWidth + 1) return
      const active = list.querySelector<HTMLElement>(
        '[data-slot="tabs-trigger"][data-state="active"]',
      )
      if (!active) return
      const listRect = list.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      if (
        activeRect.left >= listRect.left &&
        activeRect.right <= listRect.right
      ) {
        return
      }
      active.scrollIntoView({ inline: "nearest", block: "nearest" })
    }

    revealActive()
    const observer = new MutationObserver(revealActive)
    observer.observe(list, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    })
    return () => observer.disconnect()
  }, [])

  return (
    <TabsPrimitive.List
      ref={listRef}
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {/*
        选中底色 / 下划线 / 阴影由指示器承担：触发器不再各自涂背景，
        切换时只有一个元素滑动，而不是旧背景瞬间消失、新背景瞬间出现。
      */}
      <SlidingIndicator
        containerRef={listRef}
        activeSelector='[data-slot="tabs-trigger"][data-state="active"]'
        placement={variant === "line" ? "underline" : "pill"}
        className={
          variant === "line"
            ? "rounded-none bg-primary"
            : "rounded-md border border-transparent bg-primary shadow-sm dark:border-input dark:bg-input/30"
        }
      />
      {children}
    </TabsPrimitive.List>
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        // 底色 / 边框 / 阴影 / 下划线都由 TabsList 里的 SlidingIndicator 画，
        // 这里只保留文字色与焦点环：同一个强调色，切换时只有指示器在动。
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 max-sm:min-w-10 max-sm:flex-none rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-all data-[state=active]:text-primary-foreground group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // `data-active` 在 shadcn 的预设里等价于 `[data-state=active]`，暗色下
        // 文字用 foreground 而不是 primary-foreground（与指示器的暗色底配对）。
        "data-active:text-foreground dark:data-active:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      // Radix 的 tabpanel 可聚焦，但焦点环不在这里单独声明（`outline-none`
      // 只是基础重置，index.css 里未分层的统一规则优先级更高）：键盘焦点
      // 进入面板时由那条规则画出 2px 环、偏移 2px；指针模态下由
      // `html[data-input="pointer"] :focus-visible` 清掉。
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
