import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_INPUT_MODALITY,
  INPUT_MODALITY_ATTRIBUTE,
  INPUT_MODALITY_DATASET_KEY,
  applyInputModality,
  registerInputModality,
} from "./inputModality.ts";

/**
 * Node 里没有 DOM：用 EventTarget 模拟 `document`，只实现注册用到的部分。
 * `dataset` 用普通对象，和浏览器里 `root.dataset.input = "..."`
 * 最终落到 `<html data-input="...">` 的行为对齐。
 */
class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.documentElement = { dataset: {} };
    this.registrations = [];
  }

  // Node 的 EventTarget 对布尔 capture 的 add / remove 匹配有差异（浏览器没有），
  // 这里统一规范化成 options 对象，模拟真实 DOM 的移除语义。
  addEventListener(type, listener, options) {
    this.registrations.push({ type, listener, options, removed: false });
    super.addEventListener(type, listener, normalizeCapture(options));
  }

  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, normalizeCapture(options));
    for (const entry of this.registrations) {
      if (entry.type === type && entry.listener === listener) {
        entry.removed = true;
      }
    }
  }
}

function normalizeCapture(options) {
  if (typeof options === "object" && options !== null) {
    return { capture: options.capture === true };
  }
  return options === true ? { capture: true } : false;
}

function modalityOf(doc) {
  return doc.documentElement.dataset[INPUT_MODALITY_DATASET_KEY];
}

test("首次进入按指针处理：没有键盘操作就不该先亮焦点环", () => {
  assert.equal(DEFAULT_INPUT_MODALITY, "pointer");
  assert.equal(INPUT_MODALITY_ATTRIBUTE, "data-input");
  assert.equal(INPUT_MODALITY_DATASET_KEY, "input");

  const doc = new FakeDocument();
  doc.documentElement.dataset.input = "keyboard";
  registerInputModality(doc);
  assert.equal(modalityOf(doc), "pointer");
});

test("pointerdown 切到 pointer，keydown 切到 keyboard", () => {
  const doc = new FakeDocument();
  registerInputModality(doc);

  doc.dispatchEvent(new Event("keydown"));
  assert.equal(modalityOf(doc), "keyboard");

  doc.dispatchEvent(new Event("pointerdown"));
  assert.equal(modalityOf(doc), "pointer");
});

test("任意键盘事件都算键盘模态：Tab / 方向键 / 输入文字", () => {
  const doc = new FakeDocument();
  registerInputModality(doc);

  // 监听不挑键：Tab、方向键、字符键、Enter 都算键盘操作。
  for (const label of ["Tab", "ArrowDown", "ArrowRight", "a", "Enter"]) {
    doc.dispatchEvent(new Event("pointerdown"));
    assert.equal(modalityOf(doc), "pointer");
    doc.dispatchEvent(new Event("keydown"));
    assert.equal(modalityOf(doc), "keyboard", `${label} 之后应为键盘模态`);
  }
});

test("监听挂在捕获阶段，组件 stopPropagation 不能吞掉模态切换", () => {
  const doc = new FakeDocument();
  registerInputModality(doc);

  const pointer = doc.registrations.find(
    (entry) => entry.type === "pointerdown",
  );
  const keyboard = doc.registrations.find((entry) => entry.type === "keydown");
  assert.equal(pointer?.options, true);
  assert.equal(keyboard?.options, true);
  // 每种事件只注册一次：重复挂载会成倍累加监听。
  assert.equal(
    doc.registrations.filter((entry) => entry.type === "pointerdown").length,
    1,
  );
  assert.equal(
    doc.registrations.filter((entry) => entry.type === "keydown").length,
    1,
  );
});

test("卸载函数移除两个监听，之后事件不再改模态", () => {
  const doc = new FakeDocument();
  const dispose = registerInputModality(doc);
  doc.dispatchEvent(new Event("keydown"));
  assert.equal(modalityOf(doc), "keyboard");

  dispose();
  doc.dispatchEvent(new Event("pointerdown"));
  assert.equal(modalityOf(doc), "keyboard");
  assert.equal(
    doc.registrations.every((entry) => entry.removed),
    true,
    "卸载后不应留下监听",
  );
});

test("applyInputModality 是纯函数：只写传入的根元素", () => {
  const root = { dataset: {} };
  applyInputModality(root, "keyboard");
  assert.equal(root.dataset.input, "keyboard");
  applyInputModality(root, "pointer");
  assert.equal(root.dataset.input, "pointer");
});

test("模态没变时不重复写 dataset，避免每次按键都重算样式", () => {
  let writes = 0;
  const dataset = {};
  Object.defineProperty(dataset, "input", {
    get: () => "pointer",
    set: () => {
      writes += 1;
    },
  });

  applyInputModality({ dataset }, "pointer");
  assert.equal(writes, 0);
  applyInputModality({ dataset }, "keyboard");
  assert.equal(writes, 1);
});

test("模块可以在没有 document 的 Node / SSR 环境里导入", () => {
  // 能走到这里说明模块顶层没有直接读取 document；真实浏览器由
  // `useInputModality` 的 effect 注册，服务端渲染时整段跳过。
  assert.equal(typeof document, "undefined");
  const source = readFileSync(
    new URL("./inputModality.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /typeof document === "undefined"/);
});

test("index.css 只在指针模态下关掉焦点环，键盘模态保持不变", () => {
  const css = readFileSync(
    new URL("../index.css", import.meta.url),
    "utf8",
  );
  const rule = css.match(
    /html\[data-input="pointer"\] :focus-visible \{([\s\S]*?)\}/,
  );
  assert.ok(rule, "缺少指针模态的焦点环规则");
  assert.match(rule[1], /outline:\s*none/);
  // Tailwind 的 ring 走 box-shadow：只关 outline 会留下第二圈蓝。
  assert.match(rule[1], /--tw-ring-shadow:\s*0 0 #0000/);

  // 键盘模态绝不能有全局 outline:none，否则 Tab 用户彻底失去焦点提示。
  assert.doesNotMatch(css, /html\[data-input="keyboard"\]/);
  // 规则必须排在统一焦点环之后，靠未分层顺序覆盖工具类。
  const ringRule = css.indexOf("outline: 2px solid var(--focus-ring)");
  assert.ok(ringRule >= 0);
  assert.ok(css.indexOf('html[data-input="pointer"]') > ringRule);
});

test("根组件挂载时注册一次，首帧 html 就带 pointer", () => {
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(app, /useInputModality\(\)/);
  assert.match(app, /from "@\/lib\/inputModality"/);

  const html = readFileSync(
    new URL("../../index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /<html[^>]*data-input="pointer"/);
});
