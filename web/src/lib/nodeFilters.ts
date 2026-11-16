/**
 * 节点列表的服务端筛选 / 分页纯逻辑。
 *
 * URL 形态固定为 `?tag=&region=&page=`：筛选条件与页码都可收藏、刷新保持；
 * 空值省略，`page=1` 也省略，避免 `?tag=&region=&page=1` 这种噪音。
 *
 * 这里不碰 React / 网络：输入框、URL 与请求参数的转换都在这一个文件里，
 * 页面只负责渲染。
 */

/** 列表默认页大小；与后端 `DEFAULT_PER_PAGE` 保持一致。 */
export const NODE_PAGE_SIZE = 50;
/** 后端允许的最大页大小（过滤后 1..=200）。 */
export const NODE_MAX_PAGE_SIZE = 200;

export interface NodeFilterState {
  /** 精确匹配节点 `tags` 数组中的一项；空串 = 不过滤。 */
  tag: string;
  /** 地区，大小写不敏感精确匹配；空串 = 不过滤。 */
  region: string;
  /** 从 1 开始的页码；非法值回落到 1。 */
  page: number;
}

function parsePage(raw: string | null): number {
  if (raw === null) return 1;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/** 从 URL search params 解析筛选状态；未知键忽略。 */
export function parseNodeFilters(params: URLSearchParams): NodeFilterState {
  return {
    tag: (params.get("tag") ?? "").trim(),
    region: (params.get("region") ?? "").trim(),
    page: parsePage(params.get("page")),
  };
}

/**
 * 序列化成 URL search params。
 *
 * 顺序固定为 tag → region → page，便于快照/测试稳定；
 * 页面为 1 时不写 `page`，刷新后仍回到第一页。
 */
export function serializeNodeFilters(filters: NodeFilterState): URLSearchParams {
  const params = new URLSearchParams();
  const tag = filters.tag.trim();
  const region = filters.region.trim();
  if (tag !== "") params.set("tag", tag);
  if (region !== "") params.set("region", region);
  if (Number.isInteger(filters.page) && filters.page > 1) {
    params.set("page", String(filters.page));
  }
  return params;
}

/** 是否存在文本筛选（用于空态区分「还没有节点」与「没有匹配节点」）。 */
export function hasNodeFilters(
  filters: Pick<NodeFilterState, "tag" | "region">,
): boolean {
  return filters.tag.trim() !== "" || filters.region.trim() !== "";
}

function pageSize(perPage: number): number {
  return Number.isFinite(perPage) && perPage > 0
    ? Math.floor(perPage)
    : NODE_PAGE_SIZE;
}

/**
 * 总页数：至少 1 页（空列表也显示「第 1 / 1 页」）。
 * `total` 非有限 / 为负时按 0 处理。
 */
export function nodePageCount(
  total: number,
  perPage: number = NODE_PAGE_SIZE,
): number {
  const size = pageSize(perPage);
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  if (safeTotal === 0) return 1;
  return Math.max(1, Math.ceil(safeTotal / size));
}

/** 把页码夹进 `1..=nodePageCount`；非法页码回落到 1。 */
export function clampNodePage(
  page: number,
  total: number,
  perPage: number = NODE_PAGE_SIZE,
): number {
  const pages = nodePageCount(total, perPage);
  if (!Number.isFinite(page) || !Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, pages);
}

export interface NodePageSummary {
  /** 当前页第一条的 1-based 序号；空列表为 0。 */
  from: number;
  /** 当前页最后一条的 1-based 序号；空列表为 0。 */
  to: number;
  total: number;
  /** 夹取后的有效页码。 */
  page: number;
  pages: number;
}

/**
 * 「第 x–y 条 / 共 n 条」需要的数字。
 *
 * 越界页会先夹到最后一页再算区间，与页面自动纠偏的行为一致；
 * 空列表返回全 0，调用方据此隐藏区间文案。
 */
export function nodePageSummary(
  page: number,
  perPage: number = NODE_PAGE_SIZE,
  total: number = 0,
): NodePageSummary {
  const size = pageSize(perPage);
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const pages = nodePageCount(safeTotal, size);
  if (safeTotal === 0) {
    return { from: 0, to: 0, total: 0, page: 1, pages: 1 };
  }
  const current = clampNodePage(page, safeTotal, size);
  return {
    from: (current - 1) * size + 1,
    to: Math.min(safeTotal, current * size),
    total: safeTotal,
    page: current,
    pages,
  };
}
