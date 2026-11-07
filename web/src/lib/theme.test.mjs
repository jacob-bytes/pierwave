import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_THEME,
  isThemeMode,
  resolveThemeMode,
  THEME_STORAGE_KEY,
} from "./theme.ts";

test("isThemeMode accepts only the three supported choices", () => {
  assert.equal(isThemeMode("light"), true);
  assert.equal(isThemeMode("dark"), true);
  assert.equal(isThemeMode("system"), true);

  assert.equal(isThemeMode(""), false);
  assert.equal(isThemeMode("auto"), false);
  assert.equal(isThemeMode("LIGHT"), false);
  assert.equal(isThemeMode(null), false);
  assert.equal(isThemeMode(undefined), false);
});

test("resolveThemeMode keeps explicit choices independent of the system", () => {
  assert.equal(resolveThemeMode("light", false), "light");
  assert.equal(resolveThemeMode("light", true), "light");
  assert.equal(resolveThemeMode("dark", false), "dark");
  assert.equal(resolveThemeMode("dark", true), "dark");
});

test("resolveThemeMode follows prefers-color-scheme for system", () => {
  assert.equal(resolveThemeMode("system", true), "dark");
  assert.equal(resolveThemeMode("system", false), "light");
});

test("default theme stays dark so existing dark screenshots keep working", () => {
  assert.equal(DEFAULT_THEME, "dark");
  assert.equal(THEME_STORAGE_KEY, "pierwave.theme");
});
