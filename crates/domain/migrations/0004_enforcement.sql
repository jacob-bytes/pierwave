-- 断流（enforcement）：把「记账」变成「处置」。
-- 只追加，不改 0001–0003。

-- 一次「用户因套餐不可用被从某台服务器的下发配置中移除」事件。
-- message 是落库时定稿的中文说明，前端直接展示，不需要再拼装。
CREATE TABLE enforcement_events (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    username    TEXT NOT NULL,
    server_id   TEXT NOT NULL,
    server_name TEXT NOT NULL,
    reason      TEXT NOT NULL,                      -- exhausted | expired | disabled，多因用逗号分隔
    message     TEXT NOT NULL,                      -- 「用户 X 因额度用尽，已从服务器 Y 的配置中移除」
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_enforcement_events_created ON enforcement_events(created_at DESC);

-- 每台服务器最近一次成功下发的期望态指纹。
-- 断流对账每 5 分钟扫一轮，靠它判断「期望态有没有变化」：没变化就不 bump
-- config_version、不广播，避免空转和版本号噪音。
CREATE TABLE desired_snapshots (
    server_id      TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    fingerprint    TEXT NOT NULL,
    config_version INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
