# 服务器「费用与到期」管理表单 / Server cost & expiry form

新建与编辑服务器对话框里的一组可选公开字段。截图与断言跑在**真实主控**上
（临时库、`admin / devpass`），不是 mock；「元 → 分」、成对校验、清空与后端
错误码映射都按真实接口验证过。

An optional, publicly visible group in the create/edit server dialogs. The
screenshots and assertions run against a **real master** (temporary database,
`admin / devpass`), not mocks: yuan→cents conversion, the price/currency pair
rule, clearing and backend error codes are all verified through the real API.

```bash
# 1) 临时库启动主控 / start the master on a throwaway database
rm -rf /tmp/pw-billing && mkdir -p /tmp/pw-billing
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8796 \
PIERWAVE_DB='sqlite:///tmp/pw-billing/db.sqlite?mode=rwc' \
./target/debug/pierwave-master

# 2) 构建前端（主控直接从 web/dist 提供页面）
(cd web && npm run build)

# 3) 截图 + 验证 / screenshots + verification
BASE=http://127.0.0.1:8796 node web/screenshots/server-billing-form/shots.mjs
```

## 字段 / Fields

| 字段 / Field | 控件 / Control | 提交 / Payload |
|---|---|---|
| 到期日 / Paid until | 原生日期选择，`min=1970-01-01` `max=2100-12-31` | 空 = `null`；否则 `YYYY-MM-DD` |
| 价格 / Price | 文本输入，单位「元」 | 整数分（最多两位小数，0–999,999,999）；与币种成对 |
| 币种 / Currency | 下拉 `CNY / USD / EUR / 自定义`（自定义输入 3 位大写） | 空 = `null`；与价格成对 |
| 计费周期 / Billing cycle | 下拉 `月 / 年 / 一次性 / 未填写` | 空 = `null`；否则 `monthly / yearly / once` |

- 价格用字符串拆分换算（`49.99 → 4999`），不走浮点乘法；输入框里不放千分位。
- **价格与币种必须成对**：只填一半会在前端被拦下，错误落在缺的那一格；
  「清空」按钮一次清掉四格，提交时缺一半会整对发 `null`（要么都清、要么都不清）。
- 到期日只接受 `1970-01-01..=2100-12-31`：日期控件带 `min`/`max`，输入越界值
  会立刻在字段下方显示错误，提交也会被原生约束挡住。
- 空白等于未填写：四个字段都空时提交四个 `null`。
- 「清空」按钮在有内容时可点，只清空表单；点「保存修改」后才会写库。
- 任一字段非空时，组内出现一句「填写后会在公开状态页展示」；全空时隐藏。

The price is parsed from the decimal string, never via floating-point
multiplication. Price and currency must be provided together: a half pair is
blocked client-side with the error on the missing field, and the payload
clears both when either is empty. The date picker is limited to
`1970-01-01..=2100-12-31`; an out-of-range value shows an inline error and is
also blocked by the native constraint. A clear button empties the whole group,
and saving sends explicit `null`s (PATCH's "null = clear" semantics). The
public-visibility sentence appears only when at least one field has content.

## 错误 / Errors

前端先做同样的规则校验，错误直接落在字段下方（`FormField` 的行内 error +
`aria-invalid`），不弹 toast、不发请求；后端仍是权威，错误码会被映射回
对应字段并显示译文：

| 后端 code | 字段 |
|---|---|
| `server.paid_until_invalid` | 到期日（格式或年份范围） |
| `server.price_cents_invalid` | 价格 |
| `server.currency_invalid` | 币种 |
| `server.billing_cycle_invalid` | 计费周期 |
| `server.billing_pair_incomplete` | `params.missing` 指的那一格（`currency` / `price_cents`） |
| `request.invalid_json` | 通用错误（不落到字段；词典有中英文案，不展示 `detail`） |

The client mirrors the backend rules and renders errors under the matching
field (no toast, no request). The backend stays authoritative: its error codes
are mapped back to the same field with the translated message.
`request.invalid_json` is a general request-body error; the UI only translates
the code and never renders its raw `params.detail`.

## 真实后端验证 / Real-backend verification

`report.json` 记录（均为真实 HTTP 请求）：

| 验证 / Check | 结果 / Result |
|---|---|
| `POST /api/v1/servers` 填 `2026-12-31 / 268.00 元 / CNY / 月` | `paid_until=2026-12-31`、`price_cents=26800`、`currency=CNY`、`billing_cycle=monthly` |
| 编辑回填 / edit backfill | 日期 `2026-12-31`、价格 `268`、币种 `CNY`、周期 `月` |
| UI「清空」→ 保存 → `GET /servers` | 四列全部 `null`（不是缺省、不是空串） |
| 重新打开编辑 / reopen edit | 四格为空，公开提示消失 |
| 只填价格 / price only | UI 拦下、`0` 个 POST；直接调接口返回 400 `server.billing_pair_incomplete`，`params.missing=currency` |
| 只填币种 / currency only | UI 拦下、`0` 个 POST；接口 400，`params.missing=price_cents` |
| 日期 `1969-12-31` / `2101-01-01` | UI：`min/max` + 行内错误，表单不提交；接口 400 `server.paid_until_invalid`，`params.min/max` |
| 请求体类型错误 / wrong JSON type | 422，`code=request.invalid_json` |
| 390 横向溢出 / horizontal overflow | `scrollWidth = clientWidth = 390`（暗 / 亮、空 / 已填） |

`edit-inline-api-error-dark-1440.png` 里的币种错误是脚本拦截 PATCH 返回
`server.currency_invalid` 得到的：前端自己的校验已通过，验证的是「后端权威
错误 → 对应字段行内」这条路径。清空、创建、成对校验与年份范围则是完全真实的
接口调用。

## 截图 / Screenshots

| 文件 / File | 内容 / Contents |
|---|---|
| `create-empty-{dark,light}-{1440,390}.png` | 空表单：四格为空、无公开提示、清空按钮禁用 |
| `create-filled-{dark,light}-{1440,390}.png` | 已填：四格有值、公开提示出现 |
| `create-pair-price-only-dark-1440.png` | 只填价格：币种字段行内「请同时选择币种」 |
| `create-pair-currency-only-dark-1440.png` | 只填币种：价格字段行内「请同时填写价格」 |
| `create-date-range-dark-1440.png` | 日期越界（1969-12-31）：行内范围错误 |
| `create-inline-price-dark-1440.png` | 价格超上界（前端行内错误） |
| `create-filled-dark-1440-en.png` | 英文界面 |
| `edit-filled-dark-1440.png` | 编辑回填（真实接口返回的值） |
| `edit-cleared-dark-1440.png` | 点「清空」后：四格为空、提示消失 |
| `edit-empty-after-clear-dark-1440.png` | 保存清空后重新打开：仍为空 |
| `edit-inline-api-error-dark-1440.png` | 后端 `server.currency_invalid` 落到币种字段 |

## 测试 / Tests

`npm test`：712 pass（上一轮基线 706 + 新增 6 个用例），`npx tsc -b --noEmit`
与 `npm run build` 通过。

新增 / 更新断言（`src/lib/serverBilling.test.mjs`）：

- `isPaidUntilInRange`：`1970-01-01` / `2100-12-31` 通过；`1969-12-31`、
  `2101-01-01`、`0000-01-01`、`9999-12-31`、非法格式、空值拒绝。
- `validateBillingForm`：只填价格 → 币种字段 `currencyPair` 错误；只填币种 →
  价格字段 `pricePair` 错误；成对 / 都空通过；价格本身格式错误时不叠加成对错误；
  日期越界 → `paidUntil` 错误，边界日期合法。
- `billingPayload`：只填一半价格/币种 → 整对 `null`；成对保留（含 0 元）；
  日期越界 → `null`。
- `billingFieldForError`：`server.billing_pair_incomplete` 按 `params.missing`
  映射到 `currency` / `price_cents`，缺参数默认 `currency`；原有四个 code 不变。
- i18n：`currencyPair` / `pricePair` 与 `server.billing_pair_incomplete`、
  `request.invalid_json` 中英都存在；`request.invalid_json` 只显示通用文案、
  不渲染 `detail`。
- `billingFormFromServer`：年份越界的存量日期也按未填写回填。
- 源码契约：日期控件带 `min/max`；新建与编辑对话框都调用 `BillingFields`、
  `billingPayload`、`validateBillingForm` 和 `billingFieldForError`。
- 既有的元↔分、回填、清空、币种下拉与公开提示断言继续保留。
