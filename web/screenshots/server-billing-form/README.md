# 服务器「费用与到期」管理表单 / Server cost & expiry form

新建与编辑服务器对话框里新增的一组可选公开字段。截图与断言跑在**真实主控**上
（临时库、`admin / devpass`），不是 mock；四个字段的「元 → 分」、清空与后端
错误码映射都按真实接口验证过。

A new optional, publicly visible group in the create/edit server dialogs. The
screenshots and assertions run against a **real master** (temporary database,
`admin / devpass`), not mocks: yuan→cents conversion, clearing and backend error
codes are all verified through the real API.

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
| 到期日 / Paid until | 原生日期选择（`YYYY-MM-DD`） | 空 = `null`；否则原样 |
| 价格 / Price | 文本输入，单位「元」 | 解析为整数分（最多两位小数，0–999,999,999） |
| 币种 / Currency | 下拉 `CNY / USD / EUR / 自定义`（自定义输入 3 位大写） | 空 = `null`；否则 3 位大写 |
| 计费周期 / Billing cycle | 下拉 `月 / 年 / 一次性 / 未填写` | 空 = `null`；否则 `monthly / yearly / once` |

- 价格用字符串拆分换算（`49.99 → 4999`），不走浮点乘法；输入框里不放千分位。
- 空白等于未填写：四个字段都空时提交四个 `null`。
- 「清空」按钮在有内容时可点，只清空表单；点「保存修改」后才会写库。
- 任一字段非空时，组内出现一句「填写后会在公开状态页展示」；全空时隐藏。

The price is parsed from the decimal string, never via floating-point
multiplication. A clear button empties the whole group, and saving sends
explicit `null`s (PATCH's "null = clear" semantics). The public-visibility
sentence appears only when at least one field has content.

## 错误 / Errors

前端先做同样的规则校验，错误直接落在字段下方（`FormField` 的行内 error +
`aria-invalid`），不弹 toast、不发请求；后端仍是权威，四个错误码会被映射回
对应字段并显示译文：

| 后端 code | 字段 |
|---|---|
| `server.paid_until_invalid` | 到期日 |
| `server.price_cents_invalid` | 价格 |
| `server.currency_invalid` | 币种 |
| `server.billing_cycle_invalid` | 计费周期 |

The client mirrors the backend rules and renders errors under the matching
field (no toast, no request). The backend stays authoritative: its four error
codes are mapped back to the same field with the translated message.

## 真实后端验证 / Real-backend verification

`report.json` 记录（均为真实 HTTP 请求）：

| 验证 / Check | 结果 / Result |
|---|---|
| `POST /api/v1/servers` 填 `2026-12-31 / 268.00 元 / CNY / 月` | `paid_until=2026-12-31`、`price_cents=26800`、`currency=CNY`、`billing_cycle=monthly` |
| 编辑回填 / edit backfill | 日期 `2026-12-31`、价格 `268`、币种 `CNY`、周期 `月` |
| UI「清空」→ 保存 → `GET /servers` | 四列全部 `null`（不是缺省、不是空串） |
| 重新打开编辑 / reopen edit | 四格为空，公开提示消失 |
| 四个错误码 / four codes | 均 400，`code` 与 `params.field` 正确；UI 把 `currency` 错误显示在币种下方 |
| 390 横向溢出 / horizontal overflow | `scrollWidth = clientWidth = 390`（暗 / 亮、空 / 已填） |

`edit-inline-api-error-dark-1440.png` 里的币种错误是脚本拦截 PATCH 返回
`server.currency_invalid` 得到的：前端自己的校验已通过，验证的是「后端权威
错误 → 对应字段行内」这条路径。清空与创建则是完全真实的接口调用。

## 截图 / Screenshots

| 文件 / File | 内容 / Contents |
|---|---|
| `create-empty-{dark,light}-{1440,390}.png` | 空表单：四格为空、无公开提示、清空按钮禁用 |
| `create-filled-{dark,light}-{1440,390}.png` | 已填：四格有值、公开提示出现 |
| `create-inline-price-dark-1440.png` | 前端行内错误（价格超上界） |
| `edit-filled-dark-1440.png` | 编辑回填（真实接口返回的值） |
| `edit-cleared-dark-1440.png` | 点「清空」后：四格为空、提示消失 |
| `edit-empty-after-clear-dark-1440.png` | 保存清空后重新打开：仍为空 |
| `edit-inline-api-error-dark-1440.png` | 后端 `server.currency_invalid` 落到币种字段 |

## 测试 / Tests

`npm test`：706 pass（基线 689 + 新增 17 个用例），`npx tsc -b --noEmit` 与
`npm run build` 通过。

新增断言 / New assertions（`src/lib/serverBilling.test.mjs`）：

- `isIsoDate`：真实日期 / 闰日通过；`2026-02-30`、`2026-2-01`、空串、null 拒绝。
- `parsePriceYuan`：`49.99→4999`、`0.1→10`、`0→0`、空串→null、上界
  `9,999,999.99→999,999,999`；拒绝负号 / 千分位 / 三位小数 / 科学计数法 / 超上界。
- `formatPriceYuan`：分 → 元文本；负数、超范围、NaN、null 返回空串。
- `billingFormFromServer`：完整回填、null 全空、脏值逐字段丢弃、未知币种保留、0 元不丢。
- `hasAnyBillingField`：纯空白不算填写。
- `validateBillingForm`：空 / 部分填写合法；四个非法字段各自返回自己的消息 key。
- `translateBillingErrors`：key 只翻译一次。
- `billingPayload`：始终发四个键、空 = `null`、CNY 归一化、0 元保留、非法值不提交。
- `billingFieldForError`：四个 code → 四个字段；`params.field` 兜底；未知错误返回 null。
- 币种下拉辅助：已知 / 自定义 / 未填写；输入清洗只留 3 位大写字母。
- i18n：`servers.billing.*` 与四个 `errors` 码在中英都存在，且能用 `errorText` 翻译。
- 源码契约：`BillingFields` 含日期 / 价格 / 币种 / 周期控件与公开提示；
  新建与编辑对话框都调用 `BillingFields`、`billingPayload`、`validateBillingForm`
  和 `billingFieldForError`。
