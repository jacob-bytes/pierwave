-- 「转发链模板」洞察的列表查询固定按 `created_at, rowid` 读模板：
--   SELECT * FROM chain_templates ORDER BY created_at ASC, rowid ASC
-- 模板数量很小，但补上排序索引后不再需要临时 B 树，避免每次刷新都排序。
--
-- 迁移只追加，不改历史文件；这只是一个索引，不影响已有数据。
-- English: additive index for the chain-template insight list. The query is
-- `SELECT * FROM chain_templates ORDER BY created_at ASC, rowid ASC`; the index
-- removes the temp B-tree. No table or column is added or changed.
CREATE INDEX IF NOT EXISTS idx_chain_templates_created
    ON chain_templates(created_at);
