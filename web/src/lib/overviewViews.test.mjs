import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OVERVIEW_VIEW,
  OVERVIEW_VIEWS,
  applyOverviewView,
  isOverviewView,
  overviewViewParam,
  resolveOverviewView,
} from "./overviewViews.ts";

test("概览视图顺序与默认值是资源状态", () => {
  assert.deepEqual(OVERVIEW_VIEWS, ["server", "traffic", "cost", "chain"]);
  assert.equal(DEFAULT_OVERVIEW_VIEW, "server");
});

test("合法视图原样保留，非法值 / 空值回落到资源状态", () => {
  for (const view of OVERVIEW_VIEWS) {
    assert.equal(isOverviewView(view), true);
    assert.equal(resolveOverviewView(view), view);
  }
  for (const value of [null, undefined, "", "Server", "costs", "0"]) {
    assert.equal(isOverviewView(value), false);
    assert.equal(resolveOverviewView(value), "server");
  }
});

test("默认视图不写 URL 参数，其它视图写 ?view=", () => {
  assert.equal(overviewViewParam("server"), null);
  assert.equal(overviewViewParam("traffic"), "traffic");
  assert.equal(overviewViewParam("cost"), "cost");
  assert.equal(overviewViewParam("chain"), "chain");
});

test("切到默认视图只删 view，保留其它查询参数", () => {
  const params = new URLSearchParams("view=cost&range=7d&q=hk");
  const next = applyOverviewView(params, "server");

  assert.equal(next.get("view"), null);
  assert.equal(next.get("range"), "7d");
  assert.equal(next.get("q"), "hk");
  // 不修改原对象
  assert.equal(params.get("view"), "cost");
});

test("切到非默认视图写入 view，并保留其它查询参数", () => {
  const params = new URLSearchParams("range=30d");
  const next = applyOverviewView(params, "chain");

  assert.equal(next.get("view"), "chain");
  assert.equal(next.get("range"), "30d");
  assert.equal(params.get("view"), null);
});

test("非法 ?view= 解析为 server，切走后参数被清掉", () => {
  const params = new URLSearchParams("view=bogus");
  const view = resolveOverviewView(params.get("view"));
  const next = applyOverviewView(params, view);

  assert.equal(view, "server");
  assert.equal(next.toString(), "");
});

test("server ↔ cost 往返不会留下重复的 view 参数", () => {
  let params = new URLSearchParams("");
  params = applyOverviewView(params, "cost");
  params = applyOverviewView(params, "server");
  params = applyOverviewView(params, "cost");

  assert.equal(params.getAll("view").length, 1);
  assert.equal(params.get("view"), "cost");
});

test("leaving the chain view drops the chain deep-link parameter", () => {
  const params = new URLSearchParams("view=chain&chain=abc&range=7d");
  const next = applyOverviewView(params, "cost");

  assert.equal(next.get("view"), "cost");
  assert.equal(next.get("chain"), null, "chain 深链不能跟到其它 tab");
  assert.equal(next.get("range"), "7d");
});

test("staying on the chain view keeps the deep-link parameter", () => {
  const params = new URLSearchParams("view=chain&chain=abc");
  const next = applyOverviewView(params, "chain");

  assert.equal(next.get("view"), "chain");
  assert.equal(next.get("chain"), "abc");
});
