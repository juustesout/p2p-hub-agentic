const DEFAULT_HOST = "127.0.0.1";

/**
 * True for addresses that only reach this machine. The HTTP/WS bridge is only
 * guarded by the per-boot token, which is only safe to trust when the bridge
 * cannot be reached by anything but this host (see CLAUDE.md "Core-server boot
 * token"). Anything else — `0.0.0.0`, `::`, a LAN IP — widens the trust
 * boundary and must be explicitly opted into.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "::ffff:127.0.0.1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

export type BindDecision =
  | { host: string; exposed: false }
  | { host: string; exposed: true }
  | { error: string };

/**
 * Decide the bind host. Loopback is always allowed. A non-loopback host is
 * only allowed when `expose === "1"`; otherwise an error is returned so the
 * caller can refuse to start. Pure (reads only its arguments) so the decision
 * is unit-testable without triggering the server entrypoint.
 */
export function decideBindHost(
  rawHost: string | undefined,
  expose: string | undefined,
): BindDecision {
  const host = (rawHost ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  if (isLoopbackHost(host)) {
    return { host, exposed: false };
  }
  if (expose === "1") {
    return { host, exposed: true };
  }
  return {
    error:
      `refusing to bind the HTTP/WS bridge to non-loopback "${host}". ` +
      `The bridge is only safe bound to loopback (default 127.0.0.1). ` +
      `To deliberately expose it, set P2P_HUB_EXPOSE=1.`,
  };
}
