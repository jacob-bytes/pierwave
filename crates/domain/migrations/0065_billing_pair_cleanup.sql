-- 迁移 0065：修复历史「只有价格没币种」/「只有币种没价格」的行
-- （只追加；不改 0001–0064）。
--
-- 背景：0061 加了 4 个可空的费用列，0062 只修「类型写坏 / 值域非法」，没有
-- 处理**成对**约束。写路径 `BillingMeta::validated` 会拒绝只填一半（错误码
-- `server.billing_pair_incomplete`），但旧版本 / 手工改库仍可能留下：
--
--   * price_cents = 4999, currency = NULL   → 公开页显示「¥49.99」却没有币种；
--   * currency = 'CNY', price_cents = NULL  → 公开页显示「CNY」却没有金额。
--
-- 这种行既无法理解也无法校验，前端只能整组隐藏，管理员却以为自己填了。
--
-- 处理口径：**单边行整组清成 NULL**（不猜价格、不补默认币种）；成对的行原样
-- 保留。只动这两列，全程 UPDATE，不重建表、不删行，可重复执行（幂等）。
--
-- 注意：0062 先把非法值清成 NULL，所以「价格合法 + 币种非法」的行会先丢掉
-- 币种，再被本迁移按单边行整组清空——这正是希望的结果。
--
-- English: one-off repair for legacy rows where only one of
-- `price_cents` / `currency` is set. The write path already rejects such pairs
-- (`server.billing_pair_incomplete`), but older versions and hand-edited
-- databases can contain them, which renders as a price without a currency (or
-- the reverse) on the public page. Both columns are reset to NULL for unpaired
-- rows; complete pairs are untouched. Only these two columns change, every
-- statement is an idempotent UPDATE, and no rows are deleted.

UPDATE servers
   SET price_cents = NULL,
       currency = NULL
 WHERE (price_cents IS NULL) <> (currency IS NULL);
