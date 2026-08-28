# 008 – Fase 2-Eindcriterium: P2P static website (`p2p-hub:website:v1`)

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 (vastlegging van werk sinds begin van het traject) |
| **Opdracht/brief** | plan.md "Belangrijke richting: P2P Static Websites" + eindcriterium |
| **Commits** | `ed5fa21` |
| **Wiki-sectie** | `docs/wiki/05-p2p-content-sharing.md` |

## Context

De verticale slice die het eindcriterium bewijst: "Peer A exposeert een lokale
directory als P2P-website; Peer B mirror+fetcht en rendert die in de sandboxed UI
— zonder publieke HTTP-server."

## Besluiten

- **Capability-level versioned contract** (`sdk/src/website-contract.ts`) —
  `p2p-hub:website:v1`: request `{protocol, version, path}`, vaste key-volgorde,
  gepinde bytes; onbekend protocol/versie/smokkelvelden (caller-`peerId`) ⇒ typed
  errors. `MAX_WEBSITE_PATH_LENGTH` (256) en `MAX_WEBSITE_ASSET_BYTES` (128 KiB).
- **Peer A (versioned enforcement)** (`plugins/peersite`) — `fetchAsset` parsed het
  envelop-payload na de broker-gate; stat-check vóór readFile + per-asset cap
  (oversize ⇒ `payload-too-large`, nooit truncatie).
- **Atomic binary mirror** (`core/src/site/site-mirror.ts`) — write-side
  containment `mirrorDestination` (dot-segments/dotfiles/backslashes/NUL deny,
  trailing-separator-geankerd, géén realpath-vereiste omdat de file nog niet hoeft
  te bestaan); base64-decode → `atomicWriteFile` met `Uint8Array` (byte-exact);
  bestandsnaam uitsluitend uit B's eigen requested path, nooit een remote `name`-veld.
- **`/remote-site/<peerId>/*` in core-server** — loopback-gate, GET/HEAD-only,
  hardened UI-CSP, **geen boot-token**, fetch-on-miss.
- **Shell `SiteViewer`** — sandboxed iframe + **source-pinning** (`bindSource`):
  alleen windows die de shell zelf bond mag de bridge aanroepen — de remote-site
  deelt de core-server-origin met plugin-UI maar krijgt nooit een binding.

## Status & testbewijs

GEDONE. Website-v1-matrix: byte-exacte PNG, unsupported-version, malformed,
traversal, oversize, expired/revoked pass. Open follow-ups (niet-doelen): cross-origin
subresource-bundling, optioneel `contentHash` per asset, render-time `img-src`-CSP.
