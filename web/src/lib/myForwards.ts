/**
 * 用户自助转发的纯展示逻辑：不依赖 React / DOM / API 类型。
 *
 * 配额语义（顺序很重要）：
 * 1. 没有配额对象、`limit <= 0` 或 `limit` 不是有限数字 → `none`：
 *    当前套餐不支持自助转发，空态与隐藏新建按钮都以它为准；
 * 2. `used >= limit` → `exhausted`：条数已用尽，不能再建；
 * 3. 其余（`0 <= used < limit`）→ `available`。
 *
 * `used` 缺失 / 非数字 / 负数都按 0 处理：后端字段异常时宁可多给一次
 * 新建机会（后端仍会校验），也不要把可用配额算成负数。
 */

export interface ForwardQuotaLike {
  used?: number | null;
  limit?: number | null;
}

export type QuotaState = "none" | "available" | "exhausted";

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < 0 ? 0 : value;
}

export function quotaState(
  quota: ForwardQuotaLike | null | undefined,
): QuotaState {
  if (!quota) return "none";

  const limit = nonNegativeNumber(quota.limit);
  if (limit === null || limit <= 0) return "none";

  const used = nonNegativeNumber(quota.used) ?? 0;
  return used >= limit ? "exhausted" : "available";
}

/** 只有 `available` 才允许新建；`none` / `exhausted` 都不可创建。 */
export function canCreate(
  quota: ForwardQuotaLike | null | undefined,
): boolean {
  return quotaState(quota) === "available";
}

/**
 * 新建动作被拦下的原因。
 *
 * 与配额三态分开：`no-availability` 是「有配额，但没有可用的服务器 / 链模板」，
 * 配额本身完全正常。拆开之后，界面才能给出一句准确的解释，而不是笼统地
 * 把按钮置灰。
 */
export type CreateBlocker =
  /** 套餐不支持（`limit <= 0`）且没有任何存量。 */
  | "unsupported"
  /** 套餐不再支持新建，但还有存量：列表继续展示，只禁用新建。 */
  | "stock"
  /** 配额用尽。 */
  | "exhausted"
  /** 有配额，但没有授权任何服务器（转发）或模板（转发链）。 */
  | "no-availability";

export interface CreateGate {
  blocker: CreateBlocker | null;
  creatable: boolean;
  /** false 时整块只给「套餐不支持」空态；true 时保留列表（含存量）。 */
  showList: boolean;
  /**
   * 顶部配额徽章形态：
   * - `ratio`：`3 / 5 条`；
   * - `stock`：`存量 2 条`（`limit <= 0` 的存量态，绝不显示 `2 / 0`）；
   * - `null`：不显示（套餐不支持且没有存量）。
   */
  badge: "ratio" | "stock" | null;
}

/**
 * 后端 `forward_servers_reason` 的解释码（旧后端没有该字段）。
 *
 * - `package.forward_servers_empty`：有额度，但套餐没授权服务器；
 * - `package.forward_limit_zero`：套餐本身不支持自助转发。
 *
 * 未知值返回 null，调用方回落到 `servers.length` 判断（U1）。
 */
export type ForwardServersReason = "no-servers" | "no-limit";

export function forwardServersReason(
  reason: string | null | undefined,
): ForwardServersReason | null {
  if (reason === "package.forward_servers_empty") return "no-servers";
  if (reason === "package.forward_limit_zero") return "no-limit";
  return null;
}

export interface CreateGateInput {
  quota?: ForwardQuotaLike | null;
  itemCount?: number | null;
  /**
   * 允许新建的资源数量（转发的服务器 / 链的模板）。
   * `null` / `undefined` 表示还不知道（请求未完成），此时不据此拦截，
   * 避免在加载中误报「没有可用服务器」。
   */
  availableCount?: number | null;
}

function nonNegativeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * 新建入口的统一判定（自助转发与转发链共用同一套口径）。
 *
 * 判定顺序有意如此：
 * 1. `limit <= 0` 且有存量 → `stock`：保留存量列表，只禁用新建；
 * 2. `limit <= 0` 且没有存量 → `unsupported`：隐藏新建按钮，空态说明不支持；
 * 3. 配额用尽 → `exhausted`（优先于「没有服务器」，配额是主因）；
 * 4. 有配额但没有可用资源 → `no-availability`：配额正常，只是没授权；
 * 5. 其余 → 可新建。
 */
export function createGate({
  quota,
  itemCount,
  availableCount,
}: CreateGateInput): CreateGate {
  const items = nonNegativeCount(itemCount);
  const state = quotaState(quota);

  if (state === "none") {
    return items > 0
      ? {
          blocker: "stock",
          creatable: false,
          showList: true,
          badge: "stock",
        }
      : {
          blocker: "unsupported",
          creatable: false,
          showList: false,
          badge: null,
        };
  }

  if (state === "exhausted") {
    return {
      blocker: "exhausted",
      creatable: false,
      showList: true,
      badge: "ratio",
    };
  }

  if (availableCount === 0) {
    return {
      blocker: "no-availability",
      creatable: false,
      showList: true,
      badge: "ratio",
    };
  }

  return { blocker: null, creatable: true, showList: true, badge: "ratio" };
}

/** 入口地址的最小字段集：不要求完整 item，方便测试与骨架屏复用。 */
export interface ForwardEntryLike {
  entry_address?: string | null;
  listen_port?: number | null;
}

/**
 * 列表 / 复制按钮展示的入口地址。
 *
 * 后端返回的 `entry_address` 已经含端口；这里只去掉首尾空白，
 * 不做任何拼接。缺失时给占位符「—」，**不拿 `listen_port` 拼一个
 * 用户无法直接使用的地址**（缺主机名时拼出来只会误导）。
 */
export function entryLabel(
  item: ForwardEntryLike | null | undefined,
): string {
  const raw = item?.entry_address;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || "—";
}
