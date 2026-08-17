import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost } from "@p2p-hub/core";

const vaultDir = path.resolve(__dirname, "..");

interface VaultApi {
  setSecret(key: string, value: string): Promise<void>;
  listKeys(): Promise<string[]>;
  deleteSecret(key: string): Promise<boolean>;
}

async function bootVault(dataDir: string, masterKey: string): Promise<{
  vault: VaultApi;
  host: PluginHost;
}> {
  // PluginHost scans subdirs; point it at a tmp dir containing only the
  // compiled vault plugin entry so we don't boot unrelated plugins.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-host-"));
  const target = path.join(root, "vault");
  await fs.mkdir(path.join(target, "dist"), { recursive: true });
  await fs.copyFile(path.join(vaultDir, "manifest.json"), path.join(target, "manifest.json"));
  await fs.copyFile(path.join(vaultDir, "dist", "index.js"), path.join(target, "dist", "index.js"));

  const host = new PluginHost({ pluginsDir: root, dataDir, masterKey });
  await host.boot();

  const vault = host.getActivated("vault") as VaultApi;
  return { vault, host };
}

test("vault skills set and list secrets without exposing values", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-data-"));
  const { vault, host } = await bootVault(dataDir, "test-master");

  await vault.setSecret("openai.key", "sk-secret-123");

  const keys = await vault.listKeys();
  assert.deepEqual(keys, ["openai.key"]);

  // The raw key never leaks through the plugin-facing API: only core can read it.
  const raw = host.vaultManager();
  assert.equal(await raw.getSecret("openai.key"), "sk-secret-123");
});

test("vault deleteSecret removes a key", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-data-"));
  const { vault } = await bootVault(dataDir, "test-master");

  await vault.setSecret("a", "1");
  await vault.setSecret("b", "2");
  assert.equal(await vault.deleteSecret("a"), true);
  assert.deepEqual(await vault.listKeys(), ["b"]);
});
