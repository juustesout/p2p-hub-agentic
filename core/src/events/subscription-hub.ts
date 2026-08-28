import type { NetworkPeer } from "@p2p-hub/sdk";
import {
  checkPeerAccess,
  type PeerAccessContext,
  type PeerAccessOptions,
} from "../security/peer-access-gate";
import type { EventNetwork } from "./event-network";
import {
  TelemetryGate,
  type StreamRateConfig,
} from "../security/telemetry-gate";
import {
  EVENT_TOPIC_RE,
  isWildcardTopic,
  safeByteSize,
  topicMatches,
  type EventEmitBody,
  type InboundEventMessage,
  type SubAckBody,
  type SubReqBody,
} from "./types";

/**
 * Stap 5 — SubscriptionHub: remote subscriptions *towards us*.
 *
 * This is the fail-closed authorization point for "who may receive our
 * events". Every inbound `sub_req` passes through `handleSubReq`, which applies
 * (in order):
 *
 *   1. peer-level gate (`checkPeerAccess`, default `["open-lan"]`),
 *   2. per-topic exposure (`exposedEvents` exact-match for exact topics;
 *      wildcard topics are registered without leaking which specific topics
 *      exist — emit-time re-authorization is what gates them, refinement #4a),
 *   3. hard caps (`MAX_SUBSCRIPTIONS_PER_PEER` / `MAX_SUBSCRIPTIONS_PER_TOPIC`,
 *      refinement #4b) and
 *   4. a bounded granted TTL (client request clamped to
 *      `MAX_SUBSCRIPTION_TTL_MS`, default `DEFAULT_SUBSCRIPTION_TTL_MS`).
 *
 * `emitLocal(topic, payload)` is the fan-out path: the exact topic must be in
 * `exposedEvents` (a non-exposed topic throws `TopicNotExposedError` and
 * reaches no subscriber — exact AND wildcard subscribers alike), and each
 * matching subscriber receives an `event_emit` carrying OUR transport-verified
 * `publisherPeerId`, a per-subscription monotonic `sequenceNumber` and the
 * granted `subscriptionId`. The fan-out is throttled per (subscriber, topic)
 * by the outbound telemetry gate — overflow drops that subscriber's frame, so
 * a publisher cannot flood a peer on the wire. Expired subscriptions are
 * pruned lazily (on access and on an interval sweep), so a vanished peer is
 * bounded by TTL — there is no connection tracking here.
 *
 * Security notes (CLAUDE.md): never trust a caller-supplied `publisherPeerId`
 * — this hub *sets* it from the configured `selfPeerId`; the `:*` wildcard is
 * the only wildcard and matching is delimiter-anchored (principle #2); a deny
 * reason never leaks topic existence beyond what is intended (peer gate runs
 * before the exposure check so an unauthorized peer cannot probe).
 */

/** Hard cap on subscriptions a single peer may hold against us. */
export const MAX_SUBSCRIPTIONS_PER_PEER = 64;
/** Hard cap on subscriptions against a single topic (exact or wildcard). */
export const MAX_SUBSCRIPTIONS_PER_TOPIC = 128;
/** Upper bound on any granted subscription lifetime (5 minutes). */
export const MAX_SUBSCRIPTION_TTL_MS = 5 * 60_000;
/** Lifetime granted when the client sends no `ttlMs` (1 minute). */
export const DEFAULT_SUBSCRIPTION_TTL_MS = 60_000;

export type SubAckReason =
  | "topic-not-exposed"
  | "not-authorized"
  | "subscription-cap"
  | "subscription-not-found"
  | "peer-not-resolvable";

/**
 * Per-peer authorization hook for a topic namespace, registered by a plugin
 * (via `ctx.events.registerSubscriptionGuard`) and consulted IN ADDITION to the
 * static `exposedEvents` gate — never instead of. Runs at two moments:
 *
 *   1. on an inbound `sub_req` (a denial answers with `"not-authorized"`), and
 *   2. right before every `event_emit` dispatch to a specific, already
 *      subscribed peer (a denial silently skips that one recipient — a member
 *      removed *after* subscribing stops receiving immediately, no resubscribe
 *      needed).
 *
 * A guard is namespace-anchored: the registered namespace must end with `:`
 * (delimiter-anchored, CLAUDE.md principle #2) and applies to every topic that
 * starts with it. Multiple guards for one topic all must pass (AND). A throwing
 * or absent guard is a denial, never an open door.
 */
export type SubscriptionGuard = (
  peerId: string,
  topic: string,
) => boolean | Promise<boolean>;

export interface PeerSubscription {
  peerId: string;
  /** Resolved discovered peer used to fan events out. */
  peer: NetworkPeer;
  subscriptionId: string;
  /** Exact or `:ns:*` wildcard topic as subscribed. */
  topic: string;
  /** Granted lifetime in ms (bounded by {@link MAX_SUBSCRIPTION_TTL_MS}). */
  ttlMs: number;
  expiresAt: number;
}

export interface SubscriptionHubOptions {
  /** Topics this node exposes for remote subscription (exact-match gate). */
  exposedEvents: Iterable<string>;
  /**
   * Our own transport-verified peerId, stamped as `publisherPeerId` on every
   * emitted event. Never derived from a caller-supplied value.
   */
  selfPeerId: string;
  /**
   * Peer-level gate under the topic-exposure gate. Default `["open-lan"]`:
   * any transport-verified, non-blocked peer — the topic exposure itself is
   * the capability gate.
   */
  peerAccess?: PeerAccessOptions & { context?: PeerAccessContext };
  now?: () => number;
  /** How often expired subscriptions are swept (default 15s). */
  sweepIntervalMs?: number;
  /**
   * Telemetry budget for the OUTBOUND fan-out, keyed per
   * (subscriber, topic)-channel (default {@link DEFAULT_STREAM_RATE_CONFIG}).
   * A publisher that emits faster than a subscriber's channel budget is
   * pinched exactly like the receiver-side dispatch gate would — overflow
   * drops that subscriber's frame (never queued), so a hot topic cannot flood
   * a peer on the wire either.
   */
  emitTelemetry?: Partial<StreamRateConfig>;
  /**
   * Stap 6 — optional per-peer override of the outbound channel's
   * `maxMessagesPerSecond`, resolved lazily at emit time (so governance can
   * change a peer's matrix entry live). Resolved to `undefined` → the default
   * (`emitTelemetry`/`DEFAULT_STREAM_RATE_CONFIG`) applies. A non-positive
   * integer is *ignored* (the default applies) — a malformed override can
   * never disable or exceed the gate, it only ever narrows it.
   */
  peerRateLimit?: (peerId: string) => number | undefined;
}

/** Raised by `emitLocal` when the exact topic is not exposed — fail loudly. */
export class TopicNotExposedError extends Error {
  readonly topic: string;
  constructor(topic: string) {
    super(`topic "${topic}" is not exposed for remote events`);
    this.name = "TopicNotExposedError";
    this.topic = topic;
  }
}

export class SubscriptionHub {
  private readonly selfPeerId: string;
  private readonly now: () => number;
  private readonly peerAccess: PeerAccessOptions;
  private readonly peerAccessContext: PeerAccessContext | undefined;
  private readonly sweeper: NodeJS.Timeout | null;
  private exposed = new Set<string>();
  private subscriptions = new Map<string, PeerSubscription>();
  private sequences = new Map<string, number>();
  private readonly guards = new Map<string, SubscriptionGuard>();
  private readonly network: EventNetwork;
  private readonly emitGate: TelemetryGate;
  private readonly peerRateLimit: ((peerId: string) => number | undefined) | undefined;
  /** Last per-peer override applied to the emit gate (channel budgets reset on change). */
  private readonly appliedCustomRate = new Map<string, number>();

  constructor(network: EventNetwork, options: SubscriptionHubOptions) {
    this.network = network;
    this.selfPeerId = options.selfPeerId;
    this.emitGate = new TelemetryGate(options.emitTelemetry ?? {});
    this.peerRateLimit = options.peerRateLimit;
    this.now = options.now ?? Date.now;
    // Default peer-level gate: `["open-lan"]` — any transport-verified,
    // non-blocked peer; the topic exposure itself is the capability gate.
    this.peerAccess = options.peerAccess ?? { modes: ["open-lan"] };
    this.peerAccessContext = options.peerAccess?.context;
    this.setExposedEvents(options.exposedEvents);
    const sweepMs = options.sweepIntervalMs ?? 15_000;
    if (sweepMs > 0) {
      this.sweeper = setInterval(() => this.sweep(), sweepMs);
      this.sweeper.unref();
    } else {
      this.sweeper = null;
    }
  }

  /** Replace the exposed-event set (called on plugin load changes). */
  setExposedEvents(events: Iterable<string>): void {
    const next = new Set<string>();
    for (const event of events) {
      if (typeof event === "string" && EVENT_TOPIC_RE.test(event)) {
        next.add(event);
      }
    }
    this.exposed = next;
  }

  /** The current exposed-event set (exact topics only). */
  exposedEvents(): string[] {
    return [...this.exposed];
  }

  /**
   * Register (or replace) the per-peer guard for a topic namespace. The
   * namespace must be non-empty and end with `:` so the match is
   * delimiter-anchored (CLAUDE.md principle #2) — a `tasks:project:` guard
   * covers `tasks:project:<id>:updated` but never `tasks:projectEvil:x`.
   * Re-registering the same namespace replaces its guard. Guards are never
   * auto-removed on plugin deactivation (a stale guard fails closed, never
   * opens).
   */
  registerSubscriptionGuard(namespace: string, guard: SubscriptionGuard): void {
    if (
      typeof namespace !== "string" ||
      namespace.length === 0 ||
      !namespace.endsWith(":")
    ) {
      throw new Error(
        'subscription guard namespace must be non-empty and end with ":"',
      );
    }
    if (typeof guard !== "function") {
      throw new Error("subscription guard must be a function");
    }
    this.guards.set(namespace, guard);
  }

  /**
   * Evaluate every guard whose namespace anchors the topic. AND semantics: all
   * matching guards must grant. A topic that matches no guard is allowed
   * through (the peer/exposure gates still apply). A throwing guard is a
   * denial, never an open door.
   */
  private async guardsAllow(peerId: string, topic: string): Promise<boolean> {
    for (const [namespace, guard] of this.guards) {
      if (!topic.startsWith(namespace)) {
        continue;
      }
      let granted = false;
      try {
        granted = await guard(peerId, topic);
      } catch {
        granted = false;
      }
      if (!granted) {
        return false;
      }
    }
    return true;
  }

  /**
   * Authorize + register an inbound subscription request and answer with the
   * `sub_ack`. Fail-closed: every reject is an explicit reason, never a throw
   * across the connection.
   */
  async handleSubReq(msg: InboundEventMessage): Promise<SubAckBody> {
    const { peerId } = msg;
    const body = msg.body as SubReqBody;
    this.sweep();

    if (body.action === "unsubscribe") {
      return this.handleUnsubscribe(peerId, body);
    }
    return this.handleSubscribe(peerId, body);
  }

  /**
   * Fan an event out to every matching subscriber. The exact topic must be in
   * `exposedEvents` — otherwise {@link TopicNotExposedError} and no subscriber
   * (exact or wildcard) ever receives it. Each subscriber is individually
   * throttled by the outbound telemetry gate (per (subscriber, topic)-channel):
   * an over-budget frame is dropped for that subscriber only, so one hot topic
   * cannot flood a peer on the wire and a slow subscriber cannot starve the
   * others. Returns the number of subscribers the frame was successfully
   * flushed to (a transport failure or a gate drop on one subscriber does not
   * fail the rest).
   */
  async emitLocal(topic: string, payload: unknown): Promise<number> {
    if (!this.isExposed(topic)) {
      throw new TopicNotExposedError(topic);
    }
    this.sweep();
    const byteSize = safeByteSize(payload);
    if (byteSize === null) {
      // Fail-closed: a payload we cannot size cannot be accounted by the gate,
      // and (the providers are JSON transports) cannot be serialized either.
      return 0;
    }
    const now = this.now();
    const emitted: EventEmitBody = {
      subscriptionId: "",
      topic,
      publisherPeerId: this.selfPeerId,
      timestamp: now,
      sequenceNumber: 0,
      payload,
    };
    let delivered = 0;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.expiresAt <= now) {
        continue;
      }
      if (!topicMatches(subscription.topic, topic)) {
        continue;
      }
      // Re-authorize this specific recipient right before dispatch: a member
      // that was removed after subscribing stops receiving immediately. A
      // denial silently skips that one subscriber — never fails the whole emit.
      if (!(await this.guardsAllow(subscription.peerId, topic))) {
        continue;
      }
      let allowed = true;
      try {
        this.applyPeerRateLimit(subscription.peerId, topic);
        allowed = this.emitGate.checkAndConsume(
          subscription.peerId,
          topic,
          byteSize,
        ).allowed;
      } catch {
        // Sustained >2x cap escalates by throwing (stream violation): drop.
        allowed = false;
      }
      if (!allowed) {
        // Over-budget for this subscriber's channel — drop the frame without
        // advancing the per-subscription sequence (the receiver never sees a
        // gap it did not actually miss).
        continue;
      }
      const key = `${subscription.peerId}\u0000${subscription.subscriptionId}`;
      emitted.subscriptionId = subscription.subscriptionId;
      emitted.sequenceNumber = (this.sequences.get(key) ?? 0) + 1;
      this.sequences.set(key, emitted.sequenceNumber);
      if (await this.network.sendEvent(subscription.peer, { ...emitted })) {
        delivered += 1;
      }
    }
    return delivered;
  }

  /** All currently registered (non-expired) subscriptions. */
  listSubscriptions(): PeerSubscription[] {
    this.sweep();
    return [...this.subscriptions.values()];
  }

  /** Stop the sweeper and drop all state. */
  close(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
    }
    this.subscriptions.clear();
    this.sequences.clear();
  }

  /**
   * Whether `topic` may leave the process. `exposedEvents` stays the static,
   * manifest-level gate — "may this topic *pattern* ever leave the process" —
   * so a topic passes when it is listed exactly OR when it matches an exposed
   * wildcard pattern (e.g. the manifest exposing `tasks:project:*` exposes every
   * `tasks:project:<id>:updated`). Matching is delimiter-anchored
   * (`topicMatches`, CLAUDE.md principle #2). The per-namespace subscription
   * guard is a separate, per-peer gate on top of this one — never a replacement.
   */
  private isExposed(topic: string): boolean {
    if (this.exposed.has(topic)) {
      return true;
    }
    for (const entry of this.exposed) {
      if (isWildcardTopic(entry) && topicMatches(entry, topic)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Apply the peer's current per-peer rate override to the emit-gate channel
   * for `(peerId, topic)`, but only when it changed since the last application
   * (re-registering resets the channel window, which we must not do per emit).
   * A resolver that is absent, throws, or yields a non-positive integer is
   * ignored — the default budget applies, never a disabled gate.
   */
  private applyPeerRateLimit(peerId: string, topic: string): void {
    if (!this.peerRateLimit) {
      return;
    }
    let custom: number | undefined;
    try {
      custom = this.peerRateLimit(peerId);
    } catch {
      return;
    }
    if (
      custom === undefined ||
      !Number.isInteger(custom) ||
      custom <= 0 ||
      custom === this.appliedCustomRate.get(peerId)
    ) {
      return;
    }
    this.appliedCustomRate.set(peerId, custom);
    this.emitGate.registerStream(peerId, topic, {
      maxMessagesPerSecond: custom,
    });
  }

  private async handleSubscribe(
    peerId: string,
    body: SubReqBody,
  ): Promise<SubAckBody> {
    const topic = body.topic;
    if (!EVENT_TOPIC_RE.test(topic)) {
      return this.reject(body, "topic-not-exposed");
    }
    if (this.selfPeerId === peerId) {
      return this.reject(body, "not-authorized");
    }

    // Peer-level gate first: an unauthorized peer must not be able to probe
    // which topics are exposed (a denied peer always gets "not-authorized").
    const peerDecision = await checkPeerAccess(
      peerId,
      this.peerAccess,
      this.peerAccessContext,
    );
    if (!peerDecision.granted) {
      return this.reject(body, "not-authorized");
    }

    // Exact topics must be exposed; wildcards are registered (emit re-auth).
    if (!isWildcardTopic(topic) && !this.isExposed(topic)) {
      return this.reject(body, "topic-not-exposed");
    }

    // The per-namespace subscription guard (if one is registered for this
    // topic) is a second, independent gate on top of exposure: project
    // membership, for example. Denied peers get the same opaque reason as the
    // peer gate so a non-member cannot probe topic existence.
    if (!(await this.guardsAllow(peerId, topic))) {
      return this.reject(body, "not-authorized");
    }

    if (this.countForPeer(peerId) >= MAX_SUBSCRIPTIONS_PER_PEER) {
      return this.reject(body, "subscription-cap");
    }
    if (this.countForTopic(topic) >= MAX_SUBSCRIPTIONS_PER_TOPIC) {
      return this.reject(body, "subscription-cap");
    }

    const peer = this.network.getPeer(peerId);
    if (!peer) {
      // We cannot address the subscriber for fan-out — fail closed.
      return this.reject(body, "peer-not-resolvable");
    }

    const ttlMs = Math.min(
      Math.max(body.ttlMs ?? DEFAULT_SUBSCRIPTION_TTL_MS, 1),
      MAX_SUBSCRIPTION_TTL_MS,
    );
    this.subscriptions.set(keyFor(peerId, body.subscriptionId), {
      peerId,
      peer,
      subscriptionId: body.subscriptionId,
      topic,
      ttlMs,
      expiresAt: this.now() + ttlMs,
    });
    return {
      subscriptionId: body.subscriptionId,
      topic,
      accepted: true,
      ttlMs,
    };
  }

  private handleUnsubscribe(
    peerId: string,
    body: SubReqBody,
  ): SubAckBody {
    const key = keyFor(peerId, body.subscriptionId);
    if (this.subscriptions.delete(key)) {
      this.sequences.delete(key);
      return {
        subscriptionId: body.subscriptionId,
        topic: body.topic,
        accepted: true,
      };
    }
    return this.reject(body, "subscription-not-found");
  }

  private reject(body: SubReqBody, reason: SubAckReason): SubAckBody {
    return {
      subscriptionId: body.subscriptionId,
      topic: body.topic,
      accepted: false,
      reason,
    };
  }

  private countForPeer(peerId: string): number {
    let count = 0;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.peerId === peerId) {
        count += 1;
      }
    }
    return count;
  }

  private countForTopic(topic: string): number {
    let count = 0;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.topic === topic) {
        count += 1;
      }
    }
    return count;
  }

  /** Prune expired subscriptions (lazy access + interval sweep). */
  private sweep(): void {
    const now = this.now();
    for (const [key, subscription] of this.subscriptions) {
      if (subscription.expiresAt <= now) {
        this.subscriptions.delete(key);
        this.sequences.delete(key);
      }
    }
  }
}

function keyFor(peerId: string, subscriptionId: string): string {
  return `${peerId}\u0000${subscriptionId}`;
}
