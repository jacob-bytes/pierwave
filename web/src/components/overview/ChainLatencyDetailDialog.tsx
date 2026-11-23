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

/**
 * 链路详情弹窗：居中、约 960px（390 全宽），内容超出时在弹窗内部滚动。
 *
 * 打开状态由调用方（URL 的 `?chain=`）决定；关闭走 Dialog 自带的关闭按钮、
 * 遮罩点击或 Esc，统一回调 `onClose`，列表始终留在弹窗后面。
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
  return (
    <Dialog
      open={chain !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-chain-dialog
        className="flex max-h-[92dvh] w-[calc(100vw-0.5rem)] max-w-[960px] flex-col gap-0 overflow-hidden p-0 sm:w-[calc(100vw-2rem)] sm:max-w-[960px]"
      >
        {chain ? (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-12 text-left">
              <DialogTitle
                className="truncate text-sm font-medium"
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
