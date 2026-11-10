/**
 * 转发引擎的纯逻辑：枚举、默认值、文案键与运行时判定。
 *
 * 后端契约（`crates/domain/src/engine.rs` / `ForwardEngine`）：
 * - 独立转发与转发链都只有 `native` / `realm` 两个合法值；
 * - 新建时缺省 `native`；写路径严格拒绝其它值（`forward.engine_invalid`）；
 * - 读路径对历史脏数据回落到 `native`，所以 UI 也按同样规则兜底。
 *
 * 这里不依赖 React / DOM，`node --test` 可直接跑。
 */

import type { ForwardEngine } from "./api.ts";

/** 与后端白名单一致；顺序也是表单里的展示顺序。 */
export const FORWARD_ENGINES = [
  "native",
  "realm",
] as const satisfies readonly ForwardEngine[];

export type { ForwardEngine };

/** 新建规则 / 表单初始值。 */
export const DEFAULT_FORWARD_ENGINE: ForwardEngine = "native";

export function isForwardEngine(value: unknown): value is ForwardEngine {
  return value === "native" || value === "realm";
}

/** `null` / `undefined` / 空白串 = 后端没带该字段（旧版本），按默认值处理。 */
function isAbsentEngine(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  );
}

/**
 * 去掉首尾空白后严格匹配；与后端写路径 `engine::normalize` 一致。
 * 大小写不匹配仍算未知（后端也故意不忽略大小写）。
 */
function knownEngine(value: unknown): ForwardEngine | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "native" || trimmed === "realm" ? trimmed : null;
}

/**
 * 表单与序列化用：已知值原样返回，其余（含后端未来新增的未知值）回落到
 * `native`，与后端读路径的兜底一致，保证 PATCH 永远不会把脏值写回去。
 *
 * 展示不要用这个函数：未知值需要显示成「未知引擎」而不是被静默当成自带，
 * 见 {@link engineMeta}。
 */
export function normalizeEngine(value: unknown): ForwardEngine {
  return knownEngine(value) ?? DEFAULT_FORWARD_ENGINE;
}

export interface EngineMeta {
  /** 已知引擎；`null` = 后端返回了未识别的值。 */
  engine: ForwardEngine | null;
  known: boolean;
  /** `common.engine.*` 下的标签键（徽标 / 单选卡片标题）。 */
  labelKey: string;
  /** `common.engine.*` 下的完整说明键（表单说明与徽标 title）。 */
  descKey: string;
}

/**
 * 展示用映射。
 *
 * - 字段缺失（旧后端 / 迁移前的数据）= `native`：契约缺省值，不是「未知」；
 * - 已知值 → 对应的 `common.engine.*` 键；
 * - 其它非空字符串 → `common.engine.unknown.*`，兜底文案非空，绝不渲染空白。
 */
export function engineMeta(value: unknown): EngineMeta {
  if (isAbsentEngine(value)) {
    return {
      engine: DEFAULT_FORWARD_ENGINE,
      known: true,
      labelKey: `common.engine.${DEFAULT_FORWARD_ENGINE}.label`,
      descKey: `common.engine.${DEFAULT_FORWARD_ENGINE}.desc`,
    };
  }

  const engine = knownEngine(value);
  if (engine) {
    return {
      engine,
      known: true,
      labelKey: `common.engine.${engine}.label`,
      descKey: `common.engine.${engine}.desc`,
    };
  }

  return {
    engine: null,
    known: false,
    labelKey: "common.engine.unknown.label",
    descKey: "common.engine.unknown.desc",
  };
}

/**
 * Agent 上报「realm 未安装」的判定。
 *
 * 运行时只回了 `error` 字符串，没有结构化 code，所以这里匹配中英两种文案：
 * - 中文是当前 Agent 的原文（`crates/agent/src/realm.rs::NOT_INSTALLED`）；
 * - 英文是给未来 Agent 本地化 / 第三方 Agent 留的兜底。
 *
 * 不能只看 `listening=false`：realm 装了但端口被占用、配置写错时同样是
 * `listening=false`，那是真正的运行错误，必须继续显示「失败」。
 */
export function engineMissing(
  listening: boolean | null | undefined,
  error: string | null | undefined,
): boolean {
  if (listening !== false) return false;

  const text = error?.trim();
  if (!text) return false;

  return (
    /realm\s*未安装/i.test(text) ||
    /realm[\s\S]*?not\s+installed/i.test(text) ||
    /not\s+installed[\s\S]*?realm/i.test(text)
  );
}

/** 单条独立转发的「引擎缺失」：只有 realm 规则才可能出现。 */
export interface EngineRuntimeLike {
  engine?: string | null;
  runtime?: {
    listening?: boolean | null;
    error?: string | null;
  } | null;
}

export function forwardEngineMissing(forward: EngineRuntimeLike): boolean {
  return (
    normalizeEngine(forward.engine) === "realm" &&
    engineMissing(forward.runtime?.listening, forward.runtime?.error)
  );
}

/** 转发链的结构子集：任一 realm 成员报「realm 未安装」即整链引擎缺失。 */
export interface ChainEngineLike {
  engine?: string | null;
  groups?: readonly {
    members?: readonly {
      listening?: boolean | null;
      error?: string | null;
    }[];
  }[];
}

export function chainEngineMissing(chain: ChainEngineLike): boolean {
  if (normalizeEngine(chain.engine) !== "realm") return false;

  for (const group of chain.groups ?? []) {
    for (const member of group.members ?? []) {
      if (engineMissing(member.listening, member.error)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 「服务器是否安装了 realm」：静态事实，来自服务器列表的 `realm_available`。
//
// 与上面的 `engineMissing` 严格区分：
// - 这里回答「这台机器装没装 realm」，创建 / 编辑时就能知道，来源是服务器上报；
// - `engineMissing` 回答「这条规则运行后有没有报 realm 未安装」，来源是 runtime。
// `realm_available` 缺失 / null 表示旧 Agent 未上报，按「未知」处理，不能误报。
// ---------------------------------------------------------------------------

/** 服务器列表里与「是否安装 realm」有关的最小字段集。 */
export interface RealmAvailabilityLike {
  /** true = 已安装；false = 明确未安装；null / 缺失 = 旧 Agent 未上报。 */
  realm_available?: boolean | null;
}

/**
 * 所选服务器里是否至少有一台**明确**没有安装 realm（`false`）。
 *
 * `null` / `undefined`（旧 Agent 未上报）不算缺失；空数组返回 `false`。
 */
export function serversMissingRealm(
  servers: readonly RealmAvailabilityLike[],
): boolean {
  return servers.some((server) => server.realm_available === false);
}

/** 带展示名的服务器：用于把「哪些服务器没装」拼成一句话。 */
export interface NamedRealmServerLike extends RealmAvailabilityLike {
  name: string;
}

/**
 * 明确未安装 realm 的服务器名，保持传入顺序、按名字去重、跳过空名字。
 * `null` / `undefined` 的服务器不会出现在结果里。
 */
export function missingRealmServerNames(
  servers: readonly NamedRealmServerLike[],
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  for (const server of servers) {
    if (server.realm_available !== false) continue;

    const name = server.name.trim();
    if (!name || seen.has(name)) continue;

    seen.add(name);
    names.push(name);
  }

  return names;
}

/**
 * 把服务器名列表拼成一句话；分隔符由调用方按当前语言传入
 * （中文「、」/ 英文「, 」）。空名单返回空串，不会留下悬空分隔符。
 */
export function formatServerNameList(
  names: readonly string[],
  separator: string,
): string {
  return names
    .filter((name) => name.trim().length > 0)
    .join(separator);
}

/**
 * 规则引擎是 realm，且这台服务器明确没有安装 realm。
 *
 * 未知引擎按 native 兜底，所以不会因为未来新增引擎而误报。
 */
export function realmMissingOnServer(
  engine: unknown,
  server: RealmAvailabilityLike | null | undefined,
): boolean {
  return (
    normalizeEngine(engine) === "realm" && server?.realm_available === false
  );
}

/** 转发链的结构子集：只看引擎与成员指向的服务器 ID。 */
export interface ChainRealmLike {
  engine?: string | null;
  groups?: readonly {
    members?: readonly {
      server_id?: string | null;
    }[];
  }[];
}

/**
 * realm 链的成员服务器里，是否至少有一台明确没有安装 realm。
 *
 * 按 `server_id` 关联服务器列表；未知 / 已删除的服务器跳过，
 * 服务器列表还没加载完时也不会误报。
 */
export function chainServersMissingRealm(
  chain: ChainRealmLike,
  servers: readonly (RealmAvailabilityLike & { id: string })[],
): boolean {
  if (normalizeEngine(chain.engine) !== "realm") return false;

  const byId = new Map(servers.map((server) => [server.id, server]));
  for (const group of chain.groups ?? []) {
    for (const member of group.members ?? []) {
      if (!member.server_id) continue;
      if (byId.get(member.server_id)?.realm_available === false) return true;
    }
  }

  return false;
}

/**
 * 表单提交时的 `engine` 序列化。
 *
 * **两个值都显式发送**，不要为了「请求体最小」省略 native：
 * edit 时把 realm 改回 native 必须发 `engine: "native"`，否则 PATCH 的
 * 缺省语义是「不改」，引擎会一直停在 realm。create 时显式发 native 与
 * 省略等价（后端默认值就是 native），统一总是发送可以少一套分支。
 *
 * 非法值先回落 native 再发送，保证不会把未知值写回后端。
 */
export function engineInput(value: unknown): { engine: ForwardEngine } {
  return { engine: normalizeEngine(value) };
}

/**
 * 规则实际是否同时监听 UDP。
 *
 * - `realm` 在配置里已经固定 `use_udp = true`，所以恒为 `true`，
 *   不随后端字段 / 用户选择变化；
 * - `native`（含缺失字段）与未知引擎原样透传 `udp`，`undefined` 按 false。
 *
 * 表单里开关的显示值用它，而不是直接读表单里的 `udp`。
 */
export function effectiveUdp(engine: unknown, udp: unknown): boolean {
  if (normalizeEngine(engine) === "realm") return true;
  return Boolean(udp);
}

/**
 * 列表里是否额外显示 `UDP` 徽标。
 *
 * realm 不显示：引擎徽标已经写明 realm 支持 UDP，再挂一个就是重复；
 * 其它引擎只有真的开启 UDP 才显示。未知引擎照常按实际开关显示，
 * 因为它的引擎徽标没有解释 UDP。
 */
export function udpBadgeVisible(engine: unknown, udp: unknown): boolean {
  return normalizeEngine(engine) !== "realm" && Boolean(udp);
}
