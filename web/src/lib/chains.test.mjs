import assert from "node:assert/strict";
import test from "node:test";
import {
  chainStatus,
  degradedHops,
  entryHop,
  formatHopEndpoint,
  hopListeningState,
  hopTargetState,
  orderHops,
} from "./chains.ts";

const hop = (seq, overrides = {}) => ({
  seq,
  server_name: `server-${seq}`,
  listen_port: 20000 + seq,
  listening: true,
  target_ok: true,
  degraded: false,
  error: "",
  updated_at: 1_700_000_000,
  ...overrides,
});

test("chainStatus reports disabled before degraded", () => {
  assert.equal(chainStatus(false, true), "disabled");
  assert.equal(chainStatus(0, true), "disabled");
  assert.equal(chainStatus(undefined, true), "disabled");
});

test("chainStatus distinguishes degraded from ok", () => {
  assert.equal(chainStatus(true, true), "degraded");
  assert.equal(chainStatus(1, 1), "degraded");
  assert.equal(chainStatus(true, false), "ok");
  assert.equal(chainStatus(1, 0), "ok");
  assert.equal(chainStatus(true, undefined), "ok");
});

test("hopListeningState treats null as unreported, not failed", () => {
  assert.equal(hopListeningState(null), "unreported");
  assert.equal(hopListeningState(undefined), "unreported");
  assert.equal(hopListeningState(true), "listening");
  assert.equal(hopListeningState(false), "failed");
});

test("hopTargetState treats null as unprobed, not reachable", () => {
  assert.equal(hopTargetState(null), "unprobed");
  assert.equal(hopTargetState(undefined), "unprobed");
  assert.equal(hopTargetState(true), "reachable");
  assert.equal(hopTargetState(false), "unreachable");
});

test("orderHops sorts by seq without mutating the input", () => {
  const input = [hop(2), hop(0), hop(1)];
  const ordered = orderHops(input);

  assert.deepEqual(
    ordered.map((item) => item.seq),
    [0, 1, 2],
  );
  assert.deepEqual(
    input.map((item) => item.seq),
    [2, 0, 1],
  );
});

test("entryHop returns the lowest seq and null for an empty chain", () => {
  assert.equal(entryHop([hop(2), hop(0), hop(1)])?.seq, 0);
  assert.equal(entryHop([hop(1)])?.seq, 1);
  assert.equal(entryHop([]), null);
});

test("degradedHops lists only degrading hops in chain order", () => {
  const hops = [
    hop(2, { degraded: true, target_ok: false }),
    hop(0),
    hop(1, { degraded: true, target_ok: false }),
  ];

  assert.deepEqual(
    degradedHops(hops).map((item) => item.seq),
    [1, 2],
  );
  assert.deepEqual(degradedHops([hop(0), hop(1)]), []);
});

test("formatHopEndpoint trims the server name and appends the port", () => {
  assert.equal(
    formatHopEndpoint({ server_name: " 香港中转 ", listen_port: 443 }),
    "香港中转:443",
  );
  assert.equal(
    formatHopEndpoint({ server_name: "sg-02", listen_port: 20000 }),
    "sg-02:20000",
  );
});
