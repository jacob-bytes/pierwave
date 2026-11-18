import test from "node:test";
import assert from "node:assert/strict";
import { missingRequiredLabels } from "./formRequired.ts";

test("missingRequiredLabels lists the empty fields in order", () => {
  assert.deepEqual(
    missingRequiredLabels([
      { label: "名称", value: "" },
      { label: "地址", value: "  " },
    ]),
    ["名称", "地址"],
  );
});

test("missingRequiredLabels returns [] when every field is filled", () => {
  assert.deepEqual(
    missingRequiredLabels([
      { label: "名称", value: "hk-1" },
      { label: "地址", value: "10.0.0.1" },
    ]),
    [],
  );
});

test("missingRequiredLabels treats null/undefined as empty", () => {
  assert.deepEqual(
    missingRequiredLabels([
      { label: "A", value: null },
      { label: "B", value: undefined },
    ]),
    ["A", "B"],
  );
});

test("missingRequiredLabels keeps the caller's field order and labels", () => {
  const fields = [
    { label: "地址", value: "" },
    { label: "名称", value: "x" },
  ];
  assert.deepEqual(missingRequiredLabels(fields), ["地址"]);
});
