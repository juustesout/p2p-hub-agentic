import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadManifest, loadPlugin } from "./plugin-loader";
import { StorageManager } from "../storage/storage-manager";

async function makeTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "plugin-loader-"));
}

async function writePlugin(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  entrySource: string,
): Promise<string> {
  const dir = path.join(root, "plugins", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await fs.writeFile(path.join(dir, "index.mjs"), entrySource);
  return dir;
}

test("plugin without storage:read permission cannot read another plugin's storage", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginA = await writePlugin(
    root,
    "a",
    { id: "a", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default async function activate(ctx) {
      await ctx.storage.set("greeting", "hello from a");
      return { ok: true };
    }`,
  );
  const pluginB = await writePlugin(
    root,
    "b",
    { id: "b", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      return { readStorageOf: ctx.readStorageOf("a") };
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await loadPlugin(pluginA, storageManager);
  const result = (await loadPlugin(pluginB, storageManager)) as {
    readStorageOf: unknown;
  };

  assert.equal(result.readStorageOf, null);
});

test("plugin with storage:read permission can read another plugin's storage", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginA = await writePlugin(
    root,
    "a",
    { id: "a", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default async function activate(ctx) {
      await ctx.storage.set("greeting", "hello from a");
      return { ok: true };
    }`,
  );
  const pluginB = await writePlugin(
    root,
    "b",
    { id: "b", version: "1.0.0", kind: "generic", permissions: ["storage:read:a"], entry: "./index.mjs" },
    `export default function activate(ctx) {
      return { readStorageOf: ctx.readStorageOf("a") };
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await loadPlugin(pluginA, storageManager);
  const result = (await loadPlugin(pluginB, storageManager)) as {
    readStorageOf: { get(key: string): Promise<unknown> } | null;
  };

  assert.notEqual(result.readStorageOf, null);
  assert.equal(await result.readStorageOf!.get("greeting"), "hello from a");
});

test("loadManifest rejects a manifest with missing required fields", async () => {
  const root = await makeTmpRoot();
  const dir = await writePlugin(
    root,
    "broken",
    { version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() {}`,
  );

  await assert.rejects(() => loadManifest(dir), /"id"/);
});

test("storage keys are not interpreted as filesystem paths", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginC = await writePlugin(
    root,
    "c",
    { id: "c", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default async function activate(ctx) {
      await ctx.storage.set("../other-plugin/secret", "leak-attempt");
      return { keys: await ctx.storage.list() };
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  const result = (await loadPlugin(pluginC, storageManager)) as { keys: string[] };

  assert.deepEqual(result.keys, ["../other-plugin/secret"]);

  const raw = JSON.parse(
    await fs.readFile(path.join(dataDir, "c.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(raw["../other-plugin/secret"], "leak-attempt");

  const escaped = path.join(dataDir, "..", "other-plugin", "secret");
  await assert.rejects(() => fs.access(escaped));
});
