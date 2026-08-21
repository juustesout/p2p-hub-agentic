/**
 * Fase 2A — platform-scoped access passes.
 *
 * Before 2A, access passes existed only inside the peersite plugin as a
 * private in-memory `Map` with a single hardcoded scope. 2A generalizes the
 * concept into core: any plugin may mint ephemeral, scoped, per-peer access
 * passes through `ctx.access`, and the {@link TaskBroker}'s `access-pass`
 * remote gate checks them. This makes "verified contact *or* access pass" a
 * platform property instead of a per-plugin convention.
 *
 * Security invariants:
 *   - Passes are **never persisted** (ephemeral by design) and are **never
 *     bearer tokens**: they are keyed by the peerId, and the peer must still
 *     prove possession of its key over the transport on every call (the Fase
 *     1B identity binding). A stolen pass record alone authorizes nothing.
 *   - Passes are **scoped**: `hasValidPass(peerId, scope)` requires an exact
 *     scope match, so one pass never lifts the gate on unrelated capabilities.
 *   - Passes **expire** (`ttlMs`, default {@link DEFAULT_PASS_TTL_MS}).
 *   - `hasValidPass` never throws and lazily drops expired entries.
 */
export interface AccessPass {
  /** Persistent peerId the pass was issued to. */
  peerId: string;
  /** Scope string the pass lifts the gate on (e.g. `"site-read-only"`). */
  scope: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AccessPassManagerOptions {
  /** Default pass lifetime when `issue` is called without `ttlMs`. */
  defaultTtlMs?: number;
}

export const DEFAULT_PASS_TTL_MS = 60 * 60 * 1000;

export class AccessPassManager {
  private readonly passes = new Map<string, AccessPass>();
  private readonly defaultTtlMs: number;

  constructor(options: AccessPassManagerOptions = {}) {
    const ttl = options.defaultTtlMs ?? DEFAULT_PASS_TTL_MS;
    this.defaultTtlMs = Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_PASS_TTL_MS;
  }

  /**
   * Issue a pass for `peerId` over `scope`. Overwrites any existing pass for
   * the same `(peerId, scope)` pair. Throws on invalid input (empty peerId or
   * scope, non-positive ttl).
   */
  issue(peerId: string, scope: string, ttlMs?: number): AccessPass {
    if (typeof peerId !== "string" || peerId.length === 0) {
      throw new Error("access pass requires a non-empty peerId");
    }
    if (typeof scope !== "string" || scope.length === 0) {
      throw new Error("access pass requires a non-empty scope");
    }
    const ttl = ttlMs ?? this.defaultTtlMs;
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new Error("access pass ttl must be a positive integer");
    }
    const now = Date.now();
    const pass: AccessPass = { peerId, scope, issuedAt: now, expiresAt: now + ttl };
    this.passes.set(`${peerId}\u0000${scope}`, pass);
    return pass;
  }

  /** Revoke a pass; returns true when one existed for `(peerId, scope)`. */
  revoke(peerId: string, scope: string): boolean {
    return this.passes.delete(`${peerId}\u0000${scope}`);
  }

  /**
   * True when a valid, unexpired pass exists for `(peerId, scope)`. Never
   * throws; an expired entry is dropped and reported as absent.
   */
  hasValidPass(peerId: string, scope: string): boolean {
    const pass = this.passes.get(`${peerId}\u0000${scope}`);
    if (!pass) {
      return false;
    }
    if (Date.now() > pass.expiresAt) {
      this.passes.delete(`${peerId}\u0000${scope}`);
      return false;
    }
    return true;
  }

  /** Snapshot of every currently-held (unexpired) pass. */
  listPasses(): AccessPass[] {
    const now = Date.now();
    const result: AccessPass[] = [];
    for (const [key, pass] of this.passes) {
      if (now > pass.expiresAt) {
        this.passes.delete(key);
      } else {
        result.push(pass);
      }
    }
    return result;
  }
}
