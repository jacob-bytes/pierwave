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
 * - 图本身保持克制（1.5px、无坐标轴 / 网格 / 图例），空态用虚线而不是 0 平线。
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

test("hero keeps three flexible columns and stacks below md", () => {
  const hero = read("../components/status/Hero.tsx");
  // KPI 区吃掉结论以外的宽度，三列等分；结论只按内容占宽（上限 24rem）。
  assert.match(hero, /lg:flex-1/);
  assert.match(hero, /lg:max-w-\[24rem\]/);
  assert.match(hero, /md:grid-cols-3/);
  // <md：单列堆叠 + 行间分隔线，不再横向三列。
  assert.match(hero, /grid-cols-1/);
  assert.match(hero, /divide-y divide-border/);
  assert.match(hero, /md:divide-y-0/);
  // 旧的固定宽度会把三列挤到 157px，不能回来。
  assert.doesNotMatch(hero, /34rem/);
});

test("mini charts stay restrained: 1.5px, no axes, grid or legend", () => {
  const spark = read("../components/status/HeroSparkline.tsx");
  assert.match(spark, /strokeWidth=\{1\.5\}/);
  assert.doesNotMatch(spark, /recharts|CartesianGrid|XAxis|YAxis|Legend/);
  // 40px（手机）/ 48px（桌面），都在需求给的 40–56px 内。
  assert.match(spark, /h-10/);
  assert.match(spark, /md:h-12/);
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
