// W6：受管文件应用结果（partial / failed / ok / null）截图与断言。
//
// 用法 / Usage:
//   PHASE=before BASE=http://127.0.0.1:8798 node web/screenshots/w6-apply/shots.mjs
//   PHASE=after  BASE=http://127.0.0.1:8798 node web/screenshots/w6-apply/shots.mjs
//
// 前置：master 已启动（admin / devpass），DB 中至少有一台 partial、一台 failed、
// 一台 ok、一台 null；见 README 的 SQL。
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const PHASE = process.env.PHASE ?? "after";
const BASE = process.env.BASE ?? "http://127.0.0.1:8798";
const OUT = `web/screenshots/w6-apply/${PHASE}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PARTIAL_NAME = "香港-亚太边缘入口-主节点-超长名称用于移动端截断验证";
const FAILED_NAME = "东京-中转-备用入口";
const OK_NAME = "新加坡-专线-长名称节点-二号";
const NULL_NAME = "洛杉矶-美洲-测试节点";

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
    };
  });
  console.log(
    `${key}: viewport=${METRICS[key].viewportWidth} doc=${METRICS[key].docScrollWidth}/${METRICS[key].docClientWidth} main=${METRICS[key].mainScrollWidth}/${METRICS[key].mainClientWidth} overflow=${METRICS[key].overflowX}`,
  );
}

async function shoot(page, name, { fullPage = false } = {}) {
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage });
  console.log(`saved ${file}`);
}

async function cardFor(page, name) {
  return page
    .locator('[data-slot="mobile-data-card"]')
    .filter({ hasText: name })
    .first();
}

async function rowFor(page, name) {
  return page.getByRole("row").filter({ hasText: name }).first();
}

async function captureDesktop(theme) {
  const { context, page, errors } = await open({ theme, width: 1440 });
  await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
  await page.getByRole("row").filter({ hasText: PARTIAL_NAME }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await geometry(page, `W6_desktop_${theme}`);

  const rows = page.locator("tbody tr");
  METRICS[`W6rows_${theme}`] = await rows.evaluateAll((items) =>
    items.map((item) => ({
      text: item.innerText.replace(/\n/g, " | "),
      height: Math.round(item.getBoundingClientRect().height * 100) / 100,
      applyButtons: item.querySelectorAll('[data-slot="apply-status"]').length,
      statusCell: item.querySelector("td:nth-child(5)")?.innerText.trim(),
    })),
  );
  await shoot(page, `w6-servers-${theme}-1440`);

  if (PHASE === "after") {
    const partialRow = await rowFor(page, PARTIAL_NAME);
    const partialBadge = partialRow.locator('[data-slot="apply-status"]');
    assert((await partialBadge.count()) === 1, "partial 行有应用结果徽标");
    assert(
      (await partialBadge.innerText()).includes("部分应用（2/3）"),
      "partial 徽标显示 2/3",
    );
    // 徽标不在在线/离线状态列：状态列仍是单一的在线/离线。
    assert(
      (await partialRow.locator("td:nth-child(5)").innerText()).includes("在线"),
      "状态列仍只表达在线/离线",
    );
    await partialBadge.click();
    const popover = page
      .locator('[data-slot="popover-content"]')
      .filter({ hasText: "提交 rename / commit" })
      .first();
    await popover.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(300);
    const text = await popover.innerText();
    METRICS[`W6partial_${theme}`] = text;
    assert(text.includes("提交 rename / commit"), "partial 展示 stage");
    assert(text.includes("/etc/pierwave/xray/server.crt"), "partial 展示生效路径");
    assert(text.includes("/etc/pierwave/xray/server.key"), "partial 展示全部生效路径");
    await shoot(page, `w6-partial-popover-${theme}-1440`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    const failedRow = await rowFor(page, FAILED_NAME);
    const failedBadge = failedRow.locator('[data-slot="apply-status"]');
    assert((await failedBadge.count()) === 1, "failed 行有应用失败徽标");
    assert(
      (await failedBadge.innerText()).includes("应用失败"),
      "failed 徽标显示应用失败",
    );
    await failedBadge.click();
    const failedPopover = page
      .locator('[data-slot="popover-content"]')
      .filter({ hasText: "dial master: connection refused" })
      .first();
    await failedPopover.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(300);
    const failedText = await failedPopover.innerText();
    METRICS[`W6failed_${theme}`] = failedText;
    assert(
      failedText.includes("dial master: connection refused"),
      "failed 原样展示 apply_error",
    );
    await shoot(page, `w6-failed-popover-${theme}-1440`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    // ok / null 不制造噪点。
    assert(
      (await (await rowFor(page, OK_NAME)).locator('[data-slot="apply-status"]').count()) === 0,
      "ok 行不显示应用徽标",
    );
    assert(
      (await (await rowFor(page, NULL_NAME)).locator('[data-slot="apply-status"]').count()) === 0,
      "null 行不显示应用徽标",
    );
  }
  if (errors.length) console.log(`W6 desktop browser errors:`, errors);
  await context.close();
}

async function captureMobile(theme) {
  const { context, page, errors } = await open({ theme, width: 390, height: 844 });
  await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
  const card = await cardFor(page, PARTIAL_NAME);
  await card.waitFor();
  await page.evaluate(() => document.fonts.ready);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await geometry(page, `W6_mobile_${theme}`);

  METRICS[`W6card_${theme}`] = await card.evaluate((element) => {
    const title = element.querySelector('[data-slot="mobile-data-card"] > div div.truncate');
    return {
      text: element.innerText.replace(/\n/g, " | "),
      applyButtons: element.querySelectorAll('[data-slot="apply-status"]').length,
      titleWidth: title?.getBoundingClientRect().width ?? null,
      titleScrollWidth: title?.scrollWidth ?? null,
    };
  });
  await shoot(page, `w6-servers-${theme}-390`);

  if (PHASE === "after") {
    const badge = card.locator('[data-slot="apply-status"]');
    assert((await badge.count()) === 1, "390 卡片把应用徽标收进详情字段");
    assert(
      METRICS[`W6card_${theme}`].titleWidth ===
        METRICS[`W6card_${theme}`].titleWidth,
      "名称列宽可测量",
    );
    await badge.click();
    const popover = page
      .locator('[data-slot="popover-content"]')
      .filter({ hasText: "提交 rename / commit" })
      .first();
    await popover.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(300);
    assert(
      (await popover.innerText()).includes("提交 rename / commit"),
      "390 徽标可展开 stage",
    );
    await shoot(page, `w6-partial-popover-${theme}-390`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    // 详情 popover：partial 的 stage / 路径也在这里。
    await card.getByRole("button", { name: /详情/ }).click();
    const detail = page
      .locator('[data-slot="popover-content"]')
      .filter({ hasText: "应用结果" })
      .first();
    await detail.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(300);
    const detailText = await detail.innerText();
    METRICS[`W6detail_${theme}`] = detailText;
    assert(detailText.includes("应用结果"), "详情里有应用结果段");
    assert(detailText.includes("提交 rename / commit"), "详情展示 stage");
    assert(detailText.includes("/etc/pierwave/xray/server.key"), "详情展示生效路径");
    await shoot(page, `w6-detail-${theme}-390`);
  }
  if (errors.length) console.log(`W6 mobile browser errors:`, errors);
  await context.close();
}

for (const theme of ["dark", "light"]) {
  await captureDesktop(theme);
  await captureMobile(theme);
}

writeFileSync(`${OUT}/metrics.json`, JSON.stringify(METRICS, null, 2));
console.log(`metrics -> ${OUT}/metrics.json`);
await browser.close();
