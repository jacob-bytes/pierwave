// W1–W5 改前 / 改后截图与几何实测。
//
// 用法 / Usage:
//   PHASE=before BASE=http://127.0.0.1:8798 node web/screenshots/w1-w5/shots.mjs
//   PHASE=after  BASE=http://127.0.0.1:8798 node web/screenshots/w1-w5/shots.mjs
//
// 前置：master 已在 BASE 上启动（admin / devpass），数据由同目录 seed.mjs
// 写入；master 以「与种子不同的主密钥」启动时，设置页才会出现秘密恢复卡（W5）。
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const PHASE = process.env.PHASE ?? "before";
const BASE = process.env.BASE ?? "http://127.0.0.1:8798";
const OUT = `web/screenshots/w1-w5/${PHASE}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const LONG_NAME =
  "香港-亚太边缘入口-主节点-超长名称用于移动端截断验证";
const LONG_ADDRESS = "edge-hk-01.asia-southeast1.prod.example.internal";
const UPTIME_CASES = [
  { name: LONG_NAME, percent: 100 },
  { name: "东京-中转-备用入口", percent: 99 },
  { name: "新加坡-专线-长名称节点-二号", percent: 96 },
  { name: "洛杉矶-美洲-测试节点", percent: 88 },
  { name: "法兰克福-欧洲-备用节点", percent: 71 },
];

mkdirSync(OUT, { recursive: true });
const METRICS = { phase: PHASE, base: BASE };

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
  const [name, value] = cookie.split("=");
  return { name, value };
}

const cookie = await login();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function open({ theme, width, height = 900 }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    locale: "zh-CN",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.addCookies([
    {
      name: cookie.name,
      value: cookie.value,
      url: `${BASE}/`,
      httpOnly: true,
      sameSite: "Lax",
    },
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

async function geometry(page, key) {
  METRICS[key] = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("main");
    const tabs = [...document.querySelectorAll('[role="tablist"]')].map(
      (list) => ({
        aria: list.getAttribute("aria-label"),
        clientWidth: list.clientWidth,
        scrollWidth: list.scrollWidth,
        tabs: list.querySelectorAll('[role="tab"]').length,
      }),
    );
    return {
      viewportWidth: window.innerWidth,
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      mainScrollWidth: main?.scrollWidth ?? null,
      mainClientWidth: main?.clientWidth ?? null,
      overflowX:
        doc.scrollWidth > doc.clientWidth ||
        (main ? main.scrollWidth > main.clientWidth : false),
      scrollHeight: main?.scrollHeight ?? doc.scrollHeight,
      tablists: tabs,
    };
  });
  console.log(
    `${key}: viewport=${METRICS[key].viewportWidth} doc=${METRICS[key].docScrollWidth}/${METRICS[key].docClientWidth} main=${METRICS[key].mainScrollWidth}/${METRICS[key].mainClientWidth} overflow=${METRICS[key].overflowX} tabs=${JSON.stringify(METRICS[key].tablists)}`,
  );
}

async function shoot(page, name, { fullPage = false } = {}) {
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage });
  console.log(`saved ${file}`);
}

/** W1：公开状态页的三档可用率卡片 + 汇总平均可用率。 */
async function captureW1(theme, width) {
  const { context, page, errors } = await open({
    theme,
    width,
    height: width === 390 ? 844 : 900,
  });
  await page.goto(`${BASE}/status`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { level: 3, name: LONG_NAME }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await geometry(page, `W1_${theme}_${width}`);

  const cards = {};
  for (const { name } of UPTIME_CASES) {
    const card = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByRole("heading", { level: 3, name }) });
    cards[name] = await card.evaluate((element) => {
      const progress = element.querySelector(
        '[role="progressbar"][aria-label="24h 可用率"]',
      );
      const fill = progress?.querySelector("div");
      const percentText = element.querySelector(
        '[role="progressbar"][aria-label="24h 可用率"]',
      )?.parentElement?.querySelector(".tnum");
      return {
        text: percentText?.textContent?.trim() ?? null,
        color: percentText ? getComputedStyle(percentText).color : null,
        fillWidth: fill ? getComputedStyle(fill).width : null,
        fillClass: fill?.className ?? null,
        ariaValueNow: progress?.getAttribute("aria-valuenow") ?? null,
        cardWidth: element.getBoundingClientRect().width,
      };
    });
    if (width === 1440) {
      await card.screenshot({
        path: `${OUT}/w1-card-${name.slice(0, 2)}-${theme}-${width}.png`,
      });
    }
  }
  METRICS[`W1cards_${theme}_${width}`] = cards;

  // 汇总卡的「平均可用率」大号数字与脚注。
  const summary = page
    .locator('[data-slot="card"]')
    .filter({ hasText: "平均可用率" })
    .first();
  METRICS[`W1summary_${theme}_${width}`] = await summary.evaluate((element) => ({
    text: element.innerText,
  }));

  await shoot(page, `w1-status-${theme}-${width}`, {
    fullPage: width === 390,
  });
  if (errors.length) console.log(`W1 browser errors:`, errors);
  await context.close();
}

/** W2：概览「流量榜单 / 服务器」卡片的行密度。 */
async function captureW2(theme, width) {
  const { context, page, errors } = await open({
    theme,
    width,
    height: width === 390 ? 844 : 900,
  });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByText("流量榜单").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await geometry(page, `W2_${theme}_${width}`);

  const card = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("流量榜单") })
    .first();
  await card.waitFor();
  const rows = card.locator("ul > li");
  METRICS[`W2rows_${theme}_${width}`] = await rows.evaluateAll((items) =>
    items.map((item) => {
      const rect = item.getBoundingClientRect();
      const link = item.querySelector("a");
      return {
        text: item.innerText.replace(/\n/g, " | "),
        height: Math.round(rect.height * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        linkClientWidth: link?.clientWidth ?? null,
        linkScrollWidth: link?.scrollWidth ?? null,
        wrapped: (link ? link.scrollWidth > link.clientWidth : false)
          ? true
          : false,
      };
    }),
  );
  await shoot(page, `w2-overview-${theme}-${width}`, { fullPage: false });
  await card.screenshot({ path: `${OUT}/w2-board-${theme}-${width}.png` });

  if (width === 390 && PHASE === "after") {
    const first = rows.first();
    const links = await first.locator("a").count();
    assert(links === 1, "390 榜单行仍是一个可点击链接");
    await first.locator("a").click();
    await page.waitForURL("**/servers", { timeout: 10_000 });
    assert(new URL(page.url()).pathname === "/servers", "点击榜单行跳到服务器页");
  }
  if (errors.length) console.log(`W2 browser errors:`, errors);
  await context.close();
}

/** W3：服务器移动端卡片的长名称 / 地址复制。 */
async function captureW3(theme, width) {
  const { context, page, errors } = await open({
    theme,
    width,
    height: 844,
  });
  await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
  await page
    .locator('[data-slot="mobile-data-card"]')
    .filter({ hasText: LONG_NAME })
    .first()
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await geometry(page, `W3_${theme}_${width}`);

  const card = page
    .locator('[data-slot="mobile-data-card"]')
    .filter({ hasText: LONG_NAME })
    .first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  METRICS[`W3card_${theme}_${width}`] = await card.evaluate((element) => {
    const title = element.querySelector("div.truncate");
    return {
      text: element.innerText.replace(/\n/g, " | "),
      title: title?.getAttribute("title") ?? null,
      titleTruncated: title ? title.scrollWidth > title.clientWidth : null,
      copyButtons: element.querySelectorAll('button[aria-label*="复制"]').length,
    };
  });
  await shoot(page, `w3-servers-${theme}-${width}`);

  if (PHASE === "after") {
    const copyName = card.getByRole("button", {
      name: `复制 ${LONG_NAME}`,
      exact: true,
    });
    assert((await copyName.count()) > 0, "移动端卡片有名称复制按钮");
    await copyName.first().click();
    await page.locator("[data-sonner-toast]").waitFor({ timeout: 5_000 });
    await page.waitForTimeout(100);
    const toast = await page.locator("[data-sonner-toast]").first().innerText();
    METRICS[`W3toast_${theme}_${width}`] = toast;
    assert(toast.includes("已复制"), "复制成功 toast 出现");
    await shoot(page, `w3-copied-${theme}-${width}`);
    const copyAddress = card.getByRole("button", {
      name: `复制 ${LONG_ADDRESS}`,
      exact: true,
    });
    assert((await copyAddress.count()) > 0, "移动端卡片有地址复制按钮");
  }
  if (errors.length) console.log(`W3 browser errors:`, errors);
  await context.close();
}

/** W4：操作审计的分类筛选条。 */
async function captureW4(theme, width) {
  const { context, page, errors } = await open({
    theme,
    width,
    height: width === 390 ? 844 : 900,
  });
  await page.goto(`${BASE}/logs?tab=audit`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "全部", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await geometry(page, `W4_${theme}_${width}`);

  const list = page.getByRole("tablist").filter({ hasText: "全部" }).first();
  METRICS[`W4tabs_${theme}_${width}`] = await list.evaluate((element) => ({
    labels: [...element.querySelectorAll('[role="tab"]')].map((tab) =>
      tab.textContent.trim(),
    ),
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clipped: element.scrollWidth > element.clientWidth,
  }));
  await shoot(page, `w4-audit-${theme}-${width}`, { fullPage: false });

  if (width === 390 && PHASE === "after") {
    assert(
      METRICS[`W4tabs_${theme}_${width}`].labels.length === 5,
      `390 分类只有 5 个（实际 ${METRICS[`W4tabs_${theme}_${width}`].labels.length}）`,
    );
    assert(
      !METRICS[`W4_${theme}_${width}`].overflowX,
      "390 审计页没有横向溢出",
    );
    // 搜索与对象筛选仍在。
    assert(
      (await page.getByPlaceholder("搜索操作者").count()) > 0,
      "操作者搜索仍在",
    );
    assert(
      (await page.getByPlaceholder("搜索对象").count()) > 0,
      "对象筛选仍在",
    );
  }
  if (errors.length) console.log(`W4 browser errors:`, errors);
  await context.close();
}

/** W5：设置页秘密恢复卡里的 hmac_secret_v1 指引。 */
async function captureW5(theme, width) {
  const { context, page, errors } = await open({
    theme,
    width,
    height: width === 390 ? 844 : 900,
  });
  await page.goto(`${BASE}/settings?tab=general`, { waitUntil: "networkidle" });
  await page
    .locator('[data-slot="settings-secret-recovery"]')
    .waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await geometry(page, `W5_${theme}_${width}`);

  const card = page.locator('[data-slot="settings-secret-recovery"]');
  METRICS[`W5card_${theme}_${width}`] = await card.evaluate((element) => {
    const links = [...element.querySelectorAll("a")].map((link) => ({
      text: link.textContent?.trim() ?? "",
      href: link.getAttribute("href") ?? "",
    }));
    return {
      text: element.innerText,
      links,
      buttons: [...element.querySelectorAll("button")].map((button) =>
        button.textContent?.trim() ?? "",
      ),
      height: element.getBoundingClientRect().height,
    };
  });
  await shoot(page, `w5-settings-${theme}-${width}`, { fullPage: false });

  if (PHASE === "after") {
    const text = METRICS[`W5card_${theme}_${width}`].text;
    assert(text.includes("订阅派生 secret"), "恢复卡显示订阅派生 secret");
    assert(
      text.includes("重新获取订阅链接"),
      "说明所有客户端需重新获取订阅链接",
    );
    assert(text.includes("secret.key"), "给出恢复 secret.key 的下一步");
    assert(
      METRICS[`W5card_${theme}_${width}`].links.some((link) =>
        link.href.includes("BACKUP_ENCRYPTION.md"),
      ),
      "提供备份加密文档链接",
    );
    assert(
      !METRICS[`W5card_${theme}_${width}`].buttons.some((label) =>
        label.includes("重新生成"),
      ),
      "后端没有重新生成接口时不伪造按钮",
    );
  }
  if (errors.length) console.log(`W5 browser errors:`, errors);
  await context.close();
}

for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    await captureW1(theme, width);
    await captureW2(theme, width);
    if (width === 390) await captureW3(theme, width);
    await captureW4(theme, width);
    await captureW5(theme, width);
  }
}

writeFileSync(`${OUT}/metrics.json`, JSON.stringify(METRICS, null, 2));
console.log(`metrics -> ${OUT}/metrics.json`);
await browser.close();
