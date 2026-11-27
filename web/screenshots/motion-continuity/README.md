# 动效连续性验收 / Motion continuity acceptance

本目录验证「选中指示器滑动 + KPI 数值淡入 + 图表首次入场」三件事在真实浏览器里的
静止画面与读数，并保存改动前后的逐像素对比。

This directory verifies the three motion-continuity changes in a real browser —
the sliding selection indicator, the KPI value fade and the one-shot chart
entrance — with resting-frame pixel comparisons and measured readings.

## 覆盖 / Coverage

- **静止帧**：概览视图 tab（1440 / 390，亮 / 暗）、链路二级下划线子页、四个
  分段控件（在线率呈现方式 / 分布维度 / 榜单维度 / 趋势维度）、设置页与日志页
  的 tab、侧栏（桌面 + 390 抽屉）。
- **指示器**：点击 / 方向键切换的偏差轨迹、首次加载不滑、390 第 4 个 tab、
  窗口变窄、中英切换、侧栏点击 / 折叠 / 抽屉、`prefers-reduced-motion`、
  滑动帧间隔。
- **KPI**：第二次请求换数字 → `value-settle` 重播；数字不变 → 不重播、不重挂载。
- **图表**：挂载约 30ms 与 400ms 的路径不同；入场后刷新第一帧即终值；
  reduced-motion 首帧即终值。

## 前置 / Prerequisites

仓库根目录执行；`web/dist` 是当前构建。Playwright 从仓库内
`.npm-cache/_npx/` 读取，不需要 `npm install playwright`。
Chrome 默认 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，
可用 `CHROME_PATH` 覆盖。

Run from the repo root against a fresh `web/dist`. Playwright is resolved from
the in-repo `.npm-cache/_npx/` cache. `CHROME_PATH` can override the browser.

```bash
make web-build
node web/screenshots/motion-continuity/shots.mjs
```

无头 Chrome 默认把 `requestAnimationFrame` 节流到约 1fps，轨迹和 Recharts
动画都读不到。脚本用 `--disable-frame-rate-limit --disable-gpu-vsync` 打开正常
帧率（只影响采样，不影响静止帧）。

Headless Chrome throttles `requestAnimationFrame` to roughly 1fps by default.
The script launches it with `--disable-frame-rate-limit --disable-gpu-vsync` so
the trajectory and Recharts animation can be sampled; this changes sampling
only, not the resting frames.

## 基线 / Baselines

基线由**改动前**的构建生成，脚本通过 `MOTION_CONTINUITY_DIST` 指向那份
`web/dist`：

```bash
MOTION_CONTINUITY_BASELINE=1 \
  MOTION_CONTINUITY_DIST=/path/to/pre-change/web/dist \
  node web/screenshots/motion-continuity/shots.mjs
```

The baselines were captured from the pre-change build via
`MOTION_CONTINUITY_DIST`. Re-run the command above after an intentional visual
change, and review the PNGs before keeping them.

## 静止帧结果 / Resting-frame results

`0` 表示逐像素完全一致。侧栏按需求使用单通道 ≤ 8 的容差（实测最大 1）。

`0` means pixel-identical. The sidebar uses the requested per-channel tolerance
of ≤ 8 (measured maximum: 1).

| 帧 / Frame | 亮色 / light | 暗色 / dark |
|---|---|---|
| 视图 tab 1440 | 0 | 0 |
| 视图 tab 390 | 0 | 0 |
| 链路二级下划线 / chain underline | 0 | 0 |
| 分段：在线率呈现方式 / uptime mode | 84px，max 14 | 84px，max 3 |
| 分段：分布维度 / distribution | 84px，max 14 | 84px，max 3 |
| 分段：榜单维度 / leaderboard | 81px，max 14 | 84px，max 3 |
| 分段：趋势维度 / trend | 84px，max 14 | 84px，max 3 |
| 设置页 tab / settings | 0 | 0 |
| 日志页 tab / logs | 100px，max 14 | 80px，max 4 |
| 侧栏 1440 / sidebar | 0（max 1） | 0（max 1） |
| 侧栏 390 抽屉 / drawer | 0（max 1） | 0（max 1） |

### 已知偏离：圆角抗锯齿 / Known deviation: corner antialiasing

四个分段控件与日志页 tab 的选中胶囊在圆角边缘有 80–100 个像素差 1–14/255。
文字、颜色、几何、边框、阴影与内部像素完全一致；差异只在抗锯齿边缘。

原因：改动前选中底色画在触发器**自己的图层**里（旧类里的 `opacity: 0`
`::after` 让触发器成为合成层）；现在指示器是普通绝对定位元素，Chrome 对
圆角边缘的栅格化略有不同。已验证一个「让指示器多一个不可见、向外延伸的
`::after`」的写法可以做到 0 像素差，但那只是为了投合 Chrome 的图层化行为，
没有视觉收益，也没有保留。

The selected pill in the four segmented controls and the logs tabs differs by
1–14/255 on 80–100 pixels, all on the rounded edges. Text, colours, geometry,
border, shadow and interior pixels are identical. The old selected background
was painted in the trigger's own composited layer (the old `opacity: 0`
`::after`); the indicator is a plain absolutely positioned layer, which Chrome
rasterises very slightly differently at rounded corners. An invisible
outward-extending `::after` on the indicator was measured to restore an exact
0-pixel match, but it only games Chrome's layerisation and has no visual
benefit, so it was not kept.

## 动态读数 / Dynamic readings

数值来自 `report.json`（每次运行会因帧调度略有浮动）。

Readings from `report.json` (they can drift slightly between runs).

- 首次加载 / first load：58 个 ready 采样，指示器相对选中项最大偏差 **0px**。
- 点击切换 / click：过渡关键帧 `left: 3px → 73px`，跨度 **70px**（等于两个
  tab 的间距）；中间帧偏差 **4.6px**（136.2ms），结束 **0px**；点击后
  **224.7ms** 对齐；过渡 `0.2s`、`cubic-bezier(0.22, 1, 0.36, 1)`。
- 方向键 / arrow key：`73px → 3px`（跨度 70px）；中间帧 **32.6px**，结束
  **0px**；按键后 **195.6ms** 对齐（含 React 提交延迟），过渡同样 200ms。
- 390 第 4 个 tab：选中「链路时延」，偏差 **0px**。
- 窗口变窄 / resize：900 与 390 下偏差均为 **0px**。
- 中英切换 / locale：选中项变为 `Resource status`，偏差 **0px**。
- 侧栏 / sidebar：点击「服务器」**128.3ms** 对齐；折叠后偏差 **0px**；
  390 抽屉打开与点击「设置」后偏差 **0px**。
- reduced-motion：指示器 `transition: none`，实测 `0.01ms`，点击后直接终态。
- 滑动帧间隔中位数 / median frame interval：**0.2ms**（关掉帧率上限后的
  采样，满足 ≤20ms）。
- KPI：换数字时 2 个数值节点重挂载，`value-settle` 为 `running` 状态，外层
  Link 全部保持挂载；数字不变时 0 个重挂载、0 次重播。
- 图表 / charts：挂载 30ms 与 400ms 路径不同，400ms 后稳定；入场完成后
  刷新第一帧即终值；reduced-motion 首帧即终值。
- `errors`：**0**。

## 文件 / Files

- `shots.mjs`：静态服务 + mock API + 上述断言；输出截图、`report.json`。
- `baseline/`：改动前构建的 22 张元素截图。
- 根目录 22 张当前构建的元素截图（同名），加 `390-fourth-tab.png`、
  `sidebar-collapsed-1440-light.png` 两张动态截图。
- `report.json`：每一帧的差异读数、动态读数、checks、deviations、errors。
