/**
 * 「节点分布」世界地图的国家聚合。
 *
 * 纯函数：输入只包含服务器 id / 名称 / 国家代码 / 状态，输出按 ISO2 排序的
 * 国家统计。组件只负责把 tier、worst 映射成颜色与描边，方便 `node:test` 覆盖
 * 边界（0 台、单台、多台、offline/abnormal 混合、未知国家、大小写）。
 */
import { normalizeCountryCode } from "./country.ts";

export type WorldNodeStatus = "online" | "offline" | "abnormal";

export interface WorldNodeServer {
  id: string;
  name: string;
  /** ISO 3166-1 alpha-2；null / 未知代码不参与地图。 */
  country_code?: string | null;
  status: WorldNodeStatus;
}

export interface WorldCountryStats {
  /** 两位大写 ISO2。 */
  country: string;
  total: number;
  online: number;
  offline: number;
  abnormal: number;
  /** 最差状态：offline > abnormal > online。 */
  worst: WorldNodeStatus;
  /** 前 3 个节点名：异常优先，其次按名称排序，保证重复执行稳定。 */
  topNames: string[];
  /** 0 = 1 台，1 = 2–3 台，2 = 4–6 台，3 = 7+ 台。 */
  tier: 0 | 1 | 2 | 3;
}

const STATUS_RANK: Record<WorldNodeStatus, number> = {
  online: 0,
  abnormal: 1,
  offline: 2,
};

/** 1 / 2–3 / 4–6 / 7+ 四档；0 台也落到 0（调用方不会渲染无节点国家）。 */
export function worldNodeTier(total: number): 0 | 1 | 2 | 3 {
  if (total >= 7) return 3;
  if (total >= 4) return 2;
  if (total >= 2) return 1;
  return 0;
}

/**
 * 地图圆点半径（屏幕像素）：台数越多点越大。
 * 小国（HK / SG / MO）的陆地轮廓可能只有 1–2px，圆点必须能单独被看见。
 */
export const WORLD_NODE_MARKER_RADII = [3, 4, 5, 6] as const;

export function worldNodeMarkerRadius(tier: 0 | 1 | 2 | 3): number {
  return WORLD_NODE_MARKER_RADII[tier];
}

function normalizeStatus(status: string): WorldNodeStatus {
  if (status === "offline") return "offline";
  if (status === "abnormal") return "abnormal";
  return "online";
}

/**
 * 服务器当前状态 → 地图状态。
 *
 * `offline` 优先；在线的 Agent 但 Xray 没跑，按 `abnormal`（warning 描边）；
 * 其余都算 online。与服务器页的「服务异常」口径一致。
 */
export function worldNodeStatus(server: {
  status: string;
  xray_running?: boolean | null;
}): WorldNodeStatus {
  if (server.status === "offline") return "offline";
  if (server.status === "abnormal") return "abnormal";
  if (server.xray_running === false) return "abnormal";
  return "online";
}

interface CountryAccumulator {
  country: string;
  online: number;
  offline: number;
  abnormal: number;
  worst: WorldNodeStatus;
  servers: { name: string; status: WorldNodeStatus }[];
}

/**
 * 按国家聚合。未知 / 空国家代码直接跳过（没有坐标可落图），大小写与前后
 * 空白归一成 ISO2。返回结果按国家代码升序。
 */
export function worldNodeStats(
  servers: readonly WorldNodeServer[],
): WorldCountryStats[] {
  const byCountry = new Map<string, CountryAccumulator>();

  for (const server of servers) {
    const country = normalizeCountryCode(server.country_code);
    if (!country) continue;
    const status = normalizeStatus(server.status);
    let entry = byCountry.get(country);
    if (!entry) {
      entry = {
        country,
        online: 0,
        offline: 0,
        abnormal: 0,
        worst: "online",
        servers: [],
      };
      byCountry.set(country, entry);
    }
    entry[status] += 1;
    if (STATUS_RANK[status] > STATUS_RANK[entry.worst]) entry.worst = status;
    const name = server.name.trim() || server.id;
    entry.servers.push({ name, status });
  }

  return [...byCountry.values()]
    .sort((a, b) => a.country.localeCompare(b.country))
    .map((entry) => {
      const total = entry.online + entry.offline + entry.abnormal;
      const topNames = [...entry.servers]
        .sort(
          (a, b) =>
            STATUS_RANK[b.status] - STATUS_RANK[a.status] ||
            (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        )
        .slice(0, 3)
        .map((server) => server.name);
      return {
        country: entry.country,
        total,
        online: entry.online,
        offline: entry.offline,
        abnormal: entry.abnormal,
        worst: entry.worst,
        topNames,
        tier: worldNodeTier(total),
      };
    });
}
