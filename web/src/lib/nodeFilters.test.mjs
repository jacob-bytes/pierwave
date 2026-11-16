import assert from "node:assert/strict";
import test from "node:test";
import {
  NODE_PAGE_SIZE,
  clampNodePage,
  hasNodeFilters,
  nodePageCount,
  nodePageSummary,
  parseNodeFilters,
  serializeNodeFilters,
} from "./nodeFilters.ts";

test("parseNodeFilters reads tag / region / page and trims values", () => {
  const filters = parseNodeFilters(
    new URLSearchParams("tag=%20hk%20&region=HK&page=3"),
  );
  assert.deepEqual(filters, { tag: "hk", region: "HK", page: 3 });
});

test("parseNodeFilters defaults to page 1 when params are absent", () => {
  assert.deepEqual(parseNodeFilters(new URLSearchParams()), {
    tag: "",
    region: "",
    page: 1,
  });
});

test("parseNodeFilters falls back to page 1 for invalid page values", () => {
  for (const page of ["0", "-2", "abc", "2.5", ""]) {
    assert.equal(
      parseNodeFilters(new URLSearchParams(`page=${page}`)).page,
      1,
      `page=${page}`,
    );
  }
});

test("serializeNodeFilters writes tag, region then page in order", () => {
  const params = serializeNodeFilters({ tag: " hk ", region: "HK", page: 4 });
  assert.equal(params.toString(), "tag=hk&region=HK&page=4");
});

test("serializeNodeFilters omits empty values and page 1", () => {
  assert.equal(
    serializeNodeFilters({ tag: "", region: "  ", page: 1 }).toString(),
    "",
  );
  assert.equal(
    serializeNodeFilters({ tag: "direct", region: "", page: 1 }).toString(),
    "tag=direct",
  );
});

test("serialize + parse round-trips the filter state", () => {
  const input = { tag: "香港", region: "HK", page: 2 };
  assert.deepEqual(
    parseNodeFilters(serializeNodeFilters(input)),
    input,
  );
});

test("hasNodeFilters ignores whitespace-only values", () => {
  assert.equal(hasNodeFilters({ tag: "", region: "" }), false);
  assert.equal(hasNodeFilters({ tag: "  ", region: " " }), false);
  assert.equal(hasNodeFilters({ tag: "hk", region: "" }), true);
  assert.equal(hasNodeFilters({ tag: "", region: "HK" }), true);
});

test("nodePageCount always yields at least one page", () => {
  assert.equal(nodePageCount(0), 1);
  assert.equal(nodePageCount(Number.NaN), 1);
  assert.equal(nodePageCount(-5), 1);
  assert.equal(nodePageCount(1), 1);
  assert.equal(nodePageCount(NODE_PAGE_SIZE), 1);
  assert.equal(nodePageCount(NODE_PAGE_SIZE + 1), 2);
  assert.equal(nodePageCount(120, 50), 3);
  // 非法页大小回落到默认 50。
  assert.equal(nodePageCount(120, 0), 3);
});

test("clampNodePage keeps a valid page and clamps out-of-range values", () => {
  assert.equal(clampNodePage(2, 120, 50), 2);
  assert.equal(clampNodePage(0, 120, 50), 1);
  assert.equal(clampNodePage(9, 120, 50), 3);
  assert.equal(clampNodePage(3, 0, 50), 1);
  assert.equal(clampNodePage(Number.NaN, 120, 50), 1);
});

test("nodePageSummary reports the visible range on a full page", () => {
  assert.deepEqual(nodePageSummary(1, 50, 120), {
    from: 1,
    to: 50,
    total: 120,
    page: 1,
    pages: 3,
  });
});

test("nodePageSummary reports a partial last page", () => {
  assert.deepEqual(nodePageSummary(3, 50, 120), {
    from: 101,
    to: 120,
    total: 120,
    page: 3,
    pages: 3,
  });
});

test("nodePageSummary clamps an out-of-range page before computing the range", () => {
  assert.deepEqual(nodePageSummary(99, 50, 120), {
    from: 101,
    to: 120,
    total: 120,
    page: 3,
    pages: 3,
  });
});

test("nodePageSummary returns zeros for an empty list", () => {
  assert.deepEqual(nodePageSummary(4, 50, 0), {
    from: 0,
    to: 0,
    total: 0,
    page: 1,
    pages: 1,
  });
});
