-- P5：批量 Agent 升级。只追加，不改 0001–0015。
--
-- 批量层只负责排队与协调：真正的升级仍然写 `agent_upgrades`，
-- 每个 item 通过 `upgrade_id` 指回那条记录（触发后回填）。

CREATE TABLE agent_upgrade_batches (
    id            TEXT PRIMARY KEY,
    from_version  TEXT NOT NULL DEFAULT '',   -- 状态里各台不一致，留空
    to_version    TEXT NOT NULL,
    status        TEXT NOT NULL,              -- running | succeeded | failed | cancelled
    stop_on_failure INTEGER NOT NULL DEFAULT 1,
    concurrency   INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE agent_upgrade_batch_items (
    batch_id   TEXT NOT NULL REFERENCES agent_upgrade_batches(id) ON DELETE CASCADE,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    upgrade_id TEXT,                          -- 触发后回填
    status     TEXT NOT NULL,                 -- queued | running | succeeded | failed | skipped | cancelled
    error      TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (batch_id, server_id)
);

-- runner 每轮都要找「还有排队/运行中 item」的批次，按批次创建时间顺序处理。
CREATE INDEX idx_upgrade_batch_items_status
    ON agent_upgrade_batch_items(status, batch_id);
