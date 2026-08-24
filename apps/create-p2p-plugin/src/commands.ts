import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  collectPluginFileHashes,
  publicKeyHexFromPrivateKey,
  signManifest,
  verifyManifestSignature,
  verifyPluginFiles,
} from "@p2p-hub/sdk";
import {
  CertificationService,
  scanPluginDirectory,
  signCertificationRecord,
} from "@p2p-hub/core";
import type {
  CertificationRecord,
  RevocationList,
  ScanFinding,
  ScanReport,
} from "@p2p-hub/core";

/**
 * Pure, testable command implementations for the `create-p2p-plugin` CLI
 * (Fase 2C distribution tooling). The CLI wrapper only parses argv and prints;
 * everything that matters lives here.
 */

/** Same constraint as `PluginManifest.id` — dot-free (Fase 2C). */
export const PLUGIN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export interface KeyPair {
  /** PKCS8 PEM — the secret. */
  privateKeyPem: string;
  /** Hex of the raw 32-byte Ed25519 public key (peerId format). */
  publicKeyHex: string;
}

export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const privateKeyPem = typeof pem === "string" ? pem : pem.toString("utf8");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    privateKeyPem,
    publicKeyHex: Buffer.from(jwk.x, "base64url").toString("hex"),
  };
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Scaffold a new plugin at `<targetDir>/<name>` with a valid, dot-free
 * manifest, package.json, tsconfig and a typed sample skill. Refuses to
 * overwrite an existing directory and rejects ids that would break the
 * namespace/delimiter rules.
 */
export async function scaffoldPlugin(
  name: string,
  targetDir: string,
): Promise<string> {
  if (!PLUGIN_ID_RE.test(name)) {
    throw new Error(
      `invalid plugin id "${name}": must start with an alphanumeric and ` +
        `contain only alphanumerics, "_" or "-" (dots are reserved as the ` +
        `namespace delimiter)`,
    );
  }
  const dir = path.join(targetDir, name);
  try {
    await fs.access(dir);
    throw new Error(`target directory already exists: ${dir}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const manifest = {
    id: name,
    name: titleCase(name),
    version: "0.1.0",
    kind: "generic",
    entry: "./dist/index.js",
    permissions: [],
  };

  const packageJson = {
    name: `@p2p-hub/${name}`,
    version: "0.1.0",
    description: `${titleCase(name)} plugin for p2p-hub`,
    main: "dist/index.js",
    types: "dist/index.d.ts",
    files: ["dist"],
    scripts: {
      build: "tsc -p tsconfig.json",
      test: 'node --test "dist/**/*.test.js"',
    },
    dependencies: {
      "@p2p-hub/core": "0.1.0",
      "@p2p-hub/sdk": "0.1.0",
    },
    license: "MIT",
  };

  const tsconfig = {
    extends: "../../tsconfig.base.json",
    compilerOptions: { rootDir: "src", outDir: "dist" },
    include: ["src/**/*"],
    references: [{ path: "../../core" }],
  };

  const entry = `import type { PluginContext } from "@p2p-hub/core";

export default function activate(ctx: PluginContext): void {
  ctx.skills.register("ping", async (task) => {
    return { taskId: task.id, status: "ok", result: "pong" };
  });
}
`;

  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(dir, "tsconfig.json"),
    `${JSON.stringify(tsconfig, null, 2)}\n`,
  );
  await fs.writeFile(path.join(dir, "src", "index.ts"), entry);
  return dir;
}

/**
 * Sign a plugin directory: hash every shipped file, sign the canonical
 * manifest (files map included) and stamp `signature` + `files` back into
 * `manifest.json`. Idempotent — re-signing replaces the previous block.
 */
export async function signPluginDir(
  dir: string,
  privateKeyPem: string,
): Promise<{ publicKeyHex: string; fileCount: number }> {
  const manifestPath = path.join(dir, "manifest.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${manifestPath}: ${(err as Error).message}`);
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`invalid manifest at ${manifestPath}: not valid JSON`);
  }

  manifest.files = await collectPluginFileHashes(dir);
  manifest.signature = signManifest(manifest, privateKeyPem);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    publicKeyHex: publicKeyHexFromPrivateKey(privateKeyPem),
    fileCount: Object.keys(manifest.files as Record<string, string>).length,
  };
}

export type VerifyResult =
  | { signed: true; ok: true; publicKey: string; fileCount: number }
  | { signed: true; ok: false; reason: string }
  | { signed: false; ok: false; reason: string };

/**
 * Report the signing status of a plugin directory: unsigned, signed+valid, or
 * signed+broken (with the reason). Never throws.
 */
export async function verifyPluginDir(dir: string): Promise<VerifyResult> {
  const manifestPath = path.join(dir, "manifest.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    return {
      signed: false,
      ok: false,
      reason: `cannot read ${manifestPath}: ${(err as Error).message}`,
    };
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { signed: false, ok: false, reason: "manifest is not valid JSON" };
  }

  if (manifest.signature === undefined) {
    return {
      signed: false,
      ok: false,
      reason: "unsigned plugin — no provenance, treated as untrusted",
    };
  }

  const sig = verifyManifestSignature(manifest);
  if (!sig.ok) {
    return { signed: true, ok: false, reason: sig.reason };
  }
  const files = manifest.files;
  if (typeof files !== "object" || files === null) {
    return {
      signed: true,
      ok: false,
      reason: 'signed manifest must include a "files" content-hash map',
    };
  }
  const filesCheck = await verifyPluginFiles(dir, files as Record<string, string>);
  if (!filesCheck.ok) {
    return { signed: true, ok: false, reason: filesCheck.reason ?? "content mismatch" };
  }
  return {
    signed: true,
    ok: true,
    publicKey: sig.publicKey,
    fileCount: Object.keys(files).length,
  };
}

export interface CertifyOptions {
  /** ISO 8601 expiry; omit for a non-expiring certificate. */
  expiresAt?: string;
  /** Human-readable reviewer identity (defaults to the reviewer public key). */
  reviewerId?: string;
}

export interface CertifyResult {
  contentHash: string;
  reviewerId: string;
  publicKeyHex: string;
  passed: boolean;
  findings: ScanFinding[];
  record: CertificationRecord;
}

/**
 * Scan a plugin directory and — if the scanner finds no critical pattern —
 * stamp a signed `certification.json` (the reviewer's Ed25519 signature over
 * pluginId + contentHash + certifiedAt) into the plugin directory.
 *
 * The scanner never approves: `passed: false` refuses to certify; `passed:
 * true` means "no statically-critical pattern", and the human operator is
 * expected to read the full report (advisories included) before running this.
 */
export async function certifyPluginDir(
  dir: string,
  reviewerKeyPem: string,
  options: CertifyOptions = {},
): Promise<CertifyResult> {
  const report = await scanPluginDirectory(dir);
  const critical = report.findings.filter((f) => f.severity === "critical");
  if (critical.length > 0) {
    throw new Error(
      `scan blocked certification of "${dir}": ${critical
        .map((f) => `${f.detail} (${f.file}${f.line ? `:${f.line}` : ""})`)
        .join("; ")}`,
    );
  }
  const publicKeyHex = publicKeyHexFromPrivateKey(reviewerKeyPem);
  const record = signCertificationRecord(
    {
      pluginId: report.pluginId,
      contentHash: report.contentHash,
      certifiedAt: new Date().toISOString(),
      expiresAt: options.expiresAt,
      certificateVersion: "1.0",
      reviewerId: options.reviewerId ?? publicKeyHex,
    },
    reviewerKeyPem,
  );
  await fs.writeFile(
    path.join(dir, "certification.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return {
    contentHash: report.contentHash,
    reviewerId: record.reviewerId,
    publicKeyHex,
    passed: report.passed,
    findings: report.findings,
    record,
  };
}

/**
 * Revoke a content hash (optionally bound to a plugin id) by appending it to
 * the revocation register and persisting atomically. Idempotent.
 */
export async function revokePluginCertification(
  contentHash: string,
  reason: string,
  revocationListPath: string,
  pluginId?: string,
): Promise<RevocationList> {
  const service = new CertificationService({ revocationListPath });
  await service.load();
  return service.revokeCertificate(contentHash, reason, pluginId);
}

/** Scan a plugin directory and return the structured report (never throws on
 * findings — only on an unreadable manifest/bundle). */
export async function scanPluginForCertification(
  dir: string,
): Promise<ScanReport> {
  return scanPluginDirectory(dir);
}
