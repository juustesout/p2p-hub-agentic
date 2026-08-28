/**
 * Transport-neutral event/subscription types shared by the SubscriptionHub and
 * RemoteEventAdapter (Stap 5). These mirror the `p2p-hub:network` wire frames
 * (`sub_req`/`sub_ack`/`event_emit`) that live in
 * `plugins/network-light/src/wire-contract.ts`; the wire *encoding/validation*
 * stays in the provider, so an independent transport can interoperate without
 * sharing TypeScript (same doctrine as the website contract). Core deliberately
 * does NOT import from any plugin — these are structural types the provider's
 * own types satisfy by duck-typing.
 */

export type SubscriptionAction = "subscribe" | "unsubscribe";

/** `sub_req` body (subscriber → publisher). */
export interface SubReqBody {
  subscriptionId: string;
  topic: string;
  action: SubscriptionAction;
  /** Requested subscription lifetime in ms; the publisher may grant less. */
  ttlMs?: number;
}

/** `sub_ack` body (publisher → subscriber). */
export interface SubAckBody {
  subscriptionId: string;
  topic: string;
  accepted: boolean;
  /** Fail-closed deny reason when `accepted` is false. */
  reason?: string;
  /** Effective granted lifetime in ms (present on accepted subscribes). */
  ttlMs?: number;
}

/** `event_emit` body (publisher → subscriber). */
export interface EventEmitBody {
  subscriptionId: string;
  topic: string;
  /**
   * The publisher's persistent peerId. NEVER caller-trusted: the transport
   * verifies it equals the Fase 1B authenticated connection peerId and the
   * adapter re-checks it (defense-in-depth) before dispatch.
   */
  publisherPeerId: string;
  /** Publisher's event time in epoch ms. */
  timestamp: number;
  /** Per-subscription monotonic counter (loss/reorder detection). */
  sequenceNumber: number;
  payload: unknown;
}

/**
 * An inbound event-transport message as delivered by the active provider.
 * `peerId` is always the transport-verified Fase 1B identity of the sender —
 * the provider sets it, never the peer.
 */
export type InboundEventMessage =
  | { peerId: string; type: "sub_req"; body: SubReqBody }
  | { peerId: string; type: "event_emit"; body: EventEmitBody };

/**
 * Handler invoked for each inbound event-transport message. Returning a
 * `SubAckBody` answers a `sub_req` on the same connection; returning `null`
 * (the normal answer to an `event_emit`) writes nothing.
 */
export type EventMessageHandler = (
  msg: InboundEventMessage,
) => Promise<SubAckBody | null> | SubAckBody | null;

/**
 * Maximum number of `:segment` parts after the base in a topic. Bounded on
 * purpose (the same DoS-capping discipline as every other depth cap in the
 * codebase): enough for per-entity topics like `tasks:project:<id>:updated`
 * (base + 3 segments), never unbounded nesting.
 */
export const MAX_TOPIC_SEGMENTS = 3;

/**
 * A topic: `[A-Za-z0-9_][A-Za-z0-9_.-]*` with zero to {@link MAX_TOPIC_SEGMENTS}
 * delimiter-separated segments (`:name`) and an optional trailing `:*` wildcard.
 * A `:` is never allowed *inside* a segment value, so `:` is the one unambiguous
 * delimiter — the same invariant that keeps dotted plugin ids from colliding
 * (a segment may still contain `.`/`-`/`_`, but never a colon, so no encoding
 * trick can smuggle a fake delimiter into a topic). Mirrors the wire contract's
 * `TOPIC_RE` (wildcard only the terminal `:*` form) so a wire-valid topic is
 * never hub-rejected confusingly.
 */
export const EVENT_TOPIC_RE =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*){0,3}(?::\*)?$/;

/** Whether a topic ends in the terminal `:*` wildcard. */
export function isWildcardTopic(topic: string): boolean {
  return topic.endsWith(":*");
}

/**
 * Delimiter-anchored match of `actual` against a (possibly wildcard)
 * subscription topic. `calendar:*` matches `calendar:eventAdded` but never
 * `calendarEvil:x` or a bare `calendar` (CLAUDE.md principle #2).
 */
export function topicMatches(subscribed: string, actual: string): boolean {
  if (subscribed === actual) {
    return true;
  }
  if (isWildcardTopic(subscribed)) {
    return actual.startsWith(subscribed.slice(0, -2) + ":");
  }
  return false;
}

/**
 * Serialized UTF-8 byte size of a payload for telemetry-gate accounting, or
 * `null` when the payload cannot be JSON-serialized. Used by both the
 * receiver-side dispatch gate (`RemoteEventAdapter`) and the sender-side
 * fan-out gate (`SubscriptionHub`) so sizing is consistent across the layer.
 */
export function safeByteSize(payload: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    return null;
  }
}
