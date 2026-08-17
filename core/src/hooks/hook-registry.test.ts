import { test } from "node:test";
import assert from "node:assert/strict";
import { HookRegistry } from "./hook-registry";

test("actions run in priority order, lowest priority first", async () => {
  const registry = new HookRegistry();
  const order: string[] = [];

  registry.on("demo:event", () => { order.push("high"); }, 20);
  registry.on("demo:event", () => { order.push("low"); }, 5);
  registry.on("demo:event", () => { order.push("default"); }, 10);

  await registry.emit("demo:event", null);

  assert.deepEqual(order, ["low", "default", "high"]);
});

test("filters transform the value through an ordered chain", async () => {
  const registry = new HookRegistry();

  registry.registerFilter("demo:num", (value) => (value as number) * 2, 10);
  registry.registerFilter("demo:num", (value) => (value as number) + 1, 20);

  const result = await registry.applyFilters("demo:num", 3);

  assert.equal(result, 7);
});

test("a throwing action handler does not block later handlers", async () => {
  const registry = new HookRegistry();
  const calls: string[] = [];

  registry.on(
    "demo:event",
    () => {
      throw new Error("boom");
    },
    5,
  );
  registry.on("demo:event", () => { calls.push("second"); }, 10);

  await registry.emit("demo:event", null);

  assert.deepEqual(calls, ["second"]);
});

test("a throwing filter propagates to the caller", async () => {
  const registry = new HookRegistry();

  registry.registerFilter("demo:num", () => {
    throw new Error("filter failure");
  });

  await assert.rejects(() => registry.applyFilters("demo:num", 1), /filter failure/);
});
