import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { VaultManager } from "../storage/vault-manager";
import { IdentityManager } from "./identity-manager";
import {
  deriveChildSeed,
  isValidChildLabel,
  privateKeyFromSeed,
  publicKeyHexFromPrivateKey,
} from "./child-identity";

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

test("deriveChildIdentity: derived, distinct, deterministic and independently verifiable", async () => {
  const manager = new IdentityManager({ vault: await makeVault() });
  const operator = await manager.getOrCreateIdentity();

  const alice = await manager.deriveChildIdentity("agent-alice");
  // Own peerId, 64-hex, and different from the operator's.
  assert.equal(alice.peerId.length, 64);
  assert.equal(alice.peerId, alice.publicKeyHex);
  assert.notEqual(alice.peerId, operator.peerId);
  assert.equal(alice.label, "agent-alice");

  // Deterministic: deriving again returns the same child (no new key, no new cert).
  const again = await manager.deriveChildIdentity("agent-alice");
  assert.equal(again.peerId, alice.peerId);
  assert.equal(again.certificate.signature, alice.certificate.signature);

  // Distinct labels → distinct child identities.
  const bob = await manager.deriveChildIdentity("agent-bob");
  assert.notEqual(bob.peerId, alice.peerId);

  // Certificate binds the child to the operator, publicly verifiable.
  assert.equal(
    IdentityManager.verifyChildCertificate(operator.publicKeyHex, alice.certificate),
    true,
  );
  // Tampered cert → false; cert under a different parent → false; junk → false.
  const tampered = { ...alice.certificate, child: "0".repeat(64) };
  assert.equal(
    IdentityManager.verifyChildCertificate(operator.publicKeyHex, tampered),
    false,
  );
  const stranger = new IdentityManager({ vault: await makeVault() });
  const strangerIdentity = await stranger.getOrCreateIdentity();
  assert.equal(
    IdentityManager.verifyChildCertificate(strangerIdentity.publicKeyHex, alice.certificate),
    false,
  );
  assert.equal(IdentityManager.verifyChildCertificate(operator.publicKeyHex, null), false);
  assert.equal(IdentityManager.verifyChildCertificate(operator.publicKeyHex, "junk"), false);
});

test("child identities persist across IdentityManager instances on the same vault", async () => {
  const vault = await makeVault();
  const first = new IdentityManager({ vault });
  const child = await first.deriveChildIdentity("persisted-agent");

  // A brand-new instance on the same vault sees the same child (vault-backed,
  // not in-memory), including its operator-signed certificate.
  const second = new IdentityManager({ vault });
  const reloaded = await second.getChildIdentity("persisted-agent");
  assert.ok(reloaded);
  assert.equal(reloaded.peerId, child.peerId);
  assert.deepEqual(reloaded.certificate, child.certificate);
  assert.equal(await second.getChildIdentity("never-derived"), null);

  // listChildIdentities returns every derived agent, sorted by label.
  const third = new IdentityManager({ vault });
  await third.deriveChildIdentity("b-agent");
  const listed = await third.listChildIdentities();
  assert.deepEqual(listed.map((l) => l.label), ["b-agent", "persisted-agent"]);
  const byLabel = new Map(listed.map((l) => [l.label, l.peerId]));
  assert.equal(byLabel.get("persisted-agent"), child.peerId);
});

test("child key material derives from a seed and signs/verifies like any Ed25519 key", async () => {
  const manager = new IdentityManager({ vault: await makeVault() });
  // The seed never leaves IdentityManager; this exercises the same derivation
  // primitive the manager uses, from the raw seed extracted in-process.
  const childSeed = deriveChildSeed(Buffer.alloc(32, 1), "crypto-agent");
  const childKey = privateKeyFromSeed(childSeed);
  const childPubHex = publicKeyHexFromPrivateKey(childKey);
  assert.equal(childPubHex.length, 64);

  // Same seed + label → same key (HKDF determinism).
  const again = privateKeyFromSeed(deriveChildSeed(Buffer.alloc(32, 1), "crypto-agent"));
  assert.equal(publicKeyHexFromPrivateKey(again), childPubHex);

  // The derived key actually signs/verifies as an independent identity.
  const data = Buffer.from("agent-hello");
  const signature = crypto.sign(null, data, childKey);
  assert.equal(IdentityManager.verify(childPubHex, data, signature), true);

  // Derivation is domain-separated per label and needs the exact 32-byte seed.
  assert.notEqual(
    publicKeyHexFromPrivateKey(privateKeyFromSeed(deriveChildSeed(Buffer.alloc(32, 1), "other"))),
    childPubHex,
  );
  assert.equal(isValidChildLabel("good-label_1"), true);
  assert.equal(isValidChildLabel("bad label!"), false);
  assert.equal(isValidChildLabel(""), false);
  assert.throws(() => deriveChildSeed(Buffer.alloc(32, 1), "bad label!"), /invalid agent label/);
  assert.throws(() => deriveChildSeed(Buffer.alloc(16), "ok-label"), /exactly 32 bytes/);

  // Idempotent accessor returns null for an invalid label instead of touching
  // the vault with an arbitrary key name.
  assert.equal(await manager.getChildIdentity("../evil"), null);
});

test("deleteChildIdentity removes an agent from the registry and the vault", async () => {
  const manager = new IdentityManager({ vault: await makeVault() });
  await manager.deriveChildIdentity("retired-agent");
  assert.equal(await manager.getChildIdentity("retired-agent") !== null, true);

  // Deletion succeeds and the identity is gone from both the registry and the vault.
  assert.equal(await manager.deleteChildIdentity("retired-agent"), true);
  assert.equal(await manager.getChildIdentity("retired-agent"), null);
  assert.deepEqual(await manager.listChildIdentities(), []);

  // Deleting again is a no-op (false), and an invalid label never touches the vault.
  assert.equal(await manager.deleteChildIdentity("retired-agent"), false);
  assert.equal(await manager.deleteChildIdentity("../evil"), false);

  // Other labels are untouched.
  await manager.deriveChildIdentity("kept-agent");
  assert.equal(await manager.deleteChildIdentity("retired-agent"), false);
  assert.equal(await manager.getChildIdentity("kept-agent") !== null, true);
});
