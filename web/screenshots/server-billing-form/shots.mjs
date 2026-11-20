#!/usr/bin/env node
/**
 * 管理端「费用与到期」表单：截图 + 真实后端验证。
 *
 * 覆盖 / Covers:
 *   1. 新建对话框：空（无公开提示）→ 已填（出现「填写后会在公开状态页展示」）；
 *   2. 行内错误：价格超上界（前端校验）与后端错误码映射（`server.currency_invalid`）；
 *   3. 编辑回填：从 `GET /api/v1/servers` 的真实值回填；
 *   4. 清空：UI「清空」→ 保存 → 用真实接口确认四列变回 null；
 *   5. 1440 / 390、亮 / 暗，页面与对话框都不横向溢出。
 *
 * 前置 / Prerequisite:
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8796 \
 *   PIERWAVE_DB='sqlite:///tmp/pw-billing/db.sqlite?mode=rwc' \
 *   ./target/debug/pierwave-master
 *
 * 用法 / Usage:
 *   BASE=http://127.0.0.1:8796 node web/screenshots/server-billing-form/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://127.0.0.1:8796";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const NAME = "billing-ui";
const PAID_UNTIL = "2026-12-31";

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

// 可重复执行：清掉上一次运行创建的同一台测试服务器（只在这个临时库上）。
{
  const existing = await api(cookie, "GET", "/api/v1/servers");
  for (const item of existing.json.items ?? []) {
    if (item.name === NAME) {
      await api(cookie, "DELETE", `/api/v1/servers/${item.id}`);
    }
  }
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
  await page.goto(`${BASE}/servers`, { waitUntil: "load" });
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  // 真实列表加载完成（至少有一台服务器）。
  await page
    .getByRole("button", {
      name: locale === "en" ? /More actions for/ : /的更多操作/,
    })
    .first()
    .waitFor({ timeout: 15_000 });
  return { context, page };
}

async function dialogGroup(page, locale = "zh-CN") {
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  const group = dialog.getByRole("group", {
    name: locale === "en" ? "Cost and expiry" : "费用与到期",
  });
  await group.waitFor({ state: "visible" });
  return { dialog, group };
}

async function fillBilling(page, { date = PAID_UNTIL, price = "268.00", currency = "CNY", cycle = "月" } = {}) {
  const dialog = page.getByRole("dialog");
  await dialog.locator("#server-create-billing-paid-until").fill(date);
  await dialog.locator("#server-create-billing-price").fill(price);

  await dialog.locator("#server-create-billing-currency").click();
  await page.getByRole("option", { name: currency, exact: true }).click();

  await dialog.locator("#server-create-billing-cycle").click();
  await page.getByRole("option", { name: cycle, exact: true }).click();
}

function overflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

function assertNoOverflow(page, label) {
  return overflow(page).then((size) => {
    assert.ok(
      size.scrollWidth <= size.clientWidth + 1,
      `${label} 横向溢出 ${size.scrollWidth} > ${size.clientWidth}`,
    );
    return size;
  });
}

async function shot(dialog, name, group) {
  // 表单在对话框内部滚动；先把「费用与到期」整组滚进视口再截图，
  // 否则空表单时下面两个字段会被裁掉。
  if (group) await group.scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: path.join(HERE, name) });
}

async function closeDialog(page, locale = "zh-CN") {
  const cancel = page
    .getByRole("dialog")
    .getByRole("button", { name: locale === "en" ? "Cancel" : "取消" });
  if (await cancel.count()) {
    await cancel.click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
}

// ---------------------------------------------------------------- 1440 dark
{
  const { context, page } = await openPage({ theme: "dark", width: 1440, height: 1000 });
  let createPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/v1/servers")
    ) {
      createPosts += 1;
    }
  });
  try {
    await page.getByRole("button", { name: "添加服务器" }).first().click();
    const { dialog, group } = await dialogGroup(page);

    // 空：四个字段都空，公开提示不出现（避免噪音）。
    assert.equal(await group.count(), 1);
    assert.equal(
      await dialog.getByText("填写后会在公开状态页展示").count(),
      0,
      "空表单不应显示公开提示",
    );
    assert.equal(
      await group.getByRole("button", { name: "清空" }).isDisabled(),
      true,
      "空表单时清空按钮应禁用",
    );
    await shot(dialog, "create-empty-dark-1440.png", group);
    results.push({ file: "create-empty-dark-1440.png", hint: false, price: "" });

    // 已填：填任一字段后出现公开提示。
    await dialog.locator("#server-name").fill(NAME);
    await dialog.locator("#server-address").fill("203.0.113.10");
    await fillBilling(page);
    assert.equal(
      await dialog.getByText("填写后会在公开状态页展示").count(),
      1,
      "填写后应提示会公开",
    );
    await shot(dialog, "create-filled-dark-1440.png", group);
    results.push({
      file: "create-filled-dark-1440.png",
      hint: true,
      date: await dialog.locator("#server-create-billing-paid-until").inputValue(),
      price: await dialog.locator("#server-create-billing-price").inputValue(),
    });

    // 只填价格、清空币种：前端拦下，错误落在缺的币种上，且不发请求。
    const postsBeforePair = createPosts;
    await dialog.locator("#server-create-billing-currency").click();
    await page.getByRole("option", { name: "未填写", exact: true }).click();
    await dialog.getByRole("button", { name: "创建服务器" }).click();
    const currencyPairError = dialog.locator(
      "#server-create-billing-currency-error",
    );
    await currencyPairError.waitFor();
    const currencyPairText = (await currencyPairError.innerText()).trim();
    assert.match(currencyPairText, /币种/);
    assert.equal(
      createPosts,
      postsBeforePair,
      "只填价格时不应发出创建请求",
    );
    await shot(dialog, "create-pair-price-only-dark-1440.png", group);
    results.push({
      file: "create-pair-price-only-dark-1440.png",
      errorText: currencyPairText,
      posts: createPosts - postsBeforePair,
    });

    // 反向：只填币种、清空价格，错误落在价格上。
    await dialog.locator("#server-create-billing-currency").click();
    await page.getByRole("option", { name: "CNY", exact: true }).click();
    await dialog.locator("#server-create-billing-price").fill("");
    await dialog.getByRole("button", { name: "创建服务器" }).click();
    const pricePairError = dialog.locator("#server-create-billing-price-error");
    await pricePairError.waitFor();
    const pricePairText = (await pricePairError.innerText()).trim();
    assert.match(pricePairText, /价格/);
    assert.equal(
      createPosts,
      postsBeforePair,
      "只填币种时不应发出创建请求",
    );
    await shot(dialog, "create-pair-currency-only-dark-1440.png", group);
    results.push({
      file: "create-pair-currency-only-dark-1440.png",
      errorText: pricePairText,
      posts: createPosts - postsBeforePair,
    });

    // 日期越界：选择器有 min/max，且一改就显示行内错误。
    await dialog.locator("#server-create-billing-price").fill("268.00");
    await dialog
      .locator("#server-create-billing-paid-until")
      .fill("1969-12-31");
    const dateError = dialog.locator("#server-create-billing-paid-until-error");
    await dateError.waitFor();
    const dateRangeText = (await dateError.innerText()).trim();
    assert.match(dateRangeText, /1970-01-01/);
    assert.match(dateRangeText, /2100-12-31/);
    const dateLimits = await dialog
      .locator("#server-create-billing-paid-until")
      .evaluate((input) => ({
        min: input.min,
        max: input.max,
        value: input.value,
        rangeUnderflow: input.validity.rangeUnderflow,
        validationMessage: input.validationMessage,
      }));
    assert.equal(dateLimits.min, "1970-01-01");
    assert.equal(dateLimits.max, "2100-12-31");
    assert.equal(dateLimits.rangeUnderflow, true);
    await shot(dialog, "create-date-range-dark-1440.png", group);
    results.push({
      file: "create-date-range-dark-1440.png",
      errorText: dateRangeText,
      dateLimits,
    });
    // 原生约束会先挡住这次提交：依旧不能有 POST。
    await dialog.getByRole("button", { name: "创建服务器" }).click();
    assert.equal(createPosts, postsBeforePair, "越界日期不应发出创建请求");
    // 改回合法日期，错误消失，继续后面的价格格式用例。
    await dialog
      .locator("#server-create-billing-paid-until")
      .fill("2026-12-31");
    await dateError.waitFor({ state: "hidden" });

    // 行内错误：价格超上界，不弹 toast、不发请求。
    await dialog.locator("#server-create-billing-price").fill("10000000");
    await dialog.getByRole("button", { name: "创建服务器" }).click();
    const priceError = dialog.locator("#server-create-billing-price-error");
    await priceError.waitFor();
    const errorText = (await priceError.innerText()).trim();
    assert.match(errorText, /价格/);
    await shot(dialog, "create-inline-price-dark-1440.png", group);
    results.push({ file: "create-inline-price-dark-1440.png", errorText });

    // 改回合法价格并真正创建。
    await dialog.locator("#server-create-billing-price").fill("268.00");
    await dialog.getByRole("button", { name: "创建服务器" }).click();
    await page.getByText("服务器已创建").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "我已保存" }).click();
    await page.getByText("服务器已创建").waitFor({ state: "hidden" });

    const list = await api(cookie, "GET", "/api/v1/servers");
    const created = list.json.items.find((item) => item.name === NAME);
    assert.ok(created, "新建的服务器应出现在列表里");
    assert.deepEqual(
      {
        paid_until: created.paid_until,
        price_cents: created.price_cents,
        currency: created.currency,
        billing_cycle: created.billing_cycle,
      },
      {
        paid_until: PAID_UNTIL,
        price_cents: 26800,
        currency: "CNY",
        billing_cycle: "monthly",
      },
      "创建请求应把元转成分并提交四个字段",
    );
    results.push({
      api: "POST /api/v1/servers",
      created: {
        paid_until: created.paid_until,
        price_cents: created.price_cents,
        currency: created.currency,
        billing_cycle: created.billing_cycle,
      },
    });

    // 编辑回填。
    await page.getByRole("button", { name: `${NAME} 的更多操作` }).first().click();
    await page.getByRole("menuitem", { name: "编辑服务器" }).click();
    const edit = await dialogGroup(page);
    assert.equal(
      await edit.dialog.locator("#server-edit-billing-paid-until").inputValue(),
      PAID_UNTIL,
    );
    assert.equal(
      await edit.dialog.locator("#server-edit-billing-price").inputValue(),
      "268",
    );
    assert.equal(
      await edit.dialog.locator("#server-edit-billing-currency").innerText(),
      "CNY",
    );
    assert.equal(
      await edit.dialog.locator("#server-edit-billing-cycle").innerText(),
      "月",
    );
    await shot(edit.dialog, "edit-filled-dark-1440.png", edit.group);
    results.push({
      file: "edit-filled-dark-1440.png",
      backfill: {
        date: await edit.dialog.locator("#server-edit-billing-paid-until").inputValue(),
        price: await edit.dialog.locator("#server-edit-billing-price").inputValue(),
        currency: await edit.dialog.locator("#server-edit-billing-currency").innerText(),
        cycle: await edit.dialog.locator("#server-edit-billing-cycle").innerText(),
      },
    });

    // 清空 → 提示消失 → 保存。
    await edit.group.getByRole("button", { name: "清空" }).click();
    assert.equal(
      await edit.dialog.getByText("填写后会在公开状态页展示").count(),
      0,
      "清空后公开提示应消失",
    );
    await shot(edit.dialog, "edit-cleared-dark-1440.png", edit.group);
    await edit.dialog.getByRole("button", { name: "保存修改" }).click();
    await page.getByText("服务器设置已保存").waitFor({ timeout: 15_000 });
    await page.getByRole("dialog").waitFor({ state: "hidden" });

    const cleared = await api(cookie, "GET", "/api/v1/servers");
    const clearedServer = cleared.json.items.find((item) => item.id === created.id);
    assert.deepEqual(
      {
        paid_until: clearedServer.paid_until,
        price_cents: clearedServer.price_cents,
        currency: clearedServer.currency,
        billing_cycle: clearedServer.billing_cycle,
      },
      { paid_until: null, price_cents: null, currency: null, billing_cycle: null },
      "清空后 PATCH 必须真的把四列写成 null",
    );
    results.push({
      api: "PATCH … (clear)",
      cleared: {
        paid_until: clearedServer.paid_until,
        price_cents: clearedServer.price_cents,
        currency: clearedServer.currency,
        billing_cycle: clearedServer.billing_cycle,
      },
    });

    // 重新打开：空表单、无提示。
    await page.getByRole("button", { name: `${NAME} 的更多操作` }).first().click();
    await page.getByRole("menuitem", { name: "编辑服务器" }).click();
    const reopened = await dialogGroup(page);
    assert.equal(
      await reopened.dialog.locator("#server-edit-billing-price").inputValue(),
      "",
    );
    assert.equal(
      await reopened.dialog.getByText("填写后会在公开状态页展示").count(),
      0,
    );
    await shot(
      reopened.dialog,
      "edit-empty-after-clear-dark-1440.png",
      reopened.group,
    );

    // 后端错误码 → 行内错误：让 PATCH 返回 server.currency_invalid。
    // 前端能通过自己的校验，这条路径验证的是「后端权威错误落到对应字段」。
    // 价格 + 币种一起填：通过前端成对校验，这样才会真的发出 PATCH，
    // 让下面拦截到的后端错误码走到「字段行内」。
    await reopened.dialog.locator("#server-edit-billing-price").fill("49.99");
    await reopened.dialog.locator("#server-edit-billing-currency").click();
    await page.getByRole("option", { name: "CNY", exact: true }).click();
    let intercepted = 0;
    await page.route("**/api/v1/servers/*", async (route) => {
      if (route.request().method() === "PATCH" && intercepted === 0) {
        intercepted += 1;
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error:
              "币种不合法：cny 必须是 3 位大写字母（例如 CNY / USD / EUR），或留空 / Invalid currency: cny must be a 3-letter uppercase code (e.g. CNY / USD / EUR), or leave it empty",
            code: "server.currency_invalid",
            params: { field: "currency", length: 3, pattern: "^[A-Z]{3}$", value: "cny" },
          }),
        });
        return;
      }
      await route.continue();
    });
    await reopened.dialog.getByRole("button", { name: "保存修改" }).click();
    const currencyError = reopened.dialog.locator(
      "#server-edit-billing-currency-error",
    );
    await currencyError.waitFor();
    const apiErrorText = (await currencyError.innerText()).trim();
    assert.match(apiErrorText, /币种/);
    // 不是 toast：错误必须在字段下方，且对话框仍然打开。
    assert.equal(
      await reopened.dialog.getByRole("button", { name: "保存修改" }).count(),
      1,
    );
    await shot(
      reopened.dialog,
      "edit-inline-api-error-dark-1440.png",
      reopened.group,
    );
    results.push({
      file: "edit-inline-api-error-dark-1440.png",
      apiErrorText,
      intercepted,
    });
    await page.unroute("**/api/v1/servers/*");
    await closeDialog(page);
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------- 1440 / 390 others
for (const job of [
  { theme: "light", width: 1440, height: 1000, locale: "zh-CN" },
  { theme: "dark", width: 390, height: 844, locale: "zh-CN" },
  { theme: "light", width: 390, height: 844, locale: "zh-CN" },
  { theme: "dark", width: 1440, height: 1000, locale: "en" },
]) {
  const suffix = job.locale === "en" ? "-en" : "";
  const { context, page } = await openPage(job);
  try {
    await page
      .getByRole("button", {
        name: job.locale === "en" ? "Add server" : "添加服务器",
      })
      .first()
      .click();
    const { dialog, group } = await dialogGroup(page, job.locale);
    const size = await assertNoOverflow(
      page,
      `${job.theme}-${job.width}${suffix}`,
    );
    await shot(
      dialog,
      `create-empty-${job.theme}-${job.width}${suffix}.png`,
      group,
    );

    await dialog.locator("#server-name").fill(NAME);
    await dialog.locator("#server-address").fill("203.0.113.10");
    await fillBilling(page, {
      cycle: job.locale === "en" ? "Monthly" : "月",
      currency: "CNY",
    });
    await assertNoOverflow(
      page,
      `${job.theme}-${job.width}${suffix} filled`,
    );
    await shot(
      dialog,
      `create-filled-${job.theme}-${job.width}${suffix}.png`,
      group,
    );
    results.push({
      file: `create-filled-${job.theme}-${job.width}${suffix}.png`,
      theme: job.theme,
      width: job.width,
      locale: job.locale,
      overflow: size,
      hint: await dialog
        .getByText(
          job.locale === "en"
            ? "Shown on the public status page once filled in"
            : "填写后会在公开状态页展示",
        )
        .count(),
    });
    await closeDialog(page, job.locale);
  } finally {
    await context.close();
  }
}

// --------------------------------------------------- 后端契约（错误码 + 清空）
{
  const list = await api(cookie, "GET", "/api/v1/servers");
  const target = list.json.items.find((item) => item.name === NAME);
  assert.ok(target, "需要先由 UI 创建 billing-ui");
  for (const [body, code] of [
    [{ paid_until: "2026-02-30" }, "server.paid_until_invalid"],
    [{ price_cents: -1 }, "server.price_cents_invalid"],
    [{ currency: "cny" }, "server.currency_invalid"],
    [{ billing_cycle: "weekly" }, "server.billing_cycle_invalid"],
  ]) {
    const response = await api(
      cookie,
      "PATCH",
      `/api/v1/servers/${target.id}`,
      body,
    );
    assert.equal(response.status, 400, `${code} should be 400`);
    assert.equal(response.json.code, code);
    assert.ok(response.json.params?.field, `${code} params.field`);
  }
  // 价格/币种成对：真实后端只放行「都有 / 都没有」。
  const pairPrice = await api(cookie, "PATCH", `/api/v1/servers/${target.id}`, {
    price_cents: 100,
  });
  assert.equal(pairPrice.status, 400);
  assert.equal(pairPrice.json.code, "server.billing_pair_incomplete");
  assert.equal(pairPrice.json.params.missing, "currency");
  const pairCurrency = await api(
    cookie,
    "PATCH",
    `/api/v1/servers/${target.id}`,
    { currency: "CNY" },
  );
  assert.equal(pairCurrency.status, 400);
  assert.equal(pairCurrency.json.code, "server.billing_pair_incomplete");
  assert.equal(pairCurrency.json.params.missing, "price_cents");

  // 到期日年份范围：越界 400，params 带 min/max。
  for (const date of ["1969-12-31", "2101-01-01"]) {
    const range = await api(
      cookie,
      "PATCH",
      `/api/v1/servers/${target.id}`,
      { paid_until: date },
    );
    assert.equal(range.status, 400, date);
    assert.equal(range.json.code, "server.paid_until_invalid", date);
    assert.equal(range.json.params.min, "1970-01-01", date);
    assert.equal(range.json.params.max, "2100-12-31", date);
  }

  // 请求体类型错误（JSON 合法但字段类型不对）：统一映射成
  // `request.invalid_json`（422，带 code），说明前端为什么需要这个翻译键。
  const invalidJson = await fetch(`${BASE}/api/v1/servers`, {
    method: "POST",
    headers: {
      Cookie: `${cookie.name}=${cookie.value}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "billing-invalid-json",
      address: "203.0.113.11",
      price_cents: "",
    }),
  });
  const invalidBody = await invalidJson.json();
  assert.equal(invalidJson.status, 422);
  assert.equal(invalidBody.code, "request.invalid_json");

  results.push({
    api: "contract",
    pair: {
      priceOnly: {
        code: pairPrice.json.code,
        missing: pairPrice.json.params.missing,
      },
      currencyOnly: {
        code: pairCurrency.json.code,
        missing: pairCurrency.json.params.missing,
      },
    },
    invalidJson: { status: invalidJson.status, code: invalidBody.code },
  });

  results.push({ api: "error codes", codes: [
    "server.paid_until_invalid",
    "server.price_cents_invalid",
    "server.currency_invalid",
    "server.billing_cycle_invalid",
    "server.billing_pair_incomplete",
    "request.invalid_json",
  ] });
}

await browser.close();
assert.equal(failures.length, 0, `页面错误：${failures.join(" | ")}`);
writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify({ base: BASE, generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log(`截图与真实后端验证完成：${results.length} 组结果 → ${HERE}`);
