# 动效连续性验收 / Motion continuity acceptance

本目录验证「选中指示器滑动 + 焦点不误画边框 + KPI 数值淡入 + 图表首次入场」在
真实浏览器里的静止画面与读数，并保存改动前后的逐像素对比。

This directory verifies the sliding selection indicator, the pointer/keyboard
focus contract, the KPI value fade and the one-shot chart entrance in a real
browser — with resting-frame pixel comparisons and measured readings.

## 覆盖 / Coverage

- **静止帧**：概览视图 tab（1440 / 390，亮 / 暗）、链路二级下划线子页、四个
  分段控件（在线率呈现方式 / 分布维度 / 榜单维度 / 趋势维度）、设置页与日志页
  的 tab、侧栏（桌面 + 390 抽屉）。
- **焦点帧**：鼠标点击视图 tab 与「在线率呈现方式」分段控件后，焦点仍留在
  触发器上。指针模态下断言 `border-color: transparent`（或宽度 0）且
  `outline-style: none`，再把点击帧和同一构建的静止帧做 0 像素比较；键盘聚焦
  则断言 `:focus-visible`、2px outline 与 3px ring 仍在。亮 / 暗各一套，并与
  改动前构建逐像素比较。
- **指示器**：点击 / 方向键切换的偏差轨迹、首次加载不滑、390 第 4 个 tab、
  窗口变窄、中英切换、侧栏点击 / 折叠 / 抽屉、`prefers-reduced-motion`。
- **帧率**：正常帧率浏览器（不传 `--disable-frame-rate-limit`）记录滑动期间
  rAF 间隔中位数与 >25ms 的帧数。
- **KPI**：第二次请求换数字 → `value-settle` 重播；数字不变 → 不重播、不重挂载。
- **图表**：挂载约 30ms 与 400ms 的路径不同；入场后刷新第一帧即终值；
  reduced-motion 首帧即终值。

The resting frames cover the overview view tabs (1440/390, light/dark), the
chain sub-page underline, four segmented controls, settings/logs tabs and the
sidebar (desktop + 390 drawer).

The focus frames cover a view tab and the uptime segmented control in both
themes. After a mouse click the focus stays on the trigger; the frame asserts a
transparent border, no outline, and 0-pixel difference against the same-build
resting frame. Keyboard focus asserts `:focus-visible`, the 2px outline and the
3px ring. Both are compared with the pre-change build.

The indicator section covers the click/arrow displacement traces, no animation
on first load, the 4th tab at 390, resizing, locale switch, sidebar click/
collapse/drawer and reduced-motion. The frame-cadence section samples
`requestAnimationFrame` intervals during a slide in a browser launched **without**
`--disable-frame-rate-limit` and reports the median plus the number of frames
over 25ms.

## 前置 / Prerequisites

仓库根目录执行；`web/dist` 是当前构建。Playwright 从仓库内
`.npm-cache/_npx/` 读取，不需要 `npm install playwright`。
Chrome 默认 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，
可用 `CHROME_PATH` 覆盖。

```bash
make web-build
node web/screenshots/motion-continuity/shots.mjs
```

脚本会启动两类无头 Chrome：

1. **动效采样浏览器**：`--disable-frame-rate-limit --disable-gpu-vsync`。无头
   Chrome 会节流 rAF，不解限就读不到 200ms 过渡和 Recharts 入场动画；这两个
   参数只用于采样，不影响任何静止帧。
2. **帧率测量浏览器**：不传 `--disable-frame-rate-limit`，只关后台节流。
   在指示器滑动期间记录 rAF 间隔中位数与 >25ms 的帧数；目标视图先预热一轮，
   避免首次懒加载图表的主线程阻塞混进读数。

正常帧率浏览器仍被节流时（采样 <10 帧或中位数 >100ms），脚本把读数标为
`available: false` 并写入 `deviations`，不会伪造读数；本次运行读数有效。

Run from the repo root against a fresh `web/dist`. Playwright is resolved from
the in-repo `.npm-cache/_npx/` cache. `CHROME_PATH` can override the browser.

Two headless browsers are launched. The motion-sampling browser uses
`--disable-frame-rate-limit --disable-gpu-vsync` because headless Chrome
otherwise throttles rAF and the 200ms transition / Recharts entrance cannot be
sampled; these flags do not affect resting frames. The frame-cadence browser
does **not** use `--disable-frame-rate-limit`; it only disables background
throttling and samples the slide after pre-warming the target view. If headless
rAF is still throttled (fewer than 10 frames, or a median over 100ms) the script
reports `available: false` and records a deviation instead of inventing a
number.

## 基线 / Baselines

基线由**改动前**的构建生成，脚本通过 `MOTION_CONTINUITY_DIST` 指向那份
`web/dist`：

```bash
MOTION_CONTINUITY_BASELINE=1 \
  MOTION_CONTINUITY_DIST=/path/to/pre-change/web/dist \
  node web/screenshots/motion-continuity/shots.mjs
```

默认只补缺失的基线，已验收的 PNG 不会被覆盖；确需全部重拍时加
`MOTION_CONTINUITY_REBASELINE=1`。

The baselines were captured from the pre-change build via
`MOTION_CONTINUITY_DIST`. Existing baselines are kept by default; set
`MOTION_CONTINUITY_REBASELINE=1` to rewrite all of them.

## 静止帧结果 / Resting-frame results

`0` 表示逐像素完全一致。侧栏按需求使用单通道 ≤ 8 的容差（实测最大 1）。

`0` means pixel-identical. The sidebar uses the requested per-channel tolerance
of ≤ 8 (measured maximum: 1).

| 帧 / Frame | 亮色 / light | 暗色 / dark |
|---|---|---|
| 视图 tab 1440 | 0 | 0 |
| 视图 tab 390 | 0 | 0 |
| 视图 tab 点击后焦点 / view tab after click | 60px，max 13 | 0 |
| 视图 tab 键盘焦点 / view tab keyboard focus | 72px，max 52 | 52px，max 6 |
| 链路二级下划线 / chain underline | 0 | 0 |
| 分段：在线率呈现方式 / uptime mode | 84px，max 14 | 84px，max 3 |
| 分段：在线率点击后焦点 / uptime after click | 128px，max 27 | 84px，max 3 |
| 分段：在线率键盘焦点 / uptime keyboard focus | 145px，max 59 | 130px，max 42 |
| 分段：分布维度 / distribution | 84px，max 14 | 84px，max 3 |
| 分段：榜单维度 / leaderboard | 81px，max 14 | 84px，max 3 |
| 分段：趋势维度 / trend | 84px，max 14 | 84px，max 3 |
| 设置页 tab / settings | 0 | 0 |
| 日志页 tab / logs | 100px，max 14 | 80px，max 4 |
| 侧栏 1440 / sidebar | 0（max 1） | 0（max 1） |
| 侧栏 390 抽屉 / drawer | 0（max 1） | 0（max 1） |

### 焦点帧 / Focus frames

- **鼠标点击 / after a mouse click**：触发器仍是 `document.activeElement`，
  `data-input="pointer"`，计算样式为 `border-color: rgba(0,0,0,0)`、
  `outline-style: none`、无 ring 投影。四张点击帧（视图 tab 与在线率分段，
  亮 / 暗）与**同一构建的静止帧**逐像素比较均为 **0**，即焦点没有带来任何
  可见像素。
- 视图 tab 暗色点击帧与改动前基线也是 **0**；视图 tab 亮色点击帧差 60px
  （max 13），来自旧触发器 1px `border-ring` 被移除后的胶囊边缘抗锯齿，不是
  蓝框。在线率分段暗色点击帧与改动前基线仍保留既有 84px/max 3 的圆角抗锯齿
  差异（与静止帧完全相同）。
- **键盘聚焦 / keyboard focus**：`document.activeElement` 仍是触发器，
  `data-input="keyboard"`，`:focus-visible` 匹配；计算样式为 2px solid
  focus-ring outline + 3px ring，见 `report.json` 的 `focusChecks[].ringVisible`。
  键盘帧与改动前键盘帧的差异集中在胶囊边缘（52–59/255），焦点环本身仍在。

After a mouse click the trigger is still `document.activeElement` with
`data-input="pointer"`, a transparent border, no outline and no ring shadow.
All four click frames (view tab and uptime segment, light/dark) are **0 pixels**
against the resting frame of the same build. The dark view-tab click frame is
also 0 against the pre-change baseline; the light one differs by 60px (max 13)
only where the removed 1px `border-ring` changes corner antialiasing. The dark
uptime click frame keeps the existing 84px/max 3 corner antialiasing of the
indicator, identical to its resting frame.

Keyboard focus still matches `:focus-visible` and computes a 2px solid
focus-ring outline plus a 3px ring (`focusChecks[].ringVisible` in
`report.json`). Keyboard frames differ from the pre-change keyboard frames only
on the pill edge (52–59/255) after the 1px border was removed; the ring is
still drawn.

### 已知偏离：圆角抗锯齿 / Known deviation: corner antialiasing

四个分段控件与日志页 tab 的选中胶囊在圆角边缘有 80–100 个像素差 1–14/255。
文字、颜色、几何、边框、阴影与内部像素完全一致；差异只在抗锯齿边缘。

原因：改动前选中底色画在触发器**自己的图层**里（旧类里的 `opacity: 0`
`::after` 让触发器成为合成层）；现在指示器是普通绝对定位元素，Chrome 对
圆角边缘的栅格化略有不同。已验证一个「让指示器多一个不可见、向外延伸的
`::after`」的写法可以做到 0 像素差，但那只是为了投合 Chrome 的图层化行为，
没有视觉收益，也没有保留。

焦点帧同理：旧触发器带 1px `focus-visible:border-ring`，删掉后焦点环以内的
胶囊边缘抗锯齿会差 27–59/255；脚本只对带 `focusCheck` 的帧放宽到
`maxChannelDelta ≤ 64 && differingPixels ≤ 160`，并且仍由计算样式和
`focusChecks` 断言边框 / outline / ring，避免把真正的蓝框或丢失焦点环当成
抗锯齿放过。

The selected pill in the four segmented controls and the logs tabs differs by
1–14/255 on 80–100 pixels, all on the rounded edges. Text, colours, geometry,
border, shadow and interior pixels are identical. The old selected background
was painted in the trigger's own composited layer (the old `opacity: 0`
`::after`); the indicator is a plain absolutely positioned layer, which Chrome
rasterises very slightly differently at rounded corners. An invisible
outward-extending `::after` on the indicator was measured to restore an exact
0-pixel match, but it only games Chrome's layerisation and has no visual
benefit, so it was not kept.

Focus frames carry the same effect: the old trigger had a 1px
`focus-visible:border-ring`, so removing it changes the antialiasing at the pill
edge by 27–59/255. The script widens the threshold to
`maxChannelDelta ≤ 64 && differingPixels ≤ 160` **only for frames with
`focusCheck`**, and still asserts border/outline/ring from computed styles, so
a real blue box or a missing focus ring cannot pass as antialiasing.

## 动态读数 / Dynamic readings

数值来自 `report.json`（每次运行会因帧调度略有浮动）。

Readings from `report.json` (they can drift slightly between runs).

- 首次加载 / first load：56 个 ready 采样，指示器相对选中项最大偏差 **0px**。
- 点击切换 / click：过渡关键帧 `left: 3px → 73px`，跨度 **70px**（等于两个
  tab 的间距）；中间帧偏差 **5.5px**（200.2ms），结束 **0px**；点击后
  **312.2ms** 对齐；过渡 `0.2s`、`cubic-bezier(0.22, 1, 0.36, 1)`。
- 方向键 / arrow key：`73px → 3px`（跨度 70px）；中间帧 **44.2px**，结束
  **0px**；按键后 **300.1ms** 对齐（含 React 提交延迟），过渡同样 200ms。
- 390 第 4 个 tab：选中「链路时延」，偏差 **0px**。
- 窗口变窄 / resize：900 与 390 下偏差均为 **0px**。
- 中英切换 / locale：选中项变为 `Resource status`，偏差 **0px**。
- 侧栏 / sidebar：点击「服务器」**136.4ms** 对齐；折叠后偏差 **0px**；
  390 抽屉打开与点击「设置」后偏差 **0px**。
- reduced-motion：指示器 `transition: none`，实测 `0.01ms`，点击后直接终态。
- 滑动帧间隔 / frame cadence：正常帧率浏览器（无
  `--disable-frame-rate-limit`）采样 **32** 帧，中位数 **16.7ms**，
  >25ms 的帧 **1**（一次 100ms 的调度抖动），最大 **100ms**。
- KPI：换数字时 2 个数值节点重挂载，`value-settle` 为 `running` 状态，外层
  Link 全部保持挂载；数字不变时 0 个重挂载、0 次重播。
- 图表 / charts：挂载 30ms 与 400ms 路径不同，400ms 后稳定；入场完成后
  刷新第一帧即终值；reduced-motion 首帧即终值。
- `errors`：**0**。

## 文件 / Files

- `shots.mjs`：静态服务 + mock API + 上述断言；输出截图、`report.json`。
- `baseline/`：改动前构建的 30 张元素截图（22 张静止帧 + 8 张焦点帧）。
- 根目录 30 张当前构建的元素截图（同名），加 `390-fourth-tab.png`、
  `sidebar-collapsed-1440-light.png` 两张动态截图。
- `report.json`：每一帧的差异读数、`focusChecks`、动态读数、checks、
  deviations、errors。
