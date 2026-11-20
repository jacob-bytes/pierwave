-- 迁移 0062：一次性修复 `servers` 费用 / 到期四列的历史脏数据（只追加；不改 0001–0061）。
--
-- 为什么需要它：0061 只加了四个可空列，没有 CHECK。正常写入路径
-- （`pierwave_domain::billing::BillingMeta::validated`）产生不了下面的值，但手工
-- 改库或旧版本可能把 TEXT 写进 `price_cents`（INTEGER 亲和性转换失败时按 TEXT
-- 存），或写入越界价格 / 坏币种 / 未知周期 / 非 `YYYY-MM-DD` 日期。这种行会让
-- `Server::from_row` 解码失败，公开探针页、管理端列表、PATCH、DELETE 全部 500，
-- 管理员连「改回合法值」都做不到。
--
-- 处理口径与读路径（`BillingMeta::from_server`）一致：**类型被写坏或值域非法
-- 都按「未填写」处理，落成 NULL**。只清四列，不动其它字段；全程只用 UPDATE，
-- 可重复执行（幂等），不重建表、不删行。
--
-- English: one-off repair for legacy dirty values in the four billing columns added
-- by migration 0061. Normal writes (`BillingMeta::validated`) can never produce
-- these values. Wrong storage classes (e.g. TEXT inside the INTEGER column) and
-- out-of-domain values are reset to NULL, matching the tolerant read path
-- (`BillingMeta::from_server`). Only these four columns are touched; every
-- statement is idempotent and no rows are deleted.

-- 1) 列类型被写坏：SQLite 允许把无法转换的 TEXT 存进 INTEGER 列。
UPDATE servers SET paid_until = NULL WHERE typeof(paid_until) NOT IN ('text', 'null');
UPDATE servers SET price_cents = NULL WHERE typeof(price_cents) NOT IN ('integer', 'null');
UPDATE servers SET currency = NULL WHERE typeof(currency) NOT IN ('text', 'null');
UPDATE servers SET billing_cycle = NULL WHERE typeof(billing_cycle) NOT IN ('text', 'null');

-- 2) 值域非法。SQL 只能近似 Rust 校验：日期只做格式 / 年份 / 月日范围的基本
--    检查（`2026-02-30` 这类「格式合法但日历不存在」仍由读路径逐条降级）。
UPDATE servers SET paid_until = NULL
 WHERE paid_until IS NOT NULL
   AND (
     paid_until NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
     OR paid_until < '1970-01-01'
     OR paid_until > '2100-12-31'
     OR substr(paid_until, 6, 2) NOT BETWEEN '01' AND '12'
     OR substr(paid_until, 9, 2) NOT BETWEEN '01' AND '31'
   );

UPDATE servers SET price_cents = NULL
 WHERE price_cents IS NOT NULL
   AND (price_cents < 0 OR price_cents > 999999999);

UPDATE servers SET currency = NULL
 WHERE currency IS NOT NULL
   AND currency NOT GLOB '[A-Z][A-Z][A-Z]';

UPDATE servers SET billing_cycle = NULL
 WHERE billing_cycle IS NOT NULL
   AND billing_cycle NOT IN ('monthly', 'yearly', 'once');
