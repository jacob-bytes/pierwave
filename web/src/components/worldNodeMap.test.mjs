/**
 * 「节点分布」地图卡的源码契约。
 *
 * 纯函数测试覆盖聚合与筛选，这里锁定跨组件的结构：卡片位于资源状态视图的
 * KPI 与「服务器 × 时间」之间、跳转 URL、键盘可达、国家名回退，以及服务器页
 * 的 `?country=` 支持。这些位置关系单靠纯函数测不到，改版时最容易悄悄丢。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

const map = read("components/overview/WorldNodeMap.tsx");
const health = read("components/overview/ServerHealthView.tsx");
const servers = read("pages/Servers.tsx");
const country = read("lib/country.ts");
const zh = read("i18n/zh-CN.ts");
const en = read("i18n/en.ts");

test("地图卡位于资源状态视图：KPI 之后、「服务器 × 时间」之前，且整宽渲染", () => {
  const kpiEnd = health.indexOf("</ChainKpiGrid>");
  const mapStart = health.indexOf("<WorldNodeMap");
  const heatmapStart = health.indexOf("<HeatmapCard");
  assert.ok(kpiEnd >= 0, "resource view must keep ChainKpiGrid");
  assert.ok(mapStart >= 0, "resource view must mount WorldNodeMap");
  assert.ok(heatmapStart >= 0, "resource view must keep HeatmapCard");
  assert.ok(kpiEnd < mapStart, "map must render after the KPI grid");
  assert.ok(mapStart < heatmapStart, "map must render before Server × time");
  assert.match(health, /<WorldNodeMap[\s\S]{0,120}selectedIds=/);
  assert.match(health, /<WorldNodeMap[\s\S]{0,200}filtered=/);
  // 默认导出且只在资源状态视图挂载，避免被复制到别的 tab。
  assert.match(map, /export default function WorldNodeMap/);
  assert.equal(
    (health.match(/<WorldNodeMap/g) ?? []).length,
    1,
    "map must be mounted exactly once",
  );
});

test("地图卡读取 useServers 的 country_code / 状态，不新增运行时请求", () => {
  assert.match(map, /useServers\(\)/);
  assert.match(map, /country_code: server\.country_code/);
  assert.match(map, /status: worldNodeStatus\(server\)/);
  assert.match(map, /worldNodeStats/);
  assert.ok(
    !map.includes("fetch(") && !map.includes("/api/"),
    "map must not fetch its own data",
  );
  assert.match(map, /overview\.serverHealth\.mapTitle/);
});

test("着色：无节点 fill-muted，四档 primary，offline / abnormal 描边", () => {
  assert.match(map, /fill-muted/);
  for (const tier of ["fill-primary/15", "fill-primary/30", "fill-primary/50", "fill-primary/75"]) {
    assert.ok(map.includes(tier), `missing tier fill ${tier}`);
  }
  assert.match(map, /stat\.worst === "offline" && "stroke-destructive"/);
  assert.match(map, /stat\.worst === "abnormal" && "stroke-warning"/);
  assert.match(map, /data-tier="none"/);
  assert.match(map, /data-worst=/);
});

test("点击与键盘：role=button + aria-label，Enter 跳 /servers?country=XX", () => {
  assert.match(map, /role="button"/);
  assert.match(map, /aria-label=/);
  assert.match(map, /tabIndex=\{0\}/);
  assert.match(map, /event\.key !== "Enter"/);
  assert.match(map, /navigate\(`\/servers\?country=\$\{country\}`\)/);
  // 无节点国家不能可聚焦：只有 stats 命中时才挂 role / tabIndex。
  assert.match(map, /if \(!stat\) \{[\s\S]*?data-tier="none"/);
});

test("国家名：Intl.DisplayNames 本地化，失败回退 ISO2", () => {
  assert.match(country, /new Intl\.DisplayNames\(\[locale\], \{ type: "region" \}\)/);
  assert.match(country, /catch \{\s*return normalized;/);
  assert.match(map, /countryDisplayName\(code, locale\) \?\? code/);
});

test("tooltip 显示本地化国家名 + 台数 + 前 3 节点", () => {
  assert.match(map, /role="tooltip"/);
  assert.match(map, /data-world-map-tooltip/);
  assert.match(map, /mapTooltipCount/);
  assert.match(map, /topNames\.join\(" · "\)/);
  assert.match(map, /onMouseEnter/);
  assert.match(map, /onFocus/);
});

test("空态仍显示地图，图例注明暂无节点", () => {
  assert.match(map, /data-world-map-empty/);
  assert.match(map, /stats\.length === 0/);
  assert.match(map, /mapEmpty/);
  // 地图本身不因空态卸载。
  assert.ok(map.indexOf("<svg") < map.indexOf("mapEmpty"));
});

test("390：SVG 等比缩放到卡片宽，不引发布局横向滚动", () => {
  assert.match(map, /viewBox="0 0 1000 500"/);
  assert.match(map, /className="block h-auto w-full"/);
  assert.match(map, /max-w-\[840px\]/);
  assert.ok(!map.includes("overflow-x"), "map must not introduce horizontal scroll");
  assert.ok(!map.includes("min-w-"), "map must not set a min width");
});

test("服务器页读取 ?country=，与显示异常 / 分组筛选叠加，并显示 chip 与空态", () => {
  assert.match(servers, /searchParams\.get\("country"\)/);
  assert.match(servers, /resolveCountryFilter/);
  assert.match(servers, /applyServerListFilters\(items, \{[\s\S]{0,160}country: countryFilter/);
  assert.match(servers, /data-slot="server-country-filter"/);
  assert.match(servers, /data-country=\{countryFilter\}/);
  assert.match(servers, /clearCountryFilter/);
  assert.match(servers, /countryEmpty/);
  assert.match(servers, /countryEmptyTitle/);
  assert.match(servers, /setSearchParams\(next, \{ replace: true \}\)/);
});

test("中英文案同时存在，占位符一致", () => {
  for (const key of [
    "mapTitle",
    "mapAria",
    "mapCountryAria",
    "mapTooltipCount",
    "mapLegendTier",
    "mapLegendNone",
    "mapLegendOffline",
    "mapLegendAbnormal",
    "mapEmpty",
    "countryFilterChip",
    "countryFilterClear",
    "countryEmptyTitle",
    "countryEmptyDesc",
    "countryEmptyClear",
  ]) {
    assert.ok(zh.includes(`${key}:`), `zh-CN missing ${key}`);
    assert.ok(en.includes(`${key}:`), `en missing ${key}`);
  }
});
