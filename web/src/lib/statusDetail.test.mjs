import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `/status/:id` 方案 B 的源码形状守卫。
 *
 * 详情页不新增后端接口，只读现有公开状态响应；可以展示累计流量带，但仍
 * 不能展示地址、节点列表或用户数。可用率的 null / 0 语义单独由曲线组件
 * 的 `data-slot` 与 Playwright 断言锁定。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(HERE, relative), "utf8");

test("the detail page is wired as a public route without a new API", () => {
  const app = read("../App.tsx");
  assert.match(app, /StatusDetailPage = lazy/);
  assert.match(app, /publicStatusServerId/);
  assert.match(app, /<StatusDetailPage id=\{serverId\}/);
  assert.match(app, /StatusDetailRouteSkeleton/);

  const page = read("../pages/StatusDetail.tsx");
  assert.match(page, /usePublicStatus\(\)/);
  assert.match(page, /buckets_24h/);
  assert.doesNotMatch(page, /\bfetch\(|api\.[a-zA-Z]+\(/);
});

test("the dashboard has the required sections and states", () => {
  const page = read("../pages/StatusDetail.tsx");
  const curve = read("../components/status/AvailabilityCurve.tsx");
  for (const key of [
    "detail.sections.resources",
    "detail.sections.billing",
    "detail.sections.system",
    "detail.sinceBoot",
    "detail.lastReported",
    "detail.refreshHint",
    "detail.notFoundTitle",
    "detail.back",
    "detail.latency",
    "detail.rate",
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

test("two-column grid and stretch alignment are explicit", () => {
  const page = read("../pages/StatusDetail.tsx");
  assert.match(page, /lg:grid-cols-\[420px_minmax\(0,1fr\)\]/);
  assert.match(page, /items-stretch/);
  assert.doesNotMatch(page, /grid[^"\n]*items-start/);
  assert.match(page, /lg:col-start-2 lg:row-span-2 lg:row-start-1/);
  assert.match(page, /lg:col-span-2/);
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

test("detail values use the hero 19/28px scale and a 12px unit", () => {
  const page = read("../pages/StatusDetail.tsx");
  assert.match(page, /text-\[19px\] leading-none font-semibold sm:text-\[28px\]/);
  assert.match(page, /text-xs font-normal text-muted-foreground/);
  assert.match(page, /expiryLabel\(billing\.days\)/);
  assert.match(page, /billing\.days < 0 && "text-warning"|billing\.days !== null && billing\.days < 0[\s\S]{0,40}text-warning/);
  assert.match(page, /net_rx_bytes/);
  assert.match(page, /net_tx_bytes/);
});
