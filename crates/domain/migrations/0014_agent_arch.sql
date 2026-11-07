-- P4：Agent 自升级需要知道服务器真实 CPU 架构，才能下发对应产物。
-- 只追加，不改 0013（已被开发库应用过，改校验和会让 sqlx migrate 直接失败）。

ALTER TABLE servers ADD COLUMN arch TEXT NOT NULL DEFAULT '';
