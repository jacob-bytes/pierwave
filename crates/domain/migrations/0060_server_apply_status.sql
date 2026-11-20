-- 迁移 0060：Agent `ApplyResult` 的结构化落库（只追加；不改 0001–0059）。
--
-- Agent 落受管文件走两阶段提交：提交阶段失败时，失败点之前的文件已经
-- rename 生效。`ApplyResult.error` 只能带字符串，所以 Agent 用稳定标记
-- `[agent.apply_files.partial]` + 阶段 + 已生效路径表达「部分成功」。
--
-- 主控不再只写日志：解析后落成下面的结构化字段，服务器详情 / 配置版本旁边
-- 就能显示「部分应用（n/total 个文件已生效）」并展开具体路径。
--
--   * apply_status：`ok` / `partial` / `failed`；NULL = 从未上报。
--   * apply_error：`ApplyResult.error` 原文。非 partial 错误直接原样展示，
--     不做改写或截断；成功时为 NULL。
--   * apply_version：Agent 上报的配置版本（`ApplyResult.version`）。
--   * apply_at：主控收到该结果的时间（Unix 秒）。
--   * apply_partial_json：仅 partial 时的结构化详情
--     `{"stage":"...","effective":["/path",...],"total":3}`；NULL = 不是 partial。
--
-- 这些字段只描述「最近一次结果」，每次收到 ApplyResult 整体覆盖，不做历史表：
-- 需求只要求展示当前状态；历史审计已有 audit_log，不在这里重复。
--
-- English: structured storage for the Agent `ApplyResult`. `apply_status` is
-- ok/partial/failed (NULL = never reported); `apply_error` keeps the raw error
-- text (displayed as-is for non-partial failures); `apply_partial_json` holds
-- the stage and effective paths for partial successes. Every new result
-- overwrites the previous one — this is the current state, not history.

ALTER TABLE servers ADD COLUMN apply_status TEXT;
ALTER TABLE servers ADD COLUMN apply_error TEXT;
ALTER TABLE servers ADD COLUMN apply_version INTEGER;
ALTER TABLE servers ADD COLUMN apply_at INTEGER;
ALTER TABLE servers ADD COLUMN apply_partial_json TEXT;
