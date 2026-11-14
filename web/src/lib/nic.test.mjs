import assert from "node:assert/strict";
import test from "node:test";
import {
  nicBadgeTone,
  nicLabel,
  nicOptions,
  nicState,
} from "./nic.ts";

test("nicOptions renders name and addresses and keeps the reported order", () => {
  const options = nicOptions([
    { name: "eth0", addresses: ["10.0.0.2"] },
    { name: "eth1", addresses: ["10.0.0.3", "192.168.1.5"] },
  ]);

  assert.equal(options.length, 2);
  assert.deepEqual(options[0], {
    name: "eth0",
    addresses: ["10.0.0.2"],
    label: "eth0 · 10.0.0.2",
  });
  assert.equal(options[1].label, "eth1 · 10.0.0.3, 192.168.1.5");
  assert.deepEqual(
    options.map((option) => option.name),
    ["eth0", "eth1"],
  );
});

test("nicOptions drops blank, duplicate and malformed entries", () => {
  const options = nicOptions([
    { name: " eth0 ", addresses: ["10.0.0.2"] },
    { name: "eth0", addresses: ["10.0.0.9"] },
    { name: "   ", addresses: ["10.0.0.4"] },
    { name: "eth1", addresses: [] },
    null,
    { addresses: ["10.0.0.5"] },
  ]);

  assert.equal(options.length, 2);
  assert.deepEqual(
    options.map((option) => option.name),
    ["eth0", "eth1"],
  );
  // First report wins for duplicate names.
  assert.deepEqual(options[0].addresses, ["10.0.0.2"]);
  // No address still yields a usable option label.
  assert.equal(options[1].label, "eth1");
});

test("nicOptions filters empty addresses and tolerates a missing list", () => {
  const options = nicOptions([
    { name: "eth0", addresses: ["", " 10.0.0.2 ", "   "] },
  ]);
  assert.deepEqual(options[0].addresses, ["10.0.0.2"]);
  assert.equal(options[0].label, "eth0 · 10.0.0.2");

  assert.deepEqual(nicOptions(null), []);
  assert.deepEqual(nicOptions(undefined), []);
  assert.deepEqual(nicOptions([]), []);
});

test("nicLabel trims a selection and treats blank values as unset", () => {
  assert.equal(nicLabel("eth0"), "eth0");
  assert.equal(nicLabel("  eth0  "), "eth0");
  assert.equal(nicLabel(""), null);
  assert.equal(nicLabel("   "), null);
  assert.equal(nicLabel(null), null);
  assert.equal(nicLabel(undefined), null);
});

test("nicState reports unverified when the server never reported NICs", () => {
  assert.equal(nicState({ nic_unverified: true }), "unverified");
  assert.equal(
    nicState({ nic_unverified: true, nic_name: "eth0", interfaces: [] }),
    "unverified",
  );
  // A backend that predates the NIC fields cannot be verified either.
  assert.equal(nicState({ nic_name: "eth0" }), "unverified");
  assert.equal(nicState({ interfaces: undefined }), "unverified");
});

test("nicState reports empty when the server reported an empty list", () => {
  assert.equal(
    nicState({ nic_unverified: false, interfaces: [] }),
    "empty",
  );
  assert.equal(
    nicState({ nic_unverified: false, interfaces: [], nic_name: "eth0" }),
    "empty",
  );
});

test("nicState reports unset, verified and unverified for reported lists", () => {
  const interfaces = [
    { name: "eth0", addresses: ["10.0.0.2"] },
    { name: "eth1", addresses: ["10.0.0.3"] },
  ];

  assert.equal(
    nicState({ nic_unverified: false, interfaces, nic_name: null }),
    "unset",
  );
  assert.equal(
    nicState({ nic_unverified: false, interfaces, nic_name: "  eth1 " }),
    "verified",
  );
  assert.equal(
    nicState({ nic_unverified: false, interfaces, nic_name: "eth9" }),
    "unverified",
  );
});

test("nicBadgeTone maps every state to a stable badge tone", () => {
  assert.equal(nicBadgeTone("verified"), "default");
  assert.equal(nicBadgeTone("unverified"), "warning");
  assert.equal(nicBadgeTone("unset"), "muted");
  assert.equal(nicBadgeTone("empty"), "muted");
});
