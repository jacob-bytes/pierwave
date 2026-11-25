# 服务器列表 sticky 列滚动阴影 / Sticky-column scroll shadow

中文：服务器页横向滚动验收。名称列默认没有分隔线；只有横向滚动、内容
从名称列下面经过时才出现柔和投影；滚回最左端后淡出。右侧操作列同理，
滚动时左缘出现投影。上一版的 1px 竖线和宽渐变都已移除。
English: Horizontal-scroll acceptance for the servers page. The name column has
no divider by default; a soft shadow appears only while the table is scrolled
and content is passing underneath, then fades out at the left end. The actions
column mirrors this with a shadow on its left edge. The previous 1px divider and
wide gradient are gone.

## 实现 / Implementation

- 阴影是 **`box-shadow`**，不是伪元素渐变：
  `6px 0 10px -6px`（名称列，向右）、`-6px 0 10px -6px`（操作列，向左）。
- 表格是 `border-collapse: collapse`，直接给 `td` 加 `box-shadow` 会被单元格
  边界裁掉。因此 `TableHead` / `TableCell` 新增 `stickyShadow`，在 sticky
  单元格内部渲染一层 `position:absolute; inset:0; pointer-events:none` 的
  `[data-slot="sticky-scroll-shadow"]`，阴影画在它身上；sticky 单元格的
  `z-index` 保证阴影盖在滑过的内容之上。
- `Table` 监听横向滚动，把 `scrollLeft > 1` 同步成容器上的
  `data-scrolled-x="true"`。CSS 只在存在该属性时把投影 `opacity` 切到 1，
  过渡 180ms；回到 0 后属性移除，阴影淡出。
- 仅名称列（`stickyShadow` on `name`）和操作列（`stickyShadow` on `actions`）
  开启投影；同为首列 sticky 的复选框列不投影。
- 暗色 token `rgb(0 0 0 / 0.6)`，亮色 `rgb(0 0 0 / 0.16)`（暗色更高）。
- The shadow is a real `box-shadow` on an inner absolutely-positioned span,
  because `border-collapse: collapse` clips a `td`'s own shadow. `Table` mirrors
  `scrollLeft > 1` into `data-scrolled-x` on the container; CSS flips the
  shadow's opacity with a 180ms transition. Only the name column and the actions
  column opt in via `stickyShadow`.

## 截图 / Screenshots

| 文件 / File | 内容 / Content |
|---|---|
| `servers-1440-{dark,light}-initial.png` | 1440 未滚动：名称列右侧无分隔线、无阴影 / 1440 at rest: no divider, no shadow |
| `servers-1440-{dark,light}-scrolling.png` | 1440 滚动中：名称列右缘、操作列左缘柔和阴影 / 1440 mid-scroll: soft shadows on both sticky edges |
| `servers-1440-{dark,light}-back.png` | 1440 滚回最左：阴影消失，与初始一致 / 1440 back at left: shadow gone |
| `servers-1024-{dark,light}-initial.png` | 1024 未滚动 + 溢出提示可见 / 1024 at rest with scroll hint |
| `servers-1024-{dark,light}-scrolling.png` | 1024 滚动中 / 1024 mid-scroll |
| `servers-1024-{dark,light}-back.png` | 1024 滚回最左 / 1024 back at left |
| `servers-390-{dark,light}-cards.png` | 390 卡片视图：0 表格、0 投影 / 390 cards: no table, no shadow |

## 实测 / Measured

| 项目 / Item | 结果 / Result |
|---|---|
| 未滚动阴影 / At-rest shadow | 两侧 `opacity: 0`；`td box-shadow: none`；`::after content: none` |
| 滚动中阴影 / Mid-scroll | 两侧 `opacity: 1`，`6px/-6px 0 10px -6px`；`background-image: none` |
| 回滚后 / Back at left | 两侧 `opacity: 0`；`data-scrolled-x` 移除 |
| 暗色 / Dark token | `rgb(0 0 0 / 0.6)`，像素扫描边缘最大约 -4.3/255 |
| 亮色 / Light token | `rgb(0 0 0 / 0.16)`，像素扫描边缘最大约 -19/255 |
| 阴影覆盖宽度 / Visual extent | 约 9–10px（x=512→521），无实线 / ~9–10px, no solid line |
| 1440 / 1024 可滚动距离 | 65px / 44px（与上一轮一致） |
| 名称列 / Name column | 208px、sticky `left: 40px`，滚动时保持可见 |
| 地址列 / Address column | 160px / 165.6px，初始完整可读 |
| 390 | 15 卡片、0 表格、0 投影 |

亮暗各测 1440 与 1024；`report.json` 里每条宽度都有 `initial / scrolling /
back` 三态的 opacity、box-shadow、`::after` 与几何数据，共 14 条断言。
Both themes at 1440 and 1024; `report.json` stores the three states per width,
including opacity, box-shadow, `::after` and geometry, with 14 assertions.

截图使用 `reducedMotion: "reduce"` 让呼吸 / 入场动画静止，便于逐张对比；
真实交互仍是 180ms 淡入淡出。`servers-1440-dark-initial.png` 与
`servers-1440-dark-back.png` 逐像素一致。
Screenshots use `reducedMotion: "reduce"` so breathing/enter animations do not
make comparisons noisy; the UI still fades over 180ms.

## 重新生成 / Regenerate

```bash
# 1) 当前前端构建 / current web build
make web-build

# 2) 预览库临时副本（只在这个副本里清空用户，用 devpass 初始化 admin；
#    服务器数据保持原样）
#    Temporary copy of the preview DB: clear users only in the copy so the
#    master can bootstrap admin/devpass; server rows stay as-is.
cp data/preview.db /tmp/pw-sticky.db
sqlite3 /tmp/pw-sticky.db "PRAGMA foreign_keys=OFF; DELETE FROM users;"

# 3) 主控 / master
PIERWAVE_DB='sqlite:///tmp/pw-sticky.db' PIERWAVE_ADMIN_PASSWORD=devpass \
  PIERWAVE_ADDR=127.0.0.1:8787 ./target/debug/pierwave-master

# 4) 截图 + 断言 / screenshots + assertions
node web/screenshots/sticky-name-overflow/shots.mjs
```

Playwright 取自仓库 `.npm-cache/_npx/.../playwright`，不新增依赖；需要本机
Chrome（`CHROME_PATH` 覆盖），`BASE` / `ADMIN_PASSWORD` 也可覆盖。
Playwright is loaded from the repo's `.npm-cache/_npx/...`, so no new
dependency is added; local Chrome is required (`CHROME_PATH`, `BASE` and
`ADMIN_PASSWORD` are overridable).
