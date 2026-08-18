import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VaultManager } from "../storage/vault-manager";
import { IdentityManager } from "./identity-manager";

async function makeVault(): Promise<VaultManager> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "identity-data-"));
  return new VaultManager({ dataDir, masterKey: "test-master" });
}

test("identity persists across IdentityManager instances on the same vault", async () => {
  const vault = await makeVault();

  const first = new IdentityManager({ vault });
  const identity = await first.getOrCreateIdentity();

  // Ed25519 raw public key is 32 bytes → 64 hex chars.
  assert.equal(identity.peerId.length, 64);
  assert.equal(identity.publicKeyHex, identity.peerId);

  // A brand-new instance on the same vault returns the same identity — this is
  // persistence (backed by the vault), not just in-memory consistency.
  const second = new IdentityManager({ vault });
  const again = await second.getOrCreateIdentity();
  assert.equal(again.peerId, identity.peerId);
  assert.equal(again.publicKeyHex, identity.publicKeyHex);
});

test("sign/verify round-trip succeeds; tampered data or wrong key fails without throwing", async () => {
  const manager = new IdentityManager({ vault: await makeVault() });
  const identity = await manager.getOrCreateIdentity();

  const data = Buffer.from("hello");
  const signature = await manager.sign(data);
  assert.ok(signature.length > 0);

  assert.equal(IdentityManager.verify(identity.publicKeyHex, data, signature), true);

  // Tampered data → false (no throw).
  assert.equal(
    IdentityManager.verify(identity.publicKeyHex, Buffer.from("tampered"), signature),
    false,
  );

  // Wrong public key → false (no throw).
  const other = new IdentityManager({ vault: await makeVault() });
  const otherIdentity = await other.getOrCreateIdentity();
  assert.equal(
    IdentityManager.verify(otherIdentity.publicKeyHex, data, signature),
    false,
  );

  // Garbage key material → false (no throw).
  assert.equal(IdentityManager.verify("not-hex!", data, signature), false);
});
