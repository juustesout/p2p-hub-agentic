/**
 * Deel 1: broker-wide per-peer rate limiting for network-originated tasks.
 *
 * The TaskBroker enforces a per-peer sliding-window budget on every task that
 * arrives through `handleRemote` — the network path. Local callers (`handle`)
 * and HTTP-bridge callers (`handleHttp`) are never counted: they are trusted
 * in-process / loopback surfaces, not an anonymous WAN-facing boundary.
 *
 * The limiter keys on the *transport-verified* peer identity (never a
 * caller-supplied payload field), across *all* skills a peer calls — this is
 * deliberately a broker-wide cap, independent of the A1/Slice 4 telemetry
 * frequency caps (which are per-peer, per-skill, and only for `"telemetry"`
 * capabilities). Overflow fails with a typed error
 * (`PeerRateLimitExceededError` / `PEER_RATE_LIMIT_ERROR_CODE`), never with
 * silent execution and never with a throw escaping the broker.
 */

/** Per-peer sliding-window configuration for network-originated tasks. */
export interface PeerRateLimitConfig {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Maximum network-originated tasks per peer inside one window. */
  maxTasks: number;
}

/**
 * Fail-closed default: network tasks are rate-limited even when no explicit
 * config is provided, so "forgot to configure" is never "unlimited".
 */
export const DEFAULT_PEER_RATE_LIMIT: PeerRateLimitConfig = {
  windowMs: 60_000,
  maxTasks: 30,
};

/** Wire/in-process error code carried on a rate-limited TaskResult. */
export const PEER_RATE_LIMIT_ERROR_CODE = "peer-rate-limit";

/**
 * Raised by the broker when a peer exceeds the per-minute task budget on the
 * network path. Distinct from a gate denial so callers can tell "slow down"
 * apart from "not authorized".
 */
export class PeerRateLimitExceededError extends Error {
  constructor(peerId: string) {
    super(`peer "${peerId}" exceeded the per-minute network task budget`);
    this.name = "PeerRateLimitExceededError";
  }
}

interface PeerBucket {
  timestamps: number[];
  /** Monotonic bookkeeping: time of the last attempt (allowed or denied). */
  lastTouch: number;
}

/**
 * In-memory sliding-window rate limiter keyed by peerId. Thread-safe enough
 * for the single-threaded event loop; buckets are pruned lazily so memory
 * stays bounded to peers active within one window. Anonymous remote callers
 * share one budget (the broker feeds them a shared `<anonymous>` key).
 */
export class PeerRateLimiter {
  private readonly windowMs: number;
  private readonly maxTasks: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, PeerBucket>();
  private lastSweep = 0;

  constructor(config: PeerRateLimitConfig, now: () => number = Date.now) {
    if (
      !Number.isInteger(config.windowMs) ||
      config.windowMs <= 0 ||
      !Number.isInteger(config.maxTasks) ||
      config.maxTasks <= 0
    ) {
      throw new Error(
        `invalid peer rate limit config: windowMs and maxTasks must be positive integers`,
      );
    }
    this.windowMs = config.windowMs;
    this.maxTasks = config.maxTasks;
    this.now = now;
  }

  /** Whether this limiter enforces any budget (always true — see ctor). */
  isActive(): boolean {
    return this.maxTasks > 0;
  }

  /**
   * Record a network-originated task for `peerId` and report whether it is
   * inside the allowed budget. Returns `false` when the task must be rejected —
   * the caller (TaskBroker) turns that into a typed error result and never
   * dispatches the handler.
   */
  allow(peerId: string): boolean {
    const now = this.now();
    this.maybeSweep(now);
    const bucket = this.buckets.get(peerId) ?? { timestamps: [], lastTouch: now };
    const cutoff = now - this.windowMs;
    const timestamps = bucket.timestamps;
    let drop = 0;
    while (drop < timestamps.length && timestamps[drop] <= cutoff) {
      drop += 1;
    }
    if (drop > 0) {
      timestamps.splice(0, drop);
    }
    bucket.lastTouch = now;
    if (timestamps.length >= this.maxTasks) {
      this.buckets.set(peerId, bucket);
      return false;
    }
    timestamps.push(now);
    this.buckets.set(peerId, bucket);
    return true;
  }

  /** Drop all state (used by tests). */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Bound memory: remove buckets with no activity within the last window.
   * Sweeping at most once per window keeps the cost negligible.
   */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) {
      return;
    }
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [peerId, bucket] of this.buckets) {
      if (bucket.lastTouch < cutoff) {
        this.buckets.delete(peerId);
      }
    }
  }
}
