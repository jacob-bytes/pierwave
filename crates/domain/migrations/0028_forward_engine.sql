-- 转发引擎可选：native（Agent 自己监听，现有实现）或 realm（受管子进程）。
--
-- 只追加列、不改历史文件：旧数据默认 native，行为与升级前完全一致。
-- 取值只接受 native / realm，写路径由领域层 `engine::normalize` 严格校验；
-- SQLite 没有枚举类型，这里用 DEFAULT 兜住历史行与漏填的写入。
ALTER TABLE forwards ADD COLUMN engine TEXT NOT NULL DEFAULT 'native';
ALTER TABLE chains   ADD COLUMN engine TEXT NOT NULL DEFAULT 'native';
