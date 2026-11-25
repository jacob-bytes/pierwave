import assert from "node:assert/strict";
import test from "node:test";

import {
  NODE_HEAT_TOOLTIP_GAP,
  NODE_HEAT_TOOLTIP_MARGIN,
  placeNodeHeatTooltip,
} from "./nodeHeatTooltip.ts";

const CARD = { width: 520, height: 400 };
const TOOLTIP = { width: 220, height: 120 };

function row(top, bottom, left = 8, right = 512) {
  return { top, bottom, left, right };
}

test("中间行：浮层贴在行下方，水平居中且不夹紧", () => {
  const placement = placeNodeHeatTooltip({
    anchor: row(170, 230),
    size: TOOLTIP,
    container: CARD,
  });
  assert.equal(placement.below, true);
  assert.equal(placement.clampedX, false);
  assert.equal(placement.clampedY, false);
  assert.equal(placement.y, 230 + NODE_HEAT_TOOLTIP_GAP);
  assert.equal(placement.x, (8 + 512) / 2 - TOOLTIP.width / 2);
});

test("末行贴底：翻到行上方，底边仍在卡片内", () => {
  const placement = placeNodeHeatTooltip({
    anchor: row(330, 380),
    size: TOOLTIP,
    container: CARD,
  });
  assert.equal(placement.below, false);
  assert.equal(placement.clampedY, false);
  assert.equal(placement.y, 330 - NODE_HEAT_TOOLTIP_GAP - TOOLTIP.height);
  assert.ok(placement.y >= NODE_HEAT_TOOLTIP_MARGIN, "不能越出卡片上沿");
});

test("首行靠顶：下方放得下就向下，不硬翻到卡片外", () => {
  const placement = placeNodeHeatTooltip({
    anchor: row(8, 66),
    size: TOOLTIP,
    container: CARD,
  });
  assert.equal(placement.below, true);
  assert.equal(placement.clampedY, false);
  assert.ok(placement.y >= NODE_HEAT_TOOLTIP_MARGIN);
});

test("上下都放不下时夹紧在卡片内，绝不越界", () => {
  const placement = placeNodeHeatTooltip({
    anchor: row(150, 200),
    size: { width: 220, height: 380 },
    container: CARD,
  });
  assert.equal(placement.clampedY, true);
  assert.ok(placement.y >= NODE_HEAT_TOOLTIP_MARGIN, "不能越出卡片上沿");
  assert.ok(placement.y + 380 <= CARD.height, "不能越出卡片下沿");
});

test("浮层比卡片还高：顶部起算，不出现负坐标", () => {
  const placement = placeNodeHeatTooltip({
    anchor: row(150, 200),
    size: { width: 220, height: 420 },
    container: CARD,
  });
  assert.equal(placement.clampedY, true);
  assert.equal(placement.y, NODE_HEAT_TOOLTIP_MARGIN);
});

test("390 窄卡：水平夹紧，左右都不越出卡片", () => {
  const narrow = { width: 340, height: 400 };
  const placement = placeNodeHeatTooltip({
    anchor: row(170, 230, 12, 300),
    size: { width: 320, height: 120 },
    container: narrow,
  });
  assert.equal(placement.x, NODE_HEAT_TOOLTIP_MARGIN);
  assert.equal(placement.clampedX, true);
  assert.ok(placement.x + 320 <= narrow.width - NODE_HEAT_TOOLTIP_MARGIN);
});

test("浮层比卡片还宽：仍然从左边距开始，不出现负坐标", () => {
  const placement = placeNodeHeatTooltip({
    anchor: row(170, 230, 12, 300),
    size: { width: 500, height: 120 },
    container: { width: 340, height: 400 },
  });
  assert.equal(placement.x, NODE_HEAT_TOOLTIP_MARGIN);
  assert.ok(placement.y >= NODE_HEAT_TOOLTIP_MARGIN);
});

test("卡片被弹窗滚出上沿：浮层夹进可见窗口，不越出弹窗", () => {
  // 可见窗口从卡片 200px 处开始、高 200：卡片上半部已经滚出去了。
  const placement = placeNodeHeatTooltip({
    anchor: row(60, 118),
    size: TOOLTIP,
    container: CARD,
    visible: { top: 200, height: 200 },
  });
  assert.ok(
    placement.y >= 200 + NODE_HEAT_TOOLTIP_MARGIN,
    `y=${placement.y} must stay below the visible top`,
  );
  assert.equal(placement.clampedY, true);
});

test("卡片下半部滚出下沿：浮层翻到行上方而不是藏在窗口外", () => {
  // 可见窗口只到卡片 260px 处：末行 210–268 的下半部分已经在窗口外。
  const placement = placeNodeHeatTooltip({
    anchor: row(210, 268),
    size: TOOLTIP,
    container: CARD,
    visible: { top: 0, height: 260 },
  });
  assert.equal(placement.below, false);
  assert.ok(placement.y + TOOLTIP.height <= 260 - NODE_HEAT_TOOLTIP_MARGIN);
});

