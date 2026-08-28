import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { trayEventAction } from "../src/services/tray";

describe("tray event mapping", () => {
  it("maps the lock-vault event to its action", () => {
    assert.equal(trayEventAction("p2p:lock-vault"), "lock-vault");
  });

  it("maps the toggle-network event to its action", () => {
    assert.equal(trayEventAction("p2p:toggle-network"), "toggle-network");
  });

  it("maps unknown events to null, never to an action", () => {
    assert.equal(trayEventAction("p2p:something-else"), null);
    assert.equal(trayEventAction(""), null);
    assert.equal(trayEventAction("tray-status"), null);
  });
});
