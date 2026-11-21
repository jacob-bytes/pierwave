#!/usr/bin/env node
/**
 * 现网详情页的审计标注图 / annotated audit shots.
 *
 * 用法 / Usage:
 *   (cd web && npm run build && npx vite preview --port 4180 --strictPort)
 *   BASE_URL=http://localhost:4180 node web/screenshots/detail-concepts/annotate.mjs
 *
 * 只在截图用的页面里注入一层绝对定位的标注，不改产品代码、不写库。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUT = path.join(HERE, "audit");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4180";
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, "fixture.json"), "utf8"));
const TARGET = "c0ffee00-0000-4000-8000-000000000001";
const OFFLINE = "c0ffee00-0000-4000-8000-000000000003";

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const npx = path.join(ROOT, ".npm-cache", "_npx");
  if (existsSync(npx)) for (const e of readdirSync(npx)) candidates.push(path.join(npx, e, "node_modules", "playwright", "index.mjs"));
  for (const c of candidates) { try { const m = await import(pathToFileURL(c).href); if (m.chromium) return m.chromium; } catch {} }
  throw new Error("找不到 playwright");
}

const chromium = await loadPlaywright();
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined,
});

const issues = [
  ["1", "三个时间信号：顶栏「更新于」、pill「在线 13 天」、页脚「最后上报」"],
  ["2", "同一个 24h 可用率：KPI 大数字 + 区块标题，重复一次"],
  ["3", "24 格竖条 31.8×56、gap 4；无时间轴、无自定义 hover、无「现在」标记"],
  ["4", "空桶画成 56px 满高灰块，和 100% 一样高；0% 中断只有 1.1px（见离线图）"],
  ["5", "90/114px 的整张卡片只放一行费用、三个短字段"],
  ["6", "内容 896/1440=62%，两侧空白 544px；内容止于 848，底部空白 152px"],
  ["7", "六张同材质卡片 + 页脚；4 个区块标题均 12px；三个 28px 数字里速率只有 14px"],
  ["8", "页面有两个 h1：「PierWave」与「香港-01」"],
];

async function shot(url, file, target) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    localStorage.setItem("pierwave.theme", "dark");
    localStorage.setItem("pierwave.locale", "zh-CN");
  });
  await page.route("**/api/**", async (route) =>
    route.fulfill({
      status: route.request().url().includes("/api/v1/public/status") ? 200 : 404,
      contentType: "application/json",
      body: JSON.stringify(FIXTURE),
    }),
  );
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector('[data-slot="detail-header"]', { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);

  await page.evaluate(({ issues, target }) => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height };
    };
    const layer = document.createElement("div");
    layer.style.cssText = "position:absolute;left:0;top:0;z-index:90;pointer-events:none;font-family:'Geist Variable',system-ui,sans-serif;";
    const css = document.createElement("style");
    css.textContent = `
      .anno-box { position:absolute; border:1.5px solid #f43f5e; border-radius:4px; background:rgba(244,63,94,.055); }
      .anno-num { position:absolute; transform:translate(-50%,-50%); min-width:20px; height:20px; padding:0 5px; border-radius:999px;
        background:#e11d48; color:#fff; font:600 11px/20px 'Geist Variable',system-ui; text-align:center; box-shadow:0 0 0 2px #0b0b0e; }
      .anno-note { position:absolute; display:block; width:max-content; max-width:246px; padding:4px 7px; border-radius:5px; background:#1a1013; border:1px solid rgba(244,63,94,.45);
        color:#fecdd3; font:500 10.5px/1.5 'Geist Variable','PingFang SC',sans-serif; }
      .anno-margin { position:absolute; top:81px; height:768px; background:repeating-linear-gradient(135deg, rgba(244,63,94,.10) 0 6px, transparent 6px 14px); }
      .anno-legend { position:absolute; left:272px; top:858px; width:896px; padding:14px 16px; border:1px solid rgba(244,63,94,.35);
        border-radius:10px; background:rgba(26,16,19,.92); color:#fecdd3; font:500 10.5px/1.55 'Geist Variable','PingFang SC',sans-serif;
        display:grid; grid-template-columns:1fr 1fr; gap:4px 22px; }
      .anno-legend b { color:#fff; }
      .anno-legend .wide { grid-column:1/-1; color:#fda4af; }
    `;
    document.head.append(css);
    layer.append(css);

    const el = (sel) => document.querySelector(sel);
    const box = (node, num, note, noteSide = "right") => {
      if (!node) return;
      const b = r(node);
      const div = document.createElement("div");
      div.className = "anno-box";
      div.style.cssText += `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;`;
      layer.append(div);
      const n = document.createElement("span");
      n.className = "anno-num";
      n.textContent = num;
      n.style.left = `${b.x + b.w}px`;
      n.style.top = `${b.y}px`;
      layer.append(n);
      if (note) {
        const t = document.createElement("span");
        t.className = "anno-note";
        t.textContent = note;
        t.style.left = noteSide === "left" ? `${Math.max(12, b.x - 310)}px` : `${b.x + b.w + 14}px`;
        t.style.top = `${b.y + 5}px`;
        layer.append(t);
      }
    };

    const wrap = el("main .max-w-4xl");
    const w = r(wrap);
    // 左右空白
    for (const [x, width] of [[0, w.x], [w.x + w.w, 1440 - (w.x + w.w)]]) {
      const m = document.createElement("div");
      m.className = "anno-margin";
      m.style.left = `${x}px`;
      m.style.width = `${width}px`;
      layer.append(m);
    }
    const num6 = document.createElement("span");
    num6.className = "anno-num";
    num6.textContent = "6";
    num6.style.left = "16px";
    num6.style.top = "108px";
    layer.append(num6);
    const note6 = document.createElement("span");
    note6.className = "anno-note";
    note6.textContent = `内容 ${Math.round(w.w)} / 1440 = ${(w.w / 14.4).toFixed(0)}%，两侧各 ${Math.round(w.x)}px；内容止于 ${Math.round(w.y + w.h)}，底部 ${1000 - Math.round(w.y + w.h)}px 空白`;
    note6.style.left = "34px";
    note6.style.top = "100px";
    layer.append(note6);

    // 1 三个时间信号
    const live = [...document.querySelectorAll("header span")].find((e) => e.textContent.trim().startsWith("更新于"));
    if (live) {
      const b = r(live);
      const n = document.createElement("span");
      n.className = "anno-num";
      n.textContent = "1a";
      n.style.left = `${b.x + b.w}px`;
      n.style.top = `${b.y}px`;
      layer.append(n);
    }
    const badge = el('[data-slot="detail-header"] [data-slot="badge"]');
    if (badge) {
      const b = r(badge);
      const n = document.createElement("span");
      n.className = "anno-num";
      n.textContent = "1b";
      n.style.left = `${b.x + b.w}px`;
      n.style.top = `${b.y}px`;
      layer.append(n);
    }
    const footer = el('[data-slot="detail-footer"]');
    if (footer) {
      const b = r(footer);
      const n = document.createElement("span");
      n.className = "anno-num";
      n.textContent = "1c";
      n.style.left = `${b.x + b.w}px`;
      n.style.top = `${b.y}px`;
      layer.append(n);
    }

    // 2 重复 24h
    const kpi = el('[data-slot="detail-key-numbers"] [data-stat="uptime"]');
    if (kpi) {
      const b = r(kpi);
      const n = document.createElement("span");
      n.className = "anno-num";
      n.textContent = "2";
      n.style.left = `${b.x + b.w}px`;
      n.style.top = `${b.y}px`;
      layer.append(n);
    }

    // 3 24 格
    box(el('[data-slot="detail-bars"]'), "3", "24 格 31.8×56，gap 4；无时间轴 / 无自定义 hover", "left");

    // 4 空桶 + 系统卡
    const nulls = [...document.querySelectorAll('[data-slot="detail-bar"]')].filter((e) => e.dataset.ratio === "null");
    for (const bar of nulls.slice(0, 1)) box(bar, "4", "空桶 56px 满高灰块 = 和 100% 同高", "left");
    box(el('[data-slot="detail-system"]'), "5", "整张卡只放三个短字段", "left");

    // 7 六张卡片
    for (const slot of ["detail-header", "detail-key-numbers", "detail-availability", "detail-resources", "detail-billing", "detail-system"]) {
      const node = el(`[data-slot="${slot}"]`);
      if (!node) continue;
      const b = r(node);
      const div = document.createElement("div");
      div.className = "anno-box";
      div.style.cssText += `left:${b.x - 2}px;top:${b.y - 2}px;width:${b.w + 4}px;height:${b.h + 4}px;opacity:.35;`;
      layer.append(div);
    }
    const n7 = document.createElement("span");
    n7.className = "anno-num";
    n7.textContent = "7";
    n7.style.left = `${w.x + w.w}px`;
    n7.style.top = `${w.y + 80}px`;
    layer.append(n7);

    // 8 两个 h1
    const h1s = [...document.querySelectorAll("h1")];
    for (const h of h1s) {
      const b = r(h);
      const n = document.createElement("span");
      n.className = "anno-num";
      n.textContent = "8";
      n.style.left = `${b.x + b.w}px`;
      n.style.top = `${b.y}px`;
      layer.append(n);
    }

    // 图例
    const legend = document.createElement("div");
    legend.className = "anno-legend";
    legend.innerHTML = `<div class="wide">现状审计 · ${target === "offline" ? "离线态（香港-03）" : "在线态（香港-01）"} · 2026-11-21 / annotated audit</div>` +
      issues.map(([n, t]) => `<div><b>${n}</b> ${t}</div>`).join("");
    layer.append(legend);

    document.body.append(layer);
    document.documentElement.style.height = "auto";
  }, { issues, target });

  await page.screenshot({ path: path.join(OUT, file), fullPage: true, animations: "disabled" });
  await page.close();
  console.log("ok", file);
}

await shot(`${BASE_URL}/status/${TARGET}`, "current-normal-annotated-dark-1440.png", "normal");
await shot(`${BASE_URL}/status/${OFFLINE}`, "current-offline-annotated-dark-1440.png", "offline");
await browser.close();
