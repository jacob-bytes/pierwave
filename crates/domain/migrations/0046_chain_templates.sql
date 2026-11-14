-- 链模板（用户自助）：管理员预先定义一条链的形态（跳 / 引擎 / 加密方式），
-- 用户只选模板 + 填目标，入口端口由主控自动分配。
--
-- 迁移只追加：
-- * chain_templates 只是一份「形态」定义，不影响任何已有链；
-- * packages.chain_limit 默认 0，升级后所有用户都还不能自助建链；
-- * package_chain_templates 为空时表示「不发放任何模板」；
-- * chains.template_id / owner_user_id 只有新写入的用户链才会填值，
--   owner_user_id = NULL 的既有链仍走管理员路径，行为完全不变。
CREATE TABLE chain_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  engine TEXT NOT NULL,               -- native / realm / nftables / tunnel
  security TEXT NOT NULL DEFAULT 'tls',
  transport TEXT NOT NULL DEFAULT 'none',
  protocol TEXT NOT NULL DEFAULT 'tcp',
  groups_json TEXT NOT NULL,          -- [{ seq, strategy, server_ids: [...] }]
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

ALTER TABLE packages ADD COLUMN chain_limit INTEGER NOT NULL DEFAULT 0;

CREATE TABLE package_chain_templates (
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES chain_templates(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, template_id)
);

ALTER TABLE chains ADD COLUMN template_id TEXT;
ALTER TABLE chains ADD COLUMN owner_user_id TEXT;

-- 用户视角列表按 owner 过滤；与 forwards 的索引口径一致。
CREATE INDEX idx_chains_owner ON chains(owner_user_id, created_at);

-- English: chain templates for user self-service. The table only stores the
-- shape (hops / engine / security / protocol); packages.chain_limit defaults to
-- 0 and an empty package_chain_templates grants no template, so no user can
-- create chain links until an administrator opts in. chains.template_id and
-- chains.owner_user_id stay NULL for existing administrator-created chains.
