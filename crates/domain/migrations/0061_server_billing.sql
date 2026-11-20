-- 迁移 0061：服务器「费用与到期」元数据（只追加；不改 0001–0060）。
--
-- 四项都是**可选**的展示元数据：管理员填了，公开探针页就把价格与到期展示给
-- 所有人；不填就是 NULL（页面显示「—」）。它们不参与鉴权、期望态下发、限速
-- 或用户计费，改它们不会触发 Agent 下发。
--
--   * paid_until：到期日，`YYYY-MM-DD` 文本（SQLite 没有 DATE 类型，按文本存
--     保证与 API 原样往返）；NULL = 未填写。
--   * price_cents：价格，整数（`currency` 的最小单位，通常为「分」）；NULL = 未填写。
--     写路径要求 0 <= price_cents < 1_000_000_000（约 1000 万元上限，防脏数据）。
--   * currency：币种，3 位大写字母（CNY / USD / EUR ...）；NULL = 未填写。
--   * billing_cycle：计费周期，`monthly` / `yearly` / `once`；NULL = 未填写。
--
-- 校验在 Rust 写路径（`pierwave_domain::billing::BillingMeta::validated`）完成，
-- 不在这里加 CHECK：SQLite 的 ALTER TABLE ADD COLUMN 只能在建表时稳定约束，
-- 且读路径必须容忍历史/手工写入的非法值（公开页按未填写处理，不 panic）。
--
-- English: optional cost/expiry metadata for the public probe page. `paid_until`
-- is a `YYYY-MM-DD` string, `price_cents` an integer in cents (0 <= n < 1e9),
-- `currency` a three-letter uppercase code, and `billing_cycle` one of
-- monthly/yearly/once. The master validates on write; reads tolerate dirty
-- values and expose NULL instead of failing.

ALTER TABLE servers ADD COLUMN paid_until TEXT;
ALTER TABLE servers ADD COLUMN price_cents INTEGER;
ALTER TABLE servers ADD COLUMN currency TEXT;
ALTER TABLE servers ADD COLUMN billing_cycle TEXT;
