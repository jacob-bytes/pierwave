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

test("404 is mounted in both the public area and the signed-in console", () => {
  const app = read("App.tsx");
  // 公开区：/status/* 有自己的 *，且不经过 useMe 的登录守卫。
  assert.match(app, /path="\*"\s*\n\s*element=\{<NotFoundPage homePath="\/" standalone \/>\}/);
  // 管理员与普通用户的 * 都渲染 NotFoundPage，不再 Navigate。
  assert.match(app, /<NotFoundPage homePath="\/" \/>/);
  assert.match(app, /<NotFoundPage homePath="\/me" \/>/);
  assert.doesNotMatch(app, /<Route path="\*" element=\{<Navigate to="\/" replace \/>\} \/>/);
  // 未登录访问受保护路径仍然先去登录，而不是把鉴权改成 404。
  assert.match(
    app,
    /<Route path="\*" element=\{<Navigate to="\/login" replace \/>\} \/>/,
  );
});

test("404 page exposes the three exits and both languages", () => {
  const page = read("pages/NotFound.tsx");
  for (const key of ["notFound.console", "notFound.status", "notFound.back"]) {
    assert.match(page, new RegExp(key.replaceAll(".", "\\.")));
  }
  for (const dict of [zh, en]) {
    for (const key of [
      "notFound.description",
      "notFound.console",
      "notFound.status",
      "notFound.back",
    ]) {
      assert.equal(typeof hasKey(dict, key), "string", `${key} is missing`);
    }
  }
});
