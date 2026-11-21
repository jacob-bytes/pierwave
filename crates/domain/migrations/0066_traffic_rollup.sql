-- 迁移 0066：流量日汇总表（概览从「扫 30 天原始行」改为「读日汇总」）。
--
-- 只追加，不改 0001–0065。原始表 `traffic_daily` / `traffic_node_daily` 仍是
-- 唯一事实来源与计费口径；本表只是它们的**按日聚合视图**，由触发器在同一
-- 条写语句里维护（同事务、无延迟），因此不会出现「账已入、概览还是旧数」。
--
-- scope / key：
--   * `subject`：key = traffic_daily.subject（用户 id，或归因失败时的原始 email）
--   * `server` ：key = traffic_daily.server_id
--   * `node`   ：key = server_id || char(31) || node_tag（来自 traffic_node_daily）
--   * `legacy` ：key = server_id || char(31) || node_tag，只收 subject 里带 `@` 的
--                历史行；协议归属查询用 `NOT EXISTS(node)` 与原始语义对齐。
--
-- 主键顺序特意是 `(scope, day, key)`：概览的日窗口都带 `scope`，把它放在最前
-- 让同一 scope 的日期区间成为聚簇主键上的一段连续区间（WITHOUT ROWID），
-- 比 `(day, scope, key)` 少一次回表。按 key 查单个用户/服务器时用
-- `idx_traffic_daily_rollup_key_day`。
--
-- 触发器对 INSERT / UPDATE / DELETE 都写「差值」：正常上报是累加，显式修正或
-- 删除历史流量则用负增量把汇总一起拉回一致；绕过触发器直接改原始表后，启动时
-- 的 `repo::traffic_rollup::ensure_backfilled` 会检测到总和差异并全量重建。
--
-- English: migration 0066 adds a per-day rollup (scope, day, key, uplink,
-- downlink, weighted) maintained by triggers in the same statement as the raw
-- ledgers. The raw tables stay authoritative; the rollup is a read model for
-- the overview so it no longer scans 30 days of rows. The primary key starts
-- with `scope` so a date window is one contiguous clustered range (WITHOUT
-- ROWID). UPDATE/DELETE triggers apply negative deltas, so explicit history
-- corrections stay consistent; a startup consistency check there rebuilds the
-- rollup if someone bypassed the triggers.

CREATE TABLE traffic_daily_rollup (
    scope    TEXT NOT NULL,
    day      TEXT NOT NULL,            -- UTC+8 自然日，与原始表同口径
    key      TEXT NOT NULL,            -- 维度值；node/legacy 用 \x1f 连接两个键
    uplink   INTEGER NOT NULL DEFAULT 0,
    downlink INTEGER NOT NULL DEFAULT 0,
    weighted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, day, key)
) WITHOUT ROWID;

-- 按维度取单个对象的时间窗（例如 top_servers 的 LEFT JOIN、用户/节点趋势）。
CREATE INDEX idx_traffic_daily_rollup_key_day
    ON traffic_daily_rollup (scope, key, day);

-- 汇总代际：每次原始表变更 / 全量重建都 +1。概览缓存把它当 key，
-- 写路径不需要遍历缓存就能让旧结果失效。
CREATE TABLE traffic_rollup_meta (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL DEFAULT 0,
    rebuilt_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO traffic_rollup_meta (id, generation, rebuilt_at) VALUES (1, 1, 0);

-- 历史数据一次性补齐（升级到本迁移时执行一次；空库就是 no-op）。
INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
SELECT 'subject', day, subject,
       COALESCE(SUM(uplink), 0), COALESCE(SUM(downlink), 0), COALESCE(SUM(weighted), 0)
FROM traffic_daily
GROUP BY day, subject;

INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
SELECT 'server', day, server_id,
       COALESCE(SUM(uplink), 0), COALESCE(SUM(downlink), 0), COALESCE(SUM(weighted), 0)
FROM traffic_daily
GROUP BY day, server_id;

INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
SELECT 'legacy', day,
       server_id || char(31) || substr(subject, instr(subject, '@') + 1),
       COALESCE(SUM(uplink), 0), COALESCE(SUM(downlink), 0), COALESCE(SUM(weighted), 0)
FROM traffic_daily
WHERE instr(subject, '@') > 0
GROUP BY day, server_id, substr(subject, instr(subject, '@') + 1);

INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
SELECT 'node', day, server_id || char(31) || node_tag,
       COALESCE(SUM(uplink), 0), COALESCE(SUM(downlink), 0), COALESCE(SUM(weighted), 0)
FROM traffic_node_daily
GROUP BY day, server_id, node_tag;

UPDATE traffic_rollup_meta
SET rebuilt_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE id = 1;

-- ---- traffic_daily：subject / server / legacy 三个 scope -------------------

CREATE TRIGGER traffic_daily_rollup_insert
AFTER INSERT ON traffic_daily
BEGIN
    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('subject', NEW.day, NEW.subject, NEW.uplink, NEW.downlink, NEW.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('server', NEW.day, NEW.server_id, NEW.uplink, NEW.downlink, NEW.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    SELECT 'legacy', NEW.day,
           NEW.server_id || char(31) || substr(NEW.subject, instr(NEW.subject, '@') + 1),
           NEW.uplink, NEW.downlink, NEW.weighted
    WHERE instr(NEW.subject, '@') > 0
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    UPDATE traffic_rollup_meta SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER traffic_daily_rollup_update
AFTER UPDATE ON traffic_daily
BEGIN
    -- 先减旧值，再加新值：既覆盖普通累加，也覆盖显式修改历史行。
    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('subject', OLD.day, OLD.subject, -OLD.uplink, -OLD.downlink, -OLD.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('server', OLD.day, OLD.server_id, -OLD.uplink, -OLD.downlink, -OLD.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    SELECT 'legacy', OLD.day,
           OLD.server_id || char(31) || substr(OLD.subject, instr(OLD.subject, '@') + 1),
           -OLD.uplink, -OLD.downlink, -OLD.weighted
    WHERE instr(OLD.subject, '@') > 0
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('subject', NEW.day, NEW.subject, NEW.uplink, NEW.downlink, NEW.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('server', NEW.day, NEW.server_id, NEW.uplink, NEW.downlink, NEW.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    SELECT 'legacy', NEW.day,
           NEW.server_id || char(31) || substr(NEW.subject, instr(NEW.subject, '@') + 1),
           NEW.uplink, NEW.downlink, NEW.weighted
    WHERE instr(NEW.subject, '@') > 0
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    UPDATE traffic_rollup_meta SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER traffic_daily_rollup_delete
AFTER DELETE ON traffic_daily
BEGIN
    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('subject', OLD.day, OLD.subject, -OLD.uplink, -OLD.downlink, -OLD.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('server', OLD.day, OLD.server_id, -OLD.uplink, -OLD.downlink, -OLD.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    SELECT 'legacy', OLD.day,
           OLD.server_id || char(31) || substr(OLD.subject, instr(OLD.subject, '@') + 1),
           -OLD.uplink, -OLD.downlink, -OLD.weighted
    WHERE instr(OLD.subject, '@') > 0
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    UPDATE traffic_rollup_meta SET generation = generation + 1 WHERE id = 1;
END;

-- ---- traffic_node_daily：node scope ---------------------------------------

CREATE TRIGGER traffic_node_daily_rollup_insert
AFTER INSERT ON traffic_node_daily
BEGIN
    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('node', NEW.day, NEW.server_id || char(31) || NEW.node_tag,
            NEW.uplink, NEW.downlink, NEW.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    UPDATE traffic_rollup_meta SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER traffic_node_daily_rollup_update
AFTER UPDATE ON traffic_node_daily
BEGIN
    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('node', OLD.day, OLD.server_id || char(31) || OLD.node_tag,
            -OLD.uplink, -OLD.downlink, -OLD.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    -- 只有原始行被删除时才抹掉归零的汇总行：原始表里「有一行但值为 0」
    -- 与「没有这一行」在协议归属的 NOT EXISTS 语义里不同，必须区分。
    DELETE FROM traffic_daily_rollup
    WHERE scope = 'node'
      AND day = OLD.day
      AND key = OLD.server_id || char(31) || OLD.node_tag
      AND uplink = 0 AND downlink = 0 AND weighted = 0;

    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('node', NEW.day, NEW.server_id || char(31) || NEW.node_tag,
            NEW.uplink, NEW.downlink, NEW.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    UPDATE traffic_rollup_meta SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER traffic_node_daily_rollup_delete
AFTER DELETE ON traffic_node_daily
BEGIN
    INSERT INTO traffic_daily_rollup (scope, day, key, uplink, downlink, weighted)
    VALUES ('node', OLD.day, OLD.server_id || char(31) || OLD.node_tag,
            -OLD.uplink, -OLD.downlink, -OLD.weighted)
    ON CONFLICT(scope, day, key) DO UPDATE SET
        uplink = uplink + excluded.uplink,
        downlink = downlink + excluded.downlink,
        weighted = weighted + excluded.weighted;

    DELETE FROM traffic_daily_rollup
    WHERE scope = 'node'
      AND day = OLD.day
      AND key = OLD.server_id || char(31) || OLD.node_tag
      AND uplink = 0 AND downlink = 0 AND weighted = 0;

    UPDATE traffic_rollup_meta SET generation = generation + 1 WHERE id = 1;
END;
