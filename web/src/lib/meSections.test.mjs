import assert from "node:assert/strict";
import test from "node:test";
import {
  ME_SECTION_IDS,
  activeSection,
  meSections,
  sectionTitleKey,
} from "./meSections.ts";

test("meSections keeps the documented order and paths", () => {
  const sections = meSections();
  assert.deepEqual(
    sections.map((section) => section.id),
    ["overview", "subscription", "forwards", "packages"],
  );
  assert.deepEqual(
    sections.map((section) => section.path),
    ["/me", "/me/subscription", "/me/forwards", "/me/packages"],
  );
  // 顶部标签顺序必须与 ID 常量一致，避免两处手工维护后漂移。
  assert.deepEqual(
    sections.map((section) => section.id),
    [...ME_SECTION_IDS],
  );
  assert.equal(sections.length, 4);
  // 每个入口都要有独立的标签键与页面标题键。
  for (const section of sections) {
    assert.match(section.labelKey, /^me\.tabs\./);
    assert.match(section.titleKey, /^me\.pages\./);
  }
});

test("meSections returns a stable read-only snapshot", () => {
  const first = meSections();
  const second = meSections();
  assert.equal(first, second);
  assert.throws(() => {
    first.push({ id: "bogus" });
  }, TypeError);
});

test("activeSection matches /me exactly instead of as a prefix", () => {
  // 关键回归点：`/me` 是 `/me/subscription` 的前缀，不能把订阅页点亮成概览。
  assert.equal(activeSection("/me")?.id, "overview");
  assert.equal(activeSection("/me/subscription")?.id, "subscription");
  assert.equal(activeSection("/me/forwards")?.id, "forwards");
  assert.equal(activeSection("/me/packages")?.id, "packages");
  // 未知子路径不回落成概览，标签全部保持未激活。
  assert.equal(activeSection("/me/unknown"), null);
  assert.equal(activeSection("/me/subscription/extra"), null);
});

test("activeSection ignores trailing slashes", () => {
  assert.equal(activeSection("/me/")?.id, "overview");
  assert.equal(activeSection("/me/subscription/")?.id, "subscription");
  assert.equal(activeSection("/me/forwards//")?.id, "forwards");
});

test("activeSection rejects non-me paths", () => {
  assert.equal(activeSection("/"), null);
  assert.equal(activeSection("/me2"), null);
  assert.equal(activeSection("/settings"), null);
  assert.equal(activeSection(""), null);
});

test("sectionTitleKey returns a distinct i18n key for every page", () => {
  assert.equal(sectionTitleKey("overview"), "me.pages.overview.title");
  assert.equal(sectionTitleKey("subscription"), "me.pages.subscription.title");
  assert.equal(sectionTitleKey("forwards"), "me.pages.forwards.title");
  assert.equal(sectionTitleKey("packages"), "me.pages.packages.title");

  const keys = ME_SECTION_IDS.map((id) => sectionTitleKey(id));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((key) => key.startsWith("me.pages.")));
});
