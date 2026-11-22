import { ListError } from "@/components/common";
import { t } from "@/i18n";

/**
 * 概览 tab 内部的错误态：比整页错误轻，某个接口失败时只影响当前面板。
 */
export function PanelError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <ListError
      title={t("overview.panelLoadFailed")}
      message={message}
      retrying={retrying}
      onRetry={onRetry}
    />
  );
}
