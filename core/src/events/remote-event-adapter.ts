import type { NetworkPeer } from "@p2p-hub/sdk";
import { TelemetryGate, type StreamRateConfig } from "../security/telemetry-gate";
import type { EventNetwork } from "./event-network";
import {
  EVENT_TOPIC_RE,
  safeByteSize,
  topicMatches,
  type EventEmitBody,
  type InboundEventMessage,
} from "./types";
import {
  DEFAULT_SUBSCRIPTION_TTL_MS,
  MAX_SUBSCRIPTION_TTL_MS,
} from "./subscription-hub";

/**
 * Stap 5 — RemoteEventAdapter: local subscriptions *towards remote peers*.
 *
 * `subscribeRemote`/`unsubscribeRemote` talk to a remote peer's SubscriptionHub
 * over `EventNetwork.sendSubReq`, and a periodic re-subscribe heartbeat
 * refreshes the granted TTL (refinement #4b) before it lapses. Inbound
 * `event_emit` frames (from a peer whose hub we subscribed to) pass through
 * three independent filters before a handler ever runs:
 *
 *   1. **publisher identity (defense-in-depth)** — the wire `publisherPeerId`
 *      must equal the transport-verified connection peerId (the provider
 *      already closes the connection on mismatch; this is the second check),
 *   2. **subscription binding** — the frame's `subscriptionId`/`topic` must
 *      match a subscription we actually made with that peer (never dispatch
 *      events we never asked for), including a monotonic `sequenceNumber`
 *      check (stale/out-of-order frames drop), and
 *   3. **TelemetryGate per (peer, topic)-channel** (refinement #2) — overflow
 *      *drops*, never queues/spams/closes; a sustained >2x abuse raises
 *      `PeerStreamViolationError` once and pinches that channel.
 *
 * Every filter is fail-closed: a mismatch of any kind drops the frame silently.
 */

export interface RemoteEvent {
  peerId: string;
  subscriptionId: string;
  topic: string;
  timestamp: number;
  sequenceNumber: number;
  payload: unknown;
}

export type RemoteEventHandler = (event: RemoteEvent) => void;

export interface RemoteSubscription {
  subscriptionId: string;
  peerId: string;
  peer: NetworkPeer;
  topic: string;
  handler: RemoteEventHandler;
  expiresAt: number;
  lastSequenceNumber: number;
}

export interface RemoteEventAdapterOptions {
  /** Telemetry budget for inbound events per (peer, topic)-channel. */
  telemetry?: Partial<StreamRateConfig>;
  /** Default granted ttl to request; clamped to `MAX_SUBSCRIPTION_TTL_MS`. */
  subscriptionTtlMs?: number;
  /** Fraction of the granted ttl at which to re-subscribe (default 2/3). */
  refreshFraction?: number;
  /** Invoked when a subscription lapses or is rejected on refresh. */
  onSubscriptionLost?: (subscriptionId: string, reason: string) => void;
  now?: () => number;
}

/** Thrown by `subscribeRemote` when the remote peer rejects (or never acks). */
export class SubscriptionRejectedError extends Error {
  readonly subscriptionId: string;
  readonly topic: string;
  readonly reason: string;
  constructor(subscriptionId: string, topic: string, reason: string) {
    super(
      `remote subscription to "${topic}" rejected: ${reason || "no ack (peer unreachable or refused)"}`,
    );
    this.name = "SubscriptionRejectedError";
    this.subscriptionId = subscriptionId;
    this.topic = topic;
    this.reason = reason;
  }
}

export class RemoteEventAdapter {
  private readonly network: EventNetwork;
  private readonly gate: TelemetryGate;
  private readonly requestedTtlMs: number;
  private readonly refreshFraction: number;
  private readonly onSubscriptionLost: ((id: string, reason: string) => void) | undefined;
  private readonly now: () => number;
  private readonly subscriptions = new Map<string, RemoteSubscription>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(network: EventNetwork, options: RemoteEventAdapterOptions = {}) {
    this.network = network;
    this.gate = new TelemetryGate(options.telemetry ?? {});
    this.requestedTtlMs = Math.min(
      Math.max(options.subscriptionTtlMs ?? DEFAULT_SUBSCRIPTION_TTL_MS, 1),
      MAX_SUBSCRIPTION_TTL_MS,
    );
    const fraction = options.refreshFraction ?? 2 / 3;
    this.refreshFraction =
      Number.isFinite(fraction) && fraction > 0 && fraction < 1 ? fraction : 2 / 3;
    this.onSubscriptionLost = options.onSubscriptionLost;
    this.now = options.now ?? Date.now;
  }

  /**
   * Subscribe to `topic` on `peer`. Resolves with the subscriptionId once the
   * remote hub acks; rejects with {@link SubscriptionRejectedError} on a
   * fail-closed ack or on transport failure (never throws for a denial — the
   * ack reason is surfaced).
   */
  async subscribeRemote(
    peer: NetworkPeer,
    topic: string,
    handler: RemoteEventHandler,
  ): Promise<string> {
    if (!EVENT_TOPIC_RE.test(topic)) {
      throw new SubscriptionRejectedError("", topic, "malformed-topic");
    }
    const peerId = peer.peerId ?? "";
    if (peerId.length === 0) {
      throw new SubscriptionRejectedError("", topic, "peer-without-verified-identity");
    }
    const subscriptionId = randomSubscriptionId();
    const ack = await this.network.sendSubReq(peer, {
      subscriptionId,
      topic,
      action: "subscribe",
      ttlMs: this.requestedTtlMs,
    });
    if (!ack || !ack.accepted) {
      throw new SubscriptionRejectedError(
        subscriptionId,
        topic,
        ack?.reason ?? "",
      );
    }
    const grantedTtlMs =
      typeof ack.ttlMs === "number" && ack.ttlMs > 0
        ? ack.ttlMs
        : this.requestedTtlMs;
    this.subscriptions.set(subscriptionId, {
      subscriptionId,
      peerId,
      peer,
      topic,
      handler,
      expiresAt: this.now() + grantedTtlMs,
      lastSequenceNumber: 0,
    });
    this.scheduleRefresh(subscriptionId, grantedTtlMs);
    return subscriptionId;
  }

  /** Tear down a local subscription (best-effort unsubscribe over the wire). */
  async unsubscribeRemote(subscriptionId: string): Promise<boolean> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return false;
    }
    this.teardown(subscriptionId);
    await this.network.sendSubReq(subscription.peer, {
      subscriptionId,
      topic: subscription.topic,
      action: "unsubscribe",
    });
    return true;
  }

  /**
   * Route an inbound `event_emit` (from the attached provider's handler).
   * Drops silently on any filter mismatch — never throws to the transport.
   */
  handleInboundEvent(msg: InboundEventMessage): void {
    if (msg.type !== "event_emit") {
      return;
    }
    const body = msg.body as EventEmitBody;

    // 1. publisher identity, defense-in-depth (provider already enforces this).
    if (body.publisherPeerId !== msg.peerId) {
      return;
    }

    // 2. must be one of our subscriptions with that peer.
    const subscription = this.subscriptions.get(body.subscriptionId);
    if (!subscription || subscription.peerId !== msg.peerId) {
      return;
    }
    if (!topicMatches(subscription.topic, body.topic)) {
      return;
    }
    if (body.sequenceNumber <= subscription.lastSequenceNumber) {
      return;
    }

    // 3. per-(peer, topic) telemetry gate; overflow drops.
    const byteSize = safeByteSize(body.payload);
    if (byteSize === null) {
      return;
    }
    let allowed = true;
    try {
      allowed = this.gate.checkAndConsume(msg.peerId, body.topic, byteSize).allowed;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return;
    }

    subscription.lastSequenceNumber = body.sequenceNumber;
    subscription.handler({
      peerId: msg.peerId,
      subscriptionId: body.subscriptionId,
      topic: body.topic,
      timestamp: body.timestamp,
      sequenceNumber: body.sequenceNumber,
      payload: body.payload,
    });
  }

  /** All live local subscriptions. */
  listSubscriptions(): RemoteSubscription[] {
    return [...this.subscriptions.values()];
  }

  /** Stop all refresh timers and drop state. */
  close(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.subscriptions.clear();
    this.gate.reset();
  }

  private teardown(subscriptionId: string): void {
    const timer = this.timers.get(subscriptionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(subscriptionId);
    }
    this.subscriptions.delete(subscriptionId);
  }

  private scheduleRefresh(subscriptionId: string, grantedTtlMs: number): void {
    const delayMs = Math.max(
      Math.floor(grantedTtlMs * this.refreshFraction),
      1,
    );
    const timer = setTimeout(() => {
      this.timers.delete(subscriptionId);
      void this.refresh(subscriptionId);
    }, delayMs);
    timer.unref();
    this.timers.set(subscriptionId, timer);
  }

  private async refresh(subscriptionId: string): Promise<void> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return;
    }
    const ack = await this.network.sendSubReq(subscription.peer, {
      subscriptionId,
      topic: subscription.topic,
      action: "subscribe",
      ttlMs: this.requestedTtlMs,
    });
    if (!ack || !ack.accepted) {
      const reason = ack?.reason ?? "refresh-rejected";
      this.teardown(subscriptionId);
      this.onSubscriptionLost?.(subscriptionId, reason);
      return;
    }
    const grantedTtlMs =
      typeof ack.ttlMs === "number" && ack.ttlMs > 0
        ? ack.ttlMs
        : this.requestedTtlMs;
    subscription.expiresAt = this.now() + grantedTtlMs;
    this.scheduleRefresh(subscriptionId, grantedTtlMs);
  }
}

function randomSubscriptionId(): string {
  // A subscription id must satisfy the wire contract's SUBSCRIPTION_ID_RE
  // (`[A-Za-z0-9][A-Za-z0-9._-]*`), so use a hex suffix with a letter prefix.
  return `sub-${randomHex(12)}`;
}

function randomHex(bytes: number): string {
  return require("node:crypto").randomBytes(bytes).toString("hex");
}
