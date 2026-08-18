import * as crypto from "node:crypto";
import type { PeerIdentity } from "@p2p-hub/sdk";
import type { VaultManager } from "../storage/vault-manager";

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
