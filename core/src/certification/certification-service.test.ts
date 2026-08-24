import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CertificationService,
  computePluginContentHash,
  contentHashFromFileHashes,
  signCertificationRecord,
  verifyCertification,
  verifyCertificationSignature,
} from "./certification-service";
import { CERTIFICATION_FILE_NAME, CERTIFICATE_VERSION } from "./types";
import type { CertificationRecord } from "./types";
import { collectPluginFileHashes } from "@p2p-hub/sdk";
import { readJsonFile } from "../storage/atomic-write";

function makeKeyPair(): { privateKeyPem: string; publicKeyHex: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    privateKeyPem: typeof pem === "string" ? pem : pem.toString("utf8"),
    publicKeyHex: Buffer.from(jwk.x, "base64url").toString("hex"),
  };
}

async function makeTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cert-service-"));
}

async function writePlugin(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

function makeRecord(
  overrides: Partial<CertificationRecord> = {},
): Omit<CertificationRecord, "signature"> {
  return {
    pluginId: "demo",
    contentHash: "a".repeat(64),
    certifiedAt: new Date().toISOString(),
    certificateVersion: CERTIFICATE_VERSION,
    reviewerId: "reviewer-1",
    ...overrides,
  };
}

test("contentHashFromFileHashes is deterministic and binds every byte", async () => {
  const filesA = { "dist/index.js": "abc", "dist/app.js": "def" };
  const filesB = { "dist/app.js": "def", "dist/index.js": "abc" };
  assert.equal(
    contentHashFromFileHashes(filesA),
    contentHashFromFileHashes(filesB),
    "key order must not matter",
  );
  const tampered = { ...filesA, "dist/index.js": "abX" };
  assert.notEqual(
    contentHashFromFileHashes(tampered),
    contentHashFromFileHashes(filesA),
    "a one-byte change must change the aggregate",
  );
});

test("computePluginContentHash matches the manifest.files aggregate", async () => {
  const root = await makeTmpRoot();
  const dir = path.join(root, "p");
  await writePlugin(dir, {
    "manifest.json": "{}",
    "dist/index.js": "export default () => 1;",
    "dist/util.js": "export const x = 1;",
  });
  const fromDisk = await computePluginContentHash(dir);
  const fromHashes = contentHashFromFileHashes(
    await collectPluginFileHashes(dir),
  );
  assert.equal(fromDisk, fromHashes);
});

test("sign + verify round-trip against the reviewer key", () => {
  const key = makeKeyPair();
  const record = signCertificationRecord(makeRecord(), key.privateKeyPem);
  assert.equal(record.signature.length, 128);
  const result = verifyCertificationSignature(record, [key.publicKeyHex]);
  assert.deepEqual(result, { ok: true, reviewerId: "reviewer-1", publicKey: key.publicKeyHex });
});

test("signature from a different key is rejected", () => {
  const signer = makeKeyPair();
  const other = makeKeyPair();
  const record = signCertificationRecord(makeRecord(), signer.privateKeyPem);
  const result = verifyCertificationSignature(record, [other.publicKeyHex]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not verify against any reviewer key/);
});

test("tampering any signed field breaks the signature", () => {
  const key = makeKeyPair();
  const record = signCertificationRecord(makeRecord(), key.privateKeyPem);

  const tampered = [
    { ...record, pluginId: "evil" },
    { ...record, contentHash: "b".repeat(64) },
    { ...record, certifiedAt: new Date(Date.now() - 86400000).toISOString() },
  ];
  for (const rec of tampered) {
    const result = verifyCertificationSignature(rec, [key.publicKeyHex]);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(rec)}`);
  }
});

test("expired certificate is rejected", () => {
  const key = makeKeyPair();
  const record = signCertificationRecord(
    makeRecord({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
    key.privateKeyPem,
  );
  const result = verifyCertificationSignature(record, [key.publicKeyHex]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /expired/);
});

test("malformed records fail closed without throwing", () => {
  const key = makeKeyPair();
  const valid = signCertificationRecord(makeRecord(), key.privateKeyPem);
  const bad: unknown[] = [
    null,
    [],
    "nope",
    {},
    { ...valid, certificateVersion: "9.9" },
    { ...valid, pluginId: "" },
    { ...valid, contentHash: "zzz" },
    { ...valid, certifiedAt: "not-a-date" },
    { ...valid, reviewerId: "" },
    { ...valid, signature: "short" },
  ];
  for (const rec of bad) {
    const result = verifyCertificationSignature(rec, [key.publicKeyHex]);
    assert.equal(result.ok, false);
  }
});

test("no configured reviewer keys fails closed", () => {
  const key = makeKeyPair();
  const record = signCertificationRecord(makeRecord(), key.privateKeyPem);
  const result = verifyCertificationSignature(record, []);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no valid reviewer public key/);
});

test("verifyCertification enforces content binding and revocation", () => {
  const key = makeKeyPair();
  const record = signCertificationRecord(makeRecord(), key.privateKeyPem);

  const contentMismatch = verifyCertification(record, [key.publicKeyHex], {
    actualContentHash: "b".repeat(64),
  });
  assert.equal(contentMismatch.ok, false);
  assert.match(contentMismatch.reason, /does not match/);

  const pluginMismatch = verifyCertification(record, [key.publicKeyHex], {
    expectedPluginId: "other",
  });
  assert.equal(pluginMismatch.ok, false);

  const revoked = verifyCertification(record, [key.publicKeyHex], {
    revocationList: { entries: [{ contentHash: record.contentHash, revokedAt: new Date().toISOString(), reason: "bad" }] },
  });
  assert.equal(revoked.ok, false);
  assert.match(revoked.reason, /revoked/);

  const ok = verifyCertification(record, [key.publicKeyHex], {
    actualContentHash: record.contentHash,
    expectedPluginId: "demo",
    revocationList: { entries: [] },
  });
  assert.equal(ok.ok, true);
});

test("CertificationService persists the revocation register atomically", async () => {
  const root = await makeTmpRoot();
  const listPath = path.join(root, "revocations.json");
  const service = new CertificationService({ revocationListPath: listPath });
  await service.load();

  const after = await service.revokeCertificate("c".repeat(64), "supply-chain incident", "demo");
  assert.equal(after.entries.length, 1);
  assert.equal(service.isRevoked("c".repeat(64)), true);
  assert.equal(service.isRevoked("d".repeat(64)), false);

  // Idempotent — same hash never duplicated.
  await service.revokeCertificate("c".repeat(64), "again");
  assert.equal(service.listRevocations().entries.length, 1);

  // A fresh instance loads the same register.
  const reloaded = new CertificationService({ revocationListPath: listPath });
  await reloaded.load();
  assert.equal(reloaded.isRevoked("c".repeat(64)), true);
  assert.equal(reloaded.listRevocations().entries[0].reason, "supply-chain incident");

  // The persisted file is valid JSON on disk.
  const onDisk = await readJsonFile<{ entries: unknown[] }>(listPath);
  assert.equal(onDisk?.entries.length, 1);
});

test("revokeCertificate rejects malformed input loudly", async () => {
  const root = await makeTmpRoot();
  const service = new CertificationService({ revocationListPath: path.join(root, "r.json") });
  await service.load();
  await assert.rejects(
    () => service.revokeCertificate("not-a-hash", "reason"),
    /malformed content hash/,
  );
  await assert.rejects(
    () => service.revokeCertificate("c".repeat(64), "   "),
    /reason is required/,
  );
});

test("verifyPluginCertification accepts a certified plugin and refuses without one", async () => {
  const root = await makeTmpRoot();
  const key = makeKeyPair();
  const service = new CertificationService({
    reviewerPublicKeys: [key.publicKeyHex],
  });
  await service.load();

  const dir = path.join(root, "certified");
  await writePlugin(dir, {
    "manifest.json": JSON.stringify({ id: "demo", version: "1.0.0", kind: "generic", permissions: [], entry: "./dist/index.mjs" }),
    "dist/index.mjs": "export default () => 1;",
  });

  const manifest = { id: "demo" } as { id: string };
  const without = await service.verifyPluginCertification(dir, manifest as never);
  assert.equal(without.certified, false);
  assert.match(without.reason, /no certification record/);

  const contentHash = await computePluginContentHash(dir);
  const record = signCertificationRecord(
    {
      pluginId: "demo",
      contentHash,
      certifiedAt: new Date().toISOString(),
      certificateVersion: CERTIFICATE_VERSION,
      reviewerId: key.publicKeyHex,
    },
    key.privateKeyPem,
  );
  await fs.writeFile(
    path.join(dir, CERTIFICATION_FILE_NAME),
    JSON.stringify(record, null, 2),
  );

  const withCert = await service.verifyPluginCertification(dir, manifest as never);
  assert.equal(withCert.certified, true);

  // Tamper one byte in the bundle → the certificate no longer matches.
  await fs.writeFile(path.join(dir, "dist/index.mjs"), "export default () => 2;");
  const tampered = await service.verifyPluginCertification(dir, manifest as never);
  assert.equal(tampered.certified, false);
  assert.match(tampered.reason, /does not match/);
});

test("verifyPluginCertification refuses a revoked certificate", async () => {
  const root = await makeTmpRoot();
  const key = makeKeyPair();
  const listPath = path.join(root, "revocations.json");
  const service = new CertificationService({
    reviewerPublicKeys: [key.publicKeyHex],
    revocationListPath: listPath,
  });
  await service.load();

  const dir = path.join(root, "revoked");
  await writePlugin(dir, {
    "manifest.json": JSON.stringify({ id: "demo", version: "1.0.0", kind: "generic", permissions: [], entry: "./dist/index.mjs" }),
    "dist/index.mjs": "export default () => 1;",
  });
  const contentHash = await computePluginContentHash(dir);
  const record = signCertificationRecord(
    {
      pluginId: "demo",
      contentHash,
      certifiedAt: new Date().toISOString(),
      certificateVersion: CERTIFICATE_VERSION,
      reviewerId: key.publicKeyHex,
    },
    key.privateKeyPem,
  );
  await fs.writeFile(path.join(dir, CERTIFICATION_FILE_NAME), JSON.stringify(record, null, 2));

  const before = await service.verifyPluginCertification(dir, { id: "demo" } as never);
  assert.equal(before.certified, true);

  await service.revokeCertificate(contentHash, "compromised", "demo");
  const after = await service.verifyPluginCertification(dir, { id: "demo" } as never);
  assert.equal(after.certified, false);
  assert.match(after.reason, /revoked/);
});
