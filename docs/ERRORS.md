# 错误码（后端 → 前端词典）

后端 `AppError` 在响应里返回 `{ error, code, params }`；前端按 `code` 查 `errors.*` 词典，
查不到就回落到 `error` 原文（保证未翻译的错误不会显示成键名）。

新增错误时必须同时更新本表与 `web/src/i18n/{zh-CN,en}.ts` 的 `errors.*`。

| code | 中文兜底 | params |
|---|---|---|
| `auth.unauthorized` | 未登录 | — |
| `auth.invalid_credentials` | 用户名或密码错误 | — |
| `auth.wrong_password` | 旧密码错误 | — |
| `auth.forbidden` | 权限不足 | — |
| `auth.account_disabled` | 账号已被禁用 | — |
| `auth.too_many_attempts` | 尝试过于频繁，请 {minutes} 分钟后再试 | minutes |
| `common.resource_not_found` | 资源不存在 | — |
| `common.enum_invalid` | 不支持的{field}：{value} | field, value |
| `query.limit_invalid` | limit 必须是整数 | — |
| `query.limit_out_of_range` | limit 必须在 1-{max} 之间 | max |
| `query.cursor_invalid` | before 游标无效 | — |
| `event.cleanup_days_invalid` | 清理天数必须在 {min}-{max} 天之间，或选择全部 | max, min |
| `request.no_update_fields` | 至少需要提供一个可更新字段 | — |
| `user.not_found` | 用户不存在 | — |
| `user.username_length_invalid` | 用户名长度必须在 {min}-{max} 个字符之间 | max, min |
| `user.password_too_short` | 密码至少 {min} 位 | min |
| `user.username_taken` | 用户名已存在 | — |
| `user.cannot_demote_self` | 不能把自己降级为普通用户 | — |
| `user.cannot_disable_self` | 不能禁用自己的账号 | — |
| `user.cannot_delete_self` | 不能删除自己 | — |
| `user_package.not_found` | 套餐实例不存在 | — |
| `server.not_found` | 服务器不存在 | — |
| `server.name_address_required` | 名称和地址不能为空 | — |
| `server.name_required` | 服务器名称不能为空 | — |
| `server.address_required` | 服务器地址不能为空 | — |
| `server.name_too_long` | 服务器名称最多 {max} 个字符 | max |
| `server.group_name_too_long` | 分组名称最多 {max} 个字符 | max |
| `server.group_name_invalid` | 分组名称包含非法字符 | value |
| `server.xray_mode_unsupported` | 目前只支持外置 Xray（external） | — |
| `server.port_range_invalid` | 端口范围不合法：起止必须同时填写、在 1-65535 之间，且起始不大于结束 | — |
| `server.port_allow_invalid` | 额外允许的端口必须是 1-65535 的整数 | — |
| `server.nic_name_not_found` | 网卡「{nic}」不在服务器最近上报的网卡列表中 | nic, interfaces |
| `server.nic_address_unavailable` | 无法按网卡下发该服务器（未上报 / 网卡不存在 / 没有可用地址） | — |
| `agent.upgrade.version_unavailable` | 无法获取最新版本，请显式指定 version | — |
| `agent.upgrade.version_invalid` | 版本号格式不合法：{version} | version |
| `agent.upgrade.disabled` | 该服务器未开启 Agent 自升级，请先开启 | — |
| `agent.upgrade.arch_unsupported` | 不支持的 CPU 架构：{arch} | arch |
| `agent.upgrade.current_unknown` | 服务器尚未上报 Agent 版本，无法判断升级方向 | — |
| `agent.upgrade.not_newer` | 目标版本 {target} 必须比当前版本 {current} 新 | current, target |
| `agent.upgrade.in_progress` | 该服务器已有进行中的升级（{current} → {target}） | current, target |
| `upgrade_batch.not_found` | 批次不存在 | — |
| `upgrade_batch.too_many_servers` | 一个批次最多 {max} 台服务器（当前 {count} 台） | count, max |
| `upgrade_batch.empty_server_id` | server_ids 里不能有空值 | — |
| `upgrade_batch.no_servers` | server_ids 不能为空 | — |
| `upgrade_batch.servers_not_found` | 以下服务器不存在：{server_ids} | server_ids |
| `upgrade_batch.servers_disabled` | 以下服务器未开启 Agent 自升级：{servers} | servers |
| `upgrade_batch.server_busy` | 以下服务器已在进行中的批次里：{servers} | servers |
| `upgrade_batch.not_running` | 批次已结束（{status}），无法取消 | status |
| `node.not_found` | 节点不存在 | — |
| `node.name_required` | 节点名称不能为空 | — |
| `node.name_too_long` | 节点名称最多 {max} 个字符 | max |
| `node.port_invalid` | 端口必须在 {min}-{max} 之间 | max, min |
| `node.port_not_allowed` | 端口 {port} 不在服务器「{server}」允许的范围内 | port, server |
| `node.public_port_invalid` | 对外端口必须在 {min}-{max} 之间 | max, min |
| `node.public_port_conflict` | 对外端口 {public_port} 已被服务器「{server_name}」上的节点「{node_name}」占用 | address, node_id, node_name, node_tag, public_port, server_id, server_name |
| `node.tag_too_long` | tag 不能超过 {max} 个字符 | max |
| `node.tag_conflict` | 该服务器下已存在相同的 tag | — |
| `node.config_invalid` | config 必须是 JSON 对象 | — |
| `node.ss_method_invalid` | 不支持的 Shadowsocks 加密方法：{method} | allowed, method |
| `node.ss_key_invalid` | Shadowsocks 密钥不合法：{method} | actual_bytes, expected_bytes, method, min_chars |
| `node.ss_network_invalid` | 不支持的 Shadowsocks 网络类型：{network} | allowed, network |
| `node.cert_required` | TLS 节点必须绑定证书 | — |
| `node.cert_tls_only` | 只有 TLS 节点才能绑定证书 | — |
| `node.cert_not_found` | 绑定的证书不存在 | — |
| `node.cert_id_invalid` | 证书 id 不合法 | — |
| `forward.not_found` | 转发规则不存在 | — |
| `forward.name_required` | 转发名称不能为空 | — |
| `forward.name_too_long` | 转发名称最多 {max} 个字符 | max |
| `forward.listen_port_invalid` | 监听端口必须在 {min}-{max} 之间 | max, min |
| `forward.target_port_invalid` | 目标端口必须在 {min}-{max} 之间 | max, min |
| `forward.target_host_required` | 目标地址不能为空 | — |
| `forward.target_host_too_long` | 目标地址最多 {max} 个字符 | max |
| `forward.port_reserved` | 端口 {port} 是保留端口（API 10085 / SSH 22），不能用于转发 | port |
| `forward.port_conflict_node` | 监听端口 {port} 与节点「{node}」的端口冲突 | node, port |
| `forward.port_conflict_forward` | 监听端口 {port} 已被转发规则「{name}」占用 | name, port |
| `certificate.not_found` | 证书不存在 | — |
| `certificate.name_required` | 证书名称不能为空 | — |
| `certificate.name_too_long` | 证书名称最多 {max} 个字符 | max |
| `certificate.invalid` | 证书或私钥无法解析，或两者不匹配 | — |
| `certificate.in_use` | 该证书被 {nodes} 个节点、{chains} 条链引用，无法删除 | references, nodes, chains |
| `package.not_found` | 套餐不存在 | — |
| `package.name_required` | 套餐名称不能为空 | — |
| `package.quota_negative` | 额度不能为负数 | — |
| `package.period_days_invalid` | 周期天数必须在 {min}-{max} 之间 | max, min |
| `package.reset_day_invalid` | 重置日必须在 {min}-{max} 之间 | max, min |
| `package.node_ratio_invalid` | 节点倍率必须大于 0 且不超过 {max} | max |
| `package.node_scope_invalid` | 节点 id 不能为空 | — |
| `package.node_not_found` | 节点不存在：{node_ids} | node_ids |
| `package.in_use` | 该套餐还有 {references} 个用户在用，无法删除 | references |
| `package_instance.batch_renew_days_invalid` | 续期天数必须在 {min}-{max} 天之间 | max, min |
| `rule_template.not_found` | 规则模板不存在 | — |
| `rule_template.reference_not_found` | 引用的规则模板不存在 | — |
| `rule_template.name_required` | 规则模板名称不能为空 | — |
| `rule_template.name_taken` | 规则模板名称已存在 | — |
| `rule_template.rules_empty` | 规则不能为空，至少需要一条以 MATCH 开头的兜底规则 | — |
| `rule_template.rule_empty` | 第 {index} 条规则不能为空 | index |
| `rule_template.rule_too_long` | 第 {index} 条规则超过 {max} 个字符 | index, max |
| `rule_template.last_rule_must_be_match` | 最后一条规则必须以大写 MATCH 开头 | — |
| `rule_template.default_undeletable` | 默认规则模板不能删除，请先把其它模板设为默认 | — |
| `subscribe.not_found` | 订阅不存在 | — |
| `subscribe.format_unsupported` | 不支持的订阅格式：{target} | target |
| `outbound.not_found` | 出站不存在 | — |
| `outbound.tag_conflict` | 该服务器下已存在相同的出站 tag | — |
| `outbound.in_use` | 该出站被 {references} 条路由规则引用，无法修改 | references |
| `outbound.tag_invalid` | 出站 tag 不合法：{tag} | tag |
| `outbound.tag_reserved` | tag「{tag}」是保留字，请换一个 | tag |
| `outbound.protocol_invalid` | 不支持的出站协议：{protocol} | protocol |
| `outbound.config_invalid` | config 必须是 JSON 对象 | — |
| `routing_rule.not_found` | 路由规则不存在 | — |
| `routing_rule.outbound_tag_required` | outbound_tag 不能为空 | — |
| `routing_rule.outbound_not_found` | 出站 tag「{tag}」不存在 | tag |
| `routing_rule.inbound_not_found` | 入站节点 tag「{tag}」不存在 | tag |
| `routing_rule.match_required` | 路由规则至少要填写入站、域名、IP 中的一项 | — |
| `backup.restore_no_pending` | 没有待恢复的备份 | — |
| `backup.in_memory_unsupported` | 当前数据库是内存库，不支持备份与恢复 | — |
| `backup.restore_bad_header` | 备份文件不是有效的 SQLite 数据库 | — |
| `backup.restore_missing_tables` | 备份缺少必需的表 | — |
| `backup.restore_migration_too_new` | 备份的迁移版本 {version} 高于当前程序支持的 {supported} | supported, version |
| `backup.restore_too_large` | 备份文件超过 {max_mb} MB 上限 | max_mb |
| `backup.restore_invalid` | 备份文件校验失败 | — |
| `backup.restore_bad_gzip` | gzip 解压失败 | — |
| `backup.restore_read_failed` | 读取上传内容失败 | — |
| `release.key_length_invalid` | 密钥长度必须是 32 字节 | actual, expected |
| `release.public_key_invalid` | 公钥格式不合法 | — |
| `release.signature_length_invalid` | 签名长度不合法 | actual, expected |
| `release.signature_invalid` | 清单签名校验失败：产物可能被篡改，或公钥不匹配 | — |
| `release.asset_missing` | 清单里没有 {asset} | asset |
| `release.checksum_mismatch` | {asset} 的 sha256 不匹配：期望 {expected}，实际 {actual} | actual, asset, expected |
| `install.token_required` | 缺少 token 参数 | — |
| `install.token_not_found` | token 无效 | — |
| `install.filename_invalid` | 非法的文件名 | — |
| `install.file_not_found` | 文件不存在 | — |
| `install.release_not_found` | 发布版本不存在 | — |
| `install.release_unavailable` | 主控回源失败且本地没有缓存：{file}（{version}） | file, version |
| `stats.days_invalid` | days 必须在 {min}-{max} 之间 | max, min |
| `stats.top_invalid` | top 必须在 {min}-{max} 之间 | max, min |
| `settings.body_not_object` | 请求体必须是 JSON 对象 | — |
| `settings.unknown_key` | 未知的设置项：{key} | key |
| `settings.panel_name_invalid` | 面板名称必须是字符串 | — |
| `settings.panel_name_length_invalid` | 面板名称长度必须在 {min}-{max} 个字符之间 | max, min |
| `settings.int_out_of_range` | {label}需在 {min}-{max} 之间的整数 | label, max, min |
| `forward.self_loop` | 目标指向本机同一端口 {port}，会形成自连回环 | port |
| `forward.engine_invalid` | 转发引擎「{engine}」无效，只支持 native / realm / nftables | allowed, engine |
| `forward.nftables_unavailable` | 服务器「{server_name}」没有可用的 nftables（需要安装 nft 并以 root 运行） | available, server_id, server_name |
| `chain.nftables_unavailable` | 以下服务器的 nftables 不可用（需要安装 nft 并以 root 运行）：{servers} | servers |
| `chain.nftables_multi_target` | nftables 引擎暂不支持第 {seq} 组的多成员选路，请改成单成员组 | count, seq |
| `chain.not_found` | 链不存在 | — |
| `chain.latency_hours_invalid` | hours 必须是 1-168 之间的整数（默认 24） | min, max |
| `chain.name_required` | 链名称不能为空 | — |
| `chain.name_too_long` | 链名称最多 {max} 个字符 | max |
| `chain.hop_count_invalid` | 链必须包含 {min}-{max} 跳（当前 {count} 跳） | count, max, min |
| `chain.duplicate_server` | 同一台服务器（{server_id}）不能在一跳链里出现两次 | server_id |
| `chain.port_conflict_hop` | 监听端口 {port} 已被服务器「{server_name}」上的链「{name}」第 {seq} 跳占用 | chain_id, name, port, seq, server_name |
| `chain.port_not_allowed` | 端口 {port} 不在服务器「{server}」允许的范围内 | port, server |
| `chain.port_allowed_exhausted` | 服务器「{server}」允许的端口都已占用；请先释放端口，或为该跳手动填写允许范围内的端口 | server, server_id |
| `chain.internal_address_missing` | 服务器「{server}」还没有填写内网地址，无法使用内网地址转发 | server |

## 转发链端口自动分配（中英对照）/ Automatic chain port allocation

中间组（seq ≥ 1）可以省略监听端口：主控为每台服务器挑最小空闲端口，保存时落成
具体值；入口组（seq 0）仍然必须显式填写。服务器**没有**配置允许端口集合时沿用
固定池 `20000..=29999`；配置了集合（见下节）时只在集合内挑，耗尽直接 400。
已占用集合 = 该服务器上的 `forwards.listen_port`、`nodes.port`、其它链的成员端口。

Intermediate groups (seq ≥ 1) may omit their listen port: the master picks the
lowest free port for each server and persists the concrete value on save. The
entry group (seq 0) must still provide one. Servers **without** a port policy keep
the fixed `20000..=29999` pool; with a policy, allocation only picks ports inside
the allowed set and exhausts with a hard 400. Occupied = `forwards.listen_port`,
`nodes.port`, and members of other chains on the same server.

| code | 中文 | English | params |
|---|---|---|---|
| `chain.entry_port_required` | 入口组（第 1 组）必须填写监听端口 | The entry group (group 1) must provide a listen port | — |
| `chain.public_port_invalid` | 对外端口必须在 {min}-{max} 之间 | Public port must be between {min} and {max} | max, min |
| `chain.port_pool_exhausted` | 服务器（{server_id}）的自动分配端口池 {pool_start}-{pool_end} 已耗尽；请先释放端口，或为这一跳手动填写端口 | The automatic port pool {pool_start}-{pool_end} on server {server_id} is exhausted; free a port or provide one manually | pool_end, pool_start, server_id |
| `chain.port_allowed_exhausted` | 服务器「{server}」允许的端口都已占用；请先释放端口，或为该跳手动填写允许范围内的端口 | Every port allowed on server "{server}" is in use; free one or provide an allowed port manually | server, server_id |

池范围常量在 `crates/domain/src/chains.rs`（`PORT_POOL_START` / `PORT_POOL_END`）；
同一台服务器按「最小空闲」选择，池耗尽直接 400，不会换范围或随机挑端口。
The pool bounds live in `crates/domain/src/chains.rs`; allocation is "lowest free"
per server, and exhaustion is a hard 400 — never a silent range switch or random pick.

## Shadowsocks 节点校验（中英对照）

新增的三个 SS 错误码需要同时提供英文文案。`web/src/i18n/{zh-CN,en}.ts` 的 `errors.*`
由 Web lane 同步补齐；在补齐之前，英文界面会回落到后端返回的中文兜底。

The three Shadowsocks codes below are bilingual. The `errors.*` entries in
`web/src/i18n/{zh-CN,en}.ts` are owned by the Web lane; until they land, the English UI
falls back to the Chinese message returned by the backend.

| code | 中文 | English | params |
|---|---|---|---|
| `node.ss_method_invalid` | 不支持的 Shadowsocks 加密方法：{method}（可选：{allowed}） | Unsupported Shadowsocks method: {method} (allowed: {allowed}) | allowed, method |
| `node.ss_key_invalid` | Shadowsocks 密钥不合法：{method} 要求 {expected_bytes} 字节的 base64 密钥（实际 {actual_bytes} 字节）；旧 AEAD 密码至少 {min_chars} 个字符 | Invalid Shadowsocks key for {method}: a {expected_bytes}-byte base64 key is required (got {actual_bytes} bytes); legacy AEAD passwords need at least {min_chars} characters | actual_bytes, expected_bytes, method, min_chars（按分支出现 / per branch） |
| `node.ss_network_invalid` | 不支持的 Shadowsocks 网络类型：{network}（可选：tcp / udp / tcp,udp） | Unsupported Shadowsocks network: {network} (allowed: tcp / udp / tcp,udp) | allowed, network |

规则（代码见 `crates/domain/src/xray.rs`）：

| method | 密钥要求 / Key requirement | 失败码 / Error code |
|---|---|---|
| `2022-blake3-aes-128-gcm` | base64，解码后 16 字节 / base64, 16 bytes | `node.ss_key_invalid` |
| `2022-blake3-aes-256-gcm` | base64，解码后 32 字节 / base64, 32 bytes | `node.ss_key_invalid` |
| `2022-blake3-chacha20-poly1305` | base64，解码后 32 字节 / base64, 32 bytes | `node.ss_key_invalid` |
| `aes-256-gcm` / `aes-128-gcm` / `chacha20-poly1305` / `xchacha20-poly1305` | 至少 8 个字符 / at least 8 characters | `node.ss_key_invalid` |
| 其它 / anything else | 不在白名单 / not in the whitelist | `node.ss_method_invalid` |

`settings.network` 只允许 `tcp` / `udp` / `tcp,udp`（缺省 = `tcp`），否则
`node.ss_network_invalid`。SS2022 多用户：inbound 写 `method`，每个 user 只写
base64 密钥、**不带** `method`；旧 AEAD 多用户：每个 user 带自己的 `method`。

### SS2022 的两个硬约束

- **每用户密钥长度必须随方法**：AES-128 是 16 字节，AES-256 / ChaCha20 是 32 字节。
  Xray 会按方法的 `KeySaltLength` 校验每个 user 的 `password`，长度不符会**拒绝加载
  整份配置**（不是只让这个用户连不上）。面板派生时会按方法截断，不需要管理员关心。
- **多用户只支持 AES**：Xray 的 SS2022 多用户实现只支持 `2022-blake3-aes-*`；
  `2022-blake3-chacha20-poly1305` 一旦带 `clients` 会让整份配置加载失败。因此该方法的节点
  在有授权用户时会被跳过（apply 返回 warning、订阅里也不出现），改用 AES 方法即可。
- 密钥输入接受标准 / URL-safe base64、带不带 padding、多余 `=`；落盘配置与订阅统一写成
  标准 base64，避免「校验通过、客户端却连不上」。

> **Two hard constraints for SS2022.** (1) The per-user key length must match the method:
> 16 bytes for AES-128, 32 bytes for AES-256 / ChaCha20. Xray validates every user key against
> the method's `KeySaltLength` and refuses to load the whole config on a mismatch. (2) Xray's
> SS2022 multi-user mode only supports `2022-blake3-aes-*`. A `2022-blake3-chacha20-poly1305`
> node that has granted users is skipped (apply warning, absent from the subscription); use an
> AES method instead. Keys may be standard or URL-safe base64, with or without padding and any
> trailing `=`; the config and the subscription are always written in canonical standard base64.

### 跳间 TLS（P15.3）/ Hop-to-hop TLS

链的加密模式只有 `none`（默认明文）与 `tls`（realm 单向 TLS）。以下错误全部是
**fail closed**：保存时拒绝，或下发时整条链跳过——绝不回退明文。

| code | 中文 | English | params |
|---|---|---|---|
| `chain.transport_invalid` | 链的加密模式「{transport}」无效，只支持 none / tls | Invalid chain transport "{transport}"; expected none / tls | allowed, transport |
| `chain.tls_requires_realm` | 只有 realm 引擎的链才能启用跳间加密 | Hop-to-hop TLS requires the realm engine | — |
| `chain.tls_requires_two_hops` | 至少两跳的链才有跳间链路 | Hop-to-hop TLS needs at least two groups | — |
| `chain.tls_udp_unsupported` | 加密链不支持 UDP，请关闭该链的 UDP | Encrypted chains do not support UDP; disable UDP on this chain | — |
| `chain.tls_group_cert_required` | 第 {seq} 组缺少证书 | Group {seq} has no certificate | seq |
| `chain.tls_group_cert_forbidden` | 入口组不需要证书：入口监听始终是明文 | The entry group must not have a certificate; its listener stays plaintext | — |
| `chain.tls_cert_not_found` | 第 {seq} 组引用的证书不存在 | The certificate referenced by group {seq} does not exist | cert_id, seq |
| `chain.tls_cert_invalid` | 证书「{name}」或它的私钥无法解析 / 私钥已加密 | Certificate "{name}" or its private key cannot be parsed, or the key is encrypted | name |
| `chain.tls_cert_key_mismatch` | 证书「{name}」与私钥不匹配 | Certificate "{name}" does not match its private key | name |
| `chain.tls_cert_expired` | 证书「{name}」已过期（到期时间 {not_after}） | Certificate "{name}" expired at {not_after} | name, not_after |
| `chain.tls_cert_no_dns_san` | 证书「{name}」没有 DNS SAN，不能用于跳间 TLS | Certificate "{name}" has no DNS SAN and cannot be used for hop TLS | name |
| `chain.tls_cert_wildcard_only` | 证书「{name}」只有通配符 SAN，不能直接作为 SNI，请改用具体域名 | Certificate "{name}" only has wildcard SANs; a concrete hostname is required as SNI | domains, name |
| `chain.tls_cert_domain_invalid` | 域名「{domain}」不在证书「{name}」的 SAN 中 | Domain "{domain}" is not covered by certificate "{name}" | domain, name |
| `chain.tls_sni_invalid` | SNI「{sni}」不是合法的 DNS 域名（不能是 IP） | SNI "{sni}" is not a valid DNS name (IP literals are rejected) | sni |
| `chain.tls_transport_invalid` | 证书路径「{value}」不合法（只允许字母、数字与 / . _ -） | Invalid certificate path "{value}" (allowed: letters, digits and / . _ -) | value |
| `chain.tls_realm_unsupported` | 以下服务器的 realm 未启用 transport（需要升级 Agent / 换官方 realm）：{servers} | These servers run a realm without the transport feature (upgrade the agent or use the official realm): {servers} | servers |

**下发时**：`chain.tls_realm_unsupported` / 证书类失败会让整条链不进 forwards，
apply 结果的 `warnings` 里出现「链『X』未下发：…」，链视图的 `blocked_code` /
`blocked_reason` 同步展示。Agent 侧最后一道门禁：如果期望态里出现 transport，
但本机 `realm --version` 不含 `[transport]`，Agent **拒绝渲染并报错**
（状态文案「realm 不支持跳间加密」），不会写出明文配置。

> The master removes the whole chain from `forwards` and surfaces the reason in apply
> `warnings` plus `blocked_code`/`blocked_reason`; the agent refuses to render a config at all
> when its own `realm --version` lacks `[transport]`. In both cases there is no plaintext fallback.

前端 i18n 键（`errors.chain.*`）需由前端 lane 按上表补齐；本轮后端只保证
`code`/`params` 稳定与中文兜底。 / Frontend i18n keys (`errors.chain.*`) are added by the web
lane; this backend change guarantees stable `code`/`params` plus the Chinese fallback.

### 隧道安全模式（P16）/ Tunnel security mode

`engine = tunnel` 的链额外有一个安全模式：`tls`（默认，主控自有 CA 签发证书）或
`noise`（Noise/PSK，无证书，只共享 `hop_secret`）。该字段只对 tunnel 引擎有意义，
与 realm 的 `transport`（`none` / `tls`）是两个独立维度。

| code | 中文 | English | params |
|---|---|---|---|
| `chain.tunnel_security_invalid` | 隧道安全模式「{tunnel_security}」无效，只支持 tls / noise | Invalid tunnel security "{tunnel_security}"; expected tls / noise | allowed, tunnel_security |

写路径（POST/PATCH）严格校验，非法值返回 400 且不落库；读路径遇到未知值回落 `tls`，
与迁移 0038 的默认值一致。Noise 模式下发时 `TunnelSpec.security = noise`，三个证书路径
为空串，`DesiredState.files` 里没有该链的证书文件。

> A tunnel chain has its own security mode: `tls` (default, master-owned CA) or `noise`
> (Noise/PSK, no certificates, only a shared `hop_secret`). It is independent of realm's
> `transport`. Invalid values are rejected with 400 on write and fall back to `tls` on read;
> Noise dispatches an empty certificate-path set and no tunnel files.

### 隧道 UDP 中继（P16.3 / P16.5）/ Tunnel UDP relay

`engine = tunnel` 且链的 `protocol = udp / both` 时，两端在同一个端口号上起
QUIC datagram 中继（`TunnelSpec.udp = true`）。QUIC 固定走 TLS 1.3，两种安全
模式的证书来源不同：

* `tls`：主控 CA 签发的属证书，客户端用显式 CA 校验；
* `noise`（协议 25 起）：两端由 `hop_secret` 确定性派生同一张 ed25519 自签
  证书，客户端固定其 SHA-256 指纹（无 CA、无额外材料交换、无 insecure 开关）。

Noise + UDP 要求两端 Agent 协议版本 ≥ 25（旧 Agent 会拒绝该组合并让端点启动
失败）。保存与下发两条路径都会检查，绝不悄悄关掉 UDP、降级成 TLS 或明文。
`chain.tunnel_udp_requires_tls` 是历史错误码（§8.5 之前用于拒绝 noise + udp），
现在不再产生，保留在此仅供旧日志/旧前端识别。

| code | 中文 | English | params |
|---|---|---|---|
| `chain.tunnel_noise_udp_requires_upgrade` | Noise 模式的 UDP 中继需要每台服务器的 Agent 协议版本 ≥ {required}（旧 Agent 无法在 QUIC 上完成 PSK 认证）：{server} | The Noise-mode UDP relay requires agent protocol >= {required} (older agents cannot authenticate over QUIC): {server} | servers, required, protocol, tunnel_security |

`POST/PATCH /api/v1/chains` 返回 400 + 该 code；已存在的链如果被手工改成
noise + udp 且成员版本过旧，下发时整链跳过并给出同一个 `blocked_code`。

> With `engine = tunnel` and `protocol = udp / both`, both hops run a QUIC
> datagram relay on the same port number (`TunnelSpec.udp = true`). QUIC always
> uses TLS 1.3; `tls` chains use the master-owned CA, while `noise` chains
> (protocol 25+) derive a self-signed ed25519 certificate from `hop_secret` on
> both ends and pin its SHA-256 fingerprint — no CA, no extra material, and no
> insecure switch. Noise + UDP requires every member agent to be protocol >= 25;
> the write and dispatch paths both enforce it instead of silently dropping UDP
> or downgrading to TLS/plaintext. `chain.tunnel_udp_requires_tls` is a retired
> code (used before §8.5); it is kept here only so old logs/frontends can still
> recognise it.

### 转发协议模式（P15.4）/ Forward protocol mode

转发与链的 `protocol` 只有 `tcp`（默认）/ `udp` / `both` 三种取值。写路径严格校验，
读路径对历史脏数据回落 `tcp`（不会凭空多开 UDP 端口）。旧的 `udp` 布尔位只作为
迁移 `0034` 的来源，以及旧客户端/旧 Agent 的兼容镜像。

| code | 中文 | English | params |
|---|---|---|---|
| `forward.protocol_invalid` | 转发协议「{protocol}」无效，只支持 tcp / udp / both | Invalid forward protocol "{protocol}"; expected tcp / udp / both | allowed, protocol |
| `chain.protocol_invalid` | 链的转发协议「{protocol}」无效，只支持 tcp / udp / both | Invalid chain protocol "{protocol}"; expected tcp / udp / both | allowed, protocol |
| `forward.protocol_udp_requires_native` | realm 引擎固定同时转发 TCP 与 UDP，不支持仅 UDP；请改用 native 或 nftables 引擎 | The realm engine always forwards both TCP and UDP; use the native or nftables engine for UDP-only | engine, feature, protocol |
| `chain.protocol_udp_with_tls` | 加密链只走 TCP，不能选择仅 UDP | Encrypted chains are TCP-only; UDP-only is not supported | protocol, transport |
| `forward.protocol_requires_agent_upgrade` | 服务器「{server}」的 Agent 版本过旧（协议版本 {version}，需要 ≥ {required}），仅 UDP 转发需要先升级 Agent | Server "{server}" runs an agent that is too old for UDP-only forwarding (protocol {version}, requires >= {required}); upgrade the agent first | protocol, required, server, version |
| `chain.protocol_requires_agent_upgrade` | 以下服务器的 Agent 版本过旧（需要协议版本 ≥ {required}），无法使用仅 UDP 链：{server} | The following servers run agents too old for a UDP-only chain (protocol >= {required} required): {server} | protocol, required, server, servers |

行为矩阵（写路径）/ Behaviour matrix (write path):

| 场景 / Case | 结果 / Result |
|---|---|
| `protocol` 不在白名单 | `forward.protocol_invalid` / `chain.protocol_invalid` |
| `protocol = udp` 且 `engine = realm` | `forward.protocol_udp_requires_native`（转发与链共用） |
| `protocol = udp` 且链 `transport = tls` | `chain.protocol_udp_with_tls` |
| `protocol = both` 且链 `transport = tls` | `chain.tls_udp_unsupported`（UDP 不走 transport） |
| `protocol = udp` 且成员 Agent 协议未知（NULL）或 < 16 | `forward.protocol_requires_agent_upgrade` / `chain.protocol_requires_agent_upgrade` |
| `protocol = tcp / both` 且旧 Agent | 照常保存与下发（旧 Agent 能正确理解） |
| 只传旧字段 `udp = true` | 归一化为 `protocol = both`（旧客户端兼容） |
| 只传旧字段 `udp = false` | 归一化为 `protocol = tcp` |

#### 仅 UDP 的旧 Agent 门禁 / UDP-only agent gate

`protocol = udp` 从协议 16（v0.8.0）开始支持。旧 Agent 会忽略该字段，按旧的
`udp` 镜像位只监听 TCP——面板看起来规则已下发，实际一条监听都没有。因此主控
在两条路径上 fail closed：

1. **保存**：`POST/PATCH` 的最终协议是 `udp` 时，目标服务器（链为每一跳）的
   `servers.protocol_version` 必须 `>= 16`；未知（NULL，旧 Agent / 从未连过）
   与 15 一律 400，`params` 带 `server` 与 `required`（16）。
2. **下发**：已保存的历史 `udp` 规则遇到旧 Agent 时**不下发**并给 warning，
   转发列表给出 `blocked_code` / `blocked_reason`，链列表同样显示 blocked；
   绝不降级成 TCP，等 Agent 升级后自动恢复。

`tcp` / `both` 不受影响。心跳把 Agent 编译期的协议版本写入
`servers.protocol_version`；旧 Agent 缺省 `0` 不会覆盖已经上报过的值。
迁移 `0043_server_protocol_version.sql` 只追加列，历史行保持 NULL。

> `protocol = udp` has been supported since protocol 16 (v0.8.0). Old agents
> ignore the field and only listen on TCP via the legacy `udp` mirror bit, so
> the panel looks configured while nothing is listening. The master fails
> closed on both paths: saving UDP-only requires the target server (every hop
> for chains) to report `protocol_version >= 16`, and historical UDP-only rules
> are skipped (with a warning / `blocked_reason`) instead of being degraded to
> TCP. `tcp` / `both` are unaffected; a legacy heartbeat with `0` never
> overwrites a previously reported version.

迁移 `0034_forward_protocol.sql`：`udp = 1 → both`，`udp = 0 → tcp`；`udp` 列保留，
但读写行为只认 `protocol`。Agent 侧：native 按所选协议绑定（仅 UDP 时完全不绑 TCP）；
nftables 只为所选协议生成 DNAT 规则；realm 的 `both` 写 `use_udp = true`，`tcp` 写
`use_udp = false` 并给端点加 `network = { use_udp = false }`。

### 链路延迟历史与每跳流量 / Chain latency history and per-hop traffic

`GET /api/v1/chains/{id}/latency?hours=24` 只返回 **跳与跳之间** 的成功探测：

| 字段 / Field | 含义 / Meaning |
|---|---|
| `ts` | 5 分钟桶的起点（Unix 秒）/ start of the 5-minute bucket (Unix seconds) |
| `seq` | **被探测的跳**（目标成员所在组的 seq）；入口组没有上一跳，不会有点 / the probed hop; the entry group has no previous hop |
| `server_id` | 被探测的成员；该桶有多个成员时，取中位数样本所属的成员 / the probed member; for a multi-member bucket, the member whose sample is the median |
| `latency_ms` | 该桶所有成员样本的中位数（偶数个取较低的中位数）/ median of all member samples in the bucket (lower median on ties) |

- `hours` 缺省 24，范围 1..168，非法值返回 400 `chain.latency_hours_invalid`；空数据返回
  `{"points":[]}`（不是 404/500）。
- 最后一跳 → 链目标的 RTT 不属于服务器间链路，不进入历史；它仍通过成员的
  `target_latency_ms` 实时展示。
- 样本保留 7 天；写入时顺带删除更早的行。同一 `(forward_id, target_server_id)` 30 秒内
  重复心跳只更新一行，因此一行/目标/30 秒是上限。
- 成员新增 `last_seen_at`（ISO8601 UTC 字符串，来自 `servers.last_seen_at`，从未心跳为
  `null`）与 `traffic_in` / `traffic_out`（累计字节）。**`null` 表示没有数据源，绝不等于 0**。

> The endpoint returns only successful hop-to-hop probes, bucketed into 5 minutes and aggregated
> with the median across members of the same hop. `hours` defaults to 24 and accepts 1..168;
> invalid values return 400 `chain.latency_hours_invalid`; no data returns `{"points":[]}`.
> The last-hop → chain-target RTT is not a server-to-server link and stays out of history (it is
> still exposed as `target_latency_ms`). Samples are retained for 7 days and purged on write; a
> repeat heartbeat within 30 seconds updates the existing row for the same
> `(forward_id, target_server_id)`. Members expose `last_seen_at` (ISO8601 UTC, null when the
> server has never checked in) and cumulative `traffic_in`/`traffic_out`; `null` means "no data
> source", never 0.

流量数据源 / Traffic data sources:

| 引擎 / Engine | `traffic_in` | `traffic_out` | 说明 / Notes |
|---|---|---|---|
| native | ✅ 累计字节 | ✅ 累计字节 | `copy_bidirectional` 双向计数；UDP-only 为 `null`；`both` 规则只统计 TCP 一半，UDP 数据报不计入 / counted in the TCP accept path; UDP-only is null; for `both` only the TCP half is counted |
| nftables | ✅ DNAT counter | `null` | 内核 counter 只看客户端 → 目标方向；表重建后从 0 重新累计 / kernel counters only see the DNAT direction and reset when the table is rebuilt |
| realm | `null` | `null` | realm 没有字节计数 API，不编造数据 / realm exposes no byte counters; nothing is fabricated |

### 服务器分组 / Server groups

`servers.group_name` 是纯展示字段（迁移 `0039`），不参与鉴权或期望态下发。
写路径规则：先去首尾空白；空串 → `NULL`（未分组）；最长 32 个字符；拒绝换行、
制表符等控制字符。`PATCH /api/v1/servers/{id}` 不传该字段表示「不改」，
传空串表示「清空」。

> `servers.group_name` is presentation-only (migration `0039`) and never affects auth or
> desired-state dispatch. The write path trims surrounding whitespace, turns an empty string into
> `NULL` (ungrouped), limits names to 32 characters, and rejects control characters such as
> newlines and tabs. Omitting the field on `PATCH /api/v1/servers/{id}` means "leave unchanged";
> an empty string means "clear".

公开状态页的 `groups` 中具名分组按名称升序，未分组（`name: null`）固定最后；
`uptime_24h` 是组内各服务器 24h 可用率的算术平均，组内没有采样时为 `null`。

> On the public status page, named groups in `groups` are sorted by name and ungrouped servers (`name: null`) come last.
> `uptime_24h` is the arithmetic mean of the member servers' 24h uptimes; it is `null` when the
> group has no samples, never `0`.

## 对外端口（NAT）/ Public-facing port (NAT)

`nodes.public_port` 与 `chain_groups.public_port` 都**只影响展示与订阅**，不改变监听：
Agent 仍然只按 `nodes.port` / `chain_group_members.listen_port` 监听。列为 `NULL` 时
行为与引入该字段前完全一致（订阅逐字节不变、链入口显示监听端口）。

| code | 中文 | English | params |
|---|---|---|---|
| `node.public_port_invalid` | 对外端口必须在 {min}-{max} 之间 | Public port must be between {min} and {max} | max, min |
| `node.public_port_conflict` | 对外端口 {public_port} 已被服务器「{server_name}」上的节点「{node_name}」占用 | Public port {public_port} is already used by node "{node_name}" on server "{server_name}" | address, node_id, node_name, node_tag, public_port, server_id, server_name |
| `chain.public_port_invalid` | 对外端口必须在 {min}-{max} 之间 | Public port must be between {min} and {max} | max, min |

- 取值必须在 `1..=65535`，否则 400 `node.public_port_invalid` / `chain.public_port_invalid`；
- 同一 `servers.address` 上，两个节点不能拥有相同的**显式** `public_port`，否则 400
  `node.public_port_conflict`，`params.server_name` 是冲突节点所属服务器名；
- `NULL` 表示「与本机监听端口相同」，属于各自主机的端口空间，本轮不与其它节点的
  显式对外端口比较；
- `chain_groups.public_port` 只对入口组（`seq = 0`）有意义，其它组传了也会被忽略。

> `nodes.public_port` and `chain_groups.public_port` are **presentation/subscription only**;
> the Agent keeps listening on `nodes.port` / `chain_group_members.listen_port`. A `NULL`
> column preserves the exact old behaviour (byte-identical subscriptions and the entry port
> shown as before). Values must be `1..=65535` (`node.public_port_invalid` /
> `chain.public_port_invalid`). On the same `servers.address`, two nodes may not share the
> same **explicit** `public_port` (`node.public_port_conflict`; `params.server_name` names the
> conflicting server). `NULL` means "same as this host's listen port" and is not compared
> across hosts. Only the entry group (`seq = 0`) uses `chain_groups.public_port`.

## 服务器允许端口与内网地址（迁移 0041）/ Allowed ports and internal address (migration 0041)

`servers` 新增三列描述允许端口集合：`port_start` / `port_end`（闭区间）与
`port_allow_json`（区间之外额外允许的端口，JSON 数组文本，默认 `'[]'`）。
允许集合 = `[port_start, port_end] ∪ port_allow`；三者都为空 = **不限制**，与
迁移前完全一致。`servers.internal_address` 是跳间寻址可用的内网地址，`NULL` = 未填写。

Migration `0041` adds three columns describing the allowed-port set: `port_start` /
`port_end` (inclusive range) and `port_allow_json` (extra ports outside the range, a
JSON array, default `'[]'`). Allowed = `[port_start, port_end] ∪ port_allow`; all
empty means **unrestricted**, exactly as before. `servers.internal_address` is the
optional private address used for hop-to-hop addressing (`NULL` = not configured).

写路径 / Write path:

- `port_start` / `port_end` 必须**同时**填写或同时留空；值在 `1..=65535`；`start > end`
  一律 400 `server.port_range_invalid`；
- `port_allow` 的每一项必须在 `1..=65535`，否则 400 `server.port_allow_invalid`；
  服务端保存前会去重升序，响应里以数组 `port_allow` 返回；
- `PATCH /api/v1/servers/{id}` 对四个字段都是三态：缺省 = 不改、`null` = 清空、
  值 = 覆盖；`internal_address` 去首尾空白，空串按清空处理；
- 端口策略只约束**写路径**。收紧策略不会自动改写已有节点/链；只有下次重新选择端口
  （节点改端口、链手填或自动分配端口）时才会被新策略拦下。

- `port_start` / `port_end` must be provided **together** or omitted together, be within
  `1..=65535`, and `start > end` is 400 `server.port_range_invalid`.
- Every `port_allow` entry must be within `1..=65535` (400 `server.port_allow_invalid`);
  entries are deduped and sorted on save and returned as the `port_allow` array.
- On `PATCH /api/v1/servers/{id}` all four fields are tri-state: omitted = unchanged,
  `null` = clear, value = replace. `internal_address` is trimmed and an empty string clears it.
- The policy only constrains the **write path**. Tightening it never rewrites existing
  nodes/chains; they are rejected the next time a port is selected again (node port
  change, manual chain port, or automatic chain allocation).

三处执行点 / Three enforcement points:

1. 节点创建/修改：`nodes.port` 必须在允许集合内，否则 400 `node.port_not_allowed`
   （参数 `port`、`server`）；越界端口仍优先报旧码 `node.port_invalid`。
2. 链的自动端口分配：从该服务器的允许集合里挑最小空闲端口；集合耗尽 400
   `chain.port_allowed_exhausted`；未配置集合时仍是 `20000..=29999`（`chain.port_pool_exhausted`）。
3. 链的手填端口（入口与中间跳）：不在允许集合内 400 `chain.port_not_allowed`。

1. Node create/update: `nodes.port` must be allowed (`node.port_not_allowed`, params
   `port` / `server`); out-of-range values keep the older `node.port_invalid` code.
2. Automatic chain allocation: picks the lowest free port from the server's allowed set
   and fails with `chain.port_allowed_exhausted`; without a policy the legacy
   `20000..=29999` pool and `chain.port_pool_exhausted` are unchanged.
3. Manually entered chain ports (entry and intermediate hops): `chain.port_not_allowed`.

| code | 中文 | English | params |
|---|---|---|---|
| `server.port_range_invalid` | 端口范围不合法：起止必须同时填写、在 1-65535 之间，且起始不大于结束 | Invalid port range: start and end must be provided together, both within 1-65535, and start must not exceed end | end, max, min, start |
| `server.port_allow_invalid` | 额外允许的端口必须是 1-65535 的整数 | Additional allowed ports must be integers between 1 and 65535 | max, min, port |
| `node.port_not_allowed` | 端口 {port} 不在服务器「{server}」允许的范围内 | Port {port} is not allowed on server "{server}" | port, server |
| `chain.port_not_allowed` | 端口 {port} 不在服务器「{server}」允许的范围内 | Port {port} is not allowed on server "{server}" | port, server |
| `chain.port_allowed_exhausted` | 服务器「{server}」允许的端口都已占用；请先释放端口，或为该跳手动填写允许范围内的端口 | Every port allowed on server "{server}" is in use; free one or provide an allowed port manually | server, server_id |
| `chain.internal_address_missing` | 服务器「{server}」还没有填写内网地址，无法使用内网地址转发 | Server "{server}" has no internal address, so internal-address forwarding cannot be used | server |

### 跳间内网地址 / Hop-to-hop internal address

`chain_groups.use_internal_address INTEGER NOT NULL DEFAULT 0` 是**每组一个开关**
（迁移 0041）。语义：**该组被上一跳寻址时，使用该组成员的
`servers.internal_address` 替代公网 `address`**。因此校验对象是该组自己的成员：
任一成员没有内网地址 → 保存链 400 `chain.internal_address_missing`（参数
`server` / `server_id` / `seq`），不会静默回退公网。入口组（`seq = 0`）没有上一跳，
开关保存后不产生任何地址变化（前端可以禁用该开关）。默认 `false` 时下发结果与
升级前逐字节一致。

`chain_groups.use_internal_address INTEGER NOT NULL DEFAULT 0` is a **per-group**
switch (migration `0041`). Semantics: when the previous hop addresses this group, the
group members' `servers.internal_address` replaces their public `address`. Validation
therefore covers the group's own members: if any member has no internal address the
chain save fails with 400 `chain.internal_address_missing` (params `server` /
`server_id` / `seq`) instead of silently falling back to the public address. The entry
group (`seq = 0`) has no previous hop, so its switch has no routing effect after save
(the UI may disable it). With the default `false` the dispatched state is byte-identical
to before this change.

推导示例 / Derived target example (2 hops, group `seq = 1` has the switch on and its
member server has `internal_address = 10.9.0.2`):

```json
{
  "id": "chain-<chain_id>-0",
  "listen_port": 5101,
  "target_host": "10.9.0.2",
  "target_port": 5102,
  "targets": []
}
```

多成员组会把 `targets` 里每个成员的 `host` 都换成各自的内网地址 / For multi-member
groups every entry in `targets` uses that member's own internal address.

下发时的兜底 / Dispatch guard: if the internal address disappears later (manual DB
edit / cleared server field), the chain is treated as **blocked** (`blocked_reason` /
`chain.internal_address_missing`) and the desired state skips the whole chain — it is
never rendered with the public address.

## 网卡绑定（迁移 0042）/ NIC pinning (migration 0042)

`servers.nic_name TEXT NULL` 限定服务器从某块网卡出入流量（`NULL` = 不限制，旧行为）。
`servers.interfaces_json TEXT NOT NULL DEFAULT '[]'` 保存 Agent 最近一次心跳上报的
网卡列表（JSON 数组，地址不带 CIDR）。

Migration `0042` adds `servers.nic_name` (NULL = unrestricted, the old behaviour) and
`servers.interfaces_json` (the most recent agent-reported NIC list, a JSON array with
bare IPs, no CIDR).

写路径 / Write path:

- 创建与 `PATCH /api/v1/servers/{id}` 都接受 `nic_name`；`null` / 空串 = 不限制；
- 服务器最近上报过网卡列表（包括上报为空列表）→ `nic_name` 必须命中，否则 400
  `server.nic_name_not_found`（参数 `nic`、`interfaces`）；上报为空表示「当前没有
  可用网卡」，任何选择都不成立；
- 从未上报（新服务器 / 离线 / 旧 Agent）→ **允许保存**，响应里带
  `nic_unverified: true`，提示前端「网卡尚未验证」；
- 响应里的 `nic_unverified` 表示「该服务器**从未**上报过网卡」，与是否选择网卡无关：
  - 从未上报 → `interfaces: []`、`nic_unverified: true`（前端提示「尚未上报网卡」）；
  - 上报过但没有网卡 → `interfaces: []`、`nic_unverified: false`（前端显示无可用网卡）；
  - 上报过且有网卡 → `interfaces: [...]`、`nic_unverified: false`。
- 下发时期望态按网卡地址注入：每个节点入站 `listen` 从 `0.0.0.0` 改成网卡地址，
  每个出站写 `streamSettings.sockopt.sendThrough`；链路/隧道/转发的入口监听也
  换成网卡地址。网卡不存在或没有可用地址（只有 `0.0.0.0` / link-local）→
  400 `server.nic_address_unavailable`，**该服务器整台不下发**，绝不回退 `0.0.0.0`。
- `nic_name` 为 `NULL` 时不下发任何新字段，Xray 配置与升级前逐字节一致。

- `create` and `PATCH /api/v1/servers/{id}` accept `nic_name`; `null` / empty =
  unrestricted. Once the server has reported interfaces (including an empty list), the
  name must match (400 `server.nic_name_not_found`, params `nic` / `interfaces`); an
  empty report means "no usable NIC", so every selection is rejected.
- `nic_unverified` means the server has **never** reported interfaces, independent of
  whether a NIC is selected: never reported → `interfaces: []` +
  `nic_unverified: true`; reported but empty → `[]` + `false`; reported with NICs →
  `[...]` + `false`.
- Dispatch pins the server to that NIC: every node inbound `listen` changes from
  `0.0.0.0` to the NIC address, every outbound gets
  `streamSettings.sockopt.sendThrough`, and chain/tunnel/forward listeners use the NIC
  address too. A missing NIC or one without a usable address (only `0.0.0.0` /
  link-local) is 400 `server.nic_address_unavailable` and the whole server is **not
  dispatched**; there is no `0.0.0.0` fallback.
- With `nic_name` NULL no new field is emitted: the Xray config is byte-identical
  to before this change (covered by a golden test).

| code | 中文 | English | params |
|---|---|---|---|
| `server.nic_name_not_found` | 网卡「{nic}」不在服务器最近上报的网卡列表中 | NIC "{nic}" is not in the server's most recently reported interface list | interfaces, nic |
| `server.nic_address_unavailable` | 无法按网卡下发该服务器（未上报 / 网卡不存在 / 没有可用地址，不会回退 0.0.0.0） | The server cannot be dispatched with this NIC (not reported / missing / no usable address; no 0.0.0.0 fallback) | — |

## 概览页批量操作（中英对照）/ Overview batch actions

两个批量操作都要求管理员权限。`batch_renew` 只处理 `status = active` 且
`expires_at <= now` 的实例，新的到期时间从**当前时间**起算；`event.cleanup`
按 `created_at` 删除指定天数以前的记录，`days = null` 表示全部。

Both actions are admin-only. `batch_renew` only touches instances with
`status = active` and `expires_at <= now`, and the new expiry is based on **now**;
`event.cleanup` deletes records whose `created_at` is older than the given number
of days, and `days = null` means "all".

| code | 中文 | English | params |
|---|---|---|---|
| `package_instance.batch_renew_days_invalid` | 续期天数必须在 {min}-{max} 天之间 | Renewal days must be between {min} and {max} | max, min |
| `event.cleanup_days_invalid` | 清理天数必须在 {min}-{max} 天之间，或选择全部 | Cleanup days must be between {min} and {max}, or choose all | max, min |

接口 / Endpoints:

- `POST /api/v1/user-packages/batch-renew`，body `{ "days": 1..365 }`，返回 `{ "updated": n }`；
  审计动作 `package_instance.batch_renew`，detail `{ days, updated }`。
- `POST /api/v1/enforcement/events/cleanup`，body `{ "days": 1..3650 | null }`（缺省 = null = 全部），
  返回 `{ "deleted": n }`；审计动作 `event.cleanup`，detail `{ days, deleted }`。

## 用户自助转发（迁移 0044）/ User self-service forwarding

用户只能管理 `owner_user_id = 会话用户` 的转发。条数取**生效中套餐**的
`forward_limit` 最大值（无套餐 = 0，多套餐不累加）；目标服务器必须同时出现在
「`forward_limit > 0` 且生效中」的套餐 `package_forward_servers` 并集里。
监听端口由服务器端口策略自动分配，请求里带 `listen_port` 会被忽略。
端口池耗尽时复用链的分配错误码：不限制时是 `chain.port_pool_exhausted`，
有范围/白名单时是 `chain.port_allowed_exhausted`。

Users may only manage forwards whose `owner_user_id` equals the session user.
The quota is the **maximum** `forward_limit` among active packages (no package = 0;
multiple packages do not stack), and the target server must be in the union of the
`package_forward_servers` of active packages with `forward_limit > 0`. The listen
port is allocated by the server port policy and any client-supplied `listen_port`
is ignored. Port-pool exhaustion reuses the chain allocation codes:
`chain.port_pool_exhausted` without a policy, `chain.port_allowed_exhausted` with one.

| code | 中文 | English | params |
|---|---|---|---|
| `me.forward_quota_exceeded` | 转发规则数量已达套餐上限（{used}/{limit}）；limit = 0 表示当前套餐未开通 | Forward quota reached ({used}/{limit}); limit = 0 means the current package does not allow forwarding | limit, used |
| `me.forward_server_not_allowed` | 当前套餐不允许在服务器「{server_name}」上创建转发 | The current package does not allow forwarding on server "{server_name}" | server_id, server_name |
| `me.forward_not_found` | 转发规则不存在（不存在或不属于当前用户） | Forward not found (missing or not owned by the current user) | — |
| `package.forward_limit_invalid` | 自助转发条数不能为负数（0 表示不允许） | Forward limit must not be negative (0 means not allowed) | min |
| `package.forward_server_invalid` | 服务器 id 不能为空 | Server id must not be empty | — |
| `package.forward_server_not_found` | 服务器不存在：{server_ids} | Server not found: {server_ids} | server_ids |

接口 / Endpoints:

- `GET /api/v1/me/summary` 顶层带 `forward_servers: [{ id, name }]`：与创建接口用
  **同一份额度快照**（生效中且 `forward_limit > 0` 的套餐白名单并集、去重、按名称排序），
  `forward_limit = 0` 时为空数组。前端据此渲染服务器下拉。
- `GET /api/v1/me/forwards` → `{ items: [...], quota: { limit, used } }`；
  每项在转发字段之外带 `server_name`、`server_address`、`entry_address`（`地址:端口`）。
- `POST /api/v1/me/forwards`，body `{ server_id, target_host, target_port, protocol? }`：
  `protocol` 缺省 `tcp`，允许 `tcp` / `both`；`udp` 仍受 Agent 能力门禁
  （`forward.protocol_requires_agent_upgrade`）。返回 `{ forward, quota }`。
- `PATCH /api/v1/me/forwards/{id}`，body `{ enabled }`（只允许改启用状态）。
- `DELETE /api/v1/me/forwards/{id}` → `{ ok: true }`。
- 越权修改/删除别人的规则返回 **404 `me.forward_not_found`**，不返回 403：
  避免用错误码枚举他人规则 id。
- 审计动作 `user_forward.create` / `user_forward.delete`，`target` 是转发 id，
  `detail` 只含 `forward_id`、`server_id`、`server_name`、`listen_port`、
  `target_host`、`target_port`、`protocol`，**不含用户名/邮箱**。
