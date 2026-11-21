import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import zh from "../i18n/zh-CN.ts";
import en from "../i18n/en.ts";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

function hasKey(dict, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), dict);
}

test("/me overview keeps only a full-width login-devices card", () => {
  const overview = read("pages/me/Overview.tsx");
  // 登录设备直接进入页面的纵向卡片流，不包并排网格。
  assert.match(overview, /<LoginDevicesCard \/>/);
  assert.doesNotMatch(overview, /RecentLoginsCard/);
  assert.doesNotMatch(overview, /lg:grid-cols-2/);

  const card = read("components/me/LoginDevicesCard.tsx");
  assert.doesNotMatch(card, /RecentLoginsCard|sessions\.history/);
  // 数据层也只剩会话列表，不再请求/定义登录历史。
  const queries = read("lib/queries.ts");
  assert.doesNotMatch(queries, /recentLogins|useRecentLogins|RecentLogin/);
  assert.doesNotMatch(read("lib/api.ts"), /RecentLogin|me\/logins/);
  assert.doesNotMatch(read("lib/sessions.ts"), /formatLoginTime|LOGINS_EMPTY_KEY/);

  // 中英词典都不得留下死键。
  const deadKey = ["sessions", "history"].join(".");
  for (const dictionary of [zh, en]) {
    assert.equal(hasKey(dictionary, deadKey), undefined);
  }
});
