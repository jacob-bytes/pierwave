-- P15.3 链路跳间加密（TLS 单向）所需的最小追加列。
--
-- chains.transport:
--   'none'（默认）= 明文，行为与升级前完全一致；
--   'tls'        = 组与组之间用 realm 的 listen/remote transport 做单向 TLS。
-- 只追加列、默认 none：旧链升级后下发结果逐字节不变。
ALTER TABLE chains ADD COLUMN transport TEXT NOT NULL DEFAULT 'none';

-- chain_groups.cert_id:
--   该组（seq >= 1）realm 监听要用的证书。seq = 0（入口组）不允许填写，
--   由领域层校验拦截：入口组的监听始终是明文。
--   证书本体仍存在 certificates 表里，Agent 侧落到
--   /usr/local/etc/xray/certs/{cert_id}.pem|.key（见 certificate::cert_file_path）。
ALTER TABLE chain_groups ADD COLUMN cert_id TEXT;

-- servers.realm_transport:
--   Agent 心跳能力缓存：NULL = 未知（旧 Agent / 未上报）；1 = realm --version
--   输出带 [transport]；0 = 不支持（slim 构建或旧版本）。
--   主控只有在下发前看到 1 才会给该服务器下发 TLS 链，否则整链跳过并给出原因。
ALTER TABLE servers ADD COLUMN realm_transport INTEGER;
