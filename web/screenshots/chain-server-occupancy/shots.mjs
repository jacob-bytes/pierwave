#!/usr/bin/env node
/**
 * 跨跳服务器占用置灰的验收截图 / Acceptance shots for cross-hop server occupancy.
 *
 * 第 1 跳选香港-01 → 第 2 跳下拉里香港-01 置灰并标注「已在第 1 跳」；
 * 第 1 跳改选香港-02 后，第 2 跳的香港-01 恢复可选、香港-02 置灰。
 * 覆盖 1440 / 390 宽度与深色 / 浅色主题。
 *
 * 前置 / Prerequisite:
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
 *   PIERWAVE_DB='sqlite://data/chain-server-occupancy-preview.db?mode=rwc' \
 *     ./target/debug/pierwave-master
 *   cd web && npm run dev          # http://localhost:5173
 *
 * 用法 / Usage:
 *   BASE=http://localhost:5173 node web/screenshots/chain-server-occupancy/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://localhost:5173";
const ADMIN = process.env.ADMIN_PASSWORD ?? "devpass";
const VIEWPORTS = [1440, 390];
const THEMES = /** @type {const} */ (["dark", "light"]);

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) {
    candidates.push(process.env.PLAYWRIGHT_MODULE);
  }
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

const serversResponse = await fetch(`${BASE}/api/v1/servers`, {
  headers: { Cookie: sessionCookie },
});
assert.equal(serversResponse.status, 200, "server list failed");
const serverList = await serversResponse.json();
const serverId = (name) => {
  const match = (serverList.items ?? serverList).find(
    (item) => item.name === name,
  );
  assert.ok(match, `preview server ${name} is missing`);
  return match.id;
};

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

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});

function option(page, name) {
  return page.getByRole("option", { name });
}

async function openServerSelect(page, dialog, hop) {
  await dialog
    .getByRole("combobox", {
      name: `第 ${hop} 跳第 1 台成员的服务器`,
    })
    .click();
  // 下拉是 portal，等第一项出现再断言。
  await page.getByRole("option").first().waitFor({ state: "visible" });
}

for (const theme of THEMES) {
  for (const width of VIEWPORTS) {
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
    const page = await context.newPage();

    try {
      await page.goto(`${BASE}/chains`, { waitUntil: "networkidle" });
      await page
        .getByRole("button", { name: "新建转发链", exact: true })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible" });
      // 填好链名与目标，避免自动聚焦失焦后弹出一堆必填错误干扰截图。
      await dialog.locator("#chain-name").fill("香港 → 东京");
      await dialog.locator("#chain-target-host").fill("10.0.0.8");
      await dialog.locator("#chain-target-port").fill("5432");

      // 第 1 跳选香港-01，然后加第 2 跳（自动展开）。
      await openServerSelect(page, dialog, 1);
      await option(page, /^香港-01/).click();
      await dialog.getByRole("button", { name: "添加一跳" }).click();

      // 第 2 跳下拉：香港-01 置灰 + 原因；项仍在列表里。
      await openServerSelect(page, dialog, 2);
      const blocked = option(page, /^香港-01/);
      assert.equal(
        await blocked.getAttribute("aria-disabled"),
        "true",
        "hop 2 must disable the server picked by hop 1",
      );
      assert.match(
        (await blocked.innerText()).replace(/\s+/g, " "),
        /已在第 1 跳/,
        "disabled option must explain why",
      );
      assert.equal(
        await option(page, /^东京-01/).getAttribute("aria-disabled"),
        null,
        "unused servers must stay selectable",
      );
      const count = await page.getByRole("option").count();
      assert.ok(count >= 10, `all servers must stay in the list, got ${count}`);

      await check(`hop2-blocked-${width}-${theme}`, async () => {
        await page.screenshot({
          path: path.join(HERE, `hop2-blocked-${width}-${theme}.png`),
        });
        return {
          options: count,
          blocked: (await blocked.innerText()).replace(/\s+/g, " "),
        };
      });

      // 关下拉 → 展开第 1 跳改选香港-02。
      await page.keyboard.press("Escape");
      await dialog.getByRole("button", { name: "展开第 1 跳" }).click();
      await openServerSelect(page, dialog, 1);
      await option(page, /^香港-02/).click();

      // 再展开第 2 跳：香港-01 恢复可选，香港-02 置灰。
      await dialog.getByRole("button", { name: "展开第 2 跳" }).click();
      await openServerSelect(page, dialog, 2);
      const released = option(page, /^香港-01/);
      const takenNow = option(page, /^香港-02/);
      assert.equal(
        await released.getAttribute("aria-disabled"),
        null,
        "dropping the earlier server must release it immediately",
      );
      assert.equal(
        await takenNow.getAttribute("aria-disabled"),
        "true",
        "the newly picked server must be disabled",
      );
      assert.match(
        (await takenNow.innerText()).replace(/\s+/g, " "),
        /已在第 1 跳/,
        "the newly taken option must explain why",
      );

      await check(`hop2-released-${width}-${theme}`, async () => {
        await page.screenshot({
          path: path.join(HERE, `hop2-released-${width}-${theme}.png`),
        });
        return {
          released: (await released.innerText()).replace(/\s+/g, " "),
          taken: (await takenNow.innerText()).replace(/\s+/g, " "),
        };
      });
    } finally {
      await context.close();
    }
  }
}

/**
 * 分组类型下的同跳重复：第 1 跳第 1 台选香港-01 后，第 2 台的下拉要置灰它；
 * 第 1 台自己的下拉仍可选香港-01。
 */
await check("grouped-same-hop", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    localStorage.setItem("pierwave.theme", "dark");
    localStorage.setItem("pierwave.locale", "zh-CN");
  });
  await context.addCookies([
    {
      name: sessionCookie.split("=")[0],
      value: sessionCookie.split("=")[1],
      url: BASE,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/chains`, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "新建转发链", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#chain-name").fill("香港 → 东京");
    await dialog.locator("#chain-target-host").fill("10.0.0.8");
    await dialog.locator("#chain-target-port").fill("5432");

    const hop1 = dialog.getByRole("group", { name: "第 1 跳" });
    await hop1.getByRole("button", { name: "分组", exact: true }).click();
    await dialog
      .getByRole("combobox", { name: "第 1 跳第 1 台成员的服务器" })
      .click();
    await page.getByRole("option", { name: /^香港-01/ }).click();
    await hop1.getByRole("button", { name: "添加成员" }).click();

    await dialog
      .getByRole("combobox", { name: "第 1 跳第 2 台成员的服务器" })
      .click();
    const taken = page.getByRole("option", { name: /^香港-01/ });
    assert.equal(await taken.getAttribute("aria-disabled"), "true");
    assert.match(
      (await taken.innerText()).replace(/\s+/g, " "),
      /已在第 1 跳第 1 台/,
      "same-hop duplicate must name the member that already uses it",
    );
    const takenText = (await taken.innerText()).replace(/\s+/g, " ");
    await page.keyboard.press("Escape");

    // 第 1 台自己的当前值必须可选。
    await dialog
      .getByRole("combobox", { name: "第 1 跳第 1 台成员的服务器" })
      .click();
    assert.equal(
      await page
        .getByRole("option", { name: /^香港-01/ })
        .getAttribute("aria-disabled"),
      null,
      "the member's own current server must stay selectable",
    );
    return { taken: takenText };
  } finally {
    await context.close();
  }
});

/**
 * 模板编辑器同样适用：第 1 跳勾香港-01 → 第 2 跳的香港-01 置灰并说明；
 * 第 1 跳改勾香港-02 → 第 2 跳恢复可选、香港-02 置灰。
 */
await check("template-editor-occupancy", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    localStorage.setItem("pierwave.theme", "dark");
    localStorage.setItem("pierwave.locale", "zh-CN");
  });
  await context.addCookies([
    {
      name: sessionCookie.split("=")[0],
      value: sessionCookie.split("=")[1],
      url: BASE,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/chain-templates`, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "新建模板", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#chain-template-name").fill("香港 → 东京");

    const hop1HongKong01 = dialog.locator(
      `#chain-template-group-0-server-${serverId("香港-01")}`,
    );
    await hop1HongKong01.click();
    await dialog.getByRole("button", { name: "添加一跳" }).click();

    const hop2HongKong01 = dialog.locator(
      `#chain-template-group-1-server-${serverId("香港-01")}`,
    );
    const hop2HongKong02 = dialog.locator(
      `#chain-template-group-1-server-${serverId("香港-02")}`,
    );
    assert.equal(
      await hop2HongKong01.isDisabled(),
      true,
      "template hop 2 must disable the server picked by hop 1",
    );
    assert.match(
      (await hop2HongKong01.locator("xpath=..").innerText()).replace(
        /\s+/g,
        " ",
      ),
      /已在第 1 跳/,
      "template disabled row must explain why",
    );
    assert.equal(
      await dialog.locator('[data-server-unavailable="true"]').count(),
      1,
      "disabled servers must stay in the list",
    );
    await hop2HongKong01.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(HERE, "template-hop2-blocked-1440-dark.png"),
    });

    // 第 1 跳改勾香港-02 → 第 2 跳的香港-01 立即恢复。
    await hop1HongKong01.click();
    await dialog
      .locator(`#chain-template-group-0-server-${serverId("香港-02")}`)
      .click();
    assert.equal(
      await hop2HongKong01.isDisabled(),
      false,
      "dropping the earlier server must release it immediately",
    );
    assert.equal(
      await hop2HongKong02.isDisabled(),
      true,
      "the newly picked template server must be disabled",
    );
    return { released: "香港-01", taken: "香港-02" };
  } finally {
    await context.close();
  }
});

await browser.close();

writeFileSync(
  path.join(HERE, "report.json"),
  JSON.stringify({ base: BASE, results, failures }, null, 2),
);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(JSON.stringify(results, null, 2));
