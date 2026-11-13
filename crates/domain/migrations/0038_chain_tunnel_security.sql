-- P16 隧道的安全模式：tls（默认，自有 CA）或 noise（Noise/PSK，无证书）。
--
-- 只追加，不改历史表结构。迁移默认 'tls' 让所有历史 tunnel 链保持 P16.1
-- 已验收的行为；读路径遇到未知/脏值也回落 tls（见 domain::tunnel_security）。
-- 该列只对 engine = 'tunnel' 的链有意义，写路径严格校验两个合法值。
ALTER TABLE chains ADD COLUMN tunnel_security TEXT NOT NULL DEFAULT 'tls';

-- English: P16 tunnel security mode. 'tls' (default, master-owned CA) keeps
-- existing tunnel chains byte-for-byte identical; 'noise' selects Noise/PSK
-- without certificates. Unknown values fall back to tls on the read path.
