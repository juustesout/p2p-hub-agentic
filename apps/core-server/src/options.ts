import type { TaskApprovalGate, TrustConfirmation } from "@p2p-hub/core";

export interface CoreServerOptions {
  pluginsDir: string;
  dataDir: string;
  host?: string;
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
  /** Hook events to bridge to the WebSocket activity bus. */
  bridgedEvents?: string[];
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
}
