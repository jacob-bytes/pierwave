# 动效验收 / Motion acceptance

本目录用真实浏览器（Playwright + 本地 Chrome）验证「只改交互手感、不改静止画面」这一轮
动效改动的**实际读数**，并保存亮 / 暗两套截图与逐像素静止帧对比。

This directory verifies the real browser readouts of the motion-only pass
(Playwright + local Chrome): overlay durations/easing, spring indicators,
list-row press/focus states, reduced-motion, plus light/dark screenshots and
pixel-level resting-frame comparisons.

## 前置 / Prerequisites

- 仓库根目录执行；`web/dist` 是当前构建。
- 本机 Playwright 从仓库内 `.npm-cache/_npx/` 读取（与其它截图脚本一致），
  不需要 `npm install playwright`。
- Chrome 路径默认 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，
  可用 `CHROME_PATH` 覆盖。

Run from the repo root against a fresh `web/dist`. Playwright is resolved from
the in-repo `.npm-cache/_npx/` cache (same as the other screenshot scripts);
`CHROME_PATH` can override the browser path.

## 命令 / Commands

```bash
# 1) 构建（必跑）/ build first
make web-build

# 2) 动效验收 + 截图 + report.json / verify & capture
node web/screenshots/motion-pass/shots.mjs
```

脚本自己起静态服务服务 `web/dist`，并用 Playwright 拦截 `/api/v1/**`；
不需要主控、数据库或真实登录会话。

The script serves `web/dist` from a temporary static server and mocks
`/api/v1/**` through Playwright routes; no master, database, or login needed.

可选调试参数 / Optional debugging:

```bash
# 只跑一个场景（overview / dialog / alert-dialog / servers / packages /
# chain-templates / dropdown / sheet），默认 dark
MOTION_PASS_ONLY=servers MOTION_PASS_THEME=light \
  node web/screenshots/motion-pass/shots.mjs
```

## 断言 / Assertions

| 场景 / Scenario | 进入 / Enter | 退出 / Exit | 缓动 / Easing |
|---|---|---|---|
| Dialog（概览「查看全部告警」） | 200ms | 150ms | `cubic-bezier(0.22, 1, 0.36, 1)` |
| AlertDialog（我的订阅 → 重置链接） | 200ms | 150ms | 同上 |
| Dropdown / Popover / Select（popper） | 200ms | 150ms | 同上 |
| Sheet（390 宽移动导航） | 200ms | 150ms | 同上 |
| Tooltip（服务器页表头复选框） | 150ms | 100ms | 同上（唯一例外，见 [第四节第 7 条「Tooltip 保持轻快：进 150ms、出 100ms」](../../../docs/DESIGN.md#四动效灵动的唯一来源)） |

- Dialog / AlertDialog 的进入关键帧纵向位移 = **−4px**（`translate3d(0, -4px, 0)`）。
- 复选框 / 单选圆点：`transition-property: opacity, scale`、200ms、
  `cubic-bezier(0.34, 1.46, 0.64, 1)`；未选中 `opacity: 0`、`scale: 0.5`、
  `aria-hidden="true"`、无 `tabindex`；选中过程缩放峰值 **> 1**、终值 **1**。
- 开关滑块：200ms `ease-spring`；sm 尺寸从 0 移到 10px（根节点 1px 边框下
  实测 11px 左缘偏移），峰值大于终值，终值回到 10px 行程。
- 列表行：静止背景透明；按下 `bg-muted/60`；键盘 `:focus-visible` 时箭头
  `translate: 2px`（链路行 / 榜单行 / 告警行各自的 group 规则都单独验证）。
- reduced-motion：Dialog 进入动画 < 1ms（全站 `animation-duration: 0.01ms`）；
  复选框指示器（代表选中指示器）的 `transition-duration` 同样 < 1ms，
  点击后仍直接呈现 `opacity: 1` / `scale: 1` 的终态。
- 静止帧：13 个元素 × 亮 / 暗两套基线逐像素比较（见下）。

## 截图 / Screenshots

亮 / 暗各一套、1440×900；Sheet 为 390×844：
`dialog-1440-{dark,light}`、`alert-dialog-1440-*`、`dropdown-1440-*`、
`popover-1440-*`、`select-1440-*`、`tooltip-1440-*`、`checkbox-1440-*`、
`switch-1440-*`、`radio-1440-*`、`chain-row-press-1440-*`、
`chain-chevron-focus-1440-*`、`traffic-row-press-1440-*`、
`traffic-chevron-focus-1440-*`、`alert-row-press-1440-*`、
`alert-chevron-focus-1440-*`、`sheet-390-*`，以及
`reduced-motion-dialog-1440-dark`、`reduced-motion-checkbox-1440-dark`。

`report.json` 里 `checks[]` 是每一条实际读数，`staticComparisons[]` 是静止帧
逐像素对比结果，`shots[]` 是截图清单。

## 基线 / Baselines

`baseline/*.png` 是 13 个静止帧 × 亮 / 暗两套：dialog / alert-dialog /
dropdown / popover / select / tooltip / sheet 的浮层内容，checkbox 未选/选中，
switch 关/开，radio 未选/选中。

- **亮色 `<name>.png`**：改动前构建的画面，作为「只改手感、不改静止画面」的回归基准。
- **暗色 `<name>-dark.png`**：此前没有深色基线，**从本轮起记录**，用当前构建生成；
  它锁定的是本轮之后的暗色静止画面，不是改动前。

亮色基线是最初用 `MOTION_PASS_BASELINE=1` 在改动前的源码上生成的；本轮只补录暗色
（`MOTION_PASS_BASELINE=1 MOTION_PASS_BASELINE_THEME=dark`），没有重跑亮色，避免覆盖
改动前基准。基线模式默认会重录亮 + 暗，只在有意重设基准时才用。除了下面两条边缘
抗锯齿容差，其余元素要求 **0 像素差异**。

The baselines are 13 resting frames in both themes. The light `<name>.png`
files come from the pre-change build and are the regression reference. The dark
`<name>-dark.png` files are **recorded from this round on**: no pre-change dark
baseline existed, so they were generated from the current build. Light
baselines were captured with `MOTION_PASS_BASELINE=1`; this round only added
the dark set (`MOTION_PASS_BASELINE=1 MOTION_PASS_BASELINE_THEME=dark`) and did
not re-run the light mode, which would overwrite the pre-change reference.
Baseline mode records both themes by default; use it only when intentionally
resetting the reference. Every element must match exactly except the two
edge-antialiasing tolerances described below.

### 已知容差 / Known tolerance

两个元素允许 ≤ 24 个像素的**边缘抗锯齿**差异（亮 / 暗同一阈值），其余元素仍要求 0：

- Tooltip：圆角在**新增 `duration-*` 过渡后**被提升为合成层，右侧两个圆角
  1px 抗锯齿与改动前差 15 个像素（单通道 ≤ 23）。
- Sheet：面板宽是 390 × 3/4 = 292.5px，右缘落在半像素上；元素截图最右一列
  的抗锯齿随合成层降级时机浮动 3–15 个像素（单通道 ≤ ~16，全部在 x=292）。

两处都是渲染层差异，肉眼不可见，也不是布局/颜色变化；面板内部任何真实变化
仍会远超 24px 并触发失败。

Two elements allow ≤ 24 pixels of **edge antialiasing** difference (same
threshold in both themes); every other element still requires zero:

- Tooltip: the new `duration-*` transition promotes it to a composited layer,
  so its two right rounded corners differ from the pre-change baseline by 15
  pixels (≤ 23 per channel).
- Sheet: the panel is 390 × 3/4 = 292.5px wide, so its right edge lands on a
  half pixel; the last captured column varies by 3–15 pixels (≤ ~16 per
  channel, always at x=292) as the composited layer is demoted.

Both are render-layer differences that are invisible to the eye, not layout or
colour changes. Real changes inside the panel still exceed 24px and fail.

## 说明 / Notes

- 表单类 Dialog / AlertDialog（PackageFormDialog、DeletePackageDialog 等）由父
  组件条件挂载，关闭时整棵 Radix 树立即卸载，**退出动画在正常产品路径里不会播放**。
  因此 Dialog / AlertDialog 的进入+退出改用两个常驻挂载的实例来测：
  概览「查看全部告警」Dialog、我的订阅「重置链接」AlertDialog。这是现状说明，
  不是本轮改动的一部分。
- 没有新增依赖、没有改版本号、没有改 `web/dist` 产物（跑 `make web-build` 生成）。
- 脚本只读源码/构建产物和浏览器运行时，不修改应用文件。

Form dialogs are conditionally mounted, so their exit animation never plays in
normal product flows. The enter+exit readings therefore use the two
always-mounted instances (overview alert dialog and the reset-subscription
AlertDialog). No dependency, version, or `web/dist` artifact is changed.
