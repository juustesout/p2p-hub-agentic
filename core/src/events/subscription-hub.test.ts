import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SUBSCRIPTION_TTL_MS,
  MAX_SUBSCRIPTIONS_PER_PEER,
  MAX_SUBSCRIPTIONS_PER_TOPIC,
  MAX_SUBSCRIPTION_TTL_MS,
  SubscriptionHub,
  TopicNotExposedError,
} from "./subscription-hub";
import { FakeEventNetwork, fakePeer } from "./test-fakes";
import type { InboundEventMessage, SubReqBody } from "./types";

const SELF_PEER_ID = "0".repeat(64);
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

function makeHub(options: {
  exposed?: string[];
  peerAccessDeny?: (peerId: string) => boolean;
  now?: () => number;
} = {}): {
  hub: SubscriptionHub;
  network: FakeEventNetwork;
  now: () => number;
} {
  const network = new FakeEventNetwork();
  network.peers.set(ALICE, fakePeer(ALICE));
  network.peers.set(BOB, fakePeer(BOB));
  network.peers.set(CAROL, fakePeer(CAROL));
  let fakeNow = 1_000_000;
  const now = options.now ?? (() => fakeNow);
  const hubInstance = new SubscriptionHub(network, {
    exposedEvents: options.exposed ?? ["calendar:eventAdded", "sensor:update"],
    selfPeerId: SELF_PEER_ID,
    now,
    sweepIntervalMs: 0,
    ...(options.peerAccessDeny
      ? {
          peerAccess: {
            modes: ["open-lan"],
            context: {
              contacts: {
                isVerifiedContact: () => true,
                isBlockedContact: (peerId: string) => options.peerAccessDeny!(peerId),
              },
            },
          },
        }
      : {}),
  });
  return { hub: hubInstance, network, now };
}

function subReq(overrides: Partial<SubReqBody> = {}): SubReqBody {
  return {
    subscriptionId: "sub-1",
    topic: "calendar:eventAdded",
    action: "subscribe",
    ttlMs: 60_000,
    ...overrides,
  };
}

function inbound(
  peerId: string,
  body: SubReqBody,
): InboundEventMessage {
  return { peerId, type: "sub_req", body };
}

test("subscribe to an exact exposed topic is accepted with a bounded granted ttl", async () => {
  const { hub, network } = makeHub();
  const ack = await hub.handleSubReq(inbound(ALICE, subReq({ ttlMs: 10_000_000 })));
  assert.equal(ack.accepted, true);
  assert.equal(ack.subscriptionId, "sub-1");
  assert.equal(ack.topic, "calendar:eventAdded");
  assert.equal(ack.ttlMs, MAX_SUBSCRIPTION_TTL_MS, "ttl is clamped to the hard cap");
  assert.equal(hub.listSubscriptions().length, 1);
  assert.equal(network.getPeer(ALICE)?.peerId, ALICE);
});

test("a missing ttlMs grants the default", async () => {
  const { hub } = makeHub();
  const ack = await hub.handleSubReq(inbound(ALICE, subReq({ ttlMs: undefined })));
  assert.equal(ack.accepted, true);
  assert.equal(ack.ttlMs, DEFAULT_SUBSCRIPTION_TTL_MS);
});

test("exact topic not in exposedEvents is rejected with topic-not-exposed", async () => {
  const { hub } = makeHub({ exposed: ["calendar:eventAdded"] });
  const ack = await hub.handleSubReq(
    inbound(ALICE, subReq({ topic: "calendar:secret" })),
  );
  assert.equal(ack.accepted, false);
  assert.equal(ack.reason, "topic-not-exposed");
});

test("peer-level gate denial is reported as not-authorized, before exposure", async () => {
  const blocked = (peerId: string) => peerId === BOB;
  const { hub } = makeHub({ peerAccessDeny: blocked });
  // BOB is blocked: probing an exposed topic must NOT reveal it — not-authorized.
  const exposedAck = await hub.handleSubReq(inbound(BOB, subReq()));
  assert.equal(exposedAck.accepted, false);
  assert.equal(exposedAck.reason, "not-authorized");
  // The same blocked peer probing a non-exposed topic gets the same reason.
  const hiddenAck = await hub.handleSubReq(
    inbound(BOB, subReq({ topic: "calendar:secret" })),
  );
  assert.equal(hiddenAck.reason, "not-authorized");
});

test("a peer cannot subscribe to itself", async () => {
  const { hub } = makeHub();
  const ack = await hub.handleSubReq(inbound(SELF_PEER_ID, subReq()));
  assert.equal(ack.accepted, false);
  assert.equal(ack.reason, "not-authorized");
});

test("a malformed topic is denied before any gate", async () => {
  const { hub } = makeHub();
  for (const topic of ["calendar", "bad topic", "calendar:*x", "calendar/event", "x".repeat(600)]) {
    const ack = await hub.handleSubReq(inbound(ALICE, subReq({ topic })));
    assert.equal(ack.accepted, false, `topic ${JSON.stringify(topic)} must be denied`);
    assert.equal(ack.reason, "topic-not-exposed");
  }
});

test("per-topic and per-peer caps reject with subscription-cap", async () => {
  const { hub } = makeHub({ exposed: ["sensor:update", "sensor:alert", "sensor:data"] });
  // Fill the topic cap (128) across 3 peers (each stays under the 64 per-peer
  // cap) — the 129th subscription to the topic rejects on the TOPIC cap.
  const peers = [ALICE, BOB, CAROL];
  for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_TOPIC; i += 1) {
    const ack = await hub.handleSubReq(
      inbound(peers[i % peers.length], subReq({ subscriptionId: `t-${i}`, topic: "sensor:update" })),
    );
    assert.equal(ack.accepted, true, `subscription t-${i} must fill the topic cap`);
  }
  const overflow = await hub.handleSubReq(
    inbound(ALICE, subReq({ subscriptionId: "t-over", topic: "sensor:update" })),
  );
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.reason, "subscription-cap");

  // Fresh hub: fill the per-peer cap (64) from one peer — the 65th rejects.
  const { hub: hub2 } = makeHub({ exposed: ["sensor:update"] });
  for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_PEER; i += 1) {
    await hub2.handleSubReq(inbound(BOB, subReq({ subscriptionId: `p-${i}`, topic: "sensor:update" })));
  }
  const peerOverflow = await hub2.handleSubReq(inbound(BOB, subReq({ subscriptionId: "p-over", topic: "sensor:update" })));
  assert.equal(peerOverflow.accepted, false);
  assert.equal(peerOverflow.reason, "subscription-cap");
});

test("unsubscribe removes the subscription; unknown id is subscription-not-found", async () => {
  const { hub } = makeHub();
  await hub.handleSubReq(inbound(ALICE, subReq()));
  const removed = await hub.handleSubReq(
    inbound(ALICE, subReq({ action: "unsubscribe" })),
  );
  assert.equal(removed.accepted, true);
  assert.equal(hub.listSubscriptions().length, 0);

  const missing = await hub.handleSubReq(
    inbound(ALICE, subReq({ action: "unsubscribe" })),
  );
  assert.equal(missing.accepted, false);
  assert.equal(missing.reason, "subscription-not-found");
});

test("subscriptions expire after their granted ttl (lazy sweep)", async () => {
  const clock = { at: 1_000_000 };
  const { hub } = makeHub({ now: () => clock.at });
  await hub.handleSubReq(inbound(ALICE, subReq({ ttlMs: 60_000 })));
  assert.equal(hub.listSubscriptions().length, 1);

  clock.at += 60_000;
  assert.equal(hub.listSubscriptions().length, 0, "expired subscription is swept");
});

test("emitLocal throws for a topic that is not exposed (no fan-out)", async () => {
  const { hub, network } = makeHub();
  await hub.handleSubReq(inbound(ALICE, subReq({ topic: "sensor:update" })));
  await assert.rejects(hub.emitLocal("sensor:secret", { n: 1 }), TopicNotExposedError);
  assert.equal(network.sentEvents.length, 0);
});

test("emitLocal fans out to exact subscribers with verified publisherPeerId and monotonic sequence", async () => {
  const { hub, network } = makeHub();
  await hub.handleSubReq(inbound(ALICE, subReq()));
  await hub.handleSubReq(inbound(BOB, subReq({ subscriptionId: "sub-2" })));
  await hub.handleSubReq(inbound(BOB, subReq({ subscriptionId: "sub-3" })));

  const delivered = await hub.emitLocal("calendar:eventAdded", { title: "x" });
  assert.equal(delivered, 3);
  assert.equal(network.sentEvents.length, 3);

  const first = network.sentEvents[0];
  assert.equal(first.body.topic, "calendar:eventAdded");
  assert.equal(first.body.publisherPeerId, SELF_PEER_ID, "publisher identity is OURS");
  assert.deepEqual(first.body.payload, { title: "x" });
  // The counter is per-SUBSCRIPTION: on the first emit every subscription gets
  // sequence 1, regardless of how many subscriptions the peer holds.
  assert.deepEqual(
    network.sentEvents.map((e) => e.body.sequenceNumber),
    [1, 1, 1],
    "first emit assigns sequence 1 to every subscription",
  );

  const delivered2 = await hub.emitLocal("calendar:eventAdded", { title: "y" });
  assert.equal(delivered2, 3);
  assert.deepEqual(
    network.sentEvents.map((e) => e.body.sequenceNumber),
    [1, 1, 1, 2, 2, 2],
    "the second emit increments every subscription's counter to 2",
  );
});

test("wildcard subscriber receives matching topics; non-exposed exact topics never leak", async () => {
  const { hub, network } = makeHub();
  const ack = await hub.handleSubReq(
    inbound(ALICE, subReq({ subscriptionId: "wild", topic: "calendar:*" })),
  );
  assert.equal(ack.accepted, true, "wildcard subscription is registered without a topic leak");

  // Emitting an exposed exact topic reaches the wildcard subscriber.
  await hub.emitLocal("calendar:eventAdded", { day: 1 });
  assert.equal(network.sentEvents.length, 1);
  assert.equal(network.sentEvents[0].body.topic, "calendar:eventAdded");

  // A wildcard-boundary leak must not match: "calendarevil:x" is not "calendar:*".
  await assert.rejects(hub.emitLocal("calendarevil:x", {}), TopicNotExposedError);
  assert.equal(network.sentEvents.length, 1, "boundary-leak topic never reached the subscriber");
});

test("emitLocal skips expired subscriptions", async () => {
  const clock = { at: 1_000_000 };
  const { hub, network } = makeHub({ now: () => clock.at });
  await hub.handleSubReq(inbound(ALICE, subReq({ ttlMs: 60_000 })));
  clock.at += 120_000;
  const delivered = await hub.emitLocal("calendar:eventAdded", {});
  assert.equal(delivered, 0);
  assert.equal(network.sentEvents.length, 0);
});

test("a subscriber that cannot be resolved fails closed with peer-not-resolvable", async () => {
  const { hub, network } = makeHub();
  network.peers.delete(ALICE);
  const ack = await hub.handleSubReq(inbound(ALICE, subReq()));
  assert.equal(ack.accepted, false);
  assert.equal(ack.reason, "peer-not-resolvable");
});

test("setExposedEvents replaces the exposure set", async () => {
  const { hub } = makeHub();
  hub.setExposedEvents(["chat:messageReceived"]);
  assert.deepEqual(hub.exposedEvents(), ["chat:messageReceived"]);
  const ack = await hub.handleSubReq(inbound(ALICE, subReq({ topic: "calendar:eventAdded" })));
  assert.equal(ack.accepted, false);
  assert.equal(ack.reason, "topic-not-exposed");
});
