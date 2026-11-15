// 节点 TCPing 行内状态截图：成功 / 失败 / loading × 亮/暗 × 1440/390。
//
// 前置：一份 fresh DB 的 master 已启动，并已构建 web/dist：
//   PIERWAVE_ADDR=127.0.0.1:8799 PIERWAVE_DB=sqlite:///tmp/pierwave-tcping/db.sqlite?mode=rwc \
//   PIERWAVE_ADMIN_PASSWORD=devpass ./target/debug/pierwave-master
// 用法：node web/screenshots/node-tcping/shots.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8799";
const OUT = "preview-ui/node-tcping";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MASTER_PORT = Number(new URL(BASE).port);

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

async function seed() {
  const cookie = await login();
  const server = (
    await api(cookie, "/api/v1/servers", {
      name: "香港 · HKG",
      address: "127.0.0.1",
    })
  ).server;

  const nodes = [];
  for (const node of [
    {
      // 主控自己的 HTTP 端口肯定在监听：稳定拿到 reachable + 小延迟。
      name: "hk-reality",
      protocol: "vless",
      transport: "tcp",
      security: "reality",
      port: MASTER_PORT,
      region: "HK",
      tags: ["香港", "直连"],
      config: {},
    },
    {
      // 端口 1 上不会有服务：稳定拿到 Connection refused。
      name: "jp-ws",
      protocol: "trojan",
      transport: "ws",
      security: "none",
      port: 1,
      region: "JP",
      tags: ["日本"],
      config: {},
    },
    {
      name: "sg-trojan",
      protocol: "trojan",
      transport: "tcp",
      security: "none",
      port: 1,
      region: "SG",
      tags: ["新加坡"],
      config: {},
    },
  ]) {
    const created = await api(
      cookie,
      `/api/v1/servers/${server.id}/nodes`,
      node,
    );
    nodes.push(created.node);
  }
  return { cookie, server, nodes };
}

const { cookie, server, nodes } = await seed();
const [successNode, failureNode, loadingNode] = nodes;
assert(Boolean(successNode && failureNode && loadingNode), "seed 3 nodes");

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
});

async function capture({ theme, width, height }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    locale: "zh-CN",
  });
  await context.addInitScript(
    ({ theme }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", "zh-CN");
    },
    { theme },
  );
  const [name, value] = cookie.split("=");
  await context.addCookies([
    { name, value, url: `${BASE}/`, httpOnly: true, sameSite: "Lax" },
  ]);
  // 让第三条（loading）的探测一直挂起，截图时按钮保持 spinner。
  await context.route(
    `**/api/v1/nodes/${loadingNode.id}/tcping`,
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      await route.continue();
    },
  );

  const page = await context.newPage();
  async function waitForRowText(row, matches, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const text = await row.innerText();
      if (matches(text)) return text;
      await page.waitForTimeout(100);
    }
    throw new Error(`row text did not match in ${timeout}ms`);
  }
  await page.goto(`${BASE}/servers/${server.id}/nodes`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("row").filter({ hasText: "hk-reality" }).waitFor();
  await page.waitForTimeout(250);

  const successRow = page.getByRole("row").filter({ hasText: "hk-reality" });
  const probeSuccess = successRow.getByRole("button", {
    name: "探测节点 hk-reality 的可达性",
  });
  await probeSuccess.click();
  const successText = await waitForRowText(successRow, (text) => /\d+ ms/.test(text));
  assert(/\d+ ms/.test(successText), `${theme}-${width}: success 文案存在`);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);

  const failureRow = page.getByRole("row").filter({ hasText: "jp-ws" });
  const probeFailure = failureRow.getByRole("button", {
    name: "探测节点 jp-ws 的可达性",
  });
  await probeFailure.click();
  const failureText = await waitForRowText(failureRow, (text) =>
    text.includes("不可达"),
  );
  assert(failureText.includes("不可达"), `${theme}-${width}: failure 文案存在`);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);

  const loadingRow = page.getByRole("row").filter({ hasText: "sg-trojan" });
  const probeLoading = loadingRow.getByRole("button", {
    name: "探测节点 sg-trojan 的可达性",
  });
  await probeLoading.click();
  await loadingRow
    .locator('button[aria-busy="true"]')
    .waitFor({ timeout: 5_000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);

  // 截图前再断言一次三种状态都还在，避免拍了张空列表。
  assert(
    /\d+ ms/.test(await successRow.innerText()),
    `${theme}-${width}: success 状态仍在`,
  );
  assert(
    (await failureRow.innerText()).includes("不可达"),
    `${theme}-${width}: failure 状态仍在`,
  );
  assert(
    (await loadingRow.locator('button[aria-busy="true"]').count()) > 0,
    `${theme}-${width}: loading 状态仍在`,
  );

  const file = `${OUT}/node-tcping-${theme}-${width}.png`;
  await page.screenshot({ path: file, fullPage: false });
  console.log(`saved ${file}`);
  await context.close();
}

for (const theme of ["light", "dark"]) {
  for (const width of [1440, 390]) {
    await capture({ theme, width, height: width === 390 ? 900 : 900 });
  }
}

await browser.close();
