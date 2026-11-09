import type { ReactNode } from "react";
import {
  LayoutGridIcon,
  ListIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useI18n } from "@/i18n";
import type { StatusFilter, StatusView } from "@/lib/publicStatus";
import { cn } from "@/lib/utils";

type Segment<T extends string> = {
  value: T;
  label: string;
  title?: string;
  icon?: ReactNode;
  count?: number;
};

/**
 * 与参考项目同款的 segmented 控件：一个带边框的容器里放互斥的选项。
 * 状态标签与视图切换共用，尺寸与工具栏里的搜索框统一为 32px 高。
 */
function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md border border-border bg-card p-0.5",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => onChange(item.value)}
            aria-pressed={active}
            aria-label={item.label === "" ? item.title : undefined}
            title={item.title}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded text-xs whitespace-nowrap transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
              item.label === "" ? "px-1.5" : "px-2",
              active
                ? "bg-accent font-medium text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined ? (
              <span
                className={cn(
                  "tnum min-w-[18px] rounded-full px-1 text-center text-micro font-medium",
                  active
                    ? "bg-primary/15 text-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 汇总与列表之间的一行：状态标签、清除筛选、命中数量、搜索、视图切换。
 * 与参考项目的 `Toolbar` 同一个信息层次 —— 这一行只放「作用于下方列表」
 * 的控件，不再重复汇总里已有的总数。
 */
export function Toolbar({
  counts,
  total,
  filter,
  onFilter,
  query,
  onQuery,
  view,
  onView,
  narrowing,
  onClear,
}: {
  /** 已经按搜索筛过的计数；标签上的数字与点下去看到的结果一致。 */
  counts: Record<StatusFilter, number>;
  /** 服务器总数，只用于「已显示 / 总数」。 */
  total: number;
  filter: StatusFilter;
  onFilter: (filter: StatusFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  view: StatusView;
  onView: (view: StatusView) => void;
  /** 搜索或标签是否正在收窄列表：只在有隐藏时显示清除与计数。 */
  narrowing: boolean;
  onClear: () => void;
}) {
  const { t } = useI18n();

  const filters: Segment<StatusFilter>[] = [
    { value: "all", label: t("publicStatus.filter.all"), count: counts.all },
    {
      value: "online",
      label: t("publicStatus.filter.online"),
      count: counts.online,
    },
    {
      value: "offline",
      label: t("publicStatus.filter.offline"),
      count: counts.offline,
    },
    {
      value: "abnormal",
      label: t("publicStatus.filter.abnormal"),
      count: counts.abnormal,
    },
  ];

  const views: Segment<StatusView>[] = [
    {
      value: "grid",
      label: "",
      title: t("publicStatus.toolbar.gridView"),
      icon: <LayoutGridIcon className="size-3.5" aria-hidden="true" />,
    },
    {
      value: "list",
      label: "",
      title: t("publicStatus.toolbar.listView"),
      icon: <ListIcon className="size-3.5" aria-hidden="true" />,
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
      <Segmented
        items={filters}
        value={filter}
        onChange={onFilter}
        label={t("publicStatus.toolbar.filter")}
      />

      {narrowing ? (
        <>
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-8 items-center rounded px-1 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            {t("publicStatus.toolbar.clearFilters")}
          </button>
          <span className="tnum inline-flex h-8 items-center px-1 text-xs text-muted-foreground">
            {t("publicStatus.toolbar.shown", {
              shown: counts[filter],
              total,
            })}
          </span>
        </>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <label className="relative inline-flex h-8 items-center">
          <SearchIcon
            className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder={t("publicStatus.toolbar.searchPlaceholder")}
            aria-label={t("publicStatus.toolbar.searchAria")}
            className="h-8 w-40 rounded-md border border-input bg-card pr-7 pl-7 text-xs outline-none transition placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 sm:w-52 dark:bg-card [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query !== "" ? (
            <button
              type="button"
              onClick={() => onQuery("")}
              aria-label={t("publicStatus.toolbar.clearSearch")}
              className="absolute right-1.5 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </label>

        <Segmented
          items={views}
          value={view}
          onChange={onView}
          label={t("publicStatus.toolbar.view")}
        />
      </div>
    </div>
  );
}
