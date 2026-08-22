/**
 * Slice 4 (plan.md "Besluit 3"): per-peer telemetry frequency caps.
 *
 * A `"telemetry"` capability is read-only and side-effect-free by declaration,
 * but it is still a remote-facing surface a peer could hammer. The TaskBroker
 * therefore enforces a per-peer, per-skill sliding-window cap on every
 * telemetry invocation before the handler runs. Overflow fails with a typed
 * error (`TelemetryRateLimitExceededError` / `TELEMETRY_RATE_LIMIT_ERROR_CODE`),
 * never with silent execution.
 *
 * The limiter keys on the *transport-verified* peer identity (never a
 * caller-supplied payload field) and on the skill name, so one noisy skill
 * cannot starve another and one peer's budget never bleeds into another's.
 */

/** Per-peer sliding-window configuration for telemetry capabilities. */
export interface TelemetryRateLimitConfig {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Maximum telemetry calls per peer per skill inside one window. */
  maxCalls: number;
}

/**
 * Fail-closed default: telemetry capabilities are rate-limited even when no
 * explicit config is provided, so "forgot to configure" is never "unlimited".
 */
export const DEFAULT_TELEMETRY_RATE_LIMIT: TelemetryRateLimitConfig = {
  windowMs: 1_000,
  maxCalls: 10,
};

/** Wire/in-process error code carried on a rate-limited TaskResult. */
export const TELEMETRY_RATE_LIMIT_ERROR_CODE = "telemetry-rate-limit";

/**
 * Raised by the broker when a peer exceeds the frequency cap on a telemetry
 * capability. Distinct from a gate denial so the shell can tell "slow down"
 * apart from "not authorized".
 */
export class TelemetryRateLimitExceededError extends Error {
  constructor(peerId: string, skill: string) {
    super(
      `telemetry rate limit exceeded for peer "${peerId}" on skill "${skill}"`,
    );
    this.name = "TelemetryRateLimitExceededError";
  }
}

interface TelemetryBucket {
  timestamps: number[];
  /** Monotonic bookkeeping: time of the last attempt (allowed or denied). */
  lastTouch: number;
}

/**
 * In-memory sliding-window rate limiter keyed by `peerId \u0000 skill`.
 * Thread-safe enough for the single-threaded event loop; buckets are pruned
 * lazily so memory stays bounded to peers active within one window.
 */
export class TelemetryRateLimiter {
  private readonly windowMs: number;
  private readonly maxCalls: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, TelemetryBucket>();
  private lastSweep = 0;

  constructor(config: TelemetryRateLimitConfig, now: () => number = Date.now) {
    this.windowMs = config.windowMs;
    this.maxCalls = config.maxCalls;
    this.now = now;
  }

  /**
   * Record a telemetry invocation for `peerId` on `skill` and report whether
   * it is inside the allowed frequency budget. Returns `false` when the call
   * must be rejected — the caller (TaskBroker) turns that into a typed error
   * and never dispatches the handler.
   */
  allow(peerId: string, skill: string): boolean {
    const now = this.now();
    this.maybeSweep(now);
    const key = `${peerId}\u0000${skill}`;
    const bucket = this.buckets.get(key) ?? { timestamps: [], lastTouch: now };
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
    if (timestamps.length >= this.maxCalls) {
      this.buckets.set(key, bucket);
      return false;
    }
    timestamps.push(now);
    this.buckets.set(key, bucket);
    return true;
  }

  /** Drop all state (used by tests and by unregister paths). */
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
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastTouch < cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}
