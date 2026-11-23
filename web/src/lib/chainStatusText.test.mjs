import assert from "node:assert/strict";
import test from "node:test";
import { chainStatusReasonText, chainStatusText } from "./chainStatusText.ts";
import { setCurrentLocale } from "../i18n/locale.ts";

function chain(status) {
  return { status };
}

test("the four status causes keep their established wording", () => {
  setCurrentLocale("zh-CN");
  assert.equal(
    chainStatusText(
      chain({
        kind: "blocked",
        cause: "node_offline",
        node: { seq: 3, name: "大阪-01" },
      }),
    ),
    "阻断 · 大阪-01 离线",
  );
  assert.equal(
    chainStatusText(
      chain({
        kind: "degraded",
        cause: "node_unhealthy",
        node: { seq: 1, name: "东京-01" },
      }),
    ),
    "降级 · 东京-01 异常",
  );
  assert.equal(
    chainStatusText(
      chain({ kind: "degraded", cause: "no_samples", node: null }),
    ),
    "降级 · 无样本",
  );
  assert.equal(
    chainStatusText(chain({ kind: "degraded", cause: "slow", node: null })),
    "降级 · 变慢",
  );

  setCurrentLocale("en");
  assert.equal(
    chainStatusText(
      chain({
        kind: "degraded",
        cause: "no_samples",
        node: null,
      }),
    ),
    "Degraded · No samples",
  );
  assert.equal(
    chainStatusText(
      chain({
        kind: "blocked",
        cause: "node_offline",
        node: { seq: 0, name: "Osaka-01" },
      }),
    ),
    "Blocked · Osaka-01 offline",
  );
});

test("no_samples only expands when the chain is degraded", () => {
  setCurrentLocale("zh-CN");
  assert.equal(
    chainStatusReasonText(chain({ kind: "ok", cause: "no_samples", node: null })),
    null,
  );
  assert.equal(
    chainStatusText({
      status: { kind: "ok", cause: null, node: null },
      hasSamples: true,
      deltaMs: 0,
      slow: false,
    }),
    "正常",
  );
  // 旧契约没有 status 时保持纯标签，不凭空拼原因。
  assert.equal(chainStatusText({ status: null }), "样本不足");
  // 停用优先于后端状态：不能显示成「停用 · 无样本」。
  assert.equal(
    chainStatusText(
      chain({ kind: "degraded", cause: "no_samples", node: null }),
      { enabled: false, degraded: false },
    ),
    "停用",
  );
});
