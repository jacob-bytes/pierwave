-- master / agent 更新检测结果（迁移 0049）。
--
-- 只有一行（id = 1）：检测任务是单实例的，历史值没有保留价值，只需要
-- 「上次检测」这一份快照。字段含义：
--   latest_version    —— 上一次**成功**解析到的最新版本（不带 v 前缀）；
--   release_url       —— 对应的 GitHub Release 页面；
--   released_at       —— Release 发布时间（Unix 秒）；
--   checked_at        —— 最近一次检测时间（成功或失败都会写）；
--   error             —— 最近一次失败的中英双语原因；空串 = 最近一次成功；
--   notified_version  —— 已经通过告警渠道通知过的版本，避免每轮重复发送；
--   updated_at        —— 本行最后写入时间（排查用）。
--
-- 失败时只更新 checked_at / error / updated_at，latest_version 与
-- release_url 保留上一次成功值：界面上的「最新版本」不能因为一次网络抖动
-- 就变空。迁移只追加，不改 0048 及更早。
CREATE TABLE IF NOT EXISTS update_check (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    latest_version TEXT NOT NULL DEFAULT '',
    release_url TEXT NOT NULL DEFAULT '',
    released_at INTEGER,
    checked_at INTEGER,
    error TEXT NOT NULL DEFAULT '',
    notified_version TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO update_check (id) VALUES (1);

-- English: a single row (id = 1) holds the last update check. `latest_version`,
-- `release_url` and `released_at` keep the last successful value, so one
-- network blip does not blank the UI; a failure only updates `checked_at` /
-- `error`. `notified_version` remembers what was already delivered to the
-- alert channels, so the same release is never announced twice.
