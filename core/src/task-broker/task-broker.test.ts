import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskBroker } from "./task-broker";
import type { TaskRequest } from "@p2p-hub/sdk";

function task(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    id: "task-1",
    skill: "demo.echo",
    payload: "hello",
    ...overrides,
  };
}

test("handle routes a task to the registered skill", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("demo.echo", async (payload) => `pong:${String(payload)}`);

  const result = await broker.handle(task());

  assert.equal(result.status, "ok");
  assert.equal(result.result, "pong:hello");
});

test("an unknown skill returns an error result without throwing", async () => {
  const broker = new TaskBroker();

  const result = await broker.handle(task({ skill: "demo.missing" }));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /no skill registered for "demo.missing"/);
});

test("a throwing handler is caught and returned as an error result", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("demo.broken", async () => {
    throw new Error("kaboom");
  });

  const result = await broker.handle(task({ skill: "demo.broken" }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "kaboom");
});
