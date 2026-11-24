# 链路时延详情验收截图 / Chain latency detail acceptance shots

**中文**：用独立 Vite 页面渲染真实的 `ChainLatencyDetail`（真实组件 +
`normalizeChainHealth` 归一化），不依赖主控或数据库。覆盖最后一跳不可测
（realm 引擎 / native UDP 协议）、`unknown` 徽章、旧主控降级，以及与
`degraded` 的对比；每张图在 1440 / 390、亮 / 暗两套下都截一次。

**English**: Renders the real `ChainLatencyDetail` component with
`normalizeChainHealth` through a standalone Vite page, so no controller or
database is required. It covers the unmeasurable last hop (realm engine /
native UDP protocol), the `unknown` badge, the old-controller fallback and the
`degraded` contrast, at 1440 / 390 in both themes.

## 运行 / Run

```bash
cd web
./node_modules/.bin/vite --port 5199 --strictPort

# 另开一个终端 / another terminal
BASE=http://localhost:5199 node web/screenshots/chain-health/shots.mjs
```

## 覆盖 / Coverage

| fixture | 场景 / Scenario |
|---|---|
| `realm` | 最后一跳不可测，`reason = engine_unsupported` → 「不可测量（引擎不支持探测）」/ unmeasurable, engine |
| `udp` | 最后一跳不可测，`reason = protocol_unsupported` → 「不可测量（协议不支持探测）」/ unmeasurable, protocol |
| `legacy` | 旧主控：无 `last_hop` / `status`，最后一跳仍是「无历史数据」+ 告警 / old controller fallback |
| `degraded` | 节点异常：`degraded`，与 `unknown` 的 muted 徽章区分 / degraded contrast |

断言 / Assertions（`report.json`）：

- 徽章文案是 `未知 · 不可测量`，`data-state = unknown`；
- 拓扑最后一跳 `data-unmeasurable = true`，上行为「不可测量」，下行为括号原因；
- 逐段列表最后一段、逐段图例同样标注原因，整页不再出现「无历史数据」；
- 旧契约下 `data-unmeasurable = false`，边标签仍是「无历史数据」，并显示
  「最后一跳无历史数据，不计入跳间时延」告警；
- 英文 pass 断言 `Unknown · Unmeasurable` / `Unmeasurable (engine probing unsupported)`。

关键图 / Key shots：`{fixture}-{theme}-{width}.png`；390 额外有
`*-390-end.png`（拓扑横向滚到末端，最后一跳完整可见）。
