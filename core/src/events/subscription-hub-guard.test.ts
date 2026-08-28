import { test } from "node:test";
import assert from "node:assert/strict";
import { SubscriptionHub, TopicNotExposedError } from "./subscription-hub";
import { FakeEventNetwork, fakePeer } from "./test-fakes";
import type { InboundEventMessage, SubReqBody } from "./types";

const SELF_PEER_ID = "0".repeat(64);
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

const PROJECT_A_UPDATED = "tasks:project:aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000:updated";
const PROJECT_A = "tasks:project:aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000";
const PROJECT_B_UPDATED = "tasks:project:11111111-2222-3333-4444-555566667777:updated";

function makeHub(exposed: string[]): {
  hub: SubscriptionHub;
  network: FakeEventNetwork;
} {
  const network = new FakeEventNetwork();
  network.peers.set(ALICE, fakePeer(ALICE));
  network.peers.set(BOB, fakePeer(BOB));
  const hub = new SubscriptionHub(network, {
    exposedEvents: exposed,
    selfPeerId: SELF_PEER_ID,
    now: () => 1_000_000,
    sweepIntervalMs: 0,
  });
  return { hub, network };
}

function subReq(topic: string, id = "sub-1"): SubReqBody {
  return { subscriptionId: id, topic, action: "subscribe", ttlMs: 60_000 };
}

function inbound(peerId: string, body: SubReqBody): InboundEventMessage {
  return { peerId, type: "sub_req", body };
}

test("a subscription guard namespace must end with the ':' delimiter", () => {
  const { hub } = makeHub([]);
  assert.throws(
    () => hub.registerSubscriptionGuard("tasks:project", () => true),
    /end with ":"/,
  );
  assert.throws(
    () => hub.registerSubscriptionGuard("", () => true),
    /end with ":"/,
  );
  assert.throws(
    () => hub.registerSubscriptionGuard("tasks:project:", "not-a-function" as never),
    /must be a function/,
  );
  // A valid namespace registers without throwing.
  hub.registerSubscriptionGuard("tasks:project:", () => true);
});

test("a matching guard denies a non-member at subscribe time with not-authorized", async () => {
  const { hub } = makeHub([PROJECT_A_UPDATED]);
  hub.registerSubscriptionGuard("tasks:project:", (peerId, topic) => {
    return topic === PROJECT_A_UPDATED && peerId === ALICE;
  });

  const memberAck = await hub.handleSubReq(inbound(ALICE, subReq(PROJECT_A_UPDATED)));
  assert.equal(memberAck.accepted, true);

  const nonMemberAck = await hub.handleSubReq(inbound(BOB, subReq(PROJECT_A_UPDATED)));
  assert.equal(nonMemberAck.accepted, false);
  assert.equal(nonMemberAck.reason, "not-authorized");
});

test("the guard namespace is delimiter-anchored (no prefix-leak)", async () => {
  const { hub } = makeHub([PROJECT_A_UPDATED]);
  // The guard covers `tasks:project:` only — `tasks:projectEvil:x` must not be
  // gated by it (CLAUDE.md principle #2), and must be denied by exposure.
  hub.registerSubscriptionGuard("tasks:project:", (peerId, topic) => {
    return topic.startsWith("tasks:project:") && peerId === ALICE;
  });
  const evilAck = await hub.handleSubReq(
    inbound(BOB, subReq("tasks:projectEvil:updated")),
  );
  assert.equal(evilAck.accepted, false);
  assert.equal(evilAck.reason, "topic-not-exposed");
});

test("a manifest-exposed wildcard pattern exposes every matching exact topic", async () => {
  const { hub } = makeHub(["tasks:project:*"]);
  hub.registerSubscriptionGuard("tasks:project:", (peerId) => peerId === ALICE);

  // The exact topic is not listed, but the pattern `tasks:project:*` gates it.
  const ack = await hub.handleSubReq(inbound(ALICE, subReq(PROJECT_A_UPDATED)));
  assert.equal(ack.accepted, true);
  assert.equal(ack.reason, undefined);

  // A non-matching topic still fails closed.
  const otherAck = await hub.handleSubReq(
    inbound(ALICE, subReq("tasks:projectEvil:updated")),
  );
  assert.equal(otherAck.accepted, false);
  assert.equal(otherAck.reason, "topic-not-exposed");
});

test("a topic that matches no exposed pattern cannot be emitted", async () => {
  const { hub } = makeHub(["tasks:project:*"]);
  hub.registerSubscriptionGuard("tasks:project:", () => true);
  await assert.rejects(
    hub.emitLocal("tasks:other:updated", { n: 1 }),
    TopicNotExposedError,
  );
});

test("emit-time re-authorization skips a recipient removed from the guard", async () => {
  const { hub, network } = makeHub([PROJECT_A_UPDATED]);
  let aliceIsMember = true;
  hub.registerSubscriptionGuard("tasks:project:", (peerId, topic) => {
    return topic === PROJECT_A_UPDATED && (peerId === ALICE ? aliceIsMember : peerId === BOB);
  });

  await hub.handleSubReq(inbound(ALICE, subReq(PROJECT_A_UPDATED, "sub-alice")));
  await hub.handleSubReq(inbound(BOB, subReq(PROJECT_A_UPDATED, "sub-bob")));

  const first = await hub.emitLocal(PROJECT_A_UPDATED, { n: 1 });
  assert.equal(first, 2);

  // ALICE is removed from the project after subscribing; the next emit still
  // delivers to BOB but silently skips ALICE — no failed emit, no resubscribe.
  aliceIsMember = false;
  const second = await hub.emitLocal(PROJECT_A_UPDATED, { n: 2 });
  assert.equal(second, 1);
  const recipients = network.sentEvents.map((e) => e.peer.peerId);
  // 2 from the first emit (ALICE, BOB) + 1 from the second (BOB only).
  assert.deepEqual(recipients, [ALICE, BOB, BOB]);
});

test("a throwing guard is a denial, never an open door", async () => {
  const { hub } = makeHub([PROJECT_A_UPDATED]);
  hub.registerSubscriptionGuard("tasks:project:", () => {
    throw new Error("boom");
  });
  const ack = await hub.handleSubReq(inbound(ALICE, subReq(PROJECT_A_UPDATED)));
  assert.equal(ack.accepted, false);
  assert.equal(ack.reason, "not-authorized");
});

test("multiple matching guards must all pass (AND semantics)", async () => {
  const { hub } = makeHub([PROJECT_A_UPDATED]);
  hub.registerSubscriptionGuard("tasks:", () => true);
  hub.registerSubscriptionGuard("tasks:project:", (peerId) => peerId === ALICE);

  const memberAck = await hub.handleSubReq(inbound(ALICE, subReq(PROJECT_A_UPDATED)));
  assert.equal(memberAck.accepted, true);

  const nonMemberAck = await hub.handleSubReq(inbound(BOB, subReq(PROJECT_A_UPDATED)));
  assert.equal(nonMemberAck.accepted, false);
  assert.equal(nonMemberAck.reason, "not-authorized");
});

test("the guard runs on wildcard subscriptions too", async () => {
  const { hub } = makeHub(["tasks:project:*"]);
  hub.registerSubscriptionGuard("tasks:project:", (peerId) => peerId === ALICE);

  const memberAck = await hub.handleSubReq(inbound(ALICE, subReq("tasks:project:*", "wild")));
  assert.equal(memberAck.accepted, true);

  const nonMemberAck = await hub.handleSubReq(inbound(BOB, subReq("tasks:project:*", "wild-2")));
  assert.equal(nonMemberAck.accepted, false);
  assert.equal(nonMemberAck.reason, "not-authorized");

  // A wildcard covering multiple projects still works for the member.
  await hub.handleSubReq(inbound(ALICE, subReq("tasks:project:*", "wild-3")));
  assert.equal(hub.listSubscriptions().length, 2);
});

test("deeper per-project topics are grammar-valid and isolated by id", async () => {
  const { hub } = makeHub(["tasks:project:*"]);
  hub.registerSubscriptionGuard("tasks:project:", (peerId, topic) => {
    return topic === PROJECT_A_UPDATED && peerId === ALICE;
  });

  // PROJECT_A_UPDATED (4 colon-parts) is now a valid topic.
  const ack = await hub.handleSubReq(inbound(ALICE, subReq(PROJECT_A_UPDATED)));
  assert.equal(ack.accepted, true);

  // A different project's topic is a different topic entirely (no bleed).
  const bAck = await hub.handleSubReq(inbound(ALICE, subReq(PROJECT_B_UPDATED, "sub-b")));
  assert.equal(bAck.accepted, false);
  assert.equal(bAck.reason, "not-authorized");
});

test("the bare 2-segment project topic is also guarded", async () => {
  const { hub } = makeHub(["tasks:project:*"]);
  hub.registerSubscriptionGuard("tasks:project:", (peerId, topic) => {
    return topic === PROJECT_A && peerId === ALICE;
  });
  const ack = await hub.handleSubReq(inbound(ALICE, subReq(PROJECT_A)));
  assert.equal(ack.accepted, true);
  const bobAck = await hub.handleSubReq(inbound(BOB, subReq(PROJECT_A, "bob")));
  assert.equal(bobAck.accepted, false);
  assert.equal(bobAck.reason, "not-authorized");
});
