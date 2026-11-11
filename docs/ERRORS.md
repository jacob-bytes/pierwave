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
| `server.xray_mode_unsupported` | 目前只支持外置 Xray（external） | — |
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
| `chain.name_required` | 链名称不能为空 | — |
| `chain.name_too_long` | 链名称最多 {max} 个字符 | max |
| `chain.hop_count_invalid` | 链必须包含 {min}-{max} 跳（当前 {count} 跳） | count, max, min |
| `chain.duplicate_server` | 同一台服务器（{server_id}）不能在一跳链里出现两次 | server_id |
| `chain.port_conflict_hop` | 监听端口 {port} 已被服务器「{server_name}」上的链「{name}」第 {seq} 跳占用 | chain_id, name, port, seq, server_name |

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

行为矩阵（写路径）/ Behaviour matrix (write path):

| 场景 / Case | 结果 / Result |
|---|---|
| `protocol` 不在白名单 | `forward.protocol_invalid` / `chain.protocol_invalid` |
| `protocol = udp` 且 `engine = realm` | `forward.protocol_udp_requires_native`（转发与链共用） |
| `protocol = udp` 且链 `transport = tls` | `chain.protocol_udp_with_tls` |
| `protocol = both` 且链 `transport = tls` | `chain.tls_udp_unsupported`（UDP 不走 transport） |
| 只传旧字段 `udp = true` | 归一化为 `protocol = both`（旧客户端兼容） |
| 只传旧字段 `udp = false` | 归一化为 `protocol = tcp` |

迁移 `0034_forward_protocol.sql`：`udp = 1 → both`，`udp = 0 → tcp`；`udp` 列保留，
但读写行为只认 `protocol`。Agent 侧：native 按所选协议绑定（仅 UDP 时完全不绑 TCP）；
nftables 只为所选协议生成 DNAT 规则；realm 的 `both` 写 `use_udp = true`，`tcp` 写
`use_udp = false` 并给端点加 `network = { use_udp = false }`。
