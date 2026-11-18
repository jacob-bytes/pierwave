-- 迁移 0058：设置项秘密加密 + 备份默认加密。
--
-- 1) `backup_encrypt` 默认 `1`：`GET /api/v1/backup` 与异地备份都输出
--    `pierwave-backup-<ts>.db.gz.enc`（gzip 后再用主密钥 AES-256-GCM 加密）。
--    管理员可以显式设为 `0` 回到明文 `.db.gz`。
--    `INSERT ... WHERE NOT EXISTS` 保证重复执行不会覆盖用户的选择。
--
-- 2) `settings` 表中已有的明文秘密（`telegram_bot_token`、
--    `backup_webdav_password`、`webhook_url`、`hmac_secret_v1`）由
--    `pierwave_domain::secret_box::encrypt_existing_settings` 在本次迁移之后
--    就地改写为 `enc:v1:<base64 信封>`。SQL 无法做 AEAD，所以这一步放在
--    Rust 侧、与迁移同一个启动步骤执行；它只处理「非空且没有前缀」的值，
--    因此重跑迁移是幂等的。
--
-- English: migration 0058 adds the `backup_encrypt` default (1 = encrypted
-- backups) and is the schema/version anchor for encrypting existing plaintext
-- secrets in place. The AEAD rewrite happens in Rust right after migrations
-- (`secret_box::encrypt_existing_settings`); it skips empty/prefixed values,
-- so re-running it is idempotent.

INSERT INTO settings (key, value)
SELECT 'backup_encrypt', '1'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'backup_encrypt');
