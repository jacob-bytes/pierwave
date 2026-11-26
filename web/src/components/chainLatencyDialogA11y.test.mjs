import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

const DIALOGS = [
  {
    file: "components/overview/ChainLatencyDetailDialog.tsx",
    fallback: "data-chain-search",
    list: "data-chain-list",
  },
  {
    file: "components/overview/ChainTemplateInsightDialog.tsx",
    fallback: "data-chain-template-list",
    list: "data-chain-template-page",
  },
];

test("both chain dialogs move initial focus to the title, not a button", () => {
  for (const dialog of DIALOGS) {
    const source = read(dialog.file);
    assert.match(source, /onOpenAutoFocus=\{/, `${dialog.file}: missing hook`);
    assert.match(source, /\[data-slot="dialog-title"\]/, `${dialog.file}: title query`);
    // 标题可编程聚焦（-1），才不会进 Tab 序；焦点环只在键盘模态出现。
    assert.match(source, /<DialogTitle\s+tabIndex=\{-1\}/, `${dialog.file}: title tabIndex`);
    assert.match(source, /focus-visible:ring-2/, `${dialog.file}: title focus ring`);
    // 默认行为会落到关闭按钮，必须先 preventDefault。
    const hook = source.slice(source.indexOf("onOpenAutoFocus={"));
    assert.match(hook.slice(0, 400), /event\.preventDefault\(\)/);
  }
});

test("both chain dialogs remember the opener and return focus on close", () => {
  for (const dialog of DIALOGS) {
    const source = read(dialog.file);
    // 触发行在 layout effect 里抓取，此时 Dialog 的焦点陷阱还没把焦点移走。
    assert.match(source, /document\.activeElement/, `${dialog.file}: activeElement`);
    assert.match(source, /triggerRef/, `${dialog.file}: trigger ref`);
    assert.match(source, /onCloseAutoFocus=\{/, `${dialog.file}: close hook`);
    const hook = source.slice(source.indexOf("onCloseAutoFocus={"));
    assert.match(hook.slice(0, 1200), /event\.preventDefault\(\)/);
    assert.match(hook.slice(0, 1200), /focusAfterClose\(/, `${dialog.file}: restore call`);
    // 行没了时回退到搜索框 / 列表容器。
    assert.match(source, new RegExp(dialog.fallback), `${dialog.file}: fallback`);
    assert.match(source, new RegExp(dialog.list), `${dialog.file}: list fallback`);
    assert.match(source, /setAttribute\("tabindex", "-1"\)/, `${dialog.file}: focusable list`);
  }
});

test("StrictMode's fake unmount does not steal focus from the open dialog", () => {
  for (const dialog of DIALOGS) {
    const source = read(dialog.file);
    const hook = source.slice(source.indexOf("onCloseAutoFocus={"));
    assert.match(hook.slice(0, 600), /isOpenRef\.current/, `${dialog.file}: open guard`);
    assert.match(hook.slice(0, 600), /isConnected/, `${dialog.file}: DOM guard`);
  }
});

test("both trend SVGs expose a window- and selection-aware aria-label", () => {
  const charts = [
    {
      file: "components/overview/ChainLatencyTrendChart.tsx",
      key: "trendChartAria",
      count: "selectedChains.length",
    },
    {
      file: "components/overview/ChainSegmentTrendChart.tsx",
      key: "segmentChartAria",
      count: "visible.length",
    },
  ];
  for (const chart of charts) {
    const source = read(chart.file);
    // Recharts 的 SVG 是 role=application 的可聚焦节点；类型里没有
    // aria-label 属性，所以经 ref 写到真实节点上。
    assert.match(source, /setAttribute\("aria-label", chartLabel\)/, chart.file);
    assert.match(source, new RegExp(chart.key), `${chart.file}: label key`);
    assert.match(
      source,
      new RegExp(`n: ${chart.count.replace(/\./g, "\\.")}`),
      `${chart.file}: live count`,
    );
    // 窗口跟着 bucket 走：>=1h 为 7d，否则 24h。
    assert.match(source, /bucket(?:Secs)? >= 3_600/, `${chart.file}: window`);
    assert.match(source, /overview\.chainLatency\.range7d/, `${chart.file}: 7d`);
    assert.match(source, /overview\.chainLatency\.range24/, `${chart.file}: 24h`);
    assert.match(source, /ref=\{applyChartLabel\}/, `${chart.file}: svg ref`);
    // 外层 group 仍保留原有标签（已验收的行为不回退）。
    assert.match(source, /role="group"/);
    assert.match(source, /aria-label=\{t\(/);
  }
});

test("trend svg aria labels are bilingual and never empty", async () => {
  const [{ default: zh }, { default: en }] = await Promise.all([
    import("../i18n/zh-CN.ts"),
    import("../i18n/en.ts"),
  ]);
  for (const messages of [zh, en]) {
    for (const key of ["range24", "range7d", "trendChartAria", "segmentChartAria"]) {
      const value = messages.overview.chainLatency[key];
      assert.equal(typeof value, "string", `missing ${key}`);
      assert.ok(value.trim() !== "", `${key} must not be empty`);
    }
  }
  // 组合后的标签形如「… 条链 … · 24 小时」/「… chains … · 24 hours」。
  assert.match(zh.overview.chainLatency.trendChartAria, /\{n\}/);
  assert.match(en.overview.chainLatency.trendChartAria, /\{n\}/);
  assert.notEqual(
    zh.overview.chainLatency.range24,
    en.overview.chainLatency.range24,
  );
});
