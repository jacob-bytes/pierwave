-- 用户自助转发（第一期，不含流量计量）。
--
-- * packages.forward_limit：每个用户最多能创建多少条自助转发；0 = 不允许（默认）。
-- * package_forward_servers：套餐允许自助转发落地的服务器白名单；没有行 = 一台都不允许。
--   目标服务器必须同时出现在「生效中且 forward_limit > 0」的套餐白名单里。
-- * forwards.owner_user_id：创建者；NULL = 管理员创建（历史行全部为 NULL，行为不变）。
-- * forwards.count_traffic：预留给后续流量计量，本期只写入默认值、不参与任何判断。
--
-- 迁移只追加：历史套餐 forward_limit = 0、白名单为空，因此升级后所有用户都还不能
-- 创建自助转发；管理员转发的读写路径完全不受影响。

ALTER TABLE packages ADD COLUMN forward_limit INTEGER NOT NULL DEFAULT 0;

CREATE TABLE package_forward_servers (
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  server_id  TEXT NOT NULL REFERENCES servers(id)  ON DELETE CASCADE,
  PRIMARY KEY (package_id, server_id)
);

ALTER TABLE forwards ADD COLUMN owner_user_id TEXT;        -- NULL = 管理员创建
ALTER TABLE forwards ADD COLUMN count_traffic INTEGER NOT NULL DEFAULT 0;  -- 本期只存不用

-- 用户视角列表按 owner 过滤；没有索引时全表扫。
CREATE INDEX idx_forwards_owner ON forwards(owner_user_id, created_at);

-- English: user self-service port forwarding, phase 1 (no traffic metering).
-- packages.forward_limit = how many rules a user may own (0 = not allowed).
-- package_forward_servers whitelists the servers a package may forward on;
-- no rows means none. forwards.owner_user_id is NULL for admin-created rules,
-- so every existing row keeps its old behaviour. count_traffic is reserved for
-- a later phase and is never read by this release.
