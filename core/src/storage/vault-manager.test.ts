import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VaultManager } from "./vault-manager";
import { StorageCorruptionError } from "./atomic-write";

async function makeDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vault-"));
}

test("secrets round-trip through encryption", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "test-master" });

  await vault.setSecret("openai.key", "sk-secret-123");
  assert.equal(await vault.getSecret("openai.key"), "sk-secret-123");
});

test("secrets are stored encrypted, never as plaintext", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "test-master" });

  await vault.setSecret("openai.key", "sk-secret-123");

  const raw = await fs.readFile(path.join(dataDir, "vault.json"), "utf8");
  assert.equal(raw.includes("sk-secret-123"), false);
});

test("listSecretKeys returns names, never values", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "test-master" });

  await vault.setSecret("a", "value-a");
  await vault.setSecret("b", "value-b");

  const keys = await vault.listSecretKeys();
  assert.deepEqual(keys.sort(), ["a", "b"]);
});

test("deleteSecret removes an entry and reports whether it existed", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "test-master" });

  await vault.setSecret("a", "value-a");
  assert.equal(await vault.deleteSecret("a"), true);
  assert.equal(await vault.getSecret("a"), null);
  assert.equal(await vault.deleteSecret("a"), false);
});

test("a different master key cannot decrypt existing secrets", async () => {
  const dataDir = await makeDataDir();
  const writer = new VaultManager({ dataDir, masterKey: "master-A" });
  await writer.setSecret("openai.key", "sk-secret-123");

  const reader = new VaultManager({ dataDir, masterKey: "master-B" });
  assert.equal(await reader.getSecret("openai.key"), null);
});

test("refuses to start in production without a master key", async () => {
  const dataDir = await makeDataDir();
  const prevNodeEnv = process.env.NODE_ENV;
  const prevKey = process.env.P2P_HUB_VAULT_KEY;
  process.env.NODE_ENV = "production";
  delete process.env.P2P_HUB_VAULT_KEY;

  try {
    assert.throws(() => new VaultManager({ dataDir }), /no vault master key/);
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevKey === undefined) {
      delete process.env.P2P_HUB_VAULT_KEY;
    } else {
      process.env.P2P_HUB_VAULT_KEY = prevKey;
    }
  }
});

test("uses the P2P_HUB_VAULT_KEY env var when no explicit key is passed", async () => {
  const dataDir = await makeDataDir();
  const prevKey = process.env.P2P_HUB_VAULT_KEY;
  process.env.P2P_HUB_VAULT_KEY = "env-master";

  try {
    const vault = new VaultManager({ dataDir });
    await vault.setSecret("k", "v");
    assert.equal(await vault.getSecret("k"), "v");
  } finally {
    if (prevKey === undefined) {
      delete process.env.P2P_HUB_VAULT_KEY;
    } else {
      process.env.P2P_HUB_VAULT_KEY = prevKey;
    }
  }
});

test("hasSecret reports existence without revealing the value", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "test-master" });

  assert.equal(await vault.hasSecret("missing"), false);
  await vault.setSecret("openai.key", "sk-secret-123");
  assert.equal(await vault.hasSecret("openai.key"), true);
});

test("getSecretMetadata returns timestamps but never the value", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "test-master" });

  await vault.setSecret("openai.key", "sk-secret-123");

  const meta = await vault.getSecretMetadata("openai.key");
  assert.equal(meta?.key, "openai.key");
  assert.equal(typeof meta?.updatedAt, "string");
  assert.equal(JSON.stringify(meta).includes("sk-secret-123"), false);

  assert.equal(await vault.getSecretMetadata("missing"), null);
});

test("listSecretMetadata lists all keys without values", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "test-master" });

  await vault.setSecret("a", "value-a");
  await vault.setSecret("b", "value-b");

  const metas = await vault.listSecretMetadata();
  assert.deepEqual(
    metas.map((m) => m.key).sort(),
    ["a", "b"],
  );
  assert.equal(JSON.stringify(metas).includes("value-a"), false);
});

test("a corrupt vault file throws StorageCorruptionError, not a silent empty vault", async () => {
  const dataDir = await makeDataDir();
  await fs.writeFile(path.join(dataDir, "vault.json"), "{ not valid json", "utf8");

  const vault = new VaultManager({ dataDir, masterKey: "test-master" });

  await assert.rejects(() => vault.getSecret("openai.key"), StorageCorruptionError);
  await assert.rejects(() => vault.listSecretKeys(), StorageCorruptionError);

  assert.equal(
    await fs.readFile(path.join(dataDir, "vault.json"), "utf8"),
    "{ not valid json",
    "corrupt vault bytes must remain untouched",
  );
});
