# 服务器列表密度与筛选 / Server list density and filtering

中文：服务器页这一轮改动的验收截图与 DOM 断言。覆盖名称列固定、滑动提示、
行高、异常筛选、移动卡片折叠、详情弹层 label/value 去重，亮暗两套主题。

English: Acceptance screenshots and DOM assertions for the servers page changes:
sticky name column, horizontal-scroll hint, row height, service-error filter,
collapsible mobile card and label/value de-duplication in the detail popover,
in both light and dark themes.

## 截图 / Screenshots

| 文件 / File | 内容 / Content |
|---|---|
| `servers-1440-{dark,light}-toolbar.png` | 卡头新布局：在线计数在标题徽章里，异常筛选在筛选组内 / New card header: online count beside the title, error filter grouped with filters |
| `servers-1440-{dark,light}-scrolled.png` | 横向滚到最右，名称列仍固定在复选框右侧 / Scrolled fully right; the name column stays pinned after the checkbox column |
| `servers-1440-{dark,light}-filter.png` | 异常筛选选中态（实心 destructive）+ URL `?only=abnormal` / Active error filter with `?only=abnormal` |
| `servers-1024-{dark,light}-detail.png` | 详情弹层：网络延迟 `52 ms`、允许的端口 `10000-60000`、最后在线 `刚刚` / Detail popover without repeated labels; future `last_seen` shows “just now” |
| `servers-390-{dark,light}-cards.png` | 390 卡片默认态：只留实时指标，配置进「更多」 / Collapsed 390 card with live metrics only |
| `servers-390-{dark,light}-card-more.png` | 展开「更多」：允许端口、内网地址、网卡、模式、Xray、心跳、版本 / Expanded “More” section |

`report.json` 是本次实测的机读结果（行高、sticky `left`、提示条命中、筛选行数、
卡片高度）。/ `report.json` holds the measured values.

## 实测 / Measured

| 项目 / Item | 结果 / Result |
|---|---|
| 行高 / Row height | 15 行全部 64px（`h-16`） / all 64px |
| 名称列 / Name column | `position: sticky`、`left: 40px`，滚动到最右仍在 / sticky at 40px after scrolling right |
| 滑动提示 / Scroll hint | 表格右上角提示条，滚动前后 y 不变，`elementFromPoint` 命中自身 / top-right strip, hit-tested |
| 异常筛选 / Error filter | `?only=abnormal` → 2 行；再点一次恢复 15 行 / 2 rows, then back to 15 |
| 卡片高度 / Card height | 默认最大 234px（390 宽） / max 234px at 390 |
| 详情弹层 / Detail popover | `网络延迟 → 52 ms`、`允许的端口 → 10000-60000`、`最后在线 → 刚刚` |
| 未来 `last_seen` | 显示「刚刚」，不回退 19 位绝对时间 / “just now”, never an absolute timestamp |

## 重新生成 / Regenerate

```bash
# 1) 预览库副本：admin 密码重置为 devpass（不改 data/preview.db）
#    Copy of the preview DB with the admin password reset to devpass
sqlite3 data/preview.db ".backup 'data/server-list-density.db'"
# 用本地 argon2id 重算 admin 的 password_hash 后继续
# recompute users.password_hash for admin with local argon2id if needed

# 2) 主控（服务 web/dist；先 npm run build）
PIERWAVE_DB='sqlite://data/server-list-density.db' PIERWAVE_ADMIN_PASSWORD=devpass \
  PIERWAVE_ADDR=127.0.0.1:8787 ./target/debug/pierwave-master

# 3) 截图 + 断言
node web/screenshots/server-list-density/shots.mjs
```

Playwright 取自仓库 `.npm-cache/_npx/.../playwright`，不新增依赖；需要本机
Chrome（可用 `CHROME_PATH` 覆盖）。脚本只读预览库数据，不写任何业务表。
Playwright is loaded from the repo's `.npm-cache/_npx/...`, so no new dependency
is added; local Chrome is required (`CHROME_PATH` overrides). The script only
reads preview data and never writes business tables.
