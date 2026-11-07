import assert from "node:assert/strict";
import test from "node:test";
import {
  RULE_TEMPLATE_INHERIT,
  ruleTemplateFromSelectValue,
  ruleTemplateInputValue,
  ruleTemplateToSelectValue,
} from "./ruleBindings.ts";

test("ruleTemplateToSelectValue maps empty bindings to the inherit sentinel", () => {
  assert.equal(ruleTemplateToSelectValue(null), RULE_TEMPLATE_INHERIT);
  assert.equal(ruleTemplateToSelectValue(undefined), RULE_TEMPLATE_INHERIT);
  assert.equal(ruleTemplateToSelectValue(""), RULE_TEMPLATE_INHERIT);
  assert.equal(ruleTemplateToSelectValue("   "), RULE_TEMPLATE_INHERIT);
});

test("ruleTemplateToSelectValue keeps real template ids untouched", () => {
  assert.equal(ruleTemplateToSelectValue("tpl-1"), "tpl-1");
  assert.equal(ruleTemplateToSelectValue("  tpl-2  "), "tpl-2");
});

test("ruleTemplateFromSelectValue restores the inherit sentinel to an empty form value", () => {
  assert.equal(ruleTemplateFromSelectValue(RULE_TEMPLATE_INHERIT), "");
  assert.equal(ruleTemplateFromSelectValue("tpl-1"), "tpl-1");
});

test("ruleTemplateInputValue sends null for an empty form value, never undefined", () => {
  assert.equal(ruleTemplateInputValue(""), null);
  assert.equal(ruleTemplateInputValue("   "), null);
  assert.equal(ruleTemplateInputValue(null), null);
  assert.equal(ruleTemplateInputValue(undefined), null);
  assert.equal(ruleTemplateInputValue("tpl-1"), "tpl-1");
  assert.equal(ruleTemplateInputValue("  tpl-2  "), "tpl-2");
});
