import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import {
  availabilityPercent,
  availabilityTone,
  hasSamples,
  isPublicStatusPath,
  resourcePercent,
  serverState,
} from "./publicStatus.ts";

test("serverState distinguishes offline, abnormal and online", () => {
  assert.equal(serverState({ online: false, xray_running: false }), "offline");
  assert.equal(serverState({ online: false, xray_running: null }), "offline");
  assert.equal(serverState({ online: true, xray_running: false }), "abnormal");
  assert.equal(serverState({ online: true, xray_running: true }), "online");
  // 在线但没有 Xray 上报：不能断言异常，按在线处理。
  assert.equal(serverState({ online: true, xray_running: null }), "online");
});

test("availabilityTone keeps missing samples grey and bands the rest", () => {
  assert.equal(availabilityTone(null), "unknown");
  assert.equal(availabilityTone(undefined), "unknown");
  assert.equal(availabilityTone(Number.NaN), "unknown");
  assert.equal(availabilityTone(1), "ok");
  assert.equal(availabilityTone(0.99), "ok");
  assert.equal(availabilityTone(0.989), "warn");
  assert.equal(availabilityTone(0.5), "warn");
  assert.equal(availabilityTone(0.49), "down");
  assert.equal(availabilityTone(0), "down");
});

test("availabilityPercent rounds and clamps, null stays null", () => {
  assert.equal(availabilityPercent(null), null);
  assert.equal(availabilityPercent(undefined), null);
  assert.equal(availabilityPercent(Number.NaN), null);
  assert.equal(availabilityPercent(1), 100);
  assert.equal(availabilityPercent(0.996), 100);
  assert.equal(availabilityPercent(0.5), 50);
  assert.equal(availabilityPercent(0.004), 0);
  assert.equal(availabilityPercent(-1), 0);
  assert.equal(availabilityPercent(2), 100);
});

test("hasSamples only reports true for at least one real bucket", () => {
  assert.equal(hasSamples([]), false);
  assert.equal(hasSamples([null, null, undefined]), false);
  assert.equal(hasSamples([null, { ts: 1, online_ratio: 1 }]), true);
});

test("resourcePercent guards missing and zero totals", () => {
  assert.equal(resourcePercent(null, 100), null);
  assert.equal(resourcePercent(10, null), null);
  assert.equal(resourcePercent(10, 0), null);
  assert.equal(resourcePercent(Number.NaN, 100), null);
  assert.equal(resourcePercent(10, 100), 10);
  assert.equal(resourcePercent(150, 100), 100);
  assert.equal(resourcePercent(-5, 100), 0);
});

test("isPublicStatusPath only allows the exact public route", () => {
  assert.equal(isPublicStatusPath("/status"), true);
  assert.equal(isPublicStatusPath("/status/"), true);
  assert.equal(isPublicStatusPath("/status/servers"), false);
  assert.equal(isPublicStatusPath("/statuses"), false);
  assert.equal(isPublicStatusPath("/"), false);
  assert.equal(isPublicStatusPath("/login"), false);
});

test("status page dynamic i18n keys exist in both locales", () => {
  const keys = [
    "server.online",
    "server.offline",
    "server.abnormal",
    "availability.ok",
    "availability.warn",
    "availability.down",
    "availability.unknown",
  ];
  const pick = (dictionary, path) =>
    path.split(".").reduce((node, part) => node?.[part], dictionary);

  for (const key of keys) {
    assert.equal(typeof pick(zh.publicStatus, key), "string", `zh ${key}`);
    assert.equal(typeof pick(en.publicStatus, key), "string", `en ${key}`);
  }
});
