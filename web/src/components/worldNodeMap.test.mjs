/**
 * 「节点分布」地图卡的源码契约。
 *
 * 纯函数测试覆盖聚合与筛选，这里锁定跨组件的结构：卡片位于资源状态视图的
 * KPI 与「服务器 × 时间」之间、跳转 URL、键盘可达、小国圆点、图例位置，以及
 * 服务器页的 `?country=` 支持。这些位置关系单靠纯函数测不到，改版时最容易悄悄丢。
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

test("投影不变、裁到 lat +78°..-56°，地图宽度拉满卡片", () => {
  assert.match(map, /const VIEW_BOX = "0 33\.3 1000 372\.2"/);
  assert.match(map, /viewBox=\{VIEW_BOX\}/);
  assert.match(map, /className="block h-auto w-full"/);
  // 旧的 840px 居中容器会把地图压窄、上下留白变大。
  assert.ok(!map.includes("max-w-[840px]"), "map must span the card width");
  assert.ok(!map.includes("mx-auto"), "map must not be centred at 840px");
});

test("层次：海洋透明、无节点 muted-foreground/20、四档 20/35/55/80 + primary/40 描边", () => {
  assert.match(map, /fill-muted-foreground\/20/);
  for (const tier of [
    "fill-primary/20",
    "fill-primary/35",
    "fill-primary/55",
    "fill-primary/80",
  ]) {
    assert.ok(map.includes(tier), `missing tier fill ${tier}`);
  }
  assert.match(map, /stroke-primary\/40/);
  // 国家面只走 primary；红 / 黄只出现在圆点外环（见「状态用外环表达」）。
  assert.match(map, /active \? "stroke-primary" : "stroke-primary\/40"/);
  assert.match(map, /data-tier="none"/);
  assert.match(map, /data-worst=/);
});

test("状态用外环表达：离线 destructive、异常 warning、在线无环", () => {
  assert.match(
    map,
    /const STATUS_RING_STROKE = \{[\s\S]*?online: null,[\s\S]*?offline: "stroke-destructive",[\s\S]*?abnormal: "stroke-warning"/,
  );
  // 外环只在 offline / abnormal 时渲染，online 的 ringClass 为 null。
  assert.match(map, /ringClass \? \(/);
  assert.match(map, /data-world-map-ring=\{stat\.worst\}/);
  assert.match(map, /r=\{radius \+ STATUS_RING_OFFSET_PX \/ scale\}/);
  assert.match(map, /STATUS_RING_OFFSET_PX = 2\.5/);
  assert.match(map, /STATUS_RING_STROKE_PX = 2/);
  assert.match(map, /strokeWidth=\{STATUS_RING_STROKE_PX\}/);
  assert.match(map, /className=\{cn\("fill-none", ringClass\)\}/);
  // 聚焦环给状态环让位，但键盘反馈本身不变。
  assert.match(map, /MARKER_RING_FOCUS_GAP_PX/);
});

test("节点标记：质心圆点按档位 3/4/5/6px，圆点始终 primary、状态只靠外环", () => {
  assert.match(map, /worldNodeMarkerRadius\(stat\.tier\)/);
  // 质心来自 JSON 的 `c: [x, y]`，组件必须同步读取。
  assert.match(map, /const \[centroidX, centroidY\] = shape\.c/);
  assert.match(map, /data-world-map-marker=\{country\}/);
  assert.match(map, /data-world-map-dot/);
  assert.match(map, /data-world-map-count/);
  assert.match(map, /stat\.total >= 2/);
  // 圆点永远用主题主色，不再按最差状态换色。
  assert.match(map, /className="fill-primary stroke-card"/);
  assert.ok(!map.includes("fill-destructive"), "dot must not use destructive fill");
  assert.ok(!map.includes("fill-warning"), "dot must not use warning fill");
  // 圆点用 2px 卡片底色描边形成「挖空」感。
  assert.match(map, /MARKER_STROKE_PX = 2/);
  assert.match(map, /stroke-card/);
  assert.match(map, /MARKER_LABEL_PX = 12/);
  // N 标签也回到主色（2px 卡片色描边保证可读）。
  assert.match(map, /className="fill-primary font-medium"/);
  // 半径按屏幕像素固定，390 下用 ResizeObserver 换算回 viewBox 单位。
  assert.match(map, /ResizeObserver/);
  assert.match(map, /mapWidth \/ VIEW_WIDTH/);
});

test("hover / 键盘聚焦：fill 提亮一档 + 1.5px primary 描边 + focus ring", () => {
  assert.match(map, /TIER_HOVER_FILL/);
  assert.match(map, /strokeWidth=\{active \? 1\.5 : 0\.5\}/);
  assert.match(map, /data-world-map-focus-ring/);
  assert.match(map, /stroke-focus-ring/);
  assert.match(map, /onMouseEnter/);
  assert.match(map, /onFocus/);
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

test("tooltip 显示本地化国家名 + 台数 + 状态 + 前 3 节点", () => {
  assert.match(map, /role="tooltip"/);
  assert.match(map, /data-world-map-tooltip/);
  assert.match(map, /mapTooltipCount/);
  assert.match(map, /mapTooltipStatus/);
  assert.match(map, /data-world-map-tooltip-status/);
  assert.match(map, /statusLabel\(tipStat\.worst\)/);
  assert.match(map, /topNames\.join\(" · "\)/);
  // 顺序：台数 / 在线 → 状态 → 前 3 个节点。
  assert.ok(map.indexOf("mapTooltipCount") < map.indexOf("mapTooltipStatus"));
  assert.ok(map.indexOf("mapTooltipStatus") < map.indexOf("topNames.join"));
  assert.match(map, /onMouseEnter/);
  assert.match(map, /onFocus/);
});

test("图例拆成两段：节点数四档 + 圆点/外环状态语义，12px", () => {
  assert.match(map, /data-world-map-legend/);
  assert.match(map, /justify-end/);
  assert.match(map, /text-xs/);
  assert.match(map, /size-2\.5/);
  // 左段：节点数标题 + 四档色块。
  assert.match(map, /data-world-map-legend-tiers/);
  assert.match(map, /data-world-map-legend-tiers-title/);
  assert.match(map, /mapLegendTiersTitle/);
  assert.match(map, /data-world-map-legend-tier=\{tier\}/);
  // 右段：12px 圆点 + 外环示意在线 / 离线 / 异常。
  assert.match(map, /data-world-map-legend-status/);
  assert.match(map, /data-world-map-legend-online/);
  assert.match(map, /data-world-map-legend-offline/);
  assert.match(map, /data-world-map-legend-abnormal/);
  assert.match(map, /mapLegendOnline/);
  assert.match(map, /mapLegendOffline/);
  assert.match(map, /mapLegendAbnormal/);
  assert.match(map, /StatusLegendGlyph/);
  assert.match(map, /data-world-map-legend-glyph=\{status\}/);
  assert.match(map, /width="12"/);
  assert.match(map, /height="12"/);
});

test("空态仍显示地图，图例注明暂无节点", () => {
  assert.match(map, /data-world-map-empty/);
  assert.match(map, /stats\.length === 0/);
  assert.match(map, /mapEmpty/);
  // 地图本身不因空态卸载。
  assert.ok(map.indexOf("<svg") < map.indexOf("mapEmpty"));
});

test("390：SVG 等比缩放到卡片宽，不引发布局横向滚动", () => {
  assert.match(map, /className="block h-auto w-full"/);
  assert.match(map, /className="relative w-full"/);
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
    "mapTooltipStatus",
    "mapStatusOnline",
    "mapStatusOffline",
    "mapStatusAbnormal",
    "mapLegendTiersTitle",
    "mapLegendTier",
    "mapLegendNone",
    "mapLegendOnline",
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
