/**
 * 服务器分组的纯逻辑。
 *
 * 分组名来自用户输入，可能带首尾空格、连续空白，或长到撑破列表；
 * 公开状态页的 `groups` 也可能缺失或带脏计数。这里统一收口，
 * 页面只负责把结果映射成 token 与文案。
 */

/** 分组名上限；输入框的 maxLength 与归一化共用同一个值。 */
export const GROUP_NAME_MAX_LENGTH = 32;

/**
 * 归一化分组名：去首尾空格、把连续空白压成一个空格、按 code point 截断。
 *
 * null / undefined / 空串 / 全空白都表示「未分组」，统一返回 null。
 * 大小写保留原样，「HK」与「hk」是两个分组。
 */
export function normalizeGroupName(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (collapsed === "") return null;

  const characters = Array.from(collapsed);
  if (characters.length <= GROUP_NAME_MAX_LENGTH) return collapsed;
  return characters.slice(0, GROUP_NAME_MAX_LENGTH).join("").trimEnd();
}

export interface ServerGroup<T> {
  /** null 是「未分组」；永远排在具名分组之后。 */
  name: string | null;
  servers: T[];
}

/** 具名分组按名称排序，未分组固定最后；同一分组内的服务器保持原顺序。 */
function compareGroupNames(a: string | null, b: string | null): number {
  if (a === b) return 0;
  // 未分组始终最后，方便筛选器把它放在选项末尾。
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * 按 `group_name` 把服务器分组。
 *
 * 返回空数组表示列表为空；至少有一台未分组服务器时，最后一组的 `name` 为 null。
 * 名称只差空白的服务器会合并到同一组。
 */
export function groupServers<T extends { group_name?: string | null }>(
  servers: readonly T[],
): ServerGroup<T>[] {
  const named = new Map<string, ServerGroup<T>>();
  const ungrouped: T[] = [];

  for (const server of servers) {
    const name = normalizeGroupName(server.group_name);
    if (name === null) {
      ungrouped.push(server);
      continue;
    }

    const existing = named.get(name);
    if (existing) {
      existing.servers.push(server);
    } else {
      named.set(name, { name, servers: [server] });
    }
  }

  const groups = [...named.values()].sort((a, b) =>
    compareGroupNames(a.name, b.name),
  );
  if (ungrouped.length > 0) groups.push({ name: null, servers: ungrouped });
  return groups;
}

export interface GroupStatusInput {
  name?: string | null;
  servers?: number | null;
  online?: number | null;
  uptime_24h?: number | null;
}

export interface GroupStatusRow {
  name: string | null;
  servers: number;
  online: number;
  uptime_24h: number | null;
}

/** 计数只接受非负有限数并向下取整；其它值视为 0。 */
function normalizeCount(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

/** 可用率夹在 0..1；没有采样（null / NaN / 无穷）保持 null。 */
function normalizeRatio(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * 归一化公开状态页的分组聚合。
 *
 * - 缺字段、null、非数组都返回空数组，旧后端没有 `groups` 时页面直接不画这一块；
 * - 丢弃 `servers <= 0` 的空组，避免筛选/卡片出现「0 台」；
 * - `online` 不超过 `servers`，可用率夹在 0..1；
 * - 排序与 `groupServers` 一致：具名分组按名称，未分组最后。
 */
export function groupStatusRows(
  groups: readonly GroupStatusInput[] | null | undefined,
): GroupStatusRow[] {
  if (!Array.isArray(groups)) return [];

  // 同名的多条聚合（尤其是多个「未分组」）合并成一行；
  // 可用率按服务器数加权，没有采样的条目不进分母。
  type Accumulator = {
    name: string | null;
    servers: number;
    online: number;
    uptimeWeight: number;
    uptimeSum: number;
  };
  const accumulators = new Map<string | null, Accumulator>();

  for (const group of groups) {
    if (!group || typeof group !== "object") continue;

    const servers = normalizeCount(group.servers);
    if (servers <= 0) continue;

    const name = normalizeGroupName(group.name);
    const online = Math.min(servers, normalizeCount(group.online));
    const uptime = normalizeRatio(group.uptime_24h);
    const accumulator = accumulators.get(name);

    if (accumulator) {
      accumulator.servers += servers;
      accumulator.online = Math.min(
        accumulator.servers,
        accumulator.online + online,
      );
    } else {
      accumulators.set(name, {
        name,
        servers,
        online,
        uptimeWeight: 0,
        uptimeSum: 0,
      });
    }

    if (uptime !== null) {
      const current = accumulators.get(name)!;
      current.uptimeWeight += servers;
      current.uptimeSum += uptime * servers;
    }
  }

  const rows: GroupStatusRow[] = [...accumulators.values()].map(
    (accumulator) => ({
      name: accumulator.name,
      servers: accumulator.servers,
      online: accumulator.online,
      uptime_24h:
        accumulator.uptimeWeight === 0
          ? null
          : Math.min(
              1,
              Math.max(0, accumulator.uptimeSum / accumulator.uptimeWeight),
            ),
    }),
  );

  return rows.sort((a, b) => compareGroupNames(a.name, b.name));
}
