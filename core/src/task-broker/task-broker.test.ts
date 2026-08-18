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

test("skills are local-only by default and rejected over the network", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("vault.setSecret", async () => ({ ok: true }));

  const result = await broker.handleRemote(task({ skill: "vault.setSecret" }));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /local-only/);
});

test("handleRemote allows skills explicitly opted in to the network", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("calendar.listEvents", async () => [], {
    localOnly: false,
  });

  const result = await broker.handleRemote(
    task({ skill: "calendar.listEvents" }),
  );

  assert.equal(result.status, "ok");
  assert.deepEqual(result.result, []);
});

test("a local-only skill is still reachable via handle (local callers)", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("vault.setSecret", async (payload) => payload);

  const result = await broker.handle(
    task({ skill: "vault.setSecret", payload: "x" }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.result, "x");
});

test("skills are NOT HTTP-exposed by default and rejected by handleHttp", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("vault.setSecret", async () => ({ ok: true }));

  const result = await broker.handleHttp(task({ skill: "vault.setSecret" }));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not exposed over the HTTP bridge/);
});

test("handleHttp allows skills explicitly opted in to HTTP exposure", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("calc.recalc", async () => ({ ok: true }), {
    localOnly: true,
    httpExposed: true,
  });

  const result = await broker.handleHttp(task({ skill: "calc.recalc" }));

  assert.equal(result.status, "ok");
  assert.deepEqual(result.result, { ok: true });
});
