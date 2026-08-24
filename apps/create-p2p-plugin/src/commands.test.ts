import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateKeyPair,
  PLUGIN_ID_RE,
  scaffoldPlugin,
  signPluginDir,
  verifyPluginDir,
  certifyPluginDir,
  revokePluginCertification,
  scanPluginForCertification,
} from "./commands";
import { CertificationService, verifyCertificationSignature } from "@p2p-hub/core";

async function makeTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "create-p2p-plugin-"));
}

async function writeBundle(dir: string, content: string): Promise<void> {
  const distDir = path.join(dir, "dist");
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(path.join(distDir, "index.js"), content);
}

test("scaffoldPlugin creates a valid, dot-free plugin skeleton", async () => {
  const root = await makeTmpRoot();
  const dir = await scaffoldPlugin("myapp", path.join(root, "plugins"));

  const manifest = JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as { id: string; entry: string; kind: string; version: string };
  assert.equal(manifest.id, "myapp");
  assert.equal(manifest.entry, "./dist/index.js");
  assert.equal(manifest.kind, "generic");
  assert.match(manifest.id, PLUGIN_ID_RE);

  const entry = await fs.readFile(path.join(dir, "src", "index.ts"), "utf8");
  assert.match(entry, /@p2p-hub\/core/);
  assert.match(entry, /ctx\.skills\.register/);

  const tsconfig = JSON.parse(
    await fs.readFile(path.join(dir, "tsconfig.json"), "utf8"),
  ) as { references: { path: string }[] };
  assert.equal(tsconfig.references[0].path, "../../core");
});

test("scaffoldPlugin refuses dotted and path-breaking ids", async () => {
  const root = await makeTmpRoot();
  await assert.rejects(
    () => scaffoldPlugin("a.b", root),
    /namespace delimiter/,
  );
  await assert.rejects(
    () => scaffoldPlugin("../evil", root),
    /invalid plugin id/,
  );
});

test("scaffoldPlugin refuses to overwrite an existing directory", async () => {
  const root = await makeTmpRoot();
  await fs.mkdir(path.join(root, "plugins"), { recursive: true });
  await fs.mkdir(path.join(root, "plugins", "exists"));
  await assert.rejects(
    () => scaffoldPlugin("exists", path.join(root, "plugins")),
    /already exists/,
  );
});

test("sign/verify round-trip on a scaffolded plugin", async () => {
  const root = await makeTmpRoot();
  const dir = await scaffoldPlugin("signed-app", path.join(root, "plugins"));

  // Unsigned → reported as such.
  const before = await verifyPluginDir(dir);
  assert.equal(before.signed, false);
  assert.match(before.reason, /unsigned/);

  // Sign → the manifest carries signature + files.
  const key = generateKeyPair();
  const signed = await signPluginDir(dir, key.privateKeyPem);
  assert.equal(signed.publicKeyHex, key.publicKeyHex);
  const manifest = JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as { signature: { publicKey: string }; files: Record<string, string> };
  assert.equal(manifest.signature.publicKey, key.publicKeyHex);
  assert.ok(Object.keys(manifest.files).includes("src/index.ts"));

  // Verify → signed + ok.
  const after = await verifyPluginDir(dir);
  assert.equal(after.signed, true);
  assert.equal(after.ok, true);

  // Tamper → verify reports broken, never a crash.
  await fs.writeFile(path.join(dir, "src", "index.ts"), "tampered");
  const broken = await verifyPluginDir(dir);
  assert.equal(broken.signed, true);
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /does not match|unhashed/);
});

test("scan reports a clean bundle as passed with a content hash", async () => {
  const root = await makeTmpRoot();
  const dir = await scaffoldPlugin("scanned-app", path.join(root, "plugins"));
  await writeBundle(dir, `module.exports = { ping: () => "pong" };\n`);
  const report = await scanPluginForCertification(dir);
  assert.equal(report.passed, true);
  assert.equal(report.pluginId, "scanned-app");
  assert.equal(report.findings.length, 0);
  assert.equal(report.scannedFiles, 1);
  assert.match(report.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(report.limitations.length > 0);
});

test("scan flags eval as a critical finding", async () => {
  const root = await makeTmpRoot();
  const dir = await scaffoldPlugin("eval-app", path.join(root, "plugins"));
  await writeBundle(dir, `function run(c) { return (0, eval)(c); }\n`);
  const report = await scanPluginForCertification(dir);
  assert.equal(report.passed, false);
  const evals = report.findings.filter((f) => f.detail.includes("eval"));
  assert.ok(evals.length >= 1);
  assert.equal(evals[0].severity, "critical");
});

test("certify stamps a verifiable certification.json", async () => {
  const root = await makeTmpRoot();
  const dir = await scaffoldPlugin("certified-cli", path.join(root, "plugins"));
  await writeBundle(dir, `module.exports = 1;\n`);
  const key = generateKeyPair();

  const result = await certifyPluginDir(dir, key.privateKeyPem, {
    reviewerId: "CLI Reviewer",
  });
  assert.equal(result.passed, true);
  assert.equal(result.record.pluginId, "certified-cli");
  assert.equal(result.record.reviewerId, "CLI Reviewer");
  assert.equal(result.record.certificateVersion, "1.0");
  assert.match(result.record.signature, /^[0-9a-f]{128}$/);

  const record = JSON.parse(
    await fs.readFile(path.join(dir, "certification.json"), "utf8"),
  ) as { contentHash: string };
  assert.equal(record.contentHash, result.contentHash);

  const verified = verifyCertificationSignature(result.record, [key.publicKeyHex]);
  assert.equal(verified.ok, true);
});

test("certify is idempotent — certification.json never changes the content hash", async () => {
  const root = await makeTmpRoot();
  const dir = await scaffoldPlugin("stable-hash", path.join(root, "plugins"));
  await writeBundle(dir, `module.exports = 1;\n`);
  const key = generateKeyPair();

  const first = await certifyPluginDir(dir, key.privateKeyPem);
  const second = await certifyPluginDir(dir, key.privateKeyPem);
  assert.equal(first.contentHash, second.contentHash);
});

test("certify refuses when the scanner finds a critical pattern", async () => {
  const root = await makeTmpRoot();
  const dir = await scaffoldPlugin("evil-cli", path.join(root, "plugins"));
  await writeBundle(dir, `const { spawn } = require("child_process");\n`);
  const key = generateKeyPair();
  await assert.rejects(
    () => certifyPluginDir(dir, key.privateKeyPem),
    /scan blocked certification/,
  );
});

test("revokePluginCertification appends to the register and persists", async () => {
  const root = await makeTmpRoot();
  const listPath = path.join(root, "revocations.json");
  const hash = "c".repeat(64);
  const list = await revokePluginCertification(hash, "incident", listPath, "demo");
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0].pluginId, "demo");

  const reloaded = new CertificationService({ revocationListPath: listPath });
  await reloaded.load();
  assert.equal(reloaded.isRevoked(hash), true);
});
