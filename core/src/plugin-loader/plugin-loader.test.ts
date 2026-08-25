import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadManifest, loadPlugin } from "./plugin-loader";
import { IdentityManager } from "../identity/identity-manager";
import { StorageManager } from "../storage/storage-manager";
import { HookRegistry } from "../hooks/hook-registry";
import { TaskBroker } from "../task-broker/task-broker";
import { VaultManager } from "../storage/vault-manager";
import { AccessPassManager } from "../task-broker/access-pass-manager";
import { DisposerBag } from "../disposable";
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

test("Fase 2B: plugin dataDir is scoped to its own subfolder, not the host data dir", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginD = await writePlugin(
    root,
    "d",
    { id: "d", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      return { dataDir: ctx.dataDir, inside: ctx.isPathInsideDataDir(ctx.dataDir) };
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  const result = (await loadPlugin(
    pluginD,
    storageManager,
    new HookRegistry(),
  )) as { dataDir: string; inside: boolean };

  const scoped = path.join(dataDir, "plugins", "d");
  assert.equal(result.dataDir, scoped);
  assert.equal(result.inside, true);

  // The scoped folder must exist so the plugin can write into it directly.
  await fs.access(scoped);

  // The host data dir itself, and any sibling plugin folder, must never be
  // reachable through the scoped dataDir.
  assert.notEqual(result.dataDir, dataDir);
  assert.ok(!result.dataDir.startsWith(path.join(dataDir, "plugins", "e")));
});

test("Fase 2B: isPathInsideDataDir checks the host data dir, not the plugin scoped folder", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);

  const pluginD = await writePlugin(
    root,
    "d",
    { id: "d", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      return {
        hostInside: ctx.isPathInsideDataDir(ctx.dataDir),
        siblingInside: ctx.isPathInsideDataDir(${JSON.stringify(path.join(dataDir, "plugins", "other"))}),
        outside: ctx.isPathInsideDataDir(${JSON.stringify(outside)}),
      };
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  const result = (await loadPlugin(
    pluginD,
    storageManager,
    new HookRegistry(),
  )) as { hostInside: boolean; siblingInside: boolean; outside: boolean };

  assert.equal(result.hostInside, true);
  assert.equal(result.siblingInside, true);
  assert.equal(result.outside, false);
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

test("Fase 2B: cross-namespace hooks.on requires an explicit hooks:on permission", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const hookRegistry = new HookRegistry();
  const storageManager = new StorageManager(dataDir);

  const bNoPerm = await writePlugin(
    root,
    "b-noperm",
    { id: "b-noperm", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.hooks.on("calendar:eventAdded", () => {});
      return {};
    }`,
  );
  await assert.rejects(
    () => loadPlugin(bNoPerm, storageManager, hookRegistry),
    /hooks:on:calendar:eventAdded/,
  );

  const bWithPerm = await writePlugin(
    root,
    "b-perm",
    { id: "b-perm", version: "1.0.0", kind: "generic", permissions: ["hooks:on:calendar:eventAdded"], entry: "./index.mjs" },
    `export default function activate(ctx) {
      let seen = null;
      ctx.hooks.on("calendar:eventAdded", (payload) => { seen = payload; });
      return { seen: () => seen };
    }`,
  );
  const bResult = (await loadPlugin(
    bWithPerm,
    storageManager,
    hookRegistry,
  )) as { seen: () => unknown };

  const calendarDir = path.resolve(__dirname, "../../../plugins/calendar");
  const calendar = (await loadPlugin(
    calendarDir,
    storageManager,
    hookRegistry,
  )) as {
    addEvent(event: { title: string; date: string }): Promise<Record<string, unknown>>;
  };

  await calendar.addEvent({ title: "Meeting", date: "2026-08-20" });
  const seen = await bResult.seen();
  assert.ok(seen !== null, "cross-namespace listener should have received the event");
});

test("Fase 2B: own-namespace hooks.on needs no permission (delimiter-anchored)", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginH = await writePlugin(
    root,
    "h",
    { id: "h", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      // Own namespace: free. The prefix must be delimiter-anchored so a
      // plugin named "h" does not accidentally match event "h-evil:x".
      ctx.hooks.on("h:ownEvent", () => {});
      ctx.hooks.on("h-evil:x", () => {});
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(
    () => loadPlugin(pluginH, storageManager, new HookRegistry()),
    /hooks:on:h-evil:x/,
  );
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

test("Fase 2A: a skill gated 'any' requires the network:public permission", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginG = await writePlugin(
    root,
    "g",
    { id: "g", version: "1.0.0", kind: "generic", permissions: ["network:skill:g.x"], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.skills.register("x", async () => "y", { localOnly: false, remote: { gate: "any" } });
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(
    () => loadPlugin(pluginG, storageManager, new HookRegistry(), new TaskBroker()),
    /network:public:g\.x/,
  );
});

test("Fase 2A: a skill gated 'any' loads when the network:public permission is present", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const taskBroker = new TaskBroker();

  const pluginG = await writePlugin(
    root,
    "g",
    { id: "g", version: "1.0.0", kind: "generic", permissions: ["network:skill:g.x", "network:public:g.x"], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.skills.register("x", async () => "y", { localOnly: false, remote: { gate: "any" } });
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await loadPlugin(pluginG, storageManager, new HookRegistry(), taskBroker);

  const skills = taskBroker.listSkills();
  const skill = skills.find((s) => s.skill === "g.x");
  assert.ok(skill, "g.x should be registered");
  assert.deepEqual(skill.remote, { gate: "any" });
});

test("Fase 2B: exposing a skill to the HTTP bridge requires a network:http permission", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginG = await writePlugin(
    root,
    "g",
    { id: "g", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.skills.register("x", async () => "y", { httpExposed: true });
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(
    () => loadPlugin(pluginG, storageManager, new HookRegistry(), new TaskBroker()),
    /network:http:g\.x/,
  );
});

test("Fase 2B: an httpExposed skill loads when the network:http permission is present", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const taskBroker = new TaskBroker();

  const pluginG = await writePlugin(
    root,
    "g",
    { id: "g", version: "1.0.0", kind: "generic", permissions: ["network:http:g.x"], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.skills.register("x", async () => "y", { httpExposed: true });
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await loadPlugin(pluginG, storageManager, new HookRegistry(), taskBroker);

  const skills = taskBroker.listSkills();
  const skill = skills.find((s) => s.skill === "g.x");
  assert.ok(skill, "g.x should be registered");
  assert.equal(skill.httpExposed, true);
});

test("httpBridgeOnly requires the same network:http permission as httpExposed", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const pluginG = await writePlugin(
    root,
    "g",
    { id: "g", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.skills.register("x", async () => "y", { httpBridgeOnly: true });
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(
    () => loadPlugin(pluginG, storageManager, new HookRegistry(), new TaskBroker()),
    /network:http:g\.x/,
  );
});

test("httpBridgeOnly loads with the network:http permission and normalizes the record", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const taskBroker = new TaskBroker();

  const pluginG = await writePlugin(
    root,
    "g",
    { id: "g", version: "1.0.0", kind: "generic", permissions: ["network:http:g.x"], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.skills.register("x", async () => "y", { httpBridgeOnly: true });
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await loadPlugin(pluginG, storageManager, new HookRegistry(), taskBroker);

  const skill = taskBroker.listSkills().find((s) => s.skill === "g.x");
  assert.ok(skill, "g.x should be registered");
  assert.equal(skill.httpBridgeOnly, true);
  assert.equal(skill.httpExposed, true);
  assert.equal(skill.localOnly, true);

  const remote = await taskBroker.handleRemote({ id: "t", skill: "g.x", payload: null });
  assert.equal(remote.status, "error");
  assert.match(remote.error ?? "", /local-only/);
});

test("Fase 2B: httpExposed and network exposure permissions are independent", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  // A skill that is both http-exposed and network-exposed needs both
  // permissions; the network:http permission alone must not open the network.
  const pluginG = await writePlugin(
    root,
    "g",
    { id: "g", version: "1.0.0", kind: "generic", permissions: ["network:http:g.x"], entry: "./index.mjs" },
    `export default function activate(ctx) {
      ctx.skills.register("x", async () => "y", { localOnly: false, httpExposed: true });
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(
    () => loadPlugin(pluginG, storageManager, new HookRegistry(), new TaskBroker()),
    /network:skill:g\.x/,
  );
});

test("Fase 2A: ctx.access is exposed and backed by the shared pass store", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const access = new AccessPassManager();

  const pluginG = await writePlugin(
    root,
    "g",
    { id: "g", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
      return {
        issue: () => ctx.access.issue("a".repeat(64), "site-read-only"),
        hasPass: () => ctx.access.hasPass("a".repeat(64), "site-read-only"),
      };
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  const api = (await loadPlugin(
    pluginG,
    storageManager,
    new HookRegistry(),
    new TaskBroker(),
    new VaultManager(),
    undefined,
    null,
    new DisposerBag(),
    null,
    access,
  )) as { issue(): Promise<{ ok: boolean }>; hasPass(): Promise<boolean> };

  const issued = await api.issue();
  assert.deepEqual(issued, { ok: true });
  assert.equal(await api.hasPass(), true);
  assert.equal(access.hasValidPass("a".repeat(64), "site-read-only"), true);
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

test("identity capability signs `domain || data`, never raw caller-chosen bytes", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const dir = await writePlugin(
    root,
    "sig-domain",
    { id: "sig-domain", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default async function activate(ctx) {
      const peerId = await ctx.identity.peerId();
      const signature = await ctx.identity.sign("my-protocol:v1:", Buffer.from("payload"));
      return { peerId, signature: signature.toString("hex") };
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  const result = (await loadPlugin(dir, storageManager, new HookRegistry())) as {
    peerId: string;
    signature: string;
  };

  const peerId = result.peerId;
  const signature = Buffer.from(result.signature, "hex");

  // Signature must verify against the domain-prefixed bytes ...
  assert.equal(
    IdentityManager.verify(
      peerId,
      Buffer.concat([Buffer.from("my-protocol:v1:", "utf8"), Buffer.from("payload")]),
      signature,
    ),
    true,
  );

  // ... and must NOT verify against the bare payload (a raw signer would pass
  // this check — structural domain separation must prevent it).
  assert.equal(
    IdentityManager.verify(peerId, Buffer.from("payload"), signature),
    false,
  );

  // A signature minted under one domain never verifies under another.
  assert.equal(
    IdentityManager.verify(
      peerId,
      Buffer.concat([Buffer.from("other-protocol:v1:", "utf8"), Buffer.from("payload")]),
      signature,
    ),
    false,
  );
});

test("Fase 2B: loadPlugin rejects a ui.entry that escapes the plugin directory", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");

  const dir = await writePlugin(
    root,
    "ui-escape",
    {
      id: "ui-escape",
      version: "1.0.0",
      kind: "generic",
      permissions: [],
      entry: "./index.mjs",
      ui: { entry: "../../outside/index.html" },
    },
    `export default function activate() {}`,
  );

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(
    () => loadPlugin(dir, storageManager, new HookRegistry()),
    /ui.entry.*escapes/,
  );
});

test("Fase 2B: ui.skills entries must live in the plugin's own namespace", async () => {
  const root = await makeTmpRoot();

  const dir = await writePlugin(
    root,
    "ui-ns",
    {
      id: "ui-ns",
      version: "1.0.0",
      kind: "generic",
      permissions: [],
      entry: "./index.mjs",
      ui: { entry: "ui/index.html", skills: ["calendar:eventAdded", "other.x"] },
    },
    `export default function activate() {}`,
  );

  await assert.rejects(() => loadManifest(dir), /own namespace/);
});

test("Fase 2B: ui.skills entries must have a matching network:http permission", async () => {
  const root = await makeTmpRoot();

  const dir = await writePlugin(
    root,
    "ui-http",
    {
      id: "ui-http",
      version: "1.0.0",
      kind: "generic",
      permissions: [],
      entry: "./index.mjs",
      ui: { entry: "ui/index.html", skills: ["ui-http.list"] },
    },
    `export default function activate() {}`,
  );

  await assert.rejects(() => loadManifest(dir), /network:http:ui-http\.list/);
});

test("Fase 2B: a UI with a matching skills allowlist loads and exposes it", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const taskBroker = new TaskBroker();

  const dir = await writePlugin(
    root,
    "ui-ok",
    {
      id: "ui-ok",
      version: "1.0.0",
      kind: "generic",
      permissions: ["network:http:ui-ok.list"],
      entry: "./index.mjs",
      ui: {
        entry: "ui/index.html",
        skills: ["ui-ok.list"],
        defaultWidth: 500,
      },
    },
    `export default function activate(ctx) {
      ctx.skills.register("list", async () => ["a"], { httpExposed: true });
      return {};
    }`,
  );

  const storageManager = new StorageManager(dataDir);
  const manifest = await loadManifest(dir);
  await loadPlugin(dir, storageManager, new HookRegistry(), taskBroker);

  assert.deepEqual(manifest.ui?.skills, ["ui-ok.list"]);
  assert.equal(taskBroker.hasSkill("ui-ok.list"), true);
});

test("a plugin entry that is a symlink escaping the directory is rejected", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const outside = path.join(root, "outside.js");
  await fs.writeFile(outside, `export default async function activate() {}`);

  const dir = await writePlugin(
    root,
    "linky",
    {
      id: "linky",
      version: "1.0.0",
      kind: "generic",
      permissions: [],
      entry: "./index.mjs",
    },
    `export default async function activate() {}`,
  );
  // Replace the entry with a symlink pointing outside the plugin directory.
  await fs.rm(path.join(dir, "index.mjs"));
  await fs.symlink(outside, path.join(dir, "index.mjs"));

  const storageManager = new StorageManager(dataDir);
  await assert.rejects(
    () => loadPlugin(dir, storageManager, new HookRegistry()),
    /symlink.*resolves outside the plugin directory/,
  );
});

test("a symlink inside the plugin directory that stays inside is allowed", async () => {
  const root = await makeTmpRoot();
  const dataDir = path.join(root, "data");
  const taskBroker = new TaskBroker();

  const dir = await writePlugin(
    root,
    "linksafe",
    {
      id: "linksafe",
      version: "1.0.0",
      kind: "generic",
      permissions: [],
      entry: "./index.mjs",
    },
    `export default async function activate(ctx) {
      ctx.skills.register("ok", async () => "works", {});
      return {};
    }`,
  );
  // A self-referential (in-dir) symlink must not trip the scan.
  await fs.symlink("index.mjs", path.join(dir, "alias.mjs"));

  const storageManager = new StorageManager(dataDir);
  await loadPlugin(dir, storageManager, new HookRegistry(), taskBroker);
  assert.equal(taskBroker.hasSkill("linksafe.ok"), true);
});


