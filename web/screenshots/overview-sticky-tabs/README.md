# 概览视图 tab 行吸顶 / Sticky overview view toolbar

> 状态：已实现并验收截图。只改 `OverviewInsight.tsx`、`index.css` 的吸顶样式、
> 对应测试与本目录；未 commit。
>
> Status: implemented with reproducible shots. Only `OverviewInsight.tsx`, the
> sticky styles in `index.css`, the related tests and this directory changed; no
> commit.

## 行为 / Behaviour

- **桌面（≥ md / 48rem）**：四个主视图 + 服务器筛选 + 链路子页所在的那一行
  `position: sticky; top: -1.5rem`。`-1.5rem` 抵消内容区 `main` 的 `p-6`：
  Chrome 会把 `top: 0` 解释成内容盒顶部，直接写 0 会低 24px、露出上方滚过的
  内容。吸顶后行的 `top` 恰好等于 `#main-content` 的顶部。
- **吸顶态**：`data-stuck="true"` 由 `OverviewInsight` 量出（匹配 md 且已贴
  顶）。只有此时才出现极淡的 `--background` 背景（88% + 8px backdrop blur）
  与底部 1px `--border` 分隔线；未滚动时两者都不出现，静止页面不会多一条线。
- **层级**：`z-index: 20`，低于 Dropdown / Dialog / Select 的 50–60。吸顶时
  打开服务器筛选弹层，弹层仍在吸顶行之上。
- **横向**：背景用 `margin-inline: -1.5rem` + `padding-inline: 1.5rem`
  铺满内容区，恰好停在 `main` 的 padding box 内；`scrollWidth` 始终等于
  `clientWidth`，不产生横向滚动。
- **切主视图**：`scrollTop` 回到内容容器 `#main-content` 的 0；不滚动文档。
- **窄屏（< md）**：不吸顶。没有媒体查询外的 sticky 规则，2×2 tab 保持原样；
  滚动后 tab 行随内容滚走，也不会出现分隔线。
- **共存**：不引入 `overflow`，焦点环、锚点定位不受裁剪；下拉 / 弹窗走
  portal，层级更高。

**English**: On `md+` the whole toolbar (four views + server filter + chain
sub-tabs) is `position: sticky` at the top of `#main-content`. The `-1.5rem`
offset cancels the content area's `p-6` (Chrome resolves `top: 0` against the
padding box here, which would leave a 24px strip of scrolling content above the
bar). A faint `--background` tint and a 1px `--border` line appear only while
`data-stuck="true"`; unscrolled pages keep the original borderless row.
`z-index: 20` stays below overlays (50–60), and the negative inline margin plus
matching padding keep the background inside the content padding box, so no
horizontal scrollbar appears. Switching the main view sets
`#main-content.scrollTop = 0` (never the document). Below `md` nothing sticks,
the 2×2 tab layout is unchanged, and no separator is rendered.

## 复现 / Reproduce

```bash
cd web
npm run build
node screenshots/overview-sticky-tabs/shots.mjs
```

脚本只读 `web/dist`，在 Playwright 里 mock `/api/v1/**`（不需要主控、数据库或
种子数据），沿用仓库 `.npm-cache/_npx` 里的 Playwright，不新增依赖。结果写入
`report.json`；任一断言失败时退出码为 1。

The script serves `web/dist` and mocks every API the overview needs, so no
controller, database or seed data is involved. It reuses the Playwright copy in
the repo's `.npm-cache/_npx` and adds no dependency. Results land in
`report.json`; any failed assertion exits with code 1.

## 截图 / Shots

| 文件 / File | 内容 / Contents |
|---|---|
| `desktop-top-{dark,light}-1440x900.png` | 1440 未滚动：tab 行在正常文档流，无背景 / 分隔线 / 1440 unscrolled, no background or separator |
| `desktop-stuck-{dark,light}-1440x900.png` | 1440 滚动中：tab 行贴顶 + 1px 分隔线，链路列表可见 / 1440 scrolled: toolbar pinned with 1px separator over the chain list |
| `mobile-top-{dark,light}-390x844.png` | 390 未滚动：2×2 tab 原样 / 390 unscrolled 2×2 tabs |
| `mobile-scrolled-{dark,light}-390x844.png` | 390 滚动中：tab 行滚走、没有吸顶 / 390 scrolled: toolbar scrolls away, no sticky |

## 断言 / Assertions

`report.json` 中 `failures: []`、`pageErrors: []`，共 **113** 条断言通过
（暗 / 亮各一遍）。关键实测值：

| 断言 / Assertion | 结果 / Result |
|---|---|
| 1440 滚动前 toolbar top / unscrolled top | `295.8px`（`main` top `56px`，不在吸顶态） |
| 1440 滚动 500 / 740 后 toolbar top | 两次均为 `56px`，与 `main` 顶部一致 |
| 分隔线 / separator | 未吸顶 `opacity: 0`；吸顶 `opacity: 1`、`height: 1px` |
| 背景 / background | 未吸顶 `transparent`；吸顶 `oklab(... / 0.88)` |
| 层级 / layering | toolbar `z-index: 20`，服务器筛选弹层 `z-index: 50` |
| 切视图 / view switch | `#main-content.scrollTop` 从 740 回到 `0`，toolbar 回到 `295.8px` |
| 390 吸顶 / 390 sticky | `position: static`、`data-stuck=false`、分隔线不存在 |
| 横向 / horizontal | 1440 `scrollWidth 1200 = clientWidth 1200`；390 `390 = 390` |
| 页面异常 / page errors | 0 |

此外 `web/src/components/overviewStickyTabs.test.mjs` 锁定源码契约：sticky
只在 md+ 媒体查询里、`data-stuck` 驱动分隔线与背景、窄屏不进入吸顶态、
切视图只滚 `#main-content`，并保证吸顶行确实包住筛选与子页。

The source-level contract lives in `web/src/components/overviewStickyTabs.test.mjs`
(sticky only inside the `md+` media query, `data-stuck` drives the hairline and
background, mobile never enters the stuck state, view switching scrolls
`#main-content` only, and the sticky row really wraps the filter and sub-tabs).
