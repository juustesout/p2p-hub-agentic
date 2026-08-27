import { NetworkRegistry, wireNetworkToBroker } from "@p2p-hub/core";
import type { PluginHost, TaskBroker } from "@p2p-hub/core";
import { NetworkLightProvider } from "@p2p-hub/network-light";

/** Dependencies for starting the core-server's own P2P transport. */
export interface StartNetworkingDeps {
  broker: TaskBroker;
  host: PluginHost;
  registry: NetworkRegistry;
  p2pPort?: number;
  p2pBindHost?: string;
}

/**
 * Start the P2P transport behind the same identity/vault gate as
 * `PluginHost.startNetworking`. The core-server is *by definition* where
 * network functionality is expected, so a corrupt vault fails loudly here
 * (deliberate — see CLAUDE.md "Core-server identity/vault dependency").
 */
export async function startNetworking(
  deps: StartNetworkingDeps,
): Promise<NetworkLightProvider> {
  const remoteSkills = deps.broker
    .listSkills()
    .filter((s) => !s.localOnly)
    .map((s) => s.skill);

  const identity = await deps.host.identityManager().getOrCreateIdentity();
  const provider = new NetworkLightProvider({
    port: deps.p2pPort ?? 0,
    host: deps.p2pBindHost ?? "0.0.0.0",
    skills: remoteSkills,
    identity,
    // Fase 1B: prove this identity on the wire. The private key stays in
    // IdentityManager; the provider only receives signed bytes.
    identitySigner: (data) => deps.host.identityManager().sign(data),
  });
  deps.registry.register(provider);
  // Plugin code reads `ctx.network`, which is a LIVE reference to the
  // PluginHost's own network registry (the capability resolves
  // `host.networkRegistry().selectActive()` on every call — see
  // buildNetworkCapability). This CoreServer boots its host without
  // `enableNetworking`, so the host never starts its own transport and its
  // registry would stay empty — every plugin would see "no active network
  // provider" no matter how healthy THIS provider is. Register the same
  // provider into the host's registry so `contacts.verifyPeer` →
  // `ctx.network.sendTask` routes over the real transport. There is exactly
  // one provider in the process: the host starts none of its own.
  deps.host.networkRegistry().register(provider);
  wireNetworkToBroker(provider, deps.broker);
  // Stap 5: route inbound event-transport frames (sub_req → hub,
  // event_emit → adapter) for this provider through the host's event layer.
  deps.host.wireEventsToProvider(provider);
  await provider.start();
  return provider;
}

/** Dependencies for the periodic peer-discovery poller. */
export interface PeerPollerDeps {
  provider(): NetworkLightProvider | null;
  probeSkill(): string | undefined;
  broadcast(event: string, payload: unknown): void;
}

/**
 * A per-server peer poller that broadcasts `peer:connected` /
 * `peer:disconnected` as discovery changes. Owns the known-peer set.
 */
export function createPeerPoller(deps: PeerPollerDeps): {
  poll(): Promise<void>;
} {
  const knownPeers = new Set<string>();
  return {
    async poll(): Promise<void> {
      const provider = deps.provider();
      if (!provider) {
        return;
      }
      // Warm the provider's capability cache for every discovered peer. Without
      // this, `listPeers()` returns peers with an empty `skills` set until some
      // other component happens to run a capability probe. `discover(skill)`
      // probes every peer regardless of the requested skill, so a single call
      // with any network-exposed skill name warms the whole cache; probing is
      // cached per peer after the first successful handshake, so this is cheap
      // once warm.
      const probeSkill = deps.probeSkill();
      if (probeSkill !== undefined) {
        provider.discover(probeSkill).catch(() => {
          // Probe failures are retried internally (PROBE_RETRY_MS); never let a
          // peer that is momentarily unreachable take down the poll loop.
        });
      }
      const peers = provider.listPeers();
      const current = new Set(peers.map((p) => p.id));
      for (const peer of peers) {
        if (!knownPeers.has(peer.id)) {
          knownPeers.add(peer.id);
          deps.broadcast("peer:connected", {
            peerId: peer.id,
            name: peer.name ?? peer.id,
          });
        }
      }
      for (const id of [...knownPeers]) {
        if (!current.has(id)) {
          knownPeers.delete(id);
          deps.broadcast("peer:disconnected", { peerId: id });
        }
      }
    },
  };
}
