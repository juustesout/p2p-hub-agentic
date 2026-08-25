import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RemoteEventAdapter,
  SubscriptionRejectedError,
  type RemoteEvent,
} from "./remote-event-adapter";
import { FakeEventNetwork, fakePeer } from "./test-fakes";
import type { EventEmitBody, InboundEventMessage } from "./types";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function setup(options: {
  telemetry?: { maxMessagesPerSecond?: number };
  subscriptionTtlMs?: number;
} = {}): {
  adapter: RemoteEventAdapter;
  network: FakeEventNetwork;
  received: RemoteEvent[];
} {
  const network = new FakeEventNetwork();
  const received: RemoteEvent[] = [];
  const adapter = new RemoteEventAdapter(network, {
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    subscriptionTtlMs: options.subscriptionTtlMs ?? 60_000,
  });
  return { adapter, network, received };
}

function ackBody(overrides: { accepted?: boolean; reason?: string; ttlMs?: number } = {}) {
  return {
    subscriptionId: "sub-1",
    topic: "sensor:update",
    accepted: overrides.accepted ?? true,
    reason: overrides.reason,
    ttlMs: overrides.ttlMs ?? 60_000,
  };
}

function event(
  overrides: Partial<EventEmitBody> = {},
): InboundEventMessage {
  return {
    peerId: ALICE,
    type: "event_emit",
    body: {
      subscriptionId: "sub-1",
      topic: "sensor:update",
      publisherPeerId: ALICE,
      timestamp: 1_700_000_000_000,
      sequenceNumber: 1,
      payload: { value: 1 },
      ...overrides,
    },
  };
}

async function subscribe(
  adapter: RemoteEventAdapter,
  network: FakeEventNetwork,
  received: RemoteEvent[],
  topic = "sensor:update",
): Promise<string> {
  network.subAcks.set("default", ackBody() as never);
  network.peers.set(ALICE, fakePeer(ALICE));
  const id = await adapter.subscribeRemote(fakePeer(ALICE), topic, (e) => received.push(e));
  network.subAcks.clear();
  return id;
}

test("subscribeRemote sends a sub_req and resolves with the subscriptionId on an accepted ack", async () => {
  const { adapter, network, received } = setup();
  const id = await subscribe(adapter, network, received);
  assert.ok(id.startsWith("sub-"), "generated subscription id is wire-safe");
  assert.equal(network.sentSubReqs.length, 1);
  assert.equal(network.sentSubReqs[0].body.action, "subscribe");
  assert.equal(network.sentSubReqs[0].body.topic, "sensor:update");
  assert.equal(network.sentSubReqs[0].body.subscriptionId, id);
  assert.equal(adapter.listSubscriptions().length, 1);
});

test("subscribeRemote surfaces a fail-closed ack as SubscriptionRejectedError with its reason", async () => {
  const { adapter, network } = setup();
  network.peers.set(ALICE, fakePeer(ALICE));
  network.subAcks.set("default", ackBody({ accepted: false, reason: "topic-not-exposed" }) as never);
  await assert.rejects(
    adapter.subscribeRemote(fakePeer(ALICE), "sensor:update", () => {}),
    (err: unknown) =>
      err instanceof SubscriptionRejectedError && err.reason === "topic-not-exposed",
  );
});

test("subscribeRemote rejects when the transport never acks (null)", async () => {
  const { adapter, network } = setup();
  network.peers.set(ALICE, fakePeer(ALICE));
  await assert.rejects(
    adapter.subscribeRemote(fakePeer(ALICE), "sensor:update", () => {}),
    SubscriptionRejectedError,
  );
});

test("subscribeRemote rejects a malformed topic or a peer without a verified identity", async () => {
  const { adapter, network } = setup();
  network.peers.set(ALICE, fakePeer(ALICE));
  await assert.rejects(
    adapter.subscribeRemote(fakePeer(ALICE), "not a topic", () => {}),
    SubscriptionRejectedError,
  );
  const anonymousPeer = { ...fakePeer(ALICE), peerId: undefined };
  await assert.rejects(
    adapter.subscribeRemote(anonymousPeer, "sensor:update", () => {}),
    SubscriptionRejectedError,
  );
});

test("unsubscribeRemote removes the local subscription and sends an unsubscribe frame", async () => {
  const { adapter, network, received } = setup();
  const id = await subscribe(adapter, network, received);
  const ok = await adapter.unsubscribeRemote(id);
  assert.equal(ok, true);
  assert.equal(adapter.listSubscriptions().length, 0);
  const last = network.sentSubReqs[network.sentSubReqs.length - 1];
  assert.equal(last.body.action, "unsubscribe");
  assert.equal(last.body.subscriptionId, id);

  assert.equal(await adapter.unsubscribeRemote("nope"), false);
});

test("inbound event_emit matching a live subscription dispatches to the handler", async () => {
  const { adapter, network, received } = setup();
  const id = await subscribe(adapter, network, received);
  await adapter.handleInboundEvent(event({ subscriptionId: id }));
  assert.equal(received.length, 1);
  assert.equal(received[0].peerId, ALICE);
  assert.equal(received[0].topic, "sensor:update");
  assert.equal(received[0].sequenceNumber, 1);
  assert.deepEqual(received[0].payload, { value: 1 });
});

test("inbound event_emit with a spoofed publisherPeerId is dropped (defense-in-depth)", async () => {
  const { adapter, network, received } = setup();
  const id = await subscribe(adapter, network, received);
  await adapter.handleInboundEvent(event({ subscriptionId: id, publisherPeerId: BOB }));
  assert.equal(received.length, 0, "a spoofed publisher identity must never dispatch");
});

test("inbound event_emit not matching any of our subscriptions is dropped", async () => {
  const { adapter, network, received } = setup();
  const id = await subscribe(adapter, network, received);
  await adapter.handleInboundEvent(event({ subscriptionId: "stranger-sub" }));
  await adapter.handleInboundEvent(event({ subscriptionId: id, topic: "sensor:other" }));
  assert.equal(received.length, 0);
});

test("stale or out-of-order sequence numbers are dropped", async () => {
  const { adapter, network, received } = setup();
  const id = await subscribe(adapter, network, received);
  await adapter.handleInboundEvent(event({ subscriptionId: id, sequenceNumber: 5 }));
  await adapter.handleInboundEvent(event({ subscriptionId: id, sequenceNumber: 4 }));
  await adapter.handleInboundEvent(event({ subscriptionId: id, sequenceNumber: 5 }));
  assert.equal(received.length, 1, "only the strictly-increasing frame dispatches");
});

test("a wildcard subscription receives matching inbound events", async () => {
  const { adapter, network, received } = setup();
  const id = await subscribe(adapter, network, received, "sensor:*");
  await adapter.handleInboundEvent(event({ subscriptionId: id, topic: "sensor:humidity" }));
  assert.equal(received.length, 1);
  assert.equal(received[0].topic, "sensor:humidity");
});

test("the per-(peer, topic) telemetry gate drops an overflowing publisher, never closing", async () => {
  const { adapter, network, received } = setup({ telemetry: { maxMessagesPerSecond: 2 } });
  const id = await subscribe(adapter, network, received);
  await adapter.handleInboundEvent(event({ subscriptionId: id, sequenceNumber: 1 }));
  await adapter.handleInboundEvent(event({ subscriptionId: id, sequenceNumber: 2 }));
  assert.equal(received.length, 2, "within budget both frames dispatch");
  await adapter.handleInboundEvent(event({ subscriptionId: id, sequenceNumber: 3 }));
  await adapter.handleInboundEvent(event({ subscriptionId: id, sequenceNumber: 4 }));
  assert.equal(received.length, 2, "overflow frames drop, the connection stays up");
  assert.equal(adapter.listSubscriptions().length, 1);
});

test("a rejected refresh tears the subscription down and reports the loss", async () => {
  const network = new FakeEventNetwork();
  const received: RemoteEvent[] = [];
  const lost: { id: string; reason: string } = { id: "", reason: "" };
  let lostFired = false;
  const adapter = new RemoteEventAdapter(network, {
    subscriptionTtlMs: 5,
    onSubscriptionLost: (id, reason) => {
      lostFired = true;
      lost.id = id;
      lost.reason = reason;
    },
  });
  network.peers.set(ALICE, fakePeer(ALICE));
  network.subAcks.set("default", ackBody({ ttlMs: 5 }) as never);
  const id = await adapter.subscribeRemote(fakePeer(ALICE), "sensor:update", (e) => received.push(e));
  network.subAcks.clear();
  network.subAcks.set("default", ackBody({ ttlMs: 5, accepted: false, reason: "expired" }) as never);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(lostFired, true, "the lost subscription must be reported");
  assert.equal(lost.id, id);
  assert.equal(adapter.listSubscriptions().length, 0);
});

test("a successful refresh keeps the subscription alive", async () => {
  const network = new FakeEventNetwork();
  const received: RemoteEvent[] = [];
  const adapter = new RemoteEventAdapter(network, { subscriptionTtlMs: 5 });
  network.peers.set(ALICE, fakePeer(ALICE));
  network.subAcks.set("default", ackBody({ ttlMs: 5 }) as never);
  await adapter.subscribeRemote(fakePeer(ALICE), "sensor:update", (e) => received.push(e));

  await new Promise((resolve) => setTimeout(resolve, 50));
  // Refresh succeeded (and keeps succeeding for a short ttl): the subscription
  // stays alive and every refresh is a `subscribe` re-request, never a teardown.
  assert.equal(adapter.listSubscriptions().length, 1);
  assert.ok(network.sentSubReqs.length >= 2, "one initial + at least one refresh sub_req");
  assert.ok(
    network.sentSubReqs.every((r) => r.body.action === "subscribe"),
    "every frame is a (re-)subscribe, never an unsubscribe",
  );
});
