import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBindHost, isLoopbackHost } from "./host";

test("loopback hosts are recognised", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", " 127.0.0.1 "]) {
    assert.equal(isLoopbackHost(host), true, `expected ${host} to be loopback`);
  }
});

test("non-loopback hosts are rejected without an explicit opt-in", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5"]) {
    const decision = decideBindHost(host, undefined);
    assert.ok("error" in decision, `expected ${host} to require opt-in`);
  }
});

test("non-loopback hosts are allowed only with P2P_HUB_EXPOSE=1", () => {
  assert.deepEqual(decideBindHost("0.0.0.0", "1"), { host: "0.0.0.0", exposed: true });

  const notOptedIn = decideBindHost("0.0.0.0", "true");
  assert.ok("error" in notOptedIn, "expose must be exactly \"1\"");
});

test("the default host is loopback and never needs an opt-in", () => {
  assert.deepEqual(decideBindHost(undefined, undefined), {
    host: "127.0.0.1",
    exposed: false,
  });
});
