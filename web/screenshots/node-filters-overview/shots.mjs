// 节点列表服务端筛选 + 概览新卡截图。
//
// 前置：一份 fresh DB 的 master 已启动（web/dist 已构建），例如：
//   PIERWAVE_ADDR=127.0.0.1:8797 \
//   PIERWAVE_DB='sqlite:///tmp/pierwave-ui-task/db.sqlite?mode=rwc' \
//   PIERWAVE_ADMIN_PASSWORD=devpass ./target/debug/pierwave-master
// 用法：BASE=http://127.0.0.1:8797 DB_PATH=/tmp/pierwave-ui-task/db.sqlite \
//   node web/screenshots/node-filters-overview/shots.mjs
//
// 脚本会通过 API 造 60 个节点 / 5 个用户 / 4 个套餐，再直接写两张流量日表，
// 让「节点流量 Top 5」与「套餐用量分布」有真实数据；重复运行前请重建 DB。
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8797";
const DB_PATH = process.env.DB_PATH ?? "/tmp/pierwave-ui-task/db.sqlite";
const OUT = "web/screenshots/node-filters-overview";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NODE_PAGE_SIZE = 50;
const HK_NODES = 60;
const JP_NODES = 20;
// 55 个 HK 标签节点：筛选后 2 页，能同时展示「总数」与分页控件。
const HK_TAGGED = 55;

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
    const tags = hk
      ? index < HK_TAGGED
        ? ["hk", "direct"]
        : ["jp"]
      : index % 2 === 0
        ? ["jp"]
        : ["jp", "direct"];
    const node = (
      await api(cookie, `/api/v1/servers/${servers[hk ? "hk" : "jp"].id}/nodes`, {
        name: `${hk ? "香港" : "日本"}-${String(index + 1).padStart(2, "0")}`,
        tag: `node-${index + 1}`,
        protocol: ["vless", "trojan", "vmess"][index % 3],
        transport: "tcp",
        security: "none",
        port: 10000 + index,
        enabled: index % 11 !== 0,
        tags,
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

  // 每张卡至少一个用户；alice 先月卡后季卡，验证「只归当前套餐」。
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
  await api(cookie, `/api/v1/users/${users.alice.id}/packages`, {
    package_id: packages.quarter.id,
  });

  return { servers, nodes, users, packages };
}

function seedTraffic(seeded) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  // 前 7 个节点造递减流量：Top 5 有 5 条，第 6/7 名被截断。
  const nodeRows = seeded.nodes.slice(0, 7).map((node, index) => ({
    day: today,
    server_id: node.server_id,
    node_tag: node.tag,
    user_id: "",
    bytes: (7 - index) * 900 * 1024 ** 2,
  }));
  // 同一节点再补一条用户切片：验证按 (server_id, node_tag) 合并，而不是只取一行。
  nodeRows.push({
    day: today,
    server_id: seeded.nodes[0].server_id,
    node_tag: seeded.nodes[0].tag,
    user_id: seeded.users.alice.id,
    bytes: 100 * 1024 ** 2,
  });

  const userRows = [
    ["alice", 18 * 1024 ** 3],
    ["bob", 42 * 1024 ** 3],
    ["carol", 30 * 1024 ** 3],
    ["dave", 12 * 1024 ** 3],
    ["erin", 3 * 1024 ** 3],
  ].map(([username, bytes]) => ({
    day: today,
    server_id: seeded.servers.hk.id,
    subject: seeded.users[username].id,
    bytes,
  }));

  const script = `
import json, sqlite3, sys
data = json.load(sys.stdin)
conn = sqlite3.connect(sys.argv[1])
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
conn.commit()
print("seeded", len(data["node_rows"]), len(data["user_rows"]))
`;
  execFileSync("python3", ["-c", script, DB_PATH], {
    input: JSON.stringify({ node_rows: nodeRows, user_rows: userRows }),
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

/** 把 <main> 的高度撑满视口后再截全页（概览页的滚动容器是 main）。 */
async function contentHeight(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    return main ? main.scrollHeight : document.documentElement.scrollHeight;
  });
}

const cookie = await login();
const seeded = await seed(cookie);
const today = seedTraffic(seeded);
assert(today.length === 10, `流量日=${today}`);

const hk = seeded.servers.hk;
const filteredTotal = HK_TAGGED;
assert(filteredTotal > NODE_PAGE_SIZE, "筛选结果超过一页，分页控件可见");

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const reports = [];

for (const theme of ["light", "dark"]) {
  for (const width of [1440, 390]) {
    const height = width === 1440 ? 1000 : 844;
    const { context, page, errors } = await capture(browser, cookie, {
      theme,
      width,
      height,
    });

    // ---- 节点列表：URL 筛选 + 总数 + 分页 ----
    const nodesUrl = `${BASE}/servers/${hk.id}/nodes?tag=hk`;
    await page.goto(nodesUrl, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: /节点/ }).first().waitFor();
    await page
      .getByRole("textbox", { name: "按标签筛选" })
      .waitFor();
    await page.waitForFunction(
      (expected) => {
        const badges = [...document.querySelectorAll("main [data-slot='badge']")];
        return badges.some((badge) => badge.textContent?.trim() === String(expected));
      },
      filteredTotal,
      { timeout: 10_000 },
    );
    const rows = await page.getByRole("row").count();
    assert(rows >= 2, `${theme}/${width} 筛选后的表格有数据（rows=${rows}）`);
    const badge = await page
      .locator("main [data-slot='badge']")
      .filter({ hasText: /^\d+$/ })
      .first()
      .innerText();
    assert(Number(badge.trim()) === filteredTotal, `总数 badge=${badge.trim()}`);
    const footer = await page
      .getByText(/第 \d+–\d+ 条，共 \d+ 条/)
      .first()
      .innerText();
    assert(footer.includes(`共 ${filteredTotal} 条`), `分页脚注：${footer}`);
    const tagInput = page.getByRole("textbox", { name: "按标签筛选" });
    assert((await tagInput.inputValue()) === "hk", "筛选输入框来自 URL");

    let h = await contentHeight(page);
    await page.waitForTimeout(350);
    // 列表本身很长（50 行），截视口而不是整页：筛选框、总数与页码都在首屏。
    const nodesFile = `${OUT}/nodes-filter-${theme}-${width}.png`;
    await page.screenshot({ path: nodesFile, fullPage: false });

    // 翻到第 2 页：验证服务端分页后 URL、页码与区间一起更新。
    await page.getByRole("button", { name: "下一页" }).click();
    await page.waitForFunction(
      () => window.location.search.includes("page=2"),
      undefined,
      { timeout: 5_000 },
    );
    await page
      .getByText(/第 51–55 条，共 55 条/)
      .first()
      .waitFor();
    const page2Footer = await page
      .getByText(/第 51–55 条，共 55 条/)
      .first()
      .innerText();
    const pageStatus = await page
      .getByText(/第 2 \/ 2 页/)
      .first()
      .innerText();
    assert(pageStatus.includes("2 / 2"), `第 2 页状态：${pageStatus}`);
    if (width === 1440) {
      // 窄屏翻页后停在页面底部，截图意义不大；桌面端补一张第 2 页证据。
      await page.evaluate(() => {
        document.querySelector("main")?.scrollTo(0, 0);
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(200);
      const page2File = `${OUT}/nodes-page2-${theme}-${width}.png`;
      await page.screenshot({ path: page2File, fullPage: false });
      reports.push({
        file: page2File,
        page: "nodes?tag=hk&page=2",
        viewport: `${width}x${height}`,
        total: filteredTotal,
        page2Footer,
        pageStatus,
      });
    }
    reports.push({
      file: nodesFile,
      page: "nodes?tag=hk",
      viewport: `${width}x${height}`,
      contentHeight: h,
      rows,
      total: filteredTotal,
      footer,
      errors,
    });
    await context.close();

    // ---- 概览：两张新卡 ----
    const second = await capture(browser, cookie, { theme, width, height });
    const overview = second.page;
    await overview.goto(`${BASE}/overview`, { waitUntil: "networkidle" });
    await overview.getByText("节点流量 Top 5").first().waitFor();
    await overview.getByText("套餐用量分布").first().waitFor();
    await overview.getByText("季卡").first().waitFor();
    await overview.waitForTimeout(700);

    const overviewHeight = await contentHeight(overview);
    const viewportScreens = +(
      overviewHeight /
      (height - 56)
    ).toFixed(2);
    // 桌面端要求 ≤2 屏；移动端按需求单列堆叠，不做同样的高度约束。
    if (width === 1440) {
      assert(
        viewportScreens <= 2,
        `${theme}/${width} 概览高度 ${overviewHeight}px = ${viewportScreens} 屏（≤2）`,
      );
    }
    console.log(
      `ok - ${theme}/${width} 概览高度 ${overviewHeight}px = ${viewportScreens} 屏`,
    );

    // 两张新卡的 section：按标题定位到其父 section。
    const cards = overview
      .locator("section")
      .filter({ hasText: "节点流量 Top 5" })
      .first();
    const cardMetrics = await cards.evaluate((element) => ({
      height: Math.round(element.getBoundingClientRect().height),
      width: Math.round(element.getBoundingClientRect().width),
    }));
    await overview.setViewportSize({
      width,
      height: overviewHeight + 56,
    });
    await overview.waitForTimeout(350);
    const overviewFile = `${OUT}/overview-${theme}-${width}.png`;
    await overview.screenshot({ path: overviewFile, fullPage: true });
    const cardsFile = `${OUT}/overview-cards-${theme}-${width}.png`;
    await cards.screenshot({ path: cardsFile });
    reports.push({
      file: overviewFile,
      cardsFile,
      page: "overview",
      viewport: `${width}x${height}`,
      contentHeight: overviewHeight,
      screensAtViewport: viewportScreens,
      section: cardMetrics,
      errors: second.errors,
    });
    await second.context.close();
  }
}

await browser.close();
console.log(JSON.stringify({ reports }, null, 2));
