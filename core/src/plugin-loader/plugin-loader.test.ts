import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadManifest, loadPlugin } from "./plugin-loader";
import { StorageManager } from "../storage/storage-manager";
import { HookRegistry } from "../hooks/hook-registry";
import { TaskBroker } from "../task-broker/task-broker";
import { VaultManager } from "../storage/vault-manager";
import {
  collectPluginFileHashes,
  signManifest,
} from "@p2p-hub/sdk";

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

function makeSigningKey(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return typeof pem === "string" ? pem : pem.toString("utf8");
}

/** Sign a plugin dir: hash all shipped files, stamp signature + files map. */
async function signPluginDir(dir: string, privateKeyPem: string): Promise<void> {
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as Record<string, unknown>;
  manifest.files = await collectPluginFileHashes(dir);
  manifest.signature = signManifest(manifest, privateKeyPem);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
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

test("exposing a skill to the network requires a manifest permission", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginG = await writePlugin(
    root,
    "g",
    { id: "g", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.skills.register("x", async () => "y", { localOnly: false });
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(
    () => loadPlugin(pluginG, storageManager, new HookRegistry(), new TaskBroker()),
    /network:skill:g\.x/,
  );
});

test("exposing a skill to the network succeeds with the permission", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const taskBroker = new TaskBroker();

  const pluginG = await writePlugin(
    root,
    "g",
    { id: "g", version: "1.0.0", kind: "generic", permissions: ["network:skill:g.x"], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.skills.register("x", async () => "y", { localOnly: false });
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await loadPlugin(pluginG, storageManager, new HookRegistry(), taskBroker);

  assert.equal(taskBroker.hasSkill("g.x"), true);
});

test("loadManifest rejects a dotted plugin id (Fase 2C namespace fix)", async () => {
  const root = await makeTmpRoot();
  const dir = await writePlugin(
    root,
    "a.b",
    { id: "a.b", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() {}`,
  );

  // A dotted id could collide with plugin "a"'s skill "b.x"; dots are reserved
  // as the namespace delimiter and must be rejected structurally.
  await assert.rejects(() => loadManifest(dir), /"id"/);
});

test("a signed plugin loads and activates", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const key = makeSigningKey();

  const dir = await writePlugin(
    root,
    "signed-good",
    { id: "signed-good", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) { return { marker: "activated" }; }`,
  );
  await signPluginDir(dir, key);

  const storageManager = new StorageManager(dataDir);
  const result = (await loadPlugin(
    dir,
    storageManager,
    new HookRegistry(),
  )) as { marker: string };
  assert.equal(result.marker, "activated");

  const manifest = await loadManifest(dir);
  assert.equal(manifest.signature?.publicKey.length, 64);
});

test("a signed manifest with tampered fields is refused at load", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const key = makeSigningKey();

  const dir = await writePlugin(
    root,
    "signed-tampered",
    { id: "signed-tampered", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() {}`,
  );
  await signPluginDir(dir, key);

  // Tamper with a signed field (permissions) — the signature no longer covers
  // the manifest, so the plugin must be refused.
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as Record<string, unknown>;
  manifest.permissions = ["network:skill:signed-tampered.x"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(() => loadManifest(dir), /signature/);
});

test("a signed plugin with changed code is refused at load", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const key = makeSigningKey();

  const dir = await writePlugin(
    root,
    "signed-code-tampered",
    { id: "signed-code-tampered", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() {}`,
  );
  await signPluginDir(dir, key);

  // Change the shipped code after signing: content hashes must catch it.
  await fs.writeFile(path.join(dir, "index.mjs"), `export default function activate() { throw new Error("evil"); }`);

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(
    () => loadPlugin(dir, storageManager, new HookRegistry()),
    /content verification/,
  );
});

test("a signed manifest without a files map is refused at load", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const key = makeSigningKey();

  const dir = await writePlugin(
    root,
    "signed-nofiles",
    { id: "signed-nofiles", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() {}`,
  );
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as Record<string, unknown>;
  manifest.signature = signManifest(manifest, key);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(
    () => loadPlugin(dir, storageManager, new HookRegistry()),
    /unhashed file/,
  );
});


