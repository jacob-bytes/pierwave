/**
 * P5：批量 Agent 升级的前端纯逻辑，见 docs/PLAN.md「P5：批量 Agent 升级」。
 *
 * 这里只放与 React 无关的判定：状态归一化、汇总、轮询终止、多选可用性。
 * 后端契约的状态值未来可能扩展，未知值统一按 unknown 兜底：
 * - 批次未知状态：还有未终态的服务器时继续轮询；
 * - 单台未知状态：既不算成功也不算失败，留在「剩余」里继续轮询。
 */

export type AgentUpgradeBatchStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AgentUpgradeBatchStatusView =
  | AgentUpgradeBatchStatus
  | "unknown";

export type AgentUpgradeBatchItemStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type AgentUpgradeBatchItemStatusView =
  | AgentUpgradeBatchItemStatus
  | "unknown";

/** 批次状态：只认契约里的四个值，其余落到 unknown。 */
export function normalizeAgentBatchStatus(
  status: string,
): AgentUpgradeBatchStatusView {
  if (
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  return "unknown";
}

/** 单台状态：只认契约里的六个值，其余落到 unknown。 */
export function normalizeAgentBatchItemStatus(
  status: string,
): AgentUpgradeBatchItemStatusView {
  if (
    status === "queued" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "skipped" ||
    status === "cancelled"
  ) {
    return status;
  }
  return "unknown";
}

/** 批次是否已收尾（成功 / 失败 / 已取消）。 */
export function isAgentBatchStatusTerminal(status: string): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled"
  );
}

/**
 * 单台是否已收尾。
 *
 * `skipped`（失败即停后没排上）与 `cancelled`（批次被取消）也是终态，
 * 不能让它们把「剩余」一直吊着，否则进度面板会永远轮询。
 */
export function isAgentBatchItemTerminal(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "skipped" ||
    status === "cancelled"
  );
}

/** 汇总面板只依赖 item.status，放宽结构方便单测与复用。 */
export interface AgentBatchItemLike {
  status: string;
}

export interface AgentBatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: number;
  /** 仍在等待或执行中的台数；未知状态也算在内，宁可多轮询也不要提前停。 */
  remaining: number;
  /** 已进入终态的台数 = total - remaining。 */
  done: number;
  /** 完成百分比 0–100，向下取整；空批次为 0。 */
  percent: number;
}

/** 统计「成功 x · 失败 y · 剩余 z」所需的数字。 */
export function summarizeAgentBatchItems(
  items: readonly AgentBatchItemLike[],
): AgentBatchSummary {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let cancelled = 0;
  let remaining = 0;

  for (const item of items) {
    switch (normalizeAgentBatchItemStatus(item.status)) {
      case "succeeded":
        succeeded += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      case "cancelled":
        cancelled += 1;
        break;
      default:
        // queued / running / unknown 都还没收尾。
        remaining += 1;
        break;
    }
  }

  const total = items.length;
  const done = total - remaining;
  return {
    total,
    succeeded,
    failed,
    skipped,
    cancelled,
    remaining,
    done,
    percent: total === 0 ? 0 : Math.floor((done / total) * 100),
  };
}

/**
 * 进度面板是否还要继续轮询（每 5 秒）。
 *
 * 批次还在 running 就一直轮询；批次已终态后，等所有 item 也收尾才停。
 * 后端返回未知批次状态时只在还有未终态 item 时继续，避免无限轮询。
 */
export function shouldPollAgentBatch(
  batchStatus: string,
  items: readonly AgentBatchItemLike[],
): boolean {
  if (batchStatus === "running") return true;
  // 批次已终态时，后端写回 item 的顺序可能稍慢，等最后一台收尾再停；
  // 批次是未知状态时同样只看 item，避免因为不认识的状态无限轮询。
  return items.some((item) => !isAgentBatchItemTerminal(item.status));
}

/** 多选只关心 id 与「是否允许下发升级」。 */
export interface BatchSelectableServer {
  id: string;
  /** 后端可能序列化成 0/1，统一按真值判断。 */
  allow_agent_upgrade?: boolean | number | null;
}

/** 只有开启「允许下发升级」的服务器才能参与批量升级。 */
export function canSelectForBatchUpgrade(server: BatchSelectableServer): boolean {
  return Boolean(server.allow_agent_upgrade);
}

/** 当前可勾选的服务器 id，保持表格顺序。 */
export function selectableServerIds(
  servers: readonly BatchSelectableServer[],
): string[] {
  return servers.filter(canSelectForBatchUpgrade).map((server) => server.id);
}

/** 切换单台选中状态；不校验可用性，由调用方只在可选行上触发。 */
export function toggleBatchSelection(
  selected: readonly string[],
  id: string,
): string[] {
  return selected.includes(id)
    ? selected.filter((current) => current !== id)
    : [...selected, id];
}

/** 刷新列表后丢弃已不可选的 id（例如管理员关掉了「允许下发升级」）。 */
export function pruneBatchSelection(
  selected: readonly string[],
  eligibleIds: readonly string[],
): string[] {
  const eligible = new Set(eligibleIds);
  return selected.filter((id) => eligible.has(id));
}

export type BatchSelectionState = "none" | "some" | "all";

/** 表头复选框的三态：全选可选行 / 部分选中 / 未选。 */
export function batchSelectionState(
  selected: readonly string[],
  eligibleIds: readonly string[],
): BatchSelectionState {
  if (eligibleIds.length === 0) return "none";

  const chosen = pruneBatchSelection(selected, eligibleIds).length;
  if (chosen === 0) return "none";
  if (chosen >= eligibleIds.length) return "all";
  return "some";
}

/**
 * 版本输入归一化：只 trim，不补 `v`、不校验格式。
 * 空串表示「最新版本」，组件据此省略 `version` 字段。
 */
export function normalizeBatchVersionInput(value: string): string {
  return (value ?? "").trim();
}
