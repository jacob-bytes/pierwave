# 计费周期「数量 + 单位」 / Billing cycle: count + unit

服务器费用表单与公开页的计费周期从「月 / 年 / 一次性」三选一改为
**数量 1–1200 + 单位（个月 / 年 / 一次性）**。表单同时提交新契约的两列与
旧派生字段 `billing_cycle`；公开页优先读数量 + 单位，缺字段时回退旧值。

The server cost form and the public status pages now express the billing cycle as
**a count (1–1200) plus a unit (month / year / once)** instead of a single
choice. The form submits both new columns and the legacy derived `billing_cycle`;
the public pages prefer count + unit and fall back to the legacy value when the
new fields are missing.

```bash
# 1) 临时库启动主控 / start the master on a throwaway database
rm -rf /tmp/pw-billing-cycle && mkdir -p /tmp/pw-billing-cycle
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8797 \
PIERWAVE_DB='sqlite:///tmp/pw-billing-cycle/db.sqlite?mode=rwc' \
./target/debug/pierwave-master

# 2) 构建前端（主控直接从 web/dist 提供页面）/ build the SPA
(cd web && npm run build)

# 3) 截图 + 契约验证 / screenshots + contract checks
BASE=http://127.0.0.1:8797 node web/screenshots/billing-cycle/shots.mjs
```

> **数据来源 / Data source.** 截图与断言全部跑在**真实主控**上：脚本按名字创建 /
> 更新四台演示服务器，直接写入 `billing_cycle_count` / `billing_cycle_unit`，
> 公开接口原样返回。旧数据回退（两个新字段都缺失时读 `billing_cycle`）由
> `publicStatus.test.mjs` 与 `serverBilling.test.mjs` 覆盖。
>
> **All screenshots and assertions run against the real master.** The script
> creates/updates four demo servers by name and stores `billing_cycle_count` /
> `billing_cycle_unit` directly; the public API returns them as-is. The legacy
> fallback (reading `billing_cycle` when both new fields are missing) is covered
> by `publicStatus.test.mjs` and `serverBilling.test.mjs`.

## 表单 / Form

**布局 / Layout:** 两行两列 —— 第一行「价格（元）| 币种」，第二行「计费周期 | 到期日」；
390 单列时按 价格 → 币种 → 计费周期 → 到期日 堆叠。

Two-row, two-column layout: **price | currency** on the first row and
**billing cycle | paid until** on the second. At 390px the fields stack in that
same order.

| 控件 / Control | 规则 / Rule | 提交 / Payload |
|---|---|---|
| 数量 / Count | 纯数字输入，整数 `1–1200`；空串 = 未填写 | `billing_cycle_count`，空 = `null` |
| 单位 / Unit | 下拉：未填写 / 个月 / 年 / 一次性 | `billing_cycle_unit`：`month` / `year` / `once`，空 = `null` |
| 一次性 / One-time | 数量固定 `1` 并禁用（不隐藏，宽度不变） | `count = 1`、`unit = "once"` |
| 旧派生 / Derived | 1 个月 → `monthly`、1 年 → `yearly`、一次性 → `once`；**3 个月 / 2 年 → `null`** | `billing_cycle` |

- 新建对话框**默认全空**（未填写）：管理员没填过的周期不会被写进服务器；
  选择单位时数量才补默认 `1`（选「一次性」固定 1）。「清空」回到两者全空。
- 编辑对话框以服务器真实值为准：新字段优先，缺失时回退旧 `billing_cycle`
  （按 1 个对应单位展示）；两者都没有时**保持空**，不会因为编辑别的字段而
  悄悄写入周期。
- 两者都空 = 未填写，合法；只填一半 → 错误落在缺的那一格（数量或单位）。
- 数量不是整数 / 越界（0、1201、1.5、字母）→ 数量字段行内错误。
- 后端错误码映射：`server.billing_cycle_count_invalid` → 数量、
  `server.billing_cycle_unit_invalid` → 单位、
  `server.billing_cycle_once_count_invalid` → 数量、
  `server.billing_cycle_pair_incomplete` 按 `params.missing` 落格、
  旧 `server.billing_cycle_invalid` → 单位。

- The create dialog starts **empty** (unfilled), so an untouched cycle is never
  written to the server. Selecting a unit fills count `1` (one-time freezes at
  `1`); **Clear** empties both.
- The edit dialog reflects the stored value (new fields first, legacy fallback as
  one unit) and stays empty when neither exists, so editing another setting can
  never silently write a cycle.
- Both empty = unfilled (valid); one half only = inline error on the missing
  half; non-integer / out-of-range counts show an inline error on the count.

## 展示 / Display

| 周期 / Cycle | 卡片与详情价格行 / Card & detail price | 独立文案 / Standalone label |
|---|---|---|
| 1 个月 | `¥268.00 / 月`（count=1 省略数字） | `1 个月` |
| 3 个月 | `¥268.00 / 3 个月` | `3 个月` |
| 2 年 | `¥999.00 / 2 年` | `2 年` |
| 一次性 | `¥199.00 / 一次性` | `一次性` |

- 价格缺失时用独立文案：`未配置 / 1 个月`，不会显示成 `未配置 / 月`。
- 旧数据只有 `billing_cycle` 时按 `monthly → 1 个月`、`yearly → 1 年`、
  `once → 一次性` 回退；价格行仍是 `¥268.00 / 月`（与上一版逐字一致）。
- `billing_hidden = true` 时卡片与详情仍显示「未公开」，不受新字段影响。
- 详情页的周期进度按数量折算：3 个月 = 90 天、2 年 = 730 天；一次性不画进度。

- Missing price uses the standalone label (`未配置 / 1 个月`) instead of
  `未配置 / 月`.
- Legacy-only rows fall back to one unit and keep the exact old price line.
- `billing_hidden = true` still renders “Not public”.
- The remaining-days bar scales with the count (90 days for 3 months, 730 for
  2 years) and is hidden for one-time.

## 截图 / Screenshots

| 文件 / File | 内容 / Contents |
|---|---|
| `form-empty-{dark,light}-{1440,390}.png` | 新建默认空：数量空、单位「未填写」、无公开提示 |
| `form-month-{dark,light}-{1440,390}.png` | 选择「个月」后数量默认 1 |
| `form-dialog-{dark,light}-{1440,390}.png` | 完整新建对话框（含名称 / 地址等上下文） |
| `form-3-months-dark-1440.png` | 3 个月 |
| `form-2-years-dark-1440.png` | 2 年 |
| `form-once-dark-1440.png` | 一次性：数量固定 1、输入框禁用 |
| `form-error-unit-half-dark-1440.png` | 缺单位：行内「已填写计费数量，请选择单位」 |
| `form-error-count-half-dark-1440.png` | 缺数量：行内「已选择计费单位，请填写数量」 |
| `form-error-range-dark-1440.png` | 数量 1201：行内范围错误 |
| `cards-{dark,light}-{1440,390}.png` | 公开页卡片四种展示同屏 |
| `cards-cycle-only-dark-1440.png` | 只有周期、没有价格：`未配置 / 1 个月`（数量不省略） |
| `detail-{month,3-months,2-years,once}-{dark,light}-{1440,390}.png` | 详情页四种展示 × 1440 / 390 × 亮 / 暗 |
| `report.json` | 41 条断言的运行结果 |

## 真实接口验证 / Real-backend checks

`report.json` 里的 41 条检查全部通过（每次运行重新生成）：

- 新建默认空：数量空、单位「未填写」、无公开提示；直接提交时三个周期字段
  都是 `null`（不写入管理员没填过的周期）；
- 选择「个月」后数量补默认 `1`；
- 3 个月 / 2 年 / 一次性的控件状态；一次性数量禁用且固定 `1`；
- 清空后数量空、单位「未填写」；
- 缺数量 / 缺单位 / 1201 三种行内错误，且都**不发请求**；
- 提交载荷：`price_cents=26800`、`currency=CNY`、
  `billing_cycle_count=3`、`billing_cycle_unit=month`、`billing_cycle=null`
  （3 个月不能谎报成 monthly）；
- 卡片同屏出现 `¥268.00 / 月`、`¥268.00 / 3 个月`、`¥999.00 / 2 年`、
  `¥199.00 / 一次性`，且不出现 `¥268.00 / 1 个月`；
- 只有周期、没有价格的卡片显示完整文案 `未配置 / 1 个月`（此时不省略数量）；
- 详情页四种展示 × 1440 / 390 × 亮 / 暗全部截图，均不横向溢出；
- 运行前先校验公开接口：四台服务器的 count / unit 原样返回，3 个月与 2 年的
  旧派生 `billing_cycle` 为 `null`；
- 真实后端往返：用与 `billingPayload` 相同的载荷 `POST` 3 个月 → 响应
  `count=3 / unit=month / legacy=null`；`PATCH` 2 年 → 同样；清空两列 → 全
  `null`；`2 + once` → 400 `server.billing_cycle_once_count_invalid`。

## 测试 / Tests

`npm test`：**875 pass**（上一轮基线 864 + 新增 11 个用例），
`npx tsc -b --noEmit` 与 `npm run build` 通过。

新增 / 更新断言：

- `parseCycleCount`：空串、1、3、1200、前导零通过；0 / 1201 / -1 / 1.5 /
  1e3 / 全角数字拒绝；`isBillingCycleCount` 同边界。
- `EMPTY_BILLING_FORM`：新建默认全空，`billingPayload` 三列都是 `null`；
  `cycleCountForUnit`：月 / 年空数量补 1、已有值保留；一次性固定 1。
- `sanitizeCycleCountInput`：只留数字、最多 4 位。
- `validateBillingForm`：1 个月 / 3 个月 / 2 年 / 一次性通过；只填数量 →
  单位 `cycleUnitPair`；只填月 / 年单位 → 数量 `cycleCountPair`；一次性不
  要求数量；数量格式 / 范围错误只报数量。
- `billingFormFromServer`：新字段 3 个月 / 2 年 / 一次性回填；缺一半或脏值
  回退旧 `billing_cycle`；无数据保持全空。
- `billingCyclePayload` / `billingPayload`：数量 + 单位 + 旧派生镜像；
  3 个月 / 2 年的旧派生为 `null`；一次性固定 1；两者留空两列都 `null`；
  缺一半绝不提交半对。
- `billingFieldForError`：五个新 / 旧错误码与 `params.missing` 的落格。
- `publicStatus.billingCycleText`：新契约四种展示、单复数文案 key、
  一次性忽略数量、旧 `billing_cycle` 回退、非法值回退。
- i18n：`servers.billing.*` 与 `publicStatus.server.cycle.*` 中英齐全；
  四个新后端错误码在中英 `errors` 词典里都有译文。
- 源码契约：`BillingFields` 的数量 + 单位同一行、一次性禁用数量、
  新建初值 `EMPTY_BILLING_FORM`；卡片与详情都调用 `billingCycleText`。
