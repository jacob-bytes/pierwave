# 成本 KPI 第四格「月均开销」 / Cost KPI: monthly average

成本开支 tab 的 KPI 从 3 格补到 4 格：总开销 / 本年度总开销 / 未来 12 个月 /
**月均开销**。月均 = 范围内每台 `周期价格 / 周期月数` 之和（月付取月价、
年付取价/12、N 个月取价/N）；一次性没有月数，不计入；未知币种与总额口径
一致，同样不计入。

The cost tab now has four KPI cells instead of three: total / this year /
next 12 months / **monthly average**. Monthly average is the sum of each
server's `cycle price / cycle months` (monthly as-is, yearly ÷ 12, N months ÷ N).
One-time fees have no month count and are excluded; currencies without FX rates
are excluded exactly like the total.

```bash
cd web && npm run build
node screenshots/cost-monthly/shots.mjs
```

脚本自带静态服务器与 API mock，不需要主控或数据库。Mock 数据：月付 ¥100、
年付 ¥1,000、3 个月 ¥300、一次性 ¥500、未知币种 AED ¥320，因此
**月均 = 100 + 1000/12 + 300/3 = ¥283.33**、总额 = ¥1,900.00（不含 AED）、
未来 12 个月 = ¥3,900.00。

The script serves `dist` and mocks every API, so no controller or database is
needed. Mock data: monthly ¥100, yearly ¥1,000, 3-month ¥300, one-time ¥500,
and an AED server (no FX rate). So **monthly = 100 + 1000/12 + 300/3 =
¥283.33**, total = ¥1,900.00 (AED excluded), next 12 months = ¥3,900.00.

## 口径 / Definitions

| 卡 / Cell | 口径 / Definition |
|---|---|
| 总开销 / Total cost | 每台一个周期的价格之和；一次性也计入；未知币种不计入 |
| 本年度总开销 / This year | 周期价 / 月数 × 本年度剩余月数；一次性不计入 |
| 未来 12 个月 / Next 12 months | 按 `paid_until` 排期累加；已预付不重复；一次性按到期日一次计入 |
| 月均开销 / Monthly average | 每台周期价 / 周期月数之和；一次性无月数不计入 |

**月均 × 12 与「未来 12 个月」不相等是正常的。** 月均是稳态口径，把年付 /
季付均摊到每月；未来 12 个月按到期日排期，年付在窗口里可能只排 1 次，
月付在已预付时也可能少于 12 次，一次性只在到期月计一次。两者量级接近，
但含义不同——这个差异写在副行「按到期日排期累加 · 月付计 12 次」里。

**Monthly × 12 does not equal next 12 months, by design.** Monthly average is a
steady-state figure (yearly and quarterly fees spread per month); next 12 months
follows `paid_until`, so a yearly server may be counted once, a prepaid monthly
server fewer than 12 times, and a one-time fee once in its due month. The
magnitudes stay close, but the meanings differ — the hint
“Due-date schedule · monthly ×12” calls this out.

## 栅格 / Grid

与其它 tab 共用 `ChainKpi`：

- 1440：4 列，一行；
- 390：2×2（2 列 × 2 行）；
- 四格都不跨列（资源状态的三格仍由首格 `col-span-2` 补满）。

Shared `ChainKpi` grid:

- 1440: four columns, one row;
- 390: 2×2;
- no cell spans columns (the three-cell resource KPI still uses `col-span-2`
  on its first cell).

## 截图 / Screenshots

| 文件 / File | 内容 / Contents |
|---|---|
| `kpi-{light,dark}-{1440,390}.png` | 四格 KPI 本体的亮 / 暗、桌面 / 窄屏 |
| `page-{light,dark}-{1440,390}.png` | 成本 tab 首屏（KPI + 图表 + 卡片） |
| `kpi-en-dark-1440.png` | 英文四格，验证中英成对 |
| `report.json` | 运行时断言：四格、4 列 / 2×2、金额、副行文案、无横向溢出 |

## 断言 / Assertions

- 四格标签：总开销 / 本年度总开销 / 未来 12 个月 / 月均开销；
- 1440 计算列数 = 4、行起点 = 1；390 计算列数 = 2、行起点 = 2；
- 月均 = `CNY 283.33`（¥500 一次性不进月均）；
- 总额 = `CNY 1,900.00`（AED 不计入，一次性计入）；
- 未来 12 个月 = `CNY 3,900.00`，副行中文
  「按到期日排期累加 · 月付计 12 次」、英文
  「Due-date schedule · monthly ×12」；
- 月均 × 12（¥3,399.96）≠ 未来 12 个月（¥3,900.00），量级在同一档；
- 四个视口都没有横向溢出，页面无 console / page error。

- Four labels as above; computed columns 4 at 1440 and 2 at 390 (two rows);
- monthly = `CNY 283.33`; total = `CNY 1,900.00`; next 12 months =
  `CNY 3,900.00`;
- the next-12 hint reads “按到期日排期累加 · 月付计 12 次” / “Due-date
  schedule · monthly ×12”;
- monthly × 12 ≠ next 12 months, but the same order of magnitude;
- no horizontal overflow and no console / page errors in any viewport.

## 单测 / Unit tests

`npm test` 新增 3 条：

- 月付 / 年付 / 3 个月 / 一次性 / 未知币种混合：月均只取前三者；
- 月均 × 12 与未来 12 个月口径不同、量级接近；
- 0 台与只有未知币种时月均为 0（不是 `null`）。

另外更新 `overviewKpiAlignment.test.mjs` 与 `overviewKpiCompact.test.mjs`：
成本 KPI 恰好四格、四格不跨列、骨架 `cells={4}`，390 2×2 / 桌面 4 列由
共享栅格保证。

`npm test` adds three cases (mixed cycles; monthly × 12 vs next 12 months;
zero / unknown-only servers). The source-level KPI tests now expect exactly
four cost cells, no `col-span-2`, and a four-cell skeleton.
