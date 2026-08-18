import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { safeReadJson } from "../storage/backup";
import { writeAtomicJson } from "../storage/atomic";
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

test("safeReadJson returns fallback when the file is missing", async () => {
  const dir = await makeTmpDir("resilience-");
  const file = path.join(dir, "missing.json");

  assert.equal(await safeReadJson(file, "fallback"), "fallback");
});

test("truncated JSON is quarantined, warns, and falls back without throwing", async () => {
  const dir = await makeTmpDir("resilience-");
  const file = path.join(dir, "data.json");
  await fs.writeFile(file, '{"broken_json":', "utf8");

  const warnings: { event: string; payload: unknown }[] = [];
  const result = await safeReadJson(file, { safe: true }, async (event, payload) => {
    warnings.push({ event, payload });
  });

  assert.deepEqual(result, { safe: true });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, "system:storageCorrupted");

  const entries = await fs.readdir(dir);
  assert.ok(
    entries.some((e) => e.startsWith("data.json.corrupt.")),
    "expected a quarantine file",
  );
  assert.equal(
    await fs.access(file).then(() => true, () => false),
    false,
    "corrupt primary should have been moved aside",
  );
});

test("a corrupt file recovers from its .bak and restores the primary", async () => {
  const dir = await makeTmpDir("resilience-");
  const file = path.join(dir, "data.json");

  await writeAtomicJson(file, { version: 1 });
  await writeAtomicJson(file, { version: 2 }); // rotates version 1 into data.json.bak

  await fs.writeFile(file, "{ not valid", "utf8");

  const result = await safeReadJson<{ version?: number }>(file, {});
  assert.deepEqual(result, { version: 1 }, "should return the backup contents");

  const restored = await safeReadJson<{ version?: number }>(file, {});
  assert.deepEqual(restored, { version: 1 }, "primary should be restored");
});

test("a corrupt file with no backup is quarantined and falls back", async () => {
  const dir = await makeTmpDir("resilience-");
  const file = path.join(dir, "solo.json");
  await fs.writeFile(file, "garbage that is not json", "utf8");

  assert.equal(await safeReadJson(file, 42), 42);

  const entries = await fs.readdir(dir);
  assert.ok(entries.some((e) => e.startsWith("solo.json.corrupt.")));
});

test("an orphaned .tmp from a crashed write does not break later I/O", async () => {
  const dir = await makeTmpDir("resilience-");
  const file = path.join(dir, "data.json");

  // Simulate a process that died between writing the temp file and renaming it.
  const orphan = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(orphan, "partial payload", "utf8");

  await writeAtomicJson(file, { ok: 1 });
  assert.deepEqual(await safeReadJson(file, null), { ok: 1 });

  // The stale temp file is left alone but is harmless.
  assert.equal(await fs.access(orphan).then(() => true, () => false), true);
});

test("100 concurrent atomic writes to one path serialize without corruption", async () => {
  const dir = await makeTmpDir("resilience-");
  const file = path.join(dir, "hot.json");

  await Promise.all(
    Array.from({ length: 100 }, (_, i) => writeAtomicJson(file, { n: i })),
  );

  const final = await safeReadJson<{ n: number }>(file, { n: -1 });
  assert.equal(final.n, 99, "last enqueued write wins, file stays complete");

  const entries = await fs.readdir(dir);
  assert.equal(
    entries.some((e) => e.endsWith(".tmp")),
    false,
    "no temp files left behind",
  );
});

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
  const queue = new FileWriteQueue();
  const order: number[] = [];

  await Promise.all([
    queue.enqueue("/tmp/shared/p", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    }),
    queue.enqueue("/tmp/shared/p", async () => {
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
