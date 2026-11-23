/**
 * 链路状态徽章的纯文案逻辑：不依赖 React / DOM，便于直接单测。
 *
 * 徽章 = 状态标签 + 可选原因：`降级 · 无样本`、`阻断 · 大阪-01 离线`。
 * 只有四种已知 cause 会拼原因；其余（旧契约 / 未知 cause）保持纯标签。
 */

import {
  chainHealthState,
  chainNodeIssue,
  type ChainHealthChain,
  type ChainHealthConfig,
  type ChainHealthState,
} from "./chainHealth.ts";
import { t as translate } from "../i18n/index.ts";
import type { TFunction } from "../i18n/index.ts";

/** 每种状态在文案层对应的 i18n 键（色与点样式仍在组件层）。 */
export const CHAIN_STATE_LABEL_KEYS: Record<ChainHealthState, string> = {
  ok: "overview.chainLatency.healthHealthy",
  degraded: "chains.status.degraded",
  blocked: "overview.chainBlocked",
  disabled: "chains.status.disabled",
  insufficient: "overview.chainLatency.statusInsufficient",
};

/**
 * 徽章里的短原因：
 * - 节点级 cause：`大阪-01 离线` / `东京-01 异常`（保留节点名，定位更快）；
 * - 无样本：`无样本`（链级，没有节点可指）；
 * - 变慢：`变慢`（链级）。
 */
export function chainStatusReasonText(
  chain: Pick<ChainHealthChain, "status">,
  t: TFunction = translate,
  state?: ChainHealthState,
): string | null {
  const issue = chainNodeIssue(chain);
  if (issue !== null) {
    return issue.kind === "offline"
      ? t("overview.chainLatency.nodeOfflineShort", { name: issue.node.name })
      : t("overview.chainLatency.nodeUnhealthyShort", {
          name: issue.node.name,
        });
  }
  // 链级原因只在状态真的落到「降级」时展开；停用 / 正常不拼原因。
  if (state !== undefined && state !== "degraded") return null;
  if (chain.status?.kind === "degraded") {
    if (chain.status.cause === "no_samples") {
      return t("overview.chainLatency.noSamplesReason");
    }
    if (chain.status.cause === "slow") {
      return t("overview.chainLatency.statusSlow");
    }
  }
  return null;
}

/** 详情徽章完整文案；`state` 可由调用方传入，避免重复计算。 */
export function chainStatusText(
  chain: ChainHealthChain,
  config: ChainHealthConfig | null = null,
  t: TFunction = translate,
  state: ChainHealthState = chainHealthState(chain, config),
): string {
  const label = t(CHAIN_STATE_LABEL_KEYS[state]);
  const reason = chainStatusReasonText(chain, t, state);
  return reason === null
    ? label
    : t("overview.chainLatency.statusWithReason", { status: label, reason });
}
