#!/usr/bin/env node
/**
 * 「链路时延」拓扑按组呈现的验收截图与断言。
 *
 * 后端契约新增 `chains[].nodes[].members[]` / `member_count`。本机 preview
 * 数据库的链是 3 组 / 3 段，真实接口已能给 `nodes[]`，但还没有 members；
 * 这里只在浏览器层把两条链的 `nodes` 补成契约形状（组名 + 成员 + 计数），
 * series / 段时延 / 窗口丢包 / entry / exit / 链状态都来自真实接口。
 *
 * 前置 / Prerequisite:
 *   sqlite3 data/preview.db ".backup data/chain-members-preview.db"
 *   # 把时延 / 探测样本平移到当前窗口（见 README「数据说明」）
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
 *   PIERWAVE_DB='sqlite://data/chain-members-preview.db?mode=rwc' \
 *     ./target/debug/pierwave-master
 *   cd web && npm run dev
 *
 * 用法 / Usage:
 *   node web/screenshots/chain-members/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const ADMIN = process.env.ADMIN_PASSWORD ?? "devpass";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEWPORTS = [1440, 390];
const THEMES = /** @type {const} */ (["dark", "light"]);

const MIXED_CHAIN = "c0ffee00-0006-4000-8000-000000000601";
const ESTIMATED_CHAIN = "c0ffee00-0006-4000-8000-000000000603";
/** 旧契约（nodes 无 members）回归：仍是单节点外观。 */
const LEGACY_CHAIN = "c0ffee00-0006-4000-8000-000000000602";

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

const loginResponse = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: ADMIN }),
});
assert.equal(loginResponse.status, 200, "admin login failed");
const sessionCookie = loginResponse.headers
  .getSetCookie()
  .map((item) => item.split(";")[0])
  .find((item) => item.startsWith("pierwave_session="));
assert.ok(sessionCookie, "session cookie must exist");

/* ------------------------------------------------------------------ *
 * 契约注入：只补 nodes[].members / member_count，不改真实数值
 * ------------------------------------------------------------------ */

const member = (serverId, name, status) => ({
  server_id: serverId,
  name,
  status,
});

/**
 * 混排拓扑：一条链上同时出现单成员、双成员（一在线一离线）、
 * 3+ 成员折叠（可见两行 + `+1`，被折叠的成员离线）和目标节点。
 */
const MIXED_NODES = [
  {
    seq: 0,
    name: "香港入口",
    role: "source",
    status: "online",
    member_count: 1,
    members: [member("hk-01", "香港-01", "online")],
  },
  {
    seq: 1,
    name: "东京中转",
    role: "hop",
    status: "offline",
    member_count: 2,
    members: [
      member("tokyo-01", "东京-01", "online"),
      member("tokyo-02", "东京-02", "offline"),
    ],
  },
  {
    seq: 2,
    name: "新加坡中转",
    role: "hop",
    status: "online",
    member_count: 3,
    members: [
      member("sg-01", "新加坡-01", "online"),
      // 未知状态画灰点：不把没有回报当成在线。
      member("sg-02", "新加坡-02", null),
      // 被 `+1` 折叠的第三台离线；组级红点取最差成员。
      member("us-west-01", "美西-01", "offline"),
    ],
  },
  {
    seq: 3,
    name: "大阪出口",
    role: "hop",
    status: "offline",
    member_count: 1,
    members: [member("osaka-01", "大阪-01", "offline")],
  },
  { seq: 4, name: "链目标", role: "target", status: null },
];

/** 多路径链：中间组双成员；链级 estimated=true → 相邻段时延带 ≈。 */
const ESTIMATED_NODES = [
  {
    seq: 0,
    name: "香港入口",
    role: "source",
    status: "online",
    member_count: 1,
    members: [member("hk-01", "香港-01", "online")],
  },
  {
    seq: 1,
    name: "东京中转（双路）",
    role: "hop",
    status: "offline",
    member_count: 2,
    members: [
      member("tokyo-01", "东京-01", "online"),
      member("tokyo-02", "东京-02", "offline"),
    ],
  },
  {
    seq: 2,
    name: "大阪出口",
    role: "hop",
    status: "offline",
    member_count: 1,
    members: [member("osaka-01", "大阪-01", "offline")],
  },
  { seq: 3, name: "链目标", role: "target", status: null },
];

function inject(payload) {
  for (const chain of payload.chains ?? []) {
    if (chain.id === MIXED_CHAIN) chain.nodes = MIXED_NODES;
    if (chain.id === ESTIMATED_CHAIN) chain.nodes = ESTIMATED_NODES;
    if (chain.id === LEGACY_CHAIN) {
      // 最新主控已经返回 members；这里剥掉，模拟旧契约验证单节点回退。
      chain.nodes = (chain.nodes ?? []).map((node) => {
        const legacy = { ...node };
        delete legacy.members;
        delete legacy.member_count;
        return legacy;
      });
    }
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * 截图 / 断言基础设施
 * ------------------------------------------------------------------ */

const results = [];
const failures = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    failures.push(`${name}: ${error.message}`);
  }
}

async function newPage(browser, width, theme) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    colorScheme: theme,
    deviceScaleFactor: 1,
  });
  await context.addInitScript(
    ({ theme }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", "zh-CN");
    },
    { theme },
  );
  await context.addCookies([
    {
      name: sessionCookie.split("=")[0],
      value: sessionCookie.split("=")[1],
      url: BASE,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.route("**/api/v1/overview/chain-health*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: inject(body) });
  });
  return { context, page: await context.newPage() };
}

async function openDetail(page, chainId) {
  await page.goto(`${BASE}/?view=chain&chain=${chainId}`, {
    waitUntil: "networkidle",
  });
  await page.locator("[data-chain-dialog]").waitFor();
  await page.locator("[data-chain-topology-card]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function shootCard(page, selector, file) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `no box for ${selector}`);
  await page.screenshot({ path: path.join(HERE, file), clip: box });
}

/** 读出拓扑、边、徽章的全部可断言状态。 */
const READ_STATE = () => {
  const readColor = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const nodes = [...document.querySelectorAll("[data-chain-topology-node]")].map(
    (node) => {
      const dot = node.querySelector("[data-chain-topology-node-dot]");
      const rows = [...node.querySelectorAll("[data-chain-topology-member]")];
      return {
        role: node.dataset.role,
        status: node.dataset.status,
        memberCount: Number(node.dataset.memberCount),
        border: getComputedStyle(node).borderStyle,
        // offsetHeight 不受弹窗打开动画的 scale 影响；rect 在动画中途会偏小。
        height: node.offsetHeight,
        label: node
          .querySelector("[data-chain-topology-node-label] > span")
          ?.textContent?.trim(),
        name: node
          .querySelector("[data-chain-topology-node-name]")
          ?.textContent?.trim(),
        count: node
          .querySelector("[data-chain-topology-node-count]")
          ?.textContent?.trim() ?? null,
        more: node
          .querySelector("[data-chain-topology-member-more]")
          ?.textContent?.trim() ?? null,
        dot: dot
          ? {
              tone: dot.dataset.tone,
              background: getComputedStyle(dot).backgroundColor,
              animation: getComputedStyle(dot).animationName,
            }
          : null,
        rows: rows.map((row) => {
          const rowDot = row.querySelector("[data-chain-topology-member-dot]");
          return {
            name: row.querySelector("span:last-child")?.textContent?.trim(),
            status: row.dataset.status,
            tone: row.dataset.tone,
            dot: {
              background: getComputedStyle(rowDot).backgroundColor,
              animation: getComputedStyle(rowDot).animationName,
            },
          };
        }),
      };
    },
  );
  const edges = [...document.querySelectorAll("[data-chain-topology-edge]")].map(
    (edge) => ({
      seq: Number(edge.dataset.seq),
      missing: edge.dataset.missing === "true",
      estimated: edge.dataset.estimated === "true",
      latency: edge
        .querySelector("[data-chain-topology-edge-latency]")
        ?.textContent?.trim(),
      loss: edge
        .querySelector("[data-chain-topology-edge-loss]")
        ?.textContent?.trim(),
      title: edge.getAttribute("title"),
    }),
  );
  const scroll = document.querySelector("[data-chain-topology-scroll]");
  const badge = document.querySelector("[data-chain-status-badge]");
  const estimatedBadge = document.querySelector("[data-chain-estimated-badge]");
  return {
    nodes,
    edges,
    badge: badge
      ? {
          state: badge.dataset.state,
          text: badge
            .querySelector("[data-chain-status-badge-text]")
            ?.textContent?.trim(),
        }
      : null,
    estimatedBadge: estimatedBadge
      ? {
          text: estimatedBadge.textContent?.trim(),
          title: estimatedBadge.getAttribute("title"),
        }
      : null,
    topologyOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : 0,
    pageOverflow:
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    colors: {
      success: readColor("--success"),
      destructive: readColor("--destructive"),
      muted: readColor("--muted-foreground"),
    },
  };
};

function assertNode(state, index, expected, tag) {
  const node = state.nodes[index];
  assert.ok(node, `${tag}: missing node ${index}`);
  assert.equal(node.role, expected.role, `${tag}: node ${index} role`);
  assert.equal(node.label, expected.label, `${tag}: node ${index} label`);
  assert.equal(node.name, expected.name, `${tag}: node ${index} name`);
  assert.equal(node.height, expected.height, `${tag}: node ${index} height`);
  assert.equal(
    node.memberCount,
    expected.memberCount,
    `${tag}: node ${index} member count`,
  );
  assert.equal(
    node.rows.length,
    expected.rows,
    `${tag}: node ${index} member row count`,
  );
  assert.equal(node.count, expected.count, `${tag}: node ${index} count label`);
  assert.equal(node.more, expected.more, `${tag}: node ${index} +N`);
  if (expected.border) {
    assert.equal(node.border, expected.border, `${tag}: node ${index} border`);
  }
  if (expected.groupTone === null) {
    assert.equal(node.dot, null, `${tag}: node ${index} must not render a dot`);
  } else {
    assert.ok(node.dot, `${tag}: node ${index} needs a group dot`);
    assert.equal(
      node.dot.tone,
      expected.groupTone,
      `${tag}: node ${index} group tone`,
    );
    assert.equal(
      node.dot.background,
      state.colors[expected.groupColor],
      `${tag}: node ${index} group dot color`,
    );
    assert.equal(
      node.dot.animation,
      expected.groupTone === "online" ? "status-breathe" : "none",
      `${tag}: node ${index} group dot animation`,
    );
  }
  return node;
}

async function assertMixed(page, width, theme) {
  const state = await page.evaluate(READ_STATE);
  const tag = `mixed ${width} ${theme}`;

  await check(`${tag}: node labels / heights / member rows`, () => {
    assertNode(
      state,
      0,
      {
        role: "source",
        label: "SOURCE",
        name: "香港入口",
        height: 56,
        memberCount: 1,
        rows: 0,
        count: null,
        more: null,
        groupTone: "online",
        groupColor: "success",
      },
      tag,
    );
    assertNode(
      state,
      1,
      {
        role: "hop",
        label: "HOP 1",
        name: "东京中转",
        height: 72,
        memberCount: 2,
        rows: 2,
        count: "2 台",
        more: null,
        groupTone: "fault",
        groupColor: "destructive",
      },
      tag,
    );
    assertNode(
      state,
      2,
      {
        role: "hop",
        label: "HOP 2",
        name: "新加坡中转",
        height: 88,
        memberCount: 3,
        rows: 2,
        count: "3 台",
        more: "+1",
        groupTone: "fault",
        groupColor: "destructive",
      },
      tag,
    );
    assertNode(
      state,
      3,
      {
        role: "hop",
        label: "HOP 3",
        name: "大阪出口",
        height: 56,
        memberCount: 1,
        rows: 0,
        count: null,
        more: null,
        groupTone: "fault",
        groupColor: "destructive",
      },
      tag,
    );
    const target = assertNode(
      state,
      4,
      {
        role: "target",
        label: "TARGET",
        name: "链目标",
        height: 56,
        memberCount: 0,
        rows: 0,
        count: null,
        more: null,
        groupTone: null,
        border: "dashed",
      },
      tag,
    );
    assert.equal(target.status, "none", `${tag}: target has no status`);
    return state.nodes.map((node) => ({
      label: node.label,
      name: node.name,
      height: node.height,
      memberCount: node.memberCount,
      rows: node.rows.length,
      count: node.count,
      more: node.more,
    }));
  });

  await check(`${tag}: member row count matches member_count (<=2 rows)`, () => {
    for (const node of state.nodes) {
      if (node.role === "target") continue;
      const expectedRows =
        node.memberCount <= 1 ? 0 : Math.min(node.memberCount, 2);
      assert.equal(
        node.rows.length,
        expectedRows,
        `${node.label}: ${node.rows.length} rows for ${node.memberCount} members`,
      );
      if (node.memberCount > 2) {
        assert.equal(
          node.more,
          `+${node.memberCount - 2}`,
          `${node.label}: +N fold`,
        );
      }
    }
    return "ok";
  });

  await check(`${tag}: member dot colors (green breathing / red / grey)`, () => {
    const dualRows = state.nodes[1].rows;
    assert.deepEqual(
      dualRows.map((row) => row.tone),
      ["online", "fault"],
    );
    assert.equal(dualRows[0].dot.background, state.colors.success);
    assert.equal(dualRows[0].dot.animation, "status-breathe");
    assert.equal(dualRows[1].dot.background, state.colors.destructive);
    assert.equal(dualRows[1].dot.animation, "none");

    const tripleRows = state.nodes[2].rows;
    assert.deepEqual(
      tripleRows.map((row) => row.tone),
      ["online", "unknown"],
    );
    assert.equal(tripleRows[1].dot.background, state.colors.muted);
    assert.equal(tripleRows[1].dot.animation, "none");
    return { dual: dualRows, triple: tripleRows };
  });

  await check(`${tag}: group dot uses the worst member`, () => {
    assert.equal(state.nodes[1].dot.tone, "fault");
    assert.equal(state.nodes[2].dot.tone, "fault");
    // 组级红点不能因为可见两行都是绿/灰就变绿。
    assert.equal(state.nodes[2].dot.background, state.colors.destructive);
    return state.nodes.map((node) => node.dot?.tone ?? null);
  });

  await check(`${tag}: chain status badge shows blocked`, () => {
    assert.ok(state.badge, "badge must render");
    assert.equal(state.badge.state, "blocked");
    assert.match(state.badge.text, /^阻断/);
    return state.badge;
  });

  await check(`${tag}: no estimated badge when the contract does not say so`, () => {
    assert.equal(
      state.estimatedBadge,
      null,
      "estimated=false must not render the badge",
    );
    return state.estimatedBadge;
  });

  await check(`${tag}: single-member segments are not marked estimated`, () => {
    for (const edge of state.edges) {
      assert.equal(edge.estimated, false, `edge ${edge.seq} estimated`);
      assert.doesNotMatch(edge.latency ?? "", /≈/);
      // 历史序列仍在窗口内：末两跳虽在「当前 2h」无探测，也按最后一个
      // 有效样本展示真实时延，而不是伪造「无历史数据」。
      assert.match(
        edge.latency ?? "",
        /^\d+(\.\d+)? ms$/,
        `edge ${edge.seq} latency ${edge.latency}`,
      );
      assert.equal(edge.missing, false, `edge ${edge.seq} missing`);
    }
    return state.edges;
  });

  await check(`${tag}: no horizontal overflow`, () => {
    if (width >= 768) {
      assert.ok(
        state.topologyOverflow <= 1,
        `topology overflow ${state.topologyOverflow}px`,
      );
    } else {
      // 390 仍靠卡片内横向滚动看完整链路，但不能把整页撑宽。
      assert.ok(
        state.topologyOverflow > 0,
        `expected inner scroll, got ${state.topologyOverflow}px`,
      );
    }
    assert.ok(
      state.pageOverflow <= 1,
      `page overflow ${state.pageOverflow}px at ${width}`,
    );
    return {
      topologyOverflow: state.topologyOverflow,
      pageOverflow: state.pageOverflow,
    };
  });
}

async function assertEstimated(page, width, theme) {
  const state = await page.evaluate(READ_STATE);
  const tag = `estimated ${width} ${theme}`;

  await check(`${tag}: only segments touching a multi-member group get ≈`, () => {
    const first = state.edges[0];
    assert.ok(first, "needs the first edge");
    assert.equal(first.estimated, true);
    assert.equal(first.missing, false);
    assert.match(first.latency ?? "", /≈$/);
    assert.match(first.title ?? "", /多路径估算/);

    const second = state.edges[1];
    assert.equal(second.estimated, true, "hop1 → hop2 still touches the group");
    assert.match(second.latency ?? "", /≈$/);

    const last = state.edges.at(-1);
    assert.equal(last.estimated, false, "hop2 → target only has single members");
    assert.doesNotMatch(last.latency ?? "", /≈/);
    assert.doesNotMatch(last.title ?? "", /多路径估算/);
    return { first, second, last };
  });

  await check(`${tag}: estimated badge explains multi-path medians`, () => {
    assert.ok(state.estimatedBadge, "estimated chain needs the badge");
    assert.equal(state.estimatedBadge.text, "估算");
    assert.equal(
      state.estimatedBadge.title,
      "多路径链路，按各跳中位数求和，为估算值",
    );
    assert.doesNotMatch(state.estimatedBadge.title, /缺失跳/);
    return state.estimatedBadge;
  });

  await check(`${tag}: dual-member group is red, target is dashed`, () => {
    const hop = state.nodes[1];
    assert.equal(hop.memberCount, 2);
    assert.equal(hop.rows.length, 2);
    assert.equal(hop.dot.tone, "fault");
    assert.equal(hop.dot.background, state.colors.destructive);
    const target = state.nodes.at(-1);
    assert.equal(target.role, "target");
    assert.equal(target.border, "dashed");
    assert.equal(target.dot, null);
    assert.equal(target.rows.length, 0);
    return { hop: hop.label, target: target.label };
  });
}

/** 旧契约：nodes 没有 members / member_count，必须回到单节点外观。 */
async function assertLegacy(page, width, theme) {
  const state = await page.evaluate(READ_STATE);
  const tag = `legacy ${width} ${theme}`;

  await check(`${tag}: nodes without members look like single nodes`, () => {
    assert.ok(state.nodes.length >= 3, "needs a source / hop / target");
    for (const node of state.nodes) {
      assert.equal(node.height, 56, `${node.label} height`);
      assert.equal(node.memberCount, 0, `${node.label} member count`);
      assert.equal(node.rows.length, 0, `${node.label} rows`);
      assert.equal(node.count, null, `${node.label} count label`);
      assert.equal(node.more, null, `${node.label} +N`);
    }
    const target = state.nodes.at(-1);
    assert.equal(target.role, "target");
    assert.equal(target.border, "dashed");
    return state.nodes.map((node) => ({
      label: node.label,
      name: node.name,
      height: node.height,
      rows: node.rows.length,
    }));
  });

  await check(`${tag}: topology and page fit the viewport`, () => {
    if (width >= 768) {
      assert.ok(
        state.topologyOverflow <= 1,
        `topology overflow ${state.topologyOverflow}px`,
      );
    }
    assert.ok(
      state.pageOverflow <= 1,
      `page overflow ${state.pageOverflow}px`,
    );
    return {
      topologyOverflow: state.topologyOverflow,
      pageOverflow: state.pageOverflow,
    };
  });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const browser = await chromium.launch({ channel: "chrome", headless: true });

for (const width of VIEWPORTS) {
  for (const theme of THEMES) {
    const { context, page } = await newPage(browser, width, theme);
    try {
      await openDetail(page, MIXED_CHAIN);
      await assertMixed(page, width, theme);
      await shootCard(
        page,
        "[data-chain-topology-card]",
        `topology-mixed-${width}-${theme}.png`,
      );

      if (width === 390) {
        // 390 卡片内部横向滚动：分别滚到 3+ 成员组与末端目标节点。
        await page.evaluate(() => {
          document
            .querySelector('[data-chain-topology-node][data-member-count="3"]')
            ?.scrollIntoView({ inline: "center", block: "nearest" });
        });
        await page.waitForTimeout(200);
        await shootCard(
          page,
          "[data-chain-topology-card]",
          `topology-mixed-${width}-${theme}-group.png`,
        );

        await page.evaluate(() => {
          const scroll = document.querySelector("[data-chain-topology-scroll]");
          scroll.scrollLeft = scroll.scrollWidth;
        });
        await page.waitForTimeout(200);
        await shootCard(
          page,
          "[data-chain-topology-card]",
          `topology-mixed-${width}-${theme}-end.png`,
        );
      }

      await openDetail(page, ESTIMATED_CHAIN);
      await assertEstimated(page, width, theme);
      await shootCard(
        page,
        "[data-chain-topology-card]",
        `topology-estimated-${width}-${theme}.png`,
      );

      // 旧契约回归：没有 members 的节点保持原来的单节点外观。
      await openDetail(page, LEGACY_CHAIN);
      await assertLegacy(page, width, theme);
      await shootCard(
        page,
        "[data-chain-topology-card]",
        `topology-legacy-${width}-${theme}.png`,
      );
    } finally {
      await context.close();
    }
  }
}

await browser.close();

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  chains: { mixed: MIXED_CHAIN, estimated: ESTIMATED_CHAIN },
  injections: {
    nodes: "两组节点的 members[] / member_count / 成员状态（覆盖双成员一在线一离线与 3+ 折叠）",
    legacy: "第三条链剥掉 members / member_count，模拟旧契约的单节点回退",
    untouched: "series / 段时延 / 窗口丢包 / entry / exit / 链状态徽章 / estimated 均来自真实接口",
  },
  viewports: VIEWPORTS,
  themes: THEMES,
  results,
  failures,
};
writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} checks passed`);
