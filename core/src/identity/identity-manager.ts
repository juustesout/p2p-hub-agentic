import * as crypto from "node:crypto";
import type { ChildCertificate, ChildIdentity, PeerIdentity } from "@p2p-hub/sdk";
import type { VaultManager } from "../storage/vault-manager";
import {
  deriveChildSeed,
  isValidChildLabel,
  privateKeyFromSeed,
  publicKeyHexFromPrivateKey,
  verifyChildCertificate as verifyChildCertificateBytes,
  buildChildCertificate,
} from "./child-identity";

export interface IdentityManagerOptions {
  /** Reuse the existing vault — do not build a second secret store. */
  vault: VaultManager;
}

/**
 * Vault keys under which the identity keypair is persisted. Both are reserved
 * (`identity.` prefix) so they are unreachable through any plugin-facing vault
 * surface; only this class reads them, via the core-only `VaultManager`.
 */
const PRIVATE_KEY_KEY = "identity.privateKey";
const PUBLIC_KEY_KEY = "identity.publicKey";

/**
 * Vault-key prefix for derived agent (child) identities. All of these live
 * under the reserved `identity.` namespace, so no plugin-facing vault surface
 * can read or write them — only this class (core) touches them.
 */
const CHILD_KEY_PREFIX = "identity.agent.";
const childPrivateKeyKey = (label: string) => `${CHILD_KEY_PREFIX}${label}.privateKey`;
const childPublicKeyKey = (label: string) => `${CHILD_KEY_PREFIX}${label}.publicKey`;
const childCertificateKey = (label: string) => `${CHILD_KEY_PREFIX}${label}.certificate`;

/**
 * Persistent peer identity, layered *alongside* (not replacing) the per-boot
 * self-signed TLS certificates that `network-light` generates for each session.
 *
 * The keypair is Ed25519 (`node:crypto`'s `generateKeyPairSync`), a simpler
 * primitive than the X.509 certs `network-light` builds with `node-forge` —
 * here we only need a keypair, not a certificate.
 *
 * Storage format (documented, chosen deliberately):
 *   - `identity.privateKey` → PKCS8 PEM (string), re-importable via
 *     `crypto.createPrivateKey`.
 *   - `identity.publicKey`  → hex of the *raw* 32-byte Ed25519 public key
 *     (the same bytes as `peerId`), stored separately so the public half can
 *     be read without parsing the private key.
 *
 * The private key never leaves this class.
 */
export class IdentityManager {
  private readonly vault: VaultManager;
  private identity: PeerIdentity | null = null;
  private privateKey: crypto.KeyObject | null = null;

  constructor(options: IdentityManagerOptions) {
    this.vault = options.vault;
  }

  /**
   * Load the persisted keypair from the vault, or generate + persist one on
   * first call. Idempotent: a new {@link IdentityManager} instance on the same
   * vault/dataDir returns the same identity.
   */
  async getOrCreateIdentity(): Promise<PeerIdentity> {
    if (this.identity) {
      return this.identity;
    }

    const publicKeyHex = await this.vault.getSecret(PUBLIC_KEY_KEY);
    const privateKeyPem = await this.vault.getSecret(PRIVATE_KEY_KEY);

    if (publicKeyHex && privateKeyPem) {
      this.privateKey = crypto.createPrivateKey(privateKeyPem);
      this.identity = { peerId: publicKeyHex, publicKeyHex };
      return this.identity;
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" }) as { x: string };
    const rawPublicKey = Buffer.from(publicJwk.x, "base64url");
    const hex = rawPublicKey.toString("hex");

    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const pemString = typeof pem === "string" ? pem : pem.toString("utf8");

    await this.vault.setSecret(PRIVATE_KEY_KEY, pemString);
    await this.vault.setSecret(PUBLIC_KEY_KEY, hex);

    this.privateKey = privateKey;
    this.identity = { peerId: hex, publicKeyHex: hex };
    return this.identity;
  }

  /** Sign arbitrary bytes. The private key never leaves this class. */
  async sign(data: Buffer): Promise<Buffer> {
    await this.getOrCreateIdentity();
    return crypto.sign(null, data, this.privateKey as crypto.KeyObject);
  }

  /**
   * Derive (or load) a child identity for `label` — an agent's *own* derived
   * keypair, deterministically derived from this operator keypair's seed.
   * Idempotent: the same label on the same vault always returns the same
   * child peerId, signed with a fresh parent certificate on first creation.
   * See `docs/agent-identity-streaming-design.md` for the full design.
   */
  async deriveChildIdentity(label: string): Promise<ChildIdentity> {
    const existing = await this.getChildIdentity(label);
    if (existing) {
      return existing;
    }

    const parent = await this.getOrCreateIdentity();
    const parentSeed = this.privateSeed();

    const childSeed = deriveChildSeed(parentSeed, label);
    const childKey = privateKeyFromSeed(childSeed);
    const childPublicKeyHex = publicKeyHexFromPrivateKey(childKey);

    const certificate = await buildChildCertificate(
      parent,
      childPublicKeyHex,
      label,
      (data) => this.sign(data),
    );

    const privateKeyPem = childKey.export({ type: "pkcs8", format: "pem" });
    const pemString =
      typeof privateKeyPem === "string" ? privateKeyPem : privateKeyPem.toString("utf8");

    await this.vault.setSecret(childPrivateKeyKey(label), pemString);
    await this.vault.setSecret(childPublicKeyKey(label), childPublicKeyHex);
    await this.vault.setSecret(
      childCertificateKey(label),
      JSON.stringify(certificate),
    );

    return { peerId: childPublicKeyHex, publicKeyHex: childPublicKeyHex, label, certificate };
  }

  /** Load a previously derived child identity, or `null` when absent. */
  async getChildIdentity(label: string): Promise<ChildIdentity | null> {
    if (!isValidChildLabel(label)) {
      return null;
    }
    const [publicKeyHex, privateKeyPem, certificateJson] = await Promise.all([
      this.vault.getSecret(childPublicKeyKey(label)),
      this.vault.getSecret(childPrivateKeyKey(label)),
      this.vault.getSecret(childCertificateKey(label)),
    ]);
    if (!publicKeyHex || !privateKeyPem || !certificateJson) {
      return null;
    }
    try {
      const certificate = JSON.parse(certificateJson) as ChildCertificate;
      return { peerId: publicKeyHex, publicKeyHex, label, certificate };
    } catch {
      // Corrupt child record: fail loudly for the caller instead of returning
      // a half-read identity (same principle as atomic-write corruption).
      throw new Error(`corrupt child identity record for label "${label}"`);
    }
  }

  /** List every derived agent identity as `{ label, peerId }`. */
  async listChildIdentities(): Promise<Array<{ label: string; peerId: string }>> {
    const keys = await this.vault.listSecretKeys();
    const out: Array<{ label: string; peerId: string }> = [];
    for (const key of keys) {
      // Anchor on the full prefix and the exact ".publicKey" suffix so a label
      // that merely *contains* "agent." or ends in ".publicKey" cannot alias
      // another identity (delimiter-anchored, per CLAUDE.md principle #2).
      if (!key.startsWith(CHILD_KEY_PREFIX) || !key.endsWith(".publicKey")) {
        continue;
      }
      const label = key.slice(CHILD_KEY_PREFIX.length, -".publicKey".length);
      const publicKeyHex = await this.vault.getSecret(key);
      if (publicKeyHex) {
        out.push({ label, peerId: publicKeyHex });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Stateless certificate check: does `cert` prove that `parentPublicKeyHex`
   * (the operator's *public* key) created this child identity? Returns `false`
   * (never throws) for a malformed/tampered cert or a foreign parent key.
   */
  static verifyChildCertificate(
    parentPublicKeyHex: string,
    cert: unknown,
  ): boolean {
    return verifyChildCertificateBytes(parentPublicKeyHex, cert);
  }

  /**
   * The operator keypair's raw 32-byte Ed25519 seed, extracted from the private
   * key's JWK form. Read-only, never leaves this class — it is the input to
   * {@link deriveChildIdentity}'s HKDF, never exposed to any caller.
   */
  private privateSeed(): Buffer {
    const jwk = (this.privateKey as crypto.KeyObject).export({ format: "jwk" }) as {
      d: string;
    };
    return Buffer.from(jwk.d, "base64url");
  }

  /**
   * Standalone verify — no instance required, so a peer can verify someone
   * else's signature from their published public key without its own
   * {@link IdentityManager} being involved. Returns `false` (never throws) for
   * any invalid key, data or signature.
   */
  static verify(publicKeyHex: string, data: Buffer, signature: Buffer): boolean {
    try {
      const raw = Buffer.from(publicKeyHex, "hex");
      const publicKey = crypto.createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
        format: "jwk",
      });
      return crypto.verify(null, data, publicKey, signature);
    } catch {
      return false;
    }
  }
}
