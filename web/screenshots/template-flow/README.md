# 转发链模板拓扑截图 / Chain template topology screenshots

## 中文

这组截图覆盖转发链模板详情里的 React Flow 拓扑画布：3 / 4 / 6 跳、折叠与展开、
每列顶部的列头（列名 + `4 / 7 台`，细线距卡片 6px、列名/计数对比度实测）、
卡片与连线 hover 路径（药丸跟着一起压暗）、时延药丸 tooltip 与「指针移入
tooltip 时高亮保持」、100% / 50% / 150% 缩放、右缘 / 下缘「还有内容」提示
（含渐隐之上的署名）、390、亮暗、英文单数（`1 node` / `1 target` /
`1 chain · 1 user`）、空态、旧主控降级、reduced-motion 与平移 / 缩放帧率。

### 数据来源

- 页面由 `web/scripts/shots-template-flow.mjs` 用 Playwright 的 `page.route`
  注入 mock：模板列表 `/api/v1/overview/chain-templates`、详情与链路时延
  `/api/v1/overview/chain-health`。不依赖真实模板、真实转发链或 Agent 上报。
- 3 跳模板含降级 / 离线成员与 6 个目标；4 跳与 6 跳覆盖折叠卡与多列
  （6 跳 = 入口 + 6 个中转 + 目标，共 8 列，首屏必须整图可见）；
  「6 台 × 3 目标」模板覆盖上游被折叠时的目标 `+N` 展开；「8 台」模板在展开后
  覆盖同一竖线超过 6 个药丸的密集隐藏；「4 跳单台」模板入口 1 台、目标 1 个，
  用来验证英文单数；空模板没有任何链；旧主控用详情接口 404 模拟。
- 主控库里至少要有一台服务器（否则总览是「新装空态」，不会渲染转发链 tab）。
- 每次运行会把断言结果写到本目录的 `report.json`（截图清单、缩放、每列卡片数、
  列头数量与文案、列头细线间距 / 列名与计数对比度、英文单数、字体大小、tooltip、
  右缘 / 下缘提示、帧率、chunk 大小等）；帧率在 `fps.pan` / `fps.zoom`，
  同时记录采样帧数、目标值与无头门槛。

### 复现命令

```bash
# 1) 构建前端
cd web && npm run build && cd ..

# 2) 起一个可登录的主控（示例用临时库，密码 devpass）
CARGO_HOME=$PWD/.cargo-home cargo build -q -p pierwave-master
PIERWAVE_ADDR=127.0.0.1:8787 \
PIERWAVE_DB="sqlite://$PWD/data/template-flow-shots.db?mode=rwc" \
PIERWAVE_ADMIN_PASSWORD=devpass ./target/debug/pierwave-master

# 2b) 建一台服务器，否则总览停在「新装空态」
curl -s -c /tmp/pw-cookie -X POST http://127.0.0.1:8787/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"devpass"}'
curl -s -b /tmp/pw-cookie -X POST http://127.0.0.1:8787/api/v1/servers \
  -H 'Content-Type: application/json' -d '{"name":"shots-seed","address":"10.0.0.1"}'

# 3) 另开终端跑截图（默认写回本目录；OUT_DIR 可改到别处做验证）
ADMIN_PASSWORD=devpass node web/scripts/shots-template-flow.mjs http://127.0.0.1:8787
ADMIN_PASSWORD=devpass OUT_DIR=/tmp/template-flow-shots \
  node web/scripts/shots-template-flow.mjs http://127.0.0.1:8787
```

`baseUrl` 省略时用 `http://127.0.0.1:8787`；`ADMIN_PASSWORD` 省略时用 `devpass`。
本目录的产物由一次完整运行生成：`ADMIN_PASSWORD=demo12345` 连
`http://127.0.0.1:8795`。脚本用 `page.route` 注入 mock，不需要真实模板数据。

环境变量：`PLAYWRIGHT_MODULE` / `CHROME_PATH` / `OUT_DIR` / `ADMIN_PASSWORD` /
`HEADED`（`HEADED=1` 走有头窗口，帧率按 45fps 断言）。

Playwright 不在 `web/` 的依赖里。脚本按以下顺序查找，优先用环境变量覆盖：

```bash
# 指定 playwright 的 index.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
node web/scripts/shots-template-flow.mjs
```

未设置时会在仓库内 `.npm-cache/_npx/*/node_modules/playwright` 中查找，最后回退
到 `import("playwright")`；不再写死某台机器的 npx 哈希目录。

### 主要产物

- `3hop-1440-dark.png` / `3hop-1440-light.png`：字号、列距、署名颜色，以及
  每列顶部的列头（列名 + 台数 / 目标数，折叠列写 `4 / 6 台`）；
- `column-header-closeup-1440-dark.png` / `column-header-closeup-1440-light.png`：
  100% 下的列头特写：文字 → 细线 → 6px → 卡片，亮暗各一张；
- `column-header-gap-6px-1440-dark.png`：同一特写加临时标尺，直接标出细线到
  卡片顶边的 6px；
- `singular-en-1440-dark.png`、`singular-entry-en-1440-dark.png`、
  `singular-target-en-1440-dark.png`：英文单数入口列 `1 node`、目标列
  `1 target`，卡片副标题 `1 chain · 1 user`，弹窗徽标 `1 chain` / `1 user`；
- `4hop-1440-dark.png`：5 列首屏整图可见（fit 约 73%），折叠列头显示
  `4 / 7 台`，缩放栏给出「已缩小到 X%，可点击 + 放大」提示；
- `6hop-1440-dark.png` / `6hop-fit-hint-1440-dark.png`：8 列（含 8 个列头）
  首屏整图可见与缩小提示；`6hop-fit-1440-dark.png` 是「适应窗口」；`6hop-zoom-in-1440-dark.png` /
  `6hop-fit-zoom-in-1440-dark.png` 是放大后与 fit 后再放大；
- `fold-target-before-1440-dark.png` / `fold-target-after-1440-dark.png`：
  上游折叠时目标 `+N` 的前后对比；
- `dense-pills-hidden-1440-dark.png` / `dense-pills-hover-1440-dark.png`：
  同一竖线 8 个药丸默认隐藏 / 悬停显示；
- `hover-path-1440-dark.png` / `hover-edge-1440-dark.png`：卡片 hover 与药丸
  hover 都会点亮到入口的路径，其余 35% 淡出；连线 hover 时路径外的药丸
  也一起压暗；
- `tooltip-pill-1440-dark.png`、`tooltip-unavailable-1440-dark.png`、
  `tooltip-merged-1440-dark.png`：时延 / 最近已知 / 合并虚线 tooltip；
- `tooltip-retained-1440-dark.png`：指针从药丸移进 tooltip 后路径仍保持高亮；
- `zoom-150-1440-dark.png`、`fold-target-after-1440-dark.png`、密集药丸两张：
  内容超出画布下缘时的下缘渐隐与「下方还有内容」按钮；
- `bottom-hint-attribution-1440-dark.png`：下缘渐隐之上的右下角署名
  （渐隐盖内容，但署名不被压暗）；
- `6hop-390-dark.png`：390 固定 1 倍 + 横向滚动；
- `report.json`：本次运行的断言、截图清单与帧率（`fps.pan` / `fps.zoom`）。

### 断言清单

脚本在截图的同时断言（失败即退出，不写半套报告）：

- 每列可见卡片 ≤ 5（4 张成员 + 1 张折叠卡）；
- 首屏 = 适应窗口：3 / 4 / 6 跳的整张图（全部列与行）都在视口内，缩放等于
  fit，内容盒居中误差 ≤ 1px；
- 自适应缩放 < 90% 时缩放栏旁出现「已缩小到 X%，可点击 + 放大」轻提示并含当前
  百分比；≥ 90% 时不出现；
- 卡片标题 13px，状态 / 第二行 / 时延药丸 12px，React Flow 署名 12px；
- React Flow 署名是中性 muted 灰，不跟随链接蓝 / 强调色；
- 同一竖线的药丸超过 6 个时默认隐藏，悬停竖线后出现；
- 时延药丸可聚焦，tooltip 含时延、链数、用户数；不可用路径显示「最近已知」；
- 合并虚线 tooltip 显示「来自已折叠的 N 条路径，共 X 条链」；
- 折叠卡 / 目标 `+N` 只展开自己那一组；上游被折叠时每个 `+N` 仍能展开；
- 每列顶部有一个列头：y = 24、高 32px、与卡片左边缘对齐；第一张卡 y = 56，
  列间距 80px、卡片 192×64；列头文案按「目标列 `4 / 6 个`、其余列 `4 / 7 台`」，
  折叠时写 `shown / total`，只有一个时写单数；列头不可 Tab / 点击、不参与高亮
  （卡片被压暗时仍是不透明 1）、卡片计数不含列头；空模板不渲染列头；
- 列头细线到卡片顶边实测 6px（100% 与 fit 缩放都换算回画布坐标断言），
  文字到细线约 4px；列名与计数同色（`text-muted-foreground`），列名
  `font-medium`(500)、计数 400，两者对卡片背景的实测对比度亮色 / 暗色都 ≥ 4.5:1
  （`report.json` 的 `headerStyle` / `headerStyleLight` / `headerStyleAt100`）；
- 英文单数：4 跳单台夹具的入口列写 `1 node`、目标列写 `1 target`（不是
  nodes / targets），卡片副标题 `1 chain · 1 user`、弹窗徽标 `1 chain` /
  `1 user`；`+1 target` / `+1 node` 由单测覆盖键选择，中文文案保持
  「1 条链 · 1 用户」；
- 所有连线宽度 1.5–4（按链数），脉冲亮划 = 0.7 × 线宽且不粗于线，连接点
  半径 2、描边 1.2；
- 首屏整图可见时右缘 / 下缘提示都不出现；放大到 125% 后提示重新出现，且按
  「列内卡片的右边缘是否超出视口」计数：只露出半截的列也计入（3c 块会把视口
  边界拖进列内再断言），卡片右边缘刚好贴住视口右缘时不计；
- 点「右侧还有 N 列」一次平移一屏（220ms），平移到最右后提示消失，且没有卡片
  右边缘还留在视口外；
- 内容超出画布下缘时出现下缘渐隐 +「下方还有内容」；点一次下一屏，到底后消失；
  3 跳 / 50% / 适应窗口下内容放得下，提示不出现（缩放 / 平移后重算）；
- 画布高度 ≤ min(640, 视口高度 × 0.52)；
- 普通滚轮滚弹窗、Ctrl / ⌘ + 滚轮缩放、拖拽平移不丢图、双击不缩放；
- 390 固定 1 倍 + 横向滚动、页面不横向溢出、缩放栏隐藏；
- 390 的画布仍是单指竖滑滚弹窗（`touch-action: pan-y`）；
- 折叠卡 tooltip 标题含「第 N 跳」（卡片标题仍只有 `+N 台`），折叠卡副标题仍保留
  「X 条链 · Y 用户 · 含 N 台离线」；普通卡片的副标题只写「X 条链 · Y 用户」，
  不再重复列名（列头承担），aria-label 仍带列名；
- 药丸 / 合并虚线 hover 或聚焦都会点亮该连线到入口的路径，其余压到 35%；脉冲
  边仍 ≤ 10，键盘仍可 Tab 到药丸与合并虚线；
- 药丸随路径一起压暗：压暗药丸数与「有药丸的压暗连线」数一致，每颗药丸的
  `data-hot` 与实测 opacity 都和它自己那条连线一致（压暗 35%、高亮 100%），
  密集隐藏的药丸不会被这条规则提前显示；
- tooltip 打开期间高亮保持：指针从药丸移到 tooltip 上后连线 / 药丸仍是高亮
  100%、其余卡片仍压暗；指针离开药丸与 tooltip 后高亮统一清除，tooltip 关闭；
- 右缘 / 下缘渐隐出现时，署名与渐隐在同一个 stacking context，署名 z-index
  更高；把渐隐临时改成可命中后用 `elementFromPoint` 实测署名是最上层、可点；
- `prefers-reduced-motion: reduce` 下「右侧 / 下方还有」的平移是瞬时的（0ms，
  3 帧内到终点），脉冲静止但仍可见；其它动效照旧；
- 帧率：平移 / 缩放各连续 1 秒用 rAF 计帧。默认无头 Chrome（软件合成、没有
  GPU 合成器）按 ≥ 30fps 断言；`HEADED=1` 开有头窗口时按真机目标 ≥ 45fps 断言。
  两种模式的实测值都写进 `report.json` 的 `fps.pan` / `fps.zoom`（另含采样帧数、
  `target`、实际生效的 `floor`、`headless`）；
- 同时脉冲边 ≤ 10、画布 DOM ≤ 600、主 chunk 与「链路时延」chunk 不含 React Flow。

> 本目录的 PNG 与 `report.json` 由同一次完整运行生成；截图与断言不一致时，
> 以重新运行脚本的结果为准。

## English

These screenshots cover the React Flow topology canvas in the chain-template
detail dialog: 3 / 4 / 6 hops, folding and expanding, the per-column headers
(name + `4 / 7 nodes`, the rule 6px above the cards, measured name/count
contrast), card and link hover paths (pills dim with the path), latency-pill
tooltips and the highlight staying lit while the pointer is over a tooltip,
100% / 50% / 150% zoom, the right/bottom "more content" hints (with the
attribution above the fade), 390px, light/dark, English singulars
(`1 node` / `1 target` / `1 chain · 1 user`), empty state, old-controller
fallback, reduced motion and pan / zoom frame rates.

### Where the data comes from

- `web/scripts/shots-template-flow.mjs` injects mocks with Playwright
  `page.route` for the template list (`/api/v1/overview/chain-templates`),
  template detail and chain health (`/api/v1/overview/chain-health`). No real
  templates, chains or Agent reports are needed.
- The 3-hop fixture includes degraded/offline members and six targets; the 4-hop
  and 6-hop fixtures cover folded cards and many columns (6 hops = entry + 6
  intermediate hops + target, 8 columns, all visible on the first screen); the "6 nodes × 3
  targets" fixture covers expanding target `+N` groups whose upstream member is
  folded; the "8 nodes" fixture covers hiding more than 6 pills on one rail
  after expanding; the "4-hop single" fixture has exactly one entry and one
  target for the English singular checks; the empty fixture has no chains; the
  old-controller case is a 404 detail response.
- The controller database needs at least one server, otherwise the overview
  stays in the "new install" empty state and never renders the chain tabs.
- Every run writes `report.json` in this directory (screenshot list, zoom,
  per-column card counts, header count and copy, rule-to-card gap and measured
  name/count contrast, English singulars, font sizes, tooltips, overflow hints,
  frame rates, chunk sizes, …); frame rates live in `fps.pan` / `fps.zoom`
  together with the sampled frame counts, the target and the headless floor.

### Reproduce

```bash
# 1) Build the SPA
cd web && npm run build && cd ..

# 2) Start a controller you can log into (temporary DB, password devpass)
CARGO_HOME=$PWD/.cargo-home cargo build -q -p pierwave-master
PIERWAVE_ADDR=127.0.0.1:8787 \
PIERWAVE_DB="sqlite://$PWD/data/template-flow-shots.db?mode=rwc" \
PIERWAVE_ADMIN_PASSWORD=devpass ./target/debug/pierwave-master

# 2b) Create one server, otherwise the overview stays in the new-install state
curl -s -c /tmp/pw-cookie -X POST http://127.0.0.1:8787/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"devpass"}'
curl -s -b /tmp/pw-cookie -X POST http://127.0.0.1:8787/api/v1/servers \
  -H 'Content-Type: application/json' -d '{"name":"shots-seed","address":"10.0.0.1"}'

# 3) In another terminal, take the screenshots (written back here)
ADMIN_PASSWORD=devpass node web/scripts/shots-template-flow.mjs http://127.0.0.1:8787
ADMIN_PASSWORD=devpass OUT_DIR=/tmp/template-flow-shots \
  node web/scripts/shots-template-flow.mjs http://127.0.0.1:8787
```

`baseUrl` defaults to `http://127.0.0.1:8787`, `ADMIN_PASSWORD` to `devpass`. The
artifacts in this directory come from one full run against
`http://127.0.0.1:8795` with `ADMIN_PASSWORD=demo12345`; the script mocks the
template data with `page.route`, so no real templates are needed.

Environment variables: `PLAYWRIGHT_MODULE`, `CHROME_PATH`, `OUT_DIR`,
`ADMIN_PASSWORD` and `HEADED` (`HEADED=1` for a headed window and the 45fps
floor).

Playwright is not a dependency of `web/`. The script resolves it in this order
(environment overrides win):

```bash
# Point at Playwright's index.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
node web/scripts/shots-template-flow.mjs
```

Without overrides it searches
`.npm-cache/_npx/*/node_modules/playwright` inside the repository, then falls
back to `import("playwright")` — no hard-coded npx hash directory.

### Main outputs

- `3hop-1440-dark.png` / `3hop-1440-light.png`: type sizes, column gap,
  attribution colour and the per-column headers (name + node/target count,
  `4 / 6 nodes` on the folded target column);
- `column-header-closeup-1440-dark.png` / `column-header-closeup-1440-light.png`:
  the header at 100% — text → rule → 6px → card — in both themes;
- `column-header-gap-6px-1440-dark.png`: the same close-up with a temporary
  ruler marking the 6px between the rule and the card top;
- `singular-en-1440-dark.png`, `singular-entry-en-1440-dark.png`,
  `singular-target-en-1440-dark.png`: English singulars `1 node` (entry),
  `1 target` (target), card subtitle `1 chain · 1 user`, dialog badges
  `1 chain` / `1 user`;
- `4hop-1440-dark.png`: five columns fully visible on the first screen (fit ≈
  73%), folded headers read `4 / 7 nodes`, plus the "Zoomed to {percent}%; use +
  to zoom in" hint;
- `6hop-1440-dark.png` / `6hop-fit-hint-1440-dark.png`: all 8 columns (and their
  8 headers) fit on the first screen plus the zoom hint; `6hop-fit-1440-dark.png`
  is fit-to-view;
  `6hop-zoom-in-1440-dark.png` / `6hop-fit-zoom-in-1440-dark.png` show zooming
  in after opening and after fit;
- `fold-target-before-1440-dark.png` / `fold-target-after-1440-dark.png`:
  target `+N` before/after when the upstream member is folded;
- `dense-pills-hidden-1440-dark.png` / `dense-pills-hover-1440-dark.png`:
  eight pills on one rail hidden by default / revealed on hover;
- `hover-path-1440-dark.png` / `hover-edge-1440-dark.png`: hovering a card and
  hovering a pill both light the path to the entry and fade the rest to 35%;
  pills outside the hovered link dim with it;
- `tooltip-pill-1440-dark.png`, `tooltip-unavailable-1440-dark.png`,
  `tooltip-merged-1440-dark.png`: latency, last-known and merged-line tooltips;
- `tooltip-retained-1440-dark.png`: the path stays highlighted after the pointer
  moves from the pill into its tooltip;
- `zoom-150-1440-dark.png`, `fold-target-after-1440-dark.png` and both dense-pill
  shots: the bottom fade and "more content below" button when content overflows;
- `bottom-hint-attribution-1440-dark.png`: the bottom-right attribution above the
  bottom fade (the fade covers content, not the attribution);
- `6hop-390-dark.png`: 390px, fixed 1× with horizontal scrolling;
- `report.json`: assertions, screenshot list and frame rates (`fps.pan` /
  `fps.zoom`) for the run.

### Assertion checklist

The script asserts while capturing (a failure exits non-zero and no partial
report is written):

- at most 5 visible cards per column (4 members + 1 folded card);
- the initial view is fit-to-view: for 3 / 4 / 6 hops the whole graph (every
  column and row) is inside the viewport, the zoom equals fit, and the content
  box is centred within 1px;
- when the fit zoom is < 90%, a lightweight "Zoomed to {percent}%; use + to zoom
  in" hint appears next to the zoom bar with the current percentage; at ≥ 90% it
  is absent;
- 13px card titles, 12px status / second line / latency pills, 12px React Flow
  attribution;
- the React Flow attribution is neutral muted grey, not link blue / the accent;
- more than 6 pills on one vertical rail are hidden by default and appear when
  the rail is hovered;
- latency pills are focusable and their tooltip shows latency, chains and users;
  unavailable paths say "last known";
- merged dashed lines say "folded from N paths · X chains total";
- folded cards / target `+N` only expand their own group; every `+N` still works
  when the upstream member itself is folded;
- every column has a header at y = 24, 32px tall and left-aligned with its
  cards; the first card is at y = 56, with 80px column gaps and 192×64 cards.
  Header copy follows "target columns `4 / 6 targets`, other columns
  `4 / 7 nodes`", shows `shown / total` when folded and the singular when only
  one is shown; headers are not tabbable or clickable, never highlighted (still
  opacity 1 while cards dim), and the card count excludes them; the empty
  template renders no headers;
- the header rule is 6px above the card top (asserted at both 100% and fit zoom
  after converting back to canvas coordinates) and about 4px below the text;
  name and count share the same colour (`text-muted-foreground`), the name uses
  `font-medium` (500) and the count 400, and both measure ≥ 4.5:1 against the
  card background in both themes (`headerStyle` / `headerStyleLight` /
  `headerStyleAt100` in `report.json`);
- English singulars: the 4-hop single fixture renders `1 node` on the entry
  column and `1 target` on the target column (never nodes / targets), the card
  subtitle is `1 chain · 1 user` and the dialog badges read `1 chain` /
  `1 user`; `+1 target` / `+1 node` key selection is covered by unit tests and
  the Chinese copy stays 「1 条链 · 1 用户」;
- every link is 1.5–4px wide by chain count, the pulse stroke is 0.7× the link
  width and never wider than the link, and connection dots are r 2 with a 1.2
  stroke;
- with the whole graph visible at fit, neither the right-edge nor the bottom
  hint appears; after zooming to 125% they return, and the right-edge hint
  counts columns whose **card right edge** is past the viewport, including
  half-visible ones (block 3c drags the boundary into a column before
  asserting); a column whose card right edge sits exactly on the viewport edge
  does not count;
- clicking "{n} more columns" pans one screen (220ms); at the far right the hint
  disappears and no card right edge is left outside the viewport;
- when content overflows the bottom, a bottom fade and a "more content below"
  button appear; one click pans one screen and the button disappears at the
  bottom. 3 hops / 50% / fit-to-view keep everything in view, so it stays hidden
  (recomputed after every zoom or pan);
- canvas height ≤ min(640, viewport height × 0.52);
- plain wheel scrolls the dialog, Ctrl / ⌘ + wheel zooms, dragging never loses
  the graph, double-click does not zoom;
- at 390px the canvas is fixed at 1× with horizontal scrolling, the page does not
  overflow horizontally, and the zoom bar is hidden;
- at 390px single-finger vertical scrolling still scrolls the dialog
  (`touch-action: pan-y`);
- the folded-card tooltip title includes "Hop N" (the card title itself stays
  "+N nodes") and its subtitle still shows chains / users / offline nodes;
  regular card subtitles only show chains / users and no longer repeat the
  column name (the header does), while the aria-label still carries it;
- hovering or focusing a pill / merged line lights that link's path to the entry
  and fades the rest to 35%; still at most 10 pulsing edges, and pills and merged
  lines stay keyboard reachable;
- pills dim with the path: the number of dimmed pills equals the number of dimmed
  links that have a pill, and every pill's `data-hot` and measured opacity match
  its own link (35% dimmed, 100% highlighted); hidden dense pills are not revealed
  by this rule;
- the highlight stays lit while the tooltip is open: after the pointer moves from
  the pill onto the tooltip the link and pill are still at 100% and the other
  cards stay dimmed; leaving both the pill and the tooltip clears the highlight
  and closes the tooltip;
- when the right/bottom fades appear, the attribution shares their stacking
  context with a higher z-index; with the fade temporarily made hit-testable,
  `elementFromPoint` proves the attribution is on top and clickable;
- under `prefers-reduced-motion: reduce` the right/bottom pans are instant (0ms,
  reaches the target within 3 frames) while the pulse stays static but visible;
  every other animation is unchanged;
- frame rate: 1 second of panning and 1 second of zooming, counted with rAF.
  Headless Chrome (software compositing, no GPU compositor) is the default and
  asserts ≥ 30fps; `HEADED=1` opens a real window and asserts the real-hardware
  target of ≥ 45fps. Either way the measured values go to `fps.pan` /
  `fps.zoom` in `report.json` (plus frame counts, `target`, the effective
  `floor` and `headless`);
- at most 600 canvas DOM nodes, and neither the main chunk nor the
  chain-latency chunk contains React Flow.

> The PNGs and `report.json` in this directory come from the same full run; when
> they disagree with the assertions, re-running the script is authoritative.
