# 受管文件应用结果 / Managed file apply result

Agent 落受管文件（证书、私钥、配置）走两阶段提交：先写全部 `.new` 临时文件，
全部成功后再逐个 `rename` 提交。**提交阶段**失败时，失败点之前的文件已经
对线上生效——这是「部分成功」，不能当成整体失败。

Agent 的 `ApplyResult.error` 只能回传字符串，因此用稳定的文本契约表达：

```text
[agent.apply_files.partial] 受管文件部分生效（partial success），阶段: 提交 rename / commit；已生效 2/3: /etc/pierwave/xray/server.crt, /etc/pierwave/xray/server.key；其余文件未生效、临时文件已清理；失败原因: …
```

主控在落库前解析这段文本（`pierwave_domain::apply`），其它错误（`write_failed`、
`commit_failed`、网络错误、任意异常文案）**不解析、不改写**，原文照旧展示。

English: the Agent applies managed files with a two-phase commit. When the commit
phase fails after some files were already renamed into place, that is a *partial
success*, not a total failure. `ApplyResult.error` is only a string, so the Agent
uses the stable marker above. The master parses it into structured fields before
persisting; every other error is kept verbatim and displayed as-is.

## 落库 / Storage

迁移 `0060_server_apply_status.sql`（只追加）给 `servers` 加五列：

| 列 | 含义 |
|---|---|
| `apply_status` | `ok` / `partial` / `failed`；NULL = 从未上报 |
| `apply_error` | `ApplyResult.error` 原文；成功为 NULL |
| `apply_version` | Agent 上报的配置版本 |
| `apply_at` | 主控收到结果的时间（Unix 秒） |
| `apply_partial_json` | 仅 partial：`{"stage","effective","total"}`；否则 NULL |

每次收到 `ApplyResult` 整体覆盖上一条：这里展示的是「最近一次结果」，不是历史。
English: migration 0060 appends five columns to `servers`. Each report overwrites
the previous one; this is current state, not history.

## API 形状 / API shape

服务器对象（`GET /api/v1/servers`、创建/修改响应里的 `server`）新增：

```jsonc
{
  "apply_status": "partial",          // ok | partial | failed | null
  "apply_error": "…原文…",             // 非 partial 错误直接展示这段
  "apply_version": 7,
  "apply_at": 1760000000,
  "apply_partial": {                  // 仅 partial，否则 null
    "stage": "提交 rename / commit",
    "effective": ["/etc/pierwave/xray/server.crt", "/etc/pierwave/xray/server.key"],
    "effective_count": 2,             // 派生值，永远等于 effective.length
    "total": 3
  }
}
```

English: each server object exposes `apply_status`, `apply_error`,
`apply_version`, `apply_at` and `apply_partial` (`null` unless partial).

## 展示 / Display

服务器详情或配置版本旁边：

- `partial`：**部分应用（2/3 个文件已生效）**，可展开 `apply_partial.effective`
  查看具体路径；同时保留 `apply_error` 的失败原因。
- `failed`：直接显示 `apply_error` 原文，不加工。
- `ok` / NULL：不显示应用错误块。

English: for `partial`, show **Partially applied (2 of 3 files in effect)** with the
effective paths expandable; for `failed`, show `apply_error` verbatim; for `ok` or
NULL, show nothing.

## 测试 / Tests

- `pierwave-domain`：标记解析（正常、缺字段、路径为空）、非 partial 不误判、
  计数与路径一致性、落库字符串往返。
- `pierwave-master`：`ApplyResult` → 落库 → 列表 API 返回结构化字段；
  非 partial 错误原文返回且 `apply_partial` 为 `null`；成功清空上一条错误。
