import { InfoIcon } from "lucide-react";
import type { ChainTemplateDetail } from "@/lib/chainTemplateInsight";
import { t } from "@/i18n";

/**
 * 模板改过之后的提示：拓扑按真实链画，节点 / 边可能与模板当前定义不同。
 *
 * 只有 `template.stale` 为真才出现；`stale_reason` 是后端给的双语说明，
 * 放 `title`，不占版面。旧主控没有该字段时整行不渲染。
 */
export function ChainTemplateStaleNotice({
  detail,
}: {
  detail: ChainTemplateDetail;
}) {
  if (!detail.template.stale) return null;
  return (
    <p
      data-template-stale
      title={detail.template.staleReason ?? undefined}
      className="flex items-start gap-1.5 rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-[10px] leading-normal text-muted-foreground"
    >
      <InfoIcon aria-hidden="true" className="mt-px size-3 shrink-0" />
      <span>{t("overview.chainTemplateInsight.staleNotice")}</span>
    </p>
  );
}
