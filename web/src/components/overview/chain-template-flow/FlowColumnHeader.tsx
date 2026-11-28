import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { useI18n, type TFunction } from "@/i18n";
import {
  chainColumnPlan,
  type ChainColumnPlan,
} from "@/lib/chainHealth";
import {
  TEMPLATE_COLUMN_LABEL_PADDING,
  TEMPLATE_COLUMN_RULE_GAP,
  type TemplateLayoutHeader,
} from "@/lib/chainTemplateGraph";

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
 * 列头右侧文案：多成员中继列优先显示策略（`故障转移·3选1` / `3 台分担`）；
 * 其余列保持旧的计数口径：目标列用 Targets，折叠时写 `shown / total`，
 * 只有一个时用 One 单数。
 */
function planText(plan: ChainColumnPlan, translate: TFunction): string {
  if (plan.kind === "balanced") {
    return translate("overview.chainLatency.flowBalanced", { n: plan.count });
  }
  const strategy =
    plan.strategy === "failover"
      ? translate("overview.chainLatency.flowStrategyFailover")
      : translate("overview.chainLatency.flowStrategyLowestLatency");
  return translate("overview.chainLatency.flowStrategyChoose", {
    strategy,
    n: plan.count,
  });
}

function headerCount(
  header: TemplateLayoutHeader,
  translate: TFunction,
): string {
  // 策略只作用于多成员的中继列：入口 / 目标 / 单成员保持旧的台数计数。
  const plan = chainColumnPlan(header.strategy ?? null, header.total, header.role);
  if (plan !== null) return planText(plan, translate);
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
 * 左边缘与卡片对齐（没有卡片那 12px 内缩），12px muted；列名与计数同色，
 * 只靠字重区分（列名 500 / 计数 400）。细线距卡片顶边 6px，列头 32px
 * 高度与卡片 y=56 不变，视觉顺序是「文字 → 细线 → 6px → 卡片」。
 * 它是 React Flow 的节点，所以随画布缩放 / 平移；但 `aria-hidden`、
 * `pointer-events: none`、节点不可聚焦不可选，不参与 hover 高亮，
 * 也不带卡片标记，卡片计数与 Tab 顺序都不受影响。
 */
export const TemplateColumnHeaderNode = memo(function TemplateColumnHeaderNode({
  data,
}: NodeProps) {
  const { header } = data as unknown as TemplateHeaderData;
  const { t } = useI18n();
  // 链路详情的列头用节点组名（`header.title`）；模板没有该字段，保持
  // 入口 / 第 N 跳 / 目标的历史文案。
  const title =
    header.title !== undefined && header.title.trim() !== ""
      ? header.title
      : headerLabel(header, t);
  return (
    <div
      data-template-flow-column-header
      data-column={header.seq}
      data-role={header.role}
      data-shown={header.shown}
      data-total={header.total}
      data-strategy={header.strategy ?? undefined}
      aria-hidden="true"
      className="relative flex h-full w-full items-end gap-1.5 text-xs leading-none text-muted-foreground"
      style={{ paddingBottom: TEMPLATE_COLUMN_LABEL_PADDING }}
    >
      <span
        data-template-flow-column-label
        className="min-w-0 truncate font-medium"
      >
        {title}
      </span>
      <span
        data-template-flow-column-count
        className="shrink-0 text-muted-foreground tabular-nums"
      >
        {headerCount(header, t)}
      </span>
      <span
        data-template-flow-column-rule
        aria-hidden="true"
        className="absolute inset-x-0 h-px bg-border"
        style={{ bottom: TEMPLATE_COLUMN_RULE_GAP }}
      />
    </div>
  );
});
