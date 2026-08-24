/**
 * Plugin certification records (Fase 3, Stap 3 — Certification Service v1).
 *
 * A `CertificationRecord` is the *review-layer* counterpart to the Fase 2C
 * Ed25519 manifest signature. Where 2C proves provenance (the manifest and
 * every shipped file are byte-identical to what its signer produced), a
 * certificate proves that a human reviewer looked at the built plugin and
 * vouched for exactly one content hash with their own (reviewer) key.
 *
 * The two signatures are independent and bind in a chain:
 * - the certificate's own Ed25519 signature covers `(pluginId + contentHash +
 *   certifiedAt)` under a *reviewer* key (never the plugin author's key);
 * - `contentHash` is a deterministic SHA-256 aggregate of every shipped file,
 *   so "reviewer vouched for this contentHash" binds to the actual bytes on
 *   disk (see {@link CertificationService}).
 *
 * A certificate is deliberately *not* part of the 2C signed payload: it is a
 * self-authenticating review artifact (like `manifest.json` it is excluded
 * from content hashing), so the reviewer never needs — and must never hold —
 * the plugin author's private key.
 */
export const CERTIFICATE_VERSION = "1.0" as const;

/** Raw Ed25519 signature as 128 lowercase hex chars (same convention as 2C). */
export const CERTIFICATION_SIGNATURE_HEX_RE = /^[0-9a-f]{128}$/;

/** Raw Ed25519 public key as 64 lowercase hex chars (peerId format). */
export const CERTIFICATION_PUBLIC_KEY_HEX_RE = /^[0-9a-f]{64}$/;

/** SHA-256 hex (64 lowercase hex chars). */
export const CONTENT_HASH_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * A single reviewer decision over one built plugin. Stored as
 * `certification.json` in the plugin directory (a trust artifact, never part
 * of the shipped payload or the 2C content hashes).
 */
export interface CertificationRecord {
  /** Dot-free plugin id — must match the manifest id at load time. */
  pluginId: string;
  /**
   * SHA-256 over the bundled plugin content: the deterministic aggregate of
   * the per-file SHA-256 map (see `contentHashFromFileHashes`).
   */
  contentHash: string;
  /** ISO 8601 timestamp of when the review happened. */
  certifiedAt: string;
  /** Optional ISO 8601 expiry; a certificate past this date is invalid. */
  expiresAt?: string;
  /** Schema version — `"1.0"` only. */
  certificateVersion: "1.0";
  /**
   * Human-readable identity of the reviewer (e.g. name/org). Informational
   * provenance: the cryptographic authority is the signing key, not this field.
   */
  reviewerId: string;
  /**
   * Ed25519 signature (128 hex chars) under a reviewer/operator key over the
   * canonical JSON of exactly `{ pluginId, contentHash, certifiedAt }` — the
   * three fields the certificate must bind (see
   * {@link certificationSignaturePayload}).
   */
  signature: string;
}

/** One entry in the {@link RevocationList}. */
export interface RevocationEntry {
  /** Content hash that was revoked. */
  contentHash: string;
  /** Plugin id the revoked content belonged to, when known. */
  pluginId?: string;
  /** ISO 8601 timestamp of the revocation decision. */
  revokedAt: string;
  /** Why it was revoked (shown to the human operator, never to a caller). */
  reason: string;
}

/**
 * The revocation register: content hashes (and optionally plugin ids) a
 * reviewer/operator has withdrawn. A certificate whose content hash appears
 * here is void even if its signature is valid. Stored as a JSON file.
 */
export interface RevocationList {
  entries: RevocationEntry[];
}

/** JSON file names used by the certification layer. */
export const CERTIFICATION_FILE_NAME = "certification.json";
export const REVOCATION_LIST_FILE_NAME = "revocations.json";
