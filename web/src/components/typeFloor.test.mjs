/**
 * 字号下限的源码级防回归测试。
 *
 * Source-level regression guard for the 11px type floor documented in
 * `docs/DESIGN.md` (section「字号 / Typography」). It scans `web/src` and
 * rejects any UI text below 11px:
 *
 * - Tailwind arbitrary text sizes: `text-[8px] / [9px] / [10px]`（含 `sm:` 等变体）
 * - inline chart text: `fontSize: 9 / 10`（含小数，例如 10.5）
 * - CSS/`style` 里的 `font-size: 10px` 之类声明
 *
 * 允许 11 / 12 / 13 / 14px 四档；13px 只用于「需要被读的次要数据」
 * （列表第二行、表格非主列、详情字段、空态/错误态正文）。没有白名单：
 * 图表刻度也统一 11px 起，`.type-micro` 必须保持 12px。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.basename(fileURLToPath(import.meta.url));
const EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      files.push(...walk(full));
    } else if (EXTENSIONS.has(path.extname(entry))) {
      files.push(full);
    }
  }
  return files;
}

const files = walk(SRC).filter((file) => path.basename(file) !== SELF);

/** 所有字号声明：Tailwind 任意值 / inline fontSize / CSS font-size。 */
function violationsIn(file) {
  const source = readFileSync(file, "utf8");
  const found = [];
  const relative = path.relative(SRC, file);
  const add = (line, kind, value) => {
    found.push({ file: relative, line, kind, value });
  };

  source.split("\n").forEach((text, index) => {
    const line = index + 1;
    for (const match of text.matchAll(/text-\[([\d.]+)px\]/g)) {
      const value = Number.parseFloat(match[1]);
      if (Number.isFinite(value) && value < 11) {
        add(line, "tailwind", match[0]);
      }
    }
    for (const match of text.matchAll(/fontSize\s*:\s*([\d.]+)/g)) {
      const value = Number.parseFloat(match[1]);
      if (Number.isFinite(value) && value < 11) {
        add(line, "inline", match[0]);
      }
    }
    for (const match of text.matchAll(/font-size\s*:\s*([\d.]+)px/g)) {
      const value = Number.parseFloat(match[1]);
      if (Number.isFinite(value) && value < 11) {
        add(line, "css", match[0]);
      }
    }
  });
  return found;
}

test("source guard scans the real web/src tree", () => {
  assert.ok(files.length > 200, `only scanned ${files.length} files`);
  assert.ok(
    files.some((file) => file.endsWith("index.css")),
    "index.css must be part of the scan",
  );
});

test("no UI text below 11px in web/src", () => {
  const violations = files.flatMap(violationsIn);
  assert.deepEqual(
    violations,
    [],
    violations
      .map((item) => `${item.file}:${item.line} ${item.kind} ${item.value}`)
      .join("\n"),
  );
});

test(".type-micro stays at the 12px supporting-text step", () => {
  const css = readFileSync(path.join(SRC, "index.css"), "utf8");
  const match = css.match(/\.type-micro\s*\{\s*font-size:\s*([\d.]+)px;/);
  assert.ok(match, ".type-micro font-size must be declared");
  assert.equal(Number.parseFloat(match[1]), 12);
});
