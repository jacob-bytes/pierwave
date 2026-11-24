import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAIN_SECTIONS,
  DEFAULT_CHAIN_SECTION,
  applyChainSection,
  chainSectionParam,
  isChainSection,
  resolveChainSection,
} from "./chainSections.ts";
import { applyOverviewView } from "./overviewViews.ts";

test("链路时延子页顺序与默认值是转发链", () => {
  assert.deepEqual(CHAIN_SECTIONS, ["chains", "templates"]);
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

test("默认子页不写 URL 参数，模板子页写 ?section=", () => {
  assert.equal(chainSectionParam("chains"), null);
  assert.equal(chainSectionParam("templates"), "templates");
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

test("切到模板子页清掉 chain 深链，切回转发链不重弹旧详情", () => {
  const params = new URLSearchParams("view=chain&section=chains&chain=abc");
  const templates = applyChainSection(params, "templates");
  assert.equal(templates.get("section"), "templates");
  assert.equal(templates.get("chain"), null);

  // 停在转发链时不动已有深链。
  const stay = applyChainSection(params, "chains");
  assert.equal(stay.get("chain"), "abc");
});

test("离开链路时延 tab 清理 section，切到其它 tab 不留脏参数", () => {
  for (const view of ["server", "traffic", "cost"]) {
    const params = new URLSearchParams(
      "view=chain&section=templates&servers=a,b",
    );
    const next = applyOverviewView(params, view);
    assert.equal(next.get("view"), view === "server" ? null : view);
    assert.equal(next.get("section"), null, `section must not follow ${view}`);
    assert.equal(next.get("servers"), "a,b");
  }
  // 停留在链路时延 tab 时保留子页。
  const stay = applyOverviewView(
    new URLSearchParams("view=chain&section=templates"),
    "chain",
  );
  assert.equal(stay.get("section"), "templates");
});
