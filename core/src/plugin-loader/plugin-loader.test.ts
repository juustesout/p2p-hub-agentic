import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadManifest, loadPlugin } from "./plugin-loader";
import { StorageManager } from "../storage/storage-manager";
import { HookRegistry } from "../hooks/hook-registry";
import { TaskBroker } from "../task-broker/task-broker";
import { VaultManager } from "../storage/vault-manager";

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
  const hookRegistry = new HookRegistry();

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
  await loadPlugin(pluginA, storageManager, hookRegistry);
  const result = (await loadPlugin(pluginB, storageManager, hookRegistry)) as {
    readStorageOf: unknown;
  };

  assert.equal(result.readStorageOf, null);
});

test("plugin with storage:read permission can read another plugin's storage", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const hookRegistry = new HookRegistry();

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
  await loadPlugin(pluginA, storageManager, hookRegistry);
  const result = (await loadPlugin(pluginB, storageManager, hookRegistry)) as {
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

test("loadManifest rejects a plugin id containing path characters", async () => {
  const root = await makeTmpRoot();
  const dir = await writePlugin(
    root,
    "evil",
    { id: "../../other-plugin", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() {}`,
  );

  await assert.rejects(() => loadManifest(dir), /"id"/);
});

test("loadPlugin rejects an entry that escapes the plugin directory", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginD = await writePlugin(
    root,
    "d",
    { id: "d", version: "1.0.0", kind: "generic", permissions: [], entry: "../../escape.mjs" },
    `export default function activate() {}`,
  );

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(
    () => loadPlugin(pluginD, storageManager, new HookRegistry()),
    /escapes/,
  );
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
  const result = (await loadPlugin(
    pluginC,
    storageManager,
    new HookRegistry(),
  )) as { keys: string[] };

  assert.deepEqual(result.keys, ["../other-plugin/secret"]);

  const raw = JSON.parse(
    await fs.readFile(path.join(dataDir, "c.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(raw["../other-plugin/secret"], "leak-attempt");

  const escaped = path.join(dataDir, "..", "other-plugin", "secret");
  await assert.rejects(() => fs.access(escaped));
});

test("plugin cannot emit on another plugin's namespace", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginB = await writePlugin(
    root,
    "b",
    { id: "b", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      return { emit: () => ctx.hooks.emit("calendar:fake", {}) };
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  const result = (await loadPlugin(
    pluginB,
    storageManager,
    new HookRegistry(),
  )) as { emit(): Promise<void> };

  await assert.rejects(result.emit(), /cannot emit/);
});

test("plugin cannot applyFilters on another plugin's namespace", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginB = await writePlugin(
    root,
    "b",
    { id: "b", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      return { applyFilters: () => ctx.hooks.applyFilters("calendar:beforeSave", {}) };
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  const result = (await loadPlugin(
    pluginB,
    storageManager,
    new HookRegistry(),
  )) as { applyFilters(): Promise<unknown> };

  await assert.rejects(result.applyFilters(), /cannot applyFilters/);
});

test("cross-namespace filter requires permission and enriches calendar save", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const hookRegistry = new HookRegistry();
  const storageManager = new StorageManager(dataDir);

  const bNoPerm = await writePlugin(
    root,
    "b-noperm",
    { id: "b-noperm", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.hooks.registerFilter("calendar:beforeSave", (event) => event);
      return {};
    }`,
  );
  await assert.rejects(
    () => loadPlugin(bNoPerm, storageManager, hookRegistry),
    /hooks:filter:calendar:beforeSave/,
  );

  const bWithPerm = await writePlugin(
    root,
    "b-perm",
    { id: "b-perm", version: "1.0.0", kind: "generic", permissions: ["hooks:filter:calendar:beforeSave"], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.hooks.registerFilter("calendar:beforeSave", (event) => {
        if (!event.location) return { ...event, location: "unknown" };
        return event;
      });
      return {};
    }`,
  );
  await loadPlugin(bWithPerm, storageManager, hookRegistry);

  const calendarDir = path.resolve(__dirname, "../../../plugins/calendar");
  const calendar = (await loadPlugin(
    calendarDir,
    storageManager,
    hookRegistry,
  )) as {
    addEvent(event: { title: string; date: string }): Promise<Record<string, unknown>>;
  };

  const saved = await calendar.addEvent({ title: "Lunch", date: "2026-08-19" });
  assert.equal(saved.location, "unknown");
});

test("skills are registered under the plugin's own prefix", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const taskBroker = new TaskBroker();

  const pluginE = await writePlugin(
    root,
    "e",
    { id: "e", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.skills.register("x", async () => "y");
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await loadPlugin(pluginE, storageManager, new HookRegistry(), taskBroker);

  assert.equal(taskBroker.hasSkill("e.x"), true);
  assert.equal(taskBroker.hasSkill("x"), false);
});

test("plugins receive ctx.ai and get a VaultError when no key is configured", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginF = await writePlugin(
    root,
    "f",
    { id: "f", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      return { generate: () => ctx.ai.generateText({ prompt: "hi" }) };
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  const vaultManager = new VaultManager({
    dataDir: path.join(root, "vault"),
    masterKey: "test-master",
  });
  const result = (await loadPlugin(
    pluginF,
    storageManager,
    new HookRegistry(),
    new TaskBroker(),
    vaultManager,
  )) as { generate(): Promise<string> };

  await assert.rejects(result.generate(), /VaultError/);
});


