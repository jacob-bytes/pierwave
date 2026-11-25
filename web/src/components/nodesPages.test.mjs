/**
 * 节点相关页面的源码级回归：卡片 / 页头 / 进场动画 / 版本文案 / 窄屏形态。
 *
 * 这些是跨文件的视觉约定（`Card`、`PageHeader`、`animate-enter`），
 * 用源码断言守住，避免以后又写回手写卡片或另一套页面头部。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(SRC, file), "utf8");

test("NodesIndex builds server cards from the shared Card, not hand-written borders", () => {
  const source = read("pages/NodesIndex.tsx");

  assert.match(source, /import \{ Card, CardContent \} from "@\/components\/ui\/card"/);
  assert.ok(
    source.includes('<Card className="h-full gap-0 p-4'),
    "the clickable server card uses the shared Card",
  );
  assert.ok(
    !source.includes("border border-border bg-card"),
    "no hand-written card border/background",
  );
  assert.ok(
    !source.includes("hover:border-primary/40"),
    "hover state follows Card's ring instead of adding a border",
  );
});

test("NodesIndex and Nodes share the PageHeader and animate-enter", () => {
  for (const file of ["pages/NodesIndex.tsx", "pages/Nodes.tsx"]) {
    const source = read(file);
    assert.ok(source.includes("PageHeader"), `${file} imports and renders PageHeader`);
    assert.match(source, /<PageHeader/, `${file} renders the shared PageHeader`);
    assert.ok(
      source.includes('className="animate-enter space-y-6"'),
      `${file} enters with animate-enter`,
    );
    assert.ok(
      !source.includes("animate-in"),
      `${file} no longer uses the old animate-in entrance`,
    );
  }
});

test("the config version badge says 配置 vN instead of a bare vN", () => {
  const index = read("pages/NodesIndex.tsx");
  const nodes = read("pages/Nodes.tsx");

  for (const source of [index, nodes]) {
    assert.ok(
      source.includes('t("servers.configVersion"'),
      "config version reuses the shared label",
    );
    assert.ok(
      !source.includes("v{server.config_version}"),
      "no bare vN badge is left behind",
    );
  }

  // 与 Agent 版本区分：节点页徽章带「配置版本」tooltip。
  assert.ok(
    nodes.includes('title={t("servers.detail.configVersion")}'),
    "the node page badge explains it is the config version",
  );
  assert.equal(zh.servers.configVersion, "配置 v{version}");
  assert.equal(en.servers.configVersion, "Config v{version}");
  assert.equal(zh.servers.detail.configVersion, "配置版本");
  assert.equal(en.servers.detail.configVersion, "Config version");
});

test("Nodes renders mobile cards instead of the table at narrow widths", () => {
  const source = read("pages/Nodes.tsx");

  assert.ok(source.includes("useIsDesktop"), "the page picks the layout from the breakpoint");
  assert.match(source, /\{isDesktop \? \(/, "desktop table is gated behind isDesktop");
  assert.ok(
    source.includes("{!nodes.isPending && !isDesktop ? ("),
    "mobile card list renders only below the breakpoint",
  );
  assert.ok(
    source.includes("<MobileDataCard"),
    "narrow screens use the shared MobileDataCard",
  );
  assert.ok(
    source.includes("moreFields={"),
    "config fields use MobileDataCard's collapsible moreFields",
  );
  for (const label of [
    't("nodes.columns.port")',
    't("nodes.traffic.column")',
    't("nodes.columns.updatedAt")',
  ]) {
    assert.ok(
      source.includes(label),
      `config field ${label} lives in the More section`,
    );
  }
  assert.ok(
    !/<Table[^>]*className="[^"]*hidden[^"]*"/.test(source),
    "the table is not merely hidden with CSS",
  );
});

test("the desktop node table keeps the name and action columns sticky", () => {
  const source = read("pages/Nodes.tsx");

  assert.ok(source.includes('<TableCell sticky="left"'), "name column sticks left");
  assert.ok(source.includes('<TableCell sticky="right"'), "actions column sticks right");
  assert.ok(
    /index === COLUMN_COUNT - 1\s*\?\s*"right"/.test(source),
    "the last header sticks right",
  );
  assert.ok(
    /index === 0\s*\?\s*"left"/.test(source),
    "the first header sticks left",
  );
});

test("node mobile copy is bilingual", () => {
  assert.equal(zh.common.showMore, "更多");
  assert.equal(en.common.showMore, "More");
  assert.equal(zh.nodes.speedLimit.label, "限速");
  assert.equal(en.nodes.speedLimit.label, "Speed limit");
});
