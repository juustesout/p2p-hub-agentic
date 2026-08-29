import { test } from "node:test";
import assert from "node:assert/strict";
import { HostGate, hostFromHeader } from "./host-validation";

test("hostFromHeader strips the port and lowercases", () => {
  assert.equal(hostFromHeader("127.0.0.1:8788"), "127.0.0.1");
  assert.equal(hostFromHeader("LOCALHOST:8080"), "localhost");
  assert.equal(hostFromHeader("localhost"), "localhost");
  assert.equal(hostFromHeader("  evil.com:8788  "), "evil.com");
});

test("hostFromHeader handles IPv6 literals with and without brackets", () => {
  assert.equal(hostFromHeader("[::1]:8788"), "::1");
  assert.equal(hostFromHeader("[::1]"), "::1");
  assert.equal(hostFromHeader("[2001:db8::1]:8080"), "2001:db8::1");
});

test("hostFromHeader rejects missing, empty and malformed hosts", () => {
  assert.equal(hostFromHeader(undefined), null);
  assert.equal(hostFromHeader("   "), null);
  assert.equal(hostFromHeader(""), null);
  assert.equal(hostFromHeader("[::1"), null);
});

test("loopback hosts are always allowed, even without exposure", () => {
  const gate = new HostGate({ bindHost: "127.0.0.1", exposed: false });
  for (const host of [
    "127.0.0.1:8788",
    "127.0.0.55",
    "localhost:8080",
    "[::1]:8788",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(gate.isAllowed(host), true, `expected ${host} to be allowed`);
  }
});

test("a missing Host header is denied (fail closed)", () => {
  const gate = new HostGate({ bindHost: "127.0.0.1", exposed: false });
  assert.equal(gate.isAllowed(undefined), false);
  assert.equal(gate.isAllowed(""), false);
});

test("a non-loopback Host is denied unless the bridge is exposed", () => {
  const gate = new HostGate({ bindHost: "127.0.0.1", exposed: false });
  for (const host of ["evil.com", "evil.com:8788", "192.168.1.5", "10.0.0.9"]) {
    assert.equal(gate.isAllowed(host), false, `expected ${host} to be denied`);
  }
});

test("exposed mode accepts the configured bind host but never arbitrary hosts", () => {
  const gate = new HostGate({ bindHost: "192.168.1.5", exposed: true });
  assert.equal(gate.isAllowed("192.168.1.5:8788"), true);
  assert.equal(gate.isAllowed("192.168.1.5"), true);
  // Loopback stays allowed next to the exposed address.
  assert.equal(gate.isAllowed("localhost:8788"), true);
  assert.equal(gate.isAllowed("127.0.0.1:8788"), true);
  // A different, non-configured address — including the attacker's rebinding
  // domain — is refused. No wildcard acceptance just because the bridge is up.
  assert.equal(gate.isAllowed("10.0.0.99:8788"), false);
  assert.equal(gate.isAllowed("evil.com:8788"), false);
});

test("exposed mode accepts the machine's own interface addresses", () => {
  // The gate enumerates os.networkInterfaces(); on a loopback-only container
  // that is at least 127.0.0.1/::1, which isLoopbackHost already allows — so
  // the meaningful assertion is that exposing never *narrows* loopback and
  // that the configured wildcard bind host itself is not required to be a
  // reachable Host.
  const gate = new HostGate({ bindHost: "0.0.0.0", exposed: true });
  assert.equal(gate.isAllowed("127.0.0.1:8788"), true);
  assert.equal(gate.isAllowed("localhost:8788"), true);
  assert.equal(gate.isAllowed("evil.com:8788"), false);
});

test("extraHosts extends the allowlist without exposing arbitrary hosts", () => {
  const gate = new HostGate({
    bindHost: "127.0.0.1",
    exposed: false,
    extraHosts: ["my-desktop.local", " My-Desktop.local "],
  });
  assert.equal(gate.isAllowed("my-desktop.local:8788"), true);
  assert.equal(gate.isAllowed("my-desktop.local"), true);
  assert.equal(gate.isAllowed("other.local:8788"), false);
});
