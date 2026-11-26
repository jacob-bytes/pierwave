import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAIN_SECTIONS,
  CHAIN_USAGE_URL,
  DEFAULT_CHAIN_SECTION,
  applyChainSection,
  chainSectionParam,
  isChainSection,
  resolveChainSection,
} from "./chainSections.ts";
import { applyChainListFilters } from "./chainListFilters.ts";
import { CHAIN_SERIES_PARAM } from "./chainTrendSeries.ts";
import { applyOverviewView } from "./overviewViews.ts";

test("链路时延子页顺序是转发链 / 转发模板 / 转发用量，默认转发链", () => {
  assert.deepEqual(CHAIN_SECTIONS, ["chains", "templates", "usage"]);
  assert.equal(DEFAULT_CHAIN_SECTION, "chains");
});

test("合法子页原样保留，非法值 / 空值回落到转发链", () => {
  for (const section of CHAIN_SECTIONS) {
    assert.equal(isChainSection(section), true);
    assert.equal(resolveChainSection(section), section);
  }
  for (const value of [null, undefined, "", "Templates", "chain", "template", "0"]) {
    assert.equal(isChainSection(value), false);
    assert.equal(resolveChainSection(value), "chains");
  }
  // 原型链上的键不是子页。
  assert.equal(resolveChainSection("toString"), "chains");
});

test("默认子页不写 URL 参数，其它子页写 ?section=", () => {
  assert.equal(chainSectionParam("chains"), null);
  assert.equal(chainSectionParam("templates"), "templates");
  assert.equal(chainSectionParam("usage"), "usage");
});

test("旧转发用量页地址指向链路时延的用量子页", () => {
  assert.equal(CHAIN_USAGE_URL, "/?view=chain&section=usage");
});

test("切换子页只改 section，保留 view / servers / range", () => {
  const params = new URLSearchParams("view=chain&servers=a,b&range=7d");
  const next = applyChainSection(params, "templates");

  assert.equal(next.get("view"), "chain");
  assert.equal(next.get("servers"), "a,b");
  assert.equal(next.get("range"), "7d");
  assert.equal(next.get("section"), "templates");
  // 不修改原对象
  assert.equal(params.get("section"), null);
});

test("切回转发链删除 section，不影响其它参数", () => {
  const params = new URLSearchParams("view=chain&section=templates&servers=a");
  const next = applyChainSection(params, "chains");

  assert.equal(next.get("section"), null);
  assert.equal(next.get("view"), "chain");
  assert.equal(next.get("servers"), "a");
});

test("切到模板 / 用量子页清掉 chain 深链，切回转发链不重弹旧详情", () => {
  const params = new URLSearchParams("view=chain&section=chains&chain=abc");
  for (const section of ["templates", "usage"]) {
    const next = applyChainSection(params, section);
    assert.equal(next.get("section"), section);
    assert.equal(next.get("chain"), null, `${section} must drop the deep link`);
  }

  // 停在转发链时不动已有深链。
  const stay = applyChainSection(params, "chains");
  assert.equal(stay.get("chain"), "abc");
});

test("切子页不覆盖链路筛选 status / q / series", () => {
  const params = new URLSearchParams(
    `view=chain&section=chains&status=blocked&q=${encodeURIComponent("港日")}&${CHAIN_SERIES_PARAM}=a,b&servers=s1&range=7d`,
  );
  for (const section of ["templates", "usage", "chains"]) {
    const next = applyChainSection(params, section);
    assert.equal(next.get("status"), "blocked", `status lost on ${section}`);
    assert.equal(next.get("q"), "港日", `q lost on ${section}`);
    assert.equal(next.get(CHAIN_SERIES_PARAM), "a,b", `series lost on ${section}`);
    assert.equal(next.get("servers"), "s1");
    assert.equal(next.get("range"), "7d");
  }
});

test("改筛选不覆盖 section / series", () => {
  const params = new URLSearchParams(
    `view=chain&section=usage&${CHAIN_SERIES_PARAM}=a,b&servers=s1`,
  );
  const next = applyChainListFilters(params, { status: "blocked", q: "hk" });

  assert.equal(next.get("section"), "usage");
  assert.equal(next.get(CHAIN_SERIES_PARAM), "a,b");
  assert.equal(next.get("servers"), "s1");
  assert.equal(next.get("status"), "blocked");
  assert.equal(next.get("q"), "hk");
});

test("离开链路时延 tab 清理 section，切到其它 tab 不留脏参数", () => {
  for (const view of ["server", "traffic", "cost"]) {
    for (const section of ["chains", "templates", "usage"]) {
      const params = new URLSearchParams(
        `view=chain&section=${section}&servers=a,b`,
      );
      const next = applyOverviewView(params, view);
      assert.equal(next.get("view"), view === "server" ? null : view);
      assert.equal(next.get("section"), null, `section must not follow ${view}`);
      assert.equal(next.get("servers"), "a,b");
    }
  }
  // 停留在链路时延 tab 时保留子页。
  for (const section of ["templates", "usage"]) {
    const stay = applyOverviewView(
      new URLSearchParams(`view=chain&section=${section}`),
      "chain",
    );
    assert.equal(stay.get("section"), section);
  }
});
