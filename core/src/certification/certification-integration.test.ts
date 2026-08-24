import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost } from "../plugin-host/plugin-host";
import {
  CertificationService,
  computePluginContentHash,
  signCertificationRecord,
} from "./certification-service";
import { CERTIFICATION_FILE_NAME, CERTIFICATE_VERSION } from "./types";
import { collectPluginFileHashes, signManifest } from "@p2p-hub/sdk";

async function makeTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cert-integration-"));
}

function makeSigningKey(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return typeof pem === "string" ? pem : pem.toString("utf8");
}

interface Fixture {
  dir: string;
  contentHash: string;
}

async function writePlugin(
  root: string,
  name: string,
  entrySource: string,
  permissions: string[] = [],
): Promise<string> {
  const dir = path.join(root, "plugins", name);
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: name,
      version: "1.0.0",
      kind: "generic",
      permissions,
      entry: "./dist/index.mjs",
    }),
  );
  await fs.writeFile(path.join(dir, "dist", "index.mjs"), entrySource);
  return dir;
}

async function certifyDir(
  dir: string,
  reviewerKeyPem: string,
  pluginId: string,
): Promise<Fixture> {
  const contentHash = await computePluginContentHash(dir);
  const record = signCertificationRecord(
    {
      pluginId,
      contentHash,
      certifiedAt: new Date().toISOString(),
      certificateVersion: CERTIFICATE_VERSION,
      reviewerId: "reviewer@example.org",
    },
    reviewerKeyPem,
  );
  await fs.writeFile(
    path.join(dir, CERTIFICATION_FILE_NAME),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return { dir, contentHash };
}

async function signPluginDir(
  dir: string,
  privateKeyPem: string,
): Promise<void> {
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as Record<string, unknown>;
  manifest.files = await collectPluginFileHashes(dir);
  manifest.signature = signManifest(manifest, privateKeyPem);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

function silenceConsole(): () => void {
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => undefined;
  console.warn = () => undefined;
  return () => {
    console.error = originalError;
    console.warn = originalWarn;
  };
}

const ENTRY = `export default function activate() { return { ok: true }; }`;

test("a certified plugin loads under requireCertifiedPlugins", async () => {
  const root = await makeTmpRoot();
  const key = makeSigningKey();
  const publicKeyHex = Buffer.from(
    (crypto.createPrivateKey(key).export({ format: "jwk" }) as { x: string }).x,
    "base64url",
  ).toString("hex");
  const dir = await writePlugin(root, "certified-app", ENTRY);
  await certifyDir(dir, key, "certified-app");

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    requireCertifiedPlugins: true,
    reviewerPublicKeys: [publicKeyHex],
  });
  const restore = silenceConsole();
  try {
    await host.boot();
  } finally {
    restore();
  }
  assert.equal(host.pluginState("certified-app"), "ACTIVE");
  assert.equal(host.pluginCertification("certified-app"), "certified");
  await host.stop();
});

test("requireCertifiedPlugins refuses a plugin without a certificate", async () => {
  const root = await makeTmpRoot();
  await writePlugin(root, "bare", ENTRY);

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    requireCertifiedPlugins: true,
    reviewerPublicKeys: [],
  });
  const restore = silenceConsole();
  try {
    await host.boot();
  } finally {
    restore();
  }
  assert.equal(host.getActivated("bare"), undefined);
  assert.equal(host.pluginState("bare"), "FAILED_ACTIVATION");
  await host.stop();
});

test("tampering the bundle after certification refuses the plugin", async () => {
  const root = await makeTmpRoot();
  const key = makeSigningKey();
  const publicKeyHex = Buffer.from(
    (crypto.createPrivateKey(key).export({ format: "jwk" }) as { x: string }).x,
    "base64url",
  ).toString("hex");
  const dir = await writePlugin(root, "tampered-app", ENTRY);
  await certifyDir(dir, key, "tampered-app");

  // Flip one byte in the bundle after the review happened.
  await fs.writeFile(path.join(dir, "dist", "index.mjs"), ENTRY.replace("ok", "ko"));

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    requireCertifiedPlugins: true,
    reviewerPublicKeys: [publicKeyHex],
  });
  const restore = silenceConsole();
  try {
    await host.boot();
  } finally {
    restore();
  }
  assert.equal(host.getActivated("tampered-app"), undefined);
  assert.equal(host.pluginCertification("tampered-app"), "uncertified");
  await host.stop();
});

test("a revoked certificate refuses the plugin at boot", async () => {
  const root = await makeTmpRoot();
  const key = makeSigningKey();
  const publicKeyHex = Buffer.from(
    (crypto.createPrivateKey(key).export({ format: "jwk" }) as { x: string }).x,
    "base64url",
  ).toString("hex");
  const dir = await writePlugin(root, "revoked-app", ENTRY);
  const { contentHash } = await certifyDir(dir, key, "revoked-app");

  // Write a revocation register the host will load.
  const listPath = path.join(root, "data", "certifications", "revocations.json");
  const writer = new CertificationService({ revocationListPath: listPath });
  await writer.load();
  await writer.revokeCertificate(contentHash, "compromised", "revoked-app");

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    requireCertifiedPlugins: true,
    reviewerPublicKeys: [publicKeyHex],
  });
  const restore = silenceConsole();
  try {
    await host.boot();
  } finally {
    restore();
  }
  assert.equal(host.getActivated("revoked-app"), undefined);
  assert.equal(host.pluginCertification("revoked-app"), "uncertified");
  await host.stop();
});

test("without requireCertifiedPlugins an uncertified plugin still loads and is reported", async () => {
  const root = await makeTmpRoot();
  await writePlugin(root, "dev-plugin", ENTRY);

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
  });
  const restore = silenceConsole();
  try {
    await host.boot();
  } finally {
    restore();
  }
  assert.equal(host.pluginState("dev-plugin"), "ACTIVE");
  assert.equal(host.pluginCertification("dev-plugin"), "uncertified");
  await host.stop();
});

test("a plugin that is both 2C-signed and certified passes both gates", async () => {
  const root = await makeTmpRoot();
  const pluginKey = makeSigningKey();
  const reviewerKey = makeSigningKey();
  const reviewerPublicKeyHex = Buffer.from(
    (crypto.createPrivateKey(reviewerKey).export({ format: "jwk" }) as { x: string }).x,
    "base64url",
  ).toString("hex");
  const dir = await writePlugin(root, "double-gated", ENTRY);
  await signPluginDir(dir, pluginKey);
  await certifyDir(dir, reviewerKey, "double-gated");

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    requireSignedPlugins: true,
    requireCertifiedPlugins: true,
    reviewerPublicKeys: [reviewerPublicKeyHex],
  });
  const restore = silenceConsole();
  try {
    await host.boot();
  } finally {
    restore();
  }
  assert.equal(host.pluginState("double-gated"), "ACTIVE");
  assert.equal(host.pluginSignature("double-gated"), "signed");
  assert.equal(host.pluginCertification("double-gated"), "certified");
  await host.stop();
});
