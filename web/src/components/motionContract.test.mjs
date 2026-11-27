import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 动效契约（源码级）/ Motion contract at the source level.
 *
 * 浏览器端只验「真实动画读出来是多少」，这里先把组件必须携带的 class 锁住：
 * - 浮层：进入 200ms / 退出 150ms / ease-out-soft，且不再残留裸 duration-*；
 * - 选中指示器：200ms、ease-spring、50% → 100%，未选中 opacity 0；
 * - 列表行：按下态与键盘聚焦时的箭头位移。
 *
 * 这些断言只读源码字符串，不需要构建产物，因此先于实现就能跑（并失败）。
 */

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

function ui(name) {
  return read(`./ui/${name}.tsx`);
}

/**
 * 取某个 `data-slot` 元素自身的源码片段：从它出现的位置到下一个
 * `data-slot="` 声明。className 一定落在这一段里。
 */
function slot(source, name) {
  const needle = `data-slot="${name}"`;
  const start = source.indexOf(needle);
  assert.notEqual(start, -1, `missing ${needle}`);
  const next = source.indexOf('data-slot="', start + needle.length);
  return source.slice(start, next === -1 ? source.length : next);
}

/** 取带自定义 data-* 标记的开标签源码（到最近的 `>` 为止）。 */
function element(source, attribute) {
  const pattern = new RegExp(
    `${attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
  );
  const start = source.search(pattern);
  assert.notEqual(start, -1, `missing ${attribute}`);
  const end = source.indexOf(">", start);
  assert.notEqual(end, -1, `unterminated element after ${attribute}`);
  return source.slice(start, end + 1);
}

/**
 * 取包含某个 `data-slot` 的完整开标签：`aria-hidden` 之类的属性可以写在
 * `data-slot` 之前，`slot()` 从 `data-slot` 起算会漏掉它们。
 */
function tagWithSlot(source, name) {
  const needle = `data-slot="${name}"`;
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `missing ${needle}`);
  const start = source.lastIndexOf("<", index);
  assert.notEqual(start, -1, `${needle} must sit inside an opening tag`);
  const end = source.indexOf(">", index);
  assert.notEqual(end, -1, `unterminated tag around ${needle}`);
  return source.slice(start, end + 1);
}

/** 取两个标记之间的源码片段（不含结束标记）。 */
function between(source, startMarker, endMarker) {
  const from = source.indexOf(startMarker);
  assert.notEqual(from, -1, `missing ${startMarker}`);
  const to = source.indexOf(endMarker, from + startMarker.length);
  assert.notEqual(to, -1, `missing ${endMarker} after ${startMarker}`);
  return source.slice(from, to);
}

const ENTER = "data-open:duration-200";
const EXIT = "data-closed:duration-150";
const EASE = "ease-out-soft";
/** 裸时长：前面不能是 `:`（状态变体）或单词字符。 */
const BARE_DURATION = /(?<![:\w-])duration-(?:100|150|200)\b/;

const FLOATING_LAYERS = [
  { file: "dialog", slots: ["dialog-overlay", "dialog-content"] },
  { file: "alert-dialog", slots: ["alert-dialog-overlay", "alert-dialog-content"] },
  { file: "sheet", slots: ["sheet-overlay", "sheet-content"] },
  {
    file: "dropdown-menu",
    slots: ["dropdown-menu-content", "dropdown-menu-sub-content"],
  },
  { file: "popover", slots: ["popover-content"] },
  { file: "select", slots: ["select-content"] },
  { file: "tooltip", slots: ["tooltip-content"] },
];

test("the spring easing token exists right after the soft ease token", () => {
  const css = read("../index.css");
  assert.match(
    css,
    /--ease-out-soft:\s*cubic-bezier\(0\.22, 1, 0\.36, 1\);\s*\/\*[\s\S]*?\*\/\s*--ease-spring:\s*cubic-bezier\(0\.34, 1\.46, 0\.64, 1\);/,
    "@theme must declare --ease-spring after --ease-out-soft",
  );
});

test("docs item 7 records the Tooltip 150/100 exception in both languages", () => {
  const doc = read("../../../docs/DESIGN.md");
  const sections = {
    zh: between(doc, "7. 浮层进出：", "\n8. "),
    en: between(doc, "7. Overlays: ", "\n8. "),
  };
  for (const [language, section] of Object.entries(sections)) {
    assert.match(section, /Tooltip/, `${language}: item 7 must mention Tooltip`);
    assert.match(section, /150\s*ms/, `${language}: item 7 must state 150ms in`);
    assert.match(section, /100\s*ms/, `${language}: item 7 must state 100ms out`);
  }
});

test("every floating layer opens in 200ms and closes in 150ms with the soft ease", () => {
  for (const { file, slots } of FLOATING_LAYERS) {
    const source = ui(file);
    for (const name of slots) {
      const section = slot(source, name);
      // Tooltip is the one deliberate exception: 150/150/100, never 200.
      if (file === "tooltip") {
        assert.ok(
          section.includes("data-open:duration-150"),
          `${file} ${name}: open must be 150ms`,
        );
        assert.ok(
          section.includes("data-[state=delayed-open]:duration-150"),
          `${file} ${name}: delayed-open must be 150ms`,
        );
        assert.ok(
          section.includes("data-closed:duration-100"),
          `${file} ${name}: close must be 100ms`,
        );
        assert.ok(section.includes(EASE), `${file} ${name}: missing ${EASE}`);
        assert.ok(
          !section.includes("duration-200"),
          `${file} ${name}: tooltip must never use 200ms`,
        );
        assert.ok(
          !BARE_DURATION.test(section),
          `${file} ${name}: bare duration-* left behind`,
        );
        continue;
      }
      assert.ok(section.includes(ENTER), `${file} ${name}: missing ${ENTER}`);
      assert.ok(section.includes(EXIT), `${file} ${name}: missing ${EXIT}`);
      assert.ok(section.includes(EASE), `${file} ${name}: missing ${EASE}`);
      assert.ok(
        !BARE_DURATION.test(section),
        `${file} ${name}: bare duration-* left behind`,
      );
    }
  }
});

test("dialog and alert-dialog contents drop 4px while staying centered", () => {
  for (const file of ["dialog", "alert-dialog"]) {
    const content = slot(ui(file), `${file}-content`);
    assert.ok(
      content.includes("data-open:slide-in-from-top-1"),
      `${file}: open should drop from 4px above`,
    );
    assert.ok(
      content.includes("data-closed:slide-out-to-top-1"),
      `${file}: close should lift back 4px`,
    );
  }
});

test("select keeps item-aligned no-animation and popper side offsets", () => {
  const content = slot(ui("select"), "select-content");
  assert.ok(
    content.includes("data-[align-trigger=true]:animate-none"),
    "select must keep the item-aligned animate-none escape",
  );
  for (const cls of [
    "data-[side=bottom]:translate-y-1",
    "data-[side=left]:-translate-x-1",
    "data-[side=right]:translate-x-1",
    "data-[side=top]:-translate-y-1",
  ]) {
    assert.ok(content.includes(cls), `select missing ${cls}`);
  }
});

test("sheet keeps all four 2.5rem slide directions", () => {
  const content = slot(ui("sheet"), "sheet-content");
  for (const direction of ["bottom", "left", "right", "top"]) {
    assert.ok(
      content.includes(`data-[side=${direction}]:data-open:slide-in-from-${direction}-10`),
      `sheet missing open slide for ${direction}`,
    );
    assert.ok(
      content.includes(`data-[side=${direction}]:data-closed:slide-out-to-${direction}-10`),
      `sheet missing close slide for ${direction}`,
    );
  }
});

test("dropdown-menu and popover keep their anchored 8px side slides", () => {
  for (const [file, slots] of [
    ["dropdown-menu", ["dropdown-menu-content", "dropdown-menu-sub-content"]],
    ["popover", ["popover-content"]],
  ]) {
    for (const name of slots) {
      const section = slot(ui(file), name);
      for (const cls of [
        "data-[side=bottom]:slide-in-from-top-2",
        "data-[side=left]:slide-in-from-right-2",
        "data-[side=right]:slide-in-from-left-2",
        "data-[side=top]:slide-in-from-bottom-2",
      ]) {
        assert.ok(section.includes(cls), `${file} ${name} missing ${cls}`);
      }
    }
  }
});

test("checkbox indicator is force-mounted, hidden at rest and springs to full size", () => {
  const source = ui("checkbox");
  assert.ok(source.includes("forceMount"), "checkbox indicator must forceMount");
  const indicator = slot(source, "checkbox-indicator");
  const expected = [
    "grid",
    "scale-50",
    "place-content-center",
    "text-current",
    "opacity-0",
    "transition-[opacity,scale]",
    "duration-200",
    "ease-spring",
    "group-data-[state=checked]:scale-100",
    "group-data-[state=checked]:opacity-100",
    "group-data-[state=indeterminate]:scale-100",
    "group-data-[state=indeterminate]:opacity-100",
  ];
  for (const cls of expected) {
    assert.ok(indicator.includes(cls), `checkbox indicator missing ${cls}`);
  }
  assert.ok(
    !indicator.includes("transition-none"),
    "checkbox indicator must not keep transition-none",
  );
});

test("radio dot is force-mounted and springs from 50% into place", () => {
  const source = ui("radio-group");
  assert.ok(source.includes("forceMount"), "radio indicator must forceMount");
  const dot = slot(source, "radio-group-indicator-dot");
  const expected = [
    "transition-[opacity,scale]",
    "duration-200",
    "ease-spring",
    "scale-50",
    "opacity-0",
    "group-data-checked/radio-group-item:scale-100",
    "group-data-checked/radio-group-item:opacity-100",
  ];
  for (const cls of expected) {
    assert.ok(dot.includes(cls), `radio dot missing ${cls}`);
  }
});

test("checkbox indicator and radio dot are aria-hidden", () => {
  assert.ok(
    tagWithSlot(ui("checkbox"), "checkbox-indicator").includes('aria-hidden="true"'),
    "checkbox indicator must be aria-hidden",
  );
  assert.ok(
    tagWithSlot(ui("radio-group"), "radio-group-indicator-dot").includes(
      'aria-hidden="true"',
    ),
    "radio dot must be aria-hidden",
  );
});

test("switch thumb springs while keeping its transform transition and both sizes", () => {
  const thumb = slot(ui("switch"), "switch-thumb");
  assert.ok(thumb.includes("transition-transform"), "switch thumb must keep transition-transform");
  assert.ok(thumb.includes("duration-200"), "switch thumb must take 200ms");
  assert.ok(thumb.includes("ease-spring"), "switch thumb must use ease-spring");
  assert.ok(
    thumb.includes("group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)]"),
    "switch default checked translate must stay",
  );
  assert.ok(
    thumb.includes("group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)]"),
    "switch sm checked translate must stay",
  );
});

test("ChainLatencyList rows press in and nudge the chevron for keyboard focus", () => {
  const source = read("../components/overview/ChainLatencyList.tsx");
  assert.ok(
    element(source, "data-chain-list-row").includes("active:bg-muted/60"),
    "chain row is missing active:bg-muted/60",
  );
  assert.ok(
    element(source, "data-chain-chevron").includes(
      "group-focus-visible:translate-x-0.5",
    ),
    "chain chevron is missing the keyboard nudge",
  );
});

test("ChainTemplateInsightList rows press in and nudge the chevron for keyboard focus", () => {
  const source = read("../components/overview/ChainTemplateInsightList.tsx");
  assert.ok(
    element(source, "data-chain-template-row").includes("active:bg-muted/60"),
    "template row is missing active:bg-muted/60",
  );
  assert.ok(
    source.includes("group-focus-visible:translate-x-0.5"),
    "template chevron is missing the keyboard nudge",
  );
});

test("TrafficView presses all three links and nudges their chevrons", () => {
  const source = read("../components/overview/TrafficView.tsx");
  const count = (needle) => source.split(needle).length - 1;
  assert.equal(
    count("active:bg-muted/60"),
    3,
    "exactly the three leaderboard links should use active:bg-muted/60",
  );
  assert.equal(
    count("group-focus-visible:translate-x-0.5"),
    3,
    "exactly the three leaderboard chevrons should nudge on keyboard focus",
  );
  assert.equal(
    count("has-[a:active]:bg-muted/60"),
    1,
    "the alert row wrapper must press when its link is pressed",
  );
  assert.equal(
    count("group-has-[a:focus-visible]:translate-x-0.5"),
    1,
    "the alert row chevron must nudge when its link is keyboard-focused",
  );
});
