import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fixed, pre-approved dependency surface of the network-libp2p transport.
 *
 * The transport may only ever pull in:
 * - the libp2p core and the minimal set needed to *construct a libp2p node*
 *   (connection encryption + stream muxer are unavoidable plumbing), one base
 *   transport (TCP), circuit-relay v2 (client side), and the two NAT
 *   hole-punching services (AutoNAT + dcutr);
 * - multiaddr/peer-id helpers to parse and address peers;
 * - the SDK contract types;
 * - network-light, for the *existing* wire-contract implementation that this
 *   transport reuses verbatim as a bytepipe.
 *
 * Anything else — especially gossipsub, Kad-DHT, WAN discovery, or any
 * discovery package — is a hard no: this transport discovers nothing and must
 * never acquire an implicit discovery/routing surface through a dependency
 * bump. A future dependency must be added to this list *deliberately*, which
 * is the point of the structural test.
 */
const APPROVED_DEPENDENCIES: ReadonlySet<string> = new Set([
  // libp2p core plumbing (no node is constructible without these)
  "libp2p",
  "@chainsafe/libp2p-noise",
  "@chainsafe/libp2p-yamux",
  // base transport + NAT traversal (the approved Fase 2A surface)
  "@libp2p/tcp",
  "@libp2p/circuit-relay-v2",
  "@libp2p/autonat",
  "@libp2p/dcutr",
  // key handling: reconstructing a libp2p node from the p2p-hub Ed25519 key
  // (Optie B / identity unification) needs `privateKeyFromRaw`
  "@libp2p/crypto",
  // peer-metadata exchange consumed by circuit-relay-v2 (see services block
  // in the provider); explicitly not a discovery/routing mechanism
  "@libp2p/identify",
  // addressing / peer id helpers
  "@libp2p/peer-id",
  "@multiformats/multiaddr",
  // p2p-hub packages
  "@p2p-hub/sdk",
  "@p2p-hub/network-light",
]);

/** Names that would indicate an unwanted discovery/routing/subscription surface. */
const FORBIDDEN_DEPENDENCIES: ReadonlyArray<string> = [
  "@libp2p/kad-dht",
  "@libp2p/gossipsub",
  "@libp2p/mdns",
  "@libp2p/bootstrap",
  "@libp2p/pubsub-peer-discovery",
  "@libp2p/peer-discovery",
  "@libp2p/dht",
  "@libp2p/floodsub",
];

const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);

test("the dependency surface is exactly the approved set", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(packageJsonPath, "utf8"),
  ) as { dependencies?: Record<string, string> };

  const dependencies = Object.keys(packageJson.dependencies ?? {}).sort();

  for (const dependency of dependencies) {
    assert.ok(
      APPROVED_DEPENDENCIES.has(dependency),
      `"${dependency}" is not on the approved dependency surface of network-libp2p`,
    );
  }
});

test("no gossipsub / kad-dht / discovery / routing package may ever appear", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(packageJsonPath, "utf8"),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  const all = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  for (const name of Object.keys(all)) {
    assert.ok(
      !FORBIDDEN_DEPENDENCIES.includes(name),
      `"${name}" must never appear in network-libp2p — no implicit discovery/routing surface`,
    );
  }
});

test("the transport reuses the existing network-light wire contract", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(packageJsonPath, "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(packageJson.dependencies?.["@p2p-hub/network-light"], "0.1.0");
});
