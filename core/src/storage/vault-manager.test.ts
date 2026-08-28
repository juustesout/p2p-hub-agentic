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

test("hasVaultFile is false on a fresh dir and true once a vault exists", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "test-master" });
  assert.equal(await vault.hasVaultFile(), false);

  await vault.setSecret("identity.privateKey", "material");
  assert.equal(await vault.hasVaultFile(), true);
});

test("assertLoadable fails loudly on corruption but tolerates a missing file", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "test-master" });
  await assert.doesNotReject(() => vault.assertLoadable());

  await fs.writeFile(path.join(dataDir, "vault.json"), "{ nope", "utf8");
  await assert.rejects(() => vault.assertLoadable(), StorageCorruptionError);
});

test("verifyKey accepts the correct key and rejects the wrong one without leaking why", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "master-A" });
  await vault.setSecret("a.b", "value-A");
  await vault.setSecret("c.d", "value-B");

  assert.equal(await vault.verifyKey("master-A"), true);
  assert.equal(await vault.verifyKey("master-B"), false);
});

test("verifyKey is false when no vault exists and true for an empty vault", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "master-A" });
  // No vault file: nothing to verify against.
  assert.equal(await vault.verifyKey("whatever"), false);

  // A vault file with zero entries holds no secret to check — the operator's
  // key is accepted so an empty store never locks them out.
  await new VaultManager({ dataDir, masterKey: "master-A" }).setSecret("tombstone", "x");
  await new VaultManager({ dataDir, masterKey: "master-A" }).deleteSecret("tombstone");
  assert.equal(await vault.verifyKey("whatever"), true);
});

test("setKey replaces the effective key: old-key entries become unreadable, new writes use the real key", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir, masterKey: "boot-key" });
  await vault.setSecret("identity.privateKey", "material");

  // The boot-time placeholder can read what it wrote...
  assert.equal(await vault.getSecret("identity.privateKey"), "material");

  // ...but after the operator's key is installed, that pre-unlock entry is no
  // longer decryptable (the lock gate guarantees nothing sensitive was written
  // before unlock, so this is a fence, not a data-loss path).
  vault.setKey("real-key");
  assert.equal(await vault.getSecret("identity.privateKey"), null);

  // Post-unlock writes use the real key.
  await vault.setSecret("a.b", "after-unlock");

  // A fresh manager with the installed key sees the post-unlock write.
  const reader = new VaultManager({ dataDir, masterKey: "real-key" });
  assert.equal(await reader.getSecret("a.b"), "after-unlock");
  // And a manager built with the old key can no longer read anything.
  const stale = new VaultManager({ dataDir, masterKey: "boot-key" });
  assert.equal(await stale.getSecret("a.b"), null);
});

test("usesFallbackKey tracks the installed key after setKey", async () => {
  const dataDir = await makeDataDir();
  const vault = new VaultManager({ dataDir });
  assert.equal(vault.usesFallbackKey, true);

  vault.setKey("operator-chosen-key");
  assert.equal(vault.usesFallbackKey, false);
});
