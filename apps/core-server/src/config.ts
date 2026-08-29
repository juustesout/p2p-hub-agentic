import { decideBindHost } from "./host";

/**
 * Core-server configuration resolved from environment variables, with explicit
 * fallback chains. Pure (reads only its arguments) so the fallbacks are
 * unit-testable without starting the server entrypoint.
 *
 * | Variable | Chain | Default |
 * | --- | --- | --- |
 * | HTTP/WS bridge port | `P2P_HUB_PORT` → `PORT` | `8788` |
 * | Extra Host allowlist | `P2P_HUB_ALLOWED_HOSTS` (comma-separated) | *(none)* |
 * | P2P transport port | `P2P_HUB_P2P_PORT` → `P2P_PORT` | `32837` |
 * | P2P transport bind host | `P2P_BIND_HOST` | `0.0.0.0` |
 * | Networking enabled | `P2P_ENABLE_NETWORKING` → `P2P_HUB_NETWORKING` | `true` |
 * | WAN transport enabled | `P2P_HUB_WAN_ENABLED` | `false` |
 * | WAN relay multiaddr | `P2P_HUB_WAN_RELAY` | *(none)* |
 * | WAN listen multiaddrs | `P2P_HUB_WAN_LISTEN` (comma-separated) | *(none)* |
 *
 * The HTTP/WS **bridge** bind host deliberately does NOT default to `0.0.0.0`:
 * it stays loopback-by-default behind the `P2P_HUB_EXPOSE=1` gate
 * (`decideBindHost`) — that trust boundary is non-negotiable (see CLAUDE.md
 * "Core-server boot token"). `P2P_BIND_HOST` controls only the P2P transport
 * (mDNS + TLS), which authenticates every peer over the wire and never holds
 * the boot token, so binding it to `0.0.0.0` is safe and is the default.
 */

export const DEFAULT_HTTP_PORT = 8788;
export const DEFAULT_P2P_PORT = 32837;
export const DEFAULT_P2P_BIND_HOST = "0.0.0.0";
export const DEFAULT_HTTP_HOST = "127.0.0.1";

export interface ServerConfig {
  /** HTTP/WS bridge bind host (loopback-by-default; gated by P2P_HUB_EXPOSE). */
  host: string;
  /** True when the bridge host is non-loopback (caller must warn loudly). */
  exposed: boolean;
  /**
   * Explicit extra Host-header allowlist entries (comma-separated
   * `P2P_HUB_ALLOWED_HOSTS`), for reaching the bridge via a hostname the bind
   * address or interface enumeration cannot discover. Unlike the discovered
   * set, these apply on every configuration (loopback-only included) — an
   * explicit operator trust decision, so only list hostnames the operator
   * controls.
   */
  allowedHosts: string[];
  /** HTTP/WS bridge port. */
  port: number;
  /** P2P transport (network-light) port. */
  p2pPort: number;
  /** P2P transport bind host. */
  p2pBindHost: string;
  /** Whether the P2P transport (mDNS discovery + TLS) is enabled. */
  networking: boolean;
  /**
   * Whether the WAN transport (network-libp2p) is enabled. Strictly opt-in
   * (default `false`): it opens outbound connections to an operator relay and
   * must never come up implicitly. Ignored (treated as `false`) when
   * `networking` is off.
   */
  wanEnabled: boolean;
  /** Operator-supplied circuit-relay v2 relay multiaddr, or empty when unset. */
  wanRelayAddr: string;
  /** Explicit WAN listen multiaddrs, or empty when unset. */
  wanListenAddrs: string[];
}

export type LoadConfigResult =
  | { config: ServerConfig }
  | { error: string };

/**
 * Robustly parse an environment value as a boolean. Accepts the common
 * spellings; anything unrecognized falls back to `fallback` instead of
 * throwing or silently flipping.
 */
export function parseBoolEnv(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "y", "enabled", "aan"].includes(v)) {
    return true;
  }
  if (["0", "false", "no", "off", "n", "disabled", "uit", ""].includes(v)) {
    return false;
  }
  return fallback;
}

/**
 * Parse a port from an env value, or `null` when absent/invalid. `0` is valid
 * and means "let the OS assign a free port" (used by the desktop sidecar: the
 * core-server reports the actually-bound port over the `[P2P_HUB_READY]`
 * handshake). Negative values and values above 65535 are rejected.
 */
function parsePort(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null;
}

/** First valid port in a fallback chain, else `fallback`. */
function firstValidPort(values: readonly (string | undefined)[], fallback: number): number {
  for (const value of values) {
    const port = parsePort(value);
    if (port !== null) {
      return port;
    }
  }
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv): LoadConfigResult {
  const bindDecision = decideBindHost(env.P2P_HUB_HOST, env.P2P_HUB_EXPOSE);
  if ("error" in bindDecision) {
    return { error: bindDecision.error };
  }

  const port = firstValidPort([env.P2P_HUB_PORT, env.PORT], DEFAULT_HTTP_PORT);
  const p2pPort = firstValidPort(
    [env.P2P_HUB_P2P_PORT, env.P2P_PORT],
    DEFAULT_P2P_PORT,
  );
  const p2pBindHost = (env.P2P_BIND_HOST ?? "").trim() || DEFAULT_P2P_BIND_HOST;
  const allowedHosts = (env.P2P_HUB_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const networking = parseBoolEnv(
    env.P2P_ENABLE_NETWORKING ?? env.P2P_HUB_NETWORKING,
    true,
  );
  // The WAN transport is only meaningful next to the LAN transport (they share
  // one p2p-hub identity); a `wanEnabled` value with networking off is ignored
  // rather than erroring, so a `P2P_HUB_WAN_ENABLED=1 P2P_HUB_NETWORKING=0`
  // environment cannot boot a WAN-only node by accident.
  const wanEnabled =
    networking && parseBoolEnv(env.P2P_HUB_WAN_ENABLED, false);
  const wanRelayAddr = (env.P2P_HUB_WAN_RELAY ?? "").trim();
  const wanListenAddrs = (env.P2P_HUB_WAN_LISTEN ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    config: {
      host: bindDecision.host,
      exposed: bindDecision.exposed,
      allowedHosts,
      port,
      p2pPort,
      p2pBindHost,
      networking,
      wanEnabled,
      wanRelayAddr,
      wanListenAddrs,
    },
  };
}
