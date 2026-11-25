import { useMemo, useState } from "react";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  chainLegendGroups,
  formatMs,
  type ChainHealthChain,
  type ChainLegendEntry,
} from "@/lib/chainHealth";
import { chainTrendSeriesP50 } from "@/lib/chainTrendSeries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";
import { lineVisual } from "@/lib/chainSeriesStyle";
import { LineSwatch } from "./ChainSeriesSwatch";

function matches(entry: ChainLegendEntry, needle: string): boolean {
  return entry.chain.name.toLocaleLowerCase().includes(needle);
}

/**
 * 链路时延趋势的图例下拉：24 条链时不再让图例折成三行把图表往下压。
 *
 * - 卡头右侧只放一个「显示 5 / 15」按钮，弹层里是搜索 + 全选 / 清空 +
 *   每条有样本链的复选框（线型色块 + 名称 + 当前 P50）；
 * - 无样本链不进入选择，仍折叠在「N 条暂无样本」里（搜索时直接展开匹配项）；
 * - 选择结果由父组件写入 `?series=`，这里只汇报完整的勾选集合。
 */
export function ChainSeriesSelect({
  chains,
  selectedIds,
  onChange,
}: {
  chains: readonly ChainHealthChain[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showUnsampled, setShowUnsampled] = useState(false);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const groups = useMemo(() => chainLegendGroups(chains), [chains]);
  const sampledIds = useMemo(
    () => new Set(groups.sampled.map((entry) => entry.chain.id)),
    [groups],
  );
  const total = groups.sampled.length;
  const selectedCount = groups.sampled.filter((entry) =>
    selected.has(entry.chain.id),
  ).length;

  const needle = query.trim().toLocaleLowerCase();
  const searching = needle !== "";
  const visibleSampled = useMemo(
    () =>
      searching
        ? groups.sampled.filter((entry) => matches(entry, needle))
        : groups.sampled,
    [groups.sampled, needle, searching],
  );
  const visibleUnsampled = useMemo(
    () =>
      searching
        ? groups.unsampled.filter((entry) => matches(entry, needle))
        : groups.unsampled,
    [groups.unsampled, needle, searching],
  );

  /** 结果集按链列表顺序回写，URL 顺序稳定，颜色 / 线型不跳。 */
  function commit(next: ReadonlySet<string>) {
    onChange(
      chains
        .filter((chain) => next.has(chain.id) && sampledIds.has(chain.id))
        .map((chain) => chain.id),
    );
  }

  function toggle(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    commit(next);
  }

  /** 全选 / 清空始终作用于全部有样本链；搜索只负责找行，不改变按钮语义。 */
  function selectAll() {
    commit(new Set(sampledIds));
  }

  function clearAll() {
    commit(new Set());
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setShowUnsampled(false);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-chain-series-trigger
          data-selected-count={selectedCount}
          aria-label={t("overview.chainLatency.seriesSelectAria", {
            selected: selectedCount,
            total,
          })}
          className="h-8 gap-1.5 px-2 text-xs font-normal whitespace-nowrap"
        >
          {t("overview.chainLatency.seriesSelectTrigger", {
            selected: selectedCount,
            total,
          })}
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={12}
        data-chain-series-content
        className="w-[min(21rem,calc(100vw-2rem))] max-h-[min(26rem,calc(100dvh-2rem))] gap-0 p-0"
      >
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            data-chain-series-search
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("overview.chainLatency.seriesSearch")}
            aria-label={t("overview.chainLatency.seriesSearch")}
            className="h-7 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
            autoFocus
          />
        </div>

        <div
          role="group"
          aria-label={t("overview.chainLatency.seriesSelectAria", {
            selected: selectedCount,
            total,
          })}
          className="min-h-0 flex-1 overflow-y-auto p-1"
        >
          {total === 0 ? (
            <p className="px-2 py-5 text-center text-xs text-muted-foreground">
              {t("overview.chainLatency.noSamplesShort")}
            </p>
          ) : null}

          {visibleSampled.map(({ chain, index }) => (
            <div
              key={chain.id}
              data-chain-series-row
              data-chain-id={chain.id}
              className="flex min-h-6 items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-muted/50"
            >
              <Checkbox
                checked={selected.has(chain.id)}
                onCheckedChange={(checked) =>
                  toggle(chain.id, checked === true)
                }
                data-chain-series-checkbox
                aria-label={t("overview.chainLatency.seriesToggleAria", {
                  name: chain.name,
                })}
              />
              <LineSwatch visual={lineVisual(index)} />
              <span className="min-w-0 flex-1 truncate" title={chain.name}>
                {chain.name}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                {formatMs(chainTrendSeriesP50(chain))}
              </span>
            </div>
          ))}

          {searching &&
          visibleSampled.length === 0 &&
          visibleUnsampled.length === 0 ? (
            <p
              data-chain-series-no-match
              className="px-2 py-5 text-center text-xs text-muted-foreground"
            >
              {t("overview.chainLatency.seriesNoMatch")}
            </p>
          ) : null}

          {visibleUnsampled.length === 0 ? null : searching || showUnsampled ? (
            <div
              data-chain-legend-unsampled-list
              className="mt-1 flex flex-col gap-1 border-t border-border/60 pt-1"
            >
              {visibleUnsampled.map(({ chain, index }) => (
                <span
                  key={chain.id}
                  data-chain-legend-unsampled-item
                  data-chain-id={chain.id}
                  className="inline-flex min-h-6 items-center gap-2 px-1.5 text-[11px] text-muted-foreground opacity-80"
                >
                  <LineSwatch visual={lineVisual(index, true)} />
                  <span className="min-w-0 flex-1 truncate" title={chain.name}>
                    {chain.name}
                  </span>
                  <span className="shrink-0">
                    {t("overview.chainLatency.noSamplesShort")}
                  </span>
                </span>
              ))}
            </div>
          ) : (
            <button
              type="button"
              data-chain-legend-unsampled-toggle
              aria-expanded={showUnsampled}
              aria-label={t("overview.chainLatency.noSamplesGroupAria", {
                n: visibleUnsampled.length,
              })}
              onClick={() => setShowUnsampled((value) => !value)}
              className="mt-1 inline-flex min-h-6 w-full items-center gap-1 rounded-md border-t border-border/60 px-1.5 py-1 text-[11px] text-muted-foreground opacity-70 transition-opacity duration-150 hover:bg-muted/40 hover:opacity-100"
            >
              <span data-chain-legend-unsampled-count>
                {t("overview.chainLatency.noSamplesGroup", {
                  n: visibleUnsampled.length,
                })}
              </span>
              <ChevronDownIcon
                aria-hidden="true"
                className={cn(
                  "size-3 transition-transform duration-150",
                  showUnsampled && "rotate-180",
                )}
              />
            </button>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-2.5 py-2">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {t("overview.chainLatency.seriesSelectTrigger", {
              selected: selectedCount,
              total,
            })}
          </span>
          <div className="flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              data-chain-series-all
              disabled={total === 0}
              onClick={selectAll}
            >
              {t("overview.chainLatency.seriesSelectAll")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              data-chain-series-clear
              disabled={total === 0}
              onClick={clearAll}
            >
              {t("overview.chainLatency.seriesClear")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
