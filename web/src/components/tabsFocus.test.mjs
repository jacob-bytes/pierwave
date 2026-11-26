import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ui/tabs.tsx", import.meta.url), "utf8");

test("tab 面板不描焦点环：整块内容外的 2px 边框会被当成布局错误", () => {
  // 面板本身没有可操作项；焦点提示留在 tab 上，面板只保留 outline-none。
  assert.match(source, /function TabsContent[\s\S]*?outline-none/);
  assert.doesNotMatch(
    source.split("function TabsContent")[1] ?? "",
    /focus-visible:outline/,
  );
});

test("tab 触发器仍保留键盘焦点环", () => {
  assert.match(source, /focus-visible:outline-1/);
});
