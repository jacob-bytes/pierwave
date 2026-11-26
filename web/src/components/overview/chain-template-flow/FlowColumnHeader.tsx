import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { useI18n, type TFunction } from "@/i18n";
import type { TemplateLayoutHeader } from "@/lib/chainTemplateGraph";

export type TemplateHeaderData = {
  header: TemplateLayoutHeader;
};

/** 列名：入口 / 第 N 跳 / 目标（与卡片 aria-label 用同一套文案）。 */
function headerLabel(
  header: TemplateLayoutHeader,
  translate: TFunction,
): string {
  if (header.role === "entry") {
    return translate("overview.chainTemplateInsight.flowEntry");
  }
  if (header.role === "target") {
    return translate("overview.chainTemplateInsight.flowTarget");
  }
  return translate("overview.chainTemplateInsight.flowHop", {
    n: Math.max(1, header.seq),
  });
}

/**
 * 列头计数：目标列用 Targets，其余列用 Nodes；折叠时写 `shown / total`，
 * 只有一个时用 One 单数。
 */
function headerCount(
  header: TemplateLayoutHeader,
  translate: TFunction,
): string {
  const target = header.role === "target";
  if (header.shown < header.total) {
    return target
      ? translate("overview.chainTemplateInsight.flowColumnTargetsFolded", {
          shown: header.shown,
          total: header.total,
        })
      : translate("overview.chainTemplateInsight.flowColumnNodesFolded", {
          shown: header.shown,
          total: header.total,
        });
  }
  if (header.shown === 1) {
    return target
      ? translate("overview.chainTemplateInsight.flowColumnTargetsOne")
      : translate("overview.chainTemplateInsight.flowColumnNodesOne");
  }
  return target
    ? translate("overview.chainTemplateInsight.flowColumnTargets", {
        n: header.shown,
      })
    : translate("overview.chainTemplateInsight.flowColumnNodes", {
        n: header.shown,
      });
}

/**
 * 每列顶部的只读列头：`第 1 跳` + `4 / 7 台`，底下一条 1px 分隔线。
 *
 * 左边缘与卡片对齐（没有卡片那 12px 内缩），12px muted、数量更淡。
 * 它是 React Flow 的节点，所以随画布缩放 / 平移；但 `aria-hidden`、
 * `pointer-events: none`、节点不可聚焦不可选，不参与 hover 高亮，
 * 也不带卡片标记，卡片计数与 Tab 顺序都不受影响。
 */
export const TemplateColumnHeaderNode = memo(function TemplateColumnHeaderNode({
  data,
}: NodeProps) {
  const { header } = data as unknown as TemplateHeaderData;
  const { t } = useI18n();
  return (
    <div
      data-template-flow-column-header
      data-column={header.seq}
      data-role={header.role}
      data-shown={header.shown}
      data-total={header.total}
      aria-hidden="true"
      className="relative flex h-full w-full items-end gap-1.5 pb-1 text-xs leading-none text-muted-foreground"
    >
      <span data-template-flow-column-label className="truncate">
        {headerLabel(header, t)}
      </span>
      <span
        data-template-flow-column-count
        className="shrink-0 text-muted-foreground/50 tabular-nums"
      >
        {headerCount(header, t)}
      </span>
      <span
        data-template-flow-column-rule
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-px bg-border"
      />
    </div>
  );
});
