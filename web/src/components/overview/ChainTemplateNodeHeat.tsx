import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPercentValue } from "@/lib/chainHealth";
import {
  chainTemplateNodeHeat,
  type ChainTemplateDetail,
  type ChainTemplateMemberStatus,
  type ChainTemplateNodeHeatRow,
} from "@/lib/chainTemplateInsight";
import {
  placeNodeHeatTooltip,
  type NodeHeatTooltipPlacement,
} from "@/lib/nodeHeatTooltip";
import { useI18n, type TFunction } from "@/i18n";
import { cn } from "@/lib/utils";

function statusText(
  status: ChainTemplateMemberStatus,
  translate: TFunction,
): string {
  if (status === "offline") return translate("overview.chainTemplateInsight.offline");
  if (status === "online") return translate("overview.chainTemplateInsight.online");
  if (status === "degraded") return translate("overview.chainTemplateInsight.degraded");
  return translate("overview.chainTemplateInsight.unknownStatus");
}

/**
 * 条形色：最高热点用满 primary，其余略浅；离线成员用 muted 底 + destructive
 * 文字标状态，不把离线画成第二个强调色。
 */
function barClass(row: ChainTemplateNodeHeatRow, index: number): string {
  if (row.status === "offline") return "bg-muted-foreground/40";
  return index === 0 ? "bg-primary" : "bg-primary/60";
}

function statusClass(status: ChainTemplateMemberStatus): string {
  if (status === "offline") return "text-destructive";
  if (status === "degraded") return "text-warning";
  return "text-muted-foreground";
}

/**
 * 节点热度：横向条形图，Top 5 节点按使用链数降序。
 *
 * 不使用饼图：同一节点会在多条链的每一跳被重复计入（这里按 serverId 取
 * 最大值合并），各节点链数之和远大于模板链数，饼图扇区之和没有业务含义。
 * 条形只做相对长短比较，占比分母是模板总链数。
 *
 * 明细浮层用 `absolute` 挂在卡片里（定位见 `placeNodeHeatTooltip`），不占
 * 文档流：hover / focus 都不会改变卡片高度，也不会把同一行的另一张卡拉长。
 * 贴边时翻转或夹紧，永不出卡片；Esc 只收起浮层，不连带关掉整个弹窗。
 *
 * The detail overlay is `absolute` inside the card, so hovering or focusing a
 * row never changes card height or stretches the neighbouring card. It flips
 * or clamps at the card edges, and Esc dismisses only the overlay.
 */
export function ChainTemplateNodeHeat({
  detail,
}: {
  detail: ChainTemplateDetail;
}) {
  const { t: translate } = useI18n();
  const heat = useMemo(() => chainTemplateNodeHeat(detail), [detail]);
  const tooltipId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [placement, setPlacement] = useState<NodeHeatTooltipPlacement | null>(
    null,
  );
  const activeRow =
    heat.rows.find((row) => row.key === activeKey) ?? null;

  /** 用实测尺寸算一次位置；不写死 offset，长浮层 / 窄卡都能夹紧。 */
  const measure = useCallback(() => {
    const card = cardRef.current;
    const row =
      activeKey === null ? null : (rowRefs.current.get(activeKey) ?? null);
    const tooltip = tooltipRef.current;
    if (activeKey === null || !card || !row || !tooltip) {
      setPlacement(null);
      return;
    }
    const cardRect = card.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    // 弹窗滚动窗口：卡片被滚出上 / 下沿时浮层仍然留在可见区里。
    const scroll = card.closest<HTMLElement>("[data-template-dialog-scroll]");
    const scrollRect = scroll?.getBoundingClientRect() ?? null;
    const next = placeNodeHeatTooltip({
      anchor: {
        top: rowRect.top - cardRect.top,
        bottom: rowRect.bottom - cardRect.top,
        left: rowRect.left - cardRect.left,
        right: rowRect.right - cardRect.left,
      },
      size: { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
      container: { width: card.clientWidth, height: card.clientHeight },
      visible:
        scrollRect === null
          ? undefined
          : {
              top: scrollRect.top - cardRect.top,
              height: scroll?.clientHeight ?? 0,
            },
    });
    setPlacement((prev) =>
      prev !== null &&
      prev.x === next.x &&
      prev.y === next.y &&
      prev.below === next.below
        ? prev
        : next,
    );
  }, [activeKey]);

  // 浮层随行一起挂载：先量再画，避免在左上角闪一下。
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // 卡片宽度随弹窗 / 视口变化时重新夹紧，避免浮层越界。
  useEffect(() => {
    if (activeKey === null) return;
    const card = cardRef.current;
    const scroll =
      card?.closest<HTMLElement>("[data-template-dialog-scroll]") ?? null;
    const observer = new ResizeObserver(() => measure());
    if (card) observer.observe(card);
    window.addEventListener("resize", measure);
    scroll?.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      scroll?.removeEventListener("scroll", measure);
    };
  }, [activeKey, measure]);

  // Esc 只收起浮层：Radix Dialog 在 `document` 的**捕获阶段**监听 Escape，
  // 行内 onKeyDown（冒泡）拦不住它，所以在 window 捕获阶段先处理并阻止冒泡，
  // 第二次 Esc（浮层已收起、监听已移除）才关弹窗。
  useEffect(() => {
    if (activeKey === null) return;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setActiveKey(null);
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () =>
      window.removeEventListener("keydown", onKeyDownCapture, true);
  }, [activeKey]);

  const openRow = (key: string) => setActiveKey(key);
  const closeRow = (key: string) =>
    setActiveKey((current) => (current === key ? null : current));

  return (
    <Card
      ref={cardRef}
      className="relative min-w-0 gap-0"
      data-template-node-heat-card
    >
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-sm font-medium">
          {translate("overview.chainTemplateInsight.nodeHeatTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-1 flex-col p-3 sm:p-4">
        {heat.rows.length === 0 ? (
          <p
            data-template-node-heat-empty
            className="flex flex-1 items-center justify-center py-6 text-center text-xs text-muted-foreground"
          >
            {translate("overview.chainTemplateInsight.nodeHeatEmpty")}
          </p>
        ) : (
          <ul
            data-template-node-heat
            className="flex flex-col gap-1.5"
            aria-label={translate(
              "overview.chainTemplateInsight.nodeHeatListAria",
              { n: heat.rows.length },
            )}
          >
            {heat.rows.map((row, index) => {
              const barPct = Math.max(0, Math.min(100, row.barPct));
              const sharePct = Math.max(0, Math.min(100, row.sharePct));
              return (
                <li
                  key={row.key}
                  ref={(element) => {
                    if (element) rowRefs.current.set(row.key, element);
                    else rowRefs.current.delete(row.key);
                  }}
                  tabIndex={0}
                  data-template-heat-row
                  data-heat-key={row.key}
                  data-chains={row.chains}
                  data-users={row.users}
                  data-status={row.status}
                  data-share={Math.round(sharePct * 10) / 10}
                  aria-describedby={
                    activeKey === row.key ? tooltipId : undefined
                  }
                  aria-label={translate(
                    "overview.chainTemplateInsight.nodeHeatAria",
                    {
                      name: row.name,
                      chains: row.chains,
                      users: row.users,
                      status: statusText(row.status, translate),
                      pct: formatPercentValue(sharePct),
                    },
                  )}
                  onMouseEnter={() => openRow(row.key)}
                  onMouseLeave={() => closeRow(row.key)}
                  onFocus={() => openRow(row.key)}
                  onBlur={() => closeRow(row.key)}
                  className="min-w-0 -mx-2 rounded-md px-2 py-2 outline-none transition-colors duration-150 hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <div className="flex min-w-0 items-baseline justify-between gap-3">
                    <span
                      className="min-w-0 truncate text-xs text-foreground"
                      title={row.name}
                    >
                      {row.name}
                    </span>
                    <span
                      className="shrink-0 font-mono text-xs tabular-nums"
                      title={translate(
                        "overview.chainTemplateInsight.memberChains",
                        { n: row.chains },
                      )}
                    >
                      {row.chains}
                    </span>
                  </div>
                  <div
                    aria-hidden="true"
                    className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      data-template-heat-bar
                      data-width={Math.round(barPct * 100) / 100}
                      className={cn(
                        "block h-full rounded-full transition-[width] duration-150",
                        barClass(row, index),
                      )}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2 text-[11px] leading-tight">
                    <span className="min-w-0 truncate text-muted-foreground">
                      {translate("overview.chainTemplateInsight.usersValue", {
                        n: row.users,
                      })}
                    </span>
                    {row.status === "offline" ||
                    row.status === "degraded" ? (
                      <span
                        data-template-heat-status={row.status}
                        className={cn(
                          "shrink-0 font-medium",
                          statusClass(row.status),
                        )}
                      >
                        {statusText(row.status, translate)}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      {activeRow ? (
        // 绝对定位：不占文档流，卡片高度只由列表决定。pointer-events-none
        // 保证浮层不会挡住相邻行的 hover。
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          data-template-node-heat-tooltip
          data-placement={placement?.below ? "below" : "above"}
          data-clamped-x={placement?.clampedX ? "true" : "false"}
          data-clamped-y={placement?.clampedY ? "true" : "false"}
          className="pointer-events-none absolute z-20 w-56 max-w-full rounded-md border border-border bg-popover px-2.5 py-2 text-[11px] shadow-lg/40"
          style={{
            left: placement?.x ?? 0,
            top: placement?.y ?? 0,
            visibility: placement === null ? "hidden" : "visible",
          }}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">
              {translate("overview.chainTemplateInsight.tooltipChains")}
            </dt>
            <dd className="text-right font-mono tabular-nums">
              {activeRow.chains}
            </dd>
            <dt className="text-muted-foreground">
              {translate("overview.chainTemplateInsight.tooltipUsers")}
            </dt>
            <dd className="text-right font-mono tabular-nums">
              {activeRow.users}
            </dd>
            <dt className="text-muted-foreground">
              {translate("overview.chainTemplateInsight.tooltipStatus")}
            </dt>
            <dd className={cn("text-right", statusClass(activeRow.status))}>
              {statusText(activeRow.status, translate)}
            </dd>
            <dt className="text-muted-foreground">
              {translate("overview.chainTemplateInsight.nodeHeatShare")}
            </dt>
            <dd className="text-right font-mono tabular-nums">
              {formatPercentValue(
                Math.max(0, Math.min(100, activeRow.sharePct)),
              )}
              %
            </dd>
          </dl>
        </div>
      ) : null}
    </Card>
  );
}
