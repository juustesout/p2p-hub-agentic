import * as crypto from "node:crypto";
import * as path from "node:path";
import { canonicalizeJson, hashFileContent, collectPluginFileHashes } from "@p2p-hub/sdk";
import type { PluginManifest } from "@p2p-hub/sdk";
import {
  CERTIFICATION_FILE_NAME,
  CERTIFICATION_PUBLIC_KEY_HEX_RE,
  CERTIFICATION_SIGNATURE_HEX_RE,
  CERTIFICATE_VERSION,
  CONTENT_HASH_HEX_RE,
  REVOCATION_LIST_FILE_NAME,
} from "./types";
import type {
  CertificationRecord,
  RevocationEntry,
  RevocationList,
} from "./types";
import { atomicWriteFile, readJsonFile } from "../storage/atomic-write";

/**
 * Raised when a plugin is refused because it fails the certification gate
 * (missing, invalid, expired, content-mismatched, or revoked certificate) while
 * `requireCertifiedPlugins` is enabled on the runtime.
 */
export class CertificationError extends Error {
  readonly pluginId: string;
  readonly reason: string;

  constructor(pluginId: string, reason: string) {
    super(`plugin "${pluginId}" is not certified: ${reason}`);
    this.name = "CertificationError";
    this.pluginId = pluginId;
    this.reason = reason;
  }
}

/**
 * The exact bytes a reviewer signs: the canonical JSON of exactly
 * `{ pluginId, contentHash, certifiedAt }`. Kept as one function so signer and
 * verifier can never drift apart — the same discipline as `canonicalizeJson`
 * for manifest signatures. `reviewerId` and `expiresAt` are deliberately NOT
 * signed: the certificate binds the plugin identity, the content and the review
 * time; the reviewer identity is provenance metadata self-asserted by the key
 * holder, and the expiry is a policy read at verification time.
 */
export function certificationSignaturePayload(
  pluginId: string,
  contentHash: string,
  certifiedAt: string,
): string {
  return canonicalizeJson({ pluginId, contentHash, certifiedAt });
}

/**
 * Sign a certificate record under a reviewer/operator Ed25519 key (PKCS8 PEM).
 * `reviewerId` is informational (typically the human reviewer's name/org); the
 * cryptographic authority is the key, exposed as `reviewerId` fallback when the
 * caller passes none.
 */
export function signCertificationRecord(
  record: Omit<CertificationRecord, "signature">,
  privateKeyPem: string,
): CertificationRecord {
  const publicKeyHex = publicKeyHexFromPem(privateKeyPem);
  const payload = Buffer.from(
    certificationSignaturePayload(
      record.pluginId,
      record.contentHash,
      record.certifiedAt,
    ),
    "utf8",
  );
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, payload, key);
  return {
    pluginId: record.pluginId,
    contentHash: record.contentHash,
    certifiedAt: record.certifiedAt,
    expiresAt: record.expiresAt,
    certificateVersion: record.certificateVersion,
    reviewerId: record.reviewerId || publicKeyHex,
    signature: signature.toString("hex"),
  };
}

function publicKeyHexFromPem(privateKeyPem: string): string {
  const jwk = crypto
    .createPrivateKey(privateKeyPem)
    .export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

function createPublicKeyFromHex(publicKeyHex: string): crypto.KeyObject {
  const raw = Buffer.from(publicKeyHex, "hex");
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

export type CertificationCheckResult =
  | { ok: true; reviewerId: string; publicKey: string }
  | { ok: false; reason: string };

/**
 * Verify the certificate's own signature (and shape, version and expiry)
 * against a set of known reviewer/operator public keys. Default-deny: any
 * malformed field, unknown version, unparsable date, expired certificate or
 * signature that verifies under none of the given keys is a typed
 * `{ ok: false }` — never a throw.
 *
 * Does NOT yet check content binding / revocation; those need external inputs
 * and live in {@link verifyCertification}.
 */
export function verifyCertificationSignature(
  record: unknown,
  publicKeys: string[],
): CertificationCheckResult {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { ok: false, reason: "certification record must be an object" };
  }
  const rec = record as Record<string, unknown>;
  if (rec.certificateVersion !== CERTIFICATE_VERSION) {
    return {
      ok: false,
      reason: `unsupported certificate version "${String(rec.certificateVersion)}"`,
    };
  }
  if (typeof rec.pluginId !== "string" || rec.pluginId.length === 0) {
    return { ok: false, reason: '"pluginId" must be a non-empty string' };
  }
  if (
    typeof rec.contentHash !== "string" ||
    !CONTENT_HASH_HEX_RE.test(rec.contentHash)
  ) {
    return { ok: false, reason: '"contentHash" must be 64 hex chars' };
  }
  if (typeof rec.certifiedAt !== "string" || !Number.isFinite(Date.parse(rec.certifiedAt))) {
    return { ok: false, reason: '"certifiedAt" must be a valid ISO date' };
  }
  if (rec.expiresAt !== undefined) {
    if (typeof rec.expiresAt !== "string" || !Number.isFinite(Date.parse(rec.expiresAt))) {
      return { ok: false, reason: '"expiresAt" must be a valid ISO date' };
    }
    if (Date.parse(rec.expiresAt) <= Date.now()) {
      return { ok: false, reason: `certificate expired at ${rec.expiresAt}` };
    }
  }
  if (typeof rec.reviewerId !== "string" || rec.reviewerId.length === 0) {
    return { ok: false, reason: '"reviewerId" must be a non-empty string' };
  }
  if (
    typeof rec.signature !== "string" ||
    !CERTIFICATION_SIGNATURE_HEX_RE.test(rec.signature)
  ) {
    return { ok: false, reason: '"signature" must be 128 hex chars' };
  }
  const validKeys = (publicKeys ?? []).filter(
    (k) => typeof k === "string" && CERTIFICATION_PUBLIC_KEY_HEX_RE.test(k),
  );
  if (validKeys.length === 0) {
    return { ok: false, reason: "no valid reviewer public key configured" };
  }
  const payload = Buffer.from(
    certificationSignaturePayload(
      rec.pluginId as string,
      rec.contentHash as string,
      rec.certifiedAt as string,
    ),
    "utf8",
  );
  const signatureBuffer = Buffer.from(rec.signature as string, "hex");
  for (const keyHex of validKeys) {
    try {
      const valid = crypto.verify(
        null,
        payload,
        createPublicKeyFromHex(keyHex),
        signatureBuffer,
      );
      if (valid) {
        return { ok: true, reviewerId: rec.reviewerId, publicKey: keyHex };
      }
    } catch {
      // a bad key must not abort the whole check — try the next one
    }
  }
  return { ok: false, reason: "signature does not verify against any reviewer key" };
}

/** Extra inputs {@link verifyCertification} needs that live outside the record. */
export interface CertificationVerificationDeps {
  /**
   * The content hash of the plugin as actually loaded from disk. When present,
   * must equal the certificate's — the reviewer vouched for exactly this
   * content. Absent plugins are refused as `content mismatch`.
   */
  actualContentHash?: string;
  /** Expected plugin id (from the manifest). When present, must match. */
  expectedPluginId?: string;
  /** The revocation register; a matching entry voids the certificate. */
  revocationList?: RevocationList;
}

/**
 * Full certification gate: signature/version/expiry (see
 * {@link verifyCertificationSignature}) AND content binding AND revocation AND
 * plugin-id match. Never throws.
 */
export function verifyCertification(
  record: unknown,
  publicKeys: string[],
  deps: CertificationVerificationDeps = {},
): CertificationCheckResult {
  const signatureCheck = verifyCertificationSignature(record, publicKeys);
  if (!signatureCheck.ok) {
    return signatureCheck;
  }
  const rec = record as CertificationRecord;
  if (deps.expectedPluginId !== undefined && rec.pluginId !== deps.expectedPluginId) {
    return {
      ok: false,
      reason: `certificate is for plugin "${rec.pluginId}", not "${deps.expectedPluginId}"`,
    };
  }
  if (
    deps.actualContentHash !== undefined &&
    rec.contentHash !== deps.actualContentHash
  ) {
    return {
      ok: false,
      reason: "certificate content hash does not match the loaded plugin content",
    };
  }
  const revoked = (deps.revocationList?.entries ?? []).some(
    (entry) => entry.contentHash === rec.contentHash,
  );
  if (revoked) {
    return { ok: false, reason: "certificate is revoked" };
  }
  return signatureCheck;
}

/**
 * Deterministic SHA-256 aggregate over a plugin's per-file content-hash map
 * (the `manifest.files` shape, or {@link collectPluginFileHashes} output).
 * Canonical (sorted-key) JSON of the map, so the aggregate is stable across
 * directory-walk order and a single changed byte in any file changes it.
 */
export function contentHashFromFileHashes(files: Record<string, string>): string {
  return hashFileContent(Buffer.from(canonicalizeJson(files), "utf8"));
}

/**
 * Content hash of a plugin *as it sits on disk today* — the same walk 2C uses
 * for `manifest.files`, aggregated deterministically. This is the hash a
 * reviewer certifies at review time and the loader recomputes at load time;
 * equality means the bytes are identical to what was reviewed.
 */
export async function computePluginContentHash(
  pluginDir: string,
): Promise<string> {
  return contentHashFromFileHashes(await collectPluginFileHashes(pluginDir));
}

/**
 * Read `certification.json` from a plugin directory, or `null` when the plugin
 * was never reviewed. A file that exists but cannot be parsed surfaces the
 * loud `StorageCorruptionError` (CLAUDE.md principle #9 — never collapse
 * corruption into "no certificate").
 */
export async function readCertificationRecord(
  pluginDir: string,
): Promise<CertificationRecord | null> {
  const filePath = path.join(pluginDir, CERTIFICATION_FILE_NAME);
  return readJsonFile<CertificationRecord>(filePath);
}

export interface CertificationServiceOptions {
  /**
   * Path of the revocation register JSON file. When set, `load()` reads it and
   * `revokeCertificate` persists atomically. Absent ⇒ the service keeps the
   * register in memory only (still enforced, just not durable).
   */
  revocationListPath?: string;
  /** Known reviewer/operator public keys (64-hex). Empty ⇒ nothing verifies. */
  reviewerPublicKeys?: string[];
}

/**
 * Review-layer service (Fase 3 Stap 3): verifies plugin certificates and owns
 * the revocation register. The host owns an instance per data-dir; the CLI
 * shares the same JSON format so an operator can revoke out-of-band.
 */
export class CertificationService {
  private readonly revocationListPath?: string;
  private readonly reviewerPublicKeys: string[];
  private revocation: RevocationList = { entries: [] };
  private loaded = false;

  constructor(options: CertificationServiceOptions = {}) {
    this.revocationListPath = options.revocationListPath;
    this.reviewerPublicKeys = options.reviewerPublicKeys ?? [];
  }

  /**
   * Load the revocation register from disk. Missing file ⇒ empty register (the
   * normal first-run case). A file that exists but cannot be parsed throws
   * `StorageCorruptionError` loudly — never silently treated as empty.
   */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (this.revocationListPath) {
      const stored = await readJsonFile<RevocationList>(this.revocationListPath);
      if (stored !== null) {
        if (
          typeof stored !== "object" ||
          stored === null ||
          !Array.isArray((stored as RevocationList).entries)
        ) {
          throw new Error(
            `revocation list at ${this.revocationListPath} has an invalid shape`,
          );
        }
        this.revocation = stored as RevocationList;
      }
    }
    this.loaded = true;
  }

  /** The current in-memory revocation register (copy). */
  listRevocations(): RevocationList {
    return { entries: [...this.revocation.entries] };
  }

  /** Sync membership check against the loaded register. */
  isRevoked(contentHash: string): boolean {
    return this.revocation.entries.some((e) => e.contentHash === contentHash);
  }

  /**
   * Add a content hash (optionally bound to a plugin id) to the revocation
   * register and persist atomically when a path is configured. Idempotent — a
   * hash already present is not duplicated. Returns the updated register.
   */
  async revokeCertificate(
    contentHash: string,
    reason: string,
    pluginId?: string,
  ): Promise<RevocationList> {
    if (!CONTENT_HASH_HEX_RE.test(contentHash)) {
      throw new CertificationError(
        pluginId ?? "?",
        `cannot revoke malformed content hash "${contentHash}"`,
      );
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new CertificationError(
        pluginId ?? "?",
        "a revocation reason is required",
      );
    }
    if (!this.revocation.entries.some((e) => e.contentHash === contentHash)) {
      const entry: RevocationEntry = {
        contentHash,
        revokedAt: new Date().toISOString(),
        reason,
      };
      if (pluginId !== undefined) {
        entry.pluginId = pluginId;
      }
      this.revocation.entries.push(entry);
    }
    if (this.revocationListPath) {
      await atomicWriteFile(
        this.revocationListPath,
        `${JSON.stringify(this.revocation, null, 2)}\n`,
      );
    }
    return this.listRevocations();
  }

  /**
   * Full per-plugin certification check: read the record, verify signature and
   * expiry against the configured reviewer keys, recompute the plugin's actual
   * content hash from disk and require it to match, then check the revocation
   * register. Returns the verdict; never throws for a failed check (only for a
   * corrupt revocation store, which is a loud infrastructure failure).
   */
  async verifyPluginCertification(
    pluginDir: string,
    manifest: PluginManifest,
  ): Promise<{ certified: boolean; reason: string; record?: CertificationRecord }> {
    const record = await readCertificationRecord(pluginDir);
    if (record === null) {
      return { certified: false, reason: "no certification record" };
    }
    const signatureCheck = verifyCertificationSignature(
      record,
      this.reviewerPublicKeys,
    );
    if (!signatureCheck.ok) {
      return { certified: false, reason: signatureCheck.reason };
    }
    const actualContentHash = await computePluginContentHash(pluginDir);
    const full = verifyCertification(record, this.reviewerPublicKeys, {
      actualContentHash,
      expectedPluginId: manifest.id,
      revocationList: this.revocation,
    });
    if (!full.ok) {
      return { certified: false, reason: full.reason };
    }
    return { certified: true, reason: "certified", record };
  }

  /** Default revocation register path for a host data dir. */
  static defaultRevocationListPath(dataDir: string): string {
    return path.join(dataDir, "certifications", REVOCATION_LIST_FILE_NAME);
  }
}
