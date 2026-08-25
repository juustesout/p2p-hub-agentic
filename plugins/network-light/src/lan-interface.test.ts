import { test } from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { detectLanIPv4 } from "./lan-interface";

function ipv4(
  address: string,
  name = "eth0",
  internal = false,
): Record<string, NetworkInterfaceInfo[]> {
  return {
    [name]: [
      { address, family: "IPv4", internal, netmask: "255.255.255.0", cidr: `${address}/24`, mac: "00:00:00:00:00:00", scopeid: 0 },
    ],
  };
}

test("returns null when only loopback / no non-internal IPv4 exists", () => {
  assert.equal(detectLanIPv4(ipv4("127.0.0.1", "lo", true)), null);
  assert.equal(detectLanIPv4({ lo: [{ address: "::1", family: "IPv6", internal: true, netmask: "ffff::", cidr: "::1/128", mac: "00", scopeid: 0 }] }), null);
  assert.equal(detectLanIPv4({}), null);
});

test("picks the single physical LAN IPv4", () => {
  assert.equal(detectLanIPv4(ipv4("192.168.1.10", "eth0")), "192.168.1.10");
  assert.equal(detectLanIPv4(ipv4("10.0.0.5", "en0")), "10.0.0.5");
});

test("prefers a private RFC1918 address over a public one", () => {
  const interfaces = {
    eth0: [ipv4("8.8.8.8", "eth0").eth0[0]],
    eth1: [ipv4("192.168.1.7", "eth1").eth1[0]],
  };
  assert.equal(detectLanIPv4(interfaces), "192.168.1.7");
});

test("skips known virtual adapters (Hyper-V/WSL/VMware/VirtualBox/VPN)", () => {
  const interfaces: Record<string, NetworkInterfaceInfo[]> = {
    "vEthernet (WSL)": ipv4("172.24.16.1", "vEthernet (WSL)")["vEthernet (WSL)"],
    "VMware Network Adapter VMnet1": ipv4("192.168.114.1", "VMware Network Adapter VMnet1")["VMware Network Adapter VMnet1"],
    "VirtualBox Host-Only Network": ipv4("192.168.56.1", "VirtualBox Host-Only Network")["VirtualBox Host-Only Network"],
    eth0: ipv4("192.168.1.42", "eth0").eth0,
  };
  assert.equal(detectLanIPv4(interfaces), "192.168.1.42");
});

test("falls back to any non-virtual non-internal IPv4 when no private one exists", () => {
  const interfaces: Record<string, NetworkInterfaceInfo[]> = {
    eth0: ipv4("203.0.113.9", "eth0").eth0,
  };
  assert.equal(detectLanIPv4(interfaces), "203.0.113.9");
});

test("deterministic tie-break across equally-private adapters", () => {
  const interfaces: Record<string, NetworkInterfaceInfo[]> = {
    eth0: ipv4("192.168.1.50", "eth0").eth0,
    eth1: ipv4("192.168.1.50", "eth1").eth1,
  };
  assert.equal(detectLanIPv4(interfaces), "192.168.1.50");
});
