import { useLayoutEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChainLatencyDetail } from "@/components/overview/ChainLatencyDetail";
import type {
  ChainHealthChain,
  ChainHealthConfig,
  ChainHealthPoint,
  ChainHealthSnapshot,
  ChainLatencyRange,
} from "@/lib/chainHealth";
import { t, useI18n } from "@/i18n";

/** 打开弹窗时真正持有焦点的元素；`body` / 深链接没有触发元素，返回 null。 */
function openerElement(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (active === document.body || active === document.documentElement) {
    return null;
  }
  return active;
}

/**
 * 关闭后把焦点还给打开弹窗的那一行。
 *
 * 行被筛选 / 刷新移除后 DOM 里已经找不到它，此时退到列表搜索框，再退到
 * 列表容器：键盘用户至少还停在「当前列表」里，而不是掉回 `body`。
 */
function focusAfterClose(trigger: HTMLElement | null) {
  if (trigger !== null && trigger.isConnected) {
    trigger.focus();
    return;
  }
  const search = document.querySelector<HTMLElement>("[data-chain-search]");
  if (search !== null) {
    search.focus();
    return;
  }
  const list =
    document.querySelector<HTMLElement>("[data-chain-list-card]") ??
    document.querySelector<HTMLElement>("[data-chain-list]");
  if (list === null) return;
  // 容器不在 Tab 序里，临时给 -1 才能接住焦点。
  if (!list.hasAttribute("tabindex")) list.setAttribute("tabindex", "-1");
  list.focus();
}

/**
 * 链路详情弹窗：居中、约 960px（390 全宽），内容超出时在弹窗内部滚动。
 *
 * 打开状态由调用方（URL 的 `?chain=`）决定；关闭走 Dialog 自带的关闭按钮、
 * 遮罩点击或 Esc，统一回调 `onClose`，列表始终留在弹窗后面。
 *
 * 焦点：打开时落在标题（`tabIndex=-1`，读屏先读标题），关闭时回到触发行；
 * 如果该行已被筛选 / 刷新移除，则回到搜索框或列表容器。
 */
export function ChainLatencyDetailDialog({
  chain,
  config,
  snapshot,
  range,
  onRangeChange,
  trends,
  trendPending,
  onClose,
}: {
  chain: ChainHealthChain | null;
  /** 链列表里的同一条链；没有时状态只能来自 chain-health 契约。 */
  config: ChainHealthConfig | null;
  snapshot: ChainHealthSnapshot;
  range: ChainLatencyRange;
  onRangeChange: (range: ChainLatencyRange) => void;
  trends: ReadonlyMap<number, ChainHealthPoint[]>;
  trendPending: boolean;
  onClose: () => void;
}) {
  useI18n();
  const open = chain !== null;
  // 打开动作发生在父组件的行按钮上。layout effect 早于 Radix 的焦点陷阱
  // （它用 passive effect 移焦点），所以此刻 activeElement 还是那一行；
  // `triggerRef !== null` 挡住 StrictMode 的二次执行，避免记成已聚焦的标题。
  const triggerRef = useRef<HTMLElement | null>(null);
  const isOpenRef = useRef(open);
  useLayoutEffect(() => {
    isOpenRef.current = open;
    if (!open || triggerRef.current !== null) return;
    triggerRef.current = openerElement();
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-chain-dialog
        className="flex max-h-[92dvh] w-[calc(100vw-0.5rem)] max-w-[960px] flex-col gap-0 overflow-hidden p-0 sm:w-[calc(100vw-2rem)] sm:max-w-[960px]"
        onOpenAutoFocus={(event) => {
          // 默认会落到关闭按钮；标题先读出来，读屏才知道这是哪条链。
          event.preventDefault();
          const container = event.currentTarget;
          if (!(container instanceof HTMLElement)) return;
          container
            .querySelector<HTMLElement>('[data-slot="dialog-title"]')
            ?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // 自己接管归还逻辑；同时阻止 Radix 在无 trigger 时把焦点丢给 body。
          event.preventDefault();
          const container = event.currentTarget;
          // StrictMode 挂载后会跑一次假的卸载：弹窗还开着，别抢焦点。
          if (
            isOpenRef.current &&
            container instanceof HTMLElement &&
            container.isConnected
          ) {
            return;
          }
          const active = document.activeElement;
          if (
            active !== null &&
            active !== document.body &&
            active !== document.documentElement
          ) {
            // 别的代码已经把焦点放到了有意义的位置（例如切了子页）。
            triggerRef.current = null;
            return;
          }
          const trigger = triggerRef.current;
          triggerRef.current = null;
          focusAfterClose(trigger);
        }}
      >
        {chain ? (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-12 text-left">
              <DialogTitle
                tabIndex={-1}
                className="truncate rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                title={chain.name}
              >
                {chain.name}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t("overview.chainLatency.dialogDesc", { name: chain.name })}
              </DialogDescription>
            </DialogHeader>
            <div
              data-chain-dialog-scroll
              className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4"
            >
              <ChainLatencyDetail
                chain={chain}
                config={config}
                snapshot={snapshot}
                range={range}
                onRangeChange={onRangeChange}
                trends={trends}
                trendPending={trendPending}
              />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
