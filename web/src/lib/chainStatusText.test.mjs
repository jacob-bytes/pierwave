import assert from "node:assert/strict";
import test from "node:test";
import { setCurrentLocale } from "../i18n/locale.ts";
import {
  chainLastHopReasonLabel,
  chainLastHopReasonText,
  chainStatusText,
} from "./chainStatusText.ts";

function withLocale(locale, fn) {
  setCurrentLocale(locale);
  try {
    fn();
  } finally {
    setCurrentLocale("en");
  }
}

function chain(overrides = {}) {
  return {
    status: { kind: "unknown", cause: "unmeasurable", node: null },
    lastHop: { measurable: false, reason: "engine_unsupported" },
    hasSamples: true,
    deltaMs: 0,
    slow: false,
    ...overrides,
  };
}

test("last_hop reason maps to the bilingual unmeasurable wording", () => {
  withLocale("zh-CN", () => {
    assert.equal(
      chainLastHopReasonLabel(chain()),
      "引擎不支持探测",
    );
    assert.equal(
      chainLastHopReasonText(chain()),
      "不可测量（引擎不支持探测）",
    );
    assert.equal(
      chainLastHopReasonLabel(
        chain({ lastHop: { measurable: false, reason: "protocol_unsupported" } }),
      ),
      "协议不支持探测",
    );
    assert.equal(
      chainLastHopReasonText(
        chain({ lastHop: { measurable: false, reason: "protocol_unsupported" } }),
      ),
      "不可测量（协议不支持探测）",
    );
  });

  withLocale("en", () => {
    assert.equal(
      chainLastHopReasonLabel(chain()),
      "engine probing unsupported",
    );
    assert.equal(
      chainLastHopReasonText(chain()),
      "Unmeasurable (engine probing unsupported)",
    );
    assert.equal(
      chainLastHopReasonLabel(
        chain({ lastHop: { measurable: false, reason: "protocol_unsupported" } }),
      ),
      "protocol probing unsupported",
    );
  });
});

test("unknown status badge reads 未知 · 不可测量, not degraded / blocked", () => {
  withLocale("zh-CN", () => {
    assert.equal(chainStatusText(chain()), "未知 · 不可测量");
  });
  withLocale("en", () => {
    assert.equal(chainStatusText(chain()), "Unknown · Unmeasurable");
  });
});

test("a disabled unmeasurable chain stays 停用, without the reason", () => {
  const config = { enabled: false, degraded: false, blocked_reason: null };
  withLocale("zh-CN", () => {
    assert.equal(chainStatusText(chain(), config), "停用");
  });
  withLocale("en", () => {
    assert.equal(chainStatusText(chain(), config), "Disabled");
  });
});

test("old controller without last_hop keeps the legacy wording", () => {
  const legacy = chain({ status: null, lastHop: null });
  withLocale("zh-CN", () => {
    assert.equal(chainLastHopReasonLabel(legacy), null);
    assert.equal(chainLastHopReasonText(legacy), null);
  });
  withLocale("en", () => {
    assert.equal(chainLastHopReasonText(legacy), null);
  });

  // 新契约说可测时也不显示「不可测量」。
  const measurable = chain({
    status: { kind: "ok", cause: null, node: null },
    lastHop: { measurable: true, reason: null },
  });
  assert.equal(chainLastHopReasonText(measurable), null);
  assert.equal(chainLastHopReasonLabel(measurable), null);
});

test("missing reason still says unmeasurable without inventing a cause", () => {
  const noReason = chain({ lastHop: { measurable: false, reason: null } });
  withLocale("zh-CN", () => {
    assert.equal(chainLastHopReasonLabel(noReason), null);
    assert.equal(chainLastHopReasonText(noReason), "不可测量");
  });
  withLocale("en", () => {
    assert.equal(chainLastHopReasonText(noReason), "Unmeasurable");
  });
});
