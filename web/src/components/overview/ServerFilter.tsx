import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FilterIcon,
  SearchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  scopeGroupRows,
  type ScopeGroupRow,
  type ScopeServer,
} from "@/lib/overviewScope";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

interface FilterGroup extends ScopeGroupRow {
  /** 当前搜索下要展示的服务器；空数组表示整组被过滤掉。 */
  visibleServers: ScopeServer[];
  /** 组名本身命中搜索时，组内服务器全部保留。 */
  nameMatched: boolean;
}

function groupLabel(group: ScopeGroupRow): string {
  return group.name ?? t("overview.scope.ungrouped");
}

/**
 * 概览级筛选器：四个 tab 共用同一份选中集合。
 *
 * 弹层是一棵可折叠的「分组 → 服务器」树：
 * - 组行：点复选框选中 / 取消整组（支持全选 / 半选 / 未选三态），
 *   点组名只展开 / 收起，不改选择；
 * - 服务器行：逐台勾选；
 * - 搜索同时匹配组名与服务器名，命中的组自动展开；
 * - 底部全选 / 清空在搜索时只作用于当前结果，并写明作用范围。
 *
 * 展开状态是纯 UI 状态，不写入 URL；选择结果由父组件写入 `?servers=`。
 */
export function ServerFilter({
  servers,
  selectedIds,
  onChange,
}: {
  servers: readonly ScopeServer[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const contentRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allIds = useMemo(() => servers.map((server) => server.id), [servers]);
  const needle = query.trim().toLocaleLowerCase();
  const searching = needle !== "";

  const tree = useMemo<FilterGroup[]>(() => {
    const byId = new Map(servers.map((server) => [server.id, server]));
    const rows = scopeGroupRows(servers).map((group) => {
      const groupServers = group.ids
        .map((id) => byId.get(id))
        .filter((server): server is ScopeServer => server !== undefined);
      const label = group.name ?? t("overview.scope.ungrouped");
      const nameMatched =
        needle !== "" && label.toLocaleLowerCase().includes(needle);
      const visibleServers =
        needle === "" || nameMatched
          ? groupServers
          : groupServers.filter(
              (server) =>
                server.name.toLocaleLowerCase().includes(needle) ||
                server.id.toLocaleLowerCase().includes(needle),
            );
      return { ...group, visibleServers, nameMatched };
    });
    return needle === ""
      ? rows
      : rows.filter(
          (group) => group.nameMatched || group.visibleServers.length > 0,
        );
  }, [locale, needle, servers]);

  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const group of tree) {
      for (const server of group.visibleServers) ids.push(server.id);
    }
    return ids;
  }, [tree]);

  function update(ids: readonly string[]) {
    onChange([...new Set(ids)]);
  }

  function groupState(group: FilterGroup): boolean | "indeterminate" {
    const count = group.ids.filter((id) => selected.has(id)).length;
    if (count === 0) return false;
    if (count === group.ids.length) return true;
    return "indeterminate";
  }

  function toggleGroup(group: FilterGroup, checked: boolean) {
    if (checked) {
      update([...selectedIds, ...group.ids]);
    } else {
      const remove = new Set(group.ids);
      update(selectedIds.filter((id) => !remove.has(id)));
    }
  }

  function toggleServer(id: string, checked: boolean) {
    if (checked) {
      if (!selected.has(id)) update([...selectedIds, id]);
    } else {
      update(selectedIds.filter((item) => item !== id));
    }
  }

  function toggleExpanded(key: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * 全选 / 清空的作用域：有搜索词时只动搜索结果，否则动全部。
   * 全选是「并集」——不会把搜索结果之外的已选服务器悄悄取消。
   */
  function selectVisible() {
    if (!searching) {
      update(allIds);
      return;
    }
    update([...selectedIds, ...visibleIds]);
  }

  function clearVisible() {
    if (!searching) {
      update([]);
      return;
    }
    const remove = new Set(visibleIds);
    update(selectedIds.filter((id) => !remove.has(id)));
  }

  function focusRows(): HTMLElement[] {
    return [
      ...(contentRef.current?.querySelectorAll<HTMLElement>(
        "[data-server-filter-row]",
      ) ?? []),
    ];
  }

  /**
   * 键盘：↑/↓ 在组行与服务器行之间移动，空格勾选当前行，Esc 关闭。
   * 复选框自身仍可用 Tab + 空格操作；这里的空格只在行本身获得焦点时生效。
   */
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }

    const rows = focusRows();
    if (rows.length === 0) return;
    const target = event.target as HTMLElement;
    const activeRow = target.closest<HTMLElement>("[data-server-filter-row]");
    const currentIndex = activeRow ? rows.indexOf(activeRow) : -1;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        currentIndex === -1
          ? step > 0
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, currentIndex + step));
      rows[nextIndex]?.focus();
      return;
    }

    if (event.key !== " " && event.key !== "Enter") return;
    // 搜索框、复选框自己处理空格；只有行本身聚焦时才在这里切换。
    if (currentIndex === -1 || target !== activeRow) return;
    event.preventDefault();

    const groupKey = activeRow.dataset.serverFilterGroup;
    if (groupKey) {
      const group = tree.find((row) => row.key === groupKey);
      if (group) toggleGroup(group, groupState(group) !== true);
      return;
    }
    const serverId = activeRow.dataset.serverFilterItem;
    if (serverId) toggleServer(serverId, !selected.has(serverId));
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          // 默认折叠：先看到分组与数量，再按需展开。
          setExpanded(new Set());
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          data-server-filter-trigger
          aria-label={t("overview.scope.aria")}
        >
          <FilterIcon />
          {t("overview.scope.trigger", {
            selected: selectedIds.length,
            total: servers.length,
          })}
          <ChevronDownIcon
            className={cn(
              "size-3.5 transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        collisionPadding={12}
        onKeyDown={handleKeyDown}
        className="w-[min(23rem,calc(100vw-2rem))] max-h-[min(28rem,calc(100dvh-2rem))] gap-0 p-0"
        data-server-filter-content
      >
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            data-server-filter-search
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("overview.scope.search")}
            aria-label={t("overview.scope.search")}
            className="h-7 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
            autoFocus
          />
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto p-1"
          role="group"
          aria-label={t("overview.scope.aria")}
        >
          {servers.length === 0 ? (
            <p className="px-2 py-5 text-center text-xs text-muted-foreground">
              {t("overview.scope.noServers")}
            </p>
          ) : tree.length === 0 ? (
            <p
              data-server-filter-no-result
              className="px-2 py-5 text-center text-xs text-muted-foreground"
            >
              {t("overview.scope.noResult")}
            </p>
          ) : (
            tree.map((group) => {
              const state = groupState(group);
              const isExpanded = searching || expanded.has(group.key);
              const label = groupLabel(group);
              return (
                <div key={group.key} data-server-filter-section>
                  <div
                    data-server-filter-row
                    data-server-filter-group={group.key}
                    tabIndex={-1}
                    aria-expanded={isExpanded}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1.5 outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (!searching) toggleExpanded(group.key);
                      }}
                      aria-expanded={isExpanded}
                      aria-label={t(
                        isExpanded
                          ? "overview.scope.collapseGroup"
                          : "overview.scope.expandGroup",
                        { name: label },
                      )}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs"
                    >
                      <ChevronRightIcon
                        aria-hidden="true"
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                          isExpanded && "rotate-90",
                        )}
                      />
                      <span className="min-w-0 truncate">{label}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                        {t("overview.scope.groupCount", {
                          n: group.ids.length,
                        })}
                      </span>
                    </button>
                    <Checkbox
                      checked={state}
                      onCheckedChange={(checked) =>
                        toggleGroup(group, checked === true)
                      }
                      data-group-checkbox
                      aria-label={t("overview.scope.groupAria", {
                        name: label,
                        n: group.ids.length,
                      })}
                    />
                  </div>
                  {isExpanded
                    ? group.visibleServers.map((server) => (
                        <div
                          key={server.id}
                          data-server-filter-row
                          data-server-filter-item={server.id}
                          tabIndex={-1}
                          className="ml-4 flex items-center gap-2 rounded-md py-1.5 pr-1.5 pl-2 outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50"
                        >
                          <Checkbox
                            checked={selected.has(server.id)}
                            onCheckedChange={(checked) =>
                              toggleServer(server.id, checked === true)
                            }
                            data-server-filter-item-checkbox
                            aria-label={server.name}
                            tabIndex={-1}
                          />
                          <span
                            aria-hidden="true"
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              server.status === "online"
                                ? "bg-primary"
                                : server.status === "offline"
                                  ? "bg-destructive"
                                  : "bg-muted-foreground/40",
                            )}
                          />
                          <span
                            className="min-w-0 flex-1 truncate"
                            title={server.name}
                          >
                            {server.name}
                          </span>
                          <span className="max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground">
                            {server.group_name?.trim() ||
                              t("overview.scope.ungrouped")}
                          </span>
                        </div>
                      ))
                    : null}
                </div>
              );
            })
          )}
        </div>

        <div className="border-t border-border px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {t("overview.scope.trigger", {
                selected: selectedIds.length,
                total: servers.length,
              })}
            </span>
            <div className="flex items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                data-server-filter-all
                onClick={selectVisible}
              >
                {t(
                  searching
                    ? "overview.scope.selectAllResults"
                    : "overview.scope.selectAll",
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                data-server-filter-clear
                onClick={clearVisible}
              >
                {t(
                  searching
                    ? "overview.scope.clearResults"
                    : "overview.scope.clear",
                )}
              </Button>
            </div>
          </div>
          <p className="mt-1 text-[10px] leading-normal text-muted-foreground">
            {t(
              searching
                ? "overview.scope.scopeResults"
                : "overview.scope.scopeAll",
              {
                n: searching ? visibleIds.length : servers.length,
              },
            )}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
