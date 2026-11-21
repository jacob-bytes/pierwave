import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import {
  availabilityPercent,
  averageLatency,
  averageUptime24h,
  nextPublicStatusFailureStreak,
  onlineRateByDirection,
  PUBLIC_STATUS_POLL_MS,
  PUBLIC_STATUS_RETRY_BASE_MS,
  PUBLIC_STATUS_RETRY_MAX_MS,
  publicStatusPhase,
  publicStatusRetryDelay,
  statusHeadline,
} from "./publicStatus.ts";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function pick(dictionary, path) {
  return path.split(".").reduce((node, part) => node?.[part], dictionary);
}

test("publicStatusPhase separates the five visitor-facing states", () => {
  // 1. 首屏还没有任何响应。
  assert.equal(
    publicStatusPhase({
      hasData: false,
      isError: false,
      notFound: false,
    }),
    "loading",
  );

  // 2. 从未接入节点：成功响应，但 servers 为空。
  assert.equal(
    publicStatusPhase({
      hasData: true,
      isError: false,
      notFound: false,
      serverCount: 0,
    }),
    "empty",
  );

  // 3. 正常态：有节点。筛选到 0 条时不改变页面状态。
  assert.equal(
    publicStatusPhase({
      hasData: true,
      isError: false,
      notFound: false,
      serverCount: 8,
    }),
    "ready",
  );

  // 4. 404 / 等价关闭：不是故障，也不是空库。
  assert.equal(
    publicStatusPhase({
      hasData: false,
      isError: true,
      notFound: true,
    }),
    "disabled",
  );

  // 5. 5xx / 网络错误。
  assert.equal(
    publicStatusPhase({
      hasData: false,
      isError: true,
      notFound: false,
    }),
    "error",
  );
});

test("publicStatusPhase puts failure above stale data, and 404 above failure", () => {
  // 轮询失败时，旧的成功数据不能再被当成当前状态展示。
  assert.equal(
    publicStatusPhase({
      hasData: true,
      isError: true,
      notFound: false,
      serverCount: 8,
    }),
    "error",
  );
  // 管理员关闭后即使还有缓存，也必须显示「未开放」。
  assert.equal(
    publicStatusPhase({
      hasData: true,
      isError: true,
      notFound: true,
      serverCount: 8,
    }),
    "disabled",
  );
  // 缺省 count 按空库处理，不会误判成正常态。
  assert.equal(
    publicStatusPhase({ hasData: true, isError: false, notFound: false }),
    "empty",
  );
});

test("publicStatusRetryDelay backs off 5s, 10s, 20s, 40s and caps at 60s", () => {
  assert.equal(PUBLIC_STATUS_POLL_MS, 20_000);
  assert.equal(PUBLIC_STATUS_RETRY_BASE_MS, 5_000);
  assert.equal(PUBLIC_STATUS_RETRY_MAX_MS, 60_000);

  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 10].map(publicStatusRetryDelay),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000],
  );
  // 非正数 / 非有限值不会算出 NaN 或 0 间隔。
  assert.equal(publicStatusRetryDelay(0), 5_000);
  assert.equal(publicStatusRetryDelay(-2), 5_000);
  assert.equal(publicStatusRetryDelay(Number.NaN), 5_000);
  assert.equal(publicStatusRetryDelay(Number.POSITIVE_INFINITY), 5_000);
  // 小数计数按整数处理：2.9 仍等于第二次失败。
  assert.equal(publicStatusRetryDelay(2.9), 10_000);
});

test("failure streak counts consecutive errors and resets on success", () => {
  let streak = {
    dataUpdateCount: 0,
    errorUpdateCount: 0,
    failures: 0,
  };

  // 第一次失败：1 次；同一状态被重复求值时不能重复累加。
  streak = nextPublicStatusFailureStreak(streak, {
    dataUpdateCount: 0,
    errorUpdateCount: 1,
  });
  assert.equal(streak.failures, 1);
  assert.equal(
    nextPublicStatusFailureStreak(streak, {
      dataUpdateCount: 0,
      errorUpdateCount: 1,
    }),
    streak,
  );

  // 连续失败：2、3、4、5 次，间隔分别 10s、20s、40s、60s。
  for (const count of [2, 3, 4, 5]) {
    streak = nextPublicStatusFailureStreak(streak, {
      dataUpdateCount: 0,
      errorUpdateCount: count,
    });
    assert.equal(streak.failures, count);
  }
  let sequential = {
    dataUpdateCount: 0,
    errorUpdateCount: 0,
    failures: 0,
  };
  const delays = [];
  for (const count of [1, 2, 3, 4, 5]) {
    sequential = nextPublicStatusFailureStreak(sequential, {
      dataUpdateCount: 0,
      errorUpdateCount: count,
    });
    delays.push(publicStatusRetryDelay(sequential.failures));
  }
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 60_000]);

  // 成功一次：连续失败清零，下次再失败从 5 秒重新开始。
  streak = nextPublicStatusFailureStreak(streak, {
    dataUpdateCount: 1,
    errorUpdateCount: 5,
  });
  assert.equal(streak.failures, 0);
  streak = nextPublicStatusFailureStreak(streak, {
    dataUpdateCount: 1,
    errorUpdateCount: 6,
  });
  assert.equal(streak.failures, 1);
  assert.equal(publicStatusRetryDelay(streak.failures), 5_000);

  // 成功与失败计数同时变化时以成功为准，避免恢复后仍背着旧退避。
  const afterSuccess = nextPublicStatusFailureStreak(
    { dataUpdateCount: 2, errorUpdateCount: 6, failures: 5 },
    { dataUpdateCount: 3, errorUpdateCount: 7 },
  );
  assert.equal(afterSuccess.failures, 0);
});

test("averageLatency averages online nodes only and keeps unknown as null", () => {
  assert.equal(averageLatency([]), null);
  assert.equal(averageLatency([{ online: false, latency_ms: 20 }]), null);
  assert.equal(
    averageLatency([
      { online: true, latency_ms: null },
      { online: true, latency_ms: undefined },
      { online: true, latency_ms: Number.NaN },
      { online: true, latency_ms: -1 },
    ]),
    null,
  );
  // 离线机器的残留延迟不参与；在线机器的有效读数取平均并四舍五入。
  assert.equal(
    averageLatency([
      { online: true, latency_ms: 20 },
      { online: true, latency_ms: 33 },
      { online: false, latency_ms: 999 },
      { online: true, latency_ms: null },
    ]),
    27,
  );
  // 真实测到的 0 ms 是有效读数。
  assert.equal(
    averageLatency([
      { online: true, latency_ms: 0 },
      { online: true, latency_ms: 0 },
    ]),
    0,
  );
});

test("an empty library leaves hero numbers unknown (—), never 0", () => {
  const headline = statusHeadline([]);
  assert.equal(headline.kind, "empty");
  assert.equal(headline.total, 0);
  // 这三个值分别驱动 hero 的三个大数字；null 在组件里渲染成 —。
  assert.equal(averageUptime24h([]), null);
  assert.equal(availabilityPercent(averageUptime24h([])), null);
  assert.equal(onlineRateByDirection([]), null);
});

test("filtering only narrows the list, never the hero source", () => {
  const page = read("../pages/Status.tsx");
  // hero 始终接收完整数据；筛选结果只用于下方的表格 / 网格。
  assert.match(
    page,
    /<Hero[\s\S]*?summary=\{data\.summary\}[\s\S]*?servers=\{data\.servers\}/,
  );
  // 趋势序列从根级读；旧后端没有该字段时是 undefined → 空态。
  assert.match(page, /series=\{data\.series \?\? null\}/);
  assert.match(page, /const filtered = filterPublicServers\(/);
  // 全部离线的说明只读 generated_at，不引入新的红色告警块。
  assert.match(page, /allOfflineNote/);
  assert.match(page, /statusHeadline\(data\.servers\)\.kind === "all-offline"/);
  assert.match(page, /formatClockTime\(data\.generated_at\)/);
});

test("disabled and error states expose the right live-region semantics", () => {
  const page = read("../pages/Status.tsx");
  // 错误态：立刻播报（alert / assertive）；关闭态：礼貌播报（status / polite）。
  assert.match(page, /role="alert" aria-live="assertive"/);
  assert.match(page, /role="status" aria-live="polite"/);
  // 不再复用表格语境的 admin 错误块，也不再显示后端原文。
  assert.doesNotMatch(page, /ListError/);
  assert.doesNotMatch(page, /errorText/);
  // 重试按钮只在错误态出现；关闭态没有 action。
  assert.match(page, /publicStatus\.error\.retry/);
  assert.match(page, /status\.refetch\(\)/);
  // 错误态显示最后一次成功时间（React Query 的 dataUpdatedAt）。
  assert.match(page, /dataUpdatedAt/);
  assert.match(page, /lastSuccess/);
});

test("public status polling keeps 20s normally and backs off on failure", () => {
  const queries = read("./queries.ts");
  // 正常态 20 秒；页面隐藏时暂停。
  assert.match(queries, /return PUBLIC_STATUS_POLL_MS/);
  assert.match(queries, /refetchIntervalInBackground:\s*false/);
  // 失败态按连续失败次数退避，而不是固定 20 秒反复打。
  assert.match(
    queries,
    /nextPublicStatusFailureStreak\(\s*failureStreak\.current,\s*query\.state,/,
  );
  assert.match(queries, /publicStatusRetryDelay\(failureStreak\.current\.failures\)/);
  assert.match(queries, /query\.state\.status === "error"/);
  assert.doesNotMatch(
    queries,
    /refetchInterval:\s*PUBLIC_STATUS_POLL_MS/,
    "失败态不能继续固定 20 秒轮询",
  );
  // 关闭态的 404 停止轮询：重试没有意义。
  assert.match(queries, /query\.state\.error\.status === 404/);
  assert.match(queries, /return false/);
});

test("five-state copy exists in both locales and stays visitor-facing", () => {
  const keys = [
    "allOfflineNote",
    "header.disabled",
    "servers.emptyTitle",
    "servers.emptyDescription",
    "servers.emptyFilteredTitle",
    "servers.emptyFilteredDescription",
    "error.title",
    "error.description",
    "error.lastSuccess",
    "error.retry",
    "disabled.title",
    "disabled.description",
  ];
  for (const key of keys) {
    assert.equal(typeof pick(zh.publicStatus, key), "string", `zh ${key}`);
    assert.equal(typeof pick(en.publicStatus, key), "string", `en ${key}`);
  }

  // 空库：就绪，不是失败。
  assert.match(pick(zh.publicStatus, "servers.emptyTitle"), /已就绪/);
  assert.match(pick(zh.publicStatus, "servers.emptyDescription"), /还没有接入任何节点/);
  assert.match(pick(en.publicStatus, "servers.emptyTitle"), /ready/i);
  assert.match(pick(en.publicStatus, "servers.emptyDescription"), /No nodes/i);

  // 筛选无结果：一键清除。
  assert.equal(
    pick(zh.publicStatus, "servers.emptyFilteredTitle"),
    "没有匹配的节点",
  );
  assert.equal(pick(en.publicStatus, "servers.emptyFilteredTitle"), "No matching nodes");
  assert.equal(
    pick(zh.publicStatus, "toolbar.clearFilters"),
    "清除筛选",
  );

  // 全部离线：只有一条时间说明，没有警报语气。
  assert.match(pick(zh.publicStatus, "allOfflineNote"), /\{time\}/);
  assert.match(pick(en.publicStatus, "allOfflineNote"), /\{time\}/);
  assert.doesNotMatch(pick(zh.publicStatus, "allOfflineNote"), /错误|失败|警报/);
  assert.doesNotMatch(pick(en.publicStatus, "allOfflineNote"), /error|fail|alert/i);

  // 关闭：联系服务提供方，不用「管理员关闭」这种后台视角。
  assert.equal(pick(zh.publicStatus, "disabled.title"), "状态页未开放");
  assert.match(pick(zh.publicStatus, "disabled.description"), /联系服务提供方/);
  assert.match(pick(en.publicStatus, "disabled.title"), /not public/i);
  assert.match(pick(en.publicStatus, "disabled.description"), /service provider/i);

  // 失败：暂时不可用 + 重试 + 上次成功时间。
  assert.equal(
    pick(zh.publicStatus, "error.title"),
    "暂时无法获取服务状态",
  );
  assert.match(pick(en.publicStatus, "error.title"), /temporarily unavailable/i);
  assert.match(pick(zh.publicStatus, "error.lastSuccess"), /\{time\}/);
  assert.equal(pick(zh.publicStatus, "error.retry"), "重试");
  assert.equal(pick(en.publicStatus, "error.retry"), "Retry");

  // 轮询提示与实际一致：20 秒，不是旧的 30 秒。
  assert.match(pick(zh.publicStatus, "autoRefreshHint"), /20 秒/);
  assert.match(pick(en.publicStatus, "autoRefreshHint"), /20 seconds/);
});
