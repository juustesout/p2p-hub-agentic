import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  canonicalizeManifest,
  collectPluginFileHashes,
  hashFileContent,
  publicKeyHexFromPrivateKey,
  signManifest,
  verifyManifestSignature,
  verifyPluginFiles,
  verifySignedPlugin,
} from "./manifest-signing";

function makeKeypair(): { privateKeyPem: string; publicKeyHex: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const privateKeyPem = typeof pem === "string" ? pem : pem.toString("utf8");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    privateKeyPem,
    publicKeyHex: Buffer.from(jwk.x, "base64url").toString("hex"),
  };
}

function baseManifest(): Record<string, unknown> {
  return {
    id: "calendar",
    version: "0.1.0",
    kind: "generic",
    permissions: [],
    entry: "./dist/index.js",
  };
}

test("canonicalizeManifest is deterministic with sorted keys", () => {
  assert.equal(
    canonicalizeManifest({ b: 1, a: { d: [1, 2], c: "x" } }),
    '{"a":{"c":"x","d":[1,2]},"b":1}',
  );
  // Same object, different insertion order → identical bytes.
  assert.equal(
    canonicalizeManifest({ a: { d: [1, 2], c: "x" }, b: 1 }),
    canonicalizeManifest({ b: 1, a: { c: "x", d: [1, 2] } }),
  );
});

test("hashFileContent pins a known sha256", () => {
  assert.equal(
    hashFileContent(Buffer.from("p2p-hub", "utf8")),
    "7e4eb9a775788c7aaa5ca1bc0892b079ccbd132e2201142766e8b8b1050b8608",
  );
});

test("sign then verify round-trips; key order does not matter", () => {
  const key = makeKeypair();
  const manifest = baseManifest();
  const signature = signManifest(manifest, key.privateKeyPem);
  assert.equal(signature.publicKey, key.publicKeyHex);
  assert.match(signature.value, /^[0-9a-f]{128}$/);

  const signed = { ...manifest, signature };
  assert.equal(verifyManifestSignature(signed).ok, true);

  // The verifier re-sorts keys, so a manifest serialized in any order verifies.
  const shuffled: Record<string, unknown> = {};
  for (const k of ["entry", "permissions", "id", "version", "kind"]) {
    shuffled[k] = manifest[k];
  }
  const shuffledSigned = { ...shuffled, signature };
  assert.equal(verifyManifestSignature(shuffledSigned).ok, true);
});

test("tampering any signed field invalidates the signature", () => {
  const key = makeKeypair();
  const sig = signManifest(baseManifest(), key.privateKeyPem);
  const signed: Record<string, unknown> = { ...baseManifest(), signature: sig };

  const idTampered = {
    ...signed,
    id: "calendarevil",
    signature: sig,
  };
  assert.equal(verifyManifestSignature(idTampered).ok, false);

  const versionTampered = {
    ...signed,
    version: "9.9.9",
    signature: sig,
  };
  assert.equal(verifyManifestSignature(versionTampered).ok, false);

  const permissionTampered = {
    ...signed,
    permissions: ["network:skill:calendar.status"],
    signature: sig,
  };
  assert.equal(verifyManifestSignature(permissionTampered).ok, false);

  const signatureTampered = {
    ...signed,
    signature: { ...sig, value: "0".repeat(128) },
  };
  assert.equal(verifyManifestSignature(signatureTampered).ok, false);

  const keyTampered = {
    ...signed,
    signature: { ...sig, publicKey: "a".repeat(64) },
  };
  assert.equal(verifyManifestSignature(keyTampered).ok, false);
});

test("a signature from the wrong key does not verify", () => {
  const signer = makeKeypair();
  const attacker = makeKeypair();
  const sig = signManifest(baseManifest(), signer.privateKeyPem);
  const signed: Record<string, unknown> = { ...baseManifest(), signature: sig };
  const forged = { ...signed, signature: { ...sig, publicKey: attacker.publicKeyHex } };
  assert.equal(verifyManifestSignature(forged).ok, false);
});

test("malformed signature objects are rejected (default-deny)", () => {
  const key = makeKeypair();
  const manifest = baseManifest();
  const signature = signManifest(manifest, key.privateKeyPem);
  const sig = { ...signature } as { alg: string; publicKey: string; value: string };

  assert.equal(verifyManifestSignature(null).ok, false);
  assert.equal(verifyManifestSignature("nope").ok, false);
  assert.equal(
    verifyManifestSignature({ ...manifest, signature: "not-an-object" }).ok,
    false,
  );
  assert.equal(
    verifyManifestSignature({ ...manifest, signature: { ...sig, alg: "rsa" } }).ok,
    false,
  );
  assert.equal(
    verifyManifestSignature({
      ...manifest,
      signature: { ...sig, publicKey: "zz" },
    }).ok,
    false,
  );
  assert.equal(
    verifyManifestSignature({ ...manifest, signature: { ...sig, value: "zz" } }).ok,
    false,
  );
});

async function writePluginDir(
  files: Record<string, string>,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-signing-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

test("publicKeyHexFromPrivateKey derives the raw public key", () => {
  const key = makeKeypair();
  assert.equal(publicKeyHexFromPrivateKey(key.privateKeyPem), key.publicKeyHex);
});

test("verifyPluginFiles accepts a fully covered, matching plugin dir", async () => {
  const dir = await writePluginDir({
    "manifest.json": "{}",
    "dist/index.js": "export default 1",
    "package.json": "{}",
  });
  const hashes = await collectPluginFileHashes(dir);
  assert.deepEqual(Object.keys(hashes).sort(), [
    "dist/index.js",
    "package.json",
  ]);
  assert.equal((await verifyPluginFiles(dir, hashes)).ok, true);
});

test("verifyPluginFiles rejects a changed, missing or unhashed file", async () => {
  const dir = await writePluginDir({
    "manifest.json": "{}",
    "dist/index.js": "export default 1",
    "package.json": "{}",
  });
  const hashes = await collectPluginFileHashes(dir);

  await fs.writeFile(path.join(dir, "dist", "index.js"), "export default 2");
  assert.equal(
    (await verifyPluginFiles(dir, hashes)).ok,
    false,
    "changed file must be rejected",
  );

  const hashes2 = await collectPluginFileHashes(dir);
  await fs.rm(path.join(dir, "dist", "index.js"));
  assert.equal(
    (await verifyPluginFiles(dir, hashes2)).ok,
    false,
    "missing file must be rejected",
  );

  // Restore the signed content, then drop in an *extra* file that was never
  // signed — the coverage check must reject it.
  await fs.writeFile(path.join(dir, "dist", "index.js"), "export default 2");
  await fs.writeFile(path.join(dir, "dist", "extra.js"), "unsignd");
  assert.equal(
    (await verifyPluginFiles(dir, hashes2)).ok,
    false,
    "an unhashed dropped-in file must be rejected",
  );
});

test("verifyPluginFiles rejects unsafe paths in the files map", async () => {
  const dir = await writePluginDir({
    "manifest.json": "{}",
    "index.js": "export default 1",
  });
  const hashes = await collectPluginFileHashes(dir);

  assert.equal(
    (await verifyPluginFiles(dir, { ...hashes, "../escape.js": "a".repeat(64) })).ok,
    false,
  );
  assert.equal(
    (await verifyPluginFiles(dir, { ...hashes, "/abs.js": "a".repeat(64) })).ok,
    false,
  );
  assert.equal(
    (await verifyPluginFiles(dir, { ...hashes, "sub\\dir.js": "a".repeat(64) })).ok,
    false,
  );
});

test("verifySignedPlugin requires a files map on a signed manifest", async () => {
  const dir = await writePluginDir({
    "manifest.json": "{}",
    "index.js": "export default 1",
  });
  const key = makeKeypair();
  const manifest = { ...baseManifest(), entry: "./index.js" };
  const signed = {
    ...manifest,
    signature: signManifest(manifest, key.privateKeyPem),
  };
  const result = await verifySignedPlugin(dir, signed);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /files/);
});

test("verifySignedPlugin end-to-end: honest, tampered, wrong-key", async () => {
  const dir = await writePluginDir({
    "manifest.json": "{}",
    "index.js": "export default 1",
  });
  const key = makeKeypair();
  const manifest = {
    ...baseManifest(),
    entry: "./index.js",
    files: await collectPluginFileHashes(dir),
  };
  const signed = {
    ...manifest,
    signature: signManifest(manifest, key.privateKeyPem),
  };
  assert.equal((await verifySignedPlugin(dir, signed)).ok, true);

  // Tamper with the code after signing.
  await fs.writeFile(path.join(dir, "index.js"), "export default 'evil'");
  assert.equal((await verifySignedPlugin(dir, signed)).ok, false);
});
