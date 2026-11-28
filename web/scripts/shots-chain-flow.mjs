// 链路详情「完整链路」复用模板拓扑画布的验收脚本（静态构建 + API mock）。
//
// 覆盖：多成员 / 单卡 / 长链 / 折叠 / 最后一跳（缺数据 / 不可测），
// failover（当前=东京-03、东京-02 离线）、lowest_latency（当前=东京-01）、
// round_robin（无首选候选、N 台分担）与旧主控缺字段回退。
//
// 前置：已执行 `cd web && npm run build`（或 `make web-build`）。脚本自己起一个
// 静态文件服务器，不依赖 master / 数据库；所有接口用 Playwright route 注入。
//
// 用法 / Usage:
//   node web/scripts/shots-chain-flow.mjs                 # 链路断言 + 截图
//   TEMPLATE_ONLY=1 SHOT_PREFIX=before- \
//     DIST_DIR=web/.dist-before node web/scripts/shots-chain-flow.mjs
//   TEMPLATE_ONLY=1 SHOT_PREFIX=after- COMPARE_TEMPLATE=1 \
//     node web/scripts/shots-chain-flow.mjs
//
// 环境变量：DIST_DIR / OUT_DIR / TEMPLATE_ONLY / SHOT_PREFIX /
//           COMPARE_TEMPLATE / PLAYWRIGHT_MODULE / CHROME_PATH / HEADED
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const ROOT = path.resolve(WEB, "..");
const DIST = path.resolve(ROOT, process.env.DIST_DIR ?? path.join(WEB, "dist"));
const OUT = path.resolve(
  process.env.OUT_DIR ?? path.join(WEB, "screenshots", "chain-flow"),
);
const SHOT_PREFIX = process.env.SHOT_PREFIX ?? "";
const TEMPLATE_ONLY = process.env.TEMPLATE_ONLY === "1";
const COMPARE_TEMPLATE = process.env.COMPARE_TEMPLATE === "1";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HEADLESS = process.env.HEADED !== "1";
const WIDTHS = [1440, 390];
mkdirSync(OUT, { recursive: true });

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

/* ------------------------------------------------------------------ */
/* 静态服务器                                                          */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    let file = path.resolve(DIST, relative);
    if (!file.startsWith(DIST)) throw new Error("path escape");
    let info = await stat(file).catch(() => null);
    if (info === null || info.isDirectory()) {
      file = path.join(DIST, "index.html");
      info = await stat(file);
    }
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------------ */
/* 链路 fixture（六条）                                                */
/* ------------------------------------------------------------------ */

const NOW = Math.floor(Date.now() / 1000);

function members(prefix, count, status = "online") {
  return Array.from({ length: count }, (_, index) => ({
    server_id: `${prefix}-${index + 1}`,
    name: `${prefix}-0${index + 1}`,
    status,
  }));
}

function chainNode(
  seq,
  name,
  role,
  list,
  {
    serverId = null,
    status = "online",
    strategy,
    activeServerId,
  } = {},
) {
  return {
    seq,
    name,
    role,
    status,
    server_id: serverId ?? (list[0]?.server_id ?? null),
    member_count: list.length,
    members: list,
    // 旧契约 fixture 不传这两个字段：归一化后必须回退到首选 / 候选。
    ...(strategy === undefined ? {} : { strategy }),
    ...(activeServerId === undefined ? {} : { active_server_id: activeServerId }),
  };
}

function chainSegment(seq, from, to, p50, lossPct = 0.1) {
  return {
    seq,
    from,
    to,
    p50,
    delta_ms: 1,
    contribution_pct: 100 / 6,
    loss_pct: lossPct,
    attempts: 100,
    failures: Math.round(lossPct),
    series: [],
  };
}

function chainFixture({
  id,
  name,
  nodes,
  segments,
  estimated = false,
  lastHop = { measurable: true, reason: null },
  status = { kind: "ok", cause: null, node: null },
}) {
  return {
    id,
    name,
    hops: nodes.length - 1,
    status,
    last_hop: lastHop,
    nodes,
    missing_hops: [],
    estimated,
    series: [],
    segments,
    diagnosis: { kind: "overall", seq: null },
    loss_pct: 0.4,
    loss_partial: false,
    loss_samples: { attempts: 100, failures: 0 },
  };
}

/** multi：5 列 / 4 段，两列各 2 台 → 2 首选 + 2 候选，4 条 hot 线 4 个药丸。 */
function fixtureMulti() {
  const source = members("香港", 2);
  const hop1 = members("东京", 2);
  const hop2 = members("大阪", 1);
  const hop3 = members("洛杉矶", 1);
  return chainFixture({
    id: "chain-multi",
    name: "香港 → 东京 → 大阪 → 洛杉矶",
    estimated: true,
    nodes: [
      chainNode(0, "香港入口", "source", source, { serverId: source[0].server_id }),
      chainNode(1, "东京中转", "hop", hop1, { serverId: hop1[0].server_id }),
      chainNode(2, "大阪中转", "hop", hop2),
      chainNode(3, "洛杉矶中转", "hop", hop3),
      { seq: 4, name: "链目标", role: "target", status: null },
    ],
    segments: [
      chainSegment(1, "香港-01", "东京-01", 14.2, 0.2),
      chainSegment(2, "东京-01", "大阪-01", 30.5, 0.4),
      chainSegment(3, "大阪-01", "洛杉矶-01", 86.1, 0),
      chainSegment(4, "洛杉矶-01", "10.0.0.8", 120.4, 0),
    ],
  });
}

/** single：3 列 / 2 段，每列单卡 → 内容小，100% 全亮且没有首选 / 候选标签。 */
function fixtureSingle() {
  return chainFixture({
    id: "chain-single",
    name: "香港 → 东京",
    nodes: [
      chainNode(0, "香港入口", "source", members("香港", 1)),
      chainNode(1, "东京中转", "hop", members("东京", 1)),
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
    segments: [
      chainSegment(1, "香港-01", "东京-01", 18.6, 0.1),
      chainSegment(2, "东京-01", "10.0.0.8", 42.3, 0),
    ],
  });
}

/** long：7 列 / 6 段 → fit 被 0.9 下限截住，右侧出现平移提示。 */
function fixtureLong() {
  const names = ["香港", "东京", "大阪", "新加坡", "法兰克福", "洛杉矶"];
  const nodes = names.map((item, index) => {
    const list = members(item, 1);
    return chainNode(
      index,
      index === 0 ? `${item}入口` : `${item}中转`,
      index === 0 ? "source" : "hop",
      list,
    );
  });
  nodes.push({ seq: names.length, name: "链目标", role: "target", status: null });
  const segments = names.map((item, index) =>
    chainSegment(
      index + 1,
      index === 0 ? "香港-01" : `${item}-01`,
      index === names.length - 1 ? "10.0.0.8" : `${names[index + 1]}-01`,
      20 + index * 12,
      0.1,
    ),
  );
  return chainFixture({ id: "chain-long", name: "六跳长链路", nodes, segments });
}

/** unmeasurable：最后一跳 engine_unsupported，虚线 + — + 不可测量说明。 */
function fixtureUnmeasurable() {
  return chainFixture({
    id: "chain-unmeasurable",
    name: "不可测量的最后一跳",
    lastHop: { measurable: false, reason: "engine_unsupported" },
    nodes: [
      chainNode(0, "香港入口", "source", members("香港", 1)),
      chainNode(1, "东京中转", "hop", members("东京", 1)),
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
    segments: [
      chainSegment(1, "香港-01", "东京-01", 18.6, 0.1),
      { seq: 2, from: "东京-01", to: "10.0.0.8", p50: null, loss_pct: null },
    ],
  });
}

/** missing：最后一跳只是没有历史数据，文案不能说成「不可测量」。 */
function fixtureMissing() {
  return chainFixture({
    id: "chain-missing",
    name: "最后一跳无历史数据",
    nodes: [
      chainNode(0, "香港入口", "source", members("香港", 1)),
      chainNode(1, "东京中转", "hop", members("东京", 1)),
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
    segments: [
      chainSegment(1, "香港-01", "东京-01", 18.6, 0.1),
      { seq: 2, from: "东京-01", to: "10.0.0.8", p50: null, loss_pct: null },
    ],
  });
}

/** folded：入口 6 台 → 4 + 1 张折叠卡，列头 4 / 6 台，展开后恢复默认。 */
function fixtureFolded() {
  const source = members("香港", 6);
  return chainFixture({
    id: "chain-folded",
    name: "六台入口的折叠",
    nodes: [
      chainNode(0, "香港入口", "source", source, { serverId: source[0].server_id }),
      chainNode(1, "东京中转", "hop", members("东京", 1)),
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
    segments: [
      chainSegment(1, "香港-01", "东京-01", 18.6, 0.1),
      chainSegment(2, "东京-01", "10.0.0.8", 42.3, 0),
    ],
  });
}

/**
 * failover：当前通路 = 东京-03；东京-02 离线（主备组里非代表成员离线）。
 * 列头显示 `故障转移·2选1`，东京-03 是「当前」，东京-02 是「候选」。
 * 多成员组只掉一台 → `degraded`（链路仍可用），不是 `blocked`。
 */
function fixtureFailover() {
  const entry = members("香港", 1);
  const hop = [
    { server_id: "s-tk2", name: "东京-02", status: "offline" },
    { server_id: "s-tk3", name: "东京-03", status: "online" },
  ];
  const exit = members("新加坡", 1);
  return chainFixture({
    id: "chain-failover",
    name: "香港 → 东京（主备）→ 新加坡",
    status: {
      kind: "degraded",
      cause: "node_offline",
      node: { seq: 1, name: "东京-02", member_name: "东京-02" },
    },
    nodes: [
      chainNode(0, "香港入口", "source", entry),
      chainNode(1, "东京中转（主备）", "hop", hop, {
        serverId: "s-tk2",
        status: "offline",
        strategy: "failover",
        activeServerId: "s-tk3",
      }),
      chainNode(2, "新加坡出口", "hop", exit, {
        strategy: "failover",
        activeServerId: "新加坡-1",
      }),
      { seq: 3, name: "链目标", role: "target", status: null },
    ],
    segments: [
      chainSegment(1, "香港-01", "东京-03", 22.4, 0.2),
      chainSegment(2, "东京-03", "新加坡-01", 21.1, 0.1),
      chainSegment(3, "新加坡-01", "10.0.0.8", 9.2, 0),
    ],
  });
}

/**
 * lowest_latency：三台全在线，当前通路 = 东京-01。
 * 列头显示 `最低延迟·3选1`，东京-01 是「当前」，另两台「候选」。
 */
function fixtureLowestLatency() {
  const entry = members("香港", 1);
  const hop = [
    { server_id: "s-tk1", name: "东京-01", status: "online" },
    { server_id: "s-tk3", name: "东京-03", status: "online" },
    { server_id: "s-se1", name: "首尔-01", status: "online" },
  ];
  return chainFixture({
    id: "chain-lowest",
    name: "香港 → 东京（最低延迟）",
    nodes: [
      chainNode(0, "香港入口", "source", entry),
      chainNode(1, "东京出口", "hop", hop, {
        strategy: "lowest_latency",
        activeServerId: "s-tk1",
      }),
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
    segments: [
      chainSegment(1, "香港-02", "东京-01", 13.1, 0.1),
      chainSegment(2, "东京-01", "10.0.0.8", 10.2, 0),
    ],
  });
}

/**
 * round_robin：多成员组没有首选 / 候选，列头写 `2 台分担`；
 * 单成员组不显示策略；默认高亮没有可判定的首选路径，整图不着色。
 */
function fixtureRoundRobin() {
  return chainFixture({
    id: "chain-round-robin",
    name: "新加坡 → 香港（轮询）→ 东京",
    nodes: [
      chainNode(0, "新加坡入口", "source", members("新加坡", 1)),
      chainNode(1, "香港分流", "hop", members("香港", 2), {
        strategy: "round_robin",
      }),
      chainNode(2, "大阪中转", "hop", members("大阪", 1), {
        strategy: "lowest_latency",
      }),
      chainNode(3, "东京三出口", "hop", members("东京", 1), {
        strategy: "failover",
      }),
      { seq: 4, name: "链目标", role: "target", status: null },
    ],
    segments: [
      chainSegment(1, "新加坡-01", "香港-01", 17.2, 0.1),
      chainSegment(2, "香港-01", "大阪-01", 18.4, 0.1),
      chainSegment(3, "大阪-01", "东京-01", 23.1, 0.2),
      chainSegment(4, "东京-01", "10.0.0.8", 8.3, 0),
    ],
  });
}

/**
 * 旧主控：nodes 完全没有 strategy / active_server_id，回退到首选 / 候选；
 * 列头保持旧的台数，不出现「当前 / N 台分担」。
 */
function fixtureLegacy() {
  return chainFixture({
    id: "chain-legacy",
    name: "旧主控：香港 → 东京",
    nodes: [
      chainNode(0, "香港入口", "source", members("香港", 1)),
      chainNode(1, "东京中转", "hop", members("东京", 2)),
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
    segments: [
      chainSegment(1, "香港-01", "东京-01", 18.6, 0.1),
      chainSegment(2, "东京-01", "10.0.0.8", 42.3, 0),
    ],
  });
}

const CHAINS = [
  fixtureMulti(),
  fixtureSingle(),
  fixtureLong(),
  fixtureUnmeasurable(),
  fixtureMissing(),
  fixtureFolded(),
  fixtureFailover(),
  fixtureLowestLatency(),
  fixtureRoundRobin(),
  fixtureLegacy(),
];
const CHAIN_BY_ID = new Map(CHAINS.map((item) => [item.id, item]));

/* ------------------------------------------------------------------ */
/* 模板 fixture（静止帧对比用）                                        */
/* ------------------------------------------------------------------ */

function templateMember(name, chains, users, status = "online", serverId = name) {
  return { server_id: serverId, name, status, chains, users };
}

function templateEdge(fromSeq, fromMember, toSeq, toMember, chains, p50 = 20, users = 1) {
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

function templateDetail() {
  const hopMembers = Array.from({ length: 6 }, (_, index) =>
    templateMember(`东京-0${index + 1}`, 6 - index, 2),
  );
  const nodes = [
    {
      seq: 0,
      role: "source",
      name: "香港入口",
      members: [templateMember("香港-01", 6, 4)],
    },
    { seq: 1, role: "hop", name: "东京中转", members: hopMembers },
    {
      seq: 2,
      role: "hop",
      name: "洛杉矶中转",
      members: [templateMember("洛杉矶-01", 6, 3)],
    },
    {
      seq: 3,
      role: "target",
      name: "目标",
      members: [
        templateMember("1.2.3.4:443", 3, 2),
        templateMember("5.6.7.8:8443", 3, 2),
      ],
    },
  ];
  const edges = [
    ...hopMembers.map((item, index) =>
      templateEdge(0, "香港-01", 1, item.name, 6 - index, 15 + index * 2),
    ),
    ...hopMembers.map((item, index) =>
      templateEdge(1, item.name, 2, "洛杉矶-01", 6 - index, 90 + index * 3),
    ),
    templateEdge(2, "洛杉矶-01", 3, "1.2.3.4:443", 3, 160),
    templateEdge(2, "洛杉矶-01", 3, "5.6.7.8:8443", 3, 168),
  ];
  return {
    template: {
      id: "tpl-static",
      name: "静止帧模板",
      hops: 3,
      created_at: NOW - 86400,
    },
    nodes,
    edges,
    targets: [
      { host: "1.2.3.4", port: 443, chains: 3, users: [] },
      { host: "5.6.7.8", port: 8443, chains: 3, users: [] },
    ],
    users: [],
    series: [],
    strategies: [{ strategy: "ip_hashed", chains: 6, users: 4 }],
    unused_candidates: [],
  };
}

/* ------------------------------------------------------------------ */
/* API mock                                                            */
/* ------------------------------------------------------------------ */

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mockApi(page) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/api/v1/auth/me") {
      return json(route, {
        user: { id: "u-admin", username: "admin", role: "admin", short_code: "admin" },
      });
    }
    if (p === "/api/v1/chains") return json(route, { items: [] });
    if (p === "/api/v1/servers") {
      return json(route, {
        items: [
          {
            id: "srv-1",
            name: "香港-01",
            address: "10.0.0.1",
            xray_mode: "xray",
            status: "online",
            last_seen_at: NOW,
            config_version: 1,
            created_at: NOW - 86400,
            agent_version: "0.1.0",
            allow_agent_upgrade: false,
            agent_target_version: null,
          },
        ],
      });
    }
    if (p === "/api/v1/updates" || p === "/api/v1/updates/check") {
      return json(route, {
        master: {
          current: "0.0.0",
          latest: null,
          update_available: false,
          release_url: null,
          released_at: null,
          checked_at: NOW,
          error: null,
        },
        agents: { current_protocol: 1, min_supported: 1, versions: [] },
      });
    }
    if (p === "/api/v1/stats/overview") {
      return json(route, {
        servers: { total: 1, online: 1 },
        users: { total: 0, active: 0 },
        packages: { total: 0, instances: 0 },
        traffic: { today_bytes: 0, month_bytes: 0 },
        alerts: {
          expired_instances: 0,
          exhausted_instances: 0,
          offline_servers: 0,
          expiring_certs: 0,
        },
      });
    }
    if (p === "/api/v1/stats/traffic") return json(route, { days: [] });
    if (p === "/api/v1/overview/chain-health") {
      return json(route, {
        generated_at: NOW,
        hours: 24,
        bucket: 900,
        summary: {
          hop_p50_ms: 120,
          delta_ms: 4,
          slow_chains: 0,
          total_chains: CHAINS.length,
          worst_hop: { chain_id: "chain-multi", chain_name: "multi", seq: 3, p50_ms: 120 },
          loss_pct: 0.4,
          worst_loss: null,
        },
        chains: CHAINS,
        scope: { server_ids: [], filtered: false },
        warnings: {},
      });
    }
    if (p === "/api/v1/overview/chain-templates") {
      return json(route, {
        generated_at: NOW,
        items: [
          {
            id: "tpl-static",
            name: "静止帧模板",
            hops: 3,
            chains: 6,
            users: 4,
            enabled: true,
            status: { kind: "ok", cause: null },
            strategies: [{ strategy: "ip_hashed", chains: 6, users: 4 }],
            targets: [
              { host: "1.2.3.4", port: 443, chains: 3, users: [] },
              { host: "5.6.7.8", port: 8443, chains: 3, users: [] },
            ],
          },
        ],
      });
    }
    if (p === "/api/v1/overview/chain-templates/tpl-static") {
      return json(route, templateDetail());
    }
    if (/^\/api\/v1\/chains\/[^/]+\/latency$/.test(p)) {
      return json(route, { points: [] });
    }
    if (/^\/api\/v1\/chains\/[^/]+\/availability$/.test(p)) {
      return json(route, { points: [] });
    }
    if (p === "/api/v1/overview") {
      return json(route, {
        kpi: {
          servers_online: 1,
          servers_total: 1,
          nodes: 0,
          traffic_today: 0,
          traffic_month: 0,
          uptime_24h: 0,
        },
        series: [],
        protocol_series: [],
        protocols: [],
        chains: {
          total: 0,
          degraded: 0,
          blocked: 0,
          forwards_total: 0,
          forwards_failing: 0,
          handshake_failures: 0,
        },
        top: [],
        top_users: [],
        top_nodes: [],
        package_split: [],
        scope: { server_ids: [], filtered: false },
        warnings: {},
      });
    }
    return json(route, {});
  });
}

const chromium = await loadPlaywright();
const browser = await chromium.launch({
  headless: HEADLESS,
  executablePath: CHROME,
  // 静止帧对比要求像素级可复现：固定 sRGB、关 LCD 子像素与字体 hinting，
  // 避免同一份代码两次跑出 1px 的抗锯齿差异。
  args: [
    "--force-color-profile=srgb",
    "--disable-lcd-text",
    "--font-render-hinting=none",
    "--disable-gpu",
  ],
});

const report = {
  base: BASE,
  dist: path.relative(ROOT, DIST),
  mode: TEMPLATE_ONLY ? "template" : "chain",
  screenshots: [],
  assertions: {},
  templateDiff: null,
  errors: [],
};

async function newPage({
  width = 1440,
  height = 900,
  theme = "dark",
  locale = "zh-CN",
  reducedMotion = false,
} = {}) {
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
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await mockApi(page);
  return { context, page, errors };
}

async function shot(locator, file, page, options = {}) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate(() => window.getSelection()?.removeAllRanges());
  await locator.screenshot({ path: path.join(OUT, `${SHOT_PREFIX}${file}`), ...options });
  report.screenshots.push(`${SHOT_PREFIX}${file}`);
  void page;
}

/** 停掉动画 / 过渡，保证前后两次静止帧是同一帧（pulse 也不闪）。 */
async function freezeMotion(page) {
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }",
  });
  await page.waitForTimeout(200);
}

/* ------------------------------------------------------------------ */
/* 模板画布静止帧                                                      */
/* ------------------------------------------------------------------ */

async function openTemplateCanvas(page, theme) {
  await page.goto(`${BASE}/?view=chain&section=templates`, {
    waitUntil: "networkidle",
  });
  await page.locator("[data-chain-template-insight]").waitFor();
  await page.locator("[data-chain-template-row]").first().click();
  await page.locator("[data-template-detail]").waitFor();
  const canvas = page.locator("[data-template-topology]");
  await canvas.waitFor();
  await page
    .locator("[data-template-flow-edge]")
    .first()
    .waitFor({ state: "attached", timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await freezeMotion(page);
  await page.waitForTimeout(300);
  void theme;
  return canvas;
}

async function captureTemplateFrames() {
  for (const theme of ["dark", "light"]) {
    const { context, page, errors } = await newPage({ theme });
    try {
      const canvas = await openTemplateCanvas(page, theme);
      await shot(canvas, `template-collapsed-1440-${theme}.png`, page);
      const fold = page.locator('[data-card-id^="fold:"]').first();
      await fold.click();
      await page.waitForTimeout(450);
      await page.evaluate(() => document.fonts.ready);
      await freezeMotion(page);
      await shot(canvas, `template-expanded-1440-${theme}.png`, page);
    } finally {
      if (errors.length > 0) {
        report.errors.push(...errors.map((item) => `template:${theme}: ${item}`));
      }
      await context.close();
    }
  }
}

/* ------------------------------------------------------------------ */
/* 链路详情                                                            */
/* ------------------------------------------------------------------ */

async function openChain(page, id, { theme = "dark" } = {}) {
  await page.goto(`${BASE}/?view=chain&chain=${id}`, {
    waitUntil: "networkidle",
  });
  await page.locator("[data-chain-flow]").waitFor();
  const host = page.locator("[data-chain-flow] [data-template-flow]");
  await host.waitFor();
  await page
    .locator("[data-chain-flow] [data-template-flow-edge]")
    .first()
    .waitFor({ state: "attached", timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  void theme;
  return host;
}

async function zoomPercent(page) {
  const text =
    (await page.locator("[data-chain-flow] [data-flow-zoom-value]").textContent()) ??
    "";
  return Number(text.replace("%", "").trim());
}

async function chainSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector("[data-chain-flow]");
    if (root === null) return null;
    const all = (selector) => [...root.querySelectorAll(selector)];
    const text = (element) => (element?.textContent ?? "").trim();
    return {
      kind: root
        .querySelector("[data-template-flow]")
        ?.getAttribute("data-template-flow-kind"),
      zoom: text(root.querySelector("[data-flow-zoom-value]")),
      cards: all("[data-template-flow-card]").length,
      hotCards: all('[data-template-flow-card][data-hot="true"]').length,
      dimCards: all('[data-template-flow-card][data-hot="false"]').length,
      edges: all("[data-template-flow-edge-group]").length,
      hotEdges: all('[data-template-flow-edge-group][data-hot="true"]').length,
      hotEdgeIds: all('[data-template-flow-edge-group][data-hot="true"]').flatMap((group) =>
        [...group.querySelectorAll("[data-template-flow-edge]")].map((edge) =>
          edge.getAttribute("data-edge-id"),
        ),
      ),
      dimEdges: all('[data-template-flow-edge-group][data-hot="false"]').length,
      pills: all("[data-template-flow-pill]").length,
      visiblePills: all('[data-template-flow-pill][data-pill-hidden="false"]').length,
      hiddenPills: all('[data-template-flow-pill][data-pill-hidden="true"]').length,
      preferred: all('[data-template-flow-card][data-chain-tag="preferred"]').length,
      candidate: all('[data-template-flow-card][data-chain-tag="candidate"]').length,
      active: all('[data-template-flow-card][data-chain-tag="active"]').length,
      tagRows: all("[data-template-flow-card]").map((card) => ({
        name: text(card.querySelector("[data-template-flow-card-title]")),
        tag: card.getAttribute("data-chain-tag"),
        tagText: card.getAttribute("data-chain-tag-text"),
        status: card.getAttribute("data-status"),
        hot: card.getAttribute("data-hot"),
        offlineDot: (() => {
          const dot = card.querySelector("[data-template-flow-status-dot]");
          return dot === null ? false : dot.className.includes("bg-destructive");
        })(),
      })),
      hotCardNames: all('[data-template-flow-card][data-hot="true"]').map((card) =>
        text(card.querySelector("[data-template-flow-card-title]")),
      ),
      targets: all("[data-flow-target]").length,
      targetDots: all('[data-flow-target] [data-template-flow-status-dot]').length,
      unknownDots: all(
        '[data-template-flow-card][data-status="unknown"] [data-template-flow-status-dot]',
      ).length,
      headers: all("[data-template-flow-column-header]").map((header) => ({
        role: header.getAttribute("data-role"),
        label: text(header.querySelector("[data-template-flow-column-label]")),
        count: text(header.querySelector("[data-template-flow-column-count]")),
        strategy: header.getAttribute("data-strategy"),
        shown: header.getAttribute("data-shown"),
        total: header.getAttribute("data-total"),
      })),
      pillTexts: all('[data-template-flow-pill][data-pill-hidden="false"]').map(text),
      // 画布缩放会缩 screen 宽度；这里量的是 CSS 盒宽（56 / 44）。
      pillWidths: all('[data-template-flow-pill][data-pill-hidden="false"]').map(
        (pill) => Number.parseFloat(getComputedStyle(pill).width),
      ),
      pulses: all("[data-template-flow-pulse]").length,
      marches: all("[data-template-flow-march]").length,
      marchIds: all("[data-template-flow-march]").map((item) =>
        item.getAttribute("data-edge-id"),
      ),
      marchAnimation: (() => {
        const march = root.querySelector("[data-template-flow-march]");
        if (march === null) return null;
        const style = getComputedStyle(march);
        return {
          name: style.animationName,
          duration: style.animationDuration,
          iteration: style.animationIterationCount,
        };
      })(),
      unavailableEdges: all('[data-template-flow-edge][data-unavailable="true"]').length,
      dashedEdges: all('[data-template-flow-edge][data-dashed="true"]').length,
      visiblePillValues: all('[data-template-flow-pill][data-pill-hidden="false"]').map(
        text,
      ),
      headerTitles: all("[data-template-flow-column-header]").map((header) => ({
        label: text(header.querySelector("[data-template-flow-column-label]")),
        count: text(header.querySelector("[data-template-flow-column-count]")),
      })),
      reset: root.querySelector("[data-chain-flow-reset]") !== null,
      rightHint: text(root.querySelector("[data-template-flow-more]")),
      rightHintColumns: Number(
        root.querySelector("[data-template-flow-more]")?.getAttribute("data-columns") ?? 0,
      ),
      hostMode: root
        .querySelector("[data-template-flow]")
        ?.getAttribute("data-template-flow-mode"),
      hostScroll: (() => {
        const host = root.querySelector("[data-template-flow]");
        return host === null
          ? null
          : { clientWidth: host.clientWidth, scrollWidth: host.scrollWidth };
      })(),
      pageOverflow:
        document.documentElement.scrollWidth - window.innerWidth,
      bodyOverflow: document.body.scrollWidth - window.innerWidth,
      viewportTransform:
        getComputedStyle(root.querySelector(".react-flow__viewport")).transform,
      selectedPillTabIndex: (() => {
        const pill = root.querySelector(
          '[data-template-flow-pill][data-pill-hidden="false"]',
        );
        return pill === null ? null : pill.getAttribute("tabindex");
      })(),
      tabbableCards: all("[data-template-flow-card]").filter(
        (card) => card.getAttribute("tabindex") === "0",
      ).length,
      cardWidths: all("[data-template-flow-card]").map(
        (card) => card.getBoundingClientRect().width,
      ),
    };
  });
}

/**
 * 药丸 tooltip 的 hover 重试：Dialog 首次打开后，Radix 可能吞掉第一次
 * hover（指针事件在焦点陷阱接管前就发生）。真实用户会再移一次；验收脚本
 * 也重试，而不是把一次时序抖动当成功能失败。
 */
async function hoverForTooltip(page, locator, selector) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await locator.hover();
    await page.waitForTimeout(500);
    if ((await page.locator(selector).count()) > 0) return true;
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
  }
  return false;
}

async function captureChainFrame(page, id, file, theme = "dark") {
  const host = await openChain(page, id, { theme });
  const card = page.locator("[data-chain-flow]");
  await shot(card, file, page);
  return { host, snapshot: await chainSnapshot(page) };
}

/* ------------------------------------------------------------------ */
/* 静态帧比较（before / after 两个构建）                               */
/* ------------------------------------------------------------------ */

async function pixelDiff(page, imageA, imageB) {
  const a = `data:image/png;base64,${imageA.toString("base64")}`;
  const b = `data:image/png;base64,${imageB.toString("base64")}`;
  return page.evaluate(async ({ a, b }) => {
    const load = (src) =>
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
      });
    const [left, right] = await Promise.all([load(a), load(b)]);
    if (left.width !== right.width || left.height !== right.height) {
      return {
        different: true,
        reason: "size",
        width: [left.width, right.width],
        height: [left.height, right.height],
      };
    }
    const canvas = document.createElement("canvas");
    canvas.width = left.width;
    canvas.height = left.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(left, 0, 0);
    const first = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(right, 0, 0);
    const second = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let diff = 0;
    for (let index = 0; index < first.length; index += 4) {
      if (
        first[index] !== second[index] ||
        first[index + 1] !== second[index + 1] ||
        first[index + 2] !== second[index + 2] ||
        first[index + 3] !== second[index + 3]
      ) {
        diff += 1;
      }
    }
    return {
      different: diff > 0,
      diffPixels: diff,
      totalPixels: first.length / 4,
      width: left.width,
      height: left.height,
    };
  }, { a, b });
}

async function compareTemplateFrames() {
  const { context, page } = await newPage();
  try {
    const files = ["template-collapsed-1440-dark.png", "template-expanded-1440-dark.png", "template-collapsed-1440-light.png", "template-expanded-1440-light.png"];
    const rows = [];
    for (const file of files) {
      const beforeFile = path.join(OUT, `before-${file}`);
      const afterFile = path.join(OUT, `after-${file}`);
      if (!existsSync(beforeFile) || !existsSync(afterFile)) {
        rows.push({ file, error: "missing before/after screenshot" });
        continue;
      }
      const before = readFileSync(beforeFile);
      const after = readFileSync(afterFile);
      if (before.equals(after)) {
        rows.push({ file, diffPixels: 0, identicalBytes: true });
        continue;
      }
      const diff = await pixelDiff(page, before, after);
      rows.push({ file, ...diff, identicalBytes: false });
    }
    report.templateDiff = rows;
    for (const row of rows) {
      if (row.error) report.errors.push(`templateDiff: ${row.error}`);
      else if (row.diffPixels !== 0) {
        report.errors.push(
          `templateDiff: ${row.file} 差异 ${row.diffPixels}px（${JSON.stringify(row)}）`,
        );
      }
    }
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

try {
  if (TEMPLATE_ONLY) {
    await captureTemplateFrames();
    if (COMPARE_TEMPLATE) await compareTemplateFrames();
  } else {
    /* ---------------- multi ---------------- */
    {
      const { context, page, errors } = await newPage();
      try {
        const { snapshot } = await captureChainFrame(
          page,
          "chain-multi",
          "chain-multi-1440-dark.png",
        );
        report.assertions.multi = snapshot;
        assert.equal(snapshot.kind, "chain");
        const zoom = Number(snapshot.zoom.replace("%", ""));
        assert.ok(zoom >= 93, `multi fit zoom ${zoom}% 应 ≥ 93%`);
        assert.equal(snapshot.visiblePills, 4, "4 个可见药丸");
        assert.equal(snapshot.hotEdges, 4, "4 条 hot 连线");
        assert.equal(snapshot.preferred, 2, "2 张首选卡");
        assert.equal(snapshot.candidate, 2, "2 张候选卡");
        assert.equal(snapshot.targets, 1);
        assert.equal(snapshot.targetDots, 0, "目标卡不画点");
        assert.equal(snapshot.unknownDots, 0, "未知不画点");
        // 只有两端有多成员组的段才标 ≈：前两段估算，后两段是单机段。
        assert.deepEqual(snapshot.pillTexts.slice(0, 2).map((item) => item.startsWith("≈")), [true, true]);
        assert.deepEqual(snapshot.pillTexts.slice(2).map((item) => item.startsWith("≈")), [false, false]);
        assert.ok(snapshot.pillWidths.every((width) => Math.abs(width - 56) <= 1));
        assert.deepEqual(
          snapshot.headers.map((header) => header.label),
          ["香港入口", "东京中转", "大阪中转", "洛杉矶中转", "目标"],
        );
        assert.deepEqual(
          snapshot.headers.map((header) => header.count),
          ["2 台", "2 台", "1 台", "1 台", "1 个"],
        );
        assert.equal(snapshot.pulses, 0, "链路无 pulse");
        assert.equal(snapshot.marches, 4, "点亮路径带 4 条 march");
        assert.equal(snapshot.marchAnimation.duration, "1s");
        assert.equal(snapshot.marchAnimation.iteration, "infinite");
        assert.ok(
          snapshot.marchIds.every(
            (id) => id !== null && snapshot.hotEdgeIds.includes(id),
          ),
          "march 只出现在点亮连线",
        );
        report.assertions.march = {
          count: snapshot.marches,
          animation: snapshot.marchAnimation,
          onlyHot: true,
        };

        // 悬停候选卡：候选卡变亮，首选卡不再 hot。
        const candidate = page
          .locator('[data-template-flow-card][data-chain-tag="candidate"]')
          .first();
        await candidate.hover();
        await page.waitForTimeout(250);
        const candidateHot = await candidate.getAttribute("data-hot");
        const hotAfterHover = await page
          .locator('[data-template-flow-card][data-hot="true"]')
          .count();
        assert.equal(candidateHot, "true", "悬停候选卡应点亮");
        assert.equal(hotAfterHover, 1, "候选卡高亮时只剩它自己");
        report.assertions.multiHover = { candidateHot, hotAfterHover };
        await page.mouse.move(2, 2);
        // 卡片 tooltip 尚未完全关闭时立刻切到药丸，Radix 可能吞掉这次开启；
        // 先等关闭动画结束，模拟真实用户「先看卡片、再移到药丸」的停顿。
        await page.waitForTimeout(600);

        // tooltip：时延 / 丢包 / 估算。
        const pill = page
          .locator('[data-chain-flow] [data-template-flow-pill][data-pill-hidden="false"]')
          .first();
        assert.ok(
          await hoverForTooltip(page, pill, "[data-chain-flow-edge-tooltip]"),
          "药丸 tooltip 可见",
        );
        const tooltip = page.locator("[data-chain-flow-edge-tooltip]").first();
        const tooltipText = (await tooltip.textContent()) ?? "";
        assert.ok(tooltipText.includes("丢包"), "tooltip 含丢包");
        assert.ok(tooltipText.includes("多路径估算"), "tooltip 含估算说明");
        await shot(page.locator("[data-chain-flow]"), "chain-multi-tooltip-1440-dark.png", page);

        // 键盘：可见药丸 tabIndex=0，Tab 能走到卡片 / 药丸。
        assert.equal(snapshot.selectedPillTabIndex, "0");
        assert.ok(snapshot.tabbableCards > 0);
        await page.mouse.move(2, 2);
        let keyboardHit = false;
        for (let index = 0; index < 40; index += 1) {
          await page.keyboard.press("Tab");
          keyboardHit = await page.evaluate(() => {
            const active = document.activeElement;
            if (!(active instanceof HTMLElement)) return false;
            return (
              active.matches("[data-template-flow-pill]") ||
              active.matches("[data-template-flow-card]")
            );
          });
          if (keyboardHit) break;
        }
        assert.equal(keyboardHit, true, "Tab 应能到达卡片 / 药丸");
        report.assertions.multiKeyboard = { keyboardHit };
      } finally {
        if (errors.length > 0) report.errors.push(...errors.map((item) => `multi: ${item}`));
        await context.close();
      }
    }

    /* ---------------- 亮色 + 390 ---------------- */
    {
      const { context, page, errors } = await newPage({ theme: "light" });
      try {
        await captureChainFrame(page, "chain-multi", "chain-multi-1440-light.png", "light");
      } finally {
        if (errors.length > 0) report.errors.push(...errors.map((item) => `multi-light: ${item}`));
        await context.close();
      }
    }
    {
      const { context, page, errors } = await newPage({ width: 390, height: 844 });
      try {
        const host = await openChain(page, "chain-multi");
        const snapshot = await chainSnapshot(page);
        report.assertions.mobile = snapshot;
        assert.equal(snapshot.hostMode, "compact");
        assert.ok(
          snapshot.hostScroll.scrollWidth > snapshot.hostScroll.clientWidth,
          "390 下画布应可横向滚动",
        );
        await page.screenshot({
          path: path.join(OUT, `${SHOT_PREFIX}chain-multi-390-dark.png`),
        });
        report.screenshots.push(`${SHOT_PREFIX}chain-multi-390-dark.png`);
        void host;
      } finally {
        if (errors.length > 0) report.errors.push(...errors.map((item) => `multi-390: ${item}`));
        await context.close();
      }
    }

    /* ---------------- single ---------------- */
    {
      const { context, page, errors } = await newPage();
      try {
        const { snapshot } = await captureChainFrame(
          page,
          "chain-single",
          "chain-single-1440-dark.png",
        );
        report.assertions.single = snapshot;
        assert.equal(snapshot.zoom, "100%");
        assert.equal(snapshot.preferred + snapshot.candidate, 0, "单卡列无标签");
        assert.equal(snapshot.hotCards, snapshot.cards, "全部卡片点亮");
        assert.equal(snapshot.hotEdges, snapshot.edges, "全部连线点亮");
        assert.equal(snapshot.dimCards, 0);
        assert.equal(snapshot.dimEdges, 0);
        assert.equal(snapshot.marches, snapshot.hotEdges);
        assert.ok(snapshot.pillTexts.every((item) => !item.startsWith("≈")));
      } finally {
        if (errors.length > 0) report.errors.push(...errors.map((item) => `single: ${item}`));
        await context.close();
      }
    }

    /* ---------------- long ---------------- */
    {
      const { context, page, errors } = await newPage();
      try {
        const { snapshot } = await captureChainFrame(
          page,
          "chain-long",
          "chain-long-1440-dark.png",
        );
        report.assertions.long = snapshot;
        assert.equal(snapshot.zoom, "90%");
        assert.ok(snapshot.rightHintColumns > 0, "右侧还有列");
        const beforeTransform = snapshot.viewportTransform;
        await page.locator("[data-chain-flow] [data-template-flow-more]").click();
        await page.waitForTimeout(350);
        const after = await chainSnapshot(page);
        assert.notEqual(after.viewportTransform, beforeTransform, "右侧提示应平移画布");
        report.assertions.longPan = {
          before: snapshot.rightHintColumns,
          after: after.rightHintColumns,
        };
      } finally {
        if (errors.length > 0) report.errors.push(...errors.map((item) => `long: ${item}`));
        await context.close();
      }
    }

    /* ---------------- folded ---------------- */
    {
      const { context, page, errors } = await newPage();
      try {
        const { snapshot: collapsed } = await captureChainFrame(
          page,
          "chain-folded",
          "chain-folded-1440-dark.png",
        );
        report.assertions.folded = collapsed;
        assert.equal(collapsed.headers[0].shown, "4");
        assert.equal(collapsed.headers[0].total, "6");
        assert.equal(collapsed.headers[0].count, "4 / 6 台");
        const sourceCards = page.locator(
          '[data-chain-flow] [data-template-flow-card][data-column="0"]',
        );
        assert.equal(await sourceCards.count(), 5, "折叠后 4 + 1 张卡");
        await page.locator('[data-chain-flow] [data-card-id^="fold:"]').click();
        await page.waitForTimeout(450);
        const expanded = await chainSnapshot(page);
        assert.equal(expanded.headers[0].shown, "6");
        assert.equal(expanded.headers[0].count, "6 台");
        assert.equal(
          await page
            .locator('[data-chain-flow] [data-template-flow-card][data-column="0"]')
            .count(),
          6,
        );
        assert.equal(expanded.reset, true, "展开后出现「恢复默认」");
        await shot(
          page.locator("[data-chain-flow]"),
          "chain-folded-expanded-1440-dark.png",
          page,
        );
        await page.locator("[data-chain-flow] [data-chain-flow-reset]").click();
        await page.waitForTimeout(350);
        const restored = await chainSnapshot(page);
        assert.equal(restored.headers[0].count, "4 / 6 台");
        assert.equal(restored.reset, false);
        report.assertions.foldedExpand = {
          shown: expanded.headers[0].shown,
          count: expanded.headers[0].count,
          restored: restored.headers[0].count,
        };
      } finally {
        if (errors.length > 0) report.errors.push(...errors.map((item) => `folded: ${item}`));
        await context.close();
      }
    }

    /* ---------------- unmeasurable / missing ---------------- */
    for (const [id, expected, file] of [
      ["chain-unmeasurable", "不可测量", "chain-unmeasurable-1440-dark.png"],
      ["chain-missing", "无历史数据", "chain-missing-1440-dark.png"],
    ]) {
      const { context, page, errors } = await newPage();
      try {
        const { snapshot } = await captureChainFrame(page, id, file);
        report.assertions[id] = snapshot;
        assert.ok(snapshot.unavailableEdges >= 1, "最后一段不可用");
        assert.ok(snapshot.dashedEdges >= 1, "最后一段虚线");
        assert.ok(snapshot.visiblePillValues.includes("—"), "药丸显示 —");
        const lastPill = page
          .locator('[data-chain-flow] [data-template-flow-pill][data-pill-hidden="false"]')
          .last();
        assert.ok(
          await hoverForTooltip(page, lastPill, "[data-chain-flow-edge-tooltip]"),
          "最后一段 tooltip 可见",
        );
        const tooltip = page.locator("[data-chain-flow-edge-tooltip]").first();
        const text = (await tooltip.textContent()) ?? "";
        assert.ok(text.includes(expected), `tooltip 应包含 ${expected}，实际：${text}`);
        report.assertions[`${id}Tooltip`] = text;
        // 不可测 / 缺数据的边不 march。
        assert.equal(snapshot.marchIds.length, snapshot.hotEdges - 1);
      } finally {
        if (errors.length > 0) report.errors.push(...errors.map((item) => `${id}: ${item}`));
        await context.close();
      }
    }

    /* ---------------- 当前通路 / 分担策略 ---------------- */
    const SCENARIOS = [
      {
        id: "chain-failover",
        key: "failover",
        headerCount: "故障转移·2选1",
        strategy: "failover",
        active: 1,
        preferred: 0,
        candidate: 1,
        hot: ["香港-01", "东京-03", "新加坡-01", "链目标"],
        activeName: "东京-03",
        candidateName: "东京-02",
        offlineName: "东京-02",
      },
      {
        id: "chain-lowest",
        key: "lowest",
        headerCount: "最低延迟·3选1",
        strategy: "lowest_latency",
        active: 1,
        preferred: 0,
        candidate: 2,
        hot: ["香港-01", "东京-01", "链目标"],
        activeName: "东京-01",
        candidateName: "东京-03",
        offlineName: null,
      },
      {
        id: "chain-round-robin",
        key: "round-robin",
        headerCount: "2 台分担",
        strategy: "round_robin",
        active: 0,
        preferred: 0,
        candidate: 0,
        hot: [],
        activeName: null,
        candidateName: null,
        offlineName: null,
      },
      {
        id: "chain-legacy",
        key: "legacy",
        headerCount: "2 台",
        strategy: null,
        active: 0,
        preferred: 1,
        candidate: 1,
        hot: ["香港-01", "东京-01", "链目标"],
        activeName: null,
        candidateName: "东京-02",
        offlineName: null,
      },
    ];

    for (const scenario of SCENARIOS) {
      for (const theme of ["dark", "light"]) {
        for (const width of WIDTHS) {
          const { context, page, errors } = await newPage({
            width,
            height: width === 390 ? 844 : 1000,
            theme,
          });
          const label = `${scenario.key}/${theme}/${width}`;
          try {
            await openChain(page, scenario.id, { theme });
            const snapshot = await chainSnapshot(page);
            report.assertions[`${scenario.key}-${theme}-${width}`] = snapshot;

            assert.equal(snapshot.pageOverflow, 0, `${label}: page overflow`);
            assert.equal(snapshot.bodyOverflow, 0, `${label}: body overflow`);
            assert.equal(snapshot.active, scenario.active, `${label}: active tags`);
            assert.equal(snapshot.preferred, scenario.preferred, `${label}: preferred`);
            assert.equal(snapshot.candidate, scenario.candidate, `${label}: candidates`);
            assert.deepEqual(
              [...snapshot.hotCardNames].sort(),
              [...scenario.hot].sort(),
              `${label}: default highlight`,
            );
            const activeRow = snapshot.tagRows.find((row) => row.name === scenario.activeName);
            if (scenario.activeName !== null) {
              assert.ok(activeRow, `${label}: active card present`);
              assert.equal(activeRow.tag, "active", `${label}: active tag`);
              assert.equal(activeRow.tagText, "当前", `${label}: 当前 copy`);
              assert.equal(activeRow.hot, "true", `${label}: active is hot`);
            }
            const candidateRow = snapshot.tagRows.find(
              (row) => row.name === scenario.candidateName,
            );
            if (scenario.candidateName !== null) {
              assert.ok(candidateRow, `${label}: candidate card present`);
              assert.equal(candidateRow.tag, "candidate", `${label}: candidate tag`);
              assert.equal(candidateRow.tagText, "候选", `${label}: 候选 copy`);
            }
            if (scenario.offlineName !== null) {
              const offline = snapshot.tagRows.find(
                (row) => row.name === scenario.offlineName,
              );
              assert.ok(offline, `${label}: offline card present`);
              assert.equal(offline.status, "offline", `${label}: offline status`);
              assert.equal(offline.offlineDot, true, `${label}: offline red dot`);
            }
            const hopHeader = snapshot.headers[1];
            assert.equal(hopHeader.count, scenario.headerCount, `${label}: header copy`);
            if (scenario.strategy === null) {
              assert.equal(hopHeader.strategy, null, `${label}: old contract header`);
            } else {
              assert.equal(
                hopHeader.strategy,
                scenario.strategy,
                `${label}: header strategy`,
              );
            }
            // 入口列不出现「当前」；轮询等分担只作用于中继列。
            assert.equal(snapshot.headers[0].strategy, null, `${label}: entry strategy`);
            if (width === 390) {
              assert.equal(snapshot.hostMode, "compact", `${label}: compact`);
              assert.ok(
                snapshot.hostScroll.scrollWidth > snapshot.hostScroll.clientWidth,
                `${label}: compact canvas scrolls`,
              );
              // 390 画布可横向滚动：把策略列滚到可视区，截图才看得到完整列头。
              await page.evaluate(() => {
                const host = document.querySelector(
                  "[data-chain-flow] [data-template-flow]",
                );
                const header = host?.querySelectorAll(
                  "[data-template-flow-column-header]",
                )[1];
                if (host === null || header === undefined || header === null) return;
                const hostRect = host.getBoundingClientRect();
                const headerRect = header.getBoundingClientRect();
                host.scrollLeft += headerRect.left - hostRect.left - 12;
              });
              await page.waitForTimeout(150);
              await page.screenshot({
                path: path.join(OUT, `${SHOT_PREFIX}active-${scenario.key}-390-${theme}.png`),
                fullPage: true,
                animations: "disabled",
              });
              report.screenshots.push(
                `${SHOT_PREFIX}active-${scenario.key}-390-${theme}.png`,
              );
            } else {
              assert.equal(snapshot.hostMode, "full", `${label}: full canvas`);
              await shot(
                page.locator("[data-chain-flow]"),
                `active-${scenario.key}-1440-${theme}.png`,
                page,
              );
            }
          } finally {
            if (errors.length > 0) {
              report.errors.push(...errors.map((item) => `${label}: ${item}`));
            }
            await context.close();
          }
        }
      }
    }

    /* ---------------- 英文文案：Current / Balanced across ---------------- */
    {
      const { context, page, errors } = await newPage({ locale: "en" });
      try {
        await openChain(page, "chain-lowest");
        const lowest = await chainSnapshot(page);
        const active = lowest.tagRows.find((row) => row.name === "东京-01");
        assert.equal(active?.tagText, "Current", "en active copy");
        await openChain(page, "chain-round-robin");
        const balanced = await chainSnapshot(page);
        assert.equal(
          balanced.headers[1].count,
          "Balanced across 2",
          "en balanced copy",
        );
        report.assertions.en = { active: active?.tagText, balanced: balanced.headers[1].count };
      } finally {
        if (errors.length > 0) report.errors.push(...errors.map((item) => `en: ${item}`));
        await context.close();
      }
    }

    /* ---------------- reduced motion ---------------- */
    {
      const { context, page, errors } = await newPage({ reducedMotion: true });
      try {
        await openChain(page, "chain-multi");
        const snapshot = await chainSnapshot(page);
        report.assertions.reduced = snapshot;
        assert.ok(snapshot.marches >= 1);
        assert.equal(snapshot.marchAnimation.name, "none", "减弱动效下 march 静止");
        await page.screenshot({
          path: path.join(OUT, `${SHOT_PREFIX}chain-march-reduced-1440-dark.png`),
        });
        report.screenshots.push(`${SHOT_PREFIX}chain-march-reduced-1440-dark.png`);
      } finally {
        if (errors.length > 0) report.errors.push(...errors.map((item) => `reduced: ${item}`));
        await context.close();
      }
    }

    /* ---------------- 模板画布回归：kind / pulse / pill 44 / 无 march ---------------- */
    {
      const { context, page, errors } = await newPage();
      try {
        const canvas = await openTemplateCanvas(page, "dark");
        const template = await page.evaluate(() => {
          const host = document.querySelector("[data-template-topology] [data-template-flow]");
          const root = document.querySelector("[data-template-topology]");
          const pill = root?.querySelector("[data-template-flow-pill]");
          return {
            kind: host?.getAttribute("data-template-flow-kind"),
            pulses: root?.querySelectorAll("[data-template-flow-pulse]").length ?? 0,
            marches: root?.querySelectorAll("[data-template-flow-march]").length ?? 0,
            pillWidth: pill === null ? null : Number.parseFloat(getComputedStyle(pill).width),
            hotEdges:
              root?.querySelectorAll('[data-template-flow-edge-group][data-hot="true"]')
                .length ?? -1,
          };
        });
        report.assertions.template = template;
        assert.equal(template.kind, "template");
        assert.ok(template.pulses > 0, "模板仍有 pulse");
        assert.equal(template.marches, 0, "模板没有 march");
        assert.ok(Math.abs(template.pillWidth - 44) <= 1, "模板药丸仍是 44px");
        await shot(canvas, "template-regression-1440-dark.png", page);
      } finally {
        if (errors.length > 0) report.errors.push(...errors.map((item) => `template: ${item}`));
        await context.close();
      }
    }

    report.assertions.pillWidth = {
      chain: report.assertions.multi.pillWidths[0],
      template: report.assertions.template.pillWidth,
    };

    if (COMPARE_TEMPLATE) await compareTemplateFrames();
  }
} catch (error) {
  report.errors.push(String(error?.stack ?? error));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  writeFileSync(
    path.join(OUT, TEMPLATE_ONLY ? `report-template-${SHOT_PREFIX.replace(/-$/, "")}.json` : "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

if (report.errors.length > 0) {
  console.error(`✖ ${report.errors.length} error(s)`);
  for (const error of report.errors) console.error(` - ${error}`);
  process.exitCode = 1;
} else {
  console.log(`✓ chain-flow acceptance: ${report.screenshots.length} screenshots`);
  if (report.templateDiff) {
    const worst = Math.max(...report.templateDiff.map((row) => row.diffPixels ?? 0));
    console.log(`✓ template static frames diff: ${worst}px`);
  }
}
