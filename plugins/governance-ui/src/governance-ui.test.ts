import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  HookRegistry,
  StorageManager,
  TaskBroker,
  VaultManager,
  loadPlugin,
} from "@p2p-hub/core";

const pluginDir = path.resolve(__dirname, "..");

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p2p-hub-governance-ui-"));
  return dir;
}

test("governance-ui activates and describes its admin bridge skills", async () => {
  const dataDir = await makeTmpDir();
  try {
    const storage = new StorageManager(dataDir);
    const plugin = (await loadPlugin(
      pluginDir,
      storage,
      new HookRegistry(),
      new TaskBroker(),
      new VaultManager({ dataDir }),
    )) as { describe(): { id: string; adminSkills: string[] } };

    assert.ok(plugin, "plugin should activate");
    assert.equal(plugin.describe().id, "governance-ui");
    assert.deepEqual(plugin.describe().adminSkills, [
      "governance-ui.listPermissions",
      "governance-ui.registerSkills",
    ]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("governance-ui registers no broker skills itself (platform owns them)", async () => {
  const dataDir = await makeTmpDir();
  try {
    const broker = new TaskBroker();
    await loadPlugin(
      pluginDir,
      new StorageManager(dataDir),
      new HookRegistry(),
      broker,
      new VaultManager({ dataDir }),
    );
    assert.deepEqual(
      broker.listSkills().map((s) => s.skill),
      [],
      "the governance admin skills must be registered by core-server glue, never by the plugin",
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("governance-ui manifest ui.skills all carry matching network:http permissions", async () => {
  const raw = await fs.readFile(path.join(pluginDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as {
    id: string;
    permissions: string[];
    ui?: { skills?: string[] };
  };
  for (const skill of manifest.ui?.skills ?? []) {
    assert.ok(
      manifest.permissions.includes(`network:http:${manifest.id}.${skill.split(".").slice(1).join(".")}`),
      `ui.skills entry "${skill}" must have a matching network:http permission`,
    );
  }
});
