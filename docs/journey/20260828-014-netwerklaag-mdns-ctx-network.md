# 014 – Netwerklaag: one-sided mDNS-fix + `ctx.network`-wiring

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 (vastlegging van werk sinds begin van het traject) |
| **Opdracht/brief** | netwerklaag-debugslice (Windows one-sided discovery + `ctx.network`-resolutie) |
| **Commits** | `f030d3b` (mDNS-fix), `54e5630` (wiring-fix), `2de8b13` (remote `core.echo` smoke) |
| **Wiki-sectie** | `docs/wiki/03-wan-networking-and-relays.md` |

## Context

Twee onafhankelijke storingen die de P2P-belofte ondermijnden: op Windows ontdekte
A wel B maar B nooit A (one-sided mDNS), en plugins zagen "no active network
provider" terwijl het transport gezond was.

## Besluiten

- **One-sided mDNS root cause** — `multicast-dns` default-interface is `"0.0.0.0"`
  op non-darwin, zodat de OS een virtuele adapter (Hyper-V/WSL/VPN) kon kiezen.
  `detectLanIPv4()` (`plugins/network-light/src/lan-interface.ts`) kiest de fysieke
  LAN-IPv4 (skips virtuele adapters, prefereert RFC1918, deterministische
  tie-break) en wordt als `interface` doorgegeven; de socket bindt wél wildcard
  zodat loopback-multicast (in-process peers) blijft werken.
- **Proactieve peer-handshake** — een gehoorde mDNS-announcement triggert een
  throttled unicast `hello`+`auth` terug; `hello` kreeg optionele, strikt
  gevalideerde reverse-registratie-hints (`instanceId`, `listenPort`).
- **Reverse-registratie (default-deny)** — een inbound client komt pas na
  `auth`-verificatie in de discovered-map.
- **`ctx.network` resolutie** — root cause was geen netwerkfout maar een
  injectie-bug: CoreServer registreerde de provider alleen in z'n eigen registry,
  terwijl `ctx.network` een live referentie naar de **host**-netwerk-registry is.
  Fix: dezelfde provider ook in de host-registry (precies één per proces) →
  `contacts.verifyPeer` routeert nu over het echte transport.

## Status & testbewijs

GEDONE, live getest. Integratietest (`apps/core-server/src/contacts.test.ts`):
CoreServer + tweede peer, mDNS-discovery, `verifyPeer` over HTTP ⇒ `{verified:
true}` + contact gepromoveerd; tegenrichting: peer roept `core.echo` aan over z'n
eigen transport (volledig rondje discovery → TLS+identity-binding → broker).
darwin-skip in CI (runner blokkeert multicast, zie CLAUDE.md blind-spots).
