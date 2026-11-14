import assert from "node:assert/strict";
import test from "node:test";
import {
  CLEANUP_PRESETS,
  RENEW_DAY_PRESETS,
  RENEW_DAYS_MAX,
  RENEW_DAYS_MIN,
  cleanupDaysFor,
  cleanupDialogReducer,
  initialCleanupDialogState,
  initialRenewDialogState,
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
