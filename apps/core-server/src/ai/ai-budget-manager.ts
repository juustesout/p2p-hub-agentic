import type { AIBudgetGate, AIInvocationContext } from "@p2p-hub/core";
import { AIQuotaExceededError } from "@p2p-hub/core";

/**
 * AI budget configuration. Each dimension is optional and independent; a
 * missing dimension falls back to the fail-closed default (never "unlimited").
 */
export interface AIBudgetConfig {
  /** Per-`peerId` cap: `limit` LLM calls per rolling `windowMs`. */
  perPeer?: { limit: number; windowMs: number };
  /** Node-wide failsafe: `limit` LLM calls per rolling `windowMs` across every caller. */
  global?: { limit: number; windowMs: number };
}

/** Default per-peer AI budget: 10 requests per rolling hour. */
export const DEFAULT_PER_PEER_AI_LIMIT = 10;
export const DEFAULT_PER_PEER_AI_WINDOW_MS = 60 * 60 * 1000;

/** Default node-wide failsafe: 30 requests per rolling minute. */
export const DEFAULT_GLOBAL_AI_LIMIT = 30;
export const DEFAULT_GLOBAL_AI_WINDOW_MS = 60 * 1000;

/** Budget key for local/HTTP-bridge callers that carry no transport peerId. */
const LOCAL_OPERATOR_KEY = "<local>";

/**
 * Rolling-window counter: `limit` accepted calls per `windowMs`, sliding. Used
 * by both the per-peer buckets and the node-wide failsafe. Rejected calls are
 * not recorded (a burst of refusals never extends the window); entries that
 * slide out of the window free their slot.
 */
class SlidingWindow {
  private timestamps: number[] = [];
  private lastTouch: number;

  constructor(private readonly now: () => number) {
    this.lastTouch = now();
  }

  /** Record and allow the call, or refuse it without recording. */
  allow(limit: number, windowMs: number): boolean {
    const now = this.now();
    this.lastTouch = now;
    const cutoff = now - windowMs;
    let write = 0;
    for (let read = 0; read < this.timestamps.length; read++) {
      if (this.timestamps[read] > cutoff) {
        this.timestamps[write++] = this.timestamps[read];
      }
    }
    this.timestamps.length = write;
    if (this.timestamps.length >= limit) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }

  /** How many calls are recorded inside the current window (read-only). */
  count(): number {
    return this.timestamps.length;
  }

  /** Drop all recorded calls (tests and unregister paths). */
  reset(): void {
    this.timestamps = [];
    this.lastTouch = this.now();
  }

  /** True when this window saw no activity for at least `windowMs`. */
  idleSince(now: number, windowMs: number): boolean {
    return now - this.lastTouch >= windowMs;
  }
}

/** Human-readable window label for quota messages, e.g. `1h`, `60s`. */
export function windowLabel(windowMs: number): string {
  if (windowMs >= 60 * 60 * 1000) {
    const hours = Math.round(windowMs / (60 * 60 * 1000));
    return `${hours}h`;
  }
  if (windowMs >= 60 * 1000) {
    const minutes = Math.round(windowMs / (60 * 1000));
    return `${minutes}m`;
  }
  return `${Math.round(windowMs / 1000)}s`;
}

/** Clamp a positive integer config value, falling back to `fallback`. */
function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : fallback;
}

/**
 * In-memory anti-financial-DoS quota gate for AI calls. Enforced at the single
 * choke point (`CoreAIProvider`), keyed on the *transport-verified* caller
 * peerId (never a caller-supplied field). Local/HTTP-bridge callers without a
 * peerId share the {@link LOCAL_OPERATOR_KEY} budget; every caller also draws
 * from the node-wide failsafe, so no single peer — and no aggregate of peers —
 * can drive unbounded LLM spend.
 *
 * `consume` throws {@link AIQuotaExceededError} (code `ai-quota-exceeded`)
 * when the call is over quota; the TaskBroker surfaces it as a typed error
 * result and the HTTP bridge maps it to a controlled 429 without the LLM ever
 * being reached.
 */
export class AIBudgetManager implements AIBudgetGate {
  private readonly perPeerLimit: number;
  private readonly perPeerWindowMs: number;
  private readonly globalLimit: number;
  private readonly globalWindowMs: number;
  private readonly now: () => number;
  private readonly perPeer = new Map<string, SlidingWindow>();
  private readonly globalWindow: SlidingWindow;
  private lastSweep = 0;

  constructor(config: AIBudgetConfig = {}, now: () => number = Date.now) {
    this.perPeerLimit = positiveInt(
      config.perPeer?.limit,
      DEFAULT_PER_PEER_AI_LIMIT,
    );
    this.perPeerWindowMs = positiveInt(
      config.perPeer?.windowMs,
      DEFAULT_PER_PEER_AI_WINDOW_MS,
    );
    this.globalLimit = positiveInt(config.global?.limit, DEFAULT_GLOBAL_AI_LIMIT);
    this.globalWindowMs = positiveInt(
      config.global?.windowMs,
      DEFAULT_GLOBAL_AI_WINDOW_MS,
    );
    this.now = now;
    this.globalWindow = new SlidingWindow(now);
  }

  /** Refuse the call (throw) when either the per-peer or the node-wide budget is exhausted. */
  consume(context?: AIInvocationContext): void {
    this.maybeSweep(this.now());
    const peerKey =
      context?.peerId && context.peerId.length > 0
        ? context.peerId
        : LOCAL_OPERATOR_KEY;

    // Per-peer budget first: the most specific verdict. A call refused here is
    // never recorded against the node-wide failsafe (refusals don't consume).
    const peerWindow = this.windowFor(peerKey);
    if (!peerWindow.allow(this.perPeerLimit, this.perPeerWindowMs)) {
      throw new AIQuotaExceededError(
        `AI quota exceeded for peer "${peerKey}": at most ${this.perPeerLimit} ` +
          `request(s) per ${windowLabel(this.perPeerWindowMs)}`,
      );
    }

    // Node-wide failsafe: caps aggregate spend across all callers, so a set of
    // peers (or a busy local operator) cannot exceed the node's budget either.
    if (!this.globalWindow.allow(this.globalLimit, this.globalWindowMs)) {
      throw new AIQuotaExceededError(
        `AI quota exceeded: node-wide at most ${this.globalLimit} ` +
          `request(s) per ${windowLabel(this.globalWindowMs)}`,
      );
    }
  }

  /** Recorded calls for a peer inside its current window (read-only, no recording). */
  peerUsage(peerId: string): number {
    return this.windowFor(peerId).count();
  }

  /** Recorded calls against the node-wide failsafe in the current window. */
  globalUsage(): number {
    return this.globalWindow.count();
  }

  /** Drop all budget state (tests and unregister paths). */
  reset(): void {
    this.perPeer.clear();
    this.globalWindow.reset();
  }

  private windowFor(peerId: string): SlidingWindow {
    let window = this.perPeer.get(peerId);
    if (!window) {
      window = new SlidingWindow(this.now);
      this.perPeer.set(peerId, window);
    }
    return window;
  }

  /**
   * Bound memory: drop per-peer buckets that saw no activity within the last
   * window. Runs at most once per window, so the cost stays negligible.
   */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < this.perPeerWindowMs) {
      return;
    }
    this.lastSweep = now;
    for (const [key, window] of this.perPeer) {
      if (window.idleSince(now, this.perPeerWindowMs)) {
        this.perPeer.delete(key);
      }
    }
  }
}
