#!/usr/bin/env node
/**
 * 入口端口「未被采用」提示 + 降级 · 无样本徽章 的验收截图 / assertions.
 *
 * 前置 / Prerequisite:
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
 *   PIERWAVE_DB='sqlite://data/entry-port-preview.db?mode=rwc' \
 *     ./target/debug/pierwave-master
 *   cd web && npm run dev          # http://localhost:5173
 *
 * 用法 / Usage:
 *   node web/screenshots/entry-port-guard/shots.mjs
 *
 * 说明：创建请求被浏览器层拦截，返回一个「旧主控忽略 entry_port」的响应
 * （请求 24321 → 实际 24000），不往预览库写任何链。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://localhost:5173";
const ADMIN = process.env.ADMIN_PASSWORD ?? "devpass";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEWPORTS = [1440, 390];
const THEME = "dark";

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

async function session(username) {
  const response = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: ADMIN }),
  });
  assert.equal(response.status, 200, `${username} login failed`);
  const cookie = response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .find((item) => item.startsWith("pierwave_session="));
  assert.ok(cookie, "session cookie must exist");
  return cookie;
}

const ADMIN_COOKIE = await session("admin");
const USER_COOKIE = await session("alice");

async function apiGet(cookie, url) {
  const response = await fetch(`${BASE}${url}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200, `GET ${url} -> ${response.status}`);
  return response.json();
}

const health = await apiGet(
  ADMIN_COOKIE,
  "/api/v1/overview/chain-health?hours=24&bucket=900",
);
const noSamplesChain = health.chains[0];
assert.ok(noSamplesChain?.id, "need at least one preview chain");

function enrichHealth(payload) {
  for (const chain of payload.chains ?? []) {
    chain.status =
      chain.id === noSamplesChain.id
        ? { kind: "degraded", cause: "no_samples", node: null }
        : { kind: "ok", cause: null, node: null };
    if (chain.id === noSamplesChain.id) {
      // 让「无样本」与页面对得上：清空窗口内的曲线 / 逐段数据。
      chain.series = [];
      chain.segments = [];
      chain.loss_pct = null;
      chain.loss_samples = { attempts: 0, failures: 0 };
    }
  }
  return payload;
}

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

async function newPage(browser, cookie, width) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    colorScheme: THEME,
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    localStorage.setItem("pierwave.theme", "dark");
    localStorage.setItem("pierwave.locale", "zh-CN");
  });
  await context.addCookies([
    {
      name: cookie.split("=")[0],
      value: cookie.split("=")[1],
      url: BASE,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.route("**/api/v1/overview/chain-health*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: enrichHealth(body) });
  });
  // 详情弹窗会单独拉逐段曲线；无样本场景同样返回空，避免徽章和曲线打架。
  await context.route("**/api/v1/chains/*/latency*", async (route) => {
    if (route.request().url().includes(noSamplesChain.id)) {
      await route.fulfill({ status: 200, json: { points: [] } });
      return;
    }
    await route.continue();
  });
  return { context, page: await context.newPage() };
}

const warningText = "端口 24321 未被采用，实际为 24000（保存后可在链路详情看到）";

const fakeMeChain = {
  id: "preview-mismatch-me-chain",
  name: "香港 → 东京 · 双跳 · 1.2.3.4:443",
  template_id: "tpl-hk-tokyo",
  template_name: "香港 → 东京 · 双跳",
  target_host: "1.2.3.4",
  target_port: 443,
  engine: "native",
  security: "tls",
  transport: "none",
  protocol: "tcp",
  enabled: true,
  entry_address: "203.0.113.11:24000",
  entry_server_id: "c0ffee00-0000-4000-8000-000000000001",
  entry_server_name: "香港-01",
  groups: [
    {
      seq: 0,
      strategy: "failover",
      servers: [
        {
          server_id: "c0ffee00-0000-4000-8000-000000000001",
          server_name: "香港-01",
          listen_port: 24000,
        },
      ],
    },
  ],
  created_at: Math.floor(Date.now() / 1000),
  updated_at: Math.floor(Date.now() / 1000),
};

const fakeAdminChain = {
  id: "preview-mismatch-admin-chain",
  name: "香港 → 东京 · 双跳 · 1.2.3.4:443",
  target_host: "1.2.3.4",
  target_port: 443,
  enabled: true,
  engine: "native",
  protocol: "tcp",
  udp: false,
  transport: "none",
  tunnel_security: "tls",
  template_id: "tpl-hk-tokyo",
  owner_user_id: null,
  source: "admin",
  degraded: false,
  path_mode: "single",
  total_latency_ms: null,
  groups: [
    {
      id: "preview-group-0",
      seq: 0,
      name: null,
      strategy: "failover",
      cert_id: null,
      public_port: null,
      use_internal_address: false,
      degraded: false,
      listen_port: 24000,
      members: [
        {
          server_id: "c0ffee00-0000-4000-8000-000000000001",
          server_name: "香港-01",
          listen_port: 24000,
        },
      ],
    },
  ],
  created_at: Math.floor(Date.now() / 1000),
  updated_at: Math.floor(Date.now() / 1000),
};

async function fillAndSubmit(page, prefix) {
  const form = page.locator(`#${prefix}-form`);
  await form.waitFor();
  await page.locator(`#${prefix}-entry-port`).fill("24321");
  await page.locator(`#${prefix}-target-host`).fill("1.2.3.4");
  await page.locator(`#${prefix}-target-port`).fill("443");
  return form;
}

async function waitWarning(page) {
  const toast = page.locator("[data-sonner-toast]").first();
  await toast.waitFor({ timeout: 8000 });
  const text = (await toast.innerText()).trim();
  assert.equal(text, warningText);
  return { text, type: await toast.getAttribute("data-type") };
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
});

const requests = { user: null, admin: null };

for (const width of VIEWPORTS) {
  await check(`user [${width}] warns when entry_port is ignored`, async () => {
    const { context, page } = await newPage(browser, USER_COOKIE, width);
    try {
      await context.route("**/api/v1/me/chains", async (route) => {
        if (route.request().method() === "POST") {
          requests.user = route.request().postDataJSON();
          await route.fulfill({ status: 200, json: { chain: fakeMeChain } });
          return;
        }
        // 列表也补上这条链，避免截图里「提示创建成功但列表为空」。
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            json: { items: [fakeMeChain], quota: { limit: 3, used: 1 } },
          });
          return;
        }
        await route.continue();
      });
      await page.goto(`${BASE}/me/forwards`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "新建转发链", exact: true }).first().click();
      await fillAndSubmit(page, "my-chain");
      await page.locator('button[form="my-chain-form"][type="submit"]').click();
      const toast = await waitWarning(page);
      assert.equal(toast.type, "warning", `toast type: ${toast.type}`);
      assert.equal(requests.user.entry_port, 24321);
      assert.equal(requests.user.template_id, "tpl-hk-tokyo");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await page.screenshot({
        path: path.join(HERE, `user-create-ignored-port-${width}-${THEME}.png`),
      });
      return { toast: toast.text, request: requests.user };
    } finally {
      await context.close();
    }
  });

  await check(`admin [${width}] warns when entry_port is ignored`, async () => {
    const { context, page } = await newPage(browser, ADMIN_COOKIE, width);
    try {
      await context.route("**/api/v1/chains", async (route) => {
        if (route.request().method() === "POST") {
          requests.admin = route.request().postDataJSON();
          await route.fulfill({ status: 200, json: { chain: fakeAdminChain } });
          return;
        }
        await route.continue();
      });
      await page.goto(`${BASE}/chains`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "从模板创建", exact: true }).first().click();
      await fillAndSubmit(page, "chain-from-template");
      await page
        .locator('button[form="chain-from-template-form"][type="submit"]')
        .click();
      const toast = await waitWarning(page);
      assert.equal(toast.type, "warning", `toast type: ${toast.type}`);
      assert.equal(requests.admin.entry_port, 24321);
      assert.equal(requests.admin.template_id, "tpl-hk-tokyo");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await page.screenshot({
        path: path.join(HERE, `admin-create-ignored-port-${width}-${THEME}.png`),
      });
      return { toast: toast.text, request: requests.admin };
    } finally {
      await context.close();
    }
  });

  await check(`detail [${width}] shows 降级 · 无样本`, async () => {
    const { context, page } = await newPage(browser, ADMIN_COOKIE, width);
    try {
      await page.goto(`${BASE}/?view=chain&chain=${noSamplesChain.id}`, {
        waitUntil: "networkidle",
      });
      const badge = page.locator("[data-chain-status-badge]");
      await badge.waitFor();
      await page.waitForFunction(() =>
        Boolean(document.querySelector("[data-chain-status-badge]")?.dataset.state),
      );
      const text = (await badge.innerText()).trim();
      assert.equal(text, "降级 · 无样本");
      assert.equal(await badge.getAttribute("data-state"), "degraded");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await page.screenshot({
        path: path.join(HERE, `degraded-no-samples-${width}-${THEME}.png`),
      });
      return { text, state: await badge.getAttribute("data-state") };
    } finally {
      await context.close();
    }
  });
}

await browser.close();

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  width: VIEWPORTS,
  theme: THEME,
  results,
  failures,
};
writeFileSync(path.join(HERE, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(JSON.stringify(report, null, 2));
