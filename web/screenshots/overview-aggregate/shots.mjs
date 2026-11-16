// 概览页聚合卡片截图与实测：趋势 / 分布 / 榜单三组分段控件。
//
// 前置：一份 **fresh DB** 的 master 已启动，且 vite dev（默认 5173）或
// 已构建的 web/dist 在跑；例如：
//   PIERWAVE_ADDR=127.0.0.1:8787 \
//   PIERWAVE_DB='sqlite:///tmp/pierwave-overview/db.sqlite?mode=rwc' \
//   PIERWAVE_ADMIN_PASSWORD=devpass ./target/debug/pierwave-master
//   cd web && npm run dev
// 用法：BASE=http://127.0.0.1:5173 DB_PATH=/tmp/pierwave-overview/db.sqlite \
//   node web/screenshots/overview-aggregate/shots.mjs
//
// 脚本通过 API 造 2 台服务器 / 80 个节点 / 5 个用户 / 4 个套餐 / 5 条链，
// 再直接写两张流量日表（7 天趋势 + 今日节点 Top），保证每个标签页都有数据。
// 重复运行前请重建 DB。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const DB_PATH = process.env.DB_PATH ?? "/tmp/pw-overview/db.sqlite";
// 输出目录跟着脚本走：从仓库根目录或 web/ 下运行都写到同一处。
const OUT = fileURLToPath(new URL(".", import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HK_NODES = 60;
const JP_NODES = 20;
// 高度目标：1440×900 下整页 ≤ 1.6 屏（约 1450px）。
const HEIGHT_BUDGET = 1450;
const SCREEN_HEIGHT = 900;

mkdirSync(OUT, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`ok - ${message}`);
}

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "devpass" }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .find((item) => item.startsWith("pierwave_session="));
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

async function api(cookie, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const value = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return value;
}

async function seed(cookie) {
  const servers = {};
  for (const [key, name, address] of [
    ["hk", "香港-01", "10.0.0.1"],
    ["jp", "日本-01", "10.0.0.2"],
  ]) {
    servers[key] = (
      await api(cookie, "/api/v1/servers", { name, address })
    ).server;
  }

  const nodes = [];
  for (let index = 0; index < HK_NODES + JP_NODES; index += 1) {
    const hk = index < HK_NODES;
    const node = (
      await api(cookie, `/api/v1/servers/${servers[hk ? "hk" : "jp"].id}/nodes`, {
        name: `${hk ? "香港" : "日本"}-${String(index + 1).padStart(2, "0")}`,
        tag: `node-${index + 1}`,
        protocol: ["vless", "trojan", "vmess"][index % 3],
        transport: "tcp",
        security: "none",
        port: 10000 + index,
        enabled: true,
        tags: hk ? ["hk"] : ["jp"],
        region: hk ? "HK" : "JP",
        config: {},
      })
    ).node;
    nodes.push(node);
  }

  const users = {};
  for (const username of ["alice", "bob", "carol", "dave", "erin"]) {
    users[username] = (
      await api(cookie, "/api/v1/users", {
        username,
        password: "password123",
      })
    ).user;
  }

  const packages = {};
  for (const [key, name, quota] of [
    ["month", "月卡", 100 * 1024 ** 3],
    ["quarter", "季卡", 300 * 1024 ** 3],
    ["year", "年卡", 1024 ** 4],
    ["trial", "体验卡", 10 * 1024 ** 3],
  ]) {
    packages[key] = (
      await api(cookie, "/api/v1/packages", {
        name,
        quota_bytes: quota,
        period_days: key === "year" ? 365 : key === "quarter" ? 90 : 30,
      })
    ).package;
  }

  for (const [username, packageKey] of [
    ["alice", "month"],
    ["bob", "month"],
    ["carol", "quarter"],
    ["dave", "year"],
    ["erin", "trial"],
  ]) {
    await api(cookie, `/api/v1/users/${users[username].id}/packages`, {
      package_id: packages[packageKey].id,
    });
  }

  return { servers, nodes, users, packages };
}

async function seedChains(cookie, seeded) {
  const defs = [
    {
      name: "港日中转链",
      port: 19011,
      target: ["1.1.1.1", 443],
      servers: ["hk", "jp"],
    },
    {
      name: "混合链-演示",
      port: 19012,
      target: ["example.com", 8443],
      servers: ["hk"],
    },
    {
      name: "备用入口链",
      port: 19014,
      target: ["1.0.0.1", 53],
      servers: ["jp"],
    },
    {
      name: "单跳直连链",
      port: 19015,
      target: ["8.8.8.8", 443],
      servers: ["hk"],
    },
    {
      name: "双跳备用链",
      port: 19016,
      target: ["9.9.9.9", 853],
      servers: ["hk", "jp"],
    },
  ];

  for (const def of defs) {
    // 一条链里同一台服务器只能出现一次，所以每条链的组都按 def.servers 展开。
    await api(cookie, "/api/v1/chains", {
      name: def.name,
      target_host: def.target[0],
      target_port: def.target[1],
      enabled: true,
      engine: "native",
      protocol: "tcp",
      groups: def.servers.map((key, index) => ({
        strategy: "round_robin",
        members: [
          {
            server_id: seeded.servers[key].id,
            ...(index === 0 ? { listen_port: def.port } : {}),
            priority: 0,
          },
        ],
      })),
    });
  }
}

/** 7 天用户流量（趋势图）+ 今日节点流量（节点榜），直接写两张日表。 */
function seedTraffic(seeded) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
  const today = days[days.length - 1];

  const userRows = [];
  const perUser = {
    alice: 6,
    bob: 12,
    carol: 9,
    dave: 4,
    erin: 1,
  };
  days.forEach((day, index) => {
    for (const [username, base] of Object.entries(perUser)) {
      const bytes = (base + (index % 3)) * 1024 ** 3;
      userRows.push({
        day,
        server_id: seeded.servers.hk.id,
        subject: seeded.users[username].id,
        bytes,
      });
    }
  });

  // 前 7 个节点造递减流量：节点榜有 5 条，第 6/7 名被截断。
  const nodeRows = seeded.nodes.slice(0, 7).map((node, index) => ({
    day: today,
    server_id: node.server_id,
    node_tag: node.tag,
    user_id: "",
    bytes: (7 - index) * 900 * 1024 ** 2,
  }));

  const script = `
import json, sqlite3, sys
data = json.load(sys.stdin)
conn = sqlite3.connect(sys.argv[1])
for row in data["user_rows"]:
    half = row["bytes"] // 2
    conn.execute(
        """INSERT INTO traffic_daily
             (day, server_id, subject, uplink, downlink, weighted)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(day, server_id, subject) DO UPDATE SET
             uplink = excluded.uplink,
             downlink = excluded.downlink,
             weighted = excluded.weighted""",
        (row["day"], row["server_id"], row["subject"],
         half, row["bytes"] - half, row["bytes"]),
    )
for row in data["node_rows"]:
    half = row["bytes"] // 2
    conn.execute(
        """INSERT INTO traffic_node_daily
             (day, server_id, node_tag, user_id, uplink, downlink, weighted)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day, server_id, node_tag, user_id) DO UPDATE SET
             uplink = excluded.uplink,
             downlink = excluded.downlink,
             weighted = excluded.weighted""",
        (row["day"], row["server_id"], row["node_tag"], row["user_id"],
         half, row["bytes"] - half, row["bytes"]),
    )
conn.commit()
print("seeded", len(data["user_rows"]), len(data["node_rows"]))
`;
  execFileSync("python3", ["-c", script, DB_PATH], {
    input: JSON.stringify({ user_rows: userRows, node_rows: nodeRows }),
    stdio: ["pipe", "inherit", "inherit"],
  });
  return today;
}

async function capture(browser, cookie, { theme, width, height }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    locale: "zh-CN",
  });
  const [name, value] = cookie.split("=");
  await context.addCookies([
    { name, value, url: `${BASE}/`, httpOnly: true, sameSite: "Lax" },
  ]);
  await context.addInitScript(
    ({ theme }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", "zh-CN");
    },
    { theme },
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return { context, page, errors };
}

/** 概览页的滚动容器是 <main>，整页高度以它为准。 */
async function contentHeight(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    return main ? main.scrollHeight : document.documentElement.scrollHeight;
  });
}

async function tabState(tablist) {
  return tablist.getByRole("tab").evaluateAll((tabs) =>
    tabs.map((tab) => ({
      text: tab.textContent.trim(),
      selected: tab.getAttribute("aria-selected") === "true",
      tabindex: tab.getAttribute("tabindex"),
    })),
  );
}

const TABLISTS = {
  trend: "切换趋势维度",
  distribution: "切换分布维度",
  leaderboard: "切换榜单维度",
};

/** 默认态 + 四个「非默认标签」态；组合起来覆盖三张卡的全部标签。 */
const STATES = [
  { name: "default", label: "总流量 / 协议 / 服务器" },
  { name: "trend-protocol", label: "趋势 → 协议", tabs: [["trend", "协议"]] },
  {
    name: "dist-package",
    label: "分布 → 套餐",
    tabs: [["distribution", "套餐"]],
  },
  {
    name: "board-node",
    label: "榜单 → 节点",
    tabs: [["leaderboard", "节点"]],
  },
  {
    name: "board-user",
    label: "榜单 → 用户",
    tabs: [["leaderboard", "用户"]],
  },
];

const cookie = await login();
const seeded = await seed(cookie);
await seedChains(cookie, seeded);
const today = seedTraffic(seeded);
assert(today.length === 10, `流量日=${today}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const reports = [];

// ---- 交互 / 键盘 / 请求 / 溢出 / 跳转：只在 dark 1440 做一次完整验证 ----
{
  const { context, page, errors } = await capture(browser, cookie, {
    theme: "dark",
    width: 1440,
    height: SCREEN_HEIGHT,
  });
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/api/v1/overview" ||
      url.pathname === "/api/v1/stats/traffic" ||
      url.pathname === "/api/v1/stats/overview"
    ) {
      requests.push(`${url.pathname}${url.search}`);
    }
  });

  await page.goto(`${BASE}/overview`, { waitUntil: "networkidle" });
  await page.getByText("流量榜单").first().waitFor({ state: "visible" });
  await page.getByText("近 7 天趋势").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);

  const loaded = [...requests];
  const defaults = {};
  for (const [key, aria] of Object.entries(TABLISTS)) {
    const tablist = page.getByRole("tablist", { name: aria });
    defaults[key] = await tabState(tablist);
    assert(
      defaults[key].filter((tab) => tab.selected).length === 1,
      `${key} 默认只有一个激活标签`,
    );
    assert(
      defaults[key][0].selected,
      `${key} 默认停在第一项（${defaults[key][0].text}）`,
    );
    assert(
      (await tablist.evaluate((element) => getComputedStyle(element).overflowX)) ===
        "auto",
      `${key} 标签条可横向滚动（overflow-x: auto）`,
    );
  }
  assert(
    defaults.trend[0].text === "总流量",
    "趋势默认「总流量」",
  );
  assert(
    defaults.distribution[0].text === "协议",
    "分布默认「协议」",
  );
  assert(
    defaults.leaderboard[0].text === "服务器",
    "榜单默认「服务器」",
  );

  // 键盘：聚焦激活标签，按右箭头切到下一项，再按左箭头切回。
  for (const [key, aria] of Object.entries(TABLISTS)) {
    const tablist = page.getByRole("tablist", { name: aria });
    const tabs = tablist.getByRole("tab");
    await tabs.first().focus();
    await page.waitForTimeout(100);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
    const afterRight = await tabState(tablist);
    assert(
      afterRight[1].selected && !afterRight[0].selected,
      `${key} 右箭头切到第二项`,
    );
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(100);
    const afterLeft = await tabState(tablist);
    assert(
      afterLeft[0].selected && !afterLeft[1].selected,
      `${key} 左箭头切回第一项`,
    );
  }

  // 点击非默认标签：数据不重新请求（全部来自首屏已加载的查询）。
  for (const [key, label] of [
    ["trend", "协议"],
    ["distribution", "套餐"],
    ["leaderboard", "节点"],
  ]) {
    await page
      .getByRole("tablist", { name: TABLISTS[key] })
      .getByRole("tab", { name: label })
      .click();
    await page.waitForTimeout(250);
  }
  const afterSwitching = [...requests];
  assert(
    afterSwitching.length === loaded.length,
    `切换标签未新增数据请求（首屏 ${loaded.length} 次，切换后 ${afterSwitching.length} 次）`,
  );

  // 每类榜单都保留跳转：只看榜单卡内部的行链接。
  const boardCard = page
    .locator("section")
    .filter({ hasText: "流量榜单" })
    .first();
  const boardTabs = boardCard.getByRole("tablist", {
    name: TABLISTS.leaderboard,
  });
  await boardTabs.getByRole("tab", { name: "节点" }).click();
  const nodeLink = boardCard
    .locator('a[href="/nodes"]')
    .filter({ hasText: "香港-01" })
    .first();
  await nodeLink.waitFor({ state: "visible" });
  assert(
    (await nodeLink.textContent()).includes("香港-01"),
    "节点榜每行跳转 /nodes",
  );
  await boardTabs.getByRole("tab", { name: "用户" }).click();
  const userLink = boardCard
    .locator('a[href="/users"]')
    .filter({ hasText: "alice" })
    .first();
  await userLink.waitFor({ state: "visible" });
  assert(
    (await userLink.textContent()).includes("alice"),
    "用户榜每行跳转 /users",
  );
  await boardTabs.getByRole("tab", { name: "服务器" }).click();
  const serverLink = boardCard
    .locator('a[href="/servers"]')
    .filter({ hasText: "香港-01" })
    .first();
  await serverLink.waitFor({ state: "visible" });
  assert(
    (await serverLink.textContent()).includes("香港-01"),
    "服务器榜每行跳转 /servers",
  );

  assert(errors.length === 0, `浏览器无报错（${errors.join("; ")}）`);

  // 空数据兜底：拦掉聚合与流量接口，逐标签确认空态文案（不出现空白面板）。
  const emptyPage = await context.newPage();
  await emptyPage.route("**/api/v1/overview?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    }),
  );
  await emptyPage.route("**/api/v1/stats/traffic?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ days: [] }),
    }),
  );
  await emptyPage.goto(`${BASE}/overview`, { waitUntil: "networkidle" });
  await emptyPage.getByText("流量榜单").first().waitFor({ state: "visible" });
  await emptyPage.waitForTimeout(400);

  async function emptyTab(listLabel, tabLabel, emptyText) {
    await emptyPage
      .getByRole("tablist", { name: listLabel })
      .getByRole("tab", { name: tabLabel })
      .click();
    await emptyPage.getByText(emptyText).first().waitFor({ state: "visible" });
    console.log(`ok - 空数据 ${listLabel} / ${tabLabel} → ${emptyText}`);
  }

  await emptyTab("切换趋势维度", "协议", "还没有按协议的流量");
  await emptyTab("切换趋势维度", "总流量", "近 7 天还没有流量记录");
  await emptyTab("切换分布维度", "协议", "还没有流量数据");
  await emptyTab("切换分布维度", "套餐", "还没有套餐用量");
  await emptyTab("切换榜单维度", "服务器", "还没有服务器");
  await emptyTab("切换榜单维度", "节点", "还没有节点流量");
  await emptyTab("切换榜单维度", "用户", "还没有用户流量");
  await emptyPage.close();

  reports.push({
    kind: "interaction",
    loaded,
    afterSwitching,
    defaults,
    errors,
    emptyFallbacks: true,
  });
  await context.close();
}

// ---- 高度 + 截图：亮/暗 × 1440/390 × 5 种标签状态 ----
for (const theme of ["light", "dark"]) {
  for (const width of [1440, 390]) {
    const viewportHeight = width === 1440 ? SCREEN_HEIGHT : 844;
    const { context, page, errors } = await capture(browser, cookie, {
      theme,
      width,
      height: viewportHeight,
    });

    for (const state of STATES) {
      await page.goto(`${BASE}/overview`, { waitUntil: "networkidle" });
      await page.getByText("流量榜单").first().waitFor({ state: "visible" });
      for (const [key, label] of state.tabs ?? []) {
        await page
          .getByRole("tablist", { name: TABLISTS[key] })
          .getByRole("tab", { name: label })
          .click();
      }
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);

      const height = await contentHeight(page);
      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main");
        return {
          document: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
          main: main ? main.scrollWidth : 0,
          mainClient: main ? main.clientWidth : 0,
        };
      });
      assert(
        overflow.document <= overflow.viewport,
        `${theme}/${width}/${state.name} 页面无横向溢出（${overflow.document} ≤ ${overflow.viewport}）`,
      );
      assert(
        overflow.main <= overflow.mainClient,
        `${theme}/${width}/${state.name} 主内容区无横向溢出`,
      );

      if (width === 1440) {
        assert(
          height <= HEIGHT_BUDGET,
          `1440×900 ${state.name} 整页 ${height}px ≤ ${HEIGHT_BUDGET}px（${(height / SCREEN_HEIGHT).toFixed(2)} 屏）`,
        );
      }

      // 视口变高后图表可能正好落在鼠标下，先移开再截，避免截进 tooltip。
      await page.mouse.move(0, 0);
      await page.setViewportSize({ width, height: height + 56 });
      await page.waitForTimeout(300);
      const file = `${OUT}/overview-${state.name}-${theme}-${width}.png`;
      await page.screenshot({ path: file, fullPage: true });
      console.log(
        `saved ${file}  height=${height}px (${(height / SCREEN_HEIGHT).toFixed(2)} 屏)`,
      );
      reports.push({
        kind: "shot",
        file,
        state: state.name,
        stateLabel: state.label,
        theme,
        width,
        contentHeight: height,
        screens: +(height / SCREEN_HEIGHT).toFixed(2),
        errors,
      });

      // 截图用的 viewport 被撑高过，下一轮还原成视口高度再量。
      await page.setViewportSize({ width, height: viewportHeight });
    }
    await context.close();
  }
}

await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify({ reports }, null, 2));
console.log(JSON.stringify({ reports }, null, 2));
