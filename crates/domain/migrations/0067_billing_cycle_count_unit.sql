-- 迁移 0067：计费周期从「三选一」改为「数量 + 单位」（只追加；不改 0001–0066）。
--
-- 0061 的 `billing_cycle` 只能取 monthly / yearly / once，表达不了「3 个月」
-- 或「2 年」。本迁移新增两列作为**唯一事实来源**：
--
--   * billing_cycle_count：数量，1..1200 的整数（1200 个月 = 100 年）；
--   * billing_cycle_unit ：单位，`month` / `year` / `once`。
--
-- 两列必须同时有值或同时为空；`once` 时数量固定为 1。校验在 Rust 写路径
-- （`pierwave_domain::billing::BillingMeta::validated`）完成，不在这里加 CHECK：
-- 与 0061 一致，读路径必须容忍手工改库留下的脏值，而不是让整页 500。
--
-- 旧列 `billing_cycle` **保留**，降级为只读派生镜像：写路径同时维护
-- （count=1 & month → monthly；count=1 & year → yearly；unit=once → once；
-- 其它 → NULL），让只读该列的旧客户端与旧备份继续可用。
--
-- English: migration 0067 replaces the three-value `billing_cycle` with a
-- quantity + unit pair. `billing_cycle_count` is 1..1200 (1200 months = 100
-- years) and `billing_cycle_unit` is month/year/once; both are set together or
-- both NULL, and `once` always uses count 1. The legacy `billing_cycle` column
-- is kept as a read-only derived mirror maintained by the write path, so old
-- clients and old backups keep working. Validation lives in Rust, not in a
-- CHECK constraint, matching 0061.

ALTER TABLE servers ADD COLUMN billing_cycle_count INTEGER;
ALTER TABLE servers ADD COLUMN billing_cycle_unit TEXT;

-- 回填历史行：三种旧值各自映射成 1 个对应单位。
UPDATE servers SET billing_cycle_count=1, billing_cycle_unit='month' WHERE billing_cycle='monthly';
UPDATE servers SET billing_cycle_count=1, billing_cycle_unit='year'  WHERE billing_cycle='yearly';
UPDATE servers SET billing_cycle_count=1, billing_cycle_unit='once'  WHERE billing_cycle='once';
