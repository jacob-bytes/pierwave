import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ui/tabs.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

test("tab 面板不单独声明焦点环类：键盘焦点环由全局规则提供", () => {
  // 面板可聚焦，但环不在组件里声明：未被 @layer 包裹的全局规则优先级更高，
  // 键盘焦点进入面板时它负责 2px 环 + 2px 偏移。
  const content = source.split("function TabsContent")[1] ?? "";
  assert.doesNotMatch(content, /focus-visible:outline/);
  assert.match(
    css,
    /:where\([\s\S]*?\[role="tabpanel"\][\s\S]*?\):focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\);\s*outline-offset:\s*2px;/,
  );
  assert.match(
    css,
    /html\[data-input="pointer"\] :focus-visible\s*\{[^}]*outline:\s*none;/,
  );
});

test("tab 触发器仍保留键盘焦点环", () => {
  assert.match(source, /focus-visible:outline-1/);
});
