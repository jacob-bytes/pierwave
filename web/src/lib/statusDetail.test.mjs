import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `/status/:id` 四张卡（趋势 / 明细 / 运行环境 / 费用流量）的源码形状守卫。
 * 只读现有公开状态响应；可以展示累计流量，但不能展示地址、节点列表或用户数。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(HERE, relative), "utf8");

test("the detail page is wired as a public route and reads the detail endpoint", () => {
  const app = read("../App.tsx");
  assert.match(app, /StatusDetailPage = lazy/);
  assert.match(app, /publicStatusServerId/);
  // 公开区改成 Routes 后，id 由 `/status/:id` 的 useParams 传给页面。
  assert.match(app, /<StatusDetailPage id=\{id \?\? ""\}/);
  assert.match(app, /StatusDetailRouteSkeleton/);

  const page = read("../pages/StatusDetail.tsx");
  assert.match(page, /usePublicStatus\(\)/);
  assert.match(page, /usePublicStatusDetail\(id\)/);
  assert.match(page, /buckets_24h/);
  assert.match(page, /summarizeAvailability/);
  assert.doesNotMatch(page, /\bfetch\(|api\.[a-zA-Z]+\(/);
});

test("the dashboard is exactly four cards with the required sections and states", () => {
  const page = read("../pages/StatusDetail.tsx");
  const curve = read("../components/status/AvailabilityCurve.tsx");
  for (const key of [
    "detail.availabilityDetails",
    "detail.runtime",
    "detail.billingTraffic",
    "detail.sinceBoot",
    "detail.lastReported",
    "detail.refreshHint",
    "detail.notFoundTitle",
    "detail.back",
    "detail.latency",
    "detail.rate",
    "detail.outageCount",
    "detail.outageDuration",
    "detail.coverage",
    "detail.lowestHour",
    "detail.highestHour",
    "detail.compare",
    "detail.longestNormal",
    "detail.outagePeriods",
    "detail.remainingDays",
    "detail.averageHourly",
    "detail.xrayNotRunning",
    "detail.xrayUnknown",
    "detail.sections.billing",
    "detail.system.os",
  ]) {
    assert.match(page, new RegExp(key.replaceAll(".", "\\.")));
  }
  for (const key of [
    "detail.sections.availability",
    "detail.samples",
    "detail.noSample",
    "detail.now",
    "detail.legend",
    "detail.availabilityAria",
  ]) {
    assert.match(curve, new RegExp(key.replaceAll(".", "\\.")));
  }
  for (const slot of [
    "detail-overview",
    "detail-availability",
    "detail-runtime",
    "detail-billing",
  ]) {
    assert.match(page, new RegExp(`data-slot="${slot}"`));
  }
  assert.doesNotMatch(page, /data-slot="detail-7d"/);
  assert.match(page, /publicStatus\.disabled\.title/);
  assert.match(page, /publicStatus\.error\.retry/);
  assert.match(page, /publicStatus\.error\.lastSuccess/);
  assert.match(page, /StatusDetailSkeleton/);
});

test("the detail page never exposes addresses or users", () => {
  const page = read("../pages/StatusDetail.tsx");
  for (const forbidden of [/server\.address/, /users?_total/, />\s*IP\s*</]) {
    assert.doesNotMatch(page, forbidden);
  }
});

test("last reported / refresh hint move to the top row, right of the back link", () => {
  const page = read("../pages/StatusDetail.tsx");
  const topStart = page.indexOf('data-slot="detail-top"');
  const back = page.indexOf('data-slot="detail-back"');
  const meta = page.indexOf('data-slot="detail-meta"');
  assert.ok(topStart >= 0, "顶部行需要有可断言的 data-slot");
  assert.ok(back > topStart, "返回列表在顶部行里");
  assert.ok(meta > back, "最后上报 / 刷新说明在返回列表右侧（DOM 顺序）");

  // 顶部行允许换行，右侧信息用 ml-auto 贴右；390 放不下时整组落到下一行。
  const top = page.slice(topStart, page.indexOf("</div>", meta) + 6);
  assert.match(top, /flex-wrap/);
  assert.match(top, /justify-between/);
  assert.match(top, /ml-auto/);

  // 刷新节奏说明不能删，和「最后上报」同组。
  assert.match(page, /publicStatus\.detail\.lastReported/);
  assert.match(page, /publicStatus\.detail\.refreshHint/);

  // 底部那一行已删除，避免重复。
  assert.doesNotMatch(page, /data-slot="detail-footer"/);
  assert.doesNotMatch(page, /<Footer\b/);
  assert.doesNotMatch(page, /function Footer\(/);
});

test("two-column 2x2 grid and stretch alignment are explicit", () => {
  const page = read("../pages/StatusDetail.tsx");
  assert.match(page, /lg:grid-cols-\[420px_minmax\(0,1fr\)\]/);
  assert.match(page, /items-stretch/);
  assert.doesNotMatch(page, /grid[^"\n]*items-start/);
  assert.match(page, /lg:col-start-2 lg:row-start-1/);
  assert.match(page, /lg:col-start-2 lg:row-start-2/);
  assert.match(page, /gap-4/);
});

test("curve uses step/area and marks missing hours separately", () => {
  const curve = read("../components/status/AvailabilityCurve.tsx");
  assert.match(curve, /data-slot="availability-step"/);
  assert.match(curve, /data-slot="availability-missing"/);
  assert.match(curve, /data-slot="availability-area"/);
  assert.match(curve, /data-slot="availability-transition"/);
  assert.match(curve, /data-ratio=\{ratio\}/);
  assert.match(curve, /tabIndex=\{0\}/);
  assert.match(curve, /aria-describedby/);
  assert.match(curve, /<ul className="sr-only">/);
  assert.match(curve, /Y_BOTTOM/);
});

test("detail typography uses a 28/16–18/12px scale with tabular numbers", () => {
  const page = read("../pages/StatusDetail.tsx");
  // 主数字 28（390 22），次要数字 16–18，单位 / 标签 12。
  assert.match(page, /text-\[22px\] leading-none font-semibold sm:text-\[28px\]/);
  assert.match(page, /text-base leading-none font-semibold sm:text-\[18px\]/);
  assert.match(page, /text-xs font-normal text-muted-foreground/);
  // 「27 天后到期」「27 / 30 天」必须等宽，刷新时数字不抖。
  assert.match(page, /tnum flex min-w-0 flex-wrap items-baseline/);
  assert.match(page, /remainingDays[\s\S]{0,120}total: cycleDays/);
  assert.match(page, /expiryLabel\(billing\.days\)/);
  assert.match(page, /expired \? "text-warning" : "text-foreground"/);
  assert.match(page, /net_rx_bytes/);
  assert.match(page, /net_tx_bytes/);
});

test("availability details use a 2x3 grid with all six metrics at 390", () => {
  const page = read("../pages/StatusDetail.tsx");
  assert.match(page, /data-slot="detail-metric-grid"/);
  assert.match(page, /grid-cols-2/);
  assert.match(page, /grid-cols-\[minmax\(0,0\.9fr\)_minmax\(0,0\.9fr\)_minmax\(0,1\.2fr\)\]/);
  for (const metric of [
    "outages",
    "duration",
    "coverage",
    "lowest",
    "highest",
    "compare",
  ]) {
    assert.match(page, new RegExp(`name="${metric}"`));
  }
  // 最长连续正常 / 中断时段是栅格下方的两条明细，390 也必须可见。
  assert.match(page, /longestNormal/);
  assert.match(page, /outagePeriods/);
  // 不能再用桌面断点隐藏真实数据。
  assert.doesNotMatch(page, /hidden lg:(flex|block|grid)/);
  assert.doesNotMatch(page, /hidden sm:(flex|block|grid)/);
});

test("the P1 layout wires the five new optional fields", () => {
  const page = read("../pages/StatusDetail.tsx");
  assert.match(page, /outage_minutes_24h/);
  assert.match(page, /outageMinutesParts/);
  assert.match(page, /first_seen_at/);
  assert.match(page, /serviceAgeLabel/);
  assert.match(page, /inbound_count/);
  assert.match(page, /inboundCount\(/);
  assert.match(page, /buckets_7d/);
  assert.match(page, /series_24h/);
  assert.match(page, /latencyTrend\(/);
  // 精确中断为 null 时显示 —，不回落到 0 分钟。
  assert.match(page, /exactOutageMissing/);
});

test("P1 geometry: 112px curve with three y ticks, 82/70px rings, 58/42 split", () => {
  const page = read("../pages/StatusDetail.tsx");
  const curve = read("../components/status/AvailabilityCurve.tsx");
  const rateTrend = read("../components/status/RateTrend.tsx");
  const days = read("../components/status/AvailabilityDays.tsx");

  assert.match(curve, /PLOT_HEIGHT_CLASS = "h-\[112px\]"/);
  assert.match(curve, /Y_TICKS = \[100, 50, 0\]/);
  assert.match(curve, /text-xs text-muted-foreground/);
  assert.match(curve, /\[50, 100\]\.map/);

  assert.match(rateTrend, /data-slot="detail-rate-trend"/);
  assert.match(rateTrend, /h-5/);
  assert.match(days, /data-slot="detail-days"/);
  assert.match(days, /weekAvailability/);

  assert.match(page, /sm:basis-\[58%\]/);
  assert.match(page, /sm:basis-\[56%\]/);
  assert.match(page, /size-\[70px\] shrink-0 sm:size-\[82px\]/);
  assert.match(page, /sm:flex-row/);
});

test("the detail endpoint 404 falls back to list data and never errors the page", () => {
  const page = read("../pages/StatusDetail.tsx");
  const queries = read("./queries.ts");

  // 详情接口必须按 id 调用，且只在 server.id 对得上时采用。
  assert.match(page, /usePublicStatusDetail\(id\)/);
  assert.match(page, /detail\.data\?\.server\?\.id === id/);
  // 顶层 series_24h 优先，其次旧后端 server 上的字段；都没有时 null → 图表隐藏。
  assert.match(
    page,
    /detailData\.series_24h \?\? detailData\.server\.series_24h \?\? null/,
  );
  assert.match(page, /: listServer/);
  // 详情失败只落到 listServer，不能进入页面级错误态。
  assert.doesNotMatch(page, /detail\.isError/);
  assert.doesNotMatch(page, /detail\.error/);

  // 查询层：404 不重试、不轮询；正常态仍 20 秒刷新。
  const detailHook = queries.slice(
    queries.indexOf("export function usePublicStatusDetail"),
  );
  assert.ok(detailHook.length > 0, "必须在 queries.ts 里提供详情查询");
  assert.match(detailHook, /retry: false/);
  assert.match(detailHook, /query\.state\.error\.status === 404/);
  assert.match(detailHook, /return PUBLIC_STATUS_POLL_MS/);
  assert.match(detailHook, /refetchIntervalInBackground:\s*false/);
});
