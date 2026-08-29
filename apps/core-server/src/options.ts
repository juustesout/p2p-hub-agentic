import type { TaskApprovalGate, TrustConfirmation } from "@p2p-hub/core";

export interface CoreServerOptions {
  pluginsDir: string;
  dataDir: string;
  host?: string;
  /**
   * True when the HTTP/WS bridge is bound beyond loopback (`P2P_HUB_EXPOSE=1`).
   * Widens the Host-header allowlist to the machine's own addresses so LAN
   * clients can legitimately reach the tokenless surfaces; it never widens to
   * arbitrary Host values (DNS-rebinding protection stays on).
   */
  exposed?: boolean;
  /**
   * Extra hostnames to accept in the Host-header allowlist on top of the
   * loopback set and (when exposed) the machine's addresses. Operator/test
   * override for reaching the bridge via a hostname (e.g. behind a reverse
   * proxy) that interface enumeration cannot discover.
   */
  allowedHosts?: string[];
  port?: number;
  /**
   * Port for the network-light P2P transport (mDNS advertisement + TLS).
   * Defaults to 0 (ephemeral). The config loader feeds `P2P_HUB_P2P_PORT` →
   * `P2P_PORT` → `32837` here.
   */
  p2pPort?: number;
  /**
   * Bind host for the network-light P2P transport. Defaults to `0.0.0.0`
   * (the transport authenticates every peer on the wire and never holds the
   * boot token, so a wildcard bind is safe). The config loader feeds
   * `P2P_BIND_HOST` here.
   */
  p2pBindHost?: string;
  /** Vault master passphrase (falls back to env / dev key). */
  masterKey?: string;
  /** Explicit boot token; overrides env and auto-generation. */
  bootToken?: string;
  /**
   * Hook events to bridge to the WebSocket activity bus.
   */
  bridgedEvents?: string[];
  /**
   * Gate for `/remote-site/*` cache-miss outbound fetches. Defaults to a
   * `FixedWindowLimiter` (30/min); injectable so tests can observe the gate
   * without triggering real peer fetches.
   */
  remoteFetchLimiter?: { allow(): boolean };
  /**
   * Native tier-2 confirmation capability injected by the host. Absent by
   * default, which makes every tier-2 settings change fail closed (denied).
   */
  trustConfirmation?: TrustConfirmation;
  /**
   * A1/Slice 2: per-invocation human approval for agent-initiated remote
   * skills that need Tier-2 step-up. Delegated to the same native confirmation
   * channel as `trustConfirmation` (an `agent-task-approval` prompt). Absent by
   * default, which makes every agent task that needs approval fail closed.
   */
  taskApprovalGate?: TaskApprovalGate;
  /**
   * Start the P2P network transport (LAN discovery + inbound capability calls).
   * Default `true` — the core-server is by definition the P2P-capable backend.
   * Set to `false` for a fully local-only server: no identity is created, no
   * provider is started, nothing is advertised on the LAN. This mirrors the
   * `PluginHost`'s lazy identity/networking gate — a local-only server must not
   * fail hard on a corrupt vault.
   */
  networking?: boolean;
  /**
   * WAN transport (network-libp2p) toggle. Default `false` — the libp2p
   * transport is strictly opt-in: it opens outbound TCP connections to an
   * operator-configured relay and listens on WAN-reachable addresses, so it
   * must never come up implicitly. Implies `networking !== false`: the WAN
   * node is wired alongside the LAN transport, sharing one p2p-hub identity.
   */
  wanEnabled?: boolean;
  /**
   * Operator-supplied circuit-relay v2 relay multiaddr (e.g.
   * `/ip4/1.2.3.4/tcp/4001/p2p/12D3KooW...`). When set, the WAN transport
   * opens a relayed reservation and advertises a `/p2p-circuit` address, which
   * makes the node reachable behind NAT/CGNAT. The relay is derived from
   * operator config, never discovered (libp2p is a pure bytepipe, no WAN
   * discovery surface).
   */
  wanRelayAddr?: string;
  /**
   * Optional explicit listen multiaddrs for the WAN transport (TCP only).
   * Defaults to loopback ephemeral (`/ip4/127.0.0.1/tcp/0`) plus the relayed
   * circuit address. Use to bind a specific WAN-facing interface/port, e.g.
   * `["/ip4/0.0.0.0/tcp/4277"]`.
   */
  wanListenAddrs?: string[];
}
