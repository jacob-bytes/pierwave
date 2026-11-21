import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * hero 迷你图的源码形状守卫。
 *
 * 纯几何 / 数据整理已经有 `sparkline.test.mjs` 与 `heroSeries.test.mjs` 覆盖；
 * 这一层只钉住三件在 DOM 里才能看出来、但没有浏览器测试环境的事：
 * - 三个 KPI 下正好三张图，顺序与 KPI 一致；
 * - 布局在 1440 三列等宽、<md 堆叠；
 * - 图本身保持克制（1px、20/24px、无坐标轴 / 网格 / 图例），空态用虚线而不是 0 平线。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

function read(relative) {
  return readFileSync(path.join(HERE, relative), "utf8");
}

test("hero renders exactly three mini charts, in KPI order", () => {
  const hero = read("../components/status/Hero.tsx");
  assert.equal((hero.match(/<HeroSparkline/g) ?? []).length, 3);
  const kinds = [...hero.matchAll(/<HeroSparkline\s+kind="(\w+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(kinds, ["latency", "uptime", "rate"]);
});

test("hero keeps three equal columns but leaves breathing room for the verdict", () => {
  const hero = read("../components/status/Hero.tsx");
  // KPI 区在 lg 上封顶 50rem（1440 下每列约 243px），靠右，不把整行塞满。
  assert.match(hero, /lg:max-w-\[50rem\]/);
  assert.match(hero, /lg:flex-1/);
  assert.match(hero, /lg:justify-between/);
  // 结论句可以长到 32rem；旧的 24rem 上限和 34rem 固定 KPI 宽度都不能回来。
  assert.match(hero, /lg:max-w-\[32rem\]/);
  assert.doesNotMatch(hero, /lg:max-w-\[24rem\]/);
  assert.doesNotMatch(hero, /34rem/);
  assert.match(hero, /md:grid-cols-3/);
  // <md：单列堆叠 + 行间分隔线，不再横向三列。
  assert.match(hero, /grid-cols-1/);
  assert.match(hero, /divide-y divide-border/);
  assert.match(hero, /md:divide-y-0/);
});

test("mini charts are footnotes: 1px line, 20/24px tall, no axes or legend", () => {
  const spark = read("../components/status/HeroSparkline.tsx");
  assert.match(spark, /strokeWidth=\{1\}/);
  assert.doesNotMatch(spark, /strokeWidth=\{1\.5\}/);
  assert.doesNotMatch(spark, /recharts|CartesianGrid|XAxis|YAxis|Legend/);
  // 20px（手机）/ 24px（桌面）：是数字的注脚，不是独立图表。
  assert.match(spark, /h-5/);
  assert.match(spark, /md:h-6/);
  assert.doesNotMatch(spark, /md:h-12/);
  // 面积只在速率图出现，且保持很淡。
  assert.match(spark, /stopOpacity="0\.14"/);
});

test("the uptime KPI drops its progress bar and the word \"average\"", () => {
  const hero = read("../components/status/Hero.tsx");
  // 进度条与折线表达同一段历史，删掉条，也不给另外两张图加装饰。
  assert.doesNotMatch(hero, /AVAILABILITY_BAR_CLASS|availabilityFill/);
  assert.doesNotMatch(hero, /role="progressbar"/);
  assert.doesNotMatch(hero, /foot=/);
  assert.doesNotMatch(hero, /mt-2 h-1/);

  // 标签改为「24h 可用率」/「24h uptime」；数值仍是平均值，标签不再写「平均」。
  assert.match(hero, /t\("publicStatus\.hero\.averageUptime"\)/);
  assert.match(read("../i18n/zh-CN.ts"), /averageUptime: "24h 可用率"/);
  assert.match(read("../i18n/en.ts"), /averageUptime: "24h uptime"/);
  assert.doesNotMatch(read("../i18n/zh-CN.ts"), /平均 24h 可用率/);
});

test("no data renders a dashed baseline instead of a zero line", () => {
  const spark = read("../components/status/HeroSparkline.tsx");
  assert.match(spark, /data-state="empty"/);
  assert.match(spark, /data-state="ready"/);
  assert.match(spark, /border-dashed/);
  // 「画不画」取决于几何里有没有可画线段，而不是数值是否为 0。
  assert.match(spark, /line\.path !== null/);
  assert.match(spark, /publicStatus\.hero\.chartEmpty/);
});

test("uptime uses a fixed 0–100% axis, rate stays zero-based", () => {
  const spark = read("../components/status/HeroSparkline.tsx");
  assert.match(spark, /domain: \[0, 1\] as const/);
  assert.match(spark, /zeroBased: kind === "rate"/);
});

test("both locales carry the three chart labels and the empty label", () => {
  const locales = {
    zh: read("../i18n/zh-CN.ts"),
    en: read("../i18n/en.ts"),
  };
  for (const [locale, source] of Object.entries(locales)) {
    for (const key of [
      "chartEmpty",
      "rateChart",
      "latencyChart",
      "uptimeChart",
    ]) {
      assert.match(
        source,
        new RegExp(`\\b${key}:`),
        `${locale} 缺少 ${key}`,
      );
    }
  }
});

test("hero tolerates an old backend without series", () => {
  const hero = read("../components/status/Hero.tsx");
  const page = read("../pages/Status.tsx");
  assert.match(hero, /series\?: PublicStatusSeries \| null/);
  // 根级 `series` 是契约位置；旧后端没有该字段时传 null → 空态。
  assert.match(page, /series=\{data\.series \?\? null\}/);
});

test("all three KPI numbers share the 19/28px scale and 12px units", () => {
  const hero = read("../components/status/Hero.tsx");
  // 速率不再是最小的 16px 数值；三个数字都走 19px（<640）/ 28px（≥640）。
  assert.doesNotMatch(hero, /text-base leading-none font-semibold/);
  assert.ok(
    (hero.match(/text-\[19px\] leading-none font-semibold[^"]*sm:text-\[28px\]/g) ?? [])
      .length >= 3,
    "延迟 / 可用率 / 速率都要用同一档数值字号",
  );
  // 速率值整体不换行；放不下时让两个方向换行，而不是缩字号。
  assert.match(
    hero,
    /text-\[19px\] leading-none font-semibold whitespace-nowrap sm:text-\[28px\]/,
  );
  // `%` 从 30px 数字里拆出来，和 ms / MB\/s 一样是 12px muted。
  assert.match(
    hero,
    /text-xs font-normal text-muted-foreground[\s\S]{0,80}>\s*%\s*</,
  );
  assert.match(
    hero,
    /text-xs font-normal text-muted-foreground[\s\S]{0,80}>\s*ms\s*</,
  );
});

test("uptime number and chart share one sample source", () => {
  const hero = read("../components/status/Hero.tsx");
  // buckets 全空时，数字也显示 —：不能出现「100% + 数据收集中」。
  assert.match(hero, /const uptimeHasSamples = uptimeChart\.values\.some/);
  assert.match(hero, /averagePercentText = uptimeHasSamples/);
  assert.match(hero, /averageTone = uptimeHasSamples/);
  assert.match(hero, /availabilityPercentText\(averageUptime\)/);
});

test("sparkline is keyboard reachable and exposes the tooltip to AT", () => {
  const spark = read("../components/status/HeroSparkline.tsx");
  assert.match(spark, /tabIndex=\{0\}/);
  assert.match(spark, /onKeyDown=\{onKeyDown\}/);
  assert.match(spark, /event\.key === "ArrowLeft"/);
  assert.match(spark, /event\.key === "ArrowRight"/);
  assert.match(spark, /event\.key === "Escape"/);
  assert.match(
    spark,
    /aria-describedby=\{active === null \? undefined : tooltipId\}/,
  );
  assert.match(spark, /aria-live="polite"/);
  assert.doesNotMatch(
    spark,
    /aria-hidden="true"\s+data-slot="hero-sparkline-tooltip"/,
  );
  // 全站统一焦点环会命中 [tabindex]，这里不另造焦点色。
  assert.doesNotMatch(spark, /focus-visible:ring|outline-\[/);
});

test("rate chart floors nonzero values and keeps 0 on the baseline", () => {
  const spark = read("../components/status/HeroSparkline.tsx");
  assert.match(spark, /minNonZeroGap: 3/);
  assert.match(spark, /const HEIGHT = 24/);
});

test("empty label is readable: 11px, opaque muted", () => {
  const spark = read("../components/status/HeroSparkline.tsx");
  assert.match(spark, /text-\[11px\]/);
  assert.doesNotMatch(spark, /text-\[9px\]/);
  assert.match(
    spark,
    /bg-card px-1 text-\[11px\] leading-none text-muted-foreground/,
  );
});

test("the verdict is one weight step heavier without changing size", () => {
  const hero = read("../components/status/Hero.tsx");
  // 只提字重：字号、字距、颜色都不动。
  assert.match(
    hero,
    /text-lg leading-snug font-semibold tracking-tight text-pretty sm:text-xl/,
  );
  assert.doesNotMatch(hero, /font-medium/);
});
