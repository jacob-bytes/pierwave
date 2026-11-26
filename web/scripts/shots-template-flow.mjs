// 转发链模板拓扑（React Flow 画布）的截图 + 运行时断言。
//
// 前置：
//   1) 生产构建已在 web/dist（`cd web && npm run build`）；
//   2) master 跑在 127.0.0.1:8787，且 admin 密码 devpass（隔离库 / 临时库都行）；
//   3) 本脚本用 Playwright route 注入模板列表 / 详情 / 链路时延 mock，不依赖真实模板数据。
//
// 覆盖：3 跳 / 4 跳 / 6 跳、折叠 / 展开、hover 路径（卡片与连线）、卡片与药丸 /
// 合并虚线 tooltip、100% / 50% / 150% 缩放、折叠上游后的目标 +N、密集药丸、390、
// 亮暗、空态、旧主控降级、reduced-motion；并断言每列可见卡 ≤5、首屏缩放 0.9–1
// 且标题折算 ≥11.7px、列顶对齐 / 列距 80 / 卡片 192×64、右缘提示（按卡片右边缘
// 计数，半截列计入）、下缘提示（内容超高时出现，平移到底后消失）、画布高度上限、
// 滚轮不缩放、Ctrl/⌘ 滚轮缩放、拖拽不丢图、折叠只展开本列、Tab 可达、动画边 ≤10、
// DOM ≤600、React Flow 署名 12px 中性 muted 灰；reduced-motion 下平移动画 0ms；
// 平移 / 缩放各采样 1 秒 rAF 帧数（无头 ≥30fps，真机目标 ≥45fps）。
//
// 用法：node web/scripts/shots-template-flow.mjs [baseUrl]
// 环境变量：PLAYWRIGHT_MODULE / CHROME_PATH / OUT_DIR / ADMIN_PASSWORD / HEADED
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = path.resolve(WEB, "..");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "devpass";
const OUT = process.env.OUT_DIR
  ? path.resolve(process.env.OUT_DIR)
  : path.join(WEB, "screenshots", "template-flow");
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** 默认无头（CI / 截图机）；`HEADED=1` 时开有头窗口，帧率门槛按真机的 45fps。 */
const HEADLESS = process.env.HEADED !== "1";
mkdirSync(OUT, { recursive: true });

/**
 * Playwright 不在 web 的依赖里：优先用 `PLAYWRIGHT_MODULE` 指向的模块，
 * 否则在仓库内的 `.npm-cache/_npx/*` 里找（本机沙箱把全局缓存指到仓库里），
 * 最后回退到 `import("playwright")`。不再写死某台机器的 npx 哈希目录。
 */
async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const npxRoot = path.join(ROOT, ".npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(
        path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs"),
      );
    }
  }
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const mod = await import(pathToFileURL(candidate).href);
      if (mod.chromium) return mod.chromium;
    } catch {
      /* try next */
    }
  }
  const mod = await import("playwright");
  return mod.chromium;
}

const chromium = await loadPlaywright();

const NOW = Math.floor(Date.now() / 1000);
const report = { base: BASE, screenshots: [], assertions: {}, fps: null, errors: [] };

/**
 * 署名的「中性 muted 灰」判定：颜色可能序列化成 oklch（相对色解析后）
 * 或 rgb。oklch 看 chroma 是否归零，rgb 看三通道差；不写死具体色值。
 */
function isNeutralColor(value) {
  if (typeof value !== "string") return false;
  const oklch = /^oklch\(([^)]+)\)/.exec(value);
  if (oklch !== null) {
    const parts = oklch[1].trim().split(/\s+/);
    return Number.isFinite(Number(parts[1])) && Math.abs(Number(parts[1])) <= 0.005;
  }
  const rgb = /^rgba?\(([^)]+)\)/.exec(value);
  if (rgb !== null) {
    const channels = rgb[1]
      .split(",")
      .slice(0, 3)
      .map((part) => Number(part.trim()));
    return Math.max(...channels) - Math.min(...channels) <= 10;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 数据：3 / 4 / 6 跳模板 + 空模板                                     */
/* ------------------------------------------------------------------ */

function member(name, chains, users, status = "online", serverId = name) {
  return { server_id: serverId, name, status, chains, users };
}

function edge(fromSeq, fromMember, toSeq, toMember, chains, p50 = 20, users = 1) {
  return {
    seq: toSeq,
    from: { seq: fromSeq, member: fromMember },
    to: { seq: toSeq, member: toMember },
    chains,
    users,
    p50_ms: p50,
    loss_pct: 0,
  };
}

function target(host, port, chains) {
  return { host, port, chains, users: [] };
}

function strategy(name, chains, users) {
  return { strategy: name, chains, users };
}

/** 3 跳：入口 2 台 → 东京 3 台（含降级）→ 洛杉矶 3 台（含离线）→ 6 个目标。 */
function detail3Hop() {
  const nodes = [
    {
      seq: 0,
      role: "source",
      name: "香港入口",
      members: [member("香港-01", 6, 4), member("香港-02", 3, 2)],
    },
    {
      seq: 1,
      role: "hop",
      name: "东京中转",
      members: [
        member("东京-01", 5, 3),
        member("东京-02", 3, 2, "degraded"),
        member("东京-03", 1, 1),
      ],
    },
    {
      seq: 2,
      role: "hop",
      name: "洛杉矶中转",
      members: [
        member("洛杉矶-01", 5, 3),
        member("洛杉矶-02", 3, 2, "offline"),
        member("洛杉矶-03", 1, 1),
      ],
    },
    {
      seq: 3,
      role: "target",
      name: "目标",
      members: [
        member("1.2.3.4:443", 3, 2),
        member("5.6.7.8:8443", 2, 1),
        member("9.9.9.9:443", 1, 1),
        member("10.0.0.1:443", 2, 1),
        member("10.0.0.2:443", 1, 1),
        member("10.0.0.3:443", 1, 1),
      ],
    },
  ];
  const edges = [
    edge(0, "香港-01", 1, "东京-01", 4, 15.5, 3),
    edge(0, "香港-01", 1, "东京-02", 2, 18.2, 2),
    edge(0, "香港-02", 1, "东京-01", 1, 22.4, 1),
    edge(0, "香港-02", 1, "东京-02", 1, 24.1, 1),
    edge(0, "香港-02", 1, "东京-03", 1, 26, 1),
    edge(1, "东京-01", 2, "洛杉矶-01", 3, 120.4, 3),
    edge(1, "东京-01", 2, "洛杉矶-02", 1, 140, 1),
    edge(1, "东京-02", 2, "洛杉矶-01", 2, 128.6, 2),
    edge(1, "东京-02", 2, "洛杉矶-02", 1, 150, 1),
    edge(1, "东京-02", 2, "洛杉矶-03", 1, 152, 1),
    edge(1, "东京-03", 2, "洛杉矶-03", 1, 158, 1),
    edge(2, "洛杉矶-01", 3, "1.2.3.4:443", 2, 160.2, 2),
    edge(2, "洛杉矶-01", 3, "5.6.7.8:8443", 2, 168, 1),
    edge(2, "洛杉矶-01", 3, "9.9.9.9:443", 1, 171, 1),
    edge(2, "洛杉矶-02", 3, "10.0.0.1:443", 2, 190, 1),
    edge(2, "洛杉矶-02", 3, "10.0.0.2:443", 1, 195, 1),
    edge(2, "洛杉矶-03", 3, "10.0.0.3:443", 1, 205, 1),
  ];
  return {
    template: { id: "tpl-3", name: "香港 → 东京 → 洛杉矶", hops: 3, created_at: NOW - 86400 * 9 },
    nodes,
    edges,
    targets: [
      target("1.2.3.4", 443, 3),
      target("5.6.7.8", 8443, 2),
      target("9.9.9.9", 443, 1),
      target("10.0.0.1", 443, 2),
      target("10.0.0.2", 443, 1),
      target("10.0.0.3", 443, 1),
    ],
    users: [],
    series: usageSeries(24),
    strategies: [strategy("ip_hashed", 5, 3), strategy("round_robin", 4, 2)],
  };
}

/** 4 跳：第 1 / 第 3 跳各 7 台（必折叠），目标 7 个。 */
function detail4Hop() {
  const nodes = [
    {
      seq: 0,
      role: "source",
      name: "香港入口",
      members: [member("香港-01", 7, 5)],
    },
    {
      seq: 1,
      role: "hop",
      name: "东京中转",
      members: Array.from({ length: 7 }, (_, index) =>
        member(
          `东京-0${index + 1}`,
          7 - index,
          5 - Math.floor(index / 2),
          index === 5 ? "degraded" : "online",
        ),
      ),
    },
    {
      seq: 2,
      role: "hop",
      name: "洛杉矶中转",
      members: [member("洛杉矶-01", 4, 3), member("洛杉矶-02", 3, 2)],
    },
    {
      seq: 3,
      role: "hop",
      name: "法兰克福中转",
      members: Array.from({ length: 7 }, (_, index) =>
        member(
          `法兰克福-0${index + 1}`,
          7 - index,
          4,
          index === 6 ? "offline" : "online",
        ),
      ),
    },
    {
      seq: 4,
      role: "target",
      name: "目标",
      members: Array.from({ length: 7 }, (_, index) =>
        member(`172.16.0.${index + 1}:8443`, 7 - index, 3),
      ),
    },
  ];
  const edges = [];
  for (let index = 0; index < 7; index += 1) {
    edges.push(
      edge(0, "香港-01", 1, `东京-0${index + 1}`, 7 - index, 12 + index, 4),
    );
  }
  for (let index = 0; index < 7; index += 1) {
    edges.push(
      edge(
        1,
        `东京-0${index + 1}`,
        2,
        index % 2 === 0 ? "洛杉矶-01" : "洛杉矶-02",
        Math.max(1, 7 - index),
        40 + index,
        3,
      ),
    );
  }
  for (let index = 0; index < 7; index += 1) {
    edges.push(
      edge(
        2,
        index < 4 ? "洛杉矶-01" : "洛杉矶-02",
        3,
        `法兰克福-0${index + 1}`,
        Math.max(1, 7 - index),
        90 + index,
        3,
      ),
    );
  }
  for (let index = 0; index < 7; index += 1) {
    edges.push(
      edge(
        3,
        `法兰克福-0${index + 1}`,
        4,
        `172.16.0.${index + 1}:8443`,
        Math.max(1, 7 - index),
        140 + index,
        2,
      ),
    );
  }
  return {
    template: { id: "tpl-4", name: "香港 → 东京 → 洛杉矶 → 法兰克福", hops: 4, created_at: NOW - 86400 * 4 },
    nodes,
    edges,
    targets: Array.from({ length: 7 }, (_, index) =>
      target(`172.16.0.${index + 1}`, 8443, 7 - index),
    ),
    users: [],
    series: usageSeries(24),
    strategies: [strategy("failover", 7, 4), strategy("lowest_latency", 3, 2)],
  };
}

/** 6 跳：每跳 3 台、目标 4 个 —— 深度 + 多层扇出，DOM 仍要 ≤600。 */
function detail6Hop() {
  const perColumn = 3;
  const hops = 6;
  const targets = 4;
  const nodes = [];
  const edges = [];
  for (let seq = 0; seq <= hops; seq += 1) {
    const role = seq === 0 ? "source" : seq === hops ? "target" : "hop";
    nodes.push({
      seq,
      role,
      name: `第 ${seq} 跳`,
      members:
        role === "target"
          ? Array.from({ length: targets }, (_, index) =>
              member(`10.0.${seq}.${index + 1}:443`, targets - index, 4),
            )
          : Array.from({ length: perColumn }, (_, index) =>
              member(
                `s-${seq}-${String(index + 1).padStart(2, "0")}`,
                10 - seq - index,
                4 - index,
                seq === 4 && index === 2 ? "offline" : "online",
              ),
            ),
    });
  }
  for (let seq = 1; seq <= hops; seq += 1) {
    for (let index = 0; index < perColumn; index += 1) {
      edges.push(
        edge(
          seq - 1,
          seq === 1
            ? `s-0-${String(index + 1).padStart(2, "0")}`
            : `s-${seq - 1}-${String(index + 1).padStart(2, "0")}`,
          seq,
          seq === hops
            ? `10.0.${seq}.${index + 1}:443`
            : `s-${seq}-${String(index + 1).padStart(2, "0")}`,
          10 - seq - index,
          10 + seq * 10 + index,
          3,
        ),
      );
      if (seq < hops) {
        edges.push(
          edge(
            seq - 1,
            seq === 1
              ? `s-0-${String(index + 1).padStart(2, "0")}`
              : `s-${seq - 1}-${String(index + 1).padStart(2, "0")}`,
            seq,
            `s-${seq}-${String(((index + 1) % perColumn) + 1).padStart(2, "0")}`,
            8 - seq - index,
            14 + seq * 10 + index,
            2,
          ),
        );
      }
    }
    if (seq === hops) {
      // 目标列多一个上游：3 台 → 4 个目标，必然有 +N。
      edges.push(
        edge(
          seq - 1,
          `s-${seq - 1}-01`,
          seq,
          `10.0.${seq}.${targets}:443`,
          2,
          210,
          1,
        ),
      );
    }
  }
  return {
    template: { id: "tpl-6", name: "香港 → 东京 → 洛杉矶 → 法兰克福 → 伦敦 → 圣保罗", hops: 6, created_at: NOW },
    nodes,
    edges,
    targets: Array.from({ length: targets }, (_, index) =>
      target(`10.0.${hops}.${index + 1}`, 443, targets - index),
    ),
    users: [],
    series: usageSeries(24),
    strategies: [strategy("ip_hashed", 12, 9), strategy("weighted", 8, 4)],
  };
}

/** 第 1 跳 6 台、每台 3 个目标：上游被折叠时，目标 +N 的分组键回归。 */
function detail1HopWide() {
  const HOP_COUNT = 6;
  const TARGETS_PER_HOP = 3;
  const nodes = [
    {
      seq: 0,
      role: "source",
      name: "香港入口",
      members: [member("香港-01", 18, 3)],
    },
    {
      seq: 1,
      role: "hop",
      name: "东京中转",
      members: Array.from({ length: HOP_COUNT }, (_, index) =>
        member(`东京-0${index + 1}`, 3, 3, "online", `hop-${index + 1}`),
      ),
    },
    { seq: 2, role: "target", name: "目标", members: [] },
  ];
  const edges = [];
  const targets = [];
  for (let hop = 0; hop < HOP_COUNT; hop += 1) {
    edges.push(edge(0, "香港-01", 1, `东京-0${hop + 1}`, 3, 20, 3));
    for (let slot = 0; slot < TARGETS_PER_HOP; slot += 1) {
      const label = `10.0.${hop + 1}.${slot + 1}:443`;
      edges.push(
        edge(
          1,
          `东京-0${hop + 1}`,
          2,
          label,
          TARGETS_PER_HOP - slot,
          30 + slot,
          TARGETS_PER_HOP - slot,
        ),
      );
      targets.push({
        host: `10.0.${hop + 1}.${slot + 1}`,
        port: 443,
        chains: TARGETS_PER_HOP - slot,
        users: [],
      });
    }
  }
  return {
    template: {
      id: "tpl-fold",
      name: "香港 → 东京（6 台 × 3 目标）",
      hops: 2,
      created_at: NOW - 86400 * 2,
    },
    nodes,
    edges,
    targets,
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  };
}

/** 第 1 跳 8 台：展开后入口竖线会有 8 个药丸，触发密集隐藏。 */
function detailDense() {
  const HOP_COUNT = 8;
  const nodes = [
    {
      seq: 0,
      role: "source",
      name: "香港入口",
      members: [member("香港-01", HOP_COUNT, 5)],
    },
    {
      seq: 1,
      role: "hop",
      name: "东京中转",
      members: Array.from({ length: HOP_COUNT }, (_, index) =>
        member(`东京-0${index + 1}`, HOP_COUNT - index, 2),
      ),
    },
    { seq: 2, role: "target", name: "目标", members: [] },
  ];
  const edges = [];
  for (let hop = 0; hop < HOP_COUNT; hop += 1) {
    edges.push(edge(0, "香港-01", 1, `东京-0${hop + 1}`, HOP_COUNT - hop, 20));
    edges.push(
      edge(1, `东京-0${hop + 1}`, 2, `10.9.9.${hop + 1}:443`, HOP_COUNT - hop, 30),
    );
  }
  return {
    template: {
      id: "tpl-dense",
      name: "香港 → 东京（8 台密集药丸）",
      hops: 2,
      created_at: NOW - 86400 * 1,
    },
    nodes,
    edges,
    targets: [],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  };
}

function detailEmpty() {
  return {
    template: { id: "tpl-empty", name: "备用模板（未建链）", hops: 2, created_at: NOW - 86400 * 30 },
    nodes: [
      { seq: 0, role: "source", name: "香港入口", members: [member("香港-01", 0, 0)] },
      { seq: 1, role: "hop", name: "东京中转", members: [member("东京-01", 0, 0)] },
      { seq: 2, role: "target", name: "目标", members: [] },
    ],
    edges: [edge(0, "香港-01", 1, "东京-01", 0, null)],
    targets: [],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [{ seq: 1, server_id: "东京-01", name: "东京-01", status: "offline" }],
  };
}

function usageSeries(hours) {
  const count = hours * 4;
  const end = Math.floor(NOW / 900) * 900;
  return Array.from({ length: count }, (_, index) => ({
    ts: end - (count - 1 - index) * 900,
    chains: Math.min(7, 2 + Math.floor((index + 1) / 12)),
    users: Math.min(5, 1 + Math.floor((index + 1) / 16)),
  }));
}

const LIST_ITEMS = [
  {
    id: "tpl-3",
    name: "香港 → 东京 → 洛杉矶",
    hops: 3,
    enabled: true,
    chains: 9,
    users: 4,
    status: { kind: "ok", cause: null },
    strategies: [strategy("ip_hashed", 5, 3)],
    targets: [target("1.2.3.4", 443, 3)],
  },
  {
    id: "tpl-4",
    name: "香港 → 东京 → 洛杉矶 → 法兰克福",
    hops: 4,
    enabled: true,
    chains: 7,
    users: 4,
    status: { kind: "degraded", cause: "member_unhealthy" },
    strategies: [strategy("failover", 7, 4)],
    targets: [target("172.16.0.1", 8443, 7)],
  },
  {
    id: "tpl-6",
    name: "香港 → 东京 → 洛杉矶 → 法兰克福 → 伦敦 → 圣保罗",
    hops: 6,
    enabled: true,
    chains: 20,
    users: 20,
    status: { kind: "ok", cause: null },
    strategies: [strategy("ip_hashed", 12, 9)],
    targets: [target("10.0.6.1", 443, 20)],
  },
  {
    id: "tpl-empty",
    name: "备用模板（未建链）",
    hops: 2,
    enabled: false,
    chains: 0,
    users: 0,
    status: { kind: "blocked", cause: "disabled" },
    strategies: [],
    targets: [],
  },
  {
    id: "tpl-fold",
    name: "香港 → 东京（6 台 × 3 目标）",
    hops: 2,
    enabled: true,
    chains: 18,
    users: 3,
    status: { kind: "ok", cause: null },
    strategies: [strategy("ip_hashed", 18, 3)],
    targets: [target("10.0.1.1", 443, 3)],
  },
  {
    id: "tpl-dense",
    name: "香港 → 东京（8 台密集药丸）",
    hops: 2,
    enabled: true,
    chains: 8,
    users: 2,
    status: { kind: "ok", cause: null },
    strategies: [strategy("ip_hashed", 8, 2)],
    targets: [target("10.9.9.1", 443, 8)],
  },
];

const DETAILS = {
  "tpl-3": detail3Hop,
  "tpl-4": detail4Hop,
  "tpl-6": detail6Hop,
  "tpl-empty": detailEmpty,
  "tpl-fold": detail1HopWide,
  "tpl-dense": detailDense,
};

function chainHealthPayload() {
  const bucket = 900;
  const end = Math.floor(NOW / bucket) * bucket;
  return {
    generated_at: NOW,
    hours: 24,
    bucket,
    summary: {
      hop_p50_ms: 64,
      delta_ms: 12,
      slow_chains: 1,
      total_chains: 9,
      worst_hop: { chain_id: "chain-1", chain_name: "香港 → 东京", seq: 2, p50_ms: 41 },
    },
    chains: [],
    scope: { server_ids: [], filtered: false },
    warnings: {},
  };
}

/* ------------------------------------------------------------------ */
/* mock + 浏览器                                                       */
/* ------------------------------------------------------------------ */

async function mockApi(page, options = {}) {
  await page.route("**/api/v1/overview/chain-templates**", async (route) => {
    const url = new URL(route.request().url());
    const base = "/api/v1/overview/chain-templates";
    if (url.pathname === base) {
      if (options.listStatus === 404) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "not_found" } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ generated_at: NOW, items: LIST_ITEMS }),
      });
      return;
    }
    if (options.detailStatus === 404) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found" } }),
      });
      return;
    }
    const id = decodeURIComponent(url.pathname.slice(base.length + 1));
    const hours = Number(url.searchParams.get("hours") ?? "24") === 168 ? 168 : 24;
    const build = DETAILS[id] ?? detail3Hop;
    const payload = build();
    // 使用量窗口换成请求的小时数，其它形状保持一致。
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...payload, series: usageSeries(hours) }),
    });
  });
  await page.route("**/api/v1/overview/chain-health*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(chainHealthPayload()),
    });
  });
}

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const cookie = login.headers
  .getSetCookie()
  .map((item) => item.split(";")[0])
  .find((item) => item.startsWith("pierwave_session="));
if (!cookie) throw new Error("no session cookie");
const [cookieName, cookieValue] = cookie.split("=");

const browser = await chromium.launch({ executablePath: CHROME, headless: HEADLESS });

async function newPage({ width, height, theme, locale = "zh-CN", reducedMotion = false, options = {} }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await context.addInitScript(
    ({ theme, locale }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale },
  );
  await context.addCookies([
    {
      name: cookieName,
      value: cookieValue,
      url: `${BASE}/`,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await mockApi(page, options);
  return { context, page, errors };
}

async function openList(page) {
  await page.goto(`${BASE}/?view=chain&section=templates`, {
    waitUntil: "networkidle",
  });
  await page.locator("[data-chain-template-insight]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function openDetail(page, index = 0) {
  await page.locator("[data-chain-template-row]").nth(index).click();
  await page.locator("[data-template-dialog]").waitFor();
  await page.locator("[data-template-detail]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function waitFlow(page) {
  await page.locator("[data-template-flow-canvas]").waitFor();
  // React Flow 先量节点尺寸、再算连线位置；Dialog 的入场动画会让这一步更晚。
  // 等第一条连线出现，避免在「只有卡片没有线」的中间帧上断言。
  await page
    .locator("[data-template-flow-edge]").first()
    .waitFor({ state: "attached", timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function shot(locator, file, options = {}) {
  await locator.scrollIntoViewIfNeeded();
  // 清掉文本选择：亮色截图里选中「React」会变成一整块蓝，看起来像署名颜色错了。
  await locator.evaluate(() => window.getSelection()?.removeAllRanges());
  await locator.screenshot({ path: path.join(OUT, file), ...options });
  report.screenshots.push(file);
  console.log(`saved ${file}`);
}

async function zoomPercent(page) {
  const text = await page.locator("[data-flow-zoom-value]").textContent();
  return Number((text ?? "0%").replace("%", ""));
}

async function clickZoom(page, selector, times = 1) {
  for (let index = 0; index < times; index += 1) {
    await page.locator(selector).click();
    await page.waitForTimeout(120);
  }
}

function cardCountsByColumn(page) {
  return page.evaluate(() => {
    const counts = {};
    for (const card of document.querySelectorAll("[data-template-flow-card]")) {
      const column = card.getAttribute("data-column") ?? "?";
      counts[column] = (counts[column] ?? 0) + 1;
    }
    return counts;
  });
}

/* ------------------------------------------------------------------ */
/* 帧率采样：动作持续约 1 秒，用 rAF 计帧                                */
/* ------------------------------------------------------------------ */

const FPS_SAMPLE_MS = 1000;
/** 真机目标帧率。 */
const FPS_TARGET = 45;
/**
 * 无头 Chrome 走软件合成（没有 GPU 合成器），60Hz 往往只跑到 55 上下，
 * 偶尔掉到 40 多，所以无头下把门槛放宽到 30fps，只在「明显卡顿」时红；
 * 有头（`HEADED=1`）按真机目标 45fps 断言。实测值照样写进 report.json 的
 * fps.pan / fps.zoom。
 */
const FPS_FLOOR_HEADLESS = 30;
const FPS_FLOOR = HEADLESS ? FPS_FLOOR_HEADLESS : FPS_TARGET;

/** 先起 rAF 计数器，再执行 1 秒的平移 / 缩放动作，最后读回帧数。 */
async function startFpsSampler(page, durationMs = FPS_SAMPLE_MS) {
  await page.evaluate((duration) => {
    const sample = { frames: 0, done: false, ms: 0, start: performance.now() };
    window.__fpsSample = sample;
    const tick = () => {
      sample.frames += 1;
      const elapsed = performance.now() - sample.start;
      if (elapsed >= duration) {
        sample.ms = elapsed;
        sample.done = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, durationMs);
}

async function finishFpsSampler(page) {
  await page.waitForFunction(() => window.__fpsSample?.done === true, null, {
    timeout: 20000,
  });
  return page.evaluate(() => {
    const sample = window.__fpsSample;
    const fps = sample.ms > 0 ? (sample.frames / sample.ms) * 1000 : 0;
    window.__fpsSample = undefined;
    return {
      frames: sample.frames,
      ms: Math.round(sample.ms),
      fps: Math.round(fps * 10) / 10,
    };
  });
}

/** 1 秒连续拖拽平移：真实指针事件，每次移动 React Flow 都重算视口。 */
async function panForFps(page) {
  const box = await page.locator("[data-template-flow-canvas]").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let step = 1; step <= 16; step += 1) {
    await page.mouse.move(cx - step * 6, cy, { steps: 2 });
    await page.waitForTimeout(45);
  }
  await page.mouse.up();
}

/** 1 秒连续 Ctrl + 滚轮缩放，与真实 Ctrl / ⌘ 滚轮走同一条处理路径。 */
async function zoomForFps(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const pane = document.querySelector(".react-flow__pane");
        let ticks = 0;
        const timer = setInterval(() => {
          ticks += 1;
          pane.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: ticks % 2 === 0 ? 40 : -40,
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
          if (ticks >= 17) {
            clearInterval(timer);
            resolve();
          }
        }, 55);
      }),
  );
}

function assertFps(label, result) {
  assert.ok(result.frames > 0, `${label} 未采到帧`);
  assert.ok(
    result.fps >= FPS_FLOOR,
    `${label} ${result.fps}fps 低于门槛 ${FPS_FLOOR}fps（真机目标 ${FPS_TARGET}fps，无头下限 ${FPS_FLOOR_HEADLESS}fps）`,
  );
}

/* ------------------------------------------------------------------ */
/* 1) 3 跳：首屏缩放 / 每列卡片 / DOM / 动画边 / 署名 / 触屏            */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
  });
  await openList(page);
  // 首屏耗时：从点击行到第一张卡片可见（含懒加载 chunk 请求）。
  await page.evaluate(() => {
    window.__flowStart = performance.now();
  });
  await page.locator("[data-chain-template-row]").first().click();
  await page.locator("[data-template-dialog]").waitFor();
  await page.locator("[data-template-detail]").waitFor();
  await page.locator("[data-template-flow-card]").first().waitFor();
  const firstPaintMs = await page.evaluate(() =>
    Math.round(performance.now() - (window.__flowStart ?? performance.now())),
  );
  await waitFlow(page);

  const zoom = await zoomPercent(page);
  assert.ok(zoom >= 90 && zoom <= 100, `首屏缩放应在 90–100%，实际 ${zoom}%`);

  const counts = await cardCountsByColumn(page);
  for (const [column, count] of Object.entries(counts)) {
    assert.ok(count <= 5, `第 ${column} 列可见卡 ${count} 张，超过 5`);
  }

  // 列顶对齐 + 列距 80（卡片 192×64）。
  const geometry = await page.evaluate(() => {
    const byColumn = new Map();
    for (const card of document.querySelectorAll("[data-template-flow-card]")) {
      const node = card.closest(".react-flow__node");
      if (node === null) continue;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      const column = Number(card.getAttribute("data-column"));
      const entry = byColumn.get(column) ?? { x: matrix.m41, minY: Infinity };
      entry.minY = Math.min(entry.minY, matrix.m42);
      byColumn.set(column, entry);
    }
    return Object.fromEntries(
      [...byColumn.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([column, value]) => [column, value]),
    );
  });
  const columnKeys = Object.keys(geometry).map(Number).sort((a, b) => a - b);
  for (const column of columnKeys) {
    assert.equal(geometry[column].minY, 24, `第 ${column} 列顶边应统一在 y=24`);
  }
  for (let index = 1; index < columnKeys.length; index += 1) {
    const gap =
      geometry[columnKeys[index]].x - geometry[columnKeys[index - 1]].x;
    assert.equal(gap, 192 + 80, `列距应为 80px（x 差 ${gap}）`);
  }
  report.assertions["geometry"] = geometry;

  const chunkTiming = await page.evaluate(() => {
    const entry = performance
      .getEntriesByType("resource")
      .find((item) => item.name.includes("ChainTemplateFlow-"));
    return entry === undefined
      ? null
      : {
          name: entry.name.split("/").pop(),
          durationMs: Math.round(entry.duration),
          transferSize: entry.transferSize,
          decodedBodySize: entry.decodedBodySize,
        };
  });
  const pulseCount = await page.locator(".template-flow-pulse").count();
  assert.ok(pulseCount > 0, "应有脉冲边");
  assert.ok(pulseCount <= 10, `动画边 ${pulseCount} 条，超过 10`);

  const dom = await page.evaluate(
    () => document.querySelectorAll("[data-template-flow] *").length,
  );
  assert.ok(dom <= 600, `画布 DOM ${dom} 个，超过 600`);

  const style = await page.evaluate(() => {
    const attribution = document.querySelector(".react-flow__attribution");
    const pane = document.querySelector(".react-flow__pane");
    const attributionStyle = attribution ? getComputedStyle(attribution) : null;
    const paneStyle = pane ? getComputedStyle(pane) : null;
    const cardTitle = document.querySelector("[data-template-flow-card-title]");
    const host = document.querySelector("[data-template-flow]");
    const rgb = (value) => {
      const match = /rgba?\(([^)]+)\)/.exec(value ?? "");
      return match === null
        ? null
        : match[1].split(",").slice(0, 3).map((part) => Number(part.trim()));
    };
    return {
      attributionFontSize: attributionStyle?.fontSize ?? null,
      attributionColor: attributionStyle?.color ?? null,
      attributionRgb: rgb(attributionStyle?.color ?? ""),
      titleFontSize: cardTitle === null ? null : parseFloat(getComputedStyle(cardTitle).fontSize),
      hostHeight: host === null ? null : host.clientHeight,
      touchAction: paneStyle?.touchAction ?? null,
    };
  });
  assert.equal(style.attributionFontSize, "12px", "署名应为 12px");
  assert.equal(style.titleFontSize, 13, "卡片标题应为 13px");
  assert.ok(
    isNeutralColor(style.attributionColor),
    `署名应为中性 muted 灰，实际 ${style.attributionColor}`,
  );
  assert.equal(style.touchAction, "pan-y", "pane 需要 touch-action: pan-y");
  // 默认缩放下的实际字号：13px × zoom。
  assert.ok(
    (style.titleFontSize ?? 0) * (zoom / 100) >= 11.7 - 1e-6,
    `默认缩放 ${zoom}% 下标题实际 ${((style.titleFontSize ?? 0) * zoom) / 100}px，低于 11.7px`,
  );
  const canvasCap = await page.evaluate(() =>
    Math.min(640, window.innerHeight * 0.52),
  );
  assert.ok(
    style.hostHeight !== null && style.hostHeight <= canvasCap + 1,
    `画布高度 ${style.hostHeight}px 超过上限 ${canvasCap}px`,
  );

  const foldCards = await page.locator('[data-template-flow-card][data-kind="fold"]').count();
  const targetFolds = await page.locator("[data-template-flow-target-fold]").count();
  assert.ok(targetFolds > 0, "3 跳目标列应有 +N 目标标签");
  // 3 跳内容放得下：底部提示不出现（只有内容被画布下缘裁掉才提示）。
  assert.equal(
    await page.locator("[data-template-flow-more-below]").count(),
    0,
    "内容在视野内时不应出现底部提示",
  );

  const width = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(width.scrollWidth <= width.innerWidth, "页面不应横向溢出");

  assert.deepEqual(errors, []);
  await shot(page.locator("[data-template-dialog]"), "3hop-1440-dark.png");
  await shot(page.locator("[data-template-topology-card]"), "3hop-topology-1440-dark.png");

  report.assertions["3hop"] = {
    zoom,
    perColumn: counts,
    pulseCount,
    dom,
    attributionFontSize: style.attributionFontSize,
    attributionColor: style.attributionColor,
    titleFontSize: style.titleFontSize,
    hostHeight: style.hostHeight,
    touchAction: style.touchAction,
    foldCards,
    targetFolds,
    firstPaintMs,
    chunkTiming,
  };

  /* ---- hover 路径：其余卡片 35% ---- */
  const target = page.locator("[data-template-flow-card][data-role='target']").first();
  await target.hover();
  await page.waitForTimeout(250);
  const hot = await page.evaluate(() => ({
    hot: document.querySelectorAll('[data-template-flow-card][data-hot="true"]').length,
    dim: document.querySelectorAll('[data-template-flow-card][data-hot="false"]').length,
  }));
  assert.ok(hot.dim > 0, "hover 时应压暗非路径卡片");
  assert.ok(hot.hot >= 2, "hover 时应点亮到入口的路径");
  await shot(page.locator("[data-template-dialog]"), "hover-path-1440-dark.png");
  report.assertions["hover"] = hot;

  /* ---- hover 连线（时延药丸）：点亮该连线到入口的路径 ---- */
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  await page.locator("[data-template-flow-pill]").first().hover();
  await page.waitForTimeout(250);
  const edgeHot = await page.evaluate(() => ({
    edgeHot: document.querySelectorAll(
      '[data-template-flow-edge-group][data-hot="true"]',
    ).length,
    edgeDim: document.querySelectorAll(
      '[data-template-flow-edge-group][data-hot="false"]',
    ).length,
    cardHot: document.querySelectorAll(
      '[data-template-flow-card][data-hot="true"]',
    ).length,
    cardDim: document.querySelectorAll(
      '[data-template-flow-card][data-hot="false"]',
    ).length,
  }));
  assert.ok(edgeHot.edgeHot >= 1, "hover 药丸应点亮这条连线");
  assert.ok(edgeHot.edgeDim > 0, "hover 药丸应压暗其它连线");
  assert.ok(edgeHot.cardHot >= 2, "hover 药丸应点亮路径上的卡片");
  assert.ok(edgeHot.cardDim > 0, "hover 药丸应压暗路径外的卡片");
  await shot(page.locator("[data-template-dialog]"), "hover-edge-1440-dark.png");
  report.assertions["edgeHover"] = edgeHot;
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);

  /* ---- tooltip ---- */
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  const foldedTargetCard = page
    .locator("[data-template-flow-card]")
    .filter({ has: page.locator("[data-template-flow-target-fold]") })
    .first();
  await foldedTargetCard.hover();
  const tooltip = page.locator('[data-slot="tooltip-content"]').last();
  await tooltip.waitFor({ state: "visible" });
  await page.waitForTimeout(200);
  const tooltipText = (await tooltip.textContent()) ?? "";
  assert.ok(tooltipText.includes("被折叠的目标"), `tooltip 应列出被折叠目标：${tooltipText}`);
  for (const label of ["合计", "条链", "个用户"]) {
    assert.ok(tooltipText.includes(label), `折叠目标 tooltip 缺少「${label}」：${tooltipText}`);
  }
  await page.screenshot({ path: path.join(OUT, "tooltip-1440-dark.png") });
  report.screenshots.push("tooltip-1440-dark.png");
  console.log("saved tooltip-1440-dark.png");

  /* ---- 时延药丸 tooltip：不可用路径说「最近已知」 ---- */
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  const unavailablePill = page
    .locator('[data-template-flow-pill][data-unavailable="true"]')
    .first();
  if ((await unavailablePill.count()) > 0) {
    // 键盘聚焦也能开 tooltip（药丸 tabIndex=0）；顺便截图。
    await unavailablePill.focus();
    await tooltip.waitFor({ state: "visible" });
    await page.waitForTimeout(200);
    const unavailableText = (await tooltip.textContent()) ?? "";
    assert.ok(
      unavailableText.includes("最近已知") || unavailableText.includes("不可用"),
      `不可用药丸 tooltip 应说明最近已知：${unavailableText}`,
    );
    await page.screenshot({ path: path.join(OUT, "tooltip-unavailable-1440-dark.png") });
    report.screenshots.push("tooltip-unavailable-1440-dark.png");
    report.assertions["unavailablePill"] = {
      text: unavailableText.slice(0, 80),
    };
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200);
  }

  /* ---- 缩放 100% / 50% / 150% ---- */
  await page.mouse.move(5, 5);
  await clickZoom(page, "[data-flow-zoom-in]");
  assert.equal(await zoomPercent(page), 100, "一次 + 应落到 100%");
  const fonts = await page.evaluate(() => {
    const size = (selector, root = document) => {
      const element = root.querySelector(selector);
      return element === null ? null : parseFloat(getComputedStyle(element).fontSize);
    };
    const card = document.querySelector("[data-template-flow-card]");
    return {
      title: size("[data-template-flow-card-title]", card),
      status: size("[data-template-flow-status-text]", card),
      subtitle: size("[data-template-flow-card-subtitle]", card),
      pill: size("[data-template-flow-pill]"),
      attribution: size(".react-flow__attribution"),
    };
  });
  // 100% 缩放下卡片标题 13px，状态 / 第二行 / 药丸 12px，署名 12px。
  assert.equal(fonts.title, 13, "卡片标题应为 13px");
  for (const key of ["status", "subtitle", "pill", "attribution"]) {
    assert.equal(fonts[key], 12, `${key} 应为 12px`);
  }
  report.assertions["fonts"] = fonts;
  await shot(page.locator("[data-template-topology-card]"), "zoom-100-1440-dark.png");
  await clickZoom(page, "[data-flow-zoom-out]", 2);
  assert.equal(await zoomPercent(page), 50, "两次 − 应落到 50%");
  // 50% 下整列都在视野内：底部提示隐藏（缩放后重算）。
  assert.equal(
    await page.locator("[data-template-flow-more-below]").count(),
    0,
    "50% 下内容都在视野内，不应出现底部提示",
  );
  await shot(page.locator("[data-template-topology-card]"), "zoom-50-1440-dark.png");
  await clickZoom(page, "[data-flow-zoom-in]", 4);
  assert.equal(await zoomPercent(page), 150, "四次 + 应落到 150%");
  // 150% 下画布装不下整列：底部提示随缩放重新出现。
  await page
    .locator("[data-template-flow-more-below]")
    .waitFor({ state: "visible", timeout: 5000 });
  await shot(page.locator("[data-template-topology-card]"), "zoom-150-1440-dark.png");
  report.assertions["zoomButtons"] = { "100": true, "50": true, "150": true };
  // 适应窗口回到首屏档位（≤100%）。
  await page.locator("[data-flow-zoom-fit]").click();
  await page.waitForTimeout(200);
  const fitZoom = await zoomPercent(page);
  assert.ok(fitZoom >= 40 && fitZoom <= 100, `适应窗口应在 40–100%，实际 ${fitZoom}%`);
  assert.equal(
    await page.locator("[data-template-flow-more-below]").count(),
    0,
    "适应窗口后内容放得下，底部提示应消失",
  );
  report.assertions["fitZoom"] = fitZoom;

  /* ---- 滚轮：普通滚轮滚弹窗，Ctrl / ⌘ 滚轮缩放 ---- */
  const dialogScroll = page.locator("[data-template-dialog-scroll]");
  await page.evaluate(() => {
    document.querySelector("[data-template-dialog-scroll]").scrollTop = 0;
  });
  const canvasBox = await page.locator("[data-template-flow-canvas]").boundingBox();
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + 80);
  const beforeWheelZoom = await zoomPercent(page);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(250);
  const afterWheelZoom = await zoomPercent(page);
  const scrollTop = await dialogScroll.evaluate((node) => node.scrollTop);
  assert.equal(afterWheelZoom, beforeWheelZoom, "普通滚轮不应缩放画布");
  assert.ok(scrollTop > 0, "普通滚轮应滚动弹窗");

  await page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane");
    pane.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -180,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.waitForTimeout(300);
  const afterCtrlZoom = await zoomPercent(page);
  assert.notEqual(afterCtrlZoom, afterWheelZoom, "Ctrl + 滚轮应缩放画布");
  assert.ok(afterCtrlZoom <= 160, "Ctrl + 滚轮不应超过 160%");

  await page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane");
    pane.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 180,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.waitForTimeout(300);
  const afterMetaZoom = await zoomPercent(page);
  assert.notEqual(afterMetaZoom, afterCtrlZoom, "⌘ + 滚轮应缩放画布");
  report.assertions["wheel"] = {
    beforeWheelZoom,
    afterWheelZoom,
    scrollTop,
    afterCtrlZoom,
    afterMetaZoom,
  };

  /* ---- 双击不缩放 ---- */
  const beforeDblClick = await zoomPercent(page);
  const canvasBoxDbl = await page.locator("[data-template-flow-canvas]").boundingBox();
  await page.mouse.dblclick(
    canvasBoxDbl.x + canvasBoxDbl.width - 40,
    canvasBoxDbl.y + canvasBoxDbl.height - 20,
  );
  await page.waitForTimeout(300);
  assert.equal(await zoomPercent(page), beforeDblClick, "双击不应缩放画布");
  report.assertions["dblClick"] = { zoom: beforeDblClick };

  /* ---- 拖拽平移：不丢图（卡片数量不变，视口位移） ---- */
  await page.locator("[data-flow-zoom-fit]").click();
  await page.waitForTimeout(250);
  const beforeDrag = await page.evaluate(() => ({
    transform: document.querySelector(".react-flow__viewport").style.transform,
    cards: document.querySelectorAll("[data-template-flow-card]").length,
  }));
  const box = await page.locator("[data-template-flow-canvas]").boundingBox();
  await page.mouse.move(box.x + box.width - 40, box.y + box.height - 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 160, box.y + box.height - 90, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const afterDrag = await page.evaluate(() => ({
    transform: document.querySelector(".react-flow__viewport").style.transform,
    cards: document.querySelectorAll("[data-template-flow-card]").length,
  }));
  assert.equal(afterDrag.cards, beforeDrag.cards, "拖拽后卡片数量不应变化");
  assert.notEqual(afterDrag.transform, beforeDrag.transform, "拖拽应平移视口");
  report.assertions["drag"] = { beforeDrag, afterDrag };

  /* ---- Tab 可达 ---- */
  await page.locator("[data-template-flow-card]").first().focus();
  const tabbed = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      inCanvas: Boolean(active?.closest("[data-template-flow]")),
      tag: active?.tagName ?? null,
      focusable: document.querySelectorAll(
        "[data-template-flow] [tabindex='0'], [data-template-flow] button",
      ).length,
    };
  });
  assert.ok(tabbed.inCanvas, "焦点应能落在画布卡片上");
  assert.ok(tabbed.focusable >= 4, "画布内应有可 Tab 到的卡片");
  report.assertions["tab"] = tabbed;

  /* ---- 亮色主题 ---- */
  // Tab 测试会把焦点留在卡片上（trigger 会开 tooltip、点高亮），先清掉。
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    localStorage.setItem("pierwave.theme", "light");
    const root = document.documentElement;
    root.dataset.theme = "light";
    root.classList.remove("dark");
    root.style.colorScheme = "light";
  });
  await page.waitForTimeout(500);
  const lightAttribution = await page.evaluate(() => {
    const link = document.querySelector(".react-flow__attribution a");
    const attribution = document.querySelector(".react-flow__attribution");
    const color = getComputedStyle(link ?? attribution).color;
    const match = /rgba?\(([^)]+)\)/.exec(color);
    const rgb = match === null
      ? null
      : match[1].split(",").slice(0, 3).map((part) => Number(part.trim()));
    return { color, rgb };
  });
  assert.ok(
    isNeutralColor(lightAttribution.color),
    `亮色署名应为中性 muted 灰，实际 ${lightAttribution.color}`,
  );
  report.assertions["lightAttribution"] = lightAttribution;
  await shot(page.locator("[data-template-topology-card]"), "3hop-1440-light.png");

  report.errors.push(...errors.map((error) => `3hop: ${error}`));
  assert.deepEqual(errors, []);
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 1b) 英文：缩放栏与折叠标签都要有英文文案                            */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
    locale: "en",
  });
  await openList(page);
  await openDetail(page, 0);
  await waitFlow(page);
  const enFit = (await page.locator("[data-flow-zoom-fit]").textContent())?.trim();
  const enZoom = (await page.locator("[data-flow-zoom-value]").textContent())?.trim();
  assert.equal(enFit, "Fit to view", "英文缩放栏文案");
  assert.ok(/^\d+%$/.test(enZoom ?? ""), `缩放读数 ${enZoom}`);
  const enCard = await page
    .locator("[data-template-flow-card]")
    .first()
    .getAttribute("aria-label");
  assert.ok((enCard ?? "").includes("Entry"), `英文卡片 aria：${enCard}`);
  await shot(page.locator("[data-template-topology-card]"), "zoom-bar-1440-dark-en.png");
  report.assertions["en"] = { fit: enFit, zoom: enZoom, aria: enCard };
  assert.deepEqual(errors, []);
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 2) 4 跳：折叠 / 展开 / 恢复默认                                     */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
  });
  await openList(page);
  await openDetail(page, 1);
  await waitFlow(page);
  await shot(page.locator("[data-template-dialog]"), "4hop-1440-dark.png");
  const collapsed = await cardCountsByColumn(page);
  const foldCount = await page
    .locator('[data-template-flow-card][data-kind="fold"]')
    .count();
  assert.ok(foldCount >= 2, "4 跳应有至少两张折叠卡");
  assert.ok(await page.locator("[data-template-flow-reset]").count() === 0);
  await shot(page.locator("[data-template-topology-card]"), "collapsed-1440-dark.png");

  const firstFold = page.locator('[data-template-flow-card][data-kind="fold"]').first();
  const foldColumn = await firstFold.getAttribute("data-column");
  await firstFold.click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(350);
  const expanded = await cardCountsByColumn(page);
  assert.ok(
    expanded[foldColumn] > collapsed[foldColumn],
    `展开后第 ${foldColumn} 列应显示更多卡片`,
  );
  // 只展开本列：其它列的折叠卡还在。
  const foldsAfter = await page
    .locator('[data-template-flow-card][data-kind="fold"]')
    .count();
  assert.equal(foldsAfter, foldCount - 1, "只应展开点击的那一列");
  assert.ok(await page.locator("[data-template-flow-reset]").count() === 1);
  await shot(page.locator("[data-template-topology-card]"), "expanded-1440-dark.png");

  // 键盘：Enter / 空格与点击同语义（折叠卡是 role=button）。
  await page.locator("[data-template-flow-reset]").click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const keyboardFold = page
    .locator('[data-template-flow-card][data-kind="fold"]')
    .first();
  await keyboardFold.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const keyboardFolds = await page
    .locator('[data-template-flow-card][data-kind="fold"]')
    .count();
  assert.equal(keyboardFolds, foldCount - 1, "Enter 应展开该列");
  report.assertions["keyboard"] = {
    foldsAfterEnter: keyboardFolds,
    foldsBefore: foldCount,
  };

  // 整图（适应窗口）：5 列比 1040 的弹窗宽，默认 90% 需要平移才看得到目标列。
  await page.locator("[data-flow-zoom-fit]").click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(350);
  await shot(page.locator("[data-template-topology-card]"), "expanded-fit-1440-dark.png");

  await page.locator("[data-template-flow-reset]").click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(350);
  const restored = await page.evaluate(() => ({
    folds: document.querySelectorAll('[data-template-flow-card][data-kind="fold"]').length,
    reset: document.querySelectorAll("[data-template-flow-reset]").length,
  }));
  assert.equal(restored.folds, foldCount, "恢复默认后折叠卡应回来");
  assert.equal(restored.reset, 0, "恢复默认后按钮消失");
  await shot(page.locator("[data-template-topology-card]"), "collapsed-fit-1440-dark.png");

  // 折叠卡 tooltip：列前 8 名 + 最差状态（截图放在折叠/展开之后，避免 tooltip 残留）。
  const foldCard = page.locator('[data-template-flow-card][data-kind="fold"]').first();
  await foldCard.hover();
  const foldTooltip = page.locator('[data-slot="tooltip-content"]').last();
  await foldTooltip.waitFor({ state: "visible" });
  await page.waitForTimeout(200);
  const foldTooltipText = (await foldTooltip.textContent()) ?? "";
  assert.ok(
    foldTooltipText.includes("被折叠的成员"),
    `折叠卡 tooltip 应列出成员：${foldTooltipText}`,
  );
  // 卡片标题只有 `+N 台`：tooltip 标题要补回「第 N 跳」。
  assert.match(
    foldTooltipText,
    /第 \d+ 跳/,
    `折叠卡 tooltip 标题应包含跳数：${foldTooltipText}`,
  );
  const foldTitleText =
    (await page.locator("[data-template-flow-fold-title]").last().textContent()) ??
    "";
  assert.match(
    foldTitleText.trim(),
    /^第 \d+ 跳 · 被折叠的成员 · \d+$/,
    `折叠卡 tooltip 标题格式：${foldTitleText}`,
  );
  const foldSubtitles = await page
    .locator(
      '[data-template-flow-card][data-kind="fold"] [data-template-flow-card-subtitle]',
    )
    .allTextContents();
  for (const subtitle of foldSubtitles) {
    for (const label of ["条链", "用户"]) {
      assert.ok(
        subtitle.includes(label),
        `折叠卡副标题应保留「${label}」：${subtitle}`,
      );
    }
  }
  assert.ok(
    foldSubtitles.some((subtitle) => subtitle.includes("含")),
    `含离线成员的折叠卡副标题应补离线台数：${foldSubtitles.join(" | ")}`,
  );
  await page.screenshot({ path: path.join(OUT, "tooltip-fold-1440-dark.png") });
  report.screenshots.push("tooltip-fold-1440-dark.png");
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);

  // 合并虚线 tooltip：来自几条被折路径、共几条链。
  const mergedTrigger = page.locator("[data-template-flow-edge-trigger]").first();
  if ((await mergedTrigger.count()) > 0) {
    // 合并虚线是 L 形路径，bbox 中心不一定落在线上；用键盘聚焦更稳定。
    await mergedTrigger.focus();
    const mergedTooltip = page.locator('[data-slot="tooltip-content"]').last();
    await mergedTooltip.waitFor({ state: "visible" });
    await page.waitForTimeout(200);
    const mergedText = (await mergedTooltip.textContent()) ?? "";
    assert.ok(
      mergedText.includes("来自已折叠") && mergedText.includes("条路径"),
      `合并虚线 tooltip 应说明来源：${mergedText}`,
    );
    // 聚焦合并虚线：同样点亮它到入口的路径，其余 35% 淡出。
    const mergedHot = await page.evaluate(() => ({
      edgeHot: document.querySelectorAll(
        '[data-template-flow-edge-group][data-hot="true"]',
      ).length,
      edgeDim: document.querySelectorAll(
        '[data-template-flow-edge-group][data-hot="false"]',
      ).length,
      cardHot: document.querySelectorAll(
        '[data-template-flow-card][data-hot="true"]',
      ).length,
    }));
    assert.ok(mergedHot.edgeHot >= 1, "聚焦合并虚线应点亮这条连线");
    assert.ok(mergedHot.edgeDim > 0, "聚焦合并虚线应压暗其它连线");
    assert.ok(mergedHot.cardHot >= 2, "聚焦合并虚线应点亮路径上的卡片");
    report.assertions["mergedHighlight"] = mergedHot;
    await page.screenshot({ path: path.join(OUT, "tooltip-merged-1440-dark.png") });
    report.screenshots.push("tooltip-merged-1440-dark.png");
    report.assertions["mergedPill"] = { text: mergedText.slice(0, 100) };
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200);
  }

  // 目标 +N 标签只展开这一组。
  const targetFold = page.locator("[data-template-flow-target-fold]").first();
  if ((await targetFold.count()) > 0) {
    const before = await page.evaluate(
      () => document.querySelectorAll("[data-template-flow-card][data-role='target']").length,
    );
    await targetFold.click();
    await page.waitForTimeout(300);
    const after = await page.evaluate(
      () => document.querySelectorAll("[data-template-flow-card][data-role='target']").length,
    );
    assert.ok(after >= before, "展开目标组后目标卡不应减少");
  }

  const foldDom = await page.evaluate(
    () => document.querySelectorAll("[data-template-flow] *").length,
  );
  assert.ok(foldDom <= 600, `4 跳画布 DOM ${foldDom} 个，超过 600`);
  report.assertions["fold"] = {
    collapsed,
    expanded,
    foldColumn,
    foldsAfter,
    restored,
    dom: foldDom,
  };
  assert.deepEqual(errors, []);
  report.errors.push(...errors.map((error) => `4hop: ${error}`));
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 3) 6 跳：列数 / 折叠 / DOM 预算                                     */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
  });
  await openList(page);
  await openDetail(page, 2);
  await waitFlow(page);
  const counts = await cardCountsByColumn(page);
  assert.ok(Object.keys(counts).length >= 6, "6 跳应有 7 列");
  for (const [column, count] of Object.entries(counts)) {
    assert.ok(count <= 5, `第 ${column} 列 ${count} 张卡，超过 5`);
  }
  const domBreakdown = await page.evaluate(() => ({
    total: document.querySelectorAll("[data-template-flow] *").length,
    cards: document.querySelectorAll("[data-template-flow-card]").length,
    cardsDom: document.querySelectorAll(".react-flow__node *").length,
    handles: document.querySelectorAll(".react-flow__handle").length,
    edges: document.querySelectorAll("[data-template-flow-edge]").length,
    edgeGroups: document.querySelectorAll("[data-template-flow-edge-group]").length,
    edgesDom: document.querySelectorAll(".react-flow__edges *").length,
    pulses: document.querySelectorAll(".template-flow-pulse").length,
    pills: document.querySelectorAll("[data-template-flow-pill]").length,
    chrome: document.querySelectorAll("[data-template-flow] > *").length,
  }));
  const dom = domBreakdown.total;
  console.log("6hop dom", domBreakdown);
  assert.ok(dom <= 600, `6 跳画布 DOM ${dom} 个，超过 600`);
  const zoom = await zoomPercent(page);
  assert.ok(zoom >= 90 && zoom <= 100, `6 跳首屏缩放 ${zoom}% 不在 90–100%`);
  // 默认 0.9 下右侧仍有列：右缘提示 + 点击平移一屏。
  const hostHeight = await page.evaluate(
    () => document.querySelector("[data-template-flow]").clientHeight,
  );
  const canvasCap = await page.evaluate(() =>
    Math.min(640, window.innerHeight * 0.52),
  );
  assert.ok(
    hostHeight <= canvasCap + 1,
    `6 跳画布高度 ${hostHeight}px 超过上限 ${canvasCap}px`,
  );
  const more = page.locator("[data-template-flow-more]");
  await more.waitFor({ state: "visible", timeout: 5000 });
  const moreColumns = Number(await more.getAttribute("data-columns"));
  assert.ok(moreColumns > 0, `右侧提示应有列数，实际 ${moreColumns}`);
  // 计数口径：按列内卡片的右边缘是否超出视口，半截露出的列也要计入。
  const rightEdges = await page.evaluate(() => {
    const host = document.querySelector("[data-template-flow]");
    const hostRect = host.getBoundingClientRect();
    const byColumn = new Map();
    for (const card of host.querySelectorAll("[data-template-flow-card]")) {
      const rect = card.getBoundingClientRect();
      const column = Number(card.getAttribute("data-column"));
      const entry = byColumn.get(column) ?? { left: Infinity, right: -Infinity };
      entry.left = Math.min(entry.left, rect.left);
      entry.right = Math.max(entry.right, rect.right);
      byColumn.set(column, entry);
    }
    const truncated = [];
    const partial = [];
    for (const [column, entry] of byColumn) {
      if (entry.right > hostRect.right + 0.5) truncated.push(column);
      if (entry.left < hostRect.right && entry.right > hostRect.right + 0.5) {
        partial.push(column);
      }
    }
    return { truncated, partial };
  });
  assert.equal(
    rightEdges.truncated.length,
    moreColumns,
    `右缘提示应按卡片右边缘计数：提示 ${moreColumns} 列，实测 ${rightEdges.truncated.length} 列`,
  );
  // 半截列是否必然存在取决于视口右缘落在列内还是列间空隙：这里只记录，
  // 专门的 3c 块会把边界拖进列内，断言「半截列计入」。
  assert.equal(
    await more.getAttribute("data-pan-duration"),
    "220",
    "正常动效下平移 220ms",
  );
  await shot(page.locator("[data-template-dialog]"), "6hop-1440-dark.png");
  // 一次一屏，直到右缘提示消失（半截列会多留一屏）。
  let rightPans = 0;
  while (
    rightPans < 6 &&
    (await page.locator("[data-template-flow-more]").count()) > 0
  ) {
    await page.locator("[data-template-flow-more]").click();
    rightPans += 1;
    await page.waitForTimeout(320);
  }
  assert.equal(
    await page.locator("[data-template-flow-more]").count(),
    0,
    "平移到最右后右缘提示应消失",
  );
  // 提示消失 ⇔ 没有任何卡片右边缘还在视口外（同一口径）。
  const truncatedAfterPan = await page.evaluate(() => {
    const host = document.querySelector("[data-template-flow]");
    const hostRect = host.getBoundingClientRect();
    return [...host.querySelectorAll("[data-template-flow-card]")].filter(
      (card) => card.getBoundingClientRect().right > hostRect.right + 0.5,
    ).length;
  });
  assert.equal(truncatedAfterPan, 0, `提示消失后仍有 ${truncatedAfterPan} 张卡被右缘裁掉`);
  report.assertions["rightHint"] = {
    columns: moreColumns,
    truncated: rightEdges.truncated.length,
    partial: rightEdges.partial.length,
    pans: rightPans,
  };
  // 6 跳整图：适应窗口后能一眼看到「入口 → … → 目标」。
  await page.locator("[data-flow-zoom-fit]").click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(350);
  const fitZoom = await zoomPercent(page);
  await shot(page.locator("[data-template-topology-card]"), "6hop-fit-1440-dark.png");

  /* ---- 帧率：平移 1 秒、缩放 1 秒各采样 rAF 帧数 ---- */
  await page.mouse.move(5, 5);
  await startFpsSampler(page);
  await panForFps(page);
  const panFps = await finishFpsSampler(page);
  assertFps("平移", panFps);
  await page.mouse.move(5, 5);
  await startFpsSampler(page);
  await zoomForFps(page);
  const zoomFps = await finishFpsSampler(page);
  assertFps("缩放", zoomFps);
  // 无头 Chrome 用软件合成：真机目标 45fps，这里放宽到 30fps 并记录实测值。
  report.fps = {
    pan: panFps.fps,
    zoom: zoomFps.fps,
    panFrames: panFps.frames,
    zoomFrames: zoomFps.frames,
    sampleMs: FPS_SAMPLE_MS,
    target: FPS_TARGET,
    floor: FPS_FLOOR,
    headless: HEADLESS,
  };
  await page.locator("[data-flow-zoom-fit]").click();
  await page.waitForTimeout(250);
  report.assertions["6hop"] = { counts, dom, zoom, fitZoom, hostHeight, canvasCap };
  assert.deepEqual(errors, []);
  report.errors.push(...errors.map((error) => `6hop: ${error}`));
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 3a) 折叠上游：每个目标 +N 都能展开（回归）                          */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
  });
  await openList(page);
  await openDetail(page, 4);
  await waitFlow(page);
  const before = await page.evaluate(() => ({
    targets: document.querySelectorAll(
      "[data-template-flow-card][data-role='target']",
    ).length,
    folds: document.querySelectorAll("[data-template-flow-target-fold]").length,
  }));
  // 6 台里 4 台可见 + 1 张折叠卡 = 5 个上游组，每组都有 +N。
  assert.equal(before.folds, 5, `折叠态应有 5 个 +N，实际 ${before.folds}`);
  await shot(
    page.locator("[data-template-topology-card]"),
    "fold-target-before-1440-dark.png",
  );

  let clicks = 0;
  while (clicks < 10) {
    const fold = page.locator("[data-template-flow-target-fold]").first();
    if ((await fold.count()) === 0) break;
    await fold.click();
    clicks += 1;
    await page.waitForTimeout(250);
  }
  // 点击 +N 后指针停在最后一张卡上，会触发路径高亮；截图前移开。
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    targets: document.querySelectorAll(
      "[data-template-flow-card][data-role='target']",
    ).length,
    folds: document.querySelectorAll("[data-template-flow-target-fold]").length,
  }));
  assert.equal(after.folds, 0, "每个 +N 都应能展开，不能残留点不动的标签");
  assert.equal(after.targets, 18, `全部展开后应有 18 张目标卡，实际 ${after.targets}`);
  // 18 张目标卡远超视口：画布必须停在上限，而不是继续长高。
  const tallCanvas = await page.evaluate(() => ({
    hostHeight: document.querySelector("[data-template-flow]").clientHeight,
    cap: Math.min(640, window.innerHeight * 0.52),
  }));
  assert.ok(
    tallCanvas.hostHeight <= tallCanvas.cap + 1,
    `高画布 ${tallCanvas.hostHeight}px 超过上限 ${tallCanvas.cap}px`,
  );
  assert.equal(
    tallCanvas.hostHeight,
    Math.round(tallCanvas.cap),
    `内容超高时画布应停在上限 ${tallCanvas.cap}px`,
  );
  await shot(
    page.locator("[data-template-topology-card]"),
    "fold-target-after-1440-dark.png",
  );

  /* ---- 底部提示：内容被画布下缘裁掉时出现，平移到底后消失 ---- */
  const below = page.locator("[data-template-flow-more-below]");
  await below.waitFor({ state: "visible", timeout: 5000 });
  const belowState = await page.evaluate(() => {
    const host = document.querySelector("[data-template-flow]");
    const hostRect = host.getBoundingClientRect();
    const bottoms = [...host.querySelectorAll("[data-template-flow-card]")].map(
      (card) => card.getBoundingClientRect().bottom,
    );
    const button = document.querySelector("[data-template-flow-more-below]");
    return {
      overflow: Math.round(Math.max(...bottoms) - hostRect.bottom),
      duration: button.getAttribute("data-pan-duration"),
      fade: document.querySelectorAll("[data-template-flow-fade-below]").length,
      before: document.querySelector(".react-flow__viewport").style.transform,
    };
  });
  assert.ok(belowState.overflow > 1, `下方应还有内容，溢出 ${belowState.overflow}px`);
  assert.equal(belowState.duration, "220", "正常动效下平移 220ms");
  assert.equal(belowState.fade, 1, "底部提示应带下缘渐隐");
  await below.click();
  await page.waitForTimeout(350);
  const afterOneBelow = await page.evaluate(() => ({
    transform: document.querySelector(".react-flow__viewport").style.transform,
    hint: document.querySelectorAll("[data-template-flow-more-below]").length,
  }));
  assert.notEqual(
    afterOneBelow.transform,
    belowState.before,
    "点击底部提示应向下平移",
  );
  assert.equal(afterOneBelow.hint, 1, "一屏之后下方仍有内容，提示保留");
  let belowPans = 1;
  while (
    belowPans < 8 &&
    (await page.locator("[data-template-flow-more-below]").count()) > 0
  ) {
    await page.locator("[data-template-flow-more-below]").click();
    belowPans += 1;
    await page.waitForTimeout(350);
  }
  assert.equal(
    await page.locator("[data-template-flow-more-below]").count(),
    0,
    "平移到最下后底部提示应消失",
  );
  // 提示消失 ⇔ 没有卡片底边还在画布下方（同一口径）。
  const belowAfterPan = await page.evaluate(() => {
    const host = document.querySelector("[data-template-flow]");
    const hostRect = host.getBoundingClientRect();
    return [...host.querySelectorAll("[data-template-flow-card]")].filter(
      (card) => card.getBoundingClientRect().bottom > hostRect.bottom + 0.5,
    ).length;
  });
  assert.equal(belowAfterPan, 0, `提示消失后仍有 ${belowAfterPan} 张卡在画布下方`);

  report.assertions["foldTargets"] = { before, after, clicks, tallCanvas };
  report.assertions["bottomHint"] = {
    overflow: belowState.overflow,
    pans: belowPans,
    afterOnePan: afterOneBelow.hint,
  };
  assert.deepEqual(errors, []);
  report.errors.push(...errors.map((error) => `foldTargets: ${error}`));
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 3b) 展开后密集药丸：默认隐藏，悬停竖线 / 聚焦才显示                  */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
  });
  await openList(page);
  await openDetail(page, 5);
  await waitFlow(page);
  // 展开第 1 跳：入口竖线会有 8 个药丸。
  await page.locator('[data-template-flow-card][data-kind="fold"]').first().click();
  await page.waitForTimeout(400);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const dense = await page.evaluate(() => ({
    total: document.querySelectorAll(
      '[data-template-flow-pill][data-dense="true"]',
    ).length,
    hidden: document.querySelectorAll(
      '[data-template-flow-pill][data-dense="true"][data-pill-hidden="true"]',
    ).length,
  }));
  assert.ok(dense.total >= 8, `应有多条密集竖线，实际 ${dense.total} 个药丸`);
  assert.equal(dense.hidden, dense.total, "密集药丸默认应全部隐藏");
  await shot(
    page.locator("[data-template-topology-card]"),
    "dense-pills-hidden-1440-dark.png",
  );

  const firstHidden = page
    .locator(
      '[data-template-flow-pill][data-dense="true"][data-pill-hidden="true"]',
    )
    .first();
  const rail = await firstHidden.getAttribute("data-rail");
  // 悬停竖线本身（不是药丸）：HTML 16px 竖带覆盖整段连线。
  const railBox = await page
    .locator(`[data-template-flow-rail-hit][data-rail="${rail}"]`)
    .first()
    .boundingBox();
  assert.ok(railBox !== null, "密集竖线应有可悬停的命中带");
  await page.mouse.move(
    railBox.x + railBox.width / 2,
    railBox.y + railBox.height / 2,
  );
  await page.waitForTimeout(300);
  const railState = await page.evaluate((railValue) => ({
    shown: document.querySelectorAll(
      `[data-template-flow-pill][data-rail="${railValue}"][data-pill-hidden="false"]`,
    ).length,
    hidden: document.querySelectorAll(
      `[data-template-flow-pill][data-rail="${railValue}"][data-pill-hidden="true"]`,
    ).length,
  }), rail);
  assert.ok(railState.shown > 6, `悬停竖线后该线药丸应显示，实际 ${railState.shown}`);
  assert.equal(railState.hidden, 0, "同一条竖线的药丸应一起显示");
  await shot(
    page.locator("[data-template-topology-card]"),
    "dense-pills-hover-1440-dark.png",
  );

  // 药丸 tooltip：时延、链数、用户数。
  await page
    .locator(`[data-template-flow-pill][data-rail="${rail}"]`)
    .first()
    .hover();
  const pillTooltip = page.locator('[data-slot="tooltip-content"]').last();
  await pillTooltip.waitFor({ state: "visible" });
  await page.waitForTimeout(200);
  const pillTextContent = (await pillTooltip.textContent()) ?? "";
  for (const label of ["时延", "链数", "用户数"]) {
    assert.ok(
      pillTextContent.includes(label),
      `药丸 tooltip 缺少「${label}」：${pillTextContent}`,
    );
  }
  await page.screenshot({ path: path.join(OUT, "tooltip-pill-1440-dark.png") });
  report.screenshots.push("tooltip-pill-1440-dark.png");
  report.assertions["densePills"] = { dense, rail, railState, tooltip: pillTextContent.slice(0, 120) };

  // 键盘：聚焦隐藏药丸也应让它显示。
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  const hiddenAgain = page
    .locator(
      '[data-template-flow-pill][data-dense="true"][data-pill-hidden="true"]',
    )
    .first();
  if ((await hiddenAgain.count()) > 0) {
    // locator 会随属性变化重新解析，聚焦后断言同一竖线不再有隐藏药丸。
    const focusRail = await hiddenAgain.getAttribute("data-rail");
    await hiddenAgain.focus();
    await page.waitForTimeout(250);
    const focusState = await page.evaluate((railValue) => {
      const active = document.activeElement;
      return {
        activeRail: active?.getAttribute?.("data-rail") ?? null,
        activeHidden: active?.getAttribute?.("data-pill-hidden") ?? null,
        hiddenOnRail: document.querySelectorAll(
          `[data-template-flow-pill][data-rail="${railValue}"][data-pill-hidden="true"]`,
        ).length,
      };
    }, focusRail);
    assert.equal(focusState.activeRail, focusRail, "焦点应落在该竖线的药丸上");
    assert.equal(focusState.activeHidden, "false", "聚焦的药丸应显示");
    assert.equal(focusState.hiddenOnRail, 0, "同一竖线的药丸应一起显示");
  }
  assert.deepEqual(errors, []);
  report.errors.push(...errors.map((error) => `densePills: ${error}`));
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 3c) 右缘计数：半截露出的列也计入（按卡片右边缘）                    */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
  });
  await openList(page);
  await openDetail(page, 2);
  await waitFlow(page);

  const measure = () =>
    page.evaluate(() => {
      const host = document.querySelector("[data-template-flow]");
      const hostRect = host.getBoundingClientRect();
      const byColumn = new Map();
      for (const card of host.querySelectorAll("[data-template-flow-card]")) {
        const rect = card.getBoundingClientRect();
        const column = Number(card.getAttribute("data-column"));
        const entry = byColumn.get(column) ?? { left: Infinity, right: -Infinity };
        entry.left = Math.min(entry.left, rect.left);
        entry.right = Math.max(entry.right, rect.right);
        byColumn.set(column, entry);
      }
      const truncated = [];
      const partial = [];
      for (const [column, entry] of byColumn) {
        if (entry.right > hostRect.right + 0.5) truncated.push(column);
        if (entry.left < hostRect.right && entry.right > hostRect.right + 0.5) {
          partial.push(column);
        }
      }
      const hint = document.querySelector("[data-template-flow-more]");
      return {
        truncated,
        partial,
        hint: hint === null ? null : Number(hint.getAttribute("data-columns")),
      };
    });

  let state = await measure();
  assert.ok(state.hint !== null, "6 跳首屏应有右缘提示");
  assert.equal(
    state.hint,
    state.truncated.length,
    `提示列数应等于「卡片右边缘超出视口」的列数：${JSON.stringify(state)}`,
  );
  // 视口右缘可能正好落在列间空隙里：从画布底部空白处横向拖一点，把边界
  // 挪进某一列 —— 「半截露出」由此是构造出来的、可复现的。
  const box = await page.locator("[data-template-flow-canvas]").boundingBox();
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height - 24;
  for (let attempt = 0; attempt < 8 && state.partial.length === 0; attempt += 1) {
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 12, startY, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    state = await measure();
  }
  assert.ok(
    state.partial.length >= 1,
    `半截露出的列应计入右缘提示：${JSON.stringify(state)}`,
  );
  assert.equal(
    state.hint,
    state.truncated.length,
    `拖动后提示列数仍应按卡片右边缘计数：${JSON.stringify(state)}`,
  );
  report.assertions["rightHintPartial"] = state;
  assert.deepEqual(errors, []);
  report.errors.push(...errors.map((error) => `rightHintPartial: ${error}`));
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 4) 390：1 倍 + 横向滚动，页面不横向溢出                             */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 390,
    height: 844,
    theme: "dark",
  });
  await openList(page);
  try {
    await openDetail(page, 2);
  } catch (error) {
    const rows = await page.locator("[data-chain-template-row]").count();
    const html = await page
      .locator("[data-template-dialog]")
      .innerHTML()
      .catch(() => "<no dialog>");
    console.log("390 failure", { rows, html: html.slice(0, 800), url: page.url() });
    throw error;
  }
  await waitFlow(page);
  const compact = await page.evaluate(() => {
    const host = document.querySelector("[data-template-flow]");
    return {
      mode: host.getAttribute("data-template-flow-mode"),
      scrollWidth: host.scrollWidth,
      clientWidth: host.clientWidth,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      zoomBarVisible: Boolean(
        document.querySelector("[data-template-flow-zoom]")?.offsetParent,
      ),
      transform: document.querySelector(".react-flow__viewport").style.transform,
    };
  });
  assert.equal(compact.mode, "compact");
  assert.ok(compact.scrollWidth > compact.clientWidth, "390 画布应可横向滚动");
  assert.ok(compact.overflow <= 0, `390 页面横向溢出 ${compact.overflow}px`);
  assert.equal(compact.zoomBarVisible, false, "390 不显示缩放栏");
  assert.ok(compact.transform.includes("scale(1)"), "390 固定 1 倍");
  await page.screenshot({ path: path.join(OUT, "6hop-390-dark.png") });
  report.screenshots.push("6hop-390-dark.png");
  console.log("saved 6hop-390-dark.png");

  // 画布上竖滑滚弹窗（touch-action: pan-y 的运行时验证）。
  const paneTouch = await page.evaluate(
    () => getComputedStyle(document.querySelector(".react-flow__pane")).touchAction,
  );
  assert.equal(paneTouch, "pan-y");
  report.assertions["390"] = { ...compact, paneTouch };
  assert.deepEqual(errors, []);
  report.errors.push(...errors.map((error) => `390: ${error}`));
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 5) 空态 + 旧主控降级                                                */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
  });
  await openList(page);
  await openDetail(page, 3);
  await page.waitForTimeout(200);
  const empty = await page.evaluate(() => ({
    cards: document.querySelectorAll("[data-template-flow-card]").length,
    text: document.querySelector("[data-template-topology]")?.textContent ?? "",
    unused: document.querySelectorAll("[data-template-unused-member]").length,
  }));
  assert.equal(empty.cards, 0, "空态不应渲染卡片");
  assert.ok(empty.text.length > 0, "空态应有文案");
  assert.ok(empty.unused >= 1, "未使用候选仍要列出来");
  await shot(page.locator("[data-template-topology-card]"), "empty-1440-dark.png");
  report.assertions["empty"] = empty;
  assert.deepEqual(errors, []);
  await context.close();
}

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
    options: { detailStatus: 404 },
  });
  await openList(page);
  // 旧主控没有详情接口：弹窗只到「需要新版本主控」，不会有 detail 区块。
  await page.locator("[data-chain-template-row]").first().click();
  await page.locator("[data-template-dialog]").waitFor();
  await page.waitForTimeout(800);
  const text = (await page.locator("[data-template-dialog]").textContent()) ?? "";
  assert.ok(text.includes("需要新版本主控"), "旧主控应降级成「需要新版本主控」");
  assert.equal(await page.locator("[data-template-flow-canvas]").count(), 0);
  await shot(page.locator("[data-template-dialog]"), "old-master-1440-dark.png");
  report.assertions["oldMaster"] = { text: text.slice(0, 40) };
  // 404 是这一屏的预期结果（旧主控没有详情接口），只允许这一条网络噪音。
  assert.deepEqual(
    errors.filter((error) => !error.includes("404")),
    [],
  );
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 6) reduced-motion：脉冲静止可见                                     */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
    reducedMotion: true,
  });
  await openList(page);
  await openDetail(page, 0);
  await waitFlow(page);
  const pulse = await page.evaluate(() => {
    const first = document.querySelector(".template-flow-pulse");
    if (!first) return null;
    const style = getComputedStyle(first);
    return {
      animationName: style.animationName,
      strokeOpacity: Number(style.strokeOpacity),
      count: document.querySelectorAll(".template-flow-pulse").length,
    };
  });
  assert.ok(pulse !== null, "reduced-motion 下仍应渲染脉冲 path");
  assert.equal(pulse.animationName, "none", "reduced-motion 下不播动画");
  assert.ok(pulse.strokeOpacity > 0.2, "脉冲应静态可见");
  assert.ok(pulse.count <= 10);
  await shot(page.locator("[data-template-topology-card]"), "reduced-motion-1440-dark.png");
  report.assertions["reducedMotion"] = pulse;
  assert.deepEqual(errors, []);
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 6b) reduced-motion：平移瞬时（0ms），其余动效口径不变               */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
    reducedMotion: true,
  });
  await openList(page);
  await openDetail(page, 2);
  await waitFlow(page);
  const more = page.locator("[data-template-flow-more]");
  await more.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(
    await more.getAttribute("data-pan-duration"),
    "0",
    "减弱动效下平移动画应为 0ms",
  );
  // 点击后 3 帧内就到终点（220ms 动画在这时只走了一小截）。
  const jump = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const read = () =>
          document.querySelector(".react-flow__viewport").style.transform;
        const button = document.querySelector("[data-template-flow-more]");
        const before = read();
        button.click();
        let frames = 0;
        const settle = () => {
          frames += 1;
          if (frames < 3) {
            requestAnimationFrame(settle);
            return;
          }
          resolve({ before, after: read() });
        };
        requestAnimationFrame(settle);
      }),
  );
  await page.waitForTimeout(400);
  const settled = await page.evaluate(
    () => document.querySelector(".react-flow__viewport").style.transform,
  );
  assert.notEqual(jump.after, jump.before, "减弱动效下点击也应平移");
  assert.equal(
    jump.after,
    settled,
    "减弱动效下平移应在 3 帧内到终点（0ms 而不是 220ms）",
  );
  assert.ok(
    (await page.locator("[data-template-flow-more]").count()) <= 1,
    "平移后右缘提示状态应正常更新",
  );
  report.assertions["reducedMotionPan"] = {
    duration: "0",
    before: jump.before,
    after: jump.after,
    settled,
  };
  assert.deepEqual(errors, []);
  report.errors.push(...errors.map((error) => `reducedMotionPan: ${error}`));
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 7) 性能：chunk 大小 / 主 chunk 不含 React Flow                      */
/* ------------------------------------------------------------------ */

{
  const assets = path.join(WEB, "dist", "assets");
  const files = readdirSync(assets);
  const sizeOf = (file) => statSync(path.join(assets, file)).size;
  const flowChunk = files.find((file) => file.startsWith("ChainTemplateFlow-") && file.endsWith(".js"));
  const mainChunk = files.find((file) => file.startsWith("index-") && file.endsWith(".js"));
  const latencyChunk = files.find((file) => file.startsWith("ChainLatencyView-") && file.endsWith(".js"));
  assert.ok(flowChunk, "应有独立的 ChainTemplateFlow chunk");
  assert.ok(mainChunk, "应有入口 chunk");
  assert.ok(latencyChunk, "应有链路时延 chunk");
  const mainSource = readFileSync(path.join(assets, mainChunk), "utf8");
  const latencySource = readFileSync(path.join(assets, latencyChunk), "utf8");
  assert.equal(mainSource.includes("react-flow__"), false, "主 chunk 不应含 React Flow");
  assert.equal(
    latencySource.includes("react-flow__"),
    false,
    "「链路时延」chunk 不应含 React Flow",
  );
  report.assertions["chunks"] = {
    flowChunk: { file: flowChunk, bytes: sizeOf(flowChunk) },
    mainChunk: { file: mainChunk, bytes: sizeOf(mainChunk) },
    latencyChunk: { file: latencyChunk, bytes: sizeOf(latencyChunk) },
  };
}

await browser.close();
report.build = {
  generatedAt: new Date().toISOString(),
};
const reportPath = path.join(OUT, "report.json");
const fs = await import("node:fs");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.assertions, null, 2));
console.log(`report: ${reportPath}`);
