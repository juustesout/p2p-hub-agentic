# 003 – Fase 0: fundering, multi-peer testlab & cross-platform CI

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 (vastlegging van werk sinds begin van het traject) |
| **Opdracht/brief** | plan.md Fase 0A–0E |
| **Commits** | `d6d49d3` (0A/0B), `d095571` (Windows-fixes), `9776dd4` (0D), `2f09ceb` (0C), `ff9b014` (0E) |
| **Wiki-sectie** | `docs/wiki/01-architecture-overview.md` |

## Context

"378 tests groen" is geen bewijs voor correct P2P. Voordat er protocolwerk
plaatsvond moest de basis betrouwbaar zijn op Linux én Windows, met échte
multi-peer-integratie.

## Besluiten

- **0A Cross-platform CI** — GitHub Actions op Linux + Windows (later 3-OS matrix,
  `8576a92`): `tsc -b`, alle tests, `cargo check`, smoke/integration. Windows-only
  failures direct gefixt (symlink-EPERM-probe, NTFS-mode-asserties, 2048-bit
  test-cert).
- **0B Multi-peer testlab** (`apps/testlab`) — meerdere onafhankelijke
  `PluginHost`s in één proces, échte netwerkcommunicatie, A↔B↔C mesh + direct +
  chained call.
- **0C mDNS is geen capability-lek** — mDNS-TXT adverteert alleen
  `{id, version, certFingerprint, peerId?, announceSeq}`, **nooit skill-namen**;
  capability-discovery pas na de authenticated handshake (1A).
- **0D Expliciete network exposure** — `P2P_HUB_EXPOSE=1` voor elke niet-loopback
  HTTP-bridge-bind (luide waarschuwing); `P2P_HUB_NETWORKING=0` voor een volledig
  local-only core-server die de vault nooit aanraakt (corrupte vault kan een
  local-only boot niet breken).
- **0E Cross-process storage locking** — `core/src/storage/file-lock.ts`: atomair
  lockfile via `O_EXCL` met PID/stale-detectie om de bestaande atomic-write
  (temp → fsync → rename) heen, reentrant binnen één proces, `fork`-multi-proces
  tests (verloren updates zonder lock, intact met lock, op Linux én Windows).

## Status & testbewijs

Alle 0A–0E GEDONE. `plan.md` Fase 0-status + 3-OS CI-matrix. Suite-basis waarop
elke latere fase voortbouwt.
