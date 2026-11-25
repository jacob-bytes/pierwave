# 转发模板子页 KPI / Chain-template KPI cards

> 需求：在「链路时延 → 转发模板」子页顶部补 4 个与「转发链」子页同构的 KPI 卡。
> Requirement: add four KPI cards to the top of the **Chain templates** sub-page,
> matching the **Chains** sub-page.

## 交付 / Deliverables

| 文件 / File | 内容 / Contents |
|---|---|
| `templates-{1440,390}-{dark,light}.png` | 有模板：4 张 KPI + 列表 / Templates present |
| `empty-{1440,390}-{dark,light}.png` | 无模板：4 张 KPI 全是 `—` + 现有空态 / No templates |
| `unsupported-{1440,390}-{dark,light}.png` | 旧主控 404：KPI 与列表一起降级 / Old controller, 404 |
| `abnormal-zero-1440-dark.png` | 异常为 0：显示 `0` + 正常色 / Zero abnormal, normal tone |
| `abnormal-warning-1440-dark.png` | 只有降级：显示 `warning` 色 / Degraded only, warning tone |
| `error-1440-dark.png` | 接口 500：KPI 全 `—` + 可重试错误 / API failure |
| `loading-1440-dark.png` | 加载中：KPI 与列表同时铺骨架 / Loading skeletons |
| `report.json` | 每个断言的期望 / 实测值与几何数据 / Expectations and geometry |
| `shots.mjs` | 可复现的截图 + 断言脚本 / Reproducible screenshots + assertions |

所有截图与断言均来自**真实主控的列表接口**（`/api/v1/overview/chain-templates`），
只对空态 / 404 / 500 / loading 以及「异常为 0 / 只有降级」两个颜色边界在
浏览器层改写这条接口的响应；正常态没有注入 mock 数值。截图语言为简体中文。

All screenshots and assertions use the **real controller list response**; only
the empty / 404 / 500 / loading states plus the two tone boundary cases
(zero abnormal, degraded only) rewrite that one response in the browser.
Normal-state numbers are not mocked. Screenshots are zh-CN.

## 四个 KPI 的口径 / KPI definitions

| 卡 / Card | 值 / Value | 副行 / Secondary line | 来源 / Source |
|---|---|---|---|
| 模板总数 / Templates | `N 个` | `启用 X · 停用 Y` | `items.length`, `enabled` |
| 使用中的模板 / Templates in use | `X 个` | `共 N 条链` | `chains > 0` 的模板数；所有 `chains` 之和 |
| 使用用户 / Users | `N 人` | `管理员链不计入` | 各模板 `users` 之和（每个模板内已按 owner 去重；管理员链 owner 为空，后端不计入） |
| 异常模板 / Abnormal templates | `N 个` | `阻断 X · 降级 Y` | 启用模板中 `status.kind` 为 `blocked` / `degraded` 的数量 |

说明 / Notes:

- **停用的模板不算异常**：后端会把停用模板标成 `blocked/disabled`，但那是主动
  降噪，计入「异常模板」会让管理员以为出了故障。停用只在第一张卡的副行出现。
- **使用中的模板**按需求只看 `chains > 0`，停用但仍有链在用的模板也计入。
- **使用用户**是列表契约能拿到的口径：每个模板的 `users` 已是 owner 去重数，
  前端把它们相加。列表响应不含用户 id，因此当同一个用户使用多个模板时，
  跨模板无法再去重；管理员链已在每个模板的 `users` 中被后端排除。
- 异常为 0 时数字用正常前景色；有阻断用 `destructive`，只有降级用 `warning`。
- 无模板 / 旧主控 / 接口失败时四张卡显示 `—`，不显示 0；列表保留现有空态或
  错误态，与 KPI 同屏降级。

- **Disabled is not abnormal**: the backend marks disabled templates as
  `blocked/disabled`; counting them would report an intentional pause as a fault.
  Disabled count only appears in the first card's secondary line.
- **Templates in use** follows `chains > 0`; a disabled template that still has
  chains counts.
- **Users** is the best the list contract offers: each template's `users` is
  already owner-deduplicated, and the frontend sums them. The list payload has no
  user ids, so a user active on multiple templates cannot be deduplicated across
  templates; admin-owned chains are already excluded per template by the backend.
- Abnormal count is 0 → normal foreground; blocked → `destructive`; only
  degraded → `warning`.
- Empty / old controller / API failure → all four values are `—`, never 0; the
  list keeps its existing empty/error state, so KPI and list degrade together.

## 视觉 / Visual

- 与「转发链」子页共用 `ChainKpi.tsx`：2×2（`sm` 起 4 列）、1px 分隔线、
  单元格 `px-3 py-4 sm:px-5`、数字 **28px**、副行 **13px**。
- 390 下固定 2×2：`min-w-0` + `break-words`，副行最多两行；文档横向溢出 0。
- 卡片 1px border、无阴影、颜色全部走 `--card` / `--border` / `--warning` /
  `--destructive` 等 CSS 变量；异常数字不写死颜色。

- Both sub-pages share `ChainKpi.tsx`: 2×2 cells (4 columns from `sm`), 1px
  dividers, `px-3 py-4 sm:px-5`, **28px** values, **13px** secondary lines.
- 390 keeps a 2×2 grid: `min-w-0` + `break-words`, hints clamp to two lines, and
  the document has no horizontal overflow.
- 1px borders, no shadows, all colours from CSS variables; the abnormal tone is
  not hard-coded.

## 实测 / Measured

数据：`data/preview.db`（复制到临时库后启动主控）3 个模板（2 启用 / 1 停用）、
7 条链、5 个「模板去重用户」、1 个启用中的阻断模板。

Data: 3 templates (2 enabled / 1 disabled), 7 chains, 5 per-template deduped
users, 1 enabled blocked template in the preview DB.

| 项目 / Item | 实测 / Result |
|---|---|
| KPI 值 / values | `3 个` · `3 个` · `5 人` · `1 个` |
| 副行 / secondary lines | `启用 2 · 停用 1` · `共 7 条链` · `管理员链不计入` · `阻断 1 · 降级 0` |
| 1440 栅格 / grid | 4 列 × 287×113 px，同一行 / one row |
| 390 栅格 / grid | 2×2：171×113 px，第二行 y=404 / two rows |
| 横向溢出 / overflow | 1440: 0，390: 0 |
| 字号 / type | value 28px，hint 13px |
| 列表聚合 / list aggregate | 3 行、7 条链、2 启用、1 个启用中的 blocked，与 KPI 一致 |
| 异常 0 / zero abnormal | `0 个` + `text-foreground`（不变红/黄） |
| 只有降级 / degraded only | `1 个` + `text-warning`（不变红） |
| 断言 / checks | 40 / 40 通过 / passed |

## 复现 / Reproduce

```bash
# 1) 构建前端（主控直接读 web/dist）
cd web && npm run build && cd ..

# 2) 起主控；预览库 admin 密码不是 devpass 时改 ADMIN_PASSWORD
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
  PIERWAVE_DB='sqlite://data/preview.db?mode=rwc' \
  ./target/debug/pierwave-master

# 3) 生成截图与断言（Playwright 从仓库 .npm-cache/_npx 取，不新增依赖）
node web/screenshots/chain-template-kpis/shots.mjs
```

需要本机 Chrome（默认 `/Applications/Google Chrome.app`，可用 `CHROME_PATH`
覆盖）；主控地址可用 `BASE` 覆盖，admin 密码用 `ADMIN_PASSWORD` 覆盖。

Requires local Chrome (override with `CHROME_PATH`), `BASE` for the controller
URL, and `ADMIN_PASSWORD` for the preview DB's admin password.
