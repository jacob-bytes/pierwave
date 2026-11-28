# 公开状态页：顶部同步信息 + 列表「环境」列 / Status header meta & environment column

## 中文

本目录是这两项改动的截图与断言资产：

1. **详情页**：底部「最后上报 · 数据每 20 秒刷新」已删除，整组移到页面顶部，
   与「← 返回列表」同一行、右对齐。390 放不下时整组换到下一行，仍靠右，
   返回按钮不压缩（英文文案在 390 就会走换行分支）。
2. **列表视图**：节点列右侧新增「环境」列——第一行发行版
   （`Debian GNU/Linux 12`），第二行 `虚拟化 · 架构`（`kvm · x86_64`，
   12px muted）。缺字段显示 `—`，`virt = none`（裸机）不占位。
   负载 / 内存 / 硬盘列收窄，整行可点击，键盘 Enter 也能进详情；
   hover / 聚焦有背景反馈。

数据来源：`GET /api/v1/public/status` 本来就返回 `os_name` / `os_version` /
`virt` / `arch`（`crates/master/src/routes/public_status.rs` 的 `PublicServer`，
前端类型见 `web/src/lib/api.ts` 的 `PublicStatusServer`），**没有**为这一列去
逐台调详情接口；截图脚本断言列表页初始只发一次公开接口请求。

行内可点元素：脚本在运行时往「环境」单元格注入一个「复制」按钮，点击后
页面仍停在 `/status`、按钮自己的点击处理器照常执行；随后点击同一行普通
单元格才跳到 `/status/srv-hk`。这证明整行守卫只放行真正的行点击。

### 文件

| 文件 | 内容 |
|---|---|
| `detail-dark-1440.png` / `detail-light-1440.png` | 详情页 1440 亮暗，顶部右侧同步信息 |
| `detail-dark-390.png` / `detail-light-390.png` | 详情页 390 中文（同排放下） |
| `detail-dark-390-en.png` | 详情页 390 英文：换行到下一行且右对齐 |
| `list-dark-1440.png` / `list-light-1440.png` | 列表 1440 亮暗，含「环境」列 |
| `list-hover-dark-1440.png` | 行 hover 背景反馈 |
| `list-clicked-detail-dark-1440.png` | 点击行后跳转到的详情页 |
| `cards-dark-390.png` / `cards-light-390.png` | 390 卡片视图，副行保留环境信息 |
| `report.json` | 几何 / 文本 / 请求数断言结果 |

### 复跑

```bash
cd web
npm run build
npx vite preview --port 4173 --strictPort   # 另一个终端
node web/screenshots/status-header-env/shots.mjs
```

脚本用 Playwright 拦截 `/api/v1/public/status`，不需要启动主控、不写数据库。
若本机没有 playwright，设置 `PLAYWRIGHT_MODULE` 指向它的 `index.mjs`。

## English

Screenshots and assertions for two changes:

1. **Detail page**: the bottom "Last reported · Refreshes every 20 seconds" row
   is gone; the same group now sits in the top row, right-aligned with
   "← Back to list". At 390 it wraps to a second row when it does not fit —
   still right-aligned, and the back button is never squeezed (the English copy
   takes the wrap path at 390).
2. **List view**: a new "Environment" column sits right of the node column —
   distro on line 1 (`Debian GNU/Linux 12`), `virtualisation · arch` on line 2
   (`kvm · x86_64`, 12px muted). Missing fields render `—`; `virt = none`
   (bare metal) is skipped. Load / memory / disk columns are narrower, and the
   whole row is clickable — Enter on a focused row opens the detail page, hover
   and focus add a background.

Data source: `GET /api/v1/public/status` already returns `os_name` /
`os_version` / `virt` / `arch` (`PublicServer` in
`crates/master/src/routes/public_status.rs`; the front-end type is
`PublicStatusServer` in `web/src/lib/api.ts`). No per-row detail request was
added; the screenshot script asserts the list page sends exactly one public
request on its initial load.

Interactive descendants: the script injects a runtime "copy" button into the
Environment cell. Clicking it keeps the page at `/status` while the button's own
click handler still runs; clicking a plain cell on the same row then navigates
to `/status/srv-hk`. The row guard only lets real row clicks through.

### Files

| File | Contents |
|---|---|
| `detail-dark-1440.png` / `detail-light-1440.png` | Detail at 1440, dark/light, top-right sync meta |
| `detail-dark-390.png` / `detail-light-390.png` | Detail at 390, Chinese (fits on one row) |
| `detail-dark-390-en.png` | Detail at 390, English: wrapped and right-aligned |
| `list-dark-1440.png` / `list-light-1440.png` | List at 1440, dark/light, with Environment column |
| `list-hover-dark-1440.png` | Row hover background |
| `list-clicked-detail-dark-1440.png` | Detail page reached by clicking a row |
| `cards-dark-390.png` / `cards-light-390.png` | 390 card view, environment kept on the sub-line |
| `report.json` | Geometry / text / request-count assertions |

### Re-run

```bash
cd web
npm run build
npx vite preview --port 4173 --strictPort   # second terminal
node web/screenshots/status-header-env/shots.mjs
```

The script intercepts `/api/v1/public/status` with Playwright; no controller or
database is needed. If playwright is not installed locally, point
`PLAYWRIGHT_MODULE` at its `index.mjs`.
