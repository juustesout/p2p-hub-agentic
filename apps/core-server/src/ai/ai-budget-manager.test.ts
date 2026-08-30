import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CoreServer } from "../app";
import { PluginHost } from "@p2p-hub/core";
import {
  AIQuotaExceededError,
  AI_QUOTA_EXCEEDED_ERROR_CODE,
  type AIBudgetGate,
} from "@p2p-hub/core";
import {
  AIBudgetManager,
  windowLabel,
  DEFAULT_GLOBAL_AI_LIMIT,
  DEFAULT_GLOBAL_AI_WINDOW_MS,
  DEFAULT_PER_PEER_AI_LIMIT,
  DEFAULT_PER_PEER_AI_WINDOW_MS,
} from "./ai-budget-manager";

const HOUR = 60 * 60 * 1000;

test("AIBudgetManager is an AIBudgetGate", () => {
  const manager: AIBudgetGate = new AIBudgetManager();
  assert.ok(manager);
});

test("allows up to the per-peer limit, then refuses with a typed error", () => {
  const manager = new AIBudgetManager({
    perPeer: { limit: 3, windowMs: HOUR },
  });
  manager.consume({ peerId: "peer-a" });
  manager.consume({ peerId: "peer-a" });
  manager.consume({ peerId: "peer-a" });
  assert.throws(
    () => manager.consume({ peerId: "peer-a" }),
    (err: unknown) => {
      assert.ok(err instanceof AIQuotaExceededError);
      assert.equal((err as AIQuotaExceededError).code, AI_QUOTA_EXCEEDED_ERROR_CODE);
      assert.match((err as Error).message, /peer "peer-a"/);
      return true;
    },
  );
});

test("the refused call is not recorded (a burst of refusals cannot extend the window)", () => {
  const manager = new AIBudgetManager({
    perPeer: { limit: 1, windowMs: HOUR },
  });
  manager.consume({ peerId: "peer-a" });
  assert.throws(() => manager.consume({ peerId: "peer-a" }), AIQuotaExceededError);
  assert.throws(() => manager.consume({ peerId: "peer-a" }), AIQuotaExceededError);
  // Refusals never added a slot: still exactly 1 recorded call.
  assert.equal(manager.peerUsage("peer-a"), 1);
});

test("time-window reset: after the window elapses the budget frees up", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const manager = new AIBudgetManager({
    perPeer: { limit: 2, windowMs: HOUR },
  });
  manager.consume({ peerId: "peer-a" });
  manager.consume({ peerId: "peer-a" });
  assert.throws(() => manager.consume({ peerId: "peer-a" }), AIQuotaExceededError);

  // One hour later the two recorded calls have slid out of the window.
  t.mock.timers.tick(HOUR);
  manager.consume({ peerId: "peer-a" });
  manager.consume({ peerId: "peer-a" });
  assert.throws(() => manager.consume({ peerId: "peer-a" }), AIQuotaExceededError);
});

test("the window slides: entries expire individually, not all at once", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const manager = new AIBudgetManager({
    perPeer: { limit: 1, windowMs: 60_000 },
  });

  // t=0: record one call.
  manager.consume({ peerId: "peer-a" });
  assert.equal(manager.peerUsage("peer-a"), 1);

  // t=30s: the call is still inside the 60s window → still refused.
  t.mock.timers.tick(30_000);
  assert.throws(() => manager.consume({ peerId: "peer-a" }), AIQuotaExceededError);

  // t=61s: the call (at t=0) is now outside the 60s window → freed.
  t.mock.timers.tick(31_000);
  manager.consume({ peerId: "peer-a" });
  assert.equal(manager.peerUsage("peer-a"), 1);
});

test("peers are isolated: one peer's usage never bleeds into another's", () => {
  const manager = new AIBudgetManager({
    perPeer: { limit: 2, windowMs: HOUR },
  });
  manager.consume({ peerId: "peer-a" });
  manager.consume({ peerId: "peer-a" });
  assert.throws(() => manager.consume({ peerId: "peer-a" }), AIQuotaExceededError);

  // peer-b has its own fresh budget.
  manager.consume({ peerId: "peer-b" });
  manager.consume({ peerId: "peer-b" });
  assert.equal(manager.peerUsage("peer-b"), 2);
});

test("local/HTTP callers without a peerId share one budget", () => {
  const manager = new AIBudgetManager({
    perPeer: { limit: 2, windowMs: HOUR },
  });
  manager.consume();
  manager.consume({});
  assert.throws(() => manager.consume({}), AIQuotaExceededError);
  // A real transport peer is not affected by the anonymous callers.
  manager.consume({ peerId: "peer-a" });
});

test("node-wide failsafe caps aggregate spend across different peers", () => {
  const manager = new AIBudgetManager({
    perPeer: { limit: 100, windowMs: HOUR },
    global: { limit: 3, windowMs: 60_000 },
  });
  manager.consume({ peerId: "peer-a" });
  manager.consume({ peerId: "peer-b" });
  manager.consume({ peerId: "peer-c" });
  assert.equal(manager.globalUsage(), 3);
  // A fourth peer is individually far below its own cap but the node-wide
  // failsafe is exhausted.
  assert.throws(
    () => manager.consume({ peerId: "peer-d" }),
    (err: unknown) => {
      assert.ok(err instanceof AIQuotaExceededError);
      assert.match((err as Error).message, /node-wide/);
      return true;
    },
  );
});

test("node-wide window also resets with time", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const manager = new AIBudgetManager({
    perPeer: { limit: 100, windowMs: HOUR },
    global: { limit: 1, windowMs: 60_000 },
  });
  manager.consume({ peerId: "peer-a" });
  assert.throws(() => manager.consume({ peerId: "peer-b" }), AIQuotaExceededError);
  t.mock.timers.tick(60_001);
  manager.consume({ peerId: "peer-b" });
});

test("the error carries the stable machine-readable code", () => {
  const manager = new AIBudgetManager({
    perPeer: { limit: 0 + 1, windowMs: HOUR },
  });
  manager.consume({ peerId: "peer-a" });
  try {
    manager.consume({ peerId: "peer-a" });
    assert.fail("expected AIQuotaExceededError");
  } catch (err) {
    assert.ok(err instanceof AIQuotaExceededError);
    assert.equal(err.name, "AIQuotaExceededError");
    assert.equal(err.code, AI_QUOTA_EXCEEDED_ERROR_CODE);
  }
});

test("reset() drops all recorded budget state", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const manager = new AIBudgetManager({
    perPeer: { limit: 1, windowMs: HOUR },
    global: { limit: 1, windowMs: 60_000 },
  });
  manager.consume({ peerId: "peer-a" });
  assert.throws(() => manager.consume({ peerId: "peer-a" }), AIQuotaExceededError);
  manager.reset();
  manager.consume({ peerId: "peer-a" });
  assert.equal(manager.peerUsage("peer-a"), 1);
});

test("fail-closed defaults are positive and sane", () => {
  // The defaults themselves form the documented anti-DoS posture: 10
  // req/peer/hour plus a 30 req/node/minute failsafe.
  assert.equal(DEFAULT_PER_PEER_AI_LIMIT, 10);
  assert.equal(DEFAULT_PER_PEER_AI_WINDOW_MS, HOUR);
  assert.equal(DEFAULT_GLOBAL_AI_LIMIT, 30);
  assert.equal(DEFAULT_GLOBAL_AI_WINDOW_MS, 60_000);

  const manager = new AIBudgetManager();
  manager.consume({ peerId: "peer-a" });
  assert.equal(manager.peerUsage("peer-a"), 1);
});

test("invalid config values fall back to the fail-closed defaults", () => {
  const manager = new AIBudgetManager({
    perPeer: { limit: 0, windowMs: -1 },
    global: { limit: NaN, windowMs: 0 },
  });
  // Defaults apply, so a single peer can make its first call fine.
  manager.consume({ peerId: "peer-a" });
  assert.equal(manager.peerUsage("peer-a"), 1);
});

test("windowLabel renders human-readable windows", () => {
  assert.equal(windowLabel(60 * 60 * 1000), "1h");
  assert.equal(windowLabel(2 * 60 * 60 * 1000), "2h");
  assert.equal(windowLabel(60 * 1000), "1m");
  assert.equal(windowLabel(30 * 1000), "30s");
  assert.equal(windowLabel(1_000), "1s");
});

const E2E_TOKEN = "ai-budget-e2e-token";

test("HTTP /api/execute maps an over-quota AI call to a controlled 429 without reaching the LLM", async () => {
  // Mock LLM endpoint that counts every inbound request.
  let llmCalls = 0;
  const llm = http.createServer((_req, res) => {
    llmCalls += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }] }));
  });
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
  const llmPort = (llm.address() as { port: number }).port;

  const dataDir = await fs.mkdtemp(path.join("/tmp", "ai-budget-e2e-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });

  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: E2E_TOKEN,
    masterKey: "e2e-master-key",
    aiBudget: { perPeer: { limit: 1, windowMs: 60_000 } },
  });
  await server.start();
  const port = server.address()!.port;
  try {
    // Point the AI provider at the mock LLM directly — the `ai.*` vault
    // namespace is reserved on the HTTP bridge (principle #5), so it is
    // configured in-process, exactly like the operator would.
    const host = (server as unknown as { host: PluginHost }).host;
    await host.vaultManager().setSecret(
      "ai.baseUrl",
      `http://127.0.0.1:${llmPort}/v1`,
    );

    const exec = async (args: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${E2E_TOKEN}`,
        },
        body: JSON.stringify({
          serviceId: "core",
          method: "ai.generateText",
          arguments: args,
        }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    // First call: within the per-peer budget, reaches the LLM once.
    const first = await exec({ prompt: "hi" });
    assert.equal(first.status, 200);
    assert.equal(first.body.result, "hello");
    assert.equal(llmCalls, 1);

    // Second call: over the per-peer budget → controlled 429, LLM untouched.
    const second = await exec({ prompt: "hi again" });
    assert.equal(second.status, 429);
    assert.equal(second.body.status, "error");
    assert.equal(second.body.code, AI_QUOTA_EXCEEDED_ERROR_CODE);
    assert.match(String(second.body.error), /peer "<local>"/);
    assert.equal(llmCalls, 1, "the over-quota call must never reach the LLM");
  } finally {
    await server.stop();
    await new Promise<void>((resolve) => llm.close(() => resolve()));
  }
});
