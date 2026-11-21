-- 公开状态页白名单（迁移 0064）
--
-- 每台服务器是否出现在无需登录的 /api/v1/public/status 里。
-- 默认 1（可见），与升级前的行为一致：已有服务器全部继续公开，
-- 管理员需要时再显式隐藏。列只影响公开读接口，不参与鉴权、期望态下发或计费。
ALTER TABLE servers ADD COLUMN public_visible INTEGER NOT NULL DEFAULT 1;
