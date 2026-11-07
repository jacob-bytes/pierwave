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
| `node.cert_required` | TLS 节点必须绑定证书 | — |
| `node.cert_tls_only` | 只有 TLS 节点才能绑定证书 | — |
| `node.cert_not_found` | 绑定的证书不存在 | — |
| `node.cert_id_invalid` | 证书 id 不合法 | — |
| `certificate.not_found` | 证书不存在 | — |
| `certificate.name_required` | 证书名称不能为空 | — |
| `certificate.name_too_long` | 证书名称最多 {max} 个字符 | max |
| `certificate.invalid` | 证书或私钥无法解析，或两者不匹配 | — |
| `certificate.in_use` | 该证书被 {references} 个节点引用，无法删除 | references |
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
