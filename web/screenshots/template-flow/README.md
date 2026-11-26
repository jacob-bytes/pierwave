# 转发链模板拓扑截图 / Chain template topology screenshots

## 中文

这组截图覆盖转发链模板详情里的 React Flow 拓扑画布：3 / 4 / 6 跳、折叠与展开、
hover 路径、时延药丸 tooltip、100% / 50% / 150% 缩放、390、亮暗、空态、旧主控降级
与 reduced-motion。

### 数据来源

- 页面由 `web/scripts/shots-template-flow.mjs` 用 Playwright 的 `page.route`
  注入 mock：模板列表 `/api/v1/overview/chain-templates`、详情与链路时延
  `/api/v1/overview/chain-health`。不依赖真实模板、真实转发链或 Agent 上报。
- 3 跳模板含降级 / 离线成员与 6 个目标；4 跳与 6 跳覆盖折叠卡与多列；
  「6 台 × 3 目标」模板覆盖上游被折叠时的目标 `+N` 展开；「8 台」模板在展开后
  覆盖同一竖线超过 6 个药丸的密集隐藏；空模板没有任何链；旧主控用详情接口 404 模拟。
- 主控库里至少要有一台服务器（否则总览是「新装空态」，不会渲染转发链 tab）。
- 每次运行会把断言结果写到本目录的 `report.json`（截图清单、缩放、每列卡片数、
  字体大小、tooltip、chunk 大小等）。

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
node web/scripts/shots-template-flow.mjs http://127.0.0.1:8787
OUT_DIR=/tmp/template-flow-shots node web/scripts/shots-template-flow.mjs
```

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

- `3hop-1440-dark.png` / `3hop-1440-light.png`：字号、列距、署名颜色；
- `4hop-1440-dark.png`：5 列 + 右缘「右侧还有 N 列」提示；
- `fold-target-before-1440-dark.png` / `fold-target-after-1440-dark.png`：
  上游折叠时目标 `+N` 的前后对比；
- `dense-pills-hidden-1440-dark.png` / `dense-pills-hover-1440-dark.png`：
  同一竖线 8 个药丸默认隐藏 / 悬停显示；
- `tooltip-pill-1440-dark.png`、`tooltip-unavailable-1440-dark.png`、
  `tooltip-merged-1440-dark.png`：时延 / 最近已知 / 合并虚线 tooltip；
- `6hop-390-dark.png`：390 固定 1 倍 + 横向滚动；
- `report.json`：本次运行的断言与截图清单。

### 断言清单

脚本在截图的同时断言（失败即退出，不写半套报告）：

- 每列可见卡片 ≤ 5（4 张成员 + 1 张折叠卡）；
- 首屏缩放 90–100%，且卡片标题按缩放折算后仍 ≥ 11.7px；
- 卡片标题 13px，状态 / 第二行 / 时延药丸 12px，React Flow 署名 12px；
- React Flow 署名是中性 muted 灰，不跟随链接蓝 / 强调色；
- 同一竖线的药丸超过 6 个时默认隐藏，悬停竖线后出现；
- 时延药丸可聚焦，tooltip 含时延、链数、用户数；不可用路径显示「最近已知」；
- 合并虚线 tooltip 显示「来自已折叠的 N 条路径，共 X 条链」；
- 折叠卡 / 目标 `+N` 只展开自己那一组；上游被折叠时每个 `+N` 仍能展开；
- 每列顶边对齐（第一张卡 y = 24），列间距 80px、卡片 192×64；
- 默认 0.9 下右侧仍有列时出现「右侧还有 N 列」提示，点击平移一屏后消失 / 更新；
- 画布高度 ≤ min(640, 视口高度 × 0.52)；
- 普通滚轮滚弹窗、Ctrl / ⌘ + 滚轮缩放、拖拽平移不丢图、双击不缩放；
- 390 固定 1 倍 + 横向滚动、页面不横向溢出、缩放栏隐藏；
- 390 的画布仍是单指竖滑滚弹窗（`touch-action: pan-y`）；
- 同时脉冲边 ≤ 10、画布 DOM ≤ 600、主 chunk 与「链路时延」chunk 不含 React Flow。

> 本轮只更新脚本的 Playwright 查找方式与断言口径；现有 PNG 由下一轮重新生成，
> 因此截图与最新断言不一致时以重新运行脚本的结果为准。

## English

These screenshots cover the React Flow topology canvas in the chain-template
detail dialog: 3 / 4 / 6 hops, folding and expanding, hover paths, latency-pill
tooltips, 100% / 50% / 150% zoom, 390px, light/dark, empty state, old-controller
fallback and reduced motion.

### Where the data comes from

- `web/scripts/shots-template-flow.mjs` injects mocks with Playwright
  `page.route` for the template list (`/api/v1/overview/chain-templates`),
  template detail and chain health (`/api/v1/overview/chain-health`). No real
  templates, chains or Agent reports are needed.
- The 3-hop fixture includes degraded/offline members and six targets; the 4-hop
  and 6-hop fixtures cover folded cards and many columns; the "6 nodes × 3
  targets" fixture covers expanding target `+N` groups whose upstream member is
  folded; the "8 nodes" fixture covers hiding more than 6 pills on one rail
  after expanding; the empty fixture has no chains; the old-controller case is a
  404 detail response.
- The controller database needs at least one server, otherwise the overview
  stays in the "new install" empty state and never renders the chain tabs.
- Every run writes `report.json` in this directory (screenshot list, zoom,
  per-column card counts, font sizes, tooltips, chunk sizes, …).

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
node web/scripts/shots-template-flow.mjs http://127.0.0.1:8787
OUT_DIR=/tmp/template-flow-shots node web/scripts/shots-template-flow.mjs
```

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
  attribution colour;
- `4hop-1440-dark.png`: five columns plus the "{n} more columns" hint;
- `fold-target-before-1440-dark.png` / `fold-target-after-1440-dark.png`:
  target `+N` before/after when the upstream member is folded;
- `dense-pills-hidden-1440-dark.png` / `dense-pills-hover-1440-dark.png`:
  eight pills on one rail hidden by default / revealed on hover;
- `tooltip-pill-1440-dark.png`, `tooltip-unavailable-1440-dark.png`,
  `tooltip-merged-1440-dark.png`: latency, last-known and merged-line tooltips;
- `6hop-390-dark.png`: 390px, fixed 1× with horizontal scrolling;
- `report.json`: assertions and screenshot list for the run.

### Assertion checklist

The script asserts while capturing (a failure exits non-zero and no partial
report is written):

- at most 5 visible cards per column (4 members + 1 folded card);
- initial zoom is 90–100%, and the card title still measures ≥ 11.7px after the
  zoom is applied;
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
- every column's top card is aligned at y = 24, with 80px column gaps and
  192×64 cards;
- when columns still overflow at 0.9, a "{n} more columns" hint appears at the
  right edge and clicking it pans one screen until the hint disappears/updates;
- canvas height ≤ min(640, viewport height × 0.52);
- plain wheel scrolls the dialog, Ctrl / ⌘ + wheel zooms, dragging never loses
  the graph, double-click does not zoom;
- at 390px the canvas is fixed at 1× with horizontal scrolling, the page does not
  overflow horizontally, and the zoom bar is hidden;
- at 390px single-finger vertical scrolling still scrolls the dialog
  (`touch-action: pan-y`);
- at most 10 pulsing edges, at most 600 canvas DOM nodes, and neither the main
  chunk nor the chain-latency chunk contains React Flow.

> This round only updates the Playwright lookup and the assertion wording. The
> existing PNGs will be regenerated next round; when they disagree with the
> latest assertions, re-running the script is authoritative.
