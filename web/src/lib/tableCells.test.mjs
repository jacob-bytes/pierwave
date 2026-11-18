import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { alignClass, ID_CELL, NUMERIC_CELL, NUMERIC_HEAD } from "./tableCells.ts";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

test("numeric cells are right aligned and use tabular figures", () => {
  assert.match(NUMERIC_CELL, /\btext-right\b/);
  assert.match(NUMERIC_CELL, /\btabular-nums\b/);
  assert.match(NUMERIC_HEAD, /\btext-right\b/);
});

test("id / address cells stay left aligned and monospace", () => {
  assert.match(ID_CELL, /\btext-left\b/);
  assert.match(ID_CELL, /\bfont-mono\b/);
  assert.doesNotMatch(ID_CELL, /\btext-right\b/);
});

test("alignClass maps the three column kinds", () => {
  assert.equal(alignClass("numeric"), NUMERIC_CELL);
  assert.equal(alignClass("id"), ID_CELL);
  assert.equal(alignClass("text"), undefined);
});

/** 数值列覆盖：每个页面至少有一处「右对齐 + 等宽数字」，且带对应的表头。 */
const NUMERIC_FILES = {
  "pages/Servers.tsx": [
    // 负载 / 内存 / 速率三列表头右对齐
    "hidden text-right xl:table-cell",
    "text-right xl:table-cell",
  ],
  "pages/Packages.tsx": [
    // 额度 / 周期 / 倍率三个单元格
    "text-right font-mono text-xs tabular-nums",
    "text-right text-xs tabular-nums",
  ],
  "pages/Users.tsx": ["px-4 text-right", 'align="end"'],
  "pages/Subscriptions.tsx": ["px-4 text-right", 'align="end"'],
};

test("numeric columns keep text-right + tabular-nums in every covered page", () => {
  for (const [file, patterns] of Object.entries(NUMERIC_FILES)) {
    const source = read(`../${file}`);
    for (const pattern of patterns) {
      assert.ok(
        source.includes(pattern),
        `${file} is missing numeric alignment pattern: ${pattern}`,
      );
    }
  }
  // 流量条本身负责等宽数字，避免各页面重复写 tabular-nums。
  const usageBar = read("../components/UsageBar.tsx");
  assert.ok(usageBar.includes("tabular-nums"));
  assert.ok(usageBar.includes('align === "end"'));
});

test("servers memory / rate / load cells align their content to the right", () => {
  const source = read("../pages/Servers.tsx");
  assert.ok(source.includes('className="flex items-center justify-end gap-2"'));
  assert.ok(
    source.includes(
      'className="inline-flex items-center justify-end gap-2 whitespace-nowrap"',
    ),
  );
});

test("table rows share the 40px baseline and cells use the matching padding", () => {
  const source = read("../components/ui/table.tsx");
  assert.match(source, /"(?:[^"]*\s)?h-10\s/, "TableRow must carry h-10");
  assert.ok(
    source.includes("px-2 py-1.5"),
    "TableCell default padding must be py-1.5 so 28px actions fit 40px rows",
  );
});

test("multi-line tables were compacted into single-line rows", () => {
  const users = read("../pages/Users.tsx");
  // 身份列：名字与 short_code 同一行（不再堆两行）
  assert.ok(users.includes("items-baseline gap-1.5"));
  assert.ok(!users.includes("flex min-w-0 flex-col gap-1"));

  const chains = read("../pages/Chains.tsx");
  assert.match(chains, /renderChainName\(chain, true\)/);
  assert.match(chains, /renderChainGroups\(chain, false, true\)/);

  const nodes = read("../pages/Nodes.tsx");
  assert.match(nodes, /items-center gap-1\.5/);
  assert.match(nodes, /nodeMetaTitle\(node\)/);
});
