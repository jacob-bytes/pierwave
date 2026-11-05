-- 套餐可见节点范围。只追加，不改 0001–0007。
--
-- 语义：
--   * node_scope_explicit = 0（历史数据 / 未设范围）→ 可见全部节点；
--   * node_scope_explicit = 1 → 只可见 package_nodes 里列出的节点；
--     该套餐一行都没有时表示「显式一个都不给」，而不是「全部」。
--
-- 必须用 packages 上的标记位来区分「未设范围」与「显式空范围」：
-- 只看 package_nodes 是否为空的话，`node_ids: []` 会和历史套餐一样被当成
-- 「全部节点」，而且「只绑了一个节点、后来该节点被删」也会因为有级联清理
-- 变成空行，从而悄悄放大成全部节点。标记位只在显式设置过范围时置 1，
-- 历史套餐保持 0，兼容性不受影响。
CREATE TABLE package_nodes (
    package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    PRIMARY KEY (package_id, node_id)
);

-- 删节点时外键级联按 node_id 反查，主键前缀帮不上忙。
CREATE INDEX idx_package_nodes_node ON package_nodes(node_id);

ALTER TABLE packages ADD COLUMN node_scope_explicit INTEGER NOT NULL DEFAULT 0;
