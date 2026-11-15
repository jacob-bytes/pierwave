/**
 * 链模板 / 自助建链的纯展示逻辑：不依赖 React / DOM / API 类型。
 *
 * 模板是管理员定义的「形态」，用户只看得到路径与服务器名；这里把组结构
 * 压成一行可读文本（`香港-01 → 日本-02`），供列表与选择器复用。
 *
 * 配额语义复用自助转发的实现（`./myForwards.ts`）：`none` / `available` /
 * `exhausted` 三态与边界完全一致，避免两套口径。
 */

import {
  canCreate,
  entryLabel,
  quotaState,
  type ForwardQuotaLike,
  type QuotaState,
} from "./myForwards.ts";
import { t as translate } from "../i18n/index.ts";
import type { TFunction } from "../i18n/index.ts";

export type ChainQuotaState = QuotaState;

/** 自助建链的配额判定：与自助转发同语义。 */
export function chainQuotaState(
  quota: ForwardQuotaLike | null | undefined,
): ChainQuotaState {
  return quotaState(quota);
}

/** 只有 `available` 才允许新建链。 */
export function canCreateChain(
  quota: ForwardQuotaLike | null | undefined,
): boolean {
  return canCreate(quota);
}

/** 组里至少有一个可展示的服务器名/id。 */
interface GroupLike {
  seq?: number | null;
  strategy?: string | null;
  servers?: readonly { name?: string | null }[] | null;
  server_ids?: readonly string[] | null;
}

/** 用户链的组（`servers[].server_name`）。 */
interface ChainGroupLike {
  seq?: number | null;
  servers?: readonly { server_name?: string | null }[] | null;
}

function groupLabel(group: GroupLike): string {
  const names = (group.servers ?? [])
    .map((server) => (server.name ?? "").trim())
    .filter(Boolean);
  if (names.length > 0) return names.join(" / ");
  const ids = (group.server_ids ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids.join(" / ") : "—";
}

/** 按 seq 升序复制：后端已排序，但展示不依赖响应顺序。 */
function ordered<T extends { seq?: number | null }>(groups: readonly T[]): T[] {
  return [...groups].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * 模板的路径文本：`香港-01 → 日本-02`；多成员组用 `/` 分隔候选。
 * `—` 表示模板没有任何组（脏数据），不抛错。
 */
export function templatePath(
  template: { groups?: readonly GroupLike[] | null } | null | undefined,
): string {
  const groups = template?.groups ?? [];
  if (groups.length === 0) return "—";
  return ordered(groups).map(groupLabel).join(" → ");
}

/** 自助链的路径文本：每组按 `server_name` 展示。 */
export function chainPath(
  chain: { groups?: readonly ChainGroupLike[] | null } | null | undefined,
): string {
  const groups = chain?.groups ?? [];
  if (groups.length === 0) return "—";
  return ordered(groups)
    .map((group) => {
      const names = (group.servers ?? [])
        .map((server) => (server.server_name ?? "").trim())
        .filter(Boolean);
      return names.length > 0 ? names.join(" / ") : "—";
    })
    .join(" → ");
}

/** 入口地址：后端已拼好 `地址:端口`；缺失时与自助转发一样展示 `—`。 */
export function chainEntryLabel(
  chain: { entry_address?: string | null } | null | undefined,
): string {
  return entryLabel(chain);
}

/** 模板的服务器总数（组内成员累加）；选择器用它展示规模。 */
export function templateServerCount(
  template: { groups?: readonly GroupLike[] | null } | null | undefined,
): number {
  return (template?.groups ?? []).reduce((sum, group) => {
    const count =
      group.servers?.length ?? group.server_ids?.length ?? 0;
    return sum + count;
  }, 0);
}

/**
 * 编辑自己的链：只允许 name / target_host / target_port / enabled。
 *
 * 模板、groups 与入口端口是系统固定的（换模板 = 换整条链，入口端口变化会让
 * 现有客户端失联），所以编辑对话框只暴露这四个字段。
 */
export interface EditableChainLike {
  name: string;
  target_host: string;
  target_port: number;
  enabled: boolean;
}

export interface ChainEditableFields {
  name: string;
  targetHost: string;
  targetPort: string;
  enabled: boolean;
}

/** PATCH 只提交真的变了的字段；后端按字段可选处理。 */
export interface ChainEditInput {
  name?: string;
  target_host?: string;
  target_port?: number;
  enabled?: boolean;
}

export interface ChainEditPlan {
  input: ChainEditInput;
  targetChanged: boolean;
  /** 停用 → 启用：端口会重新分配，提示必须说明可能变化。 */
  enabling: boolean;
  /** 启用 → 停用：需要二次确认（会从服务器移除链路）。 */
  disabling: boolean;
  needsDisableConfirm: boolean;
  hasChanges: boolean;
}

export interface EditedChainLike {
  target_host: string;
  target_port: number;
  entry_address?: string | null;
}

/** 对话框初始值：只取可编辑字段，模板/端口不进入表单。 */
export function editableChainFields(
  chain: EditableChainLike,
): ChainEditableFields {
  return {
    name: chain.name,
    targetHost: chain.target_host,
    targetPort: String(chain.target_port),
    enabled: chain.enabled,
  };
}

/**
 * 表单校验：名称必填；启用的链目标必填、端口 1–65535；
 * 停用的链允许暂不填目标（后端也只在这时接受空目标）。
 */
export function chainEditError(
  fields: ChainEditableFields,
  t: TFunction = translate,
): string | null {
  if (!fields.name.trim()) return t("me.chains.form.nameRequired");
  const host = fields.targetHost.trim();
  if (fields.enabled && !host) return t("me.chains.form.targetRequired");
  if (host || fields.enabled) {
    const port = Number(fields.targetPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return t("me.chains.form.portRange");
    }
  }
  return null;
}

/** 把表单值转成「只含变化字段」的 PATCH 输入，并标出需要确认/提示的动作。 */
export function planChainEdit(
  chain: EditableChainLike,
  fields: ChainEditableFields,
): ChainEditPlan {
  const name = fields.name.trim();
  const host = fields.targetHost.trim();
  const port = Number(fields.targetPort);
  const portValid =
    Number.isInteger(port) && port >= 1 && port <= 65535;

  const input: ChainEditInput = {};
  if (name && name !== chain.name.trim()) input.name = name;
  if (host !== chain.target_host.trim()) input.target_host = host;
  if (host && portValid && port !== chain.target_port) input.target_port = port;
  if (fields.enabled !== chain.enabled) input.enabled = fields.enabled;

  const targetChanged =
    input.target_host !== undefined || input.target_port !== undefined;
  const enabling = input.enabled === true;
  const disabling = input.enabled === false;

  return {
    input,
    targetChanged,
    enabling,
    disabling,
    needsDisableConfirm: disabling && chain.enabled,
    hasChanges: Object.keys(input).length > 0,
  };
}

/** 停用二次确认的标题与说明：明确「从服务器移除」与「端口可能变化」。 */
export function chainDisableConfirm(t: TFunction = translate): {
  title: string;
  description: string;
} {
  return {
    title: t("me.chains.disableConfirmTitle"),
    description: t("me.chains.disableConfirmDesc"),
  };
}

/** 停用中的链启用前提示：入口端口会重新分配。 */
export function chainEnableHint(t: TFunction = translate): string {
  return t("me.chains.enableHint");
}

/**
 * 编辑成功的 toast 文案：
 * - 启用：带新入口地址，并说明端口可能变化；
 * - 停用：说明端口已释放；
 * - 改目标：带新目标（不显示入口端口，它没变）；
 * - 其它：通用已更新。
 */
export function chainEditSuccess(
  plan: ChainEditPlan,
  updated: EditedChainLike,
  t: TFunction = translate,
): string {
  if (plan.enabling) {
    return t("me.chains.enabledNotice", {
      address: updated.entry_address ?? "—",
    });
  }
  if (plan.disabling) return t("me.chains.disabledNotice");
  if (plan.targetChanged) {
    return t("me.chains.targetUpdated", {
      target: `${updated.target_host}:${updated.target_port}`,
    });
  }
  return t("me.chains.updated");
}
