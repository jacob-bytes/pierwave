-- 服务器分组：可空，NULL = 未分组。分组只是展示维度，不参与鉴权/下发。
--
-- 公开探针页按这一列聚合；名称的 trim / 长度 / 非法字符校验在写路径完成，
-- 历史数据一律为 NULL（归入「未分组」），不猜测任何分组。
ALTER TABLE servers ADD COLUMN group_name TEXT;

-- English: server grouping. NULL means ungrouped; the column is presentation-only
-- and never affects auth or desired-state dispatch. Existing rows stay NULL.
