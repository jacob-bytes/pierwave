import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, parseJsonBody } from "./apiError.ts";
import { isChainHealthUnsupported } from "./chainHealth.ts";
import { isServerHealthUnsupported } from "./serverHealth.ts";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

test("request parser returns null for an empty body and JSON otherwise", () => {
  assert.equal(parseJsonBody("", 200, "fallback"), null);
  assert.deepEqual(parseJsonBody('{"ok":true}', 200, "fallback"), {
    ok: true,
  });
});

test("a non-JSON error response becomes an ApiError with the HTTP status", () => {
  for (const status of [404, 403, 502]) {
    assert.throws(
      () => parseJsonBody("<html>gateway error</html>", status, "fallback"),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, status);
        return true;
      },
    );
  }
});

test("404 with an HTML body still degrades to the unsupported contract", () => {
  let error;
  try {
    parseJsonBody("<!doctype html><h1>not found</h1>", 404, "fallback");
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 404);
  assert.equal(isChainHealthUnsupported(error), true);
  assert.equal(isServerHealthUnsupported(error), true);
});

test("request uses the shared parser and a 15s timeout signal", () => {
  const api = read("lib/api.ts");
  const start = api.indexOf("async function request<T>");
  assert.ok(start >= 0);
  const end = api.indexOf("\nasync function ", start + 1);
  const body = api.slice(start, end === -1 ? api.length : end);
  assert.match(body, /AbortSignal\.timeout\(15_000\)/);
  assert.match(body, /parseJsonBody\(/);
  assert.doesNotMatch(body, /JSON\.parse\(text\)/);
});
