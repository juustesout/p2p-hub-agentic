import * as os from "node:os";

/**
 * Interface-name patterns that are not a physical LAN adapter. Matched
 * case-insensitively as a substring of the interface name reported by
 * `os.networkInterfaces()`. Over-matching is safe (best-effort discovery): if
 * every adapter is filtered out we fall back to the multicast-dns default
 * behaviour instead of picking a virtual adapter's address.
 */
const VIRTUAL_IFACE_PATTERNS: readonly RegExp[] = [
  /vEthernet/i, // Hyper-V virtual switch (incl. "vEthernet (WSL)")
  /WSL/i,
  /vmnet/i, // VMware
  /vbox/i, // VirtualBox
  /virtualbox/i,
  /docker/i,
  /tailscale/i,
  /zerotier/i,
  /utun/i, // macOS VPN / tunnel
  /^tun/i,
  /^tap/i,
  /^ppp/i,
  /hamachi/i,
  /loopback/i,
];

function isVirtualInterfaceName(name: string): boolean {
  return VIRTUAL_IFACE_PATTERNS.some((re) => re.test(name));
}

/** RFC1918 private IPv4 — a home/office LAN address, preferred over a public one. */
function isPrivateIPv4(ip: string): boolean {
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

/**
 * Detect the physical primary LAN IPv4 for multicast purposes. Returns the
 * best non-internal IPv4 address (preferring a private/RFC1918 address on a
 * non-virtual adapter), or `null` when no candidate exists.
 *
 * This is the explicit multicast-interface fix for the one-sided mDNS
 * discovery problem: `multicast-dns` defaults `setMulticastInterface` to
 * `"0.0.0.0"` on non-darwin platforms, which on Windows can pick a virtual
 * adapter (Hyper-V, WSL, VPN) instead of the physical NIC. Binding the mDNS
 * socket to a concrete LAN address via `interface` makes `addMembership` and
 * `setMulticastInterface` use that adapter deterministically.
 *
 * Pure (interfaces are injectable) so the candidate selection is unit-testable
 * without depending on the host's real network layout.
 */
export function detectLanIPv4(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | null {
  const candidates: { name: string; address: string; private: boolean }[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    if (!infos || isVirtualInterfaceName(name)) {
      continue;
    }
    for (const info of infos) {
      if (info.internal) {
        continue;
      }
      const family = String(info.family);
      if (family !== "IPv4" && family !== "4") {
        continue;
      }
      candidates.push({
        name,
        address: info.address,
        private: isPrivateIPv4(info.address),
      });
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  // Prefer a private LAN address; tie-break by interface name then address so
  // the result is deterministic across reboots.
  candidates.sort(
    (a, b) =>
      Number(b.private) - Number(a.private) ||
      a.name.localeCompare(b.name) ||
      a.address.localeCompare(b.address),
  );
  return candidates[0].address;
}
