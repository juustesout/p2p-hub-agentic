/**
 * Sidecar boot handshake.
 *
 * When the core-server runs as the child process of a host (the Tauri desktop
 * shell), the host needs to learn — out-of-band, without scanning filesystem
 * state — which loopback port the server actually bound and which per-boot
 * token guards it. `P2P_HUB_PORT=0` asks the OS for a free port, so the *bound*
 * address is only known after `listen()`; the token is generated inside the
 * server. The one channel the host controls end-to-end is the child's stdout,
 * so the server emits a single machine-readable line once it is ready:
 *
 * ```
 * [P2P_HUB_READY] {"port":41823,"token":"a1b2c3d4...","state":"ready"}
 * ```
 *
 * `state` reports the vault lock gate (Slice 2): `"locked"` when a
 * pre-existing vault is awaiting its master key (the bridge is up and the
 * operator API — `/api/health`, `/api/vault/unlock` — is reachable, but no
 * plugins, identity or P2P transports exist yet), `"ready"` otherwise.
 *
 * The host scans stdout for the exact `[P2P_HUB_READY] ` prefix (delimiter-
 * anchored with a trailing space — a bare `startsWith("[P2P_HUB_READY]")`
 * would wrongly match a hypothetical `[P2P_HUB_READYING] ...`, the same class
 * of bug as `"calendar".startsWith("calendar:")`; see CLAUDE.md principle #2)
 * and parses the JSON. Everything else on stdout is ordinary log output and is
 * ignored by the host.
 *
 * This channel is deliberately gated behind the `P2P_HUB_SIDECAR_READY`
 * environment variable: in a normal terminal run the ready line would be noise
 * on stdout, and — more importantly — it would put the boot token on a
 * stdout that no host is listening on. Only a host that set the gate is
 * reading it.
 */

/** Exact stdout prefix of the ready line. */
export const SIDECAR_READY_PREFIX = "[P2P_HUB_READY]";

/** Env gate: when truthy, the server prints the ready line after boot. */
export const SIDECAR_READY_ENV = "P2P_HUB_SIDECAR_READY";

/** The handshake payload the host parses off stdout. */
export interface SidecarReady {
  /** The port the HTTP/WS bridge actually bound (real value after port 0). */
  port: number;
  /** The per-boot token guarding `/api/*` and `/ws`. */
  token: string;
  /**
   * Vault lock-gate status: `"locked"` (vault awaiting its master key, only
   * the operator API is live) or `"ready"` (full boot, P2P transports up).
   */
  state: "locked" | "ready";
}

/** Format the ready line exactly as the host expects it. */
export function sidecarReadyLine(ready: SidecarReady): string {
  return `${SIDECAR_READY_PREFIX} ${JSON.stringify(ready)}`;
}

/**
 * Parse a `[P2P_HUB_READY]` line, or `null` when it is not one. Fail-closed:
 * a wrong prefix, malformed JSON, an out-of-range port, an empty token or an
 * unknown `state` all parse to `null` — a host must never half-accept a broken
 * handshake.
 */
export function parseSidecarReady(line: string): SidecarReady | null {
  if (!line.startsWith(SIDECAR_READY_PREFIX + " ")) {
    return null;
  }
  const json = line.slice(SIDECAR_READY_PREFIX.length + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const { port, token, state } = parsed as {
    port?: unknown;
    token?: unknown;
    state?: unknown;
  };
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535
  ) {
    return null;
  }
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  if (state !== "locked" && state !== "ready") {
    return null;
  }
  return { port, token, state };
}
