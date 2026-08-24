/**
 * Slice 4 (plan.md "Besluit 3" transport-level half): the streaming/telemetry
 * frequency gate.
 *
 * The broker's `TelemetryRateLimiter` covers the *request/response*
 * instantiation of Decision 3 — a `"telemetry"` capability invoked as a
 * discrete task. That limiter is tuned for low-frequency calls and is the
 * wrong shape for continuous streaming frames (20 Hz-style camera/sensor
 * feeds), which are never discrete tasks and never queue in the TaskBroker.
 *
 * This gate is the transport-level enforcement point a future streaming
 * capability must route its frames through: a per-peer, per-channel
 * sliding-window budget with two independent dimensions —
 *
 *   - message cap (max frames per window), and
 *   - byte cap (max payload bytes per window),
 *
 * plus abuse containment: a peer that sustains more than 2x the message cap in
 * one window raises `PeerStreamViolationError` and has that specific channel
 * pinched for a cooldown. It is deliberately forward-looking infrastructure
 * (the media-gate pattern): no streaming capability exists yet, so this is the
 * gate a future capability must use, not a feature on its own. Overflow
 * *drops* — it never queues, never error-spams, and never closes a connection
 * (design doc "Decision 3").
 *
 * Keys are the transport-verified `peerId` + an application `channelId`; the
 * caller decides what a channel is, but the budget can never bleed across
 * peers or across channels of the same peer.
 */

/** Per-stream sliding-window configuration. Every value is a per-window cap. */
export interface StreamRateConfig {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Maximum messages from one peer on one channel inside one window. */
  maxMessagesPerSecond: number;
  /** Maximum payload bytes from one peer on one channel inside one window. */
  maxBytesPerSecond: number;
}

/**
 * Fail-closed default: a stream is rate-limited even when nothing is
 * registered explicitly, so "forgot to configure" is never "unlimited".
 */
export const DEFAULT_STREAM_RATE_CONFIG: StreamRateConfig = {
  windowMs: 1_000,
  maxMessagesPerSecond: 60,
  maxBytesPerSecond: 1_048_576,
};

/** Why a frame was dropped. `"stream-violation"` follows a pinch. */
export type StreamDenyReason =
  | "message-cap"
  | "byte-cap"
  | "stream-violation";

/** Verdict of a single frame check — never throws for a normal denial. */
export type StreamCheckResult =
  | { allowed: true }
  | { allowed: false; reason: StreamDenyReason };

/**
 * Raised once when a peer sustains more than 2x the message cap on a channel
 * within one window. The gate pinches that channel for a cooldown and every
 * subsequent frame while pinched is dropped with `"stream-violation"` (no
 * further exceptions). Only the escalation throws — ordinary overflow drops.
 */
export class PeerStreamViolationError extends Error {
  readonly peerId: string;
  readonly channelId: string;

  constructor(peerId: string, channelId: string) {
    super(
      `peer "${peerId}" sustained >2x the telemetry message cap on channel "${channelId}"`,
    );
    this.name = "PeerStreamViolationError";
    this.peerId = peerId;
    this.channelId = channelId;
  }
}

interface StreamEntry {
  at: number;
  bytes: number;
}

interface StreamBucket {
  config: StreamRateConfig;
  entries: StreamEntry[];
  /** Consecutive denied frames (reset on an allowed frame). */
  denials: number;
  /** While `now < pinchedUntil`, every frame is dropped as a violation. */
  pinchedUntil: number;
  /** Monotonic bookkeeping: time of the last check (allowed or denied). */
  lastTouch: number;
}

function validateConfig(config: StreamRateConfig, label: string): void {
  if (
    !Number.isInteger(config.windowMs) ||
    config.windowMs <= 0 ||
    !Number.isInteger(config.maxMessagesPerSecond) ||
    config.maxMessagesPerSecond <= 0 ||
    !Number.isInteger(config.maxBytesPerSecond) ||
    config.maxBytesPerSecond <= 0
  ) {
    throw new Error(
      `${label}: windowMs, maxMessagesPerSecond and maxBytesPerSecond must be positive integers`,
    );
  }
}

function keyFor(peerId: string, channelId: string): string {
  return `${peerId}\u0000${channelId}`;
}

/**
 * In-memory sliding-window streaming gate keyed by `peerId \u0000 channelId`.
 * Thread-safe enough for the single-threaded event loop; buckets are pruned
 * lazily so memory stays bounded to peers active within one window.
 */
export class TelemetryGate {
  private readonly defaultConfig: StreamRateConfig;
  private readonly now: () => number;
  private readonly buckets = new Map<string, StreamBucket>();
  private lastSweep = 0;

  constructor(
    config: Partial<StreamRateConfig> = {},
    now: () => number = Date.now,
  ) {
    const merged: StreamRateConfig = { ...DEFAULT_STREAM_RATE_CONFIG, ...config };
    validateConfig(merged, "telemetry gate");
    this.defaultConfig = merged;
    this.now = now;
  }

  /**
   * Register a channel (or override its config). Without a registration a
   * channel still gets the fail-closed default budget — registration exists
   * for lifecycle and explicit tuning, never as a bypass. Re-registering an
   * existing channel resets its window.
   */
  registerStream(
    peerId: string,
    channelId: string,
    config: Partial<StreamRateConfig> = {},
  ): void {
    const merged: StreamRateConfig = { ...this.defaultConfig, ...config };
    validateConfig(merged, `stream ${peerId}\u0000${channelId}`);
    this.buckets.set(keyFor(peerId, channelId), {
      config: merged,
      entries: [],
      denials: 0,
      pinchedUntil: 0,
      lastTouch: this.now(),
    });
  }

  /** Tear down a channel and free its state. */
  closeStream(peerId: string, channelId: string): void {
    this.buckets.delete(keyFor(peerId, channelId));
  }

  /**
   * Check a frame against the channel budget and, if allowed, consume it.
   * Returns `{ allowed: false, reason }` (drop, never queue) when the message
   * or byte cap is exceeded. Raises {@link PeerStreamViolationError} once when
   * a peer sustains >2x the message cap within one window, pinching the
   * channel. Fails closed: an unregistered channel uses the default budget.
   */
  checkAndConsume(
    peerId: string,
    channelId: string,
    byteSize: number,
  ): StreamCheckResult {
    if (!Number.isInteger(byteSize) || byteSize < 0) {
      throw new Error(
        `byteSize must be a non-negative integer, got ${byteSize}`,
      );
    }
    const now = this.now();
    this.maybeSweep(now);
    const key = keyFor(peerId, channelId);
    const bucket =
      this.buckets.get(key) ?? {
        config: this.defaultConfig,
        entries: [],
        denials: 0,
        pinchedUntil: 0,
        lastTouch: now,
      };
    this.buckets.set(key, bucket);
    return this.consume(bucket, peerId, channelId, now, byteSize);
  }

  /** Drop all state (used by tests and by stop/unregister paths). */
  reset(): void {
    this.buckets.clear();
  }

  private consume(
    bucket: StreamBucket,
    peerId: string,
    channelId: string,
    now: number,
    byteSize: number,
  ): StreamCheckResult {
    if (bucket.pinchedUntil > now) {
      bucket.lastTouch = now;
      return { allowed: false, reason: "stream-violation" };
    }
    if (bucket.pinchedUntil !== 0 && bucket.pinchedUntil <= now) {
      // Cooldown expired: reopen the channel on a clean slate.
      bucket.pinchedUntil = 0;
      bucket.denials = 0;
    }

    const cutoff = now - bucket.config.windowMs;
    let drop = 0;
    while (drop < bucket.entries.length && bucket.entries[drop].at <= cutoff) {
      drop += 1;
    }
    if (drop > 0) {
      bucket.entries.splice(0, drop);
    }
    bucket.lastTouch = now;

    if (byteSize > bucket.config.maxBytesPerSecond) {
      return this.deny(bucket, peerId, channelId, now, "byte-cap");
    }
    const windowBytes = bucket.entries.reduce((sum, e) => sum + e.bytes, 0);
    if (bucket.entries.length >= bucket.config.maxMessagesPerSecond) {
      return this.deny(bucket, peerId, channelId, now, "message-cap");
    }
    if (windowBytes + byteSize > bucket.config.maxBytesPerSecond) {
      return this.deny(bucket, peerId, channelId, now, "byte-cap");
    }

    bucket.denials = 0;
    bucket.entries.push({ at: now, bytes: byteSize });
    return { allowed: true };
  }

  private deny(
    bucket: StreamBucket,
    peerId: string,
    channelId: string,
    now: number,
    reason: StreamDenyReason,
  ): StreamCheckResult {
    bucket.denials += 1;
    if (bucket.denials > bucket.config.maxMessagesPerSecond * 2) {
      bucket.pinchedUntil = now + bucket.config.windowMs * 2;
      throw new PeerStreamViolationError(peerId, channelId);
    }
    return { allowed: false, reason };
  }

  /**
   * Bound memory: remove buckets with no activity within the last window.
   * Sweeping at most once per window keeps the cost negligible.
   */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < this.defaultConfig.windowMs) {
      return;
    }
    this.lastSweep = now;
    const cutoff = now - this.defaultConfig.windowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastTouch < cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}
