import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkLightProvider } from "./network-light-provider";
import type { NetworkPeer } from "@p2p-hub/sdk";

async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null | undefined;
  while (Date.now() < deadline) {
    last = await check();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

test("two local instances discover each other and exchange a task", async () => {
  const alice = new NetworkLightProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({ port: 0, skills: ["echo"] });

  bob.onTask(async (task) => ({
    taskId: task.id,
    status: "ok",
    result: `pong:${String(task.payload)}`,
  }));

  await alice.start();
  await bob.start();

  try {
    assert.equal(alice.isReady(), true);
    assert.equal(bob.isReady(), true);

    const peers = await waitFor<NetworkPeer[]>(async () => {
      const found = await alice.discover("echo");
      return found.length > 0 ? found : null;
    });

    assert.equal(peers.length, 1);
    assert.equal(peers[0].skills.includes("echo"), true);

    const result = await alice.sendTask(peers[0], {
      id: "task-1",
      skill: "echo",
      payload: "hello",
    });

    assert.equal(result.status, "ok");
    assert.equal(result.result, "pong:hello");
  } finally {
    await alice.stop();
    await bob.stop();
  }
});
