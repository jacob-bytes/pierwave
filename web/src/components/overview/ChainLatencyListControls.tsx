import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_CHAIN_LIST_SORT,
  chainListSortDefaultDirection,
  type ChainListSort,
  type ChainListSortDirection,
  type ChainListSortKey,
  type ChainListStatusCounts,
  type ChainListStatusFilter,
  visibleChainListStatuses,
} from "@/lib/chainListFilters";
import { CHAIN_STATE_LABEL_KEYS } from "@/lib/chainStatusText";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** 状态文案复用徽章同一套 i18n 键，避免筛选项与徽章各叫各的。 */
const STATUS_LABEL_KEYS: Record<ChainListStatusFilter, string> = {
  all: "overview.chainLatency.filterAll",
  ok: CHAIN_STATE_LABEL_KEYS.ok,
  degraded: CHAIN_STATE_LABEL_KEYS.degraded,
  blocked: CHAIN_STATE_LABEL_KEYS.blocked,
  unknown: CHAIN_STATE_LABEL_KEYS.unknown,
  insufficient: CHAIN_STATE_LABEL_KEYS.insufficient,
  disabled: CHAIN_STATE_LABEL_KEYS.disabled,
};

export function chainListStatusLabel(status: ChainListStatusFilter): string {
  return t(STATUS_LABEL_KEYS[status]);
}

/** 搜索框：即时过滤 + 清除按钮；没有输入时不占位渲染按钮。 */
export function ChainLatencySearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  useI18n();
  return (
    <div className="relative w-full min-w-0 sm:w-72 sm:flex-none">
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("overview.chainLatency.searchPlaceholder")}
        aria-label={t("overview.chainLatency.searchAria")}
        data-chain-search
        className="h-8 pr-8 pl-8 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value === "" ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("overview.chainLatency.searchClear")}
          data-chain-search-clear
          onClick={() => onChange("")}
          className="absolute top-1/2 right-1 size-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

/**
 * 状态筛选下拉：数量由调用方按「关键词过滤后的集合」算好，这样搜索时
 * 每一档的数量会跟着收窄，而选中状态本身不会把其它档位清成 0。
 */
export function ChainLatencyStatusFilter({
  value,
  counts,
  onChange,
}: {
  value: ChainListStatusFilter;
  counts: ChainListStatusCounts;
  onChange: (value: ChainListStatusFilter) => void;
}) {
  useI18n();
  const options: ChainListStatusFilter[] = [
    "all",
    ...visibleChainListStatuses(counts),
  ];
  // 深链接可能带一个当前数据里没有的档位（例如分享时还有停用链，现在没了）：
  // 仍保留该档位，让触发器和空态说的是同一个状态，而不是显示空白。
  if (value !== "all" && !options.includes(value)) options.push(value);
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (options.includes(next as ChainListStatusFilter)) {
          onChange(next as ChainListStatusFilter);
        }
      }}
    >
      <SelectTrigger
        size="sm"
        data-chain-status-filter
        data-active={value === "all" ? "false" : "true"}
        aria-label={t("overview.chainLatency.filterAria")}
        className={cn(
          "h-8 shrink-0 gap-1.5",
          value !== "all" && "border-primary/40 bg-primary/5 text-foreground",
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" className="min-w-44">
        {options.map((option) => (
          <SelectItem
            key={option}
            value={option}
            data-chain-status-option={option}
            className="pr-8"
          >
            <span className="flex w-full items-center justify-between gap-4">
              <span>{chainListStatusLabel(option)}</span>
              <span
                data-chain-status-count={option}
                className="text-[11px] text-muted-foreground tabular-nums"
              >
                {counts[option]}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function sortValue(sort: ChainListSort): string {
  return sort.key === "default" ? "default" : `${sort.key}-${sort.direction}`;
}

function parseSortValue(value: string): ChainListSort | null {
  if (value === "default") return DEFAULT_CHAIN_LIST_SORT;
  const [key, direction] = value.split("-");
  if (
    (key === "p50" || key === "loss" || key === "latest") &&
    (direction === "asc" || direction === "desc")
  ) {
    return { key, direction };
  }
  return null;
}

export function chainListSortLabel(key: ChainListSortKey): string {
  if (key === "default") return t("overview.chainLatency.sortDefault");
  if (key === "p50") return t("overview.chainLatency.sortP50");
  if (key === "loss") return t("overview.chainLatency.sortLoss");
  return t("overview.chainLatency.sortLatest");
}

function directionLabel(direction: ChainListSortDirection): string {
  return t(
    direction === "asc"
      ? "overview.chainLatency.sortAsc"
      : "overview.chainLatency.sortDesc",
  );
}

/** 排序下拉：7 项足够放下三种维度 × 升降序，不额外拆一个方向按钮。 */
export function ChainLatencySortFilter({
  value,
  onChange,
}: {
  value: ChainListSort;
  onChange: (value: ChainListSort) => void;
}) {
  useI18n();
  const options: ChainListSort[] = [
    DEFAULT_CHAIN_LIST_SORT,
    ...(["p50", "loss", "latest"] as const).flatMap((key) => [
      { key, direction: chainListSortDefaultDirection(key) },
      {
        key,
        direction:
          chainListSortDefaultDirection(key) === "asc"
            ? ("desc" as const)
            : ("asc" as const),
      },
    ]),
  ];
  return (
    <Select
      value={sortValue(value)}
      onValueChange={(next) => {
        const parsed = parseSortValue(next);
        if (parsed) onChange(parsed);
      }}
    >
      <SelectTrigger
        size="sm"
        data-chain-sort
        aria-label={t("overview.chainLatency.sortAria")}
        className="h-8 shrink-0 gap-1.5"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" className="min-w-40">
        {options.map((option) => {
          const label =
            option.key === "default"
              ? chainListSortLabel("default")
              : t("overview.chainLatency.sortOption", {
                  label: chainListSortLabel(option.key),
                  direction: directionLabel(option.direction),
                });
          return (
            <SelectItem
              key={sortValue(option)}
              value={sortValue(option)}
              data-chain-sort-option={sortValue(option)}
            >
              {label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/**
 * 桌面表头的排序按钮：点击切换升降序，当前维度显示方向箭头。
 * 最近样本没有独立列，由卡头的排序下拉覆盖。
 */
export function ChainLatencySortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: Exclude<ChainListSortKey, "default">;
  sort: ChainListSort;
  onSort: (key: Exclude<ChainListSortKey, "default">) => void;
}) {
  useI18n();
  const active = sort.key === sortKey;
  const direction = active ? sort.direction : chainListSortDefaultDirection(sortKey);
  const Icon = active
    ? sort.direction === "asc"
      ? ArrowUpIcon
      : ArrowDownIcon
    : ArrowUpDownIcon;
  return (
    <button
      type="button"
      data-chain-sort-header={sortKey}
      aria-label={t("overview.chainLatency.sortBy", {
        label,
        direction: directionLabel(direction),
      })}
      onClick={() => onSort(sortKey)}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-sm text-left outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span className="truncate">{label}</span>
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3 shrink-0",
          active ? "opacity-100" : "opacity-40",
        )}
      />
    </button>
  );
}
