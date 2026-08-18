import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface VaultManagerOptions {
  /**
   * Directory holding the encrypted vault file. Defaults to a persistent,
   * user-scoped location (`~/.p2p-hub/vault`).
   */
  dataDir?: string;
  /**
   * Master passphrase used to derive the AES-256 key (via scrypt). Defaults to
   * the `P2P_HUB_VAULT_KEY` env var, then to an insecure dev-only fallback that
   * logs a loud warning and refuses to start when `NODE_ENV === "production"`.
   */
  masterKey?: string;
  /**
   * Key-name prefixes that are reserved for core configuration and may not be
   * read or written through the plugin-facing vault surface. This is a policy
   * the plugin loader enforces — {@link VaultManager} itself is not bound by
   * it and can still read/write reserved keys (that is how core manages
   * `ai.*`). Defaults to {@link DEFAULT_RESERVED_PREFIXES}.
   */
  reservedPrefixes?: string[];
}

interface EncryptedEntry {
  iv: string;
  tag: string;
  data: string;
  /** ISO timestamp of the last write. Optional for backwards compat. */
  updatedAt?: string;
}

interface VaultFile {
  salt: string;
  entries: Record<string, EncryptedEntry>;
}

/** Non-secret metadata about a stored secret. Never contains the value. */
export interface SecretMetadata {
  key: string;
  /** ISO timestamp of the last write, or null if unknown (legacy entry). */
  updatedAt: string | null;
}

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const DEV_MASTER_KEY = "p2p-hub-insecure-dev-key";

/** Key-name prefixes reserved for core configuration (e.g. `ai.*`, `identity.*`). */
export const DEFAULT_RESERVED_PREFIXES = ["ai.", "identity."];

function resolveMasterKey(explicit?: string): {
  masterKey: string;
  usedFallback: boolean;
} {
  if (explicit) {
    return { masterKey: explicit, usedFallback: false };
  }
  const fromEnv = process.env.P2P_HUB_VAULT_KEY;
  if (fromEnv) {
    return { masterKey: fromEnv, usedFallback: false };
  }
  return { masterKey: DEV_MASTER_KEY, usedFallback: true };
}

/**
 * Central encrypted store for secrets (API keys, certs/tokens).
 *
 * Every value is AES-256-GCM encrypted with a key derived from the master
 * passphrase. {@link getSecret} is for core use only — plugins must never
 * read raw secrets; they go through `ctx.ai` or the `vault` plugin's
 * set/list skills instead.
 */
export class VaultManager {
  private readonly dataDir: string;
  private readonly masterKey: string;
  readonly reservedPrefixes: string[];
  /** True when the master key fell back to the insecure dev-only key. */
  readonly usesFallbackKey: boolean;
  private salt: Buffer | null = null;
  private entries: Record<string, EncryptedEntry> = {};

  constructor(options: VaultManagerOptions = {}) {
    this.dataDir =
      options.dataDir ?? path.join(os.homedir(), ".p2p-hub", "vault");
    this.reservedPrefixes =
      options.reservedPrefixes ?? DEFAULT_RESERVED_PREFIXES;

    const { masterKey, usedFallback } = resolveMasterKey(options.masterKey);
    this.masterKey = masterKey;
    this.usesFallbackKey = usedFallback;

    if (usedFallback) {
      console.warn(
        "[p2p-hub] no vault master key configured (set P2P_HUB_VAULT_KEY or " +
          "pass masterKey). Falling back to a hard-coded, insecure dev-only " +
          "key — secrets are NOT protected from anyone who can read this " +
          "source.",
      );
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "refusing to start: no vault master key in production " +
            "(set P2P_HUB_VAULT_KEY)",
        );
      }
    }
  }

  private filePath(): string {
    return path.join(this.dataDir, "vault.json");
  }

  private deriveKey(): Buffer {
    if (!this.salt) {
      throw new Error("vault not loaded");
    }
    return crypto.scryptSync(this.masterKey, this.salt, KEY_LENGTH);
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath(), "utf8");
      const parsed = JSON.parse(raw) as VaultFile;
      this.salt = Buffer.from(parsed.salt, "hex");
      this.entries = parsed.entries ?? {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.salt = crypto.randomBytes(SALT_LENGTH);
        this.entries = {};
        return;
      }
      throw err;
    }
  }

  private async save(): Promise<void> {
    if (!this.salt) {
      throw new Error("vault not loaded");
    }
    await fs.mkdir(this.dataDir, { recursive: true });
    const file: VaultFile = {
      salt: this.salt.toString("hex"),
      entries: this.entries,
    };
    await fs.writeFile(this.filePath(), JSON.stringify(file, null, 2), "utf8");
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.load();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.deriveKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    this.entries[key] = {
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      data: encrypted.toString("hex"),
      updatedAt: new Date().toISOString(),
    };
    await this.save();
  }

  /** Core-only: reads a raw secret. Plugins must not call this directly. */
  async getSecret(key: string): Promise<string | null> {
    await this.load();
    const entry = this.entries[key];
    if (!entry) {
      return null;
    }
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.deriveKey(),
        Buffer.from(entry.iv, "hex"),
      );
      decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(entry.data, "hex")),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      // Wrong key or tampered ciphertext — treat as absent, never leak.
      return null;
    }
  }

  /** Returns key names only, never values. */
  async listSecretKeys(): Promise<string[]> {
    await this.load();
    return Object.keys(this.entries);
  }

  /** Whether a secret exists under `key`. Never reveals the value. */
  async hasSecret(key: string): Promise<boolean> {
    await this.load();
    return key in this.entries;
  }

  /**
   * Metadata for a single secret — existence and last-write timestamp, but
   * never the raw value. Returns null when the key is absent.
   */
  async getSecretMetadata(key: string): Promise<SecretMetadata | null> {
    await this.load();
    const entry = this.entries[key];
    if (!entry) {
      return null;
    }
    return { key, updatedAt: entry.updatedAt ?? null };
  }

  /** Metadata for every stored secret. Never contains any value. */
  async listSecretMetadata(): Promise<SecretMetadata[]> {
    await this.load();
    return Object.keys(this.entries).map((key) => ({
      key,
      updatedAt: this.entries[key].updatedAt ?? null,
    }));
  }

  async deleteSecret(key: string): Promise<boolean> {
    await this.load();
    if (!(key in this.entries)) {
      return false;
    }
    delete this.entries[key];
    await this.save();
    return true;
  }
}
