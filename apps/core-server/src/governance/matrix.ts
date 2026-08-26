import { randomBytes } from "node:crypto";
import { validateObjectDepth } from "@p2p-hub/sdk";
import { atomicWriteFile, readJsonFile } from "@p2p-hub/core";

/**
 * Hard ceiling for a per-peer custom event-stream rate limit. `customRateLimit`
 * is the only field the UI/API can tune on a matrix entry, so it is bounded
 * here: above this value the write is rejected with {@link InvalidRateLimitError}
 * (never silently clamped, never "unlimited"). The cap is not overridable by
 * callers — it is the fail-closed guard against a matrix entry disabling the
 * per-(peer, topic) emit gate entirely.
 */
export const ABSOLUTE_MAX_RATE_LIMIT = 500;

/**
 * A persistent peerId (Ed25519 public key, 64 lowercase hex chars — the same
 * shape the contacts plugin and the wire contract use for transport-verified
 * identities).
 */
export const PEER_ID_RE = /^[0-9a-f]{64}$/;

export const MATRIX_FILE_VERSION = 1;

/** A single per-peer permission matrix entry. */
export interface PeerMatrixEntry {
  peerId: string;
  /** Exact network-exposed skill names the peer may invoke. */
  skills: string[];
  /** Exposed event topics the peer may subscribe to. */
  topics: string[];
  /**
   * Optional per-peer `maxMessagesPerSecond` for the event-stream emit gate.
   * Absent → the default rate config applies. Bounded above by
   * {@link ABSOLUTE_MAX_RATE_LIMIT}.
   */
  customRateLimit?: number;
  updatedAt: number;
}

export interface PeerMatrixStoreOptions {
  filePath: string;
  /** True when `skill` is exposed by an active manifest (network-reachable). */
  validateSkill: (skill: string) => boolean;
  /** True when `topic` is emitted by an active manifest. */
  validateTopic: (topic: string) => boolean;
}

interface PersistedMatrix {
  version: number;
  entries: PeerMatrixEntry[];
}

/**
 * A matrix entry can never name a skill/topic the manifest does not expose
 * (the intersection invariant: `EffectiveAccess = ManifestExposed ∩
 * PeerMatrixAllowed ∩ VerifiedStatus`). Thrown by the store when a write
 * violates that; the HTTP layer maps it to 403.
 */
export class AccessDeniedError extends Error {
  constructor(
    public readonly kind: "skill" | "topic",
    public readonly name: string,
  ) {
    super(
      `"${name}" is not exposed by any active manifest and cannot be granted via the permission matrix`,
    );
    this.name = "AccessDeniedError";
  }
}

/**
 * `customRateLimit` outside `1..ABSOLUTE_MAX_RATE_LIMIT` (inclusive) is a
 * validation error, never a silent clamp and never "unlimited". The HTTP layer
 * maps it to 422.
 */
export class InvalidRateLimitError extends Error {
  constructor(
    public readonly value: number,
    public readonly max: number,
  ) {
    super(`customRateLimit must be 1..${max} messages/second, got ${value}`);
    this.name = "InvalidRateLimitError";
  }
}

/**
 * The per-peer permission matrix backing the governance API.
 *
 * Semantics:
 * - entries are keyed by a *persistent* peerId (64-hex); a peer with no entry
 *   keeps the manifest default (no narrowing);
 * - a matrix entry can only ever *narrow* — every listed skill/topic is
 *   validated against the live manifest-exposed catalog at write time, so a
 *   matrix entry can never open a surface the manifest does not expose;
 * - the store is authoritative and persisted: writes are atomic
 *   (temp-file + fsync + rename) and a corrupt file fails loudly with
 *   `StorageCorruptionError`, never silently "empty".
 */
export class PeerMatrixStore {
  private entries = new Map<string, PeerMatrixEntry>();

  constructor(private readonly options: PeerMatrixStoreOptions) {}

  /** Load persisted entries. Missing file → empty store; corrupt → throw. */
  async load(): Promise<void> {
    const persisted = await readJsonFile<PersistedMatrix>(this.options.filePath);
    if (!persisted) {
      return;
    }
    validateObjectDepth(persisted);
    if (
      typeof persisted !== "object" ||
      !Array.isArray(persisted.entries) ||
      persisted.version !== MATRIX_FILE_VERSION
    ) {
      throw new Error(
        `governance matrix file has an unsupported shape/version: ${this.options.filePath}`,
      );
    }
    for (const entry of persisted.entries) {
      if (
        !entry ||
        typeof entry.peerId !== "string" ||
        !PEER_ID_RE.test(entry.peerId) ||
        !Array.isArray(entry.skills) ||
        !Array.isArray(entry.topics)
      ) {
        throw new Error(
          `governance matrix file contains an invalid entry: ${this.options.filePath}`,
        );
      }
      this.entries.set(entry.peerId, {
        peerId: entry.peerId,
        skills: [...new Set(entry.skills)].sort(),
        topics: [...new Set(entry.topics)].sort(),
        ...(typeof entry.customRateLimit === "number"
          ? { customRateLimit: entry.customRateLimit }
          : {}),
        updatedAt: entry.updatedAt,
      });
    }
  }

  entry(peerId: string): PeerMatrixEntry | undefined {
    return this.entries.get(peerId);
  }

  list(): PeerMatrixEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      a.peerId.localeCompare(b.peerId),
    );
  }

  has(peerId: string): boolean {
    return this.entries.has(peerId);
  }

  /**
   * True when the peer may invoke `skill`. No entry → allowed (the manifest
   * default applies; the matrix only narrows).
   */
  async isAllowed(peerId: string, skill: string): Promise<boolean> {
    const entry = this.entries.get(peerId);
    if (!entry) {
      return true;
    }
    return entry.skills.includes(skill);
  }

  /**
   * Create or replace the entry for `peerId`. `skills`/`topics` are validated
   * against the live manifest-exposed catalog (intersection invariant) and
   * `customRateLimit` against {@link ABSOLUTE_MAX_RATE_LIMIT}. Persists the
   * updated store atomically.
   */
  async set(
    peerId: string,
    spec: {
      skills: string[];
      topics: string[];
      customRateLimit?: number;
    },
  ): Promise<PeerMatrixEntry> {
    if (!PEER_ID_RE.test(peerId)) {
      throw new Error(`invalid peerId for permission matrix: ${peerId}`);
    }
    for (const skill of spec.skills) {
      if (!this.options.validateSkill(skill)) {
        throw new AccessDeniedError("skill", skill);
      }
    }
    for (const topic of spec.topics) {
      if (!this.options.validateTopic(topic)) {
        throw new AccessDeniedError("topic", topic);
      }
    }
    if (spec.customRateLimit !== undefined) {
      if (
        !Number.isInteger(spec.customRateLimit) ||
        spec.customRateLimit < 1 ||
        spec.customRateLimit > ABSOLUTE_MAX_RATE_LIMIT
      ) {
        throw new InvalidRateLimitError(
          spec.customRateLimit,
          ABSOLUTE_MAX_RATE_LIMIT,
        );
      }
    }

    const entry: PeerMatrixEntry = {
      peerId,
      skills: [...new Set(spec.skills)].sort(),
      topics: [...new Set(spec.topics)].sort(),
      ...(spec.customRateLimit !== undefined
        ? { customRateLimit: spec.customRateLimit }
        : {}),
      updatedAt: Date.now(),
    };
    this.entries.set(peerId, entry);
    await this.persist();
    return entry;
  }

  /** Remove a peer's entry entirely. Returns false when there was none. */
  async remove(peerId: string): Promise<boolean> {
    const existed = this.entries.delete(peerId);
    if (existed) {
      await this.persist();
    }
    return existed;
  }

  private async persist(): Promise<void> {
    const persisted: PersistedMatrix = {
      version: MATRIX_FILE_VERSION,
      entries: this.list(),
    };
    await atomicWriteFile(
      this.options.filePath,
      JSON.stringify(persisted, null, 2),
    );
  }

  /** Generate a fresh 64-hex peerId for tests. */
  static testPeerId(): string {
    return randomBytes(32).toString("hex");
  }
}
