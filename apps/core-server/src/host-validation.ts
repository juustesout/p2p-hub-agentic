import * as os from "node:os";
import { isLoopbackHost } from "./host";

/**
 * Host-header allowlist: the tokenless surfaces (`/site`, `/ui`,
 * `/remote-site`, `/peersite/status`) deliberately carry no credential, and
 * loopback *binding* alone does not stop a DNS-rebinding page — after the
 * attacker's domain resolves to 127.0.0.1 the browser's requests are
 * same-origin to *that page*, so it can read the responses. The one thing a
 * rebinding request cannot fake is the `Host` header: it still claims the
 * attacker's domain (the browser derives it from the URL, never from the
 * resolved IP). Validating `Host` against "how the server can actually be
 * addressed" therefore closes the rebinding read-path for every route.
 *
 * This gate is separate from the boot-token gate on `/api/*`/`/ws`: it is an
 * additional, uniform layer, not a replacement.
 */

/**
 * Parse the hostname (port stripped, IPv6 brackets removed, lowercased) from a
 * `Host` header, or `null` when absent/malformed. Ports are not part of the
 * allowlist comparison — a rebinding attacker's port always matches the local
 * server's port (it must, to reach it), so only the hostname discriminates.
 */
export function hostFromHeader(hostHeader: string | undefined): string | null {
  if (typeof hostHeader !== "string") {
    return null;
  }
  let host = hostHeader.trim().toLowerCase();
  if (host.length === 0) {
    return null;
  }
  if (host.startsWith("[")) {
    // IPv6 literal `[::1]:8788` (brackets mandatory for v6 in a Host header).
    const close = host.indexOf("]");
    if (close === -1) {
      return null;
    }
    return host.slice(1, close);
  }
  const lastColon = host.lastIndexOf(":");
  if (lastColon !== -1) {
    const rest = host.slice(lastColon + 1);
    if (/^\d{1,5}$/.test(rest)) {
      host = host.slice(0, lastColon);
    }
  }
  return host.length > 0 ? host : null;
}

/** Options for the per-boot host gate. */
export interface HostGateOptions {
  /** The address the HTTP/WS bridge is bound to (e.g. `127.0.0.1`). */
  bindHost: string;
  /**
   * True when the bridge is bound beyond loopback (`P2P_HUB_EXPOSE=1`). Only
   * then are the machine's own addresses and the configured bind host
   * accepted — never arbitrary Host values, so exposed mode still refuses
   * DNS-rebinding origins.
   */
  exposed: boolean;
  /**
   * Explicit extra hostnames to accept on top of the loopback set and (when
   * exposed) the machine's addresses. Operator/test override for reaching the
   * bridge via a hostname that interface enumeration cannot discover.
   */
  extraHosts?: readonly string[];
}

/**
 * The per-boot Host allowlist decision. Built once at server start
 * (`os.networkInterfaces()` is not free), then consulted per request.
 *
 * Loopback addressing is always allowed: `localhost`, `127.0.0.0/8`, `::1`,
 * `::ffff:127.0.0.1`. A non-loopback Host is accepted only when the bridge is
 * explicitly exposed AND the hostname is either the configured bind address or
 * one of this machine's own interface addresses — which is the set a real
 * LAN/exposed client would legitimately use. Anything else (an attacker's
 * rebinding domain, or any arbitrary hostname) is denied.
 */
export class HostGate {
  private readonly exposedHosts: ReadonlySet<string>;

  constructor(options: HostGateOptions) {
    const hosts = new Set<string>();
    if (options.exposed) {
      const add = (host: string) => {
        const clean = host.trim().toLowerCase();
        if (clean) {
          hosts.add(clean);
        }
      };
      add(options.bindHost);
      for (const infos of Object.values(os.networkInterfaces())) {
        for (const info of infos ?? []) {
          add(info.address);
        }
      }
    }
    for (const host of options.extraHosts ?? []) {
      const clean = host.trim().toLowerCase();
      if (clean) {
        hosts.add(clean);
      }
    }
    this.exposedHosts = hosts;
  }

  /** Whether a request with this `Host` header may reach any route. */
  isAllowed(hostHeader: string | undefined): boolean {
    const host = hostFromHeader(hostHeader);
    if (!host) {
      return false;
    }
    if (isLoopbackHost(host)) {
      return true;
    }
    return this.exposedHosts.has(host);
  }
}
