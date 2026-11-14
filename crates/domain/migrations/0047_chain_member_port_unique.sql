-- 链成员监听端口唯一：同一台服务器上的同一个端口只能被一条链的一个成员占用。
--
-- 历史数据：写路径的「查冲突 + 插入」在并发下曾经不是原子的，同一
-- (server_id, listen_port) 可能已经存在多行。SQLite 无法在保留全部行的前提下
-- 建立唯一索引，因此本迁移保留最早插入的一行（rowid 最小），删除其余冲突行。
--
-- 为什么是删除而不是改端口：
-- * 静默改端口会让线上客户端失联（入口端口是用户实际连接的地址）；
-- * 被删空的组会由 `chain.group_empty` 判成整链 blocked，链列表/概览显示
--   可读原因，管理员修改或删除该链即可恢复；
-- * 继续保留重复行则唯一索引建不起来，新的并发写入还会继续复制冲突。
--
-- 迁移只追加：不改 0001–0046；旧的 idx_chain_group_members_server 保留，
-- 新的唯一索引在同一列上，冲突查询仍然走索引。
DELETE FROM chain_group_members
WHERE rowid NOT IN (
    SELECT MIN(rowid)
      FROM chain_group_members
     GROUP BY server_id, listen_port
);

CREATE UNIQUE INDEX idx_chain_group_members_server_port
    ON chain_group_members(server_id, listen_port);

-- English: one listen port per server can belong to only one chain member.
-- The old check-then-insert path was not atomic under concurrency, so duplicate
-- (server_id, listen_port) rows may already exist. SQLite cannot create a unique
-- index while keeping all rows: this migration keeps the earliest row (lowest
-- rowid) and deletes the later duplicates. Ports are deliberately not rewritten
-- (a silent port change would disconnect live clients); groups left empty are
-- reported by `chain.group_empty` and block the whole chain with a readable
-- reason instead of silently falling back to a direct target.
