import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  QueryClient,
  QueryObserver,
  keepPreviousData,
} from "@tanstack/react-query";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

function section(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const next = source.indexOf("\nexport function ", start + startMarker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

/**
 * P1-1：切换 24h → 7d 时，TanStack Query 用上一份数据做 placeholder：
 * `isPending` 必须是 false、`isPlaceholderData` 必须是 true。
 *
 * 这里直接驱动 QueryObserver（与 useQuery 同一套 observer 语义），
 * 避免把「测试」写死成对源码字符串的断言。
 */
test("range switch keeps previous data: isPending false, isPlaceholderData true", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let resolveNext = () => {};
  const observer = new QueryObserver(client, {
    queryKey: ["chainHealth", 24, 900, []],
    queryFn: async () => ({ hours: 24 }),
    placeholderData: keepPreviousData,
  });
  const unsubscribe = observer.subscribe(() => {});

  await new Promise((resolve) => setTimeout(resolve, 10));
  const first = observer.getCurrentResult();
  assert.equal(first.isPending, false);
  assert.deepEqual(first.data, { hours: 24 });

  observer.setOptions({
    queryKey: ["chainHealth", 168, 3600, []],
    queryFn: () =>
      new Promise((resolve) => {
        resolveNext = resolve;
      }),
    placeholderData: keepPreviousData,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const switching = observer.getCurrentResult();
  assert.equal(switching.isPending, false, "切时窗不能回到骨架态");
  assert.equal(switching.isPlaceholderData, true, "旧数据必须标成 placeholder");
  assert.deepEqual(switching.data, { hours: 24 }, "视图继续用旧数据渲染");

  resolveNext({ hours: 168 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const settled = observer.getCurrentResult();
  assert.equal(settled.isPlaceholderData, false);
  assert.deepEqual(settled.data, { hours: 168 });
  unsubscribe();
});

test("chain and server health queries opt into keepPreviousData", () => {
  const queries = read("lib/queries.ts");
  for (const hook of ["useServerHealth", "useChainHealth"]) {
    const body = section(queries, `export function ${hook}(`);
    assert.match(
      body,
      /placeholderData:\s*keepPreviousData/,
      `${hook} must keep the previous window while the next one loads`,
    );
  }
});

test("skeletons only show before the first payload, not on refetch", () => {
  const chainView = read("components/overview/ChainLatencyView.tsx");
  const serverView = read("components/overview/ServerHealthView.tsx");
  for (const [name, source] of [
    ["ChainLatencyView", chainView],
    ["ServerHealthView", serverView],
  ]) {
    assert.match(
      source,
      /query\.isPending\s*&&\s*query\.data\s*===\s*undefined/,
      `${name} skeleton must require data === undefined`,
    );
    assert.doesNotMatch(
      source,
      /if\s*\(query\.isPending\)\s*return/,
      `${name} must not unmount the body on a background window switch`,
    );
  }
  // 弹窗在列表之外渲染，查询切窗时不能被骨架分支吞掉。
  assert.match(chainView, /<ChainLatencyDetailDialog/);
  assert.ok(
    chainView.indexOf("<ChainLatencyDetailDialog") >
      chainView.indexOf("query.isPending && query.data === undefined"),
  );
});
