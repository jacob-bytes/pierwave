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

const kpi = read("components/overview/ChainKpi.tsx");
const templateKpi = read("components/overview/ChainTemplateKpis.tsx");
const templateList = read("components/overview/ChainTemplateInsightList.tsx");
const chainList = read("components/overview/ChainLatencyList.tsx");
const zh = read("i18n/zh-CN.ts");
const en = read("i18n/en.ts");

test("两个子页共用同一套 KPI 栅格：2×2（≥sm 4 列）、1px 分隔、28px 数字、13px 副行", () => {
  assert.match(kpi, /grid-cols-2/);
  assert.match(kpi, /sm:grid-cols-4/);
  assert.match(kpi, /gap-px/);
  assert.match(kpi, /bg-border/);
  assert.match(kpi, /min-w-0/);
  assert.match(kpi, /px-3 py-4 sm:px-5/);
  assert.match(kpi, /text-\[28px\]/);
  assert.match(kpi, /text-\[13px\]/);
  // 副行必须允许长英文换行，不能把卡片撑出横向滚动。
  assert.match(kpi, /line-clamp-2/);
  assert.match(kpi, /break-words/);
  // 转发链 KPI 也必须走同一份实现，不再自己维护一份字号。
  assert.match(chainList, /ChainKpiGrid/);
  assert.match(chainList, /ChainKpiCell/);
  assert.match(chainList, /<ChainKpiGrid data-chain-kpis>/);
  assert.doesNotMatch(chainList, /text-xl/);
});

test("模板子页四格 KPI 存在，且各自绑定一卡一问的标签 / 数值 / 副行", () => {
  assert.match(templateKpi, /data-chain-template-kpis/);
  for (const kind of ["total", "in-use", "users", "abnormal"]) {
    assert.match(templateKpi, new RegExp(`data-template-kpi="${kind}"`));
  }
  for (const key of [
    "kpiTotal",
    "kpiInUse",
    "kpiUsers",
    "kpiAbnormal",
    "kpiTotalValue",
    "kpiInUseValue",
    "kpiUsersValue",
    "kpiAbnormalValue",
    "kpiTotalHint",
    "kpiInUseHint",
    "kpiUsersHint",
    "kpiAbnormalHint",
  ]) {
    assert.ok(
      templateKpi.includes(`overview.chainTemplateInsight.${key}`),
      `component missing ${key}`,
    );
    assert.ok(
      zh.includes(`      ${key}:`),
      `zh-CN missing ${key}`,
    );
    assert.ok(en.includes(`      ${key}:`), `en missing ${key}`);
  }
});

test("异常模板：blocked 红、只有 degraded 黄、0 保持正常色", () => {
  assert.match(
    templateKpi,
    /view\.blocked > 0 \? "destructive" : view\.degraded > 0 \? "warning" : "muted"/,
  );
  assert.match(templateKpi, /tone=\{empty \? "muted" : abnormalTone\}/);
  assert.match(kpi, /destructive: "text-destructive"/);
  assert.match(kpi, /warning: "text-warning"/);
});

test("空态与降级态都用 —，不显示 0；KPI 与列表共用同一份状态", () => {
  assert.match(templateKpi, /const DASH = "—"/);
  assert.match(templateKpi, /const empty = state !== "ready"/);
  assert.match(templateKpi, /empty\s*\?\s*DASH/);
  assert.match(templateKpi, /data-state=\{state\}/);
  assert.match(templateList, /const state: ChainTemplateKpiState =/);
  assert.match(
    templateList,
    /query\.isError \|\| snapshot === null\s*\? "unavailable"/,
  );
  assert.match(templateList, /items\.length === 0\s*\? "empty"/);
  assert.match(templateList, /<ChainTemplateKpis items=\{items\} state=\{state\}/);
  assert.match(templateList, /data-chain-template-page/);
});

test("加载中先铺同栅格骨架，列表仍保留原有骨架行", () => {
  assert.match(templateKpi, /export function ChainTemplateKpisSkeleton/);
  assert.match(templateKpi, /data-chain-template-kpis-skeleton/);
  assert.match(templateKpi, /data-chain-template-kpi-skeleton/);
  assert.match(templateKpi, /length: 4/);
  assert.match(templateList, /loading \? \(\s*<ChainTemplateKpisSkeleton \/>/);
  assert.match(templateList, /data-chain-template-skeleton/);
});

test("列表行暴露聚合所需的 enabled / chains / users / status", () => {
  assert.match(templateList, /data-template-enabled=\{item\.enabled/);
  assert.match(templateList, /data-template-chains=\{item\.chains\}/);
  assert.match(templateList, /data-template-users=\{item\.users\}/);
  assert.match(templateList, /data-status=\{item\.status\.kind\}/);
  assert.match(templateList, /data-chain-template-list/);
});
