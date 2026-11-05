-- 双向断流：事件区分「移除 / 恢复」，快照记录已下发的用户集合。
-- 只追加，不改 0001–0004。

-- 已有事件都是移除，默认值正好回填历史行。
ALTER TABLE enforcement_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'removed';

-- 最近一次成功下发配置里的用户集合（JSON 数组）。
-- NULL = 0005 之前写入的旧快照，无法判断已下发内容；对账会保守跳过恢复检测，
-- 直到下一次 apply 把这里补上。不要用空数组代替 NULL，两者语义不同。
ALTER TABLE desired_snapshots ADD COLUMN granted_users TEXT;
