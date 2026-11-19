-- 迁移 0059：补齐真实查询剩下的全表扫描（P1）。
--
-- 只追加，不改 0001–0058。每个索引都对应一条实际 SQL；先用
-- `EXPLAIN QUERY PLAN` 记录过优化前的计划（关键查询见 docs/PERF.md）。
-- 高频写入的表（traffic_daily / traffic_node_daily）只加查询确实用得到的
-- 复合索引，不做「每列一个」。写入侧代价：两条日账本每次 upsert 多维护
-- 2 个 / 1 个索引，换来的是按用户、按服务器、按服务器+日期的时间窗查询
-- 从扫描整段日期退化为索引区间。
--
-- English: migration 0059 adds the indexes that real queries still needed
-- after measuring `EXPLAIN QUERY PLAN`. Only append; no historical migration
-- is changed. Each index is tied to a concrete query below. The two daily
-- traffic ledgers pay a small write cost per upsert in exchange for turning
-- whole-window scans into index range seeks.

-- 1. `traffic_daily(subject, day)`
--    服务：stats::subject_totals（WHERE subject = ?）、
--          stats::traffic_trend_for_subject（subject = ? AND day BETWEEN ? AND ?）。
--    主键是 (day, server_id, subject)：只有 subject 条件时旧计划靠 SQLite 的
--    skip-scan（ANY(day) AND ANY(server_id)），用户越多跳得越多。
CREATE INDEX idx_traffic_daily_subject_day
    ON traffic_daily (subject, day);

-- 2. `traffic_daily(server_id, day)`
--    服务：overview::top_servers 的
--          LEFT JOIN traffic_daily t ON t.server_id = s.id AND t.day BETWEEN ? AND ?。
--    没有它时每台服务器都要按日期区间重扫一遍窗口（服务器数 × 窗口行数）。
CREATE INDEX idx_traffic_daily_server_day
    ON traffic_daily (server_id, day);

-- 3. `traffic_node_daily(server_id, day)`
--    服务：stats::node_traffic 带 `?server_id=` 的筛选。
--    已存在的 (server_id, node_tag, day) 在 node_tag 未约束时用不上 day；
--    主键又以 day 开头，所以「服务器 + 日期窗口」需要这条独立索引。
CREATE INDEX idx_traffic_node_daily_server_day
    ON traffic_node_daily (server_id, day);

-- 4. `audit_log(actor_id, action, created_at, id)`
--    服务：audit::recent_logins
--          （WHERE actor_id = ? AND action = 'auth.login'
--            ORDER BY created_at DESC, id DESC LIMIT ?）。
--    原有 (created_at, id) 只能按时间扫全表再过滤 actor；把 id 放进索引尾部
--    是为了让倒序翻页不再需要临时 B 树。
CREATE INDEX idx_audit_log_actor_action_created
    ON audit_log (actor_id, action, created_at, id);

-- 5. `sessions(expires_at)`
--    服务：sessions::purge_expired（DELETE ... WHERE expires_at < ?），
--          调度器按周期清理，旧计划是全表扫描。
CREATE INDEX idx_sessions_expires_at
    ON sessions (expires_at);

-- 6. `users(created_at)`
--    服务：users::list_with_query 的
--          `ORDER BY created_at DESC, rowid DESC LIMIT ?`。
--    索引尾部的 rowid 是 SQLite 索引的隐式列，倒序扫描即可直接取前 N 行，
--    不需要把整张 users 排序。
CREATE INDEX idx_users_created_at
    ON users (created_at);

-- 7. `nodes(server_id, created_at)`
--    服务：nodes::list_page 的服务器内分页
--          （WHERE server_id = ? ORDER BY created_at ASC, rowid ASC）。
--    UNIQUE(server_id, tag) 能定位服务器，但仍要对结果排序。
CREATE INDEX idx_nodes_server_created
    ON nodes (server_id, created_at);

