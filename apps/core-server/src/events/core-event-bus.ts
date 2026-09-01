/**
 * CoreEventBus — a lightweight in-process publish/subscribe bus for local
 * domain events (Brief 5). This is deliberately NOT the peer-facing P2P event
 * network (`SubscriptionHub` in `@p2p-hub/core`); it is the core-server's own
 * async in-memory bus on which PBX-domain events (e.g. `invoice:created`,
 * `payment:observed`) are emitted locally and consumed by the PAL engine.
 *
 * Invariants:
 * - Topics use the same delimiter rule as the platform's event layer
 *   (`EVENT_TOPIC_RE`): `:` is the one unambiguous delimiter, never allowed
 *   inside a segment. Only exact topics are accepted — no wildcards on the
 *   local bus (fail-closed: a wildcard topic throws at subscribe/emit).
 * - Payloads are depth-guarded (shared boundary-guard primitive) and must be
 *   JSON-serializable, so a pathological deep payload cannot blow the stack
 *   during evaluation and a cyclic object cannot wedge a consumer.
 * - Subscriptions are fail-closed: an invalid topic throws loudly at
 *   `subscribe`, never silently drops. A throwing handler never crashes
 *   `emit` (it is caught and logged), so one broken rule cannot take the bus
 *   down — but it is still loud, not silently swallowed.
 * - Handlers run sequentially per emit, in subscription order, so rule
 *   evaluation is deterministic (important for rate-limit semantics).
 */

import { EVENT_TOPIC_RE } from "@p2p-hub/core";
import { isPlainObject, validateObjectDepth } from "@p2p-hub/sdk";
import { moduleLogger } from "../logger";

export interface CoreEvent {
  /** The exact topic the event was emitted on. */
  topic: string;
  /** Monotonic wall-clock at emission time (ms). */
  at: number;
}

/** Receive one event. May be async; a throw is caught and logged by the bus. */
export type CoreEventHandler = (
  payload: unknown,
  event: CoreEvent,
) => void | Promise<void>;

export interface Disposable {
  dispose(): void;
}

/**
 * The one topic the local bus accepts: two to four segments joined by `:`,
 * no wildcard, no empty segment. A `:` is *required* — a bare single-segment
 * string is not a domain event (the namespace prefix is the delimiter-anchored
 * structure the bus enforces, per CLAUDE.md principle #2).
 */
export const CORE_EVENT_TOPIC_RE =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*){1,3}$/;

function assertTopic(topic: string): void {
  if (
    typeof topic !== "string" ||
    topic.length === 0 ||
    !CORE_EVENT_TOPIC_RE.test(topic) ||
    !EVENT_TOPIC_RE.test(topic) ||
    topic.includes("*")
  ) {
    throw new Error(
      `invalid event topic ${JSON.stringify(topic)}: expected segments of ` +
        `[A-Za-z0-9_][A-Za-z0-9_.-]* joined by ":" with no wildcard`,
    );
  }
}

function assertPayload(payload: unknown): void {
  if (!isPlainObject(payload)) {
    throw new Error("event payload must be a plain object");
  }
  validateObjectDepth(payload);
  try {
    JSON.stringify(payload);
  } catch {
    throw new Error("event payload must be JSON-serializable");
  }
}

export class CoreEventBus {
  private readonly subscribers = new Map<string, Set<CoreEventHandler>>();

  /**
   * Subscribe to an exact topic. Throws on an invalid topic (fail-closed).
   * Returns a disposable; disposing is idempotent and safe while emitting.
   */
  subscribe(topic: string, handler: CoreEventHandler): Disposable {
    assertTopic(topic);
    if (typeof handler !== "function") {
      throw new Error("event handler must be a function");
    }
    let set = this.subscribers.get(topic);
    if (!set) {
      set = new Set();
      this.subscribers.set(topic, set);
    }
    set.add(handler);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        set!.delete(handler);
        if (set!.size === 0) {
          this.subscribers.delete(topic);
        }
      },
    };
  }

  /**
   * Publish an event. Validates the topic and payload first (throws loudly on
   * a malformed emit — a broken producer must be visible, not silent). Handler
   * errors are caught and logged so one consumer never breaks the others.
   */
  async emit(topic: string, payload: unknown): Promise<void> {
    assertTopic(topic);
    assertPayload(payload);
    const set = this.subscribers.get(topic);
    if (!set) {
      return;
    }
    const event: CoreEvent = { topic, at: Date.now() };
    for (const handler of [...set]) {
      try {
        await handler(payload, event);
      } catch (err) {
        moduleLogger("pal-bus").warn(
          err,
          `[core-event-bus] handler for topic "${topic}" threw`,
        );
      }
    }
  }

  /** Number of live subscriptions for a topic (tests/diagnostics). */
  subscriberCount(topic: string): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }

  /** Drop every subscription (tests and host teardown). */
  reset(): void {
    this.subscribers.clear();
  }

  /**
   * Graceful-shutdown alias for {@link reset}: drop every subscription when the
   * host stops (Brief 6 lifecycle), so a restart never inherits a stale
   * listener that would evaluate a rule against a torn-down engine.
   */
  removeAllListeners(): void {
    this.reset();
  }
}
