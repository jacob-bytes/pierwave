/**
 * P4：Agent 自升级的前端纯逻辑，见 docs/PLAN.md「P4：Agent 自升级」。
 *
 * 版本号统一按「去掉前导 v、忽略大小写」比较：Agent 心跳里的 `agent_version`
 * 可能写成 `0.2.0`，而目标版本来自输入框或主控，可能写成 `v0.2.0`；
 * 不做归一化会把它误判成「还有一个待升级版本」，导致列表一直轮询。
 */

export type AgentUpgradeStatus = "pending" | "succeeded" | "failed";

export type AgentUpgradeStatusView = AgentUpgradeStatus | "unknown";

/** 可参与「是否有待升级目标」判断的最小服务器结构。 */
export interface AgentVersionSource {
  agent_version: string | null;
  agent_target_version?: string | null;
}

/** 归一化版本号用于比较；空值返回空串。 */
export function normalizeAgentVersion(
  version: string | null | undefined,
): string {
  return (version ?? "").trim().replace(/^v/i, "").toLowerCase();
}

/** 展示用版本号：空值返回空串，缺少前导 `v` 时补上。 */
export function displayAgentVersion(
  version: string | null | undefined,
): string {
  const trimmed = (version ?? "").trim();
  if (!trimmed) return "";
  return /^v/i.test(trimmed) ? trimmed : `v${trimmed}`;
}

/**
 * 是否存在「已下发但尚未收敛」的目标版本。
 *
 * 只比较归一化后的版本号：`agent_target_version` 为空、或与当前版本相同，
 * 都表示没有待执行的升级。后端暂时没下发新字段时也能安全返回 false。
 */
export function hasPendingAgentUpgrade(server: AgentVersionSource): boolean {
  const target = normalizeAgentVersion(server.agent_target_version);
  if (!target) return false;
  return target !== normalizeAgentVersion(server.agent_version);
}

/** 后端未来新增状态时不要让列表崩掉，统一落到 unknown。 */
export function normalizeAgentUpgradeStatus(
  status: string,
): AgentUpgradeStatusView {
  if (status === "pending" || status === "succeeded" || status === "failed") {
    return status;
  }
  return "unknown";
}
