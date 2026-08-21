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
} from "./commands";

async function makeTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "create-p2p-plugin-"));
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
