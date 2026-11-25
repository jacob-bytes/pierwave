# 服务器列表数值列对齐 / Server numeric column alignment

中文：这一轮把「负载 / 内存 / 当前速率」三列改成左对齐，并把负载与内存合并成
一列 `负载 / 内存`（`0.39 / 31%`，斜杠弱化、无进度条），当前速率改成上行在上、
下行在下的两行文本。390 卡片仍保持三个独立字段。

English: This round left-aligns the load / memory / rate columns, merges load and
memory into one `负载 / 内存` column (`0.39 / 31%`, muted slash, no progress bar),
and renders the rate as two stacked lines (up first, then down). The 390 card
keeps its three independent fields.

## 截图 / Screenshots

| 文件 / File | 内容 / Content |
|---|---|
| `servers-1440-{dark,light}-columns.png` | 1440 未滚动：三列左对齐、合并列、无进度条、两行速率 / Unscrolled 1440: left-aligned columns, merged cell, no bars, two-line rate |
| `servers-1440-{dark,light}-scrolled.png` | 1440 主内容区纵向滚到底（15 行）：列头与数值仍对齐 / 1440 with the main pane scrolled to the last row; values stay aligned |
| `servers-1360-{dark,light}-scrolled.png` | 1360 横向滚到最右：表格溢出时名称列固定、速率列仍完整可见 / 1360 scrolled fully right: sticky name column, rate column still fully visible |
| `servers-1024-{dark,light}.png` | 1024：`xl` 以下合并列 / 速率列按断点隐藏，地址与操作不被挤压 / 1024: the merged and rate columns hide below `xl`; address and actions stay usable |
| `servers-390-{dark,light}-cards.png` | 390 卡片：负载、内存、当前速率仍是三个独立字段，内存进度条保持原样 / 390 cards: still three independent fields, memory bar unchanged |

> 注：合并列让 1440（内容区 1152px）的表格刚好放下（`scrollWidth = clientWidth = 1152`），
> 横向滚动在 1440 已经不存在；因此横向滚动截图取自 1360（仍在 `xl` 断点以上、
> 表格溢出 28px）。1440 的 `-scrolled.png` 改为纵向滚到底的截图。
>
> Note: merging the columns makes the table fit exactly at 1440
> (`scrollWidth = clientWidth = 1152`), so there is no horizontal overflow to
> scroll at that width. The horizontal-scroll shot therefore uses 1360 (still
> above the `xl` breakpoint, table overflows by 28px); the 1440 `-scrolled.png`
> is a vertical scroll to the bottom of the list.

## 实测 / Measured

| 项目 / Item | 结果 / Result |
|---|---|
| 合并列文案 / Merged cell | 首行 `0.39 / 31%`（API：load 0.39、2.5 GiB / 8 GiB）/ first row `0.39 / 31%` |
| 对齐 / Alignment | 表头与单元格 `text-align: left`；数值左沿 = 单元格内容左沿 / header and cell `left`; value x = cell content left |
| 进度条 / Progress bars | 表格内 `role="progressbar"` 数量 0 / zero inside the table |
| 速率 / Rate | `↑ 614 KB/s`（上行）在上、`↓ 1.9 MB/s`（下行）在下 / up line first, down line second |
| 行高 / Row height | 15 行全部 64px；速率两行总高约 30px / all 15 rows 64px; rate block ≈30px |
| `tabular-nums` | 合并列与速率列均为 `tabular-nums` / both columns |
| `/` 与箭头 / Slash & arrows | 颜色相同（muted），与负载数值不同 / same muted colour, different from the load value |
| 1440 表格 / Table at 1440 | 内容区 1152px，表格 1152px，无横向滚动 / 1152px content, 1152px table, no horizontal scroll |
| 1440 地址 / Address at 1440 | 190px（≥ `min-w-40`）/ 190px |
| 1360 横向滚动 / Horizontal scroll | 溢出 28px；滚动后名称列 `sticky left: 40px`，速率列完整可见 / 28px overflow; name sticky at 40px, rate fully visible |
| 1024 地址 / Address at 1024 | 163px，页面无横向溢出 / 163px, no page overflow |
| 390 卡片 / 390 card | 字段 `负载（1 分钟）`、`内存`、`当前速率` 仍在；最大高度 234px（未变）/ fields kept; max height 234px (unchanged) |

`report.json` 是机读结果（对齐、字体、颜色、尺寸与断言列表）。
`report.json` holds the machine-readable measurements and assertion list.

## 重新生成 / Regenerate

```bash
# 1) 预览库副本（不改 data/preview.db）/ Copy of the preview DB
sqlite3 data/preview.db ".backup '/tmp/mmrust-server-columns.db'"

# 2) 预览库的 admin 密码需要是 devpass（ensure_admin 只在空库时生效）。
#    可在临时空库上用 PIERWAVE_ADMIN_PASSWORD=devpass 生成一个 argon2id 哈希，
#    把 users.password_hash 写进副本后再启动：
#    The preview DB's admin password must be devpass (ensure_admin only runs on
#    an empty DB). Create a throwaway DB with PIERWAVE_ADMIN_PASSWORD=devpass,
#    copy users.password_hash into the copy, then start the master:
PIERWAVE_DB='sqlite:///tmp/mmrust-admin-seed.db?mode=rwc' PIERWAVE_ADMIN_PASSWORD=devpass \
  PIERWAVE_ADDR=127.0.0.1:8798 ./target/debug/pierwave-master   # 起一次后即可停止 / kill after the admin exists
python3 - <<'PY'
import sqlite3
seed = sqlite3.connect('/tmp/mmrust-admin-seed.db')
target = sqlite3.connect('/tmp/mmrust-server-columns.db')
target.execute("update users set password_hash=? where username='admin'",
               (seed.execute("select password_hash from users where username='admin'").fetchone()[0],))
target.commit()
PY

# 3) 先构建，再起主控（服务 web/dist）
#    Build first, then serve web/dist:
cd web && npm run build && cd ..
PIERWAVE_DB='sqlite:///tmp/mmrust-server-columns.db' PIERWAVE_ADMIN_PASSWORD=devpass \
  PIERWAVE_ADDR=127.0.0.1:8797 ./target/debug/pierwave-master

# 4) 截图 + 断言 / Screenshots + assertions
BASE=http://127.0.0.1:8797 node web/screenshots/server-columns/shots.mjs
```

Playwright 取自仓库 `.npm-cache/_npx/.../playwright`，不新增依赖；需要本机
Chrome（可用 `CHROME_PATH` 覆盖）。脚本只读预览库数据，不写业务表。

Playwright is loaded from the repo's `.npm-cache/_npx/...`, so no new dependency
is added; local Chrome is required (`CHROME_PATH` overrides). The script only
reads preview data and never writes business tables.
