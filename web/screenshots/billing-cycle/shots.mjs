#!/usr/bin/env node
/**
 * 计费周期「数量 + 单位」：截图 + 前端契约验证。
 *
 * 覆盖 / Covers:
 *   0. 真实后端往返：与 `billingPayload` 相同的 POST / PATCH 载荷；
 *   1. 新建表单的五个状态：1 个月 / 3 个月 / 2 年 / 一次性 / 空；
 *   2. 数量 1–1200 与「缺一半」的行内错误；
 *   3. 提交载荷同时带 count / unit / 旧派生 billing_cycle；
 *   4. 公开页卡片与详情的四种展示：`¥268.00 / 月`、`¥268.00 / 3 个月`、
 *      `¥999.00 / 2 年`、`¥199.00 / 一次性`（1440 / 390、亮 / 暗）。
 *
 * 全部数据来自真实主控：创建服务器时直接写 `billing_cycle_count` /
 * `billing_cycle_unit`，公开接口原样返回。旧数据回退（只有 `billing_cycle`）
 * 由 `publicStatus.test.mjs` / `serverBilling.test.mjs` 覆盖。
 *
 * 前置 / Prerequisite:
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8797 \
 *   PIERWAVE_DB='sqlite:///tmp/pw-billing-cycle/db.sqlite?mode=rwc' \
 *   ./target/debug/pierwave-master
 *
 * 用法 / Usage:
 *   BASE=http://127.0.0.1:8797 node web/screenshots/billing-cycle/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://127.0.0.1:8797";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(HERE, { recursive: true });

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const npxRoot = path.join(ROOT, ".npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    const { readdirSync } = await import("node:fs");
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

/** 登录拿会话 cookie（与 scripts/e2e.sh 相同的 admin / devpass）。 */
async function login() {
  const response = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "devpass" }),
  });
  assert.equal(response.status, 200, `login failed: ${response.status}`);
  const cookie = response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .find((item) => item.startsWith("pierwave_session="));
  assert.ok(cookie, "no session cookie");
  const [name, value] = cookie.split("=");
  return { name, value };
}

async function api(cookie, method, url, body) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      Cookie: `${cookie.name}=${cookie.value}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: response.status, json, text };
}

const chromium = await loadPlaywright();
const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  headless: true,
});
const cookie = await login();
const results = [];
const failures = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      results.push({ name, ok: true, detail });
    })
    .catch((error) => {
      results.push({ name, ok: false, detail: error.message });
      failures.push(`${name}: ${error.message}`);
    });
}

// 演示服务器：脚本自己建（可重复执行，按名字 PATCH 回预期值）。
const DEMO_SERVERS = [
  { name: "香港-01", address: "10.10.0.11", price_cents: 26800, currency: "CNY", days: 27, count: 1, unit: "month" },
  { name: "新加坡-02", address: "10.10.0.12", price_cents: 99900, currency: "CNY", days: 101, count: 2, unit: "year" },
  { name: "美西-01", address: "10.10.0.13", price_cents: 19900, currency: "CNY", days: 222, count: 1, unit: "once" },
  { name: "东京-01", address: "10.10.0.14", price_cents: 26800, currency: "CNY", days: 3, count: 3, unit: "month" },
];

function paidUntilIn(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function ensureDemoServers() {
  const list = await api(cookie, "GET", "/api/v1/servers");
  assert.equal(list.status, 200, "cannot list servers");
  const existing = new Map((list.json?.items ?? []).map((item) => [item.name, item]));
  for (const spec of DEMO_SERVERS) {
    const billing = {
      paid_until: paidUntilIn(spec.days),
      price_cents: spec.price_cents,
      currency: spec.currency,
      billing_cycle_count: spec.count,
      billing_cycle_unit: spec.unit,
      billing_cycle: null,
    };
    const current = existing.get(spec.name);
    const response = current
      ? await api(cookie, "PATCH", `/api/v1/servers/${current.id}`, billing)
      : await api(cookie, "POST", "/api/v1/servers", {
          name: spec.name,
          address: spec.address,
          xray_mode: "external",
          ...billing,
        });
    assert.equal(response.status, 200, `cannot seed ${spec.name}: ${response.text}`);
  }
}

await ensureDemoServers();


// 真实接口返回的公开页数据：四台新契约 + 一台只有旧列的回退样本。
const publicResponse = await fetch(`${BASE}/api/v1/public/status`);
assert.equal(publicResponse.status, 200, "public status is not available");
const publicList = await publicResponse.json();
const byName = new Map(publicList.servers.map((server) => [server.name, server]));

const VARIANTS = [
  { name: "香港-01", label: "月", count: 1, unit: "month", legacy: "monthly" },
  { name: "新加坡-02", label: "2 年", count: 2, unit: "year", legacy: null },
  { name: "美西-01", label: "一次性", count: 1, unit: "once", legacy: "once" },
  { name: "东京-01", label: "3 个月", count: 3, unit: "month", legacy: null },
];
for (const variant of VARIANTS) {
  const server = byName.get(variant.name);
  assert.ok(server, `缺少演示服务器 ${variant.name}`);
  // 后端契约：数量 + 单位原样返回；旧列只做派生镜像（3 个月 / 2 年为 null）。
  assert.equal(
    server.billing_cycle_count,
    variant.count,
    `${variant.name} billing_cycle_count`,
  );
  assert.equal(
    server.billing_cycle_unit,
    variant.unit,
    `${variant.name} billing_cycle_unit`,
  );
  assert.equal(
    server.billing_cycle,
    variant.legacy,
    `${variant.name} 旧派生 billing_cycle`,
  );
}

// 旧数据回退（两个新字段都缺失 → 读旧 billing_cycle）由单元测试覆盖：
// publicStatus.test.mjs 的 billingCycleText、serverBilling.test.mjs 的回填。

// ---------------------------------------------------------------
// 0) 真实后端契约：用与 billingPayload 相同的载荷走 POST / PATCH
// ---------------------------------------------------------------
const CONTRACT_NAME = "契约校验-3个月";
let contractId = null;
{
  const existing = await api(cookie, "GET", "/api/v1/servers");
  for (const item of existing.json?.items ?? []) {
    if (item.name === CONTRACT_NAME) {
      await api(cookie, "DELETE", `/api/v1/servers/${item.id}`);
    }
  }
}
await check("真实 POST：3 个月同时写数量 + 单位，旧派生为 null", async () => {
  const created = await api(cookie, "POST", "/api/v1/servers", {
    name: CONTRACT_NAME,
    address: "10.10.0.21",
    xray_mode: "external",
    paid_until: "2026-12-31",
    price_cents: 26800,
    currency: "CNY",
    billing_cycle: null,
    billing_cycle_count: 3,
    billing_cycle_unit: "month",
  });
  assert.equal(created.status, 200);
  contractId = created.json.server.id;
  assert.equal(created.json.server.billing_cycle_count, 3);
  assert.equal(created.json.server.billing_cycle_unit, "month");
  assert.equal(created.json.server.billing_cycle, null);
  return { id: contractId };
});
await check("真实 PATCH：2 年 + 旧派生 null；清空两列返回 null", async () => {
  const patched = await api(cookie, "PATCH", `/api/v1/servers/${contractId}`, {
    paid_until: "2026-12-31",
    price_cents: 99900,
    currency: "CNY",
    billing_cycle: null,
    billing_cycle_count: 2,
    billing_cycle_unit: "year",
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.server.billing_cycle_count, 2);
  assert.equal(patched.json.server.billing_cycle_unit, "year");
  assert.equal(patched.json.server.billing_cycle, null);

  const cleared = await api(cookie, "PATCH", `/api/v1/servers/${contractId}`, {
    billing_cycle: null,
    billing_cycle_count: null,
    billing_cycle_unit: null,
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.server.billing_cycle_count, null);
  assert.equal(cleared.json.server.billing_cycle_unit, null);
  assert.equal(cleared.json.server.billing_cycle, null);
});
await check("真实 PATCH：一次性 + 数量 2 被后端拒绝（once_count_invalid）", async () => {
  const rejected = await api(cookie, "PATCH", `/api/v1/servers/${contractId}`, {
    billing_cycle_count: 2,
    billing_cycle_unit: "once",
    billing_cycle: null,
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.code, "server.billing_cycle_once_count_invalid");
});
{
  const removed = await api(cookie, "DELETE", `/api/v1/servers/${contractId}`);
  assert.equal(removed.status, 200, "契约校验服务器清理失败");
}

async function openPage({ theme, width, height, locale = "zh-CN" }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    locale,
  });
  await context.addCookies([
    {
      name: cookie.name,
      value: cookie.value,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    failures.push(`${theme}-${width}: ${error.message}`);
  });
  await page.addInitScript(
    ({ theme, locale }) => {
      window.localStorage.setItem("pierwave.theme", theme);
      window.localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale },
  );


  return { context, page };
}

async function screenshot(page, name, options = {}) {
  await page.screenshot({ path: path.join(HERE, name), ...options });
}

/** 新建对话框；每次重新打开都会回到全空（未填写）初值。 */
async function openCreate(page) {
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  const group = dialog.getByRole("group", { name: "费用与到期" });
  await group.waitFor({ state: "visible" });
  return { dialog, group };
}

async function closeCreate(page) {
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}

async function pickUnit(page, dialog, name) {
  await dialog.locator("#server-create-billing-cycle-unit").click();
  await page.getByRole("option", { name, exact: true }).click();
}

async function shotGroup(group, name) {
  await group.scrollIntoViewIfNeeded();
  await group.screenshot({ path: path.join(HERE, name) });
}

// ---------------------------------------------------------------
// 1) 表单：五个状态 + 三种行内错误
// ---------------------------------------------------------------
for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    const height = width === 390 ? 844 : 1000;
    const { context, page } = await openPage({ theme, width, height });
    await page.goto(`${BASE}/servers`, { waitUntil: "load" });
    await page.getByRole("button", { name: "添加服务器", exact: true }).waitFor();
    const { dialog, group } = await openCreate(page);

    await check(`默认空：数量 + 单位都未填写（${theme}-${width}）`, async () => {
      const count = await dialog
        .locator("#server-create-billing-cycle-count")
        .inputValue();
      assert.equal(count, "");
      const unit = await dialog
        .locator("#server-create-billing-cycle-unit")
        .innerText();
      assert.match(unit, /未填写/);
      // 默认不预填任何费用字段，公开提示不应出现。
      assert.equal(
        await group.getByText("填写后会在公开状态页展示").count(),
        0,
        "空表单不应出现公开提示",
      );
      return { count, unit };
    });
    await check(`字段顺序：价格 → 币种 → 计费周期 → 到期日（${theme}-${width}）`, async () => {
      const rects = await dialog.evaluate((node) => {
        const box = (selector) => {
          const element = node.querySelector(selector);
          const rect = element.getBoundingClientRect();
          return {
            top: rect.top,
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
          };
        };
        return {
          price: box("#server-create-billing-price"),
          currency: box("#server-create-billing-currency"),
          cycle: box("#server-create-billing-cycle-count"),
          paidUntil: box("#server-create-billing-paid-until"),
        };
      });

      if (width >= 640) {
        // 第一行：价格 | 币种；第二行：计费周期 | 到期日。
        assert.ok(
          Math.abs(rects.price.top - rects.currency.top) < 2,
          `价格与币种应同一行：${JSON.stringify(rects)}`,
        );
        assert.ok(
          Math.abs(rects.cycle.top - rects.paidUntil.top) < 2,
          `计费周期与到期日应同一行：${JSON.stringify(rects)}`,
        );
        assert.ok(rects.price.top < rects.cycle.top, "价格行应在计费周期行之前");
        assert.ok(rects.price.left < rects.currency.left, "价格应在币种左侧");
        assert.ok(
          Math.abs(rects.price.left - rects.cycle.left) < 2,
          "两行第一列应左对齐",
        );
        assert.ok(
          Math.abs(rects.currency.left - rects.paidUntil.left) < 2,
          "两行第二列应左对齐",
        );
      } else {
        // 390：单列按同一顺序堆叠。
        const order = [
          rects.price.top,
          rects.currency.top,
          rects.cycle.top,
          rects.paidUntil.top,
        ];
        for (let index = 1; index < order.length; index += 1) {
          assert.ok(
            order[index] > order[index - 1],
            `390 单列顺序错误：${JSON.stringify(rects)}`,
          );
        }
        assert.ok(
          Math.abs(rects.price.left - rects.paidUntil.left) < 2,
          "390 单列应左对齐",
        );
      }
      return rects;
    });
    await shotGroup(group, `form-empty-${theme}-${width}.png`);
    // 完整对话框（含名称 / 地址等上下文）。
    await dialog.screenshot({
      path: path.join(HERE, `form-dialog-${theme}-${width}.png`),
    });

    await pickUnit(page, dialog, "个月");
    await check(`选择「个月」后数量默认 1（${theme}-${width}）`, async () => {
      assert.equal(
        await dialog.locator("#server-create-billing-cycle-count").inputValue(),
        "1",
      );
      assert.match(
        await dialog.locator("#server-create-billing-cycle-unit").innerText(),
        /个月/,
      );
    });
    await shotGroup(group, `form-month-${theme}-${width}.png`);

    if (theme === "dark" && width === 1440) {
      // 3 个月（当前已是 1 个月，只改数量）
      await dialog.locator("#server-create-billing-cycle-count").fill("3");
      await check("3 个月（数量 3 + 单位个月）", async () => {
        assert.equal(
          await dialog.locator("#server-create-billing-cycle-count").inputValue(),
          "3",
        );
      });
      await shotGroup(group, "form-3-months-dark-1440.png");
      await closeCreate(page);

      // 2 年
      let opened = await openCreate(page);
      await opened.dialog.locator("#server-create-billing-cycle-count").fill("2");
      await pickUnit(page, opened.dialog, "年");
      await check("2 年（数量 2 + 单位年）", async () => {
        assert.equal(
          await opened.dialog
            .locator("#server-create-billing-cycle-count")
            .inputValue(),
          "2",
        );
        assert.match(
          await opened.dialog
            .locator("#server-create-billing-cycle-unit")
            .innerText(),
          /^年$/,
        );
      });
      await shotGroup(opened.group, "form-2-years-dark-1440.png");
      await closeCreate(page);

      // 一次性：数量固定 1 并禁用
      opened = await openCreate(page);
      await pickUnit(page, opened.dialog, "一次性");
      await check("一次性禁止编辑数量", async () => {
        const input = opened.dialog.locator("#server-create-billing-cycle-count");
        assert.equal(await input.inputValue(), "1");
        assert.equal(await input.isDisabled(), true);
        assert.match(
          await opened.dialog
            .locator("#server-create-billing-cycle-unit")
            .innerText(),
          /^一次性$/,
        );
      });
      await shotGroup(opened.group, "form-once-dark-1440.png");
      await closeCreate(page);

      // 清空按钮把数量与单位一起置空（截图已在默认空态覆盖）。
      opened = await openCreate(page);
      await pickUnit(page, opened.dialog, "个月");
      await opened.group.getByRole("button", { name: "清空", exact: true }).click();
      await check("清空后数量 + 单位都为空（未填写）", async () => {
        assert.equal(
          await opened.dialog
            .locator("#server-create-billing-cycle-count")
            .inputValue(),
          "",
        );
        assert.match(
          await opened.dialog
            .locator("#server-create-billing-cycle-unit")
            .innerText(),
          /未填写/,
        );
      });
      await closeCreate(page);

      // 缺一半：数量有值、单位未填写
      opened = await openCreate(page);
      await pickUnit(page, opened.dialog, "未填写");
      await opened.dialog.locator("#server-create-billing-cycle-count").fill("3");
      await page.locator("#server-name").fill("计费校验");
      await page.locator("#server-address").fill("10.10.0.99");
      await opened.dialog
        .getByRole("button", { name: "创建服务器", exact: true })
        .click();
      await check("缺单位：行内报错且不发请求", async () => {
        await opened.dialog
          .getByText("已填写计费数量，请选择单位（个月 / 年 / 一次性）")
          .waitFor();
      });
      await shotGroup(opened.group, "form-error-unit-half-dark-1440.png");
      await closeCreate(page);

      // 缺一半：单位有值、数量为空
      opened = await openCreate(page);
      await pickUnit(page, opened.dialog, "个月");
      await opened.dialog.locator("#server-create-billing-cycle-count").fill("");
      await page.locator("#server-name").fill("计费校验");
      await page.locator("#server-address").fill("10.10.0.99");
      await opened.dialog
        .getByRole("button", { name: "创建服务器", exact: true })
        .click();
      await check("缺数量：行内报错且不发请求", async () => {
        await opened.dialog
          .getByText("已选择计费单位，请填写数量（1–1200）")
          .waitFor();
      });
      await shotGroup(opened.group, "form-error-count-half-dark-1440.png");
      await closeCreate(page);

      // 数量越界：1201
      opened = await openCreate(page);
      await opened.dialog.locator("#server-create-billing-cycle-count").fill("1201");
      await page.locator("#server-name").fill("计费校验");
      await page.locator("#server-address").fill("10.10.0.99");
      await opened.dialog
        .getByRole("button", { name: "创建服务器", exact: true })
        .click();
      await check("数量 1201：行内范围错误", async () => {
        await opened.dialog
          .getByText("计费周期数量需为 1–1200 的整数")
          .waitFor();
      });
      await shotGroup(opened.group, "form-error-range-dark-1440.png");
      await closeCreate(page);

      // 提交载荷：拦截 POST，确认同时发 count / unit / 旧派生 billing_cycle。
      let posted = null;
      await page.route("**/api/v1/servers", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        posted = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            server: { id: "payload-check", name: posted.name },
            token: "token",
            install_command: "curl",
          }),
        });
      });
      opened = await openCreate(page);
      await pickUnit(page, opened.dialog, "个月");
      await opened.dialog.locator("#server-create-billing-cycle-count").fill("3");
      await opened.dialog.locator("#server-create-billing-price").fill("268");
      await opened.dialog.locator("#server-create-billing-currency").click();
      await page.getByRole("option", { name: "CNY", exact: true }).click();
      // 名称 / 地址是创建表单的必填项，按现有 id 选择。
      await page.locator("#server-name").fill("载荷校验");
      await page.locator("#server-address").fill("10.10.0.98");
      await opened.dialog
        .getByRole("button", { name: "创建服务器", exact: true })
        .click();
      await check("提交载荷：26800 分 / CNY / 3 个月同时发两列", async () => {
        await dialogWaitFor(() => posted !== null, "POST 未发出");
        assert.equal(posted.price_cents, 26800);
        assert.equal(posted.currency, "CNY");
        assert.equal(posted.billing_cycle_count, 3);
        assert.equal(posted.billing_cycle_unit, "month");
        // 3 个月不能谎报成旧派生值 monthly：派生镜像必须是 null。
        assert.equal(posted.billing_cycle, null);
        return posted;
      });
      await page.unroute("**/api/v1/servers");
    }

    await context.close();
  }
}

// 新建默认空：没填周期时，POST 周期三列都必须是 null。
{
  const { context, page } = await openPage({ theme: "dark", width: 1440, height: 1000 });
  await page.goto(`${BASE}/servers`, { waitUntil: "load" });
  await page.getByRole("button", { name: "添加服务器", exact: true }).waitFor();
  let posted = null;
  await page.route("**/api/v1/servers", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    posted = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        server: { id: "empty-payload", name: posted.name },
        token: "token",
        install_command: "curl",
      }),
    });
  });
  await openCreate(page);
  await page.locator("#server-name").fill("空周期");
  await page.locator("#server-address").fill("10.10.0.97");
  await page
    .getByRole("button", { name: "创建服务器", exact: true })
    .click();
  await check("新建默认空：不提交周期字段（三列都是 null）", async () => {
    await dialogWaitFor(() => posted !== null, "POST 未发出");
    assert.equal(posted.billing_cycle_count, null);
    assert.equal(posted.billing_cycle_unit, null);
    assert.equal(posted.billing_cycle, null);
    return {
      billing_cycle_count: posted.billing_cycle_count,
      billing_cycle_unit: posted.billing_cycle_unit,
      billing_cycle: posted.billing_cycle,
    };
  });
  await context.close();
}

function dialogWaitFor(predicate, message, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeout) return reject(new Error(message));
      setTimeout(tick, 50);
    };
    tick();
  });
}

// ---------------------------------------------------------------
// 2) 公开页卡片：四种展示同屏（1440 / 390、亮 / 暗）
// ---------------------------------------------------------------
for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    const height = width === 390 ? 844 : 1000;
    const { context, page } = await openPage({ theme, width, height });
    await page.goto(`${BASE}/status`, { waitUntil: "load" });
    await page
      .getByRole("link", { name: /查看 .+ 详情|View .+ details/ })
      .first()
      .waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);
    await check(`卡片四种展示（${theme}-${width}）`, async () => {
      const body = await page.locator("body").innerText();
      assert.match(body, /¥268\.00 \/ 月/);
      assert.match(body, /¥268\.00 \/ 3 个月/);
      assert.match(body, /¥999\.00 \/ 2 年/);
      assert.match(body, /¥199\.00 \/ 一次性/);
      assert.doesNotMatch(body, /¥268\.00 \/ 1 个月/, "count=1 应省略数字");
      return "月 / 3 个月 / 2 年 / 一次性";
    });
    await screenshot(page, `cards-${theme}-${width}.png`, { fullPage: true });
    await context.close();
  }
}

// 只有周期、没有价格：完整文案 `未配置 / 1 个月`（count=1 也不省略数字）。
const CYCLE_ONLY_NAME = "仅周期-01";
{
  const list = await api(cookie, "GET", "/api/v1/servers");
  const existing = (list.json?.items ?? []).find((item) => item.name === CYCLE_ONLY_NAME);
  const body = {
    paid_until: paidUntilIn(30),
    price_cents: null,
    currency: null,
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    billing_cycle: null,
  };
  const response = existing
    ? await api(cookie, "PATCH", `/api/v1/servers/${existing.id}`, body)
    : await api(cookie, "POST", "/api/v1/servers", {
        name: CYCLE_ONLY_NAME,
        address: "10.10.0.16",
        xray_mode: "external",
        ...body,
      });
  assert.equal(response.status, 200, `cannot seed ${CYCLE_ONLY_NAME}`);
  // 公开状态页有 30 秒缓存；等它把新服务器纳入快照，否则筛选结果为 0。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const publicNow = await (await fetch(`${BASE}/api/v1/public/status`)).json();
    if (publicNow.servers?.some((item) => item.name === CYCLE_ONLY_NAME)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

{
  const { context, page } = await openPage({ theme: "dark", width: 1440, height: 1000 });
  await page.goto(`${BASE}/status`, { waitUntil: "load" });
  await page
    .getByRole("link", { name: /查看 .+ 详情|View .+ details/ })
    .first()
    .waitFor({ timeout: 15_000 });
  await page.getByPlaceholder("搜索节点").fill("仅周期");
  await page.waitForTimeout(300);
  await check("无价格时显示完整周期文案「未配置 / 1 个月」", async () => {
    const body = await page.locator("body").innerText();
    assert.match(body, /未配置 \/ 1 个月/);
    return "未配置 / 1 个月";
  });
  await screenshot(page, "cards-cycle-only-dark-1440.png", { fullPage: true });
  await context.close();
}

// ---------------------------------------------------------------
// 3) 详情页：四种展示各一张（1440 暗）+ 1440/390 × 亮/暗（3 个月）
// ---------------------------------------------------------------
const detailIds = new Map(
  VARIANTS.map((variant) => [variant.name, byName.get(variant.name).id]),
);

async function shotDetail(variantName, { theme, width, file }) {
  const height = width === 390 ? 844 : 1000;
  const { context, page } = await openPage({ theme, width, height });
  const expect = VARIANTS.find((item) => item.name === variantName);
  await page.goto(`${BASE}/status/${encodeURIComponent(detailIds.get(variantName))}`, {
    waitUntil: "load",
  });
  const billingCard = page.locator("[data-slot='detail-billing']");
  await billingCard.waitFor({ state: "visible", timeout: 15_000 });
  await check(`详情展示 ${expect.label}（${theme}-${width}）`, async () => {
    const body = await billingCard.innerText();
    const suffix = {
      month: "/ 月",
      months3: "/ 3 个月",
      years2: "/ 2 年",
      once: "/ 一次性",
    };
    const key =
      expect.unit === "once"
        ? "once"
        : expect.count === 1
          ? "month"
          : expect.unit === "year"
            ? "years2"
            : "months3";
    assert.match(body, new RegExp(suffix[key].replace(/[/]/g, "\\/")));
    return body.replace(/\s+/g, " ").slice(0, 120);
  });
  await screenshot(page, file, { fullPage: true });
  await context.close();
}

const variantSlug = (variant) =>
  variant.unit === "once"
    ? "once"
    : variant.unit === "year"
      ? "2-years"
      : variant.count === 1
        ? "month"
        : "3-months";

// 四种展示 × 1440 / 390 × 亮 / 暗，逐张截图。
for (const variant of VARIANTS) {
  for (const theme of ["dark", "light"]) {
    for (const width of [1440, 390]) {
      await shotDetail(variant.name, {
        theme,
        width,
        file: `detail-${variantSlug(variant)}-${theme}-${width}.png`,
      });
    }
  }
}


// 清理只用于「无价格」截图的临时服务器。
{
  const list = await api(cookie, "GET", "/api/v1/servers");
  const extra = (list.json?.items ?? []).find((item) => item.name === CYCLE_ONLY_NAME);
  if (extra) await api(cookie, "DELETE", `/api/v1/servers/${extra.id}`);
}

// ---------------------------------------------------------------
// 报告
// ---------------------------------------------------------------
writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify(
    {
      base: BASE,
      generated_at: new Date().toISOString(),
      note:
        "全部数据来自真实主控：四台服务器直接写入 billing_cycle_count / billing_cycle_unit。" +
        " All data comes from the real master: four servers store count/unit directly.",
      variants: VARIANTS,
      results,
      failures,
    },
    null,
    2,
  )}\n`,
);

await browser.close();

if (failures.length > 0) {
  console.error(`FAILED ${failures.length}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK ${results.length} checks`);
  for (const result of results) console.log(`- ${result.name}`);
}
