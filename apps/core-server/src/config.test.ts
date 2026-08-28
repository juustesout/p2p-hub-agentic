import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_P2P_BIND_HOST,
  DEFAULT_P2P_PORT,
  loadConfig,
  parseBoolEnv,
} from "./config";
import type { ServerConfig } from "./config";

/** Assert a successful load and return the config, failing loudly otherwise. */
function cfg(env: NodeJS.ProcessEnv): ServerConfig {
  const result = loadConfig(env);
  if ("config" in result) {
    return result.config;
  }
  throw new Error(`expected config, got: ${result.error}`);
}

test("loadConfig applies the default fallback chain on an empty environment", () => {
  const config = cfg({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.exposed, false);
  assert.equal(config.port, DEFAULT_HTTP_PORT);
  assert.equal(config.p2pPort, DEFAULT_P2P_PORT);
  assert.equal(config.p2pBindHost, DEFAULT_P2P_BIND_HOST);
  assert.equal(config.networking, true);
  assert.equal(config.wanEnabled, false);
  assert.equal(config.wanRelayAddr, "");
  assert.deepEqual(config.wanListenAddrs, []);
});

test("HTTP port: P2P_HUB_PORT wins, then PORT, then the default", () => {
  assert.equal(cfg({ P2P_HUB_PORT: "9000" }).port, 9000);
  assert.equal(
    cfg({ P2P_HUB_PORT: "9000", PORT: "9001" }).port,
    9000,
    "P2P_HUB_PORT must take precedence over PORT",
  );
  assert.equal(cfg({ PORT: "9001" }).port, 9001);
  assert.equal(cfg({}).port, DEFAULT_HTTP_PORT);
  // An invalid value falls through to the next in the chain.
  assert.equal(cfg({ P2P_HUB_PORT: "abc", PORT: "9001" }).port, 9001);
  assert.equal(cfg({ P2P_HUB_PORT: "0", PORT: "9001" }).port, 9001);
});

test("P2P port: P2P_HUB_P2P_PORT wins, then P2P_PORT, then the default", () => {
  assert.equal(cfg({ P2P_HUB_P2P_PORT: "5555" }).p2pPort, 5555);
  assert.equal(
    cfg({ P2P_HUB_P2P_PORT: "5555", P2P_PORT: "5556" }).p2pPort,
    5555,
  );
  assert.equal(cfg({ P2P_PORT: "5556" }).p2pPort, 5556);
  assert.equal(cfg({}).p2pPort, DEFAULT_P2P_PORT);
  assert.equal(
    cfg({ P2P_HUB_P2P_PORT: "nope", P2P_PORT: "5556" }).p2pPort,
    5556,
  );
});

test("P2P_BIND_HOST defaults to 0.0.0.0 and is overridable", () => {
  assert.equal(cfg({}).p2pBindHost, DEFAULT_P2P_BIND_HOST);
  assert.equal(cfg({ P2P_BIND_HOST: "192.168.1.50" }).p2pBindHost, "192.168.1.50");
  assert.equal(cfg({ P2P_BIND_HOST: "  " }).p2pBindHost, DEFAULT_P2P_BIND_HOST);
});

test("P2P_ENABLE_NETWORKING is parsed as a boolean and P2P_HUB_NETWORKING is the legacy alias", () => {
  assert.equal(cfg({}).networking, true);
  for (const off of ["0", "false", "no", "off", "n", "disabled", "uit"]) {
    assert.equal(
      cfg({ P2P_ENABLE_NETWORKING: off }).networking,
      false,
      `P2P_ENABLE_NETWORKING=${off} must disable networking`,
    );
  }
  for (const on of ["1", "true", "yes", "on", "y", "enabled", "aan"]) {
    assert.equal(
      cfg({ P2P_ENABLE_NETWORKING: on }).networking,
      true,
      `P2P_ENABLE_NETWORKING=${on} must enable networking`,
    );
  }
  assert.equal(
    cfg({ P2P_ENABLE_NETWORKING: "0", P2P_HUB_NETWORKING: "1" }).networking,
    false,
    "P2P_ENABLE_NETWORKING takes precedence over the legacy alias",
  );
  assert.equal(
    cfg({ P2P_HUB_NETWORKING: "0" }).networking,
    false,
    "legacy P2P_HUB_NETWORKING=0 must still disable networking",
  );
  // Unrecognized values fall back to the default instead of flipping.
  assert.equal(cfg({ P2P_ENABLE_NETWORKING: "maybe" }).networking, true);
});

test("WAN transport config: opt-in default, relay/listen parsing, gated on networking", () => {
  // Strictly opt-in.
  assert.equal(cfg({}).wanEnabled, false);

  // Enabled on its own flag.
  const enabled = cfg({ P2P_HUB_WAN_ENABLED: "1" });
  assert.equal(enabled.wanEnabled, true);
  assert.equal(enabled.wanRelayAddr, "");
  assert.deepEqual(enabled.wanListenAddrs, []);

  // Relay + listen multiaddrs parse (comma-separated, trimmed, empties dropped).
  const wired = cfg({
    P2P_HUB_WAN_ENABLED: "1",
    P2P_HUB_WAN_RELAY: " /ip4/1.2.3.4/tcp/4001/p2p/12D3KooWxyz ",
    P2P_HUB_WAN_LISTEN: "/ip4/0.0.0.0/tcp/4277, , /ip6/::/tcp/4277",
  });
  assert.equal(wired.wanRelayAddr, "/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWxyz");
  assert.deepEqual(wired.wanListenAddrs, [
    "/ip4/0.0.0.0/tcp/4277",
    "/ip6/::/tcp/4277",
  ]);

  // A WAN flag with networking disabled must never boot a WAN-only node.
  const gated = cfg({ P2P_HUB_WAN_ENABLED: "1", P2P_HUB_NETWORKING: "0" });
  assert.equal(gated.networking, false);
  assert.equal(gated.wanEnabled, false);
});

test("the HTTP bridge bind gate is preserved: non-loopback host still requires P2P_HUB_EXPOSE=1", () => {
  assert.ok("error" in loadConfig({ P2P_HUB_HOST: "0.0.0.0" }));
  // "true" is not the gate value — only the exact "1" opts in (documented and
  // tested security invariant; a plain "true" must never silently expose the
  // token-guarded bridge).
  assert.ok("error" in loadConfig({ P2P_HUB_HOST: "0.0.0.0", P2P_HUB_EXPOSE: "true" }));
  const exposed = cfg({ P2P_HUB_HOST: "0.0.0.0", P2P_HUB_EXPOSE: "1" });
  assert.equal(exposed.host, "0.0.0.0");
  assert.equal(exposed.exposed, true);
});

test("parseBoolEnv handles the accepted spellings and falls back otherwise", () => {
  assert.equal(parseBoolEnv(undefined, true), true);
  assert.equal(parseBoolEnv("1", true), true);
  assert.equal(parseBoolEnv("FALSE", false), false);
  assert.equal(parseBoolEnv("On", false), true);
  assert.equal(parseBoolEnv("garbage", true), true);
  assert.equal(parseBoolEnv("garbage", false), false);
});
