import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAL_RULE_ID_MAX_LENGTH,
  palInitiator,
  triggerTopic,
  validatePALRule,
  validatePALRules,
} from "./types";

/** A valid minimal rule that every mutation test starts from. */
function validRule(): Record<string, unknown> {
  return {
    id: "invoice.reminder",
    name: "remind when an invoice is created",
    trigger: { type: "invoice", event: "created" },
    where: { amount: { op: "gte", value: 100 } },
    action: {
      type: "propose_task",
      skill: "core.ai.generateText",
      payload: { prompt: "draft a reminder" },
    },
  };
}

test("a valid rule validates and normalizes (unknown keys dropped, where preserved)", () => {
  const rule = validatePALRule(validRule());
  assert.equal(rule.id, "invoice.reminder");
  assert.equal(rule.trigger.type, "invoice");
  assert.equal(rule.trigger.event, "created");
  assert.deepEqual(rule.where, { amount: { op: "gte", value: 100 } });
  assert.equal(rule.action.type, "propose_task");
  assert.equal(rule.action.skill, "core.ai.generateText");
});

test("a rule without `where` is accepted (matches every event)", () => {
  const input = validRule();
  delete input.where;
  const rule = validatePALRule(input);
  assert.equal(rule.where, undefined);
});

test("triggerTopic and palInitiator produce the documented forms", () => {
  assert.equal(triggerTopic({ type: "invoice", event: "created" }), "invoice:created");
  assert.equal(palInitiator("invoice.reminder"), "agent:pal.invoice.reminder");
});

test("rule id is validated against the identifier regex (CLAUDE.md #3)", () => {
  for (const bad of ["", "has space", "../evil", "a:b", "a/b", "áé"]) {
    const input = validRule();
    input.id = bad;
    assert.throws(() => validatePALRule(input), /"id"/, `id ${JSON.stringify(bad)} must be rejected`);
  }
});

test("rule id longer than the child-label budget is rejected at load", () => {
  const input = validRule();
  input.id = "x".repeat(PAL_RULE_ID_MAX_LENGTH + 1);
  assert.throws(() => validatePALRule(input), /exceeds/);
});

test("trigger.type cannot smuggle a colon (delimiter anchored)", () => {
  const input = validRule();
  input.trigger = { type: "invoice:evil", event: "created" };
  assert.throws(() => validatePALRule(input), /trigger.type/);
});

test("an unknown trigger event is rejected", () => {
  const input = validRule();
  input.trigger = { type: "invoice", event: "deleted2" };
  assert.throws(() => validatePALRule(input), /trigger.event/);
});

test("action.type must be propose_task (v0.1 has no other action)", () => {
  for (const type of ["notify", "link_object", "eval", "propose_task; rm -rf"]) {
    const input = validRule();
    input.action = { type, skill: "s", payload: {} };
    assert.throws(() => validatePALRule(input), /action.type/);
  }
});

test("a skill key must be a plain identifier (no whitespace/colon)", () => {
  const input = validRule();
  input.action = { type: "propose_task", skill: "core ai.generateText", payload: {} };
  assert.throws(() => validatePALRule(input), /action.skill/);
});

test("the reserved `event` key in action.payload is rejected", () => {
  const input = validRule();
  (input.action as Record<string, unknown>).payload = { event: { spoofed: true } };
  assert.throws(() => validatePALRule(input), /reserved key "event"/);
});

test("where must be a valid SmartBase filter (unknown op rejected)", () => {
  const input = validRule();
  input.where = { amount: { op: "regex", value: ".*" } };
  assert.throws(() => validatePALRule(input), /invalid op/);
});

test("a deep nesting bomb is rejected by the depth guard", () => {
  const input = validRule();
  let bomb: Record<string, unknown> = { x: {} };
  for (let i = 0; i < 20; i++) bomb = { x: bomb };
  input.action = { type: "propose_task", skill: "s", payload: bomb };
  assert.throws(() => validatePALRule(input), /depth/i);
});

test("duplicate rule ids are rejected by validatePALRules", () => {
  const a = validRule();
  const b = validRule();
  b.name = "second";
  assert.throws(() => validatePALRules([a, b]), /duplicate PAL rule id/);
});

test("a non-array ruleset is rejected", () => {
  assert.throws(() => validatePALRules({ id: "x" }), /must be an array/);
});
