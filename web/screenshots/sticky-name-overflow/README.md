# 服务器名称列收口与 1px 分隔线 / Server name column containment & 1px divider

中文：服务器页横向滚动的验收截图与 DOM 断言。修复三件事：名称列第二行
（`韩国 · 端口 10000-60000 · eth0`）溢出到地址列、sticky 列右侧 12px/20%
渐变在连续行上叠成粗竖条、以及由此让人以为「表格不能横向滚动」。
English: Acceptance screenshots and DOM assertions for horizontal scrolling on
the servers page. Fixes the overflowing name metadata, the 12px/20% sticky
gradient that stacked into a thick vertical bar, and the resulting impression
that the table cannot scroll sideways.

## 根因 / Root causes

1. **地址被盖住**：复选框列写了 `w-10`，但 auto table layout 把它压到 24px；
   名称列 `left-10`（40px）因此右移 16px，正好压住地址列前 16px。修复：
   复选框列加 `min-w-10`（真实 40px），名称列 `w-52 max-w-52`（208px）。
   The checkbox column declared `w-10` but auto layout shrank it to 24px, so
   the sticky name column at `left-10` shifted 16px right and covered the
   address. Fix: `min-w-10` on the checkbox column, `w-52 max-w-52` on name.
2. **元信息溢出**：`truncate` 的 flex 子项没有 `min-w-0`，以内容宽度为
   下限，始终截不住。修复：名称 / 元信息 span 都加 `min-w-0`，外层再兜
   `overflow-hidden`；完整文本进 `title`。
   The truncating flex children lacked `min-w-0`, so they kept their content
   width. Fix: `min-w-0` on both spans plus an `overflow-hidden` wrapper;
   full text stays in `title`.
3. **粗竖条**：`.pw-sticky-name::after` 由 12px 宽、20% 前景色渐变改成
   1px `var(--border)`。
   The 12px / 20% foreground gradient became a 1px `var(--border)` line.

## 截图 / Screenshots

| 文件 / File | 内容 / Content |
|---|---|
| `servers-1440-{dark,light}-initial.png` | 1440 初始：名称/元信息在单元格内截断，地址完整，右侧一条 1px 分隔线 / 1440 initial: contained metadata, complete address, 1px divider |
| `servers-1440-{dark,light}-scrolled.png` | 1440 横向滚到最右：名称列仍固定，地址/内容从它下面滑过，速率列露出来 / 1440 scrolled fully right: sticky name, content slides under, rate column revealed |
| `servers-1024-{dark,light}-overflow.png` | 1024 溢出态：右上角「左右滑动查看更多」在可见区 / 1024 overflow: the scroll hint is visible top-right |
| `servers-1024-{dark,light}-scrolled.png` | 1024 滚动后名称列仍固定 / sticky name after scrolling at 1024 |
| `servers-390-{dark,light}-cards.png` | 390 卡片视图：0 个表格、15 张卡片 / 390 cards: 0 tables, 15 cards |

## 实测 / Measured

| 项目 / Item | 1440 | 1024 |
|---|---|---|
| 容器 clientWidth / scrollWidth | 1152 / 1217 | 736 / 780 |
| 可横向滚动距离 / Max scroll | 65px | 44px |
| 名称列 / Name column | 208px，`sticky`，`left: 40px` | 同左 / same |
| 复选框列 / Checkbox column | 40px | 40px |
| 地址列 / Address column | 160px，`198.51.100.52` 完整 | 165.6px，完整 / complete |
| 名称单元格溢出 / Name cell overflow | 208 = 208 | 208 = 208 |
| 元信息行溢出 / Meta row overflow | 182 = 182 | 182 = 182 |
| 分隔线 / Divider | 1px `var(--border)` | 1px `var(--border)` |
| 滚动后名称列位置 / Sticky after scroll | 304–512px（可见） | 304–512px（可见） |
| 滑动提示 / Scroll hint | 可见且命中 / visible & hit-tested | 可见且命中 / visible & hit-tested |
| 390 卡片 / 390 cards | — | 15 卡片、0 表格 / 15 cards, 0 tables |

亮暗主题各测一遍：暗色 `var(--border)` 解析为 `oklch(1 0 0 / 0.08)`，
亮色为 `oklch(0.94 0.009 264.5)`；两种主题下 1px 线都不会变成竖条。
Both themes were measured; the resolved divider colours are
`oklch(1 0 0 / 0.08)` (dark) and `oklch(0.94 0.009 264.5)` (light).

`report.json` 是机读结果（30 条断言、几何、滚动交互）。
`report.json` contains the machine-readable result (30 assertions, geometry,
scroll interaction).

## 滚动交互 / Scroll interaction

- 水平滚轮 / horizontal wheel：1440 → 65px，1024 → 44px。
- Shift+滚轮 / Shift+wheel：同上；`Table` 里加了 native `wheel` 兜底
  （只接管 `shiftKey && deltaX === 0` 且表格确实溢出时），页面纵向位置不变。
  Same distances; `Table` now handles Shift+wheel natively (only when
  `shiftKey && deltaX === 0` and the table overflows), without moving the page.
- 拖滚动条 / scrollbar drag：容器是原生 `overflow-x-auto` 滚动区，并显式画
  了 8px 横向滚动条（`index.css`）。macOS headless Chrome 使用 overlay
  滚动条，滚动条不可命中，自动化无法拖拽；脚本记录
  `overlay-scrollbar-not-hit-testable-in-headless` 而不伪造通过。真实浏览器
  里拖动行为由原生滚动区提供。
  The container is a native `overflow-x-auto` scroller with an explicit 8px
  horizontal bar (`index.css`). macOS headless Chrome uses overlay scrollbars
  that are not hit-testable, so the script records the drag as not automatable
  instead of faking a pass; real browsers use the native scroller for dragging.

## 重新生成 / Regenerate

```bash
# 1) 当前前端构建 / current web build
make web-build

# 2) 预览库临时副本（只在这个副本里清空用户，用 devpass 初始化 admin；
#    服务器与业务数据保持原样）
#    Temporary copy of the preview DB: clear users only in the copy so the
#    master can bootstrap admin/devpass; servers and business rows stay as-is.
cp data/preview.db /tmp/pw-sticky.db
sqlite3 /tmp/pw-sticky.db "PRAGMA foreign_keys=OFF; DELETE FROM users;"

# 3) 主控 / master
PIERWAVE_DB='sqlite:///tmp/pw-sticky.db' PIERWAVE_ADMIN_PASSWORD=devpass \
  PIERWAVE_ADDR=127.0.0.1:8787 ./target/debug/pierwave-master

# 4) 截图 + 断言 / screenshots + assertions
node web/screenshots/sticky-name-overflow/shots.mjs
```

Playwright 取自仓库 `.npm-cache/_npx/.../playwright`，不新增依赖；需要本机
Chrome（可用 `CHROME_PATH` 覆盖，`BASE` / `ADMIN_PASSWORD` 也可覆盖）。
Playwright is loaded from the repo's `.npm-cache/_npx/...`, so no new
dependency is added; local Chrome is required (`CHROME_PATH`, `BASE` and
`ADMIN_PASSWORD` are overridable).
