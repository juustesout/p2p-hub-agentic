import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentAnycastProvider } from "./agentanycast-provider";

test("checkStatus reports not-installed when daemon is absent", async () => {
  const provider = new AgentAnycastProvider();
  const status = await provider.checkStatus();
  assert.equal(status, "not-installed");
});

test("start/isReady reflect the daemon state", async () => {
  const provider = new AgentAnycastProvider();
  assert.equal(provider.isReady(), false);

  await provider.start();

  assert.equal(provider.isReady(), false);

  await provider.stop();
  assert.equal(provider.isReady(), false);
});
