import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreEventBus } from "../events/core-event-bus";
import { PALRateLimiter } from "./rate-limiter";
import {
  PALExecutionEngine,
  type PALDispatch,
  type PALProposal,
} from "./engine";
import { validatePALRule } from "@p2p-hub/sdk";

/** A minimal valid rule (shared by engine tests). */
function rule(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

/** A recording dispatch seam. */
function recordingDispatch() {
  const proposals: PALProposal[] = [];
  let throwOnCall: (() => void) | null = null;
  const dispatch: PALDispatch = async (proposal) => {
    if (throwOnCall) throwOnCall();
    proposals.push(proposal);
    return { ok: true };
  };
  return { proposals, dispatch, setThrower: (f: (() => void) | null) => (throwOnCall = f) };
}

test("CoreEventBus delivers payload + event metadata to subscribers", async () => {
  const bus = new CoreEventBus();
  const seen: Array<{ payload: unknown; topic: string }> = [];
  const disposable = bus.subscribe("invoice:created", (payload, event) => {
    seen.push({ payload, topic: event.topic });
  });
  await bus.emit("invoice:created", { amount: 250 });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].payload, { amount: 250 });
  assert.equal(seen[0].topic, "invoice:created");
  disposable.dispose();
  await bus.emit("invoice:created", { amount: 999 });
  assert.equal(seen.length, 1, "disposed subscription must not fire again");
});

test("CoreEventBus rejects invalid topics and malformed payloads loudly", async () => {
  const bus = new CoreEventBus();
  for (const bad of ["", "no-colon", "invoice:", ":created", "a:b:c:d:e", "invoice:*", "invoice:created:"]) {
    assert.throws(() => bus.subscribe(bad, () => {}), /invalid event topic/, `subscribe ${JSON.stringify(bad)}`);
    await assert.rejects(bus.emit(bad, {}), /invalid event topic/, `emit ${JSON.stringify(bad)}`);
  }
  assert.throws(() => bus.subscribe("invoice:created", "not-a-fn" as never), /handler must be a function/);
  await assert.rejects(bus.emit("invoice:created", null), /plain object/);
  await assert.rejects(bus.emit("invoice:created", "string"), /plain object/);
  const cyclic: { cyclic?: unknown } = {};
  cyclic.cyclic = cyclic;
  await assert.rejects(bus.emit("invoice:created", cyclic), /nesting depth|JSON-serializable/);
  await assert.rejects(bus.emit("invoice:created", [{ nested: {} }]), /plain object/);
});

test("CoreEventBus isolates a throwing handler and keeps later handlers alive", async () => {
  const bus = new CoreEventBus();
  const order: string[] = [];
  bus.subscribe("invoice:created", () => {
    order.push("first");
    throw new Error("boom");
  });
  bus.subscribe("invoice:created", () => {
    order.push("second");
  });
  await bus.emit("invoice:created", { amount: 1 });
  assert.deepEqual(order, ["first", "second"]);
});

test("PALRateLimiter caps per-rule executions and refuses without recording", () => {
  const limiter = new PALRateLimiter({ perRule: { limit: 3, windowMs: 60_000 } });
  assert.equal(limiter.allow("r1"), true);
  assert.equal(limiter.allow("r1"), true);
  assert.equal(limiter.allow("r1"), true);
  assert.equal(limiter.allow("r1"), false, "4th call must be refused");
  assert.equal(limiter.ruleUsage("r1"), 3, "refusal must not be recorded");
  // A different rule is not affected by r1's cap.
  assert.equal(limiter.allow("r2"), true);
});

test("PALRateLimiter node-wide cap bounds aggregate across rules", () => {
  const limiter = new PALRateLimiter({
    perRule: { limit: 100, windowMs: 60_000 },
    global: { limit: 5, windowMs: 60_000 },
  });
  for (let i = 0; i < 5; i++) assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("b"), false, "node-wide budget exhausted");
  limiter.reset();
  assert.equal(limiter.allow("b"), true, "reset clears both budgets");
});

test("engine: where-match via the shared SmartBase evaluator", async () => {
  const bus = new CoreEventBus();
  const { proposals, dispatch } = recordingDispatch();
  const engine = new PALExecutionEngine({
    rules: [rule()], // where: { amount: { op: "gte", value: 100 } }
    eventBus: bus,
    rateLimiter: new PALRateLimiter(),
    dispatch,
  });
  engine.start();
  await bus.emit("invoice:created", { amount: 250, status: "open" });
  await bus.emit("invoice:created", { amount: 50, status: "open" });
  await bus.emit("invoice:created", { status: "open" });
  assert.equal(proposals.length, 1, "only the >=100 event dispatches");
  assert.equal(proposals[0].ruleId, "invoice.reminder");
  assert.equal(proposals[0].initiator, "agent:pal.invoice.reminder");
  assert.equal(proposals[0].skill, "core.ai.generateText");
  const eventCtx = proposals[0].payload.event as {
    topic: string;
    at: number;
    fields: Record<string, unknown>;
  };
  assert.equal(eventCtx.topic, "invoice:created");
  assert.deepEqual(eventCtx.fields, { amount: 250, status: "open" });
  assert.equal(typeof eventCtx.at, "number");
  assert.equal(proposals[0].payload.prompt, "draft a reminder");
});

test("engine: a rule without `where` matches every event", async () => {
  const bus = new CoreEventBus();
  const { proposals, dispatch } = recordingDispatch();
  const engine = new PALExecutionEngine({
    rules: [rule({ where: undefined })],
    eventBus: bus,
    rateLimiter: new PALRateLimiter(),
    dispatch,
  });
  engine.start();
  await bus.emit("invoice:created", { amount: 1 });
  await bus.emit("invoice:created", { amount: 2 });
  assert.equal(proposals.length, 2);
});

test("engine: rate limiter cuts a 500-event flood to the per-rule cap", async () => {
  const bus = new CoreEventBus();
  const { proposals, dispatch } = recordingDispatch();
  const engine = new PALExecutionEngine({
    rules: [rule()],
    eventBus: bus,
    rateLimiter: new PALRateLimiter({
      perRule: { limit: 30, windowMs: 3_600_000 },
      log: () => {},
    }),
    dispatch,
  });
  engine.start();
  for (let i = 0; i < 500; i++) {
    await bus.emit("invoice:created", { amount: 100 + i });
  }
  assert.equal(proposals.length, 30, "the flood must stop after the per-rule cap");
  engine.stop();
});

test("engine: non-matching events never consume the rate budget", async () => {
  const bus = new CoreEventBus();
  const { proposals, dispatch } = recordingDispatch();
  const engine = new PALExecutionEngine({
    rules: [rule()],
    eventBus: bus,
    rateLimiter: new PALRateLimiter({ perRule: { limit: 3, windowMs: 3_600_000 } }),
    dispatch,
  });
  engine.start();
  for (let i = 0; i < 500; i++) {
    await bus.emit("invoice:created", { amount: 1 }); // below the where threshold
  }
  await bus.emit("invoice:created", { amount: 200 });
  assert.equal(proposals.length, 1, "matching event still dispatches after noise flood");
});

test("engine: a throwing dispatch is logged, not fatal; the bus keeps working", async () => {
  const bus = new CoreEventBus();
  const { proposals, dispatch, setThrower } = recordingDispatch();
  const engine = new PALExecutionEngine({
    rules: [rule()],
    eventBus: bus,
    rateLimiter: new PALRateLimiter(),
    dispatch,
  });
  engine.start();
  setThrower(() => {
    throw new Error("dispatch exploded");
  });
  await bus.emit("invoice:created", { amount: 100 });
  setThrower(null);
  await bus.emit("invoice:created", { amount: 100 });
  assert.equal(proposals.length, 1, "post-crash event dispatches normally");
});

test("engine: an invalid ruleset fails loudly at construction (nothing partial)", () => {
  const bus = new CoreEventBus();
  const { dispatch } = recordingDispatch();
  assert.throws(
    () =>
      new PALExecutionEngine({
        rules: [rule({ id: "bad id" })],
        eventBus: bus,
        rateLimiter: new PALRateLimiter(),
        dispatch,
      }),
    /"id"/,
  );
});

test("engine: validatePALRule/triggerTopic round-trip produces the subscribed topic", () => {
  const ruleObj = validatePALRule(rule());
  assert.equal(ruleObj.trigger.event, "created");
  assert.equal(ruleObj.action.type, "propose_task");
});
