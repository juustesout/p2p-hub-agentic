import { decideBindHost } from "./host";

/**
 * Core-server configuration resolved from environment variables, with explicit
 * fallback chains. Pure (reads only its arguments) so the fallbacks are
 * unit-testable without starting the server entrypoint.
 *
 * | Variable | Chain | Default |
 * | --- | --- | --- |
 * | HTTP/WS bridge port | `P2P_HUB_PORT` → `PORT` | `8788` |
 * | P2P transport port | `P2P_HUB_P2P_PORT` → `P2P_PORT` | `32837` |
 * | P2P transport bind host | `P2P_BIND_HOST` | `0.0.0.0` |
 * | Networking enabled | `P2P_ENABLE_NETWORKING` → `P2P_HUB_NETWORKING` | `true` |
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
  /** HTTP/WS bridge port. */
  port: number;
  /** P2P transport (network-light) port. */
  p2pPort: number;
  /** P2P transport bind host. */
  p2pBindHost: string;
  /** Whether the P2P transport (mDNS discovery + TLS) is enabled. */
  networking: boolean;
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

/** Parse a port from an env value, or `null` when absent/invalid. */
function parsePort(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
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
  const networking = parseBoolEnv(
    env.P2P_ENABLE_NETWORKING ?? env.P2P_HUB_NETWORKING,
    true,
  );

  return {
    config: {
      host: bindDecision.host,
      exposed: bindDecision.exposed,
      port,
      p2pPort,
      p2pBindHost,
      networking,
    },
  };
}
