import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { NetworkPeer } from "@p2p-hub/sdk";
import {
  NetworkTimeoutError,
  isTransientError,
  withTimeout,
  withRetry,
} from "../network/retry";
import { PeerRegistry, startPeerSweeper } from "../network/peer-registry";
import { PluginHost } from "../plugin-host/plugin-host";

function transientError(code: string): Error {
  return Object.assign(new Error(`connection ${code}`), { code });
}

test("withTimeout rejects with NetworkTimeoutError when a call hangs", async () => {
  const never = new Promise<never>(() => undefined);
  await assert.rejects(
    withTimeout(never, 20),
    NetworkTimeoutError,
  );
});

test("withTimeout resolves the value of a fast call", async () => {
  const value = await withTimeout(Promise.resolve(42), 1000);
  assert.equal(value, 42);
});

test("withTimeout rejects with the underlying error on failure", async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error("boom")), 1000),
    /boom/,
  );
});

test("isTransientError flags timeouts and connection drops only", () => {
  assert.equal(isTransientError(new NetworkTimeoutError(10)), true);
  assert.equal(isTransientError(transientError("ECONNRESET")), true);
  assert.equal(isTransientError(transientError("ETIMEDOUT")), true);
  assert.equal(isTransientError(transientError("ECONNREFUSED")), true);
  assert.equal(isTransientError(new Error("boom")), false);
});

test("withRetry retries transient connection drops until success", async () => {
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw transientError("ECONNRESET");
      }
      return "ok";
    },
    { maxRetries: 3, initialDelayMs: 1, factor: 2 },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("withRetry gives up after maxRetries and rethrows the last error", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw transientError("ETIMEDOUT");
      },
      { maxRetries: 2, initialDelayMs: 1, factor: 2 },
    ),
    (err: unknown) => (err as { code?: string }).code === "ETIMEDOUT",
  );
  assert.equal(attempts, 3);
});

test("withRetry does not retry non-transient failures", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw new Error("boom");
      },
      { maxRetries: 3, initialDelayMs: 1 },
    ),
    /boom/,
  );
  assert.equal(attempts, 1);
});

test("PeerRegistry prunes peers silent past the TTL and reports each", () => {
  const pruned: NetworkPeer[] = [];
  const registry = new PeerRegistry((peer) => pruned.push(peer));
  const peerA: NetworkPeer = { id: "a", address: "127.0.0.1:1", skills: ["x"] };
  const peerB: NetworkPeer = { id: "b", address: "127.0.0.1:2", skills: ["x"] };

  registry.upsert(peerA, 1000);
  registry.upsert(peerB, 1000);
  registry.touch("b", 40_000);

  const removed = registry.pruneStale(50_000, 30_000);

  assert.deepEqual(removed.map((p) => p.id), ["a"]);
  assert.deepEqual(pruned.map((p) => p.id), ["a"]);
  assert.equal(registry.size(), 1);
  assert.equal(registry.get("a"), undefined);
  assert.equal(registry.get("b")?.id, "b");
});

test("PeerRegistry does not prune a peer exactly at the TTL boundary", () => {
  const registry = new PeerRegistry();
  registry.upsert({ id: "a", address: "127.0.0.1:1", skills: [] }, 0);
  const removed = registry.pruneStale(30_000, 30_000);
  assert.deepEqual(removed, []);
  assert.equal(registry.size(), 1);
});

test("startPeerSweeper returns a Disposable that clears its timer", () => {
  const registry = new PeerRegistry();
  const disposable = startPeerSweeper(registry, 5);
  assert.doesNotThrow(() => disposable.dispose());
  assert.doesNotThrow(() => disposable.dispose());
});

test("deactivating a plugin releases every hook listener and timer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "network-resilience-"));
  const dir = path.join(root, "plugins", "hooks");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "hooks",
      version: "1.0.0",
      kind: "generic",
      permissions: [],
      entry: "./index.mjs",
    }),
  );
  await fs.writeFile(
    path.join(dir, "index.mjs"),
    `
      export default function activate(ctx) {
        const cleanupState = { ran: false };
        for (let i = 0; i < 50; i++) {
          ctx.hooks.on("hooks:e" + i, () => {});
          ctx.hooks.registerFilter("hooks:f" + i, (v) => v);
        }
        ctx.timers.setInterval(() => {}, 60_000);
        ctx.onDispose(() => { cleanupState.ran = true; });
        return { cleanupState };
      }
    `,
  );

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
  });

  await host.boot();

  const activated = host.getActivated("hooks") as {
    cleanupState: { ran: boolean };
  };

  try {
    assert.equal(host.hookRegistry().listenerCount(), 50);
  } finally {
    await host.deactivate("hooks");
  }

  assert.equal(host.hookRegistry().listenerCount(), 0);
  assert.equal(activated.cleanupState.ran, true);
  assert.equal(host.getActivated("hooks"), undefined);
});
