# 待办与已知缺口

按约定：新增需求**先写测试再写实现**；所有面向用户的产出要中英双语。

## 已完成：真机验证（2026-11-07，Xray 26.10.31，Linux x86_64）

`make verify-xray` 全链路通过：`xray -test` 接受生成的配置字段、REALITY 端到端握手成功（HTTP 204）、
`user>>>` 与 `inbound>>>` 计数器都产生。验证过程抓到并修复了两个致命问题：

1. 节点配置用了 `stream` 而不是 Xray 的 `streamSettings` → 传输/TLS 设置被静默忽略；
2. 用户级统计写在 `policy.system` 而不是 `policy.levels."0"` → 计费恒为 0。

同时确认：`dokodemo-door` 在 Xray 26 上仍被接受；`xray api statsquery -pattern` 也能正常返回。

**仍缺一项**：`publicKey` 反推与 `xray x25519` 的对照——需要发布一个包含
`--derive-reality-key` 的版本后，脚本才能自动校验（当前会被跳过并提示 WARN）。

## 必须做（验证缺口）

- [x] **真机验证**（已通过，见上）：在一台真实的 Linux 服务器上跑 `xray -test`，起一个节点、用真实客户端连一次。
  脚本已就绪：`make verify-xray`（或 `./scripts/verify-xray.sh`）。
  它会下载/复用 Xray、在临时目录生成服务端与客户端配置、起 REALITY 节点、通过 socks 实际访问外网、
  查询 StatsService 计数器，**退出时清理自己创建的一切**（不碰系统文件、不留进程、不改端口配置）。
  注意：脚本需要机器能访问 GitHub Releases；不能访问时用 `--xray-bin /usr/bin/xray` 指定已有二进制。
  判定标准：
  - `xray -test` 通过（证明 `streamSettings` 等字段名被真实 Xray 接受）
  - 经节点访问外网返回 204/200
  - `user>>>...>>>traffic>>>uplink` 计数器 > 0（证明 stats/policy/email 配置有效）
  - PierWave 反推的 publicKey 与 `xray x25519` 输出一致
  目前所有“配置正确”都来自假命令（`restart_command=true`）与单元测试，没有真实 Xray 的证据。
  重点验证：
  - `streamSettings` 字段是否被 Xray 接受（v0.5.0 刚改名）
  - REALITY 公钥反推是否与 Xray 生成的一致
  - `stats` / `api` inbound 与 routing 规则是否生效，流量能否落到 `traffic_node_daily`
  - 证书下发路径与权限（0644 / 0600）

## 真机回归（每次发版后在该版本上跑）

```bash
# 1) 配置能被真实 Xray 接受 + 端到端握手 + 计数器
make verify-xray

# 2) 系统层：转发真的在监听、tc 限速真的加上、能正确还原
sudo make verify-runtime ARGS="--forward-port 18443 --iface eth0 --rate-mbps 100 --cleanup"
```

`verify-runtime.sh` 只读为主，`--cleanup` 只会删我们自己的 `1f00:` qdisc，不碰别人的规则。

## 已知缺口（脚本与部署）

- [x] **`scripts/install.sh` 自动化测试**：`make test-install`（`scripts/test-install.sh`）。
  用临时前缀 + stub `systemctl` + 本地假 release，覆盖 install 布局与 0600 权限、install 幂等、
  status、拒绝降级、健康检查失败回滚、uninstall 保留数据、`--purge`、越界前缀被拒绝，
  并在最后断言沙箱外零改动。已接进 CI。
- [ ] ~~**`scripts/install.sh` 零自动化测试**~~：它执行卸载/升级/回滚/删数据目录这类破坏性操作，
  目前只有人工跑过。补法：用 `DESTDIR` 前缀 + stub `systemctl`，在临时目录跑完整的
  install → status → upgrade → uninstall，断言文件创建与清理正确、`--purge` 只删数据目录。
- [ ] **Docker 镜像未在真机验证**：本机没有 Docker，`Dockerfile` 与 `docker-compose.yml`
  只做了静态审查。需要在一台有 Docker 的机器上跑一次 `docker compose up -d` 并确认：
  面板可访问、`/data` 持久化、健康检查通过、Agent 中转下载可用。

## 已知缺口（Agent 升级）

- [ ] **pending 没有超时失败机制**：如果 Agent 升级后起不来，`agent_target_version` 会永远挂在
  pending，UI 一直转圈。需要主控侧定时把「超过 N 分钟仍未达成」的升级标记为 `failed`，
  并清空 target（本轮未做）。
- [x] **看门狗不再依赖新二进制可执行**：helper 改成当场生成的 POSIX sh 脚本（`/bin/sh` 执行），
  避免「新二进制跑不起来 → 它的副本也跑不起来 → 回滚失效」这个致命边界。
- [ ] **Ack 即确认偏早**：能连上主控但运行几秒就崩的版本不会被回滚，后续考虑加「稳定运行 N 秒」窗口。
- [ ] **升级中的 Agent 无法被主控救回**：回滚完全依赖 Agent 本地看门狗；若看门狗也没注册成功，
  只能人工登机器处理。需要在 UI 上明确提示「升级失败需人工介入」。

## 已完成（2026-11-08）

- [x] **备份与恢复**：`GET /api/v1/backup`（VACUUM INTO 快照 + gzip）、上传校验、启动时应用。
  恢复不在线热替换，重启后生效；旧库保留为 `pre-restore-<ts>`。
- [x] **后端错误双语**：`{error, code, params}`，109 个稳定错误码，见 [ERRORS.md](ERRORS.md)；
  前端按 code 翻译，未命中回落中文原文。
- [x] **订阅格式扩展（P9）**：新增 `stash` / `surge` / `loon` / `qx` / `surfboard` /
  `singbox` / `shadowrocket` / `v2ray` 导出器，`?target=` 与 UA 嗅探都能识别；
  `v2ray` 输出 base64 的 URI 列表（解码后与 `uri` 一致）。
  **`egern` 本轮未实现**：PLAN 里列了它，但注册表没有该 id，`?target=egern` 仍按
  未知格式返回 400，不要误以为已支持。

## 候选需求（未排期）

| 项 | 价值 | 规模 | 备注 |
|---|---|---|---|
| Docker / compose 部署 | 高 | 小 | 降低试用门槛 |
| 规则模板绑定到用户/套餐 | 高 | 小-中 | 现在只能靠订阅链接 `?rule=` 手动指定 |
| 探针公开页 | 中-高 | 中 | 健康数据已具备，缺只读公开页面 |
| 节点限速（非断流） | 中 | 中 | Xray 原生不支持按用户限速，需 Agent 侧限速 |
| 节点测速 | 中 | 中 | PRO 类功能 |
| MCP / Telegram Bot | 中 | 中 | 生态集成 |
| 转发管理（Agent 原生 TCP 转发链） | 高 | 大 | 中转/落地链路的核心 |
| 反向隧道（WireGuard） | 中 | 大 | 家宽/NAT 落地 |
| 审计日志服务端过滤与分页 | 低 | 小 | 数据量大时才需要 |
| 自定义 CSS | 低 | 小 | 主题定制 |

## 明确不做

ACME 自动签发、nginx 证书部署、多主控/高可用、域名配置四件套、Cloudflare Tunnel、
MeowX 客户端、许可证体系。
