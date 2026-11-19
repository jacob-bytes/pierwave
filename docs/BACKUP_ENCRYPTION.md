# 备份加密与设置项秘密加密 / Backup & Secret Encryption

本项目用**同一把主密钥 + AES-256-GCM**保护两样东西：

1. 导出的数据库备份（默认 `pierwave-backup-<ts>.db.gz.enc`）；
2. `settings` 表里的秘密值（`enc:v1:` 前缀）。

This project protects two things with **one master key and AES-256-GCM**:

1. database backups (default `pierwave-backup-<ts>.db.gz.enc`);
2. secret values in the `settings` table (prefixed with `enc:v1:`).

## 1. 主密钥来源 / Master key sources

优先级 / Priority:

1. 环境变量 `PIERWAVE_SECRET_KEY`：base64 编码的 32 字节密钥。
   Environment variable `PIERWAVE_SECRET_KEY`, a base64-encoded 32-byte key.
2. 数据库同目录的 `secret.key`（默认 `data/secret.key`）。
   `secret.key` next to the database file (default `data/secret.key`).

密钥文件不存在时自动生成，权限固定 `0600`，并在日志里 `warn`：

> 已生成主密钥文件，请备份该文件；丢失后已加密的备份与设置无法解密 /
> Generated the master key file. Back it up: losing it makes encrypted backups
> and settings unrecoverable

生成是原子的：先写 `secret.key.tmp`（0600）并 `fsync`，再 `rename` 到
`secret.key`，最后 `fsync` 父目录。并发首启时用 `create_new` 竞争 `.tmp`，
输的一方读取已落位的密钥，因此不会出现两把密钥或 0 字节文件。

Generation is atomic: write `secret.key.tmp` (0600) and `fsync`, `rename` it to
`secret.key`, then `fsync` the parent directory. Concurrent first starts race on
the `.tmp` file with `create_new`; the loser reads the key that won, so there is
never a second key or a zero-byte file.

如果 `secret.key` 已存在但无法解析（0 字节、半截 base64、被截断），启动会
失败并打印可操作指引：**服务不会静默重建它**——重建会让已有密文全部报废。
请从备份恢复 `secret.key`，确认旧密钥无用后再删除文件重新配置。

If an existing `secret.key` cannot be parsed (zero bytes, a truncated base64
line, a cut-off file), startup fails with actionable guidance and **does not
silently regenerate it** — regeneration would make every existing ciphertext
unreadable. Restore `secret.key` from backup, and only delete it (to
reconfigure) when the old key is truly expendable.

```bash
# 可选：用环境变量提供密钥（多实例/容器部署时必须所有实例一致）
# Optional: provide the key via env (all instances must share it)
openssl rand -base64 32        # 生成 / generate
PIERWAVE_SECRET_KEY='<base64-32-bytes>' ./pierwave-master
```

> **丢失主密钥的后果 / Consequence of losing the master key**
>
> 已加密的备份无法解密，`settings` 里的 Telegram Token、WebDAV 密码、
> Webhook 地址与订阅派生 secret 也无法还原；这些配置只能重新填写，
> 旧备份只能作废。请把 `secret.key` 与数据库备份**分开备份**。
>
> Encrypted backups become unreadable, and the Telegram token, WebDAV password,
> webhook URL and subscription derivation secret stored in `settings` cannot be
> recovered; they must be re-entered and old encrypted backups are useless.
> Back up `secret.key` **separately** from the database backups.

环境变量存在但格式非法（不是 base64、不是 32 字节）时**启动失败**，不会静默
回落到文件密钥——换一把密钥会让已有密文全部解不开。

If the variable exists but is malformed (not base64 or not 32 bytes), startup
fails instead of silently falling back to the file key: switching keys would
make all existing ciphertext unreadable.

内存库（`sqlite::memory:`）没有可持久化的位置，使用进程内随机密钥；测试与临时
实例不会写入 `data/secret.key`。

In-memory databases (`sqlite::memory:`) use a per-process random key and never
write `data/secret.key`.

数据库 URL 按 sqlx 的解析规则处理：`sqlite:data/x.db`（单冒号）、
`sqlite://data/x.db`、百分号编码与绝对路径都会落到同一个真实文件，
`secret.key` 与权限收紧跟着该文件走。空文件名或非 `sqlite:` scheme 会在启动
时报错，不会被当成内存库（否则会随机生成密钥并把备份误报成“内存库不支持”）。

Database URLs are parsed by sqlx: `sqlite:data/x.db` (single colon),
`sqlite://data/x.db`, percent-encoded and absolute paths all resolve to the same
real file, and `secret.key` plus file-permission hardening follow that file. An
empty filename or a non-`sqlite:` scheme is a startup error rather than an
in-memory database (which would generate a random key and make backups fail as
"in-memory unsupported").

## 2. 备份格式 / Backup format

```text
MAGIC(4) = "PWSB" | VERSION(1) = 0x01 | NONCE(12) | CIPHERTEXT(+16-byte GCM tag)
```

- `seal` 每次生成新的 12 字节随机 nonce；`open` 校验 MAGIC/VERSION、解密并
  验证 GCM tag，任意一字节被篡改都会失败。
- 加密的是**整份 gzip 产物**：`VACUUM INTO` → gzip → AES-256-GCM；
  下载与异地 WebDAV 上传共用同一份文件。
- 恢复按内容判断：`PWSB` 信封 → 解密后再 gunzip；gzip 魔数 → 旧明文备份；
  都不是 → 裸 SQLite `.db`。旧 `.db.gz` 与 `.db` 继续可用。
- 密文只多 33 字节头部/标签开销。

- Every `seal` call uses a fresh 12-byte random nonce; `open` validates
  MAGIC/VERSION, decrypts and verifies the GCM tag, so any single-byte change
  fails.
- The whole gzip artifact is encrypted (`VACUUM INTO` → gzip → AES-256-GCM).
  Downloads and WebDAV uploads share the same artifact.
- Restore sniffs the content: a `PWSB` envelope is decrypted and gunzipped; a
  gzip magic means a legacy plaintext backup; otherwise the upload is treated
  as a raw SQLite `.db`. Legacy `.db.gz` / `.db` uploads keep working.
- The envelope overhead is 33 bytes (header + tag).

设置项 `backup_encrypt`（默认 `true`）可以关闭。关闭后导出与异地备份都是
明文 `.db.gz`；设置页会常驻一条显式警告。关闭只影响**新生成**的备份，
不会重新加密或删除已有文件。

The `backup_encrypt` setting (default `true`) can be turned off. Exports and
off-site uploads then use plaintext `.db.gz`, and the settings page shows a
persistent warning. Turning it off only affects newly created backups; it does
not re-encrypt or delete existing files.

## 3. 设置项秘密 / Secret settings

落库格式 / Stored format:

```text
enc:v1:<base64 of the same MAGIC|VERSION|NONCE|CIPHERTEXT envelope>
```

加密的键 / Encrypted keys:

| key | 说明 / Notes |
|---|---|
| `telegram_bot_token` | Telegram Bot Token |
| `backup_webdav_password` | WebDAV 密码 / password |
| `webhook_url` | Webhook 地址（路径里常带 token）/ URL often embeds a token |
| `hmac_secret_v1` | 订阅凭据派生 secret / subscription derivation secret |

- 写入：设置接口先按明文校验，落库前加密；空串保持为空（用于清空
  `webhook_url` 这类可清空项）。
- 读取：`settings::load` 透明解密；API 仍然不回显 Token/密码（留空 = 不改）。
- 兼容：没有 `enc:v1:` 前缀的值按历史明文读取；迁移 0058 会把它们就地加密。
- **幂等**：迁移只处理非空且未加密的值，第二次运行不改写任何行。

- Write: the settings API validates plaintext, then encrypts before writing.
  Empty strings stay empty (used to clear keys such as `webhook_url`).
- Read: `settings::load` decrypts transparently. The API still never echoes the
  token/password (blank PATCH = keep the saved value).
- Compatibility: values without the `enc:v1:` prefix are read as legacy
  plaintext; migration 0058 encrypts them in place.
- **Idempotent**: migration only touches non-empty, unencrypted values; a second
  run rewrites nothing.

主密钥与密文不匹配时，秘密字段按空串处理，但 `GET /api/v1/settings` 仍返回
**200**，响应里带 `secret_errors.keys`（例如
`{"secret_errors":{"keys":["telegram_bot_token"]}}`），让设置页能整体打开并提示
哪些键需要重填；同时服务端写一条 error 日志。`PATCH` 仍可能返回
`settings.secret_overwrite`（见下节）。错误与标记都不包含密钥、密文或明文。

When the master key does not match the ciphertext, secret fields read as empty
strings, but `GET /api/v1/settings` still returns **200** with
`secret_errors.keys` (for example
`{"secret_errors":{"keys":["telegram_bot_token"]}}`). The settings page stays
usable and can show which keys need re-entry; the server also writes an error
log. `PATCH` can still return `settings.secret_overwrite` (see below). Neither the
marker nor any error message contains the key, ciphertext or plaintext.

### 设置页的逃生路径 / Settings escape hatch

`PATCH /api/v1/settings` 在主密钥不匹配时仍可自救：

1. **只写非秘密键**（如 `panel_name`、`backup_encrypt`）会成功，响应带
   `warning`（秘密仍未修复）；这保证管理员不会被一个坏 Token 锁在门外。
2. **用新值覆盖解不开的秘密键**（`telegram_bot_token`、
   `backup_webdav_password`、`webhook_url`）会成功；新值用当前主密钥加密。
3. 若请求要开启依赖坏秘密的功能（例如开启异地备份但没重填 WebDAV 密码、
   开启 Bot 但没重填 Token），返回 400 `settings.secret_overwrite`，
   提示先重填或先关闭该功能。

When the master key does not match, `PATCH /api/v1/settings` still allows
recovery:

1. **Writing only non-secret keys** (such as `panel_name` or `backup_encrypt`)
   succeeds with a `warning` (the secrets are still broken), so one bad token
   cannot lock the administrator out.
2. **Overwriting an unreadable secret** (`telegram_bot_token`,
   `backup_webdav_password`, `webhook_url`) succeeds; the new value is encrypted
   with the current master key.
3. Enabling a feature that depends on a broken secret (for example enabling
   off-site backup without re-entering the WebDAV password, or enabling the bot
   without re-entering the token) returns 400 `settings.secret_overwrite`.

## 4. 恢复前校验 / Restore preflight

`POST /api/v1/backup/restore` 在把上传文件 rename 成 `<db>.restore-pending`
**之前**会打开候选库，扫描 `settings` 里所有 `enc:v1:` 值并用**当前主密钥**
逐个解密：

- 有解不开的：拒绝恢复，HTTP 400 `backup.key_mismatch`，文案提示「备份来自
  另一把主密钥，请同时提供 secret.key 或设置相同的 PIERWAVE_SECRET_KEY」；
  pending 文件不会落盘。
- 管理员确认要丢弃旧秘密时，请求 `POST /api/v1/backup/restore?force=true`
  （上传体是原始文件字节，`force` 只能放在查询串）可强制恢复；候选库里
  **解不开的 `enc:v1:` 行会被删除**（能解开的与非秘密设置原样保留），响应带
  `warning`。恢复后 Telegram / WebDAV / Webhook 需重新填写；内部
  `hmac_secret_v1` 会在首次使用时重新生成，旧订阅链接随之失效。

Before renaming the upload to `<db>.restore-pending`, the restore endpoint opens
the candidate database, scans every `enc:v1:` value in `settings`, and decrypts
each one with the **current master key**:

- If any value cannot be decrypted, the restore is rejected with HTTP 400
  `backup.key_mismatch` ("the backup comes from another master key; provide
  secret.key or the same PIERWAVE_SECRET_KEY"). No pending file is written.
- To explicitly discard the old secrets, `POST /api/v1/backup/restore?force=true`
  (the body is the raw file, so `force` must be a query parameter) forces the
  restore and **deletes the unreadable `enc:v1:` rows** in the candidate
  database (readable secrets and all non-secret settings are preserved), then
  returns a `warning`. Telegram / WebDAV / webhook must be re-entered afterwards;
  the internal `hmac_secret_v1` is regenerated on first use, so old subscription
  links stop working.

`Db::migrate()` 也会扫描同样的 `enc:v1:` 值；解不开时按 **error** 级日志记录
键名（不含值），不会静默跳过。 / `Db::migrate()` performs the same scan and
logs an **error** with the key name (never the value) instead of skipping
silently.

## 5. 迁移 / Migrations

`crates/domain/migrations/0058_secret_settings.sql`：

- 写入 `backup_encrypt` 的默认值 `1`（`WHERE NOT EXISTS`，重跑不覆盖用户选择）；
- 作为版本锚点：SQL 不能做 AEAD，真正的明文→密文改写由
  `secret_box::encrypt_existing_settings` 在迁移之后执行（只处理非空且无前缀的值）。

`crates/domain/migrations/0058_secret_settings.sql`:

- inserts the `backup_encrypt` default `1` (`WHERE NOT EXISTS`, so re-running
  never overwrites the operator's choice);
- is the version anchor: SQL cannot do AEAD, so the actual plaintext→ciphertext
  rewrite runs in `secret_box::encrypt_existing_settings` right after
  migrations (only non-empty, unprefixed values).

## 6. 兼容性 / Compatibility

| 场景 / Scenario | 行为 / Behavior |
|---|---|
| 旧 `.db.gz` 明文备份 / legacy plaintext backup | 继续可恢复 / restores normally |
| 裸 `.db` 上传 / raw `.db` upload | 继续可恢复 / restores normally |
| 旧明文设置值 / legacy plaintext settings | 可直接读取；下次迁移加密 / readable; encrypted by migration |
| 未设环境变量 / no env var | 自动生成 `data/secret.key`（0600）/ generated automatically |
| 换机恢复加密备份 / restore on another host | 必须同时带上原 `secret.key` 或用同样的 `PIERWAVE_SECRET_KEY`；否则 400 `backup.key_mismatch` / must carry the same key, otherwise 400 `backup.key_mismatch` |
| 多实例部署 / multiple instances | 所有实例必须共享同一把密钥 / all instances must share one key |

## 7. 未做 / Not implemented

- **主密钥轮换 / key rotation**：没有 `re-encrypt` 命令；换密钥会导致旧密文
  解不开。需要轮换时应同时保留旧密钥并一次性重写备份与 `settings`。
- 旧备份的重新加密 / re-encrypting existing backups。
- 流式 AEAD：恢复加密备份时会先把 gzip 产物读进内存（仍受 512 MB 总上限约束）。

- **Key rotation**: there is no `re-encrypt` command; changing the key makes old
  ciphertext unreadable. Rotation would need the old key kept alongside and a
  one-shot rewrite of backups and `settings`.
- Re-encrypting existing backups.
- Streaming AEAD: restoring an encrypted backup reads the gzip artifact into
  memory (still bounded by the 512 MB limit).

> `scripts/verify-backup.sh` 已覆盖加密与明文两条导出/恢复路径（见
> `docs/QUALITY.md`）；`scripts/verify-upgrade.sh` 覆盖「旧版明文 `.db.gz`
> 在新版本恢复」。 / `scripts/verify-backup.sh` now covers both the encrypted
> and plaintext export/restore paths (see `docs/QUALITY.md`), and
> `scripts/verify-upgrade.sh` covers restoring a pre-encryption `.db.gz` backup
> on the upgraded version.
