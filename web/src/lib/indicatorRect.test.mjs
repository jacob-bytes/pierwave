import assert from "node:assert/strict";
import test from "node:test";
import {
  UNDERLINE_HEIGHT,
  indicatorRect,
  sameBox,
} from "./indicatorRect.ts";

/** 视口坐标里的容器盒子；边框与滚动由调用方补充。 */
const CONTAINER = { left: 100, top: 200, width: 300, height: 100 };
const NO_SCROLL = { x: 0, y: 0 };

test("pill：选中项相对容器的偏移与尺寸", () => {
  const active = { left: 124, top: 213, width: 72, height: 30 };
  assert.deepEqual(
    indicatorRect(active, CONTAINER, NO_SCROLL, 0, "pill"),
    { left: 24, top: 13, width: 72, height: 30 },
  );
});

test("pill：滚动相抵 —— 容器滚动后的视口偏移加回来仍是同一位置", () => {
  // 容器向右、向下各滚 40px：选中项的视口矩形随之左 / 上移 40px，
  // 指示器是容器内容的一部分，所以要把滚动量加回去。
  const unscrolled = { left: 124, top: 213, width: 72, height: 30 };
  const scrolled = { left: 84, top: 173, width: 72, height: 30 };
  const scroll = { x: 40, y: 40 };
  assert.deepEqual(
    indicatorRect(scrolled, CONTAINER, scroll, 0, "pill"),
    indicatorRect(unscrolled, CONTAINER, NO_SCROLL, 0, "pill"),
  );
});

test("2×2 网格：第二行第二格取相对容器的行列偏移", () => {
  const active = { left: 260, top: 260, width: 140, height: 40 };
  assert.deepEqual(
    indicatorRect(active, CONTAINER, NO_SCROLL, 0, "pill"),
    { left: 160, top: 60, width: 140, height: 40 },
  );
});

test("underline：宽度同选中项、高 2、贴容器底边", () => {
  const active = { left: 124, top: 213, width: 72, height: 30 };
  assert.deepEqual(
    indicatorRect(active, CONTAINER, NO_SCROLL, 0, "underline"),
    {
      left: 24,
      top: CONTAINER.height - UNDERLINE_HEIGHT,
      width: 72,
      height: UNDERLINE_HEIGHT,
    },
  );
  assert.equal(UNDERLINE_HEIGHT, 2);
});

test("0 宽或 0 高返回 null（容器 / 选中项隐藏时）", () => {
  for (const active of [
    { left: 100, top: 200, width: 0, height: 30 },
    { left: 100, top: 200, width: 30, height: 0 },
    { left: 100, top: 200, width: 0, height: 0 },
  ]) {
    assert.equal(indicatorRect(active, CONTAINER, NO_SCROLL, 0, "pill"), null);
    assert.equal(
      indicatorRect(active, CONTAINER, NO_SCROLL, 0, "underline"),
      null,
    );
  }
});

test("容器边框：绝对定位相对 padding box，需要减掉边框", () => {
  const active = { left: 126, top: 215, width: 72, height: 30 };
  assert.deepEqual(
    indicatorRect(active, CONTAINER, NO_SCROLL, 2, "pill"),
    { left: 24, top: 13, width: 72, height: 30 },
  );
  // 底边在 border box 的内侧：再减掉上下两条边框，仍高 2。
  assert.deepEqual(
    indicatorRect(active, CONTAINER, NO_SCROLL, 2, "underline"),
    {
      left: 24,
      top: CONTAINER.height - 2 * 2 - UNDERLINE_HEIGHT,
      width: 72,
      height: UNDERLINE_HEIGHT,
    },
  );
});

test("小数尺寸原样保留，不做取整（避免亚像素抖动）", () => {
  const active = {
    left: 100.25,
    top: 200.5,
    width: 72.75,
    height: 30.5,
  };
  assert.deepEqual(
    indicatorRect(active, CONTAINER, NO_SCROLL, 0, "pill"),
    { left: 0.25, top: 0.5, width: 72.75, height: 30.5 },
  );
  assert.equal(
    indicatorRect(active, CONTAINER, NO_SCROLL, 0, "underline")?.width,
    72.75,
  );
});

test("sameBox：0.01px 容差内视为同一位置，超出则不相等", () => {
  const base = { left: 10, top: 20, width: 30, height: 40 };
  assert.equal(sameBox(base, { ...base }), true);
  assert.equal(sameBox(base, { ...base, left: 10.009 }), true);
  assert.equal(sameBox(base, { ...base, top: 20.01 }), true);
  assert.equal(sameBox(base, { ...base, left: 10.011 }), false);
  assert.equal(sameBox(base, { ...base, width: 30.02 }), false);
  assert.equal(sameBox(base, { ...base, height: 40.02 }), false);
  assert.equal(sameBox(null, null), true);
  assert.equal(sameBox(base, null), false);
  assert.equal(sameBox(null, base), false);
});
