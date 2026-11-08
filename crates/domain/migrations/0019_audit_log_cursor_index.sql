-- 审计日志游标分页：`(created_at, id)` 是排序键，也是翻页边界。
-- 没有这个索引时，翻页查询要对 audit_log 全表排序；有了它可以直接走索引倒序扫描。
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at_id
    ON audit_log (created_at, id);
