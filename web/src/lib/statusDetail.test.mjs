import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `/status/:id` 的源码形状守卫。
 *
 * 详情页不新增后端接口，只读现有公开状态响应；不能展示地址、节点、用户数
 * 或流量明细。这里把这些边界和几个必须存在的状态一起钉住。
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
  // 只用现有公开接口：不出现新的 fetch / api 调用。
  assert.doesNotMatch(page, /\bfetch\(|api\.[a-zA-Z]+\(/);
});

test("the detail page has the required sections and states", () => {
  const page = read("../pages/StatusDetail.tsx");
  for (const key of [
    "detail.sections.availability",
    "detail.sections.resources",
    "detail.sections.billing",
    "detail.sections.system",
    "detail.lowest",
    "detail.lastReported",
    "detail.refreshHint",
    "detail.notFoundTitle",
    "detail.back",
  ]) {
    assert.match(page, new RegExp(key.replaceAll(".", "\\.")));
  }
  assert.match(page, /publicStatus\.disabled\.title/);
  assert.match(page, /publicStatus\.error\.retry/);
  assert.match(page, /publicStatus\.error\.lastSuccess/);
  assert.match(page, /StatusDetailSkeleton/);
});

test("the detail page never exposes addresses, nodes, users or traffic detail", () => {
  const page = read("../pages/StatusDetail.tsx");
  for (const forbidden of [
    /server\.address/,
    /net_rx_bytes/,
    /net_tx_bytes/,
    /\bnodes?\b/i,
    /users?_total/,
    /traffic_today/,
    /traffic_month/,
  ]) {
    assert.doesNotMatch(page, forbidden);
  }
});

test("back link and header keep the public page chrome", () => {
  const page = read("../pages/StatusDetail.tsx");
  assert.match(page, /<Link to="\/status">/);
  assert.match(page, /StatusHeader/);
  assert.match(page, /StatusChip/);

  const header = read("../components/status/StatusHeader.tsx");
  assert.match(header, /export function StatusHeader/);
  assert.match(header, /publicStatus\.header\.themeToggle/);
});

test("detail values use the hero 19/28px scale and a 12px unit", () => {
  const page = read("../pages/StatusDetail.tsx");
  assert.match(page, /text-\[19px\] leading-none font-semibold sm:text-\[28px\]/);
  assert.match(page, /text-xs font-normal text-muted-foreground/);
  assert.match(page, /data-slot="detail-bar"/);
  assert.match(page, /expiryLabel\(billing\.days\)/);
  assert.match(page, /billing\.days < 0 && "text-warning"/);
});
