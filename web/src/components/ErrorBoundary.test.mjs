import test from "node:test";
import assert from "node:assert/strict";
import { deriveErrorState } from "./errorBoundaryState.ts";

test("deriveErrorState keeps the message of a real Error instance", () => {
  const state = deriveErrorState(new Error("summary.usage is undefined"));
  assert.equal(state.message, "summary.usage is undefined");
  assert.ok(state.error instanceof Error);
  assert.equal(state.error.message, "summary.usage is undefined");
});

test("deriveErrorState stringifies a thrown string", () => {
  const state = deriveErrorState("boom");
  assert.equal(state.message, "boom");
  assert.ok(state.error instanceof Error);
  assert.equal(state.error.message, "boom");
});

test("deriveErrorState serializes a thrown plain object", () => {
  const state = deriveErrorState({ code: 500, detail: "bad shape" });
  assert.equal(state.message, '{"code":500,"detail":"bad shape"}');
  assert.ok(state.error instanceof Error);
});

test("deriveErrorState survives null, undefined and empty strings", () => {
  for (const value of [null, undefined, ""]) {
    const state = deriveErrorState(value);
    assert.equal(state.message, "Unknown error");
    assert.ok(state.error instanceof Error);
  }
});

test("deriveErrorState does not throw on circular objects", () => {
  const circular = {};
  circular.self = circular;
  const state = deriveErrorState(circular);
  assert.ok(state.error instanceof Error);
  assert.ok(state.message.length > 0);
});
