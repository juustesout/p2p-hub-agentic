import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Ed25519 manifest signing (Fase 2C).
 *
 * A plugin manifest may carry a `signature` block proving provenance:
 *
 * ```json
 * {
 *   "id": "calendar",
 *   "version": "0.1.0",
 *   "permissions": [],
 *   "files": { "dist/index.js": "sha256hex...", ... },
 *   "signature": {
 *     "alg": "ed25519",
 *     "publicKey": "64-hex (raw Ed25519 public key)",
 *     "value": "128-hex (Ed25519 signature)"
 *   }
 * }
 * ```
 *
 * What is signed: the canonical (deterministically serialized) manifest with
 * the `signature` field removed — which therefore also authenticates
 * `files`, the SHA-256 content hashes of every shipped file. Verification is
 * symmetric: the `publicKey` in the manifest is the signing key, so no key
 * registry is required. Nothing in this module trusts a hardcoded key; a
 * signature is valid if and only if it verifies under the claimed public key.
 *
 * Key format follows the repo's identity convention: the public key is the
 * hex of the raw 32-byte Ed25519 key (same format as a peerId), the private
 * key is PKCS8 PEM (same format as `IdentityManager` stores).
 */

export const MANIFEST_SIGNATURE_ALG = "ed25519" as const;

/** Raw Ed25519 public key as 64 lowercase hex chars (peerId format). */
export const PUBLIC_KEY_HEX_RE = /^[0-9a-f]{64}$/;

/** Ed25519 signature as 128 lowercase hex chars. */
export const SIGNATURE_HEX_RE = /^[0-9a-f]{128}$/;

export interface PluginManifestSignature {
  alg: "ed25519";
  /** Hex of the raw 32-byte Ed25519 public key (peerId format). */
  publicKey: string;
  /** Hex of the 64-byte Ed25519 signature over the canonical manifest. */
  value: string;
}

/**
 * `manifest.files`: relative (posix-style) path → SHA-256 hex of that file's
 * content. Must cover every file in the plugin directory except the manifest
 * itself and a small always-excluded set (see
 * {@link collectPluginFileHashes}).
 */
export type PluginManifestFileHashes = Record<string, string>;

export class PluginSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSignatureError";
  }
}

type VerifyResult =
  | { ok: true; publicKey: string }
  | { ok: false; reason: string };

/**
 * Deterministic canonical serialization used by both the signer and the
 * verifier: object keys are sorted (UTF-16 code-unit order, matching
 * `Array.prototype.sort()`), arrays and primitives keep their JSON form.
 * A manifest whose JSON key order differs from the signer's still verifies.
 */
export function canonicalizeManifest(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  const type = typeof value;
  if (type === "string") {
    return JSON.stringify(value);
  }
  if (type === "number" || type === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (type === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`)
      .join(",")}}`;
  }
  throw new PluginSignatureError(`cannot canonicalize value of type "${type}"`);
}

/**
 * Shallow copy of the manifest without the `signature` field — this is the
 * exact object that is signed, so `files` stays inside the signed payload.
 */
export function stripSignature(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const copy = { ...manifest };
  delete copy.signature;
  return copy;
}

/** Derive the 64-hex raw public key from a PKCS8 PEM private key. */
export function publicKeyHexFromPrivateKey(privateKeyPem: string): string {
  const jwk = crypto
    .createPrivateKey(privateKeyPem)
    .export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

/**
 * Sign the canonical form of `manifest` (with any `signature` field removed)
 * with an Ed25519 PKCS8 PEM private key. Returns the signature block to store
 * under `manifest.signature`.
 */
export function signManifest(
  manifest: Record<string, unknown>,
  privateKeyPem: string,
): PluginManifestSignature {
  const payload = Buffer.from(
    canonicalizeManifest(stripSignature(manifest)),
    "utf8",
  );
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, payload, key);
  return {
    alg: MANIFEST_SIGNATURE_ALG,
    publicKey: publicKeyHexFromPrivateKey(privateKeyPem),
    value: signature.toString("hex"),
  };
}

/**
 * Verify the cryptographic signature on a manifest. Never throws — every
 * malformed input is a typed `{ ok: false, reason }` (default-deny).
 */
export function verifyManifestSignature(manifest: unknown): VerifyResult {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    return { ok: false, reason: "manifest must be an object" };
  }
  const signature = (manifest as Record<string, unknown>).signature;
  if (
    typeof signature !== "object" ||
    signature === null ||
    Array.isArray(signature)
  ) {
    return { ok: false, reason: '"signature" must be an object' };
  }
  const sig = signature as Record<string, unknown>;
  if (sig.alg !== MANIFEST_SIGNATURE_ALG) {
    return {
      ok: false,
      reason: `unsupported signature alg "${String(sig.alg)}"`,
    };
  }
  if (
    typeof sig.publicKey !== "string" ||
    !PUBLIC_KEY_HEX_RE.test(sig.publicKey)
  ) {
    return { ok: false, reason: '"signature.publicKey" must be 64 hex chars' };
  }
  if (typeof sig.value !== "string" || !SIGNATURE_HEX_RE.test(sig.value)) {
    return { ok: false, reason: '"signature.value" must be 128 hex chars' };
  }
  try {
    const payload = Buffer.from(
      canonicalizeManifest(stripSignature(manifest as Record<string, unknown>)),
      "utf8",
    );
    const valid = crypto.verify(
      null,
      payload,
      createPublicKeyFromHex(sig.publicKey),
      Buffer.from(sig.value, "hex"),
    );
    return valid
      ? { ok: true, publicKey: sig.publicKey }
      : {
          ok: false,
          reason: "signature does not verify against the canonical manifest",
        };
  } catch (err) {
    return {
      ok: false,
      reason: `signature verification failed: ${(err as Error).message}`,
    };
  }
}

function createPublicKeyFromHex(publicKeyHex: string): crypto.KeyObject {
  const raw = Buffer.from(publicKeyHex, "hex");
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

/** SHA-256 of arbitrary content, as lowercase hex. */
export function hashFileContent(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** File/dir names that are never part of the signed payload. */
const HASH_EXCLUSIONS = new Set(["manifest.json", "node_modules", ".git"]);

/**
 * Walk `pluginDir` and compute the SHA-256 of every shipped file, keyed by
 * posix-style relative path. Excluded: `manifest.json` (the signature
 * carrier), `node_modules`, `.git`, and `*.tsbuildinfo`. Symlinks are never
 * followed and never hashed — the payload must be self-contained plain files.
 */
export async function collectPluginFileHashes(
  pluginDir: string,
): Promise<PluginManifestFileHashes> {
  const hashes: PluginManifestFileHashes = {};
  await walk(path.resolve(pluginDir), "");
  return hashes;

  async function walk(abs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (HASH_EXCLUSIONS.has(entry.name)) {
        continue;
      }
      const relChild = rel ? `${rel}/${entry.name}` : entry.name;
      const absChild = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        await walk(absChild, relChild);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(".tsbuildinfo")) {
        continue;
      }
      try {
        const data = await fs.readFile(absChild);
        hashes[relChild] = hashFileContent(data);
      } catch {
        continue;
      }
    }
  }
}

function isSafeRelativePath(rel: string): boolean {
  if (typeof rel !== "string" || rel.length === 0) {
    return false;
  }
  if (rel.startsWith("/") || rel.startsWith("\\")) {
    return false;
  }
  if (rel.includes("\\") || rel.includes("\0")) {
    return false;
  }
  return !rel
    .split("/")
    .some((part) => part === "" || part === "." || part === "..");
}

/**
 * Verify that every file in `files` exists in `pluginDir`, hashes to the
 * claimed value, stays inside the directory, and that every shipped file is
 * covered by `files`. Never throws — failures are typed `{ ok: false }`.
 */
export async function verifyPluginFiles(
  pluginDir: string,
  files: PluginManifestFileHashes,
): Promise<{ ok: boolean; reason?: string }> {
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return { ok: false, reason: '"files" must be an object' };
  }
  const rootResolved = path.resolve(pluginDir);

  for (const rel of Object.keys(files)) {
    if (!isSafeRelativePath(rel)) {
      return { ok: false, reason: `unsafe file path "${rel}"` };
    }
    const expected = files[rel];
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
      return { ok: false, reason: `invalid hash for "${rel}"` };
    }
    const abs = path.resolve(rootResolved, rel);
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
      return {
        ok: false,
        reason: `path "${rel}" escapes the plugin directory`,
      };
    }
    let data: Buffer;
    try {
      data = await fs.readFile(abs);
    } catch {
      return { ok: false, reason: `missing file "${rel}"` };
    }
    if (hashFileContent(data) !== expected) {
      return {
        ok: false,
        reason: `content of "${rel}" does not match its signed hash`,
      };
    }
  }

  // Coverage: every shipped file must be authenticated — no unhashed bytes.
  const actual = await collectPluginFileHashes(rootResolved);
  for (const rel of Object.keys(actual)) {
    if (!(rel in files)) {
      return {
        ok: false,
        reason: `unhashed file "${rel}" in plugin directory`,
      };
    }
  }
  return { ok: true };
}

/**
 * Full load-time gate for a signed plugin: cryptographic signature AND content
 * integrity. Returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export async function verifySignedPlugin(
  pluginDir: string,
  manifest: Record<string, unknown>,
): Promise<{ ok: boolean; reason?: string }> {
  const sig = verifyManifestSignature(manifest);
  if (!sig.ok) {
    return sig;
  }
  const files = (manifest as { files?: unknown }).files;
  if (files === undefined) {
    return {
      ok: false,
      reason: 'signed manifest must include a "files" content-hash map',
    };
  }
  return verifyPluginFiles(pluginDir, files as PluginManifestFileHashes);
}
