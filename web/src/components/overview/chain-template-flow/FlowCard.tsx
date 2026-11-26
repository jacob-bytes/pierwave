import { memo, useContext, type KeyboardEvent } from "react";
import { GlobeIcon, LayersIcon, LogInIcon, ServerIcon } from "lucide-react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n, type TFunction } from "@/i18n";
import { cn } from "@/lib/utils";
import type { FoldedCard } from "@/lib/chainTemplateGraph";
import type { ChainTemplateMemberStatus } from "@/lib/chainTemplateInsight";
import { TemplateFlowInteractionContext } from "./context";

export type TemplateCardData = {
  card: FoldedCard;
  onExpandColumn: (seq: number) => void;
  onExpandTargets: (upstreamId: string) => void;
};

const ROLE_ICON = {
  entry: LogInIcon,
  hop: ServerIcon,
  target: GlobeIcon,
  fold: LayersIcon,
} as const;

function statusText(
  status: ChainTemplateMemberStatus,
  translate: TFunction,
): string {
  if (status === "online") {
    return translate("overview.chainTemplateInsight.online");
  }
  if (status === "offline") {
    return translate("overview.chainTemplateInsight.offline");
  }
  if (status === "degraded") {
    return translate("overview.chainTemplateInsight.degraded");
  }
  return translate("overview.chainTemplateInsight.unknownStatus");
}

function statusDotClass(status: ChainTemplateMemberStatus): string {
  if (status === "offline") return "bg-destructive";
  if (status === "degraded") return "bg-warning";
  if (status === "online") return "bg-primary";
  return "bg-muted-foreground/40";
}

function statusLabelClass(status: ChainTemplateMemberStatus): string {
  if (status === "offline") return "text-destructive";
  if (status === "degraded") return "text-warning";
  return "text-muted-foreground";
}

/** 折叠卡 / 目标卡的悬停名单：只列前 N 名，完整数据仍在列表与详情里。 */
function CardTooltip({ card }: { card: FoldedCard }) {
  const { t } = useI18n();
  if (card.kind === "fold") {
    return (
      <div data-template-flow-fold-tooltip>
        {/* 卡片标题只有 `+N 台`：tooltip 标题补回「第 N 跳」，用户才知道折的是哪一跳。 */}
        <p className="font-medium" data-template-flow-fold-title>
          {roleLabel(card, t)} ·{" "}
          {t("overview.chainTemplateInsight.flowFoldListTitle", {
            n: card.hidden,
          })}
        </p>
        <ul className="mt-1 space-y-0.5">
          {card.topNames.map((name) => (
            <li key={name} className="truncate">
              {name}
            </li>
          ))}
        </ul>
        {card.offlineHidden > 0 ? (
          <p className="mt-1 text-destructive">
            {t("overview.chainTemplateInsight.flowFoldOffline", {
              n: card.offlineHidden,
            })}
          </p>
        ) : null}
      </div>
    );
  }
  if (card.kind === "target" && card.hidden > 0) {
    return (
      <div data-template-flow-target-tooltip>
        <p className="truncate font-medium" title={card.name}>
          {card.name}
        </p>
        <p className="mt-1 font-medium">
          {t("overview.chainTemplateInsight.flowTargetListTitle", {
            n: card.hidden,
          })}
        </p>
        <ul className="mt-1 space-y-0.5">
          {card.topNames.map((name) => (
            <li key={name} className="truncate">
              {name}
            </li>
          ))}
        </ul>
        <p className="mt-1 font-mono text-xs tabular-nums" data-template-flow-hidden-totals>
          {t("overview.chainTemplateInsight.flowTargetHiddenTotals", {
            chains: card.hiddenChains,
            users: card.hiddenUsers,
          })}
        </p>
      </div>
    );
  }
  return (
    <div data-template-flow-card-tooltip>
      <p className="truncate font-medium" title={card.name}>
        {card.name}
      </p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-background/70">
          {t("overview.chainTemplateInsight.tooltipStatus")}
        </dt>
        <dd>{statusText(card.status, t)}</dd>
        <dt className="text-background/70">
          {t("overview.chainTemplateInsight.tooltipChains")}
        </dt>
        <dd className="font-mono tabular-nums">{card.chains}</dd>
        <dt className="text-background/70">
          {t("overview.chainTemplateInsight.tooltipUsers")}
        </dt>
        <dd className="font-mono tabular-nums">{card.users}</dd>
      </dl>
    </div>
  );
}

function roleLabel(card: FoldedCard, translate: TFunction): string {
  if (card.role === "entry") {
    return translate("overview.chainTemplateInsight.flowEntry");
  }
  if (card.role === "target") {
    return translate("overview.chainTemplateInsight.flowTarget");
  }
  return translate("overview.chainTemplateInsight.flowHop", {
    n: Math.max(1, card.seq),
  });
}

function cardTexts(card: FoldedCard, translate: TFunction) {
  const chains = translate("overview.chainTemplateInsight.flowChains", {
    n: card.chains,
  });
  const users = translate("overview.chainTemplateInsight.usersValue", {
    n: card.users,
  });
  if (card.kind === "fold") {
    const offline =
      card.offlineHidden > 0
        ? ` · ${translate("overview.chainTemplateInsight.flowFoldOffline", {
            n: card.offlineHidden,
          })}`
        : "";
    return {
      title: translate("overview.chainTemplateInsight.flowFoldMembers", {
        n: card.hidden,
      }),
      // 折叠卡先保留链数与用户数，再补离线台数：副标题不能只剩「含 N 台离线」。
      // 不写角色（+N 台已经在标题里），192px 宽才放得下完整的离线台数。
      subtitle: `${chains} · ${users}${offline}`,
    };
  }
  // 列名交给列头（每列顶部一次），卡片副标题只留链数与用户数；
  // aria-label 与折叠卡 tooltip 仍带列名，读屏与悬停信息不丢。
  return {
    title: card.name,
    subtitle:
      card.kind === "target" && card.hidden > 0 ? chains : `${chains} · ${users}`,
  };
}

/**
 * 一张拓扑卡：`[图标] 名称 ● 状态` / `X 条链 · Y 用户`（列名由列头承担）。
 *
 * 四种角色靠图标区分（入口 / 成员 / 目标 / 折叠）。折叠卡整张可点 / Enter /
 * 空格展开这一列；目标卡上的 `+N 个目标` 是卡内小标签，点它只展开这一组上游。
 * 卡片本身就是 React Flow 的节点根，连接点是它的绝对定位子元素（透明），
 * 这样每张卡只多 2 个 DOM，不额外套一层。
 */
export const TemplateCardNode = memo(function TemplateCardNode({
  data,
}: NodeProps) {
  const { card, onExpandColumn, onExpandTargets } =
    data as unknown as TemplateCardData;
  const { t } = useI18n();
  const interaction = useContext(TemplateFlowInteractionContext);
  const hot = interaction?.highlight?.nodes.has(card.id) ?? false;
  const dimmed =
    interaction !== null && interaction.highlight !== null && !hot;
  const active = interaction?.activeId === card.id;
  const Icon = ROLE_ICON[card.role];
  const { title, subtitle } = cardTexts(card, t);
  const status = statusText(card.status, t);
  const aria = t("overview.chainTemplateInsight.flowCardAria", {
    name: title,
    role: roleLabel(card, t),
    status,
    chains: card.chains,
    users: card.users,
  });

  const activate = (): void => interaction?.activate(card.id);
  const deactivate = (): void => interaction?.deactivate();
  const expandTargets = (): void => {
    if (card.upstreamId !== null) onExpandTargets(card.upstreamId);
  };
  const badge =
    card.kind === "target" && card.hidden > 0 ? (
      <button
        type="button"
        data-template-flow-target-fold
        data-count={card.hidden}
        aria-label={t("overview.chainTemplateInsight.flowTargetFoldAria", {
          n: card.hidden,
        })}
        onClick={(event) => {
          event.stopPropagation();
          expandTargets();
        }}
        className="ml-auto inline-flex shrink-0 items-center rounded-full border border-border px-1.5 py-0.5 text-xs leading-none text-foreground transition-colors duration-150 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      >
        {t("overview.chainTemplateInsight.flowFoldTargets", {
          n: card.hidden,
        })}
      </button>
    ) : null;

  const sharedProps = {
    "data-template-flow-card": "",
    "data-card-id": card.id,
    "data-role": card.role,
    "data-kind": card.kind,
    "data-column": card.seq,
    "data-status": card.status,
    "data-hot":
      interaction?.highlight != null
        ? hot
          ? "true"
          : "false"
        : undefined,
    "data-active": active ? "true" : undefined,
    "data-dimmed": dimmed ? "true" : undefined,
    className: cn(
      "template-flow-card relative flex h-full w-full flex-col justify-center rounded-xl bg-card px-3 text-left shadow-card ring-1 ring-foreground/10 outline-none transition duration-150 ease-out",
      card.kind === "fold" && "cursor-pointer hover:bg-muted/40",
    ),
    onMouseEnter: activate,
    onMouseLeave: deactivate,
    onFocus: activate,
    onBlur: deactivate,
  } as const;

  const handles = (
    <>
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        isConnectable={false}
        className="template-flow-handle"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        isConnectable={false}
        className="template-flow-handle"
      />
    </>
  );

  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon
          aria-hidden="true"
          className={cn(
            "icon-sm shrink-0",
            card.role === "entry" ? "text-primary" : "text-muted-foreground",
          )}
        />
        <span
          data-template-flow-card-title
          className="truncate text-[13px] font-medium text-foreground"
          title={title}
        >
          {title}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1">
          <span
            data-template-flow-status-dot
            data-status={card.status}
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", statusDotClass(card.status))}
          />
          <span
            data-template-flow-status-text
            className={cn(
              "text-xs leading-none",
              statusLabelClass(card.status),
            )}
          >
            {status}
          </span>
        </span>
      </span>
      {badge === null ? (
        <span
          data-template-flow-card-subtitle
          className="mt-1 truncate text-xs leading-none text-muted-foreground"
        >
          {subtitle}
        </span>
      ) : (
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs leading-none text-muted-foreground">
          <span data-template-flow-card-subtitle className="truncate">
            {subtitle}
          </span>
          {badge}
        </span>
      )}
    </>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {card.kind === "fold" ? (
          <div
            role="button"
            tabIndex={0}
            {...sharedProps}
            aria-label={aria}
            aria-expanded={false}
            onClick={() => onExpandColumn(card.seq)}
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onExpandColumn(card.seq);
              }
            }}
          >
            {handles}
            {body}
          </div>
        ) : (
          <div role="group" tabIndex={0} {...sharedProps} aria-label={aria}>
            {handles}
            {body}
          </div>
        )}
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        className="max-w-72 bg-foreground text-background"
      >
        <CardTooltip card={card} />
      </TooltipContent>
    </Tooltip>
  );
});
