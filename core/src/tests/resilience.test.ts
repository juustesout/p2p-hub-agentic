import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileWriteQueue } from "../storage/queue";
import { VaultManager } from "../storage/vault-manager";
import {
  PluginHost,
  DEFAULT_ACTIVATION_TIMEOUT_MS,
} from "../plugin-host/plugin-host";

async function makeTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writePlugin(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  entrySource: string,
): Promise<void> {
  const dir = path.join(root, "plugins", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(dir, "index.mjs"), entrySource);
}

test("50 concurrent vault.setSecret calls commit every key", async () => {
  const dir = await makeTmpDir("resilience-vault-");
  const vault = new VaultManager({ dataDir: dir, masterKey: "test-master" });

  await Promise.all(
    Array.from({ length: 50 }, (_, i) => vault.setSecret(`key-${i}`, `value-${i}`)),
  );

  const keys = await vault.listSecretKeys();
  assert.equal(keys.length, 50, "no key may be dropped");
  for (let i = 0; i < 50; i++) {
    assert.equal(await vault.getSecret(`key-${i}`), `value-${i}`);
  }
});

test("FileWriteQueue serializes same-path tasks but lets distinct paths run", async () => {
  const dir = await makeTmpDir("resilience-queue-");
  const queue = new FileWriteQueue();
  const order: number[] = [];

  await Promise.all([
    queue.enqueue(path.join(dir, "p"), async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    }),
    queue.enqueue(path.join(dir, "p"), async () => {
      order.push(2);
    }),
  ]);

  assert.deepEqual(order, [1, 2], "second task must wait for the first");
});

test("default activation timeout is 5000ms", () => {
  assert.equal(DEFAULT_ACTIVATION_TIMEOUT_MS, 5000);
});

test("a hanging plugin times out without blocking other plugins", async () => {
  const root = await makeTmpDir("resilience-boot-");
  await writePlugin(
    root,
    "good",
    { id: "good", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() { return { ok: true }; }`,
  );
  await writePlugin(
    root,
    "hang",
    { id: "hang", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() { return new Promise(() => {}); }`,
  );

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    activationTimeoutMs: 50,
  });

  try {
    await host.boot();
  } finally {
    console.error = original;
  }

  assert.deepEqual(host.getActivated("good"), { ok: true });
  assert.equal(host.getActivated("hang"), undefined);
  assert.equal(host.pluginState("good"), "ACTIVE");
  assert.equal(host.pluginState("hang"), "FAILED_ACTIVATION_TIMEOUT");
  assert.ok(
    errors.some((m) => m.includes("hang") && m.includes("failed to activate")),
    "expected a timeout error log for the hanging plugin",
  );
});
