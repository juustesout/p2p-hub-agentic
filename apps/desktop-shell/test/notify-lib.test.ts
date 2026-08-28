import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "./test-globals";
import { sanitizeNotification, sanitizeLabel } from "../src/services/notify-lib";

describe("notify-lib sanitizer", () => {
  it("never leaks chat message text into a notification", () => {
    const spec = sanitizeNotification({
      event: "chat:messageReceived",
      payload: {
        fromPeerId: "abc123",
        text: "bankrekening: NL91ABNA0417164300, wachtwoord: geheim",
        sentAt: 1700000000000,
        verified: true,
      },
      ts: 1700000000000,
    });
    assert.ok(spec);
    assert.equal(spec?.title, "Nieuw chatbericht");
    assert.equal(spec?.body, "Nieuw bericht van abc123");
    assert.ok(!spec?.body.includes("bankrekening"));
    assert.ok(!spec?.body.includes("geheim"));
    assert.ok(!spec?.body.includes("wachtwoord"));
  });

  it("uses a peer label when one is supplied", () => {
    const spec = sanitizeNotification({
      event: "chat:messageReceived",
      payload: { fromPeerId: "abc123", peerLabel: "Anna", text: "private" },
      ts: 1700000000000,
    });
    assert.equal(spec?.body, "Nieuw bericht van Anna");
  });

  it("maps task accept/decline/completion actions to notifications", () => {
    const accept = sanitizeNotification({
      event: "tasks:taskUpdated",
      payload: {
        projectId: "proj-1",
        taskId: "task-1",
        taskName: "Rapport schrijven",
        action: "acceptDelegation",
      },
      ts: 1700000000000,
    });
    assert.equal(accept?.title, "Taak geaccepteerd");
    assert.equal(accept?.body, "Rapport schrijven (project proj-1)");

    const decline = sanitizeNotification({
      event: "tasks:taskUpdated",
      payload: {
        projectId: "proj-1",
        taskId: "task-1",
        taskName: "Rapport schrijven",
        action: "declineDelegation",
      },
      ts: 1700000000000,
    });
    assert.equal(decline?.title, "Taak geweigerd");

    const proof = sanitizeNotification({
      event: "tasks:taskUpdated",
      payload: {
        projectId: "proj-1",
        taskId: "task-1",
        taskName: "Rapport schrijven",
        action: "submitCompletionProof",
      },
      ts: 1700000000000,
    });
    assert.equal(proof?.title, "Taak ter controle ingeleverd");
  });

  it("returns null for events that must not notify", () => {
    for (const event of [
      "peer:connected",
      "vault:updated",
      "task:completed",
      "core:ready",
    ]) {
      assert.equal(
        sanitizeNotification({ event, payload: {}, ts: 1700000000000 }),
        null,
        `expected no notification for ${event}`,
      );
    }
  });

  it("returns null for unknown task actions", () => {
    assert.equal(
      sanitizeNotification({
        event: "tasks:taskUpdated",
        payload: { taskId: "t", action: "archiveProject" },
        ts: 1700000000000,
      }),
      null,
    );
  });

  it("strips control characters and caps label length", () => {
    assert.equal(sanitizeLabel("a\u0000b\u001fc"), "a b c");
    assert.equal(sanitizeLabel("  \tspaced  out  "), "spaced out");
    assert.equal(sanitizeLabel("x".repeat(100)).length, 25);
  });
});
