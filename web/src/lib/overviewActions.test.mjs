import assert from "node:assert/strict";
import test from "node:test";
import {
  CLEANUP_PRESETS,
  RENEW_DAY_PRESETS,
  RENEW_DAYS_MAX,
  RENEW_DAYS_MIN,
  cleanupDaysFor,
  cleanupDialogReducer,
  disableOverQuotaDialogReducer,
  initialCleanupDialogState,
  initialDisableOverQuotaDialogState,
  initialRenewDialogState,
  overQuotaResultNotice,
  overQuotaScopeNotice,
  renewDialogReducer,
  validateRenewDays,
} from "./overviewActions.ts";

test("renew day presets and bounds match the dialog contract", () => {
  assert.deepEqual([...RENEW_DAY_PRESETS], [7, 30, 90]);
  assert.equal(RENEW_DAYS_MIN, 1);
  assert.equal(RENEW_DAYS_MAX, 365);
});

test("validateRenewDays accepts integers inside 1-365 and trims whitespace", () => {
  assert.deepEqual(validateRenewDays("1"), { ok: true, days: 1 });
  assert.deepEqual(validateRenewDays("365"), { ok: true, days: 365 });
  assert.deepEqual(validateRenewDays(" 30 "), { ok: true, days: 30 });
  assert.deepEqual(validateRenewDays("007"), { ok: true, days: 7 });
});

test("validateRenewDays rejects empty input separately from invalid input", () => {
  assert.deepEqual(validateRenewDays(""), { ok: false, problem: "empty" });
  assert.deepEqual(validateRenewDays("   "), { ok: false, problem: "empty" });
});

test("validateRenewDays rejects non-integer and signed input", () => {
  for (const raw of ["abc", "7.0", "7.5", "+7", "-7", "1e2", "1 2", "7天"]) {
    assert.deepEqual(
      validateRenewDays(raw),
      { ok: false, problem: "invalid" },
      raw,
    );
  }
});

test("validateRenewDays rejects zero, negative and over-limit values", () => {
  for (const raw of ["0", "366", "9999", "9007199254740993"]) {
    assert.deepEqual(
      validateRenewDays(raw),
      { ok: false, problem: "outOfRange" },
      raw,
    );
  }
});

test("renew dialog cannot advance on empty, invalid or out-of-range days", () => {
  for (const raw of ["", "abc", "0", "366"]) {
    const state = { ...initialRenewDialogState(), daysInput: raw };
    assert.equal(
      renewDialogReducer(state, { type: "next" }).stage,
      "input",
      raw,
    );
  }
});

test("renew dialog goes input -> confirm -> submit and back", () => {
  let state = initialRenewDialogState();
  assert.equal(state.stage, "input");
  assert.equal(state.daysInput, "30");

  state = renewDialogReducer(state, { type: "preset", days: 90 });
  assert.equal(state.daysInput, "90");

  state = renewDialogReducer(state, { type: "next" });
  assert.equal(state.stage, "confirm");
  assert.equal(state.error, null);

  state = renewDialogReducer(state, { type: "submit" });
  assert.equal(state.submitting, true);

  state = renewDialogReducer(state, {
    type: "failure",
    message: "boom",
  });
  assert.equal(state.stage, "confirm");
  assert.equal(state.submitting, false);
  assert.equal(state.error, "boom");

  state = renewDialogReducer(state, { type: "back" });
  assert.equal(state.stage, "input");
  assert.equal(state.submitting, false);
  assert.equal(state.error, null);

  state = renewDialogReducer(state, { type: "reset" });
  assert.deepEqual(state, initialRenewDialogState());
});

test("renew dialog submit is ignored before reaching confirmation", () => {
  const state = initialRenewDialogState();
  assert.deepEqual(
    renewDialogReducer(state, { type: "submit" }),
    state,
  );
});

test("cleanup presets map 7/30/all to days and null", () => {
  assert.deepEqual(
    CLEANUP_PRESETS.map((preset) => preset.value),
    ["7", "30", "all"],
  );
  assert.equal(cleanupDaysFor("7"), 7);
  assert.equal(cleanupDaysFor("30"), 30);
  assert.equal(cleanupDaysFor("all"), null);
});

test("cleanup dialog defaults to the conservative 30-day range", () => {
  const state = initialCleanupDialogState();
  assert.equal(state.stage, "input");
  assert.equal(state.range, "30");
  assert.equal(cleanupDaysFor(state.range), 30);
});

test("cleanup dialog goes input -> confirm -> submit / back / reset", () => {
  let state = initialCleanupDialogState();
  state = cleanupDialogReducer(state, { type: "select", range: "all" });
  assert.equal(state.range, "all");
  assert.equal(cleanupDaysFor(state.range), null);

  state = cleanupDialogReducer(state, { type: "next" });
  assert.equal(state.stage, "confirm");

  state = cleanupDialogReducer(state, { type: "submit" });
  assert.equal(state.submitting, true);

  state = cleanupDialogReducer(state, {
    type: "failure",
    message: "network",
  });
  assert.equal(state.submitting, false);
  assert.equal(state.error, "network");

  state = cleanupDialogReducer(state, { type: "back" });
  assert.equal(state.stage, "input");
  assert.equal(state.error, null);

  state = cleanupDialogReducer(state, { type: "reset" });
  assert.deepEqual(state, initialCleanupDialogState());
});

test("cleanup dialog submit is ignored before reaching confirmation", () => {
  const state = initialCleanupDialogState();
  assert.deepEqual(cleanupDialogReducer(state, { type: "submit" }), state);
});

test("over-quota scope copy: 0 uses the dedicated empty message, N carries the count", () => {
  assert.deepEqual(overQuotaScopeNotice(0), {
    key: "overview.disableDialog.noTargets",
  });
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(overQuotaScopeNotice(invalid), {
      key: "overview.disableDialog.noTargets",
    });
  }
  assert.deepEqual(overQuotaScopeNotice(1), {
    key: "overview.disableDialog.scope",
    params: { n: 1 },
  });
  assert.deepEqual(overQuotaScopeNotice(12.9), {
    key: "overview.disableDialog.scope",
    params: { n: 12 },
  });
});

test("over-quota result copy: 0 is an info result, N is a success result", () => {
  assert.deepEqual(overQuotaResultNotice(0), {
    tone: "info",
    key: "overview.disableDialog.empty",
  });
  assert.deepEqual(overQuotaResultNotice(Number.NaN), {
    tone: "info",
    key: "overview.disableDialog.empty",
  });
  assert.deepEqual(overQuotaResultNotice(3), {
    tone: "success",
    key: "overview.disableDialog.success",
    params: { n: 3 },
  });
});

test("disable dialog starts at the count step and refuses 0 targets", () => {
  let state = initialDisableOverQuotaDialogState();
  assert.equal(state.stage, "count");
  assert.equal(state.count, 0);

  for (const count of [0, -1, Number.NaN]) {
    assert.deepEqual(
      disableOverQuotaDialogReducer(state, { type: "next", count }),
      state,
      String(count),
    );
  }

  state = disableOverQuotaDialogReducer(state, { type: "next", count: 2 });
  assert.equal(state.stage, "confirm");
  assert.equal(state.count, 2, "确认页冻结进入时的人数");
});

test("disable dialog goes count -> confirm -> submit / failure / back / reset", () => {
  let state = initialDisableOverQuotaDialogState();
  state = disableOverQuotaDialogReducer(state, { type: "next", count: 4 });
  assert.equal(state.stage, "confirm");
  assert.equal(state.count, 4);

  state = disableOverQuotaDialogReducer(state, { type: "submit" });
  assert.equal(state.submitting, true);
  assert.equal(state.error, null);

  state = disableOverQuotaDialogReducer(state, {
    type: "failure",
    message: "network",
  });
  assert.equal(state.stage, "confirm");
  assert.equal(state.submitting, false);
  assert.equal(state.error, "network");

  state = disableOverQuotaDialogReducer(state, { type: "back" });
  assert.equal(state.stage, "count");
  assert.equal(state.submitting, false);
  assert.equal(state.error, null);

  state = disableOverQuotaDialogReducer(state, { type: "reset" });
  assert.deepEqual(state, initialDisableOverQuotaDialogState());
});

test("disable dialog submit is ignored before confirmation", () => {
  const state = initialDisableOverQuotaDialogState();
  assert.deepEqual(
    disableOverQuotaDialogReducer(state, { type: "submit" }),
    state,
  );
});
